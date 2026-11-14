"""SAM 3.1's detector: the objects a phrase names in a picture, each with its mask and a score.

The file (`sam3.1_multiplex_fp16.safetensors`) keeps the names of Meta's checkpoint: a detector
(`detector.*`: image encoder, text encoder, DETR encoder and decoder, mask head) and a video
tracker (`tracker.*`). The detector is transformers' `Sam3Model` (Apache-2.0); its tensors are
renamed here after the table of transformers' own conversion script
(`models/sam3/convert_sam3_to_hf.py`, Apache-2.0), queries, keys and values stored as one
matrix cut in three. SAM 3.1 has three levels of image features where SAM 3 had four and left
the last unused: that one stays empty here. The tracker ("multiplex") is not read.

A picture is stretched to 1008 x 1008 whatever its shape; values go from -1 to 1.
"""

import re
from types import SimpleNamespace

SIDE = 1008
TOKENS = 32
PREFIX = 'detector.'
# What the tracker alone reads of the detector's part of the file, and prompts by points.
UNUSED = re.compile(
    r'^backbone\.vision_backbone\.(?:interactive|propagation|sam2)_convs\.|^geometry_encoder\.points_'
)
# Present in the model, absent from the file: the fourth level of features (computed, never
# read) and CLIP's own projection (the detector reads the text's tokens, not its summary).
ABSENT = re.compile(r'^vision_encoder\.neck\.fpn_layers\.3\.|^text_encoder\.text_projection\.weight$')
POSITIONS = 'vision_encoder.backbone.embeddings.position_embeddings'
RENAMES = tuple(
    (re.compile(pattern), replacement)
    for pattern, replacement in (
        # The image encoder and its pyramid.
        (r'^backbone\.vision_backbone\.trunk\.', 'vision_encoder.backbone.'),
        (r'^vision_encoder\.backbone\.pos_embed', POSITIONS),
        (
            r'^vision_encoder\.backbone\.patch_embed\.proj\.',
            'vision_encoder.backbone.embeddings.patch_embeddings.projection.',
        ),
        (r'^vision_encoder\.backbone\.ln_pre\.', 'vision_encoder.backbone.layer_norm.'),
        (r'^vision_encoder\.backbone\.blocks\.(\d+)\.norm([12])\.', r'vision_encoder.backbone.layers.\1.layer_norm\2.'),
        (r'^vision_encoder\.backbone\.blocks\.(\d+)\.attn\.qkv\.', r'vision_encoder.backbone.layers.\1.attention.qkv.'),
        (
            r'^vision_encoder\.backbone\.blocks\.(\d+)\.attn\.proj\.',
            r'vision_encoder.backbone.layers.\1.attention.o_proj.',
        ),
        (
            r'^vision_encoder\.backbone\.blocks\.(\d+)\.attn\.freqs_cis',
            r'vision_encoder.backbone.layers.\1.rotary_emb.rope_embeddings',
        ),
        (r'^vision_encoder\.backbone\.blocks\.(\d+)\.mlp\.fc([12])\.', r'vision_encoder.backbone.layers.\1.mlp.fc\2.'),
        (
            r'^backbone\.vision_backbone\.convs\.(\d+)\.dconv_2x2_0\.',
            r'vision_encoder.neck.fpn_layers.\1.scale_layers.0.',
        ),
        (
            r'^backbone\.vision_backbone\.convs\.(\d+)\.dconv_2x2_1\.',
            r'vision_encoder.neck.fpn_layers.\1.scale_layers.2.',
        ),
        (
            r'^backbone\.vision_backbone\.convs\.(\d+)\.dconv_2x2\.',
            r'vision_encoder.neck.fpn_layers.\1.scale_layers.0.',
        ),
        (r'^backbone\.vision_backbone\.convs\.(\d+)\.conv_1x1\.', r'vision_encoder.neck.fpn_layers.\1.proj1.'),
        (r'^backbone\.vision_backbone\.convs\.(\d+)\.conv_3x3\.', r'vision_encoder.neck.fpn_layers.\1.proj2.'),
        # The text encoder.
        (r'^backbone\.language_backbone\.encoder\.', 'text_encoder.'),
        (r'^text_encoder\.token_embedding\.', 'text_encoder.text_model.embeddings.token_embedding.'),
        (r'^text_encoder\.positional_embedding', 'text_encoder.text_model.embeddings.position_embedding.weight'),
        (r'^text_encoder\.ln_final\.', 'text_encoder.text_model.final_layer_norm.'),
        (r'^text_encoder\.text_projection', 'text_encoder.text_projection.weight'),
        (
            r'^text_encoder\.transformer\.resblocks\.(\d+)\.attn\.in_proj_',
            r'text_encoder.text_model.encoder.layers.\1.self_attn.in_proj_',
        ),
        (
            r'^text_encoder\.transformer\.resblocks\.(\d+)\.attn\.out_proj\.',
            r'text_encoder.text_model.encoder.layers.\1.self_attn.out_proj.',
        ),
        (
            r'^text_encoder\.transformer\.resblocks\.(\d+)\.ln_([12])\.',
            r'text_encoder.text_model.encoder.layers.\1.layer_norm\2.',
        ),
        (
            r'^text_encoder\.transformer\.resblocks\.(\d+)\.mlp\.c_fc\.',
            r'text_encoder.text_model.encoder.layers.\1.mlp.fc1.',
        ),
        (
            r'^text_encoder\.transformer\.resblocks\.(\d+)\.mlp\.c_proj\.',
            r'text_encoder.text_model.encoder.layers.\1.mlp.fc2.',
        ),
        (r'^backbone\.language_backbone\.resizer\.', 'text_projection.'),
        # Prompts by boxes.
        (
            r'^geometry_encoder\.encode\.(\d+)\.cross_attn_image\.out_proj\.',
            r'geometry_encoder.layers.\1.cross_attn.o_proj.',
        ),
        (r'^geometry_encoder\.encode\.(\d+)\.cross_attn_image\.', r'geometry_encoder.layers.\1.cross_attn.'),
        (r'^geometry_encoder\.encode\.(\d+)\.self_attn\.out_proj\.', r'geometry_encoder.layers.\1.self_attn.o_proj.'),
        (r'^geometry_encoder\.encode\.(\d+)\.self_attn\.', r'geometry_encoder.layers.\1.self_attn.'),
        (r'^geometry_encoder\.encode\.(\d+)\.linear([12])\.', r'geometry_encoder.layers.\1.mlp.fc\2.'),
        (r'^geometry_encoder\.encode\.(\d+)\.norm([123])\.', r'geometry_encoder.layers.\1.layer_norm\2.'),
        (r'^geometry_encoder\.img_pre_norm\.', 'geometry_encoder.vision_layer_norm.'),
        (r'^geometry_encoder\.norm\.', 'geometry_encoder.prompt_layer_norm.'),
        (r'^geometry_encoder\.encode_norm\.', 'geometry_encoder.output_layer_norm.'),
        # The DETR encoder.
        (
            r'^transformer\.encoder\.layers\.(\d+)\.cross_attn_image\.out_proj\.',
            r'detr_encoder.layers.\1.cross_attn.o_proj.',
        ),
        (r'^transformer\.encoder\.layers\.(\d+)\.cross_attn_image\.', r'detr_encoder.layers.\1.cross_attn.'),
        (r'^transformer\.encoder\.layers\.(\d+)\.self_attn\.out_proj\.', r'detr_encoder.layers.\1.self_attn.o_proj.'),
        (r'^transformer\.encoder\.layers\.(\d+)\.self_attn\.', r'detr_encoder.layers.\1.self_attn.'),
        (r'^transformer\.encoder\.layers\.(\d+)\.cross_attn\.out_proj\.', r'detr_encoder.layers.\1.cross_attn.o_proj.'),
        (r'^transformer\.encoder\.layers\.(\d+)\.cross_attn\.', r'detr_encoder.layers.\1.cross_attn.'),
        (r'^transformer\.encoder\.layers\.(\d+)\.linear([12])\.', r'detr_encoder.layers.\1.mlp.fc\2.'),
        (r'^transformer\.encoder\.layers\.(\d+)\.norm([123])\.', r'detr_encoder.layers.\1.layer_norm\2.'),
        # The DETR decoder.
        (r'^transformer\.decoder\.query_embed\.', 'detr_decoder.query_embed.'),
        (r'^transformer\.decoder\.reference_points\.', 'detr_decoder.reference_points.'),
        (r'^transformer\.decoder\.presence_token\.', 'detr_decoder.presence_token.'),
        (
            r'^transformer\.decoder\.presence_token_head\.layers\.(\d)\.',
            lambda m: f'detr_decoder.presence_head.layer{int(m[1]) + 1}.',
        ),
        (r'^transformer\.decoder\.presence_token_out_norm\.', 'detr_decoder.presence_layer_norm.'),
        (r'^transformer\.decoder\.norm\.', 'detr_decoder.output_layer_norm.'),
        (
            r'^transformer\.decoder\.bbox_embed\.layers\.(\d)\.',
            lambda m: f'detr_decoder.box_head.layer{int(m[1]) + 1}.',
        ),
        (
            r'^transformer\.decoder\.ref_point_head\.layers\.(\d)\.',
            lambda m: f'detr_decoder.ref_point_head.layer{int(m[1]) + 1}.',
        ),
        (
            r'^transformer\.decoder\.boxRPB_embed_([xy])\.layers\.(\d)\.',
            lambda m: f'detr_decoder.box_rpb_embed_{m[1]}.layer{int(m[2]) + 1}.',
        ),
        (r'^transformer\.decoder\.layers\.(\d+)\.self_attn\.out_proj\.', r'detr_decoder.layers.\1.self_attn.o_proj.'),
        (r'^transformer\.decoder\.layers\.(\d+)\.self_attn\.', r'detr_decoder.layers.\1.self_attn.'),
        (
            r'^transformer\.decoder\.layers\.(\d+)\.ca_text\.out_proj\.',
            r'detr_decoder.layers.\1.text_cross_attn.o_proj.',
        ),
        (r'^transformer\.decoder\.layers\.(\d+)\.ca_text\.', r'detr_decoder.layers.\1.text_cross_attn.'),
        (
            r'^transformer\.decoder\.layers\.(\d+)\.cross_attn\.out_proj\.',
            r'detr_decoder.layers.\1.vision_cross_attn.o_proj.',
        ),
        (r'^transformer\.decoder\.layers\.(\d+)\.cross_attn\.', r'detr_decoder.layers.\1.vision_cross_attn.'),
        (r'^transformer\.decoder\.layers\.(\d+)\.linear([12])\.', r'detr_decoder.layers.\1.mlp.fc\2.'),
        (r'^transformer\.decoder\.layers\.(\d+)\.norm1\.', r'detr_decoder.layers.\1.vision_cross_attn_layer_norm.'),
        (r'^transformer\.decoder\.layers\.(\d+)\.catext_norm\.', r'detr_decoder.layers.\1.text_cross_attn_layer_norm.'),
        (r'^transformer\.decoder\.layers\.(\d+)\.norm2\.', r'detr_decoder.layers.\1.self_attn_layer_norm.'),
        (r'^transformer\.decoder\.layers\.(\d+)\.norm3\.', r'detr_decoder.layers.\1.mlp_layer_norm.'),
        # The scores.
        (
            r'^dot_prod_scoring\.prompt_mlp\.layers\.(\d)\.',
            lambda m: f'dot_product_scoring.text_mlp.layer{int(m[1]) + 1}.',
        ),
        (r'^dot_prod_scoring\.prompt_mlp\.out_norm\.', 'dot_product_scoring.text_mlp_out_norm.'),
        (r'^dot_prod_scoring\.prompt_proj\.', 'dot_product_scoring.text_proj.'),
        (r'^dot_prod_scoring\.hs_proj\.', 'dot_product_scoring.query_proj.'),
        # The masks.
        (r'^segmentation_head\.pixel_decoder\.', 'mask_decoder.pixel_decoder.'),
        (r'^segmentation_head\.mask_predictor\.mask_embed\.layers\.', 'mask_decoder.mask_embedder.layers.'),
        (r'^segmentation_head\.instance_seg_head\.', 'mask_decoder.instance_projection.'),
        (r'^segmentation_head\.semantic_seg_head\.', 'mask_decoder.semantic_projection.'),
        (r'^segmentation_head\.cross_attend_prompt\.out_proj\.', 'mask_decoder.prompt_cross_attn.o_proj.'),
        (r'^segmentation_head\.cross_attend_prompt\.', 'mask_decoder.prompt_cross_attn.'),
        (r'^segmentation_head\.cross_attn_norm\.', 'mask_decoder.prompt_cross_attn_norm.'),
    )
)
THIRDS = ('q_proj', 'k_proj', 'v_proj')


def renamed(key):
    """transformers' name of a tensor of the detector (the file's name without `detector.`): one
    name, or the three a matrix of queries, keys and values is cut into. None if unused."""
    if UNUSED.search(key):
        return None
    for pattern, replacement in RENAMES:
        key = pattern.sub(replacement, key)
    if '.attention.qkv.' in key:
        return tuple(key.replace('.qkv.', f'.{part}.') for part in THIRDS)
    if '.in_proj_' in key:
        kind = key.rsplit('in_proj_', 1)[1]
        return tuple(key.replace('in_proj_' + kind, f'{part}.{kind}') for part in THIRDS)
    return key


def names(header):
    """{transformers name: (file key, which third or None)} of the detector in a file."""
    found = {}
    for key in header:
        if not key.startswith(PREFIX):
            continue
        target = renamed(key[len(PREFIX) :])
        if target is None:
            continue
        if isinstance(target, tuple):
            for third, name in enumerate(target):
                found[name] = (key, third)
        else:
            found[target] = (key, None)
    return found


def architecture():
    from accelerate import init_empty_weights
    from transformers import Sam3Config, Sam3Model

    with init_empty_weights():
        return Sam3Model(Sam3Config()).eval()


def validate_layout(header, wanted=None):
    """Refuses a file that is not a SAM 3.1 checkpoint this detector reads. `wanted`:
    {name: shape} of the model, built when not given."""
    found = names(header)
    if wanted is None:
        wanted = {name: tuple(value.shape) for name, value in architecture().state_dict().items()}
    missing = sorted(name for name in wanted if name not in found and not ABSENT.search(name))
    if missing:
        raise ValueError('Not a SAM 3.1 checkpoint: missing ' + missing[0])
    for name, (key, third) in found.items():
        if name not in wanted:
            raise ValueError('Unexpected SAM 3 tensor: ' + key)
        shape = tuple(header[key]['shape'])
        if third is not None:
            shape = (shape[0] // 3, *shape[1:])
        if name == POSITIONS:
            shape = (shape[0], shape[1] - 1, *shape[2:])  # stored with a class token it has no use for
        if shape != wanted[name]:
            raise ValueError('Unexpected SAM 3 tensor size: ' + key)
    return found


def load(path, dtype=None):
    """The detector on the GPU, in half precision unless another is asked."""
    import torch
    from safetensors import safe_open

    from runner.models.headers import header

    model = architecture()
    wanted = {name: tuple(value.shape) for name, value in model.state_dict().items()}
    found = validate_layout(header(path), wanted)
    state = {}
    with safe_open(path, framework='pt') as source:
        stored = {}
        for name, (key, third) in found.items():
            if key not in stored:
                stored[key] = source.get_tensor(key)
            value = stored[key]
            if third is not None:
                value = value.chunk(3, dim=0)[third]
            if name == POSITIONS:
                value = value[:, 1:]
            state[name] = value
    kind = next(iter(state.values())).dtype
    for name, shape in wanted.items():
        if name not in state:
            state[name] = torch.zeros(shape, dtype=kind)
    model.load_state_dict(state, strict=True, assign=True)
    return model.to('cuda', dtype or torch.float16)


def _caches(function, depth=4):
    """The caches kept inside a decorated function, however many decorators wrap it."""
    if hasattr(function, 'cache_clear'):
        yield function
    if depth and callable(function):
        inner = [getattr(function, '__wrapped__', None)]
        for cell in getattr(function, '__closure__', None) or ():
            try:
                inner.append(cell.cell_contents)
            except ValueError:  # an empty cell
                pass
        for item in inner:
            if callable(item):
                yield from _caches(item, depth - 1)


def forget():
    """transformers keeps the last tables of positions its SAM 3 computed, for every model to
    come (caches on the classes): 60 to 80 MiB that stayed on the GPU once the detector had
    left it."""
    import inspect

    from transformers.models.sam3 import modeling_sam3

    for _name, owner in inspect.getmembers(modeling_sam3, inspect.isclass):
        for method in vars(owner).values():
            for cache in _caches(method):
                cache.cache_clear()


def phrases(text):
    """[(phrase, most objects)] of a prompt: phrases apart by commas, each followed if wanted by
    `:n`, the most objects it may name (one unless said). `girl, apple:3`."""
    found = []
    for part in text.replace('(', '').replace(')', '').split(','):
        part = part.strip()
        if not part:
            continue
        match = re.match(r'^(.+?)\s*:\s*(\d+)\s*$', part)
        found.append((match[1].strip(), max(1, int(match[2]))) if match else (part, 1))
    return found


def tokenizer(folder):
    """CLIP's tokenizer from a folder holding its `vocab.json` and `merges.txt`."""
    from transformers import CLIPTokenizer

    return CLIPTokenizer.from_pretrained(folder)


def token_ids(phrase, pieces):
    """([1, 32] ids, [1, 32] mask) of a phrase: start, its tokens, end, then padding the model
    does not read."""
    import torch

    ids = pieces(phrase, add_special_tokens=False)['input_ids'][: TOKENS - 2]
    ids = [pieces.bos_token_id, *ids, pieces.eos_token_id]
    mask = [1] * len(ids) + [0] * (TOKENS - len(ids))
    return torch.tensor([ids + [0] * (TOKENS - len(ids))]), torch.tensor([mask])


def text_features(model, ids, mask):
    import torch

    with torch.inference_mode():
        device = next(model.parameters()).device
        return model.get_text_features(input_ids=ids.to(device), attention_mask=mask.to(device), return_dict=True)


def image_features(model, pictures):
    """What the detector reads of pictures, [batch, 3, height, width] from -1 to 1: computed once
    a picture, whatever the number of phrases looked for in it."""
    import torch
    import torch.nn.functional as F

    parameter = next(model.parameters())
    pixels = pictures.to(parameter.device).float()
    pixels = F.interpolate(pixels, size=(SIDE, SIDE), mode='bilinear', align_corners=False)
    with torch.inference_mode():
        return model.get_vision_features(pixel_values=pixels.to(parameter.dtype), return_dict=True)


def detect(model, features, text, mask, threshold=0.5, most=1, presence=False):
    """The objects a phrase names in each picture of `features`: a list, one entry a picture, of
    (scores [n], masks [n, 288, 288] of probabilities), best first, `most` at most, each with a
    score above `threshold`.

    The score is how well an object answers the phrase. With `presence` it is multiplied by the
    model's own estimate that the phrase names anything at all in the picture, as for a single
    image; followed along a video, an object is kept on its own score (a handkerchief in a
    hand scores 0.9 on its own and 0.1 with that estimate)."""
    import torch

    batch, device = features.fpn_hidden_states[0].shape[0], features.fpn_hidden_states[0].device
    # One phrase for every picture: the model reads the tokens of a text, a text a picture.
    same = SimpleNamespace(pooler_output=text.pooler_output.expand(batch, -1, -1))
    with torch.inference_mode():
        output = model(vision_embeds=features, text_embeds=same, attention_mask=mask.to(device).expand(batch, -1))
        scores = output.pred_logits.float().sigmoid()
        if presence and output.presence_logits is not None:
            scores = scores * output.presence_logits.float().sigmoid()
        found = []
        for index in range(batch):
            order = scores[index].argsort(descending=True)[:most]
            order = order[scores[index][order] > threshold]
            found.append((scores[index][order], output.pred_masks[index][order].float().sigmoid()))
    return found
