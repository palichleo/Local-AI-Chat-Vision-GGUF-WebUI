"""Native MiniMax-H3 DiT for the pruned 8-step checkpoints (FastH3 Omni / FastH3 v2).

The block stack is diffusers' `MiniMaxH3Transformer3DModel` (Apache-2.0). The
pruned checkpoints differ from it in three places, adapted here:
- no timestep MLP: an `adaln_t_table` curve of 1025 points is linearly
  interpolated at t, and the AdaLN projections read it without SiLU;
- the output heads may hold several "PDD" heads (Omni: 32), blended per
  sampling step from the step's sigma interval;
- Comfy single-file layout: fused `qkv_proj` stacked [q; k; v], `fc1` stored
  [gate; value], int8 ConvRot linears streamed from the file.
"""

import json
import math

import torch
import torch.nn.functional as F

RENAMES = (
    ('token_refiner.blocks.', 'token_refiner.refiner_blocks.'),
    ('video_patch_proj.', 'proj_in.'),
    ('audio_patch_proj.', 'audio_proj_in.'),
    ('condition_proj.', 'context_embedder.'),
    ('final_layer.norm.', 'norm_out.norm.'),
    ('final_layer.adaln_proj.linear.', 'norm_out.linear.'),
    ('final_layer.video_out.', 'proj_out.'),
    ('final_layer.audio_out.', 'audio_proj_out.'),
    ('.attn.q_norm.', '.attn.norm_q.'),
    ('.attn.k_norm.', '.attn.norm_k.'),
    ('.attn.out_proj.', '.attn.to_out.0.'),
    ('.mlp.fc1.', '.ff.net.0.proj.'),
    ('.mlp.fc2.', '.ff.net.2.'),
)
VIDEO_PATCH = 96
AUDIO_PATCH = 32
VIDEO_SHIFT = 12.0
AUDIO_SHIFT = 3.0


def names(header):
    """{diffusers parameter name: (role, checkpoint key, qkv part or None)}."""
    result = {}
    for key in header:
        if key == '__metadata__' or not key.endswith(('.weight', '.bias')):
            continue
        if '.to_gate_compress.' in key or key.startswith('rope.'):
            # Video-sparse-attention gate, unused by dense attention; RoPE is recomputed.
            continue
        name = 'transformer_blocks.' + key[len('blocks.') :] if key.startswith('blocks.') else key
        for old, new in RENAMES:
            name = name.replace(old, new)
        if '.attn.qkv_proj.' in name:
            for index, part in enumerate('qkv'):
                result[name.replace('.qkv_proj.', '.to_' + part + '.')] = ('model', key, index)
        else:
            result[name] = ('model', key, None)
    return result


def pdd_heads(header):
    rows = header['final_layer.video_out.weight']['shape'][0]
    if rows % VIDEO_PATCH or header['final_layer.audio_out.weight']['shape'][0] != rows // VIDEO_PATCH * AUDIO_PATCH:
        raise ValueError('Unsupported MiniMax-H3 output heads')
    return rows // VIDEO_PATCH


def validate(header):
    """Raise unless the file is a pruned (AdaLN curve) MiniMax-H3 DiT this runner can stream."""
    if 'adaln_t_table' not in header:
        raise ValueError('Only the pruned MiniMax-H3 checkpoints (adaln_t_table) are supported')
    model, _ = architecture(header)
    expected = {name: list(value.shape) for name, value in model.state_dict().items()}
    mapped = names(header)
    for name, shape in expected.items():
        if name == 'time_embedder.table':
            continue
        location = mapped.get(name)
        if location is None:
            raise ValueError('Missing MiniMax-H3 tensor: ' + name)
        actual = list(header[location[1]]['shape'])
        if location[2] is not None:
            actual[0] //= 3
        if name in ('proj_out.weight', 'proj_out.bias', 'audio_proj_out.weight', 'audio_proj_out.bias'):
            actual[0] //= pdd_heads(header)
        if actual != shape:
            raise ValueError(f'Incompatible MiniMax-H3 tensor {name}: {actual} != {shape}')
    return pdd_heads(header)


class CurveEmbedding(torch.nn.Module):
    """t in [0, 1] -> linear interpolation of the AdaLN curve table."""

    def __init__(self, points, width):
        super().__init__()
        self.table = torch.nn.Parameter(torch.empty(points, width, dtype=torch.float32), requires_grad=False)

    def forward(self, timestep):
        last = self.table.shape[0] - 1
        position = timestep.float().clamp(0, 1) * last
        low = position.floor().long().clamp(max=last - 1)
        fraction = (position - low).unsqueeze(-1)
        table = self.table.float()
        return torch.lerp(table[low], table[low + 1], fraction)


def _curve_modulation(self, temb):
    # Curve form: the projection reads the interpolated table directly, without SiLU.
    temb = self.linear(temb.float()).to(torch.bfloat16)
    return temb.view(-1, 6 * self.hidden_size).chunk(6, dim=-1)


def _curve_norm_out(self, hidden_states, temb, timestep_indices):
    shift, scale = self.linear(temb.float()).float().chunk(2, dim=-1)
    hidden_states = self.norm(hidden_states).float()
    return hidden_states * (1.0 + scale.index_select(0, timestep_indices)) + shift.index_select(0, timestep_indices)


def _gate_first_swiglu(self, hidden_states, chunk=8192):
    # The checkpoint's fc1 holds [gate; value]. Rows are processed in chunks so the
    # 28672-wide intermediate of a ~50k-row sequence never materializes at once.
    flat = hidden_states.reshape(-1, hidden_states.shape[-1])
    parts = []
    for start in range(0, flat.shape[0], chunk):
        gate, value = self.proj(flat[start : start + chunk]).chunk(2, dim=-1)
        parts.append(F.silu(gate) * value)
    return torch.cat(parts).reshape(*hidden_states.shape[:-1], -1)


def _chunked_feed_forward(self, hidden_states, chunk=8192):
    flat = hidden_states.reshape(-1, hidden_states.shape[-1])
    out = []
    for start in range(0, flat.shape[0], chunk):
        piece = _gate_first_swiglu(self.net[0], flat[start : start + chunk])
        out.append(self.net[2](piece))
    return torch.cat(out).reshape(*hidden_states.shape[:-1], -1)


def architecture(header):
    """Empty diffusers model adapted to the pruned checkpoint, and its PDD head count."""
    from accelerate import init_empty_weights
    from diffusers import MiniMaxH3Transformer3DModel
    from diffusers.models.attention import FeedForward
    from diffusers.models.transformers import transformer_minimax_h3 as reference

    points, width = header['adaln_t_table']['shape']
    with init_empty_weights():
        model = MiniMaxH3Transformer3DModel(time_embed_dim=width)
        model.time_proj = torch.nn.Identity()
        model.time_embedder = CurveEmbedding(points, width)
    for module in model.modules():
        if isinstance(module, reference.MiniMaxH3AdaLayerNormModulation):
            module.forward = _curve_modulation.__get__(module)
        elif isinstance(module, reference.MiniMaxH3AdaLayerNormOut):
            module.forward = _curve_norm_out.__get__(module)
        elif isinstance(module, FeedForward):
            module.forward = _chunked_feed_forward.__get__(module)
    return model, pdd_heads(header)


def sigma_shift(sigma, shift):
    return shift * sigma / (1 + (shift - 1) * sigma)


def sigma_unshift(sigma, shift):
    return sigma / (shift - (shift - 1) * sigma)


class PDDHead(torch.nn.Module):
    """Output projection blending the checkpoint's per-interval heads for the current step.

    Head 0 is the base projection and heads 1..n-1 its per-interval corrections.
    A step from sigma to sigma_next covers the base-time interval
    [1 - unshift(sigma), 1 - unshift(sigma_next)]; the corrections of the heads
    in that interval are averaged with weights proportional to the length of
    each head's slot on the stream's shifted sigma grid.
    """

    def __init__(self, weight, bias, heads, shift):
        super().__init__()
        self.heads = heads
        self.shift = shift
        # Buffers, so diffusers' get_parameter_dtype finds this head's float32 precision.
        self.register_buffer('weight', weight.float().reshape(heads, -1, weight.shape[-1]), persistent=False)
        self.register_buffer('bias', bias.float().reshape(heads, -1), persistent=False)
        grid = sigma_shift(torch.linspace(1, 0, heads + 1, dtype=torch.float64), shift)
        self.slots = (grid[:-1] - grid[1:]).float()
        self.interval = None
        self.cache = {}

    def blend(self, sigma, sigma_next):
        n = self.heads
        start = round((1 - sigma_unshift(float(sigma), self.shift)) * n)
        stop = round((1 - sigma_unshift(float(sigma_next), self.shift)) * n)
        start = min(start, n - 1)
        stop = max(stop, start + 1)
        if (start, stop) not in self.cache:
            weights = self.slots[start:stop] / self.slots[start:stop].sum()
            weight, bias = self.weight[0].clone(), self.bias[0].clone()
            for k in range(max(start, 1), stop):
                weight += weights[k - start] * self.weight[k]
                bias += weights[k - start] * self.bias[k]
            self.cache = {(start, stop): (weight, bias)}
        return self.cache[(start, stop)]

    def forward(self, hidden_states):
        if self.heads == 1:
            weight, bias = self.weight[0], self.bias[0]
        else:
            if self.interval is None:
                raise RuntimeError('PDD head used without a sampling interval')
            weight, bias = self.blend(*self.interval)
        return F.linear(hidden_states.float(), weight, bias)


def load(header, store_path, pool):
    """Build the DiT on CUDA: int8 linears streamed through `pool`, small tensors resident."""
    from runner.models.ltx25 import load_streamed

    model, heads = architecture(header)
    mapping = names(header)
    store = pool.stores['model']

    def tensor(key, dtype=None):
        value = store.get_tensor(key)
        return value.to('cuda', dtype=dtype or value.dtype)

    def plain_linear(prefix, dtype=None):
        weight = tensor(mapping[prefix + '.weight'][1], dtype)
        linear = torch.nn.Linear(
            weight.shape[1], weight.shape[0], bias=prefix + '.bias' in mapping, device='cuda', dtype=weight.dtype
        )
        linear.weight = torch.nn.Parameter(weight, requires_grad=False)
        if linear.bias is not None:
            linear.bias = torch.nn.Parameter(tensor(mapping[prefix + '.bias'][1], weight.dtype), requires_grad=False)
        return linear

    for prefix, container in (('token_refiner.', model.token_refiner), *(
        (f'transformer_blocks.{i}.', block) for i, block in enumerate(model.transformer_blocks)
    )):
        local = {name[len(prefix) :]: location for name, location in mapping.items() if name.startswith(prefix)}
        load_streamed(container, local, pool)
    model.proj_in = plain_linear('proj_in')
    model.audio_proj_in = plain_linear('audio_proj_in')
    model.context_embedder = plain_linear('context_embedder')
    model.norm_out.linear = plain_linear('norm_out.linear', torch.float32)
    norm = tensor(mapping['norm_out.norm.weight'][1])
    model.norm_out.norm.weight = torch.nn.Parameter(norm, requires_grad=False)
    model.time_embedder.table = torch.nn.Parameter(tensor('adaln_t_table', torch.float32), requires_grad=False)
    model.proj_out = PDDHead(
        tensor('final_layer.video_out.weight'), tensor('final_layer.video_out.bias'), heads, VIDEO_SHIFT
    )
    model.audio_proj_out = PDDHead(
        tensor('final_layer.audio_out.weight'), tensor('final_layer.audio_out.bias'), heads, AUDIO_SHIFT
    )
    for name, value in list(model.named_parameters()) + list(model.named_buffers()):
        if value.device.type == 'meta':
            raise ValueError('Missing native MiniMax-H3 tensor ' + name)
    # RoPE frequencies are generated, keep them at their own precision on CUDA.
    return model.eval().to('cuda'), heads


def set_interval(model, video, audio):
    """Tell the PDD heads which (sigma, sigma_next) step the next forward belongs to."""
    model.proj_out.interval = video
    model.audio_proj_out.interval = audio
