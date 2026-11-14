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
# Video memory a decode in the smallest tiles takes at its peak, in GiB (measured at 896 x 1600).
DECODE_GIB = 6


def working_gib(parameters, width, height, subjects):
    """Video memory the steps need beside the weights kept on the GPU while sampling at this
    size, in GiB. Each subject reference adds its own short clip of tokens to the sequence.

    Measured on a 12 GiB card (peak allocated beyond the kept weights and the copies ahead):
    0.76 GiB for 2 304 tokens (288 x 512), 1.13 for 5 600 (448 x 800), 2.61 for 22 400
    (896 x 1600), of which 0.38 are the last layers used (RECENT). To that: the engine's margin
    (1 GiB below what is free, runner.engine), the blocks PyTorch holds between two sizes
    (0.6 GiB seen), and half a gigabyte to spare. What the pipeline computes once before the
    steps, the connectors and the encoders, is not in it: the share of the weights is filled
    after them (see `fill`)."""
    area = (height // 32) * (width // 32)
    clip = (parameters.get('msr_frames', 33) - 1) // 8 + 1
    tokens = area * ((parameters['frames'] - 1) // 8 + 1 + subjects * clip)
    return 2.6 + 0.1 * tokens / 1000


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


# The files already checked by preflight in this process, by what tells one version of a file
# from another: the same files are checked once, not twice at every generation.
CHECKED = set()


def preflight(job, config):
    """File-level checks run on CPU before the chat model is unloaded.

    Checking the files builds every model empty to compare it with them: half a second, asked
    twice for each generation (by the application, then by the worker before it generates).
    A set of files that passed is not checked again while none of them has changed."""
    from runner.models import conditioning
    from runner.models.headers import header
    from runner.models.ltx25 import validate_layout, video_encoder
    from runner.video.msr import validate_loras

    stamps = [(role, conditioning.stamp(path)) for role, path in sorted(job['components'].items())]
    stamps += [('lora', conditioning.stamp(item['path'])) for item in job['loras']]
    roles = sorted({ref['role'] for ref in job['references']})
    files = repr((stamps, roles, bool(job['parameters']['audio'])))
    if files not in CHECKED:
        headers = {role: header(path) for role, path in job['components'].items()}
        validate_layout(headers)
        if job['references']:
            video_encoder(headers)
        if job['parameters']['audio']:
            from runner.models.ltx25_audio import vocoder_layout

            vocoder_layout(headers)
        validate_loras(job, headers)
        if 'upscaler' in headers:
            from runner.models.ltx25 import latent_upscaler

            latent_upscaler(headers['upscaler'])
        CHECKED.add(files)
    for ref in job['references']:
        if ref['role'] == 'source_video':
            from runner.video.continuation import source_tail

            source_tail(ref['path'], job['parameters'])


class Loaded:
    """The video model as one generation leaves it for the next (runner.models.kept): its files
    open, its layers built, and the share of its weights that stays on the GPU."""

    def __init__(self, key):
        self.key, self.stack, self.stores, self.adapters = key, ExitStack(), {}, []
        self.transformer = self.hot = None
        # Video memory all this holds, measured once the generation that leaves it is over.
        self.allocated = 0
        # Whether what its steps copy to the GPU comes from page-locked RAM (see generate).
        self.locked = True

    def drop(self):
        try:
            if self.hot is not None:
                self.hot.clear()
        finally:
            # Whatever the card answered, the files are closed and their RAM given back.
            self.transformer = self.hot = None
            self.stack.close()


def decode_floor_gib(shape):
    """Video memory the decode of latents of this shape needs at least, in GiB: what the whole
    video holds whatever the tiles, one of the smallest tiles, and what decode_pixels leaves
    free (see configure_decode, which counts the same from the decoder itself)."""
    frames, height, width = (shape[2] - 1) * 4 + 1, shape[3] * 4, shape[4] * 4
    features = (frames + 8) * height * width * 512 * 2
    pixels = frames * 2 * height * 8 * width * 8 * 3 * 2
    tile = min(frames, TILE['frames']) * min(height, TILE['side']) * min(width, TILE['side']) * 8
    return (features + 2.5 * pixels + tile * TILE_TOKEN_BYTES) / 1024**3 + 2


class Refit(Exception):
    """The model the last generation left does not suit this one: it is built anew.

    Taken back with a share of another size, it could not be given the page-locked RAM of this
    one: its file is still open, the pages read for its share count against the free RAM, and
    the steps copied from unlocked memory (measured: 12 to 14 s a draft instead of 8, for the
    rest of the series). Dropped and built again, it is a first video, as before it was kept."""


def generate(job, config, progress):
    """One video. The model the last generation left on the GPU is taken back when it is the
    one this job asks for (same file, same LoRAs) for a video of the same shape, and left there
    again at the end. Another size or another conditioning leaves the model another share of the
    card: it is then built anew."""
    from runner.models import conditioning, kept

    p = job['parameters']
    files = [job['components']['model'], *(item['path'] for item in job['loras'])]
    shape = [p['width'], p['height'], p['frames'], sorted(ref['role'] for ref in job['references'])]
    shape.append('upscaler' in job['components'])
    key = [[conditioning.stamp(path) for path in files], [item['strength'] for item in job['loras']], shape]
    holder = [kept.take('ltx25', key)]
    try:
        try:
            result = _generate(job, config, progress, key, holder)
        except Refit:
            result = None
        if result is None:
            # Out of the handler: the error would keep what the first attempt held until here.
            stale, holder[0] = holder[0], None
            stale.drop()
            result = _generate(job, config, progress, key, holder)
    except BaseException:
        # Whatever state the failure left it in, it is not one to start the next video from.
        if holder[0] is not None:
            holder[0].drop()
        raise
    loaded = holder[0]
    if not loaded.locked:
        # RAM was short when it was built: its steps copied from the file's mapping, at half
        # the speed, and those pages (the whole model) stay in this process while the file is
        # open, so that the next video would find no room to lock either. Not kept: the next
        # one builds it anew, with the RAM this gives back.
        loaded.drop()
    else:
        kept.put('ltx25', loaded)
    return result


def _generate(job, config, progress, key, holder):
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
        kept_text,
        spread,
    )
    from runner.models.ltx25_block import fuse
    from runner.models.residency import RESIDENCY, open_store, prefetch, use_order
    from runner.models.ltx25_text import encode
    from runner.video.export import save_video
    from diffusers import LTX2Pipeline, LTX2ConditionPipeline, FlowMatchEulerDiscreteScheduler

    if not torch.cuda.is_available():
        raise RuntimeError('Native LTX2.5 requires CUDA')
    from runner.models.pool import require, room

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
    # A prompt already read comes back from the disk: the 12 GiB encoder is not loaded, and the
    # video model stays in the system's file cache. What is kept is the text as the model reads
    # it, after the connectors (see below): it depends on the prompt, the encoder and the model's
    # file. What the encoder alone gave, kept by earlier versions, is still read.
    stamps = [conditioning.stamp(job['components'][role]) for role in ('textEncoder', 'model')]
    text_entry = conditioning.key('ltx25 connected', *stamps, job['parameters']['prompt'])
    found = conditioning.load(config, text_entry)
    text, embeds, mask = (found[0], None, None) if found else (None, None, None)
    if text is None:
        found = conditioning.load(config, conditioning.key('ltx25', stamps[0], job['parameters']['prompt']))
        if found:
            embeds, mask = found[0]['embeds'], found[0]['mask']
    if text is None and holder[0] is not None and holder[0].hot is not None:
        # A prompt to read: its encoder, then the connectors, have the card to themselves as
        # they always had. The share of the model the last generation left there goes (its
        # layers stay built), and is filled again when the model first runs.
        holder[0].hot.clear()
        gc.collect()
        torch.cuda.empty_cache()
    if found:
        progress(stage='video prompt encoded', conditioning='kept from an earlier generation')
    else:
        embeds, mask = encode(job, headers, progress)
        progress(stage='video prompt encoded', weights=getattr(encode, 'weights', None))
    setup = {}
    lap = time.perf_counter()

    def timed(name):
        nonlocal lap
        setup[name] = round(time.perf_counter() - lap, 2)
        lap = time.perf_counter()

    # A model taken back from the last generation: this one is the next of a run (the Studio).
    loaded = holder[0]
    again = loaded is not None
    with ExitStack() as stack, torch.inference_mode():
        # Only what this generation runs is built: not the text encoder (its own module builds
        # it when a prompt is new), nor the connectors of a prompt whose text is kept, nor the
        # decoder (decode_pixels) unless the pipeline is given it for want of an encoder, nor
        # the model when the last generation left it.
        wanted = ['audioVae', *([] if again else ['model']), *(['connectors'] if text is None else [])]
        wanted += [] if job['references'] else ['vae']
        models, names = validate_layout(headers, wanted)
        if not again:
            # The model's file and its LoRAs stay open with it, beyond this generation.
            loaded = holder[0] = Loaded(key)
            loaded.stores['model'] = loaded.stack.enter_context(open_store(job['components']['model'], True))
            for index, item in enumerate(job['loras']):
                name = 'lora-' + str(index)
                loaded.stores[name] = loaded.stack.enter_context(open_store(item['path']))
                loaded.adapters.append((name, item['strength']))
        # Weights come from RAM-resident arenas when they fit (kept between jobs); the text
        # encoder file only lends its projection here, so it is not loaded for that alone.
        stores = dict(loaded.stores)
        for role, path in job['components'].items():
            if role not in ('upscaler', 'model'):
                stores[role] = stack.enter_context(open_store(path, 'if-present' if role == 'textEncoder' else True))
        # What this process may hold: what is free, and what it holds already (the model left by
        # the last generation, which the card no longer counts as free).
        free = (torch.cuda.mem_get_info()[0] + torch.cuda.memory_reserved()) / 1024**3
        # The share of the DiT kept on the GPU; the rest is copied from RAM at every step, at
        # about 12 GiB/s. What the model computes with comes first (working_gib). Video memory
        # that runs out halves the speed, a smaller share costs a second per step at most.
        first = first_pass_size(p, job['components'])
        # What stays on the GPU beside the model while it runs, in GiB: known once the encoders
        # are built (below).
        beside = 0.0

        def share(width, height):
            """GiB of the DiT kept on the GPU while sampling at this size."""
            kept = max(0, free - beside - working_gib(p, width, height, subjects) - AHEAD_GIB)
            return min(config['cacheGiB'], kept) if 'cacheGiB' in config else kept

        if not again:
            loaded.hot = WeightPool(loaded.stores, 0, adapters=loaded.adapters, ahead_gib=AHEAD_GIB)
        hot = loaded.hot
        cold = WeightPool(stores, 0)
        ahead = None
        # What this generation hangs on the model, taken off again at its end.
        hooks = []
        timed('layouts and stores')
        try:
            if again:
                transformer = loaded.transformer
                hot.stats.update(dict.fromkeys(hot.stats, 0.0))
                getattr(transformer, '_masks', {}).clear()
            else:
                transformer = loaded.transformer = load_streamed(models.pop('model'), names['model'], hot)
                # The blocks kept on the GPU are spread through the model: see spread.
                hot.order = spread(hot.order)
                # Blocks of another kind keep diffusers' own computation, their feed-forwards in slices.
                if not fuse(transformer):
                    chunk_feed_forwards(transformer)
            # What each LoRA changes: the layers of the model it has pairs for, among those whose
            # weights the pool serves. One that changes none (its pairs are all for the text
            # connectors, say) is refused here, not left to make the same video without it.
            changed = hot.applied()
            for index, item in enumerate(job['loras']):
                if not changed['lora-' + str(index)]:
                    raise ValueError(f'Incompatible LoRA: none of its layers is applied to this model ({item["id"]})')
            if changed:
                setup['lora layers'] = list(changed.values())
            timed('transformer')
            if job['references']:
                encoder, encoder_names = video_encoder(headers)
                vae = load_streamed(encoder, encoder_names, cold)
                del encoder
            else:
                vae = load_streamed(models.pop('vae'), names['vae'], cold)
            timed('vae')
            audio = load_streamed(models.pop('audioVae'), names['audioVae'], cold)
            timed('audio vae')
            # Their convolutions are on the GPU from here to the end of the steps (0.7 GiB for
            # the encoder of an image or of a source video, 0.1 without): they come off the share
            # of the model. Left out, a video from an image ran its steps with 45 MiB free.
            beside = max(0, torch.cuda.memory_allocated() - hot.bytes) / 1024**3
            budget = share(*(first or (p['width'], p['height'])))
            # The share the last generation left is this one's when it is about what this video
            # leaves the model (a quarter of a gigabyte over is within what the steps are given
            # to spare; half a gigabyte under is what the page-locked RAM was built to cover):
            # nothing to read again. Else it is filled anew at this video's size.
            near = (budget - LOCK_MARGIN_GIB) * 1024**3 <= hot.limit
            ready = bool(hot.gpu) and near and hot.bytes <= (budget + 0.25) * 1024**3
            if ready:
                budget = hot.limit / 1024**3
            else:
                if again and hot.gpu:
                    # A share of another size than this video leaves it (halved for want of
                    # memory, or the card filled by something else since): see Refit.
                    raise Refit
                hot.limit = int(budget * 1024**3)
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
            loaded.locked = not copied or stores['model'].pinned
            timed('weights locked in RAM')
            # From here to the end of the first step, the disk reads in sequence what is not
            # locked (the share that stays on the GPU, the connectors): the layers then find
            # their weights in RAM instead of faulting them in one by one. What is locked was
            # read once; read again here, it pushed everything else out of the system's cache.
            held = stores['model'].part.header if stores['model'].part else {}
            # In the order they are asked for: the connectors, then the share of the model.
            order = [*(use_order(names['connectors']) if text is None else ()), *(() if ready else hot.order)]
            ahead = prefetch(
                job['components'],
                stores,
                [location for location in order if location[0] != 'model' or location[1] not in held],
                lead=lambda: hot.used() + cold.used(),
            )
            # The share is filled when the model first runs, not here: what the pipeline computes
            # once before the steps (the text connectors, 1.4 GiB in one weight; the encoder of an
            # image or of a source video) then has the whole card, and the steps only need room
            # for their own tensors beside the weights. Filled here, the share had to leave those
            # 5 GiB free at every step: 4.7 GiB of the model stayed on a 12 GiB card, the other
            # 15 were copied at each step and the steps waited for the bus.
            due = [] if ready else [budget]

            def fill(_module, _inputs):
                if cold.recent or due:
                    # What those ran with leaves first: the last layers of an encoder stay on the
                    # GPU for a moment (RECENT), and PyTorch keeps the blocks it has freed.
                    cold.clear()
                    torch.cuda.empty_cache()
                if due:
                    began = time.perf_counter()
                    hot.resize(due.pop())
                    spent = setup.get('weights kept on the GPU', 0) + time.perf_counter() - began
                    setup['weights kept on the GPU'] = round(spent, 2)

            hooks.append(transformer.register_forward_pre_hook(fill))
            if text is None:
                # The connectors turn what the encoder gave into the text the model reads, and that
                # depends on the prompt alone. They run once, here, while no weight of the model is
                # on the GPU (their first layer is one weight of 1.4 GiB), and their result is kept
                # in the place of the encoder's, thirty times larger (385 MiB a prompt): another
                # seed or size then reads 12 MiB instead of running them again.
                connectors = load_streamed(models.pop('connectors'), names['connectors'], cold)
                found = connectors(embeds.to('cuda'), mask.to('cuda'), padding_side='left')
                text = dict(zip(('video', 'audio', 'mask'), found))
                del connectors, found
                cold.clear()
                setup['text kept'] = conditioning.save(config, text_entry, text)
            connectors = kept_text(*(text[name].to('cuda') for name in ('video', 'audio', 'mask')))
            del text
            timed('connectors')
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

            hooks.append(transformer.register_forward_pre_hook(keyframe_marker, with_kwargs=True))
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
                    hooks.extend(protect_head(transformer, clean))
                    continuation['audioProtectedLatents'] = clean.shape[1]
                    del clean
            if msr_refs:
                pipe.msr_references = msr_refs
                from runner.video.msr import msr_index

                pipe.msr_store = stores['lora-' + str(msr_index(job))]
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
                    # The text is already connected (kept_text): the pipeline only passes these on.
                    prompt_embeds=torch.zeros(1, 1, 1, device='cuda', dtype=torch.bfloat16),
                    prompt_attention_mask=torch.ones(1, 1, device='cuda'),
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
            try:
                video, _audio = sample(*passes[0], 0)
            except torch.OutOfMemoryError:
                video = None
            if video is None:
                # The steps needed more than was set aside for them (working_gib): once again
                # with half the weights kept, rather than a failure after the model was read.
                budget /= 2
                due[:] = [budget]
                progress(stage='sampling video', gpu_cache_limit_gib=round(budget, 3))
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
                due.append(budget)
                progress(stage='refining video')
                try:
                    video, _audio = sample(*passes[1], len(passes[0][1]), refine=refine)
                except torch.OutOfMemoryError:
                    video = None
                if video is None:
                    # Memory ran short with weights kept on the GPU: three steps again with
                    # none kept (each a little slower) cost far less than starting over.
                    due.clear()
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
            for hook in hooks:
                hook.remove()
            if ahead:
                ahead.stop()
            cold.clear()
    del cold, stores, models, embeds, mask
    # The share of the model stays on the GPU through the decode for the next video of a run
    # (`again`), when the decode has its room beside it: the next video then starts at its first
    # step, where reading the share from the disk took 3 s. A first video, or one the chat asked
    # for, gives the card to its decode as before; so does a video too large for both.
    hot.settle()
    gc.collect()
    torch.cuda.empty_cache()
    if not (again and room(0) >= decode_floor_gib(video.shape)):
        # Its weights and LoRAs leave the GPU; its layers and their order stay with it.
        hot.clear()
    del hot
    # The pages of the file read for the share of the GPU go back to the system: the file stays
    # open with the model, and they counted against the free RAM until the next video.
    loaded.stores['model'].reopen()
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
    result = save_video(pixels, config, job, metadata, audio=generated_audio)
    del pixels, generated_audio
    gc.collect()
    torch.cuda.empty_cache()
    loaded.allocated = torch.cuda.memory_allocated()
    return result


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


# The smallest tiles the last decoder stages run on, and what two tiles share to hide their
# seam, in cells of 8 pixels and 2 frames: 256 pixels and 64 frames, 32 pixels and 8 frames
# shared. A wider overlap decodes up to twice the video.
TILE = dict(frames=32, side=32, overlap_frames=4, overlap_side=4)
# Video memory a tile holds for each token of the decoder's last stage, at most (1.5 to 3.3 KiB
# measured, from 0.2 to 1.5 million tokens a tile).
TILE_TOKEN_BYTES = 3600


def plan_tiles(frames, height, width, cells, tile=None):
    """The tiles of the decode, (tile, stride) in cells for each axis: the ones that compute
    the least of what tiles share, none holding more than `cells` cells; the smallest (TILE) when
    even those hold more.

    What two tiles share is decoded twice: 256-pixel tiles of 64 frames decode 1.4 times a
    video. Measured on an RTX 4070 Super, 121 frames: 288 x 512 in one tile 3.0 s instead of
    3.9; 896 x 1600 in 384-pixel tiles of the whole length 26.5 s instead of 31.5. Larger tiles
    are also fewer seams."""
    tile = tile or TILE

    def sizes(length, smallest):
        return sorted({*range(smallest, length, 8), max(smallest, length)})

    def plan(largest_frames, largest_side):
        return (
            tiling(frames, largest_frames, tile['overlap_frames']),
            tiling(height, largest_side, tile['overlap_side']),
            tiling(width, largest_side, tile['overlap_side']),
        )

    best = None
    for largest_frames in sizes(frames, tile['frames']):
        for largest_side in sizes(max(height, width), tile['side']):
            found = plan(largest_frames, largest_side)
            held, computed = 1, 1
            for (size, stride), length in zip(found, (frames, height, width)):
                held *= size
                computed *= size * len(equal_tiles(length, size, stride))
            if held <= cells and (best is None or (computed, held) < best[:2]):
                best = (computed, held, found)
    return dict(zip(('frames', 'height', 'width'), best[2] if best else plan(tile['frames'], tile['side'])))


def configure_decode(vae, shape, free_gib=0.0):
    """Tiled decode with tiles of one size: returns the plan, for the timeline.

    `free_gib` is the video memory the decode may use beyond the decoder's weights: the tiles
    are as large as it allows (plan_tiles), after what the whole video holds whatever the tiles
    (the features the tiles are cut from, and the decoded pixels while they are put together).

    Without comfy-kitchen's neighborhood attention, diffusers' FlexAttention is compiled for
    each tile shape it meets (seconds each time): the smallest tiles then, all of one size (the
    library's own tiling ends every axis on a shorter one, up to eight shapes for one video).
    """
    import torch
    import torch.nn.attention.flex_attention as flex
    from diffusers.models.autoencoders import ltx2_diffusion_decoder as library
    from runner.models.ltx25_decoder import fuse

    # Eager attention AND eager mask construction materialize quadratic matrices.
    fused = fuse(vae)
    if not fused and not getattr(configure_decode, 'compiled', False):
        flex.flex_attention = torch.compile(flex.flex_attention, dynamic=False)
        flex.create_block_mask = torch.compile(flex.create_block_mask, dynamic=False)
        configure_decode.compiled = True
    decoder = vae.decoder
    stride = decoder.upsamples[-1].stride
    cell_frames, cell_side = stride[0], stride[1] * decoder.patch_size
    ratio_frames, ratio_side = vae.temporal_compression_ratio, vae.spatial_compression_ratio
    # Cells of the grid the tiles are cut on, from the latent size.
    frames = ((shape[2] - 1) * ratio_frames + 1 + cell_frames - 1) // cell_frames
    height, width = shape[3] * ratio_side // cell_side, shape[4] * ratio_side // cell_side
    cells = 0
    if fused:
        # In bfloat16: the features of the whole video, its last frames repeated for the border
        # of the attention, and two and a half times its pixels while the tiles are joined.
        ghost = decoder.trailing_pad_latent_frames * ratio_frames // cell_frames
        features = (frames + ghost) * height * width * decoder.upsamples[-1].proj.in_features * 2
        pixels = frames * cell_frames * height * cell_side * width * cell_side * decoder.out_channels * 2
        spare = free_gib * 1024**3 - features - 2.5 * pixels
        cells = int(spare / TILE_TOKEN_BYTES) // (cell_frames * (cell_side // decoder.patch_size) ** 2)
    plan = plan_tiles(frames, height, width, cells)
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
    from runner.models.pool import RECENT, room
    from runner.models.residency import open_store

    seed = job['parameters']['seed']
    with open_store(job['components']['vae']) as source, torch.inference_mode():
        models, names = validate_layout(headers, ('vae',))
        vae = models.pop('vae')
        # The decoder stays on the GPU while it works, where there is room beside what the
        # decode holds: each tile runs it several times.
        entries = (entry for name, entry in headers['vae'].items() if name != '__metadata__')
        size = sum(entry['data_offsets'][1] - entry['data_offsets'][0] for entry in entries)
        kept = size / 1024**3 if room(DECODE_GIB) * 1024**3 >= size else 0
        pool = WeightPool({'vae': source}, kept)
        try:
            vae = load_streamed(vae, names['vae'], pool)
            denoise, done, told, total = vae.decoder.denoise, 0, time.perf_counter(), 0

            def counted(*args, **kwargs):
                # The decode is the longest silent stage of a large video: say where it is.
                nonlocal done, told
                result = denoise(*args, **kwargs)
                done += 1
                if done in (1, total) or time.perf_counter() - told > 5:
                    told = time.perf_counter()
                    progress(stage='decoding video', tile=done, tiles=total)
                return result

            vae.decoder.denoise = counted

            def decode(free_gib):
                nonlocal done, total
                plan = configure_decode(vae, latents.shape, free_gib)
                progress(stage='decoding video', tiles=plan)
                done, total = 0, plan['frames']['tiles'] * plan['height']['tiles'] * plan['width']['tiles']
                with torch._dynamo.config.patch(recompile_limit=64, fail_on_recompile_limit_hit=True):
                    return vae.decode(
                        latents.to('cuda', dtype=torch.bfloat16),
                        generator=torch.Generator('cuda').manual_seed(seed),
                    ).sample

            try:
                # What is free below the engine's margin, less half a gigabyte and the decoder's
                # weights: all of them when they stay on the GPU, else the last layers used.
                decoded = decode(room(1.5) - (kept or RECENT / 1024**3))
            except torch.OutOfMemoryError:
                decoded = None
            if decoded is None:
                # The tiles held more than was counted for them: again with the smallest, once
                # what the failed attempt held is gone (the error itself kept it until here).
                gc.collect()
                torch.cuda.empty_cache()
                decoded = decode(0)
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
