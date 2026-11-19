"""Worker configuration validation. Job validation lives in runner.registry (manifest driven)."""

from runner.registry import absolute, fields, number, text


path = absolute


def validate_config(config):
    # tokenizerPath is accepted from older launchers but unused: each job names its own tokenizer.
    fields(
        config,
        ('tokenizerPath', 'cacheRoot', 'outputRoot', 'manifestRoot', 'engine', 'tuned', 'cacheGiB', 'warm'),
        ('cacheRoot', 'outputRoot'),
        'worker configuration',
    )
    # `manifestRoot`: where the manifest of each creation goes (its folder of creations keeps
    # only them); without it, beside the creation, as before.
    for key in ('cacheRoot', 'outputRoot', 'manifestRoot'):
        if key in config:
            path(config[key], key)
    result = {'engine': 'int8', 'tuned': True} | config
    if result['engine'] not in ('int8', 'stream'):
        raise ValueError('Unknown engine')
    if type(result['tuned']) is not bool:
        raise ValueError('Invalid tuned flag')
    if result['tuned'] and result['engine'] != 'int8':
        raise ValueError('Tuned kernels require INT8')
    if 'cacheGiB' in result:
        number(result['cacheGiB'], 'cacheGiB', 0, 1024)
    # `warm`: the libraries of the creations imported as the worker starts (runner.warm).
    if type(result.get('warm', False)) is not bool:
        raise ValueError('Invalid warm flag')
    return result


def validate_job(job):
    from runner.registry import validate_job as validate

    return validate(job)
