"""MOSS-SoundEffect v2: a 1.3B diffusion transformer over DAC latents, conditioned by Qwen3.

Architecture and sampling after MOSS-SoundEffect v2 (OpenMOSS/MOSS-TTS, folder
moss_soundeffect_v2, itself built on DiffSynth-Studio) — Apache License 2.0; see
THIRD_PARTY_NOTICES.md. Only what text-to-sound inference needs is kept, written again:
the transformer blocks of Wan with a 1-D rotary position, the flow-matching Euler steps,
and the decoder of the continuous DAC VAE (its encoder is not loaded). Weight-normalised
convolutions are folded into plain ones at load time.

The weights are the published Hugging Face folder: transformer/ (diffusers-style keys),
text_encoder/ (Qwen3-1.7B), tokenizer/, vae/vae_128d_48k.pth and scheduler/.
"""

import html
import json
import math
import re
from pathlib import Path

import torch
from torch import nn
from torch.nn import functional as F

# The published transformer uses diffusers names; the blocks below keep Wan's own.
BLOCK_NAMES = {
    'attn1.norm_k.weight': 'self_attn.norm_k.weight',
    'attn1.norm_q.weight': 'self_attn.norm_q.weight',
    'attn1.to_k.bias': 'self_attn.k.bias',
    'attn1.to_k.weight': 'self_attn.k.weight',
    'attn1.to_out.0.bias': 'self_attn.o.bias',
    'attn1.to_out.0.weight': 'self_attn.o.weight',
    'attn1.to_q.bias': 'self_attn.q.bias',
    'attn1.to_q.weight': 'self_attn.q.weight',
    'attn1.to_v.bias': 'self_attn.v.bias',
    'attn1.to_v.weight': 'self_attn.v.weight',
    'attn2.norm_k.weight': 'cross_attn.norm_k.weight',
    'attn2.norm_q.weight': 'cross_attn.norm_q.weight',
    'attn2.to_k.bias': 'cross_attn.k.bias',
    'attn2.to_k.weight': 'cross_attn.k.weight',
    'attn2.to_out.0.bias': 'cross_attn.o.bias',
    'attn2.to_out.0.weight': 'cross_attn.o.weight',
    'attn2.to_q.bias': 'cross_attn.q.bias',
    'attn2.to_q.weight': 'cross_attn.q.weight',
    'attn2.to_v.bias': 'cross_attn.v.bias',
    'attn2.to_v.weight': 'cross_attn.v.weight',
    'ffn.net.0.proj.bias': 'ffn.0.bias',
    'ffn.net.0.proj.weight': 'ffn.0.weight',
    'ffn.net.2.bias': 'ffn.2.bias',
    'ffn.net.2.weight': 'ffn.2.weight',
    'norm2.bias': 'norm3.bias',
    'norm2.weight': 'norm3.weight',
    'scale_shift_table': 'modulation',
}
GLOBAL_NAMES = {
    'condition_embedder.text_embedder.linear_1.bias': 'text_embedding.0.bias',
    'condition_embedder.text_embedder.linear_1.weight': 'text_embedding.0.weight',
    'condition_embedder.text_embedder.linear_2.bias': 'text_embedding.2.bias',
    'condition_embedder.text_embedder.linear_2.weight': 'text_embedding.2.weight',
    'condition_embedder.time_embedder.linear_1.bias': 'time_embedding.0.bias',
    'condition_embedder.time_embedder.linear_1.weight': 'time_embedding.0.weight',
    'condition_embedder.time_embedder.linear_2.bias': 'time_embedding.2.bias',
    'condition_embedder.time_embedder.linear_2.weight': 'time_embedding.2.weight',
    'condition_embedder.time_proj.bias': 'time_projection.1.bias',
    'condition_embedder.time_proj.weight': 'time_projection.1.weight',
    'scale_shift_table': 'head.modulation',
    'proj_out.bias': 'head.head.bias',
    'proj_out.weight': 'head.head.weight',
}
TEXT_LENGTH = 512


def native_names(state):
    out = {}
    for key, value in state.items():
        if key in GLOBAL_NAMES:
            out[GLOBAL_NAMES[key]] = value
        elif key.startswith('blocks.'):
            _, index, suffix = key.split('.', 2)
            out[f'blocks.{index}.{BLOCK_NAMES.get(suffix, suffix)}'] = value
        else:
            out[key] = value
    return out


# ---------------------------------------------------------------- transformer


def timestep_embedding(dim, position):
    angles = torch.outer(
        position.double(),
        torch.pow(10000, -torch.arange(dim // 2, dtype=torch.float64, device=position.device).div(dim // 2)),
    )
    return torch.cat([torch.cos(angles), torch.sin(angles)], dim=1).to(position.dtype)


def rotary(head_dim, end=16384, theta=10000.0):
    """cos and sin of a 1-D rotary position over the whole head, as [end, head_dim / 2]."""
    frequencies = 1.0 / (theta ** (torch.arange(0, head_dim, 2)[: head_dim // 2].double() / head_dim))
    angles = torch.outer(torch.arange(end, dtype=torch.float64), frequencies)
    return torch.cos(angles).float(), torch.sin(angles).float()


def rotate(x, cos, sin, heads):
    dtype = x.dtype
    b, s, _ = x.shape
    x = x.float().view(b, s, heads, -1, 2)
    even, odd = x[..., 0], x[..., 1]
    cos, sin = cos[:s, None], sin[:s, None]
    return torch.stack((even * cos - odd * sin, even * sin + odd * cos), dim=-1).flatten(2).to(dtype)


def attention(q, k, v, heads):
    b = q.shape[0]
    q, k, v = (t.view(b, -1, heads, t.shape[-1] // heads).transpose(1, 2) for t in (q, k, v))
    return F.scaled_dot_product_attention(q, k, v).transpose(1, 2).flatten(2)


class Attention(nn.Module):
    def __init__(self, dim, heads, eps):
        super().__init__()
        self.heads = heads
        self.q, self.k, self.v, self.o = (nn.Linear(dim, dim) for _ in range(4))
        self.norm_q = nn.RMSNorm(dim, eps=eps)
        self.norm_k = nn.RMSNorm(dim, eps=eps)

    def forward(self, x, context=None, cos=None, sin=None):
        source = x if context is None else context
        q, k, v = self.norm_q(self.q(x)), self.norm_k(self.k(source)), self.v(source)
        if context is None:
            q, k = rotate(q, cos, sin, self.heads), rotate(k, cos, sin, self.heads)
        return self.o(attention(q, k, v, self.heads))


class Block(nn.Module):
    def __init__(self, dim, heads, ffn_dim, eps):
        super().__init__()
        self.self_attn = Attention(dim, heads, eps)
        self.cross_attn = Attention(dim, heads, eps)
        self.norm1 = nn.LayerNorm(dim, eps=eps, elementwise_affine=False)
        self.norm2 = nn.LayerNorm(dim, eps=eps, elementwise_affine=False)
        self.norm3 = nn.LayerNorm(dim, eps=eps)
        self.ffn = nn.Sequential(nn.Linear(dim, ffn_dim), nn.GELU(approximate='tanh'), nn.Linear(ffn_dim, dim))
        self.modulation = nn.Parameter(torch.zeros(1, 6, dim))

    def forward(self, x, context, t_mod, cos, sin):
        shift_a, scale_a, gate_a, shift_f, scale_f, gate_f = (
            self.modulation.to(dtype=t_mod.dtype, device=t_mod.device) + t_mod
        ).chunk(6, dim=1)
        x = x + gate_a * self.self_attn(self.norm1(x) * (1 + scale_a) + shift_a, cos=cos, sin=sin)
        x = x + self.cross_attn(self.norm3(x), context)
        return x + gate_f * self.ffn(self.norm2(x) * (1 + scale_f) + shift_f)


class Head(nn.Module):
    def __init__(self, dim, out_dim, patch, eps):
        super().__init__()
        self.norm = nn.LayerNorm(dim, eps=eps, elementwise_affine=False)
        self.head = nn.Linear(dim, out_dim * patch)
        self.modulation = nn.Parameter(torch.zeros(1, 2, dim))

    def forward(self, x, t):
        shift, scale = (self.modulation.to(dtype=t.dtype, device=t.device) + t.unsqueeze(1)).chunk(2, dim=1)
        return self.head(self.norm(x) * (1 + scale) + shift)


class Transformer(nn.Module):
    def __init__(self, in_dim, out_dim, text_dim, freq_dim, eps, patch_size, dim, ffn_dim, num_heads, num_layers, **_):
        super().__init__()
        patch = patch_size[0] if isinstance(patch_size, (list, tuple)) else int(patch_size)
        self.dim, self.freq_dim, self.patch, self.heads = dim, freq_dim, patch, num_heads
        self.patch_embedding = nn.Conv1d(in_dim, dim, kernel_size=patch, stride=patch)
        self.text_embedding = nn.Sequential(nn.Linear(text_dim, dim), nn.GELU(approximate='tanh'), nn.Linear(dim, dim))
        self.time_embedding = nn.Sequential(nn.Linear(freq_dim, dim), nn.SiLU(), nn.Linear(dim, dim))
        self.time_projection = nn.Sequential(nn.SiLU(), nn.Linear(dim, dim * 6))
        self.blocks = nn.ModuleList(Block(dim, num_heads, ffn_dim, eps) for _ in range(num_layers))
        self.head = Head(dim, out_dim, patch, eps)
        cos, sin = rotary(dim // num_heads)
        self.register_buffer('cos', cos, persistent=False)
        self.register_buffer('sin', sin, persistent=False)

    def forward(self, latents, timestep, context):
        """latents [B, C, T], timestep [1], context [B, L, text_dim] → velocity [B, C, T]."""
        with torch.autocast(latents.device.type, dtype=torch.float32, enabled=latents.device.type == 'cuda'):
            t = self.time_embedding(timestep_embedding(self.freq_dim, timestep))
            t_mod = self.time_projection(t).unflatten(1, (6, self.dim))
        context = self.text_embedding(context)
        x = self.patch_embedding(latents).transpose(1, 2)
        frames = x.shape[1]
        for block in self.blocks:
            x = block(x, context, t_mod, self.cos, self.sin)
        x = self.head(x, t)
        # [B, F, P·C] → [B, C, F·P]
        b = x.shape[0]
        return x.view(b, frames, self.patch, -1).permute(0, 3, 1, 2).reshape(b, -1, frames * self.patch)


def load_transformer(folder, dtype=torch.float32):
    from safetensors.torch import load_file

    folder = Path(folder)
    config = json.loads((folder / 'config.json').read_text(encoding='utf-8'))
    with torch.device('meta'):
        model = Transformer(**config)
    state = native_names(load_file(str(folder / 'diffusion_pytorch_model.safetensors')))
    loaded = model.load_state_dict(state, strict=False, assign=True)
    if loaded.missing_keys:
        raise ValueError(
            'Le transformer de MOSS-SoundEffect est incomplet : ' + ', '.join(loaded.missing_keys[:3]) + '…'
        )
    cos, sin = rotary(config['dim'] // config['num_heads'])
    model.cos, model.sin = cos, sin
    return model.to(dtype).eval()


# ---------------------------------------------------------------- flow matching


def sigmas(steps, shift):
    """Noise levels from 1 down to (not including) 0, bent by the flow-matching shift."""
    values = torch.linspace(1.0, 0.0, steps + 1)[:-1]
    return shift * values / (1 + (shift - 1) * values)


# ---------------------------------------------------------------- text


def clean(text):
    text = html.unescape(html.unescape(text)).strip()
    return re.sub(r'\s+', ' ', text).strip()


def encode_text(model, tokenizer, prompts, device):
    """Last hidden states of Qwen3 over 512 tokens, zero after each prompt's own tokens."""
    tokens = tokenizer(
        [clean(prompt) for prompt in prompts],
        return_tensors='pt',
        padding='max_length',
        truncation=True,
        max_length=TEXT_LENGTH,
        add_special_tokens=True,
    )
    ids, mask = tokens.input_ids.to(device), tokens.attention_mask.to(device)
    with torch.no_grad():
        hidden = model(input_ids=ids, attention_mask=mask, output_hidden_states=True, use_cache=False).hidden_states[-1]
    for index, length in enumerate(mask.gt(0).sum(dim=1).tolist()):
        hidden[index, length:] = 0
    return hidden


# ---------------------------------------------------------------- DAC decoder


@torch.jit.script
def snake(x, alpha):
    shape = x.shape
    x = x.reshape(shape[0], shape[1], -1)
    x = x + (alpha + 1e-9).reciprocal() * torch.sin(alpha * x).pow(2)
    return x.reshape(shape)


class Snake(nn.Module):
    def __init__(self, channels):
        super().__init__()
        self.alpha = nn.Parameter(torch.ones(1, channels, 1))

    def forward(self, x):
        return snake(x, self.alpha)


class Residual(nn.Module):
    def __init__(self, dim, dilation):
        super().__init__()
        self.block = nn.Sequential(
            Snake(dim),
            nn.Conv1d(dim, dim, kernel_size=7, dilation=dilation, padding=3 * dilation),
            Snake(dim),
            nn.Conv1d(dim, dim, kernel_size=1),
        )

    def forward(self, x):
        y = self.block(x)
        pad = (x.shape[-1] - y.shape[-1]) // 2
        if pad > 0:
            x = x[..., pad:-pad]
        return x + y


class Up(nn.Module):
    def __init__(self, input_dim, output_dim, stride):
        super().__init__()
        self.block = nn.Sequential(
            Snake(input_dim),
            nn.ConvTranspose1d(
                input_dim,
                output_dim,
                kernel_size=2 * stride,
                stride=stride,
                padding=math.ceil(stride / 2),
                output_padding=stride % 2,
            ),
            Residual(output_dim, 1),
            Residual(output_dim, 3),
            Residual(output_dim, 9),
        )

    def forward(self, x):
        return self.block(x)


class Decoder(nn.Module):
    def __init__(self, latent_dim, channels, rates):
        super().__init__()
        layers = [nn.Conv1d(latent_dim, channels, kernel_size=7, padding=3)]
        for index, stride in enumerate(rates):
            layers.append(Up(channels // 2**index, channels // 2 ** (index + 1), stride))
        output_dim = channels // 2 ** len(rates)
        layers += [Snake(output_dim), nn.Conv1d(output_dim, 1, kernel_size=7, padding=3), nn.Tanh()]
        self.model = nn.Sequential(*layers)

    def forward(self, x):
        return self.model(x)


class AudioDecoder(nn.Module):
    """The decoding half of the continuous DAC VAE: [B, 128, T] latents → [B, 1, T·hop] waveform."""

    def __init__(self, latent_dim, channels, rates):
        super().__init__()
        self.hop = math.prod(rates)
        self.post_quant_conv = nn.Conv1d(latent_dim, latent_dim, 1)
        self.decoder = Decoder(latent_dim, channels, rates)

    def forward(self, z):
        return self.decoder(self.post_quant_conv(z))


def fold_weight_norm(state):
    """weight_g / weight_v pairs (torch weight_norm, dim 0) as the plain weight they stand for."""
    out = {}
    for key, value in state.items():
        if key.endswith('.weight_v'):
            base = key[: -len('_v')]
            g = state[base + '_g']
            norm = value.float().flatten(1).norm(dim=1).view(-1, *([1] * (value.dim() - 1)))
            out[base] = (g.float() * value.float() / norm).to(value.dtype)
        elif not key.endswith('.weight_g'):
            out[key] = value
    return out


def load_decoder(path):
    """The DAC decoder of a .pth (read without running any pickled code) or .safetensors file."""
    path = Path(path)
    if path.suffix == '.safetensors':
        from safetensors.torch import load_file

        checkpoint = dict(state_dict=load_file(str(path)))
    else:
        checkpoint = torch.load(str(path), map_location='cpu', weights_only=True)
    state = checkpoint.get('state_dict', checkpoint) if isinstance(checkpoint, dict) else None
    if not isinstance(state, dict):
        raise ValueError('Le VAE de MOSS-SoundEffect est illisible.')
    state = fold_weight_norm(
        {key: value for key, value in state.items() if key.split('.')[0] in ('post_quant_conv', 'decoder')}
    )
    if 'post_quant_conv.weight' not in state or 'decoder.model.0.weight' not in state:
        raise ValueError('Ce VAE n’est pas le DAC continu de MOSS-SoundEffect v2.')
    # The sizes come from the weights: first convolution, then one transposed convolution per stage.
    channels, latent_dim = state['decoder.model.0.weight'].shape[:2]
    rates, index = [], 1
    while f'decoder.model.{index}.block.1.weight' in state:
        rates.append(state[f'decoder.model.{index}.block.1.weight'].shape[-1] // 2)
        index += 1
    model = AudioDecoder(latent_dim, channels, rates)
    model.load_state_dict(state, strict=True)
    return model.eval()
