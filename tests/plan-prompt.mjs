import test from 'node:test';
import assert from 'node:assert/strict';
import { pictureOf, planMessages, planPrompt, sameWords } from '../lib/plan-prompt.mjs';

// (0.6.146) Étape 2 du Montage, lot 4: « le modèle s'occupe de combler les trous ». What happens in a plan
// to make is written by the chat model from the pictures of that plan, in a request that does nothing
// else (as the prompt of a character put in a video): one plan at a time, never in the conversation.
const A = 'data:image/jpeg;base64,AAAA',
  B = 'data:image/jpeg;base64,BBBB';
const text = messages => messages[1].content.filter(part => part.type === 'text').map(part => part.text),
  shown = messages => messages[1].content.filter(part => part.type === 'image_url').map(part => part.image_url.url);

test('the request shows the pictures of the plan in their order, and says what each one is (0.6.146)', () => {
  // From a photo to a photo.
  let messages = planMessages({ start: A, end: B, seconds: 5, previous: 'An old fisherman mends his net.' });
  assert.deepEqual(shown(messages), [A, B]);
  assert.deepEqual(text(messages), [
    'The picture the shot starts on:',
    'The picture the shot ends on:',
    'The shot lasts 5 seconds.\nWhat happens in the shot before it, for the story to go on: An old fisherman mends his net.\nWrite the prompt now.',
  ]);
  assert.match(messages[0].content, /You are shown the picture the shot starts on, then the picture it ends on\./);
  assert.match(messages[0].content, /to go from it to the last picture/);
  // What a prompt must be is what the chat model is told for that verb (lib/tasks.json), and the answer is the prompt alone.
  assert.match(messages[0].content, /What the prompt must be: The whole clip, written for a video model/);
  assert.match(messages[0].content, /Never mention a picture, a photo, a frame or another shot\. Answer with the prompt alone/);
  // A start photo alone; an end photo alone: said as such, nothing shown of what is not there.
  messages = planMessages({ start: A, seconds: 2.04 });
  assert.deepEqual([shown(messages), text(messages)], [[A], ['The picture the shot starts on:', 'The shot lasts 2 seconds.\nWrite the prompt now.']]);
  assert.match(messages[0].content, /You are shown the picture the shot starts on\. Say what the picture shows, then what happens next/);
  messages = planMessages({ end: B, seconds: 3 });
  assert.deepEqual([shown(messages), text(messages)[0]], [[B], 'The picture the shot ends on:']);
  assert.match(messages[0].content, /a shot that ends exactly as the picture shows it/);
  // The continuation of a video: its last picture, and the words of a continuation.
  messages = planMessages({ start: A, seconds: 4, verb: 'extend_video' });
  assert.equal(text(messages)[0], 'The last picture of the shot before:');
  assert.match(messages[0].content, /the last picture of the shot before it: this shot goes on from there/);
  assert.match(messages[0].content, /What the prompt must be: What happens next, written for a video model that only sees the last frames/);
  // The standing instructions of the user come last, and win.
  assert.match(planMessages({ start: A, seconds: 5, preferences: '  Toujours en plan fixe.  ' })[0].content, /\nThe user's standing instructions, which come first where they differ: Toujours en plan fixe\.$/);
  assert.doesNotMatch(planMessages({ start: A, seconds: 5 })[0].content, /standing instructions/);
});

const answer = content => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
const LONG = 'An old fisherman sits on a wooden pier at dawn, mending a net. He slowly lifts his eyes towards the open sea while the mist rises. The camera stays still.';
function engine(reply = answer(LONG), more = {}) {
  const asked = [];
  return {
    vision: true,
    state: 'ready',
    asked,
    request: async (body, options) => {
      asked.push({ body, options });
      if (reply instanceof Error) throw reply;
      return reply;
    },
    ...more,
  };
}
// A photo of which a small picture is kept, one of which only the file is there, a video (three pictures of it).
const places = {
  conversationId: 'c1',
  thumbnails: { has: key => key === 'c1.photo.0', read: async () => Buffer.from('small') },
  outputFrames: async (conversation, run) => (run === 'clip' ? { urls: ['f1', 'f2', 'f3'], video: true } : run === 'busy' ? { urls: [], video: true } : { urls: [], video: false }),
  // (Asked for a video too, it would answer: a video is never shown by its file.)
  original: async (conversation, run, index) => (run === 'file' || run === 'busy' ? `file:${conversation}.${run}.${index}` : null),
};

test('a picture of a source: the small one kept of a photo, else its file; the last picture of a video (0.6.146)', async () => {
  assert.equal(await pictureOf({ output: 'photo' }, places), 'data:image/jpeg;base64,' + Buffer.from('small').toString('base64'));
  assert.equal(await pictureOf({ output: 'file' }, places), 'file:c1.file.0');
  // (A take of another conversation of the project is found there.)
  assert.equal(await pictureOf({ output: 'file', conversation: 'c2', index: 1 }, places), 'file:c2.file.1');
  assert.equal(await pictureOf({ output: 'clip', frame: 'last' }, places), 'f3');
  // Nothing within reach: none, never a failure.
  assert.equal(await pictureOf({ output: 'gone' }, places), '');
  assert.equal(await pictureOf({ output: 'busy', frame: 'last' }, places), '', 'a video the engine cannot read now has no file to show');
  assert.equal(await pictureOf({ output: 'file' }, { ...places, original: undefined }), '');
  assert.equal(await pictureOf({ output: 'file' }, { ...places, original: async () => { throw Error('lu trop tôt'); } }), '');
  for (const none of [undefined, null, 'x', {}]) assert.equal(await pictureOf(none, places), '');
});

test('the text of a plan is the answer of the chat model, the prompt alone; why not is said in the user’s words (0.6.146)', async () => {
  // (A model that is not the local one: it is shown what happens in the plan before.)
  const chat = engine(answer(`"${LONG}"\n`), { local: false });
  const written = await planPrompt({ start: { output: 'photo' }, end: { output: 'file' }, seconds: 5, verb: 'create_video', previous: 'Avant.', preferences: 'Court.' }, { ...places, engine: chat });
  assert.deepEqual(written, { prompt: LONG });
  const [{ body, options }] = chat.asked;
  assert.deepEqual(shown(body.messages), ['data:image/jpeg;base64,' + Buffer.from('small').toString('base64'), 'file:c1.file.0']);
  assert.match(text(body.messages).at(-1), /shot before it, for the story to go on: Avant\./);
  assert.match(body.messages[0].content, /standing instructions, which come first where they differ: Court\.$/);
  // One answer, short, without thinking aloud; held by its own time limit.
  assert.deepEqual([body.stream, body.max_tokens, body.chat_template_kwargs, options.signal instanceof AbortSignal], [false, 600, { enable_thinking: false }, true]);
  // Only one of its two pictures is within reach: written from that one.
  const half = engine();
  await planPrompt({ start: { output: 'gone' }, end: { output: 'file' }, seconds: 3, verb: 'create_video' }, { ...places, engine: half });
  assert.deepEqual([shown(half.asked[0].body.messages), text(half.asked[0].body.messages)[0]], [['file:c1.file.0'], 'The picture the shot ends on:']);
  // A chat model that does not see images, or is not ready: nothing is asked of it.
  for (const [state, reason] of [
    [{ vision: false }, 'Ce modèle de chat ne voit pas les images : écrivez vous-même ce qui se passe dans cette prise.'],
    [{ state: 'starting' }, 'Le modèle de chat n’est pas prêt.'],
  ]) {
    const blind = engine(answer(LONG), state);
    assert.deepEqual(await planPrompt({ start: { output: 'photo' }, seconds: 5, verb: 'create_video' }, { ...places, engine: blind }), { reason });
    assert.equal(blind.asked.length, 0);
  }
  // No picture within reach, a refusal, a few words for an answer.
  const none = engine();
  assert.deepEqual(await planPrompt({ start: { output: 'gone' }, seconds: 5, verb: 'create_video' }, { ...places, engine: none }), { reason: 'Les images de cette prise sont introuvables.' });
  assert.equal(none.asked.length, 0);
  assert.deepEqual(await planPrompt({ start: { output: 'photo' }, seconds: 5, verb: 'create_video' }, { ...places, engine: engine({ ok: false, status: 500 }) }), { reason: 'Le modèle de chat a refusé la demande (500).' });
  assert.deepEqual(await planPrompt({ start: { output: 'photo' }, seconds: 5, verb: 'create_video' }, { ...places, engine: engine(answer('<think>hmm</think>A man looks up.')) }), { reason: 'Le modèle de chat a répondu trop court. Réessayez.' });
  // Stopped, or too slow: thrown as the request throws it, for whoever asked to say it.
  await assert.rejects(planPrompt({ start: { output: 'photo' }, seconds: 5, verb: 'create_video' }, { ...places, engine: engine(Object.assign(Error('trop long'), { name: 'TimeoutError' })) }), { name: 'TimeoutError' });
  // Stopped by who asked: its signal is the one of the request.
  const controller = new AbortController(),
    held = engine();
  await planPrompt({ start: { output: 'photo' }, seconds: 5, verb: 'create_video' }, { ...places, engine: held, signal: controller.signal });
  controller.abort();
  assert.equal(held.asked[0].options.signal.aborted, true);
});

test('the local model is not shown the plan before, and an answer that says it again is asked once more (0.6.146)', async () => {
  // (Seen on his card, 20/11: two plans between three photos of the same man. Shown the text of the first
  // « for the story to go on », his local model gave it back word for word as the second.)
  const BEFORE = LONG,
    NEXT = 'The old fisherman lets go of the net and stands up slowly, one hand on his knee. He turns towards the boat that leaves the pier and watches it go. The camera follows him up.';
  const asking = { start: { output: 'photo' }, end: { output: 'file' }, seconds: 2, verb: 'create_video', previous: BEFORE };
  // The local model: the pictures and the length, not that text.
  let chat = engine(answer(NEXT), { local: true });
  assert.deepEqual(await planPrompt(asking, { ...places, engine: chat }), { prompt: NEXT });
  assert.deepEqual([chat.asked.length, text(chat.asked[0].body.messages).at(-1), chat.asked[0].body.temperature], [1, 'The shot lasts 2 seconds.\nWrite the prompt now.', 0.4]);
  // It says the plan before again all the same (the same pictures, nearly): asked once more for what is different.
  const replies = [answer(BEFORE), answer(NEXT)];
  chat = engine(null, { local: true, request: async (body, options) => (chat.asked.push({ body, options }), replies.shift()) });
  assert.deepEqual(await planPrompt(asking, { ...places, engine: chat }), { prompt: NEXT });
  assert.equal(chat.asked.length, 2);
  assert.match(text(chat.asked[1].body.messages).at(-1), /^The shot lasts 2 seconds\.\nAnother shot of the film shows the same people in the same place\. Say precisely what is different in this one/);
  assert.doesNotMatch(text(chat.asked[1].body.messages).at(-1), /for the story to go on/);
  assert.equal(chat.asked[1].body.temperature, 0.8);
  // A model that is not the local one is shown that text; it too is asked again when it gives it back, without it.
  const far = [answer(BEFORE.replace('at dawn', 'at sunrise')), answer(NEXT)];
  chat = engine(null, { local: false, request: async (body, options) => (chat.asked.push({ body, options }), far.shift()) });
  assert.deepEqual(await planPrompt(asking, { ...places, engine: chat }), { prompt: NEXT });
  assert.match(text(chat.asked[0].body.messages).at(-1), /for the story to go on: An old fisherman sits/);
  assert.doesNotMatch(text(chat.asked[1].body.messages).at(-1), /for the story to go on/);
  // Asked again once, never more: a second answer that fails leaves the first, one that repeats is kept as it is.
  for (const second of [{ ok: false, status: 500 }, answer('Too short.'), answer(BEFORE)]) {
    const both = [answer(BEFORE), second];
    chat = engine(null, { local: true, request: async (body, options) => (chat.asked.push({ body, options }), both.shift()) });
    assert.deepEqual(await planPrompt(asking, { ...places, engine: chat }), { prompt: BEFORE });
    assert.equal(chat.asked.length, 2);
  }
  // Nothing before it (the first plan), or another story: its answer is the text, asked once.
  chat = engine(answer(BEFORE), { local: true });
  await planPrompt({ ...asking, previous: '' }, { ...places, engine: chat });
  assert.equal(chat.asked.length, 1);
});

test('two prompts say the same thing when most runs of three words of one are in the other (0.6.146)', () => {
  const one = 'An old fisherman sits on a wooden pier at dawn, mending a net. He lifts his eyes towards the sea.';
  assert.equal(sameWords(one, one), 1);
  assert.equal(sameWords(one, '  AN OLD FISHERMAN sits on a wooden pier at dawn — mending a net! He lifts his eyes towards the sea  '), 1);
  // The same look, another action: not the same shot.
  const other = 'An old fisherman sits on a wooden pier at dawn. He stands up slowly and watches the boat leave, one hand raised.';
  assert.ok(sameWords(one, other) < 0.5, String(sameWords(one, other)));
  // One inside the other is the same; nothing in common, or nothing at all, is not.
  assert.equal(sameWords(one, one + ' The camera stays still while the mist rises over the water.'), 1);
  assert.equal(sameWords(one, 'A red car drives fast through a city at night under the rain.'), 0);
  for (const none of ['', null, undefined, 'two words']) assert.equal(sameWords(one, none), 0);
});
