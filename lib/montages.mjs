/**
 * (0.6.136) A montage: takes of a project laid one after the other, with sounds under them, read
 * as one film (the user's request of 19/11: « un plan composé de tout, image/vidéo/son. Ça
 * fonctionnera comme une timeline, une vraie cette fois »). This is its first step: what the
 * user lays by hand. A montage is a file of its project, kept by the application; nothing of it
 * lives in the memory of a chat model.
 *
 * {
 *   schemaVersion: 1, id, name,
 *   format: '16:9', width, height: one of the sizes of that format (public/formats.mjs), fps,
 *   plans:  [{ id, source, kind: 'video' | 'image', from, to, frame: 'fit' | 'fill', volume }],
 *   sounds: [{ id, source, track: 'music' | 'effects', at, from, to, volume }],
 *   createdAt, updatedAt
 * }
 * `source` names a creation of the project as the gallery does: { conversationId, runId, output }
 * (lib/gallery.mjs). A plan shows its source from `from` to `to` seconds (an image: 0 to its
 * length); the plans follow one another without a gap, in the order of the list. A sound starts
 * `at` seconds of the film and plays its source from `from` to `to`.
 * Nothing is copied: the takes stay where they are, a montage only says which and when.
 */
import { mkdir, readdir, readFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { problem } from './engine.mjs';
import { projectId } from './projects.mjs';
import { atomicFile } from './update-files.mjs';
import {
  MONTAGE_LIMITS,
  MONTAGE_RATES,
  montageSeconds,
  montageSizes,
  planStarts,
  usualSize,
} from '../public/montage-model.mjs';

// (0.6.137) What the page knows of a montage too is written once, for both (public/montage-model.mjs).
export { MONTAGE_LIMITS, MONTAGE_RATES, montageSeconds, montageSizes, planStarts };

const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const FRAMES = ['fit', 'fill'],
  KINDS = ['video', 'image'],
  TRACKS = ['music', 'effects'];

const invalid = message => problem(message, 400);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
function seconds(value, label, low, high) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high)
    throw invalid(`${label} : durée invalide.`);
  // (A millisecond is finer than a frame; what the page computes by dragging is rounded to it.)
  return Math.round(value * 1000) / 1000;
}
function source(value, label) {
  if (!plain(value) || !ID.test(value.conversationId ?? '') || !ID.test(value.runId ?? ''))
    throw invalid(`${label} : prise invalide.`);
  const output = value.output ?? 0;
  if (!Number.isInteger(output) || output < 0 || output > 63) throw invalid(`${label} : prise invalide.`);
  return { conversationId: value.conversationId, runId: value.runId, output };
}
function volume(value, label) {
  if (value === undefined) return 1;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2)
    throw invalid(`${label} : volume invalide.`);
  return Math.round(value * 100) / 100;
}
const own = (value, label) => {
  if (!ID.test(value ?? '')) throw invalid(`${label} : identifiant invalide.`);
  return value;
};
const date = (value, fallback) =>
  typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : fallback;

/** A montage as it is kept: every field checked, nothing else carried over. */
export function validateMontage(input, { now = new Date().toISOString() } = {}) {
  if (!plain(input)) throw invalid('Montage invalide.');
  if (input.schemaVersion !== 1) throw invalid('Version de montage inconnue.');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > MONTAGE_LIMITS.name)
    throw invalid(`Le nom du montage doit contenir entre 1 et ${MONTAGE_LIMITS.name} caractères.`);
  const sizes = montageSizes(input.format);
  if (!sizes.length) throw invalid('Format de montage inconnu.');
  if (!sizes.some(size => size.width === input.width && size.height === input.height))
    throw invalid(`Cette taille n’est pas une taille du format ${input.format}.`);
  if (!MONTAGE_RATES.includes(input.fps)) throw invalid('Cadence de montage invalide.');
  if (!Array.isArray(input.plans) || input.plans.length > MONTAGE_LIMITS.plans)
    throw invalid(`Un montage compte au plus ${MONTAGE_LIMITS.plans} plans.`);
  if (!Array.isArray(input.sounds) || input.sounds.length > MONTAGE_LIMITS.sounds)
    throw invalid(`Un montage compte au plus ${MONTAGE_LIMITS.sounds} sons.`);
  const seen = new Set();
  const once = id => {
    if (seen.has(id)) throw invalid('Deux éléments du montage ont le même identifiant.');
    seen.add(id);
    return id;
  };
  const plans = input.plans.map((plan, index) => {
    const label = `Plan ${index + 1}`;
    if (!plain(plan) || !KINDS.includes(plan.kind)) throw invalid(`${label} : ni vidéo ni image.`);
    const from = plan.kind === 'image' ? 0 : seconds(plan.from, label, 0, 36000),
      to = seconds(plan.to, label, 0, 36000);
    if (plan.kind === 'image' && plan.from !== undefined && plan.from !== 0)
      throw invalid(`${label} : une image commence à 0.`);
    if (to - from < MONTAGE_LIMITS.shortest || to - from > MONTAGE_LIMITS.longest)
      throw invalid(`${label} : sa durée va de ${MONTAGE_LIMITS.shortest} à ${MONTAGE_LIMITS.longest} secondes.`);
    if (plan.frame !== undefined && !FRAMES.includes(plan.frame)) throw invalid(`${label} : cadre invalide.`);
    return {
      id: once(own(plan.id, label)),
      source: source(plan.source, label),
      kind: plan.kind,
      from,
      to,
      frame: plan.frame ?? 'fit',
      // (An image has no sound of its own: nothing to set.)
      ...(plan.kind === 'video' ? { volume: volume(plan.volume, label) } : {}),
    };
  });
  const sounds = input.sounds.map((sound, index) => {
    const label = `Son ${index + 1}`;
    if (!plain(sound) || !TRACKS.includes(sound.track)) throw invalid(`${label} : piste inconnue.`);
    const from = seconds(sound.from, label, 0, 36000),
      to = seconds(sound.to, label, 0, 36000);
    if (to - from < MONTAGE_LIMITS.shortest) throw invalid(`${label} : trop court.`);
    return {
      id: once(own(sound.id, label)),
      source: source(sound.source, label),
      track: sound.track,
      at: seconds(sound.at, label, 0, 36000),
      from,
      to,
      volume: volume(sound.volume, label),
    };
  });
  return {
    schemaVersion: 1,
    id: own(input.id, 'Montage'),
    name,
    format: input.format,
    width: input.width,
    height: input.height,
    fps: input.fps,
    plans,
    sounds,
    createdAt: date(input.createdAt, now),
    updatedAt: date(input.updatedAt, now),
  };
}

/** A montage with nothing in it yet, at the usual size of its format. */
export function newMontage({ name = 'Sans titre', format = '16:9', id = randomUUID(), now = new Date().toISOString() } = {}) {
  const size = usualSize(format);
  if (!size) throw invalid('Format de montage inconnu.');
  return validateMontage(
    { schemaVersion: 1, id, name, format, width: size.width, height: size.height, fps: MONTAGE_RATES[0], plans: [], sounds: [] },
    { now },
  );
}

/**
 * What the engine assembles (runner/video/montage.py): the montage with the file of each source.
 * `fileOf(source)`: the absolute path of a creation, or a refusal. A sound that starts after the
 * end of the film is left out; nothing else is changed.
 */
export async function assemblyOf(montage, fileOf) {
  const total = montageSeconds(montage);
  if (!montage.plans.length) throw invalid('Ce montage n’a encore aucun plan.');
  const plans = [];
  for (const [index, plan] of montage.plans.entries())
    plans.push({
      path: await fileOf(plan.source, `Plan ${index + 1}`),
      kind: plan.kind,
      from: plan.from,
      to: plan.to,
      frame: plan.frame,
      volume: plan.volume ?? 1,
    });
  const sounds = [];
  for (const [index, sound] of montage.sounds.entries())
    if (sound.at < total)
      sounds.push({
        path: await fileOf(sound.source, `Son ${index + 1}`),
        at: sound.at,
        from: sound.from,
        to: sound.to,
        volume: sound.volume,
      });
  return { width: montage.width, height: montage.height, fps: montage.fps, plans, sounds };
}

/** The montages of the projects, one file each: `<dir>/<project>/<id>.json`. */
export class Montages {
  constructor({ dir }) {
    this.dir = dir;
    this.pending = Promise.resolve();
  }
  #folder(project) {
    return join(this.dir, projectId(project));
  }
  #queue(work) {
    const run = this.pending.then(work);
    this.pending = run.catch(() => {});
    return run;
  }
  async #stored(project, id) {
    let text;
    try {
      text = await readFile(join(this.#folder(project), own(id, 'Montage') + '.json'), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') throw problem('Ce montage n’existe plus.', 404);
      throw error;
    }
    return validateMontage(JSON.parse(text));
  }
  /** The montages of a project, the last changed first: what a list shows of each. */
  async list(project) {
    let names;
    try {
      names = await readdir(this.#folder(project));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const found = [];
    for (const name of names) {
      if (!name.endsWith('.json') || !ID.test(name.slice(0, -5))) continue;
      try {
        const montage = await this.#stored(project, name.slice(0, -5));
        found.push({
          id: montage.id,
          name: montage.name,
          format: montage.format,
          plans: montage.plans.length,
          sounds: montage.sounds.length,
          seconds: montageSeconds(montage),
          updatedAt: montage.updatedAt,
        });
      } catch {
        // A file that cannot be read leaves the others.
      }
    }
    return found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  read(project, id) {
    return this.#stored(project, id);
  }
  /** Keeps a montage, new or changed. Its date of creation stays the one it was first kept with. */
  save(project, input) {
    return this.#queue(async () => {
      const now = new Date().toISOString();
      const montage = validateMontage({ ...input, updatedAt: now }, { now });
      try {
        montage.createdAt = (await this.#stored(project, montage.id)).createdAt;
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      await mkdir(this.#folder(project), { recursive: true });
      await atomicFile(join(this.#folder(project), montage.id + '.json'), JSON.stringify(montage, null, 2));
      return montage;
    });
  }
  /**
   * Takes a montage out of its project. Its file is kept aside (`corbeille`), never destroyed
   * here: the takes it named are untouched in any case.
   */
  remove(project, id) {
    return this.#queue(async () => {
      await this.#stored(project, id);
      const aside = join(this.#folder(project), 'corbeille');
      await mkdir(aside, { recursive: true });
      const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
      await rename(join(this.#folder(project), id + '.json'), join(aside, `${id}-${stamp}.json`));
      return { removed: id };
    });
  }
}
