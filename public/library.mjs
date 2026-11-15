/**
 * The library (Bibliothèque, 0.5.123): every creation of every project, images, clips and sounds,
 * newest first. Its project is chosen at its top; opened on one (a click on it in the sidebar), it
 * is the view of that project: its conversations, then its creations. The kind and the
 * conversation narrow the creations, above which they sit. A click on a creation shows it whole
 * with its details; on its conversation, opens it. The latest visual of a project is simply its
 * first tile.
 */
import { thumbnailOf } from './thumbnails.mjs';

export const KINDS = [
  { id: 'all', icon: 'media', label: 'Tout' },
  { id: 'image', icon: 'image', label: 'Images' },
  { id: 'video', icon: 'video', label: 'Vidéos' },
  { id: 'audio', icon: 'wave', label: 'Sons' },
];
const NAMES = { image: 'Image', video: 'Clip', audio: 'Son' };
/** The conversations of a project shown before « Afficher les autres ». */
export const FIRST_CONVERSATIONS = 6;

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

export function setupLibrary({ $, state, node, icon, api, viewOutput, openConversation, newConversation, onFilter = () => {} }) {
  const filter = { project: 'all', media: 'all', conversation: 'all' };
  let runs = [],
    version = 0,
    unfolded = false,
    failed = '';
  // The tiles drawn, kept from one drawing to the next (another filter, a project renamed):
  // their pictures are not loaded again.
  const cards = new Map();
  const projects = () => (state.projects?.length ? state.projects : [{ id: 'inbox', name: 'Conversations' }]);
  const projectName = id => projects().find(project => project.id === (id || 'inbox'))?.name ?? 'Conversations';
  const conversations = () =>
    (state.historyItems || []).filter(item => filter.project === 'all' || (item.projectId || 'inbox') === filter.project);
  const titleOf = id =>
    (state.historyItems || []).find(item => item.id === id)?.title ?? (id === state.conversationId ? 'Nouveau chat' : 'Conversation');
  const date = value => (value ? new Date(value).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '');

  function option(value, text, chosen) {
    const element = node('option', '', text);
    element.value = value;
    element.selected = value === chosen;
    return element;
  }
  /** The three filters; true when the project shown is gone (deleted elsewhere): every one is shown. */
  function paintFilters() {
    const gone = filter.project !== 'all' && !projects().some(project => project.id === filter.project);
    if (gone) filter.project = 'all';
    $('library-project').replaceChildren(
      option('all', 'Tous les projets', filter.project),
      ...projects().map(project => option(project.id, project.name, filter.project)),
    );
    $('library-project').value = filter.project;
    const list = conversations();
    if (filter.conversation !== 'all' && !list.some(item => item.id === filter.conversation)) filter.conversation = 'all';
    $('library-conversation').replaceChildren(
      option('all', 'Toutes les conversations', filter.conversation),
      ...list.map(item =>
        option(item.id, item.title + (filter.project === 'all' ? ' · ' + projectName(item.projectId) : ''), filter.conversation),
      ),
    );
    $('library-conversation').value = filter.conversation;
    const kinds = $('library-kinds');
    kinds.replaceChildren(
      ...KINDS.map(kind => {
        const choice = node('button', 'library-kind');
        choice.type = 'button';
        choice.dataset.kind = kind.id;
        choice.setAttribute('role', 'radio');
        choice.setAttribute('aria-checked', String(filter.media === kind.id));
        choice.tabIndex = filter.media === kind.id ? 0 : -1;
        choice.append(icon(kind.icon), node('span', '', kind.label));
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
  /** The view of a project: its conversations, the first ones, and a new chat in it. */
  function paintProject() {
    const box = $('library-project-view');
    if (filter.project === 'all') {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    const list = conversations();
    const head = node('div', 'library-section-head');
    head.append(node('h2', '', 'Conversations'), node('span', 'library-count', String(list.length)));
    const create = node('button', 'library-new');
    create.type = 'button';
    create.append(icon('plus'), node('span', '', 'Nouveau chat'));
    create.setAttribute('aria-label', 'Nouveau chat dans ' + projectName(filter.project));
    create.onclick = () => newConversation(filter.project);
    head.append(create);
    const rows = node('div', 'library-conversations');
    for (const item of unfolded ? list : list.slice(0, FIRST_CONVERSATIONS)) {
      const row = node('button', 'library-conversation');
      row.type = 'button';
      row.dataset.id = item.id;
      if (item.id === state.conversationId) row.setAttribute('aria-current', 'true');
      const when = node('time', '', date(item.createdAt || item.updatedAt));
      if (item.createdAt || item.updatedAt) when.dateTime = item.createdAt || item.updatedAt;
      row.append(icon('chat'), node('span', 'library-conversation-title', item.title), when);
      row.onclick = () => openConversation(item.id);
      rows.append(row);
    }
    if (!list.length) rows.append(node('p', 'library-note', 'Aucune conversation dans ce projet pour l’instant.'));
    box.replaceChildren(head, rows);
    if (!unfolded && list.length > FIRST_CONVERSATIONS) {
      const more = node('button', 'library-more'),
        rest = list.length - FIRST_CONVERSATIONS;
      more.type = 'button';
      more.textContent = rest > 1 ? `Afficher les ${rest} autres` : 'Afficher l’autre';
      more.onclick = () => {
        unfolded = true;
        paintProject();
      };
      box.append(more);
    }
    box.hidden = false;
  }
  /** A tile: the picture (a click shows it whole), the prompt, where it was made (a click opens it). */
  function build(record) {
    const media = mediaOf(record),
      output = record.outputs?.[0] ?? {},
      card = node('article', 'library-tile'),
      kept = { card, record };
    card.dataset.id = record.id;
    card.dataset.media = media;
    const pick = node('button', 'library-pick');
    pick.type = 'button';
    pick.setAttribute('aria-label', [NAMES[media] ?? 'Création', record.prompt || ''].filter(Boolean).join(' · '));
    pick.onclick = () => viewOutput(kept.record, 0);
    if (media === 'audio') {
      const wave = node('span', 'library-wave');
      wave.setAttribute('aria-hidden', 'true');
      pick.append(wave);
    } else if (output.thumbUrl || media === 'image') {
      const picture = node('img');
      Object.assign(picture, { alt: '', loading: 'lazy', decoding: 'async', src: output.thumbUrl || output.originalUrl || '' });
      // Served whole: a thumbnail is kept for the next time.
      if (!output.thumbUrl) picture.onload = () => void thumbnailOf(api, record, 0, picture);
      pick.append(picture);
    } else {
      // Its first picture only, of which a thumbnail is made for the next time.
      const clip = node('video');
      Object.assign(clip, { muted: true, preload: 'metadata', playsInline: true, src: (output.originalUrl || '') + '#t=0.1' });
      clip.onloadeddata = () => void thumbnailOf(api, record, 0, clip);
      pick.append(clip);
    }
    if (media !== 'image') {
      const badge = node('span', 'library-badge');
      badge.setAttribute('aria-hidden', 'true');
      badge.append(icon(media === 'video' ? 'video' : 'wave'));
      pick.append(badge);
    }
    const words = node('div', 'library-words');
    words.append(node('p', 'library-prompt', record.prompt || NAMES[media] || 'Création'));
    if (record.legacy) {
      // The Studio of before had no conversation: nothing to open.
      words.append(node('span', 'library-from', 'Ancien Studio'));
    } else {
      const from = node('button', 'library-from');
      from.type = 'button';
      from.onclick = () => openConversation(kept.record.conversationId);
      words.append(from);
      kept.from = from;
    }
    card.append(pick, words);
    return kept;
  }
  function tile(record) {
    const key = record.id + '|' + (record.outputs?.[0]?.originalUrl || '');
    let kept = cards.get(key);
    if (!kept) cards.set(key, (kept = build(record)));
    kept.record = record;
    if (kept.from) {
      // Its project said only when every project is shown.
      kept.from.textContent = (filter.project === 'all' ? projectName(record.projectId) + ' · ' : '') + titleOf(record.conversationId);
      kept.from.setAttribute('aria-label', 'Ouvrir la conversation : ' + titleOf(record.conversationId));
    }
    return kept.card;
  }
  function paintGrid() {
    const shown = filtered(runs, filter);
    $('library-grid').replaceChildren(...shown.map(tile));
    $('library-total').textContent = String(shown.length);
    const empty = $('library-empty');
    empty.hidden = shown.length > 0;
    empty.textContent = failed
      ? 'Bibliothèque illisible : ' + failed
      : filter.media !== 'all' || filter.conversation !== 'all'
        ? 'Aucune création de ce type ici.'
        : filter.project === 'all'
          ? 'Aucune création pour l’instant. Les images, vidéos et sons faits dans le Studio ou dans un chat arrivent ici.'
          : 'Aucune création dans ce projet pour l’instant.';
    $('library-heading').textContent = filter.project === 'all' ? 'Bibliothèque' : 'Bibliothèque › ' + projectName(filter.project);
  }
  function render() {
    const gone = paintFilters();
    paintProject();
    paintGrid();
    if (gone) onFilter({ ...filter });
  }
  function choose(change) {
    Object.assign(filter, change);
    if ('project' in change) {
      filter.conversation = 'all';
      unfolded = false;
    }
    render();
    onFilter({ ...filter });
  }
  $('library-project').onchange = () => choose({ project: $('library-project').value });
  $('library-conversation').onchange = () => choose({ conversation: $('library-conversation').value });
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
      unfolded = false;
      render();
      await refresh();
    },
    refresh,
    render,
    filter: () => ({ ...filter }),
  };
}
