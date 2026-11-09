import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../server.mjs';
const engineFixture = fileURLToPath(new URL('./fixtures/fake-engine.mjs', import.meta.url));

test('settings save model and generation choices together without restarting a running model', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-settings-'));
  let app;
  let picks = 0;
  const options = {
    port: 0,
    dataDir,
    filePicker: async (kind, { signal }) => {
      signal.throwIfAborted();
      picks++;
      return kind === 'projector' ? null : join(dataDir, 'modèle choisi.gguf');
    },
    spawnProcess: (_, args, opts) => spawn(process.execPath, [engineFixture, ...args], opts),
  };
  try {
    app = await createApplication(options);
    let initial = await (await fetch(`${app.url}/api/bootstrap`)).json();
    const api = (route, body, token = initial.token) =>
      fetch(`${app.url}/api/${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    await assert.rejects(readFile(join(dataDir, 'generation.json')), { code: 'ENOENT' });
    assert.equal((await api('files/choose', { kind: 'model' }, 'bad')).status, 401);
    assert.equal(picks, 0);
    assert.equal((await api('files/choose', { kind: 'other' })).status, 400);
    assert.equal(picks, 0);
    assert.equal(
      (await (await api('files/choose', { kind: 'model' })).json()).path,
      join(dataDir, 'modèle choisi.gguf'),
    );
    assert.equal((await (await api('files/choose', { kind: 'projector' })).json()).path, null);
    const modelPath = join(dataDir, 'model.gguf');
    await writeFile(modelPath, Buffer.from('GGUF\x03\0\0\0'));
    const config = {
      enginePath: process.execPath,
      modelPath,
      projectorPath: '',
      contextSize: 8192,
      maxOutputTokens: 4096,
      gpuLayers: 0,
    };
    const generation = { ...initial.generation, autoAllow: true, maxIterations: 10000 };
    const bad = await api('settings', { config, generation: { ...generation, maxIterations: 10001 } });
    assert.equal(bad.status, 400);
    assert.equal((await (await api('bootstrap')).json()).config.modelPath, '');
    const result = await api('settings', {
      config,
      generation,
    });
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(await readFile(join(dataDir, 'generation.json'))).maxIterations, 10000);
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'config.json'))), config);
    assert.equal(
      (
        await api('settings', {
          config: { ...config, contextSize: 1 },
          generation: { ...generation, autoAllow: false },
        })
      ).status,
      400,
    );
    assert.equal(JSON.parse(await readFile(join(dataDir, 'generation.json'))).autoAllow, true);
    assert.equal((await api('start', {})).status, 202);
    const deadline = Date.now() + 10000;
    let status;
    do {
      status = await (await api('status')).json();
      if (status.state === 'ready') break;
      await new Promise(done => setTimeout(done, 30));
    } while (Date.now() < deadline);
    assert.equal(status.state, 'ready');
    assert.equal(
      (await api('files/choose', { kind: 'model' })).status,
      200,
      'Reading a candidate model path does not require unloading the current model.',
    );
    assert.equal((await api('files/choose', { kind: 'engine' })).status, 409);
    assert.equal((await (await api('bootstrap')).json()).config.modelPath, modelPath);
    assert.equal((await api('settings', { config, generation: { ...generation, maxIterations: 1 } })).status, 200);
    assert.equal((await (await api('status')).json()).state, 'ready');
    assert.equal((await api('settings', { config: { ...config, contextSize: 16384 }, generation })).status, 409);
    assert.equal(JSON.parse(await readFile(join(dataDir, 'generation.json'))).maxIterations, 1);
    await app.close();
    app = await createApplication(options);
    initial = await (await fetch(`${app.url}/api/bootstrap`)).json();
    assert.equal(initial.generation.maxIterations, 1);
    assert.deepEqual(initial.config, config);
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
