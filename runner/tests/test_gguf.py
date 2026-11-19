import base64
import json
import struct
import tempfile
import unittest
from pathlib import Path

import torch

from runner.models import gguf

FIXTURE = json.loads((Path(__file__).parent / 'fixtures' / 'gguf-blocks.json').read_text(encoding='utf-8'))['blocks']


def _text(value):
    encoded = value.encode('utf-8')
    return struct.pack('<Q', len(encoded)) + encoded


def _file(tensors, metadata=()):
    """A GGUF file: `tensors` are (name, dimensions as GGUF lists them, type, bytes)."""
    head = gguf.MAGIC + struct.pack('<IQQ', 3, len(tensors), len(metadata))
    for key, kind, value in metadata:
        head += _text(key) + struct.pack('<I', kind) + value
    data = b''
    for name, sizes, kind, payload in tensors:
        head += _text(name) + struct.pack('<I', len(sizes)) + struct.pack(f'<{len(sizes)}Q', *sizes)
        head += struct.pack('<IQ', kind, len(data))
        data += payload + b'\0' * (-len(payload) % gguf.ALIGNMENT)
    return head + b'\0' * (-len(head) % gguf.ALIGNMENT) + data


class GgufTests(unittest.TestCase):
    def write(self, content):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        path = Path(folder.name) / 'model.gguf'
        path.write_bytes(content)
        return str(path)

    def test_every_quantisation_read_gives_the_values_of_the_reference(self):
        # Blocks quantised by gguf-py (the simple ones) or taken from a published file (the K ones),
        # and what gguf-py reads them as: the same values, to the last bit.
        self.assertEqual(sorted(FIXTURE), sorted(set(gguf.BLOCKS) - {'F32', 'F16', 'BF16'}))
        for kind, entry in FIXTURE.items():
            raw = torch.frombuffer(bytearray(base64.b64decode(entry['bytes'])), dtype=torch.uint8)
            self.assertEqual(len(raw), entry['shape'][0] * gguf.BLOCKS[kind][1], kind)
            got = gguf.dense(raw, kind, entry['shape'])
            self.assertEqual(list(got.shape), entry['shape'], kind)
            self.assertEqual(got.dtype, torch.float32, kind)
            expected = torch.tensor(entry['values'], dtype=torch.float32).reshape(entry['shape'])
            self.assertTrue(torch.equal(got, expected), kind)
            # Not zeros that would agree by accident.
            self.assertGreater(float(expected.abs().max()), 0.01, kind)

    def test_plain_tensors_are_read_as_they_are(self):
        values = torch.tensor([[1.5, -2.25, 0.125], [3.0, 0.0, -0.5]])
        for kind, stored in (('F32', values), ('F16', values.half()), ('BF16', values.to(torch.bfloat16))):
            raw = torch.frombuffer(bytearray(stored.contiguous().view(torch.uint8).numpy().tobytes()), dtype=torch.uint8)
            self.assertTrue(torch.equal(gguf.dense(raw, kind, [2, 3]), values), kind)
        self.assertEqual(list(gguf.dense(torch.empty(0, dtype=torch.uint8), 'F32', [0]).shape), [0])

    def test_a_file_is_listed_with_its_shapes_as_pytorch_orders_them(self):
        blocks = base64.b64decode(FIXTURE['Q8_0']['bytes'])
        bias = torch.tensor([0.5, -1.0]).numpy().tobytes()
        path = self.write(
            _file(
                # A matrix of 2 rows of 32: GGUF lists the 32 first.
                [('blocks.0.attn.to_q.weight', (32, 2), 8, blocks), ('blocks.0.attn.to_q.bias', (2,), 0, bias)],
                [
                    ('general.architecture', 8, _text('ltxv')),
                    ('general.alignment', 4, struct.pack('<I', 32)),
                    ('some.list', 9, struct.pack('<IQ', 4, 3) + struct.pack('<3I', 1, 2, 3)),
                ],
            )
        )
        self.assertTrue(gguf.is_gguf(path))
        tensors, metadata, start = gguf.header(path)
        self.assertEqual(metadata, {'general.architecture': 'ltxv', 'general.alignment': 32, 'some.list': [1, 2, 3]})
        self.assertEqual(start % 32, 0)
        self.assertEqual(tensors['blocks.0.attn.to_q.weight'], dict(dtype='Q8_0', shape=[2, 32], data_offsets=[0, 68]))
        self.assertEqual(tensors['blocks.0.attn.to_q.bias'], dict(dtype='F32', shape=[2], data_offsets=[96, 104]))
        self.assertEqual(gguf.unread(tensors), [])
        reader = gguf.Reader(path)
        self.addCleanup(reader.close)
        expected = torch.tensor(FIXTURE['Q8_0']['values']).reshape(2, 32)
        self.assertTrue(torch.equal(reader.get_tensor('blocks.0.attn.to_q.weight'), expected))
        self.assertTrue(torch.equal(reader.get_tensor('blocks.0.attn.to_q.bias'), torch.tensor([0.5, -1.0])))

    def test_a_quantisation_that_is_not_read_is_named_to_the_user(self):
        # Q3_K (type 11): 110 bytes for 256 values.
        path = self.write(_file([('blocks.0.weight', (256, 1), 11, b'\0' * 110), ('norm.weight', (1,), 0, b'\0' * 4)]))
        tensors, _, _ = gguf.header(path)
        self.assertEqual(tensors['blocks.0.weight']['shape'], [1, 256])
        self.assertEqual(gguf.unread(tensors), ['Q3_K'])
        said = gguf.refusal(gguf.unread(tensors))
        self.assertIn('Q3_K', said)
        self.assertIn('Q8_0', said)

    def test_another_file_is_not_taken_for_one(self):
        path = self.write(struct.pack('<Q', 2) + b'{}')
        self.assertFalse(gguf.is_gguf(path))
        with self.assertRaises(ValueError):
            gguf.header(path)
        self.assertFalse(gguf.is_gguf(path + '.missing'))


if __name__ == '__main__':
    unittest.main()
