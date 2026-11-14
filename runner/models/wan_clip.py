"""CLIP ViT-H/14, the image encoder of Wan 2.1's image-to-video models, from ComfyUI's file.

The file (`clip_vision_h.safetensors`) holds transformers' own names. What the video model reads
of the reference image is the output of the last block but one, before the final norm: 257
tokens of 1 280 values (github.com/zai-org/SCAIL-2, Apache-2.0, `wan/modules/clip.py`,
`use_31_block`). The image, already cut to the shape of the video, is stretched to 224 x 224.
"""

SIDE = 224
MEAN = (0.48145466, 0.4578275, 0.40821073)
STD = (0.26862954, 0.26130258, 0.27577711)
CONFIG = dict(
    hidden_size=1280,
    intermediate_size=5120,
    num_hidden_layers=32,
    num_attention_heads=16,
    patch_size=14,
    image_size=SIDE,
    hidden_act='gelu',
    layer_norm_eps=1e-5,
    projection_dim=1024,
)


def load(path, config=None):
    """The image encoder on the GPU in half precision."""
    import torch
    from safetensors.torch import load_file
    from transformers import CLIPVisionConfig, CLIPVisionModel

    model = CLIPVisionModel(CLIPVisionConfig(**(config or CONFIG)))
    wanted = model.state_dict()
    stored = load_file(path)
    if not any(key.startswith('vision_model.') for key in wanted):
        # transformers names the tower's tensors without the prefix the file gives them.
        stored = {key.removeprefix('vision_model.'): value for key, value in stored.items()}
    missing = sorted(key for key in wanted if key not in stored and not key.endswith('position_ids'))
    if missing:
        raise ValueError('Not a CLIP ViT-H image encoder: missing ' + missing[0])
    for key, value in wanted.items():
        if key in stored and tuple(stored[key].shape) != tuple(value.shape):
            raise ValueError('Unexpected CLIP tensor size: ' + key)
    model.load_state_dict({key: stored[key] for key in wanted if key in stored}, strict=False)
    return model.eval().to('cuda', torch.float16)


def image_tokens(model, image):
    """[batch, 257, 1280]: what the video model reads of `image`, [batch, 3, height, width] with
    values from -1 to 1."""
    import torch
    import torch.nn.functional as F

    parameter = next(model.parameters())
    pixels = F.interpolate(image.float() * 0.5 + 0.5, size=(SIDE, SIDE), mode='bicubic', align_corners=False)
    mean = torch.tensor(MEAN, device=pixels.device).view(1, 3, 1, 1)
    std = torch.tensor(STD, device=pixels.device).view(1, 3, 1, 1)
    pixels = ((pixels - mean) / std).to(parameter.device, parameter.dtype)
    with torch.inference_mode():
        states = model(pixel_values=pixels, output_hidden_states=True).hidden_states
    # The embeddings, then one entry a block: the last but one is the 31st block's output.
    return states[-2]
