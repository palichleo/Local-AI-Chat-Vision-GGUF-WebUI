import { fileURLToPath } from 'node:url';
const project = fileURLToPath(new URL('../', import.meta.url));
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tarball, sourceEntries } from './fixtures/update-archive.mjs';
import * as module from '../lib/update-install.mjs';
const sha = '1234567890abcdef1234567890abcdef12345678';

test('preparation pins the download to a commit and stages sources without replacing the running app', async t => {
  assert.equal(typeof module.prepareUpdate, 'function');
  const root = await mkdtemp(join(tmpdir(), 'atelier-prepare-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'lib'));
  await mkdir(join(root, 'scripts'));
  await cp(project + '/lib/update-files.mjs', join(root, 'lib/update-files.mjs'));
  await cp(project + '/lib/update-archive.mjs', join(root, 'lib/update-archive.mjs'));
  await cp(project + '/scripts/apply-update.mjs', join(root, 'scripts/apply-update.mjs'));
  await writeFile(join(root, 'server.mjs'), 'old server');
  await mkdir(join(root, 'runner'));
  await writeFile(join(root, 'runner/pyproject.toml'), 'old requirements');
  await writeFile(join(root, 'runner/uv.lock'), 'old lock');
  const urls = [];
  const plan = await module.prepareUpdate({
    root,
    version: '0.3.0',
    currentVersion: '0.2.0',
    port: 8787,
    fetchUpdate: async (url, options) => {
      urls.push(url);
      assert.equal(options.redirect, 'error');
      assert.equal(options.body, undefined);
      return urls.length === 1
        ? new Response(sha)
        : new Response(
            tarball([
              ...sourceEntries,
              { name: 'repo/runner/pyproject.toml', text: 'new requirements' },
              { name: 'repo/runner/uv.lock', text: 'new lock' },
            ]),
          );
    },
  });
  assert.deepEqual(urls, [
    'https://api.github.com/repos/palichleo/Local-AI-Chat-Vision-GGUF-WebUI/commits/main',
    `https://codeload.github.com/palichleo/Local-AI-Chat-Vision-GGUF-WebUI/tar.gz/${sha}`,
  ]);
  assert.equal(await readFile(join(root, 'server.mjs'), 'utf8'), 'old server');
  assert.equal(await readFile(join(root, 'runner/pyproject.toml'), 'utf8'), 'old requirements');
  assert.equal(await readFile(join(root, 'runner/uv.lock'), 'utf8'), 'old lock');
  assert.equal(await readFile(join(plan.workspace, 'stage/runner/pyproject.toml'), 'utf8'), 'new requirements');
  assert.equal(await readFile(join(plan.workspace, 'stage/runner/uv.lock'), 'utf8'), 'new lock');
  assert.equal(await readFile(join(plan.workspace, 'stage/server.mjs'), 'utf8'), 'export const version="0.3.0";');
  assert.equal(JSON.parse(await readFile(join(plan.workspace, 'plan.json'), 'utf8')).version, '0.3.0');
  assert.ok(plan.workspace.startsWith(join(root, 'data/updates')));
});

test('invalid commit metadata or obsolete versions never stage or install sources', async t => {
  assert.equal(typeof module.prepareUpdate, 'function');
  const root = await mkdtemp(join(tmpdir(), 'atelier-prepare-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const commit of ['../escape', 'https://attacker.test', 'z'.repeat(40), ''])
    await assert.rejects(
      module.prepareUpdate({
        root,
        version: '0.3.0',
        currentVersion: '0.2.0',
        port: 8787,
        fetchUpdate: async () => new Response(commit),
      }),
    );
  await assert.rejects(
    module.prepareUpdate({
      root,
      version: '0.1.0',
      currentVersion: '0.2.0',
      port: 8787,
      fetchUpdate: async () => {
        assert.fail('Must not download an obsolete version');
      },
    }),
  );
  assert.deepEqual(await readdir(root), []);
});
