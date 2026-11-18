import { citedIn } from '../public/cited-takes.mjs';

/**
 * (0.6.100) The earlier creations the tools of the small local model list by their identifier: in
 * every role that takes an image or a video, an enum of the run_ids of the conversation and one of the
 * take numbers of the project (lib/tool-catalog.mjs), and the run_ids of local_read_output
 * (lib/output-tools.mjs). Every creation made since the conversation began was listed: about 300
 * characters more for each, read again whole at every request and after every creation (llama.cpp
 * loses what it had read when it is stopped for a generation), 41 000 characters of tools after
 * 40 creations, 18/11, where the default context holds 8 192 tokens. Those listed now, in the order
 * they had:
 * - the last LISTED creations of each kind (image, video, sound) of the conversation;
 * - those the last exchange writes (from the user's message before the last one): a series just made,
 *   a creation to go on from in the same turn;
 * - those the user's last message names by their number (« la prise 3 », « prises 4 à 6 »,
 *   public/cited-takes.mjs), and the take on the screen of the Studio (`screen`);
 * - what the creations kept were made from (the image a video started on, to make it again);
 * - of the takes of the project: those of the creations kept, those named, and the last TAKES_LISTED of
 *   each kind. A take number costs a few characters where a run_id costs forty: more of them are kept,
 *   so that the model reaches an older creation of the conversation by its number ({"take": n}, what
 *   its results tell it to pass). llama.cpp holds a call to what the tools list: a run_id left out
 *   could only be written as another one.
 * An older creation stays usable: named by its number in the message (kept here), from a button under
 * a take or from the Studio (the application writes those calls itself, without the model and its
 * tools), or attached again to the message. A large model is given no list (its tools are the same at
 * every request): this is not asked for it.
 */
export const LISTED = 8;
export const TAKES_LISTED = 32;

const UUID = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g;
const kindOf = item => item?.mediaType || 'image';
const said = message => message?.role === 'user' && !message.internal;

/** The texts of a message where an identifier or a number may be written: its words, its calls. */
function textsOf(message) {
  const texts = [];
  if (typeof message?.content === 'string') texts.push(message.content);
  else if (Array.isArray(message?.content))
    for (const part of message.content) if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text);
  for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : [])
    if (typeof call?.function?.arguments === 'string') texts.push(call.function.arguments);
  return texts;
}

/** The take numbers the user's last message names, with the take on the screen of the Studio. */
function namedNumbers(messages, screen) {
  const numbers = new Set();
  for (const text of textsOf(messages.findLast(said)))
    for (const item of citedIn(text)) if (item.kind === 'take') numbers.add(item.number);
  if (Number.isInteger(screen?.take)) numbers.add(screen.take);
  return numbers;
}

/** The identifiers the last exchange writes: from the user's message before the last one to the end. */
function namedIds(messages) {
  const users = messages.flatMap((message, index) => (said(message) ? [index] : []));
  const ids = new Set();
  for (const message of messages.slice(users.length > 1 ? users.at(-2) : 0))
    for (const text of textsOf(message)) for (const [id] of text.matchAll(UUID)) ids.add(id);
  return ids;
}

/**
 * What the tools of the local model list: `runs`, the creations of the conversation, the newest first
 * (as lib/gallery.mjs lists them); `takes`, those of the project ({ take, id, mediaType, … }, in
 * the order of their numbers); `messages`, the conversation as the page sends it; `screen`, the take
 * on the screen of the Studio ({ take, media }, lib/model-wording.mjs, screenOf). The same arrays,
 * those kept only, in their order. `per`: the creations of each kind listed by their run_id;
 * `numbers`: the takes of each kind listed by their number.
 */
export function listedSources(
  { runs = [], takes = [], messages = [], screen = null } = {},
  { per = LISTED, numbers: perNumber = TAKES_LISTED } = {},
) {
  const list = Array.isArray(messages) ? messages : [],
    numbers = namedNumbers(list, screen),
    ids = namedIds(list),
    kept = new Set(),
    counted = {};
  for (const run of runs) {
    counted[kindOf(run)] = (counted[kindOf(run)] ?? 0) + 1;
    if (
      counted[kindOf(run)] <= per ||
      ids.has(run.id) ||
      (run.outputs ?? []).some(output => numbers.has(output?.take))
    )
      kept.add(run.id);
  }
  // What the creations kept were made from: one of this conversation by its run, one of another
  // conversation of the project by its take.
  const own = new Map(runs.map(run => [run.id, run])),
    elsewhere = new Set();
  for (const id of [...kept])
    for (const reference of own.get(id)?.parameters?.references ?? [])
      if (typeof reference?.output_id !== 'string') continue;
      else if (own.has(reference.output_id)) kept.add(reference.output_id);
      else elsewhere.add(reference.output_id);
  const recent = new Set(),
    last = {};
  for (let at = takes.length - 1; at >= 0; at--)
    if ((last[kindOf(takes[at])] = (last[kindOf(takes[at])] ?? 0) + 1) <= perNumber) recent.add(at);
  return {
    runs: runs.filter(run => kept.has(run.id)),
    takes: takes.filter(
      (take, at) => recent.has(at) || kept.has(take?.id) || elsewhere.has(take?.id) || numbers.has(take?.take),
    ),
  };
}
