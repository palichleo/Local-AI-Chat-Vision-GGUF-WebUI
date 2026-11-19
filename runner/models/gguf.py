"""GGUF files read without llama.cpp: their header, and their tensors as plain weights.

GGUF is llama.cpp's file format; the community publishes image and video models in it, their
matrices quantised in blocks (Q8_0, Q4_K, ...). Nothing here computes with those blocks: a
tensor is read and scaled back to plain 32-bit floats, for `runner.convert` to write it again in
the format this engine computes fastest with (0.6.107). The layouts are those of ggml's
quantisation (MIT), written again for PyTorch from their description.

A header is given in the shape the engine reads safetensors headers in: each tensor's `dtype`
(its GGUF type by name), its `shape` as PyTorch orders it (GGUF lists the dimensions backwards)
and its `data_offsets`, counted from the start of the data.
"""

import struct

MAGIC = b'GGUF'
ALIGNMENT = 32
# What a metadata value is read with, by its type in the file (8: a string, 9: a list).
_SCALARS = {0: 'B', 1: 'b', 2: 'H', 3: 'h', 4: 'I', 5: 'i', 6: 'f', 7: '?', 10: 'Q', 11: 'q', 12: 'd'}
# A list longer than this is passed over (a vocabulary), not kept.
LONGEST_LIST = 4096
# A tensor's type in the file: its name, the values a block holds, the bytes a block takes.
TYPES = {
    0: ('F32', 1, 4),
    1: ('F16', 1, 2),
    30: ('BF16', 1, 2),
    2: ('Q4_0', 32, 18),
    3: ('Q4_1', 32, 20),
    6: ('Q5_0', 32, 22),
    7: ('Q5_1', 32, 24),
    8: ('Q8_0', 32, 34),
    12: ('Q4_K', 256, 144),
    13: ('Q5_K', 256, 176),
    14: ('Q6_K', 256, 210),
}
# Types that exist and are not read here, to name them in a refusal.
UNREAD = {9: 'Q8_1', 10: 'Q2_K', 11: 'Q3_K', 15: 'Q8_K', 16: 'IQ2_XXS', 17: 'IQ2_XS', 18: 'IQ3_XXS', 19: 'IQ1_S'}
UNREAD |= {20: 'IQ4_NL', 21: 'IQ3_S', 22: 'IQ2_S', 23: 'IQ4_XS', 29: 'IQ1_M', 34: 'TQ1_0', 35: 'TQ2_0'}
BLOCKS = {name: (values, size) for name, values, size in TYPES.values()}


def is_gguf(path):
    try:
        with open(path, 'rb') as handle:
            return handle.read(4) == MAGIC
    except OSError:
        return False


def _text(handle):
    (length,) = struct.unpack('<Q', handle.read(8))
    if length > 1 << 24:
        raise ValueError('Invalid GGUF text length')
    return handle.read(length).decode('utf-8', 'replace')


def _value(handle, kind):
    if kind in _SCALARS:
        code = '<' + _SCALARS[kind]
        return struct.unpack(code, handle.read(struct.calcsize(code)))[0]
    if kind == 8:
        return _text(handle)
    if kind == 9:
        inner, count = struct.unpack('<IQ', handle.read(12))
        if inner in _SCALARS and count > LONGEST_LIST:
            handle.seek(count * struct.calcsize('<' + _SCALARS[inner]), 1)
            return None
        values = [_value(handle, inner) for _ in range(count)]
        return values if count <= LONGEST_LIST else None
    raise ValueError(f'Unknown GGUF metadata type {kind}')


def header(path):
    """What a GGUF file holds: (tensors, metadata, start of the data in the file)."""
    with open(path, 'rb') as handle:
        if handle.read(4) != MAGIC:
            raise ValueError('Not a GGUF file')
        version, tensor_count, value_count = struct.unpack('<IQQ', handle.read(20))
        if version not in (2, 3) or tensor_count > 1 << 20 or value_count > 1 << 20:
            raise ValueError(f'Unsupported GGUF version {version}')
        metadata = {}
        for _ in range(value_count):
            key = _text(handle)
            (kind,) = struct.unpack('<I', handle.read(4))
            metadata[key] = _value(handle, kind)
        listed = []
        for _ in range(tensor_count):
            name = _text(handle)
            (dimensions,) = struct.unpack('<I', handle.read(4))
            if dimensions > 8:
                raise ValueError('Invalid GGUF tensor: ' + name)
            sizes = struct.unpack(f'<{dimensions}Q', handle.read(8 * dimensions))
            kind, offset = struct.unpack('<IQ', handle.read(12))
            listed.append((name, sizes, kind, offset))
        alignment = metadata.get('general.alignment') or ALIGNMENT
        start = -(-handle.tell() // alignment) * alignment
    tensors = {}
    for name, sizes, kind, offset in listed:
        shape = list(reversed(sizes))
        if kind not in TYPES:
            # Named, for the refusal to say it (see `unread`); its bytes are not located.
            tensors[name] = dict(dtype=UNREAD.get(kind, f'type {kind}'), shape=shape, data_offsets=[offset, None])
            continue
        label, values, size = TYPES[kind]
        count = 1
        for side in sizes:
            count *= side
        if count % values:
            raise ValueError('Invalid GGUF tensor size: ' + name)
        tensors[name] = dict(dtype=label, shape=shape, data_offsets=[offset, offset + count // values * size])
    return tensors, metadata, start


def unread(tensors):
    """The quantisations of a file that are not read here, by name: none when all of it is."""
    return sorted({entry['dtype'] for entry in tensors.values() if entry['dtype'] not in BLOCKS})


def refusal(kinds):
    """What the user is told of a file quantised in a way that is not read."""
    return (
        'Ce fichier GGUF est quantifié en '
        + ', '.join(kinds)
        + ', que Moodix ne lit pas. Formats lus : '
        + ', '.join(BLOCKS)
        + '.'
    )


def _halves(raw):
    """Bytes as two 16-bit floats' worth: the 16-bit float each pair of bytes spells."""
    import torch

    return raw.contiguous().view(torch.float16).float()


def _scales_k4(packed):
    """The eight 6-bit scales and the eight 6-bit minimums of a Q4_K or Q5_K super-block, from
    its 12 bytes: the first four of each in the low bits of bytes 0-7, the last four split
    between the bytes 8-11 and the two high bits of bytes 0-7."""
    import torch

    low, high = packed[:, :4], packed[:, 4:8]
    last = packed[:, 8:12]
    scales = torch.cat([low & 63, (last & 0xF) | ((low >> 6) << 4)], dim=1)
    minimums = torch.cat([high & 63, (last >> 4) | ((high >> 6) << 4)], dim=1)
    return scales.float(), minimums.float()


def dense(raw, kind, shape):
    """A tensor of a GGUF file as plain 32-bit floats: `raw` its bytes (a 1-D uint8 tensor, on
    any device), `kind` its type by name, `shape` its shape as PyTorch orders it."""
    import torch

    if not raw.numel():
        return torch.empty(shape, dtype=torch.float32, device=raw.device)
    if kind == 'F32':
        return raw.contiguous().view(torch.float32).reshape(shape)
    if kind == 'F16':
        return raw.contiguous().view(torch.float16).float().reshape(shape)
    if kind == 'BF16':
        return raw.contiguous().view(torch.bfloat16).float().reshape(shape)
    values, size = BLOCKS[kind]
    blocks = raw.reshape(-1, size)
    if kind == 'Q8_0':
        result = _halves(blocks[:, :2]) * blocks[:, 2:].contiguous().view(torch.int8).float()
    elif kind in ('Q4_0', 'Q4_1'):
        head = 2 if kind == 'Q4_0' else 4
        packed = blocks[:, head:]
        nibbles = torch.cat([packed & 0xF, packed >> 4], dim=1).float()
        if kind == 'Q4_0':
            result = _halves(blocks[:, :2]) * (nibbles - 8)
        else:
            result = _halves(blocks[:, :2]) * nibbles + _halves(blocks[:, 2:4])
    elif kind in ('Q5_0', 'Q5_1'):
        head = 2 if kind == 'Q5_0' else 4
        # The fifth bit of each of the 32 values, one bit each, low byte first.
        bits = blocks[:, head : head + 4].contiguous()
        fifth = ((bits[:, :, None] >> torch.arange(8, device=raw.device, dtype=torch.uint8)) & 1).reshape(-1, 32)
        packed = blocks[:, head + 4 :]
        quants = (torch.cat([packed & 0xF, packed >> 4], dim=1) | (fifth << 4)).float()
        if kind == 'Q5_0':
            result = _halves(blocks[:, :2]) * (quants - 16)
        else:
            result = _halves(blocks[:, :2]) * quants + _halves(blocks[:, 2:4])
    elif kind in ('Q4_K', 'Q5_K'):
        scale, minimum = _halves(blocks[:, :2]), _halves(blocks[:, 2:4])
        scales, minimums = _scales_k4(blocks[:, 4:16])
        if kind == 'Q4_K':
            packed = blocks[:, 16:144].reshape(-1, 4, 32)
            quants = torch.stack([packed & 0xF, packed >> 4], dim=2)
        else:
            # The fifth bit of the eight sub-blocks' values: one bit a sub-block in each of 32 bytes.
            bits = blocks[:, 16:48]
            fifth = (bits[:, None, :] >> torch.arange(8, device=raw.device, dtype=torch.uint8)[None, :, None]) & 1
            packed = blocks[:, 48:176].reshape(-1, 4, 32)
            quants = torch.stack([packed & 0xF, packed >> 4], dim=2) | (fifth.reshape(-1, 4, 2, 32) << 4)
        # Eight sub-blocks of 32 values: value = scale * sub-scale * quant - minimum * sub-minimum.
        quants = quants.reshape(-1, 8, 32).float()
        result = (scale * scales)[:, :, None] * quants - (minimum * minimums)[:, :, None]
    elif kind == 'Q6_K':
        low, high = blocks[:, :128].reshape(-1, 2, 2, 32), blocks[:, 128:192].reshape(-1, 2, 1, 32)
        scales = blocks[:, 192:208].contiguous().view(torch.int8).float()
        scale = _halves(blocks[:, 208:210])
        # Two halves of 128 values; in each, four runs of 32: the low four bits from `low`
        # (its low nibbles then its high ones), the two high bits from `high`, two bits a run.
        nibbles = torch.cat([low & 0xF, low >> 4], dim=2)
        shifts = torch.tensor([0, 2, 4, 6], device=raw.device, dtype=torch.uint8)[None, None, :, None]
        quants = (nibbles | (((high >> shifts) & 3) << 4)).float() - 32
        # Sixteen sub-blocks of 16 values, each with its own scale.
        result = (scale * scales)[:, :, None] * quants.reshape(-1, 16, 16)
    else:
        raise ValueError('Unsupported GGUF type ' + kind)
    return result.reshape(shape)


class Reader:
    """A GGUF file, its tensors read one at a time as plain weights."""

    def __init__(self, path):
        import numpy

        self.path = path
        self.tensors, self.metadata, self.start = header(path)
        self.mapped = numpy.memmap(path, dtype=numpy.uint8, mode='r')

    def keys(self):
        return list(self.tensors)

    def raw(self, key, device='cpu'):
        """The bytes of a tensor as the file stores them."""
        import torch

        first, last = self.tensors[key]['data_offsets']
        return torch.from_numpy(self.mapped[self.start + first : self.start + last].copy()).to(device)

    def get_tensor(self, key, device='cpu'):
        entry = self.tensors[key]
        return dense(self.raw(key, device), entry['dtype'], entry['shape'])

    def close(self):
        self.mapped = None
