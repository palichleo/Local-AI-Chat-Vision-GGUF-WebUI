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


# Elements of one strip. A 2048 px image has 128 x 4 M activations: whole-tensor float32
# copies, SiLU outputs and up-sampler expansions (up to 2 GB each) overflow the VRAM.
# Convolutions are local, so they run over horizontal strips with a one-row halo; group
# norms only need whole-image statistics. The result is the whole-image result.
STRIP_ELEMENTS = 1 << 26


def _rows(x, channels=None):
    _, c, _, w = x.shape
    return max(1, STRIP_ELEMENTS // ((channels or c) * w))


def norm_silu(gn, x):
    """SiLU(GroupNorm(x)) as a function of a strip of x, with whole-image float32 statistics."""
    b, c, h, w = x.shape
    groups = gn.num_groups
    per = x.view(b, groups, -1)
    mean = torch.empty(b, groups, device=x.device)
    var = torch.empty_like(mean)
    step = max(1, STRIP_ELEMENTS // per.shape[-1])
    for g in range(0, groups, step):
        var[:, g : g + step], mean[:, g : g + step] = torch.var_mean(
            per[:, g : g + step].float(), dim=-1, unbiased=False
        )
    rstd = (var + gn.eps).rsqrt()
    scale = gn.weight.float().view(groups, -1) * rstd[..., None]  # b, groups, c/groups
    shift = gn.bias.float().view(groups, -1) - mean[..., None] * scale
    scale, shift = scale.reshape(b, c, 1, 1), shift.reshape(b, c, 1, 1)
    return lambda part: F.silu(part.float() * scale + shift).to(x.dtype)


def conv3(conv, x, pre=None):
    """3x3 convolution (padding 1) over strips of rows; `pre` maps a strip of x first."""
    b, _, h, w = x.shape
    out = torch.empty(b, conv.out_channels, h, w, device=x.device, dtype=x.dtype)
    rows = _rows(x, max(x.shape[1], conv.out_channels))
    for top in range(0, h, rows):
        bottom = min(top + rows, h)
        part = x[:, :, max(top - 1, 0) : min(bottom + 1, h)]
        if pre is not None:
            part = pre(part)
        # Zero rows only at the image borders, as the whole-image padding would add.
        part = F.pad(part, (0, 0, 1 if top == 0 else 0, 1 if bottom == h else 0))
        out[:, :, top:bottom] = F.conv2d(part, conv.weight, conv.bias, padding=(0, 1))
    return out


def conv1(conv, x):
    b, _, h, w = x.shape
    out = torch.empty(b, conv.out_channels, h, w, device=x.device, dtype=x.dtype)
    rows = _rows(x, max(x.shape[1], conv.out_channels))
    for top in range(0, h, rows):
        out[:, :, top : top + rows] = conv(x[:, :, top : top + rows])
    return out


class Resnet(nn.Module):
    def __init__(self, n_in, n_out):
        super().__init__()
        self.norm1, self.conv1 = norm(n_in), nn.Conv2d(n_in, n_out, 3, padding=1)
        self.norm2, self.conv2 = norm(n_out), nn.Conv2d(n_out, n_out, 3, padding=1)
        self.conv_shortcut = nn.Conv2d(n_in, n_out, 1) if n_in != n_out else None

    def forward(self, x):
        h = conv3(self.conv1, x, norm_silu(self.norm1, x))
        h = conv3(self.conv2, h, norm_silu(self.norm2, h))
        h += conv1(self.conv_shortcut, x) if self.conv_shortcut is not None else x
        return h


# Query rows per attention slice: the scores of one slice stay near 256 M entries.
SLICE_SCORES = 1 << 28


class Attention(nn.Module):
    """Single-head spatial self-attention of the middle block.

    Its head has 512 channels, beyond the fused kernels: PyTorch would build the whole score
    matrix (65 536^2 for a 2048 px image, several GB), which spills out of VRAM on Windows.
    Queries are therefore processed in slices, as ComfyUI does."""

    def __init__(self, channels):
        super().__init__()
        self.group_norm = norm(channels)
        self.to_q, self.to_k, self.to_v = (nn.Linear(channels, channels) for _ in range(3))
        self.to_out = nn.ModuleList([nn.Linear(channels, channels)])

    def forward(self, x):
        b, c, h, w = x.shape
        y = self.group_norm(x).flatten(2).transpose(1, 2)
        q, k, v = (proj(y)[:, None] for proj in (self.to_q, self.to_k, self.to_v))
        n = q.shape[2]
        step = max(1, SLICE_SCORES // n)
        y = torch.empty_like(q)
        for start in range(0, n, step):
            y[:, :, start : start + step] = F.scaled_dot_product_attention(q[:, :, start : start + step], k, v)
        return x + self.to_out[0](y[:, 0]).transpose(1, 2).reshape(b, c, h, w)


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
        y = torch.empty(b, c, 2 * h, 2 * w, device=x.device, dtype=x.dtype)
        rows = _rows(x, c * 4 * self.frames)
        for top in range(0, h, rows):
            n = min(rows, h - top)
            part = self.upscale_conv(x[:, :, top : top + n]).view(b, 2, 2, self.frames, c, n, w)[:, :, :, 0]
            y[:, :, 2 * top : 2 * (top + n)] = part.permute(0, 3, 4, 1, 5, 2).reshape(b, c, 2 * n, 2 * w)
        return conv3(self.conv, y)


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
        x = conv3(self.conv_in, x)
        for block in self.down_blocks:
            x = block(x)
        x = self.mid_block(x)
        return conv3(self.conv_out, x, norm_silu(self.conv_norm_out, x))


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
        x = self.mid_block(conv3(self.conv_in, z))
        for block in self.up_blocks:
            x = block(x)
        return conv3(self.conv_out, x, norm_silu(self.conv_norm_out, x))


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
