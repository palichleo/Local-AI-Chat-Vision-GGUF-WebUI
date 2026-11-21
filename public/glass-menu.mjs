/**
 * Menus of the page (16/11). A menu is never cut by the panel it opens from: shown in the top layer
 * (a popover), placed against its opener on the side that has room, kept inside the window.
 * - `openPopup(menu, anchor)` / `closePopup(menu)`: any menu (the formats of the Studio).
 * - `setupGlassSelects(root)`: every list of the system (`<select>`) becomes a button and a menu of
 *   the same dark glass: the choices from top to bottom, the chosen one marked, one that cannot be
 *   chosen greyed with its reason under the pointer; arrows, Entrée and Échap on the keyboard. The
 *   `<select>` stays in the page, unseen: its value, its `change` and its options are still the truth.
 *   What the page says of a choice (`data-note` on its option: « proposé ») is shown beside its name;
 *   the tip of the list follows to the button whenever it is set; given the focus, the list passes
 *   it on to its button.
 */
const MARGIN = 8,
  GAP = 6;

/** Opens `menu` against `anchor`: under it, above when there is no room below; its right edges on it. */
export function openPopup(menu, anchor, { view = globalThis, align = 'end' } = {}) {
  menu.hidden = false;
  if (typeof menu.showPopover !== 'function' || !anchor?.getBoundingClientRect) return;
  try {
    if (!menu.hasAttribute('popover')) menu.setAttribute('popover', 'manual');
    if (!menu.matches(':popover-open')) menu.showPopover();
  } catch {
    // Not in the page any more (drawn again meanwhile): nothing to show.
    return;
  }
  Object.assign(menu.style, { position: 'fixed', inset: 'auto', margin: '0' });
  const box = anchor.getBoundingClientRect(),
    size = menu.getBoundingClientRect(),
    width = view.innerWidth ?? 1280,
    height = view.innerHeight ?? 800,
    below = box.bottom + GAP + size.height <= height - MARGIN,
    above = box.top - GAP - size.height >= MARGIN,
    top = below || !above ? box.bottom + GAP : box.top - GAP - size.height,
    left = align === 'start' ? box.left : box.right - size.width;
  menu.style.left = Math.round(Math.max(MARGIN, Math.min(left, width - size.width - MARGIN))) + 'px';
  menu.style.top = Math.round(Math.max(MARGIN, Math.min(top, height - size.height - MARGIN))) + 'px';
  menu.dataset.side = below || !above ? 'below' : 'above';
}
export function closePopup(menu) {
  try {
    if (menu.matches?.(':popover-open')) menu.hidePopover();
  } catch {
    // Already out of the top layer.
  }
  menu.hidden = true;
}

/** One `<select>` shown as a button and a menu of glass. */
function enhance(select, view) {
  if (select.dataset.glass || select.hidden || select.multiple || select.size > 1) return;
  const page = select.ownerDocument;
  select.dataset.glass = 'true';
  const face = page.createElement('button'),
    text = page.createElement('span'),
    menu = page.createElement('div');
  face.type = 'button';
  // Its classes are the list's own (not the one that hides the list), with its own.
  const dress = () =>
    (face.className = (select.className.replace(/\bglass-select-native\b/, '') + ' glass-select').replace(/\s+/g, ' ').trim());
  dress();
  face.setAttribute('aria-haspopup', 'listbox');
  face.setAttribute('aria-expanded', 'false');
  text.className = 'glass-select-text';
  face.append(text);
  menu.className = 'glass-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  // Its name, its tip and what the pointer of Moodix AI aims at go to the button: the list is unseen.
  const label = select.getAttribute('aria-label') || (select.id && page.querySelector(`label[for="${select.id}"]`)?.textContent) || '';
  if (label) face.setAttribute('aria-label', label.trim());
  // Its tip, now and whenever the page sets it again (the name of a LoRA follows its list in the
  // Studio): a title, or the tip the bubble of the page made of it (help-tips.mjs). Left on the
  // unseen list, nothing showed it, and the button kept the tip of before.
  const carryTip = () => {
    const tip = select.getAttribute('title') || select.dataset.tip;
    if (!tip) return;
    face.dataset.tip = tip;
    select.removeAttribute('title');
    delete select.dataset.tip;
  };
  for (const name of [...select.getAttributeNames()].filter(name => name.startsWith('data-ai'))) {
    face.setAttribute(name, select.getAttribute(name));
    select.removeAttribute(name);
  }
  select.classList.add('glass-select-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  select.after(face, menu);

  const sync = () => {
    const chosen = select.selectedOptions?.[0] ?? select.options[select.selectedIndex];
    // (0.6.148) What the face shows of the one chosen, when it says it shorter (« 16:9  1344 × 768 »).
    text.textContent = chosen?.dataset?.face ?? chosen?.textContent ?? '';
    face.disabled = select.disabled;
    // Its classes are the list's, as they change (a value changed in a proposal turns to the accent).
    dress();
    carryTip();
    if (label) face.setAttribute('aria-label', label.trim() + ' : ' + text.textContent);
  };
  const items = () => [...menu.querySelectorAll('[role="option"]:not([aria-disabled="true"])')];
  const beside = event => {
    if (!menu.contains(event.target) && !face.contains(event.target)) close();
  };
  function close({ refocus = false } = {}) {
    if (menu.hidden) return;
    closePopup(menu);
    menu.replaceChildren();
    face.setAttribute('aria-expanded', 'false');
    page.removeEventListener('pointerdown', beside, true);
    if (refocus) face.focus();
  }
  function choose(option) {
    if (option.disabled) return;
    if (select.value !== option.value) {
      select.value = option.value;
      select.dispatchEvent(new view.Event('change', { bubbles: true }));
    }
    sync();
    // The button takes the focus back only if it is still in the menu: what `change` did may have
    // put it elsewhere (the question a choice opens, « Changer de moteur… », its first answer in hand).
    close({ refocus: menu.contains(page.activeElement) });
  }
  function open() {
    if (!menu.hidden || select.disabled) return;
    menu.replaceChildren(
      ...[...select.options].map(option => {
        const item = page.createElement('button');
        item.type = 'button';
        item.className = 'glass-menu-item' + (option.selected ? ' is-chosen' : '') + (option.disabled ? ' is-off' : '');
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(option.selected));
        item.textContent = option.textContent;
        // What the page says of this choice (`data-note`: « proposé » in a card, the one Moodix
        // proposed), after its name and quieter; a screen reader says it with the name.
        const note = option.dataset.note;
        if (note) {
          const said = page.createElement('span');
          said.className = 'glass-menu-note';
          said.textContent = note;
          item.append(said);
          item.setAttribute('aria-label', option.textContent + ', ' + note);
        }
        if (option.disabled) item.setAttribute('aria-disabled', 'true');
        // Why it cannot be chosen, under the pointer: (0.6.189) at the right of the list, where it can
        // be read; over the list, the bubble of the page was under it (help-tips.mjs).
        const reason = option.getAttribute('title') || option.dataset.tip;
        if (reason) {
          item.dataset.tip = reason;
          item.dataset.tipSide = 'right';
        }
        item.onclick = () => choose(option);
        return item;
      }),
    );
    menu.style.minWidth = Math.round(face.getBoundingClientRect().width) + 'px';
    openPopup(menu, face, { view, align: 'start' });
    face.setAttribute('aria-expanded', 'true');
    page.addEventListener('pointerdown', beside, true);
    (menu.querySelector('.is-chosen:not(.is-off)') ?? items()[0])?.focus();
  }
  face.onclick = () => (menu.hidden ? open() : close());
  face.onkeydown = event => {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      open();
    }
  };
  menu.onkeydown = event => {
    const list = items(),
      at = list.indexOf(page.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close({ refocus: true });
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      list[(at + (event.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      // Entrée chooses the one in hand (said here: not left to what the browser does of a key on a button).
      event.preventDefault();
      if (at >= 0) list[at].click();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      list.at(event.key === 'Home' ? 0 : -1)?.focus();
    } else if (event.key === 'Tab') close();
  };
  // Its value set by the page (another choice restored, a form filled again) is shown too.
  for (const name of ['value', 'selectedIndex']) {
    const own = Object.getOwnPropertyDescriptor(view.HTMLSelectElement.prototype, name);
    if (!own?.set) continue;
    Object.defineProperty(select, name, {
      configurable: true,
      get() {
        return own.get.call(this);
      },
      set(next) {
        own.set.call(this, next);
        sync();
      },
    });
  }
  select.addEventListener('change', sync);
  // Unseen, the list can still be given the focus (a click on its label, `focus()` from the page):
  // it passes it on to its button. Kept, it left no focus to see, and the keys changed the list
  // without its menu.
  select.addEventListener('focus', () => face.focus());
  new view.MutationObserver(sync).observe(select, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled', 'class', 'title', 'data-tip'],
  });
  sync();
}

/** Every `<select>` of `root` shown (not the hidden ones, kept for their value), now and as they come. */
export function setupGlassSelects(root) {
  const page = root.ownerDocument ?? root,
    view = page.defaultView ?? globalThis;
  if (typeof view.MutationObserver !== 'function' || !view.HTMLSelectElement) return;
  const all = element => {
    if (element.matches?.('select')) enhance(element, view);
    for (const select of element.querySelectorAll?.('select') ?? []) enhance(select, view);
  };
  all(root);
  new view.MutationObserver(records => {
    for (const record of records) for (const added of record.addedNodes) if (added.nodeType === 1) all(added);
  }).observe(root, { subtree: true, childList: true });
}
