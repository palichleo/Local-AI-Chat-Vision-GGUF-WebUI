import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MONTAGE_LIMITS,
  TODO_LIMITS,
  creationOf,
  isTodo,
  linkOf,
  montageSeconds,
  montageSummary,
  planStarts,
  todoPlans,
  withEndPulled,
  withItemChanged,
  withPhoto,
  withTake,
  withTodoMade,
  withoutItem,
  withoutPhoto,
} from '../public/montage-model.mjs';
import { assemblyOf, newMontage, validateMontage } from '../lib/montages.mjs';

// (0.6.142) The second step of the montage, his words of 20/11: the user lays photos on the timeline
// (« une image à 0 secondes, une image à 5 secondes, une autre image à 7 secondes »), « et le modèle
// s'occupe de combler les trous ». Here what a hand lays, and what is then asked for each plan to make.
const C = '11111111-1111-4111-8111-111111111111',
  id = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const record = (n, mediaType, more = {}) => ({ id: id(n), conversationId: C, mediaType, outputs: [{ take: n }], parameters: {}, ...more });
const photo = n => record(n, 'image'),
  clip = (n, seconds) => record(n, 'video', { parameters: { frames: seconds * 24, fps: 24 } }),
  source = n => ({ conversationId: C, runId: id(n), output: 0 });
const empty = () => newMontage({ id: id(900), now: '2026-11-20T10:00:00.000Z' });
const shape = montage => montage.plans.map(plan => [isTodo(plan) ? 'à faire' : plan.kind, plan.from, plan.to, plan.photos?.start?.runId ?? null, plan.photos?.end?.runId ?? null]);

test('his three photos, at 0, 5 and 7 seconds, are two plans to make (0.6.142)', () => {
  // The first photo on an empty film: a first plan that starts on it, of the usual length.
  let { montage, chosen } = withPhoto(empty(), photo(1), 0, { id: id(11) });
  assert.deepEqual([shape(montage), chosen], [[['à faire', 0, 5, id(1), null]], id(11)]);
  assert.deepEqual(montage.plans[0], { id: id(11), kind: 'video', todo: { prompt: '' }, from: 0, to: 5, frame: 'fit', volume: 1, photos: { start: source(1) } });
  // The second at the end of that plan: the photo it arrives on.
  ({ montage, chosen } = withPhoto(montage, photo(2), 5, { id: id(12) }));
  assert.deepEqual([shape(montage), chosen], [[['à faire', 0, 5, id(1), id(2)]], id(11)]);
  // The third further on: a second plan, from the end of the film to that photo; it has no start
  // photo of its own, it goes on from the first.
  ({ montage, chosen } = withPhoto(montage, photo(3), 7, { id: id(13) }));
  assert.deepEqual([shape(montage), chosen], [[['à faire', 0, 5, id(1), id(2)], ['à faire', 0, 2, null, id(3)]], id(13)]);
  assert.deepEqual([planStarts(montage), montageSeconds(montage), todoPlans(montage).length], [[0, 5], 7, 2]);
  // The server keeps it as it is.
  assert.deepEqual(validateMontage(montage).plans, montage.plans);
});

test('where a photo is laid says what it becomes (0.6.142)', () => {
  const first = withPhoto(empty(), photo(1), 3.2, { id: id(11) }).montage;
  assert.deepEqual(shape(first), [['à faire', 0, 5, id(1), null]], 'on an empty film, wherever it is laid');
  // After the end, a plan to make that has no end photo yet takes it, and ends where it is laid;
  // never longer than a clip can be.
  assert.deepEqual(shape(withPhoto(first, photo(2), 7.04, { id: id(12) }).montage), [['à faire', 0, 7, id(1), id(2)]]);
  assert.deepEqual(shape(withPhoto(first, photo(2), 40, { id: id(12) }).montage), [['à faire', 0, TODO_LIMITS.longest, id(1), id(2)]]);
  // Laid just at the end of a film whose last plan is made, or has its end photo: a new plan of the usual length.
  const ended = withPhoto(first, photo(2), 5, { id: id(12) }).montage;
  assert.deepEqual(shape(withPhoto(ended, photo(3), 5.3, { id: id(13) }).montage).at(-1), ['à faire', 0, TODO_LIMITS.usual, null, id(3)]);
  // On a plan to make: its start photo on its first half, its end photo on the second (the last laid replaces).
  assert.deepEqual(shape(withPhoto(ended, photo(4), 1, { id: id(14) }).montage), [['à faire', 0, 5, id(4), id(2)]]);
  assert.deepEqual(shape(withPhoto(ended, photo(4), 4, { id: id(14) }).montage), [['à faire', 0, 5, id(1), id(4)]]);
  // A clip or a sound is no photo; a photo is not laid above an image.
  for (const other of [clip(5, 5), record(6, 'audio', { parameters: { seconds: 9 } })]) {
    const tried = withPhoto(ended, other, 2, { id: id(15) });
    assert.equal(tried.montage, ended);
    assert.match(tried.reason, /^Seule une image/);
  }
  const still = withTake(empty(), photo(7), { id: id(17) });
  assert.match(withPhoto(still, photo(8), 1, { id: id(18) }).reason, /pas d’une image\.$/);
  assert.equal(withPhoto(still, photo(8), 1, { id: id(18) }).montage, still);
  // A full montage takes no plan more.
  const full = { ...empty(), plans: Array.from({ length: MONTAGE_LIMITS.plans }, (_, n) => ({ id: id(n + 100), source: source(5), kind: 'video', from: 0, to: 1, frame: 'fit', volume: 1 })) };
  assert.equal(withPhoto(full, photo(9), 999, { id: id(19) }).reason, 'Ce montage est plein.');
});

test('a photo laid above a video cuts it there: the film will cut on the photo (0.6.142)', () => {
  // « ça a pour conséquence de griser clairement la suite de la vidéo sur laquelle il a posé l'image »,
  // then « ça efface la suite de la vidéo (à partir de l'endroit où il l'a posé) », and « Coupe sur la photo ».
  const laid = withTake(empty(), clip(5, 10), { id: id(15) });
  const { montage, chosen } = withPhoto(laid, photo(2), 6.04, { id: id(16) });
  assert.equal(chosen, id(16));
  assert.deepEqual(shape(montage), [['video', 0, 6, null, null], ['à faire', 0, 4, id(2), null]]);
  // What it takes the place of is kept: shown greyed until the clip is made, given back if it is taken out.
  assert.deepEqual(montage.plans[1].replaces, { source: source(5), from: 6, to: 10 });
  assert.equal(montageSeconds(montage), 10, 'the film is as long as it was');
  assert.deepEqual(validateMontage(montage).plans, montage.plans);
  assert.deepEqual(withoutItem(montage, id(16)).plans, laid.plans);
  // (Given back only to the video it was taken from, as it was left: cut again since, it stays as it is.)
  const again = withItemChanged(montage, id(15), { to: 4 }, { longest: 10 });
  assert.deepEqual(shape(withoutItem(again, id(16))), [['video', 0, 4, null, null]]);
  // A video shown from its third second: the cut is counted in its take.
  const part = withItemChanged(laid, id(15), { from: 2, to: 9 }, { longest: 10 });
  const cut = withPhoto(part, photo(2), 3, { id: id(16) }).montage;
  assert.deepEqual([shape(cut), cut.plans[1].replaces], [[['video', 2, 5, null, null], ['à faire', 0, 4, id(2), null]], { source: source(5), from: 5, to: 9 }]);
  // Too near its start, nothing of it would be left; too near its end, nothing to replace.
  assert.match(withPhoto(laid, photo(2), 0.3, { id: id(16) }).reason, /^Posez la photo plus loin/);
  assert.match(withPhoto(laid, photo(2), 9.5, { id: id(16) }).reason, /^Posez la photo plus tôt/);
  assert.equal(withPhoto(laid, photo(2), 9.5, { id: id(16) }).montage, laid);
});

test('a plan to make has a length a clip can have, a text, and photos that can be taken off (0.6.142)', () => {
  let montage = withPhoto(empty(), photo(1), 0, { id: id(11) }).montage;
  montage = withPhoto(montage, photo(2), 5, { id: id(12) }).montage;
  const plan = changes => withItemChanged(montage, id(11), changes).plans[0];
  assert.deepEqual([plan({ to: 8.26 }).to, plan({ to: 0.2 }).to, plan({ to: 99 }).to], [8.3, TODO_LIMITS.shortest, TODO_LIMITS.longest]);
  assert.deepEqual([plan({ from: 3 }).from, plan({ frame: 'fill' }).frame], [0, 'fill']);
  assert.equal(plan({ prompt: 'Il lève les yeux.' }).todo.prompt, 'Il lève les yeux.');
  assert.equal(plan({ prompt: 'x'.repeat(5000) }).todo.prompt.length, TODO_LIMITS.prompt);
  assert.equal(montage.plans[0].todo.prompt, '', 'the montage handed over is never changed in place');
  // A photo taken off: the other stays; the last one leaves nothing behind.
  const one = withoutPhoto(montage, id(11), 'end');
  assert.deepEqual(one.plans[0].photos, { start: source(1) });
  assert.equal('photos' in withoutPhoto(one, id(11), 'start').plans[0], false);
  assert.deepEqual(withoutPhoto(one, id(11), 'end').plans, one.plans);
  assert.deepEqual(validateMontage(withoutPhoto(one, id(11), 'start')).plans, withoutPhoto(one, id(11), 'start').plans);
  // What the head of the timeline says.
  assert.equal(montageSummary(montage), '1 plan à faire · 5 s · 16:9 · 24 i/s');
  const mixed = withTake(montage, clip(5, 5), { id: id(15) });
  assert.equal(montageSummary(mixed), '2 plans dont 1 à faire · 10 s · 16:9 · 24 i/s');
  assert.equal(montageSummary(withTake(empty(), clip(5, 5), { id: id(15) })), '1 plan · 5 s · 16:9 · 24 i/s');
});

test('what is asked for a plan to make is read on the montage (0.6.142)', () => {
  let montage = withPhoto(empty(), photo(1), 0, { id: id(11) }).montage;
  montage = withPhoto(montage, photo(2), 5, { id: id(12) }).montage;
  montage = withPhoto(montage, photo(3), 7, { id: id(13) }).montage;
  // Nothing to ask without what happens in it.
  assert.deepEqual(creationOf(montage, id(11)), { reason: 'Écrivez ce qui se passe dans ce plan.' });
  montage = withItemChanged(montage, id(11), { prompt: '  Il lève les yeux.  ' });
  montage = withItemChanged(montage, id(13), { prompt: 'Il regarde la mer.' });
  // Between its two photos: a new clip of its length, at the format of the film.
  assert.deepEqual(creationOf(montage, id(11)), {
    verb: 'create_video', prompt: 'Il lève les yeux.', duration: 5, format: '16:9', end: { source: source(2) }, from: 0, start: { source: source(1) },
  });
  // The second goes on from the first, which is not made yet.
  assert.deepEqual(creationOf(montage, id(13)), { reason: 'Créez d’abord le plan 1 : celui-ci le continue.' });
  // The first made (a clip of 5,04 s): the second starts on its last image and arrives on its own photo.
  const first = record(21, 'video', { parameters: { frames: 121, fps: 24 } });
  const made = withTodoMade(montage, id(11), first);
  assert.deepEqual(made.plans[0], { id: id(11), kind: 'video', from: 0, to: 5.042, frame: 'fit', volume: 1, photos: { start: source(1), end: source(2) }, source: source(21) });
  assert.deepEqual(validateMontage(made).plans, made.plans);
  const lengthOf = wanted => (wanted.runId === id(21) ? 5.042 : null);
  assert.deepEqual(creationOf(made, id(13), lengthOf), {
    verb: 'create_video', prompt: 'Il regarde la mer.', duration: 2, format: '16:9', end: { source: source(3) }, from: 0, start: { source: source(21), frame: 'last' },
  });
  // Without an end photo it is the continuation itself: no format (it keeps the size of its video),
  // and its file holds the video first: the plan will show it from where that video ends.
  const plain = withoutPhoto(made, id(13), 'end');
  assert.deepEqual(creationOf(plain, id(13), lengthOf), { verb: 'extend_video', prompt: 'Il regarde la mer.', duration: 2, from: 5.042, continues: source(21) });
  const whole = record(22, 'video', { parameters: { frames: 49, fps: 24, continuation: { overlapFrames: 9, sourceFrames: 121, newFrames: 40 } } });
  const continued = withTodoMade(plain, id(13), whole, { from: 5.042 });
  assert.deepEqual([continued.plans[1].source, continued.plans[1].from, continued.plans[1].to, isTodo(continued.plans[1])], [source(22), 5.042, 6.708, false]);
  assert.deepEqual(validateMontage(continued).plans, continued.plans);
  // A video cut before the end of its take cannot be continued: said, with what to do.
  const shortened = withItemChanged(plain, id(11), { to: 3 }, { longest: 5.042 });
  assert.match(creationOf(shortened, id(13), lengthOf).reason, /^Le plan 1 est coupé avant la fin de sa prise/);
  assert.match(creationOf(plain, id(13), () => null).reason, /^Le plan 1 est coupé/, 'a take nobody knows the length of');
  // With a start photo it needs nothing of what is before it (the film cuts on the photo).
  const cut = withPhoto(withTake(empty(), clip(5, 10), { id: id(15) }), photo(2), 6, { id: id(16) }).montage;
  assert.deepEqual(creationOf(withItemChanged(cut, id(16), { prompt: 'Le soleil perce.' }), id(16)), {
    verb: 'create_video', prompt: 'Le soleil perce.', duration: 4, format: '16:9', from: 0, start: { source: source(2) },
  });
  // First of the film, or after an image, with no photo: a clip from its text alone.
  const alone = { ...empty(), plans: [{ id: id(31), kind: 'video', todo: { prompt: 'La mer.' }, from: 0, to: 3, frame: 'fit', volume: 1 }] };
  assert.deepEqual(creationOf(alone, id(31)), { verb: 'create_video', prompt: 'La mer.', duration: 3, format: '16:9', from: 0 });
  const afterStill = { ...alone, plans: [withTake(empty(), photo(7), { id: id(17) }).plans[0], ...alone.plans] };
  assert.equal(creationOf(afterStill, id(31)).verb, 'create_video');
  assert.deepEqual(creationOf(made, id(11)), { reason: 'Ce plan est déjà fait.' });
  assert.deepEqual(creationOf(made, id(99)), { reason: 'Ce plan est déjà fait.' });
});

test('the server keeps a plan to make as it is, and refuses what is none (0.6.142)', async () => {
  let montage = withPhoto(empty(), photo(1), 0, { id: id(11) }).montage;
  montage = withItemChanged(withPhoto(montage, photo(2), 5, { id: id(12) }).montage, id(11), { prompt: 'Il lève les yeux.' });
  assert.deepEqual(validateMontage(montage).plans, montage.plans);
  const plan = montage.plans[0];
  const tried = changes => () => validateMontage({ ...montage, plans: [{ ...plan, ...changes }] });
  for (const [changes, said] of [
    [{ source: source(5) }, /un plan à faire est une vidéo sans prise/],
    [{ kind: 'image' }, /un plan à faire est une vidéo sans prise/],
    [{ from: 1 }, /un plan à faire est une vidéo sans prise/],
    [{ to: 0.5 }, /durée invalide/],
    [{ to: 21 }, /durée invalide/],
    [{ todo: {} }, /texte du plan à faire invalide/],
    [{ todo: { prompt: 'x'.repeat(4001) } }, /texte du plan à faire invalide/],
    [{ photos: { middle: source(1) } }, /photos invalides/],
    [{ photos: { start: { runId: 'x' } } }, /photo : prise invalide/],
    [{ replaces: { source: source(5), from: 6, to: 6 } }, /ce qu’il remplace est invalide/],
    [{ replaces: { from: 1, to: 2 } }, /prise invalide/],
  ])
    assert.throws(tried(changes), said, JSON.stringify(changes).slice(0, 60));
  // Nothing else is carried over; a plan made keeps its photos, an image may have some too.
  assert.equal('extra' in validateMontage({ ...montage, plans: [{ ...plan, extra: 1 }] }).plans[0], false);
  const made = withTodoMade(montage, id(11), clip(21, 5));
  assert.deepEqual(validateMontage(made).plans[0].photos, { start: source(1), end: source(2) });
  // A film is made of takes: nothing is assembled while a plan is to make.
  const mixed = withTake(montage, clip(5, 5), { id: id(15), index: 0 });
  await assert.rejects(assemblyOf(validateMontage(mixed), async () => 'D:/x.mp4'), /Le plan 2 est encore à faire : créez-le ou retirez-le avant d’exporter le film\./);
  assert.equal((await assemblyOf(validateMontage(made), async () => 'D:/x.mp4')).plans.length, 1);
});

test('the end of a video pulled beyond its take asks for its continuation, right after it (0.6.143)', () => {
  // His words of 20/11: « s'il déroule la vidéo plus loin que sa durée d'origine, on lui montre
  // implicitement que ça va continuer sa vidéo (et ça déplace les images ou vidéos vers la droite) ».
  const film = withTake(withTake(empty(), clip(5, 5), { id: id(15) }), photo(7), { id: id(17) }),
    still = shape(film)[1],
    pull = (to, from = film) => withEndPulled(from, id(15), to, { longest: 5, suiteId: id(40) });
  // Within its take: what is kept of it, as before.
  assert.deepEqual(shape(pull(3)), [['video', 0, 3, null, null], still]);
  // At its end and a little beyond: the whole take, nothing more (the hand can stop there).
  assert.deepEqual(shape(pull(5.4)), shape(film));
  // Beyond: the take whole, then what exceeds, to make; the image comes later in the film.
  const longer = pull(9);
  assert.deepEqual(shape(longer), [['video', 0, 5, null, null], ['à faire', 0, 4, null, null], still]);
  assert.deepEqual([longer.plans[1].id, longer.plans[1].todo, planStarts(longer)], [id(40), { prompt: '' }, [0, 5, 9]]);
  assert.deepEqual(validateMontage(longer).plans, longer.plans);
  // Read on the montage as it was pressed: further, as short as a clip can be, as long, back within the take.
  assert.deepEqual([pull(11.52).plans[1].to, pull(5.5).plans[1].to, pull(60).plans[1].to], [6.5, TODO_LIMITS.shortest, TODO_LIMITS.longest]);
  assert.deepEqual(shape(pull(4.2)), [['video', 0, 4.2, null, null], still]);
  // A video cut before its end: its end comes back first, then its continuation.
  const cut = withItemChanged(film, id(15), { to: 2 }, { longest: 5 });
  assert.deepEqual(shape(pull(7, cut)), [['video', 0, 5, null, null], ['à faire', 0, 2, null, null], still]);
  // It has its continuation to make already: its edge stops at the end of its take, that one has its own edge.
  assert.deepEqual(shape(withEndPulled(longer, id(15), 12, { longest: 5, suiteId: id(41) })), shape(longer));
  assert.equal(withItemChanged(longer, id(40), { to: 6 }).plans[1].to, 6);
  // Not for an image (its edge is its length), a plan to make, or a take nobody knows the length of.
  assert.deepEqual(withEndPulled(film, id(17), 9, { longest: 3, suiteId: id(42) }).plans.map(plan => plan.id), [id(15), id(17)]);
  assert.deepEqual(withEndPulled(longer, id(40), 9, { longest: 4, suiteId: id(42) }).plans.map(plan => plan.to), [5, 9, still[2]]);
  assert.equal(withEndPulled(film, id(15), 9, { longest: null, suiteId: id(42) }).plans.length, 2);
  assert.equal(withEndPulled(film, id(15), 9, { longest: 5 }).plans.length, 2, 'no name for the continuation: none');
  // A montage that is full takes no plan more.
  const full = { ...film, plans: [film.plans[0], ...Array.from({ length: MONTAGE_LIMITS.plans - 1 }, (_, at) => ({ ...film.plans[1], id: id(100 + at) }))] };
  assert.equal(withEndPulled(full, id(15), 9, { longest: 5, suiteId: id(42) }).plans.length, MONTAGE_LIMITS.plans);
});

test('what a plan to make goes on from is read on the montage, once for what is asked and what is shown (0.6.143)', () => {
  const lengthOf = wanted => (wanted.runId === id(5) ? 5 : null),
    film = withTake(empty(), clip(5, 5), { id: id(15) }),
    suite = withEndPulled(film, id(15), 8, { longest: 5, suiteId: id(40) });
  // After a video shown to the end of its take: its continuation.
  assert.deepEqual(linkOf(suite, id(40), lengthOf), { kind: 'suite', before: 1, whole: 5 });
  assert.equal(creationOf(withItemChanged(suite, id(40), { prompt: 'Il se lève.' }), id(40), lengthOf).verb, 'extend_video');
  // With an end photo: a clip from the last image of that video. With a start photo: from that photo.
  const toPhoto = withPhoto(suite, photo(2), 7.5, { id: id(41) }).montage,
    fromPhoto = withPhoto(suite, photo(2), 5.5, { id: id(41) }).montage;
  assert.deepEqual([toPhoto.plans[1].photos, fromPhoto.plans[1].photos], [{ end: source(2) }, { start: source(2) }]);
  assert.deepEqual(linkOf(toPhoto, id(40), lengthOf), { kind: 'last', before: 1, whole: 5 });
  assert.deepEqual(linkOf(fromPhoto, id(40), lengthOf), { kind: 'photo' });
  // The video cut before its end, or of a length nobody knows; the plan before still to make.
  assert.deepEqual(linkOf(withItemChanged(suite, id(15), { to: 3 }, { longest: 5 }), id(40), lengthOf), { kind: 'cut', before: 1 });
  assert.deepEqual(linkOf(suite, id(40)), { kind: 'cut', before: 1 });
  const then = { ...suite, plans: [...suite.plans, { id: id(43), kind: 'video', todo: { prompt: '' }, from: 0, to: 2, frame: 'fit', volume: 1 }] };
  assert.deepEqual(linkOf(then, id(43), lengthOf), { kind: 'wait', before: 2 });
  // Nothing before it, or an image: a clip of its own. A plan that is made, or none: not one to make.
  assert.deepEqual(linkOf({ ...suite, plans: [suite.plans[1]] }, id(40), lengthOf), { kind: 'own' });
  assert.deepEqual(linkOf({ ...suite, plans: [withTake(empty(), photo(7), { id: id(17) }).plans[0], suite.plans[1]] }, id(40), lengthOf), { kind: 'own' });
  assert.deepEqual([linkOf(suite, id(15), lengthOf), linkOf(suite, id(99), lengthOf)], [{ kind: 'made' }, { kind: 'made' }]);
});

test('a video given its end back by hand is no longer said replaced (0.6.143)', () => {
  const cut = withPhoto(withTake(empty(), clip(5, 10), { id: id(15) }), photo(2), 6, { id: id(16) }).montage;
  assert.deepEqual(cut.plans[1].replaces, { source: source(5), from: 6, to: 10 });
  // Its edge pulled a little: more of it is kept, its end is still what the plan after it replaces.
  assert.deepEqual(withItemChanged(cut, id(15), { to: 8 }, { longest: 10 }).plans[1].replaces, cut.plans[1].replaces);
  // Pulled to the end of its take: whole again; the plan after it is a clip of its own, on its photo.
  const whole = withItemChanged(cut, id(15), { to: 10 }, { longest: 10 });
  assert.deepEqual([whole.plans[0].to, whole.plans[1].replaces, whole.plans[1].photos], [10, undefined, { start: source(2) }]);
  assert.deepEqual(validateMontage(whole).plans, whole.plans);
  assert.deepEqual(shape(withoutItem(whole, id(16))), [['video', 0, 10, null, null]]);
  // And beyond: its continuation comes between the two.
  const beyond = withEndPulled(cut, id(15), 12, { longest: 10, suiteId: id(40) });
  assert.deepEqual(shape(beyond), [['video', 0, 10, null, null], ['à faire', 0, 2, null, null], ['à faire', 0, 4, id(2), null]]);
  assert.equal(beyond.plans[2].replaces, undefined);
  // (Another video before it, or a plan to make: what it says is left as it is.)
  const other = { ...cut, plans: [withTake(empty(), clip(6, 20), { id: id(18) }).plans[0], cut.plans[1]] };
  assert.deepEqual(withItemChanged(other, id(18), { to: 12 }, { longest: 20 }).plans[1].replaces, cut.plans[1].replaces);
});
