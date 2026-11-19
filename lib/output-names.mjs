/**
 * The name of a new creation and the folder it goes in: `image`, `video` or `son` under the folder
 * of the outputs, under a name that sorts by the time it was started, as text and as numbers alike:
 * `2026-11-17_14-32-05_krea-2_a3f9.png` (the local date and time, the model, a short suffix).
 *
 * The application names it (it knows the workflow and the time) and passes the name in the job
 * (`outputName`); what writes the file (runner/media.py) puts it in the folder
 * of its kind and says where in its answer (`filename`, `subfolder`). The creations made before are
 * in the folder of the outputs itself under a random name (`subfolder: ''`): they stay there, and
 * are read there.
 *
 * Never the number of the take: takes are numbered by project, and numbered again when a
 * conversation changes project.
 */
import { randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';

/** The folder of each kind of creation, under the folder of the outputs. */
export const OUTPUT_FOLDERS = { image: 'image', video: 'video', audio: 'son' };
const FOLDERS = Object.values(OUTPUT_FOLDERS);
/** Whether a creation may say its file is there: the folder of the outputs itself (''), or one of the three. */
export const outputFolder = value => value === '' || FOLDERS.includes(value);

const NAME = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
/** Whether a job may ask this name for its creation: plain, with neither a folder nor an extension. */
export const outputName = value => typeof value === 'string' && value.length <= 96 && NAME.test(value);

const two = value => String(value).padStart(2, '0');
const drawn = () => randomBytes(2).toString('hex');

/** A model as a name holds it: « Krea 2 » → `krea-2`, « LTX 2.5 » → `ltx-2-5`; `moodix` when nothing is left. */
export function modelSlug(name) {
  const plain = String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return plain || 'moodix';
}

/**
 * The name of a creation started at `at` (the local time) by the model `model`, without its
 * extension: `2026-11-17_14-32-05_krea-2_a3f9`. Every number has its zeros, so the names sort the
 * same way read as text or as numbers.
 */
export function creationName(model, { at = new Date(), suffix = drawn() } = {}) {
  const day = [String(at.getFullYear()).padStart(4, '0'), two(at.getMonth() + 1), two(at.getDate())].join('-'),
    time = [at.getHours(), at.getMinutes(), at.getSeconds()].map(two).join('-');
  return `${day}_${time}_${modelSlug(model)}_${suffix}`;
}

/**
 * The name of one output of a creation that has `count` of them: its own name alone, else `…_1`,
 * `…_2` (with the zeros `count` asks for), so that they stay together and in their order.
 */
export function outputPart(name, index = 0, count = 1) {
  return count > 1 ? `${name}_${String(index + 1).padStart(String(count).length, '0')}` : name;
}

/** The same name under another suffix (what follows its last `_`). */
export function anotherName(name, suffix = drawn()) {
  const cut = name.lastIndexOf('_');
  return (cut > 0 ? name.slice(0, cut) : name) + '_' + suffix;
}

const exists = path =>
  lstat(path).then(
    () => true,
    error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );

/**
 * `name`, or the same under another suffix, for which none of the files `paths(name)` exists: a
 * creation never takes the place of another.
 */
export async function freeName(name, paths) {
  for (let tries = 0; tries < 64; tries++) {
    let taken = false;
    for (const path of paths(name)) if ((taken = await exists(path))) break;
    if (!taken) return name;
    name = anotherName(name);
  }
  throw new Error('Aucun nom libre pour cette création.');
}
