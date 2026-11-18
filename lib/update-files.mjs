import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { resolve, join, dirname, basename, parse, relative, sep } from 'node:path';
import { managedRoots } from './update-archive.mjs';

export async function plainFolder(path, create = false) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const segment of relative(current, absolute).split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (create) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Dossier de mise à jour non sûr.');
  }
}
async function exists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function plainTree(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || (info.isFile() && info.nlink !== 1))
    throw new Error('Lien ou fichier non sûr dans les sources.');
  if (info.isDirectory()) for (const name of await readdir(path)) await plainTree(join(path, name));
}
/**
 * Replaces a file whole or not at all (`data`: its text or its bytes): written beside it, then put
 * in its place. Every file of the data is written so (0.6.84): given up at the first refusal of
 * Windows, a setting, a counter of the takes or a workflow was not saved (« Erreur locale
 * inattendue »). This file goes with the installer of the updates (lib/update-install.mjs copies it
 * beside update-archive.mjs): it takes nothing from the rest of the application.
 */
export async function atomicFile(path, data, renameFile = rename) {
  // A name of its own for each write: one left behind (the process killed between the write and the
  // rename, a disk full) refused every later save of that file for good (« EEXIST »): no project
  // created or renamed, no reference joined, no restart kept.
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
    // Windows readers can briefly prevent replacement; keep the old file intact while retrying.
    await renameWithRetry(temporary, path, { renameFile });
  } finally {
    // Held too (the program that refused the rename holds the copy itself): it stays, and the
    // error said is the rename's, not this one's.
    await rm(temporary, { force: true }).catch(() => {});
  }
}
/**
 * A rename tried again while Windows refuses it for an instant (EPERM, EACCES, EBUSY): a file that
 * another program holds at that instant, an antivirus reading what was just written, the indexer,
 * a reader of the application. `retries`: 12, about a second, for a file of the data;
 * `LONG_RETRIES`, about a minute, for what was just downloaded or unpacked (gigabytes, programs),
 * that an antivirus may read for longer, as graceful-fs (npm) waits on Windows (0.6.85).
 * `signal`: the wait ends when the work is stopped.
 */
export async function renameWithRetry(from, to, { renameFile = rename, retries = 12, signal } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await renameFile(from, to);
    } catch (error) {
      if (attempt >= retries || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await delay(Math.min(100, 25 * (attempt + 1)), undefined, { signal });
    }
  }
}
export const LONG_RETRIES = 600;
export async function atomicJson(path, value, renameFile = rename) {
  const info = await exists(path);
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1))
    throw new Error('Fichier de mise à jour non sûr.');
  await atomicFile(path, JSON.stringify(value), renameFile);
}
async function checkWorkspace(root, workspace) {
  if (
    dirname(resolve(workspace)) !== join(resolve(root), 'data', 'updates') ||
    !/^[a-z0-9-]+$/i.test(basename(workspace))
  )
    throw new Error('Emplacement de mise à jour invalide.');
  await plainFolder(root);
  await plainFolder(workspace);
}

export async function replaceSources({ root, workspace }) {
  await checkWorkspace(root, workspace);
  const stage = join(workspace, 'stage'),
    backup = join(workspace, 'backup');
  await plainFolder(stage);
  await plainFolder(backup, true);
  if ((await readdir(backup)).length) throw new Error('Le dossier de sauvegarde doit être vide avant l’installation.');
  const entries = [];
  for (const name of (await readdir(stage)).sort()) {
    if (!managedRoots.has(name)) throw new Error('L’archive contient des sources non gérées.');
    await plainTree(join(stage, name));
    const previous = await exists(join(root, name));
    if (previous) await plainTree(join(root, name));
    entries.push({ name, existed: !!previous });
  }
  if (!entries.some(entry => entry.name === 'server.mjs') || !entries.some(entry => entry.name === 'package.json'))
    throw new Error('Sources incomplètes.');
  await atomicJson(join(workspace, 'journal.json'), entries);
  try {
    for (const { name, existed } of entries) {
      if (existed) await rename(join(root, name), join(backup, name));
      await rename(join(stage, name), join(root, name));
    }
  } catch (error) {
    try {
      await restoreSources({ root, workspace });
    } catch (rollback) {
      throw new Error(`Installation interrompue ; sauvegarde conservée dans ${backup}. ${rollback.message}`, {
        cause: error,
      });
    }
    throw error;
  }
}

export async function restoreSources({ root, workspace }) {
  await checkWorkspace(root, workspace);
  const backup = join(workspace, 'backup');
  await plainFolder(backup);
  const entries = JSON.parse(await readFile(join(workspace, 'journal.json'), 'utf8'));
  if (
    !Array.isArray(entries) ||
    entries.some(entry => !managedRoots.has(entry.name) || typeof entry.existed !== 'boolean')
  )
    throw new Error('Journal de restauration invalide.');
  for (const { name, existed } of entries.toReversed()) {
    const saved = join(backup, name),
      target = join(root, name),
      original = await exists(saved);
    // An existing source without a backup has not moved, or was already restored.
    if (existed && !original) continue;
    if (original) await plainTree(saved);
    const installed = await exists(target);
    if (installed) {
      await plainTree(target);
      await rm(target, { recursive: true, force: true });
    }
    if (original) await rename(saved, target);
  }
}
