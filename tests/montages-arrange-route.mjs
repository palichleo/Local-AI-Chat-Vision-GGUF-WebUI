import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server.mjs';
import { Gallery } from '../lib/gallery.mjs';
import { History } from '../lib/history.mjs';
import { RemoteModels } from '../lib/remote-models.mjs';

// (0.6.162) /api/montages/arrange: the plan of a request written in the Bobine, asked to the chat model
// in a request of its own (lib/arrange.mjs). The server gives the model the bobine as the page has it and
// the takes of the project; it creates nothing and lays nothing.
const folder = async t => {
  const path = await mkdtemp(join(tmpdir(), 'moodix-arrange-'));
  t.after(() => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return path;
};
/** A server of one handler, closed with the test. */
async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}
// The smallest PNG: the file of the take of the project.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const UUID = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i;
const PLAN = { say: 'Un plan sur le phare.', fill: [], add: [{ text: 'Le phare balaie la mer de son faisceau.', seconds: 5, link: 'cut', start: 'prise 1', end: null }] };

test('the plan of a request written in the Bobine is asked to the chat model, with the bobine and the takes of the project (0.6.162)', async t => {
  const sent = [],
    answers = [];
  const base = await serve(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    sent.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: answers.shift() ?? '' }, finish_reason: 'stop' }] }));
  });
  const data = await folder(t),
    conversation = randomUUID(),
    take = randomUUID();
  await mkdir(join(data, 'output', 'image'), { recursive: true });
  await writeFile(join(data, 'output', 'image', 'phare.png'), PNG);
  // A take of the project « Sans projet »: an image, in a conversation kept.
  await new Gallery({ historyDir: join(data, 'history') }).put(
    {
      mediaType: 'image',
      provider: 'native',
      id: take,
      conversationId: conversation,
      workflowId: 'essai',
      workflowName: 'Krea 2',
      prompt: 'Un phare la nuit dans la tempête',
      parameters: {},
      createdAt: '2026-11-20T10:00:00.000Z',
      outputs: [{ source: { filename: 'phare.png', subfolder: 'image', type: 'output' }, width: 1, height: 1 }],
    },
    { persist: true },
  );
  await new History(join(data, 'history')).save({ id: conversation, messages: [{ role: 'user', content: 'Le phare' }] });
  const remotes = new RemoteModels(data),
    saved = await remotes.save({ preset: 'openrouter', baseUrl: `${base}/api/v1`, model: 'un/modele', key: 'sk-or-v1-0123456789' });
  await remotes.setActive(saved.id);
  const app = await createApplication({
    port: 0,
    dataDir: data,
    outputDir: join(data, 'output'),
    openUrl: () => {},
    spawnProcess: () => {
      throw Error('llama.cpp started');
    },
  });
  t.after(() => app.close());
  const boot = await (await fetch(app.url + '/api/bootstrap')).json(),
    headers = { Authorization: 'Bearer ' + boot.token, 'Content-Type': 'application/json' },
    call = body => fetch(app.url + '/api/montages/arrange', { method: 'POST', headers, body: JSON.stringify(body) }),
    montage = { schemaVersion: 1, id: randomUUID(), name: 'Sans titre', format: '16:9', width: 1344, height: 768, fps: 24, plans: [], sounds: [] },
    asked = { project: 'inbox', conversationId: conversation, montage, request: 'Un film sur un phare, en partant de la prise 1.' };
  // The chat model not started: refused in the user's words, nothing asked.
  const early = await call(asked);
  assert.deepEqual([early.status, (await early.json()).error], [503, 'Le moteur n’est pas prêt. Configure-le puis démarre-le.']);
  const started = await fetch(app.url + '/api/start', { method: 'POST', headers, body: '{}' });
  assert.equal((await started.json()).state, 'ready');
  // No words, or no bobine: refused before anything is asked.
  for (const [body, error] of [
    [{ ...asked, request: '   ' }, 'Écrivez ce que vous demandez à Moodix AI.'],
    [{ ...asked, request: 42 }, 'Écrivez ce que vous demandez à Moodix AI.'],
    [{ ...asked, montage: 'non' }, 'Bobine invalide.'],
    [{ ...asked, montage: { plans: [] } }, 'Version de bobine inconnue.'],
  ]) {
    const refused = await call(body);
    assert.deepEqual([refused.status, (await refused.json()).error], [400, error]);
  }
  assert.equal(sent.length, 0);
  // Asked: the plan read comes back, the takes as their numbers; nothing is laid nor kept by the server.
  answers.push(JSON.stringify(PLAN));
  // (What is no request among the earlier ones is left out before the last three are kept.)
  const done = await call({ ...asked, previous: [{ request: 'un essai', say: 'Rien posé.' }, 'du bruit', { say: 'sans demande' }, 42] });
  assert.equal(done.status, 200, await done.clone().text());
  assert.deepEqual(await done.json(), {
    arrangement: { say: 'Un plan sur le phare.', fill: [], add: [{ text: 'Le phare balaie la mer de son faisceau.', seconds: 5, link: 'cut', start: 1, end: null }] },
    problems: [],
  });
  assert.equal(sent.length, 1);
  const [system, user] = sent[0].messages;
  assert.deepEqual([sent[0].messages.length, system.role, user.role], [2, 'system', 'user']);
  // A model that is not the local one reads the whole instructions (the local one, the simple form).
  assert.match(system.content, /fill/);
  // The bobine as the page has it, the take of the project by its number and what it shows, the request before, the request.
  assert.match(user.content, /The bobine is empty/);
  assert.match(user.content, /prise 1, image: "Un phare la nuit dans la tempête"/);
  assert.match(user.content, /« un essai » You answered: « Rien posé\. »/);
  assert.doesNotMatch(user.content, /du bruit|sans demande/);
  assert.match(user.content, /« Un film sur un phare, en partant de la prise 1\. »/);
  assert.doesNotMatch(system.content + user.content, UUID);
  // Two answers that cannot be read: asked twice, then said to the user.
  answers.push('Voici mon idée : un phare.', 'Toujours un phare.');
  const unread = await call(asked);
  assert.deepEqual([unread.status, (await unread.json()).error, sent.length], [502, 'Moodix AI n’a pas rendu de plan lisible. Réessayez, ou dites-le autrement.', 3]);
  assert.deepEqual(sent[2].messages.slice(2).map(message => [message.role, message.content.slice(0, 40)]), [
    ['assistant', 'Voici mon idée : un phare.'],
    ['user', 'Your answer could not be read as the pla'],
  ]);
  // The engine is free again after each of them.
  answers.push(JSON.stringify(PLAN));
  assert.equal((await call(asked)).status, 200);
});
