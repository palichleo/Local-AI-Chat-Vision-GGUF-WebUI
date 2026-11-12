"""Video sparse attention (VSA) over a packed sequence, for the models trained with it.

Attention is the one cost that grows with the square of a video's size. A model distilled
with VSA no longer needs all of it: the rows of the sequence are grouped in blocks of 64 and
each block of the video reads, row by row, only the blocks that matter to it.

The layout (`layout`):
- the rows that stay exact first — text, sound, images — cut in runs of 64 that never cross
  from one segment to the next;
- then each video, cut in cubes of 4 x 4 x 4 tokens. A cube at the far edge of the video
  holds fewer rows: it is padded with zeros, its live rows first.

The attention (`attend`):
- every row reads the exact rows, and the exact rows read everything;
- a cube of the video reads the share `keep` of the video's cubes whose mean key best
  matches its own mean query, and nothing of the others;
- the model's learned gate (`to_gate_compress`) adds a coarse answer: the attention between
  the means of all blocks, the same for the 64 rows of a block.

Method and layout are those of FastVideo's VSA-H3 (Apache-2.0,
fastvideo/attention/backends/video_sparse_attn_h3.py), written here from its description.
The attention itself is comfy-kitchen's `sol_attn_chunked` kernel (Apache-2.0). It takes the
fused q, k, v projection of the rows already laid out in blocks, CHUNK rows at a time, and
normalises, turns and quantizes them to 8 bits for the tensor cores as they come: the
queries, keys and values are never written out whole, nor read again to be laid out,
normalised, quantized or averaged.
"""

import functools
import math

BLOCK = 64
CUBE = (4, 4, 4)
# The kernel's width of a head.
WIDTH = 128
# Shorter sequences stay on full attention. Measured on an RTX 4070 Super for MiniMax-H3, a
# whole step, 10 % of the cubes kept: 13 358 rows (768 x 448, 5 s, the draft) 4.02 s instead
# of 4.29 dense, 19 796 (960 x 544) 6.1 to 6.7 s instead of 7.3, 38 222 (1344 x 768) 11.9 to
# 12.1 s instead of 19.1. Below the draft, not measured: comfy-kitchen's own threshold.
MIN_ROWS = 12288
# Rows of the fused projection per piece handed to the kernel (a multiple of 64): 168 MiB
# each for MiniMax-H3 (56 heads), however long the video.
CHUNK = 4096
# The values are quantized with the scale of the step before, this much wider (as the
# kernel's own measure of it): a value a little larger than the last step's still fits.
VALUE_MARGIN = 1.1


class Plan:
    """Where each row of a packed sequence goes among the padded blocks."""

    def __init__(self, slots, lengths, exact):
        self.slots = slots  # (rows,) int64: the padded slot of each row of the sequence
        self.lengths = lengths  # (blocks,) int32: live rows at the front of each block
        self.exact = exact  # leading blocks that hold the rows kept exact
        self.rows = int(slots.numel())
        self.blocks = int(lengths.numel())
        import torch

        live = torch.zeros(self.blocks * BLOCK, dtype=torch.bool, device=slots.device)
        live[slots] = True
        self.padding = (~live).nonzero().flatten()  # the padded slots, zero in every tile

    def to(self, device):
        return Plan(self.slots.to(device), self.lengths.to(device), self.exact)

    def tile(self, value):
        """(batch, rows, ...) -> (batch, blocks * 64, ...), zeros in the padding (only the padded
        slots are cleared: the rows fill the others)."""
        tiled = value.new_empty(value.shape[0], self.blocks * BLOCK, *value.shape[2:])
        tiled.index_fill_(1, self.padding, 0)
        return tiled.index_copy_(1, self.slots, value)

    def untile(self, value):
        return value.index_select(1, self.slots)


def layout(segments, cube=CUBE):
    """The plan of a packed sequence. `segments` lists it in order: an int is a run of rows kept
    exact, a (frames, height, width) triple a video's grid of tokens, frame-major."""
    import torch

    if math.prod(cube) != BLOCK:
        raise ValueError('A cube of the video must hold 64 tokens')
    exact, videos, cursor = [], [], 0
    for segment in segments:
        if isinstance(segment, int):
            if segment > 0:
                exact.append((cursor, segment))
            cursor += max(segment, 0)
        else:
            if min(segment) < 1:
                raise ValueError(f'Empty video grid {tuple(segment)}')
            videos.append((cursor, tuple(segment)))
            cursor += math.prod(segment)
    if not videos:
        raise ValueError('Sparse attention needs a video in the sequence')
    slots = torch.empty(cursor, dtype=torch.long)
    lengths = []

    def place(rows):
        slots[rows] = len(lengths) * BLOCK + torch.arange(rows.numel())
        lengths.append(rows.numel())

    for start, count in exact:
        for first in range(start, start + count, BLOCK):
            place(torch.arange(first, min(first + BLOCK, start + count)))
    leading = len(lengths)
    for start, (frames, height, width) in videos:
        rows = torch.arange(start, start + frames * height * width).reshape(frames, height, width)
        for t in range(0, frames, cube[0]):
            for h in range(0, height, cube[1]):
                for w in range(0, width, cube[2]):
                    place(rows[t : t + cube[0], h : h + cube[1], w : w + cube[2]].reshape(-1))
    return Plan(slots, torch.tensor(lengths, dtype=torch.int32), leading)


def ready():
    """Whether the kernel runs on this GPU (CUDA, compute capability 8.0 or more)."""
    try:
        import torch
        import comfy_kitchen

        return bool(comfy_kitchen.sol_attn_is_available(torch.device('cuda')))
    except Exception:
        return False


def release():
    """Let go of what the kernel keeps between calls: the last rotation table it derived (a
    dozen MiB at 768 x 448), held by comfy-kitchen after the generation is over, where the
    engine wants the card empty. Not public in comfy-kitchen, so looked for, not assumed."""
    import sys

    for name in ('comfy_kitchen.backends.cuda', 'comfy_kitchen.backends.hip'):
        cache = getattr(sys.modules.get(name), '_ROPE_FAB_CACHE', None)
        if cache is not None:
            cache.clear()


def pieces(project, rows, chunk):
    """The fused q, k, v projection of tiled rows (1, blocks * 64, width), `chunk` rows at a
    time: (chunk, 3 * heads * 128) each. Once the last piece is out, the generator lets go of
    `rows`."""
    for first in range(0, rows.shape[1], chunk):
        yield project(rows[0, first : first + chunk])


def statistics(key, value):
    """What the kernel takes from the step before, measured on a dense step: the mean of the
    keys (normalised and turned) and the scale that quantizes the values, from (1, rows,
    heads, 128) tensors. (heads, 128) float32 each, as `attend` returns them."""
    import torch

    # As (rows, heads * 128) views, the extremes of the values in one pass: 2.7 ms a layer at
    # 1344 x 768 (4.1 ms over the four dimensions, with a pass for each).
    shape, rows = key.shape[-2:], key.shape[0] * key.shape[1]
    mean = key.reshape(rows, -1).sum(0, dtype=torch.float32) / rows
    low, high = torch.aminmax(value.reshape(rows, -1), dim=0)
    peak = torch.maximum(high, low.neg()).float()
    return mean.view(shape), (peak / 127 * VALUE_MARGIN).clamp_min(1e-8).view(shape)


def attend(rows, project, gate, plan, keep, heads, rope, known=None):
    """Sparse attention of one layer over its input laid out in blocks, `rows` (1, blocks * 64,
    width), zeros in the padding (Plan.tile).

    `project` is the fused q, k, v projection, `gate` the coarse branch's (to_gate_compress)
    or None, for `heads` heads of 128. `rope` is (rotation table laid out in blocks, query
    norm weight, key norm weight, norm epsilon), `known` the statistics of the step before
    (from here or `statistics`): without them the kernel reads the projection twice, to
    measure them first.

    Returns the rows of the sequence in its own order (1, rows, heads, 128), and the
    statistics for the next step."""
    import comfy_kitchen

    rotation, query_norm, key_norm, eps = rope
    coarse = None if gate is None else gate(rows).unflatten(-1, (heads, WIDTH))
    # Once the statistics are known, one reading: the rows go as soon as the last piece is
    # projected, before the kernel's output is allocated.
    chunks = pieces(project, rows, CHUNK) if known else functools.partial(pieces, project, rows, CHUNK)
    del rows
    found, mean, scale = comfy_kitchen.sol_attn_chunked(
        chunks,
        plan.blocks * BLOCK,
        heads,
        rotation,
        (query_norm, key_norm),
        kmean=known[0] if known else None,
        vscale=known[1] if known else None,
        topk_ratio=float(keep),
        sink_blocks=[0, plan.exact],
        sink_q=[0, plan.exact],
        rope_eps=eps,
        tail=False,
        block_len=plan.lengths,
        coarse_gate=coarse,
    )
    del chunks, coarse
    return plan.untile(found), (mean, scale)


def reference(query, key, value, gate, plan, keep):
    """What `attend` computes, in plain full-precision PyTorch, on the rows of the sequence
    themselves (batch, rows, heads, width). Quadratic in memory: for tests and small checks."""
    import torch

    batch, rows, heads, width = query.shape
    scale = width**-0.5
    block = (plan.slots // BLOCK).to(query.device)
    blocks, exact = plan.blocks, plan.exact
    lengths = plan.lengths.to(query.device).float()

    def means(x):
        total = torch.zeros(batch, blocks, heads, width, device=x.device, dtype=torch.float32)
        total.index_add_(1, block, x.float())
        return (total / lengths.view(1, -1, 1, 1)).permute(0, 2, 1, 3)  # (batch, heads, blocks, width)

    q_mean, k_mean, v_mean = means(query), means(key), means(value)
    coarse = (q_mean @ k_mean.transpose(-1, -2)) * scale  # (batch, heads, blocks, blocks)
    # Which blocks each block reads: the exact ones, its neighbours, and its best cubes.
    count = max(1, min(blocks - 1, round(keep * (blocks - exact)))) if blocks > 1 else 0
    ranked = coarse.clone()
    ranked[..., :exact] = float('-inf')
    kept = torch.zeros_like(coarse, dtype=torch.bool)
    if count:
        kept = ranked >= ranked.topk(count, dim=-1).values[..., -1:]
    index = torch.arange(blocks, device=query.device)
    kept |= (index.view(1, -1) - index.view(-1, 1)).abs() <= 1
    kept[..., :exact] = True
    kept[..., :exact, :] = True
    mask = kept[:, :, block][:, :, :, block]  # (batch, heads, rows, rows)
    scores = (query.float().transpose(1, 2) @ key.float().transpose(1, 2).transpose(-1, -2)) * scale
    scores = scores.masked_fill(~mask, float('-inf'))
    fine = torch.softmax(scores, dim=-1) @ value.float().transpose(1, 2)  # (batch, heads, rows, width)
    answer = torch.softmax(coarse, dim=-1) @ v_mean  # (batch, heads, blocks, width)
    result = fine.transpose(1, 2)
    if gate is not None:
        result = result + gate.float() * answer[:, :, block].transpose(1, 2)
    return result.to(value.dtype)
