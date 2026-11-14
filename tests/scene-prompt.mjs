import test from 'node:test';
import assert from 'node:assert/strict';
import {
  askedSince,
  characterOf,
  characterPrompt,
  lastReplacement,
  sceneMessages,
  scenePictures,
  withScenePrompt,
} from '../lib/scene-prompt.mjs';

const frame = name => ({ time: 0, url: 'data:image/jpeg;base64,' + name });
const library = {
  readActive: async id => {
    if (id === 'clip') return { mime: 'video/mp4', frames: [frame('a'), frame('b'), frame('c'), frame('d')] };
    if (id === 'person') return { mime: 'image/png', frames: [frame('p')] };
    throw Error('inactive');
  },
};
const args = { prompt: 'A woman stands in a room.', source: { resource: 'clip' }, reference: { resource: 'person' } };
const written =
  'A young woman with dark hair pulled back, in a white sleeveless top, stands in an apple orchard in daylight. ' +
  'She wipes a red apple with a white handkerchief, smells it, then bites into it with her eyes closed.';
const engine = { vision: true, state: 'ready', base: 'http://engine', apiKey: 'k' };
const answering =
  (content, seen = []) =>
  async (url, options) => {
    seen.push([url, JSON.parse(options.body)]);
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  };

test('the prompt of a character put in a video is written from the frames of the video and the image', async () => {
  const pictures = await scenePictures(args, { resources: library });
  // Three frames of the video at most, in order, then the character.
  assert.deepEqual(pictures, {
    frames: ['a', 'b', 'c'].map(name => frame(name).url),
    character: frame('p').url,
  });
  const messages = sceneMessages({ ...pictures, asked: 'remplace la fille', draft: args.prompt });
  assert.match(messages[0].content, /Never describe the place, the pose or the background of that image/);
  const parts = messages[1].content;
  assert.deepEqual(
    parts.filter(part => part.type === 'image_url').map(part => part.image_url.url),
    [...pictures.frames, pictures.character],
  );
  assert.match(parts.at(-1).text, /What the user asked, in their own language .*: « remplace la fille »/);
  assert.match(messages[0].content, /nothing of their face, their hair, their clothes/);
  assert.match(messages[0].content, /What the user asks for comes first/);
  // In the Studio what is typed is the wish itself: said once, not as a draft too.
  const wished = [];
  await withScenePrompt(args, {
    resources: library,
    engine,
    asked: 'elle porte une robe rouge',
    draft: '',
    fetchImpl: answering(written, wished),
  });
  const said = wished[0][1].messages[1].content.at(-1).text;
  assert.match(said, /« elle porte une robe rouge »/);
  assert.doesNotMatch(said, /first draft/);
  const seen = [];
  const result = await withScenePrompt(args, { resources: library, engine, fetchImpl: answering(written, seen) });
  assert.equal(result.prompt, written);
  // The rest of the call is left as it came.
  assert.deepEqual({ ...result, prompt: args.prompt }, args);
  assert.equal(seen[0][0], 'http://engine/v1/chat/completions');
  assert.equal(seen[0][1].stream, false);
});

test('a prompt that cannot be written from the pictures never stops the video: the call keeps its own', async () => {
  const kept = options =>
    withScenePrompt(args, { resources: library, engine, fetchImpl: answering(written), ...options });
  // No vision, a model not ready, a silent or slow model, two words for an answer.
  assert.equal(await kept({ engine: { ...engine, vision: false } }), args);
  assert.equal(await kept({ engine: { ...engine, state: 'loading' } }), args);
  assert.equal(await kept({ fetchImpl: async () => ({ ok: false }) }), args);
  assert.equal(
    await kept({
      fetchImpl: async () => {
        throw Error('timeout');
      },
    }),
    args,
  );
  assert.equal(await kept({ fetchImpl: answering('A woman.') }), args);
  // The video or the character not in the library (an earlier result, an image of the message).
  const places = { resources: library };
  const other = { ...args, source: { output: 'run' } };
  assert.equal(await scenePictures(other, places), null);
  assert.equal(await withScenePrompt(other, { resources: library, engine, fetchImpl: answering(written) }), other);
  assert.equal(await scenePictures({ ...args, reference: { image: 0 } }, places), null);
  assert.equal(await scenePictures({ ...args, source: { resource: 'gone' } }, places), null);
  // An image given as the video is not one to follow.
  assert.equal(await scenePictures({ ...args, source: { resource: 'person' } }, places), null);
});

test('the pictures are found wherever they come from: the library, the conversation, an earlier result', async () => {
  const attached = 'data:image/png;base64,attached',
    messages = [
      { role: 'user', content: [{ type: 'text', text: 'voici' }, { type: 'image_url', image_url: { url: attached } }] },
      { role: 'user', internal: true, content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,shown' } }] },
    ],
    conversationId = '11111111-1111-4111-8111-111111111111',
    run = '22222222-2222-4222-8222-222222222222',
    thumbnails = {
      has: key => key === `${conversationId}.${run}.0`,
      read: async () => Buffer.from('small'),
    };
  // The character attached to the message (by its position, the pictures the page showed the model left out).
  assert.deepEqual(await scenePictures({ ...args, reference: { image: 0 } }, { resources: library, messages }), {
    frames: ['a', 'b', 'c'].map(name => frame(name).url),
    character: attached,
  });
  // The video made earlier in the conversation: the small picture kept of it.
  const earlier = await scenePictures(
    { ...args, source: { output: run } },
    { resources: library, thumbnails, conversationId },
  );
  assert.deepEqual(earlier, {
    frames: ['data:image/jpeg;base64,' + Buffer.from('small').toString('base64')],
    character: frame('p').url,
  });
  // A frame of a video of the library given as the character: that frame.
  const framed = await scenePictures({ ...args, reference: { resource: 'clip', frame: 1 } }, { resources: library });
  assert.equal(framed.character, frame('b').url);
});

test('a character with no image yet: no prompt from words, the image prompt alone on grey', async () => {
  // The prompt of the video waits for the image of the character: written from words, the person
  // of the video lent the character their clothes (a headscarf and a tote bag on a volleyball player).
  assert.equal(await scenePictures({ source: { resource: 'clip' } }, { resources: library }), null);
  const call = { prompt: 'x', source: { resource: 'clip' } },
    seen = [];
  assert.equal(await withScenePrompt(call, { resources: library, engine, fetchImpl: answering(written, seen) }), call);
  assert.equal(seen.length, 0);
  // The image of the character: alone, whole, large, on a plain background (what else it holds
  // goes into the video too).
  const image = characterPrompt('a male volleyball player with short dark hair, a blue jersey and white shorts.');
  assert.match(image, /^A full-length photo of a male volleyball player .*white shorts, alone,/);
  assert.match(image, /filling the height of the frame/);
  assert.match(image, /Plain light grey studio background with nothing else in it/);
  // Given the prompt of the replacement as the character: who they replace is left out.
  assert.match(
    characterPrompt('A male volleyball player with short hair, a blue jersey and white shorts replaces the girl.'),
    /^A full-length photo of a male volleyball player with short hair, a blue jersey and white shorts, alone,/,
  );
  assert.match(characterPrompt('An old robot, who takes the place of the man'), /^A full-length photo of an old robot, alone,/);
});

test('a video made earlier is seen through frames read from its file, else its small picture', async () => {
  const conversationId = '11111111-1111-4111-8111-111111111111',
    run = '22222222-2222-4222-8222-222222222222',
    thumbnails = { has: () => true, read: async () => Buffer.from('small') },
    asked = [];
  const outputFrames = async (conversation, id, index) => {
    asked.push([conversation, id, index]);
    return id === run ? { urls: ['f1', 'f2', 'f3', 'f4'], video: true } : { urls: [], video: false };
  };
  const pictures = await scenePictures(
    { source: { output: run }, reference: { resource: 'person' } },
    { resources: library, thumbnails, conversationId, outputFrames },
  );
  assert.deepEqual(pictures.frames, ['f1', 'f2', 'f3']);
  assert.deepEqual(asked, [[conversationId, run, 0]]);
  // An image made earlier given as the video: not a video to follow.
  assert.equal(
    await scenePictures(
      { source: { output: 'other' }, reference: { resource: 'person' } },
      { resources: library, thumbnails, conversationId, outputFrames },
    ),
    null,
  );
  // Frames that cannot be read: the small picture kept of it.
  const small = await scenePictures(
    { source: { output: run }, reference: { resource: 'person' } },
    { resources: library, thumbnails, conversationId, outputFrames: async () => null },
  );
  assert.deepEqual(small.frames, ['data:image/jpeg;base64,' + Buffer.from('small').toString('base64')]);
});

test('why the prompt was not written is told', async () => {
  const reasons = [];
  const onSkip = why => reasons.push(why);
  await withScenePrompt(args, { resources: library, engine: { ...engine, vision: false }, onSkip });
  await withScenePrompt({ ...args, source: { resource: 'gone' } }, { resources: library, engine, onSkip });
  await withScenePrompt(args, { resources: library, engine, onSkip, fetchImpl: async () => ({ ok: false, status: 503 }) });
  await withScenePrompt(args, { resources: library, engine, onSkip, fetchImpl: answering('Short.') });
  const late = Object.assign(Error('late'), { name: 'TimeoutError' });
  await withScenePrompt(args, {
    resources: library,
    engine,
    onSkip,
    timeoutMs: 5000,
    fetchImpl: async () => {
      throw late;
    },
  });
  assert.deepEqual(reasons, [
    'le modèle de chat ne voit pas les images',
    'les images de la vidéo ou du personnage sont introuvables',
    'le modèle de chat a refusé la demande (503)',
    'le modèle de chat a répondu trop court',
    'pas de réponse en 5 s',
  ]);
});

test('what the user asked about a replacement: their words since the last one made', () => {
  const made = (id, status = 'success') => [
    { role: 'assistant', content: '', tool_calls: [{ id, function: { name: 'replace_character', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: id, content: JSON.stringify({ status }) },
  ];
  assert.equal(askedSince([{ role: 'user', content: 'remplace le pingouin' }]), 'remplace le pingouin');
  const messages = [
    { role: 'user', content: 'remplace le pingouin' },
    ...made('a'),
    { role: 'user', content: 'on voit encore un bout du terrain' },
    { role: 'user', internal: true, content: 'shown pictures' },
    ...made('b', 'cancelled'),
    { role: 'user', content: 'refais-le' },
  ];
  // A correction said in two messages; what came before the last replacement made is done.
  assert.equal(askedSince(messages), 'on voit encore un bout du terrain\nrefais-le');
  assert.equal(askedSince(undefined), '');
});

test('a change asked for a replacement already made keeps its character', () => {
  const clip = { resource: 'd276' },
    kept = { output: 'image-1' },
    made = (id, run, status = 'success', again = { source: clip, reference: kept }) => [
      { role: 'assistant', content: '', tool_calls: [{ id, function: { name: 'replace_character', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: id, content: JSON.stringify({ status, run_id: run, replace_again: again }) },
    ];
  const messages = [{ role: 'user', content: 'remplace la fille' }, ...made('a', 'video-1')];
  // The same video, or the video it made: its video and its character.
  assert.deepEqual(lastReplacement(messages, { resource: 'd276' }), { source: clip, reference: kept });
  assert.deepEqual(lastReplacement(messages, { output: 'video-1' }), { source: clip, reference: kept });
  // Another video, a replacement cancelled, nothing given: nothing to keep.
  assert.equal(lastReplacement(messages, { resource: 'other' }), null);
  assert.equal(lastReplacement(made('b', 'video-2', 'cancelled'), clip), null);
  assert.equal(lastReplacement(messages, null), null);
  // The last one made from that video.
  const later = [...messages, ...made('c', 'video-3', 'success', { source: clip, reference: { output: 'image-2' } })];
  assert.deepEqual(lastReplacement(later, clip).reference, { output: 'image-2' });
  // Who to draw from a prompt given with no character: its first sentence, not the scene.
  assert.equal(
    characterOf('A male volleyball player in a blue jersey stands in an orchard. Rain falls on the leaves.'),
    'A male volleyball player in a blue jersey stands in an orchard.',
  );
  assert.match(
    characterPrompt(characterOf('A male volleyball player with short hair replaces the girl. It rains.')),
    /^A full-length photo of a male volleyball player with short hair, alone,/,
  );
});
