import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,delimiter} from 'node:path';
import {Engine,nativeEnvironment} from '../lib/engine.mjs';
import {openBrowser,createApplication} from '../server.mjs';
import {ModelLibrary} from '../lib/models.mjs';

test('native library lookup follows the selected engine and preserves the parent environment',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'atelier-native été '));t.after(()=>rm(directory,{recursive:true,force:true}));
 const enginePath=join(directory,process.platform==='win32'?'llama-server.exe':'llama-server'),cuda=join(directory,'cuda_v12');await mkdir(cuda);const library=join(cuda,process.platform==='win32'?'ggml-cuda.dll':'libggml-cuda.so');await writeFile(library,'fixture');
 const environment={PATH:join(directory,'previous-bin'),LD_LIBRARY_PATH:join(directory,'previous-lib')},before={...environment},env=await nativeEnvironment({enginePath,gpuLayers:999},environment);
 assert.deepEqual(environment,before);assert.equal(env.GGML_BACKEND_PATH,library);assert.deepEqual(env.PATH.split(delimiter),[cuda,directory,environment.PATH]);
 if(process.platform==='linux')assert.deepEqual(env.LD_LIBRARY_PATH.split(delimiter),[cuda,directory,environment.LD_LIBRARY_PATH]);else assert.equal(env.LD_LIBRARY_PATH,environment.LD_LIBRARY_PATH);
 const cpu=await nativeEnvironment({enginePath,gpuLayers:0},{});assert.equal(cpu.GGML_BACKEND_PATH,undefined);assert.equal(cpu.PATH,directory);if(process.platform==='linux')assert.equal(cpu.LD_LIBRARY_PATH,directory);
 const custom=join(directory,'custom-backend'),preserved=await nativeEnvironment({enginePath,gpuLayers:999},{GGML_BACKEND_PATH:custom,PATH:directory});assert.equal(preserved.GGML_BACKEND_PATH,custom);assert.equal(preserved.PATH,directory);
});

test('a Linux engine without execute permission fails before launching a process',{skip:process.platform!=='linux'},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'atelier-permissions-'));t.after(()=>rm(directory,{recursive:true,force:true}));const enginePath=join(directory,'llama-server');await writeFile(enginePath,'not executable',{mode:0o600});
 const engine=new Engine({spawnProcess:()=>assert.fail('An inaccessible engine must never be started')});await assert.rejects(engine.start({enginePath,modelPath:join(directory,'model.gguf'),projectorPath:'',gpuLayers:0}),/non exécutable.*chmod/);assert.equal(engine.state,'error');
});

test('browser opening uses native commands without a shell and reports headless or missing handlers',()=>{
 for(const platform of ['win32','linux']){
  const calls=[],messages=[],child=new EventEmitter();let unreferenced=false;child.unref=()=>{unreferenced=true;};const url='http://127.0.0.1:8787';
  openBrowser(url,{platform,spawnProcess:(command,args,options)=>{calls.push({command,args,options});return child;},report:message=>messages.push(message)});
  assert.equal(calls[0].command,platform==='win32'?'rundll32.exe':'xdg-open');assert.equal(calls[0].args.at(-1),url);assert.equal(calls[0].options.shell,false);assert.equal(calls[0].options.windowsHide,true);assert.equal(unreferenced,true);
  child.emit('exit',3);child.emit('error',Object.assign(Error('missing'),{code:'ENOENT'}));assert.equal(messages.length,1);assert.ok(messages[0].includes(url));
 }
});

test('successful browser opening stays silent',()=>{
 const child=new EventEmitter();child.unref=()=>{};openBrowser('http://127.0.0.1:8787',{spawnProcess:()=>child,report:()=>assert.fail('A successful browser does not need a fallback')});child.emit('exit',0);
});

test('saved profiles from another OS stay readable without rewriting paths or blocking startup',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'atelier-moved-install-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const foreign=process.platform==='win32'?'/home/another-user/models/Foreign model':'C:\\Users\\another-user\\models\\Foreign model',separator=process.platform==='win32'?'/':'\\';
 const modelPath=foreign+separator+'model.gguf',projectorPath=foreign+separator+'mmproj.gguf',saved=JSON.stringify({version:1,models:[{name:'My saved model',modelPath,projectorPath}]}),path=join(directory,'models.json');await writeFile(path,saved);
 const library=new ModelLibrary(path,join(directory,'models')),profiles=await library.list();assert.equal(profiles[0].modelPath,modelPath);assert.equal(profiles[0].projectorPath,projectorPath);assert.equal(profiles[0].name,'My saved model');assert.equal(await readFile(path,'utf8'),saved);
 await assert.rejects(library.get(profiles[0].id));assert.equal(await readFile(path,'utf8'),saved);
 const app=await createApplication({port:0,dataDir:directory});t.after(()=>app.close());const response=await fetch(app.url+'/api/bootstrap');assert.equal(response.status,200);assert.equal((await response.json()).models[0].modelPath,modelPath);
});
