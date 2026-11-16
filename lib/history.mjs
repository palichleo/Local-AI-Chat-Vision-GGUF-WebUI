import { projectId } from './projects.mjs';
import { globalContext } from './global-context.mjs';
import { mkdir, readFile, writeFile, rename, readdir, lstat, rm, open } from 'node:fs/promises';
import { join, resolve, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { nativeFields } from './native-messages.mjs';
import { problem } from './engine.mjs';
import { splitVideos } from '../public/chat-videos.mjs';
import { STUDIO_LINE, conversationTitle, withoutStudioNote } from '../public/transcript.mjs';

const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Compressed copies written by earlier versions: the only copy left of those attachments.
const validImage = /^image-([0-9a-f]{64})\.(png|jpg)$/;
// Attachments as the user gave them. The model's compressed copies are made in the session.
const validOriginal = /^original-([0-9a-f]{64})\.(png|jpg|webp)$/;
const MAX_ORIGINAL = 64 * 1024 * 1024;
function originalType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP')
    return 'webp';
  return null;
}
/** Whether a stored image name is an original attachment (rather than an old compressed copy). */
export const isOriginalAttachment = name => typeof name === 'string' && validOriginal.test(name);
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
        return image(part, message);
      }).filter(Boolean);
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
        part =>
          part.type === 'image_url' &&
          (validImage.test(part.image_url?.url || '') || validOriginal.test(part.image_url?.url || '')),
      );
      if (image) yield { kind: 'attachment', name: image.image_url.url };
    }
  }
  return null;
}
/** The words of a message for its title: its text, its joined videos apart. */
const saidIn = message =>
  splitVideos(
    typeof message?.content === 'string' ? message.content : message?.content?.find?.(part => part.type === 'text')?.text,
  );
/**
 * The title of a conversation, from the first message that says something: its words, or for a
 * creation of the Studio its prompt alone (a creation without a prompt leaves it to the next
 * message); a first message of images or videos only is named after them.
 */
function titleFrom(messages) {
  for (const message of messages ?? []) {
    if (message.role !== 'user') continue;
    const said = saidIn(message),
      text = conversationTitle(said.text).slice(0, 120);
    if (text) return text;
    if (STUDIO_LINE.test(said.text)) continue;
    return said.videos.length ? ('Vidéo · ' + said.videos[0].name).slice(0, 120) : 'Conversation avec images';
  }
  return 'Nouveau chat';
}
/**
 * The title shown: the one saved, unless it is the title an earlier version made of a creation of
 * the Studio (« Studio · Image : un renard », with the note for the model before 0.5.125), that
 * is exactly what that version made of the first message; then the title made now. A title
 * written otherwise (one day, a conversation renamed) is left as it is. Nothing is rewritten on
 * the disk: the next save of the conversation keeps the new one.
 */
function shownTitle(record) {
  // Named by the user (0.6.0): shown as it was written.
  if (record.titled === true) return record.title;
  // (A creation without a prompt left « Studio · Son : » without its last space in 0.5.125.)
  if (!/^Studio · (?:Image|Vidéo|Son) :/.test(record.title)) return record.title;
  const said = saidIn(record.messages?.find(message => message.role === 'user'));
  const made = [said.text.slice(0, 120), withoutStudioNote(said.text).slice(0, 120)];
  return made.includes(record.title) ? titleFrom(record.messages) : record.title;
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
  const title = shownTitle(record);
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
    title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    incomplete: record.incomplete,
    projectId: projectId(record.projectId || 'inbox'),
    firstPrompt: (splitVideos(text).text || title).slice(0, 360),
    preview: previewSources(record).next().value || null,
  };
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

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

  /**
   * Stores an attachment as the user gave it (PNG, JPEG or WebP, up to 64 MB) beside its
   * conversation, before the conversation itself may be saved. Returns its file name.
   */
  async addOriginal(id, chunks) {
    checkId(id);
    const parts = [];
    let size = 0;
    for await (const chunk of chunks) {
      size += chunk.length;
      if (size > MAX_ORIGINAL) throw problem('Cette image dépasse 64 Mo.', 413);
      parts.push(chunk);
    }
    const bytes = Buffer.concat(parts),
      extension = originalType(bytes);
    if (!extension) throw problem('Choisissez une image PNG, JPEG ou WebP.');
    const name = `original-${createHash('sha256').update(bytes).digest('hex')}.${extension}`;
    const write = this.pending.then(async () => {
      await folder(this.directory, true);
      const directory = join(this.directory, id);
      await folder(directory, true);
      try {
        await writeFile(join(directory, name), bytes, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      return { file: name, size: bytes.length };
    });
    this.pending = write.catch(() => {});
    return write;
  }

  /** An attachment file of a conversation, opened for streaming. */
  async attachment(id, name) {
    checkId(id);
    const match = typeof name === 'string' && (name.match(validOriginal) || name.match(validImage));
    if (!match) throw problem('Image jointe invalide.');
    await this.flush();
    const path = join(this.directory, id, name);
    let info;
    try {
      await folder(this.directory);
      await folder(join(this.directory, id));
      info = await lstat(path);
    } catch (error) {
      if (error.code === 'ENOENT') throw problem('Image jointe introuvable.', 404);
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ORIGINAL) throw problem('Image jointe invalide.');
    const handle = await open(path, 'r');
    return { handle, info: await handle.stat(), mime: MIME[match[2]] };
  }

  /**
   * Removes the attachments of conversations that were never saved (history off, or closed
   * before their first save). Only folders holding nothing but attachments are touched.
   */
  async pruneUnsaved(keep = null) {
    try {
      await folder(this.directory);
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
    let removed = 0;
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validId.test(entry.name) || entry.name === keep) continue;
      const directory = join(this.directory, entry.name);
      const names = await readdir(directory);
      if (!names.length || !names.every(name => validOriginal.test(name))) continue;
      await rm(directory, { recursive: true, force: true });
      removed++;
    }
    return removed;
  }

  async save(input) {
    const id = checkId(input?.id);
    const instructions = globalContext(input.instructions);
    if (input.projectId !== undefined) projectId(input.projectId);
    if (input.incomplete !== undefined && typeof input.incomplete !== 'boolean')
      throw problem('État de conversation invalide.');
    // Images are kept as references to files of the conversation: the attachment as given
    // (or, for conversations saved by earlier versions, its old compressed copy). The model's
    // pixels are never written: images of internal messages are dropped.
    const referenced = new Set();
    const normalized = messages(input.messages, (part, message) => {
      const name = part.file;
      if (validOriginal.test(name || '') || validImage.test(name || '')) {
        referenced.add(name);
        return { type: 'image_url', image_url: { url: name } };
      }
      if (message.internal === true) return null;
      throw problem('L’original de cette image jointe est introuvable. Joignez-la à nouveau.');
    });
    // A joined video is a line naming its resource: the title is what the user wrote, else the video;
    // a conversation the user renamed keeps its name (read below).
    let title = titleFrom(normalized),
      titled = false;
    const write = this.pending.then(async () => {
      await folder(this.directory, true);
      const directory = join(this.directory, id);
      await folder(directory, true);
      const path = join(directory, 'conversation.json');
      let createdAt = new Date().toISOString(),
        previousProject = 'inbox';
      try {
        const stored = await json(path),
          previous = summary(stored);
        createdAt = previous.createdAt;
        previousProject = previous.projectId;
        if (stored.titled === true) {
          title = stored.title;
          titled = true;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      for (const name of referenced) {
        try {
          await file(join(directory, name), MAX_ORIGINAL);
        } catch (error) {
          if (error.code === 'ENOENT') throw problem('L’original d’une image jointe est introuvable.', 409);
          throw error;
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
        ...(titled ? { titled: true } : {}),
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

  /**
   * Renames a conversation (the pencil of the fil, 0.6.0): its name is kept from then on, the
   * messages that follow do not make another one. Its date of activity does not change.
   */
  async rename(id, name) {
    checkId(id);
    const title = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
    if (!title || title.length > 120) throw problem('Le nom d’une conversation fait de 1 à 120 caractères.');
    const write = this.pending.then(async () => {
      await folder(this.directory);
      const directory = join(this.directory, id);
      try {
        await folder(directory);
      } catch (error) {
        if (error.code === 'ENOENT') throw problem('Conversation introuvable.', 404);
        throw error;
      }
      const path = join(directory, 'conversation.json'),
        record = await json(path);
      summary(record);
      if (record.id !== id) throw problem('Conversation enregistrée invalide.');
      const renamed = { ...record, title, titled: true };
      await writeFile(`${path}.tmp`, JSON.stringify(renamed, null, 2), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
      return summary(renamed);
    });
    this.pending = write.catch(() => {});
    return write;
  }

  /** The project of a saved conversation (its file only, nothing else read); null when not saved. */
  async projectOf(id) {
    checkId(id);
    await this.flush();
    try {
      const record = await json(join(this.directory, id, 'conversation.json'));
      return record?.id === id ? projectId(record.projectId || 'inbox') : null;
    } catch (error) {
      if (error.code === 'ENOENT' || error.status) return null;
      throw error;
    }
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
        } catch (error) {
          // Attachments of a conversation that was never saved: not a damaged conversation.
          if (error.code !== 'ENOENT') skipped++;
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
          return { ...source, ...image };
        }
        const match = source.name.match(validImage) || source.name.match(validOriginal);
        const bytes = await file(join(directory, source.name), MAX_ORIGINAL);
        if (createHash('sha256').update(bytes).digest('hex') !== match[1]) throw problem('Aperçu endommagé.');
        return { ...source, bytes, mime: MIME[match[2]] };
      } catch (error) {
        if (error.status !== 404 && error.code !== 'ENOENT') throw error;
      }
    }
    // The conversation is there and has nothing to show as a cover: told apart from a missing one.
    throw Object.assign(problem('Aperçu indisponible.', 404), { nothingToShow: true });
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
          if (validOriginal.test(name || '')) continue;
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
        // An original carries only its name: its compressed copy is made in the session.
        // An old compressed copy is all that remains of its attachment, so it is sent as is.
        messages: messages(record.messages, part => {
          const name = part.image_url?.url;
          return images.has(name)
            ? { type: 'image_url', image_url: { url: images.get(name) }, file: name }
            : { type: 'image_url', file: name };
        }),
      };
    } catch (error) {
      if (error.code === 'ENOENT') throw problem('Conversation ou image introuvable.', 404);
      throw error;
    }
  }
}
