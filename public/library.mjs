/**
 * The Pellicule (pellicule-maquette.md; captures 30 to 34): every creation of every project, images,
 * clips and sounds, the newest at the top left. The projects are pills under the title (« Tous les
 * projets », each project and its number, « Sans projet », « + Nouveau projet »); a project chosen,
 * its conversations are a second row of pills (no more lists that unfold). Tout · Images · Vidéos ·
 * Sons at the right of the title. The takes are a contact sheet by day (« AUJOURD'HUI · 16 NOV. »),
 * each in its own format at one height; a sound is a card that plays. Under the pointer, a veil
 * with its prompt and where and when it was made, and at its top right the actions of the
 * conversation. A click shows it whole with its details; on its conversation, opens it.
 */
import { healThumbnail, thumbnailOf } from './thumbnails.mjs';

export const KINDS = [
  { id: 'all', icon: 'grid', label: 'Tout' },
  { id: 'image', icon: 'image', label: 'Images' },
  { id: 'video', icon: 'video', label: 'Vidéos' },
  { id: 'audio', icon: 'wave', label: 'Sons' },
];
const NAMES = { image: 'Image', video: 'Clip', audio: 'Son' };
/** Kept for the callers of before (0.5.123): the conversations are all shown, as pills. */
export const FIRST_CONVERSATIONS = 6;
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
/** The length of a creation, from its settings. */
const secondsOf = record => {
  const p = record.parameters ?? {};
  if (Number(p.seconds) > 0) return Number(p.seconds);
  return p.frames > 0 && p.fps > 0 ? p.frames / p.fps : null;
};
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
  onNewProject = null,
  onRenameProject = null,
  onDeleteProject = null,
  openStudio = null,
}) {
  const filter = { project: 'all', media: 'all', conversation: 'all' };
  let runs = [],
    version = 0,
    failed = '',
    menuOpen = false,
    playing = null; // { audio, button }: the sound that plays
  // The tiles drawn, kept from one drawing to the next (another filter, a project renamed):
  // their pictures are not loaded again.
  const cards = new Map();
  const projects = () => (state.projects?.length ? state.projects : [{ id: 'inbox', name: 'Conversations' }]);
  // Outside any project: « Sans projet » (0.6.0), whatever the stored name of the group.
  const projectName = id =>
    (id || 'inbox') === 'inbox' ? 'Sans projet' : (projects().find(project => project.id === id)?.name ?? 'Sans projet');
  const conversations = () =>
    (state.historyItems || []).filter(item => filter.project === 'all' || (item.projectId || 'inbox') === filter.project);
  const titleOf = id =>
    (state.historyItems || []).find(item => item.id === id)?.title ?? (id === state.conversationId ? 'Nouvelle conversation' : 'Conversation');
  const date = value => (value ? new Date(value).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '');
  const count = list => String(list.length);

  /** A pill: its name, its number; `chosen` lights it. */
  function pill(className, name, number, chosen, onclick) {
    const element = node('button', className + (chosen ? ' is-chosen' : ''));
    element.type = 'button';
    element.setAttribute('aria-pressed', String(Boolean(chosen)));
    element.append(node('span', 'library-pill-name', name));
    if (number !== null) element.append(node('span', 'library-pill-count', number));
    element.onclick = onclick;
    return element;
  }
  /** The projects, then (one chosen) its conversations: filters in pills, at the same place. */
  function paintFilters() {
    const gone = filter.project !== 'all' && !projects().some(project => project.id === filter.project);
    if (gone) filter.project = 'all';
    // « Sans projet » after the projects, as in the fil.
    const named = projects().filter(project => project.id !== 'inbox'),
      ordered = [...named, ...projects().filter(project => project.id === 'inbox')],
      row = $('library-projects');
    row.replaceChildren(
      pill('library-pill', 'Tous les projets', count(filtered(runs, { media: filter.media })), filter.project === 'all', () =>
        choose({ project: 'all' }),
      ),
      ...ordered.map(project => {
        const element = pill(
          'library-pill',
          projectName(project.id),
          count(filtered(runs, { project: project.id, media: filter.media })),
          filter.project === project.id,
          () => choose({ project: project.id }),
        );
        element.dataset.project = project.id;
        return element;
      }),
    );
    if (onNewProject) {
      const create = node('button', 'library-pill is-new');
      create.type = 'button';
      create.append(icon('plus'), node('span', '', 'Nouveau projet'));
      create.onclick = () => onNewProject();
      row.append(create);
    }
    const list = conversations();
    if (filter.conversation !== 'all' && !list.some(item => item.id === filter.conversation)) filter.conversation = 'all';
    const talks = $('library-conversations');
    talks.hidden = filter.project === 'all';
    if (filter.project === 'all') talks.replaceChildren();
    else {
      const inProject = filtered(runs, { project: filter.project, media: filter.media }),
        made = list.filter(item => inProject.some(record => record.conversationId === item.id));
      talks.replaceChildren(
        node('span', 'library-pills-label', 'Conversations'),
        // A project without a creation keeps « + Nouvelle conversation » only (capture 34).
        ...(inProject.length
          ? [
              pill('library-pill', 'Toutes les conversations', count(inProject), filter.conversation === 'all', () =>
                choose({ conversation: 'all' }),
              ),
              ...made.map(item => {
                const element = pill(
                  'library-pill',
                  item.title,
                  count(inProject.filter(record => record.conversationId === item.id)),
                  filter.conversation === item.id,
                  () => choose({ conversation: item.id }),
                );
                element.dataset.id = item.id;
                return element;
              }),
            ]
          : []),
      );
      const create = node('button', 'library-pill is-new');
      create.type = 'button';
      create.append(icon('plus'), node('span', '', 'Nouvelle conversation'));
      create.setAttribute('aria-label', 'Nouvelle conversation dans ' + projectName(filter.project));
      create.onclick = () => newConversation(filter.project);
      talks.append(create);
    }
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
  /** « Pellicule », or « Pellicule › test » with « ··· » (Renommer, Supprimer le projet). */
  function paintHeading(total) {
    const heading = $('library-heading');
    if (filter.project === 'all') heading.replaceChildren(node('span', 'library-title', 'Pellicule'));
    else {
      heading.replaceChildren(node('span', 'library-crumb', 'Pellicule ›'), node('span', 'library-title', projectName(filter.project)));
      const project = projects().find(item => item.id === filter.project);
      if (project && project.id !== 'inbox' && (onRenameProject || onDeleteProject)) {
        const more = node('button', 'library-project-more');
        more.type = 'button';
        more.setAttribute('aria-label', 'Projet ' + projectName(project.id) + ' : renommer, supprimer');
        more.title = 'Renommer ou supprimer le projet';
        more.setAttribute('aria-expanded', String(menuOpen));
        more.append(node('span', '', '···'));
        more.onclick = () => {
          menuOpen = !menuOpen;
          render();
        };
        heading.append(more);
        if (menuOpen) {
          const menu = node('div', 'library-project-menu');
          menu.setAttribute('role', 'menu');
          for (const [label, run] of [
            ['Renommer', onRenameProject],
            ['Supprimer le projet', onDeleteProject],
          ]) {
            if (!run) continue;
            const entry = node('button', 'library-project-action', label);
            entry.type = 'button';
            entry.setAttribute('role', 'menuitem');
            entry.onclick = () => {
              menuOpen = false;
              render();
              run(project);
            };
            menu.append(entry);
          }
          heading.append(menu);
        }
      }
    }
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
    playing = { audio, button };
    button.classList.add('is-playing');
    void audio.play?.()?.catch?.(() => button.classList.remove('is-playing'));
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
      // Its first picture only, of which a thumbnail is made for the next time.
      const clip = node('video');
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
    return kept;
  }
  function tile(record) {
    const key = record.id + '|' + (record.outputs?.[0]?.originalUrl || '');
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
    paintHeading(shown.length);
    const empty = $('library-empty');
    empty.hidden = shown.length > 0;
    if (shown.length) return empty.replaceChildren();
    // A project with nothing in it (capture 34): its sentence, and two ways to begin.
    if (!failed && filter.project !== 'all' && filter.media === 'all' && filter.conversation === 'all') {
      empty.replaceChildren(
        node('p', 'library-empty-title', 'Rien dans ce projet pour l’instant.'),
        node('p', 'library-empty-text', 'Les images, les vidéos et les sons faits dans ce projet arrivent ici, la dernière en haut à gauche.'),
      );
      const doors = node('div', 'library-doors');
      if (openStudio) {
        const studio = node('button', 'library-door', 'Ouvrir le Studio');
        studio.type = 'button';
        studio.onclick = () => openStudio(filter.project);
        doors.append(studio);
      }
      const chat = node('button', 'library-door', 'Nouvelle conversation');
      chat.type = 'button';
      chat.onclick = () => newConversation(filter.project);
      doors.append(chat);
      empty.append(doors);
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
    Object.assign(filter, change);
    if ('project' in change) {
      filter.conversation = 'all';
      menuOpen = false;
    }
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
    // Only the tiles of these creations are kept.
    const keys = new Set(runs.map(record => record.id + '|' + (record.outputs?.[0]?.originalUrl || '')));
    for (const key of [...cards.keys()]) if (!keys.has(key)) cards.delete(key);
    render();
  }
  return {
    /** Shown on a project (`all`: every one), every kind, every conversation. */
    async show({ project = 'all' } = {}) {
      Object.assign(filter, { project, media: 'all', conversation: 'all' });
      menuOpen = false;
      render();
      await refresh();
    },
    refresh,
    render,
    filter: () => ({ ...filter }),
    /** Leaving the Pellicule: the sound that plays stops. */
    hush() {
      playing?.audio.pause();
      playing?.button.classList.remove('is-playing');
      playing = null;
    },
  };
}
