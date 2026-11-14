"""Weights kept where they are needed: what a model reads from its files, and what stays on the GPU.

Shared by every family (it was born with LTX 2.5). A `WeightPool` reads the weights of a model
from its files (RAM-resident stores, see runner.models.residency) and keeps a fixed share of
them on the GPU; `load_streamed` turns the linear layers of a model into layers that take their
weights from the pool each time they run, in the format the file stores them in (the note each
quantised layer carries, `.comfy_quant`): INT8 through comfy-kitchen's kernel, 8-bit floats
scaled back, plain weights as they are.
"""

import json
import math
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


# What every job was asked to find free before the floor followed the job (0.5.43 and before): a
# job is never asked for more than then, so none that ran is refused now.
FLOOR_GIB = 9


def require(label, working_gib, smaller):
    """Refuses, in the user's words, a job whose own tensors would not find their place in the
    video memory that is free now. The weights are not counted: a share of them stays on the card
    where there is room, the rest passes through, so a model in smaller files fits a smaller card.
    `working_gib` is what the pipeline itself sets aside beside them for this job (it grows with
    the picture), `smaller` what the user may reduce.
    """
    import torch

    free = torch.cuda.mem_get_info()[0] / GiB
    need = min(working_gib, FLOOR_GIB)
    if free < need:
        said = lambda value: f'{value:.1f}'.replace('.', ',')  # noqa: E731
        raise RuntimeError(
            f'{label} demande environ {said(need)} Go de mémoire vidéo libre pour cette création ; '
            f'{said(free)} Go sont libres. Fermez ce qui occupe la carte graphique, ou réduisez {smaller}.'
        )


RECENT = 384 * 1024**2
# A layer's scale and bias are this small at most: beside a weight sent to the GPU at every step
# they stay there (see WeightPool._hold).
SMALL = 64 * 1024


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
        # Each LoRA file's pairs for the layers of the model, read once (see lora_layers).
        self.lora_cache = {}
        # The keys of each store, listed once (see sized).
        self.listed = {}
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
        self.stream = self.loose = None
        # The stream the model computes on, asked for once: asking costs as much as a copy.
        self.current = None
        # Where the search for the next layers to send stopped (an index of `sequence`), while
        # what is on its way is exactly what follows the layer last asked for; else None.
        self.reach = None
        # Each layer's bytes as held in RAM, whether that RAM is page-locked, and its scale and
        # bias on the GPU (see _hold).
        self.sizes = {}
        self.locked = {}
        self.small = {}
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
        # Listed once: a store lists its keys anew each time it is asked (4 000 names for a video
        # model, asked twice per layer: seconds of the first step).
        listed = self.listed.get(source)
        if listed is None:
            listed = self.listed[source] = set(store.keys())
        values, keys = {'weight': self.read(location)}, [key]
        for suffix, label in (('.weight_scale', 'scale'), ('.bias', 'bias')):
            candidate = key.removesuffix('.weight') + suffix
            if candidate in listed:
                value = store.get_tensor(candidate)
                if part is not None and value.ndim:
                    value = value.chunk(3, dim=0)[part]
                values[label] = value
                keys.append(candidate)
        return values, keys

    def sized(self, location):
        """(bytes, file keys) of what a layer reads from its file, as `parts` gives it. From the
        header of the file when the store knows its sizes (`measure`): nothing is read."""
        source, key, part = location
        store = self.stores[source]
        measure = getattr(store, 'measure', None)
        if measure is None:
            values, names = self.parts(location)
            return sum(value.numel() * value.element_size() for value in values.values()), names
        listed = self.listed.get(source)
        if listed is None:
            listed = self.listed[source] = set(store.keys())
        size, names = measure(key)[0] // (3 if part is not None else 1), [key]
        for suffix in ('.weight_scale', '.bias'):
            candidate = key.removesuffix('.weight') + suffix
            if candidate in listed:
                held, dimensions = measure(candidate)
                size += held // 3 if part is not None and dimensions else held
                names.append(candidate)
        return size, names

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
        held, keys, cut = self.bytes + self._unmerged(), {}, False
        for location in self.order:
            if location in self.gpu:
                continue
            size, names = self.sized(location)
            if not (cut and onward) and held + size <= limit:
                held += size
            else:
                cut = True
                keys.setdefault(location[0], set()).update(names)
        return keys

    def _unmerged(self):
        """Bytes the LoRAs will take on the GPU once there (preload puts them first): their pairs
        as the files give them, in the bfloat16 they are kept in. Left out, the pool was counted
        to keep that much more of the model than it does (1.2 GiB for LTX 2.5's subject LoRA),
        and what it then copies at every step was not all in page-locked RAM."""
        total = 0
        for location, adapters in self.adapted.items():
            if location in self.merged:
                continue
            for source, down, up, _strength in adapters:
                store = self.stores[source]
                for key in (down, up):
                    # The shape alone where the store gives it without reading the tensor.
                    shape = store.get_slice(key).get_shape() if hasattr(store, 'get_slice') else None
                    total += 2 * (math.prod(shape) if shape is not None else store.get_tensor(key).numel())
        return total

    def bundle(self, location):
        if location in self.gpu:
            return self.gpu[location]
        if location in self.recent:
            return self.recent[location][0]
        if location in self.ahead:
            # Copied in advance: the GPU waits for that copy only, if it is not done yet.
            if next(iter(self.ahead)) != location:
                self.reach = None  # layers sent before it were not asked for: see _send_ahead
            result, done, size = self.ahead.pop(location)
            self.ahead_bytes -= size
            self.current.wait_event(done)
            self.stats['again_gib'] += size / GiB
            self.stats['ahead_gib'] += size / GiB
        else:
            started = time.perf_counter()
            self.reach = None
            first = location not in self.host
            if first:
                self._hold(location)
            result = {key: value.to('cuda', non_blocking=True) for key, value in self.host[location].items()}
            result.update(self.small.get(location, ()))
            size = self.sizes[location]
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
        if getattr(self.stores[location[0]], 'reader', None) is not None:
            # Read from the disk into a buffer of its own (Store.follow), not a view of the file:
            # kept for a second use, the whole file would end up in RAM.
            self.host.pop(location, None)
        if self.ahead_limit and self.known:
            self._send_ahead(location)
        return result

    def _hold(self, location):
        """Take a layer's tensors from its file, for the copies to the GPU.

        In a pool that sends its layers ahead, the scale and the bias go to the GPU once and stay:
        a few kilobytes beside megabytes of weight, they were two of the three copies of every
        layer at every step, as costly to launch as the weight's (measured on LTX 2.5: 4 400 copies
        a step, a third of the time the processor took to launch it)."""
        values = self.parts(location)[0]
        self.sizes[location] = sum(value.numel() * value.element_size() for value in values.values())
        if self.ahead_limit:
            small = self.small.get(location)
            if small is None:
                small = self.small[location] = {
                    key: value.to('cuda')
                    for key, value in values.items()
                    if key != 'weight' and value.numel() * value.element_size() <= SMALL
                }
            values = {key: value for key, value in values.items() if key not in small}
            self.locked[location] = all(value.is_pinned() for value in values.values())
        self.host[location] = values

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
        `ahead_limit` bytes are on their way.

        What is on its way is normally what follows the layer asked for, in order: only the
        layers past the last one sent are then looked at (`reach`). Walking the whole window at
        every layer took the processor longer than launching the layer's kernels."""
        count = len(self.sequence)
        index = self.place.get(location)
        if index is None:
            return
        if self.reach is None:
            return self._send_window(index, count)
        position = self.reach
        while position != index:
            following = self.sequence[position]
            if following in self.recent:
                # A sequence short enough to come round to what was just used: looked at whole.
                return self._send_window(index, count)
            host = self.host.get(following)
            if host is not None and following not in self.gpu:
                size = self.sizes[following]
                if self.ahead and self.ahead_bytes + size > self.ahead_limit:
                    break
                self._send(following, host, size)
            position = (position + 1) % count
        self.reach = position

    def _send_window(self, index, count):
        """The same from nothing: every layer that follows is looked at, and what was sent
        ahead and is no longer next (a layer some steps skip) goes away."""
        location = self.sequence[index]
        upcoming, budget, stopped, plain = [], 0, None, True
        for offset in range(1, count):
            position = (index + offset) % count
            following = self.sequence[position]
            if following == location:
                break
            if following in self.recent:
                plain = False
                continue
            if following in self.gpu:
                continue
            host = self.host.get(following)
            if host is None:
                continue
            size = self.sizes[following]
            if upcoming and budget + size > self.ahead_limit:
                stopped = position
                break
            upcoming.append((following, host, size))
            budget += size
        wanted = {following for following, _, _ in upcoming}
        for stale in [item for item in self.ahead if item not in wanted]:
            _result, done, size = self.ahead.pop(stale)
            # Its memory goes back to the model's stream: nothing there may be given it while
            # the copy is still to come.
            self.current.wait_event(done)
            self.ahead_bytes -= size
        for following, host, size in upcoming:
            if following in self.ahead:
                # Asked for again in the order of the window, after the ones sent now.
                self.ahead[following] = self.ahead.pop(following)
            else:
                self._send(following, host, size)
        # Resumed from where it stopped only when it stopped on a layer that did not fit, and
        # passed none that had just been used.
        self.reach = stopped if plain else None

    def _send(self, following, host, size):
        """Launch the copy of one layer on the pool's stream.

        The memory it is copied to is taken on the model's stream, like any tensor of the model,
        and only the copy runs on the pool's: it waits there for the model to have run all it
        was asked so far (`passed`), whatever held that memory before included; the layer in turn
        waits for the copy (bundle). Taken on the pool's stream, that memory was PyTorch's to move
        from one stream's reserve to the other's several times a step, the model's thread
        stopped each time (measured on LTX 2.5: 65 to 165 ms, one to four times a step).

        A weight that is not in page-locked RAM (what a model streams beyond the share of RAM
        that may be locked: 2 GiB of MiniMax H3's on 32 GiB) is copied as before, on memory of
        a stream of their own (`loose`): that copy holds the thread until it is done, and behind
        the others it held it until the model had caught up as well."""
        torch = self.torch
        if self.stream is None:
            self.stream, self.loose = torch.cuda.Stream(), torch.cuda.Stream()
        if self.current is None:
            self.current = torch.cuda.current_stream()
        locked = self.locked.get(following, False)
        if locked:
            copied = [torch.empty_like(value, device=self.device) for value in host.values()]
            passed = torch.cuda.Event()
            passed.record(self.current)
        stream = self.stream if locked else self.loose
        torch.cuda.set_stream(stream)
        try:
            if locked:
                stream.wait_event(passed)
                for target, value in zip(copied, host.values()):
                    target.copy_(value, non_blocking=True)
            else:
                copied = [value.to(self.device, non_blocking=True) for value in host.values()]
            done = torch.cuda.Event()
            done.record(stream)
        finally:
            torch.cuda.set_stream(self.current)
        if not locked:
            # Memory of the pool's stream, used on the model's: given back once that one is done.
            for value in copied:
                value.record_stream(self.current)
        result = dict(zip(host, copied))
        result.update(self.small.get(following, ()))
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
            for source, down, up, strength in adapters:
                store = self.stores[source]
                downs.append(store.get_tensor(down).to(self.device, dtype=dtype))
                ups.append(store.get_tensor(up).to(self.device, dtype=dtype) * strength)
            found = (torch.cat(downs, dim=0), torch.cat(ups, dim=1))
            size = sum(value.numel() * value.element_size() for value in found)
            self.merged[location] = found
            self.merged_bytes += size
            self.bytes += size
        return found

    def lora_layers(self, source):
        """{layer: (down, up, alpha)} of one LoRA file for the layers of the model, whatever the
        tool that named its tensors (runner.models.lora_keys); read once."""
        found = self.lora_cache.get(source)
        if found is None:
            from runner.models.lora_keys import lora_pairs

            targets = {key.removeprefix('model.diffusion_model.') for key in self.stores['model'].keys()}
            found = self.lora_cache[source] = lora_pairs(self.stores[source].keys(), targets)[0]
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
        self.reach = None
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
        self.small.clear()
        self.sizes.clear()
        self.locked.clear()
        self.merged.clear()
        self.reach = None
        self.bytes = self.recent_bytes = self.merged_bytes = self.ahead_bytes = 0


def load_streamed(model, names, pool):
    import torch
    import torch.nn.functional as F
    from accelerate.utils import set_module_tensor_to_device

    names_of = {}

    def listed(source):
        # A store lists its keys anew each time it is asked: asked by every layer for its
        # quantisation note, that was 2.7 of the 3.4 s a 1 650-layer video model took to build.
        found = names_of.get(source)
        if found is None:
            found = names_of[source] = set(pool.stores[source].keys())
        return found

    class Linear(torch.nn.Module):
        def __init__(self, location):
            super().__init__()
            self.location = location
            pool.order.append(location)
            self.out_features, self.in_features = pool.read(location).shape
            store = pool.stores[location[0]]
            key = location[1].removesuffix('.weight') + '.comfy_quant'
            quant = json.loads(store.get_tensor(key).numpy().tobytes()) if key in listed(location[0]) else {}
            self.rotation = quant.get('convrot_groupsize', 256) if quant.get('convrot') else 0
            if self.rotation and self.in_features % self.rotation:
                raise ValueError('Invalid ConvRot group size')
            self.adapters = []
            if location[0] == 'model':
                stem = location[1].removesuffix('.weight').removeprefix('model.diffusion_model.')
                for source, strength in pool.adapters:
                    found = pool.lora_layers(source).get(stem + '.weight')
                    if found:
                        down, up, alpha = found
                        store = pool.stores[source]
                        # The pair is scaled by alpha / rank when the file gives an alpha.
                        scale = store.get_tensor(alpha).item() / store.get_slice(down).get_shape()[0] if alpha else 1
                        self.adapters.append((source, down, up, strength * scale))

            if self.adapters:
                pool.adapted[self.location] = self.adapters

        def forward(self, value, act=None, residual=None, gate=None):
            """`act` names an activation applied to the rows on the way in: 'swiglu' takes
            [gate | up] rows and computes silu(gate) * up, 'gelu_tanh' the GELU of a feed-forward.
            With `residual` and `gate` (one value per output channel) the result is
            residual + gate * linear(rows), the end of a transformer branch.

            Both go into comfy-kitchen's INT8 kernel when the weight is INT8: a feed-forward's
            wide intermediate is never written out, nor the branch before its sum. Any other
            weight computes the same in separate steps.

            The layer's LoRAs read the activated rows and add up(down(rows)) to the result, in
            the product itself (addmm_), scaled by the gate when the branch is summed in the
            kernel: written out and added afterwards, that term was a pass over the layer's
            whole output for each LoRA layer (LTX 2.5 with its subject LoRA, ten layers a block:
            1.2 s a step where the same video takes 0.7 without)."""
            bundle = pool.bundle(self.location)
            weight, scale, bias = bundle['weight'], bundle.get('scale'), bundle.get('bias')
            quantized = weight.dtype == torch.int8
            rows = value
            if act is not None and (self.adapters or not quantized):
                if act == 'swiglu':
                    first, up = value.chunk(2, dim=-1)
                    rows = F.silu(first) * up
                elif act == 'gelu_tanh':
                    rows = F.gelu(value, approximate='tanh')
                else:
                    raise ValueError('Unknown activation ' + act)
                if not quantized:
                    value, act = rows, None
            summed = quantized and residual is not None
            if quantized and (act is not None or residual is not None):
                result = pool.kernels.int8_linear(
                    value,
                    weight,
                    scale,
                    bias,
                    value.dtype,
                    bool(self.rotation),
                    self.rotation or 256,
                    input_act=act,
                    residual=residual,
                    residual_scale=gate,
                )
            elif quantized:
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
                down, up = pool.adapter(self.location, self.adapters, rows.dtype)
                if summed:
                    up = up * gate.to(up.dtype)[:, None]
                low = F.linear(rows, down)
                result.reshape(-1, result.shape[-1]).addmm_(low.reshape(-1, low.shape[-1]), up.t())
            if residual is not None and not summed:
                result = torch.addcmul(residual, result, gate)
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
