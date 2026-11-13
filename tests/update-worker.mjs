import { fileURLToPath } from 'node:url';
const project = fileURLToPath(new URL('../', import.meta.url));
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import * as installer from '../lib/update-install.mjs';
const fixtureServer = version => `import http from 'node:http';
const server=http.createServer((req,res)=>{if(req.url==='/quit'){res.end('bye');server.close();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({version:'${version}',updateNonce:process.env.ATELIER_UPDATE_NONCE}));});
server.listen(Number(process.argv.find(a=>a.startsWith('--update-port=')).split('=')[1]),'127.0.0.1');`;
for (const fail of [false, true])
  test(
    fail
      ? 'failed new server restores old sources and restarts previous version'
      : 'installer replaces sources and restarts the updated server on the same port',
    { timeout: 20000 },
    async t => {
      assert.equal(typeof installer.launchInstaller, 'function');
      const root = await mkdtemp(join(tmpdir(), 'atelier-worker-'));
      const workspace = join(root, 'data/updates/test-worker');
      const socket = net.createServer();
      await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
      const port = socket.address().port;
      await new Promise(resolve => socket.close(resolve));
      await mkdir(join(workspace, 'stage'), { recursive: true });
      await writeFile(join(root, 'package.json'), '{"name":"atelier-local","version":"0.2.0","type":"module"}');
      await writeFile(join(root, 'server.mjs'), fixtureServer('0.2.0'));
      await writeFile(join(root, 'data/config.json'), 'private');
      await writeFile(
        join(workspace, 'stage/package.json'),
        '{"name":"atelier-local","version":"0.3.0","type":"module"}',
      );
      await writeFile(join(workspace, 'stage/server.mjs'), fail ? 'process.exit(9);' : fixtureServer('0.3.0'));
      for (const [from, to] of [
        ['lib/update-files.mjs', 'update-files.mjs'],
        ['lib/update-archive.mjs', 'update-archive.mjs'],
        ['scripts/apply-update.mjs', 'worker.mjs'],
      ])
        await cp(join(project, from), join(workspace, to));
      const plan = { root, workspace, port, version: '0.3.0', previousVersion: '0.2.0' };
      await writeFile(join(workspace, 'plan.json'), JSON.stringify(plan));
      let handle;
      try {
        handle = await installer.launchInstaller(plan);
        await handle.commit();
        const deadline = Date.now() + 12000;
        let result;
        while (Date.now() < deadline) {
          try {
            result = JSON.parse(await readFile(join(root, 'data/update-status.json'), 'utf8'));
            if (['done', 'rolled-back', 'error'].includes(result.state)) break;
          } catch {}
          await new Promise(resolve => setTimeout(resolve, 80));
        }
        assert.equal(result.state, fail ? 'rolled-back' : 'done', JSON.stringify(result));
        const response = await (await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).json();
        assert.equal(response.version, fail ? '0.2.0' : '0.3.0');
        assert.equal(await readFile(join(root, 'data/config.json'), 'utf8'), 'private');
        assert.equal(
          await readFile(join(workspace, 'backup/server.mjs'), 'utf8').catch(() => 'restored'),
          fail ? 'restored' : fixtureServer('0.2.0'),
        );
      } finally {
        try {
          await (await fetch(`http://127.0.0.1:${port}/quit`)).text();
        } catch {}
        handle?.abort();
        await new Promise(resolve => setTimeout(resolve, 150));
        await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      }
    },
  );

for (const mode of ['unresponsive', 'status-write-failure'])
  test(
    mode === 'unresponsive'
      ? 'rollback terminates an unhealthy replacement that ignores SIGTERM before reusing its port'
      : 'a terminal status write failure never rolls back a healthy replacement',
    { timeout: 40000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'atelier-worker-edge-'));
      const workspace = join(root, 'data/updates/edge');
      const socket = net.createServer();
      await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
      const port = socket.address().port;
      await new Promise(resolve => socket.close(resolve));
      let handle, pid;
      try {
        await mkdir(join(workspace, 'stage'), { recursive: true });
        await writeFile(join(root, 'package.json'), '{"name":"atelier-local","version":"0.2.0","type":"module"}');
        await writeFile(join(root, 'server.mjs'), fixtureServer('0.2.0'));
        let next = fixtureServer(mode === 'unresponsive' ? 'wrong-version' : '0.3.0');
        next =
          "import {writeFileSync,rmSync,mkdirSync} from 'node:fs';writeFileSync(new URL('./child.pid',import.meta.url),String(process.pid));" +
          next;
        if (mode === 'unresponsive') next += "process.on('SIGTERM',()=>{});";
        else
          next = next.replace(
            "res.setHeader('content-type'",
            "const p=new URL('./data/update-status.json',import.meta.url);try{rmSync(p,{force:true});mkdirSync(p);}catch{}res.setHeader('content-type'",
          );
        await writeFile(
          join(workspace, 'stage/package.json'),
          '{"name":"atelier-local","version":"0.3.0","type":"module"}',
        );
        await writeFile(join(workspace, 'stage/server.mjs'), next);
        for (const [from, to] of [
          ['lib/update-files.mjs', 'update-files.mjs'],
          ['lib/update-archive.mjs', 'update-archive.mjs'],
          ['scripts/apply-update.mjs', 'worker.mjs'],
        ])
          await cp(join(project, from), join(workspace, to));
        const plan = { root, workspace, port, version: '0.3.0', previousVersion: '0.2.0', confirmTimeout: 20000 };
        await writeFile(join(workspace, 'plan.json'), JSON.stringify(plan));
        let workerExit;
        if (mode === 'status-write-failure') {
          const child = fork(join(workspace, 'worker.mjs'), [join(workspace, 'plan.json')], {
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            windowsHide: true,
          });
          workerExit = once(child, 'exit');
          await new Promise((resolve, reject) => {
            child.once('message', resolve);
            child.once('error', reject);
          });
          child.send({ apply: true });
          child.disconnect();
          handle = {
            abort() {
              child.kill();
            },
          };
        } else {
          handle = await installer.launchInstaller(plan);
          await handle.commit();
        }
        const deadline = Date.now() + 33000;
        let done = false;
        while (Date.now() < deadline) {
          try {
            const state = JSON.parse(await readFile(join(root, 'data/update-status.json'), 'utf8'));
            if (mode === 'unresponsive' && state.state === 'rolled-back') {
              pid = state.pid;
              done = true;
              break;
            }
          } catch {}
          if (mode === 'status-write-failure')
            try {
              const data = await (await fetch('http://127.0.0.1:' + port + '/api/bootstrap')).json();
              if (data.version === '0.3.0') {
                pid = Number(await readFile(join(root, 'child.pid'), 'utf8'));
                done = true;
                break;
              }
            } catch {}
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(done, true, mode + ' did not reach its expected state');
        if (workerExit) await workerExit;
        const live = await (await fetch('http://127.0.0.1:' + port + '/api/bootstrap')).json();
        assert.equal(live.version, mode === 'unresponsive' ? '0.2.0' : '0.3.0');
        assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version, live.version);
      } finally {
        if (!pid)
          try {
            pid = Number(await readFile(join(root, 'child.pid'), 'utf8'));
          } catch {}
        if (pid)
          try {
            process.kill(pid, 'SIGKILL');
          } catch {}
        handle?.abort();
        await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      }
    },
  );
