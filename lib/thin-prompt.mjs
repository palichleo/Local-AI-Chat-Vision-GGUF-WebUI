/**
 * A prompt of two lines gives a generator almost nothing: it knows nothing of the conversation.
 * A generation call whose prompt is that short is sent back once per turn, with the images it
 * passes shown again, so the prompt is rewritten in full from what they show.
 */
// (Not a character put in a video: the application writes that prompt from the pictures.)
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
  return !told(messages);
}

/** Whether the model was already sent back for a thin prompt since the user's last message. */
function told(messages) {
  const last = messages.findLastIndex(message => message?.role === 'user' && !message.internal);
  return messages.slice(last + 1).some(message => message?.role === 'tool' && textOf(message).includes(MARK));
}

/**
 * The images of a series (create_image with `series`) whose prompt is too short, by their number in
 * the call: 1 is `prompt`, then each prompt of `series` in its order. The prompts of the images
 * after the first are generators' prompts as much as the first, and were not looked at: a series
 * could be made of one-liners. Empty for a single image, and once the model was told in this turn.
 */
export function thinSeries(messages, call) {
  if (call?.function?.name !== 'create_image' || !Array.isArray(messages)) return [];
  let args;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    return [];
  }
  // (What is not a list of texts is refused with its own words: lib/tool-runtime.mjs, seriesOf.)
  if (!Array.isArray(args?.series) || typeof args.prompt !== 'string' || args.reuse_output !== undefined) return [];
  const thin = [args.prompt, ...args.series]
    .map((prompt, index) => (typeof prompt === 'string' && prompt.trim().split(/\s+/).length < WORDS.create_image ? index + 1 : 0))
    .filter(Boolean);
  return thin.length && !told(messages) ? thin : [];
}

/** What the model is told of a series with thin prompts (`thin`: their numbers, `total`: its images). */
export function thinSeriesNote(thin, total) {
  const all = thin.length === total,
    list = thin.length > 1 ? thin.slice(0, -1).join(', ') + ' and ' + thin.at(-1) : String(thin[0]),
    which = all ? 'every image of this series' : `image${thin.length > 1 ? 's' : ''} ${list} of this series of ${total}`;
  return (
    `Nothing was generated: the ${MARK} for ${which} (image 1 is prompt, the others follow in series, in their ` +
    'order), for a generator that knows nothing of this conversation and reads one prompt per image. Write ' +
    `${all ? 'each of them' : thin.length > 1 ? 'those' : 'that one'} again in full, as the description of the prompt argument asks: what is seen, with its concrete ` +
    'look, the place and the light, and the look of the picture; each prompt complete by itself, without ' +
    `referring to another. Take the details from the images when some are shown. ${all ? 'Keep' : 'Keep the other prompts as they are and'} ` +
    'everything that was agreed with the user, then make the same call again with all its prompts.'
  );
}

/**
 * What a generation call is sent back with before anything runs, or '' when its prompts stand: the
 * note of a thin prompt for one creation, the one that names the thin prompts of a series.
 */
export function thinNote(messages, call) {
  const thin = thinSeries(messages, call);
  if (thin.length) return thinSeriesNote(thin, JSON.parse(call.function.arguments).series.length + 1);
  return thinPrompt(messages, call) ? THIN_NOTE : '';
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
