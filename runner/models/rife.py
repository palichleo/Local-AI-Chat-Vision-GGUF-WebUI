"""RIFE 4.2x frame interpolation (IFNet), standard and heavy variants.

Architecture after Practical-RIFE (MIT License, hzwer); see THIRD_PARTY_NOTICES.md.
Checkpoints use the ``blocks.N`` / ``encode`` layout; the feature width of the encoder
(4 channels standard, 16 heavy) is read from the weights.
"""

import torch
from torch import nn
from torch.nn import functional as F


def conv(in_channels, out_channels, stride=1):
    return nn.Sequential(nn.Conv2d(in_channels, out_channels, 3, stride, 1), nn.LeakyReLU(0.2, True))


class Head(nn.Module):
    def __init__(self, features):
        super().__init__()
        self.cnn0 = nn.Conv2d(3, 16, 3, 2, 1)
        self.cnn1 = nn.Conv2d(16, 16, 3, 1, 1)
        self.cnn2 = nn.Conv2d(16, 16, 3, 1, 1)
        self.cnn3 = nn.ConvTranspose2d(16, features, 4, 2, 1)

    def forward(self, x):
        x = F.leaky_relu(self.cnn0(x), 0.2)
        x = F.leaky_relu(self.cnn1(x), 0.2)
        x = F.leaky_relu(self.cnn2(x), 0.2)
        return self.cnn3(x)


class ResConv(nn.Module):
    def __init__(self, channels):
        super().__init__()
        self.conv = nn.Conv2d(channels, channels, 3, 1, 1)
        self.beta = nn.Parameter(torch.ones((1, channels, 1, 1)))

    def forward(self, x):
        return F.leaky_relu(self.conv(x) * self.beta + x, 0.2)


class IFBlock(nn.Module):
    def __init__(self, in_channels, channels):
        super().__init__()
        self.conv0 = nn.Sequential(conv(in_channels, channels // 2, 2), conv(channels // 2, channels, 2))
        self.convblock = nn.Sequential(*(ResConv(channels) for _ in range(8)))
        self.lastconv = nn.Sequential(nn.ConvTranspose2d(channels, 4 * 13, 4, 2, 1), nn.PixelShuffle(2))

    def forward(self, x, flow, scale):
        x = F.interpolate(x, scale_factor=1.0 / scale, mode='bilinear', align_corners=False)
        if flow is not None:
            flow = F.interpolate(flow, scale_factor=1.0 / scale, mode='bilinear', align_corners=False) / scale
            x = torch.cat((x, flow), 1)
        out = self.lastconv(self.convblock(self.conv0(x)))
        out = F.interpolate(out, scale_factor=scale, mode='bilinear', align_corners=False)
        return out[:, :4] * scale, out[:, 4:5], out[:, 5:]


def warp(image, flow):
    batch, _, height, width = flow.shape
    horizontal = torch.linspace(-1.0, 1.0, width, device=flow.device, dtype=flow.dtype)
    vertical = torch.linspace(-1.0, 1.0, height, device=flow.device, dtype=flow.dtype)
    grid = torch.stack(torch.meshgrid(vertical, horizontal, indexing='ij')[::-1], 0).expand(batch, -1, -1, -1)
    flow = torch.cat((flow[:, 0:1] / ((image.shape[3] - 1.0) / 2.0), flow[:, 1:2] / ((image.shape[2] - 1.0) / 2.0)), 1)
    return F.grid_sample(
        image, (grid + flow).permute(0, 2, 3, 1), mode='bilinear', padding_mode='border', align_corners=True
    )


class IFNet(nn.Module):
    SCALES = (16, 8, 4, 2, 1)

    def __init__(self, features=4):
        super().__init__()
        first = 3 + 3 + 2 * features + 1
        later = first + 1 + 8 + 4  # + mask, block features and the flow so far
        widths = (192, 128, 96, 64, 32)
        self.blocks = nn.ModuleList(IFBlock(first if i == 0 else later, c) for i, c in enumerate(widths))
        self.encode = Head(features)

    def forward(self, img0, img1, timestep):
        t = img0.new_full((img0.shape[0], 1, img0.shape[2], img0.shape[3]), timestep)
        f0, f1 = self.encode(img0), self.encode(img1)
        flow = mask = feat = None
        warped0, warped1 = img0, img1
        for block, scale in zip(self.blocks, self.SCALES):
            if flow is None:
                flow, mask, feat = block(torch.cat((img0, img1, f0, f1, t), 1), None, scale)
            else:
                wf0, wf1 = warp(f0, flow[:, :2]), warp(f1, flow[:, 2:4])
                delta, mask, feat = block(torch.cat((warped0, warped1, wf0, wf1, t, mask, feat), 1), flow, scale)
                flow = flow + delta
            warped0, warped1 = warp(img0, flow[:, :2]), warp(img1, flow[:, 2:4])
        mask = torch.sigmoid(mask)
        return warped0 * mask + warped1 * (1 - mask)


def load(path):
    from safetensors.torch import load_file

    weights = load_file(str(path))
    if 'encode.cnn3.weight' not in weights or 'blocks.4.lastconv.0.weight' not in weights:
        raise ValueError('Not a RIFE 4.2x checkpoint')
    model = IFNet(features=weights['encode.cnn3.weight'].shape[1])
    model.load_state_dict(weights, strict=True)
    return model.eval()


@torch.inference_mode()
def between(model, frame0, frame1, timestep):
    """Frame at ``timestep`` (0..1) between two (1, 3, H, W) frames in [0, 1]."""
    _, _, height, width = frame0.shape
    pad_h, pad_w = (-height) % 64, (-width) % 64
    if pad_h or pad_w:
        frame0 = F.pad(frame0, (0, pad_w, 0, pad_h), mode='replicate')
        frame1 = F.pad(frame1, (0, pad_w, 0, pad_h), mode='replicate')
    return model(frame0, frame1, timestep)[:, :, :height, :width].clamp_(0, 1)
