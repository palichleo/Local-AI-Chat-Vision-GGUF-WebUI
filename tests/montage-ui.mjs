import test from 'node:test';
import assert from 'node:assert/strict';
import { mono, setupMontage } from '../public/montage.mjs';

// (0.6.148) La Bobine (ex-Montage, the fourth mode of the Studio from 0.6.137 to 0.6.146): a page of its
// own, three fixed columns (« Prises », the preview, « À créer ») over a timeline of four tracks, a small
// bar above what is chosen, the fil at the top (maquette « La Bobine », captures 70 à 92).
class Fake {
  constructor(tag, className = '', text = '') {
    Object.assign(this, { tagName: tag.toUpperCase(), className, own: text, children: [], dataset: {}, attributes: {}, hidden: false, paused: true, currentTime: 0 });
    this.style = { setProperty: (name, value) => (this.style[name] = value) };
  }
  append(...items) {
    for (const item of items)
      if (item) {
        this.children.push(item);
        // (0.6.154) Taken out of the page as the page does it: from where it is.
        if (item instanceof Fake) item.parent = this;
      }
  }
  replaceChildren(...items) {
    this.children = [];
    this.append(...items);
  }
  replaceChild(next, old) {
    const at = this.children.indexOf(old);
    assert.notEqual(at, -1, 'only a child is replaced');
    this.children[at] = next;
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
    return { left: 0, width: WIDTH };
  }
  contains(other) {
    return under(this).includes(other);
  }
  querySelectorAll(tag) {
    return under(this).slice(1).filter(item => item.tagName === tag);
  }
  focus() {
    shown.activeElement = this;
  }
  remove() {
    this.removed = true;
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
  }
  pause() {
    this.paused = true;
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  // (0.6.169) Its classes as the page changes them (a take carried, the Flux on the preview).
  get classList() {
    const names = () => String(this.className).split(' ').filter(Boolean);
    return {
      add: (...more) => (this.className = [...new Set([...names(), ...more])].join(' ')),
      remove: (...less) => (this.className = names().filter(name => !less.includes(name)).join(' ')),
      contains: name => names().includes(name),
    };
  }
}
// The document of the page: what has the keys. How wide a lane of the timeline is, in pixels.
const shown = { activeElement: null };
let WIDTH = 1000;
/** Where a time is on a timeline of `whole` seconds, as the page says it (`percent` of montage.mjs). */
const pc = (seconds, whole) => (100 * seconds) / whole + '%';
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
const INTENTION = 'Prise d’une bobine, demandée dans la Bobine.',
  FILM = { width: 1344, height: 768 };
// (0.6.181) Where the take made goes, said with what is asked: the bobine, its take to create (the
// `at`-th), and from which second of its file it is shown (a suite holds the video it goes on from).
const placeOf = (f, at, from = 0) => ({ id: f.ui.state().montage.id, plan: f.ui.state().montage.plans[at].id, from });

function setup({ stored = [], fail = {}, extra = [], busyWith = null, followed = null, create = null, estimate = null, write = null, thumbnail = () => {}, width = 1000, modelFor = null, longestFor = null, enrich = null, downloads = null, arrange = null, dragImage = null, win = null, canvas = false } = {}) {
  WIDTH = width;
  const calls = [],
    queue = [],
    kept = new Map(stored.map(montage => [montage.id, montage])),
    runs = [
      take(1, 'video', { parameters: { frames: 80, fps: 16 } }),
      take(2, 'video', { parameters: { frames: 48, fps: 16 } }),
      take(3, 'image'),
      take(4, 'audio', { workflowName: 'Musique (ACE-Step 1.5 XL)', parameters: { seconds: 30 } }),
      ...extra,
    ];
  let project = 'inbox',
    made = 100,
    clock = 0,
    refreshed = 0,
    halted = 0;
  const api = async (route, body) => {
    calls.push({ route, body: body && structuredClone(body) });
    if (fail[route]) throw new Error(fail[route]);
    // (0.6.155) The downloads of the server (lib/model-downloads.mjs), as the test says them.
    if (downloads && /^downloads(\/|$)/.test(route)) {
      const answer = downloads(route, body);
      return { json: async () => answer };
    }
    if (route === 'montages/' + project) return { json: async () => ({ montages: [...kept.values()].map(({ id, name }) => ({ id, name, updatedAt: '2026-11-20T03:00:00.000Z' })) }) };
    if (route === 'montages/save') {
      const saved = { ...body.montage, createdAt: '2026-11-20T03:00:00.000Z', updatedAt: '2026-11-20T03:00:01.000Z' };
      kept.set(saved.id, saved);
      return { json: async () => saved };
    }
    if (route === 'montages/export') return { json: async () => ({ id: id(500), outputs: [{ take: 18 }] }) };
    // (0.6.154) « Un fichier par prise »: the takes made, in their folder of BOBINES.
    if (route === 'montages/export-takes') {
      const made = kept.get(body.id).plans.filter(plan => plan.source);
      return { json: async () => ({ folder: 'bobines/' + kept.get(body.id).name, files: made.map((_, at) => String(at + 1).padStart(2, '0') + '.mp4') }) };
    }
    if (route === 'montages/remove') {
      kept.delete(body.id);
      return { json: async () => ({ removed: body.id }) };
    }
    const found = kept.get(route.split('/').pop());
    if (found) return { json: async () => found };
    throw new Error('Cette bobine n’existe plus.');
  };
  const notices = [],
    heard = new Map(),
    // (0.6.169) `win`: what a page has besides (its images of the screen, what the Flux draws with).
    page = { document: shown, addEventListener: (type, listener) => heard.set(type, listener), removeEventListener: type => heard.delete(type), ...win };
  shown.activeElement = null;
  const ui = setupMontage({
    page,
    ...(create ? { create } : {}),
    ...(busyWith ? { busyWith } : {}),
    ...(followed ? { followed } : {}),
    ...(estimate ? { estimate } : {}),
    ...(write ? { write } : {}),
    ...(modelFor ? { modelFor } : {}),
    ...(longestFor ? { longestFor } : {}),
    ...(enrich ? { enrich } : {}),
    ...(arrange ? { arrange } : {}),
    ...(dragImage ? { dragImage } : {}),
    halt: () => void halted++,
    api,
    // (`canvas`: a canvas that draws, for the Flux.)
    node: (tag, className, text) => Object.assign(new Fake(tag, className, text), canvas && tag === 'canvas' ? { getContext: () => null } : {}),
    icon: name => new Fake('svg', 'icon-' + name),
    notice: text => notices.push(text),
    project: () => project,
    runs: () => runs,
    refresh: async () => void refreshed++,
    ensureConversation: async () => C,
    showTake: record => calls.push({ route: 'open', body: record.id }),
    newId: () => id(made++),
    thumbnail,
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
    // (0.6.160) Another project chosen on the page.
    move: name => void (project = name),
    refreshed: () => refreshed,
    halted: () => halted,
    // The lanes of the takes and of the two audio tracks, in their order; the one of the photos, above them.
    lanes: () => find(f.root, 'montage-lane').filter(lane => !String(lane.className).includes('montage-photos')),
    photos: () => find(f.root, 'montage-photos')[0],
    track: name => find(f.root, 'montage-track').find(track => track.dataset.track === name),
    // The pointer once pressed on the timeline: moved to `clientX`, let go; how many listeners are left.
    pointer: {
      move: clientX => heard.get('pointermove')?.({ clientX }),
      up: () => heard.get('pointerup')?.({}),
      held: () => ['pointermove', 'pointerup', 'pointercancel'].filter(type => heard.has(type)).length,
    },
    press: (target, clientX) => target.onpointerdown({ clientX, button: 0, stopPropagation() {} }),
    // (0.6.149) A press in the void of the takes, beside what they hold.
    pressVoid: clientX => f.lanes()[0].onpointerdown({ clientX, button: 0, target: f.lanes()[0], stopPropagation() {} }),
    focused: () => shown.activeElement,
    // (0.6.153) A key heard by the page itself, wherever the focus is.
    // (0.6.154) With what is pressed with it (Ctrl, Maj) and where the focus is.
    pageKey: (key, more = {}) => heard.get('keydown')?.({ key, target: { tagName: 'DIV' }, preventDefault() {}, ...more }),
    // (0.6.154) Whether the page hears something else (a menu open waits for a click beside it).
    heard: type => heard.has(type),
    /** Runs what waits (a save a moment after a change, the next tick of the film) and lets it finish. */
    async later({ ms = 0 } = {}) {
      clock += ms;
      for (const work of queue.splice(0)) await work?.();
      await settle();
    },
    /** (0.6.173) Time goes by, nothing else: a slide going on. */
    tick: ms => void (clock += ms),
    root: null,
    get: name => find(f.root, name),
    said: name => find(f.root, name).map(item => item.textContent),
    plans: () => find(f.root, 'montage-piece').filter(piece => !piece.className.includes('is-sound')),
    // What each take of the timeline says: its name (or its state), its length.
    names: () => f.plans().map(piece => piece.children[0].textContent),
    lengths: () => f.plans().map(piece => find(piece, 'montage-piece-length')[0].textContent),
    slider: label => find(f.root, 'montage-range').find(input => input.attributes['aria-label'] === label),
    // A button by its words, or by the words of its icon (« Remplir » for « Remplir : plein cadre… »).
    button: label =>
      under(f.root).find(item => {
        const tip = item.attributes?.['aria-label'] ?? '';
        return item.tagName === 'BUTTON' && (tip === label || tip.startsWith(label + ' :') || item.textContent === label);
      }),
    // The small bar of what is chosen: the words of its controls.
    pop: () => f.get('montage-pop')[0],
    popLabels: () => under(f.pop()).slice(1).map(item => item.attributes['aria-label']).filter(Boolean),
    // « À créer »: each line, [its instants, its model or state, what it is, why it cannot be created].
    lines: () =>
      f.get('bobine-line').map(line => [
        find(line, 'bobine-line-when')[0].textContent,
        find(line, 'bobine-line-right')[0].textContent,
        find(line, 'bobine-line-what')[0].textContent,
        find(line, 'bobine-line-reason').map(reason => reason.textContent).join(''),
      ]),
    write: (at, words) => Object.assign(f.get('bobine-line-words')[at], { value: words }).oninput(),
    go: () => f.said('bobine-go-label')[0],
    goMain: () => f.get('bobine-go-main')[0],
    pick: value => Object.assign(f.get('montage-pick')[0], { value }).onchange(),
  };
  f.open = async () => {
    f.root = ui.desk();
    await settle();
    await settle();
    // (Drawn again once its bobines are read: the same root.)
    return f;
  };
  return f;
}

test('the instants of the page are said in mono: seconds and hundredths, then minutes (0.6.148)', () => {
  assert.deepEqual([0, 5, 6.04, 5.0417, 59.999, 62.5, 125].map(mono), ['00.00', '05.00', '06.04', '05.04', '1:00.00', '1:02.50', '2:05.00']);
});

test('a new bobine shows the takes of the project, its four tracks and « À créer »; nothing is kept yet (0.6.137, 0.6.148)', async () => {
  const f = await setup().open();
  // Its fil at the top of the page when the page gives none.
  assert.deepEqual([f.root.className, f.root.children[0].className], ['studio-desk bobine-desk', 'bobine-fil']);
  assert.deepEqual(f.root.children.slice(1).map(part => part.className), [
    'studio-block is-settings montage-takes',
    'studio-block is-preview montage-screen',
    'studio-block is-settings bobine-create',
    'studio-block is-output montage-timeline',
  ]);
  assert.deepEqual(f.said('montage-take-number'), ['Prise 1', 'Prise 2', 'Prise 3', 'Prise 4']);
  assert.deepEqual(f.said('montage-take-length'), ['05.00 s', '03.00 s', 'Image', '30.00 s']);
  assert.deepEqual(f.said('montage-track-name'), ['Photos', 'Prises', 'Piste audio 1', 'Piste audio 2']);
  // The preview of an empty bobine: its frame and the Éclipse, no words.
  const [blank] = f.get('montage-blank');
  assert.deepEqual([blank.hidden, blank.children.map(child => child.className), blank.textContent], [false, ['icon-eclipse'], '']);
  // The format under the preview, said with its size.
  const [format] = f.get('montage-format');
  assert.equal(format.children.find(option => option.selected).dataset.face, '16:9  1344 × 768');
  // The fil: the bobine, what it can do (no « Supprimer » for one not kept), « Exporter ».
  assert.deepEqual(f.get('montage-pick')[0].children.map(option => [option.textContent, option.value, Boolean(option.selected)]), [
    ['Sans titre', f.ui.state().montage.id, true],
    ['+ Nouvelle bobine', 'new', false],
    ['Renommer la bobine', 'rename', false],
  ]);
  const [go] = f.get('montage-export');
  assert.deepEqual([go.disabled, go.textContent, go.title, go.children[0].className], [true, 'Exporter', 'Posez au moins une prise pour exporter', 'icon-download']);
  assert.equal(f.get('montage-play')[0].disabled, true);
  // « À créer », always there: nothing in it, its button says « Créer » and waits.
  assert.deepEqual([f.said('bobine-create-title'), f.get('bobine-line').length, f.go(), f.goMain().disabled], [['À créer'], 0, 'Créer', true]);
  assert.deepEqual(f.calls.map(call => call.route), ['montages/inbox']);
  // A kind alone: the others leave the grid, the count stays that of the project.
  f.get('montage-filter')[3].onclick();
  assert.deepEqual([f.said('montage-take-number'), f.said('montage-count')], [['Prise 4'], ['4']]);
  f.get('montage-filter')[2].onclick();
  assert.deepEqual(f.said('montage-take-number'), ['Prise 3']);
});

test('takes laid by a double click or Enter go on their tracks, kept a moment later, once (0.6.137, 0.6.148)', async () => {
  const f = await setup().open();
  f.get('montage-take')[0].ondblclick();
  f.get('montage-take')[2].onkeydown({ key: 'Enter' });
  f.get('montage-take')[3].ondblclick();
  f.get('montage-take')[1].onkeydown({ key: 'Tab' });
  assert.deepEqual([f.names(), f.lengths()], [['Prise 1', 'Prise 3'], ['05.00 s', '03.00 s']]);
  // The music on « Piste audio 1 », at 60 %.
  const sounds = find(f.root, 'is-sound');
  assert.deepEqual(sounds.map(piece => piece.children.map(part => part.textContent)), [['Prise 4 · Prise 4', '60 %']]);
  assert.deepEqual([f.lanes()[1].children, f.lanes()[2].children], [sounds, []]);
  // Placed at the scale of the timeline: ten seconds at least, here the thirty of the music.
  assert.deepEqual(f.plans().map(piece => [piece.style.left, piece.style.width]), [['0%', 'calc(16.666666666666668% - 4px)'], ['16.666666666666668%', 'calc(10% - 4px)']]);
  // The last laid is the one chosen: its small bar above it, on its track.
  assert.equal(f.ui.state().chosen, f.ui.state().montage.sounds[0].id);
  assert.deepEqual([find(f.track('music'), 'montage-pop').length, f.pop().attributes['aria-label'], f.popLabels(), f.said('montage-pop-figure')], [1, 'Réglages du son', ['Volume', 'Ouvrir la prise', 'Retirer de la bobine (Suppr)'], ['60 %']]);
  // (0.6.155) Centred above it, kept inside the track by half its width.
  assert.deepEqual([f.pop().style.left, f.pop().style['--half']], ['clamp(var(--half), 50%, calc(100% - var(--half)))', '96px']);
  assert.equal(f.saves().length, 0, 'not kept at every change');
  await f.later();
  assert.equal(f.saves().length, 1);
  const { project, montage } = f.saves()[0].body;
  assert.deepEqual([project, montage.plans.length, montage.sounds.length, montage.name, montage.width, montage.fps], ['inbox', 2, 1, 'Sans titre', 1344, 24]);
  // (0.6.154) Kept on its own, it says nothing: « Enregistrer » is the Archives now.
  assert.deepEqual(f.said('montage-status'), ['']);
  // Kept: the fil can take it out now, and « Exporter » makes its film.
  assert.deepEqual(f.get('montage-pick')[0].children.map(option => option.textContent), ['Sans titre', '+ Nouvelle bobine', 'Renommer la bobine', 'Supprimer la bobine']);
  assert.deepEqual([f.get('montage-export')[0].disabled, f.get('montage-export')[0].title], [false, 'Exporter la bobine']);
  // It follows the bobine at once, the fil not drawn again: no take, no film.
  const fil = f.get('montage-pick')[0];
  for (const piece of f.plans()) piece.onkeydown({ key: 'Delete' });
  assert.deepEqual([f.get('montage-export')[0].disabled, f.get('montage-export')[0].title, f.get('montage-pick')[0]], [true, 'Posez au moins une prise pour exporter', fil]);
});

test('the small bar of a take chosen: its sound, its frame, opened, taken out; a second click or Échap closes it (0.6.148)', async () => {
  // (Captures 80 et 81: no panel of settings any more, a small bar above the take, icons, their words on hover.)
  const f = await setup().open();
  for (const at of [0, 1, 2]) f.get('montage-take')[at].ondblclick();
  const plan = at => f.ui.state().montage.plans[at];
  f.plans()[0].onclick();
  assert.deepEqual(f.plans().map(piece => piece.attributes['aria-pressed']), ['true', 'false', 'false']);
  assert.deepEqual([find(f.track('plans'), 'montage-pop').length, f.pop().attributes['aria-label']], [1, 'Réglages de la prise']);
  assert.deepEqual(f.popLabels(), [
    'Couper le son de la prise',
    'Ajuster : la prise entière, avec des bandes si son format diffère',
    'Remplir : plein cadre, ce qui dépasse est coupé',
    'Ouvrir la prise',
    'Retirer de la bobine (Suppr)',
  ]);
  f.button('Remplir').onclick();
  assert.deepEqual([plan(0).frame, f.button('Remplir').attributes['aria-pressed'], f.button('Ajuster').attributes['aria-pressed']], ['fill', 'true', 'false']);
  f.button('Couper le son de la prise').onclick();
  assert.deepEqual([plan(0).volume, f.button('Remettre le son de la prise').attributes['aria-pressed']], [0, 'false']);
  f.button('Remettre le son de la prise').onclick();
  assert.equal(plan(0).volume, 1);
  f.button('Ouvrir la prise').onclick();
  assert.deepEqual(f.calls.at(-1), { route: 'open', body: id(1) });
  // Alt and an arrow move it, it stays the one chosen; its bar follows it.
  f.plans()[0].onkeydown({ key: 'ArrowRight', altKey: true });
  assert.deepEqual([f.names(), f.ui.state().chosen, f.pop().style.left], [['Prise 2', 'Prise 1', 'Prise 3'], plan(1).id, 'clamp(var(--half), 27.5%, calc(100% - var(--half)))']);
  // An image has a frame, no sound.
  f.plans()[2].onclick();
  assert.deepEqual(f.popLabels().map(label => label.split(' :')[0]), ['Ajuster', 'Remplir', 'Ouvrir la prise', 'Retirer de la bobine (Suppr)']);
  // Clicked again, or Échap: let go, no bar.
  f.plans()[2].onclick();
  assert.deepEqual([f.ui.state().chosen, f.get('montage-pop').length], [null, 0]);
  f.plans()[2].onclick();
  f.root.onkeydown({ key: 'Escape', target: { tagName: 'DIV' } });
  assert.deepEqual([f.ui.state().chosen, f.get('montage-pop').length], [null, 0]);
  // Taken out by its bar, or by the key on the take itself: the others close the gap, nothing is chosen.
  f.plans()[2].onclick();
  f.button('Retirer de la bobine (Suppr)').onclick();
  assert.deepEqual([f.names(), f.ui.state().chosen, f.get('montage-pop').length], [['Prise 2', 'Prise 1'], null, 0]);
  f.plans()[0].onkeydown({ key: 'Delete' });
  assert.deepEqual(f.names(), ['Prise 1']);
  // All of it kept once, a moment after the last change.
  await f.later();
  assert.equal(f.saves().length, 1);
  assert.deepEqual(f.saves()[0].body.montage.plans.map(item => [item.from, item.to, item.frame, item.volume]), [[0, 5, 'fill', 1]]);
});

test('a take is stretched by its edges and moved by dragging it; a change leaves the preview as it is (0.6.138, 0.6.149)', async () => {
  // (His request of 20/11, « studio montage : améliore »: the length was set at the right only, the
  // order by two buttons, and every change drew the screen and the takes again.)
  // (0.6.149) Eight seconds of takes: the timeline shows twenty, on a lane of 2000 pixels (a second is 100).
  const f = await setup({ width: 2000 }).open();
  for (const at of [0, 1]) f.get('montage-take')[at].ondblclick();
  const grips = () => find(f.root, 'montage-grip'),
    plan = at => f.ui.state().montage.plans[at],
    places = () => f.plans().map(piece => [piece.style.left, piece.style.width]),
    at = seconds => pc(seconds, 20),
    wide = seconds => `calc(${pc(seconds, 20)} - 4px)`,
    [screen] = f.get('montage-screen'),
    [takes] = f.get('montage-takes');
  assert.deepEqual(grips().map(grip => grip.className), ['montage-grip is-start', 'montage-grip is-end', 'montage-grip is-start', 'montage-grip is-end']);
  // The end of the first take: a pixel is no drag; a hundred to the left take a second off, and the
  // take after it, which touches it, follows. (The other buttons of the mouse pull nothing.)
  grips()[1].onpointerdown({ clientX: 500, button: 2, stopPropagation() {} });
  assert.equal(f.pointer.held(), 0);
  f.press(grips()[1], 500);
  f.pointer.move(499);
  assert.equal(plan(0).to, 5);
  assert.equal(f.root.dataset.held, undefined);
  f.pointer.move(400);
  assert.deepEqual([plan(0).to, places()], [4, [[at(0), wide(4)], [at(4), wide(3)]]]);
  assert.equal(f.root.dataset.held, 'trim', 'said to the desk while it lasts: one cursor everywhere');
  // The take in hand is the one chosen; its bar waits for the hand to let go.
  assert.deepEqual([f.ui.state().chosen, f.get('montage-pop').length], [plan(0).id, 0]);
  // Never beyond the take itself, whatever the pointer does; let go, nothing listens any more.
  f.pointer.move(900);
  assert.equal(plan(0).to, 5);
  f.pointer.move(380);
  f.pointer.up();
  assert.deepEqual([plan(0).to, f.pointer.held(), f.root.dataset.held, f.get('montage-pop').length], [3.8, 0, undefined, 1]);
  // The start of the second take: its edge follows the pointer while it is cut, the take before it
  // stays; let go, it touches the take before it again (it touched it).
  f.press(grips()[2], 380);
  f.pointer.move(480);
  assert.deepEqual([plan(1).from, plan(1).to, places()], [1, 3, [[at(0), wide(3.8)], [at(4.8), wide(2)]]]);
  f.pointer.up();
  assert.deepEqual(places(), [[at(0), wide(3.8)], [at(3.8), wide(2)]]);
  // The click the browser sends after a drag chooses nothing: the take cut is still the one chosen.
  f.plans()[1].onclick();
  assert.equal(f.ui.state().chosen, plan(1).id);
  await f.later();
  assert.equal(f.saves().length, 1, 'kept once, a moment after the last of them');
  // Dragged past the middle of the other, a take takes its place; a few pixels are a click, not a move.
  const [first, second] = [plan(0).id, plan(1).id];
  f.press(f.plans()[0], 100);
  f.pointer.move(103);
  f.pointer.up();
  assert.deepEqual([plan(0).id, plan(1).id, f.ui.state().chosen], [first, second, second]);
  // Pressed near its end and moved a little, it stays where it is, and is the one chosen: its place
  // is read on the bobine as it was when it was pressed (lifted, the other is at 0 to 2 s: its middle is 1 s).
  f.press(f.plans()[0], 370);
  f.pointer.move(378);
  assert.deepEqual([plan(0).id, plan(1).id, f.ui.state().chosen, f.plans()[0].attributes['aria-pressed']], [first, second, first, 'true']);
  f.pointer.move(470);
  assert.deepEqual([plan(0).id, plan(1).id], [first, second]);
  f.pointer.move(490);
  assert.deepEqual([plan(0).id, plan(1).id], [second, first]);
  f.pointer.move(470);
  f.pointer.up();
  assert.deepEqual([plan(0).id, plan(1).id], [first, second]);
  // (0.6.149) Dragged into the void after the other: there, a hole before it; back over the other, before it.
  f.press(f.plans()[0], 100);
  f.pointer.move(520);
  assert.deepEqual([plan(0).id, plan(1).id, plan(1).at, f.ui.state().chosen, f.root.dataset.held], [second, first, 4.2, first, 'move']);
  f.pointer.move(60);
  assert.deepEqual([plan(0).id, plan(1).id, plan(1).at], [first, second, 3.8]);
  f.pointer.up();
  // Alt and an arrow move it too, from the keyboard.
  f.plans()[0].onkeydown({ key: 'ArrowRight', altKey: true });
  assert.deepEqual([plan(0).id, plan(1).id], [second, first]);
  f.plans()[1].onkeydown({ key: 'ArrowRight', altKey: false });
  assert.deepEqual([plan(0).id, plan(1).id], [second, first]);
  // Through all of it the preview and the grid of the takes are the ones first drawn: the clip in the
  // preview did not start over, the grid did not go back to its top. Another format draws them again.
  assert.equal(f.get('montage-screen')[0], screen);
  assert.equal(f.get('montage-takes')[0], takes);
  Object.assign(f.get('montage-format')[0], { value: '1:1' }).onchange();
  assert.notEqual(f.get('montage-screen')[0], screen);
  assert.deepEqual([f.get('montage-frame')[0].style.aspectRatio, f.ui.state().montage.width], ['1024 / 1024', 1024]);
});

test('the volume of a sound stays in the hand while it is slid; let go, the timeline says it (0.6.138, 0.6.148)', async () => {
  // (Found on 20/11 while reading 0.6.137 again: a bar drawn again at each step was taken out of the hand
  // sliding it. In the Bobine the bar is above the sound, on the timeline: nothing is drawn while it slides.)
  const f = await setup().open();
  f.get('montage-take')[0].ondblclick();
  f.get('montage-take')[3].ondblclick();
  const [timeline] = f.get('montage-timeline'),
    bar = f.pop(),
    volume = f.slider('Volume'),
    sound = () => f.ui.state().montage.sounds[0];
  assert.deepEqual([volume.value, volume.min, volume.max], ['60', '0', '200']);
  Object.assign(volume, { value: '80' }).oninput();
  Object.assign(volume, { value: '40' }).oninput();
  assert.deepEqual([f.get('montage-timeline')[0], f.pop(), f.slider('Volume')], [timeline, bar, volume]);
  // What it says follows: its figure, and the sound on its track.
  assert.deepEqual([sound().volume, f.said('montage-pop-figure'), find(f.root, 'is-sound')[0].children[1].textContent, volume.style['--fill']], [0.4, ['40 %'], '40 %', '0.2']);
  // Let go: drawn as it now is, the same bar keeps the keys.
  volume.focus();
  volume.onchange();
  assert.notEqual(f.get('montage-timeline')[0], timeline);
  assert.deepEqual([f.slider('Volume').value, f.focused()], ['40', f.slider('Volume')]);
  await f.later();
  assert.deepEqual([f.saves().length, f.saves()[0].body.montage.sounds[0].volume], [1, 0.4]);
});

test('the keys stay with the bobine: what is drawn again under the focus gets it back (0.6.138)', async () => {
  // (A take clicked was drawn again and left the page with the focus: the next key went nowhere.)
  const f = await setup().open();
  for (const at of [0, 1, 2]) f.get('montage-take')[at].ondblclick();
  const plan = at => f.ui.state().montage.plans[at],
    first = plan(0).id,
    pressed = f.plans()[0];
  pressed.focus();
  pressed.onclick();
  assert.notEqual(f.plans()[0], pressed);
  assert.equal(f.focused(), f.plans()[0]);
  // Alt and an arrow, twice: the take goes on with the focus as it moves.
  for (const place of [1, 2]) {
    f.focused().onkeydown({ key: 'ArrowRight', altKey: true });
    assert.deepEqual([plan(place).id, f.focused()], [first, f.plans()[place]]);
  }
  // A button of its bar is drawn again with it: the same button has the focus; one that is no longer
  // there leaves it to the desk, which hears the keys of the bobine.
  const fill = f.button('Remplir');
  fill.focus();
  fill.onclick();
  assert.notEqual(f.button('Remplir'), fill);
  assert.deepEqual([plan(2).frame, f.focused()], ['fill', f.button('Remplir')]);
  f.button('Retirer de la bobine (Suppr)').focus();
  f.focused().onclick();
  assert.deepEqual([f.plans().length, f.focused()], [2, f.root]);
  // Taken out with its key, a take leaves the focus to the desk too.
  f.plans()[0].focus();
  f.plans()[0].onkeydown({ key: 'Delete' });
  assert.deepEqual([f.plans().length, f.focused()], [1, f.root]);
  // What is not drawn again keeps it: a take of the grid, while the timeline changes.
  const [tile] = f.get('montage-take');
  tile.focus();
  f.plans()[0].onclick();
  assert.equal(f.focused(), tile);
  // Everything drawn again (another kind of takes shown): the same filter has it.
  const filter = f.get('montage-filter')[1];
  filter.focus();
  filter.onclick();
  assert.notEqual(f.get('montage-filter')[1], filter);
  assert.equal(f.focused(), f.get('montage-filter')[1]);
});

test('a sound slides along its track, and stops on a cut of the bobine when it is near one (0.6.138)', async () => {
  const f = await setup().open();
  f.get('montage-take')[0].ondblclick();
  f.get('montage-take')[3].ondblclick();
  const sound = () => f.ui.state().montage.sounds[0],
    piece = () => find(f.root, 'is-sound')[0];
  // Thirty seconds of music on a lane of 1000: a hundred pixels are three seconds.
  f.press(piece(), 10);
  f.pointer.move(110);
  assert.deepEqual([sound().at, piece().style.left], [3, '10%']);
  // Near the end of the only take (5 s): on it. Near is eight pixels of the timeline, here a quarter
  // of a second; further, it is where the pointer is.
  f.pointer.move(175);
  assert.equal(sound().at, 5);
  f.pointer.move(169);
  assert.equal(sound().at, 5);
  f.pointer.move(160);
  assert.equal(sound().at, 4.5);
  f.pointer.move(-400);
  assert.equal(sound().at, 0);
  f.pointer.up();
  assert.deepEqual([f.ui.state().chosen, f.pop().style.left], [sound().id, 'clamp(var(--half), 50%, calc(100% - var(--half)))']);
  // An image has one edge to pull: its length.
  f.get('montage-take')[2].ondblclick();
  assert.deepEqual(find(f.plans()[1], 'montage-grip').map(grip => grip.className), ['montage-grip is-end']);
});

test('the bobine is read in the preview: the head moves, each take is shown in its turn, it stops at the end (0.6.137)', async () => {
  // (Six seconds of takes: the timeline shows twenty, on 2000 pixels.)
  const f = await setup({ width: 2000 }).open();
  for (const at of [1, 2]) f.get('montage-take')[at].ondblclick();
  const [frame] = f.get('montage-frame'),
    [blank, picture, video, caption] = frame.children;
  assert.deepEqual([video.src, video.hidden, picture.hidden, blank.hidden, caption.textContent], ['/media/2', false, true, true, 'Prise 2']);
  assert.deepEqual(f.said('montage-clock').concat(f.said('montage-clock-total')), ['00.00', ' / 06.00']);
  f.get('montage-play')[0].onclick();
  assert.deepEqual([f.ui.state().playing, video.paused, f.get('montage-play')[0].attributes['aria-label']], [true, false, 'Mettre en pause']);
  await f.later({ ms: 1500 });
  assert.equal(f.ui.state().head, 1.5);
  assert.deepEqual([f.said('montage-clock'), find(f.root, 'montage-playhead')[0].style.left], [['01.50'], '7.5%']);
  // Past the clip of three seconds: the image, the clip paused.
  await f.later({ ms: 2000 });
  assert.deepEqual([picture.src, picture.hidden, video.hidden, video.paused, caption.textContent], ['/media/3', false, true, true, 'Prise 3']);
  // At the end of the bobine it stops there; played again, it starts over.
  await f.later({ ms: 5000 });
  assert.deepEqual([f.ui.state().playing, f.ui.state().head, f.get('montage-play')[0].attributes['aria-label']], [false, 6, 'Lire la bobine']);
  f.ui.play();
  assert.deepEqual([f.ui.state().playing, f.ui.state().head], [true, 0]);
  f.ui.play();
  assert.equal(f.ui.state().playing, false);
  // A press on the ruler puts the head there; held, the head follows the pointer, until it is let go.
  f.press(f.get('montage-ruler')[0], 100);
  assert.equal(f.ui.state().head, 1);
  assert.deepEqual([video.hidden, video.currentTime], [false, 1]);
  f.pointer.move(250);
  assert.deepEqual([f.ui.state().head, video.currentTime, find(f.root, 'montage-playhead')[0].style.left], [2.5, 2.5, '12.5%']);
  f.pointer.move(450);
  assert.deepEqual([f.ui.state().head, picture.hidden], [4.5, false]);
  f.pointer.up();
  assert.equal(f.pointer.held(), 0);
  await f.later();
  // A press on a lane beside what it holds puts the head there too, and lets go of what was chosen (on
  // an audio track: in the void of the takes, a click lays a take, 0.6.169); the space bar reads the
  // bobine from anywhere, except where a key is typed or a button pressed.
  const lane = f.lanes()[1];
  assert.notEqual(f.ui.state().chosen, null);
  lane.onclick({ clientX: 800, target: lane });
  assert.deepEqual([f.ui.state().head, f.ui.state().chosen], [6, null]);
  lane.onclick({ clientX: 100, target: f.plans()[0] });
  assert.equal(f.ui.state().head, 6);
  const key = (name, tagName, className) => f.root.onkeydown({ key: name, target: { tagName, className }, preventDefault() {} });
  key('Home', 'DIV');
  assert.equal(f.ui.state().head, 0);
  key(' ', 'INPUT');
  key(' ', 'TEXTAREA');
  key(' ', 'BUTTON');
  key(' ', 'BUTTON', 'montage-pop-button');
  assert.equal(f.ui.state().playing, false);
  key(' ', 'SECTION');
  assert.equal(f.ui.state().playing, true);
  key(' ', 'DIV');
  assert.equal(f.ui.state().playing, false);
  // A take, a sound, a tile: buttons too, but the space bar reads the bobine there (Enter chooses).
  key(' ', 'BUTTON', 'montage-piece');
  assert.equal(f.ui.state().playing, true);
  key(' ', 'BUTTON', 'montage-piece is-sound');
  assert.equal(f.ui.state().playing, false);
  key(' ', 'BUTTON', 'montage-take');
  assert.equal(f.ui.state().playing, true);
  key(' ', 'BUTTON', 'montage-take');
  assert.equal(f.ui.state().playing, false);
  assert.equal(f.root.tabIndex, -1, 'a press anywhere on the desk gives it the keys');
  key('End', 'DIV');
  assert.equal(f.ui.state().head, 6);
  // (0.6.148) The Bobine is a page of its own: another page of the application shown, it does not go
  // on playing behind it; on its page it does.
  for (const [view, playing] of [['bobine', true], ['studio', false]]) {
    globalThis.document = { body: { dataset: { view } } };
    try {
      f.ui.seek(0);
      if (f.ui.state().playing) f.ui.play();
      f.ui.play();
      await f.later({ ms: 100 });
      assert.equal(f.ui.state().playing, playing, view);
    } finally {
      delete globalThis.document;
    }
  }
});

test('« Exporter » keeps the bobine, asks for its film and says the take it became (0.6.137, 0.6.148)', async () => {
  const f = await setup().open();
  f.get('montage-take')[0].ondblclick();
  await f.ui.exportFilm();
  assert.deepEqual(f.calls.slice(-2).map(call => call.route), ['montages/save', 'montages/export']);
  assert.deepEqual(f.calls.at(-1).body, { project: 'inbox', id: f.ui.state().montage.id, conversation: C });
  assert.deepEqual([f.said('montage-status'), f.refreshed(), f.get('montage-status')[0].dataset.problem], [['Film exporté · Prise 18'], 1, 'false']);
  // Refused by the server (a take that is gone): said in the fil, in its words, as a problem.
  const failing = await setup({ fail: { 'montages/export': 'Prise 1 : cette prise n’existe plus.' } }).open();
  failing.get('montage-take')[0].ondblclick();
  await failing.ui.exportFilm();
  assert.deepEqual([failing.said('montage-status'), failing.get('montage-status')[0].dataset.problem, failing.refreshed()], [['Export impossible : Prise 1 : cette prise n’existe plus.'], 'true', 0]);
  assert.equal(failing.get('montage-export')[0].disabled, false, 'it can be tried again');
  // Not kept: no film is asked for.
  const unsaved = await setup({ fail: { 'montages/save': 'Disque plein.' } }).open();
  unsaved.get('montage-take')[0].ondblclick();
  await unsaved.ui.exportFilm();
  assert.deepEqual(unsaved.said('montage-status'), ['Export impossible : Disque plein.']);
  assert.equal(unsaved.calls.some(call => call.route === 'montages/export'), false);
});

test('the bobine of the project is found again; renamed and taken out from the fil, another one, its format (0.6.137, 0.6.148)', async () => {
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
  // A take that is no longer in the project says so, on the timeline and in the preview.
  assert.deepEqual(f.plans().map(piece => [piece.dataset.missing, piece.children[0].textContent]), [['false', 'Prise 1'], ['true', 'Prise introuvable']]);
  f.ui.seek(6);
  const [frame] = f.get('montage-frame');
  assert.deepEqual([f.get('montage-blank')[0].hidden, frame.children[3].textContent], [false, 'Prise introuvable']);
  assert.deepEqual(f.get('montage-pick')[0].children.map(option => [option.textContent, option.value, Boolean(option.selected)]), [
    ['Le pêcheur à l’aube', id(900), true],
    ['+ Nouvelle bobine', 'new', false],
    ['Renommer la bobine', 'rename', false],
    ['Supprimer la bobine', 'remove', false],
  ]);
  // « Renommer la bobine »: its name in place of the list; Échap leaves it as it was, Entrée keeps it.
  f.pick('rename');
  assert.deepEqual([f.get('bobine-name')[0].value, f.get('bobine-name')[0].attributes['aria-label'], f.get('montage-pick').length], ['Le pêcheur à l’aube', 'Nom de la bobine', 0]);
  Object.assign(f.get('bobine-name')[0], { value: 'Autre' }).onkeydown({ key: 'Escape' });
  assert.deepEqual([f.ui.state().montage.name, f.get('bobine-name').length, f.get('montage-pick').length], ['Le pêcheur à l’aube', 0, 1]);
  f.pick('rename');
  Object.assign(f.get('bobine-name')[0], { value: '  Aube  ' }).onkeydown({ key: 'Enter' });
  assert.deepEqual([f.ui.state().montage.name, f.get('montage-pick')[0].children[0].textContent], ['Aube', 'Aube']);
  // Its format, under the preview: every take to create will be made at its size.
  Object.assign(f.get('montage-format')[0], { value: '9:16' }).onchange();
  assert.deepEqual([f.ui.state().montage.width, f.ui.state().montage.height], [768, 1344]);
  await f.later();
  assert.equal(f.saves().length, 1);
  // Another bobine: what is not kept yet is first, then an empty one, not kept until something is laid.
  f.pick('new');
  await settle();
  assert.deepEqual([f.ui.state().stored, f.ui.state().montage.plans.length], [false, 0]);
  assert.deepEqual(f.get('montage-pick')[0].children.map(option => option.textContent), ['Sans titre', 'Aube', '+ Nouvelle bobine', 'Renommer la bobine']);
  // Back to the first, then taken out: asked in the fil, « Garder » leaves it, « Supprimer » does it.
  f.pick(id(900));
  await settle();
  assert.equal(f.ui.state().montage.name, 'Aube');
  f.pick('remove');
  assert.deepEqual(f.said('bobine-ask'), ['Supprimer « Aube » ?']);
  f.button('Garder').onclick();
  assert.deepEqual([f.get('bobine-ask').length, f.get('montage-pick').length, f.calls.some(call => call.route === 'montages/remove')], [0, 1, false]);
  f.pick('remove');
  f.button('Supprimer').onclick();
  await settle();
  await settle();
  assert.deepEqual(f.calls.find(call => call.route === 'montages/remove').body, { project: 'inbox', id: id(900) });
  assert.deepEqual([f.notices, f.ui.state().stored, f.ui.state().montage.plans.length], [['Bobine mise de côté.'], false, 0]);
});

test('leaving the page stops the film and keeps what was not kept yet (0.6.137)', async () => {
  const f = await setup().open();
  f.get('montage-take')[0].ondblclick();
  f.ui.play();
  await f.ui.leave();
  assert.deepEqual([f.ui.state().playing, f.saves().length], [false, 1]);
  // Back on the page: the same bobine, as it was left.
  f.root = f.ui.desk();
  assert.equal(f.plans().length, 1);
  assert.equal(f.calls.filter(call => call.route === 'montages/inbox').length, 1, 'not read again for the same project');
});

// ------------------------------------------------------------------ takes to create (0.6.142)
// Photos laid on their track above the takes, takes to create, and « À créer ».
const event = clientX => ({ clientX, prevented: false, preventDefault() { this.prevented = true; } });
const photos = () => [take(5, 'image'), take(6, 'image')];
// (0.6.152) The photos laid on the track of the photos, not its empty places.
const laid = f => find(f.root, 'montage-photo').filter(pin => !pin.className.includes('is-slot'));
const made = (n, frames, more = {}) => take(n, 'video', { parameters: { frames, fps: 24, ...more } });
// His three photos at 0, 5 and 7 seconds (ten seconds on a lane of 1000): two takes to create, the
// first from a photo to a photo, the second from where the first arrives to its own photo.
const lay = f => {
  for (const [at, x] of [[2, 0], [4, 500], [5, 700]]) {
    f.get('montage-take')[at].ondragstart({ dataTransfer: { setData() {} } });
    f.photos().ondrop(event(x));
  }
};

test('a take dragged to the timeline is laid where it is dropped; a sound on the track it is dropped on (0.6.137, 0.6.149)', async () => {
  // (Eight seconds of takes: twenty on 2000 pixels, a second is 100.)
  const f = await setup({ width: 2000 }).open();
  for (const at of [0, 1]) f.get('montage-take')[at].ondblclick();
  const carry = at => f.get('montage-take')[at].ondragstart({ dataTransfer: { setData() {} } }),
    starts = () => f.ui.state().montage.plans.map(plan => plan.at);
  // A clip over the takes: accepted there, not over a track of sounds.
  carry(2);
  const over = event(100),
    refused = event(100);
  f.lanes()[0].ondragover(over);
  f.lanes()[1].ondragover(refused);
  assert.deepEqual([over.prevented, refused.prevented], [true, false]);
  // Dropped at one second: on the first half of the first take, before it; what touches it goes later.
  f.lanes()[0].ondrop(event(100));
  assert.deepEqual([f.names(), starts()], [['Prise 3', 'Prise 1', 'Prise 2'], [0, 3, 8]]);
  // (0.6.149) Dropped in the void after the bobine: where it is dropped, a hole before it.
  carry(1);
  f.lanes()[0].ondrop(event(1990));
  assert.deepEqual([f.names(), starts()], [['Prise 3', 'Prise 1', 'Prise 2', 'Prise 2'], [0, 3, 8, 19.9]]);
  // In that hole the ghost of 5 s goes where the pointer is, never over the take after it (thirty
  // seconds shown now: 19 s is at 1267 pixels; the hole goes from 11 to 19,9 s).
  f.lanes()[0].onpointermove({ clientX: 1270, target: f.lanes()[0] });
  assert.equal(f.get('bobine-ghost')[0].style.left, pc(14.9, 30));
  // A few pixels from the end of a take, against it.
  // (Thirty seconds shown now: 11 s is at 733 pixels.)
  carry(2);
  f.lanes()[0].ondrop(event(736));
  assert.deepEqual(starts(), [0, 3, 8, 11, 19.9]);
  // A music dropped on « Piste audio 2 » goes there, where it is dropped (100 pixels are 1,5 s).
  carry(3);
  const sound = event(100);
  f.lanes()[2].ondragover(sound);
  f.lanes()[2].ondrop(event(100));
  assert.deepEqual([sound.prevented, f.ui.state().montage.sounds.map(item => [item.track, item.at])], [true, [['effects', 1.5]]]);
  assert.deepEqual([f.lanes()[1].children.filter(child => child.className.includes('montage-piece')).length, f.lanes()[2].children.length], [0, 1]);
  // Nothing carried: a drop of anything else (a file of the computer) changes nothing.
  f.lanes()[0].ondrop(event(10));
  assert.equal(f.plans().length, 5);
});

test('in the void, a ghost of 5 s follows the pointer; a click lays it (0.6.169), a press pulled draws a take to create (0.6.149)', async () => {
  // (Captures 71, 75 et 76. A video of five seconds: the timeline shows ten, on 1000 pixels.)
  const empty = await setup().open();
  // An empty bobine: the ghost at its start, breathing.
  const [still] = empty.get('bobine-ghost');
  assert.deepEqual([still.hidden, still.dataset.breathing, still.style.left, still.style.width, still.textContent], [false, 'true', '0%', 'calc(50% - 4px)', '+']);
  const f = await setup({ create: async () => null }).open();
  f.get('montage-take')[0].ondblclick();
  const [lane] = f.lanes(),
    shade = () => f.get('bobine-ghost')[0],
    plans = () => f.ui.state().montage.plans.map(plan => [plan.at, plan.to - plan.from, Boolean(plan.todo)]);
  assert.equal(shade().hidden, true);
  // Over the video, no ghost; in the void after it, centred on the pointer, never over the video.
  lane.onpointermove({ clientX: 300, target: f.plans()[0] });
  assert.equal(shade().hidden, true);
  lane.onpointermove({ clientX: 800, target: lane });
  assert.deepEqual([shade().hidden, shade().style.left, shade().style.width], [false, '55%', 'calc(50% - 4px)']);
  lane.onpointermove({ clientX: 600, target: lane });
  assert.equal(shade().style.left, '50%');
  lane.onpointerleave();
  assert.equal(shade().hidden, true);
  // A click lays it there (0.6.169, his words of 21/11: « Je ne veux plus de double click pour ajouter une
  // prise vide, mais un simple click. »): a take to create of five seconds, chosen; its line waits for its text.
  lane.onclick({ clientX: 900, target: lane });
  assert.deepEqual(plans(), [[0, 5, false], [6.5, 5, true]]);
  assert.deepEqual([f.ui.state().chosen, f.lines()], [f.ui.state().montage.plans[1].id, [['06.50 → 11.50', '', 'Nouvelle prise', '']]]);
  // Pressed in the hole between them and pulled: drawn there, as long as it is pulled, within the hole;
  // a few pixels from the end of the video, against it. (Twenty seconds shown now: 50 pixels a second.)
  const draw = (from, to) => {
    f.pressVoid(from);
    f.pointer.move(to);
  };
  draw(255, 265);
  assert.deepEqual([f.ui.state().drawing, f.root.dataset.held], [{ from: 5, to: 5.3 }, 'draw']);
  assert.deepEqual([shade().hidden, shade().dataset.drawn, find(shade(), 'bobine-ghost-length')[0].textContent], [false, 'true', '00.30 s']);
  // (Pulled beyond the take after the hole, it stops at it.)
  f.pointer.move(900);
  assert.deepEqual(f.ui.state().drawing, { from: 5, to: 6.5 });
  // Let go short: a clip has a second at least.
  f.pointer.move(265);
  f.pointer.up();
  assert.deepEqual(plans(), [[0, 5, false], [5, 1, true], [6.5, 5, true]]);
  assert.deepEqual([f.ui.state().drawing, f.root.dataset.held], [null, undefined]);
  // (The click the browser sends after drawing chooses nothing more: the take drawn is chosen.)
  f.lanes()[0].onclick({ clientX: 900, target: f.lanes()[0] });
  assert.equal(f.ui.state().chosen, f.ui.state().montage.plans[1].id);
  // Drawn from right to left in the void after the bobine: from where the pointer goes to where it was pressed.
  draw(950, 760);
  assert.deepEqual(f.ui.state().drawing, { from: 15.2, to: 19 });
  f.pointer.move(0);
  assert.deepEqual(f.ui.state().drawing, { from: 11.5, to: 19 });
  f.pointer.up();
  assert.deepEqual(plans().at(-1), [11.5, 7.5, true]);
  // A press let go without moving draws nothing: the click after it lays a take of five seconds there.
  await f.later();
  f.pressVoid(990);
  f.pointer.up();
  assert.equal(f.ui.state().montage.plans.length, 4);
  f.lanes()[0].onclick({ clientX: 990, target: f.lanes()[0] });
  assert.deepEqual(plans().at(-1), [27.2, 5, true]);
  assert.equal(f.ui.state().chosen, f.ui.state().montage.plans.at(-1).id);
  // (The second click of a double click, on the take just laid, keeps it chosen: one take, not two.)
  f.plans().at(-1).onclick({ detail: 2 });
  assert.deepEqual([f.ui.state().montage.plans.length, f.ui.state().chosen], [5, f.ui.state().montage.plans.at(-1).id]);
  f.ui.undo();
  // A drawn take never goes on from what is before it: a clip of its own, from its text.
  assert.deepEqual(f.lines().map(line => line[2]), ['Nouvelle prise', 'Nouvelle prise', 'Nouvelle prise']);
  await f.later();
  assert.deepEqual(f.saves().at(-1).body.montage.plans.map(plan => [plan.at, plan.todo?.suite ?? null]), [[0, null], [5, null], [6.5, null], [11.5, null]]);
  // (0.6.152) Longer than its model makes at once, it is made in equal parts: a minute at most.
  // (Here nobody knows the model: parts of twenty seconds at most.)
  const g = await setup().open();
  g.pressVoid(0);
  g.pointer.move(3000);
  assert.deepEqual(g.ui.state().drawing, { from: 0, to: 30 });
  g.pointer.move(9000);
  assert.deepEqual(g.ui.state().drawing, { from: 0, to: 60 });
  g.pointer.move(3000);
  g.pointer.up();
  assert.deepEqual(g.ui.state().montage.plans.map(plan => [plan.at, plan.to]), [[0, 30]]);
  assert.deepEqual([g.lines()[0][0], g.said('bobine-line-parts')], ['00.00 → 30.00', ['2 × 15.00 s']]);
  assert.deepEqual(find(g.plans()[0], 'bobine-part').map(cut => [cut.textContent, cut.style.left]), [['↳ Suite', '50%']]);
});

test('the timeline is zoomed by its buttons and Ctrl + the wheel, around the pointer; « Voir toute la bobine » shows it whole (0.6.149)', async () => {
  const f = await setup().open();
  f.get('montage-take')[0].ondblclick();
  const zooms = () => f.get('bobine-zoom-button'),
    reel = () => f.get('bobine-reel')[0];
  assert.deepEqual(zooms().map(control => [control.attributes['aria-label'], control.disabled]), [['Zoom arrière', true], ['Zoom avant (Ctrl + molette)', false], ['Voir toute la bobine', true]]);
  assert.deepEqual([f.get('bobine-reel-inner')[0].style['--zoom'], reel().dataset.zoomed], ['1', 'false']);
  zooms()[1].onclick();
  assert.deepEqual([f.ui.state().zoom, f.get('bobine-reel-inner')[0].style['--zoom'], reel().dataset.zoomed], [1.5, '1.5', 'true']);
  assert.deepEqual(zooms().map(control => control.disabled), [false, false, false]);
  // Ctrl + the wheel: in or out by a quarter; without Ctrl, zoomed, it scrolls from side to side.
  const wheel = (deltaY, ctrlKey) => {
    const seen = { deltaY, ctrlKey, clientX: 500, prevented: false, preventDefault() { this.prevented = true; } };
    reel().onwheel(seen);
    return seen.prevented;
  };
  assert.equal(wheel(-100, true), true);
  assert.equal(f.ui.state().zoom, 1.88);
  wheel(100, true);
  assert.equal(f.ui.state().zoom, 1.5);
  const before = f.ui.state().scrolled;
  assert.equal(wheel(120, false), true);
  assert.equal(f.ui.state().scrolled, before + 120);
  // Never beyond sixteen times; whole again, it is not scrolled.
  for (let turn = 0; turn < 12; turn++) zooms()[1].onclick();
  assert.deepEqual([f.ui.state().zoom, zooms()[1].disabled], [16, true]);
  zooms()[2].onclick();
  assert.deepEqual([f.ui.state().zoom, f.ui.state().scrolled, reel().dataset.zoomed], [1, 0, 'false']);
  // Not zoomed, the wheel is the page's.
  assert.equal(wheel(120, false), false);
  // Its scroll is kept when the timeline is drawn again.
  zooms()[1].onclick();
  reel().scrollLeft = 300;
  reel().onscroll();
  f.plans()[0].onclick();
  assert.deepEqual([reel().scrollLeft, f.ui.state().scrolled], [300, 300]);
  // (And when the whole page is drawn again: another kind of takes shown.)
  f.get('montage-filter')[1].onclick();
  assert.equal(reel().scrollLeft, 300);
});

test('a hole of the bobine is black in the preview; the empty bobine shows its Éclipse (0.6.149)', async () => {
  const f = await setup().open();
  const [frame] = f.get('montage-frame'),
    [blank, picture, video] = frame.children;
  assert.deepEqual([frame.dataset.hole, blank.hidden], ['false', false]);
  f.get('montage-take')[1].ondblclick();
  // The clip of three seconds dragged to two seconds in: a hole before it.
  f.press(f.plans()[0], 100);
  f.pointer.move(300);
  f.pointer.up();
  assert.deepEqual([f.ui.state().montage.plans[0].at, f.said('montage-clock-total')], [2, [' / 05.00']]);
  f.ui.seek(1);
  assert.deepEqual([frame.dataset.hole, blank.hidden, picture.hidden, video.hidden, frame.children[3].textContent], ['true', true, true, true, '']);
  f.ui.seek(2.5);
  assert.deepEqual([frame.dataset.hole, video.hidden, video.currentTime], ['false', false, 0.5]);
});

test('photos dragged to their track become takes to create, each against the edge of its take, listed in « À créer » (0.6.142, 0.6.149)', async () => {
  const f = await setup({ extra: photos(), create: async () => null }).open();
  const carry = at => f.get('montage-take')[at].ondragstart({ dataTransfer: { setData() {} } }),
    pins = () => laid(f).map(pin => [pin.className, pin.style.left ?? null, pin.style.right ?? null, pin.attributes['aria-label']]);
  // An image is taken there; a clip or a sound is not.
  carry(2);
  const over = event(0);
  f.photos().ondragover(over);
  carry(0);
  const refused = event(0);
  f.photos().ondragover(refused);
  assert.deepEqual([over.prevented, refused.prevented], [true, false]);
  lay(f);
  assert.deepEqual(f.plans().map(piece => [piece.className, piece.children[0].textContent]), [['montage-piece is-todo', ''], ['montage-piece is-todo', '']]);
  assert.deepEqual(f.lengths(), ['05.00 s', '02.00 s']);
  // The start photo against the left edge of its take, an end photo against the right edge of its own
  // (seven seconds: the timeline shows twenty).
  assert.deepEqual(pins(), [
    ['montage-photo is-start', '0%', null, 'Image de début, prise de 00.00 à 05.00'],
    ['montage-photo is-end', null, 'calc(75% + 4px)', 'Image de fin, prise de 00.00 à 05.00'],
    ['montage-photo is-end', null, 'calc(65% + 4px)', 'Image de fin, prise de 05.00 à 07.00'],
  ]);
  assert.deepEqual(laid(f).map(pin => [pin.style.backgroundImage, pin.textContent]), [['url("/thumb/3")', 'Début'], ['url("/thumb/5")', 'Fin'], ['url("/thumb/6")', 'Fin']]);
  // (0.6.152) Its empty place beside them: the start of the second.
  assert.deepEqual(find(f.root, 'is-slot').map(slot => slot.attributes['aria-label']), ['Image de début, prise de 05.00 à 07.00 : glissez une image ici']);
  // No film while a take is to create: said in the menu of « Exporter » (0.6.154, capture 91).
  const [go] = f.get('montage-export');
  assert.equal(go.disabled, false);
  go.onclick();
  assert.deepEqual(f.get('bobine-export-item').map(item => [item.attributes['aria-disabled'] ?? null, item.dataset.tip ?? null]), [
    ['true', '2 prises sont encore à créer'],
    ['true', 'Aucune prise n’est encore créée'],
  ]);
  go.onclick();
  // « À créer »: a line for each, in the order of the bobine. (0.6.149) The second does not go on from
  // the first: a clip of its own, towards its photo.
  assert.deepEqual(f.lines(), [
    ['00.00 → 05.00', '', 'Nouvelle prise · images de début et de fin', ''],
    ['05.00 → 07.00', '', 'Nouvelle prise · image de fin', ''],
  ]);
  // The last laid is the one chosen: its line says it, its bar is above it.
  assert.deepEqual([f.get('bobine-line').map(line => line.attributes['aria-pressed']), f.popLabels()], [['false', 'true'], ['Retirer l’image de fin', 'Retirer de la bobine (Suppr)']]);
  assert.deepEqual([f.go(), f.goMain().disabled], ['Créer', true]);
  // Written in its line: « À créer » stays under the hand, the take shows its text, the button counts.
  const [panel] = f.get('bobine-create'),
    field = f.get('bobine-line-words')[1];
  f.write(1, 'Il regarde la mer.');
  assert.deepEqual([f.get('bobine-create')[0], f.get('bobine-line-words')[1], f.ui.state().montage.plans[1].todo.prompt], [panel, field, 'Il regarde la mer.']);
  assert.deepEqual([find(f.plans()[1], 'montage-piece-kind')[0].textContent, f.go()], ['Il regarde la mer.', 'Créer 1 prise']);
  // A line chosen chooses its take and brings the head to it.
  f.get('bobine-line')[0].onclick({ target: f.get('bobine-line')[0] });
  assert.deepEqual([f.ui.state().chosen, f.ui.state().head], [f.ui.state().montage.plans[0].id, 0]);
  f.write(0, 'Il lève les yeux.');
  assert.deepEqual([f.go(), f.goMain().disabled], ['Créer 2 prises', false]);
  // Its length by its right edge, within what a clip can be; it has no left edge to pull. (Fifty
  // pixels a second: its end, at 7 s, is at 350.)
  assert.deepEqual(find(f.plans()[1], 'montage-grip').map(grip => grip.className), ['montage-grip is-end']);
  f.press(find(f.plans()[1], 'montage-grip')[0], 350);
  f.pointer.move(425);
  f.pointer.up();
  assert.deepEqual([f.ui.state().montage.plans[1].to, f.lines()[1][0]], [3.5, '05.00 → 08.50']);
  // A photo clicked chooses its take; one taken off from its bar leaves the other.
  laid(f)[0].onclick();
  assert.deepEqual([f.ui.state().chosen, f.popLabels()], [f.ui.state().montage.plans[0].id, ['Retirer l’image de début', 'Retirer l’image de fin', 'Retirer de la bobine (Suppr)']]);
  f.button('Retirer l’image de fin').onclick();
  assert.deepEqual(pins().map(pin => pin[3]), ['Image de début, prise de 00.00 à 05.00', 'Image de fin, prise de 05.00 à 08.50']);
  // A clip dropped there is no photo: said, nothing changed. All of it is kept, as any change.
  carry(0);
  f.photos().ondrop(event(100));
  assert.equal(f.notices.at(-1), 'Seule une image se pose en début ou en fin de prise.');
  assert.equal(f.plans().length, 2);
  await f.later();
  assert.equal(f.saves().at(-1).body.montage.plans[1].todo.prompt, 'Il regarde la mer.');
});

test('« Créer 1 prise » asks the Studio for the clip, shows it being made, and the take to create becomes its take (0.6.142, 0.6.149)', async () => {
  const asked = [];
  let answer = null;
  const f = await setup({
    extra: photos(),
    create: (wanted, hooks) => {
      asked.push({ wanted: structuredClone(wanted), hooks });
      return new Promise((resolve, reject) => (answer = { resolve, reject }));
    },
  }).open();
  lay(f);
  f.write(0, 'Il lève les yeux.');
  assert.deepEqual([f.go(), f.goMain().disabled], ['Créer 1 prise', false]);
  f.goMain().onclick();
  await settle();
  // Kept first, then asked as the Studio asks a clip: its text, its length, the format of the bobine, its two photos, at its size.
  assert.equal(f.saves().length, 1);
  assert.deepEqual(asked[0].wanted, {
    verb: 'create_video',
    args: { prompt: 'Il lève les yeux.', intention: INTENTION, duration: 5, format: '16:9', start_image: { output: id(3) }, end_image: { output: id(5) } },
    size: FILM,
    // (0.6.181) And where its take goes: the server keeps it with the take (a page reloaded meanwhile).
    place: placeOf(f, 0),
  });
  // Being made: said on the take, in its line, in the button that fills, in the preview (what the engine shows, blurred).
  asked[0].hooks.onProgress('Étape 3 sur 8', 0.4, '/preview/a.jpg');
  const [frame] = f.get('montage-frame'),
    [, picture, , caption] = frame.children;
  assert.deepEqual([f.plans()[0].className, f.names()[0], find(f.root, 'montage-piece-bar-done')[0].style.width], ['montage-piece is-todo is-making', 'En cours · 40 %', '40%']);
  assert.deepEqual([f.lines()[0][1], f.get('bobine-line')[0].dataset.state], ['En cours · 40 %', 'making']);
  assert.deepEqual([f.go(), f.goMain().disabled, f.get('bobine-go-fill')[0].style.width], ['1 sur 1 · 40 %', true, '40%']);
  assert.deepEqual([picture.src, picture.hidden, caption.textContent, frame.dataset.busy], ['/preview/a.jpg', false, 'En cours · 40 %', 'true']);
  // (0.6.159, capture 87) No text over what is being made: it covered the frame, under « EN COURS ».
  const [words] = find(frame, 'montage-frame-words');
  assert.deepEqual([words.hidden, words.textContent], [true, '']);
  // Nothing else is changed meanwhile: not exported, not another bobine, not another format, no text.
  assert.deepEqual([f.get('montage-export')[0].disabled, f.get('montage-pick')[0].disabled, f.get('montage-format')[0].disabled, f.get('bobine-line-words')[0].disabled], [true, true, true, true]);
  f.plans()[1].onkeydown({ key: 'Delete' });
  assert.deepEqual([f.plans().length, f.notices.at(-1)], [2, 'Des prises sont en cours de création : attendez la fin, ou arrêtez.']);
  // Made (the Studio has read the takes of the project again): the take to create is the take made;
  // what touches it follows its length (0.6.149).
  f.runs.push(made(50, 121));
  answer.resolve(f.runs.at(-1));
  await settle();
  assert.deepEqual([f.plans()[0].className, f.names()[0], f.lengths()[0]], ['montage-piece', 'Prise 50', '05.04 s']);
  assert.deepEqual([f.ui.state().making, f.ui.state().filling, f.get('bobine-line').length], [null, null, 1]);
  // (0.6.159, capture 88) Made, it has no photo any more: none is left above it on the track of the photos.
  assert.deepEqual(f.ui.state().montage.plans[0], { id: f.ui.state().montage.plans[0].id, at: 0, kind: 'video', from: 0, to: 5.042, frame: 'fit', volume: 1, source: { conversationId: C, runId: id(50), output: 0 } });
  assert.deepEqual(laid(f).map(pin => pin.dataset.plan), [f.ui.state().montage.plans[1].id]);
  assert.deepEqual([f.saves().at(-1).body.montage.plans[0].source.runId, f.ui.state().montage.plans[1].at], [id(50), 5.042]);
  // (0.6.149) The second is a clip of its own, towards its photo: nothing of the first is asked for it.
  assert.deepEqual([f.plans()[1].className, f.names()[1], f.lines()[0][2]], ['montage-piece is-todo', '', 'Nouvelle prise · image de fin']);
  f.write(0, 'Il regarde la mer.');
  f.goMain().onclick();
  await settle();
  assert.deepEqual(asked[1].wanted.args, { prompt: 'Il regarde la mer.', intention: INTENTION, duration: 2, format: '16:9', end_image: { output: id(6) } });
  // Refused by the engine: said in its line, in amber; the take is still to create and can be tried again.
  answer.reject(new Error('Mémoire vidéo insuffisante.'));
  await settle();
  assert.deepEqual([f.lines(), f.get('bobine-line')[0].dataset.state], [[['05.04 → 07.04', 'Échec', 'Nouvelle prise · image de fin', 'Mémoire vidéo insuffisante.']], 'failed']);
  assert.deepEqual([f.plans()[1].className, f.names()[1], f.ui.state().making, f.go(), f.goMain().disabled], ['montage-piece is-todo is-failed', 'Échec', null, 'Créer 1 prise', false]);
  // Its suite pulled from the end of the take made (fifty pixels a second: 5,04 s is at 252): the
  // continuation itself, whose file holds the take first; the take after it goes later.
  f.press(find(f.plans()[0], 'montage-grip')[1], 252);
  f.pointer.move(352);
  f.pointer.up();
  assert.deepEqual([f.names(), f.lines().map(line => line.slice(0, 3))], [['Prise 50', '↳ Suite', 'Échec'], [['05.04 → 07.04', '', 'Suite de la prise 50'], ['07.04 → 09.04', 'Échec', 'Nouvelle prise · image de fin']]]);
  f.write(0, 'Il se retourne.');
  // Both are made, one after the other: the suite first, as the Studio prolongs a clip.
  assert.equal(f.go(), 'Créer 2 prises');
  f.goMain().onclick();
  await settle();
  // (0.6.181) A suite: its take holds the video it goes on from, and is shown from the end of that one.
  assert.deepEqual(asked[2].wanted, { verb: 'extend_video', args: { prompt: 'Il se retourne.', intention: INTENTION, duration: 2, source: { output: id(50) } }, size: FILM, place: placeOf(f, 1, 5.042) });
  f.runs.push(made(51, 49, { continuation: { overlapFrames: 9, sourceFrames: 121, newFrames: 40 } }));
  answer.resolve(f.runs.at(-1));
  await settle();
  await settle();
  assert.deepEqual([f.ui.state().montage.plans[1].from, f.ui.state().montage.plans[1].to, f.names()[1], f.lengths()[1], f.ui.state().montage.plans[2].at], [5.042, 6.708, 'Prise 51', '01.67 s', 6.708]);
  // The other could not begin, nothing coming back from `create` (the Studio now refuses with its reason,
  // 0.6.175: see below): said in its line.
  assert.deepEqual(asked[3].wanted.args.end_image, { output: id(6) });
  answer.resolve(null);
  await settle();
  assert.deepEqual(f.lines()[0].slice(1), ['Échec', 'Nouvelle prise · image de fin', 'La création n’a pas pu commencer.']);
  // Taken out, every take is made: the film can be exported.
  f.plans()[2].onkeydown({ key: 'Delete' });
  assert.equal(f.get('montage-export')[0].disabled, false);
});

test('a take to create whose images are gone says which, in the words of the Bobine: « image de début », « image de fin » (0.6.190)', async () => {
  // (0.6.190, capture 104) « Image » in the Bobine, no longer « Photo ». The track keeps its name (PHOTOS), and the
  // data their keys (`photos`).
  const photo = n => ({ conversationId: C, runId: id(n), output: 0 }),
    asked = [],
    create = async wanted => (asked.push(wanted), null),
    stored = (prompt, photos) => ({
      schemaVersion: 1, id: id(960), name: 'Le phare', format: '16:9', width: 1344, height: 768, fps: 24, sounds: [],
      plans: [{ id: id(961), kind: 'video', todo: { prompt }, from: 0, to: 5, frame: 'fit', volume: 1, photos }],
    }),
    reasons = f => f.lines().map(line => line[3]);
  // Its two images taken out of the project since (the takes 42 and 43): « Créer » says which; nothing is asked.
  let f = await setup({ stored: [stored('Le phare s’allume.', { start: photo(42), end: photo(43) })], create }).open();
  await settle();
  assert.deepEqual([f.go(), f.goMain().disabled], ['Créer 1 prise', false]);
  f.goMain().onclick();
  await settle();
  assert.deepEqual(reasons(f), ['L’image de début n’est plus dans le projet.']);
  f.get('bobine-line')[0].onclick({ target: f.get('bobine-line')[0] });
  if (f.ui.state().chosen !== id(961)) f.get('bobine-line')[0].onclick({ target: f.get('bobine-line')[0] });
  assert.deepEqual(f.popLabels().slice(0, 2), ['Retirer l’image de début', 'Retirer l’image de fin']);
  f.button('Retirer l’image de début').onclick();
  f.goMain().onclick();
  await settle();
  assert.deepEqual(reasons(f), ['L’image de fin n’est plus dans le projet.']);
  // Without its text, Moodix AI would write it from its image, gone too: said in the same words.
  f = await setup({ stored: [stored('', { start: photo(42) })], create, write: async () => ({ prompt: 'Le phare s’allume.' }) }).open();
  await settle();
  assert.deepEqual([f.go(), f.goMain().disabled], ['Créer 1 prise', false]);
  f.goMain().onclick();
  await settle();
  assert.deepEqual(reasons(f), ['Moodix AI n’a rien à regarder : posez une image de début ou de fin, ou écrivez ce qui se passe.']);
  assert.equal(asked.length, 0);
});

test('a photo laid above a video cuts it there: its end is greyed until the new clip is made (0.6.142, 0.6.148)', async () => {
  const f = await setup({ extra: photos() }).open();
  const carry = at => f.get('montage-take')[at].ondragstart({ dataTransfer: { setData() {} } });
  f.get('montage-take')[0].ondblclick();
  // Three seconds into a clip of five: kept up to there, the two that follow will be replaced.
  carry(2);
  f.photos().ondrop(event(300));
  assert.deepEqual(f.plans().map(piece => [piece.className, piece.children[0].textContent, piece.style.backgroundImage]), [
    ['montage-piece', 'Prise 1', 'url("/thumb/1")'],
    ['montage-piece is-todo is-replacing', 'Sera remplacé', 'url("/thumb/1")'],
  ]);
  assert.deepEqual([f.lengths(), laid(f).map(pin => [pin.className, pin.style.left])], [['03.00 s', '02.00 s'], [['montage-photo is-start', '30%']]]);
  assert.deepEqual(f.lines(), [['03.00 → 05.00', '', 'Nouvelle prise · image de début', '']]);
  // In the preview, a take to create is the photo it starts on, veiled; without one, the empty frame.
  const [frame] = f.get('montage-frame'),
    [blank, picture, video, caption] = frame.children;
  f.ui.seek(4);
  assert.deepEqual([picture.src, picture.hidden, video.hidden, caption.textContent, frame.dataset.todo], ['/media/3', false, true, 'À créer', 'true']);
  assert.deepEqual(f.popLabels(), ['Retirer l’image de début', 'Retirer, et rendre sa fin à la vidéo']);
  f.button('Retirer l’image de début').onclick();
  f.ui.seek(4);
  assert.deepEqual([blank.hidden, picture.hidden, caption.textContent], [false, true, 'À créer']);
  // (0.6.149) Without its photo it is a clip of its own, from its text: it does not go on from the video.
  f.write(0, 'Il plonge.');
  f.get('bobine-line')[0].onclick({ target: f.get('bobine-line')[0] });
  assert.deepEqual(f.lines(), [['03.00 → 05.00', '', 'Nouvelle prise', '']]);
  // Without a creation here, nothing can be created; taken out, the video has its end back.
  assert.deepEqual([f.go(), f.goMain().disabled], ['Créer 1 prise', true]);
  f.button('Retirer, et rendre sa fin à la vidéo').onclick();
  assert.deepEqual([f.names(), f.lengths(), f.get('bobine-line').length], [['Prise 1'], ['05.00 s'], 0]);
  // Too near the end of the video, nothing would be replaced: said, nothing changed.
  carry(2);
  f.photos().ondrop(event(450));
  assert.match(f.notices.at(-1), /^Posez l’image plus tôt/);
  assert.equal(f.plans().length, 1);
});

test('a take whose small picture has just been made shows it on the timeline at once (0.6.142)', async () => {
  // (Seen on the card, 20/11: the take just created was black on the timeline until the next change,
  // its tile showing its picture beside. The picture is made from the tile of the take, once its clip is read.)
  const fresh = take(9, 'video', { parameters: { frames: 48, fps: 24 }, outputs: [{ take: 9, originalUrl: '/media/9' }] });
  const f = await setup({ extra: [fresh], thumbnail: async (api, record) => void (record.outputs[0].thumbUrl = '/thumb/9') }).open();
  const tile = () => f.get('montage-take').find(item => item.dataset.id === id(9));
  tile().ondblclick();
  assert.deepEqual([f.plans().length, f.plans()[0].style.backgroundImage], [1, undefined]);
  const [panel] = f.get('bobine-create');
  tile().querySelectorAll('VIDEO')[0].onloadeddata();
  await settle();
  assert.equal(f.plans()[0].style.backgroundImage, 'url("/thumb/9")');
  // (Only the timeline is drawn again: what is being written in « À créer » stays under the hand.)
  assert.equal(f.get('bobine-create')[0], panel);
  // A take that is on no take of the bobine draws nothing again.
  const other = take(10, 'video', { parameters: { frames: 48, fps: 24 }, outputs: [{ take: 10, originalUrl: '/media/10' }] });
  const g = await setup({ extra: [other], thumbnail: async (api, record) => void (record.outputs[0].thumbUrl = '/thumb/10') }).open();
  const lane = g.lanes()[0];
  g.get('montage-take').find(item => item.dataset.id === id(10)).querySelectorAll('VIDEO')[0].onloadeddata();
  await settle();
  assert.equal(g.lanes()[0], lane);
});

test('the end of a video pulled beyond its take shows its suite to create, joined to it (0.6.143, 0.6.149)', async () => {
  // (Maquette M6, his words of 20/11: « s'il déroule la vidéo plus loin que sa durée d'origine, on lui
  // montre implicitement que ça va continuer sa vidéo (et ça déplace les images ou vidéos vers la droite) ».)
  // (Eight seconds of takes: twenty on 2000 pixels, a second is 100.)
  const f = await setup({ extra: photos(), create: async () => null, width: 2000 }).open();
  for (const at of [0, 2]) f.get('montage-take')[at].ondblclick();
  const grips = () => find(f.root, 'montage-grip'),
    plans = () => f.ui.state().montage.plans,
    look = () => f.plans().map(piece => [piece.className, piece.children[0].textContent, find(piece, 'montage-piece-length')[0].textContent, piece.style.left, piece.style.width]);
  assert.deepEqual(grips().map(grip => grip.className), ['montage-grip is-start', 'montage-grip is-end', 'montage-grip is-end']);
  // The end of the video, at 500 pixels. A little beyond the end of its
  // take: the whole take, nothing more, the hand can stop there.
  f.press(grips()[1], 500);
  f.pointer.move(540);
  assert.deepEqual([plans().length, plans()[0].to, f.get('montage-tip').length], [2, 5, 0]);
  // Four seconds beyond: its suite to create, touching it; the image comes later in the bobine.
  f.pointer.move(900);
  assert.deepEqual(look(), [
    ['montage-piece', 'Prise 1', '05.00 s', '0%', 'calc(25% - 4px)'],
    ['montage-piece is-todo is-suite', '↳ Suite', '+04.00 s', 'calc(25% - 4px)', '20%'],
    ['montage-piece', 'Prise 3', '03.00 s', '45%', 'calc(15% - 4px)'],
  ]);
  // (0.6.155) Nothing said over the ruler: « +04.00 s » on the take says it. The video stays the one in hand.
  assert.equal(f.get('montage-tip').length, 0);
  assert.equal(f.ui.state().chosen, plans()[0].id);
  // Pulled back within the take: gone, as if nothing had been asked.
  f.pointer.move(450);
  assert.deepEqual([plans().length, plans()[0].to, f.get('montage-tip').length], [2, 4.5, 0]);
  // Beyond again, and let go: the suite is chosen, what happens next is written in its line.
  f.pointer.move(700);
  f.pointer.up();
  assert.deepEqual([plans().length, plans()[0].to, plans()[1].to, f.ui.state().chosen === plans()[1].id, f.get('montage-tip').length], [3, 5, 2, true, 0]);
  assert.deepEqual([f.lines(), f.popLabels()], [[['05.00 → 07.00', '', 'Suite de la prise 1', '']], ['Retirer de la bobine (Suppr)']]);
  await f.later();
  assert.deepEqual(f.saves().at(-1).body.montage.plans.map(plan => [Boolean(plan.todo), plan.to]), [[false, 5], [true, 2], [false, 3]]);
  // It has its suite: the edge of the video stops at the end of its take, the suite has its own edge.
  f.press(grips()[1], 500);
  f.pointer.move(800);
  f.pointer.up();
  assert.deepEqual(plans().map(plan => plan.to), [5, 2, 3]);
  f.press(grips()[2], 700);
  f.pointer.move(850);
  f.pointer.up();
  assert.deepEqual([plans().map(plan => plan.to), f.lengths()[1]], [[5, 3.5, 3], '+03.50 s']);
  // Towards an end photo it is a new clip, from the last image of the video: said as it is.
  f.get('montage-take')[4].ondragstart({ dataTransfer: { setData() {} } });
  // (The bobine is 11,5 s long now, still twenty shown: 7,5 s, on the second half of the suite.)
  f.photos().ondrop(event(750));
  assert.deepEqual([f.plans()[1].className, f.lines()[0][2]], ['montage-piece is-todo is-suite', 'Suite de la prise 1 · image de fin']);
  // Taken out: the bobine as it was.
  f.button('Retirer de la bobine (Suppr)').onclick();
  assert.deepEqual(look(), [
    ['montage-piece', 'Prise 1', '05.00 s', '0%', 'calc(25% - 4px)'],
    ['montage-piece', 'Prise 3', '03.00 s', '25%', 'calc(15% - 4px)'],
  ]);
  // Neither an image nor a take to create is continued by its edge: the edge of an image is its length.
  f.press(grips()[2], 800);
  f.pointer.move(1000);
  f.pointer.up();
  assert.deepEqual(plans().map(plan => [plan.kind, plan.to]), [['video', 5], ['image', 5]]);
  // (Nothing after the video: its suite, and still nothing said over the ruler.)
  const alone = await setup().open();
  alone.get('montage-take')[0].ondblclick();
  alone.press(find(alone.root, 'montage-grip')[1], 500);
  alone.pointer.move(900);
  assert.deepEqual([alone.said('montage-tip'), alone.ui.state().montage.plans.length], [[], 2]);
  alone.pointer.up();
  assert.equal(alone.ui.state().chosen, alone.ui.state().montage.plans[1].id);
});

test('when LTX 2.5 is here, every take of the bobine is asked to it by its name, its model said in its line (0.6.151)', async () => {
  // (His answer of 20/11, « Oui, LTX 2.5 »: on the card, a take drawn of 1,90 s had gone to MiniMax
  // H3 Omni, the model the server prefers, which made 5,17 s of it in 201 s.)
  const asked = [],
    foreseen = [];
  const f = await setup({
    modelFor: verb => (['create_video', 'extend_video'].includes(verb) ? 'ltx-25' : null),
    create: wanted => (asked.push(structuredClone(wanted)), new Promise(() => {})),
    estimate: async wanted => (foreseen.push(structuredClone(wanted)), { workflowName: 'LTX 2.5' }),
  }).open();
  f.get('montage-take')[0].ondblclick();
  // A suite pulled from the video (ten seconds shown on 1000 pixels), then a take laid in the void
  // after it by a click (twenty seconds shown now).
  f.press(find(f.root, 'montage-grip')[1], 500);
  f.pointer.move(700);
  f.pointer.up();
  await f.later();
  f.lanes()[0].onclick({ clientX: 600, target: f.lanes()[0] });
  f.write(0, 'Il se retourne.');
  f.write(1, 'La brume se lève.');
  await settle();
  // Both asked by its name, the suite and the new take, to know their model as to make them.
  assert.deepEqual(foreseen.map(wanted => [wanted.verb, wanted.args.workflow]), [['extend_video', 'ltx-25'], ['create_video', 'ltx-25']]);
  assert.deepEqual(f.lines().map(line => [line[1], line[2]]), [['LTX 2.5', 'Suite de la prise 1'], ['LTX 2.5', 'Nouvelle prise']]);
  f.goMain().onclick();
  await settle();
  assert.deepEqual(asked[0], { verb: 'extend_video', args: { prompt: 'Il se retourne.', intention: INTENTION, duration: 2, workflow: 'ltx-25', source: { output: id(1) } }, size: FILM, place: placeOf(f, 1, 5) });
  // Without it, nothing is named: the server chooses, as for any creation.
  const g = await setup({ create: wanted => (asked.push(structuredClone(wanted)), new Promise(() => {})) }).open();
  g.lanes()[0].onclick({ clientX: 300, target: g.lanes()[0] });
  g.write(0, 'La brume se lève.');
  g.goMain().onclick();
  await settle();
  assert.equal('workflow' in asked.at(-1).args, false);
});

test('a take longer than its model makes is cut live in equal parts; « Créer » counts each and makes them one after the other (0.6.152)', async () => {
  // (Capture 74. LTX 2.5 makes 10,04 s of a clip, 9,67 s of a continuation.)
  const asked = [],
    answers = [];
  const f = await setup({
    extra: [made(7, 120)],
    modelFor: () => 'ltx-25',
    longestFor: verb => ({ create_video: 10.04, extend_video: 9.67 })[verb],
    create: wanted => (asked.push(structuredClone(wanted)), new Promise((resolve, reject) => answers.push({ resolve, reject }))),
  }).open();
  f.get('montage-take')[4].ondblclick();
  // The end of the video of five seconds pulled beyond it (ten seconds shown on 1000 pixels): within
  // what a continuation makes at once, one suite; further, cut live in two equal parts.
  f.press(find(f.root, 'montage-grip')[1], 500);
  f.pointer.move(1400);
  assert.deepEqual([f.ui.state().montage.plans[1].to, find(f.plans()[1], 'bobine-part').length], [9, 0]);
  f.pointer.move(1600);
  assert.deepEqual(find(f.plans()[1], 'bobine-part').map(cut => [cut.textContent, cut.style.left]), [['↳ Suite', '50%']]);
  f.pointer.up();
  // One line for it, one text: « 2 × 05.50 s »; the button counts each part.
  assert.deepEqual([f.lines(), f.said('bobine-line-parts')], [[['05.00 → 16.00', '', 'Suite de la prise 7', '']], ['2 × 05.50 s']]);
  f.write(0, 'Il marche vers la mer.');
  assert.equal(f.go(), 'Créer 2 prises');
  f.goMain().onclick();
  await settle();
  // The first part: a continuation of the video, half of it, asked to LTX 2.5.
  assert.deepEqual(asked[0], { verb: 'extend_video', args: { prompt: 'Il marche vers la mer.', intention: INTENTION, duration: 5.5, workflow: 'ltx-25', source: { output: id(7) } }, size: FILM, place: placeOf(f, 1, 5) });
  assert.deepEqual([f.go(), f.names()], ['1 sur 2', ['Prise 7', 'En cours']]);
  // Made: the part is its take, what is left a suite of it, still to the same end; asked in its turn.
  // (0.6.181) Its record says its place, as the server keeps it. The page that asked lays it itself, once:
  // the takes read again before it is handed back, or after, lay nothing more (what is left of the take
  // keeps its id: laid twice, its first part was its second too).
  f.runs.push({ ...made(60, 252, { continuation: { overlapFrames: 9, sourceFrames: 120, newFrames: 132 } }), createdAt: '2026-11-20T03:05:00.000Z', bobine: asked[0].place });
  f.ui.refreshed();
  assert.deepEqual([f.names(), f.ui.state().montage.plans.length], [['Prise 7', 'En cours'], 2]);
  answers[0].resolve(f.runs.at(-1));
  await settle();
  await settle();
  f.ui.refreshed();
  assert.deepEqual(f.ui.state().montage.plans.map(plan => [plan.at, plan.from, plan.to, Boolean(plan.todo)]), [[0, 0, 5, false], [5, 5, 10.5, false], [10.5, 0, 5.5, true]]);
  assert.deepEqual([f.lines().map(line => line.slice(0, 3)), f.said('bobine-line-parts'), f.go()], [[['10.50 → 16.00', 'En cours', 'Suite de la prise 60']], [], '2 sur 2']);
  assert.deepEqual(asked[1].args, { prompt: 'Il marche vers la mer.', intention: INTENTION, duration: 5.5, workflow: 'ltx-25', source: { output: id(60) } });
  assert.deepEqual(asked[1].place, placeOf(f, 2, 10.5));
  f.runs.push(made(61, 384, { continuation: { overlapFrames: 9, sourceFrames: 252, newFrames: 132 } }));
  answers[1].resolve(f.runs.at(-1));
  await settle();
  await settle();
  assert.deepEqual([f.names(), f.get('bobine-line').length, f.ui.state().filling, f.ui.state().montage.plans.map(plan => [plan.from, plan.to])], [['Prise 7', 'Prise 60', 'Prise 61'], 0, null, [[0, 5], [5, 10.5], [10.5, 16]]]);
});

test('a photo carried lights up the places where it can go; it goes in the one it is dropped on, never shared (0.6.152)', async () => {
  // (Captures 77 et 79: « tous les emplacements où elle peut aller s'allument […] ; les photos déjà
  // posées s'entourent, on peut les remplacer », « jamais partagées ».)
  const f = await setup({ extra: photos() }).open();
  f.get('montage-take')[0].ondblclick();
  // A suite pulled from the video (5 to 7 s), then a take drawn right after it, touching it (7 to 11 s;
  // twenty seconds shown on 1000 pixels).
  f.press(find(f.root, 'montage-grip')[1], 500);
  f.pointer.move(700);
  f.pointer.up();
  await f.later();
  f.pressVoid(352);
  f.pointer.move(550);
  f.pointer.up();
  await f.later();
  const [, suite, drawn] = f.ui.state().montage.plans.map(plan => plan.id),
    carry = at => f.get('montage-take')[at].ondragstart({ dataTransfer: { setData() {} } }),
    put = (target, plan) => {
      const over = { ...event(0), stopPropagation() {} };
      target.ondragover(over);
      assert.deepEqual([over.prevented, target.dataset.over], [true, 'true'], plan);
      target.ondrop({ ...event(0), stopPropagation() {} });
    },
    slot = (plan, side) => find(f.root, 'is-slot').find(item => item.dataset.plan === plan && item.className.includes('is-' + side));
  assert.deepEqual(f.ui.state().montage.plans.map(plan => plan.at), [0, 5, 7]);
  // Its empty places, always shown: the end of the suite (a suite has no start photo), the start and the end of the other.
  assert.deepEqual(find(f.root, 'is-slot').map(item => [item.className, item.dataset.plan]), [
    ['montage-photo is-end is-slot', suite],
    ['montage-photo is-start is-slot', drawn],
    ['montage-photo is-end is-slot', drawn],
  ]);
  assert.deepEqual([f.photos().dataset.carrying, f.get('is-new').length], ['false', 0]);
  // A photo carried lights them up, with a place at the end of the bobine to begin a new take; a clip does not.
  carry(2);
  assert.deepEqual([f.photos().dataset.carrying, f.get('is-new').map(item => item.style.left)], ['true', ['calc(55% + 4px)']]);
  assert.equal(f.get('is-new')[0].attributes['aria-label'], 'Une nouvelle prise, qui part de cette image, à la fin de la bobine');
  f.get('montage-take')[2].ondragend();
  carry(0);
  assert.deepEqual([f.photos().dataset.carrying, f.get('is-new').length], ['false', 0]);
  f.get('montage-take')[0].ondragend();
  // Dropped in the end of the suite, then in the start of the other: side by side at 7 s, each its own
  // take's, the end at the left of the instant, the start at its right.
  carry(2);
  put(slot(suite, 'end'), 'suite');
  carry(4);
  put(slot(drawn, 'start'), 'drawn');
  const photosOf = () => f.ui.state().montage.plans.map(plan => [plan.photos?.start?.runId ?? null, plan.photos?.end?.runId ?? null]);
  assert.deepEqual(photosOf(), [[null, null], [null, id(3)], [id(5), null]]);
  assert.deepEqual(laid(f).map(pin => [pin.dataset.plan, pin.style.left ?? null, pin.style.right ?? null]), [[suite, null, 'calc(65% + 4px)'], [drawn, '35%', null]]);
  assert.equal(f.ui.state().chosen, drawn);
  // Dropped on a photo laid: it replaces it.
  carry(5);
  put(laid(f).find(pin => pin.dataset.plan === drawn), 'replaced');
  assert.deepEqual(photosOf()[2], [id(6), null]);
  // On the place at the end of the bobine: a new take, which starts on it.
  carry(2);
  put(f.get('is-new')[0], 'new');
  assert.deepEqual(f.ui.state().montage.plans.at(-1), { id: f.ui.state().chosen, kind: 'video', todo: { prompt: '' }, from: 0, to: 5, frame: 'fit', volume: 1, at: 11, photos: { start: { conversationId: C, runId: id(3), output: 0 } } });
  // Nothing carried, nothing laid.
  slot(drawn, 'end').ondrop({ ...event(0), stopPropagation() {} });
  assert.deepEqual(photosOf()[2], [id(6), null]);
});

// (0.6.144, 0.6.149) « Créer n prises »: his three photos, laid in 0.6.146 and kept without instants: a take
// to create between two photos, then one that goes on from it towards a third. Read again in 0.6.149, it is
// a suite (public/montage-model.mjs `placed`): it still waits for the first, and starts on its last image.
async function series({ times = { workflowName: 'LTX 2.5' }, texts = ['Il lève les yeux.', 'Il regarde la mer.'], estimate = null, write = null, downloads = null, more = {} } = {}) {
  const asked = [],
    foreseen = [],
    answers = [],
    photo = n => ({ conversationId: C, runId: id(n), output: 0 }),
    old = {
      schemaVersion: 1, id: id(950), name: 'Le pêcheur', format: '16:9', width: 1344, height: 768, fps: 24, sounds: [],
      plans: [
        { id: id(951), kind: 'video', todo: { prompt: texts[0] }, from: 0, to: 5, frame: 'fit', volume: 1, photos: { start: photo(3), end: photo(5) } },
        { id: id(952), kind: 'video', todo: { prompt: texts[1] }, from: 0, to: 2, frame: 'fit', volume: 1, photos: { end: photo(6) } },
      ],
    };
  const f = await setup({
    stored: [old],
    extra: photos(),
    ...more,
    ...(write ? { write } : {}),
    ...(downloads ? { downloads } : {}),
    create: (wanted, hooks) => {
      asked.push({ wanted: structuredClone(wanted), hooks });
      return new Promise((resolve, reject) => answers.push({ resolve, reject }));
    },
    estimate: async wanted => {
      foreseen.push(structuredClone(wanted));
      if (estimate) return estimate(wanted);
      if (times instanceof Error) throw times;
      return structuredClone(times);
    },
  }).open();
  // (What the server says of the models: « À créer » is drawn again with it.)
  await settle();
  await settle();
  return { f, asked, foreseen, answers };
}

test('« Créer 2 prises » makes them at once, one after the other, in the order of the bobine; the model of each is said in its line (0.6.144, 0.6.148)', async () => {
  // (On the card, 20/11, a suite went to a model nobody had named. The model is said in its line before
  // anything is made; no agreement apart any more, no time: « À créer » is the list, the button does it.)
  const { f, asked, foreseen, answers } = await series();
  // Its model asked to the server once for each kind of take, never for its text: here the first, from a
  // photo to a photo (the second goes on from it: asked once the first is made).
  const shape = { prompt: 'Prise.', intention: INTENTION, duration: 5, format: '16:9', start_image: { output: id(3) }, end_image: { output: id(5) } };
  assert.deepEqual(foreseen, [{ verb: 'create_video', args: shape, size: FILM }]);
  assert.deepEqual(f.lines().map(line => line[1]), ['LTX 2.5', '']);
  assert.deepEqual([f.go(), f.goMain().disabled, asked.length], ['Créer 2 prises', false, 0]);
  f.goMain().onclick();
  await settle();
  // The first is asked as a hand asks it; the second waits its turn.
  assert.deepEqual(asked.map(item => item.wanted), [{ ...foreseen[0], args: { ...foreseen[0].args, prompt: 'Il lève les yeux.' }, place: placeOf(f, 0) }]);
  assert.deepEqual([f.names(), f.lines().map(line => line[1]), f.go(), f.get('bobine-go-fill')[0].style.width], [['En cours', 'En attente'], ['En cours', 'En attente'], '1 sur 2', '0%']);
  // Pause and stop beside it (capture 87: two bars, a square); nothing else is offered meanwhile, not
  // even the small bar of the take being made.
  assert.deepEqual([f.button('Mettre en pause après cette prise').hidden, Boolean(f.button('Arrêter'))], [false, true]);
  assert.deepEqual([f.button('Mettre en pause après cette prise').children[0].className, f.button('Arrêter').children[0].className], ['icon-pause', 'icon-stop']);
  assert.deepEqual([f.ui.state().chosen, f.get('montage-pop').length], [f.ui.state().montage.plans[0].id, 0]);
  assert.deepEqual([f.get('montage-export')[0].disabled, f.get('montage-pick')[0].disabled, f.get('montage-format')[0].disabled], [true, true, true]);
  // Its progress: on the take, in its line, in the button, which fills (half of the first of two: a quarter).
  asked[0].hooks.onProgress('Étape 4 sur 8', 0.5);
  assert.deepEqual([f.names()[0], f.lines()[0][1], f.go(), f.get('bobine-go-fill')[0].style.width], ['En cours · 50 %', 'En cours · 50 %', '1 sur 2 · 50 %', '25%']);
  f.plans()[1].onkeydown({ key: 'Delete' });
  assert.deepEqual([f.plans().length, f.notices.at(-1)], [2, 'Des prises sont en cours de création : attendez la fin, ou arrêtez.']);
  // The first made: the second is asked in its turn, from the last image of the first.
  f.runs.push(made(50, 121));
  answers[0].resolve(f.runs.at(-1));
  await settle();
  await settle();
  // (0.6.152) As a continuation of it that arrives on its photo.
  assert.deepEqual([asked[1].wanted.verb, asked[1].wanted.args], ['extend_video', { prompt: 'Il regarde la mer.', intention: INTENTION, duration: 2, end_image: { output: id(6) }, source: { output: id(50) } }]);
  assert.deepEqual([f.names(), f.lines().map(line => line[1]), f.go(), f.get('bobine-go-fill')[0].style.width], [['Prise 50', 'En cours'], ['En cours'], '2 sur 2', '50%']);
  // The second made: all of it is made; « Exporter » and the fil are back.
  f.runs.push(made(51, 49));
  answers[1].resolve(f.runs.at(-1));
  await settle();
  await settle();
  assert.deepEqual([f.ui.state().filling, f.get('bobine-line').length, f.go(), f.goMain().disabled], [null, 0, 'Créer', true]);
  assert.deepEqual([f.get('montage-export')[0].disabled, f.get('montage-pick')[0].disabled, f.names()], [false, false, ['Prise 50', 'Prise 51']]);
});

test('the creation is paused after the take being made, stopped at once, and ends on a refusal (0.6.144, 0.6.148)', async () => {
  let { f, asked, answers } = await series();
  f.goMain().onclick();
  await settle();
  // Pause asked: the take being made goes to its end.
  f.button('Mettre en pause après cette prise').onclick();
  assert.deepEqual([f.go(), f.button('Mettre en pause après cette prise').disabled], ['1 sur 2 · pause demandée', true]);
  f.runs.push(made(50, 121));
  answers[0].resolve(f.runs.at(-1));
  await settle();
  await settle();
  assert.deepEqual([asked.length, f.ui.state().filling.stage, f.go(), f.goMain().disabled, f.button('Mettre en pause après cette prise').hidden], [1, 'paused', 'Reprendre · 1 sur 2', false, true]);
  assert.deepEqual(f.lines().map(line => line[1]), ['En attente']);
  // In pause the bobine is still the one being created.
  f.plans()[1].onkeydown({ key: 'Delete' });
  assert.equal(f.notices.at(-1), 'La création est en pause : reprenez-la ou arrêtez-la avant de modifier la bobine.');
  // « Reprendre »: the second, in its turn. Stopped: the creation is stopped on the card, nothing is said to have failed.
  f.goMain().onclick();
  await settle();
  assert.deepEqual([asked.length, f.go()], [2, '2 sur 2']);
  f.button('Arrêter').onclick();
  assert.equal(f.halted(), 1);
  answers[1].reject(new Error('Génération arrêtée.'));
  await settle();
  await settle();
  assert.deepEqual([f.ui.state().filling, f.ui.state().failed.size, f.names(), f.lines().map(line => line[3]), f.go()], [null, 0, ['Prise 50', '↳ Suite'], [''], 'Créer 1 prise']);
  // Stopped while in pause: nothing to stop on the card, the creation ends there.
  ({ f, asked, answers } = await series());
  f.goMain().onclick();
  await settle();
  f.button('Mettre en pause après cette prise').onclick();
  f.runs.push(made(50, 121));
  answers[0].resolve(f.runs.at(-1));
  await settle();
  await settle();
  f.button('Arrêter').onclick();
  assert.deepEqual([f.halted(), asked.length, f.ui.state().filling, f.go()], [0, 1, null, 'Créer 1 prise']);
  // Refused by the engine: said in its line, and the take after it is not asked.
  ({ f, asked, answers } = await series());
  f.goMain().onclick();
  await settle();
  answers[0].reject(new Error('Mémoire vidéo insuffisante.'));
  await settle();
  await settle();
  assert.deepEqual([asked.length, f.ui.state().filling, f.names(), f.go()], [1, null, ['Échec', '↳ Suite'], 'Créer 2 prises']);
  assert.deepEqual(f.lines().map(line => [line[1], line[3]]), [['Échec', 'Mémoire vidéo insuffisante.'], ['', '']]);
  // A bobine is not taken out under a take being created: its take would have no bobine to go to.
  f.goMain().onclick();
  await settle();
  f.pick('remove');
  f.button('Supprimer').onclick();
  await settle();
  assert.deepEqual([f.notices.at(-1), f.calls.some(call => call.route === 'montages/remove')], ['Une prise est en cours de création : attendez sa fin, ou arrêtez-la.', false]);
  // Leaving the page ends a creation in pause.
  ({ f, answers } = await series());
  f.goMain().onclick();
  await settle();
  f.button('Mettre en pause après cette prise').onclick();
  f.runs.push(made(50, 121));
  answers[0].resolve(f.runs.at(-1));
  await settle();
  await settle();
  await f.ui.leave();
  assert.equal(f.ui.state().filling, null);
});

test('what cannot be created is said in its line and left aside, and what goes on from it with it (0.6.144, 0.6.148)', async () => {
  // The first without its text, the second going on from it: nothing to create.
  let { f } = await series({ texts: ['', 'Il regarde la mer.'] });
  assert.deepEqual([f.go(), f.goMain().disabled], ['Créer', true]);
  assert.deepEqual(f.lines().map(line => line[3]), ['', 'Elle continue la prise d’avant, qui ne peut pas être créée.']);
  // The model of the first is not on this computer: its name in amber in its line, said once above the
  // button (capture 89); the second, which goes on from it, is left aside with it.
  ({ f } = await series({ times: { workflowName: 'LTX 2.5', missing: true } }));
  assert.deepEqual(f.lines().map(line => [line[1], line[3]]), [['LTX 2.5', ''], ['', 'Elle continue la prise d’avant, qui ne peut pas être créée.']]);
  assert.deepEqual(f.said('bobine-missing'), ['LTX 2.5 n’est pas sur cet ordinateur.']);
  assert.equal(f.get('bobine-line-right')[0].dataset.missing, 'true');
  assert.deepEqual([f.go(), f.goMain().disabled], ['Créer', true]);
  await f.ui.createAll();
  assert.equal(f.ui.state().filling, null);
  // The server cannot say (its engine busy): no model said, the takes can be created all the same.
  ({ f } = await series({ times: new Error('Le serveur ne répond pas.') }));
  assert.deepEqual([f.lines().map(line => line[1]), f.go()], [['', ''], 'Créer 2 prises']);
  // One take ready, one left aside without its text.
  ({ f } = await series({ texts: ['Il lève les yeux.', ''] }));
  assert.deepEqual([f.go(), f.lines().map(line => line[3])], ['Créer 1 prise', ['', '']]);
});

// (0.6.146) What Moodix AI is asked to write, each request answered by hand: [{ wanted, signal, resolve, reject }].
function pen() {
  const pens = [];
  return {
    pens,
    write: (wanted, { signal }) => new Promise((resolve, reject) => pens.push({ wanted: structuredClone(wanted), signal, resolve, reject })),
  };
}

test('the Éclipse has Moodix AI write the takes to create that have no text, from their photos; nothing is made (0.6.146, 0.6.148)', async () => {
  // (His words of 20/11: he lays photos, « et le modèle s'occupe de combler les trous ». In the Bobine
  // the Éclipse is the third part of the button of « À créer ».)
  let { pens, write } = pen();
  let { f, asked } = await series({ texts: ['', ''], write });
  const agent = () => f.get('bobine-go-agent')[0];
  assert.deepEqual([agent().disabled, agent().attributes['aria-label'], agent().children[0].className], [false, 'Moodix AI écrit ce qui se passe dans les prises sans texte', 'icon-eclipse']);
  agent().onclick();
  await settle();
  // The first: from its photo to its photo, for its length.
  assert.deepEqual(pens[0].wanted, { verb: 'create_video', seconds: 5, start: { output: id(3) }, end: { output: id(5) } });
  // (0.6.153, capture 86: in its field, its model still at the right of its line.)
  assert.deepEqual([f.names(), f.plans()[0].className, f.lines()[0][1], f.said('bobine-line-writing')], [['Moodix AI écrit', '↳ Suite'], 'montage-piece is-todo is-writing', 'LTX 2.5', ['Moodix AI écrit']]);
  // At work: it says so; it can be stopped; nothing else is offered meanwhile.
  assert.deepEqual([agent().className, agent().disabled, f.said('bobine-halt'), f.goMain().disabled, f.get('montage-pick')[0].disabled], ['bobine-go-part bobine-go-agent is-thinking', true, ['Arrêter'], true, true]);
  f.plans()[1].onkeydown({ key: 'Delete' });
  assert.deepEqual([f.plans().length, f.notices.at(-1)], [2, 'Moodix AI écrit les prises : attendez la fin, ou arrêtez l’écriture.']);
  // Written: the second goes on from the photo the first arrives on, with what happens before it.
  pens[0].resolve({ prompt: '  An old fisherman lifts his eyes.  ' });
  await settle();
  assert.deepEqual(pens[1].wanted, { verb: 'create_video', seconds: 2, start: { output: id(5) }, end: { output: id(6) }, previous: 'An old fisherman lifts his eyes.' });
  assert.deepEqual(f.names(), ['', 'Moodix AI écrit']);
  pens[1].resolve({ prompt: 'He looks at the sea.' });
  for (let turn = 0; turn < 4; turn++) await settle();
  // Both written in their lines and kept; nothing is made: « Créer 2 prises » does it.
  assert.deepEqual([f.get('bobine-line-words').map(field => field.value), f.saves().at(-1).body.montage.plans[1].todo.prompt], [['An old fisherman lifts his eyes.', 'He looks at the sea.'], 'He looks at the sea.']);
  assert.deepEqual([f.ui.state().writing, asked.length, f.go(), f.goMain().disabled, agent().className, agent().disabled], [null, 0, 'Créer 2 prises', false, 'bobine-go-part bobine-go-agent', true]);
  // While they are created, the pause and the stop take the place of the Éclipse (capture 87).
  f.goMain().onclick();
  await settle();
  assert.deepEqual([f.get('bobine-go-agent').length, f.get('bobine-go-part').map(part => part.attributes['aria-label'])], [0, ['Mettre en pause après cette prise', 'Arrêter']]);
  // What the user wrote is left as it is: only the take without text is written, the other is its story before.
  ({ pens, write } = pen());
  ({ f } = await series({ texts: ['Il lève les yeux.', ''], write }));
  agent().onclick();
  await settle();
  assert.deepEqual([pens.length, pens[0].wanted.previous], [1, 'Il lève les yeux.']);
  pens[0].resolve({ prompt: 'He looks at the sea.' });
  for (let turn = 0; turn < 4; turn++) await settle();
  assert.deepEqual(f.ui.state().montage.plans.map(plan => plan.todo.prompt), ['Il lève les yeux.', 'He looks at the sea.']);
  // Every take written already: nothing for it to do.
  ({ pens, write } = pen());
  ({ f } = await series({ write }));
  assert.equal(agent().disabled, true);
  await f.ui.askAgent();
  assert.equal(pens.length, 0);
  // Without Moodix AI at hand (no `write`): no Éclipse.
  ({ f } = await series());
  assert.equal(f.get('bobine-go-agent').length, 0);
});

test('what Moodix AI cannot write is said; its writing is stopped at once, and ends with the page (0.6.146, 0.6.148)', async () => {
  // Refused (a chat model that does not see images): said with the take, which is left to the user.
  let { pens, write } = pen();
  let { f } = await series({ texts: ['', ''], write });
  const agent = () => f.get('bobine-go-agent')[0];
  agent().onclick();
  await settle();
  pens[0].reject(new Error('Ce modèle de chat ne voit pas les images : écrivez vous-même ce qui se passe dans cette prise.'));
  for (let turn = 0; turn < 3; turn++) await settle();
  assert.deepEqual([f.said('montage-status'), pens.length, f.ui.state().writing], [['Prise de 00.00 à 05.00 non écrite : Ce modèle de chat ne voit pas les images : écrivez vous-même ce qui se passe dans cette prise.'], 1, null]);
  assert.deepEqual([f.ui.state().montage.plans.map(plan => plan.todo.prompt), agent().disabled], [['', ''], false]);
  // An answer with nothing in it is no text.
  agent().onclick();
  await settle();
  pens[1].resolve({ prompt: '   ' });
  for (let turn = 0; turn < 3; turn++) await settle();
  assert.deepEqual(f.said('montage-status'), ['Prise de 00.00 à 05.00 non écrite : Moodix AI n’a rien écrit.']);
  // « Arrêter » while the second is written: its request is let go; what is written stays.
  ({ pens, write } = pen());
  ({ f } = await series({ texts: ['', ''], write }));
  agent().onclick();
  await settle();
  pens[0].resolve({ prompt: 'An old fisherman lifts his eyes.' });
  await settle();
  f.button('Arrêter').onclick();
  assert.deepEqual([pens[1].signal.aborted, f.halted()], [true, 0]);
  pens[1].reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
  for (let turn = 0; turn < 3; turn++) await settle();
  // (0.6.155) Stopped by the hand: nothing said in the fil.
  assert.deepEqual([f.said('montage-status'), f.ui.state().montage.plans.map(plan => plan.todo.prompt)], [[''], ['An old fisherman lifts his eyes.', '']]);
  // Leaving the page lets its request go; its answer, late, writes nothing.
  ({ pens, write } = pen());
  ({ f } = await series({ texts: ['', ''], write }));
  agent().onclick();
  await settle();
  await f.ui.leave();
  assert.deepEqual([pens[0].signal.aborted, f.ui.state().writing], [true, null]);
  pens[0].resolve({ prompt: 'Too late.' });
  await settle();
  assert.deepEqual(f.ui.state().montage.plans.map(plan => plan.todo.prompt), ['', '']);
  // The suite of a video: the end of that video, the words of a suite, what its take shows before.
  ({ pens, write } = pen());
  const g = await setup({ create: async () => null, write }).open();
  g.get('montage-take')[0].ondblclick();
  g.press(find(g.root, 'montage-grip')[1], 500);
  g.pointer.move(700);
  g.pointer.up();
  g.get('bobine-go-agent')[0].onclick();
  await settle();
  assert.deepEqual(pens[0].wanted, { verb: 'extend_video', seconds: 2, start: { output: id(1), frame: 'last' }, previous: 'Prise 1' });
  pens[0].reject(new Error('non'));
  await settle();
  // A take with nothing to look at (no photo, nothing before it) is left to the user, and that is said.
  ({ pens, write } = pen());
  ({ f } = await series({ texts: ['', ''], write }));
  f.plans()[1].onkeydown({ key: 'Delete' });
  f.plans()[0].onclick();
  if (f.ui.state().chosen !== f.ui.state().montage.plans[0].id) f.plans()[0].onclick();
  f.button('Retirer l’image de début').onclick();
  f.button('Retirer l’image de fin').onclick();
  assert.equal(f.ui.state().montage.plans[0].photos, undefined);
  agent().onclick();
  for (let turn = 0; turn < 4; turn++) await settle();
  assert.deepEqual([pens.length, f.said('montage-status'), f.ui.state().writing], [0, ['Moodix AI n’a rien à regarder : posez une image de début ou de fin, ou écrivez vous-même.'], null]);
});

test('the wand: what has a text is enriched by Moodix AI, one take after another, until Échap; Ctrl+Z gives the text back (0.6.153)', async () => {
  // (Captures 84 et 85: « tout ce qui peut être enrichi s'entoure […] ; ce qui est sous la baguette se
  // remplit, des deux côtés à la fois. Un clic l'enrichit […]. Le mode reste ouvert […] jusqu'à Échap ou
  // un nouveau clic sur la baguette. Ctrl+Z revient au texte d'avant. Un texte vide n'est pas enrichissable. »)
  const asked = [],
    signals = [];
  let answer = null;
  const f = await setup({
    extra: photos(),
    create: async () => null,
    write: () => new Promise(() => {}),
    enrich: (wanted, { signal }) => (asked.push(structuredClone(wanted)), signals.push(signal), new Promise((resolve, reject) => (answer = { resolve, reject }))),
  }).open();
  lay(f);
  const wand = () => f.get('bobine-go-wand')[0],
    agent = () => f.get('bobine-go-agent')[0],
    lines = () => f.get('bobine-line'),
    key = (name, more = {}) => f.root.onkeydown({ key: name, target: { tagName: 'DIV' }, preventDefault() {}, ...more });
  // Between « Créer » and the Éclipse; nothing to enrich without a text: greyed, until a text is written.
  assert.deepEqual(f.get('bobine-go')[0].children.map(part => part.className), ['bobine-go-main', 'bobine-go-part bobine-go-wand', 'bobine-go-part bobine-go-agent']);
  assert.deepEqual([wand().attributes['aria-label'].split(' :')[0], wand().attributes['aria-pressed'], wand().disabled], ['Enrichir', 'false', true]);
  f.write(0, 'Il lève les yeux.');
  assert.equal(wand().disabled, false);
  wand().onclick();
  assert.deepEqual([f.ui.state().wand, f.root.dataset.wand, wand().attributes['aria-pressed'], agent().disabled], [true, 'true', 'true', true]);
  // What can be enriched is said so, in « À créer » and on the track; under the pointer, both together.
  assert.deepEqual([lines().map(line => line.dataset.enrichable), f.plans().map(piece => piece.dataset.enrichable)], [['true', 'false'], ['true', 'false']]);
  lines()[0].onpointerenter();
  assert.deepEqual([lines()[0].dataset.linked, f.plans()[0].dataset.linked, f.plans()[1].dataset.linked], ['true', 'true', undefined]);
  lines()[0].onpointerleave();
  assert.equal(f.plans()[0].dataset.linked, 'false');
  // A click: Moodix AI details it, as the wand of the Studio does (its verb: a new take); meanwhile it
  // says so, and nothing else is enriched or created.
  lines()[0].onclick({ target: lines()[0] });
  assert.deepEqual(asked, [{ prompt: 'Il lève les yeux.', verb: 'create_video' }]);
  assert.deepEqual([lines()[0].dataset.state, f.said('bobine-line-writing'), f.get('bobine-line-words')[0].disabled, f.goMain().disabled, f.plans()[0].dataset.enriching], ['enriching', ['Moodix AI enrichit'], true, true, 'true']);
  f.plans()[0].onclick();
  assert.equal(asked.length, 1);
  answer.resolve({ prompt: '  Gros plan : il lève lentement les yeux vers la mer, lumière d’aube.  ' });
  await settle();
  assert.equal(f.ui.state().montage.plans[0].todo.prompt, 'Gros plan : il lève lentement les yeux vers la mer, lumière d’aube.');
  // It lights up a moment, on both sides; the wand is still in the hand.
  assert.deepEqual([lines()[0].dataset.lit, f.plans()[0].dataset.lit, f.ui.state().wand], ['true', 'true', true]);
  await f.later();
  assert.deepEqual([lines()[0].dataset.lit, f.plans()[0].dataset.lit], [undefined, undefined]);
  // An empty text is not enriched: said; a take on the track is enriched by a click too.
  lines()[1].onclick({ target: lines()[1] });
  assert.deepEqual([asked.length, f.notices.at(-1)], [1, 'Un texte vide ne s’enrichit pas : écrivez d’abord ce qui se passe.']);
  f.plans()[0].onclick();
  assert.equal(asked.length, 2);
  answer.reject(new Error('Le moteur n’est pas prêt.'));
  await settle();
  assert.deepEqual([f.notices.at(-1), f.ui.state().montage.plans[0].todo.prompt, f.ui.state().enrichingId], ['Texte non enrichi : Le moteur n’est pas prêt.', 'Gros plan : il lève lentement les yeux vers la mer, lumière d’aube.', null]);
  // Échap puts the wand down, heard by the page wherever the keys are (a click with the wand takes
  // no focus): a click on a line chooses it again.
  f.pageKey('Escape');
  assert.deepEqual([f.ui.state().wand, f.root.dataset.wand], [false, 'false']);
  f.pageKey('Escape');
  assert.equal(f.ui.state().wand, false);
  lines()[1].onclick({ target: lines()[1] });
  assert.deepEqual([asked.length, f.ui.state().chosen], [2, f.ui.state().montage.plans[1].id]);
  // (0.6.154) Ctrl+Z, « Annuler »: the text of before; Ctrl+Maj+Z, « Rétablir »: the enriched one again.
  // Not in a field being typed in: its own text comes back there.
  const prompt = () => f.ui.state().montage.plans[0].todo.prompt,
    enriched = 'Gros plan : il lève lentement les yeux vers la mer, lumière d’aube.';
  f.pageKey('z', { ctrlKey: true });
  assert.equal(prompt(), 'Il lève les yeux.');
  f.pageKey('z', { ctrlKey: true, shiftKey: true });
  assert.equal(prompt(), enriched);
  f.pageKey('z', { ctrlKey: true, target: { tagName: 'TEXTAREA' } });
  assert.equal(prompt(), enriched);
  wand().onclick();
  lines()[0].onclick({ target: lines()[0] });
  answer.resolve({ prompt: 'Plan large : il lève les yeux.' });
  await settle();
  f.write(0, 'Plan large : il lève les yeux, puis sourit.');
  // Written since: « Annuler » takes back what was written, then the enrichment.
  f.pageKey('z', { ctrlKey: true });
  assert.equal(prompt(), 'Plan large : il lève les yeux.');
  f.pageKey('y', { ctrlKey: true });
  assert.equal(prompt(), 'Plan large : il lève les yeux, puis sourit.');
  // Written meanwhile (its field is greyed, the text changed all the same): the user's text stays.
  assert.equal(f.ui.state().wand, true);
  lines()[0].onclick({ target: lines()[0] });
  assert.equal(f.ui.state().enrichingId, f.ui.state().montage.plans[0].id);
  f.write(0, 'Il sourit.');
  answer.resolve({ prompt: 'Gros plan : il sourit.' });
  await settle();
  assert.equal(f.ui.state().montage.plans[0].todo.prompt, 'Il sourit.');
  f.write(0, 'Plan large : il lève les yeux, puis sourit.');
  // A click on the wand puts it down too. Leaving the page puts it down and lets go of the enrichment asked.
  wand().onclick();
  assert.equal(f.ui.state().wand, false);
  wand().onclick();
  lines()[0].onclick({ target: lines()[0] });
  await f.ui.leave();
  assert.deepEqual([f.ui.state().wand, f.ui.state().enrichingId, signals.at(-1).aborted], [false, null, true]);
  answer.resolve({ prompt: 'Trop tard.' });
  await settle();
  assert.equal(f.ui.state().montage.plans[0].todo.prompt, 'Plan large : il lève les yeux, puis sourit.');
  // Without Moodix AI at hand: no wand.
  const bare = await setup({ create: async () => null }).open();
  assert.equal(bare.get('bobine-go-wand').length, 0);
});

test('while Moodix AI writes, its field says it and « Arrêter » is at the left of the button (0.6.153)', async () => {
  // (Capture 86.)
  const { write } = pen();
  const { f } = await series({ texts: ['', ''], write });
  f.get('bobine-go-agent')[0].onclick();
  await settle();
  assert.deepEqual(f.get('bobine-foot')[0].children.map(part => part.className), ['bobine-halt', 'bobine-go']);
  assert.deepEqual([f.said('bobine-line-writing'), f.lines()[0][1]], [['Moodix AI écrit'], 'LTX 2.5']);
});

test('a model missing is downloaded from « À créer » at once, as in Paramètres › Modèles: its line, its figures, « Arrêter »; « À créer » keeps its lines (0.6.155)', async () => {
  // (Capture 89 and his relecture of 20/11: « Le clic doit lancer le téléchargement tout de suite, sans
  // ouvrir la carte du chat. […] le bouton garde sa place : un trait d'avancée, « 3,4 / 20,0 GO » en mono
  // et « Arrêter ». Les licences sont au survol du bouton. »)
  const GB = 1024 ** 3,
    free = [{ file: 'ltx-2.5-int8.safetensors', size: 20 * GB, license: { name: 'Apache 2.0' } }],
    offer = { workflowId: 'ltx', files: free, bytes: 20 * GB, left: 20 * GB, needsToken: false, page: '' };
  let answer = { workflowName: 'LTX 2.5', missing: offer };
  const job = { state: 'idle' },
    asked = [],
    downloads = (route, body) => {
      asked.push(body === undefined ? [route] : [route, body]);
      if (route === 'downloads/start') Object.assign(job, { state: 'running', workflowId: 'ltx', name: 'LTX 2.5', received: 0, total: 20 * GB });
      if (route === 'downloads/cancel') job.state = 'cancelled';
      return structuredClone(route === 'downloads' ? { job } : job);
    };
  const { f } = await series({ estimate: () => structuredClone(answer), downloads });
  // Said once above the button; « Télécharger · 20,0 Go » in the place of « Créer », its licences under the pointer.
  assert.deepEqual([f.said('bobine-missing'), f.get('bobine-line-right')[0].dataset.missing], [['LTX 2.5 n’est pas sur cet ordinateur.'], 'true']);
  const fetch = () => f.get('bobine-go-download')[0];
  assert.deepEqual([fetch().textContent, fetch().title, f.get('bobine-go')[0].children.length, f.get('bobine-go-wand').length], ['Télécharger · 20,0 Go', 'Licence : Apache 2.0. En téléchargeant, vous l’acceptez.', 1, 0]);
  // (A download of it under way elsewhere was looked for, once.)
  assert.deepEqual(asked, [['downloads']]);
  // The click: downloaded at once, nothing opened; the lines stay, the button keeps its place.
  fetch().onclick();
  await settle();
  assert.deepEqual(asked.at(-1), ['downloads/start', { id: 'ltx' }]);
  assert.deepEqual([f.get('missing-card').length, f.get('bobine-line').length, fetch().disabled, fetch().dataset.state, fetch().textContent], [0, 2, true, 'running', '0 / 20,0 Go']);
  assert.deepEqual([f.said('bobine-halt'), f.said('bobine-missing')], [['Arrêter'], ['LTX 2.5 n’est pas sur cet ordinateur.']]);
  // As it comes: its line and its figures, the panel not drawn again (a text being written stays in the hand).
  const field = f.get('bobine-line-words')[0];
  job.received = 3.4 * GB;
  await f.later({ ms: 1000 });
  assert.deepEqual([fetch().textContent, find(fetch(), 'bobine-go-fill')[0].style.width, f.get('bobine-line-words')[0]], ['3,4 / 20,0 Go', '17%', field]);
  // « Arrêter »: stopped, what is left of it asked again with the models.
  f.get('bobine-halt')[0].onclick();
  await settle();
  assert.deepEqual(asked.at(-1), ['downloads/cancel', {}]);
  offer.left = 16.6 * GB;
  await f.later({ ms: 1000 });
  await settle();
  await settle();
  assert.deepEqual([f.ui.state().downloading, fetch().textContent, f.said('bobine-halt')], [null, 'Télécharger · 16,6 Go', []]);
  // Downloaded to its end: the models asked again, « Créer » is back.
  fetch().onclick();
  await settle();
  job.state = 'done';
  answer = { workflowName: 'LTX 2.5' };
  await f.later({ ms: 1000 });
  await settle();
  await settle();
  assert.deepEqual([f.ui.state().downloading, f.get('bobine-go-download').length, f.go(), f.said('bobine-missing')], [null, 0, 'Créer 2 prises', []]);
});

test('a licence with conditions is read in « À créer » before the download, accepted or refused; refusals and other downloads are said (0.6.155)', async () => {
  const GB = 1024 ** 3,
    files = [{ file: 'ltx-2.5-int8.safetensors', size: 20 * GB, license: { name: 'LTX-2 Community License', url: 'https://example.test/ltx', limits: 'Pas pour un concurrent.', restricted: true } }],
    offer = { workflowId: 'ltx', files, bytes: 20 * GB, left: 20 * GB, needsToken: false, page: '' };
  const job = { state: 'idle' },
    asked = [];
  let refuse = '';
  const downloads = (route, body) => {
    asked.push([route, body]);
    if (route === 'downloads/start') {
      if (refuse) throw new Error(refuse);
      Object.assign(job, { state: 'running', workflowId: 'ltx', name: 'LTX 2.5', received: 0, total: 20 * GB });
    }
    return structuredClone(route === 'downloads' ? { job } : job);
  };
  const { f } = await series({ times: { workflowName: 'LTX 2.5', missing: offer }, downloads });
  const fetch = () => f.get('bobine-go-download')[0];
  assert.equal(fetch().title, 'Licence : LTX-2 Community License (à conditions). En téléchargeant, vous l’acceptez.');
  // The click shows it, in the place of the sentence; the lines stay; nothing is asked yet.
  fetch().onclick();
  await settle();
  assert.deepEqual([asked.filter(([route]) => route === 'downloads/start').length, f.get('license-block').length, f.said('license-head'), f.said('bobine-missing'), f.get('bobine-line').length], [0, 1, ['À lire avant de télécharger'], [], 2]);
  assert.deepEqual([fetch().textContent, f.said('bobine-halt')], ['J’ai lu, télécharger · 20,0 Go', ['Refuser']]);
  // « Refuser »: as it was, nothing downloaded.
  f.get('bobine-halt')[0].onclick();
  assert.deepEqual([f.ui.state().downloading, f.get('license-block').length, fetch().textContent], [null, 0, 'Télécharger · 20,0 Go']);
  // Accepted: the download, with the word that it was read.
  fetch().onclick();
  fetch().onclick();
  await settle();
  assert.deepEqual([asked.at(-1), f.ui.state().downloading.stage], [['downloads/start', { id: 'ltx', accepted: true }], 'running']);
  // Another download under way: said, the button back.
  Object.assign(job, { workflowId: 'wan', name: 'Wan 2.2' });
  await f.later({ ms: 1000 });
  assert.deepEqual([f.ui.state().downloading, f.said('bobine-missing'), fetch().textContent], [null, ['Un autre téléchargement est en cours (Wan 2.2) : attendez sa fin.'], 'Télécharger · 20,0 Go']);
  // Refused by the server: said.
  refuse = 'Disque plein.';
  fetch().onclick();
  fetch().onclick();
  await settle();
  assert.deepEqual(f.said('bobine-missing'), ['Téléchargement impossible : Disque plein.']);
  // A model behind a Hugging Face account: said, the button greyed.
  const { f: g } = await series({ times: { workflowName: 'LTX 2.5', missing: { ...offer, needsToken: true, page: 'huggingface.co/Lightricks' } }, downloads });
  assert.deepEqual([g.get('bobine-go-download')[0].disabled, g.said('bobine-missing')], [true, ['LTX 2.5 demande un compte Hugging Face : acceptez sa licence sur huggingface.co/Lightricks, puis enregistrez votre jeton dans Paramètres › Mise à jour.']]);
  // Its download already under way (from Paramètres › Modèles): followed here.
  Object.assign(job, { state: 'running', workflowId: 'ltx', name: 'LTX 2.5', received: 10 * GB, total: 20 * GB });
  const { f: h } = await series({ times: { workflowName: 'LTX 2.5', missing: offer }, downloads });
  await settle();
  assert.deepEqual([h.ui.state().downloading?.stage, h.get('bobine-go-download')[0].textContent], ['running', '10,0 / 20,0 Go']);
  // A model whose download nobody can say (no offer): the sentence, « Créer » greyed.
  const { f: k } = await series({ times: { workflowName: 'LTX 2.5', missing: true } });
  assert.deepEqual([k.said('bobine-missing'), k.get('bobine-go-download').length, k.go(), k.goMain().disabled], [['LTX 2.5 n’est pas sur cet ordinateur.'], 0, 'Créer', true]);
});

test('a line of « À créer » and its take on the track light up together; a click on one brings the other in view (0.6.153)', async () => {
  // (Capture 78.)
  const f = await setup({ extra: photos(), create: async () => null }).open();
  lay(f);
  const lines = () => f.get('bobine-line'),
    seen = [];
  // Its line under the pointer: the take and its photos lit.
  lines()[0].onpointerenter();
  assert.deepEqual([f.plans()[0].dataset.linked, laid(f).filter(pin => pin.dataset.plan === f.ui.state().montage.plans[0].id).map(pin => pin.dataset.linked)], ['true', ['true', 'true']]);
  lines()[0].onpointerleave();
  // Lit still when the timeline is drawn again under the pointer (a change of the bobine).
  lines()[0].onpointerenter();
  f.root.onkeydown({ key: 'Home', target: { tagName: 'DIV' }, preventDefault() {} });
  f.get('montage-filter')[1].onclick();
  assert.deepEqual([lines()[0].dataset.linked, f.plans()[0].dataset.linked], ['true', 'true']);
  lines()[0].onpointerleave();
  // The take under the pointer: its line lit.
  f.plans()[1].onpointerenter();
  assert.deepEqual(lines().map(line => line.dataset.linked), ['false', 'true']);
  f.plans()[1].onpointerleave();
  // A click on a line chooses its take and brings it into the timeline; one on a take brings its line into the list.
  // (What is brought into view is the element drawn again after the choice.)
  Fake.prototype.scrollIntoView = function (options) {
    seen.push([String(this.className).split(' ')[0], this.dataset.id, options]);
  };
  try {
    lines()[0].onclick({ target: lines()[0] });
    assert.deepEqual([f.ui.state().chosen, seen], [f.ui.state().montage.plans[0].id, [['montage-piece', f.ui.state().montage.plans[0].id, { block: 'nearest', inline: 'nearest' }]]]);
    f.plans()[1].onclick();
    assert.deepEqual([f.ui.state().chosen, seen.at(-1)], [f.ui.state().montage.plans[1].id, ['bobine-line', f.ui.state().montage.plans[1].id, { block: 'nearest', inline: 'nearest' }]]);
  } finally {
    delete Fake.prototype.scrollIntoView;
  }
});

// ---- 0.6.154, lot 5 de la Bobine : Annuler, Rétablir, Enregistrer, Exporter à deux choix ----------------

test('« Annuler » and « Rétablir » in the fil, Ctrl+Z and Ctrl+Maj+Z: each gesture is one step (0.6.154)', async () => {
  // (Maquette : « à droite Annuler, Rétablir (Ctrl+Z, Ctrl+Maj+Z) ».)
  const f = await setup({ width: 2000 }).open();
  const [undo, redo] = f.get('bobine-step'),
    names = () => f.names(),
    step = () => [f.ui.state().past, f.ui.state().future];
  assert.deepEqual([undo.attributes['aria-label'], redo.attributes['aria-label'], redo.className, undo.disabled, redo.disabled], ['Annuler (Ctrl+Z)', 'Rétablir (Ctrl+Maj+Z)', 'bobine-step is-again', true, true]);
  // Two takes laid: two steps.
  for (const at of [0, 1]) f.get('montage-take')[at].ondblclick();
  assert.deepEqual([names(), step(), f.get('bobine-step')[0].disabled], [['Prise 1', 'Prise 2'], [2, 0], false]);
  // A drag, however many moves it makes: one step.
  f.press(f.plans()[0], 100);
  for (const x of [200, 400, 700]) f.pointer.move(x);
  f.pointer.up();
  assert.deepEqual([names(), step()], [['Prise 2', 'Prise 1'], [3, 0]]);
  f.get('bobine-step')[0].onclick();
  assert.deepEqual([names(), step(), f.get('bobine-step')[1].disabled], [['Prise 1', 'Prise 2'], [2, 1], false]);
  // The keys, heard by the page; Ctrl+Y does again too.
  f.pageKey('z', { ctrlKey: true });
  assert.deepEqual([names(), step()], [['Prise 1'], [1, 2]]);
  f.pageKey('Z', { ctrlKey: true, shiftKey: true });
  assert.deepEqual([names(), step()], [['Prise 1', 'Prise 2'], [2, 1]]);
  f.pageKey('y', { ctrlKey: true });
  assert.deepEqual([names(), step(), f.get('bobine-step')[1].disabled], [['Prise 2', 'Prise 1'], [3, 0], true]);
  // Kept a moment later, as any change.
  await f.later();
  assert.deepEqual(f.saves().at(-1).body.montage.plans.map(plan => plan.source.runId), [id(2), id(1)]);
  // Not in a field being typed in, nor with Alt, nor on another page.
  f.pageKey('z', { ctrlKey: true, target: { tagName: 'INPUT' } });
  f.pageKey('z', { ctrlKey: true, altKey: true });
  f.pageKey('z', {});
  globalThis.document = { body: { dataset: { view: 'chat' } } };
  try {
    f.pageKey('z', { ctrlKey: true });
  } finally {
    delete globalThis.document;
  }
  assert.deepEqual(step(), [3, 0]);
  // Something new after a step undone: what was undone cannot come back.
  f.get('bobine-step')[0].onclick();
  f.get('montage-take')[2].ondblclick();
  assert.deepEqual([step(), f.get('bobine-step')[1].disabled], [[3, 0], true]);
  // Another bobine: nothing to undo there.
  f.pick('new');
  await settle();
  assert.deepEqual([step(), f.get('bobine-step')[0].disabled], [[0, 0], true]);
});

test('a text typed in a row is one step, a pause makes another; the volume slid is one (0.6.154)', async () => {
  const f = await setup().open();
  f.get('montage-take')[0].ondblclick();
  f.lanes()[0].onclick({ clientX: 800, target: f.lanes()[0] });
  const before = f.ui.state().past;
  assert.equal(f.get('bobine-line-words').length, 1, 'a take to create, laid by a click');
  const prompt = () => f.ui.state().montage.plans.find(plan => plan.todo).todo.prompt;
  for (const words of ['Il', 'Il lève', 'Il lève les yeux.']) f.write(0, words);
  assert.equal(f.ui.state().past, before + 1);
  await f.later({ ms: 2000 });
  f.write(0, 'Il lève les yeux vers la mer.');
  assert.equal(f.ui.state().past, before + 2);
  f.ui.undo();
  assert.equal(prompt(), 'Il lève les yeux.');
  f.ui.undo();
  assert.equal(prompt(), '');
  // The volume of a sound, slid: one step.
  f.ui.redo();
  f.ui.redo();
  f.get('montage-take')[3].ondblclick();
  const volume = f.slider('Volume');
  for (const value of [80, 50, 40]) Object.assign(volume, { value }).oninput();
  assert.deepEqual([f.ui.state().past, f.ui.state().montage.sounds[0].volume], [before + 4, 0.4]);
  f.ui.undo();
  assert.equal(f.ui.state().montage.sounds[0].volume, 0.6);
});

test('a take created is a step: undone it is to create again, the take made stays in « Prises »; nothing is undone meanwhile (0.6.154)', async () => {
  const { f, answers } = await series();
  f.write(1, 'Il regarde la mer, au loin.');
  f.goMain().onclick();
  await settle();
  // While takes are made: greyed, and refused by the keys with the reason.
  assert.deepEqual(f.get('bobine-step').map(control => control.disabled), [true, true]);
  f.pageKey('z', { ctrlKey: true });
  assert.equal(f.notices.at(-1), 'Des prises sont en cours de création : attendez la fin, ou arrêtez.');
  for (const [at, n, frames] of [[0, 50, 121], [1, 51, 49]]) {
    f.runs.push(made(n, frames));
    answers[at].resolve(f.runs.at(-1));
    await settle();
    await settle();
  }
  assert.deepEqual([f.names(), f.get('bobine-step')[0].disabled], [['Prise 50', 'Prise 51'], false]);
  // Each take made, one step: the last one is to create again, then the first.
  f.ui.undo();
  assert.deepEqual([f.names()[0], f.ui.state().montage.plans[1].todo?.prompt], ['Prise 50', 'Il regarde la mer, au loin.']);
  f.ui.undo();
  assert.equal(f.ui.state().montage.plans[0].todo?.prompt, 'Il lève les yeux.');
  assert.ok(f.said('montage-take-number').includes('Prise 50'), 'the take made stays in « Prises »');
  f.ui.redo();
  f.ui.redo();
  assert.deepEqual(f.names(), ['Prise 50', 'Prise 51']);
});

test('« Enregistrer » puts the bobine in the Archives; its point says it changed since (0.6.154)', async () => {
  // (Capture 90: « Enregistrer range la bobine dans les Archives, comme une bobine qu'on rouvre, pas comme
  // un film. Un point d'accent sur le bouton dit qu'il y a des changements pas enregistrés. »)
  const f = await setup().open();
  const save = () => f.get('bobine-save')[0];
  assert.deepEqual([save().textContent, save().children[0].className, save().disabled, save().dataset.unsaved, save().title], ['Enregistrer', 'icon-save', true, 'false', 'Posez au moins une prise pour enregistrer la bobine']);
  f.get('montage-take')[0].ondblclick();
  assert.deepEqual([save().disabled, save().dataset.unsaved, save().title], [false, 'true', 'Enregistrer la bobine dans les Archives : elle a changé depuis']);
  await f.ui.archive();
  assert.deepEqual([f.saves().length, f.saves().at(-1).body.archive, f.saves().at(-1).body.montage.plans.length], [1, true, 1]);
  // (0.6.155) Nothing said in the fil: the point is gone.
  assert.deepEqual([save().dataset.unsaved, save().title, f.said('montage-status')], ['false', 'Enregistrer la bobine dans les Archives', ['']]);
  // Nothing waits to be kept on its own any more.
  await f.later();
  assert.equal(f.saves().length, 1);
  // A change: the point; undone, the bobine is the one in the Archives again.
  f.get('montage-take')[1].ondblclick();
  assert.equal(save().dataset.unsaved, 'true');
  await f.later();
  assert.deepEqual([f.saves().length, f.saves().at(-1).body.archive], [2, undefined]);
  f.ui.undo();
  assert.equal(save().dataset.unsaved, 'false');
  // Refused: said, and kept on its own all the same.
  const failing = await setup({ fail: { 'montages/save': 'Disque plein.' } }).open();
  failing.get('montage-take')[0].ondblclick();
  await failing.ui.archive();
  assert.deepEqual([failing.said('montage-status'), failing.get('montage-status')[0].dataset.problem, failing.get('bobine-save')[0].dataset.unsaved], [['Non enregistrée : Disque plein.'], 'true', 'true']);
  await failing.later();
  assert.deepEqual(failing.saves().map(call => call.body.archive), [true, undefined]);
});

test('a bobine opened says whether it is the one in the Archives; what is there is never sent back (0.6.154)', async () => {
  const plan = { id: id(901), at: 0, kind: 'video', source: { conversationId: C, runId: id(1), output: 0 }, from: 0, to: 5, frame: 'fit', volume: 1 },
    body = { name: 'Le renard', format: '16:9', width: 1344, height: 768, fps: 24, plans: [plan], sounds: [] },
    stored = { schemaVersion: 1, id: id(900), ...body, archived: { at: '2026-11-20T03:00:00.000Z', ...body } },
    other = { ...stored, id: id(910), name: 'Le phare', archived: { ...stored.archived, plans: [] } };
  const f = await setup({ stored: [stored, other] }).open();
  assert.deepEqual([f.ui.state().montage.id, f.get('bobine-save')[0].dataset.unsaved, 'archived' in f.ui.state().montage], [id(900), 'false', false]);
  f.get('montage-take')[1].ondblclick();
  await f.later();
  assert.equal('archived' in f.saves().at(-1).body.montage, false);
  // Another one, changed since it was put there: its point; nothing of the one before to undo.
  f.pick(id(910));
  await settle();
  await settle();
  assert.deepEqual([f.ui.state().montage.id, f.get('bobine-save')[0].dataset.unsaved, f.ui.state().past], [id(910), 'true', 0]);
});

test('a bobine of the Archives is opened in the Bobine: at once, or once those of its project are read (0.6.154)', async () => {
  const one = { schemaVersion: 1, id: id(900), name: 'Le renard', format: '16:9', width: 1344, height: 768, fps: 24, plans: [], sounds: [] },
    two = { ...one, id: id(910), name: 'Le phare' };
  // Asked before the page is drawn: read with the others, opened in place of the last changed.
  const f = setup({ stored: [one, two] });
  f.ui.wanted(id(910));
  await f.open();
  assert.equal(f.ui.state().montage.id, id(910));
  // The page drawn: opened at once (what was open kept first).
  f.ui.wanted(id(900));
  await settle();
  await settle();
  assert.equal(f.ui.state().montage.id, id(900));
  // The page left then drawn again: opened as it is drawn.
  await f.ui.leave();
  f.ui.wanted(id(910));
  await f.open();
  await settle();
  assert.equal(f.ui.state().montage.id, id(910));
});

test('« Exporter » opens its menu: « Un seul fichier » or « Un fichier par prise », each saying where it goes (0.6.154)', async () => {
  // (Captures 90 et 91.)
  const f = await setup().open();
  for (const at of [0, 1]) f.get('montage-take')[at].ondblclick();
  const go = f.get('montage-export')[0];
  assert.deepEqual([go.attributes['aria-haspopup'], go.attributes['aria-expanded'], go.children.map(part => part.className)], ['menu', 'false', ['icon-download', '', 'icon-chevron']]);
  go.onclick();
  const [menu] = f.get('bobine-export-menu');
  assert.deepEqual([menu.attributes.role, go.attributes['aria-expanded'], f.heard('pointerdown')], ['menu', 'true', true]);
  assert.deepEqual(f.get('bobine-export-item').map(item => [find(item, 'bobine-export-name')[0].textContent, find(item, 'bobine-export-where')[0].textContent, item.attributes['aria-disabled'] ?? null]), [
    ['Un seul fichier', 'video / Sans titre.mp4', null],
    ['Un fichier par prise', 'bobines / Sans titre / 01 à 02', null],
  ]);
  assert.equal(f.focused(), f.get('bobine-export-item')[0], 'its first choice in hand');
  // Échap closes it, the focus back on « Exporter »; a click beside it too.
  menu.onkeydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.deepEqual([f.get('bobine-export-menu').length, menu.removed, go.attributes['aria-expanded'], f.heard('pointerdown'), f.focused()], [0, true, 'false', false, go]);
  // « Un fichier par prise »: the takes made, in their folder of BOBINES.
  go.onclick();
  f.get('bobine-export-item')[1].onclick();
  await settle();
  await settle();
  // (Kept first: the server exports what is kept.)
  assert.deepEqual(f.calls.slice(-2).map(call => call.route), ['montages/save', 'montages/export-takes']);
  assert.deepEqual(f.calls.at(-1).body, { project: 'inbox', id: f.ui.state().montage.id });
  assert.deepEqual([f.said('montage-status'), f.get('bobine-export-menu').length], [['2 prises exportées · bobines / Sans titre'], 0]);
  // (0.6.155) Said a few seconds, then nothing.
  await f.later({ ms: 4000 });
  assert.deepEqual(f.said('montage-status'), ['']);
  // « Un seul fichier »: the film, as before.
  f.get('montage-export')[0].onclick();
  f.get('bobine-export-item')[0].onclick();
  await settle();
  await settle();
  assert.deepEqual([f.calls.at(-1).route, f.said('montage-status')], ['montages/export', ['Film exporté · Prise 18']]);
  // Refused: said.
  const failing = await setup({ fail: { 'montages/export-takes': 'Prise 2 : cette prise n’existe plus.' } }).open();
  failing.get('montage-take')[0].ondblclick();
  await failing.ui.exportTakes();
  assert.deepEqual([failing.said('montage-status'), failing.get('montage-status')[0].dataset.problem], [['Export impossible : Prise 2 : cette prise n’existe plus.'], 'true']);
});

test('while takes are to create, « Un seul fichier » is greyed with its reason; « Un fichier par prise » exports those made (0.6.154)', async () => {
  // (Capture 91 : « 2 prises sont encore à créer » ; « BOBINES / LE RENARD EN HIVER / 01 À 03 ».)
  const f = await setup({ extra: photos() }).open();
  f.get('montage-take')[0].ondblclick();
  lay(f);
  const go = f.get('montage-export')[0];
  assert.equal(go.disabled, false, 'never greyed but for an empty bobine');
  go.onclick();
  const [single, each] = f.get('bobine-export-item');
  assert.deepEqual([single.className, single.attributes['aria-disabled'], single.dataset.tip, each.attributes['aria-disabled'] ?? null], ['glass-menu-item bobine-export-item is-off', 'true', '2 prises sont encore à créer', null]);
  // (0.6.155) Its reason at the left of the menu: above it, it hid « Enregistrer ».
  assert.equal(single.dataset.tipSide, 'left');
  assert.equal(find(each, 'bobine-export-where')[0].textContent, 'bobines / Sans titre / 01');
  single.onclick();
  assert.equal(f.get('bobine-export-menu').length, 1, 'a choice greyed does nothing');
  assert.equal(f.focused(), each, 'the first choice that can be made in hand');
  await f.ui.exportFilm();
  assert.equal(f.calls.some(call => call.route === 'montages/export'), false);
});

test('the texts Moodix AI writes at once are one step of « Annuler » (0.6.154)', async () => {
  const { pens, write } = pen();
  const { f } = await series({ texts: ['', ''], write });
  f.get('bobine-go-agent')[0].onclick();
  await settle();
  pens[0].resolve({ prompt: 'An old fisherman lifts his eyes.' });
  await settle();
  pens[1].resolve({ prompt: 'He looks at the sea.' });
  for (let turn = 0; turn < 4; turn++) await settle();
  assert.equal(f.ui.state().past, 1);
  f.ui.undo();
  assert.deepEqual(f.ui.state().montage.plans.map(plan => plan.todo.prompt), ['', '']);
  f.ui.redo();
  assert.deepEqual(f.ui.state().montage.plans.map(plan => plan.todo.prompt), ['An old fisherman lifts his eyes.', 'He looks at the sea.']);
});

test('« Annuler » after « Renommer »: the fil says the name of before (0.6.154)', async () => {
  // (Seen in the real page, 20/11: Ctrl+Z gave the name back, the fil still said the new one.)
  const f = await setup().open();
  f.get('montage-take')[0].ondblclick();
  f.pick('rename');
  Object.assign(f.get('bobine-name')[0], { value: 'Le renard en hiver' }).onkeydown({ key: 'Enter' });
  const named = () => f.get('montage-pick')[0].children.find(option => option.selected).textContent;
  assert.equal(named(), 'Le renard en hiver');
  f.pageKey('z', { ctrlKey: true });
  assert.deepEqual([f.ui.state().montage.name, named()], ['Sans titre', 'Sans titre']);
  f.pageKey('z', { ctrlKey: true, shiftKey: true });
  assert.equal(named(), 'Le renard en hiver');
});

test('« Créer » counts every take to create: Moodix AI writes those without text first, then makes them in the series (0.6.155)', async () => {
  // (Captures 70, 73, 74: « Créer 3 prises » with a suite still without its text. His words of 20/11:
  // « Une prise sans texte n'empêche rien : Moodix AI l'écrit d'abord, comme l'Éclipse, puis la crée dans
  // la série. « Créer » n'est grisé que s'il n'y a rien à créer. »)
  const { pens, write } = pen();
  const { f, asked, answers } = await series({ texts: ['Il lève les yeux.', ''], write });
  assert.deepEqual([f.go(), f.goMain().disabled, f.lines().map(line => line[3])], ['Créer 2 prises', false, ['', '']]);
  f.goMain().onclick();
  await settle();
  assert.equal(asked.length, 1);
  f.runs.push(made(50, 121));
  answers[0].resolve(f.runs.at(-1));
  await settle();
  await settle();
  // Its turn: Moodix AI writes it from what it starts and arrives on, « MOODIX AI ÉCRIT » in its line; nothing is made meanwhile.
  assert.deepEqual([pens.length, pens[0].wanted, f.said('bobine-line-writing'), asked.length, f.go()], [1, { verb: 'extend_video', seconds: 2, start: { output: id(50), frame: 'last' }, end: { output: id(6) }, previous: 'Prise 50' }, ['Moodix AI écrit'], 1, '2 sur 2']);
  assert.deepEqual([f.get('bobine-halt').length, Boolean(f.button('Arrêter'))], [0, true], 'the stop of the series stops it');
  pens[0].resolve({ prompt: 'He looks at the sea.' });
  await settle();
  await settle();
  assert.deepEqual([asked.length, asked[1].wanted.args.prompt, f.ui.state().montage.plans[1].todo.prompt], [2, 'He looks at the sea.', 'He looks at the sea.']);
  f.runs.push(made(51, 49));
  answers[1].resolve(f.runs.at(-1));
  await settle();
  await settle();
  assert.deepEqual([f.ui.state().filling, f.names()], [null, ['Prise 50', 'Prise 51']]);
  // What Moodix AI could not write: in its line, in amber; the series ends there.
  const { pens: tips, write: writes } = pen();
  const { f: g } = await series({ texts: ['', ''], write: writes });
  assert.equal(g.go(), 'Créer 2 prises');
  g.goMain().onclick();
  await settle();
  tips[0].reject(new Error('Le modèle de chat ne répond pas.'));
  await settle();
  await settle();
  assert.deepEqual([g.ui.state().filling, g.lines()[0][3], g.get('bobine-line')[0].dataset.state, g.ui.state().writing], [null, 'Texte non écrit : Le modèle de chat ne répond pas.', 'failed', null]);
  // Stopped while it writes: let go at once, nothing made.
  const { pens: held, write: holds } = pen();
  const { f: h, asked: made2 } = await series({ texts: ['', ''], write: holds });
  h.goMain().onclick();
  await settle();
  h.button('Arrêter').onclick();
  await settle();
  await settle();
  assert.deepEqual([held[0].signal.aborted, h.ui.state().filling, h.ui.state().writing, made2.length, h.lines()[0][3]], [true, null, null, 0, '']);
  // Nothing to look at (a take drawn, without photo): not counted; without Moodix AI at hand, those without text neither.
  const { pens: none, write: blind } = pen();
  const k = await setup({ write: blind, create: async () => null }).open();
  k.lanes()[0].onclick({ clientX: 300, target: k.lanes()[0] });
  assert.deepEqual([k.go(), k.goMain().disabled, none.length], ['Créer', true, 0]);
  const { f: m } = await series({ texts: ['Il lève les yeux.', ''] });
  assert.equal(m.go(), 'Créer 1 prise');
});

test('the bar of a take to create never lies over its photos nor their places: centred, or in the take when it is narrow (0.6.155)', async () => {
  // (Captures 78, 84, 89, 91: the trash lay on the place of the start photo.) Measured on the page.
  const f = await setup({ extra: photos(), create: async () => null }).open();
  lay(f);
  const box = (left, width) => ({ left, right: left + width, width, top: 0, bottom: 30, height: 30 }),
    place = (pins, bar) => {
      const pop = f.pop();
      Object.assign(pop, { isConnected: true, getBoundingClientRect: () => bar });
      laid(f)
        .concat(find(f.root, 'is-slot'))
        .filter(pin => pin.dataset.plan === f.ui.state().chosen)
        .forEach((pin, at) => (pin.getBoundingClientRect = () => pins[at]));
    };
  // The second take chosen (5 s to 7 s): its bar centred over it, half its width kept inside the track.
  f.ui.select(f.ui.state().montage.plans[1].id);
  // (6 s of a timeline of 20; its trash and « Retirer l’image de fin », a rule between them.)
  assert.deepEqual([f.pop().style.left, f.pop().style['--half']], ['clamp(var(--half), 30%, calc(100% - var(--half)))', '42px']);
  // (0.6.158) Where it goes in the take when it is narrow: at its start, under its text, far from its length.
  assert.equal(f.pop().style['--take'], '25%');
  // Wide: between its photos, as it is. Narrow: over a place of photo, it goes into the take.
  place([box(500, 64), box(636, 64)], box(580, 40));
  f.ui.fitBar();
  assert.equal(f.pop().dataset.inside, 'false');
  place([box(500, 64), box(560, 64)], box(580, 40));
  f.ui.fitBar();
  assert.equal(f.pop().dataset.inside, 'true');
});

test('an empty bobine: its ghost has its two places of photo, at rest; a photo there makes it a take to create (0.6.157)', async () => {
  // (Capture 71: « sur la piste Prises, une prise fantôme de 5 s en pointillés, avec un « + » qui respire,
  // et ses deux emplacements de photo vides ».)
  const f = await setup().open();
  const slots = () => find(f.photos(), 'is-ghost');
  assert.deepEqual(slots().map(slot => [slot.className, slot.attributes['aria-label'], slot.style.left ?? null, slot.style.right ?? null]), [
    ['montage-photo is-start is-slot is-ghost', 'Image de début d’une nouvelle prise : glissez une image ici', '0%', null],
    ['montage-photo is-end is-slot is-ghost', 'Image de fin d’une nouvelle prise : glissez une image ici', null, 'calc(50% + 4px)'],
  ]);
  // A photo dropped on the end: a take to create of 5 s at 0 that arrives on it, chosen; the ghost's places are gone.
  f.get('montage-take')[2].ondragstart({ dataTransfer: { setData() {} } });
  slots()[1].ondrop(event(0));
  const [plan] = f.ui.state().montage.plans;
  assert.deepEqual([plan.at, plan.to, plan.todo.prompt, plan.photos, f.ui.state().chosen, slots().length], [0, 5, '', { end: { conversationId: C, runId: id(3), output: 0 } }, plan.id, 0]);
  // On the start, from an empty bobine again: it starts on it.
  const g = await setup().open();
  g.get('montage-take')[2].ondragstart({ dataTransfer: { setData() {} } });
  find(g.photos(), 'is-ghost')[0].ondrop(event(0));
  assert.deepEqual(g.ui.state().montage.plans[0].photos, { start: { conversationId: C, runId: id(3), output: 0 } });
});

test('the end of a video under the pointer shows, in light dots, the suite pulling it would give (0.6.157)', async () => {
  // (Capture 72: « une poignée, le curseur ↔, et en pointillés légers la suite qu'on obtiendrait en tirant ».)
  const f = await setup().open();
  f.get('montage-take')[0].ondblclick();
  f.get('montage-take')[2].ondblclick();
  const hint = () => find(f.root, 'bobine-edge-hint')[0],
    grips = () => find(f.root, 'montage-grip');
  assert.equal(hint().hidden, true);
  // The end of the video (5 s, then the image: a timeline of 20 s): two seconds after it.
  const [, end, image] = grips();
  end.onpointerenter();
  assert.deepEqual([hint().hidden, hint().style.left, hint().style.width], [false, '25%', 'calc(10% - 4px)']);
  end.onpointerleave();
  assert.equal(hint().hidden, true);
  // Pressed: gone, the real suite comes under the hand.
  end.onpointerenter();
  f.press(end, 500);
  assert.equal(hint().hidden, true);
  f.pointer.up();
  // Not the start of a video, nor an image, nor a take to create.
  assert.deepEqual([grips()[0].onpointerenter, image.onpointerenter], [undefined, undefined]);
});

test('the preview says what happens in a take to create at rest, and leaves the place of its end photo only when it has one (0.6.159)', async () => {
  // (His photo of 20/11: an upright film, the whole text in a column of a few words, over « EN COURS ».)
  const f = await setup({ extra: photos(), create: async () => null }).open();
  lay(f);
  f.write(0, 'Il lève les yeux.');
  f.write(1, 'Il regarde la mer.');
  const frame = () => f.get('montage-frame')[0],
    words = () => find(frame(), 'montage-frame-words')[0];
  // The head on the first (its end photo): its text, the place of the photo left.
  f.ui.seek(1);
  assert.deepEqual([words().hidden, words().textContent, frame().dataset.end, frame().dataset.tall], [false, 'Il lève les yeux.', 'true', 'false']);
  // Without an end photo: the whole width is its text's.
  f.ui.select(f.ui.state().montage.plans[1].id);
  f.pop().children.find(control => control.attributes['aria-label'] === 'Retirer l’image de fin').onclick();
  f.ui.seek(6);
  assert.deepEqual([words().textContent, frame().dataset.end], ['Il regarde la mer.', 'false']);
  // An upright film: said to the frame, its text goes above the photo.
  Object.assign(f.get('montage-format')[0], { value: '9:16' }).onchange();
  assert.equal(frame().dataset.tall, 'true');
});

test('a suite without its text that its video stops says so in its line (0.6.159)', async () => {
  // (Met while taking the captures of 0.6.155: the second clip shown 4 s of its 6,71 s; its suite, without
  // a text, was left out of « Créer » and its line said nothing.)
  const old = {
    schemaVersion: 1, id: id(950), name: 'Le pêcheur', format: '16:9', width: 1344, height: 768, fps: 24, sounds: [],
    plans: [
      { id: id(951), at: 0, kind: 'video', source: { conversationId: C, runId: id(1), output: 0 }, from: 0, to: 3, frame: 'fit', volume: 1 },
      { id: id(952), at: 3, kind: 'video', todo: { prompt: '', suite: true }, from: 0, to: 4, frame: 'fit', volume: 1 },
    ],
  };
  const f = await setup({ stored: [old], create: async () => null, write: async () => ({ prompt: 'x' }) }).open();
  assert.deepEqual([f.lines().map(line => line[3]), f.go(), f.goMain().disabled], [['La vidéo d’avant est coupée avant sa fin : rendez-lui sa fin, ou posez une image de début.'], 'Créer', true]);
});

test('the styles of the Bobine: a take being made fills from the left, no moving ground; the text of the preview is three lines at most (0.6.159)', async () => {
  // (His photos of 20/11: the take being made kept the moving ground of the Montage of 0.6.142, and the
  // text covered the preview. What is drawn cannot be read here: the rules that draw it are.)
  const { readFile } = await import('node:fs/promises');
  const css = (await readFile(new URL('../public/moodix.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const rule = selector => {
    const at = css.lastIndexOf(selector + ' {');
    assert.notEqual(at, -1, selector);
    return css.slice(at, css.indexOf('}', at));
  };
  assert.match(rule('#bobine-view .montage-piece.is-todo.is-making::before,\n#bobine-view .montage-piece.is-todo.is-making::after'), /content: none;/);
  assert.match(rule('#bobine-view .montage-piece.is-todo.is-making'), /border: 1px dashed/);
  assert.match(rule('#bobine-view .montage-piece.is-making > .montage-piece-bar'), /inset: 0;[\s\S]*z-index: -1;/);
  assert.match(rule('#bobine-view .montage-piece.is-making > .montage-piece-length'), /display: block;/);
  // (0.6.169) Cut inside its plate, not by it: no fourth line half shown in its margin.
  assert.doesNotMatch(rule('#bobine-view .montage-frame-words'), /line-clamp|overflow/);
  assert.match(rule('#bobine-view .montage-frame-text'), /-webkit-line-clamp: 3;[\s\S]*overflow: hidden;/);
  assert.match(rule('#bobine-view .montage-frame-words[hidden]'), /display: none;/);
  assert.match(rule("#bobine-view .montage-frame[data-end='true'][data-tall='true'] > .montage-frame-words"), /bottom: 82px;/);
});

// ------------------------------------------------------------------ what was left of the review (0.6.160)
/** A bobine kept: a video of 5 s (take 7), its suite of `seconds` to create, then `more`. */
const suiteOf = (seconds, more = []) => ({
  schemaVersion: 1, id: id(950), name: 'Le pêcheur', format: '16:9', width: 1344, height: 768, fps: 24, sounds: [],
  plans: [
    { id: id(951), at: 0, kind: 'video', source: { conversationId: C, runId: id(7), output: 0 }, from: 0, to: 5, frame: 'fit', volume: 1 },
    { id: id(952), at: 5, kind: 'video', todo: { prompt: 'Il marche vers la mer.', suite: true }, from: 0, to: seconds, frame: 'fit', volume: 1 },
    ...more,
  ],
});
/** That bobine on the page, with LTX 2.5 (10,04 s of a clip, 9,67 s of a continuation); `answer(n, frames)`: the clip made, `frames` long with what it continues. */
async function parted(montage) {
  const asked = [],
    answers = [];
  const f = await setup({
    stored: [montage],
    extra: [made(7, 120)],
    modelFor: () => 'ltx-25',
    longestFor: verb => ({ create_video: 10.04, extend_video: 9.67 })[verb],
    create: wanted => (asked.push(structuredClone(wanted)), new Promise(resolve => answers.push(resolve))),
  }).open();
  await settle();
  await settle();
  const answer = async (n, frames) => {
    f.runs.push(made(n, frames));
    answers.shift()(f.runs.at(-1));
    await settle();
    await settle();
  };
  return { f, asked, answer };
}

test('the parts of a take are counted again as each is made: one made shorter than asked leaves nothing behind (0.6.160)', async () => {
  // (Counted once, at « Créer »: 19 s in two parts of 9,5 s. The first made 9 s long, 10 s were left, more
  // than a continuation makes at once: the second part made half of them, and the series ended with 5 s
  // of the take still to create.)
  const { f, asked, answer } = await parted(suiteOf(19));
  assert.deepEqual([f.said('bobine-line-parts'), f.go()], [['2 × 09.50 s'], 'Créer 2 prises']);
  f.goMain().onclick();
  await settle();
  assert.deepEqual([asked[0].args.duration, f.go()], [9.5, '1 sur 2']);
  // 9 s made (its file: 14 s with the video): 10 s are left, two parts of 5 s. The series has three.
  await answer(60, 336);
  assert.deepEqual([f.go(), asked[1].args.duration, asked[1].args.source], ['2 sur 3', 5, { output: id(60) }]);
  assert.deepEqual(f.ui.state().montage.plans.map(plan => [plan.at, plan.from, plan.to, Boolean(plan.todo)]), [[0, 0, 5, false], [5, 5, 14, false], [14, 0, 10, true]]);
  await answer(61, 456);
  assert.deepEqual([f.go(), asked[2].args.duration, asked[2].args.source], ['3 sur 3', 5, { output: id(61) }]);
  await answer(62, 576);
  assert.deepEqual([f.ui.state().filling, f.get('bobine-line').length, f.go(), asked.length], [null, 0, 'Créer', 3]);
  assert.deepEqual(f.ui.state().montage.plans.map(plan => [plan.from, plan.to, Boolean(plan.todo)]), [[0, 5, false], [5, 14, false], [14, 19, false], [19, 24, false]]);
});

test('a part made much longer than asked: the take is whole sooner, and the series goes on to the takes after it (0.6.160)', async () => {
  // (25 s in three parts, then a take of its own. The first part made 16 s long, the second ended the
  // take: the third, still counted, was asked of a take already whole, refused, and the take after it
  // never made.)
  const own = { id: id(953), at: 30, kind: 'video', todo: { prompt: 'La mer, au matin.' }, from: 0, to: 3, frame: 'fit', volume: 1 };
  const { f, asked, answer } = await parted(suiteOf(25, [own]));
  assert.equal(f.go(), 'Créer 4 prises');
  f.goMain().onclick();
  await settle();
  await answer(60, 504);
  assert.deepEqual([f.go(), asked[1].args.duration], ['2 sur 3', 9]);
  await answer(61, 720);
  assert.deepEqual([f.go(), asked.length, asked[2].verb, asked[2].args.prompt], ['3 sur 3', 3, 'create_video', 'La mer, au matin.']);
  await answer(62, 72);
  assert.deepEqual([f.ui.state().filling, f.get('bobine-line').length, [...f.ui.state().failed]], [null, 0, []]);
});

test('a model that makes next to nothing each time is not asked without end: the series stops at twice its length (0.6.160)', async () => {
  const { f, asked, answer } = await parted(suiteOf(19));
  f.goMain().onclick();
  await settle();
  // Half a second each time, of 9,5 s asked: two parts foreseen, four made at most; what is left stays to create.
  for (let part = 0; part < 4; part++) await answer(60 + part, 120 + 12 * (part + 1));
  assert.deepEqual([asked.length, f.ui.state().filling, f.get('bobine-line').length, f.go()], [4, null, 1, 'Créer 2 prises']);
});

test('leaving the page while Moodix AI writes a take of the series ends the series there, and its line says why (0.6.160)', async () => {
  // (Left while a take was made, the series goes on, the Studio keeping its conversation; left while
  // Moodix AI wrote one, it ended there without a word.)
  const { pens, write } = pen();
  const { f, asked } = await series({ texts: ['', 'Il regarde la mer.'], write });
  f.goMain().onclick();
  await settle();
  assert.deepEqual([pens.length, f.ui.state().writing.series], [1, true]);
  await f.ui.leave();
  for (let turn = 0; turn < 3; turn++) await settle();
  assert.deepEqual([pens[0].signal.aborted, f.ui.state().filling, f.ui.state().writing], [true, null, null]);
  pens[0].resolve({ prompt: 'Too late.' });
  for (let turn = 0; turn < 3; turn++) await settle();
  assert.deepEqual([asked.length, f.ui.state().montage.plans.map(plan => plan.todo.prompt)], [0, ['', 'Il regarde la mer.']]);
  // Back on the page: said in its line, as what stops a take is. « Créer » takes it up again.
  f.root = f.ui.desk();
  assert.deepEqual([f.lines()[0][3], f.get('bobine-line')[0].dataset.state, f.go()], ['Série arrêtée : vous avez quitté la Bobine pendant que Moodix AI écrivait cette prise.', 'failed', 'Créer 2 prises']);
  f.goMain().onclick();
  await settle();
  assert.deepEqual([pens.length, f.lines()[0][3], f.said('bobine-line-writing')], [2, '', ['Moodix AI écrit']]);
  // The texts the Éclipse asks for, let go with the page too, are no series: nothing is said of them.
  const { pens: others, write: eclipse } = pen();
  const { f: g } = await series({ texts: ['', ''], write: eclipse });
  g.get('bobine-go-agent')[0].onclick();
  await settle();
  await g.ui.leave();
  assert.deepEqual([others[0].signal.aborted, [...g.ui.state().failed]], [true, []]);
});

test('another project chosen on the page while Moodix AI writes a take of a series: the series ends with its bobine (0.6.160)', async () => {
  // (A take being made keeps the Studio, and the bobine, in its project. While Moodix AI wrote one,
  // nothing did: its text was written in the bobine of the other project, kept there, its take asked there.)
  const { pens, write } = pen();
  const { f, asked } = await series({ texts: ['', 'Il regarde la mer.'], write });
  f.goMain().onclick();
  await settle();
  f.move('p2');
  f.ui.refreshed();
  for (let turn = 0; turn < 4; turn++) await settle();
  assert.deepEqual([pens[0].signal.aborted, f.ui.state().filling, f.ui.state().writing], [true, null, null]);
  pens[0].resolve({ prompt: 'Too late.' });
  for (let turn = 0; turn < 4; turn++) await settle();
  assert.deepEqual([asked.length, f.saves().length, f.ui.state().montage.plans.map(plan => plan.todo.prompt)], [0, 0, ['', 'Il regarde la mer.']]);
});

test('a save refused is still to keep: tried again once on its own, and when the page is left (0.6.160)', async () => {
  // (It was held for kept: leaving the page found nothing to keep, and the bobine stayed as the disk had it.)
  const fail = { 'montages/save': 'Disque plein.' };
  const f = await setup({ fail }).open();
  f.get('montage-take')[0].ondblclick();
  await f.later();
  assert.deepEqual([f.saves().length, f.said('montage-status')], [1, ['Non gardée : Disque plein.']]);
  // Once on its own, a moment later; not without end.
  await f.later();
  assert.equal(f.saves().length, 2);
  await f.later();
  await f.later();
  assert.equal(f.saves().length, 2);
  // The page left: kept then.
  delete fail['montages/save'];
  await f.ui.leave();
  assert.deepEqual([f.saves().length, f.kept.size, f.saves().at(-1).body.montage.plans.length], [3, 1, 1]);
  // A refusal that passes: kept on its own, and nothing said any more; a later refusal is tried again too.
  const passing = { 'montages/save': 'Le serveur redémarre.' };
  const g = await setup({ fail: passing }).open();
  g.get('montage-take')[0].ondblclick();
  await g.later();
  delete passing['montages/save'];
  await g.later();
  assert.deepEqual([g.saves().length, g.kept.size, g.said('montage-status')], [2, 1, ['']]);
  passing['montages/save'] = 'Disque plein.';
  g.get('montage-take')[1].ondblclick();
  await g.later();
  await g.later();
  assert.equal(g.saves().length, 4);
});

test('what a bobine could not keep is not kept in the name of the one that takes its place (0.6.160)', async () => {
  const one = { schemaVersion: 1, id: id(900), name: 'Le renard', format: '16:9', width: 1344, height: 768, fps: 24, plans: [], sounds: [] },
    two = { ...one, id: id(910), name: 'Le phare' };
  // Another one opened: it is as the disk has it, nothing of it is to keep.
  const fail = { 'montages/save': 'Disque plein.' };
  const f = await setup({ stored: [one, two], fail }).open();
  f.get('montage-take')[0].ondblclick();
  await f.later();
  f.pick(id(910));
  for (let turn = 0; turn < 4; turn++) await settle();
  assert.deepEqual([f.ui.state().montage.id, f.saves().length], [id(910), 2]);
  delete fail['montages/save'];
  await f.later();
  await f.ui.leave();
  assert.deepEqual(f.saves().map(call => call.body.montage.id), [id(900), id(900)]);
  // A new one, never kept, taken out: no empty bobine is kept in its place.
  const refused = { 'montages/save': 'Disque plein.' };
  const g = await setup({ fail: refused }).open();
  g.get('montage-take')[0].ondblclick();
  await g.later();
  g.pick('remove');
  g.button('Supprimer').onclick();
  for (let turn = 0; turn < 4; turn++) await settle();
  assert.deepEqual([g.notices, g.ui.state().montage.plans.length], [['Bobine mise de côté.'], 0]);
  delete refused['montages/save'];
  await g.later();
  await g.ui.leave();
  assert.deepEqual([g.saves().length, g.kept.size], [1, 0]);
  // « + Nouvelle bobine » after a refusal: the same.
  const again = { 'montages/save': 'Disque plein.' };
  const h = await setup({ fail: again }).open();
  h.get('montage-take')[0].ondblclick();
  await h.later();
  h.pick('new');
  for (let turn = 0; turn < 4; turn++) await settle();
  delete again['montages/save'];
  await h.later();
  await h.ui.leave();
  assert.equal(h.kept.size, 0);
  // And the refusals of the one before are forgotten with it: the new one is tried again on its own too.
  const k = await setup({ fail: { 'montages/save': 'Disque plein.' } }).open();
  k.get('montage-take')[0].ondblclick();
  await k.later();
  k.pick('new');
  for (let turn = 0; turn < 4; turn++) await settle();
  assert.equal(k.saves().length, 2);
  k.get('montage-take')[0].ondblclick();
  await k.later();
  await k.later();
  assert.equal(k.saves().length, 4);
});

test('under a window open over the page, Ctrl+Z is the window’s: nothing of the bobine is undone (0.6.160)', async () => {
  const f = await setup().open();
  f.get('montage-take')[0].ondblclick();
  // (Paramètres, a confirmation: a `dialog` open on the page.)
  shown.querySelector = asked => (asked === 'dialog[open]' ? {} : null);
  try {
    f.pageKey('z', { ctrlKey: true });
    assert.equal(f.ui.state().montage.plans.length, 1);
    shown.querySelector = () => null;
    f.pageKey('z', { ctrlKey: true });
    assert.equal(f.ui.state().montage.plans.length, 0);
  } finally {
    delete shown.querySelector;
  }
});

test('a bobine of the Archives is not opened in a project the Studio does not hold: said, nothing read (0.6.160)', async () => {
  // (0.6.81: a work keeps the Studio, and the Bobine with it, in its project while the page shows
  // another. The card of a bobine of that other project asked it there: « Bobine illisible : Cette
  // bobine n’existe plus. », of a bobine that exists.)
  const { readFile } = await import('node:fs/promises');
  const { runInNewContext } = await import('node:vm');
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    begin = source.indexOf('async function openBobine('),
    end = source.indexOf('// The line under the tab of the view', begin);
  assert.ok(begin > 0 && end > begin);
  const done = [],
    state = { projectId: 'p2' };
  let held = 'p1';
  const sandbox = {
    state,
    studioUI: { heldProject: () => held, bobine: () => ({ wanted: id => done.push(['wanted', id]) }) },
    notice: text => done.push(['notice', text]),
    newConversation: async project => {
      done.push(['new', project]);
      state.projectId = project;
    },
    showBobine: () => done.push(['shown']),
  };
  runInNewContext(source.slice(begin, end) + '\nthis.open = openBobine;', sandbox);
  await sandbox.open('p2', 'b1');
  assert.deepEqual(done.splice(0), [['notice', 'Une création est en cours dans un autre projet : cette bobine s’ouvrira après elle, d’un nouveau clic.']]);
  // Of the project the work is in: opened, as before.
  await sandbox.open('p1', 'b2');
  assert.deepEqual(done.splice(0), [['new', 'p1'], ['wanted', 'b2'], ['shown']]);
  // Nothing held: in its project, a new conversation there first when the page is in another.
  held = null;
  await sandbox.open('p2', 'b1');
  assert.deepEqual(done.splice(0), [['new', 'p2'], ['wanted', 'b1'], ['shown']]);
  await sandbox.open('p2', 'b1');
  assert.deepEqual(done.splice(0), [['wanted', 'b1'], ['shown']]);
});

test('what the download of 0.6.153 left behind is gone: the card of the chat is not the Bobine’s any more (0.6.160)', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = name => readFile(new URL('../public/' + name, import.meta.url), 'utf8');
  assert.doesNotMatch(await read('moodix.css'), /\.bobine-download/);
  assert.doesNotMatch(await read('missing-file.mjs'), /onCancel/);
});

// ------------------------------------------------------------------ asking Moodix AI (0.6.162)
// (Maquette A1 à A10, claude_design/arrangeur/maquette : le champ sous l'aperçu, son choix du 20/11.)
/** What Moodix AI is asked, held until the test answers; the page with a video laid and two photos at hand. */
async function asking(more = {}) {
  const asked = [];
  const f = await setup({
    extra: photos(),
    create: async () => null,
    arrange: (wanted, { signal }) =>
      new Promise((resolve, reject) => asked.push({ request: wanted.request, previous: structuredClone(wanted.previous), plans: wanted.montage.plans.length, signal, resolve, reject })),
    ...more,
  }).open();
  f.get('montage-take')[0].ondblclick();
  await f.later();
  const box = () => f.get('bobine-ask')[0],
    field = () => find(box(), 'bobine-ask-words')[0],
    send = () => find(box(), 'bobine-ask-send')[0],
    state = () => find(box(), 'bobine-ask-field')[0].dataset.state,
    type = words => Object.assign(field(), { value: words }).oninput(),
    enter = (more = {}) => field().onkeydown({ key: 'Enter', preventDefault() {}, ...more }),
    links = () => find(box(), 'bobine-ask-link'),
    link = words => links().find(control => control.textContent === words),
    answer = async (plan, problems = []) => {
      asked.at(-1).resolve({ arrangement: plan, problems });
      for (let turn = 0; turn < 4; turn++) await settle();
    };
  return { f, asked, box, field, send, state, type, enter, links, link, answer };
}
const SUITE = { say: 'Deux prises : il se lève, puis la mer.', fill: [], add: [{ text: 'Il se lève lentement.', seconds: 4, link: 'suite', start: null, end: 5 }, { text: 'La mer, au matin.', seconds: 5, link: 'cut', start: 6, end: null }] };

test('under the preview, a request is asked to Moodix AI; its plan is laid in takes to create, one step of « Annuler » (0.6.162)', async () => {
  const { f, asked, box, field, send, state, type, enter, link, answer } = await asking();
  // At rest: its words of invitation, nothing to send; between the time and the format.
  const transport = f.get('montage-transport')[0];
  assert.deepEqual(transport.children.map(child => child.className.split(' ')[0]), ['montage-play', 'montage-clock', 'montage-clock-total', 'bobine-ask', 'montage-format']);
  assert.deepEqual([field().placeholder, field().value, send().disabled, state(), box().attributes['aria-label']], ['Demandez un film, une suite…', '', true, 'rest', 'Moodix AI']);
  // Written: the arrow lights up; spaces alone are no request. Maj+Entrée is a line, not a request.
  type('   ');
  assert.deepEqual([send().disabled, state()], [true, 'rest']);
  enter();
  await settle();
  assert.deepEqual([asked.length, f.ui.state().arranging], [0, null]);
  type('Invente la suite.');
  assert.deepEqual([send().disabled, state()], [false, 'typed']);
  enter({ shiftKey: true });
  assert.equal(asked.length, 0);
  const saves = f.saves().length;
  enter();
  await settle();
  // Asked with the bobine as it is: « MOODIX AI ARRANGE », its request under it, « Arrêter »; the bobine is not changed meanwhile.
  assert.deepEqual([asked.length, asked[0].request, asked[0].previous, asked[0].plans], [1, 'Invente la suite.', [], 1]);
  assert.deepEqual([state(), find(box(), 'bobine-ask-label')[0].textContent, find(box(), 'bobine-ask-asked')[0].textContent, find(box(), 'bobine-halt')[0].textContent], ['working', 'Moodix AI arrange', 'Invente la suite.', 'Arrêter']);
  assert.deepEqual([find(box(), 'bobine-ask-words').length, f.get('montage-format')[0].disabled, f.get('montage-pick')[0].disabled], [0, true, true]);
  f.plans()[0].onkeydown({ key: 'Delete' });
  assert.deepEqual([f.plans().length, f.notices.at(-1)], [1, 'Moodix AI arrange la bobine : attendez la fin, ou arrêtez.']);
  // Its plan laid by the application: a suite that arrives on a photo, then a cut that starts on another.
  await answer(SUITE);
  const plans = f.ui.state().montage.plans;
  assert.deepEqual(
    plans.map(plan => [plan.at, plan.to - plan.from, plan.todo?.prompt ?? null, Boolean(plan.todo?.suite), plan.photos ?? null]),
    [
      [0, 5, null, false, null],
      [5, 4, 'Il se lève lentement.', true, { end: { conversationId: C, runId: id(5), output: 0 } }],
      [9, 5, 'La mer, au matin.', false, { start: { conversationId: C, runId: id(6), output: 0 } }],
    ],
  );
  // Said in one line, the facts counted here; the field is empty for the next request; kept at once.
  assert.deepEqual([find(box(), 'bobine-ask-facts')[0].textContent, find(box(), 'bobine-ask-done').length, find(box(), 'bobine-ask-said').length], ['2 prises ajoutées', 1, 0]);
  assert.deepEqual([field().value, state(), send().disabled, f.go(), f.saves().length > saves, f.get('montage-frame')[0].dataset.asked], ['', 'rest', true, 'Créer 2 prises', true, 'true']);
  assert.deepEqual(f.saves().at(-1).body.montage.plans.length, 3);
  // « Annuler » takes all of it out at once; « Rétablir » puts it back, and nothing is said of it any more.
  link('Annuler').onclick();
  assert.deepEqual([f.ui.state().montage.plans.length, f.ui.state().laid, find(box(), 'bobine-ask-done').length, f.get('montage-frame')[0].dataset.asked], [1, null, 0, 'false']);
  f.ui.redo();
  assert.deepEqual([f.ui.state().montage.plans.length, find(box(), 'bobine-ask-done').length], [3, 0]);
  f.pageKey('z', { ctrlKey: true });
  assert.equal(f.ui.state().montage.plans.length, 1);
  // The next request says the one before, and what was answered.
  type('Autre chose.');
  send().onclick();
  await settle();
  assert.deepEqual(asked[1].previous, [{ request: 'Invente la suite.', say: 'Deux prises : il se lève, puis la mer.' }]);
});

test('what Moodix AI laid is said while it is the last step: a change by hand, and its line is gone (0.6.162)', async () => {
  // (Its « Annuler » undoes the last step: after another change, it would undo that one.)
  const { f, box, type, enter, answer } = await asking();
  type('Invente la suite.');
  enter();
  await settle();
  await answer(SUITE);
  assert.equal(find(box(), 'bobine-ask-done').length, 1);
  f.write(0, 'Il se lève, lentement, face à la mer.');
  assert.deepEqual([f.ui.state().laid, find(box(), 'bobine-ask-done').length, f.ui.state().montage.plans.length], [null, 0, 3]);
});

test('the detail of what was laid: what Moodix AI said, and each adjustment with the instants of its take (0.6.162)', async () => {
  // (Maquette A5. The application repairs its plan: a suite that started on a photo is a new shot, a
  // take that is not of the project is no photo; what could not be read of the plan is said first.)
  const { f, box, type, enter, link, answer } = await asking();
  type('Invente la suite.');
  enter();
  await settle();
  await answer(
    { say: 'Deux prises.', fill: [], add: [{ text: 'Il se lève.', seconds: 4, link: 'suite', start: 5, end: null }, { text: 'La mer.', seconds: 5, link: 'cut', start: null, end: 42 }] },
    ['Le 3e ajout du plan n’a ni texte ni prise : il est laissé de côté.'],
  );
  // Folded: « 3 ajustements », in place of « Détail ».
  assert.deepEqual([find(box(), 'bobine-ask-facts')[0].textContent, link('Détail'), link('3 ajustements').attributes['aria-expanded'], find(box(), 'bobine-ask-said').length], ['2 prises ajoutées', undefined, 'false', 0]);
  assert.equal(f.get('montage-frame')[0].dataset.asked, 'true');
  link('3 ajustements').onclick();
  assert.deepEqual([link('3 ajustements').attributes['aria-expanded'], find(box(), 'bobine-ask-say')[0].textContent], ['true', 'Deux prises.']);
  // (0.6.163) Unfolded, its plate would lie across the text the preview shows of a take: that text is not shown meanwhile.
  assert.equal(f.get('montage-frame')[0].dataset.asked, 'open');
  assert.deepEqual(
    find(box(), 'bobine-ask-notes')[0].children.map(item => item.children.map(part => part.textContent)),
    [
      ['Le 3e ajout du plan n’a ni texte ni prise : il est laissé de côté.'],
      ['05.00 → 09.00', 'Elle commence sur la prise 5 : une suite ne commence pas sur une image, c’est un nouveau plan.'],
      ['09.00 → 14.00', 'La prise 42 n’est pas dans ce projet : pas d’image de fin.'],
    ],
  );
  // « Annuler » is still there, unfolded; folded again by the same link.
  assert.ok(link('Annuler'));
  link('3 ajustements').onclick();
  assert.deepEqual([find(box(), 'bobine-ask-said').length, f.get('montage-frame')[0].dataset.asked], [0, 'true']);
  // Without adjustment: « Détail » shows what it said.
  link('Annuler').onclick();
  f.ask = null;
  const again = await asking();
  again.type('Invente la suite.');
  again.enter();
  await settle();
  await again.answer(SUITE);
  again.link('Détail').onclick();
  assert.deepEqual([find(again.box(), 'bobine-ask-say')[0].textContent, find(again.box(), 'bobine-ask-notes').length], ['Deux prises : il se lève, puis la mer.', 0]);
});

test('nothing laid: what Moodix AI said, a cross, and the request still in its field; a refusal is said the same way (0.6.162)', async () => {
  // (Maquette A6.)
  const { f, asked, box, field, state, type, enter, links, link, answer } = await asking();
  type('Termine sur la prise 42.');
  enter();
  await settle();
  const saves = f.saves().length,
    before = f.ui.state().montage;
  await answer({ say: 'Je ne trouve pas la prise 42 dans ce projet.', fill: [], add: [] });
  assert.deepEqual([f.ui.state().montage === before, f.saves().length, f.ui.state().past], [true, saves, 1], 'the bobine is the same, nothing kept, no step to undo');
  assert.deepEqual([find(box(), 'bobine-ask-facts')[0].textContent, find(box(), 'bobine-ask-say')[0].textContent, link('Annuler'), field().value, state()], ['Moodix AI', 'Je ne trouve pas la prise 42 dans ce projet.', undefined, 'Termine sur la prise 42.', 'typed']);
  // (0.6.163) What it said is a plate too: the text of the preview is not shown under it.
  assert.equal(f.get('montage-frame')[0].dataset.asked, 'open');
  // The cross closes it.
  links().find(control => control.attributes['aria-label'] === 'Fermer').onclick();
  assert.deepEqual([f.ui.state().laid, find(box(), 'bobine-ask-said').length], [null, 0]);
  // Refused (the chat model is not started, its answer could not be read): said in amber, the request stays.
  enter();
  await settle();
  asked.at(-1).reject(new Error('Le moteur n’est pas prêt. Configure-le puis démarre-le.'));
  for (let turn = 0; turn < 4; turn++) await settle();
  const said = find(box(), 'bobine-ask-say')[0];
  assert.deepEqual([said.className, said.textContent, field().value, f.ui.state().arranging, f.ui.state().montage.plans.length], ['bobine-ask-say is-problem', 'Le moteur n’est pas prêt. Configure-le puis démarre-le.', 'Termine sur la prise 42.', null, 1]);
});

test('« Arrêter » lets the request go at once, and so does leaving the page; its words stay in the field (0.6.162)', async () => {
  const { f, asked, box, field, type, enter, answer } = await asking();
  type('Invente la suite.');
  enter();
  await settle();
  find(box(), 'bobine-halt')[0].onclick();
  assert.deepEqual([asked[0].signal.aborted, f.ui.state().arranging, field().value, f.get('montage-format')[0].disabled], [true, null, 'Invente la suite.', false]);
  // Its answer, late, lays nothing.
  await answer(SUITE);
  assert.deepEqual([f.ui.state().montage.plans.length, f.ui.state().laid], [1, null]);
  // The page left while it arranges: let go; back on the page, the words are still there.
  enter();
  await settle();
  await f.ui.leave();
  assert.deepEqual([asked[1].signal.aborted, f.ui.state().arranging], [true, null]);
  await answer(SUITE);
  f.root = f.ui.desk();
  assert.deepEqual([f.ui.state().montage.plans.length, find(f.get('bobine-ask')[0], 'bobine-ask-words')[0].value], [1, 'Invente la suite.']);
});

test('nothing is asked while the bobine is at work, nor without Moodix AI at hand (0.6.162)', async () => {
  // A take being created: the field is greyed, Entrée asks nothing.
  const makes = [];
  const { f, asked, field, send, type, enter, answer } = await asking({ create: () => new Promise(resolve => makes.push(resolve)) });
  type('Invente la suite.');
  enter();
  await settle();
  await answer(SUITE);
  type('Encore une.');
  f.goMain().onclick();
  await settle();
  assert.deepEqual([makes.length, field().disabled, send().disabled, field().value], [1, true, true, 'Encore une.']);
  enter();
  await settle();
  assert.equal(asked.length, 1);
  // Without it (a page that gives none): the row is as it was, with its empty middle.
  const bare = await setup().open();
  assert.deepEqual([bare.get('bobine-ask').length, bare.get('montage-transport')[0].children.map(child => child.className.split(' ')[0])], [0, ['montage-play', 'montage-clock', 'montage-clock-total', 'bobine-fil-gap', 'montage-format']]);
});

test('the styles of the request: it grows upwards from its row, what is laid is said above it, the text of the preview goes up (0.6.162)', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = (await readFile(new URL('../public/moodix.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const rule = selector => {
    const at = css.lastIndexOf(selector + ' {');
    assert.notEqual(at, -1, selector);
    return css.slice(at, css.indexOf('}', at));
  };
  assert.match(rule('.bobine-ask'), /position: relative;[\s\S]*flex: 100 1 0;[\s\S]*height: 40px;/);
  assert.match(rule('.bobine-ask-stack'), /position: absolute;[\s\S]*bottom: 0;[\s\S]*flex-direction: column;/);
  // (Seen in the real page: the row of the time does not break its words, and what is said above the field
  // went out of its plate; at 1280 wide, the invitation of the field took two lines.)
  assert.match(rule('.bobine-ask-stack'), /white-space: normal;/);
  assert.match(rule('#bobine-view .bobine-desk textarea.bobine-ask-words::placeholder'), /white-space: nowrap;\n  text-overflow: ellipsis;/);
  assert.match(css, /#bobine-view \.bobine-desk textarea\.bobine-ask-words \{\n  flex: 1 1 auto;\n  field-sizing: content;[\s\S]*?max-height: calc\(5lh \+ 14px\);/);
  assert.match(rule('.bobine-ask-answer'), /width: max-content;\n  min-width: 100%;/);
  assert.match(rule('.bobine-ask-answer[hidden]'), /display: none;/);
  assert.match(rule("#bobine-view .montage-frame[data-asked='true'] > .montage-frame-words"), /bottom: 46px;/);
  assert.match(rule("#bobine-view .montage-frame[data-asked='open'] > .montage-frame-words"), /display: none;/);
});

test('asked from its field, the keys are the field’s again once Moodix AI has answered (0.6.162)', async () => {
  const { f, asked, field, type, enter, answer } = await asking();
  type('Invente la suite.');
  field().focus();
  enter();
  await settle();
  assert.notEqual(f.focused(), field, 'its field is gone while Moodix AI arranges');
  await answer(SUITE);
  assert.equal(f.focused(), field());
  // Refused: the same, its words are there to be said otherwise.
  type('Termine sur la prise 42.');
  enter();
  await settle();
  asked.at(-1).reject(new Error('Non.'));
  for (let turn = 0; turn < 4; turn++) await settle();
  assert.deepEqual([f.focused() === field(), field().value], [true, 'Termine sur la prise 42.']);
  // Sent by its arrow from elsewhere, or the keys taken elsewhere meanwhile: they stay where they are.
  const take = f.plans()[0];
  take.focus();
  find(f.get('bobine-ask')[0], 'bobine-ask-send')[0].onclick();
  await settle();
  await answer({ say: 'Rien.', fill: [], add: [] });
  assert.notEqual(f.focused(), field());
});

test('another bobine: what was asked in the one before is not said again to Moodix AI (0.6.162)', async () => {
  const { f, asked, type, enter, answer } = await asking();
  type('Invente la suite.');
  enter();
  await settle();
  await answer(SUITE);
  f.pick('new');
  for (let turn = 0; turn < 4; turn++) await settle();
  assert.deepEqual([f.ui.state().laid, f.ui.state().asks], [null, []]);
  type('Un film sur la mer.');
  enter();
  await settle();
  assert.deepEqual([asked[1].request, asked[1].previous, asked[1].plans], ['Un film sur la mer.', [], 0]);
});

// ------------------------------------------------------------------ his returns of 21/11 (0.6.169)
test('a click on a take of « Prises » opens it once the time of a double click is past; a double click lays it, unopened (0.6.169)', async () => {
  // (His words of 21/11: « un click simple dans un média à gauche dans bobine doit l'ouvrir en grand. Le
  // double click doit le mettre dans la timeline. »)
  const f = await setup().open();
  const tile = () => f.get('montage-take')[0],
    opened = () => f.calls.filter(call => call.route === 'open').map(call => call.body);
  tile().onclick({ detail: 1 });
  assert.deepEqual([opened(), f.plans().length], [[], 0]);
  await f.later();
  assert.deepEqual([opened(), f.plans().length], [[id(1)], 0]);
  // The two clicks of a double click, then the double click: laid at the end, not opened.
  tile().onclick({ detail: 1 });
  tile().onclick({ detail: 2 });
  tile().ondblclick();
  await f.later();
  assert.deepEqual([opened(), f.plans().length], [[id(1)], 1]);
  // Entrée lays it (the click a button gets from that key is not let through: it would open it too).
  let taken = false;
  tile().onkeydown({ key: 'Enter', preventDefault: () => (taken = true) });
  await f.later();
  assert.deepEqual([opened(), f.plans().length, taken], [[id(1)], 2, true]);
  // A drag begun meanwhile opens nothing.
  tile().onclick({ detail: 1 });
  tile().ondragstart({ dataTransfer: { setData() {} } });
  tile().ondragend();
  await f.later();
  assert.deepEqual(opened(), [id(1)]);
});

test('a take carried over the timeline is drawn where it would go, the takes it pushes making room; nothing changes until it is dropped (0.6.169)', async () => {
  // (« On ne voit pas où on le drop. » Eight seconds of takes: twenty on 2000 pixels, a second is 100.)
  const ghosts = [];
  const f = await setup({ width: 2000, dragImage: (...given) => ghosts.push(given) }).open();
  for (const at of [0, 1]) f.get('montage-take')[at].ondblclick();
  const tile = f.get('montage-take')[2],
    transfer = { setData() {} },
    lefts = () => f.plans().map(piece => piece.style.left),
    shadows = () => f.get('bobine-drop'),
    starts = () => f.ui.state().montage.plans.map(plan => plan.at);
  // Small under the hand, at the size of a take of the track (the Studio draws it, studio.mjs); dimmed at
  // its place; the desk says what is carried, for the tracks that take it to light up.
  tile.ondragstart({ dataTransfer: transfer });
  assert.deepEqual(ghosts.map(given => given.slice(1)), [[transfer, 'image', 3, { width: 85, height: 48 }]]);
  assert.deepEqual([ghosts[0][0], tile.className, f.root.dataset.carrying], [tile, 'montage-take is-carried', 'image']);
  // Over the first half of the first take: its shadow before it, the two others pushed later; the bobine as it was.
  f.lanes()[0].ondragover(event(100));
  assert.deepEqual(shadows().map(shadow => [shadow.className, shadow.style.left, shadow.style.width, shadow.textContent]), [['bobine-drop', '0%', 'calc(15% - 4px)', 'Prise 3']]);
  assert.deepEqual([lefts(), starts()], [['15%', '40%'], [0, 5]]);
  // In the void after the bobine: there, and nothing pushed; out of the timeline, gone, everything in its place.
  f.lanes()[0].ondragover(event(1500));
  assert.deepEqual([shadows().map(shadow => shadow.style.left), lefts()], [['75%'], ['0%', '25%']]);
  f.lanes()[0].ondragleave({ relatedTarget: null });
  assert.deepEqual([shadows().length, lefts()], [0, ['0%', '25%']]);
  // Dropped where it was shown: laid there, its shadow gone.
  f.lanes()[0].ondragover(event(100));
  f.lanes()[0].ondrop(event(100));
  assert.deepEqual([f.names(), starts(), shadows().length], [['Prise 3', 'Prise 1', 'Prise 2'], [0, 3, 8], 0]);
  tile.ondragend();
  assert.deepEqual([tile.className, f.root.dataset.carrying], ['montage-take', undefined]);
  // A sound over a track of sounds: a strip there; the takes do not move.
  const sound = f.get('montage-take')[3];
  sound.ondragstart({ dataTransfer: transfer });
  assert.deepEqual([ghosts.at(-1).slice(2), f.root.dataset.carrying], [['audio', 4, { width: 106, height: 29 }], 'sound']);
  f.lanes()[1].ondragover(event(200));
  assert.deepEqual([shadows().map(shadow => [shadow.className, shadow.style.left]), lefts()], [[['bobine-drop is-sound', '10%']], ['0%', '15%', '40%']]);
  sound.ondragend();
  assert.equal(shadows().length, 0);
});

test('the clip after the one shown is loaded beforehand in a second player: no black between two takes (0.6.169)', async () => {
  // (« Entre 2 prises il y a un petit temps mort dans lequel c'est noir. » Two clips of 5 and 3 s.)
  const f = await setup({ width: 2000 }).open();
  for (const at of [0, 1]) f.get('montage-take')[at].ondblclick();
  const [frame] = f.get('montage-frame'),
    players = frame.children.filter(child => child.tagName === 'VIDEO');
  assert.equal(players.length, 2);
  const [first, second] = players;
  // The first shows take 1; the second holds take 2 already, at its start, hidden, silent, paused.
  assert.deepEqual([first.src, first.hidden, second.src, second.hidden, second.muted, second.paused, second.currentTime, second.preload], ['/media/1', false, '/media/2', true, true, true, 0, 'auto']);
  let given = 0,
    held = second.src;
  Object.defineProperty(second, 'src', { get: () => held, set: next => (given++, (held = next)) });
  f.get('montage-play')[0].onclick();
  await f.later({ ms: 4000 });
  assert.deepEqual([first.paused, first.hidden, second.hidden], [false, false, true]);
  // Past the cut: the second is shown as it was loaded, its address not given again; the first waits, hidden.
  await f.later({ ms: 1500 });
  assert.deepEqual([f.said('montage-caption'), given, second.hidden, second.paused, second.muted, second.currentTime], [['Prise 2'], 0, false, false, false, 0.5]);
  assert.deepEqual([first.hidden, first.paused], [true, true]);
});

test('read with the images of the screen when the page has them: the head moves at each one, a pause lets go of the next (0.6.169)', async () => {
  let made = 0;
  const frames = new Map(),
    f = await setup({ width: 2000, win: { requestAnimationFrame: work => (frames.set(++made, work), made), cancelAnimationFrame: at => frames.delete(at) } }).open(),
    run = () => {
      const now = [...frames.values()];
      frames.clear();
      for (const work of now) work();
    };
  f.get('montage-take')[0].ondblclick();
  f.get('montage-play')[0].onclick();
  assert.equal(frames.size, 1);
  await f.later({ ms: 1000 });
  run();
  assert.deepEqual([f.ui.state().head, f.said('montage-clock'), frames.size], [1, ['01.00'], 1]);
  f.get('montage-play')[0].onclick();
  assert.deepEqual([f.ui.state().playing, frames.size], [false, 0]);
});

test('a take being made shows the Flux of the Studio in the preview, from its start photo, with its end photo (0.6.169)', async () => {
  // (« Quand une scène est en cours de création, on n'a pas l'animation du Studio […] Ça serait bien de
  // l'avoir en plus de l'image de fin en bas à droite si y'en a une. ») What it draws is take-flux.mjs's.
  const pictures = [],
    asked = [];
  let answer = null;
  class Picture {
    constructor() {
      pictures.push(this);
    }
  }
  shown.documentElement = { dataset: {} };
  const f = await setup({
    extra: photos(),
    canvas: true,
    win: { performance: { now: () => 0 }, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout: () => 1, clearTimeout() {}, Image: Picture },
    create: (wanted, hooks) => {
      asked.push(hooks);
      return new Promise(resolve => (answer = resolve));
    },
  }).open();
  lay(f);
  f.write(0, 'Il lève les yeux.');
  f.goMain().onclick();
  await settle();
  const [frame] = f.get('montage-frame');
  // From its start photo, once it is there.
  assert.deepEqual([pictures.map(picture => picture.src), frame.className], [['/media/3'], 'montage-frame']);
  Object.assign(pictures[0], { naturalWidth: 1344, naturalHeight: 768 }).onload();
  const [end] = find(frame, 'montage-frame-end');
  assert.deepEqual([frame.className, find(frame, 'take-flux').length, end.hidden, f.said('montage-caption')], ['montage-frame has-flux', 1, false, ['En cours']]);
  // Then from what the engine shows of it.
  asked[0].onProgress('Étape 3 sur 8', 0.4, '/preview/a.jpg');
  assert.deepEqual(pictures.map(picture => picture.src), ['/media/3', '/preview/a.jpg']);
  // Made: the Flux is gone with it.
  f.runs.push(made(50, 121));
  answer(f.runs.at(-1));
  await settle();
  await settle();
  assert.deepEqual([frame.className, find(frame, 'take-flux').length, find(f.get('montage-frame')[0], 'take-flux').length], ['montage-frame', 0, 0]);
  // Without a start photo, the colours of the photo it arrives on until the engine shows something, not grey.
  const g = await setup({
    extra: photos(),
    canvas: true,
    win: { performance: { now: () => 0 }, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout: () => 1, clearTimeout() {}, Image: Picture },
    create: () => new Promise(() => {}),
  }).open();
  g.lanes()[0].onclick({ clientX: 250, target: g.lanes()[0] });
  g.get('montage-take')[5].ondragstart({ dataTransfer: { setData() {} } });
  g.photos().ondrop(event(500));
  assert.deepEqual(g.ui.state().montage.plans.map(plan => [plan.at, plan.to, Object.keys(plan.photos ?? {})]), [[0, 5, ['end']]]);
  g.write(0, 'Il arrive au ponton.');
  g.goMain().onclick();
  await settle();
  assert.equal(pictures.at(-1).src, '/thumb/6');
  delete shown.documentElement;
});

test('the text of a take to create in the preview: cut, the end of its last line fades out (0.6.169)', async () => {
  // (His photo 2 of 21/11: cut at three lines, it ended on « j... » and showed half of a fourth.)
  const f = await setup({ extra: photos() }).open();
  lay(f);
  // (The first take without its end photo: its text has the whole width of the frame.)
  laid(f)[0].onclick();
  f.button('Retirer l’image de fin').onclick();
  const [frame] = f.get('montage-frame'),
    [words] = find(frame, 'montage-frame-words'),
    [text] = find(words, 'montage-frame-text'),
    // (Ten seconds on 1000 pixels: the first take from 0 to 5, the second from 5 to 7.)
    look = x => {
      f.press(f.get('montage-ruler')[0], x);
      f.pointer.up();
    };
  // Three lines of 21 px shown; a long text takes three of them on the whole width, five beside an end photo.
  Object.defineProperty(text, 'clientHeight', { value: 63 });
  Object.defineProperty(text, 'scrollHeight', { get: () => (text.textContent.length < 40 ? 42 : frame.dataset.end === 'true' ? 105 : 63) });
  f.write(0, 'From a low position behind a fractured basalt slab, an old fisherman crosses the wet planks.');
  f.write(1, 'Ease the camera sideways just enough to reveal the boat drifting from the pier, the mist lifting.');
  look(100);
  assert.deepEqual([words.hidden, text.textContent.slice(0, 6), frame.dataset.end, words.dataset.more], [false, 'From a', 'false', 'false']);
  // Beside its end photo, it goes on: it says so (moodix.css fades its end), measured once that place is kept.
  look(600);
  assert.deepEqual([text.textContent.slice(0, 6), frame.dataset.end, words.dataset.more], ['Ease t', 'true', 'true']);
  // Shorter, measured again: it does not.
  f.write(1, 'Il lève les yeux.');
  look(600);
  assert.deepEqual([text.textContent, words.dataset.more], ['Il lève les yeux.', 'false']);
});

test('the styles of his returns of 21/11: the row under the preview as high as what it holds, the Flux under the words, a take carried (0.6.169)', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = (await readFile(new URL('../public/moodix.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const rule = selector => {
    const at = css.lastIndexOf(selector + ' {');
    assert.notEqual(at, -1, selector);
    return css.slice(at, css.indexOf('}', at));
  };
  // (Measured at 1440 × 900: at 24 px, the field of Moodix AI went 16 px under the block of the preview.)
  assert.match(rule('#bobine-view .montage-transport'), /height: 40px;/);
  assert.match(rule('#bobine-view .montage-frame > .take-flux'), /z-index: 1;/);
  assert.match(rule('#bobine-view .montage-frame > :is(.montage-caption, .montage-frame-words, .montage-frame-end)'), /z-index: 2;/);
  assert.match(rule('#bobine-view .montage-frame.has-flux > :is(img, video)'), /visibility: hidden;/);
  assert.match(rule("#bobine-view .montage-frame-words[data-more='true'] > .montage-frame-text"), /\bmask-image: linear-gradient\(#000, #000\), linear-gradient\(to left, transparent, #000 96px\);/);
  // (Its own rule, not the one of the motion reduced that names it too.)
  assert.match(css, /\n\.bobine-drop \{\n  position: absolute;[^}]*pointer-events: none;/);
  assert.match(rule('#bobine-view .montage-take.is-carried > :is(img, video)'), /opacity: 0.35;/);
  // (The bar of the take chosen stayed at its place while the takes slid, and took the drop for itself.)
  assert.match(rule('.bobine-desk[data-carrying] :is(.montage-pop, .bobine-edge-hint)'), /opacity: 0;\n  pointer-events: none;/);
});

test('the takes a change moves slide from where they were to their place; a take that comes appears softly (0.6.169)', async () => {
  // (« Globalement essaie d'améliorer la fluidité, l'impression de “c'est fluide et ça colle tout seul”. »)
  // The page here has no layout: a take is where its left says, on a lane of 1000 pixels.
  const played = [],
    { getBoundingClientRect } = Fake.prototype;
  Fake.prototype.animate = function (frames, options) {
    played.push([String(this.className), frames, options.duration]);
  };
  Fake.prototype.getBoundingClientRect = function () {
    const at = /^([\d.]+)%$/.exec(String(this.style.left ?? ''));
    return { left: at ? (Number(at[1]) * WIDTH) / 100 : 0, width: WIDTH };
  };
  try {
    const f = await setup().open();
    for (const at of [0, 1]) f.get('montage-take')[at].ondblclick();
    // (The second, laid after the first: it came, softly.)
    assert.deepEqual(played.at(-1), ['montage-piece', [{ opacity: 0, transform: 'scale(0.97)' }, { opacity: 1, transform: 'none' }], 180]);
    played.length = 0;
    // The first taken away: the second slides from five seconds (250 pixels, twenty seconds shown) to the start.
    f.plans()[0].onkeydown({ key: 'Delete' });
    assert.deepEqual([f.plans().map(piece => piece.style.left), played], [['0%'], [['montage-piece', [{ transform: 'translateX(250px)' }, { transform: 'none' }], 180]]]);
  } finally {
    delete Fake.prototype.animate;
    Fake.prototype.getBoundingClientRect = getBoundingClientRect;
  }
});

test('a take dragged: a slide going on goes on when the timeline is drawn again, nothing is drawn again for nothing, the take in the hand follows it however fast (0.6.173)', async () => {
  // (« Maintenant la timeline a un bug, ça zozote. Ça saute quand on drag des prises. » Measured in the
  // page: the timeline was drawn again at each move of the pointer, and each slide began again with it;
  // the takes waited where they were as long as the hand moved, then jumped once it stopped.)
  const played = [],
    { getBoundingClientRect } = Fake.prototype;
  Fake.prototype.animate = function (frames, options) {
    const motion = { currentTime: 0 };
    played.push([this.dataset.id, frames[0].transform, options.duration, motion]);
    return motion;
  };
  Fake.prototype.getBoundingClientRect = function () {
    const at = /^([\d.]+)%$/.exec(String(this.style.left ?? ''));
    return { left: at ? (Number(at[1]) * WIDTH) / 100 : 0, width: WIDTH };
  };
  // Each slide played since the last look: [where it leaves from, the time it has reached already].
  const slides = () => Object.fromEntries(played.splice(0).map(([id, from, , motion]) => [id, [from, motion.currentTime]]));
  try {
    const f = await setup().open();
    for (const at of [0, 1]) f.get('montage-take')[at].ondblclick();
    const [first, second] = f.plans().map(piece => piece.dataset.id);
    played.length = 0;
    // The first (5 s: 250 pixels, twenty seconds shown) pulled to the right over the second (3 s).
    f.press(f.plans()[0], 100);
    // Its start before the middle of the second, come back to the start: it stays before it. (Chosen: drawn again.)
    f.pointer.move(150);
    assert.deepEqual([f.plans().map(piece => piece.style.left), slides()], [['0%', pc(5, 20)], {}]);
    // Past that middle: it jumps after the second, further than the hand went; the second slides to the start.
    f.pointer.move(180);
    assert.deepEqual(f.plans().map(piece => [piece.dataset.id, piece.style.left]), [
      [second, '0%'],
      [first, pc(3, 20)],
    ]);
    assert.deepEqual(slides(), { [first]: ['translateX(-150px)', 0], [second]: ['translateX(250px)', 0] });
    // The hand goes on, the bobine stays as it is: nothing is drawn again, the slides go on by themselves.
    const drawn = f.plans();
    f.tick(60);
    f.pointer.move(183);
    assert.deepEqual([f.plans().map((piece, at) => piece === drawn[at]), slides(), f.saves().length], [[true, true], {}, 0]);
    // Beyond the second, in the void: it follows the hand, so the timeline is drawn again. Both slides go
    // on from where they left, at the time they have reached; the one of the take in the hand ends where
    // the hand has taken it.
    f.pointer.move(260);
    assert.deepEqual(f.plans().map(piece => piece.style.left), ['0%', pc(3.2, 20)]);
    assert.deepEqual(slides(), { [first]: ['translateX(-150px)', 60], [second]: ['translateX(250px)', 60] });
    // The slides over: the take follows the hand, however fast it goes (80 pixels at once), without sliding.
    f.tick(200);
    f.pointer.move(340);
    assert.deepEqual([f.plans().map(piece => piece.style.left), slides()], [['0%', pc(4.8, 20)], {}]);
    // Back over the second in one move, further than the hand went: a jump again, from where it is.
    f.pointer.move(150);
    assert.deepEqual(slides(), { [first]: ['translateX(240px)', 0], [second]: ['translateX(-250px)', 0] });
    f.pointer.up();
  } finally {
    delete Fake.prototype.animate;
    Fake.prototype.getBoundingClientRect = getBoundingClientRect;
  }
});

test('while the bobine cannot change, a take carried over it shows nowhere to go, nothing pushed (0.6.170)', async () => {
  // (Found in the review of 0.6.169: shown and pushed all the same, then refused, the takes stayed pushed.)
  const f = await setup({ create: () => new Promise(() => {}) }).open();
  for (const at of [0, 1]) f.get('montage-take')[at].ondblclick();
  f.lanes()[0].onclick({ clientX: 900, target: f.lanes()[0] });
  f.write(0, 'Il regarde la mer.');
  const lefts = () => f.plans().map(piece => piece.style.left),
    still = lefts(),
    tile = f.get('montage-take')[2];
  // Shown where it would go, the takes after it pushed; then a creation begins before it is dropped.
  tile.ondragstart({ dataTransfer: { setData() {} } });
  f.lanes()[0].ondragover(event(100));
  assert.equal(f.get('bobine-drop').length, 1);
  assert.notDeepEqual(lefts(), still);
  f.goMain().onclick();
  await settle();
  // (Drawn again for the creation: what was shown is gone with it.)
  assert.deepEqual([f.get('bobine-drop').length, lefts()], [0, still]);
  // Carried again meanwhile: nothing shown, nothing pushed; dropped, refused, said.
  f.lanes()[0].ondragover(event(100));
  assert.deepEqual([f.get('bobine-drop').length, lefts()], [0, still]);
  f.lanes()[0].ondrop(event(100));
  assert.deepEqual([f.plans().length, lefts(), f.notices.at(-1)], [3, still, 'Des prises sont en cours de création : attendez la fin, ou arrêtez.']);
  tile.ondragend();
});

test('in a hole of the bobine, the clip after it is loaded beforehand too (0.6.170)', async () => {
  // (A from 0 to 5, a hole, then B from 8, C and D after it: the hole is black, not the time B loads.)
  const f = await setup({ extra: [made(7, 48), made(8, 48)] }).open();
  f.get('montage-take')[0].ondblclick();
  f.get('montage-take')[1].ondragstart({ dataTransfer: { setData() {} } });
  f.lanes()[0].ondrop(event(800));
  for (const at of [4, 5]) f.get('montage-take')[at].ondblclick();
  assert.deepEqual(f.ui.state().montage.plans.map(plan => plan.at), [0, 8, 11, 13]);
  const whole = 800 / parseFloat(f.plans()[1].style.left),
    [frame] = f.get('montage-frame'),
    players = frame.children.filter(child => child.tagName === 'VIDEO'),
    look = seconds => {
      f.press(f.get('montage-ruler')[0], (seconds / whole) * 1000);
      f.pointer.up();
    },
    held = () => players.map(player => [player.src, player.hidden]).sort();
  // On D, then on C: the two players hold C and D, neither B.
  look(14);
  look(12);
  assert.deepEqual(held(), [['/media/7', false], ['/media/8', true]]);
  // In the hole before B: B waits in the player not shown, at its start.
  look(6);
  assert.deepEqual([frame.dataset.hole, held()], ['true', [['/media/2', true], ['/media/7', true]]]);
  assert.equal(players.find(player => player.src === '/media/2').currentTime, 0);
});

// ------------------------------------------------------------------ one creation at a time, said (0.6.175)
// (0.6.181) A bobine kept with one take to create, and a take made for it: its record says its place (the
// bobine, the take to create, from which second it is shown), and when it was made (after the bobine was
// last kept, unless said).
const KEPT_AT = '2026-11-20T03:00:00.000Z',
  MADE_AT = '2026-11-20T03:05:00.000Z';
const waiting = () => ({
  schemaVersion: 1, id: id(700), name: 'Le phare', format: '16:9', width: 1344, height: 768, fps: 24, sounds: [],
  plans: [{ id: id(701), at: 0, kind: 'video', todo: { prompt: 'Il lève les yeux.' }, from: 0, to: 5, frame: 'fit', volume: 1 }],
  createdAt: KEPT_AT,
  updatedAt: KEPT_AT,
});
const madeFor = (n, { bobine = id(700), plan = id(701), from = 0, at = MADE_AT } = {}) =>
  take(n, 'video', { parameters: { frames: 121, fps: 24 }, createdAt: at, bobine: { id: bobine, plan, from } });

test('a take made for a take to create while no page was there is laid at its place when its bobine opens (0.6.181)', async () => {
  // (Audit of 21/11, A5. The page reloaded or closed while a take of the Bobine is made: the server ends
  // it, but the page that would have laid it is gone. The take stayed « à créer », its take in « Prises ».)
  const f = await setup({ stored: [waiting()], extra: [madeFor(50)] }).open();
  // Laid as the page that asked would have: the take made, as long as it is, nothing left to create; kept.
  assert.deepEqual([f.names(), f.lengths(), f.lines()], [['Prise 50'], ['05.04 s'], []]);
  assert.deepEqual(f.ui.state().montage.plans[0], { id: id(701), at: 0, kind: 'video', from: 0, to: 5.042, frame: 'fit', volume: 1, source: { conversationId: C, runId: id(50), output: 0 } });
  await settle();
  assert.deepEqual(f.saves().map(save => save.body.montage.plans[0].source?.runId), [id(50)]);
  // One step of « Annuler »: to create again. And it stays so, the takes read again or the page shown again.
  f.ui.undo();
  f.ui.refreshed();
  f.ui.leave();
  f.root = f.ui.desk();
  await f.later();
  assert.deepEqual([f.names(), f.ui.state().montage.plans[0].todo?.prompt, f.lines().length], [[''], 'Il lève les yeux.', 1]);
  // A suite holds the video it goes on from: shown from where its record says.
  const suite = await setup({ stored: [waiting()], extra: [madeFor(50, { from: 2 })] }).open();
  assert.deepEqual([suite.ui.state().montage.plans[0].from, suite.ui.state().montage.plans[0].to, suite.lengths()], [2, 5.042, ['03.04 s']]);
});

test('only what is its own, and still wanted: a take made before the bobine was last kept, for another bobine, for a take no longer to create stays in « Prises » (0.6.181)', async () => {
  const before = madeFor(50, { at: '2026-11-20T02:59:00.000Z' }),
    elsewhere = madeFor(51, { bobine: id(799) }),
    gone = madeFor(52, { plan: id(702) });
  // (Before the bobine was last kept: the page was there and laid it, and the user put the take back to
  // create since — « Annuler », kept. Laid again at each opening, it could never be undone.)
  const f = await setup({ stored: [waiting()], extra: [before, elsewhere, gone] }).open();
  await f.later();
  assert.deepEqual([f.names(), f.lines().length, f.saves().length, f.ui.state().past], [[''], 1, 0, 0]);
  for (const n of [50, 51, 52]) assert.ok(f.said('montage-take-number').includes('Prise ' + n));
});

test('its take found being made after a reload says « En cours » on its take and in its line, then is laid at its place (0.6.181)', async () => {
  // (The Studio follows the work again, take-recovery.mjs, and says which take of which bobine it is for.)
  let going = null;
  const f = await setup({ stored: [waiting()], followed: () => going }).open();
  const line = () => f.get('bobine-line')[0],
    bar = () => find(f.root, 'montage-piece-bar-done').map(done => done.style.width),
    shown = () => [f.plans()[0].className, f.names(), f.lines()[0][1], line().dataset.state, bar()],
    REST = ['montage-piece is-todo', [''], '', '', []];
  assert.deepEqual(shown(), REST);
  going = { id: id(700), plan: id(701), fraction: 0.4 };
  f.ui.busyChanged();
  assert.deepEqual(shown(), ['montage-piece is-todo is-making', ['En cours · 40 %'], 'En cours · 40 %', 'making', ['40%']]);
  // As it goes on its words follow it, nothing drawn again: a text being typed keeps its field.
  const [piece] = f.plans(),
    row = line();
  going = { ...going, fraction: 0.6 };
  f.ui.busyChanged();
  assert.deepEqual([f.plans()[0] === piece, line() === row, ...shown().slice(1)], [true, true, ['En cours · 60 %'], 'En cours · 60 %', 'making', ['60%']]);
  // A work for another bobine, for a take that is not here, or over without a take: as it was.
  for (const other of [{ id: id(799), plan: id(701), fraction: 0.6 }, { id: id(700), plan: id(702), fraction: 0.6 }, null]) {
    going = other;
    f.ui.busyChanged();
    assert.deepEqual(shown(), REST);
    going = { id: id(700), plan: id(701), fraction: null };
    f.ui.busyChanged();
    assert.deepEqual(shown().slice(1, 4), [['En cours'], 'En cours', 'making']);
  }
  // Made: the Studio reads the takes of the project again, and the take is laid where it was asked. Kept.
  going = null;
  f.runs.push(madeFor(50));
  f.ui.refreshed();
  await settle();
  assert.deepEqual([f.names(), f.lines(), f.saves().at(-1).body.montage.plans[0].source.runId, f.ui.state().past], [['Prise 50'], [], id(50), 1]);
});

test('the take being made says the step the engine is at and how long it has been, in amber when it lacks video memory (0.6.182)', async () => {
  // (Audit of 21/11, B1. The Studio says « Étape 3 sur 8 · 1 min 12 s » under « Générer », the card of the
  // Chat turns amber when the engine tries again for lack of video memory; the Bobine said « En cours · 40 % ».)
  const { f, asked, answers } = await series();
  // (Above the button, not in the line of the take: at 1280 × 720 the end of a line is under the fade of the list.)
  const step = () => f.get('bobine-stage').map(line => [line.textContent, line.hidden, line.dataset.warned]),
    // (What is drawn just before the row of the button.)
    before = () => {
      const all = under(f.root);
      return all[all.indexOf(f.get('bobine-foot')[0]) - 1].className;
    };
  // Nothing is being made: nothing said.
  assert.deepEqual(step(), [['', true, 'false']]);
  f.goMain().onclick();
  await settle();
  // From its first instant, just above the row of the button.
  assert.deepEqual([step(), before()], [[['Préparation…', false, 'false']], 'bobine-stage']);
  // The step and the count of the Studio, as it says them; a step said without a time keeps the last one.
  const [row] = f.get('bobine-stage');
  asked[0].hooks.onProgress('Étape 3 sur 8', 0.4, null, '1 min 12 s');
  assert.deepEqual(step(), [['Étape 3 sur 8 · 1 min 12 s', false, 'false']]);
  asked[0].hooks.onProgress('Étape 4 sur 8', 0.5);
  assert.deepEqual(step(), [['Étape 4 sur 8 · 1 min 12 s', false, 'false']]);
  // The second goes by, the step unchanged; nothing is drawn again under the hands.
  asked[0].hooks.onProgress('', 0.5, null, '1 min 13 s');
  assert.deepEqual([step(), f.get('bobine-stage')[0] === row], [[['Étape 4 sur 8 · 1 min 13 s', false, 'false']], true]);
  // The engine lacks video memory and tries again, more slowly: its words, in amber; back to ink after.
  asked[0].hooks.onProgress('Mémoire vidéo insuffisante : nouvel essai, plus lent…', 0.5, null, '1 min 20 s');
  assert.deepEqual(step(), [['Mémoire vidéo insuffisante : nouvel essai, plus lent… · 1 min 20 s', false, 'true']]);
  asked[0].hooks.onProgress('Étape 5 sur 8', 0.6, null, '2 min 04 s');
  assert.deepEqual(step(), [['Étape 5 sur 8 · 2 min 04 s', false, 'false']]);
  // Made: the next one counts from nothing. The last one made: nothing said any more.
  f.runs.push(made(50, 121));
  answers[0].resolve(f.runs.at(-1));
  await settle();
  await settle();
  assert.deepEqual([step(), f.lines().length], [[['Préparation…', false, 'false']], 1]);
  f.runs.push(made(51, 49));
  answers[1].resolve(f.runs.at(-1));
  await settle();
  await settle();
  assert.deepEqual([step(), f.ui.state().making], [[['', true, 'false']], null]);
  // (What is drawn cannot be read here: the rules that draw it are. Never under 12 px; amber as a reason is.)
  const { readFile } = await import('node:fs/promises');
  const css = (await readFile(new URL('../public/moodix.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const rule = selector => css.slice(css.lastIndexOf(selector + ' {'), css.indexOf('}', css.lastIndexOf(selector + ' {')));
  assert.match(rule('#bobine-view .bobine-create .bobine-stage'), /font: 400 12\.5px\/1\.4 var\(--font-ui\);[\s\S]*color: var\(--muted\);/);
  assert.match(rule("#bobine-view .bobine-create .bobine-stage[data-warned='true']"), /color: var\(--warning\);/);
});

test('a take found being made after a reload says its step and its time too (0.6.182)', async () => {
  let going = { id: id(700), plan: id(701), fraction: 0.4, label: 'Étape 3 sur 8', time: '48 s' };
  const f = await setup({ stored: [waiting()], followed: () => going }).open();
  const step = () => f.get('bobine-stage').map(line => [line.textContent, line.hidden, line.dataset.warned]);
  f.ui.busyChanged();
  assert.deepEqual(step(), [['Étape 3 sur 8 · 48 s', false, 'false']]);
  going = { ...going, label: 'Mémoire vidéo insuffisante : nouvel essai, plus lent…', time: '52 s' };
  f.ui.busyChanged();
  assert.deepEqual(step(), [['Mémoire vidéo insuffisante : nouvel essai, plus lent… · 52 s', false, 'true']]);
  going = null;
  f.ui.busyChanged();
  assert.deepEqual(step(), [['', true, 'false']]);
});

test('a part laid by the page that asked for it is never laid again on what is left of its take (0.6.181)', async () => {
  // (What is left of a take made in parts keeps its id: the record of its first part names it too. In
  // pause after that part, nothing being made, the takes of the project are read again.)
  const answers = [],
    asked = [];
  const f = await setup({
    extra: [made(7, 120)],
    modelFor: () => 'ltx-25',
    longestFor: verb => ({ create_video: 10.04, extend_video: 9.67 })[verb],
    create: wanted => (asked.push(structuredClone(wanted)), new Promise(resolve => answers.push({ resolve }))),
  }).open();
  f.get('montage-take')[4].ondblclick();
  f.press(find(f.root, 'montage-grip')[1], 500);
  f.pointer.move(1600);
  f.pointer.up();
  f.write(0, 'Il marche vers la mer.');
  f.goMain().onclick();
  await settle();
  f.button('Mettre en pause après cette prise').onclick();
  f.runs.push({ ...made(60, 252, { continuation: { overlapFrames: 9, sourceFrames: 120, newFrames: 132 } }), createdAt: MADE_AT, bobine: asked[0].place });
  answers[0].resolve(f.runs.at(-1));
  await settle();
  await settle();
  const laid = () => f.ui.state().montage.plans.map(plan => [plan.at, plan.from, plan.to, Boolean(plan.todo)]);
  assert.deepEqual([f.ui.state().filling.stage, f.ui.state().making, laid()], ['paused', null, [[0, 0, 5, false], [5, 5, 10.5, false], [10.5, 0, 5.5, true]]]);
  f.ui.refreshed();
  assert.deepEqual(laid(), [[0, 0, 5, false], [5, 5, 10.5, false], [10.5, 0, 5.5, true]]);
});

test('a take made for it while another page was shown is laid when the Bobine is shown again (0.6.181)', async () => {
  const f = await setup({ stored: [waiting()] }).open();
  f.ui.leave();
  f.runs.push(madeFor(50));
  f.root = f.ui.desk();
  await settle();
  assert.deepEqual([f.names(), f.lines(), f.saves().at(-1).body.montage.plans[0].source.runId], [['Prise 50'], [], id(50)]);
});

test('a work going on outside the Bobine greys « Créer », the wand, the Éclipse and the request, and says why (0.6.175)', async () => {
  // (Audit of 21/11, A4 and B6. During a creation of the Chat or of the Studio, or while Moodix answered,
  // « Créer » stayed lit: its click was refused there without a word, and the take was noted « Échec · La
  // création n'a pas pu commencer. »; the wand and the Éclipse said « La génération utilise le GPU. »)
  const HELD = 'Génération en cours dans cette conversation : attendez sa fin.';
  let why = '';
  const { f, asked } = await series({
    texts: ['Il lève les yeux.', ''],
    write: () => new Promise(() => {}),
    more: { busyWith: () => why, enrich: () => new Promise(() => {}), arrange: () => new Promise(() => {}) },
  });
  const wand = () => f.get('bobine-go-wand')[0],
    agent = () => f.get('bobine-go-agent')[0],
    send = () => f.get('bobine-ask-send')[0],
    field = () => f.get('bobine-ask-words')[0],
    waits = () => f.get('bobine-waits').map(line => [line.textContent, line.hidden]),
    greyed = () => [f.goMain().disabled, wand().disabled, agent().disabled, send().disabled];
  Object.assign(field(), { value: 'Un film sur la mer' }).oninput();
  assert.deepEqual([greyed(), waits(), field().disabled], [[false, false, false, false], [['', true]], false]);
  // A work begins outside (the Studio says which): everything that would ask the card or Moodix AI waits,
  // and the sentence above « Créer » says why. The words of a request can still be written.
  why = HELD;
  f.ui.busyChanged();
  assert.deepEqual([greyed(), waits(), field().disabled], [[true, true, true, true], [[HELD, false]], false]);
  // Asked all the same (a key, a click sent before the grey): said, and nothing begins.
  const said = f.notices.length;
  f.goMain().onclick();
  agent().onclick();
  wand().onclick();
  field().onkeydown({ key: 'Enter', preventDefault() {} });
  await settle();
  const state = f.ui.state();
  assert.deepEqual([f.notices.slice(said), asked.length, state.writing, state.wand, state.arranging, state.filling], [[HELD, HELD, HELD, HELD], 0, null, false, null, null]);
  // The work over: lit again, nothing said.
  why = '';
  f.ui.busyChanged();
  assert.deepEqual([greyed(), waits()], [[false, false, false, false], [['', true]]]);
  // At a work of its own the Bobine says it itself, whatever goes on outside (the Studio never names
  // the take the Bobine is making; if it did, nothing of it is shown here).
  f.goMain().onclick();
  await settle();
  why = HELD;
  f.ui.busyChanged();
  assert.deepEqual([asked.length, f.ui.state().filling.stage, waits()], [1, 'running', [['', true]]]);
});

test('a take the Studio refuses to begin is no failure: its reason is said, the series ends, the take is still to create (0.6.175)', async () => {
  // (A work begun outside between two takes of a series, or between the click and the request.)
  const { f, asked, answers } = await series();
  f.goMain().onclick();
  await settle();
  const said = f.notices.length;
  answers[0].reject(Object.assign(new Error('Attendez la fin de la réponse en cours.'), { refused: true }));
  await settle();
  await settle();
  let state = f.ui.state();
  assert.deepEqual([asked.length, state.filling, state.failed.size, f.notices.slice(said)], [1, null, 0, ['Attendez la fin de la réponse en cours.']]);
  assert.deepEqual([f.lines().some(line => line[1] === 'Échec' || line[3]), f.get('bobine-line').length, f.go(), f.goMain().disabled], [false, 2, 'Créer 2 prises', false]);
  // The user said no himself (what the creation would cost him): nothing to say again.
  f.goMain().onclick();
  await settle();
  answers[1].reject(Object.assign(new Error(''), { refused: true }));
  await settle();
  await settle();
  state = f.ui.state();
  assert.deepEqual([asked.length, state.filling, state.failed.size, f.notices.length, f.go()], [2, null, 0, said + 1, 'Créer 2 prises']);
});

test('a take stopped from outside the Bobine is a stop, not a failure: nothing is noted, the series ends (0.6.176)', async () => {
  // (Audit of 21/11, A5. « Arrêter » of the Studio or « Interrompre la réponse » of the Chat during a take of
  // the Bobine: it was noted « Échec · Génération arrêtée. » or « Génération annulée. »; only its own
  // « Arrêter » counted as a stop.)
  const { f, asked, answers } = await series();
  f.goMain().onclick();
  await settle();
  const said = f.notices.length;
  answers[0].reject(Object.assign(new Error('Génération arrêtée.'), { stopped: true }));
  await settle();
  await settle();
  const state = f.ui.state();
  assert.deepEqual([asked.length, state.filling, state.making, state.failed.size, f.notices.length], [1, null, null, 0, said]);
  assert.deepEqual([f.lines().some(line => line[1] === 'Échec' || line[3]), f.get('bobine-line').length, f.go(), f.goMain().disabled], [false, 2, 'Créer 2 prises', false]);
  // (A fault of the engine is still one.)
  f.goMain().onclick();
  await settle();
  answers[1].reject(new Error('Mémoire vidéo insuffisante.'));
  await settle();
  await settle();
  assert.deepEqual([f.ui.state().failed.size, f.lines()[0].slice(1, 2), f.lines()[0][3]], [1, ['Échec'], 'Mémoire vidéo insuffisante.']);
});

test('a creation in pause is not taken up again while a work goes on outside the Bobine (0.6.175)', async () => {
  let why = '';
  const { f, asked, answers } = await series({ more: { busyWith: () => why } });
  f.goMain().onclick();
  await settle();
  f.button('Mettre en pause après cette prise').onclick();
  f.runs.push(made(50, 121));
  answers[0].resolve(f.runs.at(-1));
  await settle();
  await settle();
  assert.deepEqual([f.go(), f.goMain().disabled, f.get('bobine-waits')[0].hidden], ['Reprendre · 1 sur 2', false, true]);
  // A creation begins in the Chat meanwhile: « Reprendre » waits for it, and says so.
  why = 'Génération en cours dans cette conversation : attendez sa fin.';
  f.ui.busyChanged();
  assert.deepEqual([f.go(), f.goMain().disabled, f.get('bobine-waits')[0].textContent], ['Reprendre · 1 sur 2', true, why]);
  // (Its click sent all the same: said, the second take is not asked.)
  f.goMain().onclick();
  await settle();
  assert.deepEqual([asked.length, f.ui.state().filling.stage, f.notices.at(-1)], [1, 'paused', why]);
  why = '';
  f.ui.busyChanged();
  f.goMain().onclick();
  await settle();
  assert.deepEqual([asked.length, f.ui.state().filling.stage, f.goMain().disabled], [2, 'running', true]);
});
