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
    // (0.6.189) A list of glass, and a popover shown (above the page, as an open dialog).
    if (selector === '.glass-menu') return this.className.split(' ').includes('glass-menu');
    if (selector === ':popover-open') return this.popoverOpen === true;
    if (selector.includes(', ')) return selector.split(', ').some(part => this.is(part));
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

test('one bubble, one delay: under the pointer after 150 ms, at once on the keyboard', async () => {
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
  // Centred on it, 8 px above (16/11).
  assert.deepEqual([bubble.style.left, bubble.style.top], ['60px', '66px']);
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

// The sidebar is gone (0.6.0), and with it the bubble at the right of its folded icons: the icons
// of the top bar say their name under them, like every other.
test('the top bar: its icons say their name in the bubble, under them', () => {
  const { body } = page();
  const top = new Element('header', { id: 'top' });
  const engine = new Element('button', { className: 'engine-button', attributes: { title: 'Démarrer le modèle' }, box: { left: 1248, top: 21, right: 1278, bottom: 51 } });
  top.append(engine);
  body.append(top);
  setupHelpTips(body);
  const bubble = body.children.find(child => child.className === 'help-bubble');
  body.fire('focusin', { target: engine });
  assert.equal(bubble.hidden, false);
  assert.equal(bubble.textContent, 'Démarrer le modèle');
  assert.equal(bubble.style.top, '59px', 'no room above it: under it, 8 px below');
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

test('(0.6.155) data-tip-side="left": the bubble at the left of its control, at its height, when there is room there', () => {
  // (A choice of the menu of « Exporter », greyed: above it, its reason hid « Enregistrer ».)
  const { body } = page();
  const choice = new Element('button', { attributes: { 'data-tip': '2 prises sont encore à créer', 'data-tip-side': 'left' }, box: { left: 900, top: 140, right: 1210, bottom: 180 } });
  const edge = new Element('button', { attributes: { 'data-tip': 'Trop près du bord', 'data-tip-side': 'left' }, box: { left: 60, top: 140, right: 300, bottom: 180 } });
  body.append(choice, edge);
  setupHelpTips(body);
  const bubble = body.children.find(child => child.className === 'help-bubble');
  body.fire('focusin', { target: choice });
  assert.deepEqual([bubble.textContent, bubble.style.left, bubble.style.top], ['2 prises sont encore à créer', '772px', '147px']);
  // No room at its left: above it, as every bubble.
  body.fire('focusin', { target: edge });
  assert.deepEqual([bubble.style.left, bubble.style.top], ['120px', '106px']);
});

// (0.6.189, captures 94, 100, 101, 104) A list of glass lies above the page (a popover). Above its
// choice, the bubble of a greyed one lay over the list, under it: its reason could not be read.
function glassList(box) {
  const list = new Element('div', { className: 'glass-menu', box });
  list.popoverOpen = true;
  return list;
}

test('(0.6.189) data-tip-side="right" on a choice of a list: 8 px at the right of the list, at the height of the choice; at its left without room at its right', () => {
  const { body } = page();
  const roomy = glassList({ left: 600, top: 300, right: 800, bottom: 460 }),
    // Near the right edge of the window, as « + Ajouter » of the Bobine (104: 30 px from it).
    edge = glassList({ left: 1040, top: 300, right: 1250, bottom: 460 });
  const choice = new Element('button', { className: 'glass-menu-item is-off', attributes: { 'data-tip': 'Wan 2.2 demande une carte NVIDIA', 'data-tip-side': 'right' }, box: { left: 607, top: 380, right: 793, bottom: 416 } }),
    last = new Element('button', { className: 'glass-menu-item is-off', attributes: { 'data-tip': 'Pas dans la Bobine', 'data-tip-side': 'right' }, box: { left: 1047, top: 380, right: 1243, bottom: 416 } });
  roomy.append(choice);
  edge.append(last);
  body.append(roomy, edge);
  setupHelpTips(body);
  const bubble = body.children.find(child => child.className === 'help-bubble');
  body.fire('focusin', { target: choice });
  // 800 + 8: from the list itself, not from its choice (7 px inside it); its middle on the choice's (398).
  assert.deepEqual([bubble.textContent, bubble.style.left, bubble.style.top], ['Wan 2.2 demande une carte NVIDIA', '808px', '385px']);
  // 1250 + 8 + 120 passes the window (1280 - 8): at the left of the list, 1040 - 8 - 120.
  body.fire('focusin', { target: last });
  assert.deepEqual([bubble.textContent, bubble.style.left, bubble.style.top], ['Pas dans la Bobine', '912px', '385px']);
});

test('(0.6.189) data-tip-side="left" on a choice of a list (« Exporter », 0.6.155): 8 px at the left of the list; at its right without room at its left', () => {
  const { body } = page();
  const menu = glassList({ left: 919, top: 119, right: 1256, bottom: 254 }),
    against = glassList({ left: 20, top: 119, right: 360, bottom: 254 });
  const single = new Element('button', { className: 'glass-menu-item bobine-export-item is-off', attributes: { 'data-tip': '1 prise est encore à créer', 'data-tip-side': 'left' }, box: { left: 926, top: 126, right: 1249, bottom: 186 } }),
    near = new Element('button', { className: 'glass-menu-item is-off', attributes: { 'data-tip': 'Trop près du bord', 'data-tip-side': 'left' }, box: { left: 27, top: 126, right: 353, bottom: 186 } });
  menu.append(single);
  against.append(near);
  body.append(menu, against);
  setupHelpTips(body);
  const bubble = body.children.find(child => child.className === 'help-bubble');
  // 919 - 8 - 120 (it touched the list: 7 px from its choice, 1 px from the list); its middle at 156.
  body.fire('focusin', { target: single });
  assert.deepEqual([bubble.style.left, bubble.style.top], ['791px', '143px']);
  // 20 - 8 - 120 is out of the window: at the right of the list (above its choice, it was under the list).
  body.fire('focusin', { target: near });
  assert.deepEqual([bubble.style.left, bubble.style.top], ['368px', '143px']);
});

test('(0.6.189) no room at either side of a list: over its choice as every bubble, and in the list, above the page with it', () => {
  const { body } = page();
  const wide = glassList({ left: 100, top: 300, right: 1180, bottom: 460 });
  const choice = new Element('button', { className: 'glass-menu-item is-off', attributes: { 'data-tip': 'Indisponible ici', 'data-tip-side': 'right' }, box: { left: 107, top: 380, right: 1173, bottom: 416 } });
  wide.append(choice);
  body.append(wide);
  setupHelpTips(body);
  const bubble = body.children.find(child => child.className === 'help-bubble');
  body.fire('focusin', { target: choice });
  assert.deepEqual([bubble.style.left, bubble.style.top], ['580px', '346px']);
  // Left in the page, it was drawn under the list it lies on.
  assert.equal(bubble.parentNode, wide);
  // Hidden (a click, Échap, the focus gone), it is back in the page: a list replaces its choices as it
  // closes, and took the bubble out of the page with them.
  body.fire('pointerdown', { target: choice });
  assert.deepEqual([bubble.hidden, bubble.parentNode], [true, body]);
});

test('(0.6.189) a « ? » in a small window shown above the page (a popover): its bubble goes into it, as into a dialog', () => {
  const { body } = page();
  const small = new Element('div', { className: 'studio-piece-window' });
  small.popoverOpen = true;
  const help = new Element('span', { className: 'help-tip', attributes: { 'data-help': 'Qui remplacer : le personnage de la vidéo.' } }),
    outside = new Element('button', { attributes: { 'data-tip': 'Générer' } });
  small.append(help);
  body.append(small, outside);
  setupHelpTips(body);
  const bubble = body.children.find(child => child.className === 'help-bubble');
  body.fire('focusin', { target: help });
  assert.deepEqual([bubble.parentNode, bubble.textContent, bubble.hidden], [small, 'Qui remplacer : le personnage de la vidéo.', false]);
  // The window closed, a bubble of the page is in the page again.
  small.popoverOpen = false;
  body.fire('focusin', { target: outside });
  assert.deepEqual([bubble.parentNode, bubble.textContent], [body, 'Générer']);
});

test('(0.6.189) a browser that knows no popover still shows the bubble, in its dialog', () => {
  const { body } = page();
  const dialog = new Element('dialog', { id: 'settings' });
  dialog.open = true;
  const help = new Element('span', { attributes: { 'data-help': 'Le dossier des modèles.' } });
  // As such a browser: « :popover-open » is no selector to it.
  help.closest = function (selector) {
    if (selector.includes(':popover-open')) throw new SyntaxError(`'${selector}' is not a valid selector.`);
    return Element.prototype.closest.call(this, selector);
  };
  dialog.append(help);
  body.append(dialog);
  setupHelpTips(body);
  const bubble = body.children.find(child => child.className === 'help-bubble');
  body.fire('focusin', { target: help });
  assert.deepEqual([bubble.parentNode, bubble.textContent, bubble.hidden], [dialog, 'Le dossier des modèles.', false]);
});
