const normalized = value =>
  String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
/**
 * A line that is a setting of its own, when a block holds several (capture 49): a field, a
 * workflow, a LLM, a switch, a line. A block without them is one setting.
 */
const UNITS = '.field-group, .workflow-card, .llm-row, .history-toggle, .settings-row, .component-row';
/** The lines of a block that hold no other line. */
function linesOf(item) {
  const all = [...(item.querySelectorAll?.(UNITS) ?? [])].filter(unit => unit?.classList);
  return all.filter(unit => !all.some(other => other !== unit && unit.contains?.(other)));
}
/** What a line says, its fields' values with it (a path is found by its folder). */
const textOf = element =>
  (element.textContent || '') +
  ' ' +
  [...(element.querySelectorAll?.('input:not([type="hidden"]), textarea') ?? [])]
    .map(control => control.value || control.placeholder || '')
    .join(' ');

/**
 * The search of the settings (16/11, capture 49): the settings found in every tab together, each
 * line on its own (not its whole section), under « 2 réglages pour « lora » », the word marked;
 * each tab says how many it holds. A line is hidden by a class of its own (`is-search-hidden`):
 * what the page hides itself stays hidden once the search is cleared.
 * scroller: the part of the settings that scrolls; title: the heading of the results;
 * onRefresh(searching): told after each filtering.
 */
export function setupSettingsSearch({ dialog, input, empty, title = null, scroller = dialog, onRefresh = () => {} }) {
  const opened = new Map(),
    marks = [];
  function restore() {
    for (const [details, open] of opened) details.open = open;
    opened.clear();
  }
  function unmark() {
    for (const mark of marks.splice(0)) {
      const parent = mark.parentNode;
      if (!parent) continue;
      parent.replaceChild(mark.ownerDocument.createTextNode(mark.textContent), mark);
      parent.normalize?.();
    }
  }
  /** The word found, marked in the text of the lines shown (not in their buttons or fields). */
  function mark(elements, terms) {
    const page = dialog.ownerDocument;
    if (!page?.createTreeWalker) return;
    for (const element of elements) {
      const walker = page.createTreeWalker(element, 4),
        nodes = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        if (node.nodeValue.trim() && !node.parentElement?.closest('button, select, textarea, svg, .help-tip, mark')) nodes.push(node);
      for (const node of nodes) {
        const text = node.nodeValue,
          // The place in the text of each letter once its accents are gone.
          places = [],
          letters = [...text].map((letter, index) => {
            const plain = normalized(letter);
            for (let count = 0; count < plain.length; count++) places.push(index);
            return plain;
          }),
          flat = letters.join(''),
          ranges = [];
        for (const term of terms)
          for (let at = flat.indexOf(term); at >= 0; at = flat.indexOf(term, at + term.length))
            ranges.push([places[at], places[at + term.length - 1] + 1]);
        if (!ranges.length) continue;
        ranges.sort((a, b) => a[0] - b[0]);
        const pieces = [];
        let last = 0;
        for (const [start, end] of ranges) {
          if (start < last) continue;
          if (start > last) pieces.push(page.createTextNode(text.slice(last, start)));
          const hit = page.createElement('mark');
          hit.className = 'settings-hit';
          hit.textContent = text.slice(start, end);
          marks.push(hit);
          pieces.push(hit);
          last = end;
        }
        if (last < text.length) pieces.push(page.createTextNode(text.slice(last)));
        node.replaceWith(...pieces);
      }
    }
  }
  function refresh() {
    restore();
    unmark();
    const query = String(input.value || '').trim(),
      terms = normalized(query).split(/\s+/).filter(Boolean),
      hits = new Map();
    let count = 0;
    for (const item of dialog.querySelectorAll('[data-settings-item]')) {
      const section = item.closest('[data-settings-section]'),
        panel = item.closest?.('[data-settings-panel]'),
        lines = linesOf(item);
      for (const line of lines) line.classList.remove('is-search-hidden');
      if (!terms.length) {
        item.hidden = false;
        continue;
      }
      const found = lines.filter(line => terms.every(term => normalized(textOf(line)).includes(term)));
      let shown = [];
      if (found.length) {
        for (const line of lines) line.classList.toggle('is-search-hidden', !found.includes(line));
        shown = found;
      } else if (
        terms.every(term =>
          normalized((section?.dataset.settingsSection || '') + ' ' + (item.dataset.settingsKeywords || '') + ' ' + textOf(item)).includes(term),
        )
      )
        // Found by its section or its key words: the block whole, as one setting.
        shown = [item];
      item.hidden = !shown.length;
      if (!shown.length) continue;
      count += shown.length;
      if (panel) hits.set(panel, (hits.get(panel) ?? 0) + shown.length);
      for (const details of item.querySelectorAll('details')) {
        if (!opened.has(details)) {
          opened.set(details, details.open);
          details.open = true;
        }
      }
      mark(shown, terms);
    }
    for (const section of dialog.querySelectorAll('[data-settings-section]'))
      section.hidden = ![...section.querySelectorAll('[data-settings-item]')].some(item => !item.hidden);
    // How many each tab holds (settings-tabs.mjs reads it), and the heading of all of them.
    for (const panel of dialog.querySelectorAll?.('[data-settings-panel]') ?? [])
      if (panel.dataset) panel.dataset.settingsHits = terms.length ? String(hits.get(panel) ?? 0) : '';
    if (title) {
      title.textContent = count ? `${count} ${count > 1 ? 'réglages' : 'réglage'} pour « ${query} »` : '';
      title.hidden = !terms.length || !count;
    }
    dialog.classList?.toggle('is-searching', terms.length > 0);
    empty.hidden = count > 0 || !terms.length;
    scroller.scrollTop = 0;
    onRefresh(terms.length > 0);
  }
  function reset() {
    input.value = '';
    refresh();
  }
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape' && input.value) {
      event.preventDefault();
      event.stopPropagation();
      reset();
    }
  });
  return { refresh, reset };
}
