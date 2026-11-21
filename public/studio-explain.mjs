import { formatOf } from './formats.mjs';

/**
 * What Moodix AI understood, said at the top of the Studio's screen while its pointer sets a
 * proposal and while the proposal waits for « Générer » (0.6.95). In the Chat the user reads the
 * words of Moodix over the card of the proposal; in the Studio they saw the settings move and a long
 * prompt, and nothing said what was meant unless they opened the chat of the Agent again.
 *
 * The words are those Moodix AI wrote for that proposal: its message with the call, as the chat
 * shows it. When it wrote none (the local model often calls its tool without a word), the
 * application says the proposal itself, from what it holds. Nothing is asked of the model for it:
 * the local chat model follows long instructions badly, what must hold comes from the application.
 */

/** The words of the model as one paragraph of plain text: without the marks of Markdown. */
export function plainWords(text) {
  return (
    String(text ?? '')
      // A block of code says nothing to read here; an image, a link: their words only.
      .replace(/```[\s\S]*?(?:```|$)/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // Headings, quotes, the marks of a list, at the start of their line.
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]*>[ \t]?/gm, '')
      .replace(/^[ \t]*(?:[-*+•]|\d{1,2}[.)])[ \t]+/gm, '')
      // Bold, italics written with stars, code within a line: the words they hold.
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/\*(?=\S)([^*\n]*?\S)\*/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * The spaces of French as the page sets them: a guillemet, a colon, a question mark never alone at the
 * start or the end of a line (the model writes ordinary spaces there: « Dites « / Générer » »).
 */
const typeset = text => String(text).replace(/«\s+/g, '« ').replace(/\s+([»:;?!])/g, ' $1');

/** A length as a sentence says it: « 6 secondes » (6.04 s made: the card says 6 too). */
const seconds = value => {
  const count = Math.max(1, Math.round(Number(value)));
  return count + (count > 1 ? ' secondes' : ' seconde');
};
/**
 * An input as a sentence names it: a take (« Prise 4 », the name the server gives it), a reference of
 * the project (« #ref2 »), an image joined to the message (« Image 1 »), or its own name.
 */
function named(ref) {
  const label = String(ref?.label ?? '').trim(),
    take = /^prise\s+(\d+)$/i.exec(label),
    joined = /^image\s+(\d+)$/i.exec(label);
  if (take) return 'la prise ' + take[1];
  if (joined) return joined[1] === '1' ? 'l’image jointe' : 'l’image jointe ' + joined[1];
  if (/^#ref\d+$/i.test(label)) return label;
  // (Non-breaking spaces inside the guillemets: a line never begins with « » ».)
  return label ? `« ${label} »` : '';
}
/** « a », « a et b », « a, b et c ». */
const listed = items => (items.length < 2 ? (items[0] ?? '') : items.slice(0, -1).join(', ') + ' et ' + items.at(-1));
// (0.6.190) « comme sujet », no longer « en référence »: the inputs a creation looks at are its subjects.
const asReferences = refs =>
  refs.length ? `, avec ${listed(refs.map(ref => named(ref) || 'une image'))} comme sujet${refs.length > 1 ? 's' : ''}` : '';

/**
 * The sentence of the application for a proposal (`request`: what the server sent, local_tool_request):
 * its kind, its length, its format, its model and what it starts from, in the words of its card.
 * `purpose`: 'character', the image of a character the application makes before a replacement.
 */
export function proposalSentence(request = {}, { purpose = '' } = {}) {
  const verb = request.tool || request.call?.function?.name || '',
    plan = request.plan || {},
    parameters = plan.parameters || {},
    references = plan.references || [],
    format = formatOf(
      request.resolution?.width ?? parameters.width,
      request.resolution?.height ?? parameters.height,
    )?.id,
    model = String(request.workflowName || '').trim(),
    shape = format ? ' en ' + format : '',
    by = model ? ' avec ' + model : '',
    source = references.find(ref => ref.role === 'source_video'),
    fps = parameters.fps > 0 ? parameters.fps : null,
    // A continuation adds its frames less those it takes again from the clip (as the Studio counts them).
    overlap = source && Number.isFinite(parameters.overlap_frames) ? parameters.overlap_frames : 0,
    length = fps && Number.isFinite(parameters.frames) ? Math.max(0, parameters.frames - overlap) / fps : null;
  if (verb === 'extend_video')
    return `La suite de ${named(source) || 'la vidéo'}${length ? ' : ' + seconds(length) + ' de plus' : ''}${by}.`;
  if (verb === 'replace_character') {
    const video = references.find(ref => ref.as === 'source' || /video/.test(String(ref.role))),
      character = references.find(ref => ref !== video && (ref.as === 'reference' || ref.role === 'reference_image'));
    return (
      `Le personnage de ${named(video) || 'la vidéo'} remplacé par celui de ${named(character) || 'l’image'}` +
      (model ? ', avec ' + model : '') +
      '.'
    );
  }
  if (verb === 'create_audio' || request.mediaType === 'audio')
    return `Un son${Number(parameters.seconds) > 0 ? ' de ' + seconds(parameters.seconds) : ''}${by}.`;
  if (verb === 'create_video' || request.mediaType === 'video') {
    const start = references.find(ref => ref.role === 'start_image'),
      end = references.find(ref => ref.role === 'end_image'),
      refs = references.filter(ref => ref !== start && ref !== end && ref !== source);
    let said = `Une vidéo${length ? ' de ' + seconds(length) : ''}${shape}${by}`;
    if (start && end) said += `, qui part de ${named(start) || 'une image'} et finit sur ${named(end) || 'une image'}`;
    else if (start) said += `, qui part de ${named(start) || 'une image'}`;
    else if (end) said += `, qui finit sur ${named(end) || 'une image'}`;
    return said + asReferences(refs) + '.';
  }
  // An image: the one it changes (its source), the others it looks at.
  const changed = references.find(ref => ref.as === 'source' || ['source', 'img2img', 'source_image'].includes(ref.role)),
    refs = references.filter(ref => ref !== changed);
  let said = (purpose === 'character' ? 'L’image du personnage' : 'Une image') + shape + by;
  if (changed) said += `, qui modifie ${named(changed) || 'une image'}`;
  said += asReferences(refs);
  if (request.series?.total > 1) said += ` (image ${request.series.index} sur ${request.series.total})`;
  if (purpose === 'character') said += ' : vous la verrez avant le remplacement';
  return said + '.';
}

/**
 * The line at the top of the screen for a proposal: who says it, then what, on two lines at most
 * beside Image · Vidéo · Son, where the step under way is said during a generation. Two lines keep the
 * head of the screen at its height: the screen does not move when a proposal comes or goes (an image
 * of a series comes and goes every few seconds). Cut, its end fades under a round arrow that shows it
 * whole there, the screen easing smaller (nothing is drawn over the screen or the settings); the
 * arrow, turned up, folds it again.
 *
 * Made once for a proposal and moved from one drawing of the Studio to the next (the Studio draws
 * itself again at each step of its pointer): unfolded, it stays so. `said`: the words of Moodix AI
 * for it, '' when it wrote none.
 */
export function explanation({ node, icon, said = '', request = {}, purpose = '' }) {
  const words = plainWords(said),
    spoken = Boolean(words),
    shown = typeset(words || proposalSentence(request, { purpose })),
    box = node('div', 'studio-explain' + (spoken ? '' : ' is-sentence')),
    line = node('p', 'studio-explain-text'),
    more = node('button', 'studio-explain-more');
  line.id = 'studio-explain-text';
  // Who says it: Moodix AI for its own words; « Proposition » for the sentence of the application, as
  // the card of the Chat heads it (« PROPOSITION · VIDÉO · LTX 2.5 »).
  // (A space between them: read aloud, « Moodix AI » is not one word with the first of its words.)
  line.append(node('span', 'studio-explain-who', spoken ? 'Moodix AI' : 'Proposition'), ' ', node('span', 'studio-explain-said', shown));
  more.type = 'button';
  more.hidden = true;
  more.setAttribute('aria-controls', line.id);
  if (icon) more.append(icon('chevron'));
  box.append(line, more);
  let open = false,
    watch = null;
  const say = () => {
    const text = open ? 'Replier l’explication' : 'Lire toute l’explication';
    more.title = text;
    more.setAttribute('aria-label', text);
    more.setAttribute('aria-expanded', String(open));
  };
  /** Whether its words go past its two lines: only then the arrow, and the fade. */
  function measure() {
    const cut = !open && line.scrollHeight > line.clientHeight + 1;
    box.classList?.toggle?.('is-cut', cut);
    more.hidden = !(open || cut);
  }
  more.onclick = () => {
    open = !open;
    box.classList?.toggle?.('is-open', open);
    if (!open) line.scrollTop = 0;
    say();
    measure();
  };
  say();
  // Measured again when its width changes (the window).
  if (typeof ResizeObserver === 'function') {
    watch = new ResizeObserver(() => measure());
    watch.observe(line);
  }
  return { element: box, measure, dispose: () => watch?.disconnect() };
}

/**
 * The prompt of a proposal folded to its first lines while Moodix AI sets it and while it waits
 * (0.6.95): what it understood, at the top of the screen, is read first, and the images and the
 * settings under the prompt stay in sight. Cut, it fades at its foot under a round arrow, as the prompt
 * of a take opened (0.6.59); the arrow, or a click in it to write, shows it whole. `state`: { open,
 * cut } of the proposal, kept from one drawing to the next (the box is drawn again at each step of the
 * pointer, its arrow too: drawn as it was last measured, it does not blink). `onToggle`: the arrow
 * pressed; the Studio is drawn again with the state changed. Returns what measures it once on the page.
 */
export function foldPrompt({ node, icon, field, box, state, onToggle = () => {} }) {
  const more = node('button', 'studio-prompt-more');
  more.type = 'button';
  if (icon) more.append(icon('chevron'));
  const paint = () => {
    field.classList?.toggle?.('is-folded', !state.open);
    field.classList?.toggle?.('is-cut', !state.open && state.cut);
    more.hidden = !(state.open || state.cut);
    const text = state.open ? 'Replier le prompt' : 'Voir tout le prompt';
    more.title = text;
    more.setAttribute('aria-label', text);
    more.setAttribute('aria-expanded', String(state.open));
  };
  const measure = () => {
    if (!state.open) state.cut = box.scrollHeight > box.clientHeight + 1;
    paint();
  };
  more.onclick = () => {
    state.open = !state.open;
    onToggle();
  };
  // A click in it to write (or the focus brought there): shown whole at once, where it is: drawn
  // again, the box would lose the focus and the place of the caret.
  box.onfocus = () => {
    if (state.open) return;
    state.open = true;
    paint();
  };
  field.append(more);
  paint();
  return measure;
}
