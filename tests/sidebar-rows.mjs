import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as sessionCopies from '../public/session-copies.mjs';

const read = async name => (await readFile(new URL('../public/' + name, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('the sidebar: « Nouveau chat » a line as the pages, then Chat, Studio, Bibliothèque; no Accueil', async () => {
  const html = await read('index.html'),
    sidebar = html.slice(html.indexOf('<aside id="sidebar"'), html.indexOf('</aside>'));
  // No bordered button any more; the same id, the same words.
  assert.match(sidebar, /<button class="new-chat" id="new-chat" data-tip="Nouveau chat"><svg><use href="#i-plus"\/><\/svg><span>Nouveau chat<\/span><\/button>/);
  const order = ['id="new-chat"', 'id="chat-open"', 'id="studio-open"', 'id="studio-kinds"', 'id="library-open"'].map(
    mark => sidebar.indexOf(mark),
  );
  assert.ok(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1])), 'in this order');
  // No home page any more (0.5.123): the projects are opened in the library.
  assert.doesNotMatch(sidebar, /id="home-open"|Accueil/);
  assert.doesNotMatch(html, /id="home-view"|id="project-grid"|<symbol id="i-home"/);
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

test('the library: a page of its own in the window, its title in the title bar, its filters on one line', async () => {
  const html = await read('index.html'),
    app = await read('app.js'),
    navigation = await read('project-navigation.mjs'),
    css = await read('moodix.css');
  const page = html.match(/<section id="library-view"[^]*?<\/section><\/section>/)?.[0] ?? '';
  assert.match(page, /^<section id="library-view" class="library-view" aria-labelledby="library-title"><h1 id="library-title" class="sr-only">Bibliothèque<\/h1>/);
  // The conversations of a project at the top; then on one line the project, the conversation and
  // the kind; then « Créations » and the tiles (0.5.126).
  const order = ['id="library-project-view"', 'id="library-project"', 'id="library-conversation"', 'id="library-kinds"', 'id="library-creations-title"', 'id="library-grid"', 'id="library-empty"'].map(
    mark => page.indexOf(mark),
  );
  assert.ok(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1])), 'in this order');
  assert.match(page, /<section id="library-project-view" class="library-project-view" aria-label="Conversations du projet" hidden>/);
  assert.match(page, /<div id="library-kinds" class="library-kinds" role="radiogroup" aria-label="Type de création">/);
  assert.match(page, /<span class="sr-only">Projet<\/span><select id="library-project"><\/select>/);
  assert.match(page, /<span class="sr-only">Conversation<\/span><select id="library-conversation"><\/select>/);
  assert.match(html, /<span id="library-heading" class="library-heading">Bibliothèque<\/span>/);
  assert.match(app, /\$\('library-open'\)\.onclick = \(\) => showLibrary\(\);/);
  // The logo goes back to the chat: there is no home page any more.
  assert.match(app, /\$\('brand-home'\)\.onclick = event => \{\n {2}event\.preventDefault\(\);\n {2}showChat\(\);/);
  assert.match(html, /<body data-view="chat">/);
  assert.match(app, /\n {2}view: 'chat',\n/);
  assert.match(navigation, /\$\('library-open'\)\?\.setAttribute\('aria-current', state\.view === 'library' \? 'page' : 'false'\);/);
  assert.match(navigation, /#studio-open,#library-open'/);
  assert.match(css, /body\[data-view='library'\] \.library-view \{\n {2}display: flex;/);
  assert.match(css, /\.library-note \{\n {2}margin: 0;\n {2}color: var\(--text-2\);/);
  assert.match(css, /body\[data-view='library'\] \.chat-area,\nbody\[data-view='library'\] \.composer-region,/);
  // Its own scroll; pictures of 16:9 with 6 px corners, as in the Sortie of the Studio.
  assert.match(css, /body\[data-view='library'\] \.library-view \{[^}]*overflow-y: auto;/);
  assert.match(css, /\.library-grid \{\n {2}display: grid;\n {2}grid-template-columns: repeat\(auto-fill, minmax\(220px, 1fr\)\);/);
  assert.match(css, /\.library-pick \{[^}]*aspect-ratio: 16 \/ 9;[^}]*border-radius: 6px;/);
  assert.match(page, /<div class="library-filters"><label class="library-select">/);
  assert.match(css, /\.library-filters \{\n {2}display: flex;/);
  // The words of a tile over its foot, under the pointer or the keyboard's focus only.
  assert.match(css, /\.library-veil \{[^}]*opacity: 0;[^}]*pointer-events: none;/);
  assert.match(css, /\.library-tile:hover \.library-veil,\n\.library-tile:focus-within \.library-veil \{\n {2}opacity: 1;/);
  assert.match(css, /\.library-prompt \{[^}]*color: #eceef2;[^}]*font-size: var\(--size-2\);[^}]*-webkit-line-clamp: 2;/);
  assert.match(css, /\.library-meta \{[^}]*color: #aeb4bf;[^}]*font-size: var\(--size-1\);/);
  assert.doesNotMatch(css, /library-words|library-top|project-empty/);
  assert.match(css, /\.library-kind\[aria-checked='true'\],\n\.library-kind\[aria-checked='true'\]:hover:enabled \{\n {2}background: var\(--selected\);/);
  // Nothing left of the home page in the sheet.
  assert.doesNotMatch(css, /home-view|\.home-header|project-card|project-cover|project-grid|#home-open|data-view='home'/);
});

test('a page of its own: the conversation kept first, then the library on screen, on a project or on all', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    state = { status: {}, view: 'chat' },
    shown = [];
  let rendered = 0;
  const context = {
    libraryUI: { show: options => shown.push(options) },
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
      ';this.page=showLibrary;',
    context,
  );
  await context.page();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(state.view, 'library');
  assert.equal(state.libraryProject, 'all');
  assert.equal(rendered, 1);
  assert.equal(context.document.body.dataset.chat, undefined);
  // A click on a project in the sidebar: the library on it, the project lit there.
  await context.page({ project: 'p1' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(state.view, 'library');
  assert.equal(state.libraryProject, 'p1');
  assert.deepEqual(
    shown.map(options => options.project),
    ['all', 'p1'],
  );
});

test('every line alike: 36 px, 10 px corners; the page open, a white line on the left edge', async () => {
  const css = await read('moodix.css'),
    rows = css.slice(css.indexOf('sidebar, rows (0.5.108)'));
  assert.ok(rows.length > 100);
  assert.match(rows, /#sidebar > \.new-chat,\n#sidebar \.home-button \{[^}]*height: 36px;[^}]*padding: 0 8px;[^}]*border: 0;[^}]*border-radius: 10px;[^}]*background: transparent;[^}]*font-size: var\(--size-3\);[^}]*font-weight: 600;/);
  // Text in the four greys of the sheet (--text-1: principal, --text-2: secondaire).
  assert.match(rows, /--row-ink: var\(--text-2\);\n {2}--row-hover: #15171c;\n {2}--row-open: var\(--text-1\);/);
  assert.match(rows, /:root\[data-theme='light'\] #sidebar \{\n {2}--row-ink: var\(--text-2\);\n {2}--row-hover: #eef0f3;\n {2}--row-open: var\(--text-1\);/);
  assert.match(rows, /#sidebar > \.new-chat \{[^}]*color: var\(--row-open\);\n {2}font-weight: 700;/);
  assert.match(rows, /#sidebar \.home-button\[aria-current='page'\],\n[^{]*\{\n {2}background: transparent;\n {2}color: var\(--row-open\);\n {2}font-weight: 800;/);
  assert.match(
    rows,
    /#sidebar \.home-button\[aria-current='page'\]::after \{[^}]*top: 9px;[^}]*bottom: 9px;[^}]*left: calc\(-1 \* var\(--sidebar-inset\)\);[^}]*width: 3px;[^}]*border-radius: 0 3px 3px 0;[^}]*background: var\(--row-open\);/,
  );
  // The Studio without its card; its track under it, from the word (32 px), white in the Studio alone.
  assert.match(rows, /\.studio-nav,\nbody\[data-view='studio'\] \.studio-nav,[^{]*\{[^}]*padding: 0;[^}]*background: transparent;/);
  assert.match(rows, /#sidebar #studio-kinds\.kind-tabs \{\n {2}margin: 0 0 2px 44px;/);
  // The icon in 24 px, 12 px from its word; the word at the left of its line.
  assert.match(rows, /#sidebar > \.new-chat,\n#sidebar \.home-button \{[^}]*gap: 12px;/);
  assert.match(rows, /#sidebar > \.new-chat svg,\n#sidebar \.home-button svg \{\n {2}flex: none;\n {2}width: 24px;\n {2}height: 24px;\n {2}stroke-width: 1\.75;/);
  assert.match(rows, /#sidebar > \.new-chat > span,\n#sidebar \.home-button > span \{\n {2}text-align: left;/);
  assert.match(css, /body\[data-view='studio'\] #studio-kinds \.kind-tab\[aria-selected='true'\] \{\n {2}background: #eceef2;\n {2}color: #0b0c0f;/);
  // Folded: icons alone, 40 × 36.
  assert.match(rows, /:root\[data-sidebar='collapsed'\] #sidebar > \.new-chat,[^{]*\{[^}]*height: 36px;[^}]*padding: 0 0 0 8px;/);
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
  // The gear in the colour of its button (#AEB4BF, white under the pointer), as ⏻.
  assert.match(css, /#sidebar \.sidebar-actions \.settings-button svg \{\n {2}color: inherit;\n {2}stroke-width: 1\.75;/);
  // The foot without a box: the model at the left, Configuration at the right.
  assert.match(css, /#sidebar \.sidebar-actions,\n:root\[data-theme='light'\] #sidebar \.sidebar-actions \{\n {2}justify-content: space-between;[^}]*padding: 0;\n {2}border: 0;[^}]*background: transparent;/);
});

test('nothing left of the panel of files in the styles', async () => {
  for (const name of ['moodix.css']) {
    const css = (await read(name)).replace(/\/\*[^]*?\*\//g, '');
    assert.doesNotMatch(css, /assets-panel|assets-tabs|asset-pane|#resource-|\.resource-|files-button|data-files|resources-grid/, name);
  }
});

test('the chat: no logo, an invitation; a quiet message box; « 0 % » under the pointer only', async () => {
  const html = await read('index.html'),
    css = await read('moodix.css');
  const welcome = html.slice(html.indexOf('<div id="welcome"'), html.indexOf('<form class="composer"'));
  assert.match(welcome, /<h1>Demandez n’importe quoi\.<\/h1>/);
  assert.doesNotMatch(welcome, /welcome-logo|mdx-white|Votre modèle|Votre machine/);
  // Being written in: 1 px a little lighter, no ring around it.
  assert.match(css, /\.composer:has\(textarea:focus-visible\),\n\.composer:focus-within \{\n {2}outline: none;/);
  assert.match(css, /#chat-form\.composer:focus-within \{\n {2}border-color: #3a3f4a;/);
  // The share of the context: hidden, its room kept; shown over the box, on focus, or nearly full.
  assert.match(css, /\.context-meter \{\n {2}opacity: 0;/);
  assert.match(css, /#chat-form:hover ~ \.context-meter,\n\.context-meter:hover,\n\.context-meter:focus-visible,\n\.context-meter\[data-warning='near'\],\n\.context-meter\[data-warning='full'\] \{\n {2}opacity: 1;/);
  // No colour at the top of the cards of suggestion.
  assert.doesNotMatch(css, /\.suggestions button:nth-child\(\d\) \{\n {2}border-top: 2px solid/);
});
