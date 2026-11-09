"""Bounded safetensors inspection without loading checkpoint data or using CUDA."""

import json
import math
from pathlib import Path
import struct

DTYPES = {
    'BOOL': 1,
    'U8': 1,
    'I8': 1,
    'F8_E4M3': 1,
    'F8_E5M2': 1,
    'I16': 2,
    'U16': 2,
    'BF16': 2,
    'F16': 2,
    'I32': 4,
    'U32': 4,
    'F32': 4,
    'I64': 8,
    'U64': 8,
    'F64': 8,
}
SIGNATURES = {
    'model': {
        'first.weight': [6144, 64],
        'last.linear.weight': [64, 6144],
        'blocks.0.attn.wq.weight': [6144, 6144],
        'txtfusion.projector.weight': [1, 12],
    },
    'textEncoder': {'model.embed_tokens.weight': [151936, 2560], 'model.layers.35.self_attn.q_norm.weight': [128]},
    'vae': {
        'encoder.conv1.weight': [96, 3, 3, 3, 3],
        'decoder.conv1.weight': [384, 16, 3, 3, 3],
        'conv2.weight': [16, 16, 1, 1, 1],
    },
}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON field: ' + key)
        result[key] = value
    return result


def header(path):
    path = Path(path)
    file_size = path.stat().st_size
    with path.open('rb') as source:
        prefix = source.read(8)
        if len(prefix) != 8:
            raise ValueError('Truncated safetensors header')
        size = struct.unpack('<Q', prefix)[0]
        if not 2 <= size <= 64 * 1024**2 or size > file_size - 8:
            raise ValueError('Invalid safetensors header size')
        value = json.loads(source.read(size), object_pairs_hook=unique_object)
    if not isinstance(value, dict):
        raise ValueError('Invalid safetensors header')
    metadata = value.get('__metadata__', {})
    if not isinstance(metadata, dict) or any(not isinstance(item, str) for item in metadata.values()):
        raise ValueError('Invalid safetensors metadata')
    entries = {key: entry for key, entry in value.items() if key != '__metadata__'}
    if not entries:
        raise ValueError('Empty safetensors checkpoint')
    for key, entry in entries.items():
        if not isinstance(entry, dict) or set(entry) != {'dtype', 'shape', 'data_offsets'}:
            raise ValueError('Invalid tensor header: ' + key)
        shape = entry['shape']
        offsets = entry['data_offsets']
        dtype = entry['dtype']
        if (
            dtype not in DTYPES
            or not isinstance(shape, list)
            or len(shape) > 8
            or any(type(n) is not int or n < 0 for n in shape)
        ):
            raise ValueError('Invalid tensor dimensions/type: ' + key)
        if not isinstance(offsets, list) or len(offsets) != 2 or any(type(n) is not int for n in offsets):
            raise ValueError('Invalid tensor offsets')
    cursor = 0
    for key, entry in sorted(entries.items(), key=lambda item: item[1]['data_offsets'][0]):
        shape = entry['shape']
        offsets = entry['data_offsets']
        dtype = entry['dtype']
        begin, end = offsets
        if begin != cursor or end - begin != math.prod(shape) * DTYPES[dtype] or end > file_size - 8 - size:
            raise ValueError('Invalid tensor data offsets: ' + key)
        cursor = end
    if cursor != file_size - 8 - size:
        raise ValueError('Unexpected safetensors trailing data')
    return value


def validate_krea2_components(job):
    """Checks Krea2 tensor signatures, INT8 scales and LoRA targets before any GPU work."""
    headers = {role: header(path) for role, path in job['components'].items()}
    for role, signature in SIGNATURES.items():
        for key, shape in signature.items():
            if headers[role].get(key, {}).get('shape') != shape:
                raise ValueError('Incompatible ' + role + ' checkpoint: ' + key)
    for role in ('model', 'textEncoder'):
        entries = headers[role]
        for key, entry in entries.items():
            if key == '__metadata__':
                continue
            if entry['dtype'] == 'I8' and key.endswith('.weight'):
                scale = entries.get(key[:-7] + '.weight_scale', {})
                if scale.get('shape') not in ([], [entry['shape'][0], 1]):
                    raise ValueError('Missing/incompatible INT8 scale: ' + key)
    for item in job['loras']:
        validate_lora(header(item['path']), headers['model'])
    return headers


def validate_lora(entries, model):
    accepted = {'__metadata__'}
    count = 0
    for key, entry in entries.items():
        if not key.endswith('.lora_A.weight'):
            continue
        stem = key.removesuffix('.lora_A.weight')
        target = stem.removeprefix('model.diffusion_model.').removeprefix('diffusion_model.') + '.weight'
        pair_key = stem + '.lora_B.weight'
        pair = entries.get(pair_key, {}).get('shape', [])
        shape = entry['shape']
        base = model.get(target, {}).get('shape', [])
        if (
            len(base) != 2
            or len(shape) != 2
            or len(pair) != 2
            or shape[0] <= 0
            or shape[0] != pair[1]
            or [pair[0], shape[1]] != base
        ):
            raise ValueError('Incompatible LoRA target/pair: ' + key)
        accepted.update((key, pair_key, stem + '.alpha'))
        count += 1
        if stem + '.alpha' in entries and math.prod(entries[stem + '.alpha']['shape']) != 1:
            raise ValueError('Invalid LoRA alpha')
    if not count or entries.keys() - accepted:
        raise ValueError('Incompatible LoRA: unsupported or orphan tensors')
