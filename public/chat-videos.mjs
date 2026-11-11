/**
 * Videos joined to a chat message. A video goes into the resource library (its original kept,
 * three frames for the model) and the message carries one line per video naming its resource:
 * the model reads the id it passes to the tools ({"resource": "…"}), the conversation keeps it
 * in its history as plain text, and the interface shows a player in its place.
 */
const LINE = /^\[Vidéo jointe : (.*?) « (.*) » — resource_id ([0-9a-f-]{36})\]$/;

export const isVideo = file => /^video\/(mp4|webm)$/.test(file?.type || '');

/** The line a video adds to the message. */
export function videoLine(video) {
  const name = String(video.name || 'vidéo').replace(/[«»\n\r]/g, ' ');
  return `[Vidéo jointe : ${video.label || 'Ref'} « ${name} » — resource_id ${video.id}]`;
}

/** The message text the model reads: what the user wrote, then one line per video. */
export function withVideos(text, videos) {
  if (!videos.length) return text;
  return [text, ...videos.map(videoLine)].filter(Boolean).join('\n');
}

/** A message text taken apart again: what the user wrote and the videos it names. */
export function splitVideos(text) {
  const videos = [],
    kept = [];
  for (const line of String(text ?? '').split('\n')) {
    const match = LINE.exec(line.trim());
    if (match) videos.push({ label: match[1], name: match[2], id: match[3] });
    else kept.push(line);
  }
  return { text: kept.join('\n').trim(), videos };
}
