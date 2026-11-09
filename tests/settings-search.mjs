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
