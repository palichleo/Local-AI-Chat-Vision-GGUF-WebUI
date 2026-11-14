"""LTX 2.5's video decoder with its neighborhood attention computed by comfy-kitchen's kernels.

The decoder is a small transformer whose every token looks at its neighbors only (up to
11 x 11 x 11 of them), over as many tokens as a sixteenth of the pixels: 10.8 million for
121 frames of 896 x 1600. diffusers computes that attention through PyTorch's FlexAttention,
compiled for each tile shape it meets (14 s the first time, in every new process), and the
norm and the rotary embedding of its queries and keys in a dozen float32 passes written in
Python. Here, with the same weights and the same result:

- `rms_rope_` norms and rotates the queries and the keys in place, in one kernel;
- `na3d` is the neighborhood attention itself (NATTEN's, which the reference decoder calls).

Measured on an RTX 4070 Super, 121 frames, in the same tiles: 896 x 1600 decoded in 31.5 s
instead of 61, 288 x 512 in 3.9 s instead of 5.9 (and 19.6 the first time); the same frames to
0.1 of 255 on average (PSNR 57 to 59 dB). With nothing to compile, the tiles are then as large
as memory allows (ltx25.plan_tiles).
"""

import comfy_kitchen
import torch

# The kernels a fused attention needs of comfy-kitchen.
KERNELS = ('na3d', 'rms_rope_')
# Tokens whose rotation matrices exist at once: float32, 2 x 2 for each pair of a head (512 bytes
# a token for heads of 64).
ROPE_TOKENS = 2**17


def _tables(rope, grid, device):
    """(cos, sin) of each axis of the grid, [length, pairs] in float32: the angles of diffusers'
    LTX2VideoVaeRotaryPosEmbed3D, positions counted from zero on every axis."""
    tables = []
    for length, dim in zip(grid, rope.rope_dim_split):
        positions = torch.arange(length, dtype=torch.float32, device=device)
        angles = positions[:, None] * rope._inv_freqs(dim, device)[None, :]
        tables.append((angles.cos(), angles.sin()))
    return tables


def _rotations(tables, start, stop, height, width):
    """The rotation matrices of the tokens of frames start..stop, [1, tokens, 1, pairs, 2, 2]:
    the pairs of the time axis first, then the height's, then the width's, as the head is split."""
    grid = (stop - start, height, width)
    parts = []
    for axis, (cos, sin) in enumerate(tables):
        if axis == 0:
            cos, sin = cos[start:stop], sin[start:stop]
        matrix = torch.stack((cos, -sin, sin, cos), dim=-1)
        shape = [1, 1, 1, matrix.shape[1], 4]
        shape[axis] = matrix.shape[0]
        parts.append(matrix.reshape(shape).expand(*grid, -1, -1))
    rotations = torch.cat(parts, dim=3)
    return rotations.reshape(1, -1, 1, rotations.shape[3], 2, 2)


class NeighborhoodKernels:
    """The processor of an LTX2VideoVaeNeighborhoodAttention: what `project_qkv` and NATTEN's
    `na3d` compute, a few frames of rotations at a time."""

    def __call__(self, attn, hidden_states, block_mask=None):
        batch, frames, height, width, channels = hidden_states.shape
        shape = (batch, frames, height, width, attn.heads, attn.head_dim)
        query = attn.to_q(hidden_states).view(shape)
        key = attn.to_k(hidden_states).view(shape)
        value = attn.to_v(hidden_states).view(shape)
        # The query's 1 / sqrt(head_dim) goes with its norm weight: a scale commutes with a rotation.
        query_scale = (attn.norm_q.weight.detach() * attn.scale).to(query.dtype)
        key_scale = attn.norm_k.weight.detach().to(key.dtype)
        tables = _tables(attn.rope, (frames, height, width), hidden_states.device)
        step = max(1, ROPE_TOKENS // (height * width))
        for start in range(0, frames, step):
            stop = min(frames, start + step)
            rotations = _rotations(tables, start, stop, height, width)
            for index in range(batch):
                comfy_kitchen.rms_rope_(
                    query[index, start:stop].reshape(1, -1, attn.heads, attn.head_dim),
                    key[index, start:stop].reshape(1, -1, attn.heads, attn.head_dim),
                    rotations,
                    query_scale,
                    key_scale,
                    attn.norm_q.eps,
                )
        out = comfy_kitchen.na3d(query, key, value, list(attn.kernel_size), None, 1.0)
        del query, key, value
        return attn.to_out[0](out.reshape(batch, frames, height, width, channels))


def fuse(vae):
    """Give the decoder's attentions the processor above. False, and nothing is changed, when
    comfy-kitchen lacks its kernels: diffusers' FlexAttention then computes them."""
    from diffusers.models.autoencoders.ltx2_diffusion_decoder import LTX2VideoVaeNeighborhoodAttention

    if not all(hasattr(comfy_kitchen, name) for name in KERNELS):
        return False
    found = False
    for module in vae.modules():
        if isinstance(module, LTX2VideoVaeNeighborhoodAttention):
            module.set_processor(NeighborhoodKernels())
            found = True
    return found
