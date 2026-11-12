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
The attention itself is comfy-kitchen's `sol_attn` kernel (Apache-2.0), which quantizes
queries, keys and values to 8 bits for the tensor cores.
"""

import math

BLOCK = 64
CUBE = (4, 4, 4)
# Shorter sequences stay on full attention. Measured on an RTX 4070 Super for MiniMax-H3, one
# layer, the gate's projection and copy included: 13 358 rows (768 x 448, 5 s) lose 0.07 s a
# step, 19 796 (960 x 544) gain 0.36 s, 27 566 (1152 x 640) 2.3 s, 38 222 (1344 x 768) 5.5 s.
# (comfy-kitchen's note and ComfyUI's node say 12 288: too low here.)
MIN_ROWS = 20000


class Plan:
    """Where each row of a packed sequence goes among the padded blocks."""

    def __init__(self, slots, lengths, exact):
        self.slots = slots  # (rows,) int64: the padded slot of each row of the sequence
        self.lengths = lengths  # (blocks,) int32: live rows at the front of each block
        self.exact = exact  # leading blocks that hold the rows kept exact
        self.rows = int(slots.numel())
        self.blocks = int(lengths.numel())

    def to(self, device):
        return Plan(self.slots.to(device), self.lengths.to(device), self.exact)

    def tile(self, value):
        """(batch, rows, heads, width) -> (batch, blocks * 64, heads, width), zeros in the padding."""
        tiled = value.new_zeros(value.shape[0], self.blocks * BLOCK, *value.shape[2:])
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


def attend(query, key, value, gate, plan, keep):
    """Sparse attention over tiled (batch, blocks * 64, heads, 128) half-precision tensors.

    Returns the tiled result; the padded rows of it mean nothing (see Plan.untile).
    """
    import comfy_kitchen

    return comfy_kitchen.sol_attn(
        query,
        key,
        value,
        sink_blocks=[0, plan.exact],
        sink_q=[0, plan.exact],
        topk_ratio=float(keep),
        tail=False,
        block_len=plan.lengths,
        coarse_gate=gate,
    )


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
