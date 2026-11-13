"""The graphics card a family needs, checked before anything is unloaded for it.

A manifest says what its family computes on: ``"hardware": {"cuda": true, "vramGiB": 10}`` is an
NVIDIA card (PyTorch here is built for CUDA) with that much video memory in all; a family
without the field also runs on the processor. Two checks, neither of which takes video memory:

- ``unmet`` when the worker says what it can run: the cards the driver lists (``nvidia-smi``,
  without loading PyTorch), so the application does not offer what this computer cannot make;
- ``confirm`` at preflight, while the chat model is still loaded: PyTorch itself sees the card
  (a driver too old for this PyTorch lists its card and still cannot compute on it).

What cannot be known (no ``nvidia-smi`` in a Linux container that has the driver) refuses nothing.
"""

import os
import subprocess
import sys

QUERY = ['nvidia-smi', '--query-gpu=name,memory.total', '--format=csv,noheader,nounits']
_found = {}


def nvidia_cards(run=subprocess.run, platform=sys.platform, exists=os.path.exists):
    """``[(name, MiB of video memory)]`` for the NVIDIA cards the driver lists: empty when this
    computer has none, None when it cannot be known."""
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
    cards = []
    for line in answer.stdout.splitlines():
        name, _, memory = line.rpartition(',')
        if name.strip() and memory.strip().isdigit():
            cards.append((name.strip(), int(memory)))
    return cards


def cards():
    """``nvidia_cards()``, asked once per process."""
    if 'cards' not in _found:
        _found['cards'] = nvidia_cards()
    return _found['cards']


# For a family ComfyUI also runs: it manages with less (it keeps what does not fit in main memory).
ELSEWHERE = ' ComfyUI peut créer à sa place : réglages, Workflows, moteur externe.'


def unmet(label, needs, external=False, found=None):
    """Why this computer cannot run a family that needs ``needs``, in the user's words; '' when
    it can, or when nothing says it cannot. ``external``: ComfyUI runs the family too."""
    if not needs or not needs.get('cuda'):
        return ''
    listed = (found or cards)()
    if listed is None:
        return ''
    hint = ELSEWHERE if external else ''
    if not listed:
        return label + ' demande une carte graphique NVIDIA : son pilote n’en voit aucune sur cet ordinateur.' + hint
    name, memory = max(listed, key=lambda card: card[1])
    wanted = needs.get('vramGiB', 0)
    if memory < wanted * 1024:
        return (
            f'{label} demande une carte NVIDIA d’au moins {wanted:g} Go de mémoire vidéo : '
            f'la {name} en a {memory / 1024:.0f}.' + hint
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
