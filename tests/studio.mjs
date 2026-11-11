import test from 'node:test';
import assert from 'node:assert/strict';
import { STUDIO_ID, STUDIO_VERBS, styleLine, styleMessages } from '../lib/studio.mjs';
import { ToolRuntime, checkStyles } from '../lib/tool-runtime.mjs';
import { comfyGraph } from '../lib/comfy-graphs.mjs';
import { comfyNames } from '../lib/comfy-engine.mjs';

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

test('a Studio generation unloads the chat model and leaves it unloaded; a conversation gets it back', async () => {
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
  for (const [conversationId, expected] of [
    [STUDIO_ID, ['llm stopped', 'generate', 'gpu released']],
    [turn, ['llm stopped', 'generate', 'gpu released', 'llm started']],
  ]) {
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
        run: async () => {
          events.push('generate');
          return { outputs: [{ filename: 'image.png', subfolder: '', type: 'output' }] };
        },
        free: async () => events.push('gpu released'),
      }),
    });
    const request = await runtime.request(
      [{ id: 'call', type: 'function', function: { name: 'create_image', arguments: '{"prompt":"boat"}' } }],
      { conversationId, turnId: turn, messages: [] },
    );
    await runtime.execute({ requestId: request.requestId, permission: 'once' });
    await runtime.finished;
    assert.equal(runtime.status().state, 'done', runtime.status().error);
    assert.deepEqual(events, expected);
  }
});
