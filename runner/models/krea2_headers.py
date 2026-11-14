"""Krea 2 checkpoint checks: tensor signatures, INT8 scales and LoRA targets (was part of headers.py)."""

from runner.models.headers import header
from runner.models.lora_keys import validate_lora

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


def validate_krea2_components(job):
    """Checks Krea2 tensor signatures, INT8 scales and LoRA targets before any GPU work."""
    # The tokenizer is a folder, not a checkpoint: it is checked by preflight and the pipeline.
    headers = {role: header(path) for role, path in job['components'].items() if role != 'tokenizer'}
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
