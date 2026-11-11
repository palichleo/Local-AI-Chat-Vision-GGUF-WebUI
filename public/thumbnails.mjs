/**
 * Small pictures of the creations. An output says `thumbUrl` when the server already keeps one;
 * otherwise the first place that shows the original (an image, or a frame of a video) makes it
 * and sends it, once, for every later display.
 */
const SIDE = 512;
const sent = new Set();

/** A JPEG of at most 512 px a side, of an image or of the frame a video shows; null when empty. */
export function shrink(media) {
  const width = media.naturalWidth || media.videoWidth || 0,
    height = media.naturalHeight || media.videoHeight || 0;
  if (!width || !height) return Promise.resolve(null);
  const scale = Math.min(1, SIDE / Math.max(width, height)),
    canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d').drawImage(media, 0, 0, canvas.width, canvas.height);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
}

/**
 * Sends a thumbnail made from `media`, unless one is known or was already sent from this page.
 * `where` names the output ({ conversationId, runId, index }) or, with `preview`, the cover of
 * a conversation (the server knows which creation it shows). Never an error: a missing
 * thumbnail only means the original is shown again.
 */
export async function keepThumbnail(api, where, media) {
  const id = where.preview ? 'preview/' + where.conversationId : `${where.conversationId}/${where.runId}/${where.index}`;
  if (sent.has(id)) return null;
  sent.add(id);
  try {
    const blob = await shrink(media);
    if (!blob) return null;
    const result = await (
      await api('gallery/thumbnail', blob, {
        raw: true,
        headers: {
          'Content-Type': 'image/jpeg',
          'X-Conversation-Id': where.conversationId,
          ...(where.preview ? { 'X-Preview': '1' } : { 'X-Run-Id': where.runId, 'X-Output-Index': String(where.index) }),
        },
      })
    ).json();
    return result.thumbUrl ?? null;
  } catch {
    return null;
  }
}

/** The same for an output of a gallery record; its `thumbUrl` is set once the server keeps it. */
export async function thumbnailOf(api, record, index, media) {
  const output = record?.outputs?.[index];
  if (!output || output.thumbUrl || record.provider !== 'native') return;
  const url = await keepThumbnail(api, { conversationId: record.conversationId, runId: record.id, index }, media);
  if (url) output.thumbUrl = url;
}
