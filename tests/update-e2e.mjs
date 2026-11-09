import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { createApplication } from '../server.mjs';
import { prepareUpdate, launchInstaller } from '../lib/update-install.mjs';
import { tarball } from './fixtures/update-archive.mjs';
const project = fileURLToPath(new URL('../', import.meta.url));

for(const privateRuntime of [false,true])test(privateRuntime?'update checks newly installed requirements in the same private environment even when generation is disabled':'complete HTTP install restarts the real app and restores a private session without changing local configuration', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'atelier-e2e-'));
  let app, pid;
  try {
    for (const name of ['lib', 'public', 'scripts']) await cp(join(project, name), join(root, name), { recursive: true });
    await cp(join(project, 'server.mjs'), join(root, 'server.mjs'));
    await writeFile(join(root, 'package.json'), '{"name":"atelier-local","version":"0.2.0","type":"module","engines":{"node":">=22"}}');
    await mkdir(join(root, 'history')); await writeFile(join(root, 'history/keep.txt'), 'Private history');
    await writeFile(join(root, 'model.gguf'), 'Model outside managed sources');
    if(privateRuntime){
      await mkdir(join(root,'runner'));await writeFile(join(root,'runner/pyproject.toml'),'old requirements');await writeFile(join(root,'runner/uv.lock'),'old lock');
      await mkdir(join(root,'data/runtime/venv'),{recursive:true});await writeFile(join(root,'data/runtime/venv/pyvenv.cfg'),'preserved environment identity');
      // Stub only package installation: the updater, replacement server and startup reconciliation are real.
      await writeFile(join(root,'lib/python-environment.mjs'),`import {readFile,writeFile,lstat} from 'node:fs/promises';import {join} from 'node:path';
export const environmentVariables=()=>({...process.env});
export class PythonEnvironment{
constructor({root,dataDir}){Object.assign(this,{root,dataDir,state:'idle'});}
status(){return {state:this.state,progress:'',error:''};}
async exists(){try{await lstat(join(this.dataDir,'runtime/venv/pyvenv.cfg'));return true;}catch{return false;}}
async ensure(){const requirements=await readFile(join(this.root,'runner/pyproject.toml'),'utf8'),lock=await readFile(join(this.root,'runner/uv.lock'),'utf8'),identity=await readFile(join(this.dataDir,'runtime/venv/pyvenv.cfg'),'utf8');await writeFile(join(this.dataDir,'requirements-observed.json'),JSON.stringify({requirements,lock,identity}));this.state='ready';return process.execPath;}
async cancel(){}async close(){}
}`);
    }
    const entries = [];
    async function collect(directory, prefix) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name), name = prefix + '/' + entry.name;
        if (entry.isDirectory()) await collect(path, name); else entries.push({ name: 'repo/' + name, text: await readFile(path) });
      }
    }
    await collect(join(root, 'lib'), 'lib'); await collect(join(root, 'public'), 'public'); await collect(join(root, 'scripts'), 'scripts');
    if(privateRuntime)entries.push({name:'repo/runner/pyproject.toml',text:'new requirements'},{name:'repo/runner/uv.lock',text:'new lock'});
    // Only external version checks are disabled in this fixture; the HTTP server and installer are real.
    const server = (await readFile(join(root, 'server.mjs'), 'utf8')).replace('updateChecker: ({ signal }) => checkForUpdates({ currentVersion: version, signal }),', 'updateChecker: null,');
    entries.push({ name: 'repo/server.mjs', text: server }, { name: 'repo/package.json', text: '{"name":"atelier-local","version":"0.3.0","type":"module","engines":{"node":">=22"}}' });
    const bytes = tarball(entries), sha = '1'.repeat(40);
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(join(root, 'data/preferences.json'), JSON.stringify({ theme: 'dark', saveHistory: false }));
    const create=privateRuntime?(await import(pathToFileURL(join(root,'server.mjs')).href)).createApplication:createApplication;
    app = await create({ port: 0, dataDir: join(root, 'data'), historyDir: join(root, 'history'),
      updateChecker: async () => ({ available: true, version: '0.3.0' }),
      updateInstaller: { prepare: args => prepareUpdate({ ...args, root, currentVersion: '0.2.0', fetchUpdate: async url => new Response(url.includes('/commits/') ? sha : bytes) }), launch: launchInstaller },
    });
    const bootstrap = await (await fetch(app.url + '/api/bootstrap')).json();
    async function observed(expected){const end=Date.now()+3000;while(Date.now()<end){try{const value=JSON.parse(await readFile(join(root,'data/requirements-observed.json'),'utf8'));if(value.requirements===expected)return value;}catch{}await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('Expected dependency check: '+expected);}
    if(privateRuntime)assert.equal((await observed('old requirements')).lock,'old lock');
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
    if(privateRuntime){const checked=await observed('new requirements');assert.equal(checked.lock,'new lock');assert.equal(checked.identity,'preserved environment identity');assert.equal(await readFile(join(root,'data/runtime/venv/pyvenv.cfg'),'utf8'),checked.identity);assert.equal(next.generation.enabled,false);}
  } finally {
    if (pid) try { process.kill(pid); } catch {}
    await app?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
