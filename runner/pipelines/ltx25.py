"""Native distilled LTX2.5: encode, bounded INT8 sample, tiled diffusion decode."""

from contextlib import ExitStack
import gc
import sys
import time

DISTILLED_SIGMAS = (1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875)


def check(job, family):
    """LTX2.5 rules beyond the manifest: conditioning combinations and continuation overlap."""
    parameters = job['parameters']
    roles = {ref['role'] for ref in job['references']}
    if {'start_image', 'source_video'} <= roles:
        raise ValueError('Choose a start image or source video, not both')
    if 'source_video' in roles:
        if parameters.get('overlap_frames', 9) >= parameters['frames']:
            raise ValueError('Invalid continuation overlap')


def preflight(job, config):
    """File-level checks run on CPU before the chat model is unloaded."""
    from runner.models.headers import header
    from runner.models.ltx25 import validate_layout, video_encoder
    from runner.video.msr import validate_msr

    headers = {role: header(path) for role, path in job['components'].items()}
    validate_layout(headers)
    if job['references']:
        video_encoder(headers)
    if job['parameters']['audio']:
        from runner.models.ltx25_audio import vocoder_layout

        vocoder_layout(headers)
    validate_msr(job, headers)
    for ref in job['references']:
        if ref['role'] == 'source_video':
            from runner.video.continuation import source_tail

            source_tail(ref['path'], job['parameters'])


def generate(job, config, progress):
    import torch
    from runner.models.headers import header
    from runner.models.ltx25 import validate_layout, video_encoder, WeightPool, load_streamed
    from runner.models.residency import RESIDENCY, open_store, prefetch
    from runner.models.ltx25_text import encode
    from runner.video.export import save_video
    from diffusers import LTX2Pipeline, LTX2ConditionPipeline, FlowMatchEulerDiscreteScheduler

    if not torch.cuda.is_available():
        raise RuntimeError('Native LTX2.5 requires CUDA')
    if torch.cuda.mem_get_info()[0] < 9 * 1024**3:
        raise RuntimeError('Free the other GPU models before generating video')
    start = time.perf_counter()
    torch.cuda.reset_peak_memory_stats()
    # Every stage with its elapsed time and GPU memory, kept with the video to find slow phases.
    timeline = []
    report = progress

    def progress(**data):
        entry = dict(
            data,
            seconds=round(time.perf_counter() - start, 2),
            allocated_gib=round(torch.cuda.memory_allocated() / 1024**3, 3),
            free_gib=round(torch.cuda.mem_get_info()[0] / 1024**3, 3),
            **memory(),
        )
        timeline.append({key: value for key, value in entry.items() if key != 'prompt'})
        report(**data)

    progress(stage='loading video prompt encoder')
    headers = {role: header(path) for role, path in job['components'].items()}
    continuation = None
    source_frames = None
    source_ref = next((ref for ref in job['references'] if ref['role'] == 'source_video'), None)
    if source_ref:
        from runner.video.continuation import source_tail

        source_frames, continuation = source_tail(source_ref['path'], job['parameters'])
    embeds, mask = encode(job, headers, progress)
    progress(stage='video prompt encoded', weights=getattr(encode, 'weights', None))
    setup = {}
    lap = time.perf_counter()

    def timed(name):
        nonlocal lap
        setup[name] = round(time.perf_counter() - lap, 2)
        lap = time.perf_counter()

    with ExitStack() as stack, torch.inference_mode():
        models, names = validate_layout(headers)
        del models['textEncoder']
        # Weights come from RAM-resident arenas when they fit (kept between jobs); the text
        # encoder file only lends its projection here, so it is not loaded for that alone.
        stores = {
            role: stack.enter_context(open_store(path, 'if-present' if role == 'textEncoder' else True))
            for role, path in job['components'].items()
        }
        adapters = []
        for index, item in enumerate(job['loras']):
            key = 'lora-' + str(index)
            stores[key] = stack.enter_context(open_store(item['path']))
            adapters.append((key, item['strength']))
        free = torch.cuda.mem_get_info()[0] / 1024**3
        p = job['parameters']
        # The share of the DiT kept on the GPU; the rest is copied from RAM at every step, at
        # about 12 GiB/s. What the model computes with comes first: 5 GiB (the connectors and
        # encoders at their peak, the allocator's slack, the engine's margin) plus the
        # activations, which grow with the video. Video memory that runs out halves the speed,
        # a smaller share costs a second per step at most.
        tokens = ((p['frames'] - 1) // 8 + 1) * (p['height'] // 32) * (p['width'] // 32)
        budget = max(0, free - 5 - tokens * 4096 * 2 * 24 / 1024**3)
        if 'cacheGiB' in config:
            budget = min(config['cacheGiB'], budget)
        hot = WeightPool(stores, budget, adapters=adapters)
        cold = WeightPool(stores, 0)
        # From here to the end of the first step, the disk reads the DiT in sequence: its
        # layers then find their weights in RAM instead of faulting them in one by one.
        ahead = prefetch(job['components'], stores, [*names['model'].values(), *names['connectors'].values()])
        timed('layouts and stores')
        try:
            transformer = load_streamed(models.pop('model'), names['model'], hot)
            timed('transformer')
            hot.preload()
            timed('weights kept on the GPU')
            connectors = load_streamed(models.pop('connectors'), names['connectors'], cold)
            timed('connectors')
            if job['references']:
                encoder, encoder_names = video_encoder(headers)
                vae = load_streamed(encoder, encoder_names, cold)
                del encoder, models['vae']
            else:
                vae = load_streamed(models.pop('vae'), names['vae'], cold)
            timed('vae')
            audio = load_streamed(models.pop('audioVae'), names['audioVae'], cold)
            timed('audio vae')
            pipeline = LTX2ConditionPipeline if job['references'] else LTX2Pipeline
            msr_refs = [ref for ref in job['references'] if ref['role'] == 'msr_image']
            if msr_refs:
                from runner.video.msr import pipeline_class

                pipeline = pipeline_class()
            pipe = pipeline(
                scheduler=FlowMatchEulerDiscreteScheduler(use_dynamic_shifting=False, shift_terminal=None),
                vae=vae,
                audio_vae=audio,
                text_encoder=None,
                tokenizer=None,
                connectors=connectors,
                transformer=transformer,
                vocoder=None,
            )
            pipe.set_progress_bar_config(disable=True)
            p = job['parameters']
            spatial_tokens = p['width'] // 32 * (p['height'] // 32)

            def keyframe_marker(_module, args, values):
                hidden = values['hidden_states']
                marker = torch.zeros((*hidden.shape[:2], 1), device=hidden.device, dtype=torch.bool)
                marker[:, :spatial_tokens] = True
                values['video_keyframes_mask'] = marker
                return args, values

            transformer.register_forward_pre_hook(keyframe_marker, with_kwargs=True)
            if continuation and p['audio'] and continuation['sourceAudio']:
                # Source sound under the overlap stays fixed, so the new audio continues it.
                from runner.video.audio_tail import encode_tail, protect_head

                progress(stage='encoding source audio')
                start_seconds = (continuation['sourceFrames'] - continuation['overlapFrames']) / p['fps']
                clean = encode_tail(
                    source_ref['path'], start_seconds, continuation['sourceFrames'] / p['fps'], audio, torch
                )
                if clean is not None:
                    clean = pipe._normalize_audio_latents(
                        pipe._pack_audio_latents(clean.to('cuda')), audio.latents_mean, audio.latents_std
                    )
                    protect_head(transformer, clean)
                    continuation['audioProtectedLatents'] = clean.shape[1]
                    del clean
            if msr_refs:
                pipe.msr_references = msr_refs
                pipe.msr_store = stores['lora-0']
                pipe.msr_frames = p.get('msr_frames', 33)
                pipe.msr_strength = p.get('msr_strength', 1)
            conditions = {}
            if job['references']:
                from PIL import Image
                from diffusers.pipelines.ltx2.pipeline_ltx2_condition import LTX2VideoCondition

                conditions['conditions'] = []
                for ref in job['references']:
                    if ref['role'] == 'msr_image':
                        continue
                    if ref['role'] == 'source_video':
                        conditions['conditions'].append(
                            LTX2VideoCondition(frames=source_frames, index=0, strength=1.0, crf=0)
                        )
                        continue
                    with Image.open(ref['path']) as image:
                        pixels = image.convert('RGB')
                    start_frame = ref['role'] == 'start_image'
                    conditions['conditions'].append(
                        LTX2VideoCondition(
                            frames=pixels,
                            index=0 if start_frame else -1,
                            strength=p.get('start_strength' if start_frame else 'end_strength', 0.7),
                            crf=p.get('image_compression', 18),
                        )
                    )

            def step(_pipe, index, _timestep, values):
                read = {'prefetch': ahead.stop()} if ahead and index == 0 else {}
                progress(stage='generating video', step=index + 1, total=8, weights=hot.summary(), **read)
                return values

            timed('conditions')
            progress(stage='sampling video', setup=setup)
            video, _audio = pipe(
                prompt_embeds=embeds.to('cuda'),
                prompt_attention_mask=mask.to('cuda'),
                height=p['height'],
                width=p['width'],
                num_frames=p['frames'],
                frame_rate=p['fps'],
                num_inference_steps=8,
                sigmas=list(DISTILLED_SIGMAS),
                guidance_scale=1,
                audio_guidance_scale=1,
                stg_scale=0,
                audio_stg_scale=0,
                modality_scale=1,
                audio_modality_scale=1,
                guidance_rescale=0,
                audio_guidance_rescale=0,
                generator=torch.Generator('cuda').manual_seed(p['seed']),
                output_type='latent',
                return_dict=False,
                callback_on_step_end=step,
                **conditions,
            )
            video = video.cpu()
            audio_latents = _audio.cpu()
            cache = dict(
                gpu_cache_gib=round(hot.bytes / 1024**3, 3),
                gpu_cache_limit_gib=round(budget, 3),
                pinned_model=stores['model'].pinned,
                residency=RESIDENCY.summary(),
            )
            progress(stage='video sampled', **cache)
            del _audio, pipe, transformer, connectors, vae, audio
        finally:
            if ahead:
                ahead.stop()
            hot.clear()
            cold.clear()
    del hot, cold, stores, models, embeds, mask
    gc.collect()
    torch.cuda.empty_cache()
    # Close the large DiT/Gemma mmaps before decode, so their CPU pages can be reclaimed.
    with open_store(job['components']['vae']) as source, torch.inference_mode():
        models, names = validate_layout(headers)
        vae = models.pop('vae')
        del models
        pool = WeightPool({'vae': source}, 0)
        try:
            vae = load_streamed(vae, names['vae'], pool)
            configure_decode(vae)
            progress(stage='decoding video')
            with torch._dynamo.config.patch(recompile_limit=64, fail_on_recompile_limit_hit=True):
                decoded = vae.decode(
                    video.to('cuda', dtype=torch.bfloat16), generator=torch.Generator('cuda').manual_seed(p['seed'])
                ).sample
            if not torch.isfinite(decoded).all():
                raise RuntimeError('Non-finite decoded video; no output saved')
            pixels = ((decoded[0].float().clamp(-1, 1) + 1) * 127.5).round().byte().permute(1, 2, 3, 0).cpu().numpy()
            progress(stage='video decoded')
        finally:
            del vae
            pool.clear()
    del decoded, pool
    gc.collect()
    torch.cuda.empty_cache()
    generated_audio = None
    if p['audio']:
        from runner.models.ltx25_audio import decode

        generated_audio = decode(audio_latents, job, headers, progress)
        progress(stage='audio decoded')
    if any(name == 'comfy' or name.startswith('comfy.') for name in sys.modules):
        raise RuntimeError('Unexpected Comfy runtime import')
    metadata = dict(
        job=job,
        parameters=p,
        seconds=round(time.perf_counter() - start, 2),
        peak_vram_gib=round(torch.cuda.max_memory_allocated() / 1024**3, 3),
        backend='pytorch-diffusers-int8',
        frames=p['frames'],
        fps=p['fps'],
        stage=p['stage'],
        audio=p['audio'],
        timeline=timeline,
        weight_cache=cache,
    )
    if continuation:
        metadata['continuation'] = continuation
    if msr_refs:
        metadata['msr'] = dict(
            slots=len(msr_refs),
            frames=p.get('msr_frames', 33),
            strength=p.get('msr_strength', 1),
            timeOffsets=list(range(-len(msr_refs), 0)),
        )
    return save_video(pixels, config, job, metadata, audio=generated_audio)


def memory():
    """Free RAM, this process's own share, what the disks have read since the system started
    and the VRAM PyTorch holds (in use or cached): tells a slow disk from a full memory, and
    a full GPU from a slow model."""
    result = {}
    torch = sys.modules.get('torch')
    if torch is not None and torch.cuda.is_initialized():
        result['reserved_gib'] = round(torch.cuda.memory_reserved() / 1024**3, 2)
    try:
        import psutil

        result.update(
            disk_read_gib=round(psutil.disk_io_counters().read_bytes / 1024**3, 2),
            ram_available_gib=round(psutil.virtual_memory().available / 1024**3, 1),
            ram_process_gib=round(psutil.Process().memory_info().rss / 1024**3, 1),
        )
    except Exception:
        pass
    return result


def configure_decode(vae):
    import torch
    import torch.nn.attention.flex_attention as flex

    if not getattr(configure_decode, 'compiled', False):
        # Eager attention AND eager mask construction materialize quadratic matrices.
        flex.flex_attention = torch.compile(flex.flex_attention, dynamic=False)
        flex.create_block_mask = torch.compile(flex.create_block_mask, dynamic=False)
        configure_decode.compiled = True
    vae.enable_tiling(
        tile_sample_min_height=256,
        tile_sample_min_width=256,
        tile_sample_min_num_frames=16,
        tile_sample_stride_height=192,
        tile_sample_stride_width=192,
        tile_sample_stride_num_frames=8,
    )
