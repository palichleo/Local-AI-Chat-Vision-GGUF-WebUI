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


@unittest.skipUnless(CUDA, 'the neighborhood kernels run on the GPU')
class GroupsOfFramesTests(unittest.TestCase):
    """The decode a group of frames at a time (17/11: a video of 10 s at 1088 x 1920 was sampled to
    its end and lost in the decode, which joined the whole video on the GPU)."""

    def decoder(self):
        from diffusers.models.autoencoders.ltx2_diffusion_decoder import LTX2VideoDiffusionDecoderModel

        torch.manual_seed(0)
        vae = LTX2VideoDiffusionDecoderModel(
            latent_channels=8,
            decoder_head_dim=16,
            decoder_stage_channels=(64, 32, 16, 16, 16),
            decoder_stage_depths=(1, 1, 1, 1, 1),
            decoder_stage_kernels=((3, 3, 3),) * 4,
            decoder_upsample_channel_reductions=(2, 2, 1, 1),
            decoder_stage5_kernel=(3, 3, 3),
            decoder_t_emb_dim=32,
        )
        vae = vae.eval().to('cuda', torch.bfloat16)
        self.assertTrue(ltx25_decoder.fuse(vae))
        return vae

    def tiles(self, vae, frames, side, stride_frames, stride_side):
        vae.enable_tiling(
            tile_sample_min_height=side,
            tile_sample_min_width=side,
            tile_sample_min_num_frames=frames,
            tile_sample_stride_height=stride_side,
            tile_sample_stride_width=stride_side,
            tile_sample_stride_num_frames=stride_frames,
        )

    def test_the_groups_are_the_video_the_library_decodes_in_one_piece(self):
        vae = self.decoder()
        latents = torch.randn(1, 8, 9, 3, 4, device='cuda', dtype=torch.bfloat16)
        seeded = lambda: torch.Generator('cuda').manual_seed(7)  # noqa: E731
        # Tiles in time alone, in time and space, without anything shared, and one tile for the whole video.
        for name, plan in dict(
            time=(16, 256, 12, 256), both=(16, 64, 12, 48), apart=(16, 64, 16, 64), whole=(128, 256, 128, 256)
        ).items():
            with self.subTest(name), torch.no_grad():
                self.tiles(vae, *plan)
                expected = vae.decode(latents, generator=seeded()).sample
                groups = [group.clone() for group in ltx25_decoder.decode_groups(vae, latents, seeded())]
                self.assertTrue(torch.equal(torch.cat(groups, dim=2), expected))
                if name in ('time', 'both', 'apart'):
                    self.assertGreater(len(groups), 1, 'several groups of frames')
                self.assertEqual(sum(group.shape[2] for group in groups), (9 - 1) * 8 + 1)

    def test_the_features_of_a_stretch_of_frames_are_those_of_the_whole_video(self):
        vae = self.decoder()
        latents = torch.randn(1, 8, 9, 3, 4, device='cuda', dtype=torch.bfloat16)
        with torch.no_grad():
            whole = vae.decoder.forward_stages_1_to_3(latents)
            features = ltx25_decoder.Features(vae.decoder, latents)
            self.assertEqual((features.frames, features.height, features.width), tuple(whole.shape[1:4]))
            for start, stop in ((0, whole.shape[1]), (0, 5), (1, 6), (4, 9), (7, whole.shape[1]), (10, 11)):
                with self.subTest(start=start, stop=stop):
                    self.assertTrue(torch.equal(features.stretch(start, stop), whole[:, start:stop]))

    def test_a_group_leaves_the_card_before_the_next_is_decoded(self):
        vae = self.decoder()
        latents = torch.randn(1, 8, 17, 3, 4, device='cuda', dtype=torch.bfloat16)
        self.tiles(vae, 16, 256, 12, 256)
        with torch.no_grad():
            whole = vae.decode(latents, generator=torch.Generator('cuda').manual_seed(7)).sample
            pixels = whole.numel() * whole.element_size()
            del whole
            torch.cuda.empty_cache()
            torch.cuda.reset_peak_memory_stats()
            before = torch.cuda.memory_allocated()
            frames = 0
            for group in ltx25_decoder.decode_groups(vae, latents, torch.Generator('cuda').manual_seed(7)):
                frames += group.shape[2]
                del group
            held = torch.cuda.max_memory_allocated() - before
        self.assertEqual(frames, (17 - 1) * 8 + 1)
        # Never the whole video at once: less than its pixels, where the library held them several times.
        self.assertLess(held, pixels)


if __name__ == '__main__':
    unittest.main()
