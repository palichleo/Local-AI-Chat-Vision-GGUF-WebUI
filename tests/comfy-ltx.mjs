import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComfyClient } from '../lib/comfy-client.mjs';
import {
  comfyEngine,
  comfyNames,
  comfyRoute,
  comfyUnsupported,
  longforgeGraph,
  runOnComfy,
} from '../lib/comfy-ltx.mjs';
import { GenerationService } from '../lib/generation-service.mjs';

const png = Buffer.from('89504e470d0a1a0a000102030405', 'hex');
const mp4 = Buffer.concat([Buffer.from('00000018667479706d703432', 'hex'), Buffer.alloc(32, 7)]);
const models = 'D:\\SwarmUI\\dlbackend\\comfy\\ComfyUI\\models\\';
const job = (overrides = {}) => ({
  schemaVersion: 1,
  id: '5b1f6f0e-6f0c-4b65-9d3b-0c3f3a8f7a11',
  pipeline: 'ltx25',
  mediaType: 'video',
  parameters: {
    prompt: 'un bateau fantôme',
    seed: 1075036270707423,
    width: 576,
    height: 1024,
    steps: 8,
    frames: 121,
    fps: 24,
    stage: 'final',
    audio: true,
    start_strength: 0.8,
    end_strength: 0.6,
    image_compression: 12,
    msr_frames: 25,
    msr_strength: 0.9,
    ...overrides.parameters,
  },
  components: {
    model: models + 'diffusion_models\\ltx-transformer.safetensors',
    textEncoder: models + 'text_encoders\\gemma.safetensors',
    vae: models + 'vae\\video-vae.safetensors',
    audioVae: models + 'vae\\LTX-2\\audio-vae.safetensors',
    upscaler: models + 'latent_upscale_models\\upscaler.safetensors',
  },
  loras: overrides.loras ?? [],
  references: overrides.references ?? [],
});
const choices = {
  UNETLoader: { input: { required: { unet_name: [['other.safetensors', 'ltx-transformer.safetensors'], {}] } } },
  // The newer description of a list: its type, then its options.
  CLIPLoader: { input: { required: { clip_name: ['COMBO', { options: ['gemma.safetensors'] }] } } },
  VAELoader: {
    input: {
      required: { vae_name: [['audio-vae.safetensors', 'LTX-2\\audio-vae.safetensors', 'video-vae.safetensors'], {}] },
    },
  },
  LongForgeLTXMSRReferences: { input: { required: { lora_name: [['subjects\\msr.safetensors'], {}] } } },
  LongForgeLTXRender: { input: { required: {} } },
};

async function comfy(t, { nodes = choices, film = mp4 } = {}) {
  const seen = { uploads: [], prompts: [], freed: 0 };
  const app = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks),
      url = new URL(req.url, 'http://localhost');
    const json = (value, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/queue') return json({ queue_running: [], queue_pending: [] });
    if (url.pathname === '/system_stats')
      return json({
        system: {},
        devices: [{ type: 'cuda', vram_total: 12, vram_free: 11, torch_vram_total: 2, torch_vram_free: 1 }],
      });
    if (url.pathname.startsWith('/object_info/')) {
      const node = decodeURIComponent(url.pathname.slice(13));
      return json(nodes[node] ? { [node]: nodes[node] } : {});
    }
    if (url.pathname === '/upload/image') {
      const text = body.toString('latin1');
      const name = /filename="([^"]+)"/.exec(text)[1];
      seen.uploads.push({ name, subfolder: /name="subfolder"\r\n\r\n([^\r]+)/.exec(text)?.[1] });
      return json({ name, subfolder: 'longforge_ltx25', type: 'input' });
    }
    if (url.pathname === '/prompt') {
      seen.prompts.push(JSON.parse(body));
      return json({ prompt_id: 'prompt-1' });
    }
    if (url.pathname === '/history/prompt-1')
      return json({
        'prompt-1': {
          status: { status_str: 'success', completed: true, messages: [] },
          outputs: {
            render: {
              images: [{ filename: 'film_1.mp4', subfolder: 'longforge_ltx25/atelier_x/exports', type: 'output' }],
              longforge: [{ timings: [] }],
            },
          },
        },
      });
    if (url.pathname === '/view') {
      seen.viewed = Object.fromEntries(url.searchParams);
      res.writeHead(200, { 'content-type': 'video/mp4' });
      return res.end(film);
    }
    if (url.pathname === '/free') {
      seen.freed++;
      return json({});
    }
    json({ error: 'unexpected ' + url.pathname }, 500);
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    app.closeAllConnections();
    return new Promise(resolve => app.close(resolve));
  });
  const baseUrl = `http://127.0.0.1:${app.address().port}`;
  return { seen, baseUrl, connect: url => new ComfyClient(url, { pollMs: 1, socketImpl: null }) };
}

test('the trial is off unless data/comfy-engine.json enables a loopback ComfyUI', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-ltx-'));
  assert.equal(await comfyEngine(dir), null);
  await writeFile(join(dir, 'comfy-engine.json'), JSON.stringify({ enabled: false, baseUrl: 'http://127.0.0.1:7821' }));
  assert.equal(await comfyEngine(dir), null);
  await writeFile(
    join(dir, 'comfy-engine.json'),
    JSON.stringify({ enabled: true, baseUrl: 'http://example.com:8188' }),
  );
  assert.equal(await comfyEngine(dir), null);
  await writeFile(join(dir, 'comfy-engine.json'), JSON.stringify({ enabled: true, baseUrl: 'http://127.0.0.1:7821/' }));
  assert.deepEqual(await comfyEngine(dir), { baseUrl: 'http://127.0.0.1:7821' });
  // Only an enabled trial sends a job elsewhere, and only a job LongForge is driven for.
  assert.equal(await comfyRoute(await mkdtemp(join(tmpdir(), 'comfy-ltx-')), job()), null);
});

test('continuations, silent clips and other families stay on the built-in engine', () => {
  assert.equal(comfyUnsupported(job()), '');
  assert.match(comfyUnsupported({ ...job(), pipeline: 'flux2' }), /LTX/);
  assert.match(
    comfyUnsupported(job({ references: [{ input: 'source', role: 'source_video', path: '/x.mp4' }] })),
    /continuations/,
  );
  assert.match(comfyUnsupported(job({ parameters: { audio: false } })), /sound/);
  assert.match(comfyUnsupported(job({ parameters: { fps: 30 } })), /24/);
  assert.match(comfyUnsupported(job({ parameters: { frames: 17 } })), /one second/);
  const subjects = [1, 2, 3].map(n => ({ input: 'ref' + n, role: 'msr_image', path: `/s${n}.png` }));
  assert.match(comfyUnsupported(job({ references: subjects })), /two subject/);
});

test('model files take the names ComfyUI lists them under', async t => {
  const fake = await comfy(t);
  const names = await comfyNames(
    fake.connect(fake.baseUrl),
    job({ loras: [{ id: 'msr', path: models + 'loras\\subjects\\msr.safetensors', strength: 1 }] }),
  );
  assert.deepEqual(names, {
    model: 'ltx-transformer.safetensors',
    textEncoder: 'gemma.safetensors',
    vae: 'video-vae.safetensors',
    // The entry of the sub-folder the file really is in, not its namesake.
    audioVae: 'LTX-2\\audio-vae.safetensors',
    lora: 'subjects\\msr.safetensors',
  });
  const bare = await comfy(t, { nodes: { ...choices, LongForgeLTXRender: undefined } });
  await assert.rejects(comfyNames(bare.connect(bare.baseUrl), job()), /LongForgeLTXRender/);
  const other = await comfy(t, {
    nodes: { ...choices, UNETLoader: { input: { required: { unet_name: [['other.safetensors'], {}] } } } },
  });
  await assert.rejects(comfyNames(other.connect(other.baseUrl), job()), /ltx-transformer\.safetensors/);
});

test('the graph carries the job: prompt, seed, size, length, images by role', () => {
  const text = longforgeGraph(job());
  assert.equal(text.project.inputs.project_name, 'atelier_5b1f6f0e6f0c4b659d3b0c3f3a8f7a11');
  assert.deepEqual(JSON.parse(text.project.inputs.scene_data), [{ name: 'Scene 1', prompt: 'un bateau fantôme' }]);
  assert.deepEqual([text.video.inputs.width, text.video.inputs.height, text.video.inputs.new_seconds], [576, 1024, 5]);
  assert.equal(text.sampling.inputs.seed, 1075036270707423);
  assert.equal(text.sampling.inputs.increment_seed, false);
  assert.equal(text.model.inputs.unet_name, 'ltx-transformer.safetensors');
  assert.equal(text.render.inputs.media, undefined);
  assert.equal(text.subjects, undefined);
  // Every link points at a node of the graph.
  for (const node of Object.values(text))
    for (const value of Object.values(node.inputs)) if (Array.isArray(value)) assert.ok(text[value[0]], value[0]);

  const references = [
    { input: 'start', role: 'start_image', path: '/a.png' },
    { input: 'end', role: 'end_image', path: '/b.png' },
    { input: 'ref1', role: 'msr_image', path: '/c.png' },
    { input: 'ref2', role: 'msr_image', path: '/d.png' },
  ];
  const lora = { id: 'msr', path: models + 'loras\\msr.safetensors', strength: 0.95 };
  const files = {
    start: 'longforge_ltx25/a.png',
    end: 'longforge_ltx25/b.png',
    ref1: 'longforge_ltx25/c.png',
    ref2: 'longforge_ltx25/d.png',
  };
  const full = longforgeGraph(job({ references, loras: [lora] }), files, { lora: 'subjects\\msr.safetensors' });
  assert.deepEqual(JSON.parse(full.project.inputs.scene_data)[0].ltx, {
    start_file: 'longforge_ltx25/a.png',
    start_enabled: true,
    end_file: 'longforge_ltx25/b.png',
    end_enabled: true,
  });
  assert.deepEqual(
    [full.sampling.inputs.start_strength, full.sampling.inputs.end_strength, full.sampling.inputs.image_compression],
    [0.8, 0.6, 12],
  );
  assert.deepEqual(full.subjects.inputs, {
    lora_name: 'subjects\\msr.safetensors',
    strength_model: 0.95,
    strength: 0.9,
    reference_frames: '25',
    reference1: ['subject1', 0],
    reference2: ['subject2', 0],
  });
  assert.equal(full.subject2.inputs.image, 'longforge_ltx25/d.png');
  assert.deepEqual(full.render.inputs.media, ['subjects', 0]);
  assert.throws(() => longforgeGraph(job({ references, loras: [lora] }), {}), /non transmise/);
  assert.throws(() => longforgeGraph(job({ references }), files), /LoRA/);
});

test('a job runs on ComfyUI and its film lands in the output folder like a built-in result', async t => {
  const fake = await comfy(t),
    dir = await mkdtemp(join(tmpdir(), 'comfy-ltx-')),
    outputDir = join(dir, 'output');
  await mkdir(outputDir);
  await writeFile(join(dir, 'start.png'), png);
  const client = fake.connect(fake.baseUrl);
  // The same image as start frame and as subject is sent once.
  const references = [
    { input: 'start', role: 'start_image', path: join(dir, 'start.png') },
    { input: 'ref1', role: 'msr_image', path: join(dir, 'start.png') },
  ];
  const work = job({
    references,
    loras: [{ id: 'msr', path: models + 'loras\\subjects\\msr.safetensors', strength: 1 }],
  });
  const stages = [];
  const result = await runOnComfy(work, {
    client,
    names: await comfyNames(client, work),
    baseUrl: fake.baseUrl,
    outputDir,
    onProgress: value => stages.push(value.stage),
  });
  assert.equal(fake.seen.uploads.length, 1);
  assert.equal(fake.seen.uploads[0].subfolder, 'longforge_ltx25');
  const sent = fake.seen.prompts[0];
  assert.deepEqual(sent.partial_execution_targets, ['render']);
  assert.equal(sent.prompt.subject1.inputs.image, 'longforge_ltx25/' + fake.seen.uploads[0].name);
  assert.equal(JSON.parse(sent.prompt.project.inputs.scene_data)[0].ltx.start_file, sent.prompt.subject1.inputs.image);
  assert.equal(sent.prompt.audioVae.inputs.vae_name, 'LTX-2\\audio-vae.safetensors');
  assert.deepEqual(fake.seen.viewed, {
    filename: 'film_1.mp4',
    subfolder: 'longforge_ltx25/atelier_x/exports',
    type: 'output',
  });
  assert.deepEqual(stages, ['sending to ComfyUI', 'sampling video', 'audio decoded']);

  assert.equal(result.jobId, work.id);
  const [output] = result.outputs;
  assert.match(output.filename, /^[0-9a-f]{32}\.mp4$/);
  assert.deepEqual(
    { ...output, filename: '' },
    { filename: '', subfolder: '', type: 'output', width: 576, height: 1024 },
  );
  assert.deepEqual(
    (await readdir(outputDir)).sort(),
    [output.filename.replace('.mp4', '.json'), output.filename].sort(),
  );
  assert.deepEqual(await readFile(join(outputDir, output.filename)), mp4);
  const saved = JSON.parse(await readFile(join(outputDir, output.filename.replace('.mp4', '.json')), 'utf8'));
  assert.equal(saved.metadata.backend, 'comfyui-longforge');
  assert.equal(saved.metadata.comfy.promptId, 'prompt-1');
});

test('the generation service sends LTX jobs to ComfyUI only while the trial is on', async t => {
  const fake = await comfy(t),
    dataDir = await mkdtemp(join(tmpdir(), 'comfy-ltx-')),
    outputDir = join(dataDir, 'output');
  await mkdir(outputDir);
  const calls = [];
  const worker = {
    status: () => ({ state: 'ready', busy: false }),
    request: async (method, payload) => {
      calls.push(method);
      return method === 'generate' ? { jobId: payload.id, outputs: [], metadata: {} } : {};
    },
    unload: async () => calls.push('unload'),
    release: async () => (calls.push('release'), { released: true }),
    close: async () => {},
  };
  const service = new GenerationService({
    root: dataDir,
    dataDir,
    workflowDir: join(dataDir, 'workflows'),
    outputDir,
    worker,
    environment: { close: async () => {} },
    comfyConnect: fake.connect,
  });

  // Off: the built-in worker, and ComfyUI is never called.
  assert.equal(await service.backendNote(job()), null);
  let client = service.client();
  await client.preflight(job());
  assert.deepEqual((await client.run(job())).outputs, []);
  await client.free();
  assert.deepEqual(calls, ['preflight', 'generate', 'release']);
  assert.equal(fake.seen.prompts.length + fake.seen.freed, 0);

  await writeFile(join(dataDir, 'comfy-engine.json'), JSON.stringify({ enabled: true, baseUrl: fake.baseUrl }));
  assert.match(await service.backendNote(job()), /ComfyUI/);
  // A continuation still belongs to the built-in engine.
  const continuation = job({ references: [{ input: 'source', role: 'source_video', path: '/x.mp4' }] });
  assert.equal(await service.backendNote(continuation), null);
  calls.length = 0;
  client = service.client();
  await client.preflight(continuation);
  await client.run(continuation);
  await client.free();
  assert.deepEqual(calls, ['preflight', 'generate', 'release']);
  assert.equal(fake.seen.prompts.length + fake.seen.freed, 0);

  calls.length = 0;
  client = service.client();
  await client.preflight(job());
  const result = await client.run(job());
  assert.equal(result.metadata.backend, 'comfyui-longforge');
  assert.equal((await readdir(outputDir)).length, 2);
  await client.free();
  // The built-in engine checks the job and empties its memory; it does not generate.
  assert.deepEqual(calls, ['preflight', 'unload', 'release']);
  assert.equal(fake.seen.freed, 1);

  // A ComfyUI that is not running is said before anything is unloaded.
  await writeFile(join(dataDir, 'comfy-engine.json'), JSON.stringify({ enabled: true, baseUrl: 'http://127.0.0.1:9' }));
  await assert.rejects(service.client().preflight(job()), /ComfyUI ne répond pas/);
});
