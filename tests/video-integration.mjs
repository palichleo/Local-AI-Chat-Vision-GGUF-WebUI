import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createApplication} from '../server.mjs';
const fixture=fileURLToPath(new URL('./fixtures/fake-tool-engine.mjs',import.meta.url));
test('native video HTTP flow requires confirmation, alternates engines and serves signed range originals', {timeout:30000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'atelier-video-http-')),events=[],children=new Set();let app;
 const bytes=Buffer.from('000000186674797069736f6d0000020069736f6d6d703432','hex'),source={filename:'motion.mp4',subfolder:'clips',type:'output'};
 const comfy=http.createServer(async(req,res)=>{const url=new URL(req.url,'http://127.0.0.1'),chunks=[];for await(const chunk of req)chunks.push(chunk);const json=value=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(url.pathname==='/system_stats')return json({devices:[{type:'cuda',torch_vram_total:0,torch_vram_free:0}]});
  if(url.pathname==='/queue')return json({queue_running:[],queue_pending:[]});
  if(url.pathname==='/prompt'){events.push('comfy:submit');const graph=JSON.parse(Buffer.concat(chunks)).prompt;assert.equal(graph['1'].inputs.text,'A slow camera pan over a red boat');return json({prompt_id:'motion-job'});}
  if(url.pathname==='/history/motion-job')return json({'motion-job':{status:{completed:true},outputs:{'3':{gifs:[{...source,format:'video/h264-mp4',fullpath:'private-comfy-path'}]}}}});
  if(url.pathname==='/free'){events.push('comfy:free');return json({});}
  if(url.pathname==='/view'){assert.equal(url.searchParams.get('filename'),'motion.mp4');const match=req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);if(match){const start=Number(match[1]),end=Number(match[2]);res.writeHead(206,{'Content-Type':'video/mp4','Content-Length':end-start+1,'Content-Range':'bytes '+start+'-'+end+'/'+bytes.length});return res.end(bytes.subarray(start,end+1));}res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':bytes.length});return res.end(bytes);}
  res.writeHead(404);res.end();
 });await new Promise(done=>comfy.listen(0,'127.0.0.1',done));
 t.after(async()=>{await app?.close();for(const child of children)child.kill();comfy.closeAllConnections();await new Promise(done=>comfy.close(done));await rm(directory,{recursive:true,force:true});});
 const modelPath=join(directory,'smoke.gguf');await writeFile(modelPath,Buffer.from('GGUF\x03\0\0\0'));
 app=await createApplication({port:0,dataDir:directory,spawnProcess:(_command,args,options)=>{events.push('engine:start');const child=spawn(process.execPath,[fixture,...args],options);children.add(child);child.once('exit',()=>{events.push('engine:exit');children.delete(child);});return child;}});
 const {token}=await(await fetch(app.url+'/api/bootstrap')).json();const api=async(path,body,status=200)=>{const response=await fetch(app.url+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.equal(response.status,status,await(response.status===status?Promise.resolve(''):response.clone().text()));return response;};
 await api('config',{enginePath:process.execPath,modelPath,projectorPath:'',contextSize:8192,maxOutputTokens:4096,gpuLayers:0});
 await api('comfy/import',{id:'integration-motion',name:'Custom user video',description:'Short draft/final camera motion.',mediaType:'video',videoStages:['draft','final'],graph:{'1':{class_type:'Prompt',inputs:{text:'original'}},'2':{class_type:'Motion',inputs:{text:['1',0],frames:81,fps:16,seed:123,width:768,height:512}},'3':{class_type:'CustomSave',inputs:{movie:['2',0]}}},bindings:{prompt:{node:'1',input:'text'},frames:{node:'2',input:'frames'},fps:{node:'2',input:'fps'},seed:{node:'2',input:'seed'},width:{node:'2',input:'width'},height:{node:'2',input:'height'}},outputNodes:['3']});
 await api('comfy/config',{enabled:true,autoAllow:true,baseUrl:'http://127.0.0.1:'+comfy.address().port,maxIterations:5});await api('start',{},202);
 async function until(read){const deadline=Date.now()+15000;while(Date.now()<deadline){const result=await read();if(result)return result;await new Promise(done=>setTimeout(done,30));}assert.fail('Video test timed out');}
 await until(async()=> (await(await api('status')).json()).state==='ready');
 const conversationId=randomUUID(),response=await api('chat',{conversationId,turnId:randomUUID(),messages:[{role:'user',content:'generate video draft'}]});
 const eventsSSE=(await response.text()).split(/\r?\n\r?\n/).filter(text=>text.startsWith('data: ')&&text!=='data: [DONE]').map(text=>JSON.parse(text.slice(6))),request=eventsSSE.find(event=>event.local_tool_request)?.local_tool_request;
 assert.ok(request?.approvalToken,JSON.stringify(eventsSSE));assert.equal(request.autoAllow,false);assert.equal(request.plan.parameters.seed,123);assert.ok(!events.includes('engine:exit'));assert.ok(!events.includes('comfy:submit'));
 await api('tools/execute',{requestId:request.requestId},403);await api('tools/execute',{requestId:request.requestId,permission:'always',approvalToken:request.approvalToken},403);assert.ok(!events.includes('comfy:submit'));
 await api('tools/execute',{requestId:request.requestId,permission:'once',approvalToken:request.approvalToken},202);
 const job=await until(async()=>{const job=await(await api('tools/job')).json();return ['done','error'].includes(job.state)?job:null;});assert.equal(job.state,'done',job.error);assert.ok(events.indexOf('engine:exit')<events.indexOf('comfy:submit'));assert.ok(events.indexOf('comfy:free')<events.lastIndexOf('engine:start'));
 const record=job.record;assert.equal(record.mediaType,'video');assert.equal(record.parameters.stage,'draft');assert.equal(record.outputs[0].source.fullpath,undefined);const url=new URL(record.outputs[0].originalUrl,app.url);
 const original=await fetch(url);assert.equal(original.status,200);assert.deepEqual(Buffer.from(await original.arrayBuffer()),bytes);
 const range=await fetch(url,{headers:{Range:'bytes=12-19'}});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),bytes.subarray(12,20));
 url.searchParams.set('key','0'.repeat(64));assert.equal((await fetch(url)).status,401);
 const image='data:image/png;base64,iVBORw0KGgo=';await api('gallery/analysis',{conversationId,id:record.id,images:[image],dimensions:[{width:768,height:512}],frames:[[{time:0,url:image},{time:2,url:image}]]});
 const restored=await(await api('gallery/'+conversationId+'/'+record.id)).json();assert.equal(restored.outputs[0].analysisFrames.length,2);assert.ok(restored.outputs[0].originalUrl.startsWith('/media/generated/'));await api('tools/execute',{requestId:request.requestId,permission:'once',approvalToken:request.approvalToken},409);
});
