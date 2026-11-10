import test, { mock } from 'node:test';
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
  addEventListener(type, listener) {
    (this.listeners ??= {})[type] = listener;
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

test('a row drawn before a workflow became ready enables its button when the pointer comes back', async () => {
  mock.timers.enable({ apis: ['Date'], now: 0 });
  try {
    let image = [];
    const actions = outputActions({
      api: async () => Response.json({ upscale: image }),
      node,
      onDetails() {},
      onAction() {},
    });
    const row = actions({ id: 'still' }, 0);
    await new Promise(setImmediate);
    assert.equal(row.children[1].disabled, true);
    image = ['image'];
    mock.timers.tick(6000);
    await row.listeners.pointerenter();
    assert.equal(row.children[1].disabled, false);
    assert.doesNotMatch(row.children[1].title, /Aucun/);
  } finally {
    mock.timers.reset();
  }
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

test('an image upscale goes to SeedVR2 before Real-ESRGAN unless the model names a workflow', async () => {
  const workflow = (id, pipeline) => ({
    id,
    name: id,
    description: id,
    enabled: true,
    ready: true,
    pipeline,
    mediaType: 'image',
    parameters: {},
    components: {},
    loras: [],
    references: [{ id: 'source', role: 'source_image', required: true }],
  });
  const tools = new ToolCatalog({
    list: async () => [workflow('esrgan', 'realesrgan_image'), workflow('seedvr2', 'seedvr2')],
  });
  const media = { mediaOf: async () => 'image' };
  const route = args => tools.route('upscale', { source: { image: 0 }, ...args }, media);
  assert.equal((await route({})).workflow.id, 'seedvr2');
  assert.equal((await route({ workflow: 'esrgan' })).workflow.id, 'esrgan');
});

test('an image upscale proposal drops the intention a video would show', async () => {
  const tools = new ToolCatalog({
    list: async () => [
      {
        id: 'seedvr2',
        name: 'seedvr2',
        description: 'seedvr2',
        enabled: true,
        ready: true,
        pipeline: 'seedvr2',
        mediaType: 'image',
        parameters: {},
        components: {},
        loras: [],
        references: [{ id: 'source', role: 'source_image', required: true }],
      },
    ],
  });
  const routed = await tools.route(
    'upscale',
    { source: { image: 0 }, intention: 'Agrandir l’image.' },
    { mediaOf: async () => 'image' },
  );
  assert.equal(routed.args.intention, undefined);
});
