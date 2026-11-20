import test from 'node:test';
import assert from 'node:assert/strict';
import { setupMontage } from '../public/montage.mjs';

// (0.6.137) The « Montage » mode of the Studio (maquettes M2 à M4, « Oui, code-le » du 20/11): takes of
// the project laid by hand on a timeline, read on the screen, exported as one film.
class Fake {
  constructor(tag, className = '', text = '') {
    Object.assign(this, { tagName: tag.toUpperCase(), className, own: text, children: [], dataset: {}, attributes: {}, hidden: false, paused: true, currentTime: 0 });
    this.style = { setProperty: (name, value) => (this.style[name] = value) };
  }
  append(...items) {
    for (const item of items) if (item) this.children.push(item);
  }
  replaceChildren(...items) {
    this.children = [];
    this.append(...items);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  set textContent(value) {
    this.own = value;
    this.children = [];
  }
  get textContent() {
    return this.own + this.children.map(child => child.textContent).join('');
  }
  getBoundingClientRect() {
    return { left: 0, width: 1000 };
  }
  pause() {
    this.paused = true;
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
}
const under = root => [root, ...root.children.flatMap(child => under(child))];
const find = (root, name) => under(root).filter(item => String(item.className).split(' ').includes(name));
const settle = () => new Promise(done => setImmediate(done));
const C = '11111111-1111-4111-8111-111111111111',
  id = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const take = (n, mediaType, more = {}) => ({
  id: id(n),
  conversationId: C,
  mediaType,
  workflowName: 'Wan 2.2',
  prompt: 'Prise ' + n,
  parameters: {},
  outputs: [{ take: n, originalUrl: `/media/${n}`, ...(mediaType === 'audio' ? {} : { thumbUrl: `/thumb/${n}` }) }],
  ...more,
});

function setup({ stored = [], fail = {} } = {}) {
  const calls = [],
    queue = [],
    kept = new Map(stored.map(montage => [montage.id, montage])),
    project = 'inbox',
    runs = [
      take(1, 'video', { parameters: { frames: 80, fps: 16 } }),
      take(2, 'video', { parameters: { frames: 48, fps: 16 } }),
      take(3, 'image'),
      take(4, 'audio', { workflowName: 'Musique (ACE-Step 1.5 XL)', parameters: { seconds: 30 } }),
    ];
  let made = 100,
    clock = 0,
    refreshed = 0;
  const api = async (route, body) => {
    calls.push({ route, body: body && structuredClone(body) });
    if (fail[route]) throw new Error(fail[route]);
    if (route === 'montages/' + project) return { json: async () => ({ montages: [...kept.values()].map(({ id, name }) => ({ id, name, updatedAt: '2026-11-20T03:00:00.000Z' })) }) };
    if (route === 'montages/save') {
      const saved = { ...body.montage, createdAt: '2026-11-20T03:00:00.000Z', updatedAt: '2026-11-20T03:00:01.000Z' };
      kept.set(saved.id, saved);
      return { json: async () => saved };
    }
    if (route === 'montages/export') return { json: async () => ({ id: id(500), outputs: [{ take: 18 }] }) };
    if (route === 'montages/remove') return void kept.delete(body.id) ?? { json: async () => ({ removed: body.id }) };
    const found = kept.get(route.split('/').pop());
    if (found) return { json: async () => found };
    throw new Error('Ce montage n’existe plus.');
  };
  const notices = [];
  const ui = setupMontage({
    api,
    node: (tag, className, text) => new Fake(tag, className, text),
    icon: name => new Fake('svg', 'icon-' + name),
    notice: text => notices.push(text),
    project: () => project,
    runs: () => runs,
    refresh: async () => void refreshed++,
    ensureConversation: async () => C,
    showTake: record => calls.push({ route: 'open', body: record.id }),
    newId: () => id(made++),
    thumbnail: () => {},
    timers: { set: work => queue.push(work), clear: at => (queue[at - 1] = null) },
    now: () => clock,
  });
  const f = {
    ui,
    calls,
    runs,
    notices,
    kept,
    saves: () => calls.filter(call => call.route === 'montages/save'),
    refreshed: () => refreshed,
    /** Runs what waits (a save a moment after a change, the next tick of the film) and lets it finish. */
    async later({ ms = 0 } = {}) {
      clock += ms;
      for (const work of queue.splice(0)) await work?.();
      await settle();
    },
    root: null,
    get: name => find(f.root, name),
    said: name => find(f.root, name).map(item => item.textContent),
    plans: () => find(f.root, 'montage-piece').filter(piece => !piece.className.includes('is-sound')),
    slider: label => find(f.root, 'montage-range').find(input => input.attributes['aria-label'] === label),
    press: label => find(f.root, 'montage-action').concat(find(f.root, 'montage-step'), find(f.root, 'montage-choice')).find(control => control.textContent === label),
  };
  f.open = async () => {
    f.root = ui.desk(new Fake('div', 'kind-tabs'));
    await settle();
    await settle();
    // (Drawn again once its montages are read: the same root.)
    return f;
  };
  return f;
}

test('a new montage shows the takes of the project and invites to lay them; nothing is kept yet (0.6.137)', async () => {
  const f = await setup().open();
  assert.deepEqual(f.said('montage-take-number'), ['PRISE 1', 'PRISE 2', 'PRISE 3', 'PRISE 4']);
  assert.deepEqual(f.said('montage-take-kind'), ['Vidéo', 'Vidéo', 'Image', 'Musique']);
  assert.deepEqual(f.said('montage-take-length'), ['5 s', '3 s', '', '30 s']);
  assert.deepEqual(f.said('montage-summary'), ['Aucun plan · 16:9 · 24 i/s']);
  assert.deepEqual(f.said('montage-invite'), ['Les vidéos et les images, dans l’ordre du film', 'Une musique sous tout le film', 'Des sons, où vous les posez']);
  assert.deepEqual(f.said('montage-blank-title'), ['Votre montage se lira ici.']);
  assert.deepEqual(f.said('montage-title-name'), ['Nouveau montage']);
  const [go] = f.get('montage-export');
  assert.deepEqual([go.disabled, go.textContent, f.get('montage-play')[0].disabled], [true, 'Exporter le film', true]);
  // The tabs of the Studio are in the head of the screen, as in its other modes.
  assert.equal(f.get('montage-screen-head')[0].children[0].className, 'kind-tabs');
  assert.deepEqual(f.calls.map(call => call.route), ['montages/inbox']);
  // A kind alone: the others leave the grid, the count stays that of the project.
  f.get('montage-filter')[3].onclick();
  assert.deepEqual([f.said('montage-take-number'), f.said('montage-count')], [['PRISE 4'], ['4']]);
  f.get('montage-filter')[2].onclick();
  assert.deepEqual(f.said('montage-take-number'), ['PRISE 3']);
});

test('takes laid by a double click or Enter become plans and sounds, kept a moment later, once (0.6.137)', async () => {
  const f = await setup().open();
  f.get('montage-take')[0].ondblclick();
  f.get('montage-take')[2].onkeydown({ key: 'Enter' });
  f.get('montage-take')[3].ondblclick();
  f.get('montage-take')[1].onkeydown({ key: 'Tab' });
  assert.deepEqual(f.plans().map(piece => piece.textContent), ['1 · PRISE 1Vidéo5 s', '2 · PRISE 3Image3 s']);
  assert.deepEqual(find(f.root, 'is-sound').map(piece => piece.textContent), ['Prise 4 · Prise 4']);
  assert.deepEqual(f.said('montage-summary'), ['2 plans · 8 s · 16:9 · 24 i/s']);
  // Placed at the scale of the timeline: ten seconds at least, here the thirty of the music.
  assert.deepEqual(f.plans().map(piece => [piece.style.left, piece.style.width]), [['0%', 'calc(16.666666666666668% - 4px)'], ['16.666666666666668%', 'calc(10% - 4px)']]);
  // The last laid is the one chosen: its settings at the right.
  assert.deepEqual(f.said('montage-title-name'), ['Musique · Prise 4']);
  assert.equal(f.saves().length, 0, 'not kept at every change');
  await f.later();
  assert.equal(f.saves().length, 1);
  const { project, montage } = f.saves()[0].body;
  assert.deepEqual([project, montage.plans.length, montage.sounds.length, montage.name, montage.width, montage.fps], ['inbox', 2, 1, 'Sans titre', 1344, 24]);
  assert.deepEqual(f.said('montage-status'), ['Enregistré']);
  assert.equal(f.get('montage-export')[0].disabled, false);
});

test('a plan chosen is cut, framed, moved and taken out from its settings (0.6.137)', async () => {
  const f = await setup().open();
  for (const at of [0, 1, 2]) f.get('montage-take')[at].ondblclick();
  f.plans()[0].onclick();
  assert.deepEqual(f.plans().map(piece => piece.attributes['aria-pressed']), ['true', 'false', 'false']);
  assert.deepEqual(f.said('montage-title-name'), ['Plan 1 · Prise 1']);
  assert.deepEqual(f.said('montage-title-meta'), ['Vidéo · Wan 2.2 · 5 s à l’origine']);
  assert.deepEqual(f.said('montage-row-name'), ['Début gardé', 'Fin gardée', 'Durée', 'Cadre', 'Son du clip', 'Place']);
  // Its end brought to two seconds, its start to half a second: a second and a half of it is kept.
  Object.assign(f.slider('Fin gardée'), { value: '2' }).oninput();
  Object.assign(f.slider('Début gardé'), { value: '0.5' }).oninput();
  assert.deepEqual([f.ui.state().montage.plans[0].from, f.ui.state().montage.plans[0].to], [0.5, 2]);
  assert.deepEqual(f.said('montage-figures').slice(0, 3), ['00.5 S', '02.0 S', '01.5 S']);
  assert.deepEqual(f.said('montage-summary'), ['3 plans · 7,5 s · 16:9 · 24 i/s']);
  // Never beyond the take itself.
  Object.assign(f.slider('Fin gardée'), { value: '99' }).oninput();
  assert.equal(f.ui.state().montage.plans[0].to, 5);
  f.press('Remplir').onclick();
  assert.deepEqual([f.ui.state().montage.plans[0].frame, f.press('Remplir').attributes['aria-pressed'], f.press('Ajuster').attributes['aria-pressed']], ['fill', 'true', 'false']);
  Object.assign(f.slider('Son du clip'), { value: '40' }).oninput();
  assert.equal(f.ui.state().montage.plans[0].volume, 0.4);
  // First of the film: nothing before it; moved after the next, it stays the one chosen.
  assert.deepEqual([f.press('← Avant').disabled, f.press('Après →').disabled], [true, false]);
  f.press('Après →').onclick();
  assert.deepEqual(f.plans().map(piece => piece.textContent.slice(0, 11)), ['1 · PRISE 2', '2 · PRISE 1', '3 · PRISE 3']);
  assert.deepEqual(f.said('montage-title-name'), ['Plan 2 · Prise 1']);
  f.press('Ouvrir la prise').onclick();
  assert.deepEqual(f.calls.at(-1), { route: 'open', body: id(1) });
  // An image has a length and a frame only.
  f.plans()[2].onclick();
  assert.deepEqual(f.said('montage-row-name'), ['Durée', 'Cadre', 'Place']);
  // Taken out by its button, or by the key on the plan itself: the others close the gap, nothing is chosen.
  f.press('Retirer').onclick();
  f.plans()[0].onkeydown({ key: 'Delete' });
  assert.deepEqual([f.plans().map(piece => piece.textContent.slice(0, 11)), f.ui.state().chosen, f.said('montage-title-name')], [['1 · PRISE 1'], null, ['Nouveau montage']]);
  // All of it kept once, a moment after the last change.
  await f.later();
  assert.equal(f.saves().length, 1);
  assert.deepEqual(f.saves()[0].body.montage.plans.map(plan => [plan.from, plan.to, plan.frame, plan.volume]), [[0.5, 5, 'fill', 0.4]]);
});

test('a take dragged to the timeline is laid where it is dropped (0.6.137)', async () => {
  const f = await setup().open();
  for (const at of [0, 1]) f.get('montage-take')[at].ondblclick();
  const lanes = f.get('montage-lane'),
    carry = at => f.get('montage-take')[at].ondragstart({ dataTransfer: { setData() {} } });
  const event = clientX => ({ clientX, prevented: false, preventDefault() { this.prevented = true; } });
  // A clip over the plans: accepted there, not over a track of sounds.
  carry(2);
  const over = event(100);
  lanes[0].ondragover(over);
  const refused = event(100);
  lanes[1].ondragover(refused);
  assert.deepEqual([over.prevented, refused.prevented], [true, false]);
  // Dropped at one second of ten: before the first plan, whose middle is later.
  lanes[0].ondrop(event(100));
  assert.deepEqual(f.plans().map(piece => piece.textContent.slice(0, 11)), ['1 · PRISE 3', '2 · PRISE 1', '3 · PRISE 2']);
  // Dropped after everything: at the end.
  carry(1);
  f.get('montage-lane')[0].ondrop(event(990));
  assert.equal(f.plans().length, 4);
  assert.equal(f.plans()[3].textContent.slice(0, 11), '4 · PRISE 2');
  // A music dropped on its track starts where it is dropped (14 s of film: a tenth of the lane is 1,4 s).
  carry(3);
  f.get('montage-lane')[1].ondrop(event(100));
  assert.deepEqual(f.ui.state().montage.sounds.map(sound => [sound.track, sound.at]), [['music', 1.4]]);
  // Nothing carried: a drop of anything else (a file of the computer) changes nothing.
  f.get('montage-lane')[0].ondrop(event(10));
  assert.equal(f.plans().length, 4);
});

test('the film is read on the screen: the head moves, each plan is shown in its turn, it stops at the end (0.6.137)', async () => {
  const f = await setup().open();
  for (const at of [1, 2]) f.get('montage-take')[at].ondblclick();
  const [frame] = f.get('montage-frame'),
    [blank, picture, video, caption] = frame.children;
  assert.deepEqual([video.src, video.hidden, picture.hidden, blank.hidden, caption.textContent], ['/media/2', false, true, true, 'Plan 1 · Prise 2']);
  assert.deepEqual(f.said('montage-clock').concat(f.said('montage-clock-total')), ['00:00', ' / 00:06']);
  f.get('montage-play')[0].onclick();
  assert.deepEqual([f.ui.state().playing, video.paused, f.get('montage-play')[0].attributes['aria-label']], [true, false, 'Mettre en pause']);
  await f.later({ ms: 1500 });
  assert.equal(f.ui.state().head, 1.5);
  assert.deepEqual([f.said('montage-clock'), find(f.root, 'montage-playhead')[0].style.left], [['00:01'], '15%']);
  // Past the clip of three seconds: the image, the clip paused.
  await f.later({ ms: 2000 });
  assert.deepEqual([picture.src, picture.hidden, video.hidden, video.paused, caption.textContent], ['/media/3', false, true, true, 'Plan 2 · Prise 3']);
  // At the end of the film it stops there; played again, it starts over.
  await f.later({ ms: 5000 });
  assert.deepEqual([f.ui.state().playing, f.ui.state().head, f.get('montage-play')[0].attributes['aria-label']], [false, 6, 'Lire le montage']);
  f.ui.play();
  assert.deepEqual([f.ui.state().playing, f.ui.state().head], [true, 0]);
  f.ui.play();
  assert.equal(f.ui.state().playing, false);
  // A click on the bar or on the ruler puts the head there.
  f.get('montage-bar')[0].onclick({ clientX: 500 });
  assert.equal(f.ui.state().head, 3);
  f.get('montage-ruler')[0].onclick({ clientX: 100 });
  assert.equal(f.ui.state().head, 1);
  assert.deepEqual([video.hidden, video.currentTime], [false, 1]);
});

test('« Exporter le film » keeps the montage, asks for its film and says the take it became (0.6.137)', async () => {
  const f = await setup().open();
  f.get('montage-take')[0].ondblclick();
  await f.ui.exportFilm();
  assert.deepEqual(f.calls.slice(-2).map(call => call.route), ['montages/save', 'montages/export']);
  assert.deepEqual(f.calls.at(-1).body, { project: 'inbox', id: f.ui.state().montage.id, conversation: C });
  assert.deepEqual([f.said('montage-status'), f.refreshed(), f.get('montage-status')[0].dataset.problem], [['Film exporté · PRISE 18'], 1, 'false']);
  // Refused by the server (a take that is gone): said where the state is, in its words, as a problem.
  const failing = await setup({ fail: { 'montages/export': 'Plan 1 : cette prise n’existe plus.' } }).open();
  failing.get('montage-take')[0].ondblclick();
  await failing.ui.exportFilm();
  assert.deepEqual([failing.said('montage-status'), failing.get('montage-status')[0].dataset.problem, failing.refreshed()], [['Export impossible : Plan 1 : cette prise n’existe plus.'], 'true', 0]);
  assert.equal(failing.get('montage-export')[0].disabled, false, 'it can be tried again');
  // Not kept: no film is asked for.
  const unsaved = await setup({ fail: { 'montages/save': 'Disque plein.' } }).open();
  unsaved.get('montage-take')[0].ondblclick();
  await unsaved.ui.exportFilm();
  assert.deepEqual(unsaved.said('montage-status'), ['Export impossible : Disque plein.']);
  assert.equal(unsaved.calls.some(call => call.route === 'montages/export'), false);
});

test('the montage of the project is found again; its name, its format, another one, and set aside in two clicks (0.6.137)', async () => {
  const kept = {
    schemaVersion: 1, id: id(900), name: 'Le pêcheur à l’aube', format: '16:9', width: 1344, height: 768, fps: 24,
    plans: [
      { id: id(11), source: { conversationId: C, runId: id(1), output: 0 }, kind: 'video', from: 0, to: 5, frame: 'fit', volume: 1 },
      { id: id(12), source: { conversationId: C, runId: id(77), output: 0 }, kind: 'video', from: 0, to: 2, frame: 'fit', volume: 1 },
    ],
    sounds: [],
  };
  const f = await setup({ stored: [kept] }).open();
  assert.deepEqual(f.calls.map(call => call.route), ['montages/inbox', 'montages/inbox/' + id(900)]);
  assert.deepEqual(f.said('montage-summary'), ['2 plans · 7 s · 16:9 · 24 i/s']);
  // A plan whose take is no longer in the project says so, on the timeline and on the screen.
  assert.deepEqual(f.plans().map(piece => [piece.dataset.missing, piece.textContent.slice(0, 16)]), [['false', '1 · PRISE 1Vidéo'], ['true', 'Prise introuvabl']]);
  f.ui.seek(6);
  assert.deepEqual([f.get('montage-blank')[0].hidden, f.said('montage-blank-title')], [false, ['Prise introuvable.']]);
  const [pick] = f.get('montage-pick');
  assert.deepEqual(pick.children.map(option => [option.textContent, option.value, Boolean(option.selected)]), [['Le pêcheur à l’aube', id(900), true], ['+ Nouveau montage', 'new', false]]);
  // Its name and its format are its own settings, shown when nothing is chosen.
  assert.deepEqual(f.said('montage-row-name'), ['Nom', 'Format', 'Taille', 'Cadence']);
  Object.assign(f.get('montage-name')[0], { value: '  Aube  ' }).onchange();
  const [format] = f.get('montage-select');
  Object.assign(format, { value: '9:16' }).onchange();
  assert.deepEqual([f.ui.state().montage.name, f.ui.state().montage.width, f.ui.state().montage.height], ['Aube', 768, 1344]);
  await f.later();
  assert.equal(f.saves().length, 1);
  // Another montage: what is not kept yet is first, then an empty one, not kept until something is laid.
  Object.assign(f.get('montage-pick')[0], { value: 'new' });
  await f.get('montage-pick')[0].onchange();
  assert.deepEqual([f.said('montage-summary'), f.ui.state().stored, f.said('montage-title-name')], [['Aucun plan · 16:9 · 24 i/s'], false, ['Nouveau montage']]);
  assert.deepEqual(f.get('montage-pick')[0].children.map(option => option.textContent), ['Sans titre', 'Aube', '+ Nouveau montage']);
  // Back to the first, then set aside: asked twice, said, and the project has an empty one again.
  Object.assign(f.get('montage-pick')[0], { value: id(900) });
  await f.get('montage-pick')[0].onchange();
  assert.equal(f.ui.state().montage.name, 'Aube');
  f.press('Supprimer ce montage').onclick();
  assert.equal(f.calls.some(call => call.route === 'montages/remove'), false);
  f.press('Confirmer la suppression').onclick();
  await settle();
  await settle();
  assert.deepEqual(f.calls.find(call => call.route === 'montages/remove').body, { project: 'inbox', id: id(900) });
  assert.deepEqual([f.notices, f.ui.state().stored, f.ui.state().montage.plans.length], [['Montage mis de côté.'], false, 0]);
});

test('leaving the mode stops the film and keeps what was not kept yet (0.6.137)', async () => {
  const f = await setup().open();
  f.get('montage-take')[0].ondblclick();
  f.ui.play();
  await f.ui.leave();
  assert.deepEqual([f.ui.state().playing, f.saves().length], [false, 1]);
  // Back in the mode: the same montage, as it was left.
  f.root = f.ui.desk(new Fake('div', 'kind-tabs'));
  assert.equal(f.plans().length, 1);
  assert.equal(f.calls.filter(call => call.route === 'montages/inbox').length, 1, 'not read again for the same project');
});
