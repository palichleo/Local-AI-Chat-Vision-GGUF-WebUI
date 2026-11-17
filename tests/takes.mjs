import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Gallery } from '../lib/gallery.mjs';
import { History } from '../lib/history.mjs';
import { Takes, numbered } from '../lib/takes.mjs';
import { createApplication } from '../server.mjs';

// The numbers of the takes, « PRISE n » (reference-maquettes.md): one counter per project, in
// the order of creation; a number never changes but by a move of project, never given twice.
const run = (conversationId, createdAt, count = 1, extra = {}) => ({
  id: randomUUID(),
  conversationId,
  workflowId: 'krea2',
  workflowName: 'Krea 2',
  prompt: 'Un renard',
  parameters: {},
  provider: 'native',
  mediaType: 'image',
  createdAt,
  outputs: Array.from({ length: count }, (_, index) => ({
    source: { filename: `renard-${createdAt.slice(0, 10)}-${index}.png`, subfolder: '', type: 'output' },
  })),
  ...extra,
});
async function folder(t, name) {
  const root = await mkdtemp(join(tmpdir(), `atelier-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('a counter per project: the numbers follow one another, are kept on the disk, and never go down', async t => {
  const p1 = randomUUID(),
    root = await folder(t, 'takes'),
    path = join(root, 'takes.json'),
    takes = new Takes(path);
  assert.equal(await takes.ready(), false, 'no file yet: the takes of earlier versions are to be numbered');
  assert.deepEqual(await takes.next('inbox', 3), [1, 2, 3]);
  assert.deepEqual(await takes.next(p1, 2), [1, 2]);
  assert.deepEqual(await takes.next('inbox', 1), [4]);
  assert.deepEqual(await takes.next('inbox', 0), []);
  const again = new Takes(path);
  assert.equal(await again.ready(), true);
  assert.deepEqual([await again.last('inbox'), await again.last(p1), await again.last(randomUUID())], [4, 2, 0]);
  await again.raise({ inbox: 2, [p1]: 9 });
  assert.deepEqual([await again.last('inbox'), await again.last(p1)], [4, 9], 'raised, never lowered');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 1, projects: { inbox: 4, [p1]: 9 } });
  await assert.rejects(again.next('../x', 1));
});

test('the takes of earlier versions: numbered in their order of creation, a number given is kept', () => {
  const runs = [
    { id: 'c', createdAt: '2026-11-03', outputs: [{}] },
    { id: 'a', createdAt: '2026-11-01', outputs: [{}, {}] },
    { id: 'b', createdAt: '2026-11-02', outputs: [{ take: 7 }] },
  ];
  const { changed, last } = numbered(runs);
  assert.deepEqual(
    changed.map(item => [item.run.id, item.takes]),
    [
      ['a', [8, 9]],
      ['c', [10]],
    ],
  );
  assert.equal(last, 10);
  assert.deepEqual(numbered([]), { changed: [], last: 0 });
});

test('a take is numbered as it is made, once; saved again it keeps its number; given another, it is written', async t => {
  const root = await folder(t, 'gallery-takes'),
    takes = new Takes(join(root, 'takes.json')),
    asked = [];
  const gallery = new Gallery({
    historyDir: join(root, 'history'),
    numbering: (conversationId, count) => {
      asked.push([conversationId, count]);
      return takes.next('inbox', count);
    },
  });
  const conversation = randomUUID(),
    three = run(conversation, '2026-11-16T10:00:00.000Z', 3);
  const made = await gallery.put(three, { persist: true });
  assert.deepEqual(made.outputs.map(output => output.take), [1, 2, 3]);
  // Saved again (its analysis copies, a later step): the same numbers, nothing asked again.
  await gallery.put(three, { persist: true });
  assert.deepEqual(asked, [[conversation, 3]]);
  const read = await gallery.get(conversation, three.id, { includeImages: false });
  assert.deepEqual(read.outputs.map(output => output.take), [1, 2, 3]);
  const manifest = JSON.parse(await readFile(join(root, 'history', conversation, 'generated', three.id, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.outputs.map(output => output.take), [1, 2, 3]);
  // Its conversation moved: other numbers, written in its manifest.
  await gallery.setTakes(conversation, three.id, [33, 34, 35]);
  assert.deepEqual((await gallery.list(conversation, { includeImages: false })).runs[0].outputs.map(output => output.take), [33, 34, 35]);
  await assert.rejects(gallery.setTakes(conversation, three.id, [0]), /Numéro de prise invalide/);
  // Kept in memory only (history off): numbered all the same.
  const unsaved = await gallery.put(run(randomUUID(), '2026-11-16T11:00:00.000Z'), { persist: false });
  assert.deepEqual(unsaved.outputs.map(output => output.take), [4]);
  // Without numbering (or when it fails), a take is made without a number.
  const plain = new Gallery({ historyDir: join(root, 'history') });
  assert.equal((await plain.put(run(randomUUID(), '2026-11-16T12:00:00.000Z'))).outputs[0].take, undefined);
  const failing = new Gallery({ historyDir: join(root, 'history'), numbering: async () => Promise.reject(new Error('disque plein')) });
  assert.equal((await failing.put(run(randomUUID(), '2026-11-16T12:00:00.000Z'))).outputs[0].take, undefined);
});

test('the server: earlier takes numbered once at launch; a move and a deleted project give the numbers that follow', async t => {
  const dataDir = await folder(t, 'takes-app'),
    historyDir = join(dataDir, 'history');
  // Before the numbers: two projects, takes made in an order that crosses them.
  const history = new History(historyDir),
    first = randomUUID(),
    second = randomUUID(),
    loose = randomUUID();
  await history.save({ id: first, projectId: 'inbox', messages: [{ role: 'user', content: 'Premier' }] });
  await history.save({ id: second, projectId: 'inbox', messages: [{ role: 'user', content: 'Second' }] });
  const before = new Gallery({ historyDir });
  const runs = [
    run(second, '2026-11-02T00:00:00.000Z', 2),
    run(first, '2026-11-01T00:00:00.000Z'),
    run(first, '2026-11-03T00:00:00.000Z'),
    run(loose, '2026-11-04T00:00:00.000Z'),
  ];
  for (const item of runs) await before.put(item, { persist: true });
  let app;
  try {
    app = await createApplication({ port: 0, dataDir, historyDir });
    const bootstrap = await (await fetch(app.url + '/api/bootstrap')).json();
    const call = (route, body) =>
      fetch(app.url + '/api/' + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bootstrap.token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    await call('preferences', { saveHistory: true });
    const takesOf = async conversation =>
      (await (await call(`gallery/${conversation}?images=0`)).json()).runs
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .flatMap(item => item.outputs.map(output => output.take));
    // In the order of their creation, every conversation of « Sans projet » together.
    assert.deepEqual(await takesOf(first), [1, 4]);
    assert.deepEqual(await takesOf(second), [2, 3]);
    assert.deepEqual(await takesOf(loose), [5], 'a conversation never saved is « Sans projet »');
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'takes.json'), 'utf8')).projects, { inbox: 5 });
    // What a move would give, said before it is made.
    const { project } = await (await call('projects/save', { name: 'Clips de Noël' })).json();
    assert.deepEqual(await (await call(`takes/preview?conversation=${second}&project=${project.id}`)).json(), { count: 2, first: 1, last: 2 });
    // Moved: the numbers that follow in its new project; the others keep theirs.
    assert.equal((await call('projects/move', { id: second, projectId: project.id })).status, 200);
    assert.deepEqual(await takesOf(second), [1, 2]);
    assert.deepEqual(await takesOf(first), [1, 4]);
    // Its project deleted: back in « Sans projet », after its counter (never two « PRISE 2 »).
    assert.equal((await call('projects/delete', { id: project.id, confirm: true })).status, 200);
    assert.deepEqual(await takesOf(second), [6, 7]);
    assert.deepEqual(await (await call(`takes/preview?conversation=${first}&project=inbox`)).json(), { count: 2, first: 8, last: 9 });
  } finally {
    await app?.close();
  }
  // Launched again: nothing numbered twice.
  let again;
  try {
    again = await createApplication({ port: 0, dataDir, historyDir });
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'takes.json'), 'utf8')).projects.inbox, 7);
  } finally {
    await again?.close();
  }
});

test('counters that cannot be read at that instant are read again, never counted from nothing nor written over', async t => {
  const root = await folder(t, 'takes-unread'),
    path = join(root, 'takes.json');
  await writeFile(path, JSON.stringify({ version: 1, projects: { inbox: 3, film: 7 } }));
  // The file cannot be read for a moment (held by another program): here, a folder in its place.
  const real = await readFile(path);
  await rm(path);
  await mkdir(path);
  const takes = new Takes(path);
  await assert.rejects(takes.next('inbox', 1));
  // Readable again: the real counters, the numbers that follow.
  await rm(path, { recursive: true });
  await writeFile(path, real);
  assert.deepEqual(await takes.next('inbox', 2), [4, 5]);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).projects, { inbox: 5, film: 7 });
});

test('a manifest that is being read is still given its new numbers (the replacement is tried again)', async t => {
  const root = await folder(t, 'gallery-held'),
    gallery = new Gallery({ historyDir: join(root, 'history'), numbering: async (_, count) => Array.from({ length: count }, (_, index) => index + 1) }),
    conversation = randomUUID(),
    made = run(conversation, '2026-11-16T10:00:00.000Z', 2);
  await gallery.put(made, { persist: true });
  const manifest = join(root, 'history', conversation, 'generated', made.id, 'manifest.json');
  // Held open as a reader holds it (on Windows the file cannot be replaced meanwhile), then let go.
  const reader = await open(manifest, 'r');
  const release = new Promise(resolve => setTimeout(() => resolve(reader.close()), 120));
  await gallery.setTakes(conversation, made.id, [8, 9]);
  await release;
  assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')).outputs.map(output => output.take), [8, 9]);
});
