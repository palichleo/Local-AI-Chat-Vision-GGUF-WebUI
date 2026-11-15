/**
 * The one tooltip of the page (0.5.120). The help of a « ? » (`data-help`) and the name of a
 * control (`data-tip`, and every `title`, turned into one so that the browser shows none of its
 * own, a second late and in another style) in one bubble, one style, one delay: under the pointer
 * after 300 ms, at once on the keyboard's focus. The bubble is fixed to the window, so a scrolling
 * area never cuts it; it goes into an open dialog when the control is in one (a dialog lies above
 * the page). In the folded sidebar it stands at the right of the icon; elsewhere under the
 * control (right edges aligned for a « ? », `data-help-align="start"` for its left edges), above
 * it when the window has no room below.
 */
export function setupHelpTips(root, { id = 'help-bubble', host = root, delay = 300 } = {}) {
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

  const folded = () =>
    page.documentElement?.dataset.sidebar === 'collapsed' && (view.matchMedia?.('(min-width: 1100px)').matches ?? true);
  /** What the bubble says for `target`: its help, or its name where it does not show it itself. */
  function textOf(target) {
    if (target.dataset.help) return target.dataset.help;
    // A line of the sidebar says its name itself, but folded to its icon.
    if (target.closest?.('#sidebar') && target.matches?.('.home-button, .new-chat') && !folded()) return '';
    return target.dataset.tip || '';
  }
  function place(target) {
    const box = target.getBoundingClientRect(),
      size = bubble.getBoundingClientRect(),
      margin = 8,
      width = view.innerWidth ?? 1280,
      height = view.innerHeight ?? 800;
    let left, top;
    if (target.closest?.('#sidebar') && folded()) {
      left = box.right + 10;
      top = box.top + box.height / 2 - size.height / 2;
    } else {
      left = target.dataset.help
        ? target.dataset.helpAlign === 'start'
          ? box.left
          : box.right - size.width
        : box.left + box.width / 2 - size.width / 2;
      top = box.bottom + 6;
      if (top + size.height > height - margin) top = box.top - size.height - 6;
    }
    bubble.style.left = Math.round(Math.max(margin, Math.min(left, width - size.width - margin))) + 'px';
    bubble.style.top = Math.round(Math.max(margin, Math.min(top, height - size.height - margin))) + 'px';
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
