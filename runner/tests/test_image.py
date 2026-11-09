import json
from pathlib import Path
import tempfile
import unittest


class ImageTests(unittest.TestCase):
    def test_simple_schedule_retains_original_values_and_bounds_work(self):
        import torch
        from runner.pipelines.sampling import simple_sigmas

        grid = torch.arange(1, 10001, dtype=torch.float32) / 10000
        shifted = __import__('math').exp(1.15) / (__import__('math').exp(1.15) + (1 / grid - 1))
        for steps, denoise in [(8, 1), (8, 0.4), (4, 0.7)]:
            total = max(steps, int(steps / denoise))
            expected = [float(shifted[-(1 + int(i * 10000 / total))]) for i in range(total)] + [0.0]
            self.assertEqual(simple_sigmas(steps, denoise, torch), expected[-steps - 1 :])
        self.assertEqual(len(simple_sigmas(8, 1e-310, torch)), 9)

    def test_fused_lora_retains_convrot_algebra(self):
        import torch
        from runner.models.weights import fuse, rotation_matrix

        torch.manual_seed(4)
        rotation = rotation_matrix(256, torch, 'cpu', torch.float32)
        original = torch.randn(32, 256) * 0.05
        scale = original.abs().amax(-1, keepdim=True) / 127
        weight = (original / scale).round().clamp(-127, 127).to(torch.int8)
        adapters = [(torch.randn(4, 256) * 0.02, torch.randn(32, 4) * 0.02, s) for s in (0.55, -0.1)]
        packed, error = fuse(weight, scale, rotation, adapters)
        expected = (weight.float() * scale) @ rotation
        for a, b, strength in adapters:
            expected += (b @ a) * strength
        actual = (packed['weight'].float() * packed['scale']) @ rotation
        self.assertLess(error, 0.02)
        self.assertLess(((actual - expected).square().sum() / expected.square().sum()).sqrt().item(), 0.02)

    def test_cache_identity_includes_adapter_strength_and_file_changes(self):
        from runner.models.weights import cache_key

        with tempfile.TemporaryDirectory() as directory:
            model = Path(directory) / 'model'
            model.write_bytes(b'model')
            adapter = Path(directory) / 'adapter'
            adapter.write_bytes(b'adapter')
            first = cache_key(model, [({'strength': 0.5}, adapter)])
            self.assertEqual(first, cache_key(model, [({'strength': 0.5}, adapter)]))
            self.assertNotEqual(first, cache_key(model, [({'strength': 0.6}, adapter)]))
            model.write_bytes(b'changed')
            self.assertNotEqual(first, cache_key(model, [({'strength': 0.5}, adapter)]))

    def test_original_manifest_and_embedded_metadata_retain_resolved_seed(self):
        import numpy as np
        from PIL import Image
        from runner.media import save_image
        from runner.tests.test_contracts import job

        with tempfile.TemporaryDirectory() as directory:
            value = job()
            metadata = dict(job=value)
            result = save_image(np.zeros((64, 64, 3), dtype=np.uint8), dict(outputRoot=directory), value, metadata)
            descriptor = result['outputs'][0]
            output = Path(directory) / descriptor['filename']
            self.assertEqual(output.parent, Path(directory))
            with Image.open(output) as image:
                self.assertEqual(json.loads(image.info['atelier'])['job']['parameters']['seed'], 7)
            self.assertEqual(json.loads(output.with_suffix('.json').read_text())['jobId'], value['id'])


if __name__ == '__main__':
    unittest.main()
