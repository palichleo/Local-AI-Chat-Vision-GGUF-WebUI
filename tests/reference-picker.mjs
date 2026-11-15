import assert from 'node:assert/strict';
import test from 'node:test';
import {
  markReferences,
  narrowed,
  referenceAt,
  removedNotice,
  setupReferencePeek,
  setupReferencePicker,
} from '../public/reference-picker.mjs';

class Element {
  constructor(tag = 'div', className = '', text = '') {
    Object.assign(this, { tagName: tag.toUpperCase(), className, children: [], attributes: {}, dataset: {}, style: {}, hidden: false, listeners: {} });
    this.classList = { contains: name => this.className.split(' ').includes(name) };
    this.childNodes = [];
    if (text) this.append(text);
  }
  get textContent() {
    return this.childNodes.map(child => (child.nodeType === 3 ? child.data : child.textContent)).join('');
  }
  append(...items) {
    for (const item of items) {
      const child = typeof item === 'string' ? new Text(item) : item;
      child.parent = this;
      this.childNodes.push(child);
      if (child.nodeType === 1) this.children.push(child);
    }
  }
  replaceChildren(...items) {
    this.childNodes = [];
    this.children = [];
    this.append(...items);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  addEventListener(type, handler, capture) {
    (this.listeners[type] ??= []).push({ handler, capture });
  }
  dispatch(type, event = {}) {
    let stopped = false;
    const full = {
      preventDefault: () => (full.defaultPrevented = true),
      stopImmediatePropagation: () => (stopped = true),
      stopPropagation() {},
      ...event,
    };
    // As a browser at its target: the listeners in capture first.
    for (const { handler } of [...(this.listeners[type] ?? [])].sort((a, b) => Number(!!b.capture) - Number(!!a.capture))) {
      if (stopped) break;
      handler(full);
    }
    return full;
  }
  closest(selector) {
    let at = this;
    while (at && !(selector === '.ref-token' && at.classList?.contains('ref-token'))) at = at.parent;
    return at ?? null;
  }
  getBoundingClientRect() {
    return { left: 300, top: 400, bottom: 420, right: 340 };
  }
}
class Text {
  constructor(data) {
    this.nodeType = 3;
    this.data = data;
  }
  replaceWith(...items) {
    const siblings = this.parent.childNodes,
      at = siblings.indexOf(this);
    const nodes = items.map(item => (typeof item === 'string' ? new Text(item) : item));
    for (const child of nodes) child.parent = this.parent;
    siblings.splice(at, 1, ...nodes);
    this.parent.children = siblings.filter(child => child.nodeType === 1);
  }
}
Element.prototype.nodeType = 1;
const node = (tag, className, text) => new Element(tag, className, text);
const REFS = [
  { reference: 1, label: '#ref1', name: 'pluie.png', previewUrl: '/p/1', mime: 'image/png' },
  { reference: 2, label: '#ref2', name: 'joueur.mp4', previewUrl: '/p/2', mime: 'video/mp4' },
  { reference: 12, label: '#ref12', name: 'neige.png', previewUrl: '/p/12', mime: 'image/png' },
];

test('« # » is read where it starts a word, with the digits typed after « #ref »', () => {
  assert.deepEqual(referenceAt('anime #'), { start: 6, digits: '' });
  assert.deepEqual(referenceAt('#re'), { start: 0, digits: '' });
  assert.deepEqual(referenceAt('anime #ref1'), { start: 6, digits: '1' });
  assert.deepEqual(referenceAt('anime #ref1 sous la pluie', 11), { start: 6, digits: '1' });
  for (const text of ['anime#', '#hello', '##', 'un # ', 'C#']) assert.equal(referenceAt(text), null, text);
  assert.deepEqual(narrowed(REFS, { digits: '1' }).map(item => item.label), ['#ref1', '#ref12']);
  assert.deepEqual(narrowed(REFS, null), []);
});

test('the list of the project above the box: ↑ ↓ choose, Entrée writes, never sends; Échap closes', () => {
  const input = new Element('textarea'),
    host = new Element('form'),
    picked = [];
  let sent = 0;
  // The box's own Entrée (it sends the message), registered before the list, as in app.js.
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') sent++;
  });
  const picker = setupReferencePicker({ input, host, node, references: () => REFS, onPick: (item, typed) => picked.push([item.label, typed]) });
  const list = host.children[0];
  assert.equal(list.hidden, true);
  assert.equal(input.attributes['aria-expanded'], 'false');
  const type = value => {
    input.value = value;
    input.selectionStart = value.length;
    input.dispatch('input');
  };
  type('mets ');
  assert.equal(list.hidden, true);
  type('mets #');
  assert.equal(list.hidden, false);
  assert.equal(input.attributes['aria-expanded'], 'true');
  assert.deepEqual(list.children.map(option => option.textContent), ['#ref1pluie.png', '#ref2Vidéo · joueur.mp4', '#ref12neige.png']);
  assert.equal(list.children[0].children[0].children[0].src, '/p/1');
  assert.equal(input.attributes['aria-activedescendant'], 'ref-option-1');
  input.dispatch('keydown', { key: 'ArrowDown' });
  input.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(input.attributes['aria-activedescendant'], 'ref-option-12');
  input.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(input.attributes['aria-activedescendant'], 'ref-option-1');
  input.dispatch('keydown', { key: 'ArrowUp' });
  const enter = input.dispatch('keydown', { key: 'Enter' });
  assert.equal(enter.defaultPrevented, true);
  assert.equal(sent, 0, 'the message is not sent');
  assert.deepEqual(picked, [['#ref12', { start: 5, digits: '' }]]);
  assert.equal(list.hidden, true);
  // Narrowed by the digits typed.
  type('mets #ref1');
  assert.deepEqual(list.children.map(option => option.children[1].children[0].textContent), ['#ref1', '#ref12']);
  input.dispatch('keydown', { key: 'Escape' });
  assert.equal(list.hidden, true);
  // Closed, Entrée is the box's again.
  input.dispatch('keydown', { key: 'Enter' });
  assert.equal(sent, 1);
  // A click on a reference writes it without the box losing its focus.
  type('#');
  let prevented = false;
  list.children[1].onmousedown({ preventDefault: () => (prevented = true) });
  assert.equal(prevented, true);
  assert.equal(picked.at(-1)[0], '#ref2');
  // No reference in the project: nothing opens.
  const empty = new Element('textarea'),
    emptyHost = new Element('form');
  setupReferencePicker({ input: empty, host: emptyHost, node, references: () => [], onPick() {} });
  empty.value = '#';
  empty.selectionStart = 1;
  empty.dispatch('input');
  assert.equal(emptyHost.children[0].hidden, true);
  assert.equal(picker.isOpen(), false);
});

test('« #ref3 » in a message is marked, never inside code; under the pointer, its picture', () => {
  const body = new Element('div', 'message-body');
  const code = new Element('code', '', 'const a = "#ref1"');
  body.append('Voici #ref1 et #ref12, puis ', code, ' et #ref99.');
  markReferences(body, node);
  const marks = body.childNodes.filter(child => child.nodeType === 1 && child.classList.contains('ref-token'));
  assert.deepEqual(
    marks.map(mark => [mark.textContent, mark.dataset.ref, mark.tabIndex]),
    [
      ['#ref1', '1', 0],
      ['#ref12', '12', 0],
      ['#ref99', '99', 0],
    ],
  );
  assert.equal(body.textContent, 'Voici #ref1 et #ref12, puis const a = "#ref1" et #ref99.');
  assert.equal(code.childNodes.length, 1, 'code left as it is');
  // Marked twice: nothing more.
  markReferences(body, node);
  assert.equal(body.childNodes.filter(child => child.nodeType === 1 && child.classList.contains('ref-token')).length, 3);

  const page = { body: new Element('body'), documentElement: { clientWidth: 1280 }, addEventListener() {} };
  setupReferencePeek({ root: body, page, node, lookup: number => REFS.find(item => item.reference === number) ?? null });
  const peek = page.body.children[0];
  assert.equal(peek.attributes.role, 'tooltip');
  body.dispatch('mouseover', { target: marks[0] });
  assert.equal(peek.hidden, false);
  assert.equal(peek.children[0].src, '/p/1');
  assert.equal(peek.textContent, '#ref1 · pluie.png');
  assert.equal(marks[0].attributes['aria-describedby'], 'ref-peek');
  body.dispatch('mouseout', { target: marks[0], relatedTarget: body });
  assert.equal(peek.hidden, true);
  // Removed since, or of another project: said so.
  body.dispatch('focusin', { target: marks[2] });
  assert.equal(peek.textContent, '#ref99 · introuvable dans ce projet');
  body.dispatch('focusout', { target: marks[2] });
  assert.equal(peek.hidden, true);
});

test('references removed for room are said, by their number and name', () => {
  assert.equal(removedNotice([]), '');
  assert.equal(removedNotice([{ label: '#ref2', name: 'pluie.png' }]), 'Référence peu utilisée effacée pour faire de la place : #ref2 (pluie.png).');
  assert.equal(
    removedNotice([
      { label: '#ref2', name: 'pluie.png' },
      { label: '#ref5', name: 'joueur.png' },
    ]),
    'Références peu utilisées effacées pour faire de la place : #ref2 (pluie.png), #ref5 (joueur.png).',
  );
});
