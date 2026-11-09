import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {GenerationWorker} from '../lib/generation-worker.mjs';
const fixture=fileURLToPath(new URL('./fixtures/fake-generation-worker.mjs',import.meta.url));
function worker(mode){return new GenerationWorker({root:process.cwd(),handshakeMs:500,stopMs:200,
 spawnProcess:(_command,_args,options)=>spawn(process.execPath,[fixture],{...options,env:{...options.env,TEST_RUNNER_MODE:mode}})});}
test('worker handshake, typed protocol, progress, release and owned process close',async()=>{
 const w=worker();try{
  await w.start({pythonPath:process.execPath,configPath:'unused'});assert.equal(w.status().state,'ready');
  const progress=[];assert.deepEqual(await w.request('generate',{seed:3},{onProgress:p=>progress.push(p)}),{method:'generate',params:{seed:3}});
  assert.deepEqual(progress,[{step:1,total:8}]);assert.equal((await w.release()).released,true);
 }finally{await w.close();}assert.equal(w.status().state,'stopped');assert.equal(w.child,null);
});
test('abort kills and reaps only the owned child, then supports fresh startup',async()=>{
 const w=worker();try{await w.start({pythonPath:process.execPath,configPath:'unused'});
  const controller=new AbortController();const request=w.request('hang',{}, {signal:controller.signal});controller.abort();
  await assert.rejects(request,/annul|abort/i);assert.equal(w.child,null);
  await w.start({pythonPath:process.execPath,configPath:'unused'});assert.equal(w.status().state,'ready');
 }finally{await w.close();}
});
test('invalid JSON and startup failures leave diagnostics instead of hanging',async()=>{
 for(const mode of ['silent','crash']){const w=worker(mode);await assert.rejects(w.start({pythonPath:process.execPath,configPath:'unused'}));await w.close();assert.equal(w.child,null);}
 const w=worker();try{await w.start({pythonPath:process.execPath,configPath:'unused'});await assert.rejects(w.request('bad'),/JSON|protocole/i);}finally{await w.close();}
});

test('closing during handshake cancels startup without a late worker or fallback',async()=>{
 const w=worker('silent');const starting=w.start({pythonPath:process.execPath,configPath:'unused'});
 const rejected=assert.rejects(starting,/fermé|arrêté/);
 await w.close();await rejected;assert.equal(w.child,null);assert.equal(w.status().state,'stopped');
});
