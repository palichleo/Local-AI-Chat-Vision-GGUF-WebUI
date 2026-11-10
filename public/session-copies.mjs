/**
 * The model's compressed copies of attached images, kept for this session only.
 *
 * An attached image is stored as the user gave it; the model sees a reduced copy, made in the
 * page from that original when it is first needed (a new message, a reopened conversation,
 * the context meter) and kept in memory until the page closes. Nothing here touches the disk.
 */
import { compressImage } from './images.mjs';

const copies = new Map();

const key = (conversationId, file) => conversationId + '/' + file;

/** Records the copy made when the image was attached, so it is not made twice. */
export function rememberCopy(conversationId, file, url) {
  if (conversationId && file && url) copies.set(key(conversationId, file), Promise.resolve(url));
}

/** Forgets the copies of one conversation (deleted) or of all (history cleared). */
export function forgetCopies(conversationId = null) {
  if (!conversationId) return copies.clear();
  for (const name of copies.keys()) if (name.startsWith(conversationId + '/')) copies.delete(name);
}

/** The compressed copy of a stored attachment, made from its original when missing. */
export function attachmentCopy({ api, conversationId, file, count = 1, signal }) {
  const name = key(conversationId, file);
  if (!copies.has(name)) {
    const work = (async () => {
      const blob = await (await api(`attachments/${conversationId}/${file}`, undefined, { signal })).blob();
      return (await compressImage(blob, { name: file, count })).url;
    })();
    copies.set(name, work);
    work.catch(() => copies.delete(name));
  }
  return copies.get(name);
}

/** Whether some attached image of these messages still lacks its compressed copy. */
export function needsCopies(messages) {
  return messages.some(
    message =>
      Array.isArray(message.content) &&
      message.content.some(part => part.type === 'image_url' && part.file && !part.image_url?.url),
  );
}

/**
 * Gives every attached image of `messages` its compressed copy, in place. The copy's size
 * depends on how many images share the message, as when it was first attached.
 */
export async function fillCopies(messages, { api, conversationId, signal }) {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    const images = message.content.filter(part => part.type === 'image_url');
    for (const part of images) {
      if (!part.file || part.image_url?.url) continue;
      const url = await attachmentCopy({ api, conversationId, file: part.file, count: images.length, signal });
      part.image_url = { url };
    }
  }
  return messages;
}

/** Messages as stored: an attached image is its file name, without the model's pixels. */
export function withoutCopies(messages) {
  return messages.map(message =>
    Array.isArray(message.content) && message.content.some(part => part.type === 'image_url' && part.file)
      ? {
          ...message,
          content: message.content.map(part =>
            part.type === 'image_url' && part.file ? { type: 'image_url', file: part.file } : part,
          ),
        }
      : message,
  );
}
