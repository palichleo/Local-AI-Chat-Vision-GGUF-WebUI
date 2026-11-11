"""Atomic original images and replayable manifests under the trusted output root."""

import json
import os
from pathlib import Path
import uuid


def save_image(pixels, config, job, metadata):
    from PIL import Image, PngImagePlugin

    destination = Path(config['outputRoot']).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    filename = uuid.uuid4().hex + '.png'
    output = destination / filename
    manifest = output.with_suffix('.json')
    temporary = destination / (filename + '.tmp')
    temporary_manifest = destination / (filename + '.json.tmp')
    descriptor = dict(
        filename=filename,
        subfolder='',
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
    destination = Path(config['outputRoot']).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    output = destination / (uuid.uuid4().hex + '.wav')
    temporary = destination / (output.name + '.tmp')
    descriptor = dict(
        filename=output.name,
        subfolder='',
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
        output.with_suffix('.json'),
        dict(jobId=job['id'], outputs=[descriptor], metadata=metadata),
    )
