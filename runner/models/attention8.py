"""comfy-kitchen's INT8 attention, with the rows it fails on computed again.

The kernel (comfy_kitchen.int8_attention, the method of SageAttention: queries, keys and values on
8 bits, the softmax in float32) sometimes answers « not a number » for a whole row, one head of
one token. Measured on 20/11 with comfy-kitchen 0.2.41 on a pass of Wan 2.2 (40 heads of 28 224
tokens, the low noise model with its step LoRA): one row of the 1.1 million, head 36 of token
3890. The same queries, keys and values in float32 fail alike, and PyTorch's attention answers
them. Every row seen to fail had all its scores far below zero (the best score of that one: -237;
scaled down to -190 the kernel answers it; with fewer keys rows fail from -107): what it takes
exactly is the kernel's own matter, and no made-up input was found that does it.

One such row is enough to lose a clip. The token stays not a number through the blocks that
follow (each of its rows is quantised apart, the others stay clean), and the decoder of Wan, which
reads a frame with the ones before it, draws black from that frame to the end: the first clip
made with the step LoRAs of Wan 2.2 was five frames of the picture, then 76 black ones.

So the answer is looked at, a sum a row (1.3 ms for 40 heads of 28 224 tokens, less than a
hundredth of a pass; a row that failed is not a number from its first value to its last), and
the rows that failed are computed again by PyTorch's attention, exact. Every model that calls
the kernel does it through here.
"""

# How many failed rows are computed again at a time (each reads every key of its head).
ROWS = 1024


def attend(query, key, value, attn_mask=None, kernel=None):
    """The kernel's answer for [batch, heads, tokens, head size] queries, keys and values, every
    row of it a number. `attn_mask` as the kernel takes it (what broadcasts to [batch, heads,
    queries, keys], True or 0 where a key is read); `kernel`: comfy_kitchen.int8_attention unless
    another is given."""
    if kernel is None:
        import comfy_kitchen

        kernel = comfy_kitchen.int8_attention
    answer = kernel(query, key, value) if attn_mask is None else kernel(query, key, value, attn_mask=attn_mask)
    return repaired(answer, query, key, value, attn_mask)


def repaired(answer, query, key, value, attn_mask=None):
    """`answer` with the rows that are not numbers computed again from the queries, keys and
    values it was made from (written in it: it is the kernel's own tensor). Nothing failed, as
    nearly always: `answer` as it is, and nothing else is read."""
    import torch
    import torch.nn.functional as F

    failed = ~torch.isfinite(answer.sum(-1))
    if not bool(failed.any()):
        return answer
    heads, groups = query.shape[1], key.shape[1]
    for batch, head in failed.any(-1).nonzero().tolist():
        # (Grouped queries: several heads of queries read the same head of keys.)
        own = head * groups // heads
        keys, values = key[batch, own].float(), value[batch, own].float()
        for rows in failed[batch, head].nonzero().flatten().split(ROWS):
            mask = None
            if attn_mask is not None:
                mask = torch.broadcast_to(attn_mask, (*failed.shape, key.shape[2]))[batch, head, rows]
                mask = mask if mask.dtype == torch.bool else mask.float()
            exact = F.scaled_dot_product_attention(query[batch, head, rows].float(), keys, values, attn_mask=mask)
            answer[batch, head, rows] = exact.to(answer.dtype)
    return answer
