import test from'node:test';import assert from'node:assert/strict';import{ToolRuntime}from'../lib/tool-runtime.mjs';
const id='a1111111-1111-4111-8111-111111111111',png='data:image/png;base64,iVBORw0KGgo=';
function fixture(){
 let enabled=true;const order=[],workflow={id:'wf',name:'Reference workflow',digest:'one',bindings:{prompt:{node:'1',input:'text'},image:{node:'2',input:'image'}}};let upload;
 const resources={activeRecord:async()=>{if(!enabled)throw Error('Inactive resource');return{};},readActive:async()=>{if(!enabled)throw Error('Inactive resource');return{frames:[{url:png}]};}};
 const catalog={read:async()=>workflow,prepare:async(_id,args,options)=>{assert.equal(args.reference_resource,undefined);assert.ok(options.referenceImage);return{workflow,graph:{'1':{class_type:'Text',inputs:{text:args.prompt}}},outputNodes:['3']};}};
 const engine={state:'ready',busy:false,stop:async()=>{order.push('stop');engine.state='stopped';},start:async()=>{order.push('start');engine.state='ready';}};
 const client={status:async()=>({idle:true}),upload:async(bytes)=>{upload=bytes;return{name:'uploaded.png',subfolder:'',type:'input'};},run:async()=>{order.push('generate');return{promptId:'job',outputs:[{filename:'result.png',subfolder:'',type:'output'}]};},free:async()=>{order.push('free');}};
 const runtime=new ToolRuntime({engine,catalog,resources,gallery:{put:async record=>record},getConfig:()=>({enabled:true,autoAllow:false,maxIterations:5}),engineConfig:()=>({}),clientFactory:()=>client});
 const request=()=>runtime.request([{id:'call',type:'function',function:{name:'comfy_generate_image',arguments:JSON.stringify({workflow_id:'wf',prompt:'A reference image',reference_resource:id})}}],{conversationId:id,turnId:id,messages:[]});
 return{runtime,request,order,disable:()=>{enabled=false;},uploaded:()=>upload};
}
test('an approved Comfy workflow can use an active library image without treating its ID as a graph input',async()=>{
 const f=fixture(),pending=await f.request();assert.equal(pending.args.reference_resource,id);await f.runtime.execute({requestId:pending.requestId,permission:'once'});await f.runtime.finished;assert.deepEqual(f.order,['stop','generate','free','start']);assert.deepEqual(f.uploaded(),Buffer.from(png.split(',')[1],'base64'));assert.equal(f.runtime.job.record.parameters.reference_resource,id);assert.equal(f.runtime.job.record.parameters.comfy_prompt_id,'job');
});
test('deactivation after approval preparation prevents Comfy execution and leaves the model loaded',async()=>{
 const f=fixture(),pending=await f.request();f.disable();await assert.rejects(f.runtime.execute({requestId:pending.requestId,permission:'once'}),/Inactive/);assert.deepEqual(f.order,[]);
});
