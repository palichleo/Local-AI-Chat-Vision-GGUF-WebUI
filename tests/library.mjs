import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { filtered, mediaOf, setupLibrary } from '../public/library.mjs';
import { createApplication } from '../server.mjs';
import { Gallery } from '../lib/gallery.mjs';
import { STUDIO_ID } from '../lib/studio.mjs';

class Element {
  constructor(tag = '', className = '', textContent = '') {
    Object.assign(this, { tag, className, textContent, children: [], dataset: {}, attributes: {}, hidden: false, value: '' });
    // The classes it gains and loses while shown (« is-playing » on the button of a sound).
    const marks = (this.marks = new Set());
    this.classList = { add: name => marks.add(name), remove: name => marks.delete(name) };
  }
  append(...items) {
    this.children.push(...items);
  }
  replaceChildren(...items) {
    this.children = items;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
}
const walk = element => [element, ...element.children.flatMap(walk)];
const find = (element, className) => walk(element).find(item => item.className === className);
const tiles = element => walk(element).filter(item => item.className?.startsWith?.('library-tile')).map(item => item.dataset.id);
const pills = row =>
  row.children
    .filter(item => item.className?.split?.(' ')[0] === 'library-pill' && !item.className.includes('is-new'))
    .map(item => [item.children[0].textContent, item.children[1]?.textContent, item.attributes['aria-pressed']]);
const project = (f, id) => f.$('library-projects').children.find(item => item.dataset.project === id);
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
    parameters: { frames: 121, fps: 24 },
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
  assert.deepEqual(f.$('library-heading').children.map(item => item.textContent), ['Pellicule']);
  assert.equal(f.$('library-conversations').hidden, true, 'no conversations of a project above them');
  assert.equal(f.$('library-empty').hidden, true);
  // The projects in pills, each with its number of takes; « Sans projet » after the projects.
  assert.deepEqual(pills(f.$('library-projects')), [
    ['Tous les projets', '4', 'true'],
    ['Voyage', '2', 'false'],
    ['Sans projet', '2', 'false'],
  ]);
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
  assert.equal(find(clip, 'library-length').textContent, '05.04 S');
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

test('on a project: its conversations in pills under its own, a new chat in it, « ··· » to rename or delete it', async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    id: 'k' + i,
    title: 'Chat ' + i,
    projectId: 'p1',
    createdAt: `2026-11-0${i + 1}T10:00:00.000Z`,
  }));
  const renamed = [],
    deleted = [];
  const f = fixture({ historyItems: [...HISTORY, ...many], onRenameProject: project => renamed.push(project.id), onDeleteProject: project => deleted.push(project.id) });
  await f.library.show({ project: 'p1' });
  assert.deepEqual(f.$('library-heading').children.slice(0, 2).map(item => item.textContent), ['Pellicule ›', 'Voyage']);
  assert.equal(f.$('library-total').textContent, '2 prises');
  assert.equal(pills(f.$('library-projects'))[1][2], 'true', 'Voyage chosen');
  const row = f.$('library-conversations');
  assert.equal(row.hidden, false);
  // Those of its conversations that hold its takes, each with its number; a new one at the end.
  assert.equal(row.children[0].textContent, 'Conversations');
  assert.deepEqual(pills(row), [
    ['Toutes les conversations', '2', 'true'],
    ['Plage', '1', 'false'],
  ]);
  row.children.find(item => item.dataset.id === 'c1').onclick();
  assert.deepEqual(tiles(f.$('library-grid')), ['r1']);
  assert.deepEqual(f.filters.at(-1), { project: 'p1', media: 'all', conversation: 'c1' });
  row.children.at(-1).onclick();
  assert.deepEqual(f.created, ['p1']);
  // Its creations only, the open conversation's among them, without the project in their line.
  row.children[1].onclick();
  assert.deepEqual(tiles(f.$('library-grid')), ['r1', 'r3']);
  assert.equal(find(f.$('library-grid'), 'library-from').textContent, 'Plage');
  // « ··· » beside its name: Renommer, Supprimer le projet.
  const more = f.$('library-heading').children.find(item => item.className === 'library-project-more');
  more.onclick();
  const menu = f.$('library-heading').children.find(item => item.className === 'library-project-menu');
  assert.deepEqual(menu.children.map(item => item.textContent), ['Renommer', 'Supprimer le projet']);
  menu.children[0].onclick();
  assert.deepEqual(renamed, ['p1']);
  f.$('library-heading').children.find(item => item.className === 'library-project-more').onclick();
  f.$('library-heading').children.find(item => item.className === 'library-project-menu').children[1].onclick();
  assert.deepEqual(deleted, ['p1']);
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
    ],
  );
  assert.deepEqual(kinds.children.map(item => item.children[1].textContent), ['Tout', 'Images', 'Vidéos', 'Sons']);
  kind('video').onclick();
  assert.deepEqual(tiles(f.$('library-grid')), ['r2']);
  assert.equal(kind('video').attributes['aria-checked'], 'true');
  assert.deepEqual(f.filters.at(-1), { project: 'all', media: 'video', conversation: 'all' });
  // The numbers of the projects follow the kind.
  assert.deepEqual(pills(f.$('library-projects')).map(([name, number]) => [name, number]), [
    ['Tous les projets', '1'],
    ['Voyage', '0'],
    ['Sans projet', '1'],
  ]);
  kinds.onkeydown({ key: 'ArrowRight', preventDefault() {} });
  assert.deepEqual(tiles(f.$('library-grid')), ['r3']);
  kinds.onkeydown({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(tiles(f.$('library-grid')).length, 4, 'after the last, the first');
  kinds.onkeydown({ key: 'ArrowLeft', preventDefault() {} });
  assert.deepEqual(tiles(f.$('library-grid')), ['r3']);
  kind('image').onclick();
  assert.deepEqual(tiles(f.$('library-grid')), ['r1', 'r4']);
  project(f, 'p1').onclick();
  assert.deepEqual(tiles(f.$('library-grid')), ['r1']);
  f.$('library-conversations').children.find(item => item.dataset.id === 'c1').onclick();
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

test('a project gone shows every project again; an empty project offers two ways to begin; an error is said', async () => {
  const opened = [];
  const f = fixture({ runs: [], conversationId: null, openStudio: project => opened.push(project) });
  await f.library.show({ project: 'p1' });
  // No conversation open: only the saved ones.
  assert.deepEqual(f.asked, ['library?images=0']);
  // A project with nothing in it (capture 34): its sentence, a line, the Studio or a new chat.
  const empty = f.$('library-empty');
  assert.equal(empty.hidden, false);
  assert.equal(empty.children[0].textContent, 'Rien dans ce projet pour l’instant.');
  const doors = find(empty, 'library-doors').children;
  assert.deepEqual(doors.map(item => item.textContent), ['Ouvrir le Studio', 'Nouvelle conversation']);
  doors[0].onclick();
  doors[1].onclick();
  assert.deepEqual([opened, f.created], [['p1'], ['p1']]);
  // Its conversations: « + Nouvelle conversation » only.
  assert.deepEqual(f.$('library-conversations').children.map(item => item.className), ['library-pills-label', 'library-pill is-new']);
  f.state.projects = f.state.projects.filter(item => item.id !== 'p1');
  f.library.render();
  assert.equal(f.library.filter().project, 'all');
  assert.deepEqual(f.filters.at(-1), { project: 'all', media: 'all', conversation: 'all' });
  assert.equal(f.$('library-conversations').hidden, true);
  assert.match(f.$('library-empty').children[0].textContent, /^Aucune création pour l’instant\. Les images, vidéos et sons/);
  const broken = fixture({ fail: 'Disque illisible.' });
  await broken.library.show();
  assert.equal(broken.$('library-empty').hidden, false);
  assert.equal(broken.$('library-empty').children[0].textContent, 'Pellicule illisible : Disque illisible.');
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
