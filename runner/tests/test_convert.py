import json
import struct
import tempfile
import unittest
from pathlib import Path

import torch
from safetensors import safe_open

from runner import convert
from runner.models import gguf
from runner.tests.test_gguf import _file as gguf_file

NAMES = {torch.float8_e4m3fn: 'F8_E4M3', torch.bfloat16: 'BF16', torch.float32: 'F32', torch.int8: 'I8'}


def _safetensors(path, tensors, metadata=None):
    """A safetensors file written by hand: 8-bit floats included."""
    header, data = {'__metadata__': metadata or {}}, b''
    for name, value in tensors.items():
        raw = value.contiguous().reshape(-1).view(torch.uint8).numpy().tobytes()
        offsets = [len(data), len(data) + len(raw)]
        header[name] = dict(dtype=NAMES[value.dtype], shape=list(value.shape), data_offsets=offsets)
        data += raw
    encoded = json.dumps(header).encode('utf-8')
    Path(path).write_bytes(struct.pack('<Q', len(encoded)) + encoded + data)


def _read(path):
    with open(path, 'rb') as handle:
        (length,) = struct.unpack('<Q', handle.read(8))
        header = json.loads(handle.read(length))
        data = handle.read()
    return header, {
        name: data[entry['data_offsets'][0] : entry['data_offsets'][1]]
        for name, entry in header.items()
        if name != '__metadata__'
    }


def _q8_0(values):
    """Values packed as GGUF's Q8_0: for each 32 of them, a 16-bit float scale and 32 integers."""
    blocks = values.reshape(-1, 32)
    scale = (blocks.abs().amax(dim=1, keepdim=True) / 127).half()
    integers = (blocks / scale.float()).round().clamp(-127, 127).to(torch.int8)
    packed = torch.cat([scale.view(torch.uint8).reshape(-1, 2), integers.view(torch.uint8)], dim=1)
    return packed.numpy().tobytes(), (integers.float() * scale.float()).reshape(values.shape)


class ConvertTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = Path(folder.name)
        torch.manual_seed(3)

    def test_the_rotation_keeps_lengths_and_undoes_itself(self):
        weight = torch.randn(6, 768)
        rotated = convert.rotate(weight)
        self.assertFalse(torch.allclose(rotated, weight, atol=1e-3))
        self.assertTrue(torch.allclose(rotated.norm(dim=1), weight.norm(dim=1), rtol=1e-5))
        self.assertTrue(torch.allclose(convert.rotate(rotated), weight, atol=1e-5))
        # A large weight alone in its row is spread over its group of 256, not the next one.
        spike = torch.zeros(1, 512)
        spike[0, 300] = 16.0
        spread = convert.rotate(spike)
        self.assertTrue(torch.equal(spread[0, :256], torch.zeros(256)))
        self.assertTrue(torch.allclose(spread[0, 256:].abs(), torch.ones(256)))
        with self.assertRaises(ValueError):
            convert.rotate(torch.zeros(2, 300))

    def test_rounding_keeps_every_weight_within_half_a_step_of_its_row(self):
        weight = torch.randn(5, 256) * torch.tensor([[0.01], [1.0], [30.0], [0.2], [5.0]])
        integers, scale = convert.quantise(weight)
        self.assertEqual((integers.dtype, scale.dtype, list(scale.shape)), (torch.int8, torch.float32, [5, 1]))
        self.assertTrue(torch.equal(integers.abs().amax(dim=1), torch.full((5,), 127, dtype=torch.int8)))
        self.assertTrue(bool(((integers.float() * scale - weight).abs() <= scale / 2 + 1e-6).all()))
        # A row of zeros is not divided by nothing.
        integers, scale = convert.quantise(torch.zeros(1, 256))
        self.assertTrue(torch.equal(integers, torch.zeros(1, 256, dtype=torch.int8)))

    def test_an_fp8_scaled_file_takes_the_layout_of_the_int8_files(self):
        source, target = self.folder / 'model-fp8_scaled.safetensors', self.folder / 'model-int8.safetensors'
        stored = (torch.randn(4, 512) * 40).to(torch.float8_e4m3fn)
        narrow = torch.randn(4, 100).to(torch.float8_e4m3fn)
        tensors = {
            'transformer_blocks.0.attn1.to_q.weight': stored,
            'transformer_blocks.0.attn1.to_q.weight_scale': torch.tensor([0.02]),
            'transformer_blocks.0.attn1.to_q.bias': torch.randn(4).to(torch.bfloat16),
            # Not a multiple of 256 wide: left as it is, with its scale.
            'audio_proj.weight': narrow,
            'audio_proj.weight_scale': torch.tensor([0.5]),
            'patchify_proj.weight': torch.randn(8, 6).to(torch.bfloat16),
        }
        _safetensors(source, tensors, {'model_version': '2.5.0', '_quantization_metadata': '{"layers": {}}'})
        said = []
        result = convert.convert(str(source), str(target), device='cpu', report=said.append)
        self.assertEqual((result['layers'], result['tensors']), (1, 7))
        self.assertLess(result['worst_error'], 0.02)
        self.assertIn('1 couches', said[0])
        header, data = _read(target)
        self.assertEqual(
            header['__metadata__'],
            {
                'model_version': '2.5.0',
                'converted_from': 'model-fp8_scaled.safetensors',
                'converted_to': 'int8 convrot 256',
            },
        )
        stem = 'transformer_blocks.0.attn1.to_q'
        self.assertEqual(header[stem + '.weight']['dtype'], 'I8')
        self.assertEqual(header[stem + '.weight']['shape'], [4, 512])
        scale = header[stem + '.weight_scale']
        self.assertEqual((scale['dtype'], scale['shape']), ('F32', [4, 1]))
        # The note the engine reads beside an INT8 layer, as the published files write it.
        note = b'{"format": "int8_tensorwise", "convrot": true, "convrot_groupsize": 256}'
        self.assertEqual(data[stem + '.comfy_quant'], note)
        # Everything else, to the byte.
        for name in (stem + '.bias', 'audio_proj.weight', 'audio_proj.weight_scale', 'patchify_proj.weight'):
            stored_bytes = tensors[name].contiguous().reshape(-1).view(torch.uint8).numpy().tobytes()
            self.assertEqual(data[name], stored_bytes, name)
            self.assertEqual(header[name]['shape'], list(tensors[name].shape))
        # The file is one safetensors reads, and its layer is the source's, rotated and rounded.
        with safe_open(str(target), framework='pt') as store:
            integers, scale = store.get_tensor(stem + '.weight'), store.get_tensor(stem + '.weight_scale')
        plain = stored.float() * 0.02
        back = convert.rotate(integers.float() * scale)
        self.assertLess(float((back - plain).norm() / plain.norm()), 0.02)
        self.assertFalse((self.folder / 'model-int8.safetensors.part').exists())
        # Never over a file that is there.
        with self.assertRaisesRegex(ValueError, 'existe déjà'):
            convert.convert(str(source), str(target), device='cpu', report=said.append)

    def test_a_gguf_file_is_converted_from_its_blocks(self):
        source, target = self.folder / 'model-Q8_0.gguf', self.folder / 'model-int8.safetensors'
        packed, plain = _q8_0(torch.randn(2, 256) * 0.3)
        small, small_plain = _q8_0(torch.randn(64))
        bias = torch.tensor([0.25, -4.0])
        source.write_bytes(
            gguf_file(
                [
                    ('transformer_blocks.0.attn1.to_q.weight', (256, 2), 8, packed),
                    ('transformer_blocks.0.attn1.to_q.bias', (2,), 0, bias.numpy().tobytes()),
                    # Quantised, and not a matrix a layer reads: written as 16-bit floats.
                    ('scale_shift_table', (64,), 8, small),
                ],
                [('general.architecture', 8, struct.pack('<Q', 4) + b'ltxv')],
            )
        )
        result = convert.convert(str(source), str(target), device='cpu', report=lambda _: None)
        self.assertEqual(result['layers'], 1)
        with safe_open(str(target), framework='pt') as store:
            self.assertEqual(store.metadata()['general.architecture'], 'ltxv')
            integers = store.get_tensor('transformer_blocks.0.attn1.to_q.weight')
            scale = store.get_tensor('transformer_blocks.0.attn1.to_q.weight_scale')
            self.assertEqual(integers.dtype, torch.int8)
            self.assertLess(float((convert.rotate(integers.float() * scale) - plain).norm() / plain.norm()), 0.02)
            self.assertTrue(torch.equal(store.get_tensor('transformer_blocks.0.attn1.to_q.bias'), bias))
            table = store.get_tensor('scale_shift_table')
            self.assertEqual(table.dtype, torch.bfloat16)
            self.assertTrue(torch.allclose(table.float(), small_plain, rtol=0.01, atol=1e-3))

    def test_what_cannot_be_converted_is_said_in_the_users_words(self):
        # A quantisation that is not read.
        source = self.folder / 'model-Q3_K_M.gguf'
        source.write_bytes(gguf_file([('blocks.0.weight', (256, 1), 11, b'\0' * 110)]))
        with self.assertRaisesRegex(ValueError, 'Q3_K'):
            convert.convert(str(source), str(self.folder / 'a.safetensors'), device='cpu', report=lambda _: None)
        # Nothing quantised in the file: there is nothing to gain.
        plain = self.folder / 'model-bf16.safetensors'
        _safetensors(plain, {'transformer_blocks.0.attn1.to_q.weight': torch.randn(2, 256).to(torch.bfloat16)})
        with self.assertRaisesRegex(ValueError, 'aucune couche'):
            convert.convert(str(plain), str(self.folder / 'b.safetensors'), device='cpu', report=lambda _: None)
        left = sorted(path.name for path in self.folder.iterdir())
        self.assertEqual(left, ['model-Q3_K_M.gguf', 'model-bf16.safetensors'])

    @unittest.skipUnless(torch.cuda.is_available(), 'The kernel is a CUDA one.')
    def test_the_kernel_computes_a_converted_layer_as_the_plain_one(self):
        # The proof that the rotation is the kernel's: with another Hadamard matrix the product
        # is noise (an error of 140 %, seen while writing this).
        import torch.nn.functional as F
        import comfy_kitchen
        from comfy_kitchen.backends import cuda as kitchen

        weight = torch.randn(512, 1024, device='cuda') * 0.02
        weight[:, ::97] *= 12
        rotated = convert.rotate(weight)
        theirs = kitchen.rotate_int8_convrot_weight(weight.contiguous(), 256)
        self.assertLess(float((rotated - theirs).abs().max()), 1e-5)
        integers, scale = convert.quantise(rotated)
        rows = torch.randn(256, 1024, device='cuda', dtype=torch.bfloat16)
        exact = F.linear(rows.float(), weight)
        code = comfy_kitchen.DTYPE_TO_CODE[rows.dtype]
        got = torch.ops.comfy_kitchen.int8_linear(rows, integers, scale, None, code, True, 256).float()
        self.assertLess(float((got - exact).norm() / exact.norm()), 0.03)


if __name__ == '__main__':
    unittest.main()
