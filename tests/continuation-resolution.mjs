import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolCatalog } from '../lib/tool-catalog.mjs';
import { ToolRuntime } from '../lib/tool-runtime.mjs';
import { resolveNativeWorkflow, validateNativeWorkflow } from '../lib/native-workflows.mjs';

// A MiniMax-H3 workflow shaped like the shipped one: draft 768×448, final 1344×768, every role.
const minimax = validateNativeWorkflow({
  schemaVersion: 1,
  id: 'minimax',
  enabled: true,
  pipeline: 'minimax_h3',
  mediaType: 'video',
  name: 'MiniMax H3',
  description: 'Text, keyframes, references or continuation.',
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
    frames: { policy: 'fixed', value: 124 },
    fps: { policy: 'fixed', value: 24 },
    audio: { policy: 'fixed', value: true },
    overlap_frames: { policy: 'fixed', value: 22 },
  },
  profiles: {
    draft: { parameters: { width: 768, height: 448, frames: 124, fps: 24, steps: 8 } },
    final: { parameters: { width: 1344, height: 768, frames: 124, fps: 24, steps: 8 } },
  },
  loras: [],
  references: [
    { id: 'source', role: 'source_video', required: false, name: 'Vidéo à prolonger' },
    { id: 'start', role: 'start_image', required: false, name: 'Image de début' },
    { id: 'end', role: 'end_image', required: false, name: 'Image de fin' },
    { id: 'subject-1', role: 'reference_image', required: false, name: 'Référence 1' },
    { id: 'subject-2', role: 'reference_image', required: false, name: 'Référence 2' },
    { id: 'subject-3', role: 'reference_image', required: false, name: 'Référence 3' },
  ],
});
// An LTX 2.5 workflow with fewer slots: a "more specific" match for a bare continuation.
const ltx = {
  schemaVersion: 1,
  id: 'ltx',
  name: 'LTX 2.5',
  description: 'LTX',
  enabled: true,
  pipeline: 'ltx25',
  mediaType: 'video',
  parameters: {
    prompt: { policy: 'model', type: 'string' },
    stage: { policy: 'model', type: 'string', choices: ['draft', 'final'], default: 'draft' },
  },
  components: {},
  loras: [],
  references: [
    { id: 'start', role: 'start_image', required: false },
    { id: 'clip', role: 'source_video', required: false },
  ],
};
const assets = { resolve: async id => ({ id, path: join(tmpdir(), `${id}.safetensors`) }) };
const media = { mediaOf: async () => 'video' };
const origins = {
  'mm-run': { workflowId: 'minimax', pipeline: 'minimax_h3' },
  'ltx-run': { workflowId: 'ltx', pipeline: 'ltx25' },
};

test('a continuation stays in the workflow, or the model family, that made its source', async () => {
  const tools = new ToolCatalog({
    list: async () => [
      { ...minimax, ready: true },
      { ...ltx, ready: true },
    ],
  });
  const route = (output, originOf) =>
    tools.route('extend_video', { prompt: 'x', intention: 'y', source: { output } }, { ...media, originOf });
  const originOf = async source => origins[source.output] ?? null;
  assert.equal((await route('mm-run', originOf)).workflow.id, 'minimax');
  assert.equal((await route('ltx-run', originOf)).workflow.id, 'ltx');
  const sameFamily = async () => ({ workflowId: 'deleted-workflow', pipeline: 'minimax_h3' });
  assert.equal((await route('mm-run', sameFamily)).workflow.id, 'minimax');
  // Without an origin the most specific workflow still wins, as before.
  assert.equal((await route('mm-run', undefined)).workflow.id, 'ltx');
});

test('a continuation is generated at its source size, whatever the draft/final profile', async () => {
  const args = {
    prompt: 'x',
    intention: 'y',
    references: [{ input: 'source', output_id: '22222222-2222-4222-8222-222222222222' }],
  };
  const options = { allowPendingReferences: true, seed: 1 };
  const draft = await resolveNativeWorkflow(minimax, args, assets, {
    ...options,
    sourceSize: { width: 768, height: 448 },
  });
  assert.deepEqual([draft.parameters.width, draft.parameters.height], [768, 448]);
  const final = await resolveNativeWorkflow(minimax, { ...args, stage: 'final' }, assets, {
    ...options,
    sourceSize: { width: 768, height: 448 },
  });
  assert.deepEqual([final.parameters.width, final.parameters.height], [768, 448]);
  const tall = await resolveNativeWorkflow(minimax, args, assets, {
    ...options,
    sourceSize: { width: 896, height: 1600 },
  });
  assert.deepEqual([tall.parameters.width, tall.parameters.height], [896, 1600]);
  await assert.rejects(
    resolveNativeWorkflow(minimax, args, assets, { ...options, sourceSize: { width: 1920, height: 1080 } }),
    /1920×1080.*multiple of 32/,
  );
  // Plain creation ignores the source size and keeps the profile.
  const created = await resolveNativeWorkflow(minimax, { prompt: 'x', intention: 'y', stage: 'final' }, assets, {
    ...options,
    sourceSize: { width: 768, height: 448 },
  });
  assert.deepEqual([created.parameters.width, created.parameters.height], [1344, 768]);
});

test('the approval card shows the source size and the job carries it', async () => {
  const conversationId = '11111111-1111-4111-8111-111111111111';
  const sourceId = '22222222-2222-4222-8222-222222222222';
  const workflows = [
    { ...minimax, ready: true },
    { ...ltx, ready: true },
  ];
  const record = {
    provider: 'native',
    mediaType: 'video',
    workflowId: 'minimax',
    parameters: { pipeline: 'minimax_h3', width: 768, height: 448 },
    outputs: [{ source: { filename: 'boat.mp4' }, width: 768, height: 448 }],
  };
  const runtime = new ToolRuntime({
    catalog: {
      kind: 'native',
      list: async () => workflows,
      read: async id => workflows.find(workflow => workflow.id === id),
      prepare: async (id, args, options) => {
        const workflow = workflows.find(item => item.id === id);
        return { workflow, job: await resolveNativeWorkflow(workflow, args, assets, options), outputNodes: [] };
      },
    },
    engine: { state: 'ready' },
    gallery: { get: async () => record },
    getConfig: () => ({ enabled: true, autoAllow: false, maxIterations: 5 }),
    engineConfig: () => ({}),
    sourceMedia: async () => ({ mime: 'video/mp4', name: 'boat', handle: { close: async () => {} } }),
    clientFactory: () => ({}),
  });
  for (const stage of ['draft', 'final']) {
    const request = await runtime.request(
      [
        {
          id: 'call-' + stage,
          type: 'function',
          function: {
            name: 'extend_video',
            arguments: JSON.stringify({ prompt: 'dives', intention: 'Continue', stage, source: { output: sourceId } }),
          },
        },
      ],
      { conversationId, turnId: conversationId, messages: [] },
    );
    assert.equal(request.workflowName, 'MiniMax H3');
    assert.deepEqual(request.resolution, { width: 768, height: 448 });
    assert.equal(request.plan.parameters.overlap_frames, 22);
  }
});

test('the user revises a proposal in place: own values, same seed, size still locked to the source', async () => {
  const conversationId = '11111111-1111-4111-8111-111111111111';
  const sourceId = '22222222-2222-4222-8222-222222222222';
  const workflows = [{ ...minimax, ready: true }];
  const record = {
    provider: 'native',
    mediaType: 'video',
    workflowId: 'minimax',
    parameters: { pipeline: 'minimax_h3', width: 768, height: 448 },
    outputs: [{ source: { filename: 'boat.mp4' }, width: 768, height: 448 }],
  };
  const runtime = new ToolRuntime({
    catalog: {
      kind: 'native',
      list: async () => workflows,
      read: async id => workflows.find(workflow => workflow.id === id),
      prepare: async (id, args, options) => {
        const workflow = workflows.find(item => item.id === id);
        return { workflow, job: await resolveNativeWorkflow(workflow, args, assets, options), outputNodes: [] };
      },
    },
    engine: { state: 'ready' },
    gallery: { get: async () => record },
    getConfig: () => ({ enabled: true, autoAllow: false, maxIterations: 5 }),
    engineConfig: () => ({}),
    sourceMedia: async () => ({ mime: 'video/mp4', name: 'boat', handle: { close: async () => {} } }),
    clientFactory: () => ({}),
  });
  const first = await runtime.request(
    [
      {
        id: 'call',
        type: 'function',
        function: {
          name: 'extend_video',
          arguments: JSON.stringify({ prompt: 'dives', intention: 'Continue', source: { output: sourceId } }),
        },
      },
    ],
    { conversationId, turnId: conversationId, messages: [] },
  );
  const editable = Object.fromEntries(first.plan.editable.parameters.map(item => [item.key, item]));
  assert.match(editable.width.locked, /taille de sa vidéo source/);
  assert.deepEqual(editable.frames.choices.slice(0, 2), [124, 141]);
  assert.equal(editable.prompt, undefined);
  assert.deepEqual(first.plan.editable.stages, ['draft', 'final']);
  const revise = edits => runtime.revise({ requestId: first.requestId, approvalToken: first.approvalToken, edits });
  await assert.rejects(revise({ width: 1344 }), /taille de sa vidéo source/);
  await assert.rejects(revise({ frames: 130 }), /frames/);
  await assert.rejects(revise({ prompt: '  ' }), /vide/);
  const second = await revise({ prompt: 'the boat dives', stage: 'final', frames: 345 });
  assert.notEqual(second.requestId, first.requestId);
  assert.notEqual(second.approvalToken, first.approvalToken);
  assert.equal(second.plan.prompt, 'the boat dives');
  assert.equal(second.plan.stage, 'final');
  assert.equal(second.plan.parameters.frames, 345);
  assert.equal(second.plan.parameters.seed, first.plan.parameters.seed, 'same seed unless the user changes it');
  assert.deepEqual(second.resolution, { width: 768, height: 448 });
  assert.deepEqual(second.plan.edited, ['frames']);
  await assert.rejects(revise({ frames: 141 }), /expiré/, 'the replaced proposal is gone');
  const third = await runtime.revise({
    requestId: second.requestId,
    approvalToken: second.approvalToken,
    edits: { frames: 124, seed: 5, audio: false },
  });
  assert.deepEqual(third.plan.edited.sort(), ['audio', 'seed'], 'a value set back to the profile is no longer an edit');
  assert.equal(third.plan.parameters.seed, 5);
  await assert.rejects(
    runtime.revise({ requestId: third.requestId, approvalToken: 'forged', edits: {} }),
    /ne peut plus être modifiée/,
  );
});

// A conversation as in real use: a clip, its upscale, then the upscale smoothed to 48 fps.
function derivedConversation({ stage = 'draft', fps = 24, mode = 'smooth' } = {}) {
  const ids = {
    clip: '22222222-2222-4222-8222-222222222222',
    upscaled: '33333333-3333-4333-8333-333333333333',
    smoothed: '44444444-4444-4444-8444-444444444444',
  };
  const records = {
    [ids.clip]: {
      provider: 'native',
      mediaType: 'video',
      workflowId: 'minimax',
      workflowName: 'MiniMax H3',
      parameters: { pipeline: 'minimax_h3', width: 768, height: 448, fps, stage },
      outputs: [{ source: { filename: 'clip.mp4' }, width: 768, height: 448 }],
    },
    [ids.upscaled]: {
      provider: 'native',
      mediaType: 'video',
      workflowId: 'esrgan',
      workflowName: 'Upscale vidéo',
      parameters: {
        pipeline: 'realesrgan_video',
        references: [{ input: 'source', output_id: ids.clip, original: true, role: 'source_video' }],
      },
      outputs: [{ source: { filename: 'big.mp4' }, width: 1536, height: 896 }],
    },
    [ids.smoothed]: {
      provider: 'native',
      mediaType: 'video',
      workflowId: 'rife',
      workflowName: 'Interpoler',
      parameters: {
        pipeline: 'rife',
        multiplier: 2,
        mode,
        references: [{ input: 'source', output_id: ids.upscaled, original: true, role: 'source_video' }],
      },
      outputs: [{ source: { filename: 'smooth.mp4' }, width: 1536, height: 896 }],
    },
  };
  const workflows = [
    { ...minimax, ready: true },
    { ...ltx, ready: true },
  ];
  const runtime = new ToolRuntime({
    catalog: {
      kind: 'native',
      list: async () => workflows,
      read: async id => workflows.find(workflow => workflow.id === id),
      prepare: async (id, args, options) => {
        const workflow = workflows.find(item => item.id === id);
        return { workflow, job: await resolveNativeWorkflow(workflow, args, assets, options), outputNodes: [] };
      },
    },
    engine: { state: 'ready' },
    gallery: {
      get: async (_conversation, id) => {
        if (!records[id]) throw Object.assign(Error('missing'), { status: 404 });
        return records[id];
      },
    },
    getConfig: () => ({ enabled: true, autoAllow: false, maxIterations: 5 }),
    engineConfig: () => ({}),
    sourceMedia: async source => ({
      mime: records[source.output_id]?.mediaType === 'image' ? 'image/png' : 'video/mp4',
      name: 'clip',
      handle: { close: async () => {} },
    }),
    clientFactory: () => ({}),
  });
  const conversationId = '11111111-1111-4111-8111-111111111111';
  const extend = (output, extra = {}) =>
    runtime.request(
      [
        {
          id: 'call',
          type: 'function',
          function: {
            name: 'extend_video',
            arguments: JSON.stringify({ prompt: 'flies', intention: 'Continue', source: { output }, ...extra }),
          },
        },
      ],
      { conversationId, turnId: conversationId, messages: [] },
    );
  return { ids, records, extend, runtime };
}

test('extending an upscaled then smoothed video continues the clip it was made from', async () => {
  const { ids, extend } = derivedConversation();
  for (const output of [ids.smoothed, ids.upscaled]) {
    const request = await extend(output);
    assert.equal(request.workflowName, 'MiniMax H3', 'the model that made the clip continues it');
    assert.deepEqual(request.resolution, { width: 768, height: 448 }, 'at the size it generates, not the upscaled one');
    assert.equal(request.plan.references[0].output_id, ids.clip);
    assert.match(request.notes.join(' '), /vidéo d’origine.*Upscale vidéo/);
  }
  const direct = await extend(ids.clip);
  assert.equal(direct.plan.references[0].output_id, ids.clip);
  assert.equal(direct.notes, undefined, 'a plain clip is continued as it is');
});

test('a slow-motion video is its own source; a frame rate the model cannot join is refused before confirmation', async () => {
  // Slow motion keeps 24 fps but is other footage: it is continued itself, at its own (upscaled) size.
  const slow = derivedConversation({ mode: 'slow_motion' });
  const request = await slow.extend(slow.ids.smoothed);
  assert.equal(request.plan.references[0].output_id, slow.ids.smoothed);
  assert.deepEqual(request.resolution, { width: 1536, height: 896 });
  const odd = derivedConversation({ fps: 30 });
  await assert.rejects(odd.extend(odd.ids.clip), /30 images\/s.*24 images\/s/);
});

test('a continuation also takes subject references, never a first or last frame', async () => {
  const { ids, records, extend, runtime } = derivedConversation();
  const imageId = '55555555-5555-4555-8555-555555555555';
  records[imageId] = {
    provider: 'native',
    mediaType: 'image',
    workflowId: 'krea',
    parameters: { pipeline: 'krea2', width: 1024, height: 1024 },
    outputs: [{ source: { filename: 'fox.png' }, width: 1024, height: 1024 }],
  };
  const request = await extend(ids.clip, { reference: [{ output: imageId }] });
  assert.equal(request.workflowName, 'MiniMax H3');
  assert.deepEqual(request.plan.references.map(ref => ref.role), ['source_video', 'reference_image']);
  assert.deepEqual(request.resolution, { width: 768, height: 448 }, 'still at the size of its source');
  // In the confirmation window the reference stays a reference: the clip already gives the start.
  assert.deepEqual(request.plan.editable.references[0], [], 'the source stays the source');
  assert.deepEqual(request.plan.editable.references[1].map(option => option.role), ['reference_image']);
  await assert.rejects(
    runtime.revise({
      requestId: request.requestId,
      approvalToken: request.approvalToken,
      edits: { references: [{ index: 1, role: 'start_image' }] },
    }),
    /ne peut pas prendre ce rôle/,
  );
});

test('the next shot of a final video is final too, unless the model says otherwise', async () => {
  const final = derivedConversation({ stage: 'final' });
  assert.equal((await final.extend(final.ids.clip)).plan.stage, 'final');
  assert.equal((await final.extend(final.ids.smoothed)).plan.stage, 'final');
  assert.equal((await final.extend(final.ids.clip, { stage: 'draft' })).plan.stage, 'draft');
  const draft = derivedConversation();
  assert.equal((await draft.extend(draft.ids.clip)).plan.stage, 'draft');
});

test('the user gives an input another role: a subject reference becomes the first frame, its LoRA goes', async () => {
  const conversationId = '11111111-1111-4111-8111-111111111111';
  const imageId = '33333333-3333-4333-8333-333333333333';
  const shipped = validateNativeWorkflow(
    JSON.parse(
      readFileSync(new URL('../runner/workflows/eaec4e2f-0649-4e56-9bd9-809dc9390452.json', import.meta.url), 'utf8'),
    ),
  );
  const workflows = [{ ...shipped, ready: true }];
  const runtime = new ToolRuntime({
    catalog: {
      kind: 'native',
      list: async () => workflows,
      read: async id => workflows.find(workflow => workflow.id === id),
      prepare: async (id, args, options) => {
        const workflow = workflows.find(item => item.id === id);
        return { workflow, job: await resolveNativeWorkflow(workflow, args, assets, options), outputNodes: [] };
      },
    },
    engine: { state: 'ready' },
    gallery: {
      get: async () => ({
        provider: 'native',
        mediaType: 'image',
        workflowId: 'krea',
        parameters: { pipeline: 'krea2', width: 1024, height: 1024 },
        outputs: [{ source: { filename: 'tiger.png' }, width: 1024, height: 1024 }],
      }),
    },
    getConfig: () => ({ enabled: true, autoAllow: false, maxIterations: 5 }),
    engineConfig: () => ({}),
    sourceMedia: async () => ({ mime: 'image/png', name: 'Upscale SeedVR2', handle: { close: async () => {} } }),
    clientFactory: () => ({}),
  });
  const first = await runtime.request(
    [
      {
        id: 'call',
        type: 'function',
        function: {
          name: 'create_video',
          arguments: JSON.stringify({
            prompt: 'a tiger runs',
            intention: 'Le tigre court.',
            reference: [{ output: imageId }],
          }),
        },
      },
    ],
    { conversationId, turnId: conversationId, messages: [] },
  );
  const loras = request => runtime.pending.get(request.requestId).prepared.job.loras.map(lora => lora.id);
  assert.deepEqual(loras(first), ['reference-slots']);
  assert.equal(first.plan.references[0].role, 'msr_image');
  assert.equal(first.plan.references[0].roleLabel, 'Référence de sujet');
  assert.deepEqual(first.plan.editable.references[0].map(option => option.role).sort(), [
    'end_image',
    'msr_image',
    'start_image',
  ]);
  const revise = (request, edits) =>
    runtime.revise({ requestId: request.requestId, approvalToken: request.approvalToken, edits });
  await assert.rejects(
    revise(first, { references: [{ index: 0, role: 'source_video' }] }),
    /ne peut pas prendre ce rôle/,
  );
  await assert.rejects(revise(first, { references: [{ index: 3, role: 'start_image' }] }), /invalides/);
  const second = await revise(first, { references: [{ index: 0, role: 'start_image' }] });
  assert.equal(second.plan.references[0].role, 'start_image');
  assert.equal(second.plan.references[0].input, 'start');
  assert.equal(second.plan.references[0].roleLabel, 'Image de début');
  assert.equal(second.args.references[0].input, 'start');
  assert.equal(second.plan.parameters.start_strength, first.plan.parameters.start_strength);
  assert.deepEqual(loras(second), [], 'a first frame needs no subject LoRA');
});

test('a size the workflow sets takes the format of the image the video starts from, at the profile scale', async () => {
  const args = { prompt: 'x', intention: 'y', references: [{ input: 'start', image: 0 }] };
  const sized = async (extra, options) => {
    const job = await resolveNativeWorkflow(minimax, { ...args, ...extra }, assets, {
      allowPendingReferences: true,
      seed: 1,
      ...options,
    });
    return [job.parameters.width, job.parameters.height];
  };
  const portrait = { aspect: { width: 1024, height: 1792 } };
  assert.deepEqual(await sized({}, {}), [768, 448], 'without an image, the profile');
  assert.deepEqual(await sized({}, portrait), [448, 768], 'a portrait image is animated in portrait');
  assert.deepEqual(await sized({ stage: 'final' }, portrait), [768, 1344]);
  assert.deepEqual(await sized({}, { aspect: { format: '1:1' } }), [512, 512], 'a format asked for by name');
  assert.deepEqual(await sized({}, { aspect: { width: 3000, height: 3010 } }), [512, 512]);
  // No listed format is close to a banner: the profile stays.
  assert.deepEqual(await sized({}, { aspect: { width: 4000, height: 500 } }), [768, 448]);
  // The user's own size still wins, and a continuation keeps its source size.
  assert.deepEqual(await sized({}, { ...portrait, overrides: { width: 1024, height: 576 } }), [1024, 576]);
  const continued = await resolveNativeWorkflow(
    minimax,
    {
      prompt: 'x',
      intention: 'y',
      references: [{ input: 'source', output_id: '22222222-2222-4222-8222-222222222222' }],
    },
    assets,
    { allowPendingReferences: true, seed: 1, sourceSize: { width: 768, height: 448 }, ...portrait },
  );
  assert.deepEqual([continued.parameters.width, continued.parameters.height], [768, 448]);
});

test('a proposal follows its start image, the format the model names, and keeps it across versions', async () => {
  const conversationId = '11111111-1111-4111-8111-111111111111';
  const imageId = '22222222-2222-4222-8222-222222222222';
  const workflows = [{ ...minimax, ready: true }];
  const record = {
    provider: 'native',
    workflowId: 'krea',
    parameters: { pipeline: 'krea2', width: 1024, height: 1792 },
    outputs: [{ source: { filename: 'ship.png' }, width: 1024, height: 1792 }],
  };
  const runtime = new ToolRuntime({
    catalog: {
      kind: 'native',
      list: async () => workflows,
      read: async id => workflows.find(workflow => workflow.id === id),
      prepare: async (id, args, options) => {
        const workflow = workflows.find(item => item.id === id);
        return { workflow, job: await resolveNativeWorkflow(workflow, args, assets, options), outputNodes: [] };
      },
    },
    engine: { state: 'ready' },
    gallery: { get: async () => record },
    getConfig: () => ({ enabled: true, autoAllow: false, maxIterations: 5 }),
    engineConfig: () => ({}),
    sourceMedia: async () => ({ mime: 'image/png', name: 'ship', handle: { close: async () => {} } }),
    clientFactory: () => ({}),
  });
  const propose = args =>
    runtime.request(
      [
        {
          id: 'call',
          type: 'function',
          function: { name: 'create_video', arguments: JSON.stringify({ prompt: 'sails', intention: 'x', ...args }) },
        },
      ],
      { conversationId, turnId: conversationId, messages: [] },
    );
  const size = request => [request.resolution.width, request.resolution.height];
  const revise = (request, edits) =>
    runtime.revise({ requestId: request.requestId, approvalToken: request.approvalToken, edits });

  const animated = await propose({ start_image: { output: imageId } });
  assert.deepEqual(size(animated), [448, 768], 'the ship is 9:16: so is its video');
  const final = await revise(animated, { stage: 'final' });
  assert.deepEqual(size(final), [768, 1344], 'the final version keeps the format');
  assert.equal(final.plan.edited, undefined, 'a format that follows the image is not an edit');

  // Text only: the profile, unless the model passes the format the user named.
  assert.deepEqual(size(await propose({})), [768, 448]);
  const square = await propose({ format: '1:1' });
  assert.deepEqual(size(square), [512, 512]);
  await assert.rejects(propose({ format: '5:4' }), /format doit être/);

  // The user picks another size in the window, then another version: the format stays, the
  // scale is the new profile's (the draft size is not carried into the final).
  const chosen = await revise(square, { width: 576, height: 1024, stage: 'final' });
  assert.deepEqual(size(chosen), [768, 1344]);
  const back = await revise(chosen, { stage: 'draft' });
  assert.deepEqual(size(back), [448, 768]);
});

test('video tools offer a picture format when the workflow sets its own size, never for a continuation', async () => {
  const tools = new ToolCatalog({ list: async () => [{ ...minimax, ready: true }] });
  const definitions = Object.fromEntries(
    (await tools.definitions({ images: 1, resources: [], outputs: [] })).map(item => [
      item.function.name,
      item.function,
    ]),
  );
  assert.deepEqual(definitions.create_video.parameters.properties.format.enum.slice(0, 3), ['16:9', '9:16', '1:1']);
  assert.equal(definitions.extend_video?.parameters.properties.format, undefined);
});
