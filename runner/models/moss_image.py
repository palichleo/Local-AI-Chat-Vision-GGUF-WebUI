"""MOSS Image: one stream of image tokens followed by the text tokens, through 42 gated blocks.

Written after the model's own pipeline (OpenMOSS/MOSS-Image, `pipeline_moss_image.py`,
Apache-2.0) and the shapes its files store. The module carries the names of the files, so a
weight is found by the name of the layer that reads it: the published BF16 weights (`proj.q`,
`proj.k`, `proj.v`) and the files repacked for ComfyUI, where the three are one matrix
(`proj.qkv`).

What the model is given and gives back: the latents of the FLUX.2 VAE as that VAE normalises
them, 128 channels at a sixteenth of the picture, no patch of its own; the last hidden state of
Qwen3.5 9B for the text, at its true length (nothing is padded: the positions follow the count of
tokens); the velocity of a flow, for a sigma between 0 (the picture) and 1 (the noise).
"""

import re

import torch
import torch.nn.functional as F
from torch import nn

# The width of an attention head: the files do not write the count of heads, they are 128 wide.
HEAD = 128
EPS = 1e-6
ROPE_BASE = 10000.0
TIME_DIM = 256
# The settings the model is published with: Euler on a flow, its sigmas moved by 5 and brought to
# the thousand steps of the training, the prediction of the negative prompt made without block 22.
SHIFT = 5.0
TRAINING_STEPS = 1000
SKIPPED = (22,)
PREFIXES = ('', 'model.diffusion_model.', 'diffusion_model.')


def situ(hidden, gate):
    """The activation of the feed-forwards: a gate (a SiLU held under 4) on rows held under 25."""
    return (4.0 * torch.tanh(gate / 4.0) * torch.sigmoid(gate)) * (25.0 * torch.tanh(hidden / 25.0))


def bands(head_dim):
    """The frequencies of one axis of positions: an eighth of a head each, of its four axes, as
    sines and cosines. Computed in float32 on the processor, as the training did."""
    count = head_dim // 8
    return 1 / (ROPE_BASE ** (torch.arange(count, dtype=torch.float32) / count))


def coordinates(height, width, text_length):
    """Where each token sits, on four axes (reference, sequence, row, column), image first.

    The image is one point of the sequence axis, right after the text, its rows and columns
    counted from its centre: a larger picture grows around the same middle. The text runs along
    the sequence axis from 0. The first axis numbers reference images: none here.
    """
    image = torch.zeros(height * width, 4, dtype=torch.float32)
    image[:, 1] = text_length
    image[:, 2] = (torch.arange(height, dtype=torch.float32) - (height - 1) / 2).repeat_interleave(width)
    image[:, 3] = (torch.arange(width, dtype=torch.float32) - (width - 1) / 2).repeat(height)
    text = torch.zeros(text_length, 4, dtype=torch.float32)
    text[:, 1] = torch.arange(text_length, dtype=torch.float32)
    return torch.cat((image, text))


def rotations(height, width, text_length, head_dim):
    """(cos, sin) of every token's positions, each [1, tokens, 1, head_dim], in float32.

    A head is two halves: channel i of the first turns with channel i of the second, by the angle
    of its axis and frequency (`rotate`). The four axes share a half in equal parts.
    """
    phase = (coordinates(height, width, text_length).unsqueeze(-1) * bands(head_dim)).flatten(-2)
    cos, sin = phase.cos(), phase.sin()
    return torch.cat((cos, cos), -1)[None, :, None], torch.cat((sin, sin), -1)[None, :, None]


def rotate(x, turn):
    cos, sin = turn
    first, second = x.chunk(2, -1)
    return x * cos + torch.cat((-second, first), -1) * sin


def time_features(sigma, device):
    """The sinusoid of a step, [1, 256] in float32: cosines first, of the sigma counted in
    thousandths (the model was trained on a thousand steps), computed in float64 as the training did."""
    half = TIME_DIM // 2
    frequencies = ROPE_BASE ** (-torch.arange(half, device=device, dtype=torch.float64) / half)
    phase = torch.as_tensor(float(sigma) * TRAINING_STEPS, device=device, dtype=torch.float64) * frequencies
    return torch.cat((phase.cos(), phase.sin())).float().unsqueeze(0)


def sigmas(steps, shift=SHIFT, snap=True):
    """The sigmas of a generation, from the noise (1) to the picture (0): `steps` of them, then 0.

    Evenly spaced points, moved toward the noise by `shift` (most steps then go to the layout
    of the picture). `snap` brings each to the nearest of the thousand sigmas the model was
    trained on, as its own scheduler does; two that fall on the same one count once. Without it
    they are the sigmas ComfyUI's « normal » schedule gives the same model.
    """
    if steps < 1 or shift <= 0:
        raise ValueError('Steps and shift must be positive')
    last = shift / (TRAINING_STEPS + shift - 1)
    points = torch.linspace(1, last, steps, dtype=torch.float64)
    moved = shift * points / (1 + (shift - 1) * points)
    if snap:
        moved = torch.unique_consecutive((moved * TRAINING_STEPS).round().clamp(1, TRAINING_STEPS)) / TRAINING_STEPS
    return [float(value) for value in moved] + [0.0]


def skipping(index, steps, until):
    """Whether step `index` of `steps` makes its negative prediction without the skipped blocks:
    the first part of the generation, up to the share `until` of its steps."""
    return index / steps < until


class Norm(nn.Module):
    """RMS norm with a learnt scale, computed in float32 whatever the precision of the rows."""

    def __init__(self, dim):
        super().__init__()
        self.weight = nn.Parameter(torch.ones(dim))

    def forward(self, x):
        y = x.float()
        y = y * torch.rsqrt(y.square().mean(-1, keepdim=True) + EPS)
        return y.to(x.dtype) * self.weight


def attend(q, k, v, q_norm, k_norm, turn, heads):
    """Attention over [1, tokens, dim] rows: queries and keys normed a head at a time, then turned
    by their positions."""
    split = (*q.shape[:2], heads, q.shape[-1] // heads)
    q = rotate(q_norm(q.reshape(split)), turn).transpose(1, 2)
    k = rotate(k_norm(k.reshape(split)), turn).transpose(1, 2)
    v = v.reshape(split).transpose(1, 2)
    return F.scaled_dot_product_attention(q.to(v.dtype), k.to(v.dtype), v).transpose(1, 2).flatten(2)


class TextBlock(nn.Module):
    """A block of the text's own refinement, before it joins the image: no step, no gate."""

    def __init__(self, dim, ffn_dim, heads):
        super().__init__()
        self.heads = heads
        self.norm1, self.norm2 = Norm(dim), Norm(dim)
        self.q_norm, self.k_norm = Norm(dim // heads), Norm(dim // heads)
        self.qkv = nn.Linear(dim, 3 * dim)
        self.proj = nn.Linear(dim, dim)
        self.ffn_gate, self.ffn_up = nn.Linear(dim, ffn_dim), nn.Linear(dim, ffn_dim)
        self.ffn_down = nn.Linear(ffn_dim, dim)

    def forward(self, x, turn):
        q, k, v = self.qkv(self.norm1(x)).chunk(3, -1)
        x = x + self.proj(attend(q, k, v, self.q_norm, self.k_norm, turn, self.heads))
        y = self.norm2(x)
        return x + self.ffn_down(situ(self.ffn_up(y), self.ffn_gate(y)))


class TextEmbedder(nn.Module):
    def __init__(self, text_dim, dim, ffn_dim, heads, blocks):
        super().__init__()
        self.proj = nn.Linear(text_dim, dim)
        self.blocks = nn.ModuleList([TextBlock(dim, ffn_dim, heads) for _ in range(blocks)])

    def forward(self, x, turn):
        x = self.proj(x)
        for block in self.blocks:
            x = block(x, turn)
        return x


class Block(nn.Module):
    """A block of the joint stream. The step moves and scales its two norms and gates its two
    branches, with one table for every block (`shared_block_modulation`)."""

    def __init__(self, dim, ffn_dim, heads, fused):
        super().__init__()
        self.heads = heads
        self.fused = fused
        self.norm1, self.norm2 = Norm(dim), Norm(dim)
        self.q_norm, self.k_norm = Norm(dim // heads), Norm(dim // heads)
        self.proj = nn.ModuleDict(
            {'qkv': nn.Linear(dim, 3 * dim, bias=False)}
            if fused
            else {name: nn.Linear(dim, dim, bias=False) for name in ('q', 'k', 'v')}
        )
        self.proj['o'] = nn.Linear(dim, dim, bias=False)
        self.proj['ffn_up_gate'] = nn.Linear(dim, 2 * ffn_dim, bias=False)
        self.proj['ffn_down'] = nn.Linear(ffn_dim, dim, bias=False)

    def forward(self, x, turn, modulation):
        shift_a, scale_a, gate_a, shift_f, scale_f, gate_f = modulation
        y = self.norm1(x) * (1 + scale_a) + shift_a
        if self.fused:
            q, k, v = self.proj['qkv'](y).chunk(3, -1)
        else:
            q, k, v = self.proj['q'](y), self.proj['k'](y), self.proj['v'](y)
        x = x + self.proj['o'](attend(q, k, v, self.q_norm, self.k_norm, turn, self.heads)) * gate_a
        y = self.norm2(x) * (1 + scale_f) + shift_f
        hidden, gate = self.proj['ffn_up_gate'](y).chunk(2, -1)
        return x + self.proj['ffn_down'](situ(hidden, gate)) * gate_f


class MossImage(nn.Module):
    def __init__(self, dim, ffn_dim, heads, layers, text_dim, channels, fused, text_blocks=2):
        super().__init__()
        if dim % heads or (dim // heads) % 8:
            raise ValueError('A head must divide the width of the model, and eight its own')
        self.heads, self.channels = heads, channels
        self.video_embedder = nn.Linear(channels, dim)
        self.text_embedder = TextEmbedder(text_dim, dim, ffn_dim, heads, text_blocks)
        self.time_embedding = nn.Sequential(nn.Linear(TIME_DIM, dim), nn.SiLU(), nn.Linear(dim, dim))
        self.shared_block_modulation = nn.Linear(dim, 6 * dim)
        self.layers = nn.ModuleList([Block(dim, ffn_dim, heads, fused) for _ in range(layers)])
        self.final_norm_video = Norm(dim)
        self.final_linear_video = nn.Linear(dim, channels, bias=False)
        self.video_head_modulation = nn.Linear(dim, 2 * dim)
        # The positions of the last sizes asked: the two predictions of a step (the prompt, the
        # negative prompt) each have their own count of text tokens, the same at every step.
        self.turns = {}

    def turn(self, height, width, text_length, like):
        key = (height, width, text_length, like.device, like.dtype)
        found = self.turns.get(key)
        if found is None:
            if len(self.turns) >= 4:
                self.turns.pop(next(iter(self.turns)))
            head_dim = self.final_norm_video.weight.shape[0] // self.heads
            found = self.turns[key] = tuple(
                part.to(device=like.device, dtype=like.dtype)
                for part in rotations(height, width, text_length, head_dim)
            )
        return found

    def forward(self, latents, sigma, context, skip=()):
        """The velocity [1, channels, H, W] of `latents` at `sigma`, for a text [1, tokens, text_dim].
        `skip`: the blocks of the joint stream left out of this prediction."""
        if latents.ndim != 4 or latents.shape[0] != 1 or latents.shape[1] != self.channels:
            raise ValueError('Latents must be [1, channels, height, width]')
        if context.ndim != 3 or context.shape[0] != 1 or not context.shape[1]:
            raise ValueError('The text must be [1, tokens, width] with at least one token')
        height, width = latents.shape[2:]
        count = height * width
        # The precision the model works in is that of its small weights (the large ones may be INT8).
        dtype = self.final_norm_video.weight.dtype
        time = self.time_embedding(time_features(sigma, latents.device).to(dtype))
        modulation = self.shared_block_modulation(time).view(1, 6, 1, -1).unbind(1)
        head_shift, head_scale = self.video_head_modulation(time).view(1, 2, 1, -1).unbind(1)
        image = self.video_embedder(latents.flatten(2).transpose(1, 2).to(dtype).contiguous())
        turn = self.turn(height, width, context.shape[1], image)
        text = self.text_embedder(context.to(dtype), tuple(part[:, count:] for part in turn))
        x = torch.cat((image, text), 1)
        del image, text
        for index, layer in enumerate(self.layers):
            if index not in skip:
                x = layer(x, turn, modulation)
        x = self.final_norm_video(x[:, :count]) * (1 + head_scale) + head_shift
        return self.final_linear_video(x).transpose(1, 2).reshape(1, self.channels, height, width)


def _count(keys, pattern):
    found = {int(match.group(1)) for match in map(re.compile(pattern).match, keys) if match}
    if found != set(range(len(found))):
        raise ValueError('The blocks of the model are not numbered from 0 without a gap')
    return len(found)


def config(header):
    """What a file says of the model it holds: (the arguments of `MossImage`, the prefix of its keys).
    Read from the shapes of its header (runner.models.headers.header): nothing is loaded."""
    prefix = next((p for p in PREFIXES if p + 'shared_block_modulation.weight' in header), None)
    if prefix is None or prefix + 'layers.0.proj.ffn_up_gate.weight' not in header:
        raise ValueError('Ce fichier n’est pas un modèle MOSS Image.')

    def shape(key):
        if prefix + key not in header:
            raise ValueError('Modèle MOSS Image incomplet : ' + key + ' manque.')
        return list(header[prefix + key]['shape'])

    keys = [key[len(prefix) :] for key in header if key.startswith(prefix)]
    dim = shape('shared_block_modulation.weight')[1]
    ffn_dim = shape('layers.0.proj.ffn_down.weight')[1]
    channels, text_dim = shape('final_linear_video.weight')[0], shape('text_embedder.proj.weight')[1]
    if dim % HEAD or shape('shared_block_modulation.weight')[0] != 6 * dim:
        raise ValueError('Modèle MOSS Image de forme inattendue.')
    if shape('layers.0.proj.ffn_up_gate.weight') != [2 * ffn_dim, dim]:
        raise ValueError('Modèle MOSS Image de forme inattendue.')
    if shape('video_embedder.weight') != [dim, channels]:
        # An adapter of control (colour, depth) widens the entry of the model: not read here.
        raise ValueError('Ce modèle MOSS Image attend des cartes de contrôle, que Moodix ne lit pas.')
    return (
        dict(
            dim=dim,
            ffn_dim=ffn_dim,
            heads=dim // HEAD,
            layers=_count(keys, r'layers\.(\d+)\.norm1\.weight$'),
            text_dim=text_dim,
            channels=channels,
            fused='layers.0.proj.qkv.weight' in keys,
            text_blocks=_count(keys, r'text_embedder\.blocks\.(\d+)\.norm1\.weight$'),
        ),
        prefix,
    )


def names(model, header, prefix=''):
    """Where each weight of the model is in its file, for `load_streamed`: the name of the layer is
    the name of its key. A weight the file lacks is said by its name."""
    found = {}
    for name, _ in model.named_parameters():
        if prefix + name not in header:
            raise ValueError('Modèle MOSS Image incomplet : ' + name + ' manque.')
        found[name] = ('model', prefix + name, None)
    return found
