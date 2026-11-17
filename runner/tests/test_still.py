import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

from runner.video import still

ROOT = Path(__file__).resolve().parents[2]


def write_video(path, count=10, fps=24, size=(64, 96), codec='mpeg4'):
    """A clip whose frames grow brighter, from black to white: each one is told by its brightness."""
    import av

    with av.open(str(path), 'w') as target:
        stream = target.add_stream(codec, rate=fps)
        stream.height, stream.width = size
        stream.pix_fmt = 'yuv420p'
        for index in range(count):
            pixels = np.full((size[0], size[1], 3), round(255 * index / (count - 1)), dtype=np.uint8)
            for packet in stream.encode(av.VideoFrame.from_ndarray(pixels, format='rgb24')):
                target.mux(packet)
        for packet in stream.encode():
            target.mux(packet)


def brightness(path):
    from PIL import Image

    with Image.open(path) as image:
        return np.asarray(image.convert('L')).mean()


def shape(path):
    """(width, height) and format of an image file."""
    from PIL import Image

    with Image.open(path) as image:
        return image.size, image.format


class StillTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        self.video = self.root / 'clip.mp4'
        write_video(self.video)

    def tearDown(self):
        self.folder.cleanup()

    def test_the_last_and_the_first_pictures_are_the_video_s_own(self):
        last, first = self.root / 'last.png', self.root / 'first.png'
        result = still.extract(self.video, 'last', last)
        self.assertEqual((result['width'], result['height']), (96, 64))
        # The tenth of ten frames at 24 a second, not one « near the end ».
        self.assertAlmostEqual(result['time'], 9 / 24, places=3)
        self.assertEqual(shape(last), ((96, 64), 'PNG'))
        self.assertGreater(brightness(last), 245)
        self.assertEqual(still.extract(self.video, 'first', first)['time'], 0)
        self.assertLess(brightness(first), 10)
        # The frame before the last one is told from it: the last is the brightest of all.
        import av

        with av.open(str(self.video)) as source:
            levels = [np.asarray(frame.to_image().convert('L')).mean() for frame in source.decode(video=0)]
        self.assertEqual(len(levels), 10)
        self.assertAlmostEqual(brightness(last), levels[-1], places=3)
        self.assertGreater(levels[-1] - levels[-2], 10)

    def test_a_clip_longer_than_the_first_look_back_still_gives_its_last_picture(self):
        long = self.root / 'long.mp4'
        write_video(long, count=120)
        image, time = still.still(long, 'last')
        self.assertAlmostEqual(time, 119 / 24, places=3)
        self.assertGreater(np.asarray(image.convert('L')).mean(), 245)

    def test_a_small_copy_is_written_beside_and_nothing_is_left_half_written(self):
        wide = self.root / 'wide.mp4'
        write_video(wide, count=4, size=(128, 256))
        output, preview = self.root / 'last.png', self.root / 'small.jpg'
        still.extract(wide, 'last', output, preview, side=64)
        self.assertEqual(shape(output), ((256, 128), 'PNG'))
        self.assertEqual(shape(preview), ((64, 32), 'JPEG'))
        self.assertEqual(sorted(path.name for path in self.root.iterdir() if path.suffix == '.tmp'), [])

    def test_what_is_not_a_video_is_refused(self):
        text = self.root / 'notes.mp4'
        text.write_bytes(b'not a video')
        image = self.root / 'picture.png'
        image.write_bytes(b'not a video')
        for wrong in (text, image, self.root / 'missing.mp4'):
            with self.subTest(path=wrong.name), self.assertRaises(Exception):
                still.still(wrong, 'last')
        with self.assertRaises(ValueError):
            still.still(self.video, 'middle')

    def test_the_command_runs_apart_from_the_worker_without_loading_a_model(self):
        output = self.root / 'last.png'
        # The modules loaded are listed once the command has run, in the same process.
        code = (
            'import json,runpy,sys\n'
            'try:\n'
            "    runpy.run_module('runner', run_name='__main__')\n"
            'except SystemExit as stop:\n'
            '    code = stop.code\n'
            "models = ('torch', 'diffusers', 'transformers', 'runner.engine')\n"
            'heavy = [name for name in models if name in sys.modules]\n'
            'print(json.dumps(dict(code=code, heavy=heavy)), file=sys.stderr)\n'
        )
        command = ['frame', '--input', str(self.video), '--at', 'last', '--output', str(output)]
        done = subprocess.run([sys.executable, '-s', '-c', code, *command], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(json.loads(done.stderr.splitlines()[-1]), dict(code=0, heavy=[]), done.stderr)
        self.assertEqual(json.loads(done.stdout)['width'], 96)
        self.assertGreater(brightness(output), 245)
        failed = subprocess.run(
            [sys.executable, '-s', '-m', 'runner', 'frame', '--input', str(self.root / 'missing.mp4'), '--at', 'last']
            + ['--output', str(output)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding='utf-8',
            env={**os.environ, 'PYTHONIOENCODING': 'utf-8'},
        )
        self.assertEqual(failed.returncode, 1)
        self.assertIn('vidéo', failed.stderr)


if __name__ == '__main__':
    unittest.main()
