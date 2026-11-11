import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { problem } from './engine.mjs';

/**
 * Small pictures of the creations, shown where the original would be shrunk anyway: the cover
 * of a project, a banner or a card of the Studio, a tile while its original loads. The page
 * makes them (it has the original decoded, of an image as of a video) and sends them here once;
 * the server has no image library and only keeps the files.
 */
const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY = new RegExp(`^${ID}\\.${ID}\\.\\d{1,3}$`);
const MAX_BYTES = 400 * 1024;

export class Thumbnails {
  constructor(directory) {
    this.directory = directory;
    this.known = new Set();
  }

  /** The name a thumbnail is kept under: its conversation, its run and the output in that run. */
  static key(conversationId, runId, index = 0) {
    const key = `${conversationId}.${runId}.${Number(index)}`;
    if (!KEY.test(key)) throw problem('Vignette invalide.');
    return key;
  }

  /** Reads what is on the disk, once: has() then answers from memory. */
  async load() {
    try {
      for (const name of await readdir(this.directory))
        if (name.endsWith('.jpg') && KEY.test(name.slice(0, -4))) this.known.add(name.slice(0, -4));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this;
  }

  has(key) {
    return this.known.has(key);
  }

  /** Keeps a JPEG the page made. Written once: a creation does not change. */
  async write(key, bytes) {
    if (!KEY.test(key)) throw problem('Vignette invalide.');
    if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
      throw problem('Une vignette est une image JPEG.');
    if (bytes.length > MAX_BYTES) throw problem('Vignette trop lourde.', 413);
    if (this.known.has(key)) return false;
    await mkdir(this.directory, { recursive: true });
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      await rename(temporary, join(this.directory, key + '.jpg'));
    } finally {
      await rm(temporary, { force: true });
    }
    this.known.add(key);
    return true;
  }

  async read(key) {
    if (!this.known.has(key)) throw problem('Vignette introuvable.', 404);
    try {
      return await readFile(join(this.directory, key + '.jpg'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.known.delete(key);
      throw problem('Vignette introuvable.', 404);
    }
  }

  /** Removes the thumbnails of a conversation, or all of them. */
  async forget(conversationId = null) {
    for (const key of [...this.known]) {
      if (conversationId && !key.startsWith(conversationId + '.')) continue;
      this.known.delete(key);
      await rm(join(this.directory, key + '.jpg'), { force: true });
    }
  }
}
