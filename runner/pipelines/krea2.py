"""Native Krea2 Euler/simple sampling: the weights as their file stores them, as much of them on the GPU as fits.

The model is read from its file through a RAM-resident store and a `WeightPool` (see
runner.models.pool): no copy of it is written to disk, whatever the card. What the card has free
when the job starts decides how much of the model stays there; the rest is copied in at each
step. LoRAs are applied as the layers run.
"""

from contextlib import ExitStack
import gc
from pathlib import Path
import sys
import time
from types import SimpleNamespace

from runner.media import save_image
from runner.models.headers import header
from runner.pipelines.sampling import simple_sigmas


# Video memory left beside the weights of the model, in GiB: a fixed part and what a step's own
# tensors take, which grows with the picture. Measured on a 12 GiB card at 1024 × 1024 with
# 8.3 GiB of weights kept: the step's tensors take 0.4 GiB, the allocator holds 1 GiB more than
# it has in use (the weights that do not stay pass through it), the CUDA libraries 1 GiB outside
# PyTorch, and the card was then full to the last megabyte. Half a gibibyte more is left free.
RESERVE_GIB = 2.4
RESERVE_PER_MEGAPIXEL_GIB = 0.5
# RAM the files kept between two pictures leave free, in GiB. The model (12.6 GiB in INT8) and
# its text encoder (4.9 GiB) are small beside the general reserve, which is sized for a video
# model and the chat model together: with it, a 32 GiB machine never kept this model in RAM,
# and each step paid for copies from unlocked memory (15.7 s a picture instead of 10.7 s).
RAM_RESERVE_GIB = 4

EXPANSION_LIMITS = (
    ('maxTokens', 1, 4096, True),
    ('temperature', 0, 5, False),
    ('topK', 0, 1000, True),
    ('topP', 0, 1, False),
    ('minP', 0, 1, False),
    ('repetitionPenalty', 0, 10, False),
    ('seed', 0, 2**53 - 1, True),
)


def check(job, family):
    """Krea2 rules beyond the manifest: an enabled prompt expansion needs its concrete settings."""
    from runner.registry import fields, number, text

    parameters = job['parameters']
    if parameters.get('expandPrompt') and 'promptExpansion' not in job:
        raise ValueError('Prompt expansion requires concrete configuration')
    if 'promptExpansion' not in job:
        return
    expansion = job['promptExpansion']
    fields(expansion, ('template', 'suffix', *(name for name, *_ in EXPANSION_LIMITS)), label='prompt expansion')
    text(expansion['template'], 'expansion template', 16000)
    if expansion['template'].count('{{prompt}}') != 1:
        raise ValueError('Expansion template must contain {{prompt}} exactly once')
    if not isinstance(expansion['suffix'], str) or len(expansion['suffix']) > 8000 or '\0' in expansion['suffix']:
        raise ValueError('Invalid expansion suffix')
    for name, low, high, integer in EXPANSION_LIMITS:
        number(expansion[name], 'expansion ' + name, low, high, integer)
    if any(expansion[name] == 0 for name in ('temperature', 'topP', 'repetitionPenalty')):
        raise ValueError('Expansion sampling values must be positive')


def preflight(job, config):
    """File-level checks run on CPU before the chat model is unloaded."""
    import importlib.util
    from pathlib import Path

    from runner.models.krea2_headers import validate_krea2_components
    from runner.models.krea2_shapes import validate_shapes

    if not Path(job['components']['tokenizer']).is_dir():
        raise ValueError('The workflow tokenizer folder does not exist')
    if importlib.util.find_spec('comfy_kitchen') is None:
        raise RuntimeError('Missing installed comfy-kitchen INT8 kernels')
    if config['tuned'] and importlib.util.find_spec('triton') is None:
        raise RuntimeError('Missing installed Triton tuned kernels')
    validate_shapes(validate_krea2_components(job))


def generate(job, config, progress):
    parameters = job['parameters']
    plan = dict(
        parameters,
        sampler='euler',
        scheduler='simple',
        refine_enabled=parameters.get('expandPrompt', False),
        promptExpansion=job.get('promptExpansion'),
        image=job['references'][0]['path'] if job['references'] else None,
    )
    files = dict(
        transformer=Path(job['components']['model']),
        encoder=Path(job['components']['textEncoder']),
        vae=Path(job['components']['vae']),
        loras=[(item, Path(item['path'])) for item in job['loras']],
    )
    args = SimpleNamespace(
        engine=config['engine'],
        tuned=config['tuned'],
        cache_gib=config.get('cacheGiB'),
        tokenizer=job['components']['tokenizer'],
    )
    with ExitStack() as cleanup:
        return _generate(args, plan, files, job, config, progress, cleanup)


def _generate(args, plan, files, job, config, progress_callback, cleanup):
    import torch
    import torch.nn.functional as F
    from safetensors import safe_open
    from accelerate import init_empty_weights
    from accelerate.utils import set_module_tensor_to_device
    from diffusers import Krea2Transformer2DModel, AutoencoderKLQwenImage, Krea2Pipeline
    from diffusers.loaders.single_file_utils import (
        convert_krea2_transformer_checkpoint_to_diffusers,
        convert_wan_vae_to_diffusers,
    )
    from PIL import Image, ImageOps

    if not torch.cuda.is_available():
        raise RuntimeError('The native Krea2 implementation requires a CUDA GPU')
    free, _ = torch.cuda.mem_get_info()
    if free < 9 * 1024**3:
        raise RuntimeError(f'Only {free / 1024**3:.1f} GiB VRAM free. Free other models first; no process was stopped.')
    if plan['sampler'] != 'euler' or plan['scheduler'] != 'simple':
        raise ValueError('Krea2 implements Euler + simple only')
    if plan['cfg'] != 1:
        raise ValueError('Krea2 implements CFG=1 only')
    dtype, device = torch.bfloat16, 'cuda'
    start = time.perf_counter()
    torch.cuda.reset_peak_memory_stats()
    # Every stage with its elapsed time, kept with the image so slow phases can be found later.
    timeline = []

    def progress(stage, **extra):
        data = dict(
            stage=stage,
            seconds=round(time.perf_counter() - start, 2),
            allocated_gib=round(torch.cuda.memory_allocated() / 1024**3, 3),
            reserved_gib=round(torch.cuda.memory_reserved() / 1024**3, 3),
            free_gib=round(torch.cuda.mem_get_info()[0] / 1024**3, 3),
            **extra,
        )
        timeline.append({key: value for key, value in data.items() if key != 'prompt'})
        progress_callback(**data)

    def release():
        gc.collect()
        torch.cuda.empty_cache()

    listed = {}

    def tensor(store, key):
        """A weight on the GPU in the working precision. The stored bytes travel first:
        converting on the CPU would waste bandwidth and cores."""
        keys = listed.setdefault(id(store), set(store.keys()))
        value = store.get_tensor(key).to(device=device).to(dtype=dtype)
        scale = key[:-7] + '.weight_scale' if key.endswith('.weight') else None
        if scale in keys:
            value = value * store.get_tensor(scale).to(device=device, dtype=dtype)
        return value

    from runner.models.krea2_text import encode_prompt
    from runner.models.pool import WeightPool, load_streamed, room
    from runner.models.residency import open_store

    ram_reserve = int(RAM_RESERVE_GIB * 1024**3)
    conditioning = encode_prompt(plan, files, args.tokenizer, tensor, device, dtype, progress, ram_reserve)
    with torch.inference_mode():
        progress('loading VAE')
        with init_empty_weights():
            vae = AutoencoderKLQwenImage()
        with safe_open(str(files['vae']), framework='pt', device='cpu') as store:
            state = convert_wan_vae_to_diffusers({k: store.get_tensor(k) for k in store.keys()})
            vae.load_state_dict(state, strict=True, assign=True)
        del state
        vae.eval().to(dtype=dtype)
        vae.enable_tiling()
        progress('VAE loaded')
        mean = torch.tensor(vae.config.latents_mean, device=device, dtype=dtype).view(1, 16, 1, 1)
        std = torch.tensor(vae.config.latents_std, device=device, dtype=dtype).view(1, 16, 1, 1)
        height, width = plan['height'] // 8, plan['width'] // 8
        generator = torch.Generator('cpu').manual_seed(plan['seed'])
        noise = torch.randn((1, 16, height, width), generator=generator).to(device)
        source = torch.zeros_like(noise)
        if plan['image']:
            image = ImageOps.fit(
                Image.open(plan['image']).convert('RGB'),
                (plan['width'], plan['height']),
                method=Image.Resampling.LANCZOS,
            )
            import numpy as np

            pixels = (
                torch.from_numpy(np.array(image).copy())
                .permute(2, 0, 1)
                .unsqueeze(0)
                .unsqueeze(2)
                .to(device=device, dtype=dtype)
                / 127.5
                - 1
            )
            vae.to(device)
            source = (vae.encode(pixels).latent_dist.mode()[:, :, 0] - mean) / std
            vae.to('cpu')
            del pixels
            release()

        progress('preparing transformer')
        transformer_header = header(files['transformer'])
        rename = {}
        for key, entry in transformer_header.items():
            if key == '__metadata__':
                continue
            meta = torch.empty(entry['shape'], device='meta')
            converted = convert_krea2_transformer_checkpoint_to_diffusers({key: meta})
            rename.update({dest: key for dest in converted})
        progress('transformer header mapped')
        # The model file stays in RAM between images; LoRAs are small and read as they are.
        stores = {'model': cleanup.enter_context(open_store(str(files['transformer']), reserve=ram_reserve))}
        adapters = []
        for index, (item, path) in enumerate(files['loras']):
            stores['lora' + str(index)] = cleanup.enter_context(open_store(str(path)))
            adapters.append(('lora' + str(index), item['strength']))
        # What the card has free now, less what a step needs beside the weights (its own
        # tensors grow with the picture, and the weights that do not stay pass through).
        megapixels = plan['width'] * plan['height'] / 1024**2
        reserve = RESERVE_GIB + RESERVE_PER_MEGAPIXEL_GIB * megapixels
        budget = room(reserve)
        if args.cache_gib is not None:
            budget = min(budget, args.cache_gib)
        pool = WeightPool(stores, budget, adapters=adapters)
        cleanup.callback(pool.clear)
        with init_empty_weights():
            transformer = Krea2Transformer2DModel()
        linear = {name for name, module in transformer.named_modules() if isinstance(module, torch.nn.Linear)}
        names = {}
        for name in linear:
            if name + '.weight' not in rename:
                raise ValueError('Missing transformer matrix: ' + name)
            names[name + '.weight'] = ('model', rename[name + '.weight'], None)
        # Everything that is not a matrix (norms, modulation tables) is small and stays on the GPU.
        for key, parameter in list(transformer.named_parameters()):
            if key.rpartition('.')[0] in linear:
                continue
            if key not in rename:
                raise ValueError('Missing transformer weight: ' + key)
            value = tensor(stores['model'], rename[key])
            if value.numel() != parameter.numel():
                raise ValueError('Transformer shape mismatch: ' + key)
            set_module_tensor_to_device(transformer, key, device, value=value.reshape(parameter.shape), dtype=dtype)
        transformer = load_streamed(transformer, names, pool)
        progress('transformer layers prepared', budget_gib=round(budget, 2))
        # The share that stays goes to the GPU now, in layer order, before the first step.
        pool.preload()
        progress('transformer weights on the GPU', gpu_gib=round(pool.bytes / 1024**3, 2))
        if args.tuned:
            from runner.models.krea2_kernels import install

            install(transformer)
        steps = plan['steps']
        denoise = plan['denoise']
        if not 0 < denoise <= 1:
            raise ValueError('Denoise must be in (0,1]')
        sigmas = torch.tensor(simple_sigmas(steps, denoise, torch), device=device)
        latents = noise * sigmas[0] + source * (1 - sigmas[0])
        del noise, source
        gh, gw = (height + 1) // 2, (width + 1) // 2
        positions = Krea2Pipeline.prepare_position_ids(conditioning.shape[1], gh, gw, device)
        release()
        progress('denoising ready', engine=args.engine)
        for i in range(steps):
            padded = F.pad(latents.to(dtype), (0, width % 2, 0, height % 2), mode='circular')
            packed = padded.reshape(1, 16, gh, 2, gw, 2).permute(0, 2, 4, 1, 3, 5).reshape(1, gh * gw, 64)
            prediction = transformer(
                hidden_states=packed,
                timestep=sigmas[i : i + 1].to(dtype),
                encoder_hidden_states=conditioning,
                position_ids=positions,
                return_dict=False,
            )[0]
            prediction = (
                prediction.reshape(1, gh, gw, 16, 2, 2)
                .permute(0, 3, 1, 4, 2, 5)
                .reshape(1, 16, gh * 2, gw * 2)[:, :, :height, :width]
            )
            latents = latents + prediction.float() * (sigmas[i + 1] - sigmas[i])
            if not torch.isfinite(latents).all():
                raise RuntimeError('Non-finite latent values; refusing to save a corrupt result')
            progress('denoising', step=i + 1, total=steps)
        weights = dict(pool.summary(), gpu_gib=round(pool.bytes / 1024**3, 3), budget_gib=round(budget, 3))
        pool.clear()
        del transformer, conditioning, prediction, packed, padded
        release()
        progress('decoding image')
        vae.to(device)
        decoded = vae.decode((latents.to(dtype) * std + mean).unsqueeze(2), return_dict=False)[0][0, :, 0]
        if not torch.isfinite(decoded).all():
            raise RuntimeError('Non-finite decoded image')
        progress('decoded')
        pixels = ((decoded.float().clamp(-1, 1) + 1) * 127.5).round().byte().permute(1, 2, 0).cpu().numpy()
        comfy_imported = any(k == 'comfy' or k.startswith('comfy.') for k in sys.modules)
        if comfy_imported:
            raise RuntimeError('Unexpected Comfy runtime import')
        metadata = dict(
            job=job,
            parameters=plan,
            seconds=round(time.perf_counter() - start, 2),
            peak_vram_gib=round(torch.cuda.max_memory_allocated() / 1024**3, 3),
            backend='pytorch-diffusers',
            kernel_library='comfy_kitchen',
            tuned=args.tuned,
            weights=weights,
            timeline=timeline,
        )
        return save_image(pixels, config, job, metadata)
