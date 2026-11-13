import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import http from 'node:http';
import { tarball, sourceEntries } from './fixtures/update-archive.mjs';
import { appSources } from '../lib/app-sources.mjs';
import { prepareUpdate } from '../lib/update-install.mjs';
import { latestVersion, downloadArchive } from '../scripts/rescue-update.mjs';

// The rescue update (scripts/rescue-update.mjs) on a real installation of the application, with
// GitHub answered by the test: nothing is downloaded.
const project = fileURLToPath(new URL('../', import.meta.url));
const repository = 'palichleo/Local-AI-Chat-Vision-GGUF-WebUI';
const sha = '0123456789abcdef0123456789abcdef01234567';
const addresses = {
  commit: `https://api.github.com/repos/${repository}/commits/main`,
  version: `https://raw.githubusercontent.com/${repository}/${sha}/package.json`,
  archive: `https://codeload.github.com/${repository}/tar.gz/${sha}`,
};
const manifest = version =>
  JSON.stringify({ name: 'atelier-local', version, type: 'module', engines: { node: '>=22' } });
const launchers = ['Lancer-Windows.cmd', 'lancer-linux.sh', 'Mettre-a-jour-Windows.cmd', 'mettre-a-jour-linux.sh'];
// The person's own files: no update may touch them.
const personal = {
  'data/notes.txt': 'Private data',
  'history/keep.txt': 'Private history',
  'models/LLMs/model.gguf': 'Weights outside the sources',
  'output/image.png': 'A generated image',
};

async function until(check, label, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(typeof label === 'function' ? label() : label);
}
async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  return port;
}
async function boot(port) {
  try {
    return await (
      await fetch(`http://127.0.0.1:${port}/api/bootstrap?brief=1`, { signal: AbortSignal.timeout(1000) })
    ).json();
  } catch {
    return null;
  }
}
async function close(port) {
  const live = await boot(port);
  assert.equal(typeof live?.token, 'string', 'No application to close');
  const response = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${live.token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 202);
}
const ended = child => child.exitCode !== null || child.signalCode !== null;
function end(child) {
  if (ended(child)) return;
  if (process.platform === 'win32')
    spawnSync(
      join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'],
      { stdio: 'ignore', windowsHide: true },
    );
  else child.kill('SIGKILL');
}
function run(command, args, options, children) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...options });
  let output = '';
  for (const pipe of [child.stdout, child.stderr])
    pipe.on('data', data => {
      output = (output + data).slice(-8000);
    });
  child.stdin.end();
  children.push(child);
  return { child, output: () => output };
}
async function assertPersonal(root) {
  for (const [path, text] of Object.entries(personal)) assert.equal(await readFile(join(root, path), 'utf8'), text);
}
async function rescueOf(root) {
  // The copy installed in the folder, as the command runs it.
  return (await import(pathToFileURL(join(root, 'scripts/rescue-update.mjs')).href)).rescueUpdate;
}

/** The real application at 0.2.0 in a folder of its own, with the person's files beside it. */
async function installation(t, prefix = 'atelier-secours-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  for (const name of ['lib', 'public', 'scripts', ...launchers])
    await cp(join(project, name), join(root, name), { recursive: true });
  const original = await readFile(join(project, 'server.mjs'), 'utf8');
  // No version check towards GitHub from these servers.
  const server = original.replace(
    'updateChecker: ({ signal }) => checkForUpdates({ currentVersion: version, signal }),',
    'updateChecker: null,',
  );
  assert.notEqual(server, original);
  await writeFile(join(root, 'server.mjs'), server);
  await writeFile(join(root, 'package.json'), manifest('0.2.0'));
  for (const [path, text] of Object.entries(personal)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  const port = await freePort(),
    children = [];
  t.after(async () => {
    const live = await boot(port);
    if (typeof live?.token === 'string')
      await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${live.token}`, 'Content-Type': 'application/json' },
        body: '{}',
      }).catch(() => {});
    await Promise.race([
      Promise.all(children.filter(child => !ended(child)).map(child => once(child, 'exit'))),
      new Promise(resolve => setTimeout(resolve, 10000)),
    ]);
    for (const child of children) end(child);
    await until(async () => !(await boot(port)), 'A test application kept its port');
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  return { root, port, server, children };
}

async function tree(root, name) {
  const entries = [];
  async function collect(path, archived) {
    for (const entry of await readdir(path, { withFileTypes: true }))
      if (entry.isDirectory()) await collect(join(path, entry.name), `${archived}/${entry.name}`);
      else entries.push({ name: `repo/${archived}/${entry.name}`, text: await readFile(join(path, entry.name)) });
  }
  await collect(join(root, name), name);
  return entries;
}
/** The repository at 0.3.0: the sources of the folder, `server`, and a file the update brings. */
async function release(root, server, { replace = {} } = {}) {
  const entries = [];
  for (const name of ['lib', 'public', 'scripts']) entries.push(...(await tree(root, name)));
  for (const name of launchers)
    entries.push({ name: `repo/${name}`, text: replace[name] ?? (await readFile(join(root, name))) });
  entries.push(
    { name: 'repo/server.mjs', text: server },
    { name: 'repo/package.json', text: manifest('0.3.0') },
    { name: 'repo/lib/rescue-marker.mjs', text: 'export const delivered = true;\n' },
  );
  return tarball(entries);
}
function github(bytes, version) {
  const calls = [];
  return {
    calls,
    async fetchUpdate(url, options) {
      calls.push(url);
      assert.equal(options.redirect, 'error');
      if (url === addresses.commit) return new Response(sha);
      if (url === addresses.version) return new Response(manifest(version));
      if (url === addresses.archive) return new Response(bytes);
      throw new Error('Unexpected download: ' + url);
    },
  };
}

test(
  'the rescue closes the idle application, installs the published sources and starts them with their launcher',
  { timeout: 90000 },
  async t => {
    const { root, port, server, children } = await installation(t);
    const previous = run(
      process.execPath,
      [join(root, 'scripts/launch.mjs'), `--port=${port}`, '--no-open'],
      { cwd: root },
      children,
    );
    await until(
      async () => (await boot(port))?.controlled,
      () => 'The installed version did not start: ' + previous.output(),
    );
    const before = await boot(port);
    const { fetchUpdate, calls } = github(await release(root, server), '0.3.0');
    const messages = [];
    const result = await (
      await rescueOf(root)
    )({ root, port, open: false, fetchUpdate, log: message => messages.push(message), output: 'ignore' });
    children.push(result.launcher.child);
    assert.equal(result.status, 'updated', messages.join('\n'));
    assert.deepEqual([result.previousVersion, result.version], ['0.2.0', '0.3.0']);
    const after = await boot(port);
    assert.equal(after.version, '0.3.0');
    assert.equal(after.controlled, true);
    assert.notEqual(after.token, before.token);
    assert.ok(messages.includes('Fermeture de Moodix…'), messages.join('\n'));
    // The previous launcher window ends with its application, as after « Fermer l’application ».
    await until(async () => ended(previous.child), 'The previous launcher stayed open');
    assert.equal(previous.child.exitCode, 0, previous.output());
    assert.equal(await readFile(join(root, 'lib/rescue-marker.mjs'), 'utf8'), 'export const delivered = true;\n');
    assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version, '0.3.0');
    await assertPersonal(root);
    assert.deepEqual(calls, [addresses.commit, addresses.version, addresses.archive]);
    assert.deepEqual(await readdir(join(root, 'data/updates')), [], 'No backup or lock left behind');
    // Its launcher now holds the application: closing it from the page ends it, as in its own window.
    await close(port);
    assert.equal(await result.launcher.exited, 0);
  },
);

// A new version that cannot run: its server stops while loading (its launcher then gives up), or it
// holds the port without ever answering.
const broken = {
  'stops at startup': [
    "export function openBrowser() {}\nif (process.argv[1]?.endsWith('server.mjs')) process.exit(9);\n",
    /arrêtée au démarrage \(code [1-9]\d*\)/,
  ],
  'never answers': [
    `import http from 'node:http';
export function openBrowser() {}
if (process.argv[1]?.endsWith('server.mjs'))
  http.createServer(() => {}).listen(Number(process.argv.find(arg => arg.startsWith('--port=')).slice(7)), '127.0.0.1');
`,
    /pas répondu à temps/,
  ],
};
for (const [behaviour, [replacement, reason]] of Object.entries(broken))
  test(
    `a new version that ${behaviour} is stopped and undone, and the previous one started again`,
    { timeout: 90000 },
    async t => {
      const { root, port, server, children } = await installation(t);
      const { fetchUpdate } = github(await release(root, replacement), '0.3.0');
      const messages = [];
      const result = await (
        await rescueOf(root)
      )({
        root,
        port,
        open: false,
        fetchUpdate,
        log: message => messages.push(message),
        output: 'ignore',
        confirmTimeout: 5000,
      });
      children.push(result.launcher.child);
      assert.equal(result.status, 'rolled-back', messages.join('\n'));
      assert.match(result.error, reason);
      assert.equal(result.restarted, true, messages.join('\n'));
      const live = await boot(port);
      assert.equal(live.version, '0.2.0');
      assert.equal(live.controlled, true);
      assert.equal(await readFile(join(root, 'server.mjs'), 'utf8'), server);
      assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version, '0.2.0');
      await assert.rejects(readFile(join(root, 'lib/rescue-marker.mjs')), { code: 'ENOENT' });
      await assertPersonal(root);
      assert.deepEqual(await readdir(join(root, 'data/updates')), []);
      await close(port);
      assert.equal(await result.launcher.exited, 0);
    },
  );

test(
  'an application busy working, opened from another folder, or another program is never closed, and nothing changes',
  { timeout: 60000 },
  async t => {
    const { root, port, server } = await installation(t);
    // The identity of lib/app-sources.mjs, which the rescue computes on its own.
    const { installationId } = await appSources(root);
    const rescueUpdate = await rescueOf(root),
      bytes = await release(root, server);
    const running = {
      application: 'atelier-local',
      token: 'running-token',
      installationId,
      sourceRevision: 'running',
      version: '0.2.0',
      controlled: true,
      status: { state: 'ready', busy: false },
    };
    for (const [occupant, answer, told] of [
      ['busy working', { ...running, status: { state: 'ready', busy: true } }, /en train de travailler/],
      ['opened from another folder', { ...running, installationId: 'another-folder' }, /autre dossier/],
      ['another program', { application: 'something-else' }, /autre programme/],
    ])
      await t.test(occupant, async () => {
        let closings = 0;
        const listener = http.createServer((req, res) => {
          if (req.url.startsWith('/api/shutdown')) closings++;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(answer));
        });
        await new Promise(resolve => listener.listen(port, '127.0.0.1', resolve));
        try {
          const messages = [];
          await assert.rejects(
            rescueUpdate({
              root,
              port,
              open: false,
              fetchUpdate: github(bytes, '0.3.0').fetchUpdate,
              log: message => messages.push(message),
              output: 'ignore',
              closeTimeout: 1500,
            }),
            /n’a pas pu commencer.*Rien n’a été modifié/,
          );
          // Said once, not at every look at the port.
          assert.equal(messages.filter(message => told.test(message)).length, 1, messages.join('\n'));
          assert.equal(closings, 0);
        } finally {
          listener.closeAllConnections();
          await new Promise(resolve => listener.close(resolve));
        }
        assert.equal(await readFile(join(root, 'server.mjs'), 'utf8'), server);
        assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version, '0.2.0');
        await assert.rejects(readFile(join(root, 'lib/rescue-marker.mjs')), { code: 'ENOENT' });
        assert.deepEqual(await readdir(join(root, 'data/updates')), []);
      });
  },
);

test('an installation already up to date downloads no archive and is simply opened', async t => {
  const root = await mkdtemp(join(tmpdir(), 'atelier-secours-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  await cp(join(project, 'lib'), join(root, 'lib'), { recursive: true });
  await mkdir(join(root, 'scripts'));
  await cp(join(project, 'scripts/rescue-update.mjs'), join(root, 'scripts/rescue-update.mjs'));
  // A launcher that only says how it was started.
  await writeFile(
    join(root, 'scripts/launch.mjs'),
    "import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('../launched.json', import.meta.url), JSON.stringify(process.argv.slice(2)));\n",
  );
  await writeFile(join(root, 'package.json'), manifest('0.3.0'));
  const port = await freePort(),
    rescueUpdate = await rescueOf(root);
  // Never an older version over a newer one, even when asked to install again.
  for (const [published, reinstall, said] of [
    ['0.3.0', false, /déjà à jour/],
    ['0.2.9', true, /plus récente/],
  ]) {
    const { fetchUpdate, calls } = github(Buffer.alloc(0), published),
      messages = [];
    const result = await rescueUpdate({
      root,
      port,
      open: false,
      reinstall,
      fetchUpdate,
      log: message => messages.push(message),
      output: 'ignore',
    });
    assert.equal(result.status, 'current');
    assert.equal(await result.launcher.exited, 0);
    assert.ok(
      messages.some(message => said.test(message)),
      messages.join('\n'),
    );
    assert.deepEqual(calls, [addresses.commit, addresses.version]);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'launched.json'), 'utf8')), ['--no-open', `--port=${port}`]);
    await rm(join(root, 'launched.json'));
  }
  assert.deepEqual(await readdir(join(root, 'data/updates')), []);
});

test('the rescue asks GitHub what the update button asks, within the same limits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'atelier-secours-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  for (const file of ['lib/update-files.mjs', 'lib/update-archive.mjs', 'scripts/apply-update.mjs']) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await cp(join(project, file), join(root, file));
  }
  const bytes = tarball(sourceEntries);
  const published = url =>
    new Response(url === addresses.commit ? sha : url === addresses.version ? manifest('0.3.0') : bytes);
  const recorder =
    (calls, answer = published) =>
    async (url, options) => {
      const { signal, ...request } = options;
      calls.push({ url, ...request });
      return answer(url);
    };
  const button = [],
    rescue = [];
  await prepareUpdate({ root, version: '0.3.0', currentVersion: '0.2.0', port: 8787, fetchUpdate: recorder(button) });
  assert.deepEqual(await latestVersion({ fetchUpdate: recorder(rescue) }), { sha, version: '0.3.0' });
  assert.deepEqual(await downloadArchive(sha, { fetchUpdate: recorder(rescue) }), bytes);
  // The same commit, then the same archive, asked the same way; the version is read at that commit.
  assert.equal(button.length, 2);
  assert.deepEqual([rescue[0], rescue[2]], button);
  assert.equal(rescue[1].url, addresses.version);
  // The same size limits: 128 bytes for the commit, 20 MiB for the archive.
  for (const [limit, address] of [
    [128, addresses.commit],
    [20 * 1024 * 1024, addresses.archive],
  ])
    for (const size of [limit, limit + 1]) {
      const answer = url =>
        url === address ? new Response('x', { headers: { 'content-length': String(size) } }) : published(url);
      const outcome = promise =>
        promise.then(
          () => 'accepted',
          error => (/refusé/.test(error.message) ? 'refused' : 'accepted'),
        );
      const expected = size > limit ? 'refused' : 'accepted';
      assert.equal(
        await outcome(
          prepareUpdate({
            root,
            version: '0.3.0',
            currentVersion: '0.2.0',
            port: 8787,
            fetchUpdate: recorder([], answer),
          }),
        ),
        expected,
      );
      assert.equal(
        await outcome(
          address === addresses.commit
            ? latestVersion({ fetchUpdate: recorder([], answer) })
            : downloadArchive(sha, { fetchUpdate: recorder([], answer) }),
        ),
        expected,
      );
    }
});

test(
  'the update command of the folder installs the published version, although the update replaces it',
  { timeout: 90000 },
  async t => {
    const { root, port, server, children } = await installation(t, 'atelier-secours été (test) & espaces-');
    // What the window would run if it read its command file again after node: here only « exit 7 ».
    const replace = {
      'Mettre-a-jour-Windows.cmd': 'exit /b 7\r\n'.repeat(200),
      'mettre-a-jour-linux.sh': 'exit 7\n'.repeat(200),
    };
    await writeFile(join(root, 'test-release.tar.gz'), await release(root, server, { replace }));
    await writeFile(
      join(root, 'test-github.json'),
      JSON.stringify({ sha, packageJson: manifest('0.3.0'), archive: join(root, 'test-release.tar.gz') }),
    );
    const options = {
      cwd: root,
      env: {
        ...process.env,
        NODE_OPTIONS: `--import=${pathToFileURL(join(project, 'tests/fixtures/rescue-github.mjs')).href}`,
        ATELIER_TEST_GITHUB: join(root, 'test-github.json'),
      },
    };
    const name = process.platform === 'win32' ? 'Mettre-a-jour-Windows.cmd' : 'mettre-a-jour-linux.sh';
    const command =
      process.platform === 'win32'
        ? run(
            process.env.ComSpec || 'cmd.exe',
            ['/d', '/s', '/c', `""${join(root, name)}" --port=${port} --no-open"`],
            { ...options, windowsVerbatimArguments: true },
            children,
          )
        : run('sh', [join(root, name), `--port=${port}`, '--no-open'], options, children);
    await until(
      async () => /Mise à jour terminée/.test(command.output()),
      () => 'The update command did not finish: ' + command.output(),
      60000,
    );
    const live = await boot(port);
    assert.equal(live.version, '0.3.0');
    assert.equal(live.controlled, true);
    assert.equal(ended(command.child), false, 'The window holds the application');
    await close(port);
    await until(
      async () => ended(command.child),
      () => 'The update window stayed open: ' + command.output(),
    );
    assert.equal(command.child.exitCode, 0, command.output());
    assert.equal(await readFile(join(root, name), 'utf8'), replace[name]);
    await assertPersonal(root);
  },
);
