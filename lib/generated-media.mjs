import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve, relative, sep, extname } from 'node:path';
import { problem } from './engine.mjs';
const types = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
};
export async function generatedMedia(root, descriptor) {
  const bad = () => {
    throw problem('Sortie générée invalide.', 400);
  };
  if (
    !descriptor ||
    descriptor.type !== 'output' ||
    typeof descriptor.filename !== 'string' ||
    typeof descriptor.subfolder !== 'string'
  )
    bad();
  const parts = [...descriptor.subfolder.split('/').filter(Boolean), descriptor.filename];
  if (
    parts.some(
      p =>
        !p ||
        p === '.' ||
        p === '..' ||
        /[\\/:\x00-\x1f\x7f]/.test(p) ||
        /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p),
    )
  )
    bad();
  const mime = types[extname(descriptor.filename).toLowerCase()];
  if (!mime) bad();
  const base = await realpath(root);
  let target = base;
  for (const part of parts) {
    target = join(target, part);
    const info = await lstat(target);
    if (info.isSymbolicLink()) bad();
  }
  const canonical = await realpath(target),
    rel = relative(base, canonical);
  if (!rel || rel.startsWith('..' + sep) || rel === '..' || resolve(base, rel) !== canonical) bad();
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size === 0) bad();
    return { handle, info, mime };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
