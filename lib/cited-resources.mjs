/**
 * An image the user names by its label ("ref6", "Ref 6", "la référence 6") must reach the
 * generator. A model that only describes it in the prompt is told so once, with the argument
 * to pass; its next call stands, whatever it decides.
 */
const LABEL = /\br[ée]f(?:[ée]rence)?s?\s*(?:n°|#)?\s*(\d{1,4})\b/gi;
const MARK = 'n’est pas transmise à l’outil';
const GENERATORS = new Set(['create_image', 'create_video']);

const textOf = message =>
  typeof message?.content === 'string'
    ? message.content
    : Array.isArray(message?.content)
      ? message.content.map(part => (typeof part?.text === 'string' ? part.text : '')).join(' ')
      : '';

/** Active image resources the last user message names and this generation call leaves out. */
export function citedUnused(messages, catalog, call) {
  if (!Array.isArray(messages) || !GENERATORS.has(call?.function?.name)) return [];
  const last = messages.findLastIndex(message => message?.role === 'user');
  if (last < 0) return [];
  // Said once already for this request.
  if (messages.slice(last + 1).some(message => message?.role === 'tool' && textOf(message).includes(MARK))) return [];
  const numbers = new Set([...textOf(messages[last]).matchAll(LABEL)].map(match => Number(match[1])));
  const passed = String(call.function.arguments ?? '');
  return catalog.filter(item => item.type === 'image' && numbers.has(item.reference) && !passed.includes(item.id));
}

/** What the model is told: which image is missing, and how to pass it. */
export function citedMessage(unused) {
  const list = unused.map(item => `${item.label} ({"resource": "${item.id}"})`).join(', ');
  // The same words whatever the count: they are also how a second telling is avoided.
  return (
    `L’utilisateur cite ${list} : ce qu’il cite ${MARK}. Décrire une image dans le prompt ne la montre pas ` +
    'au générateur. Refais l’appel en la passant dans le rôle qui convient à sa demande (image de fin, ' +
    'référence ou image de départ).'
  );
}
