"""Wan 2.2 image to video (I2V-A14B): a clip that starts on an image, without sound.

The clip is drawn by two models of the same shape, one after the other (runner.models.wan22):
the « high noise » one while the noise level is 0.9 or more, the « low noise » one below. Each is
a file of 14 GiB: one is open at a time, a share of its weights on the card and the rest passing
through from RAM, as runner.pipelines.wan_scail2 does for its own model.

Sampled as the official implementation sets it (github.com/Wan-Video/Wan2.2, Apache-2.0,
`wan/image2video.py`, `wan/configs/wan_i2v_A14B.py`): the noise levels moved by a shift of 5, a
guidance of 3.5 (each step reads the prompt, then what to avoid, and goes 3.5 times further from
the second than the first does), 16 frames a second, 4n + 1 frames. The steps are Euler's, as
for the other models here; the official code takes 40 of UniPC's.

The start image fills the picture asked (what overflows is cut equally on both sides): the
job's width and height are those of the video.
"""

import gc
import time

from runner import hardware

STEPS = 20
SHIFT = 5.0
GUIDANCE = 3.5
FPS = 16
# What the official configuration asks the model to avoid (`sample_neg_prompt`), read when the
# job gives nothing: garish colours, overexposure, a still picture, blurred details, subtitles,
# bad hands and faces, extra limbs, a crowded background, walking backwards.
AVOIDED = (
    '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，'
    'JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，'
    '手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走'
)
# The component that holds each of the two models.
COMPONENTS = dict(high='model', low='modelLow')
SAID = dict(high='bruit fort', low='bruit faible')
# As runner.pipelines.wan_scail2: RAM the weights leave free, what is locked beyond what is
# copied, what is copied to the GPU ahead of the layers that read it.
RAM_RESERVE_GIB = 4
LOCK_MARGIN_GIB = 0.5
AHEAD_GIB = 0.5


def tokens(frames, height, width):
    """Tokens of a clip: one for 2 x 2 latent pixels of each latent frame."""
    return ((frames - 1) // 4 + 1) * (height // 16) * (width // 16)


def working_gib(count):
    """Video memory a step computes with beside the weights, in GiB (the estimate of
    runner.pipelines.wan_scail2, whose blocks these are)."""
    return 2 + 0.11 * count / 1000


def experts(levels, boundary=None):
    """Which of the two models draws each step: 'high' while the noise level the step starts
    from is `boundary` or more, 'low' below."""
    from runner.models import wan22

    limit = wan22.BOUNDARY if boundary is None else boundary
    return ['high' if level >= limit else 'low' for level in levels[:-1]]


def _one(job, role):
    found = [ref['path'] for ref in job['references'] if ref['role'] == role]
    return found[0] if len(found) == 1 else None


def check(job, family):
    p = job['parameters']
    if p['width'] % 16 or p['height'] % 16:
        raise ValueError('Wan 2.2 sizes are multiples of 16')
    if p['frames'] % 4 != 1 or p['frames'] < 5:
        raise ValueError('Wan 2.2 draws 4n + 1 frames, 5 at least')
    if _one(job, 'start_image') is None:
        raise ValueError('Wan 2.2 needs one start image')


def preflight(job, config):
    from runner.models import wan22
    from runner.models.headers import header

    check(job, None)
    paths = job['components']
    for kind, component in COMPONENTS.items():
        found = header(paths[component])
        wan22.validate_layout(found)
        said = wan22.expert(found, paths[component])
        if said and said != kind:
            # The two files have the same shape: swapped, the clip is drawn all the same, badly.
            raise ValueError(
                f'Le fichier choisi pour le modèle « {SAID[kind]} » de Wan 2.2 est celui du modèle '
                f'« {SAID[said]} » : échangez les deux fichiers dans les réglages de ce modèle.'
            )
    # An image that cannot be read is refused here, before the chat model is unloaded.
    from PIL import Image

    with Image.open(_one(job, 'start_image')) as image:
        image.verify()


def texts(config, path, prompts, progress=None, encode=None):
    """(the text conditioning of each prompt, how many were kept from an earlier generation):
    those kept on the disk are read there (runner.models.conditioning), the others are encoded
    together, the encoder loaded once."""
    from runner.models import conditioning, wan_text

    stamp = conditioning.stamp(path)
    keys = [conditioning.key('wan22 text', stamp, words) for words in prompts]
    found = [conditioning.load(config, key) for key in keys]
    values = [item[0].get('value') if item else None for item in found]
    missing = [index for index, value in enumerate(values) if value is None]
    if missing:
        made = (encode or wan_text.encode_all)(path, [prompts[index] for index in missing], progress)
        for index, value in zip(missing, made):
            values[index] = value
            conditioning.save(config, keys[index], {'value': value})
    return values, len(prompts) - len(missing)


def guided(predict, text, avoided, guidance):
    """The direction a step takes: what the model draws for the prompt, moved away from what it
    draws for `avoided` (None: the prompt alone, one pass)."""
    wanted = predict(text).float()
    if avoided is None:
        return wanted
    other = predict(avoided).float()
    return other + guidance * (wanted - other)


def sample(direction, noise, levels, step=None):
    """The latents of the clip: Euler steps from `noise` down `levels`, `direction(latents,
    index)` being the guided prediction of the model that draws that step."""
    latents = noise.float()
    for index in range(len(levels) - 1):
        moved = direction(latents, index)
        if step:
            # With the step's number, the picture so far: the frame in the middle as the model
            # sees it finished, asked for only if it is shown.
            middle = latents.shape[2] // 2
            step(index + 1, lambda: latents[0, :, middle] - levels[index] * moved[0, :, middle])
        latents = latents + (levels[index + 1] - levels[index]) * moved
        del moved
    return latents


def start_video(picture, frames):
    """The video the model is given, [1, 3, frames, height, width]: the start image, then grey."""
    import torch

    video = torch.zeros(1, 3, frames, *picture.shape[-2:])
    video[0, :, 0] = picture
    return video


class _Expert:
    """One of the two models streamed from its file, opened with a share of its weights on the
    GPU and closed whole."""

    def __init__(self, kind, path, names):
        self.kind, self.path, self.names = kind, path, names
        self.stack = self.pool = self.model = None
        self.facts = {}

    def open(self, budget):
        from contextlib import ExitStack

        from runner.models import wan22, wan_block, wan_scail2
        from runner.models.pool import WeightPool, load_streamed
        from runner.models.residency import open_store

        self.stack = ExitStack()
        store = self.stack.enter_context(open_store(self.path))
        self.pool = WeightPool({'model': store}, budget, ahead_gib=AHEAD_GIB)
        self.model = load_streamed(wan22.architecture(), self.names, self.pool)
        fused, fast = wan_block.fuse(self.model)
        if not fused:
            fast = wan_scail2.use_int8_attention(self.model)
        # What will not stay on the GPU goes to page-locked RAM once, for every step of this
        # model; what stays is read from the file as it is loaded.
        locked = store.keep(
            self.pool.streamed().get('model', ()),
            int(RAM_RESERVE_GIB * 1024**3),
            spare=self.pool.streamed(LOCK_MARGIN_GIB, onward=True).get('model', ()),
        )
        self.pool.preload()
        self.facts = dict(
            expert=self.kind,
            gpu_cache_gib=round(self.pool.bytes / 1024**3, 3),
            gpu_cache_limit_gib=round(budget, 3),
            locked_ram_gib=round(locked / 1024**3, 3),
            pinned_model=store.pinned,
            fused_blocks=fused,
            attention='int8' if fast else 'pytorch',
        )
        return self

    def close(self):
        import torch

        from runner.models.residency import RESIDENCY

        self.model = None
        if self.pool is not None:
            self.pool.clear()
            self.pool = None
        if self.stack is not None:
            self.stack.close()
            self.stack = None
        # The other model is read next, in this video or at the start of the one after: what was
        # locked in RAM of this one leaves now, for the other to have the whole share.
        RESIDENCY.forget(self.path)
        gc.collect()
        torch.cuda.empty_cache()


def generate(job, config, progress):
    import torch

    from runner import preview
    from runner.models import wan22, wan_vae
    from runner.models.headers import header
    from runner.models.pool import require
    from runner.models.residency import RESIDENCY
    from runner.pipelines.ltx25 import memory
    from runner.pipelines.wan_scail2 import read_image, smaller
    from runner.video import scail
    from runner.video.export import save_video

    if not torch.cuda.is_available():
        raise RuntimeError('Native Wan 2.2 requires CUDA')
    check(job, None)
    p, paths = job['parameters'], job['components']
    width, height, frames = p['width'], p['height'], p['frames']
    steps, guidance, shift = p.get('steps', STEPS), float(p.get('cfg', GUIDANCE)), float(p.get('shift', SHIFT))
    count = tokens(frames, height, width)
    require('Wan 2.2', working_gib(count), 'la taille ou la durée de la vidéo')
    GiB = 1024**3
    start = time.perf_counter()
    torch.cuda.reset_peak_memory_stats()
    timeline = []
    report = progress

    def progress(**data):
        timeline.append(
            dict(
                {key: value for key, value in data.items() if key != 'prompt'},
                seconds=round(time.perf_counter() - start, 2),
                allocated_gib=round(torch.cuda.memory_allocated() / GiB, 3),
                free_gib=round(hardware.free_bytes(torch) / GiB, 3),
                **memory(),
            )
        )
        report(**data)

    def free_card():
        gc.collect()
        torch.cuda.empty_cache()

    names = {kind: wan22.validate_layout(header(paths[component])) for kind, component in COMPONENTS.items()}
    bf16 = dict(device='cuda', dtype=torch.bfloat16)
    with torch.inference_mode():
        # 1. The prompt and what to avoid (UMT5-XXL streamed from its file), kept on the disk.
        progress(stage='loading video prompt encoder')
        # Without guidance (1) the model reads the prompt alone: one pass a step.
        wanted = [p['prompt']] + ([] if guidance == 1 else [p.get('negative_prompt', AVOIDED)])
        found, kept = texts(config, paths['textEncoder'], wanted, progress)
        text = found[0].to(**bf16)
        avoided = found[1].to(**bf16) if len(found) > 1 else None
        del found
        progress(stage='video prompt encoded', tokens=int(text.shape[1]), kept=kept, read=len(wanted))

        # 2. The start image, as the first frame of a video whose other frames are grey.
        progress(stage='encoding references')
        picture = scail.cover(read_image(_one(job, 'start_image')), width, height)
        vae = wan_vae.load(paths['vae'])
        condition = wan22.given(wan_vae.encode(vae, start_video(picture, frames))).to(**bf16)
        del picture
        free_card()
        progress(stage='references encoded', frames=frames)

        # 3. The steps: the « high noise » model, then the « low noise » one.
        levels = scail.sigmas(steps, shift)
        plan = experts(levels)
        room = max(0.0, hardware.free_bytes(torch) / GiB - working_gib(count) - AHEAD_GIB)
        state = dict(budget=min(config.get('cacheGiB', 16), room), open=None, rotary=None)
        noise = torch.randn(
            [1, wan22.LATENT_CHANNELS, condition.shape[2], height // 8, width // 8],
            generator=torch.manual_seed(p['seed']),
        ).cuda()
        opened = []

        def expert_for(index):
            """The model of this step, open: the other one leaves the card first."""
            current = state['open']
            if current is not None and current.kind != plan[index]:
                current.close()
                current = None
            if current is None:
                current = state['open'] = _Expert(plan[index], paths[COMPONENTS[plan[index]]], names[plan[index]])
            if current.model is None:
                progress(stage='loading video model', expert=current.kind)
                progress(stage='sampling video', **current.open(state['budget']).facts)
                opened.append(dict(current.facts))
                state['rotary'] = wan22.positions(current.model, condition.shape)
            return current

        def direction(latents, index):
            moved = None
            while moved is None:
                try:
                    current = expert_for(index)
                    timestep = torch.tensor([levels[index] * 1000], device='cuda')
                    moved = guided(
                        lambda words: wan22.forward(
                            current.model, latents, timestep, words, condition, state['rotary']
                        ),
                        text,
                        avoided,
                        guidance,
                    )
                except torch.OutOfMemoryError:
                    if state['budget'] <= 0:
                        raise
                if moved is None:
                    # Out of the handler, the failed attempt's tensors gone: the video memory ran
                    # out as the weights were laid on the card or in a step. The same step again
                    # with half the weights there, then none.
                    state['open'].close()
                    state['budget'] = smaller(state['budget'])
                    progress(
                        stage='retrying with a smaller share of the model', gpu_cache_limit_gib=state['budget']
                    )
            return moved

        def stepped(number, estimate):
            current = state['open']
            progress(
                stage='generating video', step=number, total=steps, expert=current.kind, weights=current.pool.summary()
            )
            preview.send(report, preview.WAN21, estimate)

        try:
            latents = sample(direction, noise, levels, stepped)
            cache = dict(experts=opened, residency=RESIDENCY.summary())
            progress(stage='video sampled', **cache)
        finally:
            # The card is the decoder's.
            if state['open'] is not None:
                state['open'].close()
        del noise, condition, text, avoided
        free_card()
        progress(stage='decoding video')
        decoded = wan_vae.decode(vae, latents)
        del latents, vae
        if decoded.shape[2] != frames:
            raise RuntimeError(f'Decoded {decoded.shape[2]} frames, expected {frames}')
        video = decoded[0].float().permute(1, 2, 3, 0)
        pixels = ((video + 1) * 127.5).round().clamp(0, 255).to(torch.uint8).cpu().numpy()
        del decoded, video
        free_card()

    metadata = dict(
        job=job,
        parameters=p,
        seconds=round(time.perf_counter() - start, 2),
        peak_vram_gib=round(torch.cuda.max_memory_allocated() / GiB, 3),
        backend='atelier-wan22',
        frames=frames,
        fps=p['fps'],
        steps_by_expert={kind: plan.count(kind) for kind in COMPONENTS},
        audio=False,
        timeline=timeline,
        weight_cache=cache,
    )
    return save_video(pixels, config, job, metadata)
