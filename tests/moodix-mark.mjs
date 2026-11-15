import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = name => readFile(new URL('../public/' + name, import.meta.url), 'utf8');
const ROWS = ['#3D6BF5', '#22A060', '#F6C343', '#E8402F'];

/** The cells of a drawing of the logo: x, y, size, corners, colour, opacity. */
function cells(svg) {
  return [...svg.matchAll(/<rect ([^>]*)\/>/g)]
    .map(found => Object.fromEntries([...found[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(pair => pair.slice(1))))
    .filter(cell => cell.width === '5');
}

for (const file of ['assets/moodix-mark.svg', 'favicon.svg']) {
  test(`${file}: the full logo, 16 whole cells, one colour a row (moodix-design.md 1, Petit logo)`, async () => {
    const svg = await read(file);
    assert.match(svg, /viewBox="0 0 32 32"/);
    const found = cells(svg);
    assert.equal(found.length, 16);
    for (const [index, cell] of found.entries()) {
      const row = Math.floor(index / 4),
        column = index % 4;
      assert.equal(Number(cell.x), +(4.6 + column * 5.95).toFixed(2));
      assert.equal(Number(cell.y), +(4.6 + row * 5.95).toFixed(2));
      assert.equal(cell.height, '5');
      assert.equal(cell.rx, '1.1');
      assert.equal(cell.fill.toUpperCase(), ROWS[row]);
      // No cell lit or dimmed: the earlier mark (100 / 58 / 30 %) was a still of the movement.
      assert.equal(cell.opacity, undefined);
    }
  });
}

test('the favicon lies on its dark square; the mark of the chat has no ground', async () => {
  assert.match(await read('favicon.svg'), /<rect width="32" height="32" rx="7" fill="#14161B"\/>/);
  assert.doesNotMatch(await read('assets/moodix-mark.svg'), /<rect width="32"/);
});

test('every reference to the logo asks for its new version (?v=3), never the one a browser kept', async () => {
  const html = await read('index.html');
  for (const name of ['favicon.ico', 'icon-512.png', 'favicon.svg', 'apple-touch-icon.png'])
    assert.match(html, new RegExp(`href="/${name.replace('.', '\\.')}\\?v=3"`));
  assert.doesNotMatch(html, /\?v=2/);
  const pages = [html, await read('app.js'), await read('moodix.css'), await read('studio.mjs')].join('\n');
  const marks = [...pages.matchAll(/\/assets\/moodix-mark\.svg[^'")\s]*/g)].map(found => found[0]);
  assert.ok(marks.length >= 3, 'the sidebar, the chat, the settings Moodix AI may change');
  for (const mark of marks) assert.equal(mark, '/assets/moodix-mark.svg?v=3');
});

test('the movement of the thought draws the same cells, whole, one colour a row', async () => {
  const app = await read('app.js');
  assert.match(app, /const MARK_COLOURS = \['#3D6BF5', '#22A060', '#F6C343', '#E8402F'\];/);
  const mark = app.slice(app.indexOf('function moodixMark()'), app.indexOf('function markThinking('));
  assert.match(mark, /\(4\.6 \+ column \* 5\.95\)/);
  assert.match(mark, /\(4\.6 \+ row \* 5\.95\)/);
  assert.doesNotMatch(mark, /opacity/);
});
