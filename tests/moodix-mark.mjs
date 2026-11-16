import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = name => readFile(new URL('../public/' + name, import.meta.url), 'utf8');
// The Éclipse (claude_design/maquettes/logo.md): the disc (16, 16) r 12.5 less the disc (16, 11.6)
// r 11.4, lit from below; at 16 px, the disc (8, 8) r 5.7 less the disc (8, 5.5) r 5.15.
const CRESCENT = 'M4.63 10.81A12.5 12.5 0 1 0 27.37 10.81A11.4 11.4 0 0 1 4.63 10.81Z';
const SMALL = 'M2.85 5.56A5.7 5.7 0 1 0 13.15 5.56A5.15 5.15 0 0 1 2.85 5.56Z';

test('the crescent is the full disc less the shadow disc: both its points lie on both circles', () => {
  for (const [path, [cx, cy, r], [sx, sy, s]] of [
    [CRESCENT, [16, 16, 12.5], [16, 11.6, 11.4]],
    [SMALL, [8, 8, 5.7], [8, 5.5, 5.15]],
  ]) {
    const found = path.match(/^M([\d.]+) ([\d.]+)A([\d.]+) [\d.]+ 0 1 0 ([\d.]+) ([\d.]+)A([\d.]+) [\d.]+ 0 0 1 \1 \2Z$/);
    assert.ok(found, path);
    const [, x1, y1, big, x2, y2, shadow] = found.map(Number);
    assert.deepEqual([big, shadow], [r, s]);
    for (const [x, y] of [
      [x1, y1],
      [x2, y2],
    ]) {
      assert.ok(Math.abs(Math.hypot(x - cx, y - cy) - r) < 0.01, `${x} ${y} sur le disque`);
      assert.ok(Math.abs(Math.hypot(x - sx, y - sy) - s) < 0.01, `${x} ${y} sur l'ombre`);
    }
    // The light is below: the points are above the middle, the large arc goes round by the bottom.
    assert.ok(y1 < cy && y2 < cy);
  }
});

test('the mark: the crescent and its light ring, which does not thicken; ivory, and ink on a light ground', async () => {
  for (const [file, colour] of [
    ['assets/moodix-mark.svg', '#EEE8DE'],
    ['assets/moodix-mark-encre.svg', '#0C0B0E'],
  ]) {
    const svg = await read(file);
    assert.match(svg, /viewBox="0 0 32 32"/);
    assert.ok(svg.includes(`<path d="${CRESCENT}" fill="${colour}"/>`), file);
    assert.ok(
      svg.includes(
        `<circle cx="16" cy="16" r="12.5" fill="none" stroke="${colour}" stroke-opacity=".22" stroke-width="1" vector-effect="non-scaling-stroke"/>`,
      ),
      file,
    );
  }
});

test('the favicon: the crescent alone, without its ring, on its dark tile with corners of 3.5', async () => {
  const svg = await read('favicon.svg');
  assert.match(svg, /viewBox="0 0 16 16"/);
  assert.ok(svg.includes('<rect width="16" height="16" rx="3.5" fill="#141318"/>'));
  assert.ok(svg.includes(`<path d="${SMALL}" fill="#EEE8DE"/>`));
  assert.doesNotMatch(svg, /<circle/);
});

test('every reference to the logo asks for its new version (?v=4), never the one a browser kept', async () => {
  const html = await read('index.html');
  for (const name of ['favicon.ico', 'icon-512.png', 'favicon.svg', 'apple-touch-icon.png'])
    assert.match(html, new RegExp(`href="/${name.replace('.', '\\.')}\\?v=4"`));
  assert.doesNotMatch(html, /\?v=[23]"/);
  const pages = [html, await read('app.js'), await read('moodix.css'), await read('studio.mjs')].join('\n');
  const marks = [...pages.matchAll(/\/assets\/moodix-mark(?:-encre)?\.svg[^'")\s]*/g)].map(found => found[0]);
  assert.ok(marks.length >= 2, 'Moodix AI in the Studio, in ivory and in ink');
  for (const mark of marks) assert.match(mark, /^\/assets\/moodix-mark(?:-encre)?\.svg\?v=4$/);
});

test('the mark of the chat breathes while its model thinks: one mask each, still at rest and with less motion', async () => {
  const app = await read('app.js'),
    css = await read('moodix.css');
  const mark = app.slice(app.indexOf('function moodixMark()'), app.indexOf('function markThinking('));
  assert.match(mark, /const id = `eclipse-\$\{\+\+eclipseCount\}`/);
  assert.match(mark, /<mask id="\$\{id\}"/);
  assert.match(mark, /<circle class="eclipse-shadow" cx="16" cy="11\.6" r="11\.4" fill="#000"\/>/);
  assert.match(mark, /<circle class="eclipse-sphere" cx="16" cy="16" r="12\.5" mask="url\(#\$\{id\}\)"\/>/);
  // No colour but the white and the black, nothing outside the circle.
  assert.doesNotMatch(mark, /#(?!000|fff)[0-9a-f]{3,6}\b/i);
  assert.match(css, /\.is-thinking \.eclipse-shadow \{\s*animation: eclipse-breath 4\.2s cubic-bezier\(0\.55, 0, 0\.35, 1\) infinite;\s*\}/);
  const breath = css.slice(css.indexOf('@keyframes eclipse-breath'), css.indexOf('@media', css.indexOf('@keyframes eclipse-breath')));
  assert.match(breath, /0%,\s*10% \{\s*cy: 11\.6px;\s*r: 11\.4px;\s*\}/);
  assert.match(breath, /44%,\s*56% \{\s*cy: 16px;\s*r: 0px;\s*\}/);
  assert.match(breath, /90%,\s*100% \{\s*cy: 11\.6px;\s*r: 11\.4px;\s*\}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.is-thinking \.eclipse-shadow \{\s*animation: none;\s*\}\s*\}/);
  assert.match(css, /\.eclipse-ring \{[^}]*stroke-opacity: 0\.22;[^}]*vector-effect: non-scaling-stroke;/);
});
