import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { plainFolder } from './update-files.mjs';
import { imageSize } from './image-size.mjs';

// As the worker is started (lib/generation-worker.mjs): the application folder first on the path.
const BOOTSTRAP =
  "import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module('runner',run_name='__main__')";
// The words a video's first or last picture is named with, and the wording of `frame` they answer.
export const STILLS = { first: 'Première image', last: 'Dernière image' };

/**
 * The first or the last picture of a video file (`at`: 'first' or 'last'), read by the Python of
 * the generation engine (runner/video/still.py): a command that runs on the processor and ends,
 * whether the worker runs or not, with no model loaded. Returns the picture as a PNG at the size
 * of the video (`bytes`, `width`, `height`) and a small JPEG copy of it (`preview`, a data URL: what
 * a reference keeps for the model and the page). `workDir`: a folder of the application where the
 * two files are written, then removed. `run`: what runs a command of the Python environment
 * (lib/python-environment.mjs, runEnvironmentCommand).
 */
export async function extractStill({ python, root, input, at, workDir, env = process.env, run, timeoutMs = 60000 }) {
  if (!Object.hasOwn(STILLS, at)) throw Error('Image demandée invalide.');
  if (!python || typeof run !== 'function')
    throw Error('l’environnement de génération n’est pas installé (Paramètres › Génération)');
  await plainFolder(workDir, true);
  const folder = await mkdtemp(join(resolve(workDir), 'still-'));
  try {
    const output = join(folder, 'frame.png'),
      preview = join(folder, 'preview.jpg');
    try {
      await run(
        python,
        ['-s', '-c', BOOTSTRAP, resolve(root), 'frame', '--input', input, '--at', at, '--output', output]
          .concat(['--preview', preview]),
        {
          cwd: resolve(root),
          env: { ...env, PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1' },
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    } catch (error) {
      if (error?.name === 'TimeoutError') throw Error('la lecture de la vidéo a dépassé le délai');
      if (error?.code === 'ENOENT') throw Error('le Python du moteur de génération est introuvable');
      // The last line the command wrote: its reason, in the user's words (runner/video/still.py).
      const reason = String(error?.message || '')
        .trim()
        .split(/\r?\n/)
        .at(-1);
      throw Error(reason || 'la vidéo n’a pas pu être lue');
    }
    const bytes = await readFile(output),
      size = imageSize(bytes);
    if (!size) throw Error('l’image extraite est illisible');
    return {
      bytes,
      ...size,
      preview: 'data:image/jpeg;base64,' + (await readFile(preview)).toString('base64'),
    };
  } finally {
    if (dirname(folder) === resolve(workDir)) await rm(folder, { recursive: true, force: true }).catch(() => {});
  }
}
