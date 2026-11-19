/**
 * (0.6.115) What a file of a model is, read in its header and nowhere else: the format of its
 * weights (INT8, FP8, BF16, a GGUF and its blocks). The page « Modèles » shows a version by what
 * its file says, never by its name: a file found in the folder of the models, or added by the user,
 * is one nobody described beforehand.
 *
 * Two containers are read. A safetensors file says the type of each tensor; where its weights are
 * quantised, a note beside each (`.comfy_quant`, a few bytes of JSON) says how, and the engine
 * reads that same note (runner/models/pool.py). The type alone is not enough: on the user's disk
 * (19/11) a file of 8-bit integers held weights of 4 bits (« asym_w4a8_int8 »), and an encoder of
 * plain bytes held NVFP4 ones. A GGUF file says the type of the blocks of each tensor; the engine
 * computes with none of them and unfolds those it knows to write the file again in its own format
 * (runner/models/gguf.py, runner/convert.py).
 *
 * Whether a model takes a format is not said here: each family reads its files with its own code
 * (the text encoder of MiniMax H3 reads NVFP4, which no other does).
 */
import { open } from 'node:fs/promises';

/** The types of a GGUF tensor the engine unfolds, by their number in the file (runner/models/gguf.py, TYPES). */
export const GGUF_READ = Object.freeze({
  0: 'F32',
  1: 'F16',
  30: 'BF16',
  2: 'Q4_0',
  3: 'Q4_1',
  6: 'Q5_0',
  7: 'Q5_1',
  8: 'Q8_0',
  12: 'Q4_K',
  13: 'Q5_K',
  14: 'Q6_K',
});
/** Those that exist and that it does not (its UNREAD): named in a refusal. */
export const GGUF_UNREAD = Object.freeze({
  9: 'Q8_1',
  10: 'Q2_K',
  11: 'Q3_K',
  15: 'Q8_K',
  16: 'IQ2_XXS',
  17: 'IQ2_XS',
  18: 'IQ3_XXS',
  19: 'IQ1_S',
  20: 'IQ4_NL',
  21: 'IQ3_S',
  22: 'IQ2_S',
  23: 'IQ4_XS',
  29: 'IQ1_M',
  34: 'TQ1_0',
  35: 'TQ2_0',
});
// The values a block holds and the bytes it takes, for the share each type has of a file.
const GGUF_BLOCKS = {
  F32: [1, 4],
  F16: [1, 2],
  BF16: [1, 2],
  Q4_0: [32, 18],
  Q4_1: [32, 20],
  Q5_0: [32, 22],
  Q5_1: [32, 24],
  Q8_0: [32, 34],
  Q4_K: [256, 144],
  Q5_K: [256, 176],
  Q6_K: [256, 210],
};
// What the page calls the type of a safetensors tensor, and the way a note says its weights are
// quantised (`format`); a way not listed here is shown as the note writes it.
const PLAIN = { I8: 'INT8', F8_E4M3: 'FP8', F8_E5M2: 'FP8', BF16: 'BF16', F16: 'FP16', F32: 'FP32' };
const NOTED = {
  int8_tensorwise: 'INT8',
  float8_e4m3fn: 'FP8',
  float8_e5m2: 'FP8',
  asym_w4a8_int8: 'W4A8',
  nvfp4: 'NVFP4',
};
const LONGEST_HEADER = 256 * 1024 * 1024;

const invalid = message => Object.assign(new Error(message), { status: 400 });

/** The header of a safetensors file: its tensors by name, and where their bytes start in the file. */
async function safetensors(file) {
  const prefix = Buffer.alloc(8);
  await file.read(prefix, 0, 8, 0);
  const length = prefix.readBigUInt64LE();
  if (length < 2n || length > BigInt(LONGEST_HEADER)) throw invalid('Invalid safetensors header size');
  const bytes = Buffer.alloc(Number(length)),
    { bytesRead } = await file.read(bytes, 0, bytes.length, 8);
  if (bytesRead !== bytes.length) throw invalid('Incomplete safetensors header');
  let header;
  try {
    header = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw invalid('Invalid safetensors header JSON');
  }
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw invalid('Invalid safetensors header');
  const tensors = {};
  for (const [name, tensor] of Object.entries(header)) {
    if (name === '__metadata__') continue;
    const [from, to] = tensor?.data_offsets ?? [];
    if (typeof tensor?.dtype !== 'string' || !Array.isArray(tensor.shape) || !(to >= from))
      throw invalid(`Invalid safetensors header tensor: ${name}`);
    tensors[name] = { dtype: tensor.dtype, shape: tensor.shape, bytes: to - from, at: 8 + bytes.length + from };
  }
  return tensors;
}

/** The header of a GGUF file: its tensors by name, each with the type of its blocks. */
async function gguf(file) {
  // Read from the start of the file, more of it each time the header runs past what was read.
  for (let size = 4 * 1024 * 1024; size <= LONGEST_HEADER; size *= 4) {
    const buffer = Buffer.alloc(size),
      { bytesRead } = await file.read(buffer, 0, size, 0),
      whole = bytesRead < size;
    try {
      return ggufTensors(buffer.subarray(0, bytesRead));
    } catch (error) {
      // Past the end of what was read: the rest of the file is read, unless this was all of it.
      if (!(error instanceof RangeError)) throw error;
      if (whole) throw invalid('Incomplete GGUF header');
    }
  }
  throw invalid('GGUF header too long');
}
function ggufTensors(buffer) {
  let cursor = 4;
  const advance = bytes => {
    if (cursor + bytes > buffer.length) throw new RangeError();
    cursor += bytes;
    return cursor - bytes;
  };
  const u32 = () => buffer.readUInt32LE(advance(4)),
    u64 = () => {
      const value = buffer.readBigUInt64LE(advance(8));
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid('Invalid GGUF header');
      return Number(value);
    },
    text = () => {
      const length = u64();
      if (length > 1 << 24) throw invalid('Invalid GGUF text length');
      return buffer.toString('utf8', advance(length), cursor);
    };
  const widths = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
  const skip = (kind, depth = 0) => {
    if (widths[kind]) return void advance(widths[kind]);
    if (kind === 8) return void text();
    if (kind !== 9 || depth > 3) throw invalid(`Unknown GGUF metadata type ${kind}`);
    const inner = u32(),
      count = u64();
    if (widths[inner]) advance(widths[inner] * count);
    else for (let index = 0; index < count; index++) skip(inner, depth + 1);
  };
  const version = u32(),
    count = u64(),
    pairs = u64();
  if (![2, 3].includes(version) || count > 1 << 20 || pairs > 1 << 20)
    throw invalid(`Unsupported GGUF version ${version}`);
  for (let index = 0; index < pairs; index++) {
    text();
    skip(u32());
  }
  const tensors = {};
  for (let index = 0; index < count; index++) {
    const name = text(),
      dimensions = u32();
    if (dimensions > 8) throw invalid('Invalid GGUF tensor: ' + name);
    const shape = [];
    for (let side = 0; side < dimensions; side++) shape.unshift(u64());
    const kind = u32();
    advance(8);
    const dtype = GGUF_READ[kind] ?? GGUF_UNREAD[kind] ?? `type ${kind}`,
      values = shape.reduce((product, side) => product * side, 1),
      block = GGUF_BLOCKS[dtype];
    tensors[name] = { dtype, shape, bytes: block ? Math.ceil(values / block[0]) * block[1] : values };
  }
  return tensors;
}

/** The bytes each type holds in a file, the largest share first: [[type, bytes], …]. */
function shares(tensors, skipped = () => false) {
  const held = new Map();
  for (const [name, tensor] of Object.entries(tensors))
    if (!skipped(name)) held.set(tensor.dtype, (held.get(tensor.dtype) ?? 0) + tensor.bytes);
  return [...held].sort((a, b) => b[1] - a[1]);
}

/**
 * What the file at `path` is: { container, format, kinds, tensors }, and
 *  - for a safetensors file, `scheme`: the way its weights are quantised as their note says it
 *    (« int8_tensorwise », « float8_e4m3fn », « asym_w4a8_int8 »…), '' when they carry no note, and
 *    `rotated`: whether that note says ConvRot;
 *  - for a GGUF file, `unread`: the types of blocks the engine does not unfold ([] when it can
 *    write the whole file again in its own format).
 * `format` is what the page shows (« INT8 », « FP8 », « BF16 », « W4A8 », « GGUF Q8 »): what most of
 * the bytes of the file are, by the note of its weights when they have one, else by their type.
 * `kinds`: the bytes of each type, the largest first.
 * A file that is neither container, or whose header cannot be read, is refused by an error.
 */
export async function describeModelFile(path) {
  const file = await open(path, 'r');
  try {
    const magic = Buffer.alloc(4);
    await file.read(magic, 0, 4, 0);
    if (magic.toString('latin1') === 'GGUF') {
      const tensors = await gguf(file),
        kinds = shares(tensors),
        // The blocks most of the file is in (« Q8 », « Q4 »); a file of plain floats says its floats.
        main = kinds[0]?.[0] ?? '';
      return {
        container: 'gguf',
        format: ('GGUF ' + main.replace(/_[0K]$/, '')).trim(),
        kinds,
        tensors: Object.keys(tensors).length,
        unread: kinds.map(([kind]) => kind).filter(kind => !Object.values(GGUF_READ).includes(kind)),
      };
    }
    const tensors = await safetensors(file);
    if (!Object.keys(tensors).length) throw invalid('Safetensors header contains no tensors');
    // The note of a quantised weight is no weight.
    const kinds = shares(tensors, name => name.endsWith('.comfy_quant')),
      main = kinds[0]?.[0] ?? '',
      // How the weights are quantised: the note of the largest weight of the type most bytes are in
      // (a file of 4-bit weights keeps a few layers of plain 8-bit ones, with a note of their own).
      noted = Object.keys(tensors)
        .filter(name => name.endsWith('.weight') && tensors[name].dtype === main && tensors[noteName(name)])
        .sort((a, b) => tensors[b].bytes - tensors[a].bytes)[0],
      note = noted ? await noteOf(file, tensors[noteName(noted)]) : null,
      scheme = typeof note?.format === 'string' ? note.format.slice(0, 64) : '';
    return {
      container: 'safetensors',
      format: scheme ? (NOTED[scheme] ?? scheme.toUpperCase()) : (PLAIN[main] ?? main),
      scheme,
      rotated: note?.convrot === true,
      kinds,
      tensors: Object.keys(tensors).length,
    };
  } finally {
    await file.close();
  }
}
const noteName = weight => weight.slice(0, -'weight'.length) + 'comfy_quant';
/** The note of a quantised weight (what its JSON says), or null when it is not one. */
async function noteOf(file, tensor) {
  if (tensor.bytes < 2 || tensor.bytes > 65536) return null;
  const bytes = Buffer.alloc(tensor.bytes);
  await file.read(bytes, 0, bytes.length, tensor.at);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
}
