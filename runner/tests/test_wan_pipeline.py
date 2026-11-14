import tempfile
import unittest
from pathlib import Path

import numpy as np
import torch

from runner.pipelines import wan_scail2 as pipeline
from runner.video import scail


def job(**changes):
    parameters = dict(prompt='a', seed=1, width=896, height=512, steps=6, frames=121, fps=24)
    parameters.update(changes.pop('parameters', {}))
    roles = changes.pop('roles', ('driving_video', 'reference_image', 'driving_mask', 'reference_mask'))
    return dict(
        parameters=parameters,
        components={},
        loras=[],
        references=[dict(input=role, role=role, path='C:/' + role) for role in roles],
    )


class PlanTests(unittest.TestCase):
    def test_a_video_is_cut_in_segments_that_start_on_the_end_of_the_one_before(self):
        self.assertEqual(scail.plan(81), [(0, 81)])
        self.assertEqual(scail.plan(45), [(0, 45)])
        # The workflow's 121 frames: 81, then 45 of which the first five are the last of the 81.
        self.assertEqual(scail.plan(121), [(0, 81), (76, 45)])
        self.assertEqual(scail.plan(85), [(0, 81), (76, 9)])
        self.assertEqual(scail.plan(233), [(0, 81), (76, 81), (152, 81)])
        self.assertEqual(scail.plan(81, 45), [(0, 45), (40, 41)])

    def test_every_frame_is_drawn_once(self):
        for frames in range(5, 400, 4):
            for segment in (21, 45, 81):
                found = scail.plan(frames, segment)
                drawn = found[0][1] + sum(count - scail.OVERLAP for _first, count in found[1:])
                self.assertEqual(drawn, frames)
                self.assertTrue(all(count % 4 == 1 for _first, count in found))
                # A segment after the first draws something beyond what it was given.
                self.assertTrue(all(count > scail.OVERLAP for _first, count in found[1:]))
                self.assertTrue(all(first + count <= frames for first, count in found))

    def test_frames_that_the_model_cannot_read_are_refused(self):
        for frames, segment in ((120, 81), (121, 80)):
            with self.assertRaises(ValueError):
                scail.plan(frames, segment)

    def test_the_tokens_are_the_reference_the_video_and_the_pose_at_half_size(self):
        self.assertEqual(scail.tokens(81, 512, 896), 1792 + 21 * 1792 + 21 * 448)
        self.assertEqual(scail.tokens(45, 512, 896), 1792 + 12 * 1792 + 12 * 448)


class InputTests(unittest.TestCase):
    def test_a_mask_is_cut_without_blending_its_colours(self):
        mask = -torch.ones(3, 9, 30)
        mask[2, :, 10:17] = 1  # a blue band
        cut = scail.cover(mask, 16, 16, flat=True)
        self.assertEqual(tuple(cut.shape), (3, 16, 16))
        self.assertEqual(set(cut.unique().tolist()), {-1.0, 1.0})
        blended = scail.cover(mask, 16, 16)
        self.assertGreater(len(blended.unique()), 2)

    def test_the_reference_is_shown_on_black_outside_its_mask(self):
        reference = torch.full((3, 4, 4), 0.5)
        mask = -torch.ones(3, 4, 4)
        mask[2, :2] = 1
        shown = scail.matte(reference, mask)
        self.assertTrue((shown[:, :2] == 0.5).all())
        self.assertTrue((shown[:, 2:] == -1).all())

    def test_a_video_is_read_at_half_the_size_of_the_generation(self):
        import imageio.v3 as iio

        frames = np.zeros((6, 32, 64, 3), dtype=np.uint8)
        frames[:, :, 32:] = 255
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / 'video.mp4')
            iio.imwrite(path, frames, fps=24, codec='libx264', macro_block_size=None)
            read = pipeline.read_halved(path, 5, 32, 32)
            self.assertEqual(tuple(read.shape), (5, 3, 16, 16))
            # The middle of the picture is kept: dark on the left, bright on the right.
            self.assertLess(read[:, :, :, :4].mean().item(), -0.8)
            self.assertGreater(read[:, :, :, -4:].mean().item(), 0.8)
            with self.assertRaises(ValueError):
                pipeline.read_halved(path, 9, 32, 32)


class RuleTests(unittest.TestCase):
    def test_a_job_the_model_cannot_draw_is_refused(self):
        pipeline.check(job(), None)
        for wrong in (
            dict(parameters=dict(width=900)),
            dict(parameters=dict(frames=4)),
            dict(parameters=dict(mode='animate')),
            dict(parameters=dict(segment_frames=44)),
            dict(roles=('driving_video', 'reference_image', 'driving_mask')),
            dict(roles=('driving_video', 'driving_video', 'reference_image', 'driving_mask', 'reference_mask')),
        ):
            with self.assertRaises(ValueError):
                pipeline.check(job(**wrong), None)

    def test_without_masks_the_job_names_what_finds_the_subjects(self):
        bare = job(roles=('driving_video', 'reference_image'))
        self.assertFalse(pipeline.masks_given(bare))
        with self.assertRaisesRegex(ValueError, 'SAM 3.1'):
            pipeline.check(bare, None)
        bare['components'] = dict(segmenter='C:/sam.safetensors', segmenterTokenizer='C:/tokenizer')
        pipeline.check(bare, None)
        self.assertTrue(pipeline.masks_given(job()))

    def test_the_video_lasts_as_long_as_the_one_it_follows_up_to_the_frames_asked(self):
        import imageio.v3 as iio

        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / 'video.mp4')
            iio.imwrite(path, np.zeros((30, 32, 64, 3), dtype=np.uint8), fps=30, codec='libx264', macro_block_size=None)
            made = job(parameters=dict(frames=121))
            made['references'][0]['path'] = path
            # 30 frames filmed: 29 drawn (4n + 1), at the video's own 30 frames a second.
            # A video twice as wide as high: 896 x 512 asked gives its shape in as many pixels.
            self.assertEqual(pipeline.clip(made), (29, 30.0, 960, 480))
            made['parameters']['frames'] = 12
            self.assertEqual(pipeline.clip(made)[:2], (9, 30.0))
            iio.imwrite(path, np.zeros((4, 32, 64, 3), dtype=np.uint8), fps=30, codec='libx264', macro_block_size=None)
            with self.assertRaisesRegex(ValueError, 'trop courte'):
                pipeline.clip(made)

    def test_the_video_has_the_shape_of_the_one_it_follows(self):
        self.assertEqual(pipeline.size_like(1280, 720, 896, 512), (896, 512))
        self.assertEqual(pipeline.size_like(720, 1280, 896, 512), (512, 896))
        self.assertEqual(pipeline.size_like(1080, 1080, 896, 512), (672, 672))
        self.assertEqual(pipeline.size_like(1920, 1080, 1344, 768), (1344, 768))
        # Never a side the model cannot draw.
        width, height = pipeline.size_like(4000, 400, 896, 512)
        self.assertEqual((width % 32, height % 32, height), (0, 0, 256))

    def test_the_models_own_loras_come_first_each_with_its_strength(self):
        made = job()
        made['loras'] = [dict(id='style', path='C:/style', strength=0.5)]
        self.assertEqual(pipeline.loras_of(made), made['loras'])
        made['components'] = dict(stepLora='C:/step', identityLora='C:/identity')
        made['parameters']['identity_lora_strength'] = 0.7
        self.assertEqual(
            pipeline.loras_of(made),
            [
                dict(id='stepLora', path='C:/step', strength=0.8),
                dict(id='identityLora', path='C:/identity', strength=0.7),
                *made['loras'],
            ],
        )

    def test_a_smaller_card_draws_shorter_segments(self):
        self.assertEqual(pipeline.segment_frames(23, 512, 896), 81)
        # A 12 GiB card with the desktop on it: the whole segment the model was trained on.
        self.assertEqual(pipeline.segment_frames(11.4, 512, 896), 81)
        found = [pipeline.segment_frames(free, 512, 896) for free in (11.4, 9.4, 7.4, 5.4, 3.4, 1)]
        self.assertEqual(found, sorted(found, reverse=True))
        self.assertLess(found[2], 81)
        self.assertEqual(found[-1], pipeline.SHORTEST)
        self.assertTrue(all(count % 4 == 1 for count in found))
        # A smaller picture fits whole where a larger one is cut.
        self.assertEqual(pipeline.segment_frames(7.4, 320, 576), 81)
        # Never longer than asked.
        self.assertEqual(pipeline.segment_frames(23, 512, 896, 45), 45)

    def test_the_share_of_the_model_leaves_the_steps_and_the_decoder_their_room(self):
        tokens = scail.tokens(81, 512, 896)
        one = pipeline.share_gib(11.2, tokens, 512, 896, 1)
        self.assertAlmostEqual(one, 11.2 - pipeline.working_gib(tokens) - pipeline.AHEAD_GIB)
        # Long segments: the steps ask for more than the decoder, one segment or several.
        self.assertEqual(pipeline.share_gib(11.2, tokens, 512, 896, 2), one)
        # Short ones: between two segments the decoder needs more than a step does.
        short = scail.tokens(45, 512, 896)
        self.assertLess(pipeline.share_gib(11.2, short, 512, 896, 2), pipeline.share_gib(11.2, short, 512, 896, 1))
        self.assertGreater(pipeline.decode_gib(768, 1344), pipeline.decode_gib(512, 896))
        self.assertEqual(pipeline.share_gib(4, tokens, 512, 896, 1), 0.0)

    def test_the_share_of_the_model_shrinks_to_none(self):
        found, share = [], 3.5
        while share > 0:
            share = pipeline.smaller(share)
            found.append(share)
        self.assertEqual(found, [1.75, 0.875, 0.0])


class SamplingTests(unittest.TestCase):
    def test_euler_steps_follow_the_model_down_the_noise_levels(self):
        noise = torch.randn(1, 16, 3, 4, 4)
        levels = scail.sigmas(4, 5.0)
        seen = []

        def velocity(stream, level):
            seen.append((tuple(stream.shape), stream.dtype, level))
            return torch.ones(1, 16, 3, 4, 4)

        steps, pictures = [], []

        def stepped(number, estimate):
            steps.append(number)
            pictures.append(estimate())

        result = pipeline.sample(velocity, noise.clone(), levels, step=stepped)
        # The levels go from 1 to 0: a velocity of one takes one away.
        self.assertTrue(torch.allclose(result, noise - 1, atol=1e-5))
        self.assertEqual(steps, [1, 2, 3, 4])
        # The picture so far: the middle frame as the model sees it finished. A velocity of one
        # from the first level (1) takes one away from the noise.
        self.assertEqual(tuple(pictures[0].shape), (16, 4, 4))
        self.assertTrue(torch.allclose(pictures[0], noise[0, :, 1] - 1, atol=1e-5))
        self.assertEqual([level for _shape, _kind, level in seen], levels[:-1])
        self.assertEqual(seen[0][:2], ((1, 20, 3, 4, 4), torch.bfloat16))

    def test_the_frames_given_by_the_segment_before_are_kept_as_they_are(self):
        noise = torch.randn(1, 16, 5, 4, 4)
        history = torch.full((1, 16, 2, 4, 4), 0.25)
        seen = []

        def velocity(stream, level):
            seen.append(stream.float().clone())
            return torch.ones(1, 16, 5, 4, 4)

        result = pipeline.sample(velocity, noise.clone(), scail.sigmas(3, 5.0), history)
        for stream in seen:
            # Read clean at every step, and marked as given; the frames to draw are not.
            self.assertTrue((stream[:, :16, :2] == 0.25).all())
            self.assertTrue((stream[:, 16:, :2] == 1).all())
            self.assertTrue((stream[:, 16:, 2:] == 0).all())
        self.assertTrue((result[:, :, :2] == 0.25).all())
        self.assertTrue(torch.allclose(result[:, :, 2:], noise[:, :, 2:] - 1, atol=1e-5))

    def test_without_history_nothing_is_marked_as_given(self):
        self.assertEqual(pipeline.marks(torch.zeros(1, 16, 3, 2, 2), None).abs().sum().item(), 0)

    def test_joined_segments_leave_out_the_frames_they_were_given(self):
        first = np.full((9, 2, 2, 3), 1, dtype=np.uint8)
        second = np.full((9, 2, 2, 3), 2, dtype=np.uint8)
        second[: scail.OVERLAP] = 9
        video = pipeline.stitched([first, second], scail.OVERLAP)
        self.assertEqual(len(video), 13)
        self.assertEqual(video[:, 0, 0, 0].tolist(), [1] * 9 + [2] * 4)


if __name__ == '__main__':
    unittest.main()
