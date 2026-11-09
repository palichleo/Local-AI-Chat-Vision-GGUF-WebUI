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
    video_missing=missing+[name for name in ('triton','imageio','imageio_ffmpeg','av','comfy_kitchen') if importlib.util.find_spec(name) is None]
    return dict(krea2=dict(ready=not missing,mediaType='image',references=['img2img'],
                          reason='Missing packages: '+', '.join(missing) if missing else ''),
                ltx25=dict(ready=not video_missing,mediaType='video',references=['start_image','end_image','msr_image','source_video'],audio=True,
                    components=['model','textEncoder','vae','audioVae'],requiredComponents=['audioVae'],
                    parameters=['prompt','seed','width','height','steps','frames','fps','stage','audio','cfg','negative_prompt','start_strength','end_strength','image_compression','overlap_frames','msr_frames','msr_strength'],
                    parameterValues=dict(steps=[8],cfg=[1],negative_prompt=['']),
                    reason='Missing packages: '+', '.join(video_missing) if video_missing else ''))


def diagnostics(config):
    torch=sys.modules.get('torch')
    return dict(protocol=1,python=sys.version.split()[0],executable=sys.executable,
                capabilities=capabilities(),tokenizerAvailable=Path(config['tokenizerPath']).is_dir(),
                torchImported=torch is not None,cudaInitialized=bool(torch and torch.cuda.is_initialized()))


def preflight(job, config):
    validate_job(job);config=validate_config(config)
    headers=validate_components(job)
    if job['pipeline']=='krea2' and not Path(config['tokenizerPath']).is_dir():raise ValueError('Configure an existing local tokenizer directory')
    capability=capabilities()[job['pipeline']]
    if not capability['ready']:raise RuntimeError(capability['reason'])
    if config['engine']=='int8' and importlib.util.find_spec('comfy_kitchen') is None:raise RuntimeError('Missing installed comfy-kitchen INT8 kernels')
    if config['tuned'] and importlib.util.find_spec('triton') is None:raise RuntimeError('Missing installed Triton tuned kernels')
    if job['pipeline']=='krea2':
        from runner.models.shapes import validate_shapes
        validate_shapes(headers)
    for item in job['references']:
        if item['role']=='source_video':
            from runner.video.continuation import source_tail
            source_tail(item['path'],job['parameters']);continue
        from PIL import Image
        with Image.open(item['path']) as image:image.verify()
    return dict(ready=True,pipeline=job['pipeline'],mediaType=job['mediaType'],references=capability['references'])


def generate(job,config,progress):
    preflight(job,config)
    if job['pipeline']=='ltx25':
        from runner.pipelines.ltx25 import generate as generate_video
        return generate_video(job,validate_config(config),progress)
    from runner.pipelines.krea2 import generate as generate_image
    return generate_image(job,validate_config(config),progress)


def release():
    gc.collect()
    torch=sys.modules.get('torch')
    allocated=0
    if torch is not None and torch.cuda.is_initialized():
        torch.cuda.synchronize()
        # PyTorch retains an 8 MiB cuBLAS scratch buffer after all model tensors have been freed.
        clear_blas=getattr(torch._C,'_cuda_clearCublasWorkspaces',None)
        if clear_blas is not None:clear_blas()
        torch.cuda.empty_cache()
        allocated=torch.cuda.memory_allocated()/1024**3
    if allocated:raise RuntimeError(f'GPU cleanup incomplete: {allocated:.6f} GiB still allocated')
    return dict(released=True,allocatedGiB=allocated)
