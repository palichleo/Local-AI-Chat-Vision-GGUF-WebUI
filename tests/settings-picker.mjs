import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server.mjs';

test('an open file picker excludes model start, settings writes and other pickers', { timeout: 10000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-picker-lock-'));
  let app, release;
  let entered;
  const arrived = new Promise(resolve => {
    entered = resolve;
  });
  try {
    app = await createApplication({
      port: 0,
      dataDir,
      filePicker: async () => {
        entered();
        return new Promise(resolve => {
          release = resolve;
        });
      },
    });
    const initial = await (await fetch(`${app.url}/api/bootstrap`)).json();
    const api = (route, body) =>
      fetch(`${app.url}/api/${route}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${initial.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const pending = api('files/choose', { kind: 'model' });
    await arrived;
    for (const [route, body] of [
      ['start', {}],
      ['config', initial.config],
      ['settings', { config: initial.config, comfy: initial.comfy }],
      ['files/choose', { kind: 'engine' }],
    ]) {
      await t.test(route, async () => {
        const response = await api(route, body);
        assert.equal(response.status, 409, await response.text());
      });
    }
    release(null);
    assert.equal((await pending).status, 200);
    assert.equal((await api('config', initial.config)).status, 200);
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'config.json'))), initial.config);
  } finally {
    release?.(null);
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('disconnecting cancels the picker and a new request can select a file', { timeout: 10000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-picker-abort-'));
  let app,
    entered,
    aborted,
    calls = 0;
  const arrived = new Promise(resolve => {
    entered = resolve;
  });
  const canceled = new Promise(resolve => {
    aborted = resolve;
  });
  try {
    app = await createApplication({
      port: 0,
      dataDir,
      filePicker: async (_kind, { signal }) => {
        if (++calls > 1) return join(dataDir, 'model.gguf');
        return new Promise((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted();
              reject(signal.reason);
            },
            { once: true },
          );
          entered();
        });
      },
    });
    const { token } = await (await fetch(`${app.url}/api/bootstrap`)).json();
    const api = signal =>
      fetch(`${app.url}/api/files/choose`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'model' }),
        signal,
      });
    const controller = new AbortController();
    const pending = assert.rejects(api(controller.signal), { name: 'AbortError' });
    await arrived;
    controller.abort();
    await pending;
    await canceled;
    const response = await api();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).path, join(dataDir, 'model.gguf'));
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
