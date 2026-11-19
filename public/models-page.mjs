/**
 * (0.6.119) What the page « Modèles » of the settings shows (maquette du 19/11, captures 65 à 69):
 * one line a model, always of the same height, with what it does, the version it uses and a chevron
 * that unfolds its versions. Nothing here draws: these are the words and the figures of a line, for
 * public/native-workflow-ui.mjs to put on the page.
 *
 * The direction is « une simplicité précise »: no dot of state, no word of help. A line says the
 * version used; a model to download says « Télécharger » and its size in its place; anything else
 * (an engine that starts, a file that cannot be read) is said under its description, smaller, and
 * never makes the line taller.
 */
import { licensesOf } from './model-licenses.mjs';

/** The groups of the page, in its order: [key, title]. */
export const GROUPS = Object.freeze([
  ['image', 'Image'],
  ['video', 'Vidéo'],
  ['audio', 'Son'],
  ['retouch', 'Retouches'],
]);

const GIB = 1024 ** 3;
const figure = (value, digits = 1) => value.toLocaleString('fr-FR', { maximumFractionDigits: digits });
/** A size as the application writes it: « 27,3 Go », « 640 Mo ». */
export const sizeText = bytes =>
  bytes >= GIB
    ? figure(bytes / GIB) + ' Go'
    : Math.max(1, Math.round(bytes / 1024 ** 2)).toLocaleString('fr-FR') + ' Mo';

/** What a version says after its name, in mono: its format, its steps (« INT8 », « 8 étapes »). */
export function versionData(version) {
  const steps = version?.parameters?.steps;
  return [version?.format, Number.isInteger(steps) ? `${steps} étapes` : ''].filter(Boolean);
}

/**
 * The lines of the page when the server sends none (`models`): one a workflow, in the group of what
 * it makes. (A server of before 0.6.118, and the tests of the editor.)
 */
export function linesOf(models, workflows) {
  if (Array.isArray(models) && models.length) return models;
  const group = record => ({ video: 'video', audio: 'audio' })[record.mediaType] ?? 'image';
  return (workflows ?? []).map(record => ({
    name: record.name,
    does: String(record.description || '').split(/(?<=[.!?])\s/)[0].trim(),
    group: group(record),
    order: 0,
    workflows: [{ id: record.id, family: record.pipeline }],
  }));
}

/**
 * What the line of a model shows. `model`: a line of the server ({ name, does, group, workflows });
 * `workflows`: the workflows as listed (ready or not, and why); `downloads`: { offers, job }.
 *
 * { records: [[entry, workflow]] the workflows of the model that are listed,
 *   state: 'downloading' | 'download' | 'ready' | 'waiting' | 'problem' | 'unavailable',
 *   label: what stands for the version used, in mono ([« Distillé », « INT8 »]),
 *   note: what is said under the description ('' when nothing is),
 *   offer: [workflow, offer] what « Télécharger » downloads, bytes: its size }
 * A model is ready when each of its workflows is. The first thing in the way decides: a download
 * under way, files to download, then why it cannot run.
 */
export function lineOf(model, workflows, downloads) {
  const records = (model.workflows ?? [])
      .map(entry => [entry, (workflows ?? []).find(record => record.id === entry.id)])
      .filter(([, record]) => record),
    job = downloads?.job ?? {},
    used = records.map(([entry]) => entry.versions?.find(version => version.used)).find(Boolean),
    named = records.map(([entry]) => entry.version).find(Boolean),
    label = used ? [used.name, used.format].filter(Boolean) : named ? [named] : [],
    line = { records, label, note: '', offer: null, bytes: 0 };
  if (job.state === 'running' && records.some(([, record]) => record.id === job.workflowId))
    return { ...line, state: 'downloading' };
  // « Disponible pour l’assistant » unticked (0.6.94): out of the tools of Moodix AI, never out of the Studio.
  const off = records.find(([, record]) => record.enabled === false)?.[1];
  if (off)
    return {
      ...line,
      state: 'off',
      note:
        off.ready === false
          ? 'Pas proposé à l’assistant. ' + (off.unavailableReason || 'Indisponible.')
          : 'Pas proposé à l’assistant : il reste dans le Studio.',
    };
  const lacking = records.filter(([, record]) => record.ready === false);
  if (!lacking.length) return { ...line, state: 'ready' };
  // What Moodix can fetch by itself: every workflow of the model that lacks a file it knows a source of.
  const offers = lacking
    .map(([, record]) => [record, downloads?.offers?.[record.id]])
    .filter(([, offer]) => offer?.complete);
  if (offers.length)
    return {
      ...line,
      state: 'download',
      offer: offers[0],
      bytes: offers.reduce((sum, [, offer]) => sum + (offer.left ?? offer.bytes ?? 0), 0),
    };
  const [, record] = lacking[0],
    reason = record.unavailableReason || 'Indisponible.';
  // What this computer lacks whatever the files (a card of another maker): greyed, with its reason.
  if (record.unavailableKind === 'hardware') return { ...line, state: 'unavailable', note: reason };
  // Not the model's fault: its engine is stopped or starts.
  if (!/^Fichier|^Aucun fichier|Choisissez/.test(reason)) return { ...line, state: 'waiting', note: reason };
  return { ...line, state: 'problem', note: reason };
}

/**
 * The advance of a download under its line: « 3,4 / 27,3 Go · 14 min ». `speed`: bytes a second, as
 * measured since it began (0 when not known yet: the time left is then not said).
 */
export function progressText(job, speed = 0) {
  const total = Number(job?.total) || 0,
    received = Math.min(Number(job?.received) || 0, total || Infinity);
  if (!total) return '';
  const unit = total >= GIB ? GIB : 1024 ** 2,
    done = `${figure(received / unit, total >= GIB ? 1 : 0)} / ${sizeText(total)}`;
  if (!(speed > 0) || received >= total) return done;
  const minutes = Math.ceil((total - received) / speed / 60);
  return `${done} · ${minutes >= 120 ? Math.round(minutes / 60) + ' h' : minutes + ' min'}`;
}

/** The share of a download that is done, from 0 to 100. */
export const progressShare = job => (job?.total ? Math.max(0, Math.min(100, (job.received / job.total) * 100)) : 0);

/**
 * The speed of a download, bytes a second: the mean over what was received since `before`
 * ({ at, received }), smoothed with the speed known until then. 0 while nothing tells it.
 */
export function speedOf(before, now, known = 0) {
  if (!before || !(now.at > before.at) || now.received < before.received) return known;
  const measured = (now.received - before.received) / ((now.at - before.at) / 1000);
  return known > 0 ? known * 0.7 + measured * 0.3 : measured;
}

/**
 * The licences of what a model downloads, in one sentence, for the pointer over « Télécharger »:
 * « Licences : Apache 2.0, MIT et SAM License (à conditions). En téléchargeant, vous les acceptez. »
 * '' when its files name none.
 */
export function licenseSentence(files) {
  // (The same licence said twice, for two of its files with a remark of their own, is named once.)
  const held = new Map();
  for (const license of licensesOf(files)) held.set(license.name, held.get(license.name) || license.restricted);
  const names = [...held].map(([name, restricted]) => name + (restricted ? ' (à conditions)' : ''));
  if (!names.length) return '';
  const several = names.length > 1,
    list = several ? names.slice(0, -1).join(', ') + ' et ' + names.at(-1) : names[0];
  const accepted = several ? 'les acceptez' : 'l’acceptez';
  return `${several ? 'Licences' : 'Licence'} : ${list}. En téléchargeant, vous ${accepted}.`;
}
