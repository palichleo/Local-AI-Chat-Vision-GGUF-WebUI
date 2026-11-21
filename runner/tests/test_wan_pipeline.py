import io
import tempfile
import unittest
from contextlib import ExitStack, contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import numpy as np
import torch

from runner.pipelines import wan_scail2 as pipeline
from runner.tests.test_wan_scail2 import IMAGE, TEXT, small
from runner.video import identity, scail

GiB = 1024**3


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


def video_file(folder, frames, width, height, fps=24, name='video.mp4'):
    """A video of `frames` grey frames, each brighter than the one before, written in `folder`."""
    import imageio.v3 as iio

    path = str(Path(folder) / name)
    greys = np.linspace(40, 200, frames).astype(np.uint8)
    pictures = np.broadcast_to(greys[:, None, None, None], (frames, height, width, 3)).copy()
    iio.imwrite(path, pictures, fps=fps, codec='libx264', macro_block_size=None)
    return path


def image_file(folder, width, height, value=153, name='image.png'):
    """An image of one grey (153 of 255: 0.2 from -1 to 1), written in `folder`."""
    from PIL import Image

    path = str(Path(folder) / name)
    Image.fromarray(np.full((height, width, 3), value, dtype=np.uint8)).save(path)
    return path


def found_job(mode, video, image='C:/reference_image', **parameters):
    """A job in `mode` whose subjects SAM 3.1 is to find."""
    made = job(parameters=dict(mode=mode, **parameters), roles=('driving_video', 'reference_image'))
    made['references'][0]['path'], made['references'][1]['path'] = video, image
    made['components'] = dict(segmenter='C:/sam.safetensors', segmenterTokenizer='C:/tokenizer')
    return made


# What SAM 3.1 finds in every picture, as runner.video.identity keeps it: one object, a square in the middle.
SQUARE = torch.zeros(288, 288)
SQUARE[96:192, 96:192] = 1


def follow_square(model, pieces, prompt, pictures, batch=4, progress=None):
    frames = [{0: SQUARE.half()} for _picture in pictures]
    if progress:
        progress(len(frames))
    return SimpleNamespace(frames=frames, count=1)


@contextmanager
def sam_finds_a_square(events=None):
    """SAM 3.1 answering follow_square, its detector neither read nor loaded; `events` is told when
    it is freed."""
    from runner.models import sam3

    freed = None if events is None else (lambda: events.append('detector freed'))
    with (
        mock.patch.object(sam3, 'load', return_value='detector') as load,
        mock.patch.object(sam3, 'tokenizer', return_value='pieces'),
        mock.patch.object(sam3, 'forget', side_effect=freed) as forget,
        mock.patch.object(identity, 'follow', side_effect=follow_square),
    ):
        yield load, forget


def latents_of(pixels):
    """What the VAE makes of pixels [batch, 3, frames, height, width]: [batch, 16, latent frames,
    height / 8, width / 8], here the mean of each 8 x 8 square of the frames the latent frames start on."""
    import torch.nn.functional as F

    squares = F.avg_pool3d(pixels[:, :, ::4].float(), kernel_size=(1, 8, 8))
    return squares.mean(dim=1, keepdim=True).expand(-1, 16, -1, -1, -1).contiguous()


def pixels_of(latents):
    """What the VAE decodes latents [batch, 16, latent frames, h, w] to: [batch, 3, 4n + 1 frames, 8h, 8w]."""
    picture = latents[:, :3].float().tanh()
    frames = torch.cat([picture[:, :, :1], picture[:, :, 1:].repeat_interleave(4, dim=2)], dim=2)
    return frames.repeat_interleave(8, dim=3).repeat_interleave(8, dim=4)


def dry_job(mode, video, image, **parameters):
    """A job of two segments (13 frames, 9 a segment) of two steps, small enough for the processor."""
    wanted = dict(frames=13, segment_frames=9, width=256, height=256, steps=2, audio=False, seed=3)
    made = found_job(mode, video, image, **dict(wanted, **parameters))
    made['components'].update(model='C:/model', textEncoder='C:/text', clipVision='C:/clip', vae='C:/vae')
    made['id'] = 'dry-run'
    return made


def mask_files(folder, around_reference, around_video):
    """(mask of the reference, mask of the video) for the image of image_file(folder, 40, 80) and
    the video of video_file(folder, 16, 64, 32): a blue square in the middle, around it `around_*`
    (255 white, 0 black)."""
    import imageio.v3 as iio
    from PIL import Image

    reference = np.full((80, 40, 3), around_reference, dtype=np.uint8)
    reference[30:50, 10:30] = (0, 0, 255)
    reference_path = str(Path(folder) / 'reference_mask.png')
    Image.fromarray(reference).save(reference_path)
    video = np.full((16, 32, 64, 3), around_video, dtype=np.uint8)
    video[:, 8:24, 24:40] = (0, 0, 255)
    video_path = str(Path(folder) / 'driving_mask.mp4')
    iio.imwrite(video_path, video, fps=24, codec='libx264', macro_block_size=None)
    return reference_path, video_path


def given_job(mode, video, image, masks):
    """dry_job with the masks of mask_files given."""
    made = dry_job(mode, video, image)
    roles = ('reference_mask', 'driving_mask')
    made['references'] += [dict(input=role, role=role, path=path) for role, path in zip(roles, masks)]
    return made


def dry_run(module, made, network, events=None):
    """`module.generate(made)` on the processor, nothing sent to the card: the text and image
    encoders, the VAE and SAM 3.1 answered by small functions, the video model by `network` (one of
    runner.tests.test_wan_scail2.small). Returns (pixels saved, job saved, the arguments of every
    call of runner.models.wan_scail2.forward); `events` is told when the detector is freed and when
    the video model is loaded."""
    from runner import hardware
    from runner.models import conditioning, headers, wan_clip, wan_scail2, wan_text, wan_vae
    from runner.video import export

    events = [] if events is None else events
    saved, calls = {}, []
    generator = torch.Generator().manual_seed(7)
    text = torch.randn(1, wan_scail2.TEXT_TOKENS, TEXT, generator=generator)
    image = torch.randn(1, 5, IMAGE, generator=generator)
    real_to, real_tensor, real_forward = torch.Tensor.to, torch.tensor, wan_scail2.forward

    def to(tensor, *args, **kwargs):
        # What the pipeline sends to the card in bfloat16 stays on the processor, in float32.
        if kwargs.get('device') == 'cuda':
            kwargs['device'] = 'cpu'
            if kwargs.get('dtype') == torch.bfloat16:
                kwargs['dtype'] = torch.float32
        return real_to(tensor, *args, **kwargs)

    def made_here(*args, **kwargs):
        if kwargs.get('device') == 'cuda':
            kwargs['device'] = 'cpu'
        return real_tensor(*args, **kwargs)

    def forward(*args, **kwargs):
        calls.append(args)
        return real_forward(*args, **kwargs)

    class Loaded:
        def __init__(self, paths, loras, names):
            self.model, self.facts, self.pool = None, {}, SimpleNamespace(summary=lambda: {})

        def open(self, budget):
            events.append('video model loaded')
            self.model = network
            return self

        def close(self):
            self.model = None

    def save(pixels, config, job, metadata, audio=None):
        saved.update(pixels=pixels, job=job)
        return dict(outputs=[], metadata=metadata)

    with ExitStack() as stack:
        enter = stack.enter_context
        enter(mock.patch.object(torch.Tensor, 'to', to))
        enter(mock.patch.object(torch.Tensor, 'cuda', lambda tensor, *args, **kwargs: tensor))
        enter(mock.patch.object(torch, 'tensor', made_here))
        for name, value in (('is_available', True), ('reset_peak_memory_stats', None)):
            enter(mock.patch.object(torch.cuda, name, return_value=value))
        for name in ('memory_reserved', 'memory_allocated', 'max_memory_allocated'):
            enter(mock.patch.object(torch.cuda, name, return_value=0))
        enter(mock.patch.object(hardware, 'free_bytes', return_value=12 * GiB))
        enter(mock.patch.object(headers, 'header', return_value={}))
        enter(mock.patch.object(wan_scail2, 'validate_layout', return_value={}))
        enter(mock.patch.object(wan_scail2, 'forward', forward))
        enter(mock.patch.object(conditioning, 'stamp', side_effect=str))
        enter(mock.patch.object(module, '_cached', lambda config, name, parts, make: (make(), 'not kept')))
        enter(mock.patch.object(module, '_Model', Loaded))
        enter(mock.patch.object(wan_text, 'encode', return_value=text))
        enter(mock.patch.object(wan_clip, 'load', return_value='clip'))
        enter(mock.patch.object(wan_clip, 'image_tokens', return_value=image))
        enter(mock.patch.object(wan_vae, 'load', return_value='vae'))
        enter(mock.patch.object(wan_vae, 'encode', lambda vae, pixels: latents_of(pixels)))
        enter(mock.patch.object(wan_vae, 'decode', lambda vae, latents: pixels_of(latents)))
        enter(mock.patch.object(export, 'save_video', save))
        enter(sam_finds_a_square(events))
        module.generate(made, dict(cacheGiB=16), lambda **data: None)
    return saved['pixels'], saved['job'], calls


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
            dict(parameters=dict(mode='dance')),
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


class AnimationTests(unittest.TestCase):
    """The character of the image moved by the motion of the video (`mode` 'animate'), beside the
    replacement of a person of the video, which stays what it was."""

    def test_a_character_is_replaced_unless_the_job_animates_it(self):
        for mode in ('replace', 'animate'):
            pipeline.check(job(parameters=dict(mode=mode)), None)
        for wrong in ('dance', 'Animate', '', None):
            with self.assertRaisesRegex(ValueError, 'mode'):
                pipeline.check(job(parameters=dict(mode=wrong)), None)
        self.assertTrue(pipeline.replacing(job()))
        self.assertTrue(pipeline.replacing(job(parameters=dict(mode='replace'))))
        self.assertFalse(pipeline.replacing(job(parameters=dict(mode='animate'))))
        # Black hides what is behind it, white shows it (runner.video.scail).
        self.assertEqual(pipeline.backgrounds(job()), (identity.BLACK, identity.WHITE))
        self.assertEqual(pipeline.backgrounds(job(parameters=dict(mode='animate'))), (identity.WHITE, identity.BLACK))

    def test_the_masks_found_show_the_scene_of_the_video_or_the_one_of_the_image(self):
        with tempfile.TemporaryDirectory() as folder:
            video = video_file(folder, 6, 32, 32)
            for mode, behind_reference, behind_video in (('replace', -1.0, 1.0), ('animate', 1.0, -1.0)):
                made = found_job(mode, video, frames=5, width=64, height=64)
                with sam_finds_a_square() as (load, forget):
                    pose, pose_mask, reference_mask, facts = pipeline.find_masks(
                        made, torch.zeros(3, 80, 80), 64, 64, lambda **data: None
                    )
                load.assert_called_once_with('C:/sam.safetensors')
                # Nothing of the detector stays for the video model.
                forget.assert_called_once()
                self.assertEqual(tuple(pose.shape), (5, 3, 32, 32))
                self.assertEqual(tuple(pose_mask.shape), (5, 3, 32, 32))
                self.assertEqual(tuple(reference_mask.shape), (3, 64, 64))
                self.assertEqual(facts['reference_objects'], 1)
                self.assertEqual(facts['objects'], [dict(colour=0, frames=5)])
                # The character in blue, the first colour; around it, what is behind it.
                blue = list(identity.PALETTE[0])
                self.assertEqual(reference_mask[:, 32, 32].tolist(), blue)
                self.assertTrue((pose_mask[:, :, 16, 16] == torch.tensor(blue)).all())
                self.assertEqual(reference_mask[:, 0, 0].tolist(), [behind_reference] * 3)
                self.assertTrue((pose_mask[:, :, 0, 0] == behind_video).all())
                # As the model reads them: the share of white, the first of the seven colours of a frame.
                white = [0, 7, 14, 21]
                reference_read, pose_read = scail.mask_latents(reference_mask[None]), scail.mask_latents(pose_mask)
                self.assertEqual(reference_read[white, 0, 0, 0].tolist(), [max(behind_reference, 0.0)] * 4)
                self.assertTrue((pose_read[white, :, 0, 0] == max(behind_video, 0.0)).all())

    def test_an_animated_character_has_the_shape_of_its_image(self):
        with tempfile.TemporaryDirectory() as folder:
            # A video twice as wide as high, an image twice as high as wide.
            video, image = video_file(folder, 30, 64, 32, fps=30), image_file(folder, 40, 80)
            self.assertEqual(pipeline.image_size(image), (40, 80))
            # 896 x 512 asked: as many pixels, the way the image is, as long as the video and at its rate.
            self.assertEqual(pipeline.clip(found_job('animate', video, image)), (29, 30.0, 480, 960))
            self.assertEqual(pipeline.clip(found_job('replace', video, image)), (29, 30.0, 960, 480))

    def test_an_animated_reference_keeps_its_scene(self):
        torch.manual_seed(5)
        raw = torch.rand(3, 20, 40) * 2 - 1
        mask = -torch.ones(3, 16, 16)
        mask[2, :, 4:12] = 1  # a blue band: the character
        cut = scail.cover(raw, 16, 16)
        replaced = pipeline.reference_shown(job(), raw, mask, 16, 16)
        # Alone, on black, to take the place of a person of the video (as before).
        self.assertTrue(torch.equal(replaced, scail.matte(cut, mask)))
        self.assertTrue((replaced[:, :, :4] == -1).all())
        self.assertTrue(torch.equal(replaced[:, :, 4:12], cut[:, :, 4:12]))
        # Whole, whatever its mask, to be moved in its own scene.
        animated = pipeline.reference_shown(job(parameters=dict(mode='animate')), raw, mask, 16, 16)
        self.assertTrue(torch.equal(animated, cut))

    def test_what_the_model_reads_has_its_channels_and_its_sizes(self):
        seen = []

        def encode(pixels):
            seen.append(pixels)
            return latents_of(pixels)

        torch.manual_seed(8)
        reference = torch.rand(3, 64, 64) * 2 - 1
        mask = torch.ones(3, 64, 64)
        mask[:, 16:48, 16:48] = torch.tensor(identity.PALETTE[0]).view(3, 1, 1)
        stream, masks = pipeline.reference_streams(reference, mask, encode)
        # One frame, its latents beside four channels of ones: it is given.
        self.assertEqual(tuple(seen[-1].shape), (1, 3, 1, 64, 64))
        self.assertEqual(tuple(stream.shape), (1, 20, 1, 8, 8))
        self.assertTrue(torch.equal(stream[0, :16], latents_of(reference[None, :, None])[0]))
        self.assertTrue((stream[0, 16:] == 1).all())
        # Its mask: the same frame four times, seven colours each (white first, blue fourth).
        self.assertEqual(tuple(masks.shape), (1, 28, 1, 8, 8))
        self.assertTrue(torch.equal(masks[0], scail.mask_latents(mask[None])))
        self.assertEqual(masks[0, [0, 7, 14, 21], 0, 0, 0].tolist(), [1.0] * 4)
        self.assertEqual(masks[0, [3, 10, 17, 24], 0, 3, 3].tolist(), [1.0] * 4)
        # The pose of a segment: its own frames of the driving video (4 to 8 here), at half the size.
        pose = (torch.arange(9.0) / 10).view(9, 1, 1, 1).expand(9, 3, 32, 32)
        pose_mask = -torch.ones(9, 3, 32, 32)
        pose_mask[:4] = 1  # the frames before the segment
        stream, masks = pipeline.pose_streams(pose, pose_mask, slice(4, 9), encode)
        self.assertEqual(tuple(seen[-1].shape), (1, 3, 5, 32, 32))
        self.assertTrue(torch.allclose(seen[-1][0, 0, :, 0, 0], torch.tensor([0.4, 0.5, 0.6, 0.7, 0.8])))
        self.assertEqual(tuple(stream.shape), (1, 20, 2, 4, 4))
        self.assertTrue((stream[0, 16:] == 1).all())
        self.assertEqual(tuple(masks.shape), (1, 28, 2, 4, 4))
        # Black over the frames of the segment: neither what is behind nor a character.
        self.assertEqual(masks.abs().sum().item(), 0)

    def test_the_model_is_told_where_the_reference_sits_and_when_the_video_starts(self):
        from runner.models import wan_scail2

        model = small()
        torch.manual_seed(6)
        given = (
            torch.randn(1, wan_scail2.TEXT_TOKENS, TEXT),
            torch.randn(1, 5, IMAGE),
            torch.randn(1, 20, 1, 8, 8),
            torch.randn(1, 20, 2, 4, 4),
            torch.rand(1, 28, 1, 8, 8).round(),
            torch.rand(1, 28, 2, 4, 4).round(),
        )
        stream = torch.randn(1, 20, 2, 8, 8)
        found = {}
        for mode in pipeline.MODES:
            replace = mode == 'replace'
            with (
                mock.patch.object(wan_scail2, 'rotations', wraps=wan_scail2.rotations) as rotations,
                mock.patch.object(wan_scail2, 'forward', wraps=wan_scail2.forward) as forward,
                torch.no_grad(),
            ):
                velocity = pipeline.velocity_of(job(parameters=dict(mode=mode)), model, given, 2, 4, 4)
                found[mode] = velocity(stream, 0.5)
                velocity(stream, 0.25)
            # The positions are made once for every step, in the mode of the job; the model is told it.
            self.assertEqual(rotations.call_count, 1)
            self.assertIs(rotations.call_args.args[4], replace)
            self.assertEqual([call.args[9] for call in forward.call_args_list], [replace, replace])
            self.assertEqual(tuple(found[mode].shape), (1, 16, 2, 8, 8))
            # What the model computes from them (to replace a character: what the pipeline gave it before).
            rotary = wan_scail2.rotations(model.rope, 2, 4, 4, replace, dtype=torch.bfloat16)
            with torch.no_grad():
                expected = wan_scail2.forward(model, stream, torch.tensor([500.0]), *given, replace, rotary)
            self.assertTrue(torch.equal(found[mode], expected))
        self.assertGreater((found['animate'] - found['replace']).abs().max().item(), 1e-4)

    def test_a_whole_video_is_made_on_the_processor_in_the_mode_of_the_job(self):
        from runner.models import wan_scail2

        network = small()
        with tempfile.TemporaryDirectory() as folder:
            video, image = video_file(folder, 16, 64, 32), image_file(folder, 40, 80)
            for mode, (width, height) in (('replace', (352, 256)), ('animate', (256, 352))):
                replace, events = mode == 'replace', []
                pixels, saved, calls = dry_run(pipeline, dry_job(mode, video, image), network, events)
                # The detector leaves the card before the video model comes.
                self.assertEqual(events, ['detector freed', 'video model loaded'])
                # 13 frames in the shape of the video a person is replaced in, or of the image animated.
                self.assertEqual(pixels.shape, (13, height, width, 3))
                p = saved['parameters']
                self.assertEqual((p['mode'], p['frames'], p['width'], p['height']), (mode, 13, width, height))
                # Two segments of two steps, every one in the mode of the job.
                self.assertEqual(len(calls), 4)
                rotary = wan_scail2.rotations(network.rope, 3, height // 16, width // 16, replace, dtype=torch.bfloat16)
                for call in calls:
                    self.assertIs(call[9], replace)
                    self.assertTrue(torch.equal(call[10][0], rotary[0]))
                # The second segment follows frames 4 to 12: it starts on the second latent frame of the first.
                self.assertTrue(torch.equal(calls[2][6][:, :, 0], calls[0][6][:, :, 1]))
                self.assertFalse(torch.equal(calls[2][6][:, :, 0], calls[0][6][:, :, 0]))
                reference, reference_mask, pose_mask = calls[0][5], calls[0][7], calls[0][8]
                # The reference on black outside its character to replace one; to animate it, with
                # the grey of its scene.
                self.assertAlmostEqual(reference[0, 0, 0, 0, 0].item(), -1.0 if replace else 0.2, places=2)
                # White, what is behind, around the person of the video replaced or the character animated.
                self.assertEqual(reference_mask[0, 0, 0, 0, 0].item(), 0.0 if replace else 1.0)
                self.assertEqual(pose_mask[0, 0, 0, 0, 0].item(), 1.0 if replace else 0.0)
            # Masks given, black around the character of the image: to animate it, the image is still
            # given whole, its scene with it.
            events, made = [], given_job('animate', video, image, mask_files(folder, 0, 0))
            pixels, _saved, calls = dry_run(pipeline, made, network, events)
            self.assertEqual(events, ['video model loaded'])
            self.assertEqual(pixels.shape, (13, 352, 256, 3))
            self.assertAlmostEqual(calls[0][5][0, 0, 0, 0, 0].item(), 0.2, places=2)
            self.assertEqual(calls[0][7][0, 0, 0, 0, 0].item(), 0.0)


class BenchTests(unittest.TestCase):
    def arguments(self, *given):
        """What runner.bench reads of its arguments, its run stopped before anything is loaded."""
        import argparse

        from runner import bench

        class Read(Exception):
            pass

        parse = argparse.ArgumentParser.parse_args

        def stop(parser, *args, **kwargs):
            raise Read(parse(parser, *args, **kwargs))

        with mock.patch.object(argparse.ArgumentParser, 'parse_args', stop), self.assertRaises(Read) as read:
            bench.main(['wan_scail2', '--out', 'C:/out', *given])
        return read.exception.args[0]

    def test_the_bench_animates_a_character_when_it_is_asked(self):
        from runner import bench

        with tempfile.TemporaryDirectory() as folder:
            video = video_file(folder, 6, 32, 32)
            files = ['--model', 'M', '--text-encoder', 'T', '--clip-vision', 'C', '--vae', 'V', '--segmenter', 'S']
            files += ['--segmenter-tokenizer', 'K', '--lora', 'F:/step.safetensors:0.8']
            files += ['--reference', 'driving_video=' + video, '--reference', 'reference_image=I']
            # Without --mode, a person of the video is replaced, as before.
            asked = (((), 'replace'), (('--mode', 'animate'), 'animate'), (('--mode', 'replace'), 'replace'))
            for chosen, mode in asked:
                made = bench.wan_scail2_job(self.arguments(*files, *chosen), 1)
                self.assertEqual(made['parameters']['mode'], mode)
                self.assertEqual(made['loras'], [dict(id='lora-0', path='F:/step.safetensors', strength=0.8)])
                pipeline.check(made, None)
            with mock.patch('sys.stderr', new_callable=io.StringIO), self.assertRaises(SystemExit):
                self.arguments(*files, '--mode', 'dance')


if __name__ == '__main__':
    unittest.main()
