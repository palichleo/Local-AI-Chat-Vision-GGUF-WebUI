import { globalContext } from './global-context.mjs';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFields } from './native-messages.mjs';

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
export function updateSession(input) {
  if (
    !input ||
    !Array.isArray(input.messages) ||
    input.messages.length > 100 ||
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
    images: input.images.map(item => ({ name: text(item.name, 255), url: image(item.url) })),
    messages: input.messages.map(message => {
      if (!['user', 'assistant', 'tool'].includes(message?.role)) throw new Error('Message de session invalide.');
      const content =
        typeof message.content === 'string'
          ? text(message.content)
          : message.role === 'user' && Array.isArray(message.content) && message.content.length <= 65
            ? message.content.map(part => {
                if (part.type === 'text') return { type: 'text', text: text(part.text) };
                if (part.type === 'image_url')
                  return { type: 'image_url', image_url: { url: image(part.image_url?.url) } };
                throw new Error('Contenu de session invalide.');
              })
            : null;
      if (content === null) throw new Error('Contenu de session invalide.');
      return {
        role: message.role,
        content,
        ...nativeFields(message),
        ...(message.internal === true ? { internal: true } : {}),
        ...(message.reasoning_content !== undefined ? { reasoning_content: text(message.reasoning_content) } : {}),
      };
    }),
  };
  if (archiveSnapshot?.tail) {
    delete archiveSnapshot.tail;
    archiveSnapshot.messages = [...normalized.messages, ...archiveSnapshot.messages];
  }
  if (archiveSnapshot?.messages.length > 100) throw new Error('Trop de messages dans la session.');
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
