import test from 'node:test';
import assert from 'node:assert/strict';
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
function miniature({ storage = null } = {}) {
  const drawn = { fluxes: [], shown: [] },
    opened = [];
  const page = node('body');
  const mini = setupMiniature({
    node,
    icon: name => node('svg', 'icon-' + name),
    mark: () => node('svg', 'mark'),
    open: work => opened.push(work),
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
  return { mini, page, drawn, opened, part, said: () => part('work-mini-stage').textContent };
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
  assert.equal(said(), 'Génération annulée');

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
