import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowCatalog } from '../lib/comfy-workflows.mjs';

function fixture(overrides = {}) {
  return {
    id: 'portrait',
    name: 'Portrait',
    description: 'A local portrait workflow.',
    graph: {
      1: { class_type: 'CLIPTextEncode', inputs: { text: 'original', clip: ['9', 0] } },
      2: { class_type: 'KSampler', inputs: { seed: 7, steps: 20, positive: ['1', 0] } },
      3: { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'ComfyUI' } },
      9: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'local.safetensors' } },
    },
    bindings: { prompt: { node: '1', input: 'text' }, seed: { node: '2', input: 'seed' } },
    outputNodes: ['3'],
    requiresImage: false,
    ...overrides,
  };
}

async function withCatalog(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-workflows-'));
  try {
    await fn(new WorkflowCatalog(directory), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('save persists an independent graph, derives a digest, lists metadata and removes it', async () => {
  await withCatalog(async (catalog, directory) => {
    assert.deepEqual(await catalog.list(), []);
    const original = fixture();
    const saved = await catalog.save(original);
    assert.equal(saved.id, 'portrait');
    assert.match(saved.digest, /^[a-f0-9]{64}$/);
    original.graph['1'].inputs.text = 'changed outside';
    assert.equal((await catalog.read('portrait')).graph['1'].inputs.text, 'original');
    saved.graph['1'].inputs.text = 'changed return';
    const listed = await catalog.list();
    assert.equal(listed[0].name, 'Portrait');
    assert.equal(listed[0].graph, undefined);
    assert.equal(listed[0].digest, (await catalog.read('portrait')).digest);
    const bytes = await readFile(join(directory, 'portrait.json'), 'utf8');
    assert.equal(JSON.parse(bytes).graph['1'].inputs.text, 'original');
    assert.deepEqual(await readdir(directory), ['portrait.json']);
    const changed = await catalog.save(fixture({ description: 'Changed approval context' }));
    assert.notEqual(changed.digest, listed[0].digest);
    await catalog.remove('portrait');
    assert.deepEqual(await catalog.list(), []);
    await assert.rejects(catalog.read('portrait'), /not found/i);
  });
});

test('prepare changes only mapped inputs and preserves saved and caller graphs', async () => {
  await withCatalog(async catalog => {
    const input = fixture();
    const saved = await catalog.save(input);
    const prepared = await catalog.prepare('portrait', { workflow_id: 'portrait', prompt: 'new portrait', seed: 0 });
    assert.equal(prepared.graph['1'].inputs.text, 'new portrait');
    assert.equal(prepared.graph['2'].inputs.seed, 0);
    assert.equal(prepared.graph['2'].inputs.steps, 20);
    assert.deepEqual(prepared.outputNodes, ['3']);
    assert.equal(prepared.workflow.digest, saved.digest);
    prepared.graph['1'].inputs.clip[0] = 'corrupted';
    prepared.workflow.bindings.prompt.node = 'other';
    prepared.outputNodes.push('2');
    assert.equal(input.graph['1'].inputs.text, 'original');
    assert.deepEqual((await catalog.read('portrait')).graph, input.graph);
    assert.deepEqual((await catalog.read('portrait')).outputNodes, ['3']);
  });
});

test('prepare rejects unbound, unknown, mismatched and invalid arguments', async () => {
  await withCatalog(async catalog => {
    await catalog.save(fixture());
    for (const args of [
      { prompt: 'ok', negative_prompt: 'unsupported' },
      { prompt: 'ok', width: 512 },
      { prompt: 'ok', reference_image: 0 },
      { prompt: 'ok', arbitrary: 'value' },
      { workflow_id: 'elsewhere', prompt: 'ok' },
      { prompt: '' },
      { prompt: ' '.repeat(3) },
      { prompt: 'x'.repeat(8001) },
      { prompt: 9 },
      { prompt: 'ok', seed: -1 },
      { prompt: 'ok', seed: 1.5 },
      { prompt: 'ok', seed: Number.MAX_SAFE_INTEGER + 1 },
      null,
      [],
    ])
      await assert.rejects(catalog.prepare('portrait', args));
    assert.equal((await catalog.read('portrait')).graph['2'].inputs.seed, 7);
  });
});

test('mapped optional text, numeric bounds and uploaded image reach exactly their inputs', async () => {
  await withCatalog(async catalog => {
    const input = fixture();
    input.graph['4'] = { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } };
    input.graph['5'] = { class_type: 'LoadImage', inputs: { image: 'old.png' } };
    input.graph['6'] = { class_type: 'CLIPTextEncode', inputs: { text: 'old negative' } };
    Object.assign(input.bindings, {
      negative_prompt: { node: '6', input: 'text' },
      width: { node: '4', input: 'width' },
      height: { node: '4', input: 'height' },
      image: { node: '5', input: 'image' },
    });
    Object.assign(input.graph['2'].inputs, { reference: ['5', 0], latent_image: ['4', 0], negative: ['6', 0] });
    input.requiresImage = true;
    await catalog.save(input);
    await assert.rejects(catalog.prepare('portrait', { prompt: 'edit' }), /reference image/i);
    const prepared = await catalog.prepare(
      'portrait',
      {
        prompt: 'edit',
        negative_prompt: '',
        seed: Number.MAX_SAFE_INTEGER,
        width: 64,
        height: 4096,
        reference_image: 0,
      },
      { referenceImage: { filename: 'uploaded.png', subfolder: 'references', type: 'input' } },
    );
    assert.equal(prepared.graph['4'].inputs.width, 64);
    assert.equal(prepared.graph['4'].inputs.height, 4096);
    assert.equal(prepared.graph['5'].inputs.image, 'references/uploaded.png');
    assert.equal(prepared.graph['6'].inputs.text, '');
    assert.equal(prepared.graph['2'].inputs.seed, Number.MAX_SAFE_INTEGER);
    for (const args of [
      { width: 63 },
      { width: 65 },
      { height: 4104 },
      { height: '512' },
      { negative_prompt: 'x'.repeat(8001) },
      { reference_image: -1 },
      { reference_image: 1.5 },
      { reference_image: 6400 },
    ]) {
      await assert.rejects(
        catalog.prepare('portrait', { prompt: 'edit', ...args }, { referenceImage: 'uploaded.png' }),
      );
    }
    const later = await catalog.prepare(
      'portrait',
      { prompt: 'edit', reference_image: 6399 },
      { referenceImage: 'uploaded.png' },
    );
    assert.equal(later.graph['5'].inputs.image, 'uploaded.png');
    const args = { prompt: 'edit', references: [] };
    await catalog.prepare('portrait', args, { referenceImage: 'uploaded.png' });
    assert.deepEqual(args.references, [], 'Legacy compatibility must not mutate caller arguments');
    for (const referenceImage of [
      '../secret.png',
      '.. ',
      'image.png ',
      { filename: 'image.png', subfolder: '../outside' },
      { filename: 'image.png', subfolder: '.. /outside' },
      {},
    ]) {
      await assert.rejects(catalog.prepare('portrait', { prompt: 'edit' }, { referenceImage }));
    }
  });
});

test('generated identifiers round-trip and digest changes follow graph changes rather than key order', async () => {
  await withCatalog(async catalog => {
    const input = fixture();
    delete input.id;
    const generated = await catalog.save(input);
    assert.equal((await catalog.read(generated.id)).id, generated.id);
    const reordered = fixture();
    reordered.graph = Object.fromEntries(Object.entries(reordered.graph).reverse());
    const first = await catalog.save(fixture());
    assert.equal((await catalog.save(reordered)).digest, first.digest);
    reordered.graph['2'].inputs.steps = 21;
    assert.notEqual((await catalog.save(reordered)).digest, first.digest);
  });
});

test('save rejects UI exports with actionable API export guidance', async () => {
  await withCatalog(async catalog => {
    await assert.rejects(
      catalog.save(fixture({ graph: { nodes: [{ id: 1, type: 'KSampler' }], links: [] } })),
      /export.*API|API.*export/i,
    );
    await assert.rejects(catalog.save(fixture({ graph: { last_node_id: 1, nodes: [], version: 0.4 } })), /API/i);
  });
});

test('save rejects malformed graphs, bindings, output nodes and unsafe identifiers', async () => {
  await withCatalog(async (catalog, directory) => {
    for (const override of [
      { id: '../outside' },
      { id: 'a/b' },
      { id: 'CON' },
      { name: '' },
      { name: 'x'.repeat(121) },
      { description: {} },
      { graph: null },
      { graph: {} },
      { graph: [] },
      { graph: { 1: { class_type: 'X', inputs: [] } } },
      { graph: { 1: { inputs: {} } } },
      { bindings: {} },
      { bindings: { prompt: { node: 'missing', input: 'text' } } },
      { bindings: { prompt: { node: '1', input: 'missing' } } },
      { bindings: { prompt: { node: '1', input: 'text' }, steps: { node: '2', input: 'steps' } } },
      { bindings: { prompt: { node: '1', input: 'text', ignored: true } } },
      { bindings: { prompt: { node: '1', input: 'text' }, image: { node: '1', input: 'text' } } },
      { outputNodes: [] },
      { outputNodes: ['missing'] },
      { outputNodes: ['3', '3'] },
      { requiresImage: 'yes' },
      { requiresImage: true },
    ])
      await assert.rejects(catalog.save(fixture(override)), `accepted ${JSON.stringify(override).slice(0, 160)}`);
    for (const id of ['../outside', 'a/b', '..', 'CON', 'a\\b', '']) {
      await assert.rejects(catalog.read(id));
      await assert.rejects(catalog.remove(id));
    }
    assert.deepEqual(await readdir(directory), []);
  });
});

test('size and node limits reject imports and oversized stored files', async () => {
  await withCatalog(async (catalog, directory) => {
    const graph = Object.fromEntries(
      Array.from({ length: 513 }, (_, i) => [String(i), { class_type: 'X', inputs: { text: 'x' } }]),
    );
    await assert.rejects(
      catalog.save(fixture({ graph, bindings: { prompt: { node: '0', input: 'text' } }, outputNodes: ['0'] })),
      /512|nodes/i,
    );
    const large = fixture();
    large.graph['1'].inputs.text = 'x'.repeat(2 * 1024 * 1024);
    await assert.rejects(catalog.save(large), /2.*MiB|large|size/i);
    await writeFile(join(directory, 'large.json'), ' '.repeat(2 * 1024 * 1024 + 1));
    await assert.rejects(catalog.read('large'), /2.*MiB|large|size/i);
  });
});

test('stored records cannot substitute a different workflow identity', async () => {
  await withCatalog(async (catalog, directory) => {
    await writeFile(join(directory, 'portrait.json'), JSON.stringify(fixture({ id: 'different' })));
    await assert.rejects(catalog.read('portrait'), /id|identity/i);
  });
});

test('definition advertises only registered workflows and their supported parameters', async () => {
  await withCatalog(async catalog => {
    assert.equal(await catalog.definition(), null);
    await catalog.save(fixture());
    const definition = await catalog.definition();
    assert.equal(definition.type, 'function');
    assert.equal(definition.function.name, 'comfy_generate_image');
    const schema = definition.function.parameters;
    assert.deepEqual(schema.required, ['workflow_id', 'prompt']);
    assert.deepEqual(schema.properties.workflow_id.enum, ['portrait']);
    assert.equal(schema.additionalProperties, false);
    assert.ok(schema.properties.seed);
    assert.equal(schema.properties.width, undefined);
    assert.match(definition.function.description, /Portrait/);
    assert.match(definition.function.description, /seed/);
    await catalog.remove('portrait');
    assert.equal(await catalog.definition(), null);
  });
});

test('output preview dimensions use declared numeric values without guessing arbitrary custom node outputs', async () => {
  const { workflowOutputSize } = await import('../lib/comfy-workflows.mjs');
  const w = fixture();
  w.bindings.width = { node: '4', input: 'width' };
  w.bindings.height = { node: '4', input: 'height' };
  w.graph['4'] = { class_type: 'CustomSizeNode', inputs: { width: 1536, height: 1024 } };
  assert.deepEqual(workflowOutputSize(w), { width: 1536, height: 1024 });
  assert.deepEqual(workflowOutputSize(w, { width: 768, height: 512 }), { width: 768, height: 512 });
  w.graph['4'].inputs.width = ['5', 0];
  assert.equal(workflowOutputSize(w), null);
});

test('a disconnected prompt or requested parameter fails before an unchanged image can be generated', async () =>
  withCatalog(async catalog => {
    const input = fixture();
    input.graph['2'].inputs.positive = ['1', 0];
    input.graph['4'] = { class_type: 'UnusedSize', inputs: { width: 512 } };
    input.bindings.width = { node: '4', input: 'width' };
    await catalog.save(input);
    await assert.rejects(catalog.prepare(input.id, { prompt: 'New', width: 1024 }), /connect/i);
    delete input.graph['2'].inputs.positive;
    await catalog.save(input);
    await assert.rejects(catalog.prepare(input.id, { prompt: 'New' }), /connect/i);
  }));
