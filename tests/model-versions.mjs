import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { families } from '../lib/families.mjs';
import { versionComponent } from '../lib/model-files.mjs';
import { GenerationService } from '../lib/generation-service.mjs';
import { ModelVersions, isCompanion, recipeOf, versionName, withVersion } from '../lib/model-versions.mjs';
import { NativeWorkflowCatalog, validateNativeWorkflow } from '../lib/native-workflows.mjs';

/**
 * The versions of a model and the rule that picks one, with the workflows Moodix ships and files that
 * say what the user's own said on 19/11 (their names, formats and the shapes that tell them apart).
 * The files here are a few bytes: what reads them is given, as is the registry of the files.
 */
const shippedFolder = fileURLToPath(new URL('../runner/workflows/', import.meta.url));
const shipped = pipeline =>
  readdirSync(shippedFolder)
    .filter(name => name.endsWith('.json'))
    .map(name => validateNativeWorkflow(JSON.parse(readFileSync(join(shippedFolder, name), 'utf8'))))
    .find(workflow => workflow.pipeline === pipeline);

const LTX = {
  'adaln_single.linear.weight': [36864, 4096],
  'transformer_blocks.47.attn1.to_q.weight': [4096, 4096],
  'audio_patchify_proj.weight': [2048, 128],
};
const MINIMAX = {
  adaln_t_table: [1025, 8],
  'blocks.49.attn.qkv_proj.weight': [21504, 5376],
  'audio_patch_proj.weight': [5376, 32],
  'final_layer.video_out.weight': [96, 5376],
};
const GATE = { 'blocks.0.attn.to_gate_compress.weight': [1, 5376] };
const KREA = { 'first.weight': [6144, 64], 'blocks.0.attn.wq.weight': [6144, 6144] };
// The identifier the registry of these tests gives a file: one a workflow takes (letters, digits, dashes).
const assetId = (family, kind, name) => `a-${family}-${kind}-${name}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
const plain = (shapes, format = 'INT8', metadata = {}) => ({ container: 'safetensors', format, shapes, metadata });
// What each file says, by its name.
const SAID = {
  'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors': plain(LTX),
  'ltx25_uncensored_v1.1-int8-convrot.safetensors': plain(LTX),
  'ltx25_uncensored_v1.1-fp8_scaled.safetensors': plain(LTX, 'FP8'),
  'ltx-w4a8.safetensors': plain(LTX, 'W4A8'),
  'ltx-q8.gguf': { container: 'gguf', format: 'GGUF Q8', unread: [], shapes: LTX, metadata: {} },
  'ltx-q3.gguf': { container: 'gguf', format: 'GGUF Q3', unread: ['Q3_K'], shapes: LTX, metadata: {} },
  'deeper.safetensors': plain(LTX),
  'elsewhere.safetensors': plain(LTX, 'BF16'),
  'krea.safetensors': plain(KREA),
  'fasth3_omniref_8step_pruned_int8_convrot.safetensors': plain(
    { ...MINIMAX, ...GATE, 'final_layer.video_out.weight': [3072, 5376] },
    'INT8',
    { source: 'transformer_ref' },
  ),
  'fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors': plain({ ...MINIMAX, ...GATE }),
  'minimax_h3_fl2va_pruned_int8_convrot.safetensors': plain(MINIMAX, 'INT8', { 'modelspec.title': 'minimax_h3_fl2va_pruned_int8_convrot' }),
  'MiniMax_H3_Ref2VA_pruned_int8_convrot.safetensors': plain(MINIMAX, 'INT8', { 'modelspec.title': 'MiniMax_H3_Ref2VA_pruned_int8_convrot' }),
  // The same second file under another name: its title still says what it is.
  'renamed.safetensors': plain(MINIMAX, 'INT8', { 'modelspec.title': 'MiniMax_H3_Ref2VA_pruned_int8_convrot' }),
};

/** A folder of models, the registry of the files and the versions over them. */
async function world(t, files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'moodix-versions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'diffusion_models');
  await mkdir(folder, { recursive: true });
  const put = async (name, bytes = 'x', directory = folder) => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, name), bytes);
    return join(directory, name);
  };
  for (const [name, bytes] of Object.entries(files)) await put(name, bytes);
  const registered = new Map(),
    described = [];
  const assets = {
    folder: (family, kind) => (kind === 'model' ? [folder] : []),
    register: async ({ path, kind, family }) => {
      const id = assetId(family, kind, basename(path));
      registered.set(id, { id, path, kind, family });
      return registered.get(id);
    },
    // A file registered, else the one of that name in the folder (as the files of a shipped workflow are found).
    resolve: async (id, { kind, family, file }) => {
      if (registered.has(id) && existsSync(registered.get(id).path)) return registered.get(id);
      if (file && existsSync(join(folder, file))) return { id, path: join(folder, file), kind, family };
      throw Object.assign(new Error(`Asset ${id} not found`), { status: 400 });
    },
  };
  const statePath = join(root, 'data', 'model-versions.json');
  const versions = new ModelVersions({
    statePath,
    assets,
    describe: async (path, options) => {
      described.push([basename(path), options]);
      if (!SAID[basename(path)]) throw new Error('Invalid safetensors header size');
      return SAID[basename(path)];
    },
  });
  return { root, folder, put, versions, assets, registered, described, statePath, state: async () => JSON.parse(await readFile(statePath, 'utf8')) };
}
const brief = listed => listed.versions.map(version => [version.file, version.source, version.how, version.used]);
const PROVIDED = 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors',
  OWN = 'ltx25_uncensored_v1.1-int8-convrot.safetensors',
  OMNI = 'fasth3_omniref_8step_pruned_int8_convrot.safetensors',
  FAST = 'fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors',
  FL2VA = 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
  REF2VA = 'MiniMax_H3_Ref2VA_pruned_int8_convrot.safetensors';

test('the versions of a model are the files of its folder that are one of it, read where they are (0.6.117)', async t => {
  const ltx = shipped('ltx25'),
    { folder, put, versions, described } = await world(t, {
      [PROVIDED]: 'a'.repeat(40),
      [OWN]: 'b'.repeat(30),
      'ltx-q8.gguf': 'c',
      'ltx-q3.gguf': 'c',
      'ltx-w4a8.safetensors': 'd',
      'krea.safetensors': 'e',
      'broken.safetensors': 'f',
      'notes.txt': 'g',
      'fichier.SAFETENSORS.part': 'h',
    });
  // One level down is looked in (ComfyUI sorts its models into folders), not two; a folder is no file.
  await put('ltx25_uncensored_v1.1-fp8_scaled.safetensors', 'i'.repeat(20), join(folder, 'video'));
  await put('deeper.safetensors', 'j', join(folder, 'video', 'old'));
  await mkdir(join(folder, 'folder.safetensors'));
  const listed = await versions.list(ltx);
  assert.deepEqual([listed.family, listed.role, listed.provided], ['ltx25', 'model', PROVIDED]);
  assert.equal(listed.used, join(folder, PROVIDED));
  // The one used first, then the others by name; another model, a file that cannot be read, a text: none.
  assert.deepEqual(brief(listed), [
    [PROVIDED, 'provided', 'direct', true],
    ['ltx-q3.gguf', 'found', 'refused', false],
    ['ltx-q8.gguf', 'found', 'convert', false],
    ['ltx-w4a8.safetensors', 'found', 'refused', false],
    ['ltx25_uncensored_v1.1-fp8_scaled.safetensors', 'found', 'direct', false],
    [OWN, 'found', 'direct', false],
  ]);
  const [first, q3, , four, scaled] = listed.versions;
  assert.deepEqual(first, { path: join(folder, PROVIDED), file: PROVIDED, name: 'Distillé', format: 'INT8', how: 'direct', bytes: 40, source: 'provided', used: true });
  assert.deepEqual(listed.versions.map(version => version.name).slice(1), ['ltx', 'ltx', 'ltx-w4a8', 'Uncensored v1.1', 'Uncensored v1.1']);
  assert.deepEqual([q3.reason, four.reason, four.format], ['Q3_K', 'W4A8', 'W4A8']);
  assert.deepEqual([scaled.path, scaled.format, scaled.bytes], [join(folder, 'video', 'ltx25_uncensored_v1.1-fp8_scaled.safetensors'), 'FP8', 20]);
  // Each file is read once, with its shapes, while it stays the same; changed, it is read again.
  const reads = () => described.filter(([name]) => name === OWN).length;
  assert.deepEqual(described.find(([name]) => name === OWN)[1], { shapes: true });
  assert.equal(reads(), 1);
  await versions.list(ltx);
  assert.equal(reads(), 1);
  await put(OWN, 'b'.repeat(31));
  assert.equal((await versions.list(ltx)).versions.find(version => version.file === OWN).bytes, 31);
  assert.equal(reads(), 2);
  // A model whose file is a folder, one another program runs, a small tool: no version to choose.
  for (const pipeline of ['acestep15', 'moss', 'rife']) assert.equal(await versions.list(shipped(pipeline)), null, pipeline);
  assert.equal(await versions.list(undefined), null);
  // Nothing of the model on the disk: nothing used, nothing listed (it is to be downloaded).
  const empty = await world(t);
  assert.deepEqual(await empty.versions.list(ltx), { family: 'ltx25', role: 'model', provided: PROVIDED, used: null, versions: [] });
});

test('a model computed in two ways says which by its file, and its second file is part of the version', async t => {
  const minimax = shipped('minimax_h3'),
    { folder, versions } = await world(t, { [OMNI]: 'a', [FAST]: 'b', [FL2VA]: 'c', [REF2VA]: 'd' });
  const listed = await versions.list(minimax);
  // MiniMax's own model in 20 steps, with its file for the reference images; that file is no version.
  assert.deepEqual(
    listed.versions.map(version => [version.file, version.recipe, version.parameters, version.companion?.file, version.used]),
    [
      [OMNI, 'fast', { steps: 8 }, undefined, true],
      [FAST, 'fast', { steps: 8 }, undefined, false],
      [FL2VA, 'full', { steps: 20 }, REF2VA, false],
    ],
  );
  assert.deepEqual(listed.versions[2].companion, { role: 'referenceModel', path: join(folder, REF2VA), file: REF2VA });
  // Without it, the version is there, alone; the second file renamed is still told by its title.
  const alone = await world(t, { [OMNI]: 'a', [FL2VA]: 'c' });
  assert.equal((await alone.versions.list(minimax)).versions.at(-1).companion, undefined);
  const renamed = await world(t, { [FL2VA]: 'c', 'renamed.safetensors': 'd' });
  assert.deepEqual(brief(await renamed.versions.list(minimax)), [[FL2VA, 'found', 'direct', false]]);
  assert.equal((await renamed.versions.list(minimax)).versions[0].companion.file, 'renamed.safetensors');
  // What tells the recipes apart, as the engine reads it (runner/pipelines/minimax_h3.py, steps_of).
  const spec = versionComponent(families().minimax_h3).spec,
    recipe = shapes => recipeOf(spec, { shapes })?.id;
  assert.equal(recipe(MINIMAX), 'full');
  assert.equal(recipe({ ...MINIMAX, ...GATE }), 'fast', 'the gates of FastH3');
  assert.equal(recipe({ ...MINIMAX, 'final_layer.video_out.weight': [3072, 5376] }), 'fast', 'several heads');
  assert.equal(recipe(undefined), 'fast');
  assert.equal(recipeOf(versionComponent(families().ltx25).spec, { shapes: LTX }), null, 'one way only: nothing to tell');
  assert.equal(recipeOf(undefined, { shapes: LTX }), null);
  const full = spec.recipes[0];
  assert.equal(isCompanion(full, { metadata: { 'modelspec.title': 'MiniMax_H3_Ref2VA' } }, 'x.safetensors'), true);
  assert.equal(isCompanion(full, { metadata: {} }, join('models', 'mon_REF2VA.safetensors')), true, 'by its name');
  assert.equal(isCompanion(full, { metadata: { 'modelspec.title': 'minimax_h3_fl2va' } }, 'fl2va.safetensors'), false);
  assert.equal(isCompanion(full, undefined, join('ref2va', 'fl2va.safetensors')), false, 'not by its folder');
  assert.equal(isCompanion(spec.recipes[1], { metadata: {} }, 'ref2va.safetensors'), false, 'a recipe in one file');
  assert.equal(isCompanion(null, {}, 'ref2va.safetensors'), false);
});

test('Moodix uses the provided version; a version picked is kept, and its file gone gives the provided one back', async t => {
  const ltx = shipped('ltx25'),
    { folder, put, versions, registered, state, statePath } = await world(t, { [PROVIDED]: 'a', [OWN]: 'b', 'ltx-q8.gguf': 'c', 'ltx-w4a8.safetensors': 'd' });
  const own = join(folder, OWN);
  // Nothing chosen: the workflow as shipped, the very object, and no file of choices.
  assert.equal(await versions.applied(ltx), ltx);
  assert.equal(existsSync(statePath), false);
  // Picked: said used, kept on the disk, registered as any file of a workflow.
  const picked = await versions.use(ltx, own);
  assert.deepEqual(brief(picked).slice(0, 2), [[OWN, 'found', 'direct', true], [PROVIDED, 'provided', 'direct', false]]);
  assert.equal(picked.used, own);
  assert.deepEqual(await state(), { schemaVersion: 1, used: { ltx25: { path: own, asset: assetId('ltx25', 'model', OWN) } }, added: {} });
  assert.deepEqual(registered.get(assetId('ltx25', 'model', OWN)), { id: assetId('ltx25', 'model', OWN), path: own, kind: 'model', family: 'ltx25' });
  // The workflow is made with it: its file, nothing else changed, and another digest.
  const made = await versions.applied(ltx);
  assert.deepEqual(made.components.model, { policy: 'fixed', asset: assetId('ltx25', 'model', OWN), file: OWN });
  assert.notEqual(made.digest, ltx.digest);
  const { components, digest, ...rest } = made,
    { components: before, digest: old, ...same } = ltx;
  assert.deepEqual(rest, same);
  assert.deepEqual({ ...components, model: before.model }, before);
  assert.equal(ltx.components.model.file, PROVIDED, 'the shipped workflow is not written to');
  // Read by another object over the same file (the application started again).
  const again = new ModelVersions({ statePath, assets: versions.assets, describe: versions.describe });
  assert.equal((await again.applied(ltx)).components.model.file, OWN);
  // Its file gone: the provided one again, and it is said so; back, it is used again.
  await rm(own);
  assert.equal(await versions.applied(ltx), ltx);
  assert.deepEqual(brief(await versions.list(ltx))[0], [PROVIDED, 'provided', 'direct', true]);
  await put(OWN, 'b');
  assert.equal((await versions.applied(ltx)).components.model.file, OWN);
  // The provided one picked again: nothing kept any more.
  const back = await versions.use(ltx, join(folder, PROVIDED));
  assert.deepEqual(brief(back)[0], [PROVIDED, 'provided', 'direct', true]);
  assert.deepEqual((await state()).used, {});
  assert.equal(await versions.applied(ltx), ltx);
  // What cannot be used is said in the user's words, and nothing is kept.
  await assert.rejects(versions.use(ltx, join(folder, 'ltx-q8.gguf')), { status: 409, message: 'ltx-q8.gguf est un GGUF : il se convertit avant de servir.' });
  await assert.rejects(versions.use(ltx, join(folder, 'ltx-w4a8.safetensors')), { status: 400, message: 'ltx-w4a8.safetensors ne se lit pas avec LTX 2.5 (W4A8).' });
  await assert.rejects(versions.use(ltx, join(folder, 'absent.safetensors')), { status: 404, message: 'Cette version n’est plus sur cet ordinateur.' });
  await assert.rejects(versions.use(shipped('acestep15'), own), { status: 400, message: 'Musique (ACE-Step 1.5 XL) n’a pas de version à choisir.' });
  assert.deepEqual((await state()).used, {});
  // A file of choices that cannot be read is no choice.
  await writeFile(statePath, '{"used":');
  assert.equal(await versions.applied(ltx), ltx);
  await writeFile(statePath, JSON.stringify({ used: { ltx25: { path: own }, krea2: 'x' }, added: { ltx25: 'x', krea2: [3, ''] } }));
  assert.equal(await versions.applied(ltx), ltx, 'a choice without its registered file');
  assert.deepEqual(brief(await versions.list(ltx))[0], [PROVIDED, 'provided', 'direct', true]);
});

test('the recipe of the version picked is set in the workflow, with its second file', async t => {
  const minimax = shipped('minimax_h3'),
    { folder, versions, state } = await world(t, { [OMNI]: 'a', [FAST]: 'b', [FL2VA]: 'c', [REF2VA]: 'd' });
  assert.deepEqual([minimax.parameters.steps.value, minimax.profiles.draft.parameters.steps, minimax.components.referenceModel], [8, 8, undefined]);
  await versions.use(minimax, join(folder, FL2VA));
  assert.deepEqual((await state()).used.minimax_h3, {
    path: join(folder, FL2VA),
    asset: assetId('minimax_h3', 'model', FL2VA),
    parameters: { steps: 20 },
    companion: { role: 'referenceModel', asset: assetId('minimax_h3', 'referenceModel', REF2VA), path: join(folder, REF2VA) },
  });
  const base = await versions.applied(minimax);
  assert.deepEqual(base.components.model, { policy: 'fixed', asset: assetId('minimax_h3', 'model', FL2VA), file: FL2VA });
  assert.deepEqual(base.components.referenceModel, { policy: 'fixed', asset: assetId('minimax_h3', 'referenceModel', REF2VA), file: REF2VA });
  // 20 steps wherever the workflow says its steps: 8 of a model made for 20 give a blurred video.
  assert.deepEqual(base.parameters.steps, { policy: 'fixed', value: 20 });
  assert.deepEqual(Object.values(base.profiles).map(profile => profile.parameters.steps), [20, 20]);
  assert.equal(base.profiles.final.parameters.width, minimax.profiles.final.parameters.width);
  // Its second file gone: the version without it (the engine then says it takes no reference).
  await rm(join(folder, REF2VA));
  const alone = await versions.applied(minimax);
  assert.deepEqual([alone.components.model.file, alone.components.referenceModel, alone.parameters.steps.value], [FL2VA, undefined, 20]);
  // The other distilled one: its 8 steps, and no file for the references left from before.
  await versions.use(minimax, join(folder, FAST));
  const fast = await versions.applied(minimax);
  assert.deepEqual([fast.components.model.file, fast.components.referenceModel, fast.parameters.steps.value], [FAST, undefined, 8]);
  assert.deepEqual((await state()).used.minimax_h3, { path: join(folder, FAST), asset: assetId('minimax_h3', 'model', FAST), parameters: { steps: 8 } });
});

test('a version of a workflow: its file, what its recipe sets, the second files emptied first', () => {
  const minimax = shipped('minimax_h3');
  const held = validateNativeWorkflow({
    ...minimax,
    components: { ...minimax.components, referenceModel: { policy: 'fixed', asset: 'old', file: 'old.safetensors' } },
    // (A setting left to the assistant takes the value as its default.)
    parameters: { ...minimax.parameters, steps: { policy: 'model', default: 8 } },
  });
  const made = withVersion(held, { role: 'model', asset: 'a', file: 'a.safetensors', parameters: { steps: 20, unknown: 3 }, companions: ['referenceModel'] });
  assert.deepEqual([made.components.model, made.components.referenceModel], [{ policy: 'fixed', asset: 'a', file: 'a.safetensors' }, undefined]);
  assert.deepEqual(made.parameters.steps, { policy: 'model', default: 20 });
  assert.equal('unknown' in made.parameters, false);
  assert.equal(held.components.referenceModel.file, 'old.safetensors', 'the workflow given is not changed');
  // Nothing set, no second file named: only the file changes.
  const bare = withVersion(held, { role: 'model', asset: 'b', file: 'b.safetensors' });
  assert.deepEqual([bare.components.referenceModel.file, bare.parameters.steps, bare.profiles], ['old.safetensors', held.parameters.steps, held.profiles]);
  const second = withVersion(minimax, { role: 'model', asset: 'a', file: 'a.safetensors', companion: { role: 'referenceModel', asset: 'r', file: 'r.safetensors' } });
  assert.deepEqual(second.components.referenceModel, { policy: 'fixed', asset: 'r', file: 'r.safetensors' });
  // What the family does not take is refused as in any workflow.
  assert.throws(() => withVersion(minimax, { role: 'model', asset: 'a', file: 'a.safetensors', parameters: { steps: 12 } }));
});

test('a file added from elsewhere is a version, read where it is; one the model does not read is refused by name', async t => {
  const ltx = shipped('ltx25'),
    { root, folder, put, versions, state } = await world(t, { [PROVIDED]: 'a' });
  const elsewhere = await put('elsewhere.safetensors', 'x'.repeat(9), join(root, 'ailleurs')),
    packed = await put('ltx-q8.gguf', 'y', join(root, 'ailleurs'));
  const added = await versions.add(ltx, elsewhere);
  assert.deepEqual(brief(added), [[PROVIDED, 'provided', 'direct', true], ['elsewhere.safetensors', 'added', 'direct', false]]);
  assert.deepEqual([added.versions[1].path, added.versions[1].format, added.versions[1].bytes], [elsewhere, 'BF16', 9]);
  assert.deepEqual((await state()).added, { ltx25: [elsewhere] });
  assert.equal(existsSync(join(folder, 'elsewhere.safetensors')), false, 'nothing is copied');
  // Twice is once; a GGUF is added too (it is converted before it is used).
  await versions.add(ltx, elsewhere);
  await versions.add(ltx, packed);
  assert.deepEqual((await state()).added.ltx25, [elsewhere, packed]);
  assert.deepEqual(brief(await versions.list(ltx)).at(-1), ['ltx-q8.gguf', 'added', 'convert', false]);
  // A file already in the folder of the models is found there: said found, not added twice.
  await versions.add(ltx, await put(OWN, 'b'));
  assert.deepEqual(brief(await versions.list(ltx)).filter(([file]) => file === OWN), [[OWN, 'found', 'direct', false]]);
  // Used, then taken out of the list: the provided one again, and the file is still there.
  await versions.use(ltx, elsewhere);
  assert.equal((await versions.applied(ltx)).components.model.file, 'elsewhere.safetensors');
  const left = await versions.remove(ltx, elsewhere);
  assert.deepEqual(brief(left).map(([file]) => file), [PROVIDED, 'ltx-q8.gguf', OWN]);
  assert.deepEqual([(await state()).used, existsSync(elsewhere)], [{}, true]);
  assert.equal(await versions.applied(ltx), ltx);
  // Taking out the last one added leaves no empty list; one that was not added changes nothing.
  await versions.remove(ltx, packed);
  await versions.remove(ltx, join(root, 'jamais-ajouté.safetensors'));
  assert.deepEqual((await state()).added, { ltx25: [join(folder, OWN)] });
  // Refused with a line that names the file (maquette, capture 67): another model, a file that is
  // none, a file that is not there, a format the model does not read.
  for (const [name, message] of [
    ['krea.safetensors', 'krea.safetensors ne se lit pas avec LTX 2.5.'],
    ['broken.safetensors', 'broken.safetensors ne se lit pas avec LTX 2.5.'],
    ['ltx-w4a8.safetensors', 'ltx-w4a8.safetensors ne se lit pas avec LTX 2.5 (W4A8).'],
    ['ltx-q3.gguf', 'ltx-q3.gguf ne se lit pas avec LTX 2.5 (Q3_K).'],
  ])
    await assert.rejects(versions.add(ltx, await put(name, 'z', join(root, 'ailleurs'))), { status: 400, message }, name);
  await assert.rejects(versions.add(ltx, join(root, 'absent.safetensors')), { message: 'absent.safetensors ne se lit pas avec LTX 2.5.' });
  await assert.rejects(versions.add(ltx, join(root, 'ailleurs')), { message: 'ailleurs ne se lit pas avec LTX 2.5.' });
  await assert.rejects(versions.add(shipped('rife'), elsewhere), { message: 'Interpoler (RIFE 4.26) n’a pas de version à choisir.' });
  assert.equal(await versions.remove(shipped('rife'), elsewhere), null);
  assert.deepEqual((await state()).added, { ltx25: [join(folder, OWN)] });
  // Taking another file out leaves the one used; the last one out leaves no empty list.
  // (The provided version comes right after the one used, whatever their names.)
  await versions.add(ltx, elsewhere);
  await versions.use(ltx, join(folder, OWN));
  assert.deepEqual(brief(await versions.list(ltx)).map(([file]) => file), [OWN, PROVIDED, 'elsewhere.safetensors']);
  await versions.remove(ltx, elsewhere);
  assert.equal((await state()).used.ltx25.path, join(folder, OWN));
  await versions.remove(ltx, join(folder, OWN));
  assert.deepEqual(await state(), { schemaVersion: 1, used: {}, added: {} });
});

test('the catalog lists a shipped workflow as made with the version kept, and leaves one the user edited as written', async t => {
  const { root, folder, versions } = await world(t, { [OMNI]: 'a', [FL2VA]: 'c', [REF2VA]: 'd' });
  const own = join(root, 'workflow');
  await mkdir(own);
  const catalog = () => new NativeWorkflowCatalog(own, { assets: versions.assets, builtin: shippedFolder, statePath: join(root, 'state.json'), versions });
  const minimax = shipped('minimax_h3');
  assert.deepEqual(await catalog().read(minimax.id), minimax, 'nothing kept: as shipped');
  await versions.use(minimax, join(folder, FL2VA));
  const listed = await catalog().read(minimax.id);
  assert.deepEqual([listed.components.model.file, listed.components.referenceModel.file, listed.parameters.steps.value], [FL2VA, REF2VA, 20]);
  assert.equal((await catalog().list()).find(workflow => workflow.id === minimax.id).components.model.file, FL2VA);
  // The other workflows are as shipped, and without `versions` the catalog is the one of before.
  assert.deepEqual(await catalog().read(shipped('ltx25').id), shipped('ltx25'));
  const plainCatalog = new NativeWorkflowCatalog(own, { assets: versions.assets, builtin: shippedFolder, statePath: join(root, 'state.json') });
  assert.deepEqual(await plainCatalog.read(minimax.id), minimax);
  // As shipped, whatever is kept; a workflow Moodix does not ship has none.
  assert.deepEqual(await catalog().shippedOf(minimax.id), minimax);
  assert.equal(await catalog().shippedOf('workflow-de-personne'), null);
  // Edited by the user (« Réglages »): theirs, file and steps as they wrote them. The editor has the last word.
  const { digest, ...stored } = minimax;
  await writeFile(join(own, minimax.id + '.json'), JSON.stringify({ ...stored, description: 'Le mien.' }));
  const edited = await catalog().read(minimax.id);
  assert.deepEqual([edited.description, edited.components.model.file, edited.parameters.steps.value, edited.components.referenceModel], ['Le mien.', OMNI, 8, undefined]);
  assert.deepEqual(await catalog().shippedOf(minimax.id), minimax);
  // The version it reads is the one said used, wherever it was chosen.
  const shown = await versions.list(minimax, { effective: edited });
  assert.deepEqual(brief(shown)[0], [OMNI, 'provided', 'direct', true]);
});

test('the application keeps the versions in data/model-versions.json, and its catalog reads them', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moodix-versions-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data'),
    file = join(root, 'models', OWN),
    ltx = shipped('ltx25');
  await mkdir(join(root, 'models'), { recursive: true });
  await mkdir(dataDir);
  await writeFile(file, 'x');
  const service = () =>
    new GenerationService({ root, dataDir, workflowDir: join(root, 'workflow'), builtinWorkflowDir: shippedFolder, outputDir: join(root, 'output'), worker: {}, environment: {} });
  assert.deepEqual(await service().catalog.read(ltx.id), ltx, 'nothing kept: as shipped');
  await writeFile(join(dataDir, 'model-versions.json'), JSON.stringify({ schemaVersion: 1, used: { ltx25: { path: file, asset: 'mon-ltx' } }, added: {} }));
  const made = await service().catalog.read(ltx.id);
  assert.deepEqual(made.components.model, { policy: 'fixed', asset: 'mon-ltx', file: OWN });
  assert.ok(service().versions instanceof ModelVersions);
});

test('a version is named without its model, its format or how it was made; a file its family knows, by the name it gives it', () => {
  const name = (family, file) => versionName(file, families()[family]);
  // The files of the user's folder (19/11).
  for (const [family, file, expected] of [
    ['ltx25', 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors', 'Distillé'],
    ['ltx25', 'ltx25_uncensored_v1.1-int8-convrot.safetensors', 'Uncensored v1.1'],
    ['ltx25', 'ltx25_uncensored_v1.1-fp8_scaled.safetensors', 'Uncensored v1.1'],
    ['minimax_h3', OMNI, 'Omni'],
    ['minimax_h3', FAST, 'FastH3 v2'],
    ['minimax_h3', FL2VA, 'De base'],
    ['seedvr2', 'seedvr2_7b_sharp_fp8_e4m3fn.safetensors', '7B Sharp'],
    ['seedvr2', 'seedvr2_7b_int8_convrot.safetensors', '7B'],
    ['seedvr2', 'seedvr2_ema_7b_sharp_fp8_e4m3fn.safetensors', '7B EMA Sharp'],
    ['seedvr2', 'seedvr2_ema_7b_fp16.safetensors', '7B EMA'],
    ['krea2', 'krea2TurboOfficialComfy_krea2TurboInt8.safetensors', 'Turbo'],
    ['wan_scail2', 'wan2.1_14B_SCAIL_2_int8_convrot.safetensors', 'De base'],
    // One nobody described: its name less the model, the format, the steps, the mark of a GGUF.
    ['ltx25', join('D:', 'modeles', 'LTX-2.5_mon-essai_8steps_pruned.safetensors'), 'Mon essai'],
    ['ltx25', 'mon-modele.Q8_0.gguf', 'Mon modele'],
    ['ltx25', 'cinema-Q4_K_M.gguf', 'Cinema'],
    ['krea2', 'krea2_portraits_v3_bf16.safetensors', 'Portraits v3'],
    ['ltx25', 'ltx25_22b_cine_convrot.safetensors', 'Cine'],
    // Nothing left: the whole name.
    ['ltx25', 'ltx25-int8.safetensors', 'ltx25-int8'],
    // A merge of the two files of MiniMax is neither the base model…
    ['minimax_h3', 'minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors', 'Hybrid fl2va ref2va b25 49'],
  ])
    assert.equal(name(family, file), expected, file);
  // … nor its second file.
  const full = versionComponent(families().minimax_h3).spec.recipes[0];
  assert.equal(isCompanion(full, { metadata: {} }, 'minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors'), false);
  assert.equal(isCompanion(full, { metadata: { 'modelspec.title': 'hybrid_fl2va_ref2va' } }, 'x.safetensors'), false);
  assert.equal(versionName('portraits_int8.safetensors', undefined), 'Portraits');
});

test('the page « Modèles » is given one line a model, in its order, and a choice made there is kept (0.6.118)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moodix-models-page-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'models', 'diffusion_models'),
    own = join(root, 'workflow');
  await mkdir(folder, { recursive: true });
  await mkdir(join(root, 'data'));
  for (const name of [PROVIDED, OWN, OMNI, FL2VA, REF2VA]) await writeFile(join(folder, name), 'x');
  const service = new GenerationService({ root, dataDir: join(root, 'data'), workflowDir: own, builtinWorkflowDir: shippedFolder, outputDir: join(root, 'output'), worker: {}, environment: {} });
  // The files of this test are a few bytes: what reads them and the registry of the files are given.
  const registered = new Map();
  Object.assign(service.assets, {
    folder: (family, kind) => (kind === 'model' ? [folder] : []),
    register: async ({ path, kind, family }) => {
      const id = assetId(family, kind, basename(path));
      registered.set(id, { id, path, kind, family });
      return registered.get(id);
    },
    read: async id => registered.get(id) ?? Promise.reject(new Error(`Asset ${id} not found`)),
    resolve: async (id, { kind, family, file }) => {
      if (registered.has(id)) return registered.get(id);
      if (!['model', 'referenceModel'].includes(kind) || existsSync(join(folder, file))) return { id, path: join(folder, file ?? id), kind, family };
      throw Object.assign(new Error(`Asset ${id} not found`), { status: 400 });
    },
  });
  service.versions.describe = async path => SAID[basename(path)] ?? Promise.reject(new Error('unreadable'));
  const lines = await service.models();
  assert.deepEqual(
    lines.map(line => [line.group, line.name, line.does]),
    [
      ['image', 'Krea 2', 'Photos, illustrations, retouche d’une image.'],
      ['image', 'MOSS Image', 'Affiches, mises en page, texte dans l’image.'],
      ['video', 'LTX 2.5', 'Vidéos et prolongations.'],
      ['video', 'MiniMax H3', 'Vidéos de 5 à 15 s, avec le son.'],
      ['video', 'Wan 2.1 SCAIL-2', 'Remplacer un personnage dans une vidéo.'],
      ['audio', 'ACE-Step 1.5', 'Musique, avec ou sans paroles.'],
      ['audio', 'MOSS-SoundEffect v2', 'Bruitages.'],
      ['retouch', 'SeedVR2', 'Agrandir et affiner une image.'],
      ['retouch', 'Real-ESRGAN', 'Agrandir une image ou une vidéo.'],
      ['retouch', 'RIFE', 'Interpoler une vidéo.'],
    ],
  );
  const line = name => lines.find(item => item.name === name),
    ltx = shipped('ltx25'),
    minimax = shipped('minimax_h3');
  // A model whose file is one to choose comes with its versions; another with the name of the one it has.
  assert.deepEqual(line('LTX 2.5').workflows.map(({ id, family, provided, used }) => [id, family, provided, used]), [[ltx.id, 'ltx25', PROVIDED, join(folder, PROVIDED)]]);
  assert.deepEqual(line('LTX 2.5').workflows[0].versions.map(version => [version.name, version.format, version.used]), [['Distillé', 'INT8', true], ['Uncensored v1.1', 'INT8', false]]);
  assert.deepEqual(line('MiniMax H3').workflows[0].versions.map(version => [version.name, version.parameters.steps]), [['Omni', 8], ['De base', 20]]);
  assert.deepEqual(line('ACE-Step 1.5').workflows, [{ id: shipped('acestep15').id, family: 'acestep15', version: 'XL' }]);
  assert.deepEqual(line('Krea 2').workflows[0].versions, [], 'none of its files here: to download');
  // Real-ESRGAN is one model in two workflows: images, videos.
  assert.deepEqual(line('Real-ESRGAN').workflows.map(({ family, version }) => [family, version]).sort(), [['realesrgan_image', '×4 Plus'], ['realesrgan_video', '×2 Plus']]);

  // A version picked for a workflow as shipped: kept beside it.
  await service.useVersion(ltx.id, join(folder, OWN));
  assert.equal((await service.catalog.read(ltx.id)).components.model.file, OWN);
  assert.equal((await service.models()).find(item => item.name === 'LTX 2.5').workflows[0].used, join(folder, OWN));
  assert.equal(existsSync(join(own, ltx.id + '.json')), false, 'no copy of the workflow is written');
  // For a workflow the user edited: written into theirs, with what they wrote.
  const { digest, ...stored } = minimax;
  await mkdir(own, { recursive: true });
  await writeFile(join(own, minimax.id + '.json'), JSON.stringify({ ...stored, description: 'Le mien.' }));
  await service.useVersion(minimax.id, join(folder, FL2VA));
  const theirs = JSON.parse(await readFile(join(own, minimax.id + '.json'), 'utf8'));
  assert.deepEqual([theirs.description, theirs.components.model.file, theirs.components.referenceModel.file, theirs.parameters.steps.value, theirs.profiles.draft.parameters.steps], ['Le mien.', FL2VA, REF2VA, 20, 20]);
  assert.deepEqual([theirs.components.model.asset, theirs.components.referenceModel.asset], [assetId('minimax_h3', 'model', FL2VA), assetId('minimax_h3', 'referenceModel', REF2VA)]);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(root, 'data', 'model-versions.json'), 'utf8')).used), ['ltx25']);
  assert.equal((await service.models()).find(item => item.name === 'MiniMax H3').workflows[0].used, join(folder, FL2VA));
  // A workflow created or imported by the user (before this page) is no line, and no model to choose a version of.
  await writeFile(join(own, 'mon-ltx.json'), JSON.stringify({ ...stored, id: 'mon-ltx', name: 'Mon MiniMax' }));
  assert.equal((await service.catalog.list()).some(workflow => workflow.id === 'mon-ltx'), true);
  assert.equal((await service.models()).flatMap(item => item.workflows).some(workflow => workflow.id === 'mon-ltx'), false);
  await assert.rejects(service.useVersion('mon-ltx', join(folder, OMNI)), { status: 404, message: 'Ce modèle n’est pas fourni avec Moodix.' });
  for (const [id, path] of [[ltx.id, ''], [ltx.id, undefined], [undefined, join(folder, OWN)], [7, join(folder, OWN)]])
    await assert.rejects(service.useVersion(id, path), { status: 400, message: 'Version invalide.' });
  await assert.rejects(service.useVersion(ltx.id, join(folder, 'absent.safetensors')), { status: 404 });
});
