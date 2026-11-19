import { moveManifests } from './output-manifests.mjs';
import { outputName } from './output-names.mjs';
import { mkdir, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { GenerationWorker } from './generation-worker.mjs';
import { PythonEnvironment, environmentVariables } from './python-environment.mjs';
import { GenerationAssets, suggestTokenizer } from './generation-assets.mjs';
import { NativeWorkflowCatalog } from './native-workflows.mjs';
import { ModelVersions, withVersion } from './model-versions.mjs';
import { ModelDownloads } from './model-downloads.mjs';
import { generatedMedia } from './generated-media.mjs';
import { extractStill } from './video-still.mjs';
import { problem } from './engine.mjs';
import { atomicFile, plainFolder } from './update-files.mjs';
import { families, family, familyCatalog } from './families.mjs';
import { comfyEngine, comfyRelease, comfyRoute, comfyUnsupported, runOnComfy } from './comfy-engine.mjs';
import { ComfyClient, normalizeComfyUrl } from './comfy-client.mjs';
import { findComfyApps, isComfyApp, launchComfy } from './comfy-launch.mjs';
import { MODEL_TREE, namesFor } from './model-tree.mjs';

// The picture so far, as the built-in engine sends it at every step: a JPEG of a few kilobytes
// in base64 (runner/preview.py). Larger, or anything but a JPEG, it is dropped.
const PREVIEW_LIMIT = 2 * 1024 * 1024;
/**
 * A progress message of the built-in engine as the generation expects it: its preview turned
 * into { preview: { bytes, mime } }, as ComfyUI's; null for a preview that is not one.
 */
export function nativeProgress(data) {
  if (!data || typeof data !== 'object' || !Object.hasOwn(data, 'preview')) return data;
  const { mime, data: text } = data.preview ?? {};
  if (mime !== 'image/jpeg' || typeof text !== 'string' || text.length > (PREVIEW_LIMIT / 3) * 4) return null;
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  return { preview: { bytes, mime } };
}

/** A family ComfyUI runs: the others are Atelier's own engine's, whether ComfyUI is set or not. */
const external = name => family(name).engine === 'external';
/** A family that creates pictures or videos with a large model: it wants the card to itself. */
const LARGE = ['create_image', 'create_video', 'extend_video', 'replace_character'];
// The files the engine writes a creation in before it puts it in its place (runner/media.py,
// runner/video/): under the name of the creation, in the folder of the outputs itself.
const TEMPORARY_ENDINGS = ['.tmp.mp4', '.tmp.wav', '.tmp.mux.mp4', '.mux.mp4', '.png.tmp', '.wav.tmp'];
/** Removes what a creation that did not end left half-written; only files of that very name. */
export async function leftTemporaries(outputDir, name) {
  if (!outputDir || !outputName(name)) return;
  for (const ending of TEMPORARY_ENDINGS) await rm(join(outputDir, name + ending), { force: true }).catch(() => {});
}
const large = name => family(name).tasks.some(task => LARGE.includes(task));
const COMFY_MISSING = 'ComfyUI n’est pas réglé : « Démarrer » sur la ligne de MOSS Image (Paramètres › Workflows).';
// The address of ComfyUI when none is kept (its usual one).
const COMFY_DEFAULT_URL = 'http://127.0.0.1:8188';
// How long the settings wait for ComfyUI to say it is there.
const COMFY_PROBE_MS = 2500;
// Memory the machine must still have available for ComfyUI to keep its models loaded, on top
// of what the chat model is about to take (`reserve`, the size of its files). Measured on a
// 32 GiB machine: reloaded with 15.7 GiB available the chat model writes 45 tokens a second,
// with 9.8 GiB only 8, and a proposal takes a minute instead of nine seconds.
const KEEP_ABOVE = 5 * 1024 ** 3;
// The same for the model files the built-in engine keeps in RAM between generations. Measured on
// 32 GiB after a Krea 2 image (13.5 + 4.9 GiB kept), the chat model then loaded and the next image
// made: with nothing given back, the chat ready in 4.8 to 7.1 s (once 26.9 s) and 0.7 GiB left
// beside it; with everything given back (5 GiB here), 3.5 s but the next image 22 s instead of
// 12; with 2 GiB, the text encoder leaves, the model stays: 4.9 s, 5 GiB left, next image 14 s.
const NATIVE_KEEP_ABOVE = 2 * 1024 ** 3;
const STAGED_TYPES = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};
/** Generations a message at most, for every conversation. */
export const MAX_GENERATIONS = 100;
const defaults = {
  enabled: true,
  autoAllow: false,
  // A video agreed on in the conversation starts by itself: Moodix AI clicks « Générer ».
  autoAllowVideos: true,
  // A character replaced in a video is asked for again before it runs (its image, when Moodix AI
  // made it, is always shown to be kept or made again).
  confirmReplacements: false,
  // 100 generations a message at most: imposed by the server, written nowhere in the interface.
  maxIterations: 100,
  // After a video, the chat model reloads and comments a storyboard of it: about a minute.
  // Off, the video ends the turn and the model looks at it when the user asks.
  reviewVideos: false,
  // The same for an image: the model reloads and looks at the picture it made.
  reviewImages: false,
  // The engine imports its libraries as it starts (runner/warm.py, 0.6.105): the first creation
  // of a session begins about five seconds sooner (21.5 s to 16.2 s for a Krea 2 picture, in the
  // application), for 0.7 GiB of RAM held from the launch. On unless the user turns it off.
  warmEngine: true,
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
    (value.maxIterations !== undefined &&
      (!Number.isInteger(value.maxIterations) || value.maxIterations < 1 || value.maxIterations > 10000)) ||
    !['boolean', 'undefined'].includes(typeof value.reviewVideos) ||
    !['boolean', 'undefined'].includes(typeof value.reviewImages) ||
    !['boolean', 'undefined'].includes(typeof value.autoAllowVideos) ||
    !['boolean', 'undefined'].includes(typeof value.confirmReplacements) ||
    !['boolean', 'undefined'].includes(typeof value.warmEngine)
  )
    throw problem('Paramètres de génération invalides.');
  const result = {
    enabled: value.enabled,
    autoAllow: value.autoAllow,
    // Whatever a configuration of before kept: 100 (parametres-maquette.md).
    maxIterations: MAX_GENERATIONS,
    // Absent from settings saved before the choice existed: videos allowed, nothing looked at.
    reviewVideos: value.reviewVideos === true,
    reviewImages: value.reviewImages === true,
    autoAllowVideos: value.autoAllowVideos !== false,
    confirmReplacements: value.confirmReplacements === true,
    // Absent from settings saved before it existed: on.
    warmEngine: value.warmEngine !== false,
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
    findComfy = findComfyApps,
    startComfyApp = launchComfy,
  } = {}) {
    Object.assign(this, { root, dataDir, outputDir, comfyConnect, findComfy, startComfyApp });
    this.path = join(dataDir, 'generation.json');
    this.workerPath = join(dataDir, 'runner-config.json');
    this.config = { ...defaults };
    this.worker = worker || new GenerationWorker({ root });
    this.environment = environment || new PythonEnvironment({ root, dataDir });
    this.worker.onLibrariesFailed = () => void this.#librariesFailed();
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
    // The files of the shipped workflows, downloadable from runner/downloads.json (next to them).
    this.downloads = new ModelDownloads({
      catalogPath: builtinWorkflowDir ? join(builtinWorkflowDir, '..', 'downloads.json') : join(dataDir, 'no-downloads'),
      dataDir,
      assets: this.assets,
      folderOf: (family, role) => this.folderOf(family, role),
    });
    // Shipped workflows come with the application (an update replaces them); the user's own and
    // their edits of shipped ones stay in workflowDir, which updates never touch.
    // (0.6.117) The version of each model the user keeps (the page « Modèles »): none kept, the
    // shipped workflows are made as shipped.
    this.versions = new ModelVersions({
      statePath: join(dataDir, 'model-versions.json'),
      assets: this.assets,
    });
    this.catalog = new NativeWorkflowCatalog(workflowDir, {
      assets: this.assets,
      versions: this.versions,
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
  /** What is kept of ComfyUI (data/comfy-engine.json): {} when nothing is. */
  async #comfyStored() {
    try {
      const stored = JSON.parse(await readFile(join(this.dataDir, 'comfy-engine.json'), 'utf8'));
      return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    } catch {
      return {};
    }
  }
  async #writeComfy(value) {
    const path = join(this.dataDir, 'comfy-engine.json');
    await mkdir(this.dataDir, { recursive: true });
    await atomicFile(path, JSON.stringify(value, null, 2) + '\n');
  }
  /**
   * What the settings show of ComfyUI (the line of MOSS Image): its address, whether it answers
   * now, and else why: `stopped` (nothing listens there: it is not started) or `silent` (it does
   * not answer in time); `app`, the name of the application « Démarrer » starts.
   */
  async comfyState() {
    const stored = await this.#comfyStored();
    const state = {
      enabled: stored.enabled === true,
      baseUrl: typeof stored.baseUrl === 'string' ? stored.baseUrl : '',
      reachable: false,
      version: '',
      reason: 'stopped',
      app: isComfyApp(stored.launchPath) ? basename(stored.launchPath) : '',
    };
    if (!(await this.refreshComfy())) return state;
    try {
      const connect = this.comfyConnect || (baseUrl => new ComfyClient(baseUrl));
      const status = await connect(this.comfy.baseUrl).status({ signal: AbortSignal.timeout(COMFY_PROBE_MS) });
      Object.assign(state, { reachable: true, reason: '', version: String(status.system?.comfyui_version || '') });
    } catch (error) {
      state.reason = error?.cause?.code === 'ECONNREFUSED' || error?.code === 'ECONNREFUSED' ? 'stopped' : 'silent';
    }
    return state;
  }
  /**
   * « Démarrer » (16/11): starts the ComfyUI application on its own, and turns on the families
   * ComfyUI runs (MOSS Image) at the address kept, else the usual one. The application is the one
   * kept, the one given (`launchPath`, chosen by the user), or the only one installed; with none or
   * several, `{ choose: true }`: the user chooses it.
   */
  async startComfy(value = {}) {
    const stored = await this.#comfyStored(),
      exists = async path => (await stat(path).catch(() => null))?.isFile() === true;
    let app = '';
    if (value?.launchPath !== undefined) {
      if (!isComfyApp(value.launchPath) || !(await exists(value.launchPath)))
        throw problem('Choisissez l’application ComfyUI (son fichier .exe, dont le nom contient « Comfy »).');
      app = value.launchPath;
    } else if (isComfyApp(stored.launchPath) && (await exists(stored.launchPath))) app = stored.launchPath;
    else {
      const found = await this.findComfy();
      if (found.length !== 1) return { choose: true, found };
      app = found[0];
    }
    let baseUrl = typeof stored.baseUrl === 'string' && stored.baseUrl.trim() ? stored.baseUrl.trim() : COMFY_DEFAULT_URL;
    try {
      normalizeComfyUrl(baseUrl);
    } catch {
      baseUrl = COMFY_DEFAULT_URL;
    }
    await this.#writeComfy({ ...stored, enabled: true, baseUrl, launchPath: app });
    this.startComfyApp(app);
    await this.refreshComfy();
    this.syncCapabilities();
    return { started: true, app: basename(app), comfy: await this.comfyState() };
  }
  /**
   * A few small pictures of a video of the outputs (runner.video.frames): [{ time, url }], or []
   * when the engine is busy or cannot read it. Never waits behind a generation.
   */
  async videoFrames(path, count = 3) {
    if (!this.worker?.idle?.()) return [];
    try {
      const result = await this.worker.request('frames', { path, count, side: 512 }, { timeoutMs: 30000 });
      return Array.isArray(result?.frames) ? result.frames.filter(frame => typeof frame?.url === 'string') : [];
    } catch {
      return [];
    }
  }
  /**
   * The first or the last picture of a video file, at its own size (lib/video-still.mjs): { bytes,
   * width, height, preview }. Read by the Python of the engine in a command of its own, on the
   * processor: it needs neither the worker nor the card, and waits behind nothing. The environment
   * is used as it is: never installed nor updated for this.
   */
  async videoStill(path, at) {
    const python =
      this.config.pythonPath || ((await this.environment.exists()) ? (this.environment.interpreter?.() ?? '') : '');
    return extractStill({
      python,
      root: this.root,
      input: path,
      at,
      workDir: join(this.dataDir, 'runtime', 'tmp'),
      env: environmentVariables(join(this.dataDir, 'runtime')),
      run: this.environment.run,
    });
  }
  /** Saves where ComfyUI is, and whether the external families use it (nothing else is kept). */
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
    const { launchPath } = await this.#comfyStored();
    await this.#writeComfy({ enabled: value.enabled, baseUrl, ...(launchPath ? { launchPath } : {}) });
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
    await atomicFile(this.path, JSON.stringify(this.config, null, 2));
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
      enabling = !this.config.enabled && next.enabled,
      disabling = this.config.enabled && !next.enabled;
    await mkdir(this.dataDir, { recursive: true });
    await atomicFile(this.path, JSON.stringify(next, null, 2));
    this.config = next;
    if (changed || disabling) {
      await this.environment.cancel();
      await this.worker.close();
      await this.starting?.catch(() => {});
    }
    // Started when generation was just switched on or its Python changed, or again once its
    // environment is there: saving other settings never downloads it.
    if (
      next.enabled &&
      (changed ||
        enabling ||
        (this.worker.status().state !== 'ready' && (next.pythonPath || (await this.environment.exists()))))
    )
      void this.start().catch(() => {});
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
    // Its environment is there, or a Python of the user's: nothing to download.
    const prepared = Boolean(this.config.pythonPath) || (await this.environment.exists());
    // On (the default), the engine starts with the application once its environment is there;
    // a new installation downloads it only when asked (« Tester », switching generation on).
    if (this.config.enabled) return prepared && !this.closing ? this.start() : undefined;
    if (!this.config.pythonPath && prepared && !this.closing) await this.environment.ensure();
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
        // The manifest of each creation (its whole job, to make it again) apart: the folder of
        // the creations holds only them.
        manifestRoot: join(this.dataDir, 'output-manifests'),
        // Its libraries imported as it starts, not at its first creation (runner/warm.py).
        warm: config.warmEngine !== false,
      }),
      { mode: 0o600 },
    );
    // Those an earlier version left beside the creations join them, once.
    void moveManifests(this.outputDir, join(this.dataDir, 'output-manifests')).catch(() => {});
    if (this.closing) throw problem('Le moteur de génération est fermé.', 503);
    // (0.6.110) An engine that imports its libraries as it starts is their check: the one made in a
    // process of its own before it is skipped while nothing changed (lib/python-environment.mjs).
    const pythonPath =
      config.pythonPath || (await this.environment.ensure({ engineReads: config.warmEngine !== false }));
    if (this.closing) throw problem('Le moteur de génération est fermé.', 503);
    await this.worker.start({
      pythonPath,
      configPath: this.workerPath,
      env: environmentVariables(join(this.dataDir, 'runtime')),
    });
    this.syncCapabilities();
    return this.worker.status();
  }
  /**
   * (0.6.110) The engine could not import one of its libraries. When its environment was taken as
   * checked at this start (the check skipped), that trust is withdrawn and the engine started again:
   * the start then checks the environment as every start did, and says what it finds where a
   * failed start says it. An environment checked at this start is left alone: the failure is the
   * creation's own, and is said there.
   */
  async #librariesFailed() {
    if (this.closing || this.config.pythonPath || !(await this.environment.distrust?.())) return;
    // (A start still on its way ends first: the one below must be a new one, which checks.)
    await this.starting?.catch(() => {});
    await this.worker.close();
    await this.start().catch(() => {});
    this.syncCapabilities();
  }
  /**
   * (0.6.118) The lines of the page « Modèles », in its order (Image, Vidéo, Son, Retouches): one a
   * model, { name, does, group, order, workflows: [{ id, family, version?, used?, provided?,
   * versions? }] }. A model is what its family says it is (`model`, runner/families); the workflows
   * Moodix ships for it are its `workflows` (Real-ESRGAN has two: images, videos), each with its
   * versions when its file is one to choose (lib/model-versions.mjs), else the name of the one
   * version it has (`version`). A workflow created or imported by the user is no line.
   */
  async models(workflows) {
    const lines = new Map();
    for (const workflow of workflows ?? (await this.catalog.list())) {
      if (!workflow.builtin || workflow.update) continue;
      const about = families()[workflow.pipeline]?.model;
      if (!about) continue;
      const shipped = await this.catalog.shippedOf(workflow.id),
        listed = shipped ? await this.versions.list(shipped, { effective: workflow }) : null,
        { name, does, group, order } = about,
        line = lines.get(name) ?? { name, does, group, order, workflows: [] };
      line.workflows.push({
        id: workflow.id,
        family: workflow.pipeline,
        ...(about.version ? { version: about.version } : {}),
        ...(listed ? { used: listed.used, provided: listed.provided, versions: listed.versions } : {}),
      });
      lines.set(about.name, line);
    }
    const rank = line => ['image', 'video', 'audio', 'retouch'].indexOf(line.group);
    return [...lines.values()].sort((a, b) => rank(a) - rank(b) || a.order - b.order);
  }
  /**
   * (0.6.118) Keeps the version at `path` for the model of the shipped workflow `workflowId`. A
   * workflow the user edited is theirs: the version is written into it, as the editor would.
   */
  async useVersion(workflowId, path) {
    if (typeof workflowId !== 'string' || typeof path !== 'string' || !path)
      throw problem('Version invalide.');
    const shipped = await this.catalog.shippedOf(workflowId);
    if (!shipped) throw problem('Ce modèle n’est pas fourni avec Moodix.', 404);
    const listed = (await this.catalog.list()).find(workflow => workflow.id === workflowId);
    if (listed?.customized) {
      // (What the catalog says of a workflow beside what is written in it.)
      const { ready, unavailableReason, unavailableKind, automatic, ...own } = listed;
      await this.catalog.save(withVersion(own, await this.versions.made(shipped, path)));
    } else await this.versions.use(shipped, path);
  }
  async snapshot() {
    const comfy = await this.comfyState();
    this.syncCapabilities();
    const workflows = await this.catalog.list();
    return {
      config: this.config,
      comfy,
      folders: this.folders(),
      families: familyCatalog(),
      runner: this.status(),
      workflows,
      models: await this.models(workflows),
      hiddenWorkflows: await this.catalog.hiddenCount(),
      assets: await this.assets.list(),
      // What the shipped workflows lack and can download, the download in progress, and whether a
      // Hugging Face token is kept (never the token itself).
      downloads: {
        offers: await this.downloads.offers(workflows),
        job: this.downloads.status(),
        hasToken: await this.downloads.hasToken(),
      },
      warning: this.warning || '',
    };
  }
  /**
   * The LoRAs of the Studio's style choice: those ComfyUI lists, and when it is off or silent
   * those of the loras folders themselves (the same files, named the same way).
   */
  async styles({ signal = AbortSignal.timeout(4000) } = {}) {
    const comfy = await this.refreshComfy();
    if (comfy)
      try {
        const connect = this.comfyConnect ?? (baseUrl => new ComfyClient(baseUrl));
        const info = await connect(comfy.baseUrl).objectInfo({ signal, node: 'LoraLoaderModelOnly' });
        const spec = info?.LoraLoaderModelOnly?.input?.required?.lora_name ?? [];
        const listed = ((Array.isArray(spec[0]) ? spec[0] : spec[1]?.options) ?? []).filter(
          name => typeof name === 'string',
        );
        if (listed.length) return listed;
      } catch {}
    return this.ownStyles();
  }
  /** The .safetensors files of the loras folders, as ComfyUI names them: relative to the folder, sub-folders included. */
  async ownStyles() {
    const found = new Set();
    const read = async (folder, prefix, depth) => {
      let entries;
      try {
        entries = await readdir(folder, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && depth < 2)
          await read(join(folder, entry.name), prefix + entry.name + sep, depth + 1);
        else if (entry.isFile() && /\.safetensors$/i.test(entry.name)) found.add(prefix + entry.name);
      }
    };
    for (const folder of this.foldersOf('', 'lora')) await read(folder, '', 0);
    return [...found].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  }
  /**
   * A job as the built-in engine reads it. The style LoRAs of the Studio become LoRAs of the job
   * for a family that takes them here ("styles" in its manifest, their files found in the loras
   * folders); elsewhere they are ComfyUI's only, and left out.
   */
  async ownJob({ styles, ...job }) {
    const manifest = family(job.pipeline);
    if (!styles?.length || !manifest.styles || !manifest.loras) return job;
    const loras = [...(job.loras ?? [])];
    for (const [index, style] of styles.entries()) {
      let path = null;
      for (const folder of this.foldersOf('', 'lora')) {
        const candidate = resolve(folder, style.name);
        // A name stays inside its folder.
        if (!candidate.startsWith(resolve(folder) + sep)) continue;
        if (
          await stat(candidate).then(
            info => info.isFile(),
            () => false,
          )
        ) {
          path = candidate;
          break;
        }
      }
      if (!path) throw problem(`LoRA introuvable dans le dossier loras : ${style.name}.`, 409);
      loras.push({ id: 'style-' + index, path, strength: style.strength });
    }
    return { ...job, loras };
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
        // Only the families declared external go to ComfyUI (MOSS Image): every other one is
        // created by Atelier's engine, whether a ComfyUI is set and answers or not.
        comfy = external(job.pipeline)
          ? await comfyRoute(this.dataDir, job, { ...options, connect: this.comfyConnect })
          : null;
        if (comfy) return {};
        // No built-in engine behind this family: say why ComfyUI did not take the job.
        if (family(job.pipeline).native === false)
          throw problem(
            this.comfy ? `ComfyUI ne prend pas cette demande (${comfyUnsupported(job)}).` : COMFY_MISSING,
            409,
          );
        await ready(options?.signal);
        return this.worker.request('preflight', await this.ownJob(job), options);
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
          // A large model run here: the models ComfyUI kept in memory (MOSS Image's) would leave
          // it too little. Upscaling and interpolation are light, ComfyUI keeps its own.
          if (large(job.pipeline)) await comfyRelease(this.dataDir, { signal, connect: this.comfyConnect });
          try {
            return await this.worker.request('generate', await this.ownJob(job), {
              signal,
              onProgress:
                onProgress &&
                (data => {
                  const value = nativeProgress(data);
                  if (value) onProgress(value);
                }),
            });
          } catch (error) {
            // Stopped or out of time, its worker was ended and could remove nothing: what it
            // was writing goes now (it stayed in the folder of the outputs for an hour).
            await leftTemporaries(this.outputDir, job.outputName);
            throw error;
          }
        }
        // Whatever the built-in engine kept from an earlier generation leaves memory first.
        await this.worker.unload().catch(() => {});
        return runOnComfy(job, {
          ...comfy,
          outputDir: this.outputDir,
          // Its manifest with those of the built-in engine: the folders of the creations hold only them.
          manifestDir: join(this.dataDir, 'output-manifests'),
          signal,
          onProgress,
        });
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
            if (!(room < KEEP_ABOVE)) return { kept: true };
            options = { signal: options.signal };
          }
          // ComfyUI gives its video memory back before the chat model reloads, and keeps its
          // models in main memory for the next generation while the machine has room.
          const { reserve, ...rest } = options ?? {};
          const wanted = Number.isFinite(reserve) && reserve > 0 ? reserve : 0;
          if (comfy) await comfy.client.free({ ...rest, keepAbove: KEEP_ABOVE + wanted });
          // The same for the built-in engine: its files leave, least recently used first (the
          // text encoder before the model), until the chat model has its room and 2 GiB beside it
          // (NATIVE_KEEP_ABOVE); without it coming back, they stay for the next creation.
          return await this.worker.release(wanted ? { keepAbove: NATIVE_KEEP_ABOVE + wanted } : {});
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
    // A download stops; its .part files stay, and it resumes from there next time.
    await this.downloads.close();
    await this.environment.close();
    await this.worker.close();
    await this.starting?.catch(() => {});
    await this.worker.close();
  }
}
