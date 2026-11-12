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

    With `ahead_gib`, those copies are made in advance: the pool notes, the first time through,
    the order in which the model asks for its streamed layers, and from then on copies the next
    ones on a stream of their own while the GPU computes, up to that many GiB ahead. Copied from
    page-locked RAM, they then cost nothing; without it the GPU waited for each.
    """

    def __init__(self, stores, limit_gib=0, adapters=(), ahead_gib=0):
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
        # Copies in advance (see the class note): what is on its way, and the order of the
        # streamed layers as the model asks for them (`sequence`, `place`), known once a layer
        # comes back (`known`).
        self.ahead_limit = int(ahead_gib * GiB)
        self.ahead = {}
        self.ahead_bytes = 0
        self.sequence = []
        self.place = {}
        self.known = False
        self.last = None
        self.stream = None
        if self.ahead_limit:
            self.stats['ahead_gib'] = 0.0

    def used(self):
        """Bytes of weights read so far from the files, for a read-ahead to keep its distance."""
        return int(self.stats['first_gib'] * 1024**3)

    def read(self, location):
        source, key, part = location
        value = self.stores[source].get_tensor(key)
        return value.chunk(3, dim=0)[part] if part is not None else value

    def summary(self):
        return {key: round(value, 2) for key, value in self.stats.items()}

    def parts(self, location):
        """What a layer reads from its file: its weight, with its scale and bias when it has them,
        and the file keys they come from."""
        source, key, part = location
        store = self.stores[source]
        values, keys = {'weight': self.read(location)}, [key]
        for suffix, label in (('.weight_scale', 'scale'), ('.bias', 'bias')):
            candidate = key.removesuffix('.weight') + suffix
            if candidate in store.keys():
                value = store.get_tensor(candidate)
                if part is not None and value.ndim:
                    value = value.chunk(3, dim=0)[part]
                values[label] = value
                keys.append(candidate)
        return values, keys

    def streamed(self, margin_gib=0, onward=False):
        """The file keys of the weights that will not stay on the GPU with the present limit,
        by store: what every step copies there again. Follows `bundle` in layer order: each
        layer stays if it still fits. Asked before the model runs, to keep these in
        page-locked RAM (Store.keep).

        `margin_gib` answers for a limit that much lower, and `onward` names every layer from
        the first that does not fit, whether a later one would or not. Together they give what
        to lock beyond the need of the moment: the free video memory differs by a few dozen
        megabytes from one generation to the next, a later small layer then fits or not, and
        what was locked for the last generation must still cover this one (measured: a share
        47 MiB smaller meant 14 GiB locked again, 11 s). Whatever a limit at least that high
        streams lies from that first layer onward.
        """
        limit = max(0, self.limit - int(margin_gib * GiB))
        held, keys, cut = self.bytes, {}, False
        for location in self.order:
            if location in self.gpu:
                continue
            values, names = self.parts(location)
            size = sum(value.numel() * value.element_size() for value in values.values())
            if not (cut and onward) and held + size <= limit:
                held += size
            else:
                cut = True
                keys.setdefault(location[0], set()).update(names)
        return keys

    def bundle(self, location):
        if location in self.gpu:
            return self.gpu[location]
        if location in self.recent:
            return self.recent[location][0]
        if location in self.ahead:
            # Copied in advance: the GPU waits for that copy only, if it is not done yet.
            result, done, size = self.ahead.pop(location)
            self.ahead_bytes -= size
            current = self.torch.cuda.current_stream()
            current.wait_event(done)
            for value in result.values():
                value.record_stream(current)
            self.stats['again_gib'] += size / GiB
            self.stats['ahead_gib'] += size / GiB
        else:
            started = time.perf_counter()
            first = location not in self.host
            if first:
                self.host[location] = self.parts(location)[0]
            result = {key: value.to('cuda', non_blocking=True) for key, value in self.host[location].items()}
            size = sum(value.numel() * value.element_size() for value in result.values())
            if first:
                self.stats['first_gib'] += size / 1024**3
                self.stats['first_seconds'] += time.perf_counter() - started
            else:
                self.stats['again_gib'] += size / 1024**3
        if self.ahead_limit:
            self._note(location)
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
        if self.ahead_limit and self.known:
            self._send_ahead(location)
        return result

    def _note(self, location):
        """Learn the order of the streamed layers: the first pass writes it down; a layer asked
        for again closes it; a layer seen for the first time later (one some steps only use)
        takes its place after the one asked for before it."""
        if location not in self.place:
            if self.known and self.last in self.place:
                self.sequence.insert(self.place[self.last] + 1, location)
                self.place = {item: index for index, item in enumerate(self.sequence)}
            else:
                self.place[location] = len(self.sequence)
                self.sequence.append(location)
        elif not self.known:
            self.known = True
        self.last = location

    def _send_ahead(self, location):
        """Copy the streamed layers that follow `location`, on the pool's own stream, until
        `ahead_limit` bytes are on their way."""
        torch = self.torch
        if self.stream is None:
            self.stream = torch.cuda.Stream()
        count = len(self.sequence)
        index = self.place.get(location)
        if index is None:
            return
        upcoming, budget = [], 0
        for offset in range(1, count):
            following = self.sequence[(index + offset) % count]
            if following == location:
                break
            if following in self.gpu or following in self.recent:
                continue
            host = self.host.get(following)
            if host is None:
                continue
            size = sum(value.numel() * value.element_size() for value in host.values())
            if upcoming and budget + size > self.ahead_limit:
                break
            upcoming.append((following, host, size))
            budget += size
        # What was sent ahead and is no longer next (a layer some steps skip) goes away.
        wanted = {following for following, _, _ in upcoming}
        for stale in [item for item in self.ahead if item not in wanted]:
            self.ahead_bytes -= self.ahead.pop(stale)[2]
        for following, host, size in upcoming:
            if following in self.ahead:
                continue
            # Allocated and copied on the pool's stream: its memory is never one the GPU still
            # reads for a layer before (see bundle, record_stream).
            with torch.cuda.stream(self.stream):
                result = {key: value.to('cuda', non_blocking=True) for key, value in host.items()}
                done = torch.cuda.Event()
                done.record(self.stream)
            self.ahead[following] = (result, done, size)
            self.ahead_bytes += size

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
        self.ahead.clear()
        self.bytes, self.recent_bytes, self.ahead_bytes = self.merged_bytes, 0, 0
        self.torch.cuda.empty_cache()
        self.limit = int(limit_gib * 1024**3)
        if self.limit:
            self.preload()

    def clear(self):
        self.torch.cuda.synchronize()
        self.gpu.clear()
        self.recent.clear()
        self.ahead.clear()
        self.host.clear()
        self.merged.clear()
        self.bytes = self.recent_bytes = self.merged_bytes = self.ahead_bytes = 0


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

        def forward(self, value, rows=None, act=None):
            """`rows` (a slice) computes only those outputs: a part of a fused projection, as
            the queries and keys of a fused q, k, v. `act='swiglu'` takes [gate | up] rows and
            computes silu(gate) * up on the way in: in comfy-kitchen's INT8 quantizer, so a
            feed-forward's wide intermediate is never written out."""
            bundle = pool.bundle(self.location)
            weight, scale, bias = bundle['weight'], bundle.get('scale'), bundle.get('bias')
            if rows is not None:
                weight = weight[rows]
                scale = scale[rows] if scale is not None and scale.ndim else scale
                bias = None if bias is None else bias[rows]
            if act is not None and (weight.dtype != torch.int8 or self.adapters):
                gate, up = value.chunk(2, dim=-1)
                value, act = F.silu(gate) * up, None
            if weight.dtype == torch.int8 and act is not None:
                result = pool.kernels.int8_linear(
                    value,
                    weight,
                    scale,
                    bias,
                    value.dtype,
                    bool(self.rotation),
                    self.rotation or 256,
                    input_act=act,
                )
            elif weight.dtype == torch.int8:
                result = torch.ops.comfy_kitchen.int8_linear(
                    value,
                    weight,
                    scale,
                    bias,
                    pool.kernels.DTYPE_TO_CODE[value.dtype],
                    bool(self.rotation),
                    self.rotation or 256,
                )
            else:
                weight = weight.to(value.dtype)
                # An 8-bit float weight is stored divided by its scale (« fp8 scaled » files).
                if scale is not None:
                    weight = weight * scale.to(value.dtype)
                result = F.linear(value, weight, None if bias is None else bias.to(value.dtype))
            if self.adapters:
                down, up = pool.adapter(self.location, self.adapters, value.dtype)
                result = result + F.linear(F.linear(value, down), up if rows is None else up[rows])
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
