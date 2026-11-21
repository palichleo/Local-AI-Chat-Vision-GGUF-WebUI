import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../public/montage-model.mjs';
import { withArrangement } from '../public/montage-arrange.mjs';
import { newMontage, validateMontage } from '../lib/montages.mjs';

// (Relecture du 21/11) The gestures of the Bobine (public/montage-model.mjs), and the plans of Moodix AI
// (public/montage-arrange.mjs), drawn at random from a fixed seed: after each of them, the bobine must be
// one the server keeps (lib/montages.mjs validateMontage) — the page keeps it a moment later, and one the
// server refuses is not kept at all any more — and its plans one after the other, none over the one before.
// The first run found takes brought to their shortest (0.1 s) refused by a rounding of the server.

/** Numbers drawn from `seed`, always the same (mulberry32). */
function drawn(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function walk(seed, runs, steps) {
  const random = drawn(seed),
    pick = list => list[Math.floor(random() * list.length)],
    between = (low, high) => low + random() * (high - low);
  let counter = 0;
  const newId = () => `0000000${++counter % 10}-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
  const conversation = newId();
  // The takes of the project: videos of all lengths (one a continuation), images, sounds.
  const records = Array.from({ length: 14 }, (_, at) => {
    const take = at + 1,
      kind = take <= 6 ? 'video' : take <= 11 ? 'image' : 'audio';
    return {
      id: newId(),
      conversationId: conversation,
      mediaType: kind,
      workflowName: kind === 'audio' ? (take % 2 ? 'ACE-Step' : 'MOSS-SFX') : 'LTX 2.5',
      prompt: 'Prise ' + take,
      parameters:
        kind === 'video'
          ? { fps: 24, frames: Math.round(between(24, 600)), ...(take === 5 ? { continuation: { sourceFrames: 120, newFrames: 96 } } : {}) }
          : kind === 'audio'
            ? { seconds: between(1, 60) }
            : {},
      outputs: [{ take }],
    };
  });
  const recordOf = source => records.find(record => record.id === source?.runId) ?? null,
    lengthOf = source => model.takeSeconds(recordOf(source)),
    // (As the page gives it, popOf: the length of the take of an element, when it is known.)
    longestOf = item => (item?.source ? lengthOf(item.source) : null),
    end = montage => model.montageSeconds(montage);
  const gestures = {
    take: m =>
      model.withTake(m, pick(records), {
        id: newId(),
        ...(random() < 0.5 ? { at: between(0, end(m) + 10), near: pick([0, 0.2]) } : random() < 0.5 ? { index: Math.floor(between(0, m.plans.length + 1)) } : {}),
      }),
    remove: m => (m.plans.length || m.sounds.length ? model.withoutItem(m, pick([...m.plans, ...m.sounds]).id) : m),
    move: m => (m.plans.length ? model.withPlanMoved(m, pick(m.plans).id, pick([-1, 1])) : m),
    place: m => (m.plans.length ? model.withPlanPlaced(m, pick(m.plans).id, between(0, end(m) + 5), { near: pick([0, 0.2]) }) : m),
    change: m => {
      const items = [...m.plans, ...m.sounds];
      if (!items.length) return m;
      const item = pick(items);
      const changes = pick([
        { to: between(-1, 700) },
        { from: between(-1, 60) },
        { volume: between(-1, 3) },
        { at: between(-5, 100) },
        { frame: pick(['fit', 'fill', 'x']) },
        { prompt: pick(['', 'Un phare.', 'x'.repeat(5000)]) },
        { to: between(0, 80), from: between(0, 40) },
      ]);
      return model.withItemChanged(m, item.id, changes, { longest: longestOf(item) });
    },
    pull: m => {
      const videos = m.plans.filter(plan => plan.kind === 'video' && !model.isTodo(plan));
      if (!videos.length) return m;
      const plan = pick(videos),
        longest = longestOf(plan);
      return model.withEndPulled(m, plan.id, between(0, (longest ?? 10) + 30), { longest, suiteId: newId() });
    },
    draw: m => model.withTodoDrawn(m, { id: newId(), at: between(0, end(m) + 20), seconds: between(-2, 90) }).montage,
    photo: m => model.withPhoto(m, pick(records), between(0, end(m) + 10), { id: newId() }).montage,
    photoIn: m => {
      const todos = model.todoPlans(m);
      return todos.length ? model.withPhotoIn(m, pick(records), pick(todos).id, pick(['start', 'end'])).montage : m;
    },
    unphoto: m => {
      const todos = model.todoPlans(m);
      return todos.length ? model.withoutPhoto(m, pick(todos).id, pick(['start', 'end'])) : m;
    },
    made: m => {
      const todos = model.todoPlans(m);
      if (!todos.length) return m;
      return model.withTodoMade(m, pick(todos).id, pick(records.filter(record => record.mediaType === 'video')), {
        from: pick([0, between(0, 10)]),
        limits: pick([{}, { create_video: 10, extend_video: 5 }]),
        partId: pick([null, newId()]),
      });
    },
    arrange: m => {
      const add = Array.from({ length: Math.floor(between(0, 5)) }, () =>
        random() < 0.3
          ? { take: Math.floor(between(0, 16)), seconds: pick([null, between(-1, 700)]) }
          : { text: 'A ship climbs.', seconds: pick([null, between(-5, 90)]), link: pick(['suite', 'cut']), start: pick([null, Math.floor(between(1, 15))]), end: pick([null, Math.floor(between(1, 15))]) },
      );
      const fill = m.plans.length ? [{ block: Math.floor(between(0, m.plans.length + 2)), text: 'Filled.' }] : [];
      return withArrangement(m, { say: '', fill, add }, { takes: records, newId, lengthOf }).montage;
    },
  };
  const names = Object.keys(gestures);
  let done = 0;
  for (let run = 0; run < runs; run++) {
    let montage = newMontage({ id: newId(), now: '2026-11-21T10:00:00.000Z' });
    const said = [];
    for (let step = 0; step < steps; step++) {
      const name = pick(names);
      said.push(name);
      montage = gestures[name](montage);
      const where = `graine ${seed}, suite ${run}, geste ${step} : ${said.slice(-6).join(' ')}`;
      let last = 0;
      for (const plan of model.placed(montage).plans) {
        assert.ok(plan.at >= last - 1e-6, `${where} : une prise passe sur la précédente`);
        last = plan.at + plan.to - plan.from;
      }
      assert.doesNotThrow(() => validateMontage(JSON.parse(JSON.stringify(montage))), where);
      done++;
    }
  }
  return done;
}

test('whatever the gestures of the Bobine and the plans of Moodix AI, the server keeps the bobine (relecture du 21/11)', () => {
  // About 36 000 gestures in all, a second or so.
  let done = 0;
  for (const seed of [1, 2, 3]) done += walk(seed, 200, 60);
  assert.equal(done, 36000);
});
