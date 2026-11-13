import re
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from runner import engine, hardware
from runner.registry import capabilities, families

CUDA = {'cuda': True, 'vramGiB': 10}


def answer(stdout='', returncode=0, stderr=''):
    return lambda *args, **kwargs: SimpleNamespace(stdout=stdout, stderr=stderr, returncode=returncode)


def missing(*args, **kwargs):
    raise FileNotFoundError('nvidia-smi')


class CardsTest(unittest.TestCase):
    """What the driver says of this computer's NVIDIA cards, on each system."""

    def test_the_cards_the_driver_lists_with_their_memory(self):
        listed = hardware.nvidia_cards(run=answer('NVIDIA GeForce RTX 4070 SUPER, 12282\nNVIDIA RTX A2000, 6138\n'))
        self.assertEqual(listed, [('NVIDIA GeForce RTX 4070 SUPER', 12282), ('NVIDIA RTX A2000', 6138)])

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
    """A family that asks for an NVIDIA card of 10 GB, on machines of several kinds."""

    def test_only_a_card_known_to_be_missing_or_too_small_refuses(self):
        said = lambda cards, **options: hardware.unmet('Krea2', CUDA, found=lambda: cards, **options)  # noqa: E731
        self.assertIn('n’en voit aucune', said([]))
        self.assertIn('au moins 10 Go', said([('NVIDIA GeForce RTX 4060', 8188)]))
        self.assertIn('la NVIDIA GeForce RTX 4060 en a 8', said([('NVIDIA GeForce RTX 4060', 8188)]))
        # 10, 12 and 24 GB cards run it; so does a machine nothing is known of.
        for memory in (10240, 12282, 24564):
            self.assertEqual(said([('card', memory)]), '')
        self.assertEqual(said(None), '')
        # Several cards: the largest decides.
        self.assertEqual(said([('small', 6138), ('large', 16376)]), '')
        # ComfyUI is named only for a family it runs too.
        self.assertIn('ComfyUI', said([], external=True))
        self.assertNotIn('ComfyUI', said([]))

    def test_a_family_that_also_runs_on_the_processor_asks_for_nothing(self):
        self.assertEqual(hardware.unmet('RIFE', None, found=lambda: []), '')
        self.assertEqual(hardware.unmet('SeedVR2', {'cuda': True}, found=lambda: [('card', 4096)]), '')
        self.assertIn('NVIDIA', hardware.unmet('SeedVR2', {'cuda': True}, found=lambda: []))


class CapabilitiesTest(unittest.TestCase):
    """What the worker says it can run, on this computer and on others."""

    def ready(self, cards):
        with patch.dict(hardware._found, {'cards': cards}):
            return {name: capability['ready'] for name, capability in capabilities().items()}

    def test_what_a_computer_cannot_make_is_not_offered(self):
        processor = {'acestep15', 'moss_sfx', 'realesrgan_image', 'realesrgan_video', 'rife'}
        large = self.ready([('NVIDIA GeForce RTX 4070 SUPER', 12282)])
        self.assertTrue(all(large.values()), large)
        # 8 GB: the image and video models need more; what remains still runs.
        small = self.ready([('NVIDIA GeForce RTX 4060', 8188)])
        self.assertEqual({name for name, ready in small.items() if ready}, processor | {'seedvr2'})
        # No NVIDIA card (AMD, Intel, none): sounds, upscaling and interpolation on the processor.
        none = self.ready([])
        self.assertEqual({name for name, ready in none.items() if ready}, processor)
        # Nothing known: nothing refused here (preflight asks PyTorch).
        self.assertTrue(all(self.ready(None).values()))
        with patch.dict(hardware._found, {'cards': []}):
            self.assertIn('carte graphique NVIDIA', capabilities()['krea2']['reason'])

    def test_a_pipeline_that_needs_cuda_says_so_in_its_manifest(self):
        pipelines = Path(engine.__file__).with_name('pipelines')
        for name, manifest in families().items():
            if not manifest.get('native', True):
                continue
            source = (pipelines / (manifest.get('module', name) + '.py')).read_text(encoding='utf-8')
            needs = bool(re.search(r"raise RuntimeError\([^)]*requires (?:a )?CUDA", source))
            self.assertEqual(bool((manifest.get('hardware') or {}).get('cuda')), needs, name)
            hardware_keys = set(manifest.get('hardware') or {})
            self.assertLessEqual(hardware_keys, {'cuda', 'vramGiB'}, name)


class ConfirmTest(unittest.TestCase):
    """Preflight, while the chat model is still loaded: PyTorch sees the card or says why not."""

    def test_a_card_pytorch_cannot_use_is_refused_before_anything_is_unloaded(self):
        blind = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False), version=SimpleNamespace(cuda='13.0'))
        with patch.dict(sys.modules, {'torch': blind}):
            with self.assertRaisesRegex(RuntimeError, 'Krea2 demande une carte graphique NVIDIA.*CUDA 13.0'):
                hardware.confirm('Krea2', CUDA)
            # A family that runs on the processor is not asked.
            hardware.confirm('RIFE', None)

    def test_preflight_refuses_a_card_too_small_with_the_reason(self):
        import tempfile

        from runner.tests.test_registry import ltx_job

        with tempfile.TemporaryDirectory() as root:
            config = dict(cacheRoot=root, outputRoot=root)
            with patch.dict(hardware._found, {'cards': [('NVIDIA GeForce RTX 4060', 8188)]}):
                with self.assertRaisesRegex(RuntimeError, 'LTX2.5 demande une carte NVIDIA d’au moins 10 Go'):
                    engine.preflight(ltx_job(), config)

    def test_asking_pytorch_takes_no_video_memory(self):
        code = '''import sys
sys.path.insert(0,sys.argv[1])
import torch
def forbid(*args,**kwargs):
    raise AssertionError('Preflight attempted CUDA initialization')
torch.cuda._lazy_init=forbid
from runner import hardware
try:hardware.confirm('Krea2',{'cuda':True,'vramGiB':10})
except RuntimeError:pass
assert not torch.cuda.is_initialized()
'''
        result = subprocess.run(
            [sys.executable, '-s', '-c', code, str(Path.cwd())], text=True, capture_output=True, timeout=120
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
