import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import torch

from runner.models import moss_image_text

CUDA = torch.cuda.is_available()


class Held:
    """A file as a plain table of tensors: what `table` asks of a store."""

    def __init__(self, tensors):
        self.tensors = tensors

    def keys(self):
        return list(self.tensors)

    def get_tensor(self, key):
        return self.tensors[key]


def note(**fields):
    return torch.frombuffer(bytearray(json.dumps(fields).encode()), dtype=torch.uint8)


class PromptTests(unittest.TestCase):
    def test_a_prompt_is_the_users_turn_left_open_on_the_thinking_of_the_answer(self):
        self.assertEqual(
            moss_image_text.chat('  A cat on a roof.\n'),
            '<|im_start|>user\nA cat on a roof.<|im_end|>\n<|im_start|>assistant\n<think>\n',
        )
        # The negative prompt of a job is often empty; a layout prompt is JSON and keeps its braces.
        self.assertEqual(moss_image_text.chat(''), '<|im_start|>user\n<|im_end|>\n<|im_start|>assistant\n<think>\n')
        layout = '{"summary":{"caption":"{0} {}"},"items":[]}'
        self.assertEqual(moss_image_text.chat(layout), moss_image_text.OPEN + layout + moss_image_text.CLOSE)

    def test_the_language_model_is_the_published_encoders_not_the_defaults_of_its_class(self):
        config = moss_image_text.text_config()
        said = config.to_dict()
        self.assertEqual(
            {
                key: said[key]
                for key in (
                    'vocab_size', 'hidden_size', 'intermediate_size', 'num_hidden_layers', 'num_attention_heads',
                    'num_key_value_heads', 'head_dim', 'hidden_act', 'max_position_embeddings', 'rms_norm_eps',
                    'linear_conv_kernel_dim', 'linear_key_head_dim', 'linear_value_head_dim', 'linear_num_key_heads',
                    'linear_num_value_heads', 'tie_word_embeddings',
                )
            },
            dict(
                vocab_size=248320, hidden_size=4096, intermediate_size=12288, num_hidden_layers=32,
                num_attention_heads=16, num_key_value_heads=4, head_dim=256, hidden_act='silu',
                max_position_embeddings=262144, rms_norm_eps=1e-6, linear_conv_kernel_dim=4, linear_key_head_dim=128,
                linear_value_head_dim=128, linear_num_key_heads=16, linear_num_value_heads=32,
                tie_word_embeddings=False,
            ),
        )  # fmt: skip
        # Its positions turn on a base of ten million (the class says ten thousand), a quarter of a head.
        self.assertEqual(
            {key: said['rope_parameters'][key] for key in ('rope_theta', 'partial_rotary_factor', 'mrope_section')},
            dict(rope_theta=10000000, partial_rotary_factor=0.25, mrope_section=[11, 11, 10]),
        )
        # Three layers of linear attention, then one of full attention, eight times.
        self.assertEqual(config.layer_types, (['linear_attention'] * 3 + ['full_attention']) * 8)
        self.assertEqual((moss_image_text.MAX_TOKENS, moss_image_text.WIDTH), (4096, 4096))


class TokenTableTests(unittest.TestCase):
    def test_only_the_rows_of_a_prompt_are_read_and_a_rotated_table_is_turned_back(self):
        from runner import convert

        torch.manual_seed(0)
        plain = torch.randn(40, 512)
        weight, scale = convert.quantise(convert.rotate(plain))
        ids = torch.tensor([[3, 39, 3, 0]])
        key = 'model.language_model.embed_tokens.weight'
        stem = key.removesuffix('.weight')
        # INT8, one scale a row, rotated: what the published file holds.
        held = {key: weight, stem + '.weight_scale': scale, stem + '.comfy_quant': note(format='int8_tensorwise', convrot=True, convrot_groupsize=256)}
        rows = moss_image_text.table(Held(held), set(held), key, 'cpu', torch.float32)(ids)
        self.assertEqual((tuple(rows.shape), rows.dtype), ((1, 4, 512), torch.float32))
        self.assertLess((rows[0] - plain[ids[0]]).abs().max().item(), 0.06)
        # (Not turned back, its rows are another table's.)
        self.assertGreater((weight.float() * scale)[ids[0]].sub(plain[ids[0]]).abs().max().item(), 1)
        # INT8 that was not rotated; another group of rotation.
        straight, straight_scale = convert.quantise(plain)
        held = {key: straight, stem + '.weight_scale': straight_scale, stem + '.comfy_quant': note(format='int8_tensorwise')}
        rows = moss_image_text.table(Held(held), set(held), key, 'cpu', torch.float32)(ids)
        self.assertLess((rows[0] - plain[ids[0]]).abs().max().item(), 0.06)
        small, small_scale = convert.quantise(convert.rotate(plain, 64))
        held = {key: small, stem + '.weight_scale': small_scale, stem + '.comfy_quant': note(format='int8_tensorwise', convrot=True, convrot_groupsize=64)}
        rows = moss_image_text.table(Held(held), set(held), key, 'cpu', torch.float32)(ids)
        self.assertLess((rows[0] - plain[ids[0]]).abs().max().item(), 0.06)
        # Plain weights, as the published BF16 encoder: read as they are, in the precision asked.
        held = {key: plain.to(torch.bfloat16)}
        rows = moss_image_text.table(Held(held), set(held), key, 'cpu', torch.bfloat16)(ids[0])
        self.assertEqual((tuple(rows.shape), rows.dtype), ((4, 512), torch.bfloat16))
        self.assertTrue(torch.equal(rows, plain.to(torch.bfloat16)[ids[0]]))
        # One scale for the whole table (older files).
        held = {key: plain / 2, stem + '.weight_scale': torch.tensor(2.0)}
        rows = moss_image_text.table(Held(held), set(held), key, 'cpu', torch.float32)(ids)
        self.assertTrue(torch.allclose(rows[0], plain[ids[0]]))
        # A format whose rows cannot be read one at a time is said, not guessed.
        held = {key: weight, stem + '.comfy_quant': note(format='nvfp4')}
        with self.assertRaisesRegex(ValueError, 'nvfp4'):
            moss_image_text.table(Held(held), set(held), key, 'cpu', torch.float32)


class KeptConditioningTests(unittest.TestCase):
    """What `conditioning` loads and what it gives back from the last prompts, the encoder mocked."""

    def setUp(self):
        moss_image_text.KEPT.clear()
        self.folder = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.folder.cleanup)
        self.encoder = Path(self.folder.name) / 'encoder.safetensors'
        self.encoder.write_bytes(b'weights')
        self.stages, self.read, self.loads, self.cleared = [], [], [], []

    def run_conditioning(self, prompts, encoder=None, tokenizer='tokenizer'):
        from runner.models import pool, residency

        class Store:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

        test = self

        def load(store, made, device='cuda'):
            test.loads.append(made.limit)
            return 'model'

        def encode(model, tokenizer, prompt, device='cuda'):
            test.read.append(prompt)
            return torch.full((1, len(prompt) + 1, 4), float(len(prompt)))

        def made_pool(stores, limit):
            return SimpleNamespace(limit=int(limit * 1024**3), clear=lambda: test.cleared.append(True))

        def opened(path, **options):
            test.opened = (path, options)
            return Store()

        with (
            patch.object(moss_image_text, 'load', load),
            patch.object(moss_image_text, 'encode', encode),
            patch.object(pool, 'WeightPool', made_pool),
            patch.object(pool, 'room', lambda reserve: 10.0 - reserve),
            patch.object(residency, 'open_store', opened),
            patch('transformers.AutoTokenizer.from_pretrained', lambda path, local_files_only: ('tokenizer', path, local_files_only)),
            patch.object(torch.cuda, 'empty_cache', lambda: None),
        ):
            return moss_image_text.conditioning(
                prompts, encoder or self.encoder, tokenizer, lambda stage, **extra: self.stages.append(stage), ram_reserve=7, device='cpu'
            )

    def test_the_encoder_is_loaded_once_for_the_prompts_not_read_lately(self):
        positive, negative = self.run_conditioning(['a cat', ''])
        self.assertEqual((positive.shape[1], negative.shape[1], self.read, len(self.loads), self.cleared), (6, 1, ['a cat', ''], 1, [True]))
        self.assertEqual(self.stages, ['loading text encoder', 'text encoder loaded', 'encoding prompt', 'encoding prompt', 'prompt encoded'])
        # (It is given what the card has free less its own room, its file neither locked nor sent away.)
        self.assertEqual(self.loads, [int((10.0 - moss_image_text.ROOM_GIB) * 1024**3)])
        self.assertEqual(self.opened, (str(self.encoder), dict(reserve=7, evict=False, pin=False)))
        # The same prompts again (another seed): nothing is loaded.
        self.stages.clear()
        again = self.run_conditioning(['a cat', ''])
        self.assertEqual((self.read, len(self.loads), self.stages), (['a cat', ''], 1, ['prompt already encoded']))
        self.assertTrue(torch.equal(again[0], positive))
        # A new prompt with the same negative one: read alone.
        self.run_conditioning(['a dog', ''])
        self.assertEqual((self.read, len(self.loads)), (['a cat', '', 'a dog'], 2))
        # The same text twice in a job is read once, and given twice.
        twice = self.run_conditioning(['x', 'x'])
        self.assertEqual((self.read[3:], len(twice)), (['x'], 2))
        self.assertTrue(torch.equal(twice[0], twice[1]))

    def test_another_encoder_or_tokenizer_reads_the_prompt_again(self):
        self.run_conditioning(['a cat'])
        self.run_conditioning(['a cat'], tokenizer='other')
        self.assertEqual(len(self.loads), 2)
        other = Path(self.folder.name) / 'other.safetensors'
        other.write_bytes(b'more weights')
        self.run_conditioning(['a cat'], encoder=other)
        self.assertEqual(len(self.loads), 3)
        # The same file written again (its size, its date): no longer the file that was read.
        self.encoder.write_bytes(b'weights changed')
        self.run_conditioning(['a cat'])
        self.assertEqual(len(self.loads), 4)

    def test_the_last_prompts_only_are_kept_and_a_failed_reading_leaves_the_card(self):
        for index in range(moss_image_text.KEEP + 3):
            self.run_conditioning([f'prompt {index}'])
        self.assertEqual(len(moss_image_text.KEPT), moss_image_text.KEEP)
        self.assertEqual([key[-1] for key in moss_image_text.KEPT][0], 'prompt 3')
        # One read lately stays ahead of the others.
        self.run_conditioning(['prompt 3'])
        self.run_conditioning(['one more'])
        self.assertIn('prompt 3', [key[-1] for key in moss_image_text.KEPT])
        self.assertNotIn('prompt 4', [key[-1] for key in moss_image_text.KEPT])
        self.cleared.clear()

        def broken(model, tokenizer, prompt, device='cuda'):
            return torch.full((1, 2, 4), float('nan'))

        with patch.object(moss_image_text, 'encode', broken), self.assertRaisesRegex(RuntimeError, 'Non-finite'):
            from runner.models import pool, residency

            class Store:
                def __enter__(self):
                    return self

                def __exit__(self, *_):
                    return False

            with (
                patch.object(moss_image_text, 'load', lambda *a, **k: 'model'),
                patch.object(pool, 'WeightPool', lambda stores, limit: SimpleNamespace(limit=0, clear=lambda: self.cleared.append(True))),
                patch.object(pool, 'room', lambda reserve: 1.0),
                patch.object(residency, 'open_store', lambda path, **options: Store()),
                patch('transformers.AutoTokenizer.from_pretrained', lambda path, local_files_only: None),
                patch.object(torch.cuda, 'empty_cache', lambda: None),
            ):
                moss_image_text.conditioning(['never kept'], self.encoder, 'tokenizer', lambda stage, **extra: None, device='cpu')
        self.assertEqual(self.cleared, [True])
        self.assertNotIn('never kept', [key[-1] for key in moss_image_text.KEPT])


@unittest.skipUnless(CUDA, 'the weights of a file are read on the GPU')
class EncoderWeightsTests(unittest.TestCase):
    def test_the_encoder_reads_a_prompt_from_its_file_as_the_plain_model_does(self):
        from safetensors.torch import save_file
        from transformers import Qwen3_5TextConfig, Qwen3_5TextModel

        from runner import convert
        from runner.models.pool import WeightPool
        from runner.models.residency import open_store

        config = Qwen3_5TextConfig(
            vocab_size=500, hidden_size=256, intermediate_size=512, num_hidden_layers=4, num_attention_heads=4,
            num_key_value_heads=2, head_dim=64, linear_key_head_dim=32, linear_value_head_dim=32,
            linear_num_key_heads=4, linear_num_value_heads=8,
            rope_parameters=dict(rope_type='default', rope_theta=10000000, partial_rotary_factor=0.25, mrope_section=[3, 3, 2]),
        )  # fmt: skip
        torch.manual_seed(0)
        plain = Qwen3_5TextModel(config).eval()
        linear = {name for name, module in plain.named_modules() if isinstance(module, torch.nn.Linear)}
        prefix = moss_image_text.PREFIX
        held, kept = {}, {}
        for name, value in plain.state_dict().items():
            stem = name.removesuffix('.weight')
            if name == 'embed_tokens.weight' or (stem in linear and value.shape[1] % 256 == 0):
                weight, scale = convert.quantise(convert.rotate(value))
                held[prefix + name], held[prefix + stem + '.weight_scale'] = weight, scale
                held[prefix + stem + '.comfy_quant'] = torch.frombuffer(bytearray(convert.NOTE), dtype=torch.uint8)
                kept[name] = convert.rotate(weight.float() * scale)
            elif name.endswith(('A_log', 'linear_attn.norm.weight')):
                held[prefix + name] = kept[name] = value.float()
            else:
                held[prefix + name] = value.to(torch.bfloat16)
                kept[name] = held[prefix + name].float()
        # What the file holds beside the language model is not asked for.
        held['lm_head.weight'] = torch.zeros(2, 2)
        held['model.visual.pos_embed.weight'] = torch.zeros(2, 2)
        plain.load_state_dict(kept)
        ids = torch.randint(0, 500, (1, 23))

        class Tokenizer:
            def __call__(self, text, return_tensors, truncation, max_length):
                self.asked = (text, return_tensors, truncation, max_length)
                return SimpleNamespace(input_ids=ids)

        tokenizer = Tokenizer()
        with torch.no_grad():
            expected = plain(input_ids=ids, attention_mask=torch.ones_like(ids), use_cache=False).last_hidden_state
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as folder:
            path = str(Path(folder) / 'encoder.safetensors')
            save_file(held, path)
            with open_store(path, resident=False) as store:
                pool = WeightPool({'text': store}, limit_gib=1)
                try:
                    model = moss_image_text.load(store, pool, config=config)
                    got = moss_image_text.encode(model, tokenizer, ' a cat ')
                    self.assertEqual((tuple(got.shape), got.dtype, got.device.type), ((1, 23, 256), torch.bfloat16, 'cuda'))
                    error = ((got.float().cpu() - expected).norm() / expected.norm()).item()
                    # Measured: 2.7 % (matrices and table rounded to 8 bits, rows in BF16).
                    self.assertLess(error, 0.06)
                    self.assertEqual(tokenizer.asked, (moss_image_text.chat('a cat'), 'pt', True, 4096))
                    # The decays of the linear attention keep the precision of the file.
                    self.assertEqual(model.layers[0].linear_attn.A_log.dtype, torch.float32)
                    self.assertEqual(model.layers[0].input_layernorm.weight.dtype, torch.bfloat16)
                finally:
                    pool.clear()
                    model = None
            # A file that lacks a weight of the language model says which.
            for missing, said in ((prefix + 'layers.1.mlp.up_proj.weight', 'matrix: layers.1.mlp.up_proj'), (prefix + 'layers.2.linear_attn.dt_bias', 'weight: layers.2.linear_attn.dt_bias')):
                lacking = str(Path(folder) / 'lacking.safetensors')
                save_file({key: value for key, value in held.items() if key != missing}, lacking)
                with open_store(lacking, resident=False) as store:
                    pool = WeightPool({'text': store}, limit_gib=1)
                    with self.assertRaisesRegex(ValueError, said.replace('.', r'\.')):
                        moss_image_text.load(store, pool, config=config)
                    pool.clear()
            wrong = str(Path(folder) / 'wrong.safetensors')
            save_file({**held, prefix + 'norm.weight': torch.zeros(128, dtype=torch.bfloat16)}, wrong)
            with open_store(wrong, resident=False) as store:
                pool = WeightPool({'text': store}, limit_gib=1)
                with self.assertRaisesRegex(ValueError, 'shape mismatch: norm.weight'):
                    moss_image_text.load(store, pool, config=config)
                pool.clear()


if __name__ == '__main__':
    unittest.main()
