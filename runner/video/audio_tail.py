"""Source audio for LTX2.5 continuation: log-mel input of the audio VAE encoder.

The encoder was trained on 16 kHz stereo log-magnitude mel spectrograms
(1024-point Hann STFT, hop 160, centered with reflect padding, 64 Slaney
mel bands from 0 to 8 kHz with area normalization, log floor 1e-5).
"""

import math

SAMPLE_RATE = 16000
N_FFT = 1024
HOP = 160
MELS = 64
# Audio latents per second: 16000 / 160 mel frames, 4 mel frames per latent.
LATENTS_PER_SECOND = SAMPLE_RATE / HOP / 4


def read_audio(path, start, end, rate=SAMPLE_RATE):
    """Stereo float32 [2, samples] at `rate` Hz between two times in seconds, or None if silent."""
    import av
    import numpy as np

    with av.open(path) as source:
        stream = next((s for s in source.streams if s.type == 'audio'), None)
        if stream is None:
            return None
        resampler = av.AudioResampler(format='fltp', layout='stereo', rate=rate)
        chunks = []
        for frame in source.decode(stream):
            for converted in resampler.resample(frame):
                chunks.append(converted.to_ndarray())
        for converted in resampler.resample(None):
            chunks.append(converted.to_ndarray())
    if not chunks:
        return None
    audio = np.concatenate(chunks, axis=1).astype(np.float32)
    first = max(0, round(start * rate))
    last = round(end * rate)
    clip = audio[:, first:last]
    if clip.shape[1] < last - first:
        clip = np.pad(clip, ((0, 0), (0, last - first - clip.shape[1])))
    return clip


def _hz_to_mel(hz):
    # Slaney scale: linear below 1 kHz, logarithmic above.
    step = 200.0 / 3
    if hz < 1000.0:
        return hz / step
    return 1000.0 / step + math.log(hz / 1000.0) / (math.log(6.4) / 27.0)


def _mel_to_hz(mel, torch):
    step = 200.0 / 3
    knee = 1000.0 / step
    return torch.where(mel < knee, mel * step, 1000.0 * torch.exp((math.log(6.4) / 27.0) * (mel - knee)))


def filterbank(torch):
    """[N_FFT // 2 + 1, MELS] triangular Slaney filters with area normalization."""
    bins = torch.linspace(0, SAMPLE_RATE / 2, N_FFT // 2 + 1, dtype=torch.float64)
    edges = _mel_to_hz(
        torch.linspace(_hz_to_mel(0.0), _hz_to_mel(SAMPLE_RATE / 2), MELS + 2, dtype=torch.float64), torch
    )
    lower, center, upper = edges[:-2], edges[1:-1], edges[2:]
    rising = (bins[:, None] - lower) / (center - lower)
    falling = (upper - bins[:, None]) / (upper - center)
    weights = torch.clamp(torch.minimum(rising, falling), min=0)
    return (weights * (2.0 / (upper - lower))).float()


def log_mel(waveform, torch):
    """[2, samples] float waveform -> [1, 2, frames, MELS] log-mel, as the encoder expects."""
    signal = torch.as_tensor(waveform, dtype=torch.float32)
    spectrum = torch.stft(
        signal,
        N_FFT,
        HOP,
        N_FFT,
        torch.hann_window(N_FFT),
        center=True,
        pad_mode='reflect',
        normalized=False,
        onesided=True,
        return_complex=True,
    ).abs()
    mel = spectrum.transpose(1, 2) @ filterbank(torch)
    return torch.log(torch.clamp(mel, min=1e-5))[None]


def protected_latents(overlap_seconds):
    """Audio latents fully inside the overlap, leaving out the last half STFT window."""
    margin = N_FFT / 2 / SAMPLE_RATE
    return max(1, math.floor((overlap_seconds - margin) * LATENTS_PER_SECOND) + 1)


def encode_tail(path, start, end, vae, torch):
    """Raw audio VAE latents [1, C, K, M] of the source from `start` to `end`, or None if it is silent.

    Up to one second of earlier sound is encoded as causal context; latent index
    context + j then lines up with latent j of the continuation window.
    """
    context = min(int(LATENTS_PER_SECOND), math.floor(start * LATENTS_PER_SECOND))
    waveform = read_audio(path, start - context / LATENTS_PER_SECOND, end)
    if waveform is None:
        return None
    mel = log_mel(waveform, torch).to('cuda', torch.bfloat16)
    latents = vae.encode(mel).latent_dist.mode()
    count = protected_latents(end - start)
    if latents.shape[2] < context + count:
        raise ValueError('Source audio is shorter than the continuation overlap')
    return latents[:, :, context : context + count].float()


def protect_head(transformer, clean):
    """Hold the first audio tokens on the clean source latents, as the video overlap is held.

    The DiT sees those tokens clean at timestep 0, and their velocity is replaced
    so every Euler step predicts them exactly: the last step lands on `clean`.
    `clean` is packed and normalized [B, K, C * M].
    """
    count = clean.shape[1]
    held = {}

    def before(_module, args, values):
        noisy = values['audio_hidden_states']
        timestep = values['audio_timestep']
        held['noisy'] = noisy[:, :count].float()
        held['sigma'] = timestep.float().reshape(-1, 1, 1) / 1000
        hidden = noisy.clone()
        hidden[:, :count] = clean.to(hidden)
        per_token = timestep.reshape(-1, 1).expand(-1, noisy.shape[1]).clone()
        per_token[:, :count] = 0
        values['audio_hidden_states'] = hidden
        values['audio_timestep'] = per_token
        return args, values

    def after(_module, _args, _values, output):
        sound = output[1].clone()
        sound[:, :count] = ((held['noisy'] - clean.float()) / held['sigma']).to(sound.dtype)
        return (output[0], sound, *output[2:])

    return (
        transformer.register_forward_pre_hook(before, with_kwargs=True),
        transformer.register_forward_hook(after, with_kwargs=True),
    )
