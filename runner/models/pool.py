"""Weights kept where they are needed: what a model reads from its files, and what stays on the GPU.

Shared by every family (it was born with LTX 2.5). A `WeightPool` reads the weights of a model
from its files (RAM-resident stores, see runner.models.residency) and keeps a fixed share of
them on the GPU; `load_streamed` turns the linear layers of a model into layers that take their
weights from the pool each time they run, in the format the file stores them in (the note each
quantised layer carries, `.comfy_quant`): INT8 through comfy-kitchen's kernel, 8-bit floats
scaled back, plain weights as they are.
"""

import json
import time

GiB = 1024**3


def room(reserve_gib):
    """Video memory a pool may fill now, in GiB: what is free, less what the model needs to run.

    Asked when the job starts, so the same code serves a card of 8, 12 or 24 GiB: all of a model
    stays on the GPU where it fits, a share of it elsewhere.
    """
    import torch

    free, _ = torch.cuda.mem_get_info()
    return max(0.0, free / GiB - reserve_gib)


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
        # The LoRAs of each layer: which ones (`adapted`, said by the layer when it is built),
        # and their matrices once on the GPU (`merged`), where they stay.
        self.adapted = {}
        self.merged = {}
        self.merged_bytes = 0
        self.device = 'cuda'
        # What streaming costs: `first` is the first copy of each tensor, whose pages come from
        # the disk or the file cache (timed); `again` is every later copy, from RAM.
        self.stats = dict(first_gib=0.0, first_seconds=0.0, again_gib=0.0)

    def used(self):
        """Bytes of weights read so far from the files, for a read-ahead to keep its distance."""
        return int(self.stats['first_gib'] * 1024**3)

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
            # It stays on the GPU: its pages in RAM are free for the weights still to come.
            del self.host[location]
        elif size <= RECENT:
            self.recent[location] = (result, size)
            self.recent_bytes += size
            while self.recent_bytes > RECENT:
                self.recent_bytes -= self.recent.pop(next(iter(self.recent)))[1]
        return result

    def adapter(self, location, adapters, dtype=None):
        """The LoRAs of one layer as a single pair (down, up), on the GPU for good.

        Their down matrices are stacked and their up matrices set side by side, each scaled by
        its strength: the layer then pays two small products whatever the number of LoRAs,
        instead of two per LoRA with their matrices copied from RAM at every step (three LoRAs
        cost a Krea 2 step 0.77 s that way, more than ComfyUI's patched weights).
        """
        found = self.merged.get(location)
        if found is None:
            torch = self.torch
            dtype = dtype or torch.bfloat16
            downs, ups = [], []
            for source, key, strength in adapters:
                store = self.stores[source]
                downs.append(store.get_tensor(key + '.lora_A.weight').to(self.device, dtype=dtype))
                ups.append(store.get_tensor(key + '.lora_B.weight').to(self.device, dtype=dtype) * strength)
            found = (torch.cat(downs, dim=0), torch.cat(ups, dim=1))
            size = sum(value.numel() * value.element_size() for value in found)
            self.merged[location] = found
            self.merged_bytes += size
            self.bytes += size
        return found

    def preload(self):
        """Fill the GPU share now, in layer order, before the model runs.

        Filled on the way, the weights that stay were allocated between the short-lived
        tensors of the first step: PyTorch then held up to 2 GiB of video memory it could not
        reuse, enough to push a 12 GiB card past its own memory.
        """
        # The LoRAs first: they are small and every step needs them; the model takes what is left.
        for location, adapters in self.adapted.items():
            self.adapter(location, adapters)
        for location in self.order:
            self.bundle(location)
            if location not in self.gpu:
                break

    def resize(self, limit_gib):
        """Start the GPU share over at another size: everything leaves, then it is filled again
        in layer order. Kept weights scattered between freed ones would split what is free
        into pieces too small for the tensors of a larger video."""
        self.torch.cuda.synchronize()
        self.gpu.clear()
        self.recent.clear()
        self.bytes, self.recent_bytes = self.merged_bytes, 0
        self.torch.cuda.empty_cache()
        self.limit = int(limit_gib * 1024**3)
        if self.limit:
            self.preload()

    def clear(self):
        self.torch.cuda.synchronize()
        self.gpu.clear()
        self.recent.clear()
        self.host.clear()
        self.merged.clear()
        self.bytes = self.recent_bytes = self.merged_bytes = 0


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

            if self.adapters:
                pool.adapted[self.location] = self.adapters

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
                weight = bundle['weight'].to(value.dtype)
                # An 8-bit float weight is stored divided by its scale (« fp8 scaled » files).
                if 'scale' in bundle:
                    weight = weight * bundle['scale'].to(value.dtype)
                result = F.linear(value, weight, None if bias is None else bias.to(value.dtype))
            if self.adapters:
                down, up = pool.adapter(self.location, self.adapters, value.dtype)
                result = result + F.linear(F.linear(value, down), up)
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
