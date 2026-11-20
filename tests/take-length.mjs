import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { clipSeconds, takeSeconds } from '../public/take-length.mjs';
import { clipSeconds as onCards } from '../public/generation-ui.mjs';
import { takeSeconds as inMontage } from '../public/montage-model.mjs';

// (0.6.141) His report of 20/11: « j'ai une vidéo de 15 secondes environ, et montage ne voit que 10
// secondes ». A clip continued: the record of the take says the frames it generated (241, 10 s), its
// file plays the clip it continues too (353 frames, 14,71 s). The cards of the chat counted it since
// 0.6.9x; the Montage, the Pellicule and the window of a take each read the length for themselves, and
// did not. Read on his 54 videos that day: 15 continuations, up to 19 s short; counted, none is off.
const continued = { frames: 241, fps: 24, overlap_frames: 9, continuation: { overlapFrames: 9, sourceFrames: 121, newFrames: 232 } };

test('a clip continued is as long as its file: the clip it continues, then what it adds (0.6.141)', () => {
  assert.equal(clipSeconds(continued), 353 / 24);
  assert.equal(takeSeconds({ mediaType: 'video', parameters: continued }), 353 / 24);
  // Continued twice: the source is already the whole of what came before.
  assert.equal(clipSeconds({ frames: 241, fps: 24, continuation: { sourceFrames: 353, newFrames: 232 } }), 585 / 24);
  // A clip that continues nothing, at its own rate; a sound says its seconds; an image has no length.
  assert.equal(clipSeconds({ frames: 81, fps: 16 }), 81 / 16);
  assert.equal(takeSeconds({ parameters: { seconds: 30 } }), 30);
  assert.equal(takeSeconds({ parameters: { seconds: '12', frames: 48, fps: 24 } }), 12);
  for (const silent of [{}, { parameters: {} }, { parameters: { frames: 121 } }, { parameters: { fps: 24 } }, null, undefined])
    assert.equal(takeSeconds(silent), null);
  // A continuation half written (an older take) falls back on its own frames, never on nothing.
  assert.equal(clipSeconds({ frames: 129, fps: 24, continuation: { sourceFrames: 121 } }), 129 / 24);
  assert.equal(clipSeconds({ frames: 129, fps: 24, continuation: null }), 129 / 24);
});

test('every screen reads the length of a take in the same place (0.6.141)', async () => {
  // The cards and the Montage hand on what take-length.mjs says (the Montage to the thousandth).
  assert.equal(onCards, clipSeconds);
  assert.equal(inMontage({ parameters: continued }), 14.708);
  assert.equal(inMontage({ parameters: { frames: 81, fps: 16 } }), 5.063);
  assert.equal(inMontage({ mediaType: 'image', parameters: {} }), null);
  // None counts frames by a rate for itself any more: the next screen to say a length asks here.
  const folder = new URL('../public/', import.meta.url);
  const own = [];
  for (const name of (await readdir(folder)).filter(name => /\.(mjs|js)$/.test(name) && name !== 'take-length.mjs')) {
    const text = await readFile(new URL(name, folder), 'utf8');
    text.split('\n').forEach((line, at) => {
      if (/frames\s*\/\s*[\w.]*fps\b/.test(line)) own.push(`${name}:${at + 1}`);
    });
  }
  assert.deepEqual(own, []);
  for (const name of ['generation-ui.mjs', 'library.mjs', 'assets-ui.mjs', 'montage-model.mjs'])
    assert.match(await readFile(new URL(name, folder), 'utf8'), /from '\.\/take-length\.mjs'/, name);
  // The page is served it.
  assert.match(await readFile(new URL('../server.mjs', import.meta.url), 'utf8'), /\['\/take-length\.mjs', \['take-length\.mjs',/);
});
