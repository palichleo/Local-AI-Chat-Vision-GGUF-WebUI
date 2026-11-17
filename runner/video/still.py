"""The first or the last picture of a video, written as a file at the video's own size.

    python -m runner frame --input clip.mp4 --at last --output last.png [--preview small.jpg]

A new clip that starts where another one ends takes that picture as its first frame: the exact
one, never a reduced copy nor a picture « near the end ». A one-shot command on the processor,
apart from the worker: only PyAV and Pillow are loaded, no model and nothing of torch.
"""

import argparse
import json
import os
from pathlib import Path
import sys
import uuid

EXTENSIONS = ('.mp4', '.webm', '.mov', '.mkv')
# How long before the declared end the decoding starts (seconds), further back when nothing comes
# out: the length a container declares may be a little longer than its pictures.
BACK = (2.0, 8.0, 32.0)


def decode(source, video, first=False):
    """The last picture decoded from where the file is read (the first one when `first`), or None.
    A file cut short keeps the pictures decoded before the fault."""
    import av

    picture = None
    try:
        for frame in source.decode(video):
            picture = frame
            if first:
                break
    except av.error.FFmpegError:
        if picture is None:
            raise
    return picture


def still(path, at='last'):
    """The first or the last picture of the video `path`: (PIL image, its time in seconds or None)."""
    import av

    if at not in ('first', 'last'):
        raise ValueError('Image demandée invalide : first ou last.')
    path = Path(path)
    if path.suffix.lower() not in EXTENSIONS or not path.is_file():
        raise ValueError('Ce fichier n’est pas une vidéo lisible.')
    with av.open(str(path)) as source:
        video = next((stream for stream in source.streams if stream.type == 'video'), None)
        if video is None:
            raise ValueError('Ce fichier ne contient pas de vidéo.')
        video.thread_type = 'AUTO'
        picture = None
        if at == 'first':
            picture = decode(source, video, first=True)
        else:
            duration = (
                float(video.duration * video.time_base)
                if video.duration
                else float(source.duration or 0) / av.time_base
            )
            origin = video.start_time or 0
            moved = False
            for back in BACK if duration > 0 else ():
                start = duration - back
                if start <= 0:
                    break
                moved = True
                try:
                    # The key frame before that time, then every picture up to the end of the file.
                    source.seek(origin + int(start / video.time_base), stream=video, backward=True, any_frame=False)
                    picture = decode(source, video)
                except av.error.FFmpegError:
                    picture = None
                if picture is not None:
                    break
            if picture is None:
                # A short clip, a length unknown or a file that cannot be sought: read from its start.
                if moved:
                    source.seek(origin, stream=video, backward=True, any_frame=False)
                picture = decode(source, video)
        if picture is None:
            raise ValueError('Cette vidéo ne contient aucune image lisible.')
        # The pixels a continuation reads (runner.video.continuation): the same conversion.
        return picture.to_image().convert('RGB'), (None if picture.time is None else float(picture.time))


def write(image, output, **options):
    """Writes `image` at `output`, never half-written: under another name first, then moved."""
    output = Path(output)
    temporary = output.with_name(f'{output.name}.{uuid.uuid4().hex}.tmp')
    try:
        image.save(temporary, **options)
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


def extract(path, at, output, preview=None, side=1024):
    """Writes the first or last picture of `path` as the PNG `output`, and a small JPEG copy of it
    as `preview` (its longest side `side` pixels at most) when one is asked."""
    image, time = still(path, at)
    write(image, output, format='PNG', compress_level=3)
    if preview:
        small = image.copy()
        small.thumbnail((side, side))
        write(small, preview, format='JPEG', quality=88)
    return dict(width=image.width, height=image.height, time=time)


def main(arguments=None):
    parser = argparse.ArgumentParser(prog='python -m runner frame', description=__doc__.splitlines()[0])
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--at', required=True, choices=('first', 'last'))
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--preview', type=Path)
    parser.add_argument('--side', type=int, default=1024)
    args = parser.parse_args(arguments)
    try:
        if not 64 <= args.side <= 4096:
            raise ValueError('Taille de la copie invalide.')
        result = extract(args.input, args.at, args.output, args.preview, args.side)
    except Exception as error:
        # One line the application repeats to the user.
        print(str(error).strip().splitlines()[-1] if str(error).strip() else type(error).__name__, file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
