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

    def test_with_a_window_the_read_stays_just_ahead_of_what_the_model_uses(self):
        import time
        from runner.models import residency

        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, 'weights.safetensors')
            base = _safetensors(path, {'a.weight': b'a' * 10000})
            used = [0]
            ahead = residency.Prefetch([(path, [(base, base + 10000)])], chunk=1000, window=2000, lead=lambda: used[0])
            time.sleep(0.3)
            self.assertFalse(ahead.done)
            self.assertEqual(ahead.bytes, 3000)  # one chunk past the window, then it waits
            used[0] = 4000
            time.sleep(0.3)
            self.assertEqual(ahead.bytes, 7000)
            used[0] = 10000
            ahead._thread.join(timeout=10)
            self.assertEqual(ahead.bytes, 10000)
            self.assertEqual(ahead.stop()['window_gib'], 0.0)
            # Stopped while it waits (the step is over): it ends at once.
            waiting = residency.Prefetch([(path, [(base, base + 10000)])], chunk=1000, window=0, lead=lambda: 0)
            time.sleep(0.1)
            waiting.stop()
            self.assertTrue(waiting.done)

    def test_a_plan_too_large_for_the_ram_follows_the_layers_not_the_file(self):
        from runner.models import residency

        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, 'weights.safetensors')
            # Stored by name, as ComfyUI does: block 10 before block 2.
            base = _safetensors(
                path,
                {
                    'blocks.0.fc.weight': b'a' * 100,
                    'blocks.0.fc.weight_scale': b's' * 10,
                    'blocks.1.fc.weight': b'b' * 100,
                    'blocks.10.fc.weight': b'c' * 100,
                    'blocks.2.fc.weight': b'd' * 100,
                    'blocks.2.fc.bias': b'e' * 10,
                },
            )
            names = {
                f'transformer_blocks.{index}.fc.weight': ('model', f'blocks.{index}.fc.weight', None)
                for index in (0, 1, 10, 2)
            }
            order = residency.use_order(names)
            self.assertEqual([key for _role, key, _part in order], [f'blocks.{index}.fc.weight' for index in (0, 1, 2, 10)])
            # Three parts of one stored tensor (q, k, v) are one read.
            order.insert(1, ('model', 'blocks.0.fc.weight', 1))
            plan = residency._as_used({'model': path}, order, lambda role: True)
            self.assertEqual(
                plan,
                [
                    (path, [(base, base + 210)]),  # blocks 0 and 1 follow each other in the file
                    (path, [(base + 310, base + 420)]),  # block 2 and its bias
                    (path, [(base + 210, base + 310)]),  # block 10, stored before it
                ],
            )
            self.assertEqual(residency._as_used({'model': path}, order, lambda role: False), [])
            saved = residency._fits
            residency._fits = lambda plan: False
            try:
                ahead = residency.prefetch({'model': path}, {'model': SimpleNamespace(arena=None)}, order, lead=lambda: 10**9)
            finally:
                residency._fits = saved
            ahead._thread.join(timeout=10)
            self.assertEqual((ahead.bytes, ahead.window, ahead.error), (420, residency.WINDOW, None))

    def test_a_missing_file_is_reported_not_raised(self):
        from runner.models import residency

        ahead = residency.Prefetch([(os.path.join(tempfile.gettempdir(), 'atelier-missing.safetensors'), [(0, 10)])])
        self.assertIn('error', ahead.stop())


if __name__ == '__main__':
    unittest.main()
