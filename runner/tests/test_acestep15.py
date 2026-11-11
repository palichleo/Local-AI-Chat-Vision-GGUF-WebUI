import json
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from runner.pipelines import acestep15
from runner.registry import validate_job


def model_folder(
    root, class_name='AceStepPipeline', parts=('transformer', 'text_encoder', 'tokenizer', 'condition_encoder', 'vae')
):
    folder = Path(root) / 'acestep-v15-xl-sft-diffusers'
    folder.mkdir()
    (folder / 'model_index.json').write_text(json.dumps({'_class_name': class_name}), encoding='utf-8')
    for part in parts:
        (folder / part).mkdir()
    return folder


def music_job(folder, **parameters):
    values = dict(
        prompt='synth-pop, 110 BPM', lyrics='', seconds=2, language='fr', seed=7, steps=3, guidance_scale=7, shift=3
    )
    values.update(parameters)
    return dict(
        schemaVersion=1,
        id='song',
        pipeline='acestep15',
        mediaType='audio',
        workflowId='music',
        workflowDigest='c' * 64,
        parameters=values,
        components=dict(musicModel=str(folder)),
        loras=[],
        references=[],
    )


class FakeTensor:
    def __init__(self, array):
        self.array = array

    def float(self):
        return self

    def cpu(self):
        return self

    def numpy(self):
        return self.array


class FakePipeline:
    sample_rate = 48000
    calls = []

    def __init__(self):
        self.vae = SimpleNamespace(enable_tiling=lambda: None)

    @classmethod
    def from_pretrained(cls, path, torch_dtype=None):
        cls.calls.append(('load', path))
        return cls()

    def to(self, device):
        return self

    def enable_model_cpu_offload(self):
        pass

    def __call__(self, **kwargs):
        FakePipeline.calls.append(('call', kwargs))
        for index in range(kwargs['num_inference_steps']):
            kwargs['callback_on_step_end'](self, index, 0, {})
        samples = int(kwargs['audio_duration'] * self.sample_rate)
        return SimpleNamespace(audios=[FakeTensor(np.full((2, samples), 0.5, dtype=np.float32))])


def fake_torch():
    class Generator:
        def __init__(self, device):
            pass

        def manual_seed(self, seed):
            self.seed = seed
            return self

    class Context:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    return SimpleNamespace(
        cuda=SimpleNamespace(is_available=lambda: False),
        bfloat16='bf16',
        Generator=Generator,
        inference_mode=Context,
    )


class AceStepTests(unittest.TestCase):
    def test_a_job_names_a_complete_ace_step_folder(self):
        with tempfile.TemporaryDirectory() as root:
            folder = model_folder(root)
            validate_job(music_job(folder, seconds=10))
            with self.assertRaisesRegex(ValueError, 'seconds'):
                validate_job(music_job(folder, seconds=700))
            acestep15.preflight(music_job(folder), {})
        with tempfile.TemporaryDirectory() as root:
            folder = model_folder(root, class_name='FluxPipeline')
            with self.assertRaisesRegex(ValueError, 'AceStepPipeline'):
                acestep15.preflight(music_job(folder), {})
        with tempfile.TemporaryDirectory() as root:
            folder = model_folder(root, parts=('transformer', 'vae'))
            with self.assertRaisesRegex(ValueError, 'text_encoder'):
                acestep15.preflight(music_job(folder), {})

    def test_an_instrumental_is_written_as_a_stereo_wav_with_its_progress(self):
        FakePipeline.calls = []
        stages = []
        with tempfile.TemporaryDirectory() as root:
            folder = model_folder(root)
            output = Path(root) / 'out'
            with patch.dict(sys.modules, torch=fake_torch(), diffusers=SimpleNamespace(AceStepPipeline=FakePipeline)):
                result = acestep15.generate(
                    music_job(folder), dict(outputRoot=str(output)), lambda **event: stages.append(event)
                )
            call = FakePipeline.calls[1][1]
            self.assertEqual((call['lyrics'], call['vocal_language']), ('[Instrumental]', 'unknown'))
            self.assertEqual(call['audio_duration'], 2.0)
            self.assertEqual([event['stage'] for event in stages][:2], ['loading music model', 'generating music'])
            self.assertEqual(stages[-2], dict(stage='generating music', step=3, total=3))
            self.assertEqual(stages[-1]['stage'], 'saving audio')
            descriptor = result['outputs'][0]
            self.assertEqual((descriptor['seconds'], descriptor['sampleRate'], descriptor['channels']), (2.0, 48000, 2))
            self.assertTrue(result['metadata']['instrumental'])
            with wave.open(str(output / descriptor['filename'])) as file:
                self.assertEqual((file.getnchannels(), file.getsampwidth(), file.getframerate()), (2, 3, 48000))
                self.assertEqual(file.getnframes(), 96000)

    def test_lyrics_are_sung_in_the_language_asked(self):
        FakePipeline.calls = []
        with tempfile.TemporaryDirectory() as root:
            folder = model_folder(root)
            with patch.dict(sys.modules, torch=fake_torch(), diffusers=SimpleNamespace(AceStepPipeline=FakePipeline)):
                acestep15.generate(
                    music_job(folder, lyrics='[Verse]\nLa nuit tombe'),
                    dict(outputRoot=str(Path(root) / 'out')),
                    lambda **event: None,
                )
            call = FakePipeline.calls[1][1]
            self.assertEqual((call['lyrics'], call['vocal_language']), ('[Verse]\nLa nuit tombe', 'fr'))


if __name__ == '__main__':
    unittest.main()
