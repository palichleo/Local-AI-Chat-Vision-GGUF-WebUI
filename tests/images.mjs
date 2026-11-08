import test from 'node:test';
import assert from 'node:assert/strict';
import { imageBudget, prepareImages, compressImage } from '../public/images.mjs';

test('image resolution shrinks to share four megapixels across at most 64 references', () => {
  for (const [count, maxSide] of [[0, 1024], [1, 1024], [2, 1024], [3, 1024], [4, 1000], [8, 707], [16, 500], [64, 250]]) {
    assert.deepEqual(imageBudget(count), { maxSide, pixelBudget: 4_000_000 });
  }
  for (let count = 1; count <= 64; count++) {
    const { maxSide } = imageBudget(count);
    assert.ok(maxSide <= 1024);
    assert.ok(count * maxSide * maxSide <= 4_000_000, `The ${count} square analysis copies must fit the shared budget.`);
  }
});

test('invalid image counts cannot bypass the budget or reference limit', () => {
  for (const count of [-1, 65, 1.5, NaN, Infinity, '2', null, undefined]) assert.throws(() => imageBudget(count));
});

test('empty image preparation needs no browser and oversized batches fail before decoding', async () => {
  assert.deepEqual(await prepareImages([]), []);
  await assert.rejects(prepareImages(Array(65).fill(null)), /64/);
  await assert.rejects(prepareImages(null));
  await assert.rejects(prepareImages([null]));
});

test('invalid reference types and remote URLs fail before loading browser image APIs', async () => {
  await assert.rejects(prepareImages([new File(['not an image'], 'file.svg', { type: 'image/svg+xml' })]), /PNG.*JPEG/);
  await assert.rejects(prepareImages([new File(['not an image'], 'file.webp', { type: 'image/webp' })]), /PNG.*JPEG/);
  await assert.rejects(prepareImages([{ name: 'remote', url: 'https://example.com/image.png' }]), /locale/);
  await assert.rejects(prepareImages([{ name: 'remote', url: 'data:text/html;base64,PGltZz4=' }]), /locale/);
  await assert.rejects(compressImage(new Blob(['x'], { type: 'image/svg+xml' })), /PNG.*JPEG.*WebP/);
  await assert.rejects(compressImage(new Blob(['x'], { type: 'image/png' }), { count: 65 }), /64/);
});

test('original byte limits are checked before attempting a bitmap decode', async () => {
  const image = new File([new Uint8Array(64 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' });
  await assert.rejects(compressImage(image), /64 Mo/);
  await assert.rejects(prepareImages([image]), /64 Mo/);
});

const pngUrl = 'data:image/png;base64,iVBORw0KGgo=';
const jpegUrl = 'data:image/jpeg;base64,/9j/';
const webpUrl = 'data:image/webp;base64,UklGRgAAAABXRUJQ';

async function browserStub(options, check) {
  const previous = new Map(['fetch', 'createImageBitmap', 'document', 'atob'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const seen = { decoded: [], drawn: [], canvases: [], closed: 0, fetches: 0 };
  try {
    globalThis.fetch = async () => { seen.fetches++; throw new Error('CSP blocks image fetch'); };
    globalThis.createImageBitmap = async blob => {
      seen.decoded.push({ mime: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()) });
      return { width: options.width ?? 2048, height: options.height ?? 1024, close() { seen.closed++; } };
    };
    globalThis.document = {
      createElement(tag) {
        assert.equal(tag, 'canvas');
        const canvas = {
          width: 0, height: 0,
          getContext() { return { fillRect() {}, drawImage(_bitmap, x, y, width, height) { seen.drawn.push({ x, y, width, height }); } }; },
          toDataURL(mime) {
            if (options.encoderError) throw options.encoderError;
            return mime === 'image/png' ? options.png ?? pngUrl : options.jpeg ?? jpegUrl;
          },
        };
        seen.canvases.push(canvas);
        return canvas;
      },
    };
    await check(seen);
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test('local PNG, JPEG and WebP data URLs decode directly without fetch', { concurrency: false }, async () => {
  await browserStub({}, async seen => {
    const results = await prepareImages([{ name: 'a', url: pngUrl }, { name: 'b', url: jpegUrl }, { name: 'c', url: webpUrl }]);
    assert.equal(results.length, 3);
    assert.equal(seen.fetches, 0);
    assert.deepEqual(seen.decoded.map(({ mime, bytes }) => [mime, Buffer.from(bytes).toString('hex')]), [
      ['image/png', '89504e470d0a1a0a'], ['image/jpeg', 'ffd8ff'], ['image/webp', '524946460000000057454250'],
    ]);
    assert.equal(seen.closed, 3);
  });
});

test('raster dimensions share the batch budget and never upscale small originals', { concurrency: false }, async () => {
  await browserStub({ width: 4000, height: 2000 }, async seen => {
    await prepareImages(Array.from({ length: 16 }, (_, index) => ({ name: `image-${index}`, url: pngUrl })));
    assert.equal(seen.drawn.length, 16);
    assert.ok(seen.drawn.every(({ width, height }) => width === 500 && height === 250));
    assert.ok(seen.drawn.reduce((pixels, { width, height }) => pixels + width * height, 0) <= 4_000_000);
  });
  await browserStub({ width: 320, height: 240 }, async seen => {
    await prepareImages([{ url: pngUrl }]);
    assert.deepEqual(seen.drawn, [{ x: 0, y: 0, width: 320, height: 240 }]);
  });
});

test('compression chooses the shorter PNG or JPEG and preserves the original File', { concurrency: false }, async () => {
  const source = new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], 'original.png', { type: 'image/png' });
  for (const [png, jpeg, expected] of [[`${pngUrl}AAAA`, jpegUrl, jpegUrl], [pngUrl, `${jpegUrl}AAAAAAAAAAAAAAAAAAAA`, pngUrl], [pngUrl, `data:image/jpeg;base64,${'A'.repeat(11)}`, pngUrl]]) {
    await browserStub({ png, jpeg }, async seen => {
      const [prepared] = await prepareImages([source]);
      assert.equal(prepared.url, expected);
      assert.equal(prepared.source, source);
      assert.equal(prepared.name, 'original.png');
      const [reprepared] = await prepareImages([prepared]);
      assert.equal(reprepared.source, source);
      assert.deepEqual(seen.decoded.map(({ bytes }) => Buffer.from(bytes).toString('hex')), ['89504e470d0a1a0a', '89504e470d0a1a0a']);
    });
  }
});

test('encoder failure closes the bitmap, clears the canvas and permits another image', { concurrency: false }, async () => {
  const failure = new Error('encoder failed');
  await browserStub({ encoderError: failure }, async seen => {
    await assert.rejects(compressImage(new Blob([Uint8Array.from([255, 216, 255])], { type: 'image/jpeg' })), error => error === failure);
    assert.equal(seen.closed, 1);
    assert.equal(seen.canvases[0].width, 0);
    assert.equal(seen.canvases[0].height, 0);
  });
  await browserStub({}, async seen => {
    assert.equal((await prepareImages([{ url: pngUrl }])).length, 1);
    assert.equal(seen.closed, 1);
  });
});

test('data URL byte limits and invalid sources fail before base64 or bitmap decoding', { concurrency: false }, async () => {
  await browserStub({}, async seen => {
    let base64Decodes = 0;
    globalThis.atob = () => { base64Decodes++; throw new Error('must reject before decoding'); };
    const tooLarge = `data:image/png;base64,${'A'.repeat(4 * Math.ceil(64 * 1024 * 1024 / 3))}`;
    await assert.rejects(prepareImages([{ url: tooLarge }]), /64 Mo/);
    for (const url of ['blob:http://127.0.0.1/local', 'data:image/png;base64,!!!!', 'data:image/svg+xml;base64,PHN2Zz4=', 'https://example.com/image.png']) await assert.rejects(prepareImages([{ url }]), /locale/);
    assert.equal(base64Decodes, 0);
    assert.equal(seen.decoded.length, 0);
    assert.equal(seen.fetches, 0);
  });
});
