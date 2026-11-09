"""RIFE frame interpolation: a smoother video at a higher frame rate, or a slow-motion version."""

import time

MAX_FPS = 240


def preflight(job, config):
    from runner.video.stream import probe

    info = probe(job['references'][0]['path'])
    multiplier = job['parameters']['multiplier']
    if job['parameters'].get('mode', 'smooth') == 'smooth' and info['fps'] * multiplier > MAX_FPS:
        raise ValueError(f'The smoothed video would exceed {MAX_FPS} fps; use a smaller multiplier')
    if info['frames'] < 2:
        raise ValueError('Interpolation needs a video of at least two frames')


def generate(job, config, progress):
    import torch

    from runner.media import publish
    from runner.models import rife
    from runner.video.stream import VideoWriter, frames, output_paths, probe

    start = time.perf_counter()
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    dtype = torch.float16 if device == 'cuda' else torch.float32
    if device == 'cuda':
        torch.cuda.reset_peak_memory_stats()
    progress(state='loading')
    model = rife.load(job['components']['interpolator']).to(device, dtype)
    parameters = job['parameters']
    multiplier, mode = parameters['multiplier'], parameters.get('mode', 'smooth')
    source = job['references'][0]['path']
    info = probe(source)
    # Smooth keeps the duration (and the audio) at a higher frame rate; slow motion keeps the frame rate.
    fps = info['fps'] * multiplier if mode == 'smooth' else info['fps']
    output, temporary, manifest = output_paths(config, '.mp4')
    writer = VideoWriter(temporary, info['width'], info['height'], fps)

    def tensor(pixels):
        return torch.from_numpy(pixels).to(device).permute(2, 0, 1)[None].to(dtype) / 255

    def array(frame):
        return (frame[0].permute(1, 2, 0).float().clamp(0, 1) * 255).round().to(torch.uint8).cpu().numpy()

    total = max(info['frames'] - 1, 1)
    try:
        previous = previous_pixels = None
        for index, pixels in enumerate(frames(source)):
            current = tensor(pixels)
            if previous is not None:
                writer.write(previous_pixels)
                for step in range(1, multiplier):
                    writer.write(array(rife.between(model, previous, current, step / multiplier)))
                progress(step=index, total=max(total, index))
            previous, previous_pixels = current, pixels
        if previous_pixels is not None:
            writer.write(previous_pixels)
        writer.close(audio_from=source if info['audio'] and mode == 'smooth' else None)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    metadata = dict(
        job=job,
        backend='pytorch-rife',
        device=device,
        seconds=round(time.perf_counter() - start, 2),
        frames=writer.count,
        fps=float(fps),
        source_fps=float(info['fps']),
        mode=mode,
        audio=info['audio'] and mode == 'smooth',
    )
    if device == 'cuda':
        metadata['peak_vram_gib'] = round(torch.cuda.max_memory_allocated() / 1024**3, 3)
    descriptor = dict(filename=output.name, subfolder='', type='output', width=info['width'], height=info['height'])
    return publish(temporary, output, manifest, dict(jobId=job['id'], outputs=[descriptor], metadata=metadata))
