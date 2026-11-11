import { randomUUID } from 'node:crypto';
import { open, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, parse, resolve } from 'node:path';
import { families } from './families.mjs';

const invalid = message => Object.assign(new Error(message), { status: 400 });
const plain = value =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [null, Object.prototype].includes(Object.getPrototypeOf(value));
/** Declaration of one asset kind in a family manifest: a component role, or its LoRAs. */
function declaration(family, kind) {
  const manifest = families()[family];
  return kind === 'lora' ? manifest?.loras : manifest?.components[kind];
}
const bytesPerElement = {
  BOOL: 1,
  U8: 1,
  I8: 1,
  I16: 2,
  U16: 2,
  F16: 2,
  BF16: 2,
  I32: 4,
  U32: 4,
  F32: 4,
  I64: 8,
  U64: 8,
  F64: 8,
  F8_E4M3: 1,
  F8_E5M2: 1,
  F8_E4M3FN: 1,
  F8_E4M3FNUZ: 1,
  F8_E5M2FNUZ: 1,
};

function identifier(value) {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value) ||
    /^(con|prn|aux|nul|com\d|lpt\d|constructor|prototype)$/i.test(value)
  )
    throw invalid('Invalid asset id');
  return value;
}
function record(input) {
  if (
    !plain(input) ||
    Object.keys(input).some(key => !['id', 'name', 'path', 'kind', 'family', 'inspection'].includes(key))
  )
    throw invalid('Invalid asset registry entry');
  const id = identifier(input.id ?? randomUUID());
  if (typeof input.kind !== 'string' || !declaration(input.family, input.kind))
    throw invalid('Unsupported asset kind or family');
  if (typeof input.path !== 'string' || !isAbsolute(input.path) || input.path.includes('\0'))
    throw invalid('Asset path must be an absolute local path');
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120))
    throw invalid('Asset name must contain 1 to 120 characters');
  return {
    id,
    name: input.name?.trim() ?? basename(input.path).slice(0, 120),
    path: resolve(input.path),
    kind: input.kind,
    family: input.family,
  };
}

/** Whether tensor names and shapes match a manifest signature: [{ key: regex, shape: [n | null, ...] }]. */
function matches(header, signature = []) {
  const keys = Object.keys(header).filter(key => key !== '__metadata__');
  return signature.every(({ key, shape }) => {
    const pattern = new RegExp(key);
    return keys.some(
      name =>
        pattern.test(name) &&
        (!shape ||
          (header[name].shape.length === shape.length &&
            shape.every((size, index) => size === null || header[name].shape[index] === size))),
    );
  });
}

const TOKENIZER_FILES = ['tokenizer.json', 'tokenizer_config.json', 'vocab.json'];
const MAX_TOKENIZER_FILE = 64 * 1024 * 1024;

async function jsonFile(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_TOKENIZER_FILE)
    throw invalid(`${basename(path)} must be a JSON file below 64 MiB`);
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw invalid(`${basename(path)} is not valid JSON`);
  }
}
const exists = path =>
  stat(path).then(
    info => info.isFile(),
    () => false,
  );
/** Highest token id + 1 among a { token: id } map and a list of ids. */
function highest(ids) {
  let top = -1;
  for (const id of ids) if (Number.isSafeInteger(id) && id > top) top = id;
  return top + 1;
}

/**
 * A Hugging Face tokenizer folder (the folder itself or one of its JSON files may be chosen).
 * Returns the folder and its vocabulary size: the number of token ids it can produce.
 */
export async function inspectTokenizer(input) {
  let path = await realpath(input);
  if (!(await stat(path)).isDirectory()) {
    if (!TOKENIZER_FILES.includes(basename(path).toLowerCase()))
      throw invalid(
        'Choisissez le dossier du tokenizer ou l’un de ses fichiers (tokenizer.json, tokenizer_config.json).',
      );
    path = dirname(path);
  }
  if (!(await exists(join(path, 'tokenizer_config.json'))))
    throw invalid('Ce dossier n’est pas un tokenizer : tokenizer_config.json est absent.');
  const config = await jsonFile(join(path, 'tokenizer_config.json'));
  const added = Object.keys(plain(config.added_tokens_decoder) ? config.added_tokens_decoder : {}).map(Number);
  let vocabulary;
  if (await exists(join(path, 'tokenizer.json'))) {
    const tokenizer = await jsonFile(join(path, 'tokenizer.json'));
    const vocab = tokenizer?.model?.vocab;
    const ids = Array.isArray(vocab) ? vocab.map((_, index) => index) : plain(vocab) ? Object.values(vocab) : [];
    vocabulary = highest([...ids, ...(tokenizer.added_tokens || []).map(token => token?.id), ...added]);
  } else if ((await exists(join(path, 'vocab.json'))) && (await exists(join(path, 'merges.txt')))) {
    const vocab = await jsonFile(join(path, 'vocab.json'));
    if (!plain(vocab)) throw invalid('vocab.json is not a token map');
    vocabulary = highest([...Object.values(vocab), ...added]);
  } else throw invalid('Ce dossier n’est pas un tokenizer : tokenizer.json ou vocab.json + merges.txt est absent.');
  if (vocabulary < 1) throw invalid('Ce tokenizer ne contient aucun token.');
  return { path, vocabulary };
}

/**
 * A model kept as a whole diffusers folder (model_index.json beside one folder per part), as it
 * is downloaded from Hugging Face: the folder, or its model_index.json, naming the pipeline the
 * family runs. Its parts are checked by the worker when it loads them.
 */
export async function inspectPipeline(input, className) {
  let path = await realpath(input);
  if (!(await stat(path)).isDirectory()) {
    if (basename(path).toLowerCase() !== 'model_index.json')
      throw invalid('Choisissez le dossier du modèle (celui qui contient model_index.json) ou ce fichier.');
    path = dirname(path);
  }
  if (!(await exists(join(path, 'model_index.json'))))
    throw invalid('Ce dossier n’est pas un modèle complet : model_index.json est absent.');
  const index = await jsonFile(join(path, 'model_index.json'));
  if (!plain(index) || typeof index._class_name !== 'string')
    throw invalid('model_index.json ne nomme pas de pipeline.');
  if (className && index._class_name !== className)
    throw invalid(`Ce dossier contient ${index._class_name}, pas ${className}.`);
  return { path, className: index._class_name };
}

/** Rows of a text encoder's token embedding, i.e. how many token ids it understands; null if unknown. */
export async function encoderVocabulary(path) {
  const header = await safetensorsHeader(path);
  for (const [key, tensor] of Object.entries(header))
    if (/(?:^|\.)embed_tokens\.weight$/.test(key) && tensor?.shape?.length === 2) return tensor.shape[0];
  return null;
}
async function safetensorsHeader(path) {
  const file = await open(path, 'r');
  try {
    const prefix = Buffer.alloc(8);
    await file.read(prefix, 0, 8, 0);
    const length = prefix.readBigUInt64LE();
    if (length < 2n || length > 64n * 1024n * 1024n) throw invalid('Invalid safetensors header size');
    const bytes = Buffer.alloc(Number(length));
    await file.read(bytes, 0, bytes.length, 8);
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    await file.close();
  }
}

/** Special tokens a tokenizer may leave out of its own count; beyond this margin it belongs to another model. */
const VOCABULARY_MARGIN = 1024;
export function tokenizerMismatch(vocabulary, rows) {
  if (!Number.isInteger(rows)) return '';
  if (vocabulary <= rows && rows - vocabulary <= VOCABULARY_MARGIN) return '';
  return `Ce tokenizer (${vocabulary} tokens) ne correspond pas à l’encodeur de texte (${rows} tokens) : choisissez celui de la même famille de modèle.`;
}

/**
 * Tokenizer folders that may belong to a text encoder: ComfyUI ships them in
 * <ComfyUI>/comfy/text_encoders/*_tokenizer, beside <ComfyUI>/models; folders next to the
 * encoder file are considered too. Returns the compatible one with the closest vocabulary.
 */
export async function suggestTokenizer(encoderPath, extra = []) {
  const rows = await encoderVocabulary(encoderPath).catch(() => null);
  if (!rows) return null;
  const candidates = new Set(extra);
  const subfolders = async folder => {
    try {
      return (await readdir(folder, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
        .map(entry => join(folder, entry.name));
    } catch {
      return [];
    }
  };
  for (const folder of await subfolders(dirname(encoderPath))) candidates.add(folder);
  for (
    let folder = dirname(encoderPath), depth = 0;
    depth < 6 && folder !== parse(folder).root;
    folder = dirname(folder), depth++
  )
    if (basename(folder).toLowerCase() === 'models')
      for (const tokenizer of await subfolders(join(dirname(folder), 'comfy', 'text_encoders')))
        if (/tokenizer/i.test(basename(tokenizer))) candidates.add(tokenizer);
  let best = null;
  for (const candidate of candidates) {
    try {
      const found = await inspectTokenizer(candidate);
      if (!tokenizerMismatch(found.vocabulary, rows) && (!best || found.vocabulary > best.vocabulary))
        best = { ...found, rows };
    } catch {
      // Not a tokenizer folder, or unreadable: ignore it.
    }
  }
  return best;
}

async function inspect(asset) {
  const declared = declaration(asset.family, asset.kind);
  if (declared.format === 'pipeline') {
    const { path, className } = await inspectPipeline(asset.path, declared.pipelineClass);
    const name = asset.name === basename(asset.path).slice(0, 120) ? basename(path).slice(0, 120) : asset.name;
    return { ...asset, name, path, inspection: { format: 'pipeline', className } };
  }
  if (declared.format === 'tokenizer') {
    const { path, vocabulary } = await inspectTokenizer(asset.path);
    // A picked JSON file names the folder, not the file.
    const name = asset.name === basename(asset.path).slice(0, 120) ? basename(path).slice(0, 120) : asset.name;
    return { ...asset, name, path, inspection: { format: 'tokenizer', vocabulary } };
  }
  const path = await realpath(asset.path);
  const format = extname(path).slice(1).toLowerCase();
  if (!(declared.formats ?? ['safetensors']).includes(format))
    throw invalid(`Unsupported file format .${format} for ${asset.family} ${asset.kind}`);
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 10) throw invalid('Asset must be a regular model file');
    // Pickled checkpoints cannot be inspected safely here; the worker loads them with weights_only.
    if (format !== 'safetensors') return { ...asset, path, inspection: { format, bytes: stat.size } };
    const prefix = Buffer.alloc(8);
    await file.read(prefix, 0, 8, 0);
    const length = prefix.readBigUInt64LE();
    if (length < 2 || length > 64n * 1024n * 1024n || length > BigInt(stat.size - 8))
      throw invalid('Invalid safetensors header size');
    const bytes = Buffer.alloc(Number(length));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 8);
    if (bytesRead !== bytes.length) throw invalid('Incomplete safetensors header');
    let header;
    try {
      header = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw invalid('Invalid safetensors header JSON');
    }
    if (!plain(header)) throw invalid('Invalid safetensors header');
    const tensors = Object.entries(header).filter(([key]) => key !== '__metadata__');
    if (!tensors.length) throw invalid('Safetensors header contains no tensors');
    const intervals = [];
    for (const [key, tensor] of tensors) {
      if (
        !key ||
        !plain(tensor) ||
        !Object.hasOwn(bytesPerElement, tensor.dtype) ||
        !Array.isArray(tensor.shape) ||
        tensor.shape.length > 16 ||
        tensor.shape.some(value => !Number.isSafeInteger(value) || value < 0) ||
        !Array.isArray(tensor.data_offsets) ||
        tensor.data_offsets.length !== 2 ||
        tensor.data_offsets.some(value => !Number.isSafeInteger(value) || value < 0)
      )
        throw invalid(`Invalid safetensors header tensor: ${key}`);
      const [start, end] = tensor.data_offsets;
      const expected = tensor.shape.reduce(
        (size, value) => size * BigInt(value),
        BigInt(bytesPerElement[tensor.dtype]),
      );
      if (end < start || end > stat.size - 8 - Number(length) || BigInt(end - start) !== expected)
        throw invalid(`Invalid safetensors tensor offsets or size: ${key}`);
      if (end > start) intervals.push([start, end]);
    }
    intervals.sort((a, b) => a[0] - b[0]);
    for (let index = 1; index < intervals.length; index++)
      if (intervals[index][0] < intervals[index - 1][1]) throw invalid('Overlapping safetensors tensor offsets');
    // Header signatures are an early role check; the worker validates every architecture shape before GPU ownership changes.
    if (!matches(header, declared.signature))
      throw invalid(`Checkpoint layout is not compatible with ${asset.family} ${asset.kind}`);
    return { ...asset, path, inspection: { format: 'safetensors', tensors: tensors.length, bytes: stat.size } };
  } finally {
    await file.close();
  }
}

export class GenerationAssets {
  /** `roots()` lists the folders searched for a workflow's file when its asset id is unknown here. */
  constructor(file, { roots = () => [] } = {}) {
    if (typeof file !== 'string' || !file) throw invalid('Asset registry file is required');
    this.file = resolve(file);
    this.roots = roots;
    this.warnings = [];
    this.pending = Promise.resolve();
  }

  async list() {
    this.warnings = [];
    let stored;
    try {
      const stat = await lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024)
        throw invalid('Asset registry must be a regular JSON file below 2 MiB');
      stored = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    if (!plain(stored) || stored.schemaVersion !== 1 || !Array.isArray(stored.assets))
      throw invalid('Unsupported or invalid asset registry');
    const entries = [],
      ids = new Set();
    for (const input of stored.assets) {
      try {
        const asset = record(input);
        if (ids.has(asset.id)) throw invalid('Duplicate asset id');
        ids.add(asset.id);
        entries.push({ ...asset, ...(plain(input.inspection) ? { inspection: input.inspection } : {}) });
      } catch (error) {
        this.warnings.push(`Skipped invalid asset registry entry ${String(input?.id ?? 'unknown')}: ${error.message}`);
      }
    }
    return entries;
  }

  async read(id) {
    identifier(id);
    const asset = (await this.list()).find(item => item.id === id);
    if (!asset) throw invalid(`Asset ${id} not found`);
    return asset;
  }
  async resolve(id, { kind, family, file } = {}) {
    let asset;
    try {
      asset = await this.read(id);
    } catch (error) {
      // A shared workflow: its asset id is not registered here, but its file may be.
      const path = file && kind && family ? await this.locate(file) : null;
      if (!path) throw error;
      return this.register({ id, path, kind, family });
    }
    if (kind !== undefined && asset.kind !== kind) throw invalid(`Asset ${id} has incompatible kind; expected ${kind}`);
    if (family !== undefined && asset.family !== family)
      throw invalid(`Asset ${id} has incompatible family; expected ${family}`);
    return inspect(asset);
  }

  /** The first `file` (a weights file, or a tokenizer folder) in a search root or one folder below. */
  async locate(file) {
    const seen = new Set();
    for (const root of this.roots()) {
      if (typeof root !== 'string' || !root || seen.has(resolve(root))) continue;
      seen.add(resolve(root));
      const candidates = [join(root, file)];
      try {
        for (const entry of await readdir(root, { withFileTypes: true }))
          if (entry.isDirectory()) candidates.push(join(root, entry.name, file));
      } catch {
        continue;
      }
      for (const candidate of candidates)
        try {
          await stat(candidate);
          return candidate;
        } catch {}
    }
    return null;
  }

  async register(input) {
    let asset = await inspect(record(input));
    const operation = this.pending.then(async () => {
      const entries = await this.list();
      // Picking the same local file again must keep existing workflow references stable.
      const existing =
        !input.id &&
        entries.find(item => item.path === asset.path && item.kind === asset.kind && item.family === asset.family);
      if (existing) asset = { ...asset, id: existing.id, ...(input.name === undefined ? { name: existing.name } : {}) };
      const index = entries.findIndex(item => item.id === asset.id);
      if (index < 0) entries.push(asset);
      else entries[index] = asset;
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ schemaVersion: 1, assets: entries }, null, 2), {
          flag: 'wx',
          mode: 0o600,
        });
        await rename(temporary, this.file);
      } finally {
        await rm(temporary, { force: true });
      }
      return asset;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
