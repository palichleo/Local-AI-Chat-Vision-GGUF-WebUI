"""A model's file written again as INT8 ConvRot, the format this engine computes fastest with.

    python -s -m runner.convert SOURCE TARGET.safetensors

On an RTX 4070 SUPER a linear layer of LTX 2.5 computes three times faster from INT8 weights
(comfy-kitchen's kernel: a product of 8-bit integers) than from weights that are turned back
into 16-bit floats first, whatever they were stored as: 0.8 ms against 2.5 ms for a 4096 x 4096
layer, and a whole step of LTX 2.5 in 1.25 s from the official INT8 file against 2.74 s from an
« fp8 scaled » one (19 November 2026, runner/MEMORY-STUDY.md). The conversion itself costs
nothing at each step: it is the product that differs.

SOURCE is a safetensors file (8-bit floats, « fp8 scaled » or not) or a GGUF file (Q8_0, Q4_K...
see runner.models.gguf). What is rewritten is what the source itself stores quantised: its
matrices whose rows are a multiple of 256 wide. Each is turned back into plain weights, rotated
(ConvRot: each group of 256 columns through a Hadamard rotation, which spreads the large weights
of a row before they are rounded; the kernel rotates what the layer reads the same way), rounded
to 8-bit integers with one scale a row, and written with the note the engine reads beside an
INT8 layer (`.comfy_quant`). Everything else is copied as it is; a quantised tensor of a GGUF
file that is not such a matrix is written as 16-bit floats.

The result has the layout of the INT8 files published for these models, and is read by the same
code. It is not their equal in fidelity: it is rounded twice, once by its source and once here.
"""

import json
import math
import os
import struct
import sys
import time

GROUP = 256
NOTE = json.dumps({'format': 'int8_tensorwise', 'convrot': True, 'convrot_groupsize': GROUP}).encode()
# 8-bit floats of a safetensors file, and the scale some files store beside them under two names.
FLOAT8 = ('F8_E4M3', 'F8_E5M2')
SCALES = ('.weight_scale', '.scale_weight')
PLAIN = ('F32', 'F16', 'BF16')


def hadamard(size, device=None):
    """The rotation of a group: ConvRot's regular Hadamard matrix (the Kronecker powers of the
    4 x 4 one whose rows each hold a single -1), scaled to keep lengths. It is symmetric and its
    own inverse. The kernel rotates what a layer reads with the same matrix (checked against
    comfy-kitchen's own rotation in the tests): another Hadamard matrix gives noise."""
    import torch

    block = torch.tensor(
        [[1, 1, 1, -1], [1, 1, -1, 1], [1, -1, 1, 1], [-1, 1, 1, 1]], dtype=torch.float32, device=device
    )
    matrix = block
    while matrix.shape[0] < size:
        matrix = torch.kron(matrix, block)
    if matrix.shape[0] != size:
        raise ValueError('A ConvRot group is a power of four wide')
    return matrix / math.sqrt(size)


def rotate(weight, group=GROUP):
    """A matrix with each group of `group` columns rotated. Applied twice, it gives the matrix back."""
    rows, columns = weight.shape
    if columns % group:
        raise ValueError('The rows of a ConvRot matrix are a multiple of its group wide')
    return (weight.reshape(rows, columns // group, group) @ hadamard(group, weight.device)).reshape(rows, columns)


def quantise(weight):
    """A matrix as 8-bit integers and one scale a row: the largest weight of a row is 127."""
    import torch

    scale = (weight.abs().amax(dim=1, keepdim=True) / 127).clamp_min(1e-12)
    return (weight / scale).round().clamp(-127, 127).to(torch.int8), scale.to(torch.float32)


def _safetensors_header(path):
    with open(path, 'rb') as handle:
        (length,) = struct.unpack('<Q', handle.read(8))
        header = json.loads(handle.read(length))
    metadata = header.pop('__metadata__', None) or {}
    return header, {key: value for key, value in metadata.items() if isinstance(value, str)}


class _Safetensors:
    """A safetensors source: its 8-bit float matrices are what is quantised."""

    def __init__(self, path):
        from safetensors import safe_open

        self.tensors, self.metadata = _safetensors_header(path)
        self.store = safe_open(path, framework='pt')
        # Each scale stored beside a matrix, by the matrix: it is not written again as it is.
        self.scales = {}
        for key in self.tensors:
            for suffix in SCALES:
                weight = key.removesuffix(suffix) + '.weight'
                if key.endswith(suffix) and self.tensors.get(weight, {}).get('dtype') in FLOAT8:
                    self.scales[weight] = key
        self.metadata.pop('_quantization_metadata', None)

    def names(self):
        return sorted(self.tensors, key=lambda key: self.tensors[key]['data_offsets'][0])

    def quantised(self, key):
        return self.tensors[key]['dtype'] in FLOAT8

    def plain(self, key, device):
        import torch

        weight = self.store.get_tensor(key).to(device).to(torch.float32)
        scale = self.scales.get(key)
        return weight * self.store.get_tensor(scale).to(device, torch.float32) if scale else weight

    def copied(self, key):
        """A tensor that is not rewritten: its type, and its bytes as the file stores them."""
        import torch

        entry = self.tensors[key]
        value = self.store.get_tensor(key).contiguous()
        return entry['dtype'], value.reshape(-1).view(torch.uint8).numpy().tobytes()

    def close(self):
        self.store.__exit__(None, None, None)


class _Gguf:
    """A GGUF source: its tensors stored in blocks are what is quantised."""

    scales = {}

    def __init__(self, path):
        from runner.models import gguf

        self.reader = gguf.Reader(path)
        self.tensors = self.reader.tensors
        kinds = gguf.unread(self.tensors)
        if kinds:
            self.reader.close()
            raise ValueError(gguf.refusal(kinds))
        self.metadata = {
            key: str(value) for key, value in self.reader.metadata.items() if isinstance(value, (str, int, float))
        }

    def names(self):
        return sorted(self.tensors, key=lambda key: self.tensors[key]['data_offsets'][0])

    def quantised(self, key):
        return self.tensors[key]['dtype'] not in PLAIN

    def plain(self, key, device):
        return self.reader.get_tensor(key, device)

    def copied(self, key):
        return self.tensors[key]['dtype'], self.reader.raw(key).numpy().tobytes()

    def close(self):
        self.reader.close()


def convert(source_path, target_path, device=None, report=print):
    """Writes `target_path` from `source_path`; returns what was done, in numbers."""
    import torch

    from runner.models import gguf

    if os.path.exists(target_path):
        raise ValueError('Le fichier de destination existe déjà : ' + target_path)
    device = device or ('cuda' if torch.cuda.is_available() else 'cpu')
    source = _Gguf(source_path) if gguf.is_gguf(source_path) else _Safetensors(source_path)
    try:
        # What each tensor becomes: an INT8 ConvRot layer (three tensors), 16-bit floats (a
        # quantised tensor that is no such matrix), or itself.
        plan, offset, layers = [], 0, 0

        def matrix(key):
            shape = source.tensors[key]['shape']
            return source.quantised(key) and key.endswith('.weight') and len(shape) == 2 and shape[1] % GROUP == 0

        # The scale a source stores beside a matrix that is rewritten goes into the new integers:
        # it is not written again. Beside a matrix left as it is, it stays.
        folded = {source.scales[key] for key in source.names() if matrix(key) and key in source.scales}
        for key in source.names():
            if key in folded:
                continue
            entry = source.tensors[key]
            shape = entry['shape']
            count = math.prod(shape)
            if matrix(key):
                stem = key.removesuffix('.weight')
                how = 'layer'
                parts = (
                    (key, 'I8', shape, count),
                    (stem + '.weight_scale', 'F32', [shape[0], 1], shape[0] * 4),
                    (stem + '.comfy_quant', 'U8', [len(NOTE)], len(NOTE)),
                )
                layers += 1
            elif source.quantised(key) and isinstance(source, _Gguf):
                # Blocks have no place in a safetensors file: plain 16-bit floats.
                how, parts = 'plain', ((key, 'BF16', shape, count * 2),)
            else:
                how = 'copy'
                parts = ((key, entry['dtype'], shape, entry['data_offsets'][1] - entry['data_offsets'][0]),)
            for name, dtype, part_shape, size in parts:
                plan.append((name, dtype, part_shape, offset, size, key, how))
                offset += size
        if not layers:
            raise ValueError('Ce fichier ne contient aucune couche quantifiée à convertir.')
        metadata = dict(source.metadata, converted_from=os.path.basename(source_path), converted_to='int8 convrot 256')
        header = {'__metadata__': metadata}
        for name, dtype, shape, start, size, _, _ in plan:
            if name in header:
                raise ValueError('Tensor written twice: ' + name)
            header[name] = dict(dtype=dtype, shape=list(shape), data_offsets=[start, start + size])
        encoded = json.dumps(header, separators=(',', ':')).encode('utf-8')
        encoded += b' ' * (-len(encoded) % 8)
        report(f'{layers} couches à convertir, {len(plan)} tenseurs, {offset / 1024**3:.2f} Gio à écrire')
        began, done, worst = time.perf_counter(), 0, 0.0
        partial = target_path + '.part'
        try:
            with open(partial, 'wb', buffering=64 * 1024**2) as out:
                out.write(struct.pack('<Q', len(encoded)))
                out.write(encoded)
                index = 0
                while index < len(plan):
                    name, _, _, _, size, key, how = plan[index]
                    if how == 'layer':
                        weight = source.plain(key, device)
                        integers, scale = quantise(rotate(weight))
                        # What the rounding cost this layer, the rotation undone: said at the end.
                        back = rotate(integers.to(torch.float32) * scale)
                        worst = max(worst, float((back - weight).norm() / weight.norm().clamp_min(1e-12)))
                        out.write(integers.cpu().numpy().tobytes())
                        out.write(scale.cpu().numpy().tobytes())
                        out.write(NOTE)
                        index += 3
                        done += 1
                        if done % 200 == 0:
                            report(f'{done}/{layers} couches, {time.perf_counter() - began:.0f} s')
                        continue
                    if how == 'plain':
                        data = source.plain(key, device).to(torch.bfloat16).cpu().contiguous()
                        data = data.reshape(-1).view(torch.uint8).numpy().tobytes()
                    else:
                        _, data = source.copied(key)
                    if len(data) != size:
                        raise ValueError('Unexpected size of ' + name)
                    out.write(data)
                    index += 1
            os.replace(partial, target_path)
        finally:
            if os.path.exists(partial):
                os.remove(partial)
    finally:
        source.close()
    result = dict(layers=layers, tensors=len(plan), gib=round(offset / 1024**3, 2), worst_error=round(worst, 4))
    result['seconds'] = round(time.perf_counter() - began, 1)
    report(
        f'{layers} couches converties en {result["seconds"]:.0f} s ; '
        f'écart le plus grand entre une couche et sa source : {worst * 100:.1f} %'
    )
    return result


def main(arguments=None):
    arguments = sys.argv[1:] if arguments is None else arguments
    if len(arguments) != 2:
        raise SystemExit('usage: python -s -m runner.convert SOURCE TARGET.safetensors')
    try:
        convert(*arguments)
    except ValueError as error:
        raise SystemExit(str(error)) from None


if __name__ == '__main__':
    main()
