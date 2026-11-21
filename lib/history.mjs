import { projectId } from './projects.mjs';
import { globalContext } from './global-context.mjs';
import { mkdir, readFile, writeFile, readdir, lstat, rm, open, stat } from 'node:fs/promises';
import { join, resolve, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicFile, renameWithRetry } from './update-files.mjs';
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
// A copy a save left beside its file is no save in progress any more after this long (pruneUnsaved).
const STALE_COPY_MS = 10 * 60 * 1000;
// The bin of the history (0.6.103): a conversation deleted, by the user or by the application, waits
// there 30 days, its folder whole, then it is erased. Before, it was erased at once, and nothing told.
export const TRASH = '.corbeille';
export const TRASH_DAYS = 30;
const TRASH_MS = TRASH_DAYS * 24 * 60 * 60 * 1000;
// What the bin says of each conversation in it (its name, why, when), beside its folder.
const TRASH_NOTE = 'corbeille.json';
// The version before the last save: taken back, and said, when the file cannot be read (0.6.103).
const PREVIOUS = 'conversation.json.prev';
// And those before a save that took messages out of it, the last few.
const VERSIONS = 'versions';
const KEPT_VERSIONS = 5;
/** Why a conversation leaves the history: the user, or the application by itself (checked on the disk). */
export const AUTOMATIC_REASONS = new Set(['studio-empty', 'recovery-empty']);
const REASONS = new Set(['user', 'user-all', 'prune', ...AUTOMATIC_REASONS]);
/** A name of the instant for a file: 2026-11-18T18-30-05-123Z. */
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
/** What is said of a conversation whose file cannot be read, nor its version before (0.6.103). */
const UNREADABLE_SAID = id =>
  `Cette conversation ne peut pas être lue : son fichier est abîmé (${join('history', id, 'conversation.json')}). ` +
  'Il est gardé tel quel, et ses prises restent dans les Archives. Vous pouvez la mettre à la corbeille depuis la liste des conversations.';
/** Whether `error` says a file of the history cannot be read (damaged, too large), not that it is held. */
const unreadable = error => Boolean(error?.status) && !error.code;
/** The name of a conversation whose file cannot be read, as far as its text still says it. */
function nameIn(bytes) {
  const found = String(bytes ?? '').match(/"title"\s*:\s*"((?:[^"\\]|\\.){1,240})"/);
  try {
    return found ? String(JSON.parse(`"${found[1]}"`)).slice(0, 120) : '';
  } catch {
    return '';
  }
}
/** The takes a folder of the history holds (`generated/`, lib/gallery.mjs). */
async function takesCount(directory) {
  try {
    return (await readdir(join(directory, 'generated'))).filter(name => validId.test(name)).length;
  } catch {
    return 0;
  }
}
/** Whether a save of `next` takes messages out of `previous`: fewer, or a message of the user changed. */
function removesMessages(previous = [], next = []) {
  if (next.length < previous.length) return true;
  return previous.some(
    (message, index) =>
      message?.role === 'user' && !message.internal && JSON.stringify(message.content) !== JSON.stringify(next[index]?.content),
  );
}
function originalType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP')
    return 'webp';
  return null;
}
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
      // Its words over the card of a video it proposed (video-brief.mjs), and how long it thought.
      ...(message.role === 'assistant' && message.planned === true ? { planned: true } : {}),
      ...(message.role === 'assistant' && Number.isFinite(message.reasoning_seconds) && message.reasoning_seconds > 0
        ? { reasoning_seconds: Math.round(message.reasoning_seconds) }
        : {}),
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
        // Several images made in one call: the last of them.
        else if (Array.isArray(result?.images))
          for (const image of [...result.images].reverse())
            if (validId.test(image?.run_id || '')) yield { kind: 'generation', runId: image.run_id };
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
  // Named by the user (0.6.0), or by the chat model once it answered (`auto`, lib/conversation-title.mjs): as written.
  if (record.titled === true || record.titled === 'auto') return record.title;
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
    // The count of the saves of its messages (0.6.103): a page saves on the one it read, never over
    // what another tab wrote since. A conversation saved before has none: 0.
    revision: Number.isInteger(record.revision) && record.revision >= 0 ? record.revision : 0,
  };
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

export class History {
  /**
   * `renameFile`: in place of fs.rename, to put a written file in its place (a test holds the file a moment).
   * `journal`: where what becomes of each conversation is written (lib/history-journal.mjs, 0.6.103).
   */
  constructor(directory, { renameFile, journal = null } = {}) {
    this.directory = resolve(directory);
    this.pending = Promise.resolve();
    this.renameFile = renameFile;
    this.journal = journal;
    this.trashDirectory = join(this.directory, TRASH);
    // Conversations whose file could not be read and whose version before was taken back: told to the page once.
    this.recoveredUntold = [];
  }
  flush() {
    return this.pending;
  }
  /** A line of the journal (0.6.103); none written without one. */
  note(event, entry) {
    return this.journal?.write({ event, ...entry });
  }

  /**
   * « Supprimer l'historique » (0.6.103): every conversation goes to the bin, each for 30 days, said in the
   * journal one by one. The bin stays; the history folder itself, erased whole before, too.
   */
  async clear({ tab = '' } = {}) {
    const target = resolve(this.directory);
    if (target !== this.directory || basename(target) !== 'history' || dirname(target) === target)
      throw problem('Le dossier à supprimer doit être le dossier history de l’application.');
    const clear = this.pending.then(async () => {
      try {
        await folder(target);
      } catch (error) {
        if (error.code === 'ENOENT') return 0;
        throw error;
      }
      let moved = 0;
      for (const entry of await readdir(target, { withFileTypes: true }))
        if (entry.isDirectory() && validId.test(entry.name)) {
          await this.#toTrash(entry.name, { reason: 'user-all', tab });
          moved++;
        }
      return moved;
    });
    this.pending = clear.catch(() => {});
    return clear;
  }

  /**
   * A conversation out of the history (0.6.103): its folder whole to the bin, where it waits 30 days
   * (restore, erase), and a line in the journal with `reason` (REASONS) and the `tab` that asked. What it
   * was: { trashed, title, messages, takes }. Erased at once before, by the user as by the page.
   */
  async remove(id, { reason = 'user', tab = '' } = {}) {
    checkId(id);
    const target = resolve(this.directory, id);
    if (basename(this.directory) !== 'history' || dirname(target) !== this.directory)
      throw problem('Dossier de conversation invalide.');
    const remove = this.pending.then(async () => {
      try {
        await folder(this.directory);
        await folder(target);
      } catch (error) {
        if (error.code === 'ENOENT') return { trashed: false };
        throw error;
      }
      return this.#toTrash(id, { reason: REASONS.has(reason) ? reason : 'user', tab });
    });
    this.pending = remove.catch(() => {});
    return remove;
  }

  /** The folder of conversation `id` moved to the bin, with what the bin says of it. */
  async #toTrash(id, { reason, tab }) {
    const source = join(this.directory, id),
      kept = join(this.trashDirectory, id),
      bytes = await readFile(join(source, 'conversation.json')).catch(() => null);
    let record = null;
    try {
      record = bytes ? JSON.parse(bytes.toString('utf8')) : null;
    } catch {}
    const about = {
      id,
      title: typeof record?.title === 'string' ? record.title.slice(0, 120) : nameIn(bytes) || '',
      projectId: typeof record?.projectId === 'string' ? record.projectId : 'inbox',
      messages: Array.isArray(record?.messages) ? record.messages.length : 0,
      takes: await takesCount(source),
      // A folder of images joined to a conversation never saved (pruneUnsaved): nothing of it to open again.
      saved: Boolean(bytes),
    };
    await mkdir(this.trashDirectory, { recursive: true, mode: 0o700 });
    // The same conversation in the bin already (deleted, given back, deleted again): the newer one stays.
    await rm(kept, { recursive: true, force: true });
    await renameWithRetry(source, kept, { renameFile: this.renameFile });
    await atomicFile(
      join(kept, TRASH_NOTE),
      JSON.stringify({ ...about, reason, deletedAt: new Date().toISOString() }, null, 2),
      this.renameFile,
    );
    await this.note('corbeille', { ...about, reason, tab });
    return { trashed: true, ...about };
  }

  /** What the bin holds, the most recently deleted first: { id, title, projectId, deletedAt, reason, messages, takes, saved }. */
  async trash() {
    await this.flush();
    const found = [];
    let entries = [];
    try {
      entries = await readdir(this.trashDirectory, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !validId.test(entry.name)) continue;
      const directory = join(this.trashDirectory, entry.name);
      let about = null;
      try {
        about = JSON.parse((await file(join(directory, TRASH_NOTE), 64 * 1024)).toString('utf8'));
      } catch {}
      const deletedAt =
        typeof about?.deletedAt === 'string' && Number.isFinite(Date.parse(about.deletedAt))
          ? about.deletedAt
          : new Date((await stat(directory)).mtimeMs).toISOString();
      found.push({
        id: entry.name,
        title: typeof about?.title === 'string' ? about.title : '',
        projectId: typeof about?.projectId === 'string' ? about.projectId : 'inbox',
        deletedAt,
        reason: REASONS.has(about?.reason) ? about.reason : 'user',
        messages: Number.isInteger(about?.messages) ? about.messages : 0,
        takes: Number.isInteger(about?.takes) ? about.takes : await takesCount(directory),
        saved: about ? about.saved !== false : true,
      });
    }
    return found.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  /**
   * A conversation of the bin back in the history, as it was deleted (its takes with it). Refused while
   * a conversation of the same identifier is in the history (one saved again since, from another tab).
   */
  async restore(id, { tab = '' } = {}) {
    checkId(id);
    const restore = this.pending.then(async () => {
      const kept = join(this.trashDirectory, id),
        target = join(this.directory, id);
      try {
        await folder(kept);
      } catch (error) {
        if (error.code === 'ENOENT') throw problem('Cette conversation n’est plus dans la corbeille.', 404);
        throw error;
      }
      if (await lstat(target).then(() => true, () => false))
        throw problem('Une conversation de même identifiant est déjà dans l’historique : rien n’a été remplacé.', 409);
      const about = await readFile(join(kept, TRASH_NOTE), 'utf8').then(JSON.parse, () => ({}));
      await renameWithRetry(kept, target, { renameFile: this.renameFile });
      await rm(join(target, TRASH_NOTE), { force: true });
      await this.note('restaurée', { id, title: about.title ?? '', messages: about.messages ?? 0, takes: about.takes ?? 0, reason: about.reason ?? 'user', tab });
      try {
        return summary(await json(join(target, 'conversation.json')));
      } catch {
        return null;
      }
    });
    this.pending = restore.catch(() => {});
    return restore;
  }

  /** A conversation of the bin erased for good, now: « Supprimer définitivement ». */
  async erase(id, { tab = '', reason = 'user', event = 'effacée' } = {}) {
    checkId(id);
    const erase = this.pending.then(async () => {
      const kept = join(this.trashDirectory, id);
      try {
        await folder(kept);
      } catch (error) {
        if (error.code === 'ENOENT') return { erased: false };
        throw error;
      }
      const about = await readFile(join(kept, TRASH_NOTE), 'utf8').then(JSON.parse, () => ({}));
      await rm(kept, { recursive: true, force: true });
      await this.note(event, { id, title: about.title ?? '', messages: about.messages ?? 0, takes: about.takes ?? 0, reason, tab });
      return { erased: true };
    });
    this.pending = erase.catch(() => {});
    return erase;
  }

  /** At launch: what waited in the bin more than 30 days is erased; their identifiers. */
  async purgeTrash({ now = Date.now() } = {}) {
    const purged = [];
    for (const item of await this.trash())
      if (now - Date.parse(item.deletedAt) > TRASH_MS) {
        await this.erase(item.id, { reason: 'trente-jours', event: 'purgée' });
        purged.push(item.id);
      }
    return purged;
  }

  /**
   * What the file of conversation `id` holds (0.6.103), for a deletion the page asks by itself: whether
   * it is there, readable, and has anything of its own (a message of the user, words of Moodix) besides
   * creations of the Studio that made nothing.
   */
  async contentOf(id) {
    checkId(id);
    await this.flush();
    let record;
    try {
      record = await json(join(this.directory, id, 'conversation.json'));
    } catch (error) {
      if (error.code === 'ENOENT') return { exists: await lstat(join(this.directory, id)).then(() => true, () => false), readable: false, own: false };
      return { exists: true, readable: false, own: true };
    }
    const own = (record.messages ?? []).some(message => {
      if (message?.role === 'tool') return false;
      if (message?.role === 'assistant') return typeof message.content === 'string' ? Boolean(message.content.trim()) : true;
      return !(message?.internal === true && typeof message.content === 'string' && STUDIO_LINE.test(message.content));
    });
    return { exists: true, readable: true, own, title: record.title, messages: record.messages?.length ?? 0 };
  }

  /** The conversations whose version before was taken back since the last time it was asked (0.6.103). */
  takeRecovered() {
    return this.recoveredUntold.splice(0);
  }

  /**
   * The file of the conversation in `directory`: { state: 'none' }, { state: 'ok', record, bytes }, or
   * { state: 'unreadable', bytes }. A file held for an instant (EBUSY, EPERM) is an error, not unreadable.
   */
  async #stored(directory) {
    const path = join(directory, 'conversation.json');
    let bytes = null;
    try {
      bytes = await file(path);
      const record = JSON.parse(bytes.toString('utf8'));
      summary(record);
      if (record.id !== basename(directory) || !Array.isArray(record.messages)) throw problem('Conversation enregistrée invalide.');
      return { state: 'ok', record, bytes };
    } catch (error) {
      if (error.code === 'ENOENT') return { state: 'none' };
      if (error instanceof SyntaxError || unreadable(error)) return { state: 'unreadable', bytes };
      throw error;
    }
  }

  /**
   * A file that cannot be read (0.6.103). With a version before it that reads whole: the file set aside
   * beside it (« conversation.illisible-<instant>.json »), that version in its place, said in the journal
   * and to the page once; the record taken back. Without one, null: the file stays where it is, the
   * conversation listed by its name as unreadable (a file moved without anything in its place would
   * leave it out of the list); `setAside` (a save is about to write the conversation again) moves it
   * aside all the same, said, never in the way of that save.
   */
  async #mend(directory, bytes, { tab = '', setAside = false } = {}) {
    const id = basename(directory),
      aside = `conversation.illisible-${stamp()}.json`;
    let before = null;
    try {
      const kept = await file(join(directory, PREVIOUS));
      before = JSON.parse(kept.toString('utf8'));
      summary(before);
      if (before.id !== id || !Array.isArray(before.messages)) before = null;
      else before.bytes = kept;
    } catch {
      before = null;
    }
    if (!before && !setAside) return null;
    await renameWithRetry(join(directory, 'conversation.json'), join(directory, aside), { renameFile: this.renameFile });
    const about = {
      id,
      title: before?.title || nameIn(bytes) || '',
      messages: before?.messages.length ?? 0,
      takes: await takesCount(directory),
      tab,
    };
    await this.note('illisible', { ...about, reason: 'fichier abîmé, gardé sous ' + aside });
    if (!before) return null;
    await atomicFile(join(directory, 'conversation.json'), before.bytes, this.renameFile);
    delete before.bytes;
    await this.note('reprise', { ...about, reason: 'version précédente reprise' });
    this.recoveredUntold.push({ id, title: before.title });
    return before;
  }

  /** A conversation whose file cannot be read, listed by its name (0.6.103): no longer a count alone. */
  async #unreadableItem(directory, bytes) {
    const id = basename(directory),
      info = await stat(directory),
      date = new Date(info.mtimeMs).toISOString(),
      named = nameIn(bytes),
      project = String(bytes ?? '').match(/"projectId"\s*:\s*"([0-9a-z-]{1,80})"/)?.[1];
    let place = 'inbox';
    try {
      place = projectId(project || 'inbox');
    } catch {}
    return {
      id,
      title: (named ? `${named.slice(0, 104)} (illisible)` : 'Conversation illisible').slice(0, 120),
      createdAt: date,
      updatedAt: date,
      incomplete: false,
      projectId: place,
      firstPrompt: '',
      preview: null,
      revision: 0,
      unreadable: true,
    };
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
   * before their first save). Only folders holding nothing but attachments are touched: to the bin
   * now (0.6.103), as every conversation that leaves. A copy of a first save that Windows held, alone
   * in its folder and whole, becomes the conversation again (it went with the folder before).
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
      if (await this.#found(directory, names)) continue;
      // Besides its attachments, a copy a refused save could not take away (atomicFile, 0.6.87), old
      // enough to belong to no save in progress: the folder was kept for good because of it.
      let unsaved = names.length > 0;
      for (const name of names) {
        if (validOriginal.test(name)) continue;
        const stale =
          /\.[0-9a-f-]{36}\.tmp$/.test(name) &&
          (await lstat(join(directory, name)).then(info => info.isFile() && Date.now() - info.mtimeMs > STALE_COPY_MS, () => false));
        if (!stale) {
          unsaved = false;
          break;
        }
      }
      if (!unsaved) continue;
      await this.#toTrash(entry.name, { reason: 'prune', tab: '' });
      removed++;
    }
    return removed;
  }

  /**
   * A folder without its conversation, and with a copy of it a save could not put in place (Windows held
   * it): the most recent copy that reads whole becomes the conversation, said in the journal (0.6.103).
   */
  async #found(directory, names) {
    if (names.includes('conversation.json')) return false;
    const copies = [];
    for (const name of names)
      if (/^conversation\.json\.[0-9a-f-]{36}\.tmp$/.test(name)) {
        const info = await lstat(join(directory, name)).catch(() => null);
        if (info?.isFile()) copies.push({ name, time: info.mtimeMs });
      }
    for (const { name } of copies.sort((a, b) => b.time - a.time)) {
      let record;
      try {
        record = JSON.parse((await file(join(directory, name))).toString('utf8'));
        summary(record);
        if (record.id !== basename(directory) || !Array.isArray(record.messages) || !record.messages.length) continue;
      } catch {
        continue;
      }
      await renameWithRetry(join(directory, name), join(directory, 'conversation.json'), { renameFile: this.renameFile });
      for (const other of copies) if (other.name !== name) await rm(join(directory, other.name), { force: true });
      await this.note('retrouvée', {
        id: record.id,
        title: record.title,
        messages: record.messages.length,
        takes: await takesCount(directory),
        reason: 'copie d’un enregistrement que Windows n’avait pas pu mettre en place',
      });
      return true;
    }
    return false;
  }

  /**
   * `keepRevision`: a save that moves the conversation (another project) and changes none of its
   * messages: the pages that hold it go on saving on their revision. `tab`: who saved, for the journal.
   */
  async save(input, { keepRevision = false, tab = '' } = {}) {
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
      // What the disk holds (0.6.103). A file that cannot be read no longer refuses every save after it:
      // set aside beside it and said in the journal, its version before taken back, then written over.
      let found = await this.#stored(directory),
        stored = found.state === 'ok' ? found.record : null;
      if (found.state === 'unreadable') stored = await this.#mend(directory, found.bytes, { tab, setAside: true });
      if (stored) {
        const previous = summary(stored);
        // Written since this page read it (another tab): refused, never written over (0.6.103). The
        // page reads it again, and keeps what is being written in its message box. A save that names no
        // revision (a conversation it never read, the session of an earlier version) is taken as it was.
        if (found.state === 'ok' && Number.isInteger(input.revision) && input.revision !== previous.revision)
          throw Object.assign(problem('Cette conversation a changé dans un autre onglet.', 409), { stale: true });
        createdAt = previous.createdAt;
        previousProject = previous.projectId;
        if (stored.titled === true || stored.titled === 'auto') {
          title = stored.title;
          titled = stored.titled;
        }
      }
      for (const name of referenced) {
        try {
          await file(join(directory, name), MAX_ORIGINAL);
        } catch (error) {
          if (error.code === 'ENOENT') throw problem('L’original d’une image jointe est introuvable.', 409);
          throw error;
        }
      }
      const revision = stored ? summary(stored).revision : 0,
        record = {
          version: 1,
          id,
          title,
          projectId: input.projectId || previousProject,
          createdAt,
          updatedAt: new Date().toISOString(),
          incomplete: input.incomplete === true,
          ...(titled ? { titled } : {}),
          ...(instructions ? { instructions } : {}),
          revision: keepRevision ? revision : revision + 1,
          messages: normalized,
        };
      if (found.state === 'ok') {
        // The version before, on the disk too (0.6.103): taken back if this one is ever found damaged.
        // Messages taken out of it (« Modifier », « Régénérer », a creation taken back): that version kept
        // aside as well, the last few of them, and said. (Copies: one that cannot be written stops no save.)
        await atomicFile(join(directory, PREVIOUS), found.bytes, this.renameFile).catch(() => {});
        if (removesMessages(stored.messages, normalized))
          await this.#keepVersion(directory, found.bytes, stored, normalized, tab).catch(() => {});
      }
      // Tried again when Windows refuses for an instant (an antivirus reading the file): given up at
      // once before 0.6.83, « Historique non enregistré : Erreur locale inattendue ».
      await atomicFile(path, JSON.stringify(record, null, 2), this.renameFile);
      return summary(record);
    });
    this.pending = write.catch(() => {});
    return write;
  }

  /** The version a save takes messages out of, kept in `versions/` (the last KEPT_VERSIONS), and said. */
  async #keepVersion(directory, bytes, stored, next, tab) {
    const versions = join(directory, VERSIONS);
    await mkdir(versions, { recursive: true, mode: 0o700 });
    await atomicFile(join(versions, `${stamp()}.json`), bytes, this.renameFile);
    const kept = (await readdir(versions)).filter(name => /\.json$/.test(name)).sort();
    for (const name of kept.slice(0, Math.max(0, kept.length - KEPT_VERSIONS))) await rm(join(versions, name), { force: true });
    await this.note('version gardée', {
      id: stored.id,
      title: stored.title,
      messages: stored.messages.length,
      after: next.length,
      takes: await takesCount(directory),
      reason: 'un enregistrement retire des messages',
      tab,
    });
  }

  /**
   * Renames a conversation (the pencil of the fil, 0.6.0): its name is kept from then on, the
   * messages that follow do not make another one. Its date of activity does not change.
   */
  /**
   * `auto`: the name the chat model gave (lib/conversation-title.mjs), kept until the user gives one;
   * never written over a name already given, by the user or by the model.
   */
  async rename(id, name, { auto = false } = {}) {
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
        found = await this.#stored(directory),
        // Unreadable: its version before taken back first (0.6.103); none, said in words.
        record = found.state === 'ok' ? found.record : found.state === 'unreadable' ? await this.#mend(directory, found.bytes) : null;
      if (found.state === 'none') throw problem('Conversation introuvable.', 404);
      if (!record) throw problem(UNREADABLE_SAID(id), 422);
      if (auto && (record.titled === true || record.titled === 'auto')) return summary(record);
      const renamed = { ...record, title, titled: auto ? 'auto' : true };
      await atomicFile(path, JSON.stringify(renamed, null, 2), this.renameFile);
      return summary(renamed);
    });
    this.pending = write.catch(() => {});
    return write;
  }

  /**
   * Whether a saved conversation has its name already (given by the user, or by the chat model):
   * its file only is read. False when it is not saved.
   */
  async named(id) {
    checkId(id);
    await this.flush();
    try {
      const record = await json(join(this.directory, id, 'conversation.json'));
      return record?.id === id && (record.titled === true || record.titled === 'auto');
    } catch (error) {
      if (error.code === 'ENOENT' || error.status) return false;
      throw error;
    }
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
        const directory = join(this.directory, entry.name);
        try {
          const found = await this.#stored(directory);
          // Attachments of a conversation that was never saved: not a damaged conversation.
          if (found.state === 'none') continue;
          if (found.state === 'ok') {
            conversations.push(summary(found.record));
            continue;
          }
          // Unreadable (0.6.103): its version before taken back, said once; else listed by its name, as
          // unreadable, where it can be opened (which says what can be done) or put in the bin. It was
          // left out of the list, a count alone said so.
          const mended = await this.#mend(directory, found.bytes);
          conversations.push(mended ? summary(mended) : await this.#unreadableItem(directory, found.bytes));
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
      const found = await this.#stored(directory);
      if (found.state === 'none') throw Object.assign(new Error('Conversation introuvable.'), { code: 'ENOENT' });
      // Unreadable: its version before taken back (0.6.103); none, what can be done said in words.
      const record = found.state === 'ok' ? found.record : await this.#mend(directory, found.bytes);
      if (!record) throw problem(UNREADABLE_SAID(id), 422);
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
