/**
 * Help shown at once, under the pointer: any element with `data-help` (the « ? » of a block, the
 * state of a workflow) shows its text in one bubble as soon as it is hovered or focused, with
 * none of the delay of a `title`. The bubble is fixed to the window, so a scrolling area never
 * cuts it; it hides when the pointer or the focus leaves.
 */
export function setupHelpTips(root) {
  const bubble = root.ownerDocument.createElement('div');
  bubble.className = 'help-bubble';
  bubble.setAttribute('role', 'tooltip');
  bubble.id = 'help-bubble';
  bubble.hidden = true;
  root.append(bubble);
  let current = null;

  function show(target) {
    current = target;
    bubble.textContent = target.dataset.help;
    bubble.dataset.tone = target.dataset.helpTone || '';
    bubble.hidden = false;
    const view = root.ownerDocument.defaultView;
    const place = target.getBoundingClientRect(),
      size = bubble.getBoundingClientRect(),
      margin = 8;
    // Under the « ? », its right edges aligned (its left edges for what sits on the left of a
    // card, `data-help-align="start"`); above it when the window has no room below.
    let left =
      target.dataset.helpAlign === 'start' ? place.left : Math.min(place.right, view.innerWidth - margin) - size.width;
    left = Math.max(margin, Math.min(left, view.innerWidth - size.width - margin));
    let top = place.bottom + 6;
    if (top + size.height > view.innerHeight - margin) top = Math.max(margin, place.top - size.height - 6);
    bubble.style.left = Math.round(left) + 'px';
    bubble.style.top = Math.round(top) + 'px';
  }
  function hide() {
    current = null;
    bubble.hidden = true;
  }
  const helpOf = event => event.target.closest?.('[data-help]');
  root.addEventListener('pointerover', event => {
    const target = helpOf(event);
    if (target && target !== current && target.dataset.help) show(target);
  });
  root.addEventListener('pointerout', event => {
    if (current && !current.contains(event.relatedTarget)) hide();
  });
  root.addEventListener('focusin', event => {
    const target = helpOf(event);
    if (target?.dataset.help) show(target);
  });
  root.addEventListener('focusout', hide);
  // The text may change while it is shown (a download in progress); a scroll moves its anchor.
  root.addEventListener('scroll', hide, true);
  return {
    hide,
    /** Shows again the help of an element whose text has just changed, if it is the one shown. */
    refresh(target) {
      if (target === current && target.dataset.help) show(target);
    },
  };
}
