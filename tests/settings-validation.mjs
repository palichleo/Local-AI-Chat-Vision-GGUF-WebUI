import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server.mjs';
import { WorkflowCatalog } from '../lib/comfy-workflows.mjs';
import { History } from '../lib/history.mjs';

const workflow = (id = 'photo') => ({
  id,
  name: 'Portrait',
  description: '',
  graph: {
    1: { class_type: 'CLIPTextEncode', inputs: { text: 'prompt' } },
    2: { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
  },
  bindings: { prompt: { node: '1', input: 'text' } },
  outputNodes: ['2'],
});
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-settings-validation-'));
  let app;
  try {
    app = await createApplication({
      port: 0,
      dataDir,
      filePicker: async () => null,
      comfyDiscovery: async baseUrl => ({ detected: false, baseUrl }),
      ...options,
    });
  } catch (error) {
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const initial = await (await fetch(`${app.url}/api/bootstrap`)).json();
  const api = (route, body) =>
    fetch(`${app.url}/api/${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${initial.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { dataDir, app, initial, api };
}
function pauseMethod(t, prototype, method) {
  const original = prototype[method];
  const arrived = Promise.withResolvers(),
    gate = Promise.withResolvers();
  let paused = false;
  prototype[method] = async function (...args) {
    if (!paused) {
      paused = true;
      arrived.resolve();
      await gate.promise;
    }
    return original.apply(this, args);
  };
  t.after(() => {
    gate.resolve();
    prototype[method] = original;
  });
  return { arrived: arrived.promise, release: gate.resolve };
}

test('settings reject non-object payloads and malformed workflow edits without writes', async t => {
  const { initial, api, dataDir } = await fixture(t);
  for (const body of [
    null,
    [],
    true,
    'settings',
    { config: initial.config, comfy: initial.comfy, workflowDescriptions: false },
    { config: initial.config, comfy: initial.comfy, workflowDescriptions: 0 },
  ]) {
    await t.test(JSON.stringify(body), async () => {
      const response = await api('settings', body);
      assert.equal(response.status, 400, await response.text());
    });
  }
  await assert.rejects(readFile(join(dataDir, 'comfy.json')), { code: 'ENOENT' });
});

test('oversized workflow description is rejected before any settings or other descriptions are saved', async t => {
  const { initial, api, dataDir } = await fixture(t);
  const catalog = new WorkflowCatalog(join(dataDir, 'workflows'));
  await catalog.save(workflow('first'));
  const large = workflow('large');
  large.graph['1'].inputs.padding = 'x'.repeat(2 * 1024 * 1024 - 1000);
  await catalog.save(large);
  const response = await api('settings', {
    config: { ...initial.config, gpuLayers: 7 },
    comfy: { ...initial.comfy, autoAllow: true },
    workflowDescriptions: [
      { id: 'first', description: 'Changed' },
      { id: 'large', description: 'd'.repeat(2000) },
    ],
  });
  assert.equal(response.status, 400, await response.text());
  const after = await (await api('bootstrap')).json();
  assert.deepEqual(after.config, initial.config);
  assert.deepEqual(after.comfy, initial.comfy);
  assert.equal((await catalog.read('first')).description, '');
  assert.equal((await catalog.read('large')).description, '');
  for (const file of ['config.json', 'comfy.json'])
    await assert.rejects(readFile(join(dataDir, file)), { code: 'ENOENT' });
});

for (const operation of ['import', 'remove'])
  test(`pending Comfy workflow ${operation} excludes concurrent settings, model start and workflow writes`, async t => {
    const { initial, api, dataDir } = await fixture(t);
    const catalog = new WorkflowCatalog(join(dataDir, 'workflows'));
    await catalog.save(workflow());
    const barrier = pauseMethod(t, WorkflowCatalog.prototype, operation === 'import' ? 'save' : 'remove');
    const pending = api(
      `comfy/${operation}`,
      operation === 'import' ? { ...workflow(), description: 'Imported' } : { id: 'photo' },
    );
    try {
      await barrier.arrived;
      for (const [route, body] of [
        ['settings', { config: initial.config, comfy: initial.comfy }],
        ['start', {}],
        ['comfy/config', initial.comfy],
        ['comfy/import', workflow('other')],
        ['comfy/remove', { id: 'other' }],
        ['files/choose', { kind: 'model' }],
      ]) {
        await t.test(route, async () => {
          const response = await api(route, body);
          assert.equal(response.status, 409, await response.text());
        });
      }
    } finally {
      barrier.release();
      assert.equal((await pending).status, 200);
    }
    assert.equal((await api('settings', { config: initial.config, comfy: initial.comfy })).status, 200);
  });

for (const method of ['clear', 'remove'])
  test(`history ${method} excludes changes to history preference until deletion ends`, async t => {
    const { api, dataDir } = await fixture(t);
    const barrier = pauseMethod(t, History.prototype, method);
    const pending = api(`history/${method === 'remove' ? 'delete' : method}`, {
      confirm: true,
      id: '11111111-1111-4111-8111-111111111111',
    });
    try {
      await barrier.arrived;
      const response = await api('preferences', { saveHistory: false });
      assert.equal(response.status, 409, await response.text());
      await assert.rejects(readFile(join(dataDir, 'preferences.json')), { code: 'ENOENT' });
    } finally {
      barrier.release();
      assert.equal((await pending).status, 200);
    }
    assert.equal((await api('preferences', { saveHistory: false })).status, 200);
  });

test('discovery keeps an explicitly saved Comfy address when another port is found', async t => {
  const { api, initial, dataDir } = await fixture(t, {
    comfyDiscovery: async () => ({ detected: true, baseUrl: 'http://127.0.0.1:7821' }),
  });
  const comfy = { ...initial.comfy, baseUrl: 'http://127.0.0.1:9000' };
  assert.equal((await api('settings', { config: initial.config, comfy })).status, 200);
  const detected = await (await api('comfy')).json();
  assert.deepEqual(detected.discovery, { detected: false, baseUrl: 'http://127.0.0.1:9000' });
  assert.equal(detected.config.baseUrl, 'http://127.0.0.1:9000');
  assert.equal(JSON.parse(await readFile(join(dataDir, 'comfy.json'), 'utf8')).baseUrl, detected.config.baseUrl);
});

test('a discovery started before explicit default-address save cannot replace that choice', async t => {
  const arrived = Promise.withResolvers(),
    result = Promise.withResolvers();
  const { api, initial } = await fixture(t, {
    comfyDiscovery: async () => {
      arrived.resolve();
      return result.promise;
    },
  });
  const pending = api('comfy');
  try {
    await arrived.promise;
    assert.equal((await api('settings', { config: initial.config, comfy: initial.comfy })).status, 200);
  } finally {
    result.resolve({ detected: true, baseUrl: 'http://127.0.0.1:7821' });
  }
  assert.equal((await (await pending).json()).config.baseUrl, 'http://127.0.0.1:8188');
});
