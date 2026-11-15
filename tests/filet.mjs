import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

class Node {
  constructor(name) {
    this.name = name;
    this.attributes = {};
    this.children = [];
  }
  setAttribute(key, value) {
    this.attributes[key] = value;
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = children;
  }
}
globalThis.document = { createElementNS: (namespace, name) => new Node(name) };
const { drawFilet, STOPS } = await import('../public/filet.mjs');

const draw = (width, height) => {
  const svg = drawFilet(new Node('svg'), width, height);
  const [defs, ...paths] = svg.children;
  const [top, left, right] = defs.children;
  return { svg, top, left, right, paths };
};

test('the filet: 1.5 px, from the middle of one top corner to the middle of the other (moodix-design.md 7 bis 20)', () => {
  const { svg, top, paths } = draw(1038, 763);
  assert.equal(svg.attributes.viewBox, '0 0 1038 763');
  // The top and the two sides; nothing at the bottom.
  assert.equal(paths.length, 3);
  for (const path of paths) assert.equal(path.attributes['stroke-width'], '1.5');
  // The middle of the arc (radius 16 − 0.75, centred 16 px in): 16 − 15.25 × √½ = 5.22 px.
  assert.equal(paths[0].attributes.d, 'M 5.22 5.22 A 15.25 15.25 0 0 1 16 0.75 H 1022 A 15.25 15.25 0 0 1 1032.78 5.22');
  assert.deepEqual([top.attributes.x1, top.attributes.x2], ['5.22', '1032.78']);
  // Each colour pure at the middle of its old segment.
  assert.deepEqual(
    top.children.map(stop => [stop.attributes.offset, stop.attributes['stop-color']]),
    [
      ['0.19', '#3d6bf5'],
      ['0.476', '#22a060'],
      ['0.714', '#f6c343'],
      ['0.929', '#e8402f'],
    ],
  );
});

test('down the sides from the corners, blue to green and red to yellow, gone at 620 px', () => {
  const { left, right, paths } = draw(1038, 763);
  assert.equal(paths[1].attributes.d, 'M 5.22 5.22 A 15.25 15.25 0 0 0 0.75 16 V 620');
  assert.equal(paths[2].attributes.d, 'M 1032.78 5.22 A 15.25 15.25 0 0 1 1037.25 16 V 620');
  for (const [gradient, from, to] of [
    [left, '#3d6bf5', '#22a060'],
    [right, '#e8402f', '#f6c343'],
  ]) {
    assert.deepEqual([gradient.attributes.y1, gradient.attributes.y2], ['5.22', '620']);
    assert.deepEqual(
      gradient.children.map(stop => [stop.attributes['stop-color'], stop.attributes['stop-opacity']]),
      [
        [from, '1'],
        [to, '0.75'],
        [to, '0'],
      ],
    );
  }
  // A lower window: gone before its bottom corners.
  const low = draw(900, 500);
  assert.match(low.paths[1].attributes.d, / V 484$/);
  assert.equal(low.left.attributes.y2, '484');
  // Too small for its corners: nothing.
  assert.equal(drawFilet(new Node('svg'), 20, 20).children.length, 0);
});

test('the same gradient as the foot of Générer (--mdx-gradient)', async () => {
  const css = await readFile(new URL('../public/moodix.css', import.meta.url), 'utf8');
  const gradient = css.match(/--mdx-gradient: linear-gradient\(90deg, ([^)]*)\);/)?.[1];
  assert.ok(gradient);
  assert.deepEqual(
    gradient.split(', ').map(part => {
      const [color, at] = part.split(' ');
      return [+(Number(at.replace('%', '')) / 100).toFixed(3), color];
    }),
    STOPS,
  );
});
