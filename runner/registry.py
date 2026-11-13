"""Generation families declared by data.

A family is ``runner/families/<name>.json`` (what it accepts, shared with the Node server)
plus ``runner/pipelines/<name>.py`` (how it runs; several families may share one module
through the manifest's ``module`` field). The module may define ``check(job, family)``
for rules that a manifest cannot express, and must define ``generate(job, config, progress)``.
Adding a family therefore never requires editing this file, the protocol or the server.

A manifest with ``"native": false`` has no module here: its jobs are run by ComfyUI, sent
by the Node server. This worker knows what such a family accepts, and never runs it.
"""

import importlib
import importlib.util
import json
import math
from pathlib import Path
import re

FAMILIES = Path(__file__).with_name('families')
NAME = re.compile(r'^[a-z][a-z0-9_]{0,39}$')
MAX_SAFE_INTEGER = 2**53 - 1
_cache = {}


def families():
    """All manifests by family name, read once per process."""
    if not _cache:
        for path in sorted(FAMILIES.glob('*.json')):
            manifest = json.loads(path.read_text(encoding='utf-8'))
            if manifest.get('family') != path.stem or not NAME.match(path.stem):
                raise ValueError(f'Family manifest {path.name} must declare family "{path.stem}"')
            _cache[path.stem] = manifest
    return _cache


def family(name):
    if not isinstance(name, str) or name not in families():
        raise ValueError('Unsupported pipeline')
    return families()[name]


def native(name):
    """Whether this worker runs the family itself."""
    return family(name).get('native', True)


def pipeline(name):
    """The module running a family: runner.pipelines.<module>, where module defaults to the family name."""
    if not native(name):
        raise ValueError(family(name)['label'] + ' is run by ComfyUI, not by this engine')
    module = family(name).get('module', name)
    if not NAME.match(module):
        raise ValueError('Invalid pipeline module for ' + name)
    return importlib.import_module('runner.pipelines.' + module)


def capabilities():
    """Readiness of each family: the packages importable in this environment, and the graphics
    card its manifest asks for (runner.hardware). Nothing is imported, no video memory is taken."""
    from runner import hardware

    result = {}
    for name, manifest in families().items():
        if not manifest.get('native', True):
            continue
        missing = [module for module in manifest.get('requires', []) if importlib.util.find_spec(module) is None]
        reason = 'Missing packages: ' + ', '.join(missing) if missing else ''
        # What the computer itself lacks is told apart: the application shows the family greyed
        # with this reason instead of leaving it out.
        lacking = '' if reason else hardware.unmet(
            manifest['label'], manifest.get('hardware'), external=manifest.get('engine') == 'external'
        )
        result[name] = dict(ready=not (reason or lacking), mediaType=manifest['mediaType'], reason=reason or lacking)
        if lacking:
            result[name]['hardware'] = True
    return result


# Generic job validation from the manifest ---------------------------------------------------


def fields(value, allowed, required=None, label='object'):
    required = allowed if required is None else required
    if not isinstance(value, dict) or value.keys() - set(allowed) or set(required) - value.keys():
        raise ValueError('Invalid ' + label + ' fields')


def text(value, label, maximum=128):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or '\0' in value:
        raise ValueError('Invalid ' + label)


def absolute(value, label):
    text(value, label, 32768)
    if not Path(value).is_absolute():
        raise ValueError(label + ' must be an absolute local path')
    return value


def number(value, label, low, high, integer=False):
    if type(value) not in ((int,) if integer else (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError('Invalid ' + label)


def matches(value, spec, label):
    """Checks one concrete value against a manifest parameter spec."""
    kind = spec['type']
    if kind == 'string':
        if not isinstance(value, str) or len(value) > spec.get('maxLength', 8000) or '\0' in value:
            raise ValueError('Invalid ' + label)
        if spec.get('nonempty') and not value.strip():
            raise ValueError(label + ' must not be empty')
    elif kind == 'boolean':
        if type(value) is not bool:
            raise ValueError(label + ' must be boolean')
    else:
        integer = kind == 'integer'
        number(value, label, spec.get('min', -math.inf), spec.get('max', math.inf), integer)
        if integer and abs(value) > MAX_SAFE_INTEGER:
            raise ValueError('Invalid ' + label)
        if spec.get('exclusiveMin') and value == spec.get('min'):
            raise ValueError(label + ' must be greater than ' + str(spec['min']))
        if spec.get('multipleOf') and value % spec['multipleOf']:
            raise ValueError(f'{label} must be a multiple of {spec["multipleOf"]}')
    if 'choices' in spec and value not in spec['choices']:
        raise ValueError(label + ' must be one of the supported values')


def validate_job(job):
    """Validates a resolved job against its family manifest, then the family's own rules."""
    required = (
        'schemaVersion',
        'id',
        'pipeline',
        'mediaType',
        'workflowId',
        'workflowDigest',
        'parameters',
        'components',
        'loras',
        'references',
    )
    fields(job, (*required, 'promptExpansion'), required, label='resolved job')
    if type(job['schemaVersion']) is not int or job['schemaVersion'] != 1:
        raise ValueError('Unsupported job schema version')
    for key in ('id', 'workflowId'):
        text(job[key], key)
    if not isinstance(job['workflowDigest'], str) or not re.fullmatch('[a-f0-9]{64}', job['workflowDigest']):
        raise ValueError('Invalid workflow digest')
    manifest = family(job['pipeline'])
    if job['mediaType'] != manifest['mediaType']:
        raise ValueError('Unsupported pipeline/media type')
    if 'promptExpansion' in job and 'promptExpansion' not in manifest.get('features', []):
        raise ValueError('Prompt expansion is not supported by ' + manifest['label'])

    specs = manifest['parameters']
    fields(job['parameters'], specs, manifest.get('requiredParameters', []), 'parameters')
    for name, value in job['parameters'].items():
        matches(value, specs[name], name)

    components = manifest['components']
    fields(job['components'], components, [k for k, v in components.items() if v.get('required')], 'components')
    for name, value in job['components'].items():
        absolute(value, name)

    loras = manifest.get('loras', {'max': 0})
    if not isinstance(job['loras'], list) or len(job['loras']) > loras['max']:
        raise ValueError('Too many LoRAs for ' + manifest['label'])
    seen = set()
    for item in job['loras']:
        fields(item, ('id', 'path', 'strength'), label='LoRA')
        text(item['id'], 'LoRA id')
        absolute(item['path'], 'LoRA path')
        matches(item['strength'], loras['strength'], 'LoRA strength')
        if item['id'] in seen:
            raise ValueError('Duplicate LoRA id')
        seen.add(item['id'])

    roles = manifest.get('roles', {})
    if not isinstance(job['references'], list):
        raise ValueError('Invalid references')
    counts = {}
    for item in job['references']:
        fields(item, ('input', 'role', 'path'), label='reference')
        text(item['input'], 'reference input')
        absolute(item['path'], 'reference path')
        if item['role'] not in roles:
            raise ValueError(f'Unsupported {manifest["label"]} reference role')
        counts[item['role']] = counts.get(item['role'], 0) + 1
        if counts[item['role']] > roles[item['role']].get('max', 1):
            raise ValueError('Too many references for role ' + item['role'])
        if roles[item['role']].get('requiresLora') and not job['loras']:
            raise ValueError(roles[item['role']]['label'] + ' requires its learned-slot LoRA')

    # A family ComfyUI runs has no module here, hence no rule beyond its manifest.
    check = getattr(pipeline(job['pipeline']), 'check', None) if native(job['pipeline']) else None
    if check:
        check(job, manifest)
    return job
