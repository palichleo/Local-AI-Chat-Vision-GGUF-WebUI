import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import assert from 'node:assert/strict';

// Original microfacets with smooth coverage; no independent per-pixel noise.
const size = 2048;
const field = new Float32Array(size * size);
let seed = 0x73a109c5;
function random() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
}
for (let i = 0; i < 190000; i++) {
  const x = random() * size,
    y = random() * size,
    angle = random() * Math.PI;
  const cosine = Math.cos(angle),
    sine = Math.sin(angle);
  const major = 1.1 + random() * 1.6,
    minor = 0.55 + random() * 0.65;
  const reflection = Math.pow(0.35 + 0.65 * Math.abs(Math.cos(angle - 0.65)), 8);
  const strength = 6 + reflection * (12 + random() * 22);
  const radius = Math.ceil(major * 1.6);
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const px = Math.floor(x) + dx,
        py = Math.floor(y) + dy;
      const ox = px + 0.5 - x,
        oy = py + 0.5 - y;
      const u = (ox * cosine + oy * sine) / major;
      const v = (-ox * sine + oy * cosine) / minor;
      const distance = u * u + v * v;
      if (distance > 3) continue;
      const coverage = Math.exp(-distance * 2);
      const index = ((py + size) % size) * size + ((px + size) % size);
      field[index] += strength * coverage * Math.max(0.65, 1 - u * 0.2);
    }
  }
}
const alpha = Uint8Array.from(field, value => Math.min(72, Math.round(value)));
const levels = Array.from({ length: 256 }, (_, i) => i);
const indices = alpha;

// Compare the two joins with normal neighbour differences, rather than duplicating edge pixels.
function seamRatio(vertical) {
  let seam = 0,
    neighbours = 0;
  for (let i = 0; i < size; i++) {
    const at = (a, b) => alpha[b * size + a];
    seam += vertical ? Math.abs(at(0, i) - at(size - 1, i)) : Math.abs(at(i, 0) - at(i, size - 1));
    for (let j = 1; j < size; j++) {
      neighbours += vertical ? Math.abs(at(j, i) - at(j - 1, i)) : Math.abs(at(i, j) - at(i, j - 1));
    }
  }
  return seam / (neighbours / (size - 1));
}
const seams = [seamRatio(true), seamRatio(false)];
assert.ok(
  seams.every(ratio => ratio > 0.8 && ratio < 1.2),
  'A tile edge differs from the interior grain',
);

const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function chunk(type, bytes) {
  const data = Buffer.concat([Buffer.from(type), bytes]);
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  const head = Buffer.alloc(4),
    tail = Buffer.alloc(4);
  head.writeUInt32BE(bytes.length);
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([head, data, tail]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 3;
const palette = Buffer.alloc(levels.length * 3);
for (let i = 0; i < levels.length; i++) palette.set([192, 198, 204], i * 3);
const stride = size + 1;
const scanlines = Buffer.alloc(stride * size);
for (let y = 0; y < size; y++) scanlines.set(indices.subarray(y * size, (y + 1) * size), y * stride + 1);
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header),
  chunk('PLTE', palette),
  chunk('tRNS', Buffer.from(levels)),
  chunk('IDAT', deflateSync(scanlines, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
assert.ok(png.length < 1500000, 'Texture exceeds its transfer budget');
const output = process.argv[2] || fileURLToPath(new URL('../public/assets/metallic-grain.png', import.meta.url));
await mkdir(dirname(output), { recursive: true });
await writeFile(output, png);
console.log(JSON.stringify({ size, bytes: png.length, decodedBytes: size * size * 4, seamRatios: seams }));
