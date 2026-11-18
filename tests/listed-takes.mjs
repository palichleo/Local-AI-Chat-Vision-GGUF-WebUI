import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LISTED, TAKES_LISTED, listedSources } from '../lib/listed-takes.mjs';
import { ToolCatalog } from '../lib/tool-catalog.mjs';
import { outputToolFor } from '../lib/output-tools.mjs';

/**
 * (0.6.100) What the tools of the local model list of the earlier creations: the latest of each kind,
 * those the last exchange and the user's message name, what they were made from; never every creation
 * made since the conversation began (41 000 characters of tools after 40 of them, 18/11).
 */
const uid = n => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** `count` creations, a video every fourth, numbered 1 to `count`; the newest first, as the gallery lists them. */
function session(count, { first = 1 } = {}) {
  const runs = Array.from({ length: count }, (_, i) => ({
    id: uid(first + i),
    mediaType: i % 4 === 3 ? 'video' : 'image',
    outputs: [{ take: first + i }],
    parameters: {},
  })).reverse();
  const takes = [...runs].reverse().map(run => ({ take: run.outputs[0].take, id: run.id, index: 0, mediaType: run.mediaType }));
  return { runs, takes };
}
const user = content => ({ role: 'user', content });
const numbers = list => list.map(item => item.take ?? item.outputs[0].take);

test('the latest creations of each kind are listed, in the order they had; a short conversation keeps them all', () => {
  const { runs, takes } = session(200),
    listed = listedSources({ runs, takes, messages: [user('Une autre image, plus sombre.')] });
  const latest = (list, size) => [
    ...list.filter(item => item.mediaType === 'image').slice(-size),
    ...list.filter(item => item.mediaType === 'video').slice(-size),
  ];
  // By their run_id: the eight latest images and videos, the newest first.
  const shown = new Set(latest([...runs].reverse(), LISTED));
  assert.deepEqual(listed.runs, runs.filter(run => shown.has(run)));
  assert.equal(listed.runs.length, 2 * LISTED);
  // By their number, which costs a few characters: the 32 latest of each kind, in their order.
  const counted = new Set(latest(takes, TAKES_LISTED));
  assert.deepEqual(listed.takes, takes.filter(take => counted.has(take)));
  assert.equal(listed.takes.length, 2 * TAKES_LISTED);
  for (const number of numbers(listed.runs)) assert.ok(numbers(listed.takes).includes(number));
  // As many as there are, or fewer: the same lists, the same order (what the local model was given).
  const few = session(LISTED);
  assert.deepEqual(listedSources({ ...few, messages: [user('Encore une.')] }), few);
  assert.deepEqual(listedSources({ ...few }), few);
  const more = session(TAKES_LISTED);
  assert.deepEqual(listedSources({ ...more }).takes, more.takes);
});

test('an older creation named by its number, on the screen of the Studio, or written in the last exchange is listed', () => {
  const { runs, takes } = session(200);
  // « la prise 3 », « prises 10 à 12 »: as the replies of Moodix are read (public/cited-takes.mjs).
  let listed = listedSources({ runs, takes, messages: [user('Anime la prise 3, puis agrandis les prises 10 à 12.')] });
  for (const number of [3, 10, 11, 12]) {
    assert.ok(numbers(listed.runs).includes(number), `run of take ${number}`);
    assert.ok(numbers(listed.takes).includes(number), `take ${number}`);
  }
  // A number that only counts (« 4 secondes ») names no take.
  listed = listedSources({ runs, takes, messages: [user('Une vidéo de 4 secondes.')] });
  assert.equal(numbers(listed.takes).includes(4), false);
  // The take on the screen of the Studio.
  listed = listedSources({ runs, takes, messages: [user('Anime celle-ci.')], screen: { take: 7, media: 'image' } });
  assert.ok(numbers(listed.runs).includes(7) && numbers(listed.takes).includes(7));
  // What the last exchange wrote: a series made then (its result), a source in a call of this turn.
  const series = [20, 21, 22].map(uid);
  const messages = [
    user('Fais trois images de chats.'),
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'create_image', arguments: '{"prompt":"A cat."}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ status: 'success', images: series.map(run_id => ({ run_id })) }) },
    user('Agrandis la deuxième.'),
    { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'upscale', arguments: JSON.stringify({ source: { output: uid(30) } }) } }] },
  ];
  listed = listedSources({ runs, takes, messages });
  for (const number of [20, 21, 22, 30]) assert.ok(numbers(listed.runs).includes(number), `run of take ${number}`);
  // Not what an exchange before the last one wrote.
  listed = listedSources({ runs, takes, messages: [...messages, { role: 'tool', tool_call_id: 'c2', content: '{}' }, user('Merci, une autre ?')] });
  assert.equal(numbers(listed.runs).includes(20), false);
  // Internal messages of the application (the copies of an output, a creation of the Studio) are not the user's.
  listed = listedSources({ runs, takes, messages: [user('Une autre.'), { role: 'user', internal: true, content: 'Copie de la prise 5.' }] });
  assert.equal(numbers(listed.runs).includes(5), false);
});

test('what a creation listed was made from is listed with it, in this conversation and in another one of the project', () => {
  const { runs, takes } = session(100);
  // The latest video started on take 2 of this conversation; another took take 900 of another conversation.
  runs.find(run => run.mediaType === 'video').parameters = { references: [{ role: 'start_image', output_id: uid(2) }] };
  runs.find(run => run.mediaType === 'image').parameters = {
    references: [{ role: 'source', output_id: uid(900), output_conversation: uid(7777) }],
  };
  const other = { take: 900, id: uid(900), index: 0, conversationId: uid(7777), mediaType: 'image' };
  const listed = listedSources({ runs, takes: [...takes, other], messages: [user('Refais la vidéo.')] });
  assert.ok(numbers(listed.runs).includes(2));
  assert.ok(numbers(listed.takes).includes(2) && numbers(listed.takes).includes(900));
});

test('the tools of the local model keep about the same length however long the conversation (10, 50, 200 creations)', async () => {
  const folder = fileURLToPath(new URL('../runner/workflows/', import.meta.url)),
    workflows = [];
  for (const file of (await readdir(folder)).filter(name => name.endsWith('.json')).sort())
    workflows.push({ ...JSON.parse(await readFile(join(folder, file), 'utf8')), ready: true, builtin: true });
  const catalog = new ToolCatalog({ list: async () => workflows });
  // As server.mjs (includeTools) describes them, with what local_read_output lists.
  const length = async ({ runs, takes }) =>
    JSON.stringify(
      await catalog.definitions({
        images: 0,
        resources: [],
        takes: takes.map(({ take, mediaType }) => ({ take, mediaType })),
        outputs: runs.map(run => ({ id: run.id, mediaType: run.mediaType, count: 1, workflowId: 'x', draft: false })),
      }),
    ).length + JSON.stringify(outputToolFor(runs)).length;
  const sizes = {},
    whole = {};
  for (const count of [10, 50, 200, 400]) {
    const all = session(count);
    whole[count] = await length(all);
    sizes[count] = await length(listedSources({ ...all, messages: [user('Une autre image, plus lumineuse.')] }));
  }
  // Every creation listed (until 0.6.90): about 300 characters more for each one.
  assert.ok(whole[200] > whole[50] + 40000 && whole[50] > whole[10] + 10000, JSON.stringify(whole));
  // Listed now: 8 run_ids and 32 numbers of each kind at most, then the same length whatever comes,
  // the digits of the numbers aside (10 creations hold 2 videos, 50 hold 12, 200 and 400 more than 32).
  assert.ok(
    sizes[50] - sizes[10] < 3000 && sizes[200] - sizes[50] < 1000 && Math.abs(sizes[400] - sizes[200]) < 100,
    JSON.stringify(sizes),
  );
  assert.ok(sizes[200] < whole[200] / 2, JSON.stringify({ sizes, whole }));
});
