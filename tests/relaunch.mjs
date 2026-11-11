import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication, startLauncher } from '../server.mjs';

test('the application relaunches itself only when its files changed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relaunch-'));
  const started = [];
  let revision = null;
  const app = await createApplication({
    port: 0,
    dataDir: root,
    launcher: target => started.push(target),
    // The files as they are now: the same as at launch, until the test says otherwise.
    currentSources: async () => ({ sourceRevision: revision ?? (await boot()).sourceRevision }),
  });
  const boot = async () => (await fetch(app.url + '/api/bootstrap')).json();
  try {
    const { token } = await boot();
    const relaunch = headers =>
      fetch(app.url + '/api/relaunch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: '{}',
      });
    // Like every action of the application: not without its token.
    assert.equal((await relaunch({})).status, 401);
    const same = await relaunch({ Authorization: 'Bearer ' + token });
    assert.equal(same.status, 409);
    assert.match((await same.json()).error, /n’ont pas changé/);
    assert.deepEqual(started, []);

    revision = 'f'.repeat(64);
    const changed = await relaunch({ Authorization: 'Bearer ' + token });
    assert.equal(changed.status, 202);
    assert.deepEqual(await changed.json(), { relaunching: true });
    assert.equal(started.length, 1);
    assert.equal(started[0].port, Number(new URL(app.url).port));
    // The instance itself goes on: the launcher is the one that stops it, once it is idle.
    assert.equal((await boot()).token, token);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the launcher is started in its own window on Windows, in the background elsewhere', () => {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    return { once() {}, unref() {} };
  };
  startLauncher({ root: 'F:\\Atelier', port: 8787 }, { platform: 'win32', spawnProcess });
  startLauncher({ root: '/opt/atelier', port: 9000 }, { platform: 'linux', spawnProcess });
  const [windows, linux] = calls;
  assert.equal(windows.command, 'cmd.exe');
  assert.deepEqual(windows.args.slice(0, 5), ['/c', 'start', 'Atelier local', '/D', 'F:\\Atelier']);
  assert.equal(windows.args[5], process.execPath);
  assert.match(windows.args[6], /scripts.launch\.mjs$/);
  assert.deepEqual(windows.args.slice(-2), ['--port=8787', '--wait-idle']);
  assert.equal(linux.command, process.execPath);
  assert.deepEqual(linux.args.slice(-2), ['--port=9000', '--wait-idle']);
  for (const { options } of calls) assert.deepEqual([options.detached, options.stdio], [true, 'ignore']);
});
