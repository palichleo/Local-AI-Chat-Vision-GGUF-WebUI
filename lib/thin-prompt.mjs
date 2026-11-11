/**
 * A prompt of two lines gives a generator almost nothing: it knows nothing of the conversation.
 * A generation call whose prompt is that short is sent back once per turn, with the images it
 * passes shown again, so the prompt is rewritten in full from what they show.
 */
const WORDS = { create_video: 60, extend_video: 35, create_image: 40 };
const MARK = 'prompt is too thin';

const textOf = message => (typeof message?.content === 'string' ? message.content : '');

/** Whether this call's prompt is too short to generate from, and the model was not told yet this turn. */
export function thinPrompt(messages, call) {
  const least = WORDS[call?.function?.name];
  if (!least || !Array.isArray(messages)) return false;
  let args;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    return false;
  }
  // A draft promoted to its final keeps its prompt; a call without one is checked elsewhere.
  if (typeof args?.prompt !== 'string' || args.reuse_output !== undefined) return false;
  if (args.prompt.trim().split(/\s+/).length >= least) return false;
  const last = messages.findLastIndex(message => message?.role === 'user' && !message.internal);
  return !messages.slice(last + 1).some(message => message?.role === 'tool' && textOf(message).includes(MARK));
}

/** Image resources a call passes, whether the model has seen them or not. */
export const passedImages = (catalog, call) =>
  catalog.filter(item => item.type === 'image' && String(call?.function?.arguments ?? '').includes(item.id));

export const THIN_NOTE =
  `Nothing was generated: the ${MARK} for a generator that knows nothing of this conversation. Write it again in ` +
  'full, as the description of the prompt argument asks: what is seen, with its concrete look, the place and the ' +
  'light; what happens, beat by beat; the camera; the look of the picture; and for a video the sound. Take the ' +
  'details from the images when some are shown. Keep everything that was agreed with the user, then make the same ' +
  'call again.';
