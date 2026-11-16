import assert from 'node:assert/strict';
import test from 'node:test';
import { proposalCard } from '../public/proposal-card.mjs';

// The proposal of Moodix in its message (direction-artistique.md, « La proposition vidéo »).
class Element {
  constructor(tag = '', className = '', text = '') {
    const classes = new Set(String(className).split(' ').filter(Boolean));
    Object.assign(this, { tag, className, textContent: text, children: [], parent: null, dataset: {}, attributes: {}, listeners: {} });
    this.classList = {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
    };
    this.style = {
      values: {},
      setProperty(name, value) {
        this.values[name] = value;
      },
    };
  }
  append(...items) {
    for (const item of items) {
      if (typeof item !== 'object') continue;
      item.parent = this;
      this.children.push(item);
    }
  }
  replaceChildren(...items) {
    this.children = [];
    this.append(...items);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  addEventListener(type, listener) {
    (this.listeners[type] ??= new Set()).add(listener);
  }
  removeEventListener(type, listener) {
    this.listeners[type]?.delete(listener);
  }
  fire(type, event = {}) {
    for (const listener of [...(this.listeners[type] ?? [])]) listener({ target: this, ...event });
  }
  contains(other) {
    return other === this || this.children.some(child => child.contains?.(other));
  }
}
const node = (...args) => new Element(...args);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const video = () => ({ mediaType: 'video', workflowName: 'LTX 2.5', requestId: 'r', approvalToken: 't', plan: { intention: 'Un plan fixe.' } });
function setup(request = video(), { delay = 60 } = {}) {
  const host = new Element('div', 'generation-grid'),
    composer = new Element('textarea'),
    controller = new AbortController(),
    revised = [];
  composer.value = '';
  const api = async (route, body) => {
    revised.push([route, body]);
    return Response.json({});
  };
  const pending = proposalCard({ host, request, signal: controller.signal, node, api, delay, composer });
  const [head] = pending.card.children,
    [title, status] = head.children,
    foot = pending.card.children[2],
    [, cancel, go] = foot.children;
  return { ...pending, host, composer, controller, title, status, cancel, go, revised };
}

test('a video proposal starts by itself after its count: « Départ dans … s », the glass of Générer filling', async () => {
  const card = setup();
  assert.equal(card.title.textContent, 'Proposition · Vidéo · LTX 2.5');
  assert.equal(card.status.textContent, 'Départ dans 1 s');
  assert.equal(card.go.classList.contains('is-counting'), true);
  assert.equal(card.go.style.values['--left'], '60ms');
  assert.equal(card.host.children.includes(card.card), true);
  assert.equal(await card.answer, 'once');
  assert.equal(card.host.children.includes(card.card), false, 'the card becomes the take: it goes');
});

test('the count pauses under the pointer and while something is written, then goes on', async () => {
  const card = setup(video(), { delay: 80 });
  card.card.fire('pointerenter');
  assert.equal(card.status.textContent, 'En pause');
  assert.equal(card.go.classList.contains('is-held'), true);
  await wait(120);
  assert.equal(card.card.parent, card.host, 'held: nothing starts');
  card.card.fire('pointerleave');
  assert.match(card.status.textContent, /^Départ dans \d s$/);
  // Something written in the message box holds it too, until the box is empty again.
  card.composer.value = 'Ciel gris';
  card.composer.fire('input');
  assert.equal(card.status.textContent, 'En pause');
  card.composer.value = '';
  card.composer.fire('input');
  assert.equal(await card.answer, 'once');
});

test('a click in the card stops the count for good: only Générer starts it', async () => {
  const card = setup(video(), { delay: 50 });
  card.card.fire('pointerdown', { target: card.title });
  assert.equal(card.status.textContent, 'En attente de votre accord');
  assert.equal(card.go.classList.contains('is-counting'), false);
  await wait(90);
  assert.equal(card.card.parent, card.host, 'nothing started by itself');
  card.go.onclick();
  assert.equal(await card.answer, 'once');
});

test('Annuler leaves « Proposition annulée. »; a new message declines it and the card goes', async () => {
  const cancelled = setup();
  cancelled.cancel.onclick();
  assert.equal(await cancelled.answer, 'deny');
  assert.deepEqual(
    cancelled.host.children.map(child => [child.className, child.textContent]),
    [['proposal-cancelled', 'Proposition annulée.']],
  );
  const declined = setup();
  declined.decline();
  assert.equal(await declined.answer, 'deny');
  assert.deepEqual(declined.host.children, [], 'Moodix answers with another card');
});

test('a sound waits for Générer, without a count; stopped, the proposal is abandoned', async () => {
  const sound = setup({ mediaType: 'audio', workflowName: 'MOSS-SFX', plan: { intention: 'Un orage.' } });
  assert.equal(sound.title.textContent, 'Proposition · Son · MOSS-SFX');
  assert.equal(sound.status.textContent, '');
  assert.equal(sound.go.classList.contains('is-counting'), false);
  sound.controller.abort(new DOMException('Arrêté', 'AbortError'));
  await assert.rejects(sound.answer, { name: 'AbortError' });
  assert.deepEqual(sound.host.children, []);
});
