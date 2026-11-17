/**
 * An image the user names by its label ("ref6", "Ref 6", "la référence 6") must reach the
 * generator. A model that only describes it in the prompt is told so once, with the argument
 * to pass; its next call stands, whatever it decides. A proposal that still leaves it out says
 * so to the user (citedNote): what they named is not shown to the generator, and why when the
 * workflow could not take it (the continuation of a video by LTX 2.5 takes no image).
 */
const LABEL = /\br[ée]f(?:[ée]rence)?s?\s*(?:n°|#)?\s*(\d{1,4})\b/gi;
const MARK = 'n’est pas transmise à l’outil';
const GENERATORS = new Set(['create_image', 'create_video', 'replace_character']);
// The roles of a verb, as the model is told of them.
const ROLE_WORDS = {
  source: 'image à modifier',
  start_image: 'image de départ',
  end_image: 'image de fin',
  reference: 'référence',
};

const textOf = message =>
  typeof message?.content === 'string'
    ? message.content
    : Array.isArray(message?.content)
      ? message.content.map(part => (typeof part?.text === 'string' ? part.text : '')).join(' ')
      : '';

// What the user wrote, not what the page adds in their name for the model (`internal`: an image
// shown to it carries the label of its reference, and was taken for the user's last message: only
// that label was looked for, and « said once » was forgotten after each image shown).
const written = message => message?.role === 'user' && !message.internal;

/** The numbers of the references the last user message names (« #ref3 », « ref 3 »). */
export function citedNumbers(messages) {
  if (!Array.isArray(messages)) return [];
  const last = messages.findLast(written);
  return [...new Set([...textOf(last).matchAll(LABEL)].map(match => Number(match[1])))];
}

/** The active image resources the last user message names. */
export function citedImages(messages, catalog) {
  const numbers = new Set(citedNumbers(messages));
  return numbers.size ? catalog.filter(item => item.type === 'image' && numbers.has(item.reference)) : [];
}

/** Whether the model was told already, for the user's last request, that an image it names is left out. */
export function citedSaid(messages) {
  if (!Array.isArray(messages)) return false;
  const last = messages.findLastIndex(written);
  return (
    last >= 0 && messages.slice(last + 1).some(message => message?.role === 'tool' && textOf(message).includes(MARK))
  );
}

/** Active image resources the last user message names and this generation call leaves out. */
export function citedUnused(messages, catalog, call) {
  if (!Array.isArray(messages) || !GENERATORS.has(call?.function?.name)) return [];
  // Said once already for this request.
  if (citedSaid(messages)) return [];
  const passed = String(call.function.arguments ?? '');
  return citedImages(messages, catalog).filter(item => !passed.includes(item.id));
}

const oneOf = words => (words.length > 1 ? words.slice(0, -1).join(', ') + ' ou ' + words.at(-1) : words[0]);

/**
 * What the model is told: which image is missing, and how to pass it. `roles`: those its workflow
 * has a place left in, when they are known (a proposal already resolved), each with its argument.
 */
export function citedMessage(unused, roles = null) {
  const list = unused.map(item => `${item.label} ({"resource": "${item.id}"})`).join(', '),
    where = roles?.length
      ? oneOf(roles.map(role => `${ROLE_WORDS[role] ?? role} : ${role}`))
      : 'image de fin, référence ou image de départ';
  // The same words whatever the count: they are also how a second telling is avoided.
  return (
    `L’utilisateur cite ${list} : ce qu’il cite ${MARK}. Décrire une image dans le prompt ne la montre pas ` +
    `au générateur. Refais l’appel en la passant dans le rôle qui convient à sa demande (${where}).`
  );
}

/**
 * What the user reads on a proposal that leaves out an image they named (`left`): the generator
 * will not see it, and why when its workflow could not take it. `here`, `none` and `other` as
 * ToolCatalog.room gives them; `continues`: the proposal continues a video.
 */
export function citedNote(left, { workflow = '', here = [], none = false, other = null, continues = false } = {}) {
  const many = left.length > 1,
    labels = left.map(item => item.label),
    list = many ? labels.slice(0, -1).join(', ') + ' et ' + labels.at(-1) : labels[0],
    it = many ? 'les' : 'la';
  const why = here.length
    ? ''
    : none
      ? ` : ${workflow} ne prend pas d’image${continues ? ' pour la suite d’une vidéo' : ''}`
      : ` : ${workflow} n’a pas de place pour ${many ? 'elles' : 'elle'} avec les autres entrées`;
  return (
    `${list} ${many ? 'ne sont pas transmises' : 'n’est pas transmise'}${why}. ` +
    `Le générateur ne ${it} verra pas, seul le prompt peut ${it} décrire.` +
    (!here.length && other ? ` ${other} peut ${it} recevoir.` : '')
  );
}
