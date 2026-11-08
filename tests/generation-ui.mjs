import test from 'node:test';import assert from 'node:assert/strict';
import {setupGenerationUI} from '../public/generation-ui.mjs';
class Element{constructor(tag='',cls='',text=''){Object.assign(this,{tag,cls,textContent:text,children:[],style:{},attributes:{},classList:{add(){}}});}append(...items){this.children.push(...items);}replaceChildren(...items){this.children=items;}setAttribute(key,value){this.attributes[key]=value;}}
test('organic frame uses the known size and is replaced by an original blob outside the model payload',async()=>{
 const container=new Element(),original=new Blob(['full original bytes'],{type:'image/png'}),api=async()=>{throw Error('No request expected');};let opened;
 const ui=setupGenerationUI({api,node:(...args)=>new Element(...args),openOutput:(...args)=>{opened=args;}}),card=ui.mount(container,{resolution:{width:1536,height:1024}}),frame=container.children[0].children[0];
 assert.equal(frame.style.aspectRatio,'1536 / 1024');assert.equal(frame.attributes['aria-busy'],'true');card.progress('{"state":"running","promptId":"private"}');assert.equal(container.children[0].children[1].children[0].textContent,'Génération de l’image…');
 const record={id:'run',workflowName:'Custom',prompt:'Prompt',parameters:{reference_count:2}};card.image({record,index:0,blob:original});const button=frame.children[0],img=button.children[0];assert.match(img.src,/^blob:/);assert.equal(await(await fetch(img.src)).text(),'full original bytes');
 img.naturalWidth=1536;img.naturalHeight=1024;img.onload();button.onclick();assert.deepEqual(opened,[record,0,original]);assert.equal(frame.attributes['aria-busy'],'false');card.finish({record});
 const url=img.src;ui.clear();await assert.rejects(fetch(url));assert.doesNotMatch(JSON.stringify(record),/blob:|full original/);
});
test('restored chat resolves the saved Comfy output and releases display blobs when conversation changes',async()=>{
 const container=new Element(),requests=[],record={id:'run',workflowName:'Custom',prompt:'Prompt',parameters:{},outputs:[{source:{filename:'original.png'}}]};
 const ui=setupGenerationUI({node:(...args)=>new Element(...args),openOutput(){},api:async(route)=>{requests.push(route);return route.endsWith('/0')?new Response('original bytes',{headers:{'content-type':'image/png'}}):Response.json(record);}});
 ui.restore(container,'conversation','run');await new Promise(setImmediate);assert.deepEqual(requests,['gallery/conversation/run','gallery/conversation/run/0']);const img=container.children[0].children[0].children[0].children[0];assert.equal(await(await fetch(img.src)).text(),'original bytes');ui.clear();
});
