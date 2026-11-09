"""Worker methods: diagnostics, CPU preflight, generation dispatch and GPU release.

Nothing here names a family: each one is described by its manifest and implemented by
``runner.pipelines.<family>`` (see runner.registry).
"""

import gc
from pathlib import Path
import sys

from runner.contracts import validate_config
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


def generate(job, config, progress):
    preflight(job, config)
    return pipeline(job['pipeline']).generate(job, validate_config(config), progress)


def release():
    gc.collect()
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
    return dict(released=True, allocatedGiB=allocated)
