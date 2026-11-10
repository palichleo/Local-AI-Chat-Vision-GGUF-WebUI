import dataclasses
import os
import tempfile
import unittest

from runner.models import conditioning


@dataclasses.dataclass
class Reference:
    image: object


class Image:
    """What the key reads of a PIL image."""

    def __init__(self, pixels, size=(2, 1), mode='RGB'):
        self.pixels, self.size, self.mode = pixels, size, mode

    def tobytes(self):
        return self.pixels

    def __eq__(self, other):
        return (self.pixels, self.size, self.mode) == (other.pixels, other.size, other.mode)


class ConditioningTest(unittest.TestCase):
    def test_a_key_follows_the_content_of_every_input(self):
        base = conditioning.key('ltx25', ['encoder', 10, 5], 'a boat')
        self.assertRegex(base, r'^[0-9a-f]{64}$')
        self.assertEqual(base, conditioning.key('ltx25', ['encoder', 10, 5], 'a boat'))
        for other in (
            conditioning.key('ltx25', ['encoder', 10, 6], 'a boat'),  # the encoder file changed
            conditioning.key('ltx25', ['encoder', 10, 5], 'a boat '),
            conditioning.key('minimax_h3', ['encoder', 10, 5], 'a boat'),
            conditioning.key('ltx25', ['encoder', 10], 5, 'a boat'),  # same values, other grouping
            conditioning.key('ltx25', ['encoder', 10, 5], 'a boat', None),
        ):
            self.assertNotEqual(base, other)
        # A request state: images count by their pixels, not by their identity.
        state = lambda pixels: dict(prompt='x', width=768, references=[Reference(Image(pixels))], image=None)
        self.assertEqual(conditioning.key(state(b'abcdef')), conditioning.key(state(b'abcdef')))
        self.assertNotEqual(conditioning.key(state(b'abcdef')), conditioning.key(state(b'abcdeg')))
        self.assertNotEqual(conditioning.key(1), conditioning.key(True))
        self.assertNotEqual(conditioning.key('1'), conditioning.key(1))
        # Something that cannot be read by content gives no key: that request is simply not kept.
        self.assertIsNone(conditioning.key(dict(prompt='x', other=object())))

    def test_stamp_changes_with_the_file_and_reads_a_folder(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, 'tokenizer.json')
            with open(path, 'w') as handle:
                handle.write('{}')
            first = conditioning.stamp(path)
            self.assertEqual(first, conditioning.stamp(path))
            with open(path, 'w') as handle:
                handle.write('{"a": 1}')
            os.utime(path, ns=(1, 1))
            self.assertNotEqual(first, conditioning.stamp(path))
            self.assertEqual(conditioning.stamp(folder), [['tokenizer.json', *conditioning.stamp(path)]])

    def test_only_what_a_stage_wrote_is_kept_and_only_when_it_can_be_given_back(self):
        image = Image(b'abcdef')
        before = dict(prompt='x', image=image, width=768)
        after = dict(prompt='x', image=Image(b'abcdef'), width=768, tokens=[1, 2, 3], note='ok')
        tensors, notes = conditioning.changes(before, after)
        self.assertEqual((tensors, notes['plain']), ({}, dict(tokens=[1, 2, 3], note='ok')))
        self.assertEqual(conditioning.restore({}, notes), dict(tokens=[1, 2, 3], note='ok'))
        self.assertIsNone(conditioning.changes(before, dict(after, model=object())))
        self.assertIsNone(conditioning.changes(before, dict(after, image=Image(b'zzzzzz'))))

    def test_entries_come_back_as_written_and_the_oldest_leave_when_the_folder_is_full(self):
        try:
            import torch
            import safetensors  # noqa: F401
        except ImportError:
            self.skipTest('torch and safetensors are required')
        with tempfile.TemporaryDirectory() as folder:
            config = dict(cacheRoot=folder)
            embeds = torch.randn(1, 4, 8).to(torch.bfloat16)
            self.assertIsNone(conditioning.load(config, 'a' * 64))
            self.assertTrue(conditioning.save(config, 'a' * 64, dict(embeds=embeds), dict(plain=dict(n=1), devices={})))
            tensors, notes = conditioning.load(config, 'a' * 64)
            self.assertTrue(torch.equal(tensors['embeds'], embeds))
            self.assertEqual(tensors['embeds'].dtype, torch.bfloat16)
            self.assertEqual(conditioning.restore(tensors, notes)['n'], 1)
            saved = conditioning.LIMIT
            conditioning.LIMIT = 100
            try:
                conditioning.save(config, 'b' * 64, dict(embeds=embeds))
            finally:
                conditioning.LIMIT = saved
            self.assertIsNone(conditioning.load(config, 'a' * 64))
            self.assertIsNotNone(conditioning.load(config, 'b' * 64))
            # A damaged entry is a miss, and it is removed.
            path = os.path.join(folder, 'conditioning', 'b' * 64 + '.safetensors')
            with open(path, 'wb') as handle:
                handle.write(b'broken')
            self.assertIsNone(conditioning.load(config, 'b' * 64))
            self.assertFalse(os.path.exists(path))
            self.assertIsNone(conditioning.load(config, None))
            self.assertFalse(conditioning.save(config, None, dict(embeds=embeds)))


if __name__ == '__main__':
    unittest.main()
