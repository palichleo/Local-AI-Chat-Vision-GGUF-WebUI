import json
import os
import struct
import tempfile
import unittest
from types import SimpleNamespace


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


def _safetensors(path, tensors):
    """A safetensors file written by hand: {name: bytes}, each stored as I8."""
    header, offset = {}, 0
    for name, data in tensors.items():
        header[name] = dict(dtype='I8', shape=[len(data)], data_offsets=[offset, offset + len(data)])
        offset += len(data)
    encoded = json.dumps(header).encode()
    with open(path, 'wb') as handle:
        handle.write(struct.pack('<Q', len(encoded)) + encoded + b''.join(tensors.values()))
    return 8 + len(encoded)


class PrefetchTest(unittest.TestCase):
    def test_reads_ahead_only_the_wanted_weights_of_mapped_files(self):
        from runner.models import residency

        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, 'weights.safetensors')
            base = _safetensors(
                path,
                {
                    'a.weight': b'a' * 1000,
                    'a.weight_scale': b's' * 10,
                    'unused.weight': b'u' * 5000,
                    'b.weight': b'b' * 2000,
                    'b.bias': b'c' * 20,
                },
            )
            # A weight comes with its scale and bias; close ranges are read as one.
            self.assertEqual(
                residency.weight_ranges(path, ['a.weight', 'b.weight'], gap=100),
                [(base, base + 1010), (base + 6010, base + 8030)],
            )
            self.assertEqual(
                residency.weight_ranges(path, ['a.weight', 'b.weight'], gap=5000), [(base, base + 8030)]
            )
            mapped = SimpleNamespace(arena=None)
            ahead = residency.prefetch({'model': path}, {'model': mapped}, [('model', 'a.weight', None), ('model', 'b.weight', 1)])
            ahead._thread.join(timeout=10)
            self.assertTrue(ahead.done)
            report = ahead.stop()
            self.assertEqual(ahead.bytes, 8030)  # one range: the default gap spans the unused tensor
            self.assertNotIn('error', report)
            # A file held in RAM is already read in sequence: nothing to do.
            resident = SimpleNamespace(arena=object())
            self.assertIsNone(residency.prefetch({'model': path}, {'model': resident}, [('model', 'a.weight', None)]))
            self.assertIsNone(residency.prefetch({'model': path}, {'model': mapped}, [('other', 'a.weight', None)]))

    def test_a_missing_file_is_reported_not_raised(self):
        from runner.models import residency

        ahead = residency.Prefetch([(os.path.join(tempfile.gettempdir(), 'atelier-missing.safetensors'), [(0, 10)])])
        self.assertIn('error', ahead.stop())


if __name__ == '__main__':
    unittest.main()
