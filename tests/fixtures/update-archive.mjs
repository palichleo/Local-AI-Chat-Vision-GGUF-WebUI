import { gzipSync } from 'node:zlib';
export function tarball(entries) {
  const blocks = [];
  for (const { name, text = '', type = '0' } of entries) {
    const bytes = Buffer.from(text), header = Buffer.alloc(512);
    header.write(name, 0, 100); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
    header.fill(32, 148, 156); header.write(type, 156); header.write('ustar\0', 257);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
export const sourceEntries = [
  { name: 'repo/package.json', text: '{"name":"atelier-local","version":"0.3.0","type":"module","engines":{"node":">=22"}}' },
  { name: 'repo/server.mjs', text: 'export const version="0.3.0";' },
  { name: 'repo/public/index.html', text: '<!doctype html><title>Updated</title>' },
  { name: 'repo/lib/test.mjs', text: 'export const updated=true;' },
];
