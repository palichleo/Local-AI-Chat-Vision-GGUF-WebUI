/**
 * (0.6.137) The « Montage » mode of the Studio, its first step (maquettes M2 à M4 du 20/11, the user's
 * « Oui, code-le »): the takes of the project laid by hand one after the other, with sounds under
 * them, read on the screen and exported as one film.
 *
 * The four blocks of the Studio keep their places and their look: at the left the takes of the project
 * (dragged to the timeline, or laid at its end by a double click), in the middle the screen that
 * reads the montage, at the right what is chosen (a plan, a sound, else the montage itself), at the
 * foot the timeline. A montage is a file of the project (lib/montages.mjs): every change is kept
 * a moment after it is made. Nothing is generated here; the film is assembled by the engine from
 * the takes as they are (runner/video/montage.py) and comes back as a take of the project.
 */
import { FORMATS } from './formats.mjs';
import { thumbnailOf } from './thumbnails.mjs';
import {
  MONTAGE_LIMITS,
  MONTAGE_RATES,
  clock,
  montageSeconds,
  montageSizes,
  montageSummary,
  planAt,
  planStarts,
  shownSeconds,
  takeSeconds,
  trackOf,
  usualSize,
  withItemChanged,
  withPlanMoved,
  withTake,
  withoutItem,
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
    media = null;

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
  const recordOf = source =>
    (runs() ?? []).find(run => run.id === source.runId && run.conversationId === source.conversationId) ?? null;
  const outputOf = source => recordOf(source)?.outputs?.[source.output] ?? null;
  const itemOf = id => montage.plans.find(plan => plan.id === id) ?? montage.sounds.find(sound => sound.id === id) ?? null;
  const total = () => montageSeconds(montage);
  const span = () =>
    Math.max(SHORTEST_SPAN, total(), ...montage.sounds.map(sound => sound.at + (sound.to - sound.from)));
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
  function change(next, { select } = {}) {
    if (next === montage) return;
    montage = next;
    if (select !== undefined) chosen = select;
    if (chosen && !itemOf(chosen)) chosen = null;
    head = Math.min(head, total());
    pending = true;
    if (saving) timers.clear(saving);
    saving = timers.set(() => void keep(), saveDelay);
    status = '';
    draw();
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
      url = at ? outputOf(at.plan.source)?.originalUrl : null;
    blank.hidden = Boolean(url);
    picture.hidden = !(url && at.plan.kind === 'image');
    video.hidden = !(url && at.plan.kind === 'video');
    media.caption.textContent = at ? `Plan ${at.index + 1}` + takeLabel(at.plan.source, ' · ') : '';
    if (url && at.plan.kind === 'image') {
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
    if (live.done) live.done.style.width = total() ? (100 * head) / total() + '%' : '0%';
    if (live.head) live.head.style.left = percent(head);
    if (live.play) {
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
        first.onloadeddata = () => void thumbnail(api, record, 0, first);
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
    blank.append(
      node('span', 'montage-blank-title', montage.plans.length ? 'Prise introuvable.' : 'Votre montage se lira ici.'),
      node('span', 'montage-blank-text', montage.plans.length ? 'Ce plan nomme une prise qui n’est plus dans le projet.' : 'Posez une première prise dans la timeline.'),
    );
    Object.assign(video, { playsInline: true, preload: 'auto', hidden: true });
    Object.assign(picture, { alt: '', hidden: true });
    frame.append(blank, picture, video, caption);
    bar.append(done);
    bar.onclick = event => {
      const box = bar.getBoundingClientRect?.();
      if (box?.width) seek(((event.clientX - box.left) / box.width) * total());
    };
    playButton.disabled = !montage.plans.length;
    transport.append(playButton, time, whole, bar);
    stage.append(frame);
    body.append(headRow, stage, transport);
    stop();
    media = { video, picture, blank, caption, sounds: new Map() };
    Object.assign(live, { clock: time, done, play: playButton });
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
    box.append(input);
    return box;
  };
  const readout = text => node('span', 'montage-figures', text);

  function inspector() {
    const { section, body } = block('is-settings', 'montage-inspector'),
      item = chosen ? itemOf(chosen) : null,
      // What is set scrolls in the block when the window is short; what is done stays in sight under it.
      rows = node('div', 'montage-rows'),
      foot = node('div', 'montage-foot');
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
      rows.append(row('Nom', name), row('Format', format), row('Taille', size), row('Cadence', readout(montage.fps + ' i/s')));
      if (stored) foot.append(button('montage-action is-quiet', confirming ? 'Confirmer la suppression' : 'Supprimer ce montage', () => void remove()));
      body.append(title, rows, foot);
      return section;
    }
    const record = recordOf(item.source),
      longest = record ? takeSeconds(record) : null,
      sound = Boolean(item.track),
      index = sound ? -1 : montage.plans.indexOf(item),
      title = node('div', 'montage-title'),
      set = changes => change(withItemChanged(montage, item.id, changes, { longest }));
    title.append(
      node('span', 'montage-title-name', (sound ? KINDS[item.track] : `Plan ${index + 1}`) + takeLabel(item.source, ' · ')),
      node('span', 'montage-title-meta', record ? [KINDS[sound ? item.track : item.kind], record.workflowName, longest ? shownSeconds(longest) + ' à l’origine' : ''].filter(Boolean).join(' · ') : 'Cette prise n’est plus dans le projet.'),
    );
    const top = Math.max(longest ?? 0, item.to, 0.2);
    if (sound) rows.append(row('Début', slider('Début dans le film', item.at, 0, Math.max(total(), item.at, 1), 0.1, at => set({ at })), readout(figures(item.at))));
    if (item.kind === 'image') rows.append(row('Durée', slider('Durée de l’image', item.to, 0.5, 20, 0.5, to => set({ to })), readout(figures(item.to))));
    else {
      rows.append(
        row('Début gardé', slider('Début gardé', item.from, 0, top, 0.1, from => set({ from })), readout(figures(item.from))),
        row('Fin gardée', slider('Fin gardée', item.to, 0, top, 0.1, to => set({ to })), readout(figures(item.to))),
        row('Durée', readout(figures(item.to - item.from))),
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
      rows.append(row(sound ? 'Volume' : 'Son du clip', slider(sound ? 'Volume' : 'Son du clip', Math.round(volume * 100), 0, 200, 5, value => set({ volume: value / 100 })), readout(Math.round(volume * 100) + ' %')));
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
    go.disabled = exporting || !montage.plans.length;
    go.title = montage.plans.length ? 'Assemble le film et l’ajoute aux prises du projet' : 'Posez au moins une prise pour exporter un film';
    headRow.append(node('span', 'montage-label', 'Montage'), pick, node('span', 'montage-summary', montageSummary(montage)), state, go);
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
    ruler.onclick = event => seek(timeAt(event, ruler));
    for (const [id, name, invitation] of TRACKS) {
      const track = node('div', 'montage-track'),
        lane = node('div', 'montage-lane');
      track.dataset.track = id;
      const items = id === 'plans' ? montage.plans : montage.sounds.filter(sound => sound.track === id);
      if (!items.length) lane.append(node('span', 'montage-invite', invitation));
      items.forEach(item => {
        const at = id === 'plans' ? starts[montage.plans.indexOf(item)] : item.at,
          record = recordOf(item.source),
          picture = id === 'plans' ? pictureOf(record) : '',
          label = id === 'plans' ? `${montage.plans.indexOf(item) + 1}${takeLabel(item.source, ' · ').toUpperCase()}` : (takeLabel(item.source) || KINDS[id]) + (record?.prompt ? ' · ' + String(record.prompt).split('\n')[0].slice(0, 60) : ''),
          piece = button('montage-piece' + (id === 'plans' ? '' : ' is-sound'), '', () => {
            chosen = chosen === item.id ? null : item.id;
            confirming = false;
            draw();
          });
        piece.dataset.id = item.id;
        piece.dataset.missing = String(!record);
        piece.setAttribute('aria-pressed', String(chosen === item.id));
        piece.style.left = percent(at);
        // (Four pixels between two neighbours: the surface shows between them.)
        piece.style.width = `calc(${percent(item.to - item.from)} - 4px)`;
        if (picture) piece.style.backgroundImage = `url("${picture}")`;
        piece.append(node('span', 'montage-piece-name', record ? label : 'Prise introuvable'));
        if (id === 'plans')
          piece.append(
            node('span', 'montage-piece-kind', KINDS[item.kind]),
            node('span', 'montage-piece-length', shownSeconds(item.to - item.from)),
          );
        piece.onkeydown = event => {
          if (event.key === 'Delete' || event.key === 'Backspace') change(withoutItem(montage, item.id));
        };
        lane.append(piece);
      });
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

  function draw() {
    if (!root || !montage) return;
    root.replaceChildren(takes(), screen(), inspector(), timeline());
    show();
  }

  return {
    /** The desk of the mode, drawn for the project of the Studio; `kinds`: Image · Vidéo · Son · Montage. */
    desk(kinds = null) {
      kindsBar = kinds;
      root = node('div', 'studio-desk is-montage');
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
      root = null;
      return keep();
    },
    // For the tests and the pointer of a later step: what is on the page, and the hands that change it.
    state: () => ({ montage, stored, chosen, head, status, playing: Boolean(playing), list }),
    lay,
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
