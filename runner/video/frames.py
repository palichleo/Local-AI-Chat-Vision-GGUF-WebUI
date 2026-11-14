"""A few pictures of a video, for whoever has to describe it: small JPEG copies at even times.

The application writes the prompt of a character put in a video from what that video shows;
for a video made earlier, it has nothing else to look at than its file. The first frame alone
(its thumbnail) is not enough: a clip made from a still image starts on that image, and what
happens comes after.
"""

import base64
import io
from pathlib import Path

# Where in the video, as shares of its length: near the start, the middle, near the end.
SPOTS = {1: (0.5,), 2: (0.15, 0.85), 3: (0.03, 0.5, 0.97)}
EXTENSIONS = ('.mp4', '.webm', '.mov', '.mkv')


def times(duration, count):
    """The times (in seconds) of `count` pictures of a video of `duration` seconds."""
    spots = SPOTS.get(count) or tuple((index + 0.5) / count for index in range(count))
    return [round(duration * spot, 3) for spot in spots]


def sample(path, count=3, side=512, quality=80):
    """[{'time': seconds, 'url': 'data:image/jpeg;base64,…'}]: `count` pictures of the video, the
    longest side `side` pixels at most, each the first frame at or after its time."""
    import av
    from PIL import Image

    path = Path(path)
    if path.suffix.lower() not in EXTENSIONS or not path.is_file():
        raise ValueError('Not a video file')
    found = []
    with av.open(str(path)) as source:
        video = next((stream for stream in source.streams if stream.type == 'video'), None)
        if video is None:
            raise ValueError('The file has no video stream')
        duration = (
            float(video.duration * video.time_base)
            if video.duration
            else float(source.duration or 0) / av.time_base
        )
        if duration <= 0:
            raise ValueError('The video has no known length')
        for wanted in times(duration, count):
            # Seek to the key frame before, then decode up to the time asked.
            source.seek(int(wanted / video.time_base), stream=video, backward=True, any_frame=False)
            picture = None
            for frame in source.decode(video):
                picture = frame
                if frame.time is not None and frame.time >= wanted - 1e-3:
                    break
            if picture is None:
                continue
            image = picture.to_image().convert('RGB')
            image.thumbnail((side, side))
            buffer = io.BytesIO()
            image.save(buffer, format='JPEG', quality=quality)
            found.append(
                dict(
                    time=round(float(picture.time if picture.time is not None else wanted), 3),
                    url='data:image/jpeg;base64,' + base64.b64encode(buffer.getvalue()).decode('ascii'),
                )
            )
    return found
