/**
 * (0.6.113) A continuation nobody asked for. « Modifie cette prise, je veux un dézoom lent » : the
 * local model called extend_video with that take as its source (19/11). No verb says « make this take
 * again with a change »; the only one that takes an existing video is the continuation. The Studio
 * showed « Suite du clip », where the size is that of the clip continued and cannot be changed, and
 * the user could only refuse.
 * A continuation the model asks for when the user's message has no word of one is sent back once,
 * before anything is worked out, with what to call instead. Asked again in the same turn, it is made:
 * the words below are those of a clip to go on, not a list of what users may mean.
 */
const MARK = 'did not ask for a longer clip';

/** What the model is told. In English, as the other notes of the tools (lib/thin-prompt.mjs). */
export const SUITE_NOTE = `Nothing was generated: the user ${MARK}. extend_video adds new footage after a clip: its result is that clip followed by the new part. To change a take or to make it again, call create_video with the whole new prompt and the same images, in the same roles as for that take. If the user does want this clip to go on, make this same extend_video call again.`;

// « la suite », « continue », « prolonge », « rallonge », « allonge », « étends », « poursuis »,
// « enchaîne », « plus long », « 5 secondes de plus »; « extend », « longer », « go on », « keep going ».
const LONGER =
  /(?<![\p{L}\p{N}])(?:suite|continu\p{L}*|prolong\p{L}*|rallong\p{L}*|allong\p{L}*|[ée]tend\p{L}*|poursui\p{L}*|encha[iî]n\p{L}*|plus\s+long\p{L}*|de\s+plus|extend\p{L}*|longer|go\s+on|keep\s+going)(?![\p{L}\p{N}])/iu;

const textOf = message =>
  typeof message?.content === 'string'
    ? message.content
    : Array.isArray(message?.content)
      ? message.content
          .filter(part => part?.type === 'text' && typeof part.text === 'string')
          .map(part => part.text)
          .join(' ')
      : '';

/**
 * Whether this call is a continuation the user's last message has no word of, and the model was not
 * told yet since that message. A message without words (an image alone) is not judged.
 */
export function unaskedSuite(messages, call) {
  if (call?.function?.name !== 'extend_video' || !Array.isArray(messages)) return false;
  const last = messages.findLastIndex(message => message?.role === 'user' && !message.internal);
  if (last < 0) return false;
  const said = textOf(messages[last]);
  if (!said.trim() || LONGER.test(said)) return false;
  return !messages.slice(last + 1).some(message => message?.role === 'tool' && textOf(message).includes(MARK));
}
