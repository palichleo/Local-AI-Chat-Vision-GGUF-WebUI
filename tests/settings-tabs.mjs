import test from 'node:test';
import assert from 'node:assert/strict';
import { setupSettingsTabs } from '../public/settings-tabs.mjs';

function fakeTabs(names, counts = {}) {
  const elements = new Map();
  const listeners = {};
  const tabs = names.map((name, index) => {
    const attributes = { 'aria-selected': String(index === 0), 'aria-controls': 'panel-' + name };
    const badge = { hidden: true, textContent: '' };
    const classes = new Set();
    const tab = {
      dataset: { settingsTab: name },
      tabIndex: index === 0 ? 0 : -1,
      focused: false,
      clicks: [],
      getAttribute: key => attributes[key],
      setAttribute: (key, value) => (attributes[key] = value),
      addEventListener: (event, fn) => tab.clicks.push(fn),
      querySelector: () => badge,
      focus: () => (tab.focused = true),
      classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) },
      classes,
      badge,
    };
    elements.set('panel-' + name, {
      hidden: index !== 0,
      querySelectorAll: () => Array.from({ length: counts[name] ?? 1 }, () => ({ hidden: false })),
    });
    return tab;
  });
  const list = {
    ownerDocument: { getElementById: id => elements.get(id) },
    querySelectorAll: () => tabs,
    addEventListener: (event, fn) => (listeners[event] = fn),
  };
  return { list, tabs, panel: name => elements.get('panel-' + name), keydown: event => listeners.keydown(event) };
}

test('one panel at a time; the tab shown is told, and again when the settings open', () => {
  const ui = fakeTabs(['update', 'llm', 'application']);
  const shown = [];
  const tabs = setupSettingsTabs({ list: ui.list, onShow: name => shown.push(name) });
  assert.equal(tabs.current(), 'update');
  ui.tabs[1].clicks[0]();
  assert.equal(tabs.current(), 'llm');
  assert.equal(ui.panel('update').hidden, true);
  assert.equal(ui.panel('llm').hidden, false);
  assert.equal(ui.tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(ui.tabs[1].tabIndex, 0);
  assert.equal(ui.tabs[0].tabIndex, -1);
  tabs.opened();
  assert.deepEqual(shown, ['llm', 'llm']);
});

test('arrow keys, Home and End move between tabs and take the focus', () => {
  const ui = fakeTabs(['update', 'llm', 'application']);
  const tabs = setupSettingsTabs({ list: ui.list });
  let prevented = 0;
  const key = (target, name) => ui.keydown({ target, key: name, preventDefault: () => prevented++ });
  key(ui.tabs[0], 'ArrowDown');
  assert.equal(tabs.current(), 'llm');
  assert.equal(ui.tabs[1].focused, true);
  key(ui.tabs[1], 'End');
  assert.equal(tabs.current(), 'application');
  key(ui.tabs[2], 'ArrowRight');
  assert.equal(tabs.current(), 'update', 'the last tab wraps to the first');
  key(ui.tabs[0], 'ArrowUp');
  assert.equal(tabs.current(), 'application');
  key(ui.tabs[2], 'Home');
  assert.equal(tabs.current(), 'update');
  key(ui.tabs[0], 'Enter');
  assert.equal(prevented, 5);
});

test('while searching, tabs count their matches and the panel moves to one that has some', () => {
  const ui = fakeTabs(['update', 'llm', 'application'], { update: 0, llm: 2, application: 1 });
  const tabs = setupSettingsTabs({ list: ui.list });
  tabs.matches(true);
  assert.equal(tabs.current(), 'llm');
  assert.equal(ui.tabs[0].badge.hidden, true);
  assert.ok(ui.tabs[0].classes.has('is-empty'));
  assert.equal(ui.tabs[1].badge.hidden, false);
  assert.equal(ui.tabs[1].badge.textContent, '2');
  tabs.matches(false);
  assert.equal(ui.tabs[1].badge.hidden, true);
  assert.ok(!ui.tabs[0].classes.has('is-empty'));
  assert.equal(tabs.current(), 'llm', 'clearing the search keeps the tab');
  tabs.mark('update', true);
  assert.ok(ui.tabs[0].classes.has('has-news'));
});
