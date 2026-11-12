"""Krea 2's own rules and what its built-in engine keeps between two pictures."""

import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from runner.models.krea2_headers import validate_krea2_components, validate_lora
from runner.pipelines import krea2


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


class Krea2Tests(unittest.TestCase):
    def test_expansion_requires_concrete_config_and_rejects_unknown_options(self):
        candidate = job()
        candidate['parameters']['expandPrompt'] = True
        with self.assertRaises(ValueError):
            krea2.check(candidate, None)
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
        krea2.check(candidate, None)
        candidate['promptExpansion']['template'] = 'no prompt placeholder'
        with self.assertRaises(ValueError):
            krea2.check(candidate, None)

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

    def test_architecture_preflight_imports_never_initialize_cuda(self):
        code = '''import sys
sys.path.insert(0,sys.argv[1])
import torch
def forbid(*args,**kwargs):
    raise AssertionError('Preflight attempted CUDA initialization')
torch.cuda._lazy_init=forbid
from runner.models.krea2_shapes import validate_shapes
try:validate_shapes(dict(model={},textEncoder={},vae={}))
except ValueError:pass
assert not torch.cuda.is_initialized()
assert 'sageattention' not in sys.modules
'''
        result = subprocess.run(
            [sys.executable, '-s', '-c', code, str(Path.cwd())], text=True, capture_output=True, timeout=60
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_the_engine_reads_the_model_as_its_file_stores_it(self):
        source = Path(krea2.__file__).read_text(encoding='utf-8')
        # No second copy of the model on disk, and nothing of ComfyUI in the process.
        for gone in ('PreparedWeights', 'cache_root', 'save_file'):
            self.assertNotIn(gone, source)
        self.assertIn('open_store(str(files[\'transformer\']), reserve=ram_reserve)', source)
        self.assertIn('Unexpected Comfy runtime import', source)
        # What the card has free decides the share of the model that stays on it, less what is
        # copied in advance of the layers that do not stay.
        self.assertIn('budget = room(reserve + AHEAD_GIB)', source)
        self.assertIn('ahead_gib=AHEAD_GIB', source)
        self.assertGreaterEqual(krea2.RESERVE_GIB, 2)


class KeptPromptTests(unittest.TestCase):
    def setUp(self):
        from runner.models import krea2_text

        self.text = krea2_text
        self.text.KEPT.clear()
        self.folder = tempfile.TemporaryDirectory()
        self.encoder = Path(self.folder.name) / 'encoder.safetensors'
        self.encoder.write_bytes(b'weights')
        self.files = dict(encoder=self.encoder)

    def tearDown(self):
        self.text.KEPT.clear()
        self.folder.cleanup()

    def encode(self, prompt, refine=False):
        stages = []
        plan = dict(prompt=prompt, refine_enabled=refine)
        with patch.dict(sys.modules, torch=SimpleNamespace()):
            result = self.text.encode_prompt(
                plan, self.files, self.folder.name, None, 'cuda', 'bf16', lambda stage, **_: stages.append(stage)
            )
        return result, stages

    def kept(self, prompt):
        return (self.text._identity(self.encoder), str(Path(self.folder.name).resolve()), prompt)

    def test_the_same_prompt_does_not_bring_the_encoder_back(self):
        moved = SimpleNamespace(to=lambda **where: ('on', where['device'], where['dtype']))
        self.text.KEPT[self.kept('a fox')] = moved
        result, stages = self.encode('a fox')
        self.assertEqual(result, ('on', 'cuda', 'bf16'))
        self.assertEqual(stages, ['prompt already encoded'])

    def test_another_prompt_another_encoder_or_a_rewritten_prompt_is_encoded_again(self):
        self.text.KEPT[self.kept('a fox')] = SimpleNamespace(to=lambda **_: 'kept')
        # Anything else goes on to load the encoder (which this fake environment does not have).
        for prompt, refine in (('a wolf', False), ('a fox', True)):
            with self.assertRaises(Exception):
                self.encode(prompt, refine)
        self.encoder.write_bytes(b'other weights, another size')
        with self.assertRaises(Exception):
            self.encode('a fox')


if __name__ == '__main__':
    unittest.main()
