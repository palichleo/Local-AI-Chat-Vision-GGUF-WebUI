import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../server.mjs';
import { prepareUpdate, launchInstaller } from '../lib/update-install.mjs';
import { tarball } from './fixtures/update-archive.mjs';
const project = fileURLToPath(new URL('../', import.meta.url));

test('complete HTTP install restarts the real app and restores a private session without changing local configuration', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'atelier-e2e-'));
  let app, pid;
  try {
    for (const name of ['lib', 'public', 'scripts']) await cp(join(project, name), join(root, name), { recursive: true });
    await cp(join(project, 'server.mjs'), join(root, 'server.mjs'));
    await writeFile(join(root, 'package.json'), '{"name":"atelier-local","version":"0.2.0","type":"module","engines":{"node":">=22"}}');
    await mkdir(join(root, 'history')); await writeFile(join(root, 'history/keep.txt'), 'Private history');
    await writeFile(join(root, 'model.gguf'), 'Model outside managed sources');
    const entries = [];
    async function collect(directory, prefix) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name), name = prefix + '/' + entry.name;
        if (entry.isDirectory()) await collect(path, name); else entries.push({ name: 'repo/' + name, text: await readFile(path) });
      }
    }
    await collect(join(root, 'lib'), 'lib'); await collect(join(root, 'public'), 'public'); await collect(join(root, 'scripts'), 'scripts');
    // Only external version checks are disabled in this fixture; the HTTP server and installer are real.
    const server = (await readFile(join(root, 'server.mjs'), 'utf8')).replace('updateChecker: ({ signal }) => checkForUpdates({ currentVersion: version, signal }),', 'updateChecker: null,');
    entries.push({ name: 'repo/server.mjs', text: server }, { name: 'repo/package.json', text: '{"name":"atelier-local","version":"0.3.0","type":"module","engines":{"node":">=22"}}' });
    const bytes = tarball(entries), sha = '1'.repeat(40);
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(join(root, 'data/preferences.json'), JSON.stringify({ theme: 'dark', saveHistory: false }));
    app = await createApplication({ port: 0, dataDir: join(root, 'data'), historyDir: join(root, 'history'),
      updateChecker: async () => ({ available: true, version: '0.3.0' }),
      updateInstaller: { prepare: args => prepareUpdate({ ...args, root, currentVersion: '0.2.0', fetchUpdate: async url => new Response(url.includes('/commits/') ? sha : bytes) }), launch: launchInstaller },
    });
    const bootstrap = await (await fetch(app.url + '/api/bootstrap')).json();
    const session = { messages: [{ role: 'user', content: 'Keep my chat' }, { role: 'assistant', content: '**My reply**' }], conversationId: 'a1111111-1111-4111-8111-111111111111', prompt: 'Keep my draft', images: [], thinking: true, title: 'Private session' };
    const response = await fetch(app.url + '/api/updates/install', { method: 'POST', headers: { Authorization: `Bearer ${bootstrap.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ session }) });
    assert.equal(response.status, 202);
    let result; const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try { result = JSON.parse(await readFile(join(root, 'data/update-status.json'), 'utf8')); if (['done', 'rolled-back', 'error'].includes(result.state)) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    pid = result?.pid;
    assert.equal(result.state, 'done', JSON.stringify(result));
    const next = await (await fetch(app.url + '/api/bootstrap')).json();
    assert.equal(next.version, '0.3.0'); assert.notEqual(next.token, bootstrap.token);
    const saved = await (await fetch(app.url + '/api/updates/session', { headers: { Authorization: `Bearer ${next.token}` } })).json();
    assert.equal(saved.prompt, 'Keep my draft'); assert.deepEqual(saved.messages, session.messages);
    assert.equal(next.preferences.saveHistory, false);
    assert.equal(await readFile(join(root, 'history/keep.txt'), 'utf8'), 'Private history');
    assert.equal(await readFile(join(root, 'model.gguf'), 'utf8'), 'Model outside managed sources');
    assert.equal((await fetch(app.url + '/update-ui.mjs')).status, 200);
  } finally {
    if (pid) try { process.kill(pid); } catch {}
    await app?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
