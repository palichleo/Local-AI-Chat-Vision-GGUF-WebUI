import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LlamaBuilds,
  RELEASES,
  candidates,
  cudaOf,
  detectDevice,
  latestRelease,
  parseAsset,
} from '../lib/llama-builds.mjs';

// The files of the nightly release b12110 (4 November 2026), as GitHub lists them.
const NAMES = [
  'llama-b12110-bin-win-cpu-x64.zip',
  'llama-b12110-bin-win-cpu-arm64.zip',
  'llama-b12110-bin-win-cuda-12.4-x64.zip',
  'llama-b12110-bin-win-cuda-13.4-x64.zip',
  'llama-b12110-bin-win-cuda-13.4-arm64.zip',
  'cudart-llama-bin-win-cuda-12.4-x64.zip',
  'cudart-llama-bin-win-cuda-13.4-x64.zip',
  'cudart-llama-bin-win-cuda-13.4-arm64.zip',
  'llama-b12110-bin-win-vulkan-x64.zip',
  'llama-b12110-bin-win-vulkan-arm64.zip',
  'llama-b12110-bin-win-rocm-10.0-x64.zip',
  'llama-b12110-bin-win-sycl-x64.zip',
  'llama-b12110-bin-win-openvino-2026.4.1-x64.zip',
  'llama-b12110-bin-win-opencl-adreno-arm64.zip',
  'llama-b12110-bin-ubuntu-x64.tar.gz',
  'llama-b12110-bin-ubuntu-arm64.tar.gz',
  'llama-b12110-bin-ubuntu-s390x.tar.gz',
  'llama-b12110-bin-ubuntu-26.04-s390x.tar.gz',
  'llama-b12110-bin-ubuntu-zdnn-s390x.tar.gz',
  'llama-b12110-bin-ubuntu-vulkan-x64.tar.gz',
  'llama-b12110-bin-ubuntu-vulkan-arm64.tar.gz',
  'llama-b12110-bin-ubuntu-cuda-12.8-x64.tar.gz',
  'llama-b12110-bin-ubuntu-cuda-13.4-x64.tar.gz',
  'llama-b12110-bin-ubuntu-cuda-13.4-arm64.tar.gz',
  'cudart-llama-b12110-bin-ubuntu-cuda-12.8-x64.tar.gz',
  'cudart-llama-b12110-bin-ubuntu-cuda-13.4-x64.tar.gz',
  'cudart-llama-b12110-bin-ubuntu-cuda-13.4-arm64.tar.gz',
  'llama-b12110-bin-ubuntu-rocm-10.0-x64.tar.gz',
  'llama-b12110-bin-ubuntu-sycl-fp32-x64.tar.gz',
  'llama-b12110-bin-ubuntu-sycl-fp16-x64.tar.gz',
  'llama-b12110-bin-ubuntu-openvino-2026.4.1-x64.tar.gz',
  'llama-b12110-bin-linux-arm64-snapdragon.tar.gz',
  'llama-b12110-bin-macos-arm64.tar.gz',
  'llama-b12110-bin-macos-x64.tar.gz',
  'llama-b12110-xcframework.zip',
  'llama-b12110-bin-android-arm64.tar.gz',
  'llama-b12110-ui.tar.gz',
];
const ASSETS = NAMES.map(name => ({ name, size: 100, url: 'https://files/' + name, sha256: '' }));
const ids = (device, assets = ASSETS) => candidates(device, assets).map(item => item.id);

test('the files of a llama.cpp release are read by pattern: system, processor, backend and its version', () => {
  assert.deepEqual(parseAsset('llama-b12110-bin-win-cuda-13.4-x64.zip'), {
    kind: 'llama',
    build: 'b12110',
    platform: 'win32',
    backend: 'cuda',
    version: '13.4',
    variant: '',
    arch: 'x64',
  });
  assert.equal(parseAsset('llama-b12110-bin-ubuntu-x64.tar.gz').backend, 'cpu');
  assert.equal(parseAsset('llama-b12110-bin-win-cpu-arm64.zip').arch, 'arm64');
  assert.equal(parseAsset('llama-b12110-bin-macos-arm64.tar.gz').platform, 'darwin');
  assert.equal(parseAsset('llama-b12110-bin-ubuntu-sycl-fp16-x64.tar.gz').variant, 'fp16');
  assert.deepEqual(parseAsset('cudart-llama-bin-win-cuda-12.4-x64.zip'), {
    kind: 'cudart',
    platform: 'win32',
    backend: 'cuda',
    version: '12.4',
    arch: 'x64',
  });
  assert.equal(parseAsset('cudart-llama-b12110-bin-ubuntu-cuda-12.8-x64.tar.gz').platform, 'linux');
  // Other processors, Android, iOS, a version of Ubuntu, backends not offered: none of them.
  for (const name of [
    'llama-b12110-bin-ubuntu-s390x.tar.gz',
    'llama-b12110-bin-ubuntu-26.04-s390x.tar.gz',
    'llama-b12110-bin-linux-arm64-snapdragon.tar.gz',
    'llama-b12110-bin-android-arm64.tar.gz',
    'llama-b12110-xcframework.zip',
    'llama-b12110-ui.tar.gz',
    'llama-b12110-bin-win-openvino-2026.4.1-x64.zip',
    'llama-b12110-bin-win-opencl-adreno-arm64.zip',
    'nightly-tag.txt',
  ])
    assert.equal(parseAsset(name), null, name);
});

test('the CUDA a driver takes is read in both ways nvidia-smi writes it', () => {
  assert.deepEqual(cudaOf('| NVIDIA-SMI 610.88   KMD Version: 610.88   CUDA UMD Version: 13.3 |'), [13, 3]);
  assert.deepEqual(cudaOf('| NVIDIA-SMI 581.57   Driver Version: 581.57   CUDA Version: 13.0 |'), [13, 0]);
  assert.equal(cudaOf('nothing'), null);
});

test('each computer gets its builds, the best first, the processor alone last', () => {
  const nvidia = (computeCap, cuda) => ({ vendor: 'nvidia', name: 'card', computeCap, cuda });
  // This machine: an RTX 4070 SUPER (8.9) whose driver takes CUDA 13.3.
  const here = candidates({ platform: 'win32', arch: 'x64', gpus: [nvidia(8.9, [13, 3])] }, ASSETS);
  assert.deepEqual(
    here.map(item => item.id),
    ['cuda-13.4', 'cuda-12.4', 'vulkan', 'cpu'],
  );
  // CUDA comes with its libraries; it must see the card to count.
  assert.deepEqual(
    here[0].files.map(file => file.name),
    ['llama-b12110-bin-win-cuda-13.4-x64.zip', 'cudart-llama-bin-win-cuda-13.4-x64.zip'],
  );
  assert.equal(here[0].expect, 'CUDA');
  assert.equal(here.at(-1).expect, null);
  // A GTX 1080 (6.1): CUDA 13 no longer serves it. An older driver: CUDA 12 only.
  assert.deepEqual(ids({ platform: 'win32', arch: 'x64', gpus: [nvidia(6.1, [13, 0])] }), [
    'cuda-12.4',
    'vulkan',
    'cpu',
  ]);
  assert.deepEqual(ids({ platform: 'win32', arch: 'x64', gpus: [nvidia(8.6, [12, 8])] }), [
    'cuda-12.4',
    'vulkan',
    'cpu',
  ]);
  // AMD and Intel: Vulkan, which works almost everywhere; no card: the processor.
  assert.deepEqual(ids({ platform: 'win32', arch: 'x64', gpus: [{ vendor: 'amd', name: 'Radeon' }] }), [
    'vulkan',
    'cpu',
  ]);
  assert.deepEqual(ids({ platform: 'win32', arch: 'x64', gpus: [] }), ['cpu']);
  assert.deepEqual(ids({ platform: 'win32', arch: 'arm64', gpus: [] }), ['cpu']);
  // Linux, its own CUDA versions and libraries.
  const linux = candidates({ platform: 'linux', arch: 'x64', gpus: [nvidia(8.6, [13, 0])] }, ASSETS);
  assert.deepEqual(
    linux.map(item => item.id),
    ['cuda-13.4', 'cuda-12.8', 'vulkan', 'cpu'],
  );
  assert.equal(linux[1].files[1].name, 'cudart-llama-b12110-bin-ubuntu-cuda-12.8-x64.tar.gz');
  assert.deepEqual(ids({ platform: 'linux', arch: 'arm64', gpus: [] }), ['cpu']);
  assert.deepEqual(ids({ platform: 'linux', arch: 'x64', gpus: [{ vendor: 'intel', name: 'card0' }] }), [
    'vulkan',
    'cpu',
  ]);
  // A Mac: one build, Metal on Apple Silicon.
  const mac = candidates({ platform: 'darwin', arch: 'arm64', gpus: [{ vendor: 'apple' }] }, ASSETS);
  assert.deepEqual(
    [mac.length, mac[0].id, mac[0].expect, mac[0].files[0].name],
    [1, 'metal', 'Metal', 'llama-b12110-bin-macos-arm64.tar.gz'],
  );
  assert.deepEqual(ids({ platform: 'darwin', arch: 'x64', gpus: [] }), ['cpu']);
});

test('the cards of this computer: NVIDIA with its generation and driver, the others by their maker', async () => {
  const run = async (command, args) =>
    command === 'nvidia-smi'
      ? args.length
        ? { code: 0, output: 'NVIDIA GeForce RTX 4070 SUPER, 8.9\n' }
        : { code: 0, output: '| NVIDIA-SMI 610.88  KMD Version: 610.88  CUDA UMD Version: 13.3 |' }
      : {
          code: 0,
          output:
            'NVIDIA|NVIDIA GeForce RTX 4070 SUPER\r\nIntel Corporation|Intel(R) UHD Graphics 770\r\nMicrosoft|Microsoft Basic Display Adapter\r\n',
        };
  const device = await detectDevice({ platform: 'win32', arch: 'x64', run });
  assert.deepEqual(device.gpus, [
    { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4070 SUPER', computeCap: 8.9, cuda: [13, 3] },
    { vendor: 'intel', name: 'Intel(R) UHD Graphics 770' },
  ]);
  // No nvidia-smi: no NVIDIA card. Linux reads the makers of its cards from /sys.
  const linux = await detectDevice({
    platform: 'linux',
    arch: 'x64',
    run: async () => null,
    listDir: async () => ['card0', 'card0-DP-1', 'renderD128'],
    readText: async () => '0x1002\n',
  });
  assert.deepEqual(linux.gpus, [{ vendor: 'amd', name: 'card0' }]);
});

/** A GitHub that answers with the stable release, its pointer, then the nightly one. */
function github(files) {
  const assets = Object.entries(files).map(([name, bytes]) => ({
    name,
    size: bytes.length,
    browser_download_url: 'https://files/' + name,
    digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
  }));
  const asked = [];
  const fetchImpl = async (url, options = {}) => {
    asked.push([url, options.headers?.Range ?? '']);
    if (url === RELEASES + '/latest')
      return Response.json({
        tag_name: 'v0.9.0',
        assets: [{ name: 'nightly-tag.txt', browser_download_url: 'https://files/nightly-tag.txt' }],
      });
    if (url === 'https://files/nightly-tag.txt') return new Response('b12110\n');
    if (url === RELEASES + '/tags/b12110') return Response.json({ tag_name: 'b12110', assets });
    const name = url.replace('https://files/', '');
    if (files[name]) return new Response(files[name]);
    return new Response('', { status: 404 });
  };
  return { fetchImpl, asked };
}

test('the stable release names the nightly one that has the files: it is followed', async () => {
  const { fetchImpl } = github({ 'llama-b12110-bin-win-cpu-x64.zip': Buffer.from('cpu') });
  const release = await latestRelease({ fetchImpl });
  assert.equal(release.tag, 'b12110');
  assert.equal(release.assets[0].name, 'llama-b12110-bin-win-cpu-x64.zip');
  assert.match(release.assets[0].sha256, /^[0-9a-f]{64}$/);
});

test('a build that does not see the card gives way to the next; the one kept is ready to start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'llama-builds-'));
  const { fetchImpl } = github({
    'llama-b12110-bin-win-cuda-13.4-x64.zip': Buffer.from('cuda 13'),
    'cudart-llama-bin-win-cuda-13.4-x64.zip': Buffer.from('cudart 13'),
    'llama-b12110-bin-win-cuda-12.4-x64.zip': Buffer.from('cuda 12'),
    'cudart-llama-bin-win-cuda-12.4-x64.zip': Buffer.from('cudart 12'),
    'llama-b12110-bin-win-vulkan-x64.zip': Buffer.from('vulkan'),
    'llama-b12110-bin-win-cpu-x64.zip': Buffer.from('cpu'),
  });
  // Unpacked: the program at the top, the CUDA libraries in a folder of their own.
  const unpack = async (archive, destination) => {
    if (archive.includes('cudart')) {
      await mkdir(join(destination, 'bin'), { recursive: true });
      await writeFile(join(destination, 'bin', 'cudart64.dll'), 'dll');
    } else await writeFile(join(destination, 'llama-server.exe'), 'exe');
  };
  // The CUDA builds start but do not see the card (no driver here): Vulkan does.
  const run = async (command, args) =>
    args[0] === '--list-devices'
      ? {
          code: 0,
          output: command.includes('vulkan')
            ? 'Available devices:\n  Vulkan0: NVIDIA GeForce RTX 4070 SUPER (12281 MiB, 11071 MiB free)\n'
            : 'Available devices:\n',
        }
      : null;
  const builds = new LlamaBuilds({
    root,
    fetchImpl,
    run,
    unpack,
    platform: 'win32',
    arch: 'x64',
    env: { PATH: 'C:\\Windows' },
    detect: async () => ({
      platform: 'win32',
      arch: 'x64',
      gpus: [{ vendor: 'nvidia', name: 'RTX', computeCap: 8.9, cuda: [13, 3] }],
    }),
  });
  try {
    const kept = await builds.install();
    assert.equal(kept.id, 'vulkan');
    assert.equal(kept.tag, 'b12110');
    assert.equal(kept.enginePath, join(root, 'b12110-vulkan', 'llama-server.exe'));
    assert.deepEqual(kept.devices, ['Vulkan0: NVIDIA GeForce RTX 4070 SUPER (12281 MiB, 11071 MiB free)']);
    assert.ok(builds.owns(kept.enginePath));
    assert.equal(builds.owns('C:\\Ollama\\llama-server.exe'), false);
    const status = builds.status();
    assert.equal(status.state, 'done');
    assert.deepEqual(
      status.tried.map(item => item.label),
      ['CUDA 13.4', 'CUDA 12.4'],
    );
    assert.match(status.tried[0].reason, /ne voit pas la carte/);
    // What did not work takes no room; the downloads are gone once unpacked.
    assert.deepEqual((await readdir(root)).sort(), ['b12110-vulkan', 'downloads']);
    assert.deepEqual(await readdir(join(root, 'downloads')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the CUDA libraries land beside the program, and a file that does not match its fingerprint is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'llama-builds-'));
  const files = {
    'llama-b12110-bin-win-cuda-13.4-x64.zip': Buffer.from('cuda 13'),
    'cudart-llama-bin-win-cuda-13.4-x64.zip': Buffer.from('cudart 13'),
    'llama-b12110-bin-win-cpu-x64.zip': Buffer.from('cpu'),
  };
  const { fetchImpl } = github(files);
  // The processor build was altered on the way (same size): its fingerprint no longer matches.
  const altered = async (url, options) => (url.endsWith('cpu-x64.zip') ? new Response('CPU') : fetchImpl(url, options));
  const unpack = async (archive, destination) => {
    if (archive.includes('cudart')) {
      await mkdir(join(destination, 'bin'), { recursive: true });
      await writeFile(join(destination, 'bin', 'cudart64_13.dll'), 'dll');
    } else {
      await mkdir(join(destination, 'build', 'bin'), { recursive: true });
      await writeFile(join(destination, 'build', 'bin', 'llama-server.exe'), 'exe');
    }
  };
  const run = async () => ({
    code: 0,
    output: 'Available devices:\n  CUDA0: NVIDIA GeForce RTX 4070 SUPER (12281 MiB)\n',
  });
  const builds = new LlamaBuilds({
    root,
    fetchImpl: altered,
    run,
    unpack,
    platform: 'win32',
    arch: 'x64',
    env: {},
    detect: async () => ({
      platform: 'win32',
      arch: 'x64',
      gpus: [{ vendor: 'nvidia', computeCap: 8.9, cuda: [13, 3] }],
    }),
  });
  try {
    const kept = await builds.install();
    assert.equal(kept.id, 'cuda-13.4');
    const folder = join(root, 'b12110-cuda-13.4', 'build', 'bin');
    assert.ok((await stat(join(folder, 'cudart64_13.dll'))).isFile(), 'the library beside llama-server.exe');
    // Asked alone, the processor build is refused for its fingerprint.
    const only = new LlamaBuilds({
      root,
      fetchImpl: altered,
      run,
      unpack,
      platform: 'win32',
      arch: 'x64',
      env: {},
      detect: async () => ({ platform: 'win32', arch: 'x64', gpus: [] }),
    });
    await assert.rejects(only.install(), /empreinte différente/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installed from the settings, the build becomes the engine of the chat model', async () => {
  const { createApplication } = await import('../server.mjs');
  const { readFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'llama-app-'));
  const enginePath = join(root, 'engines', 'llama.cpp', 'b12110-cuda-13.4', 'llama-server.exe');
  // An installer that answers at once, as if the build had been downloaded and tried.
  const fake = new LlamaBuilds({ root: join(root, 'engines', 'llama.cpp') });
  fake.check = async () => ({
    tag: 'b12110',
    device: {},
    candidates: [{ id: 'cuda-13.4', label: 'CUDA 13.4', size: 1 }],
  });
  fake.install = async () => {
    const result = { enginePath, tag: 'b12110', id: 'cuda-13.4', label: 'CUDA 13.4', devices: ['CUDA0: RTX'] };
    fake.job = { state: 'done', step: '', tried: [], result };
    return result;
  };
  const app = await createApplication({ port: 0, dataDir: root, llamaBuilds: fake });
  try {
    const { token } = await (await fetch(app.url + '/api/bootstrap')).json();
    const api = (route, body) =>
      fetch(app.url + '/api/' + route, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    assert.equal((await (await api('llama/check', {})).json()).candidates[0].label, 'CUDA 13.4');
    assert.equal((await api('llama/install', {})).status, 202);
    let job;
    for (let turn = 0; turn < 50; turn++) {
      job = await (await api('llama')).json();
      if (job.state === 'done' && job.used) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(job.used, true);
    assert.equal(job.ours, true, 'the engine in use is one of the builds installed here');
    assert.equal(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')).enginePath, enginePath);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the builds before are removed but the one the engine runs, which stays to go back to', async () => {
  const { utimes } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'llama-builds-'));
  // The build in use is the oldest: the newer ones before it go, it stays.
  const ages = { 'b100-cuda-13.4': 300, 'b200-cuda-13.4': 200, 'b300-vulkan': 100 };
  for (const [name, age] of Object.entries(ages)) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, 'llama-server.exe'), 'exe');
    const at = new Date(Date.now() - age * 1000);
    await utimes(join(root, name), at, at);
  }
  const { fetchImpl } = github({ 'llama-b12110-bin-win-cpu-x64.zip': Buffer.from('cpu') });
  const builds = new LlamaBuilds({
    root,
    fetchImpl,
    run: async () => ({ code: 0, output: 'Available devices:\n' }),
    unpack: async (_archive, destination) => writeFile(join(destination, 'llama-server.exe'), 'exe'),
    platform: 'win32',
    arch: 'x64',
    env: {},
    detect: async () => ({ platform: 'win32', arch: 'x64', gpus: [] }),
  });
  try {
    const kept = await builds.install({ inUse: join(root, 'b100-cuda-13.4', 'llama-server.exe') });
    assert.equal(kept.id, 'cpu');
    assert.equal(builds.status().state, 'done');
    assert.deepEqual((await readdir(root)).sort(), ['b100-cuda-13.4', 'b12110-cpu', 'downloads']);
    // An engine of its own (Ollama's): the newest build before stays instead.
    await mkdir(join(root, 'b400-vulkan'), { recursive: true });
    await builds.install({ inUse: 'C:\Ollama\llama-server.exe' });
    assert.deepEqual((await readdir(root)).sort(), ['b12110-cpu', 'b400-vulkan', 'downloads']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a build that cannot load the model gives the engine back to the former one', async () => {
  const { createApplication } = await import('../server.mjs');
  const { readFile } = await import('node:fs/promises');
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = await mkdtemp(join(tmpdir(), 'llama-app-'));
  const folder = join(root, 'engines', 'llama.cpp', 'b12110-cuda-13.4');
  const enginePath = join(folder, 'llama-server.exe');
  await mkdir(folder, { recursive: true });
  await writeFile(enginePath, 'exe');
  const fakeEngine = fileURLToPath(new URL('./fixtures/fake-engine.mjs', import.meta.url));
  // The engine in use loads the model; the new build says its version, then stops at loading.
  const spawnProcess = (command, args, options) =>
    command === enginePath && args[0] !== '--version'
      ? spawn(
          process.execPath,
          ['-e', 'console.error("error: unknown argument: --reasoning-format"); process.exit(1)'],
          options,
        )
      : spawn(process.execPath, [fakeEngine, ...args], options);
  const fake = new LlamaBuilds({ root: join(root, 'engines', 'llama.cpp') });
  fake.install = async () => {
    const result = { enginePath, tag: 'b12110', id: 'cuda-13.4', label: 'CUDA 13.4', devices: [] };
    fake.job = { state: 'done', step: '', tried: [], result };
    return result;
  };
  const app = await createApplication({ port: 0, dataDir: root, llamaBuilds: fake, spawnProcess });
  try {
    const { token } = await (await fetch(app.url + '/api/bootstrap')).json();
    const api = (route, body) =>
      fetch(app.url + '/api/' + route, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const until = async check => {
      for (let turn = 0; turn < 200; turn++) {
        const value = await check();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.fail('nothing came in time');
    };
    const modelPath = join(root, 'model.gguf');
    await writeFile(modelPath, Buffer.from('GGUF\x03\0\0\0'));
    const settings = { enginePath: process.execPath, modelPath, projectorPath: '', contextSize: 4096 };
    assert.equal((await api('config', { ...settings, maxOutputTokens: 1024, gpuLayers: 0 })).status, 200);
    assert.equal((await api('start', {})).status, 202);
    await until(async () => (await (await api('status')).json()).state === 'ready');
    assert.equal((await api('llama/install', {})).status, 202);
    const job = await until(async () => {
      const value = await (await api('llama')).json();
      return ['done', 'error'].includes(value.state) && value;
    });
    assert.equal(job.state, 'error');
    assert.match(job.error, /ne démarre pas avec le modèle/);
    assert.match(job.error, /unknown argument/, 'what the build said');
    assert.match(job.error, /Le moteur d’avant est remis/);
    assert.equal(job.ours, false);
    assert.equal(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')).enginePath, process.execPath);
    // The model runs again on the engine before.
    await until(async () => (await (await api('status')).json()).state === 'ready');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
