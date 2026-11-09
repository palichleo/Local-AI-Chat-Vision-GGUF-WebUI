import json
from pathlib import Path
import tempfile
import unittest

from runner.contracts import validate_job


def job():
    return dict(
        schemaVersion=1,
        id='test-video',
        pipeline='ltx25',
        mediaType='video',
        workflowId='test-workflow',
        workflowDigest='a' * 64,
        components={
            role: str(Path(role + '.safetensors').resolve()) for role in ('model', 'textEncoder', 'vae', 'audioVae')
        },
        parameters=dict(
            prompt='A red balloon', seed=123, width=64, height=64, steps=8, frames=9, fps=24, stage='draft', audio=False
        ),
        loras=[],
        references=[],
    )


class VideoTests(unittest.TestCase):
    def test_distilled_video_contract_and_explicit_unsupported_features(self):
        self.assertEqual(validate_job(job())['parameters']['seed'], 123)
        refs = job()
        refs['references'] = [
            dict(input='first', role='start_image', path=str(Path('first.png').resolve())),
            dict(input='last', role='end_image', path=str(Path('last.png').resolve())),
        ]
        validate_job(refs)
        duplicate = job()
        duplicate['references'] = refs['references'][:1] * 2
        with self.assertRaises(ValueError):
            validate_job(duplicate)
        for key, value in [
            ('frames', 10),
            ('width', 72),
            ('steps', 9),
            ('steps', 8.0),
            ('cfg', True),
            ('cfg', 3),
            ('fps', 0),
            ('stage', 'automatic'),
        ]:
            value_job = job()
            value_job['parameters'][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_job(value_job)
        for key, value in [
            ('references', {}),
            ('loras', {}),
            ('references', [dict(input='ref', role='msr_image', path=str(Path('source.png').resolve()))]),
            ('loras', [{}]),
        ]:
            value_job = job()
            value_job[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_job(value_job)

    def test_video_export_retains_original_dimensions_and_replayable_manifest(self):
        import numpy as np
        import imageio.v3 as iio
        from runner.video.export import save_video

        with tempfile.TemporaryDirectory() as folder:
            value = job()
            metadata = dict(job=value, seed=123)
            pixels = np.zeros((9, 64, 64, 3), dtype=np.uint8)
            pixels[:, :, 16:48, 0] = 200
            result = save_video(pixels, {'outputRoot': folder}, value, metadata)
            filename = result['outputs'][0]['filename']
            path = Path(folder) / filename
            self.assertEqual(iio.imread(path, index=0).shape, (64, 64, 3))
            self.assertEqual(
                json.loads(path.with_suffix('.json').read_text())['metadata']['job']['parameters']['seed'], 123
            )
            self.assertEqual(len(list(Path(folder).glob('*.tmp*'))), 0)

    def test_invalid_decoded_dimensions_publish_no_original_or_manifest(self):
        import numpy as np
        from runner.video.export import save_video

        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                save_video(np.zeros((8, 64, 64, 3), dtype=np.uint8), {'outputRoot': folder}, job(), {})
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_audio_export_and_continuation_use_exact_timebase_without_duplicate_overlap(self):
        import numpy as np
        import av
        from runner.video.export import save_video
        from runner.video.continuation import source_tail

        with tempfile.TemporaryDirectory() as folder:
            value = job()
            value['parameters']['frames'] = 25
            pixels = np.zeros((25, 64, 64, 3), dtype=np.uint8)
            source = save_video(pixels, {'outputRoot': folder}, value, {})
            source_path = str(Path(folder) / source['outputs'][0]['filename'])
            tail, plan = source_tail(source_path, value['parameters'])
            self.assertEqual(len(tail), 9)
            value['references'] = [dict(input='source', role='source_video', path=source_path)]
            joined = save_video(pixels, {'outputRoot': folder}, value, {'continuation': plan})
            with av.open(str(Path(folder) / joined['outputs'][0]['filename'])) as clip:
                stream = clip.streams.video[0]
                self.assertEqual(stream.average_rate, 24)
                self.assertEqual(len(list(clip.decode(stream))), 41)
            value['references'] = []
            value['parameters']['audio'] = True
            audio = save_video(
                pixels, {'outputRoot': folder}, value, {}, audio=(np.zeros((50000, 2), dtype=np.float32), 48000)
            )
            with av.open(str(Path(folder) / audio['outputs'][0]['filename'])) as clip:
                self.assertEqual(clip.streams.audio[0].rate, 48000)
            audible = str(Path(folder) / audio['outputs'][0]['filename'])
            tail, plan = source_tail(audible, value['parameters'])
            self.assertTrue(plan['sourceAudio'])
            value['references'] = [dict(input='source', role='source_video', path=audible)]
            extended = save_video(
                pixels,
                {'outputRoot': folder},
                value,
                {'continuation': plan},
                audio=(np.zeros((50000, 2), dtype=np.float32), 48000),
            )
            with av.open(str(Path(folder) / extended['outputs'][0]['filename'])) as clip:
                self.assertEqual(len(list(clip.decode(clip.streams.video[0]))), 41)
                sound = clip.streams.audio[0]
                self.assertAlmostEqual(float(sound.duration * sound.time_base), 41 / 24, delta=0.03)

    def test_continuation_audio_graph_covers_every_source_and_generation_case(self):
        from runner.video.export import continuation_audio

        self.assertIsNone(continuation_audio(False, False, 1, 0.375, 2))
        self.assertIn('acrossfade', continuation_audio(True, True, 1, 0.375, 2))
        self.assertIn('adelay=delays=1000', continuation_audio(False, True, 1, 0.375, 2))
        self.assertTrue(continuation_audio(True, False, 1, 0.375, 2).startswith('[0:a]apad'))

    def test_source_audio_mel_matches_the_encoder_preprocessing(self):
        try:
            import torch
        except ImportError:
            self.skipTest('torch is not installed')
        import numpy as np
        from runner.video.audio_tail import filterbank, log_mel, protected_latents, MELS

        bank = filterbank(torch)
        self.assertEqual(tuple(bank.shape), (513, MELS))
        # Slaney area normalization: each triangle has unit area on the Hz axis.
        hz = np.linspace(0, 8000, 513)
        self.assertTrue(np.allclose(np.trapezoid(bank.numpy().T, hz, axis=1)[1:-1], 1, atol=0.05))
        tone = np.sin(2 * np.pi * 440 * np.arange(16000) / 16000).astype(np.float32)
        mel = log_mel(np.stack([tone, tone]), torch)
        self.assertEqual(tuple(mel.shape), (1, 2, 101, MELS))
        self.assertEqual(int(mel[0, 0, 50].argmax()), int(bank[round(440 / 8000 * 512)].argmax()))
        self.assertEqual(protected_latents(9 / 24), 9)
        self.assertEqual(protected_latents(1 / 24), 1)

    def test_msr_slots_remain_distinct_and_wrong_lora_shapes_are_rejected(self):
        import torch
        from safetensors.torch import save_file
        from safetensors import safe_open
        from runner.video.msr import validate_msr, slot_embedding

        with tempfile.TemporaryDirectory() as folder:
            prefix = 'diffusion_model.reference_slot_embedding.'
            random = torch.Generator().manual_seed(5)
            values = {
                prefix + 'frequencies': torch.arange(1, 17).float(),
                prefix + 'net.0.weight': torch.randn((256, 33), generator=random) * 0.1,
                prefix + 'net.0.bias': torch.zeros(256),
                prefix + 'net.2.weight': torch.randn((128, 256), generator=random) * 0.1,
                prefix + 'net.2.bias': torch.zeros(128),
                'diffusion_model.transformer_blocks.0.attn1.to_q.lora_A.weight': torch.zeros((1, 3)),
                'diffusion_model.transformer_blocks.0.attn1.to_q.lora_B.weight': torch.zeros((2, 1)),
            }
            metadata = {
                'reference_slot_embedding_enabled': 'True',
                'reference_slot_embedding_type': 'fourier_mlp',
                'reference_slot_time_offsets': 'pic1_based_negative_time',
                'reference_slot_embedding_dim': '128',
            }
            path = str(Path(folder) / 'slots.safetensors')
            save_file(values, path, metadata=metadata)
            value_job = job()
            value_job['loras'] = [dict(id='slots', path=path, strength=1)]
            headers = {'model': {'model.diffusion_model.transformer_blocks.0.attn1.to_q.weight': {'shape': [2, 3]}}}
            validate_msr(value_job, headers)
            with safe_open(path, framework='pt') as source:
                first = slot_embedding(1, source, torch, 'cpu', torch.float32)
                second = slot_embedding(2, source, torch, 'cpu', torch.float32)
                self.assertEqual(list(first.shape), [128])
                self.assertTrue(torch.isfinite(first).all())
                self.assertFalse(torch.allclose(first, second))
            headers['model']['model.diffusion_model.transformer_blocks.0.attn1.to_q.weight']['shape'] = [4, 3]
            with self.assertRaisesRegex(ValueError, 'pair'):
                validate_msr(value_job, headers)


if __name__ == '__main__':
    unittest.main()
