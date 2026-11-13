import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from runner import engine, hardware
from runner.registry import capabilities, families

CUDA = {'cuda': True}


def answer(stdout='', returncode=0, stderr=''):
    return lambda *args, **kwargs: SimpleNamespace(stdout=stdout, stderr=stderr, returncode=returncode)


def missing(*args, **kwargs):
    raise FileNotFoundError('nvidia-smi')


class CardsTest(unittest.TestCase):
    """What the driver says of this computer's NVIDIA cards, on each system."""

    def test_the_cards_the_driver_lists(self):
        listed = hardware.nvidia_cards(run=answer('NVIDIA GeForce RTX 4070 SUPER\nNVIDIA RTX A2000\n'))
        self.assertEqual(listed, ['NVIDIA GeForce RTX 4070 SUPER', 'NVIDIA RTX A2000'])

    def test_no_card_is_known_and_what_is_not_known_is_not_guessed(self):
        # A driver without a card, or one that lost it.
        self.assertEqual(hardware.nvidia_cards(run=answer('No devices were found\n', returncode=6)), [])
        failed = "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver."
        self.assertEqual(hardware.nvidia_cards(run=answer(failed, returncode=9)), [])
        # No nvidia-smi: no NVIDIA driver on Windows (AMD, Intel, no card); on Linux a container
        # may have the driver without the tool.
        self.assertEqual(hardware.nvidia_cards(run=missing, platform='win32'), [])
        self.assertEqual(hardware.nvidia_cards(run=missing, platform='linux', exists=lambda path: False), [])
        self.assertIsNone(hardware.nvidia_cards(run=missing, platform='linux', exists=lambda path: True))
        # A tool that fails otherwise, or never answers, says nothing.
        self.assertIsNone(hardware.nvidia_cards(run=answer('Unknown Error', returncode=255)))

        def stuck(*args, **kwargs):
            raise subprocess.TimeoutExpired('nvidia-smi', 10)

        self.assertIsNone(hardware.nvidia_cards(run=stuck))


class NeedsTest(unittest.TestCase):
    """A family that computes on an NVIDIA card only, on machines of several kinds."""

    def test_only_a_card_known_to_be_missing_refuses(self):
        said = lambda cards, **options: hardware.unmet('Krea2', CUDA, found=lambda: cards, **options)  # noqa: E731
        self.assertIn('n’en voit aucune', said([]))
        # Any NVIDIA card runs it as far as this goes: how much video memory a generation takes
        # depends on the files chosen, and a smaller model fits a smaller card. So does a machine
        # nothing is known of.
        for card in ('NVIDIA GeForce GTX 1650', 'NVIDIA GeForce RTX 4060', 'NVIDIA GeForce RTX 4090'):
            self.assertEqual(said([card]), '')
        self.assertEqual(said(None), '')
        # ComfyUI is named only for a family it runs too.
        self.assertIn('ComfyUI', said([], external=True))
        self.assertNotIn('ComfyUI', said([]))

    def test_a_family_that_also_runs_on_the_processor_asks_for_nothing(self):
        self.assertEqual(hardware.unmet('RIFE', None, found=lambda: []), '')
        self.assertIn('NVIDIA', hardware.unmet('SeedVR2', CUDA, found=lambda: []))


class CapabilitiesTest(unittest.TestCase):
    """What the worker says it can run, on this computer and on others."""

    def said(self, cards):
        with patch.dict(hardware._found, {'cards': cards}):
            return capabilities()

    def test_what_a_computer_cannot_make_is_said_with_its_reason(self):
        processor = {'acestep15', 'moss_sfx', 'realesrgan_image', 'realesrgan_video', 'rife'}
        ready = lambda cards: {name for name, item in self.said(cards).items() if item['ready']}  # noqa: E731
        everything = set(capabilities())
        # Any NVIDIA card, small or large: nothing is refused for its size.
        for card in ('NVIDIA GeForce RTX 4060', 'NVIDIA GeForce RTX 4070 SUPER'):
            self.assertEqual(ready([card]), everything, card)
        # No NVIDIA card (AMD, Intel, none): sounds, upscaling and interpolation on the processor.
        self.assertEqual(ready([]), processor)
        # Nothing known: nothing refused here (preflight asks PyTorch).
        self.assertEqual(ready(None), everything)
        # The reason is the computer's: told apart, for the application to show the family greyed.
        none = self.said([])
        self.assertIn('carte graphique NVIDIA', none['krea2']['reason'])
        self.assertIs(none['krea2']['hardware'], True)
        self.assertNotIn('hardware', none['rife'])
        self.assertNotIn('hardware', self.said(['NVIDIA GeForce RTX 4060'])['krea2'])

    def test_a_pipeline_that_needs_cuda_says_so_in_its_manifest(self):
        pipelines = Path(engine.__file__).with_name('pipelines')
        for name, manifest in families().items():
            if not manifest.get('native', True):
                continue
            source = (pipelines / (manifest.get('module', name) + '.py')).read_text(encoding='utf-8')
            needs = bool(re.search(r"raise RuntimeError\([^)]*requires (?:a )?CUDA", source))
            self.assertEqual(bool((manifest.get('hardware') or {}).get('cuda')), needs, name)
            # Nothing that depends on the files chosen (a size of video memory) is declared.
            self.assertLessEqual(set(manifest.get('hardware') or {}), {'cuda'}, name)


class ConfirmTest(unittest.TestCase):
    """Preflight, while the chat model is still loaded: PyTorch sees the card or says why not."""

    def test_a_card_pytorch_cannot_use_is_refused_before_anything_is_unloaded(self):
        blind = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False), version=SimpleNamespace(cuda='13.0'))
        with patch.dict(sys.modules, {'torch': blind}):
            with self.assertRaisesRegex(RuntimeError, 'Krea2 demande une carte graphique NVIDIA.*CUDA 13.0'):
                hardware.confirm('Krea2', CUDA)
            # A family that runs on the processor is not asked.
            hardware.confirm('RIFE', None)

    def test_preflight_refuses_a_computer_without_the_card_with_the_reason(self):
        from runner.tests.test_registry import ltx_job

        with tempfile.TemporaryDirectory() as root:
            config = dict(cacheRoot=root, outputRoot=root)
            with patch.dict(hardware._found, {'cards': []}):
                with self.assertRaisesRegex(RuntimeError, 'LTX2.5 demande une carte graphique NVIDIA'):
                    engine.preflight(ltx_job(), config)

    def test_asking_pytorch_takes_no_video_memory(self):
        code = '''import sys
sys.path.insert(0,sys.argv[1])
import torch
def forbid(*args,**kwargs):
    raise AssertionError('Preflight attempted CUDA initialization')
torch.cuda._lazy_init=forbid
from runner import hardware
try:hardware.confirm('Krea2',{'cuda':True})
except RuntimeError:pass
assert not torch.cuda.is_initialized()
'''
        result = subprocess.run(
            [sys.executable, '-s', '-c', code, str(Path.cwd())], text=True, capture_output=True, timeout=120
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
