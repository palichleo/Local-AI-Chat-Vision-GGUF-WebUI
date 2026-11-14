"""What SCAIL-2 is given: the reference, the driving video, their identity masks, the steps.

Written after the official implementation (github.com/zai-org/SCAIL-2, Apache-2.0,
`wan/scail.py` and `wan/utils/scail_utils.py`). Pictures are tensors from -1 to 1, channels
first: an image [3, height, width], a video [frames, 3, height, width].

The masks are pictures in flat colours. Black hides what is behind it, white shows it, and each
of six colours marks a character: the same colour in the mask of the reference and in the mask
of the driving video binds the character to draw to the person to follow.
"""

import math

# A colour channel counts as lit from 225 of 255.
LIT = (225.0 - 127.5) / 127.5
SEGMENT = 81  # frames a segment
OVERLAP = 5  # frames of a segment kept from the one before


def plan(frames, segment=SEGMENT, overlap=OVERLAP):
    """[(first frame, frames)]: the segments of a video of `frames` frames (4n + 1). Each one
    after the first starts on the last `overlap` frames of the one before, which it is given
    and does not draw again; the last one is as long as what is left."""
    if frames % 4 != 1 or segment % 4 != 1 or overlap % 4 != 1 or not overlap < segment:
        raise ValueError('SCAIL-2 reads 4n + 1 frames')
    found, first = [], 0
    while True:
        count = min(segment, frames - first)
        found.append((first, count))
        if first + count >= frames:
            return found
        first += segment - overlap


def tokens(frames, height, width):
    """Tokens of a segment: the reference, the video, the pose at half its size."""
    grid = (height // 16) * (width // 16)
    latent = (frames - 1) // 4 + 1
    return grid + latent * grid + latent * (height // 32) * (width // 32)


def cover(pictures, width, height, flat=False):
    """The pictures resized to fill width x height, what overflows cut equally on both sides.
    `flat` for a mask: its colours are kept as they are, none blended with its neighbour."""
    import torch.nn.functional as F

    single = pictures.ndim == 3
    batch = pictures[None] if single else pictures
    scale = max(width / batch.shape[-1], height / batch.shape[-2])
    size = (max(height, round(batch.shape[-2] * scale)), max(width, round(batch.shape[-1] * scale)))
    if flat:
        resized = F.interpolate(batch.float(), size=size, mode='nearest')
    else:
        resized = F.interpolate(batch.float(), size=size, mode='bicubic', align_corners=False).clamp(-1, 1)
    top, left = (size[0] - height) // 2, (size[1] - width) // 2
    cut = resized[..., top : top + height, left : left + width]
    return cut[0] if single else cut


def matte(reference, mask):
    """The reference on black wherever its mask marks no character: the one to draw is shown
    alone, as the model was given it to replace a character."""
    import torch

    shown = (mask > LIT).any(dim=-3, keepdim=True)
    return torch.where(shown, reference, torch.full_like(reference, -1.0))


def halved(video):
    """A video at half its width and height, as the pose and its masks are given."""
    import torch.nn.functional as F

    return F.interpolate(video.float(), scale_factor=0.5, mode='bilinear', align_corners=False)


def mask_latents(masks):
    """[28, latent frames, height / 8, width / 8]: coloured masks, [frames, 3, height, width],
    as the model reads them. Seven channels a frame (white, red, green, blue, yellow, magenta,
    cyan; black is none), each the share of its colour in an 8 x 8 square; four frames a latent
    frame, the first frame standing for the four of the first one."""
    import torch
    import torch.nn.functional as F

    red, green, blue = (masks[:, index : index + 1] > LIT for index in range(3))
    colours = torch.cat(
        [
            red & green & blue,
            red & ~green & ~blue,
            ~red & green & ~blue,
            ~red & ~green & blue,
            red & green & ~blue,
            red & ~green & blue,
            ~red & green & blue,
        ],
        dim=1,
    ).float()
    height, width = masks.shape[-2:]
    for _ in range(3):
        height, width = math.ceil(height / 2), math.ceil(width / 2)
    small = F.interpolate(colours, size=(height, width), mode='area')
    frames = torch.cat([small[:1].expand(3, -1, -1, -1), small], dim=0)
    if frames.shape[0] % 4:
        raise ValueError('SCAIL-2 reads 4n + 1 frames')
    # [latent frames, 4 frames x 7 colours, height, width] -> channels first.
    return frames.reshape(-1, 28, height, width).permute(1, 0, 2, 3)


def given(latents, value=1.0):
    """Latents [16, frames, height, width] with the four channels that say what is given: ones
    for the reference and the pose, the frames kept from an earlier segment for the video."""
    import torch

    marks = torch.full((4, *latents.shape[1:]), value, device=latents.device, dtype=latents.dtype)
    return torch.cat([latents, marks], dim=0)


def sigmas(steps, shift):
    """The noise levels of `steps` steps, from 1 down to 0, evenly spaced then moved by `shift`
    towards the noisy end: s -> shift * s / (1 + (shift - 1) * s)."""
    levels = [1 - index / steps for index in range(steps)]
    return [shift * level / (1 + (shift - 1) * level) for level in levels] + [0.0]
