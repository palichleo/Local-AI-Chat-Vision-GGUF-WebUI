import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createApplication} from '../server.mjs';
const until=async check=>{const end=Date.now()+5000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,25));}assert.fail('The application did not stop cleanly.');};
async function fixture(t,options={}){
 const directory=await mkdtemp(join(tmpdir(),'atelier-lifecycle-'));
 const app=await createApplication({port:0,dataDir:directory,...options});
 t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
 const boot=await(await fetch(app.url+'/api/bootstrap')).json();
 const api=(route,body,token=boot.token)=>fetch(app.url+'/api/'+route,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {app,boot,api,directory};
}
test('bootstrap identifies Atelier and exposes launcher attachment state',async t=>{
 const {boot}=await fixture(t);assert.equal(boot.application,'atelier-local');assert.equal(boot.controlled,false);
});
test('closing the launcher control connection stops the application and releases its port',async t=>{
 const {app,api}=await fixture(t);
 assert.equal((await api('lifecycle',undefined,'wrong')).status,401);
 const control=await api('lifecycle');assert.equal(control.status,200);
 const reader=control.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/running/);
 assert.equal((await(await api('bootstrap')).json()).controlled,true);
 assert.equal((await api('lifecycle')).status,409);
 await reader.cancel();
 await until(async()=>{try{await fetch(app.url+'/api/bootstrap');return false;}catch{return true;}});
});
test('a managed replacement without a launcher shuts itself down',async t=>{
 const {app}=await fixture(t,{managed:true,controlTimeoutMs:70});
 await until(async()=>{try{await fetch(app.url+'/api/bootstrap');return false;}catch{return true;}});
});
test('authenticated application shutdown stops its own model and releases the listener',async t=>{
 let child;const {app,api,directory}=await fixture(t,{spawnProcess:(_cmd,args,options)=>child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/fake-engine.mjs',import.meta.url)),...args],options)});
 const modelPath=join(directory,'model.gguf');await writeFile(modelPath,Buffer.from('GGUF\x03\0\0\0'));
 assert.equal((await api('config',{enginePath:process.execPath,modelPath,projectorPath:'',contextSize:4096,maxOutputTokens:1024,gpuLayers:0})).status,200);
 assert.equal((await api('start',{})).status,202);
 await until(async()=>(await(await api('status')).json()).state==='ready');
 assert.equal((await api('shutdown',{},'bad')).status,401);
 assert.equal((await api('shutdown',null)).status,400);assert.equal((await api('status')).status,200);
 assert.equal((await api('shutdown',{})).status,202);
 await until(async()=>child.exitCode!==null||child.signalCode!==null);
 await until(async()=>{try{await fetch(app.url+'/api/bootstrap');return false;}catch{return true;}});
});

test('control heartbeats prevent idle loss and a short transport interruption allows reconnection',async t=>{
 const {app,api}=await fixture(t,{controlHeartbeatMs:20,controlReconnectMs:250});
 let control=await api('lifecycle'),reader=control.body.getReader();let beats=0;
 const untilTime=Date.now()+130;
 while(Date.now()<untilTime){const next=await Promise.race([reader.read(),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Idle control stream timed out')),150);timer.unref();})]);assert.equal(next.done,false);beats+=new TextDecoder().decode(next.value).split('running').length-1;}
 assert.ok(beats>=3);await reader.cancel();await new Promise(resolve=>setTimeout(resolve,50));assert.equal((await api('status')).status,200);
 control=await api('lifecycle');reader=control.body.getReader();await reader.read();await new Promise(resolve=>setTimeout(resolve,350));assert.equal((await api('status')).status,200);await reader.cancel();
 await until(async()=>{try{await fetch(app.url+'/api/bootstrap');return false;}catch{return true;}});
});
