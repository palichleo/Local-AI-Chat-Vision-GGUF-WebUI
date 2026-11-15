import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as sessionCopies from '../public/session-copies.mjs';

const read = async name => (await readFile(new URL('../public/' + name, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('the sidebar: « Nouvelle conversation » a line as the pages, then Accueil, Chat, Studio, Bibliothèque', async () => {
  const html = await read('index.html'),
    sidebar = html.slice(html.indexOf('<aside id="sidebar"'), html.indexOf('</aside>'));
  // No bordered button any more; the same id, the same words.
  assert.match(sidebar, /<button class="new-chat" id="new-chat" data-tip="Nouvelle conversation"><svg><use href="#i-plus"\/><\/svg><span>Nouvelle conversation<\/span><\/button>/);
  const order = ['id="new-chat"', 'id="home-open"', 'id="chat-open"', 'id="studio-open"', 'id="studio-kinds"', 'id="library-open"'].map(
    mark => sidebar.indexOf(mark),
  );
  assert.ok(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1])), 'in this order');
  assert.match(
    sidebar,
    /<button id="library-open" type="button" class="home-button" aria-controls="library-view" data-tip="Bibliothèque"><svg aria-hidden="true"><use href="#i-library"\/><\/svg><span>Bibliothèque<\/span><\/button><\/nav>/,
  );
  // At the foot, the model and Configuration only: nothing left of « Fichiers ».
  assert.match(sidebar, /id="toggle-engine"/);
  assert.match(sidebar, /id="settings-open"/);
  assert.doesNotMatch(html, /all-files|assets-panel|resource-file|Ressources/);
  assert.match(html, /<symbol id="i-library" viewBox="0 0 24 24"><path d="M4 4v16"\/><path d="M8\.5 7v13"\/><path d="M13 5v15"\/><path d="m16\.5 6\.5 3\.6 13\.2"\/><\/symbol>/);
  assert.match(html, /<symbol id="i-power" viewBox="0 0 24 24"><path d="M12 3\.5v7\.5"\/><path d="M6\.6 6\.8a7\.6 7\.6 0 1 0 10\.8 0"\/><\/symbol>/);
});

test('the library: a page of its own in the window, its title in the title bar, its content not drawn yet', async () => {
  const html = await read('index.html'),
    app = await read('app.js'),
    navigation = await read('project-navigation.mjs'),
    css = await read('moodix.css');
  assert.match(
    html,
    /<section id="library-view" class="library-view" aria-labelledby="library-title"><h1 id="library-title" class="sr-only">Bibliothèque<\/h1><p class="library-note">Toutes vos créations, bientôt ici\.<\/p><\/section>/,
  );
  assert.match(html, /<span id="library-heading" class="library-heading">Bibliothèque<\/span>/);
  assert.match(app, /\$\('library-open'\)\.onclick = \(\) => showHome\('library'\);/);
  assert.match(navigation, /\$\('library-open'\)\?\.setAttribute\('aria-current', state\.view === 'library' \? 'page' : 'false'\);/);
  assert.match(navigation, /#studio-open,#library-open'/);
  assert.match(css, /body\[data-view='library'\] \.library-view \{\n {2}display: flex;/);
  assert.match(css, /\.library-note \{\n {2}margin: 0;\n {2}color: #9aa0ab;/);
  assert.match(css, /body\[data-view='library'\] \.chat-area,\nbody\[data-view='library'\] \.composer-region,/);
});

test('a page of its own: the conversation kept first, then the library on screen', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    state = { status: {}, view: 'chat' };
  let rendered = 0;
  const context = {
    ...sessionCopies,
    state,
    document: { body: { dataset: { chat: 'open' } } },
    $: () => ({ setAttribute() {} }),
    updateControls() {},
    notice() {},
    assetsUI: { flush: async () => true },
    persistConversation: async () => true,
    requestSettingsClose: action => action(),
    projectUI: { render: () => rendered++ },
  };
  runInNewContext(
    source.slice(source.indexOf('function closeNavigation('), source.indexOf('async function newConversation(')) +
      ';this.page=showHome;',
    context,
  );
  await context.page('library');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(state.view, 'library');
  assert.equal(rendered, 1);
  assert.equal(context.document.body.dataset.chat, undefined);
  await context.page();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(state.view, 'home');
});

test('every line alike: 36 px, 10 px corners; the page open, a white line on the left edge', async () => {
  const css = await read('moodix.css'),
    rows = css.slice(css.indexOf('sidebar, rows (0.5.108)'));
  assert.ok(rows.length > 100);
  assert.match(rows, /#sidebar > \.new-chat,\n#sidebar \.home-button \{[^}]*height: 36px;[^}]*padding: 0 8px;[^}]*border: 0;[^}]*border-radius: 10px;[^}]*background: transparent;[^}]*font-size: 14px;[^}]*font-weight: 600;/);
  assert.match(rows, /--row-ink: #aeb4bf;\n {2}--row-hover: #15171c;\n {2}--row-open: #eceef2;/);
  assert.match(rows, /:root\[data-theme='light'\] #sidebar \{\n {2}--row-ink: #5a606b;\n {2}--row-hover: #eef0f3;\n {2}--row-open: #0b0c0f;/);
  assert.match(rows, /#sidebar > \.new-chat \{[^}]*color: var\(--row-open\);\n {2}font-weight: 700;/);
  assert.match(rows, /#sidebar \.home-button\[aria-current='page'\],\n[^{]*\{\n {2}background: transparent;\n {2}color: var\(--row-open\);\n {2}font-weight: 800;/);
  assert.match(
    rows,
    /#sidebar \.home-button\[aria-current='page'\]::after \{[^}]*top: 9px;[^}]*bottom: 9px;[^}]*left: calc\(-1 \* var\(--sidebar-inset\)\);[^}]*width: 3px;[^}]*border-radius: 0 3px 3px 0;[^}]*background: var\(--row-open\);/,
  );
  // The Studio without its card; its track under it, from the word (32 px), white in the Studio alone.
  assert.match(rows, /\.studio-nav,\nbody\[data-view='studio'\] \.studio-nav,[^{]*\{[^}]*padding: 0;[^}]*background: transparent;/);
  assert.match(rows, /#sidebar #studio-kinds\.kind-tabs \{\n {2}margin: 0 0 2px 32px;/);
  assert.match(css, /body\[data-view='studio'\] #studio-kinds \.kind-tab\[aria-selected='true'\] \{\n {2}background: #eceef2;\n {2}color: #0b0c0f;/);
  // Folded: icons alone, 40 × 36.
  assert.match(rows, /:root\[data-sidebar='collapsed'\] #sidebar > \.new-chat,[^{]*\{[^}]*height: 36px;[^}]*padding: 0 0 0 11px;/);
});

test('the model: one icon ⏻ whatever its state, a dot of 7 px says it; its name unchanged', async () => {
  const css = await read('moodix.css'),
    app = await read('app.js');
  assert.match(app, /\$\('toggle-engine'\)\.replaceChildren\(icon\('power'\)\);/);
  assert.doesNotMatch(app, /icon\(paused \|\| running \? 'stop' : 'play'\)/);
  // Its name and tooltip as before.
  assert.match(app, /\$\('toggle-engine'\)\.setAttribute\('aria-label', engineLabel\);\n {2}\$\('toggle-engine'\)\.title = engineLabel;/);
  assert.match(css, /#sidebar \.sidebar-actions \.engine-button svg,\n#sidebar \.sidebar-actions \.engine-button\.is-busy svg \{[^}]*stroke-width: 1\.75;[^}]*animation: none;/);
  assert.match(
    css,
    /#sidebar \.sidebar-actions \.engine-button::after \{[^}]*top: 6px;[^}]*right: 7px;[^}]*width: 7px;[^}]*height: 7px;[^}]*border-radius: 50%;[^}]*box-shadow: 0 0 0 2px var\(--engine-ring\);/,
  );
  for (const [state, colour] of [
    ['\\.is-off', '#4a4f59'],
    ['\\.is-running', '#22a060'],
    ['\\.is-running\\.is-busy,\\n#sidebar \\.sidebar-actions \\.engine-button\\.is-paused', '#f6c343'],
  ])
    assert.match(css, new RegExp(`#sidebar \\.sidebar-actions \\.engine-button${state} \\{\\n {2}--engine-dot: ${colour};`));
  assert.match(css, /\.engine-button\.is-running\.is-busy::after \{\n {2}animation: mdx-engine-wait 1\.6s ease-in-out infinite;/);
  assert.match(css, /@keyframes mdx-engine-wait \{\n {2}0%,\n {2}100% \{\n {4}opacity: 1;\n {2}\}\n {2}50% \{\n {4}opacity: 0\.4;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n {2}#sidebar \.sidebar-actions \.engine-button\.is-running\.is-busy::after \{\n {4}animation: none;/);
  // The foot without a box: the model at the left, Configuration at the right.
  assert.match(css, /#sidebar \.sidebar-actions,\n:root\[data-theme='light'\] #sidebar \.sidebar-actions \{\n {2}justify-content: space-between;[^}]*padding: 0;\n {2}border: 0;[^}]*background: transparent;/);
});

test('nothing left of the panel of files in the styles', async () => {
  for (const name of ['styles.css', 'workspace.css', 'moodix.css']) {
    const css = (await read(name)).replace(/\/\*[^]*?\*\//g, '');
    assert.doesNotMatch(css, /assets-panel|assets-tabs|asset-pane|#resource-|\.resource-|files-button|data-files|resources-grid/, name);
  }
});
