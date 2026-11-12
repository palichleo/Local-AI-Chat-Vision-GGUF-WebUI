import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelDownloads, formatBytes } from '../lib/model-downloads.mjs';

const MODEL = Buffer.from('model weights '.repeat(200)),
  VOCAB = Buffer.from('{"a":1}'),
  sha = data => createHash('sha256').update(data).digest('hex');

async function fixture(t, { catalog, free = 1024 ** 4 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'atelier-downloads-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const models = join(root, 'models');
  const catalogPath = join(root, 'downloads.json');
  await writeFile(
    catalogPath,
    JSON.stringify(
      catalog ?? {
        'krea2Turbo.safetensors': {
          repo: 'Org/Krea',
          revision: 'abc',
          path: 'diffusion_models/krea2_turbo.safetensors',
          size: MODEL.length,
          sha256: sha(MODEL),
        },
        tokenizer: {
          repo: 'Org/Tokenizer',
          revision: 'def',
          folder: true,
          size: VOCAB.length,
          files: [{ path: 'vocab.json', size: VOCAB.length }],
        },
      },
    ),
  );
  const registered = new Map(),
    requests = [];
  const assets = {
    async resolve(id) {
      if (registered.has(id)) return { path: registered.get(id).path };
      throw new Error(`Asset ${id} not found`);
    },
    async register(asset) {
      registered.set(asset.id, asset);
      return asset;
    },
  };
  const bodies = { 'krea2_turbo.safetensors': MODEL, 'vocab.json': VOCAB };
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, headers: options.headers || {} });
    const name = decodeURIComponent(url.split('/').at(-1));
    const body = bodies[name];
    if (!body) return new Response('missing', { status: 404 });
    const range = options.headers?.Range?.match(/^bytes=(\d+)-$/);
    const part = range ? body.subarray(Number(range[1])) : body;
    return new Response(part, { status: range ? 206 : 200 });
  };
  const downloads = new ModelDownloads({
    catalogPath,
    dataDir: root,
    assets,
    folderOf: (family, role) => join(models, role === 'model' ? 'diffusion_models' : 'text_encoders'),
    fetchImpl,
    statfs: async () => ({ bavail: free, bsize: 1 }),
  });
  const workflow = {
    id: 'krea',
    name: 'Krea 2',
    pipeline: 'krea2',
    builtin: true,
    ready: false,
    components: {
      model: { policy: 'fixed', asset: 'model-asset', file: 'krea2Turbo.safetensors' },
      tokenizer: { policy: 'fixed', asset: 'tokenizer-asset', file: 'tokenizer' },
    },
  };
  const finish = async () => {
    await downloads.task;
    return downloads.status();
  };
  return { root, models, downloads, workflow, registered, requests, bodies, finish };
}

test('a shipped workflow offers what it lacks, and the files land in their folders, registered for it', async t => {
  const f = await fixture(t);
  const offers = await f.downloads.offers([f.workflow, { ...f.workflow, id: 'mine', builtin: false }]);
  assert.deepEqual(Object.keys(offers), ['krea']);
  assert.equal(offers.krea.bytes, MODEL.length + VOCAB.length);
  assert.equal(offers.krea.complete, true);
  assert.equal(offers.krea.needsToken, false);
  await f.downloads.start(f.workflow);
  const done = await f.finish();
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.received, done.total);
  // Under the name of its source, in the folder of its kind; a folder takes its name once complete.
  const model = join(f.models, 'diffusion_models', 'krea2_turbo.safetensors');
  assert.deepEqual(await readFile(model), MODEL);
  assert.deepEqual(await readFile(join(f.models, 'text_encoders', 'tokenizer', 'vocab.json')), VOCAB);
  assert.equal(f.registered.get('model-asset').path, model);
  assert.equal(f.registered.get('model-asset').kind, 'model');
  assert.equal(f.registered.get('tokenizer-asset').path, join(f.models, 'text_encoders', 'tokenizer'));
  assert.equal(f.requests[0].url, 'https://huggingface.co/Org/Krea/resolve/abc/diffusion_models/krea2_turbo.safetensors');
  assert.deepEqual(await f.downloads.offers([f.workflow]), {}, 'nothing left to offer');
});

test('a download resumes from its .part file and checks the whole file', async t => {
  const f = await fixture(t);
  const folder = join(f.models, 'diffusion_models');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'krea2_turbo.safetensors.part'), MODEL.subarray(0, 1000));
  await f.downloads.start({ ...f.workflow, components: { model: f.workflow.components.model } });
  const done = await f.finish();
  assert.equal(done.state, 'done', done.error);
  assert.equal(f.requests[0].headers.Range, 'bytes=1000-');
  assert.deepEqual(await readFile(join(folder, 'krea2_turbo.safetensors')), MODEL);
});

test('a folder stopped after one of its files fetches only the others when it starts again', async t => {
  const f = await fixture(t, {
    catalog: {
      tokenizer: {
        repo: 'Org/Tokenizer',
        revision: 'def',
        folder: true,
        size: MODEL.length + VOCAB.length,
        files: [
          { path: 'krea2_turbo.safetensors', size: MODEL.length, sha256: sha(MODEL) },
          { path: 'vocab.json', size: VOCAB.length },
        ],
      },
    },
  });
  const staging = join(f.models, 'text_encoders', 'tokenizer.download');
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, 'krea2_turbo.safetensors'), MODEL);
  await writeFile(join(staging, 'vocab.json.part'), VOCAB.subarray(0, 3));
  const workflow = { ...f.workflow, components: { tokenizer: f.workflow.components.tokenizer } };
  const offer = (await f.downloads.offers([workflow])).krea;
  assert.equal(offer.bytes, MODEL.length + VOCAB.length);
  assert.equal(offer.left, VOCAB.length - 3, 'what a stopped download holds is not counted again');
  const started = await f.downloads.start({ ...f.workflow, components: { tokenizer: f.workflow.components.tokenizer } });
  assert.equal(started.received, MODEL.length + 3);
  const done = await f.finish();
  assert.equal(done.state, 'done', done.error);
  assert.deepEqual(
    f.requests.map(request => [request.url.split('/').at(-1), request.headers.Range]),
    [['vocab.json', 'bytes=3-']],
  );
  assert.deepEqual(await readFile(join(f.models, 'text_encoders', 'tokenizer', 'krea2_turbo.safetensors')), MODEL);
  assert.deepEqual(await readFile(join(f.models, 'text_encoders', 'tokenizer', 'vocab.json')), VOCAB);
});

test('a file that is not the original is deleted, and the download says so', async t => {
  const f = await fixture(t);
  f.bodies['krea2_turbo.safetensors'] = Buffer.from('x'.repeat(MODEL.length));
  await f.downloads.start({ ...f.workflow, components: { model: f.workflow.components.model } });
  const done = await f.finish();
  assert.equal(done.state, 'error');
  assert.match(done.error, /ne correspond pas/);
  const folder = join(f.models, 'diffusion_models');
  await assert.rejects(stat(join(folder, 'krea2_turbo.safetensors')));
  await assert.rejects(stat(join(folder, 'krea2_turbo.safetensors.part')));
  assert.equal(f.registered.size, 0);
});

test('a gated source needs the Hugging Face token, sent to Hugging Face only', async t => {
  const f = await fixture(t, {
    catalog: {
      'krea2Turbo.safetensors': {
        repo: 'Org/Krea',
        revision: 'abc',
        path: 'diffusion_models/krea2_turbo.safetensors',
        size: MODEL.length,
        gated: true,
        page: 'https://huggingface.co/Org/Krea',
      },
    },
  });
  const workflow = { ...f.workflow, components: { model: f.workflow.components.model } };
  assert.equal((await f.downloads.offers([workflow])).krea.needsToken, true);
  await assert.rejects(f.downloads.start(workflow), /compte Hugging Face/);
  await assert.rejects(f.downloads.setToken('a b'), /invalide/);
  assert.equal(await f.downloads.setToken(' hf_abcdefghijklmnop '), true);
  assert.equal(await f.downloads.hasToken(), true);
  assert.equal((await f.downloads.offers([workflow])).krea.needsToken, false);
  await f.downloads.start(workflow);
  assert.equal((await f.finish()).state, 'done');
  const download = f.requests.find(request => request.url.includes('/resolve/'));
  assert.equal(download.headers.Authorization, 'Bearer hf_abcdefghijklmnop');
  assert.equal(await f.downloads.setToken(''), false);
  assert.equal(await f.downloads.hasToken(), false);
});

test('nothing starts without room on the disk, for a workflow of the user, or twice at once', async t => {
  const small = await fixture(t, { free: 1000 });
  await assert.rejects(small.downloads.start(small.workflow), /Pas assez de place/);
  const f = await fixture(t);
  await assert.rejects(f.downloads.start({ ...f.workflow, builtin: false }), /fournis avec Atelier/);
  await f.downloads.start(f.workflow);
  await assert.rejects(f.downloads.start(f.workflow), /déjà en cours/);
  await f.finish();
  await assert.rejects(f.downloads.start(f.workflow), /Rien à télécharger/);
  assert.equal(formatBytes(43.7 * 1024 ** 3), '43,7 Go');
  assert.equal(formatBytes(67061725), '64 Mo');
});
