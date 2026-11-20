"""Wan 2.2 image-to-video (I2V-A14B): its two transformers, independent of ComfyUI.

Wan 2.2 makes a video from an image with two models of the same shape, each trained for a part
of the denoising: the « high noise » one draws the layout and the motion while the picture is
mostly noise, the « low noise » one finishes the details. Both are the 14B transformer of Wan 2.1
(diffusers' Wan blocks, Apache-2.0, are the layers) without its image encoder: the image is given
as latents only. After the official implementation (github.com/Wan-Video/Wan2.2, Apache-2.0,
`wan/image2video.py`, `wan/modules/model.py`):

- the sequence carries 36 channels: the 16 of the latents being drawn, 4 that say which frames
  are given (the first one), and the 16 of the image encoded as the first frame of a video whose
  other frames are grey (zeros);
- the text is UMT5-XXL's, 512 places; nothing else conditions the model.

The files are ComfyUI's single-file layout, with the names of the original Wan code: `names`
gives each parameter of the diffusers model its tensor (the same names as Wan 2.1's, see
runner.models.wan_scail2).
"""

import re

from runner.models.wan_scail2 import _COMPANIONS, renamed

DIM = 5120
LAYERS = 40
HEADS = 40
LATENT_CHANNELS = 16
GIVEN_CHANNELS = 4
STREAM_CHANNELS = LATENT_CHANNELS + GIVEN_CHANNELS + LATENT_CHANNELS  # 36
TEXT_TOKENS = 512
PATCH = (1, 2, 2)
# The noise level under which the « low noise » model takes over (wan/configs/wan_i2v_A14B.py).
BOUNDARY = 0.9
EXPERTS = ('high', 'low')


def architecture():
    """The empty model: one of the two transformers (both have this shape)."""
    from accelerate import init_empty_weights
    from diffusers import WanTransformer3DModel

    with init_empty_weights():
        return WanTransformer3DModel(
            patch_size=PATCH,
            num_attention_heads=HEADS,
            attention_head_dim=DIM // HEADS,
            in_channels=STREAM_CHANNELS,
            out_channels=LATENT_CHANNELS,
            num_layers=LAYERS,
        )


def names(header):
    """{diffusers name: ('model', key of the file, None)} for every tensor of the model."""
    result = {}
    for key in header:
        if key == '__metadata__' or key.endswith(_COMPANIONS):
            continue
        name = renamed(key)
        if name is None:
            raise ValueError('Unsupported Wan 2.2 tensor: ' + key)
        result[name] = ('model', key, None)
    return result


def validate_layout(header):
    """The file holds one of the two models, every tensor in its place and of its size; returns
    `names`. Another Wan model is named for what it is (text-to-video takes no image)."""
    entry = header.get('patch_embedding.weight')
    if entry is None:
        raise ValueError('Ce fichier n’est pas un modèle Wan 2.2 : il n’a pas la couche d’entrée attendue.')
    channels = entry['shape'][1] if len(entry['shape']) == 5 else None
    if channels != STREAM_CHANNELS:
        kind = {16: 'texte vers vidéo (T2V)', 48: 'le petit modèle 5B (TI2V)'}.get(channels, f'{channels} canaux')
        raise ValueError(
            f'Ce fichier n’est pas un modèle Wan 2.2 image vers vidéo (I2V 14B) : son entrée est celle de {kind}.'
        )
    if any(key.startswith('img_emb.') for key in header):
        raise ValueError('Ce fichier est un modèle Wan 2.1 image vers vidéo (il a un encodeur d’image), pas Wan 2.2.')
    found, model = names(header), architecture()
    wanted = {name: tuple(parameter.shape) for name, parameter in model.named_parameters()}
    missing = sorted(wanted.keys() - found.keys())
    if missing:
        raise ValueError('Not a Wan 2.2 I2V model: missing ' + missing[0])
    extra = sorted(found.keys() - wanted.keys())
    if extra:
        raise ValueError('Unsupported Wan 2.2 tensor: ' + found[extra[0]][1])
    for name, shape in wanted.items():
        if tuple(header[found[name][1]]['shape']) != shape:
            raise ValueError('Unexpected Wan 2.2 tensor size: ' + found[name][1])
    return found


def expert(header, path=''):
    """'high' or 'low': which of the two models a file is, as the file says it (`model_type` of its
    metadata: « Wan2_2-I2V-A14B-HIGH »), else as its name does; None when neither tells."""
    said = str((header.get('__metadata__') or {}).get('model_type', ''))
    for text in (said, str(path).replace('\\', '/').rsplit('/', 1)[-1]):
        # As a word of its own (« high_noise », « -LOW_ », « HighNoise »): a step LoRA is told by its
        # name alone, and « flow », « slow » or « lowvram » say nothing of the model it is for.
        tells = set(re.findall(r'(?<![a-z])(high|low)(?:[ _-]?noise)?(?![a-z])', text.lower()))
        if len(tells) == 1:
            return tells.pop()
    return None


def given(image_latents):
    """What the model reads beside the latents it draws, [batch, 20, frames, height, width]: four
    channels of ones over the first latent frame (the image, given) and zeros over the others,
    then the latents of the image followed by grey frames."""
    import torch

    marks = torch.zeros_like(image_latents[:, :GIVEN_CHANNELS])
    marks[:, :, 0] = 1
    return torch.cat([marks, image_latents], dim=1)


def positions(model, shape):
    """(cos, sin) of the rotary positions of every token of latents of this shape ([batch,
    channels, frames, height, width]), each [1, tokens, 1, head size] in float32: diffusers' own,
    computed once for all the steps a model draws."""
    import torch

    cos, sin = model.rope(torch.empty(shape, device='meta'))
    return cos.float(), sin.float()


def forward(model, latents, timestep, text, condition, rotary=None):
    """The model's prediction for the latents, [batch, 16, frames, height, width].

    `condition` is the result of `given`; `text` holds 512 tokens of the text encoder. `rotary`
    takes the result of `positions` when it is kept from one step to the next.
    """
    import torch

    if text.shape[1] != TEXT_TOKENS:
        raise ValueError('Wan 2.2 reads 512 text tokens')
    batch, _, frames, height, width = latents.shape
    dtype = model.patch_embedding.weight.dtype
    stream = torch.cat([latents, condition], dim=1).to(dtype)
    if rotary is None:
        rotary = positions(model, stream.shape)
    tokens = model.patch_embedding(stream)
    _, rows, columns = tokens.shape[2:]
    tokens = tokens.flatten(2).transpose(1, 2).contiguous()
    del stream

    # As diffusers' WanTimeTextImageEmbedding, which asks the time embedder for its parameters'
    # precision: layers that take their weights from the pool have none.
    embedder = model.condition_embedder
    temb = embedder.time_embedder(embedder.timesteps_proj(timestep).to(text.dtype)).type_as(text)
    projected = embedder.time_proj(embedder.act_fn(temb)).unflatten(1, (6, -1))
    context = embedder.text_embedder(text)
    for block in model.blocks:
        tokens = block(tokens, context, projected, rotary)

    shift, scale = (model.scale_shift_table.to(temb.device) + temb.unsqueeze(1)).chunk(2, dim=1)
    if tokens.dtype in (torch.bfloat16, torch.float16) and tokens.is_cuda:
        # One kernel in the precision of the tokens (see runner.models.wan_block).
        import comfy_kitchen

        tokens = comfy_kitchen.adaln(tokens, scale.to(tokens.dtype), shift.to(tokens.dtype), model.norm_out.eps)
    else:
        tokens = (model.norm_out(tokens.float()) * (1 + scale.float()) + shift.float()).type_as(tokens)
    tokens = model.proj_out(tokens)
    p_t, p_h, p_w = model.config.patch_size
    tokens = tokens.reshape(batch, frames, rows, columns, p_t, p_h, p_w, -1)
    return tokens.permute(0, 7, 1, 4, 2, 5, 3, 6).flatten(6, 7).flatten(4, 5).flatten(2, 3)
