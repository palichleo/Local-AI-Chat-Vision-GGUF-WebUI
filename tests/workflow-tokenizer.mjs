import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GenerationAssets, inspectTokenizer, suggestTokenizer, tokenizerMismatch } from '../lib/generation-assets.mjs';
import { NativeWorkflowCatalog } from '../lib/native-workflows.mjs';
import { GenerationService } from '../lib/generation-service.mjs';

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'atelier-tokenizer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
/** Header-only safetensors file whose declared tensors are backed by a sparse body. */
async function checkpoint(path, tensors) {
  let offset = 0;
  const header = {};
  for (const [key, shape] of Object.entries(tensors)) {
    const length = shape.reduce((a, b) => a * b, 1);
    header[key] = { dtype: 'I8', shape, data_offsets: [offset, offset + length] };
    offset += length;
  }
  const body = Buffer.from(JSON.stringify(header)),
    prefix = Buffer.alloc(8);
  prefix.writeBigUInt64LE(BigInt(body.length));
  const handle = await open(path, 'w');
  try {
    await handle.write(Buffer.concat([prefix, body]));
    await handle.truncate(8 + body.length + offset);
  } finally {
    await handle.close();
  }
  return path;
}
/** A BPE tokenizer folder in the vocab.json + merges.txt layout ComfyUI ships, with `size` token ids. */
async function tokenizer(folder, size, added = {}) {
  await mkdir(folder, { recursive: true });
  const vocab = Object.fromEntries(Array.from({ length: size - Object.keys(added).length }, (_, i) => ['t' + i, i]));
  await writeFile(join(folder, 'vocab.json'), JSON.stringify(vocab));
  await writeFile(join(folder, 'merges.txt'), '');
  await writeFile(join(folder, 'tokenizer_config.json'), JSON.stringify({ added_tokens_decoder: added }));
  return folder;
}
/** A ComfyUI-like installation: weights under models/, tokenizers under comfy/text_encoders/. */
async function comfy(root, rows = 12) {
  const models = join(root, 'ComfyUI', 'models');
  await mkdir(join(models, 'diffusion_models'), { recursive: true });
  await mkdir(join(models, 'text_encoders'), { recursive: true });
  await mkdir(join(models, 'vae'), { recursive: true });
  const shipped = join(root, 'ComfyUI', 'comfy', 'text_encoders');
  return {
    model: await checkpoint(join(models, 'diffusion_models', 'krea.safetensors'), {
      'first.weight': [6144, 64],
      'blocks.0.attn.wq.weight': [6144, 6144],
    }),
    textEncoder: await checkpoint(join(models, 'text_encoders', 'qwen.safetensors'), {
      'model.embed_tokens.weight': [rows, 2560],
    }),
    vae: await checkpoint(join(models, 'vae', 'vae.safetensors'), {
      'encoder.conv1.weight': [1, 3, 1, 1, 1],
      'decoder.conv1.weight': [1, 16, 1, 1, 1],
    }),
    // Same family as the encoder (10 ids + 2 special tokens = 12), and a larger, unrelated one.
    matching: await tokenizer(join(shipped, 'qwen25_tokenizer'), 12, {
      10: { content: '<|im_start|>' },
      11: { content: '<|im_end|>' },
    }),
    other: await tokenizer(join(shipped, 'qwen35_tokenizer'), 5000),
    shipped,
  };
}
const workflow = components => ({
  schemaVersion: 1,
  id: 'krea',
  name: 'Krea 2',
  description: 'Creer une image',
  enabled: true,
  pipeline: 'krea2',
  mediaType: 'image',
  components,
  parameters: {
    prompt: { policy: 'model', type: 'string', maxLength: 8000 },
    seed: { policy: 'random', type: 'integer' },
    width: { policy: 'fixed', value: 512 },
    height: { policy: 'fixed', value: 512 },
    steps: { policy: 'fixed', value: 8 },
  },
  loras: [],
  references: [],
});

test('a tokenizer folder is read from either layout, and its vocabulary must fit its encoder', async t => {
  const root = await directory(t),
    files = await comfy(root);
  assert.deepEqual(await inspectTokenizer(files.matching), { path: await realpath(files.matching), vocabulary: 12 });
  // Picking one of its JSON files designates the folder.
  assert.equal((await inspectTokenizer(join(files.matching, 'vocab.json'))).path, await realpath(files.matching));
  const fast = join(root, 'fast');
  await mkdir(fast);
  await writeFile(join(fast, 'tokenizer_config.json'), '{}');
  await writeFile(
    join(fast, 'tokenizer.json'),
    JSON.stringify({ model: { vocab: { a: 0, b: 1 } }, added_tokens: [{ id: 2, content: '<s>' }] }),
  );
  assert.equal((await inspectTokenizer(fast)).vocabulary, 3);
  await assert.rejects(inspectTokenizer(join(root, 'ComfyUI', 'models')), /tokenizer_config\.json/);
  await assert.rejects(inspectTokenizer(files.vae), /dossier du tokenizer/);
  assert.equal(tokenizerMismatch(151669, 151936), '', 'Qwen2.5 tokenizer and Qwen3 encoder');
  assert.equal(tokenizerMismatch(248077, 248320), '', 'Qwen3.5 tokenizer and Qwen3.5 encoder');
  assert.match(tokenizerMismatch(151669, 248320), /ne correspond pas/);
  assert.match(tokenizerMismatch(248077, 151936), /ne correspond pas/);
  assert.equal(tokenizerMismatch(10, null), '', 'an unknown encoder vocabulary is not a mismatch');
});

test('the tokenizer ComfyUI ships is found from the encoder and registered as a folder', async t => {
  const root = await directory(t),
    files = await comfy(root);
  const found = await suggestTokenizer(files.textEncoder);
  assert.equal(found.path, await realpath(files.matching));
  assert.equal(found.rows, 12);
  assert.equal(await suggestTokenizer(files.vae), null, 'no embedding, no suggestion');
  const assets = new GenerationAssets(join(root, 'assets.json'));
  const asset = await assets.register({
    path: join(files.matching, 'tokenizer_config.json'),
    kind: 'tokenizer',
    family: 'krea2',
  });
  assert.equal(asset.path, await realpath(files.matching));
  assert.equal(asset.name, 'qwen25_tokenizer');
  assert.deepEqual(asset.inspection, { format: 'tokenizer', vocabulary: 12 });
  assert.equal((await assets.register({ path: files.matching, kind: 'tokenizer', family: 'krea2' })).id, asset.id);
  await assert.rejects(assets.register({ path: files.vae, kind: 'tokenizer', family: 'krea2' }), /tokenizer/);
  await assert.rejects(
    assets.register({ path: files.matching, kind: 'tokenizer', family: 'ltx25' }),
    /Unsupported asset kind/,
  );
});

test('Krea 2 runs on Atelier’s engine: its tokenizer is needed, and the one given must fit', async t => {
  const root = await directory(t),
    files = await comfy(root),
    assets = new GenerationAssets(join(root, 'assets.json')),
    ids = {};
  for (const kind of ['model', 'textEncoder', 'vae'])
    ids[kind] = (await assets.register({ path: files[kind], kind, family: 'krea2' })).id;
  const catalog = new NativeWorkflowCatalog(join(root, 'workflow'), {
    assets,
    capabilities: { krea2: { ready: true } },
  });
  const base = Object.fromEntries(Object.entries(ids).map(([kind, id]) => [kind, { policy: 'fixed', asset: id }]));
  // A workflow saved before tokenizers moved into workflows.
  await mkdir(join(root, 'workflow'));
  await writeFile(join(root, 'workflow', 'krea.json'), JSON.stringify(workflow(base)));
  assert.equal((await catalog.read('krea')).components.tokenizer, undefined);
  // Atelier's engine has no tokenizer of its own (ComfyUI, which made these images, had): the
  // workflow stays readable, says what it lacks, and is neither saved nor run without it.
  const [listed] = await catalog.list();
  assert.equal(listed.ready, false);
  assert.match(listed.unavailableReason, /Aucun fichier pour « Tokenizer »/);
  await assert.rejects(catalog.save(workflow(base)), /Tokenizer/);
  await assert.rejects(catalog.prepare('krea', { prompt: 'a boat' }), /Tokenizer/);

  const other = await assets.register({ path: files.other, kind: 'tokenizer', family: 'krea2' });
  await assert.rejects(
    catalog.save(workflow({ ...base, tokenizer: { policy: 'fixed', asset: other.id } })),
    /ne correspond pas/,
  );
  const matching = await assets.register({ path: files.matching, kind: 'tokenizer', family: 'krea2' });
  await assert.rejects(
    catalog.save(workflow({ ...base, tokenizer: { policy: 'model', choices: [matching.id] } })),
    /must be fixed/,
  );
  await catalog.save(workflow({ ...base, tokenizer: { policy: 'fixed', asset: matching.id } }));
  const [ready] = await catalog.list();
  assert.equal(ready.ready, true, ready.unavailableReason);
  const { job } = await catalog.prepare('krea', { prompt: 'a boat' });
  assert.equal(job.components.tokenizer, await realpath(files.matching));
});

test('the former application-wide tokenizer moves into existing workflows and leaves the settings', async t => {
  const root = await directory(t),
    files = await comfy(root),
    dataDir = join(root, 'data'),
    options = { root, dataDir, workflowDir: join(root, 'workflow'), outputDir: join(root, 'output') };
  await mkdir(dataDir);
  const assets = new GenerationAssets(join(dataDir, 'generation-assets.json')),
    base = {};
  for (const kind of ['model', 'textEncoder', 'vae'])
    base[kind] = { policy: 'fixed', asset: (await assets.register({ path: files[kind], kind, family: 'krea2' })).id };
  await mkdir(options.workflowDir);
  await writeFile(join(options.workflowDir, 'krea.json'), JSON.stringify(workflow(base)));
  const settings = {
    enabled: true,
    autoAllow: true,
    maxIterations: 5,
    reviewVideos: false,
    pythonPath: '',
    modelRoot: '',
    vaeRoot: '',
    loraRoot: '',
  };
  await writeFile(join(dataDir, 'generation.json'), JSON.stringify({ ...settings, tokenizerPath: files.matching }));

  const service = await new GenerationService(options).init();
  t.after(() => service.close());
  assert.equal(service.config.tokenizerPath, undefined);
  // Rewritten with the folders added since, empty, and the choices added since at their default.
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'generation.json'), 'utf8')), {
    ...settings,
    autoAllowVideos: true,
    reviewImages: false,
    modelsDir: '',
    textEncoderRoot: '',
    tokenizerRoot: '',
    upscaleRoot: '',
    latentUpscaleRoot: '',
  });
  const migrated = await service.catalog.read('krea');
  const tokenizerAsset = await service.assets.read(migrated.components.tokenizer.asset);
  assert.equal(tokenizerAsset.path, await realpath(files.matching));
  assert.equal(service.warning, undefined);

  // The editor's suggestion: from the encoder to the tokenizer ComfyUI ships beside it.
  const suggested = await service.suggestTokenizer(base.textEncoder.asset, 'krea2');
  assert.equal(suggested.asset.id, tokenizerAsset.id);
  await assert.rejects(service.suggestTokenizer(base.textEncoder.asset, 'ltx25'), /n’utilise pas/);
});

test('an unusable former tokenizer is kept in the settings and reported instead of being lost', async t => {
  const root = await directory(t),
    files = await comfy(root),
    dataDir = join(root, 'data'),
    options = { root, dataDir, workflowDir: join(root, 'workflow'), outputDir: join(root, 'output') };
  await mkdir(dataDir);
  const assets = new GenerationAssets(join(dataDir, 'generation-assets.json')),
    base = {};
  for (const kind of ['model', 'textEncoder', 'vae'])
    base[kind] = { policy: 'fixed', asset: (await assets.register({ path: files[kind], kind, family: 'krea2' })).id };
  await mkdir(options.workflowDir);
  await writeFile(join(options.workflowDir, 'krea.json'), JSON.stringify(workflow(base)));
  const stored = {
    enabled: true,
    autoAllow: true,
    maxIterations: 5,
    pythonPath: '',
    tokenizerPath: join(root, 'missing'),
  };
  await writeFile(join(dataDir, 'generation.json'), JSON.stringify(stored));
  const service = await new GenerationService(options).init();
  t.after(() => service.close());
  assert.match(service.warning, /Tokenizer à choisir.*Krea 2/);
  assert.equal(
    JSON.parse(await readFile(join(dataDir, 'generation.json'), 'utf8')).tokenizerPath,
    stored.tokenizerPath,
  );
  assert.equal((await service.catalog.read('krea')).components.tokenizer, undefined);
});

test('a tokenizer is read again only once its files changed', async t => {
  const root = await directory(t),
    folder = join(root, 'tokenizer');
  await tokenizer(folder, 12);
  assert.equal((await inspectTokenizer(folder)).vocabulary, 12);
  assert.equal((await inspectTokenizer(folder)).vocabulary, 12, 'the same folder, as it was');
  // Another tokenizer in its place: read again, not the one kept.
  await rm(folder, { recursive: true, force: true });
  await tokenizer(folder, 30);
  assert.equal((await inspectTokenizer(folder)).vocabulary, 30);
  await rm(join(folder, 'tokenizer_config.json'));
  await assert.rejects(inspectTokenizer(folder), /tokenizer_config.json/);
});
