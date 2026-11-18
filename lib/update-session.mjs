import { globalContext } from './global-context.mjs';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFields } from './native-messages.mjs';
import { MAX_CONVERSATION_MESSAGES } from './history.mjs';

const text = (value, max = 200000) => {
  if (typeof value !== 'string' || value.length > max) throw new Error('Session de mise à jour invalide.');
  return value;
};
function image(value) {
  if (
    typeof value !== 'string' ||
    value.length > 7 * 1024 * 1024 ||
    !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    throw new Error('Image de session invalide.');
  return value;
}
// The file an attached image is kept as in the history (lib/history.mjs): the conversation is saved
// by it. Dropped here, the conversation taken back after « Redémarrer » or an update could no longer
// be saved, and no message could be sent in it (« L’original de cette image jointe est introuvable »).
const KEPT = /^(?:original-[0-9a-f]{64}\.(?:png|jpg|webp)|image-[0-9a-f]{64}\.(?:png|jpg))$/;
const kept = value => (typeof value === 'string' && KEPT.test(value) ? value : null);
const RESOURCE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
/**
 * An image of a message or of the draft: its pixels (the model's copy) when the page has them, its
 * file when it has one. One that only names its file is whole: the page makes its copy again from
 * the original (a conversation just reopened, an image taken back from an interrupted message).
 */
function picture(url, file) {
  const name = kept(file);
  if (url === undefined && name) return { file: name };
  return { url: image(url), ...(name ? { file: name } : {}) };
}
export function updateSession(input) {
  if (
    !input ||
    !Array.isArray(input.messages) ||
    // As many as a conversation may hold (100 was reached by ordinary use: the update was refused).
    input.messages.length > MAX_CONVERSATION_MESSAGES ||
    !Array.isArray(input.images) ||
    input.images.length > 64 ||
    (input.conversationId !== null && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.conversationId))
  )
    throw new Error('Session de mise à jour invalide.');
  let archiveSnapshot = null;
  if (input.archiveSnapshot !== undefined && input.archiveSnapshot !== null) {
    if (typeof input.archiveSnapshot.incomplete !== 'boolean') throw new Error('État de session invalide.');
    const compact = Array.isArray(input.archiveSnapshot.tail);
    const archived = updateSession({
      ...input,
      messages: compact ? input.archiveSnapshot.tail : input.archiveSnapshot.messages,
      archiveSnapshot: null,
    }).messages;
    archiveSnapshot = { messages: archived, incomplete: input.archiveSnapshot.incomplete };
    if (compact) archiveSnapshot.tail = true;
  }
  const normalized = {
    archiveSnapshot,
    ...(input.conversationInstructions !== undefined
      ? {
          conversationInstructions:
            input.conversationInstructions === null ? null : globalContext(input.conversationInstructions),
        }
      : {}),
    conversationId: input.conversationId,
    prompt: text(input.prompt, 100000),
    title: text(input.title, 200000),
    thinking: input.thinking === true,
    images: input.images.map(item => ({
      name: text(item.name, 255),
      ...picture(item.url, item.file),
      // The reference of the project it is, when it was joined as one.
      ...(typeof item.resource === 'string' && RESOURCE.test(item.resource) ? { resource: item.resource } : {}),
    })),
    messages: input.messages.map(message => {
      if (!['user', 'assistant', 'tool'].includes(message?.role)) throw new Error('Message de session invalide.');
      const content =
        typeof message.content === 'string'
          ? text(message.content)
          : message.role === 'user' && Array.isArray(message.content) && message.content.length <= 65
            ? message.content.map(part => {
                if (part.type === 'text') return { type: 'text', text: text(part.text) };
                if (part.type === 'image_url') {
                  const { url, file } = picture(part.image_url?.url, part.file);
                  return { type: 'image_url', ...(url ? { image_url: { url } } : {}), ...(file ? { file } : {}) };
                }
                throw new Error('Contenu de session invalide.');
              })
            : null;
      if (content === null) throw new Error('Contenu de session invalide.');
      return {
        role: message.role,
        content,
        ...nativeFields(message),
        ...(message.internal === true ? { internal: true } : {}),
        ...(message.role === 'assistant' && message.planned === true ? { planned: true } : {}),
        ...(message.role === 'assistant' && Number.isFinite(message.reasoning_seconds) && message.reasoning_seconds > 0
          ? { reasoning_seconds: Math.round(message.reasoning_seconds) }
          : {}),
        ...(message.reasoning_content !== undefined ? { reasoning_content: text(message.reasoning_content) } : {}),
      };
    }),
  };
  if (archiveSnapshot?.tail) {
    delete archiveSnapshot.tail;
    archiveSnapshot.messages = [...normalized.messages, ...archiveSnapshot.messages];
  }
  if (archiveSnapshot?.messages.length > MAX_CONVERSATION_MESSAGES) throw new Error('Trop de messages dans la session.');
  // The revision of the conversation the page had read (0.6.103): the page that comes saves on it.
  if (Number.isInteger(input.revision) && input.revision >= 0) normalized.revision = input.revision;
  // Without the history, the conversation set aside (0.6.103): found nowhere else, it was lost by an
  // update or « Redémarrer ». The same as the one shown, and its project.
  if (input.aside !== undefined && input.aside !== null) {
    if (typeof input.aside !== 'object' || !input.aside.conversationId) throw new Error('Session de mise à jour invalide.');
    const { aside, revision, ...kept } = input.aside;
    normalized.aside = {
      ...updateSession({ ...kept, aside: null }),
      projectId: typeof kept.projectId === 'string' && /^(?:inbox|[0-9a-z-]{1,80})$/.test(kept.projectId) ? kept.projectId : 'inbox',
    };
  }
  return normalized;
}
export async function readUpdateSession(dataDir) {
  try {
    const path = join(dataDir, 'update-session.json'),
      info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 40 * 1024 * 1024)
      throw new Error('Copie de reprise invalide.');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    // `restarted`: kept by « Redémarrer », not by an update.
    return {
      ...updateSession(saved),
      gallery: saved.gallery || [],
      ...(saved.restarted === true ? { restarted: true } : {}),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
