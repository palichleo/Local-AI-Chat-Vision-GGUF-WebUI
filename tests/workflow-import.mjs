import test from 'node:test';
import { ToolCatalog } from '../lib/tool-catalog.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewWorkflowImport } from '../lib/workflow-import.mjs';
import { NativeWorkflowCatalog, resolveNativeWorkflow, validateNativeWorkflow } from '../lib/native-workflows.mjs';
import { createApplication } from '../server.mjs';

function graph() {
  const value = {
    encoder: { class_type: 'CLIPLoader', inputs: { clip_name: 'custom-text.safetensors', type: 'krea2' } },
    model: { class_type: 'UNETLoader', inputs: { unet_name: 'custom-model.safetensors' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'custom-vae.safetensors' } },
    positive: { class_type: 'CLIPTextEncode', inputs: { text: 'My own scene' } },
    negative: { class_type: 'CLIPTextEncode', inputs: { text: 'blurry' } },
    latent: { class_type: 'EmptyLatentImage', inputs: { width: 640, height: 768, batch_size: 1 } },
    sampler: {
      class_type: 'KSampler',
      inputs: {
        positive: ['positive', 0],
        negative: ['negative', 0],
        steps: 27,
        cfg: 5.5,
        seed: 123,
        sampler_name: 'custom_sampler',
        scheduler: 'custom_schedule',
      },
    },
    custom: {
      class_type: 'CustomFourReferenceConditioning',
      inputs: {
        mode: 'subject identity',
        images: [
          ['image-0', 0],
          ['image-1', 0],
          ['image-2', 0],
          ['image-3', 0],
        ],
      },
    },
  };
  for (let i = 0; i < 4; i++)
    value['image-' + i] = { class_type: 'LoadImage', inputs: { image: 'reference-' + i + '.png' } };
  for (let i = 0; i < 3; i++)
    value['lora-' + i] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: { lora_name: 'specific-' + i + '.safetensors', strength_model: 0.3 + i * 0.2 },
    };
  return value;
}

test('unsupported Comfy graphs prefill all known fields, four references and three LoRAs without saving a workflow', async () => {
  const source = graph(),
    result = await previewWorkflowImport(JSON.stringify(source), { name: 'My workflow.json' }),
    record = result.workflow;
  assert.equal(record.name, 'My workflow');
  assert.equal(record.pipeline, 'krea2');
  assert.equal(record.enabled, false);
  assert.equal(record.parameters.width.value, 640);
  assert.equal(record.parameters.height.value, 768);
  assert.equal(record.parameters.steps.value, 27);
  assert.equal(record.parameters.cfg.value, 5.5);
  assert.equal(record.parameters.prompt.value, 'My own scene');
  assert.equal(record.parameters.negative_prompt.value, 'blurry');
  assert.equal(record.references.length, 4);
  assert.deepEqual(
    record.loras.map(lora => lora.strength.value),
    [0.3, 0.5, 0.7],
  );
  assert.deepEqual(record.importDraft.source, source);
  assert.ok(record.importDraft.blockers.length);
  assert.equal(record.importDraft.files[record.loras[2].asset], 'specific-2.safetensors');
  assert.ok(
    record.importDraft.extras.some(field => field.label.endsWith('sampler_name') && field.value === 'custom_sampler'),
  );
  assert.ok(
    record.importDraft.extras.some(field => field.label.endsWith('mode') && field.value === 'subject identity'),
  );
  await assert.rejects(resolveNativeWorkflow(record, {}, {}), /brouillon/);
  assert.throws(() => validateNativeWorkflow({ ...record, enabled: true }), /ne peut pas/);
});

test('drafts save and reopen unchanged, stay out of tools and preserve fields outside execution limits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-draft-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = new NativeWorkflowCatalog(root, {
    assets: {
      resolve() {
        assert.fail('Draft saves must not load weights');
      },
    },
    capabilities: { krea2: true },
  });
  const { workflow } = await previewWorkflowImport(JSON.stringify(graph()));
  await catalog.save(workflow);
  const reopened = new NativeWorkflowCatalog(root, {
    assets: {
      resolve() {
        assert.fail('Draft listing must not load weights');
      },
    },
    capabilities: { krea2: true },
  });
  const record = await reopened.read(workflow.id);
  assert.deepEqual(record, workflow);
  assert.equal((await reopened.list())[0].ready, false);
  assert.deepEqual(await new ToolCatalog(reopened).definitions(), []);
  assert.deepEqual(JSON.parse(await readFile(join(root, workflow.id + '.json'), 'utf8')).importDraft.source, graph());
});

test('editor-format Comfy widgets and links prefill known controls, while unnamed custom widgets are retained', async () => {
  const source = {
    nodes: [
      { id: 1, type: 'CLIPLoader', widgets_values: ['encoder.safetensors', 'krea2'] },
      {
        id: 2,
        type: 'KSampler',
        widgets_values: [9, 'randomize', 17, 3, 'euler', 'normal', 0.6],
        inputs: [{ name: 'positive', link: 1 }],
      },
      { id: 3, type: 'CLIPTextEncode', widgets_values: ['A scene'] },
      { id: 4, type: 'EmptyLatentImage', widgets_values: [512, 1024, 1] },
      { id: 5, type: 'CustomNode', widgets_values: ['mode', false, { anything: 42 }] },
    ],
    links: [[1, 3, 0, 2, 0, 'CONDITIONING']],
  };
  const { workflow } = await previewWorkflowImport(JSON.stringify(source));
  assert.equal(workflow.parameters.seed.value, 9);
  assert.equal(workflow.parameters.steps.value, 17);
  assert.equal(workflow.parameters.cfg.value, 3);
  assert.equal(workflow.parameters.denoise.value, 0.6);
  assert.equal(workflow.parameters.prompt.value, 'A scene');
  assert.equal(workflow.parameters.height.value, 1024);
  assert.ok(
    workflow.importDraft.extras.some(field => field.label.includes('CustomNode') && field.value?.anything === 42),
  );
});

test('conflicting values are preserved without arbitrarily selecting a sampler; unknown engines are left unassigned', async () => {
  const { workflow } = await previewWorkflowImport(
    JSON.stringify({
      one: { class_type: 'KSampler', inputs: { steps: 4 } },
      two: { class_type: 'KSampler', inputs: { steps: 12 } },
    }),
  );
  assert.equal(workflow.pipeline, '');
  assert.equal(workflow.parameters.steps, undefined);
  assert.equal(workflow.importDraft.extras.length, 2);
  assert.ok(workflow.importDraft.warnings.some(warning => warning.includes('steps')));
});

test('Atelier imports retain policies, unsupported reference counts and profiles; exported drafts can be reimported', async () => {
  const source = {
    schemaVersion: 1,
    id: 'original',
    name: 'Atelier source',
    description: 'My pipeline',
    enabled: true,
    pipeline: 'krea2',
    mediaType: 'image',
    components: {},
    parameters: {
      seed: { policy: 'random', type: 'integer' },
      prompt: { policy: 'model', type: 'string', maxLength: 1000 },
      width: { policy: 'fixed', value: 999 },
    },
    loras: [],
    references: Array.from({ length: 4 }, (_, i) => ({
      id: 'ref-' + i,
      role: 'img2img',
      required: false,
      name: 'Image ' + i,
    })),
  };
  const { workflow } = await previewWorkflowImport(JSON.stringify(source));
  assert.notEqual(workflow.id, source.id);
  assert.equal(workflow.enabled, false);
  assert.deepEqual(workflow.parameters, source.parameters);
  assert.equal(workflow.references.length, 4);
  assert.deepEqual(workflow.importDraft.source, source);
  const again = (await previewWorkflowImport(JSON.stringify(workflow))).workflow;
  assert.notEqual(again.id, workflow.id);
  assert.deepEqual(again.importDraft.source, source);
});

test('invalid structures, excessive nesting and unsafe keys fail before assets are touched', async () => {
  for (const value of [
    '{}',
    'null',
    '[]',
    '{"__proto__": {}}',
    JSON.stringify({ schemaVersion: 1, components: {}, parameters: { x: { policy: 'fixed', value: null } } }),
  ])
    await assert.rejects(
      previewWorkflowImport(value, {
        assets: {
          list() {
            assert.fail('Must validate before reading assets');
          },
        },
      }),
    );
  let nested = {};
  for (let i = 0; i < 40; i++) nested = { nested };
  await assert.rejects(previewWorkflowImport(JSON.stringify(nested)), /deeply nested/);
});

test('HTTP import returns an editable draft, persists only on Save and never advertises it to the model', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-import-http-')),
    app = await createApplication({
      port: 0,
      dataDir: join(root, 'data'),
      workflowDir: join(root, 'workflow'),
      modelsDir: join(root, 'models'),
    });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const boot = await (await fetch(app.url + '/api/bootstrap')).json(),
    api = (route, body) =>
      fetch(app.url + '/api/' + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + boot.token, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
  const response = await api('generation/import', { sourceText: JSON.stringify(graph()), name: 'Four refs.json' });
  assert.equal(response.status, 200);
  const { workflow } = await response.json();
  assert.equal(workflow.references.length, 4);
  assert.deepEqual((await (await api('generation/workflows')).json()).workflows, []);
  assert.equal((await api('generation/workflows', workflow)).status, 200);
  const saved = (await (await api('generation/workflows')).json()).workflows[0];
  assert.equal(saved.ready, false);
  assert.equal(saved.importDraft.source, undefined);
  assert.equal(saved.importDraft.extras, undefined);
  assert.equal(saved.importSummary, true);
  const full = await (await api('generation/workflows/' + saved.id)).json();
  assert.equal(full.importDraft.source.custom.class_type, 'CustomFourReferenceConditioning');
  assert.equal((await api('generation/workflows', { ...workflow, enabled: true })).status, 400);
});
