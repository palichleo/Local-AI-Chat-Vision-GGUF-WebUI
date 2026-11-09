"""Read a bounded temporal tail; the source remains an original, never a preview frame."""

from collections import deque

OVERLAPS = (1, 9, 17, 25, 33)


def source_tail(path, parameters, overlaps=OVERLAPS, default=9):
    """The last `overlap_frames` frames of the source (PIL images) and the continuation plan.

    `overlaps` are the counts a family's latent grid can protect exactly (LTX2.5: 8n+1,
    MiniMax-H3: 17n+5)."""
    import av

    count = parameters.get('overlap_frames', default)
    if count not in overlaps or count >= parameters['frames']:
        choices = ', '.join(map(str, overlaps))
        raise ValueError(f'Overlap must be one of {choices} frames and shorter than the generation window')
    with av.open(path) as source:
        source_audio = any(s.type == 'audio' for s in source.streams)
        video = next((s for s in source.streams if s.type == 'video'), None)
        if video is None or not video.average_rate:
            raise ValueError('Source has no usable video stream')
        fps = float(video.average_rate)
        if abs(fps - parameters['fps']) > 0.01:
            raise ValueError('Continuation fps must match the source video')
        if (video.width, video.height) != (parameters['width'], parameters['height']):
            raise ValueError('Continuation resolution must match the source video')
        duration = (
            float(video.duration * video.time_base)
            if video.duration is not None
            else float(source.duration or 0) / av.time_base
        )
        if not 0 < duration <= 600:
            raise ValueError('Source duration must be known and at most 600 seconds')
        start = max(0, duration - (count + fps * 2) / fps)
        if start:
            source.seek(int(start / video.time_base), stream=video, backward=True)
        tail = deque(maxlen=count)
        for frame in source.decode(video):
            tail.append(frame.to_image())
        if len(tail) != count:
            raise ValueError('Source video is shorter than the chosen overlap')
        return list(tail), dict(
            overlapFrames=count,
            sourceFrames=video.frames or round(duration * fps),
            sourceDuration=duration,
            newFrames=parameters['frames'] - count,
            sourceAudio=source_audio,
        )
