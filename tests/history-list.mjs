import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupProjectNavigation, projectGroups, projectLabel, shortDate, titleFound } from '../public/project-navigation.mjs';
import * as sessionCopies from '../public/session-copies.mjs';
class Element {
  constructor(tag = '', className = '', textContent = '') {
    Object.assign(this, {
      tag,
      className,
      textContent,
      children: [],
      dataset: {},
      attributes: {},
      hidden: false,
      disabled: false,
      value: '',
      scrollTop: 0,
      style: {},
      offsetWidth: 268,
      offsetHeight: 200,
    });
    const element = this;
    this.classList = {
      add: name => (element.className = `${element.className} ${name}`.trim()),
      remove() {},
    };
  }
  get lastChild() {
    return this.children.at(-1);
  }
  append(...items) {
    this.children.push(...items);
  }
  replaceChildren(...items) {
    this.children = items;
    this.scrollTop = 0;
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  addEventListener() {}
  querySelector() {
    return null;
  }
  contains(other) {
    return walk(this).includes(other);
  }
  getBoundingClientRect() {
    return { left: 36, top: 81, right: 144, bottom: 114, width: 108, height: 33 };
  }
  remove() {
    this.removed = true;
  }
  focus() {}
  close() {
    this.open = false;
  }
  showModal() {
    this.open = true;
  }
}
const walk = element => [element, ...element.children.flatMap(walk)];
function fixture(t, patch = {}) {
  const previous = globalThis.document,
    previousWindow = globalThis.window,
    nodes = new Map(),
    menus = [],
    $ = id => {
      if (!nodes.has(id)) nodes.set(id, new Element());
      return nodes.get(id);
    };
  globalThis.document = {
    body: { dataset: {}, append: element => menus.push(element) },
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window = { innerWidth: 1440, innerHeight: 900, addEventListener() {}, removeEventListener() {} };
  t.after(() => {
    globalThis.document = previous;
    globalThis.window = previousWindow;
  });
  $('conversation-title').textContent = 'Current conversation';
  const state = {
      projects: [
        { id: 'inbox', name: 'Conversations' },
        { id: 'project', name: 'A project' },
      ],
      projectId: 'project',
      view: 'chat',
      saveHistory: true,
      status: {},
      conversationId: 'current',
      messages: [{ role: 'user', content: 'Hello' }],
      historyItems: [
        { id: 'past', title: 'Past', projectId: 'project', updatedAt: '2026-11-07' },
        { id: 'current', title: 'Current', projectId: 'project', updatedAt: '2026-11-08' },
      ],
      ...patch,
    },
    calls = [];
  const ui = setupProjectNavigation({
    $,
    state,
    node: (...args) => new Element(...args),
    icon: name => new Element('svg', name),
    api: async (route, body) => {
      calls.push([route, body]);
      // What a move would give the takes of a conversation (lib/takes.mjs).
      if (route.startsWith('takes/preview')) return Response.json(state.preview ?? { count: 4, first: 33, last: 36 });
      const item = state.historyItems.find(entry => entry.id === body?.id) ?? state.historyItems[0];
      return Response.json({
        project: { id: 'created', name: body?.name },
        conversation: { ...item, ...(body?.title ? { title: body.title } : {}), ...(body?.projectId ? { projectId: body.projectId } : {}) },
      });
    },
    openConversation: id => calls.push(['open', id]),
    newConversation: id => calls.push(['new', id]),
    removeConversation: item => calls.push(['delete', item.id]),
    setTitle: title => calls.push(['title', title]),
  });
  ui.render();
  // The menu of the fil opened by its button: the last one put on the page.
  const open = id => {
    $(id).onclick();
    return menus.at(-1);
  };
  const lines = menu =>
    walk(menu)
      .filter(element => /^thread-line(\s|$)/.test(element.className))
      .map(line => ({
        line,
        name: walk(line).find(element => element.className === 'thread-choice-name').textContent,
        choice: walk(line).find(element => element.className === 'thread-choice'),
        tool: label => walk(line).find(element => element.attributes['aria-label']?.startsWith(label)),
        current: line.className.includes('is-current'),
      }));
  return { ui, state, $, calls, open, lines, menus };
}
test('the menu of the conversations lists those of the project once, the open one ticked, each with its pencil and bin', t => {
  const { calls, open, lines } = fixture(t);
  const rows = lines(open('thread-conversation'));
  assert.deepEqual(
    rows.map(row => [row.name, row.current]),
    [
      ['Current', true],
      ['Past', false],
    ],
  );
  assert.ok(rows.every(row => row.tool('Renommer ou déplacer la conversation') && row.tool('Supprimer la conversation')));
  // The pencil does both: its tooltip says it.
  assert.equal(rows[0].tool('Renommer ou déplacer').dataset.tip, 'Renommer ou déplacer');
  rows[1].choice.onclick();
  rows[0].tool('Supprimer').onclick();
  assert.deepEqual(calls, [
    ['open', 'past'],
    ['delete', 'current'],
  ]);
});
test('history disabled still shows the current unsaved conversation only in its project, without a bin', t => {
  const { open, lines } = fixture(t, { saveHistory: false, historyItems: [], conversationId: null });
  const rows = lines(open('thread-conversation'));
  assert.deepEqual(
    rows.map(row => [row.name, row.current, !!row.tool('Supprimer'), !!row.tool('Renommer')]),
    [['Current conversation', true, false, false]],
  );
});
test('choosing a project in the fil: a conversation begun stays where it is and a new one starts in that project', t => {
  const { calls, open, lines, $ } = fixture(t);
  const rows = lines(open('thread-project'));
  // The projects first, « Sans projet » last; the one of the conversation ticked.
  assert.deepEqual(
    rows.map(row => [row.name, row.current]),
    [
      ['A project', true],
      ['Sans projet', false],
    ],
  );
  assert.equal($('thread-project-name').textContent, 'A project');
  // « Sans projet » can be neither renamed nor deleted.
  assert.equal(rows[1].tool('Renommer'), undefined);
  assert.equal(rows[1].tool('Supprimer'), undefined);
  rows[1].choice.onclick();
  assert.deepEqual(calls, [['new', 'inbox']]);
});
test('a conversation not begun moves to the project chosen, its draft kept, nothing saved', t => {
  const { calls, open, lines, state, $ } = fixture(t, { conversationId: null, messages: [], historyItems: [] });
  lines(open('thread-project'))
    .find(row => row.name === 'Sans projet')
    .choice.onclick();
  assert.equal(state.projectId, 'inbox');
  assert.equal($('thread-project-name').textContent, 'Sans projet');
  assert.deepEqual(calls, []);
});
test('a saved conversation is renamed or moved from its pencil: one request each, the open one renamed at once', async t => {
  const { calls, open, lines, state, $ } = fixture(t);
  lines(open('thread-conversation'))
    .find(row => row.name === 'Current')
    .tool('Renommer')
    .onclick();
  assert.equal($('conversation-dialog').open, true);
  assert.equal($('conversation-name').value, 'Current');
  assert.deepEqual(
    $('conversation-project').children.map(option => [option.value, option.textContent]),
    [
      ['project', 'A project'],
      ['inbox', 'Sans projet'],
    ],
    'a menu: the projects, then « Sans projet »',
  );
  assert.equal($('conversation-project').value, 'project');
  // Its name only.
  $('conversation-name').value = '  Un   renard  ';
  await $('conversation-form').onsubmit({ preventDefault() {} });
  assert.deepEqual(calls, [
    ['history/rename', { id: 'current', title: 'Un renard' }],
    ['title', 'Un renard'],
  ]);
  assert.equal($('conversation-dialog').open, false);
  // Its project only: moved, its name unchanged.
  calls.length = 0;
  lines(open('thread-conversation'))
    .find(row => row.name === 'Past')
    .tool('Renommer')
    .onclick();
  $('conversation-project').value = 'inbox';
  await $('conversation-form').onsubmit({ preventDefault() {} });
  assert.deepEqual(calls, [['projects/move', { id: 'past', projectId: 'inbox' }]]);
  assert.equal(state.historyItems.find(item => item.id === 'past').projectId, 'inbox');
  assert.equal(state.projectId, 'project', 'the open conversation stays in its project');
});
test('before a move, the window of the pencil says the numbers its takes will take, so that they do not surprise', async t => {
  const { calls, open, lines, state, $ } = fixture(t);
  lines(open('thread-conversation'))
    .find(row => row.name === 'Current')
    .tool('Renommer')
    .onclick();
  assert.equal($('conversation-takes').hidden, true, 'nothing said while the project is its own');
  $('conversation-project').value = 'inbox';
  await $('conversation-project').onchange();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls.at(-1), ['takes/preview?conversation=current&project=inbox', undefined]);
  assert.equal($('conversation-takes').textContent, 'Ses 4 prises prendront les numéros 33 à 36 dans « Sans projet ».');
  assert.equal($('conversation-takes').hidden, false);
  // One take; none; back in its own project: said, then nothing.
  state.preview = { count: 1, first: 12, last: 12 };
  await $('conversation-project').onchange();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal($('conversation-takes').textContent, 'Sa prise prendra le numéro 12 dans « Sans projet ».');
  state.preview = { count: 0, first: 12, last: 11 };
  await $('conversation-project').onchange();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal($('conversation-takes').hidden, true);
  $('conversation-project').value = 'project';
  await $('conversation-project').onchange();
  assert.equal($('conversation-takes').hidden, true);
});

test('unknown old project associations stay visible in the default group and sorting does not mutate history', () => {
  const items = [
      { id: 'old', projectId: 'missing', updatedAt: '2025' },
      { id: 'new', updatedAt: '2026' },
    ],
    groups = projectGroups([{ id: 'inbox', name: 'Conversations' }], items);
  assert.deepEqual(
    groups[0].conversations.map(item => item.id),
    ['new', 'old'],
  );
  assert.equal(items[0].id, 'old');
});

test('opening or saving an older conversation keeps the order of the menu and of the projects', t => {
  const newer = { id: 'new', title: 'New', projectId: 'project', createdAt: '2026-11-08', updatedAt: '2026-11-08' },
    older = { id: 'old', title: 'Old', projectId: 'project', createdAt: '2026-11-07', updatedAt: '2026-11-07' };
  const { ui, state, calls, open, lines } = fixture(t, { conversationId: newer.id, historyItems: [newer, older] });
  const rows = lines(open('thread-conversation'));
  assert.deepEqual(
    rows.map(row => row.name),
    ['New', 'Old'],
  );
  const projects = lines(open('thread-project')).map(row => row.name);
  rows[1].choice.onclick();
  assert.deepEqual(calls, [['open', 'old']]);
  state.conversationId = older.id;
  older.updatedAt = '2026-11-09';
  state.historyItems = [older, newer];
  ui.render();
  assert.deepEqual(
    lines(open('thread-conversation')).map(row => [row.name, row.current]),
    [
      ['New', false],
      ['Old', true],
    ],
  );
  assert.deepEqual(
    lines(open('thread-project')).map(row => row.name),
    projects,
  );
});

test('a new unsaved conversation is first under its project and stays first after saving', t => {
  const past = { id: 'past', title: 'Past', projectId: 'project', createdAt: '2026-11-07', updatedAt: '2026-11-09' },
    other = { id: 'other', title: 'Other', projectId: 'inbox', createdAt: '2026-11-08', updatedAt: '2026-11-08' };
  const { ui, state, open, lines } = fixture(t, { conversationId: null, historyItems: [past, other] });
  const projectRows = () => lines(open('thread-conversation')).map(row => row.name);
  assert.deepEqual(projectRows(), ['Current conversation', 'Past']);
  state.conversationId = 'created';
  state.historyItems.push({
    id: 'created',
    title: 'New',
    projectId: 'project',
    createdAt: '2026-11-09',
    updatedAt: '2026-11-09',
  });
  ui.render();
  assert.deepEqual(projectRows(), ['New', 'Past']);
  const groups = projectGroups(state.projects, [
    { id: 'b', createdAt: 'same', projectId: 'inbox' },
    { id: 'a', createdAt: 'same', projectId: 'inbox' },
  ]);
  assert.deepEqual(
    groups.map(group => group.id),
    ['inbox', 'project'],
  );
  assert.deepEqual(
    groups[0].conversations.map(item => item.id),
    ['a', 'b'],
  );
});

test('a conversation not begun is not listed under « + Nouvelle conversation »: it is that line already', t => {
  const { open, lines, $ } = fixture(t, { conversationId: null, historyItems: [] });
  $('conversation-title').textContent = 'Nouvelle conversation';
  const menu = open('thread-conversation');
  assert.deepEqual(lines(menu), []);
  const empty = walk(menu).find(element => element.className === 'thread-empty');
  assert.equal(empty.textContent, 'Aucune conversation');
  assert.equal(empty.hidden, false);
});

test('the search of the menu finds a conversation by its words, case and accents aside', t => {
  const items = [
    { id: 'a', title: 'Renard sous la neige', projectId: 'project', createdAt: '2026-11-08' },
    { id: 'b', title: 'Été à la plage', projectId: 'project', createdAt: '2026-11-07' },
  ];
  const { open, lines } = fixture(t, { conversationId: 'a', historyItems: items });
  const menu = open('thread-conversation'),
    field = walk(menu).find(element => element.tag === 'input'),
    empty = walk(menu).find(element => element.className === 'thread-empty');
  assert.equal(field.placeholder, 'Rechercher…');
  field.value = 'ete';
  field.oninput();
  assert.deepEqual(
    lines(menu).map(row => [row.name, row.line.hidden]),
    [
      ['Renard sous la neige', true],
      ['Été à la plage', false],
    ],
  );
  field.value = 'chat';
  field.oninput();
  assert.equal(empty.hidden, false);
  assert.equal(titleFound('Été à la PLAGE', ' plage '), true);
  assert.equal(titleFound('Renard', 'neige'), false);
});

test('the date of a conversation in the menu: minutes, hours, « hier », then the day', () => {
  const now = new Date(2026, 10, 16, 15, 30);
  assert.equal(shortDate(new Date(2026, 10, 16, 15, 29, 40).toISOString(), now), 'à l’instant');
  assert.equal(shortDate(new Date(2026, 10, 16, 15, 5).toISOString(), now), 'il y a 25 min');
  assert.equal(shortDate(new Date(2026, 10, 16, 13, 10).toISOString(), now), 'il y a 2 h');
  assert.equal(shortDate(new Date(2026, 10, 15, 23, 50).toISOString(), now), 'hier');
  assert.equal(shortDate(new Date(2026, 10, 12, 9).toISOString(), now), '12 nov.');
  assert.equal(shortDate(new Date(2025, 10, 12, 9).toISOString(), now), '12 nov. 2025');
  assert.equal(shortDate('', now), '');
  assert.equal(shortDate('pas une date', now), '');
});

test('outside any project, the conversations are « Sans projet », whatever the stored name of their group', () => {
  assert.equal(projectLabel({ id: 'inbox', name: 'Conversations' }), 'Sans projet');
  assert.equal(projectLabel({ id: 'p1', name: 'Clips de Noël' }), 'Clips de Noël');
  assert.equal(projectLabel(undefined), 'Sans projet');
});

test('the Pellicule keeps the current messages and draft', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    state = {
      projectWorking: false,
      status: {},
      view: 'chat',
      conversationId: 'kept',
      studioId: 'studio',
      messages: [{ role: 'user', content: 'Keep' }],
    },
    prompt = { value: 'An unsent draft' },
    attributes = {},
    document = { body: { dataset: {} } };
  let pending,
    saves = 0,
    renders = 0;
  const context = {
    ...sessionCopies,
    requestSettingsClose: action => context.settingsGuard.requestClose(action),
    updateControls() {},
    notice() {},
    state,
    document,
    $: id => (id === 'prompt' ? prompt : { setAttribute: (name, value) => (attributes[name] = value) }),
    assetsUI: { flush: async () => true },
    persistConversation: async () => {
      saves++;
      return true;
    },
    settingsGuard: {
      requestClose: action => {
        pending = action();
      },
    },
    projectUI: { render: () => renders++ },
    libraryUI: { show: () => shows++ },
  };
  let shows = 0;
  runInNewContext(
    source.slice(source.indexOf('function showLibrary('), source.indexOf('async function newConversation(')) +
      ';this.show=showLibrary;',
    context,
  );
  context.show();
  await pending;
  assert.equal(state.view, 'library');
  assert.equal(shows, 1);
  assert.deepEqual(state.messages, [{ role: 'user', content: 'Keep' }]);
  assert.equal(prompt.value, 'An unsent draft');
  assert.equal(saves, 1);
  assert.equal(renders, 1);
});

test('in the Pellicule the fil is gone; the unsaved conversation is still there, not said open', t => {
  const { $, calls, open, lines } = fixture(t, {
    view: 'library',
    conversationId: null,
    historyItems: [],
    messages: [{ role: 'user', content: 'Unsaved' }],
    saveHistory: false,
  });
  assert.equal($('thread').hidden, true);
  const [row] = lines(open('thread-conversation'));
  assert.equal(row.current, false);
  row.choice.onclick();
  assert.deepEqual(calls, [['open', null]]);
});

test('the Pellicule is said current in the top bar, the conversation unchanged', t => {
  const { ui, state, $ } = fixture(t),
    before = JSON.stringify(state.historyItems);
  assert.equal($('library-open').attributes['aria-current'], 'false');
  assert.equal($('chat-open').attributes['aria-current'], 'page');
  assert.equal($('thread').hidden, false);
  state.view = 'library';
  ui.render();
  assert.equal($('library-open').attributes['aria-current'], 'page');
  assert.equal($('chat-open').attributes['aria-current'], 'false');
  assert.equal(JSON.stringify(state.historyItems), before);
  assert.equal(state.conversationId, 'current');
});

test('the library locks navigation while pending descriptions and saves complete', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    state = { status: {}, view: 'chat' },
    document = { body: { dataset: {} } };
  let release, pending;
  const gate = new Promise(resolve => {
      release = resolve;
    }),
    context = {
      ...sessionCopies,
      requestSettingsClose: action => context.settingsGuard.requestClose(action),
      state,
      document,
      $: () => ({ setAttribute() {} }),
      updateControls() {},
      notice() {},
      assetsUI: { flush: () => gate },
      persistConversation: async () => true,
      settingsGuard: {
        requestClose: action => {
          pending = action();
        },
      },
      projectUI: { render() {} },
      libraryUI: { show() {} },
    };
  runInNewContext(
    source.slice(source.indexOf('function showLibrary('), source.indexOf('async function newConversation(')) +
      ';this.home=showLibrary;',
    context,
  );
  try {
    context.home();
    assert.equal(state.loadingHistory, true);
  } finally {
    release(true);
    await pending;
  }
  assert.equal(state.loadingHistory, false);
  assert.equal(state.view, 'library');
});
test('an action clicked before the page knows its token waits for it instead of being refused', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    state = { token: '' },
    sent = [];
  const context = {
    state,
    fetch: async (url, options) => {
      sent.push([url, options.headers.Authorization]);
      return { ok: true };
    },
  };
  runInNewContext(
    source.slice(source.indexOf('let tokenKnown;'), source.indexOf('let historyWrite')) +
      ';this.api=api;this.tokenKnown=tokenKnown;',
    context,
  );
  // The first answer of the server takes seconds while the model loads; the page is already usable.
  const clicked = context.api('studio');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent, [], 'nothing leaves without a token');
  state.token = 'abc';
  context.tokenKnown();
  await clicked;
  assert.deepEqual(sent, [['/api/studio', 'Bearer abc']]);
});
test('Chat and Studio are two views of one conversation: switching is immediate, even during an answer', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    state = { status: {}, view: 'chat', conversationId: 'kept', studioId: 'studio', generating: true },
    document = { body: { dataset: {} } };
  let loaded,
    opened,
    synced = 0;
  const tools = new Promise(resolve => {
      loaded = resolve;
    }),
    context = {
      ...sessionCopies,
      requestSettingsClose: action => action(),
      state,
      document,
      $: () => ({ setAttribute() {}, focus() {} }),
      updateControls() {},
      syncViews: () => synced++,
      showLastReply() {},
      scrollToBottom() {},
      notice() {},
      assetsUI: { flush: async () => true },
      persistConversation: async () => assert.fail('nothing to save: it is the same conversation'),
      projectUI: { render() {} },
      // GET /api/studio takes seconds; the Studio is on screen meanwhile.
      studioUI: {
        open() {
          opened = state.loadingHistory;
          return tools;
        },
      },
    };
  runInNewContext(
    source.slice(source.indexOf('function showLibrary('), source.indexOf('async function newConversation(')) +
      ';this.studio=showStudio;this.chat=showChat;',
    context,
  );
  try {
    // An answer is being written: the Studio still opens, nothing is locked.
    context.studio();
    assert.equal(state.view, 'studio');
    assert.equal(opened, undefined, 'the tools load without locking the page');
    assert.equal(synced, 1);
    context.chat();
    assert.equal(state.view, 'chat');
    assert.equal(synced, 2);
  } finally {
    loaded();
  }
});
test('a deferred library action never hides a response that started while settings confirmation was pending', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    state = { status: {}, view: 'chat' };
  let deferred,
    flushes = 0;
  const context = {
    ...sessionCopies,
    requestSettingsClose: action => context.settingsGuard.requestClose(action),
    state,
    document: { body: { dataset: {} } },
    $: () => ({ setAttribute() {} }),
    updateControls() {},
    notice() {},
    assetsUI: {
      flush: async () => {
        flushes++;
        return true;
      },
    },
    persistConversation: async () => true,
    settingsGuard: {
      requestClose: action => {
        deferred = action;
      },
    },
    projectUI: { render() {} },
    libraryUI: { show: () => assert.fail('nothing shown while an answer is written') },
  };
  runInNewContext(
    source.slice(source.indexOf('function showLibrary('), source.indexOf('async function newConversation(')) +
      ';this.home=showLibrary;',
    context,
  );
  context.home();
  state.generating = true;
  await deferred();
  assert.equal(state.view, 'chat');
  assert.equal(flushes, 0);
});
test('failed library preparation keeps the chat visible and releases navigation controls', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  for (const failure of [false, new Error('Description save failed')]) {
    const state = { status: {}, view: 'chat' };
    let pending,
      renders = 0,
      notices = [];
    const context = {
      ...sessionCopies,
      requestSettingsClose: action => context.settingsGuard.requestClose(action),
      state,
      document: { body: { dataset: {} } },
      $: () => ({ setAttribute() {} }),
      updateControls() {},
      notice: text => notices.push(text),
      assetsUI: {
        flush: async () => {
          if (failure) throw failure;
          return false;
        },
      },
      persistConversation: async () => {
        throw Error('Must not save');
      },
      settingsGuard: {
        requestClose: action => {
          pending = action();
        },
      },
      projectUI: { render: () => renders++ },
      libraryUI: { show: () => assert.fail('nothing shown when the conversation could not be kept') },
    };
    runInNewContext(
      source.slice(source.indexOf('function showLibrary('), source.indexOf('async function newConversation(')) +
        ';this.home=showLibrary;',
      context,
    );
    context.home();
    await pending;
    assert.equal(state.view, 'chat');
    assert.equal(state.loadingHistory, false);
    assert.equal(renders, 0);
    assert.equal(notices.length, failure ? 1 : 0);
  }
});

test('a project is renamed with its pencil and deleted with its bin; a right click on the fil offers both', async t => {
  const { $, calls, state, open, lines, menus } = fixture(t);
  const project = () => lines(open('thread-project')).find(row => row.name === 'A project');
  project().tool('Renommer le projet').onclick();
  assert.equal($('project-dialog').open, true);
  assert.equal($('project-dialog-title').textContent, 'Renommer le projet');
  assert.equal($('project-name').value, 'A project');
  $('project-dialog').close();

  // The right click on the project of the fil: a shortcut of its menu.
  $('thread-project').oncontextmenu({ preventDefault() {} });
  const shortcut = menus.at(-1);
  assert.deepEqual(
    walk(shortcut)
      .filter(element => element.className.startsWith('thread-action'))
      .map(element => element.children[1].textContent),
    ['Renommer', 'Supprimer le projet'],
  );
  walk(shortcut)
    .filter(element => element.className.startsWith('thread-action'))[1]
    .onclick();
  assert.equal($('project-delete-dialog').open, true);
  // What happens to its conversations and their takes, said before anything is done.
  assert.match($('project-delete-description').textContent, /2 conversations seront déplacées dans « Sans projet », avec leurs prises\. Aucune conversation ni prise n’est effacée\./);

  project().tool('Supprimer le projet').onclick();
  await $('project-delete-confirm').onclick();
  assert.deepEqual(calls.at(-1), ['projects/delete', { id: 'project', confirm: true }]);
  assert.deepEqual(
    state.projects.map(item => item.id),
    ['inbox'],
  );
  assert.equal(state.projectId, 'inbox');
  assert.equal($('thread-project-name').textContent, 'Sans projet');
});

test('a project made from the fil is the one chosen: the conversation begun stays, a new one starts in it', async t => {
  const { $, calls, state, open, menus } = fixture(t);
  const menu = open('thread-project');
  walk(menu)
    .find(element => element.className === 'thread-action')
    .onclick();
  assert.equal($('project-dialog-title').textContent, 'Nouveau projet');
  $('project-name').value = 'A new idea';
  await $('project-form').onsubmit({ preventDefault() {} });
  assert.ok(state.projects.some(item => item.name === 'A new idea'));
  assert.deepEqual(calls.slice(-2), [
    ['projects/save', { name: 'A new idea' }],
    ['new', 'created'],
  ]);
  assert.ok(menus.length >= 1);
});

// The requests of the page, with what serverRestarted needs: the answers of a server started again.
async function restartedServer({ token = 'old', version = '0.5.128', next = { token: 'new', version: '0.5.128' }, updating = false, valid = next.token } = {}) {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    state = { token, version, updating, closingApp: false, messages: [], images: [], videos: [], thinking: true, view: 'chat', historyItems: [] },
    sent = [],
    kept = new Map(),
    reloads = [];
  let asked = 0;
  const context = {
    state,
    AbortSignal,
    $: id => (id === 'prompt' ? { value: 'Un brouillon' } : { textContent: 'Une conversation' }),
    sessionStorage: { setItem: (key, value) => kept.set(key, value) },
    location: { reload: () => reloads.push(true) },
    fetch: async (url, options = {}) => {
      if (url.startsWith('/api/bootstrap')) {
        asked++;
        await new Promise(resolve => setTimeout(resolve, 5));
        return { json: async () => next };
      }
      const key = options.headers.Authorization.slice(7);
      sent.push([url, key]);
      // The server knows its key only.
      return key === valid ? { ok: true, status: 200 } : { ok: false, status: 401, json: async () => ({ error: 'Accès refusé. Rechargez la page.' }) };
    },
  };
  runInNewContext(
    source.slice(source.indexOf('let tokenKnown;'), source.indexOf('let historyWrite')) +
      ';this.api=api;this.tokenKnown=tokenKnown;this.RESUME=RESUME;',
    context,
  );
  context.tokenKnown();
  return { context, state, sent, kept, reloads, asked: () => asked };
}

test('a page left open through a restart takes the new key itself and asks again (the same version)', async () => {
  const page = await restartedServer();
  // Two requests refused at once: one question to the server, both asked again with the new key.
  await Promise.all([page.context.api('status'), page.context.api('history')]);
  assert.equal(page.state.token, 'new');
  assert.equal(page.asked(), 1);
  assert.deepEqual(
    page.sent.filter(([, key]) => key === 'new').map(([url]) => url).sort(),
    ['/api/history', '/api/status'],
  );
  assert.deepEqual(page.reloads, [], 'no reload: the media keep their keys');
});

test('a refusal with the key still valid is a refusal; during an update, the update reloads the page', async () => {
  const same = await restartedServer({ next: { token: 'old', version: '0.5.128' }, valid: 'other' });
  await assert.rejects(same.context.api('status'), { status: 401 });
  const updating = await restartedServer({ updating: true });
  await assert.rejects(updating.context.api('status'), { status: 401 });
  assert.equal(updating.asked(), 0);
});

test('a page of an older version reloads, its draft kept in its tab for the page that replaces it', async () => {
  const page = await restartedServer({ next: { token: 'new', version: '0.5.129' } });
  let settled = false;
  void page.context.api('status').finally(() => (settled = true));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(page.reloads, [true]);
  assert.equal(page.state.updateReload, true, 'no « Quitter la page ? »');
  assert.equal(settled, false, 'what asked waits: the page goes');
  const kept = JSON.parse(page.kept.get(page.context.RESUME));
  assert.equal(kept.prompt, 'Un brouillon');
  assert.equal(kept.title, 'Une conversation');
  assert.equal(kept.view, 'chat');
  // Not in the history: its messages go with it.
  assert.deepEqual(kept.messages, []);
});
