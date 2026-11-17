import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DEFAULTS, ROOMS, grainImage, refreshLight, roomSettings, roomStyle, showTakeReady } from '../public/room.mjs';

// Read as the page is written, whatever the ends of line of this copy (a checkout on Windows has CRLF).
const read = async name => (await readFile(new URL('../public/' + name, import.meta.url), 'utf8')).replaceAll(String.fromCharCode(13, 10), String.fromCharCode(10));
const drawn = image => decodeURIComponent(image.slice('url("data:image/svg+xml,'.length, -2));

test('a saved setting is completed, and kept within its choices', () => {
  assert.deepEqual(roomSettings(), {
    room: 'salle',
    light: 'plusieurs',
    grain: 'poudre',
    dose: 40,
    motion: '24',
    filters: ['diffusion', 'lumiere'],
  });
  assert.deepEqual(
    roomSettings({ room: 'velours', light: 'une', grain: 'film', dose: 73, motion: 'fige', filters: ['centre', 'x', 'lumiere'] }),
    { room: 'velours', light: 'une', grain: 'film', dose: 75, motion: 'fige', filters: ['lumiere', 'centre'] },
  );
  assert.equal(roomSettings({ room: 'cinema' }).room, 'salle');
  assert.equal(roomSettings({ dose: 'beaucoup' }).dose, 40);
  assert.equal(roomSettings({ dose: 140 }).dose, 100);
  assert.equal(roomSettings({ motion: 'vite' }).motion, '24');
});

test('what the sheet reads: the grain is its base times the dose; the light and the vignette follow the lighting', () => {
  const plain = roomStyle({});
  assert.deepEqual(plain.data, { room: 'salle', light: 'plusieurs', grain: 'poudre', motion: '24', filters: 'diffusion lumiere' });
  // Grey noise in overlay with « Lumière »: 0.5 × 40 %.
  assert.equal(plain.variables['--grain-opacity'], '0.2');
  assert.equal(plain.variables['--grain-blend'], 'overlay');
  assert.deepEqual([plain.variables['--light-strength'], plain.variables['--vignette']], ['1', '0.55']);
  // Bright points without it: 0.15 × 60 %.
  const points = roomStyle({ filters: ['diffusion'], dose: 60, light: 'discret' });
  assert.equal(Number(points.variables['--grain-opacity']).toFixed(3), '0.090');
  assert.equal(points.variables['--grain-blend'], 'normal');
  assert.deepEqual([points.variables['--light-strength'], points.variables['--vignette']], ['0.4', '0.18']);
  assert.deepEqual(
    [roomStyle({ light: 'une' }).variables['--light-strength'], roomStyle({ light: 'une' }).variables['--vignette']],
    ['0.7', '0.32'],
  );
  assert.equal(roomStyle({ grain: 'aucun' }).variables['--grain-image'], 'none');
});

test('each grain its noise; the diffusion is baked into the tile, never a live blur', () => {
  for (const [grain, frequency, octaves] of [
    ['poudre', 1.25, 1],
    ['fin', 0.9, 2],
    ['film', 0.62, 3],
    ['gros', 0.4, 3],
  ]) {
    const svg = drawn(grainImage(grain, ['diffusion']));
    assert.match(svg, new RegExp(`baseFrequency='${frequency}' numOctaves='${octaves}' stitchTiles='stitch'`));
    assert.match(svg, /<feGaussianBlur stdDeviation='0\.6'\/>/);
  }
  assert.doesNotMatch(drawn(grainImage('poudre', [])), /feGaussianBlur/);
  // « Lumière »: a grey noise, all opaque; without it, bright points only.
  assert.match(drawn(grainImage('poudre', ['lumiere'])), /type='saturate' values='0'.*tableValues='1 1'/);
  assert.match(drawn(grainImage('poudre', [])), /values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 2\.4 0 0 0 -1\.45'/);
});

test('the sheet draws the room before any script: the default tile of room.mjs, a palette for each room', async () => {
  const css = await read('moodix.css'),
    html = await read('index.html');
  assert.ok(css.includes(`background-image: var(--grain-image, ${grainImage(DEFAULTS.grain, DEFAULTS.filters)});`));
  for (const room of ROOMS.slice(1))
    assert.match(css, new RegExp(`:root\\[data-room='${room}'\\]:not\\(\\[data-theme='light'\\]\\) \\{[^}]*--room-bg: #[0-9a-f]{6};`));
  const { data } = roomStyle(DEFAULTS);
  for (const [name, value] of Object.entries(data)) assert.ok(html.includes(` data-${name}="${value}"`), name);
  assert.match(html, /<div class="room" aria-hidden="true"><img class="room-veil" alt="" hidden><img class="room-glow" alt="" hidden>/);
  assert.match(html, /<div class="room-dither" aria-hidden="true"><\/div>\n<\/body>/);
});

test('the grain stops during a generation, behind a window, out of sight, when asked, and with less motion', async () => {
  const css = (await read('moodix.css')).replace(/\r\n/g, '\n');
  assert.ok(
    css.includes(
      ":root[data-motion='fige'] .room-grain,\n:root[data-page-hidden='true'] .room-grain,\n" +
        ":root[data-generating='true'] .room-grain,\nbody:has(dialog[open]) .room-grain {\n  animation-play-state: paused;\n}",
    ),
  );
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n {2}\.room-grain \{\n {4}animation: none;\n {2}\}\n\}/);
  // 24 images a second: ten places in 0.4167 s, without passing between them.
  assert.match(css, /animation: room-grain 0\.4167s steps\(1, end\) infinite;/);
  const places = css.slice(css.indexOf('@keyframes room-grain'), css.indexOf(":root[data-motion='fige'] .room-grain"));
  assert.equal(places.match(/transform: translate\(/g).length, 10);
  const app = await read('app.js');
  assert.match(app, /document\.documentElement\.dataset\.generating = String\(Boolean\(state\.generating \|\| toolBusy\)\);/);
});

function fakeRoom() {
  const element = () => ({ src: '', hidden: true });
  const parts = { '.room-veil': element(), '.room-glow': element() };
  return { parts, root: { querySelector: selector => parts[selector] ?? null } };
}

test('the light of the room: the newest take with a picture, made once and kept; the newest take of all said', async () => {
  const runs = [
    { id: 'son', mediaType: 'audio', outputs: [{}] },
    { id: 'image', mediaType: 'image', outputs: [{ thumbUrl: '/media/thumbs/a' }] },
  ];
  const asked = [];
  const api = async path => {
    asked.push(path);
    return { json: async () => ({ runs }) };
  };
  // Already made for this take: read back, nothing drawn again.
  const storage = { getItem: () => JSON.stringify({ id: 'image', veil: 'voile', glow: 'lueur' }), setItem() {} };
  const { parts, root } = fakeRoom();
  assert.equal(await refreshLight(api, { root, storage }), 'son');
  assert.deepEqual(asked, ['library?images=0']);
  assert.deepEqual(
    [parts['.room-veil'].src, parts['.room-glow'].src, parts['.room-veil'].hidden, parts['.room-glow'].hidden],
    ['voile', 'lueur', false, false],
  );
  // No take yet: no light; the Pellicule out of reach: nothing said.
  runs.length = 0;
  assert.equal(await refreshLight(api, { root, storage }), null);
  assert.equal(parts['.room-veil'].hidden, true);
  assert.equal(await refreshLight(async () => Promise.reject(new Error('hors ligne')), { root, storage }), undefined);
});

test('a take ready out of sight: a dot of the accent on the icon of the tab, until the page is seen again', () => {
  const removed = [],
    listeners = new Map();
  const links = ['/favicon.ico?v=4', '/favicon.svg?v=4'].map(href => {
    const link = { href };
    link.remove = () => {
      removed.push(href);
      head.children = head.children.filter(child => child !== link);
    };
    return link;
  });
  const head = {
    children: [...links],
    querySelectorAll: () => head.children.filter(child => links.includes(child)),
    querySelector: () => head.children.find(child => child.dataset && 'takeReady' in child.dataset) ?? null,
    append: (...items) => head.children.push(...items),
  };
  const doc = {
    hidden: true,
    head,
    documentElement: {},
    defaultView: { getComputedStyle: () => ({ getPropertyValue: name => (name === '--accent' ? ' #e7c1d2' : '') }) },
    createElement: () => {
      const link = { dataset: {} };
      link.remove = () => (head.children = head.children.filter(child => child !== link));
      return link;
    },
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name),
  };
  showTakeReady(doc);
  const ready = head.children.at(-1);
  assert.deepEqual(removed, ['/favicon.ico?v=4', '/favicon.svg?v=4']);
  assert.equal(ready.type, 'image/svg+xml');
  const svg = decodeURIComponent(ready.href.slice('data:image/svg+xml,'.length));
  assert.match(svg, /<rect width='16' height='16' rx='3\.5' fill='#141318'\/>/);
  assert.match(svg, /<circle [^>]*fill='#e7c1d2'/);
  // Twice: one dot.
  showTakeReady(doc);
  assert.equal(head.children.filter(child => child.dataset && 'takeReady' in child.dataset).length, 1);
  doc.hidden = false;
  listeners.get('visibilitychange')();
  assert.ok(!head.children.includes(ready));
  assert.deepEqual(head.children.slice(-2), links);
  assert.equal(listeners.size, 0);
});
