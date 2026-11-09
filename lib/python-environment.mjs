import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, constants } from 'node:fs';
import { lstat, readFile, copyFile, chmod, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, dirname, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { plainFolder } from './update-files.mjs';

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
  ensure() {
    if (this.closed) return Promise.reject(Error('L’environnement Python est fermé.'));
    return (this.starting ||= this.#ensure()
      .catch(error => {
        this.state = this.controller.signal.aborted ? 'idle' : 'error';
        this.error = this.controller.signal.aborted ? '' : error.message;
        throw error;
      })
      .finally(() => {
        this.starting = null;
      }));
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
  async #ensure() {
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(3600000)]);
    this.state = 'installing';
    this.error = '';
    await plainFolder(this.directory, true);
    await plainFolder(join(this.directory, 'tmp'), true);
    await plainFolder(join(this.directory, 'venv'), true);
    const uv = await this.prepareUv(signal),
      env = environmentVariables(this.directory);
    this.progress = 'Préparation du Python privé à Atelier…';
    await this.run(uv, ['python', 'install', pythonVersion, '--no-bin', '--no-registry'], {
      signal,
      env,
      cwd: this.root,
    });
    this.progress = 'Vérification et mise à jour des bibliothèques de génération…';
    await this.run(
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
    const python = join(this.directory, 'venv', this.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    this.progress = 'Vérification de l’environnement…';
    await this.run(
      python,
      [
        '-s',
        '-c',
        'import torch,torchvision,diffusers,transformers,accelerate,safetensors,PIL,numpy,triton,comfy_kitchen,av,imageio,imageio_ffmpeg;from transformers import Gemma4UnifiedTextModel;from diffusers import LTX2Pipeline,LTX2ConditionPipeline;assert torch.version.cuda;assert not torch.cuda.is_initialized()',
      ],
      { signal, env: { ...env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' }, cwd: this.root },
    );
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
