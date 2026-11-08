import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {readSSE} from '../public/stream.mjs';
const png='data:image/png;base64,iVBORw0KGgo=';
const call={id:'call_1',type:'function',function:{name:'comfy_generate_image',arguments:'{"workflow_id":"photo","prompt":"cat"}'}};
async function exchange({vision=true,ready=true,images=[png],failed=false,denied=false,hasRecord=true,readResourceDuringReview=false}={}){
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const element=()=>({value:'',disabled:false,hidden:false,textContent:'',classList:{add(){}},replaceChildren(){},remove(){},focus(){}});
 const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};$('prompt').value='Generate a cat';
 const status={state:ready?'ready':'error',vision,busy:false};
 const state={config:{enginePath:'engine',modelPath:'model'},messages:[],images:[],status:{state:'ready',vision:true,busy:false},thinking:true,comfy:{maxIterations:5}};
 const requests=[],reviews=[],views=[];
 const context={generationUI:{mount:()=>({progress(){},image(){},finish(){},fail(){}})},assetsUI:{flush:async()=>true},state,$,AbortController,performance,crypto:{randomUUID:()=> 'a1111111-1111-4111-8111-111111111111'},readSSE,
  node:()=>element(),userMessage:()=>element(),assistantMessage:()=>{const view={article:element(),reasoning:element(),thoughts:element(),body:element(),note:element()};views.push(view);return view;},
  contextMeter:{pause(){},observe(){}},renderAttachments(){},resizePrompt(){},notice(){},scrollToBottom(){},renderText(){},updateControls(){},openSettings(){},persistConversation:async()=>true,waitForModel:async()=>{},historyWrite:Promise.resolve(),refreshStatus:async()=>{},setConversationTitle(){},
  comfyUI:{requestTool:async()=>({content:JSON.stringify({status:denied?'denied':failed?'generated':'success'}),images,failed,denied,error:failed?'Model restart failed':'',...(denied||!hasRecord?{}:{record:{id:'run',conversationId:state.conversationId}})}),saveReview:async(...args)=>reviews.push(args)},
  api:async(route,body)=>{
   if(route==='status')return Response.json(status);
   if(route==='resources/read')return Response.json({id:'library',name:'Reference',description:'Visual reference',mime:'image/png',width:1,height:1,frames:[{url:png,time:null}]});
   assert.equal(route,'chat');requests.push(body);
   const events=requests.length===1?[{choices:[{delta:{},finish_reason:'tool_calls'}]},{local_tool_request:{call,workflowName:'Photo'}}]:readResourceDuringReview&&requests.length===2?[{choices:[{delta:{},finish_reason:'tool_calls'}]},{local_tool_request:{kind:'resource',resourceId:'library',workflowName:'Reference',call:{id:'read_reference',type:'function',function:{name:'local_read_resource',arguments:'{"resource_id":"library"}'}}}}]:[{choices:[{delta:{content:'Result explained'},finish_reason:'stop'}]}];
   return new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join('')+'data: [DONE]\n\n');
  }};
 const fn=source.slice(source.indexOf('async function sendMessage('),source.indexOf('setupMaterialLighting(document.'));
 const helpers=source.slice(source.indexOf('function userContent('),source.indexOf('async function sendMessage('));
 runInNewContext(helpers+fn+'\nthis.sendMessage=sendMessage;',context);await context.sendMessage({preventDefault(){}});
 return {state,requests,reviews,views};
}

test('without vision, generated outputs are explained without marking them visually reviewed',async()=>{
 const result=await exchange({vision:false});assert.equal(result.reviews.length,0);assert.equal(result.requests.length,2);
});
test('unavailable copies are distinguished from a model without vision',async()=>{
 const result=await exchange({images:[],failed:true});
 const last=result.requests[1].messages.at(-1).content[0].text;
 assert.match(last,/copies|analyse.*indisponible/i);assert.doesNotMatch(last,/ne disposes pas de la vision/);assert.equal(result.reviews.length,0);
});
test('a failed reload keeps the produced tool result and does not request a completion from a stopped engine',async()=>{
 const result=await exchange({ready:false,failed:true});assert.equal(result.requests.length,1);
 assert.ok(result.state.messages.some(m=>m.role==='tool'&&m.content.includes('generated')));
 assert.match(result.views.at(-1).note.textContent,/restart failed/);
});
test('successful vision reviews and explicit denial retain the native conversation protocol',async()=>{
 const result=await exchange();assert.equal(result.reviews.length,1);assert.equal(result.requests[1].messages.at(-1).internal,true);
 const denied=await exchange({denied:true,images:[]});assert.equal(denied.requests[1].tools,false);assert.equal(denied.reviews.length,0);
 assert.ok(denied.state.messages.some(m=>m.role==='tool'&&m.tool_call_id===call.id&&m.content.includes('denied')));
});

test('a failed generation without output checks engine readiness before continuing the chat',async()=>{
 const result=await exchange({ready:false,failed:true,images:[],hasRecord:false});assert.equal(result.requests.length,1);assert.match(result.views.at(-1).note.textContent,/restart failed/);
});

test('a resource lookup during image review preserves the generated image analysis until comparison completes',async()=>{const result=await exchange({readResourceDuringReview:true});assert.equal(result.requests.length,3);assert.equal(result.reviews.length,1);assert.equal(result.reviews[0][1],'Result explained');assert.equal(result.reviews[0][2],'reviewed');});
