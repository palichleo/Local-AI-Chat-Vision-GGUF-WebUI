import test from 'node:test';
import assert from 'node:assert/strict';
import { SUITE_NOTE, newVideoOf, remadeNote, unaskedSuite } from '../lib/unasked-suite.mjs';

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

test('the words judged are those of the request in progress: since the last creation made, and what a short answer answers (0.6.114)', () => {
  const done = { role: 'tool', tool_call_id: 'call-0', content: JSON.stringify({ status: 'success', run_id: 'r', takes: [59] }) },
    refused = { role: 'tool', tool_call_id: 'call-0', content: JSON.stringify({ status: 'denied', message: 'Refusé.' }) },
    words = content => ({ role: 'assistant', content }),
    changed = user('modifie cette prise, je veux un dézoom lent');
  // His conversation: « continue » meant the next shot of the plan, twice, each made since.
  assert.equal(asks(user('continue'), done, user('continue'), done, changed), true);
  // A suite asked, its proposal refused, then a few words more: still that suite.
  assert.equal(asks(user('prolonge la prise 59'), refused, user('avec un mouvement de caméra plus lent')), false);
  // Made since, it is a request answered: the next message stands alone.
  assert.equal(asks(user('prolonge la prise 59'), done, changed), true);
  // A creation made in the turn of the message itself takes none of its words away.
  assert.equal(asks(user('fais une vidéo puis prolonge-la'), done), false);
  assert.equal(asks(changed, done), true);
  // A result that is not read, or says nothing made, ends no request.
  assert.equal(asks(user('prolonge-la'), { role: 'tool', content: 'pas du JSON' }, user('en plus sombre, de nuit, sous la pluie')), false);
  // A few words answer what the assistant just wrote; a whole request does not.
  assert.equal(asks(done, words('Je prolonge la prise 59 de cinq secondes ?'), user('oui')), false);
  assert.equal(asks(done, words('Voici la suite proposée.'), user('ok mais plus lent')), false);
  assert.equal(asks(done, words('Le plan 3 est prêt. On continue ?'), changed), true);
  assert.equal(asks(done, words('Le plan 3 est prêt.'), user('oui')), true);
  // (Only what the assistant wrote: the result of a tool before a short message is no question.)
  const result = { role: 'tool', tool_call_id: 'call-0', content: JSON.stringify({ status: 'success', message: 'La suite est prête.' }) };
  assert.equal(asks(result, user('recommence')), true);
  // (What the application writes in the user's place stands between neither.)
  assert.equal(asks(done, words('Je prolonge ?'), { role: 'user', internal: true, content: 'Copie.' }, user('oui')), false);
  // The final version of a draft is that draft: never judged.
  const final = { id: 'call-1', type: 'function', function: { name: 'extend_video', arguments: '{"reuse_output":"x","stage":"final"}' } };
  assert.equal(unaskedSuite([user('fais la version finale')], final), false);
  assert.equal(unaskedSuite([user('fais la version finale')], { ...final, function: { name: 'extend_video', arguments: '{' } }), true);
});

test('the new video a continuation nobody asked for stands for: what its take was made with, in its roles (0.6.114)', () => {
  const roles = { source_video: { as: 'source' }, start_image: { as: 'start_image' }, end_image: { as: 'end_image' }, reference_image: { as: 'reference' } },
    taken = { start_image: {}, end_image: {}, reference: { many: true } },
    workflow = {
      id: 'w',
      parameters: { frames: { policy: 'model' }, stage: { policy: 'model' } },
      profiles: { draft: {}, final: {} },
      references: [
        { id: 'source', role: 'source_video' },
        { id: 'start', role: 'start_image' },
        { id: 'end', role: 'end_image' },
        { id: 'subject-1', role: 'reference_image' },
        { id: 'subject-2', role: 'reference_image' },
      ],
    },
    take = (references = [], parameters = {}) => ({ mediaType: 'video', parameters: { frames: 124, fps: 24, stage: 'draft', references, ...parameters } }),
    asked = { prompt: 'Un dézoom lent.', source: { output: 'clip' }, duration: 5, intention: 'Modifié' },
    of = (record, call = asked, more = {}) => newVideoOf(call, record, workflow, { roles, taken, ...more });
  // Nothing but a prompt: a video from words alone, the length and the profile of the take.
  assert.deepEqual(of(take()), {
    args: { prompt: 'Un dézoom lent.', duration: 5.17, intention: 'Modifié', workflow: 'w', stage: 'draft' },
    images: '',
    ownLength: true,
  });
  // Each image where it was: one start, one end, the references in their order; an earlier take,
  // one of another conversation, a reference of the project and the frame it was read at.
  const made = of(
    take([
      { input: 'start', output_id: 'a', output_index: 2, role: 'start_image', label: 'Prise 3' },
      { input: 'end', resource_id: 'r', frame: 'last' },
      { input: 'subject-1', output_id: 'b', output_conversation: 'c' },
      { input: 'subject-2', resource_id: 's' },
    ]),
  );
  assert.deepEqual(
    [made.args.start_image, made.args.end_image, made.args.reference, made.images],
    [{ output: 'a', index: 2 }, { resource: 'r', frame: 'last' }, [{ output: 'b', conversation: 'c' }, { resource: 's' }], 'take'],
  );
  // The images the call names are the model's choice, whatever the take had; an empty list names none.
  const named = of(take([{ input: 'start', output_id: 'a' }]), { ...asked, reference: [{ output: 'z' }] });
  assert.deepEqual([named.args.reference, named.args.start_image, named.images], [[{ output: 'z' }], undefined, 'call']);
  assert.deepEqual(of(take([{ input: 'start', output_id: 'a' }]), { ...asked, reference: [] }).args.start_image, { output: 'a' });
  // The length of the call when the user spoke of one, when the take has none, or null; never one
  // for a workflow whose clips have one length.
  assert.deepEqual([of(take(), asked, { lengthSaid: true }).args.duration, of(take(), asked, { lengthSaid: true }).ownLength], [5, false]);
  assert.deepEqual([of(take([], { frames: undefined })).args.duration, of(take([], { fps: 0 })).ownLength], [5, false]);
  assert.equal(of(take(), { prompt: 'x', duration: '5' }, { lengthSaid: true }).args.duration, null);
  const fixed = newVideoOf(asked, take(), { ...workflow, parameters: {} }, { roles, taken });
  assert.deepEqual([fixed.args.duration, fixed.ownLength, fixed.args.stage], [5, false, undefined]);
  // A profile the workflow no longer has is not asked for; an intention that is no text is left out.
  assert.equal(of(take([], { stage: 'preview' })).args.stage, undefined);
  assert.equal('intention' in of(take(), { prompt: 'x', intention: 3 }).args, false);
  // What cannot be made again so: a take that continued a clip, an image sent with a message, a
  // slot the workflow no longer has, two images for one place; no prompt; no video; no workflow.
  for (const references of [
    [{ input: 'source', output_id: 'v' }],
    [{ input: 'subject-1', image: 0 }],
    [{ input: 'gone', output_id: 'a' }],
    [{ input: 'start', output_id: 'a' }, { input: 'start', output_id: 'b' }],
  ])
    assert.equal(of(take(references)), null, JSON.stringify(references));
  for (const call of [{ ...asked, prompt: '  ' }, { ...asked, prompt: 3 }, null]) assert.equal(of(take(), call), null);
  assert.equal(of({ ...take(), mediaType: 'image' }), null);
  assert.equal(newVideoOf(asked, take(), null, { roles, taken }), null);
  assert.equal(newVideoOf(asked, null, workflow, { roles, taken }), null);
});

test('what the user reads on such a proposal says what it keeps of the take, and how to get a continuation', () => {
  const end = ' Pour une suite, utilisez « Prolonger ».',
    start = 'Votre message ne demande pas de suite : au lieu de prolonger ';
  assert.equal(remadeNote(59, { images: 'take', ownLength: true, sized: true }), start + 'la prise 59, une nouvelle vidéo est proposée, avec ses images, sa longueur et son format.' + end);
  assert.equal(remadeNote(59, { images: 'call', ownLength: true, sized: true }), start + 'la prise 59, une nouvelle vidéo est proposée, avec sa longueur et son format.' + end);
  assert.equal(remadeNote(7, { images: 'take' }), start + 'la prise 7, une nouvelle vidéo est proposée, avec ses images.' + end);
  assert.equal(remadeNote(undefined, {}), start + 'ce clip, une nouvelle vidéo est proposée.' + end);
  assert.equal(remadeNote(7.5), start + 'ce clip, une nouvelle vidéo est proposée.' + end);
});
