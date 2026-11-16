import { renderProposal } from './video-plan.mjs';

const KINDS = { video: 'Vidéo', audio: 'Son', image: 'Image' };

/**
 * The proposal of Moodix, in its message (direction-artistique.md, « La proposition vidéo »;
 * captures 11 and 12): a card that arrives with the plan, editable in place, instead of a window.
 * - A video starts by itself after `delay`: the glass of « Générer » fills with the accent from left
 *   to right, « DÉPART DANS 18 S » at the top right of the card.
 * - The count pauses while the pointer is on the card or while something is written in the message
 *   box (« EN PAUSE »), and stops for good at a click or a key in the card (« EN ATTENTE DE VOTRE
 *   ACCORD »): then only « Générer » starts it. A sound waits for « Générer » (no count).
 * - « Annuler » leaves the line « Proposition annulée. »; a new message declines it too, and the card
 *   goes (Moodix answers with another). No « Toujours autoriser ».
 * « + » on an input joins an image to the next message (`onAdd`); joining one stops the count (`stop`).
 * Returns `answer` ('once' or 'deny', after the changes are sent), `decline()` and `stop()`.
 */
export function proposalCard({
  host,
  request,
  signal,
  node,
  api,
  delay = 30000,
  composer = null,
  onAdd = null,
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
  function render() {
    title.textContent = ['Proposition', KINDS[request.mediaType] ?? KINDS.image, request.workflowName].filter(Boolean).join(' · ');
    form = renderProposal(body, request, {
      node,
      card: true,
      onAdd,
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
        fold.panel.hidden = !fold.panel.hidden;
        toggle.setAttribute('aria-expanded', String(!fold.panel.hidden));
      };
      toggles.append(toggle);
      panels.append(fold.panel);
    }
  }
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
      phase === 'waiting' ? (counted ? 'En attente de votre accord' : '') : phase === 'paused' ? 'En pause' : `Départ dans ${Math.max(1, Math.ceil(left / 1000))} s`;
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

  render();
  say();
  cancel.onclick = () => finish('deny', { line: true });
  go.onclick = () => void confirm();
  card.addEventListener('pointerenter', enter);
  card.addEventListener('pointerleave', leave);
  card.addEventListener('pointerdown', touched, true);
  card.addEventListener('keydown', touched, true);
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
