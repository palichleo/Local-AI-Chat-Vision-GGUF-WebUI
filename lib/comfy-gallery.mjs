import { mkdir, lstat, open, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, parse, relative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeComfyUrl } from './comfy-client.mjs';
import { problem } from './engine.mjs';

const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const validImage = /^analysis-([0-9a-f]{64})\.(png|jpg)$/;
const maxImage = 5 * 1024 * 1024;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function checkId(value) {
  if (typeof value !== 'string' || !validId.test(value)) throw problem('Identifiant de galerie invalide.');
  return value;
}
function text(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw problem('Texte de galerie invalide.');
  return value;
}
function metadata(value, max) {
  const visit = (item, depth = 0) => {
    if (depth > 20) throw problem('Métadonnées de galerie trop profondes.');
    if (typeof item === 'string') {
      if (/data:image\//i.test(item)) throw problem('Les images doivent être des copies d’analyse séparées.');
      return;
    }
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return;
    if (!item || typeof item !== 'object' || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)) throw problem('Métadonnées de galerie invalides.');
    for (const child of Object.values(item)) visit(child, depth + 1);
  };
  visit(value);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > max) throw problem('Métadonnées de galerie trop volumineuses.');
  return JSON.parse(json);
}
function source(input) {
  if (!input || input.type !== 'output') throw problem('Source Comfy invalide.');
  const segment = (value) => typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\\/:%\x00-\x1f\x7f]/.test(value) && !['.', '..'].includes(value) && !/[. ]$/.test(value);
  if (!segment(input.filename) || typeof input.subfolder !== 'string' || input.subfolder.length > 1000 || (input.subfolder && !input.subfolder.split('/').every(segment))) throw problem('Chemin de sortie Comfy invalide.');
  return { filename: input.filename, subfolder: input.subfolder, type: 'output' };
}
function comfyUrl(value) { return normalizeComfyUrl(value); }

function imageBytes(value) {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(maxImage / 3) + 30 || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) throw problem('Copie d’analyse invalide.');
  const encoded = value.slice(value.indexOf(',') + 1);
  const bytes = Buffer.from(encoded, 'base64');
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (bytes.length > maxImage || bytes.toString('base64') !== encoded || (value.startsWith('data:image/png') ? !png : !jpeg)) throw problem('Contenu de copie d’analyse invalide.');
  return { bytes, extension: png ? 'png' : 'jpg' };
}
function record(input) {
  if (!input || typeof input !== 'object') throw problem('Entrée de galerie invalide.');
  if (typeof input.workflowId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.workflowId)) throw problem('Workflow de galerie invalide.');
  if (!input.parameters || Array.isArray(input.parameters) || typeof input.parameters !== 'object') throw problem('Paramètres de galerie invalides.');
  if (typeof input.createdAt !== 'string' || input.createdAt.length > 40 || !Number.isFinite(Date.parse(input.createdAt))) throw problem('Date de galerie invalide.');
  if (!Array.isArray(input.outputs) || !input.outputs.length || input.outputs.length > 64) throw problem('Sorties de galerie invalides.');
  return {
    id: checkId(input.id), conversationId: checkId(input.conversationId), workflowId: input.workflowId,
    workflowName: text(input.workflowName, 200, true), prompt: text(input.prompt, 200000, true),
    parameters: metadata(input.parameters, 20000), comfyUrl: comfyUrl(input.comfyUrl), createdAt: input.createdAt,
    outputs: input.outputs.map((output) => {
      const normalized = { source: source(output?.source) };
      if (output.analysisDataUrl !== undefined) { imageBytes(output.analysisDataUrl); normalized.analysisDataUrl = output.analysisDataUrl; }
      return normalized;
    }),
    ...(input.analysis === undefined ? {} : { analysis: metadata(input.analysis, 200000) }),
  };
}

async function folder(directory, create = false) {
  const absolute = resolve(directory);
  const root = parse(absolute).root;
  let current = root;
  // Validate every ancestor before creating a child, including a configured history root.
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw problem('Dossier de galerie invalide.');
  }
}
async function file(path, max = 2 * 1024 * 1024) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > max) throw problem('Fichier de galerie invalide.');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > max) throw problem('Fichier de galerie invalide.');
    const bytes = await handle.readFile();
    if (bytes.length > max) throw problem('Fichier de galerie trop volumineux.');
    return bytes;
  } finally { await handle.close(); }
}
async function atomic(path, bytes) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw problem('Fichier de galerie invalide.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export class ComfyGallery {
  constructor({ historyDir }) {
    if (typeof historyDir !== 'string' || !historyDir) throw problem('Dossier de galerie invalide.');
    this.directory = resolve(historyDir);
    this.records = new Map();
    this.pending = Promise.resolve();
  }
  clearMemory() { this.records.clear(); }

  async put(input, { persist = false } = {}) {
    const normalized = record(input);
    if (typeof persist !== 'boolean') throw problem('Persistance de galerie invalide.');
    const write = this.pending.then(async () => {
      const key = `${normalized.conversationId}/${normalized.id}`;
      let previous = this.records.get(key);
      if (!previous && persist) {
        try { previous = await this.#read(normalized.conversationId, normalized.id); }
        catch (error) { if (error.status !== 404) throw error; }
      }
      for (const output of normalized.outputs) {
        const prior = previous?.outputs.find((item) => JSON.stringify(item.source) === JSON.stringify(output.source));
        if (output.analysisDataUrl === undefined && prior?.analysisDataUrl) output.analysisDataUrl = prior.analysisDataUrl;
      }
      if (persist) {
        const directory = join(this.directory, normalized.conversationId, 'generated', normalized.id);
        await folder(directory, true);
        const outputs = [];
        for (const output of normalized.outputs) {
          const stored = { source: output.source };
          if (output.analysisDataUrl !== undefined) {
            const { bytes, extension } = imageBytes(output.analysisDataUrl);
            stored.analysisImage = `analysis-${hash(bytes)}.${extension}`;
            const path = join(directory, stored.analysisImage);
            try {
              const existing = await file(path, maxImage);
              if (hash(existing) !== hash(bytes)) throw problem('Copie d’analyse endommagée.');
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
              await atomic(path, bytes);
            }
          }
          outputs.push(stored);
        }
        await atomic(join(directory, 'manifest.json'), JSON.stringify({ version: 1, ...normalized, outputs }, null, 2));
      }
      this.records.set(key, normalized);
      return structuredClone(normalized);
    });
    this.pending = write.catch(() => {});
    return write;
  }

  async #read(conversationId, runId) {
    const directory = join(this.directory, conversationId, 'generated', runId);
    try {
      await folder(directory);
      let stored;
      try { stored = JSON.parse((await file(join(directory, 'manifest.json'))).toString('utf8')); }
      catch (error) { if (error instanceof SyntaxError) throw problem('Entrée de galerie illisible.'); throw error; }
      if (stored?.version !== 1 || stored.id !== runId || stored.conversationId !== conversationId || !Array.isArray(stored.outputs)) throw problem('Entrée de galerie incohérente.');
      const outputs = [];
      for (const output of stored.outputs) {
        if (output?.analysisDataUrl !== undefined) throw problem('Copie d’analyse enregistrée invalide.');
        const loaded = { source: source(output?.source) };
        if (output.analysisImage !== undefined) {
          const match = typeof output.analysisImage === 'string' && output.analysisImage.match(validImage);
          if (!match) throw problem('Chemin de copie d’analyse invalide.');
          const bytes = await file(join(directory, output.analysisImage), maxImage);
          if (hash(bytes) !== match[1]) throw problem('Copie d’analyse endommagée.');
          loaded.analysisDataUrl = `data:image/${match[2] === 'png' ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}`;
        }
        outputs.push(loaded);
      }
      return record({ ...stored, outputs });
    } catch (error) {
      if (error.code === 'ENOENT') throw problem('Entrée ou copie d’analyse introuvable.', 404);
      throw error;
    }
  }

  async get(conversationId, runId) {
    checkId(conversationId); checkId(runId);
    await this.pending;
    const cached = this.records.get(`${conversationId}/${runId}`);
    return cached ? structuredClone(cached) : this.#read(conversationId, runId);
  }

  async list(conversationId) {
    checkId(conversationId);
    await this.pending;
    const runs = new Map();
    let skipped = 0;
    const directory = join(this.directory, conversationId, 'generated');
    try {
      await folder(directory);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!validId.test(entry.name)) continue;
        try { runs.set(entry.name, await this.#read(conversationId, entry.name)); }
        catch { skipped++; }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const cached of this.records.values()) if (cached.conversationId === conversationId) runs.set(cached.id, structuredClone(cached));
    return { runs: [...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), skipped };
  }
}
