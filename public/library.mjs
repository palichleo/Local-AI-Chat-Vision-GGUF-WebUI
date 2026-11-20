/**
 * The Pellicule (pellicule-maquette.md; captures 30 to 34): every creation of every project, images,
 * clips and sounds, the newest at the top left. Its head is one line (pellicule-fil-maquette.md,
 * captures 35 to 39): the fil « projet / conversation » of the Chat and the Studio, which the
 * navigation (project-navigation.mjs) puts there and whose menus choose the project and the
 * conversation shown, through `count` and `choose`; then the number of takes; Tout · Images ·
 * Vidéos · Sons at the right. The takes are a contact sheet by day (« AUJOURD'HUI · 16 NOV. »),
 * each in its own format at one height; a sound is a card that plays. Under the pointer, a veil
 * with its prompt and where and when it was made, and at its top right the actions of the
 * conversation. A click shows it whole with its details; on its conversation, opens it.
 * (0.6.147) At its top left, the bin of the Sortie of the Studio: any take goes, after the Studio's
 * question asked on it (take-delete.mjs), by the Studio's own deletion.
 */
import { DELETE_TIP, deleteQuestion } from './take-delete.mjs';
import { healThumbnail, thumbnailOf } from './thumbnails.mjs';
import { stillClip } from './take-player.mjs';
import { takeSeconds } from './take-length.mjs';

export const KINDS = [
  { id: 'all', icon: 'grid', label: 'Tout' },
  { id: 'image', icon: 'image', label: 'Images' },
  { id: 'video', icon: 'video', label: 'Vidéos' },
  { id: 'audio', icon: 'wave', label: 'Sons' },
];
const NAMES = { image: 'Image', video: 'Clip', audio: 'Son' };
/** The height of a row of the sheet; a take is as wide as its format makes it at that height. */
const ROW = 196;

/** The kind of a creation: its media type, or what its first file says. */
export function mediaOf(record) {
  if (record.mediaType === 'video' || record.mediaType === 'audio') return record.mediaType;
  const mime = String(record.outputs?.[0]?.mime ?? record.outputs?.[0]?.source?.mime ?? '');
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'image';
}

/** The creations a filter keeps. */
export function filtered(runs, { project = 'all', media = 'all', conversation = 'all' } = {}) {
  return runs.filter(
    run =>
      (project === 'all' || (run.projectId || 'inbox') === project) &&
      (media === 'all' || mediaOf(run) === media) &&
      (conversation === 'all' || run.conversationId === conversation),
  );
}

/** A length as everywhere (« 06.04 S » under a minute, « 1:45 » beyond). */
export function lengthText(seconds) {
  if (!(seconds > 0)) return '';
  if (seconds >= 60) return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
  return (Math.round(seconds * 100) / 100).toFixed(2).padStart(5, '0') + ' S';
}
/** The length of a creation, from its settings: a clip continued is as long as its file (take-length.mjs). */
const secondsOf = takeSeconds;
/** The shape of a creation, width over height: its file, its settings, or that of its kind. */
const ratioOf = (record, media) => {
  const output = record.outputs?.[0] ?? {},
    width = output.width ?? record.parameters?.width,
    height = output.height ?? record.parameters?.height;
  if (width > 0 && height > 0) return width / height;
  return media === 'video' ? 16 / 9 : 1;
};
/** The day of a creation, as the sheet groups them (local time), and its words. */
function dayOf(value, now = new Date()) {
  if (!value) return { key: 'unknown', label: 'Sans date' };
  const date = new Date(value),
    key = date.getFullYear() + '-' + (date.getMonth() + 1) + '-' + date.getDate(),
    short = date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }),
    today = new Date(now.getFullYear(), now.getMonth(), now.getDate()),
    that = new Date(date.getFullYear(), date.getMonth(), date.getDate()),
    days = Math.round((today - that) / 86400000);
  return { key, label: days === 0 ? 'Aujourd’hui · ' + short : days === 1 ? 'Hier · ' + short : short };
}

export function setupLibrary({
  $,
  state,
  node,
  icon,
  api,
  viewOutput,
  openConversation,
  newConversation,
  onFilter = () => {},
  actions = null,
  // (0.6.147) `remove(record)`: the take leaves its conversation (the Studio's deletion); whether it
  // went. Without it, no bin. `busy()`: why nothing can be deleted now ('' when it can), said by `notice`.
  remove = null,
  busy = () => '',
  notice = () => {},
}) {
  const filter = { project: 'all', media: 'all', conversation: 'all' };
  let runs = [],
    version = 0,
    failed = '',
    playing = null, // { audio, button }: the sound that plays
    asking = null; // { kept, question }: the take whose deletion waits for its answer
  // The tiles drawn, kept from one drawing to the next (another filter, a project renamed):
  // their pictures are not loaded again.
  const cards = new Map();
  const projects = () => (state.projects?.length ? state.projects : [{ id: 'inbox', name: 'Conversations' }]);
  // Outside any project: « Sans projet » (0.6.0), whatever the stored name of the group.
  const projectName = id =>
    (id || 'inbox') === 'inbox' ? 'Sans projet' : (projects().find(project => project.id === id)?.name ?? 'Sans projet');
  const titleOf = id =>
    (state.historyItems || []).find(item => item.id === id)?.title ?? (id === state.conversationId ? 'Nouvelle conversation' : 'Conversation');
  const date = value => (value ? new Date(value).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '');

  /**
   * A project gone (deleted) shows every project again; a conversation gone, or no more of the
   * project, every conversation of it. The kinds at the right of the head.
   */
  function paintFilters() {
    const gone = filter.project !== 'all' && !projects().some(project => project.id === filter.project);
    if (gone) filter.project = 'all';
    if (
      filter.conversation !== 'all' &&
      !(state.historyItems || []).some(
        item => item.id === filter.conversation && (filter.project === 'all' || (item.projectId || 'inbox') === filter.project),
      )
    )
      filter.conversation = 'all';
    const kinds = $('library-kinds');
    kinds.replaceChildren(
      ...KINDS.map(kind => {
        const choice = node('button', 'library-kind');
        choice.type = 'button';
        choice.dataset.kind = kind.id;
        choice.setAttribute('role', 'radio');
        choice.setAttribute('aria-checked', String(filter.media === kind.id));
        choice.setAttribute('aria-label', kind.label);
        choice.title = kind.label;
        choice.tabIndex = filter.media === kind.id ? 0 : -1;
        // Only the one chosen says its name (as Image · Vidéo · Son in the Studio).
        choice.append(icon(kind.icon), node('span', 'library-kind-name', kind.label));
        choice.onclick = () => choose({ media: kind.id });
        return choice;
      }),
    );
    // ← → move between the kinds, as in a group of radio buttons.
    kinds.onkeydown = event => {
      const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const at = KINDS.findIndex(kind => kind.id === filter.media),
        next = KINDS[(at + step + KINDS.length) % KINDS.length];
      choose({ media: next.id });
      kinds.querySelector?.('[aria-checked="true"]')?.focus?.();
    };
    return gone;
  }
  /** The number of takes shown, after the fil (« 46 PRISES », « 0 PRISE »). */
  function paintTotal(total) {
    $('library-total').textContent = total + (total > 1 ? ' prises' : ' prise');
  }
  /** A sound plays in its card; another one stops it. */
  function play(record, button) {
    if (playing?.button === button) {
      playing.audio.pause();
      playing.button.classList.remove('is-playing');
      playing = null;
      return;
    }
    if (playing) {
      playing.audio.pause();
      playing.button.classList.remove('is-playing');
    }
    const audio = node('audio');
    audio.src = record.outputs?.[0]?.originalUrl || '';
    audio.onended = () => {
      button.classList.remove('is-playing');
      if (playing?.audio === audio) playing = null;
    };
    playing = { audio, button, id: record.id };
    button.classList.add('is-playing');
    void audio.play?.()?.catch?.(() => button.classList.remove('is-playing'));
  }
  /** The sound that plays stops (the Pellicule left, its card gone from the sheet). */
  function hush() {
    playing?.audio.pause();
    playing?.button.classList.remove('is-playing');
    playing = null;
  }
  /**
   * A tile: the picture alone (a click shows it whole), at its format; the length of a clip at its
   * bottom right; a sound, a card (« PRISE n » and its kind, its stripes, ▶, its name and length).
   * Over its foot, under the pointer or the keyboard's focus: its prompt, then where it was made (a
   * click opens it) and when; at its top right, the actions of the conversation.
   */
  function build(record) {
    const media = mediaOf(record),
      output = record.outputs?.[0] ?? {},
      card = node('article', 'library-tile' + (media === 'audio' ? ' is-sound' : '')),
      kept = { card, record };
    card.dataset.id = record.id;
    card.dataset.media = media;
    if (media !== 'audio') card.style?.setProperty?.('--ratio', ratioOf(record, media).toFixed(4));
    const pick = node('button', 'library-pick');
    pick.type = 'button';
    pick.onclick = () => viewOutput(kept.record, 0, undefined, { list: () => shownList(), at: () => shownList().indexOf(kept.record) });
    kept.pick = pick;
    kept.media = media;
    if (media === 'audio') {
      const head = node('span', 'library-sound-head'),
        wave = node('span', 'library-wave');
      head.setAttribute('aria-hidden', 'true');
      head.append(
        node('span', '', Number.isInteger(output.take) ? 'PRISE ' + output.take : 'SON'),
        node('span', '', /musi|ace-?step|song/i.test(record.workflowName || '') ? 'MUSIQUE' : 'BRUITAGE'),
      );
      wave.setAttribute('aria-hidden', 'true');
      pick.append(head, wave);
      const foot = node('div', 'library-sound-foot'),
        listen = node('button', 'library-listen'),
        name = String(record.prompt || 'Son').split('\n')[0].slice(0, 60);
      listen.type = 'button';
      listen.setAttribute('aria-label', 'Écouter');
      listen.title = 'Écouter';
      listen.onclick = () => play(kept.record, listen);
      foot.append(listen, node('span', 'library-sound-name', [name, lengthText(secondsOf(record))].filter(Boolean).join(' · ')));
      kept.foot = foot;
    } else if (output.thumbUrl || media === 'image') {
      const picture = node('img');
      Object.assign(picture, { alt: '', loading: 'lazy', decoding: 'async', src: output.thumbUrl || output.originalUrl || '' });
      // Served whole: a thumbnail is kept for the next time. That of a clip found black: made again.
      if (!output.thumbUrl) picture.onload = () => void thumbnailOf(api, record, 0, picture);
      else if (media === 'video') picture.onload = () => void healThumbnail(api, kept.record, 0, picture);
      pick.append(picture);
    } else {
      // Its first picture only, of which a thumbnail is made for the next time; never a player of
      // the browser, not even from its menu (0.6.97): a click shows the take in its window.
      const clip = stillClip(node('video'));
      Object.assign(clip, { muted: true, preload: 'metadata', playsInline: true, src: (output.originalUrl || '') + '#t=0.1' });
      clip.onloadeddata = () => void thumbnailOf(api, record, 0, clip);
      pick.append(clip);
    }
    // On a clip, its length only (« 06.04 S »), at its bottom right.
    const length = media === 'video' ? lengthText(secondsOf(record)) : '';
    if (length) {
      const badge = node('span', 'library-length', length);
      badge.setAttribute('aria-hidden', 'true');
      pick.append(badge);
    }
    // Said whole by the label of the picture: what the veil shows is for the eyes only, but its
    // button that opens the conversation.
    const veil = node('div', 'library-veil'),
      said = node('p', 'library-prompt', record.prompt || NAMES[media] || 'Création'),
      meta = node('p', 'library-meta');
    said.setAttribute('aria-hidden', 'true');
    if (record.legacy || record.unsaved) {
      // The Studio of before had no conversation, one never saved cannot be opened.
      meta.append(node('span', 'library-from', record.legacy ? 'Sans conversation' : 'Conversation non enregistrée'));
    } else {
      const from = node('button', 'library-from');
      from.type = 'button';
      from.onclick = () => openConversation(kept.record.conversationId);
      meta.append(from);
      kept.from = from;
    }
    const dot = node('span', 'library-dot', '·'),
      when = node('time', 'library-date', date(record.createdAt));
    dot.setAttribute('aria-hidden', 'true');
    when.setAttribute('aria-hidden', 'true');
    if (record.createdAt) when.dateTime = record.createdAt;
    meta.append(dot, when);
    veil.append(said, meta);
    card.append(pick, veil);
    if (kept.foot) card.append(kept.foot);
    // The actions of a take, as in the conversation (output-actions.mjs).
    if (actions && !record.legacy && !record.unsaved) card.append(actions(record, 0));
    // (0.6.147) The bin at its top left, under the pointer, as in the Sortie of the Studio: on every
    // take, those of the Studio of before and of a conversation never saved too.
    if (remove) {
      const bin = node('button', 'library-del'),
        take = output.take;
      bin.type = 'button';
      bin.append(icon('trash'));
      kept.name = (NAMES[media] ?? 'Création') + (Number.isInteger(take) ? ' #' + take : '');
      bin.setAttribute('aria-label', 'Supprimer · ' + kept.name);
      bin.onclick = () => ask(kept);
      kept.bin = bin;
      held(kept);
      // Greyed during a generation, why under the pointer: said again when the pointer comes.
      card.addEventListener?.('pointerenter', () => held(kept));
      card.append(bin);
    }
    return kept;
  }
  /** Why the bin of a take is greyed now ('' when it is not), said on it. */
  function held(kept) {
    const why = busy() || '';
    kept.bin.setAttribute('aria-disabled', why ? 'true' : 'false');
    kept.bin.title = why ? DELETE_TIP + '\n' + why : DELETE_TIP;
    return why;
  }
  /** The question of the Studio, on the take: one at a time; ✕ (or Échap) keeps it. */
  function ask(kept) {
    const why = held(kept);
    if (why) return void notice(why);
    unask();
    const question = deleteQuestion({
      node,
      icon,
      record: kept.record,
      media: kept.media,
      name: kept.name,
      onKeep: () => {
        unask();
        kept.bin.focus?.();
      },
      onDelete: () => void erase(kept),
    });
    asking = { kept, question };
    kept.card.append(question);
    question.querySelector?.('.studio-confirm-no')?.focus?.();
  }
  function unask() {
    asking?.question.remove();
    asking = null;
  }
  /** The light bin: the take goes; the one after it has the focus, or the one before it at the end. */
  async function erase(kept) {
    unask();
    const at = shown.indexOf(kept.record);
    if (!(await remove(kept.record))) return;
    await refresh();
    const next = shown[at] ?? shown[at - 1];
    if (next) cards.get(keyOf(next))?.pick.focus?.();
  }
  const keyOf = record => record.id + '|' + (record.outputs?.[0]?.originalUrl || '');
  function tile(record) {
    const key = keyOf(record);
    let kept = cards.get(key);
    if (!kept) cards.set(key, (kept = build(record)));
    kept.record = record;
    // Its project said only when every project is shown.
    const where = record.legacy
      ? 'Sans conversation'
      : record.unsaved
        ? 'Conversation non enregistrée'
        : (filter.project === 'all' ? projectName(record.projectId) + ' · ' : '') + titleOf(record.conversationId);
    if (kept.from) {
      kept.from.textContent = where;
      kept.from.setAttribute('aria-label', 'Ouvrir la conversation : ' + titleOf(record.conversationId));
    }
    // For a screen reader, everything at once: its kind, its prompt, where it was made and when.
    kept.pick.setAttribute(
      'aria-label',
      [NAMES[kept.media] ?? 'Création', record.prompt || '', where, date(record.createdAt)].filter(Boolean).join(' · '),
    );
    return kept.card;
  }
  // The creations shown, in their order: what the arrows of a take opened go through.
  let shown = [];
  const shownList = () => shown;
  /** The contact sheet: a section a day, its line and its number, its takes in a row that wraps. */
  function paintGrid() {
    shown = filtered(runs, filter);
    // The card of the sound that plays leaves the sheet (another kind chosen, another project): it
    // stops. It went on with nothing on screen to stop it.
    if (playing && !shown.some(record => record.id === playing.id)) hush();
    const days = [];
    for (const record of shown) {
      const day = dayOf(record.createdAt);
      if (days.at(-1)?.key !== day.key) days.push({ ...day, records: [] });
      days.at(-1).records.push(record);
    }
    $('library-grid').replaceChildren(
      ...days.map(day => {
        const section = node('section', 'library-day'),
          head = node('div', 'library-day-head'),
          row = node('div', 'library-row');
        head.append(
          node('span', 'library-day-label', day.label),
          node('span', 'library-day-rule'),
          node('span', 'library-day-count', String(day.records.length)),
        );
        head.setAttribute('aria-hidden', 'true');
        section.setAttribute('aria-label', day.label);
        row.append(...day.records.map(tile));
        section.append(head, row);
        return section;
      }),
    );
    paintTotal(shown.length);
    const empty = $('library-empty');
    empty.hidden = shown.length > 0;
    if (shown.length) return empty.replaceChildren();
    // A project with nothing in it (capture 39): its sentence, and one way to begin.
    if (!failed && filter.project !== 'all' && filter.media === 'all' && filter.conversation === 'all') {
      empty.replaceChildren(
        node('p', 'library-empty-title', 'Rien dans ce projet pour l’instant.'),
        node('p', 'library-empty-text', 'Les images, les vidéos et les sons faits dans ce projet arrivent ici, la dernière en haut à gauche.'),
      );
      const begin = node('button', 'library-door');
      begin.type = 'button';
      begin.append(icon('plus'), node('span', '', 'Nouvelle conversation'));
      begin.setAttribute('aria-label', 'Nouvelle conversation dans ' + projectName(filter.project));
      begin.onclick = () => newConversation(filter.project);
      empty.append(begin);
      return;
    }
    empty.replaceChildren(
      node(
        'p',
        'library-note',
        failed
          ? 'Pellicule illisible : ' + failed
          : filter.media !== 'all' || filter.conversation !== 'all'
            ? 'Aucune création de ce type ici.'
            : 'Aucune création pour l’instant. Les images, vidéos et sons faits dans le Studio ou dans un chat arrivent ici.',
      ),
    );
  }
  function render() {
    const gone = paintFilters();
    paintGrid();
    if (gone) onFilter({ ...filter });
  }
  function choose(change) {
    // Another filter: a question left open is not found again later on a take that comes back.
    unask();
    Object.assign(filter, change);
    // Another project: every conversation of it.
    if ('project' in change && !('conversation' in change)) filter.conversation = 'all';
    render();
    onFilter({ ...filter });
  }
  /** The creations again, from the server (every conversation, and the one open if not saved yet). */
  async function refresh() {
    const asked = ++version,
      open = state.conversationId
        ? `&conversation=${encodeURIComponent(state.conversationId)}&project=${encodeURIComponent(state.projectId || 'inbox')}`
        : '';
    try {
      const result = await (await api('library?images=0' + open)).json();
      if (asked !== version) return;
      runs = result.runs ?? [];
      failed = '';
    } catch (error) {
      if (asked !== version) return;
      runs = [];
      failed = error.message;
    }
    // Only the tiles of these creations are kept; a question on one gone goes with it.
    const keys = new Set(runs.map(keyOf));
    for (const key of [...cards.keys()]) if (!keys.has(key)) cards.delete(key);
    if (asking && !keys.has(keyOf(asking.kept.record))) unask();
    render();
  }
  return {
    /** Shown on a project (`all`: every one), every kind, every conversation. */
    async show({ project = 'all' } = {}) {
      unask();
      Object.assign(filter, { project, media: 'all', conversation: 'all' });
      render();
      // The fil at its head says it at once.
      onFilter({ ...filter });
      await refresh();
    },
    refresh,
    render,
    filter: () => ({ ...filter }),
    /**
     * The fil in the Pellicule (its menus): a project or a conversation chosen there narrows the
     * sheet (`{ project }`, `{ conversation }`); it opens nothing.
     */
    choose,
    /**
     * How many takes a line of the menus of the fil stands for: those of the kind shown, of a
     * project (`all`: every one) or of a conversation; `media` another kind.
     */
    count: ({ project = 'all', conversation = 'all', media = filter.media } = {}) =>
      filtered(runs, { project, conversation, media }).length,
    /** Leaving the Pellicule: the sound that plays stops. */
    hush,
  };
}
