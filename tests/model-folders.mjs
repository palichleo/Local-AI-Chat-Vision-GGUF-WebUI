import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { GenerationAssets } from '../lib/generation-assets.mjs';
import { NativeWorkflowCatalog, resolveNativeWorkflow } from '../lib/native-workflows.mjs';
import { GenerationService, generationConfig } from '../lib/generation-service.mjs';
import { families, familyTemplate } from '../lib/families.mjs';

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'atelier-folders-'));
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
/** A tokenizer folder with `size` token ids. */
async function tokenizer(folder, size) {
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, 'vocab.json'),
    JSON.stringify(Object.fromEntries(Array.from({ length: size }, (_, i) => ['t' + i, i]))),
  );
  await writeFile(join(folder, 'merges.txt'), '');
  await writeFile(join(folder, 'tokenizer_config.json'), JSON.stringify({ added_tokens_decoder: {} }));
  return folder;
}
// What each kind of MOSS Image file is recognised by.
const MOSS = {
  model: { 'text_embedder.proj.weight': [1, 4096] },
  textEncoder: { 'model.language_model.embed_tokens.weight': [4, 4096] },
  vae: { 'encoder.conv_in.weight': [1, 3, 3, 3], 'decoder.conv_in.weight': [1, 32, 3, 3] },
};

test('a component no workflow fixes takes the file of its folder that fits, whatever its name', async t => {
  const root = await directory(t),
    encoders = join(root, 'text_encoders');
  await mkdir(join(encoders, 'big'), { recursive: true });
  // What a real folder holds: the model itself dropped there by mistake, the encoder of another
  // family, a note, and two versions of the right one (two machines, two quantisations).
  await checkpoint(join(encoders, 'MOSS-Image-SFT-INT8.safetensors'), MOSS.model);
  await checkpoint(join(encoders, 'qwen3vl_4b.safetensors'), { 'model.embed_tokens.weight': [4, 2560] });
  await writeFile(join(encoders, 'notes.txt'), 'à trier');
  const w4a8 = await checkpoint(join(encoders, 'qwen3.5_9b_w4a8.safetensors'), MOSS.textEncoder),
    int8 = await checkpoint(join(encoders, 'big', 'qwen3.5_9b_int8.safetensors'), MOSS.textEncoder);
  const assets = new GenerationAssets(join(root, 'assets.json'), {
      folder: (family, kind) => (kind === 'textEncoder' ? encoders : null),
    }),
    moss = { kind: 'textEncoder', family: 'moss' },
    named = async options => basename((await assets.pick('textEncoder', 'moss', options)).path);

  // Neither the model nor the smaller encoder: the files laid out as this component is.
  assert.equal(await named(), 'qwen3.5_9b_int8.safetensors');
  // Among several, the one named most like what the workflow asks for.
  assert.equal(await named({ file: 'mossImage_sft_txt_w4a8.safetensors' }), 'qwen3.5_9b_w4a8.safetensors');
  // The same folder answers for another family with its own encoder.
  assert.equal(basename((await assets.pick('textEncoder', 'krea2')).path), 'qwen3vl_4b.safetensors');
  // A kind of file without a folder has no default.
  assert.equal(await assets.pick('model', 'moss'), null);

  // A workflow that names a file this machine does not have: the folder answers, and nothing
  // is written down (the folder decides again next time).
  const stand = await assets.resolve('select-local-text-encoder', {
    ...moss,
    file: 'mossImage_sft_txt_int8.safetensors',
  });
  assert.equal(basename(stand.path), 'qwen3.5_9b_int8.safetensors');
  assert.equal(stand.automatic, true);
  assert.deepEqual(await assets.list(), []);

  // A file chosen in a workflow is that workflow's, until it leaves its place.
  const chosen = await assets.register({ path: w4a8, ...moss });
  assert.equal((await assets.resolve(chosen.id, moss)).automatic, undefined);
  await rm(w4a8);
  const after = await assets.resolve(chosen.id, moss);
  assert.equal(basename(after.path), 'qwen3.5_9b_int8.safetensors');
  assert.equal(after.automatic, true);

  // Nothing that fits any more: the errors of before.
  await rm(int8);
  await assert.rejects(assets.resolve(chosen.id, moss), error => error.code === 'ENOENT');
  await assert.rejects(assets.resolve('nobody', moss), /not found/);
});

test('a tokenizer left to its folder is the one whose vocabulary is the text encoder’s', async t => {
  const root = await directory(t),
    tokenizers = join(root, 'tokenizers');
  const encoder = await checkpoint(join(root, 'qwen.safetensors'), { 'model.embed_tokens.weight': [12, 2560] });
  await tokenizer(join(tokenizers, 'qwen25_tokenizer'), 12);
  await tokenizer(join(tokenizers, 'qwen35_tokenizer'), 5000);
  await mkdir(join(tokenizers, 'not a tokenizer'));
  const assets = new GenerationAssets(join(root, 'assets.json'), {
    folder: (family, kind) => (kind === 'tokenizer' ? tokenizers : null),
  });
  const picked = await assets.pick('tokenizer', 'krea2', { encoder });
  assert.equal(basename(picked.path), 'qwen25_tokenizer');
  assert.equal(picked.automatic, true);
  // Without an encoder to match, the name the workflow asks for.
  assert.equal(
    basename((await assets.pick('tokenizer', 'krea2', { file: 'qwen35_tokenizer' })).path),
    'qwen35_tokenizer',
  );
});

test('a workflow runs on the folders of the settings; a file it fixes overrides them', async t => {
  const root = await directory(t),
    folders = {
      model: join(root, 'diffusion_models'),
      textEncoder: join(root, 'text_encoders'),
      vae: join(root, 'vae'),
    };
  for (const folder of Object.values(folders)) await mkdir(folder);
  await checkpoint(join(folders.model, 'moss_fp8.safetensors'), MOSS.model);
  await checkpoint(join(folders.textEncoder, 'qwen3.5_9b_int8.safetensors'), MOSS.textEncoder);
  const vae = await checkpoint(join(folders.vae, 'flux2-vae.safetensors'), MOSS.vae);
  const assets = new GenerationAssets(join(root, 'assets.json'), { folder: (family, kind) => folders[kind] ?? null }),
    catalog = new NativeWorkflowCatalog(join(root, 'workflow'), { assets, capabilities: { moss: true } }),
    workflow = { ...familyTemplate(families().moss), id: 'moss-auto', enabled: true },
    listed = async () => (await catalog.list()).find(item => item.id === workflow.id),
    everything = {
      model: 'moss_fp8.safetensors',
      textEncoder: 'qwen3.5_9b_int8.safetensors',
      vae: 'flux2-vae.safetensors',
    };

  // No file fixed at all: each component is found in the folder of its kind, and named.
  await catalog.save({ ...workflow, components: {} });
  let found = await listed();
  assert.equal(found.ready, true, found.unavailableReason);
  assert.deepEqual(found.automatic, everything);
  const job = await resolveNativeWorkflow(found, { prompt: 'une affiche' }, assets, { seed: 1 });
  assert.deepEqual(
    Object.fromEntries(Object.entries(job.components).map(([role, path]) => [role, basename(path)])),
    everything,
  );

  // The same for the files a shipped workflow names that this machine does not have.
  await catalog.save(workflow);
  assert.deepEqual((await listed()).automatic, everything);

  // A file chosen in the workflow is used, whatever the folder holds.
  const own = await checkpoint(join(root, 'mon-encodeur.safetensors'), MOSS.textEncoder),
    chosen = await assets.register({ path: own, kind: 'textEncoder', family: 'moss' });
  await catalog.save({ ...workflow, components: { textEncoder: { policy: 'fixed', asset: chosen.id } } });
  found = await listed();
  assert.deepEqual(found.automatic, { model: everything.model, vae: everything.vae });
  assert.equal(
    basename(
      (await resolveNativeWorkflow(found, { prompt: 'une affiche' }, assets, { seed: 1 })).components.textEncoder,
    ),
    'mon-encodeur.safetensors',
  );

  // A folder that holds nothing for a component: said with what to do, and the workflow waits.
  await rm(vae);
  found = await listed();
  assert.equal(found.ready, false);
  assert.match(
    found.unavailableReason,
    /^Aucun fichier pour « VAE » : choisissez-le dans ce workflow, ou placez-le dans le dossier/,
  );
  await assert.rejects(
    resolveNativeWorkflow(found, { prompt: 'une affiche' }, assets, { seed: 1 }),
    /Aucun fichier pour « VAE »/,
  );
});

test('each kind of file has its folder in the settings', async t => {
  const root = await directory(t),
    service = new GenerationService({
      root,
      dataDir: join(root, 'data'),
      workflowDir: join(root, 'workflow'),
      outputDir: join(root, 'output'),
    }),
    models = join(root, 'models'),
    base = { enabled: false, autoAllow: false, maxIterations: 5, pythonPath: '' };
  t.after(() => service.close?.());
  // Settings saved before these folders existed.
  assert.deepEqual(
    ['textEncoderRoot', 'tokenizerRoot', 'upscaleRoot', 'latentUpscaleRoot'].map(key => generationConfig(base)[key]),
    ['', '', '', ''],
  );
  assert.throws(() => generationConfig({ ...base, textEncoderRoot: 'relatif/encodeurs' }), /absolu/);

  // Nothing set: the folders under models/, the tokenizers with the text encoders.
  assert.equal(service.folderOf('krea2', 'textEncoder'), join(models, 'LLMs'));
  assert.equal(service.folderOf('krea2', 'tokenizer'), join(models, 'LLMs'));
  // « upscaler » is an image model for Real-ESRGAN and a latent one for LTX: two folders.
  assert.equal(service.folderOf('realesrgan_image', 'upscaler'), join(models, 'upscale_models'));
  assert.equal(service.folderOf('ltx25', 'upscaler'), join(models, 'latent_upscale_models'));
  assert.equal(service.folderOf('krea2', 'unknown'), null);

  const comfy = name => join(root, 'ComfyUI', 'models', name);
  service.config = generationConfig({
    ...base,
    textEncoderRoot: comfy('text_encoders'),
    upscaleRoot: comfy('upscale_models'),
    latentUpscaleRoot: comfy('latent_upscale_models'),
  });
  assert.equal(service.folderOf('moss', 'textEncoder'), comfy('text_encoders'));
  assert.equal(service.folderOf('minimax_h3', 'tokenizer'), comfy('text_encoders'));
  assert.equal(service.folderOf('realesrgan_video', 'upscaler'), comfy('upscale_models'));
  assert.equal(service.folderOf('ltx25', 'upscaler'), comfy('latent_upscale_models'));
  assert.equal(service.folderOf('moss', 'vae'), join(models, 'VAE'));
  // What the page shows as defaults, by role.
  const folders = service.folders();
  assert.equal(folders.upscaler, comfy('upscale_models'));
  assert.equal(folders.latentUpscaler, comfy('latent_upscale_models'));
  assert.equal(folders.tokenizer, comfy('text_encoders'));

  service.config = generationConfig({ ...service.config, tokenizerRoot: join(root, 'tokenizers') });
  assert.equal(service.folderOf('krea2', 'tokenizer'), join(root, 'tokenizers'));
  assert.equal(service.folders().tokenizer, join(root, 'tokenizers'));
  // The registry of files asks the service where a component takes its default.
  assert.equal(service.assets.folder('ltx25', 'upscaler'), comfy('latent_upscale_models'));
});
