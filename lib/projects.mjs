import { readFile, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, plainFolder } from './update-files.mjs';
import { problem } from './engine.mjs';

const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export function projectId(value) {
  if (typeof value !== 'string' || (value !== 'inbox' && !idPattern.test(value))) throw problem('Projet invalide.');
  return value;
}
function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80)
    throw problem('Le nom du projet doit contenir entre 1 et 80 caractères.');
  return value.trim();
}
export class Projects {
  constructor(path) {
    this.path = path;
    this.pending = Promise.resolve();
  }
  async read() {
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 512 * 1024)
        throw problem('Fichier de projets invalide.');
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      if (
        !Array.isArray(data) ||
        data.length > 1000 ||
        data.some(item => !item || typeof item !== 'object' || Array.isArray(item)) ||
        new Set(data.map(item => item.id)).size !== data.length ||
        !data.some(item => item.id === 'inbox')
      )
        throw problem('Liste de projets invalide.');
      return data.map(item => ({ id: projectId(item.id), name: name(item.name) }));
    } catch (error) {
      if (error.code === 'ENOENT') return [{ id: 'inbox', name: 'Conversations' }];
      if (error instanceof SyntaxError) throw problem('Fichier de projets illisible.');
      throw error;
    }
  }
  async list() {
    await this.pending;
    return this.read();
  }
  async require(id) {
    projectId(id);
    const project = (await this.list()).find(item => item.id === id);
    if (!project) throw problem('Projet introuvable.', 404);
    return project;
  }
  async save(input) {
    const title = name(input.name);
    if (input.id !== undefined) projectId(input.id);
    const write = this.pending.then(async () => {
      const items = await this.read();
      let item;
      if (input.id !== undefined) {
        item = items.find(item => item.id === input.id);
        if (!item) throw problem('Projet introuvable.', 404);
        item.name = title;
      } else {
        if (items.length >= 1000) throw problem('La limite de projets est atteinte.');
        item = { id: randomUUID(), name: title };
        items.push(item);
      }
      await plainFolder(dirname(this.path), true);
      await atomicJson(this.path, items);
      return item;
    });
    this.pending = write.catch(() => {});
    return write;
  }
  /** Removes a project; the default project (Conversations) always remains. */
  async remove(id) {
    projectId(id);
    if (id === 'inbox') throw problem('Le projet Conversations ne peut pas être supprimé.');
    const write = this.pending.then(async () => {
      const items = await this.read();
      if (!items.some(item => item.id === id)) throw problem('Projet introuvable.', 404);
      await plainFolder(dirname(this.path), true);
      await atomicJson(
        this.path,
        items.filter(item => item.id !== id),
      );
      return { deleted: id };
    });
    this.pending = write.catch(() => {});
    return write;
  }
}
