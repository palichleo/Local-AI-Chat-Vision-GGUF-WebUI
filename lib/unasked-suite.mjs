/**
 * (0.6.113) A continuation nobody asked for. « Modifie cette prise, je veux un dézoom lent » : the
 * local model called extend_video with that take as its source (19/11). No verb says « make this take
 * again with a change »; the only one that takes an existing video is the continuation. The Studio
 * showed « Suite du clip », where the size is that of the clip continued and cannot be changed, and
 * the user could only refuse.
 * (0.6.114) Sent back with what to call instead, the local model followed three times out of eight on
 * the user's card, and three times wrote « j'ai créé… » with nothing made; a model of ChatGPT put
 * before the same words followed four times out of four. What must be sure is done by the
 * application: such a continuation is made the new video the user meant (newVideoOf), with the prompt
 * of the call and what the take was made with. The model is sent back, once, only when that cannot be
 * done; asked again in the same turn, the continuation is then made.
 * The words below are those of a clip to go on, not a list of what users may mean.
 */
const MARK = 'did not ask for a longer clip';

/** What the model is told. In English, as the other notes of the tools (lib/thin-prompt.mjs). */
export const SUITE_NOTE = `Nothing was generated: the user ${MARK}. extend_video adds new footage after a clip: its result is that clip followed by the new part. To change a take or to make it again, call create_video with the whole new prompt and the same images, in the same roles as for that take. If the user does want this clip to go on, make this same extend_video call again.`;

// « la suite », « continue », « prolonge », « rallonge », « allonge », « étends », « poursuis »,
// « enchaîne », « plus long », « 5 secondes de plus »; « extend », « longer », « go on », « keep going ».
const LONGER =
  /(?<![\p{L}\p{N}])(?:suite|continu\p{L}*|prolong\p{L}*|rallong\p{L}*|allong\p{L}*|[ée]tend\p{L}*|poursui\p{L}*|encha[iî]n\p{L}*|plus\s+long\p{L}*|de\s+plus|extend\p{L}*|longer|go\s+on|keep\s+going)(?![\p{L}\p{N}])/iu;
// A message of this many words or fewer (« oui », « ok mais plus lent ») answers what the assistant
// just wrote: its words count with it.
const BRIEF = 4;

const textOf = message =>
  typeof message?.content === 'string'
    ? message.content
    : Array.isArray(message?.content)
      ? message.content
          .filter(part => part?.type === 'text' && typeof part.text === 'string')
          .map(part => part.text)
          .join(' ')
      : '';
const spoken = message => message?.role === 'user' && !message.internal;
/** A result that says a creation was made: what the user wrote before it was a request now answered. */
const made = message => {
  if (message?.role !== 'tool' || typeof message.content !== 'string') return false;
  try {
    return JSON.parse(message.content)?.status === 'success';
  } catch {
    return false;
  }
};
/** The final version of a draft (`reuse_output`): that draft made again in full, not one more clip. */
const promotes = call => {
  try {
    return JSON.parse(call.function.arguments)?.reuse_output !== undefined;
  } catch {
    return false;
  }
};

/**
 * Whether this call is a continuation the user has no word of, and the model was not told yet since
 * their last message. The words judged: what the user wrote since the last creation made (a suite
 * asked, its proposal refused, then « avec un mouvement plus lent » is still that suite), and, when
 * their last message is a few words, what the assistant wrote just before it (« Je prolonge la
 * prise 59 ? » « oui »). A last message without words (an image alone) is not judged.
 */
export function unaskedSuite(messages, call) {
  if (call?.function?.name !== 'extend_video' || !Array.isArray(messages) || promotes(call)) return false;
  const last = messages.findLastIndex(spoken);
  if (last < 0) return false;
  const said = textOf(messages[last]);
  if (!said.trim()) return false;
  const since = messages.slice(0, last).findLastIndex(made) + 1,
    words = messages.slice(since, last + 1).filter(spoken).map(textOf);
  if (said.trim().split(/\s+/).length <= BRIEF) {
    const before = messages.slice(0, last).findLast(message => !(message?.role === 'user' && message.internal));
    if (before?.role === 'assistant') words.push(textOf(before));
  }
  if (words.some(text => LONGER.test(text))) return false;
  return !messages.slice(last + 1).some(message => message?.role === 'tool' && textOf(message).includes(MARK));
}

/**
 * (0.6.114) The new video such a continuation stands for, as the arguments of a call of create_video:
 * the prompt and the intention of the call; the images the call names, else those the take was made
 * with, each in its role; the workflow of the take, its profile (draft or final) and its length (the
 * one the call gives when `lengthSaid`: the user's message speaks of a length).
 * `asked`: the arguments of the call; `record`: the take it names as its source; `workflow`: the one
 * that made it; `roles`: those of its family (each slot's `as`, the role of the verb it fills);
 * `taken`: the roles create_video takes (lib/tasks.json).
 * Returns { args, images, ownLength }, or null when the take cannot be made again so: it has no
 * prompt to be made from, it continued a clip itself, or one of its images was a file sent with a
 * message, which is no longer there.
 */
export function newVideoOf(asked, record, workflow, { roles = {}, taken = {}, lengthSaid = false } = {}) {
  if (typeof asked?.prompt !== 'string' || !asked.prompt.trim()) return null;
  if (record?.mediaType !== 'video' || !Array.isArray(workflow?.references)) return null;
  const images = {},
    named = Object.keys(taken).filter(role =>
      Array.isArray(asked[role]) ? asked[role].length : asked[role] !== undefined,
    );
  for (const role of named) images[role] = asked[role];
  if (!named.length)
    for (const ref of record.parameters?.references ?? []) {
      const role = roles[workflow.references.find(slot => slot.id === ref.input)?.role]?.as,
        spec = taken[role],
        source =
          ref.output_id !== undefined
            ? {
                output: ref.output_id,
                ...(ref.output_index !== undefined ? { index: ref.output_index } : {}),
                ...(ref.output_conversation !== undefined ? { conversation: ref.output_conversation } : {}),
              }
            : ref.resource_id !== undefined
              ? { resource: ref.resource_id, ...(ref.frame !== undefined ? { frame: ref.frame } : {}) }
              : null;
      // A video it continued, or an image sent with a message: not what a new video can be given.
      if (!spec || !source) return null;
      if (spec.many) (images[role] ??= []).push(source);
      else if (images[role]) return null;
      else images[role] = source;
    }
  const { frames, fps, stage } = record.parameters ?? {},
    timed = workflow.parameters?.frames?.policy === 'model',
    ownLength = timed && !lengthSaid && Number.isFinite(frames) && Number.isFinite(fps) && frames > 0 && fps > 0;
  return {
    args: {
      prompt: asked.prompt,
      duration: ownLength
        ? Math.round((frames / fps) * 100) / 100
        : typeof asked.duration === 'number'
          ? asked.duration
          : null,
      ...(typeof asked.intention === 'string' ? { intention: asked.intention } : {}),
      workflow: workflow.id,
      ...(workflow.parameters?.stage?.policy === 'model' && workflow.profiles?.[stage] ? { stage } : {}),
      ...images,
    },
    // Whether it has images, and whose: 'take' (those of the take), 'call' (those the model named).
    images: Object.keys(images).length ? (named.length ? 'call' : 'take') : '',
    ownLength,
  };
}

/** What the user reads on the proposal: why it is no continuation, what it keeps, and how to get one. */
export function remadeNote(take, { images = '', ownLength = false, sized = false } = {}) {
  const parts = { 'ses images': images === 'take', 'sa longueur': ownLength, 'son format': sized },
    kept = Object.keys(parts).filter(part => parts[part]),
    list = kept.length > 1 ? kept.slice(0, -1).join(', ') + ' et ' + kept.at(-1) : (kept[0] ?? '');
  return `Votre message ne demande pas de suite : au lieu de prolonger ${Number.isInteger(take) ? 'la prise ' + take : 'ce clip'}, une nouvelle vidéo est proposée${list ? ', avec ' + list : ''}. Pour une suite, utilisez « Prolonger ».`;
}
