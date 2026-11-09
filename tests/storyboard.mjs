import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareStoryboard, storyboardCount } from '../public/resource-preparation.mjs';

const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rLkAAAAASUVORK5CYII=';

function fakeBrowser(t, { duration, width = 1280, height = 720 }) {
  const previous = { document: globalThis.document, bitmap: globalThis.createImageBitmap };
  const drawn = [],
    canvases = [],
    labels = [];
  let released = false;
  class Video {
    duration = duration;
    videoWidth = width;
    videoHeight = height;
    readyState = 3;
    time = -1;
    listeners = {};
    addEventListener(name, fn) {
      (this.listeners[name] ??= new Set()).add(fn);
    }
    removeEventListener(name, fn) {
      this.listeners[name]?.delete(fn);
    }
    set src(value) {
      queueMicrotask(() => [...(this.listeners.loadedmetadata || [])].forEach(fn => fn()));
    }
    set currentTime(time) {
      this.time = time;
      queueMicrotask(() => [...(this.listeners.seeked || [])].forEach(fn => fn()));
    }
    get currentTime() {
      return this.time;
    }
    pause() {}
    removeAttribute() {
      released = true;
    }
    load() {}
  }
  globalThis.document = {
    createElement: tag => {
      if (tag === 'video') return new Video();
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
          fillRect() {},
          fillText: text => labels.push(text),
          drawImage: (source, x = 0, y = 0, w, h) => {
            if (source instanceof Video)
              drawn.push({ canvas, size: [canvas.width, canvas.height], time: source.currentTime, x, y, w, h });
          },
        }),
        toBlob: callback => callback(new Blob([Buffer.from([255, 216, 255])], { type: 'image/jpeg' })),
        toDataURL: () => png,
      };
      canvases.push(canvas);
      return canvas;
    },
  };
  globalThis.createImageBitmap = async () => ({ width: 64, height: 36, close() {} });
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.createImageBitmap = previous.bitmap;
  });
  return { drawn, canvases, labels, released: () => released };
}

test('storyboard size follows the clip length: about one frame in six, from 3 to 16', () => {
  assert.equal(storyboardCount(1, 24), 4);
  assert.equal(storyboardCount(2, 24), 8);
  assert.equal(storyboardCount(0.2, 24), 3);
  assert.equal(storyboardCount(60, 24), 16);
});

test('a storyboard is one bounded, time-stamped grid plus three gallery frames', async t => {
  const browser = fakeBrowser(t, { duration: 2 });
  const result = await prepareStoryboard('blob:clip', { name: 'clip.mp4', fps: 24 });
  const board = result.storyboard;
  assert.equal(board.times.length, 8);
  assert.deepEqual([board.columns, board.rows], [2, 4], 'the grid closest to square for 16:9 frames');
  assert.ok(board.times.every((time, i) => time > 0 && time < 2 && (i === 0 || time > board.times[i - 1])));
  const cell = browser.drawn.find(item => item.w !== undefined),
    sheet = cell.canvas;
  assert.deepEqual([cell.w, cell.h], [455, 255]);
  assert.deepEqual(cell.size, [910, 1020]);
  assert.equal(browser.drawn.filter(item => item.canvas === sheet).length, 8);
  assert.deepEqual(browser.labels.slice(0, 2), ['1 · 0.13 s', '2 · 0.38 s']);
  assert.equal(result.frames.length, 3);
  assert.equal(browser.released(), true);
  assert.equal(sheet.width, 0, 'the sheet canvas is released');
});
