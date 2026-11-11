import test from 'node:test';
import assert from 'node:assert/strict';
import { callNote, spokenText } from '../public/transcript.mjs';

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
      result({ status: 'denied', message: 'L’utilisateur a refusé cette génération. Ne réessaie pas sans nouvelle demande.' }),
    ),
    'Image : génération refusée dans la fenêtre de confirmation.',
  );
  assert.equal(
    callNote(call('upscale'), result({ status: 'cancelled', message: 'L’utilisateur a arrêté cette génération…' })),
    'Agrandissement : génération arrêtée avant la fin.',
  );
  // Stopped before any result was kept, or a result that belongs to another call.
  assert.equal(callNote(call('create_audio'), undefined), 'Son : génération interrompue.');
  assert.equal(callNote(call('extend_video'), result({ status: 'success' }, 'other')), 'Suite de la vidéo : génération interrompue.');
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
