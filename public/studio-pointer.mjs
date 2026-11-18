/**
 * The pointer of Moodix AI: a white arrow in a soft halo, with a label of what it does
 * (« Moodix AI · règle la durée »). It glides from one setting to the next (0.25 s), and
 * leaves a clear ring on the setting it changes, then a fine trace once it is set; it carries a
 * take as the hand does (`carry`: its picture tilted, « PRISE n » on it). Nothing blinks; with
 * `prefers-reduced-motion` it does not glide, it appears where it goes.
 */
export function setupPointer({ cursor, text, host = globalThis }) {
  const reduced = () => Boolean(host.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const carried = cursor.querySelector?.('.ai-cursor-carry'),
    carriedTake = cursor.querySelector?.('.ai-cursor-carry-take'),
    label = text.closest?.('.ai-cursor-label') ?? text.parentElement ?? null;
  let shown = false,
    // Where it rests, or goes: the label is put back there when its words change.
    at = null;
  /**
   * Where its label goes beside the pointer at `x` (0.6.101): at its right, or at its left where the
   * right has no room, and pushed back 8 px inside an edge, so that it is always whole in the window.
   * It glides with the pointer (moodix.css: the same time, the same curve), so that from one place to
   * the next it stays in the window too. It changed side at once before, and went out on the left of
   * a window of 1280 px while the pointer left the column of the prompt for the settings.
   */
  function aside(x) {
    const width = label?.offsetWidth ?? 0,
      room = host.innerWidth ?? Infinity,
      right = x + 22,
      start = right + width <= room - 8 ? right : x - 18 - width;
    // (A window narrower than its words: their beginning in sight, « Moodix AI · ».)
    return Math.round(Math.max(8, Math.min(start, room - 8 - width)) - x);
  }
  function place(element, { ax = null, ay = null } = {}) {
    const box = element.getBoundingClientRect?.();
    if (!box) return false;
    const x = box.left + (ax ?? box.width / 2),
      y = box.top + (ay ?? box.height / 2);
    cursor.style.setProperty('--ai-x', Math.round(x) + 'px');
    cursor.style.setProperty('--ai-y', Math.round(y) + 'px');
    cursor.style.setProperty('--ai-label-x', aside(x) + 'px');
    at = x;
    return true;
  }
  /** Its new words where it is now, at once: they are wider or narrower than the ones before. */
  function reword(words) {
    text.textContent = words;
    if (!shown || at === null || !label?.style) return;
    label.style.transition = 'none';
    cursor.style.setProperty('--ai-label-x', aside(at) + 'px');
    void label.offsetWidth;
    label.style.transition = '';
  }
  return {
    reduced,
    /** Goes to `element` and says what it does there. */
    move(element, words, anchor) {
      if (!element) return;
      element.scrollIntoView?.({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
      // Its words first: where its label goes depends on their width.
      reword(words || '');
      if (!shown) {
        // It appears where it starts: it does not fly in from a corner of the window.
        cursor.hidden = false;
        cursor.classList.add('is-placing');
        place(element, anchor);
        // One frame later it fades in, then moves from there.
        host.requestAnimationFrame?.(() => {
          cursor.classList.remove('is-placing');
          cursor.classList.add('is-visible');
        }) ?? cursor.classList.add('is-visible');
        shown = true;
      } else place(element, anchor);
    },
    /** Follows its element again after the page moved under it. */
    follow(element, anchor) {
      if (shown && element) place(element, anchor);
    },
    hide() {
      if (!shown) return;
      shown = false;
      cursor.classList.remove('is-visible');
      // Gone once faded (0.25 s): nothing is left over the page.
      host.setTimeout?.(() => {
        if (!shown) cursor.hidden = true;
      }, 250);
    },
    /** Carries a picture as the hand does, « PRISE n » on it; nothing (`picture` null): put down. */
    carry(picture, take = '') {
      cursor.classList.toggle('is-carrying', Boolean(picture));
      if (carried) carried.style.backgroundImage = picture ? `url("${picture}")` : '';
      if (carriedTake) carriedTake.textContent = take;
    },
    get visible() {
      return shown;
    },
  };
}
