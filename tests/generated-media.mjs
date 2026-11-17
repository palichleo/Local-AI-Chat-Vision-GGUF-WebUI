import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generatedMedia } from '../lib/generated-media.mjs';
test('original local output can be read while traversal and unsupported files are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-output-'));
  try {
    // The folder of a kind of creation (lib/output-names.mjs); any other folder is never read.
    await mkdir(join(root, 'image'));
    await writeFile(join(root, 'image', 'test.png'), 'image');
    await mkdir(join(root, 'run'));
    await writeFile(join(root, 'run', 'test.png'), 'image');
    const media = await generatedMedia(root, { type: 'output', subfolder: 'image', filename: 'test.png' });
    assert.equal(media.mime, 'image/png');
    assert.equal((await media.handle.readFile()).toString(), 'image');
    await media.handle.close();
    for (const d of [
      { subfolder: '../', filename: 'test.png' },
      { subfolder: 'run', filename: 'test.png' },
      { subfolder: 'image', filename: '../secret.png' },
      { subfolder: 'image', filename: 'config.json' },
    ])
      await assert.rejects(generatedMedia(root, { type: 'output', ...d }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
