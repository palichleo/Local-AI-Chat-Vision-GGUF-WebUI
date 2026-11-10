"""SeedVR2 video VAE, evaluated on a single frame.

The published VAE is a causal 3D autoencoder (ByteDance-Seed/SeedVR, Apache-2.0). On one
frame every causal convolution sees its frame repeated over the temporal kernel, and the
temporal down/up-sampling keeps one frame, so the network is exactly a 2D VAE whose kernels
are the 3D kernels summed over time; temporal up-sampling keeps the first of its two
sub-frames. Group norms are per frame. Latents: 16 channels, 1/8 resolution, scale 0.9152.
"""

import torch
import torch.nn.functional as F
from torch import nn

SCALE = 0.9152
CHANNELS = (128, 256, 512, 512)
TEMPORAL_UP = 2  # the first two decoder up-samplers also double time


def signature(header):
    return (
        header.get('encoder.conv_in.weight', {}).get('shape', [None])[0] == CHANNELS[0]
        and header.get('decoder.up_blocks.0.upsamplers.0.upscale_conv.weight', {}).get('shape', [None])[0]
        == CHANNELS[-1] * 8
        and header.get('encoder.conv_out.weight', {}).get('shape', [None])[0] == 32
    )


class GroupNorm(nn.GroupNorm):
    """Statistics in float32 whatever the weights' precision."""

    def forward(self, x):
        return F.group_norm(x.float(), self.num_groups, self.weight.float(), self.bias.float(), self.eps).to(x.dtype)


def norm(channels):
    return GroupNorm(32, channels, eps=1e-6)


class Resnet(nn.Module):
    def __init__(self, n_in, n_out):
        super().__init__()
        self.norm1, self.conv1 = norm(n_in), nn.Conv2d(n_in, n_out, 3, padding=1)
        self.norm2, self.conv2 = norm(n_out), nn.Conv2d(n_out, n_out, 3, padding=1)
        self.conv_shortcut = nn.Conv2d(n_in, n_out, 1) if n_in != n_out else None

    def forward(self, x):
        h = self.conv1(F.silu(self.norm1(x)))
        h = self.conv2(F.silu(self.norm2(h)))
        return (self.conv_shortcut(x) if self.conv_shortcut is not None else x) + h


class Attention(nn.Module):
    """Single-head spatial self-attention of the middle block."""

    def __init__(self, channels):
        super().__init__()
        self.group_norm = norm(channels)
        self.to_q, self.to_k, self.to_v = (nn.Linear(channels, channels) for _ in range(3))
        self.to_out = nn.ModuleList([nn.Linear(channels, channels)])

    def forward(self, x):
        b, c, h, w = x.shape
        y = self.group_norm(x).flatten(2).transpose(1, 2)
        q, k, v = (proj(y)[:, None] for proj in (self.to_q, self.to_k, self.to_v))
        y = F.scaled_dot_product_attention(q, k, v)[:, 0]
        return x + self.to_out[0](y).transpose(1, 2).reshape(b, c, h, w)


class Mid(nn.Module):
    def __init__(self, channels):
        super().__init__()
        self.resnets = nn.ModuleList([Resnet(channels, channels), Resnet(channels, channels)])
        self.attentions = nn.ModuleList([Attention(channels)])

    def forward(self, x):
        return self.resnets[1](self.attentions[0](self.resnets[0](x)))


class Down(nn.Module):
    def __init__(self, channels):
        super().__init__()
        self.conv = nn.Conv2d(channels, channels, 3, stride=2)

    def forward(self, x):
        return self.conv(F.pad(x, (0, 1, 0, 1)))


class Up(nn.Module):
    """1x1 convolution to sub-pixels, then a 3x3 convolution. Its channels are laid out as
    (x, y, z, c): 2x2 spatial sub-pixels by `ratio` temporal sub-frames, of which one is kept."""

    def __init__(self, channels, temporal):
        super().__init__()
        self.frames = 2 if temporal else 1
        self.upscale_conv = nn.Conv2d(channels, channels * 4 * self.frames, 1)
        self.conv = nn.Conv2d(channels, channels, 3, padding=1)

    def forward(self, x):
        b, c, h, w = x.shape
        y = self.upscale_conv(x).view(b, 2, 2, self.frames, c, h, w)[:, :, :, 0]
        y = y.permute(0, 3, 4, 1, 5, 2).reshape(b, c, 2 * h, 2 * w)
        return self.conv(y)


class Stage(nn.Module):
    def __init__(self, n_in, n_out, layers, sampler):
        super().__init__()
        self.resnets = nn.ModuleList(Resnet(n_in if i == 0 else n_out, n_out) for i in range(layers))
        if sampler == 'down':
            self.downsamplers = nn.ModuleList([Down(n_out)])
        elif sampler:
            self.upsamplers = nn.ModuleList([Up(n_out, sampler == 'up-time')])

    def forward(self, x):
        for resnet in self.resnets:
            x = resnet(x)
        for sampler in getattr(self, 'downsamplers', None) or getattr(self, 'upsamplers', None) or ():
            x = sampler(x)
        return x


class Encoder(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv_in = nn.Conv2d(3, CHANNELS[0], 3, padding=1)
        self.down_blocks = nn.ModuleList(
            Stage(CHANNELS[max(i - 1, 0)], c, 2, 'down' if i < len(CHANNELS) - 1 else None)
            for i, c in enumerate(CHANNELS)
        )
        self.mid_block = Mid(CHANNELS[-1])
        self.conv_norm_out = norm(CHANNELS[-1])
        self.conv_out = nn.Conv2d(CHANNELS[-1], 32, 3, padding=1)

    def forward(self, x):
        x = self.conv_in(x)
        for block in self.down_blocks:
            x = block(x)
        return self.conv_out(F.silu(self.conv_norm_out(self.mid_block(x))))


class Decoder(nn.Module):
    def __init__(self):
        super().__init__()
        reverse = CHANNELS[::-1]
        self.conv_in = nn.Conv2d(16, reverse[0], 3, padding=1)
        self.mid_block = Mid(reverse[0])
        self.up_blocks = nn.ModuleList(
            Stage(
                reverse[max(i - 1, 0)],
                c,
                3,
                None if i == len(reverse) - 1 else ('up-time' if i < TEMPORAL_UP else 'up'),
            )
            for i, c in enumerate(reverse)
        )
        self.conv_norm_out = norm(CHANNELS[0])
        self.conv_out = nn.Conv2d(CHANNELS[0], 3, 3, padding=1)

    def forward(self, z):
        x = self.mid_block(self.conv_in(z))
        for block in self.up_blocks:
            x = block(x)
        return self.conv_out(F.silu(self.conv_norm_out(x)))


class VAE(nn.Module):
    def __init__(self):
        super().__init__()
        self.encoder = Encoder()
        self.decoder = Decoder()

    def encode(self, pixels):
        """pixels: (1, 3, H, W) in [-1, 1], H and W multiples of 8 -> scaled latent mean."""
        return self.encoder(pixels)[:, :16] * SCALE

    def decode(self, latent):
        return self.decoder(latent / SCALE)


def folded(state):
    """3D causal kernels -> 2D kernels, as seen by a single frame."""
    result = {}
    for key, value in state.items():
        result[key] = value.sum(dim=2) if value.ndim == 5 else value
    return result


def load(path, device='cuda', dtype=torch.bfloat16):
    from safetensors.torch import load_file

    state = folded({key: value.float() for key, value in load_file(path).items()})
    with torch.device('meta'):
        model = VAE()
    missing, unexpected = model.load_state_dict(state, strict=False, assign=True)
    if missing or unexpected:
        raise ValueError(f'Unexpected SeedVR2 VAE layout: missing {missing[:4]}, unexpected {unexpected[:4]}')
    return model.to(device=device, dtype=dtype).eval()


def _tiles(size, tile, overlap):
    if size <= tile:
        return [0]
    step = tile - overlap
    starts = list(range(0, size - tile, step)) + [size - tile]
    return sorted(set(starts))


def _ramp(length, overlap, first, last, device):
    weight = torch.ones(length, device=device)
    fade = torch.linspace(0, 1, overlap + 2, device=device)[1:-1]
    if not first:
        weight[:overlap] = fade
    if not last:
        weight[-overlap:] = fade.flip(0)
    return weight


def tiled(function, x, factor, tile, overlap):
    """Apply `function` (scaling sizes by `factor`) over overlapping tiles, blended linearly.
    Whole-image evaluation is preferred: tiles see different group-norm statistics."""
    _, _, h, w = x.shape
    if h <= tile and w <= tile:
        return function(x)
    out, weights = None, None
    rows, cols = _tiles(h, tile, overlap), _tiles(w, tile, overlap)
    for top in rows:
        for left in cols:
            part = function(x[:, :, top : top + tile, left : left + tile])
            if out is None:
                out = torch.zeros(x.shape[0], part.shape[1], int(h * factor), int(w * factor), device=x.device)
                weights = torch.zeros(1, 1, out.shape[2], out.shape[3], device=x.device)
            ph, pw = part.shape[2], part.shape[3]
            o = int(overlap * factor)
            wy = _ramp(ph, o, top == rows[0], top == rows[-1], x.device)
            wx = _ramp(pw, o, left == cols[0], left == cols[-1], x.device)
            weight = wy[:, None] * wx[None]
            y0, x0 = int(top * factor), int(left * factor)
            out[:, :, y0 : y0 + ph, x0 : x0 + pw] += part.float() * weight
            weights[:, :, y0 : y0 + ph, x0 : x0 + pw] += weight
    return (out / weights).to(x.dtype)
