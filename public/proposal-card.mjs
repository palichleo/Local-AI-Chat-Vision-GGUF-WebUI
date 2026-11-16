import { renderProposal } from './video-plan.mjs';

const KINDS = { video: 'Vidéo', audio: 'Son', image: 'Image' };

/**
 * The proposal of Moodix, in its message (direction-artistique.md, « La proposition vidéo »;
 * captures 11 and 12): a card that arrives with the plan, editable in place, instead of a window.
 * - With a `delay` (none in the Chat since 16/11: a video always waits for the user there, « EN
 *   ATTENTE DE VOTRE ACCORD »), a video starts by itself after it: the glass of « Générer » fills
 *   with the accent from left to right, « DÉPART DANS 18 S » at the top right of the card.
 * - The count pauses while the pointer is on the card or while something is written in the message
 *   box (« EN PAUSE »), and stops for good at a click or a key in the card (« EN ATTENTE DE VOTRE
 *   ACCORD »): then only « Générer » starts it. A sound waits for « Générer » (no count).
 * - « Annuler » leaves the line « Proposition annulée. » (answer 'cancel'); a new message declines it
 *   too ('deny'): the card goes without a trace (Moodix answers with another). No « Toujours
 *   autoriser ».
 * « + » on an input opens « Créations du projet » in the card (`takes()`: the creations of the project);
 * the image chosen goes in its case, as an image dropped or pasted on the card (`importImage(file)`:
 * kept as a reference of the project first); the server revises the proposal (`add`), no message.
 * Returns `answer` ('once' after the changes are sent, 'deny' or 'cancel'), `decline()` and `stop()`.
 */
export function proposalCard({
  host,
  request,
  signal,
  node,
  api,
  delay = 30000,
  composer = null,
  takes = null,
  importImage = null,
  onChange = () => {},
}) {
  const card = node('section', 'proposal-card'),
    head = node('header', 'proposal-head'),
    title = node('p', 'proposal-title'),
    status = node('p', 'proposal-status'),
    body = node('div', 'proposal-body'),
    foot = node('footer', 'proposal-foot'),
    toggles = node('div', 'proposal-toggles'),
    panels = node('div', 'proposal-panels'),
    cancel = node('button', 'proposal-cancel', 'Annuler'),
    go = node('button', 'proposal-go'),
    counted = request.mediaType === 'video' && delay > 0;
  card.setAttribute('aria-label', 'Proposition de Moodix');
  card.tabIndex = -1;
  status.setAttribute('aria-live', 'polite');
  cancel.type = go.type = 'button';
  go.append(node('span', 'proposal-go-play'), node('span', 'proposal-go-word', 'Générer'));
  go.setAttribute('aria-label', 'Générer');
  head.append(title, status);
  foot.append(toggles, cancel, go);
  card.append(head, body, foot, panels);
  host.append(card);

  let form = null,
    saving = false;
  /**
   * « Paramètres avancés » and « Prompt » unfold and fold back softly (16/11): their height and their
   * margin go from nothing to their own in 0.22 s, the words fading in; at once with less motion
   * asked, or where the page cannot animate.
   */
  function unfold(panel, open) {
    const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    panel.moving?.cancel?.();
    panel.moving = null;
    if (open) panel.hidden = false;
    if (still || typeof panel.animate !== 'function') {
      panel.hidden = !open;
      return onChange();
    }
    const height = panel.getBoundingClientRect().height,
      gap = globalThis.getComputedStyle?.(panel).marginTop ?? '0px',
      closed = { height: '0px', marginTop: '0px', opacity: 0 },
      opened = { height: height + 'px', marginTop: gap, opacity: 1 };
    panel.style.overflow = 'hidden';
    const move = panel.animate(open ? [closed, opened] : [opened, closed], { duration: 220, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
    panel.moving = move;
    const done = () => {
      if (panel.moving !== move) return;
      panel.moving = null;
      panel.style.overflow = '';
      if (!open) panel.hidden = true;
      onChange();
    };
    move.onfinish = done;
    move.oncancel = () => (panel.style.overflow = '');
  }
  function render() {
    title.textContent = ['Proposition', KINDS[request.mediaType] ?? KINDS.image, request.workflowName].filter(Boolean).join(' · ');
    form = renderProposal(body, request, {
      node,
      card: true,
      onAdd: takes || importImage ? role => void openShelf(role) : null,
      onStage: (stage, edits) => void revise({ ...edits, stage }),
    });
    // « Paramètres avancés › » and « Prompt › » at the foot, their panel opening under it.
    toggles.replaceChildren();
    panels.replaceChildren();
    for (const fold of form.folds ?? []) {
      const toggle = node('button', 'proposal-toggle', fold.name);
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', 'false');
      fold.panel.hidden = true;
      toggle.onclick = () => {
        const open = fold.panel.hidden;
        toggle.setAttribute('aria-expanded', String(open));
        unfold(fold.panel, open);
      };
      toggles.append(toggle);
      panels.append(fold.panel);
    }
  }
  /**
   * « Créations du projet » under the cases (as in the Studio): the images of the project, the newest
   * at the left, 56 px; one taken goes in the case. No × (16/11): Échap or a click beside it closes
   * it, and again the same « + ».
   */
  let shelfRole = null;
  function closeShelf() {
    if (form?.shelf) form.shelf.hidden = true;
    shelfRole = null;
    globalThis.document?.removeEventListener?.('pointerdown', beside, true);
  }
  // A click beside it closes it; a case of the card (its « + ») opens or closes it itself.
  function beside(event) {
    if (form?.shelf?.contains?.(event.target) || event.target?.closest?.('.proposal-input')) return;
    closeShelf();
  }
  async function openShelf(role) {
    const shelf = form?.shelf;
    if (!shelf) return;
    if (shelfRole === role && !shelf.hidden) return closeShelf();
    shelfRole = role;
    const head = node('p', 'proposal-shelf-title', 'Créations du projet'),
      row = node('div', 'proposal-shelf-row');
    row.append(node('span', 'proposal-shelf-note', takes ? 'Chargement…' : 'Glissez ou collez une image ici.'));
    shelf.replaceChildren(head, row);
    // A file of the computer, at the end (as in the Studio).
    if (importImage) {
      const file = node('button', 'proposal-shelf-file', 'Depuis l’ordinateur…'),
        input = node('input');
      file.type = 'button';
      Object.assign(input, { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
      input.onchange = () => void addFile(role, input.files?.[0]);
      file.onclick = () => input.click?.();
      shelf.append(file, input);
    }
    shelf.hidden = false;
    globalThis.document?.addEventListener?.('pointerdown', beside, true);
    if (!takes) return;
    let list = [];
    try {
      list = (await takes()).filter(record => !record.mediaType || record.mediaType === 'image');
    } catch (error) {
      row.replaceChildren(node('span', 'proposal-shelf-note', error.message));
      return;
    }
    if (shelfRole !== role || done) return;
    row.replaceChildren(
      ...(list.length ? [] : [node('span', 'proposal-shelf-note', 'Aucune image dans ce projet pour l’instant.')]),
      ...list.slice(0, 40).map(record => {
        const output = record.outputs?.[0] ?? {},
          pick = node('button', 'proposal-shelf-pick'),
          picture = node('img');
        pick.type = 'button';
        const name = Number.isInteger(output.take) ? 'Prise ' + output.take : 'Image';
        pick.setAttribute('aria-label', 'Prendre : ' + name + (record.prompt ? ' · ' + record.prompt : ''));
        pick.title = name;
        Object.assign(picture, { src: output.thumbUrl || output.originalUrl || '', alt: '', loading: 'lazy', decoding: 'async' });
        pick.append(picture);
        pick.onclick = () =>
          void addInput(role, { output: record.id, ...(record.conversationId ? { conversation: record.conversationId } : {}) });
        return pick;
      }),
    );
  }
  /** An image in a case of the card: the proposal revised with it. */
  async function addInput(role, source) {
    if (!role || done) return;
    stop();
    // What was already changed in the card goes with it (the card is drawn again from the answer).
    let edits = {};
    try {
      edits = form?.edits() ?? {};
    } catch (error) {
      form?.error(error.message);
      return;
    }
    shelfRole = null;
    await revise({ ...edits, add: { role, source } });
  }
  /** A file dropped or pasted on the card: kept as a reference of the project, then put in its case. */
  async function addFile(role, file) {
    if (!importImage || !file || !/^image\/(png|jpeg|webp)$/.test(file.type || '')) return;
    try {
      const kept = await importImage(file);
      if (kept?.id) await addInput(role, { resource: kept.id });
    } catch (error) {
      form?.error(error.message);
    }
  }
  /** The case an image goes to: the one under the pointer, else the open one, else the first empty. */
  function roleAt(target) {
    const hit = target?.closest?.('[data-role]');
    if (hit) return hit.getAttribute('data-role');
    if (shelfRole) return shelfRole;
    return form?.emptyRoles?.()[0] ?? null;
  }
  card.addEventListener?.('dragover', event => {
    if (!event.dataTransfer?.types?.includes?.('Files')) return;
    event.preventDefault();
    card.classList.add('is-dropping');
  });
  card.addEventListener?.('dragleave', event => {
    if (!card.contains(event.relatedTarget)) card.classList.remove('is-dropping');
  });
  card.addEventListener?.('drop', event => {
    card.classList.remove('is-dropping');
    const [file] = event.dataTransfer?.files ?? [];
    if (!file) return;
    event.preventDefault();
    void addFile(roleAt(event.target), file);
  });
  card.addEventListener?.('paste', event => {
    const file = [...(event.clipboardData?.files ?? [])].find(item => item.type?.startsWith('image/'));
    if (!file) return;
    event.preventDefault();
    void addFile(roleAt(event.target), file);
  });
  // The changes sent: the revised proposal (a new token) replaces this one.
  async function revise(edits) {
    if (saving) return false;
    saving = true;
    go.disabled = true;
    try {
      const revised = await (
        await api('tools/revise', { requestId: request.requestId, approvalToken: request.approvalToken, edits })
      ).json();
      if (signal?.aborted) return false;
      Object.assign(request, revised);
      render();
      return true;
    } catch (error) {
      form?.error(error.message);
      return false;
    } finally {
      saving = false;
      go.disabled = false;
    }
  }

  // The count: 'counting', 'paused' (hold), or 'waiting' (stopped for good).
  let phase = counted ? 'counting' : 'waiting',
    left = delay,
    since = 0,
    timer = null,
    ticking = null,
    pointer = false;
  const now = () => (globalThis.performance?.now?.() ?? Date.now());
  function say() {
    status.textContent =
      phase === 'waiting' ? (request.mediaType === 'video' ? 'En attente de votre accord' : '') : phase === 'paused' ? 'En pause' : `Départ dans ${Math.max(1, Math.ceil(left / 1000))} s`;
    card.dataset.phase = phase;
  }
  function clear() {
    clearTimeout(timer);
    clearInterval(ticking);
    timer = ticking = null;
  }
  function run() {
    since = now();
    // The fill of « Générer » lasts the whole count; held, it waits with it (is-held), never restarts.
    if (!go.classList.contains('is-counting')) go.style.setProperty('--left', left + 'ms');
    go.classList.add('is-counting');
    go.classList.remove('is-held');
    timer = setTimeout(() => void confirm(), left);
    ticking = setInterval(() => {
      left = Math.max(0, left - (now() - since));
      since = now();
      say();
    }, 250);
  }
  function hold() {
    if (phase !== 'counting') return;
    clear();
    left = Math.max(0, left - (now() - since));
    phase = 'paused';
    go.classList.add('is-held');
    say();
  }
  function release() {
    if (phase !== 'paused' || pointer || composer?.value?.trim()) return;
    phase = 'counting';
    run();
    say();
  }
  function stop() {
    if (phase === 'waiting') return;
    clear();
    phase = 'waiting';
    go.classList.remove('is-counting', 'is-held');
    say();
  }
  const enter = () => {
    pointer = true;
    hold();
  };
  const leave = () => {
    pointer = false;
    release();
  };
  const typing = () => (composer?.value?.trim() ? hold() : release());
  const touched = event => {
    // Générer and Annuler answer themselves; anything else in the card stops the count.
    if (event.target === go || go.contains?.(event.target) || event.target === cancel) return;
    stop();
  };

  let settle;
  const answer = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  let done = false;
  function finish(value, { line = false } = {}) {
    if (done) return;
    done = true;
    clear();
    card.removeEventListener('pointerenter', enter);
    card.removeEventListener('pointerleave', leave);
    card.removeEventListener('pointerdown', touched, true);
    card.removeEventListener('keydown', touched, true);
    card.removeEventListener('keydown', escape);
    globalThis.document?.removeEventListener?.('pointerdown', beside, true);
    composer?.removeEventListener?.('input', typing);
    signal?.removeEventListener?.('abort', abort);
    card.remove();
    // Cancelled from the card: a line says it where it was.
    if (line) host.append(node('p', 'proposal-cancelled', 'Proposition annulée.'));
    onChange();
    if (value instanceof Error) settle.reject(value);
    else settle.resolve(value);
  }
  // What runs is what the card shows: its changes are sent first.
  async function confirm() {
    if (saving || done) return;
    stop();
    if (form) {
      let edits;
      try {
        edits = form.edits();
      } catch (error) {
        form.error(error.message);
        return;
      }
      if (Object.keys(edits).length && !(await revise(edits))) return;
    }
    finish('once');
  }
  const abort = () => finish(signal.reason || new DOMException('Annulé', 'AbortError'));

  // Échap closes « Créations du projet » (16/11: no ×).
  const escape = event => {
    if (event.key !== 'Escape' || !shelfRole) return;
    event.preventDefault?.();
    closeShelf();
  };
  render();
  say();
  cancel.onclick = () => finish('cancel', { line: true });
  go.onclick = () => void confirm();
  card.addEventListener('pointerenter', enter);
  card.addEventListener('pointerleave', leave);
  card.addEventListener('pointerdown', touched, true);
  card.addEventListener('keydown', touched, true);
  card.addEventListener('keydown', escape);
  composer?.addEventListener?.('input', typing);
  signal?.addEventListener?.('abort', abort, { once: true });
  if (signal?.aborted) abort();
  else if (phase === 'counting') {
    run();
    if (composer?.value?.trim()) hold();
  }
  onChange();
  return { answer, decline: () => finish('deny'), stop, card };
}
