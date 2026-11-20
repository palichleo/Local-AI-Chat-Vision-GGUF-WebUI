import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detachedTakes, leavingQuestion, reattached, takesIn, takesWord } from '../public/detached-takes.mjs';
import { closedCalls } from '../public/transcript.mjs';
import { History } from '../lib/history.mjs';

/**
 * The takes a conversation no longer shows (0.6.99): ten images of a series were in `output` and in
 * the Pellicule, and no longer in their conversation, its exchange taken back by « Régénérer ».
 */
const ID = 'a1111111-1111-4111-8111-111111111111';
const runOf = index => `${String(index % 10).repeat(8)}-2222-4222-8222-${String(index).padStart(12, '0')}`;
/** A take as /api/gallery lists it: its call, its prompt, its time. */
const take = (index, callId = 'call_serie', given = {}) => ({
  id: runOf(index),
  conversationId: ID,
  callId,
  provider: 'native',
  workflowId: 'krea',
  workflowName: 'Krea 2',
  prompt: `Un chat ${index}, aquarelle.`,
  parameters: { seed: index, workflow_digest: 'd' },
  createdAt: new Date(Date.UTC(2026, 10, 18, 18, 30, index)).toISOString(),
  outputs: [{ source: { filename: `chat-${index}.png`, subfolder: 'image', type: 'output' }, take: index }],
  ...given,
});
const series = (count, callId = 'call_serie') => Array.from({ length: count }, (_, index) => take(index + 1, callId));
const asked = { role: 'user', content: 'Fais 10 images de chats à l’aquarelle' };
const call = (id, args = { prompt: 'Un chat 1, aquarelle.' }, name = 'create_image') => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const result = (id, content) => ({ role: 'tool', tool_call_id: id, content: JSON.stringify(content) });

test('ten takes of a call no message names any more are found, by their call, the oldest first', () => {
  // What « Régénérer » left: the message, and the list of prompts the model wrote in place of its call.
  const messages = [asked, { role: 'assistant', content: '1. Un chat roux\n2. Un chat noir' }],
    runs = series(10).reverse(),
    [group, ...others] = detachedTakes(messages, runs);
  assert.equal(others.length, 0);
  assert.deepEqual([group.callId, group.call, group.detached], ['call_serie', null, 10]);
  assert.deepEqual(group.records.map(record => record.id), series(10).map(record => record.id));
  assert.equal(takesWord(group.detached), '10 prises');
  assert.equal(takesWord(1), '1 prise');
});

test('takes named, made by hand, of a call still open, without a call, or of an exotic call: never said', () => {
  const named = [
      asked,
      { role: 'assistant', content: '', tool_calls: [call('call_serie')] },
      result('call_serie', { status: 'success', images: series(10).map(record => ({ status: 'success', run_id: record.id })) }),
    ],
    runs = series(10);
  assert.deepEqual(detachedTakes(named, runs), [], 'its result names them all');
  // A creation of the Studio by hand (tools/action: « action… »), or an image of a character let go.
  assert.deepEqual(detachedTakes([asked], [take(1, 'action0123456789abcdef01234567')]), []);
  // A call still waiting for its result (closedCalls reads it so): take-recovery.mjs completes it.
  const tenAsked = { prompt: 'Un chat 1, aquarelle.', series: series(10).slice(1).map(record => record.prompt) },
    open = [asked, { role: 'assistant', content: '', tool_calls: [call('call_serie', tenAsked)] }];
  assert.deepEqual(detachedTakes(open, runs), []);
  assert.deepEqual(detachedTakes(closedCalls(open), runs), []);
  // Between two images of a series (« Série interrompue avant sa fin »): the same.
  const between = [
    ...open,
    result('call_serie', {
      status: 'partial',
      images: [{ status: 'success', run_id: runOf(1) }],
      message: 'Série interrompue avant sa fin : 1 image sur 10 a été faite.',
    }),
  ];
  assert.deepEqual(detachedTakes(between, runs), []);
  // Made before 0.6.82 (no call kept with it), or with a call the history could not keep.
  assert.deepEqual(detachedTakes([asked], [take(1, null), take(2, 'functions.create_image:0')]), []);
  // A character made for a replacement is named by its result.
  const character = [
    asked,
    { role: 'assistant', content: '', tool_calls: [call('call_scene', { source: { output: 'x' } }, 'replace_character')] },
    result('call_scene', { status: 'success', run_id: runOf(2), character_image: { output: runOf(1) } }),
  ];
  assert.deepEqual(detachedTakes(character, [take(1, 'call_scene'), take(2, 'call_scene')]), []);
});

test('a call still there whose result names fewer takes than it made: its result written again with all of them', () => {
  const messages = [
      asked,
      { role: 'assistant', content: '', tool_calls: [call('call_serie', { prompt: 'Un chat 1, aquarelle.', series: series(9).map(record => record.prompt) })] },
      result('call_serie', {
        status: 'partial',
        images: series(9).map(record => ({ status: 'success', run_id: record.id })),
        message: 'Série arrêtée à l’image 10 : Failed to fetch',
      }),
    ],
    [group] = detachedTakes(messages, series(10));
  assert.deepEqual([group.detached, group.records.length, Boolean(group.call)], [1, 10, true]);
  const back = reattached(messages, group),
    told = JSON.parse(back.at(-1).content);
  assert.equal(back.length, 3, 'the same call, its result in place');
  assert.deepEqual([told.status, told.made, told.asked], ['success', 10, 10]);
  assert.deepEqual(told.images.map(image => image.run_id), series(10).map(record => record.id));
});

test('put back, a call taken away comes again after the last message, as it was made, and the history keeps it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'moodix-detached-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const messages = [asked, { role: 'assistant', content: '1. Un chat roux\n2. Un chat noir' }],
    [group] = detachedTakes(messages, series(10)),
    back = reattached(messages, group);
  assert.deepEqual(back.slice(0, 2), messages);
  const [calling, answer] = back.slice(2);
  assert.deepEqual([calling.role, calling.content, calling.tool_calls[0].id, calling.tool_calls[0].function.name], ['assistant', '', 'call_serie', 'create_image']);
  const args = JSON.parse(calling.tool_calls[0].function.arguments);
  assert.equal(args.prompt, 'Un chat 1, aquarelle.');
  assert.deepEqual(args.series, series(10).slice(1).map(record => record.prompt));
  const told = JSON.parse(answer.content);
  assert.deepEqual([answer.tool_call_id, told.status, told.made], ['call_serie', 'success', 10]);
  assert.deepEqual(told.images.map(image => image.run_id), series(10).map(record => record.id));
  // Nothing left to put back, and the history of the server takes it as it is.
  assert.deepEqual(detachedTakes(back, series(10)), []);
  const history = new History(join(directory, 'history'));
  await history.save({ id: ID, messages: back, incomplete: false, instructions: '', projectId: 'inbox' });
  assert.equal((await history.read(ID)).messages.length, 4);
  // A single video comes back as one: its own verb, its result.
  const clip = take(3, 'call_clip', { mediaType: 'video', prompt: 'Le chat saute.' }),
    [one] = detachedTakes(messages, [clip]),
    video = reattached(messages, one);
  assert.equal(video.at(-2).tool_calls[0].function.name, 'create_video');
  assert.equal(JSON.parse(video.at(-1).content).run_id, clip.id);
});

test('before an exchange leaves, its takes are said in the user’s words; words alone, nothing is asked', () => {
  const image = id => result(id, { status: 'success', run_id: runOf(id.length), media_type: 'image' });
  assert.equal(
    leavingQuestion([image('c')]),
    'Cette réponse a 1 image : elle quittera la conversation et restera dans les Archives. Continuer ?',
  );
  const ten = result('call_serie', { status: 'success', images: series(10).map(record => ({ status: 'success', run_id: record.id })) });
  assert.equal(
    leavingQuestion([{ role: 'assistant', content: '', tool_calls: [call('call_serie')] }, ten]),
    'Cette réponse a 10 images : elles quitteront la conversation et resteront dans les Archives. Continuer ?',
  );
  assert.match(leavingQuestion([result('v', { run_id: runOf(1), media_type: 'video' })]), /^Cette réponse a 1 vidéo : elle quittera/);
  assert.match(
    leavingQuestion([result('a', { run_id: runOf(1), media_type: 'audio' }), result('b', { run_id: runOf(2), media_type: 'audio' })]),
    /^Cette réponse a 2 sons : ils quitteront la conversation et resteront dans les Archives/,
  );
  assert.match(leavingQuestion([ten, result('v', { run_id: runOf(11), media_type: 'video' })]), /^Cette réponse a 11 prises : elles quitteront/);
  // The same take named twice counts once (a series result written again after each image).
  assert.equal(takesIn([ten, ten]).length, 10);
  assert.equal(leavingQuestion([{ role: 'assistant', content: 'Un renard.' }]), '');
  assert.equal(leavingQuestion([result('c', { status: 'error', message: 'Mémoire vidéo insuffisante.' })]), '');
  assert.equal(leavingQuestion([{ role: 'tool', tool_call_id: 'c', content: 'pas du JSON' }]), '');
});
