import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolRuntime } from '../lib/tool-runtime.mjs';
import { resolveNativeWorkflow, validateNativeWorkflow } from '../lib/native-workflows.mjs';

const krea = validateNativeWorkflow({
  schemaVersion: 1,
  id: 'krea',
  enabled: true,
  pipeline: 'krea2',
  mediaType: 'image',
  name: 'Krea 2',
  description: 'Images',
  components: Object.fromEntries(
    ['model', 'textEncoder', 'tokenizer', 'vae'].map(role => [role, { policy: 'fixed', asset: role }]),
  ),
  parameters: {
    prompt: { policy: 'model', type: 'string', maxLength: 8000 },
    seed: { policy: 'random', type: 'integer' },
    width: { policy: 'model', type: 'integer', min: 256, max: 2048, default: 1024 },
    height: { policy: 'model', type: 'integer', min: 256, max: 2048, default: 1024 },
    steps: { policy: 'fixed', value: 8 },
    cfg: { policy: 'fixed', value: 1 },
    denoise: { policy: 'fixed', value: 1 },
  },
  loras: [],
  references: [],
});
const assets = { resolve: async id => ({ id, path: join(tmpdir(), `${id}.safetensors`) }) };

test('an image proposal can be edited by the user too, then confirmed without a token', async () => {
  const conversationId = '11111111-1111-4111-8111-111111111111';
  const runtime = new ToolRuntime({
    catalog: {
      kind: 'native',
      list: async () => [{ ...krea, ready: true }],
      read: async () => krea,
      prepare: async (_id, args, options) => ({
        workflow: krea,
        job: await resolveNativeWorkflow(krea, args, assets, options),
        outputNodes: [],
      }),
    },
    engine: { state: 'ready' },
    gallery: { get: async () => assert.fail('no source') },
    getConfig: () => ({ enabled: true, autoAllow: false, maxIterations: 5 }),
    engineConfig: () => ({}),
    clientFactory: () => ({}),
  });
  const first = await runtime.request(
    [
      {
        id: 'call',
        type: 'function',
        function: { name: 'create_image', arguments: JSON.stringify({ prompt: 'a lighthouse' }) },
      },
    ],
    { conversationId, turnId: conversationId, messages: [] },
  );
  assert.equal(first.mediaType, undefined);
  assert.equal(typeof first.approvalToken, 'string');
  assert.equal(first.plan.prompt, 'a lighthouse');
  assert.deepEqual(first.plan.editable.stages, []);
  const editable = Object.fromEntries(first.plan.editable.parameters.map(item => [item.key, item]));
  assert.deepEqual([editable.width.min, editable.width.max], [256, 2048]);
  assert.equal(editable.steps.value, 8, 'a locked step count is still the user’s to change');
  const second = await runtime.revise({
    requestId: first.requestId,
    approvalToken: first.approvalToken,
    edits: { prompt: 'a lighthouse at night', width: 768, steps: 12 },
  });
  assert.equal(second.plan.prompt, 'a lighthouse at night');
  assert.deepEqual(second.resolution, { width: 768, height: 1024 });
  assert.equal(second.plan.parameters.steps, 12);
  assert.equal(second.plan.parameters.seed, first.plan.parameters.seed);
  assert.deepEqual(second.plan.edited.sort(), ['steps', 'width']);
  await assert.rejects(
    runtime.revise({ requestId: second.requestId, approvalToken: second.approvalToken, edits: { width: 100 } }),
    /range/,
  );
});
