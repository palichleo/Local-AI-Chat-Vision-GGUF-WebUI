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
