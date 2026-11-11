import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolCatalog, framesFor } from '../lib/tool-catalog.mjs';
import { resolveNativeWorkflow, validateNativeWorkflow } from '../lib/native-workflows.mjs';

const MINIMAX_FRAMES = [124, 141, 158, 175, 192, 209, 226, 243, 260, 277, 294, 311, 328, 345];
const minimax = (frames = { policy: 'model', type: 'integer', choices: MINIMAX_FRAMES, default: 124 }) =>
  validateNativeWorkflow({
    schemaVersion: 1,
    id: 'minimax',
    enabled: true,
    pipeline: 'minimax_h3',
    mediaType: 'video',
    name: 'MiniMax H3',
    description: 'Video',
    components: Object.fromEntries(
      ['model', 'textEncoder', 'tokenizer', 'vae', 'audioVae'].map(role => [role, { policy: 'fixed', asset: role }]),
    ),
    parameters: {
      prompt: { policy: 'model', type: 'string', maxLength: 8000 },
      seed: { policy: 'random', type: 'integer' },
      width: { policy: 'fixed', value: 768 },
      height: { policy: 'fixed', value: 448 },
      steps: { policy: 'fixed', value: 8 },
      stage: { policy: 'model', type: 'string', choices: ['draft', 'final'], default: 'draft' },
      frames,
      fps: { policy: 'fixed', value: 24 },
      audio: { policy: 'fixed', value: true },
      overlap_frames: { policy: 'fixed', value: 22 },
    },
    profiles: {
      draft: { parameters: { width: 768, height: 448, frames: 124, fps: 24, steps: 8 } },
      final: { parameters: { width: 1344, height: 768, frames: 124, fps: 24, steps: 8 } },
    },
    loras: [],
    references: [{ id: 'source', role: 'source_video', required: false, name: 'Vidéo à prolonger' }],
  });
const assets = { resolve: async id => ({ id, path: join(tmpdir(), `${id}.safetensors`) }) };
const media = { mediaOf: async source => (source.output ? 'video' : 'image') };

test('a requested length becomes the closest frame count the workflow allows', () => {
  const workflow = minimax();
  assert.deepEqual(framesFor(workflow, 10), { frames: 243, seconds: 243 / 24 });
  assert.equal(framesFor(workflow, 1).frames, 124, 'below the shortest clip: the shortest');
  assert.equal(framesFor(workflow, 60).frames, 345, 'beyond the longest clip: the longest');
  // A continuation re-renders 22 source frames: "3 more seconds" needs 22 + 72 frames, and 124 is the least.
  assert.equal(framesFor(workflow, 3, { continuation: true }).frames, 124);
  assert.equal(framesFor(workflow, 8, { continuation: true }).frames, 209);
});

test('the model asks for seconds; the router picks frames and says when it rounded', async () => {
  const tools = new ToolCatalog({ list: async () => [{ ...minimax(), ready: true }] });
  const definitions = Object.fromEntries((await tools.definitions()).map(tool => [tool.function.name, tool.function]));
  // Always asked for (null = the workflow's default), so a length is not left in the prompt.
  assert.deepEqual(definitions.create_video.parameters.properties.duration.type, ['number', 'null']);
  assert.ok(definitions.create_video.parameters.required.includes('duration'));
  assert.ok(definitions.extend_video.parameters.required.includes('duration'));
  const unset = await tools.route('create_video', { prompt: 'x', intention: 'y', duration: null }, media);
  assert.equal(unset.args.frames, 124, 'null is the workflow’s standard length');
  assert.equal(definitions.create_video.parameters.properties.frames, undefined, 'no raw frame count');
  assert.match(definitions.extend_video.parameters.properties.duration.description, /new footage/);
  const created = await tools.route('create_video', { prompt: 'x', intention: 'y', duration: 10 }, media);
  assert.equal(created.args.frames, 243);
  assert.match(created.notes.join(), /10 s → 10\.13 s/);
  const extended = await tools.route(
    'extend_video',
    { prompt: 'x', intention: 'y', duration: 3, source: { output: '22222222-2222-4222-8222-222222222222' } },
    media,
  );
  assert.equal(extended.args.frames, 124);
  assert.match(extended.notes.join(), /ajoutée : 3 s → 4\.25 s/);
  await assert.rejects(tools.route('create_video', { prompt: 'x', intention: 'y', duration: -1 }, media), /duration/);
});

test('a locked clip length keeps the workflow’s value and tells the model', async () => {
  const tools = new ToolCatalog({
    list: async () => [{ ...minimax({ policy: 'fixed', value: 124 }), ready: true }],
  });
  const definitions = Object.fromEntries((await tools.definitions()).map(tool => [tool.function.name, tool.function]));
  assert.equal(definitions.create_video.parameters.properties.duration, undefined);
  const routed = await tools.route('create_video', { prompt: 'x', intention: 'y', duration: 10 }, media);
  assert.equal(routed.args.frames, undefined);
  assert.match(routed.notes.join(), /Durée ignorée/);
});

test('a length the model chose outlives the draft and final profiles', async () => {
  const workflow = minimax();
  for (const stage of ['draft', 'final']) {
    const job = await resolveNativeWorkflow(workflow, { prompt: 'x', intention: 'y', stage, frames: 243 }, assets, {
      seed: 1,
    });
    assert.equal(job.parameters.frames, 243);
  }
  const plain = await resolveNativeWorkflow(workflow, { prompt: 'x', intention: 'y', stage: 'final' }, assets, {
    seed: 1,
  });
  assert.equal(plain.parameters.frames, 124, 'without a choice, the profile still decides');
  assert.equal(plain.parameters.width, 1344);
});

test('without a chosen length, a continuation adds one profile-length clip of new footage', async () => {
  const workflow = minimax();
  const source = { references: [{ input: 'source', output_id: '22222222-2222-4222-8222-222222222222' }] };
  const options = { seed: 1, allowPendingReferences: true };
  const extended = await resolveNativeWorkflow(workflow, { prompt: 'x', intention: 'y', ...source }, assets, options);
  // 124 frames would re-render 22 source frames and add 102: 141 adds 119, the closest to 124.
  assert.equal(extended.parameters.frames, 141);
  const chosen = await resolveNativeWorkflow(
    workflow,
    { prompt: 'x', intention: 'y', frames: 124, ...source },
    assets,
    options,
  );
  assert.equal(chosen.parameters.frames, 124, 'a chosen length is kept');
  const created = await resolveNativeWorkflow(workflow, { prompt: 'x', intention: 'y' }, assets, options);
  assert.equal(created.parameters.frames, 124, 'a new clip keeps the profile length');
  const fixed = await resolveNativeWorkflow(
    minimax({ policy: 'fixed', value: 124 }),
    { prompt: 'x', intention: 'y', ...source },
    assets,
    options,
  );
  assert.equal(fixed.parameters.frames, 124, 'a locked length stays locked');
});

test('without a length, a draft is the standard clip, not the short one of its profile', async () => {
  // As LTX is shipped (a draft profile of 25 frames, a standard clip of 121), with MiniMax's numbers.
  const base = minimax({ policy: 'model', type: 'integer', choices: MINIMAX_FRAMES, default: 243 });
  const workflow = {
    ...base,
    ready: true,
    profiles: {
      draft: { parameters: { width: 768, height: 448, frames: 124, fps: 24, steps: 8 } },
      final: { parameters: { width: 1344, height: 768, frames: 243, fps: 24, steps: 8 } },
    },
  };
  const tools = new ToolCatalog({ list: async () => [workflow] });
  const created = await tools.route('create_video', { prompt: 'x', intention: 'y', duration: null }, media);
  assert.equal(created.args.frames, 243);
  const job = await resolveNativeWorkflow(workflow, created.args, assets, { seed: 1 });
  assert.equal(job.parameters.frames, 243, 'the standard length');
  assert.equal(job.parameters.width, 768, 'at the size of the draft');
  const extended = await tools.route(
    'extend_video',
    { prompt: 'x', intention: 'y', duration: null, source: { output: '22222222-2222-4222-8222-222222222222' } },
    media,
  );
  // 22 frames of the source are rendered again: 260 adds 238 new ones, the closest to 243.
  assert.equal(extended.args.frames, 260);
  const asked = await tools.route('create_video', { prompt: 'x', intention: 'y', duration: 5 }, media);
  assert.equal(asked.args.frames, 124, 'a length that was asked for is kept');
});

test('a clip length the model made up is recognised: nobody spoke of a length', async () => {
  const { inventedLength } = await import('../lib/tool-runtime.mjs');
  const user = content => ({ role: 'user', content });
  const request =
    'je veux une video qui commence avec la fille dans la balencoire, elle pointe vers la droite, puis la caméra va sur l’escalier';
  assert.equal(inventedLength([user(request)]), true);
  // « court » the verb and « le long de » the place say nothing of a length.
  for (const text of ['fais une vidéo d’un chien qui court sur la plage', 'elle marche le long de la rivière'])
    assert.equal(inventedLength([user(text)]), true, text);
  assert.equal(inventedLength([user([{ type: 'text', text: request }])]), true);
  // Any number or word about time keeps the model's answer, here or earlier in the conversation.
  for (const text of [
    'une vidéo de 8 secondes',
    'huit secondes de pluie',
    'plus longue',
    'un clip très court',
    'une vidéo courte',
    'un long plan',
    'a short clip',
    'durée libre',
  ])
    assert.equal(inventedLength([user(text)]), false, text);
  assert.equal(inventedLength([user('10 secondes'), { role: 'assistant', content: 'ok' }, user('refais-la')]), false);
  // An output button asks without a conversation: its length is not the model's.
  assert.equal(inventedLength([]), false);
  assert.equal(inventedLength([{ role: 'assistant', content: 'une vidéo' }]), false);
});
