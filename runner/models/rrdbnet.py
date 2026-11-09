"""RRDBNet, the Real-ESRGAN super-resolution network.

Architecture after Real-ESRGAN / BasicSR (BSD-3-Clause, Xintao Wang); see THIRD_PARTY_NOTICES.md.
The layout (scale, width, depth) is read from the checkpoint, so x1, x2 and x4 models load alike.
"""

import re

import torch
from torch import nn
from torch.nn import functional as F


class DenseBlock(nn.Module):
    def __init__(self, features, growth):
        super().__init__()
        self.conv1 = nn.Conv2d(features, growth, 3, 1, 1)
        self.conv2 = nn.Conv2d(features + growth, growth, 3, 1, 1)
        self.conv3 = nn.Conv2d(features + 2 * growth, growth, 3, 1, 1)
        self.conv4 = nn.Conv2d(features + 3 * growth, growth, 3, 1, 1)
        self.conv5 = nn.Conv2d(features + 4 * growth, features, 3, 1, 1)

    def forward(self, x):
        x1 = F.leaky_relu(self.conv1(x), 0.2)
        x2 = F.leaky_relu(self.conv2(torch.cat((x, x1), 1)), 0.2)
        x3 = F.leaky_relu(self.conv3(torch.cat((x, x1, x2), 1)), 0.2)
        x4 = F.leaky_relu(self.conv4(torch.cat((x, x1, x2, x3), 1)), 0.2)
        return self.conv5(torch.cat((x, x1, x2, x3, x4), 1)) * 0.2 + x


class RRDB(nn.Module):
    def __init__(self, features, growth):
        super().__init__()
        self.rdb1 = DenseBlock(features, growth)
        self.rdb2 = DenseBlock(features, growth)
        self.rdb3 = DenseBlock(features, growth)

    def forward(self, x):
        return self.rdb3(self.rdb2(self.rdb1(x))) * 0.2 + x


class RRDBNet(nn.Module):
    def __init__(self, scale, features=64, blocks=23, growth=32):
        super().__init__()
        self.scale = scale
        unshuffle = {4: 1, 2: 2, 1: 4}[scale]
        self.unshuffle = unshuffle
        self.conv_first = nn.Conv2d(3 * unshuffle * unshuffle, features, 3, 1, 1)
        self.body = nn.Sequential(*(RRDB(features, growth) for _ in range(blocks)))
        self.conv_body = nn.Conv2d(features, features, 3, 1, 1)
        self.conv_up1 = nn.Conv2d(features, features, 3, 1, 1)
        self.conv_up2 = nn.Conv2d(features, features, 3, 1, 1)
        self.conv_hr = nn.Conv2d(features, features, 3, 1, 1)
        self.conv_last = nn.Conv2d(features, 3, 3, 1, 1)

    def forward(self, x):
        feat = F.pixel_unshuffle(x, self.unshuffle) if self.unshuffle > 1 else x
        feat = self.conv_first(feat)
        feat = feat + self.conv_body(self.body(feat))
        feat = F.leaky_relu(self.conv_up1(F.interpolate(feat, scale_factor=2, mode='nearest')), 0.2)
        feat = F.leaky_relu(self.conv_up2(F.interpolate(feat, scale_factor=2, mode='nearest')), 0.2)
        return self.conv_last(F.leaky_relu(self.conv_hr(feat), 0.2))


def state_dict(path):
    """Loads a .pth or .safetensors Real-ESRGAN checkpoint without executing pickled code."""
    if str(path).endswith('.safetensors'):
        from safetensors.torch import load_file

        weights = load_file(str(path))
    else:
        weights = torch.load(str(path), map_location='cpu', weights_only=True)
    for key in ('params_ema', 'params'):
        if isinstance(weights.get(key), dict):
            weights = weights[key]
    return weights


def layout(weights):
    """(scale, features, blocks, growth) of an RRDBNet state dict, or ValueError."""
    first = weights.get('conv_first.weight')
    if first is None or 'conv_last.weight' not in weights or 'body.0.rdb1.conv1.weight' not in weights:
        raise ValueError('Not a Real-ESRGAN (RRDBNet) checkpoint')
    scale = {3: 4, 12: 2, 48: 1}.get(first.shape[1])
    if scale is None:
        raise ValueError('Unsupported Real-ESRGAN input layout')
    blocks = 1 + max(int(match.group(1)) for key in weights if (match := re.match(r'body\.(\d+)\.', key)))
    return scale, first.shape[0], blocks, weights['body.0.rdb1.conv1.weight'].shape[0]


def load(path):
    weights = state_dict(path)
    scale, features, blocks, growth = layout(weights)
    model = RRDBNet(scale, features, blocks, growth)
    model.load_state_dict(weights, strict=True)
    return model.eval()


@torch.inference_mode()
def upscale(model, image, tile=512, overlap=16):
    """Upscales a (1, 3, H, W) tensor in [0, 1], in overlapping tiles to bound memory."""
    scale = model.scale
    _, _, height, width = image.shape
    if not tile or (height <= tile and width <= tile):
        return model(image).clamp_(0, 1)
    output = image.new_zeros((1, 3, height * scale, width * scale))
    for top in range(0, height, tile):
        for left in range(0, width, tile):
            y0, x0 = max(top - overlap, 0), max(left - overlap, 0)
            y1, x1 = min(top + tile + overlap, height), min(left + tile + overlap, width)
            result = model(image[:, :, y0:y1, x0:x1])
            # Keep only the tile's own area; the overlap only gives the network context.
            oy, ox = (top - y0) * scale, (left - x0) * scale
            th, tw = (min(top + tile, height) - top) * scale, (min(left + tile, width) - left) * scale
            output[:, :, top * scale : top * scale + th, left * scale : left * scale + tw] = result[
                :, :, oy : oy + th, ox : ox + tw
            ]
    return output.clamp_(0, 1)
