"""The tensors of a LoRA file, whatever the tool that wrote it.

A LoRA pairs, for a layer of the model, a down matrix [rank, in] and an up matrix [out, rank], with
an optional scalar alpha (the pair is scaled by alpha / rank). Tools name them differently:

- PEFT, diffusers: ``<layer>.lora_A.weight`` / ``<layer>.lora_B.weight``;
- kohya, with the path of the layer: ``<layer>.lora_down.weight`` / ``<layer>.lora_up.weight``;
- kohya, with the path written with ``_`` for ``.``: ``lora_unet_blocks_0_attn_wq.lora_down.weight``,
  found again from the names of the model's own layers;

the layer prefixed or not (``diffusion_model.``, ``model.diffusion_model.``, ``transformer.``).
A pair may also move a vector of the model, such as a norm's scale (``<norm>.scale.lora_down.weight``,
written with dots): its product, of the vector's size, is added to it.
LoKr, LoHa and DoRA are other kinds of adapters, not pairs: they are named as such.
"""

PREFIXES = ('model.diffusion_model.', 'diffusion_model.', 'transformer.', '')
PAIRS = (('.lora_A.weight', '.lora_B.weight'), ('.lora_down.weight', '.lora_up.weight'))
# Other kinds of adapters, which are not a down and an up matrix.
OTHER_KINDS = (
    ('.lokr_w1', 'LoKr'),
    ('.lokr_w2', 'LoKr'),
    ('.lokr_w1_a', 'LoKr'),
    ('.lokr_w2_a', 'LoKr'),
    ('.hada_w1_a', 'LoHa'),
    ('.hada_w2_a', 'LoHa'),
    ('.dora_scale', 'DoRA'),
)


def other_kind(keys):
    """The kind of adapter a file holds when it is not LoRA pairs (LoKr, LoHa, DoRA), else None."""
    for key in keys:
        for ending, kind in OTHER_KINDS:
            if key.endswith(ending):
                return kind
    return None


def lora_pairs(keys, targets):
    """``({target: (down, up, alpha or None)}, left over)`` for the tensors named in ``keys``.

    ``targets`` are the names of the model's layers (``blocks.0.attn.wq.weight``, without the
    ``model.diffusion_model.`` prefix). A pair counts only for a layer of the model and with both
    its matrices; what is not part of a pair, nor its alpha, is left over.
    """
    keys = {key for key in keys if key != '__metadata__'}
    targets = set(targets)
    # kohya writes a layer's path with '_' for '.': the model's own names say which layer it is.
    kohya = {
        'lora_unet_' + target.removesuffix('.weight').replace('.', '_'): target
        for target in targets
        if target.endswith('.weight')
    }
    pairs, used = {}, set()
    for key in keys:
        for down_end, up_end in PAIRS:
            if not key.endswith(down_end):
                continue
            stem = key[: -len(down_end)]
            target = kohya.get(stem)
            if target is None:
                for prefix in PREFIXES:
                    if not stem.startswith(prefix):
                        continue
                    name = stem[len(prefix) :]
                    if name + '.weight' in targets:
                        target = name + '.weight'
                        break
                    # A vector of the model named whole (a norm's scale), not a layer.
                    if name in targets and not name.endswith('.weight'):
                        target = name
                        break
            up = stem + up_end
            if target is None or up not in keys or target in pairs:
                break
            alpha = stem + '.alpha' if stem + '.alpha' in keys else None
            pairs[target] = (key, up, alpha)
            used.update(name for name in (key, up, alpha) if name)
            break
    return pairs, keys - used
