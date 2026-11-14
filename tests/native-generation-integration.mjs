import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server.mjs';
const fixture = fileURLToPath(new URL('./fixtures/fake-tool-engine.mjs', import.meta.url));
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rLkAAAAASUVORK5CYII=',
  'base64',
);
async function checkpoint(path, tensors) {
  let offset = 0;
  const header = {};
  for (const [key, shape] of Object.entries(tensors)) {
    const length = shape.reduce((a, b) => a * b, 1);
    header[key] = { dtype: 'I8', shape, data_offsets: [offset, offset + length] };
    offset += length;
  }
  const body = Buffer.from(JSON.stringify(header)),
    prefix = Buffer.alloc(8);
  prefix.writeBigUInt64LE(BigInt(body.length));
  const handle = await open(path, 'w');
  try {
    await handle.write(Buffer.concat([prefix, body]));
    await handle.truncate(8 + body.length + offset);
  } finally {
    await handle.close();
  }
}
/** A one-token tokenizer folder, matching the one-row embedding of the fixture text encoder. */
async function tokenizerFolder(root) {
  const folder = join(root, 'tokenizer');
  await mkdir(folder);
  await writeFile(join(folder, 'tokenizer_config.json'), '{}');
  await writeFile(join(folder, 'vocab.json'), '{"a":0}');
  await writeFile(join(folder, 'merges.txt'), '');
  return folder;
}
/**
 * Atelier's own engine as far as these tests go: it runs Krea 2, and answers each job with one
 * image saved in the output folder.
 */
function fakeEngine(outputDir, { onGenerate = () => {}, onRelease = () => {} } = {}) {
  return {
    state: 'stopped',
    status() {
      return {
        state: this.state,
        error: '',
        capabilities: { krea2: { ready: true, mediaType: 'image', reason: '' } },
      };
    },
    async unload() {},
    async start() {
      this.state = 'ready';
      return this.status();
    },
    async close() {
      this.state = 'stopped';
    },
    async release() {
      onRelease();
      return { released: true, allocatedGiB: 0 };
    },
    async request(method, job) {
      if (method !== 'generate') return {};
      onGenerate(job);
      const filename = randomUUID().replaceAll('-', '') + '.png';
      await writeFile(join(outputDir, filename), png);
      return {
        jobId: job.id,
        outputs: [{ filename, subfolder: '', type: 'output', width: 1, height: 1 }],
        metadata: {},
      };
    },
  };
}
/**
 * A ComfyUI as far as Atelier asks: it knows every node, lists the fixture files and answers
 * each graph with one saved image. Set and answering, it is still not the one that creates a
 * Krea 2 image.
 */
async function fakeComfy(onPrompt = () => {}) {
  const names = ['model.safetensors', 'textEncoder.safetensors', 'vae.safetensors'];
  const app = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, 'http://localhost');
    const json = value => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/queue') return json({ queue_running: [], queue_pending: [] });
    if (url.pathname === '/system_stats')
      return json({
        system: { ram_total: 32 * 1024 ** 3, ram_free: 16 * 1024 ** 3 },
        devices: [{ type: 'cuda', vram_total: 12, vram_free: 11, torch_vram_total: 2, torch_vram_free: 1 }],
      });
    if (url.pathname.startsWith('/object_info/')) {
      const node = decodeURIComponent(url.pathname.slice(13)),
        input = { UNETLoader: 'unet_name', CLIPLoader: 'clip_name', VAELoader: 'vae_name' }[node];
      return json({ [node]: { input: { required: input ? { [input]: [names, {}] } : {} } } });
    }
    if (url.pathname === '/upload/image') return json({ name: 'source.png', subfolder: 'atelier', type: 'input' });
    if (url.pathname === '/prompt') {
      onPrompt(JSON.parse(Buffer.concat(chunks)).prompt);
      return json({ prompt_id: 'prompt-1' });
    }
    if (url.pathname === '/history/prompt-1')
      return json({
        'prompt-1': {
          status: { status_str: 'success', completed: true, messages: [] },
          outputs: { save: { images: [{ filename: 'made.png', subfolder: 'atelier', type: 'output' }] } },
        },
      });
    if (url.pathname === '/view') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(png);
    }
    json({});
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${app.address().port}`,
    close() {
      app.closeAllConnections();
      return new Promise(resolve => app.close(resolve));
    },
  };
}
async function until(check) {
  for (let i = 0; i < 300; i++) {
    const v = await check();
    if (v) return v;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.fail('Timed out');
}
test(
  'native HTTP tool workflow resolves policy, swaps GPU owners, serves originals and preserves them after history deletion',
  { timeout: 20000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-http-'));
    let app;
    const events = [];
    // A ComfyUI is set and answers: Atelier's engine makes the image all the same.
    const comfy = await fakeComfy(() => assert.fail('a graph was sent to ComfyUI'));
    const outputDir = join(root, 'output');
    await mkdir(outputDir);
    const worker = fakeEngine(outputDir, {
      onGenerate(job) {
        events.push('generate');
        assert.equal(job.parameters.seed, 99);
      },
      onRelease: () => events.push('runner released'),
    });
    try {
      app = await createApplication({
        // The scripted model writes three-word prompts: the length of a prompt is tested apart.
        fullPrompts: false,
        port: 0,
        dataDir: root,
        outputDir,
        generationWorker: worker,
        spawnProcess: (_command, args, options) => {
          events.push('llm started');
          const child = spawn(process.execPath, [fixture, ...args], options);
          child.once('exit', () => events.push('llm stopped'));
          return child;
        },
      });
      const boot = await (await fetch(app.url + '/api/bootstrap')).json();
      const api = async (path, body, status = 200) => {
        const response = await fetch(app.url + '/api/' + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { Authorization: 'Bearer ' + boot.token, 'Content-Type': 'application/json' },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        assert.equal(response.status, status, await response.clone().text());
        return response;
      };
      const assets = {
        model: { 'first.weight': [6144, 64], 'blocks.0.attn.wq.weight': [6144, 6144] },
        textEncoder: { 'model.embed_tokens.weight': [1, 2560] },
        vae: { 'encoder.conv1.weight': [1, 3, 1, 1, 1], 'decoder.conv1.weight': [1, 16, 1, 1, 1] },
      };
      for (const [kind, tensors] of Object.entries(assets)) {
        const path = join(root, kind + '.safetensors');
        await checkpoint(path, tensors);
        await api('generation/assets', { id: kind, path, kind, family: 'krea2' });
      }
      await api('generation/assets', {
        id: 'tokenizer',
        path: await tokenizerFolder(root),
        kind: 'tokenizer',
        family: 'krea2',
      });
      await api('generation/config', {
        enabled: true,
        autoAllow: false,
        maxIterations: 5,
        pythonPath: process.execPath,
      });
      const settings = await (await api('generation/comfy', { enabled: true, baseUrl: comfy.baseUrl })).json();
      assert.equal(settings.comfy.reachable, true);
      const workflow = {
        schemaVersion: 1,
        id: 'integration-boat',
        name: 'Native image',
        description: 'Generate a red boat',
        enabled: true,
        pipeline: 'krea2',
        mediaType: 'image',
        components: Object.fromEntries(
          ['model', 'textEncoder', 'tokenizer', 'vae'].map(k => [k, { policy: 'fixed', asset: k }]),
        ),
        parameters: {
          prompt: { policy: 'model', type: 'string' },
          seed: { policy: 'fixed', value: 99 },
          width: { policy: 'fixed', value: 512 },
          height: { policy: 'fixed', value: 512 },
          steps: { policy: 'fixed', value: 8 },
          cfg: { policy: 'fixed', value: 1 },
          denoise: { policy: 'fixed', value: 1 },
        },
        loras: [],
        references: [],
      };
      await api('generation/workflows', workflow);
      const modelPath = join(root, 'llm.gguf');
      await writeFile(modelPath, 'GGUF\x03\0\0\0');
      await api('config', {
        enginePath: process.execPath,
        modelPath,
        projectorPath: '',
        contextSize: 8192,
        maxOutputTokens: 4096,
        gpuLayers: 0,
      });
      await api('start', {}, 202);
      await until(async () => (await (await api('status')).json()).state === 'ready');
      const conversationId = randomUUID(),
        turnId = randomUUID();
      const response = await api('chat', {
        messages: [{ role: 'user', content: 'generate a boat' }],
        conversationId,
        turnId,
      });
      const streamed = await response.text();
      const frame = streamed
        .split(/\r?\n\r?\n/)
        .filter(s => s.startsWith('data: ') && s !== 'data: [DONE]')
        .map(s => JSON.parse(s.slice(6)))
        .find(e => e.local_tool_request);
      assert.ok(frame, streamed);
      const approval = frame.local_tool_request;
      assert.equal(approval.call.function.name, 'create_image');
      await api('tools/execute', { requestId: approval.requestId, permission: 'once' }, 202);
      const job = await until(async () => {
        const j = await (await api('tools/job')).json();
        return j && ['done', 'error'].includes(j.state) && j;
      });
      assert.equal(job.state, 'done', job.error);
      assert.equal(job.record.provider, 'native');
      assert.equal(job.record.parameters.seed, 99);
      assert.ok(events.indexOf('llm stopped') < events.indexOf('generate'));
      assert.ok(events.indexOf('runner released') < events.lastIndexOf('llm started'));
      assert.deepEqual(
        Buffer.from(await (await api(`gallery/${conversationId}/${job.record.id}/0`)).arrayBuffer()),
        png,
      );
      await api('history/clear', { confirm: true });
      assert.deepEqual(await readFile(join(outputDir, job.record.outputs[0].source.filename)), png);
    } finally {
      await app?.close();
      await comfy.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'an optional source is only offered once something exists, and an invented one is answered to the model',
  { timeout: 20000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-sources-'));
    const outputDir = join(root, 'output');
    await mkdir(outputDir);
    let app;
    const worker = fakeEngine(outputDir);
    try {
      app = await createApplication({
        // The scripted model writes three-word prompts: the length of a prompt is tested apart.
        fullPrompts: false,
        port: 0,
        dataDir: root,
        outputDir,
        generationWorker: worker,
        spawnProcess: (_command, args, options) => spawn(process.execPath, [fixture, ...args], options),
      });
      const boot = await (await fetch(app.url + '/api/bootstrap')).json();
      const api = async (path, body, status = 200) => {
        const response = await fetch(app.url + '/api/' + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { Authorization: 'Bearer ' + boot.token, 'Content-Type': 'application/json' },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        assert.equal(response.status, status, await response.clone().text());
        return response;
      };
      const assets = {
        model: { 'first.weight': [6144, 64], 'blocks.0.attn.wq.weight': [6144, 6144] },
        textEncoder: { 'model.embed_tokens.weight': [1, 2560] },
        vae: { 'encoder.conv1.weight': [1, 3, 1, 1, 1], 'decoder.conv1.weight': [1, 16, 1, 1, 1] },
      };
      for (const [kind, tensors] of Object.entries(assets)) {
        const path = join(root, kind + '.safetensors');
        await checkpoint(path, tensors);
        await api('generation/assets', { id: kind, path, kind, family: 'krea2' });
      }
      await api('generation/assets', {
        id: 'tokenizer',
        path: await tokenizerFolder(root),
        kind: 'tokenizer',
        family: 'krea2',
      });
      await api('generation/config', {
        enabled: true,
        autoAllow: false,
        maxIterations: 5,
        pythonPath: process.execPath,
      });
      // Same shape as a Krea 2 workflow imported with its optional image-to-image slot.
      await api('generation/workflows', {
        schemaVersion: 1,
        id: 'krea-with-source',
        name: 'Krea 2',
        description: 'Creer une image',
        enabled: true,
        pipeline: 'krea2',
        mediaType: 'image',
        components: Object.fromEntries(
          ['model', 'textEncoder', 'tokenizer', 'vae'].map(k => [k, { policy: 'fixed', asset: k }]),
        ),
        parameters: {
          prompt: { policy: 'model', type: 'string' },
          seed: { policy: 'fixed', value: 7 },
          width: { policy: 'fixed', value: 512 },
          height: { policy: 'fixed', value: 512 },
          steps: { policy: 'fixed', value: 8 },
          cfg: { policy: 'fixed', value: 1 },
          denoise: { policy: 'fixed', value: 1 },
        },
        loras: [],
        references: [{ id: 'source', role: 'img2img', name: 'Source image', required: false }],
      });
      const modelPath = join(root, 'llm.gguf');
      await writeFile(modelPath, 'GGUF\x03\0\0\0');
      await api('config', {
        enginePath: process.execPath,
        modelPath,
        projectorPath: '',
        contextSize: 8192,
        maxOutputTokens: 4096,
        gpuLayers: 0,
      });
      await api('start', {}, 202);
      await until(async () => (await (await api('status')).json()).state === 'ready');
      const conversationId = randomUUID();
      const chat = async text => {
        const streamed = await (
          await api('chat', { messages: [{ role: 'user', content: text }], conversationId, turnId: randomUUID() })
        ).text();
        return streamed
          .split(/\r?\n\r?\n/)
          .filter(s => s.startsWith('data: ') && s !== 'data: [DONE]')
          .map(s => JSON.parse(s.slice(6)));
      };
      const createImage = async () =>
        (await chat('inspect tool context'))
          .find(e => e.local_test_payload)
          .local_test_payload.tools.find(tool => tool.function.name === 'create_image').function;

      // A fresh conversation has nothing to edit: no source role, no source placeholder to copy.
      const fresh = await createImage();
      assert.equal(fresh.parameters.properties.source, undefined);
      assert.doesNotMatch(fresh.description, /run_id/);

      // A model that still invents one gets a tool error it can act on; the turn is not cut.
      const events = await chat('generate a boat with an invented source');
      assert.equal(
        events.find(e => e.error),
        undefined,
        JSON.stringify(events.find(e => e.error)),
      );
      const refused = events.find(e => e.local_tool_request).local_tool_request;
      assert.equal(refused.kind, 'invalid');
      assert.equal(refused.message, 'Identifiant de sortie invalide.');
      assert.equal(refused.call.id, 'call_red_boat');
      assert.equal(refused.requestId, undefined, 'nothing awaits approval');

      // Plain creation still works, and its result becomes the only output the model may name.
      const approval = (await chat('generate a boat')).find(e => e.local_tool_request).local_tool_request;
      await api('tools/execute', { requestId: approval.requestId, permission: 'once' }, 202);
      const job = await until(async () => {
        const j = await (await api('tools/job')).json();
        return j && ['done', 'error'].includes(j.state) && j;
      });
      assert.equal(job.state, 'done', job.error);
      await until(async () => (await (await api('status')).json()).state === 'ready');
      const edited = await createImage();
      assert.deepEqual(edited.parameters.properties.source.properties.output.enum, [job.record.id]);
      assert.deepEqual(edited.parameters.properties.source.required, ['output']);
      const edit = (await chat('generate from ' + job.record.id)).find(e => e.local_tool_request).local_tool_request;
      assert.equal(edit.call.function.name, 'create_image');
      assert.equal(edit.referenceCount, 1);
    } finally {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
