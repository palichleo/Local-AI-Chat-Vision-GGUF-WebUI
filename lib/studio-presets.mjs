import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { problem } from './engine.mjs';
import { atomicFile } from './update-files.mjs';
import { checkStyles } from './tool-runtime.mjs';

const invalid = message => problem(message, 400);
const seconds = value => Number.isFinite(value) && value > 0 && value <= 3600;

/**
 * A preset as kept: only the fields the Studio saves, each of its type, within plain bounds.
 * The page sends only what the workflow leaves free; the server keeps nothing else.
 */
export function checkPreset(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Réglages invalides.');
  const preset = {};
  if (value.length !== undefined) {
    if (!seconds(value.length)) throw invalid('Durée invalide.');
    preset.length = value.length;
  }
  if (value.format !== undefined || value.size !== undefined) {
    if (typeof value.format !== 'string' || !/^\d{1,2}:\d{1,2}$/.test(value.format)) throw invalid('Format invalide.');
    if (typeof value.size !== 'string' || !/^\d{2,5}x\d{2,5}$/.test(value.size)) throw invalid('Taille invalide.');
    Object.assign(preset, { format: value.format, size: value.size });
  }
  if (value.seed !== undefined) {
    if (typeof value.seed !== 'string' || !/^\d{0,20}$/.test(value.seed)) throw invalid('Seed invalide.');
    preset.seed = value.seed;
  }
  if (value.styles !== undefined) preset.styles = checkStyles(value.styles);
  if (value.loras !== undefined) {
    if (!value.loras || typeof value.loras !== 'object' || Array.isArray(value.loras)) throw invalid('LoRA invalides.');
    const entries = Object.entries(value.loras);
    if (entries.length > 32) throw invalid('LoRA invalides.');
    preset.loras = {};
    for (const [id, entry] of entries) {
      if (!/^[\w.-]{1,120}$/.test(id) || !entry || typeof entry !== 'object') throw invalid('LoRA invalides.');
      const kept = {};
      if (entry.on !== undefined) {
        if (typeof entry.on !== 'boolean') throw invalid('LoRA invalides.');
        kept.on = entry.on;
      }
      if (entry.strength !== undefined) {
        if (!Number.isFinite(entry.strength) || Math.abs(entry.strength) > 10) throw invalid('LoRA invalides.');
        kept.strength = entry.strength;
      }
      preset.loras[id] = kept;
    }
  }
  if (value.settings !== undefined) {
    // The settings of the model itself that are kept: the length of a sound, and the denoise of an
    // image to modify (a part of 1; the Studio gives it back within the bounds of the workflow).
    const given = value.settings,
      settings = {};
    if (!given || typeof given !== 'object' || Array.isArray(given)) throw invalid('Réglages invalides.');
    if (given.seconds !== undefined) {
      if (!seconds(given.seconds)) throw invalid('Réglages invalides.');
      settings.seconds = given.seconds;
    }
    if (given.denoise !== undefined) {
      if (!Number.isFinite(given.denoise) || given.denoise <= 0 || given.denoise > 1)
        throw invalid('Débruitage invalide.');
      settings.denoise = given.denoise;
    }
    if (!Object.keys(settings).length) throw invalid('Réglages invalides.');
    preset.settings = settings;
  }
  return preset;
}

/**
 * The settings the Studio keeps for each model (« Enregistrer », the floppy disk of the Modèle
 * block): its length, format and size, seed and LoRAs, given back each time the model is chosen.
 * A file of its own: nothing here changes what Configuration › Workflows holds, values or modes.
 */
export class StudioPresets {
  constructor(file, limit = 200) {
    this.file = file;
    this.limit = limit;
    this.pending = Promise.resolve();
  }

  /**
   * The settings kept, by model. `sure`: the file read for certain (to write it again): one that
   * cannot be read at that instant is not « none kept » — taken for it, the next « Enregistrer » wrote
   * the file again with that single model, and the others were gone.
   */
  async all({ sure = false } = {}) {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      return value && typeof value.models === 'object' && !Array.isArray(value.models) ? value.models : {};
    } catch (error) {
      if (sure && error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      return {};
    }
  }

  /** Keeps the settings of a model, in place of those it had; resolves with them as kept. */
  save(id, value) {
    if (typeof id !== 'string' || !/^[\w.-]{1,120}$/.test(id)) return Promise.reject(invalid('Modèle invalide.'));
    let preset;
    try {
      preset = checkPreset(value);
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = this.pending.then(async () => {
      const models = await this.all({ sure: true });
      delete models[id];
      models[id] = { ...preset, savedAt: new Date().toISOString() };
      const ids = Object.keys(models);
      for (const old of ids.slice(0, Math.max(0, ids.length - this.limit))) delete models[old];
      await mkdir(dirname(this.file), { recursive: true });
      await atomicFile(this.file, JSON.stringify({ schemaVersion: 1, models }, null, 2));
      return models[id];
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
