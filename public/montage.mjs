/**
 * (0.6.137) The « Montage » mode of the Studio, its first step (maquettes M2 à M4 du 20/11, the user's
 * « Oui, code-le »): the takes of the project laid by hand one after the other, with sounds under
 * them, read on the screen and exported as one film.
 *
 * The four blocks of the Studio keep their places and their look: at the left the takes of the project
 * (dragged to the timeline, or laid at its end by a double click), in the middle the screen that
 * reads the montage, at the right what is chosen (a plan, a sound, else the montage itself), at the
 * foot the timeline. A montage is a file of the project (lib/montages.mjs): every change is kept
 * a moment after it is made. The film is assembled by the engine from the takes as they are
 * (runner/video/montage.py) and comes back as a take of the project.
 *
 * (0.6.142) Its second step (maquettes M5 et M9 du 20/11, « Oui, code-le »): a plan may be one to make.
 * Photos of the project are laid on a track above the plans: the photo a plan starts on, the photo
 * it arrives on; a photo laid above a video cuts it there. A plan to make is then created by the
 * Studio, as one of its takes (`create`), and becomes the plan of that take.
 */
import { FORMATS } from './formats.mjs';
import { thumbnailOf } from './thumbnails.mjs';
import {
  MONTAGE_LIMITS,
  MONTAGE_RATES,
  TODO_LIMITS,
  clock,
  creationOf,
  isTodo,
  montageSeconds,
  montageSizes,
  montageSummary,
  placeAt,
  planAt,
  planStarts,
  shownSeconds,
  snapped,
  takeSeconds,
  todoPlans,
  trackOf,
  usualSize,
  withItemChanged,
  withPhoto,
  withPlanAt,
  withPlanMoved,
  withTake,
  withTodoMade,
  withoutItem,
  withoutPhoto,
} from './montage-model.mjs';

const FILTERS = [
  ['all', 'Tout'],
  ['video', 'Vidéos'],
  ['image', 'Images'],
  ['audio', 'Sons'],
];
const TRACKS = [
  ['plans', 'Plans', 'Les vidéos et les images, dans l’ordre du film'],
  ['music', 'Musique', 'Une musique sous tout le film'],
  ['effects', 'Bruitages', 'Des sons, où vous les posez'],
];
const KINDS = { video: 'Vidéo', image: 'Image', music: 'Musique', effects: 'Bruitage' };
// The timeline shows ten seconds at least: a first plan does not fill it from side to side.
const SHORTEST_SPAN = 10;
// How near a cut of the film a sound dragged stops on it, in pixels of the timeline.
const NEAR_PIXELS = 8;
const figures = seconds => seconds.toFixed(1).padStart(4, '0') + ' S';

export function setupMontage({
  api,
  node,
  icon,
  notice = () => {},
  // The project the Studio works in, and its creations (the same the Sortie shows).
  project,
  runs,
  // Reads the creations of the project again: a film exported is one of them.
  refresh = async () => {},
  // The conversation a film is kept in, made when it has none yet.
  ensureConversation,
  // Opens a take with its details, as a click in the Sortie does.
  showTake = () => {},
  newId = () => globalThis.crypto.randomUUID(),
  // How long a change waits before it is kept (several made in a row are kept once).
  saveDelay = 500,
  timers = { set: (work, delay) => setTimeout(work, delay), clear: id => clearTimeout(id) },
  now = () => performance.now(),
  // Makes the small picture of a clip that has none yet, from its first picture (as the Sortie does).
  thumbnail = thumbnailOf,
  // What hears the pointer while something of the timeline is dragged (0.6.138): the window.
  page = globalThis.window,
  // (0.6.142) What makes a plan to make: the Studio's own creation, asked as one of its takes is
  // (`create({ verb, args }, { onProgress })` gives the record made, or throws why not), what stops
  // it, and how the Studio names a take as an input of a creation.
  create = null,
  halt = () => {},
  inputOf = record => ({ output: record.id }),
}) {
  let root = null,
    kindsBar = null,
    readFor = null,
    list = [],
    montage = null,
    stored = false,
    chosen = null,
    filter = 'all',
    head = 0,
    playing = null,
    status = '',
    saving = null,
    pending = false,
    exporting = false,
    confirming = false,
    carried = null,
    media = null,
    // The four blocks as last drawn: a change draws two of them again, not the screen nor the takes.
    parts = null,
    // While something is dragged on the timeline: its scale held as it was (it would change under
    // the pointer with the length of the film), where the plans were (a start that is cut follows
    // the pointer, the others wait), and the click that ends a drag, which chooses nothing.
    held = null,
    ghost = null,
    slid = false,
    // (0.6.142) The plan being created: { id, label, fraction }.
    making = null;

  const fresh = (format = '16:9') => ({
    schemaVersion: 1,
    id: newId(),
    name: 'Sans titre',
    format,
    ...usualSize(format),
    fps: MONTAGE_RATES[0],
    plans: [],
    sounds: [],
  });
  // (A plan to make has no take yet: nothing is found for it.)
  const recordOf = source =>
    (source && (runs() ?? []).find(run => run.id === source.runId && run.conversationId === source.conversationId)) || null;
  const outputOf = source => recordOf(source)?.outputs?.[source.output] ?? null;
  const lengthOf = source => {
    const record = recordOf(source);
    return record ? takeSeconds(record) : null;
  };
  const itemOf = id => montage.plans.find(plan => plan.id === id) ?? montage.sounds.find(sound => sound.id === id) ?? null;
  const total = () => montageSeconds(montage);
  const span = () =>
    held ?? Math.max(SHORTEST_SPAN, total(), ...montage.sounds.map(sound => sound.at + (sound.to - sound.from)));
  const percent = seconds => (100 * seconds) / span() + '%';

  // What is kept ---------------------------------------------------------------------------------
  async function read() {
    const place = project();
    readFor = place;
    list = [];
    montage = fresh();
    stored = false;
    chosen = null;
    head = 0;
    status = '';
    try {
      const found = (await (await api('montages/' + encodeURIComponent(place))).json()).montages ?? [];
      if (project() !== place) return;
      list = found;
      if (found.length) await open(found[0].id);
    } catch (error) {
      status = 'Montages illisibles : ' + error.message;
    }
    draw();
  }
  async function open(id) {
    const place = project();
    const found = await (await api(`montages/${encodeURIComponent(place)}/${id}`)).json();
    if (project() !== place) return;
    stop();
    montage = found;
    stored = true;
    chosen = null;
    head = 0;
    status = '';
  }
  /** Keeps the montage now; resolves once it is kept (or could not be: said in the head). */
  async function keep() {
    if (saving) timers.clear(saving);
    saving = null;
    if (!pending) return;
    pending = false;
    const sent = montage,
      place = project();
    status = 'Enregistrement…';
    say();
    try {
      const kept = await (await api('montages/save', { project: place, montage: sent })).json();
      stored = true;
      if (montage === sent) montage = { ...sent, createdAt: kept.createdAt, updatedAt: kept.updatedAt };
      const summary = { id: kept.id, name: kept.name, updatedAt: kept.updatedAt };
      list = [summary, ...list.filter(item => item.id !== kept.id)];
      if (!pending) status = 'Enregistré';
    } catch (error) {
      status = 'Non enregistré : ' + error.message;
    }
    say();
  }
  /** A change made by hand: shown at once, kept a moment later. */
  function change(next, { select, sliding = false } = {}) {
    if (next === montage) return;
    // (0.6.142) The plan being created is written back in this montage when it is made.
    if (making) return void notice('Un plan est en cours de création : attendez sa fin, ou arrêtez-la.');
    // Another shape of film: the screen takes it. Anything else leaves the screen and the takes as they are.
    const reshaped = next.format !== montage.format || next.width !== montage.width || next.height !== montage.height;
    montage = next;
    if (select !== undefined) chosen = select;
    if (chosen && !itemOf(chosen)) chosen = null;
    head = Math.min(head, total());
    pending = true;
    if (saving) timers.clear(saving);
    saving = timers.set(() => void keep(), saveDelay);
    status = '';
    if (reshaped) draw();
    else update({ inspector: !sliding });
  }
  function lay(record, where = {}) {
    const id = newId(),
      next = withTake(montage, record, { id, ...where });
    if (next === montage) return notice('Ce montage est plein.');
    change(next, { select: id });
  }
  async function exportFilm() {
    if (exporting || !montage.plans.length) return;
    exporting = true;
    stop();
    draw();
    try {
      pending = pending || !stored;
      await keep();
      if (status.startsWith('Non enregistré')) throw new Error(status);
      const conversation = await ensureConversation();
      const film = await (await api('montages/export', { project: project(), id: montage.id, conversation })).json();
      const take = film.outputs?.[0]?.take;
      status = Number.isInteger(take) ? `Film exporté · PRISE ${take}` : 'Film exporté';
      await refresh();
    } catch (error) {
      status = 'Export impossible : ' + error.message.replace(/^Non enregistré : /, '');
    }
    exporting = false;
    draw();
  }
  async function remove() {
    if (!confirming) {
      confirming = true;
      return draw();
    }
    confirming = false;
    stop();
    try {
      if (stored) await api('montages/remove', { project: project(), id: montage.id });
      notice('Montage mis de côté.');
    } catch (error) {
      status = 'Suppression impossible : ' + error.message;
      return draw();
    }
    await read();
  }

  // Reading the film on the screen ---------------------------------------------------------------
  function stop() {
    if (playing) timers.clear(playing.timer);
    playing = null;
    media?.video.pause?.();
    for (const sound of media?.sounds.values() ?? []) sound.pause?.();
  }
  /** Puts on the screen what the film shows at `head`, the clip and the sounds at their place. */
  function show({ sync = true } = {}) {
    if (!media) return;
    const { video, picture, blank } = media,
      at = montage.plans.length ? planAt(montage, Math.min(head, Math.max(0, total() - 0.001))) : null,
      todo = Boolean(at) && isTodo(at.plan),
      // (0.6.142) A plan to make has nothing to play yet: the photo it starts on stands for it.
      seen = !at ? null : todo ? (at.plan.photos?.start ? { source: at.plan.photos.start, kind: 'image' } : null) : at.plan,
      url = seen ? outputOf(seen.source)?.originalUrl : null;
    blank.hidden = Boolean(url);
    if (!url) {
      const [title, text] = blank.children;
      title.textContent = todo ? 'Plan à faire.' : at ? 'Prise introuvable.' : 'Votre montage se lira ici.';
      text.textContent = todo
        ? 'Il n’existe pas encore : créez-le pour le voir ici.'
        : at
          ? 'Ce plan nomme une prise qui n’est plus dans le projet.'
          : 'Posez une première prise dans la timeline.';
    }
    picture.hidden = !(url && seen.kind === 'image');
    video.hidden = !(url && seen.kind === 'video');
    media.caption.textContent = at ? `Plan ${at.index + 1}` + (todo ? ' · à faire' : takeLabel(at.plan.source, ' · ')) : '';
    if (url && seen.kind === 'image') {
      if (picture.dataset.url !== url) Object.assign(picture, { src: url }).dataset.url = url;
      video.pause?.();
    } else if (url) {
      const wanted = at.plan.from + (head - at.start);
      if (video.dataset.url !== url) Object.assign(video, { src: url }).dataset.url = url;
      video.volume = Math.min(1, at.plan.volume ?? 1);
      video.muted = !(at.plan.volume > 0);
      // Put back where the film is when it drifted, or when the head was moved by hand.
      if (sync || Math.abs((video.currentTime ?? 0) - wanted) > 0.35) video.currentTime = wanted;
      if (playing) void video.play?.()?.catch?.(() => {});
      else video.pause?.();
    } else video.pause?.();
    for (const sound of montage.sounds) {
      const url = outputOf(sound.source)?.originalUrl,
        inside = head >= sound.at && head < sound.at + (sound.to - sound.from);
      let player = media.sounds.get(sound.id);
      if (!url || !inside || !playing) {
        player?.pause?.();
        continue;
      }
      if (!player) media.sounds.set(sound.id, (player = Object.assign(node('audio'), { src: url, preload: 'auto' })));
      const wanted = sound.from + (head - sound.at);
      player.volume = Math.min(1, sound.volume);
      if (player.paused !== false || Math.abs((player.currentTime ?? 0) - wanted) > 0.35) player.currentTime = wanted;
      void player.play?.()?.catch?.(() => {});
    }
    for (const [id, player] of media.sounds) if (!montage.sounds.some(sound => sound.id === id)) player.pause?.();
    say();
  }
  function play() {
    if (playing) return stop(), show();
    if (!montage.plans.length) return;
    if (head >= total() - 0.05) head = 0;
    const tick = () => {
      // Another page of the application is shown: the film does not go on playing behind it.
      const view = globalThis.document?.body?.dataset?.view;
      if (view && view !== 'studio') return stop();
      const moment = now();
      head = Math.min(total(), head + (moment - playing.at) / 1000);
      playing.at = moment;
      if (head >= total()) {
        stop();
        return show();
      }
      playing.timer = timers.set(tick, 50);
      show({ sync: false });
    };
    playing = { at: now(), timer: timers.set(tick, 50) };
    show();
  }
  function seek(seconds) {
    head = Math.min(total(), Math.max(0, seconds));
    show();
  }

  // What is said without drawing everything again: the clock, the head, the state.
  const live = {};
  function say() {
    if (live.clock) live.clock.textContent = clock(head);
    if (live.whole) live.whole.textContent = ' / ' + clock(total());
    if (live.done) live.done.style.width = total() ? (100 * head) / total() + '%' : '0%';
    if (live.head) live.head.style.left = percent(head);
    if (live.play) {
      live.play.disabled = !montage.plans.length;
      live.play.setAttribute('aria-label', playing ? 'Mettre en pause' : 'Lire le montage');
      if (live.play.dataset.playing !== String(Boolean(playing))) live.play.replaceChildren(icon(playing ? 'stop' : 'play'));
      live.play.dataset.playing = String(Boolean(playing));
    }
    if (live.status) {
      live.status.textContent = status;
      live.status.dataset.problem = String(/impossible|Non enregistré|illisibles/.test(status));
    }
  }

  // The blocks -----------------------------------------------------------------------------------
  const button = (className, text, onclick, glyph) => {
    const control = node('button', className);
    control.type = 'button';
    if (glyph) control.append(icon(glyph));
    if (text) control.append(node('span', '', text));
    control.onclick = onclick;
    return control;
  };
  const block = (kind, name) => {
    const section = node('section', `studio-block ${kind} ${name}`),
      body = node('div', 'studio-block-body');
    section.append(body);
    return { section, body };
  };
  const takeLabel = (source, before = '') => {
    const take = outputOf(source)?.take;
    return Number.isInteger(take) ? before + 'Prise ' + take : '';
  };
  const pictureOf = record => {
    const output = record?.outputs?.[0] ?? {};
    return output.thumbUrl || (record?.mediaType === 'video' || record?.mediaType === 'audio' ? '' : output.originalUrl) || '';
  };

  function takes() {
    const { section, body } = block('is-settings', 'montage-takes'),
      all = runs() ?? [],
      shown = all.filter(record => filter === 'all' || (record.mediaType || 'image') === filter),
      headRow = node('div', 'montage-head'),
      filters = node('div', 'montage-filters'),
      grid = node('div', 'montage-grid');
    section.setAttribute('aria-label', 'Prises du projet');
    headRow.append(node('span', 'montage-label', 'Prises du projet'), node('span', 'montage-count', String(all.length)));
    for (const [id, label] of FILTERS) {
      const pill = button('montage-filter', label, () => {
        filter = id;
        draw();
      });
      pill.setAttribute('aria-pressed', String(filter === id));
      filters.append(pill);
    }
    for (const record of shown) {
      const output = record.outputs?.[0] ?? {},
        track = trackOf(record),
        seconds = takeSeconds(record),
        name = (Number.isInteger(output.take) ? 'Prise ' + output.take : 'Création') + ' · ' + KINDS[track],
        tile = button('montage-take', '', null);
      tile.dataset.kind = track;
      tile.dataset.id = record.id;
      tile.title = name + ' : double-cliquez pour la poser à la fin du montage';
      tile.setAttribute('aria-label', name);
      const picture = pictureOf(record);
      if (picture) tile.append(Object.assign(node('img'), { src: picture, alt: '', loading: 'lazy', draggable: false }));
      else if (track === 'video' && output.originalUrl) {
        // Its first picture, of which a small one is made for the next time (and for the timeline).
        const first = Object.assign(node('video'), { muted: true, preload: 'metadata', playsInline: true, draggable: false });
        first.src = output.originalUrl + '#t=0.1';
        // (0.6.142) Once made it is shown on the timeline too: a plan just created stayed black there
        // until the next change, its take showing its picture beside.
        first.onloadeddata = () =>
          void Promise.resolve(thumbnail(api, record, 0, first))
            .then(() => {
              if (pictureOf(record) && montage?.plans.some(plan => plan.source?.runId === record.id)) update({ inspector: false });
            })
            .catch(() => {});
        tile.append(first);
      } else tile.append(node('span', track === 'video' ? 'montage-take-blank' : 'montage-wave'));
      tile.append(
        node('span', 'montage-take-number', Number.isInteger(output.take) ? 'PRISE ' + output.take : ''),
        node('span', 'montage-take-kind', KINDS[track]),
        node('span', 'montage-take-length', seconds ? shownSeconds(seconds) : ''),
      );
      tile.ondblclick = () => lay(record);
      tile.onkeydown = event => {
        if (event.key === 'Enter') lay(record);
      };
      tile.draggable = true;
      tile.ondragstart = event => {
        carried = record;
        event.dataTransfer?.setData?.('text/plain', name);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
      };
      tile.ondragend = () => (carried = null);
      grid.append(tile);
    }
    if (!shown.length)
      grid.append(node('p', 'montage-none', all.length ? 'Aucune prise de ce type dans ce projet.' : 'Ce projet n’a pas encore de prise : créez-en dans Image, Vidéo ou Son.'));
    body.append(headRow, filters, grid, node('p', 'montage-hint', 'Glissez une prise dans la timeline, ou double-cliquez pour la poser à la fin.'));
    return section;
  }

  function screen() {
    const { section, body } = block('is-preview', 'montage-screen'),
      headRow = node('div', 'studio-screen-head montage-screen-head'),
      stage = node('div', 'montage-stage'),
      frame = node('div', 'montage-frame'),
      blank = node('div', 'montage-blank'),
      video = node('video'),
      picture = node('img'),
      caption = node('span', 'montage-caption'),
      transport = node('div', 'montage-transport'),
      playButton = button('montage-play', '', play, 'play'),
      time = node('span', 'montage-clock'),
      whole = node('span', 'montage-clock-total', ' / ' + clock(total())),
      bar = node('div', 'montage-bar'),
      done = node('span', 'montage-bar-done');
    section.setAttribute('aria-label', 'Écran du montage');
    if (kindsBar) headRow.append(kindsBar);
    // The frame has the shape of the film, as large as its block lets it be (moodix.css).
    frame.style.aspectRatio = `${montage.width} / ${montage.height}`;
    frame.style.setProperty?.('--ratio', String(montage.width / montage.height));
    // (What they say is written as the screen is shown: show.)
    blank.append(node('span', 'montage-blank-title', ''), node('span', 'montage-blank-text', ''));
    Object.assign(video, { playsInline: true, preload: 'auto', hidden: true });
    Object.assign(picture, { alt: '', hidden: true });
    frame.append(blank, picture, video, caption);
    bar.append(done);
    bar.onclick = event => {
      const box = bar.getBoundingClientRect?.();
      if (box?.width) seek(((event.clientX - box.left) / box.width) * total());
    };
    transport.append(playButton, time, whole, bar);
    stage.append(frame);
    body.append(headRow, stage, transport);
    stop();
    media = { video, picture, blank, caption, sounds: new Map() };
    Object.assign(live, { clock: time, whole, done, play: playButton });
    return section;
  }

  const row = (name, ...controls) => {
    const line = node('div', 'montage-row'),
      side = node('span', 'montage-row-side');
    side.append(...controls);
    line.append(node('span', 'montage-row-name', name), side);
    return line;
  };
  /** A bar from `low` to `high`; `onset(value)` as it moves. */
  const slider = (label, value, low, high, step, onset) => {
    // A bar of the Studio (moodix.css, .studio-bar): filled up to where it is.
    const input = node('input', 'studio-bar montage-range'),
      box = node('span', 'montage-range-box'),
      fill = at => input.style.setProperty?.('--fill', String(high > low ? (at - low) / (high - low) : 0));
    Object.assign(input, { type: 'range', min: String(low), max: String(high), step: String(step), value: String(value) });
    input.setAttribute('aria-label', label);
    fill(Math.min(high, Math.max(low, value)));
    input.oninput = () => {
      fill(Number(input.value));
      onset(Number(input.value));
    };
    // Let go: the block is drawn again with what was kept (a bar pushed beyond what the take allows goes back).
    input.onchange = () => update();
    box.append(input);
    return box;
  };

  function inspector() {
    const { section, body } = block('is-settings', 'montage-inspector'),
      item = chosen ? itemOf(chosen) : null,
      // What is set scrolls in the block when the window is short; what is done stays in sight under it.
      rows = node('div', 'montage-rows'),
      foot = node('div', 'montage-foot'),
      // A figure of the block, said again while a bar is slid: the block itself stays under the hand.
      readout = say => {
        const out = node('span', 'montage-figures', say());
        live.figures.push(() => (out.textContent = say()));
        return out;
      };
    live.figures = [];
    section.setAttribute('aria-label', item ? 'Élément choisi' : 'Réglages du montage');
    if (!item) {
      const name = node('input', 'montage-name');
      Object.assign(name, { type: 'text', value: montage.name, maxLength: MONTAGE_LIMITS.name });
      name.setAttribute('aria-label', 'Nom du montage');
      name.onchange = () => change({ ...montage, name: name.value.trim() || 'Sans titre' });
      const format = node('select', 'montage-select');
      format.setAttribute('aria-label', 'Format du film');
      for (const item of FORMATS) format.append(Object.assign(node('option', '', item.label), { value: item.id, selected: item.id === montage.format }));
      format.onchange = () => change({ ...montage, format: format.value, ...usualSize(format.value) });
      const size = node('select', 'montage-select');
      size.setAttribute('aria-label', 'Taille du film');
      for (const item of montageSizes(montage.format)) {
        const value = item.width + 'x' + item.height;
        size.append(Object.assign(node('option', '', `${item.width} × ${item.height}`), { value, selected: item.width === montage.width && item.height === montage.height }));
      }
      size.onchange = () => {
        const [width, height] = size.value.split('x').map(Number);
        change({ ...montage, width, height });
      };
      const title = node('div', 'montage-title');
      title.append(node('span', 'montage-title-name', stored ? 'Montage' : 'Nouveau montage'), node('span', 'montage-title-meta', 'Enregistré avec le projet'));
      rows.append(row('Nom', name), row('Format', format), row('Taille', size), row('Cadence', readout(() => montage.fps + ' i/s')));
      if (stored) foot.append(button('montage-action is-quiet', confirming ? 'Confirmer la suppression' : 'Supprimer ce montage', () => void remove()));
      body.append(title, rows, foot);
      return section;
    }
    if (isTodo(item)) return todoSettings(section, body, rows, foot, item, readout);
    const record = recordOf(item.source),
      longest = record ? takeSeconds(record) : null,
      sound = Boolean(item.track),
      index = sound ? -1 : montage.plans.indexOf(item),
      title = node('div', 'montage-title'),
      set = (changes, how) => change(withItemChanged(montage, item.id, changes, { longest }), how),
      // (0.6.138) A bar being slid: drawn again at each of its steps, as it was, the block took it
      // out of the hand at the first one.
      slide = changes => set(changes, { sliding: true }),
      current = () => itemOf(item.id) ?? item;
    title.append(
      node('span', 'montage-title-name', (sound ? KINDS[item.track] : `Plan ${index + 1}`) + takeLabel(item.source, ' · ')),
      node('span', 'montage-title-meta', record ? [KINDS[sound ? item.track : item.kind], record.workflowName, longest ? shownSeconds(longest) + ' à l’origine' : ''].filter(Boolean).join(' · ') : 'Cette prise n’est plus dans le projet.'),
    );
    const top = Math.max(longest ?? 0, item.to, 0.2);
    if (sound) rows.append(row('Début', slider('Début dans le film', item.at, 0, Math.max(total(), item.at, 1), 0.1, at => slide({ at })), readout(() => figures(current().at))));
    if (item.kind === 'image') rows.append(row('Durée', slider('Durée de l’image', item.to, 0.5, 20, 0.5, to => slide({ to })), readout(() => figures(current().to))));
    else {
      rows.append(
        row('Début gardé', slider('Début gardé', item.from, 0, top, 0.1, from => slide({ from })), readout(() => figures(current().from))),
        row('Fin gardée', slider('Fin gardée', item.to, 0, top, 0.1, to => slide({ to })), readout(() => figures(current().to))),
        row('Durée', readout(() => figures(current().to - current().from))),
      );
    }
    if (!sound) {
      const frames = node('span', 'montage-two');
      for (const [id, label] of [
        ['fit', 'Ajuster'],
        ['fill', 'Remplir'],
      ]) {
        const choice = button('montage-choice', label, () => set({ frame: id }));
        choice.setAttribute('aria-pressed', String(item.frame === id));
        choice.title = id === 'fit' ? 'La prise entière, avec du noir sur deux côtés si son format diffère' : 'L’image remplie, ce qui dépasse coupé des deux côtés';
        frames.append(choice);
      }
      rows.append(row('Cadre', frames));
    }
    if (item.kind !== 'image') {
      const volume = item.volume ?? 1;
      rows.append(row(sound ? 'Volume' : 'Son du clip', slider(sound ? 'Volume' : 'Son du clip', Math.round(volume * 100), 0, 200, 5, value => slide({ volume: value / 100 })), readout(() => Math.round((current().volume ?? 1) * 100) + ' %')));
    }
    if (!sound) {
      const earlier = button('montage-step', '← Avant', () => change(withPlanMoved(montage, item.id, -1))),
        later = button('montage-step', 'Après →', () => change(withPlanMoved(montage, item.id, 1)));
      earlier.disabled = index <= 0;
      later.disabled = index >= montage.plans.length - 1;
      rows.append(row('Place', earlier, later));
    }
    if (record) foot.append(button('montage-action', 'Ouvrir la prise', () => showTake(record)));
    foot.append(button('montage-action is-quiet', 'Retirer', () => change(withoutItem(montage, item.id))));
    body.append(title, rows, foot);
    return section;
  }

  /**
   * (0.6.142) The settings of a plan to make: the photos it goes by, its length, what happens in it,
   * and « Créer ce plan ». Why it cannot be created yet is said under its text, in the user's words.
   */
  function todoSettings(section, body, rows, foot, item, readout) {
    const index = montage.plans.indexOf(item),
      busy = making?.id === item.id,
      title = node('div', 'montage-title is-tight'),
      current = () => itemOf(item.id) ?? item;
    section.setAttribute('aria-label', 'Plan à faire');
    // (Its lines take what they need, its text the room that is left: never cut by the foot.)
    rows.className += ' is-tight';
    foot.className += ' is-tight';
    const about = node('span', 'montage-title-meta', item.replaces ? `Remplace la fin du plan ${index}` : 'Vidéo · ce plan n’existe pas encore');
    // (His choice of 20/11, « coupe sur la photo », said where the plan is read.)
    if (item.replaces) about.title = 'Le film coupe sur la photo : la vidéo est gardée jusqu’à elle, et ce plan part d’elle.';
    title.append(node('span', 'montage-title-name', `Plan ${index + 1} · à faire`), about);
    for (const [side, name] of [
      ['start', 'Photo de début'],
      ['end', 'Photo de fin'],
    ]) {
      const photo = item.photos?.[side];
      if (!photo) {
        rows.append(row(name, node('span', 'montage-none-yet', 'Glissez une image sur « Repères »')));
        continue;
      }
      const record = recordOf(photo),
        picture = pictureOf(record),
        chip = node('span', 'montage-chip'),
        off = button('montage-off', '×', () => change(withoutPhoto(montage, item.id, side)));
      if (picture) chip.style.backgroundImage = `url("${picture}")`;
      off.setAttribute('aria-label', `Retirer la ${name.toLowerCase()}`);
      off.title = `Retirer la ${name.toLowerCase()}`;
      off.disabled = Boolean(making);
      rows.append(row(name, chip, node('span', 'montage-figures', record ? takeLabel(photo) : 'Introuvable'), off));
    }
    const length = slider('Durée du plan', item.to, TODO_LIMITS.shortest, TODO_LIMITS.longest, 0.5, to => change(withItemChanged(montage, item.id, { to }), { sliding: true }));
    rows.append(row('Durée', length, readout(() => figures(current().to))));
    const words = node('label', 'montage-words'),
      field = node('textarea', 'montage-words-field'),
      why = node('p', 'montage-reason'),
      go = button('montage-action is-go', busy ? 'Création…' : 'Créer ce plan', () => void makePlan(item.id));
    Object.assign(field, { value: item.todo.prompt, rows: 3, maxLength: TODO_LIMITS.prompt, placeholder: 'Par exemple : il lève les yeux.', disabled: Boolean(making) });
    field.setAttribute('aria-label', 'Ce qui se passe dans ce plan');
    // What stops it is said as it changes: the button is never drawn again under the hand that goes to it.
    const judge = () => {
      const wanted = creationOf(montage, item.id, lengthOf),
        reason = !create ? 'La création n’est pas disponible ici.' : (wanted.reason ?? '');
      go.disabled = Boolean(reason) || Boolean(making);
      go.title = reason;
      why.textContent = busy ? '' : reason;
      why.hidden = busy || !reason;
    };
    field.oninput = () => {
      change(withItemChanged(montage, item.id, { prompt: field.value }), { sliding: true });
      judge();
    };
    words.append(node('span', 'montage-row-name', 'Ce qui se passe'), field);
    judge();
    const out = button('montage-action is-quiet', item.replaces ? 'Retirer la photo' : 'Retirer', () => change(withoutItem(montage, item.id)));
    out.disabled = Boolean(making);
    foot.append(go, out);
    body.append(title, rows, words, why, foot);
    return section;
  }

  /**
   * (0.6.142) Creates a plan to make: what is asked is read on the montage (creationOf), made by the
   * Studio as one of its takes (`create`), and the plan becomes the plan of that take. One at a time;
   * the montage is not changed meanwhile.
   */
  async function makePlan(id) {
    if (making || !create) return;
    const wanted = creationOf(montage, id, lengthOf);
    if (wanted.reason) return notice(wanted.reason);
    const index = montage.plans.findIndex(plan => plan.id === id);
    let args;
    try {
      const named = (item, what) => {
        const record = recordOf(item.source);
        if (!record) throw new Error(`${what} n’est plus dans le projet.`);
        return { ...inputOf(record), ...(item.frame ? { frame: item.frame } : {}) };
      };
      args = { prompt: wanted.prompt, intention: 'Plan d’un montage, demandé dans le Studio.', duration: wanted.duration };
      if (wanted.format) args.format = wanted.format;
      if (wanted.start) args.start_image = named(wanted.start, wanted.start.frame ? 'La vidéo du plan précédent' : 'La photo de début');
      if (wanted.end) args.end_image = named(wanted.end, 'La photo de fin');
      if (wanted.continues) args.source = named({ source: wanted.continues }, 'La vidéo du plan précédent');
    } catch (error) {
      return notice(error.message);
    }
    stop();
    await keep();
    const said = (label, fraction) => `Création du plan ${index + 1}` + (label ? ' · ' + label : '') + (Number.isFinite(fraction) ? ` · ${Math.round(fraction * 100)} %` : '');
    making = { id, label: 'Préparation…', fraction: null };
    chosen = id;
    status = said(making.label, null);
    draw();
    let record = null,
      problem = '';
    try {
      record = await create(
        { verb: wanted.verb, args },
        {
          onProgress: (label, fraction) => {
            if (!making) return;
            Object.assign(making, { label: label || making.label, fraction: Number.isFinite(fraction) ? fraction : making.fraction });
            status = said(making.label, making.fraction);
            if (live.bar) live.bar.style.width = Math.round((making.fraction ?? 0) * 100) + '%';
            if (live.making) live.making.textContent = making.label;
            say();
          },
        },
      );
      if (!record) problem = 'la création n’a pas pu commencer.';
    } catch (error) {
      problem = error.message;
    }
    making = null;
    if (record) {
      montage = withTodoMade(montage, id, record, { from: wanted.from });
      pending = true;
      // Kept at once: the take exists, the montage must say so. Then said as made (not only « Enregistré »).
      await keep();
      if (!status.startsWith('Non enregistré')) status = `Plan ${index + 1} créé`;
    } else status = 'Création impossible : ' + problem;
    draw();
    return record;
  }

  function timeline() {
    const { section, body } = block('is-output', 'montage-timeline'),
      headRow = node('div', 'montage-timeline-head'),
      pick = node('select', 'montage-pick'),
      state = node('span', 'montage-status'),
      go = button('montage-export', exporting ? 'Export…' : 'Exporter le film', () => void exportFilm()),
      ruler = node('div', 'montage-ruler'),
      lanes = node('div', 'montage-lanes'),
      headLine = node('span', 'montage-playhead'),
      starts = planStarts(montage),
      whole = span();
    section.setAttribute('aria-label', 'Timeline du montage');
    // (It takes the keys when it is pressed: the space bar reads the film.)
    section.tabIndex = -1;
    pick.setAttribute('aria-label', 'Montage ouvert');
    const named = [{ id: montage.id, name: montage.name }, ...list.filter(item => item.id !== montage.id)];
    for (const item of named) pick.append(Object.assign(node('option', '', item.name), { value: item.id, selected: item.id === montage.id }));
    pick.append(Object.assign(node('option', '', '+ Nouveau montage'), { value: 'new' }));
    pick.onchange = async () => {
      const wanted = pick.value;
      await keep();
      stop();
      if (wanted === 'new') {
        montage = fresh();
        stored = false;
        chosen = null;
        head = 0;
        status = '';
      } else
        try {
          await open(wanted);
        } catch (error) {
          status = 'Montage illisible : ' + error.message;
        }
      draw();
    };
    // (0.6.142) A film is made of takes: none is exported while a plan is to make, or being made.
    const waiting = todoPlans(montage).length;
    go.disabled = exporting || !montage.plans.length || waiting > 0 || Boolean(making);
    go.title = waiting
      ? 'Créez ou retirez les plans à faire pour exporter le film'
      : montage.plans.length
        ? 'Assemble le film et l’ajoute aux prises du projet'
        : 'Posez au moins une prise pour exporter un film';
    headRow.append(node('span', 'montage-label', 'Montage'), pick, node('span', 'montage-summary', montageSummary(montage)), state);
    if (making) headRow.append(button('montage-halt', 'Arrêter', () => halt()));
    headRow.append(go);
    live.bar = live.making = null;
    // A mark a second up to a minute, then every five or ten: the ruler never turns into a comb.
    const step = whole <= 60 ? 1 : whole <= 300 ? 5 : 10;
    for (let second = 0; second <= whole; second += step) {
      const major = second % (step * 5) === 0,
        tick = node('span', 'montage-tick' + (major ? ' is-major' : ''), major ? String(second).padStart(2, '0') + ' s' : '');
      tick.style.left = percent(second);
      ruler.append(tick);
    }
    const timeAt = (event, lane) => {
      const box = lane.getBoundingClientRect?.();
      return box?.width ? Math.max(0, ((event.clientX - box.left) / box.width) * whole) : 0;
    };
    // The head goes where the ruler is pressed, and follows the pointer while it is held.
    ruler.onpointerdown = event => {
      seek(timeAt(event, ruler));
      follow(event, ruler, { slack: 0, kind: '', move: (far, time) => seek(time) });
    };
    // (0.6.142) The photos the plans go by, above them. A start photo sits against the left edge of
    // its plan and an end photo against its right edge, never beyond (his rule of 20/11). A photo of
    // the project is laid here by dragging it: where it lands says what it becomes (withPhoto).
    {
      const track = node('div', 'montage-track'),
        lane = node('div', 'montage-lane montage-photos');
      track.dataset.track = 'photos';
      let count = 0;
      montage.plans.forEach((plan, index) => {
        for (const side of ['start', 'end']) {
          const photo = plan.photos?.[side];
          if (!photo) continue;
          count++;
          const record = recordOf(photo),
            picture = pictureOf(record),
            pin = button('montage-photo is-' + side, '', () => {
              chosen = plan.id;
              confirming = false;
              update();
            });
          pin.dataset.plan = plan.id;
          pin.dataset.missing = String(!record);
          pin.setAttribute('aria-label', `${side === 'start' ? 'Photo de début' : 'Photo de fin'} du plan ${index + 1}`);
          pin.setAttribute('aria-pressed', String(chosen === plan.id));
          if (picture) pin.style.backgroundImage = `url("${picture}")`;
          if (side === 'start') pin.style.left = percent(starts[index]);
          else pin.style.right = `calc(${100 - (100 * (starts[index] + plan.to - plan.from)) / whole}% + 4px)`;
          pin.append(node('span', 'montage-photo-side', side === 'start' ? 'Début' : 'Fin'));
          lane.append(pin);
        }
      });
      if (!count) lane.append(node('span', 'montage-invite', 'Une photo posée ici : un plan part d’elle, ou arrive sur elle'));
      lane.ondragover = event => {
        if (carried && trackOf(carried) === 'image') event.preventDefault();
      };
      lane.ondrop = event => {
        if (!carried) return;
        event.preventDefault();
        const dropped = carried;
        carried = null;
        const laid = withPhoto(montage, dropped, timeAt(event, lane), { id: newId() });
        if (laid.reason) return notice(laid.reason);
        change(laid.montage, { select: laid.chosen });
      };
      track.append(node('span', 'montage-track-name', 'Repères'), lane);
      lanes.append(track);
    }
    for (const [id, name, invitation] of TRACKS) {
      const track = node('div', 'montage-track'),
        lane = node('div', 'montage-lane');
      track.dataset.track = id;
      const items = id === 'plans' ? montage.plans : montage.sounds.filter(sound => sound.track === id);
      if (!items.length) lane.append(node('span', 'montage-invite', invitation));
      items.forEach(item => {
        // (While the start of a plan is cut, the plans stay where they were: only that edge moves.)
        const at = id !== 'plans' ? item.at : ghost?.starts.has(item.id) ? ghost.starts.get(item.id) + (ghost.id === item.id ? ghost.shift : 0) : starts[montage.plans.indexOf(item)],
          todo = isTodo(item),
          busy = todo && making?.id === item.id,
          // (A plan to make that takes the place of the end of a video shows it, greyed, until it is made.)
          record = recordOf(todo ? item.replaces?.source : item.source),
          picture = id === 'plans' ? pictureOf(record) : '',
          number = montage.plans.indexOf(item) + 1,
          label =
            id !== 'plans'
              ? (takeLabel(item.source) || KINDS[id]) + (record?.prompt ? ' · ' + String(record.prompt).split('\n')[0].slice(0, 60) : '')
              : todo
                ? `${number} · ${busy ? 'EN COURS' : item.replaces ? 'SERA REMPLACÉ' : 'À FAIRE'}`
                : `${number}${takeLabel(item.source, ' · ').toUpperCase()}`,
          look = id !== 'plans' ? ' is-sound' : todo ? ' is-todo' + (item.replaces ? ' is-replacing' : '') + (busy ? ' is-making' : '') : '',
          piece = button('montage-piece' + look, '', () => {
            // (The click that ends a drag chooses nothing.)
            if (slid) return void (slid = false);
            chosen = chosen === item.id ? null : item.id;
            confirming = false;
            update();
          });
        piece.dataset.id = item.id;
        piece.dataset.missing = String(!record && !todo);
        piece.setAttribute('aria-pressed', String(chosen === item.id));
        piece.style.left = percent(at);
        // (Four pixels between two neighbours: the surface shows between them.)
        piece.style.width = `calc(${percent(item.to - item.from)} - 4px)`;
        if (picture) piece.style.backgroundImage = `url("${picture}")`;
        piece.append(node('span', 'montage-piece-name', record || todo ? label : 'Prise introuvable'));
        if (id === 'plans') {
          // What a plan to make waits for: its text, else what it is.
          const about = !todo
              ? KINDS[item.kind]
              : busy
                ? making.label
                : item.todo.prompt.trim().split('\n')[0].slice(0, 60) || (item.replaces ? 'Nouveau clip qui part de la photo' : 'Plan à faire'),
            kind = node('span', 'montage-piece-kind', about);
          piece.append(kind, node('span', 'montage-piece-length', shownSeconds(item.to - item.from)));
          if (busy) {
            const bar = node('span', 'montage-piece-bar'),
              done = node('span', 'montage-piece-bar-done');
            done.style.width = Math.round((making.fraction ?? 0) * 100) + '%';
            bar.append(done);
            piece.append(bar);
            Object.assign(live, { bar: done, making: kind });
          }
        }
        piece.onkeydown = event => {
          if (event.key === 'Delete' || event.key === 'Backspace') change(withoutItem(montage, item.id));
          // Alt and an arrow: the plan one place earlier or later, as its buttons do.
          const step = event.altKey && id === 'plans' ? { ArrowLeft: -1, ArrowRight: 1 }[event.key] : 0;
          if (step) change(withPlanMoved(montage, item.id, step), { select: item.id });
        };
        // Dragged along its track: a plan takes its place among the others, a sound its moment.
        piece.onpointerdown = event => {
          const pressed = montage,
            first = item.at,
            // (What is dragged is chosen, even when it ends where it was.)
            put = next => {
              if (next === montage && chosen === item.id) return;
              chosen = item.id;
              confirming = false;
              if (next === montage) update();
              else change(next);
            };
          follow(event, lane, {
            // A sound stops on a cut of the film when it is within a few pixels of one.
            move: (far, time, perPixel) =>
              put(
                id === 'plans'
                  ? withPlanAt(montage, item.id, placeAt(pressed, item.id, time))
                  : withItemChanged(montage, item.id, { at: snapped(montage, first + far, Math.max(0.1, NEAR_PIXELS * perPixel)) }),
              ),
          });
        };
        // Its two edges: what is kept of the take, from its start (a clip) and to its end.
        if (id === 'plans')
          for (const edge of item.kind === 'image' || todo ? ['end'] : ['start', 'end']) {
            const grip = node('span', 'montage-grip is-' + edge);
            grip.onpointerdown = event => {
              event.stopPropagation?.();
              const first = { from: item.from, to: item.to },
                longest = record ? takeSeconds(record) : null,
                before = new Map(montage.plans.map((plan, index) => [plan.id, starts[index]]));
              follow(event, lane, {
                slack: 2,
                kind: 'trim',
                move: far => {
                  const next = withItemChanged(montage, item.id, edge === 'start' ? { from: first.from + far } : { to: first.to + far }, { longest });
                  if (edge === 'start') ghost = { starts: before, id: item.id, shift: next.plans.find(plan => plan.id === item.id).from - first.from };
                  chosen = item.id;
                  if (next === montage) update();
                  else change(next);
                },
              });
            };
            piece.append(grip);
          }
        lane.append(piece);
      });
      // A press on the lane itself, beside what it holds: the head goes there.
      lane.onclick = event => {
        if (event.target === lane) seek(timeAt(event, lane));
      };
      lane.ondragover = event => {
        if (!carried) return;
        const fits = id === 'plans' ? ['video', 'image'].includes(trackOf(carried)) : trackOf(carried) === id;
        if (fits) event.preventDefault();
      };
      lane.ondrop = event => {
        if (!carried) return;
        event.preventDefault();
        const dropped = carried,
          time = timeAt(event, lane);
        carried = null;
        if (id !== 'plans') return lay(dropped, { at: Math.round(time * 10) / 10 });
        // Before the first plan whose middle is after where it is dropped.
        const index = montage.plans.findIndex((plan, at) => starts[at] + (plan.to - plan.from) / 2 > time);
        lay(dropped, { index: index < 0 ? montage.plans.length : index });
      };
      track.append(node('span', 'montage-track-name', name), lane);
      lanes.append(track);
    }
    // The head is laid over the lanes, at their scale.
    const over = node('div', 'montage-over');
    over.append(headLine);
    lanes.append(over);
    body.append(headRow, ruler, lanes);
    Object.assign(live, { head: headLine, status: state });
    return section;
  }

  /**
   * Follows the pointer pressed on `lane` (0.6.138): `move(far, time, perPixel)` as it goes, `far` how
   * far it went and `time` where it is, both in seconds of the film at the scale the timeline had when
   * it was pressed (`perPixel` seconds a pixel); `done()` once it is let go. `kind`: what is being done
   * (« move », « trim »), said to the desk while it lasts. A press that does not move (`slack` pixels) is a click:
   * nothing is called.
   */
  function follow(event, lane, { move, done = () => {}, slack = 4, kind = 'move' }) {
    if (event.button > 0 || !page?.addEventListener) return;
    const box = lane.getBoundingClientRect?.() ?? { left: 0, width: 0 },
      scale = box.width ? span() / box.width : 0,
      from = event.clientX;
    let moved = false;
    const onMove = now => {
      const far = now.clientX - from;
      if (!moved && Math.abs(far) < slack) return;
      if (!moved) {
        held = span();
        // (Said to the desk: one cursor everywhere while it lasts, moodix.css.)
        if (kind) root.dataset.held = kind;
      }
      moved = true;
      move(far * scale, Math.max(0, (now.clientX - box.left) * scale), scale);
    };
    const heard = [
      ['pointermove', onMove],
      ['pointerup', onUp],
      ['pointercancel', onUp],
    ];
    function onUp() {
      for (const [type, listener] of heard) page.removeEventListener(type, listener);
      if (!moved) return;
      held = ghost = null;
      delete root.dataset.held;
      // The click the browser sends after a drag chooses nothing; without one (let go elsewhere), forgotten at once.
      slid = true;
      timers.set(() => (slid = false), 0);
      done();
      update();
    }
    for (const [type, listener] of heard) page.addEventListener(type, listener);
  }

  function draw() {
    if (!root || !montage) return;
    const focused = page?.document?.activeElement,
      inside = focused && focused !== root && root.contains?.(focused);
    parts = { takes: takes(), screen: screen(), inspector: inspector(), timeline: timeline() };
    root.replaceChildren(parts.takes, parts.screen, parts.inspector, parts.timeline);
    if (inside) refocus(focused, root);
    show();
  }
  /**
   * What a change of the montage alters (0.6.138): its timeline and what is chosen. The screen goes on
   * with the clip it shows and the grid of the takes keeps its place: drawn again at every move of a
   * hand, the clip started over and the grid went back to its top.
   */
  function update({ inspector: whole = true } = {}) {
    if (!root || !montage) return;
    if (!parts || !root.replaceChild) return draw();
    const focused = page?.document?.activeElement;
    for (const [name, make] of [
      ['inspector', inspector],
      ['timeline', timeline],
    ]) {
      if (name === 'inspector' && !whole) {
        // (One of its bars is being slid: replaced under the hand, it would be let go.)
        for (const say of live.figures ?? []) say();
        continue;
      }
      const old = parts[name],
        next = make();
      root.replaceChild(next, old);
      parts[name] = next;
      if (focused && old.contains?.(focused)) refocus(focused, next);
    }
    show({ sync: false });
  }
  /**
   * The focus put back on what replaces `was` in `part` (the same plan, the same control), else on the
   * desk: what had it has just left the page, and the keys of the montage would no longer be heard.
   */
  function refocus(was, part) {
    const key = item => item.dataset?.id || item.getAttribute?.('aria-label') || item.className + '|' + item.textContent,
      again = [...(part.querySelectorAll?.(was.tagName) ?? [])].find(item => key(item) === key(was) && !item.disabled);
    (again ?? root).focus?.({ preventScroll: true });
  }

  return {
    /** The desk of the mode, drawn for the project of the Studio; `kinds`: Image · Vidéo · Son · Montage. */
    desk(kinds = null) {
      kindsBar = kinds;
      root = node('div', 'studio-desk is-montage');
      // (A press anywhere on the desk gives it the keys.)
      root.tabIndex = -1;
      parts = null;
      // The space bar reads the film or pauses it, wherever nothing is being typed or pressed.
      root.onkeydown = event => {
        // (A plan, a sound or a take is a button too: Enter chooses it, the space bar reads the film.)
        const { tagName, className } = event.target ?? {},
          typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName) || (tagName === 'BUTTON' && !/\bmontage-(piece|take)\b/.test(className));
        if (event.key === ' ' && !typing) {
          event.preventDefault?.();
          play();
        } else if (event.key === 'Home' && !typing) seek(0);
        else if (event.key === 'End' && !typing) seek(total());
      };
      if (readFor !== project() || !montage) {
        montage = fresh();
        stored = false;
        void read();
      }
      draw();
      return root;
    },
    /** The creations of the project were read again (one made, one removed): shown as they are now. */
    refreshed: () => draw(),
    /** Leaving the mode or the page: nothing goes on playing, what is not kept yet is. */
    leave() {
      stop();
      root = parts = null;
      held = ghost = null;
      return keep();
    },
    // For the tests and the pointer of a later step: what is on the page, and the hands that change it.
    state: () => ({ montage, stored, chosen, head, status, playing: Boolean(playing), list, making }),
    lay,
    makePlan,
    select: id => {
      chosen = id;
      draw();
    },
    play,
    seek,
    keep,
    exportFilm,
  };
}
