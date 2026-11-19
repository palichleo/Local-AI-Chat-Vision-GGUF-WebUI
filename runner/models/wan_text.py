"""UMT5-XXL, the text encoder of Wan 2.1, from ComfyUI's single file.

The file holds transformers' own names for the encoder, its weights as 8-bit floats with one
scale each (`<layer>.scale_weight`, the « fp8 scaled » layout), and the SentencePiece model of
its tokenizer (`spiece_model`): nothing else is needed to read a prompt.

As the official Wan code does (github.com/zai-org/SCAIL-2, Apache-2.0, `wan/modules/t5.py`):
the text is cleaned of its repeated blanks, cut to 512 tokens with the end mark, encoded, and
the 512 places the model reads are filled with zeros beyond the tokens of the prompt.
"""

import gc
import html
import re

TOKENS = 512
END = 1
CONFIG = dict(
    vocab_size=256384,
    d_model=4096,
    d_kv=64,
    d_ff=10240,
    num_layers=24,
    num_heads=64,
    relative_attention_num_buckets=32,
    relative_attention_max_distance=128,
    dense_act_fn='gelu_new',
    feed_forward_proj='gated-gelu',
)


def architecture(config=None):
    from accelerate import init_empty_weights
    from transformers import UMT5Config, UMT5EncoderModel

    with init_empty_weights():
        return UMT5EncoderModel(UMT5Config(**(config or CONFIG)))


def names(header, model=None):
    """{name in transformers: ('textEncoder', key of the file, None)}, the sizes checked."""
    model = model or architecture()
    result = {}
    for name, parameter in model.named_parameters():
        key = 'shared.weight' if name == 'encoder.embed_tokens.weight' else name
        if key not in header:
            raise ValueError('Not a UMT5-XXL text encoder: missing ' + key)
        if tuple(header[key]['shape']) != tuple(parameter.shape):
            raise ValueError('Unexpected UMT5 tensor size: ' + key)
        result[name] = ('textEncoder', key, None)
    # The encoder reads its tokens from the table the file stores once (a model that is not
    # empty names that table once as well).
    result['encoder.embed_tokens.weight'] = result['shared.weight']
    return result


def clean(text):
    """The prompt as the tokenizer reads it: entities written out, blanks single."""
    text = html.unescape(html.unescape(text)).strip()
    return re.sub(r'\s+', ' ', text).strip()


def token_ids(text, pieces):
    """The ids of a prompt, the end mark last, 512 at most. `pieces` encodes a string to ids."""
    ids = list(pieces.encode(clean(text)))[: TOKENS - 1]
    return ids + [END]


def tokenizer(source):
    """The SentencePiece tokenizer stored in the encoder's file."""
    import sentencepiece

    if 'spiece_model' not in source.keys():
        raise ValueError('The UMT5 file must contain its tokenizer (spiece_model)')
    return sentencepiece.SentencePieceProcessor(model_proto=source.get_tensor('spiece_model').numpy().tobytes())


def _gated(self, hidden_states):
    """transformers' gated feed-forward (UMT5DenseGatedActDense) without its look at the weights
    of the last layer, which a layer served by the pool does not hold."""
    return self.wo(self.act(self.wi_0(hidden_states)) * self.wi_1(hidden_states))


def streamed(model, found, pool):
    """The encoder with its layers served by the pool. Two things of transformers' model read a
    layer's own weight: the feed-forwards (for its precision), computed here instead, and the
    table of relative positions of each block (for its device), 2 048 values kept as they are."""
    import types

    import torch
    from runner.models.pool import load_streamed

    model = load_streamed(model, found, pool)
    for index, block in enumerate(model.encoder.block):
        attention = block.layer[0].SelfAttention
        name = f'encoder.block.{index}.layer.0.SelfAttention.relative_attention_bias.weight'
        table = pool.read(found[name]).to('cuda', dtype=torch.bfloat16)
        attention.relative_attention_bias = torch.nn.Embedding.from_pretrained(table)
        dense = block.layer[1].DenseReluDense
        dense.forward = types.MethodType(_gated, dense)
    return model


def embed(model, ids):
    """[1, 512, width] in bfloat16 on the processor: the encoder's last states for the tokens
    of the prompt, zeros after them."""
    import torch

    tokens = torch.tensor([ids], device='cuda')
    with torch.inference_mode():
        states = model(input_ids=tokens).last_hidden_state
    padded = states.new_zeros(1, TOKENS, states.shape[-1])
    padded[:, : len(ids)] = states
    return padded.to('cpu', dtype=torch.bfloat16)


def encode(path, prompt, progress=None):
    """The text conditioning of `prompt`, [1, 512, 4096], the encoder streamed from its file."""
    return encode_all(path, [prompt], progress)[0]


def encode_all(path, prompts, progress=None):
    """The text conditioning of each of `prompts`, [1, 512, 4096] each: the encoder is streamed
    from its file once for all of them (Wan 2.2 reads a prompt and what to avoid)."""
    import torch
    from runner.models.headers import header
    from runner.models.pool import WeightPool
    from runner.models.residency import open_store

    model = architecture()
    found = names(header(path), model)
    # Read once per prompt, this file sends nothing away from RAM to sit there.
    with open_store(path, evict=False) as source:
        pieces = tokenizer(source)
        ids = [token_ids(prompt, pieces) for prompt in prompts]
        pool = WeightPool({'textEncoder': source}, 0)
        try:
            model = streamed(model, found, pool)
            if progress:
                progress(stage='encoding video prompt')
            results = [embed(model, item) for item in ids]
            encode.weights = pool.summary()
            return results
        finally:
            del model
            pool.clear()
            gc.collect()
            torch.cuda.empty_cache()
