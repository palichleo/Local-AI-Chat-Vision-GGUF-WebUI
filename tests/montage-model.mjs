import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MONTAGE_LIMITS,
  STILL_SECONDS,
  clock,
  montageSeconds,
  montageSummary,
  placeAt,
  planAt,
  planStarts,
  shownSeconds,
  snapped,
  takeSeconds,
  trackOf,
  usualSize,
  withItemChanged,
  withPlanAt,
  withPlanMoved,
  withTake,
  withoutItem,
} from '../public/montage-model.mjs';
import { newMontage, validateMontage } from '../lib/montages.mjs';

// (0.6.137) What a hand does to a montage on the timeline of the Studio (public/montage.mjs), written
// once for the page and the server: every change gives a montage the server takes as it is.
const C = '11111111-1111-4111-8111-111111111111',
  id = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const record = (n, mediaType, more = {}) => ({ id: id(n), conversationId: C, mediaType, outputs: [{ take: n }], parameters: {}, ...more });
const clip = (n, seconds) => record(n, 'video', { workflowName: 'Wan 2.2', parameters: { frames: seconds * 16, fps: 16 } });
const empty = () => newMontage({ id: id(900), now: '2026-11-20T03:00:00.000Z' });
const kept = montage => validateMontage(montage);

test('a creation goes where its kind belongs: a clip or an image on the plans, a sound on its track (0.6.137)', () => {
  assert.deepEqual(
    [clip(1, 5), record(2, 'image'), record(3), record(4, 'audio', { workflowName: 'Musique (ACE-Step 1.5 XL)' }), record(5, 'audio', { workflowName: 'Bruitages (MOSS-SoundEffect v2)', parameters: { seconds: 6 } }), record(6, 'audio', { parameters: { seconds: 45 } })].map(trackOf),
    ['video', 'image', 'image', 'music', 'effects', 'music'],
  );
  assert.deepEqual([takeSeconds(clip(1, 5)), takeSeconds(record(5, 'audio', { parameters: { seconds: 6 } })), takeSeconds(record(2, 'image'))], [5, 6, null]);
  let montage = withTake(empty(), clip(1, 5), { id: id(11) });
  montage = withTake(montage, record(2, 'image'), { id: id(12) });
  montage = withTake(montage, record(4, 'audio', { workflowName: 'Musique', parameters: { seconds: 30 } }), { id: id(13) });
  montage = withTake(montage, record(5, 'audio', { workflowName: 'Bruitages', parameters: { seconds: 6 } }), { id: id(14), at: 2.26 });
  // A clip whole, an image for a few seconds; the music lower than a sound effect, each where it is laid.
  assert.deepEqual(montage.plans, [
    { id: id(11), source: { conversationId: C, runId: id(1), output: 0 }, kind: 'video', from: 0, to: 5, frame: 'fit', volume: 1 },
    { id: id(12), source: { conversationId: C, runId: id(2), output: 0 }, kind: 'image', from: 0, to: STILL_SECONDS, frame: 'fit' },
  ]);
  assert.deepEqual(montage.sounds.map(({ track, at, to, volume }) => [track, at, to, volume]), [['music', 0, 30, 0.6], ['effects', 2.26, 6, 1]]);
  assert.deepEqual(kept(montage).plans, montage.plans, 'the server takes it as it is');
  assert.deepEqual(kept(montage).sounds, montage.sounds);
  // Laid between two plans, or before the first; the same take may be laid twice.
  const between = withTake(montage, clip(7, 2), { id: id(15), index: 1 });
  assert.deepEqual(between.plans.map(plan => plan.id), [id(11), id(15), id(12)]);
  assert.deepEqual(withTake(between, clip(1, 5), { id: id(16), index: 0 }).plans.map(plan => plan.source.runId), [id(1), id(1), id(7), id(2)]);
  // A clip whose length nobody knows is laid for a few seconds; a full montage takes nothing more.
  assert.equal(withTake(empty(), record(8, 'video'), { id: id(17) }).plans[0].to, STILL_SECONDS);
  const full = { ...empty(), plans: Array.from({ length: MONTAGE_LIMITS.plans }, (_, n) => ({ id: id(n + 1) })) };
  assert.equal(withTake(full, clip(1, 5), { id: id(999) }), full);
  assert.equal(empty().plans.length, 0, 'the montage handed over is never changed in place');
});

test('plans follow one another: their starts, the one under the head, the length of the film (0.6.137)', () => {
  let montage = empty();
  for (const [n, seconds] of [[1, 5], [2, 3], [3, 4]]) montage = withTake(montage, clip(n, seconds), { id: id(10 + n) });
  assert.deepEqual([planStarts(montage), montageSeconds(montage)], [[0, 5, 8], 12]);
  assert.deepEqual([0, 4.99, 5, 7.5, 8, 11.9, 12, 99].map(at => planAt(montage, at).index), [0, 0, 1, 1, 2, 2, 2, 2]);
  assert.deepEqual([planAt(montage, 6).start, planAt(montage, 6).plan.id], [5, id(12)]);
  assert.equal(planAt(empty(), 0), null);
  // Moved one place earlier or later; at an end it stays, as an unknown one does.
  assert.deepEqual(withPlanMoved(montage, id(13), -1).plans.map(plan => plan.id), [id(11), id(13), id(12)]);
  assert.deepEqual(withPlanMoved(montage, id(11), 1).plans.map(plan => plan.id), [id(12), id(11), id(13)]);
  for (const [which, step] of [[id(11), -1], [id(13), 1], [id(99), 1]]) assert.equal(withPlanMoved(montage, which, step), montage);
  // (0.6.138) Dragged along the timeline: the place it takes among the others is after those whose
  // middle (2,5 s, 6,5 s, 10 s) the pointer has passed, on the film as it was when it was pressed. A
  // long plan pressed near its end stays where it is until then: read with the others closing the
  // gap it leaves, it went after its neighbour at the first move (1,6 s was past « its middle »).
  assert.deepEqual([0, 1.6, 4.9, 6.4, 6.6, 9.9, 10.1, 99].map(at => placeAt(montage, id(11), at)), [0, 0, 0, 0, 1, 1, 2, 2]);
  assert.deepEqual([0, 2.4, 2.6, 7.9, 9.9, 10.1].map(at => placeAt(montage, id(12), at)), [0, 0, 1, 1, 1, 2]);
  assert.deepEqual([0, 2.4, 2.6, 6.4, 6.6, 11].map(at => placeAt(montage, id(13), at)), [0, 0, 1, 1, 2, 2]);
  // (Where it is pressed, it is at its own place: nothing moves before the pointer does.)
  for (const [which, at, place] of [[id(11), 4.99, 0], [id(12), 5, 1], [id(12), 7.99, 1], [id(13), 8, 2]]) assert.equal(placeAt(montage, which, at), place);
  assert.deepEqual(withPlanAt(montage, id(11), 2).plans.map(plan => plan.id), [id(12), id(13), id(11)]);
  assert.deepEqual(withPlanAt(montage, id(13), 0).plans.map(plan => plan.id), [id(13), id(11), id(12)]);
  assert.deepEqual(withPlanAt(montage, id(12), 99).plans.map(plan => plan.id), [id(11), id(13), id(12)]);
  for (const [which, index] of [[id(11), 0], [id(12), 1], [id(13), 2], [id(99), 0]]) assert.equal(withPlanAt(montage, which, index), montage);
  // A sound dragged near a cut of the film (5 s, 8 s), near its start (0) or its end (12), starts on
  // it; else where it is, to the tenth of a second, never before the film. How near: the timeline says.
  assert.deepEqual([0.15, 4.85, 5.15, 5.26, 7.9, 11.85, 12.1, 3.14, -2].map(at => snapped(montage, at)), [0, 5, 5, 5.3, 8, 12, 12, 3.1, 0]);
  assert.deepEqual([4.6, 5.45, 5.57].map(at => snapped(montage, at, 0.5)), [5, 5, 5.6]);
  assert.deepEqual([4.96, 4.94].map(at => snapped(montage, at, 0.05)), [5, 4.9]);
  // Taken out: the others close the gap.
  const without = withoutItem(montage, id(12));
  assert.deepEqual([without.plans.map(plan => plan.id), planStarts(without), montageSeconds(without)], [[id(11), id(13)], [0, 5], 9]);
});

test('what is kept of a take stays within the take, and never shorter than a tenth of a second (0.6.137)', () => {
  let montage = withTake(empty(), clip(1, 5), { id: id(11) });
  montage = withTake(montage, record(2, 'image'), { id: id(12) });
  montage = withTake(montage, record(4, 'audio', { workflowName: 'Musique', parameters: { seconds: 30 } }), { id: id(13) });
  const plan = (changes, options) => withItemChanged(montage, id(11), changes, options).plans[0];
  assert.deepEqual([plan({ from: 1, to: 4 }).from, plan({ from: 1, to: 4 }).to], [1, 4]);
  // Its end never beyond the take, its start never after its end; a tenth of a second at least.
  assert.equal(plan({ to: 9 }, { longest: 5 }).to, 5);
  assert.equal(plan({ from: 7 }).from, 4.9);
  assert.equal(plan({ to: 0 }).to, 0.1);
  assert.equal(plan({ from: -3 }).from, 0);
  assert.deepEqual([plan({ frame: 'fill' }).frame, plan({ frame: 'stretch' }).frame], ['fill', 'fit']);
  assert.deepEqual([plan({ volume: 0.5 }).volume, plan({ volume: 9 }).volume, plan({ volume: -1 }).volume], [0.5, 2, 0]);
  // An image has a length and a frame, no start and no sound of its own.
  const still = changes => withItemChanged(montage, id(12), changes).plans[1];
  assert.deepEqual([still({ to: 8 }).to, still({ from: 2 }).from, still({ volume: 0.5 }).volume, still({ to: 9999 }).to], [8, 0, undefined, 600]);
  // A sound moves in the film, never before its start; it has no frame.
  const sound = changes => withItemChanged(montage, id(13), changes).sounds[0];
  assert.deepEqual([sound({ at: 4.26 }).at, sound({ at: -2 }).at, sound({ frame: 'fill' }).frame, sound({ volume: 0.3 }).volume], [4.26, 0, undefined, 0.3]);
  // Every change gives a montage the server keeps as it is; the one changed is left as it was.
  const changed = withItemChanged(withItemChanged(montage, id(11), { from: 0.5, to: 2.75, frame: 'fill', volume: 0 }), id(13), { at: 1.5, volume: 0.25 });
  assert.deepEqual(kept(changed).plans, changed.plans);
  assert.deepEqual(kept(changed).sounds, changed.sounds);
  assert.equal(montage.plans[0].to, 5);
  assert.equal(withItemChanged(montage, id(99), { to: 1 }).plans[0], montage.plans[0]);
});

test('a montage is said in a line, its times as a clock and as seconds (0.6.137)', () => {
  let montage = empty();
  assert.equal(montageSummary(montage), 'Aucun plan · 16:9 · 24 i/s');
  montage = withTake(montage, clip(1, 5), { id: id(11) });
  assert.equal(montageSummary(montage), '1 plan · 5 s · 16:9 · 24 i/s');
  montage = withTake(montage, clip(2, 9), { id: id(12) });
  assert.equal(montageSummary(montage), '2 plans · 14 s · 16:9 · 24 i/s');
  assert.deepEqual([0.5, 2.06, 14, 59.96, 65, 600].map(shownSeconds), ['0,5 s', '2,1 s', '14 s', '1 min 00 s', '1 min 05 s', '10 min 00 s']);
  assert.deepEqual([0, 6.9, 59.99, 61, 754].map(clock), ['00:00', '00:06', '00:59', '01:01', '12:34']);
  assert.deepEqual([usualSize('16:9'), usualSize('9:16'), usualSize('1:1'), usualSize('7:5')], [{ width: 1344, height: 768 }, { width: 768, height: 1344 }, { width: 1024, height: 1024 }, null]);
});
