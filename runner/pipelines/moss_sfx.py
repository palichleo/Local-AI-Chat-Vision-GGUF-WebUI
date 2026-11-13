"""MOSS-SoundEffect v2 sound effects: up to 30 seconds of 48 kHz sound from a description.

The model is the published folder OpenMOSS-Team/MOSS-SoundEffect-v2.0 (Apache-2.0). Each part
takes the card in turn: Qwen3 reads the prompt, the 1.3B transformer denoises a 30-second
latent (the length it was trained on), then the DAC decoder turns it into a waveform, cut to
the length asked for.
"""

import json
from pathlib import Path
import time

CLASS = 'MossSoundEffectPipeline'
SAMPLE_RATE = 48000
FULL_SECONDS = 30


def _folder(job):
    folder = Path(job['components']['soundModel'])
    index = folder / 'model_index.json'
    if not index.is_file():
        raise ValueError('Ce dossier n’est pas un modèle MOSS-SoundEffect complet : model_index.json est absent.')
    if json.loads(index.read_text(encoding='utf-8')).get('_class_name') != CLASS:
        raise ValueError('Ce dossier ne contient pas MOSS-SoundEffect v2 (MossSoundEffectPipeline).')
    needed = (
        'transformer/config.json',
        'transformer/diffusion_pytorch_model.safetensors',
        'text_encoder',
        'tokenizer',
    )
    for part in needed:
        if not (folder / part).exists():
            raise ValueError(f'Le modèle MOSS-SoundEffect est incomplet : {part} manque.')
    if _vae(folder) is None:
        raise ValueError('Le modèle MOSS-SoundEffect est incomplet : le VAE (vae/vae_128d_48k.pth) manque.')
    return folder


def _vae(folder):
    for name in ('vae_128d_48k.pth', 'diffusion_pytorch_model.safetensors'):
        if (folder / 'vae' / name).is_file():
            return folder / 'vae' / name
    return None


def check(job, manifest):
    seconds = job['parameters']['seconds']
    if seconds > FULL_SECONDS:
        raise ValueError(f'MOSS-SoundEffect produit {FULL_SECONDS} secondes au plus')


def preflight(job, config):
    _folder(job)


def _free(torch, device):
    if device == 'cuda':
        torch.cuda.empty_cache()


def _read_prompts(folder, tokenizer, prompts, device):
    """Qwen3 reads the prompts in float32, on the processor, whatever the machine. In bfloat16 its
    first token comes out several units off (the large activations of that token lose their
    precision) and the transformer then makes silence: measured on « sons de pistolet », peak
    0.0004 in bfloat16 against 0.82 in float32, the same transformer and seed. Reading a
    prompt's own tokens takes 0.2 s on the processor (4 or 12 threads, measured), less than
    copying its 6.9 GB to the card, which 6 and 8 GB cards could not hold beside the rest."""
    import torch
    from transformers import AutoModel

    from runner.models import moss_sfx

    encoder = AutoModel.from_pretrained(str(folder / 'text_encoder'), dtype=torch.float32).eval()
    with torch.inference_mode():
        read = [moss_sfx.encode_text(encoder, tokenizer, [prompt], 'cpu').to(device) for prompt in prompts]
    del encoder
    return read


def generate(job, config, progress):
    import torch
    from transformers import AutoTokenizer

    from runner.media import save_audio
    from runner.models import moss_sfx

    start = time.perf_counter()
    parameters = job['parameters']
    folder = _folder(job)
    index = json.loads((folder / 'model_index.json').read_text(encoding='utf-8'))
    sample_rate = int(index.get('sample_rate', SAMPLE_RATE))
    full_seconds = int(index.get('max_inference_seconds', FULL_SECONDS))
    seconds = round(float(parameters['seconds']), 1)
    if seconds > full_seconds:
        raise ValueError(f'MOSS-SoundEffect produit {full_seconds} secondes au plus')
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    if device == 'cuda':
        torch.cuda.reset_peak_memory_stats()
    steps, guidance, shift = parameters['steps'], float(parameters['guidance_scale']), float(parameters['shift'])

    # The prompt, then an empty one for guidance, each with the length it was trained with.
    progress(stage='encoding sound prompt')
    prompt = f'{parameters["prompt"].strip()} duration: {seconds:.1f}s'
    tokenizer = AutoTokenizer.from_pretrained(str(folder / 'tokenizer'))
    context, empty = _read_prompts(folder, tokenizer, [prompt, parameters.get('negative_prompt', '')], device)

    progress(stage='loading sound model')
    model = moss_sfx.load_transformer(folder / 'transformer').to(device)
    with (folder / 'transformer' / 'config.json').open(encoding='utf-8') as file:
        latent_dim = json.load(file)['in_dim']
    decoder = moss_sfx.load_decoder(_vae(folder))
    hop = decoder.hop
    loaded = time.perf_counter()

    # Fixed-size noise, drawn on the CPU so a seed gives the same sound on any card.
    length = sample_rate * full_seconds // hop
    generator = torch.Generator(device='cpu').manual_seed(parameters['seed'])
    latents = torch.randn((1, latent_dim, length), generator=generator, dtype=torch.float32)
    latents = latents.to(device=device, dtype=torch.bfloat16)
    # Euler steps along the flow, from pure noise (1) to the sound (0).
    levels = moss_sfx.sigmas(steps, shift)
    timesteps = levels * 1000
    following = torch.cat([levels[1:], torch.zeros(1)])
    progress(stage='generating sound', step=0, total=steps)
    with torch.inference_mode(), torch.autocast(device, dtype=torch.bfloat16):
        for index in range(steps):
            timestep = timesteps[index : index + 1].to(device)
            velocity = model(latents, timestep, context).float()
            if guidance != 1.0:
                unconditioned = model(latents, timestep, empty).float()
                velocity = unconditioned + guidance * (velocity - unconditioned)
            latents = latents + velocity * (following[index] - levels[index]).to(device)
            progress(stage='generating sound', step=index + 1, total=steps)
    del model, context, empty
    _free(torch, device)

    progress(stage='decoding sound')
    decoder = decoder.to(device)
    with torch.inference_mode(), torch.autocast(device, dtype=torch.float32, enabled=device == 'cuda'):
        audio = decoder(latents.float())[0, :, : int(sample_rate * seconds)]
    del decoder
    progress(stage='saving audio')
    audio = audio.float().cpu().numpy()
    peak = float(abs(audio).max()) if audio.size else 0.0
    metadata = dict(
        job=job,
        backend='pytorch-moss-soundeffect',
        device=device,
        seconds=round(time.perf_counter() - start, 2),
        load_seconds=round(loaded - start, 2),
        audio_seconds=round(audio.shape[-1] / sample_rate, 3),
        sample_rate=sample_rate,
        peak=round(peak, 4),
    )
    if device == 'cuda':
        metadata['peak_vram_gib'] = round(torch.cuda.max_memory_allocated() / 1024**3, 3)
    _free(torch, device)
    return save_audio(audio, sample_rate, config, job, metadata)
