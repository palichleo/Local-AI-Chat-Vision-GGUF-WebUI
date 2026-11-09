import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolCatalog, serves } from '../lib/tool-catalog.mjs';

const video = (id, references, extra = {}) => ({
  schemaVersion: 1,
  id,
  name: id,
  description: `Workflow ${id}`,
  enabled: true,
  ready: true,
  pipeline: 'ltx25',
  mediaType: 'video',
  parameters: {
    prompt: { policy: 'model', type: 'string' },
    stage: { policy: 'model', type: 'string', choices: ['draft', 'final'], default: 'draft' },
    fps: { policy: 'fixed', value: 24 },
  },
  components: {},
  loras: [],
  references,
  ...extra,
});
const image = (id, references = []) => ({
  schemaVersion: 1,
  id,
  name: id,
  description: `Workflow ${id}`,
  enabled: true,
  ready: true,
  pipeline: 'krea2',
  mediaType: 'image',
  parameters: { prompt: { policy: 'model', type: 'string' }, width: { policy: 'fixed', value: 512 } },
  components: {},
  loras: [],
  references,
});
const slot = (id, role, required = false) => ({ id, role, required });
const catalogOf = workflows => new ToolCatalog({ list: async () => workflows });
const media = { mediaOf: async source => (source.output === 'video-run' ? 'video' : 'image') };

const workflows = [
  image('portrait'),
  image('edit', [slot('source', 'img2img', true)]),
  video('t2v', []),
  video('keyframes', [slot('first', 'start_image'), slot('last', 'end_image')]),
  video('subject', [slot('a', 'msr_image'), slot('b', 'msr_image')]),
  video('continue', [slot('clip', 'source_video', true)]),
];

test('the model sees one tool per verb with only the roles some workflow accepts', async () => {
  const tools = Object.fromEntries((await catalogOf(workflows).definitions()).map(t => [t.function.name, t.function]));
  assert.deepEqual(Object.keys(tools).sort(), ['create_image', 'create_video', 'extend_video']);
  const create = tools.create_video.parameters;
  assert.deepEqual(Object.keys(create.properties).sort(), [
    'end_image',
    'intention',
    'prompt',
    'reference',
    'stage',
    'start_image',
    'workflow',
  ]);
  assert.equal(create.properties.reference.maxItems, 2);
  assert.deepEqual(create.required.sort(), ['intention', 'prompt']);
  assert.equal(create.properties.fps, undefined, 'fixed parameters are never exposed');
  assert.deepEqual(tools.extend_video.parameters.required.sort(), ['intention', 'prompt', 'source']);
  assert.match(tools.create_video.description, /keyframes.*accepts: start_image, end_image/);
  assert.equal(serves(workflows[5], 'create_video'), false, 'a required source video excludes plain creation');
});

test('roles choose the most specific workflow, and forcing one is still checked', async () => {
  const tools = catalogOf(workflows);
  const route = (name, args) => tools.route(name, { prompt: 'x', intention: 'y', ...args }, media);
  assert.equal((await route('create_video', {})).workflow.id, 't2v');
  assert.equal((await route('create_video', { start_image: { image: 0 } })).workflow.id, 'keyframes');
  const fl = await route('create_video', { start_image: { image: 0 }, end_image: { resource: 'r1' } });
  assert.deepEqual(fl.args.references, [
    { input: 'first', image: 0 },
    { input: 'last', resource_id: 'r1' },
  ]);
  const refs = await route('create_video', { reference: [{ image: 0 }, { output: 'run', index: 1 }] });
  assert.equal(refs.workflow.id, 'subject');
  assert.deepEqual(refs.args.references[1], { input: 'b', output_id: 'run', output_index: 1 });
  await assert.rejects(
    route('create_video', { reference: [{ image: 0 }, { image: 1 }, { image: 2 }] }),
    /Aucun workflow/,
  );
  await assert.rejects(route('create_video', { workflow: 'subject', start_image: { image: 0 } }), /Aucun workflow/);
  assert.equal((await route('extend_video', { source: { output: 'video-run' } })).workflow.id, 'continue');
  await assert.rejects(route('extend_video', { source: { image: 0 } }), /Aucun workflow/);
  await assert.rejects(route('extend_video', {}), /needs a source/);
  assert.equal((await tools.route('create_image', { prompt: 'x', source: { image: 0 } }, media)).workflow.id, 'edit');
});

test('arguments are checked against the chosen workflow, never forwarded blindly', async () => {
  const tools = catalogOf(workflows);
  const routed = await tools.route('create_video', { prompt: 'x', intention: 'y', fps: 12, stage: 'final' }, media);
  assert.equal(routed.args.stage, 'final');
  assert.equal(routed.args.fps, undefined);
  assert.match(routed.notes[0], /fps ignored/);
  await assert.rejects(tools.route('create_image', { prompt: 'x', colour: 'red' }, media), /argument colour/);
  await assert.rejects(
    tools.route('create_image', { prompt: 'x', source: { image: 0, resource: 'r' } }, media),
    /exactly one/,
  );
});

test('upscale follows the media of its source and interpolate only takes videos', async () => {
  const transform = (id, pipeline, mediaType, role, parameters = {}) => ({
    schemaVersion: 1,
    id,
    name: id,
    description: id,
    enabled: true,
    ready: true,
    pipeline,
    mediaType,
    parameters,
    components: {},
    loras: [],
    references: [slot('source', role, true)],
  });
  const tools = catalogOf([
    image('portrait'),
    transform('bigger-image', 'realesrgan_image', 'image', 'source_image'),
    transform('bigger-video', 'realesrgan_video', 'video', 'source_video'),
    transform('smooth', 'rife', 'video', 'source_video', {
      multiplier: { policy: 'model', type: 'integer', choices: [2, 4], default: 2 },
    }),
  ]);
  const names = (await tools.definitions()).map(tool => tool.function.name).sort();
  assert.deepEqual(names, ['create_image', 'interpolate', 'upscale']);
  const upscale = (await tools.definitions()).find(tool => tool.function.name === 'upscale').function.parameters;
  assert.equal(upscale.properties.prompt, undefined, 'upscaling has no prompt');
  assert.deepEqual(upscale.required, ['source']);
  assert.equal((await tools.route('upscale', { source: { image: 0 } }, media)).workflow.id, 'bigger-image');
  const video = await tools.route('upscale', { source: { output: 'video-run' } }, media);
  assert.equal(video.workflow.id, 'bigger-video');
  assert.ok(video.args.intention, 'a video upscale still carries an intention for its confirmation');
  const smooth = await tools.route('interpolate', { source: { output: 'video-run' }, multiplier: 4 }, media);
  assert.deepEqual([smooth.workflow.id, smooth.args.multiplier], ['smooth', 4]);
  await assert.rejects(tools.route('interpolate', { source: { image: 0 } }, media), /Aucun workflow/);
});
