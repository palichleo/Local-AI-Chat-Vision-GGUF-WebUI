import os
import tempfile
import unittest


class ResidencyTest(unittest.TestCase):
    def test_resident_store_matches_safetensors_and_reloads_changed_files(self):
        try:
            import torch
            import psutil  # noqa: F401
            from safetensors import safe_open
            from safetensors.torch import save_file
        except ImportError:
            self.skipTest('torch, psutil and safetensors are required')
        from runner.models import residency

        saved = residency.RESERVE
        residency.RESERVE = 0
        try:
            with tempfile.TemporaryDirectory() as folder:
                path = os.path.join(folder, 'weights.safetensors')
                tensors = {
                    'odd': torch.tensor([1, 2, 3], dtype=torch.uint8),  # misaligns what follows
                    'f32': torch.randn(3, 5),
                    'bf16': torch.randn(7).to(torch.bfloat16),
                    'i8': torch.arange(10, dtype=torch.int8),
                    'fp8': torch.randn(4).to(torch.float8_e4m3fn),
                }
                save_file(tensors, path, metadata={'kind': 'test'})
                store = residency.open_store(path)
                self.assertIsNotNone(store.arena)
                self.assertEqual(store.metadata(), {'kind': 'test'})
                with safe_open(path, framework='pt') as reference:
                    for key in reference.keys():
                        a, b = store.get_tensor(key), reference.get_tensor(key)
                        self.assertEqual((a.dtype, a.shape), (b.dtype, b.shape))
                        self.assertTrue(torch.equal(a.float(), b.float()), key)
                self.assertEqual(store.get_slice('f32').get_shape(), [3, 5])
                self.assertIs(residency.open_store(path, 'if-present').arena, store.arena)
                save_file({'f32': torch.zeros(2)}, path)
                self.assertIsNone(residency.open_store(path, 'if-present').arena)
                self.assertEqual(residency.open_store(path).get_tensor('f32').tolist(), [0.0, 0.0])
        finally:
            residency.RESERVE = saved
            residency.RESIDENCY.clear()


if __name__ == '__main__':
    unittest.main()
