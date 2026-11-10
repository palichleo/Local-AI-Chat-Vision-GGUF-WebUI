import json
import tempfile
import unittest
from pathlib import Path

from runner.journal import Journal
from runner.models.ltx25 import latent_upscaler
from runner.pipelines.ltx25 import equal_tiles, first_pass_size, tiling


class PassTests(unittest.TestCase):
    def test_large_videos_are_sampled_at_half_size_first_when_the_upscaler_is_there(self):
        with_upscaler = {'model': 'm', 'upscaler': 'u'}
        size = lambda width, height, components=with_upscaler: first_pass_size(
            {'width': width, 'height': height}, components
        )
        self.assertEqual(size(896, 1600), (448, 800))
        self.assertEqual(size(1024, 576), (512, 288))
        # An odd latent size rounds the half up: the doubled result is cropped back.
        self.assertEqual(size(960, 544), (480, 288))
        # A draft is too small for a first pass worth refining; no upscaler, no second pass.
        self.assertIsNone(size(384, 256))
        self.assertIsNone(size(448, 768))
        self.assertIsNone(size(896, 1600, {'model': 'm'}))

    def test_decode_tiles_are_equal_cover_the_video_and_share_a_seam(self):
        for length in range(1, 260):
            for largest, overlap in ((32, 4), (32, 8), (16, 4)):
                tile, stride = tiling(length, largest, overlap)
                tiles = equal_tiles(length, tile, stride)
                self.assertEqual(tiles[0][0], 0)
                self.assertEqual(tiles[-1][1], length)
                self.assertEqual(len({end - start for start, end in tiles}), 1, (length, largest, overlap))
                for (_, end), (start, _) in zip(tiles, tiles[1:]):
                    self.assertGreaterEqual(end - start, overlap)
                if length <= largest:
                    self.assertEqual(tiles, [(0, length)])
        # The case measured: 1600 pixels are 200 cells, seven tiles of 256 pixels.
        self.assertEqual(tiling(200, 32, 4), (32, 28))
        self.assertEqual(len(equal_tiles(200, 32, 28)), 7)

    def test_latent_upscaler_file_is_checked_before_the_gpu_is_taken(self):
        config = dict(
            in_channels=128,
            mid_channels=1024,
            num_blocks_per_stage=4,
            dims=3,
            spatial_upsample=True,
            temporal_upsample=False,
            spatial_scale=2.0,
            rational_resampler=False,
        )
        header = lambda **changes: {
            '__metadata__': {'config': json.dumps({**config, **changes})},
            'upsampler.0.weight': {'shape': [4096, 1024, 3, 3], 'dtype': 'BF16'},
        }
        self.assertIsNone(latent_upscaler(header()))
        for wrong in (dict(temporal_upsample=True), dict(spatial_scale=1.5), dict(in_channels=16), dict(dims=2)):
            with self.assertRaises(ValueError):
                latent_upscaler(header(**wrong))
        with self.assertRaises(ValueError):
            latent_upscaler({'upsampler.0.weight': {'shape': [4096, 1024, 3, 3]}})
        with self.assertRaises(ValueError):
            latent_upscaler({**header(), 'upsampler.0.weight': {'shape': [1024, 1024, 3, 3]}})


class JournalTests(unittest.TestCase):
    def test_every_stage_is_written_as_it_happens_and_the_file_stays_small(self):
        with tempfile.TemporaryDirectory() as directory:
            config = {'cacheRoot': str(Path(directory) / 'cache')}
            job = {
                'id': 'job-1',
                'pipeline': 'ltx25',
                'parameters': {'prompt': 'a' * 500, 'width': 896, 'height': 1600},
                'components': {'model': '/models/ltx.safetensors'},
                'loras': [],
                'references': [{'role': 'start_image', 'path': '/secret/place/ship.png'}],
            }
            journal = Journal(config, job)
            journal.write(stage='generating video', step=1, total=11)
            journal.write(event='failed', error='RuntimeError: stopped')
            path = Path(directory) / 'generation-journal.jsonl'
            rows = [json.loads(line) for line in path.read_text(encoding='utf8').splitlines()]
            self.assertEqual(
                [row.get('event') or row['stage'] for row in rows], ['start', 'generating video', 'failed']
            )
            self.assertEqual(rows[0]['parameters']['width'], 896)
            self.assertEqual(len(rows[0]['parameters']['prompt']), 200)
            self.assertEqual(rows[0]['components'], {'model': 'ltx.safetensors'})
            self.assertEqual(rows[0]['references'], ['start_image'])
            self.assertNotIn('secret', path.read_text(encoding='utf8'))
            # An old, long journal is cut to its last half megabyte or less before a new job.
            path.write_text('{"old": true}\n' * 60000, encoding='utf8')
            Journal(config, job)
            self.assertLess(path.stat().st_size, 300 * 1024)
            self.assertEqual(json.loads(path.read_text(encoding='utf8').splitlines()[-1])['event'], 'start')

    def test_a_journal_that_cannot_be_written_never_stops_a_generation(self):
        journal = Journal({'cacheRoot': '/nonexistent/folder/cache'}, {'id': 'x'})
        journal.write(stage='anything')
        Journal({}, {}).write(stage='anything')


if __name__ == '__main__':
    unittest.main()
