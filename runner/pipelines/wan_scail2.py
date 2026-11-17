"""Wan 2.1 SCAIL-2: the character of a reference image drawn in place of the one of a video.

The video is made a segment at a time (81 frames, see runner.video.scail.plan): the model reads,
in one sequence, the reference image, the frames to draw and the driving video at half its
size, each with the coloured masks that say which character is which. A segment after the first
is given the last five frames of the one before, encoded again: it keeps them as they are at
every step, draws what follows, and those five frames are left out when the segments are joined.

Sampled as the distilled workflow does: six Euler steps without guidance, the noise levels moved
by a shift of 5, the model's LoRAs (lightx2v, DPO) applied as it runs. The reference is shown on
black outside its mask and the image encoder sees the whole of it, as ComfyUI's node does: the
same seed then gives the same video.

The video lasts as long as the driving video, up to the frames asked, plays at its rate and
has its shape: the width and the height of the job say how many pixels, not which way round.

The model's own LoRAs are two of its files (components `stepLora`, the distillation that makes
six steps enough, and `identityLora`), each with its strength; a job's `loras` come after them.

The masks are made here from a few words (`subject`: who to follow in the video;
`reference_subject`: who to draw from the image), by SAM 3.1's detector (runner.video.identity).
They can also be given, as two more references: an image and a video in flat colours.
"""

import gc
import time

from runner import hardware

STEPS = 6
SHIFT = 5.0
MODES = ('replace',)
# As runner.pipelines.minimax_h3: RAM the weights kept between two videos leave free, what is
# locked beyond what is copied, what is copied to the GPU ahead of the layers that read it.
RAM_RESERVE_GIB = 4
LOCK_MARGIN_GIB = 0.5
AHEAD_GIB = 0.5
# A card too small for a whole segment draws shorter ones, down to this many frames.
SHORTEST = 21
# The share of the model a card keeps at least for a segment to be worth its full length.
LEAST_SHARE_GIB = 1.0
AUDIO_RATE = 48000
# The model's own LoRAs, by component: the parameter that holds its strength, and the
# strength of the workflow the six steps were set for.
OWN_LORAS = (('stepLora', 'step_lora_strength', 0.8), ('identityLora', 'identity_lora_strength', 1.0))
# Tokens of CLIP's vocabulary, which SAM 3.1 reads.
VOCABULARY = 49408
# Who is looked for when the job does not say.
SUBJECT = 'person'
MASKS = ('driving_mask', 'reference_mask')


def working_gib(tokens):
    """Video memory a step computes with beside the weights, in GiB: 2 (the engine's margin, the
    allocator's slack, the VAE) plus 0.11 a thousand tokens. Measured with the fused blocks at
    512 x 896: 3.1 GiB reserved beside the weights for 45 frames (28 700 tokens), 4.8 for 81
    (48 800), one more with the two LoRAs of the workflow."""
    return 2 + 0.11 * tokens / 1000


def decode_gib(height, width):
    """Video memory the VAE decodes a segment with, in GiB. It follows the size of the picture,
    hardly its length: 4.9 GiB for 5 frames at 512 x 896, 5.2 for 45, 5.3 for 81."""
    return 0.3 + 11 * height * width / 1e6


def share_gib(free_gib, tokens, height, width, segments):
    """The share of the model's weights kept on the GPU, in GiB: what is free less what a step
    computes with. A video of several segments is decoded between two of them with the model
    still there: the share also leaves the decoder its room (with 1 GiB of what sits beside
    the weights and the engine's margin of 1). Without that room the model left the card for
    every decode and was read again for the next segment: 21 s each time."""
    needed = working_gib(tokens)
    if segments > 1:
        needed = max(needed, decode_gib(height, width) + 2)
    return max(0.0, free_gib - needed - AHEAD_GIB)


def segment_frames(free_gib, height, width, most=None):
    """Frames of a segment on a card with this much video memory free: the model's own 81 when
    they fit beside a share of the weights, else the longest 4n + 1 that does, never under
    SHORTEST (a smaller card then runs slower rather than not at all)."""
    from runner.video import scail

    count = most or scail.SEGMENT
    while count > SHORTEST and working_gib(scail.tokens(count, height, width)) + LEAST_SHARE_GIB > free_gib:
        count -= 4
    return count


def smaller(share_gib):
    """The share of the model tried after one that left a step out of video memory: half of it,
    then none (every weight passes through from RAM: slower, and all the card computes)."""
    return share_gib / 2 if share_gib > 1 else 0.0


def _one(job, role):
    found = [ref['path'] for ref in job['references'] if ref['role'] == role]
    return found[0] if len(found) == 1 else None


def check(job, family):
    p = job['parameters']
    if p['width'] % 32 or p['height'] % 32:
        raise ValueError('SCAIL-2 sizes are multiples of 32')
    if p['frames'] < 5:
        raise ValueError('SCAIL-2 draws 5 frames at least')
    if p.get('mode', 'replace') not in MODES:
        raise ValueError('Unsupported SCAIL-2 mode')
    segment = p.get('segment_frames')
    if segment is not None and (segment % 4 != 1 or segment < 9):
        raise ValueError('SCAIL-2 segments are 4n+1 frames, 9 at least')
    for role in ('driving_video', 'reference_image'):
        if _one(job, role) is None:
            raise ValueError('SCAIL-2 needs one ' + role.replace('_', ' '))
    given = [role for role in MASKS if any(ref['role'] == role for ref in job['references'])]
    if given and (len(given) < len(MASKS) or any(_one(job, role) is None for role in MASKS)):
        raise ValueError('SCAIL-2 masks are given together: one for the reference, one for the video')
    if not given and not all(job['components'].get(name) for name in ('segmenter', 'segmenterTokenizer')):
        raise ValueError('SCAIL-2 needs SAM 3.1 and its tokenizer to find the subjects, or their masks')


def masks_given(job):
    return _one(job, MASKS[0]) is not None


def size_like(source_width, source_height, width, height):
    """(width, height) of a video with the shape of its source and about the pixels of
    width x height, both multiples of 32: a portrait video followed stays a portrait."""
    area, ratio = width * height, source_width / source_height
    side = lambda value: max(256, round(value / 32) * 32)  # noqa: E731
    return side((area * ratio) ** 0.5), side((area / ratio) ** 0.5)


def clip(job):
    """(frames, frames a second, width, height) of the video to make: as long as the driving
    video up to the frames the job asks, 4n + 1 of them, at the driving video's own rate (each
    frame drawn follows one frame of it) and in its shape."""
    from runner.video.stream import probe

    p = job['parameters']
    found = probe(_one(job, 'driving_video'))
    available = min(p['frames'], found['frames'] or p['frames'])
    count = (available - 1) // 4 * 4 + 1
    if count < 5:
        raise ValueError('La vidéo à suivre est trop courte : il faut au moins 5 images.')
    width, height = size_like(found['width'], found['height'], p['width'], p['height'])
    return count, float(found['fps']), width, height


def loras_of(job):
    """The LoRAs of a job, in the order they are applied: the model's own, by component, then
    the job's."""
    p, paths = job['parameters'], job['components']
    own = [
        dict(id=name, path=paths[name], strength=float(p.get(parameter, strength)))
        for name, parameter, strength in OWN_LORAS
        if paths.get(name)
    ]
    return own + list(job['loras'])


def preflight(job, config):
    from runner.models import wan_scail2
    from runner.models.headers import header

    check(job, None)
    model = header(job['components']['model'])
    wan_scail2.validate_layout(model)
    for item in loras_of(job):
        wan_scail2.validate_lora(header(item['path']), model)
    # A driving video that cannot be read or is too short is refused here, before the chat
    # model is unloaded.
    count = clip(job)[0]
    if masks_given(job):
        from runner.video.stream import probe

        masks = probe(_one(job, 'driving_mask'))['frames']
        if masks and masks < count:
            raise ValueError(f'Le masque de la vidéo compte {masks} images ; la création en demande {count}.')
    else:
        from pathlib import Path

        from runner.models import sam3

        sam3.validate_layout(header(job['components']['segmenter']))
        folder = Path(job['components']['segmenterTokenizer'])
        if not all((folder / name).is_file() for name in ('vocab.json', 'merges.txt')):
            raise ValueError('The SAM 3.1 tokenizer folder must hold vocab.json and merges.txt')
        import json

        # Another model's tokenizer has the same two files: its words would be read as others.
        if len(json.loads((folder / 'vocab.json').read_text(encoding='utf-8'))) != VOCABULARY:
            raise ValueError(
                'Le tokenizer choisi pour SAM 3.1 n’est pas celui de CLIP (49 408 mots) : '
                'les sujets à suivre seraient mal compris.'
            )


def _picture(array):
    import torch

    return torch.from_numpy(array).permute(2, 0, 1).float() / 127.5 - 1


def read_frames(path, count, width, height, flat=False):
    """Yields the first `count` frames of a video cut to the shape of the generation,
    [3, height, width] from -1 to 1."""
    from contextlib import closing
    from itertools import islice

    from runner.video import scail
    from runner.video.stream import frames

    with closing(frames(path)) as source:
        for frame in islice(source, count):
            yield scail.cover(_picture(frame), width, height, flat=flat)


def _whole(found, count):
    import torch

    if len(found) < count:
        raise ValueError(f'The video holds {len(found)} frames, {count} are needed')
    return torch.stack(found)


def read_halved(path, count, width, height, flat=False):
    """The first `count` frames of a video cut to the shape of the generation, at half its size
    as the model reads them: [count, 3, height / 2, width / 2] from -1 to 1."""
    from runner.video import scail

    return _whole([scail.halved(frame[None])[0] for frame in read_frames(path, count, width, height, flat)], count)


def find_masks(job, raw, width, height, progress):
    """(pose, pose masks, reference mask, what was found): the driving video at half its size,
    its coloured masks likewise and the mask of the reference image `raw` cut to the shape of
    the generation, the subjects found by SAM 3.1 from the job's words."""
    import torch

    from runner.models import sam3
    from runner.video import identity, scail

    p, paths = job['parameters'], job['components']
    wanted, drawn = p.get('subject') or SUBJECT, p.get('reference_subject') or SUBJECT
    model = sam3.load(paths['segmenter'])
    one = follower = None
    try:
        pieces = sam3.tokenizer(paths['segmenterTokenizer'])
        # The reference: the whole image, as it is.
        one = identity.follow(model, pieces, drawn, [raw])
        ranked = identity.order(one.frames, one.count)
        if not ranked:
            raise ValueError(
                f'Aucun sujet « {drawn} » n’a été trouvé dans l’image de référence. Décrivez-le autrement.'
            )
        shown = identity.coloured(one.frames[0], ranked, raw.shape[-2], raw.shape[-1], identity.BLACK)
        reference_mask = scail.cover(shown, width, height, flat=True)
        # The video: every frame is read once, for the pose and for the masks.
        pose = []

        def pictures():
            for picture in read_frames(_one(job, 'driving_video'), p['frames'], width, height):
                pose.append(scail.halved(picture[None])[0])
                yield picture

        follower = identity.follow(
            model, pieces, wanted, pictures(), progress=lambda done: progress(stage='finding subjects', frame=done)
        )
        pose = _whole(pose, p['frames'])
        order = identity.order(follower.frames, follower.count)
        if not order:
            raise ValueError(
                f'Aucun sujet « {wanted} » n’a été trouvé dans la vidéo à suivre. Décrivez-le autrement.'
            )
        pose_mask = torch.stack(
            [scail.halved(identity.coloured(frame, order, height, width)[None])[0] for frame in follower.frames]
        )
        facts = dict(
            subject=wanted,
            reference_subject=drawn,
            reference_objects=len(ranked),
            objects=[
                dict(colour=rank, frames=sum(item in frame for frame in follower.frames))
                for rank, item in enumerate(order)
            ],
        )
        return pose, pose_mask, reference_mask, facts
    finally:
        # Nothing of the detector stays on the card for the video model.
        del model, one, follower
        sam3.forget()
        gc.collect()
        torch.cuda.empty_cache()


def read_image(path):
    import numpy as np
    from PIL import Image

    with Image.open(path) as image:
        return _picture(np.array(image.convert('RGB')))


def marks(latents, history):
    """The four channels beside the frames to draw: ones over the latent frames given from the
    segment before, zeros over those to draw."""
    import torch

    found = torch.zeros(latents.shape[0], 4, *latents.shape[2:], device=latents.device, dtype=torch.bfloat16)
    if history is not None:
        found[:, :, : history.shape[2]] = 1
    return found


def sample(velocity, noise, levels, history=None, step=None):
    """The latents of a segment: Euler steps from `noise` down `levels`, `velocity(stream,
    level)` being the model. The latent frames of `history` (the end of the segment before) are
    put back as they are before every step and in the result."""
    import torch

    latents = noise.float()
    given = marks(latents, history)
    for index in range(len(levels) - 1):
        if history is not None:
            latents[:, :, : history.shape[2]] = history
        stream = torch.cat([latents.to(torch.bfloat16), given], dim=1)
        moved = velocity(stream, levels[index]).float()
        del stream
        if step:
            # With the step's number, the picture so far: the frame in the middle as the model
            # sees it finished, asked for only if it is shown.
            middle = latents.shape[2] // 2
            step(index + 1, lambda: latents[0, :, middle] - levels[index] * moved[0, :, middle])
        latents = latents + (levels[index + 1] - levels[index]) * moved
        del moved
    if history is not None:
        latents[:, :, : history.shape[2]] = history
    return latents


def stitched(segments, overlap):
    """The frames of the segments in one video: each one after the first without the frames it
    was given."""
    import numpy as np

    return np.concatenate([frames if index == 0 else frames[overlap:] for index, frames in enumerate(segments)])


class _Model:
    """The video model streamed from its file, its LoRAs applied, opened with a share of its
    weights on the GPU and closed whole."""

    def __init__(self, paths, loras, names):
        self.paths, self.loras, self.names = paths, loras, names
        self.stack = self.pool = self.model = None
        self.facts = {}

    def open(self, budget):
        from contextlib import ExitStack

        from runner.models import wan_block, wan_scail2
        from runner.models.pool import WeightPool, load_streamed
        from runner.models.residency import open_store

        self.stack = ExitStack()
        stores = {'model': self.stack.enter_context(open_store(self.paths['model']))}
        adapters = []
        for index, item in enumerate(self.loras):
            stores[f'lora-{index}'] = self.stack.enter_context(open_store(item['path']))
            adapters.append((f'lora-{index}', item['strength']))
        self.pool = WeightPool(stores, budget, adapters=adapters, ahead_gib=AHEAD_GIB)
        self.model = load_streamed(wan_scail2.architecture(), self.names, self.pool)
        differences = sum(
            wan_scail2.add_differences(self.model, self.pool, source, strength) for source, strength in adapters
        )
        fused, fast = wan_block.fuse(self.model)
        if not fused:
            fast = wan_scail2.use_int8_attention(self.model)
        # What will not stay on the GPU goes to page-locked RAM once, for every step and the
        # next segments; what stays is read from the file as it is loaded.
        locked = stores['model'].keep(
            self.pool.streamed().get('model', ()),
            int(RAM_RESERVE_GIB * 1024**3),
            spare=self.pool.streamed(LOCK_MARGIN_GIB, onward=True).get('model', ()),
        )
        self.pool.preload()
        self.facts = dict(
            gpu_cache_gib=round(self.pool.bytes / 1024**3, 3),
            gpu_cache_limit_gib=round(budget, 3),
            locked_ram_gib=round(locked / 1024**3, 3),
            pinned_model=stores['model'].pinned,
            fused_blocks=fused,
            attention='int8' if fast else 'pytorch',
            lora_layers=self.pool.applied(),
            lora_differences=differences,
        )
        return self

    def close(self):
        import torch

        self.model = None
        if self.pool is not None:
            self.pool.clear()
            self.pool = None
        if self.stack is not None:
            self.stack.close()
            self.stack = None
        gc.collect()
        torch.cuda.empty_cache()


def _cached(config, name, parts, make):
    """A tensor kept on the disk for the same inputs and files (runner.models.conditioning)."""
    from runner.models import conditioning

    entry = conditioning.key(name, *parts)
    found = conditioning.load(config, entry)
    if found and 'value' in found[0]:
        return found[0]['value'], 'kept from an earlier generation'
    value = make()
    saved = conditioning.save(config, entry, {'value': value})
    return value, 'kept for the next generations' if saved else 'not kept'


def generate(job, config, progress):
    import torch

    from runner import preview
    from runner.models import conditioning, wan_clip, wan_scail2, wan_text, wan_vae
    from runner.models.headers import header
    from runner.models.pool import require
    from runner.models.residency import RESIDENCY
    from runner.pipelines.ltx25 import memory
    from runner.video import scail
    from runner.video.audio_tail import read_audio
    from runner.video.export import save_video

    if not torch.cuda.is_available():
        raise RuntimeError('Native Wan 2.1 SCAIL-2 requires CUDA')
    check(job, None)
    # The length, the rate and the shape are the driving video's: the job is told what was made.
    count, rate, width, height = clip(job)
    job = dict(job, parameters=dict(job['parameters'], frames=count, fps=rate, width=width, height=height))
    p, paths = job['parameters'], job['components']
    width, height, steps = p['width'], p['height'], p.get('steps', STEPS)
    GiB = 1024**3
    # The length of a segment follows the card: what a step computes with comes first, the
    # weights pass through from RAM where they do not stay.
    free = (hardware.free_bytes(torch) + torch.cuda.memory_reserved()) / GiB
    segment = segment_frames(free, height, width, p.get('segment_frames'))
    segments = scail.plan(p['frames'], segment, scail.OVERLAP)
    longest = scail.tokens(max(count for _first, count in segments), height, width)
    require('Wan 2.1 SCAIL-2', working_gib(longest), 'la taille de la vidéo')
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

    names = wan_scail2.validate_layout(header(paths['model']))
    kind = dict(device='cuda', dtype=torch.bfloat16)
    with torch.inference_mode():
        # 1. The prompt (UMT5-XXL streamed from its file), kept on the disk for the next time.
        progress(stage='loading video prompt encoder')
        text, kept = _cached(
            config,
            'wan_scail2 text',
            (conditioning.stamp(paths['textEncoder']), p['prompt']),
            lambda: wan_text.encode(paths['textEncoder'], p['prompt'], progress),
        )
        progress(stage='video prompt encoded', tokens=int(text.shape[1]), conditioning=kept)

        # 2. The reference, the driving video and their masks.
        progress(stage='encoding references')
        reference_path = next(ref['path'] for ref in job['references'] if ref['role'] == 'reference_image')
        raw = read_image(reference_path)

        def seen():
            clip = wan_clip.load(paths['clipVision'])
            try:
                # The whole image, not the part of it the video shows.
                return wan_clip.image_tokens(clip, raw[None].cuda()).cpu()
            finally:
                del clip
                free_card()

        image, _kept = _cached(
            config,
            'wan_scail2 image',
            (conditioning.stamp(paths['clipVision']), conditioning.stamp(reference_path)),
            seen,
        )
        if masks_given(job):
            reference_mask = scail.cover(read_image(_one(job, 'reference_mask')), width, height, flat=True)
            pose = read_halved(_one(job, 'driving_video'), p['frames'], width, height)
            pose_mask = read_halved(_one(job, 'driving_mask'), p['frames'], width, height, flat=True)
        else:
            progress(stage='finding subjects')
            pose, pose_mask, reference_mask, subjects = find_masks(job, raw, width, height, progress)
            progress(stage='subjects found', **subjects)
        reference = scail.matte(scail.cover(raw, width, height), reference_mask)
        del raw
        vae = wan_vae.load(paths['vae'])
        reference_stream = scail.given(wan_vae.encode(vae, reference[None, :, None].cuda())[0])[None].to(**kind)
        reference_masks = scail.mask_latents(reference_mask[None])[None].to(**kind)
        del reference, reference_mask
        text, image = text.to(**kind), image.to(**kind)
        free_card()
        progress(stage='references encoded', frames=len(pose), segments=[count for _first, count in segments])

        # 3. The segments: the model stays between them, the VAE beside it.
        room = share_gib(hardware.free_bytes(torch) / GiB, longest, height, width, len(segments))
        budget = min(config.get('cacheGiB', 16), room)
        loaded = _Model(paths, loras_of(job), names)
        levels = scail.sigmas(steps, p.get('shift', SHIFT))
        total = steps * len(segments)
        done, history, pictures = 0, None, []
        try:
            for index, (first, count) in enumerate(segments):
                rows = slice(first, first + count)
                pose_stream = scail.given(wan_vae.encode(vae, pose[rows].permute(1, 0, 2, 3)[None].cuda())[0])
                pose_stream = pose_stream[None].to(**kind)
                pose_masks = scail.mask_latents(pose_mask[rows])[None].to(**kind)
                frames = pose_stream.shape[2]
                # One seed for every segment, as the workflow's sampler is run again with its own.
                noise = torch.randn(
                    [1, wan_scail2.LATENT_CHANNELS, frames, height // 8, width // 8],
                    generator=torch.manual_seed(p['seed']),
                ).cuda()
                def attempt():
                    if loaded.model is None:
                        progress(stage='loading video model')
                        progress(stage='sampling video', **loaded.open(budget).facts)
                    model = loaded.model
                    rotary = wan_scail2.rotations(
                        model.rope, frames, height // 16, width // 16, True, dtype=torch.bfloat16
                    )

                    def velocity(stream, level):
                        timestep = torch.tensor([level * 1000], device='cuda')
                        return wan_scail2.forward(
                            model,
                            stream,
                            timestep,
                            text,
                            image,
                            reference_stream,
                            pose_stream,
                            reference_masks,
                            pose_masks,
                            True,
                            rotary,
                        )

                    def stepped(number, estimate):
                        progress(
                            stage='generating video',
                            step=done + number,
                            total=total,
                            segment=index + 1,
                            weights=loaded.pool.summary(),
                        )
                        preview.send(report, preview.WAN21, estimate)

                    return sample(velocity, noise, levels, history, stepped)

                latents = None
                while latents is None:
                    try:
                        latents = attempt()
                    except torch.OutOfMemoryError:
                        if budget <= 0:
                            raise
                    if latents is None:
                        # Out of the handler, the failed attempt's tensors gone: the video memory
                        # ran out as the weights were laid on the card or in a step. The same
                        # segment again with half the weights there, then none.
                        loaded.close()
                        budget = smaller(budget)
                        progress(stage='retrying with a smaller share of the model', gpu_cache_limit_gib=budget)
                done += steps
                del pose_stream, pose_masks, noise
                free_card()
                progress(stage='decoding video', segment=index + 1)
                if index + 1 == len(segments):
                    # The last segment: the card is the decoder's.
                    loaded.close()
                try:
                    decoded = wan_vae.decode(vae, latents)
                except torch.OutOfMemoryError:
                    decoded = None
                if decoded is None:
                    # The model leaves the card for the decoder, and comes back for the next segment.
                    loaded.close()
                    progress(stage='decoding video again without the model')
                    decoded = wan_vae.decode(vae, latents)
                del latents
                if decoded.shape[2] != count:
                    raise RuntimeError(f'Decoded {decoded.shape[2]} frames, expected {count}')
                video = decoded[0].float().permute(1, 2, 3, 0)
                pictures.append(((video + 1) * 127.5).round().clamp(0, 255).to(torch.uint8).cpu().numpy())
                if index + 1 < len(segments):
                    # What the next segment starts from: these frames as they were decoded.
                    history = wan_vae.encode(vae, decoded[:, :, -scail.OVERLAP :])
                del decoded, video
                free_card()
            cache = dict(loaded.facts, residency=RESIDENCY.summary())
            progress(stage='video sampled', **cache)
        finally:
            loaded.close()
        del vae, history, text, image, reference_stream, reference_masks
        free_card()

    pixels = stitched(pictures, scail.OVERLAP)
    progress(stage='video decoded')
    sound = None
    if p.get('audio', True):
        waveform = read_audio(_one(job, 'driving_video'), 0, p['frames'] / p['fps'], rate=AUDIO_RATE)
        if waveform is not None:
            sound = (waveform.T.copy(), AUDIO_RATE)
    metadata = dict(
        job=job,
        parameters=p,
        seconds=round(time.perf_counter() - start, 2),
        peak_vram_gib=round(torch.cuda.max_memory_allocated() / GiB, 3),
        backend='atelier-wan-scail2',
        frames=p['frames'],
        fps=p['fps'],
        segments=[dict(first=first, frames=count) for first, count in segments],
        audio=sound is not None,
        timeline=timeline,
        weight_cache=cache,
    )
    return save_video(pixels, config, job, metadata, audio=sound)
