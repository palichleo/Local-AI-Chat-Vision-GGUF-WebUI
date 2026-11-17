import test from 'node:test';
import assert from 'node:assert/strict';
import { citedImages, citedMessage, citedNote, citedSaid, citedUnused } from '../lib/cited-resources.mjs';

const girl = { id: '3c037171-3a50-48bc-9705-9bcbfb223f6a', type: 'image', reference: 5, label: 'Ref 5' },
  stairs = { id: 'a34fed7a-57f5-49cc-a0bd-7955eb05d5d2', type: 'image', reference: 6, label: 'Ref 6' },
  film = { id: 'b7d1c2e3-0000-4000-8000-000000000007', type: 'video', reference: 7, label: 'Ref 7' },
  catalog = [girl, stairs, film];
const call = (args, name = 'create_video') => ({ id: 'c1', function: { name, arguments: JSON.stringify(args) } });
const user = content => ({ role: 'user', content });
const startOnly = call({ prompt: 'the camera pans to a staircase', start_image: { resource: girl.id } });

test('an image named by its label and left out of the call is found, however the label is written', () => {
  for (const text of [
    'non tu n’as pas utilisé la ref6 de l’escalier qui monte dans le ciel,',
    'utilise Ref 6 pour la fin',
    'avec la référence n°6',
    [{ type: 'text', text: 'prends la REF #6' }],
  ])
    assert.deepEqual(citedUnused([user(text)], catalog, startOnly), [stairs], JSON.stringify(text));
  // Passed in any role: nothing to say.
  for (const args of [
    { prompt: 'x', start_image: { resource: girl.id }, end_image: { resource: stairs.id } },
    { prompt: 'x', reference: [{ resource: stairs.id }] },
  ])
    assert.deepEqual(citedUnused([user('avec la ref6')], catalog, call(args)), []);
  assert.deepEqual(citedUnused([user('refs 5 puis ref 6')], catalog, call({ prompt: 'x' })), [girl, stairs]);
});

test('only the last request counts, only images, only generations, and only once', () => {
  const earlier = [user('avec la ref6'), { role: 'assistant', content: 'voilà' }, user('une autre, plus sombre')];
  assert.deepEqual(citedUnused(earlier, catalog, startOnly), []);
  // No label, a label that names nothing active, a video, a word that only looks like one.
  for (const text of ['la fille puis l’escalier', 'la ref 12', 'la ref7', 'préfère 6 secondes, référendum 6'])
    assert.deepEqual(citedUnused([user(text)], catalog, startOnly), [], text);
  assert.deepEqual(citedUnused([user('upscale la ref6')], catalog, call({ source: { output: 'x' } }, 'upscale')), []);

  const message = citedMessage([stairs]);
  assert.match(message, /Ref 6 \(\{"resource": "a34fed7a-57f5-49cc-a0bd-7955eb05d5d2"\}\)/);
  assert.match(message, /image de fin, référence ou image de départ/);
  // The refusal is in the conversation as the tool's answer: the model's next call stands.
  const told = [
    user('avec la ref6'),
    { role: 'assistant', content: '', tool_calls: [startOnly] },
    { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ status: 'error', message }) },
  ];
  assert.deepEqual(citedUnused(told, catalog, startOnly), []);
  assert.deepEqual(citedUnused([], catalog, startOnly), []);
});

test('a continuation is not asked before its routing: which workflow continues decides', () => {
  // Left to the proposal (lib/tool-runtime.mjs): LTX 2.5 continues a clip without any image, and a
  // model told to pass one there was sent to another model, or to an error.
  const messages = [user('Prolonge #ref7 avec un cut final sur #ref6')],
    args = { prompt: 'A distant staircase', source: { resource: film.id } };
  assert.deepEqual(citedUnused(messages, catalog, call(args, 'extend_video')), []);
  assert.deepEqual(citedImages(messages, catalog), [stairs], 'the images named, the video is not one');
  assert.deepEqual(citedImages([user('sans rien citer')], catalog), []);
  assert.deepEqual(citedImages(undefined, catalog), []);
  assert.equal(citedSaid(messages), false);
  const told = [
    ...messages,
    { role: 'assistant', content: '', tool_calls: [call(args, 'extend_video')] },
    { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ status: 'error', message: citedMessage([stairs]) }) },
  ];
  assert.equal(citedSaid(told), true);
  assert.equal(citedSaid([...told, user('et la ref6 ?')]), false, 'a new request: said again if need be');
  // The roles its workflow has a place left in, each with its argument.
  assert.match(citedMessage([stairs], ['reference']), /convient à sa demande \(référence : reference\)\.$/);
  assert.match(
    citedMessage([stairs], ['start_image', 'end_image', 'reference']),
    /\(image de départ : start_image, image de fin : end_image ou référence : reference\)\.$/,
  );
});

test('what the user reads on a proposal that leaves out an image they named', () => {
  const ref2 = { id: stairs.id, label: '#ref2' },
    ref3 = { id: girl.id, label: '#ref3' };
  // The continuation of a video by a model that takes no image with it, another one that would.
  assert.equal(
    citedNote([ref2], { workflow: 'LTX 2.5', none: true, other: 'MiniMax H3 Omni', continues: true }),
    '#ref2 n’est pas transmise : LTX 2.5 ne prend pas d’image pour la suite d’une vidéo. ' +
      'Le générateur ne la verra pas, seul le prompt peut la décrire. MiniMax H3 Omni peut la recevoir.',
  );
  assert.equal(
    citedNote([ref2], { workflow: 'MOSS Image', none: true }),
    '#ref2 n’est pas transmise : MOSS Image ne prend pas d’image. Le générateur ne la verra pas, seul le prompt peut la décrire.',
  );
  // Its places taken by other images.
  assert.equal(
    citedNote([ref2, ref3], { workflow: 'MiniMax H3 Omni' }),
    '#ref2 et #ref3 ne sont pas transmises : MiniMax H3 Omni n’a pas de place pour elles avec les autres entrées. ' +
      'Le générateur ne les verra pas, seul le prompt peut les décrire.',
  );
  // A place was left and the model, told, kept its call: no reason to give, no other model to name.
  assert.equal(
    citedNote([ref2], { workflow: 'Krea 2', here: ['reference'], other: 'Autre' }),
    '#ref2 n’est pas transmise. Le générateur ne la verra pas, seul le prompt peut la décrire.',
  );
});

test('an image shown to the model in the user’s name is not what the user wrote', () => {
  // The page adds it (internal) when the model reads a reference: it carries that reference’s label.
  const shown = { role: 'user', internal: true, content: [{ type: 'text', text: 'Référence visuelle {"label":"#ref6","name":"escalier.png"}' }] },
    messages = [user('une vidéo qui part de la ref5 et finit sur la ref6'), { role: 'assistant', content: '', tool_calls: [startOnly] }, { role: 'tool', tool_call_id: 'c1', content: '{"status":"resource_loaded"}' }, shown];
  // Both images named are still looked for: the one left out is found.
  assert.deepEqual(citedImages(messages, catalog), [girl, stairs]);
  assert.deepEqual(citedUnused(messages, catalog, startOnly), [stairs]);
  // Said once, even when an image is shown after it.
  const told = [
    user('avec la ref6'),
    { role: 'assistant', content: '', tool_calls: [startOnly] },
    { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ status: 'error', message: citedMessage([stairs]) }) },
    shown,
  ];
  assert.equal(citedSaid(told), true);
  assert.deepEqual(citedUnused(told, catalog, startOnly), []);
});
