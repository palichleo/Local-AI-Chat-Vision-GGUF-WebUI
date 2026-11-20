/**
 * The one tooltip of the page (0.5.120). The help of a « ? » (`data-help`) and the name of a
 * control (`data-tip`, and every `title`, turned into one so that the browser shows none of its
 * own, a second late and in another style) in one bubble, one style, one delay: under the pointer
 * after 150 ms (16/11: half of what it was), at once on the keyboard's focus. The bubble is fixed to
 * the window, so a scrolling area never cuts it; it goes into an open dialog when the control is in
 * one (a dialog lies above the page). Every bubble is centred on its control, 8 px above it, under
 * it when there is no room above, and stays inside the window. (0.6.155) `data-tip-side="left"`: at its
 * left, at its height, when there is room there (a choice of a menu: above it, it hid what is above).
 */
export function setupHelpTips(root, { id = 'help-bubble', host = root, delay = 150 } = {}) {
  const page = root.ownerDocument ?? root,
    view = page.defaultView ?? globalThis;
  const bubble = page.createElement('div');
  bubble.className = 'help-bubble';
  bubble.setAttribute('role', 'tooltip');
  bubble.id = id;
  bubble.hidden = true;
  host.append(bubble);
  let current = null,
    timer = 0;

  /** A title becomes a tip of ours; an icon alone it named keeps that name for screen readers. */
  function adopt(element) {
    if (!element?.hasAttribute?.('title')) return;
    const text = element.getAttribute('title');
    element.removeAttribute('title');
    if (!text) return;
    element.dataset.tip = text;
    if (!element.hasAttribute('aria-label') && !element.hasAttribute('aria-labelledby') && !element.textContent?.trim())
      element.setAttribute('aria-label', text);
  }
  const adoptAll = element => {
    adopt(element);
    for (const inner of element.querySelectorAll?.('[title]') ?? []) adopt(inner);
  };
  adoptAll(root);
  if (typeof view.MutationObserver === 'function')
    new view.MutationObserver(records => {
      for (const record of records)
        if (record.type === 'attributes') adopt(record.target);
        else for (const added of record.addedNodes) if (added.nodeType === 1) adoptAll(added);
    }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });

  /** What the bubble says for `target`: its help, or its name where it does not show it itself. */
  function textOf(target) {
    if (target.dataset.help) return target.dataset.help;
    return target.dataset.tip || '';
  }
  function place(target) {
    const set = (x, y) => {
      bubble.style.left = x + 'px';
      bubble.style.top = y + 'px';
    };
    // Measured where nothing narrows it: left where it last stood, near an edge, it wrapped into a
    // tall column, and was then placed far from its control.
    set(0, 0);
    const box = target.getBoundingClientRect(),
      size = bubble.getBoundingClientRect(),
      margin = 8,
      width = view.innerWidth ?? 1280,
      height = view.innerHeight ?? 800;
    let top = box.top - size.height - 8,
      left = box.left + box.width / 2 - size.width / 2;
    if (top < margin) top = box.bottom + 8;
    if (target.dataset.tipSide === 'left' && box.left - size.width - 8 >= margin) {
      left = box.left - size.width - 8;
      top = box.top + box.height / 2 - size.height / 2;
    }
    left = Math.round(Math.max(margin, Math.min(left, width - size.width - margin)));
    top = Math.round(Math.max(margin, Math.min(top, height - size.height - margin)));
    set(left, top);
    // In a window of glass (the settings), « fixed » is counted from that window, not from the
    // screen: the bubble landed far from its control. Where it really is says by how much.
    const real = bubble.getBoundingClientRect();
    if (Math.abs(real.left - left) > 0.5 || Math.abs(real.top - top) > 0.5)
      set(left - (real.left - left), top - (real.top - top));
  }
  function show(target) {
    clearTimeout(timer);
    const text = textOf(target);
    if (!text || !target.isConnected) return hide();
    const layer = target.closest?.('dialog[open]') ?? host;
    if (bubble.parentNode !== layer) layer.append(bubble);
    if (current !== target) current?.removeAttribute?.('aria-describedby');
    current = target;
    bubble.textContent = text;
    bubble.dataset.tone = target.dataset.helpTone || '';
    bubble.dataset.kind = target.dataset.help ? 'help' : 'tip';
    bubble.hidden = false;
    place(target);
    // A description for screen readers, unless it is the name they read already.
    if (target.dataset.help || text !== target.getAttribute('aria-label')) target.setAttribute('aria-describedby', id);
  }
  function hide() {
    clearTimeout(timer);
    current?.removeAttribute?.('aria-describedby');
    current = null;
    bubble.hidden = true;
  }
  const targetOf = node => node?.closest?.('[data-help], [data-tip]') ?? null;
  root.addEventListener('pointerover', event => {
    const target = targetOf(event.target);
    if (!target || target === current) return;
    clearTimeout(timer);
    timer = setTimeout(() => show(target), delay);
  });
  root.addEventListener('pointerout', event => {
    const target = targetOf(event.target);
    if (target?.contains?.(event.relatedTarget)) return;
    clearTimeout(timer);
    if (current && !current.contains(event.relatedTarget)) hide();
  });
  root.addEventListener('focusin', event => {
    const target = targetOf(event.target);
    // At once when the keyboard brings the focus (a click focuses too: the pointer's delay then).
    if (target && (event.target.matches?.(':focus-visible') ?? true)) show(target);
  });
  root.addEventListener('focusout', () => hide());
  root.addEventListener('pointerdown', () => hide(), true);
  // The text may change while it is shown (a download in progress); a scroll moves its anchor.
  root.addEventListener('scroll', hide, true);
  page.addEventListener?.(
    'keydown',
    event => {
      if (event.key === 'Escape' && current) hide();
    },
    true,
  );
  return {
    hide,
    /** Shows again the help of an element whose text has just changed, if it is the one shown. */
    refresh(target) {
      if (target === current && textOf(target)) show(target);
    },
  };
}
