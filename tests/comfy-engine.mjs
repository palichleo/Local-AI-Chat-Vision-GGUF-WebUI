import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComfyClient } from '../lib/comfy-client.mjs';
import { comfyEngine, comfyNames, comfyRoute, comfyUnsupported, runOnComfy } from '../lib/comfy-engine.mjs';
import { comfyGraph } from '../lib/comfy-graphs.mjs';
import { GenerationService } from '../lib/generation-service.mjs';
import { mp4Bytes, mp4Info } from '../lib/video-info.mjs';

const u32 = value => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};
const box = (type, ...content) => {
  const body = Buffer.concat(content);
  return Buffer.concat([u32(body.length + 8), Buffer.from(type, 'latin1'), body]);
};
/** A PNG as far as its size, and an MP4 as far as its index: what the engine reads of a result. */
const png = (width = 4, height = 2) =>
  Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), box('IHDR', u32(width), u32(height), Buffer.alloc(5))]);
const mp4 = ({ width = 576, height = 1024, frames = 121, fps = 24 } = {}) =>
  Buffer.concat([
    box('ftyp', Buffer.from('mp42')),
    box(
      'moov',
      box(
        'trak',
        box('tkhd', Buffer.alloc(76), u32(width * 65536), u32(height * 65536)),
        box(
          'mdia',
          box('mdhd', Buffer.alloc(12), u32(fps * 1000), u32(frames * 1000)),
          box('hdlr', Buffer.alloc(8), Buffer.from('vide')),
          box('minf', box('stbl', box('stts', u32(0), u32(1), u32(frames), u32(1000)))),
        ),
      ),
    ),
  ]);
const models = 'D:\\SwarmUI\\dlbackend\\comfy\\ComfyUI\\models\\';
const job = (pipeline, { parameters = {}, components = {}, loras = [], references = [], ...rest } = {}) => ({
  schemaVersion: 1,
  id: '5b1f6f0e-6f0c-4b65-9d3b-0c3f3a8f7a11',
  pipeline,
  mediaType: ['ltx25', 'minimax_h3', 'realesrgan_video', 'rife'].includes(pipeline) ? 'video' : 'image',
  parameters,
  components,
  loras,
  references,
  ...rest,
});
const ltx = (overrides = {}) =>
  job('ltx25', {
    ...overrides,
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
  });
const krea = (overrides = {}) =>
  job('krea2', {
    ...overrides,
    parameters: {
      prompt: 'un renard',
      seed: 42,
      width: 1024,
      height: 768,
      steps: 8,
      cfg: 1,
      denoise: 1,
      ...overrides.parameters,
    },
    components: {
      model: models + 'diffusion_models\\krea.safetensors',
      textEncoder: models + 'text_encoders\\qwen.safetensors',
      tokenizer: 'D:\\tokenizers\\qwen',
      vae: models + 'vae\\krea-vae.safetensors',
    },
  });
const h3 = (overrides = {}) =>
  job('minimax_h3', {
    ...overrides,
    parameters: {
      prompt: 'la mer',
      seed: 5,
      width: 768,
      height: 448,
      steps: 8,
      frames: 124,
      fps: 24,
      audio: true,
      ...overrides.parameters,
    },
    components: {
      model: models + 'diffusion_models\\h3.safetensors',
      textEncoder: models + 'text_encoders\\qwen32.safetensors',
      vae: models + 'vae\\MiniMaxH3\\h3-vae.safetensors',
      audioVae: models + 'vae\\MiniMaxH3\\h3-audio.safetensors',
    },
  });
const source = (role, path = '/source') => [{ input: 'source', role, path }];
const lists = {
  UNETLoader: [
    'unet_name',
    ['other.safetensors', 'ltx-transformer.safetensors', 'krea.safetensors', 'h3.safetensors', 'seedvr.safetensors'],
  ],
  CLIPLoader: ['clip_name', ['gemma.safetensors', 'qwen.safetensors', 'qwen32.safetensors']],
  VAELoader: [
    'vae_name',
    [
      'audio-vae.safetensors',
      'LTX-2\\audio-vae.safetensors',
      'video-vae.safetensors',
      'krea-vae.safetensors',
      'MiniMaxH3\\h3-vae.safetensors',
      'MiniMaxH3\\h3-audio.safetensors',
      'ema.safetensors',
    ],
  ],
  LongForgeLTXMSRReferences: ['lora_name', ['subjects\\msr.safetensors']],
  LoraLoaderModelOnly: ['lora_name', ['style.safetensors', 'detail.safetensors']],
  UpscaleModelLoader: ['model_name', ['RealESRGAN_x2plus.pth', 'RealESRGAN_x4plus.pth']],
  FrameInterpolationModelLoader: ['model_name', ['rife.safetensors']],
};

/** A ComfyUI that knows every node but `missing`, lists `lists`, and answers a run with `film`. */
async function comfy(t, { missing = [], files = lists, result, ram = 32 * 1024 ** 3 } = {}) {
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
        system: { ram_total: ram },
        devices: [{ type: 'cuda', vram_total: 12, vram_free: 11, torch_vram_total: 2, torch_vram_free: 1 }],
      });
    if (url.pathname.startsWith('/object_info/')) {
      const node = decodeURIComponent(url.pathname.slice(13));
      if (missing.includes(node)) return json({});
      const [input, names] = files[node] ?? [];
      // Either description of a list: the names themselves, or a type with its options.
      const spec = node === 'CLIPLoader' ? ['COMBO', { options: names }] : [names, {}];
      return json({ [node]: { input: { required: input ? { [input]: spec } : {} } } });
    }
    if (url.pathname === '/upload/image') {
      const text = body.toString('latin1');
      const name = /filename="([^"]+)"/.exec(text)[1],
        subfolder = /name="subfolder"\r\n\r\n([^\r]+)/.exec(text)?.[1];
      seen.uploads.push({ name, subfolder });
      return json({ name, subfolder, type: 'input' });
    }
    if (url.pathname === '/prompt') {
      seen.prompts.push(JSON.parse(body));
      return json({ prompt_id: 'prompt-1' });
    }
    if (url.pathname === '/history/prompt-1') {
      const { prompt, partial_execution_targets: targets } = seen.prompts.at(-1);
      const video = prompt[targets[0]].class_type !== 'SaveImage';
      seen.film = result ?? (video ? mp4() : png(2048, 1536));
      return json({
        'prompt-1': {
          status: { status_str: 'success', completed: true, messages: [] },
          outputs: {
            [targets[0]]: {
              images: [{ filename: video ? 'film_1.mp4' : 'image_1.png', subfolder: 'atelier', type: 'output' }],
            },
            ...(targets[1] ? { [targets[1]]: { text: ['un renard roux, en détail. Grain.'] } } : {}),
          },
        },
      });
    }
    if (url.pathname === '/view') {
      seen.viewed = Object.fromEntries(url.searchParams);
      res.writeHead(200, { 'content-type': seen.viewed.filename.endsWith('.mp4') ? 'video/mp4' : 'image/png' });
      return res.end(seen.film);
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
const trial = async (baseUrl = 'http://127.0.0.1:7821') => {
  const dataDir = await mkdtemp(join(tmpdir(), 'comfy-engine-'));
  await mkdir(join(dataDir, 'output'));
  if (baseUrl) await writeFile(join(dataDir, 'comfy-engine.json'), JSON.stringify({ enabled: true, baseUrl }));
  return dataDir;
};
/** Every link of a graph points at one of its nodes. */
const linked = graph => {
  for (const [id, node] of Object.entries(graph))
    for (const value of Object.values(node.inputs))
      if (Array.isArray(value)) assert.ok(graph[value[0]], `${id} -> ${value[0]}`);
  return graph;
};

test('the trial is off unless data/comfy-engine.json enables a loopback ComfyUI', async () => {
  const dir = await trial(null);
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
  // Only an enabled trial sends a job elsewhere.
  assert.equal(await comfyRoute(await trial(null), ltx()), null);
});

test('what no graph is written for stays on the built-in engine', () => {
  for (const work of [ltx(), krea(), h3(), h3({ parameters: { audio: false } })])
    assert.equal(comfyUnsupported(work), '');
  assert.match(comfyUnsupported(job('flux9')), /no ComfyUI graph/);
  assert.match(comfyUnsupported(ltx({ references: source('source_video') })), /continuations/);
  assert.match(comfyUnsupported(h3({ references: source('source_video') })), /continuations/);
  assert.match(comfyUnsupported(ltx({ parameters: { audio: false } })), /sound/);
  assert.match(comfyUnsupported(ltx({ parameters: { fps: 30 } })), /24/);
  assert.match(comfyUnsupported(ltx({ parameters: { frames: 17 } })), /one second/);
  const subjects = [1, 2, 3].map(n => ({ input: 'ref' + n, role: 'msr_image', path: `/s${n}.png` }));
  assert.match(comfyUnsupported(ltx({ references: subjects })), /two subject/);
  assert.match(comfyUnsupported(job('seedvr2')), /one source/);
  assert.equal(comfyUnsupported(job('rife', { references: source('source_video') })), '');
});

test('model files take the names ComfyUI lists them under, and every node of the graph is checked', async t => {
  const fake = await comfy(t);
  const lora = { id: 'msr', path: models + 'loras\\subjects\\msr.safetensors', strength: 1 };
  assert.deepEqual(await comfyNames(fake.connect(fake.baseUrl), ltx({ loras: [lora] })), {
    model: 'ltx-transformer.safetensors',
    textEncoder: 'gemma.safetensors',
    vae: 'video-vae.safetensors',
    // The entry of the sub-folder the file really is in, not its namesake.
    audioVae: 'LTX-2\\audio-vae.safetensors',
    lora: 'subjects\\msr.safetensors',
  });
  const styles = ['style', 'detail'].map(id => ({ id, path: `E:\\loras\\${id}.safetensors`, strength: 0.5 }));
  assert.deepEqual(await comfyNames(fake.connect(fake.baseUrl), krea({ loras: styles })), {
    model: 'krea.safetensors',
    textEncoder: 'qwen.safetensors',
    vae: 'krea-vae.safetensors',
    // Another copy of the file, in a folder ComfyUI does not read: the same name is enough.
    lora0: 'style.safetensors',
    lora1: 'detail.safetensors',
  });
  // A node only the graph uses (no file is chosen in it) is asked for too.
  const bare = await comfy(t, { missing: ['MiniMaxH3SigmaShift'] });
  await assert.rejects(comfyNames(bare.connect(bare.baseUrl), h3()), /MiniMaxH3SigmaShift/);
  const other = await comfy(t, { files: { ...lists, UNETLoader: ['unet_name', ['other.safetensors']] } });
  await assert.rejects(comfyNames(other.connect(other.baseUrl), krea()), /krea\.safetensors/);
});

test('LTX: the LongForge graph carries the prompt, seed, size, length and the images by role', () => {
  const { graph: text, output } = comfyGraph(ltx());
  linked(text);
  assert.equal(output, 'render');
  assert.equal(text.project.inputs.project_name, 'atelier_5b1f6f0e6f0c4b659d3b0c3f3a8f7a11');
  assert.deepEqual(JSON.parse(text.project.inputs.scene_data), [{ name: 'Scene 1', prompt: 'un bateau fantôme' }]);
  assert.deepEqual([text.video.inputs.width, text.video.inputs.height, text.video.inputs.new_seconds], [576, 1024, 5]);
  assert.equal(text.sampling.inputs.seed, 1075036270707423);
  assert.equal(text.model.inputs.unet_name, 'ltx-transformer.safetensors');
  assert.equal(text.render.inputs.media, undefined);

  const references = [
    { input: 'start', role: 'start_image', path: '/a.png' },
    { input: 'end', role: 'end_image', path: '/b.png' },
    { input: 'ref1', role: 'msr_image', path: '/c.png' },
    { input: 'ref2', role: 'msr_image', path: '/d.png' },
  ];
  const lora = { id: 'msr', path: models + 'loras\\msr.safetensors', strength: 0.95 };
  const inputs = { start: 'in/a.png', end: 'in/b.png', ref1: 'in/c.png', ref2: 'in/d.png' };
  const { graph: full } = comfyGraph(ltx({ references, loras: [lora] }), inputs, { lora: 'subjects\\msr.safetensors' });
  linked(full);
  assert.deepEqual(JSON.parse(full.project.inputs.scene_data)[0].ltx, {
    start_file: 'in/a.png',
    start_enabled: true,
    end_file: 'in/b.png',
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
  assert.equal(full.subject2.inputs.image, 'in/d.png');
  assert.deepEqual(full.render.inputs.media, ['subjects', 0]);
  assert.throws(() => comfyGraph(ltx({ references, loras: [lora] }), {}), /non transmis/);
  assert.throws(() => comfyGraph(ltx({ references }), inputs), /LoRA/);
});

test('Krea 2: text, LoRAs in a chain, an image to start from, a prompt rewritten first', () => {
  const { graph, output, text } = comfyGraph(krea());
  linked(graph);
  assert.deepEqual([output, text], ['save', undefined]);
  assert.deepEqual(graph.latent, {
    class_type: 'EmptyLatentImage',
    inputs: { width: 1024, height: 768, batch_size: 1 },
  });
  assert.equal(graph.positive.inputs.text, 'un renard');
  assert.equal(graph.clip.inputs.type, 'krea2');
  assert.deepEqual(
    Object.fromEntries(
      ['seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise', 'model'].map(k => [k, graph.sampler.inputs[k]]),
    ),
    { seed: 42, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['model', 0] },
  );

  const loras = ['style', 'detail'].map((id, index) => ({
    id,
    path: `E:\\loras\\${id}.safetensors`,
    strength: 0.5 + index / 10,
  }));
  const promptExpansion = {
    template: 'Réécris : {{prompt}}',
    suffix: ' Grain.',
    maxTokens: 120,
    temperature: 3,
    topK: 64,
    topP: 0.9,
    minP: 0.05,
    repetitionPenalty: 1.05,
    seed: 7,
  };
  const edit = comfyGraph(
    krea({ loras, references: source('img2img'), promptExpansion, parameters: { denoise: 0.6, expandPrompt: true } }),
    { source: 'atelier/in.png' },
  );
  linked(edit.graph);
  assert.deepEqual(edit.graph.lora1.inputs, {
    lora_name: 'detail.safetensors',
    strength_model: 0.6,
    model: ['lora0', 0],
  });
  assert.deepEqual(edit.graph.sampler.inputs.model, ['lora1', 0]);
  assert.equal(edit.graph.sampler.inputs.denoise, 0.6);
  // The source is cropped to the size asked, then encoded in place of an empty image.
  assert.deepEqual(edit.graph.fitted.inputs, {
    image: ['source', 0],
    upscale_method: 'lanczos',
    width: 1024,
    height: 768,
    crop: 'center',
  });
  assert.equal(edit.graph.latent.class_type, 'VAEEncode');
  assert.equal(edit.graph.expand.inputs.prompt, 'Réécris : un renard');
  // ComfyUI's text generation stops at a temperature of 2.
  assert.equal(edit.graph.expand.inputs['sampling_mode.temperature'], 2);
  assert.deepEqual(edit.graph.prompt.inputs, { string_a: ['expand', 0], string_b: ' Grain.', delimiter: '' });
  assert.deepEqual(edit.graph.positive.inputs.text, ['prompt', 0]);
  assert.equal(edit.text, 'promptText');
});

test('MiniMax H3: text and references, or a start and an end image; silent on request', () => {
  const text = comfyGraph(h3()).graph;
  linked(text);
  assert.equal(text.conditions.class_type, 'MiniMaxH3ReferenceToVideo');
  assert.deepEqual(
    [text.conditions.inputs.width, text.conditions.inputs.height, text.conditions.inputs.length],
    [768, 448, 124],
  );
  assert.deepEqual(text.shifted.inputs, { model: ['model', 0], shift_video: 12, shift_audio: 3 });
  assert.equal(text.noise.inputs.noise_seed, 5);
  assert.deepEqual(text.video.inputs.audio, ['sound', 0]);
  assert.equal(text.video.inputs.fps, 24);

  const references = [1, 2].map(n => ({ input: 'subject-' + n, role: 'reference_image', path: `/r${n}.png` }));
  const subjects = comfyGraph(h3({ references }), { 'subject-1': 'atelier/1.png', 'subject-2': 'atelier/2.png' }).graph;
  linked(subjects);
  assert.deepEqual(subjects.conditions.inputs['ref_images.ref_image_1'], ['reference2', 0]);
  assert.equal(subjects.reference2.inputs.image, 'atelier/2.png');

  const frames = [
    { input: 'start', role: 'start_image', path: '/a.png' },
    { input: 'end', role: 'end_image', path: '/b.png' },
  ];
  const between = comfyGraph(h3({ references: frames, parameters: { audio: false } }), {
    start: 'atelier/a.png',
    end: 'atelier/b.png',
  }).graph;
  linked(between);
  assert.equal(between.conditions.class_type, 'MiniMaxH3ImageToVideo');
  assert.deepEqual(
    [between.conditions.inputs.first_frame, between.conditions.inputs.last_frame],
    [
      ['start', 0],
      ['end', 0],
    ],
  );
  assert.equal(between.sound, undefined);
  assert.equal(between.video.inputs.audio, undefined);
});

test('upscales and smoothing: the source goes through the model, the longer side is held', () => {
  const image = job('realesrgan_image', {
    parameters: { max_side: 1500 },
    components: { upscaler: models + 'upscale_models\\RealESRGAN_x4plus.pth' },
    references: source('source_image'),
  });
  const still = comfyGraph(image, { source: 'atelier/in.png' }).graph;
  linked(still);
  assert.deepEqual(still.upscale.inputs, { upscale_model: ['upscaler', 0], image: ['source', 0] });
  assert.match(still.limitWidth.inputs.expression, /^a if max\(a, b\) <= 1500 else/);
  assert.deepEqual(still.save.inputs.images, ['limited', 0]);

  const film = job('realesrgan_video', {
    components: { upscaler: models + 'upscale_models\\RealESRGAN_x2plus.pth' },
    references: source('source_video'),
  });
  const moving = comfyGraph(film, { source: 'atelier/in.mp4' }).graph;
  linked(moving);
  assert.equal(moving.source.class_type, 'LoadVideo');
  // No limit asked: the frames go straight from the model to the video, at the source's rate and with its sound.
  assert.deepEqual(moving.video.inputs.images, ['upscale', 0]);
  assert.deepEqual(
    [moving.video.inputs.fps, moving.video.inputs.audio],
    [
      ['parts', 2],
      ['parts', 1],
    ],
  );

  const smoother = mode =>
    comfyGraph(
      job('rife', {
        parameters: { multiplier: 3, mode },
        components: { interpolator: models + 'frame_interpolation\\rife.safetensors' },
        references: source('source_video'),
      }),
      { source: 'atelier/in.mp4' },
    ).graph;
  const smooth = linked(smoother('smooth')),
    slow = linked(smoother('slow_motion'));
  assert.equal(smooth.interpolate.inputs.multiplier, 3);
  assert.equal(smooth.rate.inputs.expression, 'a * 3');
  assert.deepEqual(
    [smooth.video.inputs.fps, smooth.video.inputs.audio],
    [
      ['rate', 0],
      ['parts', 1],
    ],
  );
  // Slow motion: the same rate, three times as long, and no sound to stretch.
  assert.deepEqual([slow.video.inputs.fps, slow.video.inputs.audio, slow.rate], [['parts', 2], undefined, undefined]);

  const restore = job('seedvr2', {
    parameters: { seed: 9, scale: 2, passes: 2, steps: 2, color_correction: 'wavelet', max_side: 3000 },
    components: { model: models + 'diffusion_models\\seedvr.safetensors', vae: models + 'vae\\ema.safetensors' },
    references: source('source_image'),
  });
  const { graph: passes, steps } = comfyGraph(restore, { source: 'atelier/in.png' });
  linked(passes);
  assert.deepEqual(steps, ['sampler1', 'sampler2']);
  assert.equal(passes.enlarged1.inputs['resize_type.multiplier'], 2);
  // Only the last pass is held to the longest side asked.
  assert.equal(passes.longer2.inputs.expression, 'min(3000, round(max(a, b) * 2))');
  assert.deepEqual(passes.enlarged2.inputs.input, ['corrected1', 0]);
  assert.deepEqual(
    [passes.sampler1.inputs.seed, passes.sampler2.inputs.seed, passes.sampler2.inputs.steps],
    [9, 10, 2],
  );
  assert.equal(passes.corrected2.inputs.color_correction_method, 'wavelet');
  assert.deepEqual(passes.save.inputs.images, ['corrected2', 0]);
});

test('a video runs on ComfyUI and lands in the output folder like a built-in result', async t => {
  const fake = await comfy(t),
    dataDir = await trial(),
    outputDir = join(dataDir, 'output');
  await writeFile(join(dataDir, 'start.png'), png());
  const client = fake.connect(fake.baseUrl);
  // The same image as start frame and as subject is sent once.
  const references = [
    { input: 'start', role: 'start_image', path: join(dataDir, 'start.png') },
    { input: 'ref1', role: 'msr_image', path: join(dataDir, 'start.png') },
  ];
  const work = ltx({
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
  // LongForge reads its images in its own folder of ComfyUI's inputs.
  assert.deepEqual(
    fake.seen.uploads.map(sent => sent.subfolder),
    ['longforge_ltx25'],
  );
  const sent = fake.seen.prompts[0];
  assert.deepEqual(sent.partial_execution_targets, ['render']);
  assert.equal(sent.prompt.subject1.inputs.image, 'longforge_ltx25/' + fake.seen.uploads[0].name);
  assert.equal(JSON.parse(sent.prompt.project.inputs.scene_data)[0].ltx.start_file, sent.prompt.subject1.inputs.image);
  assert.equal(sent.prompt.audioVae.inputs.vae_name, 'LTX-2\\audio-vae.safetensors');
  assert.deepEqual(fake.seen.viewed, { filename: 'film_1.mp4', subfolder: 'atelier', type: 'output' });
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
  assert.deepEqual(await readFile(join(outputDir, output.filename)), mp4());
  const saved = JSON.parse(await readFile(join(outputDir, output.filename.replace('.mp4', '.json')), 'utf8'));
  assert.deepEqual([saved.metadata.backend, saved.metadata.frames, saved.metadata.fps], ['comfyui', 121, 24]);
  assert.equal(saved.metadata.comfy.promptId, 'prompt-1');
});

test('an image result takes its real size, and the prompt it was really made from', async t => {
  const fake = await comfy(t),
    dataDir = await trial(),
    client = fake.connect(fake.baseUrl);
  const promptExpansion = {
    template: '{{prompt}}',
    suffix: '',
    maxTokens: 64,
    temperature: 0.5,
    topK: 64,
    topP: 0.9,
    minP: 0.05,
    repetitionPenalty: 1.05,
    seed: 0,
  };
  const work = krea({ promptExpansion, parameters: { expandPrompt: true } });
  const made = await runOnComfy(work, {
    client,
    names: await comfyNames(client, work),
    outputDir: join(dataDir, 'output'),
  });
  assert.deepEqual(fake.seen.prompts[0].partial_execution_targets, ['save', 'promptText']);
  assert.match(made.outputs[0].filename, /^[0-9a-f]{32}\.png$/);
  assert.equal(made.metadata.parameters.prompt, 'un renard roux, en détail. Grain.');
  // The request is kept as it was asked.
  assert.equal(made.metadata.job.parameters.prompt, 'un renard');

  // An upscale: the size is the one of the file ComfyUI made, not a parameter.
  await writeFile(join(dataDir, 'small.png'), png(1024, 768));
  const upscale = job('realesrgan_image', {
    components: { upscaler: models + 'upscale_models\\RealESRGAN_x2plus.pth' },
    references: source('source_image', join(dataDir, 'small.png')),
  });
  const large = await runOnComfy(upscale, {
    client,
    names: await comfyNames(client, upscale),
    outputDir: join(dataDir, 'output'),
  });
  assert.deepEqual([large.outputs[0].width, large.outputs[0].height], [2048, 1536]);
  assert.deepEqual(fake.seen.uploads.at(-1).subfolder, 'atelier');
  assert.equal(fake.seen.prompts.at(-1).prompt.source.inputs.image, 'atelier/' + fake.seen.uploads.at(-1).name);
});

test('a video too long for ComfyUI to hold in memory stays on the built-in engine', async t => {
  const fake = await comfy(t),
    dataDir = await trial(fake.baseUrl);
  const film = (name, frames) =>
    writeFile(join(dataDir, name), mp4({ width: 1920, height: 1080, frames })).then(() => join(dataDir, name));
  const upscale = path =>
    job('realesrgan_video', {
      components: { upscaler: models + 'upscale_models\\RealESRGAN_x2plus.pth' },
      references: source('source_video', path),
    });
  const options = { connect: fake.connect };
  // 48 frames enlarged twice: 9 GiB held. 480 of them: 90 GiB, more than half of this memory.
  assert.ok(await comfyRoute(dataDir, upscale(await film('short.mp4', 48)), options));
  assert.equal(await comfyRoute(dataDir, upscale(await film('long.mp4', 480)), options), null);
  // A source that does not say its length (another container) is not risked either.
  await writeFile(join(dataDir, 'other.webm'), Buffer.from('1a45dfa3', 'hex'));
  assert.equal(await comfyRoute(dataDir, upscale(join(dataDir, 'other.webm')), options), null);
  const smooth = path =>
    job('rife', {
      parameters: { multiplier: 8 },
      components: { interpolator: models + 'frame_interpolation\\rife.safetensors' },
      references: source('source_video', path),
    });
  assert.ok(await comfyRoute(dataDir, smooth(join(dataDir, 'short.mp4')), options));
  assert.equal(await comfyRoute(dataDir, smooth(join(dataDir, 'long.mp4')), options), null);
});

test('the index of an MP4 gives its size, length and rate', async () => {
  const bytes = mp4({ width: 1152, height: 2048, frames: 241, fps: 48 });
  assert.deepEqual(mp4Bytes(bytes), { width: 1152, height: 2048, frames: 241, seconds: 241 / 48, fps: 48 });
  const dir = await mkdtemp(join(tmpdir(), 'comfy-engine-'));
  await writeFile(join(dir, 'film.mp4'), bytes);
  assert.deepEqual(await mp4Info(join(dir, 'film.mp4')), mp4Bytes(bytes));
  assert.equal(mp4Bytes(png()), null);
  assert.equal(await mp4Info(join(dir, 'absent.mp4')), null);
});

test('the generation service sends jobs to ComfyUI only while the trial is on', async t => {
  const fake = await comfy(t),
    dataDir = await trial(null),
    outputDir = join(dataDir, 'output');
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
  assert.equal(await service.backendNote(ltx()), null);
  let client = service.client();
  await client.preflight(ltx());
  assert.deepEqual((await client.run(ltx())).outputs, []);
  await client.free();
  assert.deepEqual(calls, ['preflight', 'generate', 'release']);
  assert.equal(fake.seen.prompts.length + fake.seen.freed, 0);

  await writeFile(join(dataDir, 'comfy-engine.json'), JSON.stringify({ enabled: true, baseUrl: fake.baseUrl }));
  assert.match(await service.backendNote(ltx()), /ComfyUI/);
  assert.match(await service.backendNote(krea()), /ComfyUI/);
  // A continuation still belongs to the built-in engine.
  const continuation = ltx({ references: source('source_video', '/x.mp4') });
  assert.equal(await service.backendNote(continuation), null);
  calls.length = 0;
  client = service.client();
  await client.preflight(continuation);
  await client.run(continuation);
  await client.free();
  assert.deepEqual(calls, ['preflight', 'generate', 'release']);
  assert.equal(fake.seen.prompts.length + fake.seen.freed, 0);

  for (const [work, extension] of [
    [ltx(), '.mp4'],
    [krea(), '.png'],
  ]) {
    calls.length = 0;
    client = service.client();
    await client.preflight(work);
    const result = await client.run(work);
    assert.equal(result.metadata.backend, 'comfyui');
    assert.ok(result.outputs[0].filename.endsWith(extension));
    await client.free();
    // The built-in engine checks the job and empties its memory; it does not generate.
    assert.deepEqual(calls, ['preflight', 'unload', 'release']);
  }
  assert.equal(fake.seen.freed, 2);
  assert.equal((await readdir(outputDir)).length, 4);

  // A ComfyUI that is not running is said before anything is unloaded.
  await writeFile(join(dataDir, 'comfy-engine.json'), JSON.stringify({ enabled: true, baseUrl: 'http://127.0.0.1:9' }));
  await assert.rejects(service.client().preflight(ltx()), /ComfyUI ne répond pas/);
});
