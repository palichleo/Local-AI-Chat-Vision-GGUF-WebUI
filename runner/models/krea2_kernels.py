"""Inference-only fused elementwise kernels and cuDNN GQA for the installed Krea2 layers."""

from types import MethodType

import torch
import torch.nn.functional as F
import triton
import triton.language as tl
from torch.nn.attention import sdpa_kernel, SDPBackend


@triton.jit
def _norm(
    X,
    G,
    S,
    T,
    Y,
    D: tl.constexpr,
    N: tl.constexpr,
    PER_BATCH: tl.constexpr,
    EPS: tl.constexpr,
    MODULATE: tl.constexpr,
    BLOCK: tl.constexpr,
    ROWS: tl.constexpr,
):
    row = tl.program_id(0) * ROWS + tl.arange(0, ROWS)
    col = tl.arange(0, BLOCK)
    x = tl.load(X + row[:, None] * D + col[None, :], (row[:, None] < N) & (col[None, :] < D), 0).to(tl.float32)
    gamma = tl.load(G + col, col < D, 0)
    inv = tl.rsqrt(tl.sum(x * x, 1) / D + EPS)
    out = (x * inv[:, None] * gamma[None, :]).to(Y.dtype.element_ty)
    if MODULATE:
        index = (row // PER_BATCH)[:, None] * D + col[None, :]
        scale = tl.load(S + index, (row[:, None] < N) & (col[None, :] < D), 0).to(tl.float32)
        shift = tl.load(T + index, (row[:, None] < N) & (col[None, :] < D), 0).to(tl.float32)
        multiplier = (scale + 1).to(Y.dtype.element_ty).to(tl.float32)
        out = (out.to(tl.float32) * multiplier).to(Y.dtype.element_ty)
        out = out.to(tl.float32) + shift
    tl.store(Y + row[:, None] * D + col[None, :], out, (row[:, None] < N) & (col[None, :] < D))


@triton.jit
def _residual(X, A, G, Y, N: tl.constexpr, D: tl.constexpr, PER_BATCH: tl.constexpr, BLOCK: tl.constexpr):
    index = tl.program_id(0) * BLOCK + tl.arange(0, BLOCK)
    x = tl.load(X + index, index < N, 0).to(tl.float32)
    a = tl.load(A + index, index < N, 0).to(tl.float32)
    gate = tl.load(G + (index // PER_BATCH) * D + index % D, index < N, 0).to(tl.float32)
    product = (a * gate).to(Y.dtype.element_ty).to(tl.float32)
    tl.store(Y + index, x + product, index < N)


@torch.library.custom_op('prototype_runner::norm', mutates_args=())
def norm(
    x: torch.Tensor,
    gamma: torch.Tensor,
    eps: float,
    scale: torch.Tensor | None = None,
    shift: torch.Tensor | None = None,
) -> torch.Tensor:
    x = x.contiguous()
    out = torch.empty_like(x)
    width = x.shape[-1]
    rows = x.numel() // width
    chunk = 4 if width <= 256 else 1
    per_batch = rows if scale is None else rows // scale.shape[0]
    if scale is not None:
        scale = scale.contiguous()
        shift = shift.contiguous()
    _norm[(triton.cdiv(rows, chunk),)](
        x,
        gamma,
        scale,
        shift,
        out,
        width,
        rows,
        per_batch,
        eps,
        scale is not None,
        triton.next_power_of_2(width),
        chunk,
        num_warps=4 if width < 8192 else 8,
        enable_fp_fusion=False,
    )
    return out


@norm.register_fake
def _fake_norm(x, gamma, eps, scale=None, shift=None):
    return torch.empty_like(x)


@torch.library.custom_op('prototype_runner::residual', mutates_args=())
def residual(x: torch.Tensor, activation: torch.Tensor, gate: torch.Tensor) -> torch.Tensor:
    x = x.contiguous()
    activation = activation.contiguous()
    out = torch.empty_like(x)
    gate = gate.contiguous()
    _residual[(triton.cdiv(x.numel(), 1024),)](
        x, activation, gate, out, x.numel(), x.shape[-1], x.numel() // gate.shape[0], 1024, enable_fp_fusion=False
    )
    return out


@residual.register_fake
def _fake_residual(x, activation, gate):
    return torch.empty_like(x)


class Attention:
    def __call__(self, attn, hidden_states, attention_mask=None, image_rotary_emb=None):
        from diffusers.models.embeddings import apply_rotary_emb

        q, k, v, g = [layer(hidden_states) for layer in (attn.to_q, attn.to_k, attn.to_v, attn.to_gate)]
        q = attn.norm_q(q.unflatten(-1, (attn.num_heads, attn.head_dim)))
        k = attn.norm_k(k.unflatten(-1, (attn.num_kv_heads, attn.head_dim)))
        v = v.unflatten(-1, (attn.num_kv_heads, attn.head_dim))
        if image_rotary_emb is not None:
            q = apply_rotary_emb(q, image_rotary_emb, sequence_dim=1)
            k = apply_rotary_emb(k, image_rotary_emb, sequence_dim=1)
        q, k, v = (item.transpose(1, 2) for item in (q, k, v))
        if q.shape[-2] >= 1024 and attention_mask is None:
            with sdpa_kernel(SDPBackend.CUDNN_ATTENTION):
                result = F.scaled_dot_product_attention(q, k, v, enable_gqa=attn.num_heads != attn.num_kv_heads)
        else:
            result = F.scaled_dot_product_attention(
                q, k, v, attn_mask=attention_mask, enable_gqa=attn.num_heads != attn.num_kv_heads
            )
        result = result.transpose(1, 2).flatten(2)
        return attn.to_out[0](result * torch.sigmoid(g))


def _block(self, hidden_states, temb, image_rotary_emb, attention_mask=None):
    values = temb.unflatten(-1, (6, -1)) + self.scale_shift_table
    a, b, c, d, e, f = values.unbind(-2)
    normalized = norm(hidden_states, self.norm1.runner_gamma, self.norm1.eps, a, b)
    attention = self.attn(normalized, attention_mask=attention_mask, image_rotary_emb=image_rotary_emb)
    hidden_states = residual(hidden_states, attention, c)
    normalized = norm(hidden_states, self.norm2.runner_gamma, self.norm2.eps, d, e)
    return residual(hidden_states, self.ff(normalized), f)


def install(model):
    from diffusers.models.transformers.transformer_krea2 import Krea2RMSNorm, Krea2TransformerBlock, Krea2Attention

    for module in model.modules():
        if isinstance(module, Krea2RMSNorm):
            module.register_buffer('runner_gamma', (module.weight + 1).float(), persistent=False)
            module.forward = MethodType(lambda self, x: norm(x, self.runner_gamma, self.eps), module)
        elif isinstance(module, Krea2TransformerBlock):
            module.forward = MethodType(_block, module)
        elif isinstance(module, Krea2Attention):
            module.set_processor(Attention())
