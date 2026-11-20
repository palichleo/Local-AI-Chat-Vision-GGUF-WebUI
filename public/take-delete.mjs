/**
 * (0.6.147) Deleting a take, asked the same way everywhere (the Sortie of the Studio, the Pellicule:
 * « on doit pouvoir supprimer n'importe quel media dans la gallery, avec msg de confirmation comme
 * dans studio », 20/11). The question is on the take itself: « Supprimer #12 ? », the montages that
 * use it under it, ✕ (or Échap) to keep it, the light bin to take it away.
 *
 * What goes is decided in one place, the Studio's own deletion (studio.mjs, `remove`: the route
 * /api/studio/delete): the record of the take leaves its conversation (its prompt, its settings, its
 * number), its thumbnail with it; its file stays in the output folder. There is no bin for a take.
 */
export const DELETE_TIP = 'Supprimer de sa conversation (le fichier reste dans le dossier output)';
const WHAT = { image: 'cette image', video: 'ce clip', audio: 'ce son' };

/**
 * « Supprimer #12 ? »: the number of the take (« PRISE 12 »); one without it, the number it is shown
 * with (`shown`, the Studio's « #3 »), else what it is (« Supprimer cette image ? »). The « ? » is held
 * to the word before it (a no-break space): on a small take of the Sortie it went to a line of its own.
 */
export function deleteWords(record, media, shown = null) {
  const take = record?.outputs?.[0]?.take;
  if (Number.isInteger(take)) return `Supprimer #${take} ?`;
  if (Number.isInteger(shown)) return `Supprimer #${shown} ?`;
  return `Supprimer ${WHAT[media] ?? 'cette création'} ?`;
}

/**
 * What the question says of the montages that use the take (their names, from the server): '' for
 * none. `short`: on a take too small for their names (the Sortie of the Studio), « Dans un montage ».
 */
export function montageWords(names, short = false) {
  const list = (Array.isArray(names) ? names : []).filter(name => typeof name === 'string' && name);
  if (!list.length) return '';
  if (short) return list.length === 1 ? 'Dans un montage' : `Dans ${list.length} montages`;
  if (list.length === 1) return `Elle sert dans le montage « ${list[0]} »`;
  return `Elle sert dans ${list.length} montages : ${list.map(name => `« ${name} »`).join(', ')}`;
}

/**
 * The question on a take. `node(tag, className, text)` and `icon(name)` draw it; `name` says the take
 * to a screen reader (« Image #4 »); `short`: the montages said in short (their names under the
 * pointer and to a screen reader); `onKeep` (✕, Échap) and `onDelete` (the light bin) answer it.
 */
export function deleteQuestion({ node, icon, record, media, shown = null, name, short = false, onKeep, onDelete }) {
  const words = deleteWords(record, media, shown),
    note = montageWords(record?.montages),
    shownNote = montageWords(record?.montages, short),
    ask = node('div', 'studio-item-confirm'),
    row = node('div', 'studio-confirm-row'),
    no = node('button', 'studio-confirm-no'),
    yes = node('button', 'studio-confirm-yes');
  no.type = yes.type = 'button';
  no.append(icon('close'));
  yes.append(icon('trash'));
  no.onclick = () => onKeep();
  yes.onclick = () => onDelete();
  ask.setAttribute('role', 'alertdialog');
  ask.setAttribute('aria-label', note ? `${words} ${note}.` : words);
  no.setAttribute('aria-label', 'Annuler');
  no.title = 'Annuler';
  yes.setAttribute('aria-label', 'Supprimer ' + (name || words.replace(/^Supprimer |\s\?$/g, '')));
  yes.title = DELETE_TIP;
  ask.onkeydown = event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation?.();
    onKeep();
  };
  row.append(no, yes);
  ask.append(node('span', 'studio-confirm-text', words));
  if (note) {
    const said = node('span', 'studio-confirm-note', shownNote);
    // Short or cut to two lines on a small take: whole under the pointer.
    said.title = note;
    ask.append(said);
  }
  ask.append(row);
  return ask;
}
