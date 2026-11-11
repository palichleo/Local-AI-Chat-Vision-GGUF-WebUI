import test from 'node:test';
import assert from 'node:assert/strict';
import { citedMessage, citedUnused } from '../lib/cited-resources.mjs';

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
