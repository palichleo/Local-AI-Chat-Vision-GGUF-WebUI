import { citedIn } from '../public/cited-takes.mjs';
import { STILL_SECONDS, TODO_LIMITS, isTodo, linkOf, montageSeconds, placed, takeSeconds, trackOf } from '../public/montage-model.mjs';

/**
 * (0.6.161) What the chat model reads when it is asked to arrange a bobine (claude_design/arrangeur/
 * CONTRAT.md, « Pièce B »): a request of its own, apart from the conversation, whose answer is a plan in
 * JSON (public/montage-arrange.mjs reads it and lays it). Nothing is asked of a model here: only text.
 *
 * Its first reader is the small local model, which follows long instructions badly (lib/plan-prompt.mjs,
 * lib/scene-prompt.mjs were written for that reason). So:
 * - the instructions are constant and short, in English: the bobine, the takes and the request are in the
 *   message of the user, and nothing in them is ever written into the instructions;
 * - they never say what happens once the plan is given (a weak model says it back instead of answering),
 *   and they hold no example to copy: the shape of the plan only, with « ... » where words go;
 * - what the model would have to work out is said for it in the message: the number of each block, its
 *   instants, what it goes on from, which blocks have no text yet, whether a suite may follow the end;
 * - no identifier is shown: blocks by their number, takes as « prise 12 », as the page says them.
 */

// What would let the model write an identifier of the application: none reaches a message.
const UUID = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi;
// How much of a prompt describes a take, of the text of a take to create, of what the user wrote.
const DESCRIBED = 160;
const WRITTEN = 240;
const ASKED = 2000;
const SAID = 300;
// The earlier requests shown, the last ones.
const EARLIER = 3;
// Under this, a black gap between two blocks is not shown (it would read « 0 s »).
const GAP = 0.05;

const SYSTEM =
  'You arrange the bobine of a short film: its takes, one after the other on a timeline. You are given the bobine as it ' +
  'is now, in numbered blocks, the takes of the project you may use, and the user\'s request. Answer with a plan in ' +
  'JSON and nothing else: no words before or after it, no code fence.\n\n' +
  'A plan does two things:\n' +
  '- add: new takes after the end of the bobine, in the order of the film, each right after the one before. Only what ' +
  'is new: the blocks already there are never written again, changed or moved.\n' +
  '- fill: the text of each take to create on the bobine that has none yet, as {"block": its number, "text": "..."}.\n\n' +
  'An item of add is either a take to create, a new moving shot:\n' +
  '{"text": "...", "seconds": 5, "link": "cut" or "suite", "start": "prise N" or null, "end": "prise N" or null}\n' +
  'or a video of the project, laid whole as it is:\n' +
  '{"take": "prise N"}\n' +
  // (Measured: « trois plans de 3, 6 et 10 secondes » got a video of 5 s as its second shot, said « 6 ».)
  'It keeps its own length: a shot whose length is asked is a take to create.\n\n' +
  'text: one or two sentences, what is seen and what happens in that take, concrete and visible. Each text stands on ' +
  // (Measured: « Le vaisseau argenté de la prise 2 monte… »: a number means nothing to who makes the video.)
  'its own: name who and where again, never "he" or "the same place", and never a take or block number.\n' +
  `seconds: from ${TODO_LIMITS.shortest} to ${TODO_LIMITS.longest}, ${TODO_LIMITS.usual} when nothing says otherwise.\n` +
  'link: "suite" goes on without a cut from the take right before it (a video or a take to create): the same people, ' +
  'the same place, the action continues. "cut" starts a new shot. A suite never follows an image, never opens an ' +
  'empty bobine and never has a start image.\n' +
  'start, end: the image the take starts on, the image it arrives on, or null. Only an image can be a start or an ' +
  'end, never a video. The same image may end one take and start the next.\n' +
  // (Measured on 20/11 with a small ChatGPT: offered as an item like the others, an image laid still was
  // taken nearly every time, a film of fixed pictures in place of takes that start or end on them.)
  'An image of the project is never laid by itself: to show it, a take to create starts on it or arrives on it, and ' +
  `its text says what moves. Only when the request asks for a still image: {"take": "prise N", "seconds": ${STILL_SECONDS}}.\n` +
  'To go on from a video of the project: lay it, then a suite.\n\n' +
  'Name takes only as "prise N" with a number from the list, and blocks only by their number. When the request says ' +
  'neither how many takes nor how long, add three to five. When something asked cannot be done, do the rest.\n' +
  'say: one or two sentences for the user: what you arranged, and what you could not do.\n' +
  'say and every text are in the language the request itself is written in.\n\n' +
  'The plan:\n' +
  '{"say": "...", "fill": [...], "add": [...]}\n' +
  'fill and add may be empty lists.';

/**
 * (0.6.161) The same for the local model (`simple`), measured on 20/11 on his card (Qwen3.5 9B, 24 requests,
 * every plan read): given two lists, it wrote its film in `fill` (« block 1, 2, 3 », often the right one)
 * and laid a part of it only in `add`; it gave videos as start and end images. So for it: one list, no
 * `fill` (a take to create without its text is written from its photos by the Éclipse, as before), and
 * the images and the videos of the project in two lists of their own (bobineText).
 */
const SYSTEM_SIMPLE =
  'You arrange the bobine of a short film: its takes, one after the other on a timeline. You are given the bobine as it ' +
  'is now, the images and the videos of the project, and the user\'s request. Answer with a plan in JSON and nothing ' +
  'else: no words before or after it, no code fence.\n\n' +
  'The plan:\n' +
  '{"say": "...", "add": [...]}\n' +
  'add: the new takes, in the order of the film. They go after the end of the bobine. Every take of your film is in ' +
  'add; the blocks already on the bobine are not.\n\n' +
  'Each item of add is a take to create, a new moving shot:\n' +
  '{"text": "...", "seconds": 5, "link": "cut" or "suite", "start": "prise N" or null, "end": "prise N" or null}\n' +
  'text: one or two sentences, what is seen and what happens in that take. Each text stands on its own: name who and ' +
  'where again, and never a take number.\n' +
  `seconds: from ${TODO_LIMITS.shortest} to ${TODO_LIMITS.longest}, ${TODO_LIMITS.usual} when nothing says otherwise. A length the request gives is kept exactly.\n` +
  'start: an image of the list the take starts on, or null. end: an image of the list it arrives on, or null. Only ' +
  'images, never a video.\n' +
  'link: "cut" is a new shot. "suite" is the same shot going on from the take right before it, with no start image. ' +
  'The first take of an empty bobine is a cut.\n' +
  'To show an image of the project, start or end a take on it.\n' +
  'A video of the project is laid whole as it is with {"take": "prise N"}, in place of a take to create.\n\n' +
  'When the request says neither how many takes nor how long, add three to five. When something asked cannot be ' +
  'done, do the rest.\n' +
  'say: one or two sentences for the user: what you arranged, and what you could not do.\n' +
  'say and every text are in the language the request itself is written in.';

/** A text on one line, without identifiers, cut at a word within `most` characters. */
function plain(text, most) {
  const flat = String(text ?? '')
    .replace(UUID, '…')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= most) return flat;
  const head = flat.slice(0, most - 1),
    word = head.replace(/\s+\S*$/, '');
  return (word.length > most / 2 ? word : head).replace(/[\s,;:.]+$/, '') + '…';
}
// What a take shows or what happens in it, between the double quotes of the message (its own become single).
const quoted = (text, most = DESCRIBED) => plain(text, most).replace(/"/g, "'");
const secs = value => String(Math.round(value * 10) / 10);

const pictured = record => trackOf(record) === 'video' || trackOf(record) === 'image';
/** The number of a take as the page shows it (« Prise 12 »), or null. */
const numberOf = (record, output = 0) => {
  const take = record?.outputs?.[output]?.take ?? record?.outputs?.[0]?.take;
  return Number.isInteger(take) ? take : null;
};
const sameConversation = (record, source) => !source.conversationId || !record.conversationId || record.conversationId === source.conversationId;
const recordOf = (takes, source) => (source && takes.find(record => record.id === source.runId && sameConversation(record, source))) || null;
const nameOf = (takes, source) => {
  const number = numberOf(recordOf(takes, source), source?.output ?? 0);
  return number ? 'prise ' + number : null;
};
const listOf = value => (Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : []);

/** One block of the bobine: its number, its instants, what it is, and what it goes on from. */
function blockLine(montage, plans, index, takes, lengthOf) {
  const plan = plans[index],
    length = plan.to - plan.from,
    head = `Block ${index + 1}, from ${secs(plan.at)} to ${secs(plan.at + length)} s (${secs(length)} s): `;
  if (isTodo(plan)) {
    // (Read as the Bobine reads it, linkOf: only a suite joined to what is before it goes on from it.)
    const link = linkOf(montage, plan.id, lengthOf),
      how =
        link.kind === 'photo' || link.kind === 'own'
          ? 'cut'
          : link.kind === 'loose'
            ? 'suite, not joined to the block before it'
            : `suite of block ${link.before}`,
      prompt = (plan.todo.prompt ?? '').trim(),
      photo = side => {
        const source = plan.photos?.[side];
        if (!source) return '';
        const name = nameOf(takes, source);
        return ` ${side === 'start' ? 'Starts' : 'Ends'} on ${name ? 'image ' + name : 'an image no longer in the project'}.`;
      };
    return head + `take to create, ${how}. ` + (prompt ? `Text: "${quoted(prompt, WRITTEN)}"` : 'No text yet.') + photo('start') + photo('end');
  }
  // (What a take shows ends its line, between quotes: no full stop after them.)
  const record = recordOf(takes, plan.source),
    name = nameOf(takes, plan.source),
    about = quoted(record?.prompt) ? `: "${quoted(record.prompt)}"` : '.',
    unnamed = `${plan.kind === 'image' ? 'an image' : 'a video'} ${record ? 'that has no number' : 'no longer in the project'}.`;
  if (!name) return head + unnamed;
  if (plan.kind === 'image') return head + `image ${name}, still` + about;
  const whole = lengthOf(plan.source),
    shown = !(whole > 0)
      ? ''
      : plan.from < 0.06 && Math.abs(plan.to - whole) <= 0.06
        ? ', shown whole'
        : `, shown from ${secs(plan.from)} to ${secs(plan.to)} s of its ${secs(whole)} s`;
  return head + `video ${name}${shown}` + about;
}

/** What may follow the end of the bobine: a suite, or a cut first. */
function endLine(montage, plans, lengthOf) {
  if (!plans.length) return 'The bobine is empty: what you add opens the film, and its first take is a cut.';
  const last = plans.at(-1),
    whole = last.kind === 'video' && !isTodo(last) ? lengthOf(last.source) : null,
    what = isTodo(last)
      ? 'a take to create: a suite may continue it'
      : last.kind === 'image'
        ? 'an image: what you add first is a cut'
        : !(whole > 0)
          ? 'a video: what you add first is a cut'
          : Math.abs(last.to - whole) <= 0.06
            ? 'a video shown to its end: a suite may continue it'
            : 'a video cut before its end: what you add first is a cut';
  return `The bobine ends at ${secs(montageSeconds(montage))} s with block ${plans.length}, ${what}.`;
}

/**
 * Where the bobine shows the records of the project: Map(record → { laid: [block…], photo: [block…] }), the
 * blocks that are that take, and those that start or end on it.
 */
function placesOf(plans, takes) {
  const places = new Map(),
    at = record => places.get(record) ?? places.set(record, { laid: [], photo: [] }).get(record);
  plans.forEach((plan, index) => {
    const laid = recordOf(takes, plan.source);
    if (laid) at(laid).laid.push(index + 1);
    for (const source of [plan.photos?.start, plan.photos?.end]) {
      const photo = recordOf(takes, source);
      if (photo && !at(photo).photo.includes(index + 1)) at(photo).photo.push(index + 1);
    }
  });
  return places;
}
const blocks = list => `block${list.length > 1 ? 's' : ''} ${list.join(', ')}`;

/**
 * The takes of the project as the model reads them: the images and the videos that have a number (a sound
 * is never laid on the pictures), `most` at most, those the bobine and the request name first, then the
 * newest; listed by their number, each with the prompt that made it as what it shows (a take laid on the
 * bobine has it on its block already: where it is is said instead).
 */
function takesText(plans, takes, { most, request, simple = false }) {
  const all = takes.filter(record => pictured(record) && numberOf(record)),
    asked = citedIn(String(request ?? '')).flatMap(item => (item.kind === 'take' ? [item.number] : [])),
    byNumber = number => takes.find(record => numberOf(record) === number),
    // (The newest by when it was made, else by its number: the numbers of a project only grow.)
    newest = [...all].sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) || numberOf(b) - numberOf(a)),
    places = placesOf(plans, takes),
    named = [...places.keys(), ...asked.map(byNumber)].filter(record => all.includes(record)),
    kept = [...new Set([...named, ...newest])].slice(0, Number.isFinite(most) ? Math.max(0, Math.floor(most)) : 40),
    lines = [];
  const line = record => {
    const seconds = trackOf(record) === 'video' ? takeSeconds(record) : null,
      what = trackOf(record) === 'video' ? 'video' + (seconds ? ` of ${secs(seconds)} s` : '') : 'image',
      { laid = [], photo = [] } = places.get(record) ?? {},
      where = (laid.length ? `, laid as ${blocks(laid)}` : '') + (photo.length ? `, photo of ${blocks(photo)}` : ''),
      about = laid.length ? '' : quoted(record.prompt) ? `: "${quoted(record.prompt)}"` : ', no description';
    return `prise ${numberOf(record)}, ${what}${where}${about}`;
  };
  const sorted = [...kept].sort((a, b) => numberOf(a) - numberOf(b));
  if (!all.length) lines.push('The project has no image or video yet: start and end stay null, and add holds only takes to create.');
  else if (simple) {
    // (For the local model: what may be a start or an end apart from what may only be laid; it gave videos
    // as start and end images when they were in one list.)
    const images = sorted.filter(record => trackOf(record) === 'image'),
      videos = sorted.filter(record => trackOf(record) === 'video');
    if (images.length) lines.push('The images of the project, to start or to end a take on:', ...images.map(line));
    if (videos.length) lines.push((images.length ? '\n' : '') + 'The videos of the project, never a start nor an end:', ...videos.map(line));
    if (kept.length < all.length) lines.push(`(${all.length - kept.length} older takes of the project are left out.)`);
  } else {
    lines.push(
      kept.length < all.length
        ? `The takes of the project you may name (${kept.length} of ${all.length}, the older ones left out):`
        : 'The takes of the project you may name:',
    );
    lines.push(...sorted.map(line));
  }
  // (What the request names that cannot be laid is said, for the model to say it rather than to make it up.)
  const missing = asked.filter(number => !byNumber(number)),
    sounds = asked.filter(number => byNumber(number) && !pictured(byNumber(number)));
  if (missing.length) lines.push('Not in this project: ' + missing.map(number => 'prise ' + number).join(', ') + '.');
  if (sounds.length) lines.push('A sound, which a plan cannot lay: ' + sounds.map(number => 'prise ' + number).join(', ') + '.');
  return lines.join('\n');
}

/**
 * The state of the bobine and the takes of the project, as the model reads them. The blocks are numbered
 * from 1 in the order of the film, as public/montage-arrange.mjs reads `fill` (block n is
 * placed(montage).plans[n - 1]); the black gaps between them have no number. `lengthOf(source)`: the
 * length of a video of the project in seconds, or null (as for linkOf; by default read from `takes`).
 * `request`: what the user asks, for the takes it names to be listed first.
 */
export function bobineText(montage, takes, { lengthOf, most = 40, request = '', simple = false } = {}) {
  const records = listOf(takes),
    length = typeof lengthOf === 'function' ? lengthOf : source => takeSeconds(recordOf(records, source)),
    shaped = montage && typeof montage === 'object' ? { ...montage, plans: listOf(montage.plans) } : { plans: [] },
    { plans } = placed(shaped),
    // (Its name when it was given one: « Le renard en hiver » says what the film is about.)
    name = quoted(shaped.name, 80),
    lines = plans.length ? [`The bobine${name && name !== 'Sans titre' ? ` "${name}"` : ''} now:`] : [];
  let end = 0;
  plans.forEach((plan, index) => {
    if (plan.at - end >= GAP) lines.push(`Black gap, from ${secs(end)} to ${secs(plan.at)} s (${secs(plan.at - end)} s): not a block.`);
    lines.push(blockLine(shaped, plans, index, records, length));
    end = plan.at + (plan.to - plan.from);
  });
  lines.push(endLine(shaped, plans, length));
  const empty = plans.flatMap((plan, index) => (isTodo(plan) && !(plan.todo.prompt ?? '').trim() ? [index + 1] : []));
  // (Not said to the local model, which has no `fill`: it would be an invitation to write them.)
  if (empty.length && !simple) lines.push(`Takes to create with no text yet: ${blocks(empty)}.`);
  return lines.join('\n') + '\n\n' + takesText(plans, records, { most, request, simple });
}

/**
 * The messages of the request: [{ role: 'system', content }, { role: 'user', content }]. The instructions
 * are the same for every bobine and every request; the message holds the bobine, the takes, the earlier
 * requests of this bobine (`previous`: [{ request, say }], the last three, oldest first), the standing
 * instructions of the user (`preferences`, which win), then the request, last, nearest to the answer.
 */
export function arrangeMessages({ montage, takes = [], lengthOf, request = '', previous = [], preferences = '', most = 40, simple = false } = {}) {
  const asked = plain(request, ASKED),
    earlier = listOf(previous)
      .filter(item => plain(item.request, SAID))
      .slice(-EARLIER)
      .map(item => `- « ${plain(item.request, SAID)} »` + (plain(item.say, SAID) ? ` You answered: « ${plain(item.say, SAID)} »` : '')),
    wishes = plain(preferences, ASKED),
    parts = [bobineText(montage, takes, { lengthOf, most, request: asked, simple })];
  // (What came of them is on the bobine: said so, for the model not to lay it again.)
  if (earlier.length) parts.push('Earlier requests on this bobine, oldest first (the bobine above is what came of them):\n' + earlier.join('\n'));
  // (Where they differ from the rest, as in lib/plan-prompt.mjs: never « over everything », which a model
  // could read as over the shape of the answer too.)
  if (wishes) parts.push(`The user's standing instructions, which come first where they differ: ${wishes}`);
  // (The request last, nearest to the answer, with the language and the shape said once more.)
  parts.push(
    'The request (write say and every text in its language):\n' +
      (asked ? `« ${asked} »` : '(no words: go on with the film)') +
      '\nAnswer with the JSON plan only.',
  );
  return [
    { role: 'system', content: simple ? SYSTEM_SIMPLE : SYSTEM },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

/**
 * The message that asks for the plan again after an answer that could not be read (once): what was wrong
 * with it (`reason`, as public/montage-arrange.mjs says it), then the shape of the plan.
 */
export function retryMessage(reason, { simple = false } = {}) {
  const why = plain(reason, SAID),
    shape = simple ? '{"say": "...", "add": [...]}' : '{"say": "...", "fill": [...], "add": [...]}';
  return {
    role: 'user',
    content:
      'Your answer could not be read as the plan' +
      (why ? `: ${why}${/[.!?…]$/.test(why) ? '' : '.'}` : '.') +
      `\nAnswer again with the JSON plan only, ${shape}, with no words before or after it.`,
  };
}
