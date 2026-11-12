"""Qwen3 text encoding and optional local prompt expansion for Krea2."""

import gc
from collections import OrderedDict
from pathlib import Path

# The conditioning of the last prompts, kept in RAM between images (the worker outlives a job):
# the same prompt drawn again with another seed does not bring the 5 GiB encoder back.
KEPT = OrderedDict()
KEEP = 8


def _identity(path):
    path = Path(path).resolve()
    stat = path.stat()
    return (str(path), stat.st_size, stat.st_mtime_ns)


def encode_prompt(plan, files, tokenizer_path, tensor, device, dtype, progress, ram_reserve=None):
    # A prompt the model rewrites first is drawn each time: only a prompt taken as written is kept.
    kept = None
    if not plan['refine_enabled']:
        kept = (_identity(files['encoder']), str(Path(tokenizer_path).resolve()), plan['prompt'])
        if kept in KEPT:
            KEPT.move_to_end(kept)
            progress('prompt already encoded')
            return KEPT[kept].to(device=device, dtype=dtype)
    import torch
    from accelerate import init_empty_weights
    from accelerate.utils import set_module_tensor_to_device
    from transformers import Qwen3Config, Qwen3ForCausalLM, AutoTokenizer

    from runner.models.residency import open_store

    with torch.inference_mode():
        progress('loading text encoder')
        tokenizer = AutoTokenizer.from_pretrained(tokenizer_path, local_files_only=True)
        config = Qwen3Config(
            vocab_size=151936,
            hidden_size=2560,
            intermediate_size=9728,
            num_hidden_layers=36,
            num_attention_heads=32,
            num_key_value_heads=8,
            head_dim=128,
            rope_theta=5000000.0,
            rms_norm_eps=1e-6,
            max_position_embeddings=262144,
            tie_word_embeddings=True,
        )
        config._attn_implementation = 'sdpa'
        with init_empty_weights():
            text_model = Qwen3ForCausalLM(config)
        # The file stays in RAM between images when it fits beside the model, never in its
        # place: the model is read at every step, the encoder once per prompt. Unlocked, for the
        # same reason: the share of locked RAM goes to the model (4.9 GiB of it held the 12.6 of
        # the model out).
        with open_store(str(files['encoder']), reserve=ram_reserve, evict=False, pin=False) as store:
            for key, parameter in list(text_model.named_parameters()):
                if key == 'lm_head.weight':
                    continue
                if key not in store.keys():
                    raise ValueError('Missing text weight: ' + key)
                value = tensor(store, key)
                if tuple(value.shape) != tuple(parameter.shape):
                    raise ValueError('Text shape mismatch: ' + key)
                set_module_tensor_to_device(text_model, key, device, value=value, dtype=dtype)
        text_model.lm_head.weight = text_model.model.embed_tokens.weight
        text_model.eval().to(device)
        progress('text encoder loaded')
        if plan['refine_enabled']:
            progress('expanding prompt')
            options = plan['promptExpansion']
            prompt = (
                '<|im_start|>user\n'
                + options['template'].replace('{{prompt}}', plan['prompt'])
                + '<|im_end|>\n<|im_start|>assistant\n'
            )
            tokens = tokenizer(prompt, return_tensors='pt').to(device)
            torch.manual_seed(options['seed'])
            generated = text_model.generate(
                **tokens,
                do_sample=True,
                max_new_tokens=options['maxTokens'],
                temperature=options['temperature'],
                top_k=options['topK'],
                top_p=options['topP'],
                min_p=options['minP'],
                repetition_penalty=options['repetitionPenalty'],
                eos_token_id=[151643, 151645],
                pad_token_id=151643,
            )
            plan['prompt'] = tokenizer.decode(
                generated[0, tokens.input_ids.shape[1] :], skip_special_tokens=True
            ).strip()
            if not plan['prompt']:
                raise RuntimeError('Prompt expansion returned no text')
            plan['prompt'] += options['suffix']
            del generated, tokens
        progress('encoding prompt', prompt=plan['prompt'])
        prefix = '<|im_start|>system\nDescribe the image by detailing the color, shape, size, texture, quantity, text, spatial relationships of the objects and background:<|im_end|>\n<|im_start|>user\n'
        text = prefix + plan['prompt'] + '<|im_end|>\n<|im_start|>assistant\n'
        tokens = tokenizer(text, return_tensors='pt').to(device)
        outputs = text_model.model(**tokens, output_hidden_states=True, use_cache=False)
        prefix_length = len(tokenizer.encode(prefix))
        conditioning = torch.stack(
            [outputs.hidden_states[i][:, prefix_length:] for i in (2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35)], dim=2
        ).to(dtype)
        del outputs, tokens, text_model
        gc.collect()
        torch.cuda.empty_cache()
        progress('prompt encoded')
        if kept is not None:
            KEPT[kept] = conditioning.cpu()
            while len(KEPT) > KEEP:
                KEPT.popitem(last=False)
        return conditioning
