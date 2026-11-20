/**
 * (0.6.161) The arranger of the Bobine, its version for measuring (claude_design/arrangeur/CONTRAT.md):
 * the user writes a request in the Bobine (« crée une vidéo sur le thème de l’espace », « invente la
 * suite »), a chat model is asked apart from the chat and answers a plan, an `Arrangement`, in JSON:
 *   { say, fill: [{ block, text }], add: [{ text, seconds, link, start, end } | { take, seconds }] }
 * Here that plan is read, kindly as to its form and strictly as to its sense, then laid on the bobine:
 * takes to create added after its end, each against the one before it, the takes of the project it
 * names laid as they are, and the text of the takes to create that have none written. Nothing the user
 * laid is taken out, moved or changed. Every repair is said in a sentence, in the words of the screen
 * (« bloc 3 », « prise 12 »), never with an identifier.
 * No page is read here: the server and the tests read it too.
 */
import {
  MONTAGE_LIMITS,
  TODO_LIMITS,
  isTodo,
  linkOf,
  montageSeconds,
  placed,
  shownSeconds,
  takeSeconds,
  trackOf,
  withItemChanged,
  withPhotoIn,
  withTake,
  withTodoDrawn,
} from './montage-model.mjs';

/** What a plan holds at most: takes added, texts written, then the length of what it says and of a text. */
export const ARRANGE_LIMITS = Object.freeze({ add: 24, fill: 24, say: 400, text: 600 });

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const deepFrozen = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFrozen);
  }
  return value;
};

// ------------------------------------------------------------------ the plan asked
const NAMED = { type: ['string', 'null'], description: 'An image of the project, as "prise N", or null.' };
/**
 * The plan as a JSON Schema, for an answer held to it (the structured outputs of a remote model, the
 * grammar of llama.cpp): every field asked, nothing else; in `add`, a take to create or a take of the
 * project. Only what both read: no length nor pattern (what is beyond the limits is cut as the plan is
 * read). Frozen: whoever must change it changes a copy.
 */
export const ARRANGEMENT_SCHEMA = deepFrozen({
  type: 'object',
  properties: {
    say: { type: 'string', description: 'One or two sentences for the user, in the language of the request.' },
    fill: {
      type: 'array',
      maxItems: ARRANGE_LIMITS.fill,
      items: {
        type: 'object',
        properties: {
          block: { type: 'integer', description: 'The number of a take to create of the bobine that has no text.' },
          text: { type: 'string', description: 'What is seen and what happens in it, in one or two sentences.' },
        },
        required: ['block', 'text'],
        additionalProperties: false,
      },
    },
    add: {
      type: 'array',
      maxItems: ARRANGE_LIMITS.add,
      items: {
        anyOf: [
          {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'What is seen and what happens in this new take, in one or two sentences.' },
              seconds: { type: 'number', description: 'From 1 to 60, 5 usually.' },
              link: {
                type: 'string',
                enum: ['suite', 'cut'],
                description: 'suite: goes on from what is right before it, without a cut; cut: a new shot.',
              },
              start: NAMED,
              end: NAMED,
            },
            required: ['text', 'seconds', 'link', 'start', 'end'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              take: { type: 'string', description: 'A take of the project laid as it is, as "prise N".' },
              seconds: { type: ['number', 'null'], description: 'How long an image is shown, 3 usually; a video is laid whole.' },
            },
            required: ['take', 'seconds'],
            additionalProperties: false,
          },
        ],
      },
    },
  },
  required: ['say', 'fill', 'add'],
  additionalProperties: false,
});

// ------------------------------------------------------------------ the plan read
const UNREADABLE = 'Moodix AI n’a pas rendu de plan lisible.';
const PLAN_KEYS = ['say', 'fill', 'add'];
const isPlan = value => plain(value) && PLAN_KEYS.some(key => key in value);
/** How many `{` of an answer are tried before it is said unreadable: a plan is near its start. */
const TRIED = 64;

/** Where the object opened at `open` closes (its braces balanced, those of its strings not counted), or -1. */
function closing(text, open) {
  let depth = 0,
    quoted = false;
  for (let at = open; at < text.length; at++) {
    const char = text[at];
    if (quoted) {
      if (char === '\\') at++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && !--depth) return at;
  }
  return -1;
}
/** `json` without the commas before a closing brace or bracket, which JSON refuses and models write. */
function withoutTrailingCommas(json) {
  const closer = /\s*[}\]]/y;
  let out = '',
    quoted = false;
  for (let at = 0; at < json.length; at++) {
    const char = json[at];
    if (quoted) {
      out += char;
      if (char === '\\') out += json[++at] ?? '';
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    closer.lastIndex = at + 1;
    if (char === ',' && closer.test(json)) continue;
    out += char;
  }
  return out;
}
function parsed(json) {
  for (const tried of [json, withoutTrailingCommas(json)])
    try {
      return JSON.parse(tried);
    } catch {
      // (The next form, or none.)
    }
  return undefined;
}
/**
 * The plan of an answer: the first balanced object that JSON reads and that is a plan, alone, in a
 * block ```json, or among sentences; one that holds the plan as its field (« { "plan": { … } } ») gives it.
 */
function planIn(text) {
  for (let open = text.indexOf('{'), tried = 0; open >= 0 && tried < TRIED; open = text.indexOf('{', open + 1), tried++) {
    const close = closing(text, open),
      found = close < 0 ? undefined : parsed(text.slice(open, close + 1));
    if (!plain(found)) continue;
    if (isPlan(found)) return found;
    const inner = Object.values(found).find(isPlan);
    if (inner) return inner;
  }
  return null;
}

/**
 * A text of the plan, trimmed and cut to `most` characters; '' when it is none. (0.6.161) The prompt
 * shows the form of the plan with « ... » in place of its texts, and a weak model copies it: a text of
 * dots, « … » and spaces only is no text.
 */
const PLACEHOLDER = /^[\s.…]*$/;
const textOf = (value, most) => {
  const text = typeof value === 'string' ? value.trim().slice(0, most).trim() : '';
  return PLACEHOLDER.test(text) ? '' : text;
};
/** « 1er », « 2e »: an element of the plan as a sentence says it. */
const nth = number => (number === 1 ? '1er' : number + 'e');
/** What the plan wrote, as a sentence quotes it. */
const cited = value => '« ' + (typeof value === 'string' ? value.trim() : JSON.stringify(value) ?? String(value)).slice(0, 40) + ' »';

/** Seconds: 4, « 4 », « 4 s », « 4,5 », « 5 secondes »; null when absent or not read (the default comes as it is laid). */
function secondsOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const found = /^\s*(\d+(?:[.,]\d+)?)\s*(?:s|sec|secs|secondes?|seconds?)?\s*$/i.exec(value);
  return found ? Number(found[1].replace(',', '.')) : null;
}
const SUITE = new Set(['suite', 'continuation', 'continue']);
/** 'suite' for a suite, by its names; 'cut' for anything else (« cut », « coupe », « new », nothing). */
const linkRead = value => (typeof value === 'string' && SUITE.has(value.trim().toLowerCase()) ? 'suite' : 'cut');
const NONE = new Set(['', 'none', 'null', 'aucune', 'aucun', 'rien']);
const BARE = /^(?:n[°o]\.?\s*)?#?\s*(\d{1,9})$/,
  // (0.6.161) The state shown to the model says « image prise 6 », « video prise 4 »: it is copied as it
  // is. Words before the name are let be, as long as the value ends with it.
  WORDED = /(?:^|[^\p{L}\p{N}])(?:prise|take)\s*(?:n[°o]\.?)?\s*#?\s*(\d{1,9})$/u;
/**
 * The number of a take named by the plan: « prise 3 », « Prise 3 », « take 3 », « #3 », 3, « image prise
 * 3 », « la prise 3 » → 3; nothing (null, « », « none », « aucune ») → null; undefined when it cannot be
 * read (« la fusée », « ref2 »).
 */
function numberOf(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const words = value.trim().toLowerCase();
  if (NONE.has(words)) return null;
  const found = BARE.exec(words) ?? WORDED.exec(words);
  return found ? Number(found[1]) : undefined;
}
/** The number of a block: 4, « 4 », « bloc 4 », « #4 »; undefined otherwise. */
function blockOf(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
  const found = typeof value === 'string' ? /^\s*(?:bloc|block)?\s*#?\s*(\d{1,9})\s*$/i.exec(value) : null;
  return found ? Number(found[1]) : undefined;
}
/** A list of the plan; a single element given alone is read as a list of it, anything else is said. */
function listIn(value, said, problems) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (plain(value)) return [value];
  problems.push(said);
  return [];
}

/** An element of `fill`, normalized: [{ block, text }], or [] with what is left out said. */
function fillRead(item, index, problems) {
  const which = `Le ${nth(index + 1)} texte du plan`;
  if (!plain(item)) {
    problems.push(`${which} n’est pas le texte d’un bloc : il est laissé de côté.`);
    return [];
  }
  const block = blockOf(item.block),
    text = textOf(item.text, ARRANGE_LIMITS.text);
  if (block === undefined) {
    problems.push(`${which} ne dit pas quel bloc il écrit${item.block === undefined ? '' : ' (' + cited(item.block) + ')'} : il est laissé de côté.`);
    return [];
  }
  if (!text) {
    problems.push(`${which} (bloc ${block}) est vide : il est laissé de côté.`);
    return [];
  }
  return [{ block, text }];
}

/**
 * An element of `add`, normalized: a take of the project [{ take, seconds }] when it names one (a take
 * named wins over a text: it is already made), else a take to create [{ text, seconds, link, start,
 * end }]; [] with what is left out said.
 */
function addRead(item, index, problems) {
  const which = `Le ${nth(index + 1)} ajout du plan`;
  if (!plain(item)) {
    problems.push(`${which} n’est ni une prise à créer ni une prise du projet : il est laissé de côté.`);
    return [];
  }
  const take = numberOf(item.take),
    text = textOf(item.text, ARRANGE_LIMITS.text),
    seconds = secondsOf(item.seconds);
  if (Number.isInteger(take)) return [{ take, seconds }];
  if (take === undefined) problems.push(`${which} nomme une prise illisible (${cited(item.take)}) : elle est laissée de côté.`);
  if (!text) {
    if (take !== undefined) problems.push(`${which} n’a ni texte ni prise : il est laissé de côté.`);
    return [];
  }
  const photo = (side, label) => {
    const number = numberOf(item[side]);
    if (number === undefined) problems.push(`${which} a une photo de ${label} illisible (${cited(item[side])}) : elle est laissée de côté.`);
    return number ?? null;
  };
  return [{ text, seconds, link: linkRead(item.link), start: photo('start', 'début'), end: photo('end', 'fin') }];
}

/**
 * The plan read in the answer of the model: `{ arrangement: { say, fill, add }, problems }`, numbers as
 * integers, texts cut to ARRANGE_LIMITS, unknown fields left out; `problems`: a sentence for each element
 * left out. A plan that only says something (nothing to lay: « Je ne trouve pas la prise 42. ») is read.
 * Throws when the answer holds no object, or one with nothing said and nothing to lay or to write.
 */
export function readArrangement(text) {
  const found = typeof text === 'string' ? planIn(text) : null;
  if (!found) throw new Error(UNREADABLE);
  const problems = [],
    say = textOf(found.say, ARRANGE_LIMITS.say),
    fill = listIn(found.fill, 'Les textes à écrire du plan ne sont pas une liste : ils sont laissés de côté.', problems).flatMap((item, index) =>
      fillRead(item, index, problems),
    ),
    add = listIn(found.add, 'Les prises à ajouter du plan ne sont pas une liste : elles sont laissées de côté.', problems).flatMap((item, index) =>
      addRead(item, index, problems),
    );
  if (!say && !fill.length && !add.length) throw new Error(UNREADABLE);
  return { arrangement: { say, fill, add }, problems };
}

// ------------------------------------------------------------------ the plan laid
/** What a take to create that was laid may go on from (linkOf): never 'loose' nor 'cut'. */
const SUITES = ['suite', 'last', 'wait'];

/**
 * (0.6.161) No function of the model marks a take to create as a suite but withEndPulled, from the end
 * of a video pulled by hand: the mark is set here as it sets it, and linkOf says whether it holds.
 */
const suited = (montage, id) => ({
  ...montage,
  plans: montage.plans.map(plan => (plan.id === id ? { ...plan, todo: { ...plan.todo, suite: true } } : plan)),
});

/**
 * Why the take to create laid after the end of `montage` cannot go on from what is before it. (Said next
 * to the instants of that take: no number of block, which the screen does not show.)
 */
function whyNoSuite(montage, lengthOf) {
  const before = montage.plans.at(-1);
  if (!before) return 'Rien avant elle à continuer : c’est un nouveau plan, pas une suite.';
  if (before.kind === 'image') return 'Une image est avant elle, une suite ne la continue pas : c’est un nouveau plan.';
  if (!(lengthOf(before.source) > 0)) return 'La durée de la vidéo d’avant n’est pas connue : c’est un nouveau plan, pas une suite.';
  return 'La vidéo d’avant est coupée avant sa fin : c’est un nouveau plan, pas une suite.';
}

/** A length brought back within `low` and `high`, as a note says it. */
const brought = (wanted, kept, low, what) =>
  `Durée ramenée de ${shownSeconds(wanted)} à ${shownSeconds(kept)}, le plus ${wanted < low ? 'court' : 'long'} pour ${what}.`;

/**
 * A take to create laid after the end of `montage`: its length within what a take to create can be,
 * its photos when they are images of the project, a suite when it can go on from what is before it
 * (a start photo wins: it is a new shot that starts on it). `{ montage, id }`.
 */
function todoLaid(montage, item, { recordOf, newId, tell, lengthOf }) {
  const id = newId(),
    text = textOf(item.text, ARRANGE_LIMITS.text),
    wanted = Number.isFinite(item.seconds) ? item.seconds : null,
    seconds = clamp(wanted ?? TODO_LIMITS.usual, TODO_LIMITS.shortest, TODO_LIMITS.longest);
  const photoOf = (number, label) => {
    if (!Number.isInteger(number)) return null;
    const record = recordOf(number);
    if (!record) tell(id, `La prise ${number} n’est pas dans ce projet : pas de photo de ${label}.`);
    else if (trackOf(record) !== 'image') tell(id, `La prise ${number} n’est pas une image : elle ne peut pas être sa photo de ${label}.`);
    else return record;
    return null;
  };
  const start = photoOf(item.start, 'début'),
    end = photoOf(item.end, 'fin');
  let suite = item.link === 'suite';
  if (suite && start) {
    tell(id, `Elle commence sur la prise ${item.start} : une suite ne commence pas sur une photo, c’est un nouveau plan.`);
    suite = false;
  }
  // (Without a length, the usual one, unsaid: it is no repair.)
  if (wanted !== null && wanted !== seconds) tell(id, brought(wanted, seconds, TODO_LIMITS.shortest, 'une prise à créer'));
  let next = withTodoDrawn(montage, { id, at: montageSeconds(montage), seconds }).montage;
  next = withItemChanged(next, id, { prompt: text });
  if (start) next = withPhotoIn(next, start, id, 'start').montage;
  if (end) next = withPhotoIn(next, end, id, 'end').montage;
  if (suite) {
    const tried = suited(next, id);
    if (SUITES.includes(linkOf(tried, id, lengthOf).kind)) next = tried;
    else tell(id, whyNoSuite(montage, lengthOf));
  }
  return { montage: next, id };
}

/**
 * A take of the project laid as it is after the end of `montage`: a video whole, an image for its
 * `seconds` (STILL_SECONDS by default). A sound, or a take that is not of the project, is not laid:
 * said (of no take of the bobine), and undefined.
 */
function takeLaid(montage, { take, seconds }, { recordOf, newId, tell }) {
  const record = recordOf(take),
    track = record ? trackOf(record) : null;
  if (!record) return void tell(null, `La prise ${take} n’est pas dans ce projet : elle n’est pas posée.`);
  if (track !== 'video' && track !== 'image') return void tell(null, `La prise ${take} est un son : elle n’est pas posée sur la bobine.`);
  const id = newId();
  let next = withTake(montage, record, { id });
  const plan = () => next.plans.at(-1);
  if (track === 'video') {
    const shown = plan().to - plan().from;
    if (!takeSeconds(record)) tell(id, `La durée de la prise ${take} n’est pas connue : posée pour ${shownSeconds(shown)}.`);
    else if (Number.isFinite(seconds) && Math.abs(seconds - shown) >= 0.05) tell(id, `La prise ${take} est une vidéo : posée entière (${shownSeconds(shown)}).`);
    return { montage: next, id };
  }
  // (Without seconds it stays as withTake lays it, STILL_SECONDS, unsaid.)
  if (Number.isFinite(seconds)) {
    // (Its length as a hand gives it: within what the bobine keeps of a plan.)
    next = withItemChanged(next, id, { to: seconds });
    if (seconds < MONTAGE_LIMITS.shortest || seconds > MONTAGE_LIMITS.longest) tell(id, brought(seconds, plan().to, MONTAGE_LIMITS.shortest, 'une image'));
  }
  return { montage: next, id };
}

/**
 * `montage` with the plan `arrangement` (as readArrangement gives it) laid on it: `{ montage, added,
 * filled, notes }`.
 * - `fill` first, on the blocks as they are (block n: the n-th plan of the film, holes not counted): the
 *   text of a take to create that has none. One that has its text keeps it;
 * - then `add`, from the end of the bobine, each against the one before it, in the order of the plan;
 * - `takes`: the records of the project, a take named by `outputs[0].take`; `newId()`: a new identifier;
 *   `lengthOf(source)`: the length of a video of the project in seconds, or null (as for linkOf).
 * `added`, `filled`: the identifiers of the plans laid and written; `notes`: each repair, `{ id, text }`
 * (0.6.161, the page shows it next to the instants of its take): `id`, the take of the returned bobine
 * it is about (laid, or aimed at by `fill`), null when it is about none (a block that is not there, a
 * take not laid, a limit); `text`, a sentence read alone, without a number of block (the screen shows
 * none). The same montage when nothing could be laid nor written.
 */
export function withArrangement(montage, arrangement, { takes = [], newId, lengthOf = () => null } = {}) {
  const notes = [],
    tell = (id, text) => notes.push({ id, text }),
    added = [],
    filled = [],
    records = Array.isArray(takes) ? takes : [],
    recordOf = number => records.find(record => record?.outputs?.[0]?.take === number) ?? null,
    fill = Array.isArray(arrangement?.fill) ? arrangement.fill : [],
    add = Array.isArray(arrangement?.add) ? arrangement.add : [],
    context = { recordOf, newId, tell, lengthOf };
  let next = placed(montage);
  const blocks = next.plans;
  for (const item of fill.slice(0, ARRANGE_LIMITS.fill)) {
    const block = item?.block,
      plan = Number.isInteger(block) && block > 0 ? blocks[block - 1] : null,
      text = textOf(item?.text, ARRANGE_LIMITS.text);
    if (!plan) tell(null, 'Un texte était écrit pour une prise qui n’est pas sur la bobine : laissé de côté.');
    else if (!isTodo(plan)) tell(plan.id, 'Ce n’est pas une prise à créer : le texte écrit pour elle est laissé de côté.');
    else if (filled.includes(plan.id)) tell(plan.id, 'Deux textes lui étaient donnés : seul le premier est écrit.');
    else if ((plan.todo.prompt ?? '').trim()) tell(plan.id, 'Elle a déjà son texte : gardé tel quel.');
    else if (!text) tell(plan.id, 'Le texte donné est vide : rien n’est écrit.');
    else {
      next = withItemChanged(next, plan.id, { prompt: text });
      filled.push(plan.id);
    }
  }
  if (fill.length > ARRANGE_LIMITS.fill)
    tell(
      null,
      `Le plan écrivait ${fill.length} textes : les ${fill.length - ARRANGE_LIMITS.fill} derniers sont laissés de côté (${ARRANGE_LIMITS.fill} au plus).`,
    );
  const laid = add.slice(0, ARRANGE_LIMITS.add);
  for (const [index, item] of laid.entries()) {
    if (next.plans.length >= MONTAGE_LIMITS.plans) {
      const left = laid.length - index;
      tell(
        null,
        `La bobine est pleine (${MONTAGE_LIMITS.plans} prises) : ` +
          (left > 1 ? `les ${left} dernières prises du plan ne sont pas posées.` : 'la dernière prise du plan n’est pas posée.'),
      );
      break;
    }
    const step = Number.isInteger(item?.take)
      ? takeLaid(next, item, context)
      : textOf(item?.text, ARRANGE_LIMITS.text)
        ? todoLaid(next, item, context)
        : void tell(null, `Le ${nth(index + 1)} ajout du plan n’a ni texte ni prise : il n’est pas posé.`);
    if (!step) continue;
    next = step.montage;
    added.push(step.id);
  }
  if (add.length > ARRANGE_LIMITS.add)
    tell(
      null,
      `Le plan ajoutait ${add.length} prises : les ${add.length - ARRANGE_LIMITS.add} dernières sont laissées de côté (${ARRANGE_LIMITS.add} au plus).`,
    );
  return { montage: added.length || filled.length ? next : montage, added, filled, notes };
}
