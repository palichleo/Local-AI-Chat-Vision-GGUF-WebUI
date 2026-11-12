import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { callNote, lastExchange, spokenText } from '../public/transcript.mjs';
import * as chatVideos from '../public/chat-videos.mjs';

const call = (name, id = 'c1') => ({ id, type: 'function', function: { name, arguments: '{}' } });
const result = (content, id = 'c1') => ({ role: 'tool', tool_call_id: id, content: JSON.stringify(content) });

test('a call the model wrote as text is not read back from the history', () => {
  const leaked =
    '<tool_call> <function=create_video> <parameter=prompt> A ghost ship </parameter> </function> </tool_call>';
  assert.equal(spokenText(leaked), '');
  assert.equal(spokenText('Je lance la vidéo.\n\n' + leaked), 'Je lance la vidéo.');
  assert.equal(spokenText('Voici.\n<function=create_image>{"prompt":"x"}'), 'Voici.');
  // A reply may quote the tags: only what is unmistakably a call is cut.
  const quoted = 'La balise `<tool_call>` entoure un appel.';
  assert.equal(spokenText(quoted), quoted);
  assert.equal(spokenText(''), '');
  assert.equal(spokenText(undefined), '');
});

test('a generation that left no media is told in the user’s words, not the model’s', () => {
  assert.equal(
    callNote(call('create_video'), result({ status: 'error', message: 'Génération annulée.' })),
    'Vidéo : génération non aboutie (Génération annulée).',
  );
  assert.equal(
    callNote(
      call('create_image'),
      result({
        status: 'denied',
        message: 'L’utilisateur a refusé cette génération. Ne réessaie pas sans nouvelle demande.',
      }),
    ),
    'Image : génération refusée dans la fenêtre de confirmation.',
  );
  assert.equal(
    callNote(call('upscale'), result({ status: 'cancelled', message: 'L’utilisateur a arrêté cette génération…' })),
    'Agrandissement : génération arrêtée avant la fin.',
  );
  // Stopped before any result was kept, or a result that belongs to another call.
  assert.equal(callNote(call('create_audio'), undefined), 'Son : génération interrompue.');
  assert.equal(
    callNote(call('extend_video'), result({ status: 'success' }, 'other')),
    'Suite de la vidéo : génération interrompue.',
  );
  assert.equal(callNote(call('old_verb'), result({ status: 'error' })), 'Génération : génération non aboutie.');
});

test('nothing is said of a call whose result is shown or explained right after', () => {
  // The media itself is shown.
  assert.equal(callNote(call('create_image'), result({ status: 'success', run_id: 'r1' })), '');
  // The model then says why nothing was generated, or puts its plan to the user.
  assert.equal(callNote(call('create_video'), result({ status: 'nothing_generated', message: '…' })), '');
  assert.equal(callNote(call('create_video'), result({ status: 'waiting_for_user', message: '…' })), '');
});

test('looking at an earlier creation or at a resource is one discreet line', () => {
  assert.equal(
    callNote(call('local_read_output'), result({ status: 'loaded', run_id: 'r1' })),
    'A regardé une création précédente.',
  );
  assert.equal(
    callNote(call('local_read_output'), result({ status: 'already_loaded', run_id: 'r1' })),
    'A regardé une création précédente.',
  );
  assert.equal(
    callNote(call('local_read_resource'), result({ status: 'loaded', resources: [] })),
    'A regardé une ressource de la bibliothèque.',
  );
  // A reading that showed nothing (an invalid call, a note before a generation) says nothing.
  assert.equal(callNote(call('local_read_resource'), result({ status: 'nothing_generated' })), '');
  assert.equal(callNote(call('local_read_output'), undefined), '');
});

test('the last message the user wrote can be taken back, not one the application wrote', () => {
  const user = content => ({ role: 'user', content }),
    reply = { role: 'assistant', content: 'Voici.' };
  assert.equal(lastExchange([]), -1);
  assert.equal(lastExchange([user('bonjour'), reply]), 0);
  assert.equal(lastExchange([user('un'), reply, user('deux'), reply]), 2);
  // What the model is told between two tools is not a message of the user.
  assert.equal(lastExchange([user('un'), reply, { role: 'user', internal: true, content: 'note' }]), 0);
  // A message with an image: its text parts are read.
  assert.equal(
    lastExchange([
      user([
        { type: 'text', text: 'anime-la' },
        { type: 'image_url', file: 'a.png' },
      ]),
    ]),
    0,
  );
  // The buttons under a creation write their own message: nothing to edit or to send again.
  const id = 'e7e4ac1a-2bef-4c7f-adf8-fce2835dcdd6';
  assert.equal(lastExchange([user('un'), reply, user(`Upscale de la sortie ${id}.`), reply]), -1);
  assert.equal(lastExchange([user(`Interpolation de la sortie ${id} pour une vidéo plus fluide.`)]), -1);
  // A creation of the Studio came after it: taking the message back would take that away too.
  const studio = { role: 'user', internal: true, content: 'Studio · Vidéo : un renard\n\n(Créée dans le Studio.)' };
  assert.equal(lastExchange([user('un'), reply, studio, { role: 'assistant', content: '' }]), -1);
  assert.equal(lastExchange([studio, { role: 'assistant', content: '' }, user('plus long'), reply]), 2);
});

async function page(messages, { prompt = '', busy = false } = {}) {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const fields = { prompt: { value: prompt, focus() {} }, welcome: {}, messages: { replaceChildren() {} } };
  const done = [];
  const context = {
    ...chatVideos,
    lastExchange,
    state: { messages, images: [], videos: [], status: {}, generating: busy },
    $: id => fields[id] ?? (fields[id] = { requestSubmit: () => done.push('envoi') }),
    notice: text => done.push('avis : ' + text),
    generationUI: { clear() {} },
    renderTranscript: shown => done.push('affiche ' + shown.length),
    turnActions() {},
    renderAttachments() {},
    resizePrompt() {},
    updateControls() {},
    contextMeter: { schedule() {} },
    persistConversation: async () => done.push('enregistre'),
  };
  // The function that reads a saved message back, then the one under test.
  const reader = source.indexOf('function savedUser(');
  runInNewContext(
    source.slice(reader, source.indexOf('\n}', reader) + 2) +
      source.slice(source.indexOf('async function takeBack('), source.indexOf('function assistantMessage(')) +
      ';this.takeBack=takeBack;',
    context,
  );
  return { ...context, fields, done };
}
const exchange = () => [
  { role: 'user', content: 'premier' },
  { role: 'assistant', content: 'un' },
  {
    role: 'user',
    content: [
      { type: 'text', text: 'second' },
      { type: 'image_url', file: 'a.png', view: '/a' },
    ],
  },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c', function: { name: 'create_image' } }] },
  { role: 'tool', tool_call_id: 'c', content: '{"run_id":"r"}' },
];

test('« Modifier » puts the last message back in the message box and removes its reply', async () => {
  const { state, fields, done, takeBack } = await page(exchange(), { prompt: 'déjà écrit' });
  await takeBack(false);
  assert.equal(state.messages.length, 2);
  assert.equal(fields.prompt.value, 'second\n\ndéjà écrit');
  assert.deepEqual(JSON.parse(JSON.stringify(state.images)), [
    { name: 'Image enregistrée 1', file: 'a.png', view: '/a' },
  ]);
  // Saved as a message still being written: reopened, it comes back as a draft.
  assert.equal(state.archiveSnapshot.incomplete, true);
  assert.equal(state.archiveSnapshot.messages.length, 3);
  assert.equal(state.archiveSnapshot.messages.at(-1).role, 'user');
  assert.deepEqual(done, ['affiche 2', 'enregistre']);
});

test('« Régénérer » sends the same message again, unless another one is being written', async () => {
  const again = await page(exchange());
  await again.takeBack(true);
  assert.equal(again.fields.prompt.value, 'second');
  assert.deepEqual(again.done, ['affiche 2', 'enregistre', 'envoi']);
  const writing = await page(exchange(), { prompt: 'autre chose' });
  await writing.takeBack(true);
  assert.equal(writing.state.messages.length, 5, 'nothing is removed');
  assert.equal(writing.fields.prompt.value, 'autre chose');
  assert.match(writing.done[0], /^avis : Envoyez ou effacez/);
});

test('nothing is taken back while a reply or a generation is running', async () => {
  const { state, done, takeBack } = await page(exchange(), { busy: true });
  await takeBack(true);
  assert.equal(state.messages.length, 5);
  assert.match(done[0], /^avis : Attends la fin/);
});
