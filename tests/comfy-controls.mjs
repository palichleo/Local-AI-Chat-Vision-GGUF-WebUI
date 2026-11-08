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
 focus(){this.focused=true;}
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
 assert.match(get('comfy-status').textContent,/entrée du prompt/);
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
