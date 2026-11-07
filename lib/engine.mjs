import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, open, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, resolve, dirname, join, delimiter } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareModel } from './gguf.mjs';

export function problem(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export const defaults = Object.freeze({
  enginePath: '', modelPath: '', projectorPath: '', contextSize: 8192, maxOutputTokens: 4096, gpuLayers: 99,
});

export function normalizeConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw problem('Configuration invalide.');
  const result = {};
  for (const key of ['enginePath', 'modelPath', 'projectorPath']) {
    if (typeof input[key] !== 'string' || input[key].length > 4096 || /[\0\r\n]/.test(input[key])) {
      throw problem(`Chemin invalide : ${key}.`);
    }
    result[key] = input[key].trim().replace(/^"(.*)"$/, '$1');
  }
  if (!Number.isInteger(input.contextSize) || input.contextSize < 1024 || input.contextSize > 262144) {
    throw problem('Le contexte doit être compris entre 1 024 et 262 144 tokens.');
  }
  const maxOutputTokens = input.maxOutputTokens ?? Math.min(4096, input.contextSize);
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 128 || maxOutputTokens > Math.min(32768, input.contextSize)) throw problem('La sortie doit être comprise entre 128 tokens et le minimum du contexte et de 32 768 tokens.');
  if (!Number.isInteger(input.gpuLayers) || input.gpuLayers < 0 || input.gpuLayers > 999) {
    throw problem('Le nombre de couches GPU doit être compris entre 0 et 999.');
  }
  return { ...result, contextSize: input.contextSize, maxOutputTokens, gpuLayers: input.gpuLayers };
}

async function checkFile(path, label, gguf = false) {
  if (!path || !isAbsolute(path)) throw problem(`${label} : indique un chemin absolu vers le fichier.`);
  try {
    if (!(await stat(path)).isFile()) throw new Error('not a file');
    await access(path, gguf || process.platform === 'win32' ? constants.R_OK : constants.X_OK);
  } catch {
    throw problem(`${label} introuvable ou inaccessible : ${path}`);
  }
  if (!gguf) return;
  if (!/\.gguf$/i.test(path)) throw problem(`${label} : un fichier .gguf est attendu.`);
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    if (bytesRead !== 4 || header.toString('ascii') !== 'GGUF') throw problem(`${label} : le fichier n’est pas un GGUF valide.`);
  } finally {
    await handle.close();
  }
}

async function freePort() {
  const probe = createServer();
  await new Promise((yes, no) => { probe.once('error', no); probe.listen(0, '127.0.0.1', yes); });
  const port = probe.address().port;
  await new Promise((yes) => probe.close(yes));
  return port;
}

async function nativeEnvironment(config) {
  const env = { ...process.env };
  // Ollama place CUDA à côté du moteur, mais ne l'ajoute pas au chemin du processus lancé seul.
  if (config.gpuLayers > 0 && !env.GGML_BACKEND_PATH) {
    for (const folder of ['cuda_v12', 'cuda_v13']) {
      const directory = join(dirname(config.enginePath), folder);
      const library = join(directory, process.platform === 'win32' ? 'ggml-cuda.dll' : 'libggml-cuda.so');
      try { await access(library, constants.R_OK); }
      catch { continue; }
      env.GGML_BACKEND_PATH = library;
      const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
      env[pathKey] = `${directory}${delimiter}${env[pathKey] || ''}`;
      break;
    }
  }
  return env;
}

export class Engine {
  constructor({ spawnProcess = spawn, cacheDir } = {}) {
    this.spawnProcess = spawnProcess;
    this.cacheDir = cacheDir;
    this.state = 'stopped';
    this.logs = [];
    this.error = '';
    this.busy = false;
    this.child = null;
    this.vision = false;
    this.activeRequest = null;
  }

  status() {
    return { state: this.state, vision: this.vision, busy: this.busy, logs: [...this.logs], error: this.error };
  }

  log(text) {
    const clean = String(text).replace(/\x1b\[[0-9;]*m/g, '');
    for (const line of clean.split(/\r?\n/)) {
      if (line.trim()) this.logs.push(line.slice(0, 1500));
    }
    this.logs = this.logs.slice(-70);
  }

  async start(config) {
    if (this.child || this.state === 'loading' || this.state === 'stopping') throw problem('Le moteur est déjà démarré. Arrête-le avant de changer de modèle.', 409);
    this.state = 'loading';
    this.error = '';
    this.logs = [];
    this.vision = false;
    const loadController = new AbortController();
    this.loadController = loadController;
    try {
      await checkFile(config.enginePath, 'Moteur llama-server');
      if (process.platform === 'win32' && !/\.exe$/i.test(config.enginePath)) throw problem('Sous Windows, sélectionne llama-server.exe.');
      if (config.projectorPath) {
        await checkFile(config.projectorPath, 'Projecteur de vision', true);
        if (resolve(config.projectorPath) === resolve(config.modelPath)) throw problem('Le modèle et son projecteur doivent être deux fichiers différents.');
      }
      await checkFile(config.modelPath, 'Modèle', true);
      const prepared = await prepareModel(config.modelPath, this.cacheDir, (message) => this.log(message));
      const override = prepared.override;
      this.port = await freePort();
      const env = await nativeEnvironment(config);
      if (loadController.signal.aborted) throw problem('Démarrage interrompu.');
      this.apiKey = randomBytes(24).toString('hex');
      this.base = `http://127.0.0.1:${this.port}`;
      const args = [
        '-m', prepared.path, '--host', '127.0.0.1', '--port', String(this.port),
        '--api-key', this.apiKey, '--ctx-size', String(config.contextSize),
        '--n-gpu-layers', String(config.gpuLayers), '--parallel', '1',
        '--jinja', '--reasoning-format', 'deepseek', '--offline',
      ];
      if (config.projectorPath) args.push('--mmproj', config.projectorPath);
      if (config.gpuLayers === 0) args.push('--no-mmproj-offload');
      if (override) {
        args.push('--override-kv', override);
        this.log('Compatibilité Qwen3.5 : MTP déclaré sans poids, désactivé en mémoire. Fichier GGUF inchangé.');
      }
      const child = this.spawnProcess(config.enginePath, args, {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env,
      });
      this.child = child;
      this.exited = new Promise((done) => {
        const finish = (code, signal) => {
          if (this.child !== child) return done();
          this.child = null;
          loadController.abort();
          this.activeRequest?.abort();
          this.busy = false;
          this.vision = false;
          if (this.state !== 'stopping') {
            this.state = 'error';
            this.error ||= `Le moteur s’est arrêté (${signal || `code ${code}`}). Consulte les journaux.`;
          }
          done();
        };
        child.once('exit', finish);
        child.once('error', (error) => {
          this.error = `Impossible de lancer le moteur : ${error.message}`;
          finish(null, null);
        });
      });
      child.stdout?.on('data', (data) => this.log(data));
      child.stderr?.on('data', (data) => this.log(data));
      this.log('Chargement des fichiers locaux…');
      this.waitForReady(child, Boolean(config.projectorPath));
    } catch (error) {
      if (this.loadController === loadController && !loadController.signal.aborted && this.state !== 'stopping' && this.state !== 'stopped') {
        this.state = 'error';
        this.error = error.message;
      }
      throw error;
    }
  }

  async waitForReady(child, vision) {
    const signal = this.loadController.signal;
    const deadline = Date.now() + 300000;
    try {
      while (!signal.aborted && this.child === child) {
        try {
          const response = await fetch(`${this.base}/health`, {
            headers: { Authorization: `Bearer ${this.apiKey}` },
            signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
          });
          const body = await response.json();
          if (response.ok && body.status === 'ok' && !signal.aborted && this.child === child) {
            this.state = 'ready';
            this.vision = vision;
            this.log('Moteur prêt.');
            return;
          }
        } catch { /* Le port n'écoute pas encore pendant le chargement. */ }
        if (Date.now() > deadline) throw new Error('Le chargement dépasse cinq minutes. Vérifie les journaux et la mémoire disponible.');
        await delay(500, undefined, { signal });
      }
    } catch (error) {
      if (signal.aborted || this.child !== child) return;
      this.error = error.message;
      this.state = 'error';
      child.kill();
    }
  }

  async stop() {
    this.activeRequest?.abort();
    this.loadController?.abort();
    this.vision = false;
    if (!this.child) {
      this.state = 'stopped';
      this.busy = false;
      this.error = '';
      return;
    }
    this.state = 'stopping';
    const child = this.child;
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 3000);
    force.unref();
    await this.exited;
    clearTimeout(force);
    this.state = 'stopped';
    this.error = '';
  }
}
