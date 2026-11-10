import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { relocate } from '../lib/relocate.mjs';
import { PythonEnvironment } from '../lib/python-environment.mjs';
import { GenerationAssets } from '../lib/generation-assets.mjs';

async function folder(fn) {
  const root = await mkdtemp(join(tmpdir(), 'atelier-moved-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('paths saved by an installation in another folder find the same file in this one', async () =>
  folder(async root => {
    await mkdir(join(root, 'models', 'LLMs'), { recursive: true });
    const model = join(root, 'models', 'LLMs', 'chat.gguf');
    await writeFile(model, 'GGUF');
    assert.equal(relocate('F:\\Programmation\\prototype-runner\\models\\LLMs\\chat.gguf', root), model);
    assert.equal(relocate('/home/me/old/models/LLMs/chat.gguf', root), model);
    assert.equal(relocate(model, root), model, 'an existing path is kept');
    const missing = 'F:\\elsewhere\\models\\LLMs\\other.gguf';
    assert.equal(relocate(missing, root), missing, 'nothing to find: the saved path is kept');
    assert.equal(relocate('', root), '');
  }));

test('a moved Python runtime points back to its own interpreter instead of being rebuilt', async () =>
  folder(async root => {
    const runtime = join(root, 'data', 'runtime');
    await mkdir(join(runtime, 'venv'), { recursive: true });
    await mkdir(join(runtime, 'python', 'cpython-3.13.14-windows-x86_64-none'), { recursive: true });
    const old = 'F:\\Programmation\\prototype-runner\\data\\runtime\\python\\cpython-3.13.14-windows-x86_64-none';
    await writeFile(join(runtime, 'venv', 'pyvenv.cfg'), `home = ${old}\nimplementation = CPython\n`);
    const environment = new PythonEnvironment({ root, dataDir: join(root, 'data') });
    assert.equal(await environment.relink(), true);
    const text = await readFile(join(runtime, 'venv', 'pyvenv.cfg'), 'utf8');
    assert.equal(
      text,
      `home = ${join(runtime, 'python', 'cpython-3.13.14-windows-x86_64-none')}\nimplementation = CPython\n`,
    );
    assert.equal(await environment.relink(), false, 'nothing left to fix');
  }));

/** A minimal safetensors file whose tensors match the MiniMax-H3 audio VAE signature. */
async function audioVae(path) {
  const tensors = {
    'dec_in_proj.weight': { dtype: 'F16', shape: [2048, 32, 1], data_offsets: [0, 2048 * 32 * 2] },
    'mean_proj.weight': { dtype: 'F16', shape: [2], data_offsets: [2048 * 32 * 2, 2048 * 32 * 2 + 4] },
  };
  const header = Buffer.from(JSON.stringify(tensors));
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(header.length));
  await writeFile(path, Buffer.concat([size, header, Buffer.alloc(2048 * 32 * 2 + 4)]));
}

test('a shared workflow finds its weights by file name when the asset id is unknown here', async () =>
  folder(async root => {
    const models = join(root, 'models', 'VAE');
    await mkdir(join(models, 'MiniMaxH3'), { recursive: true });
    const file = join(models, 'MiniMaxH3', 'minimax_h3_audio_vae_fp32.safetensors');
    await audioVae(file);
    const assets = new GenerationAssets(join(root, 'data', 'generation-assets.json'), { roots: () => [models] });
    const id = '11111111-2222-4333-8444-555555555555';
    await assert.rejects(assets.resolve(id, { kind: 'audioVae', family: 'minimax_h3' }), /not found/);
    const found = await assets.resolve(id, {
      kind: 'audioVae',
      family: 'minimax_h3',
      file: 'minimax_h3_audio_vae_fp32.safetensors',
    });
    assert.equal(found.path, file);
    assert.equal((await assets.read(id)).path, file, 'registered under the workflow’s own id');
    await assert.rejects(
      assets.resolve('99999999-2222-4333-8444-555555555555', {
        kind: 'audioVae',
        family: 'minimax_h3',
        file: 'nope.safetensors',
      }),
      /not found/,
    );
  }));

test('saved workflows carry the file name of each fixed component', async () =>
  folder(async root => {
    const { NativeWorkflowCatalog, validateNativeWorkflow } = await import('../lib/native-workflows.mjs');
    const { familyTemplate, family } = await import('../lib/families.mjs');
    const paths = Object.fromEntries(
      ['model', 'textEncoder', 'tokenizer', 'vae', 'audioVae'].map(role => [role, join(root, `${role}.safetensors`)]),
    );
    const assets = {
      read: async id => ({ id, path: paths[id] }),
      resolve: async id => ({ id, path: paths[id] }),
    };
    const catalog = new NativeWorkflowCatalog(join(root, 'workflow'), { assets });
    const components = Object.fromEntries(Object.keys(paths).map(role => [role, { policy: 'fixed', asset: role }]));
    const workflow = validateNativeWorkflow({
      ...familyTemplate(family('minimax_h3')),
      id: 'shared',
      name: 'Shared',
      components,
    });
    await catalog.save(workflow);
    const saved = JSON.parse(await readFile(join(root, 'workflow', 'shared.json'), 'utf8'));
    assert.equal(saved.components.vae.file, 'vae.safetensors');
    assert.equal(saved.components.model.asset, 'model');
  }));
