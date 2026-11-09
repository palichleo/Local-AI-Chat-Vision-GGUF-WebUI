import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {ModelLibrary} from '../lib/models.mjs';import {createApplication} from '../server.mjs';
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'atelier-models-'));t.after(()=>rm(root,{recursive:true,force:true}));const models=join(root,'models');await mkdir(models);return {root,models,library:new ModelLibrary(join(root,'library.json'),models)};}
async function gguf(folder,name,contents='GGUF\x03\0\0\0'){await mkdir(folder,{recursive:true});const path=join(folder,name);await writeFile(path,contents);return path;}

test('organized folders detect LLMs and matching vision folders without treating component folders as broken chat models',async t=>{
 const {models,library}=await fixture(t);for(const folder of ['checkpoints','LoRa','VAE','vision'])await mkdir(join(models,folder));
 await gguf(join(models,'LLMs','New model'),'main.gguf');const projector=await gguf(join(models,'vision','New model'),'mmproj.gguf');await gguf(join(models,'Legacy model'),'main.gguf');await writeFile(join(models,'VAE','vae.safetensors'),'test');
 const result=await library.scan();assert.deepEqual(result.errors,[]);assert.deepEqual(result.detected.map(item=>item.name),['Legacy model','New model']);assert.equal(result.detected[1].projectorPath,projector);
 await assert.rejects(readFile(join(models,'put model folders here.txt')),{code:'ENOENT'});
 await gguf(join(models,'LLMs','New model'),'mmproj.gguf');assert.match((await library.scan()).detected[1].projectorPath,/LLMs/);
});
test('scan assigns mmproj regardless of order, derives names from folders and reports ambiguous or invalid folders',async t=>{
 const {models,library}=await fixture(t);await gguf(join(models,'My vision model'),'z.gguf');await gguf(join(models,'My vision model'),'a.MMProj.gguf');await gguf(join(models,'Text only'),'model.gguf');
 await gguf(join(models,'Ambiguous'),'a.gguf');await gguf(join(models,'Ambiguous'),'b.gguf');await gguf(join(models,'Invalid'),'a.gguf','not GGUF');await gguf(join(models,'Projector only'),'mmproj.gguf');
 const result=await library.scan();assert.deepEqual(result.detected.map(p=>p.name),['My vision model','Text only']);assert.match(result.detected[0].projectorPath,/a.MMProj.gguf$/);assert.match(result.detected[0].modelPath,/z.gguf$/);assert.equal(result.errors.length,3);
});
test('manual profiles deduplicate, persist paths only and validate GGUF headers before saving',async t=>{
 const {root,library,models}=await fixture(t),modelPath=await gguf(join(root,'External model'),'main.gguf'),projectorPath=await gguf(join(root,'External model'),'mmproj.gguf');
 const one=await library.add({modelPath,projectorPath});assert.equal(one.name,'External model');assert.equal((await library.add({modelPath,projectorPath})).id,one.id);
 const reopened=new ModelLibrary(join(root,'library.json'),models);assert.equal((await reopened.list()).length,1);assert.equal((await reopened.get(one.id)).modelPath,modelPath);
 await assert.rejects(library.add({modelPath:projectorPath,projectorPath:''}),/mmproj/);await writeFile(modelPath,'bad');await assert.rejects(reopened.get(one.id),/GGUF/);
});
test('HTTP model selection preserves shared engine settings and survives restart',async t=>{
 const {root,models}=await fixture(t),dataDir=join(root,'data');let app=await createApplication({port:0,dataDir,modelsDir:models});t.after(()=>app.close());
 const request=async(route,body)=>{const boot=await(await fetch(app.url+'/api/bootstrap')).json();return fetch(app.url+'/api/'+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+boot.token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});};
 const modelPath=await gguf(join(models,'Portable LLM'),'text.gguf');const added=await(await request('models/add',{modelPath,projectorPath:''})).json();assert.equal(added.profile.name,'Portable LLM');
 const before=await(await fetch(app.url+'/api/bootstrap')).json();const switched=await(await request('models/select',{id:added.profile.id})).json();assert.equal(switched.config.modelPath,modelPath);assert.equal(switched.config.enginePath,before.config.enginePath);assert.equal(switched.config.contextSize,before.config.contextSize);assert.equal(switched.status.state,'stopped');
 assert.equal((await request('models/select',{id:'../bad'})).status,400);await app.close();app=await createApplication({port:0,dataDir,modelsDir:models});const after=await(await fetch(app.url+'/api/bootstrap')).json();assert.equal(after.models.length,1);assert.equal(after.config.modelPath,modelPath);
});

test('switching a running model reloads only that engine and rejects switching during chat',async t=>{
 const {root,models}=await fixture(t),dataDir=join(root,'data');
 const app=await createApplication({port:0,dataDir,modelsDir:models,spawnProcess:(_cmd,args,options)=>spawn(process.execPath,[fileURLToPath(new URL('./fixtures/fake-engine.mjs',import.meta.url)),...args],options)});t.after(()=>app.close());
 const boot=await(await fetch(app.url+'/api/bootstrap')).json();const request=(route,body)=>fetch(app.url+'/api/'+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+boot.token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const a=await gguf(join(models,'A'),'model.gguf'),b=await gguf(join(models,'B'),'model.gguf');
 await request('config',{...boot.config,enginePath:process.execPath,modelPath:a,gpuLayers:0});await request('start',{});
 const ready=async()=>{const deadline=Date.now()+10000;while((await(await request('status')).json()).state!=='ready'){if(Date.now()>deadline)assert.fail('Engine not ready');await new Promise(r=>setTimeout(r,25));}};await ready();
 const {profile}=await(await request('models/add',{modelPath:b,projectorPath:''})).json();
 const reader=(await request('chat',{messages:[{role:'user',content:'lent'}]})).body.getReader();await reader.read();assert.equal((await request('models/select',{id:profile.id})).status,409);assert.equal((await request('models/remove',{id:profile.id})).status,409);await reader.cancel();
 const deadline=Date.now()+2000;while((await(await request('status')).json()).busy){if(Date.now()>deadline)assert.fail('Chat not cancelled');await new Promise(r=>setTimeout(r,25));}
 const response=await request('models/select',{id:profile.id});assert.equal(response.status,200);assert.equal((await response.json()).config.enginePath,process.execPath);await ready();
 const status=await(await request('status')).json();assert.ok(status.logs.some(line=>line.includes(b)));assert.equal(status.vision,false);
 const removed=await(await request('models/remove',{id:profile.id})).json();assert.equal(removed.status.state,'stopped');assert.equal(removed.config.modelPath,'');assert.equal(removed.config.enginePath,process.execPath);assert.equal(await readFile(b,'utf8'),'GGUF\x03\0\0\0');
});

test('removal persists, suppresses rediscovery and keeps GGUF files; adding again restores detection',async t=>{
 const {root,models,library}=await fixture(t),modelPath=await gguf(join(models,'A'),'main.gguf'),projectorPath=await gguf(join(models,'A'),'mmproj.gguf'),otherPath=await gguf(join(models,'B'),'main.gguf');
 const one=await library.add({modelPath,projectorPath});await library.remove(one.id);
 const reopened=new ModelLibrary(join(root,'library.json'),models);assert.deepEqual(await reopened.list(),[]);assert.deepEqual((await reopened.scan()).detected.map(p=>p.name),['B']);
 assert.equal(await readFile(modelPath,'utf8'),'GGUF\x03\0\0\0');assert.equal(await readFile(projectorPath,'utf8'),'GGUF\x03\0\0\0');
 await reopened.add({modelPath:otherPath});assert.equal((await reopened.scan()).detected.length,1,'unrelated save preserves exclusions');
 await reopened.add({modelPath,projectorPath});assert.equal((await reopened.scan()).detected.length,2);
 await rm(modelPath);await reopened.remove(one.id);assert.equal((await reopened.list()).length,1,'stale paths remain removable');
 await assert.rejects(reopened.remove('../bad'),{status:400});await assert.rejects(reopened.remove('a'.repeat(64)),{status:404});
});

test('detected unsaved models can be removed and simultaneous mutations keep other profiles',async t=>{
 const {models,library}=await fixture(t),a=await gguf(join(models,'A'),'main.gguf'),b=await gguf(join(models,'B'),'main.gguf');
 const detected=(await library.scan()).detected.find(item=>item.modelPath===a);await Promise.all([library.remove(detected.id),library.add({modelPath:b})]);
 assert.deepEqual((await library.list()).map(p=>p.modelPath),[b]);assert.deepEqual((await library.scan()).detected.map(p=>p.modelPath),[b]);
});

test('HTTP removal leaves an unrelated selection intact and clears an active selection across restart',async t=>{
 const {root,models}=await fixture(t),dataDir=join(root,'data');let app=await createApplication({port:0,dataDir,modelsDir:models});t.after(()=>app.close());
 const request=async(route,body)=>{const boot=await(await fetch(app.url+'/api/bootstrap')).json();return fetch(app.url+'/api/'+route,{method:'POST',headers:{Authorization:'Bearer '+boot.token,'Content-Type':'application/json'},body:JSON.stringify(body)});};
 const a=await gguf(join(models,'A'),'main.gguf'),b=await gguf(join(models,'B'),'main.gguf');
 const one=(await(await request('models/add',{modelPath:a})).json()).profile,two=(await(await request('models/add',{modelPath:b})).json()).profile;
 await request('models/select',{id:one.id});const inactive=await(await request('models/remove',{id:two.id})).json();assert.equal(inactive.config.modelPath,a);
 const active=await(await request('models/remove',{id:one.id})).json();assert.equal(active.config.modelPath,'');assert.equal(active.config.projectorPath,'');assert.deepEqual(active.models,[]);assert.deepEqual(active.detected,[]);
 assert.equal((await request('models/remove',{id:one.id})).status,404);assert.equal((await request('models/remove',{id:'../bad'})).status,400);
 await app.close();app=await createApplication({port:0,dataDir,modelsDir:models});const boot=await(await fetch(app.url+'/api/bootstrap')).json();assert.equal(boot.config.modelPath,'');assert.deepEqual(boot.models,[]);
 const library=await(await fetch(app.url+'/api/models',{headers:{Authorization:'Bearer '+boot.token}})).json();assert.deepEqual(library.detected,[]);assert.equal(await readFile(a,'utf8'),'GGUF\x03\0\0\0');assert.equal(await readFile(b,'utf8'),'GGUF\x03\0\0\0');
});
test('concurrent additions never lose profiles and never read full model weights',async t=>{
 const {root,library}=await fixture(t),a=await gguf(join(root,'A'),'a.gguf'),b=await gguf(join(root,'B'),'b.gguf');
 await Promise.all([library.add({modelPath:a}),library.add({modelPath:b})]);assert.equal((await library.list()).length,2);
});

test('a projector named mmproj with a wrong extension fails detection instead of silently becoming text-only',async t=>{
 const {models,library}=await fixture(t);await gguf(join(models,'Broken pair'),'main.gguf');await gguf(join(models,'Broken pair'),'mmproj.bin');
 const result=await library.scan();assert.equal(result.detected.length,0);assert.equal(result.errors.length,1);assert.match(result.errors[0].error,/GGUF/);
});

test('custom LLM names survive restart, keep the same identity and never rename the folder',async t=>{
 const {root,models,library}=await fixture(t),modelPath=await gguf(join(models,'Folder'),'main.gguf');
 const first=await library.add({modelPath,name:'Personal name'});assert.equal(first.name,'Personal name');
 const second=await library.add({id:first.id,modelPath,name:'Renamed'});assert.equal(second.id,first.id);
 const reopened=new ModelLibrary(join(root,'library.json'),models);assert.equal((await reopened.list())[0].name,'Renamed');assert.equal((await reopened.scan()).detected[0].name,'Folder');
 for(const name of ['', ' '.repeat(3), 'a'.repeat(121)])await assert.rejects(library.add({id:first.id,modelPath,name}),/nom/i);
});
test('editing model paths replaces that profile and preserves other saved LLMs',async t=>{
 const {models,library}=await fixture(t),a=await gguf(join(models,'A'),'main.gguf'),b=await gguf(join(models,'B'),'main.gguf'),c=await gguf(join(models,'C'),'main.gguf');
 const one=await library.add({modelPath:a}),two=await library.add({modelPath:b});const changed=await library.add({id:one.id,modelPath:c,name:'C custom'});
 assert.equal((await library.list()).length,2);assert.equal((await library.get(changed.id)).name,'C custom');assert.equal((await library.get(two.id)).modelPath,b);await assert.rejects(library.get(one.id),{status:404});
 await assert.rejects(library.add({id:two.id,modelPath:c,name:'Duplicate'}),{status:409});
});
