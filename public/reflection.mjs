/**
 * The reflection of Moodix in a message (claude_design/maquettes/reflexion-maquette.md, captures 58
 * to 61). Its label, « · RÉFLEXION 3 S », is on the line of the signature, in the writing of
 * « MOODIX »: a button, no icon nor chevron, that opens and folds it.
 * - While Moodix thinks (59): always open, on three lines only, the text written at the bottom and
 *   the lines above fading; the label counts the time (« 0:04 »).
 * - The answer begins (58): it folds by itself (200 ms); only the label stays, with how long it took.
 * - Open (60): its text at the margin of the answer, smaller and greyer, a fine rule down from the
 *   Éclipse; a paragraph per line of the model, 9 px apart, never an empty line.
 * - Long (61): past eight lines its foot fades and « Tout lire » unfolds the rest; « Réduire » folds
 *   it back to eight lines.
 * Without a reflection (thinking off, a model that has none) there is no label.
 */
const LONG = 168, // eight lines of 21 px
  FOLD_MS = 200;

/** How long, as the label writes it: « 3 S » under a minute, « 1:12 » past it; counting, « 0:04 ». */
export function thoughtTime(seconds, counting = false) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return counting || total >= 60
    ? `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
    : `${Math.max(1, total)} S`;
}

/** The paragraphs of a reflection: one per line the model wrote, no empty one. */
export const paragraphs = text =>
  String(text ?? '')
    .split(/\n+/)
    .map(part => part.trim())
    .filter(Boolean);

/**
 * The reflection of one message. `label` goes on the line of the signature, `element` under it.
 * `now` and `every` are the clock (tests give their own); `still`, whether less motion is asked.
 */
export function reflection({
  node,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  every = (run, ms) => {
    const timer = globalThis.setInterval?.(run, ms);
    timer?.unref?.();
    return () => globalThis.clearInterval?.(timer);
  },
  still = () => Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches),
  onChange = () => {},
}) {
  const label = node('button', 'reasoning-label'),
    time = node('span', 'reasoning-time'),
    element = node('div', 'reasoning'),
    pane = node('div', 'reasoning-window'),
    content = node('div', 'reasoning-content'),
    more = node('button', 'reasoning-more', 'Tout lire');
  label.type = more.type = 'button';
  label.append(node('span', 'reasoning-dot', '·'), node('span', 'reasoning-word', 'Réflexion'), time);
  label.setAttribute('aria-label', 'Réflexion du modèle');
  label.setAttribute('aria-expanded', 'false');
  label.hidden = element.hidden = more.hidden = true;
  pane.append(content);
  element.append(pane, more);

  let state = 'none', // 'live' while Moodix thinks, then 'closed' or 'open'
    text = '',
    from = null,
    seconds = null,
    stop = null,
    whole = false,
    moving = null;

  function set(next) {
    state = next;
    element.setAttribute('data-state', next);
    label.setAttribute('aria-expanded', String(next === 'open' || next === 'live'));
  }
  function write(next) {
    if (next === text) return;
    text = next;
    content.replaceChildren(...paragraphs(next).map(part => node('p', '', part)));
  }
  /** Past eight lines: its foot fades, « Tout lire » under it. */
  function measure() {
    const long = state === 'open' && Number(content.scrollHeight) > LONG + 4;
    if (long) element.setAttribute('data-long', '');
    else element.removeAttribute?.('data-long');
    if (whole && long) element.setAttribute('data-whole', '');
    else element.removeAttribute?.('data-whole');
    more.hidden = !long;
    more.textContent = whole ? 'Réduire' : 'Tout lire';
  }
  /** Unfolds or folds back in one soft movement; at once with less motion, or where nothing animates. */
  function slide(open, after = () => {}) {
    moving?.cancel?.();
    moving = null;
    if (open) element.hidden = false;
    const done = () => {
      if (!open) element.hidden = true;
      after();
      onChange();
    };
    if (still() || typeof element.animate !== 'function' || typeof element.getBoundingClientRect !== 'function') return done();
    const height = element.getBoundingClientRect().height + 'px',
      shut = { height: '0px', opacity: 0 },
      full = { height, opacity: 1 };
    element.style.overflow = 'hidden';
    const move = element.animate(open ? [shut, full] : [full, shut], { duration: FOLD_MS, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
    moving = move;
    move.onfinish = () => {
      if (moving !== move) return;
      moving = null;
      element.style.overflow = '';
      done();
    };
    move.oncancel = () => (element.style.overflow = '');
  }
  function open() {
    if (state !== 'closed' || !text) return;
    set('open');
    element.hidden = false;
    measure();
    slide(true);
  }
  function close() {
    if (state !== 'open') return;
    whole = false;
    slide(false, () => {
      set('closed');
      measure();
    });
  }
  /** The reflection is over: its time is said, and it folds by itself if it was still open. */
  function finish(given) {
    stop?.();
    stop = null;
    if (seconds === null)
      seconds = Number.isFinite(given) && given > 0 ? Math.round(given) : from === null ? null : Math.max(1, Math.round((now() - from) / 1000));
    time.textContent = seconds ? thoughtTime(seconds) : '';
    if (state !== 'live') return;
    slide(false, () => set('closed'));
  }
  const tick = () => (time.textContent = thoughtTime((now() - from) / 1000, true));

  label.onclick = () => (state === 'open' ? close() : open());
  more.onclick = () => {
    whole = !whole;
    measure();
    onChange();
  };

  return {
    label,
    element,
    content,
    /** What Moodix thinks, as it comes; `answered`: its answer has begun. */
    show(next, answered = false) {
      if (!next) return;
      write(next);
      if (state === 'none') {
        from = now();
        label.hidden = false;
        element.hidden = false;
        set('live');
        tick();
        stop = every(tick, 1000);
      }
      if (state === 'live' && answered) finish();
    },
    /** The turn is over (the answer never came: stopped, or a call alone). */
    end() {
      if (state === 'live' || (text && seconds === null && from !== null)) finish();
    },
    /** A reflection read back from the conversation: folded, with its time when it was kept. */
    restore(saved, kept) {
      write(String(saved ?? ''));
      stop?.();
      stop = null;
      seconds = Number.isFinite(kept) && kept > 0 ? Math.round(kept) : null;
      time.textContent = seconds ? thoughtTime(seconds) : '';
      label.hidden = !text;
      element.hidden = true;
      set(text ? 'closed' : 'none');
    },
    /** Nothing to show of it (a silent step of the turn). */
    hide() {
      stop?.();
      stop = null;
      label.hidden = element.hidden = true;
    },
    /** How long it took, once known. */
    seconds: () => seconds,
    state: () => state,
  };
}
