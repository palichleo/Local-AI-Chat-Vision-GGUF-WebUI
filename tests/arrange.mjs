import test from 'node:test';
import assert from 'node:assert/strict';
import { arrangePlan } from '../lib/arrange.mjs';
import { arrangeMessages, retryMessage } from '../lib/arrange-prompt.mjs';
import { newMontage, validateMontage } from '../lib/montages.mjs';
import { readArrangement } from '../public/montage-arrange.mjs';

// (0.6.162) The arranger of the Bobine (claude_design/arrangeur/CONTRAT.md): the plan of a request, asked of
// the chat model in a request of its own, read, and asked again once when it cannot be read.
const C = '11111111-1111-4111-8111-111111111111',
  NOW = '2026-11-20T10:00:00.000Z',
  id = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
// An image and a video of 5 s (120 pictures at 24 a second).
const record = (n, mediaType, prompt, parameters = {}) => ({ id: id(n), conversationId: C, mediaType, prompt, parameters, outputs: [{ take: n }] });
const TAKES = [
  record(1, 'image', 'A small red rocket on a launch pad in the desert at sunrise.'),
  record(2, 'video', 'The red rocket lifts off in a burst of flame and white smoke.', { frames: 120, fps: 24 }),
];
const asking = (more = {}) => ({ montage: newMontage({ id: id(900), now: NOW }), takes: TAKES, request: 'invente la suite', ...more });

// A plan with one element that cannot be laid (said in `problems`); an answer with no plan; a plan with nothing in it.
const PLAN = JSON.stringify({
  say: 'J’ai posé deux prises qui suivent la fusée.',
  add: [
    { text: 'Une petite fusée rouge décolle du désert à l’aube.', seconds: 5, link: 'cut', start: 'prise 1', end: null },
    { text: 'La fusée rouge traverse les nuages au-dessus du désert.', seconds: 4, link: 'suite', start: null, end: null },
    { take: 'la fusée' },
  ],
});
const WORDS = 'Voici une belle idée : la fusée décolle, puis elle arrive sur la Lune.',
  NOTHING = '{"fill": [], "add": []}';
const UNREADABLE = 'Moodix AI n’a pas rendu de plan lisible.',
  UNREAD = 'Moodix AI n’a pas rendu de plan lisible. Réessayez, ou dites-le autrement.';
const read = (text, tries) => {
  const { arrangement, problems } = readArrangement(text);
  return { arrangement, problems, tries };
};

const answer = content => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
/**
 * A chat model that notes what it is asked and gives, request after request, the replies it is told: a
 * response, an error it throws, or a function of the request.
 */
function engine(replies, more = {}) {
  const asked = [],
    left = [...replies];
  return {
    state: 'ready',
    asked,
    request: async (body, options) => {
      asked.push({ body, options });
      const reply = left.shift();
      if (reply instanceof Error) throw reply;
      return typeof reply === 'function' ? reply(body, options) : reply;
    },
    ...more,
  };
}
// A request that waits for its signal: stopped, or too slow, it throws as fetch does.
const held = (body, options) =>
  new Promise((resolve, reject) => {
    if (options.signal.aborted) reject(options.signal.reason);
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });

test('a chat model that is not ready is asked nothing (0.6.162)', async () => {
  for (const state of ['starting', 'stopped', undefined]) {
    const chat = engine([answer(PLAN)], { state });
    assert.deepEqual(await arrangePlan(asking(), { engine: chat }), { reason: 'Le modèle de chat n’est pas prêt.' });
    assert.equal(chat.asked.length, 0);
  }
  for (const none of [undefined, null]) {
    assert.deepEqual(await arrangePlan(asking(), { engine: none }), { reason: 'Le modèle de chat n’est pas prêt.' });
  }
});

test('a plan read at the first answer: one request, its body as for the plan of a take, the plan as it is read (0.6.162)', async () => {
  const chat = engine([answer(PLAN)]),
    plan = await arrangePlan(asking(), { engine: chat });
  assert.deepEqual(plan, read(PLAN, 1));
  // (What the plan holds that cannot be laid is said, and the rest is kept.)
  assert.deepEqual(
    [plan.arrangement.add.length, plan.problems.length, plan.arrangement.say],
    [2, 1, 'J’ai posé deux prises qui suivent la fusée.'],
  );
  assert.equal(chat.asked.length, 1);
  const [{ body, options }] = chat.asked;
  assert.deepEqual(body, {
    messages: arrangeMessages({ ...asking(), simple: true }),
    stream: false,
    max_tokens: 1500,
    temperature: 0.6,
    reasoning_format: 'deepseek',
    chat_template_kwargs: { enable_thinking: false },
  });
  // Held by a time limit of its own when nobody else can stop it.
  assert.deepEqual([options.signal instanceof AbortSignal, options.signal.aborted], [true, false]);
});

test('the local model reads the simple form of the instructions, and is asked again in it (0.6.162)', async () => {
  // (Anything but a model said not to be the local one: true, not said, another value.)
  for (const local of [true, undefined, 'yes']) {
    const chat = engine([answer(WORDS), answer(PLAN)], { local });
    assert.equal((await arrangePlan(asking(), { engine: chat })).tries, 2);
    const [first, second] = chat.asked.map(({ body }) => body.messages);
    assert.deepEqual(first, arrangeMessages({ ...asking(), simple: true }));
    assert.doesNotMatch(first[0].content, /fill/);
    assert.deepEqual(second.at(-1), retryMessage(UNREADABLE, { simple: true }));
    assert.doesNotMatch(second.at(-1).content, /fill/);
  }
});

test('a model that is not the local one reads the whole of the instructions, and is asked again in them (0.6.162)', async () => {
  const chat = engine([answer(WORDS), answer(PLAN)], { local: false });
  assert.equal((await arrangePlan(asking(), { engine: chat })).tries, 2);
  const [first, second] = chat.asked.map(({ body }) => body.messages);
  assert.deepEqual(first, arrangeMessages({ ...asking(), simple: false }));
  assert.match(first[0].content, /fill/);
  assert.deepEqual(second.at(-1), retryMessage(UNREADABLE, { simple: false }));
  assert.match(second.at(-1).content, /fill/);
});

test('an answer that cannot be read is asked again once, with that answer and what was wrong with it (0.6.162)', async () => {
  const start = arrangeMessages({ ...asking(), simple: true });
  // Words with no plan, a plan with nothing in it, no answer at all (said as an empty one).
  for (const [reply, said] of [
    [answer(WORDS), WORDS],
    [answer(NOTHING), NOTHING],
    [{ ok: true, json: async () => ({ choices: [] }) }, ''],
  ]) {
    const chat = engine([reply, answer(PLAN)]);
    assert.deepEqual(await arrangePlan(asking(), { engine: chat }), read(PLAN, 2));
    assert.equal(chat.asked.length, 2);
    // The first request is left as it was; the second goes on from it, in this order.
    assert.deepEqual(chat.asked[0].body.messages, start);
    assert.deepEqual(chat.asked[1].body.messages, [
      ...start,
      { role: 'assistant', content: said },
      retryMessage(UNREADABLE, { simple: true }),
    ]);
    // The rest of the request is the same, but its time limit is its own.
    const rest = ({ messages, ...others }) => others;
    assert.deepEqual(rest(chat.asked[1].body), rest(chat.asked[0].body));
    assert.notEqual(chat.asked[1].options.signal, chat.asked[0].options.signal);
  }
});

test('two answers that cannot be read: two requests, never three, and what to do is said (0.6.162)', async () => {
  for (const [one, two] of [
    [WORDS, NOTHING],
    [NOTHING, WORDS],
    [WORDS, WORDS],
  ]) {
    const chat = engine([answer(one), answer(two), answer(PLAN)]);
    assert.deepEqual(await arrangePlan(asking(), { engine: chat }), { reason: UNREAD });
    assert.equal(chat.asked.length, 2);
  }
});

test('a refusal is said with its status, at the first request (not asked again) as at the second (0.6.162)', async () => {
  let chat = engine([{ ok: false, status: 503 }, answer(PLAN)]);
  assert.deepEqual(await arrangePlan(asking(), { engine: chat }), { reason: 'Le modèle de chat a refusé la demande (503).' });
  assert.equal(chat.asked.length, 1);
  chat = engine([answer(WORDS), { ok: false, status: 429 }, answer(PLAN)]);
  assert.deepEqual(await arrangePlan(asking(), { engine: chat }), { reason: 'Le modèle de chat a refusé la demande (429).' });
  assert.equal(chat.asked.length, 2);
});

test('stopped by who asked, or too slow: thrown as the request throws it, at either request (0.6.162)', async () => {
  // Stopped by who asked: its signal is in the one of the request.
  const controller = new AbortController(),
    chat = engine([held]),
    asked = arrangePlan(asking(), { engine: chat, signal: controller.signal });
  controller.abort();
  await assert.rejects(asked, { name: 'AbortError' });
  assert.equal(chat.asked.length, 1);
  // Too slow: its own time limit. (The timer of AbortSignal.timeout does not hold the process: this one does, meanwhile.)
  const awake = setTimeout(() => {}, 5000);
  try {
    await assert.rejects(arrangePlan(asking(), { engine: engine([held]), timeoutMs: 20 }), { name: 'TimeoutError' });
  } finally {
    clearTimeout(awake);
  }
  // At the second request, or while its answer is read: never taken for an answer that cannot be read.
  const stopped = Object.assign(new Error('arrêté'), { name: 'AbortError' }),
    late = Object.assign(new Error('trop long'), { name: 'TimeoutError' }),
    slow = { ok: true, json: async () => Promise.reject(late) };
  await assert.rejects(arrangePlan(asking(), { engine: engine([answer(WORDS), stopped]) }), { name: 'AbortError' });
  await assert.rejects(arrangePlan(asking(), { engine: engine([slow, answer(PLAN)]) }), { name: 'TimeoutError' });
});

test('the earlier requests, the standing instructions, the takes and their lengths reach the message of the user (0.6.162)', async () => {
  const previous = [{ request: 'crée une vidéo sur le thème de l’espace', say: 'J’ai posé quatre prises.' }],
    preferences = 'Des plans courts, en noir et blanc.',
    // The video of take 2 shown from 0 to 5 s; its length is the one given (8 s), not the one of its record (5 s).
    shown = { id: id(11), at: 0, kind: 'video', source: { conversationId: C, runId: id(2), output: 0 }, from: 0, to: 5, frame: 'fit', volume: 1 },
    montage = validateMontage({ ...newMontage({ id: id(900), now: NOW }), plans: [shown] }, { now: NOW }),
    lengthOf = () => 8,
    chat = engine([answer(PLAN)]);
  await arrangePlan(asking({ montage, lengthOf, previous, preferences }), { engine: chat });
  const [messages] = chat.asked.map(({ body }) => body.messages),
    user = messages[1].content;
  assert.deepEqual(
    messages,
    arrangeMessages({ montage, takes: TAKES, lengthOf, request: 'invente la suite', previous, preferences, simple: true }),
  );
  assert.match(user, /Earlier requests on this bobine[^]*\n- « crée une vidéo sur le thème de l’espace » You answered: « J’ai posé/);
  assert.match(user, /The user's standing instructions, which come first where they differ: Des plans courts, en noir et blanc\./);
  assert.match(user, /video prise 2, shown from 0 to 5 s of its 8 s/);
  assert.match(user, /prise 1, image: "A small red rocket/);
  assert.match(user, /« invente la suite »\nAnswer with the JSON plan only\.$/);
  // None of them: nothing said of them.
  const bare = engine([answer(PLAN)]);
  await arrangePlan(asking(), { engine: bare });
  assert.doesNotMatch(bare.asked[0].body.messages[1].content, /Earlier requests|standing instructions/);
});

test('an empty request is asked as one: go on with the film (0.6.162)', async () => {
  for (const request of ['', '   \n ', undefined]) {
    const chat = engine([answer(PLAN)]);
    assert.deepEqual(await arrangePlan(asking({ request }), { engine: chat }), read(PLAN, 1));
    assert.equal(chat.asked.length, 1);
    assert.match(chat.asked[0].body.messages[1].content, /\(no words: go on with the film\)\nAnswer with the JSON plan only\.$/);
  }
});
