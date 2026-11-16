import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { setupGlassSelects } from '../public/glass-menu.mjs';

// The lists of the page (glass-menu.mjs): a `<select>` shown as a button and a menu of glass.
class Element {
  constructor(tag) {
    Object.assign(this, { tagName: tag.toUpperCase(), children: [], parent: null, attributes: {}, dataset: {}, style: {}, listeners: {}, hidden: false });
    this.className = '';
    this.classList = {
      add: name => {
        if (!this.className.split(' ').includes(name)) this.className = (this.className + ' ' + name).trim();
      },
    };
  }
  get nodeType() {
    return 1;
  }
  get ownerDocument() {
    return page;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  getAttributeNames() {
    return Object.keys(this.attributes);
  }
  hasAttribute(name) {
    return name in this.attributes;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  after(...nodes) {
    const at = this.parent.children.indexOf(this);
    for (const node of nodes) node.parent = this.parent;
    this.parent.children.splice(at + 1, 0, ...nodes);
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  matches(selector) {
    return selector === 'select' && this.tagName === 'SELECT';
  }
  querySelectorAll(selector) {
    const found = [];
    const walk = node => {
      for (const child of node.children) {
        if (selector === 'select' ? child.tagName === 'SELECT' : child.attributes.role === 'option') found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  querySelector() {
    return null;
  }
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  dispatchEvent(event) {
    for (const listener of this.listeners[event.type] ?? []) listener(event);
  }
  getBoundingClientRect() {
    return { left: 10, top: 10, right: 110, bottom: 38, width: 100, height: 28 };
  }
  focus() {}
}
class Select extends Element {
  constructor(options, value) {
    super('select');
    this.options = options.map(([key, text, disabled]) => ({ value: key, textContent: text, disabled: Boolean(disabled), dataset: {}, getAttribute: () => null }));
    this.kept = value;
    this.disabled = false;
    this.multiple = false;
    this.size = 0;
  }
  get selectedIndex() {
    return this.options.findIndex(option => option.value === this.kept);
  }
  get selectedOptions() {
    return this.options.filter(option => option.value === this.kept);
  }
}
// As the browser has them: accessors on the prototype, which the module wraps to follow a value set.
Object.defineProperty(Select.prototype, 'value', {
  configurable: true,
  get() {
    return this.kept;
  },
  set(next) {
    this.kept = String(next);
    for (const option of this.options) option.selected = option.value === this.kept;
  },
});
const observers = [];
const page = {
  defaultView: {
    HTMLSelectElement: Select,
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe(target, options) {
        Object.assign(this, { target, options });
      }
    },
    innerWidth: 1280,
    innerHeight: 800,
  },
  createElement: tag => new Element(tag),
  addEventListener() {},
  removeEventListener() {},
  activeElement: null,
};

test('a list of the system becomes a button of glass that says its choice and follows its list', () => {
  const root = new Element('div'),
    field = new Element('label'),
    select = new Select([['draft', 'Brouillon'], ['final', 'Finale'], ['x', 'Indisponible', true]], 'draft');
  root.ownerDocumentOverride = page;
  select.className = 'studio-model-pick';
  select.setAttribute('aria-label', 'Version');
  select.setAttribute('data-ai', 'model');
  field.append(select);
  root.append(field);
  setupGlassSelects(root);
  const [, face, menu] = field.children;
  assert.equal(face.tagName, 'BUTTON');
  // Its classes are the list's, with its own; never the one that hides the list.
  assert.equal(face.className, 'studio-model-pick glass-select');
  assert.equal(select.className, 'studio-model-pick glass-select-native');
  assert.equal(face.children[0].textContent, 'Brouillon');
  assert.equal(face.attributes['aria-label'], 'Version : Brouillon');
  // What the pointer of Moodix AI aims at goes to the button: the list is unseen.
  assert.equal(face.attributes['data-ai'], 'model');
  assert.equal(select.attributes['data-ai'], undefined);
  assert.equal(menu.attributes.role, 'listbox');
  assert.equal(menu.hidden, true);
  // A value set by the page is shown; a class it gains or loses too (« is-changed » in a proposal).
  select.value = 'final';
  assert.equal(face.children[0].textContent, 'Finale');
  select.className = 'studio-model-pick glass-select-native is-changed';
  const following = observers.find(observer => observer.target === select);
  assert.deepEqual(following.options.attributeFilter, ['disabled', 'class']);
  following.callback();
  assert.equal(face.className, 'studio-model-pick is-changed glass-select');
  // Open: its choices from top to bottom, the chosen one marked, one that cannot be chosen greyed.
  face.onclick();
  assert.equal(menu.hidden, false);
  assert.deepEqual(
    menu.children.map(item => [item.textContent, item.className]),
    [
      ['Brouillon', 'glass-menu-item'],
      ['Finale', 'glass-menu-item is-chosen'],
      ['Indisponible', 'glass-menu-item is-off'],
    ],
  );
  // A choice: the list takes it and says so (`change`), the menu closes.
  const changes = [];
  select.addEventListener('change', event => changes.push(event.type));
  menu.children[0].onclick();
  assert.equal(select.value, 'draft');
  assert.deepEqual(changes, ['change']);
  assert.equal(menu.hidden, true);
  assert.equal(face.children[0].textContent, 'Brouillon');
  // One that cannot be chosen changes nothing.
  face.onclick();
  menu.children[2].onclick();
  assert.equal(select.value, 'draft');
});

test('no source of the page or of the server holds a control character (an escape lost on its way into a file)', async () => {
  const folders = ['../public/', '../lib/', '../tests/', '../scripts/'];
  const files = [new URL('../server.mjs', import.meta.url)];
  for (const folder of folders)
    for (const name of await readdir(new URL(folder, import.meta.url)).catch(() => []))
      if (/\.(mjs|js|css|html)$/.test(name)) files.push(new URL(folder + name, import.meta.url));
  for (const file of files) {
    const text = await readFile(file, 'utf8'),
      // Everything under the space, but the tab and the ends of line.
      at = text.search(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
    assert.equal(at, -1, `${file.pathname.split('/').slice(-2).join('/')}: U+${text.charCodeAt(at).toString(16).padStart(4, '0')} at ${at}`);
  }
});
