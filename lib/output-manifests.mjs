import { copyFile, mkdir, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// The creations the engine writes, each with its manifest of the same name.
const CREATIONS = ['.png', '.mp4', '.wav', '.webm', '.jpg', '.webp'];

/**
 * Moves the manifests an earlier version wrote beside the creations (`<name>.json` next to
 * `<name>.png|mp4|wav…`) to the folder of the manifests, so that the folder of the creations
 * holds only them. Only a manifest of the engine moves (its `jobId` and `outputs`, beside its
 * creation); one already there is left in place. Never deletes a manifest without its copy.
 * Returns how many moved.
 */
export async function moveManifests(outputDir, manifestDir) {
  let names;
  try {
    names = await readdir(outputDir);
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  const present = new Set(names);
  const found = names.filter(
    name => name.endsWith('.json') && CREATIONS.some(extension => present.has(name.slice(0, -5) + extension)),
  );
  if (!found.length) return 0;
  await mkdir(manifestDir, { recursive: true });
  const already = new Set(await readdir(manifestDir));
  let moved = 0;
  for (const name of found) {
    if (already.has(name)) continue;
    const from = join(outputDir, name),
      to = join(manifestDir, name);
    try {
      const manifest = JSON.parse(await readFile(from, 'utf8'));
      if (typeof manifest?.jobId !== 'string' || !Array.isArray(manifest.outputs)) continue;
      try {
        await rename(from, to);
      } catch (error) {
        // Another drive: copied, then removed once the copy is there.
        if (error.code !== 'EXDEV') throw error;
        await copyFile(from, to);
        await unlink(from);
      }
      moved++;
    } catch {
      // Unreadable, or in use: it stays where it is, the others go.
    }
  }
  return moved;
}
