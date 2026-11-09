"""Keep model files resident in RAM between jobs, like ComfyUI's model cache.

The worker process outlives jobs. Each large safetensors file is read once,
sequentially, into one RAM arena (one buffer per file: no per-tensor
allocator rounding) and page-locked with cudaHostRegister when the system
allows it. Later jobs then read weights from RAM instead of faulting the file
mapping in again, and page-locked arenas make the host-to-GPU copies of
streamed weights about twice as fast and truly asynchronous.

Arenas are kept least-recently-used within a RAM budget that always leaves a
reserve for the system and the chat model; a file that does not fit is read
through its mapping as before.

`open_store(path)` returns a `safe_open`-compatible store backed by an arena.
"""

import json
import os
import struct
import threading
from collections import OrderedDict

GiB = 1024**3
RESERVE = 12 * GiB  # never let arenas push free RAM below this
PIN_SHARE = 0.5  # never page-lock more than half the physical RAM
CHUNK = 64 * 1024**2

_DTYPES = {
    'F64': 'float64',
    'F32': 'float32',
    'F16': 'float16',
    'BF16': 'bfloat16',
    'I64': 'int64',
    'I32': 'int32',
    'I16': 'int16',
    'I8': 'int8',
    'U8': 'uint8',
    'BOOL': 'bool',
    'F8_E4M3': 'float8_e4m3fn',
    'F8_E5M2': 'float8_e5m2',
}


def _header(path):
    with open(path, 'rb') as handle:
        length = struct.unpack('<Q', handle.read(8))[0]
        header = json.loads(handle.read(length))
    return header, 8 + length


class Arena:
    def __init__(self, path, stamp, header, base, data, pinned):
        self.path, self.stamp, self.header, self.base = path, stamp, header, base
        self.data, self.pinned = data, pinned
        self.size = data.numel()

    def tensor(self, key):
        import torch

        info = self.header[key]
        start, end = info['data_offsets']
        dtype = getattr(torch, _DTYPES[info['dtype']])
        raw = self.data[start:end]
        if start % dtype.itemsize:  # odd-length predecessor: aligned copy
            raw = raw.clone()
        return raw.view(dtype).reshape(info['shape'])

    def release(self):
        import torch

        if self.pinned:
            # Copies from this arena may still be in flight.
            torch.cuda.synchronize()
            torch.cuda.cudart().cudaHostUnregister(self.data.data_ptr())
            self.pinned = False
        self.data = None


class Residency:
    def __init__(self):
        self.arenas = OrderedDict()
        self.lock = threading.Lock()
        self.stats = dict(hits=0, loads=0, load_seconds=0.0, skipped=0)

    @staticmethod
    def _stamp(path):
        status = os.stat(path)
        return status.st_size, status.st_mtime_ns

    def arena(self, path):
        """The file's arena, loading it if RAM allows; None to fall back to the mapping."""
        import time
        import torch

        path = os.path.abspath(path)
        stamp = self._stamp(path)
        with self.lock:
            found = self.arenas.get(path)
            if found and found.stamp == stamp:
                self.arenas.move_to_end(path)
                self.stats['hits'] += 1
                return found
            if found:
                self.arenas.pop(path).release()
            header, base = _header(path)
            size = stamp[0] - base
            if not self._make_room(size):
                self.stats['skipped'] += 1
                return None
            started = time.perf_counter()
            data = torch.empty(size, dtype=torch.uint8)
            view = memoryview(data.numpy())
            with open(path, 'rb', buffering=0) as handle:
                handle.seek(base)
                done = 0
                while done < size:
                    read = handle.readinto(view[done : done + CHUNK])
                    if not read:
                        raise OSError('Unexpected end of ' + path)
                    done += read
            pinned = self._pin(data)
            arena = Arena(path, stamp, header, base, data, pinned)
            self.arenas[path] = arena
            self.stats['loads'] += 1
            self.stats['load_seconds'] += time.perf_counter() - started
            return arena

    def present(self, path):
        path = os.path.abspath(path)
        with self.lock:
            found = self.arenas.get(path)
            if found and found.stamp == self._stamp(path):
                self.arenas.move_to_end(path)
                self.stats['hits'] += 1
                return found
        return None

    def _make_room(self, size):
        try:
            import psutil
        except ImportError:
            return False
        if size + RESERVE > psutil.virtual_memory().total:
            return False
        # Evict least recently used arenas until this file fits above the reserve.
        while self.arenas and psutil.virtual_memory().available - size < RESERVE:
            self.arenas.popitem(last=False)[1].release()
        return psutil.virtual_memory().available - size >= RESERVE

    def _pin(self, data):
        import torch

        try:
            import psutil

            pinned = sum(arena.size for arena in self.arenas.values() if arena.pinned)
            if not torch.cuda.is_available() or pinned + data.numel() > psutil.virtual_memory().total * PIN_SHARE:
                return False
            return torch.cuda.cudart().cudaHostRegister(data.data_ptr(), data.numel(), 0) == 0
        except Exception:
            return False

    def clear(self):
        with self.lock:
            while self.arenas:
                self.arenas.popitem()[1].release()

    def summary(self):
        try:
            import psutil

            memory = psutil.virtual_memory()
            ram = dict(ram_total_gib=round(memory.total / GiB, 1), ram_available_gib=round(memory.available / GiB, 1))
        except ImportError:
            ram = {}
        return dict(
            self.stats,
            **ram,
            load_seconds=round(self.stats['load_seconds'], 2),
            resident_gib=round(sum(arena.size for arena in self.arenas.values()) / GiB, 2),
            pinned_gib=round(sum(arena.size for arena in self.arenas.values() if arena.pinned) / GiB, 2),
            files=[os.path.basename(path) for path in self.arenas],
        )


RESIDENCY = Residency()


class _Slice:
    def __init__(self, tensor):
        self.tensor = tensor

    def get_shape(self):
        return list(self.tensor.shape)

    def __getitem__(self, index):
        return self.tensor[index]


class Store:
    """`safe_open`-compatible reader over a resident arena (or the file mapping as fallback)."""

    def __init__(self, path, resident=True):
        """`resident`: True loads the file into RAM if it fits, 'if-present' only reuses an arena."""
        self.path = path
        if resident == 'if-present':
            self.arena = RESIDENCY.present(path)
        else:
            self.arena = RESIDENCY.arena(path) if resident else None
        self.mapping = None
        if self.arena is None:
            from safetensors import safe_open

            self.mapping = safe_open(path, framework='pt')

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def close(self):
        if self.mapping is not None:
            self.mapping.__exit__(None, None, None)
            self.mapping = None
        self.arena = None

    def keys(self):
        if self.arena:
            return [key for key in self.arena.header if key != '__metadata__']
        return self.mapping.keys()

    def metadata(self):
        if self.arena:
            return self.arena.header.get('__metadata__')
        return self.mapping.metadata()

    def get_tensor(self, key):
        if self.arena:
            return self.arena.tensor(key)
        return self.mapping.get_tensor(key)

    def get_slice(self, key):
        if self.arena:
            return _Slice(self.arena.tensor(key))
        return self.mapping.get_slice(key)

    @property
    def pinned(self):
        return bool(self.arena and self.arena.pinned)


def open_store(path, resident=True):
    return Store(path, resident=resident)
