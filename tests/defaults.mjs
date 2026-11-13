import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server.mjs';

test('new installs save conversations by default and use ten generation attempts, while choices survive restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-defaults-'));
  let app;
  try {
    app = await createApplication({ port: 0, dataDir });
    let initial = await (await fetch(app.url + '/api/bootstrap')).json();
    assert.equal(initial.preferences.saveHistory, true);
    assert.equal(initial.generation.maxIterations, 10);
    assert.equal(initial.generation.reviewVideos, false, 'A video is not analysed by the model unless asked.');
    assert.equal(initial.generation.reviewImages, false, 'An image is not analysed by the model unless asked.');
    assert.equal(initial.generation.enabled, true, 'Local generation is on from the start.');
    assert.equal(initial.generation.autoAllowVideos, true, 'A video agreed on in the chat starts by itself.');
    assert.equal(initial.config.gpuLayers, 999, 'A new GPU configuration must not stop offloading after 99 layers.');
    const post = (path, body) =>
      fetch(app.url + '/api/' + path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${initial.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    assert.equal((await post('preferences', { saveHistory: false })).status, 200);
    assert.equal((await post('generation/config', { ...initial.generation, reviewVideos: 'yes' })).status, 400);
    assert.equal((await post('generation/config', { ...initial.generation, autoAllowVideos: 'yes' })).status, 400);
    assert.equal(
      (
        await post('generation/config', {
          ...initial.generation,
          maxIterations: 7,
          reviewVideos: true,
          reviewImages: true,
          autoAllowVideos: false,
        })
      ).status,
      200,
    );
    await app.close();
    app = await createApplication({ port: 0, dataDir });
    initial = await (await fetch(app.url + '/api/bootstrap')).json();
    assert.equal(initial.preferences.saveHistory, false);
    assert.equal(initial.generation.maxIterations, 7);
    assert.equal(initial.generation.reviewVideos, true);
    assert.equal(initial.generation.reviewImages, true);
    assert.equal(initial.generation.autoAllowVideos, false);
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
