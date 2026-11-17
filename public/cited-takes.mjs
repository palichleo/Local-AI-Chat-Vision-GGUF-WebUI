/**
 * The takes a reply of Moodix names, shown small under it (17/11): « la prise 12 », « prises 3 à 5 »,
 * « #ref4 ». The user sees what the model speaks of without going to the Studio or the Pellicule.
 * A take is found by its number in the project of the conversation (as the model's tools name
 * them), a reference among those of the project; a click on a take opens it as in the Pellicule.
 * A number the project does not have shows nothing.
 */

/** At most this many pictures under one reply. */
export const MOST = 8;
const REF = /#ref(\d{1,4})(?!\d)/giy;
// « prise 12 », « PRISE 12 », « take 12 », « prise n° 12 », « prise #12 ».
const TAKE = /\b(?:prises?|takes?)\s*(?:n[°o]\.?\s*|#\s*)?(\d{1,4})(?!\d)/giy;
// What may join a number to the next one in a list: « , », « et », « ou », « & », « / », « and »;
// a range: « à », « au », « - », « – ».
// (« \b » does not know « à »: the words are bounded by letters of any script.)
const NEXT =
  /\s*(,|&|\/|-|–|(?<!\p{L})(?:et|ou|and|or|à|au)(?!\p{L}))\s*(?:(?:la|les|prises?|takes?)\s+)?(?:n[°o]\.?\s*|#\s*)?(\d{1,4})(?!\d)/iuy;

/** What a text names, in its order, each once: `{ kind: 'take' | 'ref', number }`. */
export function citedIn(text) {
  const source = String(text ?? ''),
    found = [],
    seen = new Set();
  const add = (kind, number) => {
    const key = kind + number;
    if (number < 1 || seen.has(key) || found.length >= MOST) return;
    seen.add(key);
    found.push({ kind, number });
  };
  for (let at = 0; at < source.length && found.length < MOST; at++) {
    REF.lastIndex = at;
    let match = REF.exec(source);
    if (match) {
      add('ref', Number(match[1]));
      at = REF.lastIndex - 1;
      continue;
    }
    // A word starts here only (not « emprise 3 »).
    if (at > 0 && /[\p{L}\p{N}]/u.test(source[at - 1])) continue;
    TAKE.lastIndex = at;
    match = TAKE.exec(source);
    if (!match) continue;
    let last = Number(match[1]),
      end = TAKE.lastIndex;
    add('take', last);
    // « prises 12, 14 et 15 », « prises 3 à 5 ».
    for (;;) {
      NEXT.lastIndex = end;
      const next = NEXT.exec(source);
      if (!next) break;
      const number = Number(next[2]);
      if (/^(à|au|-|–)$/i.test(next[1]) && number > last && number - last <= MOST)
        for (let between = last + 1; between <= number; between++) add('take', between);
      else add('take', number);
      last = number;
      end = NEXT.lastIndex;
    }
    at = end - 1;
  }
  return found;
}

/**
 * `load()` gives the creations of the project of the conversation open (as the Sortie reads them),
 * `references()` those of the project by their number, `viewOutput(record, index, blob, around)`
 * opens a take. `show(view, text)` draws, under `view.body`, what `text` names.
 */
export function setupCitedTakes({ node, icon, load, project, references, viewOutput }) {
  let known = { project: null, takes: new Map() },
    loading = null;
  // Numbers asked for in vain, with when: not asked again at each piece of a reply being written.
  const missed = new Map();
  /** Every take of the project by its number: `{ record, index }`. */
  function index(runs) {
    const takes = new Map();
    for (const record of runs)
      (record.outputs ?? []).forEach((output, at) => {
        if (Number.isInteger(output.take) && !takes.has(output.take)) takes.set(output.take, { record, index: at });
      });
    return takes;
  }
  function refresh() {
    const asked = project();
    loading ??= Promise.resolve()
      .then(load)
      .then(runs => {
        known = { project: asked, takes: index(runs ?? []) };
      })
      .catch(() => {
        // Without them, the reply shows nothing more.
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  }
  function tile(item, records) {
    const kind = item.kind,
      label = kind === 'take' ? 'PRISE ' + item.number : '#REF' + item.number;
    if (kind === 'ref') {
      const reference = item.found,
        figure = node('figure', 'message-cited-item is-ref'),
        frame = node('span', 'message-cited-picture');
      figure.title = `#ref${item.number} · ${reference.name}`;
      if (reference.previewUrl) {
        const picture = node('img');
        Object.assign(picture, { src: reference.previewUrl, alt: '', loading: 'lazy', decoding: 'async' });
        frame.append(picture);
      } else frame.append(node('span', 'message-cited-blank', reference.kind === 'video' ? '▶' : '·'));
      figure.append(frame, node('figcaption', 'message-cited-label', label));
      return figure;
    }
    const { record, index: at } = item.found,
      output = record.outputs[at] ?? {},
      media = record.mediaType === 'video' || record.mediaType === 'audio' ? record.mediaType : 'image',
      open = node('button', 'message-cited-item'),
      // The picture in its filet; « PRISE 12 » under it, as in the Sortie.
      frame = node('span', 'message-cited-picture');
    open.type = 'button';
    const what = { image: 'Image', video: 'Vidéo', audio: 'Son' }[media];
    open.setAttribute('aria-label', `Ouvrir la prise ${item.number} · ${what}${record.prompt ? ' · ' + record.prompt : ''}`);
    open.title = `Prise ${item.number}${record.prompt ? ' · ' + record.prompt : ''}`;
    // At its format, as in the Sortie: its file's size, its settings', else that of its kind.
    const width = output.width ?? record.parameters?.width,
      height = output.height ?? record.parameters?.height,
      ratio = width > 0 && height > 0 ? width / height : media === 'video' ? 16 / 9 : 1;
    open.style?.setProperty?.('--ratio', ratio.toFixed(4));
    if (media === 'audio') {
      open.classList.add('is-sound');
      frame.append(icon('wave'));
    } else if (output.thumbUrl || media === 'image') {
      const picture = node('img');
      Object.assign(picture, { src: output.thumbUrl || output.originalUrl || '', alt: '', loading: 'lazy', decoding: 'async' });
      frame.append(picture);
    } else {
      // Its first picture only.
      const clip = node('video');
      Object.assign(clip, { muted: true, preload: 'metadata', playsInline: true, src: (output.originalUrl || '') + '#t=0.1' });
      frame.append(clip);
    }
    open.append(frame, node('span', 'message-cited-label', label));
    // ‹ › of the take opened go through the takes of this reply.
    open.onclick = () =>
      viewOutput(record, at, undefined, { list: () => records, at: () => records.indexOf(record) });
    return open;
  }
  /** Under the words of `view` (a reply), what `text` names; nothing when it names nothing found. */
  function show(view, text) {
    const cited = citedIn(text),
      here = project();
    if (known.project !== here) known = { project: here, takes: new Map() };
    const refs = cited.some(item => item.kind === 'ref') ? references() : [],
      found = cited
        .map(item => ({
          ...item,
          found:
            item.kind === 'take'
              ? known.takes.get(item.number)
              : refs.find(reference => reference.reference === item.number),
        }))
        .filter(item => item.found);
    // A take not known yet (made in this turn, or the project not read yet): read once more, then drawn.
    const now = Date.now(),
      wanted = cited.filter(
        item => item.kind === 'take' && !known.takes.has(item.number) && !(now - (missed.get(here + ':' + item.number) ?? 0) < 8000),
      );
    if (wanted.length) {
      for (const item of wanted) missed.set(here + ':' + item.number, now);
      void refresh().then(() => {
        if (view.citedText === text && project() === here) show(view, text);
      });
    }
    draw(view, text, found);
  }
  function draw(view, text, found) {
    view.citedText = text;
    const key = found.map(item => item.kind + item.number + ':' + (item.found.record?.id ?? item.found.id ?? '')).join('|');
    // The same pictures: nothing drawn again (a reply being written calls this at each piece).
    if (view.cited && view.citedKey === key) return;
    view.citedKey = key;
    if (!found.length) {
      view.cited?.remove();
      view.cited = null;
      return;
    }
    if (!view.cited) {
      view.cited = node('div', 'message-cited');
      view.cited.setAttribute('role', 'group');
      view.cited.setAttribute('aria-label', 'Prises citées dans cette réponse');
      view.body.after(view.cited);
    }
    const records = found.filter(item => item.kind === 'take').map(item => item.found.record);
    view.cited.replaceChildren(...found.map(item => tile(item, records)));
  }
  return {
    show,
    /** Takes made or removed since: read again at the next reply that names one. */
    forget() {
      known = { project: null, takes: new Map() };
      missed.clear();
    },
  };
}
