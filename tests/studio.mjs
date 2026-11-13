import test from 'node:test';
import assert from 'node:assert/strict';
import { STUDIO_ID, STUDIO_VERBS, enrichedPrompt, enrichMessages } from '../lib/studio.mjs';
import { ToolRuntime, checkStyles } from '../lib/tool-runtime.mjs';
import { comfyGraph } from '../lib/comfy-graphs.mjs';
import { comfyNames } from '../lib/comfy-engine.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../server.mjs';

test('a prompt is enriched from what the user typed, for the creation it is for', () => {
  const [system, user] = enrichMessages('  un renard dans la neige  ');
  // What was typed is the whole request; the model is told to keep it and add what is missing.
  assert.equal(user.content, 'un renard dans la neige');
  assert.match(system.content, /the prompt of an image/);
  assert.match(system.content, /Keep everything the user asked for/);
  assert.match(system.content, /Answer with the prompt alone/);
  // The same guidance as when the chat model writes a prompt itself, per kind of creation.
  assert.match(system.content, /three to six sentences in English/);
  const [video] = enrichMessages('un renard', { verb: 'create_video' });
  assert.match(video.content, /the prompt of a video clip/);
  assert.match(video.content, /present tense/);
  assert.match(enrichMessages('la suite', { verb: 'extend_video' })[0].content, /continuation of a video clip/);
  // An unknown verb is an image; the user's standing instructions come last and win.
  assert.match(enrichMessages('x', { verb: 'nope' })[0].content, /the prompt of an image/);
  assert.doesNotMatch(system.content, /standing instructions/);
  const [wished] = enrichMessages('un renard', { preferences: ' 500 caractères, en anglais ' });
  assert.match(
    wished.content,
    /standing instructions, which come first where they differ: 500 caractères, en anglais$/,
  );
});

test('the answer is kept as the prompt alone', () => {
  assert.equal(
    enrichedPrompt('<think>hmm</think>\n"Prompt: A red fox sits in fresh snow.\n\nSoft morning light."\n'),
    'A red fox sits in fresh snow.\nSoft morning light.',
  );
  assert.equal(enrichedPrompt('Enriched prompt: « A fox »'), 'A fox');
  assert.equal(enrichedPrompt('x'.repeat(5000)).length, 4000);
  assert.equal(enrichedPrompt(null), '');
});

test('the Studio has its own identifier and the verbs it may start', () => {
  assert.match(STUDIO_ID, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  for (const verb of ['create_image', 'create_video', 'extend_video', 'create_audio'])
    assert.ok(STUDIO_VERBS.includes(verb));
});

test('style LoRAs: three at most, a name and a strength within limits', () => {
  assert.deepEqual(checkStyles([{ name: 'a.safetensors' }, { name: 'sub\\b.safetensors', strength: 0.5 }]), [
    { name: 'a.safetensors', strength: 1 },
    { name: 'sub\\b.safetensors', strength: 0.5 },
  ]);
  assert.throws(() => checkStyles([{ name: '' }]), /Style invalide/);
  assert.throws(() => checkStyles([{ name: 'a', strength: 9 }]), /Style invalide/);
  assert.equal(checkStyles(Array(3).fill({ name: 'a' })).length, 3);
  assert.throws(() => checkStyles(Array(4).fill({ name: 'a' })), /trois/);
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
  // Each model with its family: the page keeps a family's LoRAs to itself.
  assert.equal(krea.family, 'krea2');
  assert.equal(named('create_image', 'MOSS').family, 'moss');
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

test('the page module loads and offers the sizes of a format', async () => {
  const { sizeChoices } = await import('../public/studio.mjs');
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
    enrichTimeoutMs: 400,
    spawnProcess: (_command, args, options) =>
      spawn(
        process.execPath,
        [fileURLToPath(new URL('./fixtures/fake-engine.mjs', import.meta.url)), ...args],
        options,
      ),
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
  // Nothing to enrich is said at once, without asking the model.
  assert.equal((await api('studio/enrich', { prompt: '   ' })).status, 400);
  const late = await api('studio/enrich', { prompt: 'aquarelle, sans réponse', verb: 'create_image' });
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

test('under the preview: 1:1, 16:9 and 9:16, and a fourth format takes the place of « ··· »', async () => {
  const { shownFormats, resultCount } = await import('../public/studio.mjs');
  const all = ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'];
  assert.deepEqual(shownFormats(all, '16:9'), { main: ['1:1', '16:9', '9:16'], extra: null });
  assert.deepEqual(shownFormats(all, '4:3'), { main: ['1:1', '16:9', '9:16'], extra: '4:3' });
  // A model that cannot make a square shows the two others.
  assert.deepEqual(shownFormats(['16:9', '9:16', '21:9'], '21:9'), { main: ['16:9', '9:16'], extra: '21:9' });
  // The count of the Sortie, in the words of the choice beside it.
  assert.equal(resultCount(0), '');
  assert.equal(resultCount(1), '1 résultat');
  assert.equal(resultCount(3), '3 résultats');
});

test('a proposal of Moodix AI read in the Studio’s terms, with what the assistant may change', async () => {
  const { proposedValues } = await import('../public/studio.mjs');
  const offered = [
    { id: 'ltx', name: 'LTX 2.5', settings: [] },
    { id: 'minimax', name: 'MiniMax H3 Omni', settings: [{ key: 'language' }] },
  ];
  const values = proposedValues(
    {
      tool: 'create_video',
      workflowName: 'MiniMax H3 Omni',
      resolution: { width: 768, height: 448 },
      plan: {
        prompt: 'Un renard se lève',
        stage: 'draft',
        parameters: { width: 768, height: 448, frames: 125, fps: 24, seed: 42, language: 'fr' },
        editable: {
          prompt: true,
          parameters: [
            { key: 'frames', type: 'integer', value: 125, choices: [125, 193] },
            // « Fixe » in the workflow: shown, never changed by the pointer.
            { key: 'width', type: 'integer', value: 768, locked: 'Fixé par le workflow' },
            { key: 'height', type: 'integer', value: 448, locked: 'Fixé par le workflow' },
            { key: 'seed', type: 'integer', value: 42 },
          ],
          references: [[{ role: 'start_image' }, { role: 'reference' }]],
        },
        references: [{ role: 'start_image', resource_id: 'r1', label: 'Renard' }],
      },
    },
    offered,
  );
  assert.equal(values.workflow, 'minimax');
  assert.equal(values.prompt, 'Un renard se lève');
  assert.equal(values.promptFree, true);
  assert.equal(values.format, '16:9');
  assert.equal(values.size, '768x448');
  assert.equal(values.sizeFree, false);
  assert.ok(Math.abs(values.seconds - 125 / 24) < 1e-9);
  assert.equal(values.framesFree, true);
  assert.deepEqual(values.framesChoices, [125, 193]);
  assert.equal(values.seed, 42);
  assert.deepEqual(values.settings, { language: 'fr' });
  assert.deepEqual(values.settingsFree, { language: false });
  assert.equal(values.references.length, 1);
  assert.equal(values.source, null);
  // A continuation: its added length is counted after the overlap with its clip.
  const more = proposedValues(
    {
      tool: 'extend_video',
      workflowName: 'LTX 2.5',
      plan: {
        prompt: 'La suite',
        parameters: { width: 512, height: 288, frames: 73, fps: 24, overlap_frames: 25 },
        editable: { prompt: true, parameters: [] },
        references: [{ role: 'source_video', output_id: 'clip' }],
      },
    },
    offered,
  );
  assert.equal(more.source, 'clip');
  assert.equal(more.seconds, 2);
  assert.deepEqual(more.references, []);
});

test('another mode stops following the size of the frame it leaves', async () => {
  // Just enough of a page for the Studio to draw itself.
  class Element {
    children = [];
    style = {};
    dataset = {};
    classList = { toggle() {}, add() {}, remove() {} };
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
    removeAttribute() {}
    querySelector() {
      return new Element();
    }
    querySelectorAll() {
      return [];
    }
  }
  const page = Object.fromEntries(['studio-view', 'studio-kinds', 'studio-body'].map(id => [id, new Element()]));
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
    const workflow = (id, media) => ({
      id,
      name: id,
      roles: {},
      limits,
      size: { width: 1024, height: 576 },
      settings: [],
      seeded: true,
      media,
    });
    const info = {
      enabled: true,
      legacyId: STUDIO_ID,
      styles: [],
      tools: { create_image: [workflow('i', 'image')], create_video: [workflow('v', 'video')] },
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
      conversation: () => 'c1',
    });
    await studio.open();
    // No page of three choices any more: the Studio opens on a mode, Image first.
    assert.equal(page['studio-body'].dataset.mode, 'image');
    assert.deepEqual(
      page['studio-kinds'].children.map(tab => tab.dataset.mode),
      ['image', 'video', 'audio'],
    );
    const following = observers.at(-1);
    assert.ok(following.watched, 'the frame follows its stage');
    page['studio-kinds'].children[1].onclick();
    assert.equal(page['studio-body'].dataset.mode, 'video');
    // Still watched, the stage left was reported once more as it went.
    assert.equal(following.watched, null);
    assert.equal(observers.filter(observer => observer.watched).length, 1);
  } finally {
    Object.assign(globalThis, before);
  }
});

/** A runtime with one image workflow, a chat model and a generator that only note what they are asked. */
function handover({ keepMs, fails = false, tight = false, onRun } = {}) {
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
      // Asked to stay loaded, the generator does so unless main memory is short with its models in it.
      free: async options => {
        const kept = Boolean(options?.keep) && !tight;
        events.push(kept ? 'sources removed' : 'gpu released');
        return kept ? { kept: true } : {};
      },
    }),
  });
  /** One image asked from this conversation, run to its end; `studio`: started in its Studio. */
  async function create(conversationId, { studio = false } = {}) {
    const request = await runtime.request(
      [{ id: 'call', type: 'function', function: { name: 'create_image', arguments: '{"prompt":"boat"}' } }],
      { conversationId, turnId: turn, messages: [] },
    );
    await runtime.execute({ requestId: request.requestId, permission: 'once', ...(studio ? { studio } : {}) });
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

test('in a conversation, a creation started from its Studio keeps the generator and leaves the chat model unloaded', async () => {
  const { runtime, events, create, turn } = handover();
  const status = await create(turn, { studio: true });
  assert.equal(status.state, 'done', status.error);
  // The user may well make another one at once: nothing reloads, only the copies of the sources go.
  assert.deepEqual(events, ['llm stopped', 'generate', 'sources removed']);
  // The next message of the chat gives the card back first.
  events.length = 0;
  assert.equal(await runtime.yieldGpu(), true);
  assert.deepEqual(events, ['gpu released']);
  await runtime.close();
});

test('the generator a Studio creation left loaded gives the card back by itself after a while', async () => {
  const { runtime, events, create } = handover({ keepMs: 40 });
  await create(STUDIO_ID);
  await create(STUDIO_ID);
  // Two creations in a row: nothing was unloaded between them.
  assert.deepEqual(events, [
    'llm stopped',
    'generate',
    'sources removed',
    'llm stopped',
    'generate',
    'sources removed',
  ]);
  events.length = 0;
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.deepEqual(events, ['gpu released']);
  assert.equal(await runtime.yieldGpu(), false);
  await runtime.close();
});

test('a generator that leaves the machine short of main memory is not kept loaded', async () => {
  // A video model: seventeen gigabytes of main memory beside the card, three left out of thirty-two.
  const { runtime, events, create } = handover({ tight: true });
  const status = await create(STUDIO_ID);
  assert.equal(status.state, 'done', status.error);
  assert.deepEqual(events, ['llm stopped', 'generate', 'gpu released']);
  // Nothing is left to give back later, and the chat model still stays away.
  assert.equal(await runtime.yieldGpu(), false);
  assert.deepEqual(events, ['llm stopped', 'generate', 'gpu released']);
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

/** A page that remembers what each element is, with the Studio set up in it; `routes` answers its requests. */
async function studioPage(tools, routes = {}, options = {}) {
  class Element {
    constructor(tag = '', className = '', textContent = '') {
      Object.assign(this, { tag, className, textContent, children: [], style: {}, dataset: {} });
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
    setAttribute(name, value) {
      (this.attributes ??= {})[name] = value;
    }
    removeAttribute(name) {
      delete this.attributes?.[name];
    }
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
    ['studio-view', 'studio-kinds', 'studio-body', 'ai-status', 'ai-takeover'].map(id => [id, new Element()]),
  );
  // What the page itself listens to: keys pressed with the focus on no field.
  const pageKeys = [];
  const globals = {
    document: {
      getElementById: id => page[id] ?? null,
      querySelector: () => null,
      body: {},
      addEventListener: (type, listener) => type === 'keydown' && pageKeys.push(listener),
    },
    Option: class {},
    ResizeObserver: undefined,
  };
  const before = Object.fromEntries(Object.keys(globals).map(key => [key, globalThis[key]]));
  Object.assign(globalThis, globals);
  const { setupStudio } = await import('../public/studio.mjs');
  const asked = [],
    notices = [],
    revealed = [];
  let imported = 0;
  const runs = options.runs ?? [];
  const studio = setupStudio({
    api: async (route, body) => {
      asked.push([route, body]);
      return {
        json: async () =>
          route === 'studio'
            ? { enabled: true, legacyId: STUDIO_ID, styles: ['a.safetensors', 'b.safetensors'], tools }
            : route.startsWith('gallery/')
              ? { runs: route.includes(STUDIO_ID) ? (options.legacy ?? []) : runs }
              : (routes[route]?.(body) ?? {}),
      };
    },
    node: (tag, className, text) => new Element(tag, className, text),
    icon: () => new Element('svg'),
    notice: text => notices.push(text),
    // Each file dropped becomes a resource of the library, with its own preview.
    assets: {
      importFiles: async files =>
        files.map(file => ({
          id: 'r' + ++imported,
          label: 'Ref ' + imported,
          name: file.name,
          previewUrl: '/preview/' + file.name,
          width: 1280,
          height: 720,
        })),
      resource: id => ({ previewUrl: '/preview/' + id }),
    },
    viewOutput: options.viewOutput ?? (() => {}),
    waitForModel: async () => {},
    blocked: () => '',
    onChange() {},
    conversation: () => options.conversation?.() ?? 'c1',
    ensureConversation: async () => options.conversation?.() ?? 'c1',
    reveal: () => revealed.push(true),
    pace: 0,
    ...(options.run ? { run: options.run } : {}),
    ...(options.openAgent ? { openAgent: options.openAgent } : {}),
  });
  if (options.open !== false) await studio.open();
  return {
    studio,
    page,
    body: page['studio-body'],
    asked,
    notices,
    revealed,
    pageKeys,
    runs,
    restore: () => Object.assign(globalThis, before),
    /** Opens a mode by its place among Image, Vidéo and Son. */
    mode: index => page['studio-kinds'].children[index].onclick(),
    /** The prompt of the Entrée block. */
    prompt: () => page['studio-body'].find('studio-prompt-field')[0].children[0],
  };
}
const sizes = { width: { min: 256, max: 2048, multipleOf: 32 }, height: { min: 256, max: 2048, multipleOf: 32 } };
const settle = () => new Promise(resolve => setTimeout(resolve, 15));

test('the last creation stays on the screen; another conversation starts from an empty screen', async () => {
  const workflow = {
    id: 'w',
    name: 'Image',
    roles: {},
    limits: sizes,
    direct: true,
    size: { width: 1024, height: 1024 },
    settings: [],
    seeded: true,
  };
  const made = { id: 'r1', prompt: 'un phare', outputs: [{ originalUrl: '/media/generated/phare' }] };
  const opened = [];
  let conversation = 'c1';
  const page = await studioPage(
    { create_image: [workflow] },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => {
        // The creation is made at once, and listed by the gallery from then on.
        page.runs.unshift(made);
        return { id: 'j', state: 'done', record: made };
      },
    },
    { viewOutput: record => opened.push(record.id), conversation: () => conversation },
  );
  const { body, studio, asked, restore } = page;
  try {
    assert.deepEqual(body.find('studio-frame-result'), [], 'an empty screen to begin with');
    page.prompt().value = 'un phare';
    page.prompt().oninput();
    await body.find('studio-go')[0].onclick();
    // Made in the conversation, as a creation of its Studio.
    const [, action] = asked.find(([route]) => route === 'tools/action');
    assert.equal(action.conversationId, 'c1');
    assert.equal(action.studio, true);
    assert.equal(asked.find(([route]) => route === 'tools/execute')[1].studio, true);
    const [kept] = body.find('studio-frame-result');
    assert.equal(kept.tag, 'img');
    assert.equal(kept.src, '/media/generated/phare');
    assert.match(body.find('studio-frame')[0].className, /has-result/);
    // A click shows it whole, with its settings.
    kept.onclick();
    assert.deepEqual(opened, ['r1']);
    // In the Sortie, with its count; on the screen still after a visit of the chat.
    assert.equal(body.find('studio-item').length, 1);
    assert.equal(body.find('studio-count')[0].textContent, '1 résultat');
    // A creation is shown as it is, with no grain over it; its actions sit on its picture, so the
    // Sortie keeps its height. No title on the blocks: their colour says what they are for.
    assert.deepEqual(body.find('picture-grain'), []);
    assert.equal(body.find('studio-thumb')[0].find('studio-actions').length, 1);
    assert.deepEqual(body.find('studio-block-title'), []);
    await studio.open();
    assert.equal(body.find('studio-frame-result').length, 1);
    // Another conversation: its own Studio, an empty screen.
    conversation = 'c2';
    page.runs.length = 0;
    await studio.open();
    assert.deepEqual(body.find('studio-frame-result'), []);
    assert.equal(body.find('studio-item').length, 0);
  } finally {
    restore();
  }
});

test('« Ouvrir » on a card puts the creation on the screen of its mode', async () => {
  const video = {
    id: 'v',
    name: 'Clip',
    roles: {},
    limits: sizes,
    size: { width: 768, height: 448 },
    settings: [],
    seeded: true,
  };
  const clip = { id: 'c', mediaType: 'video', prompt: 'un renard', outputs: [{ originalUrl: '/clip.mp4' }] };
  const { studio, body, restore } = await studioPage({ create_video: [video] }, {}, { runs: [clip] });
  try {
    assert.equal(body.dataset.mode, 'image');
    studio.show(clip);
    assert.equal(body.dataset.mode, 'video');
    const [shown] = body.find('studio-frame-result');
    assert.equal(shown.tag, 'video');
    assert.equal(shown.controls, true, 'a clip plays on the screen');
    assert.match(body.find('studio-item')[0].className, /is-shown/);
  } finally {
    restore();
  }
});

test('the creations of the former Studio stay listed apart, and are made there', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] };
  const old = { id: 'o', prompt: 'avant', outputs: [{ originalUrl: '/old.png' }] };
  const { body, asked, restore } = await studioPage(
    { create_image: [image] },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }),
    },
    { legacy: [old] },
  );
  try {
    const [where] = body.find('studio-source-pick');
    assert.ok(where, 'a choice appears once the former Studio holds something');
    assert.equal(body.find('studio-item').length, 0);
    where.value = 'legacy';
    where.onchange();
    await settle();
    assert.equal(body.find('studio-item').length, 1);
    // Its creations stay where they were: Détails and Retirer, no action written to a conversation.
    assert.deepEqual(
      body
        .find('studio-item')[0]
        .find('output-action')
        .map(action => action.children.at(-1)?.textContent ?? ''),
      ['Détails', ''],
    );
    const prompt = body.find('studio-prompt-field')[0].children[0];
    prompt.value = 'encore';
    prompt.oninput();
    await body.find('studio-go')[0].onclick();
    assert.equal(asked.find(([route]) => route === 'tools/action')[1].conversationId, STUDIO_ID);
  } finally {
    restore();
  }
});

test('an image dragged to another slot changes role; a move that would not combine is refused', async () => {
  const video = {
    id: 'v',
    name: 'Clip',
    external: true,
    limits: sizes,
    size: { width: 768, height: 448 },
    settings: [],
    seeded: true,
    // As MiniMax: a start and an end, or references, never both.
    exclusive: [['start_image', 'end_image'], ['reference']],
    roles: {
      start_image: { count: 1, media: ['image'] },
      end_image: { count: 1, media: ['image'] },
      reference: { count: 2, media: ['image'] },
    },
  };
  const { body, restore, mode } = await studioPage({ create_video: [video] });
  try {
    mode(1);
    const slots = () => body.find('studio-slot'),
      shown = () => slots().map(tile => (tile.className.includes('is-filled') ? tile.children[0].children[0].src : '')),
      event = files => ({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files, setData() {} } }),
      drop = async (index, name) => {
        slots()[index].ondrop(event([{ name }]));
        await new Promise(resolve => setTimeout(resolve, 5));
      },
      drag = (from, to) => {
        slots()[from].children[0].ondragstart(event([]));
        slots()[to].ondrop(event([]));
      };
    assert.equal(slots().length, 4, 'start, end and two references');

    await drop(0, 'a.png');
    assert.deepEqual(shown(), ['/preview/a.png', '', '', '']);
    // References do not combine with a start image: their slots say so, and still take the move.
    assert.match(slots()[2].className, /is-blocked/);
    drag(0, 2);
    assert.deepEqual(shown(), ['', '', '/preview/a.png', '']);
    assert.doesNotMatch(slots()[2].className, /is-blocked/);
    assert.match(slots()[0].className, /is-blocked/);

    // To the end slot, then a start image beside it: the two swap when one is dropped on the other.
    drag(2, 1);
    await drop(0, 'b.png');
    assert.deepEqual(shown(), ['/preview/b.png', '/preview/a.png', '', '']);
    drag(0, 1);
    assert.deepEqual(shown(), ['/preview/a.png', '/preview/b.png', '', '']);

    // A reference beside an end image is what the model cannot take: nothing moves, and it is said.
    drag(0, 3);
    assert.deepEqual(shown(), ['/preview/a.png', '/preview/b.png', '', '']);
    assert.match(body.find('studio-error')[0].textContent, /ne se combine pas avec : Image de fin/);
  } finally {
    restore();
  }
});

test('Ctrl + Entrée generates from anywhere in the Studio, and the button says so in its corner', async () => {
  const image = {
    id: 'w',
    name: 'Image',
    roles: {},
    limits: sizes,
    direct: true,
    size: { width: 1024, height: 1024 },
    settings: [],
    seeded: true,
  };
  const studio = await studioPage(
    { create_image: [image] },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }),
    },
  );
  const { page, body, asked, pageKeys, restore } = studio;
  try {
    const key = (overrides = {}) => ({ key: 'Enter', ctrlKey: true, preventDefault() {}, ...overrides }),
      started = () => asked.filter(([route]) => route === 'tools/action').length;
    assert.match(body.find('studio-go-key')[0].textContent, /^(Ctrl|⌘) ↵$/);
    // Nothing typed: a prompt is asked for, nothing starts.
    page['studio-view'].onkeydown(key());
    await settle();
    assert.equal(started(), 0);
    assert.match(body.find('studio-error')[0].textContent, /Écrivez un prompt/);
    studio.prompt().value = 'un phare';
    studio.prompt().oninput();
    // Entrée alone is a line in the prompt.
    page['studio-view'].onkeydown(key({ ctrlKey: false }));
    assert.equal(started(), 0);
    // The message box of the chat sends with Entrée: the key is not the Studio's there.
    page['studio-view'].onkeydown(key({ target: { id: 'prompt' } }));
    assert.equal(started(), 0);
    page['studio-view'].onkeydown(key());
    await settle();
    const [, sent] = asked.find(([route]) => route === 'tools/action');
    // What is typed is what is sent: no style line is added any more.
    assert.equal(sent.arguments.prompt, 'un phare');

    // After a click beside the fields the focus is on none: the key reaches the page itself, and
    // generates too, but only while the Studio is the view on screen.
    const onPage = () => pageKeys.forEach(listener => listener({ ...key(), target: document.body }));
    assert.equal(started(), 1);
    onPage();
    assert.equal(started(), 1, 'the Studio is not on screen');
    page['studio-view'].offsetParent = {};
    onPage();
    await settle();
    assert.equal(started(), 2);
    // A key pressed in a field of another view is not the Studio's.
    pageKeys.forEach(listener => listener({ ...key(), target: {} }));
    assert.equal(started(), 2);
  } finally {
    restore();
  }
});

test('« Agent », left of « Générer », opens the chat as the band at the foot did; the Sortie wears the four colours', async () => {
  const image = {
    id: 'w',
    name: 'Image',
    roles: {},
    limits: sizes,
    direct: true,
    size: { width: 1024, height: 1024 },
    settings: [],
    seeded: true,
  };
  let opened = 0;
  const { body, restore } = await studioPage({ create_image: [image] }, {}, { openAgent: () => opened++ });
  try {
    const group = body.find('studio-go-group')[0],
      [agent] = body.find('studio-agent'),
      go = body.find('studio-go')[0];
    assert.equal(agent.id, 'agent-open');
    assert.deepEqual(group.children.slice(0, 2), [agent, go], 'just before Générer, in one group');
    assert.equal(agent.find('studio-agent-word')[0].textContent, 'Agent');
    // An icon, its word, its name for screen readers and in its tooltip.
    assert.equal(agent.attributes['aria-label'], 'Agent Moodix AI');
    assert.equal(agent.title, 'Agent Moodix AI');
    assert.equal(agent.attributes['aria-controls'], 'chat-panel');
    assert.equal(agent.find('studio-agent-rule').length, 1);
    agent.onclick();
    assert.equal(opened, 1);
    // The Sortie: the four colours of the logo along its foot.
    const output = body.find('is-output')[0];
    assert.equal(output.children.at(-1).className, 'moodix-rule studio-output-rule');
    assert.equal(output.children.at(-1).children.length, 4);
  } finally {
    restore();
  }
  // Nothing ready to make: the chat stays at hand all the same.
  const empty = await studioPage({ create_image: [] }, {}, { openAgent: () => opened++ });
  try {
    const [agent] = empty.body.find('studio-agent');
    assert.ok(agent, 'Agent shown with the message');
    agent.onclick();
    assert.equal(opened, 2);
  } finally {
    empty.restore();
  }
});

test('« Enrichir le prompt » rewrites what is typed, which can be taken back; three LoRAs at most', async () => {
  const image = {
    id: 'w',
    name: 'Image',
    external: true,
    roles: {},
    limits: sizes,
    direct: true,
    size: { width: 1024, height: 1024 },
    settings: [],
    seeded: true,
  };
  const studio = await studioPage(
    { create_image: [image] },
    { 'studio/enrich': ({ prompt }) => ({ prompt: 'A lighthouse at dusk. (' + prompt + ')' }) },
  );
  const { body, asked, restore } = studio;
  try {
    assert.equal(body.find('studio-enrich-go')[0].children.at(-1).textContent, 'Enrichir le prompt');

    // Nothing typed: nothing is asked of the model.
    await body.find('studio-enrich-go')[0].onclick();
    assert.equal(asked.filter(([route]) => route === 'studio/enrich').length, 0);
    assert.match(body.find('studio-error')[0].textContent, /quelques mots/);

    studio.prompt().value = 'un phare';
    studio.prompt().oninput();
    await body.find('studio-enrich-go')[0].onclick();
    assert.deepEqual(asked.find(([route]) => route === 'studio/enrich')[1], {
      prompt: 'un phare',
      verb: 'create_image',
    });
    assert.equal(studio.prompt().value, 'A lighthouse at dusk. (un phare)');
    // What was typed is one click away.
    const back = body.find('studio-enrich')[0].children.find(child => child.className === 'studio-link');
    back.onclick();
    assert.equal(studio.prompt().value, 'un phare');
    assert.equal(body.find('studio-enrich')[0].children.length, 1);

    // The seed and the LoRAs are rare: under « Plus de réglages ».
    const [more] = body.find('studio-more');
    assert.equal(more.children.at(-1).textContent, '+ Plus de réglages');
    assert.equal(body.find('studio-advanced')[0].hidden, true);
    more.onclick();
    assert.equal(body.find('studio-advanced')[0].hidden, false);
    // LoRAs: a card each, the count shown, and no fourth.
    for (let added = 0; added < 3; added++) body.find('studio-lora-add')[0].onclick();
    assert.equal(body.find('studio-lora').length, 3);
    assert.equal(body.find('studio-loras-count')[0].textContent, '3 / 3');
    assert.deepEqual(body.find('studio-lora-add'), []);
    body.find('studio-lora-remove')[0].onclick();
    assert.equal(body.find('studio-lora').length, 2);
    assert.equal(body.find('studio-lora-add').length, 1);
  } finally {
    restore();
  }
});

test('the LoRAs of a model do not follow to a model of another family, and come back with theirs', async () => {
  const image = (id, name, family) => ({
    id,
    name,
    family,
    external: true,
    roles: {},
    limits: sizes,
    direct: true,
    size: { width: 1024, height: 1024 },
    settings: [],
    seeded: true,
  });
  const studio = await studioPage(
    {
      create_image: [
        image('k', 'Krea 2', 'krea2'),
        image('k2', 'Krea 2 rétro', 'krea2'),
        image('m', 'MOSS Image', 'moss'),
      ],
    },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }),
    },
  );
  const { body, asked, restore } = studio;
  try {
    const model = to => {
        const control = body.find('studio-field').find(field => field.children[0].textContent === 'Modèle').children[1];
        control.value = to;
        control.onchange();
      },
      generate = async () => {
        studio.prompt().value = 'une affiche';
        studio.prompt().oninput();
        await body.find('studio-go')[0].onclick();
        await settle();
        return asked.filter(([route]) => route === 'tools/action').at(-1)[1];
      };
    body.find('studio-lora-add')[0].onclick();
    body.find('studio-lora-add')[0].onclick();
    assert.equal(body.find('studio-lora').length, 2);

    // Another workflow of the same family keeps them.
    model('k2');
    assert.equal(body.find('studio-lora').length, 2);

    // MOSS Image: none of Krea 2's LoRAs is shown, and none is sent.
    model('m');
    assert.equal(body.find('studio-lora').length, 0);
    assert.equal(body.find('studio-loras-count')[0].textContent, '0 / 3');
    const sent = await generate();
    assert.equal(sent.arguments.workflow ?? 'm', 'm');
    assert.equal(sent.styles, undefined);

    // One of its own, then back to Krea 2: each family finds its own again.
    body.find('studio-lora-add')[0].onclick();
    model('k');
    assert.equal(body.find('studio-lora').length, 2);
    assert.equal((await generate()).styles.length, 2);
    model('m');
    assert.equal(body.find('studio-lora').length, 1);
  } finally {
    restore();
  }
});

/** A video workflow with three lengths and a proposal of Moodix AI for it. */
function proposalOf({ prompt = 'Un renard se lève', frames = 121 } = {}) {
  const clip = {
    id: 'v',
    name: 'Clip',
    roles: { start_image: { count: 1, media: ['image'] } },
    limits: sizes,
    size: { width: 768, height: 448 },
    final: { width: 1344, height: 768 },
    stages: true,
    seeded: true,
    lengths: { seconds: [121 / 24, 193 / 24, 241 / 24], standard: 121 / 24 },
    settings: [],
  };
  const request = {
    requestId: 'q',
    approvalToken: 't',
    tool: 'create_video',
    mediaType: 'video',
    workflowName: 'Clip',
    resolution: { width: 768, height: 448 },
    call: { id: 'call', type: 'function', function: { name: 'create_video', arguments: '{}' } },
    plan: {
      prompt,
      stage: 'draft',
      parameters: { prompt, width: 768, height: 448, frames, fps: 24, seed: 7 },
      editable: {
        prompt: true,
        stages: ['draft', 'final'],
        parameters: [
          { key: 'frames', type: 'integer', value: frames, choices: [121, 193, 241] },
          { key: 'width', type: 'integer', value: 768 },
          { key: 'height', type: 'integer', value: 448 },
          { key: 'seed', type: 'integer', value: 7 },
        ],
        references: [],
      },
      references: [],
    },
  };
  return { clip, request };
}

test('Moodix AI sets its proposal in the Studio and waits: « Générer » is the answer, with the user’s changes', async () => {
  const { clip, request } = proposalOf();
  const studio = await studioPage(
    { create_video: [clip] },
    { 'tools/revise': ({ edits }) => ({ requestId: 'q2', approvalToken: 't2', revised: edits }) },
  );
  const { body, asked, revealed, restore } = studio;
  try {
    assert.equal(studio.studio.accepts('create_video'), true);
    assert.equal(studio.studio.accepts('upscale'), false);
    const answer = studio.studio.propose(request, new AbortController().signal);
    await settle();
    // The Studio came on screen, in Vidéo, with what the pointer set.
    assert.equal(revealed.length, 1);
    assert.equal(body.dataset.mode, 'video');
    assert.equal(studio.prompt().value, 'Un renard se lève');
    // The lengths of the model, in a list like the other settings: the one proposed is chosen.
    assert.equal(body.find('studio-length')[0].value, String(121 / 24));
    assert.equal(studio.studio.proposing(), true);
    // Nothing starts by itself: the pointer stops on « Générer », beside a way to decline.
    assert.equal(asked.filter(([route]) => route.startsWith('tools/')).length, 0);
    assert.equal(body.find('studio-decline').length, 1);
    // The user lengthens it, then generates: the change goes first, then the answer.
    const length = body.find('studio-length')[0];
    length.value = String(193 / 24);
    length.onchange();
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    assert.deepEqual(asked.find(([route]) => route === 'tools/revise')[1], {
      requestId: 'q',
      approvalToken: 't',
      edits: { frames: 193 },
    });
    // The proposal now is the revised one, and the generation is followed by the chat turn.
    assert.equal(request.requestId, 'q2');
    assert.equal(studio.studio.proposing(), false);
    assert.equal(studio.studio.busy(), true);
    studio.studio.follow('Génération…', 0.42);
    assert.equal(body.find('studio-progress')[0].hidden, false);
    await studio.studio.settled({ record: null, error: 'Mémoire insuffisante.' });
    assert.equal(studio.studio.busy(), false);
    assert.match(body.find('studio-error')[0].textContent, /Mémoire insuffisante/);
    // The seed drawn for the proposal was its own: a creation by hand draws again.
    assert.equal(body.find('studio-advanced')[0].find('studio-field')[0].children[1].value, '');
  } finally {
    restore();
  }
});

test('a proposal left as it is goes as it is; declined, it is answered « deny »', async () => {
  const { clip, request } = proposalOf();
  const studio = await studioPage({ create_video: [clip] });
  const { body, asked, restore } = studio;
  try {
    let answer = studio.studio.propose(request, new AbortController().signal);
    await settle();
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    assert.equal(asked.filter(([route]) => route === 'tools/revise').length, 0, 'nothing changed: nothing revised');
    await studio.studio.settled({ record: null });

    const second = proposalOf({ prompt: 'Un phare la nuit' });
    answer = studio.studio.propose(second.request, new AbortController().signal);
    await settle();
    assert.equal(studio.prompt().value, 'Un phare la nuit');
    body.find('studio-decline')[0].onclick();
    assert.equal(await answer, 'deny');
    assert.equal(studio.studio.proposing(), false);
    assert.deepEqual(body.find('studio-decline'), []);

    // A new message in the chat declines it too; a stopped turn takes it away.
    const third = proposalOf();
    answer = studio.studio.propose(third.request, new AbortController().signal);
    await settle();
    assert.equal(studio.studio.decline(), true);
    assert.equal(await answer, 'deny');
    const stopped = new AbortController();
    answer = studio.studio.propose(proposalOf().request, stopped.signal);
    await settle();
    stopped.abort();
    await assert.rejects(answer);
    assert.equal(studio.studio.proposing(), false);
  } finally {
    restore();
  }
});

test('the pointer only sets what the workflow leaves to the assistant', async () => {
  const { clip, request } = proposalOf({ frames: 193 });
  // « Fixe » in the workflow: the length is not the assistant's.
  request.plan.editable.parameters = request.plan.editable.parameters.filter(item => item.key !== 'frames');
  clip.lengths = null;
  const studio = await studioPage({ create_video: [clip] });
  const { body, restore } = studio;
  try {
    const answer = studio.studio.propose(request, new AbortController().signal);
    await settle();
    // No length to set: none is shown, none is sent.
    assert.deepEqual(body.find('studio-length'), []);
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
  } finally {
    restore();
  }
});

test('the Studio reads its tools once at a time, and its creations only when something changed', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] };
  const { clip, request } = proposalOf();
  const studio = await studioPage({ create_image: [image], create_video: [clip] }, {}, { open: false });
  const { asked, restore } = studio;
  const tools = () => asked.filter(([route]) => route === 'studio').length,
    galleries = () => asked.filter(([route]) => route.startsWith('gallery/')).map(([route]) => route);
  try {
    // A proposal arrives as the Studio opens: one reading of the tools for both.
    const opening = studio.studio.open(),
      answer = studio.studio.propose(request, new AbortController().signal);
    await opening;
    await settle();
    assert.equal(tools(), 1);
    studio.studio.decline();
    await answer;
    // Its creations, without the copies kept for the model.
    assert.ok(galleries().length >= 1);
    assert.ok(galleries().every(route => route.endsWith('?images=0')));
    // Going to the chat and back reads nothing again.
    const read = galleries().length;
    await studio.studio.open();
    await studio.studio.open();
    assert.equal(galleries().length, read);
    assert.equal(tools(), 1);
    // Something made from the chat: its creations are read again at the next opening.
    studio.studio.invalidate();
    await studio.studio.open();
    assert.equal(galleries().length, read + 1);
    // The settings closed: the tools too, in the background.
    studio.studio.invalidate({ tools: true });
    await studio.studio.open();
    await settle();
    assert.equal(tools(), 2);
  } finally {
    restore();
  }
});

test('drawn again, the Studio keeps the pictures of its Sortie and what its screen shows', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] };
  const made = {
    id: 'r1',
    mediaType: 'image',
    prompt: 'un phare',
    outputs: [{ originalUrl: '/phare', thumbUrl: '/phare.jpg' }],
  };
  const { studio, body, restore } = await studioPage({ create_image: [image] }, {}, { runs: [made] });
  try {
    const picture = () => body.find('studio-thumb')[0].children[0];
    const first = picture();
    assert.equal(first.src, '/phare.jpg');
    studio.render();
    assert.equal(picture(), first, 'the same picture: nothing loaded again');
    studio.show(made);
    const [shown] = body.find('studio-frame-result');
    studio.render();
    assert.equal(body.find('studio-frame-result')[0], shown);
  } finally {
    restore();
  }
});

test('the LoRAs chosen in a workflow are listed for the Studio, named by their file, those switched off left out', async () => {
  const { readFile } = await import('node:fs/promises');
  const { ToolCatalog } = await import('../lib/tool-catalog.mjs');
  const krea = JSON.parse(
    await readFile(new URL('../runner/workflows/fefb88eb-8311-4409-b636-6efbb42e952c.json', import.meta.url), 'utf8'),
  );
  const loras = [
    {
      id: 'grain',
      asset: 'a1',
      description: 'Grain de film',
      enabled: { policy: 'model', default: false },
      strength: { policy: 'model', min: 0, max: 1.5, default: 0.8 },
    },
    {
      id: 'net',
      asset: 'a2',
      description: '',
      enabled: { policy: 'fixed', value: true },
      strength: { policy: 'fixed', value: 1 },
    },
    {
      id: 'old',
      asset: 'a3',
      description: 'Hors service',
      enabled: { policy: 'off' },
      strength: { policy: 'fixed', value: 1 },
    },
  ];
  const tools = new ToolCatalog({
    list: async () => [{ ...krea, loras, ready: true }],
    // The registry names its files; a LoRA without one is named by its description.
    assets: {
      list: async () => [
        { id: 'a1', path: 'D:/loras/film_grain.safetensors' },
        { id: 'a2', name: 'net.safetensors', path: 'D:/x/autre.safetensors' },
      ],
    },
  });
  const [workflow] = (await tools.studio()).create_image;
  assert.deepEqual(workflow.loras, [
    {
      id: 'grain',
      name: 'film_grain',
      description: 'Grain de film',
      assistant: true,
      on: false,
      strength: { min: 0, max: 1.5, default: 0.8 },
    },
    { id: 'net', name: 'net', description: '', assistant: false, on: true, strength: { value: 1 } },
  ]);
});

/** A workflow that brings two LoRAs: one left to the assistant (off by default), one always on. */
const withLoras = workflow => ({
  ...workflow,
  loras: [
    {
      id: 'grain',
      name: 'film_grain',
      description: 'Grain de film',
      assistant: true,
      on: false,
      strength: { min: 0, max: 1.5, default: 0.8 },
    },
    { id: 'net', name: 'net', description: '', assistant: false, on: true, strength: { value: 1 } },
  ],
});

test('the LoRAs of the workflow show in the Studio: those of the assistant are switched there and go with the creation', async () => {
  const workflow = withLoras({
    id: 'w',
    name: 'Krea 2',
    family: 'krea2',
    roles: {},
    limits: sizes,
    direct: true,
    size: { width: 1024, height: 1024 },
    settings: [],
  });
  const page = await studioPage(
    { create_image: [workflow] },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'error', error: 'arrêt' }),
    },
  );
  const { body, asked, restore } = page;
  try {
    // In sight among the settings, without « Plus de réglages »: one row each.
    const rows = body.find('studio-lora');
    assert.equal(rows.length, 2);
    assert.match(rows[0].className, /is-off/, 'off by default, as the workflow says');
    assert.equal(rows[0].find('ai-mark').length, 1, 'the tile of Moodix AI: the assistant may switch it');
    const [grain, net] = body.find('studio-lora-switch');
    assert.equal(net.checked, true);
    assert.equal(net.disabled, true, '« Activé » in Workflows: always applied');
    grain.checked = true;
    grain.onchange();
    page.prompt().value = 'un renard';
    page.prompt().oninput();
    await body.find('studio-go')[0].onclick();
    const [, action] = asked.find(([route]) => route === 'tools/action');
    // As the model would give it; the LoRA fixed in the workflow is not the creation's to set.
    assert.deepEqual(action.arguments.loras, { grain: { enabled: true, strength: 0.8 } });
  } finally {
    restore();
  }
});

test('a proposal of Moodix AI switches the LoRAs of the workflow as it has them; changed here, they go with « Générer »', async () => {
  const { clip, request } = proposalOf();
  request.plan.loras = [
    { id: 'grain', strength: 1.2 },
    { id: 'net', strength: 1 },
  ];
  const studio = await studioPage(
    { create_video: [withLoras(clip)] },
    { 'tools/revise': ({ edits }) => ({ requestId: 'q2', approvalToken: 't2', revised: edits }) },
  );
  const { body, asked, restore } = studio;
  try {
    const answer = studio.studio.propose(request, new AbortController().signal);
    await settle();
    const [grain] = body.find('studio-lora-switch');
    assert.equal(grain.checked, true, 'on, as Moodix AI has it');
    assert.equal(body.find('studio-lora-strength')[0].textContent, '1,20');
    // The user switches it off before generating: the change goes with the answer.
    grain.checked = false;
    grain.onchange();
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    assert.deepEqual(asked.find(([route]) => route === 'tools/revise')[1].edits, {
      loras: { grain: { enabled: false } },
    });
  } finally {
    restore();
  }
});
