import { mkdir, writeFile, readFile, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fork } from 'node:child_process';
import { readUpdateArchive } from './update-archive.mjs';
import { plainFolder, atomicJson } from './update-files.mjs';
import { newerVersion } from './updates.mjs';

async function download(url, limit, signal, fetchUpdate, accept = 'application/octet-stream') {
  const response = await fetchUpdate(url, { redirect: 'error', signal, headers: { Accept: accept, 'User-Agent': 'AtelierLocal-updater' } });
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('Téléchargement de la mise à jour refusé.'); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw new Error('La mise à jour dépasse la taille autorisée.'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}

export async function prepareUpdate({ root, version, currentVersion, port, signal, fetchUpdate = fetch }) {
  if (!newerVersion(version, currentVersion) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Aucune nouvelle version installable.');
  const timed = AbortSignal.timeout(120000), downloadSignal = signal ? AbortSignal.any([signal, timed]) : timed;
  const sha = (await download('https://api.github.com/repos/palichleo/Local-AI-Chat-Vision-GGUF-WebUI/commits/main', 128, downloadSignal, fetchUpdate, 'application/vnd.github.sha')).toString('utf8').trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Révision GitHub invalide.');
  const bytes = await download(`https://codeload.github.com/palichleo/Local-AI-Chat-Vision-GGUF-WebUI/tar.gz/${sha}`, 20 * 1024 * 1024, downloadSignal, fetchUpdate);
  const files = readUpdateArchive(bytes, version);
  await plainFolder(root);
  const parent = join(resolve(root), 'data', 'updates'); await plainFolder(parent, true);
  const workspace = await mkdtemp(join(parent, 'install-'));
  try {
    for (const [path, content] of files) {
      const target = join(workspace, 'stage', path); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { flag: 'wx', mode: path.endsWith('.sh') ? 0o755 : 0o600 });
    }
    for (const [source, target] of [['lib/update-files.mjs', 'update-files.mjs'], ['lib/update-archive.mjs', 'update-archive.mjs'], ['scripts/apply-update.mjs', 'worker.mjs']]) await copyFile(join(root, source), join(workspace, target));
    const plan = { root: resolve(root), workspace, port, version, previousVersion: currentVersion };
    await atomicJson(join(workspace, 'plan.json'), plan);
    return plan;
  } catch (error) { await rm(workspace, { recursive: true, force: true }); throw error; }
}

export async function launchInstaller(plan) {
  const child = fork(join(plan.workspace, 'worker.mjs'), [join(plan.workspace, 'plan.json')], { cwd: plan.workspace, detached: true, windowsHide: true, env: { ...process.env, ATELIER_MANAGED_LAUNCH: plan.managed ? '1' : '' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('L’installateur ne répond pas.')), 5000);
    const onMessage = message => { if (message?.ready) finish(); };
    const onError = error => finish(error);
    const onExit = () => finish(new Error('L’installateur s’est arrêté avant le démarrage.'));
    function finish(error) {
      clearTimeout(timeout); child.off('message', onMessage); child.off('error', onError); child.off('exit', onExit);
      if (error) { child.kill(); reject(error); } else resolve();
    }
    child.on('message', onMessage); child.once('error', onError); child.once('exit', onExit);
  });
  return {
    async commit() {
      await new Promise((resolve, reject) => child.send({ apply: true }, error => error ? reject(error) : resolve()));
      if (child.connected) child.disconnect(); child.unref();
    },
    abort() { if (child.connected) child.disconnect(); child.kill(); },
  };
}
