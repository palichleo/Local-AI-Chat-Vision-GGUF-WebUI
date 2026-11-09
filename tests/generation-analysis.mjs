import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server.mjs';
import { Gallery } from '../lib/gallery.mjs';
const png = 'data:image/png;base64,iVBORw0KGgo=';
test('partial photo and video analysis persists valid outputs without changing missing originals or their indices', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-partial-analysis-'));
  assert.equal(dirname(directory), tmpdir());
  const historyDir = join(directory, 'history');
  const app = await createApplication({ port: 0, dataDir: directory, historyDir }),
    gallery = new Gallery({ historyDir });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { token } = await (await fetch(app.url + '/api/bootstrap')).json();
  for (const video of [false, true]) {
    const record = {
      id: randomUUID(),
      conversationId: randomUUID(),
      workflowId: 'user-batch',
      workflowName: 'User batch',
      prompt: 'Generate a batch',
      parameters: {},
      comfyUrl: 'http://127.0.0.1:8188',
      createdAt: new Date().toISOString(),
      ...(video ? { mediaType: 'video' } : {}),
      outputs: [0, 1].map(i => ({
        source: { filename: i + (video ? '.mp4' : '.png'), subfolder: '', type: 'output' },
      })),
    };
    await gallery.put(record, { persist: true });
    const body = {
      conversationId: record.conversationId,
      id: record.id,
      images: [null, png],
      dimensions: [null, { width: 768, height: 512 }],
      ...(video
        ? {
            frames: [
              null,
              [
                { time: 0, url: png },
                { time: 1, url: png },
              ],
            ],
          }
        : {}),
    };
    const response = await fetch(app.url + '/api/gallery/analysis', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, await (response.status === 200 ? Promise.resolve('') : response.clone().text()));
    const restored = await new Gallery({ historyDir }).get(record.conversationId, record.id);
    assert.equal(restored.outputs[0].analysisDataUrl, undefined);
    assert.equal(restored.outputs[1].analysisDataUrl, png);
    assert.equal(restored.outputs[1].width, 768);
    assert.deepEqual(
      restored.outputs.map(output => output.source),
      record.outputs.map(output => output.source),
    );
    if (video) assert.equal(restored.outputs[1].analysisFrames.length, 2);
  }
});
