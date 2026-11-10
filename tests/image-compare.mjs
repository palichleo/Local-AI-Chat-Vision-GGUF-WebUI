import test from 'node:test';
import assert from 'node:assert/strict';
import { comparedSource, imageCompare } from '../public/image-compare.mjs';

class Element {
  constructor(tag, className = '', text = '') {
    Object.assign(this, { tag, className, textContent: text, children: [], attributes: {}, listeners: {} });
    this.classes = new Set(className.split(' ').filter(Boolean));
    this.classList = {
      add: (...names) => names.forEach(name => this.classes.add(name)),
      remove: (...names) => names.forEach(name => this.classes.delete(name)),
      contains: name => this.classes.has(name),
    };
    const properties = {};
    this.style = { setProperty: (key, value) => (properties[key] = value), removeProperty: key => delete properties[key], properties };
  }
  append(...children) {
    for (const child of children) (child.parent = this), this.children.push(child);
  }
  remove() {
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'src') delete this.src;
  }
  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }
  removeEventListener(type) {
    delete this.listeners[type];
  }
  getBoundingClientRect() {
    return { left: 100, width: 200 };
  }
}
const node = (tag, className, text) => new Element(tag, className, text);

test('only an image made from an original source image is compared', () => {
  const source = { input: 'source', output_id: 'abc', original: true, role: 'source_image' };
  assert.equal(comparedSource({ parameters: { references: [source] } }), source);
  assert.equal(comparedSource({ mediaType: 'video', parameters: { references: [source] } }), null);
  assert.equal(comparedSource({ parameters: { references: [{ ...source, role: 'img2img' }] } }), null);
  assert.equal(comparedSource({ parameters: {} }), null);
});

test('hovering lays the source over the upscaled image, which stays the one dragged', async () => {
  const host = node('button'),
    upscaled = node('img');
  host.append(upscaled);
  globalThis.URL.createObjectURL ??= () => 'blob:x';
  let loads = 0;
  const comparison = imageCompare({ node, host, load: async () => (loads++, new Blob(['png'])) });
  const before = host.children[1];
  assert.equal(host.children[0], upscaled, 'the upscaled image stays underneath');
  assert.equal(before.draggable, false);
  host.listeners.pointerenter({ clientX: 150 });
  host.listeners.pointerenter({ clientX: 150 });
  await new Promise(setImmediate);
  assert.equal(loads, 1, 'the source is fetched once');
  assert.ok(host.classList.contains('is-comparing'));
  assert.equal(host.style.properties['--compare-split'], '25.00%');
  host.listeners.pointermove({ clientX: 400 });
  assert.equal(host.style.properties['--compare-split'], '100.00%');
  host.listeners.pointerleave();
  assert.ok(!host.classList.contains('is-comparing'));
  comparison.dispose();
  assert.deepEqual(host.children, [upscaled]);
  assert.ok(!host.classList.contains('image-compare'));
});
