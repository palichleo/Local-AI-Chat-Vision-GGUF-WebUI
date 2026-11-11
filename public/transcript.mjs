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
  if (data.status === 'cancelled') return `${made} : génération arrêtée avant la fin.`;
  if (data.status === 'error')
    return `${made} : génération non aboutie` + (data.message ? ` (${String(data.message).replace(/\.$/, '')}).` : '.');
  return '';
}

// What the application writes for the user when a button under a creation is pressed.
const DIRECT_ACTION = /^(?:Upscale|Interpolation) de la sortie [0-9a-f]{8}-/;
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
    if (message.role !== 'user' || message.internal) continue;
    return DIRECT_ACTION.test(written(message)) ? -1 : index;
  }
  return -1;
}
