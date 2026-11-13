import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readUpdateArchive } from '../lib/update-archive.mjs';
import { plainFolder, replaceSources, restoreSources } from '../lib/update-files.mjs';
import { newerVersion } from '../lib/updates.mjs';

// The rescue update: the latest `main` installed from the folder itself, for when the update button
// cannot do it (a broken page, server or installer). Nothing of the installed page or server runs:
// only this file, lib/update-archive.mjs, lib/update-files.mjs and lib/updates.mjs, then the launcher
// of the NEW version. Started by Mettre-a-jour-Windows.cmd, mettre-a-jour-linux.sh or
// `node scripts/rescue-update.mjs` (--port=8787, --no-open, --reinstall).

const repository = 'palichleo/Local-AI-Chat-Vision-GGUF-WebUI';
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const never = new AbortController().signal;

// The requests of prepareUpdate (lib/update-install.mjs): same addresses, headers and size limits
// (tests/rescue-update.mjs compares them). Written again here so that a broken installer cannot
// break this one too.
async function download(url, limit, signal, fetchUpdate, accept = 'application/octet-stream') {
  const response = await fetchUpdate(url, {
    redirect: 'error',
    signal,
    headers: { Accept: accept, 'User-Agent': 'AtelierLocal-updater' },
  });
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error(`Téléchargement de la mise à jour refusé (HTTP ${response.status}).`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('La mise à jour dépasse la taille autorisée.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** The commit `main` points to, and the version it carries (read at that commit, like the archive). */
export async function latestVersion({ fetchUpdate = fetch, signal = never } = {}) {
  const sha = (
    await download(
      `https://api.github.com/repos/${repository}/commits/main`,
      128,
      signal,
      fetchUpdate,
      'application/vnd.github.sha',
    )
  )
    .toString('utf8')
    .trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Révision GitHub invalide.');
  const text = (
    await download(
      `https://raw.githubusercontent.com/${repository}/${sha}/package.json`,
      32768,
      signal,
      fetchUpdate,
      'application/json',
    )
  ).toString('utf8');
  let info;
  try {
    info = JSON.parse(text);
  } catch {}
  if (info?.name !== 'atelier-local' || !stableVersion.test(info.version))
    throw new Error('Version publiée illisible.');
  return { sha, version: info.version };
}

export function downloadArchive(sha, { fetchUpdate = fetch, signal = never } = {}) {
  return download(`https://codeload.github.com/${repository}/tar.gz/${sha}`, 20 * 1024 * 1024, signal, fetchUpdate);
}

/** The archive's files written beside the sources, in data/updates, as prepareUpdate does. */
async function stage(root, files) {
  const workspace = await mkdtemp(join(root, 'data', 'updates', 'rescue-'));
  try {
    for (const [path, content] of files) {
      const target = join(workspace, 'stage', path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { flag: 'wx', mode: path.endsWith('.sh') ? 0o755 : 0o600 });
    }
    return workspace;
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

/** Every source moved aside by replaceSources is back in place (or none was moved). */
async function nothingMoved(workspace) {
  try {
    return (await readdir(join(workspace, 'backup'))).length === 0;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** One rescue at a time in a folder: two would swap the same sources (a window opened twice). */
async function lock(root) {
  const path = join(root, 'data', 'updates', 'rescue.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, JSON.stringify({ pid: process.pid, started: Date.now() }), { flag: 'wx', mode: 0o600 });
      return () => rm(path, { force: true }).catch(() => {});
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let holder = null,
      age = 0;
    try {
      age = Date.now() - (await stat(path)).mtimeMs;
      holder = JSON.parse(await readFile(path, 'utf8'));
    } catch {}
    // A rescue holds its lock for minutes at most: an older one was left by a window closed midway.
    if (holder ? running(holder.pid) && age < 3600000 : age < 10000) break;
    await rm(path, { force: true });
  }
  throw new Error(
    'Une autre mise à jour de secours est déjà en cours dans ce dossier. Attendez qu’elle se termine, puis relancez si besoin.',
  );
}

async function installedVersion(root) {
  try {
    const info = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    return info?.name === 'atelier-local' && stableVersion.test(info.version) ? info.version : null;
  } catch {
    return null;
  }
}

/** The installation identity of lib/app-sources.mjs, without reading every source. */
async function installationOf(root) {
  const directory = await realpath(root);
  return createHash('sha256')
    .update(process.platform === 'win32' ? directory.toLowerCase() : directory)
    .digest('hex');
}

/** Who answers on the port: { answer } (null if not JSON), { silent } when late, { free } when nothing listens. */
async function probe(port, wait, signal = never) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/api/bootstrap?brief=1`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(wait)]),
    });
    return { answer: await response.json() };
  } catch (error) {
    signal.throwIfAborted();
    if (error.name === 'TimeoutError') return { silent: true };
    return response ? { answer: null } : { free: true };
  }
}

/** Nothing holds the port: the launcher will be able to take it. */
function portFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

const busy = value =>
  value.updating ||
  value.status?.busy ||
  value.status?.toolJob ||
  ['loading', 'stopping'].includes(value.status?.state);

/** An update started from the page is replacing the sources (scripts/apply-update.mjs). */
async function installing(root) {
  try {
    const path = join(root, 'data', 'update-status.json'),
      { state } = JSON.parse(await readFile(path, 'utf8'));
    return ['installing', 'restarting'].includes(state) && Date.now() - (await stat(path)).mtimeMs < 300000;
  } catch {
    return false;
  }
}

async function askToClose(url, boot, signal) {
  try {
    const response = await fetch(url + '/api/shutdown', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + boot.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        onlyIfIdle: true,
        installationId: boot.installationId,
        sourceRevision: boot.sourceRevision,
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
    let error = '';
    try {
      error = (await response.json())?.error || '';
    } catch {}
    return { ok: response.ok, status: response.status, error };
  } catch {
    signal.throwIfAborted();
    // Cut while closing: the next look at the port tells.
    return { ok: false, status: 0, error: '' };
  }
}

/**
 * Closes the running application as its launcher would (only the one of this folder, only when
 * idle), or says what to close and waits for the port to be free. Gives up after `timeout`.
 */
async function closeInstance({ root, port, signal, timeout, log }) {
  const id = await installationOf(root),
    url = `http://127.0.0.1:${port}`,
    deadline = Date.now() + timeout,
    told = new Set();
  let why = '',
    asked = null,
    askedAt = 0;
  const tell = (key, message, reason) => {
    why = reason;
    if (told.has(key)) return;
    told.add(key);
    log(message);
  };
  const occupied = () =>
    tell(
      'busy',
      'Moodix est en train de travailler (génération, chargement du modèle ou mise à jour). Laissez-le terminer, ou fermez sa fenêtre : la mise à jour continuera ensuite.',
      'Moodix est resté occupé.',
    );
  while (true) {
    const seen = await probe(port, 5000, signal),
      boot = seen.answer;
    if (seen.free) {
      if (await installing(root))
        tell(
          'installing',
          'Une mise à jour lancée depuis la page est en cours d’installation : elle est attendue.',
          'une mise à jour lancée depuis la page était encore en cours.',
        );
      else if (await portFree(port)) return { closed: !!asked };
      else
        tell(
          'held',
          `Le port ${port} est occupé. Fermez le programme qui l’utilise : la mise à jour continuera dès qu’il sera libre.`,
          `le port ${port} est resté occupé.`,
        );
    } else if (seen.silent)
      tell(
        'silent',
        `Le port ${port} est tenu par un programme qui ne répond pas, sans doute Moodix très occupé. Fermez la fenêtre de Moodix : la mise à jour continuera dès que le port sera libre.`,
        `le programme qui tient le port ${port} ne répond pas.`,
      );
    else if (boot?.application !== 'atelier-local' || typeof boot.token !== 'string')
      tell(
        'other',
        `Le port ${port} est utilisé par un autre programme que Moodix (ou par une très ancienne version). Fermez-le : la mise à jour continuera dès que le port sera libre.`,
        `le port ${port} est utilisé par un autre programme.`,
      );
    else if (!boot.installationId || !boot.sourceRevision)
      tell(
        'old',
        `Une ancienne version de Moodix${boot.version ? ` (v${boot.version})` : ''} est ouverte. Fermez sa fenêtre de lancement : la mise à jour continuera ensuite.`,
        'une ancienne version de Moodix est restée ouverte.',
      );
    else if (boot.installationId !== id)
      tell(
        'elsewhere',
        `Le port ${port} est utilisé par Moodix ouvert depuis un autre dossier. Fermez cette fenêtre-là : la mise à jour continuera ensuite.`,
        'Moodix est resté ouvert depuis un autre dossier.',
      );
    else if (boot.token === asked) {
      if (Date.now() - askedAt > 30000)
        tell(
          'stuck',
          'Moodix ne se ferme pas. Fermez sa fenêtre : la mise à jour continuera ensuite.',
          'Moodix ne s’est pas fermé.',
        );
    } else if (busy(boot)) occupied();
    else {
      const answer = await askToClose(url, boot, signal);
      if (answer.ok) {
        asked = boot.token;
        askedAt = Date.now();
        tell('closing', 'Fermeture de Moodix…', 'Moodix ne s’est pas fermé.');
      } else if (answer.status === 409) occupied();
      else if (answer.status)
        tell(
          'refused',
          `Moodix a refusé de se fermer${answer.error ? ` (${answer.error})` : ''}. Fermez sa fenêtre : la mise à jour continuera ensuite.`,
          'Moodix a refusé de se fermer.',
        );
    }
    if (Date.now() >= deadline)
      throw new Error(
        `La mise à jour n’a pas pu commencer : ${why} Rien n’a été modifié ; relancez-la une fois Moodix fermé.`,
      );
    await delay(1000, undefined, { signal });
  }
}

/** The launcher of the sources now in the folder, in this window: it starts the server and holds it. */
function launch(root, port, open, output) {
  const child = spawn(
    process.execPath,
    [join(root, 'scripts', 'launch.mjs'), open ? '--open' : '--no-open', `--port=${port}`],
    { cwd: root, stdio: output, windowsHide: true },
  );
  const launcher = { child, code: null };
  launcher.exited = new Promise(resolve => {
    child.once('error', () => {
      launcher.code ??= 1;
      resolve(launcher.code);
    });
    child.once('exit', code => {
      launcher.code = code ?? 1;
      resolve(launcher.code);
    });
  });
  return launcher;
}

async function within(promise, ms) {
  let timer;
  const done = await Promise.race([
    promise.then(() => true),
    new Promise(resolve => {
      timer = setTimeout(resolve, ms, false);
    }),
  ]);
  clearTimeout(timer);
  return done;
}

/** The application answers with this version (any, when unknown) and its launcher holds it. */
async function confirmStart({ port, version, launcher, timeout, signal }) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && !signal.aborted && launcher.code === null) {
    const { answer } = await probe(port, 2000);
    if (
      answer?.application === 'atelier-local' &&
      answer.controlled === true &&
      (!version || answer.version === version) &&
      launcher.code === null
    )
      return true;
    await within(launcher.exited, 250);
  }
  return false;
}

/** Ends the launcher and its whole tree (server, model, generation worker). */
async function killTree(launcher) {
  if (launcher.code !== null) return;
  if (process.platform === 'win32')
    await new Promise(resolve => {
      const killer = spawn(
        join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(launcher.child.pid), '/T', '/F'],
        { stdio: 'ignore', windowsHide: true },
      );
      killer.once('error', resolve);
      killer.once('exit', resolve);
    });
  // Elsewhere the launcher stops the server it started; a server it already held stops by itself
  // once it has lost its launcher.
  else launcher.child.kill('SIGTERM');
  if (!(await within(launcher.exited, 3000))) launcher.child.kill('SIGKILL');
  await within(launcher.exited, 3000);
}

/** Stops what the rescue started; true once the port is free again. */
async function stopStarted({ port, launcher, version }) {
  const { answer } = await probe(port, 2000);
  let asked = false;
  if (answer?.application === 'atelier-local' && answer.version === version && typeof answer.token === 'string')
    try {
      // Asked first: the application saves what it holds, and its launcher ends with it.
      const response = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + answer.token, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(10000),
      });
      await response.body?.cancel();
      asked = response.ok;
    } catch {}
  if (!asked || !(await within(launcher.exited, 10000))) await killTree(launcher);
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if ((await probe(port, 1000)).free && (await portFree(port))) return true;
    await delay(250);
  }
  return false;
}

/**
 * Downloads the latest published version and installs it in `root`: the running application is
 * closed (only when idle), the sources are replaced with a backup, and the new version is started by
 * its own launcher. If it does not answer, the previous sources are put back and started again.
 * Resolves once the launcher holds the application ({ status, launcher }); the launcher keeps
 * running, as it does in its own window.
 */
export async function rescueUpdate({
  root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  port = 8787,
  open = true,
  // The published version installed again even when it is the installed one (never an older one).
  reinstall = false,
  fetchUpdate = fetch,
  log = console.log,
  signal = never,
  // How long a busy application, or a window to close, may keep the port before giving up.
  closeTimeout = 600000,
  // How long a started version may take to answer through its launcher.
  confirmTimeout = 90000,
  // The launcher's console: this window's own.
  output = 'inherit',
} = {}) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 ou plus récent est requis.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port invalide.');
  root = resolve(root);
  await plainFolder(root);
  await plainFolder(join(root, 'data', 'updates'), true);
  const unlock = await lock(root);
  try {
    const previousVersion = await installedVersion(root);
    log(`Mise à jour de secours de Moodix dans ${root}`);
    log(
      previousVersion
        ? `Version installée : ${previousVersion}.`
        : 'Version installée illisible : elle sera remplacée.',
    );
    log('Recherche de la dernière version sur GitHub…');
    const downloading = AbortSignal.any([signal, AbortSignal.timeout(600000)]);
    let files, version;
    try {
      const latest = await latestVersion({ fetchUpdate, signal: downloading });
      version = latest.version;
      if (previousVersion && !newerVersion(version, previousVersion) && !(reinstall && version === previousVersion)) {
        log(
          version === previousVersion
            ? `Moodix est déjà à jour (v${version}).`
            : `La version installée (v${previousVersion}) est plus récente que celle publiée (v${version}) : rien à installer.`,
        );
        return { status: 'current', version, previousVersion, launcher: launch(root, port, open, output) };
      }
      log(`Téléchargement de Moodix v${version} (révision ${latest.sha.slice(0, 7)})…`);
      files = readUpdateArchive(await downloadArchive(latest.sha, { fetchUpdate, signal: downloading }), version);
    } catch (error) {
      if (signal.aborted) throw error;
      if (error.name === 'TimeoutError')
        throw new Error('GitHub ne répond pas : délai dépassé. Vérifiez la connexion internet, puis relancez.');
      if (error instanceof TypeError)
        throw new Error(
          `GitHub est injoignable (${error.cause?.code || error.cause?.message || error.message}). Vérifiez la connexion internet, puis relancez.`,
        );
      throw error;
    }
    let workspace = await stage(root, files),
      failure;
    try {
      const { closed } = await closeInstance({ root, port, signal, timeout: closeTimeout, log });
      // Its launcher window ends with it: left a moment to finish before its files are swapped.
      if (closed) await delay(1000);
    } catch (error) {
      await rm(workspace, { recursive: true, force: true });
      throw error;
    }
    // From here the previous version is closed: whatever happens, it is put back and started again.
    log('Installation des nouveaux fichiers…');
    let installed = false;
    for (let attempt = 1; !installed && !failure; attempt++) {
      try {
        await replaceSources({ root, workspace });
        installed = true;
      } catch (error) {
        // Its own rollback failed: the backup it names is the previous version.
        if (!(await nothingMoved(workspace))) throw error;
        await rm(workspace, { recursive: true, force: true });
        if (attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error.code))
          failure = `les fichiers n’ont pas pu être remplacés (${error.message}).`;
        else {
          // A file still held for a moment (the closing application, an antivirus): tried again.
          await delay(attempt * 1000);
          workspace = await stage(root, files);
        }
      }
    }
    if (installed) {
      log(`Démarrage de Moodix v${version}…`);
      const launcher = launch(root, port, open, output);
      if (await confirmStart({ port, version, launcher, timeout: confirmTimeout, signal })) {
        await rm(workspace, { recursive: true, force: true }).catch(() => {});
        log(`\nMise à jour terminée : Moodix v${version} est ouvert.\n`);
        return { status: 'updated', version, previousVersion, launcher };
      }
      failure = signal.aborted
        ? 'la mise à jour a été interrompue.'
        : launcher.code !== null
          ? `la nouvelle version s’est arrêtée au démarrage (code ${launcher.code}).`
          : 'la nouvelle version n’a pas répondu à temps.';
      log(`Échec : ${failure} Retour à la version précédente…`);
      const stopped = await stopStarted({ port, launcher, version });
      try {
        await restoreSources({ root, workspace });
      } catch (error) {
        throw new Error(
          `La version précédente n’a pas pu être remise en place ; elle est sauvegardée dans ${join(workspace, 'backup')}. ${error.message}`,
        );
      }
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
      if (!stopped)
        throw new Error(
          `La mise à jour a échoué : ${failure} La version précédente est remise en place, mais la nouvelle occupe encore le port ${port} : fermez toutes les fenêtres de Moodix (ou redémarrez l’ordinateur), puis lancez Moodix.`,
        );
      if (signal.aborted) throw new Error('Mise à jour interrompue : la version précédente a été remise en place.');
    } else {
      log(`Échec : ${failure}`);
      if (signal.aborted) throw new Error('Mise à jour annulée : rien n’a été modifié.');
    }
    log(`Redémarrage de la version précédente${previousVersion ? ` (v${previousVersion})` : ''}…`);
    const launcher = launch(root, port, open, output);
    // The version that ran until now is given at least a minute, however short the wait for the new one.
    const restarted = await confirmStart({
      port,
      version: previousVersion,
      launcher,
      timeout: Math.max(confirmTimeout, 60000),
      signal,
    });
    return { status: 'rolled-back', version, previousVersion, error: failure, restarted, launcher };
  } finally {
    await unlock();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  // Ctrl+C reaches the launcher too, which closes the application itself.
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])];
  for (const name of signals) process.on(name, stop);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    portArg = process.argv.find(arg => arg.startsWith('--port='));
  try {
    // Never inside a folder the update replaces: Windows cannot rename a current directory.
    process.chdir(root);
    const result = await rescueUpdate({
      root,
      port: portArg ? Number(portArg.split('=')[1]) : 8787,
      open: !process.argv.includes('--no-open'),
      reinstall: process.argv.includes('--reinstall'),
      signal: controller.signal,
    });
    // This window now holds the application, as the launcher's own would.
    const code = await result.launcher.exited;
    if (result.status === 'rolled-back') {
      console.error(
        `\nLa mise à jour vers la v${result.version} n’a pas été installée : ${result.error} La version précédente est restée en place.` +
          (result.restarted
            ? ''
            : ' Elle n’a pas pu être rouverte : relancez Moodix avec son lanceur pour voir l’erreur.'),
      );
      process.exitCode = 1;
    } else process.exitCode = code;
  } catch (error) {
    console.error(`\n${error.name === 'AbortError' ? 'Mise à jour annulée : rien n’a été modifié.' : error.message}`);
    process.exitCode = 1;
  } finally {
    for (const name of signals) process.off(name, stop);
  }
}
