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

/** How long the film is, in seconds: its plans end to end (a sound never makes it longer). */
export const montageSeconds = montage => round(montage.plans.reduce((sum, plan) => sum + (plan.to - plan.from), 0));

/** When each plan starts in the film, in seconds, in the order of the list. */
export function planStarts(montage) {
  let at = 0;
  return montage.plans.map(plan => {
    const start = at;
    at = round(at + plan.to - plan.from);
    return start;
  });
}
/** The plan shown at `seconds` of the film: { plan, index, start }, the last one at the very end; null without plans. */
export function planAt(montage, seconds) {
  const starts = planStarts(montage);
  if (!starts.length) return null;
  let index = starts.length - 1;
  while (index > 0 && starts[index] > seconds) index--;
  return { plan: montage.plans[index], index, start: starts[index] };
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
 * `montage` with a creation of the project laid on it: a video or an image as a plan (at `index`, the
 * end by default), a sound on its track from `at` seconds (the start by default). `id`: the identifier
 * of the new element. A take already there may be laid again: a film may show it twice.
 */
export function withTake(montage, record, { id, index, at = 0 } = {}) {
  const track = trackOf(record),
    length = takeSeconds(record);
  if (track === 'video' || track === 'image') {
    if (montage.plans.length >= MONTAGE_LIMITS.plans) return montage;
    const plan =
      track === 'image'
        ? { id, source: sourceOf(record), kind: 'image', from: 0, to: STILL_SECONDS, frame: 'fit' }
        : { id, source: sourceOf(record), kind: 'video', from: 0, to: clamp(length ?? STILL_SECONDS, MONTAGE_LIMITS.shortest, MONTAGE_LIMITS.longest), frame: 'fit', volume: 1 };
    const place = clamp(index ?? montage.plans.length, 0, montage.plans.length),
      plans = [...montage.plans];
    plans.splice(place, 0, plan);
    return { ...montage, plans };
  }
  if (montage.sounds.length >= MONTAGE_LIMITS.sounds) return montage;
  const sound = { id, source: sourceOf(record), track, at: round(Math.max(0, at)), from: 0, to: Math.max(MONTAGE_LIMITS.shortest, length ?? STILL_SECONDS), volume: track === 'music' ? 0.6 : 1 };
  return { ...montage, sounds: [...montage.sounds, sound] };
}

/** `montage` without the plan or the sound of this identifier. */
export const withoutItem = (montage, id) => ({
  ...montage,
  plans: montage.plans.filter(plan => plan.id !== id),
  sounds: montage.sounds.filter(sound => sound.id !== id),
});

/** `montage` with a plan moved by `step` places (-1: earlier, 1: later); the same when it cannot move. */
export function withPlanMoved(montage, id, step) {
  const from = montage.plans.findIndex(plan => plan.id === id),
    to = from + step;
  if (from < 0 || to < 0 || to >= montage.plans.length) return montage;
  const plans = [...montage.plans];
  plans.splice(to, 0, ...plans.splice(from, 1));
  return { ...montage, plans };
}

/** `montage` with a plan put at `index` among the others (0: the first); the same when it is there already. */
export function withPlanAt(montage, id, index) {
  const from = montage.plans.findIndex(plan => plan.id === id);
  if (from < 0) return montage;
  const others = montage.plans.filter(plan => plan.id !== id),
    to = clamp(index, 0, others.length);
  if (to === from) return montage;
  others.splice(to, 0, montage.plans[from]);
  return { ...montage, plans: others };
}
/**
 * The place a plan dragged to `seconds` of the film takes among the others: after those whose
 * middle is before that time, in the montage as it was when the plan was pressed (`montage`, the
 * plan still in its place). Read on the film as it is being changed, the others closing the gap it
 * leaves, a long plan pressed near its end went after its neighbour at the first move.
 */
export function placeAt(montage, id, seconds) {
  const starts = planStarts(montage);
  return montage.plans.filter((plan, index) => plan.id !== id && starts[index] + (plan.to - plan.from) / 2 < seconds).length;
}
/**
 * Where a sound dragged to `seconds` starts: on a cut between two plans, at the start or the end of
 * the film when it is within `near` seconds of one; else where it is, to the tenth of a second.
 */
export function snapped(montage, seconds, near = 0.2) {
  const cuts = [0, ...planStarts(montage).slice(1), montageSeconds(montage)],
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
  const edit = item => {
    if (item.id !== id) return item;
    const next = { ...item },
      top = Math.min(longest ?? 36000, 36000),
      still = item.kind === 'image';
    if (changes.to !== undefined) next.to = round(clamp(changes.to, next.from + MONTAGE_LIMITS.shortest, still ? MONTAGE_LIMITS.longest : top));
    if (changes.from !== undefined && !still) next.from = round(clamp(changes.from, 0, next.to - MONTAGE_LIMITS.shortest));
    if (next.to - next.from > MONTAGE_LIMITS.longest && item.kind) next.to = round(next.from + MONTAGE_LIMITS.longest);
    if (changes.frame === 'fit' || changes.frame === 'fill') if (item.kind) next.frame = changes.frame;
    if (changes.volume !== undefined && item.kind !== 'image') next.volume = Math.round(clamp(changes.volume, 0, 2) * 100) / 100;
    if (changes.at !== undefined && item.track) next.at = round(Math.max(0, changes.at));
    return next;
  };
  return { ...montage, plans: montage.plans.map(edit), sounds: montage.sounds.map(edit) };
}

/** What the head of the timeline says of a montage: « 4 plans · 14 s · 16:9 · 24 i/s ». */
export function montageSummary(montage) {
  const count = montage.plans.length,
    seconds = montageSeconds(montage);
  return [
    count ? `${count} plan${count > 1 ? 's' : ''}` : 'Aucun plan',
    ...(count ? [shownSeconds(seconds)] : []),
    montage.format,
    montage.fps + ' i/s',
  ].join(' · ');
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
