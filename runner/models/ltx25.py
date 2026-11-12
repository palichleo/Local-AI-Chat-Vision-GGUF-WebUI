"""LTX2.5 checkpoint layouts and bounded INT8 loading, independent of ComfyUI."""

import json
import time

# Their home is runner.models.pool now; the families still import them from here.
from runner.models.pool import RECENT, WeightPool, load_streamed  # noqa: F401


def architectures(headers):
    from accelerate import init_empty_weights
    from diffusers.utils import import_utils

    import_utils._sageattention_available = False
    from diffusers import LTX2VideoTransformer3DModel, AutoencoderKLLTX2Audio
    from diffusers.pipelines.ltx2.connectors import LTX2TextConnectors
    from diffusers.models.autoencoders.ltx2_diffusion_decoder import LTX2VideoDiffusionDecoderModel
    from transformers import Gemma4UnifiedTextConfig, Gemma4UnifiedTextModel

    config = json.loads(headers['textEncoder']['__metadata__']['gemma_config'])['text_config']
    supported = {
        'hidden_size': 3840,
        'intermediate_size': 15360,
        'num_hidden_layers': 48,
        'num_attention_heads': 16,
        'num_key_value_heads': 8,
        'num_global_key_value_heads': 1,
        'vocab_size': 262144,
        'head_dim': 256,
        'global_head_dim': 512,
        'hidden_size_per_layer_input': 0,
        'num_kv_shared_layers': 0,
        'enable_moe_block': False,
        'attention_k_eq_v': True,
        'use_double_wide_mlp': False,
        'layer_types': (['sliding_attention'] * 5 + ['full_attention']) * 8,
        'rms_norm_eps': 1e-6,
        'attention_bias': False,
        'hidden_activation': 'gelu_pytorch_tanh',
        'rope_parameters': {
            'full_attention': {'partial_rotary_factor': 0.25, 'rope_theta': 1000000.0, 'rope_type': 'proportional'},
            'sliding_attention': {'rope_theta': 10000.0, 'rope_type': 'default'},
        },
    }
    if any(config.get(key) != value for key, value in supported.items()):
        raise ValueError('Unsupported Gemma4 Unified architecture')
    if len(config.get('layer_types', [])) != 48:
        raise ValueError('Invalid Gemma4 attention layer count')
    with init_empty_weights():
        return dict(
            model=LTX2VideoTransformer3DModel(
                gated_attn=True,
                cross_attn_mod=True,
                audio_gated_attn=True,
                audio_cross_attn_mod=True,
                rope_type='split',
                use_prompt_embeddings=False,
                ff_bias=False,
                audio_ff_bias=False,
                use_prompt_adaln_single=False,
                use_keyframes_abs_pos_embedding=True,
            ),
            connectors=LTX2TextConnectors(
                video_connector_num_attention_heads=32,
                video_connector_num_layers=8,
                video_gated_attn=True,
                audio_connector_num_attention_heads=32,
                audio_connector_attention_head_dim=64,
                audio_connector_num_layers=8,
                audio_gated_attn=True,
                rope_type='split',
                per_modality_projections=True,
                proj_bias=True,
            ),
            textEncoder=Gemma4UnifiedTextModel(
                Gemma4UnifiedTextConfig(
                    **supported, sliding_window=1024, max_position_embeddings=262144, tie_word_embeddings=True
                )
            ),
            vae=LTX2VideoDiffusionDecoderModel(),
            audioVae=AutoencoderKLLTX2Audio(),
        )


def mappings(headers):
    from diffusers.loaders.single_file_utils import (
        convert_ltx2_transformer_to_diffusers,
        convert_ltx2_audio_vae_to_diffusers,
    )

    model = convert_ltx2_transformer_to_diffusers(
        {key: ('model', key, None) for key in headers['model'] if key != '__metadata__'}
    )
    connectors = {
        key.replace('model.diffusion_model.video_embeddings_connector.', 'video_connector.')
        .replace('model.diffusion_model.audio_embeddings_connector.', 'audio_connector.')
        .replace('.transformer_1d_blocks.', '.transformer_blocks.')
        .replace('.q_norm.', '.norm_q.')
        .replace('.k_norm.', '.norm_k.'): ('model', key, None)
        for key in headers['model']
        if 'embeddings_connector.' in key
    }
    for modality in ('video', 'audio'):
        for suffix in ('weight', 'bias'):
            connectors[modality + '_text_proj_in.' + suffix] = (
                'textEncoder',
                'text_embedding_projection.' + modality + '_aggregate_embed.' + suffix,
                None,
            )
    vae = {}
    for key in headers['vae']:
        if key == '__metadata__' or key.startswith('encoder.'):
            continue
        if '.qkv.' in key:
            for i, part in enumerate(('q', 'k', 'v')):
                vae[key.replace('.qkv.', '.to_' + part + '.')] = ('vae', key, i)
        else:
            name = (
                key.replace('.attn.proj.', '.attn.to_out.0.')
                .replace('.q_norm.', '.norm_q.')
                .replace('.k_norm.', '.norm_k.')
            )
            name = name.replace('.t_embedder.mlp.0.', '.t_embedder.timestep_embedder.linear_1.').replace(
                '.t_embedder.mlp.2.', '.t_embedder.timestep_embedder.linear_2.'
            )
            name = name.replace('per_channel_statistics.mean-of-means', 'latents_mean').replace(
                'per_channel_statistics.std-of-means', 'latents_std'
            )
            vae[name] = ('vae', key, None)
    audio = convert_ltx2_audio_vae_to_diffusers(
        {key: ('audioVae', key, None) for key in headers.get('audioVae', {}) if key.startswith('audio_vae.')}
    )
    return dict(
        model=model,
        connectors=connectors,
        textEncoder={
            key.removeprefix('model.'): ('textEncoder', key, None)
            for key in headers['textEncoder']
            if key.startswith('model.')
        },
        vae=vae,
        audioVae=audio,
    )


def validate_layout(headers):
    models = architectures(headers)
    names = mappings(headers)
    for role, model in models.items():
        for key, value in model.state_dict().items():
            if key not in names[role]:
                raise ValueError('Unsupported LTX2.5 ' + role + ' tensor: ' + key)
            source, original, part = names[role][key]
            shape = list(headers[source][original]['shape'])
            if part is not None:
                shape[0] //= 3
            if shape != list(value.shape):
                raise ValueError('Incompatible LTX2.5 ' + role + ' shape: ' + key)
            if headers[source][original]['dtype'] == 'I8' and original.endswith('.weight'):
                scale = headers[source].get(original.removesuffix('.weight') + '.weight_scale', {})
                if scale.get('shape') not in ([], [shape[0], 1]):
                    raise ValueError('Missing/incompatible INT8 scale: ' + original)
    return models, names


def video_encoder(headers):
    import torch
    from accelerate import init_empty_weights
    from diffusers import AutoencoderKLLTX2Video
    from diffusers.loaders.single_file_utils import convert_ltx2_vae_to_diffusers

    with init_empty_weights():
        model = AutoencoderKLLTX2Video(
            block_out_channels=(256, 512, 1024, 1024),
            layers_per_block=(4, 6, 4, 2, 2),
            spatial_compression_ratio=32,
            temporal_compression_ratio=8,
        )
    model.decoder = torch.nn.Identity()
    names = convert_ltx2_vae_to_diffusers(
        {key: ('vae', key, None) for key in headers['vae'] if key.startswith(('encoder.', 'per_channel_statistics.'))}
    )
    for key, value in model.state_dict().items():
        if key not in names or list(value.shape) != headers['vae'][names[key][1]]['shape']:
            raise ValueError('Unsupported LTX2.5 encoder tensor: ' + key)
    return model, names


def latent_upscaler(header, source=None):
    """Checks the ×2 latent upscaler's file; with `source` (its open store), builds it on the GPU.

    A small convolutional model (1 GiB) that doubles the width and height of video latents:
    the bridge between the half-size first pass and the full-size refining pass.
    """
    try:
        config = json.loads(header['__metadata__']['config'])
    except (KeyError, TypeError, ValueError):
        raise ValueError('Unsupported latent upscaler: no configuration in the file') from None
    wanted = dict(dims=3, spatial_upsample=True, temporal_upsample=False, spatial_scale=2.0, rational_resampler=False)
    if any(config.get(key) != value for key, value in wanted.items()):
        raise ValueError('Unsupported latent upscaler: a spatial ×2 upscaler is expected')
    settings = dict(
        in_channels=config.get('in_channels'),
        mid_channels=config.get('mid_channels'),
        num_blocks_per_stage=config.get('num_blocks_per_stage'),
    )
    if settings['in_channels'] != 128 or any(type(value) is not int or value < 1 for value in settings.values()):
        raise ValueError('Unsupported latent upscaler configuration')
    mid = settings['mid_channels']
    if header.get('upsampler.0.weight', {}).get('shape') != [4 * mid, mid, 3, 3]:
        raise ValueError('Unsupported latent upscaler layout')
    if source is None:
        return None
    import torch
    from diffusers.pipelines.ltx2.latent_upsampler import LTX2LatentUpsamplerModel

    model = LTX2LatentUpsamplerModel(
        **settings, dims=3, spatial_upsample=True, temporal_upsample=False, use_rational_resampler=False
    )
    model.load_state_dict({key: source.get_tensor(key) for key in source.keys()}, strict=True)
    return model.eval().to('cuda', dtype=torch.bfloat16)


def chunk_feed_forwards(transformer, rows=8192):
    """Run each block's feed-forward a few thousand tokens at a time.

    Its inner layer is four times as wide as the tokens: for a large video that is one block of
    700 MiB per layer, asked from a GPU already full of smaller pieces. In slices the result is
    the same and the largest block is the size of the tokens themselves.
    """
    import torch

    class Chunked(torch.nn.Module):
        def __init__(self, inner):
            super().__init__()
            self.inner = inner

        def forward(self, hidden, *args, **kwargs):
            if hidden.shape[1] <= rows:
                return self.inner(hidden, *args, **kwargs)
            return torch.cat([self.inner(part, *args, **kwargs) for part in hidden.split(rows, dim=1)], dim=1)

    for block in transformer.transformer_blocks:
        block.ff = Chunked(block.ff)
    return transformer
