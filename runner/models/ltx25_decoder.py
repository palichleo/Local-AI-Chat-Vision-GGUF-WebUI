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

`decode_groups` is the tiled decode itself, a group of frames at a time: diffusers' keeps every
decoded tile on the GPU and joins them there at the end, two and a half times the pixels of
the whole video. A video of 10 s at 1088 x 1920 or 1536 x 1536 was sampled to its end and
lost there, after five to seven minutes (17/11).
"""

import math

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


class Features:
    """What the tiles of the decode are cut from (the output of the decoder's stages 1 to 3), a
    stretch of frames at a time.

    diffusers computes it for the whole video at once. Its last operation, an upsample (a linear
    layer that widens each token eight times, then a shuffle of that into two frames of twice
    the size), holds nine gigabytes for 241 frames of 1536 x 1536, and its result 4.6: that video
    was sampled to its end and lost there (17/11). The upsample reads each token alone: applied
    to the frames a stretch needs, it gives the very values of the whole. What comes before it
    (the attentions, which do read their neighbours in time) is computed once for the video, on a
    grid an eighth as large."""

    def __init__(self, decoder, latents):
        hidden = latents
        pad = decoder.trailing_pad_latent_frames
        if pad > 0:
            hidden = torch.cat([hidden, hidden[:, :, -1:].expand(-1, -1, pad, -1, -1)], dim=2)
        hidden = decoder.conv_in(hidden.permute(0, 2, 3, 4, 1))
        stages, upsamples = decoder.det_stages[:-1], decoder.upsamples[:-1]
        for place, (blocks, upsample) in enumerate(zip(stages, upsamples)):
            mask = blocks[0].attn.build_block_mask(hidden)
            for block in blocks:
                hidden = block(hidden, mask)
            if place < len(stages) - 1:
                hidden = upsample(hidden)
        self.inner, self.upsample = hidden, upsamples[-1]
        self.doubles = self.upsample.stride[0] == 2
        # The frames of the whole: the first of a doubled video comes once (the causal mapping).
        self.frames = hidden.shape[1] * 2 - 1 if self.doubles else hidden.shape[1] * self.upsample.stride[0]
        self.height = hidden.shape[2] * self.upsample.stride[1]
        self.width = hidden.shape[3] * self.upsample.stride[2]

    def stretch(self, start, stop):
        """Frames [start, stop) of the features, [B, frames, H, W, C]."""
        if not self.doubles:
            step = self.upsample.stride[0]
            first, last = start // step, -(-stop // step)
            made = self.upsample(self.inner[:, first:last], drop_leading_frame=False)
            return made[:, start - first * step : stop - first * step]
        # Frame f of the whole is the frame f + 1 of the doubled inner frames: the first is dropped.
        first, last = (start + 1) // 2, -(-(stop + 1) // 2)
        made = self.upsample(self.inner[:, first:last], drop_leading_frame=False)
        return made[:, start + 1 - 2 * first : stop + 1 - 2 * first]


def decode_groups(vae, latents, generator):
    """The frames of the video, [B, C, frames, H, W] on the GPU, one group of frames after the
    other: what diffusers' `tiled_decode` returns in one piece, to the bit (the same tiles in the
    same order, each drawing its noise from `generator`, joined by the model's own blends).

    A group is the tiles of one stretch of frames, joined; what the next group blends with is
    its last frames only. The caller takes each group off the GPU before the next is computed:
    the decode then holds the features of the video and one group, whatever its length.
    Derived from diffusers' LTX2VideoDiffusionDecoderModel.tiled_decode (Apache-2.0). A video
    that is one tile, or a decoder of several steps (its tiles then share one canvas of noise
    as large as the video), is left to the library."""
    from diffusers.models.autoencoders import ltx2_diffusion_decoder as library
    from diffusers.utils.torch_utils import randn_tensor

    decoder = vae.decoder
    tiled = vae.use_tiling and (
        latents.shape[2] > vae.tile_sample_min_num_frames // vae.temporal_compression_ratio
        or latents.shape[3] > vae.tile_sample_min_height // vae.spatial_compression_ratio
        or latents.shape[4] > vae.tile_sample_min_width // vae.spatial_compression_ratio
    )
    if not tiled or decoder.default_num_inference_steps != 1 or decoder.model_output_type != 'x0':
        yield vae.decode(latents, generator=generator).sample
        return
    batch, patch, last = latents.shape[0], decoder.patch_size, decoder.upsamples[-1].stride
    # Pixels per cell of the grid the tiles are cut on.
    scale_t, scale_h, scale_w = last[0], last[1] * patch, last[2] * patch
    tile_t, stride_t = vae.tile_sample_min_num_frames // scale_t, vae.tile_sample_stride_num_frames // scale_t
    tile_h, stride_h = vae.tile_sample_min_height // scale_h, vae.tile_sample_stride_height // scale_h
    tile_w, stride_w = vae.tile_sample_min_width // scale_w, vae.tile_sample_stride_width // scale_w
    smallest = [
        max(before, -(-after // step))
        for before, after, step in zip(vae.config.decoder_stage_kernels[-1], vae.config.decoder_stage5_kernel, last)
    ]
    features = Features(decoder, latents)
    ghost = decoder.trailing_pad_latent_frames * math.prod(up.stride[0] for up in decoder.upsamples[:-1])
    frames, height, width = features.frames - ghost, features.height, features.width
    stretches = library._tile_intervals(frames, tile_t, stride_t, smallest[0])
    rows_of = library._tile_intervals(height, tile_h, stride_h, smallest[1])
    columns_of = library._tile_intervals(width, tile_w, stride_w, smallest[2])
    blend_t, blend_h = (tile_t - stride_t) * scale_t, (tile_h - stride_h) * scale_h
    blend_w = (tile_w - stride_w) * scale_w
    tail = None
    for place, (t0, t1) in enumerate(stretches):
        origin, trailing = t0 == 0, t1 == frames
        # The features of this stretch of frames only, for the time of its tiles.
        stretch = features.stretch(t0, features.frames if trailing else t1)
        rows = []
        for h0, h1 in rows_of:
            row = []
            for w0, w1 in columns_of:
                context = decoder.forward_stage_4(
                    stretch[:, :, h0:h1, w0:w1],
                    drop_leading_frame=origin,
                    crop_trailing_ghost=trailing,
                )
                sides = context.shape[2] * patch, context.shape[3] * patch
                shape = (batch, decoder.out_channels, context.shape[1], *sides)
                noise = randn_tensor(shape, generator=generator, device=latents.device, dtype=latents.dtype)
                row.append(decoder.denoise(context, noise, 1))
                del context, noise
            rows.append(row)
        joined = []
        for i, row in enumerate(rows):
            line = []
            for j, tile in enumerate(row):
                if i > 0:
                    tile = vae.blend_v(rows[i - 1][j], tile, blend_h)
                if j > 0:
                    tile = vae.blend_h(row[j - 1], tile, blend_w)
                # The last tile of an axis keeps its whole extent (a short remnant is merged into it).
                keep_h = stride_h * scale_h if i < len(rows) - 1 else tile.shape[3]
                keep_w = stride_w * scale_w if j < len(row) - 1 else tile.shape[4]
                line.append(tile[:, :, :, :keep_h, :keep_w])
            joined.append(torch.cat(line, dim=4))
        group = torch.cat(joined, dim=3)
        del rows, joined, line, row, tile, stretch
        if tail is not None:
            group = vae.blend_t(tail, group, blend_t)
        final = place == len(stretches) - 1
        # The first group is one frame short: its first cell decodes to a single frame.
        keep = group.shape[2] if final else stride_t * scale_t - (1 if place == 0 and scale_t == 2 else 0)
        # What the next group blends with: the last frames of this one, as blended here.
        tail = None if final else group[:, :, group.shape[2] - min(group.shape[2], max(blend_t, 0)) :].clone()
        yield group[:, :, :keep]
        del group


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
