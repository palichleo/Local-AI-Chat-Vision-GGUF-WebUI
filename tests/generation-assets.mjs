import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GenerationAssets } from '../lib/generation-assets.mjs';

async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-assets-'));
  try {
    await fn(directory, new GenerationAssets(join(directory, 'assets.json')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function weights(path, tensors) {
  const header = Buffer.from(JSON.stringify(tensors));
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64LE(BigInt(header.length));
  await writeFile(
    path,
    Buffer.concat([
      prefix,
      header,
      Buffer.alloc(Math.min(10240, Math.max(...Object.values(tensors).map(tensor => tensor.data_offsets[1])))),
    ]),
  );
}
const tensor = { dtype: 'F32', shape: [1], data_offsets: [0, 4] };
const encoderTensor = { dtype: 'F32', shape: [1, 2560], data_offsets: [0, 10240] };

test('registered assets use inspected local checkpoint headers and persisted stable IDs', async () => {
  await fixture(async (directory, assets) => {
    const path = join(directory, 'anything.safetensors');
    await weights(path, { 'model.embed_tokens.weight': encoderTensor });
    const saved = await assets.register({
      id: 'encoder',
      name: 'My encoder',
      path,
      kind: 'textEncoder',
      family: 'krea2',
    });
    assert.equal(saved.path, await realpath(path));
    assert.equal(
      (await assets.resolve('encoder', { kind: 'textEncoder', family: 'krea2' })).path,
      await realpath(path),
    );
    assert.equal((await new GenerationAssets(assets.file).read('encoder')).name, 'My encoder');
    await assert.rejects(assets.resolve('encoder', { kind: 'vae', family: 'krea2' }), /kind|compatible/i);
    await assert.rejects(assets.resolve('encoder', { kind: 'textEncoder', family: 'ltx25' }), /family|compatible/i);
    assert.equal((await assets.list()).length, 1);
    const unnamed = await assets.register({ path, kind: 'textEncoder', family: 'krea2' });
    assert.equal(unnamed.name, 'My encoder');
    assert.equal(unnamed.id, saved.id);
    assert.equal((await assets.list()).length, 1);
  });
});

test('invalid header and incompatible layouts cannot overwrite a registered asset', async () => {
  await fixture(async (directory, assets) => {
    const path = join(directory, 'valid.safetensors');
    await weights(path, { 'model.embed_tokens.weight': encoderTensor });
    await assets.register({ id: 'encoder', path, kind: 'textEncoder', family: 'krea2' });
    const before = await readFile(assets.file, 'utf8');
    const bad = join(directory, 'bad.safetensors');
    await writeFile(bad, 'not weights');
    await assert.rejects(
      assets.register({ id: 'encoder', path: bad, kind: 'textEncoder', family: 'krea2' }),
      /header|safetensors/i,
    );
    await assert.rejects(
      assets.register({ id: 'encoder', path, kind: 'vae', family: 'krea2' }),
      /structure de ce fichier/,
    );
    assert.equal(await readFile(assets.file, 'utf8'), before);
    await weights(bad, { 'model.embed_tokens.weight': { ...tensor, data_offsets: [0, 400] } });
    await assert.rejects(assets.register({ path: bad, kind: 'textEncoder', family: 'krea2' }), /offset|size|header/i);
  });
});

test('corrupted registry entries are isolated with an actionable warning', async () => {
  await fixture(async (directory, assets) => {
    const path = join(directory, 'encoder.safetensors');
    await weights(path, { 'model.embed_tokens.weight': encoderTensor });
    const saved = await assets.register({ id: 'encoder', path, kind: 'textEncoder', family: 'krea2' });
    await writeFile(assets.file, JSON.stringify({ schemaVersion: 1, assets: [saved, { id: '../unsafe' }] }));
    assert.deepEqual(
      (await assets.list()).map(asset => asset.id),
      ['encoder'],
    );
    assert.match(assets.warnings[0], /unsafe|invalid|entry/i);
  });
});

test('checkpoint role checks reject tensor names with the wrong basic shape', async () => {
  await fixture(async (directory, assets) => {
    const path = join(directory, 'wrong-shape.safetensors');
    await weights(path, { 'model.embed_tokens.weight': tensor });
    await assert.rejects(
      assets.register({ id: 'wrong', path, kind: 'textEncoder', family: 'krea2' }),
      /structure de ce fichier/,
    );
  });
});

test('MOSS Image: the model itself is refused as its text encoder, and each file only in its own role', async () => {
  await fixture(async (directory, assets) => {
    const wide = { dtype: 'F16', shape: [1, 4096], data_offsets: [0, 8192] };
    // The diffusion model, as its file is laid out: the projection of the text encoder's 4096 values.
    const model = join(directory, 'MOSS-Image-SFT-INT8.safetensors');
    await weights(model, {
      'text_embedder.proj.weight': wide,
      'layers.0.proj.qkv.weight': { dtype: 'I8', shape: [4], data_offsets: [8192, 8196] },
    });
    // Its text encoder, a Qwen3.5-9B: a table of token embeddings 4096 wide.
    const encoder = join(directory, 'qwen3.5_9b.safetensors');
    await weights(encoder, { 'model.language_model.embed_tokens.weight': wide });
    // A smaller Qwen (2560 wide) is another model's encoder.
    const small = join(directory, 'qwen_4b.safetensors');
    await weights(small, { 'model.embed_tokens.weight': encoderTensor });
    const vae = join(directory, 'flux2-vae.safetensors');
    await weights(vae, {
      'encoder.conv_in.weight': { dtype: 'F32', shape: [1, 3, 3, 3], data_offsets: [0, 108] },
      'decoder.conv_in.weight': { dtype: 'F32', shape: [1, 32, 3, 3], data_offsets: [108, 1260] },
    });
    const register = (path, kind) => assets.register({ path, kind, family: 'moss' });

    // What happened: the model picked in the text encoder's place. It is said in the user's words.
    await assert.rejects(
      register(model, 'textEncoder'),
      /La structure de ce fichier n’est pas celle attendue pour « Encodeur de texte » \(MOSS Image\)\. Attendu : .*Qwen3\.5-9B.*non le modèle/,
    );
    await assert.rejects(register(small, 'textEncoder'), /structure de ce fichier/);
    await assert.rejects(register(encoder, 'model'), /structure de ce fichier/);
    await assert.rejects(register(model, 'vae'), /structure de ce fichier/);
    assert.equal((await register(model, 'model')).kind, 'model');
    assert.equal((await register(encoder, 'textEncoder')).kind, 'textEncoder');
    assert.equal((await register(vae, 'vae')).kind, 'vae');
  });
});

test('a model file is inspected again once it changed, never taken from what was kept', async () => {
  await fixture(async (directory, assets) => {
    const path = join(directory, 'encoder.safetensors');
    await weights(path, { 'model.embed_tokens.weight': encoderTensor });
    await assets.register({ id: 'encoder', path, kind: 'textEncoder', family: 'krea2' });
    const first = await assets.resolve('encoder', { kind: 'textEncoder', family: 'krea2' });
    assert.deepEqual(await assets.resolve('encoder', { kind: 'textEncoder', family: 'krea2' }), first);
    // Another file in its place, of another layout: refused, as it would be the first time.
    await weights(path, { 'unrelated.weight': tensor });
    await assert.rejects(
      assets.resolve('encoder', { kind: 'textEncoder', family: 'krea2' }),
      /structure|signature|attendu/i,
    );
  });
});
