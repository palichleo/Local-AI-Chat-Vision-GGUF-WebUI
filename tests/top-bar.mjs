import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as sessionCopies from '../public/session-copies.mjs';

// The top bar of « Salle obscure » (0.6.0), which takes the place of the sidebar (sidebar-rows.mjs
// before): what those tests checked of the places, the library and the model, now on the top bar.
const read = async name => (await readFile(new URL('../public/' + name, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('the top bar: « Moodix » with the Éclipse for its first « o », then Chat · Studio · Pellicule, then the model and the gear; no sidebar', async () => {
  const html = await read('index.html'),
    top = html.slice(html.indexOf('<header id="top"'), html.indexOf('</header>', html.indexOf('<header id="top"')));
  assert.ok(top.length > 100);
  const order = ['id="brand-home"', 'class="top-name brand-word" aria-label="Moodix">M<svg', 'id="chat-open"', 'id="studio-open"', 'id="library-open"', 'id="toggle-engine"', 'id="engine-name"', 'id="settings-open"'].map(
    mark => top.indexOf(mark),
  );
  assert.ok(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1])), 'in this order');
  // The Éclipse in the word (Logo E, « Dans le nom », 17/11): fuller than the mark (radii 15.2 and
  // 14), in currentColor; no mark apart any more.
  assert.match(
    top,
    /aria-label="Moodix">M<svg class="brand-eclipse" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="15\.2" fill="none" stroke="currentColor" stroke-opacity="0\.22" stroke-width="1" vector-effect="non-scaling-stroke"\/><path d="M2\.01 10\.06A15\.2 15\.2 0 1 0 29\.99 10\.06A14 14 0 0 1 2\.01 10\.06Z" fill="currentColor"\/><\/svg>odix<\/span><\/a>/,
  );
  assert.doesNotMatch(top, /top-mark|eclipse-ring|eclipse\.svg/);
  assert.match(top, /<button id="library-open" type="button" class="top-place" aria-controls="library-view">Pellicule<\/button>/);
  // No sidebar, no drawer, no button « Nouveau chat » any more: the fil holds the conversations.
  assert.doesNotMatch(html, /id="sidebar"|id="navigation-open"|id="new-chat"|id="sidebar-toggle"|class="mdx-filet"|sidebar-state\.js/);
  // No home page (0.5.123), nothing left of « Fichiers ».
  assert.doesNotMatch(html, /id="home-view"|id="project-grid"|<symbol id="i-home"/);
  assert.doesNotMatch(html, /all-files|assets-panel|resource-file|Ressources/);
  assert.match(html, /<symbol id="i-power" viewBox="0 0 24 24"><path d="M12 3\.5v7\.5"\/><path d="M6\.6 6\.8a7\.6 7\.6 0 1 0 10\.8 0"\/><\/symbol>/);
  // The fil in the window, before the pages.
  assert.ok(html.indexOf('<nav id="thread"') > html.indexOf('<div class="workspace">'));
  assert.ok(html.indexOf('<nav id="thread"') < html.indexOf('<section id="library-view"'));
  const css = await read('moodix.css');
  // 72 px high, the three places in the middle; « Moodix » in Gloock 26 px, its Éclipse in em.
  assert.match(css, /\.top-bar \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\);[^}]*height: 72px;[^}]*padding: 0 36px;/);
  assert.match(
    css,
    /\.brand-eclipse \{[^}]*width: 0\.556em;[^}]*height: 0\.556em;[^}]*margin: 0 0\.03em;[^}]*vertical-align: -0\.022em;/,
  );
  assert.doesNotMatch(css, /\.top-mark/);
  assert.match(css, /\.top-name \{[^}]*font-family: var\(--font-display\);[^}]*font-size: 26px;/);
  // One line under the tab of the view, which glides to the tab chosen (16/11).
  assert.match(css, /\.top-line \{[^}]*width: 16px;[^}]*height: 1\.5px;[^}]*transition: transform 0\.2s cubic-bezier\(0\.2, 0\.7, 0\.2, 1\);/);
  assert.match(html, /<span id="top-line" class="top-line" aria-hidden="true" hidden><\/span>/);
});

test('the Pellicule: a page of its own, headed by the fil of the Chat and the Studio, its number of takes, the kinds', async () => {
  const html = await read('index.html'),
    app = await read('app.js'),
    navigation = await read('project-navigation.mjs'),
    css = await read('moodix.css');
  const page = html.match(/<section id="library-view"[^]*?<\/section><\/section>/)?.[0] ?? '';
  // Its name for a screen reader only: no title, no pills any more (pellicule-fil-maquette.md).
  assert.match(page, /^<section id="library-view" class="library-view" aria-labelledby="library-heading"><h1 id="library-heading" class="sr-only">Pellicule<\/h1><header class="library-head">/);
  // One line: the place of the fil, the number of takes, the kinds; then the sheet.
  const order = ['id="library-thread"', 'id="library-total"', 'id="library-kinds"', 'id="library-grid"', 'id="library-empty"'].map(mark =>
    page.indexOf(mark),
  );
  assert.ok(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1])), 'in this order');
  assert.match(page, /<header class="library-head"><div id="library-thread" class="library-thread"><\/div><span id="library-total" class="library-total">0 prise<\/span>/);
  assert.match(page, /<div id="library-kinds" class="library-kinds" role="radiogroup" aria-label="Type de création">/);
  assert.doesNotMatch(page, /<select|library-pill|library-projects|library-conversations|library-title/, 'no more pills nor title');
  // The fil is one element, put there by its module; in it, what the Pellicule shows of the conversations.
  assert.equal(html.split('<nav id="thread"').length, 2, 'the same fil, not a copy');
  assert.match(html, /<span id="conversation-title">Nouvelle conversation<\/span><span id="thread-shown" hidden><\/span>/);
  assert.match(navigation, /slot = \$\('library-thread'\);/);
  assert.match(app, /\nprojectUI\.useLibrary\(libraryUI\);\r?\n/);
  assert.match(app, /\$\('library-open'\)\.onclick = \(\) => showLibrary\(\);/);
  // The logo opens the accueil (16/11: a new conversation of the project, from any view).
  assert.match(app, /\$\('brand-home'\)\.onclick = event => \{\n {2}event\.preventDefault\(\);\n {2}goHome\(\);/);
  assert.match(html, /<body data-view="chat">/);
  assert.match(app, /\n {2}view: 'chat',\n/);
  assert.match(navigation, /\$\('library-open'\)\?\.setAttribute\('aria-current', state\.view === 'library' \? 'page' : 'false'\);/);
  assert.match(navigation, /'#thread button,#chat-open,#studio-open,#library-open'/);
  assert.match(css, /body\[data-view='library'\] \.library-view \{\n {2}display: flex;/);
  assert.match(css, /\.library-note \{\n {2}margin: 0;\n {2}color: var\(--text-2\);/);
  assert.match(css, /body\[data-view='library'\] \.chat-area,\nbody\[data-view='library'\] \.composer-region \{/);
  // Its own scroll; the sheet by day, each take at its format on rows of 196 px (capture 31).
  assert.match(css, /body\[data-view='library'\] \.library-view \{[^}]*overflow-y: auto;/);
  assert.match(css, /\.library-row \{\n {2}display: flex;\n {2}flex-wrap: wrap;\n {2}gap: 10px;/);
  assert.match(css, /#library-view \.library-tile \{[^}]*width: calc\(196px \* var\(--ratio, 1\)\);[^}]*height: 196px;/);
  assert.doesNotMatch(css, /\.library-pill|\.library-project-more|\.library-title|\.library-doors/);
  // « Tous les projets » alone; the number of takes of a line of the menus in mono.
  assert.match(css, /\.thread\[data-scope='all'\] :is\(\.thread-slash, \.thread-conversation\) \{\n {2}display: none;/);
  assert.match(css, /\.thread-choice-count \{[^}]*font: 400 12px\/1 var\(--font-mono\);/);
  // A narrow take (9:16): its actions in one column at its right edge, not in stretched rows (17/11).
  // Under the width of a square take (196 px), which keeps its row.
  assert.match(css, /#library-view \.library-tile \{\r?\n {2}container: library-tile \/ inline-size;/);
  assert.match(
    css,
    /@container library-tile \(max-width: 184px\) \{\r?\n {2}#library-view \.library-tile \.output-actions \{\r?\n {4}flex-direction: column;/,
  );
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
    source.slice(source.indexOf('function showLibrary('), source.indexOf('async function newConversation(')) +
      ';this.page=showLibrary;',
    context,
  );
  await context.page();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(state.view, 'library');
  assert.equal(state.libraryProject, 'all');
  assert.equal(rendered, 1);
  assert.equal(context.document.body.dataset.chat, undefined);
  // On a project: the library on it.
  await context.page({ project: 'p1' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(state.view, 'library');
  assert.equal(state.libraryProject, 'p1');
  assert.deepEqual(
    shown.map(options => options.project),
    ['all', 'p1'],
  );
});

test('the model in its capsule: one icon ⏻ whatever its state, a dot says it, its name beside; the gear wears the update', async () => {
  const css = await read('moodix.css'),
    app = await read('app.js');
  assert.match(app, /\$\('toggle-engine'\)\.replaceChildren\(icon\('power'\)\);/);
  assert.doesNotMatch(app, /icon\(paused \|\| running \? 'stop' : 'play'\)/);
  // Its name and tooltip as before.
  assert.match(app, /\$\('toggle-engine'\)\.setAttribute\('aria-label', engineLabel\);\n {2}\$\('toggle-engine'\)\.title = engineLabel;/);
  // The name of the model beside it, from the library of models, or its file.
  assert.match(app, /\$\('engine-name'\)\.textContent =\n {4}model\?\.name \|\|/);
  assert.match(css, /#top \.engine-button::after \{[^}]*top: 5px;[^}]*right: 5px;[^}]*width: 6px;[^}]*height: 6px;[^}]*border-radius: 50%;/);
  assert.match(css, /#top \.engine-button\.is-running::after \{\n {2}background: #78c08f;/);
  assert.match(css, /#top \.engine-button\.is-running\.is-busy::after,\n#top \.engine-button\.is-paused::after \{\n {2}background: #e0a35c;/);
  // While the model loads, its dot breathes; still with less motion asked.
  assert.match(css, /#top \.engine-button\.is-running\.is-busy::after \{\n {2}animation: mdx-engine-wait 1\.6s ease-in-out infinite;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n {2}#top \.engine-button\.is-running\.is-busy::after \{\n {4}animation: none;/);
  assert.match(css, /\.top-engine-name \{[^}]*font: 400 12\.5px\/1 var\(--font-mono\);/);
  // A dot of the accent, 7 px, on the gear when an update is there.
  assert.match(css, /#top \.top-settings\.has-update::after \{[^}]*width: 7px;[^}]*height: 7px;[^}]*background: var\(--accent\);/);
  assert.match(app, /opener\.classList\.toggle\('has-update', state\.updateAvailable\);/);
});

test('the window of the pencil: its name, its project in a menu, drawn like the window of a project', async () => {
  const html = await read('index.html'),
    css = await read('moodix.css');
  const dialog = html.match(/<dialog id="conversation-dialog"[^]*?<\/dialog>/)?.[0] ?? '';
  assert.match(dialog, /<h2 id="conversation-dialog-title">Renommer ou déplacer la conversation<\/h2>/);
  assert.match(dialog, /<label for="conversation-name">Nom<\/label><input id="conversation-name" type="text" maxlength="120"/);
  // « Projet » is a menu, not a field to type in.
  // A menu as those of the fil (16/11), the select hidden keeping the choice.
  assert.match(dialog, /<label for="conversation-project-button">Projet<\/label><div class="project-picker"><button type="button" id="conversation-project-button" class="project-picker-button" aria-haspopup="listbox"/);
  // Its own class: a menu of the fil (« .thread-menu ») is one open over the page.
  assert.match(dialog, /<div id="conversation-project-menu" class="project-picker-menu" role="listbox"/);
  assert.match(dialog, /<select id="conversation-project" hidden aria-hidden="true" tabindex="-1"><\/select>/);
  assert.match(dialog, /<button id="conversation-save" type="submit" class="primary">Enregistrer<\/button>/);
  // Centred and framed as the window of a project: the same rules, not a copy of them.
  assert.match(css, /#project-dialog,\n#conversation-dialog \{\n {2}position: fixed;\n {2}inset: 0;\n {2}margin: auto;/);
  assert.match(css, /#project-dialog footer,\n#conversation-dialog footer \{\n {2}display: flex;/);
  assert.match(css, /#project-name,\n#conversation-name,\n#conversation-project-button \{\n {2}min-height: 42px;/);
});

test('nothing left of the panel of files in the styles', async () => {
  for (const name of ['moodix.css']) {
    const css = (await read(name)).replace(/\/\*[^]*?\*\//g, '');
    assert.doesNotMatch(css, /assets-panel|assets-tabs|asset-pane|#resource-|\.resource-|files-button|data-files|resources-grid/, name);
  }
});

test('the welcome: no logo, an invitation in Gloock; a box of glass; « 0 % » under the pointer only', async () => {
  const html = await read('index.html'),
    css = await read('moodix.css');
  const welcome = html.slice(html.indexOf('<div id="welcome"'), html.indexOf('<form class="composer"'));
  // « Récit » (direction-artistique.md): the word « idée » in the colour of the room.
  assert.match(welcome, /<h1>Racontez-moi votre <span class="welcome-accent">idée<\/span>\.<\/h1>/);
  assert.doesNotMatch(welcome, /welcome-logo|mdx-white|Votre modèle|Votre machine/);
  assert.match(css, /#welcome h1 \{[^}]*font-family: var\(--font-display\);[^}]*font-size: 66px;/);
  assert.match(css, /\.welcome-accent \{\n {2}color: var\(--accent\);/);
  // Its box says what to write; in a conversation, « Écrivez à Moodix… » (on vouvoie partout).
  assert.match(html, /<textarea id="prompt" rows="1" maxlength="100000" placeholder="Une image, un plan, un son… quelques mots suffisent\."><\/textarea>/);
  assert.match(await read('app.js'), /\? 'Écrivez à Moodix…'\n {4}: 'Une image, un plan, un son… quelques mots suffisent\.';/);
  // Being written in: its border of 1 px a little lighter, no ring around it; the box of glass.
  assert.match(css, /\.composer:has\(textarea:focus-visible\),\n\.composer:focus-within \{\n {2}outline: none;/);
  assert.match(css, /:root:not\(\[data-theme='light'\]\) #chat-form\.composer \{[^}]*background: var\(--glass\);[^}]*backdrop-filter: blur\(24px\) saturate\(1\.15\);/);
  assert.match(css, /:root:not\(\[data-theme='light'\]\) #chat-form\.composer:focus-within \{\n {2}border-color: rgba\(238, 232, 222, 0\.17\);/);
  // Joindre and Réflexion of 34 px (corners of 8), Envoyer of 38 px (corners of 10).
  assert.match(css, /#chat-form :is\(#attach, #thinking\) \{[^}]*width: 34px;[^}]*height: 34px;[^}]*border-radius: var\(--radius-s\);/);
  assert.match(css, /#chat-form \.send-button \{[^}]*width: 38px;[^}]*height: 38px;[^}]*border-radius: var\(--radius-l\);/);
  // The share of the context: hidden, its room kept; shown over the box, on focus, or nearly full.
  assert.match(css, /\.context-meter \{\n {2}opacity: 0;/);
  assert.match(css, /#chat-form:hover ~ \.context-meter,\n\.context-meter:hover,\n\.context-meter:focus-visible,\n\.context-meter\[data-warning='near'\],\n\.context-meter\[data-warning='full'\] \{\n {2}opacity: 1;/);
  // No colour at the top of the cards of suggestion.
  assert.doesNotMatch(css, /\.suggestions button:nth-child\(\d\) \{\n {2}border-top: 2px solid/);
});

test('the logo opens the accueil, a new conversation in the project in hand, from any view (16/11)', async () => {
  const app = await read('app.js'),
    source = app.slice(app.indexOf('function goHome('), app.indexOf("$('brand-home').onclick"));
  for (const [view, libraryProject, project] of [
    ['studio', undefined, 'p1'],
    ['chat', undefined, 'p1'],
    // The Pellicule of one project: the accueil of that project; of all of them, the conversation's.
    ['library', 'p2', 'p2'],
    ['library', 'all', 'p1'],
  ]) {
    const state = { view, projectId: 'p1', libraryProject },
      done = [];
    const context = {
      state,
      document: { body: { dataset: { chat: 'open' } } },
      requestSettingsClose: run => run(),
      switchView: async (kind, apply) => {
        done.push(['view', kind]);
        apply();
      },
      projectUI: { render() {} },
      syncViews() {},
      updateControls() {},
      newConversation: async into => done.push(['new', into]),
    };
    runInNewContext(source + '\nthis.goHome = goHome;', context);
    context.goHome();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(done, [['view', 'chat'], ['new', project]], view);
    // « + Nouvelle conversation » of the Pellicule: the welcome in the project it names.
    done.length = 0;
    state.view = view;
    context.goHome('p3');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(done, [['view', 'chat'], ['new', 'p3']], view + ', a project named');
    assert.equal(state.view, 'chat');
    assert.equal(context.document.body.dataset.chat, undefined, 'the chat of the Studio is folded');
  }
  // Nothing while the application updates or closes.
  const busy = { state: { view: 'studio', updating: true }, requestSettingsClose: () => assert.fail('not while it updates') };
  runInNewContext(source + '\nthis.goHome = goHome;', busy);
  busy.goHome();
});

test('the Éclipse of the word « Moodix » is a filled shape: not the stroke of the pictures of the bar', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../public/moodix.css', import.meta.url), 'utf8');
  // (More specific than `.top-bar svg`, which gives every picture of the bar a stroke of 1.7.)
  assert.match(css, /\.top-brand \.brand-eclipse \{\r?\n  stroke: none;\r?\n\}/);
});

test('a very narrow window: the word « Moodix » never goes over « Chat »; under 400 px its Éclipse alone', async () => {
  const css = await read('moodix.css');
  // 520 px or less: the word smaller (20 px, some 76 px wide), its Éclipse with it.
  assert.match(css, /@media \(max-width: 520px\) \{\n {2}\.top-bar \{\n {4}padding: 0 12px;\n {2}\}[^]*?\n {2}\.top-name \{\n {4}font-size: 20px;\n {2}\}/);
  // The bar then: 12 px on each side, two gaps of 8 px, the three places in the middle (some
  // 190 px); each side column has half of what is left. The word fits down to some 382 px of
  // window; under it, it went over « Chat » (nothing cut it).
  assert.match(css, /@media \(max-width: 760px\) \{\n {2}\.top-bar \{\n {4}gap: 8px;/);
  const side = width => (width - 2 * 12 - 2 * 8 - 190) / 2;
  assert.ok(side(401) >= 76, 'the word still fits where it is kept');
  assert.ok(side(360) < 76, 'and no longer in a narrower window');
  // 400 px or less: the letters take no room, the Éclipse alone (18 px) is the link to the chat.
  assert.match(
    css,
    /@media \(max-width: 400px\) \{\n {2}\.top-name \{\n {4}font-size: 0;\n {2}\}\n {2}\.top-name \.brand-eclipse \{\n {4}width: 18px;\n {4}height: 18px;\n {4}margin: 0;\n {2}\}\n\}/,
  );
  assert.ok(side(280) >= 18);
  // Nothing changes in a wide window: the rules of the word outside those two blocks are as they were.
  assert.equal(css.match(/\.top-name \{/g).length, 3);
  assert.match(css, /\n\.top-name \{\n {2}font-family: var\(--font-display\);\n {2}font-size: 26px;\n {2}font-weight: 400;\n {2}line-height: 1;\n {2}white-space: nowrap;\n\}/);
});
