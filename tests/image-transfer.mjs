import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server.mjs';
import { Gallery } from '../lib/gallery.mjs';

test('a ComfyUI-era gallery record stays listed but its original is reported unavailable without contacting Comfy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-legacy-original-'));
  let contacted = false;
  const comfy = http.createServer((_req, res) => {
    contacted = true;
    res.end();
  });
  let app;
  try {
    await new Promise(resolve => comfy.listen(0, '127.0.0.1', resolve));
    const record = {
      id: randomUUID(),
      conversationId: randomUUID(),
      workflowId: 'test',
      workflowName: 'Test',
      prompt: 'Image',
      parameters: {},
      createdAt: new Date().toISOString(),
      comfyUrl: `http://127.0.0.1:${comfy.address().port}`,
      outputs: [{ source: { filename: 'test.png', subfolder: '', type: 'output' } }],
    };
    await new Gallery({ historyDir: join(directory, 'history') }).put(record, { persist: true });
    app = await createApplication({ port: 0, dataDir: directory });
    const { token } = await (await fetch(`${app.url}/api/bootstrap`)).json();
    const headers = { Authorization: `Bearer ${token}` };
    const listed = await (await fetch(`${app.url}/api/gallery/${record.conversationId}`, { headers })).json();
    assert.equal(listed.runs.length, 1);
    const original = await fetch(`${app.url}/api/gallery/${record.conversationId}/${record.id}/0`, { headers });
    assert.equal(original.status, 410);
    assert.match((await original.json()).error, /ComfyUI non disponible/);
    assert.equal(contacted, false);
  } finally {
    comfy.closeAllConnections();
    await new Promise(resolve => comfy.close(resolve));
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
