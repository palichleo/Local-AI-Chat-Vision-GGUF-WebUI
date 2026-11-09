"""CPU diagnostics/preflight and an explicit supported-family dispatch."""
import gc
import importlib.util
from pathlib import Path
import sys

from runner.contracts import validate_config, validate_job
from runner.models.headers import validate_components

PACKAGES=('torch','diffusers','transformers','accelerate','safetensors','PIL')


def capabilities():
    missing=[name for name in PACKAGES if importlib.util.find_spec(name) is None]
    return dict(krea2=dict(ready=not missing,mediaType='image',references=['img2img'],
                          reason='Missing packages: '+', '.join(missing) if missing else ''),
                ltx25=dict(ready=False,mediaType='video',reason='Native video validation pending'))


def diagnostics(config):
    torch=sys.modules.get('torch')
    return dict(protocol=1,python=sys.version.split()[0],executable=sys.executable,
                capabilities=capabilities(),tokenizerAvailable=Path(config['tokenizerPath']).is_dir(),
                torchImported=torch is not None,cudaInitialized=bool(torch and torch.cuda.is_initialized()))


def preflight(job, config):
    validate_job(job);config=validate_config(config)
    headers=validate_components(job)
    if not Path(config['tokenizerPath']).is_dir():raise ValueError('Configure an existing local tokenizer directory')
    capability=capabilities()[job['pipeline']]
    if not capability['ready']:raise RuntimeError(capability['reason'])
    if config['engine']=='int8' and importlib.util.find_spec('comfy_kitchen') is None:raise RuntimeError('Missing installed comfy-kitchen INT8 kernels')
    if config['tuned'] and importlib.util.find_spec('triton') is None:raise RuntimeError('Missing installed Triton tuned kernels')
    from runner.models.shapes import validate_shapes
    validate_shapes(headers)
    for item in job['references']:
        from PIL import Image
        with Image.open(item['path']) as image:image.verify()
    return dict(ready=True,pipeline=job['pipeline'],mediaType=job['mediaType'],references=capability['references'])


def generate(job,config,progress):
    preflight(job,config)
    from runner.pipelines.krea2 import generate as generate_image
    return generate_image(job,validate_config(config),progress)


def release():
    gc.collect()
    torch=sys.modules.get('torch')
    allocated=0
    if torch is not None and torch.cuda.is_initialized():
        torch.cuda.synchronize();torch.cuda.empty_cache()
        allocated=torch.cuda.memory_allocated()/1024**3
    if allocated:raise RuntimeError(f'GPU cleanup incomplete: {allocated:.6f} GiB still allocated')
    return dict(released=True,allocatedGiB=allocated)
