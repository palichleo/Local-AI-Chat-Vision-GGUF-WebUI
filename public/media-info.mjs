/**
 * What Moodix knows of a creation, kept inside its own file (16/11): its model, its prompt, its
 * settings, its seed… travel with the image, the clip or the sound, whatever its name becomes and
 * wherever it is copied. No file beside it is needed to read them back.
 * - PNG: an `iTXt` chunk named « moodix », before the pixels.
 * - MP4: a `uuid` box of Moodix's own, after everything else (players skip a box they do not know).
 * - WAV: a `MDIX` chunk, after the sound.
 * Each holds the same JSON (`{ moodix: 1, … }`, written by lib/media-info.mjs). This module reads it,
 * in the page as on the server, and builds the bytes that hold it; it never touches a file.
 */
export const KEYWORD = 'moodix';
export const CHUNK = 'MDIX';
// The extended type of the box: « moodix.creation! » in ASCII, so that it is recognised by eye too.
export const BOX = Uint8Array.from('moodix.creation!', letter => letter.charCodeAt(0));
/** No sheet is longer than this: what is larger is not Moodix's. */
export const MAX_INFO = 256 * 1024;

const encoder = new TextEncoder(),
  decoder = new TextDecoder();
const ascii = (bytes, from, length) => String.fromCharCode(...bytes.subarray(from, from + length));
const be32 = (bytes, at) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
const le32 = (bytes, at) => (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
const put32 = (value, little = false) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, little);
  return bytes;
};
const join = parts => {
  const whole = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.length;
  }
  return whole;
};
const same = (bytes, at, expected) => expected.every((value, index) => bytes[at + index] === value);

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();
/** The CRC of a PNG chunk (its type and its data). */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Which of the three a file is, from its first twelve bytes; null for anything else. */
export function kindOf(head) {
  if (head.length >= 8 && same(head, 0, [137, 80, 78, 71, 13, 10, 26, 10])) return 'png';
  if (head.length >= 12 && ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WAVE') return 'wav';
  if (head.length >= 12 && ascii(head, 4, 4) === 'ftyp') return 'mp4';
  return null;
}

const sheet = info => encoder.encode(JSON.stringify(info));
/** The chunk of a PNG that holds the sheet (length, type, data, CRC). */
export function pngChunk(info) {
  const body = join([encoder.encode('iTXt'), encoder.encode(KEYWORD), Uint8Array.of(0, 0, 0, 0, 0), sheet(info)]);
  return join([put32(body.length - 4), body, put32(crc32(body))]);
}
/** The box of an MP4 that holds the sheet. */
export function mp4Box(info) {
  const body = sheet(info);
  return join([put32(8 + BOX.length + body.length), encoder.encode('uuid'), BOX, body]);
}
/** The chunk of a WAV that holds the sheet (padded to an even length, as RIFF wants). */
export function wavChunk(info) {
  const body = sheet(info);
  return join([encoder.encode(CHUNK), put32(body.length, true), body, body.length % 2 ? Uint8Array.of(0) : new Uint8Array(0)]);
}

function parse(bytes) {
  try {
    const info = JSON.parse(decoder.decode(bytes));
    return info && typeof info === 'object' && info.moodix === 1 ? info : null;
  } catch {
    return null;
  }
}

/**
 * Where the pieces of a file are: `{ kind, parts, info }`. `parts` are the chunks of a PNG, the boxes
 * of an MP4 or the chunks of a WAV, each `{ type, at, size, mine }` (`mine`: it holds the sheet of
 * Moodix; `at` and `size` cover its whole, header included); null when the file is none of the three
 * or is not well formed. `source`: `{ size, read(offset, length) }`, which gives bytes.
 */
export async function layout(source) {
  const head = await source.read(0, Math.min(12, source.size)),
    kind = kindOf(head);
  if (!kind) return null;
  const parts = [];
  let info = null,
    at = kind === 'png' ? 8 : kind === 'wav' ? 12 : 0;
  for (let count = 0; at < source.size && count < 8192; count++) {
    if (kind === 'png') {
      if (at + 12 > source.size) return null;
      const header = await source.read(at, 8),
        length = be32(header, 0),
        type = ascii(header, 4, 4),
        size = 12 + length;
      if (at + size > source.size) return null;
      let mine = false,
        engine = false;
      if ((type === 'iTXt' || type === 'tEXt') && length <= MAX_INFO * 8) {
        const start = await source.read(at + 8, Math.min(length, KEYWORD.length + 1));
        mine = type === 'iTXt' && ascii(start, 0, KEYWORD.length) === KEYWORD && start[KEYWORD.length] === 0;
        // What the engine wrote of its own (the paths of its files among it): replaced by the sheet.
        engine = type === 'tEXt' && ascii(start, 0, 7) === 'atelier';
        if (mine && length <= MAX_INFO) {
          const data = await source.read(at + 8, length);
          // keyword, 0, compression flag, compression method, language, 0, translated keyword, 0, text
          let text = KEYWORD.length + 3;
          for (let zeros = 0; zeros < 2 && text < data.length; text++) if (data[text] === 0) zeros++;
          if (data[KEYWORD.length + 1] === 0) info = parse(data.subarray(text)) ?? info;
        }
      }
      parts.push({ type, at, size, mine, engine });
      at += size;
      if (type === 'IEND') break;
    } else if (kind === 'mp4') {
      if (at + 8 > source.size) return null;
      const header = await source.read(at, Math.min(16, source.size - at));
      let size = be32(header, 0),
        own = 8;
      const type = ascii(header, 4, 4);
      if (size === 1) {
        if (header.length < 16) return null;
        size = be32(header, 8) * 2 ** 32 + be32(header, 12);
        own = 16;
      } else if (size === 0) size = source.size - at;
      if (size < own || at + size > source.size) return null;
      let mine = false;
      if (type === 'uuid' && size >= own + BOX.length) {
        mine = same(await source.read(at + own, BOX.length), 0, [...BOX]);
        if (mine && size - own - BOX.length <= MAX_INFO)
          info = parse(await source.read(at + own + BOX.length, size - own - BOX.length)) ?? info;
      }
      parts.push({ type, at, size, mine, open: be32(header, 0) === 0 });
      at += size;
    } else {
      if (at + 8 > source.size) break;
      const header = await source.read(at, 8),
        type = ascii(header, 0, 4),
        length = le32(header, 4),
        size = Math.min(8 + length + (length % 2), source.size - at);
      if (at + 8 + length > source.size) return null;
      const mine = type === CHUNK;
      if (mine && length <= MAX_INFO) info = parse(await source.read(at + 8, length)) ?? info;
      parts.push({ type, at, size, mine });
      at += size;
    }
  }
  return { kind, parts, info };
}

/** The sheet a file carries, or null: `source` as for `layout`. */
export async function readInfo(source) {
  try {
    return (await layout(source))?.info ?? null;
  } catch {
    return null;
  }
}
/** The sheet a file of the page carries (a `File`, a `Blob`), or null. Only the bytes needed are read. */
export const fileInfo = file =>
  readInfo({
    size: file.size,
    read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
  });
/** The sheet held by bytes already in memory. */
export const bytesInfo = bytes =>
  readInfo({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) });
