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

/**
 * `montage` without the plan or the sound of this identifier. A plan to make that took the place of
 * the end of a video (0.6.142) gives it back: the video before it is whole again.
 */
export function withoutItem(montage, id) {
  const at = montage.plans.findIndex(plan => plan.id === id),
    gone = montage.plans[at],
    before = montage.plans[at - 1],
    back = gone?.replaces && before && sameSource(before.source, gone.replaces.source) && Math.abs(before.to - gone.replaces.from) < 0.002;
  return {
    ...montage,
    plans: montage.plans.filter(plan => plan.id !== id).map(plan => (back && plan === before ? { ...plan, to: gone.replaces.to } : plan)),
    sounds: montage.sounds.filter(sound => sound.id !== id),
  };
}

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
  return { ...montage, plans: replacing(montage.plans.map(edit)), sounds: montage.sounds.map(edit) };
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

/** What the head of the timeline says of a montage: « 4 plans · 14 s · 16:9 · 24 i/s ». */
export function montageSummary(montage) {
  const count = montage.plans.length,
    todo = todoPlans(montage).length,
    seconds = montageSeconds(montage),
    plural = count > 1 ? 's' : '';
  return [
    // (0.6.142) « 2 plans à faire », « 3 plans dont 1 à faire ».
    !count ? 'Aucun plan' : todo === count ? `${count} plan${plural} à faire` : `${count} plan${plural}` + (todo ? ` dont ${todo} à faire` : ''),
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
export const TODO_LIMITS = Object.freeze({ shortest: 1, longest: 20, usual: 5, prompt: 4000 });
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
  const within = withItemChanged(montage, id, { to }, { longest }),
    index = montage.plans.findIndex(plan => plan.id === id),
    plan = montage.plans[index],
    next = montage.plans[index + 1];
  if (!plan || isTodo(plan) || plan.kind !== 'video' || !(longest > 0) || !suiteId) return within;
  if (to - longest < SUITE_BEYOND || (isTodo(next) && !next.photos?.start)) return within;
  if (montage.plans.length >= MONTAGE_LIMITS.plans) return within;
  const plans = [...within.plans];
  plans.splice(index + 1, 0, todoPlan(suiteId, to - longest));
  return { ...within, plans };
}

/**
 * A photo of the project laid on the track of the photos at `seconds` of the film. What it becomes is
 * read where it is laid: `{ montage, chosen }` (the plan it now belongs to), or `{ montage, reason }`
 * with the montage as it was and why, in the user's words.
 * - on an empty film: a first plan to make, which starts on it;
 * - after the end of the film: the photo the last plan to make arrives on when it has none (the plan
 *   then ends there), else a new plan to make, from the end of the film to the photo, its end photo;
 * - on a plan to make: its start photo on its first half, its end photo on the second;
 * - on a video: the video is kept up to there and a plan to make takes the place of its end, starting
 *   on the photo (the film cuts on it).
 */
export function withPhoto(montage, record, seconds, { id } = {}) {
  const refused = reason => ({ montage, reason });
  if (trackOf(record) !== 'image') return refused('Seule une image se pose comme photo de début ou de fin.');
  const photo = sourceOf(record),
    total = montageSeconds(montage),
    at = tenth(Math.max(0, seconds)),
    plans = [...montage.plans];
  if (!plans.length) {
    plans.push(todoPlan(id, TODO_LIMITS.usual, { photos: { start: photo } }));
    return { montage: { ...montage, plans }, chosen: id };
  }
  if (at >= total) {
    const last = plans.at(-1);
    if (isTodo(last) && !last.photos?.end) {
      const start = round(total - (last.to - last.from));
      plans[plans.length - 1] = { ...last, to: tenth(clamp(at - start, TODO_LIMITS.shortest, TODO_LIMITS.longest)), photos: { ...last.photos, end: photo } };
      return { montage: { ...montage, plans }, chosen: last.id };
    }
    if (plans.length >= MONTAGE_LIMITS.plans) return refused('Ce montage est plein.');
    plans.push(todoPlan(id, at - total < TODO_LIMITS.shortest ? TODO_LIMITS.usual : at - total, { photos: { end: photo } }));
    return { montage: { ...montage, plans }, chosen: id };
  }
  const { plan, index, start } = planAt(montage, at),
    length = plan.to - plan.from,
    local = at - start;
  if (isTodo(plan)) {
    plans[index] = { ...plan, photos: { ...plan.photos, [local < length / 2 ? 'start' : 'end']: photo } };
    return { montage: { ...montage, plans }, chosen: plan.id };
  }
  if (plan.kind !== 'video') return refused('Une photo se pose au-dessus d’une vidéo ou d’un plan à faire, pas d’une image.');
  if (local < 0.5) return refused('Posez la photo plus loin dans la vidéo : avant elle, il ne resterait rien de ce plan.');
  if (length - local < TODO_LIMITS.shortest) return refused('Posez la photo plus tôt dans la vidéo, ou après la fin du film pour un nouveau plan.');
  if (plans.length >= MONTAGE_LIMITS.plans) return refused('Ce montage est plein.');
  const cut = round(plan.from + local);
  plans[index] = { ...plan, to: cut };
  plans.splice(index + 1, 0, todoPlan(id, length - local, { photos: { start: photo }, replaces: { source: plan.source, from: cut, to: plan.to } }));
  return { montage: { ...montage, plans }, chosen: id };
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
export function withTodoMade(montage, id, record, { from = 0 } = {}) {
  const whole = takeSeconds(record);
  return {
    ...montage,
    plans: montage.plans.map(plan => {
      if (plan.id !== id || !isTodo(plan)) return plan;
      const { todo: _todo, replaces: _replaces, ...rest } = plan,
        start = round(clamp(from, 0, Math.max(0, (whole ?? 0) - MONTAGE_LIMITS.shortest)));
      return { ...rest, source: sourceOf(record), kind: 'video', from: start, to: round(Math.max(start + MONTAGE_LIMITS.shortest, whole ?? start + (plan.to - plan.from))) };
    }),
  };
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
 */
export function linkOf(montage, id, lengthOf = () => null) {
  const index = montage.plans.findIndex(plan => plan.id === id),
    plan = montage.plans[index];
  if (!isTodo(plan)) return { kind: 'made' };
  if (plan.photos?.start) return { kind: 'photo' };
  const before = montage.plans[index - 1];
  if (isTodo(before)) return { kind: 'wait', before: index };
  if (before?.kind !== 'video') return { kind: 'own' };
  const whole = lengthOf(before.source);
  if (!(whole > 0) || Math.abs(before.to - whole) > 0.06) return { kind: 'cut', before: index };
  return { kind: plan.photos?.end ? 'last' : 'suite', before: index, whole };
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
export function creationOf(montage, id, lengthOf = () => null) {
  const index = montage.plans.findIndex(plan => plan.id === id),
    plan = montage.plans[index];
  if (!isTodo(plan)) return { reason: 'Ce plan est déjà fait.' };
  const prompt = (plan.todo.prompt ?? '').trim();
  if (!prompt) return { reason: 'Écrivez ce qui se passe dans ce plan.' };
  const wanted = {
    verb: 'create_video',
    prompt,
    duration: tenth(plan.to - plan.from),
    format: montage.format,
    ...(plan.photos?.end ? { end: { source: plan.photos.end } } : {}),
    from: 0,
  };
  const link = linkOf(montage, id, lengthOf),
    before = montage.plans[index - 1];
  if (link.kind === 'photo') return { ...wanted, start: { source: plan.photos.start } };
  if (link.kind === 'wait') return { reason: `Créez d’abord le plan ${index} : celui-ci le continue.` };
  if (link.kind === 'own') return wanted;
  if (link.kind === 'cut')
    return { reason: `Le plan ${index} est coupé avant la fin de sa prise : rendez-lui sa fin, ou posez une photo de début sur ce plan.` };
  if (link.kind === 'last') return { ...wanted, start: { source: before.source, frame: 'last' } };
  const { format: _format, ...rest } = wanted;
  return { ...rest, verb: 'extend_video', continues: before.source, from: link.whole };
}
