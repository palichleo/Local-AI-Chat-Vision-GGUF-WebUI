import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server.mjs';
import { History } from '../lib/history.mjs';

const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rLkAAAAASUVORK5CYII=';

test('history stays ordered by creation after an old conversation is saved again and reopened', async t => {
  const root = await mkdtemp(join(tmpdir(), 'atelier-history-order-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'history'),
    history = new History(directory),
    older = randomUUID(),
    newer = randomUUID(),
    messages = [{ role: 'user', content: 'Keep this conversation' }];
  for (const [id, createdAt] of [
    [older, '2026-11-07T00:00:00.000Z'],
    [newer, '2026-11-08T00:00:00.000Z'],
  ]) {
    await history.save({ id, messages });
    const path = join(directory, id, 'conversation.json'),
      stored = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...stored, createdAt, updatedAt: createdAt }));
  }
  assert.deepEqual(
    (await history.list()).conversations.map(item => item.id),
    [newer, older],
  );
  const resaved = await history.save({
    id: older,
    messages: [...messages, { role: 'assistant', content: 'A later reply' }],
  });
  assert.equal(resaved.createdAt, '2026-11-07T00:00:00.000Z');
  assert.ok(resaved.updatedAt > resaved.createdAt);
  assert.deepEqual(
    (await history.list()).conversations.map(item => item.id),
    [newer, older],
  );
  assert.deepEqual(
    (await new History(directory).list()).conversations.map(item => item.id),
    [newer, older],
  );
});

test('historique optionnel : l’original joint est conservé, les copies du modèle jamais', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'atelier-history-'));
  const historyDir = join(folder, 'history');
  const id = randomUUID();
  let app, token;
  const call = async (route, body, auth = token) =>
    fetch(`${app.url}/api/${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const original = Buffer.from(png.split(',')[1], 'base64');
  const upload = conversationId =>
    fetch(`${app.url}/api/attachments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png', 'X-Conversation-Id': conversationId },
      body: original,
    });
  try {
    app = await createApplication({ port: 0, dataDir: folder, historyDir });
    token = (await (await fetch(`${app.url}/api/bootstrap`)).json()).token;
    const stored = await (await upload(id)).json();
    assert.match(stored.file, /^original-[0-9a-f]{64}\.png$/);
    assert.deepEqual(Buffer.from(await (await fetch(app.url + stored.view)).arrayBuffer()), original);
    assert.equal((await upload(id)).status, 201, 'the same image is stored once');
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Une image à conserver' },
          { type: 'image_url', image_url: { url: png }, file: stored.file },
        ],
      },
      { role: 'assistant', content: '**Réponse**', reasoning_content: 'Réflexion.' },
      {
        role: 'user',
        internal: true,
        content: [
          { type: 'text', text: 'Copie compressée pour ce tour.' },
          { type: 'image_url', image_url: { url: png } },
        ],
      },
    ];
    assert.equal((await call('preferences', { saveHistory: false })).status, 200);
    assert.equal((await call('history/save', { id, messages })).status, 403);
    assert.equal((await call('preferences', { saveHistory: true })).status, 200);
    assert.equal((await call('history/save', { id, messages }, '')).status, 401);
    const unsaved = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: png } }] }];
    assert.equal((await call('history/save', { id, messages: unsaved })).status, 400, 'a compressed copy is not kept');
    assert.equal((await call('history/save', { id, messages, incomplete: true })).status, 200);
    assert.equal((await call('history/save', { id, messages })).status, 200);
    const files = await readdir(join(historyDir, id));
    assert.deepEqual(files.sort(), ['conversation.json', stored.file]);
    assert.ok(!(await readFile(join(historyDir, id, 'conversation.json'), 'utf8').then(s => s.includes('base64,'))));
    await app.close();
    app = await createApplication({ port: 0, dataDir: folder, historyDir });
    token = (await (await fetch(`${app.url}/api/bootstrap`)).json()).token;
    const list = await (await call('history')).json();
    assert.equal(list.conversations.length, 1);
    const loaded = await (await call(`history/${id}`)).json();
    const image = loaded.messages[0].content[1];
    assert.equal(image.file, stored.file);
    assert.equal(image.image_url, undefined, 'the model’s copy is made again in the session');
    assert.deepEqual(Buffer.from(await (await fetch(app.url + image.view)).arrayBuffer()), original);
    assert.deepEqual(loaded.messages[2].content, [{ type: 'text', text: 'Copie compressée pour ce tour.' }]);
    const read = await fetch(`${app.url}/api/attachments/${id}/${stored.file}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.deepEqual(Buffer.from(await read.arrayBuffer()), original);
    assert.equal((await fetch(app.url + image.view.replace(/key=.*/, 'key=' + '0'.repeat(64)))).status, 401);
    assert.equal((await call('history/save', { id, messages: loaded.messages })).status, 200, 'a reopened conversation saves again');
    assert.equal((await call('preferences', { saveHistory: false })).status, 200);
    assert.equal((await call('history')).status, 403);
    assert.ok((await readdir(join(historyDir, id))).includes('conversation.json'), 'Désactiver ne doit pas effacer les fichiers.');
  } finally {
    await app?.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('les images jointes d’une conversation jamais enregistrée sont retirées au démarrage suivant', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'atelier-history-'));
  const historyDir = join(folder, 'history');
  const saved = randomUUID(),
    unsaved = randomUUID();
  let app;
  try {
    app = await createApplication({ port: 0, dataDir: folder, historyDir });
    const { token } = await (await fetch(`${app.url}/api/bootstrap`)).json();
    for (const id of [saved, unsaved])
      await fetch(`${app.url}/api/attachments`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png', 'X-Conversation-Id': id },
        body: Buffer.from(png.split(',')[1], 'base64'),
      });
    await fetch(`${app.url}/api/history/save`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: saved, messages: [{ role: 'user', content: 'Kept' }] }),
    });
    await app.close();
    app = await createApplication({ port: 0, dataDir: folder, historyDir });
    assert.deepEqual((await readdir(historyDir)).sort(), [saved]);
  } finally {
    await app?.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('historique : données invalides, chemins et fichiers endommagés sont contrôlés', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'atelier-history-'));
  let app;
  try {
    app = await createApplication({ port: 0, dataDir: folder, historyDir: join(folder, 'history') });
    const { token } = await (await fetch(`${app.url}/api/bootstrap`)).json();
    const post = (route, data) =>
      fetch(`${app.url}/api/${route}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    const get = route => fetch(`${app.url}/api/${route}`, { headers: { Authorization: `Bearer ${token}` } });
    await post('preferences', { saveHistory: true });
    const id = randomUUID();
    for (const invalid of [
      { id: '../escape', messages: [{ role: 'user', content: 'x' }] },
      { id, messages: [{ role: 'system', content: 'x' }] },
      {
        id,
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'image-../../secret.png' } }] }],
      },
      {
        id,
        messages: [
          { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,SGVsbG8=' } }] },
        ],
      },
    ])
      assert.equal((await post('history/save', invalid)).status, 400);
    assert.equal((await get(`history/${randomUUID()}`)).status, 404);
    await post('history/save', { id, messages: [{ role: 'user', content: 'Conservé' }], incomplete: true });
    const loaded = await (await get(`history/${id}`)).json();
    assert.equal(loaded.incomplete, true);
    assert.equal(loaded.messages.at(-1).role, 'user');
    const other = randomUUID();
    await post('history/save', { id: other, messages: [{ role: 'user', content: 'Endommagé' }] });
    await writeFile(join(folder, 'history', other, 'conversation.json'), '{');
    const malformed = randomUUID();
    await post('history/save', { id: malformed, messages: [{ role: 'user', content: 'Date incorrecte' }] });
    const malformedPath = join(folder, 'history', malformed, 'conversation.json');
    const malformedData = JSON.parse(await readFile(malformedPath, 'utf8'));
    malformedData.updatedAt = 2026;
    await writeFile(malformedPath, JSON.stringify(malformedData));
    const list = await (await get('history')).json();
    assert.equal(list.conversations.length, 1);
    assert.equal(list.skipped, 2);
    assert.equal((await post('preferences', { saveHistory: 'true' })).status, 400);
  } finally {
    await app?.close();
    await rm(folder, { recursive: true, force: true });
  }
});
