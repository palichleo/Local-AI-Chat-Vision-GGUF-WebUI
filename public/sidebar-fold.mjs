/**
 * The sidebar folds to its icons (64 px) and unfolds (232 px), from the button beside the logo
 * (the small logo when folded) or Ctrl+B (⌘+B on a Mac). The state is kept in localStorage
 * (`moodix.sidebar`) and read again before the first paint (public/sidebar-state.js). Under
 * 1100 px nothing changes: the drawer, always unfolded (moodix.css ignores the state there).
 */
export const KEY = 'moodix.sidebar';
export const WIDE = 1100;

/** Whether a key pressed there belongs to a field (text typed, a choice made). */
export function typing(target) {
  if (!target || typeof target !== 'object') return false;
  if (target.isContentEditable) return true;
  const tag = String(target.tagName || '').toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag !== 'input') return false;
  return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset'].includes(
    String(target.type || 'text').toLowerCase(),
  );
}

export function setupSidebarFold({ root, toggle, sidebar, page, view = globalThis, storage, mac = false }) {
  if (!root || !toggle) return { folded: () => false, flip: () => {} };
  const keys = (mac ? '⌘' : 'Ctrl') + '+B';
  const folded = () => root.dataset.sidebar === 'collapsed';
  // Folded, each icon says its name at its right at once: the browser's own tooltip, which would
  // come a second later under the pointer, is put aside (a title set meanwhile too, the engine's).
  const hush = element => {
    if (!element?.hasAttribute?.('title')) return;
    element.dataset.title = element.getAttribute('title');
    element.removeAttribute('title');
  };
  function apply(collapsed) {
    root.dataset.sidebar = collapsed ? 'collapsed' : 'expanded';
    const label = collapsed ? 'Déplier la barre' : 'Replier la barre';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', label);
    toggle.dataset.tip = `${label} (${keys})`;
    for (const element of sidebar?.querySelectorAll?.(collapsed ? '[title]' : '[data-title]') ?? []) {
      if (collapsed) hush(element);
      else {
        element.setAttribute('title', element.dataset.title);
        delete element.dataset.title;
      }
    }
  }
  function flip() {
    const collapsed = !folded(),
      focused = page?.activeElement;
    apply(collapsed);
    try {
      storage?.setItem(KEY, collapsed ? 'collapsed' : 'expanded');
    } catch {
      // Not kept: the next page comes up unfolded.
    }
    // What had the focus is gone with the words (a conversation, « Nouveau projet »): it goes to
    // the button, never to the page.
    if (collapsed && focused?.closest?.('#history-section, .project-nav-heading, .brand')) toggle.focus?.();
  }
  apply(folded());
  if (sidebar && typeof view.MutationObserver === 'function') {
    new view.MutationObserver(records => {
      if (!folded()) return;
      for (const record of records) {
        hush(record.target);
        for (const added of record.addedNodes ?? []) {
          hush(added);
          for (const inner of added.querySelectorAll?.('[title]') ?? []) hush(inner);
        }
      }
    }).observe(sidebar, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
  }
  // The same button in both states: the focus stays on it.
  toggle.onclick = () => flip();
  page?.addEventListener?.('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    if (String(event.key).toLowerCase() !== 'b' || event.repeat) return;
    // Not in a field, not under a window opened over the page, not where the sidebar is a drawer.
    if (typing(event.target) || page.querySelector?.('dialog[open]') || (view.innerWidth ?? WIDE) < WIDE) return;
    event.preventDefault();
    flip();
  });
  return { folded, flip };
}
