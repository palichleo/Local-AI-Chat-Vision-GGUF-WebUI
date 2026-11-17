"""Upscale and interpolation pipelines end to end on CPU, with small random weights."""

import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

HAVE = all(importlib.util.find_spec(name) for name in ('torch', 'PIL', 'av', 'imageio_ffmpeg', 'safetensors'))


@unittest.skipUnless(
    all(importlib.util.find_spec(name) for name in ('numpy', 'imageio_ffmpeg')), 'numpy and imageio-ffmpeg are required'
)
class VideoWriterTests(unittest.TestCase):
    def test_a_sound_shorter_than_the_picture_costs_no_frame(self):
        """A video made by ComfyUI has a sound track a few milliseconds shorter than its picture."""
        import imageio_ffmpeg
        import numpy as np

        from runner.video.stream import VideoWriter

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            sound = root / 'sound.mp4'
            subprocess.run(
                [imageio_ffmpeg.get_ffmpeg_exe(), '-v', 'error', '-y', '-f', 'lavfi', '-i',
                 'testsrc=size=64x48:rate=24:duration=1', '-f', 'lavfi', '-i', 'sine=duration=1',
                 '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(sound)],
                check=True,
            )  # fmt: skip
            noise = np.random.default_rng(0)
            for name, audio in (('with-sound.mp4', sound), ('silent.mp4', None)):
                writer = VideoWriter(root / name, 320, 192, 24)
                for _ in range(41):
                    writer.write(noise.integers(0, 255, (192, 320, 3), dtype=np.uint8))
                writer.close(audio_from=audio)
                frames, seconds = imageio_ffmpeg.count_frames_and_secs(str(root / name))
                self.assertEqual(frames, 41, name)
                self.assertAlmostEqual(seconds, 41 / 24, delta=0.05)


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

    def run_job(self, family, media, component, weights, parameters, role, source, name=None):
        from runner.engine import generate

        job = dict(
            # The name the application asks for the file, when it gives one.
            **({} if name is None else dict(outputName=name)),
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
        descriptor = result['outputs'][0]
        return descriptor, self.output / descriptor['subfolder'] / descriptor['filename']

    def test_named_transforms_go_in_the_folder_of_their_kind(self):
        from PIL import Image

        from runner.video.stream import probe

        names = [f'2026-11-17_09-00-0{index}_transform_00a{index}' for index in range(3)]
        image, image_path = self.run_job(
            'realesrgan_image', 'image', 'upscaler', self.upscaler, {'tile': 16}, 'source_image', self.image, names[0]
        )
        video, video_path = self.run_job(
            'realesrgan_video', 'video', 'upscaler', self.upscaler, {}, 'source_video', self.video, names[1]
        )
        smooth, smooth_path = self.run_job(
            'rife', 'video', 'interpolator', self.interpolator, {'multiplier': 2}, 'source_video', self.video, names[2]
        )
        self.assertEqual(
            [(item['subfolder'], item['filename']) for item in (image, video, smooth)],
            [('image', names[0] + '.png'), ('video', names[1] + '.mp4'), ('video', names[2] + '.mp4')],
        )
        with Image.open(image_path) as upscaled:
            self.assertEqual(upscaled.size, (120, 80))
        self.assertEqual(probe(video_path)['frames'], 8)
        self.assertEqual(probe(smooth_path)['frames'], 15)
        # Nothing but them under the folder of the outputs: no temporary file is left beside, and
        # each manifest (no folder is named for them here) is beside the folders, as before.
        found = sorted(path.relative_to(self.output).as_posix() for path in self.output.rglob('*') if path.is_file())
        self.assertEqual(
            found,
            sorted(
                [f'image/{names[0]}.png', f'video/{names[1]}.mp4', f'video/{names[2]}.mp4']
                + [name + '.json' for name in names]
            ),
        )

    def test_a_named_transform_that_fails_leaves_nothing_in_the_folders(self):
        from unittest import mock

        # It stops between two frames, its video half written.
        with mock.patch('runner.models.rife.between', side_effect=RuntimeError('stopped')):
            with self.assertRaises(Exception):
                self.run_job(
                    'rife', 'video', 'interpolator', self.interpolator, {'multiplier': 2}, 'source_video', self.video,
                    '2026-11-17_09-00-09_transform_00a9',
                )  # fmt: skip
        for folder in ('image', 'video', 'son'):
            self.assertEqual(list((self.output / folder).glob('*')), [], folder)

    def test_a_video_stopped_half_way_leaves_no_temporary_file(self):
        import importlib
        import shutil
        from unittest import mock

        def stopping(target, error, after=2):
            """`target` as it is, until its call number `after` + 1 raises `error`."""
            module, name = target.rsplit('.', 1)
            real, calls = getattr(importlib.import_module(module), name), []

            def stop(*args, **kwargs):
                calls.append(1)
                if len(calls) > after:
                    raise error
                return real(*args, **kwargs)

            return mock.patch(target, side_effect=stop)

        cases = (
            ('rife', 'interpolator', self.interpolator, {'multiplier': 2}, 'runner.models.rife.between'),
            ('realesrgan_video', 'upscaler', self.upscaler, {}, 'runner.models.rrdbnet.upscale'),
        )
        for family, component, weights, parameters, target in cases:
            # By an error of the engine, then by a stop asked for while it works.
            for index, error in enumerate((RuntimeError('stopped'), KeyboardInterrupt())):
                source = Path(self.folder.name) / f'{family}-{index}.mp4'
                shutil.copyfile(self.video, source)
                name = f'2026-11-17_09-0{index}-00_{family.replace("_", "-")}_00a{index}'
                with stopping(target, error), self.assertRaises(type(error)) as caught:
                    self.run_job(family, 'video', component, weights, parameters, 'source_video', source, name)
                # The error that stopped it, not a refusal to delete a file the encoder still held.
                self.assertIs(caught.exception, error, family)
                # Frames were written before it stopped, and nothing of them is left: neither in the
                # folder of the outputs, where the temporary file was, nor in its folders.
                left = [path.relative_to(self.output).as_posix() for path in self.output.rglob('*') if path.is_file()]
                self.assertEqual(left, [], family)
                # The source was closed too: it can be removed at once (Windows refuses an open file).
                source.unlink()

    def test_a_generation_sweeps_the_old_temporary_files_of_a_killed_worker(self):
        import os
        import time

        self.output.mkdir()
        stale = self.output / '2026-11-16_22-10-00_rife_0f3c.tmp.mp4'
        recent = self.output / '2026-11-17_08-59-00_rife_1a2b.tmp.mp4'
        for path in (stale, recent):
            path.write_bytes(b'half a video')
        old = time.time() - 2 * 3600
        os.utime(stale, (old, old))
        self.run_job('realesrgan_image', 'image', 'upscaler', self.upscaler, {'tile': 16}, 'source_image', self.image)
        self.assertFalse(stale.exists())
        # One written a moment ago may be the creation of another worker: left alone.
        self.assertTrue(recent.exists())

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


class SweepTests(unittest.TestCase):
    """What a killed worker left in the folder of the outputs (runner.media.sweep)."""

    def test_old_temporary_files_of_the_engine_go_and_nothing_else(self):
        import os
        import time

        from runner.media import STALE_SECONDS, sweep

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'out'
            named, random = '2026-11-16_22-10-00_rife_0f3c', '0123456789abcdef0123456789abcdef'
            old = time.time() - STALE_SECONDS - 60

            def put(path, at=old):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'half a file')
                os.utime(path, (at, at))
                return path

            # Every temporary file the engine writes there, under a name of the application or a
            # random one (a creation without a name).
            endings = ('.tmp.mp4', '.tmp.wav', '.tmp.mux.mp4', '.mux.mp4', '.png.tmp', '.wav.tmp')
            stale = [put(root / (name + ending)) for name in (named, random) for ending in endings]
            kept = [
                # Written less than an hour ago: maybe a creation in progress.
                put(root / '2026-11-17_08-59-00_rife_1a2b.tmp.mp4', time.time() - STALE_SECONDS + 600),
                # Files of the user, old as they are: not the names of the engine.
                put(root / 'vacances.tmp.mp4'),
                put(root / 'Mon film.tmp.mp4'),
                put(root / 'notes.tmp'),
                put(root / (named + '.tmp.mov')),
                # Finished creations and their manifests, as before the folders of each kind.
                put(root / (random + '.mp4')),
                put(root / (random + '.png')),
                put(root / (random + '.json')),
                # Nothing of the three folders is looked at, whatever its name.
                put(root / 'video' / (named + '.tmp.mp4')),
                put(root / 'image' / (named + '.png.tmp')),
                put(root / 'son' / (named + '.wav.tmp')),
            ]
            # A folder named like a temporary file is no file.
            folder_named = root / '2026-11-15_10-00-00_rife_aaaa.tmp.mp4'
            put(folder_named / 'inside.mp4')
            os.utime(folder_named, (old, old))
            removed = sweep(dict(outputRoot=str(root)))
            self.assertEqual(sorted(removed), sorted(path.name for path in stale))
            self.assertEqual([path for path in stale if path.exists()], [])
            self.assertEqual([path for path in kept if not path.exists()], [])
            self.assertTrue((folder_named / 'inside.mp4').exists())
            # Nothing left to remove, and a folder of the outputs that does not exist yet is no error.
            self.assertEqual(sweep(dict(outputRoot=str(root))), [])
            self.assertEqual(sweep(dict(outputRoot=str(root / 'absent'))), [])


if __name__ == '__main__':
    unittest.main()
