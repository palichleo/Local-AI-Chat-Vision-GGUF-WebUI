import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from runner.video import montage


def lavfi(target, *sources, extra=()):
    """A small real file made by ffmpeg for the test: a moving picture, a tone."""
    import imageio_ffmpeg

    command = [imageio_ffmpeg.get_ffmpeg_exe(), '-nostdin', '-v', 'error', '-y']
    for source in sources:
        command += ['-f', 'lavfi', '-i', source]
    subprocess.run([*command, *extra, str(target)], check=True, capture_output=True)
    return str(target)


class Folder(unittest.TestCase):
    """A folder of outputs with a silent clip at 16 frames a second (as Wan 2.2 makes them), a
    clip at 24 with its sound (as LTX 2.5), a red square image and a music."""

    @classmethod
    def setUpClass(cls):
        from PIL import Image

        cls.held = tempfile.TemporaryDirectory()
        cls.root = Path(cls.held.name).resolve() / 'output'
        (cls.root / 'video').mkdir(parents=True)
        (cls.root / 'image').mkdir()
        (cls.root / 'son').mkdir()
        encode = ('-c:v', 'libx264', '-pix_fmt', 'yuv420p')
        blue = 'color=c=blue:size=320x180:rate=16:duration=2'
        cls.silent = lavfi(cls.root / 'video' / 'silent.mp4', blue, extra=encode)
        cls.heard = lavfi(
            cls.root / 'video' / 'heard.mp4',
            'color=c=green:size=256x256:rate=24:duration=2',
            'sine=frequency=440:duration=2',
            extra=(*encode, '-c:a', 'aac'),
        )
        cls.image = str(cls.root / 'image' / 'red.png')
        Image.new('RGB', (100, 100), (255, 0, 0)).save(cls.image)
        cls.music = lavfi(cls.root / 'son' / 'music.wav', 'sine=frequency=220:duration=10')
        beside = cls.root.parent
        cls.config = dict(outputRoot=str(cls.root), manifestRoot=str(beside / 'manifests'), cacheRoot=str(beside))

    @classmethod
    def tearDownClass(cls):
        cls.held.cleanup()

    def asked(self, **changes):
        plans = [
            dict(path=self.silent, kind='video', **{'from': 0, 'to': 1.5}, frame='fit', volume=1),
            dict(path=self.heard, kind='video', **{'from': 0.5, 'to': 1.5}, frame='fill', volume=0.5),
            dict(path=self.image, kind='image', **{'from': 0, 'to': 1}, frame='fit', volume=1),
        ]
        sounds = [dict(path=self.music, at=0.5, **{'from': 0, 'to': 10}, volume=0.3)]
        return dict(dict(id='film-1', width=320, height=180, fps=24, plans=plans, sounds=sounds), **changes)


class RuleTests(Folder):
    def test_what_is_asked_is_checked_and_every_file_is_one_of_the_outputs(self):
        plan = montage.validated(self.asked(), self.root)
        self.assertEqual(montage.seconds(plan), 3.5)
        self.assertEqual([item['kind'] for item in plan['plans']], ['video', 'video', 'image'])
        first = self.asked()['plans'][0]
        outside = Path(self.held.name) / 'elsewhere.mp4'
        outside.write_bytes(Path(self.silent).read_bytes())
        for wrong, said in (
            (dict(plans=[]), '1 to 200 plans'),
            (dict(width=321), 'film width'),
            (dict(height=64), 'film height'),
            (dict(fps=0), 'film rate'),
            (dict(plans=[dict(first, path=str(outside))]), 'only a creation of the outputs'),
            (dict(plans=[dict(first, path=str(self.root / 'video' / 'gone.mp4'))]), 'n’existe plus'),
            (dict(plans=[dict(first, path=self.image)]), 'not a file of that kind'),
            (dict(plans=[dict(first, kind='image')]), 'not a file of that kind'),
            (dict(plans=[dict(first, **{'to': 0.05})]), 'invalid length'),
            (dict(plans=[dict(first, frame='stretch')]), 'invalid kind or frame'),
            (dict(plans=[dict(first, volume=3)]), 'invalid volume'),
            (dict(plans=[dict(first, extra=1)]), 'Invalid Plan 1 fields'),
            (dict(sounds=[dict(self.asked()['sounds'][0], path=self.image)]), 'not a file of that kind'),
            (dict(sounds=[dict(self.asked()['sounds'][0], at=-1)]), 'invalid time'),
            (dict(outputName='../x'), 'Invalid output name'),
        ):
            with self.assertRaisesRegex(ValueError, said, msg=said):
                montage.validated(self.asked(**wrong), self.root)

    def test_each_plan_is_cut_sized_and_given_exactly_its_length_then_joined_and_mixed(self):
        plan = montage.validated(self.asked(), self.root)
        inputs, filters, sound, total = montage.graph(plan, [False, True, False])
        self.assertEqual((sound, total), ('[sound]', 3.5))
        self.assertEqual(inputs.count('-i'), 4)
        # An image is shown for its length; the videos are read as they are.
        self.assertEqual(inputs[4:8], ['-loop', '1', '-t', '1'])
        parts = filters.split(';')
        # Whole, with black on two sides; then filling the picture, what overflows cut.
        cut = '[0:v]trim=start=0:end=1.5,setpts=PTS-STARTPTS,scale=320:180:force_original_aspect_ratio=decrease'
        self.assertIn(cut, parts[0])
        held = 'pad=320:180:(ow-iw)/2:(oh-ih)/2:black,fps=24,tpad=stop_mode=clone:stop_duration=1.5,trim=duration=1.5'
        self.assertIn(held, parts[0])
        self.assertIn('scale=320:180:force_original_aspect_ratio=increase,crop=320:180,fps=24', parts[2])
        # A clip without a sound of its own is silent for its length; the other keeps its sound, lowered.
        self.assertEqual(parts[1], 'anullsrc=r=48000:cl=stereo,atrim=duration=1.5[a0]')
        self.assertIn('[1:a]atrim=start=0.5:end=1.5,asetpts=PTS-STARTPTS,volume=0.5,', parts[3])
        self.assertTrue(parts[3].endswith('apad,atrim=duration=1[a1]'))
        self.assertTrue(parts[4].startswith('[2:v]scale='), 'an image is not cut in time')
        self.assertEqual(parts[6], '[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[film][clips]')
        # The music starts half a second in, and stops with the film: 3 s of its 10.
        self.assertIn('[3:a]atrim=start=0:end=3,asetpts=PTS-STARTPTS,volume=0.3,', parts[7])
        self.assertTrue(parts[7].endswith('adelay=500:all=1[s0]'))
        self.assertEqual(parts[8], '[clips][s0]amix=inputs=2:duration=first:normalize=0[sound]')
        # Without a sound laid under it, the film has the sound of its clips; one laid after its end
        # is left out.
        late = dict(self.asked()['sounds'][0], at=3.5)
        for sounds in ([], [late]):
            plan = montage.validated(self.asked(sounds=sounds), self.root)
            inputs, filters, sound, _ = montage.graph(plan, [False, True, False])
            self.assertEqual((sound, inputs.count('-i'), 'amix' in filters), ('[clips]', 3, False))
        # A clip whose own sound is turned off is silent.
        muted = self.asked()
        muted['plans'][1]['volume'] = 0
        graph = montage.graph(montage.validated(muted, self.root), [False, True, False])[1]
        self.assertIn('anullsrc=r=48000:cl=stereo,atrim=duration=1[a1]', graph)


class FilmTests(Folder):
    def test_the_film_is_one_file_of_the_outputs_with_its_manifest_at_its_size_rate_and_length(self):
        import imageio.v3 as iio

        from runner.video.stream import probe

        told = []
        asked = self.asked(outputName='2026-11-20_03-00-00_montage_ab12')
        result = montage.assemble(asked, self.config, lambda **data: told.append(data))
        (descriptor,) = result['outputs']
        named = dict(filename='2026-11-20_03-00-00_montage_ab12.mp4', subfolder='video', type='output')
        self.assertEqual(descriptor, named | dict(width=320, height=180))
        film = self.root / 'video' / descriptor['filename']
        found = probe(film)
        self.assertEqual((found['width'], found['height'], float(found['fps']), found['audio']), (320, 180, 24.0, True))
        frames = iio.imread(film)
        self.assertEqual(len(frames), 84, '3.5 s at 24 frames a second')
        self.assertEqual(result['metadata'] | dict(seconds=0), dict(
            backend='atelier-montage', seconds=0, film_seconds=3.5, frames=84, fps=24, plans=3, sounds=1, audio=True,
        ))
        colour = lambda index, x: frames[index][90, x].astype(int).tolist()  # noqa: E731
        near = lambda found, wanted: all(abs(a - b) < 60 for a, b in zip(found, wanted))  # noqa: E731
        # Plan 1 (blue, 16 frames a second brought to 24) for 1.5 s, plan 2 (green, filling) for 1 s,
        # then the red square whole in the middle with black on both sides.
        self.assertTrue(near(colour(10, 160), (0, 0, 255)), colour(10, 160))
        self.assertTrue(near(colour(48, 160), (0, 128, 0)), colour(48, 160))
        self.assertTrue(near(colour(48, 5), (0, 128, 0)), 'the square clip fills the picture')
        self.assertTrue(near(colour(75, 160), (255, 0, 0)), colour(75, 160))
        self.assertTrue(near(colour(75, 5), (0, 0, 0)), 'the image is whole, black beside it')
        # Its manifest is where the manifests go, and nothing else is left in the outputs.
        manifest = json.loads((self.root.parent / 'manifests' / (film.stem + '.json')).read_text(encoding='utf-8'))
        self.assertEqual((manifest['jobId'], manifest['outputs']), ('film-1', [descriptor]))
        kept = sorted(path.name for path in (self.root / 'video').iterdir())
        self.assertEqual(kept, sorted(['silent.mp4', 'heard.mp4', film.name]))
        self.assertEqual(told[-1], dict(stage='film assembled', seconds=3.5, total=3.5))
        # The takes it is made of are as they were.
        self.assertEqual(probe(self.silent)['frames'], 32)

    def test_a_plan_asked_longer_than_its_clip_holds_its_last_picture_and_a_sound_must_be_one(self):
        import imageio.v3 as iio

        longer = self.asked(sounds=[])
        longer['plans'] = [dict(longer['plans'][0], **{'to': 3}), longer['plans'][2]]
        result = montage.assemble(longer, self.config, lambda **data: None)
        frames = iio.imread(self.root / result['outputs'][0]['filename'])
        # (Without a name from the application: a random one, in the folder of the outputs itself.)
        self.assertEqual(result['outputs'][0]['subfolder'], '')
        self.assertEqual(len(frames), 96, '3 s of the clip of 2 s, then 1 s of the image')
        self.assertGreater(int(frames[70][90, 160][2]), 180, 'still the blue of the clip after its end')
        with self.assertRaisesRegex(ValueError, 'Son 1 : ce fichier n’a pas de son'):
            mute = dict(self.asked()['sounds'][0], path=self.silent)
            montage.assemble(self.asked(sounds=[mute]), self.config, lambda **data: None)
        # What fails leaves nothing half-written in the outputs: here the film is assembled, and its
        # manifest cannot be written.
        from unittest import mock

        with mock.patch('runner.media.publish', side_effect=OSError('disk full')):
            with self.assertRaisesRegex(OSError, 'disk full'):
                montage.assemble(self.asked(sounds=[]), self.config, lambda **data: None)
        self.assertFalse([path.name for path in self.root.rglob('*.tmp.mp4')])

    def test_the_worker_assembles_a_film_asked_over_its_protocol(self):
        import sys

        config = Path(self.held.name) / 'config.json'
        config.write_text(json.dumps(self.config), encoding='utf-8')
        code = 'import sys;sys.path.insert(0,sys.argv.pop(1));from runner.__main__ import main;main()'
        requests = [
            dict(id='m', method='assemble', params=self.asked(id='film-2')),
            dict(id='n', method='assemble', params={}),
            dict(id='z', method='shutdown', params={}),
        ]
        done = subprocess.run(
            [sys.executable, '-c', code, str(Path.cwd()), '--config', str(config)],
            input=''.join(json.dumps(request) + chr(10) for request in requests),
            text=True,
            capture_output=True,
            timeout=90,
        )
        self.assertEqual(done.returncode, 0, done.stderr[-800:])
        rows = [json.loads(line) for line in done.stdout.splitlines()]
        answer = next(row for row in rows if row.get('id') == 'm' and 'result' in row)
        self.assertEqual((answer['result']['jobId'], answer['result']['metadata']['frames']), ('film-2', 84))
        told = [row['data'].get('stage') for row in rows if row.get('event') == 'progress' and row.get('id') == 'm']
        self.assertEqual(told[-1], 'film assembled')
        # A request that says nothing of the film is refused, and the worker goes on.
        refused = next(row for row in rows if row.get('id') == 'n')
        self.assertIn('Invalid film fields', refused['error']['message'])
        self.assertTrue(any(row.get('id') == 'z' for row in rows))

    def test_the_engine_takes_the_request_as_it_takes_a_creation(self):
        from runner import engine

        result = engine.assemble(self.asked(sounds=[]), self.config, lambda **data: None)
        self.assertEqual(result['jobId'], 'film-1')
        with self.assertRaisesRegex(ValueError, 'worker configuration'):
            engine.assemble(self.asked(), dict(self.config, elsewhere=1), lambda **data: None)


if __name__ == '__main__':
    unittest.main()
