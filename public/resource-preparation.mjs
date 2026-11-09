import { compressImage, imageBudget } from './images.mjs';

function waitFor(video, event, signal) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      video.removeEventListener(event, success);
      video.removeEventListener('error', failure);
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve();
    };
    const success = () => finish(),
      failure = () =>
        finish(
          Error(
            'Cette vidéo ne peut pas être décodée par le navigateur. Utilisez MP4 ou WebM avec un codec pris en charge.',
          ),
        ),
      abort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(Error('La préparation vidéo a dépassé le délai.')), 15000);
    video.addEventListener(event, success, { once: true });
    video.addEventListener('error', failure, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export async function prepareResource(file, { signal } = {}) {
  signal?.throwIfAborted();
  const mime =
    file.type ||
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      mp4: 'video/mp4',
      webm: 'video/webm',
    }[file.name.split('.').at(-1).toLowerCase()];
  if (!['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm'].includes(mime))
    throw Error('Formats acceptés : PNG, JPEG, WebP, MP4 et WebM.');
  if (file.size > (mime.startsWith('video/') ? 512 : 64) * 1024 ** 2)
    throw Error('Limite : 64 Mo par image et 512 Mo par vidéo.');
  if (mime.startsWith('image/')) {
    const source = file.type ? file : new File([file], file.name, { type: mime });
    const image = await compressImage(source);
    signal?.throwIfAborted();
    return { mime, width: image.width, height: image.height, frames: [{ url: image.url, time: null }] };
  }
  return prepareVideo(file, { signal, name: file.name });
}
async function openVideo(source, { signal, name }) {
  const mime =
    source.type || { webm: 'video/webm', mp4: 'video/mp4' }[name.split('.').at(-1).toLowerCase()] || 'video/mp4';
  const video = document.createElement('video'),
    url = typeof source === 'string' ? source : URL.createObjectURL(source);
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  const release = () => {
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (typeof source !== 'string') URL.revokeObjectURL(url);
  };
  try {
    const metadata = waitFor(video, 'loadedmetadata', signal);
    video.src = url;
    await metadata;
    if (
      !Number.isFinite(video.duration) ||
      video.duration <= 0 ||
      video.duration > 86400 ||
      !video.videoWidth ||
      video.videoWidth * video.videoHeight > 64_000_000
    )
      throw Error('Durée ou résolution vidéo non prise en charge.');
    if (video.readyState < 2) await waitFor(video, 'loadeddata', signal);
    return { video, mime, release };
  } catch (error) {
    release();
    throw error;
  }
}

async function seek(video, time, signal) {
  signal?.throwIfAborted();
  if (Math.abs(video.currentTime - time) > 0.001) {
    const seeked = waitFor(video, 'seeked', signal);
    video.currentTime = time;
    await seeked;
  }
}

/** Draws the current video frame, scaled to fit `side`, and returns it as a compressed analysis copy. */
async function capture(video, { side, name, count }) {
  const canvas = document.createElement('canvas'),
    scale = Math.min(1, side / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.max(1, Math.floor(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.floor(video.videoHeight * scale));
  try {
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!blob) throw Error('Impossible de préparer cette image vidéo.');
    return await compressImage(blob, { name, count });
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function prepareVideo(source, { signal, name = 'Vidéo', frameCount = 3, totalFrames = frameCount } = {}) {
  signal?.throwIfAborted();
  if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > 3) throw Error('Nombre d’images vidéo invalide.');
  const { video, mime, release } = await openVideo(source, { signal, name });
  try {
    const times =
        video.duration < 0.2 || frameCount === 1
          ? [0]
          : (frameCount === 2 ? [0.1, 0.9] : [0.1, 0.5, 0.9]).map(fraction => video.duration * fraction),
      frames = [];
    for (const time of times) {
      await seek(video, time, signal);
      const prepared = await capture(video, {
        side: imageBudget(totalFrames).maxSide,
        name: name + ' — ' + time.toFixed(2) + 's',
        count: totalFrames,
      });
      frames.push({ time, url: prepared.url });
    }
    return { mime, width: video.videoWidth, height: video.videoHeight, duration: video.duration, frames };
  } finally {
    release();
  }
}

/** Storyboard size for a clip: about one frame in six, never fewer than 3 nor more than 16. */
export function storyboardCount(duration, fps = 24) {
  return Math.max(3, Math.min(16, Math.ceil((duration * fps) / 6)));
}

/**
 * One analysis image for a whole clip: frames taken at the middle of equal time slices, laid out
 * left to right and top to bottom, each stamped with its order and time. Its cost for the vision
 * model is that of a single image, whatever the number of frames. Up to three of the frames are
 * also returned separately for the gallery.
 */
export async function prepareStoryboard(source, { signal, name = 'Vidéo', fps = 24, maxSide = 1024 } = {}) {
  signal?.throwIfAborted();
  const { video, mime, release } = await openVideo(source, { signal, name });
  const sheet = document.createElement('canvas');
  try {
    const count = storyboardCount(video.duration, fps),
      times = Array.from({ length: count }, (_, i) => (video.duration * (i + 0.5)) / count),
      aspect = video.videoHeight / video.videoWidth;
    // The grid that gives each frame the most room inside a maxSide × maxSide image.
    let columns = 1,
      cellWidth = 0;
    for (let candidate = 1; candidate <= count; candidate++) {
      const width = Math.floor(Math.min(maxSide / candidate, maxSide / (Math.ceil(count / candidate) * aspect)));
      if (width > cellWidth) [columns, cellWidth] = [candidate, width];
    }
    const rows = Math.ceil(count / columns),
      cellHeight = Math.max(1, Math.floor(cellWidth * aspect));
    sheet.width = cellWidth * columns;
    sheet.height = cellHeight * rows;
    const context = sheet.getContext('2d');
    context.fillStyle = '#000';
    context.fillRect(0, 0, sheet.width, sheet.height);
    const label = Math.max(10, Math.round(cellHeight / 10)),
      picks = new Set([0, Math.floor((count - 1) / 2), count - 1]),
      frames = [];
    for (const [index, time] of times.entries()) {
      await seek(video, time, signal);
      const x = (index % columns) * cellWidth,
        y = Math.floor(index / columns) * cellHeight;
      context.drawImage(video, x, y, cellWidth, cellHeight);
      const text = `${index + 1} · ${time.toFixed(2)} s`;
      context.font = `bold ${label}px sans-serif`;
      context.fillStyle = 'rgba(0, 0, 0, 0.65)';
      context.fillRect(x, y, Math.ceil(text.length * label * 0.62) + 8, label + 8);
      context.fillStyle = '#fff';
      context.fillText(text, x + 4, y + label + 2);
      if (picks.has(index)) {
        const prepared = await capture(video, {
          side: imageBudget(3).maxSide,
          name: name + ' — ' + time.toFixed(2) + 's',
          count: 3,
        });
        frames.push({ time, url: prepared.url });
      }
    }
    const blob = await new Promise(resolve => sheet.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) throw Error('Impossible de préparer la planche de la vidéo.');
    const board = await compressImage(blob, { name: name + ' — planche', count: 1 });
    return {
      mime,
      width: video.videoWidth,
      height: video.videoHeight,
      duration: video.duration,
      frames,
      storyboard: { url: board.url, times, columns, rows },
    };
  } finally {
    sheet.width = 0;
    sheet.height = 0;
    release();
  }
}
