import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { GenerationWorker } from './generation-worker.mjs';
import { PythonEnvironment, environmentVariables } from './python-environment.mjs';
import { GenerationAssets } from './generation-assets.mjs';
import { NativeWorkflowCatalog } from './native-workflows.mjs';
import { generatedMedia } from './generated-media.mjs';
import { problem } from './engine.mjs';
import { plainFolder } from './update-files.mjs';
const defaults = {
  enabled: false,
  autoAllow: false,
  maxIterations: 5,
  pythonPath: '',
  tokenizerPath: '',
  modelRoot: '',
};
export function generationConfig(value) {
  if (
    !value ||
    typeof value.enabled !== 'boolean' ||
    typeof value.autoAllow !== 'boolean' ||
    !Number.isInteger(value.maxIterations) ||
    value.maxIterations < 1 ||
    value.maxIterations > 10000
  )
    throw problem('Paramètres de génération invalides.');
  const result = { enabled: value.enabled, autoAllow: value.autoAllow, maxIterations: value.maxIterations };
  for (const key of ['pythonPath', 'tokenizerPath', 'modelRoot']) {
    if (key === 'modelRoot' && value[key] === undefined) {
      result[key] = '';
      continue;
    }
    if (typeof value[key] !== 'string' || value[key].length > 4096 || /[\x00\r\n]/.test(value[key]))
      throw problem('Chemin de génération invalide.');
    result[key] = value[key].trim().replace(/^"(.*)"$/, '$1');
    if (result[key] && !isAbsolute(result[key])) throw problem('Un chemin absolu est requis.');
  }
  if (/\.json$/i.test(result.tokenizerPath)) result.tokenizerPath = dirname(result.tokenizerPath);
  return result;
}
export class GenerationService {
  constructor({ root, dataDir, workflowDir, outputDir, worker, environment } = {}) {
    Object.assign(this, { root, dataDir, outputDir });
    this.path = join(dataDir, 'generation.json');
    this.workerPath = join(dataDir, 'runner-config.json');
    this.config = { ...defaults };
    this.worker = worker || new GenerationWorker({ root });
    this.environment = environment || new PythonEnvironment({ root, dataDir });
    this.assets = new GenerationAssets(join(dataDir, 'generation-assets.json'));
    this.catalog = new NativeWorkflowCatalog(workflowDir, { assets: this.assets });
    this.inputDir = join(dataDir, 'runner-input');
  }
  async init() {
    try {
      this.config = generationConfig(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') this.warning = 'Configuration de génération illisible.';
    }
    return this;
  }
  async save(value) {
    const next = generationConfig(value);
    const changed = next.pythonPath !== this.config.pythonPath || next.tokenizerPath !== this.config.tokenizerPath,
      disabling = this.config.enabled && !next.enabled;
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.path + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(this.path + '.tmp', this.path);
    this.config = next;
    if (changed || disabling) {
      await this.environment.cancel();
      await this.worker.close();
      await this.starting?.catch(() => {});
    }
    if (next.enabled && (changed || this.worker.status().state !== 'ready')) void this.start().catch(() => {});
    return this.snapshot();
  }
  start() {
    if (this.closing) return Promise.reject(problem('Le moteur de génération est fermé.', 503));
    return (this.starting ||= this.#start().finally(() => {
      this.starting = null;
    }));
  }
  async prepareOnLaunch() {
    if (this.closing) return;
    if (this.config.enabled) return this.start();
    if (!this.config.pythonPath && (await this.environment.exists()) && !this.closing) await this.environment.ensure();
  }
  async #start() {
    const config = { ...this.config };
    await mkdir(this.dataDir, { recursive: true });
    await mkdir(this.outputDir, { recursive: true });
    await plainFolder(join(this.dataDir, 'runtime', 'tmp'), true);
    await writeFile(
      this.workerPath,
      JSON.stringify({
        tokenizerPath: config.tokenizerPath || join(this.dataDir, 'tokenizer'),
        cacheRoot: join(this.dataDir, 'generation-cache'),
        outputRoot: this.outputDir,
      }),
      { mode: 0o600 },
    );
    if (this.closing) throw problem('Le moteur de génération est fermé.', 503);
    const pythonPath = config.pythonPath || (await this.environment.ensure());
    if (this.closing) throw problem('Le moteur de génération est fermé.', 503);
    await this.worker.start({
      pythonPath,
      configPath: this.workerPath,
      env: environmentVariables(join(this.dataDir, 'runtime')),
    });
    this.syncCapabilities();
    return this.worker.status();
  }
  async snapshot() {
    this.syncCapabilities();
    return {
      config: this.config,
      folders: this.folders(),
      runner: this.status(),
      workflows: await this.catalog.list(),
      assets: await this.assets.list(),
      warning: this.warning || '',
    };
  }
  folders() {
    const models = join(this.root, 'models');
    return {
      model: this.config.modelRoot || join(models, 'checkpoints'),
      textEncoder: join(models, 'LLMs'),
      vae: join(models, 'VAE'),
      audioVae: join(models, 'VAE'),
      lora: join(models, 'LoRa'),
      textProjection: join(models, 'vision'),
      enhancer: join(models, 'LLMs'),
    };
  }
  status() {
    const worker = this.worker.status(),
      setup = this.environment.status();
    return !this.config.pythonPath && ['installing', 'error'].includes(setup.state)
      ? {
          ...worker,
          state: setup.state === 'error' ? 'unavailable' : 'installing',
          error: setup.error,
          progress: setup.progress,
        }
      : worker;
  }
  syncCapabilities() {
    const state = this.status();
    this.catalog.capabilities = structuredClone(state.capabilities);
    if (state.state !== 'ready')
      for (const capability of Object.values(this.catalog.capabilities)) {
        capability.ready = false;
        capability.reason = state.error || 'Moteur Python indisponible.';
      }
    if (!this.config.tokenizerPath && this.catalog.capabilities.krea2)
      this.catalog.capabilities.krea2 = { ready: false, reason: 'Choisissez le tokenizer local dans les paramètres.' };
  }
  client() {
    const staged = new Set();
    return {
      status: async ({ signal } = {}) => {
        signal?.throwIfAborted();
        if (this.worker.status().state !== 'ready') {
          let abort;
          const cancelled =
            signal &&
            new Promise((_, no) => {
              abort = () => no(signal.reason);
              signal.addEventListener('abort', abort, { once: true });
            });
          try {
            await (cancelled ? Promise.race([this.start(), cancelled]) : this.start());
          } finally {
            if (abort) signal.removeEventListener('abort', abort);
          }
        }
        return { idle: !this.worker.status().busy };
      },
      preflight: (job, options) => this.worker.request('preflight', job, options),
      stage: async (media, { signal } = {}) => {
        try {
          signal?.throwIfAborted();
          if (!['video/mp4', 'video/webm'].includes(media.mime) || media.info.size > 512 * 1024 ** 2)
            throw problem('Vidéo source invalide ou trop volumineuse (512 Mo maximum).');
          await mkdir(this.inputDir, { recursive: true });
          const file = join(this.inputDir, randomUUID() + (media.mime === 'video/mp4' ? '.mp4' : '.webm'));
          staged.add(file);
          await pipeline(media.handle.createReadStream(), createWriteStream(file, { flags: 'wx', mode: 0o600 }), {
            signal,
          });
          return { path: file };
        } finally {
          await media.handle.close().catch(() => {});
        }
      },
      upload: async (bytes, { filename, mime, signal } = {}) => {
        signal?.throwIfAborted();
        if (bytes.length > 5 * 1024 * 1024 || !['image/png', 'image/jpeg'].includes(mime))
          throw problem('Référence préparée invalide.');
        await mkdir(this.inputDir, { recursive: true });
        const file = join(this.inputDir, randomUUID() + (mime === 'image/png' ? '.png' : '.jpg'));
        await writeFile(file, bytes, { mode: 0o600 });
        staged.add(file);
        return { path: file };
      },
      run: (job, { signal, onProgress } = {}) => this.worker.request('generate', job, { signal, onProgress }),
      free: async () => {
        try {
          return await this.worker.release();
        } finally {
          for (const file of staged) {
            await rm(file, { force: true });
            staged.delete(file);
          }
        }
      },
      original: async source => {
        const media = await generatedMedia(this.outputDir, source);
        try {
          return { bytes: await media.handle.readFile(), mime: media.mime };
        } finally {
          await media.handle.close();
        }
      },
    };
  }
  async close() {
    this.closing = true;
    await this.environment.close();
    await this.worker.close();
    await this.starting?.catch(() => {});
    await this.worker.close();
  }
}
