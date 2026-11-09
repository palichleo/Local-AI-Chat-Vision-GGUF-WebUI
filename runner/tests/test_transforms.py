"""Upscale and interpolation pipelines end to end on CPU, with small random weights."""

import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

HAVE = all(importlib.util.find_spec(name) for name in ('torch', 'PIL', 'av', 'imageio_ffmpeg', 'safetensors'))


@unittest.skipUnless(HAVE, 'torch, Pillow, PyAV and imageio-ffmpeg are required')
class TransformTests(unittest.TestCase):
    def setUp(self):
        import imageio_ffmpeg
        import numpy as np
        from PIL import Image
        from safetensors.torch import save_file

        from runner.models.rife import IFNet
        from runner.models.rrdbnet import RRDBNet

        self.folder = tempfile.TemporaryDirectory()
        root = Path(self.folder.name)
        self.output = root / 'out'
        self.config = dict(tokenizerPath=str(root), cacheRoot=str(root), outputRoot=str(self.output))
        self.upscaler = root / 'tiny-x2.safetensors'
        save_file(RRDBNet(2, features=8, blocks=1, growth=4).state_dict(), str(self.upscaler))
        self.interpolator = root / 'rife.safetensors'
        save_file(IFNet(features=4).state_dict(), str(self.interpolator))
        self.image = root / 'source.png'
        Image.fromarray(np.full((40, 60, 3), 128, np.uint8)).save(self.image)
        self.video = root / 'source.mp4'
        subprocess.run(
            [imageio_ffmpeg.get_ffmpeg_exe(), '-v', 'error', '-y', '-f', 'lavfi', '-i',
             'testsrc=size=64x48:rate=8:duration=1', '-f', 'lavfi', '-i', 'sine=duration=1',
             '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(self.video)],
            check=True,
        )  # fmt: skip

    def tearDown(self):
        self.folder.cleanup()

    def run_job(self, family, media, component, weights, parameters, role, source):
        from runner.engine import generate

        job = dict(
            schemaVersion=1,
            id='job',
            pipeline=family,
            mediaType=media,
            workflowId='wf',
            workflowDigest='a' * 64,
            parameters=parameters,
            components={component: str(weights)},
            loras=[],
            references=[dict(input='source', role=role, path=str(source))],
        )
        result = generate(job, self.config, lambda **_: None)
        return result['outputs'][0], self.output / result['outputs'][0]['filename']

    def test_image_upscale_doubles_and_respects_the_maximum_side(self):
        from PIL import Image

        descriptor, path = self.run_job(
            'realesrgan_image', 'image', 'upscaler', self.upscaler, {'tile': 16}, 'source_image', self.image
        )
        self.assertEqual(Image.open(path).size, (120, 80))
        self.assertEqual((descriptor['width'], descriptor['height']), (120, 80))
        _, path = self.run_job(
            'realesrgan_image', 'image', 'upscaler', self.upscaler, {'max_side': 90}, 'source_image', self.image
        )
        self.assertEqual(Image.open(path).size, (90, 60))

    def test_video_upscale_keeps_frames_rate_and_sound(self):
        from runner.video.stream import probe

        _, path = self.run_job('realesrgan_video', 'video', 'upscaler', self.upscaler, {}, 'source_video', self.video)
        info = probe(path)
        self.assertEqual((info['width'], info['height'], info['frames'], float(info['fps'])), (128, 96, 8, 8.0))
        self.assertTrue(info['audio'])

    def test_interpolation_smooth_and_slow_motion(self):
        from runner.video.stream import probe

        _, path = self.run_job(
            'rife', 'video', 'interpolator', self.interpolator, {'multiplier': 2}, 'source_video', self.video
        )
        info = probe(path)
        self.assertEqual((info['frames'], float(info['fps']), info['audio']), (15, 16.0, True))
        _, path = self.run_job(
            'rife', 'video', 'interpolator', self.interpolator,
            {'multiplier': 3, 'mode': 'slow_motion'}, 'source_video', self.video,
        )  # fmt: skip
        info = probe(path)
        self.assertEqual((info['frames'], float(info['fps']), info['audio']), (22, 8.0, False))

    def test_wrong_checkpoints_fail_before_any_work(self):
        from runner.engine import preflight

        job = dict(
            schemaVersion=1,
            id='job',
            pipeline='realesrgan_image',
            mediaType='image',
            workflowId='wf',
            workflowDigest='a' * 64,
            parameters={},
            components={'upscaler': str(self.interpolator)},
            loras=[],
            references=[dict(input='source', role='source_image', path=str(self.image))],
        )
        with self.assertRaisesRegex(ValueError, 'Real-ESRGAN'):
            preflight(job, self.config)


if __name__ == '__main__':
    unittest.main()
