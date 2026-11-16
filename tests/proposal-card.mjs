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
function setup(request = video(), { delay = 60, takes = null, importImage = null, answer = () => ({}) } = {}) {
  const host = new Element('div', 'generation-grid'),
    composer = new Element('textarea'),
    controller = new AbortController(),
    revised = [];
  composer.value = '';
  const api = async (route, body) => {
    revised.push([route, body]);
    return Response.json(answer(route, body));
  };
  const pending = proposalCard({ host, request, signal: controller.signal, node, api, delay, composer, takes, importImage });
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

/** Every element under `root` (the fake document has no querySelector). */
const under = root => [root, ...root.children.flatMap(child => under(child))];
const withInputs = () => ({
  ...video(),
  inputRoles: ['start_image', 'end_image', 'reference', 'reference'],
  plan: {
    intention: 'Un plan fixe.',
    prompt: 'Un phare sous la pluie.',
    references: [{ role: 'start_image', preview: '/d.png', label: 'Prise 3' }],
    editable: { prompt: true },
  },
});

test('« + » opens « Créations du projet » in the card; the image taken goes in its case, no message', async () => {
  const takes = async () => [
    { id: 'run-image', conversationId: 'other', prompt: 'Une falaise', outputs: [{ take: 7, thumbUrl: '/t7.webp' }] },
    { id: 'run-video', mediaType: 'video', outputs: [{ take: 8 }] },
  ];
  const card = setup(withInputs(), {
    delay: 5000,
    takes,
    answer: route => (route === 'tools/revise' ? { approvalToken: 't2' } : {}),
  });
  const [, body] = card.card.children,
    media = body.children.find(child => child.className === 'proposal-media'),
    shelf = body.children.find(child => child.className === 'proposal-shelf');
  assert.equal(shelf.hidden, true, 'closed until a « + » is clicked');
  const empty = under(media).filter(item => item.className.startsWith('proposal-input is-empty'));
  assert.deepEqual(empty.map(item => item.attributes['data-role']), ['end_image', 'reference']);
  const [plusEnd] = empty[0].children;
  assert.equal(plusEnd.disabled, false);
  assert.equal(plusEnd.attributes['aria-label'], 'Ajouter une image de fin');
  plusEnd.onclick();
  await wait(0);
  assert.equal(shelf.hidden, false);
  assert.match(card.status.textContent, /^Départ dans 5/, 'opening it is not an answer');
  const [head, row] = shelf.children;
  assert.equal(head.textContent, 'Créations du projet');
  const picks = row.children.filter(item => item.className === 'proposal-shelf-pick');
  assert.equal(picks.length, 1, 'the images only');
  assert.equal(picks[0].title, 'Prise 7');
  assert.equal(picks[0].children[0].src, '/t7.webp');
  // The prompt changed in the card goes with the image: the card is drawn again from the answer.
  const prompt = under(card.card).find(item => item.className === 'proposal-prompt');
  prompt.value = 'Un phare sous la neige.';
  picks[0].onclick();
  await wait(0);
  const [route, sent] = card.revised.at(-1);
  assert.equal(route, 'tools/revise');
  assert.deepEqual(sent.edits.add, { role: 'end_image', source: { output: 'run-image', conversation: 'other' } });
  assert.equal(sent.edits.prompt, 'Un phare sous la neige.');
  assert.equal(card.status.textContent, 'En attente de votre accord', 'an image put in a case stops the count');
  assert.equal(card.card.parent, card.host, 'no message: the card stays');
  card.cancel.onclick();
  assert.equal(await card.answer, 'deny');
});

test('an image dropped or pasted on the card is kept in the project, then goes in its case', async () => {
  const kept = [];
  const card = setup(withInputs(), {
    delay: 5000,
    importImage: async file => {
      kept.push(file.name);
      return { id: 'res-' + kept.length };
    },
  });
  const file = { name: 'falaise.png', type: 'image/png' };
  card.card.fire('dragover', { dataTransfer: { types: ['Files'] }, preventDefault() {} });
  assert.equal(card.card.classList.contains('is-dropping'), true, 'the empty cases light up');
  card.card.fire('drop', { dataTransfer: { files: [file] }, preventDefault() {} });
  assert.equal(card.card.classList.contains('is-dropping'), false);
  await wait(0);
  assert.deepEqual(kept, ['falaise.png']);
  assert.deepEqual(card.revised.at(-1)[1].edits.add, { role: 'end_image', source: { resource: 'res-1' } });
  // Pasted: the same way; a text pasted is left to the field.
  card.card.fire('paste', { clipboardData: { files: [] }, preventDefault: () => assert.fail('a text is not taken') });
  card.card.fire('paste', { clipboardData: { files: [{ name: 'image.webp', type: 'image/webp' }] }, preventDefault() {} });
  await wait(0);
  assert.deepEqual(kept, ['falaise.png', 'image.webp']);
  // Neither a video nor a GIF goes in a case of images.
  card.card.fire('drop', { dataTransfer: { files: [{ name: 'clip.mp4', type: 'video/mp4' }] }, preventDefault() {} });
  await wait(0);
  assert.equal(kept.length, 2);
  card.cancel.onclick();
  assert.equal(await card.answer, 'deny');
});
