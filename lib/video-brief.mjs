/**
 * A video is agreed on before it is generated. The model first tells the user, in a few lines,
 * how it understands the clip, how long it will be and what each image is for, and asks what
 * is still open; it generates once the user has answered.
 *
 * Nothing here reads the request: the rule only looks at who has spoken since the last video.
 */
const VIDEO = new Set(['create_video', 'extend_video']);

const textOf = message =>
  typeof message?.content === 'string'
    ? message.content
    : Array.isArray(message?.content)
      ? message.content.map(part => (typeof part?.text === 'string' ? part.text : '')).join(' ')
      : '';
const fromUser = message => message?.role === 'user' && !message.internal;
const toUser = message => message?.role === 'assistant' && !message.tool_calls?.length && textOf(message).trim();

/**
 * Whether this video call comes before any exchange about it: since the last video made in
 * this conversation, the model has not yet written to the user and been answered.
 */
export function briefMissing(messages, call) {
  if (!Array.isArray(messages) || !VIDEO.has(call?.function?.name)) return false;
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
  const spoke = messages.findIndex((message, index) => index >= from && toUser(message));
  return spoke < 0 || !messages.slice(spoke + 1).some(fromUser);
}

const seconds = value => String(Math.round(value * 10) / 10);

/**
 * What the model is told instead of a generation. `lengths` ([{ name, min, max, standard }], in
 * seconds) are the clip lengths the active workflows allow, so the one it proposes exists.
 */
export function briefMessage(lengths = []) {
  const allowed = lengths
    .map(
      item => `${item.name} from ${seconds(item.min)} to ${seconds(item.max)} s (usually ${seconds(item.standard)} s)`,
    )
    .join('; ');
  return (
    'Not generated yet: the user agrees on a video before it is made. Answer now without any tool, in the ' +
    'user’s language, as a short spoken message: five lines at most, plain sentences, no headings, no lists, no ' +
    'bold, no tool or argument names. Say how you understand the clip from its first moment to its last, the ' +
    'length you propose in seconds, and what each image is for (the image the clip starts on, the one it ends ' +
    'on, or a subject kept as it looks). Then ask the one to three questions whose answer would really change ' +
    'this video: what the request leaves open or what could be read two ways. Do not ask about what the user ' +
    'already said, nor about anything the images show (what a person, an object or a place looks like: you ' +
    'see it), and do not offer options they did not raise. End by asking for their go. Call the tool ' +
    'after they answer, with what was agreed.' +
    (allowed ? ` Lengths possible: ${allowed}.` : '')
  );
}
