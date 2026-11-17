import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readUpdateArchive } from '../lib/update-archive.mjs';
import { readUpdateArchive as installedCheck } from './fixtures/update-archive-0.6.30.mjs';
import { refusals } from '../scripts/check-update.mjs';
import { tarball } from './fixtures/update-archive.mjs';

// An update is checked by the code of the version INSTALLED. What this repository publishes must
// therefore pass the check of the copies in the field (kept as it was in 0.6.30), or nobody can
// update any more: in 0.6.38 a library declared in « dependencies » did exactly that.
const root = fileURLToPath(new URL('..', import.meta.url));
const real = async name => readFile(new URL('../' + name, import.meta.url), 'utf8');
const sources = info => [
  { name: 'moodix/package.json', text: JSON.stringify(info) },
  { name: 'moodix/server.mjs', text: 'export {};' },
  { name: 'moodix/public/index.html', text: '<!doctype html>' },
];

test('the package.json of this repository is taken by the copies already installed', async () => {
  const info = JSON.parse(await real('package.json'));
  assert.deepEqual(Object.keys(info.dependencies ?? {}), [], 'no « dependencies »: an optional library goes in optionalDependencies');
  assert.equal(info.name, 'atelier-local');
  assert.equal(info.type, 'module');
  const archive = tarball(sources(info));
  // The check they run, and the one of this version.
  for (const check of [installedCheck, readUpdateArchive]) {
    const files = check(archive, { newerThan: '0.6.30' });
    assert.equal(JSON.parse(files.get('package.json')).version, info.version);
  }
  assert.deepEqual(refusals(archive, info), []);
  // The library of Claude is still declared, where the installer of the settings reads it.
  assert.equal(info.optionalDependencies?.['@anthropic-ai/sdk'], JSON.parse(await real('package-lock.json')).packages['node_modules/@anthropic-ai/sdk'].version);
});

test('a « dependency » added to package.json is refused by name before it is published', async () => {
  const info = { ...JSON.parse(await real('package.json')), dependencies: { 'left-pad': '1.0.0' } },
    archive = tarball(sources(info));
  // What the copies installed answer, and nothing more.
  assert.throws(() => installedCheck(archive, { newerThan: '0.6.30' }), /Archive de mise à jour invalide/);
  const reasons = refusals(archive, info);
  assert.match(reasons[0], /« dependencies » \(left-pad\).*optionalDependencies/);
  assert.equal(reasons.some(reason => reason.includes('versions installées (0.6.30)')), true);
});

test('the whole repository passes the check run before each commit', t => {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, encoding: 'utf8' });
  } catch {
    return t.skip('not a git checkout');
  }
  // The script as the hook runs it: every file about to be committed (the index: the last commit
  // when nothing is staged), packed as GitHub packs it.
  const said = execFileSync(process.execPath, ['scripts/check-update.mjs'], { cwd: root, encoding: 'utf8' });
  assert.match(said, /est installable par les versions déjà installées/);
});
