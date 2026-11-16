import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { FIRST_CONVERSATIONS, filtered, mediaOf, setupLibrary } from '../public/library.mjs';
import { createApplication } from '../server.mjs';
import { Gallery } from '../lib/gallery.mjs';
import { STUDIO_ID } from '../lib/studio.mjs';

class Element {
  constructor(tag = '', className = '', textContent = '') {
    Object.assign(this, { tag, className, textContent, children: [], dataset: {}, attributes: {}, hidden: false, value: '' });
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
const ids = element => element.children.map(item => item.dataset.id);

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
  { id: 'r2', conversationId: 'c2', projectId: 'inbox', mediaType: 'video', prompt: 'Un clip', outputs: [output('c2', 'r2')] },
  { id: 'r3', conversationId: 'open', projectId: 'p1', mediaType: 'audio', prompt: 'Des vagues', outputs: [output('open', 'r3')] },
  { id: 'r4', conversationId: STUDIO_ID, projectId: 'inbox', legacy: true, prompt: '', outputs: [output(STUDIO_ID, 'r4')] },
];

function fixture({ runs = RUNS, historyItems = HISTORY, fail = '', conversationId = 'open' } = {}) {
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
  assert.deepEqual(ids(grid), ['r1', 'r2', 'r3', 'r4']);
  assert.equal(f.$('library-total').textContent, '4');
  assert.equal(f.$('library-heading').textContent, 'Pellicule');
  assert.equal(f.$('library-project-view').hidden, true, 'no conversations of a project above them');
  assert.equal(f.$('library-empty').hidden, true);
  assert.deepEqual(
    f.$('library-project').children.map(item => [item.value, item.textContent]),
    [
      ['all', 'Tous les projets'],
      ['inbox', 'Sans projet'],
      ['p1', 'Voyage'],
    ],
  );
  assert.equal(f.$('library-project').value, 'all');
  // Every conversation, each with its project.
  assert.deepEqual(
    f.$('library-conversation').children.map(item => item.textContent),
    ['Toutes les conversations', 'Plage · Voyage', 'Idées · Sans projet'],
  );
  const [image, clip, sound, before] = grid.children;
  // The picture alone, as in the timeline (0.5.126); over its foot, under the pointer or the focus:
  // its prompt (for the eyes: the label of the picture says it all), where it was made and when.
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
  // The picture: its thumbnail; the first frame of a clip; the stripes of a sound, and their badge.
  assert.equal(walk(image).find(item => item.tag === 'img').src, '/media/thumbnail/r1');
  assert.equal(walk(clip).find(item => item.tag === 'video').src, '/media/generated/c2/r2/0?key=k#t=0.1');
  assert.ok(find(sound, 'library-wave'));
  assert.equal(find(image, 'library-badge'), undefined);
  assert.equal(find(find(clip, 'library-badge'), 'icon-video').tag, 'svg');
  assert.equal(find(find(sound, 'library-badge'), 'icon-wave').tag, 'svg');
  assert.equal(find(clip, 'library-pick').attributes['aria-label'], 'Clip · Un clip · Sans projet · Idées');
  find(image, 'library-pick').onclick();
  assert.deepEqual(f.viewed, [['r1', 0]]);
  find(clip, 'library-from').onclick();
  assert.deepEqual(f.opened, ['c2']);
});

test('on a project: its conversations above its creations, the first ones, a new chat in it', async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    id: 'k' + i,
    title: 'Chat ' + i,
    projectId: 'p1',
    createdAt: `2026-11-0${i + 1}T10:00:00.000Z`,
  }));
  const f = fixture({ historyItems: [...HISTORY, ...many] });
  await f.library.show({ project: 'p1' });
  assert.equal(f.$('library-heading').textContent, 'Pellicule › Voyage');
  assert.equal(f.$('library-project').value, 'p1');
  const view = f.$('library-project-view');
  assert.equal(view.hidden, false);
  assert.equal(find(view, 'library-count').textContent, '9');
  const rows = () => walk(f.$('library-project-view')).filter(item => item.className === 'library-conversation');
  assert.equal(rows().length, FIRST_CONVERSATIONS);
  assert.deepEqual(
    rows().map(row => find(row, 'library-conversation-title').textContent),
    ['Plage', 'Chat 0', 'Chat 1', 'Chat 2', 'Chat 3', 'Chat 4'],
  );
  assert.equal(rows()[0].children.find(item => item.tag === 'time').dateTime, '2026-11-14T10:00:00.000Z');
  const more = find(view, 'library-more');
  assert.equal(more.textContent, 'Afficher les 3 autres');
  more.onclick();
  assert.equal(rows().length, 9);
  assert.equal(find(f.$('library-project-view'), 'library-more'), undefined);
  rows()[0].onclick();
  assert.deepEqual(f.opened, ['c1']);
  find(f.$('library-project-view'), 'library-new').onclick();
  assert.deepEqual(f.created, ['p1']);
  // Its creations only, the open conversation's among them, without the project in their line.
  assert.deepEqual(ids(f.$('library-grid')), ['r1', 'r3']);
  assert.equal(find(f.$('library-grid').children[0], 'library-from').textContent, 'Plage');
  // Its own conversations in the filter, without their project.
  assert.deepEqual(f.$('library-conversation').children.slice(0, 3).map(item => item.textContent), [
    'Toutes les conversations',
    'Plage',
    'Chat 0',
  ]);
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
  assert.deepEqual(ids(f.$('library-grid')), ['r2']);
  assert.equal(kind('video').attributes['aria-checked'], 'true');
  assert.deepEqual(f.filters.at(-1), { project: 'all', media: 'video', conversation: 'all' });
  kinds.onkeydown({ key: 'ArrowRight', preventDefault() {} });
  assert.deepEqual(ids(f.$('library-grid')), ['r3']);
  kinds.onkeydown({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(f.$('library-grid').children.length, 4, 'after the last, the first');
  kinds.onkeydown({ key: 'ArrowLeft', preventDefault() {} });
  assert.deepEqual(ids(f.$('library-grid')), ['r3']);
  kind('image').onclick();
  assert.deepEqual(ids(f.$('library-grid')), ['r1', 'r4']);
  f.$('library-conversation').value = 'c1';
  f.$('library-conversation').onchange();
  assert.deepEqual(ids(f.$('library-grid')), ['r1']);
  kind('audio').onclick();
  assert.equal(f.$('library-grid').children.length, 0);
  assert.equal(f.$('library-empty').hidden, false);
  assert.equal(f.$('library-empty').textContent, 'Aucune création de ce type ici.');
  // Another project: its conversation forgotten, the kind kept.
  f.$('library-project').value = 'inbox';
  f.$('library-project').onchange();
  assert.deepEqual(f.filters.at(-1), { project: 'inbox', media: 'audio', conversation: 'all' });
  // Shown again from the sidebar: everything again.
  await f.library.show({ project: 'inbox' });
  assert.deepEqual(f.library.filter(), { project: 'inbox', media: 'all', conversation: 'all' });
  assert.deepEqual(ids(f.$('library-grid')), ['r2', 'r4']);
});

test('a creation of a conversation never saved says so, and opens nothing', async () => {
  const f = fixture({
    runs: [{ id: 'u1', conversationId: 'gone', projectId: 'inbox', unsaved: true, prompt: 'Un renard', outputs: [output('gone', 'u1')] }],
  });
  await f.library.show();
  const from = find(f.$('library-grid').children[0], 'library-from');
  assert.equal(from.tag, 'span');
  assert.equal(from.textContent, 'Conversation non enregistrée');
  assert.equal(from.onclick, undefined);
});

test('the tiles are kept from one drawing to the next: their pictures are not loaded again', async () => {
  const f = fixture();
  await f.library.show();
  const first = f.$('library-grid').children[0];
  f.$('library-project').value = 'p1';
  f.$('library-project').onchange();
  assert.equal(f.$('library-grid').children[0], first);
  assert.equal(find(first, 'library-from').textContent, 'Plage', 'its line follows the filter');
  await f.library.refresh();
  assert.equal(f.$('library-grid').children[0], first, 'the same creation read again');
  find(first, 'library-pick').onclick();
  assert.deepEqual(f.viewed, [['r1', 0]]);
});

test('a project gone shows every project again; an empty library says where creations come from; an error is said', async () => {
  const f = fixture({ runs: [], conversationId: null });
  await f.library.show({ project: 'p1' });
  // No conversation open: only the saved ones.
  assert.deepEqual(f.asked, ['library?images=0']);
  assert.equal(f.$('library-empty').textContent, 'Aucune création dans ce projet pour l’instant.');
  f.state.projects = f.state.projects.filter(project => project.id !== 'p1');
  f.library.render();
  assert.equal(f.library.filter().project, 'all');
  assert.deepEqual(f.filters.at(-1), { project: 'all', media: 'all', conversation: 'all' });
  assert.equal(f.$('library-project-view').hidden, true);
  assert.match(f.$('library-empty').textContent, /^Aucune création pour l’instant\. Les images, vidéos et sons/);
  const broken = fixture({ fail: 'Disque illisible.' });
  await broken.library.show();
  assert.equal(broken.$('library-empty').hidden, false);
  assert.equal(broken.$('library-empty').textContent, 'Pellicule illisible : Disque illisible.');
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
