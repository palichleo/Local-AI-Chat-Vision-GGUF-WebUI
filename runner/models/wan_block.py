"""Wan 2.1's transformer block computed with comfy-kitchen's fused kernels.

diffusers' WanTransformerBlock is the reference: the same products in the same order. It writes
every intermediate out, most of them in float32: with the reference, the video and the pose of
SCAIL-2 in one sequence (49 000 tokens of 5 120 values for 81 frames at 512 x 896), each of
those is a gigabyte, and a 12 GiB card ran out of memory with the model's LoRAs beside them.
Here, in the precision of the tokens:

- a norm and its modulation, layer_norm(x) * (1 + scale) + shift, are one kernel (adaln);
- the queries and the keys are turned in place by one kernel, from rotation matrices built once
  per forward (the pose's are averages of rotations, shorter than one: a matrix all the same);
- the attention of the sequence over itself goes through the INT8 kernel where the GPU has it,
  else through cuDNN's (see runner.models.ltx25_block._attention);
- a branch's last product adds itself to the stream, residual + gate * linear(x), and the
  feed-forward's GELU is applied inside it, a few thousand rows at a time: its intermediate,
  2.7 times as wide as the tokens, is never written out whole.

Rounding once where the separate steps rounded each time, a block's result differs from
diffusers' by what bfloat16 itself cannot hold.
"""

import types

import torch
import torch.nn.functional as F

from runner.models import attention8
from runner.models.ltx25_block import _attention, _joined

# A feed-forward runs this many tokens at a time (see the module's note).
ROWS = 8192
KERNELS = ('adaln', 'apply_rope_')
TEXT_TOKENS = 512


def rotation_table(cos, sin):
    """diffusers' rotary (cos, sin), [1, tokens, 1, head size] each with every value twice, as
    the matrices the kernel reads: [1, tokens, 1, head size / 2, 2, 2] in float32, [[cos, -sin],
    [sin, cos]] for each pair of channels. Built once: kept on `cos`, which the blocks share."""
    found = getattr(cos, '_table', None)
    if found is None:
        c, s = cos[..., 0::2].float(), sin[..., 1::2].float()
        found = torch.stack((c, -s, s, c), dim=-1).unflatten(-1, (2, 2)).contiguous()
        cos._table = found
    return found


def _heads(attn, value):
    return value.unflatten(2, (attn.heads, -1))


def _block_forward(self, hidden_states, encoder_hidden_states, temb, rotary_emb):
    """diffusers' WanTransformerBlock.forward, same arguments and result."""
    import comfy_kitchen

    if temb.ndim != 3:
        # One timestep a token (Wan 2.2's small model): diffusers' own computation.
        return self._reference_forward(hidden_states, encoder_hidden_states, temb, rotary_emb)
    stream = hidden_states
    table = self.scale_shift_table.to(device=temb.device, dtype=stream.dtype) + temb.to(stream.dtype)
    shift, scale, gate, cross_shift, cross_scale, cross_gate = table.chunk(6, dim=1)

    # 1. The sequence over itself.
    attn = self.attn1
    normed = comfy_kitchen.adaln(stream, scale, shift, self.norm1.eps)
    query = _heads(attn, attn.norm_q(attn.to_q(normed)))
    key = _heads(attn, attn.norm_k(attn.to_k(normed)))
    held = _heads(attn, attn.to_v(normed))
    del normed
    if rotary_emb is not None:
        comfy_kitchen.apply_rope_(query, key, rotation_table(*rotary_emb))
    if self._int8_attention:
        # The kernel reads [batch, heads, tokens, head size]; the model keeps the heads third.
        # (Through runner.models.attention8: a row the kernel fails on is computed again.)
        seen = attention8.attend(query.transpose(1, 2), key.transpose(1, 2), held.transpose(1, 2))
        seen = seen.transpose(1, 2)
    else:
        seen = _attention(query, key, held)
    del query, key, held
    # The stream handed in is the caller's: the first sum writes a new one, the next ones this one.
    stream = _joined(attn.to_out[0], seen.flatten(2, 3).type_as(stream), stream, gate, own=False)
    del seen

    # 2. The sequence over the reference image, then over the text.
    attn = self.attn2
    normed = self.norm2(stream) if isinstance(self.norm2, torch.nn.Identity) else F.layer_norm(
        stream, stream.shape[-1:], self.norm2.weight.to(stream.dtype), self.norm2.bias.to(stream.dtype), self.norm2.eps
    )
    query = _heads(attn, attn.norm_q(attn.to_q(normed)))
    del normed
    context = encoder_hidden_states
    image = None
    if attn.add_k_proj is not None:
        image, context = context[:, : context.shape[1] - TEXT_TOKENS], context[:, -TEXT_TOKENS:]
    seen = _attention(query, _heads(attn, attn.norm_k(attn.to_k(context))), _heads(attn, attn.to_v(context)))
    if image is not None and image.shape[1]:
        key = _heads(attn, attn.norm_added_k(attn.add_k_proj(image)))
        seen = seen + _attention(query, key, _heads(attn, attn.add_v_proj(image)))
    del query
    ones = torch.ones(1, 1, stream.shape[-1], device=stream.device, dtype=stream.dtype)
    stream = _joined(attn.to_out[0], seen.flatten(2, 3).type_as(stream), stream, ones)
    del seen

    # 3. The feed-forward, a few thousand rows at a time.
    normed = comfy_kitchen.adaln(stream, cross_scale, cross_shift, self.norm3.eps)
    project, out = self.ffn.net[0].proj, self.ffn.net[2]
    for start in range(0, normed.shape[1], ROWS):
        rows = slice(start, start + ROWS)
        wide = project(normed[:, rows])
        stream[:, rows] = _joined(out, wide, stream[:, rows], cross_gate, act='gelu_tanh', own=False)
    return stream


def fusable(model):
    """Whether this model's blocks can be computed here: the kernels are there, and the blocks
    are the ones this was written for (queries and keys normalised across the heads)."""
    import comfy_kitchen

    if not all(hasattr(comfy_kitchen, name) for name in KERNELS):
        return False
    return all(isinstance(block.attn1.norm_q, torch.nn.RMSNorm) for block in model.blocks)


def fuse(model, int8_attention=True):
    """The blocks of a Wan transformer take this forward. Returns (fused, int8 attention used)."""
    if not fusable(model):
        return False, False
    fast = False
    if int8_attention:
        try:
            import comfy_kitchen

            fast = bool(comfy_kitchen.int8_attention_is_available(torch.device('cuda')))
        except Exception:
            fast = False
    for block in model.blocks:
        if not hasattr(block, '_reference_forward'):
            block._reference_forward = block.forward
        block._int8_attention = fast
        block.forward = types.MethodType(_block_forward, block)
    return True, fast
