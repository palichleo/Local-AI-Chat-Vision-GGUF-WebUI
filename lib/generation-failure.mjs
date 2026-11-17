/**
 * What a failure of the engine means for the user, in their words (16/11). The engine says it in
 * the words of its libraries (« CUDA driver error: device not ready … Failed to create GPU
 * mapping »): shown as such in the chat and in the Studio, it told nothing of what to do. The words
 * of the engine stay in its journal (data/generation-journal.jsonl), where a failure is read.
 */

// The card has no room left for the job: PyTorch refused an allocation, or the driver could not map
// memory for it (what Windows answers when even the memory it lends past the card's own is gone).
const NO_VIDEO_MEMORY =
  /CUDA out of memory|OutOfMemoryError|CUDA error: out of memory|Failed to create GPU mapping|CUDA driver error: device not ready|cudaErrorMemoryAllocation/i;

const KIND = { image: 'cette image', video: 'cette vidéo', audio: 'ce son' };
const seconds = value => String(Math.round(value * 10) / 10).replace('.', ',');

/**
 * `message`: what the engine said. `job`: what was asked of it — `media` ('image', 'video',
 * 'audio'), `width`, `height`, `frames`, `fps`, `overlap` (the frames a continuation shares with
 * its clip) and `continues` (it continues a clip, whose size it keeps). A failure that is not
 * known is given back as it came.
 */
export function explainFailure(message, { media = 'image', width, height, frames, fps, overlap = 0, continues = false } = {}) {
  const said = String(message ?? '').trim();
  if (!NO_VIDEO_MEMORY.test(said)) return said;
  const size = width > 0 && height > 0 ? `${width} × ${height}` : '',
    length = media === 'video' && frames > 0 && fps > 0 ? `${seconds(Math.max(0, frames - (continues ? overlap : 0)) / fps)} s` : '',
    asked = [size, length].filter(Boolean).join(', ');
  if (continues)
    return (
      `La carte graphique n’a pas assez de mémoire pour prolonger cette vidéo à sa taille${asked ? ` (${asked})` : ''}. ` +
      'Une suite garde la taille de la vidéo de départ : demandez une suite plus courte, partez d’une vidéo plus petite, ' +
      'ou fermez les programmes qui se servent de la carte.'
    );
  return (
    `La carte graphique n’a pas assez de mémoire pour ${KIND[media] ?? KIND.image}${asked ? ` (${asked})` : ''}. ` +
    `Choisissez une taille${media === 'video' ? ' ou une durée' : ''} plus petite, ou fermez les programmes qui se servent de la carte.`
  );
}
