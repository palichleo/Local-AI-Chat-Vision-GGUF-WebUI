/**
 * Size, frame count and frame rate of an MP4 file, read from its index (the `moov` box) without
 * decoding anything; null for another container or an index that says none of it.
 */
import { open } from 'node:fs/promises';

const MAX_INDEX = 64 * 1024 ** 2;

function* boxes(bytes, start, end) {
  let offset = start;
  while (offset + 8 <= end) {
    let size = bytes.readUInt32BE(offset),
      header = 8;
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (size === 1) {
      if (offset + 16 > end) return;
      size = Number(bytes.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header || offset + size > end) return;
    yield { type, start: offset + header, end: offset + size };
    offset += size;
  }
}
const child = (bytes, parent, type) => [...boxes(bytes, parent.start, parent.end)].find(box => box.type === type);

function index(bytes) {
  for (const track of boxes(bytes, 0, bytes.length)) {
    if (track.type !== 'trak') continue;
    const header = child(bytes, track, 'tkhd'),
      media = child(bytes, track, 'mdia');
    const handler = media && child(bytes, media, 'hdlr'),
      clock = media && child(bytes, media, 'mdhd');
    if (!header || !handler || !clock || bytes.toString('latin1', handler.start + 8, handler.start + 12) !== 'vide')
      continue;
    // The size closes the track header, as two 16.16 numbers.
    const width = bytes.readUInt32BE(header.end - 8) >>> 16,
      height = bytes.readUInt32BE(header.end - 4) >>> 16;
    if (!width || !height) continue;
    const long = bytes[clock.start] === 1,
      scale = bytes.readUInt32BE(clock.start + (long ? 20 : 12)),
      ticks = long ? Number(bytes.readBigUInt64BE(clock.start + 24)) : bytes.readUInt32BE(clock.start + 16);
    const table = ['minf', 'stbl', 'stts'].reduce((box, type) => box && child(bytes, box, type), media);
    let frames = 0;
    if (table)
      for (let entry = 0, count = bytes.readUInt32BE(table.start + 4); entry < count; entry++) {
        if (table.start + 16 + entry * 8 > table.end) break;
        frames += bytes.readUInt32BE(table.start + 8 + entry * 8);
      }
    const seconds = scale ? ticks / scale : 0;
    return {
      width,
      height,
      frames: frames || null,
      seconds: seconds || null,
      fps: frames && seconds ? frames / seconds : null,
    };
  }
  return null;
}

/** The same reading of an MP4 held in memory. */
export function mp4Bytes(bytes) {
  const moov = [...boxes(bytes, 0, bytes.length)].find(box => box.type === 'moov');
  return moov ? index(bytes.subarray(moov.start, moov.end)) : null;
}

export async function mp4Info(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat(),
      head = Buffer.alloc(16);
    for (let offset = 0; offset + 8 <= size;) {
      const { bytesRead } = await handle.read(head, 0, 16, offset);
      if (bytesRead < 8) return null;
      let length = head.readUInt32BE(0),
        header = 8;
      if (length === 1 && bytesRead === 16) {
        length = Number(head.readBigUInt64BE(8));
        header = 16;
      } else if (length === 0) length = size - offset;
      if (length < header) return null;
      if (head.toString('latin1', 4, 8) === 'moov') {
        if (length - header > MAX_INDEX || offset + length > size) return null;
        const content = Buffer.alloc(length - header);
        await handle.read(content, 0, content.length, offset + header);
        return index(content);
      }
      offset += length;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}
