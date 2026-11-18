import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FAMILY_SIZES,
  FORMATS,
  formatOf,
  formatsFor,
  nearestFormat,
  nearestSize,
  sizeFits,
  sizesFor,
} from '../public/formats.mjs';

test('every listed size is clean: a multiple of 32, in its format, never twice', () => {
  // The common lists and those of a family (Krea 2's, 0.6.92).
  const lists = [
    ...FORMATS.map(format => [format, format.sizes]),
    ...Object.values(FAMILY_SIZES).flatMap(own => FORMATS.map(format => [format, own[format.id]])),
  ];
  for (const [format, list] of lists) {
    const seen = new Set();
    for (const { width, height } of list) {
      assert.equal(width % 32, 0, `${format.id} ${width}`);
      assert.equal(height % 32, 0, `${format.id} ${height}`);
      assert.equal(formatOf(width, height), format, `${width} × ${height} reads as ${format.id}`);
      assert.ok(!seen.has(width + 'x' + height));
      seen.add(width + 'x' + height);
    }
    const pixels = list.map(size => size.width * size.height);
    assert.deepEqual(pixels, [...pixels].sort((a, b) => a - b), format.id + ' sizes grow');
  }
});

test('Krea 2 has lists of its own: the two smallest sizes of each format left out, two larger ones added (0.6.92)', () => {
  const own = FAMILY_SIZES.krea2,
    named = list => list.map(({ width, height }) => `${width}x${height}`);
  assert.deepEqual(Object.keys(FAMILY_SIZES), ['krea2']);
  assert.deepEqual(Object.keys(own), FORMATS.map(format => format.id));
  for (const format of FORMATS) {
    const list = own[format.id],
      largest = format.sizes.at(-1);
    assert.deepEqual(list.slice(0, -2), format.sizes.slice(2), format.id + ': the common list less its two smallest');
    for (const size of list.slice(-2))
      assert.ok(size.width * size.height > largest.width * largest.height, `${format.id}: ${named([size])} is larger`);
  }
  // The two added to each, by the step their list takes (those to try on the card of 12 GB).
  assert.deepEqual(
    Object.fromEntries(FORMATS.map(format => [format.id, named(own[format.id].slice(-2))])),
    {
      '16:9': ['2240x1248', '2560x1440'],
      '9:16': ['1248x2240', '1440x2560'],
      '1:1': ['1792x1792', '2048x2048'],
      '4:3': ['1792x1344', '2048x1536'],
      '3:4': ['1344x1792', '1536x2048'],
      '3:2': ['1728x1152', '1920x1280'],
      '2:3': ['1152x1728', '1280x1920'],
      '21:9': ['2240x960', '2688x1152'],
    },
  );
  // Within what Krea 2 accepts (its manifest: 64 to 4096, a multiple of 8), and for Krea 2 alone:
  // the video models (LTX 2.5, MiniMax H3, SCAIL-2) and the others keep the common lists.
  const krea = { width: { min: 64, max: 4096, multipleOf: 8 }, height: { min: 64, max: 4096, multipleOf: 8 } };
  for (const format of FORMATS) {
    assert.deepEqual(sizesFor(format, krea, 'krea2'), own[format.id]);
    for (const family of [undefined, null, 'ltx25', 'minimax_h3', 'wan_scail2', 'moss', 'constructor'])
      assert.deepEqual(sizesFor(format, krea, family), format.sizes, `${format.id} for ${family}`);
  }
  assert.equal(formatsFor(krea, 'krea2').length, FORMATS.length);
  // The common lists are those of before.
  assert.deepEqual(
    FORMATS.map(format => named([format.sizes[0], format.sizes.at(-1)])),
    [
      ['512x288', '1920x1088'],
      ['288x512', '1088x1920'],
      ['384x384', '1536x1536'],
      ['384x288', '1536x1152'],
      ['288x384', '1152x1536'],
      ['384x256', '1536x1024'],
      ['256x384', '1024x1536'],
      ['672x288', '1792x768'],
    ],
  );
  // The size Krea 2 takes by itself in each format (nearest to its 1024 × 1024) does not change.
  for (const format of FORMATS)
    assert.deepEqual(nearestSize(sizesFor(format, krea, 'krea2'), 1024 * 1024), nearestSize(format.sizes, 1024 * 1024));
});

test('the format of any size, the nearest for a ratio none has; whether a model accepts a size (0.6.92)', () => {
  assert.equal(nearestFormat(1920, 1080).id, '16:9');
  assert.equal(nearestFormat(1080, 1920).id, '9:16');
  // 16:10 and 5:4 are no format of the Studio: the nearest, by their ratio.
  assert.equal(formatOf(1280, 800), null);
  assert.equal(nearestFormat(1280, 800).id, '3:2');
  assert.equal(nearestFormat(1280, 1024).id, '4:3');
  assert.equal(nearestFormat(4096, 1024).id, '21:9');
  assert.equal(nearestFormat(0, 1024), null);
  const krea = { width: { min: 64, max: 4096, multipleOf: 8 }, height: { min: 64, max: 4096, multipleOf: 8 } },
    video = { width: { multipleOf: 32 }, height: { multipleOf: 32 } };
  assert.equal(sizeFits({ width: 1920, height: 1080 }, krea), true);
  assert.equal(sizeFits({ width: 1920, height: 1084 }, krea), false);
  assert.equal(sizeFits({ width: 8192, height: 1024 }, krea), false);
  assert.equal(sizeFits({ width: 1920, height: 1080 }, video), false);
});

test('the sizes of the shipped workflows are recognised', () => {
  assert.equal(formatOf(384, 256).id, '3:2'); // LTX draft
  assert.equal(formatOf(896, 1600).id, '9:16'); // LTX final
  assert.equal(formatOf(768, 448).id, '16:9'); // MiniMax draft
  assert.equal(formatOf(1344, 768).id, '16:9'); // MiniMax final
  assert.equal(formatOf(1024, 1024).id, '1:1');
  assert.equal(formatOf(1000, 300), null);
});

test('a model only gets the sizes it accepts, and a format change keeps the scale', () => {
  const minimax = { width: { min: 256, max: 2048, multipleOf: 32 }, height: { min: 256, max: 2048, multipleOf: 32 } };
  const portrait = FORMATS.find(format => format.id === '9:16');
  assert.ok(sizesFor(portrait, minimax).every(size => size.height <= 2048 && size.width >= 256));
  const strict = { width: { max: 1024 }, height: { max: 600 } };
  assert.ok(!formatsFor(strict).some(format => format.id === '9:16' && sizesFor(format, strict).some(s => s.height > 600)));
  // Draft 768 × 448 turned portrait stays a draft size, not a final one.
  assert.deepEqual(nearestSize(sizesFor(portrait, minimax), 768 * 448), { width: 448, height: 768 });
});
