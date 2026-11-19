"""The libraries a creation imports, loaded once the worker has started rather than at its first creation.

The first creation of a session imported PyTorch then what its pipeline builds its models with
(diffusers, transformers): 5.8 s for Krea 2, 6.6 s for LTX 2.5 and 3.2 s for MiniMax H3 with their
files in the system's cache, 18.6 s the first time of an evening (19 November 2026, 0.6.105), before
anything was read of the model. A worker asked to (`warm` in its configuration, a setting of the
application, on unless the user turns it off) imports them in the background as soon as it has
answered. It costs 0.7 GiB of RAM from then on, and nothing of the card: no module is called, the
driver is given no context. Measured on the first Krea 2 picture of a worker (1024 x 1024, 8 steps,
three times or more each, alternated): 23.2 s without, 16.3 s asked for once the import has ended,
20.0 s asked for 3 s after the start, 23.1 s asked for at once (runner/MEMORY-STUDY.md).

What to import is not written here: each family's first creation of a process says what it imported
(`watch`), kept beside the caches (`warm.json`) and read at the next start. A family never used on
this computer is not prepared; a module that is gone since (an update) is passed over.

One thread imports at a time. A request that needs the libraries (`aside`) takes over once the
module being imported is imported, and imports the rest itself as it always did: it never waits for
what another family needs, and nothing is imported by two threads. The background import goes on
after it.

On Windows a library that opens looks at the process's standard handles, and that look waits for
a read in progress on a pipe: with the worker waiting for its next request the usual way, the
import stood still until a request came (numpy imported 12 s after the start instead of 0.12 s,
measured, and the first creation gained nothing). While the libraries are imported the worker
therefore asks the pipe whether something is to be read (`await_input`), and reads only then.
"""

import ctypes
import importlib
import json
import os
import sys
import threading
from contextlib import contextmanager
from pathlib import Path

NAME = 'warm.json'
# Imported whatever was kept: every family computes with it.
ALWAYS = ('torch',)
# What is kept of one family: more would be a file grown by mistake, not a list of libraries.
LIMIT = 8000

_thread = None
# Who imports: the background thread, one module at a time, or the requests that asked it aside.
_state = threading.Condition()
_importing = False
_requests = 0


def _file(config):
    return Path(config['cacheRoot']) / NAME


def _read(config):
    """What each family imported, by family; nothing for a file that cannot be read."""
    try:
        kept = json.loads(_file(config).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}
    if not isinstance(kept, dict):
        return {}
    return {
        family: [name for name in names if isinstance(name, str)]
        for family, names in kept.items()
        if isinstance(family, str) and isinstance(names, list)
    }


def _usable(name, module):
    """A module that can be imported again by its name: not ours (cheap, and some say by being
    there what the worker holds), not one made on the fly, nothing of ComfyUI (a pipeline refuses
    to end with it imported)."""
    return (
        isinstance(name, str)
        and name
        and not name.startswith(('runner', '_', '<', 'comfy.'))
        and name != 'comfy'
        and '<' not in name
        and getattr(module, '__spec__', None) is not None
    )


def _run(names):
    global _importing
    for name in names:
        with _state:
            while _requests:
                _state.wait()
            _importing = True
        try:
            importlib.import_module(name)
        except BaseException:  # noqa: BLE001 - gone since, or refusing to be imported alone: passed over
            pass
        finally:
            with _state:
                _importing = False
                _state.notify_all()


def start(config):
    """Imports in the background what the creations of this computer import; True when it began."""
    global _thread
    if config.get('warm') is not True:
        return False
    names = list(ALWAYS)
    seen = set(names)
    for family_names in _read(config).values():
        for name in family_names:
            if name not in seen:
                seen.add(name)
                names.append(name)
    with _state:
        if _thread is not None:
            return False
        _thread = threading.Thread(target=_run, args=(names,), name='warm', daemon=True)
        _thread.start()
    return True


@contextmanager
def aside():
    """Around a request that imports and computes: the background import stands aside for it, once
    the module it is on is imported (one the request would have imported itself), and goes on after."""
    global _requests
    with _state:
        _requests += 1
        while _importing:
            _state.wait()
    try:
        yield
    finally:
        with _state:
            _requests -= 1
            _state.notify_all()


def whole(name):
    """The module, if it is there and entirely imported. One the background is importing is in
    `sys.modules` half made: the interpreter marks it so (what `import` itself waits on)."""
    module = sys.modules.get(name)
    if module is None or getattr(getattr(module, '__spec__', None), '_initializing', False):
        return None
    return module


def await_input(source, pause=0.02):
    """Returns once the worker may read its next request: at once, except on Windows while the
    libraries are imported, where it waits until the pipe has something to read (or is closed, or
    the import ended) so that no read is in progress while a library opens."""
    thread = _thread
    if thread is None or not thread.is_alive() or sys.platform != 'win32':
        return
    try:
        import msvcrt

        handle = msvcrt.get_osfhandle(source.fileno())
        peek = ctypes.windll.kernel32.PeekNamedPipe
    except (OSError, ValueError, AttributeError):
        # Not a file of the system (a test's text): nothing to wait for.
        return
    available = ctypes.c_ulong(0)
    arguments = (ctypes.c_void_p(handle), None, ctypes.c_ulong(0), None, ctypes.byref(available), None)
    # (Not a pipe, or its other end closed: the call fails, and the read says the rest.)
    while thread.is_alive() and peek(*arguments) and not available.value:
        thread.join(pause)


@contextmanager
def watch(config, job):
    """Around a creation: what it imported that this process had not is kept for its family."""
    before = set(sys.modules)
    yield
    # (Only a creation that went to its end: one that failed may have stopped half-way through them,
    # and its job or its configuration may not even be valid.)
    new = [name for name, module in list(sys.modules.items()) if name not in before and _usable(name, module)]
    if not new:
        return
    try:
        family = job['pipeline']
        kept = _read(config)
        known = kept.get(family, [])
        seen = set(known)
        kept[family] = (known + [name for name in new if name not in seen])[-LIMIT:]
        target = _file(config)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f'{NAME}.{os.getpid()}.tmp')
        temporary.write_text(json.dumps(kept), encoding='utf-8')
        os.replace(temporary, target)
    except (OSError, KeyError, TypeError):
        # Not kept this time: the next creation says it again.
        pass
