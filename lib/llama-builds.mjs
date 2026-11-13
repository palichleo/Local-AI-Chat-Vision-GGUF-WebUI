import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { runVersion } from './components.mjs';

/**
 * The official builds of llama.cpp (github.com/ggml-org/llama.cpp, MIT licence), for any computer:
 * the one that fits is chosen from its system, its processor and its graphics card, downloaded,
 * checked against the SHA-256 GitHub gives, unpacked in a folder of its own and tried
 * (`llama-server --list-devices`) before it is used. A build that does not see the card gives
 * way to the next: CUDA (the newest the driver takes), then Vulkan, then the processor alone.
 *
 * The stable releases of llama.cpp carry no files, only `nightly-tag.txt`, the name of the
 * nightly release that has them: it is followed. The file names are read by pattern
 * (`llama-b12110-bin-win-cuda-13.4-x64.zip`); if they change, `parseAsset` is the place.
 */
export const RELEASES = 'https://api.github.com/repos/ggml-org/llama.cpp/releases';
const HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'Moodix-llama-builds' };
const SYSTEMS = { win: 'win32', ubuntu: 'linux', macos: 'darwin' };
// What each kind of build shows in `--list-devices` when it sees a card.
const SEEN = { CUDA: /^\s*CUDA\d*\s*:/im, Vulkan: /^\s*Vulkan\d*\s*:/im, Metal: /^\s*(?:Metal|MTL)\d*\s*:/im };
// The installed builds kept: the one in use and the one before, to go back to.
const KEPT = 2;

const problem = (message, status = 400) => Object.assign(new Error(message), { status });

/**
 * What a file of a release is: a build (`kind: 'llama'`) or the CUDA libraries that go with
 * one (`kind: 'cudart'`), for which system, processor and graphics backend. Null for the rest
 * (sources, Android, iOS, other processors).
 */
export function parseAsset(name) {
  let match = /^cudart-llama-(?:b\d+-)?bin-(win|ubuntu)-cuda-(\d+(?:\.\d+)*)-(x64|arm64)\.(zip|tar\.gz)$/.exec(name);
  if (match) return { kind: 'cudart', platform: SYSTEMS[match[1]], backend: 'cuda', version: match[2], arch: match[3] };
  match = /^llama-(b\d+)-bin-(win|ubuntu|macos)-(.*?)-?(x64|arm64)\.(zip|tar\.gz)$/.exec(name);
  if (!match) return null;
  const [, build, system, middle, arch] = match,
    parts = middle.split('-').filter(Boolean),
    [first = 'cpu', ...rest] = parts;
  // `ubuntu-x64` and `win-cpu-x64` are the processor alone; a version of Ubuntu is another build.
  if (/^\d/.test(first)) return null;
  const backend = { cpu: 'cpu', cuda: 'cuda', vulkan: 'vulkan', rocm: 'rocm', hip: 'rocm', sycl: 'sycl' }[first];
  if (!backend) return null;
  return {
    kind: 'llama',
    build,
    platform: SYSTEMS[system],
    backend,
    version: backend === 'cuda' || backend === 'rocm' ? (rest[0] ?? '') : '',
    variant: backend === 'sycl' ? (rest[0] ?? '') : '',
    arch,
  };
}

/** "CUDA Version: 13.0" (older drivers) or "CUDA UMD Version: 13.3": the newest CUDA the driver takes. */
export function cudaOf(output) {
  const match = String(output || '').match(/CUDA(?: UMD)? Version:\s*(\d+)\.(\d+)/i);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

const vendorOf = text =>
  /nvidia/i.test(text)
    ? 'nvidia'
    : /\bamd\b|advanced micro|radeon|\bati\b/i.test(text)
      ? 'amd'
      : /intel/i.test(text)
        ? 'intel'
        : null;

/**
 * This computer as the choice needs it: its system, its processor, and its graphics cards (the
 * maker; for NVIDIA, the generation of each card and the CUDA its driver takes). Each program
 * asked has a few seconds; one that does not answer counts as no card of that maker.
 */
export async function detectDevice({
  platform = process.platform,
  arch = process.arch,
  run = runVersion,
  readText = path => readFile(path, 'utf8'),
  listDir = readdir,
} = {}) {
  const gpus = [];
  if (platform === 'darwin') {
    if (arch === 'arm64') gpus.push({ vendor: 'apple', name: 'Apple Silicon' });
    return { platform, arch, gpus };
  }
  const listed = await run('nvidia-smi', ['--query-gpu=name,compute_cap', '--format=csv,noheader'], { timeout: 8000 });
  if (listed?.code === 0) {
    const cuda = cudaOf((await run('nvidia-smi', [], { timeout: 8000 }))?.output);
    for (const line of listed.output.split(/\r?\n/)) {
      const [name, capability] = line.split(',').map(item => item.trim());
      if (name) gpus.push({ vendor: 'nvidia', name, computeCap: Number(capability) || null, cuda });
    }
  }
  if (platform === 'win32') {
    const answer = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_VideoController | ForEach-Object { $_.AdapterCompatibility + "|" + $_.Name }',
      ],
      { timeout: 15000 },
    );
    for (const line of String(answer?.output ?? '').split(/\r?\n/)) {
      const [maker = '', name = ''] = line.split('|').map(item => item.trim()),
        vendor = vendorOf(maker + ' ' + name);
      // NVIDIA cards are already known, with what CUDA needs.
      if (vendor && vendor !== 'nvidia') gpus.push({ vendor, name: name || maker });
    }
  } else if (platform === 'linux') {
    for (const card of await listDir('/sys/class/drm').catch(() => [])) {
      if (!/^card\d+$/.test(card)) continue;
      const id = (await readText(`/sys/class/drm/${card}/device/vendor`).catch(() => '')).trim().toLowerCase(),
        vendor = { '0x1002': 'amd', '0x8086': 'intel' }[id];
      if (vendor) gpus.push({ vendor, name: card });
    }
  }
  return { platform, arch, gpus };
}

const versionKey = value =>
  String(value || '0')
    .split('.')
    .map(Number);
const newer = (a, b) => {
  const [x, y] = [versionKey(a), versionKey(b)];
  for (let index = 0; index < Math.max(x.length, y.length); index++)
    if ((x[index] ?? 0) !== (y[index] ?? 0)) return (y[index] ?? 0) - (x[index] ?? 0);
  return 0;
};

/**
 * The builds to try on this computer, the best first: { id, label, files, expect }, `expect`
 * being what `--list-devices` must show for the build to count as working (null: the
 * processor alone, which always works). An NVIDIA card takes the newest CUDA its driver accepts
 * (CUDA 13 no longer serves the cards before Turing, generation 7.5), with its libraries; any
 * card takes Vulkan next; the processor build comes last everywhere. A Mac has one build.
 */
export function candidates(device, assets) {
  const files = assets
    .map(asset => ({ ...asset, ...parseAsset(asset.name) }))
    .filter(item => item.kind && item.platform === device.platform && item.arch === device.arch);
  const builds = files.filter(item => item.kind === 'llama'),
    runtimes = files.filter(item => item.kind === 'cudart'),
    cpu = builds.find(item => item.backend === 'cpu'),
    chosen = [];
  if (device.platform === 'darwin') {
    if (cpu)
      chosen.push({
        id: device.arch === 'arm64' ? 'metal' : 'cpu',
        label: device.arch === 'arm64' ? 'Metal' : 'processeur',
        files: [cpu],
        expect: device.arch === 'arm64' ? 'Metal' : null,
      });
    return chosen;
  }
  const nvidia = device.gpus.find(gpu => gpu.vendor === 'nvidia');
  if (nvidia)
    for (const build of builds.filter(item => item.backend === 'cuda').sort((a, b) => newer(a.version, b.version))) {
      const major = versionKey(build.version)[0];
      if (nvidia.cuda && nvidia.cuda[0] < major) continue;
      if (major >= 13 && nvidia.computeCap && nvidia.computeCap < 7.5) continue;
      const runtime = runtimes.find(item => item.version === build.version);
      chosen.push({
        id: 'cuda-' + build.version,
        label: 'CUDA ' + build.version,
        files: runtime ? [build, runtime] : [build],
        expect: 'CUDA',
      });
    }
  const vulkan = builds.find(item => item.backend === 'vulkan');
  if (device.gpus.length && vulkan) chosen.push({ id: 'vulkan', label: 'Vulkan', files: [vulkan], expect: 'Vulkan' });
  if (cpu) chosen.push({ id: 'cpu', label: 'processeur', files: [cpu], expect: null });
  return chosen;
}

/** A file of a release as the installer needs it. */
const assetOf = asset => ({
  name: asset.name,
  size: asset.size,
  url: asset.browser_download_url,
  sha256: /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '')?.[1]?.toLowerCase() || '',
});

/**
 * The newest release with files: the latest stable one when it has them, else the nightly one
 * it names in `nightly-tag.txt`. { tag, assets: [{ name, size, url, sha256 }] }.
 */
export async function latestRelease({ fetchImpl = fetch, signal } = {}) {
  const ask = async url => {
    const response = await fetchImpl(url, { headers: HEADERS, signal });
    if (!response.ok) throw problem(`GitHub répond ${response.status} pour les versions de llama.cpp.`, 502);
    return response.json();
  };
  let release = await ask(RELEASES + '/latest');
  if (!release.assets?.some(asset => parseAsset(asset.name))) {
    const pointer = release.assets?.find(asset => asset.name === 'nightly-tag.txt');
    if (!pointer) throw problem('La dernière version de llama.cpp ne donne aucun fichier à télécharger.', 502);
    const response = await fetchImpl(pointer.browser_download_url, {
      headers: { 'User-Agent': HEADERS['User-Agent'] },
      signal,
    });
    const tag = (await response.text()).trim();
    if (!/^b\d+$/.test(tag)) throw problem('Le nom de la version de nuit de llama.cpp est illisible.', 502);
    release = await ask(`${RELEASES}/tags/${tag}`);
  }
  return { tag: release.tag_name, assets: (release.assets ?? []).map(assetOf) };
}

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
/** The SHA-256 of what a partial file holds, to go on with the rest. */
async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash;
}
/** Every file under a folder, its sub-folders included. */
async function filesIn(folder) {
  const found = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...(await filesIn(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}
/** The program of a build, wherever its archive put it (at the top, or under build/bin). */
async function serverIn(folder, name, depth = 3) {
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    return '';
  }
  for (const entry of entries) if (entry.isFile() && entry.name === name) return join(folder, entry.name);
  if (depth > 0)
    for (const entry of entries)
      if (entry.isDirectory()) {
        const found = await serverIn(join(folder, entry.name), name, depth - 1);
        if (found) return found;
      }
  return '';
}

/**
 * Installs the build that fits this computer under `root` (one folder per build:
 * `b12110-cuda-13.4`). `status()` tells where it is, for the settings to show.
 */
export class LlamaBuilds {
  constructor({
    root,
    fetchImpl = fetch,
    run = runVersion,
    platform = process.platform,
    arch = process.arch,
    detect = () => detectDevice({ platform, arch, run }),
    unpack = null,
    env = process.env,
  }) {
    this.root = root;
    this.fetchImpl = fetchImpl;
    this.run = run;
    this.platform = platform;
    this.arch = arch;
    this.detect = detect;
    this.unpackImpl = unpack;
    this.env = env;
    this.job = { state: 'idle' };
    this.checked = null;
  }

  status() {
    const { controller, ...job } = this.job;
    return structuredClone(job);
  }

  /** Whether a llama-server is one of the builds installed here. */
  owns(enginePath) {
    const root = this.root.toLowerCase().replaceAll('\\', '/');
    return (
      Boolean(enginePath) &&
      enginePath
        .toLowerCase()
        .replaceAll('\\', '/')
        .startsWith(root + '/')
    );
  }

  /**
   * The newest release and the builds it offers this computer, the best first; asked again
   * past an hour (GitHub allows sixty unauthenticated questions an hour).
   */
  async check({ again = false } = {}) {
    if (!again && this.checked && Date.now() - this.checked.at < 3600000) return this.checked.value;
    const [release, device] = await Promise.all([latestRelease({ fetchImpl: this.fetchImpl }), this.detect()]);
    const offered = candidates(device, release.assets);
    const value = {
      tag: release.tag,
      device,
      candidates: offered.map(({ id, label, files }) => ({
        id,
        label,
        size: files.reduce((sum, file) => sum + (file.size || 0), 0),
      })),
    };
    this.checked = { at: Date.now(), value, release, offered };
    return value;
  }

  /**
   * Downloads, unpacks and tries the builds in order until one works. Resolves with the build
   * kept: { enginePath, tag, id, label, devices }; rejects when none works (the reason of each).
   */
  async install() {
    if (['checking', 'downloading', 'unpacking', 'trying'].includes(this.job.state))
      throw problem('Une installation de llama.cpp est déjà en cours.', 409);
    const controller = new AbortController();
    this.job = { state: 'checking', step: 'Recherche de la dernière version de llama.cpp…', tried: [], controller };
    try {
      await this.check({ again: true });
      const { release, offered } = this.checked;
      if (!offered.length)
        throw problem(`llama.cpp ne publie aucune version pour ce système (${this.platform}, ${this.arch}).`);
      for (const candidate of offered) {
        try {
          const found = await this.#installOne(release.tag, candidate, controller.signal);
          this.job = { ...this.job, state: 'done', step: '', result: found };
          await this.#prune(release.tag + '-' + candidate.id);
          return found;
        } catch (error) {
          if (controller.signal.aborted) throw error;
          this.job.tried.push({ label: candidate.label, reason: error.message });
          // A build that does not work here takes no room.
          await rm(join(this.root, `${release.tag}-${candidate.id}`), { recursive: true, force: true }).catch(() => {});
        }
      }
      throw problem(
        'Aucune version de llama.cpp ne fonctionne ici : ' +
          this.job.tried.map(item => `${item.label} (${item.reason})`).join(' ; '),
        502,
      );
    } catch (error) {
      this.job = {
        ...this.job,
        state: 'error',
        step: '',
        error: controller.signal.aborted ? 'Installation annulée.' : error.message,
      };
      throw error;
    } finally {
      delete this.job.controller;
    }
  }

  cancel() {
    this.job.controller?.abort();
  }

  async #installOne(tag, candidate, signal) {
    const folder = join(this.root, `${tag}-${candidate.id}`),
      program = this.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    let server = await serverIn(folder, program);
    // Already here from an earlier installation (or one cut short after the unpacking): tried again.
    if (!server) {
      const downloads = join(this.root, 'downloads');
      await mkdir(downloads, { recursive: true });
      const total = candidate.files.reduce((sum, file) => sum + (file.size || 0), 0);
      Object.assign(this.job, { state: 'downloading', label: candidate.label, received: 0, total });
      this.job.step = `Téléchargement de llama.cpp ${tag} (${candidate.label})…`;
      for (const file of candidate.files) await this.#download(file, join(downloads, file.name), signal);
      Object.assign(this.job, { state: 'unpacking', step: `Décompression (${candidate.label})…` });
      const unpacked = folder + '.unpack',
        extra = folder + '.libraries';
      await rm(unpacked, { recursive: true, force: true });
      await mkdir(unpacked, { recursive: true });
      const [build, ...libraries] = candidate.files;
      await this.#unpack(join(downloads, build.name), unpacked);
      const inside = await serverIn(unpacked, program);
      if (!inside) throw problem(`L’archive ${build.name} ne contient pas ${program}.`, 502);
      // The CUDA libraries go beside the program, where it looks for them, whatever their folders.
      for (const library of libraries) {
        await rm(extra, { recursive: true, force: true });
        await mkdir(extra, { recursive: true });
        await this.#unpack(join(downloads, library.name), extra);
        for (const file of await filesIn(extra)) await rename(file, join(dirname(inside), file.split(/[\\/]/).pop()));
        await rm(extra, { recursive: true, force: true });
      }
      await rm(folder, { recursive: true, force: true });
      await rename(unpacked, folder);
      server = await serverIn(folder, program);
      for (const file of candidate.files) await rm(join(downloads, file.name), { force: true });
    }
    Object.assign(this.job, { state: 'trying', step: `Essai de llama.cpp ${tag} (${candidate.label})…` });
    const env = { ...this.env },
      pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
    env[pathKey] = [dirname(server), env[pathKey]].filter(Boolean).join(delimiter);
    if (this.platform === 'linux')
      env.LD_LIBRARY_PATH = [dirname(server), env.LD_LIBRARY_PATH].filter(Boolean).join(delimiter);
    const listed = await this.run(server, ['--list-devices'], { env, timeout: 60000 });
    if (!listed || listed.code !== 0) throw problem('le programme ne démarre pas sur cet ordinateur');
    if (candidate.expect && !SEEN[candidate.expect].test(listed.output))
      throw problem(`il ne voit pas la carte graphique (${candidate.expect} absent)`);
    const devices = listed.output
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => /^\w+\d*\s*:\s*\S/.test(line) && !/^available devices/i.test(line));
    return { enginePath: server, tag, id: candidate.id, label: candidate.label, devices };
  }

  /** A file of the release, resumed where it stopped, checked against its SHA-256 when GitHub gives one. */
  async #download(file, path, signal) {
    const partial = path + '.part';
    if ((await sizeOf(path)) === file.size && file.size) {
      this.job.received += file.size;
      return;
    }
    let offset = await sizeOf(partial);
    if (file.size && offset > file.size) {
      await rm(partial, { force: true });
      offset = 0;
    }
    let hash = offset ? await hashFile(partial) : createHash('sha256');
    this.job.received += offset;
    if (!file.size || offset < file.size) {
      const response = await this.fetchImpl(file.url, {
        headers: { 'User-Agent': HEADERS['User-Agent'], ...(offset ? { Range: `bytes=${offset}-` } : {}) },
        redirect: 'follow',
        signal,
      });
      if (!response.ok || !response.body) throw problem(`GitHub répond ${response.status} pour ${file.name}.`, 502);
      if (offset && response.status !== 206) {
        this.job.received -= offset;
        offset = 0;
        hash = createHash('sha256');
      }
      const job = this.job;
      const counter = new Transform({
        transform(chunk, _encoding, done) {
          hash.update(chunk);
          job.received += chunk.length;
          done(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body),
        counter,
        createWriteStream(partial, { flags: offset ? 'a' : 'w' }),
        {
          signal,
        },
      );
    }
    const size = await sizeOf(partial);
    if (file.size && size !== file.size)
      throw problem(`${file.name} est incomplet (${size} octets sur ${file.size}).`, 502);
    if (file.sha256 && hash.digest('hex') !== file.sha256) {
      await rm(partial, { force: true });
      throw problem(`${file.name} ne correspond pas à l’original (empreinte différente) : il a été effacé.`, 502);
    }
    await rename(partial, path);
  }

  /** A .zip (Windows) or .tar.gz (Linux, Mac), unpacked with the tar of the system. */
  async #unpack(archive, destination) {
    if (this.unpackImpl) return this.unpackImpl(archive, destination);
    const tar =
      this.platform === 'win32'
        ? join(this.env.SystemRoot || this.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar';
    const result = await this.run(tar, [archive.endsWith('.zip') ? '-xf' : '-xzf', archive, '-C', destination], {
      timeout: 600000,
    });
    if (!result || result.code !== 0)
      throw problem(`Décompression impossible de ${archive.split(/[\\/]/).pop()}.`, 502);
  }

  /** The builds installed before the one in use and the one before it are removed. */
  async #prune(current) {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch {
      return;
    }
    const builds = [];
    for (const entry of entries)
      if (entry.isDirectory() && /^b\d+-/.test(entry.name))
        builds.push({ name: entry.name, at: (await stat(join(this.root, entry.name))).mtimeMs });
    builds.sort((a, b) => (a.name === current ? -1 : b.name === current ? 1 : b.at - a.at));
    for (const old of builds.slice(KEPT)) await rm(join(this.root, old.name), { recursive: true, force: true });
  }
}
