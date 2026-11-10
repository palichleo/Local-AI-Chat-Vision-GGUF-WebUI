/**
 * Width and height of a PNG or JPEG from its first bytes, or null: enough to know the format
 * of an image a video starts from without decoding it.
 */
export function imageSize(bytes) {
  if (!bytes || bytes.length < 24) return null;
  if (bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString('latin1', 12, 16) === 'IHDR')
    return size(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset++;
      continue;
    }
    // Start-of-frame markers carry the size; C4, C8 and CC are tables, not frames.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return size(bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5));
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return null;
}

function size(width, height) {
  return width > 0 && height > 0 && width <= 131072 && height <= 131072 ? { width, height } : null;
}
