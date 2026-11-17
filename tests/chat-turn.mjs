import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { readSSE } from '../public/stream.mjs';
import * as sessionCopies from '../public/session-copies.mjs';
import * as chatVideos from '../public/chat-videos.mjs';
import * as transcript from '../public/transcript.mjs';
import { reflection, thoughtTime } from '../public/reflection.mjs';
import { History, MAX_CONVERSATION_MESSAGES } from '../lib/history.mjs';
import { nativeFields } from '../lib/native-messages.mjs';
import { problem } from '../lib/engine.mjs';

/**
 * A turn of the chat from its first word to what is kept of it (0.6.31): the page (slices of
 * app.js in a sandbox, as tests/image-chat.mjs), the history of the server (lib/history.mjs) and
 * what /api/chat accepts (chatPayload, cut out of server.mjs). Each test is one of the faults found
 * in the audit of the chat, turned round: it fails when its correction is taken away.
 */
const text = async name => (await readFile(new URL(name, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const source = await text('../public/app.js'),
  serverSource = await text('../server.mjs');
function cut(from, to, within = source) {
  const start = within.indexOf(from),
    end = within.indexOf(to, start + 1);
  assert.ok(start >= 0 && end > start, `slice not found: ${from} … ${to}`);
  return within.slice(start, end);
}
/** A value made in the sandbox, compared here (another realm: its prototypes are not ours). */
const plain = value => JSON.parse(JSON.stringify(value));
/** Who speaks in turn in a conversation (a list made here, whatever made the messages). */
const roles = messages => Array.from(messages, message => message.role);

// What /api/chat does with the messages of a request before anything else: it throws its refusal
// (« Résultat d’outil manquant. », a call without its result).
const validation = { problem, nativeFields, MAX_CONVERSATION_MESSAGES, Buffer };
runInNewContext(cut('function chatPayload(', '/** 32 random bytes kept', serverSource) + '\nthis.chatPayload = chatPayload;', validation);
const accepted = messages => validation.chatPayload({ messages: plain(messages) }, true, 1024);
/** The next message of the user after `messages`, as sendMessage posts it. */
const nextMessage = (messages, said = 'Oui, vas-y') => [{ role: 'system', content: 'Tu es un assistant.' }, ...messages, { role: 'user', content: said }];

class El {
  constructor(tag = '', className = '', said) {
    const names = new Set(String(className).split(' ').filter(Boolean));
    Object.assign(this, { tag, className, textContent: said ?? '', children: [], parent: null, dataset: {}, attributes: {}, listeners: {} });
    Object.assign(this, { value: '', hidden: false, disabled: false, style: { setProperty() {}, removeProperty() {} } });
    this.classList = {
      add: (...added) => added.forEach(name => names.add(name)),
      remove: (...removed) => removed.forEach(name => names.delete(name)),
      toggle: (name, on = !names.has(name)) => (on ? names.add(name) : names.delete(name), on),
      contains: name => names.has(name),
    };
  }
  append(...items) {
    for (const item of items) {
      if (item instanceof El) item.parent = this;
      this.children.push(item);
    }
  }
  replaceChildren(...items) {
    this.children = [];
    this.textContent = '';
    this.append(...items);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  removeEventListener(type, listener) {
    this.listeners[type] = (this.listeners[type] ?? []).filter(item => item !== listener);
  }
  querySelector() {
    return null;
  }
  focus() {}
  close() {}
  /** A form sent: its listeners of the capture first (app.js: the label of a shortcut), then its handler. */
  requestSubmit() {
    const event = { preventDefault() {} };
    for (const listener of this.listeners.submit ?? []) listener(event);
    return this.onsubmit?.(event);
  }
  /** Everything written in it and under it. */
  get words() {
    return [this.textContent, ...this.children.map(child => (child instanceof El ? child.words : String(child ?? '')))]
      .filter(Boolean)
      .join(' ');
  }
  /** Every element under it of that class. */
  all(className) {
    return this.children.flatMap(child =>
      child instanceof El ? [...(child.classList.contains(className) ? [child] : []), ...child.all(className)] : [],
    );
  }
}

// What the stream of an answer holds (server.mjs): the words of the model, a call it made.
const said = (words, reason = 'stop') => [{ choices: [{ delta: words ? { content: words } : {}, finish_reason: reason }] }];
const called = (request, words = '') => [
  { choices: [{ delta: words ? { content: words } : {}, finish_reason: 'tool_calls' }] },
  { local_tool_request: request },
];
const functionCall = (name, id = 'call_1', args = '{"prompt":"un renard court dans la neige"}') => ({
  id,
  type: 'function',
  function: { name, arguments: args },
});
// A video not talked over yet (lib/video-brief.mjs): proposed with what Moodix is to say of it.
const videoProposal = (id = 'call_1') => ({
  call: functionCall('create_video', id),
  workflowName: 'LTX',
  requestId: 'r1',
  approvalToken: 't1',
  mediaType: 'video',
  brief: 'PLAN FIRST (Studio)',
  cardBrief: 'WORDS OVER THE CARD',
});
const PLAN = 'Le renard court dans la neige pendant cinq secondes, la caméra le suit. Cela vous convient ?';
const ID = 'a1111111-1111-4111-8111-111111111111';

/** A history of the server in a folder of its own, removed with the test. */
async function historyStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'moodix-chat-turn-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new History(join(directory, 'history'));
}

/**
 * The page of a conversation. `chat(body, n)`: what the n-th /api/chat answers (the events of its
 * stream; it may throw as a refusal of the server does). `requestTool`: the generation (its card
 * first for a video), as generation-runtime.mjs. `store`: the history the page saves in and reads.
 * `state`: what the page holds when the test begins; `routes`: the other answers of the server;
 * `waitForModel`: the model coming (a turn may be stopped there). What the page did is kept beside
 * its state: `requests` (/api/chat), `saves` (history/save), `notices`, `takes`, `views`, `cancelled`
 * (tools/cancel), `lines`.
 */
function page({
  chat = () => said('ok'),
  requestTool = async () => ({ content: JSON.stringify({ status: 'success' }), images: [] }),
  store = null,
  state: given = {},
  routes = {},
  waitForModel = async (api, signal) => signal.throwIfAborted(),
} = {}) {
  const nodes = new Map(),
    $ = id => {
      if (!nodes.has(id)) nodes.set(id, new El());
      return nodes.get(id);
    };
  $('conversation-title').textContent = 'Nouvelle conversation';
  const state = {
    view: 'chat',
    config: { enginePath: 'engine', modelPath: 'model' },
    messages: [],
    images: [],
    videos: [],
    status: { state: 'ready', vision: true, busy: false },
    thinking: true,
    saveHistory: true,
    historyItems: [],
    projectId: 'inbox',
    conversationId: null,
    generation: { maxIterations: 5 },
    ...given,
  };
  // `lines`: the view the line under the tabs was drawn for, each time it was drawn.
  const seen = { requests: [], saves: [], notices: [], takes: [], restored: [], views: [], failures: [], cancelled: [], lines: [] };
  const node = (tag, className, words) => new El(tag, className, words);
  const context = {
    ...sessionCopies,
    ...chatVideos,
    ...transcript,
    reflection,
    thoughtTime,
    readSSE,
    state,
    $,
    node,
    seen,
    icon: () => node('svg'),
    document: { querySelectorAll: () => [] },
    AbortController,
    DOMException,
    performance,
    console,
    crypto: { randomUUID: () => ID },
    confirm: () => true,
    historyWrite: Promise.resolve(),
    moodixMark: () => [],
    markThinking() {},
    modelLoading: () => ({ show() {}, stop() {}, fail: message => seen.failures.push(message) }),
    userMessage(words, images, videos = []) {
      const article = node('article', 'message user', words);
      Object.assign(article, { images, videos });
      $('messages').append(article);
      return article;
    },
    renderText(target, words) {
      target.textContent = words;
    },
    notice: words => seen.notices.push(words),
    tabLine: () => seen.lines.push(state.view),
    turnActions() {},
    showLastReply() {},
    renderAttachments() {},
    resizePrompt() {},
    scrollToBottom() {},
    updateControls() {},
    openSettings() {},
    writeReference() {},
    rememberConversation() {},
    requestSettingsClose: after => after?.(),
    refreshStatus: async () => {},
    waitForModel,
    contextMeter: { pause() {}, observe() {}, schedule() {} },
    settingsGuard: { isDirty: () => false },
    projectUI: { render() {}, sync() {} },
    assetsUI: { flush: async () => true, refresh: async () => {}, importFiles: async () => [] },
    // The takes a reply names, under it (cited-takes.mjs).
    citedTakes: { show() {}, forget() {} },
    generationUI: {
      // A take of the message: what the page tells it is kept (`told`).
      mount(container, request, options) {
        const take = { container, request, options, told: [], progress() {}, image() {} };
        for (const name of ['finish', 'fail', 'failed', 'withdraw']) take[name] = (...given) => take.told.push([name, ...given]);
        seen.takes.push(take);
        return take;
      },
      restore: (container, conversationId, runId, options) => seen.restored.push({ container, runId, options }),
      clear() {},
    },
    workflowsUI: { requestTool: (...given) => requestTool(...given), saveReview: async () => {} },
    async api(route, body, options) {
      if (route === 'status') return Response.json(state.status);
      if (route === 'history/save') {
        seen.saves.push(plain(body));
        // The real history refuses as the server does: api() throws its words.
        const conversation = store ? await store.save(plain(body)) : { id: body.id, title: '' };
        return Response.json({ conversation });
      }
      if (store && route.startsWith('history/') && body === undefined) return Response.json(await store.read(route.slice(8)));
      if (route === 'tools/cancel') {
        seen.cancelled.push(plain(body));
        return Response.json({});
      }
      if (route === 'chat') {
        seen.requests.push(plain(body));
        options?.signal?.throwIfAborted();
        const events = await chat(body, seen.requests.length, options);
        // (A stream of its own when the test gives one: an answer stopped midway.)
        if (events instanceof Response) return events;
        return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
      }
      if (routes[route]) return routes[route](body, options);
      throw new Error('route inattendue : ' + route);
    },
  };
  runInNewContext(
    [
      cut('const UNTITLED', 'import { setupProjectNavigation }'),
      cut('function renderHistory()', 'async function refreshHistory()'),
      cut('function persistConversation()', 'async function clearHistory()'),
      cut('function savedUser(', 'async function restoreUpdate()'),
      cut('function restoreSession(', 'async function resumeAfterRestart()'),
      cut('async function addFiles(', 'function scrollToBottom()'),
      cut('async function takeBack(', 'function assistantMessage('),
      cut('function assistantMessage(', 'function userContent('),
      // Every part of an answer, in the order the page made them.
      'const madeAssistantMessage = assistantMessage; assistantMessage = parent => { const view = madeAssistantMessage(parent); seen.views.push(view); return view; };',
      cut('function userContent(', 'async function sendMessage('),
      cut('async function sendMessage(', '\nfunction alignConversation()'),
      cut('async function runForTurn(', 'async function runInStudio('),
      cut('async function newConversation(', "document.addEventListener('keydown'"),
      cut('let promptLabel = null;', '// Images need the vision projector'),
      cut("$('cancel').onclick = () => {", "$('thinking').onclick"),
    ].join('\n'),
    context,
  );
  // The form sends as in the page; the turn it began is kept for the test to wait for.
  let sent = Promise.resolve();
  $('chat-form').onsubmit = event => (sent = context.sendMessage(event));
  return {
    ...seen,
    state,
    context,
    $,
    /** The end of the turn the form began last (« Régénérer », Entrée). */
    turn: () => sent,
    /** The user writes and sends. */
    send(words) {
      if (words !== undefined) $('prompt').value = words;
      return context.sendMessage({ preventDefault() {} });
    },
  };
}

/** A card that waits for the user: `shown` once it is on screen, `answer(result)` is their answer. */
function waitingCard() {
  let appear, answer;
  const shown = new Promise(resolve => (appear = resolve));
  return {
    shown,
    answer: result => answer(result),
    requestTool: () =>
      new Promise(resolve => {
        answer = resolve;
        appear();
      }),
  };
}
const made = (runId = 'b2222222-2222-4222-8222-222222222222', mediaType = 'video') => ({
  content: JSON.stringify({ status: 'success', run_id: runId }),
  images: [],
  record: { id: runId, conversationId: ID, mediaType },
});

test('a video card that waits is saved with a result for its call: reopened, the conversation goes on', async t => {
  const store = await historyStore(t),
    card = waitingCard();
  const first = page({
    store,
    chat: (body, n) => (n === 1 ? called(videoProposal()) : n === 2 ? said(PLAN) : said('')),
    requestTool: card.requestTool,
  });
  const turn = first.send('Fais une vidéo d’un renard');
  await card.shown;

  // The card waits (it never starts alone). What the disk holds now: the words of Moodix on their
  // call, and a result for that call, so that the server takes the conversation as it is.
  const saved = first.saves.at(-1);
  assert.deepEqual(roles(saved.messages), ['user', 'assistant', 'tool']);
  assert.equal(saved.incomplete, true);
  assert.equal(saved.messages[1].content, PLAN);
  assert.equal(saved.messages[1].planned, true);
  assert.equal(saved.messages[1].tool_calls[0].id, 'call_1');
  assert.equal(saved.messages[2].tool_call_id, 'call_1');
  assert.deepEqual(JSON.parse(saved.messages[2].content), { status: 'cancelled', unanswered: true, message: transcript.UNANSWERED });
  assert.doesNotThrow(() => accepted(nextMessage(saved.messages)));
  // The note for its words (« a card shows this proposal ») is not kept: no card would be there.
  assert.doesNotMatch(JSON.stringify(saved.messages), /waiting_for_user|WORDS OVER THE CARD/);

  // The page is closed there. Another one opens the conversation from the disk: the words, and
  // where the card was, that it was left without an answer.
  const reopened = page({
    store,
    chat: body => {
      accepted(body.messages);
      return said('D’accord, je la propose de nouveau.');
    },
  });
  await reopened.context.loadConversation(ID);
  assert.deepEqual(reopened.notices.filter(Boolean), []);
  assert.equal(reopened.state.messages.length, 3);
  assert.match(reopened.$('messages').words, /Le renard court dans la neige/);
  assert.deepEqual(
    reopened.$('messages').all('proposal-cancelled').map(line => line.textContent),
    ['Proposition restée sans réponse.'],
  );
  // The user writes again: the message is taken and answered (it was refused for good,
  // « Résultat d’outil manquant. », and the text sent back to the box).
  await reopened.send('Oui, vas-y');
  assert.equal(reopened.requests.length, 1);
  assert.deepEqual(reopened.notices.filter(Boolean), []);
  assert.equal(reopened.$('prompt').value, '');
  assert.equal(reopened.state.messages.at(-1).content, 'D’accord, je la propose de nouveau.');
  assert.equal(reopened.state.messages.at(-2).content, 'Oui, vas-y');

  // In the first page the user presses « Générer »: the call keeps the result of its generation
  // alone, in the page, in what it tells the model next and on the disk.
  card.answer(made());
  await turn;
  for (const messages of [first.state.messages, first.requests.at(-1).messages.slice(1), first.saves.at(-1).messages]) {
    const results = messages.filter(message => message.role === 'tool');
    assert.equal(results.length, 1);
    assert.equal(JSON.parse(results[0].content).status, 'success');
    assert.doesNotMatch(JSON.stringify(messages), /unanswered|waiting_for_user/);
    assert.equal(messages.find(message => message.tool_calls).content, PLAN);
    assert.doesNotThrow(() => accepted(nextMessage(messages)));
  }
  assert.equal(first.saves.at(-1).incomplete, false);
});

// A character to put in a video, with no image of them (replace_character with a description): the
// page makes the image in the Studio, the user checks it, then the replacement runs.
const characterRequest = {
  kind: 'character',
  call: functionCall('replace_character', 'call_replace', '{"source":{"take":3},"character":"un chevalier en armure"}'),
  character: 'un chevalier en armure',
  imagePrompt: 'Un chevalier en armure, en pied',
  sourceSize: { width: 768, height: 448 },
  replace: { source: { take: 3 }, prompt: 'un chevalier en armure' },
  asked: 'Remplace le personnage de la prise 3 par un chevalier',
};
const IMAGE = 'c3333333-3333-4333-8333-333333333333',
  VIDEO = 'd4444444-4444-4444-8444-444444444444';
/** The page of a replacement: `studio` is what the Studio answers, `requestTool` the generations. */
function replacement({ requestTool, studio = {} }) {
  return page({
    chat: () => called(characterRequest),
    requestTool,
    state: {
      studio: {
        accepts: () => true,
        imageSize: () => null,
        follow() {},
        settled: async () => {},
        propose: async () => 'once',
        checkCharacter: async () => ({ decision: 'ok', prompt: '' }),
        ...studio,
      },
    },
    routes: {
      'tools/action': body => Response.json({ call: functionCall(body.name, 'action_' + body.name, '{}'), requestId: 'r-' + body.name, workflowName: 'Studio' }),
    },
  });
}
/** A generation that runs until the turn is stopped; `started` once it runs. */
function running() {
  let begin;
  const started = new Promise(resolve => (begin = resolve));
  return {
    started,
    requestTool: (request, signal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        begin();
      }),
  };
}

test('a character replacement stopped by the user keeps a result for its call: the conversation goes on', async () => {
  // « Interrompre » (or the stop of the Studio) while the image of the character is made…
  const image = running(),
    making = replacement({ requestTool: image.requestTool });
  const turn = making.send('Remplace le personnage de la prise 3 par un chevalier');
  await image.started;
  making.state.controller.abort();
  await turn;
  // … or while the user looks at it (« OK », « Autre image », « Annuler » in the Studio).
  let look;
  const looking = new Promise(resolve => (look = resolve));
  const checking = replacement({
    requestTool: async () => made(IMAGE, 'image'),
    studio: {
      checkCharacter: (record, signal) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          look();
        }),
    },
  });
  const checked = checking.send('Remplace le personnage de la prise 3 par un chevalier');
  await looking;
  checking.state.controller.abort();
  await checked;

  for (const stopped of [making, checking]) {
    for (const messages of [stopped.state.messages, stopped.saves.at(-1).messages]) {
      assert.deepEqual(roles(messages), ['user', 'assistant', 'tool']);
      assert.equal(messages[1].tool_calls[0].id, 'call_replace');
      assert.equal(messages[2].tool_call_id, 'call_replace');
      // Its own result, said to the model as a creation stopped: not the one of a call left unanswered.
      const result = JSON.parse(messages[2].content);
      assert.equal(result.status, 'cancelled');
      assert.equal(result.unanswered, undefined);
      assert.match(result.message, /arrêté ce remplacement avant la fin : rien n’a été produit/);
      // The next message of the user is taken by the server (it was refused: « Résultat d’outil manquant. »).
      assert.doesNotThrow(() => accepted(nextMessage(messages, 'Essaie encore')));
    }
    assert.equal(stopped.views.at(-1).note.textContent, 'Opération interrompue à votre demande.');
    assert.deepEqual(stopped.notices.filter(Boolean), [], 'stopped by the user: no notice');
    assert.equal(stopped.state.generating, false);
    assert.equal(stopped.state.controller, null);
  }
  // The take of the image stopped goes (runForTurn), the one already made stays.
  assert.deepEqual(making.takes[0].told, [['withdraw']]);
  assert.equal(checking.takes[0].told[0][0], 'finish');
});

test('a character replacement that fails keeps what failed as the result of its call', async () => {
  const refusal = 'Une opération GPU est déjà en cours.';
  const failing = replacement({
    requestTool: async () => {
      throw new Error(refusal);
    },
  });
  await failing.send('Remplace le personnage de la prise 3 par un chevalier');
  for (const messages of [failing.state.messages, failing.saves.at(-1).messages]) {
    assert.deepEqual(roles(messages), ['user', 'assistant', 'tool']);
    assert.deepEqual(JSON.parse(messages[2].content), { status: 'error', message: refusal });
    assert.equal(messages[2].tool_call_id, 'call_replace');
    assert.doesNotThrow(() => accepted(nextMessage(messages, 'Essaie encore')));
  }
  assert.equal(failing.views.at(-1).note.textContent, refusal);
  assert.ok(failing.notices.includes(refusal));
  assert.equal(failing.state.generating, false);

  // Kept and made, the replacement is told as before: its video, and the image of the character.
  let generation = 0;
  const done = replacement({ requestTool: async () => (generation++ ? made(VIDEO) : made(IMAGE, 'image')) });
  await done.send('Remplace le personnage de la prise 3 par un chevalier');
  assert.deepEqual(roles(done.state.messages), ['user', 'assistant', 'tool']);
  assert.deepEqual(JSON.parse(done.state.messages[2].content), { status: 'success', run_id: VIDEO, character_image: { output: IMAGE } });
  assert.equal(done.saves.at(-1).incomplete, false);
});

const exchange = () => [
  { role: 'user', content: 'Un renard en pull bleu' },
  { role: 'assistant', content: 'Voici.' },
];

test('a conversation is named once, by its first message: the next ones leave its name alone', async t => {
  // Begun: the bar takes the words of the first message, as the history names it (120 characters).
  const begun = page();
  assert.equal(begun.$('conversation-title').textContent, 'Nouvelle conversation');
  const long = 'Un renard en pull bleu, de face, ' + 'dans une forêt de bouleaux sous la neige, '.repeat(4);
  await begun.send(long);
  assert.equal(begun.$('conversation-title').textContent, long.trim().slice(0, 120));
  // Its second message is not its name (the bar took the whole text of the last message, each time).
  await begun.send('plus sombre');
  assert.equal(begun.$('conversation-title').textContent, long.trim().slice(0, 120));
  assert.equal(begun.state.messages.length, 4);

  // The name the user gave with the pencil stays too.
  const named = page({ state: { messages: exchange(), conversationId: ID } });
  named.$('conversation-title').textContent = 'Mon renard';
  await named.send('plus sombre');
  assert.equal(named.$('conversation-title').textContent, 'Mon renard');

  // With the history, the bar says the name the history keeps: a video alone is named after it
  // (not « Une image à explorer »)…
  const store = await historyStore(t),
    video = { id: 'e5555555-5555-4555-8555-555555555555', label: 'ref3', name: 'plage.mp4' };
  const filmed = page({ store, state: { videos: [video] } });
  await filmed.send('');
  assert.equal(filmed.$('conversation-title').textContent, 'Vidéo · plage.mp4');
  // … and a conversation renamed elsewhere takes that name at its next message.
  await store.rename(ID, 'Sur la plage');
  await filmed.send('Prolonge-la');
  assert.equal(filmed.$('conversation-title').textContent, 'Sur la plage');
});

test('a send that fails before any answer gives the whole draft back: its text, its images, its videos', async () => {
  const video = { id: 'e5555555-5555-4555-8555-555555555555', label: 'ref3', name: 'plage.mp4' },
    image = { name: 'a.png', url: 'data:image/png;base64,AAAA', file: 'original-a.png', view: '/a' },
    draft = () => ({ videos: [video], images: [image] });
  // Refused by the server before the first word…
  const refused = page({
    state: draft(),
    chat: () => {
      throw Object.assign(new Error('Une réponse est déjà en cours.'), { status: 409 });
    },
  });
  await refused.send('Prolonge #ref3');
  assert.ok(refused.notices.includes('Une réponse est déjà en cours.'));
  // … or « Annuler le message en attente » while the model loads.
  const cancelled = page({
    state: draft(),
    waitForModel: async (api, signal) => {
      cancelled.state.controller.abort();
      signal.throwIfAborted();
    },
  });
  await cancelled.send('Prolonge #ref3');
  assert.equal(cancelled.requests.length, 0);

  for (const failed of [refused, cancelled]) {
    assert.equal(failed.$('prompt').value, 'Prolonge #ref3');
    assert.deepEqual(plain(failed.state.images), [image]);
    // The video comes back with its chip (only its « #ref3 » was left, in the text).
    assert.deepEqual(plain(failed.state.videos), [video]);
    assert.equal(failed.state.messages.length, 0);
    assert.equal(failed.$('messages').children.length, 0, 'the message leaves the thread');
    assert.equal(failed.state.generating, false);
  }

  // Sent again, the message names its video for the model, as the first time.
  const sent = page({ state: draft() });
  await sent.send('Prolonge #ref3');
  assert.match(sent.requests[0].messages.at(-1).content[0].text, /^Prolonge #ref3\n\[Vidéo jointe : ref3 « plage.mp4 » — resource_id e5555555-/);
  assert.deepEqual(plain(sent.state.videos), []);
});

// A take of the conversation, and what tools/action answers to one of its buttons.
const take = (given = {}) => ({ id: VIDEO, conversationId: ID, mediaType: 'video', outputs: [{ take: 4 }], ...given });
const actionRoutes = {
  'tools/action': body =>
    Response.json({ call: functionCall(body.name, 'action_' + body.name, JSON.stringify(body.arguments)), requestId: 'r-' + body.name, workflowName: 'Studio' }),
};
const settled = () => new Promise(resolve => setTimeout(resolve, 0));

test('an action on a take ends with its controller: « Interrompre » then cancels the creation of the Studio', async () => {
  const acted = page({ state: { conversationId: ID, messages: exchange() }, routes: actionRoutes, requestTool: async () => made() });
  await acted.context.runOutputAction(take(), 0, 'upscale');
  assert.equal(acted.state.generating, false);
  assert.equal(acted.state.controller, null);
  assert.deepEqual(roles(acted.state.messages), ['user', 'assistant', 'user', 'assistant', 'tool']);
  // Later a creation runs in the Studio (its own controller, no turn of the chat): « Interrompre » of
  // the message box asks the server to cancel that job (it aborted the controller of the upscale
  // again, and nothing was cancelled).
  acted.state.status = { state: 'stopped', toolJob: { id: 'job-of-the-studio' } };
  acted.$('cancel').onclick();
  await settled();
  assert.deepEqual(acted.cancelled, [{ jobId: 'job-of-the-studio' }]);
});

test('an action on a take stopped by the user withdraws its take; failed, the take says why', async () => {
  const job = running(),
    stopped = page({ state: { conversationId: ID, messages: exchange() }, routes: actionRoutes, requestTool: job.requestTool });
  const action = stopped.context.runOutputAction(take(), 0, 'interpolate');
  await job.started;
  // While it runs, « Interrompre » stops this very action.
  stopped.$('cancel').onclick();
  await action;
  // The take goes and the line of the message says it, once (the take said it again, in the words
  // of the browser: « signal is aborted without reason »).
  assert.deepEqual(stopped.takes[0].told, [['withdraw']]);
  assert.equal(stopped.views.at(-1).note.textContent, 'Opération interrompue à votre demande.');
  assert.deepEqual(stopped.notices.filter(Boolean), []);
  assert.deepEqual(stopped.cancelled, [], 'its own controller stops it: no job of another to cancel');
  assert.equal(stopped.state.controller, null);
  // Its call keeps a result all the same.
  assert.deepEqual(roles(stopped.state.messages), ['user', 'assistant', 'user', 'assistant', 'tool']);
  assert.equal(stopped.state.messages[2].content, 'Interpoler la prise 4 pour une vidéo plus fluide.');
  assert.deepEqual(JSON.parse(stopped.state.messages[4].content), { status: 'error', message: 'Génération annulée.' });
  assert.doesNotThrow(() => accepted(nextMessage(stopped.state.messages)));

  // Failed by itself: the take stays and says what failed, the notice too.
  const failed = page({
    state: { conversationId: ID, messages: exchange() },
    routes: actionRoutes,
    requestTool: async () => {
      throw new Error('Mémoire vidéo insuffisante.');
    },
  });
  await failed.context.runOutputAction(take(), 0, 'upscale');
  assert.deepEqual(failed.takes[0].told, [['fail', 'Mémoire vidéo insuffisante.']]);
  assert.ok(failed.notices.includes('Mémoire vidéo insuffisante.'));
  assert.equal(failed.state.controller, null);
});

test('a call written as text in place of the words over a card leaves the card its own words', async () => {
  const leak = '<tool_call>\n<function=create_video>\n<parameter=prompt>\nUn renard\n</parameter>\n</function>\n</tool_call>';
  // The model called without a word, then wrote its call again instead of its words.
  const silent = page({
    chat: (body, n) => (n === 1 ? called(videoProposal()) : n === 2 ? said(leak) : said('')),
    requestTool: async () => ({ content: JSON.stringify({ status: 'denied', cancelled: 'card' }), images: [], denied: true }),
  });
  await silent.send('Fais une vidéo d’un renard');
  assert.equal(silent.takes.length, 1, 'the card was put to the user');
  const calling = silent.state.messages.find(message => message.tool_calls);
  assert.equal(calling.planned, true);
  // Over « Générer », never « I cannot start another generation in this message. ».
  assert.match(calling.content, /^Voici ce que je propose : la carte ci-dessous/);
  assert.doesNotMatch(calling.content, /Je ne peux pas lancer|Renvoyez votre demande|tool_call|function=/);
  assert.equal(silent.views[0].body.textContent, calling.content, 'the same words on the page');
  // What it had written with its call stays before them, as before.
  const led = page({
    chat: (body, n) => (n === 1 ? called(videoProposal(), 'Je confirme : qu’il court.') : n === 2 ? said(leak) : said('')),
    requestTool: async () => ({ content: JSON.stringify({ status: 'denied', cancelled: 'card' }), images: [], denied: true }),
  });
  await led.send('Fais une vidéo d’un renard');
  assert.match(led.state.messages.find(message => message.tool_calls).content, /^Je confirme : qu’il court\.\n\nVoici ce que je propose : la carte ci-dessous/);
  // Outside a card, a call written as text once the tools are withdrawn is still answered for.
  const withdrawn = page({
    chat: (body, n) => (n === 1 ? called({ call: functionCall('create_image'), workflowName: 'Krea', requestId: 'r2' }) : said(leak)),
    requestTool: async () => ({ content: JSON.stringify({ status: 'error', message: 'Échec.' }), images: [], failed: true, error: 'Échec.' }),
  });
  await withdrawn.send('Une image de renard');
  assert.equal(withdrawn.requests[1].tools, false);
  assert.match(withdrawn.state.messages.at(-1).content, /^Je ne peux pas lancer d’autre génération dans ce message\./);
});

test('a conversation opened or begun from the Pellicule leaves it as its tab does: the sound stops, the line moves', async t => {
  const store = await historyStore(t);
  await store.save({ id: ID, messages: exchange(), incomplete: false, instructions: '', projectId: 'inbox' });
  const from = view => {
    const opened = page({ store, state: { view, hushed: 0 } });
    opened.state.hushLibrary = () => opened.state.hushed++;
    return opened;
  };
  // Opened from the Pellicule (the conversation of a take, an action on a take of another one).
  const opened = from('library');
  await opened.context.loadConversation(ID);
  assert.equal(opened.state.view, 'chat');
  assert.equal(opened.state.messages.length, 2);
  assert.equal(opened.state.hushed, 1, 'the sound playing in the Pellicule stops');
  assert.equal(opened.lines.at(-1), 'chat', 'the line goes under « Chat »');
  // Already the one open: shown again, the same way.
  opened.state.view = 'library';
  await opened.context.loadConversation(ID);
  assert.equal(opened.state.view, 'chat');
  assert.equal(opened.state.hushed, 2);
  // « Nouvelle conversation » in the Pellicule.
  const begun = from('library');
  await begun.context.newConversation('inbox');
  assert.equal(begun.state.view, 'chat');
  assert.equal(begun.state.hushed, 1);
  assert.equal(begun.lines.at(-1), 'chat');
  // The Studio on screen stays (Chat and Studio are two views of one conversation); from the Chat
  // there is no sound to stop.
  const studio = from('studio');
  await studio.context.loadConversation(ID);
  await studio.context.newConversation('inbox');
  assert.equal(studio.state.view, 'studio');
  assert.equal(studio.state.hushed, 0);
  const chat = from('chat');
  await chat.context.loadConversation(ID);
  assert.equal(chat.state.view, 'chat');
  assert.equal(chat.state.hushed, 0);
});

test('the message a button of a take writes is not one to edit nor to send again', async () => {
  // As runOutputAction writes it today: by the number of the take, by its run when it has none,
  // the second output of a run.
  for (const [record, index, action, words] of [
    [take(), 0, 'upscale', 'Agrandir et affiner la prise 4.'],
    [take(), 0, 'interpolate', 'Interpoler la prise 4 pour une vidéo plus fluide.'],
    [take({ outputs: [{}, {}] }), 1, 'upscale', `Agrandir et affiner la sortie ${VIDEO} (sortie 2).`],
    [take({ outputs: [{}] }), 0, 'interpolate', `Interpoler la sortie ${VIDEO} pour une vidéo plus fluide.`],
  ]) {
    const acted = page({ state: { conversationId: ID, messages: exchange() }, routes: actionRoutes, requestTool: async () => made() });
    await acted.context.runOutputAction(record, index, action);
    assert.equal(acted.state.messages[2].content, words);
    // Neither « Modifier » nor « Régénérer » under it (turnActions draws them from lastExchange)…
    assert.equal(transcript.lastExchange(acted.state.messages), -1, words);
    // … and « Régénérer » called all the same takes nothing back and sends nothing to the model.
    await acted.context.takeBack(true);
    await acted.turn();
    assert.equal(acted.state.messages.length, 5);
    assert.equal(acted.requests.length, 0);
    assert.equal(acted.$('prompt').value, '');
    // What the user writes after it is theirs to take back.
    const after = [...acted.state.messages, { role: 'user', content: 'Merci' }, { role: 'assistant', content: 'De rien.' }];
    assert.equal(transcript.lastExchange(after), 5);
  }
});

test('a message sent again keeps its own words: the label of a shortcut is for the next one', async () => {
  const again = page({ state: { conversationId: ID, messages: exchange() } });
  // « Image » chosen under the message box (the label « Image × »), nothing written yet.
  const shortcut = new El('button');
  shortcut.dataset = { prompt: 'Crée une image : ', label: 'Image' };
  again.context.setPromptLabel(shortcut);
  assert.equal(again.$('prompt-label').hidden, false);
  // « Régénérer » on the last reply: the same message, as it was.
  await again.context.takeBack(true);
  await again.turn();
  assert.equal(again.requests.length, 1);
  assert.equal(again.requests[0].messages.at(-1).content, 'Un renard en pull bleu');
  assert.equal(again.state.messages.at(-2).content, 'Un renard en pull bleu');
  assert.equal(again.state.resent, false);
  // The label waits for the message it was chosen for…
  assert.equal(again.$('prompt-label').hidden, false);
  // … which takes it when it is sent, and the label goes.
  again.$('prompt').value = 'un chat roux';
  again.$('chat-form').requestSubmit();
  await again.turn();
  assert.equal(again.requests.length, 2);
  assert.equal(again.requests[1].messages.at(-1).content, 'Crée une image : un chat roux');
  assert.equal(again.$('prompt-label').hidden, true);
});

test('a file joined while a creation of the Studio runs is refused in words, not lost in silence', async () => {
  const imported = [],
    reference = { id: 'e5555555-5555-4555-8555-555555555555', label: 'ref1', name: 'plage.mp4' },
    file = { name: 'plage.mp4', type: 'video/mp4' };
  const joined = page({ state: { status: { state: 'stopped', toolJob: { id: 'job-of-the-studio' } } } });
  joined.context.assetsUI.importFiles = async files => (imported.push(...files), [reference]);
  // The « + » stays within reach while the Studio generates (and a file can be dropped or pasted).
  await joined.context.addFiles([file]);
  assert.deepEqual(joined.notices, ['Attendez la fin de la génération en cours pour joindre un fichier.']);
  assert.equal(imported.length, 0);
  assert.deepEqual(plain(joined.state.videos), []);
  // Nothing chosen: nothing said. In a turn of the chat that generates, the « + » is disabled: no word either.
  await joined.context.addFiles([]);
  joined.state.generating = true;
  await joined.context.addFiles([file]);
  assert.equal(joined.notices.length, 1);
  assert.equal(imported.length, 0);
  // The creation over, the file is joined.
  joined.state.generating = false;
  joined.state.status = { state: 'ready' };
  await joined.context.addFiles([file]);
  assert.deepEqual(imported, [file]);
  assert.deepEqual(plain(joined.state.videos), [reference]);
});

test('a creation made by a turn of the Chat tells the Studio to read its takes again', async () => {
  const studioOf = () => {
    const studio = { read: 0, shown: [], accepts: () => true, propose: async () => 'once', follow() {} };
    studio.invalidate = () => studio.read++;
    studio.settled = result => studio.shown.push(result);
    return studio;
  };
  const image = { call: functionCall('create_image'), workflowName: 'Krea', requestId: 'r2' },
    turnOf = (state, requestTool) => page({ state, requestTool, chat: (body, n) => (n === 1 ? called(image) : said('')) });
  // Made from the Chat: the Sortie and the screen of the Studio did not know of the take.
  const chat = turnOf({ studio: studioOf() }, async () => made(IMAGE, 'image'));
  await chat.send('Une image de renard');
  assert.equal(chat.state.studio.read, 1);
  assert.deepEqual(chat.state.studio.shown, []);
  // Nothing made (declined): nothing to read again.
  const declined = turnOf({ studio: studioOf() }, async () => ({ content: JSON.stringify({ status: 'denied' }), images: [], denied: true }));
  await declined.send('Une image de renard');
  assert.equal(declined.state.studio.read, 0);
  // Made by the agent of the Studio: the Studio is given the take itself, as before.
  const agent = turnOf({ view: 'studio', studio: studioOf() }, async () => made(IMAGE, 'image'));
  await agent.send('Une image de renard');
  assert.equal(agent.state.studio.read, 0);
  assert.equal(agent.state.studio.shown.length, 1);
  assert.equal(agent.state.studio.shown[0].record.id, IMAGE);
});

test('every call is followed by its result; a history that is sound is left as it is', () => {
  const { closedCalls, UNANSWERED } = transcript,
    user = { role: 'user', content: 'Deux images' },
    calling = id => ({ role: 'assistant', content: '', tool_calls: [functionCall('create_image', id)] }),
    result = id => ({ role: 'tool', tool_call_id: id, content: '{"status":"success"}' }),
    unanswered = id => ({ role: 'tool', tool_call_id: id, content: JSON.stringify({ status: 'cancelled', unanswered: true, message: UNANSWERED }) });
  // Sound: the same messages (the very objects), nothing added; the pixels read for the model after
  // a result and an answer after it change nothing.
  const sound = [user, calling('a'), result('a'), { role: 'user', internal: true, content: 'Copies' }, calling('b'), result('b'), { role: 'assistant', content: 'Voilà.' }];
  const kept = closedCalls(sound);
  assert.equal(kept.length, sound.length);
  assert.ok(kept.every((message, index) => message === sound[index]));
  assert.deepEqual(closedCalls([]), []);
  // A call left without its result, at the end or before what follows: one result, right after it.
  assert.deepEqual(closedCalls([user, calling('a')]), [user, calling('a'), unanswered('a')]);
  assert.deepEqual(closedCalls([user, calling('a'), { role: 'user', content: 'Alors ?' }, calling('b'), result('b')]), [
    user,
    calling('a'),
    unanswered('a'),
    { role: 'user', content: 'Alors ?' },
    calling('b'),
    result('b'),
  ]);
  // The same identifier used twice by the model: each call is answered by what follows it at once.
  assert.deepEqual(closedCalls([calling('a'), result('a'), calling('a')]), [calling('a'), result('a'), calling('a'), unanswered('a')]);
  // What it gives is what the server asks for, and it says that nothing was made.
  assert.throws(() => accepted(nextMessage([user, calling('a')])), /Résultat d’outil manquant/);
  assert.doesNotThrow(() => accepted(nextMessage(closedCalls([user, calling('a')]))));
  assert.match(UNANSWERED, /rien n’a été produit/);
});

test('a conversation kept before 0.6.31 with a call left without its result is read with one', async t => {
  const store = await historyStore(t),
    OTHER = 'f6666666-6666-4666-8666-666666666666';
  // As 0.6.30 saved them: the card of a video that waited when the page closed (the words on their
  // call), and a character replacement stopped before its end (a call alone).
  const waited = [
      { role: 'user', content: 'Fais une vidéo d’un renard' },
      { role: 'assistant', content: PLAN, planned: true, tool_calls: [functionCall('create_video')] },
    ],
    stoppedBefore = [
      { role: 'user', content: 'Remplace le personnage de la prise 3 par un chevalier' },
      { role: 'assistant', content: '', tool_calls: [characterRequest.call] },
    ];
  await store.save({ id: ID, messages: waited, incomplete: true, instructions: '', projectId: 'inbox' });
  await store.save({ id: OTHER, messages: stoppedBefore, incomplete: true, instructions: '', projectId: 'inbox' });
  // What the server answered to every message of such a conversation.
  assert.throws(() => accepted(nextMessage(waited)), /Résultat d’outil manquant/);

  const taken = body => {
    accepted(body.messages);
    return said('Entendu.');
  };
  const card = page({ store, chat: taken });
  await card.context.loadConversation(ID);
  assert.deepEqual(roles(card.state.messages), ['user', 'assistant', 'tool']);
  assert.equal(JSON.parse(card.state.messages[2].content).unanswered, true);
  assert.deepEqual(
    card.$('messages').all('proposal-cancelled').map(line => line.textContent),
    ['Proposition restée sans réponse.'],
  );
  await card.send('Oui, vas-y');
  assert.equal(card.requests.length, 1);
  assert.deepEqual(card.notices.filter(Boolean), []);
  assert.equal(card.state.messages.at(-1).content, 'Entendu.');
  // Saved again, it is sound on the disk too.
  assert.doesNotThrow(() => accepted(nextMessage(card.saves.at(-1).messages)));

  // A call alone: its line says that the demand came to nothing (not « génération interrompue »).
  const replaced = page({ store, chat: taken });
  await replaced.context.loadConversation(OTHER);
  assert.deepEqual(roles(replaced.state.messages), ['user', 'assistant', 'tool']);
  assert.deepEqual(
    replaced.$('messages').all('message-step').map(line => line.textContent),
    ['Personnage remplacé : demande restée sans suite.'],
  );
  await replaced.send('Essaie encore');
  assert.equal(replaced.requests.length, 1);
  assert.deepEqual(replaced.notices.filter(Boolean), []);

  // Taken back after an update or « Redémarrer » (the page of 0.6.30 kept it so): read with one too.
  const restored = page({ chat: taken });
  restored.context.restoreSession({ messages: plain(waited), conversationId: ID, archiveSnapshot: null, images: [], thinking: true, prompt: '', title: 'Renard' });
  assert.deepEqual(roles(restored.state.messages), ['user', 'assistant', 'tool']);
  assert.equal(restored.$('conversation-title').textContent, 'Renard');
  await restored.send('Oui, vas-y');
  assert.equal(restored.requests.length, 1);
  assert.deepEqual(restored.notices.filter(Boolean), []);
});

test('the consigne of a creation that failed is settled in what the model is sent next, not in what is kept', async () => {
  const { FAILED_NOTE, FAILED_SETTLED } = transcript;
  const failedBefore = [
    { role: 'user', content: 'Une vidéo de renard' },
    { role: 'assistant', content: '', tool_calls: [functionCall('create_video')] },
    { role: 'tool', tool_call_id: 'call_1', content: JSON.stringify({ status: 'error', message: 'Mémoire vidéo insuffisante.', note: FAILED_NOTE }) },
    { role: 'assistant', content: 'La génération a échoué.' },
  ];
  const next = page({ state: { conversationId: ID, messages: failedBefore } });
  await next.send('Recommence');
  // The model, its tools back, no longer reads « no tool is left, write no call »…
  const sent = JSON.parse(next.requests[0].messages.find(message => message.role === 'tool').content);
  assert.equal(next.requests[0].tools, true);
  assert.equal(sent.note, FAILED_SETTLED);
  assert.equal(sent.message, 'Mémoire vidéo insuffisante.');
  // … and the conversation keeps what was written when it failed.
  assert.equal(JSON.parse(next.state.messages[2].content).note, FAILED_NOTE);
  assert.equal(JSON.parse(next.saves.at(-1).messages[2].content).note, FAILED_NOTE);
});

/** An answer that says `events`, then stays open until the turn is stopped (it fails then, as fetch does). */
const unfinished = (events, signal) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder(),
          say = event => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        for (const event of events) say(event);
        // It goes on a moment later (the page draws an answer at most every 55 ms).
        const more = setTimeout(() => say({ choices: [{ delta: {} }] }), 80);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(more);
            controller.error(signal.reason);
          },
          { once: true },
        );
      },
    }),
  );
async function until(holds) {
  for (let tries = 0; tries < 500 && !holds(); tries++) await settled();
  assert.ok(holds(), 'the page never came to that point');
}
const LEAD = 'Je confirme : qu’il court.';
/** « Interrompre » while Moodix writes its words over the card to come (`lead`: what it wrote with its call). */
async function stoppedOverCard(lead = '') {
  const stopped = page({
    chat: (body, n, options) => (n === 1 ? called(videoProposal(), lead) : unfinished(said('Le renard court', null), options.signal)),
  });
  const turn = stopped.send('Fais une vidéo d’un renard');
  await until(() => stopped.views[0]?.body.textContent.includes('Le renard court'));
  stopped.$('cancel').onclick();
  await turn;
  return stopped;
}

test('stopped while Moodix writes its words over a card: no card comes, and what is kept is taken by the server', async () => {
  for (const lead of ['', LEAD]) {
    const stopped = await stoppedOverCard(lead);
    assert.equal(stopped.requests.length, 2);
    assert.equal(stopped.takes.length, 0, 'no card, no take');
    assert.equal(stopped.views[0].note.textContent, 'Opération interrompue à votre demande.');
    assert.deepEqual(stopped.notices.filter(Boolean), []);
    // What it had written stays on the page.
    assert.match(stopped.views[0].body.textContent, /Le renard court$/);
    if (lead) assert.ok(stopped.views[0].body.textContent.startsWith(LEAD));
    assert.equal(stopped.state.generating, false);
    assert.equal(stopped.state.controller, null);
    // Its call has one result, in the page and on the disk, and the next message is taken.
    const saved = stopped.saves.at(-1);
    assert.equal(saved.incomplete, true);
    for (const messages of [stopped.state.messages, saved.messages]) {
      assert.equal(messages.filter(message => message.role === 'tool' && message.tool_call_id === 'call_1').length, 1);
      assert.doesNotThrow(() => accepted(nextMessage(messages, 'Finalement, fais-la')));
    }
    assert.deepEqual(roles(saved.messages), roles(stopped.state.messages));
  }
});

// (0.6.31 kept the note for the words, « a card shows this proposal », when none came, and the words
// begun in a message of their own, what was written with the call said a second time.)
test('stopped while Moodix writes its words over a card: its call keeps them, and the result of a proposal never shown', async () => {
  for (const lead of ['', LEAD]) {
    const stopped = await stoppedOverCard(lead),
      words = (lead ? lead + '\n\n' : '') + 'Le renard court';
    for (const messages of [stopped.state.messages, stopped.saves.at(-1).messages]) {
      assert.deepEqual(roles(messages), ['user', 'assistant', 'tool']);
      // Once, on the call they were for; not agreed on (the card will come with its words again).
      assert.equal(messages[1].content, words);
      assert.equal(messages[1].planned, undefined);
      const result = JSON.parse(messages[2].content);
      assert.equal(result.status, 'cancelled');
      assert.equal(result.unanswered, undefined);
      assert.match(result.message, /rien n’a été produit/);
      assert.doesNotMatch(JSON.stringify(messages), /waiting_for_user|WORDS OVER THE CARD/);
    }
    // The proposal the server kept for the card is let go.
    assert.deepEqual(stopped.cancelled, [{ requestId: 'r1' }]);
    assert.equal(stopped.views[0].body.textContent, words, 'the page keeps what it showed');
  }
});
