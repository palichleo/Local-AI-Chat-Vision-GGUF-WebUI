"""Keep the text conditioning of recent prompts on disk.

Encoding a prompt loads a 12 to 16 GiB text encoder. Reading it takes seven to ten seconds,
and it pushes the video model out of the system's file cache, so the model is then read
from the disk again. A prompt already encoded with the same encoder (a draft rendered as a
final, another seed, a changed size, a second attempt) is read back in a fraction of a
second, and the video model stays in RAM.

An entry is named by a SHA-256 of everything its conditioning depends on; the prompt
itself is never written. The folder is capped at LIMIT and its oldest entries leave first.
"""

import dataclasses
import hashlib
import json
import os
from pathlib import Path

VERSION = '1'  # change it when what is stored for a key changes
LIMIT = 2 * 1024**3


class Uncacheable(TypeError):
    pass


def stamp(path):
    """What tells one version of a file (or of a folder's files) from another."""
    path = Path(path)
    if path.is_dir():
        return [[item.name, *stamp(item)] for item in sorted(path.iterdir()) if item.is_file()]
    status = path.stat()
    return [str(path.resolve()), status.st_size, status.st_mtime_ns]


def _feed(digest, value):
    """Hash a value by content, with its type and boundaries, so that no two inputs collide."""
    if value is None or isinstance(value, (bool, int, float, str)):
        digest.update(repr((type(value).__name__, value)).encode())
    elif isinstance(value, (bytes, bytearray)):
        digest.update(b'b%d:' % len(value) + bytes(value))
    elif isinstance(value, (list, tuple)):
        digest.update(b'[%d:' % len(value))
        for item in value:
            _feed(digest, item)
    elif isinstance(value, dict):
        digest.update(b'{%d:' % len(value))
        for name in sorted(value, key=str):
            _feed(digest, str(name))
            _feed(digest, value[name])
    elif all(hasattr(value, name) for name in ('mode', 'size', 'tobytes')):  # a PIL image
        _feed(digest, ['image', value.mode, list(value.size), value.tobytes()])
    elif all(hasattr(value, name) for name in ('detach', 'cpu', 'dtype', 'shape')):  # a tensor
        import torch

        raw = value.detach().cpu().contiguous().reshape(-1).view(torch.uint8).numpy().tobytes()
        _feed(digest, ['tensor', str(value.dtype), list(value.shape), raw])
    elif hasattr(value, 'dtype') and hasattr(value, 'tobytes'):  # a NumPy array
        _feed(digest, ['array', str(value.dtype), list(value.shape), value.tobytes()])
    elif dataclasses.is_dataclass(value) and not isinstance(value, type):
        _feed(digest, [type(value).__name__, {field.name: getattr(value, field.name) for field in dataclasses.fields(value)}])
    else:
        raise Uncacheable(type(value).__name__)


def key(*parts):
    """The entry name for these inputs, or None when one of them cannot be told apart by content."""
    digest = hashlib.sha256()
    try:
        _feed(digest, [VERSION, *parts])
    except Uncacheable:
        return None
    return digest.hexdigest()


def _folder(config):
    return Path(config['cacheRoot']) / 'conditioning'


def load(config, name):
    """({tensor name: CPU tensor}, notes) of an entry, or None. A damaged entry is removed."""
    if not name:
        return None
    path = _folder(config) / (name + '.safetensors')
    if not path.is_file():
        return None
    try:
        from safetensors import safe_open

        with safe_open(str(path), framework='pt') as handle:
            notes = json.loads((handle.metadata() or {}).get('notes', '{}'))
            tensors = {name: handle.get_tensor(name).clone() for name in handle.keys()}
        os.utime(path)  # recently used: the last to leave
        return tensors, notes
    except Exception:
        try:
            path.unlink()
        except OSError:
            pass
        return None


def save(config, name, tensors, notes=None):
    """Write an entry (never fails the job: a full disk only loses the shortcut)."""
    if not name:
        return False
    folder = _folder(config)
    path = folder / (name + '.safetensors')
    partial = folder / (name + '.partial')
    try:
        from safetensors.torch import save_file

        folder.mkdir(parents=True, exist_ok=True)
        save_file(
            {label: value.detach().to('cpu').contiguous() for label, value in tensors.items()},
            str(partial),
            metadata={'notes': json.dumps(notes or {})},
        )
        os.replace(partial, path)
        _trim(folder, keep=path)
        return True
    except Exception:
        try:
            partial.unlink()
        except OSError:
            pass
        return False


def _trim(folder, keep):
    entries = sorted(
        (item for item in folder.glob('*.safetensors')), key=lambda item: item.stat().st_mtime_ns, reverse=True
    )
    total = 0
    for item in entries:
        total += item.stat().st_size
        if total > LIMIT and item != keep:
            try:
                item.unlink()
            except OSError:
                pass


def _same(before, after):
    if before is after:
        return True
    if type(before) is not type(after):
        return False
    if hasattr(after, 'detach'):
        import torch

        return before.shape == after.shape and before.dtype == after.dtype and bool(torch.equal(before, after))
    try:
        return bool(before == after)
    except Exception:
        return False


def _plain(value):
    try:
        return json.loads(json.dumps(value)) == value
    except (TypeError, ValueError):
        return False


def changes(before, after):
    """What a stage wrote into a request state ({name: value} before and after), as
    (tensors, notes) ready for `save`; None when a written value is neither a tensor nor
    plain data, which a later `restore` could not give back."""
    tensors, plain, devices = {}, {}, {}
    for name, value in after.items():
        if name in before and _same(before[name], value):
            continue
        if hasattr(value, 'detach'):
            tensors[name] = value
            devices[name] = value.device.type
        elif _plain(value):
            plain[name] = value
        else:
            return None
    return tensors, dict(plain=plain, devices=devices)


def restore(tensors, notes):
    """The values `changes` kept, tensors back on the kind of device they were written on."""
    values = dict(notes.get('plain', {}))
    for name, value in tensors.items():
        values[name] = value.to(notes.get('devices', {}).get(name, 'cpu'))
    return values
