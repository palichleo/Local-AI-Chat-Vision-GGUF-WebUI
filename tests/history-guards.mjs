import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server.mjs';
import { History } from '../lib/history.mjs';
import { HistoryJournal } from '../lib/history-journal.mjs';
import { Gallery } from '../lib/gallery.mjs';
import { atomicFile } from '../lib/update-files.mjs';
import { updateSession } from '../lib/update-session.mjs';

/**
 * What protects a conversation of the history (0.6.103). A friend saw his conversation « se
 * supprimer », and nothing could tell what had happened to it: deletions were erased at once and said
 * nowhere, a file left zeros by a computer cut off hid its conversation for good, a copy of a first save
 * held by Windows was erased at the next launch, and a tab left on an older copy wrote over another's.
 */
const conversation = (id, count, words = 'Fais une image') => ({
  id,
  messages: Array.from({ length: count }, (_, index) =>
    index % 2 ? { role: 'assistant', content: `Réponse ${index}` } : { role: 'user', content: `${words} ${index}` },
  ),
});
async function folder(t, name = 'moodix-guards-') {
  const root = await mkdtemp(join(tmpdir(), name));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const lines = async path => (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const take = (conversationId, callId = 'call_serie') => ({
  id: randomUUID(),
  conversationId,
  callId,
  workflowId: 'test',
  workflowName: 'Test',
  prompt: 'Un renard',
  parameters: {},
  comfyUrl: 'http://127.0.0.1:8188',
  createdAt: new Date().toISOString(),
  outputs: [{ source: { filename: 'a.png', subfolder: '', type: 'output' } }],
});
async function server(t, dataDir) {
  const historyDir = join(dataDir, 'history'),
    app = await createApplication({ port: 0, dataDir, historyDir });
  t.after(() => app.close());
  const { token } = await (await fetch(app.url + '/api/bootstrap')).json();
  const call = (route, body, tab = 'onglet-1') =>
    fetch(app.url + '/api/' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Moodix-Tab': tab },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { app, call, historyDir, journal: join(dataDir, 'history-journal.jsonl') };
}

test('a conversation deleted by hand goes to the bin, is listed there, given back, then erased for good; each step a line of the journal, never its words', async t => {
  const dataDir = await folder(t),
    { call, historyDir, journal } = await server(t, dataDir),
    id = randomUUID();
  assert.equal((await call('history/save', conversation(id, 4, 'Mots secrets'))).status, 200);
  await new Gallery({ historyDir }).put(take(id), { persist: true });
  const deleted = await call('history/delete', { id, confirm: true });
  assert.deepEqual(await deleted.json(), { deleted: id, trashed: true });
  // Out of the history, its folder whole in the bin (its take with it).
  assert.equal((await (await call('history')).json()).conversations.length, 0);
  assert.deepEqual(await readdir(join(historyDir, '.corbeille')), [id]);
  const [listed] = (await (await call('history/trash')).json()).conversations;
  assert.deepEqual(
    { id: listed.id, title: listed.title, reason: listed.reason, messages: listed.messages, takes: listed.takes },
    { id, title: 'Mots secrets 0', reason: 'user', messages: 4, takes: 1 },
  );
  assert.ok(Date.now() - Date.parse(listed.deletedAt) < 60000);
  // « Restaurer »: back as it was, its take too.
  const restored = await call('history/restore', { id });
  assert.equal((await restored.json()).conversation.id, id);
  assert.equal((await (await call(`history/${id}`)).json()).messages.length, 4);
  assert.equal((await (await call(`gallery/${id}?images=0`)).json()).runs.length, 1);
  assert.deepEqual((await (await call('history/trash')).json()).conversations, []);
  // Deleted again, then « Supprimer définitivement »: asked first, then gone for good.
  await call('history/delete', { id, confirm: true });
  assert.equal((await call('history/erase', { id })).status, 400);
  assert.deepEqual(await (await call('history/erase', { id, confirm: true })).json(), { erased: true });
  await assert.rejects(readdir(join(historyDir, '.corbeille', id)), { code: 'ENOENT' });
  // The journal: one line each, with who asked and the version, and never what it said.
  const said = await lines(journal);
  assert.deepEqual(
    said.map(({ event, id: which, reason, tab, messages, takes }) => [event, which, reason, tab, messages, takes]),
    [
      ['corbeille', id, 'user', 'onglet-1', 4, 1],
      ['restaurée', id, 'user', 'onglet-1', 4, 1],
      ['corbeille', id, 'user', 'onglet-1', 4, 1],
      ['effacée', id, 'user', 'onglet-1', 4, 1],
    ],
  );
  assert.ok(said.every(line => line.title === 'Mots secrets 0' && Number.isFinite(Date.parse(line.date)) && /^\d+\.\d+\.\d+$/.test(line.version)));
  assert.equal((await readFile(journal, 'utf8')).includes('Réponse 1'), false, 'never its messages');
});

test('« Supprimer l’historique » puts every conversation in the bin, each said; a restore never writes over one there', async t => {
  const dataDir = await folder(t),
    { call, historyDir, journal } = await server(t, dataDir),
    ids = [randomUUID(), randomUUID()];
  for (const id of ids) await call('history/save', conversation(id, 2));
  assert.deepEqual(await (await call('history/clear', { confirm: true })).json(), { cleared: true, trashed: 2 });
  assert.deepEqual((await readdir(join(historyDir, '.corbeille'))).sort(), [...ids].sort());
  assert.deepEqual((await lines(journal)).map(line => [line.event, line.reason]), [['corbeille', 'user-all'], ['corbeille', 'user-all']]);
  // Saved again meanwhile from a tab that still had it: given back, it would write over that one.
  await call('history/save', conversation(ids[0], 2));
  const refused = await call('history/restore', { id: ids[0] });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /déjà dans l’historique : rien n’a été remplacé/);
  assert.equal((await call('history/restore', { id: ids[1] })).status, 200);
});

test('a deletion the page asks by itself goes only when the disk has nothing of the user: refused and said otherwise', async t => {
  const dataDir = await folder(t),
    { call, historyDir, journal } = await server(t, dataDir),
    studioLine = { role: 'user', internal: true, content: 'Studio · Vidéo : un chat saute\n\n(Créée dans le Studio.)' },
    studioCall = { role: 'assistant', content: '', tool_calls: [{ id: 'action1', type: 'function', function: { name: 'create_video', arguments: '{}' } }] },
    withWords = randomUUID(),
    withTake = randomUUID(),
    damaged = randomUUID(),
    empty = randomUUID();
  // Words of the user (what the friend had: the prompts the local model wrote as a list).
  await call('history/save', conversation(withWords, 2));
  // Only a creation of the Studio, but a take of it saved.
  await call('history/save', { id: withTake, messages: [studioLine, studioCall] });
  await new Gallery({ historyDir }).put(take(withTake, 'action1'), { persist: true });
  // A file that cannot be read: in doubt, kept.
  await call('history/save', { id: damaged, messages: [studioLine, studioCall] });
  await writeFile(join(historyDir, damaged, 'conversation.json'), Buffer.alloc(200, 0));
  // A creation of the Studio that made nothing, alone in a conversation begun for it.
  await call('history/save', { id: empty, messages: [studioLine, studioCall] });
  for (const id of [withWords, withTake, damaged]) {
    const answer = await call('history/delete', { id, confirm: true, reason: 'studio-empty' });
    assert.equal(answer.status, 409, id);
    assert.match((await answer.json()).error, /a des messages ou des prises : elle reste dans l’historique/);
  }
  assert.equal((await call('history/delete', { id: empty, confirm: true, reason: 'recovery-empty' })).status, 200);
  assert.deepEqual((await (await call('history/trash')).json()).conversations.map(item => [item.id, item.reason]), [[empty, 'recovery-empty']]);
  assert.deepEqual(
    (await lines(journal)).map(line => [line.event, line.id, line.reason]),
    [
      ['suppression refusée', withWords, 'studio-empty'],
      ['suppression refusée', withTake, 'studio-empty'],
      ['suppression refusée', damaged, 'studio-empty'],
      ['corbeille', empty, 'recovery-empty'],
    ],
  );
  // By hand, the user decides: the one with words goes, to the bin.
  assert.equal((await call('history/delete', { id: withWords, confirm: true })).status, 200);
});

test('what waited 30 days in the bin is erased at the next launch, its thumbnails with it, and said', async t => {
  const dataDir = await folder(t),
    historyDir = join(dataDir, 'history'),
    history = new History(historyDir, { journal: new HistoryJournal(join(dataDir, 'history-journal.jsonl')) }),
    old = randomUUID(),
    recent = randomUUID(),
    run = randomUUID();
  for (const id of [old, recent]) {
    await history.save(conversation(id, 2));
    await history.remove(id);
  }
  const note = join(historyDir, '.corbeille', old, 'corbeille.json'),
    kept = JSON.parse(await readFile(note, 'utf8'));
  await writeFile(note, JSON.stringify({ ...kept, deletedAt: new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString() }));
  await mkdir(join(dataDir, 'thumbnails'), { recursive: true });
  const thumbnail = join(dataDir, 'thumbnails', `${old}.${run}.0.jpg`);
  await writeFile(thumbnail, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  const app = await createApplication({ port: 0, dataDir, historyDir });
  t.after(() => app.close());
  assert.deepEqual(await readdir(join(historyDir, '.corbeille')), [recent]);
  await assert.rejects(stat(thumbnail), { code: 'ENOENT' });
  assert.deepEqual((await lines(join(dataDir, 'history-journal.jsonl'))).at(-1).event, 'purgée');
});

test('written on the disk before its rename: the data of a write is flushed first', async t => {
  const root = await folder(t),
    path = join(root, 'conversation.json'),
    order = [],
    probe = await fs.open(join(root, 'probe'), 'w'),
    FileHandle = probe.constructor,
    sync = FileHandle.prototype.sync;
  await probe.close();
  FileHandle.prototype.sync = async function () {
    order.push('sync');
    return sync.call(this);
  };
  try {
    await atomicFile(path, '{"a":1}', async (from, to) => {
      order.push('rename');
      return fs.rename(from, to);
    });
  } finally {
    FileHandle.prototype.sync = sync;
  }
  assert.deepEqual(order, ['sync', 'rename']);
  assert.equal(await readFile(path, 'utf8'), '{"a":1}');
});

test('a file left zeros by a computer cut off: its version before is taken back and said; without one, listed by its name and no longer in the way of a save', async t => {
  const root = await folder(t),
    directory = join(root, 'history'),
    journal = join(root, 'history-journal.jsonl'),
    history = new History(directory, { journal: new HistoryJournal(journal) }),
    mended = randomUUID(),
    lost = randomUUID();
  await history.save(conversation(mended, 2, 'Avant'));
  await history.save(conversation(mended, 4, 'Avant'));
  await history.save(conversation(lost, 2, 'Perdue'));
  for (const id of [mended, lost]) {
    const path = join(directory, id, 'conversation.json');
    await writeFile(path, Buffer.alloc((await stat(path)).size, 0));
  }
  const listed = await history.list();
  assert.equal(listed.skipped, 0);
  const shown = Object.fromEntries(listed.conversations.map(item => [item.id, [item.title, item.unreadable === true]]));
  // Its version before (2 messages) in place, said once; the other by its name, as unreadable.
  assert.deepEqual(shown, { [mended]: ['Avant 0', false], [lost]: ['Conversation illisible', true] });
  assert.deepEqual(history.takeRecovered(), [{ id: mended, title: 'Avant 0' }]);
  assert.deepEqual(history.takeRecovered(), []);
  assert.equal((await history.read(mended)).messages.length, 2);
  assert.ok((await readdir(join(directory, mended))).some(name => /^conversation\.illisible-.+\.json$/.test(name)), 'the damaged file kept beside it');
  await assert.rejects(history.read(lost), error => error.status === 422 && /son fichier est abîmé .*ses prises restent dans les Archives\. .*corbeille/.test(error.message));
  // Saved again by the page that holds it: not refused for ever any more.
  await history.save(conversation(lost, 6, 'Perdue'));
  assert.equal((await history.read(lost)).messages.length, 6);
  assert.deepEqual(
    (await lines(journal)).map(line => [line.event, line.id]),
    [
      ['illisible', mended],
      ['reprise', mended],
      ['illisible', lost],
    ],
  );
});

test('a save that takes messages out of the disk keeps the version before, the last five, and says it', async t => {
  const root = await folder(t),
    directory = join(root, 'history'),
    journal = join(root, 'history-journal.jsonl'),
    history = new History(directory, { journal: new HistoryJournal(journal) }),
    id = randomUUID();
  await history.save(conversation(id, 12));
  // Growing, or the last answer written on: nothing kept.
  await history.save(conversation(id, 13));
  assert.deepEqual(await readdir(join(directory, id)).then(names => names.includes('versions')), false);
  // « Modifier » (fewer messages), seven times: the last five kept.
  for (let count = 11; count >= 5; count--) await history.save(conversation(id, count));
  const kept = await readdir(join(directory, id, 'versions'));
  assert.equal(kept.length, 5);
  const newest = JSON.parse(await readFile(join(directory, id, 'versions', kept.sort().at(-1)), 'utf8'));
  assert.equal(newest.messages.length, 6);
  // A message of the user changed in place (another tab's copy): kept too.
  await history.save({ id, messages: [{ role: 'user', content: 'Autre chose' }, ...conversation(id, 5).messages.slice(1)] });
  assert.equal((await readdir(join(directory, id, 'versions'))).length, 5);
  const said = (await lines(journal)).filter(line => line.event === 'version gardée');
  assert.equal(said.length, 8);
  assert.deepEqual([said[0].messages, said[0].after], [13, 11]);
});

test('at launch, a copy of a first save Windows held, alone and whole in its folder, becomes the conversation again', async t => {
  const root = await folder(t),
    directory = join(root, 'history'),
    journal = join(root, 'history-journal.jsonl'),
    history = new History(directory, { journal: new HistoryJournal(journal) }),
    whole = randomUUID(),
    broken = randomUUID(),
    attachment = 'original-' + 'a'.repeat(64) + '.png',
    hour = new Date(Date.now() - 3600000);
  // The record a refused first save left in its copy, as atomicFile writes it.
  const saved = await history.save(conversation(whole, 4, 'Retrouvée'));
  const record = await readFile(join(directory, whole, 'conversation.json'));
  await rm(join(directory, whole, 'conversation.json'));
  await rm(join(directory, whole, 'conversation.json.prev'), { force: true });
  const copy = join(directory, whole, `conversation.json.${randomUUID()}.tmp`);
  await writeFile(copy, record);
  await writeFile(join(directory, whole, attachment), 'x');
  await utimes(copy, hour, hour);
  await mkdir(join(directory, broken), { recursive: true });
  const half = join(directory, broken, `conversation.json.${randomUUID()}.tmp`);
  await writeFile(half, '{"id":');
  await utimes(half, hour, hour);
  // Invisible in the list until then (no conversation.json): 0.6.87 erased it at the next launch.
  assert.deepEqual((await history.list()).conversations, []);
  assert.equal(await history.pruneUnsaved(), 1);
  const [found] = (await history.list()).conversations;
  assert.deepEqual([found.id, found.title, found.createdAt], [whole, 'Retrouvée 0', saved.createdAt]);
  assert.equal((await history.read(whole)).messages.length, 4);
  assert.deepEqual(await readdir(join(directory, '.corbeille')), [broken], 'the copy that does not read whole: to the bin');
  assert.deepEqual(
    (await lines(journal)).map(line => [line.event, line.id, line.reason?.slice(0, 5)]).sort(),
    [
      ['corbeille', broken, 'prune'],
      ['retrouvée', whole, 'copie'],
    ],
  );
});

test('a save on an older revision than the disk’s is refused; moves and names keep the revision; a save naming none is taken', async t => {
  const dataDir = await folder(t),
    { call } = await server(t, dataDir),
    id = randomUUID(),
    save = async body => {
      const answer = await call('history/save', body);
      return { status: answer.status, body: await answer.json() };
    };
  let { body } = await save(conversation(id, 2));
  assert.equal(body.conversation.revision, 1);
  // Each save on the revision read: the next one.
  ({ body } = await save({ ...conversation(id, 4), revision: 1 }));
  assert.equal(body.conversation.revision, 2);
  // A tab left on revision 1 (P2 of the inquiry: it wrote twelve messages over with three).
  const stale = await save({ ...conversation(id, 3), revision: 1 });
  assert.deepEqual([stale.status, stale.body.stale, stale.body.error], [409, true, 'Cette conversation a changé dans un autre onglet.']);
  assert.equal((await (await call(`history/${id}`)).json()).messages.length, 4);
  // Named (by the user, or the chat model), moved to a project: its messages unchanged, its revision too.
  await call('history/rename', { id, title: 'Les chats' });
  const project = (await (await call('projects/save', { name: 'Chats' })).json()).project.id;
  await call('projects/move', { id, projectId: project });
  const read = await (await call(`history/${id}`)).json();
  assert.deepEqual([read.revision, read.projectId, read.title], [2, project, 'Les chats']);
  ({ body } = await save({ ...conversation(id, 6), revision: 2, projectId: project }));
  assert.equal(body.conversation.revision, 3);
  // A page that never read it (the session of an earlier version): taken as before.
  assert.equal((await save(conversation(id, 8))).status, 200);
});

test('the session of an update or « Redémarrer » keeps the revision read, and without the history the conversation set aside', () => {
  const message = { role: 'user', content: 'Un chat' },
    base = { messages: [message], images: [], conversationId: randomUUID(), prompt: '', title: 'Un chat', thinking: true };
  const aside = { ...base, conversationId: randomUUID(), projectId: 'inbox', title: 'Mise de côté', prompt: 'brouillon' };
  const kept = updateSession({ ...base, revision: 7, aside });
  assert.equal(kept.revision, 7);
  assert.deepEqual([kept.aside.conversationId, kept.aside.title, kept.aside.prompt, kept.aside.projectId], [aside.conversationId, 'Mise de côté', 'brouillon', 'inbox']);
  assert.deepEqual(kept.aside.messages, [message]);
  assert.equal(updateSession(base).aside, undefined);
  assert.throws(() => updateSession({ ...base, aside: { messages: 'non' } }), /Session de mise à jour invalide/);
});
