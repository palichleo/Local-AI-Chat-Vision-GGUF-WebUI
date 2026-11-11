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
    end = source.indexOf('setupMaterialLighting(document.', start);
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

test('a new conversation suggests what the application makes: an image, a video, or starting from an image', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const cards = html.match(/<div class="suggestions">.*?<\/div>/s)[0];
  const titles = [...cards.matchAll(/<strong>(.*?)<\/strong>/g)].map(match => match[1]);
  assert.deepEqual(titles, ['Créer une image', 'Créer une vidéo', 'Partir d’une image']);
  // Two of them start the request in the message box, the third opens the file chooser.
  assert.deepEqual(
    [...cards.matchAll(/data-prompt="(.*?)"/g)].map(match => match[1]),
    ['Crée une image : ', 'Crée une vidéo de 5 secondes : '],
  );
  assert.match(cards, /<button id="suggest-image">/);
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
