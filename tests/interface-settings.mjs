import assert from 'node:assert/strict';
import test from 'node:test';
import { setupInterfaceSettings } from '../public/interface-settings.mjs';

// The Interface tab of the settings (interface-settings.mjs): the room, its light and its grain.
class Element {
  constructor(tag = 'div', className = '', text = '') {
    Object.assign(this, { tag, className, textContent: text, children: [], attributes: {}, dataset: {}, style: {}, value: '' });
    this.classList = { toggle() {} };
  }
  append(...items) {
    this.children.push(...items);
  }
  replaceChildren(...items) {
    this.children = items;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  // As in a page: the one focused is the page's active element.
  focus() {
    page.activeElement = this;
  }
}
const page = { activeElement: null };
function fixture(t) {
  const previous = globalThis.document,
    nodes = new Map(),
    $ = id => {
      if (!nodes.has(id)) nodes.set(id, new Element('div', id));
      return nodes.get(id);
    },
    applied = [];
  globalThis.document = page;
  page.activeElement = null;
  t.after(() => {
    globalThis.document = previous;
  });
  const root = { dataset: {}, style: { setProperty: (name, value) => applied.push([name, value]) } },
    ui = setupInterfaceSettings({ $, node: (...args) => new Element(...args), api: async () => Response.json({ preferences: {} }), root });
  ui.load({});
  const chosen = id => $(id).children.find(item => item.attributes['aria-checked'] === 'true')?.textContent;
  return { ui, $, root, chosen };
}

test('a choice made on the keyboard keeps the focus, on the button drawn in its place', t => {
  const { ui, $, root, chosen } = fixture(t);
  assert.equal(chosen('room-grain'), 'Poudre');
  // The choices are drawn again at each change: the button in hand was replaced, the focus fell on
  // the page, and the next key started again from the top of the settings.
  const film = $('room-grain').children[3];
  assert.equal(film.textContent, 'Film');
  film.focus();
  film.onclick();
  assert.equal(chosen('room-grain'), 'Film');
  assert.equal(root.dataset.grain, 'film');
  assert.notEqual($('room-grain').children[3], film, 'drawn again');
  assert.equal(page.activeElement, $('room-grain').children[3]);
  assert.equal(page.activeElement.textContent, 'Film');
  // A room, a filter (several may be on): the same.
  const night = $('room-choices').children[2];
  night.focus();
  night.onclick();
  assert.equal(root.dataset.room, 'nuit');
  assert.equal(page.activeElement, $('room-choices').children[2]);
  const centre = $('room-filters').children[2];
  centre.focus();
  centre.onclick();
  assert.equal(page.activeElement, $('room-filters').children[2]);
  assert.equal(page.activeElement.attributes['aria-pressed'], 'true');
  assert.equal(ui.dirty(), true);
});

test('the focus elsewhere stays where it is: the dose moved, the defaults put back', t => {
  const { $, chosen } = fixture(t);
  const dose = $('room-dose');
  dose.focus();
  dose.value = '65';
  dose.oninput();
  assert.equal($('room-dose-value').textContent, '65 %');
  assert.equal(page.activeElement, dose);
  const reset = $('room-reset');
  $('room-grain').children[4].onclick();
  reset.focus();
  reset.onclick();
  assert.equal(chosen('room-grain'), 'Poudre');
  assert.equal(page.activeElement, reset);
});
