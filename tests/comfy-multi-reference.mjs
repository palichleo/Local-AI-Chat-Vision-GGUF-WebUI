import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowCatalog } from '../lib/comfy-workflows.mjs';
import { ToolRuntime } from '../lib/tool-runtime.mjs';
import { ComfyClient } from '../lib/comfy-client.mjs';

const resourceId = 'a1111111-1111-4111-8111-111111111111';
const first = Buffer.from('89504e470d0a1a0a01', 'hex'),
  second = Buffer.from('89504e470d0a1a0a02', 'hex');
const data = bytes => 'data:image/png;base64,' + bytes.toString('base64');
function workflow() {
  return {
    id: 'two-refs',
    name: 'Custom two-image workflow',
    description: 'Combine the subject and the style.',
    graph: {
      11: { class_type: 'CustomPrompt', inputs: { instruction: 'Original' } },
      42: { class_type: 'CustomFileLoader', inputs: { source_file: 'old-subject.png', strength: 0.7 } },
      73: { class_type: 'AnotherCustomLoader', inputs: { style_file: 'old-style.png' } },
      99: { class_type: 'CustomImageSaver', inputs: { images: ['42', 0], style: ['73', 0], prompt: ['11', 0] } },
    },
    bindings: { prompt: { node: '11', input: 'instruction' } },
    outputNodes: ['99'],
    imageInputs: [
      {
        id: 'subject',
        name: 'Sujet',
        description: 'Personnage à conserver.',
        node: '42',
        input: 'source_file',
        required: true,
      },
      {
        id: 'style',
        name: 'Style',
        description: 'Palette et rendu à reprendre.',
        node: '73',
        input: 'style_file',
        required: false,
      },
    ],
  };
}
async function catalogTest(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-multi-'));
  try {
    const catalog = new WorkflowCatalog(directory);
    await catalog.save(workflow());
    await fn(catalog, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('multiple declared image inputs persist and route uploads without any node-class convention', async () =>
  catalogTest(async (catalog, directory) => {
    const saved = await new WorkflowCatalog(directory).read('two-refs');
    assert.equal(saved.imageInputs.length, 2);
    const broken = workflow();
    delete broken.graph['99'].inputs.style;
    await catalog.save(broken);
    await assert.rejects(
      catalog.prepare(
        'two-refs',
        {
          prompt: 'New',
          references: [
            { input: 'subject', image: 0 },
            { input: 'style', image: 1 },
          ],
        },
        { referenceImages: { subject: 'one.png', style: 'two.png' } },
      ),
      /not connected/,
    );
    await catalog.save(workflow());
    const refs = [
      { input: 'style', resource_id: resourceId, frame: 1 },
      { input: 'subject', image: 0 },
    ];
    const prepared = await catalog.prepare(
      'two-refs',
      { prompt: 'New', references: refs },
      {
        referenceImages: {
          subject: { name: 'one.png', subfolder: 'refs', type: 'input' },
          style: { name: 'two.png', subfolder: 'different', type: 'input' },
        },
      },
    );
    assert.equal(prepared.graph['42'].inputs.source_file, 'refs/one.png');
    assert.equal(prepared.graph['73'].inputs.style_file, 'different/two.png');
    assert.equal(prepared.graph['42'].inputs.strength, 0.7);
    assert.deepEqual(prepared.graph['99'].inputs.images, ['42', 0]);
    assert.deepEqual((await catalog.read('two-refs')).graph, workflow().graph);
    const definition = await catalog.definition();
    assert.deepEqual(definition.function.parameters.properties.references.items.properties.input.enum, [
      'subject',
      'style',
    ]);
    assert.match(definition.function.description, /Personnage à conserver/);
    assert.match(definition.function.description, /Palette et rendu/);
    const optional = await catalog.prepare(
      'two-refs',
      { prompt: 'Only subject', references: [{ input: 'subject', image: 0 }] },
      { referenceImages: { subject: 'one.png' } },
    );
    assert.equal(optional.graph['73'].inputs.style_file, 'old-style.png');
  }));

test('ambiguous, missing, undeclared and unsafe reference mappings fail before graph execution', async () =>
  catalogTest(async catalog => {
    const subject = { input: 'subject', image: 0 };
    for (const references of [
      [],
      [subject, subject],
      [{ input: 'unknown', image: 0 }],
      [{ input: 'subject', image: 0, resource_id: resourceId }],
      [{ input: 'subject' }],
      [{ ...subject, frame: 0 }],
      [{ ...subject, image: 6400 }],
      [{ input: 'subject', resource_id: '../file' }],
      [{ input: 'subject', resource_id: resourceId, frame: 3 }],
      {},
      [{ ...subject, node: '73' }],
    ])
      await assert.rejects(
        catalog.prepare(
          'two-refs',
          { prompt: 'New', references },
          { referenceImages: { subject: 'one.png', style: 'two.png' } },
        ),
      );
    await assert.rejects(
      catalog.prepare(
        'two-refs',
        { prompt: 'New', references: [subject], reference_image: 0 },
        { referenceImages: { subject: 'one.png' } },
      ),
    );
    await assert.rejects(catalog.prepare('two-refs', { prompt: 'New', references: [subject] }), /uploaded reference/i);
    for (const modify of [
      w => w.imageInputs.push({ ...w.imageInputs[0] }),
      w => (w.imageInputs[1].node = '42'),
      w => (w.imageInputs[1].input = 'missing'),
      w => (w.imageInputs[1].description = ''),
      w => (w.imageInputs[0].node = 42),
      w => (w.imageInputs[1].required = 'true'),
      w => {
        w.imageInputs[1].node = '99';
        w.imageInputs[1].input = 'images';
      },
      w => {
        w.imageInputs[1].node = '11';
        w.imageInputs[1].input = 'instruction';
      },
    ]) {
      const w = workflow();
      modify(w);
      await assert.rejects(catalog.save(w));
    }
  }));

async function runtimeTest(fn) {
  return catalogTest(async catalog => {
    const uploads = [],
      graphs = [],
      events = [];
    let enabled = true,
      failUpload = false;
    const server = http.createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const bytes = Buffer.concat(chunks),
          path = new URL(req.url, 'http://127.0.0.1').pathname;
        const json = value => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(value));
        };
        if (path === '/queue') return json({ queue_running: [], queue_pending: [] });
        if (path === '/system_stats') return json({ devices: [] });
        if (path === '/upload/image') {
          if (failUpload) {
            res.writeHead(500);
            return res.end('upload failed');
          }
          const form = await new Request('http://127.0.0.1/upload/image', {
              method: 'POST',
              headers: req.headers,
              body: bytes,
            }).formData(),
            file = form.get('image');
          uploads.push({ name: file.name, bytes: Buffer.from(await file.arrayBuffer()) });
          return json({ name: file.name, subfolder: 'uploaded/references', type: 'input' });
        }
        if (path === '/prompt') {
          graphs.push(JSON.parse(bytes).prompt);
          events.push('generate');
          return json({ prompt_id: 'multi-job' });
        }
        if (path === '/history/multi-job')
          return json({
            'multi-job': {
              status: { completed: true, status_str: 'success' },
              outputs: { 99: { images: [{ filename: 'original.png', subfolder: 'outputs', type: 'output' }] } },
            },
          });
        if (path === '/free') {
          events.push('free');
          return json({});
        }
        res.writeHead(404);
        res.end();
      } catch (error) {
        res.writeHead(500);
        res.end(error.message);
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    const engine = {
      state: 'ready',
      busy: false,
      stop: async () => {
        events.push('stop');
        engine.state = 'stopped';
      },
      start: async () => {
        events.push('start');
        engine.state = 'ready';
      },
    };
    const resources = {
      readActive: async () => {
        if (!enabled) throw Error('Inactive reference');
        return { frames: [{ url: data(second) }, { url: data(second) }] };
      },
      activeRecord: async () => {
        if (!enabled) throw Error('Inactive reference');
      },
    };
    const runtime = new ToolRuntime({
      engine,
      catalog,
      resources,
      gallery: { put: async record => record },
      getConfig: () => ({ enabled: true, autoAllow: false, maxIterations: 5, baseUrl: url }),
      engineConfig: () => ({}),
      clientFactory: () => new ComfyClient(url, { pollMs: 0 }),
    });
    const request = (
      references,
      messages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: data(first) } }] }],
    ) =>
      runtime.request(
        [
          {
            id: 'multi-call',
            type: 'function',
            function: {
              name: 'comfy_generate_image',
              arguments: JSON.stringify({
                workflow_id: 'two-refs',
                prompt: 'Combine the chosen references',
                references,
              }),
            },
          },
        ],
        { conversationId: resourceId, turnId: resourceId, messages },
      );
    try {
      await fn({
        runtime,
        request,
        uploads,
        graphs,
        events,
        disable: () => {
          enabled = false;
        },
        failUpload: () => {
          failUpload = true;
        },
      });
    } finally {
      await runtime.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}

test('one approved HTTP Comfy call uploads chat and library sources to their distinct mapped inputs', async () =>
  runtimeTest(async ({ runtime, request, uploads, graphs, events }) => {
    const refs = [
        { input: 'style', resource_id: resourceId, frame: 1 },
        { input: 'subject', image: 0 },
      ],
      pending = await request(refs);
    assert.deepEqual(pending.args.references, refs);
    assert.equal(uploads.length, 0);
    assert.deepEqual(events, []);
    await runtime.execute({ requestId: pending.requestId, permission: 'once' });
    await runtime.finished;
    assert.equal(runtime.job.state, 'done');
    assert.equal(uploads.length, 2);
    assert.notEqual(uploads[0].name, uploads[1].name);
    assert.deepEqual(uploads[0].bytes, second);
    assert.deepEqual(uploads[1].bytes, first);
    assert.equal(graphs[0]['73'].inputs.style_file, 'uploaded/references/' + uploads[0].name);
    assert.equal(graphs[0]['42'].inputs.source_file, 'uploaded/references/' + uploads[1].name);
    assert.deepEqual(events, ['stop', 'generate', 'free', 'start']);
    assert.deepEqual(runtime.job.record.parameters.references, refs);
  }));

test('the same source assigned twice uploads once; internal generated images never shift chat indices', async () =>
  runtimeTest(async ({ runtime, request, uploads, graphs }) => {
    const pending = await request(
      [
        { input: 'subject', image: 0 },
        { input: 'style', image: 0 },
      ],
      [
        { role: 'user', internal: true, content: [{ type: 'image_url', image_url: { url: data(second) } }] },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: data(first) } }] },
      ],
    );
    await runtime.execute({ requestId: pending.requestId, permission: 'once' });
    await runtime.finished;
    assert.equal(uploads.length, 1);
    assert.deepEqual(uploads[0].bytes, first);
    assert.equal(graphs[0]['42'].inputs.source_file, graphs[0]['73'].inputs.style_file);
  }));

test('missing or disabled sources do not unload the model; upload failures never execute a partial graph', async () =>
  runtimeTest(async ({ runtime, request, uploads, graphs, events, disable, failUpload }) => {
    await assert.rejects(request([{ input: 'subject', image: 2 }]), /introuvable/);
    assert.deepEqual(events, []);
    const p = await request([{ input: 'subject', resource_id: resourceId }]);
    disable();
    await assert.rejects(runtime.execute({ requestId: p.requestId, permission: 'once' }), /Inactive/);
    assert.deepEqual(events, []);
    const next = await request([
      { input: 'subject', image: 0 },
      { input: 'style', image: 0 },
    ]);
    failUpload();
    await runtime.execute({ requestId: next.requestId, permission: 'once' });
    await runtime.finished;
    assert.equal(runtime.job.state, 'error');
    assert.equal(uploads.length, 0);
    assert.equal(graphs.length, 0);
    assert.deepEqual(events, ['stop', 'free', 'start']);
  }));

test('omitted optional reference inputs are reported as workflow defaults rather than user-supplied pixels', async () =>
  runtimeTest(async ({ runtime, request }) => {
    const p = await request([{ input: 'subject', image: 0 }]);
    await runtime.execute({ requestId: p.requestId, permission: 'once' });
    await runtime.finished;
    assert.equal(runtime.job.state, 'done');
    assert.equal(runtime.job.record.parameters.reference_count, 1);
    assert.deepEqual(
      runtime.job.record.parameters.reference_defaults.map(ref => ref.input),
      ['style'],
    );
  }));
