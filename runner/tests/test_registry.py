import json
import subprocess
import sys
import unittest
from pathlib import Path

from runner.registry import capabilities, families, pipeline, validate_job

ROOT = Path(__file__).resolve().parents[2]


def ltx_job(**changes):
    job = dict(
        schemaVersion=1,
        id='job',
        pipeline='ltx25',
        mediaType='video',
        workflowId='wf',
        workflowDigest='b' * 64,
        parameters=dict(
            prompt='a boat', seed=1, width=384, height=256, steps=8, frames=25, fps=24, stage='draft', audio=False
        ),
        components={k: str(Path.cwd() / f'{k}.safetensors') for k in ('model', 'textEncoder', 'vae', 'audioVae')},
        loras=[],
        references=[],
    )
    job.update(changes)
    return job


class RegistryTests(unittest.TestCase):
    def test_every_manifest_has_a_runnable_module_and_a_capability(self):
        self.assertEqual(set(capabilities()), set(families()))
        for name, manifest in families().items():
            with self.subTest(family=name):
                self.assertTrue(callable(pipeline(name).generate))
                for role, spec in manifest['roles'].items():
                    self.assertIn(spec['media'], ('image', 'video', 'audio'), role)
                    self.assertTrue(spec['as'])
                template = manifest['template']
                self.assertTrue(set(template['parameters']) <= set(manifest['parameters']))

    def test_family_modules_import_without_torch(self):
        code = (
            'import sys; from runner.registry import families, pipeline\n'
            '[pipeline(name) for name in families()]\n'
            'print(json.dumps("torch" in sys.modules))'
        )
        result = subprocess.run(
            [sys.executable, '-s', '-c', 'import json\n' + code], cwd=ROOT, capture_output=True, text=True, check=True
        )
        self.assertEqual(json.loads(result.stdout), False, 'validating a job must not load PyTorch')

    def test_manifest_limits_reject_values_roles_and_counts(self):
        self.assertEqual(validate_job(ltx_job())['pipeline'], 'ltx25')
        image = str(Path.cwd() / 'start.png')
        for change in [
            dict(parameters=ltx_job()['parameters'] | {'steps': 12}),
            dict(parameters=ltx_job()['parameters'] | {'frames': 24}),
            dict(parameters=ltx_job()['parameters'] | {'unknown': 1}),
            dict(references=[dict(input='a', role='img2img', path=image)]),
            dict(references=[dict(input=k, role='start_image', path=image) for k in 'ab']),
            dict(references=[dict(input='a', role='msr_image', path=image)]),
            dict(mediaType='image'),
            dict(pipeline='unknown'),
        ]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_job(ltx_job(**change))

    def test_family_rules_beyond_the_manifest_still_apply(self):
        video = str(Path.cwd() / 'source.mp4')
        image = str(Path.cwd() / 'start.png')
        both = [dict(input='s', role='source_video', path=video), dict(input='i', role='start_image', path=image)]
        with self.assertRaisesRegex(ValueError, 'start image or source video'):
            validate_job(ltx_job(references=both))
        # Continuation with sound is allowed: the source audio under the overlap is held fixed.
        validate_job(ltx_job(references=both[:1], parameters=ltx_job()['parameters'] | {'audio': True}))


if __name__ == '__main__':
    unittest.main()
