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
 let stored={enabled:true,baseUrl:'http://127.0.0.1:7821',autoAllow:false,maxIterations:3};let workflows=[];const calls=[];let failTest=false;let importPause=Promise.resolve();
 const api=async(route,body)=>{
  calls.push({route,body});
  if(route==='comfy')return Response.json({config:stored,discovery:{detected:true},workflows});
  if(route==='comfy/test'){if(failTest)throw Error('Introuvable');return Response.json({detected:true,baseUrl:body.baseUrl,status:{idle:true}});}
  if(route==='comfy/import'){await importPause;const record={id:`wf-${workflows.length+1}`,...body};workflows.push(record);return Response.json(record);}
  throw Error(`Unexpected route ${route}`);
 };
 const state={conversationId:null};
 const ui=setupComfy({api,state,node:(tag,c,t)=>{const n=new Element(tag,c,t);all.push(n);return n;},notice:()=>{},onChange:()=>{}});
 try{await ui.refresh();await fn({ui,nodes,all,calls,state,details,setImportPause:value=>{importPause=value;},setFailTest:value=>{failTest=value;},setWorkflows:value=>{workflows=value;},setStored:value=>{stored=value;}});}
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

test('async workflow import stays locked during parent status refreshes',async()=>fixture(async({ui,nodes,setImportPause})=>{
 const get=id=>nodes.get(id);const graph={'1':{class_type:'CLIPTextEncode',inputs:{text:'prompt'}},'2':{class_type:'SaveImage',inputs:{images:['1',0]}}};
 await get('workflow-file').onchange({target:{files:[new File([JSON.stringify(graph)],'photo.json')],value:''}});
 let release;setImportPause(new Promise(resolve=>{release=resolve;}));get('workflow-description').value='Photo réaliste';
 const pending=get('workflow-import').onclick();
 try{ui.setBusy(false);assert.equal(get('workflow-import').disabled,true);assert.equal(get('workflow-file').disabled,true);}
 finally{release();await pending;}
 assert.equal(get('workflow-file').disabled,false);
}));
