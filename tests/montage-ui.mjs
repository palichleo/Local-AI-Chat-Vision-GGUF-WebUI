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
    return { left: 0, width: 1000 };
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
// The document of the page: what has the keys.
const shown = { activeElement: null };
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

function setup({ stored = [], fail = {}, extra = [], create = null, thumbnail = () => {} } = {}) {
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
    if (route === 'montages/remove') return void kept.delete(body.id) ?? { json: async () => ({ removed: body.id }) };
    const found = kept.get(route.split('/').pop());
    if (found) return { json: async () => found };
    throw new Error('Ce montage n’existe plus.');
  };
  const notices = [],
    heard = new Map(),
    page = { document: shown, addEventListener: (type, listener) => heard.set(type, listener), removeEventListener: type => heard.delete(type) };
  shown.activeElement = null;
  const ui = setupMontage({
    page,
    ...(create ? { create } : {}),
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
    // (0.6.142) The lanes of the plans and of the sounds, in their order; the one of the photos, above them.
    lanes: () => find(f.root, 'montage-lane').filter(lane => !String(lane.className).includes('montage-photos')),
    photos: () => find(f.root, 'montage-photos')[0],
    // The pointer once pressed on the timeline: moved to `clientX`, let go; how many listeners are left.
    pointer: { move: clientX => heard.get('pointermove')?.({ clientX }), up: () => heard.get('pointerup')?.({}), held: () => heard.size },
    press: (target, clientX) => target.onpointerdown({ clientX, button: 0, stopPropagation() {} }),
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
    slider: label => find(f.root, 'montage-range').find(input => input.attributes['aria-label'] === label),
    button: label => find(f.root, 'montage-action').concat(find(f.root, 'montage-step'), find(f.root, 'montage-choice')).find(control => control.textContent === label),
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
  assert.deepEqual(f.said('montage-invite'), ['Une photo posée ici : un plan part d’elle, ou arrive sur elle', 'Les vidéos et les images, dans l’ordre du film', 'Une musique sous tout le film', 'Des sons, où vous les posez']);
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
  f.button('Remplir').onclick();
  assert.deepEqual([f.ui.state().montage.plans[0].frame, f.button('Remplir').attributes['aria-pressed'], f.button('Ajuster').attributes['aria-pressed']], ['fill', 'true', 'false']);
  Object.assign(f.slider('Son du clip'), { value: '40' }).oninput();
  assert.equal(f.ui.state().montage.plans[0].volume, 0.4);
  // First of the film: nothing before it; moved after the next, it stays the one chosen.
  assert.deepEqual([f.button('← Avant').disabled, f.button('Après →').disabled], [true, false]);
  f.button('Après →').onclick();
  assert.deepEqual(f.plans().map(piece => piece.textContent.slice(0, 11)), ['1 · PRISE 2', '2 · PRISE 1', '3 · PRISE 3']);
  assert.deepEqual(f.said('montage-title-name'), ['Plan 2 · Prise 1']);
  f.button('Ouvrir la prise').onclick();
  assert.deepEqual(f.calls.at(-1), { route: 'open', body: id(1) });
  // An image has a length and a frame only.
  f.plans()[2].onclick();
  assert.deepEqual(f.said('montage-row-name'), ['Durée', 'Cadre', 'Place']);
  // Taken out by its button, or by the key on the plan itself: the others close the gap, nothing is chosen.
  f.button('Retirer').onclick();
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
  const lanes = f.lanes(),
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
  f.lanes()[0].ondrop(event(990));
  assert.equal(f.plans().length, 4);
  assert.equal(f.plans()[3].textContent.slice(0, 11), '4 · PRISE 2');
  // A music dropped on its track starts where it is dropped (14 s of film: a tenth of the lane is 1,4 s).
  carry(3);
  f.lanes()[1].ondrop(event(100));
  assert.deepEqual(f.ui.state().montage.sounds.map(sound => [sound.track, sound.at]), [['music', 1.4]]);
  // Nothing carried: a drop of anything else (a file of the computer) changes nothing.
  f.lanes()[0].ondrop(event(10));
  assert.equal(f.plans().length, 4);
});

test('a plan is stretched by its edges and moved by dragging it; a change leaves the screen as it is (0.6.138)', async () => {
  // (His request of 20/11, « studio montage : améliore »: the length was set at the right only, the
  // order by two buttons, and every change drew the screen and the takes again.)
  const f = await setup().open();
  for (const at of [0, 1]) f.get('montage-take')[at].ondblclick();
  const grips = () => find(f.root, 'montage-grip'),
    plan = at => f.ui.state().montage.plans[at],
    places = () => f.plans().map(piece => [piece.style.left, piece.style.width]),
    [screen] = f.get('montage-screen'),
    [takes] = f.get('montage-takes');
  assert.deepEqual(grips().map(grip => grip.className), ['montage-grip is-start', 'montage-grip is-end', 'montage-grip is-start', 'montage-grip is-end']);
  // The end of the first plan (5 s of 10 on a lane of 1000: a second is 100): a pixel is no drag;
  // a hundred to the left take a second off, and the plan after it follows.
  // (The other buttons of the mouse pull nothing.)
  grips()[1].onpointerdown({ clientX: 500, button: 2, stopPropagation() {} });
  assert.equal(f.pointer.held(), 0);
  f.press(grips()[1], 500);
  f.pointer.move(499);
  assert.equal(plan(0).to, 5);
  assert.equal(f.root.dataset.held, undefined);
  f.pointer.move(400);
  assert.deepEqual([plan(0).to, places()], [4, [['0%', 'calc(40% - 4px)'], ['40%', 'calc(30% - 4px)']]]);
  assert.equal(f.root.dataset.held, 'trim', 'said to the desk while it lasts: one cursor everywhere');
  assert.deepEqual(f.said('montage-title-name'), ['Plan 1 · Prise 1']);
  // Never beyond the take itself, whatever the pointer does; let go, nothing listens any more.
  f.pointer.move(900);
  assert.equal(plan(0).to, 5);
  f.pointer.move(380);
  f.pointer.up();
  assert.deepEqual([plan(0).to, f.pointer.held(), f.root.dataset.held], [3.8, 0, undefined]);
  // The start of the second plan: its edge follows the pointer while it is cut, the plan before it
  // stays; let go, the film closes the gap.
  f.press(grips()[2], 380);
  f.pointer.move(480);
  assert.deepEqual([plan(1).from, plan(1).to, places()], [1, 3, [['0%', 'calc(38% - 4px)'], ['48%', 'calc(20% - 4px)']]]);
  f.pointer.up();
  assert.deepEqual(places(), [['0%', 'calc(38% - 4px)'], ['38%', 'calc(20% - 4px)']]);
  // The click the browser sends after a drag chooses nothing: the plan cut is still the one chosen.
  f.plans()[1].onclick();
  assert.equal(f.ui.state().chosen, plan(1).id);
  await f.later();
  assert.equal(f.saves().length, 1, 'kept once, a moment after the last of them');
  // Dragged past the middle of the other, a plan takes its place; a few pixels are a click, not a move.
  const [first, second] = [plan(0).id, plan(1).id];
  f.press(f.plans()[0], 100);
  f.pointer.move(103);
  f.pointer.up();
  assert.deepEqual([plan(0).id, plan(1).id, f.ui.state().chosen], [first, second, second]);
  // Pressed near its end and moved a little, it stays where it is, and is the one chosen: its place
  // is read on the film as it was when it was pressed (3,8 s then 2 s: the middle to pass is at 4,8 s).
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
  f.press(f.plans()[0], 100);
  f.pointer.move(520);
  assert.deepEqual([plan(0).id, plan(1).id, f.ui.state().chosen, f.root.dataset.held], [second, first, first, 'move']);
  f.pointer.move(60);
  assert.deepEqual([plan(0).id, plan(1).id], [first, second]);
  f.pointer.up();
  // Alt and an arrow move it too, from the keyboard.
  f.plans()[0].onkeydown({ key: 'ArrowRight', altKey: true });
  assert.deepEqual([plan(0).id, plan(1).id], [second, first]);
  f.plans()[1].onkeydown({ key: 'ArrowRight', altKey: false });
  assert.deepEqual([plan(0).id, plan(1).id], [second, first]);
  // Through all of it the screen and the grid of the takes are the ones first drawn: the clip on the
  // screen did not start over, the grid did not go back to its top. Another shape of film draws them again.
  assert.equal(f.get('montage-screen')[0], screen);
  assert.equal(f.get('montage-takes')[0], takes);
  f.plans()[1].onclick();
  f.plans()[1].onclick();
  Object.assign(f.get('montage-select')[0], { value: '1:1' }).onchange();
  assert.notEqual(f.get('montage-screen')[0], screen);
  assert.equal(f.get('montage-frame')[0].style.aspectRatio, '1024 / 1024');
});

test('a bar of the settings stays in the hand while it is slid; let go, the block says what was kept (0.6.138)', async () => {
  // (Found on 20/11 while reading 0.6.137 again: the block was drawn again at each step of a bar,
  // and the bar taken out of the hand that was sliding it.)
  const f = await setup().open();
  f.get('montage-take')[0].ondblclick();
  const [block] = f.get('montage-inspector'),
    end = f.slider('Fin gardée'),
    start = f.slider('Début gardé'),
    plan = () => f.ui.state().montage.plans[0];
  Object.assign(end, { value: '2' }).oninput();
  Object.assign(end, { value: '1.5' }).oninput();
  assert.deepEqual([f.get('montage-inspector')[0], f.slider('Fin gardée')], [block, end]);
  // What it says follows, and the timeline with it.
  assert.deepEqual([plan().to, f.said('montage-figures').slice(0, 3)], [1.5, ['00.0 S', '01.5 S', '01.5 S']]);
  assert.deepEqual([f.plans().map(piece => piece.style.width), f.said('montage-piece-length'), f.said('montage-summary')], [['calc(15% - 4px)'], ['1,5 s'], ['1 plan · 1,5 s · 16:9 · 24 i/s']]);
  // The start pushed past the end: a tenth of a second is kept; the bar is where the hand has it
  // until it is let go, then where what was kept is.
  Object.assign(start, { value: '4' }).oninput();
  assert.deepEqual([plan().from, start.value, f.said('montage-figures').slice(0, 3)], [1.4, '4', ['01.4 S', '01.5 S', '00.1 S']]);
  start.focus();
  start.onchange();
  assert.notEqual(f.get('montage-inspector')[0], block);
  assert.deepEqual([f.slider('Début gardé').value, f.focused()], ['1.4', f.slider('Début gardé')]);
  Object.assign(f.slider('Son du clip'), { value: '40' }).oninput();
  assert.deepEqual([plan().volume, f.said('montage-figures').at(-1)], [0.4, '40 %']);
  await f.later();
  assert.equal(f.saves().length, 1);
});

test('the keys stay with the montage: what is drawn again under the focus gets it back (0.6.138)', async () => {
  // (A plan clicked was drawn again and left the page with the focus: the next key went nowhere.)
  const f = await setup().open();
  for (const at of [0, 1, 2]) f.get('montage-take')[at].ondblclick();
  const plan = at => f.ui.state().montage.plans[at],
    first = plan(0).id,
    pressed = f.plans()[0];
  pressed.focus();
  pressed.onclick();
  assert.notEqual(f.plans()[0], pressed);
  assert.equal(f.focused(), f.plans()[0]);
  // Alt and an arrow, twice: the plan goes on with the focus as it moves.
  for (const place of [1, 2]) {
    f.focused().onkeydown({ key: 'ArrowRight', altKey: true });
    assert.deepEqual([plan(place).id, f.focused()], [first, f.plans()[place]]);
  }
  // A button of its settings is drawn again with them: the same button has the focus; one that
  // can no longer be pressed leaves it to the desk, which hears the keys of the montage.
  const earlier = f.button('← Avant');
  earlier.focus();
  earlier.onclick();
  assert.notEqual(f.button('← Avant'), earlier);
  assert.deepEqual([plan(1).id, f.focused()], [first, f.button('← Avant')]);
  f.focused().onclick();
  assert.deepEqual([plan(0).id, f.button('← Avant').disabled, f.focused()], [first, true, f.root]);
  // Taken out with its key, a plan leaves the focus to the desk too.
  f.plans()[0].focus();
  f.plans()[0].onkeydown({ key: 'Delete' });
  assert.deepEqual([f.plans().length, f.focused()], [2, f.root]);
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

test('a sound slides along its track, and stops on a cut of the film when it is near one (0.6.138)', async () => {
  const f = await setup().open();
  f.get('montage-take')[0].ondblclick();
  f.get('montage-take')[3].ondblclick();
  const sound = () => f.ui.state().montage.sounds[0],
    piece = () => find(f.root, 'is-sound')[0];
  // Thirty seconds of music on a lane of 1000: a hundred pixels are three seconds.
  f.press(piece(), 10);
  f.pointer.move(110);
  assert.deepEqual([sound().at, piece().style.left], [3, '10%']);
  // Near the end of the only plan (5 s): on it. Near is eight pixels of the timeline, here a quarter
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
  assert.deepEqual([f.ui.state().chosen, f.said('montage-title-name')], [sound().id, ['Musique · Prise 4']]);
  // An image has one edge to pull: its length.
  f.get('montage-take')[2].ondblclick();
  assert.deepEqual(find(f.plans()[1], 'montage-grip').map(grip => grip.className), ['montage-grip is-end']);
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
  f.press(f.get('montage-ruler')[0], 100);
  assert.equal(f.ui.state().head, 1);
  assert.deepEqual([video.hidden, video.currentTime], [false, 1]);
  // (0.6.138) Held, the head follows the pointer along the ruler, until it is let go.
  f.pointer.move(250);
  assert.deepEqual([f.ui.state().head, video.currentTime, find(f.root, 'montage-playhead')[0].style.left], [2.5, 2.5, '25%']);
  f.pointer.move(450);
  assert.deepEqual([f.ui.state().head, picture.hidden], [4.5, false]);
  f.pointer.up();
  assert.equal(f.pointer.held(), 0);
  // A press on a lane beside what it holds puts the head there too; the space bar reads the film
  // from anywhere in the montage, except where a key is typed or a button pressed.
  const [lane] = f.lanes();
  lane.onclick({ clientX: 800, target: lane });
  assert.equal(f.ui.state().head, 6);
  lane.onclick({ clientX: 100, target: f.plans()[0] });
  assert.equal(f.ui.state().head, 6);
  const key = (name, tagName, className) => f.root.onkeydown({ key: name, target: { tagName, className }, preventDefault() {} });
  key('Home', 'DIV');
  assert.equal(f.ui.state().head, 0);
  key(' ', 'INPUT');
  key(' ', 'BUTTON');
  key(' ', 'BUTTON', 'montage-action is-quiet');
  assert.equal(f.ui.state().playing, false);
  key(' ', 'SECTION');
  assert.equal(f.ui.state().playing, true);
  key(' ', 'DIV');
  assert.equal(f.ui.state().playing, false);
  // A plan, a sound, a take: buttons too, but the space bar reads the film there (Enter chooses).
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
  f.button('Supprimer ce montage').onclick();
  assert.equal(f.calls.some(call => call.route === 'montages/remove'), false);
  f.button('Confirmer la suppression').onclick();
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

// ------------------------------------------------------------------ plans to make (0.6.142)
// The second step of the montage (maquettes M5 et M9 du 20/11, « Oui, code-le »): photos laid on a track
// above the plans, plans to make, and « Créer ce plan ».
const event = clientX => ({ clientX, prevented: false, preventDefault() { this.prevented = true; } });
const photos = () => [take(5, 'image'), take(6, 'image')];
const made = (n, frames, more = {}) => take(n, 'video', { parameters: { frames, fps: 24, ...more } });

test('photos dragged to their track become plans to make, each against the edge of its plan (0.6.142)', async () => {
  const f = await setup({ extra: photos(), create: async () => null }).open();
  const carry = at => f.get('montage-take')[at].ondragstart({ dataTransfer: { setData() {} } }),
    pins = () => find(f.root, 'montage-photo').map(pin => [pin.className, pin.style.left ?? null, pin.style.right ?? null, pin.attributes['aria-label']]);
  assert.deepEqual(f.said('montage-track-name'), ['Repères', 'Plans', 'Musique', 'Bruitages']);
  // An image is taken there; a clip or a sound is not.
  carry(2);
  const over = event(0);
  f.photos().ondragover(over);
  carry(0);
  const refused = event(0);
  f.photos().ondragover(refused);
  assert.deepEqual([over.prevented, refused.prevented], [true, false]);
  // His three photos, at 0, 5 and 7 seconds (ten seconds on a lane of 1000).
  for (const [at, x] of [[2, 0], [4, 500], [5, 700]]) {
    carry(at);
    f.photos().ondrop(event(x));
  }
  assert.deepEqual(f.plans().map(piece => [piece.className, piece.textContent]), [
    ['montage-piece is-todo', '1 · À FAIREPlan à faire5 s'],
    ['montage-piece is-todo', '2 · À FAIREPlan à faire2 s'],
  ]);
  // The start photo against the left edge of its plan, an end photo against the right edge of its own.
  assert.deepEqual(pins(), [
    ['montage-photo is-start', '0%', null, 'Photo de début du plan 1'],
    ['montage-photo is-end', null, 'calc(50% + 4px)', 'Photo de fin du plan 1'],
    ['montage-photo is-end', null, 'calc(30% + 4px)', 'Photo de fin du plan 2'],
  ]);
  assert.deepEqual(find(f.root, 'montage-photo').map(pin => [pin.style.backgroundImage, pin.textContent]), [['url("/thumb/3")', 'Début'], ['url("/thumb/5")', 'Fin'], ['url("/thumb/6")', 'Fin']]);
  assert.deepEqual(f.said('montage-summary'), ['2 plans à faire · 7 s · 16:9 · 24 i/s']);
  // No film while a plan is to make: said on its button.
  const [go] = f.get('montage-export');
  assert.deepEqual([go.disabled, go.title], [true, 'Créez ou retirez les plans à faire pour exporter le film']);
  // The last laid is the one chosen: its settings at the right, and why it cannot be created yet.
  assert.deepEqual(f.said('montage-title-name').concat(f.said('montage-title-meta')), ['Plan 2 · à faire', 'Vidéo · ce plan n’existe pas encore']);
  assert.deepEqual(f.said('montage-row-name'), ['Photo de début', 'Photo de fin', 'Durée', 'Ce qui se passe']);
  assert.deepEqual(f.said('montage-none-yet'), ['Glissez une image sur « Repères »']);
  const [block] = f.get('montage-inspector'),
    [field] = f.get('montage-words-field'),
    create = () => f.button('Créer ce plan');
  assert.deepEqual([create().disabled, f.said('montage-reason')], [true, ['Écrivez ce qui se passe dans ce plan.']]);
  // Written: the block stays under the hand (the button too), and the reason follows.
  Object.assign(field, { value: 'Il regarde la mer.' }).oninput();
  assert.equal(f.get('montage-inspector')[0], block);
  assert.deepEqual([f.ui.state().montage.plans[1].todo.prompt, f.said('montage-reason')], ['Il regarde la mer.', ['Créez d’abord le plan 1 : celui-ci le continue.']]);
  assert.deepEqual(f.plans()[1].textContent, '2 · À FAIREIl regarde la mer.2 s');
  // Its length by its bar or its right edge, within what a clip can be; it has no left edge to pull.
  assert.deepEqual(find(f.plans()[1], 'montage-grip').map(grip => grip.className), ['montage-grip is-end']);
  Object.assign(f.slider('Durée du plan'), { value: '3.5' }).oninput();
  assert.equal(f.ui.state().montage.plans[1].to, 3.5);
  // A photo clicked chooses its plan; one taken off with its cross leaves the other.
  find(f.root, 'montage-photo')[0].onclick();
  assert.deepEqual(f.said('montage-title-name'), ['Plan 1 · à faire']);
  assert.deepEqual(f.said('montage-figures').slice(0, 2), ['Prise 3', 'Prise 5']);
  find(f.root, 'montage-off')[1].onclick();
  assert.deepEqual(pins().map(pin => pin[3]), ['Photo de début du plan 1', 'Photo de fin du plan 2']);
  // A clip dropped there is no photo: said, nothing changed. All of it is kept, as any change.
  carry(0);
  f.photos().ondrop(event(100));
  assert.match(f.notices.at(-1), /^Seule une image/);
  assert.equal(f.plans().length, 2);
  await f.later();
  assert.equal(f.saves().at(-1).body.montage.plans[1].todo.prompt, 'Il regarde la mer.');
});

test('« Créer ce plan » asks the Studio for the clip, shows it being made, and the plan becomes its take (0.6.142)', async () => {
  const asked = [];
  let answer = null;
  const f = await setup({
    extra: photos(),
    create: (wanted, hooks) => {
      asked.push({ wanted: structuredClone(wanted), hooks });
      return new Promise((resolve, reject) => (answer = { resolve, reject }));
    },
  }).open();
  const carry = at => f.get('montage-take')[at].ondragstart({ dataTransfer: { setData() {} } });
  for (const [at, x] of [[2, 0], [4, 500], [5, 700]]) {
    carry(at);
    f.photos().ondrop(event(x));
  }
  const write = (plan, words) => {
    f.plans()[plan].onclick();
    if (f.ui.state().chosen !== f.ui.state().montage.plans[plan].id) f.plans()[plan].onclick();
    Object.assign(f.get('montage-words-field')[0], { value: words }).oninput();
  };
  write(0, 'Il lève les yeux.');
  assert.deepEqual([f.button('Créer ce plan').disabled, f.said('montage-reason')], [false, ['']]);
  f.button('Créer ce plan').onclick();
  await settle();
  // Kept first, then asked as the Studio asks a clip: its text, its length, the format of the film, its two photos.
  assert.equal(f.saves().length, 1);
  assert.deepEqual(asked[0].wanted, {
    verb: 'create_video',
    args: { prompt: 'Il lève les yeux.', intention: 'Plan d’un montage, demandé dans le Studio.', duration: 5, format: '16:9', start_image: { output: id(3) }, end_image: { output: id(5) } },
  });
  // Being made: said on the plan and in the head, with what stops it; nothing else is changed meanwhile.
  asked[0].hooks.onProgress('Étape 3 sur 8', 0.4);
  assert.deepEqual([f.plans()[0].className, f.plans()[0].textContent], ['montage-piece is-todo is-making', '1 · EN COURSÉtape 3 sur 85 s']);
  assert.deepEqual([find(f.root, 'montage-piece-bar-done')[0].style.width, f.said('montage-status')], ['40%', ['Création du plan 1 · Étape 3 sur 8 · 40 %']]);
  assert.deepEqual([f.get('montage-export')[0].disabled, f.button('Création…').disabled, f.ui.state().making.id], [true, true, f.ui.state().montage.plans[0].id]);
  f.plans()[1].onkeydown({ key: 'Delete' });
  assert.equal(f.plans().length, 2);
  assert.match(f.notices.at(-1), /^Un plan est en cours de création/);
  f.get('montage-halt')[0].onclick();
  assert.equal(f.halted(), 1);
  // Made (the Studio has read the takes of the project again): the plan is the plan of that take.
  f.runs.push(made(50, 121));
  answer.resolve(f.runs.at(-1));
  await settle();
  assert.deepEqual([f.plans()[0].className, f.plans()[0].textContent], ['montage-piece', '1 · PRISE 50Vidéo5 s']);
  assert.deepEqual([f.said('montage-status'), f.ui.state().making, f.get('montage-halt').length], [['Plan 1 créé'], null, 0]);
  assert.deepEqual(f.ui.state().montage.plans[0], { id: f.ui.state().montage.plans[0].id, kind: 'video', from: 0, to: 5.042, frame: 'fit', volume: 1, photos: { start: { conversationId: C, runId: id(3), output: 0 }, end: { conversationId: C, runId: id(5), output: 0 } }, source: { conversationId: C, runId: id(50), output: 0 } });
  await f.later();
  assert.equal(f.saves().at(-1).body.montage.plans[0].source.runId, id(50));
  // The second goes on from it, to its own photo: a clip that starts on the last image of the first.
  write(1, 'Il regarde la mer.');
  f.button('Créer ce plan').onclick();
  await settle();
  assert.deepEqual(asked[1].wanted.args, { prompt: 'Il regarde la mer.', intention: 'Plan d’un montage, demandé dans le Studio.', duration: 2, format: '16:9', start_image: { output: id(50), frame: 'last' }, end_image: { output: id(6) } });
  // Refused by the engine: said where the state is, the plan is still to make and can be tried again.
  answer.reject(new Error('Mémoire vidéo insuffisante.'));
  await settle();
  assert.deepEqual([f.said('montage-status'), f.plans()[1].className, f.ui.state().making], [['Création impossible : Mémoire vidéo insuffisante.'], 'montage-piece is-todo is-suite', null]);
  assert.equal(f.button('Créer ce plan').disabled, false);
  // Without its end photo it is the continuation itself, whose file holds the first clip: the plan shows what was added.
  find(f.root, 'montage-off')[0].onclick();
  // (0.6.143) « Prolonger », the word of the Studio for it.
  assert.equal(f.button('Créer ce plan'), undefined);
  f.button('Prolonger').onclick();
  await settle();
  assert.deepEqual(asked[2].wanted, { verb: 'extend_video', args: { prompt: 'Il regarde la mer.', intention: 'Plan d’un montage, demandé dans le Studio.', duration: 2, source: { output: id(50) } } });
  f.runs.push(made(51, 49, { continuation: { overlapFrames: 9, sourceFrames: 121, newFrames: 40 } }));
  answer.resolve(f.runs.at(-1));
  await settle();
  assert.deepEqual([f.ui.state().montage.plans[1].from, f.ui.state().montage.plans[1].to, f.plans()[1].textContent], [5.042, 6.708, '2 · PRISE 51Vidéo1,7 s']);
  assert.equal(f.get('montage-export')[0].disabled, false, 'every plan is made: the film can be exported');
  // A creation that could not begin (the Studio busy elsewhere) is said too.
  carry(4);
  f.photos().ondrop(event(900));
  write(2, 'Le soleil perce.');
  f.button('Créer ce plan').onclick();
  await settle();
  answer.resolve(null);
  await settle();
  assert.deepEqual(f.said('montage-status'), ['Création impossible : la création n’a pas pu commencer.']);
});

test('a photo laid above a video cuts it there: its end is greyed until the new clip is made (0.6.142)', async () => {
  const f = await setup({ extra: photos() }).open();
  const carry = at => f.get('montage-take')[at].ondragstart({ dataTransfer: { setData() {} } });
  f.get('montage-take')[0].ondblclick();
  // Three seconds into a clip of five: kept up to there, the two that follow will be replaced.
  carry(2);
  f.photos().ondrop(event(300));
  assert.deepEqual(f.plans().map(piece => [piece.className, piece.textContent, piece.style.backgroundImage]), [
    ['montage-piece', '1 · PRISE 1Vidéo3 s', 'url("/thumb/1")'],
    ['montage-piece is-todo is-replacing', '2 · SERA REMPLACÉNouveau clip qui part de la photo2 s', 'url("/thumb/1")'],
  ]);
  assert.deepEqual(find(f.root, 'montage-photo').map(pin => [pin.className, pin.style.left]), [['montage-photo is-start', '30%']]);
  assert.deepEqual(f.said('montage-title-meta'), ['Remplace la fin du plan 1']);
  assert.match(f.get('montage-title-meta')[0].title, /coupe sur la photo/);
  assert.deepEqual(f.said('montage-summary'), ['2 plans dont 1 à faire · 5 s · 16:9 · 24 i/s']);
  // On the screen, a plan to make is the photo it starts on; without one, said.
  const [frame] = f.get('montage-frame'),
    [blank, picture, video, caption] = frame.children;
  f.ui.seek(4);
  assert.deepEqual([picture.src, picture.hidden, video.hidden, caption.textContent], ['/media/3', false, true, 'Plan 2 · à faire']);
  find(f.root, 'montage-off')[0].onclick();
  f.ui.seek(4);
  assert.deepEqual([blank.hidden, blank.children[0].textContent, picture.hidden], [false, 'Plan à faire.', true]);
  // Without a creation here, the button says so; « Retirer la photo » gives the video its end back.
  assert.deepEqual([f.button('Créer ce plan').disabled, f.button('Créer ce plan').title], [true, 'La création n’est pas disponible ici.']);
  f.button('Retirer la photo').onclick();
  assert.deepEqual(f.plans().map(piece => piece.textContent), ['1 · PRISE 1Vidéo5 s']);
  // Too near the end of the video, nothing would be replaced: said, nothing changed.
  carry(2);
  f.photos().ondrop(event(450));
  assert.match(f.notices.at(-1), /^Posez la photo plus tôt/);
  assert.equal(f.plans().length, 1);
});

test('a take whose small picture has just been made shows it on the timeline at once (0.6.142)', async () => {
  // (Seen on the card, 20/11: the plan just created was black on the timeline until the next change,
  // its take showing its picture beside. The picture is made from the tile of the take, once its clip is read.)
  const fresh = take(9, 'video', { parameters: { frames: 48, fps: 24 }, outputs: [{ take: 9, originalUrl: '/media/9' }] });
  const f = await setup({ extra: [fresh], thumbnail: async (api, record) => void (record.outputs[0].thumbUrl = '/thumb/9') }).open();
  const tile = () => f.get('montage-take').find(item => item.dataset.id === id(9));
  tile().ondblclick();
  assert.deepEqual([f.plans().length, f.plans()[0].style.backgroundImage], [1, undefined]);
  const words = f.get('montage-title-name')[0];
  tile().querySelectorAll('VIDEO')[0].onloadeddata();
  await settle();
  assert.equal(f.plans()[0].style.backgroundImage, 'url("/thumb/9")');
  // (Only the timeline is drawn again: what is being set at the right stays under the hand.)
  assert.equal(f.get('montage-title-name')[0], words);
  // A take that is on no plan draws nothing again.
  const other = take(10, 'video', { parameters: { frames: 48, fps: 24 }, outputs: [{ take: 10, originalUrl: '/media/10' }] });
  const g = await setup({ extra: [other], thumbnail: async (api, record) => void (record.outputs[0].thumbUrl = '/thumb/10') }).open();
  const lane = g.lanes()[0];
  g.get('montage-take').find(item => item.dataset.id === id(10)).querySelectorAll('VIDEO')[0].onloadeddata();
  await settle();
  assert.equal(g.lanes()[0], lane);
});

test('the end of a video pulled beyond its take shows its continuation to make, joined to it (0.6.143)', async () => {
  // (Maquette M6, his words of 20/11: « s'il déroule la vidéo plus loin que sa durée d'origine, on lui
  // montre implicitement que ça va continuer sa vidéo (et ça déplace les images ou vidéos vers la droite) ».)
  const f = await setup({ extra: photos(), create: async () => null }).open();
  for (const at of [0, 2]) f.get('montage-take')[at].ondblclick();
  const grips = () => find(f.root, 'montage-grip'),
    plans = () => f.ui.state().montage.plans,
    shown = () => f.plans().map(piece => [piece.className, piece.textContent, piece.style.left, piece.style.width]);
  assert.deepEqual(grips().map(grip => grip.className), ['montage-grip is-start', 'montage-grip is-end', 'montage-grip is-end']);
  // The end of the video (5 s of 10 on a lane of 1000: a second is 100). A little beyond the end of its
  // take: the whole take, nothing more, the hand can stop there.
  f.press(grips()[1], 500);
  f.pointer.move(540);
  assert.deepEqual([plans().length, plans()[0].to, f.get('montage-tip').length], [2, 5, 0]);
  // Four seconds beyond: its continuation to make, touching it; the image comes later in the film.
  f.pointer.move(900);
  assert.deepEqual(shown(), [
    ['montage-piece', '1 · PRISE 1Vidéo5 s', '0%', 'calc(50% - 4px)'],
    ['montage-piece is-todo is-suite', '2 · SUITE À CRÉERSuite du plan 1+ 4 s', 'calc(50% - 4px)', '40%'],
    ['montage-piece', '3 · PRISE 3Image3 s', '90%', 'calc(30% - 4px)'],
  ]);
  // What that does is said where the hand is; the video stays the one in hand.
  assert.deepEqual([f.said('montage-tip'), f.get('montage-tip')[0].style.left], [['Au-delà de la prise : + 4 s à créer · ce qui suit se décale'], 'clamp(180px, 90%, calc(100% - 180px))']);
  assert.deepEqual(f.said('montage-title-name'), ['Plan 1 · Prise 1']);
  // Pulled back within the take: gone, as if nothing had been asked.
  f.pointer.move(450);
  assert.deepEqual([plans().length, plans()[0].to, f.get('montage-tip').length], [2, 4.5, 0]);
  // Beyond again, and let go: the continuation is chosen, what happens next is written there.
  f.pointer.move(700);
  f.pointer.up();
  assert.deepEqual([plans().length, plans()[0].to, plans()[1].to, f.ui.state().chosen === plans()[1].id, f.get('montage-tip').length], [3, 5, 2, true, 0]);
  assert.deepEqual(f.said('montage-title-name').concat(f.said('montage-title-meta')), ['Plan 2 · suite à créer', 'Continue le plan 1, là où il s’arrête']);
  assert.deepEqual(f.said('montage-row').slice(0, 2), ['DépartFin du plan 1', 'Photo de finGlissez une image sur « Repères »']);
  assert.deepEqual(find(f.root, 'montage-action').map(control => control.textContent), ['Prolonger', 'Retirer la suite']);
  assert.deepEqual(f.said('montage-words').map(words => words.slice(0, 23)), ['Ce qui se passe ensuite']);
  await f.later();
  assert.deepEqual(f.saves().at(-1).body.montage.plans.map(plan => [Boolean(plan.todo), plan.to]), [[false, 5], [true, 2], [false, 3]]);
  // It has its continuation: the edge of the video stops at the end of its take, that one has its own edge.
  f.press(grips()[1], 500);
  f.pointer.move(800);
  f.pointer.up();
  assert.deepEqual(plans().map(plan => plan.to), [5, 2, 3]);
  f.press(grips()[2], 700);
  f.pointer.move(850);
  f.pointer.up();
  assert.deepEqual([plans().map(plan => plan.to), f.plans()[1].textContent], [[5, 3.5, 3], '2 · SUITE À CRÉERSuite du plan 1+ 3,5 s']);
  // Towards an end photo it is a new clip, from the last image of the video: said as it is, and asked as such.
  f.get('montage-take')[4].ondragstart({ dataTransfer: { setData() {} } });
  // (The film is 11,5 s long now: 652 of 1000 is 7,5 s, on the second half of the continuation.)
  f.photos().ondrop(event(652));
  assert.deepEqual(f.said('montage-title-meta'), ['Part de la dernière image du plan 1']);
  assert.deepEqual([f.plans()[1].className, f.plans()[1].textContent], ['montage-piece is-todo is-suite', '2 · SUITE À CRÉERJusqu’à la photo de fin+ 3,5 s']);
  assert.deepEqual(find(f.root, 'montage-action').map(control => control.textContent), ['Créer ce plan', 'Retirer la suite']);
  // « Retirer la suite »: the film as it was.
  f.button('Retirer la suite').onclick();
  assert.deepEqual(shown(), [
    ['montage-piece', '1 · PRISE 1Vidéo5 s', '0%', 'calc(50% - 4px)'],
    ['montage-piece', '2 · PRISE 3Image3 s', '50%', 'calc(30% - 4px)'],
  ]);
  // Neither an image nor a plan to make is continued by its edge: the edge of an image is its length.
  f.press(grips()[2], 800);
  f.pointer.move(1000);
  f.pointer.up();
  assert.deepEqual(plans().map(plan => [plan.kind, plan.to]), [['video', 5], ['image', 5]]);
  // (Nothing after the video: nothing is said to move.)
  const alone = await setup().open();
  alone.get('montage-take')[0].ondblclick();
  alone.press(find(alone.root, 'montage-grip')[1], 500);
  alone.pointer.move(900);
  assert.deepEqual(alone.said('montage-tip'), ['Au-delà de la prise : + 4 s à créer']);
  alone.pointer.up();
  assert.deepEqual(alone.said('montage-title-name'), ['Plan 2 · suite à créer']);
});
