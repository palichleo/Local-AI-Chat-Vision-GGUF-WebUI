import json
import math
import tempfile
import unittest
from pathlib import Path

import torch

from runner.models import moss_image

CUDA = torch.cuda.is_available()
TINY = dict(dim=32, ffn_dim=24, heads=2, layers=3, text_dim=12, channels=8, fused=True)


def tiny(seed=0, **changes):
    """A small model with weights of its own everywhere (a norm left at 1 would hide a mistake)."""
    torch.manual_seed(seed)
    model = moss_image.MossImage(**{**TINY, **changes}).eval()
    with torch.no_grad():
        for parameter in model.parameters():
            parameter.copy_(torch.randn_like(parameter) * 0.2 + (1 if parameter.ndim == 1 else 0))
    return model


def reference(state, config, latents, sigma, context, skip=()):
    """The model as its published pipeline writes it (OpenMOSS/MOSS-Image, Apache-2.0), on a plain
    table of weights and one token at a time where the module works on whole tensors."""
    dim, heads = config['dim'], config['heads']
    head = dim // heads
    count = head // 8

    def linear(x, name):
        return x @ state[name + '.weight'].T + state.get(name + '.bias', 0)

    def norm(x, name):
        return x / (x.square().mean(-1, keepdim=True) + 1e-6).sqrt() * state[name + '.weight']

    def situ(hidden, gate):
        return 4 * torch.tanh(gate / 4) * torch.sigmoid(gate) * 25 * torch.tanh(hidden / 25)

    height, width = latents.shape[2:]
    tokens = context.shape[1]
    places = [(0, tokens, row - (height - 1) / 2, column - (width - 1) / 2) for row in range(height) for column in range(width)]
    places += [(0, index, 0, 0) for index in range(tokens)]

    def turned(x, where):
        """x [positions, heads, head]: channel i of the first half turns with channel i of the second."""
        out = torch.empty_like(x)
        for token, place in enumerate(where):
            for axis in range(4):
                for band in range(count):
                    angle = place[axis] / 10000 ** (band / count)
                    i = axis * count + band
                    a, b = x[token, :, i], x[token, :, i + head // 2]
                    out[token, :, i] = a * math.cos(angle) - b * math.sin(angle)
                    out[token, :, i + head // 2] = b * math.cos(angle) + a * math.sin(angle)
        return out

    def attention(q, k, v, stem, where):
        split = lambda rows: rows.reshape(len(where), heads, head)  # noqa: E731
        q, k, v = turned(norm(split(q), stem + '.q_norm'), where), turned(norm(split(k), stem + '.k_norm'), where), split(v)
        scores = torch.einsum('ihd,jhd->hij', q, k) / math.sqrt(head)
        return torch.einsum('hij,jhd->ihd', scores.softmax(-1), v).reshape(len(where), dim)

    half = 128
    angles = torch.tensor([sigma * 1000 / 10000 ** (index / half) for index in range(half)], dtype=torch.float64)
    time = torch.cat((angles.cos(), angles.sin())).float()
    time = linear(torch.nn.functional.silu(linear(time, 'time_embedding.0')), 'time_embedding.2')
    shift_a, scale_a, gate_a, shift_f, scale_f, gate_f = linear(time, 'shared_block_modulation').reshape(6, dim)
    head_shift, head_scale = linear(time, 'video_head_modulation').reshape(2, dim)

    text = linear(context[0], 'text_embedder.proj')
    for index in range(config.get('text_blocks', 2)):
        stem = f'text_embedder.blocks.{index}'
        q, k, v = linear(norm(text, stem + '.norm1'), stem + '.qkv').chunk(3, -1)
        text = text + linear(attention(q, k, v, stem, places[height * width :]), stem + '.proj')
        y = norm(text, stem + '.norm2')
        text = text + linear(situ(linear(y, stem + '.ffn_up'), linear(y, stem + '.ffn_gate')), stem + '.ffn_down')
    image = linear(latents[0].flatten(1).T, 'video_embedder')
    x = torch.cat((image, text))
    for index in range(config['layers']):
        if index in skip:
            continue
        stem = f'layers.{index}'
        y = norm(x, stem + '.norm1') * (1 + scale_a) + shift_a
        if config['fused']:
            q, k, v = linear(y, stem + '.proj.qkv').chunk(3, -1)
        else:
            q, k, v = (linear(y, stem + '.proj.' + name) for name in 'qkv')
        x = x + linear(attention(q, k, v, stem, places), stem + '.proj.o') * gate_a
        y = norm(x, stem + '.norm2') * (1 + scale_f) + shift_f
        hidden, gate = linear(y, stem + '.proj.ffn_up_gate').chunk(2, -1)
        x = x + linear(situ(hidden, gate), stem + '.proj.ffn_down') * gate_f
    x = norm(x[: height * width], 'final_norm_video') * (1 + head_scale) + head_shift
    return linear(x, 'final_linear_video').T.reshape(1, -1, height, width)


def header_of(config, prefix='', wide=0):
    """The header of a file holding such a model: its keys and their shapes."""
    model = moss_image.MossImage(**config)
    header = {prefix + name: {'shape': list(value.shape)} for name, value in model.state_dict().items()}
    header[prefix + 'rope.bands'] = {'shape': [16]}
    if wide:
        header[prefix + 'video_embedder.weight']['shape'][1] += wide
    return header


REAL = dict(dim=256, ffn_dim=512, heads=2, layers=4, text_dim=96, channels=16, fused=True, text_blocks=2)


class MossImageModelTests(unittest.TestCase):
    def test_the_model_computes_what_its_published_pipeline_writes(self):
        for fused in (True, False):
            config = {**TINY, 'fused': fused}
            model = tiny(1, fused=fused)
            torch.manual_seed(2)
            latents, context = torch.randn(1, 8, 3, 4), torch.randn(1, 5, 12)
            with torch.no_grad():
                for sigma, skip in ((0.731, ()), (0.05, ()), (1.0, (1,)), (0.4, (0, 2))):
                    got = model(latents, sigma, context, skip=skip)
                    expected = reference(model.state_dict(), config, latents, sigma, context, skip)
                    self.assertEqual(tuple(got.shape), (1, 8, 3, 4))
                    self.assertLess((got - expected).abs().max().item(), 2e-4, (fused, sigma, skip))
                # (Each block counts: left out, the prediction is another one.)
                self.assertGreater((model(latents, 0.4, context) - model(latents, 0.4, context, skip=(1,))).abs().max(), 1e-3)

    def test_one_matrix_for_queries_keys_and_values_gives_what_three_do(self):
        apart = tiny(3, fused=False)
        state = apart.state_dict()
        for index in range(TINY['layers']):
            stem = f'layers.{index}.proj.'
            state[stem + 'qkv.weight'] = torch.cat([state.pop(stem + name + '.weight') for name in 'qkv'])
        together = moss_image.MossImage(**TINY).eval()
        together.load_state_dict(state)
        torch.manual_seed(4)
        latents, context = torch.randn(1, 8, 2, 5), torch.randn(1, 3, 12)
        with torch.no_grad():
            self.assertTrue(torch.allclose(together(latents, 0.6, context), apart(latents, 0.6, context), atol=1e-5))

    def test_the_text_is_read_at_its_own_length_and_the_picture_at_any_size(self):
        model = tiny(5)
        torch.manual_seed(6)
        with torch.no_grad():
            for (height, width), tokens in (((1, 1), 1), ((2, 7), 9), ((5, 3), 2)):
                latents, context = torch.randn(1, 8, height, width), torch.randn(1, tokens, 12)
                got = model(latents, 0.5, context)
                self.assertLess((got - reference(model.state_dict(), TINY, latents, 0.5, context)).abs().max().item(), 2e-4)
        # Its positions are kept for the next steps: the same tensors, a few sizes at most.
        first = model.turn(2, 7, 9, torch.zeros(1))
        self.assertIs(model.turn(2, 7, 9, torch.zeros(1)), first)
        for tokens in range(10, 16):
            model.turn(2, 7, tokens, torch.zeros(1))
        self.assertEqual(len(model.turns), 4)
        for wrong in (torch.randn(2, 8, 2, 2), torch.randn(1, 7, 2, 2), torch.randn(8, 2, 2)):
            with self.assertRaises(ValueError):
                model(wrong, 0.5, torch.randn(1, 3, 12))
        for wrong in (torch.randn(1, 0, 12), torch.randn(2, 3, 12), torch.randn(3, 12)):
            with self.assertRaises(ValueError):
                model(torch.randn(1, 8, 2, 2), 0.5, wrong)
        with self.assertRaises(ValueError):
            moss_image.MossImage(**{**TINY, 'dim': 36})  # heads 18 wide: not a multiple of 8

    def test_the_picture_sits_after_the_text_around_its_own_centre(self):
        places = moss_image.coordinates(2, 3, 4)
        self.assertEqual(
            places.tolist(),
            [
                [0, 4, -0.5, -1], [0, 4, -0.5, 0], [0, 4, -0.5, 1],
                [0, 4, 0.5, -1], [0, 4, 0.5, 0], [0, 4, 0.5, 1],
                [0, 0, 0, 0], [0, 1, 0, 0], [0, 2, 0, 0], [0, 3, 0, 0],
            ],
        )  # fmt: skip
        self.assertTrue(torch.allclose(moss_image.bands(128), 1 / 10000 ** (torch.arange(16) / 16)))
        cos, sin = moss_image.rotations(2, 3, 4, 16)
        self.assertEqual((tuple(cos.shape), tuple(sin.shape), cos.dtype), ((1, 10, 1, 16), (1, 10, 1, 16), torch.float32))
        # A head of 16: two frequencies an axis (1 and 1/100), the four axes in each half.
        row = torch.tensor([0, 0, 4, 0.04, -0.5, -0.005, -1, -0.01])
        self.assertTrue(torch.allclose(cos[0, 0, 0], torch.cat((row.cos(), row.cos())), atol=1e-6))
        self.assertTrue(torch.allclose(sin[0, 0, 0], torch.cat((row.sin(), row.sin())), atol=1e-6))
        # Turning by a position, then by its opposite, gives the rows back.
        x = torch.randn(1, 10, 3, 16)
        self.assertTrue(torch.allclose(moss_image.rotate(moss_image.rotate(x, (cos, sin)), (cos, -sin)), x, atol=1e-5))

    def test_a_step_is_told_by_the_cosines_then_the_sines_of_its_sigma_in_thousandths(self):
        features = moss_image.time_features(0.5, 'cpu')
        self.assertEqual((tuple(features.shape), features.dtype), ((1, 256), torch.float32))
        self.assertAlmostEqual(features[0, 0].item(), math.cos(500), places=5)
        self.assertAlmostEqual(features[0, 128].item(), math.sin(500), places=5)
        self.assertAlmostEqual(features[0, 1].item(), math.cos(500 / 10000 ** (1 / 128)), places=5)
        self.assertAlmostEqual(features[0, 255].item(), math.sin(500 / 10000 ** (127 / 128)), places=5)
        still = moss_image.time_features(torch.tensor(0.0), 'cpu')
        self.assertEqual((still[0, :128].tolist(), still[0, 128:].tolist()), ([1.0] * 128, [0.0] * 128))

    def test_the_sigmas_are_those_of_the_models_own_scheduler(self):
        got = moss_image.sigmas(50)
        self.assertEqual((len(got), got[0], got[-1]), (51, 1.0, 0.0))
        self.assertTrue(all(before > after for before, after in zip(got, got[1:])))
        # Each is one of the thousand sigmas of the training.
        self.assertTrue(all(abs(value * 1000 - round(value * 1000)) < 1e-9 for value in got))
        self.assertEqual((got[1], got[25], got[49]), (0.996, 0.829, 0.024))
        # Not brought to them, they are ComfyUI's « normal » schedule for a flow moved by 5.
        loose = moss_image.sigmas(50, snap=False)
        point = 1 - 25 * (1 - 5 / 1004) / 49
        self.assertAlmostEqual(loose[25], 5 * point / (1 + 4 * point), places=12)
        self.assertAlmostEqual(loose[49], 5 / 1004 * 5 / (1 + 4 * 5 / 1004), places=12)
        self.assertTrue(all(abs(a - b) <= 0.0005 + 1e-12 for a, b in zip(got, loose)))
        # Another move, one step, more steps than the training has: two on the same sigma count once.
        self.assertEqual(moss_image.sigmas(3, shift=1), [1.0, 0.5, 0.001, 0.0])
        self.assertEqual(moss_image.sigmas(1), [1.0, 0.0])
        # (Below the last sigma of the training, the last one: never a step at 0 before the end.)
        self.assertEqual(moss_image.sigmas(2, shift=0.3), [1.0, 0.001, 0.0])
        many = moss_image.sigmas(3000)
        self.assertLess(len(many), 3001)
        self.assertTrue(all(before > after for before, after in zip(many, many[1:])))
        self.assertEqual(len(moss_image.sigmas(3000, snap=False)), 3001)
        for steps, shift in ((0, 5), (5, 0), (5, -1)):
            with self.assertRaises(ValueError):
                moss_image.sigmas(steps, shift)
        self.assertEqual((moss_image.SHIFT, moss_image.SKIPPED), (5.0, (22,)))

    def test_the_negative_prediction_skips_its_blocks_for_the_first_part_of_the_steps(self):
        self.assertEqual([moss_image.skipping(index, 50, 0.5) for index in (0, 24, 25, 49)], [True, True, False, False])
        self.assertEqual([moss_image.skipping(index, 4, 1) for index in range(4)], [True] * 4)
        self.assertEqual([moss_image.skipping(index, 4, 0) for index in range(4)], [False] * 4)

    def test_the_activation_is_a_gate_on_rows_both_held_in_bounds(self):
        hidden, gate = torch.tensor([0.5, -3.0, 1000.0, 2.0]), torch.tensor([1.0, 2.0, 0.5, -1000.0])
        got = moss_image.situ(hidden, gate)
        self.assertAlmostEqual(got[0].item(), 4 * math.tanh(0.25) / (1 + math.exp(-1)) * 25 * math.tanh(0.02), places=5)
        self.assertAlmostEqual(got[1].item(), 4 * math.tanh(0.5) / (1 + math.exp(-2)) * 25 * math.tanh(-0.12), places=5)
        self.assertAlmostEqual(got[2].item(), 4 * math.tanh(0.125) / (1 + math.exp(-0.5)) * 25, places=4)
        self.assertEqual(got[3].item(), 0)


class FusedKernelTests(unittest.TestCase):
    """What the blocks hand comfy-kitchen's kernels on a card, checked here without one."""

    def test_the_rotations_as_matrices_turn_the_rows_as_cosines_and_sines_do(self):
        cos, sin = moss_image.rotations(2, 3, 4, 16)
        table = moss_image.matrices(cos, sin)
        self.assertEqual((tuple(table.shape), table.dtype), ((1, 10, 1, 8, 2, 2), torch.float32))
        torch.manual_seed(0)
        x = torch.randn(1, 10, 3, 16)
        # The product the kernel documents: a pair is channel i of each half of a head.
        pairs = x.reshape(1, 10, 3, 2, 8).movedim(-2, -1).unsqueeze(-2)
        turned = (table[..., 0] * pairs[..., 0] + table[..., 1] * pairs[..., 1]).movedim(-1, -2).reshape(x.shape)
        self.assertTrue(torch.allclose(turned, moss_image.rotate(x, (cos, sin)), atol=1e-6))
        # The model keeps the three for a size: cosines and sines in its precision, the matrices in float32.
        kept = tiny(1).turn(2, 3, 4, torch.zeros(1, dtype=torch.float64))
        self.assertEqual([part.dtype for part in kept], [torch.float64, torch.float64, torch.float32])
        self.assertTrue(torch.equal(kept[2], moss_image.matrices(*moss_image.rotations(2, 3, 4, 16))))

    def test_a_norm_and_its_modulation_go_to_the_kernel_with_the_weight_folded_in_the_scale(self):
        torch.manual_seed(1)
        norm = moss_image.Norm(6)
        with torch.no_grad():
            norm.weight.copy_(torch.rand(6) + 0.5)
        x, scale, shift = torch.randn(1, 4, 6), torch.randn(1, 1, 6), torch.randn(1, 1, 6)
        plain = moss_image.modulated(norm, x, scale, shift)
        self.assertTrue(torch.allclose(plain, norm(x) * (1 + scale) + shift))

        class Kitchen:
            def rms_adaln(self, rows, folded, moved, eps):
                # What the kernel computes: rmsnorm(rows) * (1 + folded) + moved.
                self.eps = eps
                return rows * torch.rsqrt(rows.square().mean(-1, keepdim=True) + eps) * (1 + folded) + moved

        kitchen = Kitchen()
        self.assertTrue(torch.allclose(moss_image.modulated(norm, x, scale, shift, kitchen), plain, atol=1e-5))
        self.assertEqual(kitchen.eps, 1e-6)

    def test_a_branch_ends_in_its_product_for_a_layer_of_the_pool_and_in_steps_for_a_plain_one(self):
        torch.manual_seed(2)
        layer = torch.nn.Linear(5, 3, bias=False)
        x, gate = torch.randn(1, 4, 3), torch.randn(1, 1, 3)
        rows = torch.randn(1, 4, 5)
        self.assertTrue(torch.allclose(moss_image.branch(layer, rows, x, gate), x + layer(rows) * gate))
        wide = torch.randn(1, 4, 10) * 20
        hidden, opening = wide.chunk(2, -1)
        expected = x + layer(moss_image.situ(hidden, opening)) * gate
        self.assertTrue(torch.allclose(moss_image.branch(layer, wide, x, gate, act='situ'), expected))

        class Pooled:
            def __call__(self, value, act=None, residual=None, gate=None):
                self.asked = (value, act, residual, gate)
                return 'summed in the kernel'

        pooled = Pooled()
        self.assertEqual(moss_image.branch(pooled, wide, x, gate, act='situ'), 'summed in the kernel')
        self.assertIs(pooled.asked[0], wide)
        self.assertEqual((pooled.asked[1], pooled.asked[2] is x, tuple(pooled.asked[3].shape)), ('situ', True, (3,)))
        self.assertEqual(moss_image.branch(pooled, rows, x, gate), 'summed in the kernel')
        self.assertIsNone(pooled.asked[1])

    def test_the_attention_is_the_one_the_file_asks_for_and_dense_without_a_card(self):
        self.assertEqual(moss_image.attention(b'{"attention":"comfy_kitchen_int8"}'), 'int8')
        self.assertEqual(moss_image.attention(bytearray(b'{"attention": "comfy_kitchen_int8"}')), 'int8')
        for note in (b'{"attention":"pytorch"}', b'{}', b'[1]', b'not json', b''):
            self.assertEqual(moss_image.attention(note), 'dense', note)

        class Store:
            def get_tensor(self, key):
                self.asked = key
                return torch.frombuffer(bytearray(b'{"attention":"comfy_kitchen_int8"}'), dtype=torch.uint8)

        store = Store()
        header = {'p.layers.0.comfy_attention.config': {'shape': [35]}}
        self.assertEqual(moss_image.file_attention(header, 'p.', store), 'int8')
        self.assertEqual(store.asked, 'p.layers.0.comfy_attention.config')
        # (The published weights carry no note: nothing is read.)
        self.assertEqual(moss_image.file_attention({}, 'p.', None), 'dense')
        self.assertEqual(moss_image.file_attention(header, '', None), 'dense')
        self.assertEqual((tiny(0).attention, tiny(0, attention='int8').attention), ('dense', 'int8'))
        self.assertNotIn('attention', moss_image.config(header_of(REAL))[0])
        with self.assertRaises(ValueError):
            moss_image.MossImage(**{**TINY, 'attention': 'sparse'})
        # On the processor the blocks are computed as written, whatever the file asks for.
        self.assertIsNone(moss_image.kernels(torch.zeros(1)))
        model, asked = tiny(3), tiny(3, attention='int8')
        latents, context = torch.randn(1, 8, 2, 2), torch.randn(1, 3, 12)
        with torch.no_grad():
            self.assertTrue(torch.equal(model(latents, 0.5, context), asked(latents, 0.5, context)))

    def test_on_a_card_every_block_goes_through_the_kernels_and_gives_what_the_written_blocks_give(self):
        from unittest.mock import patch

        class Kitchen:
            """The kernels as their documentation writes them, counted."""

            def __init__(self, available):
                self.available, self.calls = available, dict(norms=0, turns=0, attentions=0)

            def rms_adaln(self, rows, folded, moved, eps):
                self.calls['norms'] += 1
                return rows * torch.rsqrt(rows.square().mean(-1, keepdim=True) + eps) * (1 + folded) + moved

            def rms_rope_split_half(self, q, k, table, q_scale, k_scale, eps):
                self.calls['turns'] += 1

                def one(rows, scale):
                    rows = rows * torch.rsqrt(rows.square().mean(-1, keepdim=True) + eps) * scale
                    half = rows.shape[-1] // 2
                    pairs = rows.reshape(*rows.shape[:-1], 2, half).movedim(-2, -1).unsqueeze(-2)
                    turned = table[..., 0] * pairs[..., 0] + table[..., 1] * pairs[..., 1]
                    return turned.movedim(-1, -2).reshape(rows.shape)

                return one(q, q_scale), one(k, k_scale)

            def int8_attention_is_available(self):
                return self.available

            def int8_attention(self, q, k, v):
                self.calls['attentions'] += 1
                return torch.nn.functional.scaled_dot_product_attention(q, k, v)

        torch.manual_seed(9)
        latents, context = torch.randn(1, 8, 3, 2), torch.randn(1, 4, 12)
        for asked, available, attentions in (('dense', True, 0), ('int8', True, 3), ('int8', False, 0)):
            written = tiny(4, attention=asked)
            kitchen = Kitchen(available)
            with torch.no_grad():
                expected = written(latents, 0.6, context)
                with patch.object(moss_image, 'kernels', lambda tensor: kitchen):
                    got = written(latents, 0.6, context)
                    skipped = written(latents, 0.6, context, skip=(1,))
            self.assertLess((got - expected).abs().max().item(), 2e-4, asked)
            self.assertGreater((skipped - expected).abs().max().item(), 1e-3)
            # Two norms a block and the one of the head; a turn a block, text blocks included; the
            # attention of the file in the blocks of the stream only, where the card has it.
            self.assertEqual(
                kitchen.calls,
                dict(norms=(2 * 3 + 1) + (2 * 2 + 1), turns=(3 + 2) + (2 + 2), attentions=attentions and attentions + 2),
                (asked, available),
            )


class MossImageFileTests(unittest.TestCase):
    def test_a_file_says_its_model_by_its_shapes(self):
        full = dict(dim=3072, ffn_dim=8192, heads=24, layers=42, text_dim=4096, channels=128, fused=True, text_blocks=2)
        # The file published for ComfyUI: 42 blocks 3072 wide, one matrix for queries, keys and values.
        header = {
            'shared_block_modulation.weight': {'shape': [18432, 3072]},
            'video_embedder.weight': {'shape': [3072, 128]},
            'final_linear_video.weight': {'shape': [128, 3072]},
            'text_embedder.proj.weight': {'shape': [3072, 4096]},
            **{f'text_embedder.blocks.{index}.norm1.weight': {'shape': [3072]} for index in range(2)},
            **{f'layers.{index}.norm1.weight': {'shape': [3072]} for index in range(42)},
            'layers.0.proj.qkv.weight': {'shape': [9216, 3072]},
            'layers.0.proj.ffn_up_gate.weight': {'shape': [16384, 3072]},
            'layers.0.proj.ffn_down.weight': {'shape': [3072, 8192]},
            'rope.bands': {'shape': [16]},
        }
        self.assertEqual(moss_image.config(header), (full, ''))
        # The published weights keep the three apart; a file may carry a prefix.
        for prefix in ('', 'model.diffusion_model.', 'diffusion_model.'):
            for fused in (True, False):
                config = {**REAL, 'fused': fused}
                self.assertEqual(moss_image.config(header_of(config, prefix)), (config, prefix))
        self.assertEqual(moss_image.config(header_of({**REAL, 'text_blocks': 3}))[0]['text_blocks'], 3)

    def test_a_file_that_is_not_this_model_is_refused_in_the_users_words(self):
        header = header_of(REAL)
        for missing in ('shared_block_modulation.weight', 'layers.0.proj.ffn_up_gate.weight'):
            with self.assertRaisesRegex(ValueError, 'n’est pas un modèle MOSS Image'):
                moss_image.config({key: value for key, value in header.items() if key != missing})
        for missing in ('final_linear_video.weight', 'text_embedder.proj.weight', 'video_embedder.weight', 'layers.0.proj.ffn_down.weight'):
            with self.assertRaisesRegex(ValueError, 'incomplet : ' + missing.replace('.', r'\.') + ' manque'):
                moss_image.config({key: value for key, value in header.items() if key != missing})
        # An adapter of control widens the entry of the model.
        with self.assertRaisesRegex(ValueError, 'cartes de contrôle'):
            moss_image.config(header_of(REAL, wide=32))
        for key, shape in (
            ('shared_block_modulation.weight', [1536, 250]),
            ('shared_block_modulation.weight', [1535, 256]),
            ('layers.0.proj.ffn_up_gate.weight', [1000, 256]),
            ('layers.0.proj.ffn_up_gate.weight', [1024, 128]),
        ):
            with self.assertRaisesRegex(ValueError, 'forme inattendue'):
                moss_image.config({**header, key: {'shape': shape}})
        # A width that is not a whole count of heads of 128 (every other shape agreeing with it).
        with self.assertRaisesRegex(ValueError, 'forme inattendue'):
            moss_image.config(header_of({**REAL, 'dim': 192}))
        with self.assertRaisesRegex(ValueError, 'numbered'):
            moss_image.config({key: value for key, value in header.items() if not key.startswith('layers.1.')})

    def test_each_weight_is_found_by_the_name_of_its_layer(self):
        for prefix in ('', 'model.diffusion_model.'):
            header = header_of(REAL, prefix)
            config, found = moss_image.config(header)
            model = moss_image.MossImage(**config)
            names = moss_image.names(model, header, found)
            self.assertEqual(set(names), {name for name, _ in model.named_parameters()})
            self.assertEqual(names['layers.3.proj.qkv.weight'], ('model', prefix + 'layers.3.proj.qkv.weight', None))
            self.assertEqual(names['text_embedder.blocks.1.ffn_up.bias'], ('model', prefix + 'text_embedder.blocks.1.ffn_up.bias', None))
            self.assertNotIn('rope.bands', names)  # frequencies the model computes: the file's copy is not read
            del header[prefix + 'layers.2.k_norm.weight']
            with self.assertRaisesRegex(ValueError, r'incomplet : layers\.2\.k_norm\.weight manque'):
                moss_image.names(model, header, found)


@unittest.skipUnless(CUDA, 'the weights of a file are read on the GPU')
class MossImageWeightsTests(unittest.TestCase):
    def file(self, model, folder, int8):
        """The model in a file as ComfyUI's are: small weights in BF16; with `int8`, the matrices
        of the blocks as rotated 8-bit integers with a scale a row and their note. Returns the
        path and the weights such a file really holds (rounded as the file rounds them)."""
        from safetensors.torch import save_file

        from runner import convert

        held, kept = {}, {}
        for name, value in model.state_dict().items():
            if int8 and name.startswith('layers.') and '.proj.' in name:
                weight, scale = convert.quantise(convert.rotate(value))
                stem = name.removesuffix('.weight')
                held[name], held[stem + '.weight_scale'] = weight, scale
                held[stem + '.comfy_quant'] = torch.frombuffer(bytearray(convert.NOTE), dtype=torch.uint8)
                kept[name] = convert.rotate(weight.float() * scale)
            else:
                held[name] = value.to(torch.bfloat16)
                kept[name] = held[name].float()
        held['rope.bands'] = moss_image.bands(128)
        path = str(Path(folder) / 'moss.safetensors')
        save_file(held, path)
        return path, kept

    def test_the_model_runs_from_its_file_through_the_pool_as_plain_weights_do(self):
        from accelerate import init_empty_weights

        from runner.models.headers import header
        from runner.models.pool import WeightPool, load_streamed
        from runner.models.residency import open_store

        torch.manual_seed(7)
        latents, context = torch.randn(1, 16, 6, 5), torch.randn(1, 11, 96)
        # Measured on three draws: 1 % from BF16 weights, 1.2 to 2 % from INT8 ones (the rows are
        # rounded to 8 bits too); a block left out or not by mistake is 34 to 69 % away.
        for int8, bound in ((False, 0.03), (True, 0.05)):
            plain = moss_image.MossImage(**REAL).eval()
            with torch.no_grad():
                for parameter in plain.parameters():
                    parameter.copy_(torch.randn_like(parameter) * 0.05 + (1 if parameter.ndim == 1 else 0))
            with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as folder:
                path, kept = self.file(plain, folder, int8)
                plain.load_state_dict(kept)
                config, prefix = moss_image.config(header(path))
                self.assertEqual(config, REAL)
                with open_store(path, resident=False) as store:
                    # With the dense attention, then with the one on 8-bit integers a file may ask for.
                    seen = {}
                    for attention, slack in (('dense', 0), ('int8', 0.03)):
                        pool = WeightPool({'model': store}, limit_gib=1)
                        try:
                            with init_empty_weights():
                                model = moss_image.MossImage(**config, attention=attention)
                            model = load_streamed(model, moss_image.names(model, header(path), prefix), pool)
                            with torch.inference_mode():
                                for sigma, skip in ((0.9, ()), (0.3, (2,))):
                                    got = model(latents.cuda(), sigma, context.cuda(), skip=skip).float().cpu()
                                    expected = plain(latents, sigma, context, skip=skip)
                                    error = ((got - expected).norm() / expected.norm()).item()
                                    self.assertLess(error, bound + slack, (int8, attention, sigma, skip))
                                    seen.setdefault(attention, got)
                                    self.assertEqual(got.dtype, torch.float32)
                        finally:
                            pool.clear()
                            del model
                    # (The attention asked for is the one that ran: rounded to 8 bits, it is not the dense one.)
                    self.assertGreater((seen['dense'] - seen['int8']).abs().max().item(), 0)

    def test_a_layer_of_the_pool_activates_the_halves_of_a_feed_forward_whatever_its_weights(self):
        from accelerate import init_empty_weights
        from safetensors.torch import save_file

        from runner import convert
        from runner.models.pool import WeightPool, load_streamed
        from runner.models.residency import open_store

        torch.manual_seed(8)
        weight = torch.randn(4, 256) * 0.05
        # Rows well past the bounds of the activation (25 for the hidden half, 4 for the gate).
        rows, stream, gate = torch.randn(1, 6, 512) * 30, torch.randn(1, 6, 4), torch.rand(4) + 0.5
        expected = stream + torch.nn.functional.linear(moss_image.situ(*rows.chunk(2, -1)), weight) * gate
        quantised, scale = convert.quantise(convert.rotate(weight))
        files = {
            'plain': {'a.weight': weight.to(torch.bfloat16)},
            'int8': {
                'a.weight': quantised,
                'a.weight_scale': scale,
                'a.comfy_quant': torch.frombuffer(bytearray(convert.NOTE), dtype=torch.uint8),
            },
        }
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as folder:
            for name, held in files.items():
                path = str(Path(folder) / (name + '.safetensors'))
                save_file(held, path)
                with open_store(path, resident=False) as store:
                    pool = WeightPool({'model': store}, limit_gib=1)
                    try:
                        with init_empty_weights():
                            model = torch.nn.ModuleDict({'a': torch.nn.Linear(256, 4, bias=False)})
                        model = load_streamed(model, {'a.weight': ('model', 'a.weight', None)}, pool)
                        with torch.inference_mode():
                            got = moss_image.branch(
                                model['a'], rows.cuda().to(torch.bfloat16), stream.cuda().to(torch.bfloat16),
                                gate.cuda().to(torch.bfloat16), act='situ',
                            )  # fmt: skip
                        error = ((got.float().cpu() - expected).norm() / expected.norm()).item()
                        self.assertLess(error, 0.05, name)
                    finally:
                        pool.clear()
                        del model


if __name__ == '__main__':
    unittest.main()
