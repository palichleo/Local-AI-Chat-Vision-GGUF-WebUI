"""Worker configuration validation. Job validation lives in runner.registry (manifest driven)."""

from runner.registry import absolute, fields, number, text


path = absolute


def validate_config(config):
    fields(
        config,
        ('tokenizerPath', 'cacheRoot', 'outputRoot', 'engine', 'tuned', 'cacheGiB'),
        ('tokenizerPath', 'cacheRoot', 'outputRoot'),
        'worker configuration',
    )
    for key in ('tokenizerPath', 'cacheRoot', 'outputRoot'):
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
    return result


def validate_job(job):
    from runner.registry import validate_job as validate

    return validate(job)
