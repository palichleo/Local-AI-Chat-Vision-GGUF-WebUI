"""Frame-by-frame video reading and writing, so long or large videos never sit whole in memory."""

from fractions import Fraction
import os
from pathlib import Path
import subprocess
import uuid

MAX_FRAMES = 36000


def probe(path):
    """fps (Fraction), width, height, frame count estimate and whether an audio track exists."""
    import av

    with av.open(str(path)) as source:
        video = next((s for s in source.streams if s.type == 'video'), None)
        if video is None or not video.average_rate:
            raise ValueError('Source has no usable video stream')
        duration = (
            float(video.duration * video.time_base) if video.duration else float(source.duration or 0) / av.time_base
        )
        fps = Fraction(video.average_rate)
        frames = video.frames or round(duration * fps)
        return dict(
            fps=fps,
            width=video.width,
            height=video.height,
            frames=frames,
            duration=duration,
            audio=any(s.type == 'audio' for s in source.streams),
        )


def frames(path):
    """Yields every frame as an RGB uint8 array of shape (H, W, 3)."""
    import av

    with av.open(str(path)) as source:
        video = next(s for s in source.streams if s.type == 'video')
        for count, frame in enumerate(source.decode(video)):
            if count >= MAX_FRAMES:
                raise ValueError('Source video is too long')
            yield frame.to_ndarray(format='rgb24')


def _ffmpeg(*args, timeout=600):
    import imageio_ffmpeg

    result = subprocess.run(
        [imageio_ffmpeg.get_ffmpeg_exe(), '-nostdin', '-v', 'error', '-y', *map(str, args)],
        capture_output=True,
        timeout=timeout,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    if result.returncode:
        raise RuntimeError('FFmpeg failed: ' + result.stderr.decode(errors='replace')[-1500:])


class VideoWriter:
    """Encodes frames as they come, then optionally copies the audio track of another file."""

    def __init__(self, path, width, height, fps):
        import imageio_ffmpeg

        self.path = Path(path)
        self.size = (width, height)
        self.fps = float(fps)
        self.count = 0
        self._writer = imageio_ffmpeg.write_frames(
            str(self.path),
            self.size,
            fps=float(fps),
            codec='libx264',
            quality=8,
            pix_fmt_out='yuv420p',
            macro_block_size=1,
            output_params=['-movflags', '+faststart'],
        )
        self._writer.send(None)

    def write(self, frame):
        import numpy as np

        frame = np.ascontiguousarray(frame)
        if frame.shape[1::-1] != self.size:
            raise ValueError('Frame size does not match the video being written')
        self._writer.send(frame)
        self.count += 1

    def close(self, audio_from=None):
        self._writer.close()
        if audio_from:
            muxed = self.path.with_name(self.path.stem + '.mux' + self.path.suffix)
            try:
                # Every frame written stays: the sound is cut to the length of the picture as it is
                # read. (`-shortest` ends the file when the sound runs out, and drops the frames
                # still waiting to be written: four of 121 when the sound is 30 ms shorter.)
                _ffmpeg(
                    '-i',
                    self.path,
                    '-t',
                    f'{self.count / self.fps:.6f}',
                    '-i',
                    audio_from,
                    '-map',
                    '0:v:0',
                    '-map',
                    '1:a:0?',
                    '-c:v',
                    'copy',
                    '-c:a',
                    'aac',
                    '-movflags',
                    '+faststart',
                    muxed,
                )
                os.replace(muxed, self.path)
            finally:
                muxed.unlink(missing_ok=True)


def output_paths(config, extension):
    """A fresh (final, temporary, manifest) triple under the trusted output folder."""
    destination = Path(config['outputRoot']).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    name = uuid.uuid4().hex
    return destination / (name + extension), destination / (name + '.tmp' + extension), destination / (name + '.json')
