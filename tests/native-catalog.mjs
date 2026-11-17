import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { NativeWorkflowCatalog, workflowFingerprint } from '../lib/native-workflows.mjs';

const shippedFile = new URL('../runner/workflows/5e1b8c3a-9d2f-4a6e-b7c4-1f0d6e3a9b85.json', import.meta.url);
const assets = { resolve: async id => ({ path: join(tmpdir(), id) }), read: async () => null };

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'atelier-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const builtin = join(root, 'shipped'),
    user = join(root, 'workflow');
  await mkdir(builtin);
  const original = JSON.parse(await readFile(shippedFile, 'utf8'));
  const ship = async workflow => writeFile(join(builtin, workflow.id + '.json'), JSON.stringify(workflow));
  await ship(original);
  const catalog = new NativeWorkflowCatalog(user, {
    assets,
    capabilities: { realesrgan_image: true },
    builtin,
    statePath: join(root, 'data', 'workflow-natives.json'),
    historyPath: join(root, 'history.json'),
  });
  const names = async () => (await catalog.list()).map(item => [item.name, item.builtin ?? false, item.customized ?? false, item.update ?? false]);
  return { root, builtin, user, catalog, original, ship, names };
}

test('a shipped workflow is listed ready, and saving it unchanged keeps it shipped', async t => {
  const f = await setup(t);
  const [listed] = await f.catalog.list();
  assert.equal(listed.id, f.original.id);
  assert.equal(listed.builtin, true);
  assert.equal(listed.ready, true);
  assert.equal((await f.catalog.read(f.original.id)).name, f.original.name);
  // Opened and saved without a change (the editor adds empty descriptions): nothing of the user's.
  const same = structuredClone(f.original);
  same.references[0].description = '';
  await f.catalog.save(same);
  await assert.rejects(readdir(f.user), { code: 'ENOENT' });
  assert.deepEqual(await f.names(), [[f.original.name, true, false, false]]);
});

test('an update never replaces an edited workflow: its new version is listed beside it as V2', async t => {
  const f = await setup(t);
  await f.catalog.save({ ...f.original, description: 'Mon réglage à moi.' });
  assert.deepEqual(await f.names(), [[f.original.name, true, true, false]]);
  // The update ships a new version of the same workflow.
  await f.ship({ ...f.original, description: 'Nouvelle version fournie.' });
  assert.deepEqual(await f.names(), [
    [f.original.name, true, true, false],
    [f.original.name + ' V2', true, false, true],
  ]);
  const listed = await f.catalog.list();
  assert.equal((await f.catalog.read(f.original.id)).description, 'Mon réglage à moi.');
  const update = listed.find(item => item.update);
  assert.notEqual(update.id, f.original.id);
  assert.equal((await f.catalog.read(update.id)).description, 'Nouvelle version fournie.');
  // Its identity is stable from one listing to the next (conversations keep pointing at it).
  assert.equal((await f.catalog.list()).find(item => item.update).id, update.id);
  const prepared = await f.catalog.prepare(update.id, { references: [{ input: 'source', image: 0 }] }, { allowPendingReferences: true });
  assert.equal(prepared.workflow.id, update.id);
});

test('a shipped workflow named like one of the user’s becomes V2, then V3', async t => {
  const f = await setup(t);
  const mine = id => ({ ...f.original, id, description: 'À moi.' });
  await f.catalog.save(mine('mine-1'));
  assert.deepEqual(await f.names(), [
    [f.original.name, false, false, false],
    [f.original.name + ' V2', true, false, false],
  ]);
  await f.catalog.save({ ...mine('mine-2'), name: f.original.name + ' V2' });
  assert.equal((await f.names()).at(-1)[0], f.original.name + ' V3');
  assert.equal((await f.catalog.read(f.original.id)).name, f.original.name + ' V3');
});

test('a deleted shipped workflow stays hidden until an update changes it, and can be shown again', async t => {
  const f = await setup(t);
  await f.catalog.remove(f.original.id);
  assert.deepEqual(await f.names(), []);
  assert.equal(await f.catalog.hiddenCount(), 1);
  await f.catalog.unhide();
  assert.equal((await f.names()).length, 1);
  await f.catalog.remove(f.original.id);
  await f.ship({ ...f.original, description: 'Nouvelle version fournie.' });
  assert.deepEqual(await f.names(), [[f.original.name, true, false, false]]);
  // Never written to: an update replaces that folder.
  assert.deepEqual(await readdir(f.builtin), [f.original.id + '.json']);
});

test('an edited shipped workflow can be restored, or deleted with its original', async t => {
  const f = await setup(t);
  await f.catalog.save({ ...f.original, description: 'Mon réglage à moi.' });
  await f.catalog.reset(f.original.id);
  assert.deepEqual(await f.names(), [[f.original.name, true, false, false]]);
  await assert.rejects(f.catalog.reset(f.original.id), /fourni et modifié/);
  await f.catalog.save({ ...f.original, description: 'Mon réglage à moi.' });
  await f.catalog.remove(f.original.id);
  assert.deepEqual(await f.names(), []);
  assert.deepEqual(await readdir(f.user), []);
});

test('copies left by older versions: unedited ones go, edited ones stay without a V2', async t => {
  const f = await setup(t);
  await mkdir(f.user);
  const old = { ...f.original, description: 'Version livrée autrefois.' };
  await writeFile(
    f.root + '/history.json',
    JSON.stringify({ workflows: { [f.original.id]: [workflowFingerprint(old)] } }),
  );
  await writeFile(join(f.user, f.original.id + '.json'), JSON.stringify(old));
  assert.deepEqual(await f.catalog.adoptShipped(), { removed: [f.original.id], kept: [] });
  assert.deepEqual(await f.names(), [[f.original.name, true, false, false]]);
  await writeFile(join(f.user, f.original.id + '.json'), JSON.stringify({ ...f.original, description: 'Édité.' }));
  assert.deepEqual(await f.catalog.adoptShipped(), { removed: [], kept: [f.original.id] });
  assert.deepEqual(await f.names(), [[f.original.name, true, true, false]]);
});

test('Krea 2 at a denoise of 0.75 reaches the installed copies: an untouched one follows, an edited one is kept', async t => {
  const id = 'fefb88eb-8311-4409-b636-6efbb42e952c';
  const current = JSON.parse(await readFile(new URL(`../runner/workflows/${id}.json`, import.meta.url), 'utf8'));
  // The version shipped before: the same workflow at a denoise of 1 (the image to modify was ignored).
  const before = structuredClone(current);
  before.parameters.denoise.value = 1;
  const historyPath = new URL('../runner/workflow-history.json', import.meta.url);
  const versions = JSON.parse(await readFile(historyPath, 'utf8')).workflows[id];
  assert.equal(current.parameters.denoise.value, 0.75);
  assert.ok(versions.includes(workflowFingerprint(before)), 'the version before is in the history');
  assert.equal(versions.at(-1), workflowFingerprint(current));
  const root = await mkdtemp(join(tmpdir(), 'atelier-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const builtin = join(root, 'shipped'),
    user = join(root, 'workflow');
  await mkdir(builtin);
  await mkdir(user);
  const ship = workflow => writeFile(join(builtin, id + '.json'), JSON.stringify(workflow));
  const catalog = new NativeWorkflowCatalog(user, {
    assets,
    capabilities: { krea2: true },
    builtin,
    statePath: join(root, 'data', 'workflow-natives.json'),
    historyPath: fileURLToPath(historyPath),
  });
  const denoise = async key => (await catalog.read(key)).parameters.denoise.value;
  await ship(current);
  // A copy an earlier version left in the user's folder, never edited: it goes, and the workflow is the new one.
  await writeFile(join(user, id + '.json'), JSON.stringify(before));
  assert.deepEqual(await catalog.adoptShipped(), { removed: [id], kept: [] });
  assert.deepEqual(await readdir(user), []);
  assert.equal(await denoise(id), 0.75);
  // The same copy with a change of the user's: kept as it is, at their denoise.
  await writeFile(join(user, id + '.json'), JSON.stringify({ ...before, description: 'Mon Krea.' }));
  assert.deepEqual(await catalog.adoptShipped(), { removed: [], kept: [id] });
  assert.equal(await denoise(id), 1);
  assert.equal((await catalog.read(id)).description, 'Mon Krea.');
  // Edited from the settings while 1 was shipped: the update never replaces it, and lists the new
  // version beside it (« Krea 2 V2 »).
  await catalog.reset(id);
  await ship(before);
  await catalog.save({ ...before, description: 'Mon Krea.' });
  await ship(current);
  const listed = await catalog.list();
  assert.deepEqual(
    listed.map(item => [item.name, item.customized ?? false, item.update ?? false, item.parameters.denoise.value]),
    [
      [current.name, true, false, 1],
      [current.name + ' V2', false, true, 0.75],
    ],
  );
  // Never written to: an update replaces that folder.
  assert.deepEqual(await readdir(builtin), [id + '.json']);
});

test('a workflow whose file is missing is listed unavailable, in words', async t => {
  const f = await setup(t);
  f.catalog.assets = { resolve: async () => { throw Object.assign(new Error('Asset x not found'), {}); } };
  const [listed] = await f.catalog.list();
  assert.equal(listed.ready, false);
  assert.match(listed.unavailableReason, /Fichier introuvable pour « .+ » \(RealESRGAN_x4plus\.pth\)/);
});

test('updates deliver the shipped workflows and never touch the user folder', async () => {
  const { managedRoots } = await import('../lib/update-archive.mjs');
  const { validateNativeWorkflow } = await import('../lib/native-workflows.mjs');
  assert.ok(managedRoots.has('runner'), 'runner/workflows/ comes with every update');
  assert.ok(!managedRoots.has('workflow'), 'workflow/ is the user’s');
  const folder = new URL('../runner/workflows/', import.meta.url);
  const names = (await readdir(folder)).filter(name => name.endsWith('.json'));
  assert.ok(names.length >= 7);
  const history = JSON.parse(await readFile(new URL('../runner/workflow-history.json', import.meta.url), 'utf8'));
  const seen = new Set();
  for (const name of names) {
    const workflow = validateNativeWorkflow(JSON.parse(await readFile(new URL(name, folder), 'utf8')));
    assert.equal(workflow.id + '.json', name);
    assert.ok(!seen.has(workflow.name.toLowerCase()), 'two shipped workflows share the name ' + workflow.name);
    seen.add(workflow.name.toLowerCase());
    // Every shipped component names its file, so another installation finds it.
    for (const policy of Object.values(workflow.components))
      if (policy.policy === 'fixed') assert.ok(policy.file, `${workflow.name}: a component without its file name`);
    assert.ok(history.workflows[workflow.id]?.includes(workflowFingerprint(workflow)), workflow.name + ' missing from the history');
  }
});

test('every file of a shipped workflow has its source: a missing one offers its download', async () => {
  const { readFile: read, readdir: list } = await import('node:fs/promises');
  const folder = new URL('../runner/workflows/', import.meta.url);
  const catalog = JSON.parse(await read(new URL('../runner/downloads.json', import.meta.url), 'utf8'));
  const missing = [];
  for (const name of (await list(folder)).filter(file => file.endsWith('.json'))) {
    const workflow = JSON.parse(await read(new URL(name, folder), 'utf8'));
    for (const [role, policy] of Object.entries(workflow.components ?? {}))
      if (policy?.policy === 'fixed' && policy.file && !catalog[policy.file])
        missing.push(`${workflow.name} · ${role} · ${policy.file}`);
  }
  // Wan 2.1 SCAIL-2 was shipped without them: no « Télécharger » on another computer.
  assert.deepEqual(missing, []);
});

test('every source names its licence, as the table of the notices gives it; one with conditions says its limits', async () => {
  const { readFile: read } = await import('node:fs/promises');
  const catalog = JSON.parse(await read(new URL('../runner/downloads.json', import.meta.url), 'utf8'));
  const notices = await read(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  const models = notices.slice(notices.indexOf('## Models'));
  const restricted = new Set();
  for (const [file, source] of Object.entries(catalog)) {
    const license = source.license;
    assert.ok(license?.name, file + ': no licence');
    assert.match(license.url, /^https:\/\/\S+$/, file + ': no link to the text of its licence');
    assert.deepEqual(
      Object.keys(license).filter(key => !['name', 'url', 'limits', 'restricted'].includes(key)),
      [],
      file,
    );
    if ('limits' in license)
      assert.ok(typeof license.limits === 'string' && license.limits.trim(), file + ': empty limits');
    // The name is the one of the table; nothing is said here that the notices do not say.
    assert.ok(models.includes(license.name), `${file}: « ${license.name} » is not in the table of the notices`);
    if (license.restricted) {
      assert.equal(license.restricted, true, file);
      assert.ok(license.limits, file + ': a licence with conditions without its limits');
      assert.ok(
        models.includes(`[${license.name}](${license.url})`),
        `${file}: its link is not the one of the notices`,
      );
      restricted.add(license.name);
    } else
      assert.match(
        license.name,
        /^(Apache-2\.0|MIT|BSD-3-Clause)$/,
        file + ': neither free nor marked with conditions',
      );
    // A file behind a licence gate is under a licence with conditions.
    if (source.gated) assert.equal(license.restricted, true, file + ': gated, yet not marked with conditions');
  }
  assert.deepEqual([...restricted].sort(), [
    'Krea 2 Community License Agreement v.1',
    'LTX-2.x Community License Agreement',
    'MiniMax H3 Community License Agreement',
    'SAM License',
  ]);
  // MiniMax H3: where it is not licensed is said first, in so many words.
  for (const file of [
    'fasth3_omniref_8step_pruned_int8_convrot.safetensors',
    'minimax_h3_video_vae_fp16.safetensors',
    'minimax_h3_audio_vae_fp32.safetensors',
  ])
    assert.match(
      catalog[file].license.limits,
      /^Non licencié dans l’Union européenne, au Royaume-Uni, en Corée du Sud ni aux États-Unis/,
      file,
    );
  assert.match(catalog['krea2TurboOfficialComfy_krea2TurboInt8.safetensors'].license.limits, /1 million de dollars/);
  assert.equal(catalog['sam3.1_multiplex_fp16.safetensors'].license.name, 'SAM License');
});
