import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createApplication } from '../server.mjs';
import { History } from '../lib/history.mjs';
import { BRIEF_TOKENS } from '../lib/chat-model.mjs';
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
    // (The local model is not asked by default: see the test after this one.)
    localTitles: true,
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
  // Nothing to name it from yet: nothing written, asked again when a next message has words.
  const other = randomUUID();
  await api('history/save', { id: other, messages: [{ role: 'user', content: 'Bonjour' }] });
  assert.deepEqual(await api('history/title', { id: other, content: '' }), { later: true });
  assert.deepEqual(await api('history/title', { id: other, contents: ['', []] }), { later: true });
});

/** The application as these tests ask it: its routes, answered in JSON. */
async function titled(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'moodix-title-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = await createApplication({ port: 0, dataDir: root, openUrl: () => {}, localTitles: true, ...options(root) });
  t.after(() => app.close());
  const boot = await (await fetch(app.url + '/api/bootstrap')).json();
  /** The answer itself, as it comes (a reply of the chat is a stream). */
  const raw = (path, body) =>
    fetch(app.url + '/api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + boot.token, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const api = async (path, body, status = 200) => {
    const response = await raw(path, body);
    assert.equal(response.status, status, await response.clone().text());
    return response.json();
  };
  const conversation = async (said = 'Bonjour') => {
    const id = randomUUID();
    await api('history/save', { id, messages: [{ role: 'user', content: said }] });
    return id;
  };
  return { root, api, raw, conversation };
}

test('what the local model is asked for a name: a few words, no tool, no reflection, the first message that has words', { timeout: 30000 }, async t => {
  // llama.cpp as far as a name goes: it keeps what it is asked, and answers a name.
  let log;
  const { root, api, conversation } = await titled(t, root => {
    log = join(root, 'asked.jsonl');
    const script = join(root, 'engine.mjs');
    return { spawnProcess: (_command, args, options) => spawn(process.execPath, [script, ...args], options) };
  });
  await writeFile(
    join(root, 'engine.mjs'),
    `import http from 'node:http';
import { appendFileSync } from 'node:fs';
if (process.argv[2] === '--version') {
  console.error('version: 1 (fake)');
  process.exit(0);
}
const args = process.argv.slice(2);
http
  .createServer(async (req, res) => {
    const json = value => (res.writeHead(200, { 'Content-Type': 'application/json' }), res.end(JSON.stringify(value)));
    if (req.url === '/health') return json({ status: 'ok' });
    if (req.url !== '/v1/chat/completions') return res.writeHead(404).end();
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    appendFileSync(${JSON.stringify(log)}, Buffer.concat(chunks).toString() + String.fromCharCode(10));
    json({ choices: [{ index: 0, message: { role: 'assistant', content: 'Renard dans la neige' }, finish_reason: 'stop' }] });
  })
  .listen(Number(args[args.indexOf('--port') + 1]), '127.0.0.1');
`,
  );
  const modelPath = join(root, 'llm.gguf');
  await writeFile(modelPath, 'GGUF\x03\0\0\0');
  await api('config', { enginePath: process.execPath, modelPath, projectorPath: '', contextSize: 8192, maxOutputTokens: 4096, gpuLayers: 0 });
  await api('start', {}, 202);
  for (let i = 0; i < 400 && (await api('status')).state !== 'ready'; i++) await new Promise(resolve => setTimeout(resolve, 25));
  const id = await conversation(),
    studio = 'Studio · Image : \n\n(Créée dans le Studio : l’utilisateur a réglé et lancé cette génération lui-même.)';
  // It opened on a creation of the Studio made without a prompt, then on pictures alone (this model
  // sees none): named after the first message that has words, the third.
  const { conversation: named } = await api('history/title', {
    id,
    contents: [
      studio,
      [
        { type: 'text', text: 'Décris les images.' },
        { type: 'image_url', image_url: { url: png } },
      ],
      [{ type: 'text', text: 'Un renard court dans la neige, à l’aquarelle' }],
    ],
  });
  assert.equal(named.title, 'Renard dans la neige');
  const asked = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(asked.length, 1);
  const [sent] = asked;
  assert.equal('tools' in sent || 'tool_choice' in sent, false, 'no tool');
  assert.deepEqual([sent.stream, sent.max_tokens], [false, 40], 'a few words, in one answer');
  assert.deepEqual(sent.chat_template_kwargs, { enable_thinking: false }, 'no reflection');
  assert.deepEqual(
    sent.messages.map(message => message.role),
    ['system', 'user'],
  );
  assert.match(sent.messages[0].content, /at most four words/);
  assert.equal(sent.messages[1].content, 'Un renard court dans la neige, à l’aquarelle');
  assert.equal(JSON.stringify(sent).includes('Studio ·'), false);
});

/** A service « compatible OpenAI » as far as a name goes: what it is asked, what the test has it answer. */
async function nameService(t) {
  const seen = { bodies: [], answer: () => 'Renard dans la neige', held: null };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    seen.bodies.push(body);
    // A reply of the chat (a stream): held until the test lets it end.
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"Bon"}}]}\n\n');
      await seen.held;
      return res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }
    const said = seen.answer(body);
    if (said === null) return res.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":{"message":"panne"}}');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: said }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => (server.closeAllConnections(), new Promise(resolve => server.close(resolve))));
  return { seen, address: `http://127.0.0.1:${server.address().port}/v1` };
}

test('a remote service is asked for a name cheaply, once more at most when it gives none, and never under a reply', { timeout: 30000 }, async t => {
  const { seen, address } = await nameService(t);
  const { api, raw, conversation } = await titled(t, () => ({
    // The local engine never starts here: a remote model answers.
    spawnProcess: () => {
      throw Error('llama.cpp started');
    },
  }));
  const { saved } = await api('remote/save', { preset: 'custom', name: 'Service', baseUrl: address, model: 'test-model', key: 'k-123456789', vision: false });
  await api('remote/select', { id: saved.id });
  const titles = () => seen.bodies.filter(body => body.stream === false);

  // What it gets: its model, a short answer asked (the conversation's own requests have no limit),
  // no tool, none of the fields of llama.cpp.
  const first = await conversation('Un renard court dans la neige');
  assert.equal((await api('history/title', { id: first, contents: ['Un renard court dans la neige'] })).conversation.title, 'Renard dans la neige');
  const [sent] = titles();
  assert.deepEqual([sent.model, sent.stream, sent.max_tokens], ['test-model', false, BRIEF_TOKENS]);
  assert.equal('tools' in sent || 'chat_template_kwargs' in sent || 'reasoning_format' in sent, false);
  assert.equal(sent.messages.at(-1).content, 'Un renard court dans la neige');

  // No name in its answer (empty, a refusal, a breakdown): asked once more at the end of a next
  // turn, then the name made of the first message stays and the service is left alone.
  const second = await conversation('Une musique calme');
  seen.answer = () => '';
  assert.deepEqual(await api('history/title', { id: second, contents: ['Une musique calme'] }), { later: true });
  seen.answer = () => null;
  assert.deepEqual(await api('history/title', { id: second, contents: ['Une musique calme'] }), { named: false });
  seen.answer = () => 'Musique calme';
  assert.deepEqual(await api('history/title', { id: second, contents: ['Une musique calme'] }), { named: false });
  assert.equal(titles().length, 3, 'two requests for that conversation, not three');
  assert.equal((await api('history')).conversations.find(item => item.id === second).title, 'Une musique calme');
  // A first answer that is no name, a second that is one: named.
  const third = await conversation('Un escalier de pierre');
  seen.answer = () => 'Je suis désolé, je ne peux pas.';
  assert.deepEqual(await api('history/title', { id: third, contents: ['Un escalier de pierre'] }), { later: true });
  seen.answer = () => 'Escalier de pierre';
  assert.equal((await api('history/title', { id: third, contents: ['Un escalier de pierre'] })).conversation.title, 'Escalier de pierre');

  // While the model answers the conversation, it is not asked: later.
  let release;
  seen.held = new Promise(resolve => (release = resolve));
  const fourth = await conversation('Un phare la nuit'),
    before = titles().length;
  const reply = raw('chat', { messages: [{ role: 'user', content: 'Bonjour' }], conversationId: fourth, turnId: randomUUID() });
  for (let i = 0; i < 400 && !seen.bodies.some(body => body.stream); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(seen.bodies.some(body => body.stream), 'the reply is being written');
  assert.deepEqual(await api('history/title', { id: fourth, contents: ['Un phare la nuit'] }), { later: true });
  assert.equal(titles().length, before, 'not asked under the reply');
  release();
  await (await reply).text();
  // The reply over: asked, and named (a `later` is not a try).
  seen.answer = () => 'Phare la nuit';
  assert.equal((await api('history/title', { id: fourth, contents: ['Un phare la nuit'] })).conversation.title, 'Phare la nuit');
});

test('an answer that is no name names nothing: a refusal, a sentence, a reflection left open, something that is not words', () => {
  for (const said of [
    [{ type: 'text', text: 'Renard' }],
    { text: 'Renard' },
    'Je suis désolé, je ne peux pas identifier cette image.',
    'Désolé, je ne vois pas d’image.',
    'I’m sorry, but I can’t help with that.',
    "I can't name this conversation.",
    '<think>Le sujet est un chat',
    'Ceci est une phrase entière qui décrit longuement ce que la conversation contient vraiment',
    '',
    null,
  ])
    assert.equal(shortTitle(said), '', JSON.stringify(said));
  // What it says before the name is left out; a name with a colon of its own is kept whole.
  assert.equal(shortTitle('Voici un titre : Renard dans la neige'), 'Renard dans la neige');
  assert.equal(shortTitle('Sure! Here is a title: Fox'), 'Fox');
  assert.equal(shortTitle('<think>x</think>Chat sur un toit'), 'Chat sur un toit');
  assert.equal(shortTitle('Paris : la nuit'), 'Paris : la nuit');
  // Five to eight words: its four first, as before.
  assert.equal(shortTitle('Un escalier ancien dans les nuages'), 'Un escalier ancien dans...');
});

test('the local chat model is asked for a name when it runs on the card, not on a processor alone', async () => {
  const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  // Measured on the card: the name costs under half a second and the conversation keeps its
  // prompt. On a processor alone a prompt read again would cost far more: not asked there.
  assert.match(source, /\n  localTitles = 'gpu',\r?\n/);
  assert.match(source, /const localNamed = localTitles === true \|\| \(localTitles === 'gpu' && config\.gpuLayers !== 0\);/);
  assert.match(source, /if \(wordingOf\(chat\.connection\) !== CAPABLE && !localNamed\) return send\(200, \{ named: false \}\);/);
  // And nothing is written once the application is closing.
  assert.match(source, /if \(closing \|\| relaunching\) return send\(200, \{ later: true \}\);/);
});
