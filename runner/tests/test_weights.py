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
        from runner.models import pool as module

        torch = SimpleNamespace(cuda=SimpleNamespace(synchronize=lambda: None))
        with patch.dict(sys.modules, torch=torch, comfy_kitchen=SimpleNamespace()):
            pool = module.WeightPool({'model': Store(sizes)}, limit / 1024**3)
        pool.order = [('model', key, None) for key in sizes]
        Tensor.copies = 0
        return pool, module

    def test_the_gpu_share_is_filled_before_the_model_runs(self):
        pool, _ = self.pool({'a.weight': 60, 'b.weight': 30, 'c.weight': 50, 'd.weight': 10}, limit=100)
        pool.preload()
        # In layer order, until one does not fit: the rest is streamed when its layer runs.
        self.assertEqual([key for _, key, _ in pool.gpu], ['a.weight', 'b.weight'])
        self.assertEqual(pool.bytes, 90)
        kept = pool.bundle(('model', 'a.weight', None))
        self.assertIs(pool.bundle(('model', 'a.weight', None)), kept)

    def test_a_layer_run_in_chunks_copies_its_weights_once(self):
        pool, module = self.pool({'fc1.weight': 200, 'fc2.weight': 100, 'next.weight': 150}, limit=0)
        with patch.object(module, 'RECENT', 320):
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


class StreamedShareTest(unittest.TestCase):
    def test_the_weights_that_will_not_stay_on_the_gpu_are_named_before_the_model_runs(self):
        sizes = {
            'a.weight': 60,
            'a.weight_scale': 5,
            'b.weight': 50,
            'b.bias': 5,
            'c.weight': 20,
            'd.weight': 40,
            'd.weight_scale': 5,
        }
        pool, _ = WeightPoolTest.pool(self, sizes, limit=100)
        pool.order = [('model', key, None) for key in sizes if key.endswith('.weight')]
        # In layer order each layer stays if it still fits: a (65) stays, b (55) does not, c (20)
        # does, d (45) does not. What does not stay is named with its scale and bias.
        self.assertEqual(pool.streamed(), {'model': {'b.weight', 'b.bias', 'd.weight', 'd.weight_scale'}})
        # What to lock with something to spare: every layer from the first that does not fit a
        # GPU share a little smaller. Whatever a share at least that large streams is in there:
        # with 100 it streams b and d, with 90 (c fits, d does not) too, with 80 the same.
        spare = pool.streamed(margin_gib=20 / 1024**3, onward=True)['model']
        self.assertEqual(spare, {'b.weight', 'b.bias', 'c.weight', 'd.weight', 'd.weight_scale'})
        for limit in (80, 90, 100, 120):
            other, _ = WeightPoolTest.pool(self, sizes, limit=limit)
            other.order = pool.order
            self.assertLessEqual(other.streamed().get('model', set()), spare, limit)
        # Nothing was copied to find out, and the model then fills the GPU the same way.
        self.assertEqual(Tensor.copies, 0)
        for location in pool.order:
            pool.bundle(location)
        self.assertEqual([key for _, key, _ in pool.gpu], ['a.weight', 'c.weight'])
        # With no room at all every layer is streamed; with room for all, none.
        pool, _ = WeightPoolTest.pool(self, sizes, limit=0)
        pool.order = [('model', key, None) for key in sizes if key.endswith('.weight')]
        self.assertEqual(pool.streamed(), {'model': set(sizes)})
        pool, _ = WeightPoolTest.pool(self, sizes, limit=1000)
        pool.order = [('model', key, None) for key in sizes if key.endswith('.weight')]
        self.assertEqual(pool.streamed(), {})


class MergedAdaptersTest(unittest.TestCase):
    def test_the_loras_of_a_layer_are_one_pair_of_matrices_that_stays_on_the_gpu(self):
        try:
            import torch
            import torch.nn.functional as F
        except ImportError:
            self.skipTest('torch is required')
        from runner.models import pool as module

        torch.manual_seed(0)
        # Three LoRAs of different ranks on one layer of 12 inputs and 8 outputs.
        ranks, strengths = (2, 4, 3), (1.0, 0.5, 1.4)
        tensors, adapters = {}, []
        for index, (rank, strength) in enumerate(zip(ranks, strengths)):
            key = f'lora{index}.layer'
            tensors[key + '.lora_A.weight'] = torch.randn(rank, 12)
            tensors[key + '.lora_B.weight'] = torch.randn(8, rank)
            adapters.append(('loras', key, strength))
        reads = []

        class Loras:
            def get_tensor(self, key):
                reads.append(key)
                return tensors[key]

        with patch.dict(sys.modules, comfy_kitchen=SimpleNamespace()):
            pool = module.WeightPool({'loras': Loras()}, 0)
        pool.device = 'cpu'
        location = ('model', 'layer.weight', None)
        down, up = pool.adapter(location, adapters, torch.float32)
        self.assertEqual((tuple(down.shape), tuple(up.shape)), ((9, 12), (8, 9)))
        # The same sum as each LoRA applied in turn with its strength.
        value = torch.randn(5, 12)
        expected = sum(
            F.linear(F.linear(value, tensors[key + '.lora_A.weight']), tensors[key + '.lora_B.weight']) * strength
            for _, key, strength in adapters
        )
        self.assertTrue(torch.allclose(F.linear(F.linear(value, down), up), expected, atol=1e-5))
        # Read once: the next step finds the pair where it is, and it counts in what the GPU holds.
        self.assertIs(pool.adapter(location, adapters, torch.float32)[0], down)
        self.assertEqual(len(reads), 6)
        self.assertEqual(pool.bytes, (9 * 12 + 8 * 9) * 4)
        self.assertEqual(pool.merged_bytes, pool.bytes)
        pool.torch = SimpleNamespace(cuda=SimpleNamespace(synchronize=lambda: None))
        pool.clear()
        self.assertEqual((pool.merged, pool.bytes, pool.merged_bytes), ({}, 0, 0))


class RoomTest(unittest.TestCase):
    def test_the_gpu_share_follows_what_the_card_has_free(self):
        from runner.models import pool as module

        def card(free_gib):
            return SimpleNamespace(cuda=SimpleNamespace(mem_get_info=lambda: (int(free_gib * 1024**3), 0)))

        # The same code on a 12, a 24 and an 8 GiB card: what is free, less what a step needs.
        with patch.dict(sys.modules, torch=card(10.74)):
            self.assertAlmostEqual(module.room(2.9), 7.84, places=2)
        with patch.dict(sys.modules, torch=card(22.5)):
            self.assertAlmostEqual(module.room(2.9), 19.6, places=2)
        # Nothing to keep there: every weight is then copied as its layer runs.
        with patch.dict(sys.modules, torch=card(2.0)):
            self.assertEqual(module.room(2.9), 0.0)

    def test_the_pool_is_still_found_where_the_families_import_it(self):
        from runner.models import ltx25
        from runner.models import pool as module

        self.assertIs(ltx25.WeightPool, module.WeightPool)
        self.assertIs(ltx25.load_streamed, module.load_streamed)


if __name__ == '__main__':
    unittest.main()
