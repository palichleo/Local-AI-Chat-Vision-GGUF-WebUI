import json
import math
import tempfile
import unittest
from pathlib import Path

from runner.journal import Journal
from runner.models.ltx25 import kept_text, latent_upscaler, spread
from runner.pipelines.ltx25 import TILE, equal_tiles, first_pass_size, plan_tiles, tiling


class PassTests(unittest.TestCase):
    def test_the_blocks_kept_on_the_gpu_are_spread_through_the_model(self):
        layer = lambda name: ('model', 'model.diffusion_model.' + name + '.weight', None)  # noqa: E731
        outside = [layer('patchify_proj'), layer('adaln_single.linear')]
        blocks = [layer(f'transformer_blocks.{index}.{part}') for index in range(48) for part in ('attn1', 'ff')]
        order = spread([outside[0], *blocks, outside[1]])
        self.assertEqual(sorted(order), sorted(outside + blocks))
        # What is not in a block first; then whole blocks, their layers in their own order.
        self.assertEqual(order[:2], outside)
        index = lambda location: int(location[1].split('.')[3])  # noqa: E731
        ranked = [index(location) for location in order[2::2]]
        self.assertEqual([index(location) for location in order[3::2]], ranked)
        self.assertTrue(all('attn1' in location[1] for location in order[2::2]))
        self.assertEqual(ranked[:8], [0, 32, 16, 8, 40, 24, 4, 36])
        # Whatever the number kept, no long run of blocks is left to copy: 12 of 48 are four
        # apart, 18 at most four, and a smaller share is a part of a larger one.
        for kept, widest in ((6, 8), (12, 4), (18, 4), (24, 2)):
            chosen = sorted(ranked[:kept])
            gaps = [after - before for before, after in zip(chosen, [*chosen[1:], 48 + chosen[0]])]
            self.assertLessEqual(max(gaps), widest, kept)

    def test_the_text_kept_for_a_prompt_stands_for_the_connectors_in_the_pipeline(self):
        import torch

        video, audio, mask = torch.ones(1, 4, 8), torch.ones(1, 4, 6), torch.zeros(1, 1, 4)
        connectors = kept_text(video, audio, mask)
        self.assertIsInstance(connectors, torch.nn.Module)
        # Whatever the pipeline calls them with: the encoder's output is no longer needed.
        found = connectors(torch.zeros(1, 1, 1), torch.ones(1, 1), padding_side='left')
        self.assertTrue(all(got is given for got, given in zip(found, (video, audio, mask))))

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

    def test_decode_tiles_are_as_large_as_memory_allows_and_never_smaller_than_the_smallest(self):
        count = lambda plan, lengths: [  # noqa: E731
            len(equal_tiles(length, *plan[axis])) for axis, length in zip(('frames', 'height', 'width'), lengths)
        ]
        held = lambda plan: plan['frames'][0] * plan['height'][0] * plan['width'][0]  # noqa: E731
        draft, final = (61, 64, 36), (61, 200, 112)
        # No room, or FlexAttention (compiled for each shape): the smallest tiles, as before.
        smallest = plan_tiles(*final, 0)
        self.assertEqual(smallest, dict(frames=tiling(61, 32, 4), height=tiling(200, 32, 4), width=tiling(112, 32, 4)))
        self.assertEqual(count(smallest, final), [3, 7, 4])
        # Room for the whole draft: one tile, nothing decoded twice.
        self.assertEqual(count(plan_tiles(*draft, 61 * 64 * 36), draft), [1, 1, 1])
        # Less: the largest that fit, and among those the ones that share the least.
        for cells in (30_000, 60_000, 110_000, 200_000):
            plan = plan_tiles(*final, cells)
            self.assertLessEqual(held(plan), max(cells, held(smallest)))
            computed = lambda found: math.prod(  # noqa: E731
                size * tiles for (size, _), tiles in zip(found.values(), count(found, final))
            )
            self.assertLessEqual(computed(plan), computed(smallest))
            for axis, length in zip(('frames', 'height', 'width'), final):
                tile, stride = plan[axis]
                tiles = equal_tiles(length, tile, stride)
                self.assertEqual((tiles[0][0], tiles[-1][1]), (0, length))
                self.assertTrue(all(stop - start == tile for start, stop in tiles))
                overlap = TILE['overlap_frames' if axis == 'frames' else 'overlap_side']
                self.assertTrue(len(tiles) == 1 or tile - stride >= overlap)
        # The whole length of a 121-frame video in 384-pixel tiles, measured the fastest that fits 12 GiB.
        self.assertEqual(count(plan_tiles(*final, 110_000), final)[0], 1)

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


class PreflightTests(unittest.TestCase):
    def test_files_that_passed_are_checked_again_only_when_one_changes(self):
        from unittest import mock

        from runner.pipelines import ltx25 as pipeline

        job = dict(components={'model': 'model.safetensors'}, loras=[], references=[], parameters={'audio': False})
        stamps = {'model.safetensors': ['model.safetensors', 10, 1]}
        with (
            mock.patch('runner.models.conditioning.stamp', side_effect=lambda path: list(stamps[path])),
            mock.patch('runner.models.headers.header', return_value={}),
            mock.patch('runner.models.ltx25.validate_layout') as validate,
            mock.patch('runner.video.msr.validate_msr'),
            mock.patch('runner.models.ltx25_audio.vocoder_layout'),
            mock.patch.object(pipeline, 'CHECKED', set()),
        ):
            pipeline.preflight(job, {})
            pipeline.preflight(job, {})
            self.assertEqual(validate.call_count, 1)
            stamps['model.safetensors'][2] = 2
            pipeline.preflight(job, {})
            self.assertEqual(validate.call_count, 2)
            # Another way to use the same files is another check, and a refusal is not remembered.
            pipeline.preflight(dict(job, parameters={'audio': True}, components={'model': 'model.safetensors'}), {})
            self.assertEqual(validate.call_count, 3)
            stamps['model.safetensors'][2] = 3
            validate.side_effect = ValueError('Unsupported LTX2.5 layout')
            for _ in range(2):
                with self.assertRaises(ValueError):
                    pipeline.preflight(job, {})
            self.assertEqual(validate.call_count, 5)


class KeptModelTests(unittest.TestCase):
    def test_the_model_left_is_taken_back_for_the_same_shape_only_and_built_anew_when_it_does_not_fit(self):
        from types import SimpleNamespace
        from unittest import mock

        from runner.models import kept
        from runner.pipelines import ltx25 as pipeline

        def job(width=288, references=()):
            parameters = dict(width=width, height=512, frames=121)
            return dict(components={'model': 'model'}, loras=[], references=list(references), parameters=parameters)

        given, dropped = [], []

        def run(_job, _config, _progress, key, holder):
            given.append(holder[0])
            if holder[0] is None:
                holder[0] = SimpleNamespace(
                    key=key, fits=True, locked=True, allocated=0, drop=lambda: dropped.append(key[2][0])
                )
                holder[0].locked = key[2][0] != 1024
            elif not holder[0].fits:
                raise pipeline.Refit
            return 'video'

        with (
            mock.patch('runner.models.conditioning.stamp', side_effect=lambda path: [path, 1, 1]),
            mock.patch.object(pipeline, '_generate', run),
        ):
            try:
                self.assertEqual(pipeline.generate(job(), {}, None), 'video')
                first = kept._kept['ltx25']
                self.assertEqual(pipeline.generate(job(), {}, None), 'video')
                self.assertEqual((given, dropped), ([None, first], []))
                # Its share no longer suits this video: dropped, and the video starts over without it.
                first.fits = False
                self.assertEqual(pipeline.generate(job(), {}, None), 'video')
                self.assertEqual((given[2:], dropped), ([first, None], [288]))
                second = kept._kept['ltx25']
                self.assertIsNot(second, first)
                # Another size, or an image to start from: another share, the model is not taken back.
                pipeline.generate(job(width=544), {}, None)
                pipeline.generate(job(width=544, references=[{'role': 'start_image'}]), {}, None)
                self.assertEqual((given[4:], dropped), ([None, None], [288, 288, 544]))
                # A failure leaves nothing for the next video.
                kept._kept['ltx25'].fits = False
                with mock.patch.object(pipeline, '_generate', side_effect=RuntimeError('out of memory')):
                    with self.assertRaises(RuntimeError):
                        pipeline.generate(job(width=544, references=[{'role': 'start_image'}]), {}, None)
                self.assertEqual((dropped[3:], kept._kept), ([544], {}))
                # A model whose steps copied from unlocked memory (RAM was short) is not kept: its
                # file left open would leave the next video no room to lock either.
                self.assertEqual(pipeline.generate(job(width=1024), {}, None), 'video')
                self.assertEqual((dropped[4:], kept._kept), ([1024], {}))
            finally:
                kept._kept.clear()


if __name__ == '__main__':
    unittest.main()
