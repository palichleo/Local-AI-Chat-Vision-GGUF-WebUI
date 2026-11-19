import test from 'node:test';
import assert from 'node:assert/strict';
import { setupSettingsSearch } from '../public/settings-search.mjs';
test('settings search is accent insensitive, reveals matching paths and restores collapsed state without changing values', () => {
  const details = { open: false },
    input = {
      value: '',
      addEventListener(name, fn) {
        this[name] = fn;
      },
    },
    empty = { hidden: true };
  const make = (text, detailsList = []) => ({
    textContent: text,
    hidden: false,
    dataset: {},
    closest() {
      return section;
    },
    querySelectorAll() {
      return detailsList;
    },
  });
  const a = make('Nom Chemins Projecteur de vision', [details]),
    b = make('Contexte total Sortie maximale'),
    section = {
      dataset: { settingsSection: 'Réglages' },
      querySelectorAll() {
        return [a, b];
      },
    };
  const dialog = {
    querySelectorAll(selector) {
      return selector === '[data-settings-item]' ? [a, b] : [section];
    },
  };
  const search = setupSettingsSearch({ dialog, input, empty });
  input.value = 'PROJÉCTEUR vision';
  search.refresh();
  assert.equal(a.hidden, false);
  assert.equal(b.hidden, true);
  assert.equal(details.open, true);
  assert.equal(empty.hidden, true);
  input.value = 'zzzz';
  search.refresh();
  assert.equal(section.hidden, true);
  assert.equal(empty.hidden, false);
  search.reset();
  assert.equal(details.open, false);
  assert.equal(section.hidden, false);
  assert.equal(b.hidden, false);
  assert.equal(input.value, '');
  details.open = true;
  input.value = 'vision';
  search.refresh();
  search.reset();
  assert.equal(details.open, true);
});

test('the settings found in every tab together: each line on its own, under « 2 réglages pour « lora » »', () => {
  // A small page: a block of folders (its LoRA line among others), a block of workflows, a switch.
  const element = (className, text = '', children = [], extra = {}) => {
    const classes = new Set(className.split(' ').filter(Boolean));
    const node = {
      className,
      hidden: false,
      dataset: {},
      children,
      textContent: text + ' ' + children.map(child => child.textContent).join(' '),
      classList: {
        toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
        remove: name => classes.delete(name),
        contains: name => classes.has(name),
      },
      contains: other => other === node || children.some(child => child.contains(other)),
      querySelectorAll: selector => {
        const all = children.flatMap(child => [child, ...child.querySelectorAll('*')]);
        if (selector === '*') return all;
        const names = selector.split(',').map(part => part.trim().replace(/^\./, ''));
        return all.filter(child => names.some(name => child.classList.contains(name)) || (selector === 'details' && child.details));
      },
      closest: selector => (selector === '[data-settings-section]' ? node.section : selector === '[data-settings-panel]' ? node.panel : null),
      ...extra,
    };
    return node;
  };
  const lora = element('field-group', 'LoRA'),
    vae = element('field-group', 'VAE'),
    folders = element('', '', [element('field-group', 'Dossier « models »'), vae, lora]),
    portrait = element('model-line', 'Krea portrait doux Image Vous Krea 2 · LoRA « grain doux » 0,8'),
    krea = element('model-line', 'Krea 2 Image Créer une image'),
    list = element('', '', [krea, portrait]),
    toggle = element('', 'Activer la génération locale');
  const generation = { dataset: {} },
    workflows = { dataset: {} },
    section = { dataset: { settingsSection: 'Réglages' } };
  for (const [item, panel] of [[folders, generation], [list, workflows], [toggle, generation]]) Object.assign(item, { section, panel });
  Object.assign(section, { querySelectorAll: () => [folders, list, toggle] });
  const classes = new Set(),
    dialog = {
      classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) },
      querySelectorAll: selector =>
        selector === '[data-settings-item]' ? [folders, list, toggle] : selector === '[data-settings-panel]' ? [generation, workflows] : [section],
    },
    input = { value: '', addEventListener() {} },
    empty = { hidden: true },
    title = { hidden: true, textContent: '' };
  const searched = [];
  const search = setupSettingsSearch({ dialog, input, empty, title, onRefresh: searching => searched.push(searching) });
  input.value = 'lora';
  search.refresh();
  // The LoRA line alone of its block, the workflow with a LoRA alone of the list; the switch goes.
  assert.equal(folders.hidden, false);
  assert.equal(lora.classList.contains('is-search-hidden'), false);
  assert.equal(vae.classList.contains('is-search-hidden'), true);
  assert.equal(portrait.classList.contains('is-search-hidden'), false);
  assert.equal(krea.classList.contains('is-search-hidden'), true);
  assert.equal(toggle.hidden, true);
  assert.equal(title.textContent, '2 réglages pour « lora »');
  assert.equal(title.hidden, false);
  assert.deepEqual([generation.dataset.settingsHits, workflows.dataset.settingsHits], ['1', '1']);
  assert.ok(classes.has('is-searching'));
  // Cleared: everything back, nothing left hidden by the search, no heading.
  search.reset();
  assert.equal(vae.classList.contains('is-search-hidden'), false);
  assert.equal(krea.classList.contains('is-search-hidden'), false);
  assert.equal(toggle.hidden, false);
  assert.equal(title.hidden, true);
  assert.ok(!classes.has('is-searching'));
  assert.deepEqual(searched, [true, false]);
});
