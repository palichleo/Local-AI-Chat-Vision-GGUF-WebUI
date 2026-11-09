"""Read a bounded temporal tail; the source remains an original, never a preview frame."""

from collections import deque

OVERLAPS = (1, 9, 17, 25, 33)


def source_tail(path, parameters):
    import av

    count = parameters.get('overlap_frames', 9)
    if count not in OVERLAPS or count >= parameters['frames']:
        raise ValueError('Overlap must be 1, 9, 17, 25 or 33 frames and shorter than the generation window')
    with av.open(path) as source:
        if any(s.type == 'audio' for s in source.streams):
            raise ValueError('Audio source continuation is not supported yet; use a silent source')
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
        )
