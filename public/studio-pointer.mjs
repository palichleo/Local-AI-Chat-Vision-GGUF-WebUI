/**
 * The pointer of Moodix AI: a white arrow in a soft halo, with a label of what it does
 * (« Moodix AI · règle la durée »). It glides from one setting to the next (0.45 s), and
 * leaves a clear ring on the setting it changes, then a fine trace once it is set. Nothing
 * blinks; with `prefers-reduced-motion` it does not glide, it appears where it goes.
 */
export function setupPointer({ cursor, text, host = globalThis }) {
  const reduced = () => Boolean(host.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  let shown = false;
  function place(element, { ax = null, ay = null } = {}) {
    const box = element.getBoundingClientRect?.();
    if (!box) return false;
    const x = box.left + (ax ?? box.width / 2),
      y = box.top + (ay ?? box.height / 2);
    cursor.style.setProperty('--ai-x', Math.round(x) + 'px');
    cursor.style.setProperty('--ai-y', Math.round(y) + 'px');
    // Near the right edge, its label goes to the left of it: never out of the window.
    cursor.classList.toggle('is-left', x > (host.innerWidth ?? Infinity) - 280);
    return true;
  }
  return {
    reduced,
    /** Goes to `element` and says what it does there. */
    move(element, label, anchor) {
      if (!element) return;
      element.scrollIntoView?.({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
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
      text.textContent = label || '';
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
    get visible() {
      return shown;
    },
  };
}
