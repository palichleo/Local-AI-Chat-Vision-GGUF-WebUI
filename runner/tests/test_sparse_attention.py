"""Video sparse attention: the layout of a packed sequence in blocks and cubes, and the attention
over it, checked against comfy-kitchen's own full-precision reference and, on a GPU, its kernel."""

import unittest
import unittest.mock

import torch

from runner.models import minimax_h3, sparse_attention
from runner.models.sparse_attention import BLOCK, layout


def sequence(grid, text=70, audio=40):
    """A packed MiniMax-H3 sequence as the transformer receives it: text, then the sound's rows
    (two channels), then the generated video, frame-major."""
    target = grid[0] * grid[1] * grid[2]
    rows = text + audio + target
    position = torch.zeros(rows, 3, dtype=torch.float64)
    position[:text, 0] = torch.arange(text, dtype=torch.float64)
    position[text : text + audio, 0] = text + torch.arange(audio // 2, dtype=torch.float64).repeat(2)
    position[text + audio :, 0] = text + torch.arange(grid[0], dtype=torch.float64).repeat_interleave(target // grid[0])
    return dict(
        position_ids=position,
        text_indices=torch.arange(text),
        audio_indices=torch.arange(text, text + audio),
        video_indices=torch.arange(text + audio, rows),
    )


class LayoutTest(unittest.TestCase):
    def test_every_row_has_one_slot_live_rows_first(self):
        plan = layout([70, 40, (5, 6, 7)])
        rows = 70 + 40 + 5 * 6 * 7
        self.assertEqual(plan.rows, rows)
        self.assertEqual(torch.unique(plan.slots).numel(), rows)
        # 70 text rows: one full block and one of 6; 40 sound rows: one block; then the cubes.
        self.assertEqual(plan.exact, 3)
        self.assertEqual(plan.lengths[:3].tolist(), [64, 6, 40])
        self.assertEqual(int(plan.lengths.sum()), rows)
        # 2 x 2 x 2 cubes over 5 x 6 x 7 tokens: the far ones are cut.
        self.assertEqual(plan.blocks, 3 + 8)
        self.assertEqual(plan.lengths[3:].tolist(), [64, 48, 32, 24, 16, 12, 8, 6])
        offsets = plan.slots % BLOCK
        self.assertTrue(bool((offsets < plan.lengths[plan.slots // BLOCK].long()).all()))

    def test_a_cube_holds_neighbouring_tokens(self):
        plan = layout([(8, 4, 4)])
        rows = torch.arange(8 * 4 * 4).reshape(8, 4, 4)
        first = rows[:4].reshape(-1)
        self.assertEqual(sorted((plan.slots[first] // BLOCK).tolist()), [0] * 64)
        self.assertEqual(sorted((plan.slots[rows[4:].reshape(-1)] // BLOCK).tolist()), [1] * 64)

    def test_tile_and_untile_give_the_rows_back(self):
        plan = layout([10, (3, 5, 9)])
        value = torch.randn(2, plan.rows, 3, 8)
        tiled = plan.tile(value)
        self.assertEqual(tuple(tiled.shape), (2, plan.blocks * BLOCK, 3, 8))
        self.assertTrue(torch.equal(plan.untile(tiled), value))
        # The padding is zero.
        live = torch.zeros(plan.blocks * BLOCK, dtype=torch.bool)
        live[plan.slots] = True
        self.assertEqual(float(tiled[:, ~live].abs().sum()), 0.0)

    def test_a_sequence_without_video_is_refused(self):
        with self.assertRaises(ValueError):
            layout([100])


class SegmentsTest(unittest.TestCase):
    def test_text_sound_then_video(self):
        values = sequence((5, 6, 7))
        self.assertEqual(minimax_h3.segments(values, (5, 6, 7)), [70, 40, (5, 6, 7)])

    def test_two_key_frames_are_two_runs(self):
        grid = (3, 4, 4)
        values = sequence(grid, text=20, audio=10)
        # Two key frames of 16 rows each, between the text and the sound, at two rotary times.
        frames = torch.zeros(32, 3, dtype=torch.float64)
        frames[:16, 0], frames[16:, 0] = 20.0, 30.0
        position = torch.cat([values['position_ids'][:20], frames, values['position_ids'][20:]])
        rows = position.shape[0]
        values = dict(
            position_ids=position,
            text_indices=torch.arange(20),
            audio_indices=torch.arange(52, 62),
            video_indices=torch.cat([torch.arange(20, 52), torch.arange(62, rows)]),
        )
        self.assertEqual(minimax_h3.segments(values, grid), [20, 16, 16, 10, grid])

    def test_a_sequence_that_does_not_end_with_the_video(self):
        values = sequence((2, 4, 4))
        self.assertIsNone(minimax_h3.segments(values, (3, 4, 4)))


class GatesTest(unittest.TestCase):
    def test_the_gates_are_read_only_for_sparse_attention(self):
        header = {
            '__metadata__': {},
            'blocks.0.attn.qkv_proj.weight': {},
            'blocks.0.attn.to_gate_compress.weight': {},
            'blocks.0.attn.to_gate_compress.weight_scale': {},
            'rope.freqs.weight': {},
        }
        dense = minimax_h3.names(header)
        self.assertNotIn('transformer_blocks.0.attn.to_gate_compress.weight', dense)
        self.assertIn('transformer_blocks.0.attn.to_qkv.weight', dense)
        sparse = minimax_h3.names(header, gate=True)
        self.assertEqual(
            sparse['transformer_blocks.0.attn.to_gate_compress.weight'],
            ('model', 'blocks.0.attn.to_gate_compress.weight', None),
        )
        self.assertFalse(any(name.startswith('rope.') for name in sparse))
        self.assertTrue(minimax_h3.has_gates(header))

    @unittest.skipUnless(torch.cuda.is_available(), 'no GPU')
    def test_a_short_sequence_stays_dense(self):
        sparse = minimax_h3.Sparse(0.1)
        self.assertIsNone(sparse.prepare(sequence((37, 14, 24)), (37, 14, 24)))
        grid = (40, 24, 24)
        plan = sparse.prepare(sequence(grid), grid)
        self.assertEqual(plan.rows, 70 + 40 + 40 * 24 * 24)
        self.assertIs(sparse.prepare(sequence(grid), grid), plan)


class ReferenceTest(unittest.TestCase):
    """`reference` (the rows of the sequence) and comfy-kitchen's full-precision reference of its
    kernel (the padded blocks) compute the same attention: the plan's blocks, sinks and padding
    mean to the kernel what this module means by them."""

    def check(self, gate, keep):
        from comfy_kitchen.backends.eager.sol_attn import sol_attn

        torch.manual_seed(3)
        plan = layout([70, 40, (6, 8, 8)])
        heads, width = 2, 128
        q, k, v = (torch.randn(1, plan.rows, heads, width) for _ in range(3))
        g = torch.rand(1, plan.rows, heads, width) if gate else None
        ours = sparse_attention.reference(q, k, v, g, plan, keep)
        theirs = sol_attn(
            plan.tile(q),
            plan.tile(k),
            plan.tile(v),
            sink_blocks=[0, plan.exact],
            sink_q=[0, plan.exact],
            topk_ratio=keep,
            tail=False,
            block_len=plan.lengths,
            coarse_gate=plan.tile(g) if gate else None,
        )
        torch.testing.assert_close(ours, plan.untile(theirs), atol=1e-4, rtol=1e-4)

    def test_fine_stage(self):
        self.check(gate=False, keep=0.25)

    def test_with_the_coarse_branch(self):
        self.check(gate=True, keep=0.1)


class BlockTest(unittest.TestCase):
    def test_modulated_by_runs_as_diffusers_does_row_by_row(self):
        from diffusers.models.transformers.transformer_minimax_h3 import MiniMaxH3TransformerBlock

        torch.manual_seed(4)
        block = MiniMaxH3TransformerBlock(64, 2, 32, 96, 16, 1e-6, 1e-6).to(torch.bfloat16)
        for parameter in block.parameters():
            parameter.data.normal_(0, 0.2)
        rows = 40
        hidden = torch.randn(1, rows, 64, dtype=torch.bfloat16)
        temb = torch.randn(2, 16)
        # Two timesteps x three modalities: text, sound, video rows, then conditions.
        indices = torch.tensor([1] * 7 + [2] * 5 + [0] * 20 + [3] * 8)
        angles = torch.randn(rows, 12)
        rotary = (torch.cat([angles, angles], -1).cos(), torch.cat([angles, angles], -1).sin())
        expected = block(hidden.clone(), temb, indices, rotary)
        block._reference_forward = block.forward
        block.forward = minimax_h3._block_forward.__get__(block)
        found = block(hidden.clone(), temb, indices.clone(), rotary)
        self.assertTrue(torch.equal(found, expected))
        self.assertEqual(minimax_h3.runs(torch.tensor([5, 5, 6, 6, 6, 5])), [(0, 2, 5), (2, 5, 6), (5, 6, 5)])
        self.assertIsNone(minimax_h3.runs(torch.arange(100)))


class RotationTest(unittest.TestCase):
    def test_turned_in_place_as_diffusers_turns_it(self):
        from diffusers.models.transformers.transformer_minimax_h3 import _apply_rotary_emb

        torch.manual_seed(2)
        value = torch.randn(1, 50, 3, 128, dtype=torch.bfloat16)
        angles = torch.randn(50, 48)
        cos, sin = torch.cat([angles, angles], -1).cos(), torch.cat([angles, angles], -1).sin()
        expected = _apply_rotary_emb(value, cos, sin)
        self.assertTrue(torch.equal(minimax_h3.rotate_(value.clone(), cos, sin), expected))


@unittest.skipUnless(minimax_h3.int8_attention_ready(), 'no INT8 attention kernel on this machine')
class FusedAttentionTest(unittest.TestCase):
    def test_one_projection_and_the_fused_rotation_give_diffusers_attention(self):
        with torch.inference_mode():
            self.check()

    def check(self):
        from diffusers.models.transformers.transformer_minimax_h3 import MiniMaxH3Attention

        torch.manual_seed(6)
        attn = MiniMaxH3Attention(256, 4, 128, 1e-5).to('cuda', torch.bfloat16)
        for parameter in attn.parameters():
            parameter.data.normal_(0, 0.05)
        attn.norm_q.weight.data.uniform_(0.5, 1.5)
        attn.norm_k.weight.data.uniform_(0.5, 1.5)
        rows = 700
        hidden = torch.randn(1, rows, 256, device='cuda', dtype=torch.bfloat16)
        angles = torch.randn(rows, 48, device='cuda')
        rotary = (torch.cat([angles, angles], -1).cos(), torch.cat([angles, angles], -1).sin())
        expected = attn(hidden, rotary).float()
        attn.to_qkv = torch.nn.Linear(256, 3 * 512, bias=False).to('cuda', torch.bfloat16)
        attn.to_qkv.weight.data = torch.cat([attn.to_q.weight, attn.to_k.weight, attn.to_v.weight]).data
        found = minimax_h3.Int8Attention()(attn, hidden, rotary).float()
        cosine = torch.nn.functional.cosine_similarity(found.flatten(), expected.flatten(), dim=0)
        self.assertGreater(float(cosine), 0.995)
        # The rotation alone: comfy-kitchen's kernel against PyTorch's norm and rotate_.
        query = torch.randn(1, rows, 4, 128, device='cuda', dtype=torch.bfloat16)
        key = torch.randn(1, rows, 4, 128, device='cuda', dtype=torch.bfloat16)
        reference = [
            minimax_h3.rotate_(norm(value), *rotary) for norm, value in ((attn.norm_q, query), (attn.norm_k, key))
        ]
        import comfy_kitchen

        comfy_kitchen.rms_rope_split_half_(
            query,
            key,
            minimax_h3.rotation_table(*rotary),
            attn.norm_q.weight.detach(),
            attn.norm_k.weight.detach(),
            1e-5,
            rot_dim=96,
        )
        torch.testing.assert_close(query, reference[0], atol=0.05, rtol=0.02)
        torch.testing.assert_close(key, reference[1], atol=0.05, rtol=0.02)


@unittest.skipUnless(minimax_h3.int8_attention_ready(), 'no comfy-kitchen CUDA kernels on this machine')
class GatedProjectionTest(unittest.TestCase):
    def test_the_gated_activation_taken_in_by_the_quantizer_gives_the_same_projection(self):
        import comfy_kitchen

        torch.manual_seed(8)
        rows = torch.randn(300, 2 * 512, device='cuda', dtype=torch.bfloat16)
        weight = torch.randint(-127, 128, (256, 512), device='cuda', dtype=torch.int8)
        scale = torch.rand(256, 1, device='cuda') / 500
        with torch.inference_mode():
            fused = comfy_kitchen.int8_linear(rows, weight, scale, None, torch.bfloat16, True, 256, input_act='swiglu')
            gate, up = rows.chunk(2, dim=-1)
            apart = comfy_kitchen.int8_linear(
                torch.nn.functional.silu(gate) * up, weight, scale, None, torch.bfloat16, True, 256
            )
        cosine = torch.nn.functional.cosine_similarity(fused.float().flatten(), apart.float().flatten(), dim=0)
        self.assertGreater(float(cosine), 0.999)


@unittest.skipUnless(torch.cuda.is_available(), 'no GPU')
class DecoderAttentionTest(unittest.TestCase):
    def test_one_projection_and_the_fused_rotation_give_the_decoder_attention_of_diffusers(self):
        with torch.inference_mode():
            self.check()

    def check(self):
        from diffusers.models.autoencoders.autoencoder_kl_minimax_h3 import MiniMaxH3VideoAttention
        from runner.models import minimax_h3_vae

        torch.manual_seed(7)
        heads, width = 2, 64
        attn = MiniMaxH3VideoAttention(heads * width, heads, width).to('cuda', torch.bfloat16)
        for parameter in attn.parameters():
            parameter.data.normal_(0, 0.1)
        rows = 300
        hidden = torch.randn(1, rows, heads * width, device='cuda', dtype=torch.bfloat16)
        angles = torch.randn(1, rows, 1, 24, device='cuda')
        rotary = (torch.cat([angles, angles], -1).cos(), torch.cat([angles, angles], -1).sin())
        expected = attn(hidden, rotary).float()
        # The file's layout: per head, q then k then v.
        weight = torch.stack([part.weight.view(heads, width, -1) for part in (attn.to_q, attn.to_k, attn.to_v)], 1)
        bias = torch.stack([part.bias.view(heads, width) for part in (attn.to_q, attn.to_k, attn.to_v)], 1)
        attn.to_qkv = torch.nn.Linear(heads * width, 3 * heads * width).to('cuda', torch.bfloat16)
        attn.to_qkv.weight.data = weight.reshape(3 * heads * width, -1).clone()
        attn.to_qkv.bias.data = bias.reshape(-1).clone()
        found = minimax_h3_vae.DecoderAttention()(attn, hidden, rotary).float()
        cosine = torch.nn.functional.cosine_similarity(found.flatten(), expected.flatten(), dim=0)
        self.assertGreater(float(cosine), 0.999)


@unittest.skipUnless(sparse_attention.ready(), 'no sparse attention kernel on this machine')
class KernelTest(unittest.TestCase):
    def inputs(self):
        torch.manual_seed(5)
        plan = layout([130, 60, (8, 12, 16)]).to('cuda')
        heads, width = 4, 128
        q, k, v = (torch.randn(1, plan.rows, heads, width, device='cuda', dtype=torch.bfloat16) for _ in range(3))
        g = torch.rand(1, plan.rows, heads, width, device='cuda', dtype=torch.bfloat16)
        return plan, q, k, v, g

    def sparse(self, plan, q, k, v, g):
        q, k, v = plan.tile(q), plan.tile(k), plan.tile(v)
        answer = sparse_attention.coarse(q, k, v, plan)
        return sparse_attention.add_coarse(sparse_attention.attend(q, k, v, plan, 0.1), g, answer, plan)

    def test_the_kernel_matches_the_reference(self):
        plan, q, k, v, g = self.inputs()
        expected = sparse_attention.reference(q, k, v, g, plan, 0.1).float()
        found = self.sparse(plan, q, k, v, g)
        cosine = torch.nn.functional.cosine_similarity(found.float().flatten(), expected.flatten(), dim=0)
        self.assertGreater(float(cosine), 0.99)

    def test_heads_by_packs_give_the_same_result(self):
        plan, q, k, v, g = self.inputs()
        whole = self.sparse(plan, q, k, v, g)
        with unittest.mock.patch.object(sparse_attention, 'HEAD_BYTES', 1):
            self.assertEqual(len(sparse_attention.packs(4, plan.blocks * 64)), 4)
            single = self.sparse(plan, q, k, v, g)
        torch.testing.assert_close(single, whole, atol=0, rtol=0)


if __name__ == '__main__':
    unittest.main()
