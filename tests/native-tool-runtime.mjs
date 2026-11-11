import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRuntime } from '../lib/tool-runtime.mjs';
const id = 'a1111111-1111-4111-8111-111111111111';
test('native immutable job keeps random seed through authorization and GPU handoff', async () => {
  const events = [];
  let preparation = 0,
    saved;
  const workflow = {
    schemaVersion: 1,
    id: 'image',
    name: 'Image',
    description: '',
    digest: 'a'.repeat(64),
    mediaType: 'image',
    pipeline: 'krea2',
    enabled: true,
    ready: true,
    parameters: { prompt: { policy: 'model', type: 'string' } },
    references: [],
  };
  const catalog = {
    list: async () => [workflow],
    read: async () => workflow,
    prepare: async () => {
      preparation++;
      return {
        workflow,
        job: {
          schemaVersion: 1,
          id,
          pipeline: 'krea2',
          mediaType: 'image',
          workflowId: 'image',
          workflowDigest: workflow.digest,
          parameters: { prompt: 'boat', seed: 123, width: 512, height: 512 },
          components: {},
          loras: [],
          references: [],
        },
        outputNodes: [],
      };
    },
  };
  const engine = {
    busy: false,
    state: 'ready',
    stop: async () => {
      events.push('llm stopped');
      engine.state = 'stopped';
    },
    start: async () => {
      events.push('llm started');
      engine.state = 'ready';
    },
  };
  const client = {
    status: async () => ({ idle: true }),
    preflight: async job => {
      events.push('preflight');
      assert.equal(job.parameters.seed, 123);
    },
    run: async job => {
      events.push('generate');
      assert.equal(engine.state, 'stopped');
      assert.equal(job.parameters.seed, 123);
      return { outputs: [{ filename: 'image.png', subfolder: '', type: 'output' }] };
    },
    free: async () => events.push('gpu released'),
  };
  const runtime = new ToolRuntime({
    engine,
    catalog,
    gallery: {
      put: async record => {
        saved = record;
        return record;
      },
    },
    getConfig: () => ({ enabled: true, autoAllow: false, maxIterations: 5, baseUrl: 'native' }),
    engineConfig: () => ({}),
    clientFactory: () => client,
  });
  const call = {
    id: 'call',
    type: 'function',
    function: { name: 'create_image', arguments: JSON.stringify({ prompt: 'boat' }) },
  };
  const request = await runtime.request([call], {
    conversationId: id,
    turnId: id,
    messages: [{ role: 'user', content: 'boat' }],
  });
  await runtime.execute({ requestId: request.requestId, permission: 'once' });
  await runtime.finished;
  assert.equal(runtime.status().state, 'done', runtime.status().error);
  assert.equal(preparation, 1);
  assert.equal(saved.provider, 'native');
  assert.equal(saved.parameters.seed, 123);
  assert.deepEqual(events, ['preflight', 'llm stopped', 'generate', 'gpu released', 'llm started']);
});

test('a seed named by the user reaches the job instead of a drawn one', async () => {
  const workflow = {
    schemaVersion: 1,
    id: 'image',
    name: 'Image',
    description: '',
    digest: 'a'.repeat(64),
    mediaType: 'image',
    pipeline: 'krea2',
    enabled: true,
    ready: true,
    parameters: { prompt: { policy: 'model', type: 'string' }, seed: { policy: 'random', type: 'integer' } },
    references: [],
  };
  const seeds = [];
  const runtime = new ToolRuntime({
    engine: { busy: false, state: 'ready' },
    catalog: {
      list: async () => [workflow],
      read: async () => workflow,
      prepare: async (_id, args, options) => {
        seeds.push([args.seed, options.seed]);
        return {
          workflow,
          job: {
            schemaVersion: 1,
            id,
            pipeline: 'krea2',
            mediaType: 'image',
            workflowId: 'image',
            workflowDigest: workflow.digest,
            parameters: { prompt: 'boat', seed: options.seed ?? 1, width: 512, height: 512 },
            components: {},
            loras: [],
            references: [],
          },
          outputNodes: [],
        };
      },
    },
    gallery: {},
    getConfig: () => ({ enabled: true, autoAllow: false, maxIterations: 5, baseUrl: 'native' }),
    engineConfig: () => ({}),
    clientFactory: () => ({ status: async () => ({ idle: true }), preflight: async () => {} }),
  });
  const ask = args =>
    runtime.request(
      [{ id: 'call', type: 'function', function: { name: 'create_image', arguments: JSON.stringify(args) } }],
      { conversationId: id, turnId: id, messages: [{ role: 'user', content: 'boat' }] },
    );
  await ask({ prompt: 'boat', seed: 42 });
  await ask({ prompt: 'boat' });
  assert.deepEqual(seeds, [
    [undefined, 42],
    [undefined, undefined],
  ]);
});

test('native video approval shows the resolved fixed stage and cannot use global image authorization', async () => {
  const workflow = {
    schemaVersion: 1,
    id: 'video',
    name: 'Video',
    digest: 'b'.repeat(64),
    mediaType: 'video',
    pipeline: 'ltx25',
    enabled: true,
    ready: true,
    parameters: {},
    references: [],
  };
  const catalog = {
    list: async () => [workflow],
    read: async () => workflow,
    prepare: async () => ({
      workflow,
      job: {
        parameters: { prompt: 'locked prompt', stage: 'draft', seed: 41, width: 384, height: 256 },
        references: [],
        loras: [],
      },
      outputNodes: [],
    }),
  };
  let calls = 0;
  const runtime = new ToolRuntime({
    catalog,
    engine: { state: 'ready', stop: async () => {}, start: async () => {} },
    gallery: { put: async record => record },
    getConfig: () => ({ enabled: true, autoAllow: true, maxIterations: 5, baseUrl: 'native' }),
    engineConfig: () => ({}),
    clientFactory: () => ({
      status: async () => ({ idle: true }),
      preflight: async () => {},
      run: async () => {
        calls++;
        return { outputs: [{ filename: 'video.mp4', subfolder: '', type: 'output' }] };
      },
      free: async () => {},
    }),
  });
  const request = await runtime.request(
    [
      {
        id: 'video-call',
        type: 'function',
        function: { name: 'create_video', arguments: JSON.stringify({ intention: 'Test' }) },
      },
    ],
    { conversationId: id, turnId: id, messages: [] },
  );
  assert.equal(request.autoAllow, false);
  assert.equal(request.args.stage, 'draft');
  assert.equal(request.plan.stage, 'draft');
  assert.equal(request.plan.prompt, 'locked prompt');
  assert.equal(request.plan.parameters.seed, 41);
  await assert.rejects(
    runtime.execute({ requestId: request.requestId, permission: 'always', approvalToken: request.approvalToken }),
  );
  await assert.rejects(runtime.execute({ requestId: request.requestId, permission: 'once', approvalToken: 'wrong' }));
  assert.equal(calls, 0);
  await runtime.execute({ requestId: request.requestId, permission: 'once', approvalToken: request.approvalToken });
  await runtime.finished;
  assert.equal(calls, 1);
  assert.equal(runtime.status().state, 'done');
  await assert.rejects(
    runtime.execute({ requestId: request.requestId, permission: 'once', approvalToken: request.approvalToken }),
  );
});

test('native continuation stages the original video instead of a sampled image', async () => {
  let closed = 0,
    staged = 0,
    generated;
  const sourceId = '22222222-2222-4222-8222-222222222222';
  const workflow = {
    schemaVersion: 1,
    id: 'continue',
    name: 'Continue',
    mediaType: 'video',
    pipeline: 'ltx25',
    enabled: true,
    ready: true,
    parameters: { prompt: { policy: 'model', type: 'string' } },
    digest: 'c'.repeat(64),
    references: [{ id: 'source', role: 'source_video', required: true }],
  };
  const catalog = {
    list: async () => [workflow],
    read: async () => workflow,
    prepare: async () => ({
      workflow,
      job: {
        parameters: { prompt: 'continue', seed: 2, stage: 'draft', width: 384, height: 256 },
        components: {},
        loras: [],
        references: [],
      },
      outputNodes: [],
    }),
  };
  const runtime = new ToolRuntime({
    catalog,
    engine: { state: 'ready', stop: async () => {}, start: async () => {} },
    gallery: {
      put: async record => record,
      get: async () => ({ mediaType: 'video', outputs: [{ source: { filename: 'prior.mp4' } }] }),
    },
    getConfig: () => ({ enabled: true, autoAllow: true, maxIterations: 5, baseUrl: 'native' }),
    engineConfig: () => ({}),
    sourceMedia: async (ref, conversation) => {
      assert.equal(ref.output_id, sourceId);
      assert.equal(conversation, id);
      return { mime: 'video/mp4', name: 'Previous output', handle: { close: async () => closed++ } };
    },
    clientFactory: () => ({
      status: async () => ({ idle: true }),
      preflight: async () => {},
      stage: async media => {
        staged++;
        await media.handle.close();
        return { path: '/local/staged-source.mp4' };
      },
      upload: () => assert.fail('Must not upload sampled pixels'),
      run: async job => {
        generated = job;
        return { outputs: [{ filename: 'new.mp4', subfolder: '', type: 'output' }] };
      },
      free: async () => {},
    }),
  });
  const request = await runtime.request(
    [
      {
        id: 'continue-call',
        type: 'function',
        function: {
          name: 'extend_video',
          arguments: JSON.stringify({ prompt: 'continue', intention: 'Continue', source: { output: sourceId } }),
        },
      },
    ],
    { conversationId: id, turnId: id, messages: [] },
  );
  await runtime.execute({ requestId: request.requestId, permission: 'once', approvalToken: request.approvalToken });
  await runtime.finished;
  assert.equal(runtime.status().state, 'done');
  assert.equal(staged, 1);
  assert.equal(closed, 2);
  assert.deepEqual(generated.references, [{ input: 'source', role: 'source_video', path: '/local/staged-source.mp4' }]);
});

test('draft promotion retains seed and writable choices while final profile remains reviewable', async () => {
  const draftId = '33333333-3333-4333-8333-333333333333',
    components = { model: '/local/model.safetensors' };
  const workflow = {
    schemaVersion: 1,
    id: 'film',
    name: 'Film',
    mediaType: 'video',
    pipeline: 'ltx25',
    enabled: true,
    ready: true,
    parameters: {},
    digest: 'd'.repeat(64),
    references: [],
    profiles: { final: { parameters: { width: 768, height: 512 } } },
  };
  let options, args;
  const prior = {
    provider: 'native',
    mediaType: 'video',
    workflowId: 'film',
    prompt: 'same prompt',
    parameters: {
      workflow_digest: workflow.digest,
      stage: 'draft',
      seed: 987,
      native_components: components,
      replay_args: {
        workflow_id: 'film',
        prompt: 'same prompt',
        stage: 'draft',
        loras: { style: { enabled: true, strength: 0.7 } },
      },
    },
  };
  const catalog = {
    kind: 'native',
    read: async () => workflow,
    prepare: async (_id, a, o) => {
      args = a;
      options = o;
      return {
        workflow,
        job: {
          parameters: { prompt: a.prompt, seed: o.seed, stage: a.stage, width: 768, height: 512 },
          components,
          loras: [],
          references: [],
        },
        outputNodes: [],
      };
    },
  };
  const runtime = new ToolRuntime({
    catalog,
    gallery: {
      get: async (conversation, run) => {
        assert.equal(conversation, id);
        assert.equal(run, draftId);
        return prior;
      },
    },
    getConfig: () => ({ enabled: true, maxIterations: 5, baseUrl: 'native' }),
    engine: {},
    engineConfig: () => ({}),
  });
  const call = changes => [
    {
      id: 'final-call',
      type: 'function',
      function: {
        name: 'create_video',
        arguments: JSON.stringify({
          reuse_output: draftId,
          stage: 'final',
          intention: 'Final version',
          ...changes,
        }),
      },
    },
  ];
  const request = await runtime.request(call(), { conversationId: id, turnId: id, messages: [] });
  assert.equal(options.seed, 987);
  assert.equal(request.plan.parameters.width, 768);
  assert.equal(args.prompt, 'same prompt');
  assert.deepEqual(args.loras, prior.parameters.replay_args.loras);
  await assert.rejects(
    runtime.request(call({ prompt: 'different' }), { conversationId: id, turnId: id, messages: [] }),
  );
});

test('an enhanced prompt is kept with the image, and only when enhancement ran', async () => {
  async function generate(expandPrompt, used) {
    let saved;
    const workflow = {
      schemaVersion: 1,
      id: 'image',
      name: 'Image',
      description: '',
      digest: 'a'.repeat(64),
      mediaType: 'image',
      pipeline: 'krea2',
      enabled: true,
      ready: true,
      parameters: { prompt: { policy: 'model', type: 'string' } },
      references: [],
    };
    const job = {
      schemaVersion: 1,
      id,
      pipeline: 'krea2',
      mediaType: 'image',
      workflowId: 'image',
      workflowDigest: workflow.digest,
      parameters: { prompt: 'boat', seed: 1, width: 1024, height: 1024, expandPrompt },
      components: {},
      loras: [],
      references: [],
    };
    const engine = { busy: false, state: 'ready', stop: async () => {}, start: async () => {} };
    const runtime = new ToolRuntime({
      engine,
      catalog: { list: async () => [workflow], read: async () => workflow, prepare: async () => ({ workflow, job }) },
      gallery: { put: async record => (saved = record) },
      getConfig: () => ({ enabled: true, autoAllow: false, maxIterations: 5, baseUrl: 'native' }),
      engineConfig: () => ({}),
      clientFactory: () => ({
        status: async () => ({ idle: true }),
        preflight: async () => {},
        free: async () => {},
        // The worker reports the prompt it actually encoded.
        run: async () => ({
          outputs: [{ filename: 'image.png', subfolder: '', type: 'output' }],
          metadata: { parameters: { prompt: used } },
        }),
      }),
    });
    const call = { id: 'call', type: 'function', function: { name: 'create_image', arguments: '{"prompt":"boat"}' } };
    const request = await runtime.request([call], { conversationId: id, turnId: id, messages: [] });
    await runtime.execute({ requestId: request.requestId, permission: 'once' });
    await runtime.finished;
    assert.equal(runtime.status().state, 'done', runtime.status().error);
    return saved;
  }
  const enhanced = await generate(true, 'A small red wooden boat drifting on a calm misty lake at dawn.');
  assert.equal(enhanced.prompt, 'boat', 'the requested prompt stays the record prompt');
  assert.equal(enhanced.parameters.expanded_prompt, 'A small red wooden boat drifting on a calm misty lake at dawn.');
  const plain = await generate(false, 'boat');
  assert.equal(plain.parameters.expanded_prompt, undefined);
});

test('an image attached in the chat is upscaled from the file the user gave, not the model’s copy', async () => {
  const attachment = 'original-' + 'b'.repeat(64) + '.png';
  let staged = 0,
    generated,
    opened;
  const workflow = {
    schemaVersion: 1,
    id: 'seedvr2',
    name: 'Upscale SeedVR2',
    mediaType: 'image',
    pipeline: 'seedvr2',
    enabled: true,
    ready: true,
    parameters: { scale: { policy: 'fixed', type: 'number', default: 2 } },
    digest: 'd'.repeat(64),
    references: [{ id: 'source', role: 'source_image', required: true }],
  };
  const catalog = {
    list: async () => [workflow],
    read: async () => workflow,
    prepare: async () => ({
      workflow,
      job: { parameters: { scale: 2, seed: 1 }, components: {}, loras: [], references: [] },
      outputNodes: [],
    }),
  };
  const runtime = new ToolRuntime({
    catalog,
    engine: { state: 'ready', stop: async () => {}, start: async () => {} },
    gallery: { put: async record => record, get: async () => assert.fail('No earlier output is involved') },
    getConfig: () => ({ enabled: true, autoAllow: true, maxIterations: 5, baseUrl: 'native' }),
    engineConfig: () => ({}),
    sourceMedia: async (ref, conversation) => {
      assert.equal(conversation, id);
      opened = ref.attachment;
      return { mime: 'image/png', name: 'Image jointe', handle: { close: async () => {} } };
    },
    clientFactory: () => ({
      status: async () => ({ idle: true }),
      preflight: async () => {},
      stage: async media => {
        staged++;
        await media.handle.close();
        return { path: '/local/original.png' };
      },
      upload: () => assert.fail('The compressed copy must not reach the upscaler'),
      run: async job => {
        generated = job;
        return { outputs: [{ filename: 'upscaled.png', subfolder: '', type: 'output' }] };
      },
      free: async () => {},
    }),
  });
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Agrandis cette photo' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/' }, file: attachment },
      ],
    },
  ];
  const request = await runtime.request(
    [{ id: 'up', type: 'function', function: { name: 'upscale', arguments: JSON.stringify({ source: { image: 0 } }) } }],
    { conversationId: id, turnId: id, messages },
  );
  await runtime.execute({ requestId: request.requestId, permission: 'once', approvalToken: request.approvalToken });
  await runtime.finished;
  assert.equal(runtime.status().state, 'done', runtime.status().error);
  assert.equal(opened, attachment);
  assert.equal(staged, 1);
  assert.deepEqual(generated.references, [{ input: 'source', role: 'source_image', path: '/local/original.png' }]);
});

test('a source the worker refuses fails before the chat model is unloaded, and its staged copy is removed', async () => {
  const events = [];
  const sourceId = '22222222-2222-4222-8222-222222222222';
  const workflow = {
    schemaVersion: 1,
    id: 'continue',
    name: 'Continue',
    mediaType: 'video',
    pipeline: 'ltx25',
    enabled: true,
    ready: true,
    parameters: { prompt: { policy: 'model', type: 'string' } },
    digest: 'c'.repeat(64),
    references: [{ id: 'source', role: 'source_video', required: true }],
  };
  const runtime = new ToolRuntime({
    catalog: {
      list: async () => [workflow],
      read: async () => workflow,
      prepare: async () => ({
        workflow,
        job: { parameters: { prompt: 'continue', seed: 2, stage: 'draft', width: 384, height: 256 }, components: {}, loras: [], references: [] },
        outputNodes: [],
      }),
    },
    engine: { state: 'ready', stop: async () => events.push('llm stopped'), start: async () => events.push('llm started') },
    gallery: {
      put: async record => record,
      get: async () => ({ provider: 'native', mediaType: 'video', outputs: [{ source: { filename: 'prior.mp4' } }], parameters: {} }),
    },
    getConfig: () => ({ enabled: true, autoAllow: true, maxIterations: 5, baseUrl: 'native' }),
    engineConfig: () => ({}),
    sourceMedia: async () => ({ mime: 'video/mp4', name: 'Previous output', handle: { close: async () => {} } }),
    clientFactory: () => ({
      status: async () => ({ idle: true }),
      stage: async media => {
        events.push('staged');
        await media.handle.close();
        return { path: '/local/staged-source.mp4' };
      },
      preflight: async job => {
        events.push('preflight ' + job.references.map(ref => ref.path).join());
        throw Error('La vidéo source est à 48 images/s');
      },
      run: () => assert.fail('Must not generate'),
      free: async () => events.push('staged copies removed'),
    }),
  });
  const request = await runtime.request(
    [
      {
        id: 'continue-call',
        type: 'function',
        function: {
          name: 'extend_video',
          arguments: JSON.stringify({ prompt: 'continue', intention: 'Continue', source: { output: sourceId } }),
        },
      },
    ],
    { conversationId: id, turnId: id, messages: [] },
  );
  await assert.rejects(
    runtime.execute({ requestId: request.requestId, permission: 'once', approvalToken: request.approvalToken }),
    /48 images\/s/,
  );
  assert.deepEqual(events, ['staged', 'preflight /local/staged-source.mp4', 'staged copies removed']);
  assert.equal(runtime.status().state, 'error');
  assert.equal(runtime.active, false);
});

test('a sound is always confirmed with its token, runs as audio and is saved as audio', async () => {
  const workflow = {
    schemaVersion: 1,
    id: 'music',
    name: 'Musique',
    description: '',
    digest: 'c'.repeat(64),
    mediaType: 'audio',
    pipeline: 'acestep15',
    enabled: true,
    ready: true,
    parameters: {
      prompt: { policy: 'model', type: 'string' },
      lyrics: { policy: 'model', type: 'string', default: '' },
      seconds: { policy: 'model', type: 'number', min: 10, max: 600, default: 60 },
    },
    references: [],
  };
  let prepared, ran, saved;
  const catalog = {
    list: async () => [workflow],
    read: async () => workflow,
    prepare: async (_workflow, args) => {
      prepared = args;
      return {
        workflow,
        job: {
          schemaVersion: 1,
          id,
          pipeline: 'acestep15',
          mediaType: 'audio',
          workflowId: 'music',
          workflowDigest: workflow.digest,
          parameters: { prompt: args.prompt, lyrics: args.lyrics, seconds: args.seconds, seed: 5 },
          components: {},
          loras: [],
          references: [],
        },
        outputNodes: [],
      };
    },
  };
  const runtime = new ToolRuntime({
    catalog,
    engine: { state: 'ready', stop: async () => {}, start: async () => {} },
    gallery: {
      put: async record => {
        saved = record;
        return record;
      },
    },
    // « Toujours autoriser » is for images: it never starts a sound by itself.
    getConfig: () => ({ enabled: true, autoAllow: true, maxIterations: 5, baseUrl: 'native' }),
    engineConfig: () => ({}),
    clientFactory: () => ({
      status: async () => ({ idle: true }),
      preflight: async () => {},
      run: async (job, options) => {
        ran = { job, options };
        return { outputs: [{ filename: 'song.wav', subfolder: '', type: 'output', seconds: 30 }] };
      },
      free: async () => {},
    }),
  });
  const args = { prompt: 'synth-pop, 110 BPM, female voice', lyrics: '[Chorus]\nLa nuit', seconds: 30 };
  const request = await runtime.request(
    [{ id: 'song', type: 'function', function: { name: 'create_audio', arguments: JSON.stringify(args) } }],
    { conversationId: id, turnId: id, messages: [{ role: 'user', content: 'une chanson' }] },
  );
  assert.equal(request.autoAllow, false);
  assert.equal(request.mediaType, 'audio');
  assert.equal(prepared.lyrics, '[Chorus]\nLa nuit');
  assert.equal(prepared.seconds, 30);
  await assert.rejects(runtime.execute({ requestId: request.requestId, permission: 'once' }));
  assert.equal(ran, undefined);
  await runtime.execute({ requestId: request.requestId, permission: 'once', approvalToken: request.approvalToken });
  await runtime.finished;
  assert.equal(runtime.status().state, 'done', runtime.status().error);
  assert.equal(ran.job.mediaType, 'audio');
  assert.equal(ran.options?.mediaType, 'audio');
  assert.equal(saved.mediaType, 'audio');
  assert.equal(saved.outputs[0].filename ?? saved.outputs[0].source?.filename, 'song.wav');
});
