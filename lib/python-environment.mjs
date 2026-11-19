import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, constants, existsSync } from 'node:fs';
import { lstat, readFile, copyFile, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { atomicFile, plainFolder } from './update-files.mjs';

const uvVersion = '0.13.7',
  pythonVersion = '3.13.14';
const releases = {
  win32: {
    archive: 'uv-x86_64-pc-windows-msvc.zip',
    assetId: 704009796,
    sha256: '0cdc5b38fe5a8168ed6a25814f5ba43c21d313dd3187314fccb37b7cec46e021',
    binary: 'uv.exe',
  },
  linux: {
    archive: 'uv-x86_64-unknown-linux-gnu.tar.gz',
    assetId: 704009823,
    sha256: 'c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83',
    binary: 'uv',
  },
};
// What a start of the engine makes sure of by importing it in a process of its own: the libraries are
// there and open, PyTorch is the CUDA build, and importing them takes nothing of the card.
const CHECK =
  'import torch,torchvision,diffusers,transformers,accelerate,safetensors,PIL,numpy,triton,comfy_kitchen,av,imageio,imageio_ffmpeg;from transformers import Gemma4UnifiedTextModel;from diffusers import LTX2Pipeline,LTX2ConditionPipeline;assert torch.version.cuda;assert not torch.cuda.is_initialized()';
// (0.6.110) Kept beside the environment once that check passed: what it was passed on.
const STAMP = 'verified.json';

/**
 * Whether `uv sync` found every library as its lock says and installed or removed nothing: its two
 * lines then, « Resolved 72 packages in 1ms » and « Checked 52 packages in 2ms » (uv 0.13.7), and no
 * other. Any other line, the words of a change or words uv would use one day, is read as a change:
 * the environment is then checked, as at every start before 0.6.110.
 */
export function nothingInstalled({ stdout = '', stderr = '' } = {}) {
  const lines = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  return (
    lines.some(line => /^Checked \d+ packages? in /.test(line)) &&
    lines.every(line => /^(?:Resolved|Checked) \d+ packages? in /.test(line))
  );
}

/** What the last check that passed was passed on, or nothing. */
async function passed(file) {
  try {
    const kept = JSON.parse(await readFile(file, 'utf8'));
    return typeof kept?.fingerprint === 'string' ? kept.fingerprint : '';
  } catch {
    return '';
  }
}

export function environmentVariables(directory) {
  const root = resolve(directory);
  return {
    ...process.env,
    PYTHONPATH: '',
    PYTHONHOME: '',
    PYTHONNOUSERSITE: '1',
    PYTHONIOENCODING: 'utf-8',
    UV_NO_CONFIG: '1',
    UV_NO_PROGRESS: '1',
    UV_PYTHON_INSTALL_BIN: '0',
    UV_PYTHON_INSTALL_REGISTRY: '0',
    UV_CACHE_DIR: join(root, 'cache', 'uv'),
    UV_PYTHON_INSTALL_DIR: join(root, 'python'),
    UV_PYTHON_BIN_DIR: join(root, 'bin'),
    UV_PYTHON_CACHE_DIR: join(root, 'cache', 'python'),
    UV_PROJECT_ENVIRONMENT: join(root, 'venv'),
    XDG_CACHE_HOME: join(root, 'cache'),
    HF_HOME: join(root, 'cache', 'huggingface'),
    HF_HUB_CACHE: join(root, 'cache', 'huggingface', 'hub'),
    HUGGINGFACE_HUB_CACHE: join(root, 'cache', 'huggingface', 'hub'),
    TRANSFORMERS_CACHE: join(root, 'cache', 'huggingface', 'transformers'),
    TORCH_HOME: join(root, 'cache', 'torch'),
    TORCH_EXTENSIONS_DIR: join(root, 'cache', 'torch-extensions'),
    TORCHINDUCTOR_CACHE_DIR: join(root, 'cache', 'inductor'),
    TRITON_CACHE_DIR: join(root, 'cache', 'triton'),
    PYTHONPYCACHEPREFIX: join(root, 'cache', 'pycache'),
    TMP: join(root, 'tmp'),
    TEMP: join(root, 'tmp'),
    TMPDIR: join(root, 'tmp'),
  };
}

export function runEnvironmentCommand(command, args, { cwd, env, signal } = {}) {
  signal?.throwIfAborted();
  return new Promise((yes, no) => {
    let stdout = '',
      stderr = '',
      error,
      force;
    const child = spawn(command, args, { cwd, env, signal, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const abort = () => {
      force = setTimeout(() => child.kill('SIGKILL'), 3000);
      force.unref();
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', text => {
      stdout = (stdout + text).slice(-12000);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => {
      stderr = (stderr + text).slice(-12000);
    });
    child.once('error', failure => {
      error = failure;
    });
    child.once('close', code => {
      clearTimeout(force);
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) no(signal.reason);
      else if (error || code !== 0)
        no(error || Error(stderr.trim().slice(-3000) || `Préparation Python interrompue (${code}).`));
      else yes({ stdout, stderr });
    });
  });
}

async function regular(path, max = Infinity) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > max)
    throw Error('Fichier de l’environnement Python non sûr.');
  return info;
}

export class PythonEnvironment {
  constructor({
    root,
    dataDir,
    platform = process.platform,
    arch = process.arch,
    run = runEnvironmentCommand,
    fetchAsset = fetch,
  } = {}) {
    Object.assign(this, {
      root: resolve(root),
      directory: resolve(dataDir, 'runtime'),
      platform,
      arch,
      run,
      fetchAsset,
    });
    this.state = 'idle';
    this.progress = '';
    this.error = '';
    this.closed = false;
    // Whether the last start took the environment as checked without checking it again (see #ensure).
    this.trusted = false;
  }
  status() {
    return { state: this.state, progress: this.progress, error: this.error };
  }
  async exists() {
    try {
      await regular(join(this.directory, 'venv', 'pyvenv.cfg'), 16384);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
  /** The Python of the environment, where it is once prepared (see exists). */
  interpreter() {
    return join(this.directory, 'venv', this.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  }
  /**
   * Makes sure of the environment and gives its Python. `engineReads`: the engine imports its
   * libraries itself as it starts (its setting, on unless the user turned it off); the check that
   * imports them in a process of its own is then skipped while nothing changed since it passed.
   */
  ensure({ engineReads = false } = {}) {
    if (this.closed) return Promise.reject(Error('L’environnement Python est fermé.'));
    return (this.starting ||= this.#ensure(engineReads)
      .catch(error => {
        this.state = this.controller.signal.aborted ? 'idle' : 'error';
        this.error = this.controller.signal.aborted ? '' : error.message;
        throw error;
      })
      .finally(() => {
        this.starting = null;
      }));
  }
  /** What a check that passed was passed on: the libraries asked for, their Python, the check itself. */
  async #fingerprint(python) {
    try {
      const digest = createHash('sha256').update([CHECK, pythonVersion, uvVersion, python].join('\n'));
      for (const name of ['uv.lock', 'pyproject.toml']) digest.update(await readFile(join(this.root, 'runner', name)));
      return digest.digest('hex');
    } catch {
      // (No lock to read: nothing to compare with, the check is made.)
      return '';
    }
  }
  /**
   * (0.6.110) The engine could not import a library: the mark of the check that passed goes, and the
   * next start checks again. Says whether this start had skipped the check: only then is there
   * something to start again for.
   */
  async distrust() {
    const trusted = this.trusted;
    this.trusted = false;
    await rm(join(this.directory, STAMP), { force: true }).catch(() => {});
    return trusted;
  }
  /**
   * A runtime moved with the application folder still names its old interpreter in pyvenv.cfg;
   * uv would then rebuild the whole environment. Point it at the same interpreter here.
   */
  async relink() {
    const file = join(this.directory, 'venv', 'pyvenv.cfg');
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    const home = text.match(/^home\s*=\s*(.+?)\s*$/m)?.[1];
    if (!home || existsSync(home)) return false;
    const parts = home.split(/[\\/]+/),
      at = parts.lastIndexOf('python');
    if (at < 0) return false;
    const moved = join(this.directory, ...parts.slice(at));
    if (!existsSync(moved)) return false;
    await writeFile(file, text.split(home).join(moved));
    return true;
  }
  async prepareUv(signal) {
    const release = releases[this.platform];
    if (!release || this.arch !== 'x64') throw Error('La génération native nécessite Windows ou Linux x64.');
    const destination = join(this.directory, 'uv', uvVersion, release.binary);
    await plainFolder(dirname(destination), true);
    try {
      await regular(destination, 200 * 1024 ** 2);
      return destination;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const temporary = await mkdtemp(join(this.directory, 'tmp', 'uv-'));
    try {
      this.progress = 'Téléchargement de l’installateur privé…';
      const archive = join(temporary, release.archive),
        digest = createHash('sha256');
      let bytes = 0;
      let response = await this.fetchAsset(
        `https://github.com/astral-sh/uv/releases/download/${uvVersion}/${release.archive}`,
        { signal, headers: { 'User-Agent': 'AtelierLocal-runtime' } },
      );
      if (!response.ok && release.assetId) {
        await response.body?.cancel();
        response = await this.fetchAsset(
          `https://api.github.com/repos/astral-sh/uv/releases/assets/${release.assetId}`,
          { signal, headers: { Accept: 'application/octet-stream', 'User-Agent': 'AtelierLocal-runtime' } },
        );
      }
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 100 * 1024 ** 2) {
        await response.body?.cancel();
        throw Error(`Téléchargement de l’environnement Python refusé (HTTP ${response.status}).`);
      }
      const counter = new Transform({
        transform: (chunk, _, done) => {
          bytes += chunk.length;
          if (bytes > 100 * 1024 ** 2) {
            done(Error('Installateur Python trop volumineux.'));
            return;
          }
          digest.update(chunk);
          done(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body),
        counter,
        createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
        { signal },
      );
      if (digest.digest('hex') !== release.sha256)
        throw Error('L’installateur Python ne correspond pas à son empreinte de sécurité.');
      const extracted = join(temporary, 'extracted');
      await plainFolder(extracted, true);
      const env = environmentVariables(this.directory);
      if (this.platform === 'win32')
        await this.run(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Expand-Archive -LiteralPath $env:ATELIER_UV_ARCHIVE -DestinationPath $env:ATELIER_UV_TARGET',
          ],
          { signal, env: { ...env, ATELIER_UV_ARCHIVE: archive, ATELIER_UV_TARGET: extracted }, cwd: this.root },
        );
      else
        await this.run('tar', ['-xzf', archive, '-C', extracted, '--strip-components=1'], {
          signal,
          env,
          cwd: this.root,
        });
      const binary = join(extracted, release.binary);
      await regular(binary, 200 * 1024 ** 2);
      signal.throwIfAborted();
      try {
        await copyFile(binary, destination, constants.COPYFILE_EXCL);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await regular(destination, 200 * 1024 ** 2);
        if (
          !createHash('sha256')
            .update(await readFile(binary))
            .digest()
            .equals(
              createHash('sha256')
                .update(await readFile(destination))
                .digest(),
            )
        )
          throw Error('Installateur Python local incohérent.');
      }
      await chmod(destination, 0o700);
      return destination;
    } finally {
      if (!temporary.startsWith(this.directory + sep)) throw Error('Dossier temporaire Python invalide.');
      await rm(temporary, { recursive: true, force: true });
    }
  }
  async #ensure(engineReads) {
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(3600000)]);
    this.state = 'installing';
    this.error = '';
    // (Said again below, once uv has answered: a start that fails before that skipped nothing.)
    this.trusted = false;
    await plainFolder(this.directory, true);
    await plainFolder(join(this.directory, 'tmp'), true);
    await plainFolder(join(this.directory, 'venv'), true);
    const uv = await this.prepareUv(signal),
      env = environmentVariables(this.directory);
    await this.relink();
    this.progress = 'Préparation du Python privé à Atelier…';
    await this.run(uv, ['python', 'install', pythonVersion, '--no-bin', '--no-registry'], {
      signal,
      env,
      cwd: this.root,
    });
    this.progress = 'Vérification et mise à jour des bibliothèques de génération…';
    const synced = await this.run(
      uv,
      [
        'sync',
        '--project',
        join(this.root, 'runner'),
        '--locked',
        '--no-install-project',
        '--python',
        pythonVersion,
        '--managed-python',
        '--no-python-downloads',
      ],
      { signal, env, cwd: this.root },
    );
    const python = this.interpreter(),
      stamp = join(this.directory, STAMP),
      fingerprint = await this.#fingerprint(python);
    // (0.6.110) The check below imports every library in a process of its own, then the engine
    // starts and imports its own again: 7 s of every start (measured, runner/MEMORY-STUDY.md). Once
    // passed, it is skipped while nothing changed: the same libraries asked for (their lock), the
    // same Python, and uv found them all there without installing or removing one. Only when the
    // engine reads them as it starts: otherwise nothing would before the first creation, which
    // would then bring them from the disk itself. A library the engine cannot import is said by
    // it (runner/protocol.py), and that withdraws this trust (distrust).
    this.trusted =
      engineReads && Boolean(fingerprint) && nothingInstalled(synced ?? {}) && (await passed(stamp)) === fingerprint;
    if (!this.trusted) {
      this.progress = 'Vérification de l’environnement…';
      // (The mark of an earlier check goes first: a check that fails, or is stopped, leaves none.)
      await rm(stamp, { force: true }).catch(() => {});
      await this.run(python, ['-s', '-c', CHECK], {
        signal,
        env: { ...env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
        cwd: this.root,
      });
      signal.throwIfAborted();
      if (fingerprint) await atomicFile(stamp, JSON.stringify({ fingerprint }) + '\n').catch(() => {});
    }
    signal.throwIfAborted();
    this.state = 'ready';
    this.progress = 'Environnement Atelier prêt.';
    return python;
  }
  async cancel() {
    this.controller?.abort();
    await this.starting?.catch(() => {});
  }
  async close() {
    this.closed = true;
    await this.cancel();
  }
}
