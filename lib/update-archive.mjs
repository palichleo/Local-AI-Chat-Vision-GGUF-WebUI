import { gunzipSync } from 'node:zlib';

export const managedRoots = new Set([
  'server.mjs',
  'package.json',
  'package-lock.json',
  'Lancer-Windows.cmd',
  'lancer-linux.sh',
  // The rescue update (scripts/rescue-update.mjs). An update made by an earlier version, whose
  // list lacks them, brings the script but not these two: they come with the next one.
  'Mettre-a-jour-Windows.cmd',
  'mettre-a-jour-linux.sh',
  'README.md',
  'README.zh-CN.md',
  'README.ko.md',
  'DISTRIBUTION.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  '.gitignore',
  '.gitattributes',
  'public',
  'lib',
  'scripts',
  'docs',
  'tests',
  'runner',
]);
const fail = () => {
  throw new Error('Archive de mise à jour invalide.');
};
function safePath(name) {
  if (!name || name.length > 1000 || /[\\:\x00-\x1f\x7f]/.test(name) || name.startsWith('/')) fail();
  const parts = name.replace(/\/$/, '').split('/');
  if (
    parts.some(
      part =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    fail();
  return parts;
}
function pax(bytes) {
  const values = {};
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset);
    const length = Number(bytes.toString('ascii', offset, space));
    if (
      space < offset ||
      !Number.isSafeInteger(length) ||
      length <= space - offset + 1 ||
      offset + length > bytes.length ||
      bytes[offset + length - 1] !== 10
    )
      fail();
    const field = bytes.toString('utf8', space + 1, offset + length - 1),
      equal = field.indexOf('=');
    if (equal < 1) fail();
    values[field.slice(0, equal)] = field.slice(equal + 1);
    offset += length;
  }
  return values;
}

export function readUpdateArchive(compressed, version) {
  if (compressed.length > 20 * 1024 * 1024) fail();
  const archive = gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
  const files = new Map(),
    seen = new Set();
  let prefix,
    extended = {},
    ended = false,
    count = 0;
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      ended = true;
      break;
    }
    const string = (start, length) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .split('\0')[0];
    const number = (start, length) => {
      const value = string(start, length).trim();
      if (!/^[0-7]+$/.test(value)) fail();
      return parseInt(value, 8);
    };
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (number(148, 8) !== checksum || !string(257, 6).startsWith('ustar')) fail();
    const size = number(124, 12),
      type = string(156, 1) || '0';
    const end = offset + 512 + size;
    if (size > 8 * 1024 * 1024 || end > archive.length || ++count > 4000) fail();
    const bytes = archive.subarray(offset + 512, end);
    offset = Math.ceil(end / 512) * 512;
    if (type === 'g') {
      const global = pax(bytes);
      if (global.path || global.linkpath || global.size) fail();
      continue;
    }
    if (type === 'x') {
      extended = pax(bytes);
      continue;
    }
    if (!['0', '5'].includes(type) || extended.linkpath || extended.size) fail();
    const name = extended.path || [string(345, 155), string(0, 100)].filter(Boolean).join('/');
    extended = {};
    const parts = safePath(name);
    prefix ||= parts[0];
    if (parts[0] !== prefix) fail();
    const path = parts.slice(1).join('/');
    if (!path) {
      if (type !== '5') fail();
      continue;
    }
    const key = path.toLowerCase();
    if (seen.has(key)) fail();
    seen.add(key);
    if (type === '5') {
      if (size) fail();
      continue;
    }
    const root = parts[1];
    if (managedRoots.has(root.toLowerCase()) && !managedRoots.has(root)) fail();
    if (!managedRoots.has(root)) continue;
    if (/\.(?:gguf|safetensors|ckpt|bin|exe|dll|so|dylib)$/i.test(path)) fail();
    files.set(path, Buffer.from(bytes));
  }
  if (!ended || ['server.mjs', 'package.json', 'public/index.html'].some(path => !files.has(path))) fail();
  const info = JSON.parse(files.get('package.json').toString('utf8'));
  if (
    info.name !== 'atelier-local' ||
    info.version !== version ||
    info.type !== 'module' ||
    Object.keys(info.dependencies || {}).length
  )
    fail();
  return files;
}
