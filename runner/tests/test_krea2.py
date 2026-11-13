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

    def test_lora_of_every_common_naming_is_read_and_others_are_named(self):
        from runner.models.lora_keys import lora_pairs

        base = {'blocks.0.attn.wq.weight': {'shape': [4, 8]}, 'txt_fusion.proj.weight': {'shape': [4, 8]}}
        down, up, alpha = {'shape': [2, 8]}, {'shape': [4, 2]}, {'shape': []}
        # PEFT with a prefix and an alpha; kohya with dots; kohya with underscores, even for a
        # layer whose own name has one.
        for entries in (
            {
                'diffusion_model.blocks.0.attn.wq.lora_A.weight': down,
                'diffusion_model.blocks.0.attn.wq.lora_B.weight': up,
                'diffusion_model.blocks.0.attn.wq.alpha': alpha,
            },
            {'blocks.0.attn.wq.lora_down.weight': down, 'blocks.0.attn.wq.lora_up.weight': up},
            {
                'lora_unet_blocks_0_attn_wq.lora_down.weight': down,
                'lora_unet_blocks_0_attn_wq.lora_up.weight': up,
                'lora_unet_blocks_0_attn_wq.alpha': alpha,
                'lora_unet_txt_fusion_proj.lora_down.weight': down,
                'lora_unet_txt_fusion_proj.lora_up.weight': up,
            },
        ):
            validate_lora(entries, base)
            pairs, left = lora_pairs(entries, {key for key in base})
            self.assertFalse(left)
            self.assertIn('blocks.0.attn.wq.weight', pairs)
        # A pair that moves a norm's scale (a vector), beside a layer's: read and checked by size.
        norm = {'txtfusion.blocks.0.prenorm.scale': {'shape': [4]}}
        moved = {
            'diffusion_model.blocks.0.attn.wq.lora_A.weight': down,
            'diffusion_model.blocks.0.attn.wq.lora_B.weight': up,
            'diffusion_model.txtfusion.blocks.0.prenorm.scale.lora_down.weight': {'shape': [1, 1]},
            'diffusion_model.txtfusion.blocks.0.prenorm.scale.lora_up.weight': {'shape': [4, 1]},
            'diffusion_model.txtfusion.blocks.0.prenorm.scale.alpha': alpha,
        }
        validate_lora(moved, base | norm)
        pairs, left = lora_pairs(moved, set(base | norm))
        self.assertFalse(left)
        self.assertEqual(
            pairs['txtfusion.blocks.0.prenorm.scale'][0],
            'diffusion_model.txtfusion.blocks.0.prenorm.scale.lora_down.weight',
        )
        with self.assertRaisesRegex(ValueError, 'target/pair'):
            validate_lora(moved, base | {'txtfusion.blocks.0.prenorm.scale': {'shape': [5]}})
        # Another kind of adapter, or a LoRA of another model: said as such.
        with self.assertRaisesRegex(ValueError, 'LoKr'):
            validate_lora({'blocks.0.attn.wq.lokr_w1': down, 'blocks.0.attn.wq.lokr_w2': up}, base)
        with self.assertRaisesRegex(ValueError, 'another one'):
            validate_lora(
                {
                    'transformer_blocks.0.attn1.to_k.lora_A.weight': down,
                    'transformer_blocks.0.attn1.to_k.lora_B.weight': up,
                },
                base,
            )

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


class StreamedEncoderTests(unittest.TestCase):
    """The text encoder on a card it does not fit on: one module's weights there at a time."""

    def test_each_module_receives_its_weights_for_its_forward_and_gives_them_back(self):
        try:
            import torch
            from accelerate import init_empty_weights
        except ImportError:
            self.skipTest('torch and accelerate are required')
        from runner.models.krea2_text import stream_weights

        def build():
            return torch.nn.Sequential(torch.nn.Embedding(10, 4), torch.nn.Linear(4, 4), torch.nn.Linear(4, 2))

        torch.manual_seed(0)
        reference = build().double()
        weights = dict(reference.named_parameters())
        with init_empty_weights():
            model = build()
        held, loaded = [], []

        def load(name):
            # How many weights are out of the file while this one is asked for.
            held.append(sum(not parameter.is_meta for parameter in model.parameters()))
            loaded.append(name)
            return weights[name].detach().clone()

        stream_weights(model, load, 'cpu')
        tokens = torch.tensor([[1, 2, 3]])
        with torch.inference_mode():
            first, second = model(tokens), model(tokens)
            expected = reference(tokens)
        # The same numbers, in the precision of the weights given (not that of the empty model).
        self.assertEqual(first.dtype, torch.float64)
        self.assertTrue(torch.equal(first, expected) and torch.equal(second, expected))
        # Read again at every forward, one module at a time, and nothing is left behind.
        self.assertEqual(loaded, ['0.weight', '1.weight', '1.bias', '2.weight', '2.bias'] * 2)
        self.assertLessEqual(max(held), 1)
        self.assertTrue(all(parameter.is_meta for parameter in model.parameters()))


if __name__ == '__main__':
    unittest.main()
