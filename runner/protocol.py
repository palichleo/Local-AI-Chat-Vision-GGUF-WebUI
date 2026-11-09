"""Version 1 serial JSON-line protocol. Only protocol data reaches stdout."""

from contextlib import redirect_stdout
import json
import sys

from runner.contracts import fields
from runner.engine import capabilities, diagnostics, generate, preflight, release
from runner.models.headers import unique_object

MAX_LINE = 1024 * 1024


def serve(config, source=None, destination=None):
    source = source or sys.stdin
    destination = destination or sys.stdout

    def emit(value):
        destination.write(json.dumps(value, ensure_ascii=False, allow_nan=False) + '\n')
        destination.flush()

    emit(dict(event='ready', protocol=1, capabilities=capabilities()))
    try:
        while True:
            line = source.readline(MAX_LINE + 1)
            if not line:
                break
            request_id = None
            method = None
            response = None
            try:
                if len(line) > MAX_LINE:
                    while line and not line.endswith('\n'):
                        line = source.readline(MAX_LINE + 1)
                    raise ValueError('Worker request exceeds one MiB')
                request = json.loads(
                    line,
                    object_pairs_hook=unique_object,
                    parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Invalid JSON number: ' + value)),
                )
                fields(request, ('id', 'method', 'params'), label='request')
                request_id = request['id']
                method = request['method']
                params = request['params']
                if (
                    type(request_id) not in (str, int)
                    or isinstance(request_id, str)
                    and (not request_id or len(request_id) > 128)
                ):
                    request_id = None
                    raise ValueError('Invalid request id')
                if method not in ('diagnostics', 'preflight', 'generate', 'release', 'shutdown'):
                    raise ValueError('Unsupported worker method')
                if not isinstance(params, dict):
                    raise ValueError('Worker params must be an object')
                if method not in ('preflight', 'generate') and params:
                    raise ValueError('This method accepts no parameters')

                def progress(**data):
                    emit(dict(event='progress', id=request_id, data=data))

                with redirect_stdout(sys.stderr):
                    if method == 'diagnostics':
                        result = diagnostics(config)
                    elif method == 'preflight':
                        result = preflight(params, config)
                    elif method == 'generate':
                        result = generate(params, config, progress)
                    else:
                        result = release()
                response = dict(id=request_id, result=result)
            except Exception as exc:
                _log_failure(method, exc)
                # Do not retain an inference traceback (and its model tensors) during cleanup.
                response = dict(
                    id=request_id,
                    error=dict(
                        message=str(exc),
                        code='INVALID_REQUEST'
                        if isinstance(exc, (ValueError, TypeError, KeyError))
                        else 'GENERATION_FAILED',
                    ),
                )
            if method == 'generate':
                try:
                    with redirect_stdout(sys.stderr):
                        release()
                except Exception as exc:
                    emit(dict(id=request_id, error=dict(message=str(exc), code='GPU_RELEASE_FAILED')))
                    return
            emit(response)
            if method == 'shutdown':
                break
    finally:
        with redirect_stdout(sys.stderr):
            release()


def _log_failure(method, exc):
    """Keep the traceback of a failed request (text only) in data/runner-errors.log for diagnosis."""
    import datetime
    import traceback
    from pathlib import Path

    try:
        folder = Path(__file__).resolve().parent.parent / 'data'
        if not folder.is_dir():
            return
        text = ''.join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        stamp = datetime.datetime.now().isoformat(timespec='seconds')
        log = folder / 'runner-errors.log'
        previous = log.read_text(encoding='utf8')[-200_000:] if log.exists() else ''
        log.write_text(previous + f'--- {stamp} {method}\n{text}\n', encoding='utf8')
    except Exception:
        pass
