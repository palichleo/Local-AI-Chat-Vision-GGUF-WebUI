import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { quoteText } from '../public/copy.mjs';
import { markdownToHtml } from '../public/markdown.mjs';
import * as sessionCopies from '../public/session-copies.mjs';

test('copy actions belong to quotes and fenced code, while ordinary prose and lists have none', () => {
  assert.doesNotMatch(
    markdownToHtml('### Titre\n\nUne réponse **normale**.\n\n- un élément\n- un autre'),
    /copy-button|data-copy-/,
  );
  const quote = markdownToHtml('> *Un prompt à copier.*');
  assert.match(
    quote,
    /<blockquote[^>]*><div class="copy-content"><p><em>Un prompt à copier\.<\/em><\/p><\/div><button[^>]*data-copy-quote/,
  );
  const code = markdownToHtml('```js\nconst x = "<tag>";\n```');
  assert.match(code, /<div class="code-block copy-block"><div class="copy-content">/);
  assert.match(code, /<pre><code>const x = &quot;&lt;tag&gt;&quot;;<\/code><\/pre><\/div><button[^>]*data-copy-code/);
  assert.match(quote, /class="sr-only">Copier/);
});

test('quoted text retains paragraphs and line breaks without copying labels or Markdown formatting', () => {
  const text = value => ({ nodeType: 3, textContent: value });
  const element = (tagName, children = [], copyUI = false) => ({
    nodeType: 1,
    tagName,
    childNodes: children,
    matches: () => copyUI,
  });
  const content = element('DIV', [
    element('P', [text('Un '), element('EM', [text('prompt')]), text(' complet.')]),
    element('P', [text('Ligne deux'), element('BR'), text('Ligne trois')]),
    element('BUTTON', [text('Copier')], true),
    element('SPAN', [text('javascript')], true),
  ]);
  assert.equal(quoteText(content).trim(), 'Un prompt complet.\n\nLigne deux\nLigne trois');
});

test('conversation alignment follows scrollbar changes and handles the hidden welcome scroller', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function alignConversation()'),
    end = source.indexOf('\nalignConversation();', start) + '\nalignConversation();'.length;
  let update, observed;
  const values = [];
  const area = { offsetWidth: 900, clientWidth: 890 };
  const context = {
    ...sessionCopies,
    $: id => {
      assert.equal(id, 'chat-area');
      return area;
    },
    document: { documentElement: { style: { setProperty: (key, value) => values.push([key, value]) } } },
    ResizeObserver: class {
      constructor(callback) {
        update = callback;
      }
      observe(target) {
        observed = target;
      }
    },
  };
  runInNewContext(source.slice(start, end), context);
  assert.equal(observed, area);
  assert.deepEqual(values.at(-1), ['--chat-scrollbar', '10px']);
  area.clientWidth = 900;
  update();
  assert.deepEqual(values.at(-1), ['--chat-scrollbar', '0px']);
  area.offsetWidth = 0;
  area.clientWidth = 0;
  update();
  assert.deepEqual(values.at(-1), ['--chat-scrollbar', '0px']);
  area.offsetWidth = 420;
  area.clientWidth = 414;
  update();
  assert.deepEqual(values.at(-1), ['--chat-scrollbar', '6px']);
});

test('a new conversation suggests what the application makes: an image, a shot, a sound, each as a label', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    // Read with the line endings of the checkout taken out (CRLF on a fresh copy under Windows):
    // the last pattern below spans several lines.
    app = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const shortcuts = html.match(/<div class="suggestions"[^>]*>.*?<\/div>/s)[0];
  // « Créer une image · Tourner un plan · Composer un son » (direction-artistique.md, « Récit »).
  assert.deepEqual(
    [...shortcuts.matchAll(/<span>(.*?)<\/span><\/button>/g)].map(match => match[1]),
    ['Créer une image', 'Tourner un plan', 'Composer un son'],
  );
  // Each puts a label at the start of the box (« Image × »), and says what is asked when sent.
  assert.deepEqual(
    [...shortcuts.matchAll(/data-prompt="(.*?)" data-label="(.*?)" aria-pressed="false"/g)].map(match => [match[1], match[2]]),
    [
      ['Crée une image : ', 'Image'],
      ['Crée une vidéo : ', 'Plan'],
      ['Crée un son : ', 'Son'],
    ],
  );
  assert.doesNotMatch(html, /id="suggest-image"/);
  // Nothing written in the box any more: a label, the shortcut chosen underlined.
  assert.doesNotMatch(app, /\$\('prompt'\)\.value = button\.dataset\.prompt/);
  assert.match(app, /item\.setAttribute\('aria-pressed', String\(item === promptLabel\)\)/);
  // Sent: the label becomes the start of the message, before sendMessage reads it (capture).
  assert.match(app, /if \(text && !text\.startsWith\(asked\.trim\(\)\)\) \$\('prompt'\)\.value = asked \+ text;\n {4}setPromptLabel\(null\);\n {2}\},\n {2}true,\n\);/);
});

test('the bar of the chat stays on one line: the name of the model gives way first, then the reflection, then the sentence at the right', async () => {
  const css = (await readFile(new URL('../public/moodix.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n'),
    from = css.indexOf('@media (min-width: 521px) {\n  #chat-form .composer-tools {'),
    bar = css.slice(from, css.indexOf('\n}\n', from));
  assert.ok(from > 0 && bar.length > 200);
  // One line: the left side takes what the right side leaves, and nothing in it but the model
  // shrinks by itself; « Joindre » and the buttons at the right keep their width.
  assert.match(bar, /#chat-form \.composer-options \{\n {4}flex: 0 1 auto;\n {4}flex-wrap: nowrap;\n {2}\}/);
  assert.match(bar, /#chat-form #attach,\n {2}#chat-form \.send-tools > button \{\n {4}flex: none;\n {2}\}/);
  // (0.6.92) No « ● Studio » in the box of the chat of the Studio any more: nor what drew it.
  const [html, app] = await Promise.all(
    ['index.html', 'app.js'].map(name => readFile(new URL('../public/' + name, import.meta.url), 'utf8')),
  );
  for (const source of [css, html, app]) assert.doesNotMatch(source, /composer-context|mode-dot/);
  assert.match(css, /#chat-form :is\(#model-choice, #effort-choice\) \{[^}]*flex: 0 1 auto;[^}]*min-width: 0;[^}]*max-width: 210px;/);
  assert.match(css, /#chat-form #effort-choice \{\n {2}flex-shrink: 0;\n {2}max-width: 190px;/);
  // The sentence at the right is cut short, in the room its side has.
  assert.match(bar, /#chat-form \.compose-state \{\n {4}flex: 0 1 auto;\n {4}min-width: 0;\n {4}padding: 3px 0;\n {4}overflow: hidden;\n {4}text-overflow: ellipsis;\n {4}white-space: nowrap;\n {2}\}/);
  // What the left side keeps at the least: « Joindre », the model down to 72 px, the reflection
  // down to 96 px, 2 px between them; the same in the Studio.
  const JOIN = 34,
    GAP = 2,
    MODEL = 72,
    EFFORT = 96,
    BETWEEN = 10,
    left = Number(bar.match(/#chat-form \.composer-tools \{\n {4}--bar-left: (\d+)px;/)[1]);
  assert.equal(left, JOIN + GAP + MODEL + GAP + EFFORT);
  assert.doesNotMatch(bar, /--bar-left: (?!206px)/, 'one --bar-left for every bar');
  assert.match(css, /#chat-form \.composer-tools \{[^}]*gap: 10px;/);
  assert.match(css, /#chat-form \.composer-options \{[^}]*gap: 2px;/);
  assert.match(bar, /#chat-form #effort-choice \{\n {4}max-width: min\(190px, calc\(100% - var\(--bar-left\) \+ 96px\)\);\n {2}\}/);
  assert.match(bar, /#chat-form \.send-tools \{\n {4}max-width: calc\(100% - 10px - var\(--bar-left\)\);\n {2}\}/);
  // The widths those rules give to a bar `width` px wide: the right side first (never more than
  // the bar less what the left side keeps), the left side in the rest; in it the reflection as
  // long as the model has its 72 px, the model in what is left.
  const lay = ({ width, model, effort, sentence, buttons }) => {
    const natural = JOIN + GAP + model + GAP + effort,
      right = Math.min(sentence + buttons, width - BETWEEN - left),
      options = Math.min(natural, width - BETWEEN - right),
      reflection = Math.min(effort, 190, options - left + EFFORT),
      name = Math.min(model, options - JOIN - GAP - GAP - reflection);
    return { model: name, effort: reflection, sentence: right - buttons, room: width - BETWEEN - right - (natural - model - effort + name + reflection) };
  };
  // The longest of each: a name at the 210 px of its button, « Réflexion très élevée » at its 190 px,
  // « Proposition dans le Studio · un message la refuse » (49 characters of 7.2 px in mono 12 px:
  // 353 px), then 13 px and « Envoyer » (38 px).
  const longest = { model: 210, effort: 190, sentence: 353, buttons: 13 + 38 };
  // The box of the chat, 760 px: 728 px inside its border (1 px) and its padding (15 px). The
  // sentence whole, the reflection whole, the name of the model in 86 px (50 px of letters).
  assert.deepEqual(lay({ width: 728, ...longest }), { model: 86, effort: 190, sentence: 353, room: 0 });
  // « Réflexion moyenne » (some 155 px): the name has 121 px.
  assert.deepEqual(lay({ width: 728, ...longest, effort: 155 }), { model: 121, effort: 155, sentence: 353, room: 0 });
  // The panel of the Agent over the Studio, 700 px: the box 658 px, 626 px inside, without « Studio »
  // (0.6.92). The sentence whole, the model at its least, the reflection in 102 px: one line.
  assert.deepEqual(lay({ width: 626, ...longest }), { model: 72, effort: 102, sentence: 353, room: 0 });
  // The same panel while a take is made (« Génération en cours… », 144 px): only the name gives way.
  assert.deepEqual(lay({ width: 626, ...longest, sentence: 144 }), { model: 193, effort: 190, sentence: 144, room: 0 });
  // Nothing said at the right (the box at rest): nothing is cut, room is left.
  assert.deepEqual(lay({ width: 626, ...longest, sentence: 0 }), { model: 210, effort: 190, sentence: 0, room: 127 });
  // A window of 520 px or less keeps its second line (the buttons narrower), as before.
  assert.match(css, /\.composer-options \{\n {2}min-width: 0;\n {2}flex-wrap: wrap;\n {2}row-gap: 6px;\n\}/);
  assert.match(css, /@media \(max-width: 520px\) \{\n {2}#chat-form #model-choice \{\n {4}max-width: 110px;/);
});

test('under a message, only the last exchange can be taken back: nothing copies a whole message', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const actions = source.slice(source.indexOf('function turnActions('), source.indexOf('async function takeBack('));
  // Copying stays where the first test of this file puts it: the quotes and the code blocks.
  assert.deepEqual(
    [...actions.matchAll(/action\('([^']+)'/g)].map(match => match[1]),
    ['Modifier', 'Régénérer'],
  );
  assert.doesNotMatch(actions, /clipboard|Copier/);
});

test('the interface names its places in French: Chat, Studio, Bobine, Archives, Jour and Nuit; no « Créations », no « Fichiers »', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  // « Pellicule » in the texts only (0.6.0): the routes, the modules and the data keep « library ».
  assert.match(html, /id="chat-open"[^>]*>Chat<\/button>/);
  assert.match(html, /id="studio-open"[^>]*>Studio<\/button>/);
  // (0.6.148) « Bobine » (ex-Montage) beside the Studio, « Archives » (ex-Pellicule).
  assert.match(html, /id="bobine-open"[^>]*>Bobine<\/button>/);
  assert.match(html, /id="library-open"[^>]*>Archives<\/button>/);
  assert.doesNotMatch(html, />(Pellicule|Montage)</);
  assert.doesNotMatch(html, />Bibliothèque</);
  // No home page any more (0.5.123): a project opens in the library.
  assert.doesNotMatch(html, /id="home-open"|id="home-view"|>Accueil</);
  // The references are kept from the Studio and the chats of a project: no panel of files.
  assert.doesNotMatch(html, /id="all-files"|id="assets-panel"|assets-resources-tab/);
  // The creations are in the Sortie of the Studio, shared by the project.
  assert.doesNotMatch(html, /assets-output-tab|output-pane|gallery-list/);
  assert.match(app, /dark \? 'Jour' : 'Nuit'/);
  // The English names they replace are gone from what the user reads.
  assert.doesNotMatch(html, />Home<|All files|>Output</);
  assert.doesNotMatch(app, /'Day'|'Night'/);
});

test('no panel of files to open: no button, no tab of creations to keep up to date', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /openFiles|all-files|assets-close|showCreations|renderGallery/);
});
