import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { REPOSITORY, REPOSITORY_ID, checkForUpdates, githubFetch, newerVersion } from '../lib/updates.mjs';
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
        'https://raw.githubusercontent.com/palichleo/Moodix-AI/main/package.json',
      );
      assert.equal(options.body, undefined);
      assert.equal(options.redirect, 'manual');
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
    assert.doesNotMatch(html, /id="update-available"/, 'updates live in the settings, not in the sidebar');
    // Six tabs (parametres-maquette.md): Moodix AI first, Mise à jour last.
    assert.match(html, /id="settings-tab-ai"[^>]*aria-selected="true"/, 'Moodix AI comes first');
    assert.ok(html.indexOf('data-settings-tab="application"') < html.indexOf('data-settings-tab="update"'));
    assert.match(html, /id="settings-update-install"[^>]+hidden/, 'install shows once an update is found');
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

test('a redirect is followed between the hosts of GitHub only, twice at most', async () => {
  // 17/11: the repository renamed, GitHub answered the request that pins the commit by a redirect;
  // refused like any other, it stopped every update of every copy installed.
  const moved = (location, status = 301) => new Response(null, { status, headers: { location } });
  const asked = [];
  const github = answers => async (url, options) => {
    asked.push(url);
    assert.equal(options.redirect, 'manual', 'never followed by fetch itself');
    return answers[url] ?? new Response('not found', { status: 404 });
  };
  const start = 'https://api.github.com/repos/someone/old-name/commits/main';
  // The same repository under its number, then its archive on another host of GitHub.
  const followed = await githubFetch(
    github({
      [start]: moved('https://api.github.com/repositories/1/commits/main'),
      'https://api.github.com/repositories/1/commits/main': moved('/repositories/1/commits/abc', 302),
      'https://api.github.com/repositories/1/commits/abc': new Response('abc'),
    }),
    start,
    { headers: { Accept: 'text/plain' } },
  );
  assert.equal(await followed.text(), 'abc');
  assert.equal(asked.length, 3);
  // Anywhere else, in clear, or once too many: refused, and nothing more is asked.
  const refused = {
    'another host': moved('https://example.com/main'),
    'a host that looks like one': moved('https://api.github.com.example.com/main'),
    'in clear': moved('http://api.github.com/repositories/1/commits/main'),
    'no address': new Response(null, { status: 302 }),
  };
  for (const [name, answer] of Object.entries(refused)) {
    asked.length = 0;
    await assert.rejects(githubFetch(github({ [start]: answer }), start, {}), /Redirection de la mise à jour refusée/, name);
    assert.equal(asked.length, 1, name);
  }
  asked.length = 0;
  const loop = github({ [start]: moved(start) });
  await assert.rejects(githubFetch(loop, start, {}), /Redirection de la mise à jour refusée/);
  assert.equal(asked.length, 3);
  // A check of the version that meets a refused redirect says nothing is available, as for any failure.
  const none = await checkForUpdates({ currentVersion: '0.2.0', fetchVersion: github({}) });
  assert.deepEqual(none, { available: false });
  const elsewhere = await checkForUpdates({
    currentVersion: '0.2.0',
    fetchVersion: async () => moved('https://example.com/package.json'),
  });
  assert.deepEqual(elsewhere, { available: false });
  // And one moved inside GitHub is read.
  const read = await checkForUpdates({
    currentVersion: '0.2.0',
    fetchVersion: async url =>
      url.includes('/Moodix-AI/')
        ? moved('https://raw.githubusercontent.com/palichleo/another-name/main/package.json')
        : Response.json({ name: 'atelier-local', version: '0.2.1' }),
  });
  assert.deepEqual(read, { available: true, version: '0.2.1' });
});

test('the commit to install is asked by the number of the repository, which no renaming changes', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8');
  const [install, rescue] = await Promise.all([read('lib/update-install.mjs'), read('scripts/rescue-update.mjs')]);
  assert.equal(REPOSITORY_ID, 1449534927);
  assert.equal(REPOSITORY, 'palichleo/Moodix-AI');
  assert.match(install, /`https:\/\/api\.github\.com\/repositories\/\$\{REPOSITORY_ID\}\/commits\/main`/);
  // The rescue update is written apart (a broken installer must not break it): the same repository.
  assert.match(rescue, /const repository = 'palichleo\/Moodix-AI';\r?\nconst repositoryId = 1449534927;/);
  assert.match(rescue, /`https:\/\/api\.github\.com\/repositories\/\$\{repositoryId\}\/commits\/main`/);
  for (const source of [install, rescue]) {
    assert.doesNotMatch(source, /api\.github\.com\/repos\//, 'no request by the name where the number is taken');
    assert.doesNotMatch(source, /redirect: 'error'|redirect: 'follow'/);
  }
});
