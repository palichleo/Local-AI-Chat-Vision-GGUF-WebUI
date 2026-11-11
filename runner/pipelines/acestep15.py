"""ACE-Step 1.5 music: a song with sung lyrics, or an instrumental piece, from a style description.

The model is a whole diffusers folder (ACE-Step/acestep-v15-xl-sft-diffusers, MIT licence), run
with diffusers' AceStepPipeline (Apache-2.0): text and lyrics encoders, a diffusion transformer
over 25 audio latents per second, and an Oobleck VAE back to 48 kHz stereo. Each part moves to
the GPU only while it runs, so the 4B transformer has the card to itself.
"""

import json
from pathlib import Path
import time

CLASS = 'AceStepPipeline'
# Lyrics the model reads as "no singing".
INSTRUMENTAL = '[Instrumental]'


def _folder(job):
    folder = Path(job['components']['musicModel'])
    index = folder / 'model_index.json'
    if not index.is_file():
        raise ValueError('Ce dossier n’est pas un modèle ACE-Step complet : model_index.json est absent.')
    if json.loads(index.read_text(encoding='utf-8')).get('_class_name') != CLASS:
        raise ValueError('Ce dossier ne contient pas un modèle ACE-Step 1.5 (AceStepPipeline).')
    for part in ('transformer', 'text_encoder', 'tokenizer', 'condition_encoder', 'vae'):
        if not (folder / part).is_dir():
            raise ValueError(f'Le modèle ACE-Step est incomplet : le dossier {part} manque.')
    return folder


def preflight(job, config):
    _folder(job)


def generate(job, config, progress):
    import torch
    from diffusers import AceStepPipeline

    from runner.media import save_audio

    start = time.perf_counter()
    parameters = job['parameters']
    folder = _folder(job)
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    if device == 'cuda':
        torch.cuda.reset_peak_memory_stats()
    progress(stage='loading music model')
    pipe = AceStepPipeline.from_pretrained(str(folder), torch_dtype=torch.bfloat16)
    if device == 'cuda':
        # One part on the GPU at a time: the transformer alone takes about 8 GB in bf16.
        pipe.enable_model_cpu_offload()
    else:
        pipe.to(device)
    pipe.vae.enable_tiling()
    loaded = time.perf_counter()
    steps = parameters['steps']
    lyrics = parameters.get('lyrics', '').strip()
    language = parameters.get('language', 'en')
    if not lyrics:
        lyrics, language = INSTRUMENTAL, 'unknown'
    progress(stage='generating music', step=0, total=steps)

    def step(pipeline, index, timestep, values):
        progress(stage='generating music', step=index + 1, total=steps)
        return values

    generator = torch.Generator(device='cpu').manual_seed(parameters['seed'])
    with torch.inference_mode():
        result = pipe(
            prompt=parameters['prompt'],
            lyrics=lyrics,
            audio_duration=float(parameters['seconds']),
            vocal_language=language,
            num_inference_steps=steps,
            guidance_scale=float(parameters['guidance_scale']),
            shift=float(parameters['shift']),
            generator=generator,
            callback_on_step_end=step,
        )
    progress(stage='saving audio')
    audio = result.audios[0].float().cpu().numpy()
    peak = float(abs(audio).max()) if audio.size else 0.0
    metadata = dict(
        job=job,
        backend='pytorch-diffusers-acestep',
        device=device,
        seconds=round(time.perf_counter() - start, 2),
        load_seconds=round(loaded - start, 2),
        audio_seconds=round(audio.shape[-1] / pipe.sample_rate, 3),
        sample_rate=pipe.sample_rate,
        instrumental=lyrics == INSTRUMENTAL,
        peak=round(peak, 4),
    )
    if device == 'cuda':
        metadata['peak_vram_gib'] = round(torch.cuda.max_memory_allocated() / 1024**3, 3)
    del pipe
    return save_audio(audio, metadata['sample_rate'], config, job, metadata)
