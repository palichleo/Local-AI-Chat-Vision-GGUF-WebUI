"""Validate the complete supported architectures on the meta device before GPU handoff."""


def validate_shapes(headers):
    import torch
    from accelerate import init_empty_weights
    from diffusers.utils import import_utils
    # Native SDPA/cuDNN is used; SageAttention's optional import initializes CUDA during preflight.
    import_utils._sageattention_available=False
    from diffusers import Krea2Transformer2DModel, AutoencoderKLQwenImage
    from diffusers.loaders.single_file_utils import convert_krea2_transformer_checkpoint_to_diffusers, convert_wan_vae_to_diffusers
    from transformers import Qwen3Config, Qwen3ForCausalLM
    with init_empty_weights():
        models={
            'model':Krea2Transformer2DModel(),
            'textEncoder':Qwen3ForCausalLM(Qwen3Config(vocab_size=151936,hidden_size=2560,intermediate_size=9728,
                num_hidden_layers=36,num_attention_heads=32,num_key_value_heads=8,head_dim=128,
                rope_theta=5000000.0,rms_norm_eps=1e-6,max_position_embeddings=262144,tie_word_embeddings=True)),
            'vae':AutoencoderKLQwenImage()}
    for role,model in models.items():
        state={key:torch.empty(entry['shape'],device='meta') for key,entry in headers[role].items() if key!='__metadata__'}
        if role=='model':state=convert_krea2_transformer_checkpoint_to_diffusers(state)
        elif role=='vae':state=convert_wan_vae_to_diffusers(state)
        for key,parameter in model.named_parameters():
            if role=='textEncoder' and key=='lm_head.weight':continue
            if key not in state or state[key].numel()!=parameter.numel():
                raise ValueError('Incompatible '+role+' tensor: '+key)
            # Krea2 stores modulation tensors flattened; its converter deliberately retains that shape.
            if role!='model' and state[key].shape!=parameter.shape:raise ValueError('Incompatible '+role+' shape: '+key)
