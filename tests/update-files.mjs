import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import * as module from '../lib/update-files.mjs';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'atelier-installer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'data', 'updates', 'test-transaction');
  await mkdir(join(workspace, 'stage', 'public'), { recursive: true });
  await mkdir(join(root, 'public')); await mkdir(join(root, 'history')); await mkdir(join(root, '.git'));
  await writeFile(join(root, 'package.json'), '{"name":"atelier-local","version":"0.2.0"}');
  await writeFile(join(root, 'server.mjs'), 'old server'); await writeFile(join(root, 'public', 'index.html'), 'old page');
  await writeFile(join(root, 'data', 'config.json'), 'private paths'); await writeFile(join(root, 'history', 'keep.json'), 'private conversation');
  await writeFile(join(root, 'weights.gguf'), 'large original'); await writeFile(join(root, '.git', 'config'), 'git config');
  await writeFile(join(workspace, 'stage', 'package.json'), '{"name":"atelier-local","version":"0.3.0"}');
  await writeFile(join(workspace, 'stage', 'server.mjs'), 'new server'); await writeFile(join(workspace, 'stage', 'public', 'index.html'), 'new page');
  return { root, workspace };
}

test('installation replaces managed sources and retains private folders, originals and a recoverable backup', async t => {
  assert.equal(typeof module.replaceSources, 'function');
  const { root, workspace } = await fixture(t);
  await module.replaceSources({ root, workspace });
  assert.equal(await readFile(join(root, 'server.mjs'), 'utf8'), 'new server');
  assert.equal(await readFile(join(root, 'public', 'index.html'), 'utf8'), 'new page');
  assert.equal(await readFile(join(workspace, 'backup', 'server.mjs'), 'utf8'), 'old server');
  for (const [path, content] of [['data/config.json', 'private paths'], ['history/keep.json', 'private conversation'], ['weights.gguf', 'large original'], ['.git/config', 'git config']]) assert.equal(await readFile(join(root, path), 'utf8'), content);
  await module.restoreSources({ root, workspace });
  assert.equal(await readFile(join(root, 'server.mjs'), 'utf8'), 'old server');
  assert.equal(await readFile(join(root, 'public', 'index.html'), 'utf8'), 'old page');
});

test('pre-existing backup content is never mistaken for the sources being replaced', async t => {
  assert.equal(typeof module.replaceSources, 'function');
  const { root, workspace } = await fixture(t);
  // A stale or conflicting backup must not be used to restore unrelated files.
  await mkdir(join(workspace, 'backup', 'server.mjs'), { recursive: true });
  await writeFile(join(workspace, 'backup', 'server.mjs', 'obstacle'), 'keep');
  await assert.rejects(module.replaceSources({ root, workspace }));
  assert.equal(await readFile(join(root, 'server.mjs'), 'utf8'), 'old server');
  assert.equal(await readFile(join(root, 'public', 'index.html'), 'utf8'), 'old page');
  assert.equal(await readFile(join(root, 'data', 'config.json'), 'utf8'), 'private paths');
});

test('installer refuses symlinks and a workspace outside its own update folder before replacing sources', async t => {
  assert.equal(typeof module.replaceSources, 'function');
  const { root, workspace } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'atelier-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  await assert.rejects(module.replaceSources({ root, workspace: outside }));
  await rm(join(root, 'public'), { recursive: true });
  await writeFile(join(outside, 'keep.txt'), 'intact');
  await symlink(outside, join(root, 'public'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(module.replaceSources({ root, workspace }));
  assert.equal(await readFile(join(root, 'server.mjs'), 'utf8'), 'old server');
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'intact');
});
