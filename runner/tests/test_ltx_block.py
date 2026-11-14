import unittest
from types import SimpleNamespace

import torch

from runner.models import ltx25_block
from runner.models.pool import load_streamed

CUDA = torch.cuda.is_available()


def relative(got, expected):
    return ((got.float() - expected.float()).norm() / expected.float().norm()).item()


@unittest.skipUnless(CUDA, 'the fused kernels run on the GPU')
class FusedBlockTests(unittest.TestCase):
    def block(self, rope_type='split'):
        from diffusers.models.transformers.transformer_ltx2 import LTX2VideoTransformerBlock

        torch.manual_seed(0)
        block = LTX2VideoTransformerBlock(
            dim=64,
            num_attention_heads=4,
            attention_head_dim=16,
            cross_attention_dim=64,
            audio_dim=32,
            audio_num_attention_heads=4,
            audio_attention_head_dim=8,
            audio_cross_attention_dim=32,
            video_gated_attn=True,
            video_cross_attn_adaln=True,
            audio_gated_attn=True,
            audio_cross_attn_adaln=True,
            qk_norm='rms_norm_across_heads',
            rope_type=rope_type,
        )
        return block.eval().to('cuda')

    def inputs(self, tokens=24, sound=10, text=6, timesteps=1):
        """One timestep for the sequence, or one per token (frames held by an image)."""
        value = lambda *shape: torch.randn(*shape, device='cuda')
        angles = lambda length, half: torch.rand(1, 4, length, half, device='cuda') * 6.28
        freqs = {
            'video_rotary_emb': angles(tokens, 8),
            'audio_rotary_emb': angles(sound, 4),
            'ca_video_rotary_emb': angles(tokens, 4),
            'ca_audio_rotary_emb': angles(sound, 4),
        }
        video_steps, sound_steps = (tokens, sound) if timesteps != 1 else (1, 1)
        named = dict(
            hidden_states=value(1, tokens, 64),
            audio_hidden_states=value(1, sound, 32),
            encoder_hidden_states=value(1, text, 64),
            audio_encoder_hidden_states=value(1, text, 32),
            temb=value(1, video_steps, 9 * 64),
            temb_audio=value(1, sound_steps, 9 * 32),
            temb_ca_scale_shift=value(1, video_steps, 4 * 64),
            temb_ca_audio_scale_shift=value(1, sound_steps, 4 * 32),
            temb_ca_gate=value(1, video_steps, 64),
            temb_ca_audio_gate=value(1, sound_steps, 32),
        )
        reference = dict(named, **{name: (angle.cos(), angle.sin()) for name, angle in freqs.items()})
        rotations = {}
        for name, angle in freqs.items():
            cos, sin = angle.cos().permute(0, 2, 1, 3), angle.sin().permute(0, 2, 1, 3)
            matrix = torch.stack((cos, -sin, sin, cos), dim=-1)
            rotations[name] = matrix.reshape(*matrix.shape[:-1], 2, 2)
        return reference, dict(named, **rotations)

    def test_the_fused_block_computes_what_diffusers_block_computes(self):
        block = self.block()
        for timesteps in (1, 'per token'):
            for a2v, v2a in ((True, True), (True, False), (False, True), (False, False)):
                with self.subTest(timesteps=timesteps, a2v=a2v, v2a=v2a), torch.no_grad():
                    reference, fused = self.inputs(timesteps=timesteps)
                    which = dict(use_a2v_cross_attention=a2v, use_v2a_cross_attention=v2a)
                    before = fused['hidden_states'].clone(), fused['audio_hidden_states'].clone()
                    expected = block(**reference, **which)
                    got = ltx25_block._block_forward(block, **fused, **which)
                    for mine, theirs in zip(got, expected):
                        self.assertLess(relative(mine, theirs), 1e-4)
                    # The streams that came in are the caller's: not written.
                    self.assertTrue(torch.equal(fused['hidden_states'], before[0]))
                    self.assertTrue(torch.equal(fused['audio_hidden_states'], before[1]))

    def test_a_long_feed_forward_runs_in_slices_with_the_same_result(self):
        block = self.block()
        with torch.no_grad():
            reference, fused = self.inputs(tokens=40)
            expected = block(**reference)
            original, ltx25_block.ROWS = ltx25_block.ROWS, 16
            try:
                got = ltx25_block._block_forward(block, **fused)
            finally:
                ltx25_block.ROWS = original
            for mine, theirs in zip(got, expected):
                self.assertLess(relative(mine, theirs), 1e-4)

    def test_a_long_attention_runs_through_the_faster_kernel_with_the_same_scores(self):
        torch.manual_seed(0)
        value = lambda tokens: torch.randn(1, tokens, 4, 64, device='cuda', dtype=torch.bfloat16)  # noqa: E731
        plain = lambda q, k, v, mask=None: torch.nn.functional.scaled_dot_product_attention(  # noqa: E731
            q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2), attn_mask=mask
        ).transpose(1, 2)
        for queries, keys in ((1200, 1200), (1200, 40), (40, 1200), (40, 40)):
            with self.subTest(queries=queries, keys=keys), torch.no_grad():
                q, k, v = value(queries), value(keys), value(keys)
                got = ltx25_block._attention(q, k, v)
                self.assertEqual(got.shape, q.shape)
                self.assertLess(relative(got, plain(q, k, v)), 5e-3)
        # A mask the faster kernel does not take: the call goes to one that does.
        with torch.no_grad():
            q, k, v = value(1200), value(40), value(40)
            mask = torch.zeros(1, 1, 1, 40, device='cuda', dtype=torch.bfloat16)
            mask[..., 30:] = -10000.0
            self.assertLess(relative(ltx25_block._attention(q, k, v, mask), plain(q, k, v, mask)), 5e-3)
            original, ltx25_block.HUGE = ltx25_block.HUGE, 1000
            try:
                self.assertLess(relative(ltx25_block._attention(q, k, v), plain(q, k, v)), 5e-3)
            finally:
                ltx25_block.HUGE = original

    def test_the_rotary_modules_give_the_matrices_of_their_cos_and_sin(self):
        angle = torch.rand(1, 4, 5, 8, device='cuda')
        rope = SimpleNamespace(
            _reference_forward=lambda coords, device=None: (angle.cos(), angle.sin()), _rotation_dtype=torch.float32
        )
        matrix = ltx25_block._rotations(rope, None)
        self.assertEqual(tuple(matrix.shape), (1, 5, 4, 8, 2, 2))
        cos, sin = angle.cos().permute(0, 2, 1, 3), angle.sin().permute(0, 2, 1, 3)
        self.assertTrue(torch.equal(matrix[..., 0, 0], cos) and torch.equal(matrix[..., 1, 1], cos))
        self.assertTrue(torch.equal(matrix[..., 0, 1], -sin) and torch.equal(matrix[..., 1, 0], sin))

    def test_only_the_blocks_this_forward_computes_are_fused(self):
        ropes = {name: torch.nn.Identity() for name in ltx25_block.ROPES}
        transformer = torch.nn.Module()
        transformer.transformer_blocks = torch.nn.ModuleList([self.block('interleaved')])
        for name, rope in ropes.items():
            setattr(transformer, name, rope)
        forward = transformer.transformer_blocks[0].forward
        self.assertFalse(ltx25_block.fuse(transformer))
        self.assertEqual(transformer.transformer_blocks[0].forward, forward)
        transformer.transformer_blocks = torch.nn.ModuleList([self.block()])
        self.assertTrue(ltx25_block.fuse(transformer))
        self.assertEqual(transformer.transformer_blocks[0].forward.__func__, ltx25_block._block_forward)
        self.assertEqual(transformer.rope.forward.__func__, ltx25_block._rotations)


class NullMaskTests(unittest.TestCase):
    def test_a_text_mask_that_hides_nothing_is_not_given_to_the_attention(self):
        seen = {}
        transformer = SimpleNamespace(_masks={}, _reference_forward=lambda **named: seen.update(named))
        rows, hidden = torch.ones(1, 6), torch.tensor([[1.0, 1, 1, 0, 0, 0]])
        bias, hiding = torch.zeros(1, 1, 6), torch.tensor([[[0.0, 0, -10000]]])
        ltx25_block._forward(transformer, encoder_attention_mask=rows, audio_encoder_attention_mask=bias)
        self.assertIsNone(seen['encoder_attention_mask'])
        self.assertIsNone(seen['audio_encoder_attention_mask'])
        ltx25_block._forward(transformer, encoder_attention_mask=hidden, audio_encoder_attention_mask=hiding)
        self.assertIs(seen['encoder_attention_mask'], hidden)
        self.assertIs(seen['audio_encoder_attention_mask'], hiding)
        # Read once: the same mask comes back at every step.
        self.assertIs(transformer._masks['encoder_attention_mask'][0], hidden)


@unittest.skipUnless(CUDA, 'the INT8 kernel runs on the GPU')
class StreamedLinearTests(unittest.TestCase):
    def linear(self, weight, scale=None, rows=64, features=256):
        """One streamed layer whose weights the pool hands over as given."""
        import comfy_kitchen

        tensors = {'weight': weight.cuda(), 'bias': torch.randn(rows, dtype=torch.bfloat16, device='cuda')}
        if scale is not None:
            tensors['scale'] = scale.cuda()
        store = SimpleNamespace(keys=lambda: ['layer.weight'])
        pool = SimpleNamespace(
            kernels=comfy_kitchen,
            stores={'model': store},
            adapters=(),
            adapted={},
            order=[],
            read=lambda location: weight,
            bundle=lambda location: tensors,
        )
        model = torch.nn.Sequential(torch.nn.Linear(features, rows))
        self.pool = pool
        return load_streamed(model, {'0.weight': ('model', 'layer.weight')}, pool)[0]

    def test_an_activation_and_a_residual_go_into_the_int8_product_with_the_same_result(self):
        torch.manual_seed(0)
        weight = torch.randint(-127, 128, (64, 256), dtype=torch.int8)
        linear = self.linear(weight, torch.tensor(0.01))
        rows = torch.randn(1, 300, 256, dtype=torch.bfloat16, device='cuda')
        residual = torch.randn(1, 300, 64, dtype=torch.bfloat16, device='cuda')
        gate = torch.rand(64, dtype=torch.bfloat16, device='cuda')
        gelu = torch.nn.functional.gelu(rows, approximate='tanh')
        with torch.no_grad():
            self.assertLess(relative(linear(rows, act='gelu_tanh'), linear(gelu)), 0.02)
            self.assertLess(relative(linear(rows, residual=residual, gate=gate), residual + gate * linear(rows)), 0.02)
            both = linear(rows, act='gelu_tanh', residual=residual, gate=gate)
            self.assertLess(relative(both, residual + gate * linear(gelu)), 0.02)
            self.assertEqual(both.dtype, torch.bfloat16)

    def test_a_lora_adds_its_term_to_the_product_whatever_goes_with_it(self):
        torch.manual_seed(0)
        value = lambda *shape: torch.randn(*shape, dtype=torch.bfloat16, device='cuda')  # noqa: E731
        down, up = value(8, 256) * 0.1, value(64, 8) * 0.1
        rows, residual = value(1, 300, 256), value(1, 300, 64)
        gate = torch.rand(64, dtype=torch.bfloat16, device='cuda')
        gelu = torch.nn.functional.gelu(rows, approximate='tanh')
        term = lambda source: torch.nn.functional.linear(torch.nn.functional.linear(source, down), up)  # noqa: E731
        weights = (
            (torch.randint(-127, 128, (64, 256), dtype=torch.int8), torch.tensor(0.01)),
            (torch.randn(64, 256, dtype=torch.bfloat16), None),
        )
        for weight, scale in weights:
            linear = self.linear(weight, scale)
            self.pool.adapter = lambda location, adapters, dtype=None: (down, up)
            with self.subTest(weight=weight.dtype), torch.no_grad():
                plain, activated = linear(rows), linear(gelu)
                linear.adapters = [('lora', 'down', 'up', 1.0)]
                self.assertLess(relative(linear(rows), plain + term(rows)), 0.02)
                # The LoRA reads the activated rows, as the weight does.
                self.assertLess(relative(linear(rows, act='gelu_tanh'), activated + term(gelu)), 0.02)
                # Summed into the stream: the gate scales the LoRA's term with the weight's.
                expected = residual + gate * (activated + term(gelu))
                got = linear(rows, act='gelu_tanh', residual=residual, gate=gate)
                self.assertLess(relative(got, expected), 0.02)
                got = linear(rows, residual=residual, gate=gate)
                self.assertLess(relative(got, residual + gate * (plain + term(rows))), 0.02)

    def test_a_weight_that_is_not_int8_computes_them_in_separate_steps(self):
        torch.manual_seed(0)
        linear = self.linear(torch.randn(64, 256, dtype=torch.bfloat16))
        rows = torch.randn(1, 30, 256, dtype=torch.bfloat16, device='cuda')
        residual = torch.randn(1, 30, 64, dtype=torch.bfloat16, device='cuda')
        gate = torch.rand(64, dtype=torch.bfloat16, device='cuda')
        gelu = torch.nn.functional.gelu(rows, approximate='tanh')
        with torch.no_grad():
            got = linear(rows, act='gelu_tanh', residual=residual, gate=gate)
            self.assertTrue(torch.equal(got, torch.addcmul(residual, linear(gelu), gate)))
            with self.assertRaises(ValueError):
                linear(rows, act='unknown')


if __name__ == '__main__':
    unittest.main()
