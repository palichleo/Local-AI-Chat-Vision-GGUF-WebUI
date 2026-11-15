/**
 * Small pictures of the creations. An output says `thumbUrl` when the server already keeps one;
 * otherwise the first place that shows the original (an image, or a frame of a video) makes it
 * and sends it, once, for every later display. A picture with nothing drawn, or black, is never
 * kept (a hidden page, a frame not decoded yet); one kept so before 0.5.125 is made again from its
 * clip when it is shown (healThumbnail).
 */
const SIDE = 512;
const sent = new Set();
const healing = new Set();

/** True when nothing is drawn on the canvas, or only black. */
export function blank(context, width, height) {
  const { data } = context.getImageData(0, 0, width, height);
  for (let i = 0; i < data.length; i += 4)
    if (data[i + 3] > 0 && (data[i] > 8 || data[i + 1] > 8 || data[i + 2] > 8)) return false;
  return true;
}

/** A JPEG of at most 512 px a side, of an image or of the frame a video shows; null when empty or black. */
export function shrink(media) {
  const width = media.naturalWidth || media.videoWidth || 0,
    height = media.naturalHeight || media.videoHeight || 0;
  if (!width || !height) return Promise.resolve(null);
  const scale = Math.min(1, SIDE / Math.max(width, height)),
    canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(media, 0, 0, canvas.width, canvas.height);
  if (blank(context, canvas.width, canvas.height)) return Promise.resolve(null);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
}

/** Sends a JPEG to the server; its address there, or null. `replace`: in place of the one kept. */
async function upload(api, where, blob, replace) {
  try {
    const result = await (
      await api('gallery/thumbnail', blob, {
        raw: true,
        headers: {
          'Content-Type': 'image/jpeg',
          'X-Conversation-Id': where.conversationId,
          ...(where.preview ? { 'X-Preview': '1' } : { 'X-Run-Id': where.runId, 'X-Output-Index': String(where.index) }),
          ...(replace ? { 'X-Replace': '1' } : {}),
        },
      })
    ).json();
    return result.thumbUrl ?? null;
  } catch {
    return null;
  }
}

/**
 * Sends a thumbnail made from `media`, unless one is known or was already sent from this page.
 * `where` names the output ({ conversationId, runId, index }) or, with `preview`, the cover of
 * a conversation (the server knows which creation it shows). Never an error: a missing
 * thumbnail only means the original is shown again. Nothing is made while the page is hidden
 * (no frame is decoded then), nor from an empty or black picture: the next display tries again.
 */
export async function keepThumbnail(api, where, media) {
  const id = where.preview ? 'preview/' + where.conversationId : `${where.conversationId}/${where.runId}/${where.index}`;
  if (sent.has(id) || globalThis.document?.visibilityState === 'hidden') return null;
  sent.add(id);
  let blob = null;
  try {
    blob = await shrink(media);
  } catch {
    // Unreadable: the original stays.
  }
  if (!blob) {
    sent.delete(id);
    return null;
  }
  return upload(api, where, blob, false);
}

/** The same for an output of a gallery record; its `thumbUrl` is set once the server keeps it. */
export async function thumbnailOf(api, record, index, media) {
  const output = record?.outputs?.[index];
  if (!output || output.thumbUrl || record.provider !== 'native') return;
  const url = await keepThumbnail(api, { conversationId: record.conversationId, runId: record.id, index }, media);
  if (url) output.thumbUrl = url;
}

const event = (target, names, wait) =>
  new Promise(resolve => {
    const late = setTimeout(() => done(false), wait);
    function done(value) {
      clearTimeout(late);
      for (const name of names) target[name] = null;
      resolve(value);
    }
    target[names[0]] = () => done(true);
    target[names[1]] = () => done(false);
  });

/**
 * The thumbnail of a clip, once shown: found black (kept before 0.5.125 from a frame the browser
 * had not decoded), it is made again from the clip, in the background, sent in place of the
 * black one and shown. Once a session per output; not while the page is hidden.
 */
export async function healThumbnail(api, record, index, picture) {
  const output = record?.outputs?.[index];
  if (record?.mediaType !== 'video' || record.provider !== 'native' || !output?.thumbUrl || !output.originalUrl) return;
  const id = `${record.conversationId}/${record.id}/${index}`;
  if (healing.has(id) || !picture.naturalWidth || globalThis.document?.visibilityState === 'hidden') return;
  // A copy of 24 × 24 says whether anything is drawn.
  const probe = document.createElement('canvas');
  probe.width = probe.height = 24;
  const context = probe.getContext('2d', { willReadFrequently: true });
  context.drawImage(picture, 0, 0, 24, 24);
  if (!blank(context, 24, 24)) return;
  healing.add(id);
  const clip = document.createElement('video');
  Object.assign(clip, { muted: true, preload: 'auto', playsInline: true, src: output.originalUrl + '#t=0.1' });
  let blob = null;
  if (await event(clip, ['onloadeddata', 'onerror'], 20000)) {
    blob = await shrink(clip).catch(() => null);
    // Its first frame not ready yet: a little further.
    if (!blob) {
      clip.currentTime = 0.4;
      if (await event(clip, ['onseeked', 'onerror'], 8000)) blob = await shrink(clip).catch(() => null);
    }
  }
  clip.removeAttribute('src');
  clip.load?.();
  const url = blob && (await upload(api, { conversationId: record.conversationId, runId: record.id, index }, blob, true));
  if (!url) return;
  output.thumbUrl = url;
  picture.src = url;
}
