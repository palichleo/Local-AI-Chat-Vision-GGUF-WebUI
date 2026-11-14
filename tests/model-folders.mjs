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

  // Neither the model nor the smaller encoder: the files laid out as this component is, the
  // one in the folder itself before the one in a sub-folder.
  assert.equal(await named(), 'qwen3.5_9b_w4a8.safetensors');
  assert.equal(await named({ file: 'mossImage_sft_txt_int8.safetensors' }), 'qwen3.5_9b_int8.safetensors');
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

function service(t, root) {
  const made = new GenerationService({
    root,
    dataDir: join(root, 'data'),
    workflowDir: join(root, 'workflow'),
    outputDir: join(root, 'output'),
  });
  t.after(() => made.close?.());
  return made;
}
const base = { enabled: false, autoAllow: false, maxIterations: 5, pythonPath: '' };

test('one models directory, sorted as ComfyUI sorts its own, serves every kind of file', async t => {
  const root = await directory(t),
    made = service(t, root),
    own = name => join(root, 'models', name),
    comfy = name => join(root, 'ComfyUI', 'models', name);
  // Settings saved before the directory could be chosen.
  assert.equal(generationConfig(base).modelsDir, '');
  assert.throws(() => generationConfig({ ...base, modelsDir: 'ComfyUI/models' }), /absolu/);

  // Nothing set: Atelier's own directory, under the names ComfyUI gives its folders.
  assert.equal(made.modelsDir(), join(root, 'models'));
  assert.equal(made.folderOf('krea2', 'model'), own('diffusion_models'));
  assert.equal(made.folderOf('krea2', 'textEncoder'), own('text_encoders'));
  assert.equal(made.folderOf('krea2', 'tokenizer'), own('text_encoders'));
  assert.equal(made.folderOf('moss', 'vae'), own('vae'));
  assert.equal(made.folderOf('', 'lora'), own('loras'));
  assert.equal(made.folderOf('acestep15', 'musicModel'), own('diffusers'));
  assert.equal(made.folderOf('rife', 'interpolator'), own('frame_interpolation'));
  // « upscaler » is an image model for Real-ESRGAN and a latent one for LTX: two folders.
  assert.equal(made.folderOf('realesrgan_image', 'upscaler'), own('upscale_models'));
  assert.equal(made.folderOf('ltx25', 'upscaler'), own('latent_upscale_models'));
  assert.equal(made.folderOf('krea2', 'unknown'), null);
  // What was filed under Atelier's former names, or ComfyUI's other ones, is still found.
  assert.deepEqual(made.foldersOf('krea2', 'model'), [own('diffusion_models'), own('unet'), own('checkpoints')]);
  assert.deepEqual(made.foldersOf('krea2', 'textEncoder'), [own('text_encoders'), own('clip'), own('LLMs')]);
  assert.deepEqual(made.foldersOf('', 'lora'), [own('loras'), own('LoRa')]);

  // The single path of the settings: ComfyUI's directory. Every kind of file follows.
  made.config = generationConfig({ ...base, modelsDir: join(root, 'ComfyUI', 'models') });
  assert.equal(made.folderOf('krea2', 'model'), comfy('diffusion_models'));
  assert.equal(made.folderOf('minimax_h3', 'textEncoder'), comfy('text_encoders'));
  assert.equal(made.folderOf('minimax_h3', 'tokenizer'), comfy('text_encoders'));
  assert.equal(made.folderOf('seedvr2', 'vae'), comfy('vae'));
  assert.equal(made.folderOf('', 'lora'), comfy('loras'));
  assert.equal(made.folderOf('ltx25', 'upscaler'), comfy('latent_upscale_models'));
  const shown = made.folders();
  assert.equal(shown.models, join(root, 'ComfyUI', 'models'));
  assert.equal(shown.model, comfy('diffusion_models'));
  assert.equal(shown.upscaler, comfy('upscale_models'));
  assert.equal(shown.latentUpscaler, comfy('latent_upscale_models'));
  // Atelier's own directory stays a place to look, after ComfyUI's.
  assert.deepEqual(made.foldersOf('moss', 'vae'), [comfy('vae'), comfy('VAE'), own('vae'), own('VAE')]);
  // The registry of files asks the service where a component takes its default.
  assert.equal(made.assets.folder('ltx25', 'upscaler')[0], comfy('latent_upscale_models'));

  // The details: a folder apart for one kind of file wins over the directory, for that kind only.
  made.config = generationConfig({ ...made.config, vaeRoot: join(root, 'mes vae'), tokenizerRoot: join(root, 'tok') });
  assert.equal(made.folderOf('moss', 'vae'), join(root, 'mes vae'));
  assert.equal(made.folderOf('krea2', 'tokenizer'), join(root, 'tok'));
  assert.equal(made.folderOf('krea2', 'textEncoder'), comfy('text_encoders'));
  assert.equal(made.folders().tokenizer, join(root, 'tok'));
});

test('Atelier’s own models directory holds the folders of ComfyUI, and files left under the former names still serve', async t => {
  const root = await directory(t),
    made = await service(t, root).init(),
    { stat } = await import('node:fs/promises');
  for (const name of ['diffusion_models', 'text_encoders', 'vae', 'loras', 'upscale_models', 'latent_upscale_models'])
    assert.equal((await stat(join(root, 'models', name))).isDirectory(), true, name);

  // An installation of before: its files are where Atelier used to ask for them.
  await mkdir(join(root, 'models', 'LLMs'), { recursive: true });
  await mkdir(join(root, 'models', 'checkpoints'), { recursive: true });
  await checkpoint(join(root, 'models', 'LLMs', 'qwen3.5_9b_int8.safetensors'), MOSS.textEncoder);
  await checkpoint(join(root, 'models', 'checkpoints', 'moss.safetensors'), MOSS.model);
  await checkpoint(join(root, 'models', 'vae', 'flux2-vae.safetensors'), MOSS.vae);
  const picked = async role => basename((await made.assets.pick(role, 'moss')).path);
  assert.equal(await picked('textEncoder'), 'qwen3.5_9b_int8.safetensors');
  assert.equal(await picked('model'), 'moss.safetensors');
  assert.equal(await picked('vae'), 'flux2-vae.safetensors');

  // A ComfyUI chosen in the settings: its files first, Atelier's own after.
  const comfy = join(root, 'ComfyUI', 'models');
  await mkdir(join(comfy, 'text_encoders'), { recursive: true });
  await checkpoint(join(comfy, 'text_encoders', 'qwen3.5_9b_w4a8.safetensors'), MOSS.textEncoder);
  await made.save({ ...made.config, modelsDir: comfy });
  assert.equal(await picked('textEncoder'), 'qwen3.5_9b_w4a8.safetensors');
  assert.equal(await picked('model'), 'moss.safetensors');
});

test('a library moved to another place is found again under the same names, without choosing each file anew', async t => {
  const root = await directory(t),
    before = join(root, 'SwarmUI', 'models'),
    after = join(root, 'Comfy-Desktop', 'models');
  await mkdir(join(before, 'upscale_models'), { recursive: true });
  await mkdir(join(before, 'vae'), { recursive: true });
  // A pickled upscaler, which nothing but its name tells from another, and a VAE.
  const upscaler = join(before, 'upscale_models', 'RealESRGAN_x4plus.pth'),
    vae = await checkpoint(join(before, 'vae', 'flux2-vae.safetensors'), MOSS.vae);
  await writeFile(upscaler, Buffer.alloc(64));
  let models = before;
  const assets = new GenerationAssets(join(root, 'assets.json'), {
    roots: () => [join(models, 'upscale_models'), join(models, 'vae')],
    folder: (family, kind) => (kind === 'vae' ? join(models, 'vae') : join(models, 'upscale_models')),
  });
  const chosen = {
    upscaler: await assets.register({ path: upscaler, kind: 'upscaler', family: 'realesrgan_image' }),
    vae: await assets.register({ path: vae, kind: 'vae', family: 'moss' }),
  };

  // The whole library goes to another installation; the settings follow with one path.
  await mkdir(join(root, 'Comfy-Desktop'));
  const { rename } = await import('node:fs/promises');
  await rename(before, after);
  await assert.rejects(
    assets.resolve(chosen.vae.id, { kind: 'vae', family: 'moss' }),
    error => error.code === 'ENOENT',
  );
  models = after;
  for (const [kind, family] of [
    ['upscaler', 'realesrgan_image'],
    ['vae', 'moss'],
  ]) {
    const found = await assets.resolve(chosen[kind].id, { kind, family });
    assert.equal(found.path.startsWith(after), true, found.path);
    assert.equal(basename(found.path), basename(chosen[kind].path));
    assert.equal(found.id, chosen[kind].id);
    assert.equal(found.automatic, true);
  }
});

test('without ComfyUI the Studio lists the LoRAs of the folder, and Atelier’s engine is given their files', async t => {
  const root = await directory(t),
    made = service(t, root),
    loras = join(root, 'models', 'loras');
  await mkdir(join(loras, 'krea'), { recursive: true });
  await writeFile(join(loras, 'retro.safetensors'), 'x');
  await writeFile(join(loras, 'krea', 'detail.safetensors'), 'x');
  await writeFile(join(loras, 'notes.txt'), 'x');
  // No ComfyUI to ask: the files themselves, named from the folder as ComfyUI names them.
  assert.deepEqual(await made.styles(), [join('krea', 'detail.safetensors'), 'retro.safetensors']);

  const job = { id: 'j', pipeline: 'krea2', loras: [], parameters: {} };
  const styles = [
    { name: 'retro.safetensors', strength: 1 },
    { name: join('krea', 'detail.safetensors'), strength: 1.4 },
  ];
  // Krea 2 takes its LoRAs on Atelier's engine: the styles of the Studio become LoRAs of the job.
  const own = await made.ownJob({ ...job, styles });
  assert.equal(own.styles, undefined);
  assert.deepEqual(own.loras, [
    { id: 'style-0', path: join(loras, 'retro.safetensors'), strength: 1 },
    { id: 'style-1', path: join(loras, 'krea', 'detail.safetensors'), strength: 1.4 },
  ]);
  // A LoRA that is not there, or a name that leaves the folder, is refused in plain words.
  for (const name of ['absent.safetensors', join('..', '..', 'data', 'secret.safetensors')])
    await assert.rejects(
      made.ownJob({ ...job, styles: [{ name, strength: 1 }] }),
      /LoRA introuvable dans le dossier loras/,
    );
  // LTX 2.5 takes them too, after the workflow's own LoRA (the one of its subject references).
  const subject = { id: 'msr', path: join(root, 'msr.safetensors'), strength: 1 };
  const video = await made.ownJob({ id: 'v', pipeline: 'ltx25', loras: [subject], styles });
  assert.equal(video.styles, undefined);
  assert.deepEqual(
    video.loras.map(lora => lora.id),
    ['msr', 'style-0', 'style-1'],
  );
  // A family whose engine applies no style LoRA (MiniMax H3): they are left out.
  const other = await made.ownJob({ id: 'h', pipeline: 'minimax_h3', loras: [], styles });
  assert.deepEqual([other.styles, other.loras], [undefined, []]);
});
