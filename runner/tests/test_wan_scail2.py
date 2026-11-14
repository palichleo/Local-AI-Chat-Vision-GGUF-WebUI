import math
import unittest

import torch

from runner.models import wan_scail2

TEXT, IMAGE = 32, 8


def small():
    """A Wan transformer of two small blocks with the embeddings of SCAIL-2, weights drawn at random."""
    from diffusers import WanTransformer3DModel

    torch.manual_seed(0)
    model = WanTransformer3DModel(
        num_attention_heads=2,
        attention_head_dim=12,
        in_channels=wan_scail2.STREAM_CHANNELS,
        out_channels=wan_scail2.LATENT_CHANNELS,
        text_dim=TEXT,
        freq_dim=16,
        ffn_dim=48,
        num_layers=2,
        image_dim=IMAGE,
        added_kv_proj_dim=24,
        rope_max_seq_len=256,
    )
    return wan_scail2.extend(model).eval()


def inputs(frames=3, height=8, width=8):
    torch.manual_seed(1)
    return dict(
        video=torch.randn(1, 20, frames, height, width),
        timestep=torch.tensor([500]),
        text=torch.randn(1, wan_scail2.TEXT_TOKENS, TEXT),
        image=torch.randn(1, 5, IMAGE),
        reference=torch.randn(1, 20, 1, height, width),
    )


class ForwardTests(unittest.TestCase):
    def test_without_pose_an_animation_is_diffusers_own_computation_on_the_reference_then_the_video(self):
        model, given = small(), inputs()
        with torch.no_grad():
            ours = wan_scail2.forward(model, **given, replace=False)
            theirs = model(
                hidden_states=torch.cat([given['reference'], given['video']], dim=2),
                timestep=given['timestep'],
                encoder_hidden_states=given['text'],
                encoder_hidden_states_image=given['image'],
                return_dict=False,
            )[0]
        self.assertEqual(tuple(ours.shape), (1, 16, 3, 8, 8))
        # The reference frame is computed with the video and left out of the result.
        self.assertLess((ours - theirs[:, :, 1:]).abs().max().item(), 1e-5)

    def test_the_pose_and_the_masks_reach_the_video_and_only_the_video_comes_out(self):
        model, given = small(), inputs()
        torch.manual_seed(2)
        pose, pose_mask = torch.randn(1, 20, 3, 4, 4), torch.rand(1, 28, 3, 4, 4).round()
        reference_mask = torch.rand(1, 28, 1, 8, 8).round()
        with torch.no_grad():
            plain = wan_scail2.forward(model, **given)
            posed = wan_scail2.forward(model, **given, pose=pose)
            masked = wan_scail2.forward(model, **given, pose=pose, pose_mask=pose_mask, reference_mask=reference_mask)
            again = wan_scail2.forward(model, **given, pose=pose, pose_mask=pose_mask, reference_mask=reference_mask)
            animated = wan_scail2.forward(model, **given, pose=pose, replace=False)
        for result in (plain, posed, masked, animated):
            self.assertEqual(tuple(result.shape), (1, 16, 3, 8, 8))
        self.assertGreater((posed - plain).abs().max().item(), 1e-3)
        self.assertGreater((masked - posed).abs().max().item(), 1e-3)
        self.assertGreater((animated - posed).abs().max().item(), 1e-3)
        self.assertEqual((again - masked).abs().max().item(), 0)
        with self.assertRaisesRegex(ValueError, 'half the size'):
            wan_scail2.forward(model, **given, pose=torch.randn(1, 20, 3, 8, 8))
        with self.assertRaisesRegex(ValueError, '512 text tokens'):
            wan_scail2.forward(model, **dict(given, text=given['text'][:, :100]))


class AttentionTests(unittest.TestCase):
    def test_queries_are_turned_as_diffusers_turns_them(self):
        torch.manual_seed(3)
        rope = small().rope
        cos, sin = wan_scail2.rotations(rope, 2, 4, 6, replace=True)
        value = torch.randn(1, cos.shape[1], 2, 12)
        ours = wan_scail2.turned(value, cos.float(), sin.float())
        # diffusers' own lines (WanAttnProcessor), kept here as the reference.
        x1, x2 = value.unflatten(-1, (-1, 2)).unbind(-1)
        theirs = torch.empty_like(value)
        theirs[..., 0::2] = x1 * cos.float()[..., 0::2] - x2 * sin.float()[..., 1::2]
        theirs[..., 1::2] = x1 * sin.float()[..., 1::2] + x2 * cos.float()[..., 0::2]
        self.assertLess((ours - theirs).abs().max().item(), 1e-6)

    @unittest.skipUnless(torch.cuda.is_available(), 'the INT8 attention kernel runs on the GPU')
    def test_the_int8_kernel_gives_the_attention_of_the_blocks_within_its_rounding(self):
        if not wan_scail2.int8_attention_ready():
            self.skipTest('no INT8 attention kernel for this GPU')
        from diffusers import WanTransformer3DModel

        torch.manual_seed(4)
        # Heads of the real size (128): the kernel is written for them.
        model = WanTransformer3DModel(
            num_attention_heads=2,
            attention_head_dim=128,
            in_channels=20,
            out_channels=16,
            text_dim=TEXT,
            freq_dim=16,
            ffn_dim=64,
            num_layers=1,
            image_dim=IMAGE,
            added_kv_proj_dim=256,
            rope_max_seq_len=256,
        )
        model = wan_scail2.extend(model).eval().to('cuda', torch.bfloat16)
        given = {name: value.to('cuda') for name, value in inputs(frames=2, height=16, width=16).items()}
        given = {name: value if name == 'timestep' else value.to(torch.bfloat16) for name, value in given.items()}
        pose = torch.randn(1, 20, 2, 8, 8, device='cuda', dtype=torch.bfloat16)
        with torch.no_grad():
            exact = wan_scail2.forward(model, **given, pose=pose).float()
            self.assertTrue(wan_scail2.use_int8_attention(model))
            self.assertIsInstance(model.blocks[0].attn1.processor, wan_scail2.Int8SelfAttention)
            fast = wan_scail2.forward(model, **given, pose=pose).float()
        cosine = torch.nn.functional.cosine_similarity(exact.flatten(), fast.flatten(), dim=0).item()
        self.assertGreater(cosine, 0.99)


class RotationTests(unittest.TestCase):
    def test_the_reference_is_moved_down_and_the_pose_right_with_its_rotations_averaged(self):
        rope = small().rope
        frames, rows, columns = 2, 4, 6
        cos, sin = wan_scail2.rotations(rope, frames, rows, columns, replace=True)
        video, pose = rows * columns, (rows // 2) * (columns // 2)
        self.assertEqual(tuple(cos.shape), (1, video * (1 + frames) + pose * frames, 1, 12))
        t, h = rope.t_dim, rope.h_dim
        table = rope.freqs_cos.float()
        # The first frequency of each axis turns by one radian a position.
        self.assertAlmostEqual(table[3, 0].item(), math.cos(3), places=5)
        # Reference, row 1, column 2: time 0, 120 rows down, its own column.
        token = cos[0, 1 * columns + 2, 0]
        self.assertTrue(torch.allclose(token[:t], table[0, :t]))
        self.assertTrue(torch.allclose(token[t : t + h], table[120 + 1, t : t + h]))
        self.assertTrue(torch.allclose(token[t + h :], table[2, t + h :]))
        # Video, second frame, row 3, column 5: time 1 when a character is replaced (the video
        # starts at time 0), time 2 when one is animated (the reference keeps time 0 to itself).
        index = video + video + 3 * columns + 5
        self.assertTrue(torch.allclose(cos[0, index, 0, :t], table[1, :t]))
        self.assertTrue(torch.allclose(cos[0, index, 0, t : t + h], table[3, t : t + h]))
        animated = wan_scail2.rotations(rope, frames, rows, columns, replace=False)[0]
        self.assertTrue(torch.allclose(animated[0, index, 0, :t], table[2, :t]))
        self.assertTrue(torch.allclose(animated[0, 1 * columns + 2, 0, t : t + h], table[1, t : t + h]))
        # Pose, second frame, token (1, 2): the video's rows 2-3 and columns 4-5, 120 columns to
        # the right, their rotations averaged, so shorter than one where they differ.
        token = video * (1 + frames) + pose + 1 * (columns // 2) + 2
        self.assertTrue(torch.allclose(cos[0, token, 0, :t], table[1, :t]))
        rows_mean = (table[2, t : t + h] + table[3, t : t + h]) / 2
        columns_mean = (table[124, t + h :] + table[125, t + h :]) / 2
        self.assertTrue(torch.allclose(cos[0, token, 0, t : t + h], rows_mean, atol=1e-6))
        self.assertTrue(torch.allclose(cos[0, token, 0, t + h :], columns_mean, atol=1e-6))
        length = (cos[0, token, 0, t] ** 2 + sin[0, token, 0, t] ** 2).sqrt().item()
        self.assertAlmostEqual(length, math.cos(0.5), places=5)
        # Without a pose: the reference and the video alone; an odd grid cannot be averaged.
        self.assertEqual(wan_scail2.rotations(rope, frames, rows, columns, True, pose=False)[0].shape[1], video * 3)
        with self.assertRaisesRegex(ValueError, 'multiples of 32'):
            wan_scail2.rotations(rope, frames, 3, columns, True)


class LayoutTests(unittest.TestCase):
    def header(self):
        """The header of a SCAIL-2 file in ComfyUI's layout, sizes taken from the model itself."""
        shapes = {name: list(parameter.shape) for name, parameter in wan_scail2.architecture().named_parameters()}
        header = {'__metadata__': {'format': 'pt'}}

        def tensor(key, quantised=False):
            header[key] = dict(dtype='I8' if quantised else 'F16', shape=shapes[wan_scail2.renamed(key)])
            if quantised:
                header[key + '_scale'] = dict(dtype='F32', shape=[header[key]['shape'][0], 1])
                header[key.removesuffix('.weight') + '.comfy_quant'] = dict(dtype='U8', shape=[64])

        for index in range(wan_scail2.LAYERS):
            block = f'blocks.{index}.'
            tensor(block + 'modulation')
            for name in ('self_attn.q', 'self_attn.k', 'self_attn.v', 'self_attn.o', 'ffn.0', 'ffn.2'):
                tensor(block + name + '.weight', quantised=True)
                tensor(block + name + '.bias')
            for name in ('q', 'k', 'v', 'o', 'k_img', 'v_img'):
                tensor(block + 'cross_attn.' + name + '.weight', quantised=True)
                tensor(block + 'cross_attn.' + name + '.bias')
            for name in ('self_attn.norm_q', 'self_attn.norm_k', 'cross_attn.norm_q', 'cross_attn.norm_k'):
                tensor(block + name + '.weight')
            tensor(block + 'cross_attn.norm_k_img.weight')
            tensor(block + 'norm3.weight')
            tensor(block + 'norm3.bias')
        outside = ('time_embedding.0', 'time_embedding.2', 'time_projection.1', 'text_embedding.0', 'text_embedding.2')
        outside += ('img_emb.proj.0', 'img_emb.proj.1', 'img_emb.proj.3', 'img_emb.proj.4', 'head.head')
        outside += ('patch_embedding', 'patch_embedding_pose', 'patch_embedding_mask')
        for name in outside:
            tensor(name + '.weight')
            tensor(name + '.bias')
        tensor('head.modulation')
        return header

    def test_every_tensor_of_the_file_has_its_place_in_the_model(self):
        header = self.header()
        names = wan_scail2.validate_layout(header)
        self.assertEqual(names['blocks.7.attn2.add_k_proj.weight'], ('model', 'blocks.7.cross_attn.k_img.weight', None))
        self.assertEqual(names['blocks.0.norm2.bias'], ('model', 'blocks.0.norm3.bias', None))
        self.assertEqual(names['scale_shift_table'], ('model', 'head.modulation', None))
        self.assertEqual(names['patch_embedding_mask.weight'][1], 'patch_embedding_mask.weight')
        self.assertEqual(header['patch_embedding_mask.weight']['shape'], [5120, 28, 1, 2, 2])
        self.assertEqual(header['patch_embedding_pose.weight']['shape'], [5120, 20, 1, 2, 2])
        # What a quantised weight stores beside itself is the pool's to read, not a tensor of the model.
        self.assertFalse(any(key.endswith(('weight_scale', 'comfy_quant')) for _, key, _ in names.values()))

    def test_another_model_is_refused_with_the_tensor_that_tells(self):
        header = self.header()
        plain = {key: value for key, value in header.items() if not key.startswith('patch_embedding_pose')}
        with self.assertRaisesRegex(ValueError, 'missing patch_embedding_pose'):
            wan_scail2.validate_layout(plain)
        with self.assertRaisesRegex(ValueError, 'Unsupported SCAIL-2 tensor: blocks.0.face_adapter.weight'):
            wan_scail2.validate_layout(dict(header, **{'blocks.0.face_adapter.weight': dict(dtype='F16', shape=[1])}))
        sized = dict(header, **{'patch_embedding.weight': dict(dtype='F16', shape=[5120, 36, 1, 2, 2])})
        with self.assertRaisesRegex(ValueError, 'size: patch_embedding.weight'):
            wan_scail2.validate_layout(sized)


if __name__ == '__main__':
    unittest.main()
