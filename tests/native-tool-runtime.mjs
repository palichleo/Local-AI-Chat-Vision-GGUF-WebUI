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
