import unittest
from unittest.mock import patch

import torch

from runner.models import wan_block, wan_scail2

CUDA = torch.cuda.is_available()


def relative(got, expected):
    return ((got.float() - expected.float()).norm() / expected.float().norm()).item()


class RotationTableTests(unittest.TestCase):
    def test_cos_and_sin_become_one_matrix_a_pair_of_channels_built_once(self):
        cos = torch.tensor([0.5, 0.5, 0.2, 0.2]).view(1, 1, 1, 4)
        sin = torch.tensor([0.1, 0.1, 0.9, 0.9]).view(1, 1, 1, 4)
        table = wan_block.rotation_table(cos, sin)
        self.assertEqual(tuple(table.shape), (1, 1, 1, 2, 2, 2))
        self.assertTrue(torch.allclose(table[0, 0, 0, 0], torch.tensor([[0.5, -0.1], [0.1, 0.5]])))
        self.assertTrue(torch.allclose(table[0, 0, 0, 1], torch.tensor([[0.2, -0.9], [0.9, 0.2]])))
        self.assertIs(wan_block.rotation_table(cos, sin), table)


@unittest.skipUnless(CUDA, 'the fused kernels run on the GPU')
class FusedBlockTests(unittest.TestCase):
    def setUp(self):
        from diffusers.models.transformers.transformer_wan import WanRotaryPosEmbed, WanTransformerBlock

        torch.manual_seed(0)
        # Two heads of the real size, the image projections of an image-to-video model.
        block = WanTransformerBlock(dim=256, ffn_dim=512, num_heads=2, cross_attn_norm=True, added_kv_proj_dim=256)
        self.block = block.eval().to('cuda', torch.bfloat16)
        self.model = torch.nn.Module()
        self.model.blocks = torch.nn.ModuleList([self.block])
        rope = WanRotaryPosEmbed(128, (1, 2, 2), 256).cuda()
        # The reference, two frames of video and the pose, whose rotations are averages.
        self.rotary = wan_scail2.rotations(rope, 2, 4, 6, True, dtype=torch.bfloat16)
        kind = dict(device='cuda', dtype=torch.bfloat16)
        self.stream = torch.randn(1, self.rotary[0].shape[1], 256, **kind)
        self.context = torch.randn(1, 9 + wan_block.TEXT_TOKENS, 256, **kind)
        self.temb = torch.randn(1, 6, 256, **kind) * 0.2

    def run_block(self):
        with torch.no_grad():
            return self.block(self.stream, self.context, self.temb, self.rotary)

    def test_the_fused_block_computes_what_diffusers_block_computes(self):
        exact = self.run_block()
        self.assertEqual(wan_block.fuse(self.model, int8_attention=False), (True, False))
        given = self.stream.clone()
        fused = self.run_block()
        # bfloat16's own rounding: diffusers' block in float32 is as far from itself in bfloat16.
        self.assertLess(relative(fused, exact), 0.01)
        self.assertTrue(torch.equal(self.stream, given), 'the stream handed in is the caller\'s')
        # The feed-forward a few rows at a time gives the same rows.
        with patch.object(wan_block, 'ROWS', 7):
            self.assertLess(relative(self.run_block(), fused), 0.005)
        # Fused twice, the block still knows diffusers' own forward.
        wan_block.fuse(self.model, int8_attention=False)
        self.assertEqual(self.block._reference_forward.__func__.__qualname__, 'WanTransformerBlock.forward')

    def test_the_int8_attention_stays_within_its_rounding(self):
        exact = self.run_block()
        fused, fast = wan_block.fuse(self.model)
        if not fast:
            self.skipTest('no INT8 attention kernel for this GPU')
        self.assertLess(relative(self.run_block(), exact), 0.02)

    def test_a_timestep_for_each_token_is_left_to_diffusers(self):
        wan_block.fuse(self.model, int8_attention=False)
        temb = self.temb[:, None].expand(1, self.stream.shape[1], 6, 256).contiguous()
        with torch.no_grad():
            fused = self.block(self.stream, self.context, temb, self.rotary)
            exact = self.block._reference_forward(self.stream, self.context, temb, self.rotary)
        self.assertTrue(torch.equal(fused, exact))

    def test_a_model_of_another_kind_keeps_its_blocks(self):
        self.block.attn1.norm_q = torch.nn.LayerNorm(256).to('cuda', torch.bfloat16)
        forward = self.block.forward
        self.assertEqual(wan_block.fuse(self.model), (False, False))
        self.assertEqual(self.block.forward, forward)


@unittest.skipUnless(CUDA, 'the fused kernels run on the GPU')
class FusedModelTests(unittest.TestCase):
    def test_the_whole_model_with_fused_blocks_gives_the_same_video(self):
        from diffusers import WanTransformer3DModel

        torch.manual_seed(1)
        model = WanTransformer3DModel(
            num_attention_heads=2,
            attention_head_dim=128,
            in_channels=20,
            out_channels=16,
            text_dim=32,
            freq_dim=16,
            ffn_dim=512,
            num_layers=2,
            image_dim=8,
            added_kv_proj_dim=256,
            rope_max_seq_len=256,
        )
        model = wan_scail2.extend(model).eval().to('cuda', torch.bfloat16)
        kind = dict(device='cuda', dtype=torch.bfloat16)
        given = dict(
            video=torch.randn(1, 20, 2, 16, 16, **kind),
            timestep=torch.tensor([500], device='cuda'),
            text=torch.randn(1, 512, 32, **kind),
            image=torch.randn(1, 5, 8, **kind),
            reference=torch.randn(1, 20, 1, 16, 16, **kind),
            pose=torch.randn(1, 20, 2, 8, 8, **kind),
        )
        with torch.no_grad():
            exact = wan_scail2.forward(model, **given)
            self.assertEqual(wan_block.fuse(model, int8_attention=False), (True, False))
            fused = wan_scail2.forward(model, **given)
        self.assertEqual(tuple(fused.shape), (1, 16, 2, 16, 16))
        self.assertLess(relative(fused, exact), 0.02)


if __name__ == '__main__':
    unittest.main()
