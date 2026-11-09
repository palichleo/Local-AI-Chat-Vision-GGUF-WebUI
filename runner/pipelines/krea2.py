"""Native Krea2 Euler/simple sampling with bounded streaming or prepared INT8 weights."""

from contextlib import ExitStack, nullcontext
import gc
import json
import math
from pathlib import Path
import sys
import time
from types import SimpleNamespace

from runner.media import save_image
from runner.models.headers import header
from runner.pipelines.sampling import simple_sigmas


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

    from runner.models.headers import validate_krea2_components
    from runner.models.shapes import validate_shapes

    if not Path(config['tokenizerPath']).is_dir():
        raise ValueError('Configure an existing local tokenizer directory')
    if config['engine'] == 'int8' and importlib.util.find_spec('comfy_kitchen') is None:
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
        cache_root=config['cacheRoot'],
        tokenizer=config['tokenizerPath'],
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
    scope = lambda _: nullcontext()
    prepared = None
    prepared_stats = None
    start = time.perf_counter()
    torch.cuda.reset_peak_memory_stats()

    def progress(stage, **extra):
        data = dict(
            stage=stage,
            seconds=round(time.perf_counter() - start, 2),
            allocated_gib=round(torch.cuda.memory_allocated() / 1024**3, 3),
            **extra,
        )
        progress_callback(**data)

    def release():
        gc.collect()
        torch.cuda.empty_cache()

    def tensor(store, key):
        # Transfer quantized bytes first; converting on the CPU wastes bandwidth and cores.
        with scope('krea/weights.read'):
            value = store.get_tensor(key)
        with scope('krea/weights.upload'):
            value = value.to(device=device)
        with scope('krea/weights.dequantize'):
            value = value.to(dtype=dtype)
        with scope('krea/weights.read'):
            scale = key[:-7] + '.weight_scale' if key.endswith('.weight') else None
            scaled = scale and scale in store.keys()
            factor = store.get_tensor(scale) if scaled else None
        if scaled:
            with scope('krea/weights.upload'):
                factor = factor.to(device=device, dtype=dtype)
            with scope('krea/weights.dequantize'):
                value = value * factor
        return value

    prefetch = None
    if args.tuned:
        from runner.models.kernels import start_prefetch
        from runner.models.weights import cache_key

        prefetch = start_prefetch(Path(args.cache_root) / cache_key(files['transformer'], files['loras']))
        cleanup.callback(prefetch[0].shutdown, wait=True)
    from runner.models.text import encode_prompt

    conditioning = encode_prompt(plan, files, args.tokenizer, tensor, device, dtype, progress)
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

        progress('preparing streaming transformer')
        transformer_header = header(files['transformer'])
        rename = {}
        for key, entry in transformer_header.items():
            if key == '__metadata__':
                continue
            meta = torch.empty(entry['shape'], device='meta')
            converted = convert_krea2_transformer_checkpoint_to_diffusers({key: meta})
            rename.update({dest: key for dest in converted})
        weights = cleanup.enter_context(safe_open(str(files['transformer']), framework='pt', device='cpu'))
        adapters = [
            (cleanup.enter_context(safe_open(str(path), framework='pt', device='cpu')), item['strength'])
            for item, path in files['loras']
        ]
        rotations = {}
        if args.engine == 'int8':
            from runner.models.weights import PreparedWeights, PreparedLinear

            available = torch.cuda.mem_get_info()[0] / 1024**3
            ceiling, reserve = (7.0, 3.0) if args.tuned else (6.0, 3.5)
            budget = max(0, min(ceiling, available - reserve))
            if args.cache_gib is not None:
                budget = min(budget, args.cache_gib)
            prepared = PreparedWeights(files, weights, args.cache_root, budget, scope, progress)
            if prefetch is not None:
                pool, future = prefetch
                prepared.host = future.result()
                progress('CPU weights prefetched', layers=len(prepared.host))

        class StreamingLinear(torch.nn.Module):
            def __init__(self, name, original):
                super().__init__()
                self.source = original
                self.in_features = transformer_header[original]['shape'][1]
                self.out_features = transformer_header[original]['shape'][0]
                quant_key = original.removesuffix('.weight') + '.comfy_quant'
                quant = json.loads(bytes(weights.get_tensor(quant_key).tolist())) if quant_key in weights.keys() else {}
                self.rotation_size = quant.get('convrot_groupsize', 256) if quant.get('convrot') else None
                if self.rotation_size:
                    if self.in_features % self.rotation_size:
                        raise ValueError('Invalid ConvRot dimensions: ' + original)
                    if self.rotation_size not in rotations:
                        from runner.models.weights import rotation_matrix

                        rotations[self.rotation_size] = rotation_matrix(self.rotation_size, torch, device, dtype)
                self.adapters = []
                for store, strength in adapters:
                    stem = original.removesuffix('.weight')
                    for candidate in (stem, 'diffusion_model.' + stem, 'model.diffusion_model.' + stem):
                        if candidate + '.lora_A.weight' in store.keys():
                            self.adapters.append((store, candidate, strength))
                            break

            def forward(self, value):
                weight = tensor(weights, self.source)
                bias_key = self.source[:-7] + '.bias'
                bias = tensor(weights, bias_key) if bias_key in weights.keys() else None
                rotated = value
                with scope('krea/convrot'):
                    if self.rotation_size:
                        rotated = (value.reshape(-1, self.rotation_size) @ rotations[self.rotation_size]).reshape(
                            value.shape
                        )
                with scope('krea/base.linear'):
                    result = F.linear(rotated, weight, bias)
                del weight, bias, rotated
                for store, key, strength in self.adapters:
                    with scope('krea/lora.read'):
                        a = store.get_tensor(key + '.lora_A.weight')
                        b = store.get_tensor(key + '.lora_B.weight')
                        alpha = (
                            store.get_tensor(key + '.alpha').item() / a.shape[0]
                            if key + '.alpha' in store.keys()
                            else 1.0
                        )
                    with scope('krea/lora.upload_cast'):
                        a = a.to(device=device, dtype=value.dtype)
                        b = b.to(device=device, dtype=value.dtype)
                    with scope('krea/lora.linear'):
                        result = result + F.linear(F.linear(value, a), b) * (strength * alpha)
                return result

        with init_empty_weights():
            transformer = Krea2Transformer2DModel()
        for name, module in list(transformer.named_modules()):
            if isinstance(module, torch.nn.Linear):
                if name + '.weight' not in rename:
                    raise ValueError('Missing transformer matrix: ' + name)
                original = rename[name + '.weight']
                linear = StreamingLinear(name, original)
                if prepared is not None:
                    linear = PreparedLinear(original, linear.adapters, rotations.get(linear.rotation_size), prepared)
                transformer.set_submodule(name, linear)
        for key, parameter in list(transformer.named_parameters()):
            if key not in rename:
                raise ValueError('Missing transformer weight: ' + key)
            value = tensor(weights, rename[key])
            if value.numel() != parameter.numel():
                raise ValueError('Transformer shape mismatch: ' + key)
            set_module_tensor_to_device(transformer, key, device, value=value.reshape(parameter.shape), dtype=dtype)
        transformer.eval().to(device)
        if args.tuned:
            from runner.models.kernels import install

            install(transformer)
        if prepared is not None:
            # Prepared layers own their files; release the original mmap pages before sampling.
            prepared.source = None
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
            with scope('krea/step'):
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
        if prepared is not None:
            prepared_stats = prepared.stats()
            prepared.clear()
        del transformer, conditioning, prediction, packed, padded, adapters, weights
        release()
        progress('decoding image')
        vae.to(device)
        decoded = vae.decode((latents.to(dtype) * std + mean).unsqueeze(2), return_dict=False)[0][0, :, 0]
        if not torch.isfinite(decoded).all():
            raise RuntimeError('Non-finite decoded image')
        pixels = ((decoded.float().clamp(-1, 1) + 1) * 127.5).round().byte().permute(1, 2, 0).cpu().numpy()
        comfy_imported = any(k == 'comfy' or k.startswith('comfy.') for k in sys.modules)
        if comfy_imported:
            raise RuntimeError('Unexpected Comfy runtime import')
        metadata = dict(
            job=job,
            parameters=plan,
            seconds=round(time.perf_counter() - start, 2),
            peak_vram_gib=round(torch.cuda.max_memory_allocated() / 1024**3, 3),
            backend='pytorch-diffusers-' + args.engine,
            kernel_library='comfy_kitchen' if args.engine == 'int8' else None,
            tuned=args.tuned,
        )
        if prepared_stats is not None:
            metadata['prepared_weights'] = prepared_stats
        return save_image(pixels, config, job, metadata)
