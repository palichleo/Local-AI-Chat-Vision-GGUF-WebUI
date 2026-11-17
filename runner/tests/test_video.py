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

    def test_manifests_go_to_their_own_folder_when_the_application_names_one(self):
        import numpy as np
        from runner.contracts import validate_config
        from runner.media import save_image
        from runner.video.export import save_video

        with tempfile.TemporaryDirectory() as folder:
            output, manifests = Path(folder) / 'output', Path(folder) / 'manifests'
            config = validate_config(
                {'cacheRoot': str(Path(folder) / 'cache'), 'outputRoot': str(output), 'manifestRoot': str(manifests)}
            )
            value = job()
            video = save_video(np.zeros((9, 64, 64, 3), dtype=np.uint8), config, value, dict(job=value, seed=7))
            image = save_image(np.zeros((32, 32, 3), dtype=np.uint8), config, value, dict(job=value, seed=8))
            # The folder of the creations holds only them; each manifest has the creation's name.
            self.assertEqual(
                sorted(path.name for path in output.iterdir()),
                sorted([video['outputs'][0]['filename'], image['outputs'][0]['filename']]),
            )
            seeds = {
                path.stem: json.loads(path.read_text(encoding='utf-8'))['metadata']['seed']
                for path in manifests.iterdir()
            }
            self.assertEqual(
                seeds,
                {Path(video['outputs'][0]['filename']).stem: 7, Path(image['outputs'][0]['filename']).stem: 8},
            )
            with self.assertRaises(ValueError):
                validate_config({'cacheRoot': folder, 'outputRoot': folder, 'manifestRoot': 'relative'})

    def test_invalid_decoded_dimensions_publish_no_original_or_manifest(self):
        import numpy as np
        from runner.video.export import save_video

        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                save_video(np.zeros((8, 64, 64, 3), dtype=np.uint8), {'outputRoot': folder}, job(), {})
            self.assertEqual(list(Path(folder).iterdir()), [])

    def named_config(self, folder):
        from runner.contracts import validate_config

        root = Path(folder)
        return validate_config(
            {'cacheRoot': str(root / 'cache'), 'outputRoot': str(root / 'output'), 'manifestRoot': str(root / 'lists')}
        )

    def files(self, folder):
        return sorted(path.relative_to(folder).as_posix() for path in Path(folder).rglob('*') if path.is_file())

    def test_a_named_creation_goes_in_the_folder_of_its_kind_and_says_where(self):
        import numpy as np
        from runner.media import save_audio, save_image
        from runner.video.export import save_video

        with tempfile.TemporaryDirectory() as folder:
            config = self.named_config(folder)
            names = [f'2026-11-17_14-32-0{index}_model-{index}_a3f9' for index in range(3)]
            jobs = [validate_job(job() | {'outputName': name}) for name in names]
            made = [
                save_video(np.zeros((9, 64, 64, 3), dtype=np.uint8), config, jobs[0], dict(seed=1)),
                save_image(np.zeros((32, 32, 3), dtype=np.uint8), config, jobs[1], dict(seed=2)),
                save_audio(np.zeros((1, 801), dtype=np.float32), 8000, config, jobs[2], dict(seed=3)),
            ]
            said = [(result['outputs'][0]['subfolder'], result['outputs'][0]['filename']) for result in made]
            self.assertEqual(
                said, [('video', names[0] + '.mp4'), ('image', names[1] + '.png'), ('son', names[2] + '.wav')]
            )
            # Each file where its descriptor says, nothing else in the folder of the outputs (no
            # temporary file), and its manifest under its name with the others.
            self.assertEqual(self.files(Path(folder) / 'output'), sorted(f'{sub}/{name}' for sub, name in said))
            self.assertEqual(self.files(Path(folder) / 'lists'), sorted(name + '.json' for name in names))

            # The same name asked again: another suffix, and the first creation as it was.
            first = (Path(folder) / 'output' / 'image' / (names[1] + '.png')).read_bytes()
            again = save_image(np.full((32, 32, 3), 9, dtype=np.uint8), config, jobs[1], {})['outputs'][0]
            self.assertEqual(again['subfolder'], 'image')
            self.assertNotEqual(again['filename'], names[1] + '.png')
            self.assertRegex(again['filename'], r'^2026-11-17_14-32-01_model-1_[0-9a-f]{4}\.png$')
            self.assertEqual((Path(folder) / 'output' / 'image' / (names[1] + '.png')).read_bytes(), first)
            self.assertTrue((Path(folder) / 'output' / 'image' / again['filename']).is_file())

    def test_a_job_without_a_name_is_written_as_before(self):
        import numpy as np
        from runner.media import save_audio, save_image
        from runner.video.export import save_video

        with tempfile.TemporaryDirectory() as folder:
            config = self.named_config(folder)
            value = validate_job(job())
            made = [
                save_video(np.zeros((9, 64, 64, 3), dtype=np.uint8), config, value, {})['outputs'][0],
                save_image(np.zeros((32, 32, 3), dtype=np.uint8), config, value, {})['outputs'][0],
                save_audio(np.zeros((1, 801), dtype=np.float32), 8000, config, value, {})['outputs'][0],
            ]
            for item, extension in zip(made, ('mp4', 'png', 'wav')):
                self.assertEqual(item['subfolder'], '')
                self.assertRegex(item['filename'], r'^[0-9a-f]{32}\.' + extension + '$')
            # Flat, in the folder of the outputs itself: none of the three folders is made.
            self.assertEqual(self.files(Path(folder) / 'output'), sorted(item['filename'] for item in made))
            self.assertEqual([path.name for path in (Path(folder) / 'output').iterdir() if path.is_dir()], [])

    def test_a_name_that_is_not_plain_is_refused_and_writes_nothing(self):
        import numpy as np
        from runner.media import save_image

        with tempfile.TemporaryDirectory() as folder:
            config = self.named_config(folder)
            absolute = str(Path(folder).resolve() / 'elsewhere')
            odd = ('..', '../up', 'a/b', 'a\\b', absolute, 'C:name', 'a.png', 'Name', 'a b')
            odd += ('', '_a', 'a_', 'x' * 97, 5)
            for name in odd:
                value = job() | {'outputName': name}
                with self.subTest(name=name):
                    with self.assertRaises(ValueError):
                        validate_job(value)
                    with self.assertRaises(ValueError):
                        save_image(np.zeros((32, 32, 3), dtype=np.uint8), config, value, {})
            self.assertEqual(self.files(folder), [])

    def test_a_named_creation_that_fails_leaves_nothing_in_the_folders(self):
        import numpy as np
        from runner.video.export import save_video

        with tempfile.TemporaryDirectory() as folder:
            config = self.named_config(folder)
            value = job() | {'outputName': '2026-11-17_14-32-05_model_a3f9'}
            with self.assertRaises(ValueError):
                save_video(np.zeros((8, 64, 64, 3), dtype=np.uint8), config, value, {})
            self.assertEqual(self.files(folder), [])

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
        from runner.video.msr import msr_index, slot_embedding, validate_loras

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
            validate_loras(value_job, headers)
            with safe_open(path, framework='pt') as source:
                first = slot_embedding(1, source, torch, 'cpu', torch.float32)
                second = slot_embedding(2, source, torch, 'cpu', torch.float32)
                self.assertEqual(list(first.shape), [128])
                self.assertTrue(torch.isfinite(first).all())
                self.assertFalse(torch.allclose(first, second))
            # Style LoRAs go beside it, in any order: pairs for layers of this model, whatever the
            # tool that named them. The MSR one is found by its learned slots.
            layer = 'transformer_blocks.0.attn1.to_q'
            style = str(Path(folder) / 'style.safetensors')
            save_file(
                {
                    f'transformer.{layer}.lora_down.weight': torch.zeros((4, 3)),
                    f'transformer.{layer}.lora_up.weight': torch.zeros((2, 4)),
                    f'transformer.{layer}.alpha': torch.tensor(4.0),
                },
                style,
            )
            styled = job()
            styled['loras'] = [dict(id='style-0', path=style, strength=-1.5), dict(id='slots', path=path, strength=1)]
            validate_loras(styled, headers)
            self.assertEqual((msr_index(styled), msr_index(value_job)), (1, 0))
            styled['loras'] = styled['loras'][:1]
            validate_loras(styled, headers)
            self.assertIsNone(msr_index(styled))
            # Subject references need the MSR LoRA, a style does not stand for it; one MSR at most.
            wanting = dict(styled, references=[dict(input='ref', role='msr_image', path=style)])
            with self.assertRaisesRegex(ValueError, 'MSR references require'):
                validate_loras(wanting, headers)
            twice = dict(value_job, loras=value_job['loras'] * 2)
            with self.assertRaisesRegex(ValueError, 'one MSR LoRA'):
                validate_loras(twice, headers)
            # A LoRA made for another model is refused before anything is loaded.
            other = str(Path(folder) / 'other.safetensors')
            pair = {'blocks.0.wq.lora_A.weight': torch.zeros((4, 3)), 'blocks.0.wq.lora_B.weight': torch.zeros((2, 4))}
            save_file(pair, other)
            with self.assertRaisesRegex(ValueError, 'none of its layers belongs to this model'):
                validate_loras(dict(styled, loras=[dict(id='style-0', path=other, strength=1)]), headers)
            headers['model']['model.diffusion_model.transformer_blocks.0.attn1.to_q.weight']['shape'] = [4, 3]
            with self.assertRaisesRegex(ValueError, 'pair'):
                validate_loras(value_job, headers)
            with self.assertRaisesRegex(ValueError, 'pair'):
                validate_loras(styled, headers)


if __name__ == '__main__':
    unittest.main()
