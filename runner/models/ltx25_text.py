"""Gemma4 Unified encoding using the tokenizer embedded in the selected checkpoint."""

import gc


def encode(job, headers, progress):
    import torch
    from tokenizers import Tokenizer
    from runner.models.residency import open_store, prefetch, use_order
    from runner.models.ltx25 import architectures, mappings, WeightPool, load_streamed

    models = architectures(headers)
    model = models.pop('textEncoder')
    del models
    names = mappings(headers)['textEncoder']
    # Read once per prompt, this file sends nothing away from RAM to sit there (`evict`): the
    # share of the video model locked for every step stays. Where it finds no room, its layers
    # come from the disk in the order they run (Store.follow), as for MiniMax-H3.
    with open_store(job['components']['textEncoder'], evict=False) as source:
        if 'tokenizer_json' not in source.keys():
            raise ValueError('Gemma4 checkpoint must contain its tokenizer_json tensor')
        tokenizer = Tokenizer.from_str(source.get_tensor('tokenizer_json').numpy().tobytes().decode('utf8'))
        ids = [2] + tokenizer.encode(job['parameters']['prompt'], add_special_tokens=False).ids
        if len(ids) > 1024:
            raise ValueError('Video prompt exceeds the supported 1024 text tokens; shorten it')
        mask = torch.tensor([[0] * (1024 - len(ids)) + [1] * len(ids)], device='cuda')
        tokens = torch.tensor([[0] * (1024 - len(ids)) + ids], device='cuda')
        pool = WeightPool({'textEncoder': source}, 0)
        ahead = None
        try:
            model = load_streamed(model, names, pool)
            # The disk reads the encoder's weights in sequence while its layers run: by the store
            # itself when the file is not kept in RAM, else through the system's cache.
            stems = [key.removesuffix('.weight') for _role, key, _part in pool.order]
            layers = [stem + suffix for stem in stems for suffix in ('.weight', '.weight_scale', '.bias')]
            if not source.follow(layers):
                ahead = prefetch(job['components'], {'textEncoder': source}, use_order(names), lead=pool.used)
            progress(stage='encoding video prompt')
            with torch.inference_mode():
                outputs = model(input_ids=tokens, attention_mask=mask, output_hidden_states=True, use_cache=False)
                embeds = torch.stack(outputs.hidden_states, dim=-1).flatten(2, 3).to('cpu', dtype=torch.bfloat16)
            read = ahead.stop() if ahead else source.reader.summary() if source.reader else None
            encode.weights = dict(pool.summary(), **({'prefetch': read} if read else {}))
            return embeds, mask.cpu()
        finally:
            if ahead:
                ahead.stop()
            del model, tokens, mask
            if 'outputs' in locals():
                del outputs
            pool.clear()
            gc.collect()
            torch.cuda.empty_cache()
