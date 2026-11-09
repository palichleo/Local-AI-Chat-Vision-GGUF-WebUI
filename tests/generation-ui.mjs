import test from 'node:test';import assert from 'node:assert/strict';
import {setupGenerationUI} from '../public/generation-ui.mjs';
class Element{constructor(tag='',cls='',text=''){const classes=new Set(cls.split(' '));Object.assign(this,{tag,cls,textContent:text,children:[],style:{},attributes:{},classList:{add(...names){for(const name of names)classes.add(name);},remove(...names){for(const name of names)classes.delete(name);},toggle(name,value){if(value)classes.add(name);else classes.delete(name);},contains:name=>classes.has(name)}});}append(...items){this.children.push(...items);}replaceChildren(...items){this.children=items;}setAttribute(key,value){this.attributes[key]=value;}removeAttribute(key){delete this[key];delete this.attributes[key];}}
test('organic frame uses the known size and is replaced by an original blob outside the model payload',async()=>{
 const container=new Element(),original=new Blob(['full original bytes'],{type:'image/png'}),api=async()=>{throw Error('No request expected');};let opened;
 const ui=setupGenerationUI({api,node:(...args)=>new Element(...args),openOutput:(...args)=>{opened=args;}}),card=ui.mount(container,{resolution:{width:1536,height:1024}}),frame=container.children[0].children[0];
 assert.equal(frame.style.aspectRatio,'1536 / 1024');assert.equal(frame.attributes['aria-busy'],'true');card.progress('{"state":"running","promptId":"private"}');const [bar,label]=container.children[0].children[1].children;assert.equal(bar.attributes.role,'progressbar');assert.equal(bar.attributes['aria-label'],'Génération de l’image…');assert.equal(label.classList.contains('sr-only'),true);assert.equal(container.children[0].children[1].children.length,2);
 const record={id:'run',workflowName:'Custom',prompt:'Prompt',parameters:{reference_count:2}};card.image({record,index:0,blob:original});const button=frame.children[0],img=button.children[0];assert.match(img.src,/^blob:/);assert.equal(await(await fetch(img.src)).text(),'full original bytes');
 img.naturalWidth=1536;img.naturalHeight=1024;img.onload();button.onclick();assert.deepEqual(opened,[record,0,original]);assert.equal(frame.attributes['aria-busy'],'false');assert.equal(bar.classList.contains('is-complete'),false);card.finish({record});assert.equal(bar.classList.contains('is-complete'),true);assert.equal(bar.attributes['aria-hidden'],'true');assert.equal(label.classList.contains('sr-only'),false);assert.doesNotMatch(label.textContent,/1536|1024/);
 const completedLabel=label.textContent;card.progress('Late status update');assert.equal(label.textContent,completedLabel);assert.equal(bar.classList.contains('is-complete'),true);
 const url=img.src;ui.clear();await assert.rejects(fetch(url));assert.doesNotMatch(JSON.stringify(record),/blob:|full original/);
});
test('restored chat resolves the saved Comfy output and releases display blobs when conversation changes',async()=>{
 const container=new Element(),requests=[],record={id:'run',conversationId:'conversation',workflowName:'Custom',prompt:'Prompt',parameters:{},outputs:[{source:{filename:'original.png'}}]};
 const ui=setupGenerationUI({node:(...args)=>new Element(...args),openOutput(){},api:async(route)=>{requests.push(route);return route.endsWith('/0')?new Response('original bytes',{headers:{'content-type':'image/png'}}):Response.json(record);}});
 ui.restore(container,'conversation','run');assert.equal(container.children[0].children[1].children[0].hidden,true);await new Promise(setImmediate);assert.deepEqual(requests,['gallery/conversation/run','gallery/conversation/run/0']);const img=container.children[0].children[0].children[0].children[0];assert.equal(await(await fetch(img.src)).text(),'original bytes');ui.clear();
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
 const [first,second]=container.children.map(figure=>figure.children[0].children[0]);
 observed.callback([{target:first,isIntersecting:true},{target:second,isIntersecting:true}]);await new Promise(setImmediate);assert.equal(calls.length,2,'only one original transfers at a time');
 gates[0]();await new Promise(setImmediate);assert.equal(calls.length,3);const url=first.children[0].src;assert.match(url,/^blob:/);
 observed.callback([{target:first,isIntersecting:false}]);await assert.rejects(fetch(url));assert.equal(first.children[0].src,'compressed-preview');
 ui.clear();await new Promise(setImmediate);assert.equal(observed.targets.size,0);gates[1]();await new Promise(setImmediate);
 assert.doesNotMatch(second.children[0].src||'',/^blob:/,'late completion cannot resurrect a disposed original');
});

test('video output uses the original streaming URL, has controls, and never buffers a full clip in the chat',async()=>{
 const container=new Element(),record={id:'run',conversationId:'conversation',mediaType:'video',workflowName:'Motion',prompt:'Slow pan',parameters:{stage:'draft'},outputs:[{source:{filename:'clip.mp4'},originalUrl:'/media/generated/signed'}]};let opened;
 const ui=setupGenerationUI({node:(...args)=>new Element(...args),openOutput:(...args)=>opened=args,api:async()=>{throw Error('No full-video blob transfer expected');}}),card=ui.mount(container,{mediaType:'video',plan:{stage:'draft'}});
 const [bar,label]=container.children[0].children[1].children;card.progress('Génération de la vidéo…');assert.equal(label.classList.contains('sr-only'),true);assert.equal(bar.attributes['aria-label'],'Génération de la vidéo…');card.image({record,index:0});record.outputs[0].analysisDataUrl='compressed-preview';card.finish({record});const frame=container.children[0].children[0],wrapper=frame.children[0],video=wrapper.children.find(node=>node.tag==='video');assert.ok(video);assert.equal(video.poster,'compressed-preview');assert.equal(video.controls,true);assert.equal(video.preload,'none');assert.equal(video.src,'/media/generated/signed');assert.match(label.textContent,/Brouillon/);assert.equal(bar.classList.contains('is-complete'),true);wrapper.children.find(node=>node.tag==='button').onclick();assert.deepEqual(opened,[record,0]);ui.clear();assert.equal(video.src,undefined);
});


test('refused, revised, failed and cancelled generations hide the empty preview and its dimensions',async t=>{
 for(const [name,settle]of [
  ['refused',card=>card.finish({denied:true})],
  ['revised',card=>card.finish({denied:true,revised:true})],
  ['failed',card=>card.finish({failed:true,error:'ComfyUI unavailable'})],
  ['cancelled',card=>card.fail('Generation cancelled')],
  ['missing original',card=>card.finish({record:{outputs:[]}})]
 ])await t.test(name,()=>{
  const container=new Element();let resized=0;
  const ui=setupGenerationUI({node:(...args)=>new Element(...args),api:async()=>{throw Error('No generation expected');},openOutput(){},onResize(){resized++;}}),card=ui.mount(container,{resolution:{width:512,height:512}}),[frame,caption]=container.children[0].children;
  const before=resized;settle(card);assert.equal(frame.hidden,true);assert.equal(caption.children[0].classList.contains('is-complete'),true);assert.ok(caption.children[1].textContent);assert.equal(caption.children[1].classList.contains('sr-only'),false);assert.equal(frame.attributes['aria-busy'],'false');assert.equal(card.finished,true);assert.ok(resized>before);ui.clear();
 });
});

test('an analysis or model reload failure preserves an original that was already produced',t=>{
 const container=new Element(),ui=setupGenerationUI({node:(...args)=>new Element(...args),api:async()=>{throw Error('No request expected');},openOutput(){}});t.after(()=>ui.clear());
 const card=ui.mount(container),record={workflowName:'User workflow',parameters:{},outputs:[{}]};card.image({record,index:0,blob:new Blob(['original'],{type:'image/png'})});const frame=container.children[0].children[0],img=frame.children[0].children[0];
 card.finish({record,failed:true,error:'Analysis unavailable'});assert.notEqual(frame.hidden,true);assert.match(img.src,/^blob:/);card.fail('Model reload failed');assert.notEqual(frame.hidden,true);assert.match(img.src,/^blob:/);
});

test('sequential runs and batch outputs append separate tiles to the same grid without replacing originals',async t=>{
 const container=new Element(),ui=setupGenerationUI({node:(...args)=>new Element(...args),api:async()=>{throw Error('No request expected');},openOutput(){}});t.after(()=>ui.clear());
 const first=ui.mount(container),record={workflowName:'Batch',parameters:{},outputs:[{},{}]},blob=new Blob(['original'],{type:'image/png'});
 first.image({record,index:0,blob});first.image({record,index:1,blob});first.finish({record});
 const second=ui.mount(container,{resolution:{width:768,height:1024}});
 assert.equal(container.children.length,3);assert.equal(container.children[2].children[0].style.aspectRatio,'768 / 1024');
 for(const figure of container.children.slice(0,2)){const frame=figure.children[0];assert.equal(frame.children.length,1);assert.match(frame.children[0].children[0].src,/^blob:/);}
 second.fail('Cancelled');assert.equal(container.children[2].children[0].hidden,true);assert.notEqual(container.children[0].children[0].hidden,true);
});

test('loading animation pauses outside the viewport and observation stops on refusal',t=>{
 const previous=globalThis.IntersectionObserver;let observed;
 globalThis.IntersectionObserver=class{constructor(callback){this.callback=callback;this.targets=new Set();observed=this;}observe(target){this.targets.add(target);}unobserve(target){this.targets.delete(target);}};
 t.after(()=>{globalThis.IntersectionObserver=previous;});
 const container=new Element(),ui=setupGenerationUI({node:(...args)=>new Element(...args),api:async()=>{throw Error('No generation expected');},openOutput(){}});t.after(()=>ui.clear());
 const card=ui.mount(container),figure=container.children[0],frame=figure.children[0];assert.equal(frame.classList.contains('is-paused'),true);
 observed.callback([{target:figure,isIntersecting:true}]);assert.equal(frame.classList.contains('is-paused'),false);
 observed.callback([{target:figure,isIntersecting:false}]);assert.equal(frame.classList.contains('is-paused'),true);card.finish({denied:true});assert.equal(observed.targets.size,0);assert.equal(frame.hidden,true);
});
