import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { newerVersion, checkForUpdates } from '../lib/updates.mjs';
import { createApplication } from '../server.mjs';

test('stable versions compare numerically and ignore older, equal, preview or malformed versions', () => {
  for (const next of ['0.2.1', '0.10.0', '1.0.0']) assert.equal(newerVersion(next, '0.2.0'), true);
  for (const next of [
    '0.2.0',
    '0.1.99',
    '0.3.0-beta.1',
    'v0.3.0',
    '0.03.0',
    '999999999999999999999.0.0',
    null,
    '<img>',
  ])
    assert.equal(newerVersion(next, '0.2.0'), false);
  assert.equal(newerVersion('1.0.0', 'invalid'), false);
  assert.equal(newerVersion('0.2.9', '0.2.10'), false);
});

test('update check reads only fixed public metadata, never sends local data or installs anything', async () => {
  let calls = 0;
  const result = await checkForUpdates({
    currentVersion: '0.2.0',
    fetchVersion: async (url, options) => {
      calls++;
      assert.equal(
        url,
        'https://raw.githubusercontent.com/palichleo/Local-AI-Chat-Vision-GGUF-WebUI/main/package.json',
      );
      assert.equal(options.body, undefined);
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.headers.Cookie, undefined);
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({ name: 'atelier-local', version: '0.2.1', extra: 'ignored' });
    },
  });
  assert.deepEqual(result, { available: true, version: '0.2.1' });
  assert.equal(calls, 1);
});

test('offline, invalid, oversized and unavailable metadata stay silent', async () => {
  const factories = [
    () => {
      throw new Error('offline');
    },
    () => new Response('Unavailable', { status: 503 }),
    () => new Response('not json'),
    () => Response.json({ name: 'another-app', version: '9.0.0' }),
    () => Response.json({ name: 'atelier-local', version: '0.2.0' }),
    () => Response.json({ name: 'atelier-local', version: '0.1.0' }),
    () => Response.json({ name: 'atelier-local', version: '1.0.0-beta.1' }),
    () => new Response('x'.repeat(32769)),
    () => new Response('{}', { headers: { 'content-length': '32769' } }),
  ];
  for (const factory of factories)
    assert.deepEqual(await checkForUpdates({ currentVersion: '0.2.0', fetchVersion: async () => factory() }), {
      available: false,
    });
  let cancelled = false;
  const stream = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  await checkForUpdates({
    currentVersion: '0.2.0',
    fetchVersion: async () => new Response(stream, { headers: { 'content-length': '40000' } }),
  });
  assert.equal(cancelled, true);
});

test('closing aborts an in-flight check without surfacing a network error', async () => {
  const controller = new AbortController();
  const pending = checkForUpdates({
    currentVersion: '0.2.0',
    signal: controller.signal,
    fetchVersion: async (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  });
  controller.abort();
  assert.deepEqual(await pending, { available: false });
});

test('background check never blocks startup or chat status and repeated reads reuse the same result', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'atelier-updates-'));
  let app,
    release,
    calls = 0;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  try {
    app = await createApplication({
      port: 0,
      dataDir: folder,
      updateChecker: async () => {
        calls++;
        return gate;
      },
    });
    const bootstrap = await (await fetch(app.url + '/api/bootstrap')).json();
    const headers = { Authorization: `Bearer ${bootstrap.token}` };
    assert.equal((await fetch(app.url + '/api/status', { headers })).status, 200);
    assert.equal((await fetch(app.url + '/api/updates')).status, 401);
    const first = fetch(app.url + '/api/updates', { headers }),
      second = fetch(app.url + '/api/updates', { headers });
    release({ available: true, version: '0.2.1' });
    for (const pending of [first, second])
      assert.deepEqual(await (await pending).json(), { available: true, version: '0.2.1' });
    assert.equal(calls, 1);
    const html = await (await fetch(app.url)).text();
    assert.ok(html.indexOf('id="settings-open"') < html.indexOf('id="update-available"'));
    assert.doesNotMatch(html, /id="update-available"[^>]+hidden/, 'the update button is always shown');
    assert.ok(html.indexOf('id="toggle-engine"') < html.indexOf('id="settings-open"'), 'start/stop sits left of the settings');
    assert.doesNotMatch(html, /id="model-select"|id="model-card"/, 'the LLM is chosen in the settings only');
  } finally {
    release({ available: false });
    await app?.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('failed background checks are cached silently and app closure cancels pending work', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'atelier-updates-'));
  let app,
    cancelled = false;
  try {
    app = await createApplication({
      port: 0,
      dataDir: folder,
      updateChecker: async () => {
        throw new Error('offline');
      },
    });
    let bootstrap = await (await fetch(app.url + '/api/bootstrap')).json();
    assert.deepEqual(
      await (await fetch(app.url + '/api/updates', { headers: { Authorization: `Bearer ${bootstrap.token}` } })).json(),
      { available: false },
    );
    await app.close();
    app = null;
    app = await createApplication({
      port: 0,
      dataDir: folder,
      updateChecker: ({ signal }) =>
        new Promise(resolve => {
          signal.addEventListener(
            'abort',
            () => {
              cancelled = true;
              resolve({ available: false });
            },
            { once: true },
          );
        }),
    });
    await app.close();
    app = null;
    assert.equal(cancelled, true);
  } finally {
    await app?.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('the update button checks again on demand, and a failed check keeps a known update', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'atelier-updates-'));
  const answers = [{ available: false }, { available: true, version: '9.0.0' }, null];
  let app;
  try {
    app = await createApplication({
      port: 0,
      dataDir: folder,
      updateChecker: async () => {
        const answer = answers.shift();
        if (!answer) throw new Error('offline');
        return answer;
      },
    });
    const { token } = await (await fetch(app.url + '/api/bootstrap')).json();
    const read = async (refresh = false) =>
      (
        await fetch(app.url + '/api/updates' + (refresh ? '?refresh=1' : ''), {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json();
    assert.deepEqual(await read(), { available: false }, 'launch check');
    assert.deepEqual(await read(), { available: false }, 'a plain read reuses it');
    assert.deepEqual(await read(true), { available: true, version: '9.0.0' }, 'the button checks again');
    assert.deepEqual(await read(true), { available: true, version: '9.0.0' }, 'offline keeps the known update');
    assert.deepEqual(await read(), { available: true, version: '9.0.0' });
  } finally {
    await app?.close();
    await rm(folder, { recursive: true, force: true });
  }
});
