import copy
import json
from pathlib import Path
import struct
import tempfile
import unittest

from runner.contracts import validate_job, validate_config
from runner.models.headers import header, validate_krea2_components, validate_lora


def job():
    return dict(
        schemaVersion=1,
        id='job-one',
        pipeline='krea2',
        mediaType='image',
        workflowId='preset',
        workflowDigest='a' * 64,
        parameters=dict(prompt='a tree', seed=7, width=64, height=64, steps=1, cfg=1, denoise=1),
        components={k: str(Path.cwd() / f'{k}.safetensors') for k in ('model', 'textEncoder', 'vae')}
        | {'tokenizer': str(Path.cwd() / 'tokenizer')},
        loras=[],
        references=[],
    )


class ContractTests(unittest.TestCase):
    def test_concrete_job_is_valid_without_loading_files(self):
        value = job()
        self.assertEqual(validate_job(value), value)

    def test_rejects_policy_unknown_fields_and_nonfinite_numbers(self):
        for field, value in [
            ('seed', True),
            ('seed', 2**53),
            ('width', 65),
            ('steps', 0),
            ('cfg', 2),
            ('denoise', float('nan')),
            ('denoise', 0),
            ('prompt', {'policy': 'model'}),
            ('expandPrompt', 'true'),
            ('unknown', 1),
        ]:
            candidate = job()
            candidate['parameters'][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                validate_job(candidate)
        for key, value in [
            ('schemaVersion', 2),
            ('pipeline', 'exec'),
            ('mediaType', 'video'),
            ('workflowDigest', 'bad'),
            ('extra', 1),
        ]:
            candidate = job()
            candidate[key] = value
            with self.assertRaises(ValueError):
                validate_job(candidate)

    def test_rejects_unsafe_paths_duplicate_loras_and_unsupported_refs(self):
        candidate = job()
        candidate['components']['model'] = '../file'
        with self.assertRaises(ValueError):
            validate_job(candidate)
        candidate = job()
        candidate['loras'] = [dict(id='x', path=candidate['components']['model'], strength=0.5)] * 2
        with self.assertRaises(ValueError):
            validate_job(candidate)
        candidate = job()
        candidate['references'] = [dict(input='start', role='startImage', path=candidate['components']['model'])]
        with self.assertRaises(ValueError):
            validate_job(candidate)

    def test_trusted_config(self):
        value = {k: str(Path.cwd() / k) for k in ('tokenizerPath', 'cacheRoot', 'outputRoot')}
        self.assertEqual(validate_config(value)['engine'], 'int8')
        with self.assertRaises(ValueError):
            validate_config(value | {'cacheGiB': float('inf')})

    def test_signed_lora_strength_bounds(self):
        candidate = job()
        candidate['loras'] = [dict(id='style', path=candidate['components']['model'], strength=-0.5)]
        self.assertEqual(validate_job(candidate), candidate)
        candidate['loras'][0]['strength'] = -4.01
        with self.assertRaises(ValueError):
            validate_job(candidate)

    def test_expansion_requires_concrete_config_and_rejects_unknown_options(self):
        candidate = job()
        candidate['parameters']['expandPrompt'] = True
        with self.assertRaises(ValueError):
            validate_job(candidate)
        candidate['promptExpansion'] = dict(
            template='Describe {{prompt}}',
            maxTokens=128,
            temperature=0.7,
            topK=50,
            topP=0.95,
            minP=0,
            repetitionPenalty=1.05,
            seed=7,
            suffix=' visual details',
        )
        self.assertEqual(validate_job(candidate), candidate)
        candidate['promptExpansion']['template'] = 'no prompt placeholder'
        with self.assertRaises(ValueError):
            validate_job(candidate)

    def test_safetensors_header_rejects_truncation_invalid_offsets_and_duplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fake.safetensors'
            for raw, payload in [
                (b'{}', b''),
                (b'{"x":{"dtype":"F32","shape":[2],"data_offsets":[0,8]}}', b'1234'),
                (b'{"x":1,"x":2}', b''),
                (b'{"x":{"dtype":"F32","shape":[1],"data_offsets":[]}}', b'1234'),
                (b'{"__metadata__":{"bad":12},"x":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}', b'1234'),
            ]:
                path.write_bytes(struct.pack('<Q', len(raw)) + raw + payload)
                with self.assertRaises(ValueError):
                    header(path)

    def test_layout_inspection_rejects_wrong_family(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fake.safetensors'
            raw = json.dumps({'x': {'dtype': 'F32', 'shape': [1], 'data_offsets': [0, 4]}}).encode()
            path.write_bytes(struct.pack('<Q', len(raw)) + raw + b'1234')
            candidate = job()
            candidate['components'] = {k: str(path) for k in candidate['components']}
            with self.assertRaisesRegex(ValueError, '[Ii]ncompatible'):
                validate_krea2_components(candidate)

    def test_lora_rejects_orphan_and_unsupported_tensors(self):
        base = {'layer.weight': {'shape': [4, 8]}}
        entries = {'layer.lora_A.weight': {'shape': [2, 8]}, 'layer.lora_B.weight': {'shape': [4, 2]}}
        validate_lora(entries, base)
        with self.assertRaises(ValueError):
            validate_lora(entries | {'other.lora_B.weight': {'shape': [4, 2]}}, base)
        with self.assertRaises(ValueError):
            validate_lora(entries | {'layer.dora_scale': {'shape': [4]}}, base)


if __name__ == '__main__':
    unittest.main()
