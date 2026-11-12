import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
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
import { families, family, familyCatalog } from './families.mjs';
import { comfyEngine, comfyRelease, comfyRoute, comfyUnsupported, runOnComfy } from './comfy-engine.mjs';
import { ComfyClient, normalizeComfyUrl } from './comfy-client.mjs';
import { MODEL_TREE, namesFor } from './model-tree.mjs';

// The built-in engine reads a job strictly: the style LoRAs of the Studio are ComfyUI's only.
const ownJob = ({ styles, ...job }) => job;
const COMFY_MISSING = 'ComfyUI n’est pas configuré : réglages, Workflows, moteur externe.';
// How long the settings wait for ComfyUI to say it is there.
const COMFY_PROBE_MS = 2500;
// Memory the machine must still have available for ComfyUI to keep its models loaded, on top
// of what the chat model is about to take (`reserve`, the size of its files). Measured on a
// 32 GiB machine: reloaded with 15.7 GiB available the chat model writes 45 tokens a second,
// with 9.8 GiB only 8, and a proposal takes a minute instead of nine seconds.
const COMFY_KEEP_ABOVE = 5 * 1024 ** 3;
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
  // After a video, the chat model reloads and comments a storyboard of it: about a minute.
  // Off, the video ends the turn and the model looks at it when the user asks.
  reviewVideos: false,
  pythonPath: '',
  // The models directory, sorted as ComfyUI sorts its own: ComfyUI's, or Atelier's when empty.
  modelsDir: '',
  modelRoot: '',
  vaeRoot: '',
  loraRoot: '',
  textEncoderRoot: '',
  tokenizerRoot: '',
  upscaleRoot: '',
  latentUpscaleRoot: '',
};
// A folder apart for one kind of file, when it is not where the models directory has it;
// absent from settings saved before they existed.
const ROOTS = [
  'modelRoot',
  'vaeRoot',
  'loraRoot',
  'textEncoderRoot',
  'tokenizerRoot',
  'upscaleRoot',
  'latentUpscaleRoot',
];
// Which of them holds the files a family manifest sorts under `folder`.
const ROOT_OF = {
  diffusion_models: 'modelRoot',
  vae: 'vaeRoot',
  text_encoders: 'textEncoderRoot',
  loras: 'loraRoot',
  upscale_models: 'upscaleRoot',
  latent_upscale_models: 'latentUpscaleRoot',
};
/** Every folder setting: the models directory, then the folders apart. */
export const FOLDER_KEYS = ['modelsDir', ...ROOTS];
export function generationConfig(value) {
  if (
    !value ||
    typeof value.enabled !== 'boolean' ||
    typeof value.autoAllow !== 'boolean' ||
    !Number.isInteger(value.maxIterations) ||
    value.maxIterations < 1 ||
    value.maxIterations > 10000 ||
    !['boolean', 'undefined'].includes(typeof value.reviewVideos)
  )
    throw problem('Paramètres de génération invalides.');
  const result = {
    enabled: value.enabled,
    autoAllow: value.autoAllow,
    maxIterations: value.maxIterations,
    // Absent from settings saved before the choice existed.
    reviewVideos: value.reviewVideos === true,
  };
  // The tokenizer belongs to each workflow now; an older saved tokenizerPath is ignored here
  // and moved into the workflows once (GenerationService.init).
  for (const key of ['pythonPath', ...FOLDER_KEYS]) {
    if (FOLDER_KEYS.includes(key) && value[key] === undefined) {
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
  constructor({
    root,
    dataDir,
    workflowDir,
    builtinWorkflowDir = null,
    outputDir,
    worker,
    environment,
    comfyConnect,
  } = {}) {
    Object.assign(this, { root, dataDir, outputDir, comfyConnect });
    this.path = join(dataDir, 'generation.json');
    this.workerPath = join(dataDir, 'runner-config.json');
    this.config = { ...defaults };
    this.worker = worker || new GenerationWorker({ root });
    this.environment = environment || new PythonEnvironment({ root, dataDir });
    this.assets = new GenerationAssets(join(dataDir, 'generation-assets.json'), {
      // A shared workflow's files: every folder a kind of file may be in, the models directory
      // itself (its other folders, one level down), and what is next to a folder set apart.
      roots: () => [
        ...this.searchFolders(),
        this.modelsDir(),
        join(root, 'models'),
        ...ROOTS.map(key => this.config[key])
          .filter(Boolean)
          .map(dirname),
      ],
      // Where a component no workflow fixes takes its file.
      folder: (family, kind) => this.foldersOf(family, kind),
    });
    // Shipped workflows come with the application (an update replaces them); the user's own and
    // their edits of shipped ones stay in workflowDir, which updates never touch.
    this.catalog = new NativeWorkflowCatalog(workflowDir, {
      assets: this.assets,
      builtin: builtinWorkflowDir,
      statePath: join(dataDir, 'workflow-natives.json'),
      historyPath: builtinWorkflowDir ? join(builtinWorkflowDir, '..', 'workflow-history.json') : null,
    });
    this.inputDir = join(dataDir, 'runner-input');
    // The ComfyUI that runs the external families (data/comfy-engine.json), or null.
    this.comfy = null;
  }
  /** Reads again where ComfyUI is: the file may have been written by hand. */
  async refreshComfy() {
    this.comfy = await comfyEngine(this.dataDir);
    return this.comfy;
  }
  /** What the settings show of the external engine: its address, and whether it answers now. */
  async comfyState() {
    let stored = {};
    try {
      stored = JSON.parse(await readFile(join(this.dataDir, 'comfy-engine.json'), 'utf8'));
    } catch {}
    const state = {
      enabled: stored?.enabled === true,
      baseUrl: typeof stored?.baseUrl === 'string' ? stored.baseUrl : '',
      reachable: false,
      version: '',
    };
    if (!(await this.refreshComfy())) return state;
    try {
      const connect = this.comfyConnect || (baseUrl => new ComfyClient(baseUrl));
      const status = await connect(this.comfy.baseUrl).status({ signal: AbortSignal.timeout(COMFY_PROBE_MS) });
      Object.assign(state, { reachable: true, version: String(status.system?.comfyui_version || '') });
    } catch {}
    return state;
  }
  /** Saves where ComfyUI is, and whether the external families use it. */
  async saveComfy(value) {
    if (!value || typeof value.enabled !== 'boolean' || typeof value.baseUrl !== 'string')
      throw problem('Réglage ComfyUI invalide.');
    const baseUrl = value.baseUrl.trim();
    // An empty address is only kept while the engine is off.
    if (value.enabled || baseUrl) {
      try {
        normalizeComfyUrl(baseUrl);
      } catch {
        throw problem('Adresse ComfyUI invalide : une adresse locale comme http://127.0.0.1:8188 est attendue.');
      }
    }
    const path = join(this.dataDir, 'comfy-engine.json');
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(path + '.tmp', JSON.stringify({ enabled: value.enabled, baseUrl }, null, 2) + '\n', {
      mode: 0o600,
    });
    await rename(path + '.tmp', path);
    return this.snapshot();
  }
  async init() {
    let stored;
    try {
      stored = JSON.parse(await readFile(this.path, 'utf8'));
      this.config = generationConfig(stored);
    } catch (error) {
      if (error.code !== 'ENOENT') this.warning = 'Configuration de génération illisible.';
    }
    await this.refreshComfy();
    if (typeof stored?.tokenizerPath === 'string') await this.#migrateTokenizer(stored.tokenizerPath.trim());
    // Atelier's own models directory is sorted as ComfyUI's: its folders are there to be filled.
    for (const name of MODEL_TREE) await mkdir(join(this.root, 'models', name), { recursive: true }).catch(() => {});
    try {
      await this.catalog.adoptShipped();
    } catch (error) {
      this.warning = 'Workflows fournis non vérifiés : ' + error.message;
    }
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
    const comfy = await this.comfyState();
    this.syncCapabilities();
    return {
      config: this.config,
      comfy,
      folders: this.folders(),
      families: familyCatalog(),
      runner: this.status(),
      workflows: await this.catalog.list(),
      hiddenWorkflows: await this.catalog.hiddenCount(),
      assets: await this.assets.list(),
      warning: this.warning || '',
    };
  }
  /** The LoRAs ComfyUI lists, for the Studio's style choice; none when ComfyUI is off or silent. */
  async styles({ signal = AbortSignal.timeout(4000) } = {}) {
    const comfy = await this.refreshComfy();
    if (!comfy) return [];
    try {
      const connect = this.comfyConnect ?? (baseUrl => new ComfyClient(baseUrl));
      const info = await connect(comfy.baseUrl).objectInfo({ signal, node: 'LoraLoaderModelOnly' });
      const spec = info?.LoraLoaderModelOnly?.input?.required?.lora_name ?? [];
      const listed = (Array.isArray(spec[0]) ? spec[0] : spec[1]?.options) ?? [];
      return listed.filter(name => typeof name === 'string');
    } catch {
      return [];
    }
  }
  /** The models directory in use: the one of the settings (a ComfyUI's, say), else Atelier's own. */
  modelsDir(config = this.config) {
    return config.modelsDir || join(this.root, 'models');
  }
  /**
   * Every folder that may hold the files a manifest sorts under `name`, the first being where
   * they are expected: the folder set apart for them (`apart`) or the one of that name in the
   * models directory; then the other names ComfyUI reads them from, and what Atelier called
   * the folder before; the same in Atelier's own directory when another one is in use.
   */
  #foldersNamed(name, apart, config) {
    const own = join(this.root, 'models'),
      chosen = this.modelsDir(config),
      folders = apart ? [apart] : [];
    for (const directory of [chosen, own]) for (const other of namesFor(name)) folders.push(join(directory, other));
    return [...new Set(folders)];
  }
  /** The folders of one component of a family (see #foldersNamed); a tokenizer lives with the text encoders unless set apart. */
  foldersOf(family, role, config = this.config) {
    if (role === 'lora') return this.#foldersNamed('loras', config.loraRoot, config);
    const spec = families()[family]?.components[role];
    if (!spec) return [];
    return this.#foldersNamed(
      spec.folder,
      (spec.format === 'tokenizer' && config.tokenizerRoot) || config[ROOT_OF[spec.folder]],
      config,
    );
  }
  /** Where the files of one component are expected, or null for a role the family does not have. */
  folderOf(family, role, config = this.config) {
    return this.foldersOf(family, role, config)[0] ?? null;
  }
  /** Every folder a generation file may be in, for the searches by name. */
  searchFolders(config = this.config) {
    const folders = this.foldersOf('', 'lora', config);
    for (const manifest of Object.values(families()))
      for (const role of Object.keys(manifest.components))
        folders.push(...this.foldersOf(manifest.family, role, config));
    return [...new Set(folders)];
  }
  /**
   * Default browse folder for each component role, as declared by the family manifests. Two
   * families give the same role to different kinds of file (« upscaler » is an image model for
   * Real-ESRGAN, a latent one for LTX): the role is the image one here, `latentUpscaler` the other.
   */
  folders(config = this.config) {
    const models = this.modelsDir(config);
    const folders = {
      // The directory itself, as the settings show it.
      models,
      model: config.modelRoot || join(models, 'diffusion_models'),
      lora: config.loraRoot || join(models, 'loras'),
      textEncoder: config.textEncoderRoot || join(models, 'text_encoders'),
      tokenizer: config.tokenizerRoot || config.textEncoderRoot || join(models, 'text_encoders'),
      upscaler: config.upscaleRoot || join(models, 'upscale_models'),
      latentUpscaler: config.latentUpscaleRoot || join(models, 'latent_upscale_models'),
    };
    for (const manifest of Object.values(families()))
      for (const role of Object.keys(manifest.components))
        folders[role] ??= this.folderOf(manifest.family, role, config);
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
  /**
   * Which families can run now. The built-in engine answers for its own; a family ComfyUI
   * runs ("engine": "external") is ready as soon as ComfyUI is set, whatever the state of
   * the built-in engine. Whether ComfyUI answers is checked when a generation starts.
   */
  syncCapabilities() {
    const state = this.status();
    const capabilities = structuredClone(state.capabilities ?? {});
    // A worker restarting after a cancelled generation is back in seconds, and a request
    // waits for it: its workflows stay offered meanwhile.
    if (state.state !== 'ready' && !state.recovering)
      for (const capability of Object.values(capabilities)) {
        capability.ready = false;
        capability.reason = state.error || 'Moteur Python indisponible.';
      }
    for (const [name, manifest] of Object.entries(families())) {
      // Before the built-in engine has said what it runs: said as it is, not as a missing family.
      const builtIn = manifest.native !== false && !(manifest.engine === 'external' && this.comfy);
      if (builtIn && !capabilities[name] && state.state !== 'ready')
        capabilities[name] = {
          ready: false,
          mediaType: manifest.mediaType,
          reason: ['starting', 'installing'].includes(state.state)
            ? 'Le moteur de génération démarre…'
            : state.error || 'Moteur de génération arrêté.',
        };
      if (manifest.engine !== 'external') continue;
      if (this.comfy) capabilities[name] = { ready: true, mediaType: manifest.mediaType, reason: '' };
      else if (manifest.native === false)
        capabilities[name] = { ready: false, mediaType: manifest.mediaType, reason: COMFY_MISSING };
    }
    this.catalog.capabilities = capabilities;
  }
  client() {
    const staged = new Set();
    // Set by preflight when this job goes to ComfyUI.
    let comfy = null;
    // Starts the built-in worker if it is not running; gives up when the job is cancelled.
    const ready = async signal => {
      signal?.throwIfAborted();
      if (this.worker.status().state === 'ready') return;
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
    };
    return {
      status: async ({ signal } = {}) => {
        // With ComfyUI set, the worker only starts for a job it runs itself (preflight):
        // starting Python for nothing costs several seconds before every first generation.
        if (await this.refreshComfy()) signal?.throwIfAborted();
        else await ready(signal);
        return { idle: !this.worker.status().busy };
      },
      preflight: async (job, options) => {
        comfy = await comfyRoute(this.dataDir, job, { ...options, connect: this.comfyConnect });
        if (comfy) return {};
        // No built-in engine behind this family: say why ComfyUI did not take the job.
        if (family(job.pipeline).native === false)
          throw problem(
            this.comfy ? `ComfyUI ne prend pas cette demande (${comfyUnsupported(job)}).` : COMFY_MISSING,
            409,
          );
        await ready(options?.signal);
        return this.worker.request('preflight', ownJob(job), options);
      },
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
      run: async (job, { signal, onProgress } = {}) => {
        if (!comfy) {
          // A large model run here (a continuation): the models ComfyUI kept in memory would
          // leave it too little. Upscaling and interpolation are light, ComfyUI keeps its own.
          if (family(job.pipeline).engine === 'external')
            await comfyRelease(this.dataDir, { signal, connect: this.comfyConnect });
          return this.worker.request('generate', ownJob(job), { signal, onProgress });
        }
        // Whatever the built-in engine kept from an earlier generation leaves memory first.
        await this.worker.unload().catch(() => {});
        return runOnComfy(job, { ...comfy, outputDir: this.outputDir, signal, onProgress });
      },
      free: async options => {
        try {
          // The Studio goes on creating: the models stay on the card, where the next creation
          // finds them; only the copies of the sources go (below). Only while the machine has
          // main memory left with them loaded: a video model keeps seventeen gigabytes of it
          // beside the card (three left out of thirty-two, measured), which is no state to
          // leave a computer in. Then everything is given back, as after any generation.
          if (options?.keep) {
            const room = comfy
              ? Number((await comfy.client.status({ signal: options.signal }).catch(() => null))?.system?.ram_free)
              : Infinity;
            if (!(room < COMFY_KEEP_ABOVE)) return { kept: true };
            options = { signal: options.signal };
          }
          // ComfyUI gives its video memory back before the chat model reloads, and keeps its
          // models in main memory for the next generation while the machine has room.
          if (comfy) {
            const { reserve, ...rest } = options ?? {};
            await comfy.client.free({
              ...rest,
              keepAbove: COMFY_KEEP_ABOVE + (Number.isFinite(reserve) && reserve > 0 ? reserve : 0),
            });
          }
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
  /** Unloads the models the image/video worker keeps in RAM and VRAM between generations. */
  unload() {
    return this.worker.unload();
  }
  async close() {
    this.closing = true;
    await this.environment.close();
    await this.worker.close();
    await this.starting?.catch(() => {});
    await this.worker.close();
  }
}
