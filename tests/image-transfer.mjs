import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server.mjs';
import { ComfyGallery } from '../lib/comfy-gallery.mjs';

test('aborting a gallery original stops the upstream image transfer', { timeout: 6000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-image-transfer-'));
  let entered, closed;
  const arrived = new Promise(resolve => {
      entered = resolve;
    }),
    disconnected = new Promise(resolve => {
      closed = resolve;
    });
  const comfy = http.createServer((req, res) => {
    res.on('close', closed);
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.write(Buffer.from('89504e470d0a1a0a', 'hex'));
    entered();
  });
  let app, timer;
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
    await new ComfyGallery({ historyDir: join(directory, 'history') }).put(record, { persist: true });
    app = await createApplication({ port: 0, dataDir: directory });
    const { token } = await (await fetch(`${app.url}/api/bootstrap`)).json();
    const controller = new AbortController();
    const request = assert.rejects(
      fetch(`${app.url}/api/gallery/${record.conversationId}/${record.id}/0`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      }),
      { name: 'AbortError' },
    );
    await arrived;
    controller.abort();
    await request;
    await Promise.race([
      disconnected,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Upstream image transfer kept running after cancellation')), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    comfy.closeAllConnections();
    await new Promise(resolve => comfy.close(resolve));
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
