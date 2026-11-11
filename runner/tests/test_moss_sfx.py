import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from runner.pipelines import moss_sfx
from runner.registry import validate_job

TORCH = importlib.util.find_spec('torch') is not None


def model_folder(root, class_name='MossSoundEffectPipeline', vae='vae_128d_48k.pth'):
    folder = Path(root) / 'MOSS-SoundEffect-v2.0'
    for part in ('transformer', 'text_encoder', 'tokenizer', 'vae'):
        (folder / part).mkdir(parents=True)
    (folder / 'model_index.json').write_text(json.dumps({'_class_name': class_name}), encoding='utf-8')
    (folder / 'transformer' / 'config.json').write_text('{}', encoding='utf-8')
    (folder / 'transformer' / 'diffusion_pytorch_model.safetensors').write_bytes(b'')
    if vae:
        (folder / 'vae' / vae).write_bytes(b'')
    return folder


def sound_job(folder, **parameters):
    values = dict(prompt='Rain on a tin roof', seconds=10, seed=1, steps=100, guidance_scale=4, shift=5)
    values.update(parameters)
    return dict(
        schemaVersion=1,
        id='sfx',
        pipeline='moss_sfx',
        mediaType='audio',
        workflowId='effects',
        workflowDigest='d' * 64,
        parameters=values,
        components=dict(soundModel=str(folder)),
        loras=[],
        references=[],
    )


class MossSoundEffectTests(unittest.TestCase):
    def test_a_job_names_a_complete_folder_and_at_most_thirty_seconds(self):
        with tempfile.TemporaryDirectory() as root:
            folder = model_folder(root)
            validate_job(sound_job(folder))
            moss_sfx.preflight(sound_job(folder), {})
            with self.assertRaisesRegex(ValueError, 'seconds'):
                validate_job(sound_job(folder, seconds=31))
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(ValueError, 'MossSoundEffectPipeline'):
                moss_sfx.preflight(sound_job(model_folder(root, class_name='AceStepPipeline')), {})
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(ValueError, 'VAE'):
                moss_sfx.preflight(sound_job(model_folder(root, vae=None)), {})

    @unittest.skipUnless(TORCH, 'torch is not installed')
    def test_the_published_weight_norm_folds_into_plain_convolutions(self):
        import torch

        from runner.models.moss_sfx import fold_weight_norm

        conv = torch.nn.ConvTranspose1d(6, 4, 4, 2)
        v, g = torch.randn_like(conv.weight), torch.rand(6, 1, 1) + 0.5
        folded = fold_weight_norm({'c.weight_v': v, 'c.weight_g': g, 'c.bias': conv.bias})
        expected = g * v / v.flatten(1).norm(dim=1).view(-1, 1, 1)
        self.assertTrue(torch.allclose(folded['c.weight'], expected))
        self.assertEqual(sorted(folded), ['c.bias', 'c.weight'])

    @unittest.skipUnless(TORCH, 'torch is not installed')
    def test_the_flow_runs_from_pure_noise_towards_the_sound(self):
        from runner.models.moss_sfx import sigmas

        levels = sigmas(4, 5.0).tolist()
        self.assertEqual(levels[0], 1.0)
        self.assertTrue(all(a > b for a, b in zip(levels, levels[1:], strict=False)))
        self.assertAlmostEqual(levels[-1], 5 * 0.25 / (1 + 4 * 0.25))


if __name__ == '__main__':
    unittest.main()
