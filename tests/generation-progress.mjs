import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProgressClock, ProgressHistory, milestone, timingKey } from '../lib/generation-progress.mjs';

function clockAt(reference) {
  let now = 0;
  const clock = new ProgressClock(reference, () => now);
  return { clock, at: seconds => (now = seconds * 1000) };
}

test('runner events become ordered milestone names', () => {
  assert.equal(milestone({ stage: 'generating video', step: 3, total: 8 }), 'generating video#3');
  assert.equal(milestone({ stage: 'decoding video' }), 'decoding video');
  assert.equal(milestone('Préparation'), 'Préparation');
  assert.equal(milestone({}), null);
  assert.equal(timingKey('w', { stage: 'draft', width: 384, height: 256, frames: 25 }, 1), 'w|draft|384x256x25|refs1');
});

test('a previous run paces the bar by its real milestone times', () => {
  const reference = [
    { mark: 'unloading', at: 0 },
    { mark: 'encoding', at: 10 },
    { mark: 'generating video#1', at: 30 },
    { mark: 'generating video#2', at: 40 },
    { mark: 'decoding', at: 50 },
    { mark: 'done', at: 100 },
  ];
  const { clock, at } = clockAt(reference);
  clock.mark('unloading');
  at(5);
  assert.equal(clock.fraction('unloading'), 0.05);
  // Running slower than last time: the bar waits just short of the next milestone.
  at(60);
  assert.equal(clock.fraction('unloading'), 0.095);
  clock.mark('encoding');
  assert.equal(clock.fraction('generating'), 0.1);
  at(70);
  clock.mark('generating video#1');
  clock.mark('generating video#2');
  clock.mark('decoding');
  at(95);
  assert.equal(clock.fraction('generating'), 0.75);
  assert.equal(clock.fraction('done'), 1);
});

test('never moves backwards and never reports completion early', () => {
  const { clock, at } = clockAt([
    { mark: 'a', at: 0 },
    { mark: 'done', at: 10 },
  ]);
  clock.mark('a');
  at(1000);
  assert.ok(clock.fraction('generating') <= 0.99);
  clock.mark('unexpected');
  assert.ok(clock.fraction('generating') >= 0.9);
});

test('without history the sampling steps carry the bar', () => {
  const { clock } = clockAt(null);
  assert.equal(clock.fraction('checking'), 0.03);
  clock.mark('unloading');
  clock.mark('generating');
  clock.mark('loading encoder');
  const loading = clock.fraction('generating');
  assert.ok(loading > 0.05 && loading < 0.25);
  clock.mark('generating video#4', { step: 4, total: 8 });
  assert.equal(clock.fraction('generating'), 0.55);
  clock.mark('generating video#8', { step: 8, total: 8 });
  assert.equal(clock.fraction('generating'), 0.85);
  clock.mark('decoding video');
  assert.ok(clock.fraction('generating') > 0.85);
  assert.equal(clock.fraction('restarting'), 0.97);
});

test('history keeps the last successful timeline per key', async () => {
  const history = new ProgressHistory(join(await mkdtemp(join(tmpdir(), 'timing-')), 'timing.json'));
  assert.equal(await history.reference('k'), null);
  await history.save('k', [
    { mark: 'a', at: 1.234 },
    { mark: 'done', at: 5 },
  ]);
  assert.deepEqual(await history.reference('k'), [
    { mark: 'a', at: 1.23 },
    { mark: 'done', at: 5 },
  ]);
});

test('how long a creation took here before says how long it will take: the same one, else the nearest one made by that model (0.6.144)', async () => {
  // (Étape 2 du Montage, lot 3: before a series of plans the user agrees knowing the time. Only what
  // was really made here is said; a size never made here has nothing to say.)
  const history = new ProgressHistory(join(await mkdtemp(join(tmpdir(), 'timing-')), 'timing.json'));
  const clip = (frames, more = {}) => ({ width: 1600, height: 896, frames, stage: 'final', ...more }),
    made = (parameters, references, seconds) => history.save(timingKey('ltx', parameters, references), [{ mark: 'loading', at: 4 }, { mark: 'done', at: seconds }]);
  assert.equal(await history.expected('ltx', clip(121), 2), null);
  await made(clip(121), 2, 108.4);
  // The same workflow, size, length and number of inputs: that time.
  assert.deepEqual(await history.expected('ltx', clip(121), 2), { seconds: 108.4, exact: true });
  // Another length at that size: the time of the nearest one, brought to this length.
  assert.deepEqual(await history.expected('ltx', clip(49), 2), { seconds: 43.9, exact: false });
  await made(clip(57), 2, 50);
  assert.deepEqual(await history.expected('ltx', clip(49), 2), { seconds: 43, exact: false });
  assert.deepEqual(await history.expected('ltx', clip(241), 2), { seconds: 215.9, exact: false });
  // As many inputs first; with none made so, the nearest length whatever its inputs.
  await made(clip(49), 0, 30);
  assert.deepEqual(await history.expected('ltx', clip(49), 2), { seconds: 43, exact: false });
  assert.deepEqual(await history.expected('ltx', clip(49), 1), { seconds: 30, exact: false });
  // Another size: the nearest in pictures to make (their size by their number), brought to what is
  // asked (57 pictures of 1600 × 896 in 50 s: 121 of 768 × 448, half as much to make, in 25,5 s).
  assert.deepEqual(await history.expected('ltx', clip(121, { width: 768, height: 448 }), 2), { seconds: 25.5, exact: false });
  // Another version of the workflow, another workflow: never made here, nothing is said.
  assert.equal(await history.expected('ltx', clip(121, { stage: 'draft' }), 2), null);
  assert.equal(await history.expected('wan', clip(121), 2), null);
  // An image (no length): the same size only. A timeline that did not end is no time.
  await made({ width: 1024, height: 1024 }, 0, 9.5);
  assert.deepEqual(await history.expected('ltx', { width: 1024, height: 1024 }, 0), { seconds: 9.5, exact: true });
  assert.equal(await history.expected('ltx', { width: 1024, height: 768 }, 0), null);
  await history.save(timingKey('ltx', clip(33), 2), [{ mark: 'loading', at: 4 }]);
  assert.deepEqual(await history.expected('ltx', clip(33), 2), { seconds: 28.9, exact: false });
  // That size first: another size, though nearer in pictures to make, is not the one read.
  await made(clip(161, { width: 1920, height: 1088 }), 2, 400);
  assert.deepEqual(await history.expected('ltx', clip(241), 2), { seconds: 215.9, exact: false });
});
