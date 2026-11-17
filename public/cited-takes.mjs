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
// A number that is not that of a take, by what follows it: a figure (« 4K », « 16:9 », « 1280 × 720 »,
// « 3,5 », « 1080p »), a length or a count (« 6 s », « 4 secondes », « 24 fps », « 5 steps »,
// « 3 fois »), a day (« 12 mars »). (« 3 s’ouvre » and « 3 mais » are not lengths nor days.)
const NOT_A_TAKE =
  '(?!\\d|\\p{L}|[.,]\\d|\\s?(?::\\d|[x×]\\s?\\d|%|(?:[kp]|px|s|sec(?:s|onde?s?)?|fps|ips|fois|min(?:utes?)?|images?|frames?|steps?|étapes?|janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)(?![\\p{L}\'’])))';
// « prise 12 », « PRISE 12 », « take 12 », « prise n° 12 », « prise #12 »; not the verb (« it takes
// 3 seconds »).
const TAKE = new RegExp('\\b(prises?|take)\\s*(?:n[°o]\\.?\\s*|#\\s*)?(\\d{1,4})' + NOT_A_TAKE, 'giuy');
// What may join a number to the next one in a list: « , », « et », « ou », « & », « / », « and »;
// a range: « à », « au », « - », « – ». On the same line only (not the dash of a list under it).
// (« \b » does not know « à »: the words are bounded by letters of any script.)
const NEXT = new RegExp(
  '([^\\S\\r\\n]*)(,|&|\\/|-|–|(?<!\\p{L})(?:et|ou|and|or|à|au)(?!\\p{L}))([^\\S\\r\\n]*)(?:(?:la|les|prises?|take)\\s+)?(?:n[°o]\\.?\\s*|#\\s*)?(\\d{1,4})' +
    NOT_A_TAKE,
  'iuy',
);
// A word after a number, on its line: what makes of a number a count (« 2 personnages »).
const WORD = /[^\S\r\n]+\p{L}/uy;
// Code is not read: a block between fences (one still being written too), a word between backticks.
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
// Every set of cited takes of the page (one, in app.js): what deletes a take tells them all.
const SETS = new Set();
/**
 * A take was deleted (the Sortie of the Studio): what was read of the projects is forgotten, and
 * read again at the next reply that names a take. Without it, a later reply of the conversation
 * left open still drew the take from what was read before.
 */
export function forgetCitedTakes() {
  for (const forget of SETS) forget();
}

/** What a text names, in its order, each once: `{ kind: 'take' | 'ref', number }`. */
export function citedIn(text) {
  const source = String(text ?? '').replace(CODE, '\n'),
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
    let last = Number(match[2]),
      end = TAKE.lastIndex;
    const several = /s$/i.test(match[1]);
    add('take', last);
    // « prises 12, 14 et 15 », « prises 3 à 5 ».
    for (;;) {
      NEXT.lastIndex = end;
      const next = NEXT.exec(source);
      if (!next) break;
      const number = Number(next[4]),
        spaced = next[1].length + next[3].length,
        after = NEXT.lastIndex;
      // After one take (« la prise 3 »), a comma then a bare number is another take only in what is
      // plainly a list (« la prise 3, 4 et 7 », « prise 3, 4 »): followed by a word that joins no
      // other number, it is a count (« la prise 3, 2 personnages »). (« la prise 3, la 4 » names it.)
      if (!several && next[2] === ',' && /^\d/.test(next[0].slice(spaced + 1))) {
        WORD.lastIndex = NEXT.lastIndex = after;
        if (WORD.test(source) && !NEXT.test(source)) break;
      }
      // A dash joins two takes written tight (« prises 3-5 »), or with a space on each side after
      // « prises » (« prises 3 – 5 »); else it sets what follows apart (« La prise 12 - 16:9, 6 s »).
      if (/^[-–]$/.test(next[2]) && spaced && !(several && next[1].length <= 1 && next[3].length <= 1)) break;
      if (/^(à|au|-|–)$/i.test(next[2]) && number > last && number - last <= MOST)
        for (let between = last + 1; between <= number; between++) add('take', between);
      else add('take', number);
      last = number;
      end = after;
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
    // One read at a time for a project. Another project asked meanwhile (a conversation of another
    // project opened) is read for itself: the answer of the first one is not its takes.
    if (loading?.project === asked) return loading.promise;
    const read = { project: asked };
    read.promise = new Promise(resolve => resolve(load()))
      .then(runs => {
        if (loading === read && project() === asked) known = { project: asked, takes: index(runs ?? []) };
        // The answer for a project left meanwhile is not kept: its numbers are asked again when wanted.
        else if (project() !== asked) for (const key of [...missed.keys()]) if (key.startsWith(asked + ':')) missed.delete(key);
      })
      .catch(() => {
        // Without them, the reply shows nothing more.
      })
      .finally(() => {
        if (loading === read) loading = null;
      });
    loading = read;
    return read.promise;
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
      // (With the words the reply has by then: more of it may have come while the project was read.)
      void refresh().then(() => {
        if (project() === here) show(view, view.citedText);
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
  /** Takes made or removed since: read again at the next reply that names one. */
  function forget() {
    known = { project: null, takes: new Map() };
    // A read in flight may be from before: its answer is not kept.
    loading = null;
    missed.clear();
  }
  SETS.add(forget);
  return { show, forget };
}
