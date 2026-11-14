import unittest

import torch

from runner.models import ltx25_decoder

CUDA = torch.cuda.is_available()


def relative(got, expected):
    return ((got.float() - expected.float()).norm() / expected.float().norm()).item()


@unittest.skipUnless(CUDA, 'the neighborhood kernels run on the GPU')
class NeighborhoodKernelsTests(unittest.TestCase):
    def attention(self):
        from diffusers.models.autoencoders.ltx2_diffusion_decoder import LTX2VideoVaeNeighborhoodAttention

        torch.manual_seed(0)
        attn = LTX2VideoVaeNeighborhoodAttention(128, (3, 5, 5), head_dim=64).to('cuda', torch.bfloat16)
        with torch.no_grad():
            attn.norm_q.weight.copy_(torch.rand(64) + 0.5)
            attn.norm_k.weight.copy_(torch.rand(64) + 0.5)
        return attn

    def test_the_kernels_compute_the_attention_of_the_decoder(self):
        import comfy_kitchen

        attn = self.attention()
        processor = ltx25_decoder.NeighborhoodKernels()
        for grid in ((6, 9, 7), (20, 12, 10)):
            with self.subTest(grid=grid), torch.no_grad():
                hidden = torch.randn(1, *grid, 128, device='cuda', dtype=torch.bfloat16)
                # diffusers' own norm, scale and rotation of the queries and keys, then NATTEN's attention.
                query, key, value = attn.project_qkv(hidden)
                expected = comfy_kitchen.na3d(
                    query.contiguous(), key.contiguous(), value.contiguous(), [3, 5, 5], None, 1.0
                )
                expected = attn.to_out[0](expected.reshape(1, *grid, 128))
                got = processor(attn, hidden)
                self.assertEqual(got.shape, hidden.shape)
                self.assertLess(relative(got, expected), 2e-3)
                # A few frames of rotations at a time: the same result.
                original, ltx25_decoder.ROPE_TOKENS = ltx25_decoder.ROPE_TOKENS, 300
                try:
                    self.assertTrue(torch.equal(processor(attn, hidden), got))
                finally:
                    ltx25_decoder.ROPE_TOKENS = original

    def test_the_rotations_follow_each_axis_of_the_grid(self):
        attn = self.attention()
        tables = ltx25_decoder._tables(attn.rope, (4, 3, 2), torch.device('cuda'))
        self.assertEqual([tuple(cos.shape) for cos, _ in tables], [(4, 8), (3, 12), (2, 12)])
        rotations = ltx25_decoder._rotations(tables, 1, 3, 3, 2)
        self.assertEqual(tuple(rotations.shape), (1, 2 * 3 * 2, 1, 32, 2, 2))
        # The token of frame 2, row 1, column 1: its frame turns the first pairs, its row the next, its column the last.
        token = rotations[0, (2 - 1) * 6 + 1 * 2 + 1, 0]
        for pairs, (cos, sin), position in zip((slice(0, 8), slice(8, 20), slice(20, 32)), tables, (2, 1, 1)):
            self.assertTrue(torch.equal(token[pairs, 0, 0], cos[position]))
            self.assertTrue(torch.equal(token[pairs, 0, 1], -sin[position]))
            self.assertTrue(torch.equal(token[pairs, 1, 0], sin[position]))
            self.assertTrue(torch.equal(token[pairs, 1, 1], cos[position]))

    def test_the_decoder_attentions_take_the_kernels(self):
        holder = torch.nn.Module()
        holder.attn = self.attention()
        flex = holder.attn.processor
        self.assertTrue(ltx25_decoder.fuse(holder))
        self.assertIsInstance(holder.attn.processor, ltx25_decoder.NeighborhoodKernels)
        # No mask is built for a processor that reads none (it would not fit in memory at real sizes).
        self.assertIsNone(holder.attn.build_block_mask(torch.zeros(1, 4, 6, 6, 128, device='cuda')))
        self.assertFalse(ltx25_decoder.fuse(torch.nn.Linear(2, 2)))
        original, ltx25_decoder.KERNELS = ltx25_decoder.KERNELS, ('a kernel comfy-kitchen does not have',)
        try:
            holder.attn.set_processor(flex)
            self.assertFalse(ltx25_decoder.fuse(holder))
            self.assertIs(holder.attn.processor, flex)
        finally:
            ltx25_decoder.KERNELS = original


if __name__ == '__main__':
    unittest.main()
