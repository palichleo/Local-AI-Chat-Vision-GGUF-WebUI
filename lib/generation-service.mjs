import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { GenerationWorker } from './generation-worker.mjs';
import { PythonEnvironment, environmentVariables } from './python-environment.mjs';
import { GenerationAssets, suggestTokenizer } from './generation-assets.mjs';
import { NativeWorkflowCatalog } from './native-workflows.mjs';
import { generatedMedia } from './generated-media.mjs';
import { problem } from './engine.mjs';
import { plainFolder } from './update-files.mjs';
import { families, familyCatalog } from './families.mjs';

const STAGED_TYPES = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};
const defaults = {
  enabled: false,
  autoAllow: false,
  maxIterations: 5,
  pythonPath: '',
  modelRoot: '',
  vaeRoot: '',
  loraRoot: '',
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
  // The tokenizer belongs to each workflow now; an older saved tokenizerPath is ignored here
  // and moved into the workflows once (GenerationService.init).
  for (const key of ['pythonPath', 'modelRoot', 'vaeRoot', 'loraRoot']) {
    if (['modelRoot', 'vaeRoot', 'loraRoot'].includes(key) && value[key] === undefined) {
      result[key] = '';
      continue;
    }
    if (typeof value[key] !== 'string' || value[key].length > 4096 || /[\x00\r\n]/.test(value[key]))
      throw problem('Chemin de génération invalide.');
    result[key] = value[key].trim().replace(/^"(.*)"$/, '$1');
    if (result[key] && !isAbsolute(result[key])) throw problem('Un chemin absolu est requis.');
  }
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
    let stored;
    try {
      stored = JSON.parse(await readFile(this.path, 'utf8'));
      this.config = generationConfig(stored);
    } catch (error) {
      if (error.code !== 'ENOENT') this.warning = 'Configuration de génération illisible.';
    }
    if (typeof stored?.tokenizerPath === 'string') await this.#migrateTokenizer(stored.tokenizerPath.trim());
    return this;
  }
  /**
   * Older versions kept one tokenizer folder for the whole application. It moves into every
   * workflow whose family needs one and has none yet, then leaves the configuration file.
   */
  async #migrateTokenizer(path) {
    const failures = [];
    if (path) {
      const workflows = await this.catalog.list().catch(() => []);
      for (const listed of workflows) {
        if (listed.importDraft) continue;
        const roles = Object.entries(families()[listed.pipeline]?.components || {}).filter(
          ([role, spec]) => spec.format === 'tokenizer' && !listed.components[role],
        );
        if (!roles.length) continue;
        try {
          const workflow = await this.catalog.read(listed.id);
          for (const [role] of roles) {
            const asset = await this.assets.register({ path, kind: role, family: workflow.pipeline });
            workflow.components[role] = { policy: 'fixed', asset: asset.id };
          }
          await this.catalog.save(workflow);
        } catch (error) {
          failures.push(`${listed.name} : ${error.message}`);
        }
      }
    }
    if (failures.length) {
      this.warning = 'Tokenizer à choisir dans les workflows : ' + failures.join(' · ');
      return;
    }
    await writeFile(this.path + '.tmp', JSON.stringify(this.config, null, 2), { mode: 0o600 });
    await rename(this.path + '.tmp', this.path);
  }
  /** The tokenizer folder that matches a registered text encoder, registered for that family, or null. */
  async suggestTokenizer(encoderId, family) {
    const manifest = families()[family];
    const entry = Object.entries(manifest?.components || {}).find(([, spec]) => spec.format === 'tokenizer');
    if (!entry) throw problem('Cette famille n’utilise pas de tokenizer séparé.');
    const [role, spec] = entry;
    const encoder = await this.assets.resolve(encoderId, { kind: spec.vocabularyOf, family });
    const known = (await this.assets.list()).filter(asset => asset.kind === role).map(asset => asset.path);
    const found = await suggestTokenizer(encoder.path, known);
    if (!found) return { asset: null };
    return { asset: await this.assets.register({ path: found.path, kind: role, family }) };
  }
  async save(value) {
    const next = generationConfig(value);
    const changed = next.pythonPath !== this.config.pythonPath,
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
      families: familyCatalog(),
      runner: this.status(),
      workflows: await this.catalog.list(),
      assets: await this.assets.list(),
      warning: this.warning || '',
    };
  }
  /** Default browse folder for each component role, as declared by the family manifests. */
  folders(config = this.config) {
    const models = join(this.root, 'models');
    const folders = { model: config.modelRoot || join(models, 'checkpoints'), lora: config.loraRoot || join(models, 'LoRa') };
    for (const manifest of Object.values(families()))
      for (const [role, spec] of Object.entries(manifest.components))
        folders[role] ??= (spec.folder === 'VAE' && config.vaeRoot) || join(models, spec.folder);
    return folders;
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
      // Copies an original image or video where the worker can read it, without loading it in memory.
      stage: async (media, { signal } = {}) => {
        try {
          signal?.throwIfAborted();
          const extension = STAGED_TYPES[media.mime];
          if (!extension || media.info.size > (media.mime.startsWith('video/') ? 512 : 64) * 1024 ** 2)
            throw problem('Fichier source invalide ou trop volumineux (64 Mo par image, 512 Mo par vidéo).');
          await mkdir(this.inputDir, { recursive: true });
          const file = join(this.inputDir, randomUUID() + extension);
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
