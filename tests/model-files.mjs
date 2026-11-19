import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { families } from '../lib/families.mjs';
import { GGUF_READ, GGUF_UNREAD, describeModelFile, fits, modelsOf, taking, versionComponent } from '../lib/model-files.mjs';

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

// What the files of each model hold, as read on the user's disk on 19/11 (names and shapes only).
const LTX = {
  'adaln_single.linear.weight': [36864, 4096],
  'audio_adaln_single.linear.weight': [18432, 2048],
  'transformer_blocks.0.attn1.to_q.weight': [4096, 4096],
  'transformer_blocks.47.attn1.to_q.weight': [4096, 4096],
  'audio_patchify_proj.weight': [2048, 128],
  'patchify_proj.weight': [4096, 128],
};
const MINIMAX = {
  adaln_t_table: [1025, 8],
  'blocks.0.attn.qkv_proj.weight': [21504, 5376],
  'blocks.49.attn.qkv_proj.weight': [21504, 5376],
  'audio_patch_proj.weight': [5376, 32],
  'video_patch_proj.weight': [5376, 96],
};
const KREA = { 'first.weight': [6144, 64], 'last.linear.weight': [64, 6144], 'blocks.0.attn.wq.weight': [6144, 6144] };
const SEEDVR = { 'vid_in.proj.weight': [3072, 132], 'blocks.35.attn.proj_qkv.vid.weight': [9216, 3072] };
const SCAIL = { 'patch_embedding_pose.weight': [5120, 20, 1, 2, 2], 'patch_embedding_mask.weight': [5120, 28, 1, 2, 2] };
// (0.6.134) One of the two files of Wan 2.2 image to video: 36 channels in, forty blocks, no image encoder.
const WAN22 = { 'patch_embedding.weight': [5120, 36, 1, 2, 2], 'blocks.39.self_attn.q.weight': [5120, 5120] };
const OWN = { ltx25: LTX, minimax_h3: MINIMAX, krea2: KREA, seedvr2: SEEDVR, wan_scail2: SCAIL, wan22: WAN22 };
const prefixed = (shapes, prefix) => Object.fromEntries(Object.entries(shapes).map(([name, shape]) => [prefix + name, shape]));
const which = shapes => modelsOf({ shapes });

test('a file is a version of one model, told by what it holds and not by its name (0.6.116)', () => {
  // The families whose versions are files, and the component those files are.
  const versioned = Object.values(families()).filter(versionComponent);
  assert.deepEqual(versioned.map(manifest => manifest.family), ['krea2', 'ltx25', 'minimax_h3', 'seedvr2', 'wan22', 'wan_scail2']);
  for (const manifest of versioned) {
    const { role, spec } = versionComponent(manifest);
    assert.equal(role, 'model', manifest.family);
    // (0.6.134) No FP8 file of Wan 2.2 was tried: none is promised (tests/wan22.mjs).
    const formats = ['INT8', 'FP8', 'BF16', 'FP16', 'FP32'].filter(format => format !== 'FP8' || manifest.family !== 'wan22');
    assert.deepEqual(spec.reads, formats, manifest.family);
    assert.equal(spec.folder, 'diffusion_models');
  }
  // A folder of Hugging Face, a model ComfyUI runs, a small tool: no versions to find.
  for (const name of ['acestep15', 'moss_sfx', 'moss', 'rife', 'realesrgan_image', 'realesrgan_video'])
    assert.equal(versionComponent(families()[name]), null, name);
  assert.equal(versionComponent(undefined), null);
  // Each to its own model, and to no other.
  for (const [family, shapes] of Object.entries(OWN)) assert.deepEqual(which(shapes), [family], family);
  // The file Moodix ships for LTX 2.5 names its tensors under « model.diffusion_model. ».
  assert.deepEqual(which(prefixed(LTX, 'model.diffusion_model.')), ['ltx25']);
  assert.deepEqual(which(prefixed(LTX, 'diffusion_model.')), ['ltx25']);
  assert.deepEqual(which(prefixed(KREA, 'model.diffusion_model.')), ['krea2']);
  // What the looser check of the chooser took: any model with « transformer_blocks » for LTX 2.5…
  assert.deepEqual(which({ 'transformer_blocks.0.attn1.to_q.weight': [2048, 2048] }), []);
  // … one block more, another width, no sound: other models.
  assert.deepEqual(which({ ...LTX, 'transformer_blocks.48.attn1.to_q.weight': [4096, 4096] }), []);
  assert.deepEqual(which({ ...LTX, 'adaln_single.linear.weight': [18432, 2048] }), []);
  assert.deepEqual(which({ ...LTX, 'adaln_single.linear.weight': [36864, 2048] }), [], 'each side counts');
  assert.deepEqual(which({ ...LTX, 'adaln_single.linear.weight': [18432, 4096] }), []);
  for (const gone of Object.keys(LTX).filter(name => /^(adaln_single|transformer_blocks\.47|audio_patchify)/.test(name))) {
    const { [gone]: left, ...rest } = LTX;
    assert.deepEqual(which(rest), [], gone);
  }
  // … and for MiniMax H3 the image model of the same name (19/11, on the user's disk): the same
  // table and fifty blocks, no sound, and its 4-bit weights half as wide.
  const { 'audio_patch_proj.weight': sound, ...image } = MINIMAX;
  assert.deepEqual(which(image), []);
  assert.deepEqual(which({ ...MINIMAX, 'blocks.49.attn.qkv_proj.weight': [21504, 2688] }), []);
  assert.deepEqual(which({ ...MINIMAX, 'blocks.50.attn.qkv_proj.weight': [21504, 5376] }), []);
  assert.deepEqual(which({ ...MINIMAX, adaln_t_table: [1025, 4] }), []);
  assert.deepEqual(which(prefixed(MINIMAX, 'model.diffusion_model.')), [], 'no file of it is known with that prefix');
  // The model of three billion of SeedVR2 (the engine is written for the seven), Wan 2.2, a Flux.
  assert.deepEqual(which({ 'vid_in.proj.weight': [2560, 132], 'blocks.31.attn.proj_qkv.vid.weight': [7680, 2560] }), []);
  assert.deepEqual(which({ 'patch_embedding.weight': [3072, 48, 1, 2, 2], 'blocks.29.ffn.2.weight': [3072, 14336] }), []);
  assert.deepEqual(which({ 'double_blocks.4.img_attn.qkv.weight': [9216, 3072], 'single_blocks.19.linear1.weight': [27648, 3072] }), []);
  // Nothing read, nothing recognised.
  assert.deepEqual([which({}), which(undefined), modelsOf(undefined)], [[], [], []]);
  // (Given the families to look in: the page passes those it shows.)
  assert.deepEqual(modelsOf({ shapes: LTX }, { ltx25: families().ltx25 }), ['ltx25']);
  assert.deepEqual(modelsOf({ shapes: LTX }, { krea2: families().krea2 }), []);
});

test('what describes a model: tensors it has, with their shape, and tensors it must not have', () => {
  const shapes = { 'a.weight': [4, 8], 'b.0.weight': [2], 'b.1.weight': [2] };
  assert.equal(fits(shapes, [{ key: '^a\\.weight$', shape: [4, 8] }]), true);
  assert.equal(fits(shapes, [{ key: '^a\\.weight$' }]), true, 'no shape asked');
  assert.equal(fits(shapes, [{ key: '^a\\.weight$', shape: [null, 8] }]), true, 'a size left open');
  assert.equal(fits(shapes, [{ key: '^a\\.weight$', shape: [4, 9] }]), false);
  assert.equal(fits(shapes, [{ key: '^a\\.weight$', shape: [4] }]), false, 'one side fewer');
  assert.equal(fits(shapes, [{ key: '^a\\.weight$', shape: [4, 8, 1] }]), false);
  assert.equal(fits(shapes, [{ key: '^c\\.' }]), false);
  // Any tensor of that name will do; every line is to be met.
  assert.equal(fits(shapes, [{ key: '^b\\.\\d+\\.weight$', shape: [2] }]), true);
  assert.equal(fits(shapes, [{ key: '^a\\.' }, { key: '^c\\.' }]), false);
  // Absent: met by no tensor, of that shape when one is given.
  assert.equal(fits(shapes, [{ key: '^a\\.' }, { key: '^b\\.2\\.', absent: true }]), true);
  assert.equal(fits(shapes, [{ key: '^a\\.' }, { key: '^b\\.1\\.', absent: true }]), false);
  assert.equal(fits(shapes, [{ key: '^a\\.weight$', shape: [4, 9], absent: true }]), true);
  // Nothing described recognises nothing, whatever the file.
  assert.deepEqual(
    [fits(shapes, []), fits(shapes, undefined), fits(undefined, [{ key: 'a' }]), fits({}, [{ key: 'a' }])],
    [false, false, false, false],
  );
});

test('how a model takes a file: as it is, through a conversion, or not, with what stops it', () => {
  const spec = versionComponent(families().ltx25).spec,
    file = (format, more = {}) => ({ container: 'safetensors', format, ...more });
  for (const format of ['INT8', 'FP8', 'BF16', 'FP16', 'FP32']) assert.deepEqual(taking(spec, file(format)), { how: 'direct' }, format);
  // 19/11, on the user's disk: weights of 4 bits, an encoder in NVFP4. Named, never tried.
  assert.deepEqual(taking(spec, file('W4A8')), { how: 'refused', reason: 'W4A8' });
  assert.deepEqual(taking(spec, file('NVFP4')), { how: 'refused', reason: 'NVFP4' });
  assert.deepEqual(taking({ reads: ['INT8', 'NVFP4'] }, file('NVFP4')), { how: 'direct' }, 'a family that reads it');
  // A GGUF is never computed with: unfolded whole and written again in INT8, when the model reads
  // INT8 and the engine unfolds every block of the file.
  const packed = (unread = []) => ({ container: 'gguf', format: 'GGUF Q8', unread });
  assert.deepEqual(taking(spec, packed()), { how: 'convert' });
  assert.deepEqual(taking(spec, packed(['Q3_K', 'IQ4_XS'])), { how: 'refused', reason: 'Q3_K, IQ4_XS' });
  assert.deepEqual(taking({ reads: ['BF16'] }, packed()), { how: 'refused', reason: 'GGUF Q8' });
  // A family that says nothing reads nothing.
  assert.deepEqual(taking({}, file('INT8')), { how: 'refused', reason: 'INT8' });
  assert.deepEqual(taking(undefined, packed()), { how: 'refused', reason: 'GGUF Q8' });
  assert.deepEqual(taking(spec, undefined), { how: 'refused', reason: '' });
});

test('the shapes of the tensors are read on request, in the order PyTorch gives them', async t => {
  const read = await folder(t);
  const directory = await mkdtemp(join(tmpdir(), 'moodix-model-shapes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const shaped = async (name, bytes) => {
    await writeFile(join(directory, name), bytes);
    return describeModelFile(join(directory, name), { shapes: true });
  };
  const plain = safetensors([['a.weight', 'BF16', [4, 8], 64], ['a.comfy_quant', 'U8', [2], note({})]], { metadata: { x: 'y' } });
  assert.equal('shapes' in (await read(plain)), false, 'not unless asked');
  assert.deepEqual((await shaped('a.safetensors', plain)).shapes, { 'a.weight': [4, 8], 'a.comfy_quant': [2] });
  // With them, what the file says of itself: its short texts (a title, a source), nothing else.
  assert.deepEqual((await shaped('a.safetensors', plain)).metadata, { x: 'y' });
  assert.equal('metadata' in (await read(plain)), false);
  const said = { 'modelspec.title': 'MiniMax_H3_Ref2VA', source: 'transformer_ref', long: 'z'.repeat(257), edge: 'z'.repeat(256), count: 3, list: ['a'] };
  const told = (await shaped('b.safetensors', safetensors([['a.weight', 'BF16', [4], 8]], { metadata: said }))).metadata;
  assert.deepEqual(told, { 'modelspec.title': 'MiniMax_H3_Ref2VA', source: 'transformer_ref', edge: 'z'.repeat(256) });
  for (const metadata of [undefined, 'texte', ['a'], 7])
    assert.deepEqual((await shaped('c.safetensors', safetensors([['a.weight', 'BF16', [4], 8]], { header: { 'a.weight': { dtype: 'BF16', shape: [4], data_offsets: [0, 8] }, ...(metadata === undefined ? {} : { __metadata__: metadata }) } }))).metadata, {});
  // A GGUF lists the sides of a tensor backwards.
  const unfolded = await shaped('a.gguf', gguf({ tensors: [['a.weight', [8, 4], 8], ['a.bias', [4], 1]] }));
  assert.deepEqual(unfolded.shapes, { 'a.weight': [4, 8], 'a.bias': [4] });
  assert.deepEqual(unfolded.metadata, {});
  assert.equal('shapes' in (await read(gguf({ tensors: [['a.weight', [8, 4], 8]] }))), false);
  // The whole way: a file of LTX 2.5 written as a GGUF is one of LTX 2.5, taken through a conversion.
  const ltx = await shaped('ltx.gguf', gguf({ tensors: Object.entries(LTX).map(([name, shape]) => [name, [...shape].reverse(), 8]) }));
  assert.deepEqual([modelsOf(ltx), taking(versionComponent(families().ltx25).spec, ltx)], [['ltx25'], { how: 'convert' }]);
});
