import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
const project=fileURLToPath(new URL('../',import.meta.url));
async function until(check,label){const end=Date.now()+20000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,40));}assert.fail(label||'Expected launcher state was not reached');}
async function freePort(){const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port;}
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'atelier-launcher espace-'));assert.equal(dirname(root),tmpdir());
 for(const name of ['lib','public','scripts','Lancer-Windows.cmd','lancer-linux.sh'])await cp(join(project,name),join(root,name),{recursive:true});
 await mkdir(join(root,'tests/fixtures'),{recursive:true});await cp(join(project,'tests/fixtures/fake-engine.mjs'),join(root,'tests/fixtures/fake-engine.mjs'));
 let server=await readFile(join(project,'server.mjs'),'utf8');
 server=server.replace('updateChecker: ({ signal }) => checkForUpdates({ currentVersion: version, signal }),','updateChecker: null,');
 server=server.replace("const app = await createApplication({ port,", "const app = await createApplication({ port, spawnProcess: (_command,args,options) => { const child=spawn(process.execPath,[join(root,'tests/fixtures/fake-engine.mjs'),...args],options); void writeFile(join(root,'engine.pid'),String(child.pid)); return child; },");
 await writeFile(join(root,'server.mjs'),server);await writeFile(join(root,'package.json'),'{"name":"atelier-local","version":"0.2.0","type":"module"}');
 const port=await freePort(),url=`http://127.0.0.1:${port}`,children=[];
 const boot=async()=>{try{return await(await fetch(url+'/api/bootstrap',{signal:AbortSignal.timeout(500)})).json();}catch{return null;}};
 const api=async(route,body)=>{const current=await boot();return fetch(url+'/api/'+route,{method:'POST',headers:{Authorization:`Bearer ${current?.token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});};
 function launch(native=false){
  const command=native?(process.platform==='win32'?process.env.ComSpec||'cmd.exe':'sh'):process.execPath;
  const args=native?(process.platform==='win32'?['/d','/c','Lancer-Windows.cmd',`--port=${port}`,'--no-open']:['lancer-linux.sh',`--port=${port}`,'--no-open']):['scripts/launch.mjs',`--port=${port}`,'--no-open'];
  const child=spawn(command,args,{cwd:root,stdio:['pipe','pipe','pipe'],windowsHide:true});let output='';for(const pipe of [child.stdout,child.stderr])pipe.on('data',data=>{output=(output+data).slice(-8000);});child.stdin.end();children.push(child);return {child,output:()=>output};
 }
 t.after(async()=>{try{const live=await boot();if(live?.application==='atelier-local')await api('shutdown',{});}catch{}for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill();await until(async()=>!(await boot()),'Test server left its port open');await rm(root,{recursive:true,force:true,maxRetries:15,retryDelay:100});});
 return {root,port,url,boot,api,launch,server};
}
test('native launcher remains open, reuses an existing app and exits after clean UI shutdown',{timeout:30000},async t=>{
 const {launch,boot,api}=await fixture(t),first=launch(true);
 await until(async()=>(await boot())?.controlled,'Native launcher failed: '+first.output());
 const second=launch();await until(async()=>second.child.exitCode!==null,'Second launch did not reuse the app');assert.equal(second.child.exitCode,0,second.output());
 assert.equal(first.child.exitCode,null);assert.equal((await boot()).controlled,true);
 assert.equal((await api('shutdown',{})).status,202);await until(async()=>first.child.exitCode!==null,'Native launcher did not finish');assert.equal(first.child.exitCode,0,first.output());
});
test('losing the controller process releases the port and terminates its model',{timeout:30000},async t=>{
 const {root,launch,boot,api}=await fixture(t),control=launch();await until(async()=>(await boot())?.controlled,control.output());
 const modelPath=join(root,'model.gguf');await writeFile(modelPath,Buffer.from('GGUF\x03\0\0\0'));
 await api('config',{enginePath:process.execPath,modelPath,projectorPath:'',contextSize:4096,maxOutputTokens:1024,gpuLayers:0});await api('start',{});
 await until(async()=>(await boot())?.status.state==='ready','Fake model never started');const pid=Number(await readFile(join(root,'engine.pid'),'utf8'));
 control.child.kill('SIGKILL');await until(async()=>!(await boot()),'Controller left the application listening');
 await until(async()=>{try{process.kill(pid,0);return false;}catch{return true;}},'Controller left its model running');
});
test('native launcher never takes over or kills an unrelated service',{timeout:30000},async t=>{
 const {port,launch}=await fixture(t),other=http.createServer((req,res)=>res.end('{"application":"different-service"}'));
 await new Promise(resolve=>other.listen(port,'127.0.0.1',resolve));
 try{const control=launch(true);await until(async()=>control.child.exitCode!==null,'Launcher did not report occupied port');assert.equal(control.child.exitCode,1,control.output());assert.match(control.output(),/autre service|ancienne instance/);assert.equal((await(await fetch(`http://127.0.0.1:${port}`)).json()).application,'different-service');}
 finally{other.closeAllConnections();await new Promise(resolve=>other.close(resolve));}
});
test('launcher stays attached across an installed update and can close the replacement',{timeout:35000},async t=>{
 const {root,port,launch,boot,api,server}=await fixture(t),workspace=join(root,'data/updates/test-launcher');
 await mkdir(join(workspace,'stage'),{recursive:true});
 for(const name of ['lib','public','scripts'])await cp(join(root,name),join(workspace,'stage',name),{recursive:true});
 await writeFile(join(workspace,'stage/server.mjs'),server);await writeFile(join(workspace,'stage/package.json'),'{"name":"atelier-local","version":"0.3.0","type":"module"}');
 for(const[from,to]of [['lib/update-files.mjs','update-files.mjs'],['lib/update-archive.mjs','update-archive.mjs'],['scripts/apply-update.mjs','worker.mjs']])await cp(join(root,from),join(workspace,to));
 const plan={root,workspace,port,version:'0.3.0',previousVersion:'0.2.0'};await writeFile(join(workspace,'plan.json'),JSON.stringify(plan));
 const initial=server.replace('updateChecker: null,',"updateChecker: async()=>({available:true,version:'0.3.0'}),").replace('prepare: args => prepareUpdate({ ...args, root, currentVersion: version })',`prepare: async()=>JSON.parse(await readFile(${JSON.stringify(join(workspace,'plan.json'))},'utf8'))`);
 await writeFile(join(root,'server.mjs'),initial);const control=launch();await until(async()=>(await boot())?.controlled,control.output());
 assert.equal((await api('updates/install',{session:{messages:[],conversationId:null,prompt:'',images:[],thinking:true,title:'Test'}})).status,202);
 await until(async()=>{const current=await boot();return current?.version==='0.3.0'&&current.controlled;},'Launcher lost replacement: '+control.output());
 assert.equal(control.child.exitCode,null,control.output());
 await until(async()=>{try{return JSON.parse(await readFile(join(root,'data/update-status.json'),'utf8')).state==='done';}catch{return false;}},'Update worker did not finish');
 const replacementPid=JSON.parse(await readFile(join(root,'data/update-status.json'),'utf8')).pid;
 control.child.kill('SIGKILL');await until(async()=>!(await boot()),'Updated application survived a closed controller');
 await until(async()=>{try{process.kill(replacementPid,0);return false;}catch{return true;}},'Replacement server did not exit');
});

test('launcher reconnects after a transient control stream failure instead of closing the app',async()=>{
 const {runLauncher}=await import('../scripts/launch.mjs');let streams=0;
 const server=http.createServer((req,res)=>{
  if(req.url==='/api/bootstrap'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({application:'atelier-local',token:'reconnect-test',controlled:false}));}
  if(req.url==='/api/lifecycle'){streams++;res.writeHead(200,{'content-type':'application/x-ndjson'});res.write('{"state":"running"}\n');const timer=setTimeout(()=>streams===1?res.destroy():res.end('{"state":"stopped"}\n'),40);res.on('close',()=>clearTimeout(timer));return;}
  res.writeHead(404);res.end();
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{await runLauncher({port:server.address().port,signal:AbortSignal.timeout(5000)});assert.equal(streams,2);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
