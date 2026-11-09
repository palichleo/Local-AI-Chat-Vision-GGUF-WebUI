import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import * as module from '../lib/update-archive.mjs';
import { tarball, sourceEntries } from './fixtures/update-archive.mjs';
test('a pinned source archive exposes only managed sources, excluding local data and model weights', () => {
  assert.equal(typeof module.readUpdateArchive, 'function');
  const files = module.readUpdateArchive(
    tarball([
      ...sourceEntries,
      { name: 'repo/data/config.json', text: 'do not copy' },
      { name: 'repo/history/private.json', text: 'do not copy' },
      { name: 'repo/personal.txt', text: 'do not copy' },
      { name: 'repo/model.gguf', text: 'do not copy' },
    ]),
    '0.3.0',
  );
  assert.deepEqual([...files.keys()].sort(), ['lib/test.mjs', 'package.json', 'public/index.html', 'server.mjs']);
  assert.equal(files.get('lib/test.mjs').toString(), 'export const updated=true;');
});

test('archive rejects traversal, links, duplicate paths, wrong versions and corrupted data before any write', () => {
  assert.equal(typeof module.readUpdateArchive, 'function');
  for (const entry of [
    { name: 'repo/../outside.txt', text: 'escape' },
    { name: '/absolute/file', text: 'escape' },
    { name: 'repo/lib\\escape.mjs', text: 'escape' },
    { name: 'repo/public/nul.txt', text: 'reserved' },
    { name: 'repo/lib/link', type: '2' },
    { name: 'repo/lib/hard', type: '1' },
    { name: 'other/public/app.js', text: 'mixed roots' },
    { name: 'repo/server.mjs', text: 'duplicate' },
    { name: 'repo/PUBLIC/index.html', text: 'case alias' },
  ])
    assert.throws(() => module.readUpdateArchive(tarball([...sourceEntries, entry]), '0.3.0'), entry.name);
  assert.throws(() => module.readUpdateArchive(tarball(sourceEntries), '0.4.0'));
  assert.throws(() => module.readUpdateArchive(Buffer.from('broken'), '0.3.0'));
  assert.throws(() =>
    module.readUpdateArchive(tarball(sourceEntries.filter(entry => !entry.name.endsWith('server.mjs'))), '0.3.0'),
  );
});

test('native runner sources are updated while workflows, caches and originals stay private', () => {
  const files = module.readUpdateArchive(
    tarball([
      ...sourceEntries,
      { name: 'repo/runner/engine.py', text: 'native runner' },
      { name: 'repo/workflow/private.json', text: 'private workflow' },
      { name: 'repo/output/original.png', text: 'original' },
      { name: 'repo/data/generation-cache/prepared.safetensors', text: 'weights' },
    ]),
    '0.3.0',
  );
  assert.equal(files.get('runner/engine.py').toString(), 'native runner');
  assert.ok(![...files.keys()].some(path => /^(workflow|output|data)\//.test(path)));
});
