import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupInterfaceSettings } from '../public/interface-settings.mjs';
import { createApplication } from '../server.mjs';

// The Interface tab of the settings (interface-settings.mjs): the room, its light and its grain.
class Element {
  constructor(tag = 'div', className = '', text = '') {
    Object.assign(this, { tag, className, textContent: text, children: [], attributes: {}, dataset: {}, style: {}, value: '' });
    // The classes it has (« is-faded » on a row that cannot be used).
    const marks = (this.marks = new Set());
    this.classList = { toggle: (name, on) => (on ? marks.add(name) : marks.delete(name)) };
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
  const sent = [],
    root = { dataset: {}, style: { setProperty: (name, value) => applied.push([name, value]) } },
    ui = setupInterfaceSettings({
      $,
      node: (...args) => new Element(...args),
      api: async (route, body) => (sent.push([route, body]), Response.json({ preferences: body ?? {} })),
      root,
    });
  ui.load({});
  const chosen = id => $(id).children.find(item => item.attributes['aria-checked'] === 'true')?.textContent;
  return { ui, $, root, chosen, sent };
}

test('Éclairage: « Lumière » is « Dernière prise » unless the user chooses « Irisée »; with it, « Sources » fades and cannot be used', async t => {
  const { ui, $, root, chosen, sent } = fixture(t);
  // Nothing saved (a first launch, or preferences of before 0.6.81): the light of the last take.
  assert.equal(chosen('room-lighting'), 'Dernière prise');
  assert.equal(root.dataset.lighting, 'prise');
  assert.equal(chosen('room-light'), 'Plusieurs sources');
  assert.equal($('room-sources').marks.has('is-faded'), false);
  assert.equal($('room-light').children.some(item => item.disabled), false);
  assert.deepEqual(
    $('room-lighting').children.map(item => [item.textContent, item.title]),
    [
      ['Dernière prise', 'La dernière prise éclaire la pièce et change avec elle'],
      ['Irisée', 'Une lumière irisée, comme le reflet d’un disque. Elle ne change pas avec les prises'],
    ],
  );
  // Chosen: on the page at once, the sources faded, out of reach of the pointer and of the keyboard.
  $('room-lighting').children[1].onclick();
  assert.equal(root.dataset.lighting, 'irisee');
  assert.equal(chosen('room-lighting'), 'Irisée');
  assert.equal($('room-sources').marks.has('is-faded'), true);
  assert.equal($('room-light').children.every(item => item.disabled), true);
  assert.equal($('room-light').attributes['aria-disabled'], 'true');
  assert.equal(chosen('room-light'), 'Plusieurs sources', 'the sources kept, for the way back');
  // Kept with the other settings of the interface.
  assert.equal(ui.dirty(), true);
  await ui.save();
  assert.deepEqual(sent.at(-1), ['preferences', { room: { room: 'salle', lighting: 'irisee', light: 'plusieurs', grain: 'poudre', dose: 40, motion: '24', filters: ['diffusion', 'lumiere'] } }]);
  assert.equal(ui.dirty(), false);
  // « Rétablir les réglages par défaut »: the light of the last take again.
  $('room-reset').onclick();
  assert.equal(root.dataset.lighting, 'prise');
  assert.equal($('room-sources').marks.has('is-faded'), false);
  // Closed without « Enregistrer »: what was kept.
  ui.revert();
  assert.equal(root.dataset.lighting, 'irisee');
});

test('the server keeps « Irisée » when it is chosen, and the light of the last take otherwise', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'moodix-lighting-'));
  t.after(() => rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  // Preferences of before, without the field.
  await writeFile(join(folder, 'preferences.json'), JSON.stringify({ theme: 'dark', saveHistory: true, room: { room: 'velours', light: 'une' } }));
  let app = await createApplication({ port: 0, dataDir: folder });
  try {
    const token = (await (await fetch(`${app.url}/api/bootstrap`)).json()).token;
    const call = async body =>
      (
        await fetch(`${app.url}/api/preferences`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json();
    assert.equal((await call({ theme: 'dark' })).preferences.room.lighting, 'prise');
    assert.equal((await call({ room: { room: 'velours', lighting: 'irisee' } })).preferences.room.lighting, 'irisee');
    assert.equal((await call({ room: { room: 'velours', lighting: 'arc-en-ciel' } })).preferences.room.lighting, 'prise');
    await call({ room: { room: 'velours', lighting: 'irisee' } });
  } finally {
    await app.close();
  }
  // Read back at the next start.
  assert.equal(JSON.parse(await readFile(join(folder, 'preferences.json'), 'utf8')).room.lighting, 'irisee');
  app = await createApplication({ port: 0, dataDir: folder });
  try {
    const { preferences } = await (await fetch(`${app.url}/api/bootstrap`)).json();
    assert.equal(preferences.room.lighting, 'irisee');
  } finally {
    await app.close();
  }
});

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
