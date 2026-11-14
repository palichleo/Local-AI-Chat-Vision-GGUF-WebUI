import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch


class Tensor:
    """What a WeightPool needs of a tensor, counting the copies to the GPU."""

    copies = 0
    pinned = True  # in page-locked RAM, as the weights a pool sends ahead normally are
    returned = []

    def __init__(self, size):
        self.size, self.ndim = size, 2

    def to(self, device, non_blocking=False):
        Tensor.copies += 1
        return Tensor(self.size)

    def copy_(self, source, non_blocking=False):
        Tensor.copies += 1
        return self

    def is_pinned(self):
        return Tensor.pinned

    def record_stream(self, stream):
        Tensor.returned.append(stream)

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

    def test_weights_read_from_the_disk_into_their_own_buffer_are_not_kept_in_ram(self):
        # A file used through its mapping costs nothing to keep a view of: a layer run again
        # finds it. One read from the disk tensor by tensor (Store.follow) would stay in RAM whole.
        sizes = {'a.weight': 60, 'b.weight': 30}
        pool, _ = self.pool(sizes, limit=0)
        pool.bundle(('model', 'a.weight', None))
        self.assertIn(('model', 'a.weight', None), pool.host)
        pool, _ = self.pool(sizes, limit=0)
        pool.stores['model'].reader = object()
        for key in sizes:
            pool.bundle(('model', key, None))
        self.assertEqual(pool.host, {})

    def test_the_gpu_share_is_filled_before_the_model_runs(self):
        pool, _ = self.pool({'a.weight': 60, 'b.weight': 30, 'c.weight': 50, 'd.weight': 10}, limit=100)
        pool.preload()
        # In layer order, until one does not fit: the rest is streamed when its layer runs.
        self.assertEqual([key for _, key, _ in pool.gpu], ['a.weight', 'b.weight'])
        self.assertEqual(pool.bytes, 90)
        kept = pool.bundle(('model', 'a.weight', None))
        self.assertIs(pool.bundle(('model', 'a.weight', None)), kept)

    def test_streamed_layers_are_copied_ahead_once_their_order_is_known(self):
        from runner.models import pool as module

        side = {'on': False, 'copies': 0, 'waits': []}

        class Event:
            def record(self, stream):
                self.stream = stream

        class Stream:
            def wait_event(self, event):
                side['waits'].append((self, event.stream))

        current = Stream()

        def set_stream(stream):
            # The copies ahead are launched on the pool's own stream, the model's kernels on its own.
            side['on'] = stream is not current

        cuda = SimpleNamespace(
            synchronize=lambda: None, Stream=Stream, Event=Event, set_stream=set_stream, current_stream=lambda: current
        )
        sizes = {'a.weight': 60, 'b.weight': 30, 'c.weight': 50, 'd.weight': 10}
        original = Tensor.copy_

        def copy_(tensor, source, non_blocking=False):
            side['copies'] += side['on']
            return original(tensor, source, non_blocking)

        torch = SimpleNamespace(cuda=cuda, empty_like=lambda value, device: Tensor(value.size))
        with patch.dict(sys.modules, torch=torch, comfy_kitchen=SimpleNamespace()):
            pool = module.WeightPool({'model': Store(sizes)}, 0, ahead_gib=100 / 1024**3)
        layers = [('model', key, None) for key in sizes]
        Tensor.copies = 0
        with patch.object(module, 'RECENT', 0), patch.object(Tensor, 'copy_', copy_):
            # The first step only learns the order: every layer is copied when it runs.
            for layer in layers:
                pool.bundle(layer)
            self.assertEqual((Tensor.copies, side['copies']), (4, 0))
            # From the second, the next layers are on their way, up to 100 bytes ahead.
            pool.bundle(layers[0])
            self.assertEqual(set(pool.ahead), set(layers[1:]))
            for layer in layers[1:]:
                pool.bundle(layer)
            self.assertEqual(round(pool.stats['ahead_gib'] * 1024**3), 90)
            # Each layer is copied once a step: b, c and d ahead, then a and b for the next step.
            self.assertEqual((Tensor.copies, side['copies']), (10, 5))
            self.assertEqual(set(pool.ahead), set(layers[:2]))
            self.assertEqual(pool.ahead_bytes, 90)
            # Each copy waits, on the pool's stream, for what the model was asked before it (the
            # memory it is copied to may have been a tensor of the model); each layer, on the
            # model's stream, for its copy.
            ahead = [of for waiting, of in side['waits'] if waiting is pool.stream]
            self.assertEqual((len(ahead), set(ahead)), (5, {current}))
            layer = [of for waiting, of in side['waits'] if waiting is current]
            self.assertEqual((len(layer), set(layer)), (3, {pool.stream}))
        pool.clear()
        self.assertEqual((pool.ahead, pool.ahead_bytes), ({}, 0))

    def ahead_pool(self, sizes, ahead):
        """A pool that copies ahead, on a fake GPU with two streams."""
        from runner.models import pool as module

        class Event:
            def record(self, _stream):
                pass

        class Stream:
            def wait_event(self, _event):
                pass

        current = Stream()
        cuda = SimpleNamespace(
            synchronize=lambda: None,
            Stream=Stream,
            Event=Event,
            set_stream=lambda _stream: None,
            current_stream=lambda: current,
        )
        torch = SimpleNamespace(cuda=cuda, empty_like=lambda value, device: Tensor(value.size))
        with patch.dict(sys.modules, torch=torch, comfy_kitchen=SimpleNamespace()):
            pool = module.WeightPool({'model': Store(sizes)}, 0, ahead_gib=ahead / 1024**3)
        Tensor.copies = 0
        return pool, module, [('model', key, None) for key in sizes if key.endswith('.weight')]

    def test_the_window_of_copies_ahead_moves_with_the_layers_without_being_walked_again(self):
        pool, module, layers = self.ahead_pool({f'{index}.weight': 30 for index in range(10)}, ahead=100)
        with patch.object(module, 'RECENT', 0):
            for layer in layers:
                pool.bundle(layer)
            walked = []
            whole = pool._send_window
            pool._send_window = lambda *args: (walked.append(args), whole(*args))[1]
            for _step in range(3):
                for index, layer in enumerate(layers):
                    pool.bundle(layer)
                    # Three layers of 30 bytes fit in 100: the three that follow, in their order.
                    self.assertEqual(list(pool.ahead), [layers[(index + ahead) % 10] for ahead in (1, 2, 3)])
                    self.assertEqual(pool.ahead_bytes, 90)
            # The whole window was looked at once, when the order became known.
            self.assertEqual(len(walked), 1)
            self.assertEqual(Tensor.copies, 10 + 30 + 3)
            # A layer the model skips: its copy goes away and the window starts over after the next.
            pool.bundle(layers[0])
            pool.bundle(layers[2])
            self.assertEqual(len(walked), 2)
            self.assertEqual(list(pool.ahead), layers[3:6])
            pool.bundle(layers[3])
            self.assertEqual((len(walked), list(pool.ahead)), (2, layers[4:7]))

    def test_a_weight_that_is_not_in_locked_ram_is_copied_ahead_on_memory_of_the_pools_stream(self):
        pool, module, layers = self.ahead_pool({f'{index}.weight': 30 for index in range(6)}, ahead=100)
        waits = []
        with patch.object(module, 'RECENT', 0), patch.object(Tensor, 'pinned', False), patch.object(
            Tensor, 'returned', []
        ):
            for layer in layers:
                pool.bundle(layer)
            pool.stream = pool.loose = SimpleNamespace(wait_event=waits.append)
            pool.bundle(layers[0])
            # Three layers sent: taken by `to` (no memory of the model's stream, no wait behind
            # the model), and their memory handed to the model's stream for when it is done.
            self.assertEqual(list(pool.ahead), layers[1:4])
            self.assertEqual(waits, [])
            self.assertEqual(Tensor.returned, [pool.current] * 3)
            self.assertEqual(Tensor.copies, 6 + 1 + 3)

    def test_a_scale_and_a_bias_stay_on_the_gpu_beside_a_weight_sent_at_every_step(self):
        sizes = {}
        for index in range(4):
            sizes.update({f'{index}.weight': 100_000, f'{index}.weight_scale': 4, f'{index}.bias': 64})
        pool, module, layers = self.ahead_pool(sizes, ahead=250_000)
        with patch.object(module, 'RECENT', 0):
            first = [pool.bundle(layer) for layer in layers]
            # Three tensors each the first time; from then on the weight alone.
            self.assertEqual(Tensor.copies, 12)
            self.assertEqual(set(pool.host[layers[0]]), {'weight'})
            second = [pool.bundle(layer) for layer in layers]
            self.assertEqual(Tensor.copies, 12 + 4 + 2)
            for before, after in zip(first, second):
                self.assertEqual(set(after), {'weight', 'scale', 'bias'})
                self.assertIs(after['scale'], before['scale'])
                self.assertIs(after['bias'], before['bias'])
                self.assertIsNot(after['weight'], before['weight'])
            # What a layer weighs is still all of it: the share kept on the GPU is counted as before.
            self.assertEqual(pool.sizes[layers[0]], 100_068)
        pool.clear()
        self.assertEqual((pool.small, pool.sizes), ({}, {}))
        # A pool that copies each layer when it runs keeps nothing there.
        plain, _ = self.pool(sizes, limit=0)
        plain.bundle(layers[0])
        self.assertEqual(plain.small, {})
        self.assertEqual(set(plain.host[layers[0]]), {'weight', 'scale', 'bias'})

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

    def test_a_store_that_knows_its_sizes_is_not_read_to_name_what_is_streamed(self):
        sizes = {'a.weight': 60, 'a.weight_scale': 5, 'b.weight': 50, 'b.bias': 5, 'qkv.weight': 90, 'qkv.bias': 9}

        class Sized(Store):
            """As runner.models.residency.Store: sizes from the header of the file."""

            asked = 0

            def measure(self, key):
                return self.sizes[key], 1

            def get_tensor(self, key):
                Sized.asked += 1
                return super().get_tensor(key)

        pool, _ = WeightPoolTest.pool(self, sizes, limit=70)
        pool.stores = {'model': Sized(sizes)}
        # One of the three parts of a fused matrix counts for a third of it, bias included.
        pool.order = [('model', 'a.weight', None), ('model', 'b.weight', None), ('model', 'qkv.weight', 1)]
        self.assertEqual(pool.sized(('model', 'qkv.weight', 1)), (33, ['qkv.weight', 'qkv.bias']))
        self.assertEqual(pool.streamed(), {'model': {'b.weight', 'b.bias', 'qkv.weight', 'qkv.bias'}})
        self.assertEqual(Sized.asked, 0, 'no tensor was mapped to find out')


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
            adapters.append(('loras', key + '.lora_A.weight', key + '.lora_B.weight', strength))
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
            F.linear(F.linear(value, tensors[down]), tensors[up]) * strength
            for _, down, up, strength in adapters
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

    def test_a_job_is_refused_only_when_its_own_tensors_do_not_fit_and_never_for_more_than_before(self):
        import math

        from runner.models import pool as module
        from runner.pipelines import krea2, ltx25, minimax_h3

        def card(free_gib):
            return SimpleNamespace(cuda=SimpleNamespace(mem_get_info=lambda: (int(free_gib * 1024**3), 0)))

        def asked(working, free_gib):
            with patch.dict(sys.modules, torch=card(free_gib)):
                try:
                    module.require('MiniMax H3', working, 'la taille ou la durée de la vidéo')
                except RuntimeError as error:
                    return str(error)
            return ''

        video = lambda width, height: minimax_h3.working_gib(  # noqa: E731
            math.prod(minimax_h3.grid_of(dict(frames=124, width=width, height=height))) + 512
        )
        draft, final = video(768, 448), video(1344, 768)
        # What a job asks for grows with it, whatever the files chosen: a draft on an 8 GiB card
        # (7 free), which the fixed 9 GiB refused; its final needs a larger one.
        self.assertLess(draft, 6.1)
        self.assertEqual(asked(draft, 7.0), '')
        self.assertIn('demande environ 8,0 Go de mémoire vidéo libre', asked(final, 7.0))
        self.assertIn('7,0 Go sont libres', asked(final, 7.0))
        self.assertIn('réduisez la taille ou la durée de la vidéo', asked(final, 7.0))
        # Never more than before: a job whose estimate passes 9 GiB still runs with 9 free.
        large = video(1920, 1088)
        self.assertGreater(large, module.FLOOR_GIB)
        self.assertEqual(asked(large, 9.0), '')
        self.assertIn('environ 9,0 Go', asked(large, 8.9))
        # An LTX video asks for what its steps need: its largest size on an 8 GiB card too.
        self.assertLess(ltx25.working_gib(dict(frames=121), 288, 512, 0), 3)
        self.assertEqual(asked(ltx25.working_gib(dict(frames=121), 896, 1600, 0), 7.0), '')
        # An image asks for little: its text encoder and its weights follow the card.
        image = krea2.RESERVE_GIB + krea2.RESERVE_PER_MEGAPIXEL_GIB * 1 + krea2.AHEAD_GIB
        self.assertEqual(asked(image, 3.5), '')
        self.assertIn('Go sont libres', asked(image, 3.0))
        # Subject references add their clips to an LTX video.
        clip = dict(frames=121)
        self.assertGreater(ltx25.working_gib(clip, 448, 800, 2), ltx25.working_gib(clip, 448, 800, 0))

    def test_no_pipeline_asks_for_a_fixed_amount_of_video_memory(self):
        import re
        from pathlib import Path

        from runner.pipelines import krea2

        for path in Path(krea2.__file__).parent.glob('*.py'):
            source = path.read_text(encoding='utf-8')
            fixed = re.search(r'mem_get_info\(\)\[0\]\s*<\s*\d|free\s*<\s*\d+\s*\*\s*1024', source)
            self.assertIsNone(fixed, path.name)

    def test_the_pool_is_still_found_where_the_families_import_it(self):
        from runner.models import ltx25
        from runner.models import pool as module

        self.assertIs(ltx25.WeightPool, module.WeightPool)
        self.assertIs(ltx25.load_streamed, module.load_streamed)


if __name__ == '__main__':
    unittest.main()
