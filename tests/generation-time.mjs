import test from 'node:test';
import assert from 'node:assert/strict';
import { elapsedClock, generationTime, madeIn, takeTime } from '../public/generation-time.mjs';

/**
 * The time a take took to make (0.6.93, public/generation-time.mjs): counted by the server from the
 * user's go to the file written, written the same everywhere, never taken for the length of a clip.
 */
test('the time of a generation is written « 42 s », « 2 min 05 s », « 1 h 02 min »: the whole seconds gone by', () => {
  assert.deepEqual(
    [0, 999, 42000, 59999, 60000, 125400, 3599999, 3600000, 3725000, 7265000].map(generationTime),
    ['0 s', '0 s', '42 s', '59 s', '1 min 00 s', '2 min 05 s', '59 min 59 s', '1 h 00 min', '1 h 02 min', '2 h 01 min'],
  );
  // Nothing measured: nothing said.
  for (const value of [undefined, null, NaN, -1, '42']) assert.equal(generationTime(value), '');
});

test('a take says the whole of its time from 0.6.93; before, only the engine’s, said as such; else nothing', () => {
  const now = { parameters: { generation_time: { total_ms: 72500, prepare_ms: 2500, engine_ms: 70000 }, generation_duration_ms: 70000 } };
  assert.deepEqual(takeTime(now), { ms: 72500, whole: true, prepare: 2500, engine: 70000 });
  assert.equal(madeIn(now), 'Générée en 1 min 12 s');
  // Made before: its record held how long the engine took (its models, the computation, the file), not
  // what came before it (the checks, the chat model leaving the card). Never passed off as the whole.
  const before = { parameters: { generation_duration_ms: 116300, runner_duration_ms: 116300 } };
  assert.deepEqual(takeTime(before), { ms: 116300, whole: false, engine: 116300 });
  assert.equal(madeIn(before), '');
  // Nothing measured (a take of ComfyUI before the engine of Moodix, a file of the computer).
  for (const record of [{ parameters: {} }, {}, null, { parameters: { generation_time: { total_ms: 'long' } } }]) {
    assert.equal(takeTime(record), null);
    assert.equal(madeIn(record), '');
  }
});

/** A clock and timers the test moves by hand. */
function hand() {
  let at = 1000,
    next = 1;
  const intervals = new Map();
  return {
    now: () => at,
    timers: {
      setInterval: (fn, every) => (intervals.set(next, { fn, every }), next++),
      clearInterval: id => intervals.delete(id),
    },
    intervals,
    /** Time goes by `ms`, the intervals firing as they would. */
    pass(ms) {
      for (let step = 0; step < ms; step += 250) {
        at += 250;
        for (const { fn } of [...intervals.values()]) fn();
      }
    },
  };
}

test('while a take is made its time goes on between two answers of the server, never back, and stops at its file', () => {
  const clock = hand(),
    said = [];
  const counted = elapsedClock(text => said.push(text), clock);
  // Nothing from the server: nothing said, nothing counted.
  counted.update(undefined);
  counted.update({ running: true });
  assert.deepEqual([said, clock.intervals.size], [[], 0]);
  // 41.8 s since the go, as the server says it: counted from there, a second at a time.
  counted.update({ ms: 41800, running: true });
  assert.deepEqual(said, ['41 s']);
  clock.pass(1000);
  assert.deepEqual(said, ['41 s', '42 s']);
  // An answer that took longer to come says a later start: the count does not go back for it.
  counted.update({ ms: 42000, running: true });
  assert.equal(counted.text, '42 s');
  clock.pass(18000);
  assert.equal(counted.text, '1 min 00 s');
  assert.equal(clock.intervals.size, 1, 'one count, however many answers');
  // Its file is written: the server says its time, which no longer moves.
  counted.update({ ms: 72500, running: false });
  assert.equal(counted.text, '1 min 12 s');
  assert.equal(clock.intervals.size, 0);
  clock.pass(5000);
  assert.equal(said.at(-1), '1 min 12 s');
  // Another take on the same clock: from nothing again.
  counted.reset();
  counted.update({ ms: 2000, running: true });
  assert.equal(counted.text, '2 s');
  counted.stop();
  assert.equal(clock.intervals.size, 0);
});
