"""LTX 2.5's transformer block computed with comfy-kitchen's fused kernels.

diffusers' block is the reference: the same products in the same order. What changes is how
often the tokens are read and written between them. Its norms, modulations, rotations and sums
are one elementwise pass each over the whole sequence, some in float32: on a 12 GiB card they
cost a step as much as the INT8 products (profiled on a 288 x 512 draft: 325 ms of 900). Here:

- a norm and its modulation, rms_norm(x) * (1 + scale) + shift, are one kernel;
- the rotary embedding turns the queries and the keys in one kernel, from rotation matrices
  built once per step in the model's precision;
- a feed-forward's GELU is applied inside the INT8 product that follows it, and the wide
  intermediate (four times the tokens) is never written out;
- a branch's last product adds itself to the stream: residual + gate * linear(x);
- the attentions over the video run through cuDNN's kernel (see _attention);
- the embedding of a timestep is kept once per different timestep, not once per token
  (see _grouped).

A fused kernel rounds once where the separate steps rounded each time: on real inputs a block's
result differs from diffusers' by 0.2 % (cosine 0.999998), the noise of bfloat16 itself.
"""

import inspect
from types import SimpleNamespace

import comfy_kitchen
import torch
import torch.nn.functional as F
from torch.nn.attention import SDPBackend, sdpa_kernel

# A feed-forward runs this many tokens at a time: its inner layer is four times as wide as the
# tokens, one block of 700 MiB per layer for a large video on a GPU full of smaller pieces.
ROWS = 8192


# cuDNN's attention first, then PyTorch's own choice: its default on Windows, where the flash
# kernel is not built, is the memory-efficient one.
KERNELS = [SDPBackend.CUDNN_ATTENTION, SDPBackend.FLASH_ATTENTION, SDPBackend.EFFICIENT_ATTENTION, SDPBackend.MATH]
# The rotary modules of the transformer, and the kernels a fused block needs of comfy-kitchen.
ROPES = ('rope', 'audio_rope', 'cross_attn_rope', 'cross_attn_audio_rope')
FUSED = ('rms_adaln', 'apply_rope_split_half', 'apply_rope_split_half1')
PRIORITIES = 'set_priority' in inspect.signature(sdpa_kernel).parameters
# From this many tokens on one side, cuDNN's kernel is the faster; and from this many scores, it
# is faster again on tensors laid out head by head, their copy included.
LONG = 1024
HUGE = 2 * 10**8
# The smallest piece of the queries of an attention computed in pieces (_attention_in_pieces).
PIECE = 1024
# The pipeline gives the video one timestep per token: the tokens an image holds have their
# own, all the others share the step's. From this many tokens on, and for at most this many
# different timesteps, an embedding is computed and kept once per timestep (see _grouped).
SHARED = 1024
GROUPS = 16
# The modules that embed the video's timesteps: the first one says which tokens share one.
TIMES = ('time_embed', 'av_cross_attn_video_scale_shift', 'av_cross_attn_video_a2v_gate')


def _attention(query, key, held, mask=None):
    """scaled_dot_product_attention of [B, T, heads, dim] tensors, [B, T, heads, dim] back.

    Measured on an RTX 4070 Super, 32 heads of 128, bfloat16, against PyTorch's default kernel:
    the video over itself 1.46 ms instead of 2.24 for 2 304 tokens, 8.3 instead of 11.8 for
    5 600, 120 instead of 179 for 22 400 (four fifths of a block at that size); over the text
    0.64 instead of 0.87 ms. The same scores to 0.1 % (bfloat16's rounding). The few tokens of
    the sound among themselves are faster with the default. A kernel that cannot take the call
    (a mask) leaves it to the next.

    When the video memory lacks for it (the refining pass of 10 s at 896 x 1600 on an 8 GiB
    card, 17/11), the same attention a piece of its queries at a time: see _attention_in_pieces."""
    try:
        return _whole_attention(query, key, held, mask)
    except torch.OutOfMemoryError:
        if mask is not None:
            raise
    return _attention_in_pieces(query, key, held)


def _whole_attention(query, key, held, mask=None):
    query, key, held = query.transpose(1, 2), key.transpose(1, 2), held.transpose(1, 2)
    queries, keys = query.shape[2], key.shape[2]
    if not PRIORITIES or max(queries, keys) < LONG:
        return F.scaled_dot_product_attention(query, key, held, attn_mask=mask).transpose(1, 2)
    if queries * keys >= HUGE:
        query, key, held = query.contiguous(), key.contiguous(), held.contiguous()
    with sdpa_kernel(KERNELS, set_priority=True):
        return F.scaled_dot_product_attention(query, key, held, attn_mask=mask).transpose(1, 2)


def _attention_in_pieces(query, key, held):
    """The attention of [B, T, heads, dim] tensors when the whole does not fit: the queries a
    piece at a time, each piece's answer written where its queries were (they are read no
    more). Each query reads every key on its own: the answer is the one of the whole call,
    to the rounding of the kernel. No copy of the keys and values laid out head by head
    (what makes the whole call faster costs their size again)."""
    from runner.models.ladder import in_pieces

    keys, values = key.transpose(1, 2), held.transpose(1, 2)

    def piece(start, stop):
        rows = query[:, start:stop].transpose(1, 2)
        if PRIORITIES and keys.shape[2] >= LONG:
            with sdpa_kernel(KERNELS, set_priority=True):
                answer = F.scaled_dot_product_attention(rows, keys, values)
        else:
            answer = F.scaled_dot_product_attention(rows, keys, values)
        query[:, start:stop] = answer.transpose(1, 2)

    rows = query.shape[1]
    in_pieces(piece, rows, torch, unit=min(PIECE, rows), first=max(PIECE, -(-rows // 2 // PIECE) * PIECE))
    return query


def _modulation(table, temb, batch):
    """The rows of a block's table added to the step's embedding: one [B, T or 1, D] each."""
    count = table.shape[0]
    return (table[None, None].to(temb.device) + temb.reshape(batch, temb.shape[1], count, -1)).unbind(dim=2)


def _modulated(norm, value, scale, shift):
    return comfy_kitchen.rms_adaln(value, scale, shift, norm.eps)


def _spread(value, index, groups):
    """What is kept once per group of tokens ([B, groups, D]), read for each token ([B, T, D]).

    Made where it is read and dropped after: one such tensor is 274 MiB for a 896 x 1600 video
    of 8 s. One group alone is every token's, and is left as it is: it goes into the products.
    So is what already has a row per token (a module left as diffusers computes it)."""
    if index is None or groups < 2 or value.ndim != 3 or value.shape[1] != groups:
        return value
    return value.index_select(1, index)


def _grouped(self, timestep, *args, **kwargs):
    """A module that embeds the video's timesteps, computed once per different timestep.

    diffusers embeds every token's timestep and gives each block the result: nine values per
    channel and per token for the first module, which each block then adds its table to. For a
    896 x 1600 video of 8 s (35 000 tokens of 4 096 channels) these copies took 7.5 of the
    card's 12 GiB, and its refining pass could not run (17/11) - for two different timesteps,
    the tokens an image holds and all the others. Here the blocks get one row per different
    timestep, and `shared.index` says which row is each token's (see _spread). The second
    result of the first module is read once after the blocks, per token: given per token.
    A batch of one sequence only (`shared.active`): rows of several sequences would mix."""
    shared = self._shared
    if self._leads:
        shared.index, shared.groups = None, 0
    if not shared.active or timestep.ndim != 1 or timestep.numel() < SHARED:
        return self._reference_forward(timestep, *args, **kwargs)
    values, index = torch.unique(timestep, return_inverse=True)
    if values.numel() > GROUPS:
        return self._reference_forward(timestep, *args, **kwargs)
    if self._leads:
        shared.index, shared.groups = index, values.numel()
    elif shared.index is None or not torch.equal(index, shared.index):
        # Not the groups the blocks were told of: per token, as diffusers computes it.
        return self._reference_forward(timestep, *args, **kwargs)
    rows, embedded = self._reference_forward(values, *args, **kwargs)
    return rows, embedded.index_select(0, index) if self._leads else embedded


def _rotations(self, coords, device=None):
    """The rotary module's (cos, sin), [B, heads, T, r] each, as the rotation matrices
    [B, T, heads, r, 2, 2] the kernel reads, in the precision of the tokens."""
    cos, sin = (value.permute(0, 2, 1, 3).to(self._rotation_dtype) for value in self._reference_forward(coords, device))
    value = torch.stack((cos, -sin, sin, cos), dim=-1)
    return value.reshape(*value.shape[:-1], 2, 2)


def _attend(attn, value, context=None, rotation=None, key_rotation=None, mask=None):
    """diffusers' LTX2AudioVideoAttnProcessor up to its output projection: [B, T, heads * dim]."""
    context = value if context is None else context
    gates = attn.to_gate_logits(value) if attn.to_gate_logits is not None else None
    heads = attn.heads
    query = attn.norm_q(attn.to_q(value)).unflatten(2, (heads, -1))
    key = attn.norm_k(attn.to_k(context)).unflatten(2, (heads, -1))
    held = attn.to_v(context).unflatten(2, (heads, -1))
    if rotation is not None:
        if key_rotation is None and query.shape == key.shape:
            query, key = comfy_kitchen.apply_rope_split_half(query, key, rotation)
        else:
            query = comfy_kitchen.apply_rope_split_half1(query, rotation)
            key = comfy_kitchen.apply_rope_split_half1(key, rotation if key_rotation is None else key_rotation)
    if mask is not None:
        batch, length = context.shape[:2]
        mask = attn.prepare_attention_mask(mask, length, batch)
        mask = mask.view(batch, heads, -1, mask.shape[-1])
    out = _attention(query, key, held, mask)
    if gates is not None:
        # Twice the sigmoid: gates whose logits are zero leave the heads as they are.
        out = out * (2.0 * torch.sigmoid(gates)).unsqueeze(-1)
    return out.flatten(2, 3)


def _joined(linear, value, residual, gate, act=None, own=True):
    """residual + gate * linear(act(value)).

    Inside the product when the layer is streamed and the gate is one value per channel (one
    timestep for the whole sequence). A gate per token (frames held by an image have their own
    timestep) is applied after it, in place when `own` says the stream is this block's."""
    streamed = hasattr(linear, 'location')
    if streamed and gate.numel() == residual.shape[-1]:
        return linear(value, act=act, residual=residual, gate=gate.reshape(-1))
    if act is not None and not streamed:
        value, act = F.gelu(value, approximate='tanh'), None
    result = linear(value, act=act) if streamed else linear(value)
    return residual.addcmul_(result, gate) if own else torch.addcmul(residual, result, gate)


def _feed(ff, value, residual, gate, index=None, groups=0):
    """residual + gate * feed-forward(value); `residual` is this block's and may be written.
    `index`: the row of `gate` that is each token's, when it has one per group of `groups`
    (see _spread)."""
    ff = getattr(ff, 'inner', ff)
    proj, out = ff.net[0].proj, ff.net[2]
    if value.shape[1] <= ROWS:
        return _joined(out, proj(value), residual, _spread(gate, index, groups), act='gelu_tanh')
    grouped = index is not None and groups > 1 and gate.ndim == 3 and gate.shape[1] == groups
    # In slices, each written back in the place of the rows it was added to.
    for start in range(0, value.shape[1], ROWS):
        rows = slice(start, start + ROWS)
        residual[:, rows] = _joined(
            out,
            proj(value[:, rows]),
            residual[:, rows],
            gate.index_select(1, index[rows]) if grouped else gate if gate.shape[1] == 1 else gate[:, rows],
            act='gelu_tanh',
            own=False,
        )
    return residual


def _block_forward(
    self,
    hidden_states,
    audio_hidden_states,
    encoder_hidden_states,
    audio_encoder_hidden_states,
    temb,
    temb_audio,
    temb_ca_scale_shift,
    temb_ca_audio_scale_shift,
    temb_ca_gate,
    temb_ca_audio_gate,
    temb_prompt=None,
    temb_prompt_audio=None,
    video_rotary_emb=None,
    audio_rotary_emb=None,
    ca_video_rotary_emb=None,
    ca_audio_rotary_emb=None,
    encoder_attention_mask=None,
    audio_encoder_attention_mask=None,
    self_attention_mask=None,
    audio_self_attention_mask=None,
    a2v_cross_attention_mask=None,
    v2a_cross_attention_mask=None,
    use_a2v_cross_attention=True,
    use_v2a_cross_attention=True,
    perturbation_mask=None,
    all_perturbed=None,
):
    """diffusers' LTX2VideoTransformerBlock.forward, see the module's note.

    The streams that come in are the caller's and are not written; what a branch returns is
    this block's, and the next branches add to it in place when they cannot do so in a product.
    """
    batch = hidden_states.size(0)
    video, audio = hidden_states, audio_hidden_states
    # The embeddings of the video's timesteps may come once per group of tokens (see _grouped).
    shared = getattr(self, '_shared', None)
    index, groups = (shared.index, shared.groups) if shared is not None else (None, 0)

    def each(value):
        return _spread(value, index, groups)

    # 1. Self-attention.
    params = _modulation(self.scale_shift_table, temb, batch)
    shift_msa, scale_msa, gate_msa, shift_mlp, scale_mlp, gate_mlp = params[:6]
    out = _attend(
        self.attn1,
        _modulated(self.norm1, video, each(scale_msa), each(shift_msa)),
        rotation=video_rotary_emb,
        mask=self_attention_mask,
    )
    video = _joined(self.attn1.to_out[0], out, video, each(gate_msa), own=False)
    if self.video_cross_attn_adaln:
        shift_text_q, scale_text_q, gate_text_q = params[6:9]

    params = _modulation(self.audio_scale_shift_table, temb_audio, batch)
    audio_shift_msa, audio_scale_msa, audio_gate_msa, audio_shift_mlp, audio_scale_mlp, audio_gate_mlp = params[:6]
    out = _attend(
        self.audio_attn1,
        _modulated(self.audio_norm1, audio, audio_scale_msa, audio_shift_msa),
        rotation=audio_rotary_emb,
        mask=audio_self_attention_mask,
    )
    audio = _joined(self.audio_attn1.to_out[0], out, audio, audio_gate_msa, own=False)
    if self.audio_cross_attn_adaln:
        audio_shift_text_q, audio_scale_text_q, audio_gate_text_q = params[6:9]

    # 2. Cross-attention with the text.
    if self.cross_attn_adaln:
        if temb_prompt is not None:
            shift_kv, scale_kv = _modulation(self.prompt_scale_shift_table, temb_prompt, batch)
        else:
            shift_kv, scale_kv = self.prompt_scale_shift_table[None, None].to(video).unbind(dim=2)
        if temb_prompt_audio is not None:
            audio_shift_kv, audio_scale_kv = _modulation(self.audio_prompt_scale_shift_table, temb_prompt_audio, batch)
        else:
            audio_shift_kv, audio_scale_kv = self.audio_prompt_scale_shift_table[None, None].to(audio).unbind(dim=2)
        encoder_hidden_states = encoder_hidden_states * (1 + scale_kv) + shift_kv
        audio_encoder_hidden_states = audio_encoder_hidden_states * (1 + audio_scale_kv) + audio_shift_kv

    if self.video_cross_attn_adaln:
        normed = _modulated(self.norm2, video, each(scale_text_q), each(shift_text_q))
    else:
        normed, gate_text_q = self.norm2(video), video.new_ones(video.shape[-1])
    out = _attend(self.attn2, normed, context=encoder_hidden_states, mask=encoder_attention_mask)
    video = _joined(self.attn2.to_out[0], out, video, each(gate_text_q))

    if self.audio_cross_attn_adaln:
        normed = _modulated(self.audio_norm2, audio, audio_scale_text_q, audio_shift_text_q)
    else:
        normed, audio_gate_text_q = self.audio_norm2(audio), audio.new_ones(audio.shape[-1])
    out = _attend(self.audio_attn2, normed, context=audio_encoder_hidden_states, mask=audio_encoder_attention_mask)
    audio = _joined(self.audio_attn2.to_out[0], out, audio, audio_gate_text_q)

    # 3. Audio to video, then video to audio: both read the streams as they are here.
    if use_a2v_cross_attention or use_v2a_cross_attention:
        table = self.video_a2v_cross_attn_scale_shift_table
        a2v_scale, a2v_shift, v2a_scale, v2a_shift = _modulation(table[:4, :], temb_ca_scale_shift, batch)
        a2v_gate = _modulation(table[4:, :], temb_ca_gate, batch)[0]
        table = self.audio_a2v_cross_attn_scale_shift_table
        audio_a2v_scale, audio_a2v_shift, audio_v2a_scale, audio_v2a_shift = _modulation(
            table[:4, :], temb_ca_audio_scale_shift, batch
        )
        v2a_gate = _modulation(table[4:, :], temb_ca_audio_gate, batch)[0]
        video_before, audio_before = video, audio
        if use_a2v_cross_attention:
            out = _attend(
                self.audio_to_video_attn,
                _modulated(self.audio_to_video_norm, video_before, each(a2v_scale), each(a2v_shift)),
                context=_modulated(self.video_to_audio_norm, audio_before, audio_a2v_scale, audio_a2v_shift),
                rotation=ca_video_rotary_emb,
                key_rotation=ca_audio_rotary_emb,
                mask=a2v_cross_attention_mask,
            )
            # Not in place while the other direction still has this stream to read.
            video = _joined(
                self.audio_to_video_attn.to_out[0], out, video, each(a2v_gate), own=not use_v2a_cross_attention
            )
        if use_v2a_cross_attention:
            out = _attend(
                self.video_to_audio_attn,
                _modulated(self.video_to_audio_norm, audio_before, audio_v2a_scale, audio_v2a_shift),
                context=_modulated(self.audio_to_video_norm, video_before, each(v2a_scale), each(v2a_shift)),
                rotation=ca_audio_rotary_emb,
                key_rotation=ca_video_rotary_emb,
                mask=v2a_cross_attention_mask,
            )
            audio = _joined(self.video_to_audio_attn.to_out[0], out, audio, v2a_gate)

    # 4. Feed-forward.
    normed = _modulated(self.norm3, video, each(scale_mlp), each(shift_mlp))
    video = _feed(self.ff, normed, video, gate_mlp, index, groups)
    del normed
    audio = _feed(
        self.audio_ff, _modulated(self.audio_norm3, audio, audio_scale_mlp, audio_shift_mlp), audio, audio_gate_mlp
    )
    return video, audio


def _forward(self, *args, **kwargs):
    """The transformer's forward without a text mask that hides nothing.

    The connectors fill the padding of a prompt with learned registers: every one of its tokens
    is read, and the mask the pipeline still passes is all zeros. Given to the attention, it is
    a matrix as large as the scores added to them for nothing, in each of the 96 text
    attentions of a step. Looked at once per mask (reading it waits for the GPU).

    And the embeddings of the video's timesteps kept once per timestep for the time of this
    call, for one sequence (see _grouped)."""
    for name in ('encoder_attention_mask', 'audio_encoder_attention_mask'):
        mask = kwargs.get(name)
        if mask is None:
            continue
        seen = self._masks.get(name)
        if seen is None or seen[0] is not mask:
            # A mask of rows is 1 for a token to read; one already made a bias is 0 for it.
            reads_all = bool((mask == 1).all() if mask.ndim == 2 else (mask == 0).all())
            seen = self._masks[name] = (mask, reads_all)
        if seen[1]:
            kwargs[name] = None
    shared = getattr(self, '_shared', None)
    if shared is None:
        return self._reference_forward(*args, **kwargs)
    hidden = kwargs.get('hidden_states', args[0] if args else None)
    shared.active = hidden is not None and hidden.shape[0] == 1
    try:
        return self._reference_forward(*args, **kwargs)
    finally:
        shared.active, shared.index, shared.groups = False, None, 0


def fusable(transformer):
    """Whether these blocks are the ones `_block_forward` computes: split rotary embeddings,
    plain attention (no perturbed layers), norms without weights, tanh GELU feed-forwards."""
    if not all(hasattr(comfy_kitchen, name) for name in FUSED):
        return False
    for block in transformer.transformer_blocks:
        norms = [block.norm1, block.norm2, block.norm3, block.audio_norm1, block.audio_norm2, block.audio_norm3]
        norms += [block.audio_to_video_norm, block.video_to_audio_norm]
        feeds = [getattr(ff, 'inner', ff).net[0] for ff in (block.ff, block.audio_ff)]
        if (
            block.perturbed_attn
            or block.attn1.rope_type != 'split'
            or any(getattr(norm, 'weight', None) is not None for norm in norms)
            or any(getattr(feed, 'approximate', None) != 'tanh' for feed in feeds)
        ):
            return False
    return True


def fuse(transformer, dtype=torch.bfloat16):
    """Give the transformer's blocks the fused forward above. False, and nothing is changed,
    when its blocks are not the ones that forward computes."""
    if not fusable(transformer):
        return False
    for block in transformer.transformer_blocks:
        block._reference_forward = block.forward
        block.forward = _block_forward.__get__(block)
    for rope in (getattr(transformer, name) for name in ROPES):
        rope._reference_forward = rope.forward
        rope._rotation_dtype = dtype
        rope.forward = _rotations.__get__(rope)
    # Which tokens share a timestep, said by the first module to the others and to the blocks.
    shared = SimpleNamespace(active=False, index=None, groups=0)
    for block in transformer.transformer_blocks:
        block._shared = shared
    for name in TIMES:
        module = getattr(transformer, name, None)
        if module is None:
            continue
        module._reference_forward, module._shared, module._leads = module.forward, shared, name == TIMES[0]
        module.forward = _grouped.__get__(module)
    transformer._shared = shared
    transformer._reference_forward = transformer.forward
    transformer._masks = {}
    transformer.forward = _forward.__get__(transformer)
    return True
