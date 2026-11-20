/**
 * The length of a creation, read once for every screen that says it (0.6.141): the cards of the chat
 * and of the Studio, the Pellicule, the window of a take, the Montage. Each read it for itself, and
 * three of the four forgot the continuation: a clip of 5 s continued by 10 s, whose file plays 15 s,
 * was « 10 s » in the Montage, which let no more of it be laid (his report of 20/11; on that day 15
 * of his 54 videos were continuations, the widest gap 19 s).
 *
 * No screen is read here: the server reads it too (lib/montages.mjs).
 */

/**
 * The length of a clip in seconds, from its settings. The file of a continuation holds the clip it
 * continues, then what it adds: its length is that of both (`continuation`, written by the engine),
 * not the frames it generated, overlap included (a suite of 5 s of a clip of 5 s read « 05.38 S »
 * while its file plays 10 s).
 */
export function clipSeconds(p = {}) {
  if (!(p.fps > 0)) return null;
  const made = p.continuation;
  if (made?.sourceFrames > 0 && made?.newFrames > 0) return (made.sourceFrames + made.newFrames) / p.fps;
  return p.frames > 0 ? p.frames / p.fps : null;
}

/** The length of a creation in seconds, from its record: a sound says it, a clip is counted; null for
 * an image, or when nothing tells. */
export function takeSeconds(record) {
  const p = record?.parameters ?? {};
  return Number(p.seconds) > 0 ? Number(p.seconds) : clipSeconds(p);
}
