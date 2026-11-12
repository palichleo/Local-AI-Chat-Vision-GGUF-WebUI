"""Video sparse attention: the layout of a packed sequence in blocks and cubes, and the attention
over it, checked against comfy-kitchen's own full-precision reference and, on a GPU, its kernel."""

import unittest

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
        self.assertIn('transformer_blocks.0.attn.to_q.weight', dense)
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


@unittest.skipUnless(sparse_attention.ready(), 'no sparse attention kernel on this machine')
class KernelTest(unittest.TestCase):
    def test_the_kernel_matches_the_reference(self):
        torch.manual_seed(5)
        plan = layout([130, 60, (8, 12, 16)]).to('cuda')
        heads, width = 4, 128
        q, k, v = (torch.randn(1, plan.rows, heads, width, device='cuda', dtype=torch.bfloat16) for _ in range(3))
        g = torch.rand(1, plan.rows, heads, width, device='cuda', dtype=torch.bfloat16)
        expected = sparse_attention.reference(q, k, v, g, plan, 0.1).float()
        found = plan.untile(sparse_attention.attend(plan.tile(q), plan.tile(k), plan.tile(v), plan.tile(g), plan, 0.1))
        cosine = torch.nn.functional.cosine_similarity(found.float().flatten(), expected.flatten(), dim=0)
        self.assertGreater(float(cosine), 0.99)


if __name__ == '__main__':
    unittest.main()
