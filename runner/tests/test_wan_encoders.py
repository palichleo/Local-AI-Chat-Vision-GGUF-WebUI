import os
import tempfile
import unittest

import torch

from runner.models import wan_clip, wan_scail2, wan_text, wan_vae
from runner.video import scail

CUDA = torch.cuda.is_available()
TINY_TEXT = dict(
    vocab_size=100,
    d_model=32,
    d_kv=8,
    d_ff=64,
    num_layers=2,
    num_heads=4,
    relative_attention_num_buckets=32,
    relative_attention_max_distance=128,
    dense_act_fn='gelu_new',
    feed_forward_proj='gated-gelu',
)
TINY_CLIP = dict(
    hidden_size=32,
    intermediate_size=64,
    num_hidden_layers=3,
    num_attention_heads=4,
    patch_size=14,
    image_size=224,
    hidden_act='gelu',
    layer_norm_eps=1e-5,
    projection_dim=16,
)


class TextTests(unittest.TestCase):
    def test_a_prompt_is_cleaned_and_cut_to_512_tokens_with_its_end_mark(self):
        self.assertEqual(wan_text.clean('  a &amp;amp; b \n\t c  '), 'a & b c')

        class Pieces:
            def encode(self, text):
                return [7] * len(text.split())

        self.assertEqual(wan_text.token_ids('one two  three', Pieces()), [7, 7, 7, 1])
        long = wan_text.token_ids(' '.join(['word'] * 900), Pieces())
        self.assertEqual((len(long), long[-1], long[-2]), (512, 1, 7))

    def test_the_file_must_hold_every_tensor_of_the_encoder_at_its_size(self):
        from transformers import UMT5Config, UMT5EncoderModel

        model = UMT5EncoderModel(UMT5Config(**TINY_TEXT))
        header = {name: {'shape': list(value.shape)} for name, value in model.state_dict().items()}
        del header['encoder.embed_tokens.weight']
        names = wan_text.names(header, model)
        # The tokens are read from the one table the file stores.
        self.assertEqual(names['encoder.embed_tokens.weight'], ('textEncoder', 'shared.weight', None))
        self.assertEqual(names['shared.weight'], ('textEncoder', 'shared.weight', None))
        key = 'encoder.block.1.layer.1.DenseReluDense.wo.weight'
        with self.assertRaisesRegex(ValueError, 'missing ' + key):
            wan_text.names({name: value for name, value in header.items() if name != key}, model)
        with self.assertRaisesRegex(ValueError, 'size: ' + key):
            wan_text.names(dict(header, **{key: {'shape': [1, 1]}}), model)

    def test_the_feed_forward_computed_here_is_the_one_of_transformers(self):
        import types

        from transformers import UMT5Config, UMT5EncoderModel

        torch.manual_seed(0)
        dense = UMT5EncoderModel(UMT5Config(**TINY_TEXT)).eval().encoder.block[0].layer[1].DenseReluDense
        rows = torch.randn(1, 5, 32)
        with torch.no_grad():
            theirs = dense(rows)
            ours = types.MethodType(wan_text._gated, dense)(rows)
        self.assertLess((ours - theirs).abs().max().item(), 1e-6)

    @unittest.skipUnless(CUDA, 'the encoder is streamed to the GPU')
    def test_an_fp8_scaled_file_gives_the_states_of_the_encoder_zeros_after_the_prompt(self):
        from safetensors.torch import save_file
        from transformers import UMT5Config, UMT5EncoderModel

        from runner.models.pool import WeightPool
        from runner.models.residency import RESIDENCY, open_store

        torch.manual_seed(1)
        reference = UMT5EncoderModel(UMT5Config(**TINY_TEXT)).eval()
        stored = {}
        for name, value in reference.state_dict().items():
            if name == 'encoder.embed_tokens.weight':
                continue
            if value.ndim == 2 and 'SelfAttention.relative' not in name and name != 'shared.weight':
                # 8-bit floats and one scale a weight, as ComfyUI's « fp8 scaled » files.
                scale = value.abs().max() / 8
                small = (value / scale).to(torch.float8_e4m3fn)
                stored[name] = small
                stored[name.removesuffix('.weight') + '.scale_weight'] = scale
                value.copy_(small.float() * scale)
            else:
                stored[name] = value.to(torch.float16)
                value.copy_(stored[name].float())
        ids = [5, 17, 42, 9, 1]
        with torch.no_grad():
            expected = reference(input_ids=torch.tensor([ids])).last_hidden_state
        try:
            with tempfile.TemporaryDirectory() as folder:
                path = os.path.join(folder, 'umt5.safetensors')
                save_file(stored, path)
                from runner.models.headers import header

                model = wan_text.architecture(TINY_TEXT)
                found = wan_text.names(header(path), model)
                with open_store(path, evict=False) as source:
                    pool = WeightPool({'textEncoder': source}, 0)
                    try:
                        result = wan_text.embed(wan_text.streamed(model, found, pool), ids)
                    finally:
                        pool.clear()
        finally:
            RESIDENCY.clear()
        self.assertEqual(tuple(result.shape), (1, wan_text.TOKENS, 32))
        self.assertEqual(result[:, len(ids) :].abs().max().item(), 0)
        got = result[0, : len(ids)].float()
        cosine = torch.nn.functional.cosine_similarity(got.flatten(), expected[0].flatten(), dim=0).item()
        self.assertGreater(cosine, 0.999)


class ImageTests(unittest.TestCase):
    @unittest.skipUnless(CUDA, 'the image encoder runs on the GPU')
    def test_the_video_model_reads_the_last_block_but_one_of_the_stretched_image(self):
        from safetensors.torch import save_file
        from transformers import CLIPVisionConfig, CLIPVisionModel

        torch.manual_seed(2)
        reference = CLIPVisionModel(CLIPVisionConfig(**TINY_CLIP)).eval()
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, 'clip.safetensors')
            # ComfyUI's file names the tower `vision_model.` and holds a projection beside it.
            state = reference.state_dict().items()
            stored = {'vision_model.' + key.removeprefix('vision_model.'): value for key, value in state}
            stored['visual_projection.weight'] = torch.zeros(16, 32)
            save_file(stored, path)
            model = wan_clip.load(path, TINY_CLIP)
            with self.assertRaisesRegex(ValueError, 'missing'):
                save_file({'visual_projection.weight': torch.zeros(16, 32)}, path)
                wan_clip.load(path, TINY_CLIP)
        image = torch.rand(1, 3, 96, 160, device='cuda') * 2 - 1
        tokens = wan_clip.image_tokens(model, image)
        self.assertEqual(tuple(tokens.shape), (1, 257, 32))
        # By hand: stretched to 224 x 224, CLIP's mean and deviation, the state before the last block.
        resize = torch.nn.functional.interpolate
        pixels = resize(image * 0.5 + 0.5, size=(224, 224), mode='bicubic', align_corners=False)
        mean = torch.tensor(wan_clip.MEAN, device='cuda').view(1, 3, 1, 1)
        std = torch.tensor(wan_clip.STD, device='cuda').view(1, 3, 1, 1)
        with torch.no_grad():
            states = reference.cuda()(pixel_values=(pixels - mean) / std, output_hidden_states=True).hidden_states
        self.assertEqual(len(states), 4)
        self.assertLess((tokens.float() - states[-2]).abs().max().item(), 0.05)
        self.assertGreater((states[-1] - states[-2]).abs().max().item(), 0.05)


class VaeTests(unittest.TestCase):
    def test_every_name_of_the_original_code_has_its_place_in_diffusers_model(self):
        from accelerate import init_empty_weights
        from diffusers import AutoencoderKLWan

        with init_empty_weights():
            wanted = set(AutoencoderKLWan().state_dict())
        cases = {
            'conv1.weight': 'quant_conv.weight',
            'conv2.bias': 'post_quant_conv.bias',
            'encoder.conv1.weight': 'encoder.conv_in.weight',
            'encoder.downsamples.3.residual.2.weight': 'encoder.down_blocks.3.conv1.weight',
            'encoder.downsamples.3.residual.0.gamma': 'encoder.down_blocks.3.norm1.gamma',
            'encoder.downsamples.3.shortcut.bias': 'encoder.down_blocks.3.conv_shortcut.bias',
            'encoder.downsamples.5.resample.1.weight': 'encoder.down_blocks.5.resample.1.weight',
            'encoder.downsamples.5.time_conv.weight': 'encoder.down_blocks.5.time_conv.weight',
            'encoder.middle.0.residual.6.weight': 'encoder.mid_block.resnets.0.conv2.weight',
            'encoder.middle.1.to_qkv.weight': 'encoder.mid_block.attentions.0.to_qkv.weight',
            'encoder.middle.2.residual.3.gamma': 'encoder.mid_block.resnets.1.norm2.gamma',
            'encoder.head.0.gamma': 'encoder.norm_out.gamma',
            'encoder.head.2.bias': 'encoder.conv_out.bias',
            'decoder.conv1.weight': 'decoder.conv_in.weight',
            'decoder.middle.1.norm.gamma': 'decoder.mid_block.attentions.0.norm.gamma',
            'decoder.upsamples.0.residual.2.weight': 'decoder.up_blocks.0.resnets.0.conv1.weight',
            'decoder.upsamples.3.time_conv.weight': 'decoder.up_blocks.0.upsamplers.0.time_conv.weight',
            'decoder.upsamples.4.shortcut.weight': 'decoder.up_blocks.1.resnets.0.conv_shortcut.weight',
            'decoder.upsamples.11.resample.1.bias': 'decoder.up_blocks.2.upsamplers.0.resample.1.bias',
            'decoder.upsamples.14.residual.6.bias': 'decoder.up_blocks.3.resnets.2.conv2.bias',
            'decoder.head.2.weight': 'decoder.conv_out.weight',
        }
        for key, name in cases.items():
            self.assertEqual(wan_vae.renamed(key), name)
            self.assertIn(name, wanted)
        for key in ('model.conv1.weight', 'encoder.upsamples.0.residual.2.weight', 'decoder.tail.weight'):
            with self.assertRaisesRegex(ValueError, 'Unsupported Wan VAE tensor'):
                wan_vae.renamed(key)


class PreparationTests(unittest.TestCase):
    def test_a_picture_is_resized_to_fill_the_frame_and_cut_in_its_middle(self):
        wide = torch.zeros(3, 10, 40)
        wide[:, :, 16:24] = 1
        cut = scail.cover(wide, 16, 8)
        self.assertEqual(tuple(cut.shape), (3, 8, 16))
        # The middle of the picture is what is left: the lit band, now 6 or 7 columns of 16.
        self.assertGreater(cut[0, 4, 6:10].min().item(), 0.9)
        self.assertLess(cut[0, 4, :2].abs().max().item(), 0.1)
        video = scail.cover(torch.zeros(5, 3, 30, 20), 16, 8)
        self.assertEqual(tuple(video.shape), (5, 3, 8, 16))
        self.assertEqual(tuple(scail.halved(torch.zeros(5, 3, 16, 32)).shape), (5, 3, 8, 16))

    def test_coloured_masks_become_28_channels_seven_colours_for_each_of_four_frames(self):
        black, white = (-1.0, -1.0, -1.0), (1.0, 1.0, 1.0)
        colours = [white, (1, -1, -1), (-1, 1, -1), (-1, -1, 1), (1, 1, -1), (1, -1, 1), (-1, 1, 1)]
        masks = torch.empty(5, 3, 16, 16)
        masks[:] = torch.tensor(black).view(1, 3, 1, 1)
        # First frame: blue everywhere. Third frame: the top-left square of 8 half red, half white.
        masks[0] = torch.tensor(colours[3]).view(3, 1, 1)
        masks[2, :, :8, :4] = torch.tensor(colours[1]).view(3, 1, 1)
        masks[2, :, :8, 4:8] = torch.tensor(colours[0]).view(3, 1, 1)
        latents = scail.mask_latents(masks)
        self.assertEqual(tuple(latents.shape), (28, 2, 2, 2))
        # The first latent frame is the first frame four times: blue (channel 3) at 0, 7, 14, 21.
        first = latents[:, 0]
        self.assertEqual([index for index in range(28) if first[index].max() > 0], [3, 10, 17, 24])
        self.assertEqual(first[3].min().item(), 1)
        # The second holds frames 1 to 4; frame 2 is its second: channels 7 (white) and 8 (red),
        # half of the top-left square each. Black lights nothing.
        second = latents[:, 1]
        self.assertEqual([index for index in range(28) if second[index].max() > 0], [7, 8])
        self.assertEqual((second[7, 0, 0].item(), second[8, 0, 0].item(), second[7, 1, 1].item()), (0.5, 0.5, 0))
        # A colour not fully lit is not a colour (225 of 255 at least).
        dim = torch.full((1, 3, 8, 8), 0.7)
        self.assertEqual(scail.mask_latents(dim).abs().max().item(), 0)
        with self.assertRaisesRegex(ValueError, '4n \\+ 1'):
            scail.mask_latents(masks[:4])

    def test_the_four_channels_that_say_what_is_given_and_the_noise_levels(self):
        latents = torch.zeros(16, 3, 4, 4)
        self.assertEqual(tuple(scail.given(latents).shape), (20, 3, 4, 4))
        self.assertEqual(scail.given(latents)[16:].min().item(), 1)
        self.assertEqual(scail.given(latents, 0)[16:].max().item(), 0)
        levels = scail.sigmas(6, 5)
        self.assertEqual((len(levels), levels[0], levels[-1]), (7, 1.0, 0.0))
        self.assertTrue(all(first > second for first, second in zip(levels, levels[1:])))
        # Half-way, moved by the shift: 5 x 0.5 / (1 + 4 x 0.5).
        self.assertAlmostEqual(levels[3], 2.5 / 3)
        self.assertEqual(scail.sigmas(4, 1), [1.0, 0.75, 0.5, 0.25, 0.0])


class LoraTests(unittest.TestCase):
    def header(self):
        return {
            'blocks.0.self_attn.q.weight': {'shape': [8, 8]},
            'blocks.0.self_attn.q.bias': {'shape': [8]},
            'blocks.0.norm3.weight': {'shape': [8]},
            'blocks.0.norm3.bias': {'shape': [8]},
        }

    def lora(self):
        stem = 'diffusion_model.blocks.0.'
        return {
            stem + 'self_attn.q.lora_down.weight': {'shape': [2, 8]},
            stem + 'self_attn.q.lora_up.weight': {'shape': [8, 2]},
            stem + 'self_attn.q.diff_b': {'shape': [8]},
            stem + 'norm3.diff': {'shape': [8]},
            stem + 'norm3.diff_b': {'shape': [8]},
        }

    def test_a_distillation_lora_brings_differences_for_biases_and_norms_beside_its_pairs(self):
        found = wan_scail2.lora_differences(self.lora(), self.header())
        self.assertEqual(
            found,
            {
                'blocks.0.self_attn.q.bias': 'diffusion_model.blocks.0.self_attn.q.diff_b',
                'blocks.0.norm3.weight': 'diffusion_model.blocks.0.norm3.diff',
                'blocks.0.norm3.bias': 'diffusion_model.blocks.0.norm3.diff_b',
            },
        )
        wan_scail2.validate_lora(self.lora(), self.header())
        # A difference for a tensor the model has not, or of another size, is refused.
        other = dict(self.lora(), **{'diffusion_model.blocks.0.norm9.diff': {'shape': [8]}})
        with self.assertRaisesRegex(ValueError, 'fits no tensor'):
            wan_scail2.validate_lora(other, self.header())
        orphan = dict(self.lora(), **{'diffusion_model.blocks.0.extra.weight': {'shape': [8]}})
        with self.assertRaisesRegex(ValueError, 'orphan tensors'):
            wan_scail2.validate_lora(orphan, self.header())
        with self.assertRaisesRegex(ValueError, 'none of its layers'):
            foreign = {'x.lora_A.weight': {'shape': [2, 8]}, 'x.lora_B.weight': {'shape': [8, 2]}}
            wan_scail2.validate_lora(foreign, self.header())

    @unittest.skipUnless(CUDA, 'the differences are added on the GPU')
    def test_differences_go_to_the_bias_of_a_pooled_layer_and_to_the_other_tensors_themselves(self):
        from types import SimpleNamespace

        class Store:
            def __init__(self, tensors):
                self.tensors = tensors

            def keys(self):
                return list(self.tensors)

            def get_tensor(self, key):
                return self.tensors[key]

            def get_slice(self, key):
                return SimpleNamespace(get_shape=lambda: list(self.tensors[key].shape))

        stem = 'diffusion_model.blocks.0.'
        lora = Store(
            {
                stem + 'self_attn.q.diff_b': torch.full((8,), 2.0),
                stem + 'norm3.diff': torch.full((8,), 3.0),
                stem + 'norm3.diff_b': torch.full((8,), 4.0),
                stem + 'self_attn.q.lora_down.weight': torch.zeros(2, 8),
            }
        )
        file = Store({key: torch.zeros(value['shape']) for key, value in self.header().items()})
        pool = SimpleNamespace(stores={'model': file, 'lora-0': lora}, shifts={}, keys=lambda source: set(file.keys()))
        # diffusers' names: the block's `norm3` is its `norm2`, its `self_attn.q` is `attn1.to_q`.
        pooled = torch.nn.Identity()
        pooled.location = ('model', 'blocks.0.self_attn.q.weight', None)
        block = torch.nn.Module()
        block.attn1 = torch.nn.Module()
        block.attn1.to_q = pooled
        block.norm2 = torch.nn.LayerNorm(8).to('cuda', torch.bfloat16)
        model = torch.nn.Module()
        model.blocks = torch.nn.ModuleList([block])
        self.assertEqual(wan_scail2.add_differences(model, pool, 'lora-0', 0.5), 3)
        self.assertEqual(pool.shifts[pooled.location].tolist(), [1.0] * 8)
        self.assertEqual(block.norm2.weight.tolist(), [2.5] * 8)
        self.assertEqual(block.norm2.bias.tolist(), [2.0] * 8)
        # A second LoRA adds to what the first one left.
        wan_scail2.add_differences(model, pool, 'lora-0', 1.0)
        self.assertEqual(pool.shifts[pooled.location].tolist(), [3.0] * 8)


if __name__ == '__main__':
    unittest.main()
