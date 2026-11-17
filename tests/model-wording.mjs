import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer as netServer } from 'node:net';
import { createApplication } from '../server.mjs';
import { ToolCatalog } from '../lib/tool-catalog.mjs';
import { refsToIds, resourceCatalogPrompt, resourceTool } from '../lib/resources.mjs';
import { outputToolFor } from '../lib/output-tools.mjs';
import { briefMessage, cardBrief } from '../lib/video-brief.mjs';
import { THIN_NOTE } from '../lib/thin-prompt.mjs';
import { SEEN_NOTE } from '../lib/seen-resources.mjs';
import { citedMessage } from '../lib/cited-resources.mjs';
import { FAILED_NOTE, FAILED_SETTLED, UNANSWERED } from '../public/transcript.mjs';
import {
  BLIND,
  CAPABLE,
  CAPABLE_CARD,
  CAPABLE_SYSTEM,
  LOCAL_LINE,
  RAILS,
  capableMessages,
  capableResult,
  wordingOf,
} from '../lib/model-wording.mjs';

/**
 * What the small local model is given (« rails ») does not change by a character when the remote
 * models get their own wording: the definitions of the tools for the workflows shipped with Moodix,
 * the notes the application writes for it, and a whole request as llama.cpp receives it, compared
 * with what 0.6.39 sent (tests/fixtures/rails-wording.json). `UPDATE_RAILS=1` writes it again: only
 * when a change for the local model is meant (0.6.48: the `series` of create_image, several images
 * in one call).
 */
const snapshotPath = fileURLToPath(new URL('./fixtures/rails-wording.json', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/fake-tool-engine.mjs', import.meta.url));
const shipped = fileURLToPath(new URL('../runner/workflows/', import.meta.url));

const R1 = '11111111-1111-4111-8111-111111111111',
  R2 = '22222222-2222-4222-8222-222222222222',
  O1 = '33333333-3333-4333-8333-333333333333',
  O2 = '44444444-4444-4444-8444-444444444444';
/** What a conversation of the project can name, as server.mjs (includeTools) describes it. */
const CONTEXTS = {
  generic: undefined,
  fresh: { images: 0, resources: [], takes: [], outputs: [] },
  rich: {
    images: 1,
    resources: [
      { id: R1, type: 'image' },
      { id: R2, type: 'video' },
    ],
    takes: [
      { take: 1, mediaType: 'image' },
      { take: 2, mediaType: 'video' },
      { take: 3, mediaType: 'video' },
    ],
    outputs: [
      { id: O1, mediaType: 'video', count: 1, workflowId: 'e06b6ac9-0d3f-4538-b9ff-bf41cf3ef38f', draft: true },
      { id: O2, mediaType: 'image', count: 2, workflowId: 'fefb88eb-8311-4409-b636-6efbb42e952c', draft: false },
    ],
  },
};

/** The workflows shipped with Moodix, every one ready, as on a computer that has all their files. */
async function shippedCatalog() {
  const workflows = [];
  for (const file of (await readdir(shipped)).filter(name => name.endsWith('.json')).sort())
    workflows.push({ ...JSON.parse(await readFile(join(shipped, file), 'utf8')), ready: true, builtin: true });
  return new ToolCatalog({ list: async () => workflows });
}

/** Everything the application says to the local model that does not depend on a conversation. */
async function railsWording(definitionsOf = (catalog, available) => catalog.definitions(available)) {
  const catalog = await shippedCatalog();
  const definitions = {};
  for (const [name, available] of Object.entries(CONTEXTS)) definitions[name] = await definitionsOf(catalog, available);
  const catalogEntries = [
    { id: R1, reference: 1, label: '#ref1', name: 'renard.png', description: 'Un renard roux', mime: 'image/png' },
    { id: R2, reference: 2, label: '#ref2', name: 'neige.mp4', description: '', mime: 'video/mp4', duration: 4 },
  ];
  return {
    definitions,
    resourceTool,
    outputTool: outputToolFor([{ id: O1, outputs: [{}] }]),
    resourceCatalog: resourceCatalogPrompt(catalogEntries, { cited: [1] }),
    brief: briefMessage(await catalog.lengths('create_video')),
    briefExtend: briefMessage(await catalog.lengths('extend_video')),
    cardBrief: cardBrief(),
    thin: THIN_NOTE,
    seen: SEEN_NOTE,
    cited: citedMessage([{ label: '#ref1', id: R1 }], ['start_image', 'reference']),
    failed: [FAILED_NOTE, FAILED_SETTLED, UNANSWERED],
  };
}

/** A safetensors file whose header says these shapes, its data left sparse. */
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

async function snapshot() {
  return JSON.parse(await readFile(snapshotPath, 'utf8'));
}

/**
 * Moodix with llama.cpp replaced by the scripted engine, which gives back the request it gets; with
 * `remote` (a preset), the same engine reached as that remote service instead, chosen and in use.
 */
async function localMoodix(t, { remote = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'moodix-rails-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputDir = join(root, 'output');
  await mkdir(outputDir);
  const worker = {
    state: 'stopped',
    status() {
      return { state: this.state, error: '', capabilities: { krea2: { ready: true, mediaType: 'image', reason: '' } } };
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
      return { released: true, allocatedGiB: 0, kept: false };
    },
    async request() {
      return {};
    },
  };
  const app = await createApplication({
    fullPrompts: false,
    port: 0,
    dataDir: root,
    outputDir,
    generationWorker: worker,
    openUrl: () => {},
    spawnProcess: (_command, args, options) => spawn(process.execPath, [fixture, ...args], options),
  });
  t.after(() => app.close());
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
  // The files of a Krea 2 workflow, as small as the checks of their headers allow.
  const tensors = {
    model: { 'first.weight': [6144, 64], 'blocks.0.attn.wq.weight': [6144, 6144] },
    textEncoder: { 'model.embed_tokens.weight': [1, 2560] },
    vae: { 'encoder.conv1.weight': [1, 3, 1, 1, 1], 'decoder.conv1.weight': [1, 16, 1, 1, 1] },
  };
  for (const [kind, shape] of Object.entries(tensors)) {
    const path = join(root, kind + '.safetensors');
    await checkpoint(path, shape);
    await api('generation/assets', { id: kind, path, kind, family: 'krea2' });
  }
  const tokenizer = join(root, 'tokenizer');
  await mkdir(tokenizer);
  await writeFile(join(tokenizer, 'tokenizer_config.json'), '{}');
  await writeFile(join(tokenizer, 'vocab.json'), '{"a":0}');
  await writeFile(join(tokenizer, 'merges.txt'), '');
  await api('generation/assets', { id: 'tokenizer', path: tokenizer, kind: 'tokenizer', family: 'krea2' });
  await api('generation/config', { enabled: true, autoAllow: false, maxIterations: 5, pythonPath: process.execPath });
  await api('generation/workflows', {
    schemaVersion: 1,
    id: 'rails-image',
    name: 'Image locale',
    description: 'Creer une image',
    enabled: true,
    pipeline: 'krea2',
    mediaType: 'image',
    components: Object.fromEntries(
      ['model', 'textEncoder', 'tokenizer', 'vae'].map(k => [k, { policy: 'fixed', asset: k }]),
    ),
    parameters: {
      prompt: { policy: 'model', type: 'string' },
      seed: { policy: 'fixed', value: 5 },
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
  await api('config', {
    enginePath: process.execPath,
    modelPath,
    projectorPath: '',
    contextSize: 8192,
    maxOutputTokens: 4096,
    gpuLayers: 0,
  });
  if (remote) {
    // The scripted engine as a service of the Internet would be: its address and its key.
    const port = await freePort(),
      key = 'sk-test-' + randomUUID();
    const service = spawn(
      process.execPath,
      [fixture, '--offline', '--host', '127.0.0.1', '--port', String(port), '--api-key', key],
      { stdio: 'ignore' },
    );
    t.after(() => service.kill());
    for (let i = 0; i < 400; i++) {
      if ((await fetch(`http://127.0.0.1:${port}/health`).catch(() => null))?.status === 401) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const { saved } = await (
      await api('remote/save', {
        preset: remote,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'test-model',
        key,
        vision: true,
      })
    ).json();
    await api('remote/select', { id: saved.id });
  } else await api('start', {}, 202);
  for (let i = 0; i < 400 && (await (await api('status')).json()).state !== 'ready'; i++)
    await new Promise(resolve => setTimeout(resolve, 25));
  // A reference of the project (#ref1), as the page adds one.
  const reference = async () => {
    const uploaded = await fetch(app.url + '/api/resources/upload', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + boot.token,
        'Content-Type': 'image/png',
        'X-Resource-Name': encodeURIComponent('escalier.png'),
      },
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rLkAAAAASUVORK5CYII=',
        'base64',
      ),
    });
    assert.equal(uploaded.status, 201, await uploaded.clone().text());
    // Prepared as the page prepares it (its copy for the model): ready, in the list of the model.
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rLkAAAAASUVORK5CYII=';
    await api('resources/update', {
      id: (await uploaded.json()).id,
      patch: { description: 'Un escalier', prepared: { width: 1, height: 1, frames: [{ url: png, time: null }] } },
    });
  };
  return { api, reference };
}
async function freePort() {
  const probe = netServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

/** A conversation as the page sends it: its line, a creation made, a video waiting on its card, a failure. */
function pageConversation(system) {
  const made = {
      id: 'call_image_1',
      type: 'function',
      function: { name: 'create_image', arguments: '{"prompt":"A red fox in the snow"}' },
    },
    video = {
      id: 'call_video_1',
      type: 'function',
      function: {
        name: 'create_video',
        arguments: '{"prompt":"A fox runs","duration":5,"intention":"Un renard court."}',
      },
    };
  return [
    { role: 'system', content: system },
    { role: 'user', content: 'Fais une image d’un renard dans la neige.' },
    { role: 'assistant', content: '', tool_calls: [made] },
    {
      role: 'tool',
      tool_call_id: made.id,
      content: JSON.stringify({
        status: 'success',
        run_id: O2,
        takes: [4],
        takes_note:
          'Pour l’utilisateur, ces prises s’appellent « PRISE n » (takes, une par sortie) : nomme-les par ce numéro, jamais par run_id. Pour en reprendre une, {"take": n} suffit.',
        use_as_source: { output: O2 },
        workflow: 'Krea 2',
        prompt: 'A red fox in the snow',
        workflow_id: 'fefb88eb-8311-4409-b636-6efbb42e952c',
        workflow_digest: 'abc',
        media_type: 'image',
        parameters: { seed: 7, width: 1024, height: 1024 },
        reference_default_count: 0,
        reference_defaults: [],
        reference_count: 0,
        reference_capacity: 1,
        reference_mode: 'pixels',
        outputs: [{ filename: 'a.png', subfolder: '', type: 'output' }],
        note: 'Image générée et affichée à l’utilisateur. Tu ne l’as pas vue : n’écris ni commentaire ni description, ton texte ne serait pas affiché.',
      }),
    },
    { role: 'user', content: 'Fais une vidéo de 5 secondes : un renard court dans la neige.' },
    { role: 'assistant', content: 'Un renard roux traverse la neige.', planned: true, tool_calls: [video] },
    {
      role: 'tool',
      tool_call_id: video.id,
      content: JSON.stringify({
        status: 'denied',
        cancelled: 'card',
        message: 'L’utilisateur a refusé cette génération. Ne réessaie pas sans nouvelle demande.',
      }),
    },
    { role: 'user', content: 'inspect tool context' },
  ];
}

/** What llama.cpp (or the service of `remote`) receives for that conversation: its messages and its tools. */
async function localRequest(t, remote = null, { withReference = false } = {}) {
  const { api, reference } = await localMoodix(t, { remote });
  if (withReference) await reference();
  const streamed = await (
    await api('chat', {
      messages: pageConversation(
        LOCAL_LINE +
          '\n\nContexte fourni par l’utilisateur au démarrage de cette conversation :\nTout en noir et blanc.',
      ),
      conversationId: '55555555-5555-4555-8555-555555555555',
      turnId: '66666666-6666-4666-8666-666666666666',
      thinking: false,
      project: 'inbox',
    })
  ).text();
  const payload = streamed
    .split(/\r?\n\r?\n/)
    .filter(frame => frame.startsWith('data: ') && frame !== 'data: [DONE]')
    .map(frame => JSON.parse(frame.slice(6)))
    .find(event => event.local_test_payload).local_test_payload;
  return { messages: payload.messages, tools: payload.tools, tool_choice: payload.tool_choice };
}

test('the local model gets the definitions, notes and consigne of 0.6.39, to the character', async () => {
  if (process.env.UPDATE_RAILS === '1') return;
  const kept = await snapshot();
  assert.deepEqual(JSON.parse(JSON.stringify(await railsWording())), kept.wording);
});

test('a whole request of the chat reaches llama.cpp as it did in 0.6.39', { timeout: 30000 }, async t => {
  const request = await localRequest(t);
  if (process.env.UPDATE_RAILS === '1') {
    await writeFile(
      snapshotPath,
      JSON.stringify(
        { version: '0.6.39', wording: JSON.parse(JSON.stringify(await railsWording())), request },
        null,
        1,
      ) + '\n',
    );
    return;
  }
  assert.deepEqual(request, (await snapshot()).request);
});

test('the line of the local model is the one the page sends, and only ChatGPT, Claude and OpenRouter get the other wording', async () => {
  const app = await readFile(fileURLToPath(new URL('../public/app.js', import.meta.url)), 'utf8');
  assert.ok(app.includes(`'${LOCAL_LINE}'`), 'public/app.js sends LOCAL_LINE');
  assert.equal(wordingOf(null), RAILS);
  for (const preset of ['chatgpt', 'claude', 'openrouter']) assert.equal(wordingOf({ preset }), CAPABLE, preset);
  // Another service may well be a small model on this computer: the rails.
  for (const preset of ['custom', 'ollama', 'lmstudio', 'openai', 'mistral', 'groq'])
    assert.equal(wordingOf({ preset }), RAILS, preset);
});

test('a capable model reads the facts of a result: no order, no identifier it is never to name', () => {
  const [, , , made, , , refused] = capableMessages(pageConversation(LOCAL_LINE + '\n\nContexte : noir et blanc.'));
  const facts = JSON.parse(made.content);
  assert.deepEqual(Object.keys(facts).sort(), [
    'media_type',
    'parameters',
    'prompt',
    'run_id',
    'status',
    'takes',
    'workflow',
  ]);
  assert.deepEqual([facts.takes, facts.parameters.seed], [[4], 7]);
  assert.deepEqual(JSON.parse(refused.content), { status: 'denied', cancelled: 'card' });
  // What failed is a fact; what to do about it is said once in the consigne.
  const failed = JSON.parse(
    capableResult(JSON.stringify({ status: 'error', message: 'Mémoire insuffisante.', note: FAILED_NOTE })),
  );
  assert.deepEqual(failed, { status: 'error', message: 'Mémoire insuffisante.' });
  // The application's own answers stay: a prompt too thin, images shown before a call.
  for (const message of [THIN_NOTE, SEEN_NOTE])
    assert.equal(JSON.parse(capableResult(JSON.stringify({ status: 'nothing_generated', message }))).message, message);
  // The words over a card asked in the wording of the small model: in the capable one.
  assert.equal(
    JSON.parse(capableResult(JSON.stringify({ status: 'waiting_for_user', message: cardBrief() }))).message,
    CAPABLE_CARD,
  );
  // A result that is not JSON, and a looked-at result, keep what they say.
  assert.equal(capableResult('texte libre'), 'texte libre');
  const looked = JSON.parse(
    capableResult(
      JSON.stringify({ status: 'success', analysis_outputs: [], reference_count: 1, reference_mode: 'pixels' }),
    ),
  );
  assert.deepEqual([looked.reference_count, looked.reference_mode], [1, 'pixels']);
});

test('a capable model gets the consigne of Moodix in place of the local line, the user’s context after it', () => {
  const [system, user] = capableMessages([
    { role: 'system', content: LOCAL_LINE + '\n\nContexte fourni : noir et blanc.' },
    { role: 'user', content: LOCAL_LINE },
  ]);
  assert.equal(system.content, CAPABLE_SYSTEM + '\n\nContexte fourni : noir et blanc.');
  assert.equal(user.content, LOCAL_LINE, 'only the system line');
  // No name of a tool, no number: the same words at every request, kept in the cache of a provider.
  for (const name of ['create_', 'extend_video', 'replace_character', 'upscale', 'interpolate', 'local_read'])
    assert.equal(CAPABLE_SYSTEM.includes(name), false, name);
  assert.ok(CAPABLE_SYSTEM.length < 4000, 'a few hundred tokens');
  // Nothing of what follows a call: a small model wrote it in place of the call (« La carte est prête »).
  assert.doesNotMatch(CAPABLE_SYSTEM, /as soon as you call|asks you for|card/i);
  // A model that sees no image is told so, after the consigne.
  assert.equal(
    capableMessages([{ role: 'system', content: LOCAL_LINE }], { vision: false })[0].content,
    CAPABLE_SYSTEM + BLIND,
  );
});

test('the tools of a capable model are contracts: no plan agreed in words, every argument said, workflows by name', async () => {
  const catalog = await shippedCatalog(),
    generic = await catalog.definitions(undefined, { wording: CAPABLE });
  for (const [context, available] of Object.entries(CONTEXTS)) {
    const tools = await catalog.definitions(available, { wording: CAPABLE }),
      rails = await catalog.definitions();
    // Whatever the conversation holds, the same definitions, to the character: the cache of the
    // provider keeps them from one request to the next, one project to another, after a creation.
    assert.equal(JSON.stringify(tools), JSON.stringify(generic), context);
    // The tools and arguments of the local model when nothing narrows them, sources by number.
    const shape = list =>
      list.map(tool => [
        tool.function.name,
        Object.keys(tool.function.parameters.properties),
        tool.function.parameters.required,
      ]);
    assert.deepEqual(shape(tools), shape(rails), context);
    assert.doesNotMatch(
      JSON.stringify(tools),
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
      'no identifier',
    );
    const text = JSON.stringify(tools);
    for (const staging of [
      /agree (on|with)/i,
      /five lines/i,
      /without a tool/i,
      /no headings/i,
      /once they answered/i,
      /must confirm every video/i,
      /Never write the length/i,
    ])
      assert.doesNotMatch(text, staging, `${context}: ${staging}`);
    for (const tool of tools)
      for (const [key, property] of Object.entries(tool.function.parameters.properties))
        assert.ok(property.description, `${context}: ${tool.function.name}.${key} is described`);
  }
  const video = (await catalog.definitions(CONTEXTS.rich, { wording: CAPABLE })).find(
    tool => tool.function.name === 'create_video',
  ).function;
  assert.deepEqual(video.parameters.properties.workflow.enum, ['MiniMax H3 Omni', 'LTX 2.5']);
  assert.match(video.description, /\n- LTX 2\.5\. /);
  assert.doesNotMatch(video.description, /eaec4e2f/);
  // A workflow passed by its name is the one used.
  const routed = await catalog.route(
    'create_video',
    { prompt: 'A fox runs in the snow.', duration: 5, intention: 'Un renard.', workflow: 'LTX 2.5' },
    { mediaOf: async () => 'image' },
  );
  assert.equal(routed.workflow.name, 'LTX 2.5');
  // Two workflows of a verb with the same name: their ids, as for the local model.
  const twins = new ToolCatalog({
    list: async () =>
      (await catalog.workflows.list())
        .filter(workflow => workflow.mediaType === 'audio')
        .map(workflow => ({ ...workflow, name: 'Son' })),
  });
  const audio = (await twins.definitions(CONTEXTS.fresh, { wording: CAPABLE })).find(
    tool => tool.function.name === 'create_audio',
  ).function;
  assert.ok(audio.parameters.properties.workflow.enum.every(value => /^[0-9a-f-]{36}$/.test(value)));
  // Sources by their numbers: a take, a reference (#ref2 is 2), a frame of a video reference.
  const source = video.parameters.properties.start_image;
  assert.deepEqual(Object.keys(source.properties), ['take', 'ref', 'frame', 'image', 'output', 'index']);
  assert.match(video.description, /\{"ref": n\} the reference #refN/);
});

test('a reference named by its number is made the reference of the project, a number that is none refused', () => {
  const catalog = [
    { id: R1, reference: 1, label: '#ref1' },
    { id: R2, reference: 2, label: '#ref2' },
  ];
  assert.deepEqual(
    JSON.parse(
      refsToIds(
        JSON.stringify({ prompt: 'p', start_image: { ref: 2, frame: 1 }, reference: [{ ref: 1 }, { take: 3 }] }),
        catalog,
      ),
    ),
    { prompt: 'p', start_image: { frame: 1, resource: R2 }, reference: [{ resource: R1 }, { take: 3 }] },
  );
  assert.deepEqual(JSON.parse(refsToIds('{"refs":[2,1]}', catalog)), { resource_ids: [R2, R1] });
  // Without a number, the arguments come back as they were, to the character.
  const plain = '{"prompt":"p","source":{"resource":"' + R1 + '"}}';
  assert.equal(refsToIds(plain, catalog), plain);
  assert.equal(refsToIds('pas du JSON', catalog), 'pas du JSON');
  assert.throws(() => refsToIds('{"refs":[9]}', catalog), /La référence #ref9 n’existe pas dans ce projet\./);
  assert.throws(() => refsToIds('{"source":{"ref":9}}', catalog), /#ref9/);
  // Told to a capable model by its number, to the local one by its id.
  assert.match(
    citedMessage([{ label: '#ref2', id: R2, reference: 2 }], null, { byNumber: true }),
    /#ref2 \(\{"ref": 2\}\)/,
  );
  assert.match(
    citedMessage([{ label: '#ref2', id: R2, reference: 2 }]),
    new RegExp(`#ref2 \\(\\{"resource": "${R2}"\\}\\)`),
  );
});

test(
  'through the application: OpenRouter gets the capable wording, another service the local one',
  { timeout: 60000 },
  async t => {
    const capable = await localRequest(t, 'openrouter', { withReference: true });
    assert.ok(capable.messages[0].content.startsWith(CAPABLE_SYSTEM));
    assert.ok(capable.messages[0].content.endsWith('Tout en noir et blanc.'));
    // The references of the project at the end of the user's last message, without their ids: the
    // consigne, the tools and the history stay the same from one project to another.
    const asked = capable.messages.at(-1).content;
    assert.match(
      asked,
      /^inspect tool context\n\n\[References of the project, added by Moodix .*"label":"#ref1".*Un escalier.*\]$/s,
    );
    assert.doesNotMatch(asked, /"id":/);
    assert.equal(
      capable.messages.filter(message => /References of the project/.test(JSON.stringify(message.content))).length,
      1,
    );
    assert.equal(JSON.parse(capable.messages[3].content).note, undefined);
    assert.doesNotMatch(capable.tools[0].function.description, /Workflows:\n- rails-image:/);
    // Its two readings by number, and not one identifier in its tools: the same at every request.
    assert.deepEqual(
      capable.tools.slice(-2).map(tool => tool.function.name),
      ['local_read_resource', 'local_read_output'],
    );
    assert.deepEqual(Object.keys(capable.tools.at(-2).function.parameters.properties), ['refs']);
    assert.doesNotMatch(JSON.stringify(capable.tools), /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    // Another service « compatible OpenAI » keeps the words of the local model, to the character.
    const other = await localRequest(t, 'custom'),
      kept = (await snapshot()).request;
    assert.deepEqual([other.messages, other.tools], [kept.messages, kept.tools]);
  },
);
