/**
 * A video is put to the user before it is generated. Moodix says in a few sentences what the clip
 * will be, and the proposal is shown at once where the user decides: its card under those words in
 * the Chat (`cardBrief`), the Studio set by the pointer in the Studio (`studioBrief`). It waits
 * there on « Générer »: nothing starts it but the user, whatever the settings allow.
 *
 * The words are left out, and in the Studio the pointer may start the video when the settings allow
 * it, only for a proposal the user has already had under their eyes and answered in words: the
 * same call (its verb and its arguments, value for value) made again after they wrote. Any other
 * call is a proposal they have not seen: another prompt, another length, other images, another
 * verb, the first call after a talk in plain text. (17/11, in the Studio: the user had to write
 * « go » to a plan nothing showed, and after « non, je veux refaire une vidéo, pas prolonger » a
 * video nobody had read started by itself.)
 *
 * Nothing here reads the request: the rule looks at the calls made since the last video, at what
 * became of them, and at whether the user has written since.
 */
const VIDEO = new Set(['create_video', 'extend_video', 'replace_character']);
// A character put in a video is a video like the others once made, but it is not agreed on in
// words: the application writes its prompt and shows the window where the user confirms, with
// the video, the character and that prompt (the plan the chat model wrote before it varied
// from one try to the next, « here is the video » included).
const SPOKEN = new Set(['create_video', 'extend_video']);

const textOf = message =>
  typeof message?.content === 'string'
    ? message.content
    : Array.isArray(message?.content)
      ? message.content.map(part => (typeof part?.text === 'string' ? part.text : '')).join(' ')
      : '';
const fromUser = message => message?.role === 'user' && !message.internal;

/** The arguments of a call as values; undefined when they cannot be read. */
function argumentsOf(call) {
  try {
    return JSON.parse(String(call?.function?.arguments ?? ''));
  } catch {
    return undefined;
  }
}
/** The same values, whatever the order of their keys (a list keeps its order). */
function same(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
}
// What the result of a proposal says when the user had it under their eyes and no video came of it:
// declined (« Annuler », « Refuser », a new message), left without an answer (the page closed on its
// card), or, as the Studio did before, answered by a plan in words to agree on.
const SEEN = /"status"\s*:\s*"(?:denied|waiting_for_user)"|"unanswered"\s*:\s*true/;
/**
 * Whether the proposal of a call made at `index` was put to the user: its result says so, or the
 * words of Moodix were written for it (`planned`, set by the page: its card or the Studio came
 * next, whatever became of it then). A call the application sent back before anything was shown (a
 * prompt too thin, images to look at first, arguments refused, a reply stopped before its card) was not.
 */
function shown(messages, index, call) {
  const message = messages[index];
  if (message.planned === true && textOf(message).trim()) return true;
  for (let next = index + 1; messages[next]?.role === 'tool'; next++)
    if (messages[next].tool_call_id === call?.id) return SEEN.test(textOf(messages[next]));
  // Left without its result: the page gives it the one of a proposal left without an answer.
  return true;
}

/**
 * Whether this video call is to be put to the user with the words of Moodix, and wait for them:
 * true unless this same proposal was already shown to them since the last video made in this
 * conversation, and they have written since.
 *
 * `talked`: for the small local model. Its tools tell it (in words kept as they are, see
 * tests/model-wording.mjs) to agree on a video in a spoken message and to call once answered: a
 * plan it wrote in plain words since the last video, which the user answered, is that agreement,
 * as it always was. Without it the user who said « go » to its plan read the same plan again.
 */
export function briefMissing(messages, call, { talked = false } = {}) {
  if (!Array.isArray(messages) || !SPOKEN.has(call?.function?.name)) return false;
  // A button on an output asks without a conversation; a draft promoted to its final was agreed on.
  if (!messages.some(fromUser) || /"reuse_output"\s*:/.test(String(call.function.arguments ?? ''))) return false;
  const videos = new Set(
    messages
      .flatMap(message => (message?.role === 'assistant' ? message.tool_calls || [] : []))
      .filter(made => VIDEO.has(made?.function?.name))
      .map(made => made.id),
  );
  const made = messages.findLastIndex(
    message =>
      message?.role === 'tool' && videos.has(message.tool_call_id) && /"status"\s*:\s*"success"/.test(textOf(message)),
  );
  // What follows a finished video up to the user's next message is the model looking at it.
  const from = made < 0 ? 0 : made + 1 + Math.max(0, messages.slice(made + 1).findIndex(fromUser));
  if (talked) {
    const spoke = messages.findIndex(
      (message, index) =>
        index >= from && message?.role === 'assistant' && !message.tool_calls?.length && textOf(message).trim(),
    );
    if (spoke >= 0 && messages.slice(spoke + 1).some(fromUser)) return false;
  }
  const asked = argumentsOf(call);
  if (asked === undefined) return true;
  // This same proposal, shown since then, and a message of the user after it.
  return !messages.some(
    (message, index) =>
      index >= from &&
      message?.role === 'assistant' &&
      (message.tool_calls || []).some(
        former =>
          former?.function?.name === call.function.name &&
          same(argumentsOf(former), asked) &&
          shown(messages, index, former),
      ) &&
      messages.slice(index + 1).some(fromUser),
  );
}

/**
 * What the model is told when its video comes with a card (the Chat): a few plain sentences over the
 * card, which shows the rest (length, format, prompt) and where the user agrees. Short on purpose:
 * the chat model follows a long note badly (it answered « here is the video » to the former one).
 */
export function cardBrief() {
  return (
    'Nothing is generated yet. Under your next words a card shows this proposal to the user (its length, ' +
    'its format, its prompt) with « Générer » and « Annuler »: they decide there. Write to them now, without ' +
    'any tool, in their language: two to four plain sentences that say what happens in the clip from its ' +
    'first moment to its last, then ask whether it suits them. Never say the video is ready, made or sent: ' +
    'it does not exist yet. No headings, no lists, no bold, no tool or argument names.'
  );
}

/**
 * The same when its video is set in the Studio (the conversation held from there): the pointer sets
 * the proposal after those words and rests on « Générer », « Refuser » beside it.
 */
export function studioBrief() {
  return (
    'Nothing is generated yet. The Studio now shows this proposal to the user (its length, its format, ' +
    'its prompt, its images) with « Générer » and « Refuser »: they decide there. Write to them now, without ' +
    'any tool, in their language: two to four plain sentences that say what happens in the clip from its ' +
    'first moment to its last, then ask whether it suits them. Never say the video is ready, made or sent: ' +
    'it does not exist yet. No headings, no lists, no bold, no tool or argument names.'
  );
}
