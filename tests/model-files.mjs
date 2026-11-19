import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GGUF_READ, GGUF_UNREAD, describeModelFile } from '../lib/model-files.mjs';

/** A safetensors file: `tensors` as [name, type, shape, bytes or their number]. */
function safetensors(tensors, { metadata, header: given } = {}) {
  const header = {},
    parts = [];
  let at = 0;
  for (const [name, dtype, shape, data] of tensors) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.alloc(data);
    header[name] = { dtype, shape, data_offsets: [at, at + bytes.length] };
    at += bytes.length;
    parts.push(bytes);
  }
  if (metadata) header.__metadata__ = metadata;
  const json = Buffer.from(typeof given === 'string' ? given : JSON.stringify(given ?? header)),
    prefix = Buffer.alloc(8);
  prefix.writeBigUInt64LE(BigInt(json.length));
  return Buffer.concat([prefix, json, ...parts]);
}
const note = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
const u32 = value => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};
const u64 = value => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
};
const text = value => Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value)]);
/** A GGUF header: `pairs` as [key, type, bytes of the value], `tensors` as [name, sizes, type]. */
const gguf = ({ version = 3, pairs = [], tensors = [] }) =>
  Buffer.concat([
    Buffer.from('GGUF'),
    u32(version),
    u64(tensors.length),
    u64(pairs.length),
    ...pairs.map(([key, kind, value]) => Buffer.concat([text(key), u32(kind), value])),
    ...tensors.map(([name, sizes, kind]) => Buffer.concat([text(name), u32(sizes.length), ...sizes.map(u64), u32(kind), u64(0)])),
  ]);

async function folder(t) {
  const directory = await mkdtemp(join(tmpdir(), 'moodix-model-files-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let count = 0;
  return async bytes => {
    const path = join(directory, `file-${count++}.bin`);
    await writeFile(path, bytes);
    return describeModelFile(path);
  };
}

test('a safetensors file says its format by what most of its bytes are (0.6.115)', async t => {
  const read = await folder(t);
  // The file Moodix ships most: 8-bit integers with ConvRot, a few plain layers beside them.
  assert.deepEqual(
    await read(
      safetensors(
        [
          ['blocks.0.fc1.weight', 'I8', [40, 25], 1000],
          ['blocks.0.fc1.comfy_quant', 'U8', [61], note({ format: 'int8_tensorwise', convrot: true, convrot_groupsize: 256 })],
          ['blocks.0.fc1.weight_scale', 'BF16', [40], 80],
          ['blocks.0.norm.weight', 'BF16', [10], 20],
        ],
        { metadata: { format: 'pt' } },
      ),
    ),
    {
      container: 'safetensors',
      format: 'INT8',
      scheme: 'int8_tensorwise',
      rotated: true,
      // (Neither the note nor what the file says of itself is a weight.)
      kinds: [
        ['I8', 1000],
        ['BF16', 100],
      ],
      tensors: 4,
    },
  );
  // Plain weights: their type, and no way of quantising to name.
  for (const [dtype, format] of [
    ['F8_E4M3', 'FP8'],
    ['F8_E5M2', 'FP8'],
    ['BF16', 'BF16'],
    ['F16', 'FP16'],
    ['F32', 'FP32'],
    ['I8', 'INT8'],
    // A type the page has no name for is shown as the file writes it.
    ['I64', 'I64'],
  ]) {
    const said = await read(safetensors([['layer.weight', dtype, [4, 4], 64], ['layer.bias', dtype === 'F32' ? 'BF16' : 'F32', [4], 16]]));
    assert.deepEqual([said.format, said.scheme, said.rotated, said.kinds[0]], [format, '', false, [dtype, 64]], dtype);
  }
  // The largest share decides, whatever comes first in the file.
  const mixed = await read(safetensors([['a.weight', 'BF16', [4], 100], ['b.weight', 'F8_E4M3', [4], 300], ['c.weight', 'BF16', [4], 150]]));
  assert.deepEqual([mixed.format, mixed.kinds], ['FP8', [['F8_E4M3', 300], ['BF16', 250]]]);
});

test('the note of the weights says how they are quantised, where their type alone would lie', async t => {
  const read = await folder(t);
  const noted = (dtype, bytes, format, name) => [
    [`${name}.weight`, dtype, [4, 4], bytes],
    [`${name}.comfy_quant`, 'U8', [8], note(format)],
  ];
  // 19/11, on the user's disk: 4-bit weights kept in 8-bit integers, a few plain 8-bit layers beside
  // (one of them first in the file: the note read is that of the largest weight).
  const four = await read(
    safetensors([...noted('I8', 300, { format: 'int8_tensorwise', convrot: true }, 'head'), ...noted('I8', 900, { format: 'asym_w4a8_int8' }, 'blocks.0')]),
  );
  assert.deepEqual([four.format, four.scheme, four.rotated], ['W4A8', 'asym_w4a8_int8', false]);
  // And an encoder of NVFP4 weights kept in plain bytes, whose largest single layer is an 8-bit one:
  // the note is that of the type most bytes are in.
  const nvfp4 = await read(
    safetensors([
      ...noted('U8', 400, { format: 'nvfp4' }, 'layers.0'),
      ...noted('U8', 400, { format: 'nvfp4' }, 'layers.1'),
      ...noted('I8', 500, { format: 'int8_tensorwise' }, 'embed'),
    ]),
  );
  assert.deepEqual([nvfp4.format, nvfp4.scheme, nvfp4.kinds[0]], ['NVFP4', 'nvfp4', ['U8', 800]]);
  // 8-bit floats with their note; a way of quantising the page has no name for, as the note writes it.
  assert.equal((await read(safetensors(noted('F8_E4M3', 64, { format: 'float8_e4m3fn', full_precision_matrix_mult: false }, 'a')))).format, 'FP8');
  const unknown = await read(safetensors(noted('I8', 64, { format: 'int4_blockwise' }, 'a')));
  assert.deepEqual([unknown.format, unknown.scheme], ['INT4_BLOCKWISE', 'int4_blockwise']);
  assert.equal((await read(safetensors(noted('I8', 64, { format: 'x'.repeat(200) }, 'a')))).scheme.length, 64);
  // A note that says nothing leaves the type: not JSON, not an object, no format, a format that is no text.
  for (const written of ['pas du JSON', '[1,2]', '{}', '{"format":8}', '"int8_tensorwise"'])
    assert.deepEqual(
      (({ format, scheme }) => [format, scheme])(await read(safetensors(noted('I8', 64, written, 'a')))),
      ['INT8', ''],
      written,
    );
  // Nor a note too long to be one, nor one beside no weight.
  const long = await read(safetensors([['a.weight', 'I8', [4], 64], ['a.comfy_quant', 'U8', [70000], Buffer.concat([note({ format: 'nvfp4' }), Buffer.alloc(70000, 32)])]]));
  assert.equal(long.format, 'INT8');
  const alone = await read(safetensors([['a.weight', 'I8', [4], 64], ['b.comfy_quant', 'U8', [8], note({ format: 'nvfp4' })]]));
  assert.deepEqual([alone.format, alone.kinds], ['INT8', [['I8', 64]]]);
});

test('a file that is no model is refused, with what is wrong with it', async t => {
  const read = await folder(t);
  const prefixed = (length, rest = Buffer.alloc(0)) => {
    const prefix = Buffer.alloc(8);
    prefix.writeBigUInt64LE(BigInt(length));
    return Buffer.concat([prefix, rest]);
  };
  await assert.rejects(read(Buffer.alloc(0)), { status: 400, message: 'Invalid safetensors header size' });
  await assert.rejects(read(prefixed(1, Buffer.from('{'))), { status: 400, message: 'Invalid safetensors header size' });
  await assert.rejects(read(prefixed(300 * 1024 * 1024)), { message: 'Invalid safetensors header size' });
  await assert.rejects(read(prefixed(50, Buffer.from('{"a":1}'))), { status: 400, message: 'Incomplete safetensors header' });
  await assert.rejects(read(safetensors([], { header: '{"a":' })), { message: 'Invalid safetensors header JSON' });
  await assert.rejects(read(safetensors([], { header: '[1,2]' })), { message: 'Invalid safetensors header' });
  await assert.rejects(read(safetensors([], { header: 'null' })), { message: 'Invalid safetensors header' });
  await assert.rejects(read(safetensors([])), { message: 'Safetensors header contains no tensors' });
  await assert.rejects(read(safetensors([], { header: { __metadata__: { a: 'b' } } })), { message: 'Safetensors header contains no tensors' });
  for (const tensor of [null, { dtype: 'I8', shape: [1] }, { dtype: 8, shape: [1], data_offsets: [0, 1] }, { dtype: 'I8', shape: 1, data_offsets: [0, 1] }, { dtype: 'I8', shape: [1], data_offsets: [4, 1] }])
    await assert.rejects(read(safetensors([], { header: { 'a.weight': tensor } })), { message: 'Invalid safetensors header tensor: a.weight' });
});

test('a GGUF file says the blocks most of it is in, and those the engine does not unfold', async t => {
  const read = await folder(t);
  // Metadata of every kind is passed over: a text, numbers, a list of texts, a list of lists.
  const pairs = [
    ['general.architecture', 8, text('ltxv')],
    ['general.quantization_version', 4, u32(2)],
    ['general.alignment', 10, u64(32)],
    ['some.flag', 7, Buffer.from([1])],
    ['some.names', 9, Buffer.concat([u32(8), u64(2), text('un'), text('deux')])],
    ['some.lists', 9, Buffer.concat([u32(9), u64(1), u32(4), u64(3), u32(1), u32(2), u32(3)])],
  ];
  assert.deepEqual(
    await read(
      gguf({
        pairs,
        tensors: [
          ['blocks.0.weight', [32, 64], 8],
          ['blocks.0.bias', [10], 1],
          ['blocks.1.weight', [32, 2], 8],
        ],
      }),
    ),
    {
      container: 'gguf',
      format: 'GGUF Q8',
      // 2048 + 64 values in blocks of 32 values and 34 bytes; ten floats of two bytes.
      kinds: [
        ['Q8_0', (64 + 2) * 34],
        ['F16', 20],
      ],
      tensors: 3,
      unread: [],
    },
  );
  // A block rounded up; the K blocks; version 2.
  const four = await read(gguf({ version: 2, tensors: [['a', [300], 12], ['b', [16], 0]] }));
  assert.deepEqual([four.format, four.kinds, four.unread], ['GGUF Q4', [['Q4_K', 2 * 144], ['F32', 64]], []]);
  assert.equal((await read(gguf({ tensors: [['a', [512], 14]] }))).format, 'GGUF Q6');
  assert.equal((await read(gguf({ tensors: [['a', [64], 2]] }))).format, 'GGUF Q4');
  // A file of plain floats says its floats.
  assert.equal((await read(gguf({ tensors: [['a', [64], 30]] }))).format, 'GGUF BF16');
  // 19/11, on the user's disk: « Q3_K_M », which the engine does not unfold. Named, with any other.
  const three = await read(gguf({ tensors: [['a', [4096], 11], ['b', [256], 12], ['c', [8], 99]] }));
  assert.deepEqual([three.format, three.unread], ['GGUF Q3', ['Q3_K', 'type 99']]);
  assert.deepEqual((await read(gguf({ tensors: [] }))).format, 'GGUF');
  // A header longer than what is read first (a list of four million bytes) is read further.
  const long = await read(gguf({ pairs: [['big.list', 9, Buffer.concat([u32(0), u64(5_000_000), Buffer.alloc(5_000_000)])]], tensors: [['a', [32], 8]] }));
  assert.deepEqual([long.format, long.tensors], ['GGUF Q8', 1]);
  // What is no GGUF header.
  await assert.rejects(read(gguf({ version: 1 })), { status: 400, message: 'Unsupported GGUF version 1' });
  await assert.rejects(read(gguf({ tensors: [['a', [1, 1, 1, 1, 1, 1, 1, 1, 1], 0]] })), { message: 'Invalid GGUF tensor: a' });
  await assert.rejects(read(gguf({ pairs: [['a', 13, Buffer.alloc(4)]] })), { message: 'Unknown GGUF metadata type 13' });
  await assert.rejects(read(gguf({ tensors: [['a', [32], 8]] }).subarray(0, 40)), { status: 400, message: 'Incomplete GGUF header' });
  await assert.rejects(read(Buffer.concat([Buffer.from('GGUF'), u32(3), u64(1), u64(0), u64(2 ** 30), Buffer.alloc(64)])), { message: 'Invalid GGUF text length' });
});

test('the types of GGUF blocks are those the engine names: the ones it unfolds, the ones it does not', async () => {
  // (The engine keeps them in Python, runner/models/gguf.py; the page reads them here.)
  const source = await readFile(new URL('../runner/models/gguf.py', import.meta.url), 'utf8');
  const unfolded = Object.fromEntries([...source.matchAll(/^\s+(\d+): \('([A-Z0-9_]+)', \d+, \d+\),$/gm)].map(([, id, name]) => [id, name]));
  assert.ok(Object.keys(unfolded).length >= 11);
  assert.deepEqual({ ...GGUF_READ }, unfolded);
  const named = Object.fromEntries(
    [...source.matchAll(/^UNREAD (?:\|)?= \{(.+)\}$/gm)].flatMap(([, list]) => [...list.matchAll(/(\d+): '([A-Z0-9_]+)'/g)].map(([, id, name]) => [id, name])),
  );
  assert.ok(Object.keys(named).length >= 15);
  assert.deepEqual({ ...GGUF_UNREAD }, named);
});
