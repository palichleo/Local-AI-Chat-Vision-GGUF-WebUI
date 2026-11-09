import { projectId } from './projects.mjs';
import { globalContext } from './global-context.mjs';
import { mkdir, readFile, writeFile, rename, readdir, lstat, rm } from 'node:fs/promises';
import { join, resolve, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { nativeFields } from './native-messages.mjs';
import { problem } from './engine.mjs';

const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const validImage = /^image-([0-9a-f]{64})\.(png|jpg)$/;
function checkId(id) {
  if (typeof id !== 'string' || !validId.test(id)) throw problem('Identifiant de conversation invalide.');
  return id;
}
async function folder(path, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw problem('Dossier d’historique invalide.');
}
async function file(path, max = 20 * 1024 * 1024) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > max) throw problem('Fichier d’historique invalide.');
  return readFile(path);
}
async function json(path) {
  const bytes = await file(path);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw problem('Conversation enregistrée illisible.');
  }
}
function imageBytes(url) {
  if (typeof url !== 'string' || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(url))
    throw problem('Image d’historique invalide.');
  const bytes = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (bytes.length > 5 * 1024 * 1024 || (url.startsWith('data:image/png') ? !png : !jpeg))
    throw problem('Contenu d’image d’historique invalide.');
  return { bytes, extension: png ? 'png' : 'jpg' };
}
// Generation turns add several tool messages each; 100 was reached by ordinary use.
export const MAX_CONVERSATION_MESSAGES = 1000;
function messages(input, image) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_CONVERSATION_MESSAGES)
    throw problem('Historique de conversation invalide.');
  const text = value => {
    if (typeof value !== 'string' || value.length > 200000) throw problem('Texte d’historique invalide.');
    return value;
  };
  return input.map(message => {
    if (!message || !['user', 'assistant', 'tool'].includes(message.role)) throw problem('Rôle d’historique invalide.');
    let content;
    if (typeof message.content === 'string') content = text(message.content);
    else if (
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.length > 0 &&
      message.content.length <= 65
    ) {
      let count = 0;
      content = message.content.map(part => {
        if (part?.type === 'text') return { type: 'text', text: text(part.text) };
        if (part?.type !== 'image_url' || ++count > 64) throw problem('Images d’historique invalides.');
        return { type: 'image_url', image_url: { url: image(part.image_url?.url) } };
      });
    } else throw problem('Contenu d’historique invalide.');
    return {
      role: message.role,
      content,
      ...nativeFields(message),
      ...(message.internal === true ? { internal: true } : {}),
      ...(message.role === 'assistant' && message.reasoning_content !== undefined
        ? { reasoning_content: text(message.reasoning_content) }
        : {}),
    };
  });
}
function* previewSources(record) {
  for (const message of [...(record.messages || [])].reverse()) {
    if (message.role === 'tool' && typeof message.content === 'string') {
      try {
        const result = JSON.parse(message.content);
        if (validId.test(result?.run_id || '')) yield { kind: 'generation', runId: result.run_id };
      } catch {}
    }
    if (message.role === 'user' && !message.internal && Array.isArray(message.content)) {
      const image = message.content.find(
        part => part.type === 'image_url' && validImage.test(part.image_url?.url || ''),
      );
      if (image) yield { kind: 'attachment', name: image.image_url.url };
    }
  }
  return null;
}
function summary(record) {
  if (
    !record ||
    !validId.test(record.id) ||
    typeof record.title !== 'string' ||
    record.title.length > 120 ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    !Number.isFinite(Date.parse(record.updatedAt)) ||
    typeof record.incomplete !== 'boolean'
  )
    throw problem('Métadonnées d’historique invalides.');
  const first = record.messages?.find(message => message.role === 'user' && !message.internal),
    text =
      typeof first?.content === 'string'
        ? first.content
        : first?.content
            ?.filter(part => part.type === 'text')
            .map(part => part.text)
            .join(' ');
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    incomplete: record.incomplete,
    projectId: projectId(record.projectId || 'inbox'),
    firstPrompt: (text || record.title).slice(0, 360),
    preview: previewSources(record).next().value || null,
  };
}

export class History {
  constructor(directory) {
    this.directory = resolve(directory);
    this.pending = Promise.resolve();
  }
  flush() {
    return this.pending;
  }

  async clear() {
    const target = resolve(this.directory);
    if (target !== this.directory || basename(target) !== 'history' || dirname(target) === target)
      throw problem('Le dossier à supprimer doit être le dossier history de l’application.');
    const clear = this.pending.then(async () => {
      try {
        await folder(target);
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      await rm(target, { recursive: true, force: true });
    });
    this.pending = clear.catch(() => {});
    return clear;
  }

  async remove(id) {
    checkId(id);
    const target = resolve(this.directory, id);
    if (basename(this.directory) !== 'history' || dirname(target) !== this.directory)
      throw problem('Dossier de conversation invalide.');
    const remove = this.pending.then(async () => {
      try {
        await folder(this.directory);
        await folder(target);
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      await rm(target, { recursive: true, force: true });
    });
    this.pending = remove.catch(() => {});
    return remove;
  }

  async save(input) {
    const id = checkId(input?.id);
    const instructions = globalContext(input.instructions);
    if (input.projectId !== undefined) projectId(input.projectId);
    if (input.incomplete !== undefined && typeof input.incomplete !== 'boolean')
      throw problem('État de conversation invalide.');
    const images = new Map();
    const normalized = messages(input.messages, url => {
      const { bytes, extension } = imageBytes(url);
      const name = `image-${createHash('sha256').update(bytes).digest('hex')}.${extension}`;
      images.set(name, bytes);
      return name;
    });
    const user = normalized.find(message => message.role === 'user');
    const title =
      (typeof user?.content === 'string' ? user.content : user?.content.find(part => part.type === 'text')?.text)
        ?.trim()
        .slice(0, 120) || 'Conversation avec images';
    const write = this.pending.then(async () => {
      await folder(this.directory, true);
      const directory = join(this.directory, id);
      await folder(directory, true);
      const path = join(directory, 'conversation.json');
      let createdAt = new Date().toISOString(),
        previousProject = 'inbox';
      try {
        const previous = summary(await json(path));
        createdAt = previous.createdAt;
        previousProject = previous.projectId;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      for (const [name, bytes] of images) {
        try {
          await writeFile(join(directory, name), bytes, { flag: 'wx', mode: 0o600 });
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      }
      const record = {
        version: 1,
        id,
        title,
        projectId: input.projectId || previousProject,
        createdAt,
        updatedAt: new Date().toISOString(),
        incomplete: input.incomplete === true,
        ...(instructions ? { instructions } : {}),
        messages: normalized,
      };
      await writeFile(`${path}.tmp`, JSON.stringify(record, null, 2), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
      return summary(record);
    });
    this.pending = write.catch(() => {});
    return write;
  }

  async list() {
    await this.flush();
    const conversations = [];
    let skipped = 0;
    try {
      await folder(this.directory);
      for (const entry of await readdir(this.directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || !validId.test(entry.name)) continue;
        try {
          const record = summary(await json(join(this.directory, entry.name, 'conversation.json')));
          if (record.id !== entry.name) throw problem('Identifiant incohérent.');
          conversations.push(record);
        } catch {
          skipped++;
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    conversations.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return { conversations, skipped };
  }

  async preview(id, readGeneration) {
    checkId(id);
    await this.flush();
    const directory = join(this.directory, id);
    let saved;
    try {
      await folder(this.directory);
      await folder(directory);
      saved = await json(join(directory, 'conversation.json'));
    } catch (error) {
      if (error.code === 'ENOENT') throw problem('Aperçu introuvable.', 404);
      throw error;
    }
    if (saved.id !== id) throw problem('Conversation invalide.');
    summary(saved);
    for (const source of previewSources(saved)) {
      try {
        if (source.kind === 'generation') {
          const image = await readGeneration(source.runId);
          if (!image) continue;
          return {
            ...source,
            bytes: Buffer.from(image.split(',')[1], 'base64'),
            mime: image.startsWith('data:image/png;') ? 'image/png' : 'image/jpeg',
          };
        }
        const bytes = await file(join(directory, source.name), 5 * 1024 * 1024);
        if (createHash('sha256').update(bytes).digest('hex') !== source.name.match(validImage)[1])
          throw problem('Aperçu endommagé.');
        return { ...source, bytes, mime: source.name.endsWith('.png') ? 'image/png' : 'image/jpeg' };
      } catch (error) {
        if (error.status !== 404 && error.code !== 'ENOENT') throw error;
      }
    }
    throw problem('Aperçu indisponible.', 404);
  }

  async read(id) {
    checkId(id);
    await this.flush();
    try {
      await folder(this.directory);
      const directory = join(this.directory, id);
      await folder(directory);
      const record = await json(join(directory, 'conversation.json'));
      const metadata = summary(record);
      if (record.id !== id || !Array.isArray(record.messages)) throw problem('Conversation enregistrée invalide.');
      const images = new Map();
      for (const message of record.messages) {
        if (!Array.isArray(message?.content)) continue;
        for (const part of message.content) {
          if (part?.type !== 'image_url') continue;
          const name = part.image_url?.url;
          const match = typeof name === 'string' && name.match(validImage);
          if (!match) throw problem('Chemin d’image d’historique invalide.');
          if (!images.has(name)) {
            const bytes = await file(join(directory, name), 5 * 1024 * 1024);
            if (createHash('sha256').update(bytes).digest('hex') !== match[1])
              throw problem('Image enregistrée endommagée.');
            const url = `data:image/${match[2] === 'png' ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}`;
            imageBytes(url);
            images.set(name, url);
          }
        }
      }
      return {
        ...metadata,
        ...(record.instructions !== undefined ? { instructions: globalContext(record.instructions) } : {}),
        messages: messages(record.messages, name => images.get(name)),
      };
    } catch (error) {
      if (error.code === 'ENOENT') throw problem('Conversation ou image introuvable.', 404);
      throw error;
    }
  }
}
