"""Colour correction of a restored image against its source (resized to the same size).

Diffusion restoration sharpens details but may drift colours. Each method keeps the restored
details and takes the colours back from the source:
- lab: CIELAB histogram matching of a* and b*, and of 20 % of L* (detail stays from the output);
- wavelet: the output's high frequencies over the source's low frequencies;
- adain: per-channel mean and deviation of the source (global, the lightest touch);
- none.
All tensors are (1, 3, H, W) in [0, 1].
"""

import torch
import torch.nn.functional as F

METHODS = ('lab', 'wavelet', 'adain', 'none')
_RGB_TO_XYZ = torch.tensor(
    [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]]
)
_WHITE = torch.tensor([0.95047, 1.0, 1.08883])
_EPSILON = 6 / 29


def _to_lab(rgb):
    linear = torch.where(rgb > 0.04045, ((rgb + 0.055) / 1.055) ** 2.4, rgb / 12.92)
    xyz = torch.einsum('ij,bjhw->bihw', _RGB_TO_XYZ.to(rgb), linear) / _WHITE.to(rgb).view(1, 3, 1, 1)
    f = torch.where(xyz > _EPSILON**3, xyz.clamp_min(1e-12) ** (1 / 3), xyz / (3 * _EPSILON**2) + 4 / 29)
    return torch.stack([116 * f[:, 1] - 16, 500 * (f[:, 0] - f[:, 1]), 200 * (f[:, 1] - f[:, 2])], dim=1)


def _from_lab(lab):
    fy = (lab[:, 0] + 16) / 116
    f = torch.stack([fy + lab[:, 1] / 500, fy, fy - lab[:, 2] / 200], dim=1)
    xyz = torch.where(f > _EPSILON, f**3, 3 * _EPSILON**2 * (f - 4 / 29)) * _WHITE.to(lab).view(1, 3, 1, 1)
    linear = torch.einsum('ij,bjhw->bihw', torch.linalg.inv(_RGB_TO_XYZ).to(lab), xyz)
    rgb = torch.where(linear > 0.0031308, 1.055 * linear.clamp_min(0) ** (1 / 2.4) - 0.055, 12.92 * linear)
    return rgb.clamp(0, 1)


def _match(values, reference):
    """Histogram matching by rank: each value takes the reference value of the same quantile."""
    flat = values.flatten()
    order = flat.argsort()
    target = reference.flatten().sort().values
    if target.numel() != flat.numel():
        positions = torch.linspace(0, target.numel() - 1, flat.numel(), device=flat.device).round().long()
        target = target[positions]
    matched = torch.empty_like(flat)
    matched[order] = target
    return matched.view_as(values)


def _lab(output, source, luminance=0.8):
    out, ref = _to_lab(output), _to_lab(source)
    l_channel = out[:, 0] * luminance + _match(out[:, 0], ref[:, 0]) * (1 - luminance)
    result = torch.stack([l_channel, _match(out[:, 1], ref[:, 1]), _match(out[:, 2], ref[:, 2])], dim=1)
    return _from_lab(result)


def _blur(x, radius):
    radius = max(1, min(radius, min(x.shape[-2:]) // 8))
    kernel = torch.tensor([[1, 2, 1], [2, 4, 2], [1, 2, 1]], dtype=x.dtype, device=x.device) / 16
    kernel = kernel[None, None].repeat(x.shape[1], 1, 1, 1)
    return F.conv2d(F.pad(x, (radius,) * 4, mode='replicate'), kernel, groups=x.shape[1], dilation=radius)


def _low(x, levels=5):
    for level in range(levels):
        x = _blur(x, 2**level)
    return x


def _wavelet(output, source):
    return (output - _low(output) + _low(source)).clamp(0, 1)


def _adain(output, source):
    mean_o, std_o = output.mean((2, 3), keepdim=True), output.std((2, 3), keepdim=True) + 1e-5
    mean_s, std_s = source.mean((2, 3), keepdim=True), source.std((2, 3), keepdim=True) + 1e-5
    return ((output - mean_o) / std_o * std_s + mean_s).clamp(0, 1)


def correct(output, source, method):
    if method not in METHODS:
        raise ValueError('Unknown colour correction ' + str(method))
    if method == 'none':
        return output
    output, source = output.float(), source.float()
    return {'lab': _lab, 'wavelet': _wavelet, 'adain': _adain}[method](output, source)
