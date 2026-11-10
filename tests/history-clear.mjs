import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server.mjs';
import { History } from '../lib/history.mjs';
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rLkAAAAASUVORK5CYII=';
const bytes = Buffer.from(png.split(',')[1], 'base64');
// An attached image is stored first, as given; the conversation refers to it by name.
const record = (id = randomUUID(), file = null) => ({
  id,
  messages: [
    {
      role: 'user',
      content: [{ type: 'text', text: 'Conversation de test' }, ...(file ? [{ type: 'image_url', file }] : [])],
    },
  ],
});

test('supprimer l’historique exige confirmation et jeton, fonctionne même désactivé et préserve les préférences', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-clear-'));
  const historyDir = join(dataDir, 'history');
  let app;
  try {
    app = await createApplication({ port: 0, dataDir, historyDir });
    const initial = await (await fetch(`${app.url}/api/bootstrap`)).json();
    const post = (route, data, token = initial.token) =>
      fetch(`${app.url}/api/${route}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    for (const enabled of [true, false]) {
      await post('preferences', { saveHistory: true, theme: 'light' });
      const id = randomUUID();
      const { file } = await (
        await fetch(`${app.url}/api/attachments`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${initial.token}`, 'Content-Type': 'image/png', 'X-Conversation-Id': id },
          body: bytes,
        })
      ).json();
      const saved = record(id, file);
      assert.equal((await post('history/save', saved)).status, 200);
      if (!enabled) await post('preferences', { saveHistory: false });
      const before = JSON.parse(await readFile(join(dataDir, 'preferences.json'), 'utf8'));
      await writeFile(join(dataDir, 'outside.txt'), 'À conserver');
      const conditioning = join(dataDir, 'generation-cache', 'conditioning');
      await mkdir(conditioning, { recursive: true });
      await writeFile(join(conditioning, 'a'.repeat(64) + '.safetensors'), 'derived from a prompt');
      await writeFile(join(dataDir, 'generation-cache', 'weights.safetensors'), 'model cache');
      assert.equal((await post('history/clear', { confirm: true }, '')).status, 401);
      assert.equal((await post('history/clear', {})).status, 400);
      assert.equal((await post('history/clear', { confirm: false })).status, 400);
      assert.ok((await readdir(join(historyDir, saved.id))).some(name => name.startsWith('original-')));
      const deleted = await post('history/clear', { confirm: true });
      assert.equal(deleted.status, 200);
      assert.deepEqual(await deleted.json(), { cleared: true });
      await assert.rejects(readdir(historyDir), { code: 'ENOENT' });
      assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'preferences.json'), 'utf8')), before);
      assert.equal(await readFile(join(dataDir, 'outside.txt'), 'utf8'), 'À conserver');
      await assert.rejects(readdir(conditioning), { code: 'ENOENT' });
      assert.equal(await readFile(join(dataDir, 'generation-cache', 'weights.safetensors'), 'utf8'), 'model cache');
      assert.equal((await post('history/clear', { confirm: true })).status, 200);
    }
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('la suppression attend les sauvegardes déjà acceptées puis permet de nouveaux échanges', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'atelier-clear-'));
  try {
    const directory = join(folder, 'history');
    const history = new History(directory);
    const first = randomUUID();
    const { file } = await history.addOriginal(first, [bytes]);
    const saved = history.save(record(first, file));
    const cleared = history.clear();
    await Promise.all([saved, cleared]);
    await assert.rejects(readdir(directory), { code: 'ENOENT' });
    assert.deepEqual(await history.list(), { conversations: [], skipped: 0 });
    const id = randomUUID();
    const fresh = record(id, (await history.addOriginal(id, [bytes])).file);
    await history.save(fresh);
    assert.equal((await history.list()).conversations.length, 1);
    assert.deepEqual((await history.read(fresh.id)).messages, fresh.messages);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('la suppression refuse un autre dossier et un lien pointant hors de history', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'atelier-clear-'));
  try {
    const outside = join(folder, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'keep.txt'), 'Intact');
    await assert.rejects(new History(outside).clear());
    await symlink(outside, join(folder, 'history'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(new History(join(folder, 'history')).clear());
    assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'Intact');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
