import test from 'node:test';
import assert from 'node:assert/strict';
import { STUDIO_ID, STUDIO_VERBS, styleLine, styleMessages } from '../lib/studio.mjs';
import { ToolRuntime, checkStyles } from '../lib/tool-runtime.mjs';
import { comfyGraph } from '../lib/comfy-graphs.mjs';
import { comfyNames } from '../lib/comfy-engine.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../server.mjs';

test('a style is asked as one short line, from the description or from random starting points', () => {
  const [system, user] = styleMessages('  affiche soviétique  ', 'image');
  assert.match(system.content, /one line only/);
  assert.match(system.content, /30 words at most/);
  assert.match(user.content, /affiche soviétique$/);
  const [, first] = styleMessages('', 'image');
  assert.match(first.content, /^Invent a distinctive style/);
  const seen = new Set(Array.from({ length: 12 }, () => styleMessages('', 'video')[1].content));
  assert.ok(seen.size > 1, 'an empty box does not always get the same style');
  assert.match(styleMessages('', 'video')[0].content, /footage/);
});

test('the answer is kept as one clean line', () => {
  assert.equal(
    styleLine('<think>hmm</think>\n"Style: gouache, muted palette,\nsoft light"\n'),
    'gouache, muted palette, soft light',
  );
  assert.equal(styleLine('x'.repeat(900)).length, 400);
  assert.equal(styleLine(null), '');
});

test('the Studio has its own identifier and the verbs it may start', () => {
  assert.match(STUDIO_ID, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  for (const verb of ['create_image', 'create_video', 'extend_video', 'create_audio'])
    assert.ok(STUDIO_VERBS.includes(verb));
});

test('style LoRAs: four at most, a name and a strength within limits', () => {
  assert.deepEqual(checkStyles([{ name: 'a.safetensors' }, { name: 'sub\\b.safetensors', strength: 0.5 }]), [
    { name: 'a.safetensors', strength: 1 },
    { name: 'sub\\b.safetensors', strength: 0.5 },
  ]);
  assert.throws(() => checkStyles([{ name: '' }]), /Style invalide/);
  assert.throws(() => checkStyles([{ name: 'a', strength: 9 }]), /Style invalide/);
  assert.throws(() => checkStyles(Array(5).fill({ name: 'a' })), /quatre/);
});

const krea = styles => ({
  id: '00000000-0000-4000-8000-000000000000',
  pipeline: 'krea2',
  mediaType: 'image',
  references: [],
  loras: [],
  styles,
  parameters: { prompt: 'un renard', seed: 1, width: 1024, height: 1024, steps: 8, attention: 'comfy_kitchen' },
  components: { model: 'm/krea.safetensors', textEncoder: 'm/qwen.safetensors', vae: 'm/vae.safetensors' },
});

test('the styles of a Studio job are LoRA nodes between the model and the sampler, under ComfyUI’s names', async () => {
  const styles = [
    { name: '70sSCiFiKrea2Raw.safetensors', strength: 0.55 },
    { name: 'krea2_detail_slider.safetensors', strength: 0.2 },
  ];
  const { graph } = comfyGraph(krea(styles));
  assert.deepEqual(graph.style0.inputs, { lora_name: styles[0].name, strength_model: 0.55, model: ['model', 0] });
  assert.deepEqual(graph.style1.inputs.model, ['style0', 0]);
  assert.deepEqual(graph.attention.inputs.model, ['style1', 0]);
  assert.deepEqual(graph.sampler.inputs.model, ['attention', 0]);
  assert.equal(comfyGraph(krea(undefined)).graph.style0, undefined);

  const lists = {
    UNETLoader: ['unet_name', ['krea.safetensors']],
    CLIPLoader: ['clip_name', ['qwen.safetensors']],
    VAELoader: ['vae_name', ['vae.safetensors']],
    LoraLoaderModelOnly: ['lora_name', ['styles\\70sSCiFiKrea2Raw.safetensors', 'krea2_detail_slider.safetensors']],
  };
  const client = {
    objectInfo: async ({ node }) => ({
      [node]: { input: { required: lists[node] ? { [lists[node][0]]: [lists[node][1], {}] } : {} } },
    }),
  };
  const names = await comfyNames(client, krea(styles));
  assert.equal(names.style0, 'styles\\70sSCiFiKrea2Raw.safetensors');
  assert.equal(names.style1, 'krea2_detail_slider.safetensors');
  await assert.rejects(comfyNames(client, krea([{ name: 'absent.safetensors', strength: 1 }])), /absent\.safetensors/);
});

test('the Studio is told, per verb, the ready workflows with their inputs, sizes, lengths and settings', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { ToolCatalog } = await import('../lib/tool-catalog.mjs');
  const folder = new URL('../runner/workflows/', import.meta.url);
  const workflows = [];
  for (const name of await readdir(folder))
    workflows.push({ ...JSON.parse(await readFile(new URL(name, folder), 'utf8')), ready: true });
  const tools = await new ToolCatalog({ list: async () => workflows }).studio();
  const named = (verb, name) => tools[verb].find(item => item.name.startsWith(name));

  const krea = named('create_image', 'Krea 2');
  assert.deepEqual(krea.size, { width: 1024, height: 1024 });
  assert.equal(krea.limits.width.max, 4096);
  assert.equal(krea.roles.source.count, 1);

  const h3 = named('create_video', 'MiniMax');
  assert.deepEqual(h3.size, { width: 768, height: 448 });
  assert.deepEqual(h3.final, { width: 1344, height: 768 });
  assert.deepEqual([h3.roles.start_image.count, h3.roles.end_image.count, h3.roles.reference.count], [1, 1, 3]);
  assert.ok(Math.abs(h3.lengths.seconds[0] - 124 / 24) < 1e-9);
  assert.ok(h3.exclusive);

  const ltx = named('create_video', 'LTX');
  assert.ok(ltx.lengths.seconds.includes(5) || ltx.lengths.seconds.some(s => Math.abs(s - 121 / 24) < 1e-9));
  const more = named('extend_video', 'MiniMax');
  assert.equal(more.roles.source.count, 1);
  // 141 frames with 22 taken from the source: 119 new ones.
  assert.ok(more.lengths.seconds.some(s => Math.abs(s - 119 / 24) < 1e-9));

  const music = named('create_audio', 'Musique');
  assert.deepEqual(music.settings.map(item => item.key).sort(), ['language', 'lyrics', 'seconds']);
  assert.match(music.for, /music/);
  assert.equal(named('create_audio', 'Bruitages').settings.find(item => item.key === 'seconds').max, 30);
});

test('the page module loads, adds the style to the prompt and offers the sizes of a format', async () => {
  const { sizeChoices, withStyle } = await import('../public/studio.mjs');
  assert.equal(withStyle(' un renard ', ' gouache, palette sourde '), 'un renard\n\nStyle: gouache, palette sourde');
  assert.equal(withStyle('un renard', '  '), 'un renard');
  const limits = { width: { min: 256, max: 2048, multipleOf: 32 }, height: { min: 256, max: 2048, multipleOf: 32 } };
  const { sizes, nearest } = sizeChoices({ limits }, '16:9', 768 * 448);
  assert.ok(sizes.length > 2);
  assert.ok(sizes.every(size => size.width > size.height && size.width % 32 === 0 && size.height % 32 === 0));
  assert.ok(Math.abs(nearest.width * nearest.height - 768 * 448) < 768 * 448 * 0.4);
});

test('the format frame keeps the ratio and fits its box, wide or tall', async () => {
  const { frameSize } = await import('../public/studio.mjs');
  const box = { width: 264, height: 176 };
  assert.deepEqual(frameSize(16 / 9, box), { width: 264, height: 149 });
  assert.deepEqual(frameSize(9 / 16, box), { width: 99, height: 176 });
  assert.deepEqual(frameSize(1, box), { width: 176, height: 176 });
  for (const ratio of [16 / 9, 4 / 3, 3 / 2, 1, 2 / 3, 3 / 4, 9 / 16]) {
    const size = frameSize(ratio, box);
    assert.ok(size.width <= box.width && size.height <= box.height);
    assert.ok(Math.abs(size.width / size.height / ratio - 1) < 0.02);
  }
});

test('a style the model does not write in time is said as such, and the model is free again', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-style-'));
  const app = await createApplication({
    port: 0,
    dataDir: directory,
    styleTimeoutMs: 400,
    spawnProcess: (_command, args, options) =>
      spawn(process.execPath, [fileURLToPath(new URL('./fixtures/fake-engine.mjs', import.meta.url)), ...args], options),
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { token } = await (await fetch(app.url + '/api/bootstrap?brief=1')).json();
  const api = (route, body) =>
    fetch(app.url + '/api/' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const modelPath = join(directory, 'model.gguf');
  await writeFile(modelPath, Buffer.from('GGUF\x03\0\0\0'));
  await api('config', {
    enginePath: process.execPath,
    modelPath,
    projectorPath: '',
    contextSize: 4096,
    maxOutputTokens: 1024,
    gpuLayers: 0,
  });
  assert.equal((await api('start', {})).status, 202);
  for (let tries = 0; tries < 200 && (await (await api('status')).json()).state !== 'ready'; tries++)
    await new Promise(resolve => setTimeout(resolve, 25));
  // The simulated engine never finishes this one, like a model crawling on a shared graphics card.
  const late = await api('studio/style', { description: 'aquarelle, sans réponse', media: 'image' });
  assert.equal(late.status, 504);
  assert.match((await late.json()).error, /n’a pas répondu en 0 secondes.*carte graphique/);
  const status = await (await api('status')).json();
  assert.deepEqual([status.state, status.busy], ['ready', false]);
});

test('the workflows are listed once for a whole answer, whatever the number of verbs', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { ToolCatalog } = await import('../lib/tool-catalog.mjs');
  const folder = new URL('../runner/workflows/', import.meta.url);
  const workflows = [];
  for (const name of await readdir(folder))
    workflows.push({ ...JSON.parse(await readFile(new URL(name, folder), 'utf8')), ready: true });
  // Each listing checks the files of every workflow: 0.6 s on the machine it was measured on.
  let listed = 0;
  const tools = new ToolCatalog({
    list: async () => {
      listed++;
      return workflows;
    },
  });
  const studio = await tools.studio();
  assert.equal(listed, 1, 'the Studio');
  assert.ok(studio.create_image.length && studio.create_video.length);
  listed = 0;
  const offered = await tools.definitions({ images: 0, resources: [], outputs: [] });
  assert.equal(listed, 1, 'the tools offered to the model');
  assert.ok(offered.length > 1);
  listed = 0;
  assert.ok((await tools.actions()).upscale.length);
  assert.equal(listed, 1, 'the buttons under a creation');
});

test('each banner shows the last creation of its mode and how many there are', async () => {
  const { showcased } = await import('../public/studio.mjs');
  const run = (mediaType, url) => ({ ...(mediaType ? { mediaType } : {}), outputs: [{ originalUrl: url }] });
  const nothing = { count: '', latest: null, small: null, record: null };
  assert.deepEqual(showcased([]), { image: nothing, video: nothing, audio: nothing });
  // Newest first, as the gallery gives them; a record without a type is an image.
  const clip = { mediaType: 'video', outputs: [{ originalUrl: '/v2', thumbUrl: '/v2.jpg' }] },
    picture = run(undefined, '/i3');
  const shown = showcased([clip, picture, run('image', '/i2'), run('video', '/v1'), run('audio', '/a1')]);
  // Without a thumbnail the original is shown, and its record is there to make one from.
  assert.deepEqual(shown.image, { count: '2 images', latest: '/i3', small: null, record: picture });
  // With one, a clip is shown as a picture too: nothing of the video is loaded.
  assert.deepEqual(shown.video, { count: '2 clips', latest: '/v2', small: '/v2.jpg', record: clip });
  // A sound has no picture: its number only.
  assert.deepEqual(shown.audio, { count: '1 son', latest: null, small: null, record: null });
});

test('leaving a mode stops following the size of its frame', async () => {
  // Just enough of a page for the Studio to draw itself.
  class Element {
    children = [];
    style = {};
    dataset = {};
    classList = { toggle() {}, add() {} };
    append(...nodes) {
      this.children.push(...nodes);
    }
    replaceChildren(...nodes) {
      this.children = nodes;
    }
    add(option) {
      this.children.push(option);
    }
    setAttribute() {}
    querySelector() {
      return new Element();
    }
    querySelectorAll() {
      return [];
    }
  }
  const page = Object.fromEntries(
    ['studio-view', 'studio-modes', 'studio-back', 'studio-title', 'studio-summary', 'studio-body'].map(id => [
      id,
      new Element(),
    ]),
  );
  const observers = [];
  const globals = {
    document: { getElementById: id => page[id] ?? null, querySelector: () => null },
    Option: class {},
    ResizeObserver: class {
      constructor(callback) {
        Object.assign(this, { callback, watched: null });
        observers.push(this);
      }
      observe(target) {
        this.watched = target;
      }
      disconnect() {
        this.watched = null;
      }
    },
  };
  const before = Object.fromEntries(Object.keys(globals).map(key => [key, globalThis[key]]));
  Object.assign(globalThis, globals);
  try {
    const { setupStudio } = await import('../public/studio.mjs');
    const limits = { width: { min: 256, max: 2048, multipleOf: 32 }, height: { min: 256, max: 2048, multipleOf: 32 } };
    const info = {
      enabled: true,
      conversationId: STUDIO_ID,
      styles: [],
      tools: {
        create_image: [
          { id: 'w', name: 'Image', roles: {}, limits, size: { width: 1024, height: 1024 }, settings: [], seeded: true },
        ],
      },
    };
    const studio = setupStudio({
      api: async route => ({ json: async () => (route === 'studio' ? info : { runs: [] }) }),
      node: () => new Element(),
      icon: () => new Element(),
      notice() {},
      assets: {},
      viewOutput() {},
      waitForModel: async () => {},
      blocked: () => '',
      onChange() {},
    });
    await studio.open();
    const [image] = page['studio-modes'].children;
    image.onclick();
    const following = observers.at(-1);
    assert.ok(following.watched, 'the frame follows its stage while the mode is open');
    page['studio-back'].onclick();
    assert.equal(page['studio-body'].dataset.mode, '');
    // Still watched, the stage was reported once more as it left, and no mode had a format to read.
    assert.equal(following.watched, null);
    assert.ok(observers.every(observer => !observer.watched));
  } finally {
    Object.assign(globalThis, before);
  }
});

/** A runtime with one image workflow, a chat model and a generator that only note what they are asked. */
function handover({ keepMs, fails = false, onRun } = {}) {
  const turn = 'a1111111-1111-4111-8111-111111111111';
  const workflow = {
    schemaVersion: 1,
    id: 'image',
    name: 'Image',
    description: '',
    digest: 'a'.repeat(64),
    mediaType: 'image',
    pipeline: 'krea2',
    enabled: true,
    ready: true,
    parameters: { prompt: { policy: 'model', type: 'string' } },
    references: [],
  };
  const events = [];
  const engine = {
    busy: false,
    state: 'ready',
    stop: async () => {
      events.push('llm stopped');
      engine.state = 'stopped';
    },
    start: async () => {
      events.push('llm started');
      engine.state = 'ready';
    },
  };
  const runtime = new ToolRuntime({
    engine,
    ...(keepMs ? { keepMs } : {}),
    catalog: {
      list: async () => [workflow],
      read: async () => workflow,
      prepare: async () => ({
        workflow,
        job: {
          schemaVersion: 1,
          id: turn,
          pipeline: 'krea2',
          mediaType: 'image',
          workflowId: 'image',
          workflowDigest: workflow.digest,
          parameters: { prompt: 'boat', seed: 1, width: 512, height: 512 },
          components: {},
          loras: [],
          references: [],
        },
        outputNodes: [],
      }),
    },
    gallery: { put: async record => record },
    getConfig: () => ({ enabled: true, autoAllow: false, maxIterations: 5, baseUrl: 'native' }),
    engineConfig: () => ({}),
    clientFactory: () => ({
      status: async () => ({ idle: true }),
      preflight: async () => {},
      run: async (job, options) => {
        events.push('generate');
        await onRun?.(options);
        if (fails) throw Error('Mémoire vidéo insuffisante.');
        return { outputs: [{ filename: 'image.png', subfolder: '', type: 'output' }] };
      },
      free: async options => events.push(options?.keep ? 'sources removed' : 'gpu released'),
    }),
  });
  /** One image asked from this conversation, run to its end. */
  async function create(conversationId) {
    const request = await runtime.request(
      [{ id: 'call', type: 'function', function: { name: 'create_image', arguments: '{"prompt":"boat"}' } }],
      { conversationId, turnId: turn, messages: [] },
    );
    await runtime.execute({ requestId: request.requestId, permission: 'once' });
    await runtime.finished;
    return runtime.status();
  }
  return { runtime, events, create, turn };
}

test('a Studio generation unloads the chat model and leaves it unloaded; a conversation gets it back', async () => {
  for (const studio of [true, false]) {
    const { runtime, events, create, turn } = handover();
    const status = await create(studio ? STUDIO_ID : turn);
    assert.equal(status.state, 'done', status.error);
    assert.deepEqual(
      events,
      studio
        ? // The generator stays loaded for the next creation: only the copies of the sources go.
          ['llm stopped', 'generate', 'sources removed']
        : ['llm stopped', 'generate', 'gpu released', 'llm started'],
    );
    // The chat model is wanted (a message, a style): the card is given back first, once.
    events.length = 0;
    assert.equal(await runtime.yieldGpu(), studio);
    assert.deepEqual(events, studio ? ['gpu released'] : []);
    assert.equal(await runtime.yieldGpu(), false);
    await runtime.close();
  }
});

test('the generator a Studio creation left loaded gives the card back by itself after a while', async () => {
  const { runtime, events, create } = handover({ keepMs: 40 });
  await create(STUDIO_ID);
  await create(STUDIO_ID);
  // Two creations in a row: nothing was unloaded between them.
  assert.deepEqual(events, ['llm stopped', 'generate', 'sources removed', 'llm stopped', 'generate', 'sources removed']);
  events.length = 0;
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.deepEqual(events, ['gpu released']);
  assert.equal(await runtime.yieldGpu(), false);
  await runtime.close();
});

test('a failed Studio creation, a conversation or closing give the whole card back', async () => {
  // A failure may have left the card full: nothing is kept after it.
  const failed = handover({ fails: true });
  const status = await failed.create(STUDIO_ID);
  assert.equal(status.state, 'error');
  assert.deepEqual(failed.events, ['llm stopped', 'generate', 'gpu released']);
  assert.equal(await failed.runtime.yieldGpu(), false);
  await failed.runtime.close();

  // A creation asked in a conversation ends with the chat model back: what the Studio left
  // loaded leaves before it, with the generator of that creation.
  const mixed = handover();
  await mixed.create(STUDIO_ID);
  mixed.events.length = 0;
  await mixed.create(mixed.turn);
  assert.deepEqual(mixed.events, ['llm stopped', 'generate', 'gpu released', 'gpu released', 'llm started']);
  await mixed.runtime.close();

  // Closing the application does not leave the generator holding the card.
  const closed = handover();
  await closed.create(STUDIO_ID);
  closed.events.length = 0;
  await closed.runtime.close();
  assert.deepEqual(closed.events, ['gpu released']);
});

test('the picture the generator has so far is kept one at a time, and dropped with the job', async () => {
  const first = { bytes: Buffer.from([0xff, 0xd8, 0xff, 1]), mime: 'image/jpeg' },
    second = { bytes: Buffer.from([0xff, 0xd8, 0xff, 2]), mime: 'image/jpeg' };
  let during;
  const { runtime, create } = handover({
    onRun: ({ onProgress }) => {
      onProgress({ stage: 'generating', step: 1, total: 8 });
      const before = runtime.status();
      onProgress({ preview: first });
      onProgress({ preview: second });
      const { id, preview, progress } = runtime.status();
      during = { before: before.preview, preview, progress, kept: runtime.preview(id), other: runtime.preview('x') };
    },
  });
  const status = await create(STUDIO_ID);
  // Its number only goes with the status; the bytes are asked for apart, for this job alone.
  assert.equal(during.before, undefined);
  assert.equal(during.preview, 2);
  assert.deepEqual(during.kept, { ...second, seq: 2 });
  assert.equal(during.other, null);
  // A picture is not a stage of the work: the progress line is not touched by it.
  assert.doesNotMatch(String(during.progress), /preview|object/i);
  // Once the creation is there, nothing of it stays in memory.
  assert.equal(status.preview, undefined);
  assert.equal(runtime.preview(status.id), null);
  await runtime.close();
});

test('the last creation of a visit stays in the frame, and a new visit starts from an empty frame', async () => {
  // A page that remembers what each element is, so the frame can be looked into.
  class Element {
    constructor(tag = '', className = '') {
      Object.assign(this, { tag, className, children: [], style: {}, dataset: {} });
      this.classList = { toggle() {}, add() {}, remove() {} };
    }
    append(...nodes) {
      this.children.push(...nodes);
    }
    replaceChildren(...nodes) {
      this.children = nodes;
    }
    add(option) {
      this.children.push(option);
    }
    setAttribute() {}
    querySelector() {
      return new Element();
    }
    querySelectorAll() {
      return [];
    }
    /** Every element under this one whose classes include `name`. */
    find(name) {
      return this.children.flatMap(child =>
        child instanceof Element
          ? [...(child.className.split(' ').includes(name) ? [child] : []), ...child.find(name)]
          : [],
      );
    }
  }
  const page = Object.fromEntries(
    ['studio-view', 'studio-modes', 'studio-back', 'studio-title', 'studio-summary', 'studio-body'].map(id => [
      id,
      new Element(),
    ]),
  );
  const globals = {
    document: { getElementById: id => page[id] ?? null, querySelector: () => null },
    Option: class {},
    ResizeObserver: undefined,
  };
  const before = Object.fromEntries(Object.keys(globals).map(key => [key, globalThis[key]]));
  Object.assign(globalThis, globals);
  try {
    const { setupStudio } = await import('../public/studio.mjs');
    const limits = { width: { min: 256, max: 2048, multipleOf: 32 }, height: { min: 256, max: 2048, multipleOf: 32 } };
    const workflow = {
      id: 'w',
      name: 'Image',
      roles: {},
      limits,
      direct: true,
      size: { width: 1024, height: 1024 },
      settings: [],
      seeded: true,
    };
    const info = { enabled: true, conversationId: STUDIO_ID, styles: [], tools: { create_image: [workflow] } };
    const made = { id: 'r1', prompt: 'un phare', outputs: [{ originalUrl: '/media/generated/phare' }] };
    const runs = [];
    const opened = [];
    const studio = setupStudio({
      api: async route => ({
        json: async () => {
          if (route === 'studio') return info;
          if (route.startsWith('gallery/')) return { runs };
          if (route === 'tools/action') return { requestId: 'q', plan: { parameters: {} } };
          if (route === 'tools/execute') {
            // The creation is made at once, and listed by the gallery from then on.
            runs.unshift(made);
            return { id: 'j', state: 'done', record: made };
          }
          return {};
        },
      }),
      node: (tag, className) => new Element(tag, className),
      icon: () => new Element('svg'),
      notice() {},
      assets: {},
      viewOutput: record => opened.push(record.id),
      waitForModel: async () => {},
      blocked: () => '',
      onChange() {},
    });
    const body = page['studio-body'],
      enter = async () => {
        await studio.open();
        page['studio-modes'].children[0].onclick();
      };
    await enter();
    assert.deepEqual(body.find('studio-frame-result'), [], 'an empty frame to begin with');

    const [prompt] = body.find('studio-write')[0].children[0].children.filter(child => child.tag === 'textarea');
    prompt.value = 'un phare';
    prompt.oninput();
    await body.find('studio-go')[0].onclick();
    const [kept] = body.find('studio-frame-result');
    assert.equal(kept.tag, 'img');
    assert.equal(kept.src, '/media/generated/phare');
    assert.match(body.find('studio-frame')[0].className, /has-result/);
    // A click shows it whole, with its settings.
    kept.onclick();
    assert.deepEqual(opened, ['r1']);

    // Back to the three choices and in again: still the same visit.
    page['studio-back'].onclick();
    page['studio-modes'].children[0].onclick();
    assert.equal(body.find('studio-frame-result').length, 1);

    // The Studio is left and entered again: the frame is empty, the creation is in the list below.
    await enter();
    assert.deepEqual(body.find('studio-frame-result'), []);
    assert.doesNotMatch(body.find('studio-frame')[0].className, /has-result/);
    assert.equal(body.find('studio-card').length, 1);
  } finally {
    Object.assign(globalThis, before);
  }
});
