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
