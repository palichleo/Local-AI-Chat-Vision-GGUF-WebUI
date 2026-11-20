"""Version 1 serial JSON-line protocol. Only protocol data reaches stdout."""

from contextlib import nullcontext, redirect_stdout
import json
import sys
import threading

from runner import warm
from runner.contracts import fields
from runner.engine import assemble, capabilities, diagnostics, frames, generate, preflight, release, unload
from runner.models.headers import unique_object

MAX_LINE = 1024 * 1024


def _keep_above(params):
    """The RAM (bytes) the machine must have available once released: the chat model's room."""
    value = params.get('keepAbove')
    if set(params) != {'keepAbove'} or type(value) not in (int, float) or not 0 <= value < 2**60:
        raise ValueError('Invalid release parameters')
    return int(value)


def serve(config, source=None, destination=None):
    source = source or sys.stdin
    destination = destination or sys.stdout

    writing = threading.Lock()

    def emit(value):
        # (One line at a time: the thread that imports the libraries may have one to say.)
        with writing:
            destination.write(json.dumps(value, ensure_ascii=False, allow_nan=False) + '\n')
            destination.flush()

    emit(dict(event='ready', protocol=1, capabilities=capabilities()))
    # Ready first, then its libraries in the background (0.6.105): the application has its answer
    # at once, and the first creation finds them imported. One every family computes with that
    # cannot be imported is said (0.6.110): the application no longer imports them all in a
    # process of its own before every start, and checks its environment again when told so.
    warm.start(config, failed=lambda name, error: emit(dict(event='libraries', error=f'{name}: {error}')))
    try:
        while True:
            # (No read in progress while the libraries are imported: on Windows they would wait for it.)
            warm.await_input(source)
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
                known = ('diagnostics', 'preflight', 'generate', 'frames', 'assemble', 'release', 'unload', 'shutdown')
                if method not in known:
                    raise ValueError('Unsupported worker method')
                if not isinstance(params, dict):
                    raise ValueError('Worker params must be an object')
                if method not in ('preflight', 'generate', 'frames', 'assemble', 'release') and params:
                    raise ValueError('This method accepts no parameters')

                def progress(**data):
                    emit(dict(event='progress', id=request_id, data=data))

                # One thread imports at a time: what the worker imports in the background stands
                # aside for a request that needs the libraries, and goes on after it.
                turn = warm.aside() if method in ('preflight', 'generate', 'frames') else nullcontext()
                with redirect_stdout(sys.stderr), turn:
                    if method == 'diagnostics':
                        result = diagnostics(config)
                    elif method == 'preflight':
                        result = preflight(params, config)
                    elif method == 'generate':
                        result = generate(params, config, progress)
                    elif method == 'frames':
                        result = frames(params, config)
                    elif method == 'assemble':
                        result = assemble(params, config, progress)
                    elif method == 'unload':
                        result = unload()
                    elif params:
                        result = release(keep_above=_keep_above(params))
                    else:
                        result = release()
                response = dict(id=request_id, result=result)
            except Exception as exc:
                _log_failure(config, method, exc)
                # Do not retain an inference traceback (and its model tensors) during cleanup.
                response = dict(id=request_id, error=dict(message=str(exc), code=_code(exc)))
            if method == 'generate':
                try:
                    with redirect_stdout(sys.stderr):
                        # What the generation left on the card for the next one stays, until
                        # the application asks for a release.
                        release(between=True)
                except Exception as exc:
                    emit(dict(id=request_id, error=dict(message=str(exc), code='GPU_RELEASE_FAILED')))
                    return
            emit(response)
            if method == 'shutdown':
                break
    finally:
        with redirect_stdout(sys.stderr):
            release()


def _code(exc):
    if _import_failed(exc):
        return 'LIBRARIES_FAILED'
    return 'INVALID_REQUEST' if isinstance(exc, (ValueError, TypeError, KeyError)) else 'GENERATION_FAILED'


def _import_failed(exc):
    """Whether a request stopped on a library that would not be imported (0.6.110): a module that is
    not there or does not open, or one whose own lines failed while it was imported (a DLL PyTorch
    cannot load is an OSError raised in the lines of its `__init__`). The application then checks
    the whole environment again (lib/generation-service.mjs), as every start did before."""
    if isinstance(exc, ImportError):
        return True
    trace = exc.__traceback__
    while trace is not None:
        if trace.tb_frame.f_code.co_name == '<module>':
            return True
        trace = trace.tb_next
    return False


def _log_failure(config, method, exc):
    """Keep the traceback of a failed request (text only) in runner-errors.log, beside the
    generation journal (the folder that holds the cache), for diagnosis."""
    import datetime
    import traceback
    from pathlib import Path

    try:
        folder = Path(config['cacheRoot']).resolve().parent
        if not folder.is_dir():
            return
        text = ''.join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        stamp = datetime.datetime.now().isoformat(timespec='seconds')
        log = folder / 'runner-errors.log'
        previous = log.read_text(encoding='utf8')[-200_000:] if log.exists() else ''
        log.write_text(previous + f'--- {stamp} {method}\n{text}\n', encoding='utf8')
    except Exception:
        pass
