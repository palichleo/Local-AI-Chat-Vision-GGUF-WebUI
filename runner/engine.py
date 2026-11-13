"""Worker methods: diagnostics, CPU preflight, generation dispatch and GPU release.

Nothing here names a family: each one is described by its manifest and implemented by
``runner.pipelines.<family>`` (see runner.registry).
"""

import gc
from pathlib import Path
import sys

from runner.contracts import validate_config
from runner.journal import Journal
from runner.registry import capabilities, family, pipeline, validate_job


def diagnostics(config):
    torch = sys.modules.get('torch')
    return dict(
        protocol=1,
        python=sys.version.split()[0],
        executable=sys.executable,
        capabilities=capabilities(),
        torchImported=torch is not None,
        cudaInitialized=bool(torch and torch.cuda.is_initialized()),
    )


def _check_reference(item, media):
    if media == 'image':
        from PIL import Image

        with Image.open(item['path']) as image:
            image.verify()
    elif not Path(item['path']).is_file():
        raise ValueError('Reference ' + item['input'] + ' is not a readable file')


def preflight(job, config):
    """Everything that can fail without the GPU fails here, before the chat model is unloaded."""
    validate_job(job)
    config = validate_config(config)
    manifest = family(job['pipeline'])
    capability = capabilities()[job['pipeline']]
    if not capability['ready']:
        raise RuntimeError(capability['reason'])
    module = pipeline(job['pipeline'])
    if hasattr(module, 'preflight'):
        module.preflight(job, config)
    for item in job['references']:
        _check_reference(item, manifest['roles'][item['role']]['media'])
    return dict(ready=True, pipeline=job['pipeline'], mediaType=job['mediaType'])


VRAM_MARGIN = 1024**3


def _vram_ceiling(torch, margin=VRAM_MARGIN):
    """Keep PyTorch inside the video memory that is free now, less a margin.

    PyTorch keeps freed blocks for reuse and takes new ones while the driver gives any. On
    Windows the driver never refuses: past the card's own memory it hands out system RAM, and
    every step then runs two to three times slower. Under a ceiling PyTorch reuses what it
    holds instead. Returns whether a ceiling was set.
    """
    if torch is None or not torch.cuda.is_available():
        return False
    free, total = torch.cuda.mem_get_info()
    if free - margin < total * 0.25:  # too little is free for a ceiling to help
        return False
    torch.cuda.set_per_process_memory_fraction((free - margin) / total)
    return True


def generate(job, config, progress):
    preflight(job, config)
    module, config = pipeline(job['pipeline']), validate_config(config)
    journal = Journal(config, job)

    def report(**data):
        # The picture so far is for the page: kilobytes at every step, nothing to diagnose.
        if 'preview' not in data:
            journal.write(**data)
        progress(**data)

    try:
        import torch
    except ImportError:
        torch = None
    try:
        if not _vram_ceiling(torch):
            result = module.generate(job, config, report)
        else:
            try:
                result = module.generate(job, config, report)
            except torch.OutOfMemoryError as error:
                # Left below, once the failed attempt's tensors are out of scope.
                result = None
                journal.write(event='out of video memory under the ceiling', error=str(error)[:300])
            finally:
                torch.cuda.set_per_process_memory_fraction(1.0)
            if result is None:
                # This job needs more than the card has free: better slow than failed, so run
                # it again without the ceiling, as before.
                gc.collect()
                torch.cuda.empty_cache()
                report(stage='retrying without the video memory ceiling')
                result = module.generate(job, config, report)
    except BaseException as error:
        journal.write(event='failed', error=f'{type(error).__name__}: {error}'[:500])
        raise
    journal.write(event='done')
    return result


def unload():
    """Everything the worker keeps between generations leaves RAM and VRAM: the model files
    held in RAM (and pinned for fast transfers), then the GPU allocator's cache."""
    residency = sys.modules.get('runner.models.residency')
    freed = 0.0
    if residency is not None:
        freed = sum(arena.size for arena in residency.RESIDENCY.arenas.values()) / 1024**3
        residency.RESIDENCY.clear()
    return dict(release(), freedRamGiB=round(freed, 2))


def release(keep_above=None):
    """The GPU's memory goes back to the driver. With `keep_above` (bytes) the chat model is about
    to load: the model files kept in RAM between generations leave, least recently used first,
    until the machine has that much available (see Residency.leave_room)."""
    gc.collect()
    freed = 0
    if keep_above:
        residency = sys.modules.get('runner.models.residency')
        if residency is not None:
            freed = residency.RESIDENCY.leave_room(keep_above)
    torch = sys.modules.get('torch')
    allocated = 0
    if torch is not None and torch.cuda.is_initialized():
        torch.cuda.synchronize()
        # PyTorch retains an 8 MiB cuBLAS scratch buffer after all model tensors have been freed.
        clear_blas = getattr(torch._C, '_cuda_clearCublasWorkspaces', None)
        if clear_blas is not None:
            clear_blas()
        torch.cuda.empty_cache()
        allocated = torch.cuda.memory_allocated() / 1024**3
    if allocated:
        raise RuntimeError(f'GPU cleanup incomplete: {allocated:.6f} GiB still allocated')
    if keep_above:
        return dict(released=True, allocatedGiB=allocated, freedRamGiB=round(freed / 1024**3, 2))
    return dict(released=True, allocatedGiB=allocated)
