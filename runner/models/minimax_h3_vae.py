"""MiniMax-H3 video and audio VAEs: Comfy-layout checkpoints loaded into the diffusers models.

The diffusers classes are the reference implementation (Apache-2.0); only the
tensor names and two fused layouts differ in the single-file checkpoints:
- video decoder attention: one `to_qkv` with rows grouped per head as [q k v];
- video decoder FFN: `w1` holds [gate; up], diffusers' gated FFN reads [up; gate];
- audio convolutions: weight norm already folded into plain `weight`.
"""

import json
import re


def video_names(keys, heads=32):
    """{diffusers name: (checkpoint key, transform)} for the video VAE."""
    names = {}
    for key in keys:
        if key in ('__metadata__', 'decoder.mask_token'):
            continue
        name = key
        name = re.sub(r'^encoder\.down\.(\d+)\.block\.(\d+)\.', r'encoder.down_blocks.\1.resnets.\2.', name)
        name = re.sub(r'^encoder\.down\.(\d+)\.downsample\.', r'encoder.down_blocks.\1.downsamplers.0.', name)
        name = name.replace('.nin_shortcut.', '.conv_shortcut.')
        name = name.replace('decoder.x_embedder.', 'decoder.proj_in.')
        name = name.replace('.attn.to_out.', '.attn.to_out.0.')
        name = name.replace('.ff.w2.', '.ff.net.2.')
        if '.attn.to_qkv.' in name:
            for index, part in enumerate('qkv'):
                names[name.replace('.to_qkv.', '.to_' + part + '.')] = (key, ('head_qkv', heads, index))
            continue
        if '.ff.w1.' in name:
            names[name.replace('.ff.w1.', '.ff.net.0.proj.')] = (key, ('swap_halves',))
            continue
        names[name] = (key, None)
    return names


def transform(value, how):
    if how is None:
        return value
    if how[0] == 'head_qkv':
        heads, index = how[1], how[2]
        grouped = value.reshape(heads, 3, value.shape[0] // (3 * heads), *value.shape[1:])
        return grouped[:, index].reshape(-1, *value.shape[1:]).contiguous()
    if how[0] == 'swap_halves':
        gate, up = value.chunk(2, dim=0)
        return __import__('torch').cat([up, gate], dim=0)
    raise ValueError(how)


def audio_model():
    """diffusers audio VAE with weight norm folded, matching the checkpoint's plain weights."""
    import torch
    from diffusers import AutoencoderKLMiniMaxH3Audio

    model = AutoencoderKLMiniMaxH3Audio()
    for module in model.modules():
        if hasattr(module, 'weight_g'):
            torch.nn.utils.remove_weight_norm(module)
        elif hasattr(module, 'parametrizations') and 'weight' in getattr(module, 'parametrizations', {}):
            torch.nn.utils.parametrize.remove_parametrizations(module, 'weight')
    return model


def config(header, name):
    """VAE metadata JSON stored under `name` (latents mean/std and source config)."""
    return json.loads(header['__metadata__'][name])


def _fill(model, tensors, dtype, skip=()):
    """Copy {name: tensor} into an empty model on CUDA; fp32-pinned modules stay float32."""
    import torch
    from accelerate.utils import set_module_tensor_to_device

    keep = tuple(getattr(model, '_keep_in_fp32_modules', None) or ())
    for name, value in list(model.named_parameters()) + list(model.named_buffers()):
        if name.startswith(skip):
            continue
        if name not in tensors:
            if value.device.type != 'meta':
                # Generated buffers (RoPE frequencies, filters) are not stored in the file.
                set_module_tensor_to_device(model, name, 'cuda')
                continue
            raise ValueError('Missing MiniMax-H3 VAE tensor ' + name)
        target = torch.float32 if any(part in name.split('.') for part in keep) else dtype
        set_module_tensor_to_device(model, name, 'cuda', value=tensors[name], dtype=target)


def video_vae(path, part):
    """The video VAE with only `part` ('encoder' or 'decoder') loaded, on CUDA in bfloat16."""
    import torch
    from accelerate import init_empty_weights
    from diffusers import AutoencoderKLMiniMaxH3
    from safetensors import safe_open

    with safe_open(path, framework='pt') as store:
        meta = json.loads(store.metadata()['minimax_h3_video_vae'])
        mapping = video_names(store.keys())
        prefixes = ('encoder.', 'quant_conv.') if part == 'encoder' else ('decoder.', 'post_quant_conv.')
        tensors = {
            name: transform(store.get_tensor(key), how)
            for name, (key, how) in mapping.items()
            if name.startswith(prefixes)
        }
    with init_empty_weights(include_buffers=False):
        model = AutoencoderKLMiniMaxH3(latents_mean=tuple(meta['latents_mean']), latents_std=tuple(meta['latents_std']))
    other = ('decoder.', 'post_quant_conv.') if part == 'encoder' else ('encoder.', 'quant_conv.')
    _fill(model, tensors, torch.bfloat16, skip=other)
    # Drop the half that was never loaded, so no meta tensor is left to report the model's device.
    if part == 'encoder':
        del model.decoder, model.post_quant_conv
    else:
        del model.encoder, model.quant_conv
    return model.eval()


def audio_vae(path):
    """The audio VAE (encoder and decoder), weight norm folded, float32 on CUDA."""
    import torch
    from accelerate import init_empty_weights
    from safetensors import safe_open

    with safe_open(path, framework='pt') as store:
        meta = json.loads(store.metadata()['minimax_h3_audio_vae'])
        tensors = {key: store.get_tensor(key) for key in store.keys() if key not in ('latents_mean', 'latents_std')}
    with init_empty_weights(include_buffers=False):
        model = audio_model()
    model.register_to_config(latents_mean=list(meta['latents_mean']), latents_std=list(meta['latents_std']))
    _fill(model, tensors, torch.float32)
    return model.eval()
