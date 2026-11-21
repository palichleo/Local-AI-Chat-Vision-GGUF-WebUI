import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from runner.video import montage

# (0.6.154) The name of the temporary file of a take exported alone.
NAMED = dict(outputName='2026-11-20_03-00-00_bobine_ab12')


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
            # (0.6.154) A take exported alone: a numbered file of the folder of its bobine, under `bobines`.
            (dict(exportTo='bobines/Le renard/01.mp4'), 'An export names its temporary file'),
            (dict(**NAMED, exportTo='video/01.mp4'), 'Invalid export place'),
            (dict(**NAMED, exportTo='Bobines/Fin/01.mp4'), 'Invalid export place'),
            (dict(**NAMED, exportTo='bobines/../01.mp4'), 'Invalid export place'),
            (dict(**NAMED, exportTo='bobines/a?b/01.mp4'), 'Invalid export place'),
            (dict(**NAMED, exportTo='bobines/Fin./01.mp4'), 'Invalid export place'),
            (dict(**NAMED, exportTo='bobines/ Fin/01.mp4'), 'Invalid export place'),
            (dict(**NAMED, exportTo='bobines/Fin/1.mp4'), 'Invalid export place'),
            (dict(**NAMED, exportTo='bobines/Fin/01.mov'), 'Invalid export place'),
            (dict(**NAMED, exportTo='bobines/Le/renard/01.mp4'), 'Invalid export place'),
            (dict(**NAMED, exportTo=1), 'Invalid export place'),
        ):
            with self.assertRaisesRegex(ValueError, said, msg=said):
                montage.validated(self.asked(**wrong), self.root)
        place = montage.validated(self.asked(**NAMED, exportTo='bobines/Le renard/01.mp4'), self.root)
        self.assertEqual(place['exportTo'], self.root / 'bobines' / 'Le renard' / '01.mp4')

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

    def test_a_hole_before_a_plan_is_black_and_silent_as_long_as_it_is(self):
        # (0.6.149, La Bobine) The first plan at 0.5 s, the second at 3 s: a hole of half a second before
        # the first and one of a second after it (it ends at 2 s); the image, without an instant, follows.
        asked = self.asked(sounds=[])
        asked['plans'][0]['at'] = 0.5
        asked['plans'][1]['at'] = 3
        plan = montage.validated(asked, self.root)
        self.assertEqual([item['at'] for item in plan['plans']], [0.5, 3, 4])
        self.assertEqual((montage.seconds(plan), montage.holes(plan)), (5, [(0, 0.5), (1, 1)]))
        inputs, filters, sound, total = montage.graph(plan, [False, True, False])
        parts = filters.split(';')
        self.assertEqual(parts[0], 'color=c=black:s=320x180:r=24:d=0.5,setsar=1,format=yuv420p[g0]')
        self.assertEqual(parts[1], 'anullsrc=r=48000:cl=stereo,atrim=duration=0.5[h0]')
        self.assertIn('color=c=black:s=320x180:r=24:d=1,setsar=1,format=yuv420p[g1]', parts)
        self.assertEqual(parts[-1], '[g0][h0][v0][a0][g1][h1][v1][a1][v2][a2]concat=n=5:v=1:a=1[film][clips]')
        # (A hole is made in the graph: no file is read for it.)
        self.assertEqual((sound, total, inputs.count('-i')), ('[clips]', 5, 3))
        # Without instants the plans follow one another, as before; one over the plan before it is refused.
        self.assertEqual(montage.holes(montage.validated(self.asked(), self.root)), [])
        asked['plans'][1]['at'] = 1.9
        with self.assertRaisesRegex(ValueError, 'Plan 2: starts before the end of the plan before it'):
            montage.validated(asked, self.root)
        asked['plans'][1]['at'] = -1
        with self.assertRaisesRegex(ValueError, 'invalid time'):
            montage.validated(asked, self.root)


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

    def test_a_hole_is_black_and_silent_in_the_film(self):
        import av
        import imageio.v3 as iio
        import numpy as np

        # (0.6.149) A clip of a second with its sound, a hole of a second, the same clip again.
        asked = self.asked(sounds=[])
        heard = dict(path=self.heard, kind='video', **{'from': 0, 'to': 1}, frame='fill', volume=1)
        asked['plans'] = [dict(heard, at=0), dict(heard, at=2)]
        result = montage.assemble(asked, self.config, lambda **data: None)
        film = self.root / result['outputs'][0]['filename']
        frames = iio.imread(film)
        self.assertEqual(len(frames), 72, '1 s, a hole of 1 s, 1 s, at 24 frames a second')
        self.assertEqual(result['metadata']['film_seconds'], 3)
        colour = lambda index: frames[index][90, 160].astype(int).tolist()  # noqa: E731
        self.assertTrue(all(abs(a - b) < 60 for a, b in zip(colour(12), (0, 128, 0))), colour(12))
        self.assertTrue(max(colour(36)) < 30, 'black in the hole: ' + str(colour(36)))
        self.assertTrue(all(abs(a - b) < 60 for a, b in zip(colour(60), (0, 128, 0))), colour(60))
        with av.open(str(film)) as source:
            rate = source.streams.audio[0].rate
            samples = np.concatenate([frame.to_ndarray()[0] for frame in source.decode(audio=0)])
        loud = lambda a, b: float(np.sqrt(np.mean(samples[int(a * rate) : int(b * rate)] ** 2)))  # noqa: E731
        self.assertGreater(loud(0.2, 0.8), 0.05, 'the sound of the clip')
        self.assertLess(loud(1.2, 1.8), 0.005, 'silent in the hole')
        self.assertGreater(loud(2.2, 2.8), 0.05, 'the sound of the clip after the hole')

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

    def test_a_take_exported_alone_is_a_file_of_the_folder_of_its_bobine_never_written_over(self):
        import imageio.v3 as iio

        # (0.6.154) « Un fichier par prise »: the clip filling the picture, a second of it, in BOBINES.
        heard = dict(path=self.heard, kind='video', **{'from': 0.5, 'to': 1.5}, frame='fill', volume=1)
        asked = self.asked(plans=[dict(heard, at=0)], sounds=[], outputName='2026-11-20_03-00-00_bobine_cd34')
        asked['exportTo'] = 'bobines/Le renard en hiver/01.mp4'
        made = sorted(path.name for path in (self.root / 'video').iterdir())
        manifests = self.root.parent / 'manifests'
        before = sorted(path.name for path in manifests.iterdir()) if manifests.exists() else []
        result = montage.assemble(asked, self.config, lambda **data: None)
        (descriptor,) = result['outputs']
        wanted = dict(filename='01.mp4', subfolder='bobines/Le renard en hiver', type='export', width=320, height=180)
        self.assertEqual(descriptor, wanted)
        file = self.root / 'bobines' / 'Le renard en hiver' / '01.mp4'
        self.assertEqual(len(iio.imread(file)), 24, 'a second at 24 frames a second')
        # Not a creation: nothing in VIDEO, no manifest, nothing left in the outputs.
        self.assertEqual(sorted(path.name for path in (self.root / 'video').iterdir()), made)
        after = sorted(path.name for path in manifests.iterdir()) if manifests.exists() else []
        self.assertEqual(after, before)
        self.assertFalse([path.name for path in self.root.glob('*.tmp.mp4')])
        # Never written over: asked again, refused before anything is made, the file as it was.
        size = file.stat().st_size
        with self.assertRaisesRegex(ValueError, 'Ce fichier existe déjà'):
            montage.validated(asked, self.root)
        with self.assertRaisesRegex(ValueError, 'Ce fichier existe déjà'):
            montage.assemble(asked, self.config, lambda **data: None)
        self.assertEqual(file.stat().st_size, size)

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


class WatermarkTests(Folder):
    """(0.6.187) The watermark of what goes out of Moodix (watermark-maquette.md)."""

    def test_the_pictures_of_the_watermarks_are_those_the_places_are_counted_from(self):
        import numpy as np
        from PIL import Image

        # (0.6.187) Each picture as its table says it: its size, and its drawing (ivory) within it.
        for name, sizes in montage.WATERMARKS.items():
            for made, (wide, high, box) in sizes.items():
                path = montage.WATERMARK_FOLDER / f'moodix-watermark-{name}-{made}.png'
                pixels = np.asarray(Image.open(path).convert('RGBA')).astype(int)
                self.assertEqual(pixels.shape[:2], (high, wide), path.name)
                ys, xs = np.nonzero((pixels[..., 3] > 20) & (pixels[..., 0] > 120))
                self.assertEqual((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1), box, path.name)
                # Ivory at 85 %, nothing more opaque.
                self.assertEqual(pixels[..., 3].max(), 217, path.name)

    def test_the_watermark_is_4_percent_of_the_short_side_from_the_corner_or_where_tiktok_covers_nothing(self):
        # 1920 × 1080: the file made for 1080 as it is, its drawing (45 → 124) 43.2 px from the edges.
        path, wide, high, x, y = montage.watermark_place('eclipse', 1920, 1080)
        self.assertTrue(path.endswith('moodix-watermark-eclipse-1080.png'))
        self.assertEqual((wide, high), (169, 169))
        self.assertEqual((x + 124, y + 124), (round(1920 - 43.2), round(1080 - 43.2)))
        # 1920 × 1088 (the largest film of the Bobine): the one made for 2160, brought to 1088 / 2160.
        path, wide, high, x, y = montage.watermark_place('eclipse-nom', 1920, 1088)
        ratio = 1088 / 2160
        self.assertTrue(path.endswith('moodix-watermark-eclipse-nom-2160.png'))
        self.assertEqual((wide, high), (round(619 * ratio), round(272 * ratio)))
        self.assertAlmostEqual(x + 534 * ratio, 1920 - 0.04 * 1088, delta=0.5)
        self.assertAlmostEqual(y + 176 * ratio, 1088 - 0.04 * 1088, delta=0.5)
        # A small square film: smaller still, from the corner all the same.
        path, wide, high, x, y = montage.watermark_place('eclipse', 512, 512)
        self.assertEqual((wide, high), (round(336 * 512 / 2160),) * 2)
        self.assertAlmostEqual(x + 247 * 512 / 2160, 512 - 0.04 * 512, delta=0.5)
        # 9:16 (and the 448 × 768 of MiniMax, within 4 % of it): at the top left, in the zone TikTok
        # leaves free, at 150/1080 of the width and 270/1920 of the height.
        for width, height in ((1088, 1920), (576, 1024), (448, 768)):
            path, wide, high, x, y = montage.watermark_place('eclipse-nom', width, height)
            ratio = width / (1080 if width == 1080 else 2160)
            made = 1080 if width == 1080 else 2160
            left, top = montage.WATERMARKS['eclipse-nom'][made][2][:2]
            self.assertAlmostEqual(x + left * ratio, width * 150 / 1080, delta=0.5)
            self.assertAlmostEqual(y + top * ratio, height * 270 / 1920, delta=0.5)
        # 3:4 is not TikTok's: in the corner.
        x, y = montage.watermark_place('eclipse', 768, 1024)[3:]
        self.assertGreater(y, 1024 / 2)

    def test_the_watermark_is_one_of_ours_and_laid_last_over_the_film(self):
        with self.assertRaisesRegex(ValueError, 'Invalid watermark'):
            montage.validated(self.asked(watermark='../../secret.png'), self.root)
        plan = montage.validated(self.asked(watermark='eclipse'), self.root)
        inputs, filters, sound, _ = montage.graph(plan, [False, True, False])
        # After the three plans and the music: the fifth input, the picture of the watermark.
        self.assertEqual(inputs.count('-i'), 5)
        self.assertTrue(inputs[-1].endswith('moodix-watermark-eclipse-2160.png'))
        self.assertIn('[3:a]atrim', filters, 'the music is still the fourth input')
        self.assertIn('concat=n=3:v=1:a=1[plain][clips]', filters)
        self.assertIn('[4:v]scale=', filters)
        self.assertTrue(filters.split(';')[-2].startswith('[plain][mark]overlay='))
        self.assertTrue(filters.split(';')[-2].endswith('[film]'))
        self.assertEqual(sound, '[sound]')
        # Without one, nothing of it.
        inputs, filters, _, _ = montage.graph(montage.validated(self.asked(), self.root), [False, True, False])
        self.assertEqual(inputs.count('-i'), 4)
        self.assertNotIn('overlay', filters)

    def test_a_film_with_the_watermark_has_it_in_the_corner_and_nowhere_else(self):
        import imageio.v3 as iio
        import numpy as np

        # A blue film of 1080 × 1080 (the file made for 1080, as it is), then the same without it.
        blue = lavfi(
            self.root / 'video' / 'blue-1080.mp4',
            'color=c=0x2040a0:size=1080x1080:rate=24:duration=1',
            extra=('-c:v', 'libx264', '-pix_fmt', 'yuv420p'),
        )
        plan = dict(path=blue, kind='video', **{'from': 0, 'to': 1}, frame='fill', volume=1)
        asked = dict(id='film-w', width=1080, height=1080, fps=24, plans=[plan])
        films = {}
        for mark in ('eclipse', None):
            request = dict(asked, **({'watermark': mark} if mark else {}))
            result = montage.assemble(request, self.config, lambda **data: None)
            made = result['outputs'][0]
            films[mark] = iio.imread(self.root / made['subfolder'] / made['filename']).astype(int)
            self.assertEqual(result['metadata'].get('watermark'), mark)
        marked, plain = films['eclipse'][12], films[None][12]
        changed = np.abs(marked - plain).max(axis=2) > 24
        ys, xs = np.nonzero(changed)
        # Its drawing, 81 px wide, its right and bottom edges 43 px from those of the film (the shadow
        # around it is soft: only the drawing and the near shadow change the blue that much).
        self.assertTrue(len(xs), 'the watermark is in the film')
        self.assertTrue(1080 - 43 - 81 - 12 <= xs.min() and xs.max() <= 1080 - 43 + 12, (xs.min(), xs.max()))
        self.assertTrue(1080 - 43 - 81 - 12 <= ys.min() and ys.max() <= 1080 - 43 + 12, (ys.min(), ys.max()))
        # The crescent (lower half of the disc) is ivory.
        self.assertGreater(marked[1080 - 43 - 8, 1080 - 43 - 40].min(), 170, marked[1080 - 43 - 8, 1080 - 43 - 40])


if __name__ == '__main__':
    unittest.main()
