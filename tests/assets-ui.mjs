import test from 'node:test';import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';
import{setupAssets}from'../public/assets-ui.mjs';
class Element{
 constructor(tag='div',className='',text=''){Object.assign(this,{tagName:tag.toUpperCase(),className,textContent:text,children:[],attributes:{},dataset:{},value:'',open:false,disabled:false,hidden:false,listeners:{},style:{}});this.classList={toggle(){},add(){},remove(){}};}
 append(...children){this.children.push(...children);}replaceChildren(...children){this.children=[...children];}setAttribute(name,value){this.attributes[name]=value;}removeAttribute(name){delete this.attributes[name];}addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}getBoundingClientRect(){return{left:0,top:0,right:500,bottom:500};}focus(){}pause(){}load(){}click(){}showModal(){this.open=true;}close(){this.open=false;for(const fn of this.listeners.close||[])fn();}contains(){return false;}
}
async function fixture(t){
 const previous=globalThis.document,html=await readFile(new URL('../public/index.html',import.meta.url),'utf8'),nodes=new Map([...html.matchAll(/id="([^"]+)"/g)].map(match=>[match[1],new Element()]));const $=id=>{assert.ok(nodes.has(id),'Missing HTML id '+id);return nodes.get(id);};
 globalThis.document={getElementById:$};t.after(()=>{globalThis.document=previous;});
 let stored=[{id:'one',name:'Reference',mime:'image/png',description:'Light',ready:true,enabled:true,frames:[],originalUrl:'/original',previewUrl:'/preview'}];const calls=[],notices=[];const api=async(route,body,options)=>{calls.push({route,body,options});if(route==='resources')return Response.json({resources:structuredClone(stored)});if(route==='resources/update'){const record=stored.find(item=>item.id===body.id);Object.assign(record,body.patch);return Response.json(record);}if(route==='resources/delete'){stored=stored.filter(item=>item.id!==body.id);return Response.json({deleted:true});}throw Error('Unexpected '+route);};
 const state={resourceWorking:false};const ui=setupAssets({api,state,node:(...args)=>new Element(...args),icon:()=>new Element('svg'),notice:text=>notices.push(text)});await ui.refresh();return{ui,$,calls,state,notices};
}
test('resource tabs preserve the library, annotations save, and activation changes are persisted',async t=>{
 const{ui,$,calls}=await fixture(t);assert.equal($('resources-pane').hidden,false);assert.equal($('output-pane').hidden,true);$('assets-output-tab').onclick();assert.equal($('output-pane').hidden,false);$('assets-resources-tab').onclick();
 const card=$('resources-list').children[0],activation=card.children[3].children[0],description=card.children[4];assert.equal(activation.checked,true);
 activation.checked=false;await activation.onchange();await new Promise(setImmediate);assert.deepEqual(calls.at(-1).body,{id:'one',patch:{enabled:false}});
 description.value='A cinematic blue light';assert.equal(ui.hasDraft(),true);assert.equal(await ui.flush(),true);await new Promise(setImmediate);assert.equal(ui.hasDraft(),false);assert.equal(calls.at(-1).body.patch.description,'A cinematic blue light');
 ui.setBusy(true);assert.equal(activation.disabled,true);ui.setBusy(false);assert.equal(activation.disabled,false);
 await card.children[1].onclick();await new Promise(setImmediate);assert.equal($('resources-list').children.length,0);
});
test('output details expose full prompts, workflow, seed and available parameters',async t=>{
 const {ui,$}=await fixture(t);const record={id:'run',conversationId:'conversation',workflowName:'Portrait workflow',prompt:'A full prompt with details',createdAt:'2026-01-02T12:00:00Z',parameters:{seed:42,width:1024,height:768},outputs:[{source:{filename:'result.png'},analysisDataUrl:'data:image/png;base64,AA=='}]};
 await ui.viewOutput(record,0);assert.equal($('original-dialog').open,true);const texts=$('media-metadata').children.map(item=>item.textContent);assert.ok(texts.includes(record.prompt));assert.ok(texts.includes(record.workflowName));assert.ok(texts.includes('42'));assert.ok(texts.some(text=>text.includes('1024')));assert.match($('media-error').textContent,/Aperçu compressé/);
 $('original-close').onclick();assert.equal($('original-dialog').open,false);
});

test('chat details reuse the displayed original blob and persisted original dimensions',async t=>{
 const {ui,$,calls}=await fixture(t),original=new Blob(['Original'],{type:'image/png'}),record={id:'run',conversationId:'conversation',workflowName:'Workflow',prompt:'Prompt',createdAt:'2026-01-02T12:00:00Z',parameters:{},outputs:[{source:{filename:'original.png'},width:1448,height:1448}]};
 const count=calls.length;await ui.viewOutput(record,0,original);assert.equal(calls.length,count);assert.equal($('media-download').disabled,false);assert.ok($('media-metadata').children.some(item=>item.textContent==='1448 × 1448'));assert.equal(await(await fetch($('original-image').src)).text(),'Original');$('original-close').onclick();
});
