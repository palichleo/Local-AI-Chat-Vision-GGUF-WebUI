"""LTX2.5 checkpoint layouts and bounded INT8 loading, independent of ComfyUI."""

import json
import time


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


RECENT = 384 * 1024**2


class WeightPool:
    """Keep a fixed subset resident; streaming a whole traversal must not thrash an LRU.

    The other weights are copied to the GPU each time a layer runs. The last ones copied stay
    for a moment (`RECENT` bytes): a layer that runs its rows in chunks, as the wide
    feed-forwards do, then copies its weights once per step instead of once per chunk.
    """

    def __init__(self, stores, limit_gib=0, adapters=()):
        import torch, comfy_kitchen

        self.torch = torch
        self.kernels = comfy_kitchen
        self.stores = stores
        self.limit = int(limit_gib * 1024**3)
        self.bytes = 0
        self.gpu = {}
        self.recent = {}
        self.recent_bytes = 0
        self.order = []
        self.host = {}
        self.adapters = adapters
        # What streaming costs: `first` is the first copy of each tensor, whose pages come from
        # the disk or the file cache (timed); `again` is every later copy, from RAM.
        self.stats = dict(first_gib=0.0, first_seconds=0.0, again_gib=0.0)

    def read(self, location):
        source, key, part = location
        value = self.stores[source].get_tensor(key)
        return value.chunk(3, dim=0)[part] if part is not None else value

    def summary(self):
        return {key: round(value, 2) for key, value in self.stats.items()}

    def bundle(self, location):
        if location in self.gpu:
            return self.gpu[location]
        if location in self.recent:
            return self.recent[location][0]
        started = time.perf_counter()
        first = location not in self.host
        if first:
            source, key, part = location
            store = self.stores[source]
            values = {'weight': self.read(location)}
            for suffix, label in (('.weight_scale', 'scale'), ('.bias', 'bias')):
                candidate = key.removesuffix('.weight') + suffix
                if candidate in store.keys():
                    value = store.get_tensor(candidate)
                    if part is not None and value.ndim:
                        value = value.chunk(3, dim=0)[part]
                    values[label] = value
            self.host[location] = values
        result = {key: value.to('cuda', non_blocking=True) for key, value in self.host[location].items()}
        size = sum(value.numel() * value.element_size() for value in result.values())
        if first:
            self.stats['first_gib'] += size / 1024**3
            self.stats['first_seconds'] += time.perf_counter() - started
        else:
            self.stats['again_gib'] += size / 1024**3
        if self.bytes + size <= self.limit:
            self.gpu[location] = result
            self.bytes += size
        elif size <= RECENT:
            self.recent[location] = (result, size)
            self.recent_bytes += size
            while self.recent_bytes > RECENT:
                self.recent_bytes -= self.recent.pop(next(iter(self.recent)))[1]
        return result

    def preload(self):
        """Fill the GPU share now, in layer order, before the model runs.

        Filled on the way, the weights that stay were allocated between the short-lived
        tensors of the first step: PyTorch then held up to 2 GiB of video memory it could not
        reuse, enough to push a 12 GiB card past its own memory.
        """
        for location in self.order:
            self.bundle(location)
            if location not in self.gpu:
                break

    def clear(self):
        self.torch.cuda.synchronize()
        self.gpu.clear()
        self.recent.clear()
        self.host.clear()
        self.bytes = self.recent_bytes = 0


def load_streamed(model, names, pool):
    import torch
    import torch.nn.functional as F
    from accelerate.utils import set_module_tensor_to_device

    class Linear(torch.nn.Module):
        def __init__(self, location):
            super().__init__()
            self.location = location
            pool.order.append(location)
            self.out_features, self.in_features = pool.read(location).shape
            store = pool.stores[location[0]]
            key = location[1].removesuffix('.weight') + '.comfy_quant'
            quant = json.loads(store.get_tensor(key).numpy().tobytes()) if key in store.keys() else {}
            self.rotation = quant.get('convrot_groupsize', 256) if quant.get('convrot') else 0
            if self.rotation and self.in_features % self.rotation:
                raise ValueError('Invalid ConvRot group size')
            self.adapters = []
            if location[0] == 'model':
                stem = location[1].removesuffix('.weight').removeprefix('model.diffusion_model.')
                for source, strength in pool.adapters:
                    for prefix in ('diffusion_model.', 'model.diffusion_model.', ''):
                        key = prefix + stem
                        if key + '.lora_A.weight' in pool.stores[source].keys():
                            alpha = (
                                pool.stores[source].get_tensor(key + '.alpha').item()
                                / pool.stores[source].get_slice(key + '.lora_A.weight').get_shape()[0]
                                if key + '.alpha' in pool.stores[source].keys()
                                else 1
                            )
                            self.adapters.append((source, key, strength * alpha))
                            break

        def forward(self, value):
            bundle = pool.bundle(self.location)
            if bundle['weight'].dtype == torch.int8:
                result = torch.ops.comfy_kitchen.int8_linear(
                    value,
                    bundle['weight'],
                    bundle['scale'],
                    bundle.get('bias'),
                    pool.kernels.DTYPE_TO_CODE[value.dtype],
                    bool(self.rotation),
                    self.rotation or 256,
                )
            else:
                bias = bundle.get('bias')
                result = F.linear(value, bundle['weight'].to(value.dtype), None if bias is None else bias.to(value.dtype))
            for source, key, strength in self.adapters:
                a = pool.bundle((source, key + '.lora_A.weight', None))['weight'].to(value.dtype)
                b = pool.bundle((source, key + '.lora_B.weight', None))['weight'].to(value.dtype)
                result = result + F.linear(F.linear(value, a), b) * strength
            return result

    class Embedding(torch.nn.Module):
        def __init__(self, location, scale):
            super().__init__()
            self.location = location
            self.scale = scale

        def forward(self, ids):
            # Upload only the selected rows of the 2 GiB vocabulary table.
            rows = (
                pool.read(self.location)
                .index_select(0, ids.reshape(-1).cpu())
                .to(device=ids.device, dtype=torch.bfloat16)
            )
            return rows.reshape(*ids.shape, -1) * self.scale

    for name, module in list(model.named_modules()):
        if isinstance(module, torch.nn.Linear):
            model.set_submodule(name, Linear(names[name + '.weight']))
        elif isinstance(module, torch.nn.Embedding):
            model.set_submodule(name, Embedding(names[name + '.weight'], getattr(module, 'embed_scale', 1)))
    for name, parameter in list(model.named_parameters()) + list(model.named_buffers()):
        if name not in names:
            if parameter.device.type == 'meta':
                raise ValueError('Missing native tensor ' + name)
            continue
        value = pool.read(names[name]).to('cuda', dtype=torch.bfloat16)
        set_module_tensor_to_device(model, name, 'cuda', value=value, dtype=torch.bfloat16)
    # Parameters were cast above; keep generated RoPE/filter buffers at their native precision.
    return model.eval().to(device='cuda')
