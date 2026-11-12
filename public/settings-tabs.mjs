/**
 * The tabs of the settings, in a column on the left (a row on narrow screens). One panel shows
 * at a time; the one last shown is shown again when the settings open. While a search is typed,
 * each tab says how many settings match, and the panel shown moves to a tab that has some.
 */
export function setupSettingsTabs({ list, onShow = () => {} }) {
  const tabs = [...list.querySelectorAll('[role="tab"]')];
  const panelOf = tab => list.ownerDocument.getElementById(tab.getAttribute('aria-controls'));
  let current = tabs.find(tab => tab.getAttribute('aria-selected') === 'true') || tabs[0];

  function select(name, { focus = false } = {}) {
    const next = tabs.find(tab => tab.dataset.settingsTab === name);
    if (!next) return;
    current = next;
    for (const tab of tabs) {
      const selected = tab === next;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panelOf(tab).hidden = !selected;
    }
    if (focus) next.focus();
    onShow(name);
  }

  /** Counts on the tabs while searching; none otherwise. */
  function matches(searching) {
    const counts = new Map(
      tabs.map(tab => [
        tab,
        [...panelOf(tab).querySelectorAll('[data-settings-item]')].filter(item => !item.hidden).length,
      ]),
    );
    for (const [tab, count] of counts) {
      const badge = tab.querySelector('.settings-tab-count');
      badge.hidden = !searching || !count;
      badge.textContent = String(count);
      tab.classList.toggle('is-empty', searching && !count);
    }
    if (searching && !counts.get(current)) {
      const found = tabs.find(tab => counts.get(tab) > 0);
      if (found) select(found.dataset.settingsTab);
    }
  }

  /** A dot on a tab that asks to be looked at (an update ready to install). */
  function mark(name, flag) {
    tabs.find(tab => tab.dataset.settingsTab === name)?.classList.toggle('has-news', !!flag);
  }

  for (const tab of tabs) tab.addEventListener('click', () => select(tab.dataset.settingsTab));
  list.addEventListener('keydown', event => {
    const index = tabs.indexOf(event.target);
    if (index < 0) return;
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    const target =
      event.key === 'Home'
        ? tabs[0]
        : event.key === 'End'
          ? tabs.at(-1)
          : step
            ? tabs[(index + step + tabs.length) % tabs.length]
            : null;
    if (!target) return;
    event.preventDefault();
    select(target.dataset.settingsTab, { focus: true });
  });

  return {
    select,
    matches,
    mark,
    current: () => current?.dataset.settingsTab || '',
    /** The settings were opened: the tab shown is reported as shown again. */
    opened: () => onShow(current?.dataset.settingsTab || ''),
  };
}
