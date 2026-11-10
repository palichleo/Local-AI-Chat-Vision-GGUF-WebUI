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

    def resident_soon(self, path):
        """Whether `arena(path)` holds or will load this file: it is then read in sequence anyway."""
        path = os.path.abspath(path)
        with self.lock:
            if path in self.arenas:
                return True
        try:
            import psutil

            return psutil.virtual_memory().available - os.path.getsize(path) >= RESERVE
        except (ImportError, OSError):
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


class Prefetch:
    """Read model weights ahead, in file order, while another stage works.

    A file that does not fit in a RAM arena is used through its mapping: its pages then come
    from the disk one fault at a time, in the order the layers run, well below what the disk
    reads in sequence. This thread reads the wanted byte ranges once with large sequential
    reads; the system cache shares those pages with the mapping, so the first use of each
    weight finds it in RAM. Nothing is kept by this process, and `stop()` ends the read early.
    """

    def __init__(self, plan, chunk=32 * 1024**2):
        """`plan`: [(path, [(start, end), ...]), ...] with sorted, non-overlapping ranges."""
        import time

        self.plan, self.chunk = plan, chunk
        self.bytes, self.seconds, self.error = 0, 0.0, None
        self._stop = threading.Event()
        self._started = time.perf_counter()
        self._thread = threading.Thread(target=self._run, name='prefetch', daemon=True)
        self._thread.start()

    def _run(self):
        import time

        try:
            for path, ranges in self.plan:
                # O_SEQUENTIAL (Windows) asks the cache manager for large read-ahead.
                flags = os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_SEQUENTIAL', 0)
                descriptor = os.open(path, flags)
                try:
                    for start, end in ranges:
                        os.lseek(descriptor, start, os.SEEK_SET)
                        while start < end and not self._stop.is_set():
                            count = len(os.read(descriptor, min(self.chunk, end - start)))
                            if not count:
                                break
                            start += count
                            self.bytes += count
                        if self._stop.is_set():
                            break
                finally:
                    os.close(descriptor)
                if self._stop.is_set():
                    break
        except OSError as error:  # a warm-up only: the mapping still works without it
            self.error = str(error)
        self.seconds = time.perf_counter() - self._started

    @property
    def done(self):
        return not self._thread.is_alive()

    def stop(self):
        """Ends the read and returns what it did, for the job's timeline."""
        self._stop.set()
        self._thread.join(timeout=10)
        gib = self.bytes / GiB
        return dict(
            read_gib=round(gib, 2),
            seconds=round(self.seconds, 2),
            **({'gib_per_second': round(gib / self.seconds, 2)} if self.seconds > 0.05 else {}),
            **({'error': self.error} if self.error else {}),
        )


def weight_ranges(path, keys, gap=4 * 1024**2):
    """Byte ranges of the named tensors of a safetensors file (with the scale, bias and
    quantization notes stored beside a weight), merged when less than `gap` apart."""
    header, base = _header(path)
    wanted = set()
    for key in keys:
        wanted.add(key)
        stem = key.removesuffix('.weight')
        wanted.update(stem + suffix for suffix in ('.weight_scale', '.bias', '.comfy_quant'))
    spans = sorted(
        (base + header[key]['data_offsets'][0], base + header[key]['data_offsets'][1])
        for key in wanted
        if key in header and key != '__metadata__'
    )
    merged = []
    for start, end in spans:
        if merged and start - merged[-1][1] <= gap:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [(start, end) for start, end in merged]


def prefetch(paths, stores, locations):
    """Starts reading ahead the weights at `locations` ((role, key, part) as in a WeightPool)
    from the files of `paths` that are used through their mapping; None when all are resident."""
    keys = {}
    for role, key, _part in locations:
        keys.setdefault(role, set()).add(key)
    def mapped(role):
        store = stores.get(role)
        return store.arena is None if store is not None else not RESIDENCY.resident_soon(paths[role])

    plan = [(paths[role], weight_ranges(paths[role], wanted)) for role, wanted in keys.items() if role in paths and mapped(role)]
    plan = [(path, ranges) for path, ranges in plan if ranges]
    return Prefetch(plan) if plan else None
