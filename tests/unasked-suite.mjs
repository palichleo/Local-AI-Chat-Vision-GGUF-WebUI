import test from 'node:test';
import assert from 'node:assert/strict';
import { SUITE_NOTE, unaskedSuite } from '../lib/unasked-suite.mjs';

const call = name => ({ id: 'call-1', type: 'function', function: { name, arguments: '{}' } });
const user = content => ({ role: 'user', content });
const told = { role: 'tool', tool_call_id: 'call-1', content: JSON.stringify({ status: 'nothing_generated', message: SUITE_NOTE }) };
const asks = (...messages) => unaskedSuite(messages, call('extend_video'));

test('a continuation the user’s message has no word of is sent back; one they ask for is not (0.6.113)', () => {
  // « Modifie cette prise, je veux un dézoom lent » (19/11): the local model called extend_video, the
  // Studio showed « Suite du clip » and the size could not be changed.
  for (const said of [
    'modifie cette prise, je veux un dézoom lent',
    'refais la prise 59 avec plus de lumière',
    'change le mouvement de caméra',
    'recommence',
    'je veux un zoom plus lent',
    'encore, mais de nuit',
    'ajoute un dézoom à la fin',
    'ensuite fais la même en plus sombre',
    'make it again with a slower zoom',
  ])
    assert.equal(asks(user(said)), true, said);
  for (const said of [
    'la suite',
    'continue',
    'Continue le clip : il se retourne vers la caméra',
    'prolonge la prise 58 de 5 secondes',
    'rallonge-la',
    'allonge ce plan',
    'fais-la plus longue',
    '5 secondes de plus',
    'enchaîne sur la galaxie',
    'poursuis la scène',
    'étends cette vidéo',
    'extend it',
    'make it longer',
    'keep going',
  ])
    assert.equal(asks(user(said)), false, said);
  // The words of a message in parts; its pictures say nothing.
  assert.equal(asks(user([{ type: 'text', text: 'modifie la' }, { type: 'image_url', image_url: { url: 'data:,' } }])), true);
  assert.equal(asks(user([{ type: 'text', text: 'prolonge' }, { type: 'text', text: 'la' }])), false);
});

test('only a continuation, only on the user’s words, and once in a turn', () => {
  const changed = user('modifie cette prise, je veux un dézoom lent');
  for (const name of ['create_video', 'create_image', 'replace_character', 'upscale', 'interpolate', 'local_read_output'])
    assert.equal(unaskedSuite([changed], call(name)), false, name);
  // No message of the user, or one without words (an image alone): not judged.
  assert.equal(asks(), false);
  assert.equal(asks({ role: 'system', content: 'Tu es un assistant.' }), false);
  assert.equal(asks(user([{ type: 'image_url', image_url: { url: 'data:,' } }])), false);
  assert.equal(asks(user('   ')), false);
  assert.equal(unaskedSuite(undefined, call('extend_video')), false);
  // What the application writes in the user's place for the model is not what the user said.
  assert.equal(asks(user('prolonge ce clip'), { role: 'user', internal: true, content: 'Copie compressée de la sortie.' }), false);
  assert.equal(asks(changed, { role: 'user', internal: true, content: 'la suite' }), true);
  // Told once since the user's message: the same call, asked again, is made.
  const calling = { role: 'assistant', content: '', tool_calls: [call('extend_video')] };
  assert.equal(asks(changed, calling, told), false);
  // Told in an earlier turn says nothing of this one.
  assert.equal(asks(changed, calling, told, { role: 'assistant', content: 'Voilà.' }, user('refais-la plus sombre')), true);
  // What it is told names the verb to call instead, and how to insist.
  assert.match(SUITE_NOTE, /^Nothing was generated: the user did not ask for a longer clip\./);
  assert.match(SUITE_NOTE, /call create_video with the whole new prompt and the same images/);
  assert.match(SUITE_NOTE, /make this same extend_video call again\.$/);
});
