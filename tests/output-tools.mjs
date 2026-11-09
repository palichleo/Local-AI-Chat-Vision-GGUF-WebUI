import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Gallery } from '../lib/gallery.mjs';
import { readOutput } from '../lib/output-tools.mjs';
import { createApplication } from '../server.mjs';
import { readSSE } from '../public/stream.mjs';
import { updateSession } from '../lib/update-session.mjs';

const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rLkAAAAASUVORK5CYII=',
  jpeg = 'data:image/jpeg;base64,/9j/2Q==';
function run(overrides = {}) {
  return {
    id: randomUUID(),
    conversationId: randomUUID(),
    provider: 'native',
    workflowId: 'custom',
    workflowName: 'User workflow',
    prompt: 'A boat',
    parameters: { seed: 42 },
    createdAt: new Date().toISOString(),
    outputs: [{ source: { filename: 'original.png', subfolder: '', type: 'output' }, analysisDataUrl: png }],
    ...overrides,
  };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'atelier-output-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, gallery: new Gallery({ historyDir: join(root, 'history') }) };
}

test('output inspection validates IDs and indexes and reads only the requested compressed copy', async t => {
  const { root, gallery } = await fixture(t),
    record = run({
      outputs: [
        { source: { filename: 'first.jpg', subfolder: '', type: 'output' }, analysisDataUrl: jpeg },
        { source: { filename: 'second.png', subfolder: '', type: 'output' }, analysisDataUrl: png },
      ],
    });
  await gallery.put(record, { persist: true });
  const folder = join(root, 'history', record.conversationId, 'generated', record.id),
    other = (await readdir(folder)).find(name => name.endsWith('.jpg'));
  await writeFile(join(folder, other), 'corrupted unrelated image');
  const result = await readOutput(gallery, record.conversationId, { run_id: record.id, output_index: 1 });
  assert.deepEqual(result.images, [png]);
  assert.equal(result.metadata.output_index, 1);
  assert.equal(result.metadata.workflow, record.workflowName);
  assert.equal(result.metadata.status, 'loaded');
  const metadata = await readOutput(gallery, record.conversationId, { run_id: record.id }, { includeImages: false });
  assert.deepEqual(metadata.images, []);
  assert.doesNotMatch(JSON.stringify(metadata), /base64|original\.png/);
  await assert.rejects(readOutput(gallery, record.conversationId, { run_id: record.id }), /endommag/);
  for (const args of [
    null,
    [],
    { run_id: '../bad' },
    { run_id: record.id, output_index: null },
    { run_id: record.id, output_index: -1 },
    { run_id: record.id, output_index: 1.5 },
    { run_id: record.id, output_index: 64 },
    { run_id: record.id, path: 'secret' },
  ])
    await assert.rejects(readOutput(gallery, record.conversationId, args), { status: 400 });
  await assert.rejects(readOutput(gallery, record.conversationId, { run_id: record.id, output_index: 2 }), {
    status: 404,
  });
  await assert.rejects(readOutput(gallery, randomUUID(), { run_id: record.id }), { status: 404 });
});

test('in-memory inspection isolates one output and missing copies never cause an original read', async t => {
  const { gallery } = await fixture(t),
    record = run({
      outputs: [
        { source: { filename: 'a.png', subfolder: '', type: 'output' }, analysisDataUrl: png },
        { source: { filename: 'b.jpg', subfolder: '', type: 'output' }, analysisDataUrl: jpeg },
      ],
    });
  await gallery.put(record);
  const loaded = await gallery.get(record.conversationId, record.id, { outputIndex: 1 });
  assert.equal(loaded.outputs[0].analysisDataUrl, undefined);
  assert.equal(loaded.outputs[1].analysisDataUrl, jpeg);
  loaded.outputs[1].analysisDataUrl = 'mutated';
  assert.deepEqual((await readOutput(gallery, record.conversationId, { run_id: record.id })).images, [png]);
  const empty = run();
  delete empty.outputs[0].analysisDataUrl;
  await gallery.put(empty);
  const result = await readOutput(gallery, empty.conversationId, { run_id: empty.id });
  assert.equal(result.metadata.status, 'unavailable');
  assert.deepEqual(result.images, []);
  const video = run({ mediaType: 'video' });
  video.outputs[0].analysisFrames = [
    { time: 0, url: png },
    { time: 1, url: jpeg },
  ];
  await gallery.put(video);
  const frames = await readOutput(gallery, video.conversationId, { run_id: video.id });
  assert.deepEqual(frames.images, [png, jpeg]);
  assert.deepEqual(frames.metadata.frame_times, [0, 1]);
  assert.match(frames.metadata.note, /without audio/);
});

test('HTTP output tool remains available after generation is disabled, enforces conversation scope and shares the read budget', async t => {
  const { root, gallery } = await fixture(t),
    record = run();
  await gallery.put(record, { persist: true });
  const modelPath = join(root, 'model.gguf'),
    projectorPath = join(root, 'mmproj.gguf');
  await writeFile(modelPath, 'GGUF\x03\0\0\0');
  await writeFile(projectorPath, 'GGUF\x03\0\0\0');
  const app = await createApplication({
    port: 0,
    dataDir: join(root, 'data'),
    historyDir: join(root, 'history'),
    spawnProcess: (_command, args, options) =>
      spawn(
        process.execPath,
        [fileURLToPath(new URL('./fixtures/fake-resource-engine.mjs', import.meta.url)), ...args],
        options,
      ),
  });
  t.after(() => app.close());
  const bootstrap = await (await fetch(app.url + '/api/bootstrap')).json(),
    request = (route, body) =>
      fetch(app.url + '/api/' + route, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + bootstrap.token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
  assert.equal(
    (
      await request('config', {
        ...bootstrap.config,
        enginePath: process.execPath,
        modelPath,
        projectorPath,
        gpuLayers: 0,
      })
    ).status,
    200,
  );
  assert.equal((await request('start', {})).status, 202);
  const deadline = Date.now() + 10000;
  while (
    (await (await fetch(app.url + '/api/status', { headers: { Authorization: 'Bearer ' + bootstrap.token } })).json())
      .state !== 'ready'
  ) {
    if (Date.now() > deadline) assert.fail('Engine not ready');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const turnId = randomUUID(),
    chat = async (text, extras = {}) => {
      const events = [];
      await readSSE(
        (
          await request('chat', {
            messages: [{ role: 'user', content: text }],
            conversationId: record.conversationId,
            turnId,
            tools: false,
            ...extras,
          })
        ).body,
        event => events.push(event),
      );
      return events;
    };
  const initial = (await chat('inspect resources')).find(event => event.local_test_payload).local_test_payload;
  assert.deepEqual(
    initial.tools.map(tool => tool.function.name),
    ['local_read_output'],
  );
  assert.doesNotMatch(JSON.stringify(initial), /base64/);
  assert.deepEqual(initial.tools[0].function.parameters.properties.run_id.enum, [record.id]);
  // A wrong run_id is answered to the model as a refused call instead of ending the turn.
  const refused = (await chat('inspect output ' + JSON.stringify({ run_id: 'run_id' }))).find(
    event => event.local_tool_request,
  ).local_tool_request;
  assert.equal(refused.kind, 'invalid');
  assert.equal(refused.message, 'Identifiant de sortie invalide.');
  assert.equal(refused.call.function.name, 'local_read_output');
  for (let i = 0; i < 8; i++) {
    const events = await chat('inspect output ' + JSON.stringify({ run_id: record.id })),
      tool = events.find(event => event.local_tool_request).local_tool_request;
    assert.equal(tool.kind, 'output');
    assert.equal(tool.outputIndex, 0);
    assert.doesNotMatch(JSON.stringify(tool), /base64/);
  }
  const exhausted = (await chat('inspect resources')).find(event => event.local_test_payload).local_test_payload;
  assert.equal(exhausted.tools, undefined);
  const read = await request('gallery/read', {
    conversationId: record.conversationId,
    runId: record.id,
    outputIndex: 0,
  });
  assert.equal(read.status, 200);
  assert.deepEqual((await read.json()).images, [png]);
  const messages = [
    { role: 'user', content: 'Check the image' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'read_saved',
          type: 'function',
          function: { name: 'local_read_output', arguments: JSON.stringify({ run_id: record.id }) },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'read_saved', content: JSON.stringify({ status: 'loaded', run_id: record.id }) },
    { role: 'assistant', content: 'Checked.' },
  ];
  assert.equal((await request('history/save', { id: record.conversationId, messages })).status, 200);
  const saved = await (
    await fetch(app.url + '/api/history/' + record.conversationId, {
      headers: { Authorization: 'Bearer ' + bootstrap.token },
    })
  ).json();
  assert.deepEqual(saved.messages, messages);
  assert.doesNotMatch(JSON.stringify(saved), /base64/);
  assert.deepEqual(
    updateSession({
      messages,
      conversationId: record.conversationId,
      prompt: '',
      images: [],
      title: 'Checked image',
      thinking: false,
    }).messages,
    messages,
  );
  assert.equal((await request('gallery/read', { conversationId: randomUUID(), runId: record.id })).status, 404);
  assert.equal(
    (await request('gallery/read', { conversationId: record.conversationId, runId: record.id, outputIndex: -1 }))
      .status,
    400,
  );
  // A conversation without results is never offered the inspection tool, so another
  // conversation's run_id cannot be requested through it.
  const empty = (await chat('inspect resources', { turnId: randomUUID(), conversationId: randomUUID() })).find(
    event => event.local_test_payload,
  ).local_test_payload;
  assert.equal(empty.tools, undefined);
  await assert.rejects(
    chat('inspect output ' + JSON.stringify({ run_id: record.id }), {
      turnId: randomUUID(),
      conversationId: randomUUID(),
    }),
    /indisponible/,
  );
  const disabled = (await chat('inspect resources', { resources: false, turnId: randomUUID() })).find(
    event => event.local_test_payload,
  ).local_test_payload;
  assert.equal(disabled.tools, undefined);
  const status = await (
    await fetch(app.url + '/api/status', { headers: { Authorization: 'Bearer ' + bootstrap.token } })
  ).json();
  assert.equal(status.state, 'ready');
  assert.equal(status.toolJob, null);
});
