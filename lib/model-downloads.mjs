import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, statfs as fsStatfs, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { families } from './families.mjs';

/**
 * Downloads the files a shipped workflow names and this computer does not have, from the
 * sources listed in runner/downloads.json (keyed by the file name the workflow gives). Each
 * file goes to the folder of its kind in the models directory of the settings, under the name
 * of its source; it is then registered for the workflow, which finds it without any setting.
 *
 * A download resumes where it stopped (the `.part` file stays), checks the room on the disk
 * first, and checks size and SHA-256 at the end. A folder (a diffusers model, a tokenizer) is
 * filled under `<name>.download` and takes its name only once complete.
 */
const HUGGING_FACE = 'https://huggingface.co';
// Room left free on the disk after a download.
const MARGIN = 2 * 1024 ** 3;
const TOKEN = /^[\x21-\x7e]{8,200}$/;

const problem = (message, status = 400) => Object.assign(new Error(message), { status });
const hfUrl = (repo, revision, path) =>
  `${HUGGING_FACE}/${repo}/resolve/${revision}/${path.split('/').map(encodeURIComponent).join('/')}`;
export const formatBytes = bytes =>
  bytes >= 1024 ** 3
    ? (bytes / 1024 ** 3).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' Go'
    : Math.max(1, Math.round(bytes / 1024 ** 2)).toLocaleString('fr-FR') + ' Mo';

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
/**
 * A file is only given its name once complete and checked (it is `.part` before): a file of a
 * folder being filled that has its name and its size is done, whatever stopped the download.
 */
async function done(file) {
  return !(await exists(file.path + '.part')) && (await sizeOf(file.path)) === file.size;
}
async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash;
}

export class ModelDownloads {
  constructor({ catalogPath, dataDir, assets, folderOf, fetchImpl = fetch, statfs = fsStatfs }) {
    Object.assign(this, { catalogPath, assets, folderOf, fetchImpl, statfs });
    this.tokenPath = join(dataDir, 'huggingface-token');
    this.job = { state: 'idle' };
    this.controller = null;
    this.catalogCache = null;
  }
  async catalog() {
    if (!this.catalogCache)
      try {
        this.catalogCache = JSON.parse(await readFile(this.catalogPath, 'utf8'));
      } catch {
        this.catalogCache = {};
      }
    return this.catalogCache;
  }
  async #token() {
    try {
      const token = (await readFile(this.tokenPath, 'utf8')).trim();
      return TOKEN.test(token) ? token : '';
    } catch {
      return '';
    }
  }
  async hasToken() {
    return Boolean(await this.#token());
  }
  /** Keeps the Hugging Face token on this computer only; an empty one removes it. */
  async setToken(value) {
    const token = typeof value === 'string' ? value.trim() : '';
    if (!token) {
      await rm(this.tokenPath, { force: true });
      return false;
    }
    if (!TOKEN.test(token)) throw problem('Jeton Hugging Face invalide.');
    await writeFile(this.tokenPath, token, { mode: 0o600 });
    return true;
  }
  /** Whether the file of a component cannot be found at all (as opposed to found and unsuitable). */
  async #absent(workflow, role, policy) {
    try {
      await this.assets.resolve(policy.asset, { kind: role, family: workflow.pipeline, file: policy.file });
      return false;
    } catch (error) {
      return error.code === 'ENOENT' || /not found|absolute local path|Aucun fichier/.test(error.message);
    }
  }
  /** The components of a workflow whose file is not here, each with its source when one is known. */
  async missing(workflow) {
    if (!families()[workflow.pipeline]) return [];
    const catalog = await this.catalog(),
      missing = [];
    for (const [role, policy] of Object.entries(workflow.components || {})) {
      if (policy?.policy !== 'fixed' || !policy.file || !policy.asset) continue;
      if (await this.#absent(workflow, role, policy))
        missing.push({ role, file: policy.file, asset: policy.asset, source: catalog[policy.file] || null });
    }
    return missing;
  }
  /** For each shipped workflow that lacks files: which, how much to download, and whether a token is needed. */
  async offers(workflows) {
    const offers = {},
      token = await this.hasToken();
    for (const record of workflows) {
      if (!record.builtin || record.importDraft || record.ready) continue;
      const missing = await this.missing(record);
      if (!missing.length) continue;
      const known = missing.filter(item => item.source);
      const gated = known.some(item => item.source.gated);
      const bytes = known.reduce((sum, item) => sum + item.source.size, 0);
      // What a stopped download already holds is not fetched again: what is left is said.
      let left = bytes;
      try {
        left = 0;
        for (const file of this.#plan(record, known).flatMap(item => item.files))
          left += (await done(file)) ? 0 : file.size - Math.min(file.size, await sizeOf(file.path + '.part'));
      } catch {
        left = bytes;
      }
      offers[record.id] = {
        files: missing.map(item => ({ role: item.role, file: item.file, size: item.source?.size ?? null })),
        bytes,
        left,
        complete: known.length === missing.length,
        gated,
        needsToken: gated && !token,
        page: known.find(item => item.source.page)?.source.page || '',
      };
    }
    return offers;
  }
  status() {
    const { state, workflowId, name, received = 0, total = 0, current = '', error = '' } = this.job;
    return { state, workflowId, name, received, total, current, error };
  }
  /** Where each missing file goes, and the files to fetch for it (one, or those of a folder). */
  #plan(workflow, missing) {
    return missing.map(item => {
      const folder = this.folderOf(workflow.pipeline, item.role),
        source = item.source;
      if (!folder) throw problem(`Aucun dossier pour « ${item.role} ».`);
      if (source.folder) {
        const target = join(folder, item.file),
          staging = target + '.download';
        return {
          ...item,
          target,
          staging,
          files: source.files.map(file => ({
            url: hfUrl(source.repo, source.revision, file.path),
            path: join(staging, ...file.path.split('/')),
            size: file.size,
            sha256: file.sha256 || '',
            gated: Boolean(source.gated),
          })),
        };
      }
      const url = source.url || hfUrl(source.repo, source.revision, source.path);
      const target = join(folder, basename(source.path || new URL(url).pathname));
      return {
        ...item,
        target,
        files: [{ url, path: target, size: source.size, sha256: source.sha256 || '', gated: Boolean(source.gated), source }],
      };
    });
  }
  async start(workflow) {
    if (this.job.state === 'running') throw problem('Un téléchargement est déjà en cours.', 409);
    if (!workflow?.builtin) throw problem('Seuls les workflows fournis avec Atelier se téléchargent.');
    const missing = await this.missing(workflow);
    if (!missing.length) throw problem('Rien à télécharger : tous les fichiers de ce workflow sont là.');
    const unknown = missing.filter(item => !item.source);
    if (unknown.length)
      throw problem(`Pas de source connue pour ${unknown.map(item => item.file).join(', ')} : placez-le dans son dossier.`);
    const token = await this.#token();
    const page = missing.find(item => item.source.page)?.source.page;
    if (missing.some(item => item.source.gated) && !token)
      throw problem(
        `Ces fichiers demandent un compte Hugging Face : acceptez la licence sur ${page}, puis enregistrez votre jeton dans l’onglet Mise à jour.`,
        403,
      );
    const plan = this.#plan(workflow, missing);
    // Nothing is overwritten: a file of that name which is not the workflow's stays.
    for (const item of plan)
      if (await exists(item.target)) {
        const file = item.files[0];
        const complete = !item.staging && (await sizeOf(item.target)) === file.size;
        if (!complete)
          throw problem(`${basename(item.target)} existe déjà dans ${this.folderOf(workflow.pipeline, item.role)} sans convenir à ce workflow.`, 409);
        item.files = [];
      }
    // Room on each disk for what remains to fetch there.
    const needs = new Map();
    for (const item of plan)
      for (const file of item.files) {
        const folder = this.folderOf(workflow.pipeline, item.role);
        await mkdir(folder, { recursive: true });
        const left = file.size - (await sizeOf(file.path + '.part'));
        needs.set(folder, (needs.get(folder) || 0) + Math.max(0, left));
      }
    for (const [folder, bytes] of needs) {
      const disk = await this.statfs(folder);
      const free = Number(disk.bavail) * Number(disk.bsize);
      if (bytes + MARGIN > free)
        throw problem(`Pas assez de place dans ${folder} : ${formatBytes(bytes)} à télécharger, ${formatBytes(free)} libres.`, 507);
    }
    const files = plan.flatMap(item => item.files);
    let received = 0;
    for (const file of files)
      received += (await done(file)) ? file.size : Math.min(file.size, await sizeOf(file.path + '.part'));
    this.controller = new AbortController();
    this.job = {
      state: 'running',
      workflowId: workflow.id,
      name: workflow.name,
      total: files.reduce((sum, file) => sum + file.size, 0),
      received,
      current: '',
      error: '',
    };
    const signal = this.controller.signal;
    this.task = this.#run(plan, workflow, token, signal).then(
      () => {
        this.job = { ...this.job, state: 'done', current: '' };
      },
      error => {
        this.job = signal.aborted
          ? { ...this.job, state: 'cancelled', current: '' }
          : { ...this.job, state: 'error', current: '', error: error.message };
      },
    );
    return this.status();
  }
  async #run(plan, workflow, token, signal) {
    for (const item of plan) {
      for (const file of item.files) {
        this.job.current = basename(file.path);
        await this.#fetchFile(file, token, signal);
      }
      if (item.staging) {
        if (await exists(item.target)) throw problem(`${basename(item.target)} existe déjà.`, 409);
        await rename(item.staging, item.target);
      }
      await this.assets.register({ id: item.asset, path: item.target, kind: item.role, family: workflow.pipeline });
    }
  }
  /** SHA-256 of a gated file, which Hugging Face only gives to an account that accepted the licence. */
  async #hashFromHub(file, token, signal) {
    const { repo, revision, path } = file.source;
    const response = await this.fetchImpl(`${HUGGING_FACE}/api/models/${repo}/paths-info/${revision}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [path], expand: false }),
      signal,
    });
    if (!response.ok) return '';
    const [entry] = await response.json();
    return /^[0-9a-f]{64}$/.test(entry?.lfs?.oid || '') ? entry.lfs.oid : '';
  }
  async #fetchFile(file, token, signal) {
    const partial = file.path + '.part';
    // A file of a folder already completed (and checked) by an earlier, stopped download.
    if (await done(file)) return;
    await mkdir(join(partial, '..'), { recursive: true });
    if (!file.sha256 && file.gated && token) file.sha256 = await this.#hashFromHub(file, token, signal);
    let offset = await sizeOf(partial);
    if (offset > file.size) {
      await rm(partial, { force: true });
      offset = 0;
    }
    const huggingFace = new URL(file.url).origin === HUGGING_FACE;
    const headers = {
      'User-Agent': 'AtelierLocal-models',
      ...(offset ? { Range: `bytes=${offset}-` } : {}),
      ...(huggingFace && token ? { Authorization: `Bearer ${token}` } : {}),
    };
    let hash = offset ? await hashFile(partial) : createHash('sha256');
    if (offset < file.size) {
      const response = await this.fetchImpl(file.url, { headers, redirect: 'follow', signal });
      if (response.status === 401 || response.status === 403)
        throw problem(`Accès refusé par la source de ${basename(file.path)} : vérifiez le jeton et la licence acceptée.`, 403);
      if (!response.ok || !response.body) throw problem(`La source de ${basename(file.path)} répond ${response.status}.`, 502);
      if (offset && response.status !== 206) {
        // The source starts again from the beginning: so does the file.
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
      await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(partial, { flags: offset ? 'a' : 'w' }), {
        signal,
      });
    }
    const size = await sizeOf(partial);
    if (size !== file.size) throw problem(`${basename(file.path)} est incomplet (${size} octets sur ${file.size}).`, 502);
    if (file.sha256 && hash.digest('hex') !== file.sha256) {
      await rm(partial, { force: true });
      throw problem(`${basename(file.path)} ne correspond pas à l’original (empreinte différente) : il a été effacé.`, 502);
    }
    await rename(partial, file.path);
  }
  cancel() {
    this.controller?.abort();
  }
  async close() {
    this.cancel();
    await this.task?.catch(() => {});
  }
}
