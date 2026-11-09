import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
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
    const outputDir = join(root, 'output');
    await mkdir(outputDir);
    const worker = {
      state: 'stopped',
      status() {
        return {
          state: this.state,
          error: '',
          capabilities: { krea2: { ready: this.state === 'ready' }, ltx25: { ready: false } },
        };
      },
      async start() {
        this.state = 'ready';
        return this.status();
      },
      async close() {
        this.state = 'stopped';
      },
      async release() {
        events.push('runner released');
        return { released: true, allocatedGiB: 0 };
      },
      async request(method, job) {
        if (method === 'preflight') {
          events.push('preflight');
          return { ready: true };
        }
        assert.equal(method, 'generate');
        events.push('generate');
        assert.equal(job.parameters.seed, 99);
        await writeFile(join(outputDir, 'original.png'), png);
        return { jobId: job.id, outputs: [{ type: 'output', subfolder: '', filename: 'original.png' }] };
      },
    };
    try {
      app = await createApplication({
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
      await api('generation/config', {
        enabled: true,
        autoAllow: false,
        maxIterations: 5,
        pythonPath: process.execPath,
        tokenizerPath: root,
      });
      const workflow = {
        schemaVersion: 1,
        id: 'integration-boat',
        name: 'Native image',
        description: 'Generate a red boat',
        enabled: true,
        pipeline: 'krea2',
        mediaType: 'image',
        components: Object.fromEntries(['model', 'textEncoder', 'vae'].map(k => [k, { policy: 'fixed', asset: k }])),
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
      assert.deepEqual(await readFile(join(outputDir, 'original.png')), png);
    } finally {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
