import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, request } from 'node:http';
import { EventEmitter } from 'node:events';
import { createApplication } from '../server.mjs';
import { readSSE } from '../public/stream.mjs';
import { collectToolCalls } from '../lib/tool-runtime.mjs';
import { nativeFields } from '../lib/native-messages.mjs';
import { RemoteModels, nearbyHost, onThisComputer } from '../lib/remote-models.mjs';
import { ChatModel, normalizedStream, remoteBody, remoteFailure } from '../lib/chat-model.mjs';
import { ChatGPTAccount, responseChunks, responsesRequest } from '../lib/chatgpt.mjs';
import { ClaudeAccess, claudeChunks, claudeMessages, claudeRequest } from '../lib/claude.mjs';
import { OpenRouterSignIn } from '../lib/openrouter.mjs';
import { setupRemoteModels } from '../public/remote-llm-ui.mjs';
import { setupModelChoice } from '../public/model-choice.mjs';

/**
 * The second review of the remote chat model (0.6.40): the settings and the menu of the model in
 * the bar of the chat as the user meets them, the efforts of a quick turn, the refusals said in the
 * right words, the form a service took kept, Claude's time limits and fallbacks. Nothing here calls a
 * real service: fakes on 127.0.0.1, or functions given in place of fetch.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const installed = await access(join(root, 'node_modules', '@anthropic-ai', 'sdk', 'package.json')).then(
  () => true,
  () => false,
);
const needsLibrary = installed ? {} : { skip: 'la bibliothèque @anthropic-ai/sdk n’est pas installée (npm ci)' };
const folder = async t => {
  const path = await mkdtemp(join(tmpdir(), 'moodix-second-review-'));
  t.after(() => rm(path, { recursive: true, force: true }));
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
const settled = async (times = 6) => {
  for (let i = 0; i < times; i++) await new Promise(resolve => setImmediate(resolve));
};
const sse = (...events) =>
  new Response(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''))
    .body;
// The local engine, never started here.
const engine = () => ({ state: 'stopped', busy: false, stop: async () => {}, status: () => ({ state: 'stopped' }) });

/** The few elements setupRemoteModels touches, without a browser (as in tests/openrouter.mjs). */
function fakePage() {
  const elements = new Map();
  const element = () => ({
    hidden: false,
    disabled: false,
    open: false,
    value: '',
    checked: false,
    placeholder: '',
    href: '',
    textContent: '',
    focused: false,
    children: [],
    classList: { toggle() {} },
    listeners: {},
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
    replaceChildren(...children) {
      this.children = children;
    },
    append(...children) {
      this.children.push(...children);
    },
    setAttribute() {},
    focus() {
      this.focused = true;
    },
  });
  const $ = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const node = (tag, className = '', text = '') => Object.assign(element(), { tag, className, textContent: text });
  return { $, node, icon: () => element() };
}

/** A node of a page as far as the menu of the model uses it: a tree, simple selectors, the focus. */
class FakeNode {
  constructor(page, tag = 'div', className = '', text = '') {
    Object.assign(this, { page, tag, className, textContent: text, children: [], parent: null, hidden: false });
    Object.assign(this, { disabled: false, dataset: {}, style: {}, attributes: {}, listeners: {}, value: '', width: 0 });
    const self = this;
    this.classList = {
      toggle(name, on) {
        const names = new Set(self.className.split(/\s+/).filter(Boolean));
        if (on ?? !names.has(name)) names.add(name);
        else names.delete(name);
        self.className = [...names].join(' ');
      },
      contains: name => self.className.split(/\s+/).includes(name),
    };
  }
  get ownerDocument() {
    return this.page;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  hasAttribute(name) {
    return name in this.attributes;
  }
  append(...nodes) {
    for (const item of nodes) {
      item.parent = this;
      this.children.push(item);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
    // The focus of a node taken out of the page goes to its body, as in a browser.
    if (this.page.activeElement && !this.page.body.contains(this.page.activeElement))
      this.page.activeElement = this.page.body;
  }
  contains(other) {
    for (let at = other; at; at = at.parent) if (at === this) return true;
    return false;
  }
  *walk() {
    for (const child of this.children) {
      yield child;
      yield* child.walk();
    }
  }
  matches(selector) {
    if (selector === 'button:not(:disabled)') return this.tag === 'button' && !this.disabled;
    if (selector === '[data-key]') return 'key' in this.dataset;
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    return this.tag === selector;
  }
  querySelectorAll(selector) {
    return [...this.walk()].filter(item => item.matches(selector));
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  addEventListener(type, listener, capture = false) {
    (this.listeners[type] ??= []).push({ listener, capture: Boolean(capture) });
  }
  removeEventListener(type, listener, capture = false) {
    this.listeners[type] = (this.listeners[type] ?? []).filter(
      item => item.listener !== listener || item.capture !== Boolean(capture),
    );
  }
  focus() {
    this.page.activeElement = this;
  }
  getBoundingClientRect() {
    return this.rect ?? { top: 0, bottom: 0, left: 0, right: 0, width: this.width, height: 0 };
  }
  setSelectionRange() {}
}
/** A key pressed where the focus is: the page first (capture), then from the element up. */
function press(page, key) {
  const event = {
    key,
    target: page.activeElement ?? page.body,
    stopped: false,
    preventDefault() {},
    stopPropagation() {
      this.stopped = true;
    },
  };
  const chain = [];
  for (let at = event.target; at; at = at.parent) chain.push(at);
  for (const at of [...chain].reverse())
    for (const { listener, capture } of at.listeners.keydown ?? []) if (capture && !event.stopped) listener(event);
  for (const at of chain)
    for (const { listener, capture } of at.listeners.keydown ?? []) if (!capture && !event.stopped) listener(event);
}
/**
 * The two buttons of the bar of the chat, « Modèle » and « Réflexion », and their menus, in a page of
 * their own; `options()` answers /api/remote/options.
 */
function modelMenu({
  status,
  options,
  choice = async () => ({}),
  view = { innerHeight: 720, innerWidth: 1280 },
  thinking = true,
  localName = 'Qwen 3.5',
  openModels = null,
}) {
  const page = new FakeNode(null, '#document');
  page.page = page;
  page.activeElement = null;
  page.body = new FakeNode(page, 'body');
  page.body.parent = page;
  const ids = {};
  for (const prefix of ['model-choice', 'effort-choice']) {
    ids[prefix] = new FakeNode(page, 'button', prefix);
    ids[prefix + '-text'] = new FakeNode(page, 'span');
    ids[prefix + '-menu'] = new FakeNode(page, 'div', 'glass-menu');
    ids[prefix].append(ids[prefix + '-text']);
    ids[prefix + '-menu'].hidden = true;
    page.body.append(ids[prefix], ids[prefix + '-menu']);
  }
  let current = status,
    reflecting = thinking;
  const asked = [];
  const api = async (path, body) => {
    asked.push([path, body]);
    if (path.startsWith('remote/options')) return options();
    if (path === 'remote/choice') {
      const result = await choice(body);
      return Response.json(result);
    }
    throw Error('unexpected ' + path);
  };
  const control = setupModelChoice({
    $: id => ids[id],
    api,
    node: (tag, className = '', text = '') => new FakeNode(page, tag, className, text),
    getStatus: () => current,
    getThinking: () => reflecting,
    setThinking: on => (reflecting = on),
    getLocalName: () => localName,
    openModels,
    onStatus: next => (current = next),
    view,
  });
  const part = prefix => ({
    button: ids[prefix],
    text: ids[prefix + '-text'],
    menu: ids[prefix + '-menu'],
    said: () => ids[prefix + '-text'].textContent,
    texts: () => [...ids[prefix + '-menu'].walk()].map(item => item.textContent),
  });
  return { page, control, asked, thinking: () => reflecting, ...part('model-choice'), effort: part('effort-choice') };
}
const optionsOf = (model, models, extra = {}) => ({
  preset: 'openrouter',
  model,
  effort: 'medium',
  efforts: models.find(item => item.id === model)?.efforts ?? [],
  models,
  error: '',
  ...extra,
});

// ——— À l'écran : les réglages ———

test('1 · a key of Claude typed, then « Enregistrer » of the settings: it is kept and Claude chosen', async () => {
  const { $, node, icon } = fakePage();
  let server = {
    connections: [],
    active: null,
    presets: { custom: { name: 'Autre', baseUrl: '', key: false } },
    chatgpt: {},
    openrouter: { pending: false, error: '' },
    claude: { library: 'ready', error: '' },
  };
  const calls = [];
  const api = async (path, body) => {
    calls.push([path, body]);
    if (path === 'remote') return Response.json(server);
    if (path === 'remote/provider') {
      const made = { id: 'k1', preset: 'claude', name: 'Claude', baseUrl: 'https://api.anthropic.com/v1' };
      server = { ...server, connections: [{ ...made, model: 'claude-opus-5-5', hasKey: true }], active: 'k1' };
      return Response.json({ ...server, status: { state: 'ready', remote: { id: 'k1' } } });
    }
    throw Error('unexpected ' + path);
  };
  const remote = setupRemoteModels({ $, api, node, icon, confirmFn: () => true });
  await remote.load();
  remote.rows(false)[1].children[0].onclick();
  const keyField = () => remote.rows(false)[1].children[2]?.children[0];
  keyField().value = 'sk-ant-typed-key-0123';
  // Something not saved: closing the settings asks first (settings-guard reads dirty()).
  assert.equal(remote.dirty(), true);
  // « Enregistrer » of the settings saves what is written here first (app.js, saveConfiguration).
  assert.equal(await remote.save(), true);
  assert.deepEqual(calls.find(([path]) => path === 'remote/provider')?.[1], {
    provider: 'claude',
    key: 'sk-ant-typed-key-0123',
  });
  assert.equal(remote.dirty(), false);
});

test('2 · a key being typed stays when the list is drawn again, or « Autre service » opened; a poll draws only a change', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { $, node, icon } = fakePage();
  const server = {
    connections: [],
    active: null,
    presets: { ollama: { name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', key: false } },
    chatgpt: { pending: true },
    openrouter: { pending: false, error: '' },
    claude: { library: 'ready', error: '' },
  };
  let drawn = 0;
  const remote = setupRemoteModels({
    $,
    api: async path => {
      if (path === 'remote') return Response.json(server);
      throw Error('unexpected ' + path);
    },
    node,
    icon,
    confirmFn: () => true,
    onChange: () => drawn++,
  });
  await remote.load();
  await settled();
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(5000);
    await settled();
  }
  // Waiting for ChatGPT, nothing changed: the list is not drawn again (its « Annuler » keeps the focus).
  assert.equal(drawn, 1);

  remote.rows(false)[1].children[0].onclick();
  const keyField = () => remote.rows(false)[1].children[2]?.children[0];
  keyField().value = 'sk-ant-half-typed';
  assert.equal(keyField().value, 'sk-ant-half-typed', 'drawn again, the field keeps what is typed');
  $('add-api').onclick();
  assert.equal(keyField().value, 'sk-ant-half-typed', '« Autre service » opened, the field keeps it too');
  server.chatgpt = { pending: false };
  t.mock.timers.tick(5000);
  await settled();
});

test('7 · « Autre service »: another service chosen takes its own address; opened and left as it was, nothing is to save', async () => {
  const { $, node, icon } = fakePage();
  const presets = {
    groq: { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', key: true },
    mistral: { name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', key: true },
    custom: { name: 'Autre', baseUrl: '', key: false },
  };
  const server = {
    connections: [
      {
        id: 'g1',
        preset: 'groq',
        name: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        model: 'llama-4',
        vision: false,
        hasKey: true,
      },
    ],
    active: null,
    presets,
    chatgpt: {},
    openrouter: { pending: false, error: '' },
    claude: { library: 'ready', error: '' },
  };
  const remote = setupRemoteModels({
    $,
    api: async () => Response.json(server),
    node,
    icon,
    confirmFn: () => true,
  });
  await remote.load();
  // Its pencil: the editor opens on Groq, with nothing changed yet.
  remote.rows(false).at(-1).children[1].onclick();
  assert.equal($('api-url').value, 'https://api.groq.com/openai/v1');
  assert.equal(remote.dirty(), false);
  // Mistral chosen in the list of glass (no focus event reaches the list under it).
  $('api-preset').value = 'mistral';
  $('api-preset').listeners.change();
  assert.equal($('api-url').value, 'https://api.mistral.ai/v1', 'not a « Groq » that talks to Mistral');
  // The guard of the settings asks whether something changed, not whether the editor is open.
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /api: state\.remoteUI\?\.dirty\(\)/);
});

// ——— À l'écran : le menu du modèle ———

const twoModels = [
  { id: 'm1', name: 'Modèle 1', efforts: ['low', 'medium', 'high'] },
  { id: 'm2', name: 'Modèle 2', efforts: ['low', 'medium', 'high'] },
];
const remoteOf = (model, effort = 'medium') => ({ id: 'c1', name: 'OpenRouter', model, effort });

test('3 · the menu of the model by the keyboard: a choice kept closes it, the focus back on its button; Échap closes it, even while it reads', async () => {
  let kept = 'm1';
  const ui = modelMenu({
    status: { state: 'ready', remote: remoteOf('m1') },
    options: () => Response.json({ options: optionsOf(kept, twoModels) }),
    choice: async ({ model }) => {
      kept = model;
      return { options: optionsOf(model, twoModels), status: { state: 'ready', remote: remoteOf(model) } };
    },
  });
  await settled();
  ui.button.onclick();
  await settled();
  assert.equal(ui.menu.hidden, false);
  ui.menu.querySelectorAll('button').find(item => item.textContent === 'Modèle 2').onclick();
  await settled();
  assert.equal(kept, 'm2');
  assert.equal(ui.menu.hidden, true, 'kept: the menu closes');
  assert.equal(ui.page.activeElement, ui.button, 'the focus back on its button');
  assert.equal(ui.said(), 'Modèle 2');
  ui.button.onclick();
  await settled();
  const before = ui.page.activeElement;
  assert.ok(ui.menu.contains(before), 'opened, the focus in it');
  press(ui.page, 'ArrowDown');
  assert.notEqual(ui.page.activeElement, before, 'the arrows move in it');
  press(ui.page, 'Escape');
  assert.equal(ui.menu.hidden, true);
  assert.equal(ui.page.activeElement, ui.button, 'closed, the focus is back on its button');

  // A choice refused: the menu stays, the focus on the one chosen.
  const refused = modelMenu({
    status: { state: 'ready', remote: remoteOf('m1') },
    options: () => Response.json({ options: optionsOf('m1', twoModels) }),
    choice: async () => {
      throw Error('Refusé.');
    },
  });
  await settled();
  refused.button.onclick();
  await settled();
  refused.menu.querySelectorAll('button').find(item => item.textContent === 'Modèle 2').onclick();
  await settled();
  assert.equal(refused.menu.hidden, false);
  assert.equal(refused.page.activeElement?.textContent, 'Modèle 1');

  // While its models are read, and when they cannot be: Échap closes it all the same.
  for (const options of [
    () => new Promise(() => {}),
    () => {
      throw Error('Le service ne répond pas.');
    },
  ]) {
    const reading = modelMenu({ status: { state: 'ready', remote: remoteOf('m1') }, options });
    await settled();
    reading.button.onclick();
    await settled();
    assert.equal(reading.menu.hidden, false);
    press(reading.page, 'Escape');
    assert.equal(reading.menu.hidden, true);
  }
});

test('4 · the menu placed again at each drawing: as tall as the room beside its button, never narrower than it was', async () => {
  const models = Array.from({ length: 20 }, (_, i) => ({
    id: `m${i + 1}`,
    name: `Modèle ${i + 1}`,
    efforts: ['low', 'medium', 'high'],
  }));
  let kept = 'm1';
  const ui = modelMenu({
    status: { state: 'ready', remote: remoteOf('m1') },
    options: () => Response.json({ options: optionsOf(kept, models) }),
    choice: async ({ model }) => {
      kept = model;
      return { options: optionsOf(model, models), status: { state: 'ready', remote: remoteOf(model) } };
    },
  });
  ui.button.rect = { top: 400, bottom: 436, left: 600, right: 700, width: 100, height: 36 };
  ui.menu.width = 420;
  await settled();
  ui.button.onclick();
  await settled();
  // 720 high: 400 above its button, 284 below; the menu fits in the room above (24 px of margin).
  assert.equal(ui.menu.style.maxHeight, '376px');
  // A filter typed (the bar moved meanwhile): placed again, never as it was at the opening; the
  // list gets narrower, the menu does not jump.
  ui.button.rect = { top: 300, bottom: 336, left: 600, right: 700, width: 100, height: 36 };
  ui.menu.width = 260;
  const field = ui.menu.querySelector('.glass-menu-filter');
  field.value = 'Modèle 1';
  for (const { listener } of field.listeners.input) listener();
  // Now 300 above, 384 below: the side with more room.
  assert.equal(ui.menu.style.maxHeight, '360px');
  assert.equal(ui.menu.style.minWidth, '420px');
});

test('5 · as soon as the page opens, the buttons say the name of the model and its effort', async () => {
  const ui = modelMenu({
    status: { state: 'ready', remote: { id: 'c1', name: 'ChatGPT', model: 'gpt-5.2', effort: 'high' } },
    options: () =>
      Response.json({
        options: {
          preset: 'chatgpt',
          model: 'gpt-5.2',
          effort: 'high',
          efforts: ['low', 'medium', 'high'],
          models: [{ id: 'gpt-5.2', name: 'GPT-5.2', efforts: ['low', 'medium', 'high'] }],
          error: '',
        },
      }),
  });
  await settled();
  assert.equal(ui.menu.hidden, true, 'nothing opened');
  assert.equal(ui.said(), 'GPT-5.2');
  assert.equal(ui.effort.said(), 'Réflexion élevée');
  assert.equal(ui.button.attributes['aria-label'] ?? ui.button.getAttribute?.('aria-label'), 'Modèle : GPT-5.2 · ChatGPT');
});

test('6 · many models said so, the effort never hidden by a long name, no tip over the open menu, ↑ to the last, a failure said alone', async () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ id: `vendor/model-${i}`, name: `Modèle ${i}`, efforts: [] }));
  const ui = modelMenu({
    status: { state: 'ready', remote: { ...remoteOf('vendor/model-0'), effort: 'high' } },
    options: () => Response.json({ options: { ...optionsOf('vendor/model-0', many), effort: 'high' } }),
  });
  await settled();
  // The effort on a button of its own, which the CSS never shrinks (the name of the model is cut instead).
  assert.equal(ui.effort.said(), 'Réflexion élevée');
  const css = await readFile(new URL('../public/moodix.css', import.meta.url), 'utf8');
  assert.match(css, /#chat-form #effort-choice\s*\{[^}]*flex-shrink:\s*0/);
  assert.match(css, /\.model-choice-text\s*\{[^}]*text-overflow:\s*ellipsis/);
  // (Once the name is at its least, the reflection gives way too, then the sentence at the right:
  // the bar never takes a second line; its arithmetic is in tests/chat-layout.mjs.)
  assert.match(css, /#chat-form \.composer-options\s*\{\s*flex: 0 1 auto;\s*flex-wrap: nowrap;/);
  // In the menu, a name longer than the menu is wide (a local file of some fifty characters) is
  // cut short on its line, with no bar to scroll the menu sideways; under the pointer or the
  // keyboard its line shows it whole, on as many lines as it takes.
  assert.match(css, /\.glass-menu \{[^}]*max-width: min\(420px, calc\(100vw - 16px\)\);/);
  assert.match(css, /\.glass-menu-item \{[^}]*white-space: nowrap;/);
  assert.match(css, /\.model-choice-menu,\s*\.model-choice-menu \.glass-menu-list \{\s*overflow-x: hidden;\s*\}/);
  assert.match(
    css,
    /\.model-choice-menu \.glass-menu-item \{\s*flex-shrink: 0;\s*max-width: 100%;\s*overflow: hidden;\s*text-overflow: ellipsis;\s*\}/,
  );
  assert.match(
    css,
    /\.model-choice-menu \.glass-menu-item:is\(:hover, :focus-visible\) \{\s*padding-top: 8px;\s*padding-bottom: 8px;\s*white-space: normal;\s*overflow-wrap: anywhere;\s*\}/,
  );
  ui.button.onclick();
  await settled();
  assert.ok(
    ui.texts().some(text => /200 modèles montrés sur 300/.test(text)),
    'the models not shown are said',
  );
  assert.equal(ui.button.dataset.tip, undefined, 'no tip over the open menu');
  ui.menu.querySelector('.glass-menu-filter').focus();
  press(ui.page, 'ArrowUp');
  assert.equal(ui.page.activeElement, ui.menu.querySelectorAll('button').at(-1), '↑ from the filter goes to the last');

  const failed = modelMenu({
    status: { state: 'ready', remote: remoteOf('m1') },
    options: () => {
      throw Error('OpenRouter ne donne pas la liste de ses modèles (erreur 503).');
    },
  });
  await settled();
  failed.button.onclick();
  await settled();
  assert.ok(failed.texts().includes('OpenRouter ne donne pas la liste de ses modèles (erreur 503).'));
  assert.equal(failed.texts().includes('Aucun modèle trouvé.'), false, 'the failure is said alone');
});

test('6 · « Modèle » and « Réflexion »: one menu at a time; the efforts of the model; greyed with why; the local model', async () => {
  const models = [
    { id: 'm1', name: 'Modèle 1', efforts: ['low', 'medium', 'high'] },
    { id: 'm2', name: 'Modèle 2', efforts: [] },
  ];
  let kept = { model: 'm1', effort: 'medium' };
  const settings = [];
  const ui = modelMenu({
    status: { state: 'ready', remote: { ...remoteOf('m1'), effort: 'medium' } },
    options: () => Response.json({ options: { ...optionsOf(kept.model, models), effort: kept.effort } }),
    choice: async change => {
      kept = { ...kept, ...change, ...(change.model === 'm2' ? { effort: '' } : {}) };
      return {
        options: { ...optionsOf(kept.model, models), effort: kept.effort },
        status: { state: 'ready', remote: { ...remoteOf(kept.model), effort: kept.effort } },
      };
    },
    openModels: () => settings.push('ai'),
  });
  await settled();
  assert.deepEqual([ui.said(), ui.effort.said()], ['Modèle 1', 'Réflexion moyenne']);
  // The menu of the model, then that of the reflection: the first closes.
  ui.button.onclick();
  await settled();
  assert.equal(ui.texts().includes('Faible'), false, 'no effort in the menu of the model');
  assert.ok(ui.texts().includes('Changer de service…'));
  ui.effort.button.onclick();
  await settled();
  assert.equal(ui.menu.hidden, true, 'one menu at a time');
  assert.equal(ui.effort.menu.hidden, false);
  assert.deepEqual(
    ui.effort.menu.querySelectorAll('button').map(item => [item.textContent, item.attributes['aria-checked']]),
    [
      ['Faible', 'false'],
      ['Moyenne', 'true'],
      ['Élevée', 'false'],
    ],
  );
  ui.effort.menu.querySelectorAll('button').find(item => item.textContent === 'Élevée').onclick();
  await settled();
  assert.deepEqual(ui.asked.at(-1), ['remote/choice', { effort: 'high' }]);
  assert.equal(ui.effort.menu.hidden, true, 'kept: closed');
  assert.equal(ui.effort.said(), 'Réflexion élevée');
  // A model that lists no effort: the reflection greyed, and why.
  ui.button.onclick();
  await settled();
  ui.menu.querySelectorAll('button').find(item => item.textContent === 'Modèle 2').onclick();
  await settled();
  assert.equal(ui.said(), 'Modèle 2');
  assert.equal(ui.effort.said(), 'Réflexion');
  assert.equal(ui.effort.button.classList.contains('is-off'), true);
  assert.equal(ui.effort.button.attributes['aria-label'], 'Réflexion. Ce modèle ne propose pas de réglage de la réflexion.');
  ui.effort.button.onclick();
  await settled();
  assert.ok(ui.effort.texts().includes('Ce modèle ne propose pas de réglage de la réflexion.'));
  press(ui.page, 'Escape');
  // « Changer de service… »: the settings, the menu closed.
  ui.button.onclick();
  await settled();
  ui.menu.querySelectorAll('button').find(item => item.textContent === 'Changer de service…').onclick();
  assert.deepEqual(settings, ['ai']);
  assert.equal(ui.menu.hidden, true);

  // The local model: its name, « Changer de modèle… »; the reflection, with or without; nothing asked.
  const local = modelMenu({ status: { state: 'ready', remote: null }, options: () => assert.fail('no listing'), openModels: () => settings.push('local') });
  await settled();
  assert.deepEqual([local.said(), local.effort.said()], ['Qwen 3.5', 'Réflexion']);
  local.button.onclick();
  await settled();
  assert.deepEqual(
    local.menu.querySelectorAll('button').map(item => item.textContent),
    ['Qwen 3.5', 'Changer de modèle…'],
  );
  local.menu.querySelectorAll('button').at(-1).onclick();
  assert.deepEqual(settings, ['ai', 'local']);
  local.effort.button.onclick();
  await settled();
  local.effort.menu.querySelectorAll('button').find(item => item.textContent === 'Sans réflexion').onclick();
  assert.equal(local.thinking(), false);
  assert.equal(local.effort.said(), 'Sans réflexion');
  assert.equal(local.effort.button.classList.contains('is-off'), true);
  assert.equal(local.effort.menu.hidden, true);
  assert.deepEqual(local.asked, []);
});

// ——— Côté serveur ———

test('8 · ChatGPT: a quick turn takes the lowest effort the model lists, none when it lists none', async t => {
  const body = { messages: [{ role: 'user', content: 'x' }], chat_template_kwargs: { enable_thinking: false } };
  assert.equal(responsesRequest(body, 'm', 'high', 'minimal').reasoning.effort, 'minimal');
  assert.equal('effort' in responsesRequest(body, 'm', 'high', '').reasoning, false);
  assert.equal(responsesRequest({ messages: body.messages }, 'm', 'high', 'minimal').reasoning.effort, 'high');

  // The chat gives the lowest of the listing to a quick turn.
  const data = await folder(t),
    remotes = new RemoteModels(data),
    asked = [];
  const chatgpt = {
    models: async () => [{ id: 'gpt-x', name: 'GPT X', efforts: ['minimal', 'low', 'high'], vision: true }],
    respond: async (sent, options) => (asked.push(options), Response.json({ choices: [] })),
  };
  const chat = await new ChatModel({ engine: engine(), remotes, chatgpt }).load();
  await chat.use((await remotes.save({ preset: 'chatgpt', model: 'gpt-x', effort: 'high' })).id);
  await chat.options();
  await chat.request(body);
  assert.deepEqual([asked[0].effort, asked[0].quick], ['high', 'minimal']);
});

test('8 · ChatGPT: a model that refuses the summary of its reflection is asked again without it, tools or not; no effort invented', async t => {
  const data = await folder(t);
  await writeFile(
    join(data, 'chatgpt-account.json'),
    JSON.stringify({ access_token: 'access-1', expires_at: Date.now() + 3_600_000 }),
  );
  const sent = [];
  const account = new ChatGPTAccount({
    dataDir: data,
    api: 'https://chatgpt.test/v1',
    fetchImpl: async (url, init) => {
      if (url.endsWith('/models'))
        return Response.json({ models: [{ slug: 'gpt-plain', display_name: 'GPT Plain', visibility: 'list' }] });
      const request = JSON.parse(init.body);
      sent.push(request);
      if (request.reasoning?.summary)
        return Response.json({ error: { message: 'Unsupported parameter: reasoning.summary' } }, { status: 400 });
      const events = [
        { type: 'response.output_text.delta', delta: 'Bonjour' },
        { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 1 } } },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
  });
  const answer = await account.respond({ messages: [{ role: 'user', content: 'x' }] }, { model: 'gpt-plain', effort: 'high' });
  assert.equal((await answer.json()).choices[0].message.content, 'Bonjour');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].reasoning, { effort: 'high' }, 'the effort chosen stays');
  // A model whose listing says no effort: none is offered.
  assert.deepEqual((await account.models())[0].efforts, []);
});

test('9 · « ne sait pas appeler d’outils » and « ne voit pas les images » only for the refusals that say so', () => {
  const where = { host: 'api.example.com', model: 'some/model' };
  for (const [status, said] of [
    [400, '{"error":{"message":"Invalid tool_call_id: call_1 was not found in the tool results"}}'],
    [400, '{"error":{"message":"messages.2: tool result must follow a tool call"}}'],
    [400, '{"error":{"message":"Image exceeds the maximum size of 5 MB"}}'],
    [401, '{"error":{"message":"Invalid API key for tools endpoint"}}'],
  ]) {
    const message = remoteFailure(status, said, where).message;
    assert.doesNotMatch(message, /ne sait pas appeler d’outils|ne voit pas les images/, said);
  }
  assert.match(
    remoteFailure(401, '{"error":{"message":"Invalid API key for tools endpoint"}}', where).message,
    /clé d’API est refusée/,
  );
  assert.match(
    remoteFailure(400, '{"error":{"message":"This model does not support tools"}}', where).message,
    /ne sait pas appeler d’outils/,
  );
});

test('10 · a provider chosen takes what its model takes from its listing: images, its context', async t => {
  const data = await folder(t);
  await mkdir(join(data, 'output'));
  const remotes = new RemoteModels(data);
  await remotes.save({ preset: 'openrouter', model: 'vendor/eyes', key: 'sk-or-v1-0123456789' });
  const app = await createApplication({
    port: 0,
    dataDir: data,
    outputDir: join(data, 'output'),
    openUrl: () => {},
    openrouter: {
      listing: {
        fetchImpl: async () =>
          Response.json({
            data: [
              {
                id: 'vendor/eyes',
                name: 'Eyes',
                supported_parameters: ['tools'],
                architecture: { input_modalities: ['text', 'image'] },
                context_length: 200000,
              },
            ],
          }),
      },
    },
    spawnProcess: () => {
      throw Error('llama.cpp started');
    },
  });
  t.after(() => app.close());
  const boot = await (await fetch(app.url + '/api/bootstrap')).json();
  const response = await fetch(app.url + '/api/remote/provider', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + boot.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'openrouter' }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const { remote } = (await response.json()).status;
  assert.deepEqual([remote.vision, remote.contextSize], [true, 200000]);
});

test('10 · 11 · Claude associated: its model’s context at once; the list of its models asked with a time limit', needsLibrary, async t => {
  const data = await folder(t);
  await mkdir(join(data, 'output'));
  const signals = [];
  class APIError extends Error {}
  class Anthropic {
    static APIError = APIError;
    static APIUserAbortError = class extends APIError {};
    static APIConnectionError = class extends APIError {};
    constructor() {
      this.models = {
        list: (params, { signal } = {}) => {
          signals.push(signal);
          return (async function* () {
            yield {
              id: 'claude-opus-5-5',
              display_name: 'Claude Opus 5.5',
              max_input_tokens: 1000000,
              capabilities: { image_input: { supported: true } },
            };
          })();
        },
      };
    }
  }
  const app = await createApplication({
    port: 0,
    dataDir: data,
    outputDir: join(data, 'output'),
    openUrl: () => {},
    claude: { load: async () => ({ default: Anthropic }), retries: 0 },
    spawnProcess: () => {
      throw Error('llama.cpp started');
    },
  });
  t.after(() => app.close());
  const boot = await (await fetch(app.url + '/api/bootstrap')).json();
  const api = async (path, body) => {
    const response = await fetch(app.url + '/api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + boot.token, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const chosen = await api('remote/provider', { provider: 'claude', key: 'sk-ant-test-0123456789' });
  assert.equal(chosen.status.remote.contextSize, 1000000, 'the gauge says the context of the model at once');
  signals.length = 0;
  await api('remote/options?again=1');
  assert.ok(signals[0] instanceof AbortSignal, 'a service that never answers does not leave the menu waiting');
});

test('11 · the bar says the effort that goes with the next message; an unknown model, or a listing that fails, changes nothing', async t => {
  const data = await folder(t),
    remotes = new RemoteModels(data);
  let listing = async () => [
    { id: 'a/m', name: 'M', efforts: ['low', 'medium', 'high'], vision: false },
    { id: 'a/n', name: 'N', efforts: [], vision: false },
  ];
  const chat = await new ChatModel({ engine: engine(), remotes, openrouterModels: () => listing() }).load();
  await chat.use((await remotes.save({ preset: 'openrouter', model: 'a/m', key: 'sk-or-v1-0123456789' })).id);
  // No effort chosen yet: none said (none is sent).
  assert.equal((await chat.options()).effort, '');
  await assert.rejects(chat.choose({ model: 'unknown/model' }), /n’est pas proposé/);
  assert.equal(chat.connection.model, 'a/m');
  await chat.choose({ effort: 'high' });
  // The listing fails: the effort kept (which still goes) is said all the same.
  listing = async () => {
    throw Object.assign(Error('OpenRouter ne donne pas la liste de ses modèles (erreur 503).'), { status: 502 });
  };
  const failed = await chat.options({ again: true });
  assert.equal(failed.effort, 'high');
  assert.match(failed.error, /erreur 503/);

  // Never read: nothing is chosen blind.
  const other = await folder(t),
    otherRemotes = new RemoteModels(other);
  const blind = await new ChatModel({ engine: engine(), remotes: otherRemotes, openrouterModels: () => listing() }).load();
  await blind.use((await otherRemotes.save({ preset: 'openrouter', model: 'a/m', key: 'sk-or-v1-0123456789' })).id);
  await assert.rejects(blind.choose({ effort: 'low' }), /rien n’a été changé/);
  assert.equal(blind.connection.effort ?? '', '');
});

test('12 · Claude: a quick turn takes the lowest effort its listing says', () => {
  const body = { messages: [{ role: 'user', content: 'x' }], chat_template_kwargs: { enable_thinking: false } };
  assert.equal(claudeRequest(body, { model: 'claude-x', effort: 'high', quick: 'medium' }).output_config.effort, 'medium');
  assert.equal(claudeRequest(body, { model: 'claude-x', effort: 'high' }).output_config.effort, 'low');
});

test('12 · Claude: after a fallback in the middle of the answer, only the call of the model that answers is kept', async () => {
  async function* events() {
    yield { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } };
    yield {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_first', name: 'create_image', input: {} },
    };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"prompt":"un' } };
    yield { type: 'content_block_start', index: 1, content_block: { type: 'fallback' } };
    yield {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', id: 'toolu_second', name: 'create_image', input: {} },
    };
    yield { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"prompt":"a boat"}' } };
    yield { type: 'content_block_stop', index: 2 };
    yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } };
    yield { type: 'message_stop' };
  }
  const calls = [];
  for await (const chunk of claudeChunks(events())) collectToolCalls(calls, chunk.choices?.[0]?.delta ?? {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'toolu_second');
  assert.deepEqual(calls[0].function, { name: 'create_image', arguments: '{"prompt":"a boat"}' });
});

test('12 · Claude: a time limit passed is said as such, in the listing and in the middle of an answer; no credit left too', needsLibrary, async t => {
  const base = await serve(t, async (req, res) => {
    for await (const _ of req);
    if (req.url.startsWith('/v1/models')) return; // Never answers.
    // The key of an account without credit (sent as x-api-key, or as a bearer by the library).
    if ((req.headers['x-api-key'] ?? req.headers.authorization ?? '').includes('poor')) {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'billing_error', message: 'Payment required' } }));
    }
    // An answer begun, then nothing more.
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-haiku-5-5',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      })}\n\n`,
    );
  });
  const claude = new ClaudeAccess({ root, baseURL: base, retries: 0 });
  const body = { messages: [{ role: 'user', content: 'x' }], stream: false };
  await assert.rejects(
    claude.models('sk-ant-test-0123456789', { signal: AbortSignal.timeout(300) }),
    /ne répond pas à temps/,
  );
  await assert.rejects(
    claude.respond(body, {
      model: 'claude-haiku-5-5',
      key: 'sk-ant-test-0123456789',
      effort: 'low',
      signal: AbortSignal.timeout(400),
    }),
    /ne répond pas à temps/,
  );
  await assert.rejects(
    claude.respond(body, { model: 'claude-haiku-5-5', key: 'sk-ant-poor-0123456789', effort: 'low' }),
    /Crédit épuisé sur votre compte Claude Console/,
  );
});

test('13 · no length of answer asked of a remote model; the form a service took is kept, with the effort and one call at a time', async t => {
  assert.equal(
    remoteBody({ messages: [], stream: true, max_tokens: 4096 }, { preset: 'openrouter', model: 'm' }).max_tokens,
    undefined,
  );
  const data = await folder(t),
    remotes = new RemoteModels(data),
    sent = [];
  let refuse = request => 'temperature' in request;
  const chat = await new ChatModel({
    engine: engine(),
    remotes,
    openrouterModels: async () => [
      { id: 'a/m', name: 'M', efforts: ['low', 'medium', 'high'], vision: false },
      { id: 'a/n', name: 'N', efforts: ['low', 'medium', 'high'], vision: false },
    ],
    fetchImpl: async (url, init) => {
      const request = JSON.parse(init.body);
      sent.push(request);
      if (refuse(request))
        return Response.json({ error: { message: 'Unknown field' } }, { status: 400 });
      return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] });
    },
  }).load();
  await chat.use((await remotes.save({ preset: 'openrouter', model: 'a/m', key: 'sk-or-v1-0123456789' })).id);
  await chat.choose({ effort: 'high' });
  const body = {
    messages: [{ role: 'user', content: 'x' }],
    stream: false,
    temperature: 0.7,
    parallel_tool_calls: false,
  };
  await chat.request(body);
  assert.equal(sent.length, 2);
  assert.deepEqual([sent[1].reasoning, sent[1].parallel_tool_calls], [{ effort: 'high' }, false]);
  await chat.request(body);
  assert.equal(sent.length, 3, 'the refused form is not sent again at each message');
  assert.equal('temperature' in sent[2], false);
  assert.equal((await chat.options()).ignored, false);

  // A model that refuses the effort itself: its lightest form, and the bar says the effort is not sent.
  refuse = request => 'temperature' in request || 'reasoning' in request;
  await chat.choose({ model: 'a/n' });
  await chat.request(body);
  assert.equal('reasoning' in sent.at(-1), false);
  assert.equal((await chat.options()).ignored, true);
});

test('14 · a call that came without an identifier is given one; « 127.example.com » is not this computer; 100.x is near', async () => {
  const events = [];
  await readSSE(
    normalizedStream(
      sse(
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'create_image', arguments: '{}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ),
      'api.example.com',
    ),
    event => events.push(event),
  );
  const calls = [];
  for (const event of events) collectToolCalls(calls, event.choices?.[0]?.delta ?? {});
  assert.equal(calls.length, 1);
  assert.match(calls[0].id, /^call_[A-Za-z0-9]+$/);
  assert.doesNotThrow(() => nativeFields({ role: 'assistant', tool_calls: calls }));

  assert.equal(onThisComputer('http://127.example.com/v1'), false);
  assert.equal(onThisComputer('http://127.0.0.1:11434/v1'), true);
  assert.equal(nearbyHost('100.64.1.2'), true);
  assert.equal(nearbyHost('100.200.1.2'), false);
});

test('14 · package-lock.json says the version of package.json', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')),
    lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.deepEqual([lock.version, lock.packages[''].version], [pkg.version, pkg.version]);
});

test('14 · an install of the library of Claude that never ends is stopped, and said', async t => {
  const dir = await folder(t);
  await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@anthropic-ai/sdk': '1.4.0' } }));
  let killed = false;
  const claude = new ClaudeAccess({
    root: dir,
    installTime: 50,
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = child.stderr = null;
      child.kill = () => {
        killed = true;
        queueMicrotask(() => child.emit('close', null));
      };
      return child;
    },
  });
  let timer;
  const ended = await Promise.race([
    claude.install().then(() => true),
    new Promise(resolve => (timer = setTimeout(() => resolve(false), 2000))),
  ]);
  clearTimeout(timer);
  assert.equal(ended, true, 'the install ends');
  assert.equal(killed, true);
  assert.match((await claude.status()).error, /arrêtée après 10 minutes/);
});

test('14 · signing out of ChatGPT with a file of keys that cannot be read: nothing half done', async t => {
  const data = await folder(t);
  await mkdir(join(data, 'output'));
  const remotes = new RemoteModels(data);
  await remotes.save({ preset: 'chatgpt', model: 'gpt-x' });
  await writeFile(join(data, 'remote-llm-keys.json'), '{ not json');
  await writeFile(
    join(data, 'chatgpt-account.json'),
    JSON.stringify({ access_token: 'access-1', expires_at: Date.now() + 3_600_000 }),
  );
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
  const boot = await (await fetch(app.url + '/api/bootstrap')).json();
  const response = await fetch(app.url + '/api/remote/forget', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + boot.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'chatgpt' }),
  });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /fichier des clés/);
  // Still signed in, with its connection: the user can try again.
  const kept = JSON.parse(await readFile(join(data, 'chatgpt-account.json'), 'utf8'));
  assert.equal(kept.access_token, 'access-1');
  assert.equal((await remotes.list()).connections.length, 1);
});

test('14 · OpenRouter: a browser that reads the page of return ahead neither ends the sign-in nor spends it', async t => {
  const data = await folder(t);
  const sign = new OpenRouterSignIn({ remotes: new RemoteModels(data), site: 'http://127.0.0.1:9', api: 'http://127.0.0.1:9/api/v1' });
  t.after(() => sign.close());
  const { url } = await sign.start();
  const back = new URL(new URL(url).searchParams.get('callback_url'));
  // Asked by node:http (fetch may leave out a header of the browser's own).
  const get = headers =>
    new Promise((resolve, reject) =>
      request(back, { headers }, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      })
        .on('error', reject)
        .end(),
    );
  for (const headers of [{ 'Sec-Purpose': 'prefetch' }, { Purpose: 'prefetch' }]) {
    assert.notEqual(await get(headers), 200);
    assert.equal(sign.status().pending, true, 'the sign-in still waits for the user');
    assert.equal(sign.status().error, '');
  }
});

test('13 · « Améliorer le prompt » with a remote model that reflects within any length it is given (as Ernie on OpenRouter)', async t => {
  const sent = [];
  const base = await serve(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    sent.push(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // A length asked is spent reflecting: nothing written. Without one, the prompt comes after the reflection.
    const limited = 'max_tokens' in body || 'max_completion_tokens' in body;
    res.end(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              reasoning: 'The user wants a richer prompt… '.repeat(20),
              content: limited ? '' : 'A red fishing boat crossing a calm bay at dawn, soft mist, cinematic light.',
            },
            finish_reason: limited ? 'length' : 'stop',
          },
        ],
      }),
    );
  });
  const data = await folder(t);
  await mkdir(join(data, 'output'));
  const remotes = new RemoteModels(data);
  const saved = await remotes.save({
    preset: 'openrouter',
    baseUrl: `${base}/api/v1`,
    model: 'baidu/ernie-5.5-flash-preview:free',
    key: 'sk-or-v1-0123456789',
  });
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
  const boot = await (await fetch(app.url + '/api/bootstrap')).json();
  // Started as the application starts it at launch (a test server does not).
  const started = await fetch(app.url + '/api/start', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + boot.token, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal((await started.json()).state, 'ready');
  const response = await fetch(app.url + '/api/studio/enrich', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + boot.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'un bateau rouge à l’aube' }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.match((await response.json()).prompt, /red fishing boat/);
  assert.equal(sent.length, 1, 'asked once');
});

// ——— 0.6.41, asked by the session that adapts the instructions to large models ———

test('Claude is told a result of a tool that says a failure as an error; other results as they are', () => {
  const { messages } = claudeMessages([
    { role: 'user', content: 'une image' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'create_image', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'toolu_1', content: '{"status":"error","error":"La génération a échoué."}' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'toolu_2', type: 'function', function: { name: 'create_image', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'toolu_2', content: '{"status":"done","path":"a.png"}' },
  ]);
  const results = messages.flatMap(turn => turn.content).filter(block => block.type === 'tool_result');
  assert.deepEqual(
    results.map(block => block.is_error),
    [true, undefined],
  );
});

test('what was read from the cache is said in the usage, as OpenAI says it (ChatGPT, Claude)', async () => {
  const events = [
    { type: 'response.output_text.delta', delta: 'ok' },
    {
      type: 'response.completed',
      response: { usage: { input_tokens: 9000, output_tokens: 5, input_tokens_details: { cached_tokens: 8704 } } },
    },
  ];
  const stream = new Response(events.map(event => `event: ${event.type}
data: ${JSON.stringify(event)}

`).join(''))
    .body;
  let usage;
  for await (const chunk of responseChunks(stream)) usage = chunk.usage ?? usage;
  assert.deepEqual([usage.prompt_tokens, usage.prompt_tokens_details], [9000, { cached_tokens: 8704 }]);

  async function* claudeEvents() {
    yield {
      type: 'message_start',
      message: { usage: { input_tokens: 40, cache_read_input_tokens: 9400, cache_creation_input_tokens: 60, output_tokens: 1 } },
    };
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } };
    yield { type: 'message_stop' };
  }
  let told;
  for await (const chunk of claudeChunks(claudeEvents())) told = chunk.usage ?? told;
  assert.deepEqual([told.prompt_tokens, told.prompt_tokens_details], [9500, { cached_tokens: 9400 }]);
});
