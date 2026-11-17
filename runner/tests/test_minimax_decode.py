import unittest
from types import SimpleNamespace

import torch

from runner.models import minimax_h3_vae


class DecodeChunksTests(unittest.TestCase):
    """The video decoded a stretch of frames at a time (17/11: a video of 1920 x 1088 was sampled to
    its end and lost in the decode, which joined it whole on the GPU several times)."""

    def vae(self, clip_length=17, token_drop=3, ratio=4):
        """What the decode reads of the VAE, with a decoder that only stretches its latents in time:
        the clips, their cross-fades and the cut of the end are the library's own."""
        from diffusers import AutoencoderKLMiniMaxH3 as Library

        size = -(-clip_length // ratio)
        overlap = (-token_drop) % size
        padding = (-clip_length) % ratio
        vae = SimpleNamespace(
            config=SimpleNamespace(token_drop=token_drop, clip_length=clip_length),
            tokens_chunk_size=size,
            temporal_compression_ratio=ratio,
            token_overlap=overlap,
            frame_pre_padding=padding,
            frame_overlap=max(overlap * ratio - padding, 0),
            post_quant_conv=torch.nn.Conv3d(2, 2, 1).double(),
        )
        # Each latent frame becomes as many frames as the VAE's ratio, marked by the clip that made them.
        calls = []

        def clip(z):
            calls.append(z.shape[2])
            return z.repeat_interleave(ratio, dim=2) + 0.001 * len(calls)

        vae._decode_clip = clip
        vae._blend = lambda a, b, extent, dim: Library._blend(vae, a, b, extent, dim)
        vae.library = lambda z: Library._decode(vae, z)
        vae.calls = calls
        return vae

    def test_the_chunks_are_the_video_the_library_decodes_in_one_piece(self):
        torch.manual_seed(2)
        # The latent frames of the lengths the model takes (5 to 15 s), and lengths that fill no clip.
        for tokens in (37, 42, 57, 72, 102, 38, 40, 41):
            with self.subTest(latent_frames=tokens):
                vae = self.vae()
                latents = torch.randn(1, 2, tokens, 3, 4, dtype=torch.float64)
                expected = vae.library(latents)
                vae.calls.clear()
                chunks = list(minimax_h3_vae.decode_chunks(vae, latents))
                self.assertTrue(torch.equal(torch.cat(chunks, dim=2), expected))
                self.assertGreater(len(chunks), 2, 'a stretch of frames is given before the video is decoded')

    def test_a_stretch_is_given_as_soon_as_the_frames_cut_off_the_end_wait_behind_it(self):
        vae = self.vae()
        latents = torch.randn(1, 2, 37, 3, 4, dtype=torch.float64)
        clips = []
        for _ in minimax_h3_vae.decode_chunks(vae, latents):
            clips.append(len(vae.calls))
        # The first stretch left before the last clip was decoded.
        self.assertLess(clips[0], clips[-1])
        self.assertEqual(clips, sorted(clips))


if __name__ == '__main__':
    unittest.main()
