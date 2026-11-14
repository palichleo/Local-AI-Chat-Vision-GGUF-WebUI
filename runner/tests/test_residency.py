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


class PartlyLockedArenaTest(unittest.TestCase):
    def test_an_arena_larger_than_the_share_allowed_is_locked_up_to_a_tensor_boundary(self):
        try:
            import torch
            import psutil
            from safetensors.torch import save_file
        except ImportError:
            self.skipTest('torch, psutil and safetensors are required')
        if not torch.cuda.is_available():
            self.skipTest('no GPU')
        from unittest.mock import patch

        from runner.models import residency

        megabyte = 1024**2
        size = 3 * megabyte + 7
        tensors = {f'layer{index}.weight': torch.randint(-127, 128, (size,), dtype=torch.int8) for index in range(4)}
        tensors['small.scale'] = torch.randn(5)
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, 'model.safetensors')
            save_file(tensors, path)
            # Room for two of the four layers: those asked for first are the ones locked.
            share = (2 * (3 * megabyte + 7) + 3 * residency.PAGE) / psutil.virtual_memory().total
            store = residency.open_store(path, resident=False)
            try:
                with patch.object(residency, 'PIN_SHARE', share):
                    store.keep(['layer2.weight', 'layer3.weight'], reserve=0, spare=['layer0.weight', 'layer1.weight'])
                arena = store.part
                self.assertGreater(arena.pinned, 2 * 3 * megabyte)
                self.assertLess(arena.pinned, arena.size)
                self.assertEqual(arena.pinned % residency.PAGE, 0)
                self.assertEqual(arena.data.data_ptr() % residency.PAGE, 0)
                locked = {key for key in arena.keys if arena.header[key]['data_offsets'][1] <= arena.pinned}
                self.assertEqual(locked, {'layer2.weight', 'layer3.weight'})
                # Every tensor, locked or not, copies to the GPU and reads back the same.
                for key, value in tensors.items():
                    copied = store.get_tensor(key).to('cuda', non_blocking=True)
                    torch.cuda.synchronize()
                    self.assertTrue(torch.equal(copied.cpu(), value), key)
            finally:
                store.close()
                residency.RESIDENCY.clear()


class PartialArenaTest(unittest.TestCase):
    def test_only_the_weights_asked_for_are_kept_in_ram_the_others_are_read_from_the_file(self):
        try:
            import torch
            import psutil  # noqa: F401
            from safetensors.torch import save_file
        except ImportError:
            self.skipTest('torch, psutil and safetensors are required')
        from runner.models import residency

        try:
            with tempfile.TemporaryDirectory() as folder:
                path = os.path.join(folder, 'model.safetensors')
                tensors = {
                    'first.weight': torch.arange(12, dtype=torch.int8).reshape(3, 4),
                    'odd': torch.tensor([1, 2, 3], dtype=torch.uint8),  # misaligns what follows
                    'second.weight': torch.randn(5, 7).to(torch.bfloat16),
                    'second.weight_scale': torch.randn(5, 1),
                    'third.weight': torch.randn(2, 2),
                }
                save_file(tensors, path)
                # The whole file is not kept (a model too large for that): it is read as mapped.
                store = residency.open_store(path, resident=False)
                self.assertIsNone(store.arena)
                asked = ['second.weight', 'second.weight_scale', 'third.weight', 'not in the file']
                kept = store.keep(asked, reserve=0)
                self.assertGreaterEqual(kept, 5 * 7 * 2 + 5 * 4 + 4 * 4)
                # At most a page of padding per tensor (each starts on a page of its own).
                self.assertLessEqual(kept, 5 * 7 * 2 + 5 * 4 + 4 * 4 + 3 * residency.PAGE)
                arena = store.part
                self.assertEqual(arena.keys, {'second.weight', 'second.weight_scale', 'third.weight'})
                # Every tensor reads the same wherever it comes from.
                for key, value in tensors.items():
                    read = store.get_tensor(key)
                    self.assertEqual((read.dtype, read.shape), (value.dtype, value.shape), key)
                    self.assertTrue(torch.equal(read.float(), value.float()), key)
                self.assertEqual(set(store.keys()), set(tensors))
                # The kept ones come from the arena, packed and aligned; the others from the file.
                held = arena.data.data_ptr()
                inside = lambda tensor: held <= tensor.data_ptr() < held + arena.size  # noqa: E731
                self.assertTrue(inside(store.get_tensor('second.weight')))
                self.assertFalse(inside(store.get_tensor('first.weight')))
                self.assertTrue(all(arena.header[key]["data_offsets"][0] % residency.PAGE == 0 for key in arena.keys))
                # Asked again for a part of what is held (the next video): the same arena.
                again = residency.open_store(path, resident=False)
                again.keep(['third.weight'], reserve=0)
                self.assertIs(again.part, arena)
                self.assertEqual(arena.users, 2)
                # Built with a little to spare, it serves a need that grows by that much.
                spared = residency.open_store(path, resident=False)
                spared.keep(['first.weight'], reserve=0, spare=['first.weight', 'second.weight'])
                wide = spared.part
                self.assertEqual(wide.keys, {'first.weight', 'second.weight'})
                spared.keep(['first.weight', 'second.weight'], reserve=0, spare=['third.weight'])
                self.assertIs(spared.part, wide)
                spared.close()
                # Asked for more (a larger video keeps less on the GPU): built again.
                again.keep(['first.weight', 'third.weight'], reserve=0)
                self.assertIsNot(again.part, arena)
                self.assertEqual(again.part.keys, {'first.weight', 'third.weight'})
                self.assertEqual(arena.users, 1)
                # The arena that was replaced is released when its last reader is done with it,
                # not left page-locked behind.
                self.assertIsNotNone(arena.data)
                store.close()
                self.assertIsNone(arena.data)
                self.assertFalse(arena.pinned)
                # A store kept from one video to the next, alone to read its part: asked for more,
                # that part is released before the new one looks for its room in RAM, not after.
                old, seen = again.part, []
                real = residency.RESIDENCY._make_room
                residency.RESIDENCY._make_room = lambda *args: seen.append(old.data is None) or real(*args)
                try:
                    again.keep(['first.weight', 'second.weight', 'third.weight'], reserve=0)
                finally:
                    del residency.RESIDENCY._make_room
                self.assertEqual(seen, [True])
                self.assertEqual(again.part.keys, {'first.weight', 'second.weight', 'third.weight'})
                self.assertEqual(again.part.users, 1)
                again.close()
                self.assertEqual(again.part, None)
                # A file that is resident whole needs no part of it kept again.
                saved = residency.RESERVE
                residency.RESERVE = 0
                try:
                    whole = residency.open_store(path)
                    self.assertIsNotNone(whole.arena)
                    self.assertEqual(whole.keep(['third.weight'], reserve=0), 0)
                    whole.close()
                finally:
                    residency.RESERVE = saved
        finally:
            residency.RESIDENCY.clear()


class EvictionTest(unittest.TestCase):
    """Memory short while a generation runs: the arenas it reads from stay, the others go."""

    def test_an_arena_a_store_reads_from_is_never_evicted(self):
        try:
            import psutil
        except ImportError:
            self.skipTest('psutil is required')
        from runner.models import residency

        released = []

        def arena(name, users):
            return SimpleNamespace(users=users, size=1, pinned=False, release=lambda: released.append(name))

        table = residency.Residency()
        table.arenas['vae'] = arena('vae', users=1)
        table.arenas['old'] = arena('old', users=0)
        table.arenas['audio'] = arena('audio', users=1)
        saved_reserve, saved_memory = residency.RESERVE, psutil.virtual_memory
        residency.RESERVE = 4
        # 10 units in all; 2 available, 2 more once the idle arena is gone.
        psutil.virtual_memory = lambda: SimpleNamespace(total=10, available=2 + 2 * ('old' in released))
        try:
            # A file that must not send another away (a text encoder beside its model) is not
            # loaded when it does not fit as things are, and nothing leaves; with a smaller
            # reserve of its own it fits without anyone leaving.
            self.assertFalse(table._make_room(3, evict=False))
            self.assertEqual(released, [])
            self.assertTrue(table._make_room(1, reserve=1, evict=False))
            self.assertEqual(released, [])
            # Even with the idle arena gone the file does not fit: it will be read from its mapping.
            self.assertFalse(table._make_room(3))
            self.assertEqual(released, ['old'])
            self.assertEqual(list(table.arenas), ['vae', 'audio'])
            # A store closes: its arena may go when room is needed again, the one still read stays.
            table.drop(table.arenas['vae'])
            self.assertFalse(table._make_room(3))
            self.assertEqual(released, ['old', 'vae'])
            self.assertEqual(list(table.arenas), ['audio'])
            # Unloading between generations leaves alone what is still being read.
            table.clear()
            self.assertEqual(released, ['old', 'vae'])
            self.assertEqual(len(table.arenas), 0)
        finally:
            residency.RESERVE, psutil.virtual_memory = saved_reserve, saved_memory


class RoomForTheChatModel(unittest.TestCase):
    def test_idle_arenas_leave_oldest_first_until_the_chat_model_has_its_room(self):
        try:
            import psutil
        except ImportError:
            self.skipTest('psutil is required')
        from runner.models import residency

        released, sizes = [], {'encoder': 5, 'vae': 1, 'model': 13}

        def arena(name, users):
            return SimpleNamespace(users=users, size=sizes[name], pinned=False, release=lambda: released.append(name))

        table = residency.Residency()
        # Least recently used first: the text encoder, then the model; the VAE is still read.
        table.arenas['encoder'] = arena('encoder', 0)
        table.arenas['vae'] = arena('vae', 1)
        table.arenas['model'] = arena('model', 0)
        saved = psutil.virtual_memory
        # 4 units available, and what each arena gives back once gone.
        psutil.virtual_memory = lambda: SimpleNamespace(total=32, available=4 + sum(sizes[name] for name in released))
        try:
            # Room enough already: nothing leaves.
            self.assertEqual(table.leave_room(4), 0)
            self.assertEqual(released, [])
            # 8 wanted: the encoder alone gives it.
            self.assertEqual(table.leave_room(8), 5)
            self.assertEqual(released, ['encoder'])
            self.assertEqual(list(table.arenas), ['vae', 'model'])
            # More than all of them give: the idle ones go, never the one still read.
            self.assertEqual(table.leave_room(100), 13)
            self.assertEqual(released, ['encoder', 'model'])
            self.assertEqual(list(table.arenas), ['vae'])
        finally:
            psutil.virtual_memory = saved

    def test_on_every_size_of_machine_only_what_the_chat_model_lacks_leaves(self):
        """Krea 2 keeps its files after two images (its encoder without sending anyone away, then
        its model, 4 GiB reserve each), then the chat model comes back and asks its room + 2 GiB.
        The system and the usual programs take 4 GiB + 15 % of the RAM."""
        try:
            import psutil
        except ImportError:
            self.skipTest('psutil is required')
        from runner.models import residency

        def after_images_then_chat(total, chat):
            used, held, table = 4 + 0.15 * total, {}, residency.Residency()

            def available():
                return (total - used - sum(held.values())) * GiB

            psutil.virtual_memory = lambda: SimpleNamespace(total=total * GiB, available=available())

            def admit(name, size, evict):
                if name in held:
                    table.arenas.move_to_end(name)
                elif table._make_room(size * GiB, 4 * GiB, evict):
                    held[name] = size
                    table.arenas[name] = SimpleNamespace(
                        users=0, size=size * GiB, pinned=False, release=lambda: held.pop(name)
                    )

            for _ in range(2):
                admit('encoder', 4.9, evict=False)
                admit('model', 13.5, evict=True)
            kept = sorted(held)
            table.leave_room(int((chat + 2) * GiB))
            return kept, sorted(held), available() / GiB

        GiB = 1024**3
        saved = psutil.virtual_memory
        try:
            # A big machine: both files stay, the chat model has its room beside them.
            kept, left, free = after_images_then_chat(64, 8.3)
            self.assertEqual((kept, left), (['encoder', 'model'], ['encoder', 'model']))
            self.assertGreaterEqual(free, 8.3 + 2)
            # A big chat model on 48 GiB: the encoder leaves, the model (used last) stays.
            kept, left, free = after_images_then_chat(48, 20)
            self.assertEqual((kept, left), (['encoder', 'model'], ['model']))
            self.assertGreaterEqual(free, 20 + 2)
            # 32 GiB and less room: everything idle leaves for the chat model.
            kept, left, free = after_images_then_chat(32, 8.3)
            self.assertEqual((kept, left), (['encoder', 'model'], []))
            # 16 GiB: the model never stayed; what can leave leaves, short of the room, no error.
            kept, left, free = after_images_then_chat(16, 8.3)
            self.assertEqual((kept, left), (['encoder'], []))
            self.assertLess(free, 8.3 + 2)
            # 8 GiB: nothing was kept, nothing to give.
            self.assertEqual(after_images_then_chat(8, 2.5)[:2], ([], []))
        finally:
            psutil.virtual_memory = saved


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


class MeasureTest(unittest.TestCase):
    def test_the_size_of_a_tensor_comes_from_the_header_of_the_file(self):
        from runner.models import residency

        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, 'weights.safetensors')
            _safetensors(path, {'a.weight': b'a' * 1000, 'a.weight_scale': b's' * 10})
            # Through its mapping, as a file too large to be kept in RAM.
            with residency.open_store(path, False) as store:
                self.assertEqual(store.measure('a.weight'), (1000, 1))
                self.assertEqual(store.measure('a.weight_scale'), (10, 1))
                with self.assertRaises(KeyError):
                    store.measure('absent')


class ReaderTest(unittest.TestCase):
    """A file read from the disk a little ahead of its use, where RAM has no room to keep it."""

    def setUp(self):
        try:
            import torch  # noqa: F401
        except ImportError:
            self.skipTest('torch is required')
        self.folder = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.folder.name, 'weights.safetensors')
        self.tensors = {name: bytes([index + 1]) * 1000 for index, name in enumerate('abcdef')}
        _safetensors(self.path, self.tensors)

    def tearDown(self):
        self.folder.cleanup()

    def test_tensors_come_ahead_of_their_use_in_the_order_given(self):
        from runner.models import residency

        reader = residency.Reader(self.path, list('abcdef'), ahead=2500)
        try:
            for name in 'abcdef':
                self.assertEqual(bytes(reader.take(name).numpy().tobytes()), self.tensors[name], name)
            # Never more than its window at once, and nothing was left for the caller to read.
            said = reader.summary()
            self.assertEqual(said['direct_gib'], 0)
            self.assertLessEqual(reader.held, 2500)
            self.assertIsNone(reader.take('absent'), 'a key it does not follow is left to the mapping')
        finally:
            reader.close()
        self.assertFalse(reader.thread.is_alive())

    def test_a_tensor_asked_for_out_of_turn_is_read_at_once_and_only_once(self):
        from runner.models import residency

        reader = residency.Reader(self.path, list('abcdef'), ahead=2500)
        try:
            # The last one first: the window fills with a and b, the caller reads f itself.
            self.assertEqual(bytes(reader.take('f').numpy().tobytes()), self.tensors['f'])
            for name in 'abcde':
                self.assertEqual(bytes(reader.take(name).numpy().tobytes()), self.tensors[name], name)
            # Asked for again (a layer run twice): read again, the same.
            self.assertEqual(bytes(reader.take('c').numpy().tobytes()), self.tensors['c'])
            reader.thread.join(timeout=5)
            self.assertNotIn('f', reader.ready)
        finally:
            reader.close()

    def test_a_store_follows_its_file_only_when_it_is_not_kept_in_ram(self):
        try:
            import psutil  # noqa: F401
        except ImportError:
            self.skipTest('psutil is required')
        from runner.models import residency

        with residency.open_store(self.path, False) as store:
            self.assertTrue(store.follow(list('abc')))
            self.assertFalse(store.follow(list('abc')), 'once')
            for name in 'abcdef':
                self.assertEqual(bytes(store.get_tensor(name).numpy().tobytes()), self.tensors[name], name)
            reader = store.reader
            self.assertGreater(reader.stats['ahead_gib'] + reader.stats['direct_gib'], 0)
        self.assertFalse(reader.thread.is_alive(), 'closed with its store')
        table = residency.Residency()
        saved = residency.RESIDENCY
        residency.RESIDENCY = table
        try:
            with residency.open_store(self.path, reserve=0) as store:
                if store.arena is not None:
                    self.assertFalse(store.follow(list('abc')), 'a file kept in RAM needs no reader')
                    self.assertIsNone(store.reader)
        finally:
            table.clear()
            residency.RESIDENCY = saved


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
            self.assertEqual(residency.weight_ranges(path, ['a.weight', 'b.weight'], gap=5000), [(base, base + 8030)])
            mapped = SimpleNamespace(arena=None)
            ahead = residency.prefetch(
                {'model': path}, {'model': mapped}, [('model', 'a.weight', None), ('model', 'b.weight', 1)]
            )
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
            self.assertEqual(
                [key for _role, key, _part in order], [f'blocks.{index}.fc.weight' for index in (0, 1, 2, 10)]
            )
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
                ahead = residency.prefetch(
                    {'model': path}, {'model': SimpleNamespace(arena=None)}, order, lead=lambda: 10**9
                )
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
