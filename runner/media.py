"""Atomic original images and replayable manifests under the trusted output root."""

import json
import os
from pathlib import Path
import re
import time
import uuid


def manifest_path(config, name):
    """Where the manifest of the creation `name` goes: the folder of the manifests when the
    application names one (the folder of the creations then holds only them), else beside it."""
    root = Path(config.get('manifestRoot') or config['outputRoot']).resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root / (name + '.json')


# The folder of each kind of creation, under the folder of the outputs.
FOLDERS = dict(image='image', video='video', audio='son')


def output_place(config, job, kind, extension):
    """Where a new creation of `kind` (image, video, audio) is written: (root, output).

    `root` is the folder of the outputs, where the temporary files go: a creation that fails or is
    stopped leaves nothing in the folders of the creations. `output` is the finished file. Named by
    the application (`outputName` of the job: the time, the model, a short suffix), it goes in the
    folder of its kind under that name, or under the same with another suffix when a creation has
    it already. Without a name (an older caller), a random one in the folder of the outputs itself,
    as before.
    """
    from runner.registry import output_name

    root = Path(config['outputRoot']).resolve()
    root.mkdir(parents=True, exist_ok=True)
    name = job.get('outputName')
    if name is None:
        return root, root / (uuid.uuid4().hex + extension)
    output_name(name)
    folder = root / FOLDERS[kind]
    folder.mkdir(exist_ok=True)
    while (folder / (name + extension)).exists() or manifest_path(config, name).exists():
        name = name.rsplit('_', 1)[0] + '_' + uuid.uuid4().hex[:4]
    return root, folder / (name + extension)


def subfolder(config, output):
    """The folder of a creation as its descriptor names it: '' for the folder of the outputs itself."""
    return '' if output.parent == Path(config['outputRoot']).resolve() else output.parent.name


# What this engine writes in the folder of the outputs while a creation is made, and nothing else:
# the name of a creation (the one the application gives, a date and a time first, or 32 hexadecimal
# digits without one: see output_place), then the ending of one of its temporary files (save_image
# and save_audio here, runner.video.stream.output_paths and VideoWriter, runner.video.export).
TEMPORARY = re.compile(
    r'(?:[0-9a-f]{32}|\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d_[a-z0-9]+(?:[_-][a-z0-9]+)*)'
    r'(?:\.tmp\.mp4|\.tmp\.wav|\.tmp\.mux\.mp4|\.mux\.mp4|\.png\.tmp|\.wav\.tmp)'
)
# A temporary file older than this belongs to no creation in progress: one being written changes
# all the time, and the longest step that leaves it alone (the sound added to a video) takes minutes.
STALE_SECONDS = 3600


def sweep(config, older_than=STALE_SECONDS):
    """Removes the temporary files a stopped engine left in the folder of the outputs, and returns
    their names. A creation that fails removes its own; a worker that is killed cannot.

    Only regular files of the folder of the outputs itself (never those of its folders `image`,
    `video` and `son`), named like a temporary file of this engine, and old. One that cannot be
    read or removed is left for the next time: nothing here stops a creation."""
    removed = []
    now = time.time()
    try:
        entries = list(os.scandir(config['outputRoot']))
    except (OSError, KeyError, TypeError, ValueError):
        # No folder of the outputs yet, or none named: nothing to sweep.
        return removed
    for entry in entries:
        try:
            if not TEMPORARY.fullmatch(entry.name) or not entry.is_file(follow_symlinks=False):
                continue
            # Asked of the file itself: what Windows keeps in the folder is only brought up to date
            # when a file is closed.
            if now - os.lstat(entry.path).st_mtime < older_than:
                continue
            os.unlink(entry.path)
            removed.append(entry.name)
        except OSError:
            continue
    return removed


def save_image(pixels, config, job, metadata):
    from PIL import Image, PngImagePlugin

    destination, output = output_place(config, job, 'image', '.png')
    filename = output.name
    manifest = manifest_path(config, output.stem)
    temporary = destination / (filename + '.tmp')
    temporary_manifest = manifest.with_name(manifest.name + '.tmp')
    descriptor = dict(
        filename=filename,
        subfolder=subfolder(config, output),
        type='output',
        width=int(pixels.shape[1]),
        height=int(pixels.shape[0]),
    )
    result = dict(jobId=job['id'], outputs=[descriptor], metadata=metadata)
    info = PngImagePlugin.PngInfo()
    info.add_text('atelier', json.dumps(metadata, ensure_ascii=False, allow_nan=False))
    try:
        Image.fromarray(pixels).save(temporary, format='PNG', pnginfo=info)
        temporary_manifest.write_text(
            json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False), encoding='utf-8'
        )
        os.replace(temporary, output)
        try:
            os.replace(temporary_manifest, manifest)
        except BaseException:
            output.unlink(missing_ok=True)
            raise
    finally:
        temporary.unlink(missing_ok=True)
        temporary_manifest.unlink(missing_ok=True)
    return result


def publish(temporary, output, manifest, result):
    """Moves a finished original and its manifest into place; nothing is left half-written."""
    temporary_manifest = manifest.with_name(manifest.name + '.tmp')
    try:
        temporary_manifest.write_text(
            json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False), encoding='utf-8'
        )
        os.replace(temporary_manifest, manifest)
        os.replace(temporary, output)
    except BaseException:
        temporary.unlink(missing_ok=True)
        temporary_manifest.unlink(missing_ok=True)
        if not output.exists():
            manifest.unlink(missing_ok=True)
        raise
    return result


def save_audio(samples, sample_rate, config, job, metadata):
    """Writes `samples` (channels × samples, floats in [-1, 1]) as a 24-bit PCM WAV original."""
    import wave

    import numpy as np

    samples = np.asarray(samples, dtype=np.float32)
    if samples.ndim == 1:
        samples = samples[None]
    if samples.ndim != 2 or not 1 <= samples.shape[0] <= 8 or samples.shape[1] < 1:
        raise ValueError('Audio must be channels × samples')
    if not np.isfinite(samples).all():
        raise ValueError('Audio contains non-finite samples')
    channels, length = samples.shape
    # Interleaved little-endian 24-bit integers, three bytes each.
    scaled = np.ascontiguousarray(np.round(np.clip(samples.T, -1.0, 1.0) * 8388607.0).astype('<i4'))
    pcm = scaled.view(np.uint8).reshape(length, channels, 4)[:, :, :3].tobytes()
    destination, output = output_place(config, job, 'audio', '.wav')
    temporary = destination / (output.name + '.tmp')
    descriptor = dict(
        filename=output.name,
        subfolder=subfolder(config, output),
        type='output',
        seconds=round(length / sample_rate, 3),
        sampleRate=int(sample_rate),
        channels=int(channels),
    )
    try:
        with wave.open(str(temporary), 'wb') as file:
            file.setnchannels(channels)
            file.setsampwidth(3)
            file.setframerate(int(sample_rate))
            file.writeframes(pcm)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return publish(
        temporary,
        output,
        manifest_path(config, output.stem),
        dict(jobId=job['id'], outputs=[descriptor], metadata=metadata),
    )
