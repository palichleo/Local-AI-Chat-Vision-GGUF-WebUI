"""The picture a generation has so far, sent to the page at every step while it samples.

The model's estimate of the finished latent is turned into colours by one linear map (a weight
per latent channel and colour, plus a bias), at the latent's own resolution and without the
VAE: no video memory, a few milliseconds, a few kilobytes of JPEG. The page shows it under the
moving background of a generation, as it shows ComfyUI's.

The maps were fitted for Atelier by least squares, on pictures it had generated: each one
encoded by the model's VAE, against the same picture averaged to the latent's resolution, in
[-1, 1]. They reproduce the colours of pictures left out of the fit with R² 0.94 to 0.97.
"""

import base64
import io
import sys

# Krea 2's latent (16 channels, normalised by the VAE's mean and deviation, as it is sampled):
# fitted on 59 images through krea2RealVae_v10 (Qwen-Image's VAE).
KREA2 = (
    (
        (-0.0270, -0.0001, 0.3695),
        (-0.0192, -0.0333, -0.0116),
        (0.2114, 0.1388, 0.0940),
        (0.2519, 0.3571, 0.2500),
        (-0.0242, -0.0366, -0.0306),
        (0.0868, -0.0577, -0.0338),
        (-0.2053, -0.2750, -0.1320),
        (-0.0866, 0.0200, 0.0579),
        (-0.2747, -0.2591, -0.3597),
        (-0.1147, 0.0591, 0.1621),
        (0.0040, 0.1874, 0.1060),
        (0.0099, 0.0611, 0.0449),
        (-0.1243, 0.0264, 0.0896),
        (-0.0139, -0.0593, -0.0381),
        (0.2678, 0.1195, 0.2330),
        (0.0778, -0.0031, -0.0024),
    ),
    (-0.2394, -0.2247, -0.3832),
)

# MiniMax-H3's video latent (24 channels, normalised): fitted on 201 pictures (two frames of each
# of 71 generated videos, 59 generated images), each held still for 22 frames and encoded as a
# video by minimax_h3_video_vae, every latent frame against the picture.
MINIMAX_H3 = (
    (
        (-0.1407, -0.2069, -0.2259),
        (0.1032, 0.1296, 0.0725),
        (0.2656, 0.1832, 0.0434),
        (0.2089, 0.0614, -0.2119),
        (0.0933, 0.1392, -0.0441),
        (0.1104, 0.0858, -0.0269),
        (0.0622, 0.0432, 0.0531),
        (0.0648, 0.0648, 0.0416),
        (0.0427, 0.0571, 0.0648),
        (0.3029, 0.2153, 0.2143),
        (-0.1122, -0.1079, -0.0534),
        (-0.0834, -0.0574, 0.0004),
        (0.0417, 0.0284, 0.0573),
        (-0.0138, 0.0099, 0.0069),
        (0.0106, 0.0252, 0.0563),
        (-0.0078, -0.0175, -0.0482),
        (-0.0026, -0.0003, -0.0042),
        (-0.0629, -0.0649, -0.0458),
        (-0.0428, -0.0384, -0.0367),
        (0.0771, 0.0755, 0.0816),
        (0.0270, 0.0125, 0.0016),
        (-0.0275, -0.0243, -0.0252),
        (-0.0065, 0.0149, 0.0282),
        (-0.0281, -0.0304, -0.0186),
    ),
    (0.1281, 0.0531, 0.0085),
)

# JPEG quality: the picture is small and shown enlarged, under the background and a grain.
QUALITY = 85


def picture(latent, colours):
    """One latent (channels, height, width) as the model samples it, in colours: a JPEG,
    {'mime': 'image/jpeg', 'data': base64}."""
    import torch
    from PIL import Image

    factors, bias = colours
    weight = torch.tensor(factors, dtype=torch.float32, device=latent.device)
    if latent.shape[0] != weight.shape[0]:
        raise ValueError(f'A preview of {weight.shape[0]} channels, not {latent.shape[0]}')
    rgb = torch.einsum('chw,cr->hwr', latent.float(), weight) + torch.tensor(bias, device=latent.device)
    pixels = ((rgb.clamp(-1, 1) + 1) * 127.5).round().byte().cpu().numpy()
    buffer = io.BytesIO()
    Image.fromarray(pixels).save(buffer, format='JPEG', quality=QUALITY)
    return dict(mime='image/jpeg', data=base64.b64encode(buffer.getvalue()).decode('ascii'))


def send(progress, colours, finished, *values):
    """Sends the picture so far through `progress`, `finished(*values)` giving the latent. A
    preview that fails is only reported on stderr: the generation goes on without it."""
    try:
        progress(preview=picture(finished(*values), colours))
    except Exception as error:
        print(f'Preview skipped: {type(error).__name__}: {error}', file=sys.stderr)
