"""Native distilled LTX2.5: encode, bounded INT8 sample, tiled diffusion decode."""

from contextlib import ExitStack
import gc
import sys
import time

DISTILLED_SIGMAS = (1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875)
# The second pass of a large video: its upscaled first pass, noised again to the first of
# these levels, then three steps at the full size.
REFINE_SIGMAS = (0.909375, 0.725, 0.421875)
# Below this side, half the size is too small for a first pass worth refining.
TWO_PASS_SIDE = 512
# As MiniMax-H3 does (runner.pipelines.minimax_h3): the model (20 GiB) does not fit whole in a
# 12 GiB card nor, beside the rest, in 32 GiB of RAM. The share of it that every step copies to
# the GPU is kept in page-locked RAM, leaving this much free, a little beyond what is copied so
# that the next video finds its weights there; and copied in advance, while the GPU computes the
# layers before. Read from the file through unlocked memory, those copies were the whole of a
# step: 1.85 s at 288 x 512 where ComfyUI takes 0.62 s (measured, 12.8 GiB copied per step).
RAM_RESERVE_GIB = 4
LOCK_MARGIN_GIB = 0.5
AHEAD_GIB = 0.5
# Video memory the tiles of the decode take at their peak, in GiB (measured at 896 x 1600).
DECODE_GIB = 6


def working_gib(parameters, width, height, subjects):
    """Video memory the model computes with beside its weights while sampling at this size, in
    GiB: 5 (the connectors and encoders at their peak, the allocator's slack, the engine's margin)
    plus the activations, which grow with the video. Each subject reference adds its own short
    clip of tokens to the sequence."""
    area = (height // 32) * (width // 32)
    clip = (parameters.get('msr_frames', 33) - 1) // 8 + 1
    tokens = area * ((parameters['frames'] - 1) // 8 + 1 + subjects * clip)
    return 5 + tokens * 4096 * 2 * 30 / 1024**3


def first_pass_size(parameters, components):
    """The half size a large video is first sampled at, or None for a single pass.

    Sampling costs grow faster than the picture: at 896 × 1600 each step takes many times a
    step at 448 × 800. With the latent upscaler, the eight steps run at half the size, the
    result is doubled in latent space and three steps at the full size restore the detail:
    the model's own two-pass recipe. Odd latent sizes round the half up; the doubled result
    is cropped back.
    """
    if 'upscaler' not in components:
        return None
    width, height = parameters['width'] // 32, parameters['height'] // 32
    if min(width, height) * 32 < TWO_PASS_SIDE:
        return None
    return (width + 1) // 2 * 32, (height + 1) // 2 * 32


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
    if 'upscaler' in headers:
        from runner.models.ltx25 import latent_upscaler

        latent_upscaler(headers['upscaler'])
    for ref in job['references']:
        if ref['role'] == 'source_video':
            from runner.video.continuation import source_tail

            source_tail(ref['path'], job['parameters'])


def generate(job, config, progress):
    import torch
    from runner.models import conditioning
    from runner.models.headers import header
    from runner.models.ltx25 import (
        validate_layout,
        video_encoder,
        WeightPool,
        load_streamed,
        latent_upscaler,
        chunk_feed_forwards,
    )
    from runner.models.residency import RESIDENCY, open_store, prefetch, use_order
    from runner.models.ltx25_text import encode
    from runner.video.export import save_video
    from diffusers import LTX2Pipeline, LTX2ConditionPipeline, FlowMatchEulerDiscreteScheduler

    if not torch.cuda.is_available():
        raise RuntimeError('Native LTX2.5 requires CUDA')
    from runner.models.pool import require

    # Asked for before anything is loaded: what the model computes with for the first pass of
    # this video. Its weights follow the card (see `share` below).
    p = job['parameters']
    subjects = sum(ref['role'] == 'msr_image' for ref in job['references'])
    require(
        'LTX 2.5',
        working_gib(p, *(first_pass_size(p, job['components']) or (p['width'], p['height'])), subjects),
        'la taille ou la durée de la vidéo',
    )
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
    # A prompt this encoder has already read comes back from the disk: the 12 GiB encoder
    # is not loaded, and the video model stays in the system's file cache.
    entry = conditioning.key('ltx25', conditioning.stamp(job['components']['textEncoder']), job['parameters']['prompt'])
    found = conditioning.load(config, entry)
    if found:
        embeds, mask = found[0]['embeds'], found[0]['mask']
        progress(stage='video prompt encoded', conditioning='kept from an earlier generation')
    else:
        embeds, mask = encode(job, headers, progress)
        kept = conditioning.save(config, entry, {'embeds': embeds, 'mask': mask})
        progress(
            stage='video prompt encoded',
            weights=getattr(encode, 'weights', None),
            conditioning='kept for the next generations' if kept else 'not kept',
        )
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
            if role != 'upscaler'
        }
        adapters = []
        for index, item in enumerate(job['loras']):
            key = 'lora-' + str(index)
            stores[key] = stack.enter_context(open_store(item['path']))
            adapters.append((key, item['strength']))
        free = torch.cuda.mem_get_info()[0] / 1024**3
        # The share of the DiT kept on the GPU; the rest is copied from RAM at every step, at
        # about 12 GiB/s. What the model computes with comes first (working_gib). Video memory
        # that runs out halves the speed, a smaller share costs a second per step at most.
        first = first_pass_size(p, job['components'])

        def share(width, height):
            """GiB of the DiT kept on the GPU while sampling at this size."""
            kept = max(0, free - working_gib(p, width, height, subjects) - AHEAD_GIB)
            return min(config['cacheGiB'], kept) if 'cacheGiB' in config else kept

        budget = share(*(first or (p['width'], p['height'])))
        hot = WeightPool(stores, budget, adapters=adapters, ahead_gib=AHEAD_GIB)
        cold = WeightPool(stores, 0)
        ahead = None
        timed('layouts and stores')
        try:
            transformer = chunk_feed_forwards(load_streamed(models.pop('model'), names['model'], hot))
            timed('transformer')
            # What will not stay on the GPU goes to page-locked RAM once, for every step and the
            # next videos. The second pass of a large video keeps less there: what it copies
            # beyond the first is locked too when RAM allows, else read from the file as before.
            reserve = int(RAM_RESERVE_GIB * 1024**3)
            copied = hot.streamed().get('model', ())
            later = max(LOCK_MARGIN_GIB, budget - share(p['width'], p['height'])) if first else LOCK_MARGIN_GIB
            locked = stores['model'].keep(copied, reserve, spare=hot.streamed(later, onward=True).get('model', ()))
            if not locked and first:
                locked = stores['model'].keep(
                    copied, reserve, spare=hot.streamed(LOCK_MARGIN_GIB, onward=True).get('model', ())
                )
            timed('weights locked in RAM')
            # From here to the end of the first step, the disk reads in sequence what is not
            # locked (the share that stays on the GPU, the connectors): the layers then find
            # their weights in RAM instead of faulting them in one by one. What is locked was
            # read once; read again here, it pushed everything else out of the system's cache.
            held = stores['model'].part.header if stores['model'].part else {}
            order = [*use_order(names['connectors']), *use_order(names['model'])]
            ahead = prefetch(
                job['components'],
                stores,
                [location for location in order if location[0] != 'model' or location[1] not in held],
                lead=lambda: hot.used() + cold.used(),
            )
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
            # The size being sampled: the first pass of a large video runs at half of it.
            current = dict(width=p['width'], height=p['height'])

            def keyframe_marker(_module, args, values):
                hidden = values['hidden_states']
                marker = torch.zeros((*hidden.shape[:2], 1), device=hidden.device, dtype=torch.bool)
                marker[:, : current['width'] // 32 * (current['height'] // 32)] = True
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
            images = {}
            if job['references']:
                from PIL import Image
                from diffusers.pipelines.ltx2.pipeline_ltx2_condition import LTX2VideoCondition

                for ref in job['references']:
                    if ref['role'] in ('start_image', 'end_image'):
                        with Image.open(ref['path']) as image:
                            images[ref['input']] = image.convert('RGB')

            def conditions(refining):
                """The images and source frames that guide this pass. The refining pass holds
                the first frame exactly: the first pass only followed it."""
                if not job['references']:
                    return {}
                found = []
                for ref in job['references']:
                    if ref['role'] == 'msr_image':
                        continue
                    if ref['role'] == 'source_video':
                        found.append(LTX2VideoCondition(frames=source_frames, index=0, strength=1.0, crf=0))
                        continue
                    start_frame = ref['role'] == 'start_image'
                    found.append(
                        LTX2VideoCondition(
                            frames=images[ref['input']],
                            index=0 if start_frame else -1,
                            strength=1.0
                            if start_frame and refining
                            else p.get('start_strength' if start_frame else 'end_strength', 0.7),
                            crf=p.get('image_compression', 18),
                        )
                    )
                return {'conditions': found}

            passes = [(first, DISTILLED_SIGMAS), ((p['width'], p['height']), REFINE_SIGMAS)] if first else []
            passes = passes or [((p['width'], p['height']), DISTILLED_SIGMAS)]
            total = sum(len(sigmas) for _, sigmas in passes)
            generator = torch.Generator('cuda').manual_seed(p['seed'])

            def sample(size, sigmas, done, refine=None):
                current['width'], current['height'] = size

                def step(_pipe, index, _timestep, values):
                    read = {'prefetch': ahead.stop()} if ahead and not done and index == 0 else {}
                    progress(
                        stage='generating video', step=done + index + 1, total=total, weights=hot.summary(), **read
                    )
                    return values

                return pipe(
                    prompt_embeds=embeds.to('cuda'),
                    prompt_attention_mask=mask.to('cuda'),
                    height=size[1],
                    width=size[0],
                    num_frames=p['frames'],
                    frame_rate=p['fps'],
                    num_inference_steps=len(sigmas),
                    sigmas=list(sigmas),
                    guidance_scale=1,
                    audio_guidance_scale=1,
                    stg_scale=0,
                    audio_stg_scale=0,
                    modality_scale=1,
                    audio_modality_scale=1,
                    guidance_rescale=0,
                    audio_guidance_rescale=0,
                    generator=generator,
                    output_type='latent',
                    return_dict=False,
                    callback_on_step_end=step,
                    **(refine or {}),
                    **conditions(bool(refine)),
                )

            timed('conditions')
            progress(stage='sampling video', setup=setup, passes=[list(size) for size, _ in passes])
            video, _audio = sample(*passes[0], 0)
            if first:
                # The full size leaves less room for weights: all of them leave the GPU, so that
                # what is free is in one piece for the upscaler and the larger activations.
                budget = share(p['width'], p['height'])
                hot.resize(0)
                progress(stage='upscaling video latents', gpu_cache_limit_gib=round(budget, 3))
                with open_store(job['components']['upscaler'], False) as source:
                    upscaler = latent_upscaler(headers['upscaler'], source)
                    video = upscaler(video.to('cuda', dtype=torch.bfloat16)).float()
                    del upscaler
                # An odd latent size was rounded up for the first pass: keep the middle.
                rows, columns = p['height'] // 32, p['width'] // 32
                top, left = (video.shape[-2] - rows) // 2, (video.shape[-1] - columns) // 2
                video = video[..., top : top + rows, left : left + columns].contiguous()
                torch.cuda.empty_cache()
                refine = dict(latents=video, audio_latents=_audio.float(), noise_scale=REFINE_SIGMAS[0])
                del video, _audio
                hot.resize(budget)
                progress(stage='refining video')
                try:
                    video, _audio = sample(*passes[1], len(passes[0][1]), refine=refine)
                except torch.OutOfMemoryError:
                    video = None
                if video is None:
                    # Memory ran short with weights kept on the GPU: three steps again with
                    # none kept (each a little slower) cost far less than starting over.
                    hot.resize(0)
                    progress(stage='refining video', gpu_cache_limit_gib=0)
                    video, _audio = sample(*passes[1], len(passes[0][1]), refine=refine)
                    budget = 0
            video = video.cpu()
            audio_latents = _audio.cpu()
            cache = dict(
                gpu_cache_gib=round(hot.bytes / 1024**3, 3),
                gpu_cache_limit_gib=round(budget, 3),
                pinned_model=stores['model'].pinned,
                locked_ram_gib=round(locked / 1024**3, 3),
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
    # The large DiT/Gemma mappings are closed before the decode: their pages can be reclaimed.
    pixels = decode_pixels(job, headers, video, progress)
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
        passes=[dict(width=size[0], height=size[1], steps=len(sigmas)) for size, sigmas in passes],
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


def tiling(length, largest, overlap):
    """(tile, stride) in cells: equal tiles of at most `largest`, sharing at least `overlap`,
    that cover `length` exactly, with the least to compute."""
    if length <= largest:
        return length, length
    first = -(-(length - overlap) // (largest - overlap))
    best = None
    for count in range(first, first + 17):
        # The stride that keeps the tile within `largest`, and the one that keeps the overlap.
        low, high = -(-(length - largest) // (count - 1)), (length - overlap) // count
        if low <= high:
            tile = length - (count - 1) * high
            if best is None or count * tile < best[0]:
                best = (count * tile, tile, high)
    if best:
        return best[1], best[2]
    stride = (length - overlap) // first
    return length - (first - 1) * stride, stride


def equal_tiles(length, tile, stride, _min_size=0):
    """Tiles `stride` apart, all of `tile` cells when `tiling` chose them (the last ends the video)."""
    if length <= tile:
        return [(0, length)]
    count = -(-(length - tile) // stride) + 1
    return [(index * stride, min(index * stride + tile, length)) for index in range(count - 1)] + [
        ((count - 1) * stride, length)
    ]


# The largest tile the last decoder stages run on, and what two tiles share to hide their seam,
# in cells of 8 pixels and 2 frames: 256 pixels and 64 frames, 32 pixels and 8 frames shared.
# Measured on a 896 × 1600 clip of 121 frames: wider tiles cost as much (the decoder's local
# attention works on whole rows of a tile), a wider overlap decodes up to twice the video.
TILE = dict(frames=32, side=32, overlap_frames=4, overlap_side=4)


def configure_decode(vae, shape):
    """Tiled decode with tiles of one size: returns the plan, for the timeline.

    The decoder's attention is compiled for each tile shape it meets (seconds each time). The
    library's own tiling ends every axis on a shorter tile, up to eight shapes for one video;
    equal tiles leave the first and last in time as the only different ones.
    """
    import torch
    import torch.nn.attention.flex_attention as flex
    from diffusers.models.autoencoders import ltx2_diffusion_decoder as library

    if not getattr(configure_decode, 'compiled', False):
        # Eager attention AND eager mask construction materialize quadratic matrices.
        flex.flex_attention = torch.compile(flex.flex_attention, dynamic=False)
        flex.create_block_mask = torch.compile(flex.create_block_mask, dynamic=False)
        configure_decode.compiled = True
    tile = TILE
    decoder = vae.decoder
    stride = decoder.upsamples[-1].stride
    cell_frames, cell_side = stride[0], stride[1] * decoder.patch_size
    ratio_frames, ratio_side = vae.temporal_compression_ratio, vae.spatial_compression_ratio
    # Cells of the grid the tiles are cut on, from the latent size.
    frames = ((shape[2] - 1) * ratio_frames + 1 + cell_frames - 1) // cell_frames
    height, width = shape[3] * ratio_side // cell_side, shape[4] * ratio_side // cell_side
    plan = dict(
        frames=tiling(frames, tile['frames'], tile['overlap_frames']),
        height=tiling(height, tile['side'], tile['overlap_side']),
        width=tiling(width, tile['side'], tile['overlap_side']),
    )
    library._tile_intervals = equal_tiles
    vae.enable_tiling(
        tile_sample_min_height=plan['height'][0] * cell_side,
        tile_sample_min_width=plan['width'][0] * cell_side,
        tile_sample_min_num_frames=plan['frames'][0] * cell_frames,
        tile_sample_stride_height=plan['height'][1] * cell_side,
        tile_sample_stride_width=plan['width'][1] * cell_side,
        tile_sample_stride_num_frames=plan['frames'][1] * cell_frames,
    )
    return {
        axis: dict(cells=cells, tile=size, stride=step, tiles=len(equal_tiles(cells, size, step)))
        for (axis, (size, step)), cells in zip(plan.items(), (frames, height, width))
    }


def decode_pixels(job, headers, latents, progress):
    """Video latents to frames (uint8, frames × height × width × 3), tile by tile."""
    import numpy
    import torch
    from runner.models.ltx25 import validate_layout, WeightPool, load_streamed
    from runner.models.pool import room
    from runner.models.residency import open_store

    seed = job['parameters']['seed']
    with open_store(job['components']['vae']) as source, torch.inference_mode():
        models, names = validate_layout(headers)
        vae = models.pop('vae')
        del models
        # The decoder stays on the GPU while it works, where there is room beside its tiles
        # (5.6 GiB at their peak): each tile runs it several times.
        entries = (entry for name, entry in headers['vae'].items() if name != '__metadata__')
        size = sum(entry['data_offsets'][1] - entry['data_offsets'][0] for entry in entries)
        pool = WeightPool({'vae': source}, size / 1024**3 if room(DECODE_GIB) * 1024**3 >= size else 0)
        try:
            vae = load_streamed(vae, names['vae'], pool)
            plan = configure_decode(vae, latents.shape)
            progress(stage='decoding video', tiles=plan)
            # The decode is the longest silent stage of a large video: say where it is.
            total = plan['frames']['tiles'] * plan['height']['tiles'] * plan['width']['tiles']
            denoise, done, told = vae.decoder.denoise, 0, time.perf_counter()

            def counted(*args, **kwargs):
                nonlocal done, told
                result = denoise(*args, **kwargs)
                done += 1
                if done in (1, total) or time.perf_counter() - told > 5:
                    told = time.perf_counter()
                    progress(stage='decoding video', tile=done, tiles=total)
                return result

            vae.decoder.denoise = counted
            with torch._dynamo.config.patch(recompile_limit=64, fail_on_recompile_limit_hit=True):
                decoded = vae.decode(
                    latents.to('cuda', dtype=torch.bfloat16), generator=torch.Generator('cuda').manual_seed(seed)
                ).sample
            # A few frames at a time: the whole video as 32-bit floats would not fit beside itself.
            frames = []
            for start in range(0, decoded.shape[2], 8):
                part = decoded[0, :, start : start + 8].float()
                if not torch.isfinite(part).all():
                    raise RuntimeError('Non-finite decoded video; no output saved')
                frames.append(((part.clamp(-1, 1) + 1) * 127.5).round().byte().permute(1, 2, 3, 0).cpu().numpy())
            del decoded, part
            progress(stage='video decoded')
        finally:
            del vae
            pool.clear()
    gc.collect()
    torch.cuda.empty_cache()
    return numpy.concatenate(frames)
