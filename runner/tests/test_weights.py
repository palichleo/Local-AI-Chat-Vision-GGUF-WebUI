import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch


class Tensor:
    """What a WeightPool needs of a tensor, counting the copies to the GPU."""

    copies = 0

    def __init__(self, size):
        self.size, self.ndim = size, 2

    def to(self, device, non_blocking=False):
        Tensor.copies += 1
        return Tensor(self.size)

    def numel(self):
        return self.size

    def element_size(self):
        return 1


class Store:
    def __init__(self, sizes):
        self.sizes = sizes

    def keys(self):
        return list(self.sizes)

    def get_tensor(self, key):
        return Tensor(self.sizes[key])


class WeightPoolTest(unittest.TestCase):
    def pool(self, sizes, limit):
        from runner.models import ltx25

        torch = SimpleNamespace(cuda=SimpleNamespace(synchronize=lambda: None))
        with patch.dict(sys.modules, torch=torch, comfy_kitchen=SimpleNamespace()):
            pool = ltx25.WeightPool({'model': Store(sizes)}, limit / 1024**3)
        pool.order = [('model', key, None) for key in sizes]
        Tensor.copies = 0
        return pool, ltx25

    def test_the_gpu_share_is_filled_before_the_model_runs(self):
        pool, _ = self.pool({'a.weight': 60, 'b.weight': 30, 'c.weight': 50, 'd.weight': 10}, limit=100)
        pool.preload()
        # In layer order, until one does not fit: the rest is streamed when its layer runs.
        self.assertEqual([key for _, key, _ in pool.gpu], ['a.weight', 'b.weight'])
        self.assertEqual(pool.bytes, 90)
        kept = pool.bundle(('model', 'a.weight', None))
        self.assertIs(pool.bundle(('model', 'a.weight', None)), kept)

    def test_a_layer_run_in_chunks_copies_its_weights_once(self):
        pool, ltx25 = self.pool({'fc1.weight': 200, 'fc2.weight': 100, 'next.weight': 150}, limit=0)
        with patch.object(ltx25, 'RECENT', 320):
            for _chunk in range(3):
                first = pool.bundle(('model', 'fc1.weight', None))
                second = pool.bundle(('model', 'fc2.weight', None))
            self.assertEqual(Tensor.copies, 2)
            self.assertIs(pool.bundle(('model', 'fc1.weight', None)), first)
            # The next layer takes their place: nothing accumulates on the GPU.
            pool.bundle(('model', 'next.weight', None))
            self.assertEqual(list(pool.recent), [('model', 'fc2.weight', None), ('model', 'next.weight', None)])
            self.assertEqual(pool.recent_bytes, 250)
            self.assertIsNot(pool.bundle(('model', 'fc1.weight', None)), first)
            del second
        self.assertEqual(pool.summary()['again_gib'], round(200 / 1024**3, 2))
        pool.clear()
        self.assertEqual((pool.recent, pool.recent_bytes, pool.gpu), ({}, 0, {}))


if __name__ == '__main__':
    unittest.main()
