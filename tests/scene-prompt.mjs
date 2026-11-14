import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneMessages, scenePictures, withScenePrompt } from '../lib/scene-prompt.mjs';

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
  const pictures = await scenePictures(args, library);
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
  assert.match(parts.at(-1).text, /What the user asked: remplace la fille/);
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
  const other = { ...args, source: { output: 'run' } };
  assert.equal(await scenePictures(other, library), null);
  assert.equal(await withScenePrompt(other, { resources: library, engine, fetchImpl: answering(written) }), other);
  assert.equal(await scenePictures({ ...args, reference: { image: 0 } }, library), null);
  assert.equal(await scenePictures({ ...args, source: { resource: 'gone' } }, library), null);
  // An image given as the video is not one to follow.
  assert.equal(await scenePictures({ ...args, source: { resource: 'person' } }, library), null);
});
