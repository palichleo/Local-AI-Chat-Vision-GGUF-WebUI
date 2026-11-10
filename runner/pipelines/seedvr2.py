"""SeedVR2 7B image upscaling: Lanczos enlargement, one-step diffusion restoration, colour
correction against the enlarged source. Several passes repeat the whole (the model chooses).

One pass: resize the image by `scale` (Lanczos), pad to a multiple of 16, encode with the VAE,
denoise once from pure noise conditioned on that latent (t = 1000, v-prediction on a linear
schedule), decode, crop, then correct colours against the resized source.
"""

import time

MAX_SIDE = 8192
T = 1000.0


def check(job, family):
    p = job['parameters']
    if p.get('passes', 1) > 1 and p.get('scale', 2) ** p['passes'] > 16:
        raise ValueError('SeedVR2 would enlarge more than 16 times; use fewer passes or a smaller scale')


def _sizes(width, height, parameters):
    """Size after each pass; the last pass is reduced to max_side if needed."""
    scale, passes, max_side = parameters.get('scale', 2), parameters.get('passes', 1), parameters.get('max_side', 0)
    sizes = []
    for _ in range(passes):
        width, height = round(width * scale), round(height * scale)
        sizes.append((width, height))
    limit = min(max_side or MAX_SIDE, MAX_SIDE)
    width, height = sizes[-1]
    if max(width, height) > limit:
        ratio = limit / max(width, height)
        sizes[-1] = (max(16, round(width * ratio)), max(16, round(height * ratio)))
    return sizes


def preflight(job, config):
    from PIL import Image

    from runner.models import seedvr2, seedvr2_vae
    from runner.models.headers import header

    if not seedvr2.signature(header(job['components']['model'])):
        raise ValueError('Ce fichier n’est pas un DiT SeedVR2 7B.')
    if not seedvr2_vae.signature(header(job['components']['vae'])):
        raise ValueError('Ce fichier n’est pas le VAE de SeedVR2 (ema_vae_fp16).')
    with Image.open(job['references'][0]['path']) as image:
        _sizes(*image.size, job['parameters'])


def generate(job, config, progress):
    import numpy as np
    import torch
    from PIL import Image

    from runner.media import save_image
    from runner.models import seedvr2, seedvr2_color, seedvr2_vae
    from runner.models.ltx25 import WeightPool
    from runner.models.residency import RESIDENCY, open_store

    if not torch.cuda.is_available():
        raise RuntimeError('SeedVR2 requires CUDA')
    start = time.perf_counter()
    torch.cuda.reset_peak_memory_stats()
    p = job['parameters']
    steps, method, seed = p.get('steps', 1), p.get('color_correction', 'lab'), p['seed']
    with Image.open(job['references'][0]['path']) as image:
        current = image.convert('RGB')
    source_size = current.size
    sizes = _sizes(*current.size, p)
    progress(stage='loading upscaler')
    vae = seedvr2_vae.load(job['components']['vae'])
    total = len(sizes) * seedvr2.LAYERS * steps
    done = 0
    timeline = []
    with open_store(job['components']['model']) as store, torch.inference_mode():
        budget = min(config.get('cacheGiB', 6), max(0, torch.cuda.mem_get_info()[0] / 1024**3 - 4))
        pool = WeightPool({'model': store}, budget)
        try:
            dit = seedvr2.load(store, pool)
            text = seedvr2.positive_text(store)
            for index, (width, height) in enumerate(sizes):
                resized = current.resize((width, height), Image.LANCZOS)
                reference = torch.from_numpy(np.asarray(resized)).to('cuda').permute(2, 0, 1)[None].float() / 255
                pad_h, pad_w = -height % 16, -width % 16
                pixels = torch.nn.functional.pad(reference, (0, pad_w, 0, pad_h)) * 2 - 1
                progress(stage='encoding', step=done, total=total)
                latent = seedvr2_vae.tiled(vae.encode, pixels.to(torch.bfloat16), 1 / 8, 2048, 128)
                latent = latent[0].permute(1, 2, 0)[None].to(torch.bfloat16)  # (1, h, w, 16)
                condition = torch.cat([latent, torch.ones_like(latent[..., :1])], dim=-1)
                generator = torch.Generator('cuda').manual_seed(seed + index)
                x = torch.randn(latent.shape, generator=generator, device='cuda', dtype=torch.bfloat16)
                times = [T * (1 - i / steps) for i in range(steps)]
                for step, t in enumerate(times):

                    def report(block, blocks, base=done):
                        progress(stage='upscaling', step=base + block, total=total)

                    v = dit(torch.cat([x, condition], dim=-1), text, torch.tensor(t, device='cuda'), report)
                    x0 = x - (t / T) * v  # v-prediction on x_t = (1 - t/T) x0 + (t/T) noise
                    if step + 1 < steps:
                        s = times[step + 1]
                        noise = x + (1 - t / T) * v
                        x = (1 - s / T) * x0 + (s / T) * noise
                    else:
                        x = x0
                    done += seedvr2.LAYERS
                progress(stage='decoding', step=done, total=total)
                decoded = seedvr2_vae.tiled(vae.decode, x[0].permute(2, 0, 1)[None], 8, 256, 16)
                decoded = ((decoded[:, :, :height, :width].float() + 1) / 2).clamp(0, 1)
                corrected = seedvr2_color.correct(decoded, reference, method)
                current = Image.fromarray(
                    (corrected[0].permute(1, 2, 0) * 255).round().to(torch.uint8).cpu().numpy()
                )
                timeline.append(dict(pass_=index + 1, size=[width, height], seconds=round(time.perf_counter() - start, 2)))
                del latent, condition, x, decoded, corrected, reference, pixels
            cache = dict(gpu_cache_gib=round(pool.bytes / 1024**3, 3), residency=RESIDENCY.summary())
            del dit
        finally:
            pool.clear()
    del vae
    torch.cuda.empty_cache()
    output = np.asarray(current)
    metadata = dict(
        job=job,
        backend='pytorch-seedvr2-7b',
        source=list(source_size),
        passes=len(sizes),
        steps=steps,
        color_correction=method,
        seconds=round(time.perf_counter() - start, 2),
        peak_vram_gib=round(torch.cuda.max_memory_allocated() / 1024**3, 3),
        timeline=timeline,
        weight_cache=cache,
    )
    return save_image(output, config, job, metadata)
