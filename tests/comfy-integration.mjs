import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server.mjs';
import { readSSE } from '../public/stream.mjs';
import { ComfyGallery } from '../lib/comfy-gallery.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-tool-engine.mjs', import.meta.url));
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rLkAAAAASUVORK5CYII=';
const original = Buffer.from(png.split(',')[1], 'base64');
const descriptor = { filename: 'original.png', subfolder: 'integration', type: 'output' };
const workflow = {
  id: 'integration-boat', name: 'Integration boat', description: 'A deterministic test workflow.',
  graph: { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'Original prompt' } }, '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'integration' } } },
  bindings: { prompt: { node: '1', input: 'text' } }, outputNodes: ['2'], requiresImage: false,
};

async function until(check, message = 'The expected state was not reached.') {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 30));
  }
  assert.fail(message);
}

async function fakeComfy(events) {
  let submitted = false, complete = false, graph;
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    const json = (value) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (path.pathname === '/system_stats') return json({ devices: [{ name: 'Test GPU', type: 'cuda', torch_vram_total: 0, torch_vram_free: 0 }] });
    if (path.pathname === '/queue') return json({ queue_running: submitted && !complete ? [[0, 'integration-prompt']] : [], queue_pending: [] });
    if (path.pathname === '/prompt' && req.method === 'POST') {
      events.push('comfy:prompt'); submitted = true; graph = body.prompt;
      return json({ prompt_id: 'integration-prompt' });
    }
    if (path.pathname === '/history/integration-prompt') return json(complete ? { 'integration-prompt': { status: { completed: true, status_str: 'success' }, outputs: { '2': { images: [descriptor] } } } } : {});
    if (path.pathname === '/free' && req.method === 'POST') {
      events.push('comfy:free');
      assert.deepEqual(body, { unload_models: true, free_memory: true });
      return json({});
    }
    if (path.pathname === '/view') {
      if (path.searchParams.get('filename') !== descriptor.filename || path.searchParams.get('subfolder') !== descriptor.subfolder || path.searchParams.get('type') !== 'output') { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(original);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${server.address().port}`, complete: () => { complete = true; }, graph: () => graph,
    async close() { complete = true; server.closeAllConnections(); await new Promise((done) => server.close(done)); },
  };
}

test('HTTP native approval alternates engines, restores native history and clears only app copies', { timeout: 40000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-comfy-integration-'));
  const events = [];
  const children = new Set();
  let app, comfy;
  try {
    comfy = await fakeComfy(events);
    const modelPath = join(directory, 'fake-model.gguf');
    const projectorPath = join(directory, 'fake-projector.gguf');
    await writeFile(modelPath, Buffer.from('GGUF\x03\0\0\0'));
    await writeFile(projectorPath, Buffer.from('GGUF\x03\0\0\0'));
    const options = { port: 0, dataDir: directory, spawnProcess: (_command, args, processOptions) => {
      events.push('engine:start');
      const child = spawn(process.execPath, [fixture, ...args], processOptions);
      children.add(child);
      child.once('exit', () => { events.push('engine:exit'); children.delete(child); });
      return child;
    } };
    app = await createApplication(options);
    let token = (await (await fetch(`${app.url}/api/bootstrap`)).json()).token;
    const call = (path, body) => fetch(`${app.url}/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = async (path, body, expected = 200) => {
      const response = await call(path, body);
      const result = await response.json();
      assert.equal(response.status, expected, `${path}: ${JSON.stringify(result)}`);
      return result;
    };
    const status = () => json('status');
    const chat = async (messages, ids = {}) => {
      const response = await call('chat', { messages, conversationId, turnId, ...ids });
      assert.equal(response.status, 200);
      const stream = await response.text();
      return stream.split(/\r?\n\r?\n/).filter((frame) => frame.startsWith('data: ') && frame !== 'data: [DONE]').map((frame) => JSON.parse(frame.slice(6)));
    };
    const conversationId = randomUUID(), turnId = randomUUID();
    const messages = [{ role: 'user', content: 'generate a red boat' }];
    await json('config', { enginePath: process.execPath, modelPath, projectorPath, contextSize: 8192, maxOutputTokens: 4096, gpuLayers: 0 });
    await json('preferences', { saveHistory: false });
    await json('comfy/import', workflow);
    await json('comfy/config', { enabled: true, baseUrl: comfy.url, autoAllow: false, maxIterations: 3 });
    await json('start', {}, 202);
    await until(async () => (await status()).state === 'ready');

    await t.test('ordinary chat and malformed or truncated native calls cannot generate', async () => {
      const inspected = await chat([{ role: 'system', content: 'Original assistant instructions' }, { role: 'user', content: 'inspect tool context' }]);
      const forwarded = inspected.find(event => event.local_test_payload)?.local_test_payload;
      assert.ok(forwarded);
      assert.deepEqual(forwarded.messages, [{ role: 'system', content: 'Original assistant instructions' }, { role: 'user', content: 'inspect tool context' }]);
      assert.equal(forwarded.tool_choice, 'auto');
      assert.equal(forwarded.parallel_tool_calls, false);
      assert.equal(forwarded.tools[0].function.name, 'comfy_generate_image');
      assert.ok(forwarded.tools[0].function.description.includes(workflow.description));
      const ordinary = await chat([{ role: 'user', content: 'Hello' }]);
      assert.ok(ordinary.some((event) => event.choices?.[0]?.delta?.content === 'Ordinary chat, no generation.'));
      for (const content of ['generate malformed', 'generate length', 'generate truncated']) {
        const received = await chat([{ role: 'user', content }], { turnId: randomUUID() });
        assert.equal(received.some((event) => event.local_tool_request), false, content);
        assert.ok(received.some((event) => event.error), `${content} must produce an explicit stream error.`);
      }
      assert.equal(events.includes('comfy:prompt'), false);
    });

    let request, record;
    await t.test('native call waits for approval and running jobs reserve all GPU mutations', async () => {
      const received = await chat(messages);
      request = received.find((event) => event.local_tool_request)?.local_tool_request;
      assert.ok(request?.requestId, JSON.stringify(received));
      assert.equal(request.autoAllow, false);
      assert.equal(request.call.function.name, 'comfy_generate_image');
      assert.deepEqual(JSON.parse(request.call.function.arguments), { workflow_id: workflow.id, prompt: 'A red boat' });
      assert.equal(events.includes('comfy:prompt'), false, 'Native emission alone must not execute an image workflow.');
      await json('tools/execute', { requestId: request.requestId }, 403);
      assert.equal(events.includes('comfy:prompt'), false);
      await json('tools/execute', { requestId: request.requestId, permission: 'once' }, 202);
      await until(() => events.includes('comfy:prompt'));
      for (const [path, body] of [
        ['start', {}], ['stop', {}], ['chat', { messages }], ['history/clear', { confirm: true }],
        ['history/save', { id: conversationId, messages }], ['history/delete', { id: conversationId, confirm: true }], ['preferences', { saveHistory: false }],
      ]) await json(path, body, 409);
      assert.equal((await status()).toolJob.state, 'generating');
      assert.equal(events.filter((event) => event === 'engine:start').length, 1);
      comfy.complete();
      const finished = await until(async () => {
        const job = await json('tools/job');
        if (job?.state === 'error') assert.fail(job.error);
        return job?.state === 'done' ? job : false;
      });
      record = finished.record;
      assert.equal(record.prompt, 'A red boat');
      assert.deepEqual(record.outputs, [{ source: descriptor }]);
      assert.equal((await status()).state, 'ready');
      assert.deepEqual(events, ['engine:start', 'engine:exit', 'comfy:prompt', 'comfy:free', 'engine:start']);
      assert.equal(comfy.graph()['1'].inputs.text, 'A red boat');
      assert.equal(comfy.graph()['2'].inputs.filename_prefix, 'integration');
      assert.equal((await json('comfy')).config.autoAllow, false);
    });

    let transcript;
    await t.test('original proxy is byte exact and native tool continuation accepts analysis images', async (t) => {
      const originalResponse = await call(`gallery/${conversationId}/${record.id}/0`);
      assert.equal(originalResponse.status, 200);
      assert.equal(originalResponse.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await originalResponse.arrayBuffer()), original);
      const withAnalysis = await json('gallery/analysis', { conversationId, id: record.id, images: [png] });
      assert.equal(withAnalysis.outputs[0].analysisDataUrl, png);
      transcript = [...messages,
        { role: 'assistant', content: '', reasoning_content: 'I will use the registered workflow.', tool_calls: [request.call] },
        { role: 'tool', tool_call_id: request.call.id, content: JSON.stringify({ id: record.id, status: 'done' }) },
        { role: 'user', internal: true, content: [{ type: 'text', text: 'Review the generated image.' }, { type: 'image_url', image_url: { url: png } }] },
      ];
      const response = await call('chat', { messages: transcript, conversationId, turnId });
      assert.equal(response.status, 200);
      let review = '';
      await readSSE(response.body, (event) => { review += event.choices?.[0]?.delta?.content || ''; });
      assert.equal(review, 'The red boat is visible in the generated image.');
      const reviewed=await json('gallery/review',{conversationId,id:record.id,text:review,status:'reviewed'});
      assert.equal(reviewed.analysis.text,review);
      assert.equal(reviewed.analysis.status,'reviewed');
      assert.equal((await call('gallery/review',{conversationId,id:record.id,text:review,status:'conforme'})).status,400);
      transcript.push({ role: 'assistant', content: review });
      await assert.rejects(readdir(join(directory,'history')), {code:'ENOENT'});
      assert.equal((await call('gallery/persist',{conversationId})).status,403);
      await json('preferences',{saveHistory:true});
      await json('history/save', { id: conversationId, messages: transcript });
      await t.test('gallery persistence blocks history clearing and disabling until the complete batch settles', async () => {
        const originalPut = ComfyGallery.prototype.put;
        let entered = false, release, pending;
        const gate = new Promise((resolve) => { release = resolve; });
        ComfyGallery.prototype.put = async function (input, options) {
          if (input.conversationId === conversationId && options?.persist === true) {
            entered = true;
            await gate;
          }
          return originalPut.call(this, input, options);
        };
        try {
          pending = call('gallery/persist', { conversationId });
          await until(() => entered, 'The gallery persistence batch never reached its first write.');
          const clear = await call('history/clear', { confirm: true });
          const disable = await call('preferences', { saveHistory: false });
          assert.equal(clear.status, 409, 'Clearing must be blocked even before the first put joins gallery.pending.');
          assert.equal(disable.status, 409, 'Disabling history must wait for the complete gallery persistence batch.');
          release();
          const saved = await pending;
          assert.equal(saved.status, 200);
          assert.equal((await saved.json()).saved, 1);
        } finally {
          release();
          try { await pending; }
          finally { ComfyGallery.prototype.put = originalPut; }
        }
      });
      const history = await json(`history/${conversationId}`);
      assert.deepEqual(history.messages, transcript);
      const manifest = await readFile(join(directory, 'history', conversationId, 'generated', record.id, 'manifest.json'), 'utf8');
      assert.ok(!manifest.includes('base64,'));
    });

    await t.test('restart restores gallery and native history without rerunning and clear preserves original Comfy bytes', async () => {
      await app.close();
      app = await createApplication(options);
      token = (await (await fetch(`${app.url}/api/bootstrap`)).json()).token;
      assert.equal((await status()).state, 'stopped');
      assert.deepEqual((await json(`history/${conversationId}`)).messages, transcript);
      const gallery = await json(`gallery/${conversationId}`);
      assert.equal(gallery.runs.length, 1);
      assert.equal(gallery.runs[0].outputs[0].analysisDataUrl, png);
      assert.equal(gallery.runs[0].analysis.status,'reviewed');
      assert.equal(events.filter((event) => event === 'comfy:prompt').length, 1);
      assert.equal(await json('tools/job'), null);
      const restoredOriginal = await call(`gallery/${conversationId}/${record.id}/0`);
      assert.deepEqual(Buffer.from(await restoredOriginal.arrayBuffer()), original);
      await json('history/clear', { confirm: true });
      assert.deepEqual(await json(`gallery/${conversationId}`), { runs: [], skipped: 0 });
      assert.deepEqual(await json('history'), { conversations: [], skipped: 0 });
      await assert.rejects(readdir(join(directory, 'history')), { code: 'ENOENT' });
      const comfyOriginal = await fetch(`${comfy.url}/view?${new URLSearchParams(descriptor)}`);
      assert.equal(comfyOriginal.status, 200);
      assert.deepEqual(Buffer.from(await comfyOriginal.arrayBuffer()), original);
    });
  } finally {
    comfy?.complete();
    try { await app?.close(); }
    finally {
      for (const child of children) child.kill();
      await comfy?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
