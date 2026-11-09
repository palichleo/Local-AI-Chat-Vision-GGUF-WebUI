import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createApplication } from '../server.mjs';

test('the served page can load its entire JavaScript module graph', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-frontend-'));
  assert.equal(dirname(directory), tmpdir());
  const app = await createApplication({ port: 0, dataDir: directory });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const page = await fetch(app.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  const modules = [...html.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/g)].map(
    match => new URL(match[1], app.url),
  );
  assert.ok(modules.length, 'The page must load the application module');
  const visited = new Set();
  while (modules.length) {
    const url = modules.pop();
    if (visited.has(url.href)) continue;
    visited.add(url.href);
    assert.equal(url.origin, app.url, 'UI modules must stay local');
    const response = await fetch(url);
    assert.equal(response.status, 200, 'Missing browser module: ' + url.pathname);
    assert.match(response.headers.get('content-type'), /^text\/javascript/, 'Invalid MIME type: ' + url.pathname);
    const source = await response.text();
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[^'";\n]*?\s+from\s*)?['"]([^'"]+)['"]/g)) {
      assert.match(match[1], /^\.\.?\//, 'Unexpected external browser dependency');
      modules.push(new URL(match[1], url));
    }
  }
  for (const module of ['/copy.mjs', '/settings-guard.mjs', '/context-meter.mjs'])
    assert.ok(visited.has(app.url + module), 'The graph must exercise ' + module);
  assert.equal((await fetch(app.url + '/server.mjs')).status, 404, 'Backend sources must stay private');
});

test('a running server serves a consistent frontend snapshot even when files on disk change', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-snapshot-')),
    publicDir = join(directory, 'public');
  await cp(new URL('../public/', import.meta.url), publicDir, { recursive: true });
  const appSource = 'export const snapshot="initial frontend";';
  await writeFile(join(publicDir, 'app.js'), appSource);
  const app = await createApplication({ port: 0, dataDir: join(directory, 'data'), publicDir });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(await (await fetch(app.url + '/app.js')).text(), appSource);
  const html = await (await fetch(app.url)).text();
  await writeFile(join(publicDir, 'app.js'), 'import "./future-not-registered.mjs";');
  await writeFile(join(publicDir, 'index.html'), '<h1>Future release</h1>');
  await rm(join(publicDir, 'settings-search.mjs'));
  assert.equal(
    await (await fetch(app.url + '/app.js')).text(),
    appSource,
    'Old backend must never serve newly edited scripts',
  );
  assert.equal(await (await fetch(app.url)).text(), html, 'The HTML must match the backend lifetime');
  assert.equal(
    (await fetch(app.url + '/settings-search.mjs')).status,
    200,
    'A running snapshot retains its imported modules',
  );
});
