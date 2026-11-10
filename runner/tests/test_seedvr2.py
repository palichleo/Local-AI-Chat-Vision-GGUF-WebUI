import importlib.util
import unittest

HAS_TORCH = importlib.util.find_spec('torch') is not None


@unittest.skipUnless(HAS_TORCH, 'torch is not installed')
class SeedVR2Test(unittest.TestCase):
    def test_windows_cover_every_token_once(self):
        import torch

        from runner.models import seedvr2

        for size in [(1, 72, 128), (1, 8, 12), (1, 40, 30), (3, 17, 23), (1, 1, 1)]:
            for method in ('win', 'swin'):
                grid = torch.zeros(size, dtype=torch.int)
                for st, sh, sw in seedvr2.window_slices(size, method):
                    grid[slice(*st), slice(*sh), slice(*sw)] += 1
                self.assertTrue(bool((grid == 1).all()), (size, method))

    def test_folded_vae_matches_a_three_tap_causal_kernel(self):
        import torch

        from runner.models import seedvr2_vae

        weight = torch.randn(4, 3, 3, 3)
        folded = seedvr2_vae.folded({'w': weight[:, :, None].repeat(1, 1, 3, 1, 1) / 3})['w']
        self.assertTrue(torch.allclose(folded, weight, atol=1e-6))

    def test_colour_corrections_keep_an_identical_image(self):
        import torch

        from runner.models import seedvr2_color

        image = torch.rand(1, 3, 32, 32)
        for method in seedvr2_color.METHODS:
            self.assertLess((seedvr2_color.correct(image, image, method) - image).abs().max().item(), 1e-4)

    def test_bundled_text_embedding_has_its_shape(self):
        from runner.models import seedvr2

        self.assertEqual(seedvr2.POSITIVE.stat().st_size, 58 * 5120 * 2)


if __name__ == '__main__':
    unittest.main()
