/**
 * (0.6.137) What the page and the server both know of a montage (lib/montages.mjs keeps it, public/
 * montage.mjs shows it): its sizes, its length, and what a hand does to it on the timeline. Every
 * change returns a new montage; none is made in place. The server checks what it is sent in any case.
 */
import { FORMATS } from './formats.mjs';
import { takeSeconds as lengthOf } from './take-length.mjs';

/** Frames a second of a film. LTX 2.5 and MiniMax H3 draw 24; a take at another rate is brought to it. */
export const MONTAGE_RATES = Object.freeze([24]);
export const MONTAGE_LIMITS = Object.freeze({ plans: 200, sounds: 64, name: 80, shortest: 0.1, longest: 600 });
/** How long an image is shown when it is laid on the timeline, and a take whose length is not known. */
export const STILL_SECONDS = 3;

const round = value => Math.round(value * 1000) / 1000;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** The sizes a film of this format may have: those of the format, from 512 px wide or high. */
export function montageSizes(format) {
  const found = FORMATS.find(item => item.id === format);
  return found ? found.sizes.filter(size => Math.max(size.width, size.height) >= 512) : [];
}
/** The usual size of a format: about a million points (1344 x 768 for 16:9, 1024 x 1024 for a square). */
export function usualSize(format) {
  const sizes = montageSizes(format),
    points = size => Math.abs(size.width * size.height - 1344 * 768);
  return sizes.length ? sizes.reduce((best, item) => (points(item) < points(best) ? item : best)) : null;
}

// ------------------------------------------------------------------ the instants (0.6.149)
/**
 * (0.6.149, La Bobine, lot 2) Each plan is at its instant of the bobine (`at`, in seconds), in the order
 * of the list, none over the one before it; between two of them there may be a hole, black in the
 * film (« Elle reste où on l'a dessinée, sans se coller à la fin : le trou d'avant reste »). What
 * touches a plan follows it: a plan made shorter or longer takes with it those glued after it, a
 * plan taken out leaves them where it was; what is pushed is pushed only as far as it must be.
 */
const NEAR = 0.002;
const long = plan => plan.to - plan.from;
const endOf = plan => round(plan.at + long(plan));
/** Plans in their order, none over the one before it: what overlaps is pushed later, nothing else moves. */
function settled(plans) {
  let end = 0;
  return plans.map(plan => {
    const at = round(Math.max(Number.isFinite(plan.at) ? plan.at : end, end));
    end = round(at + long(plan));
    return at === plan.at ? plan : { ...plan, at };
  });
}
/** Whether the plan at `index` touches what is before it (the one before, or the start of the bobine). */
const gluedBefore = (plans, index) => (index ? Math.abs(plans[index].at - endOf(plans[index - 1])) < NEAR : plans[0].at < NEAR);
/** The plans right after the one at `index` that touch it, each touching the one before it. */
function gluedAfter(plans, index) {
  const chain = [];
  for (let at = index + 1; at < plans.length && Math.abs(plans[at].at - endOf(plans[at - 1])) < NEAR; at++) chain.push(at);
  return chain;
}
const moved = (plans, indices, delta) =>
  delta ? plans.map((plan, at) => (indices.includes(at) ? { ...plan, at: round(Math.max(0, plan.at + delta)) } : plan)) : plans;

/**
 * `montage` with each plan at its instant. A bobine kept before 0.6.149 had none: its plans followed
 * one another, and a plan to make without a start photo right after a video or another plan to make
 * went on from it. They are laid end to end as they were shown, and those continuations are said
 * as such (`todo.suite`): only a suite goes on from what is before it now.
 */
export function placed(montage) {
  const plans = montage.plans ?? [];
  const old = plans.some(plan => !Number.isFinite(plan.at));
  const marked = old
    ? plans.map((plan, index) => {
        const before = plans[index - 1];
        if (Number.isFinite(plan.at) || !isTodo(plan) || plan.todo.suite || plan.photos?.start || !before || before.kind !== 'video') return plan;
        return { ...plan, todo: { ...plan.todo, suite: true } };
      })
    : plans;
  const next = settled(marked);
  return next.every((plan, index) => plan === plans[index]) ? montage : { ...montage, plans: next };
}

/** How long the film is, in seconds: to the end of its last plan (a sound never makes it longer). */
export function montageSeconds(montage) {
  const { plans } = placed(montage);
  return plans.length ? endOf(plans.at(-1)) : 0;
}

/** When each plan starts in the film, in seconds, in the order of the list. */
export const planStarts = montage => placed(montage).plans.map(plan => plan.at);

/**
 * The plan shown at `seconds` of the film: { plan, index, start }; the last one at its very end or
 * beyond; null in a hole of the bobine, or without plans.
 */
export function planAt(montage, seconds) {
  const { plans } = placed(montage);
  if (!plans.length) return null;
  if (seconds >= endOf(plans.at(-1))) return { plan: plans.at(-1), index: plans.length - 1, start: plans.at(-1).at };
  const index = plans.findIndex(plan => plan.at <= seconds + 1e-9 && seconds < endOf(plan));
  return index < 0 ? null : { plan: plans[index], index, start: plans[index].at };
}

/**
 * (0.6.149) The hole of the bobine around `seconds`: { from, to } (`to`: Infinity after its end), or
 * null on a plan. Where a plan can be drawn, and where its ghost goes.
 */
export function holeAt(montage, seconds) {
  const { plans } = placed(montage);
  let from = 0;
  for (const plan of plans) {
    if (seconds < plan.at) return { from, to: plan.at };
    if (seconds < endOf(plan)) return null;
    from = endOf(plan);
  }
  return { from, to: Infinity };
}

/**
 * Where a plan (or plans that stay together, `block`) laid at `seconds` goes among `plans`: on a
 * plan, before it on its first half and after it on its second; in a hole, where it is laid, or
 * against the edge of a neighbour within `near` seconds. What it then overlaps is pushed later.
 */
function laidAt(plans, block, seconds, near = 0) {
  const length = block.reduce((sum, plan) => sum + long(plan), 0);
  let start = Math.max(0, seconds),
    index = plans.findIndex(plan => plan.at <= start && start < endOf(plan));
  if (index >= 0) {
    const on = plans[index];
    // (Past its middle: after it.)
    if (start > on.at + long(on) / 2) {
      start = endOf(on);
      index++;
    } else start = on.at;
  } else {
    index = plans.filter(plan => plan.at < start).length;
    const before = plans[index - 1],
      after = plans[index];
    if (near && before && start - endOf(before) <= near) start = endOf(before);
    else if (near && after && after.at - (start + length) <= near && after.at - length >= (before ? endOf(before) : 0)) start = after.at - length;
    else if (near && !before && start <= near) start = 0;
  }
  let at = start;
  const laid = block.map(plan => {
    const placedPlan = { ...plan, at: round(at) };
    at += long(plan);
    return placedPlan;
  });
  const next = [...plans];
  next.splice(index, 0, ...laid);
  return settled(next);
}

/**
 * Where a creation of the project goes when it is laid: 'video' or 'image' on the plans, 'music' or
 * 'effects' on the sounds (a sound of the music model, or of more than twenty seconds, is a music).
 */
export function trackOf(record) {
  const media = record?.mediaType || 'image';
  if (media !== 'audio') return media === 'video' ? 'video' : 'image';
  const seconds = Number(record.parameters?.seconds) || 0;
  return /musi|ace-?step|song/i.test(record.workflowName || '') || seconds > 20 ? 'music' : 'effects';
}
/**
 * The length of a creation in seconds, from its record; null for an image or when nothing says it.
 * A clip continued is as long as its file, the clip it continues counted (take-length.mjs, 0.6.141:
 * the frames it generated alone left the end of the take out of reach).
 */
export function takeSeconds(record) {
  const seconds = lengthOf(record);
  return seconds > 0 ? round(seconds) : null;
}

const sourceOf = (record, output = 0) => ({ conversationId: record.conversationId, runId: record.id, output });

/**
 * `montage` with a creation of the project laid on it: a video or an image as a plan, a sound on its
 * track from `at` seconds (the start by default). A plan goes at the end of the bobine by default; at
 * `index` among the others (it takes the place of the one there, which is pushed later with what
 * touches it); or laid at `at` seconds (0.6.149, laidAt: in a hole it stays where it is laid, against
 * a neighbour within `near` seconds). `id`: the identifier of the new element. A take already there
 * may be laid again: a film may show it twice.
 */
export function withTake(montage, record, { id, index, at, track: lane, near = 0 } = {}) {
  const track = trackOf(record),
    length = takeSeconds(record);
  // (A bobine that is full is handed back as it is.)
  if ((track === 'video' || track === 'image' ? montage.plans.length >= MONTAGE_LIMITS.plans : montage.sounds.length >= MONTAGE_LIMITS.sounds)) return montage;
  montage = placed(montage);
  if (track === 'video' || track === 'image') {
    const plan =
      track === 'image'
        ? { id, source: sourceOf(record), kind: 'image', from: 0, to: STILL_SECONDS, frame: 'fit' }
        : { id, source: sourceOf(record), kind: 'video', from: 0, to: clamp(length ?? STILL_SECONDS, MONTAGE_LIMITS.shortest, MONTAGE_LIMITS.longest), frame: 'fit', volume: 1 };
    if (at !== undefined && index === undefined) return { ...montage, plans: laidAt(montage.plans, [plan], at, near) };
    const place = clamp(index ?? montage.plans.length, 0, montage.plans.length),
      plans = [...montage.plans];
    plans.splice(place, 0, { ...plan, at: place < plans.length ? plans[place].at : montageSeconds(montage) });
    return { ...montage, plans: settled(plans) };
  }
  if (montage.sounds.length >= MONTAGE_LIMITS.sounds) return montage;
  // (0.6.148) A sound goes on the track it is dropped on (« Piste audio 1 » or « 2 »), else on its own.
  const sound = { id, source: sourceOf(record), track: lane === 'music' || lane === 'effects' ? lane : track, at: round(Math.max(0, at ?? 0)), from: 0, to: Math.max(MONTAGE_LIMITS.shortest, length ?? STILL_SECONDS), volume: track === 'music' ? 0.6 : 1 };
  return { ...montage, sounds: [...montage.sounds, sound] };
}

/**
 * `montage` without the plan or the sound of this identifier. The plans that touched it come back to
 * where it was (0.6.149: those beyond a hole stay where they are). A plan to make that took the place
 * of the end of a video (0.6.142) gives it back: the video before it is whole again.
 */
export function withoutItem(montage, id) {
  montage = placed(montage);
  const at = montage.plans.findIndex(plan => plan.id === id),
    gone = montage.plans[at],
    before = montage.plans[at - 1],
    back = gone?.replaces && before && sameSource(before.source, gone.replaces.source) && Math.abs(before.to - gone.replaces.from) < NEAR && gluedBefore(montage.plans, at);
  let plans = montage.plans;
  if (gone) {
    const growth = back ? gone.replaces.to - before.to : 0;
    plans = moved(plans, gluedAfter(plans, at), growth - long(gone))
      .map(plan => (back && plan.id === before.id ? { ...plan, to: gone.replaces.to } : plan))
      .filter(plan => plan.id !== id);
  }
  return { ...montage, plans: settled(plans), sounds: montage.sounds.filter(sound => sound.id !== id) };
}

/**
 * `montage` with a plan moved by `step` places (-1: earlier, 1: later): it and its neighbour change
 * places, what was between them stays between them; the same when it cannot move.
 */
export function withPlanMoved(montage, id, step) {
  montage = placed(montage);
  const from = montage.plans.findIndex(plan => plan.id === id),
    to = from + step;
  if (from < 0 || to < 0 || to >= montage.plans.length) return montage;
  const plans = [...montage.plans],
    [first, second] = step > 0 ? [from, to] : [to, from],
    [a, b] = [plans[first], plans[second]];
  plans[first] = { ...b, at: a.at };
  plans[second] = { ...a, at: round(endOf(b) - long(a)) };
  return { ...montage, plans: settled(plans) };
}

/**
 * (0.6.149) `montage` with a plan dragged so that it starts at `seconds`, read on the bobine as it was
 * when it was pressed (`montage`): it is lifted, with the suites to create joined after it (they go on
 * from it), those that touched it come back to where it was, and it is laid there (laidAt: on a plan,
 * before or after it by its middle; in a hole, where it is, or against a neighbour within `near`
 * seconds). The same montage when nothing moves.
 */
export function withPlanPlaced(montage, id, seconds, { near = 0 } = {}) {
  montage = placed(montage);
  const index = montage.plans.findIndex(plan => plan.id === id);
  if (index < 0) return montage;
  const plans = montage.plans,
    block = [index];
  for (const at of gluedAfter(plans, index)) {
    if (!(isTodo(plans[at]) && plans[at].todo.suite)) break;
    block.push(at);
  }
  const lifted = block.map(at => plans[at]),
    length = lifted.reduce((sum, plan) => sum + long(plan), 0),
    others = moved(plans, gluedAfter(plans, block.at(-1)), -length).filter((_, at) => !block.includes(at));
  const next = laidAt(others, lifted, seconds, near);
  return JSON.stringify(next) === JSON.stringify(plans) ? montage : { ...montage, plans: next };
}

/**
 * Where a sound dragged to `seconds` starts: on a cut of the film (a plan starts or ends there), at its
 * start or its end, when it is within `near` seconds of one; else where it is, to the tenth of a second.
 */
export function snapped(montage, seconds, near = 0.2) {
  const { plans } = placed(montage),
    cuts = [0, ...plans.flatMap(plan => [plan.at, endOf(plan)])],
    close = cuts.find(cut => Math.abs(cut - seconds) <= near);
  return close ?? Math.max(0, Math.round(seconds * 10) / 10);
}

/**
 * `montage` with what is kept of an element changed: { from, to, frame, volume, at }. A value out of
 * bounds is brought back to them: never under 0 nor beyond the length of the take (`longest`, when it
 * is known), never shorter than a tenth of a second; an image only has a length; a volume goes from
 * 0 to 2, a sound never starts before the film.
 */
export function withItemChanged(montage, id, changes, { longest = null } = {}) {
  montage = placed(montage);
  const edit = item => {
    if (item.id !== id) return item;
    const next = { ...item },
      top = Math.min(longest ?? 36000, 36000),
      still = item.kind === 'image';
    // (0.6.142) A plan to make has no take yet: a length wanted, within what a clip can be, and its text.
    if (isTodo(item)) {
      if (changes.to !== undefined) next.to = tenth(clamp(changes.to, TODO_LIMITS.shortest, TODO_LIMITS.longest));
      if (typeof changes.prompt === 'string') next.todo = { ...item.todo, prompt: changes.prompt.slice(0, TODO_LIMITS.prompt) };
      if (changes.frame === 'fit' || changes.frame === 'fill') next.frame = changes.frame;
      return next;
    }
    if (changes.to !== undefined) next.to = round(clamp(changes.to, next.from + MONTAGE_LIMITS.shortest, still ? MONTAGE_LIMITS.longest : top));
    if (changes.from !== undefined && !still) next.from = round(clamp(changes.from, 0, next.to - MONTAGE_LIMITS.shortest));
    if (next.to - next.from > MONTAGE_LIMITS.longest && item.kind) next.to = round(next.from + MONTAGE_LIMITS.longest);
    if (changes.frame === 'fit' || changes.frame === 'fill') if (item.kind) next.frame = changes.frame;
    if (changes.volume !== undefined && item.kind !== 'image') next.volume = Math.round(clamp(changes.volume, 0, 2) * 100) / 100;
    if (changes.at !== undefined && item.track) next.at = round(Math.max(0, changes.at));
    return next;
  };
  // (0.6.149) A plan: what touches its end follows it. Its start cut or given back moves its end when it
  // touches what is before it (as before 0.6.149); after a hole, its start moves and its end stays.
  const index = montage.plans.findIndex(plan => plan.id === id);
  let plans = montage.plans;
  if (index >= 0) {
    const old = plans[index],
      next = edit(old);
    if (next.from !== old.from && !gluedBefore(plans, index)) {
      const room = (index ? endOf(plans[index - 1]) : 0) - old.at,
        shift = Math.max(next.from - old.from, room);
      next.from = round(old.from + shift);
      next.at = round(old.at + shift);
    }
    plans = moved(
      plans.map((plan, at) => (at === index ? next : plan)),
      gluedAfter(plans, index),
      round(endOf(next) - endOf(old)),
    );
  }
  return { ...montage, plans: settled(replacing(plans)), sounds: montage.sounds.map(edit) };
}

/**
 * (0.6.143) A plan to make no longer says it replaces the end of the video before it once that video is
 * given its end back by hand (its edge pulled to the end of its take): nothing of it is replaced then.
 * (Cut otherwise since, the video stays as the hand left it: see withoutItem.)
 */
function replacing(plans) {
  return plans.map((plan, at) => {
    const before = plans[at - 1];
    if (!plan.replaces || !before || isTodo(before) || !sameSource(before.source, plan.replaces.source)) return plan;
    if (before.to < plan.replaces.to - 0.002) return plan;
    const { replaces: _nothing, ...rest } = plan;
    return rest;
  });
}

/** Seconds as the page says them: « 14 s », « 2,5 s », « 1 min 05 s ». */
export function shownSeconds(seconds) {
  const whole = Math.round(seconds * 10) / 10;
  if (whole < 60) return String(whole).replace('.', ',') + ' s';
  const minutes = Math.floor(whole / 60);
  return `${minutes} min ${String(Math.round(whole - minutes * 60)).padStart(2, '0')} s`;
}
/** A time of the film as its clock shows it: « 00:06 ». */
export function clock(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return String(Math.floor(whole / 60)).padStart(2, '0') + ':' + String(whole % 60).padStart(2, '0');
}

// ------------------------------------------------------------------ plans to make (0.6.142)
/**
 * (0.6.142) The second step of the montage, his words of 20/11: « ce serait surtout de permettre à
 * l'utilisateur de créer un plan ». A plan may be one **to make**: no take yet, a length wanted and
 * what happens in it (`todo: { prompt }`), and the photos it goes by:
 * - `photos.start`: the photo it starts on; `photos.end`: the photo it must arrive on. On the timeline
 *   a start photo sits against the left edge of its plan and an end photo against its right edge,
 *   never beyond (« le bord droit de la photo ne doit pas dépasser le plan pour lequel c'est la photo
 *   de fin. et pour la photo du début c'est toujours le bord gauche »);
 * - `replaces`: what of a take this plan takes the place of. A photo laid above a video cuts it
 *   there: the video is kept up to the photo, its end is shown greyed until the new clip is made
 *   (« griser clairement la suite de la vidéo », then « coupe sur la photo »).
 * Once created, the plan is a plan as the others, with the take that was made.
 */
// (0.6.152) A take to create may be longer than its model makes at once (`longest`, a minute): it is
// cut in equal parts, each within the model's own longest (`part` when nobody knows it).
export const TODO_LIMITS = Object.freeze({ shortest: 1, longest: 60, part: 20, usual: 5, prompt: 4000 });
export const isTodo = plan => Boolean(plan?.todo);
export const todoPlans = montage => montage.plans.filter(isTodo);
const tenth = value => Math.round(value * 10) / 10;
const sameSource = (a, b) => Boolean(a && b) && a.conversationId === b.conversationId && a.runId === b.runId && (a.output ?? 0) === (b.output ?? 0);
const todoPlan = (id, seconds, more = {}) => ({
  id,
  kind: 'video',
  todo: { prompt: '' },
  from: 0,
  to: tenth(clamp(seconds, TODO_LIMITS.shortest, TODO_LIMITS.longest)),
  frame: 'fit',
  volume: 1,
  ...more,
});

/** (0.6.143) How far beyond the end of its take the end of a video is pulled before its continuation is asked. */
export const SUITE_BEYOND = 0.5;

/**
 * (0.6.143) The end of the plan `id` pulled to `to` seconds of its take, which is `longest` long (« s'il
 * déroule la vidéo plus loin que sa durée d'origine, on lui montre […] que ça va continuer sa vidéo »).
 * Within the take: what is kept of it, as withItemChanged. Beyond it (by SUITE_BEYOND at least): the
 * plan keeps its take to its end, and what exceeds is its continuation, a plan to make laid right
 * after it under `suiteId`; what follows comes later in the film. Read on the montage as it was when
 * the edge was pressed: pulled back, the continuation is gone. A video that has its continuation to
 * make already stops at the end of its take: that one is pulled by its own edge.
 */
export function withEndPulled(montage, id, to, { longest = null, suiteId } = {}) {
  montage = placed(montage);
  const within = withItemChanged(montage, id, { to }, { longest }),
    index = montage.plans.findIndex(plan => plan.id === id),
    plan = montage.plans[index],
    next = montage.plans[index + 1];
  if (!plan || isTodo(plan) || plan.kind !== 'video' || !(longest > 0) || !suiteId) return within;
  // (0.6.149) Its suite to make, joined after it: it has one already.
  const suited = isTodo(next) && next.todo.suite && gluedBefore(montage.plans, index + 1);
  if (to - longest < SUITE_BEYOND || suited) return within;
  if (montage.plans.length >= MONTAGE_LIMITS.plans) return within;
  const plans = [...within.plans];
  // (Marked as a suite: only a suite goes on from what is before it, 0.6.149.)
  plans.splice(index + 1, 0, todoPlan(suiteId, to - longest, { at: endOf(plans[index]), todo: { prompt: '', suite: true } }));
  return { ...within, plans: settled(plans) };
}

/**
 * (0.6.149) `montage` with a plan to make drawn in a hole (« cliquer dans le vide et tirer dessine une
 * nouvelle prise à créer, de la longueur tirée »), or laid there by a double click: at `at` seconds,
 * `seconds` long, within what a clip can be. It stays where it is drawn, and never goes on from what
 * is before or after it: it starts from its text, or from its photos. `{ montage, chosen }`, or the
 * montage as it was and `reason`.
 */
export function withTodoDrawn(montage, { id, at, seconds = TODO_LIMITS.usual } = {}) {
  montage = placed(montage);
  if (montage.plans.length >= MONTAGE_LIMITS.plans) return { montage, reason: 'Cette bobine est pleine.' };
  const start = round(Math.max(0, at)),
    plans = [...montage.plans],
    index = plans.filter(plan => plan.at < start).length;
  plans.splice(index, 0, todoPlan(id, seconds, { at: start }));
  return { montage: { ...montage, plans: settled(plans) }, chosen: id };
}

/**
 * A photo of the project laid on the track of the photos at `seconds` of the film. What it becomes is
 * read where it is laid: `{ montage, chosen }` (the plan it now belongs to), or `{ montage, reason }`
 * with the montage as it was and why, in the user's words.
 * - on an empty film: a first plan to make, which starts on it;
 * - after the end of the film, or in a hole (0.6.149): the photo the plan to make before it arrives on
 *   when it has none (the plan then ends there), else a new plan to make, from the end of the plan
 *   before it to the photo, its end photo (it does not go on from that plan: only a suite does);
 * - on a plan to make: its start photo on its first half, its end photo on the second;
 * - on a video: the video is kept up to there and a plan to make takes the place of its end, starting
 *   on the photo (the film cuts on it).
 */
export function withPhoto(montage, record, seconds, { id } = {}) {
  montage = placed(montage);
  const refused = reason => ({ montage, reason });
  if (trackOf(record) !== 'image') return refused('Seule une image se pose comme photo de début ou de fin.');
  const photo = sourceOf(record),
    at = tenth(Math.max(0, seconds)),
    plans = [...montage.plans];
  if (!plans.length) {
    plans.push(todoPlan(id, TODO_LIMITS.usual, { at: 0, photos: { start: photo } }));
    return { montage: { ...montage, plans }, chosen: id };
  }
  const index = plans.findIndex(plan => plan.at <= at && at < endOf(plan));
  if (index < 0) {
    const after = plans.filter(plan => plan.at <= at).length,
      last = plans[after - 1];
    if (last && isTodo(last) && !last.photos?.end) {
      plans[after - 1] = { ...last, to: tenth(clamp(at - last.at, TODO_LIMITS.shortest, TODO_LIMITS.longest)), photos: { ...last.photos, end: photo } };
      return { montage: { ...montage, plans: settled(plans) }, chosen: last.id };
    }
    if (plans.length >= MONTAGE_LIMITS.plans) return refused('Cette bobine est pleine.');
    const from = last ? endOf(last) : 0;
    plans.splice(after, 0, todoPlan(id, at - from < TODO_LIMITS.shortest ? TODO_LIMITS.usual : at - from, { at: from, photos: { end: photo } }));
    return { montage: { ...montage, plans: settled(plans) }, chosen: id };
  }
  const plan = plans[index],
    start = plan.at,
    length = plan.to - plan.from,
    local = at - start;
  if (isTodo(plan)) {
    // (0.6.152) A suite starts from the end of its video: its photo is the one it arrives on.
    const side = local < length / 2 && !plan.todo.suite ? 'start' : 'end';
    plans[index] = { ...plan, photos: { ...plan.photos, [side]: photo } };
    return { montage: { ...montage, plans }, chosen: plan.id };
  }
  if (plan.kind !== 'video') return refused('Une photo se pose au-dessus d’une vidéo ou d’une prise à créer, pas d’une image.');
  if (local < 0.5) return refused('Posez la photo plus loin dans la vidéo : avant elle, il ne resterait rien de cette prise.');
  if (length - local < TODO_LIMITS.shortest) return refused('Posez la photo plus tôt dans la vidéo, ou après la fin pour une nouvelle prise.');
  if (plans.length >= MONTAGE_LIMITS.plans) return refused('Cette bobine est pleine.');
  const cut = round(plan.from + local);
  plans[index] = { ...plan, to: cut };
  plans.splice(index + 1, 0, todoPlan(id, length - local, { at: round(start + local), photos: { start: photo }, replaces: { source: plan.source, from: cut, to: plan.to } }));
  return { montage: { ...montage, plans: settled(plans) }, chosen: id };
}

/**
 * (0.6.152, captures 77 et 79) A photo laid in a place of a take to create: its start (`side`
 * 'start'), or its end. Never shared: it is that take's alone. A suite has no start photo.
 * `{ montage, chosen }`, or the montage as it was and `reason`.
 */
export function withPhotoIn(montage, record, id, side) {
  const refused = reason => ({ montage, reason });
  if (trackOf(record) !== 'image') return refused('Seule une image se pose comme photo de début ou de fin.');
  const plan = montage.plans.find(item => item.id === id);
  if (!isTodo(plan)) return refused('Une photo se pose au début ou à la fin d’une prise à créer.');
  if (side === 'start' && plan.todo.suite) return refused('Une suite part de la fin de sa vidéo : elle n’a que sa photo de fin.');
  if (side !== 'start' && side !== 'end') return refused('Une photo est de début ou de fin.');
  return {
    montage: { ...montage, plans: montage.plans.map(item => (item === plan ? { ...plan, photos: { ...plan.photos, [side]: sourceOf(record) } } : item)) },
    chosen: id,
  };
}

/** `montage` without the start or the end photo of a plan. */
export function withoutPhoto(montage, id, side) {
  return {
    ...montage,
    plans: montage.plans.map(plan => {
      if (plan.id !== id || !plan.photos?.[side]) return plan;
      const { [side]: _gone, ...photos } = plan.photos,
        { photos: _all, ...rest } = plan;
      return Object.keys(photos).length ? { ...rest, photos } : rest;
    }),
  };
}

/**
 * `montage` with a plan to make become the plan of the take that was made for it (`record`), shown
 * from `from` seconds of its file: 0 for a clip of its own; where the clip it continues ends, for a
 * continuation, whose file holds that clip first.
 */
export function withTodoMade(montage, id, record, { from = 0, limits = {}, partId = null } = {}) {
  montage = placed(montage);
  const whole = takeSeconds(record),
    index = montage.plans.findIndex(plan => plan.id === id),
    plan = montage.plans[index];
  if (!isTodo(plan)) return montage;
  // (0.6.159, capture 88) Made, it has no photo any more: its photos were those of a take to create
  // (« Photos : toujours début ou fin d'une prise à créer »). Kept, they stayed on the track of the photos
  // for ever, the bar of a take made having nothing to take them off with.
  const { todo: _todo, replaces: _replaces, photos: _photos, ...rest } = plan,
    start = round(clamp(from, 0, Math.max(0, (whole ?? 0) - MONTAGE_LIMITS.shortest))),
    made = { ...rest, source: sourceOf(record), kind: 'video', from: start, to: round(Math.max(start + MONTAGE_LIMITS.shortest, whole ?? start + (plan.to - plan.from))) };
  // (0.6.152) The first part of a take made in parts: it becomes that take (`partId`); what is left of it
  // stays to create under its own id, a suite of it, with its text and the photo it arrives on, as long
  // as it was left.
  // (Relecture du 21/11) A bobine full has no room for what is left: the take made takes its place whole.
  // creationOf refuses it before (the bobine is not changed while a take is made); a take more, there,
  // was one beyond what the server keeps, and nothing of the bobine was kept any more.
  const { count } = partsOf(plan, limits);
  if (count > 1 && partId && montage.plans.length < MONTAGE_LIMITS.plans) {
    const part = { ...made, id: partId },
      // (To the millisecond, not the tenth: the take ends where it ended, part after part.)
      left = { ...todoPlan(id, TODO_LIMITS.shortest, { at: endOf(part), todo: { prompt: plan.todo.prompt, suite: true } }), to: round(Math.max(TODO_LIMITS.shortest, plan.to - plan.from - (part.to - part.from))), frame: plan.frame, volume: plan.volume, ...(plan.photos?.end ? { photos: { end: plan.photos.end } } : {}) },
      plans = [...montage.plans];
    plans.splice(index, 1, part, left);
    return { ...montage, plans: settled(moved(plans, gluedAfter(montage.plans, index).map(at => at + 1), round(endOf(left) - endOf(plan)))) };
  }
  // (0.6.149) Its take is as long as it was made: what touches it follows.
  const plans = moved(
    montage.plans.map((item, at) => (at === index ? made : item)),
    gluedAfter(montage.plans, index),
    round(endOf(made) - endOf(plan)),
  );
  return { ...montage, plans: settled(plans) };
}

/**
 * (0.6.152, capture 74) The parts a take to create is made in: `{ count, seconds }`, equal, each within
 * what its model makes at once. `limits`: the longest the model makes, by verb (« create_video »,
 * « extend_video »: a suite is made by continuations, a new take by a first clip and then by its suites,
 * each part as long as the shortest of the two allows). Without them, parts of TODO_LIMITS.part at most.
 * « Ce sont plusieurs suites de la même prise, à la chaîne […]. Un seul texte pour toute la longueur, une
 * seule photo de fin, au bout de la dernière partie. »
 */
export function partsOf(plan, limits = {}) {
  const seconds = plan.to - plan.from,
    known = value => (value > 0 ? value : TODO_LIMITS.part),
    suite = Boolean(plan.todo?.suite),
    alone = known(limits[suite ? 'extend_video' : 'create_video']);
  if (seconds <= alone + 1e-9) return { count: 1, seconds: round(seconds) };
  const each = suite ? alone : Math.min(alone, known(limits.extend_video)),
    count = Math.ceil(seconds / each - 1e-9);
  return { count, seconds: round(seconds / count) };
}

/**
 * (0.6.143) What a plan to make goes on from, read on the montage: `{ kind, before, whole }`.
 * - 'photo': its start photo;
 * - 'suite': the video before it, shown to the end of its take, which it continues (`whole`: the
 *   length of that take);
 * - 'last': the last image of that video, towards its own end photo (a new clip: see creationOf);
 * - 'wait': the plan before it is still to make; 'cut': the video before it stops before the end of
 *   its take;
 * - 'own': nothing to go on from; 'made': not a plan to make.
 * `before`: the number of the plan before it, as the page says it.
 * (0.6.149) Only a suite (`todo.suite`, pulled from the end of a video) goes on from what is before
 * it; any other plan to make starts from its text or its photos, even right after a video (« Une prise
 * dessinée ne continue jamais »). A suite no longer joined to a video is 'loose'.
 */
export function linkOf(montage, id, lengthOf = () => null) {
  const { plans } = placed(montage),
    index = plans.findIndex(plan => plan.id === id),
    plan = plans[index];
  if (!isTodo(plan)) return { kind: 'made' };
  if (plan.photos?.start) return { kind: 'photo' };
  if (!plan.todo.suite) return { kind: 'own' };
  const before = plans[index - 1];
  if (!before || !gluedBefore(plans, index)) return { kind: 'loose' };
  if (isTodo(before)) return { kind: 'wait', before: index };
  if (before.kind !== 'video') return { kind: 'loose' };
  const whole = lengthOf(before.source);
  if (!(whole > 0) || Math.abs(before.to - whole) > 0.06) return { kind: 'cut', before: index };
  return { kind: plan.photos?.end ? 'last' : 'suite', before: index, whole };
}

/**
 * (0.6.144) The plans to make of the montage, in the order of the film, as a series creates them one
 * after the other (« le modèle s'occupe de combler les trous »): `[{ id, number, seconds, prompt,
 * kind, ready, reason, blocked, after }]`.
 * - `ready`: what it needs is there now (creationOf), or will be once the plan to make right before
 *   it (`after`: its id), itself ready, is made: it goes on from it, and is created in its turn;
 * - else `reason`, in the user's words. A plan that goes on from one that cannot be created cannot
 *   be either.
 * `kind`: what it goes on from (linkOf).
 */
export function seriesOf(montage, lengthOf = () => null, { limits = {}, writable = () => false } = {}) {
  const items = [];
  montage.plans.forEach((plan, index) => {
    if (!isTodo(plan)) return;
    const prompt = (plan.todo.prompt ?? '').trim(),
      link = linkOf(montage, plan.id, lengthOf),
      // (0.6.155) Without its text, Moodix AI writes it first when it can (`writable(plan)`): nothing
      // else stops it, it is read as written.
      written = Boolean(prompt) || writable(plan),
      // (0.6.159) Without its text and stopped by something else (the video before it cut before its end,
      // a suite no longer joined to its video): that is what is said, not « écrivez » (`blocked`). Writing
      // its text changed nothing, and its line said nothing at all.
      blocked = !prompt && (link.kind === 'cut' || link.kind === 'loose'),
      probe = prompt || (!written && !blocked) ? montage : withItemChanged(montage, plan.id, { prompt: 'Prise.' }),
      // (The plan before it is to make too: the last one read. Without its text it waits for nothing.)
      before = link.kind === 'wait' && written ? items.at(-1) : null,
      reason = before ? (before.ready ? '' : 'Elle continue la prise d’avant, qui ne peut pas être créée.') : (creationOf(probe, plan.id, lengthOf, { limits }).reason ?? ''),
      // (0.6.152) How many parts it is made in, and how long each is.
      parts = partsOf(plan, limits);
    items.push({
      id: plan.id,
      number: index + 1,
      seconds: tenth(plan.to - plan.from),
      prompt,
      kind: link.kind,
      ready: !reason,
      reason,
      blocked,
      after: before?.ready ? before.id : null,
      parts: parts.count,
      part: parts.seconds,
    });
  });
  return items;
}

/**
 * What must be asked for a plan to make to be created, read on the montage: `{ verb, prompt, duration,
 * format, start, end, continues, from }`, or `{ reason }` in the user's words when it cannot be yet.
 * `lengthOf(source)`: the length of a take of the project, or null.
 * - a start photo: a new clip that starts on it (`start: { source }`);
 * - no start photo, after a video shown to its end: it continues that video. With an end photo, a new
 *   clip from the last image of the video (`start: { source, frame: 'last' }`); without one, the
 *   continuation itself (`continues`), whose file holds the video first: the plan shows it from `from`;
 * - else a clip of its own, from its text (and its end photo).
 */
export function creationOf(montage, id, lengthOf = () => null, { limits = {} } = {}) {
  const index = montage.plans.findIndex(plan => plan.id === id),
    plan = montage.plans[index];
  if (!isTodo(plan)) return { reason: 'Cette prise est déjà créée.' };
  const prompt = (plan.todo.prompt ?? '').trim();
  if (!prompt) return { reason: 'Écrivez ce qui se passe dans cette prise.' };
  // (0.6.152) Made in parts: what is asked now is its first part; the photo it arrives on is the one
  // of its last part.
  const parts = partsOf(plan, limits);
  // (Relecture du 21/11) Each part becomes a take of the bobine: it needs room for them all. Created
  // without, the bobine went beyond its 200 takes, and the server refused it whole from then on.
  const over = montage.plans.length + parts.count - 1 - MONTAGE_LIMITS.plans;
  if (parts.count > 1 && over > 0)
    return {
      reason: `Elle se crée en ${parts.count} parties, une prise chacune, et la bobine est pleine (${MONTAGE_LIMITS.plans} prises au plus) : retirez-en ${over}.`,
    };
  const wanted = {
    verb: 'create_video',
    prompt,
    duration: tenth(parts.seconds),
    format: montage.format,
    ...(plan.photos?.end && parts.count === 1 ? { end: { source: plan.photos.end } } : {}),
    from: 0,
    ...(parts.count > 1 ? { parts: parts.count } : {}),
  };
  const link = linkOf(montage, id, lengthOf),
    before = montage.plans[index - 1];
  if (link.kind === 'photo') return { ...wanted, start: { source: plan.photos.start } };
  if (link.kind === 'wait') return { reason: 'Créez d’abord la prise d’avant : celle-ci la continue.' };
  if (link.kind === 'own') return wanted;
  if (link.kind === 'loose') return { reason: 'Cette suite n’est plus collée à la vidéo qu’elle continue : rapprochez-la, ou retirez-la.' };
  if (link.kind === 'cut')
    return { reason: 'La vidéo d’avant est coupée avant sa fin : rendez-lui sa fin, ou posez une photo de début.' };
  // (0.6.152) A suite towards its photo is a continuation that arrives on it (end_image on extend_video,
  // his choice of 20/11 for the Bobine and the Studio), no longer a new clip from the last image.
  const { format: _format, ...rest } = wanted;
  return { ...rest, verb: 'extend_video', continues: before.source, from: link.whole };
}

/**
 * (0.6.154) The folder « Un fichier par prise » puts the takes of a bobine in, under BOBINES in the folder
 * of the outputs (« BOBINES / LE RENARD EN HIVER / 01 À 05 »): its name as it is written, without what a
 * folder of Windows refuses (\ / : * ? " < > |, a dot or a space at its end, CON, NUL…), « Bobine » when
 * nothing is left.
 */
export function folderName(name) {
  let plain = String(name ?? '')
    .replace(/[\x00-\x1f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(plain)) plain = 'Bobine ' + plain;
  return plain || 'Bobine';
}
