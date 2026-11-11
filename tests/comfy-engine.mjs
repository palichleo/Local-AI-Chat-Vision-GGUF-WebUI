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
import { mp4Bytes } from '../lib/video-info.mjs';

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
// Large enough for the two passes of an LTX video.
const large = { width: 896, height: 1600 };
const moss = (overrides = {}) =>
  job('moss', {
    ...overrides,
    parameters: {
      prompt: 'une affiche',
      negative_prompt: 'flou',
      seed: 3,
      width: 1024,
      height: 1536,
      steps: 50,
      cfg: 3,
      ...overrides.parameters,
    },
    components: {
      model: models + 'diffusion_models\\moss.safetensors',
      textEncoder: models + 'text_encoders\\moss-text.safetensors',
      vae: models + 'vae\\flux2-vae.safetensors',
    },
  });
const source = (role, path = '/source') => [{ input: 'source', role, path }];
const subjects = (count = 1) =>
  Array.from({ length: count }, (_, n) => ({ input: 'ref' + (n + 1), role: 'msr_image', path: `/s${n + 1}.png` }));
const msr = { id: 'msr', path: models + 'loras\\subjects\\msr.safetensors', strength: 1 };
const lists = {
  UNETLoader: [
    'unet_name',
    ['other.safetensors', 'ltx-transformer.safetensors', 'krea.safetensors', 'h3.safetensors', 'moss.safetensors'],
  ],
  CLIPLoader: ['clip_name', ['gemma.safetensors', 'qwen.safetensors', 'qwen32.safetensors', 'moss-text.safetensors']],
  VAELoader: [
    'vae_name',
    [
      'audio-vae.safetensors',
      'LTX-2\\audio-vae.safetensors',
      'video-vae.safetensors',
      'krea-vae.safetensors',
      'MiniMaxH3\\h3-vae.safetensors',
      'MiniMaxH3\\h3-audio.safetensors',
      'flux2-vae.safetensors',
    ],
  ],
  LongForgeLTXMSRReferences: ['lora_name', ['subjects\\msr.safetensors']],
  LoraLoaderModelOnly: ['lora_name', ['style.safetensors', 'detail.safetensors']],
  LatentUpscaleModelLoader: ['model_name', ['upscaler.safetensors', 'temporal.safetensors']],
};

/** A ComfyUI that knows every node but `missing`, lists `lists`, and answers a run with `film`. */
async function comfy(t, { missing = [], files = lists, result, ram = 32 * 1024 ** 3, available = ram / 2 } = {}) {
  const seen = { uploads: [], prompts: [], freed: [] };
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
        system: { ram_total: ram, ram_free: available },
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
      seen.freed.push(JSON.parse(body));
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

test('ComfyUI is used only when data/comfy-engine.json enables a loopback address', async () => {
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
  // Without it no job goes anywhere.
  assert.equal(await comfyRoute(await trial(null), ltx()), null);
});

test('what no graph is written for stays on the built-in engine', () => {
  for (const work of [ltx(), ltx({ parameters: { audio: false, fps: 30, frames: 17 } }), krea(), h3()])
    assert.equal(comfyUnsupported(work), '');
  assert.equal(comfyUnsupported(h3({ parameters: { audio: false } })), '');
  assert.match(comfyUnsupported(job('flux9')), /no ComfyUI graph/);
  assert.match(comfyUnsupported(ltx({ references: source('source_video') })), /continuations/);
  assert.match(comfyUnsupported(h3({ references: source('source_video') })), /continuations/);
  // With subject references the video goes through LongForge, which renders less freely.
  const withSubjects = parameters => ltx({ references: subjects(), loras: [msr], parameters });
  assert.equal(comfyUnsupported(withSubjects()), '');
  assert.match(comfyUnsupported(withSubjects({ audio: false })), /sound/);
  assert.match(comfyUnsupported(withSubjects({ fps: 30 })), /24/);
  assert.match(comfyUnsupported(withSubjects({ frames: 17 })), /one second/);
  assert.match(comfyUnsupported(ltx({ references: subjects(3), loras: [msr] })), /two subject/);
  // What the built-in engine refuses with its own words is left to it.
  const mixed = [
    { input: 'start', role: 'start_image', path: '/a.png' },
    { input: 'subject-1', role: 'reference_image', path: '/b.png' },
  ];
  assert.match(comfyUnsupported(h3({ references: mixed })), /do not combine/);
  // Upscaling and interpolation are the built-in engine's: no graph, whatever is asked.
  for (const family of ['realesrgan_image', 'realesrgan_video', 'rife', 'seedvr2'])
    assert.match(comfyUnsupported(job(family, { references: source('source_video') })), /no ComfyUI graph/);
  assert.equal(comfyUnsupported(moss()), '');
});

test('model files take the names ComfyUI lists them under, and every node of the graph is checked', async t => {
  const fake = await comfy(t);
  assert.deepEqual(await comfyNames(fake.connect(fake.baseUrl), ltx({ loras: [msr], references: subjects() })), {
    model: 'ltx-transformer.safetensors',
    textEncoder: 'gemma.safetensors',
    vae: 'video-vae.safetensors',
    // The entry of the sub-folder the file really is in, not its namesake.
    audioVae: 'LTX-2\\audio-vae.safetensors',
    lora: 'subjects\\msr.safetensors',
  });
  // Without a subject: ComfyUI's own nodes, the latent upscaler for the two passes of a large size.
  assert.equal(
    (await comfyNames(fake.connect(fake.baseUrl), ltx({ parameters: large }))).upscaler,
    'upscaler.safetensors',
  );
  assert.equal((await comfyNames(fake.connect(fake.baseUrl), ltx())).upscaler, undefined);
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

test('LTX with subject references: the LongForge graph carries the prompt, seed, size, length and images', () => {
  const lora = { id: 'msr', path: models + 'loras\\msr.safetensors', strength: 0.95 };
  const one = comfyGraph(ltx({ references: subjects(), loras: [lora] }), { ref1: 'in/c.png' });
  linked(one.graph);
  assert.equal(one.output, 'render');
  assert.equal(one.graph.project.inputs.project_name, 'atelier_5b1f6f0e6f0c4b659d3b0c3f3a8f7a11');
  assert.deepEqual(JSON.parse(one.graph.project.inputs.scene_data), [{ name: 'Scene 1', prompt: 'un bateau fantôme' }]);
  assert.deepEqual(
    [one.graph.video.inputs.width, one.graph.video.inputs.height, one.graph.video.inputs.new_seconds],
    [576, 1024, 5],
  );
  assert.equal(one.graph.sampling.inputs.seed, 1075036270707423);
  assert.equal(one.graph.model.inputs.unet_name, 'ltx-transformer.safetensors');

  const references = [
    { input: 'start', role: 'start_image', path: '/a.png' },
    { input: 'end', role: 'end_image', path: '/b.png' },
    ...subjects(2),
  ];
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

test('LTX: a large video is sampled at half size, enlarged, then refined; a small one in one pass', () => {
  const { graph, output, steps } = comfyGraph(ltx({ parameters: large }));
  linked(graph);
  assert.equal(output, 'save');
  assert.deepEqual(steps, [
    ['sampler1', 8],
    ['sampler2', 3],
  ]);
  assert.deepEqual(graph.empty.inputs, { width: 448, height: 800, length: 121, batch_size: 1 });
  assert.deepEqual(graph.enlarged.inputs.samples, ['parts1', 0]);
  // The sound follows the picture from one pass to the next.
  assert.deepEqual(graph.joined2.inputs, { video_latent: ['enlarged', 0], audio_latent: ['parts1', 1] });
  assert.deepEqual(
    [graph.sigmas1.inputs.sigmas.split(',').length, graph.sigmas2.inputs.sigmas],
    [9, '0.909375, 0.725, 0.421875, 0.0'],
  );
  assert.deepEqual(
    [graph.noise1.inputs.noise_seed, graph.noise2.inputs.noise_seed],
    [1075036270707423, 1075036270707424],
  );
  assert.equal(graph.positive.inputs.text, 'un bateau fantôme');
  assert.deepEqual(graph.decode.inputs.samples, ['parts2', 0]);
  assert.deepEqual(graph.video.inputs.audio, ['sound', 0]);

  // One pass: a size where two would be slower, one whose half the model does not take, or no latent upscaler.
  for (const parameters of [
    { width: 576, height: 1024 },
    { width: 928, height: 1632 },
  ]) {
    const small = comfyGraph(ltx({ parameters }));
    assert.deepEqual(
      [small.steps, small.graph.enlarged, small.graph.empty.inputs.width],
      [['sampler1'], undefined, parameters.width],
    );
    assert.deepEqual(linked(small.graph).decode.inputs.samples, ['parts1', 0]);
  }
  const bare = ltx({ parameters: large });
  delete bare.components.upscaler;
  assert.deepEqual(comfyGraph(bare).steps, ['sampler1']);

  // A start image is written into the first frame: followed in the first pass, held in the second.
  const start = [{ input: 'start', role: 'start_image', path: '/a.png' }];
  const animated = linked(comfyGraph(ltx({ references: start, parameters: large }), { start: 'atelier/a.png' }).graph);
  assert.deepEqual(animated.startFitted.inputs['resize_type.width'], 896);
  assert.equal(animated.startImage.inputs.img_compression, 12);
  assert.deepEqual([animated.started1.inputs.strength, animated.started2.inputs.strength], [0.8, 1]);
  assert.deepEqual(animated.started2.inputs.latent, ['enlarged', 0]);

  // With an end image both are guides, taken out of the latent after each pass.
  const ends = [...start, { input: 'end', role: 'end_image', path: '/b.png' }];
  const between = linked(
    comfyGraph(ltx({ references: ends, parameters: { ...large, audio: false } }), { start: 'a', end: 'b' }).graph,
  );
  assert.deepEqual(
    [between.startGuide1.inputs.frame_idx, between.endGuide1.inputs.frame_idx, between.endGuide2.inputs.strength],
    [0, -1, 0.6],
  );
  assert.deepEqual(between.guider1.inputs.positive, ['endGuide1', 0]);
  assert.deepEqual(between.enlarged.inputs.samples, ['cropped1', 2]);
  assert.deepEqual(between.decode.inputs.samples, ['cropped2', 2]);
  // Silent on request: the model still makes its sound, the video is saved without it.
  assert.deepEqual([between.sound, between.video.inputs.audio], [undefined, undefined]);

  const styled = comfyGraph(
    ltx({ parameters: large, loras: [{ id: 'style', path: 'E:\\loras\\style.safetensors', strength: 0.4 }] }),
  ).graph;
  assert.deepEqual(linked(styled).guider2.inputs.model, ['lora0', 0]);
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

test('MOSS Image: the prompt and its negative, a late layer skipped for half the steps', () => {
  const { graph, output, steps } = comfyGraph(moss());
  linked(graph);
  assert.deepEqual([output, steps], ['save', ['sampler']]);
  assert.equal(graph.clip.inputs.type, 'moss_image');
  assert.deepEqual([graph.positive.inputs.text, graph.negative.inputs.text], ['une affiche', 'flou']);
  assert.deepEqual(graph.latent, {
    class_type: 'EmptyFlux2LatentImage',
    inputs: { width: 1024, height: 1536, batch_size: 1 },
  });
  assert.deepEqual(graph.model.inputs, {
    model: ['loaded', 0],
    double_layers: '',
    single_layers: '22',
    start_percent: 0,
    end_percent: 0.5,
  });
  assert.deepEqual(
    Object.fromEntries(
      ['seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'model'].map(k => [k, graph.sampler.inputs[k]]),
    ),
    { seed: 3, steps: 50, cfg: 3, sampler_name: 'euler', scheduler: 'normal', model: ['model', 0] },
  );
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

  // The size is the one of the file ComfyUI made (2048 × 1536 here), whatever was asked.
  assert.deepEqual([made.outputs[0].width, made.outputs[0].height], [2048, 1536]);
});

test('steps are counted over every pass, then the decoding is said once', async () => {
  const dataDir = await trial(),
    seen = [];
  const client = {
    run: async (graph, { onProgress }) => {
      const step = (node, value, max) => onProgress({ state: 'step', node, value, max });
      onProgress({ state: 'queued' });
      for (let value = 1; value <= 8; value++) step('sampler1', value, 8);
      step('enlarged', 1, 1);
      for (let value = 1; value <= 3; value++) step('sampler2', value, 3);
      for (let value = 1; value <= 4; value++) step('decode', value, 4);
      return { promptId: 'p', outputs: [{ filename: 'f.mp4', subfolder: 'atelier', type: 'output' }] };
    },
    original: async () => ({ bytes: mp4(), mime: 'video/mp4' }),
  };
  await runOnComfy(ltx({ parameters: large }), {
    client,
    names: {},
    outputDir: join(dataDir, 'output'),
    onProgress: value => seen.push(value.step ? `${value.step}/${value.total}` : value.stage),
  });
  assert.deepEqual(seen, [
    'sending to ComfyUI',
    'sampling video',
    ...Array.from({ length: 10 }, (_, index) => `${index + 1}/11`),
    'decoding video',
    'audio decoded',
  ]);
});

test('the index of an MP4 gives its size, length and rate', async () => {
  const bytes = mp4({ width: 1152, height: 2048, frames: 241, fps: 48 });
  assert.deepEqual(mp4Bytes(bytes), { width: 1152, height: 2048, frames: 241, seconds: 241 / 48, fps: 48 });
  assert.equal(mp4Bytes(png()), null);
});

test('the generation service: ComfyUI for its families, the built-in engine for the others', async t => {
  const fake = await comfy(t),
    dataDir = await trial(null),
    outputDir = join(dataDir, 'output');
  const calls = [];
  const ready = { ready: true, reason: '' };
  const worker = {
    // The built-in engine answers for the families it runs itself.
    status: () => ({
      state: 'ready',
      busy: false,
      capabilities: { ltx25: { ...ready, mediaType: 'video' }, rife: { ...ready, mediaType: 'video' } },
    }),
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
    environment: { close: async () => {}, status: () => ({ state: 'ready' }) },
    comfyConnect: fake.connect,
  });
  const available = async () => {
    await service.refreshComfy();
    service.syncCapabilities();
    return Object.fromEntries(
      Object.entries(service.catalog.capabilities).map(([name, capability]) => [name, capability.ready]),
    );
  };

  // ComfyUI not set: its own families cannot run, LTX still can on the built-in engine.
  assert.deepEqual(await available(), { ltx25: true, rife: true, krea2: false, moss: false });
  assert.match(service.catalog.capabilities.krea2.reason, /ComfyUI n’est pas configuré/);
  let client = service.client();
  await client.preflight(ltx());
  assert.deepEqual((await client.run(ltx())).outputs, []);
  await client.free();
  assert.deepEqual(calls, ['preflight', 'generate', 'release']);
  await assert.rejects(service.client().preflight(krea()), /ComfyUI n’est pas configuré/);
  assert.equal(fake.seen.prompts.length + fake.seen.freed.length, 0);

  // Set from the settings: an address on this machine, or nothing is saved.
  await assert.rejects(service.saveComfy({ enabled: true, baseUrl: 'http://example.com:8188' }), /Adresse ComfyUI/);
  const saved = await service.saveComfy({ enabled: true, baseUrl: fake.baseUrl + '/' });
  assert.deepEqual(saved.comfy, { enabled: true, baseUrl: fake.baseUrl + '/', reachable: true, version: '' });
  assert.deepEqual(await available(), { ltx25: true, rife: true, krea2: true, minimax_h3: true, moss: true });

  // A continuation still belongs to the built-in engine, which gets the memory ComfyUI kept.
  const continuation = ltx({ references: source('source_video', '/x.mp4') });
  calls.length = 0;
  client = service.client();
  await client.preflight(continuation);
  await client.run(continuation);
  await client.free();
  assert.deepEqual(calls, ['preflight', 'generate', 'release']);
  assert.equal(fake.seen.prompts.length, 0);
  assert.deepEqual(fake.seen.freed.splice(0), [{ unload_models: true, free_memory: true }]);

  // Interpolation and upscaling never go to ComfyUI, and leave it its models: they are light.
  const smooth = job('rife', { parameters: { multiplier: 2 }, references: source('source_video', '/x.mp4') });
  calls.length = 0;
  client = service.client();
  await client.preflight(smooth);
  await client.run(smooth);
  await client.free();
  assert.deepEqual(calls, ['preflight', 'generate', 'release']);
  assert.equal(fake.seen.prompts.length + fake.seen.freed.length, 0);

  for (const [work, extension] of [
    [ltx(), '.mp4'],
    [krea(), '.png'],
    [moss(), '.png'],
  ]) {
    calls.length = 0;
    client = service.client();
    await client.preflight(work);
    const result = await client.run(work);
    assert.equal(result.metadata.backend, 'comfyui');
    assert.ok(result.outputs[0].filename.endsWith(extension));
    await client.free();
    // The built-in engine is not asked anything but to leave memory, if it holds any.
    assert.deepEqual(calls, ['unload', 'release']);
  }
  // The video memory is given back each time; the models stay in main memory while there is room.
  assert.deepEqual(fake.seen.freed, Array(3).fill({ unload_models: true }));
  assert.equal((await readdir(outputDir)).length, 6);

  // On a machine short of memory, ComfyUI lets go of everything.
  const tight = await comfy(t, { available: 1024 ** 3 });
  await service.saveComfy({ enabled: true, baseUrl: tight.baseUrl });
  client = service.client();
  await client.preflight(krea());
  await client.free();
  assert.deepEqual(tight.seen.freed, [{ unload_models: true }, { unload_models: true, free_memory: true }]);

  // A ComfyUI that is not running: said in the settings, and before anything is unloaded.
  const stopped = await service.saveComfy({ enabled: true, baseUrl: 'http://127.0.0.1:9' });
  assert.equal(stopped.comfy.reachable, false);
  await assert.rejects(service.client().preflight(ltx()), /ComfyUI ne répond pas/);
  // Switched off: the address is kept, the families are ComfyUI's no more.
  const off = await service.saveComfy({ enabled: false, baseUrl: 'http://127.0.0.1:9' });
  assert.deepEqual([off.comfy.enabled, off.comfy.baseUrl], [false, 'http://127.0.0.1:9']);
  assert.equal((await available()).krea2, false);
});
