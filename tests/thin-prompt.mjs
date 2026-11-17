import test from 'node:test';
import assert from 'node:assert/strict';
import { THIN_NOTE, passedImages, thinNote, thinPrompt, thinSeries, thinSeriesNote } from '../lib/thin-prompt.mjs';

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

test('each prompt of a series is held to what a single image is: one answer names those to write again', () => {
  const full = words(40),
    series = (prompt, others) => call('create_image', { prompt, series: others });
  // Every prompt complete: the call stands.
  assert.deepEqual(thinSeries(asked, series(full, [full, full])), []);
  assert.equal(thinNote(asked, series(full, [full, full])), '');
  // A first prompt complete and one-liners after it: they were made as they came.
  const some = series(full, ['A blue whale.', full, 'An owl at night.']);
  assert.deepEqual(thinSeries(asked, some), [2, 4]);
  const note = thinNote(asked, some);
  assert.match(note, /^Nothing was generated: the prompt is too thin for images 2 and 4 of this series of 4 /);
  assert.match(note, /image 1 is prompt, the others follow in series, in their order/);
  assert.match(note, /Keep the other prompts as they are/);
  assert.match(note, /make the same call again with all its prompts\.$/);
  // One alone, the first among them, every one of them: said as such.
  assert.match(thinNote(asked, series('A fox.', [full, full])), /too thin for image 1 of this series of 3 .*Write that one again/s);
  assert.deepEqual(thinSeries(asked, series('A fox.', ['A whale.', 'An owl.'])), [1, 2, 3]);
  const all = thinNote(asked, series('A fox.', ['A whale.', 'An owl.']));
  assert.match(all, /too thin for every image of this series /);
  assert.doesNotMatch(all, /Keep the other prompts/);
  assert.equal(thinSeriesNote([1, 2, 3], 5).includes('images 1, 2 and 3 of this series of 5'), true);
  // Told once in this turn, as for a single image: the next call stands, until the user writes again.
  const told = [...asked, { role: 'tool', content: JSON.stringify({ status: 'nothing_generated', message: note }) }];
  assert.deepEqual(thinSeries(told, some), []);
  assert.equal(thinNote(told, some), '');
  assert.deepEqual(thinSeries([...told, { role: 'user', content: 'refais' }], some), [2, 4]);
  // A single image gets what it always got, to the character; a video has no series.
  assert.equal(thinNote(asked, call('create_image', { prompt: words(39) })), THIN_NOTE);
  assert.equal(thinNote(asked, call('create_image', { prompt: full })), '');
  assert.equal(thinNote(asked, call('create_video', { prompt: words(30) })), THIN_NOTE);
  assert.deepEqual(thinSeries(asked, call('create_video', { prompt: full, series: ['x'] })), []);
  // What is no list of texts is refused with its own words (lib/tool-runtime.mjs), not here.
  assert.deepEqual(thinSeries(asked, series(full, 'A whale.')), []);
  assert.deepEqual(thinSeries(asked, series(full, [full, 7])), []);
  assert.deepEqual(thinSeries(asked, { function: { name: 'create_image', arguments: '{' } }), []);
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
