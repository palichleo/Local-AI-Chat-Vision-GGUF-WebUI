import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { moveManifests } from '../lib/output-manifests.mjs';

test('the manifests left beside the creations join their own folder; nothing else moves', async t => {
  const root = await mkdtemp(join(tmpdir(), 'atelier-manifests-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'output'),
    manifests = join(root, 'manifests');
  await mkdir(output);
  await mkdir(manifests);
  const manifest = id => JSON.stringify({ jobId: id, outputs: [], metadata: {} });
  const files = {
    'a.png': 'png',
    'a.json': manifest('a'),
    'b.mp4': 'mp4',
    'b.json': manifest('b'),
    'c.wav': 'wav',
    'c.json': manifest('c'),
    // A JSON of the user, without a creation of its name, or not a manifest: stays.
    'notes.json': manifest('x'),
    'd.png': 'png',
    'd.json': JSON.stringify({ title: 'mine' }),
    // Already in the folder of the manifests: left where it is, never overwritten.
    'e.png': 'png',
    'e.json': manifest('e-new'),
  };
  for (const [name, content] of Object.entries(files)) await writeFile(join(output, name), content);
  await writeFile(join(manifests, 'e.json'), manifest('e-old'));
  assert.equal(await moveManifests(output, manifests), 3);
  assert.deepEqual((await readdir(output)).sort(), ['a.png', 'b.mp4', 'c.wav', 'd.json', 'd.png', 'e.json', 'e.png', 'notes.json']);
  assert.deepEqual((await readdir(manifests)).sort(), ['a.json', 'b.json', 'c.json', 'e.json']);
  assert.equal(JSON.parse(await readFile(join(manifests, 'e.json'), 'utf8')).jobId, 'e-old');
  // Once done, nothing more to move; no folder of creations, nothing either.
  assert.equal(await moveManifests(output, manifests), 0);
  assert.equal(await moveManifests(join(root, 'none'), manifests), 0);
});
