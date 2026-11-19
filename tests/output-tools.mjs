import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Gallery } from '../lib/gallery.mjs';
import { TAKES_AT_ONCE, capableOutputTool, outputTool, outputToolFor, readOutput, takesToRead } from '../lib/output-tools.mjs';
import { SHEET_TAKES, sheetLayout, contactSheet } from '../public/contact-sheet.mjs';
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

test('output inspection validates IDs and indexes and reads only the requested session copy', async t => {
  const { root, gallery } = await fixture(t),
    record = run({
      outputs: [
        { source: { filename: 'first.jpg', subfolder: '', type: 'output' }, analysisDataUrl: jpeg },
        { source: { filename: 'second.png', subfolder: '', type: 'output' }, analysisDataUrl: png },
      ],
    });
  await gallery.put(record, { persist: true });
  const folder = join(root, 'history', record.conversationId, 'generated', record.id);
  assert.deepEqual(await readdir(folder), ['manifest.json'], 'the copies stay in this session’s memory');
  const result = await readOutput(gallery, record.conversationId, { run_id: record.id, output_index: 1 });
  assert.deepEqual(result.images, [png]);
  assert.equal(result.metadata.output_index, 1);
  assert.equal(result.metadata.workflow, record.workflowName);
  assert.equal(result.metadata.status, 'loaded');
  const metadata = await readOutput(gallery, record.conversationId, { run_id: record.id }, { includeImages: false });
  assert.deepEqual(metadata.images, []);
  assert.doesNotMatch(JSON.stringify(metadata), /base64|original\.png/);
  const restarted = new Gallery({ historyDir: join(root, 'history') });
  const later = await readOutput(restarted, record.conversationId, { run_id: record.id });
  assert.equal(later.metadata.status, 'unavailable', 'a later session makes its own copy from the original');
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
    record = run(),
    // (0.6.112) Another creation of the same conversation, two outputs.
    other = run({
      conversationId: record.conversationId,
      createdAt: new Date(Date.now() + 1000).toISOString(),
      outputs: [{ source: { filename: 'a.png', subfolder: '', type: 'output' } }, { source: { filename: 'b.png', subfolder: '', type: 'output' } }],
    });
  await gallery.put(record, { persist: true });
  await gallery.put(other, { persist: true });
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
  // (0.6.112) Its takes by their numbers, given as the application started: no run_id to copy.
  assert.deepEqual(Object.keys(initial.tools[0].function.parameters.properties), ['takes']);
  assert.deepEqual(initial.tools[0].function.parameters.properties.takes.items.enum, [1, 2, 3]);
  // One take: read as a result always was. Several: handed to the page together. One read of the
  // turn either way; a number that is none of its takes is said to the model.
  const asked = async takes =>
    (await chat('inspect output ' + JSON.stringify({ takes }), { turnId: randomUUID() })).find(event => event.local_tool_request)
      .local_tool_request;
  const one = await asked([1]);
  assert.deepEqual([one.kind, one.runId, one.outputIndex], ['output', record.id, 0]);
  const three = await asked([3, 1, 2, 3]);
  assert.equal(three.kind, 'outputs');
  assert.deepEqual(three.takes, [
    { take: 3, runId: other.id, outputIndex: 1 },
    { take: 1, runId: record.id, outputIndex: 0 },
    { take: 2, runId: other.id, outputIndex: 0 },
  ]);
  assert.equal(three.workflowName, 'PRISE 3, PRISE 1, PRISE 2');
  assert.doesNotMatch(JSON.stringify(three), /base64/);
  const none = await asked([1, 9]);
  assert.equal(none.kind, 'invalid');
  assert.equal(none.message, 'La prise 9 n’est pas une prise de cette conversation.');
  // A wrong run_id is answered to the model as a refused call instead of ending the turn.
  const refused = (await chat('inspect output ' + JSON.stringify({ run_id: 'run_id' }))).find(
    event => event.local_tool_request,
  ).local_tool_request;
  assert.equal(refused.kind, 'invalid');
  assert.equal(refused.message, 'Identifiant de sortie invalide.');
  assert.equal(refused.call.function.name, 'local_read_output');
  // (0.6.111) Several tools asked in one message, which may hold one. llama.cpp read the first,
  // then refused the whole answer: « Failed to parse input at pos 693 » was shown as it was and
  // the turn lost. The first call is made; the same when a service answers several calls.
  for (const script of ['inspect unread ', 'inspect twice ']) {
    const events = await chat(script + JSON.stringify({ run_id: record.id }), { turnId: randomUUID() }),
      tool = events.find(event => event.local_tool_request)?.local_tool_request;
    assert.equal(tool?.kind, 'output', script);
    assert.equal(tool.call.id, 'first_call', script);
    assert.equal(tool.runId, record.id, script);
  }
  // Nothing it could read of the answer: said in the user's words, not in the engine's.
  await assert.rejects(chat('inspect unread nothing', { turnId: randomUUID() }), error => {
    assert.match(error.message, /n’a pas su lire la réponse du modèle/);
    assert.doesNotMatch(error.message, /Failed to parse/);
    return true;
  });
  for (let i = 0; i < 8; i++) {
    const events = await chat('inspect output ' + JSON.stringify({ run_id: record.id })),
      tool = events.find(event => event.local_tool_request).local_tool_request;
    assert.equal(tool.kind, 'output');
    assert.equal(tool.outputIndex, 0);
    assert.doesNotMatch(JSON.stringify(tool), /base64/);
  }
  const exhausted = (await chat('inspect resources')).find(event => event.local_test_payload).local_test_payload;
  assert.equal(exhausted.tools, undefined);
  const read = () =>
    request('gallery/read', {
      conversationId: record.conversationId,
      runId: record.id,
      outputIndex: 0,
    });
  // This application session has no copy yet: the page makes one from the original and hands it over.
  assert.deepEqual((await (await read()).json()).images, []);
  assert.equal(
    (await request('gallery/analysis', { conversationId: record.conversationId, id: record.id, images: [png] })).status,
    200,
  );
  const loaded = await read();
  assert.equal(loaded.status, 200);
  assert.deepEqual((await loaded.json()).images, [png]);
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

test('the takes of a conversation are looked at by their numbers, several in one call (0.6.112)', () => {
  // Asked to plan a video from three takes, the local model wrote three calls in one message, then
  // read them one request after the other, a run_id of thirty-six characters copied for each.
  const A = randomUUID(),
    B = randomUUID(),
    C = randomUUID(),
    runs = [
      { id: A, mediaType: 'video', workflowName: 'LTX 2.5', outputs: [{ take: 7 }] },
      { id: B, workflowName: 'Krea 2', outputs: [{ take: 5 }, { take: 6 }] },
    ];
  const tool = outputToolFor(runs),
    parameters = tool.function.parameters;
  assert.deepEqual(Object.keys(parameters.properties), ['takes']);
  assert.deepEqual(parameters.properties.takes.items, { type: 'integer', enum: [5, 6, 7] });
  assert.equal(parameters.properties.takes.maxItems, 3);
  assert.deepEqual(parameters.required, ['takes']);
  assert.match(tool.function.description, /in one call/);
  assert.doesNotMatch(JSON.stringify(tool), /run_id/);
  // As many as one sheet holds, never more.
  const many = outputToolFor([{ id: A, outputs: Array.from({ length: 30 }, (_, at) => ({ take: at + 1 })) }]);
  assert.equal(many.function.parameters.properties.takes.maxItems, TAKES_AT_ONCE);
  assert.equal(TAKES_AT_ONCE, SHEET_TAKES);
  // Found among the creations of the conversation, in the order asked, each once.
  assert.deepEqual(takesToRead({ takes: [7, 5, 7] }, runs), [
    { take: 7, runId: A, outputIndex: 0, mediaType: 'video', workflowName: 'LTX 2.5' },
    { take: 5, runId: B, outputIndex: 0, mediaType: 'image', workflowName: 'Krea 2' },
  ]);
  assert.deepEqual(takesToRead({ takes: [6] }, runs)[0], { take: 6, runId: B, outputIndex: 1, mediaType: 'image', workflowName: 'Krea 2' });
  assert.throws(() => takesToRead({ takes: [5, 9] }, runs), /La prise 9 n’est pas une prise de cette conversation/);
  for (const refused of [{}, { takes: [] }, { takes: [0] }, { takes: ['5'] }, { takes: 5 }, { takes: [5], run_id: A }, { takes: Array.from({ length: 13 }, (_, at) => at + 1) }])
    assert.throws(() => takesToRead(refused, runs), /Numéros de prise invalides/, JSON.stringify(refused));
  // A result without a number is still read by its run_id, with the words the tool always had.
  const earlier = outputToolFor([{ id: C, outputs: [{}, {}] }]);
  assert.deepEqual(Object.keys(earlier.function.parameters.properties), ['run_id', 'output_index']);
  assert.deepEqual(earlier.function.parameters.properties.run_id.enum, [C]);
  assert.equal(earlier.function.parameters.properties.output_index.maximum, 1);
  assert.deepEqual(earlier.function.parameters.required, ['run_id']);
  assert.equal(earlier.function.description, outputTool.function.description);
  const both = outputToolFor([...runs, { id: C, outputs: [{}] }]);
  assert.deepEqual(Object.keys(both.function.parameters.properties), ['takes', 'run_id', 'output_index']);
  assert.deepEqual(both.function.parameters.properties.run_id.enum, [C]);
  assert.deepEqual(both.function.parameters.required, []);
  // A large model: the same definition at every request, no list.
  assert.deepEqual(Object.keys(capableOutputTool.function.parameters.properties), ['takes', 'run_id', 'output_index']);
  assert.equal(capableOutputTool.function.parameters.properties.takes.items.enum, undefined);
});

test('several takes are drawn on one picture, each under its number (0.6.112)', async () => {
  // One, two and three in a row; four as a square; then rows of three, then of four.
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 12, 40].map(count => [sheetLayout(count).columns, sheetLayout(count).rows]),
    [[1, 1], [2, 1], [3, 1], [2, 2], [3, 2], [3, 2], [4, 2], [4, 2], [4, 3], [4, 3]],
  );
  const three = sheetLayout(3);
  assert.deepEqual([three.width, three.height], [3 * 320 + 4 * 8, 320 + 34 + 2 * 8]);
  assert.deepEqual(three.cells, [{ x: 8, y: 8 }, { x: 336, y: 8 }, { x: 664, y: 8 }]);
  const drawn = [],
    canvas = {
      getContext: () => ({
        fillRect: (...box) => drawn.push(['box', ...box]),
        fillText: (text, x, y) => drawn.push(['text', text, x, y]),
        drawImage: (picture, x, y, width, height) => drawn.push(['picture', picture.name, x, y, width, height]),
      }),
      toDataURL: (type, quality) => `data:${type};sheet,${quality}`,
    };
  const sheet = await contactSheet(
    [
      { label: 'PRISE 47', url: 'wide' },
      { label: 'PRISE 49', url: 'gone' },
      { label: 'PRISE 50', url: 'tall' },
    ],
    {
      document: { createElement: () => canvas },
      load: async url => {
        if (url === 'gone') throw new Error('unreadable');
        return url === 'wide' ? { name: url, width: 1280, height: 640 } : { name: url, width: 500, height: 1000 };
      },
    },
  );
  assert.equal(sheet, 'data:image/jpeg;sheet,0.86');
  assert.deepEqual([canvas.width, canvas.height], [three.width, three.height]);
  assert.deepEqual(drawn.filter(([kind]) => kind === 'text').map(([, text, x]) => [text, x]), [['PRISE 47', 12], ['PRISE 49', 340], ['PRISE 50', 668]]);
  // Each picture whole in its square, centred; the one that cannot be read leaves its square empty.
  assert.deepEqual(drawn.filter(([kind]) => kind === 'picture'), [
    ['picture', 'wide', 8, 42 + 80, 320, 160],
    ['picture', 'tall', 664 + 80, 42, 160, 320],
  ]);
});
