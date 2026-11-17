import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../server.mjs';
import { History } from '../lib/history.mjs';
import { TITLE_WORDS, shortTitle, titleRequest } from '../lib/conversation-title.mjs';

/**
 * The name of a conversation in four words at most (17/11), asked to the chat model once it has
 * answered: a picture it opened on described, words summed up; « ... » after a fourth word.
 */
const fixture = fileURLToPath(new URL('./fixtures/fake-tool-engine.mjs', import.meta.url));
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rLkAAAAASUVORK5CYII=';

test('the answer of the model made a name of four words at most, « ... » after the fourth', () => {
  assert.equal(TITLE_WORDS, 4);
  assert.equal(shortTitle('Renard dans la neige'), 'Renard dans la neige');
  assert.equal(shortTitle('Un renard qui court dans la neige'), 'Un renard qui court...');
  // What a small model adds around it: a label, quotes, final punctuation, a reflection, more lines.
  assert.equal(shortTitle('Titre : « Escalier de pierre ».'), 'Escalier de pierre');
  assert.equal(shortTitle('<think>Le sujet est un chat.</think>\n"Chat roux"\nC’est un bon titre.'), 'Chat roux');
  assert.equal(shortTitle('**Title:** Fox in the snow!'), 'Fox in the snow');
  assert.equal(shortTitle('Musique calme au piano, trente secondes.'), 'Musique calme au piano...');
  assert.equal(shortTitle(''), '');
  assert.equal(shortTitle(undefined), '');
  assert.equal(shortTitle('  \n « » \n'), '');
});

test('a conversation that opens on a picture is named after it, else after its words', () => {
  // Words: summed up, in their language.
  const words = titleRequest('Fais une vidéo de 5 secondes : un renard court dans la neige.');
  assert.equal(words[1].content, 'Fais une vidéo de 5 secondes : un renard court dans la neige.');
  assert.match(words[0].content, /at most four words/);
  assert.match(words[0].content, /language of the message/);
  // A picture, for a model that sees: the picture alone, described.
  const content = [
    { type: 'text', text: 'Anime cette image' },
    { type: 'image_url', image_url: { url: png } },
  ];
  const picture = titleRequest(content, { vision: true });
  assert.deepEqual(picture[1].content, [{ type: 'image_url', image_url: { url: png } }]);
  assert.match(picture[0].content, /what the image shows/);
  // A model that sees no picture: the words that go with it, or nothing to name it from.
  assert.equal(titleRequest(content, { vision: false })[1].content, 'Anime cette image');
  assert.equal(
    titleRequest(
      [
        { type: 'text', text: 'Décris les images.' },
        { type: 'image_url', image_url: { url: png } },
      ],
      { vision: false },
    ),
    null,
  );
  // An image that is no copy for the model (a file name of the history) is not sent.
  assert.equal(
    titleRequest(
      [
        { type: 'text', text: 'Un chat' },
        { type: 'image_url', image_url: { url: 'a.png' } },
      ],
      {
        vision: true,
      },
    )[1].content,
    'Un chat',
  );
  // A creation of the Studio: its prompt alone.
  assert.equal(
    titleRequest(
      'Studio · Image : A red fox in fresh snow\n\n(Créée dans le Studio : l’utilisateur a réglé et lancé cette génération lui-même.)',
    )[1].content,
    'A red fox in fresh snow',
  );
  assert.equal(titleRequest(''), null);
  assert.equal(titleRequest(undefined), null);
});

test('a name given by the model is kept at each save, and one given by the user always wins', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'moodix-title-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const history = new History(directory),
    id = randomUUID(),
    messages = [
      { role: 'user', content: 'Fais une vidéo de cinq secondes d’un renard qui court dans la neige' },
      { role: 'assistant', content: 'Voici la proposition.' },
    ];
  await history.save({ id, messages });
  assert.equal(await history.named(id), false);
  assert.equal((await history.rename(id, 'Renard dans la neige', { auto: true })).title, 'Renard dans la neige');
  assert.equal(await history.named(id), true);
  // The next saves keep it (they named it by its first message before).
  const saved = await history.save({ id, messages: [...messages, { role: 'user', content: 'Plus lent' }] });
  assert.equal(saved.title, 'Renard dans la neige');
  // Not written over by the model, but by the user.
  assert.equal((await history.rename(id, 'Autre chose', { auto: true })).title, 'Renard dans la neige');
  assert.equal((await history.rename(id, 'Mon renard')).title, 'Mon renard');
  assert.equal((await history.rename(id, 'Encore autre chose', { auto: true })).title, 'Mon renard');
  const stored = JSON.parse(await readFile(join(directory, id, 'conversation.json'), 'utf8'));
  assert.deepEqual([stored.title, stored.titled], ['Mon renard', true]);
  assert.equal(await history.named(randomUUID()), false, 'not saved: no name');
});

test('through the application: the chat model names the conversation once, beside it', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'moodix-title-app-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = await createApplication({
    port: 0,
    dataDir: root,
    openUrl: () => {},
    // The scripted engine answers « OK » to a request without a stream.
    spawnProcess: (_command, args, options) => spawn(process.execPath, [fixture, ...args], options),
  });
  t.after(() => app.close());
  const boot = await (await fetch(app.url + '/api/bootstrap')).json();
  const api = async (path, body, status = 200) => {
    const response = await fetch(app.url + '/api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + boot.token, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.status, status, await response.clone().text());
    return response.json();
  };
  const id = randomUUID(),
    said = 'Fais une vidéo de cinq secondes d’un renard qui court dans la neige';
  // Not ready yet (no model started): asked again later, nothing named.
  await api('history/save', {
    id,
    messages: [
      { role: 'user', content: said },
      { role: 'assistant', content: 'Oui.' },
    ],
  });
  assert.deepEqual(await api('history/title', { id, content: said }), { later: true });
  const modelPath = join(root, 'llm.gguf');
  await writeFile(modelPath, 'GGUF\x03\0\0\0');
  await api('config', {
    enginePath: process.execPath,
    modelPath,
    projectorPath: '',
    contextSize: 8192,
    maxOutputTokens: 4096,
    gpuLayers: 0,
  });
  await api('start', {}, 202);
  for (let i = 0; i < 400 && (await api('status')).state !== 'ready'; i++)
    await new Promise(resolve => setTimeout(resolve, 25));
  const { conversation } = await api('history/title', { id, content: said });
  assert.equal(conversation.title, 'OK');
  assert.equal((await api('history')).conversations.find(item => item.id === id).title, 'OK');
  // Once named, the model is not asked again; a name given by the user stays.
  assert.deepEqual(await api('history/title', { id, content: said }), { named: true });
  await api('history/rename', { id, title: 'Mon renard' });
  assert.deepEqual(await api('history/title', { id, content: said }), { named: true });
  assert.equal((await api('history')).conversations.find(item => item.id === id).title, 'Mon renard');
  // Nothing to name it from: said so, nothing written.
  const other = randomUUID();
  await api('history/save', { id: other, messages: [{ role: 'user', content: 'Bonjour' }] });
  assert.deepEqual(await api('history/title', { id: other, content: '' }), { named: false });
});
