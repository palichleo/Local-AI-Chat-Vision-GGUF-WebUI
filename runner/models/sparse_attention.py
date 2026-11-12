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
# For each head and each padded row, the kernel holds about 700 bytes: its output, and its
# workspace (8-bit copies of the queries, keys and values, 442 bytes). All 56 heads of a
# 1344 x 768 video at once: 1.6 GiB, one GiB of it in a single allocation, which a 12 GiB
# card short of memory refused. The heads go by packs of HEAD_BYTES.
BYTES_PER_HEAD_ROW = 700
HEAD_BYTES = 256 * 1024**2


class Plan:
    """Where each row of a packed sequence goes among the padded blocks."""

    def __init__(self, slots, lengths, exact):
        self.slots = slots  # (rows,) int64: the padded slot of each row of the sequence
        self.lengths = lengths  # (blocks,) int32: live rows at the front of each block
        self.exact = exact  # leading blocks that hold the rows kept exact
        self.rows = int(slots.numel())
        self.blocks = int(lengths.numel())
        self.block = slots // BLOCK  # (rows,) the block of each row
        import torch

        live = torch.zeros(self.blocks * BLOCK, dtype=torch.bool, device=slots.device)
        live[slots] = True
        self.padding = (~live).nonzero().flatten()  # the padded slots, zero in every tile

    def to(self, device):
        return Plan(self.slots.to(device), self.lengths.to(device), self.exact)

    def tile(self, value):
        """(batch, rows, heads, width) -> (batch, blocks * 64, heads, width), zeros in the padding
        (only the padded slots are cleared: the rows fill the others)."""
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


def packs(heads, length, batch=1):
    """The heads by packs whose kernel memory stays near HEAD_BYTES: each head is computed on
    its own, so the result is the same as all at once."""
    step = max(1, HEAD_BYTES // (batch * length * BYTES_PER_HEAD_ROW))
    return [slice(first, min(first + step, heads)) for first in range(0, heads, step)]


def attend(query, key, value, plan, keep):
    """The fine stage of sparse attention over tiled (batch, blocks * 64, heads, 128)
    half-precision tensors. Returns the rows of the sequence, in its own order:
    (batch, rows, heads, 128). The coarse branch is apart (see coarse, add_coarse), so that
    the gate is computed once the queries, keys and values are gone."""
    import comfy_kitchen

    batch, length, heads, width = query.shape
    result = query.new_empty(batch, plan.rows, heads, width)
    for part in packs(heads, length, batch):
        found = comfy_kitchen.sol_attn(
            query[:, :, part],
            key[:, :, part],
            value[:, :, part],
            sink_blocks=[0, plan.exact],
            sink_q=[0, plan.exact],
            topk_ratio=float(keep),
            tail=False,
            block_len=plan.lengths,
        )
        result[:, :, part] = plan.untile(found)
        del found
    return result


def coarse(query, key, value, plan):
    """VSA's coarse branch: attention between the means of the blocks, from tiled tensors
    (their padding is zero). Returns (batch, heads, blocks, width) in float32, a few MiB."""
    import torch

    batch, length, heads, width = query.shape
    lengths = plan.lengths.to(torch.float32).view(1, -1, 1, 1)

    def means(x):
        total = x.view(batch, plan.blocks, BLOCK, heads, width).sum(2, dtype=torch.float32)
        return (total / lengths).permute(0, 2, 1, 3)

    scores = means(query) @ means(key).transpose(-1, -2) * width**-0.5
    return torch.softmax(scores, dim=-1) @ means(value)


def add_coarse(result, gate, answer, plan):
    """result += gate * the coarse answer of each row's block, in place, a pack of heads at a
    time, in one fused product and sum per pack. result and gate are (batch, rows, heads,
    width), answer comes from coarse."""
    answer = answer.to(result.dtype)
    for part in packs(result.shape[2], plan.rows, result.shape[0]):
        rows = answer[:, part].index_select(2, plan.block).permute(0, 2, 1, 3)
        result[:, :, part].addcmul_(gate[:, :, part], rows)
    return result


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
