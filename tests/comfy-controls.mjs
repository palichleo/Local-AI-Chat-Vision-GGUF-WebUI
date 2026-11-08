import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setupComfy } from '../public/comfy-ui.mjs';

class Element {
 constructor(tag='div',className='',text){this.tagName=tag;this.className=className;this.textContent=text||'';this.children=[];this.value='';this.hidden=false;this.disabled=false;this.checked=false;this.attributes={};this.options=[];}
 append(...children){this.children.push(...children);}
 replaceChildren(...children){this.children=[...children];this.options=children.filter(c=>c instanceof Option);this.value=this.options[0]?.value||'';}
 setAttribute(name,value){this.attributes[name]=value;}
 add(option){this.options.push(option);}
 focus(){if(!this.disabled)this.focused=true;}
 showModal(){this.open=true;}close(){this.open=false;}addEventListener(name,fn){(this.events??={})[name]=fn;}removeEventListener(name){delete (this.events??={})[name];}
}
async function fixture(fn){
 const previousDocument=globalThis.document,previousOption=globalThis.Option;
 const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
 const nodes=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new Element()]));
 const all=[];const details=new Element('details');
 globalThis.Option=class {constructor(text,value){this.text=text;this.value=value;}};
 globalThis.document={getElementById:id=>{assert.ok(nodes.has(id),`Missing real HTML id ${id}`);return nodes.get(id);},querySelector:()=>details,querySelectorAll:()=>all.filter(n=>n.className.includes('workflow-description')||n.className.includes('workflow-remove'))};
 let stored={enabled:true,baseUrl:'http://127.0.0.1:7821',autoAllow:false,maxIterations:3};let workflows=[];const calls=[];let failTest=false;let importPause=Promise.resolve();let intercept=()=>undefined;const busyChanges=[];
 const api=async(route,body,options)=>{
  calls.push({route,body});
  const intercepted=intercept(route,body,options);if(intercepted!==undefined)return intercepted;
  if(route==='comfy')return Response.json({config:stored,discovery:{detected:true},workflows});
  if(route==='comfy/test'){if(failTest)throw Error('Introuvable');return Response.json({detected:true,baseUrl:body.baseUrl,status:{idle:true}});}
  if(route==='comfy/import'){await importPause;const record={id:`wf-${workflows.length+1}`,...body};workflows.push(record);return Response.json(record);}
  throw Error(`Unexpected route ${route}`);
 };
 const state={conversationId:null};
 const ui=setupComfy({api,state,node:(tag,c,t)=>{const n=new Element(tag,c,t);all.push(n);return n;},notice:()=>{},onChange:()=>{},onSettingsBusyChange:value=>busyChanges.push(value)});
 try{await ui.refresh();await fn({ui,nodes,all,calls,state,details,busyChanges,setIntercept:fn=>{intercept=fn;},setImportPause:value=>{importPause=value;},setFailTest:value=>{failTest=value;},setWorkflows:value=>{workflows=value;},setStored:value=>{stored=value;}});}
 finally{globalThis.document=previousDocument;globalThis.Option=previousOption;}
}

test('detected address is read-only, manual override and connection test use the visible address',async()=>fixture(async({ui,nodes,calls,setFailTest})=>{
 const get=id=>nodes.get(id);assert.equal(get('comfy-url').readOnly,true);assert.equal(get('comfy-address-edit').hidden,false);
 get('comfy-address-edit').onclick();assert.equal(get('comfy-url').readOnly,false);
 get('comfy-url').value='http://127.0.0.1:9000';await get('comfy-test').onclick();
 assert.deepEqual(calls.at(-1),{route:'comfy/test',body:{baseUrl:'http://127.0.0.1:9000'}});assert.equal(get('comfy-url').readOnly,true);
 setFailTest(true);await get('comfy-test').onclick();assert.equal(get('comfy-url').readOnly,false);
 ui.setBusy(true);assert.equal(get('comfy-test').disabled,true);
}));
test('stepper clamps at one and infinity stores10000 while keeping a finite choice',async()=>fixture(async({ui,nodes,setStored})=>{
 const get=id=>nodes.get(id);get('comfy-iterations').value='1';get('comfy-iterations').oninput();get('comfy-minus').onclick();assert.equal(ui.values().maxIterations,1);
 get('comfy-unlimited').onclick();assert.equal(ui.values().maxIterations,10000);assert.equal(get('comfy-iterations').hidden,true);
 get('comfy-unlimited').onclick();assert.equal(ui.values().maxIterations,1);
 get('comfy-unlimited').onclick();get('comfy-minus').onclick();assert.equal(ui.values().maxIterations,9999);
 get('comfy-plus').onclick();assert.equal(ui.values().maxIterations,10000);
 setStored({enabled:true,baseUrl:'http://127.0.0.1:7821',autoAllow:false,maxIterations:10000});await ui.refresh();assert.equal(ui.values().maxIterations,10000);
}));
test('multiple imported workflows each receive a description without resetting pending Comfy settings',async()=>fixture(async({ui,nodes,calls,all})=>{
 const get=id=>nodes.get(id);const graph={'1':{class_type:'CLIPTextEncode',inputs:{text:'old'}},'2':{class_type:'SaveImage',inputs:{images:['1',0]}}};
 const files=['Portrait.json','Peinture.json'].map(name=>new File([JSON.stringify(graph)],name,{type:'application/json'}));
 await get('workflow-file').onchange({target:{files,value:'selected'}});
 assert.match(get('workflow-import-progress').textContent,/1 \/ 2/);
 await get('workflow-import').onclick();assert.equal(calls.filter(c=>c.route==='comfy/import').length,0);
 get('comfy-auto').checked=true;get('workflow-description').value='Portraits photo réalistes';await get('workflow-import').onclick();
 assert.match(get('workflow-import-progress').textContent,/2 \/ 2/);assert.equal(ui.values().autoAllow,true);
 get('workflow-description').value='Paysages peints à l’aquarelle';await get('workflow-import').onclick();
 const imported=calls.filter(c=>c.route==='comfy/import');assert.equal(imported.length,2);assert.match(imported[0].body.description,/Portraits/);assert.match(imported[1].body.description,/aquarelle/);assert.equal(get('workflow-import-panel').hidden,true);
 const description=all.filter(n=>n.className==='workflow-description').at(-1);description.value='Nouvelle description';description.oninput();assert.deepEqual(ui.workflowDescriptions(),[{id:'wf-2',description:'Nouvelle description'}]);
}));
test('linked prompts require explicit mapping before the workflow can be added',async()=>fixture(async({ui,nodes})=>{
 const get=id=>nodes.get(id);const graph={'1':{class_type:'CLIPTextEncode',inputs:{text:['9',0]}},'2':{class_type:'SaveImage',inputs:{images:['1',0]}}};
 await get('workflow-file').onchange({target:{files:[new File([JSON.stringify(graph)],'linked.json')],value:''}});
 assert.equal(get('binding-prompt').value,'');get('workflow-description').value='Un workflow avec des entrées liées';await get('workflow-import').onclick();
 assert.match(get('workflow-import-error').textContent,/entrée du prompt/);
 ui.setBusy(true);assert.equal(get('workflow-import').disabled,true);ui.setBusy(false);
}));

test('async workflow import stays locked during parent status refreshes',async()=>fixture(async({ui,nodes,setImportPause,busyChanges})=>{
 const get=id=>nodes.get(id);const graph={'1':{class_type:'CLIPTextEncode',inputs:{text:'prompt'}},'2':{class_type:'SaveImage',inputs:{images:['1',0]}}};
 await get('workflow-file').onchange({target:{files:[new File([JSON.stringify(graph)],'photo.json')],value:''}});
 let release;setImportPause(new Promise(resolve=>{release=resolve;}));get('workflow-description').value='Photo réaliste';
 const pending=get('workflow-import').onclick();
 try{ui.setBusy(false);assert.equal(get('workflow-import').disabled,true);assert.equal(get('workflow-file').disabled,true);}
 finally{release();await pending;}
 assert.equal(get('workflow-file').disabled,false);assert.equal(busyChanges.at(-1),false);
}));

test('connection checks keep all Comfy controls locked through periodic status refreshes',async()=>fixture(async({ui,nodes,setIntercept,busyChanges})=>{
 const get=id=>nodes.get(id);let release;
 setIntercept(route=>route==='comfy/test'?new Promise(resolve=>{release=()=>resolve(Response.json({detected:true,baseUrl:'http://127.0.0.1:7821',status:{idle:true}}));}):undefined);
 const pending=get('comfy-test').onclick();
 try{ui.setBusy(false);assert.equal(get('comfy-test').disabled,true);assert.equal(get('comfy-url').disabled,true);assert.equal(busyChanges.at(-1),true);}
 finally{release();await pending;}
 assert.equal(get('comfy-test').disabled,false);assert.equal(busyChanges.at(-1),false);
}));

test('an old connection check cannot replace the address of reopened settings',async()=>fixture(async({ui,nodes,setIntercept,setStored})=>{
 const get=id=>nodes.get(id);let release;
 setIntercept(route=>route==='comfy/test'?new Promise(resolve=>{release=()=>resolve(Response.json({detected:true,baseUrl:'http://127.0.0.1:7821',status:{idle:true}}));}):undefined);
 const pending=get('comfy-test').onclick();
 try{
  ui.cancelSettings?.();setStored({enabled:false,baseUrl:'http://127.0.0.1:9000',autoAllow:true,maxIterations:7});await ui.refresh();
  release();await pending;assert.equal(get('comfy-url').value,'http://127.0.0.1:9000');assert.equal(get('comfy-status').textContent,'');
 }finally{release();await pending;}
}));

test('only the latest settings refresh applies values, and refresh locks are balanced',async()=>fixture(async({ui,nodes,setIntercept,busyChanges})=>{
 const resolvers=[];setIntercept(route=>route==='comfy'?new Promise(resolve=>resolvers.push(resolve)):undefined);
 const first=ui.refresh(),second=ui.refresh();
 const result=(port,maxIterations)=>Response.json({config:{enabled:true,baseUrl:`http://127.0.0.1:${port}`,autoAllow:false,maxIterations},discovery:{detected:false},workflows:[]});
 resolvers[1](result(9002,9));await second;resolvers[0](result(9001,2));await first;
 assert.equal(nodes.get('comfy-url').value,'http://127.0.0.1:9002');assert.equal(ui.values().maxIterations,9);
 assert.equal(busyChanges.at(-1),false);
}));

test('closing discards unsaved workflow descriptions and cancels pending workflow reads',async()=>fixture(async({ui,nodes,all,setWorkflows})=>{
 setWorkflows([{id:'photo',name:'Photo',description:'Saved description'}]);await ui.refresh();
 const description=all.filter(n=>n.className==='workflow-description').at(-1);description.value='Abandoned draft';description.oninput();
 let release;const file={name:'late.json',size:10,text:()=>new Promise(resolve=>{release=resolve;})};
 const pending=nodes.get('workflow-file').onchange({target:{files:[file],value:''}});
 ui.cancelSettings?.();release(JSON.stringify({'1':{class_type:'CLIPTextEncode',inputs:{text:'p'}},'2':{class_type:'SaveImage',inputs:{images:['1',0]}}}));await pending;
 assert.deepEqual(ui.workflowDescriptions(),[]);assert.equal(nodes.get('workflow-import-panel').hidden,true);
}));

test('saved settings apply the committed response without a second network request',async()=>fixture(async({ui,nodes,calls})=>{
 const count=calls.length;
 await ui.saved({comfy:{enabled:false,baseUrl:'http://127.0.0.1:9003',autoAllow:true,maxIterations:8},workflows:[]});
 assert.equal(calls.length,count);assert.equal(nodes.get('comfy-url').value,'http://127.0.0.1:9003');assert.equal(ui.values().maxIterations,8);
}));

test('workflow removal holds the settings lock and restores it after failure',async()=>fixture(async({ui,nodes,all,setIntercept,setWorkflows,busyChanges})=>{
 setWorkflows([{id:'photo',name:'Photo',description:'Saved description'}]);await ui.refresh();
 let reject;setIntercept(route=>route==='comfy/remove'?new Promise((_,no)=>{reject=no;}):undefined);
 const remove=all.filter(n=>n.className.includes('workflow-remove')).at(-1),pending=remove.onclick();
 try{ui.setBusy(false);assert.equal(nodes.get('workflow-file').disabled,true);assert.equal(busyChanges.at(-1),true);}
 finally{reject(Error('Read-only folder'));await pending;}
 assert.equal(nodes.get('workflow-file').disabled,false);assert.equal(busyChanges.at(-1),false);
}));

test('only finite generation counts participate in native form validation',async()=>fixture(async({ui,nodes})=>{
 const count=nodes.get('comfy-iterations');
 assert.equal(count.required,true);
 nodes.get('comfy-unlimited').onclick();assert.equal(count.disabled,true);assert.equal(count.required,false);
 ui.setBusy(false);assert.equal(count.disabled,true);assert.equal(ui.values().maxIterations,10000);
 nodes.get('comfy-unlimited').onclick();assert.equal(count.disabled,false);assert.equal(count.required,true);
 for(const invalid of ['', '0', '2.5','10001']){count.value=invalid;assert.throws(()=>ui.values(),/générations|entier|limite/);}
}));

test('reading an imported workflow holds the settings lock until parsing completes',async()=>fixture(async({ui,nodes,setWorkflows,busyChanges})=>{
 let release;const file={name:'reading.json',size:10,text:()=>new Promise(resolve=>{release=resolve;})};
 const pending=nodes.get('workflow-file').onchange({target:{files:[file],value:''}});
 try{ui.setBusy(false);assert.equal(nodes.get('workflow-file').disabled,true);assert.equal(busyChanges.at(-1),true);}
 finally{release(JSON.stringify({'1':{class_type:'CLIPTextEncode',inputs:{text:'p'}},'2':{class_type:'SaveImage',inputs:{images:['1',0]}}}));await pending;}
 assert.equal(busyChanges.at(-1),false);
}));

test('latest gallery refresh wins without duplicate images',async()=>fixture(async({ui,state,nodes,setIntercept})=>{
 state.conversationId='conversation';const replies=[];
 setIntercept(route=>route==='gallery/conversation'?new Promise(resolve=>replies.push(resolve)):undefined);
 const record={id:'run',conversationId:'conversation',workflowName:'Portrait',prompt:'A portrait',createdAt:'2026-11-08T00:00:00Z',parameters:{},outputs:[{source:{filename:'image.png'}}]};
 const first=ui.renderGallery('conversation'),second=ui.renderGallery('conversation');
 replies[1](Response.json({runs:[record]}));await second;replies[0](Response.json({runs:[record]}));await first;
 assert.equal(nodes.get('gallery-list').children.length,1);
}));

test('cancel during launch acknowledgement is sent immediately and is scoped to that request',async()=>fixture(async({ui,state,calls,setIntercept})=>{
 state.conversationId='conversation';let release;
 setIntercept(route=>route==='tools/execute'?new Promise(resolve=>{release=()=>resolve(Response.json({id:'mine',state:'checking'}));}):route==='tools/cancel'?Response.json({}):undefined);
 const controller=new AbortController(),pending=assert.rejects(ui.requestTool({autoAllow:true,requestId:'request-mine'},controller.signal,()=>{}),{name:'AbortError'});
 await new Promise(setImmediate);controller.abort();
 try{assert.ok(calls.some(c=>c.route==='tools/cancel'&&c.body.requestId==='request-mine'));}
 finally{release();await pending;}
}));

test('a replaced job is never followed or cancelled as if it belonged to this message',async()=>fixture(async({ui,state,calls,setIntercept})=>{
 state.conversationId='conversation';
 setIntercept(route=>route==='tools/execute'?Response.json({id:'mine',state:'generating'}):route==='tools/job'?Response.json({id:'other',state:'error',error:'Other job'}):route==='tools/cancel'?Response.json({}):undefined);
 await assert.rejects(ui.requestTool({autoAllow:true,requestId:'request-mine'},new AbortController().signal,()=>{}),/remplacée|correspond/);
 assert.ok(calls.filter(c=>c.route==='tools/cancel').every(c=>c.body.requestId==='request-mine'));
}));

async function rasterStub(check){
 const priorBitmap=globalThis.createImageBitmap,priorCreate=document.createElement;
 globalThis.createImageBitmap=async()=>({width:1,height:1,close(){}});
 document.createElement=()=>({width:0,height:0,getContext:()=>({fillRect(){},drawImage(){}}),toDataURL:mime=>mime==='image/png'?'data:image/png;base64,iVBORw0KGgo=':'data:image/jpeg;base64,/9j/'});
 try{await check();}finally{globalThis.createImageBitmap=priorBitmap;document.createElement=priorCreate;}
}
const generatedRecord={id:'mine',conversationId:'conversation',workflowName:'Portrait',prompt:'A portrait',createdAt:'2026-11-08T00:00:00Z',parameters:{},outputs:[{source:{filename:'image.png'}}]};

test('an image survives a failed model restart and still receives its compressed gallery copy',async()=>fixture(async({ui,state,calls,setIntercept})=>{
 state.conversationId='conversation';
 setIntercept(route=>route==='tools/execute'?Response.json({id:'mine',state:'error',error:'Model restart failed',record:generatedRecord}):route==='gallery/conversation'?Response.json({runs:[generatedRecord]}):route.endsWith('/mine/0')?new Response(Buffer.from('89504e470d0a1a0a','hex'),{headers:{'Content-Type':'image/png'}}):route==='gallery/analysis'?Response.json({}):undefined);
 await rasterStub(async()=>{
  const result=await ui.requestTool({autoAllow:true,requestId:'request-mine'},new AbortController().signal,()=>{});
  assert.equal(result.record?.id,'mine');assert.equal(result.failed,true);assert.equal(result.images.length,1);
  assert.match(result.error,/restart failed/);assert.ok(calls.some(c=>c.route==='gallery/analysis'));
 });
}));

test('a missing original for compression cannot turn a produced image into a lost tool result',async()=>fixture(async({ui,state,setIntercept})=>{
 state.conversationId='conversation';
 setIntercept(route=>route==='tools/execute'?Response.json({id:'mine',state:'done',record:generatedRecord}):route==='gallery/conversation'?Response.json({runs:[generatedRecord]}):route.endsWith('/mine/0')?Promise.reject(Error('Original unavailable')):undefined);
 const result=await ui.requestTool({autoAllow:true,requestId:'request-mine'},new AbortController().signal,()=>{});
 assert.equal(result.record?.id,'mine');assert.equal(result.failed,true);assert.deepEqual(result.images,[]);
 assert.match(result.content,/generated|générée/);assert.match(result.error,/Original unavailable/);
}));

test('image slots are explicitly named and mapped at import, including arbitrary custom file loaders',async()=>fixture(async({nodes,calls})=>{
 const get=id=>nodes.get(id),graph={'1':{class_type:'CLIPTextEncode',inputs:{text:'p'}},'2':{class_type:'SaveImage',inputs:{images:['1',0]}},'17':{class_type:'CustomLoader',inputs:{source:'a.png'}},'31':{class_type:'OtherCustomLoader',inputs:{style:'b.png'}}};
 await get('workflow-file').onchange({target:{files:[new File([JSON.stringify(graph)],'two.json')],value:''}});get('workflow-description').value='Subject and style';
 assert.equal(get('workflow-image-inputs').children.length,0,'No image role or mapping is guessed from a node class');
 get('workflow-add-image').onclick();get('workflow-add-image').onclick();
 const [a,b]=get('workflow-image-inputs').children;
 for(const [row,name,node,input]of [[a,'Subject','17','source'],[b,'Style','31','style']]){row.children[0].value=name;row.children[1].value='Use this as '+name;row.children[2].value=JSON.stringify({node,input});}
 a.children[3].children[0].checked=true;
 await get('workflow-import').onclick();const body=calls.find(call=>call.route==='comfy/import').body;
 assert.equal(body.bindings.image,undefined);assert.deepEqual(body.imageInputs.map(({id,name,node,input,required})=>({id,name,node,input,required})),[{id:'ref_1',name:'Subject',node:'17',input:'source',required:true},{id:'ref_2',name:'Style',node:'31',input:'style',required:false}]);
}));

test('incomplete and duplicate image slots block import, and removing a slot removes its mapping',async()=>fixture(async({ui,nodes,calls})=>{
 const get=id=>nodes.get(id),graph={'1':{class_type:'CLIPTextEncode',inputs:{text:'p'}},'2':{class_type:'SaveImage',inputs:{images:['1',0]}},'17':{class_type:'LoadImage',inputs:{image:'a.png'}}};
 await get('workflow-file').onchange({target:{files:[new File([JSON.stringify(graph)],'two.json')],value:''}});get('workflow-description').value='Subject and style';get('workflow-add-image').onclick();
 await get('workflow-import').onclick();assert.equal(calls.some(call=>call.route==='comfy/import'),false);
 get('workflow-add-image').onclick();const [a,b]=get('workflow-image-inputs').children;
 for(const row of [a,b]){row.children[0].value='Reference';row.children[1].value='Role';row.children[2].value=JSON.stringify({node:'17',input:'image'});}
 await get('workflow-import').onclick();assert.equal(calls.some(call=>call.route==='comfy/import'),false);
 ui.setBusy(true);assert.equal(a.children[0].disabled,true);assert.equal(a.children[4].disabled,true);ui.setBusy(false);
 b.children[4].onclick();assert.equal(get('workflow-image-inputs').children.length,1);await get('workflow-import').onclick();assert.equal(calls.find(call=>call.route==='comfy/import').body.imageInputs.length,1);
}));

test('editor workflow rejection stays pending with a visible local error until explicitly skipped',async()=>fixture(async({ui,nodes,calls})=>{
 const get=id=>nodes.get(id),editor={id:'test',version:0.4,nodes:[{id:1,type:'A-subgraph'}],links:[],definitions:{subgraphs:[]}};
 await get('workflow-file').onchange({target:{files:[new File([JSON.stringify(editor)],'Image MOSS.json')],value:''}});
 assert.equal(ui.hasPendingImport(),true);assert.equal(get('workflow-import-panel').hidden,false);assert.equal(get('workflow-import-fields').hidden,true);
 assert.equal(get('workflow-import-error').hidden,false);assert.match(get('workflow-import-error').textContent,/Export \(API\)/);assert.match(get('workflow-import-progress').textContent,/Image MOSS/);
 assert.equal(await ui.finishImport(),false);assert.equal(ui.hasPendingImport(),true);assert.equal(calls.some(call=>call.route==='comfy/import'),false);
 get('workflow-skip').onclick();assert.equal(ui.hasPendingImport(),false);assert.equal(get('workflow-import-panel').hidden,true);
}));

test('valid import prompts for description and the main save path can finish it without a separate Add click',async()=>fixture(async({ui,nodes,calls})=>{
 const get=id=>nodes.get(id),graph={'1':{class_type:'CLIPTextEncode',inputs:{text:'p'}},'2':{class_type:'SaveImage',inputs:{images:['1',0]}}};
 await get('workflow-file').onchange({target:{files:[new File([JSON.stringify(graph)],'Image.json')],value:''}});
 assert.equal(get('workflow-import-fields').hidden,false);assert.equal(get('workflow-description').focused,true);
 assert.equal(await ui.finishImport(),false);assert.equal(get('workflow-import-error').hidden,false);assert.match(get('workflow-import-error').textContent,/description/);
 get('workflow-description').value='Use for image generation.';assert.equal(await ui.finishImport(),true);assert.equal(ui.hasPendingImport(),false);
 await ui.refresh();assert.equal(calls.filter(call=>call.route==='comfy/import').length,1);assert.match(get('workflow-list').children[0].children[1].value,/image generation/);
}));

test('imports remain pending while being read and additional file selections preserve the current description',async()=>fixture(async({ui,nodes})=>{
 const get=id=>nodes.get(id),graph={'1':{class_type:'CLIPTextEncode',inputs:{text:'p'}},'2':{class_type:'SaveImage',inputs:{images:['1',0]}}};let release;
 const reading=get('workflow-file').onchange({target:{files:[{name:'First.json',size:10,text:()=>new Promise(resolve=>{release=resolve;})}],value:''}});
 assert.equal(ui.hasPendingImport(),true);release(JSON.stringify(graph));await reading;get('workflow-description').value='First purpose';
 await get('workflow-file').onchange({target:{files:[new File([JSON.stringify(graph)],'Second.json')],value:''}});assert.equal(get('workflow-description').value,'First purpose');
 assert.equal(await ui.finishImport(),false,'The next workflow still needs its own description');assert.match(get('workflow-import-progress').textContent,/Second/);get('workflow-description').value='Second purpose';assert.equal(await ui.finishImport(),true);
}));

test('a committed import is not retried when the subsequent metadata refresh fails',async()=>fixture(async({ui,nodes,calls,setIntercept})=>{
 const get=id=>nodes.get(id),graph={'1':{class_type:'CLIPTextEncode',inputs:{text:'p'}},'2':{class_type:'SaveImage',inputs:{images:['1',0]}}};
 await get('workflow-file').onchange({target:{files:[new File([JSON.stringify(graph)],'Image.json')],value:''}});get('workflow-description').value='Saved purpose';
 setIntercept(route=>route==='comfy'?Promise.reject(Error('Disconnected')):undefined);
 assert.equal(await ui.finishImport(),true);assert.equal(ui.hasPendingImport(),false);assert.equal(await ui.finishImport(),true);assert.equal(calls.filter(call=>call.route==='comfy/import').length,1);
}));

test('the original reaches the chat during model reload, while only a compressed copy goes to analysis',async()=>fixture(async({ui,state,calls,setIntercept})=>{
 state.conversationId='conversation';let shown=false;const bytes=Buffer.from('89504e470d0a1a0a0102030405060708','hex');
 setIntercept(route=>route==='tools/execute'?Response.json({id:'mine',state:'restarting',progress:'Reloading',record:generatedRecord}):route==='tools/job'?Response.json({id:'mine',state:'done',record:generatedRecord}):route==='gallery/conversation'?Response.json({runs:[generatedRecord]}):route.endsWith('/mine/0')?new Response(bytes,{headers:{'Content-Type':'image/png'}}):route==='gallery/analysis'?Response.json({}):undefined);
 await rasterStub(async()=>{const result=await ui.requestTool({autoAllow:true,requestId:'request-mine'},new AbortController().signal,()=>{},({blob})=>{shown=true;assert.equal(blob.size,bytes.length);assert.equal(calls.some(call=>call.route==='tools/job'),false);});assert.equal(shown,true);assert.equal(result.images[0],'data:image/jpeg;base64,/9j/');const analysis=calls.find(call=>call.route==='gallery/analysis');assert.deepEqual(analysis.body.images,result.images);assert.notEqual(analysis.body.images[0].split(',')[1],bytes.toString('base64'));});
 assert.equal(calls.filter(call=>call.route.endsWith('/mine/0')).length,1);
}));

test('batch output originals are transferred and compressed sequentially before the next download',async()=>fixture(async({ui,state,setIntercept,calls})=>{
 state.conversationId='conversation';const record={...generatedRecord,outputs:[0,1,2].map(i=>({source:{filename:i+'.png'}}))},gates=[],shown=[];
 setIntercept(route=>route==='tools/execute'?Response.json({id:'mine',state:'done',record}):route==='gallery/conversation'?Response.json({runs:[record]}):/mine\/\d+$/.test(route)?new Promise(resolve=>gates.push(()=>resolve(new Response(Buffer.from('89504e470d0a1a0a','hex'),{headers:{'content-type':'image/png'}})))):route==='gallery/analysis'?Response.json({}):undefined);
 await rasterStub(async()=>{
  const pending=ui.requestTool({autoAllow:true,requestId:'mine'},new AbortController().signal,()=>{},event=>shown.push(event.index));
  for(let i=0;i<3;i++){await new Promise(setImmediate);assert.equal(gates.length,i+1);gates[i]();}
  const result=await pending;assert.deepEqual(shown,[0,1,2]);assert.equal(result.images.length,3);
  assert.equal(calls.filter(call=>/mine\/\d+$/.test(call.route)).length,3);
 });
}));

test('an unreadable original does not prevent later batch outputs from being shown',async()=>fixture(async({ui,state,calls,setIntercept})=>{
 state.conversationId='conversation';const record={...generatedRecord,outputs:[0,1].map(i=>({source:{filename:i+'.png'}}))},shown=[];
 setIntercept(route=>route==='tools/execute'?Response.json({id:'mine',state:'done',record}):route==='gallery/conversation'?Response.json({runs:[record]}):route==='gallery/analysis'?Response.json({}):route.endsWith('/mine/0')?Promise.reject(Error('Missing first image')):route.endsWith('/mine/1')?new Response(Buffer.from('89504e470d0a1a0a','hex'),{headers:{'content-type':'image/png'}}):undefined);
 await rasterStub(async()=>{const result=await ui.requestTool({autoAllow:true,requestId:'mine'},new AbortController().signal,()=>{},event=>shown.push(event.index));assert.deepEqual(shown,[1]);assert.equal(result.failed,true);assert.equal(result.images.length,1);assert.deepEqual(calls.find(call=>call.route==='gallery/analysis').body.images,[null,result.images[0]]);assert.equal(JSON.parse(result.content).analysis_outputs[0].output_index,1);assert.match(result.error,/Missing first image/);});
}));
test('an already cancelled automatic call releases its pending approval without executing',async()=>fixture(async({ui,calls,setIntercept})=>{
 setIntercept(route=>route==='tools/cancel'?Response.json(null):undefined);
 const controller=new AbortController();controller.abort();await assert.rejects(ui.requestTool({autoAllow:true,requestId:'cancelled'},controller.signal,()=>{}),{name:'AbortError'});
 assert.equal(calls.filter(call=>call.route==='tools/execute').length,0);assert.equal(calls.find(call=>call.route==='tools/cancel').body.requestId,'cancelled');
}));

test('video import declares stages, output and frame mappings without guessing custom workflow names',async()=>fixture(async({nodes,calls})=>{
 const get=id=>nodes.get(id),graph={'1':{class_type:'CLIPTextEncode',inputs:{text:'p'}},'2':{class_type:'CustomAnimator',inputs:{length:81,fps:16,prompt:['1',0]}},'3':{class_type:'ArbitrarySaveNode',inputs:{movie:['2',0]}}};
 await get('workflow-file').onchange({target:{files:[new File([JSON.stringify(graph)],'custom.json')],value:''}});
 get('workflow-media').value='video';get('workflow-media').onchange();get('workflow-stages').value='both';get('workflow-output').value='3';get('binding-frames').value=JSON.stringify({node:'2',input:'length'});get('workflow-description').value='Camera motion, draft and final';
 await get('workflow-import').onclick();const imported=calls.find(call=>call.route==='comfy/import')?.body;
 assert.equal(imported?.mediaType,'video');assert.deepEqual(imported.videoStages,['draft','final']);assert.deepEqual(imported.outputNodes,['3']);assert.deepEqual(imported.bindings.frames,{node:'2',input:'length'});
}));
test('video approval is shown even with global permission, explains draft/final and revision never executes',async()=>fixture(async({ui,nodes,calls,setIntercept})=>{
 setIntercept(route=>route==='tools/cancel'?Response.json({}):undefined);
 const request={requestId:'proposal',mediaType:'video',autoAllow:true,workflowName:'Custom motion',args:{prompt:'A slow pan'},approvalToken:'one-use',plan:{stage:'draft',intention:'Vérifier le mouvement.',prompt:'A slow pan',parameters:{frames:81,fps:16,width:768,height:512,seed:12},references:[{input:'start',label:'Ref 2',role:'Image de début'}]}};
 const pending=ui.requestTool(request,new AbortController().signal,()=>{});await new Promise(setImmediate);
 assert.equal(nodes.get('tool-dialog').open,true);assert.match(nodes.get('tool-title').textContent,/Brouillon/);assert.equal(nodes.get('tool-always').hidden,true);assert.equal(nodes.get('tool-revise').hidden,false);assert.ok(!calls.some(call=>call.route==='tools/execute'));assert.match(JSON.stringify(nodes.get('tool-plan').children),/Vérifier le mouvement|Ref 2/);
 nodes.get('tool-revise').onclick();const result=await pending;assert.equal(result.denied,true);assert.match(result.content,/revision_requested/);assert.equal(nodes.get('tool-dialog').open,false);assert.ok(!calls.some(call=>call.route==='tools/execute'));
}));
test('video confirm sends the exact proposal token once and final label is explicit',async()=>fixture(async({ui,nodes,calls,setIntercept})=>{
 setIntercept(route=>route==='tools/execute'?Response.json({id:'job',state:'error',error:'test boundary'}):undefined);
 const pending=ui.requestTool({requestId:'final-proposal',mediaType:'video',autoAllow:true,approvalToken:'final-token',workflowName:'Motion',args:{},plan:{stage:'final',intention:'Finaliser.',parameters:{},references:[]}},new AbortController().signal,()=>{});
 await new Promise(setImmediate);assert.match(nodes.get('tool-title').textContent,/Vidéo finale/);nodes.get('tool-once').onclick();await pending;
 assert.deepEqual(calls.find(call=>call.route==='tools/execute').body,{requestId:'final-proposal',permission:'once',approvalToken:'final-token'});
}));

test('video tool result retains the effective recipe even when analysis frames cannot be decoded',async()=>fixture(async({ui,state,nodes,setIntercept})=>{
 state.conversationId='conversation';const record={...generatedRecord,mediaType:'video',parameters:{stage:'draft',seed:123,width:768,height:512,frames:81,fps:16,workflow_digest:'version',workflow_inputs:{private:'unneeded context'}}};
 setIntercept(route=>route==='tools/execute'?Response.json({id:'job',state:'done',record}):route==='gallery/conversation'?Response.json({runs:[record]}):undefined);
 const pending=ui.requestTool({requestId:'video',mediaType:'video',approvalToken:'token',args:{},plan:{stage:'draft',parameters:{},references:[]}},new AbortController().signal,()=>{});await new Promise(setImmediate);nodes.get('tool-once').onclick();const result=await pending,data=JSON.parse(result.content);
 assert.equal(result.record.id,'mine');assert.equal(result.failed,true);assert.equal(data.parameters.seed,123);assert.equal(data.parameters.fps,16);assert.equal(data.parameters.frames,81);assert.equal(data.workflow_digest,'version');assert.equal(data.parameters.workflow_inputs,undefined);
}));

test('photo tool results expose the actual seed and dimensions for a later correction',async()=>fixture(async({ui,state,setIntercept})=>{
 state.conversationId='conversation';const record={...generatedRecord,parameters:{seed:42,width:1024,height:768,workflow_digest:'photo-version'}};
 setIntercept(route=>route==='tools/execute'?Response.json({id:'mine',state:'done',record}):route==='gallery/conversation'?Response.json({runs:[record]}):route.endsWith('/mine/0')?Promise.reject(Error('No preview')):undefined);
 const result=await ui.requestTool({autoAllow:true,requestId:'photo'},new AbortController().signal,()=>{}),data=JSON.parse(result.content);assert.equal(data.parameters.seed,42);assert.equal(data.parameters.width,1024);assert.equal(data.workflow_digest,'photo-version');
}));
