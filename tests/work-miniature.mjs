import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { FOLDED_KEY, setupMiniature } from '../public/work-miniature.mjs';

/**
 * The miniature of the chat (0.6.81, public/work-miniature.mjs): while a work goes on and the user
 * looks elsewhere, a small window shows it as the conversation does, brings back to it in one click,
 * and says how it ended. A page of elements enough for it: their classes, their words, their parent.
 */
class Element {
  constructor(tag = '', className = '', text = '') {
    const names = new Set(String(className).split(' ').filter(Boolean));
    Object.assign(this, { tag, className, textContent: text ?? '', children: [], parentNode: null, hidden: false, dataset: {}, attributes: {} });
    this.style = {
      values: {},
      setProperty(name, value) {
        this.values[name] = value;
      },
    };
    this.classList = {
      add: (...added) => added.forEach(name => names.add(name)),
      remove: (...removed) => removed.forEach(name => names.delete(name)),
      toggle: (name, on = !names.has(name)) => (on ? names.add(name) : names.delete(name), on),
      contains: name => names.has(name),
    };
  }
  append(...items) {
    for (const item of items) {
      if (item?.parentNode) item.parentNode.children = item.parentNode.children.filter(child => child !== item);
      if (item && typeof item === 'object') item.parentNode = this;
      this.children.push(item);
    }
  }
  prepend(item) {
    if (item.parentNode) item.parentNode.children = item.parentNode.children.filter(child => child !== item);
    item.parentNode = this;
    this.children.unshift(item);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  /** The first element under it of that class. */
  find(name) {
    for (const child of this.children) {
      if (!(child instanceof Element)) continue;
      if (child.classList.contains(name)) return child;
      const found = child.find(name);
      if (found) return found;
    }
    return null;
  }
}
const node = (tag, className, text) => new Element(tag, className, text);

/** A miniature on a page, with what its Flux and its picture so far were told. */
function miniature({ storage = null, mayClose, onClosed } = {}) {
  const drawn = { fluxes: [], shown: [] },
    opened = [];
  const page = node('body');
  const mini = setupMiniature({
    node,
    icon: name => node('svg', 'icon-' + name),
    mark: () => node('svg', 'mark'),
    open: work => opened.push(work),
    ...(mayClose ? { mayClose } : {}),
    ...(onClosed ? { onClosed } : {}),
    storage,
    makeFlux: () => {
      const flux = { told: [], stopped: false, visible: null };
      for (const name of ['source', 'neutral', 'progress']) flux[name] = value => flux.told.push([name, value]);
      flux.visible = value => (flux.seen = value);
      flux.stop = () => (flux.stopped = true);
      drawn.fluxes.push(flux);
      return flux;
    },
    makePreview: () => ({ show: url => drawn.shown.push(url), clear() {} }),
  });
  page.append(mini.element);
  const part = name => mini.element.find(name);
  // (The words of its stage, beside its time since 0.6.93.)
  return { mini, page, drawn, opened, part, said: () => part('work-mini-said').textContent };
}
const WORK = { conversationId: 'a1111111-1111-4111-8111-111111111111', title: 'Renard dans la neige', kind: 'turn' };
const video = { mediaType: 'video', workflowName: 'LTX 2.5', requestId: 'r1' };

test('the miniature shows the take in progress as the conversation does, and brings back to it in one click', () => {
  const { mini, drawn, opened, part, said } = miniature();
  // Nothing to show before a work.
  mini.place('corner');
  assert.equal(mini.element.hidden, true);
  mini.begin(WORK);
  mini.place('corner');
  assert.equal(mini.element.hidden, false);
  assert.equal(part('work-mini-title').textContent, 'Renard dans la neige');
  // Signed by the Éclipse of Moodix, beside the name of the conversation.
  assert.ok(part('work-mini-mark').find('mark'));
  // Moodix answers: its words, no take yet.
  assert.equal(said(), 'Moodix répond…');
  assert.equal(mini.element.classList.contains('has-take'), false);
  mini.answer('Le modèle se charge…');
  assert.equal(said(), 'Le modèle se charge…');
  // A video waits for the user on its card.
  mini.take({ type: 'start', request: video });
  assert.equal(mini.phase, 'waiting');
  assert.equal(said(), 'En attente de votre accord');
  assert.equal(part('work-mini-kind').textContent, 'Vidéo · LTX 2.5');
  // Made: its stage, its percentage, its line, the Flux of the picture so far.
  mini.take({ type: 'progress', request: video, text: 'Génération · 5/8', fraction: 0.42, preview: '/media/job-preview/j/3' });
  assert.equal(mini.phase, 'making');
  assert.equal(said(), 'Génération · 5/8');
  assert.equal(part('work-mini-percent').textContent, '42 %');
  assert.equal(part('work-mini-fill').style.values['--mini-progress'], '0.42');
  assert.equal(part('work-mini-bar').classList.contains('is-determinate'), true);
  assert.deepEqual(drawn.shown, ['/media/job-preview/j/3']);
  const flux = drawn.fluxes.at(-1);
  assert.deepEqual(flux.told.at(-1), ['progress', 0.42]);
  assert.equal(flux.seen, true, 'it draws while it is in sight');
  assert.match(part('work-mini-back').getAttribute('aria-label'), /^Revenir à la conversation « Renard dans la neige » : Vidéo · LTX 2\.5 · Génération · 5\/8 · 42/);
  // The take is there: its picture, its number.
  const record = { mediaType: 'video', outputs: [{ thumbUrl: '/media/thumbs/a/b/0', take: 14 }] };
  mini.take({ type: 'image', request: video, record, index: 0 });
  mini.take({ type: 'done', request: video, record, failed: false });
  assert.equal(mini.phase, 'done');
  assert.equal(said(), 'Prise 14 prête');
  assert.equal(part('work-mini-still').src, '/media/thumbs/a/b/0');
  assert.equal(part('work-mini-still').hidden, false);
  assert.equal(flux.stopped, true, 'its Flux ends with the take');
  // No × while the work goes on (Moodix may still answer); once it is over, the ×.
  assert.equal(part('work-mini-close').hidden, true);
  mini.end();
  assert.equal(mini.running, false);
  assert.equal(part('work-mini-close').hidden, false);
  // One click: back to its conversation.
  part('work-mini-back').onclick();
  assert.deepEqual(opened.map(work => work.conversationId), [WORK.conversationId]);
  // Closed: nothing left of it.
  part('work-mini-close').onclick();
  assert.equal(mini.element.hidden, true);
  assert.equal(mini.work, null);
});

test('the miniature says how long the take has been in the making, as its card does, then how long it took (0.6.93)', () => {
  const { mini, part, said } = miniature();
  mini.begin(WORK);
  mini.place('corner');
  const time = () => part('work-mini-time');
  // Waiting for the user: nothing counted yet.
  mini.take({ type: 'start', request: video });
  assert.equal(time().textContent, '');
  // Its card heard the server: the same count, at the right of its stage.
  mini.take({ type: 'progress', request: video, text: 'Génération · 5/8', fraction: 0.42 });
  mini.take({ type: 'time', text: '1 min 12 s' });
  assert.deepEqual([said(), time().textContent], ['Génération · 5/8', '1 min 12 s']);
  assert.equal(time().parentNode, part('work-mini-stage'), 'on the line of its stage');
  assert.match(part('work-mini-back').getAttribute('aria-label'), /Génération · 5\/8 · 42 % · 1 min 12 s$/);
  // Made: how long it took, as its record says it.
  const record = { mediaType: 'video', parameters: { generation_time: { total_ms: 73400 } }, outputs: [{ take: 14 }] };
  mini.take({ type: 'image', request: video, record, index: 0 });
  mini.take({ type: 'done', request: video, record, failed: false });
  assert.deepEqual([said(), time().textContent], ['Prise 14 prête', '1 min 13 s']);
  // Made before 0.6.93 (the engine's time alone), or failed: no time.
  mini.begin(WORK);
  mini.take({ type: 'start', request: video });
  mini.take({ type: 'time', text: '12 s' });
  mini.take({ type: 'done', request: video, record: { ...record, parameters: { generation_duration_ms: 70000 } } });
  assert.equal(time().textContent, '');
  mini.begin(WORK);
  mini.take({ type: 'start', request: video });
  mini.take({ type: 'progress', request: video, text: 'Génération · 1/8', fraction: 0.1 });
  mini.take({ type: 'time', text: '12 s' });
  mini.take({ type: 'failed', message: 'La mémoire a manqué.' });
  assert.equal(time().textContent, '');
});

test('the miniature says a failure, a cancellation, and an answer made of words alone', () => {
  const { mini, part, said } = miniature();
  mini.begin(WORK);
  mini.place('corner');
  // An image is made at once (no card).
  mini.take({ type: 'start', request: { workflowName: 'Krea 2', autoAllow: true } });
  assert.equal(mini.phase, 'making');
  assert.equal(part('work-mini-kind').textContent, 'Image · Krea 2');
  mini.take({ type: 'failed', message: 'La carte graphique manque de mémoire.' });
  assert.equal(mini.phase, 'failed');
  assert.equal(said(), 'Échec · La carte graphique manque de mémoire.');
  assert.equal(mini.element.dataset.phase, 'failed');

  mini.begin(WORK);
  mini.take({ type: 'start', request: video });
  mini.take({ type: 'progress', request: video, text: 'Génération · 1/8', fraction: 0.1 });
  mini.take({ type: 'stopped' });
  assert.equal(said(), 'Génération arrêtée');

  // A turn of words alone, over while the user was away.
  mini.begin(WORK);
  mini.end();
  assert.equal(mini.phase, 'answered');
  assert.equal(said(), 'Moodix a répondu');
  assert.equal(mini.taking, false);
  // A card answered (declined) where it was shown leaves nothing to say of a take.
  mini.begin(WORK);
  mini.take({ type: 'start', request: video });
  mini.end();
  assert.equal(mini.phase, 'answered');
  // Over, it hears nothing more of takes.
  mini.take({ type: 'start', request: video });
  assert.equal(mini.phase, 'answered');
});

test('the miniature folds into a pill the browser keeps; in the foot of the Paramètres it is that pill, then back in its corner', () => {
  const kept = new Map(),
    storage = { getItem: key => kept.get(key) ?? null, setItem: (key, value) => kept.set(key, value) };
  const { mini, page, drawn, part } = miniature({ storage });
  mini.begin(WORK);
  mini.place('corner');
  assert.equal(mini.folded, false);
  part('work-mini-fold').onclick();
  assert.equal(mini.element.classList.contains('is-folded'), true);
  assert.equal(kept.get(FOLDED_KEY), 'pill');
  assert.equal(part('work-mini-fold').getAttribute('aria-label'), 'Agrandir la miniature');
  // The next page opens it folded, as it was left.
  assert.equal(miniature({ storage }).mini.folded, true);
  // In the foot of the Paramètres (a window above the page), then back in the page.
  const foot = node('footer', 'settings-footer');
  mini.take({ type: 'start', request: { workflowName: 'Krea 2', autoAllow: true } });
  mini.place(foot);
  assert.equal(mini.element.parentNode, foot);
  assert.equal(foot.children[0], mini.element, 'at the left of « Annuler » and « Enregistrer »');
  assert.equal(mini.element.classList.contains('is-foot'), true);
  mini.place('corner');
  assert.equal(mini.element.parentNode, page);
  assert.equal(mini.element.classList.contains('is-foot'), false);
  // Out of sight, its Flux does not draw.
  mini.place(null);
  assert.equal(mini.element.hidden, true);
  assert.equal(drawn.fluxes.at(-1).seen, false);
});

test('« × » asks the page first: kept when it says no, and the page told what went with it (0.6.87)', () => {
  // Without the history, the conversation it leads back to can be opened from nowhere else: the page
  // asks before, and lets it go with it.
  let allowed = false;
  const closed = [];
  const { mini, part } = miniature({ mayClose: () => allowed, onClosed: work => closed.push(work) });
  mini.begin(WORK);
  mini.take({ type: 'start', request: video });
  mini.take({ type: 'done', record: { id: 'r', outputs: [{ take: 3 }] } });
  mini.end();
  mini.place('corner');
  part('work-mini-close').onclick();
  assert.equal(mini.element.hidden, false, 'kept');
  assert.equal(mini.work?.conversationId, WORK.conversationId);
  assert.deepEqual(closed, []);
  allowed = true;
  part('work-mini-close').onclick();
  assert.equal(mini.element.hidden, true);
  assert.deepEqual(closed.map(work => work.conversationId), [WORK.conversationId]);
});

test('a take waiting for the user in the Studio of its conversation says so, without a Flux, until it begins (0.6.88)', () => {
  // « Préparation… » over a Flux that moved for nothing while Moodix AI waited there.
  const { mini, drawn, said } = miniature();
  mini.begin(WORK);
  mini.place('corner');
  mini.take({ type: 'start', request: { mediaType: 'image', workflowName: 'Krea 2', requestId: 'r2' } });
  assert.equal([mini.phase, said()].join(' · '), 'making · Préparation…');
  const flux = drawn.fluxes.at(-1);
  mini.waitFor('Moodix AI vous attend dans le Studio de cette conversation');
  assert.equal([mini.phase, said()].join(' · '), 'waiting · Moodix AI vous attend dans le Studio de cette conversation');
  assert.equal(flux.stopped, true, 'no Flux for nothing');
  // It begins: made as any take.
  mini.take({ type: 'progress', text: 'Génération · 1/8', fraction: 0.1 });
  assert.equal([mini.phase, said()].join(' · '), 'making · Génération · 1/8');
  mini.waitFor('Moodix AI vous attend dans le Studio de cette conversation');
  assert.equal(mini.phase, 'making', 'once begun, nothing to wait for');
  // A video waiting on its card says what it always said.
  mini.take({ type: 'start', request: video });
  assert.equal(said(), 'En attente de votre accord');
  // (0.6.180) One of the Studio or of the Bobine (a compact card) was accepted by its click: it is being
  // prepared, nothing waits for the user. It said « En attente de votre accord » until its first step.
  mini.take({ type: 'start', compact: true, request: video });
  assert.deepEqual([mini.phase, said()], ['making', 'Préparation…']);
});

/**
 * The page's side (app.js): where it puts the miniature (syncMiniature), and what it keeps of the take
 * of the Chat for the Studio of its conversation (chatTake), cut out of app.js and run on a page of
 * its own.
 */
const appSource = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
function appPart(from, to) {
  const start = appSource.indexOf(from),
    end = appSource.indexOf(to, start + 1);
  assert.ok(start >= 0 && end > start, `slice not found: ${from} … ${to}`);
  return appSource.slice(start, end);
}
function shownPage() {
  const { mini, part } = miniature(),
    foot = node('footer', 'settings-footer'),
    settings = { open: false, querySelector: selector => (selector === '.settings-footer' ? foot : null) },
    watched = [],
    // A proposal of Moodix AI waiting in the Studio of the work's conversation.
    held = { waiting: false };
  const state = {
    view: 'chat',
    conversationId: WORK.conversationId,
    miniature: mini,
    work: null,
    waitingForModel: false,
    studio: {
      proposing: () => held.waiting,
      heldFor: () => (held.waiting ? WORK.conversationId : null),
      holds: () => held.waiting,
      watch: () => watched.push(structuredClone(state.work?.take ?? null)),
    },
  };
  const context = {
    state,
    $: id => (id === 'settings' ? settings : null),
    shownHere: id => !id || state.conversationId === id,
    document: { body: { dataset: {} } },
  };
  runInNewContext(
    appPart('function syncMiniature(', '/** Whether `version`') +
      appPart('function chatTake(', '/** The name a work gives') +
      '\nthis.syncMiniature = syncMiniature;\nthis.chatTake = chatTake;',
    context,
  );
  return { mini, part, foot, settings, state, held, watched, sync: context.syncMiniature, chatTake: context.chatTake };
}

test('in the conversation of its work, its Chat as its Studio, the miniature never shows; elsewhere it does (0.6.96)', () => {
  // Chat and Studio are two views of one conversation: it showed in the Studio whenever the Studio did
  // not hold the take (one asked in the Chat, a video waiting on its card there), as for another one.
  const { mini, part, foot, settings, state, held, sync } = shownPage();
  state.work = { ...WORK };
  mini.begin(WORK);
  mini.take({ type: 'start', request: { workflowName: 'Krea 2', autoAllow: true } });
  mini.take({ type: 'progress', text: 'Génération · 2/8', fraction: 0.25 });
  for (const view of ['chat', 'studio']) {
    state.view = view;
    sync();
    assert.equal(mini.element.hidden, true, 'in its ' + view);
  }
  // A proposal of Moodix AI waiting in its Studio, a video waiting on its card in its Chat: the same.
  held.waiting = true;
  sync();
  assert.equal(mini.element.hidden, true);
  held.waiting = false;
  mini.take({ type: 'start', request: video });
  sync();
  assert.equal(mini.element.hidden, true);
  // The Pellicule, another conversation in its Chat or its Studio: it shows, in its corner.
  mini.take({ type: 'progress', request: video, text: 'Génération · 3/8', fraction: 0.4 });
  state.view = 'library';
  sync();
  assert.equal(mini.element.hidden, false);
  state.conversationId = 'b2222222-2222-4222-8222-222222222222';
  for (const view of ['chat', 'studio']) {
    state.view = view;
    sync();
    assert.equal(mini.element.hidden, false, 'in the ' + view + ' of another');
    assert.equal(part('work-mini-said').textContent, 'Génération · 3/8');
  }
  // The Paramètres, over its conversation: the pill in their foot.
  state.conversationId = WORK.conversationId;
  settings.open = true;
  sync();
  assert.equal(mini.element.parentNode, foot);
  settings.open = false;
  sync();
  assert.equal(mini.element.hidden, true);
  // A proposal waiting in its Studio, seen from another conversation: said so (0.6.88), as before.
  mini.begin(WORK);
  mini.take({ type: 'start', request: { mediaType: 'image', workflowName: 'Krea 2', requestId: 'r3' } });
  held.waiting = true;
  state.conversationId = 'b2222222-2222-4222-8222-222222222222';
  sync();
  assert.equal(part('work-mini-said').textContent, 'Moodix AI vous attend dans le Studio de cette conversation');
  assert.equal(mini.element.hidden, false);
  // Back in its conversation once it is over (in its Studio too): nothing more to say.
  held.waiting = false;
  mini.end();
  state.conversationId = WORK.conversationId;
  state.view = 'studio';
  sync();
  assert.equal(mini.work, null);
});

test('the page keeps the take of the Chat being made for the Studio of its conversation, not one of the Studio (0.6.96)', () => {
  const { state, watched, chatTake } = shownPage();
  const asked = { requestId: 'r1', workflowName: 'Krea 2', plan: { prompt: 'un phare' } };
  // No work: nothing to keep.
  chatTake({ type: 'start', request: asked });
  assert.deepEqual(watched, []);
  state.work = { ...WORK };
  chatTake({ type: 'start', request: asked });
  assert.equal(state.work.take.request, asked);
  assert.equal(state.work.take.running, false, 'not begun: a card may wait for the user');
  chatTake({ type: 'progress', request: asked, text: 'Génération · 2/8', fraction: 0.25, preview: '/p/2', time: { ms: 3000, running: true } });
  chatTake({ type: 'progress', request: asked, text: '', fraction: null, preview: null, time: null });
  assert.deepEqual(
    [state.work.take.running, state.work.take.label, state.work.take.fraction, state.work.take.preview, state.work.take.time?.ms],
    [true, 'Génération · 2/8', 0.25, '/p/2', 3000],
    'what is not said again stays as it was (its time from its go too, 0.6.93)',
  );
  // Its picture, its card's count each second, and the progress of another card, change nothing.
  chatTake({ type: 'image', request: asked, record: { id: 'x' }, index: 0 });
  chatTake({ type: 'time', request: asked, text: '4 s' });
  chatTake({ type: 'progress', request: { requestId: 'other' }, text: 'Génération · 7/8', fraction: 0.9 });
  assert.equal(state.work.take.label, 'Génération · 2/8');
  const record = { id: 'run', outputs: [{ take: 4 }] };
  chatTake({ type: 'done', request: asked, record, failed: false, error: '' });
  // (Made in the page's realm: read field by field.)
  const ended = () => [state.work.take.running, state.work.take.ended?.type, state.work.take.ended?.record, state.work.take.ended?.message];
  assert.deepEqual(ended(), [false, 'done', record, '']);
  chatTake({ type: 'start', request: { requestId: 'r2' } });
  chatTake({ type: 'failed', request: state.work.take.request, message: 'La mémoire a manqué.' });
  assert.deepEqual(ended(), [false, 'failed', null, 'La mémoire a manqué.']);
  // The Studio heard each step (it follows the take from it).
  assert.deepEqual(
    watched.map(take => [take.running, take.label, take.ended?.type ?? null]),
    [
      [false, '', null],
      [true, 'Génération · 2/8', null],
      [true, 'Génération · 2/8', null],
      [false, 'Génération · 2/8', 'done'],
      [false, '', null],
      [false, '', 'failed'],
    ],
  );
  // A creation of the Studio (its card compact) is followed by the Studio itself: nothing kept.
  const before = state.work.take;
  chatTake({ type: 'start', compact: true, request: { requestId: 'studio' } });
  chatTake({ type: 'progress', compact: true, request: { requestId: 'studio' }, text: 'Génération · 1/8', fraction: 0.1 });
  assert.equal(state.work.take, before);
  assert.equal(watched.length, 6);
});
