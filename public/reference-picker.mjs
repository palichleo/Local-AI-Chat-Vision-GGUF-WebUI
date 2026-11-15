/**
 * The references of a project at hand in the chat (0.5.114).
 * - « # » in the message box opens the list of the project's references above it, with their
 *   pictures; typing narrows it (« #ref1 » keeps #ref1, #ref10…); ↑ ↓ choose, Entrée or Tab writes
 *   « #refN », Échap closes. Only where « # » starts a word, and only if the project has some.
 * - « #refN » in a message is marked; under the pointer or the keyboard's focus, its picture.
 * - References removed for room (the least used, lib/resources.mjs) are said in a notice.
 */
const TYPED = /(?:^|\s)(#(?:r(?:e(?:f(\d{0,4})?)?)?)?)$/i;
const TOKEN = /#ref(\d{1,4})(?!\d)/gi;
const SKIP = new Set(['CODE', 'PRE', 'A', 'BUTTON', 'TEXTAREA', 'SCRIPT', 'STYLE']);

/** The « # » being typed just before `caret`: where it starts and the digits after « #ref ». */
export function referenceAt(text, caret = String(text).length) {
  const match = String(text).slice(0, caret).match(TYPED);
  return match ? { start: caret - match[1].length, digits: match[2] ?? '' } : null;
}

/** The references `typed` keeps: their number starts with its digits. */
export function narrowed(references, typed) {
  return typed ? references.filter(item => String(item.reference).startsWith(typed.digits)) : [];
}

/** What the user reads when references were removed for room. */
export function removedNotice(items) {
  if (!Array.isArray(items) || !items.length) return '';
  const named = items.map(item => `${item.label} (${item.name})`).join(', ');
  return items.length === 1
    ? `Référence peu utilisée effacée pour faire de la place : ${named}.`
    : `Références peu utilisées effacées pour faire de la place : ${named}.`;
}

export function setupReferencePicker({ input, host, node, references, onPick }) {
  const list = node('div', 'ref-picker');
  list.id = 'ref-picker';
  list.hidden = true;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Références du projet');
  host.append(list);
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');
  let shown = [],
    active = 0,
    typed = null;
  const isOpen = () => !list.hidden;
  function close() {
    list.hidden = true;
    shown = [];
    typed = null;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
  function choose(item) {
    const at = typed;
    close();
    if (at && item) onPick(item, at);
  }
  function paint() {
    list.replaceChildren(
      ...shown.map((item, index) => {
        const option = node('div', 'ref-picker-item' + (index === active ? ' is-active' : ''));
        option.id = 'ref-option-' + item.reference;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(index === active));
        const picture = node('span', 'ref-picker-picture');
        if (item.previewUrl) {
          const image = node('img');
          image.src = item.previewUrl;
          image.alt = '';
          image.loading = 'lazy';
          picture.append(image);
        }
        const words = node('span', 'ref-picker-words');
        words.append(
          node('strong', '', item.label),
          node('span', '', (String(item.mime || '').startsWith('video/') ? 'Vidéo · ' : '') + item.name),
        );
        option.append(picture, words);
        // Chosen without the box losing its focus, nor its caret.
        option.onmousedown = event => {
          event.preventDefault();
          choose(item);
        };
        return option;
      }),
    );
    input.setAttribute('aria-activedescendant', 'ref-option-' + shown[active].reference);
    list.children?.[active]?.scrollIntoView?.({ block: 'nearest' });
  }
  function update() {
    typed = referenceAt(input.value, input.selectionStart ?? input.value.length);
    shown = narrowed(typed ? references() : [], typed);
    if (!shown.length) return close();
    active = Math.min(active, shown.length - 1);
    paint();
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }
  input.addEventListener('input', () => {
    active = 0;
    update();
  });
  // The caret moved without typing (a click, ← →): the list follows it, or closes.
  input.addEventListener('click', update);
  input.addEventListener('keyup', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) update();
  });
  input.addEventListener('blur', close);
  // Before the box's own keys (Entrée sends the message): while the list is open, they are its.
  input.addEventListener(
    'keydown',
    event => {
      if (!isOpen() || event.isComposing) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        active = (active + (event.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
        paint();
      } else if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault();
        event.stopImmediatePropagation();
        choose(shown[active]);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    },
    true,
  );
  return { close, update, isOpen };
}

/** Wraps each « #refN » written in `root` (outside code, links and buttons) in a mark. */
export function markReferences(root, node) {
  const texts = [];
  const walk = element => {
    for (const child of [...(element.childNodes ?? [])]) {
      if (child.nodeType === 3) {
        if (/#ref\d/i.test(child.data)) texts.push(child);
      } else if (child.nodeType === 1 && !SKIP.has(child.tagName) && !child.classList?.contains('ref-token')) walk(child);
    }
  };
  walk(root);
  for (const text of texts) {
    const parts = [];
    let at = 0;
    for (const match of text.data.matchAll(TOKEN)) {
      if (match.index > at) parts.push(text.data.slice(at, match.index));
      const mark = node('span', 'ref-token', match[0]);
      mark.dataset.ref = String(Number(match[1]));
      mark.tabIndex = 0;
      parts.push(mark);
      at = match.index + match[0].length;
    }
    if (!parts.length) continue;
    if (at < text.data.length) parts.push(text.data.slice(at));
    text.replaceWith(...parts);
  }
  return root;
}

/** Under the pointer or the keyboard's focus, a « #refN » of a message shows its picture. */
export function setupReferencePeek({ root, page, node, lookup }) {
  const peek = node('div', 'ref-peek');
  peek.id = 'ref-peek';
  peek.hidden = true;
  peek.setAttribute('role', 'tooltip');
  page.body.append(peek);
  let current = null;
  function hide() {
    current?.removeAttribute('aria-describedby');
    current = null;
    peek.hidden = true;
  }
  function show(token) {
    const number = Number(token.dataset.ref),
      item = lookup(number),
      parts = [];
    if (item?.previewUrl) {
      const image = node('img');
      image.src = item.previewUrl;
      image.alt = '';
      parts.push(image);
    }
    parts.push(
      node('span', 'ref-peek-caption', item ? `${item.label} · ${item.name}` : `#ref${number} · introuvable dans ce projet`),
    );
    peek.replaceChildren(...parts);
    peek.hidden = false;
    const box = token.getBoundingClientRect(),
      above = box.top > 200;
    // Above the mark, or under it when it is near the top of the window.
    Object.assign(peek.style, {
      left: Math.max(8, Math.min(box.left, (page.documentElement?.clientWidth ?? 1280) - 228)) + 'px',
      top: (above ? box.top - 8 : box.bottom + 8) + 'px',
      transform: above ? 'translateY(-100%)' : 'none',
    });
    current?.removeAttribute('aria-describedby');
    token.setAttribute('aria-describedby', peek.id);
    current = token;
  }
  const tokenOf = target => target?.closest?.('.ref-token') ?? null;
  root.addEventListener('mouseover', event => {
    const token = tokenOf(event.target);
    if (token && token !== current) show(token);
  });
  root.addEventListener('mouseout', event => {
    if (tokenOf(event.target) && !tokenOf(event.relatedTarget)) hide();
  });
  root.addEventListener('focusin', event => {
    const token = tokenOf(event.target);
    if (token) show(token);
  });
  root.addEventListener('focusout', event => {
    if (tokenOf(event.target)) hide();
  });
  // Laid in the window's coordinates: whatever scrolls takes it away.
  page.addEventListener('scroll', hide, true);
  return { hide };
}
