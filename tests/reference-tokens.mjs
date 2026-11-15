import assert from 'node:assert/strict';
import test from 'node:test';
import { withReference, withoutReference } from '../public/reference-tokens.mjs';

test('a file joined to a message writes « #ref3 » where the cursor is, spaced', () => {
  assert.deepEqual(withReference('', '#ref3'), { text: '#ref3 ', caret: 6 });
  assert.deepEqual(withReference('anime', '#ref3'), { text: 'anime #ref3 ', caret: 12 });
  assert.deepEqual(withReference('anime ', '#ref3'), { text: 'anime #ref3 ', caret: 12 });
  assert.deepEqual(withReference('anime en pluie', '#ref3', 6), { text: 'anime #ref3 en pluie', caret: 12 });
  // A selection is replaced.
  assert.deepEqual(withReference('anime ceci', '#ref3', 6, 10), { text: 'anime #ref3 ', caret: 12 });
});

test('its attachment removed, « #ref3 » leaves the message, never « #ref31 »', () => {
  assert.equal(withoutReference('anime #ref3 en pluie', '#ref3'), 'anime en pluie');
  assert.equal(withoutReference('#ref3 anime', '#ref3'), 'anime');
  assert.equal(withoutReference('#ref31 et #ref3 ensemble', '#ref3'), '#ref31 et ensemble');
  assert.equal(withoutReference('rien ici', '#ref3'), 'rien ici');
});
