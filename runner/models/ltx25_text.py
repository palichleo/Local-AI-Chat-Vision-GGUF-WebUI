"""Gemma4 Unified encoding using the tokenizer embedded in the selected checkpoint."""

import gc


def encode(job, headers, progress):
    import torch
    from safetensors import safe_open
    from tokenizers import Tokenizer
    from runner.models.ltx25 import architectures, mappings, WeightPool, load_streamed

    models = architectures(headers)
    model = models.pop('textEncoder')
    del models
    names = mappings(headers)['textEncoder']
    with safe_open(job['components']['textEncoder'], framework='pt') as source:
        if 'tokenizer_json' not in source.keys():
            raise ValueError('Gemma4 checkpoint must contain its tokenizer_json tensor')
        tokenizer = Tokenizer.from_str(source.get_tensor('tokenizer_json').numpy().tobytes().decode('utf8'))
        ids = [2] + tokenizer.encode(job['parameters']['prompt'], add_special_tokens=False).ids
        if len(ids) > 1024:
            raise ValueError('Video prompt exceeds the supported 1024 text tokens; shorten it')
        mask = torch.tensor([[0] * (1024 - len(ids)) + [1] * len(ids)], device='cuda')
        tokens = torch.tensor([[0] * (1024 - len(ids)) + ids], device='cuda')
        pool = WeightPool({'textEncoder': source}, 0)
        try:
            model = load_streamed(model, names, pool)
            progress(stage='encoding video prompt')
            with torch.inference_mode():
                outputs = model(input_ids=tokens, attention_mask=mask, output_hidden_states=True, use_cache=False)
                embeds = torch.stack(outputs.hidden_states, dim=-1).flatten(2, 3).to('cpu', dtype=torch.bfloat16)
            return embeds, mask.cpu()
        finally:
            del model, tokens, mask
            if 'outputs' in locals():
                del outputs
            pool.clear()
            gc.collect()
            torch.cuda.empty_cache()
