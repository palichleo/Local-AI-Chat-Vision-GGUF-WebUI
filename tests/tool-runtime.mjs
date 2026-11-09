import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRuntime, collectToolCalls } from '../lib/tool-runtime.mjs';
const id = 'a1111111-1111-4111-8111-111111111111';
// Minimal native catalog: a resolved job plus the workflow it came from.
const nativeWorkflow = (fields = {}) => ({
  schemaVersion: 1,
  id: 'wf',
  pipeline: 'krea2',
  mediaType: 'image',
  enabled: true,
  ready: true,
  parameters: { prompt: { policy: 'model', type: 'string' } },
  references: [],
  ...fields,
});
const nativePrepared = (workflow, references = []) => ({
  workflow,
  job: {
    pipeline: 'krea2',
    parameters: { prompt: 'portrait', seed: 7, width: 512, height: 512 },
    components: {},
    loras: [],
    references,
  },
});

test('native deltas assemble tool arguments; text never becomes a tool', () => {
  const calls = [];
  collectToolCalls(calls, {
    tool_calls: [{ index: 0, id: 'call_1', function: { name: 'create_image', arguments: '{"prompt":' } }],
  });
  collectToolCalls(calls, { tool_calls: [{ index: 0, function: { arguments: '"cat"}' } }] });
  assert.equal(calls[0].function.arguments, '{"prompt":"cat"}');
  collectToolCalls(calls, { content: '{"tool":"create_image"}' });
  assert.equal(calls.length, 1);
});
test('approval pins workflow, is consumed once, and enforces a turn limit', async () => {
  let digest = 'one',
    runs = 0;
  const order = [];
  const workflow = nativeWorkflow({ id: 'wf', name: 'test', digest });
  const catalog = {
    list: async () => [{ ...workflow, digest }],
    read: async () => ({ ...workflow, digest }),
    prepare: async () => nativePrepared(workflow),
  };
  const engine = {
    state: 'ready',
    busy: false,
    stop: async () => {
      order.push('stop');
      engine.state = 'stopped';
    },
    start: async () => {
      order.push('start');
      engine.state = 'ready';
    },
  };
  const client = {
    status: async () => ({ idle: true }),
    preflight: async () => {},
    run: async () => {
      runs++;
      order.push('run');
      return { outputs: [{ filename: 'x.png', subfolder: '', type: 'output' }] };
    },
    free: async () => {
      order.push('free');
    },
  };
  const gallery = { put: async r => r };
  const rt = new ToolRuntime({
    engine,
    catalog,
    gallery,
    getConfig: () => ({ enabled: true, autoAllow: false, maxIterations: 1 }),
    engineConfig: () => ({}),
    clientFactory: () => client,
  });
  const calls = [
    {
      id: 'call_1',
      type: 'function',
      function: { name: 'create_image', arguments: '{"prompt":"cat"}' },
    },
  ];
  const pending = await rt.request(calls, { conversationId: id, turnId: id, messages: [] });
  await assert.rejects(rt.execute({ requestId: pending.requestId, permission: 'none' }), /autorisation/i);
  digest = 'changed';
  await assert.rejects(rt.execute({ requestId: pending.requestId, permission: 'once' }), /modifié/i);
  digest = 'one';
  const p = await rt.request(calls, { conversationId: id, turnId: id, messages: [] });
  const job = await rt.execute({ requestId: p.requestId, permission: 'once' });
  await rt.finished;
  assert.equal(rt.job.state, 'done');
  assert.equal(job.id, rt.job.id);
  assert.equal(rt.job.record.parameters.reference_count, 0);
  assert.equal(rt.job.record.parameters.reference_capacity, 0);
  assert.equal(rt.job.record.parameters.reference_mode, 'not_provided');
  assert.deepEqual(order, ['stop', 'run', 'free', 'start']);
  assert.equal(runs, 1);
  await assert.rejects(rt.execute({ requestId: p.requestId, permission: 'once' }), /expiré/i);
  await assert.rejects(rt.request(calls, { conversationId: id, turnId: id, messages: [] }), /limite/i);
});
test('a failed GPU release keeps the LLM stopped and records the error', async () => {
  let starts = 0;
  const engine = {
    state: 'ready',
    stop: async () => {},
    start: async () => {
      starts++;
    },
  };
  const rt = new ToolRuntime({
    engine,
    catalog: {
      list: async () => [nativeWorkflow({ digest: '1', name: 'wf' })],
      read: async () => nativeWorkflow({ digest: '1', name: 'wf' }),
      prepare: async () => nativePrepared(nativeWorkflow({ name: 'wf', digest: '1' })),
    },
    gallery: { put: async r => r },
    getConfig: () => ({ enabled: true, autoAllow: true, maxIterations: 3 }),
    engineConfig: () => ({}),
    clientFactory: () => ({
      status: async () => ({ idle: true }),
      preflight: async () => {},
      run: async () => {
        throw Error('failed');
      },
      free: async () => {
        throw Error('VRAM');
      },
    }),
  });
  const p = await rt.request(
    [
      {
        id: 'c',
        type: 'function',
        function: { name: 'create_image', arguments: '{"prompt":"cat"}' },
      },
    ],
    { conversationId: id, turnId: id, messages: [] },
  );
  await rt.execute({ requestId: p.requestId });
  await rt.finished;
  assert.equal(rt.active, true);
  assert.equal(starts, 0);
  assert.equal(rt.job.state, 'error');
  assert.match(rt.job.error, /VRAM/);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function runtimeFixture() {
  const seen = { runs: 0, stops: 0, starts: 0, references: [] };
  const workflow = nativeWorkflow({
    id: 'wf',
    name: 'Portrait',
    digest: 'approved',
    references: [{ id: 'source', name: 'Source', role: 'img2img', description: 'Image to edit', required: false }],
  });
  const engine = {
    state: 'ready',
    busy: false,
    async stop() {
      seen.stops++;
      engine.state = 'stopped';
    },
    async start() {
      seen.starts++;
      engine.state = 'ready';
    },
  };
  const catalog = {
    async list() {
      return [{ ...workflow }];
    },
    async read() {
      return { ...workflow };
    },
    async prepare() {
      return nativePrepared({ ...workflow });
    },
  };
  const client = {
    async status() {
      return { idle: true };
    },
    async preflight() {},
    async run(job) {
      seen.runs++;
      seen.references.push(job.references);
      return { outputs: [{ filename: 'portrait.png', subfolder: '', type: 'output' }] };
    },
    async free() {
      return { idle: true, memory: { torchAllocated: 0 } };
    },
  };
  const rt = new ToolRuntime({
    engine,
    catalog,
    gallery: { put: async record => record },
    getConfig: () => ({ enabled: true, autoAllow: false, maxIterations: 1 }),
    engineConfig: () => ({}),
    clientFactory: () => client,
  });
  const request = (args = {}, messages = []) =>
    rt.request(
      [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'create_image',
            arguments: JSON.stringify({ prompt: 'portrait', ...args }),
          },
        },
      ],
      { conversationId: id, turnId: id, messages },
    );
  return { rt, seen, workflow, catalog, client, request };
}

test('concurrent execute claims one approval before asynchronous preflight', async () => {
  const { rt, seen, client, request } = runtimeFixture();
  const gate = deferred();
  client.status = async () => {
    await gate.promise;
    return { idle: true };
  };
  const pending = await request();
  const first = rt.execute({ requestId: pending.requestId, permission: 'once' });
  assert.equal(rt.active, true, 'preflight owns the GPU before the first await');
  await assert.rejects(rt.execute({ requestId: pending.requestId, permission: 'once' }), { status: 409 });
  gate.resolve();
  const job = await first;
  await rt.finished;
  assert.equal(seen.runs, 1);
  assert.equal(rt.status().id, job.id);
  assert.equal(rt.status().state, 'done');
  await assert.rejects(rt.execute({ requestId: pending.requestId, permission: 'once' }), /expiré/i);
});

test('a workflow changed during the engine status check never reaches execution', async () => {
  const { rt, seen, workflow, client, request } = runtimeFixture();
  const pending = await request();
  client.status = async () => {
    workflow.digest = 'replaced';
    return { idle: true };
  };
  await rt.execute({ requestId: pending.requestId, permission: 'once' });
  await rt.finished;
  assert.equal(seen.runs, 0);
  assert.equal(rt.status().state, 'error');
  assert.match(rt.status().error, /workflow.*modifié/i);
});

test('a chat image reference is uploaded once and reaches the job as a staged path', async () => {
  const { rt, seen, client, request } = runtimeFixture();
  let uploads = 0;
  client.upload = async bytes => {
    uploads++;
    assert.deepEqual(bytes, Buffer.from('89504e470d0a1a0a', 'hex'));
    return { path: '/staged/reference.png' };
  };
  const pending = await request({ source: { image: 0 } }, [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] },
  ]);
  await rt.execute({ requestId: pending.requestId, permission: 'once' });
  await rt.finished;
  assert.equal(uploads, 1);
  assert.deepEqual(seen.references.at(-1), [{ input: 'source', role: 'img2img', path: '/staged/reference.png' }]);
  assert.equal(rt.status().state, 'done');
});

test('unconfirmed cleanup blocks execution until explicit recovery succeeds', async () => {
  const { rt, seen, client, request } = runtimeFixture();
  const pending = await request();
  client.free = async () => {
    throw new Error('allocation still unknown');
  };
  await rt.execute({ requestId: pending.requestId, permission: 'once' });
  await rt.finished;
  assert.equal(rt.active, true);
  assert.equal(rt.status().blocked, true);
  assert.equal(rt.status().state, 'error');
  assert.equal(seen.starts, 0);
  await assert.rejects(rt.execute({ requestId: pending.requestId, permission: 'once' }), { status: 409 });
  await assert.rejects(rt.recover(), /allocation still unknown/);
  assert.equal(rt.active, true);
  assert.equal(rt.status().blocked, true);
  const gate = deferred();
  client.free = async () => {
    await gate.promise;
    return { idle: true, memory: { torchAllocated: 0 } };
  };
  const recovery = rt.recover();
  assert.equal(rt.active, true, 'recovery owns the GPU until release confirmation');
  gate.resolve();
  const recovered = await recovery;
  assert.equal(recovered.blocked, false);
  assert.equal(rt.active, false);
  assert.equal(recovered.state, 'done');
  await assert.rejects(rt.recover(), { status: 409 });
});

test('forgetting one conversation invalidates only its pending calls and completed job', async () => {
  const { rt, request, seen } = runtimeFixture();
  const first = await request();
  const other = 'b2222222-2222-4222-8222-222222222222';
  const second = await rt.request(
    [
      {
        id: 'other_call',
        type: 'function',
        function: {
          name: 'create_image',
          arguments: JSON.stringify({ prompt: 'Another portrait' }),
        },
      },
    ],
    { conversationId: other, turnId: other, messages: [] },
  );
  rt.forgetConversation(id);
  await assert.rejects(rt.execute({ requestId: first.requestId, permission: 'once' }), /expiré/i);
  await rt.execute({ requestId: second.requestId, permission: 'once' });
  await rt.finished;
  assert.equal(seen.runs, 1);
  rt.forgetConversation(id);
  assert.equal(rt.job.record.conversationId, other);
  rt.forgetConversation(other);
  assert.equal(rt.job, null);
});

test('cancel targets the owned request and cannot abort another job', async () => {
  const { rt, client, request } = runtimeFixture(),
    gate = deferred();
  client.status = async () => {
    await gate.promise;
    return { idle: true };
  };
  const p = await request();
  const executing = rt.execute({ requestId: p.requestId, permission: 'once' });
  try {
    assert.throws(() => rt.cancel({ requestId: 'different-request' }), { status: 409 });
    assert.equal(rt.job.controller.signal.aborted, false);
    rt.cancel({ requestId: p.requestId });
    assert.equal(rt.job.controller.signal.aborted, true);
  } finally {
    gate.resolve();
    await assert.rejects(executing, { name: 'AbortError' });
    await rt.close();
  }
});

test('closing waits for explicit GPU recovery and rejects any later execution', async () => {
  const { rt, client, request } = runtimeFixture(),
    p = await request();
  client.free = async () => {
    throw Error('not released');
  };
  await rt.execute({ requestId: p.requestId, permission: 'once' });
  await rt.finished;
  const gate = deferred();
  client.free = async () => gate.promise;
  const recovery = rt.recover();
  let closed = false;
  const closing = rt.close().then(() => {
    closed = true;
  });
  await new Promise(setImmediate);
  assert.equal(closed, false);
  gate.resolve();
  await recovery;
  await closing;
  await assert.rejects(request(), { status: 409 });
});

test('GPU recovery cannot turn a failed generation into a successful image', async () => {
  const { rt, client, request } = runtimeFixture(),
    p = await request();
  client.run = async () => {
    throw Error('workflow rejected');
  };
  client.free = async () => {
    throw Error('memory unknown');
  };
  await rt.execute({ requestId: p.requestId, permission: 'once' });
  await rt.finished;
  client.free = async () => {};
  await rt.recover();
  assert.equal(rt.active, false);
  assert.equal(rt.status().state, 'error');
  assert.match(rt.status().error, /workflow rejected/);
});

test('a gallery disk write failure keeps generated originals linked in session memory', async () => {
  const { rt, request } = runtimeFixture();
  const writes = [];
  rt.persist = () => true;
  rt.gallery.put = async (record, { persist }) => {
    writes.push(persist);
    if (persist) throw Error('disk full');
    return record;
  };
  const p = await request();
  await rt.execute({ requestId: p.requestId, permission: 'once' });
  await rt.finished;
  assert.equal(rt.status().state, 'done');
  assert.equal(rt.status().record?.outputs[0].source.filename, 'portrait.png');
  assert.match(rt.status().warning, /disk full/);
  assert.deepEqual(writes, [true, false]);
});

test('cancelling while global approval is saved never unloads the language model', async () => {
  const { rt, request, seen } = runtimeFixture(),
    entered = deferred(),
    gate = deferred();
  rt.saveConfig = async () => {
    entered.resolve();
    await gate.promise;
  };
  const p = await request(),
    execution = rt.execute({ requestId: p.requestId, permission: 'always' });
  await entered.promise;
  rt.cancel({ requestId: p.requestId });
  gate.resolve();
  await assert.rejects(execution, { name: 'AbortError' });
  await rt.finished;
  assert.equal(seen.stops, 0);
  assert.equal(seen.runs, 0);
});

test('cancelling a pending approval releases its reference copies and prevents later execution', async () => {
  const { rt, request, seen } = runtimeFixture(),
    approval = await request();
  rt.cancel({ requestId: approval.requestId });
  assert.equal(rt.pending.size, 0);
  await assert.rejects(rt.execute({ requestId: approval.requestId, permission: 'once' }), /expiré/i);
  assert.equal(seen.runs, 0);
});

test('an active resource is passed as its original file, and deactivating it before execution keeps the model loaded', async () => {
  const { rt, seen, client, request } = runtimeFixture();
  const resource = 'c3333333-3333-4333-8333-333333333333';
  let active = true;
  rt.resources = {
    activeRecord: async id => {
      assert.equal(id, resource);
      if (!active) throw Object.assign(Error('Ressource désactivée.'), { status: 409 });
      return { mime: 'image/png' };
    },
  };
  rt.sourceMedia = async ref => {
    assert.equal(ref.resource_id, resource);
    return { mime: 'image/png', name: 'chair.png', handle: { close: async () => {} } };
  };
  client.stage = async () => ({ path: '/staged/chair.png' });
  const approved = await request({ source: { resource } });
  await rt.execute({ requestId: approved.requestId, permission: 'once' });
  await rt.finished;
  assert.deepEqual(seen.references.at(-1), [{ input: 'source', role: 'img2img', path: '/staged/chair.png' }]);
  const again = await request({ source: { resource } }).catch(error => error);
  // The turn limit is one in this fixture; a fresh runtime checks deactivation.
  assert.match(again.message, /limite/i);
  const second = runtimeFixture();
  second.rt.resources = rt.resources;
  second.rt.sourceMedia = rt.sourceMedia;
  const pending = await second.request({ source: { resource } });
  active = false;
  await assert.rejects(second.rt.execute({ requestId: pending.requestId, permission: 'once' }), /désactivée/);
  assert.equal(second.seen.stops, 0);
  assert.equal(second.seen.runs, 0);
});

test('a verb with no matching workflow explains which inputs are available', async () => {
  const { rt } = runtimeFixture();
  await assert.rejects(
    rt.request(
      [{ id: 'c', type: 'function', function: { name: 'create_video', arguments: '{"prompt":"x","intention":"y"}' } }],
      { conversationId: id, turnId: id, messages: [] },
    ),
    /Aucun workflow/,
  );
  await assert.rejects(
    rt.request(
      [
        {
          id: 'c',
          type: 'function',
          function: { name: 'create_image', arguments: '{"prompt":"x","start_image":{"image":0}}' },
        },
      ],
      { conversationId: id, turnId: id, messages: [] },
    ),
    /Aucun workflow|start_image/,
  );
});
