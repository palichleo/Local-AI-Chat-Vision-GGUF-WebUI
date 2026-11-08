import { lstat, readdir, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { resolve, join, dirname, basename, parse, relative, sep } from 'node:path';
import { managedRoots } from './update-archive.mjs';

export async function plainFolder(path, create = false) {
  const absolute = resolve(path); let current = parse(absolute).root;
  for (const segment of relative(current, absolute).split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (create) { try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Dossier de mise à jour non sûr.');
  }
}
async function exists(path) { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function plainTree(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory() || info.isFile() && info.nlink !== 1) throw new Error('Lien ou fichier non sûr dans les sources.');
  if (info.isDirectory()) for (const name of await readdir(path)) await plainTree(join(path, name));
}
export async function atomicJson(path, value) {
  const info = await exists(path);
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw new Error('Fichier de mise à jour non sûr.');
  const temporary = path + '.tmp';
  await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
}
async function checkWorkspace(root, workspace) {
  if (dirname(resolve(workspace)) !== join(resolve(root), 'data', 'updates') || !/^[a-z0-9-]+$/i.test(basename(workspace))) throw new Error('Emplacement de mise à jour invalide.');
  await plainFolder(root); await plainFolder(workspace);
}

export async function replaceSources({ root, workspace }) {
  await checkWorkspace(root, workspace);
  const stage = join(workspace, 'stage'), backup = join(workspace, 'backup');
  await plainFolder(stage); await plainFolder(backup, true);
  if ((await readdir(backup)).length) throw new Error('Le dossier de sauvegarde doit être vide avant l’installation.');
  const entries = [];
  for (const name of (await readdir(stage)).sort()) {
    if (!managedRoots.has(name)) throw new Error('L’archive contient des sources non gérées.');
    await plainTree(join(stage, name));
    const previous = await exists(join(root, name));
    if (previous) await plainTree(join(root, name));
    entries.push({ name, existed: !!previous });
  }
  if (!entries.some(entry => entry.name === 'server.mjs') || !entries.some(entry => entry.name === 'package.json')) throw new Error('Sources incomplètes.');
  await atomicJson(join(workspace, 'journal.json'), entries);
  try {
    for (const { name, existed } of entries) {
      if (existed) await rename(join(root, name), join(backup, name));
      await rename(join(stage, name), join(root, name));
    }
  } catch (error) {
    try { await restoreSources({ root, workspace }); }
    catch (rollback) { throw new Error(`Installation interrompue ; sauvegarde conservée dans ${backup}. ${rollback.message}`, { cause: error }); }
    throw error;
  }
}

export async function restoreSources({ root, workspace }) {
  await checkWorkspace(root, workspace);
  const backup = join(workspace, 'backup');
  await plainFolder(backup);
  const entries = JSON.parse(await readFile(join(workspace, 'journal.json'), 'utf8'));
  if (!Array.isArray(entries) || entries.some(entry => !managedRoots.has(entry.name) || typeof entry.existed !== 'boolean')) throw new Error('Journal de restauration invalide.');
  for (const { name, existed } of entries.toReversed()) {
    const saved = join(backup, name), target = join(root, name), original = await exists(saved);
    // An existing source without a backup has not moved, or was already restored.
    if (existed && !original) continue;
    if (original) await plainTree(saved);
    const installed = await exists(target); if (installed) { await plainTree(target); await rm(target, { recursive: true, force: true }); }
    if (original) await rename(saved, target);
  }
}
