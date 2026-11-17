/**
 * What a conversation read back from the history shows of the model's tool calls. The results
 * kept in the history are written for the model (« Ne réessaie pas sans nouvelle demande ») :
 * the user is told in a few words what happened instead.
 */

// The same mark as while a reply arrives: only what is unmistakably a call written as text.
const CALL_AS_TEXT = /<tool_call>\s*(?:<function=|\{)|(?:^|\n)<function=\w+>/;
const MADE = {
  create_image: 'Image',
  create_video: 'Vidéo',
  extend_video: 'Suite de la vidéo',
  replace_character: 'Personnage remplacé',
  create_audio: 'Son',
  upscale: 'Agrandissement',
  interpolate: 'Interpolation',
};
const LOOKED = {
  local_read_output: 'A regardé une création précédente.',
  local_read_resource: 'A regardé une ressource de la bibliothèque.',
};

/**
 * What a creation that failed tells the model while its message is answered: no tool is left for
 * that message, the model says what failed…
 */
export const FAILED_NOTE =
  'La génération a échoué et rien n’a été produit. Aucun outil n’est disponible pour la suite de ce message : explique l’échec à l’utilisateur en une ou deux phrases, sans écrire d’appel d’outil. Il relancera s’il le souhaite.';
/**
 * … and what is left of it once the user has written again. Kept as it was, « no tool, no call » was
 * read at each later message, when the tools are back: asked anything, the model answered « je
 * relance » and called nothing (16/11), and a creation made in the Studio never had the message that
 * consigne was for (the chat model stays unloaded after it).
 */
export const FAILED_SETTLED =
  'La génération a échoué et rien n’a été produit. Si l’utilisateur demande de recommencer, refais le même appel d’outil.';
const inJSON = text => JSON.stringify(text).slice(1, -1);
/** The messages as the model reads them: the consigne of a failure before the user's last message, settled. */
export function settledNotes(messages) {
  const last = messages.findLastIndex(message => message?.role === 'user' && !message.internal),
    now = inJSON(FAILED_NOTE);
  return messages.map((message, index) =>
    index < last && message?.role === 'tool' && typeof message.content === 'string' && message.content.includes(now)
      ? { ...message, content: message.content.replace(now, inJSON(FAILED_SETTLED)) }
      : message,
  );
}

/** What a call left without its result is given in its place: nothing was made of it. */
export const UNANSWERED =
  'Cette demande n’a pas abouti : rien n’a été produit. Si l’utilisateur la redemande, refais le même appel d’outil.';
/**
 * The messages with every call followed by its result. A call left without one (the page closed
 * while its card waited for an answer, a creation stopped before its result was written) made the
 * conversation refused at every message (« Résultat d’outil manquant. »), with no way out but
 * taking the last message back: it is given the result of a demand that came to nothing.
 */
export function closedCalls(messages) {
  const closed = [];
  for (const [index, message] of messages.entries()) {
    closed.push(message);
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) continue;
    // Its results follow it at once, one for each call.
    const answered = new Set();
    for (let next = index + 1; messages[next]?.role === 'tool'; next++) answered.add(messages[next].tool_call_id);
    for (const call of message.tool_calls)
      if (!answered.has(call?.id))
        closed.push({
          role: 'tool',
          tool_call_id: call?.id,
          content: JSON.stringify({ status: 'cancelled', unanswered: true, message: UNANSWERED }),
        });
  }
  return closed;
}

/** A saved reply without the tool call the model wrote as text instead of making it. */
export function spokenText(content) {
  if (typeof content !== 'string') return '';
  const cut = content.search(CALL_AS_TEXT);
  return (cut < 0 ? content : content.slice(0, cut)).trimEnd();
}

/**
 * One line for a tool call that left nothing to show, from the call and its saved result; empty
 * when the result is shown as a media, or when the model explains itself in its next message.
 */
export function callNote(call, result) {
  const name = call?.function?.name ?? '';
  let data = null;
  try {
    if (result?.role === 'tool' && result.tool_call_id === call.id) data = JSON.parse(result.content);
  } catch {}
  if (name.startsWith('local_')) return data && /loaded$/.test(data.status ?? '') ? (LOOKED[name] ?? '') : '';
  const made = MADE[name] ?? 'Génération';
  if (!data) return `${made} : génération interrompue.`;
  if (data.run_id) return '';
  // Declined: nothing is left of it (16/11); « Annuler » of a card leaves its own line (app.js).
  if (data.status === 'denied') return '';
  // The image of the character Moodix AI made, seen and declined: nothing was stopped midway.
  if (data.status === 'cancelled' && data.character_image) return 'Remplacement annulé à la vérification du personnage.';
  // Left without a result (closedCalls): nothing was stopped midway, nothing was made.
  if (data.status === 'cancelled' && data.unanswered) return `${made} : demande restée sans suite.`;
  if (data.status === 'cancelled') return `${made} : génération arrêtée avant la fin.`;
  if (data.status === 'error')
    return `${made} : génération non aboutie` + (data.message ? ` (${String(data.message).replace(/\.$/, '')}).` : '.');
  return '';
}

// What the application writes for the user when a button under a creation is pressed (app.js,
// runOutputAction): « Agrandir et affiner la prise 4. », « Interpoler la sortie 1a2b… pour une vidéo
// plus fluide. »; « Upscale de la sortie … » before 0.6.0. Not a message to take back or send again.
const TAKEN = '(?:la prise \\d+|la sortie [0-9a-f]{8}-)';
const DIRECT_ACTION = new RegExp(
  `^(?:(?:Upscale|Interpolation) de la sortie [0-9a-f]{8}-|Agrandir et affiner ${TAKEN}|Interpoler ${TAKEN})`,
);
// What it writes for the model when the user makes something in the Studio.
export const STUDIO_LINE = /^Studio · (?:Image|Vidéo|Son) : /;
// The words it adds after that line, for the model only: not what the user reads.
export const STUDIO_NOTE = '(Créée dans le Studio : l’utilisateur a réglé et lancé cette génération lui-même.)';
/**
 * A title without those words, even cut short (a title keeps 120 characters): « Studio · Image :
 * un renard », not the line and the note joined (the titles saved before 0.5.125).
 */
export function withoutStudioNote(text) {
  const value = String(text ?? '');
  if (!STUDIO_LINE.test(value)) return value;
  const at = value.lastIndexOf('\n\n(');
  return (at >= 0 && STUDIO_NOTE.startsWith(value.slice(at + 2)) ? value.slice(0, at) : value).trimEnd();
}
/**
 * What names a conversation from a message: its words; for a creation of the Studio, its prompt
 * alone (0.5.126), without « Studio · Image : » (the pill of the title bar says the mode) and
 * without the words added for the model. Empty when the Studio was given no prompt.
 */
export function conversationTitle(text) {
  const value = String(text ?? '');
  if (!STUDIO_LINE.test(value)) return value;
  const prompt = value.replace(STUDIO_LINE, ''),
    at = prompt.lastIndexOf('\n\n(');
  return (at >= 0 && STUDIO_NOTE.startsWith(prompt.slice(at + 2)) ? prompt.slice(0, at) : prompt).trim();
}
const written = message =>
  typeof message.content === 'string'
    ? message.content
    : (message.content ?? [])
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('\n');

/**
 * Where the last message the user wrote sits, when it can be taken back to be edited or sent
 * again; -1 when there is none, or when the application wrote it itself.
 */
export function lastExchange(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    // A creation of the Studio came after it: taking the message back would take that away too.
    if (message.role === 'user' && message.internal && STUDIO_LINE.test(written(message))) return -1;
    if (message.role !== 'user' || message.internal) continue;
    return DIRECT_ACTION.test(written(message)) ? -1 : index;
  }
  return -1;
}
