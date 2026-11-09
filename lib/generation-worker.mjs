import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const failure = message => Object.assign(new Error(message), { status: 503 });
export class GenerationWorker {
  constructor({ root, spawnProcess = spawn, handshakeMs = 60000, stopMs = 3000 } = {}) {
    this.root = resolve(root || '.');
    this.spawnProcess = spawnProcess;
    this.handshakeMs = handshakeMs;
    this.stopMs = stopMs;
    this.child = null;
    this.pending = new Map();
    this.state = 'stopped';
    this.error = '';
    this.capabilities = {};
    this.closing = false;
  }
  status() {
    return {
      state: this.state,
      error: this.error,
      capabilities: this.capabilities,
      busy: [...this.pending.values()].some(p => p.method === 'generate'),
    };
  }
  async start(config) {
    if (this.closingTask) await this.closingTask;
    if (this.terminating) await this.terminating;
    if (this.state === 'ready') return this.status();
    if (this.starting) return this.starting;
    this.closing = false;
    this.config = config;
    this.starting = this.#start(config).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  async #start(config) {
    const candidates = config.pythonPath
      ? [config.pythonPath]
      : [
          process.env.ATELIER_PYTHON,
          ...(process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']),
        ].filter(Boolean);
    let last;
    for (const python of candidates) {
      if (this.closing) break;
      this.state = 'starting';
      this.error = '';
      try {
        await this.#launch(python, config);
        if (this.closing) {
          await this.#terminate();
          break;
        }
        this.state = 'ready';
        this.error = '';
        return this.status();
      } catch (error) {
        last = error;
        await this.#terminate();
      }
    }
    this.state = this.closing ? 'stopped' : 'unavailable';
    this.error = this.closing ? 'Le moteur Python est fermé.' : last?.message || 'Python est introuvable.';
    throw failure(this.error);
  }
  #launch(python, config) {
    return new Promise((yes, no) => {
      const bootstrap =
        "import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module('runner',run_name='__main__')";
      let child;
      try {
        child = this.spawnProcess(python, ['-s', '-u', '-c', bootstrap, this.root, '--config', config.configPath], {
          cwd: this.root,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            ...config.env,
            HF_HUB_OFFLINE: '1',
            TRANSFORMERS_OFFLINE: '1',
            PYTHONIOENCODING: 'utf-8',
            PYTHONNOUSERSITE: '1',
          },
        });
      } catch (error) {
        no(error);
        return;
      }
      this.child = child;
      this.closed = new Promise(done => child.once('close', done));
      child.stdin.on('error', () => {});
      let buffer = '',
        ready = false,
        stderr = '';
      const timer = setTimeout(() => no(failure('Le moteur Python ne répond pas au démarrage.')), this.handshakeMs);
      const reject = error => {
        clearTimeout(timer);
        no(error);
        this.#fail(error);
      };
      child.on('error', error => reject(failure(`Python indisponible : ${error.message}`)));
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', text => {
        stderr = (stderr + text).slice(-8000);
      });
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', text => {
        if (this.child !== child) return;
        buffer += text;
        if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) {
          reject(failure('Réponse Python trop longue.'));
          void this.#terminate();
          return;
        }
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            reject(failure('Protocole Python : JSON invalide.'));
            void this.#terminate();
            return;
          }
          if (event.event === 'ready') {
            if (ready || event.protocol !== 1 || !event.capabilities || typeof event.capabilities !== 'object') {
              reject(failure('Version du protocole Python incompatible.'));
              void this.#terminate();
              return;
            }
            ready = true;
            clearTimeout(timer);
            this.capabilities = event.capabilities;
            yes();
            continue;
          }
          if (!ready) {
            reject(failure('Le moteur Python n’a pas confirmé son démarrage.'));
            void this.#terminate();
            return;
          }
          const pending = this.pending.get(event.id);
          if (!pending) continue;
          if (event.event === 'progress') {
            try {
              pending.onProgress?.(event.data);
            } catch {}
            continue;
          }
          this.pending.delete(event.id);
          pending.dispose();
          if (event.error) pending.no(failure(String(event.error.message || 'Erreur du moteur Python.')));
          else if (Object.hasOwn(event, 'result')) pending.yes(event.result);
          else pending.no(failure('Réponse Python invalide.'));
        }
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (this.child === child) {
          this.child = null;
          this.state = this.closing ? 'stopped' : 'unavailable';
        }
        const error = failure(
          `Le moteur Python s’est arrêté (${signal || code}).${stderr ? ' ' + stderr.trim().slice(-1500) : ''}`,
        );
        if (!ready) no(error);
        this.#fail(error);
      });
    });
  }
  #fail(error) {
    this.error = error.message;
    for (const item of this.pending.values()) {
      item.dispose();
      item.no(error);
    }
    this.pending.clear();
  }
  request(method, params = {}, { signal, onProgress, timeoutMs = method === 'generate' ? 3600000 : 60000 } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason || failure('Opération annulée.'));
    if (this.state !== 'ready' || !this.child)
      return Promise.reject(failure(this.error || 'Le moteur Python est indisponible.'));
    if (method === 'generate' && this.status().busy)
      return Promise.reject(failure('Une génération est déjà en cours.'));
    const child = this.child,
      id = randomUUID();
    return new Promise((yes, no) => {
      let disposed = false;
      const abort = () => {
        if (disposed) return;
        this.pending.delete(id);
        dispose();
        void this.#terminate().then(() => no(failure('Génération annulée.')));
      };
      const timer = setTimeout(() => {
        if (disposed) return;
        this.pending.delete(id);
        dispose();
        void this.#terminate().then(() => no(failure('Le moteur Python a dépassé le délai.')));
      }, timeoutMs);
      const dispose = () => {
        disposed = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      this.pending.set(id, { method, yes, no, onProgress, dispose });
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (error && this.pending.delete(id)) {
          dispose();
          no(failure(error.message));
        }
      });
    });
  }
  async release() {
    if (!this.child) return { released: true, allocatedGiB: 0 };
    const result = await this.request('release');
    if (result?.released !== true) throw failure('La libération du GPU n’a pas été confirmée.');
    return result;
  }
  async #terminate() {
    if (this.terminating) return this.terminating;
    this.terminating = this.#stopChild().finally(() => {
      this.terminating = null;
    });
    return this.terminating;
  }
  async #stopChild() {
    const child = this.child;
    if (!child) return;
    this.state = 'stopping';
    child.stdin?.end();
    child.kill();
    await Promise.race([this.closed, delay(this.stopMs)]);
    if (this.child === child) {
      child.kill('SIGKILL');
      await this.closed;
    }
    if (this.child === child) this.child = null;
  }
  close() {
    if (!this.closingTask)
      this.closingTask = this.#close().finally(() => {
        this.closingTask = null;
      });
    return this.closingTask;
  }
  async #close() {
    this.closing = true;
    if (this.child && this.state === 'ready' && !this.status().busy && !this.child.stdin.writableEnded) {
      const child = this.child;
      child.stdin.end(JSON.stringify({ id: randomUUID(), method: 'shutdown', params: {} }) + '\n');
      await Promise.race([this.closed, delay(this.stopMs)]);
      if (this.child === child) await this.#terminate();
    } else await this.#terminate();
    await this.starting?.catch(() => {});
    await this.#terminate();
    this.state = 'stopped';
    this.#fail(failure('Le moteur Python est fermé.'));
  }
}
