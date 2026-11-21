import base64
import io
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from runner import preview


class PreviewTests(unittest.TestCase):
    def test_a_latent_becomes_a_small_jpeg_at_its_own_resolution(self):
        import torch
        from PIL import Image

        latent = torch.zeros(16, 6, 10)
        latent[3] = 4  # the channel that brightens all three colours most
        sent = preview.picture(latent, preview.KREA2)
        self.assertEqual(sent['mime'], 'image/jpeg')
        image = Image.open(io.BytesIO(base64.b64decode(sent['data'])))
        self.assertEqual((image.format, image.size), ('JPEG', (10, 6)))
        red, green, blue = image.convert('RGB').getpixel((5, 3))
        self.assertGreater(min(red, green, blue), 180)

    def test_a_failed_preview_never_stops_the_generation(self):
        import torch

        sent = []
        with patch('sys.stderr', io.StringIO()) as errors:
            preview.send(lambda **data: sent.append(data), preview.KREA2, torch.zeros, 24, 2, 2)
        self.assertEqual(sent, [])
        self.assertIn('Preview skipped', errors.getvalue())

    def test_an_image_shows_the_latent_its_velocity_points_from(self):
        import torch
        from runner.pipelines.krea2 import finished

        clean, noise, sigma = torch.randn(1, 16, 4, 6), torch.randn(1, 16, 4, 6), 0.7
        noisy = (1 - sigma) * clean + sigma * noise
        torch.testing.assert_close(finished(noisy, noise - clean, sigma), clean[0])

    def test_a_video_shows_its_middle_frame_as_the_step_sees_it_finished(self):
        import torch
        from runner.pipelines.minimax_h3 import _patchify, middle_frame

        video = torch.randn(1, 24, 5, 6, 8)  # (1, C, T, H, W): a 3 x 4 grid of tokens per frame
        velocity = torch.randn(1, 24, 5, 6, 8)
        condition = torch.randn(7, 96)  # rows of a reference before the generated video
        rows = torch.cat([condition, _patchify(video)])[None]
        speed = torch.cat([torch.zeros(7, 96), _patchify(velocity)])[None]
        found = middle_frame(rows, speed, 0.25, (5, 3, 4))
        torch.testing.assert_close(found, video[0, :, 2] + 0.25 * velocity[0, :, 2])
        self.assertEqual(len(preview.MINIMAX_H3[0]), found.shape[0])

    def test_the_preview_goes_to_the_page_not_to_the_journal(self):
        from runner import engine

        written, sent = [], []

        class Journal:
            def __init__(self, config, job):
                pass

            def write(self, **entry):
                written.append(entry)

        def generate(job, config, progress):
            progress(stage='denoising', step=1, total=4)
            progress(preview=dict(mime='image/jpeg', data='/9j/'))
            return 'image'

        torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False))
        with (
            patch.dict(sys.modules, torch=torch),
            patch.object(engine, 'Journal', Journal),
            patch.object(engine, 'preflight', lambda job, config: None),
            patch.object(engine, 'validate_config', lambda config: config),
            patch.object(engine, 'pipeline', lambda name: SimpleNamespace(generate=generate)),
        ):
            self.assertEqual(engine.generate({'pipeline': 'any'}, {}, lambda **data: sent.append(data)), 'image')
        self.assertEqual(written, [dict(stage='denoising', step=1, total=4), dict(event='done')])
        self.assertEqual([list(data) for data in sent], [['stage', 'step', 'total'], ['preview']])


if __name__ == '__main__':
    unittest.main()


class Ltx25PreviewTests(unittest.TestCase):
    """(0.6.178) LTX 2.5 sent no picture while it computed: no screen showed a take of the Bobine, all
    made by it, taking shape (« j'ai pas la prévisualisation », 21/11)."""

    def test_its_colours_are_a_weight_for_each_of_its_128_channels_and_a_bias(self):
        import torch
        from PIL import Image

        factors, bias = preview.LTX25
        self.assertEqual((len(factors), {len(row) for row in factors}, len(bias)), (128, {3}, 3))
        self.assertTrue(all(abs(value) < 2 for row in (*factors, bias) for value in row))
        # A latent of its shape for 768 x 448 (a thirty-second of the picture) is a picture of that size.
        sent = preview.picture(torch.zeros(128, 14, 24), preview.LTX25)
        image = Image.open(io.BytesIO(base64.b64decode(sent['data'])))
        self.assertEqual((image.format, image.size), ('JPEG', (24, 14)))
        # Nothing in the latent: the colour of the bias alone, a grey.
        colour = image.convert('RGB').getpixel((12, 7))
        wanted = [round((value + 1) * 127.5) for value in bias]
        self.assertTrue(all(abs(seen - told) <= 3 for seen, told in zip(colour, wanted)), (colour, wanted))

    def test_the_frame_in_the_middle_is_read_finished_from_what_a_step_was_given_and_what_it_left(self):
        import torch

        from runner.pipelines import ltx25

        torch.manual_seed(3)
        # 25 frames at 96 x 64: four latent frames of 2 rows by 3 columns, then tokens that guide it from
        # another frame (an end image), which are not the video.
        frames, size, sigmas = 25, (96, 64), (1.0, 0.9, 0.5)
        clean, noise = torch.randn(1, 4 * 6 + 5, 128), torch.randn(1, 4 * 6 + 5, 128)
        at = lambda level: (1 - level) * clean + level * noise  # noqa: E731
        wanted = clean[0, 12:18].T.reshape(128, 2, 3)
        for index, following in enumerate((0.9, 0.5, 0.0)):
            found = ltx25.so_far(at(sigmas[index]).to(torch.bfloat16), at(following), sigmas, index, size, frames)
            self.assertEqual(tuple(found.shape), (128, 2, 3))
            # (What the step was given comes in the precision of the model: within its rounding.)
            self.assertLess(float((found - wanted).abs().max()), 0.2, index)
        exact = ltx25.so_far(at(0.5), at(0.0), sigmas, 2, size, frames)
        self.assertTrue(torch.allclose(exact, wanted, atol=1e-5))
        # One frame alone (an image): that frame.
        alone = ltx25.so_far(at(0.5)[:, :6], at(0.0)[:, :6], sigmas, 2, size, 1)
        self.assertTrue(torch.allclose(alone, clean[0, :6].T.reshape(128, 2, 3), atol=1e-5))
        # A sequence that does not hold that frame is said, for the generation to go on without its picture.
        with self.assertRaises(ValueError):
            ltx25.so_far(at(0.5)[:, :14], at(0.0)[:, :14], sigmas, 2, size, frames)
        sent = []
        tell = lambda **data: sent.append(data)  # noqa: E731
        with patch('sys.stderr', io.StringIO()) as errors:
            preview.send(tell, preview.LTX25, ltx25.so_far, None, at(0.0), sigmas, 2, size, frames)
        self.assertEqual(sent, [])
        self.assertIn('Preview skipped', errors.getvalue())
        preview.send(tell, preview.LTX25, ltx25.so_far, at(0.5), at(0.0), sigmas, 2, size, frames)
        self.assertEqual([list(data) for data in sent], [['preview']])

