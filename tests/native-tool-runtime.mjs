import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolRuntime} from '../lib/tool-runtime.mjs';
const id='a1111111-1111-4111-8111-111111111111';
test('native immutable job keeps random seed through authorization and GPU handoff',async()=>{
 const events=[];let preparation=0,saved;
 const workflow={schemaVersion:1,id:'image',name:'Image',description:'',digest:'a'.repeat(64),mediaType:'image',parameters:{},references:[]};
 const catalog={kind:'native',read:async()=>workflow,prepare:async()=>{
  preparation++;return {workflow,job:{schemaVersion:1,id,pipeline:'krea2',mediaType:'image',workflowId:'image',workflowDigest:workflow.digest,
   parameters:{prompt:'boat',seed:123,width:512,height:512},components:{},loras:[],references:[]},outputNodes:[]};
 }};
 const engine={busy:false,state:'ready',stop:async()=>{events.push('llm stopped');engine.state='stopped';},start:async()=>{events.push('llm started');engine.state='ready';}};
 const client={status:async()=>({idle:true}),preflight:async job=>{events.push('preflight');assert.equal(job.parameters.seed,123);},run:async job=>{
  events.push('generate');assert.equal(engine.state,'stopped');assert.equal(job.parameters.seed,123);return {outputs:[{filename:'image.png',subfolder:'',type:'output'}]};
 },free:async()=>events.push('gpu released')};
 const runtime=new ToolRuntime({engine,catalog,gallery:{put:async record=>{saved=record;return record;}},getConfig:()=>({enabled:true,autoAllow:false,maxIterations:5,baseUrl:'native'}),engineConfig:()=>({}),clientFactory:()=>client});
 const call={id:'call',type:'function',function:{name:'generate_image',arguments:JSON.stringify({workflow_id:'image',prompt:'boat'})}};
 const request=await runtime.request([call],{conversationId:id,turnId:id,messages:[{role:'user',content:'boat'}]});
 await runtime.execute({requestId:request.requestId,permission:'once'});await runtime.finished;
 assert.equal(runtime.status().state,'done',runtime.status().error);assert.equal(preparation,1);assert.equal(saved.provider,'native');assert.equal(saved.parameters.seed,123);
 assert.deepEqual(events,['preflight','llm stopped','generate','gpu released','llm started']);
});

test('native video approval shows the resolved fixed stage and cannot use global image authorization',async()=>{
 const workflow={schemaVersion:1,id:'video',name:'Video',digest:'b'.repeat(64),mediaType:'video',parameters:{},references:[]};
 const catalog={kind:'native',read:async()=>workflow,prepare:async()=>({workflow,job:{parameters:{prompt:'locked prompt',stage:'draft',seed:41,width:384,height:256},references:[],loras:[]},outputNodes:[]})};
 let calls=0;
 const runtime=new ToolRuntime({catalog,engine:{state:'ready',stop:async()=>{},start:async()=>{}},gallery:{put:async record=>record},
  getConfig:()=>({enabled:true,autoAllow:true,maxIterations:5,baseUrl:'native'}),engineConfig:()=>({}),clientFactory:()=>({status:async()=>({idle:true}),preflight:async()=>{},run:async()=>{calls++;return {outputs:[{filename:'video.mp4',subfolder:'',type:'output'}]};},free:async()=>{}})});
 const request=await runtime.request([{id:'video-call',type:'function',function:{name:'generate_video',arguments:JSON.stringify({workflow_id:'video',intention:'Test'})}}],{conversationId:id,turnId:id,messages:[]});
 assert.equal(request.autoAllow,false);assert.equal(request.args.stage,'draft');assert.equal(request.plan.stage,'draft');assert.equal(request.plan.prompt,'locked prompt');assert.equal(request.plan.parameters.seed,41);
 await assert.rejects(runtime.execute({requestId:request.requestId,permission:'always',approvalToken:request.approvalToken}));
 await assert.rejects(runtime.execute({requestId:request.requestId,permission:'once',approvalToken:'wrong'}));assert.equal(calls,0);
 await runtime.execute({requestId:request.requestId,permission:'once',approvalToken:request.approvalToken});await runtime.finished;assert.equal(calls,1);assert.equal(runtime.status().state,'done');
 await assert.rejects(runtime.execute({requestId:request.requestId,permission:'once',approvalToken:request.approvalToken}));
});

test('native continuation stages the original video instead of a sampled image',async()=>{
 let closed=0,staged=0,generated;const sourceId='22222222-2222-4222-8222-222222222222';
 const workflow={schemaVersion:1,id:'continue',name:'Continue',mediaType:'video',digest:'c'.repeat(64),references:[{id:'source',role:'source_video',required:true}]};
 const catalog={kind:'native',read:async()=>workflow,prepare:async()=>({workflow,job:{parameters:{prompt:'continue',seed:2,stage:'draft',width:384,height:256},components:{},loras:[],references:[]},outputNodes:[]})};
 const runtime=new ToolRuntime({catalog,engine:{state:'ready',stop:async()=>{},start:async()=>{}},gallery:{put:async record=>record},
  getConfig:()=>({enabled:true,autoAllow:true,maxIterations:5,baseUrl:'native'}),engineConfig:()=>({}),
  sourceMedia:async(ref,conversation)=>{assert.equal(ref.output_id,sourceId);assert.equal(conversation,id);return {mime:'video/mp4',name:'Previous output',handle:{close:async()=>closed++}};},
  clientFactory:()=>({status:async()=>({idle:true}),preflight:async()=>{},stage:async media=>{staged++;await media.handle.close();return {path:'/local/staged-source.mp4'};},upload:()=>assert.fail('Must not upload sampled pixels'),run:async job=>{generated=job;return {outputs:[{filename:'new.mp4',subfolder:'',type:'output'}]};},free:async()=>{}})});
 const request=await runtime.request([{id:'continue-call',type:'function',function:{name:'generate_video',arguments:JSON.stringify({workflow_id:'continue',intention:'Continue',references:[{input:'source',output_id:sourceId}]})}}],{conversationId:id,turnId:id,messages:[]});
 await runtime.execute({requestId:request.requestId,permission:'once',approvalToken:request.approvalToken});await runtime.finished;
 assert.equal(runtime.status().state,'done');assert.equal(staged,1);assert.equal(closed,2);assert.deepEqual(generated.references,[{input:'source',role:'source_video',path:'/local/staged-source.mp4'}]);
});

test('draft promotion retains seed and writable choices while final profile remains reviewable',async()=>{
 const draftId='33333333-3333-4333-8333-333333333333',components={model:'/local/model.safetensors'};
 const workflow={schemaVersion:1,id:'film',name:'Film',mediaType:'video',digest:'d'.repeat(64),references:[],profiles:{final:{parameters:{width:768,height:512}}}};let options,args;
 const prior={provider:'native',mediaType:'video',workflowId:'film',prompt:'same prompt',parameters:{workflow_digest:workflow.digest,stage:'draft',seed:987,native_components:components,replay_args:{workflow_id:'film',prompt:'same prompt',stage:'draft',loras:{style:{enabled:true,strength:0.7}}}}};
 const catalog={kind:'native',read:async()=>workflow,prepare:async(_id,a,o)=>{args=a;options=o;return {workflow,job:{parameters:{prompt:a.prompt,seed:o.seed,stage:a.stage,width:768,height:512},components,loras:[],references:[]},outputNodes:[]};}};
 const runtime=new ToolRuntime({catalog,gallery:{get:async(conversation,run)=>{assert.equal(conversation,id);assert.equal(run,draftId);return prior;}},getConfig:()=>({enabled:true,maxIterations:5,baseUrl:'native'}),engine:{},engineConfig:()=>({})});
 const call=changes=>[{id:'final-call',type:'function',function:{name:'generate_video',arguments:JSON.stringify({workflow_id:'film',reuse_output:draftId,stage:'final',intention:'Final version',...changes})}}];
 const request=await runtime.request(call(),{conversationId:id,turnId:id,messages:[]});
 assert.equal(options.seed,987);assert.equal(request.plan.parameters.width,768);assert.equal(args.prompt,'same prompt');assert.deepEqual(args.loras,prior.parameters.replay_args.loras);
 await assert.rejects(runtime.request(call({prompt:'different'}),{conversationId:id,turnId:id,messages:[]}));
});
