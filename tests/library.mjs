import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { filtered, mediaOf, setupLibrary } from '../public/library.mjs';
import { deleteWords, montageWords } from '../public/take-delete.mjs';
import { setupProjectNavigation } from '../public/project-navigation.mjs';
import { createApplication } from '../server.mjs';
import { Gallery } from '../lib/gallery.mjs';
import { newMontage } from '../lib/montages.mjs';
import { STUDIO_ID } from '../lib/studio.mjs';

class Element {
  constructor(tag = '', className = '', textContent = '') {
    Object.assign(this, { tag, className, textContent, children: [], dataset: {}, attributes: {}, hidden: false, value: '', style: {} });
    // The classes it gains and loses while shown (« is-playing » on the button of a sound).
    const marks = (this.marks = new Set());
    this.classList = { add: name => marks.add(name), remove: name => marks.delete(name) };
  }
  append(...items) {
    for (const item of items) if (item instanceof Element) item.parent = this;
    this.children.push(...items);
  }
  replaceChildren(...items) {
    for (const item of items) if (item instanceof Element) item.parent = this;
    this.children = items;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  // What the fil and its menus ask of an element (project-navigation.mjs).
  addEventListener() {}
  querySelector() {
    return null;
  }
  contains(other) {
    return walk(this).includes(other);
  }
  getBoundingClientRect() {
    return { left: 36, top: 90, right: 180, bottom: 123, width: 144, height: 33 };
  }
  // Out of the element it was in (the question of a take, answered).
  remove() {
    this.removed = true;
    if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this);
  }
  // The element that has the focus last (after a take deleted, the one after it).
  focus() {
    Element.focused = this;
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
}
const walk = element => [element, ...element.children.flatMap(walk)];
const find = (element, className) => walk(element).find(item => item.className === className);
const tiles = element => walk(element).filter(item => item.className?.startsWith?.('library-tile')).map(item => item.dataset.id);
// A project chosen in the fil of the Pellicule (its menu calls `choose`, see the test of the fil below).
const project = (f, id) => ({ onclick: () => f.library.choose({ project: id }) });
const card = (f, id) => walk(f.$('library-grid')).find(item => item.className?.startsWith?.('library-tile') && item.dataset.id === id);

const PROJECTS = [
  { id: 'inbox', name: 'Conversations' },
  { id: 'p1', name: 'Voyage' },
];
const HISTORY = [
  { id: 'c1', title: 'Plage', projectId: 'p1', createdAt: '2026-11-14T10:00:00.000Z' },
  { id: 'c2', title: 'Idées', projectId: 'inbox', createdAt: '2026-11-13T10:00:00.000Z' },
];
const output = (conversation, id, extra = {}) => ({ originalUrl: `/media/generated/${conversation}/${id}/0?key=k`, ...extra });
// As the server sends them: the newest first, each with its project.
const RUNS = [
  {
    id: 'r1',
    conversationId: 'c1',
    projectId: 'p1',
    prompt: 'Une plage',
    createdAt: '2026-11-14T10:00:00.000Z',
    outputs: [output('c1', 'r1', { thumbUrl: '/media/thumbnail/r1' })],
  },
  {
    id: 'r2',
    conversationId: 'c2',
    projectId: 'inbox',
    mediaType: 'video',
    prompt: 'Un clip',
    // (0.6.141) A clip continued: 121 frames, then 232 more. Its file plays 14,71 s; the 241 frames it
    // generated, overlap included, read « 10.04 S ».
    parameters: { frames: 241, fps: 24, continuation: { overlapFrames: 9, sourceFrames: 121, newFrames: 232 } },
    outputs: [output('c2', 'r2')],
  },
  { id: 'r3', conversationId: 'open', projectId: 'p1', mediaType: 'audio', prompt: 'Des vagues', outputs: [output('open', 'r3')] },
  { id: 'r4', conversationId: STUDIO_ID, projectId: 'inbox', legacy: true, prompt: '', outputs: [output(STUDIO_ID, 'r4')] },
];

function fixture({ runs = RUNS, historyItems = HISTORY, fail = '', conversationId = 'open', ...more } = {}) {
  const nodes = new Map(),
    $ = id => {
      if (!nodes.has(id)) nodes.set(id, new Element('', id));
      return nodes.get(id);
    };
  const state = { projects: [...PROJECTS], historyItems, conversationId, projectId: 'p1' },
    asked = [],
    viewed = [],
    opened = [],
    created = [],
    filters = [];
  const library = setupLibrary({
    $,
    state,
    node: (...args) => new Element(...args),
    icon: name => new Element('svg', 'icon-' + name),
    api: async route => {
      asked.push(route);
      if (fail) throw new Error(fail);
      return Response.json({ runs });
    },
    viewOutput: (record, index) => viewed.push([record.id, index]),
    openConversation: id => opened.push(id),
    newConversation: id => created.push(id),
    onFilter: filter => filters.push(filter),
    ...more,
  });
  return { library, $, state, asked, viewed, opened, created, filters };
}

test('a creation is of its media type, or of what its file says; the filters keep a project, a kind, a conversation', () => {
  assert.equal(mediaOf({ mediaType: 'video' }), 'video');
  assert.equal(mediaOf({ mediaType: 'audio' }), 'audio');
  assert.equal(mediaOf({ outputs: [{ source: { mime: 'video/webm' } }] }), 'video');
  assert.equal(mediaOf({ outputs: [{ mime: 'audio/flac' }] }), 'audio');
  assert.equal(mediaOf({ outputs: [{}] }), 'image');
  const runs = [
    { id: 'a', projectId: 'p1', conversationId: 'c1' },
    { id: 'b', projectId: 'inbox', conversationId: 'c2', mediaType: 'video' },
    // Without a project: « Sans projet » (0.6.0).
    { id: 'c', conversationId: 'c3', mediaType: 'audio' },
  ];
  assert.deepEqual(filtered(runs).map(run => run.id), ['a', 'b', 'c']);
  assert.deepEqual(filtered(runs, { project: 'inbox' }).map(run => run.id), ['b', 'c']);
  assert.deepEqual(filtered(runs, { media: 'video' }).map(run => run.id), ['b']);
  assert.deepEqual(filtered(runs, { conversation: 'c1' }).map(run => run.id), ['a']);
  assert.deepEqual(filtered(runs, { project: 'p1', media: 'video' }), []);
});

test('every project: each creation with its project and its conversation; a click shows it, another opens its chat', async () => {
  const f = fixture();
  await f.library.show();
  // The open conversation is asked for too, even before it is saved.
  assert.deepEqual(f.asked, ['library?images=0&conversation=open&project=p1']);
  const grid = f.$('library-grid');
  assert.deepEqual(tiles(grid), ['r1', 'r2', 'r3', 'r4']);
  assert.equal(f.$('library-total').textContent, '4 prises');
  assert.equal(f.$('library-empty').hidden, true);
  // The numbers the menus of the fil say: every project, each project (« Sans projet » too).
  assert.deepEqual([f.library.count(), f.library.count({ project: 'p1' }), f.library.count({ project: 'inbox' })], [4, 2, 2]);
  // The sheet by day: the line of a day, then its takes; those without a date together.
  assert.deepEqual(
    grid.children.map(day => find(day, 'library-day-count').textContent),
    ['1', '3'],
  );
  assert.match(find(grid.children[0], 'library-day-label').textContent, /14 nov\.$/);
  assert.equal(find(grid.children[1], 'library-day-label').textContent, 'Sans date');
  const [image, clip, sound, before] = walk(grid).filter(item => item.className?.startsWith?.('library-tile'));
  // The picture alone (0.5.126); over its foot, under the pointer or the focus: its prompt (for the
  // eyes: the label of the picture says it all), where it was made and when.
  assert.deepEqual(
    image.children.map(item => item.className),
    ['library-pick', 'library-veil'],
  );
  const veil = find(image, 'library-veil');
  assert.equal(find(veil, 'library-prompt').textContent, 'Une plage');
  assert.equal(find(veil, 'library-prompt').attributes['aria-hidden'], 'true');
  assert.deepEqual(
    find(veil, 'library-meta').children.map(item => [item.className, item.textContent]),
    [
      ['library-from', 'Voyage · Plage'],
      ['library-dot', '·'],
      ['library-date', '14 nov.'],
    ],
  );
  assert.equal(find(image, 'library-pick').attributes['aria-label'], 'Image · Une plage · Voyage · Plage · 14 nov.');
  assert.equal(find(sound, 'library-from').textContent, 'Voyage · Nouvelle conversation', 'the open one, not saved yet');
  // The Studio of before had no conversation: « Sans conversation », and nothing to open.
  assert.equal(find(before, 'library-from').tag, 'span');
  assert.equal(find(before, 'library-from').textContent, 'Sans conversation');
  // The picture: its thumbnail; the first frame of a clip and its length alone; a sound, a card that
  // plays (« PRISE n » and its kind, its stripes, ▶, its name and its length).
  assert.equal(walk(image).find(item => item.tag === 'img').src, '/media/thumbnail/r1');
  assert.equal(walk(clip).find(item => item.tag === 'video').src, '/media/generated/c2/r2/0?key=k#t=0.1');
  assert.equal(find(clip, 'library-length').textContent, '14.71 S');
  assert.equal(find(image, 'library-length'), undefined);
  assert.ok(find(sound, 'library-wave'));
  assert.deepEqual(find(sound, 'library-sound-head').children.map(item => item.textContent), ['SON', 'BRUITAGE']);
  assert.equal(find(sound, 'library-sound-name').textContent, 'Des vagues');
  assert.ok(find(sound, 'library-listen'));
  assert.equal(find(clip, 'library-pick').attributes['aria-label'], 'Clip · Un clip · Sans projet · Idées');
  find(image, 'library-pick').onclick();
  assert.deepEqual(f.viewed, [['r1', 0]]);
  find(clip, 'library-from').onclick();
  assert.deepEqual(f.opened, ['c2']);
});

test('on a project: its takes, its conversations counted, one of them chosen, then all of them again', async () => {
  const f = fixture();
  await f.library.show({ project: 'p1' });
  assert.equal(f.$('library-total').textContent, '2 prises');
  assert.deepEqual(f.library.filter(), { project: 'p1', media: 'all', conversation: 'all' });
  // Each conversation with its number of takes; the open one, not saved yet, has its own.
  assert.deepEqual(
    [f.library.count({ project: 'p1', conversation: 'c1' }), f.library.count({ project: 'p1', conversation: 'open' })],
    [1, 1],
  );
  f.library.choose({ conversation: 'c1' });
  assert.deepEqual(tiles(f.$('library-grid')), ['r1']);
  assert.equal(f.$('library-total').textContent, '1 prise');
  assert.deepEqual(f.filters.at(-1), { project: 'p1', media: 'all', conversation: 'c1' });
  assert.deepEqual(f.opened, [], 'the Chat does not open');
  // Its creations only, the open conversation's among them, without the project in their line.
  f.library.choose({ conversation: 'all' });
  assert.deepEqual(tiles(f.$('library-grid')), ['r1', 'r3']);
  assert.equal(find(f.$('library-grid'), 'library-from').textContent, 'Plage');
  // A conversation of another project is not one of this one: all of them again.
  f.library.choose({ conversation: 'c2' });
  assert.equal(f.library.filter().conversation, 'all');
});

/**
 * The fil of the Chat and the Studio heading the Pellicule (pellicule-fil-maquette.md, captures 35
 * to 39): the module of the fil itself, on the Pellicule itself.
 */
function filFixture(t, options = {}) {
  const f = fixture({ historyItems: HISTORY_FIL, ...options }),
    previous = [globalThis.document, globalThis.window],
    menus = [],
    calls = [];
  globalThis.document = {
    body: { dataset: {}, append: element => menus.push(element) },
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window = { innerWidth: 1280, innerHeight: 720, addEventListener() {}, removeEventListener() {} };
  t.after(() => ([globalThis.document, globalThis.window] = previous));
  Object.assign(f.state, { view: 'library', saveHistory: true, status: {}, messages: [] });
  f.$('conversation-title').textContent = 'Nouvelle conversation';
  const fil = setupProjectNavigation({
    $: f.$,
    state: f.state,
    node: (...args) => new Element(...args),
    icon: name => new Element('svg', 'icon-' + name),
    api: async () => Response.json({}),
    openConversation: id => calls.push(['open', id]),
    newConversation: id => calls.push(['new', id]),
    removeConversation: item => calls.push(['delete', item.id]),
  });
  fil.useLibrary(f.library);
  // As app.js: the Pellicule filtered, the fil says it.
  f.filters.push = filter => fil.render(filter);
  const open = id => (f.$(id).onclick(), menus.at(-1));
  const lines = menu =>
    walk(menu)
      .filter(item => /^thread-line(\s|$)/.test(item.className))
      .map(line => ({
        name: walk(line).find(item => item.className === 'thread-choice-name').textContent,
        count: walk(line).find(item => item.className === 'thread-choice-count')?.textContent,
        current: line.className.includes('is-current'),
        tools: walk(line)
          .filter(item => /^thread-tool(\s|$)/.test(item.className ?? ''))
          .map(item => item.dataset.tip),
        choose: () => walk(line).find(item => item.className === 'thread-choice').onclick(),
        tool: tip => walk(line).find(item => item.dataset.tip === tip).onclick(),
      }));
  const said = () => [
    f.$('thread').dataset.scope,
    f.$('thread-project-name').textContent,
    f.$('thread-shown').textContent,
    f.$('library-total').textContent,
  ];
  return { ...f, fil, calls, menus, open, lines, said };
}
const HISTORY_FIL = [
  ...HISTORY,
  // Another conversation of the project with a take, one without any.
  { id: 'c3', title: 'Croquis', projectId: 'p1', createdAt: '2026-11-15T10:00:00.000Z' },
  { id: 'c4', title: 'Sans prise', projectId: 'p1', createdAt: '2026-11-16T10:00:00.000Z' },
];
const RUNS_FIL = [{ id: 'r5', conversationId: 'c3', projectId: 'p1', prompt: 'Un croquis', createdAt: '2026-11-15T10:00:00.000Z', outputs: [output('c3', 'r5')] }, ...RUNS];

test('in the Pellicule, the fil heads the sheet: « Tous les projets » alone, its menu with the takes of each project', async t => {
  const f = filFixture(t, { runs: RUNS_FIL });
  await f.library.show();
  // One link, « Tous les projets », then the number of takes.
  assert.deepEqual(f.said(), ['all', 'Tous les projets', 'Toutes les conversations', '5 prises']);
  assert.equal(f.$('thread').hidden, false);
  assert.equal(f.$('conversation-title').hidden, true, 'the title of the conversation open is kept, not shown');
  assert.equal(f.$('thread-shown').hidden, false);
  // Capture 36: « Tous les projets » first, the projects and « Sans projet » with their takes; the
  // pencil and the bin on a project only; « + Nouveau projet » at the foot.
  const menu = f.open('thread-project');
  assert.deepEqual(
    f.lines(menu).map(line => [line.name, line.count, line.current, line.tools]),
    [
      ['Tous les projets', '5', true, []],
      ['Voyage', '3', false, ['Renommer', 'Supprimer']],
      ['Sans projet', '2', false, []],
    ],
  );
  assert.equal(walk(menu).filter(item => item.className === 'thread-lines').length, 1, 'the projects scroll');
  assert.deepEqual(walk(menu.children.at(-1)).map(item => item.textContent).filter(Boolean), ['Nouveau projet']);
  // A project chosen: « Voyage / Toutes les conversations », its takes; nothing opens.
  f.lines(menu)[1].choose();
  assert.deepEqual(f.said(), ['project', 'Voyage', 'Toutes les conversations', '3 prises']);
  assert.deepEqual(tiles(f.$('library-grid')), ['r5', 'r1', 'r3']);
  assert.deepEqual(f.calls, []);
  assert.equal(f.state.projectId, 'p1', 'the project of the conversation open is not changed');
  // Back to every project from the first line.
  f.lines(f.open('thread-project'))[0].choose();
  assert.deepEqual(f.said(), ['all', 'Tous les projets', 'Toutes les conversations', '5 prises']);
});

test('in the Pellicule, a conversation chosen in the fil filters the takes and does not open the Chat', async t => {
  const f = filFixture(t, { runs: RUNS_FIL });
  await f.library.show({ project: 'p1' });
  assert.deepEqual(f.said(), ['project', 'Voyage', 'Toutes les conversations', '3 prises']);
  // Capture 38: « Toutes les conversations » first, then those that made takes, each with its number
  // (the one without a take is not there), the pencil and the bin; « + Nouvelle conversation » at the foot.
  const menu = f.open('thread-conversation');
  assert.equal(menu.attributes['aria-label'], 'Conversations · Voyage');
  assert.deepEqual(
    f.lines(menu).map(line => [line.name, line.count, line.current, line.tools]),
    [
      ['Toutes les conversations', '3', true, []],
      ['Croquis', '1', false, ['Renommer ou déplacer', 'Supprimer']],
      ['Plage', '1', false, ['Renommer ou déplacer', 'Supprimer']],
    ],
  );
  assert.equal(walk(menu).some(item => item.tag === 'input'), false, 'no search here');
  f.lines(menu)[2].choose();
  // The takes of « Plage » only; the fil says it; the Chat is not opened.
  assert.deepEqual(tiles(f.$('library-grid')), ['r1']);
  assert.deepEqual(f.said(), ['project', 'Voyage', 'Plage', '1 prise']);
  assert.deepEqual(f.library.filter(), { project: 'p1', media: 'all', conversation: 'c1' });
  assert.deepEqual(f.calls, []);
  assert.equal(f.state.view, 'library');
  assert.equal(f.$('thread-conversation').attributes['aria-label'], 'Conversation : Plage');
  // Marked in its menu; the kind narrows it further, its number follows.
  assert.deepEqual(
    f.lines(f.open('thread-conversation')).filter(line => line.current).map(line => line.name),
    ['Plage'],
  );
  f.library.choose({ media: 'video' });
  assert.deepEqual(tiles(f.$('library-grid')), []);
  assert.deepEqual(
    f.lines(f.open('thread-conversation')).map(line => [line.name, line.count]),
    [
      ['Toutes les conversations', '0'],
      ['Croquis', '0'],
      ['Plage', '0'],
    ],
  );
  f.library.choose({ media: 'all' });
  // Its pencil opens the window of the conversation (rename or move), its bin asks first.
  f.lines(f.open('thread-conversation'))[1].tool('Renommer ou déplacer');
  assert.equal(f.$('conversation-dialog').open, true);
  assert.equal(f.$('conversation-name').value, 'Croquis');
  f.lines(f.open('thread-conversation'))[1].tool('Supprimer');
  assert.deepEqual(f.calls, [['delete', 'c3']]);
  // « Toutes les conversations » again; « + Nouvelle conversation » asks for the welcome in the project.
  f.lines(f.open('thread-conversation'))[0].choose();
  assert.deepEqual(f.said(), ['project', 'Voyage', 'Toutes les conversations', '3 prises']);
  const create = f.open('thread-conversation').children.at(-1);
  assert.equal(create.className, 'thread-action');
  create.onclick();
  assert.deepEqual(f.calls.at(-1), ['new', 'p1']);
  // Another project: every conversation of it.
  f.lines(f.open('thread-conversation'))[1].choose();
  f.lines(f.open('thread-project'))[2].choose();
  assert.deepEqual(f.said(), ['project', 'Sans projet', 'Toutes les conversations', '2 prises']);
});

test('back in the Chat, the fil is that of the conversation open again, its menus as before', async t => {
  const f = filFixture(t, { runs: RUNS_FIL });
  await f.library.show({ project: 'inbox' });
  f.state.view = 'chat';
  f.fil.render();
  assert.equal(f.$('thread').dataset.scope, '');
  assert.equal(f.$('thread-project-name').textContent, 'Voyage', 'the project of the conversation open');
  assert.equal(f.$('conversation-title').hidden, false);
  assert.equal(f.$('thread-shown').hidden, true);
  const menu = f.open('thread-conversation');
  assert.equal(walk(menu).some(item => item.tag === 'input'), true, 'the search of the Chat');
  assert.equal(walk(menu).some(item => item.className === 'thread-choice-count'), false);
  // A conversation chosen here opens it.
  f.lines(menu)[0].choose();
  assert.deepEqual(f.calls, [['open', 'c4']]);
});

test('the kind and the conversation narrow the creations; ← → move between the kinds; a project keeps the kind', async () => {
  const f = fixture();
  await f.library.show();
  const kinds = f.$('library-kinds'),
    kind = id => kinds.children.find(item => item.dataset.kind === id);
  assert.deepEqual(
    kinds.children.map(item => [item.dataset.kind, item.attributes.role, item.attributes['aria-checked'], item.tabIndex]),
    [
      ['all', 'radio', 'true', 0],
      ['image', 'radio', 'false', -1],
      ['video', 'radio', 'false', -1],
      ['audio', 'radio', 'false', -1],
      ['bobine', 'radio', 'false', -1],
    ],
  );
  assert.deepEqual(kinds.children.map(item => item.children[1].textContent), ['Tout', 'Images', 'Vidéos', 'Sons', 'Bobines']);
  kind('video').onclick();
  assert.deepEqual(tiles(f.$('library-grid')), ['r2']);
  assert.equal(kind('video').attributes['aria-checked'], 'true');
  assert.deepEqual(f.filters.at(-1), { project: 'all', media: 'video', conversation: 'all' });
  // The numbers of the projects follow the kind.
  assert.deepEqual([f.library.count(), f.library.count({ project: 'p1' }), f.library.count({ project: 'inbox' })], [1, 0, 1]);
  assert.equal(f.library.count({ project: 'p1', media: 'all' }), 2, 'or the kind asked');
  kinds.onkeydown({ key: 'ArrowRight', preventDefault() {} });
  assert.deepEqual(tiles(f.$('library-grid')), ['r3']);
  // (0.6.154) Then the bobines (none put in the Archives here), and after them the first.
  kinds.onkeydown({ key: 'ArrowRight', preventDefault() {} });
  assert.deepEqual([tiles(f.$('library-grid')), f.$('library-total').textContent], [[], '0 bobine']);
  kinds.onkeydown({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(tiles(f.$('library-grid')).length, 4, 'after the last, the first');
  kinds.onkeydown({ key: 'ArrowLeft', preventDefault() {} });
  kinds.onkeydown({ key: 'ArrowLeft', preventDefault() {} });
  assert.deepEqual(tiles(f.$('library-grid')), ['r3']);
  kind('image').onclick();
  assert.deepEqual(tiles(f.$('library-grid')), ['r1', 'r4']);
  project(f, 'p1').onclick();
  assert.deepEqual(tiles(f.$('library-grid')), ['r1']);
  f.library.choose({ conversation: 'c1' });
  assert.deepEqual(tiles(f.$('library-grid')), ['r1']);
  kind('audio').onclick();
  assert.deepEqual(tiles(f.$('library-grid')), []);
  assert.equal(f.$('library-empty').hidden, false);
  assert.equal(f.$('library-empty').children[0].textContent, 'Aucune création de ce type ici.');
  // Another project: its conversation forgotten, the kind kept.
  project(f, 'inbox').onclick();
  assert.deepEqual(f.filters.at(-1), { project: 'inbox', media: 'audio', conversation: 'all' });
  // Shown again from the sidebar: everything again.
  await f.library.show({ project: 'inbox' });
  assert.deepEqual(f.library.filter(), { project: 'inbox', media: 'all', conversation: 'all' });
  assert.deepEqual(tiles(f.$('library-grid')), ['r2', 'r4']);
});

test('a sound plays in its card, and stops when its card leaves the sheet', async () => {
  const sounds = [];
  const f = fixture({
    node: (tag, ...rest) => {
      const element = new Element(tag, ...rest);
      if (tag !== 'audio') return element;
      sounds.push(element);
      return Object.assign(element, {
        paused: true,
        play() {
          this.paused = false;
          return Promise.resolve();
        },
        pause() {
          this.paused = true;
        },
      });
    },
  });
  await f.library.show();
  const kinds = f.$('library-kinds'),
    kind = id => kinds.children.find(item => item.dataset.kind === id),
    listen = () => find(card(f, 'r3'), 'library-listen');
  listen().onclick();
  assert.equal(sounds.length, 1);
  assert.equal(sounds[0].paused, false);
  assert.ok(listen().marks.has('is-playing'));
  // Still on the sheet under another filter (its project, the sounds alone): it plays on.
  project(f, 'p1').onclick();
  kind('audio').onclick();
  assert.equal(sounds[0].paused, false);
  // Another kind: its card is gone, and nothing on screen could stop it any more. It stops.
  kind('image').onclick();
  assert.deepEqual(tiles(f.$('library-grid')), ['r1']);
  assert.equal(sounds[0].paused, true);
  // Back among the sounds: its button is a ▶ again, and plays it from a new start.
  kind('audio').onclick();
  assert.ok(!listen().marks.has('is-playing'));
  listen().onclick();
  assert.equal(sounds.length, 2);
  assert.equal(sounds[1].paused, false);
  // Another project, where it is not: stopped too. Leaving the Pellicule stops it as before.
  project(f, 'inbox').onclick();
  assert.equal(sounds[1].paused, true);
  f.library.hush();
});

test('a creation of a conversation never saved says so, and opens nothing', async () => {
  const f = fixture({
    runs: [{ id: 'u1', conversationId: 'gone', projectId: 'inbox', unsaved: true, prompt: 'Un renard', outputs: [output('gone', 'u1')] }],
  });
  await f.library.show();
  const from = find(f.$('library-grid'), 'library-from');
  assert.equal(from.tag, 'span');
  assert.equal(from.textContent, 'Conversation non enregistrée');
  assert.equal(from.onclick, undefined);
});

test('the tiles are kept from one drawing to the next: their pictures are not loaded again', async () => {
  const f = fixture();
  await f.library.show();
  const first = card(f, 'r1');
  project(f, 'p1').onclick();
  assert.equal(card(f, 'r1'), first);
  assert.equal(find(first, 'library-from').textContent, 'Plage', 'its line follows the filter');
  await f.library.refresh();
  assert.equal(card(f, 'r1'), first, 'the same creation read again');
  find(first, 'library-pick').onclick();
  assert.deepEqual(f.viewed, [['r1', 0]]);
});

test('a project gone shows every project again; an empty project offers one way to begin; an error is said', async () => {
  const f = fixture({ runs: [], conversationId: null });
  await f.library.show({ project: 'p1' });
  // No conversation open: only the saved ones.
  assert.deepEqual(f.asked, ['library?images=0']);
  // A project with nothing in it (capture 39): its sentence, a line, « + Nouvelle conversation » alone.
  const empty = f.$('library-empty');
  assert.equal(empty.hidden, false);
  assert.equal(f.$('library-total').textContent, '0 prise');
  assert.deepEqual(
    empty.children.map(item => item.className),
    ['library-empty-title', 'library-empty-text', 'library-door'],
  );
  assert.equal(empty.children[0].textContent, 'Rien dans ce projet pour l’instant.');
  const begin = empty.children[2];
  assert.deepEqual(begin.children.map(item => item.className || item.textContent), ['icon-plus', 'Nouvelle conversation']);
  assert.equal(begin.attributes['aria-label'], 'Nouvelle conversation dans Voyage');
  begin.onclick();
  assert.deepEqual(f.created, ['p1']);
  f.state.projects = f.state.projects.filter(item => item.id !== 'p1');
  f.library.render();
  assert.equal(f.library.filter().project, 'all');
  assert.deepEqual(f.filters.at(-1), { project: 'all', media: 'all', conversation: 'all' });
  assert.match(f.$('library-empty').children[0].textContent, /^Aucune création pour l’instant\. Les images, vidéos et sons/);
  const broken = fixture({ fail: 'Disque illisible.' });
  await broken.library.show();
  assert.equal(broken.$('library-empty').hidden, false);
  assert.equal(broken.$('library-empty').children[0].textContent, 'Archives illisibles : Disque illisible.');
});

test('GET /api/library: the creations of every project, each with its own, the open one, those never saved and those of before', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'atelier-library-')),
    historyDir = join(folder, 'history');
  let app;
  try {
    app = await createApplication({ port: 0, dataDir: folder, historyDir });
    const token = (await (await fetch(`${app.url}/api/bootstrap`)).json()).token;
    const call = (route, body) =>
      fetch(`${app.url}/api/${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    assert.equal((await call('preferences', { saveHistory: true })).status, 200);
    const project = (await (await call('projects/save', { name: 'Voyage' })).json()).project;
    // `orphan`: a conversation never saved (a creation of the Studio before any message).
    const [trip, idea, open, orphan] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const said = content => [{ role: 'user', content }];
    assert.equal((await call('history/save', { id: trip, projectId: project.id, messages: said('Une plage') })).status, 200);
    assert.equal((await call('history/save', { id: idea, messages: said('Une idée') })).status, 200);
    const gallery = new Gallery({ historyDir }),
      made = {};
    for (const [name, conversationId, createdAt, mediaType] of [
      ['orphan', orphan, '2026-11-09T10:00:00.000Z', 'image'],
      ['before', STUDIO_ID, '2026-11-10T10:00:00.000Z', 'image'],
      ['trip', trip, '2026-11-11T10:00:00.000Z', 'image'],
      ['idea', idea, '2026-11-12T10:00:00.000Z', 'video'],
      ['open', open, '2026-11-13T10:00:00.000Z', 'audio'],
    ]) {
      made[name] = randomUUID();
      await gallery.put(
        {
          id: made[name],
          conversationId,
          provider: 'native',
          mediaType,
          workflowId: 'basic',
          workflowName: 'Basic',
          prompt: 'Prompt ' + name,
          parameters: {},
          createdAt,
          outputs: [{ source: { filename: name + '.png', subfolder: '', type: 'output' } }],
        },
        { persist: true },
      );
    }
    const library = async query => (await (await call('library' + query)).json()).runs;
    const listed = await library(`?images=0&conversation=${open}&project=${project.id}`);
    assert.deepEqual(
      listed.map(run => [run.id, run.projectId, run.legacy === true, run.unsaved === true]),
      [
        [made.open, project.id, false, false],
        [made.idea, 'inbox', false, false],
        [made.trip, project.id, false, false],
        [made.before, 'inbox', true, false],
        [made.orphan, 'inbox', false, true],
      ],
      'the newest first, each with its project',
    );
    assert.match(listed[0].outputs[0].originalUrl, new RegExp(`^/media/generated/${open}/${made.open}/0\\?key=`));
    assert.equal(listed[0].mediaType, 'audio');
    // Not said open: the conversation of the open one, never saved, is one of those never saved.
    assert.deepEqual(
      (await library('?images=0')).map(run => [run.id, run.unsaved === true]),
      [
        [made.open, true],
        [made.idea, false],
        [made.trip, false],
        [made.before, false],
        [made.orphan, true],
      ],
    );
    assert.equal((await call('library?conversation=' + open + '&project=..')).status, 400, 'an invalid project');
    // Without the history: the open one and those of before.
    assert.equal((await call('preferences', { saveHistory: false })).status, 200);
    assert.deepEqual(
      (await library(`?images=0&conversation=${open}&project=inbox`)).map(run => [run.id, run.projectId]),
      [
        [made.open, 'inbox'],
        [made.before, 'inbox'],
      ],
    );
    assert.equal((await fetch(`${app.url}/api/library`)).status, 401, 'not without the key of the page');
  } finally {
    await app?.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('(0.6.147) the question of a take: its number, else what it is; the montages that use it', () => {
  assert.equal(deleteWords({ outputs: [{ take: 12 }] }, 'image'), 'Supprimer #12\u00a0?');
  // Without a number of take: the one it is shown with (the Studio), else what it is.
  assert.equal(deleteWords({ outputs: [{}] }, 'video', 3), 'Supprimer #3\u00a0?');
  assert.deepEqual(
    ['image', 'video', 'audio', undefined].map(media => deleteWords({ outputs: [{}] }, media)),
    ['Supprimer cette image\u00a0?', 'Supprimer ce clip\u00a0?', 'Supprimer ce son\u00a0?', 'Supprimer cette création\u00a0?'],
  );
  assert.equal(montageWords(undefined), '');
  assert.equal(montageWords([]), '');
  assert.equal(montageWords(['Le pêcheur']), 'Elle sert dans la bobine « Le pêcheur »');
  assert.equal(montageWords(['Bis', 'Le pêcheur']), 'Elle sert dans 2 bobines : « Bis », « Le pêcheur »');
  // On a take too small for their names (the Sortie of the Studio).
  assert.deepEqual([montageWords(['Le pêcheur'], true), montageWords(['Bis', 'Le pêcheur'], true), montageWords([], true)], [
    'Dans une bobine',
    'Dans 2 bobines',
    '',
  ]);
});

test('(0.6.147) every take has the bin of the Studio: asked on the take, ✕ and Échap keep it, the light bin deletes it by the Studio’s deletion', async () => {
  // Takes of every kind, of a conversation never saved and of the Studio of before too.
  const list = [
      { ...RUNS[0], outputs: [output('c1', 'r1', { take: 12 })], montages: ['Le pêcheur'] },
      { ...RUNS[1], outputs: [output('c2', 'r2', { take: 3 })] },
      { ...RUNS[2], outputs: [output('open', 'r3', { take: 4 })] },
      RUNS[3],
      { id: 'u1', conversationId: 'gone', projectId: 'inbox', unsaved: true, prompt: 'Un renard', outputs: [output('gone', 'u1')] },
    ],
    removed = [],
    notices = [];
  let answer = true,
    why = '';
  const f = fixture({
    runs: list,
    remove: async record => {
      removed.push([record.id, record.conversationId]);
      // Gone from the server: no longer listed.
      if (answer) list.splice(list.findIndex(run => run.id === record.id), 1);
      return answer;
    },
    busy: () => why,
    notice: text => notices.push(text),
  });
  await f.library.show();
  const bin = id => find(card(f, id), 'library-del'),
    asked = id => find(card(f, id), 'studio-item-confirm'),
    open = () => walk(f.$('library-grid')).filter(item => item.className === 'studio-item-confirm'),
    answered = () => new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(
    ['r1', 'r2', 'r3', 'r4', 'u1'].map(id => [bin(id).attributes['aria-label'], bin(id).attributes['aria-disabled']]),
    [
      ['Supprimer · Image #12', 'false'],
      ['Supprimer · Clip #3', 'false'],
      ['Supprimer · Son #4', 'false'],
      ['Supprimer · Image', 'false'],
      ['Supprimer · Image', 'false'],
    ],
  );
  assert.equal(bin('r1').title, 'Supprimer de sa conversation (le fichier reste dans le dossier output)');
  assert.equal(bin('r1').children[0].className, 'icon-trash');
  // The question of the Studio, on the take: its number, the montage that uses it, ✕ and the light bin.
  bin('r1').onclick();
  const ask = asked('r1');
  assert.equal(ask.attributes.role, 'alertdialog');
  assert.deepEqual(
    ask.children.map(item => [item.className, item.textContent]),
    [
      ['studio-confirm-text', 'Supprimer #12\u00a0?'],
      ['studio-confirm-note', 'Elle sert dans la bobine « Le pêcheur »'],
      ['studio-confirm-row', ''],
    ],
  );
  assert.deepEqual(
    find(ask, 'studio-confirm-row').children.map(item => [item.className, item.children[0].className]),
    [
      ['studio-confirm-no', 'icon-close'],
      ['studio-confirm-yes', 'icon-trash'],
    ],
  );
  // One at a time: another bin closes it.
  bin('r2').onclick();
  assert.deepEqual(open().map(item => item.parent.dataset.id), ['r2']);
  assert.equal(find(asked('r2'), 'studio-confirm-text').textContent, 'Supprimer #3\u00a0?');
  assert.equal(find(asked('r2'), 'studio-confirm-note'), undefined, 'in no montage: no line');
  // ✕ keeps it; Échap too. Without a number: what it is.
  find(asked('r2'), 'studio-confirm-no').onclick();
  assert.deepEqual(open(), []);
  assert.equal(Element.focused, bin('r2'), 'the focus back on its bin');
  bin('r4').onclick();
  assert.equal(find(asked('r4'), 'studio-confirm-text').textContent, 'Supprimer cette image\u00a0?');
  let stopped = 0;
  asked('r4').onkeydown({ key: 'Escape', preventDefault() {}, stopPropagation: () => stopped++ });
  assert.deepEqual([open(), stopped], [[], 1]);
  assert.deepEqual(removed, []);
  // The light bin: the Studio's deletion, then the sheet read again without it.
  const reads = f.asked.length;
  bin('r2').onclick();
  find(asked('r2'), 'studio-confirm-yes').onclick();
  await answered();
  assert.deepEqual(removed, [['r2', 'c2']]);
  assert.deepEqual(open(), []);
  assert.equal(f.asked.length, reads + 1);
  assert.deepEqual(tiles(f.$('library-grid')), ['r1', 'r3', 'r4', 'u1']);
  assert.equal(Element.focused, find(card(f, 'r3'), 'library-pick'), 'the focus on the take after it');
  // One of a conversation never saved goes the same way; the last one: the focus on the one before it.
  bin('u1').onclick();
  find(asked('u1'), 'studio-confirm-yes').onclick();
  await answered();
  assert.deepEqual(removed.at(-1), ['u1', 'gone']);
  assert.deepEqual(tiles(f.$('library-grid')), ['r1', 'r3', 'r4']);
  assert.equal(Element.focused, find(card(f, 'r4'), 'library-pick'));
  // Refused (the Studio says why): the take stays, the sheet is not read again.
  answer = false;
  bin('r4').onclick();
  find(asked('r4'), 'studio-confirm-yes').onclick();
  await answered();
  assert.deepEqual(removed.at(-1), ['r4', STUDIO_ID]);
  assert.equal(f.asked.length, reads + 2);
  assert.deepEqual(tiles(f.$('library-grid')), ['r1', 'r3', 'r4']);
  assert.deepEqual(open(), []);
  // During a generation: greyed, why under the pointer and said when it is pressed; nothing asked.
  why = 'Attendez la fin de la génération en cours pour supprimer.';
  const count = removed.length;
  bin('r1').onclick();
  assert.deepEqual(open(), []);
  assert.deepEqual(notices, [why]);
  assert.equal(bin('r1').attributes['aria-disabled'], 'true');
  assert.equal(bin('r1').title, 'Supprimer de sa conversation (le fichier reste dans le dossier output)\n' + why);
  assert.equal(removed.length, count);
  // Another filter closes a question left open.
  why = '';
  bin('r1').onclick();
  assert.equal(open().length, 1);
  f.library.choose({ media: 'image' });
  assert.deepEqual(open(), []);
});

test('(0.6.147) without the Studio’s deletion given, no bin', async () => {
  const f = fixture();
  await f.library.show();
  assert.equal(walk(f.$('library-grid')).some(item => item.className === 'library-del'), false);
});

test('(0.6.147) GET /api/library and the Sortie: each take with the montages of its project that use it; deleted, it leaves them, its file stays', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'atelier-library-montages-')),
    historyDir = join(folder, 'history');
  let app;
  try {
    app = await createApplication({ port: 0, dataDir: folder, historyDir });
    const token = (await (await fetch(`${app.url}/api/bootstrap`)).json()).token;
    const call = (route, body) =>
      fetch(`${app.url}/api/${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    assert.equal((await call('preferences', { saveHistory: true })).status, 200);
    const talk = randomUUID();
    assert.equal((await call('history/save', { id: talk, messages: [{ role: 'user', content: 'Le pêcheur' }] })).status, 200);
    const gallery = new Gallery({ historyDir }),
      made = {};
    await mkdir(join(folder, 'output'), { recursive: true });
    let minute = 10;
    for (const [name, mediaType] of [
      ['plan', 'image'],
      ['photo', 'image'],
      ['sound', 'audio'],
      ['free', 'image'],
    ]) {
      made[name] = randomUUID();
      await writeFile(join(folder, 'output', name + '.png'), 'fichier');
      await gallery.put(
        {
          id: made[name],
          conversationId: talk,
          provider: 'native',
          mediaType,
          workflowId: 'basic',
          workflowName: 'Basic',
          prompt: 'Prompt ' + name,
          parameters: {},
          createdAt: `2026-11-20T10:${minute++}:00.000Z`,
          outputs: [{ source: { filename: name + '.png', subfolder: '', type: 'output' } }],
        },
        { persist: true },
      );
    }
    const take = name => ({ conversationId: talk, runId: made[name], output: 0 });
    // A plan, the photo it starts on, a sound under it; another montage of the plan twice (said once), changed last.
    const first = {
      ...newMontage({ name: 'Le pêcheur' }),
      plans: [{ id: randomUUID(), kind: 'image', source: take('plan'), from: 0, to: 2, frame: 'fit', photos: { start: take('photo') } }],
      sounds: [{ id: randomUUID(), source: take('sound'), track: 'music', at: 0, from: 0, to: 2, volume: 1 }],
    };
    assert.equal((await call('montages/save', { project: 'inbox', montage: first })).status, 200);
    await new Promise(resolve => setTimeout(resolve, 15));
    const second = {
      ...newMontage({ name: 'Bis' }),
      plans: [
        { id: randomUUID(), kind: 'image', source: take('plan'), from: 0, to: 2, frame: 'fit' },
        { id: randomUUID(), kind: 'image', source: take('plan'), from: 0, to: 2, frame: 'fit' },
      ],
      sounds: [],
    };
    assert.equal((await call('montages/save', { project: 'inbox', montage: second })).status, 200);
    const uses = runs => Object.fromEntries(runs.map(run => [Object.keys(made).find(name => made[name] === run.id), run.montages ?? null]));
    const expected = { free: null, sound: ['Le pêcheur'], photo: ['Le pêcheur'], plan: ['Bis', 'Le pêcheur'] };
    assert.deepEqual(uses((await (await call('library?images=0')).json()).runs), expected);
    assert.deepEqual(uses((await (await call('project-gallery/inbox?images=0')).json()).runs), expected);
    // (0.6.154) « Enregistrer »: the bobine in the Archives, with what its card shows; the other is not there.
    assert.deepEqual((await (await call('library?images=0')).json()).bobines, []);
    assert.equal((await call('montages/save', { project: 'inbox', montage: first, archive: true })).status, 200);
    const [shelved, ...others] = (await (await call('library?images=0')).json()).bobines;
    assert.deepEqual(
      [others, shelved.id, shelved.name, shelved.project, shelved.archived.seconds, shelved.archived.plans, shelved.archived.pictures],
      [[], first.id, 'Le pêcheur', 'inbox', 2, 1, [take('plan')]],
    );
    // « Un fichier par prise » of a bobine with nothing made: refused in the user's words, nothing asked of the engine.
    const waiting = { ...newMontage({ name: 'À faire' }), plans: [{ id: randomUUID(), kind: 'video', todo: { prompt: '' }, from: 0, to: 2 }], sounds: [] };
    assert.equal((await call('montages/save', { project: 'inbox', montage: waiting })).status, 200);
    const refused = await call('montages/export-takes', { project: 'inbox', id: waiting.id });
    assert.deepEqual([refused.status, (await refused.json()).error], [400, 'Aucune prise de cette bobine n’est encore créée.']);
    // The take goes (the route of the Studio, that of the Pellicule): listed nowhere, its file still there.
    assert.equal((await call('studio/delete', { id: made.plan, conversationId: talk })).status, 200);
    assert.equal((await (await call('library?images=0')).json()).runs.some(run => run.id === made.plan), false);
    assert.equal((await (await call('project-gallery/inbox?images=0')).json()).runs.some(run => run.id === made.plan), false);
    await access(join(folder, 'output', 'plan.png'));
    // The montages are untouched: their plan says « Prise introuvable » (public/montage.mjs).
    assert.equal((await (await call(`montages/inbox/${first.id}`)).json()).plans[0].source.runId, made.plan);
  } finally {
    await app?.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('(0.6.154) the bobines put in the Archives: among the takes at their date, a card of their own; « Bobines » shows them alone; a click opens one', async () => {
  // (Capture 92.)
  const bobines = [
      {
        id: 'b1',
        name: 'Le renard en hiver',
        format: '16:9',
        project: 'p1',
        archived: { at: '2026-11-14T12:00:00.000Z', seconds: 22.04, plans: 7, pictures: [{ conversationId: 'c1', runId: 'r1', output: 0 }, { conversationId: 'c9', runId: 'gone', output: 0 }] },
      },
      { id: 'b2', name: 'Le phare', format: '9:16', project: 'inbox', archived: { at: '2026-11-15T09:00:00.000Z', seconds: 4, plans: 1, pictures: [] } },
    ],
    wanted = [];
  const f = fixture({ api: async () => Response.json({ runs: RUNS, bobines }), openBobine: asked => wanted.push(asked) });
  await f.library.show();
  const grid = f.$('library-grid');
  // At the date they were put there, the newest first; not counted as takes.
  assert.deepEqual([tiles(grid), f.$('library-total').textContent], [['b2', 'b1', 'r1', 'r2', 'r3', 'r4'], '4 prises']);
  const reel = card(f, 'b1');
  assert.deepEqual([reel.className, reel.dataset.media], ['library-tile is-bobine', 'bobine']);
  // A strip with the pictures of its first takes (a take gone: an empty place), « BOBINE », its name, its length and takes.
  const strip = find(reel, 'library-reel');
  assert.deepEqual(strip.children.map(cell => [cell.tag, cell.className, cell.src ?? null]), [
    ['img', '', '/media/thumbnail/r1'],
    ['span', 'library-reel-blank', null],
  ]);
  assert.deepEqual(find(reel, 'library-reel-said').children.map(part => [part.className, part.textContent]), [
    ['library-reel-label', 'Bobine'],
    ['library-reel-name', 'Le renard en hiver'],
    ['library-reel-meta', '22.04 S · 7 prises'],
  ]);
  const pick = find(reel, 'library-pick');
  assert.match(pick.attributes['aria-label'], /^Bobine Le renard en hiver · 22\.04 S · 7 prises · enregistrée le 14 nov\. · l’ouvrir dans la Bobine$/);
  assert.deepEqual(find(card(f, 'b2'), 'library-reel').children.map(cell => cell.className), ['library-reel-blank']);
  // A click opens it again in the Bobine, in its project.
  pick.onclick();
  assert.deepEqual(wanted, [{ project: 'p1', id: 'b1' }]);
  // « Bobines »: they alone, counted as bobines; of a project, of none in a conversation.
  const kind = id => f.$('library-kinds').children.find(item => item.dataset.kind === id);
  kind('bobine').onclick();
  assert.deepEqual([tiles(grid), f.$('library-total').textContent], [['b2', 'b1'], '2 bobines']);
  assert.deepEqual([f.library.count(), f.library.count({ project: 'p1' }), f.library.count({ conversation: 'c1' })], [2, 1, 0]);
  project(f, 'p1').onclick();
  assert.deepEqual([tiles(grid), f.$('library-total').textContent], [['b1'], '1 bobine']);
  f.library.choose({ conversation: 'c1' });
  assert.deepEqual([tiles(grid), f.$('library-empty').hidden], [[], false]);
  // Another kind: none of them.
  f.library.choose({ conversation: 'all' });
  kind('image').onclick();
  assert.deepEqual(tiles(grid), ['r1']);
  // None in the Archives: said.
  const bare = fixture();
  await bare.library.show();
  bare.library.choose({ media: 'bobine' });
  assert.equal(bare.$('library-empty').children[0].textContent, 'Aucune bobine ici : « Enregistrer », dans la Bobine, en range une dans les Archives.');
});
