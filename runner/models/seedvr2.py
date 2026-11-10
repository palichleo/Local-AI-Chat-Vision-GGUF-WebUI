"""SeedVR2 7B (one-step diffusion restoration), native port for still images.

Architecture after ByteDance-Seed/SeedVR and numz/ComfyUI-SeedVR2_VideoUpscaler (both
Apache-2.0): a native-resolution DiT whose 36 blocks alternate shifted 3D windows; inside a
window the video tokens attend jointly with the (fixed) text embedding, whose per-window
outputs are averaged. Weights are read as published by Comfy-Org (fp8 or int8 ConvRot), with
the positive text embedding stored in the checkpoint.
"""

import math
from pathlib import Path

import torch
import torch.nn.functional as F
from torch import nn

DIM, HEADS, HEAD_DIM, LAYERS = 3072, 24, 128, 36
LATENT, CONDITION = 16, 17  # noise latent | (degraded latent, mask)
PATCH = 2
TEXT_DIM = 5120
WINDOWS = (4, 3, 3)
EPS = 1e-5


def signature(header):
    """Whether a checkpoint header is a supported SeedVR2 7B DiT."""
    keys = set(header)
    return (
        'vid_in.proj.weight' in keys
        and header['vid_in.proj.weight']['shape'] == [DIM, (LATENT + CONDITION) * PATCH * PATCH]
        and f'blocks.{LAYERS - 1}.attn.proj_qkv.vid.weight' in keys
    )


def rms(x, weight=None):
    x = x * torch.rsqrt(x.float().pow(2).mean(-1, keepdim=True) + EPS).to(x.dtype)
    return x if weight is None else x * weight


def timestep_embedding(t, dim=256):
    """Sinusoidal embedding as diffusers' get_timestep_embedding (sin first, no shift)."""
    half = dim // 2
    exponent = -math.log(10000) * torch.arange(half, dtype=torch.float32, device=t.device) / half
    angles = t.float()[:, None] * exponent.exp()[None]
    return torch.cat([angles.sin(), angles.cos()], dim=-1)


def window_slices(size, method):
    """SeedVR2's '720p' windows over a (t, h, w) token grid: a 4x3x3 grid of a 45x80 frame,
    scaled to the actual size; odd blocks use the same windows shifted by half a window."""
    t, h, w = size
    nt, nh, nw = WINDOWS
    scale = math.sqrt((45 * 80) / (h * w))
    wh, ww = math.ceil(round(h * scale) / nh), math.ceil(round(w * scale) / nw)
    wt = math.ceil(min(t, 30) / nt)
    if method == 'win':
        counts = math.ceil(t / wt), math.ceil(h / wh), math.ceil(w / ww)
        shifts = 0, 0, 0
    else:
        shifts = 0.5 if wt < t else 0, 0.5 if wh < h else 0, 0.5 if ww < w else 0
        counts = tuple(
            math.ceil((n - s) / k) + 1 if s else 1 for n, s, k in zip((t, h, w), shifts, (wt, wh, ww))
        )

    def span(i, shift, size_, total):
        return max(int((i - shift) * size_), 0), min(int((i - shift + 1) * size_), total)

    result = []
    for iw in range(counts[2]):
        sw = span(iw, shifts[2], ww, w)
        if sw[1] <= sw[0]:
            continue
        for ih in range(counts[1]):
            sh = span(ih, shifts[1], wh, h)
            if sh[1] <= sh[0]:
                continue
            for it in range(counts[0]):
                st = span(it, shifts[0], wt, t)
                if st[1] > st[0]:
                    result.append((st, sh, sw))
    return result


class Rope:
    """Axial 3D rotary embedding ('pixel' frequencies) on the first 60 of 128 head channels,
    positions spanning [-1, 1] over each window axis."""

    def __init__(self):
        per_axis = HEAD_DIM // 2 // 3  # 21 -> 10 frequencies, 20 channels per axis
        self.freqs = torch.linspace(1.0, 256 / 2, per_axis // 2) * math.pi
        self.cache = {}

    def __call__(self, size, device):
        key = size, str(device)
        if key not in self.cache:
            axes = []
            for index, n in enumerate(size):
                pos = torch.linspace(-1, 1, steps=n)
                f = (pos[:, None] * self.freqs[None]).repeat_interleave(2, dim=-1)  # n, 20
                shape = [1, 1, 1, f.shape[-1]]
                shape[index] = n
                axes.append(f.view(shape).expand(*size, f.shape[-1]))
            freqs = torch.cat(axes, dim=-1).reshape(-1, 3 * self.freqs.numel() * 2)
            self.cache[key] = (freqs.cos().to(device), freqs.sin().to(device))
        return self.cache[key]


def rotate(x, cos, sin):
    """x: (n, heads, 128); interleaved-pair rotation of its first cos.shape[-1] channels."""
    width = cos.shape[-1]
    head, tail = x[..., :width].float(), x[..., width:]
    pairs = head.unflatten(-1, (-1, 2))
    rotated = torch.stack((-pairs[..., 1], pairs[..., 0]), dim=-1).flatten(-2)
    head = head * cos[:, None] + rotated * sin[:, None]
    return torch.cat([head.to(x.dtype), tail], dim=-1)


class Pair(nn.Module):
    """One module per stream (video, text), as stored: `<name>.vid` and `<name>.txt`."""

    def __init__(self, make):
        super().__init__()
        self.vid, self.txt = make(), make()


class Mlp(nn.Module):
    def __init__(self):
        super().__init__()
        self.proj_in = nn.Linear(DIM, DIM * 4)
        self.proj_out = nn.Linear(DIM * 4, DIM)

    def forward(self, x):
        return self.proj_out(F.gelu(self.proj_in(x), approximate='tanh'))


class Ada(nn.Module):
    def __init__(self):
        super().__init__()
        for layer in ('attn', 'mlp'):
            for part in ('shift', 'scale', 'gate'):
                self.register_parameter(f'{layer}_{part}', nn.Parameter(torch.empty(DIM)))

    def terms(self, emb, layer):
        # emb: (dim * 2 layers * 3) laid out as (dim, layer, shift/scale/gate).
        shift, scale, gate = emb.view(DIM, 2, 3)[:, ('attn', 'mlp').index(layer)].unbind(-1)
        return (
            shift + getattr(self, f'{layer}_shift'),
            scale + getattr(self, f'{layer}_scale'),
            gate + getattr(self, f'{layer}_gate'),
        )


class Norms(nn.Module):
    def __init__(self):
        super().__init__()
        self.weight = nn.Parameter(torch.empty(HEAD_DIM))


class Attention(nn.Module):
    def __init__(self, method):
        super().__init__()
        self.method = method
        self.proj_qkv = Pair(lambda: nn.Linear(DIM, 3 * DIM, bias=False))
        self.proj_out = Pair(lambda: nn.Linear(DIM, DIM))
        self.norm_q = Pair(Norms)
        self.norm_k = Pair(Norms)

    def forward(self, vid, txt, size, rope):
        q_v, k_v, v_v = self.proj_qkv.vid(vid).view(-1, 3, HEADS, HEAD_DIM).unbind(1)
        q_t, k_t, v_t = self.proj_qkv.txt(txt).view(-1, 3, HEADS, HEAD_DIM).unbind(1)
        q_v, k_v = rms(q_v, self.norm_q.vid.weight), rms(k_v, self.norm_k.vid.weight)
        q_t, k_t = rms(q_t, self.norm_q.txt.weight), rms(k_t, self.norm_k.txt.weight)
        grid = torch.arange(vid.shape[0], device=vid.device).view(size)
        out_v = torch.empty_like(v_v)
        out_t = torch.zeros_like(v_t, dtype=torch.float32)
        windows = window_slices(size, self.method)
        texts = txt.shape[0]
        for st, sh, sw in windows:
            index = grid[slice(*st), slice(*sh), slice(*sw)].reshape(-1)
            cos, sin = rope((st[1] - st[0], sh[1] - sh[0], sw[1] - sw[0]), vid.device)
            q = torch.cat([rotate(q_v[index], cos, sin), q_t]).transpose(0, 1)
            k = torch.cat([rotate(k_v[index], cos, sin), k_t]).transpose(0, 1)
            v = torch.cat([v_v[index], v_t]).transpose(0, 1)
            out = F.scaled_dot_product_attention(q[None], k[None], v[None])[0].transpose(0, 1)
            out_v[index] = out[:-texts]
            out_t += out[-texts:].float()
        out_t = (out_t / len(windows)).to(v_t.dtype)
        return self.proj_out.vid(out_v.flatten(1)), self.proj_out.txt(out_t.flatten(1))


class Block(nn.Module):
    def __init__(self, index):
        super().__init__()
        self.attn = Attention('win' if index % 2 == 0 else 'swin')
        self.mlp = Pair(Mlp)
        self.ada = Pair(Ada)

    def forward(self, vid, txt, size, emb, rope):
        terms = {
            (stream, layer): ada.terms(emb, layer)
            for stream, ada in (('vid', self.ada.vid), ('txt', self.ada.txt))
            for layer in ('attn', 'mlp')
        }

        def modulate(x, stream, layer):
            shift, scale, _ = terms[stream, layer]
            return rms(x) * scale + shift

        a_v, a_t = self.attn(modulate(vid, 'vid', 'attn'), modulate(txt, 'txt', 'attn'), size, rope)
        vid = vid + a_v * terms['vid', 'attn'][2]
        txt = txt + a_t * terms['txt', 'attn'][2]
        m_v = self.mlp.vid(modulate(vid, 'vid', 'mlp'))
        m_t = self.mlp.txt(modulate(txt, 'txt', 'mlp'))
        return vid + m_v * terms['vid', 'mlp'][2], txt + m_t * terms['txt', 'mlp'][2]


class TimeEmbedding(nn.Module):
    def __init__(self):
        super().__init__()
        self.proj_in = nn.Linear(256, DIM)
        self.proj_hid = nn.Linear(DIM, DIM)
        self.proj_out = nn.Linear(DIM, 6 * DIM)

    def forward(self, t, dtype):
        x = F.silu(self.proj_in(timestep_embedding(t).to(dtype)))
        return self.proj_out(F.silu(self.proj_hid(x)))


class Linear1(nn.Module):
    def __init__(self, n_in, n_out):
        super().__init__()
        self.proj = nn.Linear(n_in, n_out)


class SeedVR2(nn.Module):
    def __init__(self):
        super().__init__()
        self.vid_in = Linear1((LATENT + CONDITION) * PATCH * PATCH, DIM)
        self.txt_in = nn.Linear(TEXT_DIM, DIM)
        self.emb_in = TimeEmbedding()
        self.blocks = nn.ModuleList(Block(i) for i in range(LAYERS))
        self.vid_out = Linear1(DIM, LATENT * PATCH * PATCH)
        self.rope = Rope()

    def forward(self, latent, txt, timestep, progress=None):
        """latent: (t, h, w, 33) noise latent and condition, h and w even; txt: (L, 5120)."""
        t, h, w, c = latent.shape
        tokens = (h // PATCH, w // PATCH)
        # (T t)(H h)(W w) c -> T H W (t h w c), with t = 1.
        x = latent.view(t, tokens[0], PATCH, tokens[1], PATCH, c).permute(0, 1, 3, 2, 4, 5).reshape(-1, PATCH * PATCH * c)
        vid = self.vid_in.proj(x)
        txt = self.txt_in(txt)
        emb = self.emb_in(timestep.reshape(1), vid.dtype)[0]
        size = (t, *tokens)
        for index, block in enumerate(self.blocks):
            vid, txt = block(vid, txt, size, emb, self.rope)
            if progress:
                progress(index + 1, len(self.blocks))
        out = self.vid_out.proj(vid).view(t, *tokens, PATCH, PATCH, LATENT)
        return out.permute(0, 1, 3, 2, 4, 5).reshape(t, h, w, LATENT)


def load(store, pool):
    """The DiT on CUDA: linears streamed by `pool` (fp8 or int8 ConvRot), the rest resident."""
    from runner.models.ltx25 import load_streamed

    with torch.device('meta'):
        model = SeedVR2()
    names = {key: ('model', key, None) for key in store.keys() if not key.endswith('rope.rope.freqs')}
    # Norm and modulation tensors are tiny: load_streamed casts them to bfloat16 on CUDA.
    return load_streamed(model, names, pool)


# The fixed text embedding SeedVR2 restores with (58 x 5120 bfloat16), as published in
# ByteDance-Seed/SeedVR (pos_emb.pt, Apache-2.0); Comfy-Org checkpoints carry the same bytes.
POSITIVE = Path(__file__).with_name('seedvr2_positive.bf16')


def positive_text(store):
    if 'positive_conditioning' in store.keys():
        return store.get_tensor('positive_conditioning').to('cuda', torch.bfloat16)
    data = bytearray(POSITIVE.read_bytes())
    return torch.frombuffer(data, dtype=torch.bfloat16).view(58, TEXT_DIM).to('cuda')
