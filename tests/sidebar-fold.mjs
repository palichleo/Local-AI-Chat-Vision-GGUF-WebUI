import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { KEY, setupSidebarFold, typing } from '../public/sidebar-fold.mjs';

const read = name => readFile(new URL('../public/' + name, import.meta.url), 'utf8');

function element(attributes = {}, extra = {}) {
  const attrs = { ...attributes };
  return {
    dataset: {},
    focused: 0,
    hasAttribute: name => name in attrs,
    getAttribute: name => (name in attrs ? attrs[name] : null),
    setAttribute: (name, value) => (attrs[name] = String(value)),
    removeAttribute: name => delete attrs[name],
    focus() {
      this.focused++;
    },
    attrs,
    ...extra,
  };
}

function setup({ state, width = 1280, dialog = false, mac = false, store } = {}) {
  const root = { dataset: state ? { sidebar: state } : {} };
  const toggle = element({ 'aria-expanded': 'true', 'aria-label': 'Replier la barre' });
  const engine = element({ title: 'Démarrer le modèle', 'aria-label': 'Démarrer le modèle' });
  const files = element({ title: 'Fichiers', 'aria-label': 'Fichiers' });
  const items = [engine, files];
  const sidebar = {
    querySelectorAll: selector =>
      items.filter(item => (selector === '[title]' ? item.hasAttribute('title') : 'title' in item.dataset)),
  };
  const listeners = {};
  const page = {
    activeElement: null,
    addEventListener: (type, handler) => (listeners[type] = handler),
    querySelector: selector => (selector === 'dialog[open]' && dialog ? {} : null),
  };
  const saved = {};
  const storage = store ?? { setItem: (key, value) => (saved[key] = value) };
  const fold = setupSidebarFold({ root, toggle, sidebar, page, view: { innerWidth: width }, storage, mac });
  const press = (key, more = {}) => {
    let prevented = false;
    listeners.keydown({ key, ctrlKey: true, target: { tagName: 'BODY' }, preventDefault: () => (prevented = true), ...more });
    return prevented;
  };
  return { root, toggle, engine, files, page, saved, fold, press };
}

test('the button folds and unfolds the sidebar, says which, and the state is kept', () => {
  const { root, toggle, engine, saved } = setup();
  assert.equal(root.dataset.sidebar, 'expanded');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.getAttribute('aria-label'), 'Replier la barre');
  assert.equal(toggle.dataset.tip, 'Replier la barre (Ctrl+B)');
  assert.equal(engine.getAttribute('title'), 'Démarrer le modèle');

  toggle.onclick();
  assert.equal(root.dataset.sidebar, 'collapsed');
  assert.equal(saved[KEY], 'collapsed');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-label'), 'Déplier la barre');
  assert.equal(toggle.dataset.tip, 'Déplier la barre (Ctrl+B)');
  // The names of the icons are the one tooltip's (help-tips.mjs): the sidebar leaves them as they are.
  assert.equal(engine.getAttribute('title'), 'Démarrer le modèle');
  assert.equal(engine.getAttribute('aria-label'), 'Démarrer le modèle');

  toggle.onclick();
  assert.equal(root.dataset.sidebar, 'expanded');
  assert.equal(saved[KEY], 'expanded');
  assert.equal(engine.getAttribute('title'), 'Démarrer le modèle');
});

test('a sidebar left folded comes back folded', () => {
  const { root, toggle } = setup({ state: 'collapsed' });
  assert.equal(root.dataset.sidebar, 'collapsed');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-label'), 'Déplier la barre');
});

test('Ctrl+B (⌘+B on a Mac) folds and unfolds, never in a field, under a dialog or on a narrow window', () => {
  const run = setup();
  assert.equal(run.press('b'), true);
  assert.equal(run.root.dataset.sidebar, 'collapsed');
  assert.equal(run.press('B'), true);
  assert.equal(run.root.dataset.sidebar, 'expanded');
  assert.equal(run.press('b', { ctrlKey: false, metaKey: true }), true);
  assert.equal(run.root.dataset.sidebar, 'collapsed');
  // Other keys and other chords are left alone (Ctrl+Shift+B: the bookmarks bar of the browser).
  for (const more of [{ shiftKey: true }, { altKey: true }, { ctrlKey: false }, { repeat: true }]) {
    assert.equal(run.press('b', more), false);
  }
  assert.equal(run.press('e'), false);
  assert.equal(run.root.dataset.sidebar, 'collapsed');
  // Text typed: Ctrl+B is the field's (bold, nothing), not the sidebar's.
  for (const target of [
    { tagName: 'TEXTAREA' },
    { tagName: 'INPUT', type: 'text' },
    { tagName: 'INPUT', type: 'search' },
    { tagName: 'INPUT' },
    { tagName: 'SELECT' },
    { tagName: 'DIV', isContentEditable: true },
  ]) {
    assert.equal(run.press('b', { target }), false);
  }
  assert.equal(run.press('b', { target: { tagName: 'INPUT', type: 'checkbox' } }), true);
  assert.equal(run.root.dataset.sidebar, 'expanded');

  const dialog = setup({ dialog: true });
  assert.equal(dialog.press('b'), false);
  assert.equal(dialog.root.dataset.sidebar, 'expanded');
  const narrow = setup({ width: 1099 });
  assert.equal(narrow.press('b'), false);
  assert.equal(narrow.root.dataset.sidebar, 'expanded');

  const mac = setup({ mac: true });
  assert.equal(mac.toggle.dataset.tip, 'Replier la barre (⌘+B)');
});

test('the focus is never lost to the page when what held it folds away', () => {
  const run = setup();
  run.page.activeElement = { closest: selector => (selector.includes('#history-section') ? {} : null) };
  run.toggle.onclick();
  assert.equal(run.toggle.focused, 1);
  run.toggle.onclick();
  // Unfolding takes nothing away; a click on the button keeps the focus on it (same element).
  assert.equal(run.toggle.focused, 1);
});

test('storage that refuses does not stop the sidebar from folding', () => {
  const run = setup({
    store: {
      setItem() {
        throw new Error('blocked');
      },
    },
  });
  run.toggle.onclick();
  assert.equal(run.root.dataset.sidebar, 'collapsed');
});

test('fields are told apart from buttons', () => {
  assert.equal(typing(null), false);
  assert.equal(typing({ tagName: 'BUTTON' }), false);
  assert.equal(typing({ tagName: 'INPUT', type: 'range' }), false);
  assert.equal(typing({ tagName: 'INPUT', type: 'email' }), true);
});

test('the state is read in <head>, before the first paint, from an external script', async () => {
  const html = await read('index.html');
  const head = html.slice(0, html.indexOf('</head>'));
  const early = head.indexOf('<script src="/sidebar-state.js"></script>');
  assert.ok(early > 0, 'sidebar-state.js in <head>');
  assert.ok(early < head.indexOf('rel="stylesheet"'), 'before the stylesheets');
  assert.doesNotMatch(head, /<script>(?!<)/, 'no inline script (the page allows only its own files)');

  const source = await read('sidebar-state.js');
  for (const [stored, expected] of [
    ['collapsed', 'collapsed'],
    ['expanded', undefined],
    [null, undefined],
  ]) {
    const documentElement = { dataset: {} };
    vm.runInNewContext(source, {
      localStorage: { getItem: key => (key === KEY ? stored : null) },
      document: { documentElement },
    });
    assert.equal(documentElement.dataset.sidebar, expected);
  }
  const documentElement = { dataset: {} };
  vm.runInNewContext(source, {
    localStorage: {
      getItem() {
        throw new Error('blocked');
      },
    },
    document: { documentElement },
  });
  assert.equal(documentElement.dataset.sidebar, undefined);
});

test('the button beside the logo, and each icon named for its tooltip', async () => {
  const html = await read('index.html');
  const button = html.match(/<button id="sidebar-toggle"[^>]*>/)?.[0] ?? '';
  assert.match(button, /aria-label="Replier la barre"/);
  assert.match(button, /aria-controls="sidebar"/);
  assert.match(button, /aria-expanded="true"/);
  assert.match(button, /data-tip="Replier la barre \(Ctrl\+B\)"/);
  assert.ok(html.indexOf('id="sidebar-toggle"') > html.indexOf('class="brand-rule"'), 'at the right of the logo');
  assert.match(html, /<img class="sidebar-mark" src="\/assets\/moodix-mark\.svg\?v=3"/);
  assert.match(html, /<symbol id="i-panel" viewBox="0 0 24 24"><rect x="3\.5" y="4\.5" width="17" height="15" rx="3"\/><path d="M9\.5 4\.5v15"\/><\/symbol>/);
  for (const [id, tip] of [
    ['new-chat', 'Nouveau chat'],
    ['library-open', 'Bibliothèque'],
    ['chat-open', 'Chat'],
    ['studio-open', 'Studio'],
  ]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*data-tip="${tip}"`));
  }
  // The words of « Nouveau chat » in their own element, so that they can fade.
  assert.match(html, /id="new-chat"[^>]*><svg><use href="#i-plus"\/><\/svg><span>Nouveau chat<\/span>/);
});

test('folded only on a wide window, 64 px, animated unless motion is reduced', async () => {
  const css = (await read('moodix.css')).replace(/\r\n/g, '\n');
  const section = css.slice(css.indexOf('sidebar folded (0.5.99)'));
  assert.ok(section.length > 100);
  const wide = section.indexOf('@media (min-width: 1100px) {');
  assert.ok(wide > 0);
  // Every rule of the folded sidebar inside the wide media query: under 1100 px, the drawer as it was.
  const before = section.slice(0, wide);
  assert.doesNotMatch(before, /data-sidebar/);
  assert.match(before, /\.sidebar-toggle \{\n {2}display: none;/);
  assert.match(section, /:root\[data-sidebar='collapsed'\] \{\n {4}--sidebar-width: 64px;/);
  assert.match(section, /flex-basis 180ms ease/);
  assert.match(section, /transition: opacity 80ms ease;/);
  assert.match(section, /white-space: nowrap;/);
  assert.match(section, /@media \(min-width: 1100px\) and \(prefers-reduced-motion: reduce\) \{[^}]*#sidebar,[^}]*transition: none;/);
});

test('the sidebar spans the window: the logo at its top edge, the actions at its bottom edge', async () => {
  const css = (await read('moodix.css')).replace(/\r\n/g, '\n');
  const frame = css.slice(css.indexOf('frame and window'));
  // The window: 10 px from the frame, the drawer's (under 1100 px) at the top too.
  assert.match(frame, /\.workspace \{[^}]*height: calc\(100dvh - 20px\);[^}]*margin: 10px 10px 10px 0;/);
  // The sidebar: 20 px, the logo's box (6 px of padding) and the 1.5 px of empty drawing above the
  // letters put them at 27.5 px; 27 px under the actions, as under the window.
  assert.match(frame, /@media \(min-width: 1100px\) \{[^@]*#sidebar \{\n {4}padding: 20px 12px 27px;/);
  // Wide, the window follows the logo: its top edge at 27 px, as far from the frame at its bottom
  // and its right.
  assert.match(
    frame,
    /@media \(min-width: 1100px\) \{\n {2}\.workspace \{\n {4}height: calc\(100dvh - 54px\);\n {4}margin: 27px 27px 27px 0;/,
  );
  assert.match(css, /#sidebar \.brand \{[^}]*padding: 6px 4px;/);
  // Unfolded, the button on the logo's line; folded, the small logo (24 px in 36) at the same top.
  assert.match(css, /\.sidebar-toggle \{[^}]*align-self: flex-start;[^}]*height: 28px;[^}]*margin: 6px 0 0;/);
  const folded = css.match(/:root\[data-sidebar='collapsed'\] \.sidebar-toggle \{[^}]*\}/)?.[0] ?? '';
  assert.match(folded, /height: 36px;/);
  assert.match(folded, /margin: 0;/);
  assert.doesNotMatch(folded, /align-self/);
  // The small logo's squares (from 4.6 of 32, at 24 px: 3.45 px) 2 px above the middle: 20 + 6 - 2 + 3.45.
  assert.match(css, /:root\[data-sidebar='collapsed'\] \.sidebar-toggle \.sidebar-mark \{[^}]*transform: translateY\(-2px\);/);
  const mark = await read('assets/moodix-mark.svg');
  assert.match(mark, /viewBox="0 0 32 32"/);
  assert.equal(Math.min(...[...mark.matchAll(/<rect[^>]* y="([\d.]+)"/g)].map(found => Number(found[1]))), 4.6);
});
