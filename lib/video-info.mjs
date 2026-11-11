/**
 * Size, frame count and frame rate of an MP4, read from its index (the `moov` box) without
 * decoding anything; null for another container or an index that says none of it.
 */
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

/** What the index of an MP4 held in memory says of its video. */
export function mp4Bytes(bytes) {
  const moov = [...boxes(bytes, 0, bytes.length)].find(box => box.type === 'moov');
  return moov ? index(bytes.subarray(moov.start, moov.end)) : null;
}
