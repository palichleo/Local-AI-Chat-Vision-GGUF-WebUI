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
    for (const item of items) if (item) this.children.push(item);
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
  pause() {
    this.paused = true;
  }
  play() {
    this.paused = false;
    return Promise.resolve();
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

function setup({ stored = [], fail = {}, extra = [], create = null, estimate = null, write = null, thumbnail = () => {}, width = 1000, modelFor = null } = {}) {
  WIDTH = width;
  const calls = [],
    queue = [],
    kept = new Map(stored.map(montage => [montage.id, montage])),
    project = 'inbox',
    runs = [
      take(1, 'video', { parameters: { frames: 80, fps: 16 } }),
      take(2, 'video', { parameters: { frames: 48, fps: 16 } }),
      take(3, 'image'),
      take(4, 'audio', { workflowName: 'Musique (ACE-Step 1.5 XL)', parameters: { seconds: 30 } }),
      ...extra,
    ];
  let made = 100,
    clock = 0,
    refreshed = 0,
    halted = 0;
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
    page = { document: shown, addEventListener: (type, listener) => heard.set(type, listener), removeEventListener: type => heard.delete(type) };
  shown.activeElement = null;
  const ui = setupMontage({
    page,
    ...(create ? { create } : {}),
    ...(estimate ? { estimate } : {}),
    ...(write ? { write } : {}),
    ...(modelFor ? { modelFor } : {}),
    halt: () => void halted++,
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
    refreshed: () => refreshed,
    halted: () => halted,
    // The lanes of the takes and of the two audio tracks, in their order; the one of the photos, above them.
    lanes: () => find(f.root, 'montage-lane').filter(lane => !String(lane.className).includes('montage-photos')),
    photos: () => find(f.root, 'montage-photos')[0],
    track: name => find(f.root, 'montage-track').find(track => track.dataset.track === name),
    // The pointer once pressed on the timeline: moved to `clientX`, let go; how many listeners are left.
    pointer: { move: clientX => heard.get('pointermove')?.({ clientX }), up: () => heard.get('pointerup')?.({}), held: () => heard.size },
    press: (target, clientX) => target.onpointerdown({ clientX, button: 0, stopPropagation() {} }),
    // (0.6.149) A press in the void of the takes, beside what they hold.
    pressVoid: clientX => f.lanes()[0].onpointerdown({ clientX, button: 0, target: f.lanes()[0], stopPropagation() {} }),
    focused: () => shown.activeElement,
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
  assert.deepEqual([go.disabled, go.textContent, go.title, go.children[0].className], [true, 'Exporter', 'Posez au moins une prise pour exporter un film', 'icon-download']);
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
  assert.equal(f.pop().style.left, 'clamp(0px, 0%, calc(100% - 240px))');
  assert.equal(f.saves().length, 0, 'not kept at every change');
  await f.later();
  assert.equal(f.saves().length, 1);
  const { project, montage } = f.saves()[0].body;
  assert.deepEqual([project, montage.plans.length, montage.sounds.length, montage.name, montage.width, montage.fps], ['inbox', 2, 1, 'Sans titre', 1344, 24]);
  assert.deepEqual(f.said('montage-status'), ['Enregistré']);
  // Kept: the fil can take it out now, and « Exporter » makes its film.
  assert.deepEqual(f.get('montage-pick')[0].children.map(option => option.textContent), ['Sans titre', '+ Nouvelle bobine', 'Renommer la bobine', 'Supprimer la bobine']);
  assert.deepEqual([f.get('montage-export')[0].disabled, f.get('montage-export')[0].title], [false, 'Un seul fichier : le film dans VIDEO, et une prise du projet']);
  // It follows the bobine at once, the fil not drawn again: no take, no film.
  const fil = f.get('montage-pick')[0];
  for (const piece of f.plans()) piece.onkeydown({ key: 'Delete' });
  assert.deepEqual([f.get('montage-export')[0].disabled, f.get('montage-export')[0].title, f.get('montage-pick')[0]], [true, 'Posez au moins une prise pour exporter un film', fil]);
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
  assert.deepEqual([f.names(), f.ui.state().chosen, f.pop().style.left], [['Prise 2', 'Prise 1', 'Prise 3'], plan(1).id, 'clamp(0px, 15%, calc(100% - 240px))']);
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
  assert.deepEqual([f.ui.state().chosen, f.pop().style.left], [sound().id, 'clamp(0px, 0%, calc(100% - 240px))']);
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
  // A press on a lane beside what it holds puts the head there too, and lets go of what was chosen;
  // the space bar reads the bobine from anywhere, except where a key is typed or a button pressed.
  const [lane] = f.lanes();
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

test('in the void, a ghost of 5 s follows the pointer; a double click lays it, a press pulled draws a take to create (0.6.149)', async () => {
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
  // A double click lays it there: a take to create of five seconds, chosen; its line waits for its text.
  lane.ondblclick({ clientX: 900, target: lane });
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
  // A click alone draws nothing: it moves the head (to the end of the bobine, the most it can go).
  await f.later();
  f.pressVoid(990);
  f.pointer.up();
  f.lanes()[0].onclick({ clientX: 990, target: f.lanes()[0] });
  assert.deepEqual([f.ui.state().montage.plans.length, f.ui.state().head], [4, 19]);
  // A drawn take never goes on from what is before it: a clip of its own, from its text.
  assert.deepEqual(f.lines().map(line => line[2]), ['Nouvelle prise', 'Nouvelle prise', 'Nouvelle prise']);
  await f.later();
  assert.deepEqual(f.saves().at(-1).body.montage.plans.map(plan => [plan.at, plan.todo?.suite ?? null]), [[0, null], [5, null], [6.5, null], [11.5, null]]);
  // Pulled longer than a clip can be, it stops at twenty seconds (longer ones will be cut in parts).
  const g = await setup().open();
  g.pressVoid(0);
  g.pointer.move(3000);
  assert.deepEqual(g.ui.state().drawing, { from: 0, to: 20 });
  g.pointer.up();
  assert.deepEqual(g.ui.state().montage.plans.map(plan => [plan.at, plan.to]), [[0, 20]]);
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
    pins = () => find(f.root, 'montage-photo').map(pin => [pin.className, pin.style.left ?? null, pin.style.right ?? null, pin.attributes['aria-label']]);
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
    ['montage-photo is-start', '0%', null, 'Photo de début, prise de 00.00 à 05.00'],
    ['montage-photo is-end', null, 'calc(75% + 4px)', 'Photo de fin, prise de 00.00 à 05.00'],
    ['montage-photo is-end', null, 'calc(65% + 4px)', 'Photo de fin, prise de 05.00 à 07.00'],
  ]);
  assert.deepEqual(find(f.root, 'montage-photo').map(pin => [pin.style.backgroundImage, pin.textContent]), [['url("/thumb/3")', 'Début'], ['url("/thumb/5")', 'Fin'], ['url("/thumb/6")', 'Fin']]);
  // No film while a take is to create: said on « Exporter ».
  const [go] = f.get('montage-export');
  assert.deepEqual([go.disabled, go.title], [true, '2 prises sont encore à créer']);
  // « À créer »: a line for each, in the order of the bobine. (0.6.149) The second does not go on from
  // the first: a clip of its own, towards its photo.
  assert.deepEqual(f.lines(), [
    ['00.00 → 05.00', '', 'Nouvelle prise · photos de début et de fin', ''],
    ['05.00 → 07.00', '', 'Nouvelle prise · photo de fin', ''],
  ]);
  // The last laid is the one chosen: its line says it, its bar is above it.
  assert.deepEqual([f.get('bobine-line').map(line => line.attributes['aria-pressed']), f.popLabels()], [['false', 'true'], ['Retirer la photo de fin', 'Retirer de la bobine (Suppr)']]);
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
  find(f.root, 'montage-photo')[0].onclick();
  assert.deepEqual([f.ui.state().chosen, f.popLabels()], [f.ui.state().montage.plans[0].id, ['Retirer la photo de début', 'Retirer la photo de fin', 'Retirer de la bobine (Suppr)']]);
  f.button('Retirer la photo de fin').onclick();
  assert.deepEqual(pins().map(pin => pin[3]), ['Photo de début, prise de 00.00 à 05.00', 'Photo de fin, prise de 05.00 à 08.50']);
  // A clip dropped there is no photo: said, nothing changed. All of it is kept, as any change.
  carry(0);
  f.photos().ondrop(event(100));
  assert.equal(f.notices.at(-1), 'Seule une image se pose comme photo de début ou de fin.');
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
  });
  // Being made: said on the take, in its line, in the button that fills, in the preview (what the engine shows, blurred).
  asked[0].hooks.onProgress('Étape 3 sur 8', 0.4, '/preview/a.jpg');
  const [frame] = f.get('montage-frame'),
    [, picture, , caption] = frame.children;
  assert.deepEqual([f.plans()[0].className, f.names()[0], find(f.root, 'montage-piece-bar-done')[0].style.width], ['montage-piece is-todo is-making', 'En cours · 40 %', '40%']);
  assert.deepEqual([f.lines()[0][1], f.get('bobine-line')[0].dataset.state], ['En cours · 40 %', 'making']);
  assert.deepEqual([f.go(), f.goMain().disabled, f.get('bobine-go-fill')[0].style.width], ['1 sur 1 · 40 %', true, '40%']);
  assert.deepEqual([picture.src, picture.hidden, caption.textContent, frame.dataset.busy], ['/preview/a.jpg', false, 'En cours · 40 %', 'true']);
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
  assert.deepEqual(f.ui.state().montage.plans[0], { id: f.ui.state().montage.plans[0].id, at: 0, kind: 'video', from: 0, to: 5.042, frame: 'fit', volume: 1, photos: { start: { conversationId: C, runId: id(3), output: 0 }, end: { conversationId: C, runId: id(5), output: 0 } }, source: { conversationId: C, runId: id(50), output: 0 } });
  assert.deepEqual([f.saves().at(-1).body.montage.plans[0].source.runId, f.ui.state().montage.plans[1].at], [id(50), 5.042]);
  // (0.6.149) The second is a clip of its own, towards its photo: nothing of the first is asked for it.
  assert.deepEqual([f.plans()[1].className, f.names()[1], f.lines()[0][2]], ['montage-piece is-todo', '', 'Nouvelle prise · photo de fin']);
  f.write(0, 'Il regarde la mer.');
  f.goMain().onclick();
  await settle();
  assert.deepEqual(asked[1].wanted.args, { prompt: 'Il regarde la mer.', intention: INTENTION, duration: 2, format: '16:9', end_image: { output: id(6) } });
  // Refused by the engine: said in its line, in amber; the take is still to create and can be tried again.
  answer.reject(new Error('Mémoire vidéo insuffisante.'));
  await settle();
  assert.deepEqual([f.lines(), f.get('bobine-line')[0].dataset.state], [[['05.04 → 07.04', 'Échec', 'Nouvelle prise · photo de fin', 'Mémoire vidéo insuffisante.']], 'failed']);
  assert.deepEqual([f.plans()[1].className, f.names()[1], f.ui.state().making, f.go(), f.goMain().disabled], ['montage-piece is-todo is-failed', 'Échec', null, 'Créer 1 prise', false]);
  // Its suite pulled from the end of the take made (fifty pixels a second: 5,04 s is at 252): the
  // continuation itself, whose file holds the take first; the take after it goes later.
  f.press(find(f.plans()[0], 'montage-grip')[1], 252);
  f.pointer.move(352);
  f.pointer.up();
  assert.deepEqual([f.names(), f.lines().map(line => line.slice(0, 3))], [['Prise 50', '↳ Suite', 'Échec'], [['05.04 → 07.04', '', 'Suite de la prise 50'], ['07.04 → 09.04', 'Échec', 'Nouvelle prise · photo de fin']]]);
  f.write(0, 'Il se retourne.');
  // Both are made, one after the other: the suite first, as the Studio prolongs a clip.
  assert.equal(f.go(), 'Créer 2 prises');
  f.goMain().onclick();
  await settle();
  assert.deepEqual(asked[2].wanted, { verb: 'extend_video', args: { prompt: 'Il se retourne.', intention: INTENTION, duration: 2, source: { output: id(50) } }, size: FILM });
  f.runs.push(made(51, 49, { continuation: { overlapFrames: 9, sourceFrames: 121, newFrames: 40 } }));
  answer.resolve(f.runs.at(-1));
  await settle();
  await settle();
  assert.deepEqual([f.ui.state().montage.plans[1].from, f.ui.state().montage.plans[1].to, f.names()[1], f.lengths()[1], f.ui.state().montage.plans[2].at], [5.042, 6.708, 'Prise 51', '01.67 s', 6.708]);
  // The other could not begin (the Studio busy elsewhere): said in its line.
  assert.deepEqual(asked[3].wanted.args.end_image, { output: id(6) });
  answer.resolve(null);
  await settle();
  assert.deepEqual(f.lines()[0].slice(1), ['Échec', 'Nouvelle prise · photo de fin', 'La création n’a pas pu commencer.']);
  // Taken out, every take is made: the film can be exported.
  f.plans()[2].onkeydown({ key: 'Delete' });
  assert.equal(f.get('montage-export')[0].disabled, false);
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
  assert.deepEqual([f.lengths(), find(f.root, 'montage-photo').map(pin => [pin.className, pin.style.left])], [['03.00 s', '02.00 s'], [['montage-photo is-start', '30%']]]);
  assert.deepEqual(f.lines(), [['03.00 → 05.00', '', 'Nouvelle prise · photo de début', '']]);
  // In the preview, a take to create is the photo it starts on, veiled; without one, the empty frame.
  const [frame] = f.get('montage-frame'),
    [blank, picture, video, caption] = frame.children;
  f.ui.seek(4);
  assert.deepEqual([picture.src, picture.hidden, video.hidden, caption.textContent, frame.dataset.todo], ['/media/3', false, true, 'À créer', 'true']);
  assert.deepEqual(f.popLabels(), ['Retirer la photo de début', 'Retirer, et rendre sa fin à la vidéo']);
  f.button('Retirer la photo de début').onclick();
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
  assert.match(f.notices.at(-1), /^Posez la photo plus tôt/);
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
  // What that does is said where the hand is; the video stays the one in hand.
  assert.deepEqual([f.said('montage-tip'), f.get('montage-tip')[0].style.left], [['+ 04.00 s à créer · ce qui suit se décale'], 'clamp(120px, 45%, calc(100% - 120px))']);
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
  assert.deepEqual([f.plans()[1].className, f.lines()[0][2]], ['montage-piece is-todo is-suite', 'Suite de la prise 1 · photo de fin']);
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
  // (Nothing after the video: nothing is said to move.)
  const alone = await setup().open();
  alone.get('montage-take')[0].ondblclick();
  alone.press(find(alone.root, 'montage-grip')[1], 500);
  alone.pointer.move(900);
  assert.deepEqual(alone.said('montage-tip'), ['+ 04.00 s à créer']);
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
  // after it by a double click (twenty seconds shown now).
  f.press(find(f.root, 'montage-grip')[1], 500);
  f.pointer.move(700);
  f.pointer.up();
  await f.later();
  f.lanes()[0].ondblclick({ clientX: 600, target: f.lanes()[0] });
  f.write(0, 'Il se retourne.');
  f.write(1, 'La brume se lève.');
  await settle();
  // Both asked by its name, the suite and the new take, to know their model as to make them.
  assert.deepEqual(foreseen.map(wanted => [wanted.verb, wanted.args.workflow]), [['extend_video', 'ltx-25'], ['create_video', 'ltx-25']]);
  assert.deepEqual(f.lines().map(line => [line[1], line[2]]), [['LTX 2.5', 'Suite de la prise 1'], ['LTX 2.5', 'Nouvelle prise']]);
  f.goMain().onclick();
  await settle();
  assert.deepEqual(asked[0], { verb: 'extend_video', args: { prompt: 'Il se retourne.', intention: INTENTION, duration: 2, workflow: 'ltx-25', source: { output: id(1) } }, size: FILM });
  // Without it, nothing is named: the server chooses, as for any creation.
  const g = await setup({ create: wanted => (asked.push(structuredClone(wanted)), new Promise(() => {})) }).open();
  g.lanes()[0].ondblclick({ clientX: 300, target: g.lanes()[0] });
  g.write(0, 'La brume se lève.');
  g.goMain().onclick();
  await settle();
  assert.equal('workflow' in asked.at(-1).args, false);
});

// (0.6.144, 0.6.149) « Créer n prises »: his three photos, laid in 0.6.146 and kept without instants: a take
// to create between two photos, then one that goes on from it towards a third. Read again in 0.6.149, it is
// a suite (public/montage-model.mjs `placed`): it still waits for the first, and starts on its last image.
async function series({ times = { workflowName: 'LTX 2.5' }, texts = ['Il lève les yeux.', 'Il regarde la mer.'], estimate = null, write = null } = {}) {
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
    ...(write ? { write } : {}),
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
  assert.deepEqual(asked.map(item => item.wanted), [{ ...foreseen[0], args: { ...foreseen[0].args, prompt: 'Il lève les yeux.' } }]);
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
  assert.deepEqual(asked[1].wanted.args, { prompt: 'Il regarde la mer.', intention: INTENTION, duration: 2, format: '16:9', start_image: { output: id(50), frame: 'last' }, end_image: { output: id(6) } });
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
  // The model of the first is not on this computer: said in its line; the second, which goes on from it,
  // is left aside with it (it would be asked first, and refused).
  ({ f } = await series({ times: { workflowName: 'LTX 2.5', missing: true } }));
  assert.deepEqual(f.lines().map(line => [line[1], line[3]]), [['LTX 2.5', 'LTX 2.5 n’est pas sur cet ordinateur.'], ['', 'Elle continue la prise d’avant, qui ne peut pas être créée.']]);
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
  assert.deepEqual([f.names(), f.plans()[0].className, f.lines()[0][1]], [['Moodix AI écrit', '↳ Suite'], 'montage-piece is-todo is-writing', 'Moodix AI écrit']);
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
  assert.deepEqual([f.said('montage-status'), f.ui.state().montage.plans.map(plan => plan.todo.prompt)], [['Écriture arrêtée · 1 prise écrite'], ['An old fisherman lifts his eyes.', '']]);
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
  f.button('Retirer la photo de début').onclick();
  f.button('Retirer la photo de fin').onclick();
  assert.equal(f.ui.state().montage.plans[0].photos, undefined);
  agent().onclick();
  for (let turn = 0; turn < 4; turn++) await settle();
  assert.deepEqual([pens.length, f.said('montage-status'), f.ui.state().writing], [0, ['Moodix AI n’a rien à regarder : posez une photo de début ou de fin, ou écrivez vous-même.'], null]);
});
