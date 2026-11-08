const maxBytes = 64 * 1024 * 1024;
let pending = Promise.resolve();

export function imageBudget(count) {
  if (!Number.isInteger(count) || count < 0 || count > 64) throw new Error('Vous pouvez joindre 64 images au maximum par message.');
  return { maxSide: Math.min(1024, Math.floor(Math.sqrt(4_000_000 / Math.max(1, count)))), pixelBudget: 4_000_000 };
}

function checkBlob(blob, generated) {
  const allowed = generated ? ['image/png', 'image/jpeg', 'image/webp'] : ['image/png', 'image/jpeg'];
  if (!(blob instanceof Blob) || !allowed.includes(blob.type)) throw new Error(generated ? 'Choisissez une image PNG, JPEG ou WebP.' : 'Choisissez une image PNG ou JPEG.');
  if (blob.size > maxBytes) throw new Error('Cette image dépasse 64 Mo.');
}
function imageName(name, fallback = 'image') {
  if (name === undefined) return fallback;
  if (typeof name !== 'string' || !name.trim() || name.length > 255) throw new Error('Nom d’image invalide.');
  return name;
}
function dataBlob(url) {
  const header = typeof url === 'string' && /^data:image\/(png|jpeg|webp);base64,/.exec(url);
  if (!header) throw new Error('Utilisez une image locale PNG, JPEG ou WebP.');
  if (url.length - header[0].length > 4 * Math.ceil(maxBytes / 3)) throw new Error('Cette image dépasse 64 Mo.');
  const encoded = url.slice(header[0].length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Utilisez une image locale PNG, JPEG ou WebP.');
  const size = Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
  if (size > maxBytes) throw new Error('Cette image dépasse 64 Mo.');
  let decoded;
  try { decoded = atob(encoded); }
  catch { throw new Error('Cette image locale ne peut pas être lue.'); }
  return new Blob([Uint8Array.from(decoded, character => character.charCodeAt(0))], { type: `image/${header[1]}` });
}
function raster(blob, { name, count, source, maxPixels }) {
  const { maxSide } = imageBudget(count);
  const work = pending.then(async () => {
    const bitmap = await createImageBitmap(blob);
    let canvas;
    try {
      if (!Number.isFinite(bitmap.width * bitmap.height) || bitmap.width < 1 || bitmap.height < 1 || bitmap.width * bitmap.height > maxPixels) throw new Error(`Cette image dépasse ${maxPixels / 1_000_000} mégapixels. Réduisez sa taille avant de la joindre.`);
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(bitmap.width * scale));
      canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Le navigateur ne peut pas préparer cette image.');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const png = canvas.toDataURL('image/png');
      const jpeg = canvas.toDataURL('image/jpeg', 0.82);
      const url = png.length <= jpeg.length ? png : jpeg;
      if (!/^data:image\/(png|jpeg);base64,/.test(url)) throw new Error('La compression de cette image a échoué.');
      return { name, url, ...(source ? { source } : {}) };
    } finally {
      bitmap.close();
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    }
  });
  pending = work.then(() => {}, () => {});
  return work;
}

export async function compressImage(blob, { name, count = 1 } = {}) {
  imageBudget(count);
  if (count === 0) throw new Error('Le nombre d’images doit être positif.');
  checkBlob(blob, true);
  const filename = imageName(name, blob instanceof File ? blob.name : `image.${blob.type === 'image/jpeg' ? 'jpg' : blob.type.split('/')[1]}`);
  const source = blob instanceof File ? blob : new File([blob], filename, { type: blob.type });
  return raster(blob, { name: filename, count, source, maxPixels: 64_000_000 });
}

export async function prepareImages(items) {
  if (!items || typeof items[Symbol.iterator] !== 'function') throw new Error('Liste d’images invalide.');
  const list = Array.from(items);
  imageBudget(list.length);
  const prepared = [];
  for (const item of list) {
    if (item instanceof File) {
      checkBlob(item, false);
      prepared.push(await raster(item, { name: imageName(item.name), count: list.length, source: item, maxPixels: 40_000_000 }));
      continue;
    }
    if (!item || typeof item !== 'object') throw new Error('Image invalide.');
    const name = imageName(item.name);
    if (item.source !== undefined) {
      if (!(item.source instanceof File)) throw new Error('Source d’image invalide.');
      checkBlob(item.source, true);
      prepared.push(await raster(item.source, { name, count: list.length, source: item.source, maxPixels: 64_000_000 }));
      continue;
    }
    const blob = dataBlob(item.url);
    checkBlob(blob, true);
    prepared.push(await raster(blob, { name, count: list.length, maxPixels: 64_000_000 }));
  }
  return prepared;
}
