import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const renderer = new URL('../public/markdown.mjs', import.meta.url);

test('model Markdown renders headings, emphasis, lists and literal escapes', async () => {
  assert.ok(existsSync(renderer), 'Le module de rendu Markdown doit exister.');
  const { markdownToHtml } = await import(renderer);
  const html = markdownToHtml('### Composition\n\nUne **structure forte** et une *ambiance calme*.\n\n* **Verticalité :** une silhouette\n* Horizon\n\n1. Première étape\n2. Deuxième étape\n\n\\*texte littéral\\* et `snake_case`');
  assert.match(html, /<h3>Composition<\/h3>/);
  assert.match(html, /<strong>structure forte<\/strong>/);
  assert.match(html, /<em>ambiance calme<\/em>/);
  assert.match(html, /<ul>[\s\S]*<li>[\s\S]*<strong>Verticalité :<\/strong>/);
  assert.match(html, /<ol>[\s\S]*<li>[\s\S]*Première étape/);
  assert.match(html, /\*texte littéral\*/);
  assert.match(html, /<code>snake_case<\/code>/);
});

test('nested lists, quotations, tables and rules keep their structure', async () => {
  const { markdownToHtml } = await import(renderer);
  const html = markdownToHtml('- Parent\n  - Enfant\n- Suite\n\n> Une citation **utile**.\n\n| Nom | Valeur |\n| --- | --- |\n| A | **42** |\n\n---');
  assert.equal((html.match(/<ul>/g) || []).length, 2);
  assert.match(html, /<blockquote[^>]*>[\s\S]*<strong>utile<\/strong>/);
  assert.match(html, /<table>[\s\S]*<th>Nom<\/th>[\s\S]*<td><strong>42<\/strong><\/td>/);
  assert.match(html, /<hr>/);
});

test('code fences preserve HTML and Markdown literally, including while streaming', async () => {
  const { markdownToHtml } = await import(renderer);
  const source = '```html\n<div>**gras** & texte</div>\n';
  const html = markdownToHtml(source);
  assert.match(html, /<pre>[\s\S]*<code>/);
  assert.match(html, /&lt;div&gt;\*\*gras\*\* &amp; texte&lt;\/div&gt;/);
  assert.doesNotMatch(html, /<strong>|<div>/);
  assert.match(markdownToHtml(source + '```'), /&lt;div&gt;/);
});

test('model HTML, unsafe links and image embeds cannot create active content', async () => {
  const { markdownToHtml } = await import(renderer);
  const html = markdownToHtml('# <img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n\n[Ouvrir](javascript:alert(1)) [Autre](data:text/html,test)\n\n![image](https://example.org/image.png)\n\n[Source](https://example.org/?a=1&b=2)');
  assert.doesNotMatch(html, /<(?:img|script|svg|iframe)\b/i);
  assert.doesNotMatch(html, /href=["'](?:javascript|data):/i);
  assert.match(html, /&lt;img/);
  assert.match(html, /href="https:\/\/example\.org\/\?a=1&amp;b=2"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('incomplete emphasis is shown during streaming and completed markers become formatting', async () => {
  const { markdownToHtml } = await import(renderer);
  assert.match(markdownToHtml('### Titre\n\n**en cours'), /\*\*en cours/);
  assert.match(markdownToHtml('### Titre\n\n**en cours**'), /<strong>en cours<\/strong>/);
  assert.equal(markdownToHtml(''), '');
  assert.doesNotMatch(markdownToHtml('snake_case et mot_suivant'), /<em>/);
});
