import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { componentVersions, llamaVersion, nvidiaVersion, torchVersion } from '../lib/components.mjs';

test('llama.cpp versions: a release build by number, a build outside the releases by commit', () => {
  assert.deepEqual(
    llamaVersion(
      'ggml_cuda_init: found 1 CUDA devices:\n  Device 0: NVIDIA GeForce RTX 4070, compute capability 8.9\nversion: 6912 (a1b2c3d4e)\nbuilt with MSVC',
    ),
    { version: 'b6912', detail: 'commit a1b2c3d · NVIDIA GeForce RTX 4070' },
  );
  assert.deepEqual(llamaVersion('version: 1 (6f3a9f3de)\nbuilt with Clang 18.1.8 for Windows AMD64'), {
    version: '6f3a9f3',
    detail: 'build hors versions publiées',
  });
  assert.equal(llamaVersion('Usage: ollama [command]'), null);
});

test('PyTorch and NVIDIA versions are read without loading anything', () => {
  assert.deepEqual(torchVersion('2.14.0+cu130'), { version: '2.14.0', cuda: '13.0', cpu: false });
  assert.deepEqual(torchVersion('2.9.1+cu128'), { version: '2.9.1', cuda: '12.8', cpu: false });
  assert.deepEqual(torchVersion('2.9.1+cpu'), { version: '2.9.1', cuda: '', cpu: true });
  assert.deepEqual(nvidiaVersion('NVIDIA GeForce RTX 4070 SUPER, 610.88, 12282\n'), {
    version: '610.88',
    detail: 'NVIDIA GeForce RTX 4070 SUPER · 12 Go',
  });
  assert.equal(nvidiaVersion(''), null);
});

test('component rows say what is missing, what fails and what is not used', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'atelier-components-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const engine = join(folder, 'llama-server.exe');
  await writeFile(engine, '');
  const runtimeDir = join(folder, 'runtime');
  const calls = [];
  const run = async (command, args) => {
    calls.push(command);
    if (command === engine) return { code: 0, output: 'version: 7001 (0123abcd)' };
    if (command === 'nvidia-smi') return null;
    if (args.includes('-c'))
      return {
        code: 0,
        output: JSON.stringify({ python: '3.13.14', torch: '2.9.1+cpu', diffusers: '0.41.0', transformers: '' }),
      };
    return null;
  };
  // No private environment yet: Python is said to come with the first generation, nothing is run.
  let rows = await componentVersions({
    config: { enginePath: engine, gpuLayers: 0 },
    runtimeDir,
    comfy: { enabled: false },
    run,
  });
  const byId = list => Object.fromEntries(list.map(row => [row.id, row]));
  let found = byId(rows);
  assert.equal(found.llama.version, 'b7001');
  assert.equal(found.llama.state, 'ok');
  assert.equal(found.nvidia.state, 'off');
  assert.equal(found.python.state, 'missing');
  assert.equal(found.torch, undefined);
  assert.equal(found.comfy.state, 'off');
  assert.equal(found.node.version, process.versions.node);
  assert.ok(!calls.some(command => /python/i.test(command)), 'no Python is started when none is prepared');

  // A prepared environment: a CPU-only PyTorch cannot generate, a missing package is named.
  const python = join(runtimeDir, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin');
  await mkdir(python, { recursive: true });
  await writeFile(join(python, process.platform === 'win32' ? 'python.exe' : 'python'), '');
  rows = await componentVersions({
    config: { enginePath: '', gpuLayers: 0 },
    runtimeDir,
    comfy: { enabled: true, reachable: false, baseUrl: 'http://127.0.0.1:8188' },
    run,
  });
  found = byId(rows);
  assert.equal(found.llama.state, 'missing');
  assert.equal(found.python.version, '3.13.14');
  assert.equal(found.torch.state, 'error');
  assert.equal(found.torch.detail, 'Sans CUDA');
  assert.equal(found.diffusers.version, '0.41.0');
  assert.equal(found.transformers.state, 'missing');
  assert.equal(found.comfy.state, 'error');
  assert.match(found.comfy.detail, /127\.0\.0\.1:8188/);
});
