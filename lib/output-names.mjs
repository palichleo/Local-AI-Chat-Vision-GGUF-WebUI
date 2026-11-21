/**
 * The name of a new creation and the folder it goes in: `image`, `video` or `son` under the folder
 * of the outputs, under a name that sorts by the time it was started, as text and as numbers alike:
 * `2026-11-17_14-32-05_krea-2_a3f9.png` (the local date and time, the model, a short suffix).
 *
 * The application names it (it knows the workflow and the time) and passes the name in the job
 * (`outputName`); what writes the file (runner/media.py) puts it in the folder of its kind, under
 * another suffix when a creation has it already (output_place), and says where in its answer
 * (`filename`, `subfolder`). The creations made before are
 * in the folder of the outputs itself under a random name (`subfolder: ''`): they stay there, and
 * are read there.
 *
 * Never the number of the take: takes are numbered by project, and numbered again when a
 * conversation changes project.
 */
import { randomBytes } from 'node:crypto';

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
