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
import { runSeries } from '../public/image-series.mjs';
import { takesOf } from '../public/take-recovery.mjs';
import { takeContent } from '../public/generation-runtime.mjs';
import { History, MAX_CONVERSATION_MESSAGES } from '../lib/history.mjs';
import { nativeFields } from '../lib/native-messages.mjs';
import { problem } from '../lib/engine.mjs';
import { briefMissing } from '../lib/video-brief.mjs';

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
      // A fragment gives its children, as the DOM's does (a conversation set aside comes back, 0.6.81).
      if (item instanceof El && item.tag === 'fragment') {
        const moved = item.children;
        item.children = [];
        this.append(...moved);
        continue;
      }
      // Put in a fragment, a node leaves where it was (a conversation set aside).
      if (item instanceof El && this.tag === 'fragment' && item.parent) item.parent.children = item.parent.children.filter(child => child !== item);
      if (item instanceof El) item.parent = this;
      this.children.push(item);
    }
  }
  get childNodes() {
    return [...this.children];
  }
  get childElementCount() {
    return this.children.length;
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
  brief: true,
  cardBrief: 'WORDS OVER THE CARD',
  studioBrief: 'WORDS BEFORE THE STUDIO',
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
 * (tools/cancel), `lines`, `drawn` (the navigation drawn whole, « all », or its line « Reprendre »
 * alone, « resume »).
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
  const seen = { requests: [], saves: [], notices: [], takes: [], restored: [], views: [], failures: [], cancelled: [], lines: [], cited: [], drawn: [] };
  const node = (tag, className, words) => new El(tag, className, words);
  const context = {
    ...sessionCopies,
    ...chatVideos,
    ...transcript,
    reflection,
    thoughtTime,
    readSSE,
    runSeries,
    takesOf,
    takeContent,
    // The conversation shown, drawn again from its messages (app.js).
    rerender: () => seen.drawn.push('rerender'),
    state,
    $,
    node,
    seen,
    icon: () => node('svg'),
    document: { querySelectorAll: () => [], createDocumentFragment: () => new El('fragment') },
    AbortController,
    DOMException,
    performance,
    console,
    // The page waits for the server to hand the card back after a stop (generationOver, 0.6.84).
    setTimeout,
    clearTimeout,
    // And for the user to come back to the conversation of a step that needs its Studio (backHere).
    setInterval,
    clearInterval,
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
    projectUI: { render: () => seen.drawn.push('all'), sync() {}, renderResume: () => seen.drawn.push('resume') },
    assetsUI: { flush: async () => true, refresh: async () => {}, importFiles: async () => [] },
    // The takes a reply names, under it (cited-takes.mjs): what is asked of it, in its order.
    citedTakes: { show: () => seen.cited.push('show'), forget: () => seen.cited.push('forget') },
    generationUI: {
      // A take of the message: what the page tells it is kept (`told`).
      mount(container, request, options) {
        // (`progressed`: what each progress handed to it, its time included.)
        const take = { container, request, options, told: [], progressed: [], progress: (...given) => take.progressed.push(given), image() {} };
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
      cut('function renderHistory(', 'async function refreshHistory()'),
      cut('function persistConversation(', 'async function clearHistory()'),
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
      // A creation of the Studio, written in its conversation (0.6.81: wherever the user is meanwhile).
      cut('async function runInStudio(', 'const tokenControls = setupTokenControls'),
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
  // The takes its replies name are read again, before its words are drawn: one deleted since (in the
  // Pellicule, in the Studio) was still drawn from what had been read.
  assert.deepEqual(reopened.cited, ['forget', 'show']);
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

// What the server answers to a video the model calls for (server.mjs): its proposal, which may start
// alone as the settings of the Studio allow by default, with what Moodix is to say of it when the
// user has not had it under their eyes yet (the rule itself: lib/video-brief.mjs).
const FOX = '{"prompt":"un renard court dans la neige","duration":5}';
const videoAnswer = (body, id, args = FOX) => {
  const call = functionCall('create_video', id, args);
  return called({
    call,
    workflowName: 'LTX',
    requestId: 'r-' + id,
    approvalToken: 't-' + id,
    mediaType: 'video',
    autoAllow: true,
    ...(briefMissing(body.messages, call) ? { brief: true, cardBrief: 'WORDS OVER THE CARD', studioBrief: 'WORDS BEFORE THE STUDIO' } : {}),
  });
};
// A generation as generation-runtime.mjs runs it: the answer of the user first, where the page asks for it.
const asApproved = async (request, signal, onProgress, onImage, options) =>
  (await options.approve(request, signal)) === 'once'
    ? made()
    : { content: JSON.stringify({ status: 'denied', message: 'L’utilisateur a refusé cette génération. Ne réessaie pas sans nouvelle demande.' }), images: [], denied: true };
/**
 * The Studio as the page drives it (public/studio.mjs): each proposal set there is kept as it came
 * (`proposed`); the pointer presses « Générer » itself when it may, else it rests there until
 * `generate()` (the user's click) or `decline()` (« Refuser », a new message). `screen`: the take on its screen.
 */
function studioOf({ screen = null } = {}) {
  let answer = null;
  const give = decision => {
    const resolve = answer;
    answer = null;
    resolve(decision);
  };
  const studio = {
    proposed: [],
    // What the page gave it to say at the top of its screen with each (0.6.95).
    said: [],
    accepts: () => true,
    follow() {},
    settled: async () => {},
    screenTake: () => screen,
    propose: (proposal, signal, options) => {
      studio.proposed.push(plain(proposal));
      studio.said.push(options?.said);
      return proposal.autoAllow === true ? Promise.resolve('once') : new Promise(resolve => (answer = resolve));
    },
    waiting: () => Boolean(answer),
    generate: () => give('once'),
    decline: () => Boolean(answer) && (give('deny'), true),
  };
  return studio;
}
/** The cards of the Chat (proposal-card.mjs) of a page: each waits for `generate()` or `decline()`. */
function cardsOf(target) {
  const cards = [];
  target.context.proposalCard = ({ request }) => {
    let give;
    const card = { request: plain(request), answer: new Promise(resolve => (give = resolve)), generate: () => give('once'), decline: () => give('deny') };
    cards.push(card);
    return card;
  };
  return cards;
}
const resultsOf = (messages, id) => messages.filter(message => message.role === 'tool' && message.tool_call_id === id).map(message => JSON.parse(message.content));

test('in the Studio a video the user has not seen is set there with the words of Moodix and waits on « Générer »: one click, one result', async t => {
  const store = await historyStore(t),
    studio = studioOf({ screen: { take: 4, media: 'video' } });
  const agent = page({
    store,
    state: { view: 'studio', studio },
    chat: (body, n) => (n === 1 ? videoAnswer(body, 'call_1') : said(PLAN)),
    requestTool: asApproved,
  });
  const turn = agent.send('Fais une vidéo d’un renard');
  await until(() => studio.waiting());
  // 1: its call. 2: its words, without tools, after the note of the Studio (no plan to answer by « go »).
  assert.equal(agent.requests.length, 2);
  assert.equal(agent.requests[1].tools, false);
  assert.deepEqual(JSON.parse(agent.requests[1].messages.at(-1).content), { status: 'waiting_for_user', message: 'WORDS BEFORE THE STUDIO' });
  // The proposal is in the Studio, once, and the pointer rests on « Générer »: the settings allow a
  // video to start alone (`autoAllow` from the server), not one the user sees for the first time.
  assert.equal(studio.proposed.length, 1);
  assert.equal(studio.proposed[0].call.id, 'call_1');
  assert.equal(studio.proposed[0].autoAllow, false);
  // While it waits the disk holds the words on their call, and a result for it (the page may close).
  const waited = agent.saves.at(-1).messages;
  assert.deepEqual(roles(waited), ['user', 'assistant', 'tool']);
  assert.equal(waited[1].content, PLAN);
  assert.equal(waited[1].planned, true);
  assert.equal(resultsOf(waited, 'call_1')[0].unanswered, true);
  assert.doesNotMatch(JSON.stringify(waited), /waiting_for_user|WORDS BEFORE THE STUDIO/);
  // « Générer »: the video is made, without another word of the model.
  studio.generate();
  await turn;
  assert.equal(agent.requests.length, 2, 'no second call of the model');
  for (const messages of [agent.state.messages, agent.saves.at(-1).messages, (await store.read(ID)).messages]) {
    assert.deepEqual(roles(messages), ['user', 'assistant', 'tool']);
    assert.deepEqual(resultsOf(messages, 'call_1').map(result => result.status), ['success']);
    assert.doesNotMatch(JSON.stringify(messages), /unanswered|waiting_for_user/);
    assert.equal(messages[1].content, PLAN);
    assert.doesNotThrow(() => accepted(nextMessage(messages)));
  }
  assert.equal(agent.saves.at(-1).incomplete, false);
  // What its screen showed as the user wrote goes with every request of the turn.
  assert.deepEqual(agent.requests.map(request => request.screen), [{ take: 4, media: 'video' }, { take: 4, media: 'video' }]);
  // And that it is asked from the Studio: made with the LoRAs the Studio shows, not those saved.
  assert.ok(agent.requests.every(request => request.inStudio === true));

  // « Refuser » instead: one result too, and the turn ends there.
  const other = studioOf(),
    refused = page({ state: { view: 'studio', studio: other }, chat: (body, n) => (n === 1 ? videoAnswer(body, 'call_1') : said(PLAN)), requestTool: asApproved });
  const declined = refused.send('Fais une vidéo d’un renard');
  await until(() => other.waiting());
  other.decline();
  await declined;
  assert.equal(refused.requests.length, 2);
  assert.deepEqual(resultsOf(refused.state.messages, 'call_1').map(result => result.status), ['denied']);
  // A screen without a take says nothing.
  assert.ok(refused.requests.every(request => !('screen' in request)));
});

test('in the Studio the words Moodix wrote for its proposal go with it, said at the top of the screen; never the line the page writes in their place (0.6.95)', async () => {
  // The Studio showed the settings moving and the prompt, and nothing of what Moodix meant (studio-explain.mjs).
  const turn = async (chat, done = studio => studio.decline()) => {
    const studio = studioOf(),
      agent = page({ state: { view: 'studio', studio }, chat, requestTool: asApproved });
    const sent = agent.send('Fais une vidéo d’un renard');
    await until(() => studio.waiting());
    const said = [...studio.said],
      waited = agent.saves.at(-1).messages;
    done(studio);
    await sent;
    return { said, waited };
  };
  // A video not seen yet: the words written for it, after its call.
  assert.deepEqual((await turn((body, n) => (n === 1 ? videoAnswer(body, 'call_1') : said(PLAN)))).said, [PLAN]);
  // With what it wrote with its call before them, as the chat shows them.
  const led = await turn((body, n) => {
    if (n !== 1) return said(PLAN);
    const [, { local_tool_request }] = videoAnswer(body, 'call_1');
    return called(local_tool_request, 'Je règle le Studio.');
  });
  assert.deepEqual(led.said, ['Je règle le Studio.\n\n' + PLAN]);
  // Nothing written: the chat has the line of the page; the Studio is given nothing, it says the
  // proposal in its own sentence.
  const silent = await turn((body, n) => (n === 1 ? videoAnswer(body, 'call_1') : said('')));
  assert.match(silent.waited[1].content, /^Voici ce que je propose : le Studio montre la durée/);
  assert.deepEqual(silent.said, ['']);
  // An image: the words with its call (no plan is asked for it).
  const image = await turn(
    () => called({ call: functionCall('create_image', 'call_1'), workflowName: 'Krea 2', requestId: 'r1', approvalToken: 't1' }, 'Un renard roux dans la neige, en 1:1.'),
    studio => studio.generate(),
  );
  assert.deepEqual(image.said, ['Un renard roux dans la neige, en 1:1.']);
});

test('in the Studio the same proposal sent again after the user answered in words starts as the settings allow; another one waits again', async () => {
  const studio = studioOf();
  const agent = page({
    state: { view: 'studio', studio },
    // The model proposes, writes its words, then makes the same call again once the user wrote « go ».
    chat: (body, n) => (n === 2 ? said(PLAN) : videoAnswer(body, 'call_' + n)),
    requestTool: asApproved,
  });
  const turn = agent.send('Fais une vidéo d’un renard');
  await until(() => studio.waiting());
  // Their message declines the proposal that waited; the answer of the model is the same proposal.
  await agent.send('go');
  await turn;
  assert.equal(agent.requests.length, 3, 'no words asked a second time');
  assert.deepEqual(
    studio.proposed.map(proposal => [proposal.call.id, proposal.autoAllow]),
    [['call_1', false], ['call_3', true]],
  );
  assert.deepEqual(roles(agent.state.messages), ['user', 'assistant', 'tool', 'user', 'assistant', 'tool']);
  assert.deepEqual(resultsOf(agent.state.messages, 'call_1').map(result => result.status), ['denied']);
  assert.deepEqual(resultsOf(agent.state.messages, 'call_3').map(result => result.status), ['success']);
  assert.equal(agent.state.messages[1].planned, true);
  assert.equal(agent.state.messages[4].planned, undefined);

  // A correction instead of « go »: the call that comes is a proposal nobody saw (another length).
  // It comes with its words and waits in its turn (17/11: it started by itself).
  const other = studioOf();
  const corrected = page({
    state: { view: 'studio', studio: other },
    chat: (body, n) =>
      n % 2 === 0 ? said(PLAN) : videoAnswer(body, 'call_' + n, n === 1 ? FOX : '{"prompt":"un renard court dans la neige","duration":8}'),
    requestTool: asApproved,
  });
  const begun = corrected.send('Fais une vidéo d’un renard');
  await until(() => other.waiting());
  const next = corrected.send('Non, plutôt 8 secondes');
  await until(() => other.proposed.length === 2 && other.waiting());
  assert.equal(corrected.requests.length, 4);
  assert.deepEqual(JSON.parse(corrected.requests[3].messages.at(-1).content), { status: 'waiting_for_user', message: 'WORDS BEFORE THE STUDIO' });
  assert.deepEqual(other.proposed.map(proposal => proposal.autoAllow), [false, false]);
  other.generate();
  await Promise.all([begun, next]);
  assert.deepEqual(resultsOf(corrected.state.messages, 'call_3').map(result => result.status), ['success']);
  assert.equal(corrected.requests.length, 4);
});

test('in the Chat nothing changes: the card with the words of Moodix at the first call, the card alone when the same call comes back', async () => {
  const chat = page({
    chat: (body, n) => (n === 1 || n === 3 ? videoAnswer(body, 'call_' + n) : n === 2 ? said(PLAN) : said('')),
    requestTool: asApproved,
  });
  const cards = cardsOf(chat);
  const turn = chat.send('Fais une vidéo d’un renard');
  await until(() => cards.length === 1);
  assert.equal(chat.requests.length, 2);
  assert.deepEqual(JSON.parse(chat.requests[1].messages.at(-1).content), { status: 'waiting_for_user', message: 'WORDS OVER THE CARD' });
  assert.equal(chat.state.messages.length, 0, 'the turn waits on its card');
  // The user answers in words: the card goes, and the same call of the model brings it back alone.
  const next = chat.send('go');
  await until(() => cards.length === 2);
  assert.equal(chat.requests.length, 3, 'no words asked for the card that comes back');
  assert.equal(cards[1].request.call.id, 'call_3');
  // It waits there whatever the settings allow: in the Chat a video never starts by itself.
  assert.equal(chat.state.generating, true);
  cards[1].generate();
  await Promise.all([turn, next]);
  const messages = chat.state.messages;
  assert.deepEqual(roles(messages), ['user', 'assistant', 'tool', 'user', 'assistant', 'tool']);
  assert.deepEqual([messages[1].planned, messages[1].content], [true, PLAN]);
  assert.deepEqual([messages[4].planned, messages[4].content], [undefined, '']);
  assert.deepEqual(resultsOf(messages, 'call_1').map(result => result.status), ['denied']);
  assert.deepEqual(resultsOf(messages, 'call_3').map(result => result.status), ['success']);
  // From the Chat nothing is said of a screen.
  assert.ok(chat.requests.every(request => !('screen' in request)));
  // Nor that it comes from the Studio: the server takes the LoRAs saved for the model.
  assert.ok(chat.requests.every(request => !('inStudio' in request)));
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
function replacement({ requestTool, studio = {}, chat = () => called(characterRequest) }) {
  return page({
    chat,
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

test('a character put in a video: its image is said in the Studio as such, the replacement with the words of Moodix for its call (0.6.95)', async () => {
  const words = 'Je mets un chevalier en armure à la place du personnage de la prise 3.',
    told = [];
  const replaced = replacement({
    chat: () => called(characterRequest, words),
    // Each step answered where the page asks for it (generation-runtime.mjs): the image, then the replacement.
    requestTool: async (request, signal, onProgress, onImage, options) => {
      await options.approve(request, signal);
      return request.call.function.name === 'create_image' ? made(IMAGE, 'image') : made(VIDEO, 'video');
    },
    studio: { propose: async (proposal, signal, options) => (told.push([proposal.call.function.name, plain(options)]), 'once') },
  });
  await replaced.send('Remplace le personnage de la prise 3 par un chevalier');
  assert.deepEqual(told, [
    ['create_image', { said: '', purpose: 'character' }],
    ['replace_character', { said: words, purpose: '' }],
  ]);
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

/** Waits for what the page does behind a turn (the name of the conversation, asked beside it). */
async function eventually(check) {
  for (let tries = 0; tries < 200 && !check(); tries++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), 'attendu en vain');
}

test('the name the model gives a conversation is written where it shows, without the navigation drawn again', async () => {
  const asked = [];
  let release;
  const held = new Promise(resolve => (release = resolve));
  const named = page({
    routes: {
      'history/title': async body => {
        asked.push(plain(body));
        await held;
        return Response.json({ conversation: { id: ID, title: 'Renard bleu' } });
      },
    },
  });
  await named.send('Un renard en pull bleu, de face');
  // The turn is over and its name is being asked: meanwhile the user opens a list of the fil.
  await eventually(() => asked.length === 1);
  assert.deepEqual(asked[0], { id: ID, contents: ['Un renard en pull bleu, de face'] });
  const before = named.drawn.length;
  release();
  await eventually(() => named.$('conversation-title').textContent === 'Renard bleu');
  // Only what the name changes: the bar, the label of its button, the list of the history and the
  // line « Reprendre ». The navigation drawn whole closed the menu open meanwhile, with what was
  // typed in its search field.
  assert.deepEqual(named.drawn.slice(before), ['resume']);
  assert.equal(named.$('thread-conversation').getAttribute('aria-label'), 'Conversation : Renard bleu');
  assert.equal(named.state.historyItems.find(item => item.id === ID).title, 'Renard bleu');
  // Named: not asked again at the next message.
  await named.send('plus sombre');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(asked.length, 1);

  // In the Pellicule the button of the fil says another name (the conversation shown there): left.
  const elsewhere = page({
    routes: { 'history/title': async () => Response.json({ conversation: { id: ID, title: 'Renard bleu' } }) },
  });
  elsewhere.$('conversation-title').hidden = true;
  elsewhere.$('thread-conversation').setAttribute('aria-label', 'Conversation : Toutes les conversations');
  await elsewhere.send('Un renard en pull bleu');
  await eventually(() => elsewhere.$('conversation-title').textContent === 'Renard bleu');
  assert.equal(elsewhere.$('thread-conversation').getAttribute('aria-label'), 'Conversation : Toutes les conversations');
});

test('a conversation is named after the first of its messages that has words, asked again while there is none', async () => {
  const asked = [];
  let answer = { later: true };
  const { context, state } = page({
    routes: {
      'history/title': async body => {
        asked.push(plain(body));
        return Response.json(answer);
      },
    },
  });
  const picture = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    studio = 'Studio · Image : \n\n' + transcript.STUDIO_NOTE,
    made = [
      // A creation of the Studio made without a prompt: nothing to name the conversation from.
      { role: 'user', internal: true, content: studio },
      { role: 'assistant', content: '', tool_calls: [functionCall('create_image')] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"status":"success"}' },
    ],
    written = [
      ...made,
      { role: 'user', content: [{ type: 'text', text: 'Rends-la plus sombre' }, picture] },
      // What the application writes for the model is not a message of the user: never a name.
      { role: 'user', internal: true, content: [{ type: 'text', text: 'Voici les copies réduites des sorties.' }, picture] },
      { role: 'user', internal: true, resourceId: 'r1', content: [{ type: 'text', text: 'Référence visuelle' }, picture] },
      { role: 'assistant', content: 'Voilà.' },
    ];
  await context.nameConversation(made, ID);
  assert.deepEqual(asked, [{ id: ID, contents: [studio] }]);
  // Nothing to name it from yet (`later`): asked again at the end of the next turn, with the words
  // written since. The first message goes as it is; of the next ones, the words alone.
  await context.nameConversation(written, ID);
  assert.deepEqual(asked[1], { id: ID, contents: [studio, [{ type: 'text', text: 'Rends-la plus sombre' }]] });
  // Not to be asked again (`named: false`: the model answered no name twice, or is not asked).
  answer = { named: false };
  await context.nameConversation(written, ID);
  await context.nameConversation(written, ID);
  assert.equal(asked.length, 3);
  assert.equal(state.named.has(ID), true);
  // Beyond its first three messages, a conversation keeps the name it has.
  const long = Array.from({ length: 4 }, (_, at) => ({ role: 'user', content: 'message ' + at }));
  await context.nameConversation(long, 'f6666666-6666-4666-8666-666666666666');
  assert.equal(asked.length, 3);
});

test('a series of images in the Chat is kept after each image, with one result for its call, and never handed whole to the model', async t => {
  const store = await historyStore(t),
    prompts = ['A red fox in fresh snow.', 'A blue whale at dusk.', 'A barn owl at night.'],
    call = functionCall('create_image', 'call_1', JSON.stringify({ prompt: prompts[0], series: prompts.slice(1) })),
    proposal = index => ({ call, workflowName: 'Krea', requestId: 'r' + index, autoAllow: true, series: { id: 's1', index, total: 3 } }),
    runOf = index => `${String(index).repeat(8)}-1111-4111-8111-111111111111`;
  // The third image waits for the test: the application is « closed » while it is being made.
  let reached, let3;
  const atThird = new Promise(resolve => (reached = resolve)),
    gate = new Promise(resolve => (let3 = resolve)),
    given = [],
    asked = [];
  const requestTool = async (request, signal, onProgress, onImage, options) => {
    given.push(options);
    const index = request.series?.index ?? 1;
    if (request.series && index === 3) {
      reached();
      await gate;
    }
    return {
      content: JSON.stringify({
        status: 'success',
        run_id: runOf(index),
        takes: [index],
        workflow: 'Krea',
        prompt: prompts[index - 1],
        media_type: 'image',
        parameters: { seed: index },
        note: 'Image générée et affichée à l’utilisateur.',
      }),
      images: ['data:image/png;base64,AAA' + index],
      record: { id: runOf(index), conversationId: ID, mediaType: 'image' },
    };
  };
  // The user chose that the model looks at each image made.
  const looking = { generation: { maxIterations: 5, reviewImages: true } };
  const first = page({
    store,
    state: looking,
    requestTool,
    chat: (body, n) => (n === 1 ? called(proposal(1)) : said('')),
    routes: {
      'tools/series': body => {
        asked.push(plain(body));
        return Response.json(body.end ? { ended: true } : proposal(asked.filter(item => !item.end).length + 1));
      },
    },
  });
  const turn = first.send('Fais trois images à l’aquarelle');
  await atThird;
  // Two images are made, the third is running. What the disk holds: the call and, for it, one
  // result that says what is made so far (the next image takes its place).
  const kept = first.saves.at(-1),
    partial = JSON.parse(kept.messages[2].content);
  assert.deepEqual(roles(kept.messages), ['user', 'assistant', 'tool']);
  assert.deepEqual([partial.status, partial.made, partial.asked], ['partial', 2, 3]);
  assert.deepEqual(partial.images.map(image => image.run_id), [runOf(1), runOf(2)]);
  assert.match(partial.message, /^Série interrompue avant sa fin : 2 images sur 3/);
  assert.equal(kept.incomplete, true);
  for (const saved of first.saves) {
    assert.ok(saved.messages.filter(message => message.role === 'tool').length <= 1, 'one result for the call, at most');
    assert.doesNotThrow(() => accepted(nextMessage(saved.messages)));
  }
  // Its call is kept before its first image is made (0.6.82: the page reloaded meanwhile finds it), as
  // a call left without a result reads (closedCalls); then after the first image, then after the second.
  assert.deepEqual(
    first.saves
      .filter(saved => saved.messages[2])
      .map(saved => {
        const result = JSON.parse(saved.messages[2].content);
        return result.unanswered ? 'appel' : result.made;
      }),
    ['appel', 1, 2],
    'kept before the first image, then after it, then after the second',
  );
  // The application closed there, and opened again: the images made so far are shown, the
  // conversation is taken as it is.
  const reopened = page({ store, chat: body => (accepted(body.messages), said('Il manque la troisième.')) });
  await reopened.context.loadConversation(ID);
  assert.deepEqual(reopened.restored.map(item => item.runId), [runOf(1), runOf(2)]);
  // Under them, in one quiet line, where it stopped (0.6.82); no failure, no take « interrompue ».
  assert.match(reopened.$('messages').words, /Série interrompue avant sa fin : 2 images sur 3 ont été faites\./);
  assert.doesNotMatch(reopened.$('messages').words, /non aboutie|génération interrompue/);
  await reopened.send('Où en est la série ?');
  assert.deepEqual(reopened.notices.filter(Boolean), []);

  // In the first page the series goes to its end: the result of the whole takes the place of what
  // was kept, in the page, on the disk and in what the model is told.
  let3();
  await turn;
  assert.deepEqual(asked, [{ series: 's1' }, { series: 's1' }]);
  for (const messages of [first.state.messages, first.saves.at(-1).messages, first.requests.at(-1).messages.slice(1)]) {
    const results = messages.filter(message => message.role === 'tool');
    assert.equal(results.length, 1);
    const told = JSON.parse(results[0].content);
    assert.deepEqual([told.status, told.made, told.takes], ['success', 3, [1, 2, 3]]);
    assert.equal(results[0].content.includes(prompts[1]), false, 'the prompts stay in the call');
  }
  assert.equal(first.saves.at(-1).incomplete, false);
  assert.equal(first.takes.length, 3, 'a card for each image');
  // Never handed to the model by themselves, though the user chose it for an image: three copies in
  // one message here, up to twenty. Each image is run without that look, and nothing is joined.
  assert.deepEqual(given.map(options => options.reviewImages), [false, false, false]);
  assert.equal(first.requests.length, 2);
  assert.equal(JSON.stringify(first.requests[1].messages).includes('image_url'), false);
  assert.equal(JSON.stringify(first.requests[1].messages).includes('copies réduites'), false);

  // A single image keeps the look the user chose: its copy goes to the model with its result.
  const seen = [];
  const single = page({
    state: looking,
    requestTool: async (request, signal, onProgress, onImage, options) => (seen.push(options), requestTool(request, signal, onProgress, onImage, options)),
    chat: (body, n) => (n === 1 ? called({ call: functionCall('create_image'), workflowName: 'Krea', requestId: 'r9' }) : said('Un renard roux.')),
  });
  await single.send('Une image de renard');
  assert.equal(seen[0].reviewImages, true);
  assert.equal(JSON.stringify(single.requests[1].messages).includes('data:image/png;base64,AAA1'), true);
});

test('a series stopped by the user keeps one result for its call: what was made, in place of what was kept', async t => {
  const store = await historyStore(t),
    call = functionCall('create_image', 'call_1', '{"prompt":"A fox.","series":["A whale.","An owl."]}'),
    proposal = index => ({ call, workflowName: 'Krea', requestId: 'r' + index, autoAllow: true, series: { id: 's1', index, total: 3 } }),
    asked = [];
  let stop;
  const stopped = page({
    store,
    chat: () => called(proposal(1)),
    // The second image is being made when the user presses « Interrompre ».
    requestTool: async (request, signal) => {
      if (request.series.index === 2) {
        stop();
        signal.throwIfAborted();
      }
      return made(IMAGE, 'image');
    },
    routes: {
      'tools/series': body => {
        asked.push(plain(body));
        return Response.json(body.end ? { ended: true } : proposal(2));
      },
    },
  });
  stop = () => stopped.state.controller.abort();
  await stopped.send('Fais trois images');
  // The server is told the series is over (it lets its prompts go, the chat model comes back).
  assert.deepEqual(asked, [{ series: 's1' }, { series: 's1', end: true }]);
  for (const messages of [stopped.state.messages, stopped.saves.at(-1).messages]) {
    const results = messages.filter(message => message.role === 'tool');
    assert.equal(results.length, 1);
    const told = JSON.parse(results[0].content);
    assert.deepEqual([told.status, told.made, told.asked], ['partial', 1, 3]);
    assert.match(told.message, /^Série arrêtée par l’utilisateur : 1 image sur 3 a été faite\.$/);
    assert.doesNotThrow(() => accepted(nextMessage(messages)));
  }

  // A series whose first image fails goes no further: the server is told as well (it would keep
  // its prompts for hours), before the model is written to.
  asked.length = 0;
  const order = [];
  const failing = page({
    chat: (body, n) => (order.push('chat ' + n), n === 1 ? called(proposal(1)) : said('La première image a échoué.')),
    requestTool: async () => ({
      content: JSON.stringify({ status: 'error', message: 'Mémoire vidéo insuffisante.' }),
      images: [],
      failed: true,
      error: 'Mémoire vidéo insuffisante.',
    }),
    routes: {
      'tools/series': body => {
        asked.push(plain(body));
        order.push('series over');
        return Response.json({ ended: true });
      },
    },
  });
  await failing.send('Fais trois images');
  assert.deepEqual(asked, [{ series: 's1', end: true }]);
  assert.deepEqual(order, ['chat 1', 'series over', 'chat 2']);
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

test('a take in the making hands its card, and the Studio that follows it, how long since its go as the server counts it (0.6.93)', async () => {
  const time = { ms: 72000, running: true },
    followed = [],
    image = { call: functionCall('create_image'), workflowName: 'Krea', requestId: 'r3' },
    requestTool = async (request, signal, onProgress) => {
      onProgress('Génération · 5/8', 0.42, null, time);
      return made(IMAGE, 'image');
    },
    studio = { accepts: () => true, propose: async () => 'once', follow: (...given) => followed.push(given), invalidate() {}, settled() {} },
    turnOf = state => page({ state, requestTool, chat: (body, n) => (n === 1 ? called(image) : said('')) });
  const chat = turnOf({ studio });
  await chat.send('Une image de renard');
  assert.deepEqual(chat.takes[0].progressed, [['Génération · 5/8', 0.42, null, time]]);
  assert.deepEqual(followed, [], 'made in the Chat: the Studio follows nothing');
  // Made by the agent of the Studio: its screen counts the same.
  const agent = turnOf({ view: 'studio', studio });
  await agent.send('Une image de renard');
  assert.deepEqual(agent.takes[0].progressed, [['Génération · 5/8', 0.42, null, time]]);
  assert.deepEqual(followed, [['Génération · 5/8', 0.42, null, time]]);
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

// ------------------------------------------------------------------ any page during a work (0.6.81)
const ELSEWHERE = 'f7777777-7777-4777-8777-777777777777';
/** Another conversation, saved: what the user opens while a take of the first is being made. */
const otherConversation = store =>
  store.save({
    id: ELSEWHERE,
    messages: [
      { role: 'user', content: 'Bonjour' },
      { role: 'assistant', content: 'Bonjour ! Que créons-nous ?' },
    ],
    incomplete: false,
    instructions: '',
    projectId: 'inbox',
  });
/** A generation the test ends: `started` (its options) once it runs, `finish(result)`. */
function heldGeneration() {
  let begin, end;
  const started = new Promise(resolve => (begin = resolve));
  return {
    started,
    finish: result => end(result),
    requestTool: (request, signal, onProgress, onImage, options) =>
      new Promise(resolve => {
        end = resolve;
        begin(options);
      }),
  };
}
const RUN = 'b2222222-2222-4222-8222-222222222222';
const madeImage = (conversationId = ID) => ({
  content: JSON.stringify({ status: 'success', run_id: RUN }),
  images: [],
  record: { id: RUN, conversationId, mediaType: 'image' },
});

test('another conversation opens while a turn makes its take: the one left is set aside, its take written in it, back as it was', async t => {
  // Until 0.6.80 the page held its navigation while Moodix worked: the turn wrote in « the
  // conversation on screen », its result would have gone to the one opened meanwhile.
  const store = await historyStore(t),
    generation = heldGeneration();
  await otherConversation(store);
  const making = page({
    store,
    chat: (body, n) => (n === 1 ? called({ call: functionCall('create_image'), workflowName: 'Krea 2', requestId: 'r1', approvalToken: 't1' }) : said('')),
    requestTool: generation.requestTool,
  });
  const turn = making.send('Une image d’un renard dans la neige');
  const options = await generation.started;
  assert.equal(options.conversationId, ID, 'its take is asked for its own conversation');
  assert.equal(making.state.work.conversationId, ID);

  // The user opens the other conversation meanwhile: it opens; the one of the turn is set aside.
  await making.context.loadConversation(ELSEWHERE);
  assert.equal(making.state.conversationId, ELSEWHERE);
  assert.equal(making.state.aside.conversationId, ID);
  assert.deepEqual(roles(making.state.messages), ['user', 'assistant']);
  assert.match(making.$('messages').words, /Que créons-nous/);
  assert.doesNotMatch(making.$('messages').words, /renard/);
  // Written there meanwhile: refused in words (one work at a time), kept in the box, nothing sent.
  const asked = making.requests.length;
  making.$('prompt').value = 'Et un lapin ?';
  await making.send();
  assert.match(making.notices.at(-1), /dans «\u00a0Une image d’un renard dans la neige\u00a0» : attendez/);
  assert.equal(making.$('prompt').value, 'Et un lapin ?');
  assert.equal(making.requests.length, asked);

  // The take is made: written in its own conversation, the one shown left alone.
  generation.finish(madeImage());
  await turn;
  assert.equal(making.state.work, null);
  const kept = await store.read(ID);
  assert.deepEqual(roles(kept.messages), ['user', 'assistant', 'tool']);
  assert.equal(JSON.parse(kept.messages[2].content).status, 'success');
  assert.equal(kept.incomplete, false);
  // The model was asked again (after the take) for that conversation, in its project.
  assert.deepEqual([making.requests.at(-1).conversationId, making.requests.at(-1).project], [ID, 'inbox']);
  assert.equal((await store.read(ELSEWHERE)).messages.length, 2);
  assert.deepEqual(roles(making.state.messages), ['user', 'assistant']);
  assert.equal(making.$('prompt').value, 'Et un lapin ?');
  assert.equal(making.state.aside.title, 'Une image d’un renard dans la neige', 'named by its first message, set aside');

  // Back to it: as it was left, from the page (not read again from the disk), its take there.
  let reads = 0;
  const read = store.read.bind(store);
  store.read = id => (reads++, read(id));
  await making.context.loadConversation(ID);
  assert.equal(reads, 0);
  assert.equal(making.state.conversationId, ID);
  assert.equal(making.state.aside, null);
  assert.deepEqual(roles(making.state.messages), ['user', 'assistant', 'tool']);
  assert.match(making.$('messages').words, /renard/);
  assert.doesNotMatch(making.$('messages').words, /Que créons-nous/);
  assert.equal(making.$('conversation-title').textContent, 'Une image d’un renard dans la neige');
});

test('a new conversation begun while a turn makes its take: the turn goes on in its own; a send that failed comes back there', async t => {
  const store = await historyStore(t),
    generation = heldGeneration();
  const making = page({
    store,
    chat: (body, n) => (n === 1 ? called({ call: functionCall('create_image'), workflowName: 'Krea 2', requestId: 'r1', approvalToken: 't1' }) : said('')),
    requestTool: generation.requestTool,
  });
  const turn = making.send('Une image d’un renard dans la neige');
  await generation.started;
  // The logo (goHome): a new conversation, here, while the take is made.
  await making.context.newConversation('inbox');
  assert.equal(making.state.conversationId, null);
  assert.equal(making.state.messages.length, 0);
  assert.equal(making.state.aside.conversationId, ID);
  generation.finish(madeImage());
  await turn;
  assert.deepEqual(roles((await store.read(ID)).messages), ['user', 'assistant', 'tool']);
  assert.equal(making.state.messages.length, 0, 'the new conversation stays empty');
  assert.equal(making.$('welcome').hidden, false);

  // A message that fails before any answer while its conversation is set aside: it goes back to the
  // box of that conversation, not to the one shown.
  let release;
  const gate = new Promise(resolve => (release = resolve));
  const failing = page({
    store,
    chat: async () => {
      await gate;
      throw Error('Le serveur ne répond pas.');
    },
  });
  const sent = failing.send('Un lapin');
  while (!failing.requests.length) await new Promise(resolve => setTimeout(resolve, 1));
  await failing.context.newConversation('inbox');
  release();
  await sent;
  assert.equal(failing.$('prompt').value, '', 'not in the box of the conversation shown');
  assert.equal(failing.state.aside.draft.text, 'Un lapin');
  assert.match(failing.notices.at(-1), /Le serveur ne répond pas/);
});

test('a creation of the Studio made while another conversation is open is written in its own (0.6.81)', async t => {
  const store = await historyStore(t),
    generation = heldGeneration();
  await otherConversation(store);
  const studio = page({ store, requestTool: generation.requestTool, state: { conversationId: ID, view: 'studio' } });
  const proposal = { call: functionCall('create_image', 'action1'), workflowName: 'Krea 2', requestId: 'r1', plan: { prompt: 'un renard' } };
  // « Générer » of the Studio: its work begins in the conversation shown (the Studio says so, onWork).
  studio.context.beginWork('studio', ID);
  const made = studio.context.runInStudio(proposal, { signal: new AbortController().signal, onProgress() {}, conversationId: ID });
  const options = await generation.started;
  assert.equal(options.conversationId, ID);
  await studio.context.loadConversation(ELSEWHERE);
  assert.equal(studio.state.aside.conversationId, ID);
  generation.finish(madeImage());
  const result = await made;
  assert.equal(result.record.id, RUN);
  const kept = await store.read(ID);
  assert.deepEqual(roles(kept.messages), ['user', 'assistant', 'tool']);
  assert.match(kept.messages[0].content, /^Studio · Image : un renard/);
  assert.equal(JSON.parse(kept.messages[2].content).run_id, RUN);
  assert.equal((await store.read(ELSEWHERE)).messages.length, 2, 'not in the conversation shown');
  assert.deepEqual(roles(studio.state.messages), ['user', 'assistant']);
  assert.deepEqual(roles(studio.state.aside.messages), ['user', 'assistant', 'tool']);
});

test('a call of the Chat is kept before its take is made: the page reloaded meanwhile finds it (0.6.82)', async t => {
  const store = await historyStore(t),
    generation = heldGeneration(),
    proposal = { call: functionCall('create_image', 'call_boat'), workflowName: 'Krea 2', requestId: 'r1', autoAllow: true };
  const making = page({ store, requestTool: generation.requestTool, chat: (body, n) => (n === 1 ? called(proposal) : said('')) });
  const turn = making.send('Un bateau rouge');
  await generation.started;
  // While its take is made, the disk holds the message and its call (read as one left without a
  // result): reloaded now, the conversation opens on it, not on the message given back to the box.
  const kept = await store.read(ID);
  assert.deepEqual(roles(kept.messages), ['user', 'assistant', 'tool']);
  assert.equal(kept.messages[1].tool_calls[0].id, 'call_boat');
  assert.equal(JSON.parse(kept.messages[2].content).unanswered, true);
  generation.finish(madeImage());
  await turn;
  const done = await store.read(ID);
  assert.equal(JSON.parse(done.messages[2].content).run_id, RUN, 'its result in place of the one it was kept with');
  assert.equal(done.messages.filter(message => message.role === 'tool').length, 1);
});

test('a creation of the Studio is kept as it starts, and taken back when it makes nothing (0.6.82)', async t => {
  const store = await historyStore(t);
  await otherConversation(store);
  // In a conversation that had something before: its line and its call while it is made, then nothing.
  const generation = heldGeneration(),
    studio = page({
      store,
      requestTool: generation.requestTool,
      state: { conversationId: ELSEWHERE, messages: (await store.read(ELSEWHERE)).messages, view: 'studio' },
    });
  const proposal = { call: functionCall('create_image', 'action1'), workflowName: 'Krea 2', requestId: 'r1', plan: { prompt: 'un renard' } };
  const made = studio.context.runInStudio(proposal, { signal: new AbortController().signal, onProgress() {}, conversationId: ELSEWHERE });
  await generation.started;
  const during = await store.read(ELSEWHERE);
  assert.deepEqual(roles(during.messages), ['user', 'assistant', 'user', 'assistant', 'tool']);
  assert.match(during.messages[2].content, /^Studio · Image : un renard/);
  generation.finish({ content: JSON.stringify({ status: 'error', message: 'Mémoire vidéo insuffisante.' }), images: [], failed: true, error: 'Mémoire vidéo insuffisante.' });
  await made;
  assert.deepEqual(roles((await store.read(ELSEWHERE)).messages), ['user', 'assistant'], 'nothing made, nothing to tell');
  // Begun for it, in a conversation never saved: it exists while it is made, then leaves the history.
  const first = heldGeneration(),
    deleted = [],
    fresh = page({
      store,
      requestTool: first.requestTool,
      state: { conversationId: ID, view: 'studio' },
      routes: {
        'history/delete': async body => {
          deleted.push(plain(body));
          await store.remove(body.id);
          return Response.json({ removed: body.id });
        },
        // No take in its folder: it may go (0.6.87).
        [`gallery/${ID}?images=0`]: async () => Response.json({ runs: [] }),
      },
    });
  const begun = fresh.context.runInStudio(proposal, { signal: new AbortController().signal, onProgress() {}, conversationId: ID });
  await first.started;
  assert.deepEqual(roles((await store.read(ID)).messages), ['user', 'assistant', 'tool']);
  assert.ok(fresh.state.historyItems.some(item => item.id === ID), 'listed, in its project');
  first.finish({ content: '{}', images: [], failed: true, error: 'Génération annulée.' });
  await begun;
  assert.deepEqual(deleted, [{ confirm: true, id: ID }]);
  assert.equal(fresh.state.historyItems.some(item => item.id === ID), false);
  await assert.rejects(store.read(ID));
});

test('a creation of the Studio that makes nothing never deletes a conversation that existed, nor one with takes (0.6.87)', async t => {
  // « Modifier » on its first message leaves no message in the page, and one in the history: taken
  // back, the conversation was deleted with its folder, the records of its takes in it.
  const store = await historyStore(t),
    deleted = [],
    first = { role: 'user', content: 'Un renard dans la neige' },
    failing = async () => ({ content: JSON.stringify({ status: 'error', message: 'rien' }), images: [], failed: true, error: 'rien' }),
    proposal = { call: functionCall('create_image', 'action1'), workflowName: 'Krea 2', requestId: 'r1', plan: { prompt: 'un renard' } },
    routes = runs => ({
      'history/delete': async body => (deleted.push(plain(body)), Response.json({ removed: body.id })),
      [`gallery/${ID}?images=0`]: async () => Response.json({ runs }),
    });
  await store.save({ id: ID, messages: [first], incomplete: true, instructions: '', projectId: 'inbox' });
  const emptied = page({
    store,
    requestTool: failing,
    routes: routes([]),
    state: {
      conversationId: ID,
      view: 'studio',
      messages: [],
      archiveSnapshot: { messages: [first], incomplete: true },
      historyItems: [{ id: ID, title: 'Un renard dans la neige', projectId: 'inbox' }],
    },
  });
  await emptied.context.runInStudio(proposal, { signal: new AbortController().signal, onProgress() {}, conversationId: ID });
  assert.deepEqual(deleted, []);
  const kept = await store.read(ID);
  assert.deepEqual([roles(kept.messages), kept.messages[0].content, kept.incomplete], [['user'], 'Un renard dans la neige', true], 'as it was');
  // Begun for this creation, but with takes in its folder: never deleted with them.
  await store.remove(ID);
  const begun = page({ store, requestTool: failing, routes: routes([{ id: RUN, conversationId: ID }]), state: { conversationId: ID, view: 'studio' } });
  await begun.context.runInStudio(proposal, { signal: new AbortController().signal, onProgress() {}, conversationId: ID });
  assert.deepEqual(deleted, []);
  assert.ok(await store.read(ID), 'kept in the history');
});

test('a proposal that waits for the user, asked from the Studio, waits in the Studio of its own conversation: another opened meanwhile is not touched (0.6.87)', async () => {
  // Set in the Studio of the one shown meanwhile: its drafts taken, the take of the other put on its screen.
  const studio = studioOf();
  let reach, go;
  const reached = new Promise(resolve => (reach = resolve)),
    gate = new Promise(resolve => (go = resolve));
  const agent = page({
    state: { view: 'studio', studio },
    chat: (body, n) => (n === 1 ? called({ call: functionCall('create_image', 'call_img'), workflowName: 'Krea 2', requestId: 'r1' }) : said('')),
    requestTool: async (request, signal, onProgress, onImage, options) => {
      reach();
      await gate;
      return asApproved(request, signal, onProgress, onImage, options);
    },
  });
  const turn = agent.send('Une image de renard');
  await reached;
  agent.state.conversationId = ELSEWHERE;
  go();
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(studio.proposed.length, 0, 'nothing set in the Studio of the conversation shown');
  assert.equal(agent.state.work?.waits, true, 'the miniature says Moodix AI waits there');
  agent.state.conversationId = ID;
  for (let tries = 0; tries < 40 && !studio.proposed.length; tries++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(studio.proposed.length, 1, 'set once its conversation is shown again');
  studio.generate();
  await turn;
});

test('what goes by itself, asked from the Studio, is made at once while the user is elsewhere: no wait, no other Studio touched (0.6.88)', async () => {
  // Made to wait for the user to come back (0.6.87), a series stopped as long as they were elsewhere
  // and its proposal expired after 15 minutes; set in the Studio, it took the page back there.
  const studio = studioOf(),
    settled = [];
  let invalidated = 0;
  studio.settled = async outcome => settled.push(outcome);
  studio.invalidate = () => invalidated++;
  let reach, go;
  const reached = new Promise(resolve => (reach = resolve)),
    gate = new Promise(resolve => (go = resolve));
  const agent = page({
    state: { view: 'studio', studio },
    chat: (body, n) =>
      n === 1 ? called({ call: functionCall('create_image', 'call_img'), workflowName: 'Krea 2', requestId: 'r1', autoAllow: true }) : said(''),
    requestTool: async (request, signal, onProgress, onImage, options) => {
      reach();
      await gate;
      return asApproved(request, signal, onProgress, onImage, options);
    },
  });
  const turn = agent.send('Une image de renard');
  await reached;
  agent.state.conversationId = ELSEWHERE;
  go();
  const over = await Promise.race([turn.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 3000))]);
  assert.equal(over, true, 'made without waiting for the user to come back');
  assert.equal(studio.proposed.length, 0, 'set in no Studio');
  assert.notEqual(agent.state.work?.waits, true, 'nothing waits for the user');
  assert.equal(settled.length, 0, 'its take not put on the screen of the Studio shown');
  assert.ok(invalidated > 0, 'its Studio reads its takes again when it is shown');
  // Made in its Studio, on screen: set there, as always.
  const here = studioOf(),
    at = page({
      state: { view: 'studio', studio: here },
      chat: (body, n) =>
        n === 1 ? called({ call: functionCall('create_image', 'call_img'), workflowName: 'Krea 2', requestId: 'r1', autoAllow: true }) : said(''),
      requestTool: asApproved,
    });
  await at.send('Une image de renard');
  assert.equal(here.proposed.length, 1);
});

test('made at once away from its Studio, a creation has the LoRAs of the user that Studio has for its conversation (0.6.88)', async () => {
  // Added by « Générer » in the Studio only (its edits): the images made meanwhile had none, and the
  // Studio, set from the last of them, emptied its list.
  const studio = studioOf(),
    revised = [],
    ran = [],
    grain = [{ name: 'grain.safetensors', strength: 0.8 }];
  studio.stylesFor = (id, target) => (id === ID && target === 'image' ? grain : null);
  let reach, go;
  const reached = new Promise(resolve => (reach = resolve)),
    gate = new Promise(resolve => (go = resolve));
  const agent = page({
    state: { view: 'studio', studio },
    routes: {
      'tools/revise': async body => (revised.push(plain(body)), Response.json({ requestId: 'r2', approvalToken: 't2', styles: body.edits.styles })),
    },
    chat: (body, n) =>
      n === 1
        ? called({ call: functionCall('create_image', 'call_img'), workflowName: 'Krea 2', requestId: 'r1', approvalToken: 't1', autoAllow: true, styles: [] })
        : said(''),
    requestTool: async (request, signal, onProgress, onImage, options) => {
      reach();
      await gate;
      const decision = await options.approve(request, signal);
      ran.push(plain([decision, request.requestId, request.styles]));
      return made();
    },
  });
  const turn = agent.send('Une image de renard');
  await reached;
  agent.state.conversationId = ELSEWHERE;
  go();
  await turn;
  assert.deepEqual(revised, [{ requestId: 'r1', approvalToken: 't1', edits: { styles: grain } }]);
  assert.deepEqual(ran, [['once', 'r2', grain]]);
  // The same LoRAs already: nothing to change.
  studio.stylesFor = () => [];
  const plainAgent = page({
    state: { view: 'studio', studio },
    routes: { 'tools/revise': async body => (revised.push(plain(body)), Response.json({})) },
    chat: (body, n) =>
      n === 1 ? called({ call: functionCall('create_image', 'call_img'), workflowName: 'Krea 2', requestId: 'r1', autoAllow: true, styles: [] }) : said(''),
    requestTool: async (request, signal, onProgress, onImage, options) => {
      plainAgent.state.conversationId = ELSEWHERE;
      return asApproved(request, signal, onProgress, onImage, options);
    },
  });
  await plainAgent.send('Une image de renard');
  assert.equal(revised.length, 1);
});

test('a request that lacks a file is taken up again in its own conversation, though another was shown when it came (0.6.87)', async () => {
  let card = null;
  const agent = page({
    chat: (body, n) => {
      if (n > 1) return said('');
      // Another conversation opened while Moodix answered.
      agent.state.conversationId = ELSEWHERE;
      return called({
        call: functionCall('create_image', 'call_m'),
        tool: 'create_image',
        workflowName: 'Krea 2',
        requestId: 'r1',
        missing: { workflowId: 'krea', files: [{ file: 'krea.safetensors', size: 1 }], bytes: 1, left: 1 },
      });
    },
  });
  agent.context.missingFileCard = options => ((card = options), {});
  let sent = 0;
  agent.$('chat-form').requestSubmit = () => sent++;
  await agent.send('Une image de renard');
  assert.ok(card, 'its card');
  // Back in its conversation: « Reprendre la demande » sends it again (before: « Ouvrez la conversation
  // de cette demande », the one shown when the answer came being kept).
  agent.state.conversationId = ID;
  card.onResume();
  assert.equal(agent.notices.includes('Ouvrez la conversation de cette demande.'), false);
  assert.equal(sent, 1);
  agent.state.conversationId = ELSEWHERE;
  card.onResume();
  assert.equal(agent.notices.at(-1), 'Ouvrez la conversation de cette demande.');
});

test('what was being written in a conversation comes back when it is opened again (0.6.87)', async t => {
  // Kept only for the one set aside during its work before: written in the one shown meanwhile, it was
  // lost when the miniature brought the user back.
  const store = await historyStore(t);
  await otherConversation(store);
  const p = page({ store, state: { conversationId: ID, messages: [{ role: 'user', content: 'Bonjour' }], historyItems: [{ id: ID }, { id: ELSEWHERE }] } });
  p.$('prompt').value = 'Et maintenant un chat';
  await p.context.loadConversation(ELSEWHERE);
  assert.equal(p.$('prompt').value, '', 'the other has its own box');
  await store.save({ id: ID, messages: [{ role: 'user', content: 'Bonjour' }, { role: 'assistant', content: 'Bonjour !' }], incomplete: false, instructions: '', projectId: 'inbox' });
  await p.context.loadConversation(ID);
  assert.equal(p.$('prompt').value, 'Et maintenant un chat');
  // Taken once: opened again, the box is as it is left then.
  p.$('prompt').value = '';
  await p.context.loadConversation(ELSEWHERE);
  await p.context.loadConversation(ID);
  assert.equal(p.$('prompt').value, '');
});

test('without the history, the conversation set aside does not leave the page without a question (0.6.87)', async () => {
  // Another set aside in its place, or the miniature closed: it can be opened from nowhere else.
  const asked = [],
    aside = { conversationId: ELSEWHERE, projectId: 'inbox', messages: [{ role: 'user', content: 'Bonjour' }], title: 'Le phare', draft: { text: '', images: [], videos: [] }, nodes: null };
  const p = page({
    state: {
      saveHistory: false,
      conversationId: ID,
      messages: [{ role: 'user', content: 'Un renard' }],
      aside,
      work: { kind: 'turn', conversationId: ID },
    },
  });
  p.context.confirm = question => (asked.push(question), false);
  await p.context.newConversation();
  assert.match(asked[0], /« Le phare » n’est pas enregistrée \(historique désactivé\) : elle sera effacée de la page\. Continuer \?/);
  assert.deepEqual([p.state.conversationId, p.state.aside], [ID, aside], 'nothing left');
  assert.equal(p.context.asideMayGo(), false);
  p.state.saveHistory = true;
  assert.equal(p.context.asideMayGo(), true, 'with the history it is found again in the fil');
  assert.equal(asked.length, 2);
});

test('a creation of the Studio stopped once its take was saved keeps it, in the conversation begun for it (0.6.86)', async t => {
  // Taken back with its line before 0.6.86: the conversation begun for it left the history, and the
  // take the Pellicule with it (its record is kept in the folder of its conversation).
  const store = await historyStore(t),
    deleted = [];
  let started;
  const running = new Promise(resolve => (started = resolve));
  const take = {
    id: RUN,
    conversationId: ID,
    callId: 'action1',
    createdAt: '2026-11-18T10:00:00.000Z',
    mediaType: 'image',
    workflowName: 'Krea 2',
    workflowId: 'krea',
    prompt: 'un renard',
    parameters: { seed: 7 },
    outputs: [{ source: { filename: 'renard.png' }, take: 7 }],
  };
  const studio = page({
    store,
    state: { conversationId: ID, view: 'studio' },
    requestTool: (request, signal) =>
      new Promise((resolve, reject) => {
        started();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    routes: {
      [`gallery/${ID}?images=0`]: async () => Response.json({ runs: [take, { ...take, id: 'autre', callId: 'action0' }] }),
      'history/delete': async body => (deleted.push(plain(body)), Response.json({ removed: body.id })),
    },
  });
  const stop = new AbortController(),
    proposal = { call: functionCall('create_image', 'action1'), workflowName: 'Krea 2', requestId: 'r1', plan: { prompt: 'un renard' } };
  const made = studio.context.runInStudio(proposal, { signal: stop.signal, onProgress() {}, conversationId: ID });
  await running;
  stop.abort();
  const result = await made;
  assert.equal(result.record.id, RUN, 'the Studio shows the take made');
  assert.deepEqual(deleted, [], 'the conversation stays, its take with it');
  const saved = await store.read(ID);
  assert.deepEqual(roles(saved.messages), ['user', 'assistant', 'tool']);
  assert.deepEqual([JSON.parse(saved.messages[2].content).run_id, JSON.parse(saved.messages[2].content).takes], [RUN, [7]]);
  assert.ok(studio.drawn.includes('rerender'), 'drawn from the conversation, its card having gone');
});

test('another conversation opened while a generation runs is opened without a question: the server keeps saves for its end (0.6.82)', async t => {
  // Until 0.6.81 the page saved the conversation it left: refused during a generation
  // (/api/history/save), each page opened then asked « n’a pas pu être enregistrée ».
  const store = await historyStore(t),
    generation = heldGeneration(),
    proposal = { call: functionCall('create_image', 'call_boat'), workflowName: 'Krea 2', requestId: 'r1', autoAllow: true };
  await otherConversation(store);
  const asked = [];
  const making = page({ store, requestTool: generation.requestTool, chat: (body, n) => (n === 1 ? called(proposal) : said('')) });
  making.context.confirm = question => (asked.push(question), true);
  const turn = making.send('Un bateau rouge');
  await generation.started;
  making.state.status = { ...making.state.status, toolJob: { id: 'job', state: 'generating', conversationId: ID, callId: 'call_boat' } };
  const saves = making.saves.length;
  await making.context.loadConversation(ELSEWHERE);
  assert.equal(making.state.conversationId, ELSEWHERE);
  assert.equal(making.state.aside.conversationId, ID, 'the one of the generation set aside, alive');
  assert.equal(making.saves.length, saves, 'nothing saved while the generation runs');
  assert.deepEqual(asked, []);
  making.state.status = { ...making.state.status, toolJob: null };
  generation.finish(madeImage());
  await turn;
  assert.equal(JSON.parse((await store.read(ID)).messages[2].content).run_id, RUN, 'its take written in its own at its end');
});

test('a creation stopped by the user is kept once the server has handed the card back: no « Historique non enregistré » (0.6.84)', async t => {
  // Saved at once, it was refused (/api/history/save waits for the end of a generation): the stop was
  // never kept, and the page said « Historique non enregistré : Attendez la fin de la génération. ».
  const store = await historyStore(t),
    proposal = { call: functionCall('create_image', 'call_boat'), workflowName: 'Krea 2', requestId: 'r1', autoAllow: true };
  let started;
  const running = new Promise(resolve => (started = resolve));
  const making = page({
    store,
    chat: (body, n) => (n === 1 ? called(proposal) : said('')),
    requestTool: (request, signal) =>
      new Promise((resolve, reject) => {
        started();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  });
  const turn = making.send('Un bateau rouge');
  await running;
  making.state.status = { ...making.state.status, toolJob: { id: 'job', state: 'generating', conversationId: ID, callId: 'call_boat' } };
  const saves = making.saves.length;
  making.$('cancel').onclick();
  await new Promise(resolve => setTimeout(resolve, 100));
  // The server still hands the card back: nothing saved yet, the turn not over.
  assert.equal(making.saves.length, saves);
  assert.equal(making.state.generating, true);
  making.state.status = { ...making.state.status, toolJob: null };
  await turn;
  const kept = await store.read(ID),
    result = JSON.parse(kept.messages[2].content);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.unanswered, undefined, 'stopped, not a call left without its result');
  assert.deepEqual(making.notices.filter(Boolean), []);
  assert.equal(making.state.generating, false);
});

test('a message left unsent comes back once in the box, however often its conversation is opened again (0.6.88)', async t => {
  // Kept as the box held it when the conversation was left (0.6.87), it came back after that message,
  // which was in it already: once more at each visit, its images too.
  const store = await historyStore(t);
  await otherConversation(store);
  await store.save({
    id: ID,
    messages: [{ role: 'user', content: 'Bonjour' }, { role: 'assistant', content: 'Bonjour !' }, { role: 'user', content: 'Un phare la nuit' }],
    incomplete: true,
    instructions: '',
    projectId: 'inbox',
  });
  const p = page({ store, state: { conversationId: ELSEWHERE, historyItems: [{ id: ID }, { id: ELSEWHERE }] } });
  await p.context.loadConversation(ID);
  assert.equal(p.$('prompt').value, 'Un phare la nuit');
  await p.context.loadConversation(ELSEWHERE);
  await p.context.loadConversation(ID);
  assert.equal(p.$('prompt').value, 'Un phare la nuit', 'once');
  p.$('prompt').value = 'Un phare la nuit, sous la pluie';
  await p.context.loadConversation(ELSEWHERE);
  await p.context.loadConversation(ID);
  assert.equal(p.$('prompt').value, 'Un phare la nuit, sous la pluie', 'as it was changed');
});

test('what was written in a conversation not begun yet comes back with the next one begun in its project (0.6.88)', async t => {
  // Kept only for a conversation with an identifier (0.6.87): written in a new conversation while
  // another worked, it was lost when the miniature brought the user back.
  const store = await historyStore(t);
  await otherConversation(store);
  const p = page({ store, state: { conversationId: null, projectId: 'inbox', historyItems: [{ id: ELSEWHERE }] } });
  p.$('prompt').value = 'Un chat sur un toit';
  await p.context.loadConversation(ELSEWHERE);
  assert.equal(p.$('prompt').value, '');
  // Another not begun of that project, left empty (its conversation deleted, say), takes nothing away.
  Object.assign(p.state, { conversationId: null, messages: [] });
  p.$('prompt').value = '';
  await p.context.loadConversation(ELSEWHERE);
  await p.context.newConversation();
  assert.equal(p.$('prompt').value, 'Un chat sur un toit');
  // Begun again from there, it is emptied, as it always was.
  await p.context.newConversation();
  assert.equal(p.$('prompt').value, '');
});

test('a conversation that cannot be opened leaves what is written in the one shown in its box, not kept to come back once sent (0.6.88)', async t => {
  const store = await historyStore(t);
  const p = page({ store, state: { conversationId: ID, messages: [{ role: 'user', content: 'Bonjour' }], historyItems: [{ id: ID }] } });
  p.$('prompt').value = 'Un renard';
  await p.context.loadConversation('c3333333-3333-4333-8333-333333333333');
  assert.deepEqual([p.state.conversationId, p.$('prompt').value], [ID, 'Un renard'], 'still there');
  assert.equal(p.state.draftsLeft?.has(ID) ?? false, false, 'nothing kept to come back');
});

test('the conversation set aside, replaced by another, keeps what was being written in it (0.6.88)', () => {
  const p = page({
    state: {
      conversationId: ID,
      projectId: 'inbox',
      messages: [{ role: 'user', content: 'Un renard' }],
      work: { kind: 'turn', conversationId: ID },
      aside: {
        conversationId: ELSEWHERE,
        projectId: 'inbox',
        messages: [{ role: 'user', content: 'Un phare' }],
        title: 'Le phare',
        draft: { text: 'Et la nuit ?', images: [], videos: [] },
        nodes: null,
      },
    },
  });
  assert.equal(p.context.setAside(), true);
  assert.equal(p.state.aside.conversationId, ID);
  assert.deepEqual(plain(p.context.draftLeft(ELSEWHERE)), { text: 'Et la nuit ?', images: [], videos: [] });
});

test('the message put back in the box stays on the disk through a creation of the Studio, while it runs and once it is made (0.6.88)', async t => {
  // Taken out of the history as the creation started, it was only in the box: lost with a page
  // reloaded meanwhile, or once the creation was made.
  const store = await historyStore(t),
    hello = { role: 'user', content: 'Bonjour' },
    reply = { role: 'assistant', content: 'Bonjour !' },
    pending = { role: 'user', content: 'Un renard dans la neige' },
    proposal = { call: functionCall('create_image', 'action1'), workflowName: 'Krea 2', requestId: 'r1', plan: { prompt: 'un renard' } };
  await store.save({ id: ID, messages: [hello, reply, pending], incomplete: true, instructions: '', projectId: 'inbox' });
  let during = null;
  const studio = page({
    store,
    requestTool: async () => {
      during = await store.read(ID);
      return madeImage();
    },
    state: {
      conversationId: ID,
      view: 'studio',
      messages: [hello, reply],
      archiveSnapshot: { messages: [hello, reply, pending], incomplete: true },
      historyItems: [{ id: ID, title: 'Bonjour', projectId: 'inbox' }],
    },
  });
  await studio.context.runInStudio(proposal, { signal: new AbortController().signal, onProgress() {}, conversationId: ID });
  assert.deepEqual([during.messages.at(-1).content, during.incomplete], ['Un renard dans la neige', true], 'kept as it runs');
  const after = await store.read(ID);
  assert.deepEqual([after.messages.at(-1).content, after.incomplete], ['Un renard dans la neige', true], 'kept once it is made');
  assert.ok(
    after.messages.some(message => message.role === 'tool' && message.tool_call_id === 'action1'),
    'the result of its call before it',
  );
});

test('a conversation one of whose takes cannot be read is never forgotten with it (0.6.89)', async () => {
  // The record of a take the gallery cannot read counted as no take: the conversation begun for a
  // creation of the Studio that made nothing went, with that record and its files.
  const deleted = [],
    forgotten = skipped =>
      page({
        state: { historyItems: [{ id: ID }] },
        routes: {
          'history/delete': async body => (deleted.push(plain(body)), Response.json({ removed: body.id })),
          [`gallery/${ID}?images=0`]: async () => Response.json({ runs: [], skipped }),
        },
      }).context.forgetConversation(ID);
  await forgotten(1);
  assert.deepEqual(deleted, []);
  // Nothing in its folder: it goes, as a conversation begun for a creation that made nothing.
  await forgotten(0);
  assert.deepEqual(deleted.map(body => body.id), [ID]);
});

test('without the history, a work begun beside the conversation set aside asks first: that one would be reached no more (0.6.90)', async () => {
  // The miniature that led back to it went to the new work, and nothing else led to it.
  const asked = [],
    aside = {
      conversationId: ELSEWHERE,
      projectId: 'inbox',
      messages: [{ role: 'user', content: 'Un phare' }],
      title: 'Le phare',
      draft: { text: '', images: [], videos: [] },
      nodes: null,
    };
  let chats = 0;
  const p = page({
    chat: () => (chats++, said('Bonjour !')),
    state: {
      saveHistory: false,
      conversationId: ID,
      messages: [{ role: 'user', content: 'Un renard' }, { role: 'assistant', content: 'Oui ?' }],
      aside,
    },
  });
  p.context.confirm = question => (asked.push(question), false);
  await p.send('Et en hiver ?');
  assert.match(asked[0], /« Le phare » n’est pas enregistrée \(historique désactivé\) : elle sera effacée de la page\. Continuer \?/);
  assert.deepEqual([chats, p.state.aside, p.$('prompt').value], [0, aside, 'Et en hiver ?'], 'nothing begun, the message kept');
  p.context.confirm = question => (asked.push(question), true);
  await p.send('Et en hiver ?');
  assert.equal(chats, 1, 'begun once the user said yes');
  assert.equal(p.state.aside, null, 'that one left the page');
  // « Régénérer » asks before its last exchange leaves the page.
  const exchange = [{ role: 'user', content: 'Un renard' }, { role: 'assistant', content: 'Oui ?' }],
    regenerate = page({ chat: () => said('Bonjour !'), state: { saveHistory: false, conversationId: ID, messages: [...exchange], aside: { ...aside } } });
  regenerate.context.confirm = () => false;
  await regenerate.context.takeBack(true);
  assert.equal(regenerate.state.messages.length, 2, 'its last exchange still there');
  // With the history it is in the fil: nothing asked.
  const kept = page({ chat: () => said('Bonjour !'), state: { conversationId: ID, messages: [], aside: { ...aside } } });
  kept.context.confirm = () => assert.fail('nothing to ask');
  await kept.send('Et en hiver ?');
  assert.equal(kept.state.aside?.conversationId, ELSEWHERE);
});

test('the question comes only for a message that leaves, and a « non » leaves nothing of it (0.6.90)', async () => {
  // Asked before « Régénérer » met its own refusal (a draft in the box), a « oui » let the conversation
  // set aside go and nothing was made again; asked once the images of a new message were copied, a
  // « non » left them on the server, and the conversation not begun with an identifier given for nothing.
  const aside = () => ({
      conversationId: ELSEWHERE,
      projectId: 'inbox',
      messages: [{ role: 'user', content: 'Un phare' }],
      title: 'Le phare',
      draft: { text: '', images: [], videos: [] },
      nodes: null,
    }),
    exchange = () => [{ role: 'user', content: 'Un renard' }, { role: 'assistant', content: 'Oui ?' }];
  const writing = page({ state: { saveHistory: false, conversationId: ID, messages: exchange(), aside: aside() } });
  writing.context.confirm = () => assert.fail('nothing asked: « Régénérer » refuses first');
  writing.$('prompt').value = 'Un brouillon';
  await writing.context.takeBack(true);
  assert.match(writing.notices.at(-1), /Envoyez ou effacez d’abord le message en cours d’écriture/);
  assert.equal(writing.state.aside?.conversationId, ELSEWHERE, 'the one set aside still there');
  assert.equal(writing.state.messages.length, 2);
  // « Envoyer » greyed (the server away, the engine stopping): the message waits in the box as before,
  // nothing asked, the one set aside kept.
  let chats = 0;
  const held = page({
    chat: () => (chats++, said('Bonjour !')),
    state: { saveHistory: false, conversationId: ID, messages: exchange(), aside: aside(), sendHeld: true },
  });
  held.$('send').disabled = true;
  held.context.confirm = () => assert.fail('nothing asked: the message does not leave');
  await held.context.takeBack(true);
  await held.turn();
  assert.deepEqual([chats, held.state.aside?.conversationId, held.$('prompt').value], [0, ELSEWHERE, 'Un renard']);
  // No model chosen: the same, the Paramètres opened when it is sent.
  const unset = page({ state: { saveHistory: false, conversationId: ID, messages: exchange(), aside: aside(), config: {} } });
  unset.context.confirm = () => assert.fail('nothing asked: no model to answer it');
  await unset.context.takeBack(true);
  await unset.turn();
  assert.deepEqual([unset.state.aside?.conversationId, unset.$('prompt').value], [ELSEWHERE, 'Un renard']);
  assert.match(unset.notices.at(-1), /Choisissez votre LLM/);
  // A new conversation with an image: « non » copies nothing and gives it no identifier.
  let copies = 0;
  const fresh = page({
    state: {
      saveHistory: false,
      conversationId: null,
      messages: [],
      aside: aside(),
      images: [{ url: 'blob:une', source: new Blob(['x'], { type: 'image/png' }) }],
    },
    routes: { attachments: () => (copies++, Response.json({ file: 'une.png', view: '/v/une.png' })) },
  });
  fresh.context.confirm = () => false;
  await fresh.send('Un phare la nuit');
  assert.deepEqual(
    [copies, fresh.state.conversationId, fresh.state.images.length, fresh.$('prompt').value],
    [0, null, 1, 'Un phare la nuit'],
  );
  // « oui »: the message leaves, its image copied once.
  fresh.context.confirm = () => true;
  await fresh.send('Un phare la nuit');
  assert.deepEqual([copies, fresh.state.conversationId, fresh.state.aside], [1, ID, null]);
});
