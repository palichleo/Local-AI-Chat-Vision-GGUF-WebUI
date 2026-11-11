import test from 'node:test';
import assert from 'node:assert/strict';
import { briefMessage, briefMissing } from '../lib/video-brief.mjs';

const user = content => ({ role: 'user', content });
const says = content => ({ role: 'assistant', content });
const calls = (id, name = 'create_video') => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
});
const result = (id, status) => ({ role: 'tool', tool_call_id: id, content: JSON.stringify({ status }) });
const call = (name = 'create_video', args = {}) => ({ function: { name, arguments: JSON.stringify(args) } });

test('a video is agreed on with the user before it is generated', () => {
  const asked = [user('une vidéo de la fille sur la balançoire')];
  assert.equal(briefMissing(asked, call()), true, 'first request: the model has not spoken yet');
  assert.equal(briefMissing(asked, call('extend_video')), true);
  // Told to agree first, the model cannot simply call again in the same reply.
  const told = [...asked, calls('a'), result('a', 'waiting_for_user')];
  assert.equal(briefMissing(told, call()), true);
  const plan = [...told, says('Elle pointe à droite, puis la caméra tourne vers l’escalier, 5 secondes. Go ?')];
  assert.equal(briefMissing(plan, call()), true, 'the user has not answered');
  assert.equal(briefMissing([...plan, user('go')], call()), false);
  // A model that wrote its plan by itself is not asked twice.
  assert.equal(briefMissing([...asked, says('Plan : … Go ?'), user('oui, 8 secondes')], call()), false);
  // The model is given the lengths that exist, so the one it proposes can be made.
  const told2 = briefMessage([{ name: 'LTX 2.5', min: 0.375, max: 10.04, standard: 5.04 }]);
  assert.match(told2, /five lines at most/);
  assert.match(told2, /Lengths possible: LTX 2\.5 from 0\.4 to 10 s \(usually 5 s\)\./);
  assert.doesNotMatch(briefMessage(), /Lengths possible/);
});

test('refusing a proposal keeps the agreement; a finished video ends it', () => {
  const agreed = [user('une vidéo'), says('Plan… Go ?'), user('go'), calls('a')];
  const refused = [...agreed, result('a', 'denied'), user('plutôt 3 secondes')];
  assert.equal(briefMissing(refused, call()), false, 'the same video, adjusted');
  const made = [
    ...agreed,
    result('a', 'success'),
    { role: 'user', internal: true, content: 'Voici les sorties du workflow.' },
    says('La vidéo correspond à la demande.'),
  ];
  // Looking at the result is not a plan for the next video.
  assert.equal(briefMissing(made, call()), true, 'a correction right after the review');
  assert.equal(briefMissing([...made, user('maintenant une vidéo de la mer')], call()), true);
  const next = [...made, user('maintenant une vidéo de la mer'), says('Plan… Go ?'), user('go')];
  assert.equal(briefMissing(next, call()), false);
});

test('images, buttons and promoted drafts are not asked for an agreement', () => {
  const asked = [user('une image de chat')];
  assert.equal(briefMissing(asked, call('create_image')), false);
  assert.equal(briefMissing(asked, call('upscale')), false);
  assert.equal(briefMissing([], call()), false, 'a button on an output: no conversation');
  assert.equal(briefMissing(undefined, call()), false);
  assert.equal(briefMissing(asked, call('create_video', { reuse_output: 'run', stage: 'final' })), false);
});
