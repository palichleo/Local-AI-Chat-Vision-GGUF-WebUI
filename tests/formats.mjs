import test from 'node:test';
import assert from 'node:assert/strict';
import { FORMATS, formatOf, formatsFor, nearestSize, sizesFor } from '../public/formats.mjs';

test('every listed size is clean: a multiple of 32, in its format, never twice', () => {
  for (const format of FORMATS) {
    const seen = new Set();
    for (const { width, height } of format.sizes) {
      assert.equal(width % 32, 0, `${format.id} ${width}`);
      assert.equal(height % 32, 0, `${format.id} ${height}`);
      assert.equal(formatOf(width, height), format, `${width} × ${height} reads as ${format.id}`);
      assert.ok(!seen.has(width + 'x' + height));
      seen.add(width + 'x' + height);
    }
    const pixels = format.sizes.map(size => size.width * size.height);
    assert.deepEqual(pixels, [...pixels].sort((a, b) => a - b), format.id + ' sizes grow');
  }
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
