"""Native MiniMax-H3 (FastH3 Omni / FastH3 v2): prompt + references -> video with sound.

The request flow is the diffusers MiniMax-H3 modular pipeline (Apache-2.0), run
stage by stage so only one large model occupies the GPU at a time:
presentation + conditioner, VAE encoding of the conditions, 8-step joint
denoise with the streamed DiT, then video and audio decoding.
"""

import gc
import sys
import time

STEPS = 8
FRAME_CHOICES = tuple(17 * n + 5 for n in range(7, 21))  # 5 to 15 seconds at 24 fps
# A continuation overlap must cover whole VAE chunks (17n+5 frames -> 5n+2 latent frames),
# so the source tail encodes onto exactly the latent frames that open the new window.
OVERLAPS = (22, 39, 56)
AUDIO_LATENTS_PER_SECOND = 40


def check(job, family):
    p = job['parameters']
    roles = [ref['role'] for ref in job['references']]
    if p['frames'] not in FRAME_CHOICES:
        raise ValueError('MiniMax-H3 frames must be 17n+5 between 124 and 345')
    if p['fps'] != 24:
        raise ValueError('MiniMax-H3 generates at 24 fps')
    if roles.count('reference_image') > 9:
        raise ValueError('At most 9 reference images')
    if 'reference_image' in roles and ({'start_image', 'end_image'} & set(roles)):
        raise ValueError('Choose reference images or start/end images, not both')
    if 'source_video' in roles and ({'start_image', 'end_image'} & set(roles)):
        raise ValueError('A continuation already starts on its source video; drop the start/end images')
    if 'source_video' in roles and p.get('overlap_frames', 22) not in OVERLAPS:
        raise ValueError('MiniMax-H3 continuation overlap must be 22, 39 or 56 frames')


def model_kind(header):
    """'reference' for a Ref2VA-derived DiT (FastH3 Omni), 'base' otherwise (FastH3 v2)."""
    source = (header.get('__metadata__') or {}).get('source', '')
    return 'reference' if source == 'transformer_ref' else 'base'


def preflight(job, config):
    from runner.models.headers import header
    from runner.models import minimax_h3

    minimax_h3.validate(header(job['components']['model']))
    # A source video of another size or frame rate is refused here, before the chat model is unloaded.
    for ref in job['references']:
        if ref['role'] == 'source_video':
            from runner.video.continuation import source_tail

            source_tail(ref['path'], job['parameters'], overlaps=OVERLAPS, default=22)


def _stage(block_name, components, state, **inputs):
    """Run one MiniMax-H3 block as its own small pipeline on the shared request state.

    One `PipelineState` carries the request (and the raw `references` / `image` /
    `last_image` the auto blocks select their workflow on) from stage to stage, so
    each stage only needs its own models loaded. The pipeline works on a copy:
    use the returned state.
    """
    from diffusers.modular_pipelines import MiniMaxH3Blocks

    block = MiniMaxH3Blocks().sub_blocks[block_name]
    pipe = block.init_pipeline()
    needed = {spec.name for spec in block.expected_components} | {spec.name for spec in block.expected_configs}
    pipe.update_components(**{name: value for name, value in components.items() if name in needed})
    for name, value in inputs.items():
        if value is not None:
            state.set(name, value)
    return pipe(state=state)


def _free(*names, scope):
    import torch

    for name in names:
        scope.pop(name, None)
    gc.collect()
    torch.cuda.empty_cache()


def _patchify(latents):
    """(1, C, T, H, W) VAE latents -> packed video rows (T * H/2 * W/2, C * 4), frame-major."""
    _, channels, frames, height, width = latents.shape
    rows = latents.reshape(1, channels, frames, 1, height // 2, 2, width // 2, 2)
    return rows.permute(0, 2, 4, 6, 1, 3, 5, 7).reshape(frames * (height // 2) * (width // 2), channels * 4)


def protect_head(dit, schedulers, calls, video_head, audio_head, target_video_rows, target_audio_latents):
    """LongForge PROTECTED continuation on the packed sequence.

    The first target rows (video: the source tail's latent frames; audio: both stereo
    channels' first latents) are fed clean at a pinned timestep, and their velocity is
    replaced so every Euler step lands them on the clean source: the generated window
    opens exactly on the end of the source video and its sound.
    """
    import torch

    held = {}

    def before(_module, args, values):
        hidden, audio = values['hidden_states'], values['audio_hidden_states']
        timestep, indices = values['timestep'], values['timestep_indices'].clone()
        video_rows = values['video_indices']
        audio_rows = values['audio_indices']
        first_video = hidden.shape[1] - target_video_rows
        first_audio = audio.shape[1] - 2 * target_audio_latents
        video_slice = slice(first_video, first_video + video_head.shape[0])
        audio_slices = [
            slice(start, start + audio_head.shape[1])
            for start in (first_audio + channel * target_audio_latents for channel in range(2))
        ]
        held['video'] = (video_slice, hidden[0, video_slice].float())
        held['audio'] = [(part, audio[0, part].float()) for part in audio_slices]
        hidden = hidden.clone()
        hidden[0, video_slice] = video_head.to(hidden)
        audio = audio.clone()
        for channel, part in enumerate(audio_slices):
            audio[0, part] = audio_head[channel].to(audio)
        # Pinned timesteps: video like the other clean condition rows, audio fully clean.
        timestep = torch.cat([timestep, timestep.new_tensor([0.999, 1.0])])
        indices[video_rows[video_slice]] = timestep.numel() - 2
        for part in audio_slices:
            indices[audio_rows[part]] = timestep.numel() - 1
        values.update(hidden_states=hidden, audio_hidden_states=audio, timestep=timestep, timestep_indices=indices)
        return args, values

    def after(_module, _args, _values, output):
        video, audio = output[0].clone(), output[1].clone()
        step = calls['step'] - 1  # the step counter hook ran first
        sigma = float(schedulers[0].sigmas[step])
        audio_sigma = float(schedulers[1].sigmas[step])
        # MiniMax-H3 predicts a data-ward velocity: x0 = x + sigma * v.
        part, noisy = held['video']
        video[0, part] = ((video_head.to(noisy) - noisy) / sigma).to(video)
        for channel, (part, noisy) in enumerate(held['audio']):
            audio[0, part] = ((audio_head[channel].to(noisy) - noisy) / audio_sigma).to(audio)
        return (video, audio, *output[2:])

    return (
        dit.register_forward_pre_hook(before, with_kwargs=True),
        dit.register_forward_hook(after, with_kwargs=True),
    )


def _encode_tail(vae, audio_vae, path, tail, plan, parameters):
    """Clean packed rows of the source tail: video (rows, 96) and audio (2, latents, 32)."""
    import math
    import numpy as np
    import torch
    from diffusers.modular_pipelines.minimax_h3.encoders import encode_vae_condition
    from runner.video.audio_tail import read_audio

    pixels = torch.from_numpy(np.stack([np.asarray(frame.convert('RGB')) for frame in tail]))
    pixels = pixels.to(vae.device).permute(3, 0, 1, 2)[None]
    # Same recipe as the pipeline's own visual conditions (ImageNet pixels, seeded posterior sample).
    latents = encode_vae_condition(vae, pixels, (0.485, 0.456, 0.406), (0.229, 0.224, 0.225), 42)
    video_head = _patchify(latents.float())
    overlap = plan['overlapFrames']
    count = math.floor(overlap / 24 * AUDIO_LATENTS_PER_SECOND)
    audio_head = torch.zeros(2, 0, audio_vae.config.latent_channels)
    if parameters.get('audio', True) and plan.get('sourceAudio'):
        rate = audio_vae.config.sampling_rate
        hop = rate // AUDIO_LATENTS_PER_SECOND
        start = (plan['sourceFrames'] - overlap) / 24
        wave = read_audio(path, start, plan['sourceFrames'] / 24, rate=rate)
        if wave is not None:
            wave = np.pad(wave, ((0, 0), (0, -wave.shape[1] % hop)))
            posterior = audio_vae.encode(torch.from_numpy(wave).to(audio_vae.device)[:, None], return_dict=False)[0]
            audio = posterior.mode().float().cpu().transpose(1, 2)
            mean = torch.tensor(audio_vae.config.latents_mean).view(1, 1, -1)
            std = torch.tensor(audio_vae.config.latents_std).view(1, 1, -1)
            audio_head = ((audio - mean) / std)[:, :count]
    return video_head, audio_head


def generate(job, config, progress):
    import torch
    from PIL import Image
    from diffusers import MiniMaxH3Scheduler
    from diffusers.modular_pipelines.minimax_h3 import encoders as reference_encoders
    from diffusers.modular_pipelines.minimax_h3.references import MiniMaxH3ImageReference
    from runner.models.headers import header
    from runner.models import conditioning, minimax_h3, minimax_h3_text, minimax_h3_vae
    from runner.models.ltx25 import WeightPool
    from runner.models.residency import RESIDENCY, open_store, prefetch, use_order
    from runner.pipelines.ltx25 import memory
    from runner.video.export import save_video

    if not torch.cuda.is_available():
        raise RuntimeError('Native MiniMax-H3 requires CUDA')
    if torch.cuda.mem_get_info()[0] < 9 * 1024**3:
        raise RuntimeError('Free the other GPU models before generating video')
    start = time.perf_counter()
    torch.cuda.reset_peak_memory_stats()
    timeline = []
    report = progress

    def progress(**data):
        timeline.append(
            dict(
                {key: value for key, value in data.items() if key != 'prompt'},
                seconds=round(time.perf_counter() - start, 2),
                allocated_gib=round(torch.cuda.memory_allocated() / 1024**3, 3),
                free_gib=round(torch.cuda.mem_get_info()[0] / 1024**3, 3),
                **memory(),
            )
        )
        report(**data)

    p, paths = job['parameters'], job['components']
    dit_header = header(paths['model'])
    kind = model_kind(dit_header)
    roles = {ref['role'] for ref in job['references']}
    # FastH3 Omni also runs text-only and start/end-image requests: their packed sequences
    # only add keyframe condition rows, which the reference model reads like LongForge does.
    if kind == 'base' and 'reference_image' in roles:
        raise ValueError('This MiniMax-H3 model does not take reference images; use FastH3 Omni')
    references = []
    keyframe_inputs = {}
    source = next((ref for ref in job['references'] if ref['role'] == 'source_video'), None)
    continuation = None
    if source:
        from runner.video.continuation import source_tail

        tail, continuation = source_tail(source['path'], p, overlaps=OVERLAPS, default=22)
    for ref in job['references']:
        if ref['role'] == 'source_video':
            continue
        with Image.open(ref['path']) as image:
            pixels = image.convert('RGB')
        if ref['role'] == 'reference_image':
            references.append(MiniMaxH3ImageReference(image=pixels))
        elif ref['role'] == 'start_image':
            keyframe_inputs['image'] = pixels
        elif ref['role'] == 'end_image':
            keyframe_inputs['last_image'] = pixels
    from diffusers.modular_pipelines import PipelineState

    state = PipelineState()
    for name, value in dict(
        prompt=p['prompt'],
        height=p['height'],
        width=p['width'],
        num_frames=p['frames'],
        references=references or None,
        **keyframe_inputs,
    ).items():
        if value is not None:
            state.set(name, value)

    # 1. Presentation and conditioner (streamed Qwen3-VL-32B).
    progress(stage='loading video prompt encoder')
    # LongForge's "max" reference sizing: never upscale, cap the short edge at 2048.
    # (diffusers rescales every reference image to one configured short edge.)
    reference_edge = min([2048, *(min(ref.image.size) for ref in references)])
    state = _stage('before_encode', {'reference_image_short_edge': reference_edge}, state)
    # What the conditioner wrote for the same request (prompt, images, sizes) with the same
    # files comes back from the disk: the 16 GiB conditioner is not loaded, and the video
    # model stays in the system's file cache.
    entry = conditioning.key(
        'minimax_h3',
        conditioning.stamp(paths['textEncoder']),
        conditioning.stamp(paths['tokenizer']),
        dict(state.values),
    )
    found = conditioning.load(config, entry)
    read = None
    if found:
        for name, value in conditioning.restore(*found).items():
            state.set(name, value)
        for kind, names in found[1].get('kinds', {}).items():
            known = state.kwargs_mapping.setdefault(kind, [])
            known.extend(name for name in names if name not in known)
        kept = 'kept from an earlier generation'
    else:
        tokenizer, processor = minimax_h3_text.processor(paths['tokenizer'])
        text_encoder, text_store = minimax_h3_text.load(paths['textEncoder'])
        # The disk reads the conditioner in sequence while its layers run, then the DiT while
        # the conditions are encoded and the model is built (see Prefetch).
        ahead = prefetch(paths, {'textEncoder': text_store}, [('textEncoder', key, None) for key in text_store.keys()])
        original = reference_encoders.get_qwen3vl_prompt_embeds
        reference_encoders.get_qwen3vl_prompt_embeds = minimax_h3_text.prompt_embeds
        before = dict(state.values)
        try:
            progress(stage='encoding video prompt')
            state = _stage(
                'text_encoder', dict(text_encoder=text_encoder, tokenizer=tokenizer, processor=processor), state
            )
        finally:
            reference_encoders.get_qwen3vl_prompt_embeds = original
            read = ahead.stop() if ahead else None
        written = conditioning.changes(before, state.values)
        kept = (
            'kept for the next generations'
            if written
            and conditioning.save(config, entry, written[0], dict(written[1], kinds=dict(state.kwargs_mapping)))
            else 'not kept'
        )
        del text_encoder, text_store, before, written
    state.set('prompt_embeds', state.get('prompt_embeds').to('cuda', torch.bfloat16))
    _free(scope={})
    progress(
        stage='video prompt encoded',
        tokens=int(state.get('prompt_embeds').shape[1]),
        conditioning=kept,
        **({'prefetch': read} if read else {}),
    )
    ahead = prefetch(paths, {}, use_order(minimax_h3.names(dit_header)))

    # 2. Conditions through the VAE encoders (only when there are any).
    video_head = audio_head = None
    if references or keyframe_inputs or continuation:
        progress(stage='encoding references')
        vae = minimax_h3_vae.video_vae(paths['vae'], 'encoder')
        audio_vae = minimax_h3_vae.audio_vae(paths['audioVae'])
        if references or keyframe_inputs:
            state = _stage('vae_encoder', dict(vae=vae, audio_vae=audio_vae), state)
        if continuation:
            with torch.inference_mode():
                video_head, audio_head = _encode_tail(vae, audio_vae, source['path'], tail, continuation, p)
            continuation['audioProtectedLatents'] = int(audio_head.shape[1])
        del vae, audio_vae
        _free(scope={})

    # 3. Joint denoise: DiT streamed from its file, PDD heads told each step's interval.
    progress(stage='loading video model')
    with open_store(paths['model']) as store, torch.inference_mode():
        # The share of the DiT kept on the GPU; the rest is copied from RAM at every step, at
        # about 12 GiB/s. What the model computes with comes first: 5 GiB (a feed-forward
        # chunk, the allocator's slack, the engine's margin) plus the activations, which grow
        # with the video (1 GiB for a 5 s draft). Video memory that runs out halves the speed,
        # a smaller share costs a second per step at most.
        tokens = ((p['frames'] - 5) // 17 * 5 + 2) * (p['height'] // 32) * (p['width'] // 32) + 512
        room = torch.cuda.mem_get_info()[0] / 1024**3 - 5 - tokens * 7168 * 2 * 6 / 1024**3
        budget = min(config.get('cacheGiB', 6), max(0, room))
        pool = WeightPool({'model': store}, budget)
        if ahead:
            ahead.lead = pool.used
        try:
            fast_attention = minimax_h3.INT8_ATTENTION and minimax_h3.int8_attention_ready()
            dit, _heads = minimax_h3.load(dit_header, paths['model'], pool, fast_attention)
            pool.preload()
            scheduler, audio_scheduler = MiniMaxH3Scheduler(shift=12.0), MiniMaxH3Scheduler(shift=3.0)
            calls = {'step': 0}

            def before(_module, args, values):
                i = calls['step']
                minimax_h3.set_interval(
                    dit,
                    (scheduler.sigmas[i], scheduler.sigmas[i + 1]),
                    (audio_scheduler.sigmas[i], audio_scheduler.sigmas[i + 1]),
                )
                return args, values

            def after(_module, _args, _values, output):
                calls['step'] += 1
                read = {'prefetch': ahead.stop()} if ahead and calls['step'] == 1 else {}
                progress(stage='generating video', step=calls['step'], total=STEPS, weights=pool.summary(), **read)
                return output

            dit.register_forward_pre_hook(before, with_kwargs=True)
            dit.register_forward_hook(after, with_kwargs=True)
            if continuation:
                # Registered after the step counter: its output hook reads the finished step.
                latent_frames = (p['frames'] - 5) // 17 * 5 + 2
                protect_head(
                    dit,
                    (scheduler, audio_scheduler),
                    calls,
                    video_head.to('cuda'),
                    audio_head.to('cuda'),
                    latent_frames * (p['height'] // 32) * (p['width'] // 32),
                    round(p['frames'] / 24 * AUDIO_LATENTS_PER_SECOND),
                )
            progress(stage='sampling video', attention='int8' if fast_attention else 'pytorch')
            # The diffusers blocks name the DiT by workflow: ref2va reads `transformer_ref`.
            name = 'transformer_ref' if references else 'transformer'
            state = _stage(
                'denoise',
                {name: dit, 'scheduler': scheduler, 'audio_scheduler': audio_scheduler},
                state,
                num_inference_steps=STEPS + 1,
                generator=torch.Generator('cpu').manual_seed(p['seed']),
            )
            if calls['step'] != STEPS:
                raise RuntimeError(f'Expected {STEPS} denoising steps, ran {calls["step"]}')
            cache = dict(
                gpu_cache_gib=round(pool.bytes / 1024**3, 3),
                gpu_cache_limit_gib=round(budget, 3),
                pinned_model=store.pinned,
                residency=RESIDENCY.summary(),
            )
            progress(stage='video sampled', **cache)
            del dit
        finally:
            if ahead:
                ahead.stop()
            pool.clear()
    del pool
    state.set('prompt_embeds', None)
    _free(scope={})

    # 4. Decode video and sound.
    progress(stage='decoding video')
    vae = minimax_h3_vae.video_vae(paths['vae'], 'decoder')
    audio_vae = minimax_h3_vae.audio_vae(paths['audioVae'])
    with torch.inference_mode():
        state = _stage('decode', dict(vae=vae, audio_vae=audio_vae), state, output_type='pt')
    videos, audio, rate = state.get('videos'), state.get('audio'), state.get('sampling_rate')
    del vae, audio_vae
    _free(scope={})
    progress(stage='video decoded')
    video = videos[0] if isinstance(videos, (list, tuple)) else videos[0]
    # [frames, channels, height, width] float in [0, 1] -> uint8 [frames, height, width, 3]
    pixels = (video.float().clamp(0, 1) * 255).round().byte().permute(0, 2, 3, 1).cpu().numpy()
    if len(pixels) != p['frames']:
        raise RuntimeError(f'Decoded {len(pixels)} frames, expected {p["frames"]}')
    generated_audio = None
    if p.get('audio', True):
        waveform = audio[0] if isinstance(audio, (list, tuple)) else audio
        waveform = waveform.float().reshape(-1, waveform.shape[-1]).cpu()
        if waveform.shape[0] == 1:
            waveform = waveform.repeat(2, 1)
        if not torch.isfinite(waveform).all():
            raise RuntimeError('Non-finite audio; no output saved')
        generated_audio = (waveform[:2].T.contiguous().numpy(), int(rate))
    if any(name == 'comfy' or name.startswith('comfy.') for name in sys.modules):
        raise RuntimeError('Unexpected Comfy runtime import')
    metadata = dict(
        job=job,
        parameters=p,
        seconds=round(time.perf_counter() - start, 2),
        peak_vram_gib=round(torch.cuda.max_memory_allocated() / 1024**3, 3),
        backend='pytorch-diffusers-minimax-h3',
        model=kind,
        frames=p['frames'],
        fps=24,
        stage=p['stage'],
        audio=generated_audio is not None,
        timeline=timeline,
        weight_cache=cache,
    )
    if continuation:
        metadata['continuation'] = continuation
    return save_video(pixels, config, job, metadata, audio=generated_audio)
