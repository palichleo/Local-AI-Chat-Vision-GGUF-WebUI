"""Write an original MP4 and its resolved job manifest without touching user media."""

import json
import os
from pathlib import Path
import uuid
import subprocess
import wave


def save_video(pixels, config, job, metadata, audio=None):
    import imageio.v3 as iio

    destination = Path(config['outputRoot']).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    name = uuid.uuid4().hex
    temporary = destination / (name + '.tmp.mp4')
    output = destination / (name + '.mp4')
    wave_path = destination / (name + '.tmp.wav')
    muxed = destination / (name + '.mux.mp4')
    manifest = destination / (name + '.json')
    temporary_manifest = destination / (name + '.json.tmp')
    p = job['parameters']
    descriptor = dict(filename=output.name, subfolder='', type='output', width=p['width'], height=p['height'])
    result = dict(jobId=job['id'], outputs=[descriptor], metadata=metadata)
    try:
        if len(pixels) != p['frames'] or pixels.shape[1:3] != (p['height'], p['width']):
            raise ValueError('Decoded video dimensions do not match the approved job')
        iio.imwrite(temporary, pixels, fps=p['fps'], codec='libx264', quality=8, macro_block_size=1)
        if audio is not None:
            import numpy as np
            import imageio_ffmpeg

            waveform, sample_rate = audio
            if waveform.ndim != 2 or waveform.shape[1] != 2 or sample_rate != 48000 or not np.isfinite(waveform).all():
                raise ValueError('Invalid generated stereo audio')
            count = round(len(pixels) / p['fps'] * sample_rate)
            waveform = np.pad(waveform[:count], ((0, max(0, count - len(waveform))), (0, 0)))
            with wave.open(str(wave_path), 'wb') as target:
                target.setnchannels(2)
                target.setsampwidth(2)
                target.setframerate(sample_rate)
                target.writeframes((waveform.clip(-1, 1) * 32767).astype('<i2').tobytes())
            result_process = subprocess.run(
                [
                    imageio_ffmpeg.get_ffmpeg_exe(),
                    '-nostdin',
                    '-v',
                    'error',
                    '-y',
                    '-i',
                    str(temporary),
                    '-i',
                    str(wave_path),
                    '-map',
                    '0:v:0',
                    '-map',
                    '1:a:0',
                    '-c:v',
                    'copy',
                    '-c:a',
                    'aac',
                    '-shortest',
                    '-movflags',
                    '+faststart',
                    str(muxed),
                ],
                capture_output=True,
                timeout=120,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            )
            if result_process.returncode:
                raise RuntimeError('Audio mux failed: ' + result_process.stderr.decode(errors='replace')[-1500:])
            os.replace(muxed, temporary)
        continuation = metadata.get('continuation')
        if continuation:
            import imageio_ffmpeg

            source = next(ref['path'] for ref in job['references'] if ref['role'] == 'source_video')
            overlap = continuation['overlapFrames']
            filters = f'[0:v]setpts=PTS-STARTPTS[a];[1:v]trim=start_frame={overlap},setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1:a=0[v]'
            process = subprocess.run(
                [
                    imageio_ffmpeg.get_ffmpeg_exe(),
                    '-nostdin',
                    '-v',
                    'error',
                    '-y',
                    '-i',
                    source,
                    '-i',
                    str(temporary),
                    '-filter_complex',
                    filters,
                    '-map',
                    '[v]',
                    '-an',
                    '-r',
                    str(p['fps']),
                    '-fps_mode',
                    'cfr',
                    '-c:v',
                    'libx264',
                    '-crf',
                    '18',
                    '-pix_fmt',
                    'yuv420p',
                    '-movflags',
                    '+faststart',
                    str(muxed),
                ],
                capture_output=True,
                timeout=300,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            )
            if process.returncode:
                raise RuntimeError('Continuation export failed: ' + process.stderr.decode(errors='replace')[-1500:])
            os.replace(muxed, temporary)
            metadata['frames'] = continuation['sourceFrames'] + continuation['newFrames']
        temporary_manifest.write_text(
            json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False), encoding='utf8'
        )
        os.replace(temporary_manifest, manifest)
        os.replace(temporary, output)
    except BaseException:
        temporary.unlink(missing_ok=True)
        temporary_manifest.unlink(missing_ok=True)
        if not output.exists():
            manifest.unlink(missing_ok=True)
        raise
    finally:
        wave_path.unlink(missing_ok=True)
        muxed.unlink(missing_ok=True)
    return result
