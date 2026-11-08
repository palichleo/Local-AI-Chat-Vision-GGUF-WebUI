import test from 'node:test';import assert from 'node:assert/strict';
import {setupGenerationUI} from '../public/generation-ui.mjs';
class Element{constructor(tag='',cls='',text=''){Object.assign(this,{tag,cls,textContent:text,children:[],style:{},attributes:{},classList:{add(){}}});}append(...items){this.children.push(...items);}replaceChildren(...items){this.children=items;}setAttribute(key,value){this.attributes[key]=value;}removeAttribute(key){delete this[key];delete this.attributes[key];}}
test('organic frame uses the known size and is replaced by an original blob outside the model payload',async()=>{
 const container=new Element(),original=new Blob(['full original bytes'],{type:'image/png'}),api=async()=>{throw Error('No request expected');};let opened;
 const ui=setupGenerationUI({api,node:(...args)=>new Element(...args),openOutput:(...args)=>{opened=args;}}),card=ui.mount(container,{resolution:{width:1536,height:1024}}),frame=container.children[0].children[0];
 assert.equal(frame.style.aspectRatio,'1536 / 1024');assert.equal(frame.attributes['aria-busy'],'true');card.progress('{"state":"running","promptId":"private"}');assert.equal(container.children[0].children[1].children[0].textContent,'Génération de l’image…');
 const record={id:'run',workflowName:'Custom',prompt:'Prompt',parameters:{reference_count:2}};card.image({record,index:0,blob:original});const button=frame.children[0],img=button.children[0];assert.match(img.src,/^blob:/);assert.equal(await(await fetch(img.src)).text(),'full original bytes');
 img.naturalWidth=1536;img.naturalHeight=1024;img.onload();button.onclick();assert.deepEqual(opened,[record,0,original]);assert.equal(frame.attributes['aria-busy'],'false');card.finish({record});
 const url=img.src;ui.clear();await assert.rejects(fetch(url));assert.doesNotMatch(JSON.stringify(record),/blob:|full original/);
});
test('restored chat resolves the saved Comfy output and releases display blobs when conversation changes',async()=>{
 const container=new Element(),requests=[],record={id:'run',conversationId:'conversation',workflowName:'Custom',prompt:'Prompt',parameters:{},outputs:[{source:{filename:'original.png'}}]};
 const ui=setupGenerationUI({node:(...args)=>new Element(...args),openOutput(){},api:async(route)=>{requests.push(route);return route.endsWith('/0')?new Response('original bytes',{headers:{'content-type':'image/png'}}):Response.json(record);}});
 ui.restore(container,'conversation','run');await new Promise(setImmediate);assert.deepEqual(requests,['gallery/conversation/run','gallery/conversation/run/0']);const img=container.children[0].children[0].children[0].children[0];assert.equal(await(await fetch(img.src)).text(),'original bytes');ui.clear();
});

test('restoring a long conversation defers originals, serializes transfers and revokes offscreen blobs',async t=>{
 const previous=globalThis.IntersectionObserver;let observed;
 globalThis.IntersectionObserver=class{constructor(callback){this.callback=callback;this.targets=new Set();observed=this;}observe(target){this.targets.add(target);}unobserve(target){this.targets.delete(target);}};
 t.after(()=>{globalThis.IntersectionObserver=previous;});
 const record={id:'run',conversationId:'conversation',workflowName:'Custom',prompt:'Prompt',parameters:{},outputs:[0,1].map(i=>({source:{filename:i+'.png'},width:1024,height:1024,analysisDataUrl:'compressed-preview'}))};
 const calls=[],gates=[],container=new Element();
 const ui=setupGenerationUI({node:(...args)=>new Element(...args),openOutput(){},api:async(route,_,options)=>{calls.push(route);if(route==='gallery/conversation/run')return Response.json(record);return new Promise((resolve,reject)=>{gates.push(()=>resolve(new Response('original bytes',{headers:{'content-type':'image/png'}})));options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});}});
 ui.restore(container,'conversation','run');await new Promise(setImmediate);assert.equal(calls.length,0,'offscreen history must not fetch originals');
 observed.callback([{target:container.children[0],isIntersecting:true}]);await new Promise(setImmediate);assert.equal(calls.length,1);
 const frame=container.children[0].children[0],[first,second]=frame.children;
 observed.callback([{target:first,isIntersecting:true},{target:second,isIntersecting:true}]);await new Promise(setImmediate);assert.equal(calls.length,2,'only one original transfers at a time');
 gates[0]();await new Promise(setImmediate);assert.equal(calls.length,3);const url=first.children[0].src;assert.match(url,/^blob:/);
 observed.callback([{target:first,isIntersecting:false}]);await assert.rejects(fetch(url));assert.equal(first.children[0].src,'compressed-preview');
 ui.clear();await new Promise(setImmediate);assert.equal(observed.targets.size,0);gates[1]();await new Promise(setImmediate);
 assert.doesNotMatch(second.children[0].src||'',/^blob:/,'late completion cannot resurrect a disposed original');
});

test('video output uses the original streaming URL, has controls, and never buffers a full clip in the chat',async()=>{
 const container=new Element(),record={id:'run',conversationId:'conversation',mediaType:'video',workflowName:'Motion',prompt:'Slow pan',parameters:{stage:'draft'},outputs:[{source:{filename:'clip.mp4'},originalUrl:'/media/generated/signed'}]};let opened;
 const ui=setupGenerationUI({node:(...args)=>new Element(...args),openOutput:(...args)=>opened=args,api:async()=>{throw Error('No full-video blob transfer expected');}}),card=ui.mount(container,{mediaType:'video',plan:{stage:'draft'}});
 card.image({record,index:0});record.outputs[0].analysisDataUrl='compressed-preview';card.finish({record});const frame=container.children[0].children[0],wrapper=frame.children[0],video=wrapper.children.find(node=>node.tag==='video');assert.ok(video);assert.equal(video.poster,'compressed-preview');assert.equal(video.controls,true);assert.equal(video.preload,'none');assert.equal(video.src,'/media/generated/signed');assert.match(container.children[0].children[1].children[0].textContent,/Brouillon/);wrapper.children.find(node=>node.tag==='button').onclick();assert.deepEqual(opened,[record,0]);ui.clear();assert.equal(video.src,undefined);
});
