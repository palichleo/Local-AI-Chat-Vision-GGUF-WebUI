"""MOSS Image's conditioner: Qwen3.5 9B read to its last layer, the prompt given as a chat turn.

After the model's own pipeline (OpenMOSS/MOSS-Image, Apache-2.0). The text encoder is the
published Qwen3.5 9B, unchanged; what the image model reads is its last hidden state, final norm
included, for the prompt as the user's turn of its chat template with thinking on: the turn ends
on an open think block. Each text is read alone, at its own length: nothing is padded.

The language model is transformers' own (`Qwen3_5TextModel`), with the settings of the published
encoder (the defaults of the class are not all its own: its positions turn on a base of ten
million). Its matrices come from the file through a `WeightPool` as every model's do, INT8 ones
through comfy-kitchen's kernel: as much of it stays on the card as fits while the prompts are
read, the rest passes through. The vision tower, the head and the draft layer of the file
(`model.visual`, `lm_head`, `mtp`) are not read: a prompt holds no image and nothing is written.
"""

import gc
import json
from collections import OrderedDict
from pathlib import Path

# The conditioning of the last prompts, kept in RAM between images (the worker outlives a job):
# the same prompt drawn again with another seed does not bring the 10 GiB encoder back.
KEPT = OrderedDict()
KEEP = 8
PREFIX = 'model.language_model.'
# The user's turn of Qwen3.5's chat template with thinking on, as the template writes it.
OPEN, CLOSE = '<|im_start|>user\n', '<|im_end|>\n<|im_start|>assistant\n<think>\n'
MAX_TOKENS = 4096
WIDTH = 4096
# Video memory left free beside the weights of the encoder while it reads, in GiB: its own
# tensors for a prompt of 4 096 tokens, and the margin the engine keeps under what is free.
ROOM_GIB = 1.5


def text_config():
    """The language model of Qwen3.5 9B, as the `config.json` of the published encoder states it."""
    from transformers import Qwen3_5TextConfig

    return Qwen3_5TextConfig(
        vocab_size=248320,
        hidden_size=WIDTH,
        intermediate_size=12288,
        num_hidden_layers=32,
        num_attention_heads=16,
        num_key_value_heads=4,
        head_dim=256,
        hidden_act='silu',
        max_position_embeddings=262144,
        rms_norm_eps=1e-6,
        linear_conv_kernel_dim=4,
        linear_key_head_dim=128,
        linear_value_head_dim=128,
        linear_num_key_heads=16,
        linear_num_value_heads=32,
        rope_parameters=dict(
            rope_type='default',
            rope_theta=10000000,
            partial_rotary_factor=0.25,
            mrope_section=[11, 11, 10],
            mrope_interleaved=True,
        ),
        tie_word_embeddings=False,
    )


def chat(prompt):
    """A prompt as the model was given its captions: the user's turn, trimmed, then the assistant's
    left open on its thinking. (Written out: a layout prompt is JSON, braces included.)"""
    return OPEN + prompt.strip() + CLOSE


def _identity(path):
    path = Path(path).resolve()
    stat = path.stat()
    return (str(path), stat.st_size, stat.st_mtime_ns)


def _note(store, listed, stem):
    """What a quantised tensor says of itself beside its weight (`.comfy_quant`), {} without one."""
    key = stem + '.comfy_quant'
    return json.loads(store.get_tensor(key).numpy().tobytes()) if key in listed else {}


def table(store, listed, key, device, dtype):
    """The table of the tokens as a layer that reads only the rows of a prompt (the table is 1 GiB
    in INT8 for 248 320 tokens). An INT8 table has one scale a row and, rotated (ConvRot), its
    rows are turned back once looked up: nothing multiplies them by what would undo the rotation,
    as a linear layer does."""
    import torch

    from runner.convert import rotate

    stem = key.removesuffix('.weight')
    note = _note(store, listed, stem)
    if note and note.get('format') != 'int8_tensorwise':
        raise ValueError('Unsupported token table quantization: ' + str(note.get('format')))
    group = note.get('convrot_groupsize', 256) if note.get('convrot') else 0
    scales = stem + '.weight_scale' if stem + '.weight_scale' in listed else None

    class Tokens(torch.nn.Module):
        def forward(self, ids):
            flat = ids.reshape(-1).cpu()
            rows = store.get_tensor(key).index_select(0, flat).to(device=device, dtype=torch.float32)
            if scales:
                scale = store.get_tensor(scales)
                rows = rows * (scale.index_select(0, flat) if scale.ndim else scale).to(device, torch.float32)
            if group:
                rows = rotate(rows, group)
            return rows.to(dtype).reshape(*ids.shape, -1)

    return Tokens()


def load(store, pool, source='text', device='cuda', config=None):
    """The language model ready to read prompts: its matrices taken from `pool` as they run, its
    small weights (norms, the decays and filters of the linear attention) on the device in the
    precision the file stores them in."""
    import torch
    from accelerate import init_empty_weights
    from accelerate.utils import set_module_tensor_to_device
    from transformers import Qwen3_5TextModel

    from runner.models.pool import load_streamed

    listed = pool.keys(source)
    with init_empty_weights():
        model = Qwen3_5TextModel(config or text_config())
    model.embed_tokens = table(store, listed, PREFIX + 'embed_tokens.weight', device, torch.bfloat16)
    linear = {name for name, module in model.named_modules() if isinstance(module, torch.nn.Linear)}
    names = {}
    for name in sorted(linear):
        if PREFIX + name + '.weight' not in listed:
            raise ValueError('Missing text encoder matrix: ' + name)
        names[name + '.weight'] = (source, PREFIX + name + '.weight', None)
    for name, parameter in list(model.named_parameters()):
        if name.rpartition('.')[0] in linear:
            continue
        if PREFIX + name not in listed:
            raise ValueError('Missing text encoder weight: ' + name)
        value = store.get_tensor(PREFIX + name)
        if tuple(value.shape) != tuple(parameter.shape):
            raise ValueError('Text encoder shape mismatch: ' + name)
        # In the precision of the file: the decays of the linear attention are stored in float32.
        set_module_tensor_to_device(model, name, device, value=value, dtype=value.dtype)
    return load_streamed(model, names, pool).to(device)


def encode(model, tokenizer, prompt, device='cuda'):
    """[1, tokens, 4096]: the last hidden state for one prompt, in the precision the model works in."""
    import torch

    ids = tokenizer(chat(prompt), return_tensors='pt', truncation=True, max_length=MAX_TOKENS).input_ids.to(device)
    with torch.inference_mode():
        output = model(input_ids=ids, attention_mask=torch.ones_like(ids), use_cache=False)
    return output.last_hidden_state


def conditioning(prompts, encoder, tokenizer_path, progress, ram_reserve=None, device='cuda'):
    """The conditioning of each prompt, in order (a tensor [1, tokens, 4096] on the device each).

    Those read lately are given back as they were; the encoder is loaded for the others only,
    once for all of them, and has left the card when this returns."""
    import torch

    stamp = (_identity(encoder), str(Path(tokenizer_path).resolve()))
    found = {}
    for prompt in prompts:
        if (*stamp, prompt) in KEPT:
            KEPT.move_to_end((*stamp, prompt))
            found[prompt] = KEPT[(*stamp, prompt)]
    missing = [prompt for prompt in dict.fromkeys(prompts) if prompt not in found]
    if not missing:
        progress('prompt already encoded')
    else:
        from transformers import AutoTokenizer

        from runner.models.pool import WeightPool, room
        from runner.models.residency import open_store

        progress('loading text encoder')
        tokenizer = AutoTokenizer.from_pretrained(str(tokenizer_path), local_files_only=True)
        # Read once per prompt, the file sends nothing away from RAM to sit there and is not
        # locked: the locked share goes to the image model, which every step reads.
        with open_store(str(encoder), reserve=ram_reserve, evict=False, pin=False) as store:
            pool = WeightPool({'text': store}, room(ROOM_GIB))
            try:
                model = load(store, pool, device=device)
                progress('text encoder loaded', gpu_gib=round(pool.limit / 1024**3, 2))
                for prompt in missing:
                    progress('encoding prompt', prompt=prompt)
                    found[prompt] = encode(model, tokenizer, prompt, device).to('cpu', copy=True)
                    if not torch.isfinite(found[prompt].float()).all():
                        raise RuntimeError('Non-finite text conditioning')
                    KEPT[(*stamp, prompt)] = found[prompt]
            finally:
                pool.clear()
                model = None
                gc.collect()
                torch.cuda.empty_cache()
        while len(KEPT) > KEEP:
            KEPT.popitem(last=False)
        progress('prompt encoded')
    return [found[prompt].to(device) for prompt in prompts]
