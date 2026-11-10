import test from 'node:test';
import { family, familyTemplate } from '../lib/families.mjs';
import { ToolCatalog } from '../lib/tool-catalog.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  NativeWorkflowCatalog,
  validateNativeWorkflow,
  resolveNativeWorkflow,
  nativeWorkflowReferences,
} from '../lib/native-workflows.mjs';

const assetMap = new Map(
  ['model', 'textEncoder', 'vae', 'lora'].map(id => [
    id,
    { id, path: join(tmpdir(), `${id}.safetensors`), kind: id, family: 'krea2' },
  ]),
);
assetMap.set('tokenizer', { id: 'tokenizer', path: join(tmpdir(), 'tokenizer'), kind: 'tokenizer', family: 'krea2' });
const assets = {
  async resolve(id, { kind, family }) {
    const asset = assetMap.get(id);
    if (!asset || asset.kind !== kind || asset.family !== family) throw new Error('Incompatible asset');
    return asset;
  },
};
function fixture() {
  return {
    schemaVersion: 1,
    id: 'portrait',
    name: 'Portrait',
    description: 'For portraits',
    enabled: true,
    pipeline: 'krea2',
    mediaType: 'image',
    components: Object.fromEntries(
      ['model', 'textEncoder', 'tokenizer', 'vae'].map(role => [role, { policy: 'fixed', asset: role }]),
    ),
    parameters: {
      prompt: { policy: 'model', type: 'string', maxLength: 8000 },
      seed: { policy: 'random', type: 'integer' },
      width: { policy: 'fixed', value: 512 },
      height: { policy: 'fixed', value: 512 },
      steps: { policy: 'model', type: 'integer', min: 1, max: 12, default: 8 },
      cfg: { policy: 'fixed', value: 1 },
      denoise: { policy: 'fixed', value: 1 },
    },
    loras: [
      {
        id: 'style',
        asset: 'lora',
        description: 'A style',
        enabled: { policy: 'off' },
        strength: { policy: 'fixed', value: 0.5 },
      },
    ],
    references: [],
  };
}
async function withCatalog(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-native-'));
  try {
    await fn(new NativeWorkflowCatalog(directory, { assets, capabilities: { krea2: { ready: true } } }), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('strict policy resolver rejects locked overrides, unsupported fields and out-of-range model choices', async () => {
  const workflow = fixture();
  for (const args of [
    { prompt: 'test', width: 512 },
    { prompt: 'test', seed: 2 },
    { prompt: 'test', steps: 13 },
    { prompt: 'test', module: 'os' },
  ])
    await assert.rejects(resolveNativeWorkflow(workflow, args, assets), /fixed|random|range|unsupported|locked/i);
  const job = await resolveNativeWorkflow(workflow, { prompt: 'test', steps: 10 }, assets, {
    seed: 0,
    jobId: 'job-one',
  });
  assert.equal(job.id, 'job-one');
  assert.equal(job.parameters.seed, 0);
  assert.equal(job.parameters.width, 512);
  assert.equal(job.parameters.steps, 10);
  assert.deepEqual(job.loras, []);
  assert.equal(job.components.model, assetMap.get('model').path);
  assert.equal(job.schemaVersion, 1);
  assert.equal(job.workflowId, 'portrait');
});

test('schema rejects executable/unknown settings and enforces family boundaries', () => {
  for (const change of [
    { schemaVersion: 2 },
    { module: 'custom.py' },
    { pipeline: 'arbitrary' },
    { pipeline: ['krea2'] },
    { mediaType: 'video' },
    { parameters: { ...fixture().parameters, seed: { policy: 'random', type: 'number' } } },
  ])
    assert.throws(() => validateNativeWorkflow({ ...fixture(), ...change }));
  const workflow = fixture();
  workflow.parameters.width = { policy: 'model', type: 'integer', choices: [512, 768], default: 512 };
  assert.equal(validateNativeWorkflow(workflow).parameters.width.default, 512);
  workflow.parameters.width.choices = [513];
  assert.throws(() => validateNativeWorkflow(workflow), /multiple|width/i);
  workflow.parameters.width = { policy: 'fixed', value: 512 };
  workflow.parameters.denoise.value = 0;
  assert.throws(() => validateNativeWorkflow(workflow), /denoise/i);
});

test('enabled LoRA and component policies apply only allowlisted choices', async () => {
  const workflow = fixture();
  workflow.loras[0].enabled = { policy: 'model', default: false };
  workflow.loras[0].strength = { policy: 'model', type: 'number', min: 0, max: 1, default: 0.5 };
  const job = await resolveNativeWorkflow(
    workflow,
    { prompt: 'test', loras: { style: { enabled: true, strength: 0.75 } } },
    assets,
    { seed: 7 },
  );
  assert.deepEqual(job.loras, [{ id: 'style', path: assetMap.get('lora').path, strength: 0.75 }]);
  await assert.rejects(
    resolveNativeWorkflow(workflow, { prompt: 'test', loras: { style: { enabled: true, strength: 1.1 } } }, assets),
    /range/i,
  );
  await assert.rejects(
    resolveNativeWorkflow(fixture(), { prompt: 'test', loras: { style: { enabled: true } } }, assets),
    /off|fixed|locked/i,
  );
  await assert.rejects(
    resolveNativeWorkflow(workflow, { prompt: 'test', components: { model: '/arbitrary/file' } }, assets),
    /fixed|locked/i,
  );
});

test('Krea LoRAs explicitly support signed strength within the validated bounds', async () => {
  const workflow = fixture();
  workflow.loras[0].enabled = { policy: 'fixed', value: true };
  workflow.loras[0].strength.value = -0.5;
  assert.equal(
    (await resolveNativeWorkflow(workflow, { prompt: 'test' }, assets, { seed: 1 })).loras[0].strength,
    -0.5,
  );
  workflow.loras[0].strength.value = -4.1;
  assert.throws(() => validateNativeWorkflow(workflow), /range/i);
});

test('trusted prompt expansion preserves exact settings and prompt templates resolve once', async () => {
  const workflow = fixture();
  workflow.parameters.expandPrompt = { policy: 'fixed', value: true };
  workflow.promptExpansion = {
    template: 'Rewrite {{prompt}}',
    maxTokens: 512,
    temperature: 0.5,
    topK: 64,
    topP: 0.95,
    minP: 0.05,
    repetitionPenalty: 1.05,
    seed: 0,
    suffix: ', style',
  };
  const job = await resolveNativeWorkflow(workflow, { prompt: 'a scene' }, assets, { seed: 5 });
  assert.deepEqual(job.promptExpansion, workflow.promptExpansion);
  assert.equal(job.parameters.prompt, 'a scene');
  workflow.promptExpansion.template = 'missing placeholder';
  assert.throws(() => validateNativeWorkflow(workflow), /template|placeholder/i);
  delete workflow.promptExpansion;
  assert.throws(() => validateNativeWorkflow(workflow), /expansion/i);
  workflow.parameters.expandPrompt.value = false;
  workflow.promptTemplate = '{{prompt}}, style';
  assert.equal(
    (await resolveNativeWorkflow(workflow, { prompt: 'a scene' }, assets, { seed: 5 })).parameters.prompt,
    'a scene, style',
  );
});

test('implicit Krea defaults resolve a complete Python job', async () => {
  const workflow = fixture();
  delete workflow.parameters.cfg;
  delete workflow.parameters.denoise;
  const job = await resolveNativeWorkflow(workflow, { prompt: 'a scene' }, assets, { seed: 5 });
  assert.equal(job.parameters.cfg, 1);
  assert.equal(job.parameters.denoise, 1);
});

test('canonical digest changes only with saved content and saved files remain atomic on invalid edits', async () => {
  await withCatalog(async (catalog, directory) => {
    assert.equal(catalog.kind, 'native');
    const saved = await catalog.save(fixture());
    const ordered = Object.fromEntries(Object.entries(fixture()).reverse());
    assert.equal(validateNativeWorkflow(ordered).digest, saved.digest);
    const before = await readFile(join(directory, 'portrait.json'), 'utf8');
    const invalid = fixture();
    invalid.components.vae.asset = 'missing';
    await assert.rejects(catalog.save(invalid), /asset/i);
    assert.equal(await readFile(join(directory, 'portrait.json'), 'utf8'), before);
    const changed = fixture();
    changed.description = 'Changed';
    assert.notEqual((await catalog.save(changed)).digest, saved.digest);
    await writeFile(join(directory, 'broken.json'), '{oops');
    const listed = await catalog.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].parameters.width.value, 512);
    assert.equal(listed[0].ready, true);
    assert.match(catalog.warnings[0], /broken/i);
    assert.deepEqual((await readdir(directory)).sort(), ['broken.json', 'portrait.json']);
    await catalog.remove('portrait');
    assert.deepEqual(await catalog.list(), []);
  });
});

test('tools advertise only enabled ready workflows and writable policy fields', async () => {
  await withCatalog(async catalog => {
    await catalog.save(fixture());
    const tools = new ToolCatalog(catalog);
    const definition = (await tools.definitions()).find(tool => tool.function.name === 'create_image');
    const variant = definition.function.parameters;
    assert.ok(variant.properties.prompt);
    assert.equal(variant.properties.width, undefined);
    // A drawn seed is not the model's to choose, but it passes on the one the user names.
    assert.match(variant.properties.seed.description, /Only when the user gives a seed number/);
    assert.ok(!variant.required.includes('seed'));
    assert.equal(variant.properties.steps.maximum, 12);
    assert.equal(variant.properties.loras, undefined);
    catalog.capabilities = {};
    assert.deepEqual(await tools.definitions(), []);
  });
});

test('references use declared roles and staged local files, never model-supplied paths', async () => {
  await withCatalog(async (catalog, directory) => {
    const workflow = fixture();
    workflow.references = [{ id: 'source', role: 'img2img', required: true, name: 'Source' }];
    await catalog.save(workflow);
    const args = { prompt: 'edit', references: [{ input: 'source', image: 0 }] };
    assert.deepEqual(nativeWorkflowReferences(workflow, args), args.references);
    await assert.rejects(catalog.prepare('portrait', args), /staged|reference/i);
    const path = join(directory, 'source.png');
    await writeFile(path, 'test');
    const prepared = await catalog.prepare('portrait', args, { referenceImages: { source: path }, seed: 5 });
    assert.deepEqual(prepared.outputNodes, []);
    assert.deepEqual(prepared.job.references, [{ input: 'source', role: 'img2img', path: await realpath(path) }]);
    assert.equal(prepared.job.parameters.seed, 5);
    assert.throws(
      () => nativeWorkflowReferences(workflow, { ...args, references: [{ input: 'source', path }] }),
      /reference|source/i,
    );
    assert.throws(() => nativeWorkflowReferences(workflow, { prompt: 'test' }), /required/i);
    const pending = await catalog.prepare('portrait', args, { allowPendingReferences: true, seed: 5 });
    assert.equal(pending.job.references[0].path, null);
  });
});

test('family manifest limits are enforced when a workflow is saved, not discovered at run time', async () => {
  await withCatalog(async catalog => {
    const workflow = familyTemplate(family('ltx25'));
    workflow.enabled = true;
    catalog.assets = { resolve: async id => ({ path: join(tmpdir(), id + '.safetensors') }) };
    catalog.capabilities = { ltx25: { ready: true } };
    await catalog.save(workflow);
    assert.ok((await new ToolCatalog(catalog).definitions()).some(tool => tool.function.name === 'create_video'));
    for (const [patch, error] of [
      [w => (w.parameters.steps.value = 12), /supported|allowed/i],
      [w => w.references.push({ id: 'edit', role: 'img2img', required: false }), /reference slot/i],
      [w => (w.parameters.frames.value = 24), /allowed|supported/i],
    ]) {
      const changed = structuredClone(workflow);
      patch(changed);
      await assert.rejects(catalog.save(changed), error);
    }
  });
});

test('a reference that depends on a LoRA switches it on, or is refused in plain words', async () => {
  const workflow = JSON.parse(
    await readFile(new URL('../runner/workflows/eaec4e2f-0649-4e56-9bd9-809dc9390452.json', import.meta.url), 'utf8'),
  );
  const assets = { resolve: async id => ({ path: join(tmpdir(), id) }) };
  const resolve = (references, input = workflow) =>
    resolveNativeWorkflow(
      input,
      { prompt: 'a tiger runs', intention: 'x', ...(references ? { references } : {}) },
      assets,
      {
        allowPendingReferences: true,
      },
    );
  // LTX subject references need the learned-slot LoRA: an image is enough to ask for it.
  assert.deepEqual(
    (await resolve([{ input: 'subject-1', image: 0 }])).loras.map(lora => lora.id),
    ['reference-slots'],
  );
  assert.deepEqual((await resolve([{ input: 'start', image: 0 }])).loras, []);
  assert.deepEqual((await resolve()).loras, []);
  const without = structuredClone(workflow);
  without.loras[0].enabled = { policy: 'off' };
  await assert.rejects(resolve([{ input: 'subject-1', image: 0 }], without), /référence de sujet.*LoRA/);
});

test('an optional component whose file is absent is left out; the workflow still runs', async () => {
  const workflow = JSON.parse(
    await readFile(new URL('../runner/workflows/eaec4e2f-0649-4e56-9bd9-809dc9390452.json', import.meta.url), 'utf8'),
  );
  workflow.components.upscaler = { policy: 'fixed', asset: 'latent-upscaler', file: 'upscaler-x2.safetensors' };
  assert.equal(family('ltx25').components.upscaler.required, false);
  const here = { resolve: async id => ({ path: join(tmpdir(), id) }) };
  const absent = {
    resolve: async id => {
      if (id === 'latent-upscaler') throw new Error('Asset latent-upscaler not found');
      return { path: join(tmpdir(), id) };
    },
  };
  const wrong = {
    resolve: async id => {
      if (id === 'latent-upscaler') throw new Error('Asset latent-upscaler has incompatible kind; expected upscaler');
      return { path: join(tmpdir(), id) };
    },
  };
  const resolve = assets =>
    resolveNativeWorkflow(workflow, { prompt: 'a boat', intention: 'x' }, assets, { allowPendingReferences: true });
  assert.equal((await resolve(here)).components.upscaler, join(tmpdir(), 'latent-upscaler'));
  const without = await resolve(absent);
  assert.equal(without.components.upscaler, undefined);
  assert.ok(without.components.model, 'the required components are still there');
  // A file that is there but is not an upscaler is an error to show, not something to skip.
  await assert.rejects(resolve(wrong), /incompatible kind/);
});
