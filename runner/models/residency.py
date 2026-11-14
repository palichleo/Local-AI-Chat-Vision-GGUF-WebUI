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
# Never page-lock more than this share of the physical RAM. On Windows, locked memory is mapped
# into the GPU's shared memory, half the RAM at most: 15.9 of 31.8 GiB locked left the driver
# nothing (« CUDA error: out of memory » at the first copy), 14.5 GiB ran well.
PIN_SHARE = 0.45
MIN_PINNED = 1024**2  # nor a buffer this small
PAGE = 4096  # where a partial arena's tensors start (see Residency.partial, _pin)
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
        # The tensors held when the arena is a part of the file only (see Residency.partial).
        self.keys = None

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


# How the table names the arena that holds a part of a file, beside the one that holds it whole.
PARTIAL = '|part'


class Residency:
    def __init__(self):
        self.arenas = OrderedDict()
        self.lock = threading.Lock()
        self.stats = dict(hits=0, loads=0, load_seconds=0.0, skipped=0)

    @staticmethod
    def _stamp(path):
        status = os.stat(path)
        return status.st_size, status.st_mtime_ns

    def arena(self, path, reserve=None, evict=True, pin=True):
        """The file's arena, loading it if RAM allows; None to fall back to the mapping.

        `reserve` (bytes) is the RAM this file must leave free, RESERVE when not given: a family
        whose files are small beside the machine's memory keeps them with less. `evict` False
        loads the file only if it fits as things are, without sending another one away (a text
        encoder must not push out the model that every step reads). `pin` False leaves it
        unlocked: a file read once per prompt leaves the share of locked RAM to the model.
        """
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
            if not self._make_room(size, reserve, evict):
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
            pinned = self._pin(data) if pin else 0
            arena = Arena(path, stamp, header, base, data, pinned)
            self.arenas[path] = arena
            self.stats['loads'] += 1
            self.stats['load_seconds'] += time.perf_counter() - started
            return arena

    def partial(self, path, keys, reserve=None, spare=()):
        """An arena that holds only `keys` of the file, packed and page-locked when allowed.

        For a model too large to keep whole beside everything else (a 19 GiB video model in
        32 GiB of RAM): the weights that stay on the GPU are read once per generation, those
        that do not are copied there at every step, and only these need to sit in locked
        memory for the copies to be fast. Reused while it holds every key asked for; None when
        RAM does not allow it (the file is then read through its mapping, as before).

        `spare` names keys to hold as well when the arena has to be built: what the next
        generations may need beyond `keys`, so that it is not built again for a few megabytes.
        """
        import time
        import torch

        path = os.path.abspath(path)
        stamp = self._stamp(path)
        name = path + PARTIAL
        wanted = set(keys)
        with self.lock:
            found = self.arenas.get(name)
            if found and found.stamp == stamp and wanted <= found.keys:
                self.arenas.move_to_end(name)
                self.stats['hits'] += 1
                return found
            if found:
                self._discard(self.arenas.pop(name))
            first = set(keys)
            wanted |= set(spare)
            header, base = _header(path)
            # What is asked for now comes first, what is held to spare after: when RAM allows to
            # lock only a part of the arena (see _pin), the part locked is the one in use.
            ordered = sorted((key not in first, header[key]['data_offsets'][0], key) for key in wanted if key in header)
            packed, size, cuts = {}, 0, []
            for _, _, key in ordered:
                start, end = header[key]['data_offsets']
                # Every tensor starts on a page of its own: the arena can be locked up to any of
                # them without a page shared by locked and unlocked tensors.
                size = -(-size // PAGE) * PAGE
                cuts.append(size)
                packed[key] = dict(header[key], data_offsets=[size, size + end - start])
                size += end - start
            cuts.append(size)
            if not size or not self._make_room(size, reserve, True):
                self.stats['skipped'] += 1
                return None
            started = time.perf_counter()
            # Starting on a page boundary, so that its tensors do too (torch aligns on 64 bytes).
            block = torch.empty(size + PAGE, dtype=torch.uint8)
            skip = -block.data_ptr() % PAGE
            data = block[skip : skip + size]
            view = memoryview(data.numpy())
            with open(path, 'rb', buffering=0) as handle:
                for _, _, key in ordered:
                    start, end = header[key]['data_offsets']
                    to = packed[key]['data_offsets'][0]
                    handle.seek(base + start)
                    done = 0
                    while done < end - start:
                        read = handle.readinto(view[to + done : to + min(end - start, done + CHUNK)])
                        if not read:
                            raise OSError('Unexpected end of ' + path)
                        done += read
            arena = Arena(path, stamp, packed, base, data, self._pin(data, cuts))
            arena.keys = frozenset(packed)
            self.arenas[name] = arena
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

    def _make_room(self, size, reserve=None, evict=True):
        try:
            import psutil
        except ImportError:
            return False
        reserve = RESERVE if reserve is None else reserve
        if size + reserve > psutil.virtual_memory().total:
            return False
        # Evict the least recently used arenas until this file fits above the reserve. Never one
        # a store of the running generation reads from: when memory is short (another program
        # holding its own models), this file is read from its mapping instead.
        while evict and psutil.virtual_memory().available - size < reserve:
            idle = next((path for path, arena in self.arenas.items() if not arena.users), None)
            if idle is None:
                break
            self.arenas.pop(idle).release()
        return psutil.virtual_memory().available - size >= reserve

    @staticmethod
    def _discard(arena):
        """Releases an arena that left the table, unless a store still reads from it: it is then
        released when that store is done (see drop)."""
        if not arena.users:
            arena.release()

    def hold(self, arena):
        """A store starts reading from this arena."""
        with self.lock:
            arena.users += 1

    def drop(self, arena):
        """A store is done with this arena. One that left the table while it was read (replaced,
        or sent away by `clear`) is released now: left page-locked, its memory would be handed
        to something else still registered with CUDA, and a later copy from there would fail
        (« Copy is larger than memobj size »)."""
        with self.lock:
            arena.users = max(0, arena.users - 1)
            gone = all(kept is not arena for kept in self.arenas.values())
            if not arena.users and gone and getattr(arena, 'data', None) is not None:
                arena.release()

    def _pin(self, data, cuts=()):
        """Page-lock `data`, or the part of it that the share of RAM allowed still holds: up to
        the last of `cuts` (offsets where a tensor starts on a page of its own) under that share.
        Returns the bytes locked, 0 for none."""
        import torch

        try:
            import psutil

            # A buffer smaller than a few pages shares its pages with other allocations: locking
            # it gains nothing, and two of them on one page confuse the driver's bookkeeping
            # (a later copy from that page then fails with « Copy is larger than memobj size »).
            if data.numel() < MIN_PINNED or not torch.cuda.is_available():
                return 0
            room = psutil.virtual_memory().total * PIN_SHARE - sum(int(arena.pinned) for arena in self.arenas.values())
            length = data.numel()
            if length > room:
                # Measured: 18.9 GiB asked at 1344 x 768, 15.9 allowed; all of it then stayed
                # unlocked. A part is locked instead, cut between two tensors on a page boundary.
                if data.data_ptr() % PAGE:
                    return 0
                length = max((cut for cut in cuts if cut <= room), default=0)
                if length < MIN_PINNED:
                    return 0
            return length if torch.cuda.cudart().cudaHostRegister(data.data_ptr(), length, 0) == 0 else 0
        except Exception:
            return 0

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

    def leave_room(self, available):
        """The chat model is about to load: arenas leave, least recently used first (never one a
        store still reads), until the machine has `available` bytes of RAM available. Returns
        the bytes let go. Without psutil nothing is measured, and nothing leaves."""
        try:
            import psutil
        except ImportError:
            return 0
        freed = 0
        with self.lock:
            while psutil.virtual_memory().available < available:
                idle = next((path for path, arena in self.arenas.items() if not arena.users), None)
                if idle is None:
                    break
                arena = self.arenas.pop(idle)
                freed += arena.size
                arena.release()
        return freed

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
            pinned_gib=round(sum(int(arena.pinned) for arena in self.arenas.values()) / GiB, 2),
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


class Reader:
    """Reads tensors of a file from the disk a little ahead of their use, in the order given.

    For a file used once from end to end that finds no room in RAM: a text encoder of 15 GiB
    beside the locked share of its video model, in 32 GiB. Read through its mapping, such a file
    comes in page by page as its layers touch it (1 GiB/s measured where the disk gives 2.1 in
    sequence), and its pages enter the working set of the process, which pushes the rest out.
    Here a thread reads each tensor whole into a buffer of its own, at most `ahead` bytes before
    the model asks for them: the disk works in sequence while the GPU computes, and RAM holds
    one window of the file. A tensor asked for out of turn is read at once by the caller.
    """

    def __init__(self, path, keys, ahead=GiB):
        header, base = _header(path)
        self.path, self.ahead = path, ahead
        # {key: (position in the file, bytes, dtype, shape)}, in the order of use.
        self.plan = {
            key: (
                base + header[key]['data_offsets'][0],
                header[key]['data_offsets'][1] - header[key]['data_offsets'][0],
                header[key]['dtype'],
                header[key]['shape'],
            )
            for key in keys
            if key in header and key != '__metadata__'
        }
        self.ready, self.held, self.taken = {}, 0, set()
        self.reading, self.waiting, self.done, self.closed = None, False, False, False
        self.stats = dict(read_gib=0.0, seconds=0.0, ahead_gib=0.0, direct_gib=0.0)
        self.state = threading.Condition()
        self.direct = threading.Lock()
        self.handle = open(path, 'rb', buffering=0)
        self.thread = threading.Thread(target=self._run, name='reader', daemon=True)
        self.thread.start()

    @staticmethod
    def _read(handle, offset, size):
        import torch

        data = torch.empty(size, dtype=torch.uint8)
        view = memoryview(data.numpy()) if size else b''
        handle.seek(offset)
        done = 0
        while done < size:
            count = handle.readinto(view[done : done + CHUNK])
            if not count:
                raise OSError('Unexpected end of file')
            done += count
        return data

    def _run(self):
        import time

        try:
            with open(self.path, 'rb', buffering=0) as handle:
                for key, (offset, size, _dtype, _shape) in self.plan.items():
                    with self.state:
                        # One window ahead: what is ready waits for the model to take it.
                        while not self.closed and self.ready and self.held + size > self.ahead:
                            self.waiting = True
                            self.state.notify_all()
                            self.state.wait()
                        self.waiting = False
                        if self.closed:
                            return
                        if key in self.taken:
                            continue
                        self.reading = key
                    started = time.perf_counter()
                    data = self._read(handle, offset, size)
                    with self.state:
                        self.stats['seconds'] += time.perf_counter() - started
                        self.reading = None
                        if key not in self.taken and not self.closed:
                            self.ready[key] = data
                            self.held += size
                            self.stats['read_gib'] += size / GiB
                        self.state.notify_all()
        except OSError:
            pass  # what is not read ahead is read by whoever asks for it
        finally:
            with self.state:
                self.reading, self.waiting, self.done = None, False, True
                self.state.notify_all()

    def take(self, key):
        """The tensor of this key, or None for a key this reader does not follow."""
        import torch

        entry = self.plan.get(key)
        if entry is None:
            return None
        offset, size, dtype, shape = entry
        data = None
        with self.state:
            while not self.closed:
                if key in self.ready:
                    data = self.ready.pop(key)
                    self.held -= size
                    self.stats['ahead_gib'] += size / GiB
                    break
                # The thread is on it or will come to it: wait, unless it is held up by a full
                # window (what is ready is asked for later), or has passed this key already.
                if self.done or key in self.taken or (self.waiting and self.reading != key):
                    break
                self.state.wait(0.05)
            if data is None:
                self.taken.add(key)
            self.state.notify_all()
        if data is None:
            with self.direct:
                data = self._read(self.handle, offset, size)
            self.stats['direct_gib'] += size / GiB
        return data.view(getattr(torch, _DTYPES[dtype])).reshape(shape)

    def close(self):
        with self.state:
            self.closed = True
            self.ready.clear()
            self.held = 0
            self.state.notify_all()
        self.thread.join(timeout=10)
        self.handle.close()

    def summary(self):
        return {name: round(value, 2) for name, value in self.stats.items()}


class Store:
    """`safe_open`-compatible reader over a resident arena (or the file mapping as fallback)."""

    def __init__(self, path, resident=True, reserve=None, evict=True, pin=True):
        """`resident`: True loads the file into RAM if it fits, 'if-present' only reuses an arena.
        `reserve`, `evict` and `pin`: see Residency.arena."""
        self.path = path
        if resident == 'if-present':
            self.arena = RESIDENCY.present(path)
        else:
            self.arena = RESIDENCY.arena(path, reserve=reserve, evict=evict, pin=pin) if resident else None
        self.mapping = None
        # A part of the file kept in locked RAM beside the mapping (see `keep`).
        self.part = None
        # Tensors read from the disk ahead of their use, for a file not kept in RAM (see `follow`).
        self.reader = None
        # The size of each tensor, read from the header when first asked (see `measure`).
        self.sizes = None
        if self.arena is not None:
            RESIDENCY.hold(self.arena)
        if self.arena is None:
            from safetensors import safe_open

            self.mapping = safe_open(path, framework='pt')

    def keep(self, keys, reserve=None, spare=()):
        """From now on these tensors are read from page-locked RAM (Residency.partial), the
        others from the mapping as before. Returns the bytes kept: 0 when the whole file is
        resident already, or when RAM does not allow it."""
        if self.arena is not None:
            return 0
        if self.part is not None and not set(keys) <= self.part.keys:
            # The part this store reads from no longer holds all that is asked (a store kept from
            # one generation to the next, for a video that leaves the model a smaller share): it
            # leaves first. Still held, it was not released when replaced, the new one found no
            # room beside it in RAM, and the steps copied from unlocked memory.
            RESIDENCY.drop(self.part)
            self.part = None
        arena = RESIDENCY.partial(self.path, keys, reserve, spare)
        if self.part is not None and self.part is not arena:
            RESIDENCY.drop(self.part)
        if arena is not None and arena is not self.part:
            RESIDENCY.hold(arena)
        self.part = arena
        return arena.size if arena else 0

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def follow(self, keys, ahead=GiB):
        """From now on these tensors, asked for in this order, come from the disk a little ahead
        of their use (see Reader) instead of through the mapping. Nothing changes for a file
        kept in RAM. Returns whether a reader was started."""
        if self.arena is not None or self.reader is not None:
            return False
        self.reader = Reader(self.path, keys, ahead)
        return True

    def close(self):
        if self.reader is not None:
            self.reader.close()
            self.reader = None
        if self.mapping is not None:
            self.mapping.__exit__(None, None, None)
            self.mapping = None
        if self.arena is not None:
            RESIDENCY.drop(self.arena)
        self.arena = None
        if self.part is not None:
            RESIDENCY.drop(self.part)
        self.part = None

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
        if self.part and key in self.part.header:
            return self.part.tensor(key)
        if self.reader is not None:
            value = self.reader.take(key)
            if value is not None:
                return value
        return self.mapping.get_tensor(key)

    def get_slice(self, key):
        if self.arena:
            return _Slice(self.arena.tensor(key))
        return self.mapping.get_slice(key)

    def measure(self, key):
        """(bytes, dimensions) of a tensor as the header of the file gives them: nothing of the
        tensor is read, where `get_tensor` maps it (6 s for the 4 000 tensors of a video model)."""
        if self.sizes is None:
            header = self.arena.header if self.arena else _header(self.path)[0]
            self.sizes = {
                name: (info['data_offsets'][1] - info['data_offsets'][0], len(info['shape']))
                for name, info in header.items()
                if name != '__metadata__'
            }
        return self.sizes[key]

    @property
    def pinned(self):
        return bool((self.arena and self.arena.pinned) or (self.part and self.part.pinned))


def open_store(path, resident=True, reserve=None, evict=True, pin=True):
    return Store(path, resident=resident, reserve=reserve, evict=evict, pin=pin)


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
