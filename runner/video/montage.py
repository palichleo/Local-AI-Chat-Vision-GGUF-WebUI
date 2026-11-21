"""A film assembled from takes: plans end to end, sounds under them, in one file.

What the application asks (lib/montages.mjs, `assemblyOf`): a size, a rate, the plans in order
(each a video from `from` to `to` seconds, or an image shown that long) and the sounds (each
placed `at` seconds of the film). Nothing is drawn here: ffmpeg cuts every plan to its length,
brings it to the size and the rate of the film, joins them, and mixes the sounds with those of
the clips. The takes are only read; the film is a new creation of the folder of the outputs.

Each plan is brought to the film's size whole, with black on two sides (`fit`), or filling the
picture, what overflows cut equally on both sides (`fill`). Each has exactly its length, picture
and sound: a clip shorter than asked holds its last picture, in silence, so that the plans that
follow start where the montage says.

(0.6.149, La Bobine) A plan may say its instant in the film (`at`): the plans are in their order, none
over the one before it, and a hole between two (or before the first) is black and silent, as long
as it is. Without instants, the plans follow one another.

(0.6.187) What goes out of Moodix may carry a watermark (`watermark`: L'Éclipse, or L'Éclipse and the
name; claude_design/maquettes/watermark-maquette.md): one of the pictures of `watermark/`, ivory at
85 % with its shadow, brought to the size of the film and laid over it, in the lower right corner, or
at the top left in 9:16, where TikTok covers nothing. A take never has one: only the exports do.
"""

import os
import re
import subprocess
import tempfile
import time
from pathlib import Path

RATE = 48000
SOUND = f'aresample={RATE},aformat=sample_fmts=fltp:channel_layouts=stereo'
LIMITS = dict(plans=200, sounds=64, shortest=0.1, longest=600)
SIDES = (128, 4096)
RATES = (1, 60)
MOVING = ('.mp4', '.webm')
STILL = ('.png', '.jpg', '.jpeg', '.webp')
HEARD = ('.wav', '.mp4', '.webm')
# What Windows takes on one command line; the graph itself is read from a file.
LONGEST_COMMAND = 30000
# (0.6.154) A take of a bobine exported alone: `bobines/<the folder of its bobine>/<its number>.mp4`.
FOLDER = re.compile(r'[^\x00-\x1f<>:"/\\|?*]{1,64}')
NUMBERED = re.compile(r'\d{2,3}\.mp4')
# (0.6.187) The watermarks, each made for a short side of 1080 and of 2160 (watermark-maquette.md):
# {short side: (width, height, (left, top, right, bottom) of the drawing in it)}. Around the drawing,
# a transparent margin for the shadow: the margins of the film are counted from the drawing.
WATERMARKS = {
    'eclipse': {1080: (169, 169, (45, 45, 124, 124)), 2160: (336, 336, (89, 89, 247, 247))},
    'eclipse-nom': {1080: (311, 137, (44, 47, 267, 88)), 2160: (619, 272, (87, 95, 534, 176))},
}
WATERMARK_FOLDER = Path(__file__).resolve().parent / 'watermark'


def watermark_place(name, width, height):
    """(0.6.187) Where the watermark `name` goes on a film of that size: (its file, its width and height
    once brought to the film, x, y of its top left corner). S, the short side of the film: the file made
    for 1080 as it is, any other size from the one made for 2160, in the ratio S / 2160. Its drawing is
    4 % of S from the right and the bottom; in 9:16 (TikTok covers the bottom and the right), at 150/1080
    of the width from the left and 270/1920 of the height from the top."""
    short = min(width, height)
    made = 1080 if short == 1080 else 2160
    wide, high, (left, top, right, bottom) = WATERMARKS[name][made]
    ratio = short / made
    path = WATERMARK_FOLDER / f'moodix-watermark-{name}-{made}.png'
    sized = (max(2, round(wide * ratio)), max(2, round(high * ratio)))
    if abs(width / height / (9 / 16) - 1) <= 0.04:
        x, y = width * 150 / 1080 - left * ratio, height * 270 / 1920 - top * ratio
    else:
        x, y = width - 0.04 * short - right * ratio, height - 0.04 * short - bottom * ratio
    return str(path), *sized, round(x), round(y)


def _n(value):
    """A number of seconds as ffmpeg reads it, to the millisecond."""
    return f'{value:.3f}'.rstrip('0').rstrip('.') or '0'


def _file(value, root, endings, label):
    if not isinstance(value, str) or not value or '\0' in value:
        raise ValueError(label + ': invalid path')
    target = Path(value).resolve()
    if root not in target.parents:
        raise ValueError(label + ': only a creation of the outputs is read')
    if target.suffix.lower() not in endings:
        raise ValueError(label + ': not a file of that kind')
    if not target.is_file():
        raise ValueError(label + ' : ce fichier n’existe plus.')
    return str(target)


def _seconds(value, label, low=0.0, high=36000.0):
    if type(value) not in (int, float) or not low <= value <= high:
        raise ValueError(label + ': invalid time')
    return round(float(value), 3)


def _volume(value, label):
    if type(value) not in (int, float) or not 0 <= value <= 2:
        raise ValueError(label + ': invalid volume')
    return round(float(value), 2)


def export_place(value, root):
    """(0.6.154) Where a take of a bobine exported alone goes (« Un fichier par prise »): a file of the
    folder `bobines` of the outputs, in the folder of its bobine, that is not there yet: nothing is
    written over."""
    parts = value.split('/') if isinstance(value, str) else []
    if (
        len(parts) != 3
        or parts[0] != 'bobines'
        or not FOLDER.fullmatch(parts[1])
        or parts[1] != parts[1].strip()
        or parts[1][-1] == '.'
        or not NUMBERED.fullmatch(parts[2])
    ):
        raise ValueError('Invalid export place')
    target = (root / parts[0] / parts[1] / parts[2]).resolve()
    if root / 'bobines' not in target.parents:
        raise ValueError('Invalid export place')
    if target.exists():
        raise ValueError('Ce fichier existe déjà : rien n’est écrit par-dessus.')
    return target


def validated(params, root):
    """The assembly asked, every value checked, every file one of the folder of the outputs."""
    from runner.registry import fields, output_name, text

    known = ('id', 'outputName', 'exportTo', 'watermark', 'width', 'height', 'fps', 'plans', 'sounds')
    fields(params, known, ('id', 'width', 'height', 'fps', 'plans'), 'film')
    text(params['id'], 'id')
    for side in ('width', 'height'):
        if type(params[side]) is not int or not SIDES[0] <= params[side] <= SIDES[1] or params[side] % 2:
            raise ValueError('Invalid film ' + side)
    if type(params['fps']) is not int or not RATES[0] <= params['fps'] <= RATES[1]:
        raise ValueError('Invalid film rate')
    plans, sounds = params['plans'], params.get('sounds', [])
    if not isinstance(plans, list) or not 1 <= len(plans) <= LIMITS['plans']:
        raise ValueError('A film has 1 to 200 plans')
    if not isinstance(sounds, list) or len(sounds) > LIMITS['sounds']:
        raise ValueError('A film has 64 sounds at most')
    result = {key: params[key] for key in ('id', 'width', 'height', 'fps')} | dict(plans=[], sounds=[])
    if 'outputName' in params:
        result['outputName'] = output_name(params['outputName'])
    if 'exportTo' in params:
        # (Its temporary file is named as those of a creation: one a stopped engine leaves is swept.)
        if 'outputName' not in result:
            raise ValueError('An export names its temporary file')
        result['exportTo'] = export_place(params['exportTo'], root)
    if 'watermark' in params:
        # (0.6.187) One of ours, never a file named by the request.
        if params['watermark'] not in WATERMARKS:
            raise ValueError('Invalid watermark')
        result['watermark'] = params['watermark']
    for index, item in enumerate(plans):
        label = f'Plan {index + 1}'
        known = ('path', 'at', 'kind', 'from', 'to', 'frame', 'volume')
        fields(item, known, tuple(key for key in known if key != 'at'), label=label)
        if item['kind'] not in ('video', 'image') or item['frame'] not in ('fit', 'fill'):
            raise ValueError(label + ': invalid kind or frame')
        start, end = _seconds(item['from'], label), _seconds(item['to'], label)
        if not LIMITS['shortest'] <= end - start <= LIMITS['longest'] or (item['kind'] == 'image' and start):
            raise ValueError(label + ': invalid length')
        # Its instant: after the end of the one before it (a millisecond of rounding allowed).
        before = result['plans'][-1] if result['plans'] else None
        follows = round(before['at'] + before['to'] - before['from'], 3) if before else 0.0
        at = _seconds(item['at'], label) if 'at' in item else follows
        if at < follows - 0.001:
            raise ValueError(label + ': starts before the end of the plan before it')
        result['plans'].append(
            {
                'path': _file(item['path'], root, MOVING if item['kind'] == 'video' else STILL, label),
                'at': max(at, follows),
                'kind': item['kind'],
                'from': start,
                'to': end,
                'frame': item['frame'],
                'volume': _volume(item['volume'], label),
            }
        )
    for index, item in enumerate(sounds):
        label = f'Son {index + 1}'
        fields(item, ('path', 'at', 'from', 'to', 'volume'), label=label)
        start, end = _seconds(item['from'], label), _seconds(item['to'], label)
        if end - start < LIMITS['shortest']:
            raise ValueError(label + ': invalid length')
        result['sounds'].append(
            {
                'path': _file(item['path'], root, HEARD, label),
                'at': _seconds(item['at'], label),
                'from': start,
                'to': end,
                'volume': _volume(item['volume'], label),
            }
        )
    return result


def seconds(plan):
    """How long the film is: to the end of its last plan, each at its instant."""
    last = plan['plans'][-1]
    return round(last['at'] + last['to'] - last['from'], 3)


def holes(plan):
    """[(index of the plan after it, seconds)]: the holes of the film, black and silent."""
    found, end = [], 0.0
    for index, item in enumerate(plan['plans']):
        if item['at'] - end > 0.0005:
            found.append((index, round(item['at'] - end, 3)))
        end = round(item['at'] + item['to'] - item['from'], 3)
    return found


def graph(plan, audible):
    """(inputs of the command, the filter graph, the label of the film's sound, its seconds).

    `audible[index]`: whether the file of that plan has a sound of its own."""
    width, height, fps, total = plan['width'], plan['height'], plan['fps'], seconds(plan)
    inputs, filters, joined = [], [], []
    hole = dict(holes(plan))
    for index, item in enumerate(plan['plans']):
        if index in hole:
            # (0.6.149) A hole before this plan: black and silent, as long as it is, made in the graph.
            length = _n(hole[index])
            filters.append(f'color=c=black:s={width}x{height}:r={fps}:d={length},setsar=1,format=yuv420p[g{index}]')
            filters.append(f'anullsrc=r={RATE}:cl=stereo,atrim=duration={length}[h{index}]')
            joined.append(f'[g{index}][h{index}]')
        length = _n(item['to'] - item['from'])
        still = item['kind'] == 'image'
        inputs += (['-loop', '1', '-t', length] if still else []) + ['-i', item['path']]
        cut = '' if still else f"trim=start={_n(item['from'])}:end={_n(item['to'])},setpts=PTS-STARTPTS,"
        if item['frame'] == 'fill':
            sized = f'scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height}'
        else:
            sized = (
                f'scale={width}:{height}:force_original_aspect_ratio=decrease,'
                f'pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black'
            )
        # Exactly its length: a clip shorter than asked holds its last picture.
        filters.append(
            f'[{index}:v]{cut}{sized},fps={fps},tpad=stop_mode=clone:stop_duration={length},'
            f'trim=duration={length},setsar=1,format=yuv420p[v{index}]'
        )
        if audible[index] and item['volume'] > 0:
            filters.append(
                f"[{index}:a]atrim=start={_n(item['from'])}:end={_n(item['to'])},asetpts=PTS-STARTPTS,"
                f"volume={item['volume']},{SOUND},apad,atrim=duration={length}[a{index}]"
            )
        else:
            filters.append(f'anullsrc=r={RATE}:cl=stereo,atrim=duration={length}[a{index}]')
        joined.append(f'[v{index}][a{index}]')
    marked = plan.get('watermark')
    filters.append(''.join(joined) + f"concat=n={len(joined)}:v=1:a=1[{'plain' if marked else 'film'}][clips]")
    mixed, first = ['[clips]'], len(plan['plans'])
    for index, item in enumerate(plan['sounds']):
        # What is left of the film when it starts: a sound never makes the film longer.
        length = min(item['to'] - item['from'], total - item['at'])
        if length <= 0:
            continue
        inputs += ['-i', item['path']]
        number = first + len(mixed) - 1
        filters.append(
            f"[{number}:a]atrim=start={_n(item['from'])}:end={_n(item['from'] + length)},asetpts=PTS-STARTPTS,"
            f"volume={item['volume']},{SOUND},adelay={round(item['at'] * 1000)}:all=1[s{index}]"
        )
        mixed.append(f'[s{index}]')
    if marked:
        # (0.6.187) Its picture, the last input, brought to the film and laid over every frame (a still:
        # the overlay repeats it to the end).
        path, wide, high, x, y = watermark_place(marked, width, height)
        number = first + len(mixed) - 1
        inputs += ['-i', path]
        filters.append(f'[{number}:v]scale={wide}:{high}:flags=area,format=rgba[mark]')
        filters.append(f'[plain][mark]overlay=x={x}:y={y}:format=auto,format=yuv420p[film]')
    if len(mixed) == 1:
        return inputs, ';'.join(filters), '[clips]', total
    # (normalize=0: each keeps the volume it was given, the mix does not lower them all.)
    filters.append(''.join(mixed) + f'amix=inputs={len(mixed)}:duration=first:normalize=0[sound]')
    return inputs, ';'.join(filters), '[sound]', total


def _audible(path):
    import av

    with av.open(path) as source:
        return any(stream.type == 'audio' for stream in source.streams)


def assemble(params, config, progress):
    """Writes the film and its manifest as a creation of the outputs; returns what a generation
    returns: {jobId, outputs: [descriptor], metadata}."""
    import imageio_ffmpeg

    from runner.media import manifest_path, output_place, publish, subfolder

    root = Path(config['outputRoot']).resolve()
    plan = validated(params, root)
    audible = [item['kind'] == 'video' and _audible(item['path']) for item in plan['plans']]
    for index, item in enumerate(plan['sounds']):
        if not _audible(item['path']):
            raise ValueError(f'Son {index + 1} : ce fichier n’a pas de son.')
    inputs, filters, sound, total = graph(plan, audible)
    job = {key: plan[key] for key in ('id', 'outputName') if key in plan}
    exported = plan.get('exportTo')
    if exported:
        destination, output = root, exported
        temporary = root / (plan['outputName'] + '.tmp.mp4')
    else:
        destination, output = output_place(config, job, 'video', '.mp4')
        temporary = destination / (output.stem + '.tmp.mp4')
    started = time.perf_counter()
    script = errors = None
    try:
        # The graph grows with the plans: read from a file, it has no limit of length.
        with tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False, encoding='utf-8') as held:
            held.write(filters)
            script = held.name
        command = [
            imageio_ffmpeg.get_ffmpeg_exe(), '-nostdin', '-v', 'error', '-y', '-progress', 'pipe:1', '-nostats',
            *inputs, '-filter_complex_script', script, '-map', '[film]', '-map', sound,
            '-r', str(plan['fps']), '-fps_mode', 'cfr', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', str(temporary),
        ]  # fmt: skip
        if sum(len(part) + 3 for part in command) > LONGEST_COMMAND:
            raise ValueError('Ce montage compte trop de plans pour un seul export.')
        errors = tempfile.TemporaryFile()
        hidden = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
        told = 0.0
        piped = dict(stdout=subprocess.PIPE, stderr=errors, text=True, creationflags=hidden)
        with subprocess.Popen(command, **piped) as process:
            for line in process.stdout:
                name, _, value = line.strip().partition('=')
                if name == 'out_time_us' and value.lstrip('-').isdigit() and time.perf_counter() - told > 0.4:
                    told = time.perf_counter()
                    done = round(min(total, max(0, int(value)) / 1e6), 2)
                    progress(stage='assembling film', seconds=done, total=total)
        if process.returncode:
            errors.seek(0)
            raise RuntimeError('Film assembly failed: ' + errors.read().decode(errors='replace')[-1500:])
        frames = round(total * plan['fps'])
        descriptor = dict(filename=output.name, subfolder=subfolder(config, output), type='output')
        descriptor.update(width=plan['width'], height=plan['height'])
        metadata = dict(
            backend='atelier-montage',
            seconds=round(time.perf_counter() - started, 2),
            film_seconds=total,
            frames=frames,
            fps=plan['fps'],
            plans=len(plan['plans']),
            sounds=len(plan['sounds']),
            audio=True,
        )
        if plan.get('watermark'):
            metadata['watermark'] = plan['watermark']
        result = dict(jobId=plan['id'], outputs=[descriptor], metadata=metadata)
        if exported:
            # (0.6.154) A file of the folder of its bobine, not a creation: no manifest.
            descriptor.update(subfolder=output.parent.relative_to(root).as_posix(), type='export')
            output.parent.mkdir(parents=True, exist_ok=True)
            if output.exists():
                raise ValueError('Ce fichier existe déjà : rien n’est écrit par-dessus.')
            os.replace(temporary, output)
        else:
            publish(temporary, output, manifest_path(config, output.stem), result)
        progress(stage='film assembled', seconds=total, total=total)
        return result
    finally:
        temporary.unlink(missing_ok=True)
        if errors is not None:
            errors.close()
        if script:
            try:
                os.unlink(script)
            except OSError:
                pass
