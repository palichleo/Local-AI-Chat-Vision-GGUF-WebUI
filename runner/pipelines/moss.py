"""Native MOSS Image: Euler on a flow, two predictions a step, the weights as their files store them.

After the model's own pipeline (OpenMOSS/MOSS-Image, Apache-2.0), with the settings it is
published with: sigmas moved by its shift (5, a setting of the model since 0.6.129) and brought to
the steps of the training, the prediction of the negative prompt made without block 22
(runner.models.moss_image). The two predictions of a step
are computed one after the other, each with its text at its own length, and joined in float32.

The model is read from its file through a RAM-resident store and a `WeightPool`
(runner.models.pool): what the card has free when the job starts decides how much of it stays
there, the rest is copied in at each step. The text encoder comes and goes before it
(runner.models.moss_image_text); the VAE is FLUX.2's, in float32 as the model's pipeline has it.
"""

from contextlib import ExitStack
import gc
from pathlib import Path
import sys
import time

from runner import hardware, preview
from runner.media import save_image
from runner.models.headers import header

# Video memory left beside the weights of the model, in GiB: a fixed part and what a step's own
# tensors take, which grows with the picture (Krea 2's figures, a model of the same width:
# to be measured again for this one).
RESERVE_GIB = 2.4
RESERVE_PER_MEGAPIXEL_GIB = 0.5
# RAM the files kept between two pictures leave free, in GiB (see runner.pipelines.krea2).
RAM_RESERVE_GIB = 4
# Weights copied to the GPU in advance, while it computes the layers before them (WeightPool).
AHEAD_GIB = 0.5
# The share of the steps whose negative prediction leaves block 22 out: the first half, as the
# workflow published for ComfyUI does (the model's own pipeline leaves it out to the last step).
SKIP_UNTIL = 0.5
# What the VAE takes to decode a megapixel whole in float32, in GiB: beyond what is free, it
# decodes by tiles.
DECODE_GIB_PER_MEGAPIXEL = 4.0
QUANT = (('encoder.quant_conv.', 'quant_conv.'), ('decoder.post_quant_conv.', 'post_quant_conv.'))


def preflight(job, config):
    """File-level checks run on CPU before the chat model is unloaded."""
    import importlib.util

    from runner.models import moss_image
    from runner.models.moss_image_text import PREFIX, WIDTH

    tokenizer = job['components'].get('tokenizer')
    if not tokenizer or not Path(tokenizer).is_dir():
        raise ValueError(
            'MOSS Image a besoin du tokenizer de Qwen3.5 (dossier qwen35_tokenizer) : '
            'choisissez-le dans les réglages du modèle.'
        )
    if importlib.util.find_spec('comfy_kitchen') is None:
        raise RuntimeError('Missing installed comfy-kitchen INT8 kernels')
    moss_image.config(header(job['components']['model']))
    encoder = header(job['components']['textEncoder'])
    table = encoder.get(PREFIX + 'embed_tokens.weight')
    if table is None or table['shape'][1:] != [WIDTH]:
        raise ValueError(
            'L’encodeur de texte de MOSS Image est un Qwen3.5 9B (par exemple '
            'mossImage_sft_txt_int8.safetensors) : ce fichier n’en est pas un.'
        )
    # ComfyUI also reads this encoder in files of 4-bit weights (« W4A8 »): this engine does not yet.
    if any(key.startswith(PREFIX) and key.endswith('.weight_codebook') for key in encoder):
        raise ValueError(
            'Cet encodeur de texte est en 4 bits (W4A8), un format que Moodix ne lit pas encore : '
            'choisissez l’encodeur INT8 de MOSS Image (mossImage_sft_txt_int8.safetensors).'
        )
    vae = header(job['components']['vae'])
    if 'bn.running_mean' not in vae or vae['bn.running_mean']['shape'] != [128]:
        raise ValueError('Le VAE de MOSS Image est celui de FLUX.2 (flux2-vae.safetensors) : ce fichier n’en est pas un.')


def generate(job, config, progress):
    with ExitStack() as cleanup:
        return _generate(job, config, progress, cleanup)


def finished(latents, velocity, sigma):
    """The finished latent (128, H, W) as a step sees it, for the page: the velocity points from
    it to the noise."""
    return (latents - velocity * sigma)[0]


def load_vae(path):
    """FLUX.2's VAE from its single file, in float32 on the processor. The file names its two
    1 x 1 convolutions inside the encoder and the decoder, and keeps the mean and the deviation
    of the latents in a batch norm (`bn`) that diffusers' class holds under the same name."""
    from diffusers import AutoencoderKLFlux2
    from diffusers.loaders.single_file_utils import convert_ldm_vae_checkpoint
    from safetensors import safe_open

    with safe_open(str(path), framework='pt', device='cpu') as store:
        held = {key: store.get_tensor(key) for key in store.keys()}
    vae = AutoencoderKLFlux2()
    plain = {}
    for key, value in held.items():
        if key.startswith('bn.'):
            continue
        for old, new in QUANT:
            key = key.replace(old, new)
        plain[key] = value
    state = convert_ldm_vae_checkpoint(plain, vae.config)
    state.update({key: value for key, value in held.items() if key.startswith('bn.')})
    vae.load_state_dict(state, strict=True)
    return vae.eval()


def pixels_of(latents, vae):
    """What the VAE decodes: the latents of the model given their mean and deviation back, then
    each of the 128 channels put in its place of a 2 x 2 block of the VAE's 32."""
    deviation = (vae.bn.running_var + vae.config.batch_norm_eps).sqrt().to(latents).view(1, -1, 1, 1)
    z = latents * deviation + vae.bn.running_mean.to(latents).view(1, -1, 1, 1)
    batch, channels, height, width = z.shape
    return (
        z.reshape(batch, channels // 4, 2, 2, height, width)
        .permute(0, 1, 4, 2, 5, 3)
        .reshape(batch, channels // 4, 2 * height, 2 * width)
    )


def guided(positive, negative, scale):
    """The velocity a step follows: from the negative prediction toward the positive one."""
    return negative + scale * (positive - negative)


def sample(model, latents, texts, sigmas, cfg, step=None):
    """Euler along `sigmas`, from the noise to the latents of the picture, in float32.

    `texts`: the conditioning of the prompt, then of the negative prompt. A guidance of 1 follows
    the prompt alone, one prediction a step; any other makes a second prediction for the negative
    prompt, without the skipped blocks for the first part of the steps. `step(index, total,
    latents, velocity, sigma)` is told each step once taken: the latents it leaves, the velocity
    it followed and the sigma it stops at (the finished picture it sees is latents - velocity * sigma).
    """
    import torch

    from runner.models.moss_image import SKIPPED, skipping

    total = len(sigmas) - 1
    for index in range(total):
        sigma = sigmas[index]
        velocity = model(latents, sigma, texts[0]).float()
        if cfg != 1:
            skip = SKIPPED if skipping(index, total, SKIP_UNTIL) else ()
            velocity = guided(velocity, model(latents, sigma, texts[1], skip=skip).float(), cfg)
        latents = latents + velocity * (sigmas[index + 1] - sigma)
        if not torch.isfinite(latents).all():
            raise RuntimeError('Non-finite latent values; refusing to save a corrupt result')
        if step is not None:
            step(index, total, latents, velocity, sigmas[index + 1])
    return latents


def schedule(parameters):
    """The sigmas of a job, and the shift they are moved by: the one of its settings (0.6.129: it was
    the constant of the model, 5, whatever was asked), the model's own when a job has none (a
    workflow written before the setting was)."""
    from runner.models import moss_image

    shift = float(parameters.get('shift', moss_image.SHIFT))
    return moss_image.sigmas(parameters['steps'], shift), shift


def _generate(job, config, progress_callback, cleanup):
    import torch
    from accelerate import init_empty_weights

    from runner.models import moss_image, moss_image_text
    from runner.models.pool import WeightPool, load_streamed, require, room
    from runner.models.residency import open_store

    if not torch.cuda.is_available():
        raise RuntimeError('The native MOSS Image implementation requires a CUDA GPU')
    parameters = job['parameters']
    files = {name: Path(job['components'][name]) for name in ('model', 'textEncoder', 'vae')}
    width, height, cfg = (parameters[name] for name in ('width', 'height', 'cfg'))
    megapixels = width * height / 1024**2
    reserve = RESERVE_GIB + RESERVE_PER_MEGAPIXEL_GIB * megapixels
    require('MOSS Image', reserve + AHEAD_GIB, 'la taille de l’image')
    device = 'cuda'
    start = time.perf_counter()
    torch.cuda.reset_peak_memory_stats()
    timeline = []

    def progress(stage, **extra):
        data = dict(
            stage=stage,
            seconds=round(time.perf_counter() - start, 2),
            allocated_gib=round(torch.cuda.memory_allocated() / 1024**3, 3),
            reserved_gib=round(torch.cuda.memory_reserved() / 1024**3, 3),
            free_gib=round(hardware.free_bytes(torch) / 1024**3, 3),
            **extra,
        )
        timeline.append({key: value for key, value in data.items() if key != 'prompt'})
        progress_callback(**data)

    def release():
        gc.collect()
        torch.cuda.empty_cache()

    ram_reserve = int(RAM_RESERVE_GIB * 1024**3)
    # A guidance of 1 follows the positive prediction alone: the negative prompt is not read.
    prompts = [parameters['prompt']] + ([parameters.get('negative_prompt', '')] if cfg != 1 else [])
    texts = moss_image_text.conditioning(
        prompts, files['textEncoder'], job['components']['tokenizer'], progress, ram_reserve, device
    )
    release()
    with torch.inference_mode():
        progress('loading VAE')
        vae = load_vae(files['vae'])
        progress('VAE loaded')
        generator = torch.Generator('cpu').manual_seed(parameters['seed'])
        # Drawn in float32 on the processor: the same picture on every card for a seed.
        latents = torch.randn((1, 128, height // 16, width // 16), generator=generator, dtype=torch.float32).to(device)

        progress('preparing transformer')
        described = header(files['model'])
        settings, prefix = moss_image.config(described)
        stores = {'model': cleanup.enter_context(open_store(str(files['model']), reserve=ram_reserve))}
        # The attention the file asks for (ComfyUI's files of INT8 weights ask for INT8 attention).
        asked = moss_image.file_attention(described, prefix, stores['model'])
        budget = room(reserve + AHEAD_GIB)
        if config.get('cacheGiB') is not None:
            budget = min(budget, config['cacheGiB'])
        pool = WeightPool(stores, budget, ahead_gib=AHEAD_GIB)
        cleanup.callback(pool.clear)
        with init_empty_weights():
            model = moss_image.MossImage(**settings, attention=asked)
        model = load_streamed(model, moss_image.names(model, described, prefix), pool)
        progress('transformer layers prepared', budget_gib=round(budget, 2))
        # The share that stays goes to the GPU now, in layer order, before the first step.
        pool.preload()
        progress('transformer weights on the GPU', gpu_gib=round(pool.bytes / 1024**3, 2))
        sigmas, shift = schedule(parameters)
        total = len(sigmas) - 1
        release()
        progress('denoising ready', engine=config.get('engine'))

        def step(index, total, latents, velocity, sigma):
            preview.send(progress_callback, preview.FLUX2, finished, latents, velocity, sigma)
            progress('denoising', step=index + 1, total=total)

        latents = sample(model, latents, texts, sigmas, cfg, step)
        weights = dict(pool.summary(), gpu_gib=round(pool.bytes / 1024**3, 3), budget_gib=round(budget, 3))
        # What the blocks really ran with, for the record of the picture.
        used = model.attention
        pool.clear()
        del model, texts
        release()
        progress('decoding image')
        vae.to(device)
        # Whole where the card has the room, by tiles beyond: a tile joins its neighbours over a band.
        tiled = DECODE_GIB_PER_MEGAPIXEL * megapixels > hardware.free_bytes(torch) / 1024**3
        if tiled:
            vae.enable_tiling()
        decoded = vae.decode(pixels_of(latents.to(vae.dtype), vae), return_dict=False)[0][0]
        if not torch.isfinite(decoded).all():
            raise RuntimeError('Non-finite decoded image')
        progress('decoded', tiled=tiled)
        pixels = ((decoded.float().clamp(-1, 1) + 1) * 127.5).round().byte().permute(1, 2, 0).cpu().numpy()
        if any(name == 'comfy' or name.startswith('comfy.') for name in sys.modules):
            raise RuntimeError('Unexpected Comfy runtime import')
        metadata = dict(
            job=job,
            # What the picture was really made with, beside what was asked: the model's own schedule.
            parameters=dict(
                parameters,
                sampler='euler',
                scheduler='moss_image',
                shift=shift,
                steps_done=total,
                skip_layers=list(moss_image.SKIPPED) if cfg != 1 else [],
                skip_until=SKIP_UNTIL,
                attention=used,
            ),
            seconds=round(time.perf_counter() - start, 2),
            peak_vram_gib=round(torch.cuda.max_memory_allocated() / 1024**3, 3),
            backend='pytorch',
            kernel_library='comfy_kitchen',
            weights=weights,
            timeline=timeline,
        )
        return save_image(pixels, config, job, metadata)
