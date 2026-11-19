import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GenerationService, generationConfig } from '../lib/generation-service.mjs';
import { createApplication } from '../server.mjs';

test('checkpoint directory defaults to this installation, custom paths persist and old settings still load', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-folders-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
      root,
      dataDir: join(root, 'data'),
      workflowDir: join(root, 'workflow'),
      outputDir: join(root, 'output'),
    },
    service = await new GenerationService(options).init();
  assert.equal((await service.snapshot()).folders.model, join(root, 'models', 'diffusion_models'));
  assert.equal(service.folders().lora, join(root, 'models', 'loras'));
  const custom = join(root, 'custom checkpoints');
  await service.save({ ...service.config, modelRoot: custom });
  await service.close();
  const reopened = await new GenerationService(options).init();
  assert.equal(reopened.config.modelRoot, custom);
  assert.equal(reopened.folders().model, custom);
  await reopened.close();
  const { modelRoot, ...legacy } = service.config;
  assert.equal(generationConfig(legacy).modelRoot, '');
  assert.throws(() => generationConfig({ ...legacy, modelRoot: 'relative/path' }), /absolu/);
});

test('VAE and LoRA folder overrides persist, cover audio VAEs and reject invalid paths without losing saved settings', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-component-folders-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    root,
    dataDir: join(root, 'data'),
    workflowDir: join(root, 'workflow'),
    outputDir: join(root, 'output'),
  };
  const service = await new GenerationService(options).init();
  const vaeRoot = join(root, 'external VAE'),
    loraRoot = join(root, 'external LoRA');
  await service.save({ ...service.config, vaeRoot, loraRoot });
  await service.close();
  const reopened = await new GenerationService(options).init();
  t.after(() => reopened.close());
  assert.equal(reopened.folders().vae, vaeRoot);
  assert.equal(reopened.folders().audioVae, vaeRoot);
  assert.equal(reopened.folders().lora, loraRoot);
  assert.equal(reopened.folders().textEncoder, join(root, 'models', 'text_encoders'));
  await assert.rejects(reopened.save({ ...reopened.config, vaeRoot: '../relative' }), /absolu/);
  await assert.rejects(reopened.save({ ...reopened.config, loraRoot: '\0bad' }), /invalide/);
  assert.equal(reopened.folders().vae, vaeRoot);
  await reopened.save({ ...reopened.config, vaeRoot: '', loraRoot: '' });
  assert.equal(reopened.folders().vae, join(root, 'models', 'vae'));
  assert.equal(reopened.folders().lora, join(root, 'models', 'loras'));
});

test('HTTP import finds VAE and LoRA files in edited folders before configuration is saved', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-folder-import-'));
  const modelRoot = join(root, 'checkpoints'),
    vaeRoot = join(root, 'external VAE'),
    loraRoot = join(root, 'external LoRA');
  for (const directory of [modelRoot, vaeRoot, loraRoot]) await mkdir(directory);
  async function weights(path, shapes) {
    let offset = 0;
    const header = {};
    for (const [key, shape] of Object.entries(shapes)) {
      const length = shape.reduce((a, b) => a * b, 4);
      header[key] = { dtype: 'F32', shape, data_offsets: [offset, offset + length] };
      offset += length;
    }
    const bytes = Buffer.from(JSON.stringify(header)),
      prefix = Buffer.alloc(8);
    prefix.writeBigUInt64LE(BigInt(bytes.length));
    await writeFile(path, Buffer.concat([prefix, bytes, Buffer.alloc(offset)]));
  }
  const vaePath = join(vaeRoot, 'decoder.safetensors'),
    loraPath = join(loraRoot, 'style.safetensors');
  await weights(vaePath, { 'encoder.conv1.weight': [1, 3, 1, 1, 1], 'decoder.conv1.weight': [1, 16, 1, 1, 1] });
  await weights(loraPath, { 'layer.lora_A.weight': [1, 1], 'layer.lora_B.weight': [1, 1] });
  const app = await createApplication({ port: 0, dataDir: join(root, 'data'), modelsDir: join(root, 'models') });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const boot = await (await fetch(app.url + '/api/bootstrap')).json();
  const response = await fetch(app.url + '/api/generation/import', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + boot.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      modelRoot,
      vaeRoot,
      loraRoot,
      sourceText: JSON.stringify({
        encoder: { class_type: 'CLIPLoader', inputs: { type: 'krea2' } },
        vae: { class_type: 'VAELoader', inputs: { vae_name: 'decoder.safetensors' } },
        lora: { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'style.safetensors', strength_model: 0.5 } },
      }),
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.assets.find(asset => asset.kind === 'vae').path, await realpath(vaePath));
  assert.equal(result.assets.find(asset => asset.kind === 'lora').path, await realpath(loraPath));
  const saved = await (
    await fetch(app.url + '/api/generation', { headers: { Authorization: 'Bearer ' + boot.token } })
  ).json();
  assert.equal(saved.config.vaeRoot, '');
  assert.equal(saved.config.loraRoot, '');
});

test('HTTP import validation does not save a workflow and browse defaults follow the registered folders', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-folder-http-')),
    models = join(root, 'models'),
    calls = [];
  const app = await createApplication({
    port: 0,
    dataDir: root,
    modelsDir: models,
    filePicker: async (kind, { initialPath }) => {
      calls.push({ kind, initialPath });
      return null;
    },
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const boot = await (await fetch(app.url + '/api/bootstrap')).json(),
    api = (route, body) =>
      fetch(app.url + '/api/' + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + boot.token, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
  const template = (await (await api('generation/templates?pipeline=krea2')).json()).template;
  assert.equal((await api('generation/validate', template)).status, 200);
  assert.equal((await api('generation/validate', { ...template, parameters: null })).status, 400);
  assert.deepEqual((await (await api('generation/workflows')).json()).workflows, []);
  const unsupported = await api('generation/import-comfy', { sourceText: JSON.stringify({ nodes: [] }) });
  assert.equal(unsupported.status, 400);
  assert.match((await unsupported.json()).error, /compatible/);
  assert.deepEqual((await (await api('generation/workflows')).json()).workflows, []);
  const generation = await (await api('generation')).json();
  assert.match(generation.folders.model, /[\\/]models[\\/]diffusion_models$/);
  const custom = join(root, 'another checkpoint folder');
  assert.equal((await api('generation/config', { ...generation.config, modelRoot: custom })).status, 200);
  for (const kind of ['directory', 'workflow', 'model', 'projector'])
    assert.equal((await api('files/choose', { kind })).status, 200);
  assert.equal(calls[0].initialPath, custom);
  assert.match(calls[1].initialPath, /[\\/]workflow$/);
  assert.equal(calls[2].initialPath, join(models, 'LLMs'));
  assert.equal(calls[3].initialPath, join(models, 'vision'));
});

test('closing during asynchronous worker setup cannot spawn an orphan after shutdown', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-start-close-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let starts = 0;
  const worker = {
    status: () => ({ state: 'stopped', capabilities: {} }),
    close: async () => {},
    start: async () => {
      starts++;
    },
  };
  const service = new GenerationService({
    root,
    dataDir: root,
    workflowDir: join(root, 'workflow'),
    outputDir: join(root, 'output'),
    worker,
  });
  const starting = service.start(),
    rejected = assert.rejects(starting, /fermé/);
  await service.close();
  await rejected;
  assert.equal(starts, 0);
  await assert.rejects(service.start(), /fermé/);
});

test('private setup remains visible and cancelling a generation wait does not leave shutdown blocked', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-setup-close-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let begin,
    reject,
    started = 0;
  const entered = new Promise(resolve => {
      begin = resolve;
    }),
    worker = {
      status: () => ({ state: 'stopped', capabilities: {} }),
      close: async () => {},
      start: async () => {
        started++;
      },
    };
  const environment = {
    state: 'idle',
    status() {
      return { state: this.state, progress: 'Installation…', error: '' };
    },
    ensure() {
      this.state = 'installing';
      begin();
      return new Promise((_, no) => {
        reject = no;
      });
    },
    async cancel() {
      reject?.(Error('Setup cancelled'));
      this.state = 'idle';
    },
    async close() {
      await this.cancel();
    },
  };
  const service = new GenerationService({
      root,
      dataDir: root,
      workflowDir: join(root, 'workflow'),
      outputDir: join(root, 'output'),
      worker,
      environment,
    }),
    controller = new AbortController();
  const pending = service.client().status({ signal: controller.signal }),
    cancelled = assert.rejects(pending, /abort/i);
  await entered;
  assert.equal((await service.snapshot()).runner.state, 'installing');
  controller.abort();
  await cancelled;
  await service.close();
  assert.equal(started, 0);
  await assert.rejects(service.start(), /fermé/);
});

test('an explicit Python override bypasses private installation and receives app-only caches', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-custom-python-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let chosen;
  const worker = {
      status: () => ({ state: 'ready', capabilities: {} }),
      close: async () => {},
      start: async config => {
        chosen = config;
      },
    },
    environment = {
      status: () => ({ state: 'idle' }),
      ensure: async () => {
        throw Error('Must not install into custom Python');
      },
      close: async () => {},
    };
  const service = new GenerationService({
    root,
    dataDir: root,
    workflowDir: join(root, 'workflow'),
    outputDir: join(root, 'output'),
    worker,
    environment,
  });
  service.config.pythonPath = process.execPath;
  await service.start();
  assert.equal(chosen.pythonPath, process.execPath);
  assert.equal(chosen.env.UV_PROJECT_ENVIRONMENT, join(root, 'runtime', 'venv'));
  await service.close();
});

test('disabling generation cancels private preparation and does not restart it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-setup-disable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let begin,
    reject,
    starts = 0;
  const entered = new Promise(resolve => {
    begin = resolve;
  });
  const environment = {
      status: () => ({ state: 'installing' }),
      ensure() {
        begin();
        return new Promise((_, no) => {
          reject = no;
        });
      },
      async cancel() {
        reject?.(Error('Setup cancelled'));
      },
      close: async () => {},
    },
    worker = {
      status: () => ({ state: 'stopped', capabilities: {} }),
      close: async () => {},
      start: async () => {
        starts++;
      },
    };
  const service = new GenerationService({
    root,
    dataDir: root,
    workflowDir: join(root, 'workflow'),
    outputDir: join(root, 'output'),
    environment,
    worker,
  });
  service.config.enabled = true;
  const starting = service.start(),
    rejected = assert.rejects(starting, /cancelled/);
  await entered;
  await service.save({ ...service.config, enabled: false });
  await rejected;
  assert.equal(starts, 0);
  assert.equal(service.config.enabled, false);
  await service.close();
});

test(
  'environment verification acknowledges startup without holding the settings request open',
  { timeout: 5000 },
  async t => {
    const root = await mkdtemp(join(tmpdir(), 'native-setup-http-'));
    let release, entered;
    const starting = new Promise(resolve => {
        entered = resolve;
      }),
      gate = new Promise(resolve => {
        release = resolve;
      });
    let state = 'stopped';
    const worker = {
      status: () => ({ state, capabilities: {} }),
      start: async () => {
        state = 'starting';
        entered();
        await gate;
        state = 'ready';
      },
      close: async () => {
        if (state === 'starting') release();
        state = 'stopped';
      },
    };
    const app = await createApplication({ port: 0, dataDir: root, generationWorker: worker });
    t.after(async () => {
      release();
      await app.close();
      await rm(root, { recursive: true, force: true });
    });
    const boot = await (await fetch(app.url + '/api/bootstrap')).json();
    const response = await fetch(app.url + '/api/generation/test', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + boot.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: false,
        autoAllow: false,
        maxIterations: 5,
        pythonPath: process.execPath,
        tokenizerPath: '',
      }),
      signal: AbortSignal.timeout(1000),
    });
    assert.equal(response.status, 200);
    await starting;
    const status = await (
      await fetch(app.url + '/api/status', { headers: { Authorization: 'Bearer ' + boot.token } })
    ).json();
    assert.equal(status.runner.state, 'starting');
    release();
  },
);

test('launch reconciles an existing private environment even with generation disabled, but skips fresh and external setups', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-reconcile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let present = false,
    checks = 0,
    starts = 0,
    probes = 0;
  const environment = {
      status: () => ({ state: 'idle' }),
      exists: async () => {
        probes++;
        return present;
      },
      ensure: async () => {
        checks++;
      },
      close: async () => {},
    },
    worker = {
      status: () => ({ state: 'stopped', capabilities: {} }),
      start: async () => {
        starts++;
      },
      close: async () => {},
    };
  const service = new GenerationService({
    root,
    dataDir: root,
    workflowDir: join(root, 'workflow'),
    outputDir: join(root, 'output'),
    worker,
    environment,
  });
  // Generation switched off: an environment already there is brought up to date, nothing more.
  service.config.enabled = false;
  await service.prepareOnLaunch();
  assert.equal(checks, 0);
  present = true;
  await service.prepareOnLaunch();
  assert.equal(checks, 1);
  assert.equal(starts, 0);
  service.config.pythonPath = process.execPath;
  await service.prepareOnLaunch();
  assert.equal(checks, 1);
  assert.equal(probes, 2);
  // On, as by default: the engine starts with the application only once its environment is
  // there; a new installation downloads nothing at launch.
  service.config.pythonPath = '';
  service.config.enabled = true;
  present = false;
  await service.prepareOnLaunch();
  assert.equal(checks, 1);
  assert.equal(starts, 0);
  present = true;
  await service.prepareOnLaunch();
  assert.equal(checks, 2);
  assert.equal(starts, 1);
  assert.equal(probes, 4);
  await service.close();
  await service.prepareOnLaunch();
  assert.equal(probes, 4);
});

test('the engine is told to import its libraries as it starts, unless the user turned that off (0.6.105)', async t => {
  // Its first creation of a session paid them: six seconds, eighteen just after the computer started.
  const root = await mkdtemp(join(tmpdir(), 'native-warm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = [],
    worker = {
      status: () => ({ state: 'ready', busy: false, capabilities: {} }),
      // What the worker is given to read: its configuration file, as it is when it starts.
      start: async config => void started.push(JSON.parse(await readFile(config.configPath, 'utf8'))),
      close: async () => {},
    },
    service = await new GenerationService({
      root,
      dataDir: join(root, 'data'),
      workflowDir: join(root, 'workflow'),
      outputDir: join(root, 'output'),
      worker,
      environment: {
        close: async () => {},
        status: () => ({ state: 'ready' }),
        exists: async () => true,
        ensure: async () => process.execPath,
      },
    }).init();
  t.after(() => service.close());
  await service.start();
  assert.equal(started.at(-1).warm, true, 'on from the start');
  await service.save({ ...service.config, warmEngine: false });
  await service.start();
  assert.equal(started.at(-1).warm, false, 'turned off: the next start imports nothing ahead');
  // Settings saved before it existed: on. Anything but yes or no is refused.
  const { warmEngine, ...before } = service.config;
  assert.equal(warmEngine, false);
  assert.equal(generationConfig(before).warmEngine, true);
  assert.throws(() => generationConfig({ ...before, warmEngine: 'yes' }), /invalides/);
});

test('an engine that imports its libraries as it starts is their check; one it cannot import brings the check back (0.6.110)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-trust-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const asked = [],
    events = [];
  let trusted = true,
    early = false;
  const worker = {
      state: 'stopped',
      status() {
        return { state: this.state, busy: false, capabilities: {} };
      },
      async start() {
        events.push('start');
        this.state = 'ready';
        if (!early) return;
        // Said by the worker before the application's own start has ended.
        early = false;
        this.onLibrariesFailed('torch: DLL load failed');
        await new Promise(done => setTimeout(done, 30));
      },
      async close() {
        events.push('close');
        this.state = 'stopped';
      },
    },
    service = await new GenerationService({
      root,
      dataDir: join(root, 'data'),
      workflowDir: join(root, 'workflow'),
      outputDir: join(root, 'output'),
      worker,
      environment: {
        close: async () => {},
        status: () => ({ state: 'ready' }),
        exists: async () => true,
        ensure: async options => {
          asked.push(options);
          events.push('ensure');
          return process.execPath;
        },
        // Whether this start had skipped the check, as lib/python-environment.mjs says it.
        distrust: async () => {
          events.push('distrust');
          const was = trusted;
          trusted = false;
          return was;
        },
      },
    }).init();
  t.after(() => service.close());
  await service.start();
  assert.deepEqual(asked.at(-1), { engineReads: true }, 'it reads them as it starts: the check may be skipped');
  // The worker says it could not import a library, in an environment taken as checked at this start:
  // it is stopped and started again, and that start checks (what it then says is said as before).
  events.length = 0;
  worker.onLibrariesFailed('torch: DLL load failed');
  for (let turn = 0; turn < 400 && events.at(-1) !== 'start'; turn++) await new Promise(done => setTimeout(done, 5));
  assert.deepEqual(events, ['distrust', 'close', 'ensure', 'start']);
  // Checked at this start: the failure is the creation's own, the engine is left as it is.
  events.length = 0;
  worker.onLibrariesFailed('diffusers: gone');
  await new Promise(done => setTimeout(done, 30));
  assert.deepEqual(events, ['distrust']);
  // An engine told to import nothing ahead: the check stays what reads the libraries.
  await service.save({ ...service.config, warmEngine: false });
  await service.start();
  assert.deepEqual(asked.at(-1), { engineReads: false });
  // Said while the start that skipped the check is still on its way: that start ends first, and a
  // new one is made, which checks (asked for at once, it would have been the one on its way).
  await service.save({ ...service.config, warmEngine: true });
  trusted = early = true;
  events.length = 0;
  await service.start();
  for (let turn = 0; turn < 400 && events.length < 6; turn++) await new Promise(done => setTimeout(done, 5));
  assert.deepEqual(events, ['ensure', 'start', 'distrust', 'close', 'ensure', 'start']);
});
