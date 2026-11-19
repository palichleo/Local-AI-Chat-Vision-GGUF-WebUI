import tempfile
import unittest
from pathlib import Path
from unittest import mock

import torch

from runner.models import wan22, wan_block
from runner.pipelines import wan22 as pipeline
from runner.video import scail

TEXT = 32
CUDA = torch.cuda.is_available()


def small(head=12, wide=48):
    """One of the two transformers of Wan 2.2 with two small blocks, weights drawn at random."""
    from diffusers import WanTransformer3DModel

    torch.manual_seed(0)
    return WanTransformer3DModel(
        num_attention_heads=2,
        attention_head_dim=head,
        in_channels=wan22.STREAM_CHANNELS,
        out_channels=wan22.LATENT_CHANNELS,
        text_dim=TEXT,
        freq_dim=16,
        ffn_dim=wide,
        num_layers=2,
        rope_max_seq_len=256,
    ).eval()


def header(kind='HIGH', channels=wan22.STREAM_CHANNELS):
    """The header of one of the two files in ComfyUI's layout, sizes taken from the model itself
    (and from the user's own files of 19/11: INT8 weights with their scale and their note)."""
    shapes = {name: list(parameter.shape) for name, parameter in wan22.architecture().named_parameters()}
    found = {'__metadata__': {'format': 'pt', 'model_type': 'Wan2_2-I2V-A14B-' + kind}}

    def tensor(key, quantised=False):
        found[key] = dict(dtype='I8' if quantised else 'F32', shape=shapes[wan22.renamed(key)])
        if quantised:
            found[key + '_scale'] = dict(dtype='F32', shape=[])
            found[key.removesuffix('.weight') + '.comfy_quant'] = dict(dtype='U8', shape=[64])

    for index in range(wan22.LAYERS):
        block = f'blocks.{index}.'
        tensor(block + 'modulation')
        for name in ('self_attn.q', 'self_attn.k', 'self_attn.v', 'self_attn.o', 'ffn.0', 'ffn.2'):
            tensor(block + name + '.weight', quantised=True)
            tensor(block + name + '.bias')
        for name in ('q', 'k', 'v', 'o'):
            tensor(block + 'cross_attn.' + name + '.weight', quantised=True)
            tensor(block + 'cross_attn.' + name + '.bias')
        for name in ('self_attn.norm_q', 'self_attn.norm_k', 'cross_attn.norm_q', 'cross_attn.norm_k'):
            tensor(block + name + '.weight')
        tensor(block + 'norm3.weight')
        tensor(block + 'norm3.bias')
    for name in ('time_embedding.0', 'time_embedding.2', 'time_projection.1', 'text_embedding.0', 'text_embedding.2'):
        tensor(name + '.weight', quantised=True)
        tensor(name + '.bias')
    for name in ('head.head', 'patch_embedding'):
        tensor(name + '.weight')
        tensor(name + '.bias')
    tensor('head.modulation')
    found['patch_embedding.weight']['shape'][1] = channels
    return found


class ForwardTests(unittest.TestCase):
    def given(self, frames=3, height=8, width=8):
        torch.manual_seed(1)
        return dict(
            latents=torch.randn(1, 16, frames, height, width),
            timestep=torch.tensor([500]),
            text=torch.randn(1, wan22.TEXT_TOKENS, TEXT),
            condition=torch.randn(1, 20, frames, height, width),
        )

    def test_a_pass_is_diffusers_own_computation_on_the_latents_beside_what_is_given(self):
        model, given = small(), self.given()
        with torch.no_grad():
            ours = wan22.forward(model, **given)
            theirs = model(
                hidden_states=torch.cat([given['latents'], given['condition']], dim=1),
                timestep=given['timestep'],
                encoder_hidden_states=given['text'],
                return_dict=False,
            )[0]
            kept = wan22.forward(model, **given, rotary=wan22.positions(model, (1, 36, 3, 8, 8)))
        self.assertEqual(tuple(ours.shape), (1, 16, 3, 8, 8))
        self.assertLess((ours - theirs).abs().max().item(), 1e-5)
        # The positions computed once for every step are those of each pass.
        self.assertEqual((kept - ours).abs().max().item(), 0)
        with self.assertRaisesRegex(ValueError, '512 text tokens'):
            wan22.forward(model, **dict(given, text=given['text'][:, :100]))

    def test_the_image_and_the_prompt_both_reach_the_video(self):
        model, given = small(), self.given()
        with torch.no_grad():
            plain = wan22.forward(model, **given)
            other_image = wan22.forward(model, **dict(given, condition=given['condition'] + 1))
            other_text = wan22.forward(model, **dict(given, text=given['text'] + 1))
        self.assertGreater((other_image - plain).abs().max().item(), 1e-3)
        self.assertGreater((other_text - plain).abs().max().item(), 1e-3)

    @unittest.skipUnless(CUDA, 'the fused kernels run on the GPU')
    def test_with_fused_blocks_the_video_is_the_same_within_the_rounding(self):
        model = small(head=128, wide=512).to('cuda', torch.bfloat16)
        kind = dict(device='cuda', dtype=torch.bfloat16)
        torch.manual_seed(1)
        given = dict(
            latents=torch.randn(1, 16, 2, 16, 16, **kind),
            timestep=torch.tensor([500], device='cuda'),
            text=torch.randn(1, 512, TEXT, **kind),
            condition=torch.randn(1, 20, 2, 16, 16, **kind),
        )
        with torch.no_grad():
            exact = wan22.forward(model, **given).float()
            self.assertEqual(wan_block.fuse(model, int8_attention=False), (True, False))
            fused = wan22.forward(model, **given).float()
        self.assertEqual(tuple(fused.shape), (1, 16, 2, 16, 16))
        self.assertLess(((fused - exact).norm() / exact.norm()).item(), 0.02)


class GivenTests(unittest.TestCase):
    def test_the_first_latent_frame_is_marked_given_and_the_others_to_draw(self):
        latents = torch.randn(1, 16, 5, 4, 6)
        found = wan22.given(latents)
        self.assertEqual(tuple(found.shape), (1, 20, 5, 4, 6))
        self.assertTrue((found[:, :4, 0] == 1).all())
        self.assertTrue((found[:, :4, 1:] == 0).all())
        # The marks first, the latents of the image after: the order the model was trained with.
        self.assertTrue((found[:, 4:] == latents).all())

    def test_the_video_given_is_the_start_image_then_grey(self):
        picture = torch.rand(3, 16, 32) * 2 - 1
        video = pipeline.start_video(picture, 9)
        self.assertEqual(tuple(video.shape), (1, 3, 9, 16, 32))
        self.assertTrue((video[0, :, 0] == picture).all())
        self.assertTrue((video[0, :, 1:] == 0).all())


class LayoutTests(unittest.TestCase):
    def test_every_tensor_of_the_file_has_its_place_in_the_model(self):
        found = header()
        names = wan22.validate_layout(found)
        self.assertEqual(names['blocks.7.attn2.to_k.weight'], ('model', 'blocks.7.cross_attn.k.weight', None))
        self.assertEqual(names['blocks.0.norm2.bias'], ('model', 'blocks.0.norm3.bias', None))
        self.assertEqual(names['scale_shift_table'], ('model', 'head.modulation', None))
        self.assertEqual(names['proj_out.weight'], ('model', 'head.head.weight', None))
        self.assertEqual(found['patch_embedding.weight']['shape'], [5120, 36, 1, 2, 2])
        # What a quantised weight stores beside itself is the pool's to read, not a tensor of the model.
        self.assertFalse(any(key.endswith(('weight_scale', 'comfy_quant')) for _, key, _ in names.values()))

    def test_another_wan_model_is_refused_by_what_it_is(self):
        for channels, said in ((16, 'texte vers vidéo'), (48, '5B')):
            with self.assertRaisesRegex(ValueError, said):
                wan22.validate_layout(header(channels=channels))
        earlier = dict(header(), **{'img_emb.proj.0.weight': dict(dtype='F32', shape=[1280])})
        with self.assertRaisesRegex(ValueError, 'Wan 2.1'):
            wan22.validate_layout(earlier)
        with self.assertRaisesRegex(ValueError, 'couche d’entrée'):
            wan22.validate_layout({'__metadata__': {}, 'weight': dict(dtype='F32', shape=[1])})
        lacking = {key: value for key, value in header().items() if not key.startswith('blocks.39.')}
        with self.assertRaisesRegex(ValueError, 'missing blocks.39'):
            wan22.validate_layout(lacking)
        with self.assertRaisesRegex(ValueError, 'Unsupported Wan 2.2 tensor: blocks.0.face_adapter.weight'):
            wan22.validate_layout(dict(header(), **{'blocks.0.face_adapter.weight': dict(dtype='F16', shape=[1])}))

    def test_a_file_says_which_of_the_two_models_it_is(self):
        self.assertEqual(wan22.expert(header('HIGH')), 'high')
        self.assertEqual(wan22.expert(header('LOW')), 'low')
        # A file that says nothing of itself is told by its name; neither: nobody knows.
        silent = {'__metadata__': {'format': 'pt'}}
        self.assertEqual(wan22.expert(silent, 'D:\\models\\wan2.2_i2v_low_noise_14B_fp16.safetensors'), 'low')
        self.assertEqual(wan22.expert(silent, '/models/Wan2_2-I2V-A14B-HIGH_bf16.safetensors'), 'high')
        self.assertIsNone(wan22.expert(silent, '/models/high/wan22_a.safetensors'))
        self.assertIsNone(wan22.expert(silent, '/models/wan22_high_lowvram.safetensors'))
        self.assertIsNone(wan22.expert({}, ''))


def job(**changes):
    parameters = dict(prompt='a', seed=1, width=768, height=448, steps=20, frames=81, fps=16)
    parameters.update(changes.pop('parameters', {}))
    roles = changes.pop('roles', ('start_image',))
    return dict(
        parameters=parameters,
        components=changes.pop('components', {}),
        loras=[],
        references=[dict(input=role, role=role, path=changes.get('image', 'C:/' + role)) for role in roles],
    )


class RuleTests(unittest.TestCase):
    def test_what_the_engine_takes_when_a_job_says_nothing_is_what_the_application_ships(self):
        import json

        from runner.registry import families, validate_job

        root = Path(__file__).resolve().parents[1]
        manifest = families()['wan22']
        shipped = [json.loads(path.read_text(encoding='utf-8')) for path in sorted((root / 'workflows').glob('*.json'))]
        (workflow,) = [item for item in shipped if item['pipeline'] == 'wan22']
        for made in (workflow['parameters'], manifest['template']['parameters']):
            self.assertEqual(made['negative_prompt']['value'], pipeline.AVOIDED)
            self.assertEqual(
                [made[name]['value'] for name in ('steps', 'cfg', 'shift', 'fps')],
                [pipeline.STEPS, pipeline.GUIDANCE, pipeline.SHIFT, pipeline.FPS],
            )
        # The job the application sends for it is one the engine takes.
        folder = Path.cwd()
        sent = dict(
            schemaVersion=1,
            id='job',
            pipeline='wan22',
            mediaType='video',
            workflowId=workflow['id'],
            workflowDigest='b' * 64,
            parameters=dict(
                prompt='a fox', negative_prompt=pipeline.AVOIDED, seed=1, width=768, height=448, steps=20, cfg=3.5,
                shift=5, frames=81, fps=16,
            ),
            components={name: str(folder / (name + '.safetensors')) for name in manifest['components']},
            loras=[],
            references=[dict(input='start', role='start_image', path=str(folder / 'start.png'))],
        )
        self.assertIs(validate_job(sent), sent)
        for wrong in (dict(frames=80), dict(fps=24), dict(width=1296), dict(steps=3), dict(cfg=0.5)):
            with self.assertRaises(ValueError, msg=wrong):
                validate_job(dict(sent, parameters=dict(sent['parameters'], **wrong)))
        with self.assertRaises(ValueError):
            validate_job(dict(sent, references=[]))

    def test_a_job_the_model_cannot_draw_is_refused(self):
        pipeline.check(job(), None)
        pipeline.check(job(parameters=dict(width=832, height=480, frames=5)), None)
        for wrong in (
            dict(parameters=dict(width=776)),
            dict(parameters=dict(height=450)),
            dict(parameters=dict(frames=80)),
            dict(parameters=dict(frames=1)),
            dict(roles=()),
            dict(roles=('start_image', 'start_image')),
        ):
            with self.assertRaises(ValueError):
                pipeline.check(job(**wrong), None)

    def test_the_two_files_swapped_are_refused_before_anything_is_loaded(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as folder:
            image = str(Path(folder) / 'start.png')
            Image.new('RGB', (8, 8)).save(image)
            headers = {'C:/high.safetensors': header('HIGH'), 'C:/low.safetensors': header('LOW')}
            with mock.patch('runner.models.headers.header', headers.get):
                right = dict(model='C:/high.safetensors', modelLow='C:/low.safetensors')
                pipeline.preflight(job(components=right, image=image), {})
                swapped = dict(model='C:/low.safetensors', modelLow='C:/high.safetensors')
                said = '« bruit fort » de Wan 2.2 est celui du modèle « bruit faible »'
                with self.assertRaisesRegex(ValueError, said):
                    pipeline.preflight(job(components=swapped, image=image), {})
                twice = dict(model='C:/high.safetensors', modelLow='C:/high.safetensors')
                said = '« bruit faible » de Wan 2.2 est celui du modèle « bruit fort »'
                with self.assertRaisesRegex(ValueError, said):
                    pipeline.preflight(job(components=twice, image=image), {})
                # An image cut short (a copy that did not finish) stops the job here too: its first
                # bytes say a picture, the rest is not there.
                whole = Path(folder) / 'whole.png'
                Image.effect_noise((64, 64), 60).convert('RGB').save(whole)
                broken = str(Path(folder) / 'broken.png')
                Path(broken).write_bytes(whole.read_bytes()[: whole.stat().st_size // 2])
                with Image.open(broken) as opened:
                    self.assertEqual(opened.size, (64, 64))
                with self.assertRaises(Exception):
                    pipeline.preflight(job(components=right, image=broken), {})


class ExpertTests(unittest.TestCase):
    def test_a_model_that_closes_gives_back_what_it_held_in_ram_for_the_other_one(self):
        closed = []
        expert = pipeline._Expert('high', 'C:/models/high.safetensors', {})
        expert.model = object()
        expert.pool = mock.Mock(clear=lambda: closed.append('pool'))
        expert.stack = mock.Mock(close=lambda: closed.append('file'))
        with mock.patch('runner.models.residency.RESIDENCY.forget', lambda path: closed.append(path)):
            expert.close()
        # After its file is closed: an arena still read from is not let go.
        self.assertEqual(closed, ['pool', 'file', 'C:/models/high.safetensors'])
        self.assertEqual((expert.model, expert.pool, expert.stack), (None, None, None))


class SamplingTests(unittest.TestCase):
    def test_the_high_noise_model_draws_while_the_noise_is_nine_tenths_or_more(self):
        # The official 40 steps at a shift of 5: fifteen, then twenty-five.
        for steps, shift, high in ((40, 5, 15), (20, 5, 8), (20, 8, 10), (4, 5, 2)):
            plan = pipeline.experts(scail.sigmas(steps, shift))
            self.assertEqual(len(plan), steps)
            self.assertEqual(plan, ['high'] * high + ['low'] * (steps - high), (steps, shift))
        self.assertEqual(pipeline.experts([1.0, 0.9, 0.89, 0.0]), ['high', 'high', 'low'])
        self.assertEqual(pipeline.experts([1.0, 0.5, 0.0], boundary=0.4), ['high', 'high'])

    def test_a_step_reads_the_prompt_then_what_to_avoid_and_goes_further_from_it(self):
        asked = []

        def predict(words):
            asked.append(words)
            return torch.full((1, 2), 3.0 if words == 'prompt' else 1.0, dtype=torch.bfloat16)

        moved = pipeline.guided(predict, 'prompt', 'avoided', 3.5)
        self.assertEqual(asked, ['prompt', 'avoided'])
        self.assertEqual(moved.dtype, torch.float32)
        self.assertTrue((moved == 1 + 3.5 * 2).all())
        # Without guidance: the prompt alone, one pass.
        asked.clear()
        self.assertTrue((pipeline.guided(predict, 'prompt', None, 1.0) == 3).all())
        self.assertEqual(asked, ['prompt'])

    def test_the_prompt_and_what_to_avoid_are_read_in_one_load_of_the_encoder_then_kept(self):
        loads = []

        def encode(path, prompts, progress):
            loads.append(list(prompts))
            return [torch.full((1, 512, 4), float(len(words)), dtype=torch.bfloat16) for words in prompts]

        with tempfile.TemporaryDirectory() as folder:
            encoder = Path(folder) / 'umt5.safetensors'
            encoder.write_bytes(b'weights')
            config = dict(cacheRoot=folder)
            found, kept = pipeline.texts(config, str(encoder), ['a fox', 'blur'], None, encode)
            self.assertEqual((loads, kept), ([['a fox', 'blur']], 0))
            self.assertEqual([value[0, 0, 0].item() for value in found], [5.0, 4.0])
            # The same words again: nothing is loaded.
            again, kept = pipeline.texts(config, str(encoder), ['a fox', 'blur'], None, encode)
            self.assertEqual((len(loads), kept), (1, 2))
            self.assertTrue(all((a == b).all() for a, b in zip(again, found)))
            # Another prompt: it alone is read, what to avoid is the one kept.
            other, kept = pipeline.texts(config, str(encoder), ['a wolf runs', 'blur'], None, encode)
            self.assertEqual((loads[1:], kept), ([['a wolf runs']], 1))
            self.assertEqual([value[0, 0, 0].item() for value in other], [11.0, 4.0])
            # Another encoder file: what was kept for the first is not read for it.
            encoder.write_bytes(b'other weights')
            pipeline.texts(config, str(encoder), ['a fox'], None, encode)
            self.assertEqual(loads[2:], [['a fox']])

    def test_a_start_image_is_encoded_once_for_a_size_and_a_length_whatever_its_place(self):
        from PIL import Image

        made = []

        def encode():
            made.append(1)
            return torch.full((1, 16, 3, 4, 4), float(len(made)), dtype=torch.bfloat16)

        with tempfile.TemporaryDirectory() as folder:
            vae = Path(folder) / 'vae.safetensors'
            vae.write_bytes(b'vae')
            first, copy, other = (Path(folder) / name for name in ('a.png', 'job-2-copy.png', 'b.png'))
            Image.effect_noise((16, 16), 60).save(first)
            copy.write_bytes(first.read_bytes())
            Image.effect_noise((16, 16), 20).save(other)
            config = dict(cacheRoot=folder)
            found, kept = pipeline.start_latents(config, str(vae), str(first), (768, 448, 81), encode)
            self.assertEqual((len(made), kept, found.dtype), (1, False, torch.bfloat16))
            # The same picture handed over as another file (the copy of the next job): nothing is encoded.
            again, kept = pipeline.start_latents(config, str(vae), str(copy), (768, 448, 81), encode)
            self.assertEqual((len(made), kept), (1, True))
            self.assertTrue((again == found).all())
            # Another length, another size, another picture, another VAE: each is encoded.
            for image, shape in ((first, (768, 448, 49)), (first, (512, 512, 81)), (other, (768, 448, 81))):
                _, kept = pipeline.start_latents(config, str(vae), str(image), shape, encode)
                self.assertFalse(kept, (image.name, shape))
            self.assertEqual(len(made), 4)
            vae.write_bytes(b'another vae')
            self.assertFalse(pipeline.start_latents(config, str(vae), str(first), (768, 448, 81), encode)[1])

    def test_euler_steps_down_the_noise_levels_reach_the_video_the_model_points_to(self):
        torch.manual_seed(4)
        target, noise = torch.randn(1, 16, 3, 2, 2), torch.randn(1, 16, 3, 2, 2)
        levels = scail.sigmas(6, 5)
        seen = []

        def direction(latents, index):
            # A model that knows the video: from the latents at this noise level, straight to it.
            return (latents - target) / levels[index]

        found = pipeline.sample(direction, noise, levels, lambda number, estimate: seen.append((number, estimate())))
        self.assertLess((found - target).abs().max().item(), 1e-4)
        self.assertEqual([number for number, _ in seen], [1, 2, 3, 4, 5, 6])
        # What is shown meanwhile: the frame in the middle as the model sees it finished.
        self.assertLess((seen[0][1] - target[0, :, 1]).abs().max().item(), 1e-4)

    def test_a_clip_has_one_token_for_four_latent_points_of_each_latent_frame(self):
        self.assertEqual(pipeline.tokens(81, 448, 768), 21 * 28 * 48)
        self.assertEqual(pipeline.tokens(33, 480, 832), 9 * 30 * 52)
        self.assertGreater(pipeline.working_gib(pipeline.tokens(81, 720, 1280)), 9)


if __name__ == '__main__':
    unittest.main()
