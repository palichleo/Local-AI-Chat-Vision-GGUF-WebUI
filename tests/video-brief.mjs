import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { briefMissing, cardBrief, studioBrief } from '../lib/video-brief.mjs';
import { UNANSWERED } from '../public/transcript.mjs';

const user = content => ({ role: 'user', content });
const says = content => ({ role: 'assistant', content });
// The video Moodix proposes in these conversations, and the same with one thing changed.
const SWING = { prompt: 'A girl on a swing points to the right.', duration: 5, start_image: { output: 'run-1' } };
const calls = (id, name = 'create_video', args = SWING, more = {}) => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  ...more,
});
// Its words written, its card or the Studio came next (`planned`, set by the page).
const planned = (id, name, args) => calls(id, name, args, { content: 'Elle pointe à droite. Cela vous convient ?', planned: true });
const result = (id, status, more = {}) => ({ role: 'tool', tool_call_id: id, content: JSON.stringify({ status, ...more }) });
const call = (name = 'create_video', args = SWING) => ({ function: { name, arguments: JSON.stringify(args) } });

test('a video is put to the user with the words of Moodix, and waits, unless this same proposal comes back after their answer', () => {
  const asked = [user('une vidéo de la fille sur la balançoire')];
  assert.equal(briefMissing(asked, call()), true, 'first call: nothing was shown yet');
  assert.equal(briefMissing(asked, call('extend_video')), true);
  // A character put in a video is not put in words: the application writes its prompt and the user
  // confirms in the window (the plan of the chat model varied from one try to the next).
  assert.equal(briefMissing(asked, call('replace_character')), false);
  // Once made, it is a video like the others: the next clip is put to the user anew.
  const replaced = [
    ...asked,
    calls('r', 'replace_character'),
    result('r', 'success'),
    user('maintenant une vidéo du verger'),
  ];
  assert.equal(briefMissing(replaced, call()), true);
  // Shown with its words (its card, or the Studio), it waits: no answer of the user yet.
  const shown = [...asked, planned('a'), result('a', 'denied')];
  assert.equal(briefMissing(shown, call()), true, 'the user has not written since');
  // They answer in words (the proposal that waited is declined by their message) and the model
  // sends its call again, the same: it was seen, and may start as the settings say.
  const answered = [...shown, user('go')];
  assert.equal(briefMissing(answered, call()), false);
  // The same values in another order of their keys are the same call.
  assert.equal(briefMissing(answered, call('create_video', { start_image: { output: 'run-1' }, duration: 5, prompt: SWING.prompt })), false);
  // Anything changed after their answer is a proposal they have not seen: its prompt, its length,
  // its images, its verb, an argument more or less.
  for (const [what, changed] of [
    ['prompt', { ...SWING, prompt: 'A girl on a swing points to the left.' }],
    ['duration', { ...SWING, duration: 8 }],
    ['input', { ...SWING, start_image: { output: 'run-2' } }],
    ['one input more', { ...SWING, end_image: { output: 'run-2' } }],
    ['one input less', { prompt: SWING.prompt, duration: 5 }],
    ['an input in a list', { ...SWING, reference: [{ output: 'run-1' }] }],
  ])
    assert.equal(briefMissing(answered, call('create_video', changed)), true, what);
  assert.equal(briefMissing(answered, call('extend_video')), true, 'another verb');
  // The order of a list counts (the first image of a list is not the second).
  const listed = { prompt: 'p', reference: [{ output: 'a' }, { output: 'b' }] };
  const two = [...asked, planned('l', 'create_video', listed), result('l', 'denied'), user('go')];
  assert.equal(briefMissing(two, call('create_video', listed)), false);
  assert.equal(briefMissing(two, call('create_video', { ...listed, reference: [{ output: 'b' }, { output: 'a' }] })), true);
  // Arguments that cannot be read are no proposal seen.
  assert.equal(briefMissing(answered, { function: { name: 'create_video', arguments: '{"prompt":' } }), true);
  const unread = [...asked, { ...planned('u'), tool_calls: [{ id: 'u', type: 'function', function: { name: 'create_video', arguments: 'pas du JSON' } }] }, result('u', 'denied'), user('go')];
  assert.equal(briefMissing(unread, call()), true);
  // (17/11) The model wrote a plan in plain text and the user answered: its first call is still a
  // proposal nobody saw. It started by itself in the Studio.
  assert.equal(briefMissing([...asked, says('Plan : … Go ?'), user('oui, 8 secondes')], call()), true);
  assert.equal(
    briefMissing([...asked, says('On prolonge la prise 3 ?'), user('Non, je veux refaire une vidéo, pas prolonger')], call()),
    true,
  );
});

test('what became of a proposal says whether the user saw it', () => {
  const asked = [user('une vidéo de la fille sur la balançoire')],
    after = (calling, ...results) => briefMissing([...asked, calling, ...results, user('go')], call());
  // Declined (« Annuler » of its card, « Refuser » in the Studio, a new message), with or without its words.
  assert.equal(after(calls('a'), result('a', 'denied')), false);
  assert.equal(after(calls('a'), result('a', 'denied', { cancelled: 'card' })), false);
  // Left without an answer: the page closed on its card (public/transcript.mjs, closedCalls).
  assert.equal(after(calls('a'), result('a', 'cancelled', { unanswered: true, message: UNANSWERED })), false);
  assert.equal(after(calls('a')), false, 'a call left without its result is given that one');
  // A conversation of before, in the Studio: the plan asked in words, then the « go » of the user.
  assert.equal(after(calls('a'), result('a', 'waiting_for_user'), says('Elle pointe à droite. Go ?')), false);
  // Shown with its words, approved, then stopped or failed: it was seen.
  assert.equal(after(planned('a'), result('a', 'cancelled')), false);
  assert.equal(after(planned('a'), result('a', 'error', { message: 'Mémoire vidéo insuffisante.' })), false);
  // Sent back by the application before anything was shown: a prompt too thin, images to look at
  // first, arguments refused, a reply stopped while Moodix wrote its words (no `planned` then).
  assert.equal(after(calls('a'), result('a', 'nothing_generated')), true);
  assert.equal(after(calls('a'), result('a', 'error', { message: 'La prise 99 n’existe pas dans ce projet.' })), true);
  assert.equal(after(calls('a'), result('a', 'cancelled', { message: 'La réponse a été interrompue avant que cette proposition soit montrée à l’utilisateur.' })), true);
  assert.equal(after({ ...calls('a'), content: 'Elle pointe', planned: undefined }, result('a', 'cancelled')), true);
  assert.equal(after(calls('a'), result('a', 'missing_file')), true);
  // The answer of the user comes after the proposal, not before it; what the application writes
  // for the model (`internal`) is not their answer.
  assert.equal(briefMissing([...asked, planned('a'), result('a', 'denied'), { role: 'user', internal: true, content: 'Copies.' }], call()), true);
});

test('a finished video ends it: the next one is put to the user anew', () => {
  const agreed = [user('une vidéo'), planned('a'), result('a', 'denied'), user('go'), calls('b')];
  const made = [
    ...agreed,
    result('b', 'success'),
    { role: 'user', internal: true, content: 'Voici les sorties du workflow.' },
    says('La vidéo correspond à la demande.'),
  ];
  // The very call that was made, asked again: a video the user has not been shown as a proposal.
  assert.equal(briefMissing(made, call()), true, 'a correction right after the review');
  assert.equal(briefMissing([...made, user('la même, encore')], call()), true);
  assert.equal(briefMissing([...made, user('maintenant une vidéo de la mer')], call('create_video', { prompt: 'The sea.' })), true);
  // And shown in its turn, then answered, it comes back alone.
  const next = [...made, user('la même, encore'), planned('c'), result('c', 'denied'), user('go')];
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

test('what Moodix is told for its words: over a card in the Chat, before the Studio is set in the Studio, and short', () => {
  const note = cardBrief();
  assert.match(note, /Nothing is generated yet/);
  assert.match(note, /a card shows this proposal/);
  assert.match(note, /« Générer » and « Annuler »/);
  assert.match(note, /Never say the video is ready, made or sent/);
  // In the Studio there is no card: the Studio shows the proposal, with its own buttons.
  const studio = studioBrief();
  assert.match(studio, /Nothing is generated yet/);
  assert.match(studio, /The Studio now shows this proposal to the user \(its length, its format, its prompt, its images\)/);
  assert.match(studio, /« Générer » and « Refuser »/);
  assert.doesNotMatch(studio, /card|Annuler/);
  assert.match(studio, /two to four plain sentences/);
  assert.match(studio, /Never say the video is ready, made or sent/);
  // No plan to agree on in words, no « go » to ask for (the note of before: about a thousand characters).
  for (const text of [note, studio]) {
    assert.doesNotMatch(text, /their go|questions|five lines/);
    assert.ok(text.length < 600, 'the chat model follows a long note badly');
  }
  assert.ok(Math.abs(studio.length - note.length) < 40, 'the same length');
});

test('the server sends both notes with a proposal to put in words, in the wording of the model, and the page picks its own', async () => {
  // (Read in the source: no test runs a video proposal through /api/chat.)
  const read = async name => (await readFile(new URL(name, import.meta.url), 'utf8')).replace(/\r\n/g, '\n'),
    server = await read('../server.mjs'),
    page = await read('../public/app.js');
  // (The small local model keeps the agreement in words its tools tell it to get: `talked`.)
  assert.match(server, /const capable = wordingOf\(chat\.connection\) === CAPABLE;\n\s+if \(request && !request\.missing && briefMissing\(body\.messages, call, \{ talked: !capable \}\)\) \{\n\s+request\.brief = true;\n\s+request\.cardBrief = capable \? CAPABLE_CARD : cardBrief\(\);\n\s+request\.studioBrief = capable \? CAPABLE_STUDIO : studioBrief\(\);/);
  // (Set in the Studio of the conversation of the turn only, `talkId`: 0.6.81.)
  assert.match(page, /const note = setInStudio\(request, talkId\) \? request\.studioBrief : request\.cardBrief;/);
  // The long plan of before (« ask for their go ») is told by nobody any more.
  for (const source of [server, page]) assert.doesNotMatch(source, /briefMessage|kind: 'brief'|kind === 'brief'/);
});

test('the small local model: a plan it wrote in words and the user answered is the agreement it is told to get', () => {
  const call = { id: 'c1', type: 'function', function: { name: 'create_video', arguments: '{"prompt":"A boat.","duration":5}' } };
  const talk = [
    { role: 'user', content: 'Une vidéo du bateau' },
    { role: 'assistant', content: 'Le bateau quitte le port, cinq secondes. Cela vous convient ?' },
    { role: 'user', content: 'go' },
  ];
  // A large model has no such consigne: its first call is a proposal nobody has seen.
  assert.equal(briefMissing(talk, call), true);
  assert.equal(briefMissing(talk, call, { talked: true }), false);
  // Its plan not answered yet, or no plan at all: put to the user with its words, as for any model.
  assert.equal(briefMissing(talk.slice(0, 2), call, { talked: true }), true);
  assert.equal(briefMissing(talk.slice(0, 1), call, { talked: true }), true);
  // A plan from before the last video made is not one for the next.
  const made = [
    ...talk,
    { role: 'assistant', content: '', tool_calls: [call] },
    { role: 'tool', tool_call_id: 'c1', content: '{"status":"success","run_id":"r"}' },
    { role: 'user', content: 'Une autre, de nuit' },
  ];
  assert.equal(briefMissing(made, { ...call, id: 'c2' }, { talked: true }), true);
});
