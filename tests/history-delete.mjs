import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server.mjs';
import { History } from '../lib/history.mjs';
import { Gallery } from '../lib/gallery.mjs';
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rLkAAAAASUVORK5CYII=';

test('deleting one conversation removes copies and cached links, retaining other chats and originals', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-delete-')),
    historyDir = join(dataDir, 'history');
  let app;
  try {
    app = await createApplication({ port: 0, dataDir, historyDir });
    const bootstrap = await (await fetch(app.url + '/api/bootstrap')).json();
    const call = (route, body, token = bootstrap.token) =>
      fetch(app.url + '/api/' + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    await call('preferences', { saveHistory: true });
    const ids = [randomUUID(), randomUUID()],
      runs = [];
    const gallery = new Gallery({ historyDir });
    const original = join(dataDir, 'original.png');
    await writeFile(original, Buffer.from(png.split(',')[1], 'base64'));
    for (const id of ids) {
      assert.equal(
        (
          await call('history/save', {
            id,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: id },
                  { type: 'image_url', image_url: { url: png } },
                ],
              },
            ],
          })
        ).status,
        200,
      );
      const run = {
        id: randomUUID(),
        conversationId: id,
        workflowId: 'test',
        workflowName: 'Test',
        prompt: 'Blue cup',
        parameters: {},
        comfyUrl: 'http://127.0.0.1:8188',
        createdAt: new Date().toISOString(),
        outputs: [{ source: { filename: 'original.png', subfolder: '', type: 'output' }, analysisDataUrl: png }],
      };
      runs.push(run);
      await gallery.put(run, { persist: true });
      assert.equal((await call(`gallery/${id}/${run.id}`)).status, 200);
    }
    assert.equal((await call('history/delete', { id: ids[0], confirm: true }, '')).status, 401);
    assert.equal((await call('history/delete', { id: ids[0] })).status, 400);
    assert.equal((await call('history/delete', { id: '../escape', confirm: true })).status, 400);
    assert.equal((await call('history/delete', { id: ids[0], confirm: true })).status, 200);
    await assert.rejects(readdir(join(historyDir, ids[0])), { code: 'ENOENT' });
    assert.equal((await call(`history/${ids[0]}`)).status, 404);
    assert.equal((await call(`gallery/${ids[0]}/${runs[0].id}`)).status, 404);
    assert.equal((await call(`gallery/${ids[1]}/${runs[1].id}`)).status, 200);
    assert.deepEqual(
      (await (await call('history')).json()).conversations.map(item => item.id),
      [ids[1]],
    );
    assert.deepEqual(await readFile(original), Buffer.from(png.split(',')[1], 'base64'));
    await call('preferences', { saveHistory: false });
    assert.equal((await call('history/delete', { id: ids[1], confirm: true })).status, 200);
    assert.equal((await call('history/delete', { id: ids[1], confirm: true })).status, 200);
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'preferences.json'), 'utf8')), {
      theme: 'dark',
      saveHistory: false,
    });
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('conversation removal waits for accepted saves and rejects directory links and traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atelier-delete-'));
  try {
    const history = new History(join(root, 'history')),
      id = randomUUID(),
      other = randomUUID();
    const input = id => ({ id, messages: [{ role: 'user', content: 'Keep' }] });
    const saved = history.save(input(id)),
      removed = history.remove(id);
    await Promise.all([saved, removed]);
    assert.deepEqual((await history.list()).conversations, []);
    await history.save(input(other));
    await assert.rejects(history.remove('../outside'));
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'keep.txt'), 'Intact');
    const linked = randomUUID();
    await symlink(outside, join(history.directory, linked), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(history.remove(linked));
    assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'Intact');
    assert.deepEqual((await history.read(other)).messages, input(other).messages);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an accepted gallery update prevents deletion until its write finishes', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-delete-')),
    historyDir = join(dataDir, 'history');
  let app, pending, release;
  const originalPut = Gallery.prototype.put;
  try {
    app = await createApplication({ port: 0, dataDir, historyDir });
    const bootstrap = await (await fetch(app.url + '/api/bootstrap')).json();
    const call = (route, body) =>
      fetch(app.url + '/api/' + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bootstrap.token}` },
        body: JSON.stringify(body),
      });
    await call('preferences', { saveHistory: true });
    const id = randomUUID(),
      run = {
        id: randomUUID(),
        conversationId: id,
        workflowId: 'test',
        workflowName: 'Test',
        prompt: 'Cup',
        parameters: {},
        comfyUrl: 'http://127.0.0.1:8188',
        createdAt: new Date().toISOString(),
        outputs: [{ source: { filename: 'original.png', subfolder: '', type: 'output' } }],
      };
    await call('history/save', { id, messages: [{ role: 'user', content: 'Cup' }] });
    await new Gallery({ historyDir }).put(run, { persist: true });
    let entered;
    const started = new Promise(resolve => {
        entered = resolve;
      }),
      gate = new Promise(resolve => {
        release = resolve;
      });
    Gallery.prototype.put = async function (input, options) {
      if (input.id === run.id) {
        entered();
        await gate;
      }
      return originalPut.call(this, input, options);
    };
    pending = call('gallery/analysis', { conversationId: id, id: run.id, images: [png] });
    await started;
    assert.equal((await call('history/delete', { id, confirm: true })).status, 409);
    release();
    assert.equal((await pending).status, 200);
    assert.equal((await call('history/delete', { id, confirm: true })).status, 200);
  } finally {
    release?.();
    await pending;
    Gallery.prototype.put = originalPut;
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
