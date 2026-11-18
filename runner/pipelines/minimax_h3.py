"""Native MiniMax-H3 (FastH3 Omni / FastH3 v2): prompt + references -> video with sound.

The request flow is the diffusers MiniMax-H3 modular pipeline (Apache-2.0), run
stage by stage so only one large model occupies the GPU at a time:
presentation + conditioner, VAE encoding of the conditions, 8-step joint
denoise with the streamed DiT, then video and audio decoding.
"""

from contextlib import ExitStack
import gc
import math
import sys
import time

from runner import hardware, preview

STEPS = 8
FRAME_CHOICES = tuple(17 * n + 5 for n in range(7, 21))  # 5 to 15 seconds at 24 fps
# A continuation overlap must cover whole VAE chunks (17n+5 frames -> 5n+2 latent frames),
# so the source tail encodes onto exactly the latent frames that open the new window.
OVERLAPS = (22, 39, 56)
AUDIO_LATENTS_PER_SECOND = 40
# RAM the weights kept between two videos leave free, in GiB. The model (19 GiB) does not fit
# whole beside everything else in 32 GiB: only the share of it that every step copies to the GPU
# is kept, page-locked (14 GiB with 4.7 GiB of the model on a 12 GiB card). Read from unlocked
# memory, those copies took a third of each step.
RAM_RESERVE_GIB = 4
# Locked a little beyond what is copied, so the next video finds its weights there (see streamed).
LOCK_MARGIN_GIB = 0.5
# Weights copied to the GPU in advance, while it computes the layers before them (WeightPool).
AHEAD_GIB = 0.5
# What is asked free beyond what the steps were measured to hold (least_gib): the margin of the
# engine (1 GiB) and half a gigabyte. With less, a video of 1920 x 1088 failed one time of two,
# after five minutes (17/11).
EDGE_GIB = 1.5
# Video memory what runs once before the steps takes beside a model left on the card, in GiB:
# the conditioner (1.4, 2.1 with reference images), the VAE encoders of the references (1.6),
# measured on the sweep of 17/11; and the margin the engine keeps under what is free.
BESIDE_GIB = 3.0
CEILING_GIB = 1.0
# What the video VAE's pixels are normalised by (ImageNet's, as the library's pipeline says).
PIXEL_MEAN, PIXEL_STD = (0.485, 0.456, 0.406), (0.229, 0.224, 0.225)


def grid_of(parameters):
    """(latent frames, rows, columns) of the tokens of a video."""
    return ((parameters['frames'] - 5) // 17 * 5 + 2, parameters['height'] // 32, parameters['width'] // 32)


def working_gib(tokens):
    """Video memory the model computes with beside its weights, in GiB: 5 (a feed-forward chunk,
    the allocator's slack, the engine's margin) plus the activations, which grow with the video
    (1 GiB for a 5 s draft)."""
    return 5 + tokens * 7168 * 2 * 6 / 1024**3


def least_gib(tokens):
    """Video memory the steps hold at the least, in GiB: with none of the weights kept on the
    card, and the dense attention in pieces. Measured on the sweep of 17/11 (RTX 4070 SUPER,
    INT8 model): 2.6 for 12 900 tokens, 5.1 for 34 800, 5.3 for 37 800, 9.7 for 76 000."""
    return 1.2 + 0.112 * tokens / 1000


def decode_gib(parameters):
    """Video memory the decode of the video holds, in GiB: its decoder (4.6) and what it
    computes a clip with, which grows with the picture. Measured 17/11 with the audio VAE
    beside it: 5.4 at 768 x 448, 6.0 at 1344 x 768; half a gigabyte is added to spare."""
    return 5.2 + 0.8e-6 * parameters['width'] * parameters['height']


class Loaded:
    """The video model as one generation leaves it for the next (runner.models.kept): its file
    open, its layers built, the share of its weights that stays on the GPU. As LTX 2.5's.

    Built at every video, the share was read from the file each time (2 s of a draft), and its
    pages pushed the decoders' file out of the system's cache: the decoder then took 3.6 to
    7.3 s to load, where ComfyUI leaves both on the card (18/11)."""

    def __init__(self, key):
        self.key, self.stack = key, ExitStack()
        self.store = self.pool = self.dit = self.sparse = None
        self.fast = False
        # Video memory all this holds, measured once the generation that leaves it is over.
        self.allocated = 0
        # Whether what its steps copy to the GPU comes from page-locked RAM, and the bytes there.
        self.locked = True
        self.ram = 0

    def drop(self):
        try:
            if self.pool is not None:
                self.pool.clear()
        finally:
            # Whatever the card answered, the file is closed and its RAM given back.
            self.dit = self.pool = self.sparse = None
            self.stack.close()


def too_large(parameters, card_gib):
    """Why this video cannot be made on a card of `card_gib`, in the user's words; '' when it can,
    or when the card is not known. Said before anything is unloaded for it: at 1344 x 768 for
    14 s the steps alone hold more than a 12 GiB card has, and the generation failed after
    half a minute, whatever was closed (17/11)."""
    if not card_gib:
        return ''
    need = least_gib(math.prod(grid_of(parameters)) + 512)
    # The engine keeps 1 GiB of the card free (runner.engine).
    if need <= card_gib - 1:
        return ''
    said = lambda value: f'{value:.0f}'  # noqa: E731
    return (
        f'MiniMax H3 ne peut pas faire cette vidéo sur cette carte graphique ({said(card_gib)} Go) : '
        f'{parameters["width"]} × {parameters["height"]} pendant {round(parameters["frames"] / 24)} s '
        f'demande environ {said(need)} Go pour le calcul seul. Réduisez la durée ou la résolution.'
    )


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
    # A video the card cannot hold is said now, not after half a minute of loading.
    refused = too_large(job['parameters'], hardware.card_gib())
    if refused:
        raise RuntimeError(refused)
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

    # (« decode.audio »: a step of a block, when another of its steps is done here.)
    block = MiniMaxH3Blocks()
    for name in block_name.split('.'):
        block = block.sub_blocks[name]
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


def middle_frame(rows, velocity, sigma, grid):
    """The generated video's middle latent frame (C, H, W) as a step sees it finished, from the
    DiT's video rows and their velocity (1, rows, C * 4): the video's `grid` of tokens comes
    last, laid out as `_patchify` does. MiniMax-H3 predicts a data-ward velocity: x0 = x + sigma * v."""
    frames, height, width = grid
    count = height * width
    first = rows.shape[1] - (frames - frames // 2) * count
    finished = rows[0, first : first + count].float() + float(sigma) * velocity[0, first : first + count].float()
    finished = finished.reshape(height, width, -1, 2, 2)
    return finished.permute(2, 0, 3, 1, 4).reshape(finished.shape[2], height * 2, width * 2)


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
    """One video. The model the last generation left on the GPU is taken back when it is the one
    this job asks for (same file, same attention) for a video of the same shape, and left
    there again at the end."""
    import torch
    from runner.models import conditioning, kept

    p = job['parameters']
    shape = [p['width'], p['height'], p['frames'], sorted(ref['role'] for ref in job['references'])]
    attention = [p.get('attention', 'comfy_kitchen'), p.get('sparse_attention', 'off'), p.get('sparse_keep', 10)]
    key = [conditioning.stamp(job['components']['model']), shape, attention]
    holder = [kept.take('minimax_h3', key)]
    try:
        result = _generate(job, config, progress, key, holder)
    except BaseException:
        # Whatever state the failure left it in, it is not one to start the next video from.
        if holder[0] is not None:
            holder[0].drop()
        raise
    loaded = holder[0]
    if not loaded.locked or not loaded.pool.gpu:
        # RAM was short when it was built (its steps copied from the file's mapping, whose
        # pages stay in this process while the file is open), or its share left for the
        # decode: the next video builds it anew.
        loaded.drop()
    else:
        gc.collect()
        loaded.allocated = torch.cuda.memory_allocated()
        kept.put('minimax_h3', loaded)
    return result


def _generate(job, config, progress, key, holder):
    import numpy
    import torch
    from PIL import Image
    from diffusers import MiniMaxH3Scheduler
    from diffusers.modular_pipelines.minimax_h3 import encoders as reference_encoders
    from diffusers.modular_pipelines.minimax_h3.references import MiniMaxH3ImageReference
    from runner.models.headers import header
    from runner.models import conditioning, minimax_h3, minimax_h3_text, minimax_h3_vae
    from runner.models.ladder import smaller
    from runner.models.ltx25 import WeightPool
    from runner.models.pool import require
    from runner.models.residency import RESIDENCY, open_store, prefetch, use_order
    from runner.pipelines.ltx25 import memory
    from runner.video.export import save_video

    if not torch.cuda.is_available():
        raise RuntimeError('Native MiniMax-H3 requires CUDA')
    # Asked for before anything is loaded: what the model computes with for this video. Its
    # weights follow the card (see the budget below).
    require(
        'MiniMax H3',
        working_gib(math.prod(grid_of(job['parameters'])) + 512),
        'la taille ou la durée de la vidéo',
        measured=least_gib(math.prod(grid_of(job['parameters'])) + 512) + EDGE_GIB,
    )
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
                free_gib=round(hardware.free_bytes(torch) / 1024**3, 3),
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
    left = holder[0].pool if holder[0] is not None else None
    if left is not None and left.gpu and (not found or references or keyframe_inputs or continuation):
        # A prompt to read, or references to encode, beside the share of the model the last
        # video left on the card: the share lends what they lack (WeightPool.lend).
        gc.collect()
        torch.cuda.empty_cache()
        left.lend(BESIDE_GIB + CEILING_GIB - hardware.free_bytes(torch) / 1024**3)
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
        # The disk reads the conditioner in sequence while its layers run: by the store itself
        # when the file is not kept in RAM (Store.follow), else through the system's cache.
        ahead = (
            None
            if text_store.reader
            else prefetch(paths, {'textEncoder': text_store}, [('textEncoder', key, None) for key in text_store.keys()])
        )
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
            read = ahead.stop() if ahead else text_store.reader.summary() if text_store.reader else None
        written = conditioning.changes(before, state.values)
        kept = (
            'kept for the next generations'
            if written
            and conditioning.save(config, entry, written[0], dict(written[1], kinds=dict(state.kwargs_mapping)))
            else 'not kept'
        )
        del text_encoder
        text_store.close()
        del text_store, before, written
    state.set('prompt_embeds', state.get('prompt_embeds').to('cuda', torch.bfloat16))
    _free(scope={})
    progress(
        stage='video prompt encoded',
        tokens=int(state.get('prompt_embeds').shape[1]),
        conditioning=kept,
        **({'prefetch': read} if read else {}),
    )
    # The workflow's « attention creuse » (VSA), for the FastH3 models trained with it, decided
    # before the model is read: a dense generation neither loads nor reads ahead the gates. It
    # needs comfy-kitchen's sparse kernel, and a video large enough to gain from it.
    grid = grid_of(p)
    tokens = math.prod(grid) + 512
    sparse, dense_why = None, None
    if p.get('sparse_attention', 'off') == 'vsa':
        from runner.models import sparse_attention

        if not sparse_attention.ready():
            dense_why = 'no sparse attention kernel on this GPU'
        elif tokens < sparse_attention.MIN_ROWS:
            dense_why = f'about {tokens} rows, faster dense below {sparse_attention.MIN_ROWS}'
        else:
            sparse = minimax_h3.Sparse(float(p.get('sparse_keep', 10)) / 100)

    def read_ahead():
        return prefetch(paths, {}, use_order(minimax_h3.names(dit_header, gate=sparse is not None)))

    # A model left by the last video is read no more: its share is on the card, the rest in RAM.
    ahead = None if holder[0] is not None else read_ahead()

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

    def share():
        """GiB of the DiT kept on the GPU; the rest is copied from RAM at every step, at about
        12 GiB/s. What the model computes with comes first: 5 GiB (a feed-forward chunk, the
        allocator's slack, the engine's margin) plus the activations, which grow with the
        video (1 GiB for a 5 s draft). Video memory that runs out halves the speed, a smaller
        share costs a second per step at most. Counted from what this process may hold: what
        is free, and what it holds already (the share the last video left).
        (Sparse attention needs less at its peak: 5 widths instead of 6, measured at 1344 x 768.)"""
        free = (hardware.free_bytes(torch) + torch.cuda.memory_reserved()) / 1024**3
        return min(config.get('cacheGiB', 6), max(0, free - working_gib(tokens) - AHEAD_GIB))

    budget = share()
    loaded = holder[0]
    if loaded is not None:
        # The share the last video left is this one's when it is about what this video leaves
        # the model (as for LTX 2.5: a quarter of a gigabyte over, half a gigabyte under), and
        # the model was built with the same attention. Else it is dropped and built anew: taken
        # back at another size it could not be given its page-locked RAM (see ltx25.Refit).
        held = loaded.pool
        near = (budget - LOCK_MARGIN_GIB) * 1024**3 <= held.limit
        suits = bool(held.gpu) and near and held.bytes <= (budget + 0.25) * 1024**3
        if not suits or (sparse is None) != (loaded.sparse is None):
            loaded.drop()
            loaded = holder[0] = None
            _free(scope={})
            budget = share()
            ahead = read_ahead()
    # A model taken back from the last generation: this one is the next of a run (the Studio).
    again = loaded is not None
    if not again:
        loaded = holder[0] = Loaded(key)
        # The model's file stays open with it, beyond this generation.
        loaded.store = loaded.stack.enter_context(open_store(paths['model']))
        loaded.pool = WeightPool({'model': loaded.store}, budget, ahead_gib=AHEAD_GIB)
    store, pool = loaded.store, loaded.pool
    # What this generation hangs on the model, taken off again at its end.
    hooks = []
    with torch.inference_mode():
        if ahead:
            ahead.lead = pool.used
        try:
            if again:
                dit, fast_attention, sparse, budget = loaded.dit, loaded.fast, loaded.sparse, pool.limit / 1024**3
                pool.stats.update(dict.fromkeys(pool.stats, 0.0))
                if sparse is not None:
                    # The plans and the measures of the last video are not this one's.
                    sparse.plan, sparse.plans, sparse.statistics, sparse.measure = None, {}, {}, False
            else:
                # The workflow's « attention » choice; comfy-kitchen's INT8 kernel unless it asks for PyTorch's.
                fast_attention = (
                    p.get('attention', 'comfy_kitchen') == 'comfy_kitchen'
                    and minimax_h3.INT8_ATTENTION
                    and minimax_h3.int8_attention_ready()
                )
                dit, _heads = minimax_h3.load(dit_header, paths['model'], pool, fast_attention, sparse)
                loaded.dit, loaded.fast, loaded.sparse = dit, fast_attention, sparse
            if again:
                # Its page-locked RAM is the one its last video ran with: nothing is asked again.
                # Asked again, the weights to copy were named from the share as the steps left
                # it, a few layers more than first foreseen: at 1344 x 768, where RAM allows a
                # part of them only, 19 GiB were read anew beside the rest and the steps of the
                # next videos took five times longer (18/11).
                locked = loaded.ram
            else:
                # What will not stay on the GPU goes to page-locked RAM once, for every step and
                # the next videos; what stays is read from the file as it is loaded.
                copied = pool.streamed().get('model', ())
                locked = loaded.ram = store.keep(
                    copied,
                    int(RAM_RESERVE_GIB * 1024**3),
                    spare=pool.streamed(LOCK_MARGIN_GIB, onward=True).get('model', ()),
                )
                loaded.locked = not copied or store.pinned
            # The share is filled; one left by the last video takes back what it lent.
            pool.preload()
            scheduler, audio_scheduler = MiniMaxH3Scheduler(shift=12.0), MiniMaxH3Scheduler(shift=3.0)
            calls = {'step': 0}
            sparse_start = float(p.get('sparse_start', 0.2))

            def before(_module, args, values):
                i = calls['step']
                minimax_h3.set_interval(
                    dit,
                    (scheduler.sigmas[i], scheduler.sigmas[i + 1]),
                    (audio_scheduler.sigmas[i], audio_scheduler.sigmas[i + 1]),
                )
                if sparse is not None:
                    # The first steps lay the video out: they stay dense, as the model was trained.
                    sparse.plan = sparse.prepare(values, grid) if i >= sparse_start * STEPS else None
                    # The last of them measures what the first sparse step quantizes with.
                    sparse.measure = i < sparse_start * STEPS <= i + 1
                return args, values

            def after(_module, _args, values, output):
                calls['step'] += 1
                read = {'prefetch': ahead.stop()} if ahead and calls['step'] == 1 else {}
                mode = {}
                if sparse is not None:
                    mode['attention'] = 'sparse' if sparse.plan is not None else 'dense'
                progress(
                    stage='generating video', step=calls['step'], total=STEPS, weights=pool.summary(), **read, **mode
                )
                sigma = scheduler.sigmas[calls['step'] - 1]
                preview.send(report, preview.MINIMAX_H3, middle_frame, values['hidden_states'], output[0], sigma, grid)
                return output

            hooks.append(dit.register_forward_pre_hook(before, with_kwargs=True))
            hooks.append(dit.register_forward_hook(after, with_kwargs=True))
            if continuation:
                # Registered after the step counter: its output hook reads the finished step.
                latent_frames = (p['frames'] - 5) // 17 * 5 + 2
                hooks.extend(
                    protect_head(
                        dit,
                        (scheduler, audio_scheduler),
                        calls,
                        video_head.to('cuda'),
                        audio_head.to('cuda'),
                        latent_frames * (p['height'] // 32) * (p['width'] // 32),
                        round(p['frames'] / 24 * AUDIO_LATENTS_PER_SECOND),
                    )
                )
            label = 'int8' if fast_attention else 'pytorch'
            if sparse is not None:
                first = math.ceil(sparse_start * STEPS) + 1
                gates = 'with gates' if minimax_h3.has_gates(dit_header) else 'without gates'
                label += f', then vsa {round(sparse.keep * 100, 1)} % from step {first}, {gates}'
            elif dense_why:
                label += f' (vsa asked, dense: {dense_why})'
            progress(stage='sampling video', attention=label)
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
                locked_ram_gib=round(locked / 1024**3, 3),
                residency=RESIDENCY.summary(),
            )
            progress(stage='video sampled', **cache)
            del dit
        finally:
            for hook in hooks:
                hook.remove()
            if ahead:
                ahead.stop()
            if sparse is not None:
                sparse_attention.release()
    # The share of the model stays on the GPU through the decode, for the next video: the
    # layers copied for a moment leave, and the pages of the file read for the share go back
    # to the system (the file stays open with the model).
    pool.settle()
    store.reopen()
    state.set('prompt_embeds', None)
    _free(scope={})

    # 4. Decode video and sound. The share lends the decode what it lacks.
    progress(stage='decoding video')
    pool.lend(decode_gib(p) + 0.5 + CEILING_GIB - hardware.free_bytes(torch) / 1024**3)
    with torch.inference_mode():

        def frames_of():
            vae = minimax_h3_vae.video_vae(paths['vae'], 'decoder')
            """The frames, uint8 [frames, height, width, 3], off the GPU as each stretch of them
            is decoded (minimax_h3_vae.decode_chunks): the block of the library joined the whole
            video on the GPU, several times as 32-bit floats."""
            scale = lambda values: torch.tensor(values, device='cuda').view(1, -1, 1, 1, 1)  # noqa: E731
            latents = state.get('latents') * scale(vae.config.latents_std) + scale(vae.config.latents_mean)
            made = []
            for chunk in minimax_h3_vae.decode_chunks(vae, latents):
                # As the block does: back from the VAE's normalisation (ImageNet's), in [0, 1].
                chunk = (chunk.float() * scale(PIXEL_STD) + scale(PIXEL_MEAN)).clamp(0, 1)
                made.append((chunk[0] * 255).round().byte().permute(1, 2, 3, 0).cpu().numpy())
                del chunk
            return numpy.concatenate(made)

        def alone():
            # Beside the share of the model the decode did not fit: the share leaves whole, as
            # it always did before 0.6.80, and the next video builds the model anew.
            pool.clear()
            progress(stage='decoding video again without the share of the model')
            return frames_of()

        def unbound():
            # A clip that does not fit under the engine's ceiling (1 GiB below what the card had
            # free): with all of the card, where the engine would run the whole video again.
            torch.cuda.set_per_process_memory_fraction(1.0)
            progress(stage='decoding video again without the video memory ceiling')
            return frames_of()

        pixels = smaller([frames_of, *([alone] if pool.gpu else []), unbound], torch)
        _free(scope={})
        audio_vae = minimax_h3_vae.audio_vae(paths['audioVae'])
        state = _stage('decode.audio', dict(audio_vae=audio_vae), state)
    audio, rate = state.get('audio'), state.get('sampling_rate')
    del audio_vae
    _free(scope={})
    progress(stage='video decoded')
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
