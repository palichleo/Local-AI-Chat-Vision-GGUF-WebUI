import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink, rename } from 'node:fs/promises';
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

test('atomic status writes retry transient Windows locks without removing the previous status', async t => {
  const {root} = await fixture(t), target = join(root, 'data', 'status.json');
  await module.atomicJson(target, {state:'old'}); let attempts = 0;
  await module.atomicJson(target, {state:'done'}, async (from, to) => {
    attempts++;
    assert.deepEqual(JSON.parse(await readFile(to, 'utf8')), {state:'old'});
    if (attempts <= 2) throw Object.assign(Error('Reader lock'), {code:attempts === 1 ? 'EPERM' : 'EBUSY'});
    return rename(from, to);
  });
  assert.equal(attempts, 3); assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), {state:'done'});
  assert.equal((await readdir(join(root, 'data'))).includes('status.json.tmp'), false);
});
test('permanent status write errors are bounded and preserve the last valid JSON', async t => {
  const {root} = await fixture(t), target = join(root, 'data', 'status.json');
  await module.atomicJson(target, {state:'old'});
  for (const code of ['EINVAL', 'EPERM']) {
    let attempts = 0;
    await assert.rejects(module.atomicJson(target, {state:'done'}, async () => { attempts++; throw Object.assign(Error('Blocked'), {code}); }), {code});
    assert.equal(attempts, code === 'EINVAL' ? 1 : 13);
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), {state:'old'});
    assert.equal((await readdir(join(root, 'data'))).includes('status.json.tmp'), false);
  }
});
test('a status reader can keep polling while atomic updates complete', async t => {
  const {root} = await fixture(t), target = join(root, 'data', 'status.json');
  await module.atomicJson(target, {step:0}); let reading = true;
  const reader = (async () => { while (reading) { await readFile(target).catch(() => {}); await new Promise(resolve => setTimeout(resolve, 10)); } })();
  try { for (let step = 1; step <= 20; step++) await module.atomicJson(target, {step}); }
  finally { reading = false; await reader; }
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), {step:20});
});
