import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server.mjs';

test('new installs save conversations by default and use five generation attempts, while choices survive restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-defaults-'));
  let app;
  try {
    app = await createApplication({ port: 0, dataDir });
    let initial = await (await fetch(app.url + '/api/bootstrap')).json();
    assert.equal(initial.preferences.saveHistory, true);
    assert.equal(initial.comfy.maxIterations, 5);
    const post = (path, body) => fetch(app.url + '/api/' + path, { method: 'POST', headers: { Authorization: `Bearer ${initial.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('preferences', { saveHistory: false })).status, 200);
    assert.equal((await post('comfy/config', { ...initial.comfy, maxIterations: 7 })).status, 200);
    await app.close(); app = await createApplication({ port: 0, dataDir });
    initial = await (await fetch(app.url + '/api/bootstrap')).json();
    assert.equal(initial.preferences.saveHistory, false);
    assert.equal(initial.comfy.maxIterations, 7);
  } finally { await app?.close(); await rm(dataDir, { recursive: true, force: true }); }
});
