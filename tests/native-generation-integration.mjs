import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server.mjs';
import { bytesInfo, layout } from '../public/media-info.mjs';
import { THIN_NOTE } from '../lib/thin-prompt.mjs';
const fixture = fileURLToPath(new URL('./fixtures/fake-tool-engine.mjs', import.meta.url));
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rLkAAAAASUVORK5CYII=',
  'base64',
);
/** A PNG without the sheet Moodix writes in it (public/media-info.mjs): the image as the engine made it. */
async function withoutSheet(bytes) {
  const found = await layout({ size: bytes.length, read: async (at, length) => bytes.subarray(at, at + length) });
  return Buffer.concat([bytes.subarray(0, 8), ...found.parts.filter(part => !part.mine).map(part => bytes.subarray(part.at, part.at + part.size))]);
}
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
 * image saved in the output folder: as the engine does (runner/media.py), under the name the
 * application asks for, in the folder of the images. `flat`: as every creation was written before
 * the three folders, under a random name in the folder of the outputs itself.
 */
function fakeEngine(outputDir, { onGenerate = () => {}, onRelease = () => {}, flat = false } = {}) {
  return {
    flat,
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
      // (Waited for: a test may keep a generation running.)
      await onGenerate(job);
      const subfolder = this.flat ? '' : 'image',
        filename = (this.flat ? randomUUID().replaceAll('-', '') : job.outputName) + '.png';
      await mkdir(join(outputDir, subfolder), { recursive: true });
      await writeFile(join(outputDir, subfolder, filename), png);
      return {
        jobId: job.id,
        outputs: [{ filename, subfolder, type: 'output', width: 1, height: 1 }],
        metadata: {},
      };
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
    let app, named;
    const events = [];
    const outputDir = join(root, 'output');
    await mkdir(outputDir);
    const worker = fakeEngine(outputDir, {
      onGenerate(job) {
        events.push('generate');
        assert.equal(job.parameters.seed, 99);
        // The name of its file: the local time it starts, its model (« Native image »), a short suffix.
        assert.match(job.outputName, /^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d_native-image_[0-9a-f]{4}$/);
        const [day, time] = job.outputName.split('_'),
          at = new Date(`${day}T${time.replaceAll('-', ':')}`);
        assert.ok(Math.abs(Date.now() - at) < 60000, 'the time it is now, here');
        named = job.outputName;
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
      // No other program is asked anything: the settings say nothing of one (0.6.127).
      assert.equal(Object.hasOwn(await (await api('generation')).json(), 'comfy'), false);
      await api('generation/comfy', { enabled: true, baseUrl: 'http://127.0.0.1:8188' }, 404);
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
      // Its record says where the engine wrote it: the folder of the images, under the name asked.
      assert.deepEqual(job.record.outputs[0].source, { filename: named + '.png', subfolder: 'image', type: 'output' });
      assert.ok(events.indexOf('llm stopped') < events.indexOf('generate'));
      assert.ok(events.indexOf('runner released') < events.lastIndexOf('llm started'));
      // The original served is the image the engine made, with its sheet written in it (16/11): what
      // made it travels with the file, whatever its name becomes.
      const served = Buffer.from(await (await api(`gallery/${conversationId}/${job.record.id}/0`)).arrayBuffer());
      assert.deepEqual(await withoutSheet(served), png);
      const sheet = await bytesInfo(served);
      assert.deepEqual(
        [sheet.moodix, sheet.id, sheet.conversationId, sheet.mediaType, sheet.parameters.seed, sheet.take],
        [1, job.record.id, conversationId, 'image', 99, job.record.outputs[0].take],
      );
      assert.equal(sheet.workflowId, job.record.workflowId);
      assert.equal(typeof sheet.prompt, 'string');
      // Nothing of this computer goes with it.
      assert.equal(sheet.parameters.native_components, undefined);
      assert.doesNotMatch(JSON.stringify(sheet), /safetensors|[A-Z]:\\\\/);
      await api('history/clear', { confirm: true });
      // The conversation gone, the file still says what made it.
      const kept = await readFile(join(outputDir, 'image', job.record.outputs[0].source.filename));
      assert.deepEqual(kept, served);
      assert.equal((await bytesInfo(kept)).id, job.record.id);
      // Nothing else in the folder of the outputs: the image in its folder, and no temporary file.
      assert.deepEqual(await readdir(outputDir), ['image']);
      assert.deepEqual(await readdir(join(outputDir, 'image')), [named + '.png']);
    } finally {
      await app?.close();
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
    // Each job with the files of its sources as the engine reads them (they are removed afterwards).
    const jobs = [];
    const worker = fakeEngine(outputDir, {
      flat: true,
      onGenerate: job => jobs.push({ ...job, staged: job.references.map(ref => readFileSync(ref.path)) }),
    });
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
      // Its result is the only one the model may name: by its run_id, or by its number in the
      // project as the user sees it (« PRISE 1 », 0.6.4).
      const variants = edited.parameters.properties.source.anyOf;
      assert.deepEqual(
        variants.map(variant => variant.required),
        [['output'], ['take']],
      );
      assert.deepEqual(variants[0].properties.output.enum, [job.record.id]);
      assert.deepEqual(variants[1].properties.take.enum, [job.record.outputs[0].take]);
      assert.equal(job.record.outputs[0].take, 1);
      const edit = (await chat('generate from ' + job.record.id)).find(e => e.local_tool_request).local_tool_request;
      assert.equal(edit.call.function.name, 'create_image');
      assert.equal(edit.referenceCount, 1);
      // « Repars de la prise 1 » : named by its number, the take is found and passed as itself.
      const byNumber = (await chat('generate from take 1')).find(e => e.local_tool_request).local_tool_request;
      assert.equal(byNumber.call.function.name, 'create_image');
      assert.deepEqual(JSON.parse(byNumber.call.function.arguments).source, { output: job.record.id });
      assert.equal(byNumber.referenceCount, 1);
      // A number that is no take of the project: said to the model, which can answer.
      const unknown = (await chat('generate from take 99')).find(e => e.local_tool_request).local_tool_request;
      assert.equal(unknown.kind, 'invalid');
      assert.equal(unknown.message, 'La prise 99 n’existe pas dans ce projet.');

      // An image of the project the user names (« ref1 ») and the model leaves out: the model is
      // told once, with the argument to pass…
      const uploaded = await fetch(app.url + '/api/resources/upload', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + boot.token,
          'Content-Type': 'image/png',
          'X-Resource-Name': encodeURIComponent('stairs.png'),
        },
        body: png,
      });
      assert.equal(uploaded.status, 201, await uploaded.clone().text());
      const stairs = await (
        await api('resources/update', {
          id: (await uploaded.json()).id,
          patch: {
            description: 'Stairs in the sky',
            prepared: { width: 1, height: 1, frames: [{ url: 'data:image/png;base64,' + png.toString('base64'), time: null }] },
          },
        })
      ).json();
      assert.equal(stairs.label, '#ref1');
      const wish = 'generate a boat like ref1, whatever is said',
        told = (await chat(wish)).find(e => e.local_tool_request).local_tool_request;
      assert.equal(told.kind, 'invalid');
      assert.match(told.message, new RegExp(`#ref1 \\(\\{"resource": "${stairs.id}"\\}\\) : ce qu’il cite n’est pas transmise à l’outil`));
      assert.match(told.message, /image de fin, référence ou image de départ/);
      // … and its next call stands, whatever it decides: the proposal then says to the user that
      // the image they named does not reach the generator.
      const stands = (
        await (
          await api('chat', {
            messages: [
              { role: 'user', content: wish },
              { role: 'assistant', content: '', tool_calls: [told.call] },
              { role: 'tool', tool_call_id: told.call.id, content: JSON.stringify({ status: 'error', message: told.message }) },
            ],
            conversationId,
            turnId: randomUUID(),
          })
        ).text()
      )
        .split(/\r?\n\r?\n/)
        .filter(s => s.startsWith('data: ') && s !== 'data: [DONE]')
        .map(s => JSON.parse(s.slice(6)))
        .find(e => e.local_tool_request).local_tool_request;
      assert.equal(stands.kind, undefined, stands.message);
      assert.ok(stands.requestId, 'a proposal the user can approve');
      assert.deepEqual(stands.notes, [
        '#ref1 n’est pas transmise. Le générateur ne la verra pas, seul le prompt peut la décrire.',
      ]);
      assert.deepEqual(stands.cited, { left: [{ id: stairs.id, label: '#ref1' }], roles: ['source'] });
      // Its identifier written in the prompt is not the image passed: seen once the call is resolved,
      // the model is told then (its workflow has a place for it), and nothing is left to approve.
      const written = (await chat(`generate naming ${stairs.id} for ref1`)).find(e => e.local_tool_request).local_tool_request;
      assert.equal(written.kind, 'invalid');
      assert.match(written.message, /n’est pas transmise à l’outil.*\(image à modifier : source\)\.$/);
      assert.equal(written.requestId, undefined);

      // A take written before the three folders (in the folder of the outputs itself, under a random
      // name) is given to the engine as itself: its own file, with the sheet written in it.
      const run = async proposal => {
        await api('tools/execute', { requestId: proposal.requestId, permission: 'once' }, 202);
        const done = await until(async () => {
          const j = await (await api('tools/job')).json();
          return j && ['done', 'error'].includes(j.state) && j;
        });
        assert.equal(done.state, 'done', done.error);
        await until(async () => (await (await api('status')).json()).state === 'ready');
        return done.record;
      };
      const proposed = async text => (await chat(text)).find(e => e.local_tool_request).local_tool_request;
      assert.match(job.record.outputs[0].source.filename, /^[0-9a-f]{32}\.png$/);
      assert.equal(job.record.outputs[0].source.subfolder, '');
      await run(await proposed('generate from ' + job.record.id));
      assert.equal(jobs.at(-1).references.length, 1);
      assert.deepEqual(await withoutSheet(jobs.at(-1).staged[0]), png);
      assert.equal((await bytesInfo(jobs.at(-1).staged[0])).id, job.record.id);
      // From now on the engine writes where the application asks: the folder of the images. A take
      // made there is a source like the others.
      worker.flat = false;
      const named = await run(await proposed('generate a boat'));
      assert.equal(named.outputs[0].source.subfolder, 'image');
      assert.match(named.outputs[0].source.filename, /^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d_krea-2_[0-9a-f]{4}\.png$/);
      const fromNamed = await proposed('generate from ' + named.id);
      assert.equal(fromNamed.referenceCount, 1);
      await run(fromNamed);
      assert.equal((await bytesInfo(jobs.at(-1).staged[0])).id, named.id);
      // Both are listed, and served at their address: the old ones where they were, the new ones in
      // their folder.
      const { runs } = await (await api(`gallery/${conversationId}?images=0`)).json();
      assert.deepEqual(runs.map(made => made.outputs[0].source.subfolder).sort(), ['', '', 'image', 'image']);
      for (const made of runs) {
        const original = await fetch(app.url + made.outputs[0].originalUrl);
        assert.equal(original.status, 200, made.outputs[0].source.filename);
        assert.equal((await bytesInfo(Buffer.from(await original.arrayBuffer()))).id, made.id);
      }
      assert.deepEqual((await readdir(outputDir)).filter(name => !/^[0-9a-f]{32}\.png$/.test(name)), ['image']);
    } finally {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

/**
 * Moodix with the scripted chat model started (the local one) and one image workflow, for a series
 * of images asked in one message. `seen`: the prompts the generator was given, the times the chat
 * model was started (`starts`), and `hold`, a promise a test sets to keep a generation running.
 * `remote` (0.6.100): a preset (« openrouter »), the same scripted model reached as that service of
 * the Internet, chosen for the chat: a large model, given the « capable » wording.
 */
async function boatsApp({ fullPrompts = false, remote = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'native-series-'));
  let app;
  const outputDir = join(root, 'output');
  await mkdir(outputDir);
  const seen = { prompts: [], starts: 0, hold: null };
  const worker = fakeEngine(outputDir, {
    onGenerate: async job => {
      seen.prompts.push(job.parameters.prompt);
      await seen.hold;
    },
  });
  let service = null;
  const close = async () => {
    service?.kill();
    await app?.close();
    await rm(root, { recursive: true, force: true });
  };
  try {
    app = await createApplication({
      fullPrompts,
      port: 0,
      dataDir: root,
      outputDir,
      generationWorker: worker,
      spawnProcess: (_command, args, options) => {
        if (args.includes('--port')) seen.starts++;
        return spawn(process.execPath, [fixture, ...args], options);
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
    await api('generation/assets', { id: 'tokenizer', path: await tokenizerFolder(root), kind: 'tokenizer', family: 'krea2' });
    await api('generation/config', { enabled: true, autoAllow: false, maxIterations: 5, pythonPath: process.execPath });
    await api('generation/workflows', {
      schemaVersion: 1,
      id: 'integration-boats',
      name: 'Native image',
      description: 'Generate boats',
      enabled: true,
      pipeline: 'krea2',
      mediaType: 'image',
      components: Object.fromEntries(['model', 'textEncoder', 'tokenizer', 'vae'].map(k => [k, { policy: 'fixed', asset: k }])),
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
    });
    const modelPath = join(root, 'llm.gguf');
    await writeFile(modelPath, 'GGUF\x03\0\0\0');
    await api('config', { enginePath: process.execPath, modelPath, projectorPath: '', contextSize: 8192, maxOutputTokens: 4096, gpuLayers: 0 });
    await api('start', {}, 202);
    await until(async () => (await (await api('status')).json()).state === 'ready');
    if (remote) {
      // The scripted model as a service of the Internet would be: its address and its key.
      const probe = createServer();
      await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
      const { port } = probe.address();
      await new Promise(resolve => probe.close(resolve));
      const key = 'sk-test-' + randomUUID();
      service = spawn(process.execPath, [fixture, '--offline', '--host', '127.0.0.1', '--port', String(port), '--api-key', key], {
        stdio: 'ignore',
      });
      await until(async () => (await fetch(`http://127.0.0.1:${port}/health`).catch(() => null))?.status === 401);
      const { saved } = await (
        await api('remote/save', { preset: remote, baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test-model', key, vision: true })
      ).json();
      await api('remote/select', { id: saved.id });
    }
    const state = async () => (await (await api('status')).json()).state;
    /** What the server answers to a message of the chat: its proposal, or what it sends the model back with. */
    const ask = async (said = 'generate series of boats') => {
      const streamed = await (
        await api('chat', { messages: [{ role: 'user', content: said }], conversationId: randomUUID(), turnId: randomUUID() })
      ).text();
      const request = streamed
        .split(/\r?\n\r?\n/)
        .filter(s => s.startsWith('data: ') && s !== 'data: [DONE]')
        .map(s => JSON.parse(s.slice(6)))
        .find(e => e.local_tool_request)?.local_tool_request;
      assert.ok(request, streamed);
      return request;
    };
    /** A proposal run to the end of its job: its record. */
    const made = async proposal => {
      await api('tools/execute', { requestId: proposal.requestId, permission: 'once' }, 202);
      const job = await until(async () => {
        const j = await (await api('tools/job')).json();
        return j && ['done', 'error'].includes(j.state) && j;
      });
      assert.equal(job.state, 'done', job.error);
      return job.record;
    };
    return { api, ask, made, state, seen, close };
  } catch (error) {
    await close();
    throw error;
  }
}

test('several images asked in one message: one call, its images made one after another without the model', { timeout: 30000 }, async () => {
  const { api, ask, made, state, seen, close } = await boatsApp();
  try {
    const first = await ask();
    assert.deepEqual([first.series.index, first.series.total], [1, 3]);
    assert.equal(seen.starts, 1);
    const records = [await made(first)];
    // Between two images the chat model is not loaded again to be unloaded at once.
    assert.equal(await state(), 'stopped');
    for (const index of [2, 3]) {
      const next = await (await api('tools/series', { series: first.series.id })).json();
      assert.deepEqual([next.series.index, next.call.id], [index, first.call.id]);
      if (index === 2) {
        // While an image is being made, the name of a conversation is not asked: later.
        let release;
        seen.hold = new Promise(resolve => (release = resolve));
        await api('tools/execute', { requestId: next.requestId, permission: 'once' }, 202);
        await until(() => seen.prompts.length === 2);
        assert.deepEqual(await (await api('history/title', { id: randomUUID(), contents: ['Des bateaux'] })).json(), {
          later: true,
        });
        seen.hold = null;
        release();
        const job = await until(async () => {
          const j = await (await api('tools/job')).json();
          return j && ['done', 'error'].includes(j.state) && j;
        });
        assert.equal(job.state, 'done', job.error);
        records.push(job.record);
        assert.equal(await state(), 'stopped');
      } else records.push(await made(next));
    }
    // After the last image it is back, as after any creation: started once for the three images.
    assert.equal(await state(), 'ready');
    assert.equal(seen.starts, 2);
    assert.match(
      (await (await api('tools/series', { series: first.series.id }, 409)).json()).error,
      /terminée/,
    );
    assert.deepEqual(seen.prompts.map(prompt => prompt.match(/A \w+ boat/)?.[0]), ['A red boat', 'A blue boat', 'A green boat']);
    // Three takes, numbered one after another in the project.
    const takes = records.map(record => record.outputs[0].take);
    assert.deepEqual(takes, [takes[0], takes[0] + 1, takes[0] + 2]);

    // A series the page stops after its first image (the user's stop, an image refused): the server
    // is told, lets its prompts go, and answers once the chat model is back.
    const stopped = await ask();
    await made(stopped);
    assert.equal(await state(), 'stopped');
    assert.deepEqual(await (await api('tools/series', { series: stopped.series.id, end: true })).json(), { ended: true });
    assert.equal(await state(), 'ready');
    assert.equal(seen.starts, 3);
    assert.match((await (await api('tools/series', { series: stopped.series.id }, 409)).json()).error, /terminée/);
    // Its first proposal let go before anything ran: the series is not kept either.
    const unused = await ask();
    await api('tools/cancel', { requestId: unused.requestId });
    assert.match((await (await api('tools/series', { series: unused.series.id }, 409)).json()).error, /terminée/);
    assert.deepEqual([await state(), seen.starts, seen.prompts.length], ['ready', 3, 4]);
  } finally {
    await close();
  }
});

test('a series whose prompts are one-liners is sent back once: the images to write again named to a large model, its first prompt to the local one', { timeout: 30000 }, async () => {
  for (const remote of [null, 'openrouter']) {
    const { ask, seen, close } = await boatsApp({ fullPrompts: true, remote });
    try {
      // The scripted model writes « A red boat », « A blue boat », « A green boat »: nothing is proposed.
      const request = await ask();
      assert.equal(request.kind, 'retry');
      assert.equal(request.call.function.name, 'create_image');
      // (0.6.100) The local model is told of its first prompt alone, as until 0.6.67 (sent back for the
      // others, it wrote them in its answer and made no call); a large model, of every one.
      if (remote) assert.match(request.message, /^Nothing was generated: the prompt is too thin for every image of this series /);
      else assert.equal(request.message, THIN_NOTE);
      assert.equal(seen.prompts.length, 0);
      // A single image keeps the answer it always had.
      assert.equal((await ask('generate a boat')).message, THIN_NOTE);
    } finally {
      await close();
    }
  }
});

test('five images, the first prompt in full and the four others in a sentence: proposed with the local model, sent back to a large one (0.6.100)', { timeout: 30000 }, async () => {
  for (const remote of [null, 'openrouter']) {
    const { ask, seen, close } = await boatsApp({ fullPrompts: true, remote });
    try {
      // (The scripted model answers « generate five images » as a small one answered « genere 5 image
      // de l’espace » on 18/11: tests/fixtures/fake-tool-engine.mjs.)
      const request = await ask('generate five images');
      const asked = JSON.parse(request.call.function.arguments);
      assert.ok(asked.prompt.split(/\s+/).length >= 40 && asked.series.every(prompt => prompt.split(/\s+/).length < 40));
      if (remote) {
        // A large model writes them again when asked: the check of every prompt stays its own.
        assert.equal(request.kind, 'retry');
        assert.match(request.message, /too thin for images 2, 3, 4 and 5 of this series of 5 /);
      } else {
        // The local model: nothing sent back, the five images go, the first proposed now. Sent back for
        // the four others (0.6.68 to 0.6.90), it wrote them in its answer as a list and called nothing.
        assert.equal(request.kind, undefined);
        assert.ok(request.requestId);
        assert.deepEqual([request.series.index, request.series.total], [1, 5]);
      }
      assert.equal(seen.prompts.length, 0);
    } finally {
      await close();
    }
  }
});
