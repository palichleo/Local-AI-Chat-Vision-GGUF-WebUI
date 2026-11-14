"""Wan 2.1 SCAIL-2 (character animation and replacement): its transformer, independent of ComfyUI.

The model is the 14B image-to-video transformer of Wan 2.1 with two more patch embeddings: one
for the driving video (« pose ») and one for the identity masks. diffusers' Wan blocks
(Apache-2.0) are the layers; what is specific to SCAIL-2 is written here after the official
implementation (github.com/zai-org/SCAIL-2, Apache-2.0, `wan/modules/model_scail2.py`):

- the sequence is [reference image, one latent frame] + [video] + [pose]. The reference and the
  video go through `patch_embedding` together; the pose, encoded at half the size of the video,
  through `patch_embedding_pose`, and its tokens are appended. Only the video comes out.
- every stream carries 20 channels: 16 latent channels and 4 that say what is given (ones for
  the reference and the pose, the frames kept from an earlier segment for the video).
- the identity masks (28 channels, see runner.video — not written yet) are embedded by
  `patch_embedding_mask` and added: the reference's to the reference frame (zeros over the
  video), the driving video's to the pose tokens.
- rotary positions: the reference sits at time 0. To replace a character it is moved 120 rows
  down and the video starts at time 0 as well; to animate one it stays in place and the video
  starts at time 1. The pose is given the video's positions 120 columns to the right, then
  averaged two by two in rows and columns (it has a quarter of the tokens): the rotations
  themselves are averaged, so a pose rotation may be shorter than one.

The file is ComfyUI's single-file layout, with the names of the original Wan code: `names`
gives each parameter of the diffusers model its tensor.
"""

import re

DIM = 5120
LAYERS = 40
HEADS = 40
LATENT_CHANNELS = 16
STREAM_CHANNELS = 20  # 16 latent channels + 4 that say what is given
MASK_CHANNELS = 28
IMAGE_DIM = 1280  # CLIP ViT-H, the layer before last
TEXT_TOKENS = 512  # diffusers' cross-attention takes what comes before the last 512 as the image
REFERENCE_ROWS = 120
POSE_COLUMNS = 120
PATCH = (1, 2, 2)

# The names of the original code, and diffusers' for the same tensors.
_OUTSIDE = {
    'time_embedding.0': 'condition_embedder.time_embedder.linear_1',
    'time_embedding.2': 'condition_embedder.time_embedder.linear_2',
    'time_projection.1': 'condition_embedder.time_proj',
    'text_embedding.0': 'condition_embedder.text_embedder.linear_1',
    'text_embedding.2': 'condition_embedder.text_embedder.linear_2',
    'img_emb.proj.0': 'condition_embedder.image_embedder.norm1',
    'img_emb.proj.1': 'condition_embedder.image_embedder.ff.net.0.proj',
    'img_emb.proj.3': 'condition_embedder.image_embedder.ff.net.2',
    'img_emb.proj.4': 'condition_embedder.image_embedder.norm2',
    'head.head': 'proj_out',
    'patch_embedding': 'patch_embedding',
    'patch_embedding_pose': 'patch_embedding_pose',
    'patch_embedding_mask': 'patch_embedding_mask',
}
_BLOCK = {
    'self_attn.q': 'attn1.to_q',
    'self_attn.k': 'attn1.to_k',
    'self_attn.v': 'attn1.to_v',
    'self_attn.o': 'attn1.to_out.0',
    'self_attn.norm_q': 'attn1.norm_q',
    'self_attn.norm_k': 'attn1.norm_k',
    'cross_attn.q': 'attn2.to_q',
    'cross_attn.k': 'attn2.to_k',
    'cross_attn.v': 'attn2.to_v',
    'cross_attn.o': 'attn2.to_out.0',
    'cross_attn.k_img': 'attn2.add_k_proj',
    'cross_attn.v_img': 'attn2.add_v_proj',
    'cross_attn.norm_q': 'attn2.norm_q',
    'cross_attn.norm_k': 'attn2.norm_k',
    'cross_attn.norm_k_img': 'attn2.norm_added_k',
    'norm3': 'norm2',
    'ffn.0': 'ffn.net.0.proj',
    'ffn.2': 'ffn.net.2',
}
# What a quantised weight stores beside itself, read with it by the pool.
_COMPANIONS = ('.weight_scale', '.comfy_quant')


def architecture():
    """The empty model: Wan 2.1's image-to-video transformer and the two embeddings of SCAIL-2."""
    from accelerate import init_empty_weights
    from diffusers import WanTransformer3DModel

    with init_empty_weights():
        model = WanTransformer3DModel(
            patch_size=PATCH,
            num_attention_heads=HEADS,
            attention_head_dim=DIM // HEADS,
            in_channels=STREAM_CHANNELS,
            out_channels=LATENT_CHANNELS,
            num_layers=LAYERS,
            image_dim=IMAGE_DIM,
            added_kv_proj_dim=DIM,
        )
        extend(model, MASK_CHANNELS)
    return model


def extend(model, mask_channels=MASK_CHANNELS):
    """Gives a Wan transformer the embeddings of the pose and of the masks."""
    import torch

    config = model.config
    width, patch = config.num_attention_heads * config.attention_head_dim, tuple(config.patch_size)
    model.patch_embedding_pose = torch.nn.Conv3d(config.in_channels, width, kernel_size=patch, stride=patch)
    model.patch_embedding_mask = torch.nn.Conv3d(mask_channels, width, kernel_size=patch, stride=patch)
    return model


def renamed(key):
    """The diffusers name of a tensor of the file, or None for what a weight stores beside itself."""
    if key.endswith(_COMPANIONS):
        return None
    if key == 'head.modulation':
        return 'scale_shift_table'
    found = re.fullmatch(r'blocks\.(\d+)\.(.+)', key)
    if found:
        index, rest = found.groups()
        if rest == 'modulation':
            return f'blocks.{index}.scale_shift_table'
        stem, _, leaf = rest.rpartition('.')
        return f'blocks.{index}.{_BLOCK[stem]}.{leaf}' if stem in _BLOCK else None
    stem, _, leaf = key.rpartition('.')
    return f'{_OUTSIDE[stem]}.{leaf}' if stem in _OUTSIDE else None


def names(header):
    """{diffusers name: ('model', key of the file, None)} for every tensor of the model."""
    result = {}
    for key in header:
        if key == '__metadata__' or key.endswith(_COMPANIONS):
            continue
        name = renamed(key)
        if name is None:
            raise ValueError('Unsupported SCAIL-2 tensor: ' + key)
        result[name] = ('model', key, None)
    return result


def validate_layout(header):
    """The file holds this model, every tensor in its place and of its size; returns `names`."""
    found, model = names(header), architecture()
    wanted = {name: tuple(parameter.shape) for name, parameter in model.named_parameters()}
    missing = sorted(wanted.keys() - found.keys())
    if missing:
        raise ValueError('Not a Wan 2.1 SCAIL-2 model: missing ' + missing[0])
    extra = sorted(found.keys() - wanted.keys())
    if extra:
        raise ValueError('Unsupported SCAIL-2 tensor: ' + found[extra[0]][1])
    for name, shape in wanted.items():
        if tuple(header[found[name][1]]['shape']) != shape:
            raise ValueError('Unexpected SCAIL-2 tensor size: ' + found[name][1])
    return found


def turned(value, cos, sin):
    """The queries or keys, [batch, tokens, heads, head size], turned by their rotary positions
    as diffusers' Wan attention does: each pair of channels by its (cos, sin)."""
    import torch

    pairs = value.unflatten(-1, (-1, 2))
    first, second = pairs[..., 0], pairs[..., 1]
    cos, sin = cos[..., 0::2], sin[..., 1::2]
    return torch.stack((first * cos - second * sin, first * sin + second * cos), dim=-1).flatten(-2).type_as(value)


class Int8SelfAttention:
    """A block's attention of the sequence over itself through comfy-kitchen's INT8 kernel
    (the method of SageAttention: queries, keys and values quantised to 8 bits, the softmax in
    float32), as runner.models.minimax_h3 does for its own model.

    With the reference, the video and the pose in one sequence (49 000 tokens for 81 frames at
    512 x 896), this attention is most of a step: 37 to 42 s a step in ComfyUI with PyTorch's
    kernel, 19 with this one, the same scene at the same seed (measured, 14/11)."""

    def __call__(self, attn, hidden_states, encoder_hidden_states=None, attention_mask=None, rotary_emb=None):
        import comfy_kitchen

        query = attn.norm_q(attn.to_q(hidden_states)).unflatten(2, (attn.heads, -1))
        key = attn.norm_k(attn.to_k(hidden_states)).unflatten(2, (attn.heads, -1))
        value = attn.to_v(hidden_states).unflatten(2, (attn.heads, -1))
        if rotary_emb is not None:
            query, key = turned(query, *rotary_emb), turned(key, *rotary_emb)
        # The kernel reads [batch, heads, tokens, head size]; the model keeps the heads third.
        result = comfy_kitchen.int8_attention(query.transpose(1, 2), key.transpose(1, 2), value.transpose(1, 2))
        del query, key, value
        result = result.transpose(1, 2).flatten(2, 3).type_as(hidden_states)
        return attn.to_out[1](attn.to_out[0](result))


def int8_attention_ready():
    try:
        import comfy_kitchen
        import torch

        return bool(comfy_kitchen.int8_attention_is_available(torch.device('cuda')))
    except Exception:
        return False


def use_int8_attention(model):
    """The blocks' self-attention goes through the INT8 kernel where this GPU has it; the
    attention to the text and to the reference image (769 keys) stays PyTorch's. Returns whether
    it was set."""
    if not int8_attention_ready():
        return False
    for block in model.blocks:
        block.attn1.processor = Int8SelfAttention()
    return True


def rotations(rope, frames, rows, columns, replace, pose=True, dtype=None):
    """(cos, sin) of the rotary positions of every token, each [1, tokens, 1, head size]: the
    reference frame, `frames` frames of video of `rows` x `columns` tokens, then the pose.

    `rope` is diffusers' WanRotaryPosEmbed, whose tables hold one row per position for time, rows
    and columns side by side."""
    import torch
    import torch.nn.functional as F

    sizes = [rope.t_dim, rope.h_dim, rope.w_dim]
    tables = [table.split(sizes, dim=1) for table in (rope.freqs_cos, rope.freqs_sin)]

    def grid(count, time, row, column):
        """[2, count, rows, columns, head size]: cos then sin."""
        return torch.stack(
            [
                torch.cat(
                    [
                        table[0][time : time + count].view(count, 1, 1, -1).expand(count, rows, columns, -1),
                        table[1][row : row + rows].view(1, rows, 1, -1).expand(count, rows, columns, -1),
                        table[2][column : column + columns].view(1, 1, columns, -1).expand(count, rows, columns, -1),
                    ],
                    dim=-1,
                )
                for table in tables
            ]
        )

    start = 0 if replace else 1
    parts = [grid(1, 0, REFERENCE_ROWS if replace else 0, 0).flatten(1, 3), grid(frames, start, 0, 0).flatten(1, 3)]
    if pose:
        if rows % 2 or columns % 2:
            raise ValueError('SCAIL-2 needs a width and a height that are multiples of 32')
        spread = grid(frames, start, 0, POSE_COLUMNS)
        # The rotations of the four video positions a pose token covers, averaged as they are.
        pooled = F.avg_pool2d(spread.flatten(0, 1).permute(0, 3, 1, 2).float(), kernel_size=2, stride=2)
        parts.append(pooled.permute(0, 2, 3, 1).unflatten(0, (2, frames)).flatten(1, 3))
    cos, sin = torch.cat([part.to(parts[-1].dtype) for part in parts], dim=1).unsqueeze(1).unsqueeze(3)
    return (cos, sin) if dtype is None else (cos.to(dtype), sin.to(dtype))


def forward(
    model,
    video,
    timestep,
    text,
    image,
    reference,
    pose=None,
    reference_mask=None,
    pose_mask=None,
    replace=True,
    rotary=None,
):
    """The model's prediction for the video latents, [batch, 16, frames, height, width].

    `video` and `reference` are [batch, 20, frames or 1, height, width], `pose` (and `pose_mask`,
    28 channels) at half that height and width; `reference_mask` is [batch, 28, 1, height, width].
    `text` holds 512 tokens of the text encoder, `image` the tokens of the reference in CLIP.
    `rotary` takes the result of `rotations` when it is kept from one step to the next.
    """
    import torch

    batch, _, frames, height, width = video.shape
    if text.shape[1] != TEXT_TOKENS:
        raise ValueError('SCAIL-2 reads 512 text tokens')
    dtype = model.patch_embedding.weight.dtype
    stream = torch.cat([reference, video], dim=2).to(dtype)
    tokens = model.patch_embedding(stream)
    if reference_mask is not None:
        blank = reference_mask.new_zeros(batch, reference_mask.shape[1], frames, height, width)
        tokens = tokens + model.patch_embedding_mask(torch.cat([reference_mask, blank], dim=2).to(dtype))
    _, rows, columns = tokens.shape[2:]
    tokens = tokens.flatten(2).transpose(1, 2)
    kept = tokens.shape[1]
    if pose is not None:
        added = model.patch_embedding_pose(pose.to(dtype))
        if pose_mask is not None:
            added = added + model.patch_embedding_mask(pose_mask.to(dtype))
        if tuple(added.shape[2:]) != (frames, rows // 2, columns // 2):
            raise ValueError('The SCAIL-2 pose must be half the size of the video')
        tokens = torch.cat([tokens, added.flatten(2).transpose(1, 2)], dim=1)
    tokens = tokens.contiguous()
    if rotary is None:
        rotary = rotations(model.rope, frames, rows, columns, replace, pose is not None, dtype=tokens.dtype)

    # As diffusers' WanTimeTextImageEmbedding, which asks the time embedder for its parameters'
    # precision: layers that take their weights from the pool have none.
    embedder = model.condition_embedder
    temb = embedder.time_embedder(embedder.timesteps_proj(timestep).to(text.dtype)).type_as(text)
    projected = embedder.time_proj(embedder.act_fn(temb)).unflatten(1, (6, -1))
    text, image = embedder.text_embedder(text), embedder.image_embedder(image)
    context = torch.cat([image, text], dim=1)
    for block in model.blocks:
        tokens = block(tokens, context, projected, rotary)

    # The pose has done its work: only the reference and the video go through the head.
    tokens = tokens[:, :kept]
    shift, scale = (model.scale_shift_table.to(temb.device) + temb.unsqueeze(1)).chunk(2, dim=1)
    tokens = (model.norm_out(tokens.float()) * (1 + scale) + shift).type_as(tokens)
    tokens = model.proj_out(tokens)
    p_t, p_h, p_w = model.config.patch_size
    tokens = tokens.reshape(batch, 1 + frames, rows, columns, p_t, p_h, p_w, -1)
    output = tokens.permute(0, 7, 1, 4, 2, 5, 3, 6).flatten(6, 7).flatten(4, 5).flatten(2, 3)
    return output[:, :, 1:]
