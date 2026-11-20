/**
 * (0.6.136) The film of a montage (lib/montages.mjs): its takes found in the gallery of its
 * project, assembled by the engine (runner/video/montage.py), and the film kept as a creation of
 * the conversation it was asked from: a take as the others, numbered with them, that the Sortie
 * and the Pellicule show.
 */
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { problem } from './engine.mjs';
import { assemblyOf, montageSeconds } from './montages.mjs';
import { creationName } from './output-names.mjs';
import { folderName, isTodo } from '../public/montage-model.mjs';

/**
 * What finds the file of a source of a montage: `fileOf(source, label)`.
 * `gallery.get(conversationId, runId)`: the creation; `pathOf(output.source)`: its file in the
 * folder of the outputs; `projectOf(conversationId)`: the project of a conversation. A take of
 * another project, or one that is gone, is refused by the plan that names it.
 */
export function takeFiles({ project, gallery, pathOf, projectOf }) {
  return async (source, label) => {
    const gone = () => problem(`${label} : cette prise n’existe plus.`, 409);
    let run;
    try {
      run = await gallery.get(source.conversationId, source.runId, { includeImages: false });
    } catch {
      throw gone();
    }
    if ((await projectOf(source.conversationId)) !== project)
      throw problem(`${label} : cette prise est d’un autre projet.`, 409);
    const output = run.outputs?.[source.output];
    if (!output) throw gone();
    try {
      return await pathOf(output.source);
    } catch {
      throw gone();
    }
  };
}

/**
 * Assembles `montage` and keeps the film: returns its record as the gallery keeps it.
 * `assemble(request)`: the engine (GenerationService.assembleFilm); `conversationId`: where the
 * film is kept; `persist`: as for any creation (the history kept or not).
 */
export async function exportMontage({
  montage,
  conversationId,
  fileOf,
  assemble,
  gallery,
  persist = false,
  onProgress,
  id = randomUUID(),
  // (0.6.154) Named after its bobine (« video/2026-11-20_14-32-05_le-renard-en-hiver_a3f9.mp4 »).
  name = creationName(montage.name),
  now = () => new Date(),
}) {
  const assembly = await assemblyOf(montage, fileOf),
    started = now();
  const result = await assemble({ id, outputName: name, ...assembly }, { onProgress });
  const made = result?.outputs?.[0];
  if (!made) throw problem('Le moteur n’a pas rendu de film.', 502);
  const finished = now();
  return gallery.put(
    {
      mediaType: 'video',
      provider: 'native',
      id,
      conversationId,
      workflowId: 'montage',
      // (0.6.148) « Bobine », the name of the page it was exported from.
      workflowName: 'Bobine',
      // What a take is named by where no prompt made it: the name of its bobine.
      prompt: montage.name,
      parameters: {
        montage: montage.id,
        plans: montage.plans.length,
        sounds: montage.sounds.length,
        seconds: montageSeconds(montage),
        width: montage.width,
        height: montage.height,
        fps: montage.fps,
        frames: Math.round(montageSeconds(montage) * montage.fps),
        generation_duration_ms: finished - started,
      },
      createdAt: finished.toISOString(),
      outputs: [{ source: made, width: montage.width, height: montage.height }],
    },
    { persist },
  );
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
 * (0.6.154) « Un fichier par prise »: each take of the bobine already made, in its order and numbered (01,
 * 02…), as the film shows it (its part, its frame, its own sound; no audio track under it), in a folder of
 * its own under `bobines` in the folder of the outputs (`outputDir`), named after the bobine. A folder
 * already there is never written into: the next free one (« Le renard en hiver 2 »). These files are not
 * takes of the project. Returns { folder, files }.
 */
export async function exportTakes({
  montage,
  fileOf,
  assemble,
  outputDir,
  onProgress,
  id = () => randomUUID(),
  name = () => creationName('bobine'),
}) {
  const made = montage.plans.filter(plan => !isTodo(plan));
  if (!made.length) throw problem('Aucune prise de cette bobine n’est encore créée.', 400);
  const base = folderName(montage.name);
  let folder = base;
  for (let count = 2; await exists(join(outputDir, 'bobines', folder)); count++) {
    if (count > 99) throw problem('Aucun dossier libre pour les prises de cette bobine.', 409);
    folder = base + ' ' + count;
  }
  const width = Math.max(2, String(made.length).length),
    files = [];
  for (const [index, plan] of made.entries()) {
    const file = String(index + 1).padStart(width, '0') + '.mp4',
      label = `Prise ${montage.plans.indexOf(plan) + 1}`,
      assembly = await assemblyOf({ ...montage, plans: [{ ...plan, at: 0 }], sounds: [] }, source => fileOf(source, label));
    await assemble({ id: id(), outputName: name(), exportTo: ['bobines', folder, file].join('/'), ...assembly }, { onProgress });
    files.push(file);
  }
  return { folder: 'bobines/' + folder, files };
}
