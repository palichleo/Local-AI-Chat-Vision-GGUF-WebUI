"""The validated Euler/simple sigma schedule, bounded by requested diffusion steps."""

import math


def simple_sigmas(steps, denoise, torch):
    count = steps / denoise
    if math.isfinite(count):
        total = max(steps, int(count))
    else:
        numerator, denominator = denoise.as_integer_ratio()
        total = max(steps, steps * denominator // numerator)
    grid = torch.arange(1, 10001, dtype=torch.float32) / 10000
    shifted = math.exp(1.15) / (math.exp(1.15) + (1 / grid - 1))
    return [float(shifted[-(1 + i * 10000 // total)]) for i in range(total - steps, total)] + [0.0]


def applied_denoise(denoise, has_source):
    """The denoise a job is really made with: the one asked for when there is an image to modify,
    else 1. Without an image there is nothing to keep: a lower denoise then started from zeros
    half covered with noise, and gave a washed-out picture."""
    if not 0 < denoise <= 1:
        raise ValueError('Denoise must be in (0,1]')
    return denoise if has_source else 1


def start_latents(noise, source, sigma):
    """The latents the first step reads: the image to modify (`source`, its latents) under the
    noise of the first sigma, or the noise alone without one. At a sigma of 1 (a denoise of 1)
    nothing of the image is left."""
    if source is None:
        return noise * sigma
    return noise * sigma + source * (1 - sigma)
