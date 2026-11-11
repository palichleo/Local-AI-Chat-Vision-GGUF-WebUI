import { readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { replaceSources, restoreSources, atomicJson, plainFolder } from './update-files.mjs';

const plan = JSON.parse(await readFile(process.argv[2], 'utf8'));
await plainFolder(join(plan.root, 'data'));
let started = false;
process.once('disconnect', () => {
  if (!started) process.exitCode = 1;
});
process.once('message', async message => {
  if (!message?.apply || started) return;
  started = true;
  const status = (state, error = '', pid = null) =>
    atomicJson(join(plan.root, 'data', 'update-status.json'), { state, version: plan.version, error, pid });
  let installed = false,
    healthy = false;
  try {
    await status('installing');
    await replaceSources(plan);
    installed = true;
    await status('restarting');
    const pid = await restart(plan.version);
    healthy = true;
    await status('done', '', pid);
  } catch (error) {
    // A status-file error must never roll back an already healthy application.
    if (healthy) return;
    if (error.unsafeRollback) {
      await status('error', error.message).catch(() => {});
      return;
    }
    try {
      if (installed) await restoreSources(plan);
      const pid = await restart(plan.previousVersion);
      await status(
        'rolled-back',
        'La mise à jour a échoué ; la version précédente a été restaurée. ' + error.message,
        pid,
      );
    } catch (failure) {
      await status(
        'error',
        'Redémarrage impossible. La sauvegarde est conservée dans ' + plan.workspace + '. ' + failure.message,
      );
    }
  } finally {
    if (process.connected) process.disconnect();
  }
});
process.send({ ready: true });

async function restart(expectedVersion) {
  const nonce = randomUUID();
  const log = await open(join(plan.workspace, 'restart.log'), 'a', 0o600);
  const child = spawn(process.execPath, [join(plan.root, 'server.mjs'), `--update-port=${plan.port}`], {
    cwd: plan.root,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log.fd, log.fd],
    env: { ...process.env, ATELIER_UPDATE_NONCE: nonce },
  });
  let spawnError,
    exited = false;
  child.on('error', error => {
    spawnError = error;
  });
  const exit = new Promise(resolve =>
    child.once('exit', () => {
      exited = true;
      resolve();
    }),
  );
  const deadline = Date.now() + 20000;
  try {
    while (Date.now() < deadline) {
      if (spawnError || exited) throw spawnError || new Error('La nouvelle application s’est arrêtée.');
      try {
        // The short answer: the full one reads the workflow catalog and can take over a second.
        const response = await fetch(`http://127.0.0.1:${plan.port}/api/bootstrap?brief=1`, {
          signal: AbortSignal.timeout(5000),
        });
        const data = await response.json();
        if (data.version === expectedVersion && data.updateNonce === nonce) {
          child.unref();
          return child.pid;
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('Le démarrage n’a pas pu être confirmé.');
  } catch (error) {
    if (!exited && child.pid) {
      child.kill('SIGTERM');
      await waitForExit(3000);
      if (!exited) {
        child.kill('SIGKILL');
        await waitForExit(3000);
      }
      if (!exited)
        throw Object.assign(
          new Error('Le processus de mise à jour ne peut pas être arrêté ; sources et sauvegarde conservées.'),
          { unsafeRollback: true },
        );
    }
    throw error;
  } finally {
    await log.close();
  }
  async function waitForExit(ms) {
    let timer;
    await Promise.race([
      exit,
      new Promise(resolve => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
    clearTimeout(timer);
  }
}
