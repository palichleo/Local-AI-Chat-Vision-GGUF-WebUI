import { readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { atomicJson } from './update-files.mjs';
import { problem } from './engine.mjs';

/**
 * The chat models reached by an address instead of llama.cpp (Paramètres › Moodix AI): the three
 * providers of the list (ChatGPT, the account of the user, lib/chatgpt.mjs; Claude, by the key of
 * its Console, lib/claude.mjs; OpenRouter, by the key its sign-in makes, lib/openrouter.mjs), and
 * under « Autre service » any server « compatible OpenAI » (a preset fills its address). A key is
 * kept apart. The model and the effort are chosen in the bar of the chat, kept as the last choice.
 */
export const PRESETS = Object.freeze({
  openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', key: true },
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', key: true },
  mistral: { name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', key: true },
  groq: { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', key: true },
  ollama: { name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', key: false },
  lmstudio: { name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', key: false },
  custom: { name: 'Autre', baseUrl: '', key: false },
  chatgpt: { name: 'ChatGPT', baseUrl: 'https://api.openai.com/v1', key: false },
  claude: { name: 'Claude', baseUrl: 'https://api.anthropic.com', key: true },
});
// The providers of the list: one connection each, their name and address fixed.
export const PROVIDERS = Object.freeze(['chatgpt', 'claude', 'openrouter']);
// The efforts of reflection a provider may take, from the least to the most.
export const EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
// What a remote model keeps in mind is not known from here: the most common size today.
export const REMOTE_CONTEXT = 131072;
const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** Whether `host` is this computer or the home network: nothing sent there leaves it for the Internet. */
export function nearbyHost(host) {
  const name = String(host)
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (['localhost', '::1'].includes(name) || /^127\./.test(name)) return true;
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|f[cd][0-9a-f]{2}:)/.test(name);
}
/** Whether what is sent to `baseUrl` stays on this computer (a server such as Ollama). */
export function onThisComputer(baseUrl) {
  try {
    const name = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return name === 'localhost' || name === '::1' || /^127\./.test(name);
  } catch {
    return false;
  }
}

function text(value, label, max, { optional = false } = {}) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || value.length > max || /[\0-\x1f\x7f]/.test(value))
    throw problem(`${label} invalide.`);
  return value.trim();
}

/** The address of a service as kept: http(s), without what follows /v1 and without a final slash. */
export function serviceUrl(value) {
  const written = text(value, 'Adresse du serveur', 2048);
  let url;
  try {
    url = new URL(written);
  } catch {
    throw problem('Indiquez l’adresse complète du serveur, par exemple https://openrouter.ai/api/v1.');
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw problem('L’adresse du serveur commence par https:// (ou http:// pour un serveur local).');
  if (url.username || url.password) throw problem('Mettez la clé dans son champ, pas dans l’adresse.');
  // Sent in clear over the Internet, what is written (and the key) could be read on the way.
  if (url.protocol === 'http:' && !nearbyHost(url.hostname))
    throw problem(
      'Une adresse sur Internet doit commencer par https:// : en http, vos messages et votre clé passeraient en clair.',
    );
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/(chat\/completions|models)\/?$/, '').replace(/\/+$/, '');
}

/** A key as the user pasted it, without spaces nor « Bearer ». */
export function apiKey(value) {
  const key = text(value, 'Clé d’API', 4096).replace(/^Bearer\s+/i, '');
  if (/\s/.test(key)) throw problem('La clé d’API ne contient pas d’espace : recopiez-la telle quelle.');
  return key;
}

/** A connection as written in the editor, checked; `id` kept when it edits one. */
export function connectionOf(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw problem('Connexion invalide.');
  const preset = Object.hasOwn(PRESETS, input.preset) ? input.preset : 'custom';
  // A provider of the list keeps its own name; another service, the one of its preset or written.
  const name = PROVIDERS.includes(preset)
    ? PRESETS[preset].name
    : text(input.name ?? PRESETS[preset].name, 'Nom', 120) || PRESETS[preset].name;
  const model = text(input.model, 'Nom du modèle', 200);
  if (!model)
    throw problem('Indiquez le nom du modèle, tel que le service l’écrit (par exemple mistral-medium-latest).');
  const contextSize = input.contextSize ?? REMOTE_CONTEXT;
  if (!Number.isInteger(contextSize) || contextSize < 2048 || contextSize > 4194304)
    throw problem('Taille de contexte invalide.');
  if (input.id !== undefined && (typeof input.id !== 'string' || !ID.test(input.id)))
    throw problem('Identifiant de connexion invalide.');
  const effort = input.effort ?? '';
  if (effort !== '' && !EFFORTS.includes(effort)) throw problem('Force de réflexion invalide.');
  return {
    ...(input.id ? { id: input.id } : {}),
    name,
    preset,
    // ChatGPT and Claude are where their provider is; the others where they are said to be.
    baseUrl: ['chatgpt', 'claude'].includes(preset)
      ? PRESETS[preset].baseUrl
      : serviceUrl(input.baseUrl ?? PRESETS[preset].baseUrl),
    model,
    vision: input.vision === true,
    contextSize,
    ...(effort ? { effort } : {}),
  };
}

export class RemoteModels {
  constructor(dataDir) {
    this.file = join(dataDir, 'remote-llms.json');
    // The keys apart, on this computer only: never sent back to the page, never in a journal.
    this.keysFile = join(dataDir, 'remote-llm-keys.json');
    this.pending = Promise.resolve();
  }
  async #read() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      const connections = (Array.isArray(data?.connections) ? data.connections : []).flatMap(item => {
        try {
          return item?.id && ID.test(item.id) ? [{ ...connectionOf(item), id: item.id }] : [];
        } catch {
          // One that no longer reads leaves the others.
          return [];
        }
      });
      return { connections, active: connections.some(item => item.id === data.active) ? data.active : null };
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return { connections: [], active: null };
      throw error;
    }
  }
  async #keys() {
    try {
      const keys = JSON.parse(await readFile(this.keysFile, 'utf8'));
      return keys && typeof keys === 'object' && !Array.isArray(keys) ? keys : {};
    } catch {
      return {};
    }
  }
  /** One change at a time: two saves never write over each other. */
  #queue(task) {
    const run = this.pending.then(task);
    this.pending = run.catch(() => {});
    return run;
  }
  /** The connections as the page sees them: whether a key is kept, never the key. */
  async list() {
    await this.pending;
    const [{ connections, active }, keys] = await Promise.all([this.#read(), this.#keys()]);
    return { connections: connections.map(item => ({ ...item, hasKey: Boolean(keys[item.id]) })), active };
  }
  /** One connection with its key, for the server only. */
  async get(id) {
    await this.pending;
    const found = (await this.#read()).connections.find(item => item.id === id);
    if (!found) throw problem('Connexion introuvable.', 404);
    return { ...found, key: (await this.#keys())[id] || '' };
  }
  /** The connection of a provider of the list (ChatGPT, Claude, OpenRouter), with its key; null when none. */
  async provider(preset) {
    await this.pending;
    const found = (await this.#read()).connections.find(item => item.preset === preset);
    return found ? { ...found, key: (await this.#keys())[found.id] || '' } : null;
  }
  async active() {
    await this.pending;
    const { active } = await this.#read();
    return active ? this.get(active) : null;
  }
  /**
   * Saves a connection (a new one without `id`). `key`: left out, the kept one stays; empty, it is
   * removed; otherwise it replaces it. The connection saved, without its key.
   */
  save(input) {
    const connection = connectionOf(input),
      key = input.key === undefined ? undefined : input.key === '' ? '' : apiKey(input.key);
    return this.#queue(async () => {
      const data = await this.#read();
      if (connection.id && !data.connections.some(item => item.id === connection.id))
        throw problem('Connexion introuvable.', 404);
      if (!connection.id && data.connections.length >= 100) throw problem('Cent connexions au plus.');
      const saved = { ...connection, id: connection.id || randomUUID() };
      const connections = connection.id
        ? data.connections.map(item => (item.id === saved.id ? saved : item))
        : [...data.connections, saved];
      if (key !== undefined) {
        const keys = await this.#keys();
        if (key) keys[saved.id] = key;
        else delete keys[saved.id];
        await atomicJson(this.keysFile, keys);
      }
      await atomicJson(this.file, { version: 1, active: data.active, connections });
      return { ...saved, hasKey: Boolean((await this.#keys())[saved.id]) };
    });
  }
  remove(id) {
    return this.#queue(async () => {
      const data = await this.#read();
      if (!data.connections.some(item => item.id === id)) throw problem('Connexion introuvable.', 404);
      const keys = await this.#keys();
      if (keys[id]) {
        delete keys[id];
        if (Object.keys(keys).length) await atomicJson(this.keysFile, keys);
        else await rm(this.keysFile, { force: true });
      }
      await atomicJson(this.file, {
        version: 1,
        active: data.active === id ? null : data.active,
        connections: data.connections.filter(item => item.id !== id),
      });
    });
  }
  /** The connection the chat uses from now on, or none (the local model). */
  setActive(id) {
    return this.#queue(async () => {
      const data = await this.#read();
      if (id !== null && !data.connections.some(item => item.id === id)) throw problem('Connexion introuvable.', 404);
      await atomicJson(this.file, { version: 1, active: id, connections: data.connections });
    });
  }
}
