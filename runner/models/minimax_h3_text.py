"""MiniMax-H3 conditioner: Qwen3-VL-32B truncated to 50 layers, read unnormalized.

The language model is streamed layer by layer from the single file. NVFP4
(ModelOpt AWQ) linears are dequantized on the GPU per use with
comfy_kitchen.dequantize_nvfp4 (Apache-2.0); int8 ConvRot files use the int8
kernel. The vision tower stays bfloat16. The diffusers MiniMax-H3 blocks build
the token presentation; `prompt_embeds` replaces their conditioner call.
"""

import json

import torch
import torch.nn.functional as F

EXTRA_TOKENS = {
    '<d>': 151669,
    '</d>': 151670,
    '<|cutoff|>': 151671,
    '<|lyrics_start|>': 151672,
    '<|lyrics_end|>': 151673,
    '<|caption_start|>': 151674,
    '<|caption_end|>': 151675,
}


def config():
    from transformers import Qwen3VLConfig

    return Qwen3VLConfig(
        text_config=dict(
            hidden_size=5120,
            intermediate_size=25600,
            num_hidden_layers=50,
            num_attention_heads=64,
            num_key_value_heads=8,
            head_dim=128,
            vocab_size=151936,
            rms_norm_eps=1e-6,
            max_position_embeddings=262144,
            rope_theta=5000000.0,
            rope_scaling=dict(rope_type='default', mrope_section=[24, 20, 20], mrope_interleaved=True),
            tie_word_embeddings=False,
        ),
        vision_config=dict(
            depth=27,
            hidden_size=1152,
            intermediate_size=4304,
            num_heads=16,
            out_hidden_size=5120,
            patch_size=16,
            spatial_merge_size=2,
            temporal_patch_size=2,
            num_position_embeddings=2304,
            deepstack_visual_indexes=[8, 16, 24],
            in_channels=3,
            hidden_act='gelu_pytorch_tanh',
        ),
    )


def align_extra_tokens(tokenizer):
    """MiniMax-H3's own tokens, at the ids the model was trained with: right after the 151669 of a
    Qwen3 tokenizer. A Qwen2.5 tokenizer stops at 151665: placeholders no prompt contains fill the
    gap first, so either gives them the same ids."""
    if all(tokenizer.convert_tokens_to_ids(token) == index for token, index in EXTRA_TOKENS.items()):
        return
    first = min(EXTRA_TOKENS.values())
    fillers = ['<|minimax_h3_reserved_' + str(index) + '|>' for index in range(len(tokenizer), first)]
    tokenizer.add_special_tokens({'additional_special_tokens': fillers + list(EXTRA_TOKENS)})
    for token, index in EXTRA_TOKENS.items():
        found = tokenizer.convert_tokens_to_ids(token)
        if found != index:
            raise ValueError(
                'Tokenizer vocabulary does not match MiniMax-H3 ('
                + token
                + ' is '
                + str(found)
                + ', expected '
                + str(index)
                + '): choose a Qwen2.5 or Qwen3 tokenizer, such as ComfyUI qwen25_tokenizer'
            )


def processor(tokenizer_path):
    """Qwen3-VL processor around the local Qwen tokenizer, with MiniMax-H3's extra tokens."""
    from pathlib import Path
    from transformers import Qwen2TokenizerFast, Qwen2VLImageProcessor, Qwen3VLProcessor
    from transformers.models.qwen3_vl.video_processing_qwen3_vl import Qwen3VLVideoProcessor

    folder = Path(tokenizer_path)
    if folder.is_file():
        folder = folder.parent
    # from_pretrained reads tokenizer_config.json, which declares the vision tokens.
    tokenizer = Qwen2TokenizerFast.from_pretrained(str(folder))
    specials = ['<|vision_start|>', '<|vision_end|>', '<|image_pad|>', '<|video_pad|>']
    for token in specials:
        if tokenizer.convert_tokens_to_ids(token) in (None, tokenizer.unk_token_id):
            raise ValueError('The tokenizer lacks the Qwen-VL vision tokens')
    align_extra_tokens(tokenizer)
    images = Qwen2VLImageProcessor(
        size={'shortest_edge': 65536, 'longest_edge': 16777216},
        patch_size=16,
        temporal_patch_size=2,
        merge_size=2,
        image_mean=[0.5, 0.5, 0.5],
        image_std=[0.5, 0.5, 0.5],
    )
    videos = Qwen3VLVideoProcessor(
        patch_size=16, temporal_patch_size=2, merge_size=2, image_mean=[0.5, 0.5, 0.5], image_std=[0.5, 0.5, 0.5]
    )
    return tokenizer, Qwen3VLProcessor(image_processor=images, tokenizer=tokenizer, video_processor=videos)


class _TextPool:
    """Streams quantized language-model linears; nothing stays resident between uses."""

    def __init__(self, store):
        import comfy_kitchen

        self.store = store
        self.kernels = comfy_kitchen
        self.keys = set(store.keys())

    def tensor(self, key):
        return self.store.get_tensor(key).to('cuda', non_blocking=True)

    def optional(self, key):
        return self.tensor(key) if key in self.keys else None


class QuantLinear(torch.nn.Module):
    def __init__(self, pool, stem):
        super().__init__()
        self.pool = pool
        self.stem = stem
        quant = json.loads(pool.store.get_tensor(stem + '.comfy_quant').numpy().tobytes())
        self.format = quant.get('format')
        self.rotation = quant.get('convrot_groupsize', 256) if quant.get('convrot') else 0
        if self.format not in ('nvfp4', 'int8_tensorwise'):
            raise ValueError('Unsupported conditioner quantization: ' + str(self.format))

    def forward(self, value):
        pool, stem = self.pool, self.stem
        weight = pool.tensor(stem + '.weight')
        scale = pool.tensor(stem + '.weight_scale')
        bias = pool.optional(stem + '.bias')
        smooth = pool.optional(stem + '.pre_quant_scale')
        if smooth is not None:
            # ModelOpt AWQ smoothing folded out of the weight, applied to the input.
            value = value * smooth.to(value.dtype)
        if self.format == 'nvfp4':
            dense = pool.kernels.dequantize_nvfp4(weight, pool.tensor(stem + '.weight_scale_2'), scale, value.dtype)
            return F.linear(value, dense, None if bias is None else bias.to(value.dtype))
        return torch.ops.comfy_kitchen.int8_linear(
            value,
            weight,
            scale,
            bias,
            pool.kernels.DTYPE_TO_CODE[value.dtype],
            bool(self.rotation),
            self.rotation or 256,
        )


class QuantEmbedding(torch.nn.Module):
    """int8 vocabulary with one scale per row; only the looked-up rows are read."""

    def __init__(self, store, stem):
        super().__init__()
        self.store = store
        self.stem = stem

    def forward(self, ids):
        flat = ids.reshape(-1).cpu()
        table = self.store.get_slice(self.stem + '.weight')
        scales = self.store.get_slice(self.stem + '.weight_scale')
        rows = torch.stack([table[int(i) : int(i) + 1][0] for i in flat]).to(ids.device, torch.bfloat16)
        scale = torch.cat([scales[int(i) : int(i) + 1] for i in flat]).to(ids.device, torch.bfloat16)
        return (rows * scale.reshape(-1, 1)).reshape(*ids.shape, -1)


def load(path):
    """Qwen3VLModel with streamed language model and resident bf16 vision tower, plus the open store."""
    from accelerate import init_empty_weights
    from accelerate.utils import set_module_tensor_to_device
    from transformers import Qwen3VLModel
    from runner.models.residency import open_store

    # Read once per prompt, this file sends nothing away from RAM to sit there (`evict`): the
    # share of the video model locked for every step stays where it is. Where the file finds no
    # room (15 GiB beside that share, in 32 GiB), its layers come from the disk in the order they
    # run, a little ahead of them (Store.follow). Sent away, the share of the video model was read
    # back from the disk at every new prompt: 12 to 13 s.
    store = open_store(path, evict=False)
    keys = set(store.keys())
    with init_empty_weights():
        model = Qwen3VLModel(config())
    # MiniMax-H3 reads the hidden state after the last kept layer, before any final norm.
    model.language_model.norm = torch.nn.Identity()
    pool = _TextPool(store)
    order = []
    for name, module in list(model.language_model.named_modules()):
        if isinstance(module, torch.nn.Linear):
            model.language_model.set_submodule(name, QuantLinear(pool, 'model.' + name))
            # What the layer reads when it runs, in that order (QuantLinear.forward).
            for suffix in ('.weight', '.weight_scale', '.bias', '.pre_quant_scale', '.weight_scale_2'):
                if 'model.' + name + suffix in keys:
                    order.append('model.' + name + suffix)
    model.language_model.embed_tokens = QuantEmbedding(store, 'model.embed_tokens')
    for name, _ in list(model.named_parameters()):
        key = 'model.' + name[len('language_model.') :] if name.startswith('language_model.') else name
        if key not in keys:
            raise ValueError('Missing conditioner tensor ' + key)
        set_module_tensor_to_device(model, name, 'cuda', value=store.get_tensor(key), dtype=torch.bfloat16)
    for name, buffer in list(model.named_buffers()):
        if buffer.device.type == 'meta':
            raise ValueError('Uninitialized conditioner buffer ' + name)
    model = model.eval().to('cuda')
    store.follow(order)
    return model, store


def prompt_embeds(
    text_encoder, processor, token_ids, vision_inputs=None, text_encoder_layer=50, device=None, dtype=None
):
    """Drop-in for diffusers' `get_qwen3vl_prompt_embeds` on the truncated, unnormalized stack."""
    if text_encoder_layer != text_encoder.config.text_config.num_hidden_layers:
        raise ValueError('The conditioner file must hold exactly the layers MiniMax-H3 reads')
    here = text_encoder.device
    input_ids = torch.tensor([token_ids], dtype=torch.long, device=here)
    types = torch.tensor(processor.create_mm_token_type_ids([token_ids]), dtype=torch.long, device=here)
    vision = {
        name: value.to(here, text_encoder.dtype) if name.startswith('pixel_') else value.to(here)
        for name, value in (vision_inputs or {}).items()
    }
    with torch.inference_mode():
        output = text_encoder(
            input_ids=input_ids,
            attention_mask=torch.ones_like(input_ids),
            mm_token_type_ids=types,
            use_cache=False,
            **vision,
        )
    return output.last_hidden_state.to(device=device or 'cuda', dtype=dtype or torch.bfloat16)
