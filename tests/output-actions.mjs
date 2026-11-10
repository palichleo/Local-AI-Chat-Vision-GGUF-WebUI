import test from 'node:test';
import assert from 'node:assert/strict';
import { outputActions } from '../public/output-actions.mjs';
import { ToolCatalog } from '../lib/tool-catalog.mjs';

class Element {
  constructor(tag, className = '', text) {
    this.tag = tag;
    this.className = className;
    this.textContent = text ?? '';
    this.children = [];
    this.attributes = {};
  }
  append(...children) {
    this.children.push(...children);
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
}
const node = (tag, className, text) => new Element(tag, className, text);
globalThis.document ??= { createElementNS: (_ns, tag) => new Element(tag) };
const label = button => button.children.find(child => child.tag === 'span').textContent;

test('outputs offer Détails, Upscale and, for videos, Interpoler and Prolonger', async () => {
  const calls = [];
  const actions = outputActions({
    api: async route => {
      assert.equal(route, 'tools/actions');
      return Response.json({ upscale: ['video'], interpolate: ['video'], extend_video: [] });
    },
    node,
    onDetails: (...args) => calls.push(['details', ...args]),
    onAction: (...args) => calls.push(args.slice(1)),
  });
  const video = { id: 'run', mediaType: 'video' },
    image = { id: 'still' };
  const videoRow = actions(video, 0),
    imageRow = actions(image, 0);
  assert.deepEqual(videoRow.children.map(label), ['Détails', 'Upscale', 'Interpoler', 'Prolonger']);
  assert.deepEqual(imageRow.children.map(label), ['Détails', 'Upscale']);
  assert.ok(
    videoRow.children.slice(1).every(button => button.disabled),
    'disabled until the server answers',
  );
  await new Promise(setImmediate);
  const [details, upscale, interpolate, extend] = videoRow.children;
  assert.equal(upscale.disabled, false);
  assert.equal(interpolate.disabled, false);
  assert.equal(extend.disabled, true);
  assert.match(extend.title, /prolonger/);
  assert.equal(imageRow.children[1].disabled, true, 'no image upscaler is active');
  assert.match(imageRow.children[1].title, /upscale image/);
  details.onclick();
  interpolate.onclick();
  assert.deepEqual(calls, [
    ['details', video, 0],
    [0, 'interpolate'],
  ]);
});

test('the server lists which media each output button can act on', async () => {
  const workflow = (id, pipeline, mediaType, role) => ({
    id,
    name: id,
    description: id,
    enabled: true,
    ready: true,
    pipeline,
    mediaType,
    parameters: {},
    components: {},
    loras: [],
    references: [{ id: 'source', role, required: true }],
  });
  const tools = new ToolCatalog({
    list: async () => [
      workflow('esrgan-video', 'realesrgan_video', 'video', 'source_video'),
      workflow('rife', 'rife', 'video', 'source_video'),
    ],
  });
  assert.deepEqual(await tools.actions(), { upscale: ['video'], interpolate: ['video'], extend_video: [] });
});
