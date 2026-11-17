"""The graphics card a family needs, checked before anything is unloaded for it.

A manifest says what its family computes on: ``"hardware": {"cuda": true}`` is an NVIDIA card
(PyTorch here is built for CUDA), whatever the files chosen; a family without the field also runs
on the processor. How much video memory a generation takes is not asked here: it depends on the
files the user chose (a smaller model fits a smaller card). Two checks, neither of which takes
video memory:

- ``unmet`` when the worker says what it can run: the cards the driver lists (``nvidia-smi``,
  without loading PyTorch), so the application shows greyed, with the reason, what this
  computer cannot make;
- ``confirm`` at preflight, while the chat model is still loaded: PyTorch itself sees the card
  (a driver too old for this PyTorch lists its card and still cannot compute on it).

What cannot be known (no ``nvidia-smi`` in a Linux container that has the driver) refuses nothing.
"""

import ctypes
import os
import subprocess
import sys

QUERY = ['nvidia-smi', '--query-gpu=name', '--format=csv,noheader']
_found = {}


def nvidia_cards(run=subprocess.run, platform=sys.platform, exists=os.path.exists):
    """The names of the NVIDIA cards the driver lists: empty when this computer has none, None
    when it cannot be known."""
    try:
        answer = run(
            QUERY,
            capture_output=True,
            text=True,
            timeout=10,
            # No console window flashing on Windows.
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0) if platform == 'win32' else 0,
        )
    except FileNotFoundError:
        # The NVIDIA driver installs nvidia-smi on Windows; on Linux a container may hold the
        # driver without it.
        return None if platform != 'win32' and exists('/proc/driver/nvidia') else []
    except (OSError, subprocess.SubprocessError):
        return None
    if answer.returncode:
        text = (answer.stdout or '') + (answer.stderr or '')
        return [] if 'No devices were found' in text or 'communicate with the NVIDIA driver' in text else None
    return [line.strip() for line in answer.stdout.splitlines() if line.strip()]


MEMORY = ['nvidia-smi', '--query-gpu=memory.total', '--format=csv,noheader,nounits']


def card_gib(run=subprocess.run, platform=sys.platform):
    """The video memory of the first NVIDIA card, in GiB, as its driver says it (PyTorch is not
    loaded for it, and nothing is taken on the card); None when it cannot be known."""
    if 'gib' in _found and run is subprocess.run:
        return _found['gib']
    found = None
    try:
        answer = run(
            MEMORY,
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0) if platform == 'win32' else 0,
        )
        if not answer.returncode:
            found = float(answer.stdout.split()[0]) / 1024
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        found = None
    if run is subprocess.run:
        _found['gib'] = found
    return found


class _Memory(ctypes.Structure):
    _fields_ = [('total', ctypes.c_ulonglong), ('free', ctypes.c_ulonglong), ('used', ctypes.c_ulonglong)]


def _nvml(platform=sys.platform):
    """The driver's own library (NVML) and its first card, opened once; None when it is not there."""
    if 'nvml' not in _found:
        found = None
        try:
            library = ctypes.CDLL('nvml.dll' if platform == 'win32' else 'libnvidia-ml.so.1')
            count, handle = ctypes.c_uint(), ctypes.c_void_p()
            opened = (
                library.nvmlInit_v2() == 0
                and library.nvmlDeviceGetCount_v2(ctypes.byref(count)) == 0
                # Several cards: which one PyTorch computes on is not asked of the driver here.
                and count.value == 1
                and library.nvmlDeviceGetHandleByIndex_v2(0, ctypes.byref(handle)) == 0
            )
            if opened:
                found = (library, handle)
        except (OSError, AttributeError):
            found = None
        _found['nvml'] = found
    return _found['nvml']


def device_memory():
    """(free, total) bytes of the card as its driver counts them, every program included; None
    when the driver cannot be asked."""
    opened = _nvml()
    if not opened:
        return None
    library, handle = opened
    memory = _Memory()
    if library.nvmlDeviceGetMemoryInfo(handle, ctypes.byref(memory)) != 0:
        return None
    return memory.free, memory.total


def free_bytes(torch, device=device_memory):
    """The video memory that is free now, in bytes: the least of what PyTorch says and of what
    the driver counts.

    On Windows PyTorch says what this process may still take of its own budget (the card less
    a fixed share), whatever the other programs hold. With 4 GiB of a 12 GiB card taken by
    another process it still said 10.8 GiB free: the engine filled them, the driver put the
    overflow in the shared memory, and an image took 474 s instead of 30, without an error
    (17/11). The driver counts every program. Every pipeline asks here, and here only.
    (A PyTorch that is not the real one, in a test, is believed as it is; so is one whose
    card is not the one the driver counted.)"""
    free, total = torch.cuda.mem_get_info()
    if getattr(torch, '__name__', None) != 'torch':
        return free
    counted = device()
    if not counted or abs(counted[1] - total) > 0.05 * total:
        return free
    return min(free, counted[0])


def cards():
    """``nvidia_cards()``, asked once per process."""
    if 'cards' not in _found:
        _found['cards'] = nvidia_cards()
    return _found['cards']


# For a family ComfyUI also runs.
ELSEWHERE = ' ComfyUI peut créer à sa place : réglages, Workflows, moteur externe.'


def unmet(label, needs, external=False, found=None):
    """Why this computer cannot run a family that needs ``needs``, in the user's words; '' when
    it can, or when nothing says it cannot. ``external``: ComfyUI runs the family too."""
    if not needs or not needs.get('cuda'):
        return ''
    listed = (found or cards)()
    if listed is None:
        return ''
    if not listed:
        return (
            label
            + ' demande une carte graphique NVIDIA : son pilote n’en voit aucune sur cet ordinateur.'
            + (ELSEWHERE if external else '')
        )
    return ''


def confirm(label, needs):
    """PyTorch sees the card the family needs, or the reason it does not. Loads PyTorch (as the
    generation would a moment later) and takes no video memory."""
    if not needs or not needs.get('cuda'):
        return
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError(
            label
            + ' demande une carte graphique NVIDIA que PyTorch puisse utiliser : il n’en trouve pas'
            + ' (carte absente, ou pilote NVIDIA trop ancien pour CUDA '
            + str(torch.version.cuda or '?')
            + ').'
        )
