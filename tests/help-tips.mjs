import assert from 'node:assert/strict';
import test from 'node:test';
import { setupHelpTips } from '../public/help-tips.mjs';

/** Just what the tooltip reads of the page. */
class Element {
  constructor(tag, { id = '', className = '', attributes = {}, text = '', box = { left: 100, top: 100, right: 140, bottom: 136 } } = {}) {
    Object.assign(this, { tagName: tag.toUpperCase(), id, className, children: [], dataset: {}, style: {}, hidden: false, isConnected: true, open: false, box, listeners: {}, text });
    this.attributes = { ...attributes };
    for (const [name, value] of Object.entries(attributes)) if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value;
  }
  get textContent() {
    return this.text + this.children.map(child => child.textContent).join('');
  }
  set textContent(value) {
    this.text = value;
    this.children = [];
  }
  get parentNode() {
    return this.parent ?? null;
  }
  append(...children) {
    for (const child of children) {
      child.parent?.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = this;
      this.children.push(child);
    }
  }
  hasAttribute(name) {
    return name in this.attributes;
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  addEventListener(type, handler) {
    (this.listeners[type] ??= []).push(handler);
  }
  fire(type, event) {
    for (const handler of this.listeners[type] ?? []) handler(event);
  }
  is(selector) {
    if (selector === '[data-help], [data-tip]') return Boolean(this.dataset.help || this.dataset.tip);
    if (selector === '#sidebar') return this.id === 'sidebar';
    if (selector === 'dialog[open]') return this.tagName === 'DIALOG' && this.open;
    if (selector === '.home-button, .new-chat') return /\b(home-button|new-chat)\b/.test(this.className);
    if (selector === ':focus-visible') return true;
    return false;
  }
  matches(selector) {
    return this.is(selector);
  }
  closest(selector) {
    for (let at = this; at; at = at.parent) if (at.is?.(selector)) return at;
    return null;
  }
  contains(other) {
    for (let at = other; at; at = at.parent) if (at === this) return true;
    return false;
  }
  querySelectorAll(selector) {
    assert.equal(selector, '[title]');
    return this.children.flatMap(child => [...(child.hasAttribute('title') ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  getBoundingClientRect() {
    if (this.className === 'help-bubble') return { width: 120, height: 26 };
    return { ...this.box, width: this.box.right - this.box.left, height: this.box.bottom - this.box.top };
  }
}

function page({ folded = false, wide = true } = {}) {
  const document = {
    documentElement: { dataset: folded ? { sidebar: 'collapsed' } : {} },
    defaultView: { innerWidth: 1280, innerHeight: 800, matchMedia: () => ({ matches: wide }) },
    createElement: tag => new Element(tag),
    listeners: {},
    addEventListener(type, handler) {
      (this.listeners[type] ??= []).push(handler);
    },
  };
  const body = new Element('body');
  body.ownerDocument = document;
  return { document, body };
}

test('every title becomes a tip of the one bubble; an icon alone keeps it as its name', () => {
  const { body } = page();
  const icon = new Element('button', { attributes: { title: 'Configuration' } });
  const named = new Element('button', { attributes: { title: 'Envoyer le message', 'aria-label': 'Envoyer' } });
  const worded = new Element('button', { attributes: { title: 'Générer (Ctrl+Entrée)' }, text: 'Générer' });
  const empty = new Element('button', { attributes: { title: '' } });
  body.append(icon, named, worded, empty);
  setupHelpTips(body);
  for (const element of [icon, named, worded, empty]) assert.equal(element.hasAttribute('title'), false);
  assert.deepEqual([icon.dataset.tip, icon.getAttribute('aria-label')], ['Configuration', 'Configuration']);
  assert.deepEqual([named.dataset.tip, named.getAttribute('aria-label')], ['Envoyer le message', 'Envoyer']);
  assert.deepEqual([worded.dataset.tip, worded.getAttribute('aria-label')], ['Générer (Ctrl+Entrée)', null]);
  assert.equal(empty.dataset.tip, undefined);
  // One bubble for the page.
  assert.equal(body.children.filter(child => child.className === 'help-bubble').length, 1);
});

test('one bubble, one delay: under the pointer after 300 ms, at once on the keyboard', async () => {
  const { body } = page();
  const button = new Element('button', { attributes: { title: 'Agent Moodix AI' } });
  const help = new Element('span', { className: 'help-tip', attributes: { 'data-help': 'Le contexte donné au modèle.' } });
  body.append(button, help);
  const tips = setupHelpTips(body, { delay: 20 });
  const bubble = body.children.find(child => child.className === 'help-bubble');
  body.fire('pointerover', { target: button });
  assert.equal(bubble.hidden, true, 'not at once under the pointer');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual([bubble.hidden, bubble.textContent, bubble.dataset.kind], [false, 'Agent Moodix AI', 'tip']);
  // Under it, centred on it.
  assert.deepEqual([bubble.style.left, bubble.style.top], ['60px', '142px']);
  body.fire('pointerout', { target: button, relatedTarget: body });
  assert.equal(bubble.hidden, true);
  // The keyboard: at once, and said to screen readers.
  body.fire('focusin', { target: help });
  assert.deepEqual([bubble.hidden, bubble.textContent, bubble.dataset.kind], [false, 'Le contexte donné au modèle.', 'help']);
  assert.equal(help.getAttribute('aria-describedby'), 'help-bubble');
  body.fire('focusout', {});
  assert.equal(help.getAttribute('aria-describedby'), null);
  tips.hide();
});

test('the sidebar: its lines say their name themselves, but folded, at the right of the icon', () => {
  for (const folded of [false, true]) {
    const { body } = page({ folded });
    const sidebar = new Element('aside', { id: 'sidebar' });
    const line = new Element('button', { className: 'home-button', attributes: { 'data-tip': 'Bibliothèque' }, box: { left: 12, top: 126, right: 52, bottom: 162 } });
    const engine = new Element('button', { className: 'engine-button', attributes: { title: 'Démarrer le modèle' }, box: { left: 12, top: 700, right: 52, bottom: 736 } });
    sidebar.append(line, engine);
    body.append(sidebar);
    setupHelpTips(body);
    const bubble = body.children.find(child => child.className === 'help-bubble');
    body.fire('focusin', { target: line });
    if (!folded) assert.equal(bubble.hidden, true, 'unfolded, « Bibliothèque » is written on its line');
    else {
      assert.equal(bubble.textContent, 'Bibliothèque');
      assert.deepEqual([bubble.style.left, bubble.style.top], ['62px', '131px'], 'at its right, on its middle');
    }
    body.fire('focusin', { target: engine });
    assert.equal(bubble.textContent, 'Démarrer le modèle');
  }
});

test('in an open dialog, the bubble goes into it (a dialog is above the page)', () => {
  const { body } = page();
  const dialog = new Element('dialog', { id: 'settings' });
  dialog.open = true;
  const help = new Element('span', { attributes: { 'data-help': 'Le dossier des modèles.' } });
  dialog.append(help);
  body.append(dialog);
  setupHelpTips(body);
  const bubble = body.children.find(child => child.className === 'help-bubble');
  body.fire('focusin', { target: help });
  assert.equal(bubble.parentNode, dialog);
  assert.equal(bubble.textContent, 'Le dossier des modèles.');
});
