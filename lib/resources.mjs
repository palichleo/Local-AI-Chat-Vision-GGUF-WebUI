import { mkdir, readdir, lstat, open, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { plainFolder, atomicJson } from './update-files.mjs';
import { problem } from './engine.mjs';
import { projectId } from './projects.mjs';

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const formats = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};
const imageLimit = 64 * 1024 ** 2,
  videoLimit = 512 * 1024 ** 2;
function id(value) {
  if (typeof value !== 'string' || !idPattern.test(value)) throw problem('Ressource invalide.');
  return value;
}
/** Whether `value` names a project (« inbox » for Conversations, or the id of one). */
function validProject(value) {
  try {
    projectId(value);
    return true;
  } catch {
    return false;
  }
}
/** The numbering of one project: its next number and the number of each of its references. */
function validCounter(counter) {
  return (
    counter &&
    typeof counter === 'object' &&
    Number.isSafeInteger(counter.next) &&
    counter.next >= 1 &&
    counter.ids &&
    typeof counter.ids === 'object' &&
    !Array.isArray(counter.ids) &&
    Object.entries(counter.ids).every(
      ([key, value]) => idPattern.test(key) && Number.isSafeInteger(value) && value >= 1 && value < counter.next,
    ) &&
    new Set(Object.values(counter.ids)).size === Object.keys(counter.ids).length
  );
}
function validName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 255 || /[\\/\x00-\x1f\x7f]/.test(value))
    throw problem('Nom de ressource invalide.');
  return value;
}
function image(value) {
  const match = typeof value === 'string' && value.match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || value.length > 7 * 1024 ** 2) throw problem('Copie visuelle invalide.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 5 * 1024 ** 2 || bytes.toString('base64') !== match[2] || !signature(bytes, `image/${match[1]}`))
    throw problem('Copie visuelle invalide.');
  return { bytes, extension: match[1] === 'png' ? 'png' : 'jpg' };
}
function signature(bytes, mime) {
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/webp')
    return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (mime === 'video/mp4') return bytes.toString('ascii', 4, 8) === 'ftyp';
  return mime === 'video/webm' && bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
}
async function safeOpen(path, max = Infinity) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > max)
    throw problem('Fichier de ressource non sûr.');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  const opened = await handle.stat();
  if (!opened.isFile() || opened.nlink !== 1 || opened.size > max) {
    await handle.close();
    throw problem('Fichier de ressource non sûr.');
  }
  return { handle, info: opened };
}
export class Resources {
  constructor(directory) {
    this.directory = resolve(directory);
    this.pending = Promise.resolve();
    this.working = 0;
    this.uploads = new Set();
    this.readers = new Map();
    this.closing = false;
  }
  get busy() {
    return this.working > 0;
  }
  flush() {
    return this.pending;
  }
  async close() {
    this.closing = true;
    for (const stream of this.uploads) stream.destroy();
    for (const handles of [...this.readers.values()])
      await Promise.all([...handles].map(handle => handle.close().catch(() => {})));
    await this.flush();
  }
  mutate(work) {
    this.working++;
    const task = this.pending.then(work).finally(() => {
      this.working--;
    });
    this.pending = task.catch(() => {});
    return task;
  }
  location(resourceId) {
    const target = resolve(this.directory, id(resourceId));
    if (dirname(target) !== this.directory) throw problem('Dossier de ressource invalide.');
    return target;
  }
  async record(resourceId) {
    const directory = this.location(resourceId);
    try {
      await plainFolder(directory);
      const { handle } = await safeOpen(join(directory, 'manifest.json'), 32768);
      let record;
      try {
        record = JSON.parse((await handle.readFile()).toString('utf8'));
      } finally {
        await handle.close();
      }
      if (
        record.version !== 1 ||
        record.id !== resourceId ||
        !formats[record.mime] ||
        typeof record.enabled !== 'boolean' ||
        typeof record.ready !== 'boolean' ||
        (record.project !== undefined && !validProject(record.project)) ||
        (record.uses !== undefined && (!Number.isSafeInteger(record.uses) || record.uses < 0)) ||
        (record.usedAt !== undefined && typeof record.usedAt !== 'string') ||
        typeof record.description !== 'string' ||
        record.description.length > 300 ||
        !Array.isArray(record.frames) ||
        record.frames.length > 3 ||
        record.frames.some((frame, index) => !new RegExp('^frame-' + index + '\\.(png|jpg)$').test(frame.file))
      )
        throw problem('Métadonnées de ressource invalides.');
      validName(record.name);
      return record;
    } catch (error) {
      if (error.code === 'ENOENT') throw problem('Ressource introuvable.', 404);
      throw error;
    }
  }
  /**
   * The numbers of the references, one numbering a project (« #ref1 », « #ref2 »… in each). Read
   * inside `mutate`. Before 0.5.106 one numbering for the whole library: it becomes the one of
   * Conversations, its numbers kept (a conversation that said « ref 34 » still means that picture).
   */
  async #index() {
    await plainFolder(this.directory, true);
    let index,
      changed = false;
    try {
      const { handle } = await safeOpen(join(this.directory, 'references.json'), 2 * 1024 ** 2);
      try {
        index = JSON.parse((await handle.readFile()).toString('utf8'));
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      index = { version: 2, projects: {} };
    }
    if (index?.version === 1 && validCounter(index)) {
      index = { version: 2, projects: { inbox: { next: index.next, ids: index.ids } } };
      changed = true;
    }
    if (
      index?.version !== 2 ||
      !index.projects ||
      typeof index.projects !== 'object' ||
      Array.isArray(index.projects) ||
      Object.entries(index.projects).some(([project, counter]) => !validProject(project) || !validCounter(counter))
    )
      throw problem('Index des références invalide.');
    return { index, changed };
  }
  async withReferences(records) {
    return this.mutate(async () => {
      let { index, changed } = await this.#index();
      for (const record of records) {
        const counter = (index.projects[record.project || 'inbox'] ??= { next: 1, ids: {} });
        if (!Object.hasOwn(counter.ids, record.id)) {
          counter.ids[record.id] = counter.next++;
          changed = true;
        }
      }
      if (changed) await atomicJson(join(this.directory, 'references.json'), index);
      return records
        .map(record => {
          const project = record.project || 'inbox',
            reference = index.projects[project].ids[record.id];
          return { ...record, project, reference, label: '#ref' + reference };
        })
        .sort((a, b) => a.reference - b.reference);
    });
  }
  /** Every reference, or those of `project`. */
  async list(project) {
    await this.flush();
    try {
      await plainFolder(this.directory);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const records = [];
    for (const entry of await readdir(this.directory, { withFileTypes: true }))
      if (entry.isDirectory() && idPattern.test(entry.name)) {
        try {
          records.push(await this.record(entry.name));
        } catch (error) {
          if (error.status !== 404)
            records.push({
              id: entry.name,
              name: 'Ressource illisible',
              enabled: false,
              ready: false,
              broken: true,
              description: '',
              frames: [],
            });
        }
      }
    return this.withReferences(
      records
        .filter(record => project === undefined || (record.project || 'inbox') === project)
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
    );
  }
  /** A file kept as a reference of `project` (the Studio, the message box of one of its chats). */
  async add(stream, { name, mime, length, project = 'inbox' }) {
    validName(name);
    projectId(project);
    if (!formats[mime]) throw problem('Utilisez PNG, JPEG, WebP, MP4 ou WebM.');
    const limit = mime.startsWith('video/') ? videoLimit : imageLimit;
    if (Number(length) > limit) throw problem('Ressource trop volumineuse (images : 64 Mo, vidéos : 512 Mo).', 413);
    if (this.closing) throw problem('L’application est en cours de fermeture.', 409);
    this.uploads.add(stream);
    return this.mutate(async () => {
      if (this.closing) throw problem('L’application est en cours de fermeture.', 409);
      await plainFolder(this.directory, true);
      const resourceId = randomUUID(),
        directory = this.location(resourceId);
      await mkdir(directory, { mode: 0o700 });
      try {
        const target = join(directory, 'source.' + formats[mime]),
          handle = await open(target, 'wx', 0o600);
        let size = 0,
          header = Buffer.alloc(0);
        try {
          for await (const chunk of stream) {
            size += chunk.length;
            if (size > limit) throw problem('Ressource trop volumineuse.', 413);
            if (header.length < 64) header = Buffer.concat([header, chunk]).subarray(0, 64);
            await handle.writeFile(chunk);
          }
        } finally {
          await handle.close();
        }
        if (!size || !signature(header, mime)) throw problem('Le contenu ne correspond pas au format du fichier.');
        const record = {
          version: 1,
          id: resourceId,
          project,
          name,
          mime,
          size,
          createdAt: new Date().toISOString(),
          description: '',
          enabled: true,
          ready: false,
          frames: [],
        };
        await atomicJson(join(directory, 'manifest.json'), record);
        return record;
      } catch (error) {
        if (dirname(directory) !== this.directory) throw error;
        await rm(directory, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    })
      .finally(() => this.uploads.delete(stream))
      .then(async record => (await this.withReferences([record]))[0]);
  }
  async update(resourceId, patch) {
    id(resourceId);
    if (
      !patch ||
      typeof patch !== 'object' ||
      Array.isArray(patch) ||
      Object.keys(patch).some(key => !['description', 'enabled', 'prepared'].includes(key))
    )
      throw problem('Modification de ressource invalide.');
    return this.mutate(async () => {
      const record = await this.record(resourceId),
        directory = this.location(resourceId);
      if ('description' in patch) {
        if (typeof patch.description !== 'string' || patch.description.length > 300)
          throw problem('La description est limitée à 300 caractères.');
        record.description = patch.description.trim();
      }
      if ('enabled' in patch) {
        if (typeof patch.enabled !== 'boolean') throw problem('Activation invalide.');
        record.enabled = patch.enabled;
      }
      if (patch.prepared !== undefined) {
        const p = patch.prepared;
        if (
          record.ready ||
          !p ||
          !Number.isInteger(p.width) ||
          p.width < 1 ||
          p.width > 131072 ||
          !Number.isInteger(p.height) ||
          p.height < 1 ||
          p.height > 131072 ||
          !Array.isArray(p.frames) ||
          !p.frames.length ||
          p.frames.length > (record.mime.startsWith('video/') ? 3 : 1)
        )
          throw problem('Préparation de ressource invalide.');
        if (record.mime.startsWith('video/') && (!Number.isFinite(p.duration) || p.duration <= 0 || p.duration > 86400))
          throw problem('Durée vidéo invalide.');
        const frames = p.frames.map((frame, index) => {
          if (
            record.mime.startsWith('video/') &&
            (!Number.isFinite(frame.time) || frame.time < 0 || frame.time > p.duration)
          )
            throw problem('Image vidéo invalide.');
          const decoded = image(frame.url);
          return {
            ...decoded,
            file: `frame-${index}.${decoded.extension}`,
            time: record.mime.startsWith('video/') ? frame.time : null,
          };
        });
        for (const frame of frames) {
          const handle = await open(join(directory, frame.file), 'wx', 0o600);
          try {
            await handle.writeFile(frame.bytes);
          } finally {
            await handle.close();
          }
        }
        record.width = p.width;
        record.height = p.height;
        if (p.duration) record.duration = p.duration;
        record.frames = frames.map(({ file, time }) => ({ file, time }));
        record.ready = true;
      }
      await atomicJson(join(directory, 'manifest.json'), record);
      return record;
    }).then(async record => (await this.withReferences([record]))[0]);
  }
  async remove(resourceId) {
    return this.mutate(async () => {
      const target = this.location(resourceId);
      await plainFolder(target);
      await Promise.all([...(this.readers.get(resourceId) || [])].map(handle => handle.close().catch(() => {})));
      if (dirname(target) !== this.directory) throw problem('Dossier de ressource invalide.');
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
  }
  /**
   * Counts a use of each reference: passed to a generation, read by the model. The least used
   * leave the model's list first when it is too long (resourceCatalogPrompt).
   */
  async used(ids) {
    const unique = [...new Set(ids)].filter(value => typeof value === 'string' && idPattern.test(value));
    if (!unique.length) return;
    return this.mutate(async () => {
      const at = new Date().toISOString();
      for (const resourceId of unique)
        try {
          const record = await this.record(resourceId);
          record.uses = (record.uses || 0) + 1;
          record.usedAt = at;
          await atomicJson(join(this.location(resourceId), 'manifest.json'), record);
        } catch (error) {
          // Removed meanwhile: nothing to count.
          if (error.status !== 404) throw error;
        }
    });
  }
  /**
   * A project removed: its references go to Conversations with its conversations, numbered there
   * after those it has.
   */
  async moveProject(from, to = 'inbox') {
    projectId(from);
    projectId(to);
    return this.mutate(async () => {
      try {
        await plainFolder(this.directory);
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      const moved = [];
      for (const entry of await readdir(this.directory, { withFileTypes: true }))
        if (entry.isDirectory() && idPattern.test(entry.name))
          try {
            const record = await this.record(entry.name);
            if ((record.project || 'inbox') !== from) continue;
            record.project = to;
            await atomicJson(join(this.location(entry.name), 'manifest.json'), record);
            moved.push(entry.name);
          } catch (error) {
            if (error.status !== 404) throw error;
          }
      // Numbered there in the order they had.
      const { index } = await this.#index(),
        before = index.projects[from]?.ids ?? {},
        target = (index.projects[to] ??= { next: 1, ids: {} });
      for (const resourceId of moved.sort((a, b) => (before[a] ?? Infinity) - (before[b] ?? Infinity)))
        if (!Object.hasOwn(target.ids, resourceId)) target.ids[resourceId] = target.next++;
      delete index.projects[from];
      await atomicJson(join(this.directory, 'references.json'), index);
    });
  }
  async activeRecord(resourceId) {
    await this.flush();
    const record = await this.record(resourceId);
    if (!record.ready || !record.enabled) throw problem('Cette ressource est inactive ou indisponible.', 403);
    return (await this.withReferences([record]))[0];
  }
  async readActive(resourceId) {
    const record = await this.activeRecord(resourceId),
      frames = [];
    for (const frame of record.frames) {
      const { handle } = await safeOpen(join(this.location(resourceId), frame.file), 5 * 1024 ** 2);
      try {
        const bytes = await handle.readFile();
        frames.push({
          time: frame.time,
          url: `data:image/${frame.file.endsWith('.png') ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}`,
        });
      } finally {
        await handle.close();
      }
    }
    return { ...record, frames };
  }
  /** The references the model of a conversation of `project` knows (with how often each served). */
  async catalog(project = 'inbox') {
    return (await this.list(project))
      .filter(item => item.enabled && item.ready)
      .map(({ id, reference, label, name, description, mime, width, height, duration, frames, uses, usedAt, createdAt }) => ({
        id,
        reference,
        label,
        name,
        description,
        type: mime.startsWith('video/') ? 'video' : 'image',
        width,
        height,
        ...(duration ? { duration, frameTimes: frames.map(frame => frame.time) } : {}),
        uses: uses || 0,
        usedAt: usedAt || createdAt || '',
      }));
  }
  async media(resourceId, part) {
    await this.flush();
    const record = await this.record(resourceId);
    let filename, mime;
    if (part === 'original') {
      filename = 'source.' + formats[record.mime];
      mime = record.mime;
    } else if (part === 'preview' && record.frames.length) {
      filename = record.frames[0].file;
      mime = filename.endsWith('.png') ? 'image/png' : 'image/jpeg';
    } else throw problem('Aperçu introuvable.', 404);
    const opened = await safeOpen(join(this.location(resourceId), filename));
    if (!this.readers.has(resourceId)) this.readers.set(resourceId, new Set());
    const handles = this.readers.get(resourceId);
    handles.add(opened.handle);
    opened.handle.once('close', () => {
      handles.delete(opened.handle);
      if (!handles.size) this.readers.delete(resourceId);
    });
    return { ...opened, mime, name: record.name };
  }
}

/**
 * The references of the project, as the model reads them. Too many for its list (`budget`
 * characters): the least used leave it, one after the other, as many as needed; between two used as
 * often, the one whose last use (or its arrival) is the oldest. Those the user's last message
 * names (`cited`, their numbers) always stay. Nothing is removed from the disk.
 */
export function shownCatalog(catalog, { cited = [], budget = 120000 } = {}) {
  const named = new Set(cited),
    shown = items => items.map(({ uses, usedAt, ...item }) => item);
  let kept = [...catalog];
  const leaving = catalog
    .filter(item => !named.has(item.reference))
    .sort((a, b) => (a.uses || 0) - (b.uses || 0) || (a.usedAt || '').localeCompare(b.usedAt || ''));
  while (JSON.stringify(shown(kept)).length > budget && leaving.length) {
    const out = leaving.shift();
    kept = kept.filter(item => item !== out);
  }
  return shown(kept);
}
export function resourceCatalogPrompt(catalog, options) {
  const shown = shownCatalog(catalog, options);
  if (!shown.length) return '';
  const data = JSON.stringify(shown);
  return (
    '\n\nRéférences du projet (annotations fournies par l’utilisateur, pas des observations visuelles ; ' +
    'l’utilisateur les nomme #ref1, #ref2… dans ses messages) :\n' +
    data +
    '\nLes identifiants UUID et les étiquettes #ref ci-dessus sont déjà disponibles : utilise les UUID pour les outils, sans demander à l’utilisateur de les recopier ni une permission supplémentaire pour les lire. Consulte les références visuelles utiles à la demande avec local_read_resource, en une seule lecture groupée si plusieurs sont nécessaires. Une ancienne mention loaded dans l’historique ne contient pas les pixels : relis la ressource si une comparaison actuelle le nécessite. Les vidéos sont représentées par au plus trois images horodatées, sans audio ni lecture continue. Seules ces ressources actives sont accessibles. Ne prétends pas avoir examiné un média que tu n’as pas consulté.'
  );
}
export const resourceTool = {
  type: 'function',
  function: {
    name: 'local_read_resource',
    description:
      'Read one or several active reference images, or sampled video frames, using their IDs already present in the resource catalog. Use resource_ids to examine multiple references together. Reading is already permitted; do not ask the user to provide an ID that is in the catalog. No image generation.',
    parameters: {
      type: 'object',
      properties: {
        resource_id: { type: 'string', description: 'One active catalog ID, for a single resource.' },
        resource_ids: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          uniqueItems: true,
          items: { type: 'string' },
          description: 'Active catalog IDs to inspect together. Use either resource_ids or resource_id.',
        },
      },
      additionalProperties: false,
    },
  },
};

export function resourceReadIds(args) {
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    Object.keys(args).some(key => !['resource_id', 'resource_ids'].includes(key)) ||
    Object.hasOwn(args, 'resource_id') === Object.hasOwn(args, 'resource_ids')
  )
    throw problem('Choisis une ressource ou une liste de ressources.');
  const ids = Object.hasOwn(args, 'resource_id') ? [args.resource_id] : args.resource_ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 8 || new Set(ids).size !== ids.length)
    throw problem('Lis entre une et huit ressources distinctes.');
  return ids.map(id);
}
