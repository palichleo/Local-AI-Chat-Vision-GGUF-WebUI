"""Load the audio decoder and bandwidth extension vocoder from the chosen checkpoint."""


def vocoder_layout(headers):
    from accelerate import init_empty_weights
    from diffusers.pipelines.ltx2.vocoder import LTX2VocoderWithBWE

    with init_empty_weights():
        model = LTX2VocoderWithBWE()
    names = {}
    for key, value in model.state_dict().items():
        source = 'vocoder.' + key.replace('.conv_in.', '.conv_pre.').replace('.conv_out.', '.conv_post.').replace(
            '.upsamplers.', '.ups.'
        ).replace('.resnets.', '.resblocks.').replace('.act_out.', '.act_post.').replace(
            '.downsample.filter', '.downsample.lowpass.filter'
        )
        spec = headers['audioVae'].get(source)
        if spec is None or spec['shape'] != list(value.shape):
            raise ValueError('Incompatible LTX2.5 vocoder tensor: ' + key)
        names[key] = ('audioVae', source, None)
    return model, names


def decode(latents, job, headers, progress):
    import torch
    from runner.models.residency import open_store
    from runner.models.ltx25 import validate_layout, WeightPool, load_streamed

    with open_store(job['components']['audioVae']) as source, torch.inference_mode():
        models, names = validate_layout(headers)
        vae = models.pop('audioVae')
        del models
        vocoder, vocoder_names = vocoder_layout(headers)
        pool = WeightPool({'audioVae': source}, 0)
        try:
            progress(stage='decoding audio')
            vae = load_streamed(vae, names['audioVae'], pool)
            mel = vae.decode(latents.to('cuda', dtype=torch.bfloat16), return_dict=False)[0]
            del vae
            vocoder = load_streamed(vocoder, vocoder_names, pool)
            waveform = vocoder(mel).float().cpu()[0].T.contiguous().numpy()
            if not torch.isfinite(torch.from_numpy(waveform)).all():
                raise RuntimeError('Non-finite audio; no output saved')
            return waveform, 48000
        finally:
            pool.clear()
