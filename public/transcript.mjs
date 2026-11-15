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
  if (data.status === 'denied') return `${made} : génération refusée dans la fenêtre de confirmation.`;
  // The image of the character Moodix AI made, seen and declined: nothing was stopped midway.
  if (data.status === 'cancelled' && data.character_image) return 'Remplacement annulé à la vérification du personnage.';
  if (data.status === 'cancelled') return `${made} : génération arrêtée avant la fin.`;
  if (data.status === 'error')
    return `${made} : génération non aboutie` + (data.message ? ` (${String(data.message).replace(/\.$/, '')}).` : '.');
  return '';
}

// What the application writes for the user when a button under a creation is pressed.
const DIRECT_ACTION = /^(?:Upscale|Interpolation) de la sortie [0-9a-f]{8}-/;
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
