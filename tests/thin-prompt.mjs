import test from 'node:test';
import assert from 'node:assert/strict';
import { THIN_NOTE, passedImages, thinPrompt } from '../lib/thin-prompt.mjs';

const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });
const words = count => Array(count).fill('word').join(' ');
const asked = [{ role: 'user', content: 'une vidéo' }];

test('a generation call with a two-line prompt is sent back once per turn', () => {
  assert.equal(thinPrompt(asked, call('create_video', { prompt: words(30) })), true);
  assert.equal(thinPrompt(asked, call('create_video', { prompt: words(60) })), false);
  assert.equal(thinPrompt(asked, call('create_image', { prompt: words(39) })), true);
  assert.equal(thinPrompt(asked, call('create_image', { prompt: words(40) })), false);
  // Told once in this turn: the next call stands, whatever its length.
  const told = [
    ...asked,
    { role: 'tool', content: JSON.stringify({ status: 'nothing_generated', message: THIN_NOTE }) },
  ];
  assert.equal(thinPrompt(told, call('create_video', { prompt: words(30) })), false);
  assert.equal(
    thinPrompt([...told, { role: 'user', content: 'refais' }], call('create_video', { prompt: words(30) })),
    true,
  );
});

test('other tools, promoted drafts and calls without a prompt are left alone', () => {
  assert.equal(thinPrompt(asked, call('upscale', { prompt: 'x' })), false);
  assert.equal(thinPrompt(asked, call('create_video', { reuse_output: 'run', stage: 'final' })), false);
  assert.equal(thinPrompt(asked, call('create_video', { reuse_output: 'run', prompt: 'x' })), false);
  assert.equal(thinPrompt(undefined, call('create_video', { prompt: 'x' })), false);
  assert.equal(thinPrompt(asked, { function: { name: 'create_video', arguments: '{' } }), false);
  const catalog = [
    { id: 'aaaa', type: 'image' },
    { id: 'bbbb', type: 'video' },
    { id: 'cccc', type: 'image' },
  ];
  const passing = call('create_video', {
    prompt: 'x',
    start_image: { resource: 'aaaa' },
    source: { resource: 'bbbb' },
  });
  assert.deepEqual(
    passedImages(catalog, passing).map(item => item.id),
    ['aaaa'],
  );
});
