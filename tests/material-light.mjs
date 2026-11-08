import test from 'node:test';
import assert from 'node:assert/strict';
import { setupMaterialLighting } from '../public/material-light.mjs';

class Surface extends EventTarget {
  attributes = new Map();
  properties = new Map();
  reads = 0;
  style = { setProperty: (key, value) => this.properties.set(key, value) };
  setAttribute(key, value) { this.attributes.set(key, value); }
  removeAttribute(key) { this.attributes.delete(key); }
  getBoundingClientRect() { this.reads++; return { left: 100, top: 50 }; }
  move(x, y, pointerType = 'mouse') {
    this.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: x, clientY: y, pointerType }));
  }
}
function environment() {
  const host = new EventTarget(), media = new EventTarget(), frames = new Map();
  host.document = new EventTarget(); host.document.hidden = false;
  media.matches = true; host.matchMedia = () => media;
  let id = 0;
  host.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  host.cancelAnimationFrame = frame => frames.delete(frame);
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); };
  return { host, media, frames, flush };
}

test('material lighting coalesces pointer moves and schedules no idle animation', () => {
  const env = environment(), surface = new Surface();
  const dispose = setupMaterialLighting([surface], env.host);
  assert.equal(env.frames.size, 0);
  for (let i = 0; i < 100; i++) surface.move(100 + i, 80);
  assert.equal(env.frames.size, 1);
  assert.equal(surface.reads, 0);
  env.flush();
  assert.equal(surface.reads, 1);
  assert.equal(surface.properties.get('--light-x'), '99px');
  assert.equal(surface.properties.get('--light-y'), '30px');
  assert.ok(surface.attributes.has('data-material-lit'));
  assert.equal(env.frames.size, 0);
  surface.dispatchEvent(new Event('pointerleave'));
  assert.ok(!surface.attributes.has('data-material-lit'));
  surface.move(200, 100);
  dispose();
  assert.equal(env.frames.size, 0);
  surface.move(200, 100);
  assert.equal(env.frames.size, 0);
});

test('touch, reduced motion and background tabs never paint a moving light', () => {
  const env = environment(), surface = new Surface();
  const dispose = setupMaterialLighting([surface], env.host);
  surface.move(200, 100, 'touch');
  assert.equal(env.frames.size, 0);
  env.media.matches = false;
  surface.move(200, 100);
  assert.equal(env.frames.size, 0);
  env.media.matches = true;
  surface.move(200, 100); env.flush();
  env.media.matches = false; env.media.dispatchEvent(new Event('change'));
  assert.ok(!surface.attributes.has('data-material-lit'));
  env.media.matches = true;
  surface.move(200, 100);
  env.host.document.hidden = true; env.host.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(env.frames.size, 0);
  surface.move(200, 100);
  assert.equal(env.frames.size, 0);
  assert.equal(surface.reads, 1);
  dispose();
});

test('moving between surfaces, blur and page exit clear reflections and pending work', () => {
  const env = environment(), first = new Surface(), second = new Surface();
  setupMaterialLighting([first, second], env.host);
  first.move(130, 80); env.flush();
  second.move(250, 100);
  assert.ok(!first.attributes.has('data-material-lit'));
  env.flush();
  assert.ok(second.attributes.has('data-material-lit'));
  env.host.dispatchEvent(new Event('blur'));
  assert.ok(!second.attributes.has('data-material-lit'));
  first.move(180, 100);
  first.dispatchEvent(new Event('pointercancel'));
  assert.equal(env.frames.size, 0);
  second.move(250, 100);
  env.host.dispatchEvent(new Event('pagehide'));
  assert.equal(env.frames.size, 0);
  second.move(250, 100);
  assert.equal(env.frames.size, 0);
});
