import test from 'node:test';
import assert from 'node:assert/strict';
import { takeFlux } from '../public/take-flux.mjs';

// The Flux of a take in progress (capture 13): when it draws, and what it leaves behind.
// What was drawn from a picture (not from another canvas), and from the field of the room (320 × 180).
const drawn = [],
  fields = [];
const pen = () =>
  new Proxy(
    {
      drawImage(source) {
        if (!(source instanceof Canvas)) drawn.push(source);
        else if (source.width === 320) fields.push(source);
      },
      createRadialGradient: () => ({ addColorStop() {} }),
    },
    {
      get: (target, key) => (key in target ? target[key] : () => {}),
      set: (target, key, value) => ((target[key] = value), true),
    },
  );
class Canvas {
  constructor(className = '') {
    Object.assign(this, { className, width: 0, height: 0, clientWidth: 56, clientHeight: 32, attributes: {}, parentNode: null });
    this.pen = pen();
  }
  getContext() {
    return this.pen;
  }
  setAttribute(key, value) {
    this.attributes[key] = value;
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
}
function page({ reduced = false } = {}) {
  const timers = new Map(),
    frames = new Map(),
    delays = [];
  let id = 0;
  const win = {
    document: { createElement: () => new Canvas(), documentElement: { dataset: {} } },
    devicePixelRatio: 1,
    performance: { now: () => 0 },
    matchMedia: () => ({ matches: reduced }),
    setTimeout(run, delay) {
      delays.push(delay);
      timers.set(++id, run);
      return id;
    },
    clearTimeout: key => timers.delete(key),
    requestAnimationFrame(run) {
      frames.set(++id, run);
      return id;
    },
    cancelAnimationFrame: key => frames.delete(key),
    Image: class {
      set src(value) {
        Object.assign(this, { address: value, naturalWidth: 100, naturalHeight: 50, complete: true });
        queueMicrotask(() => this.onload?.());
      }
    },
  };
  return {
    win,
    timers,
    frames,
    delays,
    draw: at => {
      for (const [key, run] of [...frames]) {
        frames.delete(key);
        run(at);
      }
    },
    wait: () => {
      for (const [key, run] of [...timers]) {
        timers.delete(key);
        run();
      }
    },
  };
}
function frame() {
  const classes = new Set();
  return {
    children: [],
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
    append(child) {
      child.parentNode = this;
      this.children.push(child);
    },
  };
}
const node = (tag, className) => new Canvas(className);
const settle = () => new Promise(resolve => setImmediate(resolve));

test('without a page that draws, the Flux does nothing', () => {
  const flux = takeFlux(frame(), { node: () => ({}), win: page().win });
  assert.doesNotThrow(() => {
    flux.source('/image.png');
    flux.progress(0.4);
    flux.visible(false);
    flux.stop();
  });
});

test('a picture starts it: its canvas in the frame, 24 images a second at most (the grain), nothing out of view', async () => {
  const browser = page(),
    box = frame(),
    flux = takeFlux(box, { node, win: browser.win });
  assert.equal(box.children.length, 0, 'no picture yet: the moving background of the frame');
  flux.source('/media/start.png');
  await settle();
  assert.equal(box.children[0].className, 'take-flux');
  assert.equal(box.classList.contains('has-flux'), true);
  browser.draw(1000);
  assert.equal(box.children[0].width, 56, 'drawn at the size of the frame');
  assert.deepEqual(browser.delays, [1000 / 24]);
  // Out of view: nothing waits to draw; back in view, it draws again.
  flux.visible(false);
  assert.equal(browser.timers.size + browser.frames.size, 0);
  flux.visible(true);
  assert.equal(browser.frames.size, 1);
  // The take is there: the canvas goes, and nothing is left to run.
  flux.stop();
  assert.equal(box.children.length, 0);
  assert.equal(box.classList.contains('has-flux'), false);
  assert.equal(browser.timers.size + browser.frames.size, 0);
});

test('a take from words alone runs on the colours of the room until its first picture', async () => {
  const browser = page(),
    box = frame(),
    flux = takeFlux(box, { node, win: browser.win });
  flux.neutral();
  assert.equal(box.classList.contains('has-flux'), true, 'no moving background of before: the Flux at once');
  assert.equal(box.children.length, 1);
  fields.length = 0;
  browser.draw(1000);
  assert.ok(fields.length > 0, 'drawn from the field of the room');
  flux.source('/media/preview.png');
  await settle();
  drawn.length = 0;
  browser.draw(2000);
  assert.deepEqual([...new Set(drawn.map(image => image.address))], ['/media/preview.png']);
  // Asked again once a picture is there (a later take of the same tile): the picture stays.
  fields.length = 0;
  flux.neutral();
  browser.wait();
  browser.draw(3000);
  assert.deepEqual(fields, [], 'a picture is never replaced by the field');
  flux.stop();
});

test('with reduced motion, one still image: the picture blurred, drawn again only when something changes', async () => {
  const browser = page({ reduced: true }),
    box = frame(),
    flux = takeFlux(box, { node, win: browser.win });
  flux.source('/media/start.png');
  await settle();
  browser.draw(1000);
  assert.equal(browser.timers.size + browser.frames.size, 0, 'no loop');
  flux.progress(0.5);
  assert.equal(browser.frames.size, 1, 'the progress drawn once');
  flux.stop();
});

test('a later picture wins over an earlier one still loading', async () => {
  const browser = page(),
    box = frame(),
    flux = takeFlux(box, { node, win: browser.win });
  const loaded = [];
  browser.win.Image = class {
    set src(value) {
      Object.assign(this, { address: value, naturalWidth: 10, naturalHeight: 10, complete: true });
      loaded.push(() => this.onload?.());
    }
  };
  flux.source('/first.png');
  flux.source('/second.png');
  loaded[1]();
  loaded[0]();
  drawn.length = 0;
  browser.draw(1000);
  assert.ok(drawn.length > 0);
  assert.deepEqual([...new Set(drawn.map(image => image.address))], ['/second.png']);
  flux.stop();
});
