import base64
import io
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from runner import engine
from runner.video import frames


def write_video(path, count=48, fps=24, size=(64, 96)):
    """A clip whose frames grow brighter: the time of a picture shows in its brightness."""
    import imageio.v3 as iio

    pictures = np.zeros((count, size[0], size[1], 3), dtype=np.uint8)
    for index in range(count):
        pictures[index] = int(255 * index / (count - 1))
    iio.imwrite(path, pictures, fps=fps, codec='libx264', macro_block_size=None)


def brightness(url):
    from PIL import Image

    data = base64.b64decode(url.split(',', 1)[1])
    return np.asarray(Image.open(io.BytesIO(data)).convert('L')).mean()


class FramesTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        self.video = self.root / 'clip.mp4'
        write_video(self.video)
        self.config = dict(outputRoot=str(self.root), cacheRoot=str(self.root / 'cache'))

    def tearDown(self):
        self.folder.cleanup()

    def test_pictures_are_taken_near_the_start_the_middle_and_the_end(self):
        self.assertEqual(frames.times(2.0, 3), [0.06, 1.0, 1.94])
        self.assertEqual(frames.times(2.0, 1), [1.0])
        self.assertEqual(frames.times(4.0, 4), [0.5, 1.5, 2.5, 3.5])
        found = frames.sample(self.video, 3, 64)
        self.assertEqual(len(found), 3)
        times = [item['time'] for item in found]
        self.assertEqual(times, sorted(times))
        self.assertLess(times[0], 0.2)
        self.assertGreater(times[-1], 1.7)
        # What happens in the clip, not three copies of its first frame.
        light = [brightness(item['url']) for item in found]
        self.assertLess(light[0], 40)
        self.assertGreater(light[-1], 200)
        self.assertTrue(all(item['url'].startswith('data:image/jpeg;base64,') for item in found))

    def test_pictures_are_small(self):
        from PIL import Image

        found = frames.sample(self.video, 1, 64)
        data = base64.b64decode(found[0]['url'].split(',', 1)[1])
        self.assertLessEqual(max(Image.open(io.BytesIO(data)).size), 64)

    def test_only_a_video_of_the_outputs_is_read(self):
        result = engine.frames(dict(path=str(self.video), count=2, side=64), self.config)
        self.assertEqual(len(result['frames']), 2)
        with tempfile.TemporaryDirectory() as elsewhere:
            outside = Path(elsewhere) / 'clip.mp4'
            write_video(outside, count=6)
            with self.assertRaisesRegex(ValueError, 'outputs'):
                engine.frames(dict(path=str(outside)), self.config)
        for wrong in (dict(path=''), dict(path=str(self.video), count=0), dict(path=str(self.video), side=8)):
            with self.assertRaises(ValueError):
                engine.frames(wrong, self.config)
        image = self.root / 'picture.png'
        image.write_bytes(b'not a video')
        with self.assertRaisesRegex(ValueError, 'Not a video'):
            engine.frames(dict(path=str(image)), self.config)

    def test_the_worker_answers_a_frames_request(self):
        from runner.protocol import serve

        request = json.dumps(dict(id=1, method='frames', params=dict(path=str(self.video), count=1, side=64)))
        source, destination = io.StringIO(request + '\n'), io.StringIO()
        serve(self.config, source, destination)
        lines = [json.loads(line) for line in destination.getvalue().splitlines()]
        answer = next(line for line in lines if line.get('id') == 1)
        self.assertEqual(len(answer['result']['frames']), 1)


if __name__ == '__main__':
    unittest.main()
