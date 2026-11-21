"""The video VAE of Wan 2.1 from ComfyUI's single file, loaded into diffusers' model.

diffusers' AutoencoderKLWan (Apache-2.0) is the implementation; the file keeps the names of the
original Wan code (`encoder.downsamples.3.residual.2`, `decoder.head.0`…): `renamed` gives each
its place. Latents are normalised channel by channel with the mean and the deviation the model
was trained with (diffusers' configuration holds the same sixteen values as the original code).

A latent frame is 8 x 8 pixels wide and stands for 4 frames, the first for one: 81 frames at
512 x 896 are 21 latent frames of 64 x 112.
"""

import re

_RESIDUAL = {'0': 'norm1', '2': 'conv1', '3': 'norm2', '6': 'conv2'}


def _block(rest):
    """What follows a block's number in the original names, in diffusers' words."""
    found = re.fullmatch(r'residual\.(\d)\.(.+)', rest)
    if found:
        return f'{_RESIDUAL[found.group(1)]}.{found.group(2)}'
    return rest.replace('shortcut.', 'conv_shortcut.')


def renamed(key):
    """The diffusers name of a tensor of the file."""
    if key.startswith('conv1.'):
        return 'quant_conv.' + key[6:]
    if key.startswith('conv2.'):
        return 'post_quant_conv.' + key[6:]
    side, _, rest = key.partition('.')
    if side not in ('encoder', 'decoder'):
        raise ValueError('Unsupported Wan VAE tensor: ' + key)
    if rest.startswith('conv1.'):
        return f'{side}.conv_in.{rest[6:]}'
    if rest.startswith('head.0.'):
        return f'{side}.norm_out.{rest[7:]}'
    if rest.startswith('head.2.'):
        return f'{side}.conv_out.{rest[7:]}'
    found = re.fullmatch(r'middle\.(\d)\.(.+)', rest)
    if found:
        index, tail = found.groups()
        # A residual block, the attention, a residual block.
        place = {'0': 'resnets.0', '1': 'attentions.0', '2': 'resnets.1'}[index]
        return f'{side}.mid_block.{place}.{_block(tail)}'
    found = re.fullmatch(r'downsamples\.(\d+)\.(.+)', rest)
    if found and side == 'encoder':
        return f'encoder.down_blocks.{found.group(1)}.{_block(found.group(2))}'
    found = re.fullmatch(r'upsamples\.(\d+)\.(.+)', rest)
    if found and side == 'decoder':
        # Three residual blocks then the upsampling, four times over (the last without one).
        stage, place = divmod(int(found.group(1)), 4)
        inner = f'resnets.{place}' if place < 3 else 'upsamplers.0'
        return f'decoder.up_blocks.{stage}.{inner}.{_block(found.group(2))}'
    raise ValueError('Unsupported Wan VAE tensor: ' + key)


def load(path, dtype=None):
    """The VAE on the GPU, in the precision of its file unless another is asked."""
    import torch
    from diffusers import AutoencoderKLWan
    from safetensors.torch import load_file

    model = AutoencoderKLWan()
    wanted = model.state_dict()
    stored = {renamed(key): value for key, value in load_file(path).items()}
    missing = sorted(wanted.keys() - stored.keys())
    if missing:
        raise ValueError('Not a Wan 2.1 VAE: missing ' + missing[0])
    extra = sorted(stored.keys() - wanted.keys())
    if extra:
        raise ValueError('Unsupported Wan VAE tensor: ' + extra[0])
    for key, value in wanted.items():
        if tuple(stored[key].shape) != tuple(value.shape):
            raise ValueError('Unexpected Wan VAE tensor size: ' + key)
    model.load_state_dict(stored)
    return model.eval().to('cuda', dtype or next(iter(stored.values())).dtype)


def _statistics(vae, like):
    import torch

    mean = torch.tensor(vae.config.latents_mean, device=like.device, dtype=like.dtype).view(1, -1, 1, 1, 1)
    std = torch.tensor(vae.config.latents_std, device=like.device, dtype=like.dtype).view(1, -1, 1, 1, 1)
    return mean, std


def encode(vae, pixels):
    """Normalised latents [batch, 16, frames, height / 8, width / 8] of `pixels`, [batch, 3,
    frames, height, width] with values from -1 to 1 (the mean of the distribution, not a draw)."""
    import torch

    parameter = next(vae.parameters())
    with torch.inference_mode():
        latents = vae.encode(pixels.to(parameter.device, parameter.dtype)).latent_dist.mode()
    mean, std = _statistics(vae, latents)
    return (latents - mean) / std


def decode(vae, latents):
    """Pixels from -1 to 1, [batch, 3, frames, height, width], of normalised latents."""
    import torch

    parameter = next(vae.parameters())
    latents = latents.to(parameter.device, parameter.dtype)
    mean, std = _statistics(vae, latents)
    with torch.inference_mode():
        return vae.decode(latents * std + mean, return_dict=False)[0].clamp(-1, 1)


def decode16(vae, latents):
    """`decode` with the decoder set in float16 and the weights of its convolutions channels
    last (`vae` is changed: it is not to encode with afterwards). None when a value came out
    that is not a number: float16 holds less far than bfloat16, and the caller then decodes as
    before, with a VAE loaded anew.

    Measured on 21/11, 81 frames at 768 x 448 on a 12 GiB card, against the same decoding in
    float32 (15.9 s, 7.5 GiB): bfloat16 as the file has it, 9.2 s and 4.0 GiB, each value of a
    pixel 0.22 away on 255 on average (20 at most); float16 with the channels last, 8.3 s and
    3.7 GiB, 0.03 away (3 at most). Float16 keeps ten bits of a value where bfloat16 keeps
    seven; channels last alone is the 0.8 s, at bfloat16's exactness."""
    import torch

    vae.to(torch.float16)
    for module in vae.modules():
        if isinstance(module, torch.nn.Conv3d):
            module.weight.data = module.weight.data.to(memory_format=torch.channels_last_3d)
    decoded = decode(vae, latents)
    return decoded if bool(torch.isfinite(decoded).all()) else None
