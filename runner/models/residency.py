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
        # Open stores reading from this arena: it is not released under them (see Residency.hold).
        self.users = 0

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
                self._discard(self.arenas.pop(path))
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
        # Evict the least recently used arenas until this file fits above the reserve. Never one
        # a store of the running generation reads from: when memory is short (another program
        # holding its own models), this file is read from its mapping instead.
        while psutil.virtual_memory().available - size < RESERVE:
            idle = next((path for path, arena in self.arenas.items() if not arena.users), None)
            if idle is None:
                break
            self.arenas.pop(idle).release()
        return psutil.virtual_memory().available - size >= RESERVE

    @staticmethod
    def _discard(arena):
        """Releases an arena that left the table, unless a store still reads from it: its memory
        then goes with the last tensor taken from it."""
        if not arena.users:
            arena.release()

    def hold(self, arena):
        """A store starts reading from this arena."""
        with self.lock:
            arena.users += 1

    def drop(self, arena):
        """A store is done with this arena."""
        with self.lock:
            arena.users = max(0, arena.users - 1)

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
                self._discard(self.arenas.popitem()[1])

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
        if self.arena is not None:
            RESIDENCY.hold(self.arena)
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
        if self.arena is not None:
            RESIDENCY.drop(self.arena)
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


WINDOW = 4 * GiB
PATIENCE = 60  # seconds without any weight being used before a waiting read-ahead gives up


class Prefetch:
    """Read model weights ahead, in file order, while another stage works.

    A file that does not fit in a RAM arena is used through its mapping: its pages then come
    from the disk one fault at a time, in the order the layers run, well below what the disk
    reads in sequence. This thread reads the wanted byte ranges once with large sequential
    reads; the system cache shares those pages with the mapping, so the first use of each
    weight finds it in RAM. Nothing is kept by this process, and `stop()` ends the read early.

    When the files do not fit in the free RAM, pages read long before their layer runs are
    pushed out of the cache and the disk reads them twice (measured: 40 GiB read for a 22 GiB
    model whose file is not in layer order). The plan is then given in the order the layers
    run and read with a `window`: the thread stays that far ahead of `lead()`, the bytes the
    model has used so far.
    """

    def __init__(self, plan, chunk=32 * 1024**2, window=None, lead=None):
        """`plan`: [(path, [(start, end), ...]), ...] with sorted, non-overlapping ranges."""
        self.plan, self.chunk, self.window, self.lead = plan, chunk, window, lead
        self.bytes, self.seconds, self.error = 0, 0.0, None
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name='prefetch', daemon=True)
        self._thread.start()

    def _wait(self):
        """Hold the read while it is a window ahead of what the model has used."""
        import time

        waited, seen = 0.0, None
        while self.window is not None and not self._stop.is_set():
            used = self.lead() if self.lead else 0
            if self.bytes - used <= self.window:
                return
            if used != seen:
                waited, seen = 0.0, used
            elif waited > PATIENCE:
                self._stop.set()
            time.sleep(0.02)
            waited += 0.02

    def _run(self):
        import time

        descriptors = {}
        try:
            for path, ranges in self.plan:
                if path not in descriptors:
                    # O_SEQUENTIAL (Windows) asks the cache manager for large read-ahead.
                    flags = os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_SEQUENTIAL', 0)
                    descriptors[path] = os.open(path, flags)
                descriptor = descriptors[path]
                for start, end in ranges:
                    os.lseek(descriptor, start, os.SEEK_SET)
                    while start < end and not self._stop.is_set():
                        self._wait()
                        if self._stop.is_set():
                            break
                        began = time.perf_counter()
                        count = len(os.read(descriptor, min(self.chunk, end - start)))
                        self.seconds += time.perf_counter() - began
                        if not count:
                            break
                        start += count
                        self.bytes += count
                if self._stop.is_set():
                    break
        except OSError as error:  # a warm-up only: the mapping still works without it
            self.error = str(error)
        finally:
            for descriptor in descriptors.values():
                os.close(descriptor)

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
            seconds=round(self.seconds, 2),  # spent reading, not waiting for the model
            **({'gib_per_second': round(gib / self.seconds, 2)} if self.seconds > 0.05 else {}),
            **({'window_gib': round(self.window / GiB, 1)} if self.window is not None else {}),
            **({'error': self.error} if self.error else {}),
        )


def _companions(key):
    """A weight and what is stored beside it: its scale, bias and quantization notes."""
    stem = key.removesuffix('.weight')
    return [key, *(stem + suffix for suffix in ('.weight_scale', '.bias', '.comfy_quant'))]


def weight_ranges(path, keys, gap=4 * 1024**2):
    """Byte ranges of the named tensors of a safetensors file (with the scale, bias and
    quantization notes stored beside a weight), merged when less than `gap` apart."""
    header, base = _header(path)
    wanted = {name for key in keys for name in _companions(key)}
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


def prefetch(paths, stores, locations, lead=None):
    """Starts reading ahead the weights at `locations` ((role, key, part) as in a WeightPool)
    from the files of `paths` that are used through their mapping; None when all are resident.

    Give `locations` in the order the layers run (see `use_order`), and `lead`, a function
    giving the bytes of these weights used so far: a plan larger than the free RAM is then read
    in that order, a window ahead of its use, instead of all at once in file order. `lead` may
    also be set later on the returned object, which reads one window in the meantime."""
    locations = list(locations)
    keys = {}
    for role, key, _part in locations:
        keys.setdefault(role, set()).add(key)

    def mapped(role):
        store = stores.get(role)
        return store.arena is None if store is not None else not RESIDENCY.resident_soon(paths[role])

    plan = [
        (paths[role], weight_ranges(paths[role], wanted))
        for role, wanted in keys.items()
        if role in paths and mapped(role)
    ]
    plan = [(path, ranges) for path, ranges in plan if ranges]
    if not plan:
        return None
    if _fits(plan):
        return Prefetch(plan)
    return Prefetch(_as_used(paths, locations, mapped), window=WINDOW, lead=lead)


def use_order(names):
    """The locations of {parameter name: location} in the order the layers run: block 2 before
    block 10, where the file may store them by name."""
    import re

    def natural(name):
        return [int(part) if part.isdigit() else part for part in re.split(r'(\d+)', name)]

    return [names[name] for name in sorted(names, key=natural)]


def _as_used(paths, locations, mapped):
    """The plan in the order of `locations`: each weight once, with what is stored beside it;
    consecutive weights that also follow each other in the file are read as one range."""
    headers, seen, plan = {}, set(), []
    for role, key, _part in locations:
        if (role, key) in seen or role not in paths or not mapped(role):
            continue
        seen.add((role, key))
        path = paths[role]
        if path not in headers:
            headers[path] = _header(path)
        header, base = headers[path]
        for name in _companions(key):
            if name not in header or name == '__metadata__':
                continue
            start, end = (base + offset for offset in header[name]['data_offsets'])
            if end <= start:
                continue
            last = plan[-1] if plan else None
            if last and last[0] == path and start == last[1][-1][1]:
                last[1][-1] = (last[1][-1][0], end)
            else:
                plan.append((path, [(start, end)]))
    return plan


def _fits(plan):
    """Whether the whole plan can sit in the system cache until its layers run."""
    try:
        import psutil
    except ImportError:
        return True
    total = sum(end - start for _path, ranges in plan for start, end in ranges)
    return total <= psutil.virtual_memory().available - GiB
