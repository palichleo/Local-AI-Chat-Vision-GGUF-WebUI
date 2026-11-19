import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import torch

from runner.pipelines import moss


class Model:
    """A model whose prediction says what it was asked: the text's value, less 0.25 a skipped block."""

    def __init__(self):
        self.asked = []

    def __call__(self, latents, sigma, text, skip=()):
        self.asked.append((round(float(sigma), 4), float(text), tuple(skip)))
        return torch.full_like(latents, float(text) - 0.25 * len(skip)).to(torch.bfloat16)


class SamplingTests(unittest.TestCase):
    def test_each_step_follows_the_two_predictions_joined_then_moves_by_the_gap_of_its_sigmas(self):
        model, start = Model(), torch.zeros(1, 2, 1, 1)
        told = []
        sigmas = [1.0, 0.75, 0.5, 0.25, 0.0]
        got = moss.sample(
            model, start, [torch.tensor(2.0), torch.tensor(1.0)], sigmas, 3,
            lambda index, total, latents, velocity, sigma: told.append((index, total, latents.clone(), velocity.clone(), sigma)),
        )  # fmt: skip
        # The prompt first, then the negative prompt; block 22 left out of it for the first half.
        self.assertEqual(
            model.asked,
            [(1.0, 2.0, ()), (1.0, 1.0, (22,)), (0.75, 2.0, ()), (0.75, 1.0, (22,)), (0.5, 2.0, ()), (0.5, 1.0, ()), (0.25, 2.0, ()), (0.25, 1.0, ())],
        )  # fmt: skip
        # negative + 3 x (positive - negative): 0.75 + 3 x 1.25 = 4.5 while it skips, then 1 + 3 x 1 = 4.
        self.assertEqual([round(item[3].flatten()[0].item(), 4) for item in told], [4.5, 4.5, 4.0, 4.0])
        self.assertTrue(torch.allclose(got, torch.full((1, 2, 1, 1), -(4.5 * 0.5 + 4.0 * 0.5))))
        # (The predictions come in the precision of the model; they are joined in float32.)
        self.assertEqual((got.dtype, {item[3].dtype for item in told}), (torch.float32, {torch.float32}))
        # Each step is told once taken: the latents it leaves and the sigma it stops at, from
        # which the picture it sees finished is latents - velocity x sigma.
        self.assertEqual([(item[0], item[1], item[4]) for item in told], [(0, 4, 0.75), (1, 4, 0.5), (2, 4, 0.25), (3, 4, 0.0)])
        self.assertTrue(torch.allclose(told[0][2], torch.full((1, 2, 1, 1), -1.125)))
        seen = moss.finished(told[0][2], told[0][3], told[0][4])
        self.assertEqual(tuple(seen.shape), (2, 1, 1))  # one latent, as the preview takes it
        self.assertTrue(torch.allclose(seen, torch.full((2, 1, 1), -4.5)))
        self.assertTrue(torch.equal(told[3][2], got))

    def test_a_guidance_of_one_follows_the_prompt_alone(self):
        model = Model()
        got = moss.sample(model, torch.zeros(1, 1, 1, 1), [torch.tensor(2.0)], [1.0, 0.4, 0.0], 1)
        self.assertEqual(model.asked, [(1.0, 2.0, ()), (0.4, 2.0, ())])
        self.assertAlmostEqual(got.item(), -2.0, places=6)
        self.assertEqual(moss.guided(torch.tensor(5.0), torch.tensor(1.0), 3).item(), 13.0)
        self.assertEqual((moss.SKIP_UNTIL, moss.guided(torch.tensor(5.0), torch.tensor(1.0), 1).item()), (0.5, 5.0))

    def test_latents_that_stop_being_numbers_are_refused_at_once(self):
        class Broken(Model):
            def __call__(self, latents, sigma, text, skip=()):
                super().__call__(latents, sigma, text, skip)
                return torch.full_like(latents, float('nan') if len(self.asked) > 2 else 1.0)

        model, told = Broken(), []
        with self.assertRaisesRegex(RuntimeError, 'Non-finite'):
            moss.sample(model, torch.zeros(1, 1, 1, 1), [torch.tensor(1.0)], [1.0, 0.6, 0.3, 0.0], 1, lambda *step: told.append(step[0]))
        self.assertEqual((len(model.asked), told), (3, [0, 1]))


class DecodingTests(unittest.TestCase):
    def test_the_latents_get_their_mean_and_deviation_back_and_each_channel_its_place_in_a_block(self):
        torch.manual_seed(0)
        vae = SimpleNamespace(
            bn=SimpleNamespace(running_mean=torch.randn(8), running_var=torch.rand(8) + 0.5),
            config=SimpleNamespace(batch_norm_eps=0.25),
        )
        latents = torch.randn(1, 8, 2, 3)
        got = moss.pixels_of(latents, vae)
        self.assertEqual(tuple(got.shape), (1, 2, 4, 6))
        for channel in range(8):
            deep, down, right = channel // 4, channel % 4 // 2, channel % 2
            expected = latents[0, channel] * (vae.bn.running_var[channel] + 0.25).sqrt() + vae.bn.running_mean[channel]
            self.assertTrue(torch.allclose(got[0, deep, down::2, right::2], expected, atol=1e-6), channel)

    def test_the_vae_is_read_from_its_single_file_with_its_two_convolutions_renamed(self):
        from safetensors.torch import save_file

        held = {
            'encoder.conv_in.weight': torch.ones(1),
            'encoder.quant_conv.weight': torch.full((1,), 2.0),
            'decoder.post_quant_conv.bias': torch.full((1,), 3.0),
            'decoder.conv_out.bias': torch.full((1,), 4.0),
            'bn.running_mean': torch.full((2,), 5.0),
            'bn.running_var': torch.full((2,), 6.0),
        }
        seen = {}

        class Vae:
            config = 'the config of the class'

            def load_state_dict(self, state, strict):
                seen['state'], seen['strict'] = {key: value.tolist() for key, value in state.items()}, strict

            def eval(self):
                seen['eval'] = True
                return self

        def converted(plain, config):
            seen['asked'] = (sorted(plain), config)
            return {'converted.' + key: value for key, value in plain.items()}

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as folder:
            path = Path(folder) / 'vae.safetensors'
            save_file(held, str(path))
            with (
                patch('diffusers.AutoencoderKLFlux2', Vae),
                patch('diffusers.loaders.single_file_utils.convert_ldm_vae_checkpoint', converted),
            ):
                vae = moss.load_vae(path)
        self.assertIsInstance(vae, Vae)
        # The names diffusers' conversion knows; the statistics of the latents are not its own.
        self.assertEqual(
            seen['asked'],
            (['decoder.conv_out.bias', 'encoder.conv_in.weight', 'post_quant_conv.bias', 'quant_conv.weight'], 'the config of the class'),
        )
        self.assertEqual(
            seen['state'],
            {
                'converted.encoder.conv_in.weight': [1.0], 'converted.quant_conv.weight': [2.0],
                'converted.post_quant_conv.bias': [3.0], 'converted.decoder.conv_out.bias': [4.0],
                'bn.running_mean': [5.0, 5.0], 'bn.running_var': [6.0, 6.0],
            },
        )  # fmt: skip
        self.assertEqual((seen['strict'], seen['eval']), (True, True))


class PreviewTests(unittest.TestCase):
    def test_the_picture_so_far_is_drawn_from_the_128_channels_of_the_latent(self):
        import base64
        import io

        from PIL import Image

        from runner import preview

        factors, bias = preview.FLUX2
        self.assertEqual((len(factors), {len(row) for row in factors}, len(bias)), (128, {3}, 3))
        # A latent of zeros is the colour of the bias; a channel alone adds its own three weights.
        for channel, value in ((None, 0.0), (3, 4.0), (77, -4.0)):
            latent = torch.zeros(128, 2, 3)
            if channel is not None:
                latent[channel] = value
            sent = preview.picture(latent, preview.FLUX2)
            image = Image.open(io.BytesIO(base64.b64decode(sent['data'])))
            self.assertEqual((sent['mime'], image.size), ('image/jpeg', (3, 2)))
            row = factors[channel] if channel is not None else (0, 0, 0)
            expected = [round((min(1, max(-1, bias[i] + value * row[i])) + 1) * 127.5) for i in range(3)]
            self.assertTrue(all(abs(got - want) <= 6 for got, want in zip(image.getpixel((1, 1)), expected)), (channel, expected))


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.folder.cleanup)
        self.tokenizer = Path(self.folder.name) / 'qwen35_tokenizer'
        self.tokenizer.mkdir()
        from runner.tests.test_moss_image import REAL, header_of

        self.headers = {
            'model': header_of(REAL),
            'encoder': {'model.language_model.embed_tokens.weight': {'shape': [248320, 4096]}},
            'vae': {'bn.running_mean': {'shape': [128]}, 'decoder.conv_in.weight': {'shape': [512, 32, 3, 3]}},
        }

    def check(self, **components):
        job = dict(components={**dict(model='model', textEncoder='encoder', vae='vae', tokenizer=str(self.tokenizer)), **components})
        with patch.object(moss, 'header', lambda path: self.headers[str(path)]):
            return moss.preflight(job, {})

    def test_files_that_are_the_models_own_pass_and_the_others_are_named_in_the_users_words(self):
        self.assertIsNone(self.check())
        for tokenizer in (None, '', str(self.tokenizer / 'absent'), str(Path(self.folder.name) / 'file.json')):
            with self.assertRaisesRegex(ValueError, 'tokenizer de Qwen3.5 .dossier qwen35_tokenizer.'):
                self.check(tokenizer=tokenizer)
        self.headers['other'] = {'blocks.0.attn.qkv.weight': {'shape': [4, 4]}}
        with self.assertRaisesRegex(ValueError, 'n’est pas un modèle MOSS Image'):
            self.check(model='other')
        # The image model given as its own text encoder (seen in a workflow of the user), a smaller Qwen.
        with self.assertRaisesRegex(ValueError, 'Qwen3.5 9B .* ce fichier n’en est pas un'):
            self.check(textEncoder='model')
        self.headers['small'] = {'model.language_model.embed_tokens.weight': {'shape': [248320, 2048]}}
        with self.assertRaisesRegex(ValueError, 'Qwen3.5 9B'):
            self.check(textEncoder='small')
        # The same encoder in 4-bit weights, which ComfyUI reads and this engine does not yet.
        self.headers['w4a8'] = {
            'model.language_model.embed_tokens.weight': {'shape': [248320, 4096]},
            'model.language_model.layers.0.mlp.gate_proj.weight_codebook': {'shape': [16]},
        }
        with self.assertRaisesRegex(ValueError, '4 bits .W4A8.*mossImage_sft_txt_int8'):
            self.check(textEncoder='w4a8')
        # (A codebook elsewhere in the file, the vision tower's, is not the language model's.)
        self.headers['other'] = {**self.headers['encoder'], 'model.visual.blocks.0.attn.qkv.weight_codebook': {'shape': [16]}}
        self.assertIsNone(self.check(textEncoder='other'))
        with self.assertRaisesRegex(ValueError, 'celui de FLUX.2'):
            self.check(vae='encoder')
        self.headers['wide'] = {'bn.running_mean': {'shape': [64]}}
        with self.assertRaisesRegex(ValueError, 'celui de FLUX.2'):
            self.check(vae='wide')
        with patch('importlib.util.find_spec', lambda name: None), self.assertRaisesRegex(RuntimeError, 'comfy-kitchen'):
            self.check()


if __name__ == '__main__':
    unittest.main()
