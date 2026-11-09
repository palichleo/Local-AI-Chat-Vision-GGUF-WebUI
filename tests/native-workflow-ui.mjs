import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateNativeWorkflow} from '../lib/native-workflows.mjs';
import { setupNativeWorkflows, parameterPolicies } from '../public/native-workflow-ui.mjs';
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');

function fixture(){
 const nodes=new Map();
 class Element {
  constructor(tag='div',className='',text=''){this.tagName=tag.toUpperCase();this.className=className;this.textContent=text;this.children=[];this.listeners={};this.hidden=false;this.value='';this.checked=false;this.disabled=false;this.dataset={};this.attributes={};this.classList={toggle(){},add(){},remove(){}};}
  set id(value){this._id=value;nodes.set(value,this);}get id(){return this._id;}
  append(...items){this.children.push(...items);for(const item of items)item.parent=this;}
  replaceChildren(...items){this.children=[];this.append(...items);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
  setAttribute(key,value){this.attributes[key]=value;}getAttribute(key){return this.attributes[key]??null;}
  addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}focus(){this.focused=true;}scrollIntoView(){}
  querySelectorAll(){return this.children.flatMap(child=>[child,...child.querySelectorAll()]).filter(child=>['INPUT','TEXTAREA','SELECT','BUTTON','FIELDSET'].includes(child.tagName));}
 }
 for(const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)){const element=new Element(match[1]);element.id=match[3];element.hidden=/\bhidden(?:\s|$)/.test(match[2]);}
 const $=id=>nodes.get(id)||null;
 const document={getElementById:$,createElement:tag=>new Element(tag),activeElement:$('workflow-add')};
 const template={schemaVersion:1,id:'image-test',name:'Portrait',description:'Portraits in studio',enabled:false,pipeline:'krea2',mediaType:'image',components:{model:{policy:'fixed',asset:'model-one'},textEncoder:{policy:'fixed',asset:'encoder-one'},vae:{policy:'fixed',asset:'vae-one'}},parameters:{prompt:{policy:'model',type:'string',maxLength:8000},seed:{policy:'random',type:'integer'},width:{policy:'fixed',value:512},height:{policy:'fixed',value:512},steps:{policy:'fixed',value:8}},loras:[],references:[]};
 const calls=[],workflows=[structuredClone(template)];let failSave=false;
 const api=async(route,body)=>{calls.push({route,body:structuredClone(body)});if(route==='generation')return Response.json({config:{enabled:true,autoAllow:false,maxIterations:5,pythonPath:'',tokenizerPath:''},folders:{model:'C:/atelier/models/checkpoints',textEncoder:'C:/atelier/models/LLMs',vae:'C:/atelier/models/VAE',lora:'C:/atelier/models/LoRa'},runner:{state:'ready',capabilities:{krea2:true}},workflows,assets:[{id:'model-one',kind:'model',pipeline:'krea2',path:'model.safetensors'},{id:'encoder-one',kind:'textEncoder',pipeline:'krea2',path:'encoder.safetensors'},{id:'vae-one',kind:'vae',pipeline:'krea2',path:'vae.safetensors'},{id:'lora-one',kind:'lora',pipeline:'krea2',path:'lora.safetensors'}]});if(route==='files/choose')return Response.json({path:'C:/models/new.safetensors'});if(route==='generation/assets')return Response.json({asset:{id:'model-new',path:body.path,kind:body.kind,family:body.family}});if(route==='generation/import-comfy')return Response.json({workflow:{...template,id:'converted-krea',enabled:false},assets:[],warnings:[]});if(route==='generation/validate')return Response.json({workflow:validateNativeWorkflow(body)});if(route.startsWith('generation/templates')){const pipeline=new URLSearchParams(route.split('?')[1]).get('pipeline');return Response.json({template:pipeline==='ltx25'?{...template,pipeline:'ltx25',mediaType:'video'}:template});}if(route==='generation/workflows'&&body){if(failSave)throw Error('Composant incompatible : choisissez un modèle Krea2.');const index=workflows.findIndex(item=>item.id===body.id);if(index<0)workflows.push(body);else workflows[index]=body;return Response.json({workflow:body});}throw Error('Unexpected '+route);};
 return {$,nodes,document,template,workflows,calls,api,node:(...args)=>new Element(...args),set failSave(value){failSave=value;}};
}
async function setup(t){const f=fixture(),previous=globalThis.document;globalThis.document=f.document;t.after(()=>{globalThis.document=previous;});f.ui=setupNativeWorkflows({api:f.api,state:{},node:f.node,notice(){}});await f.ui.refresh();return f;}

test('only seed offers random ownership',()=>{assert.deepEqual(parameterPolicies('seed'),['fixed','model','random']);assert.deepEqual(parameterPolicies('steps'),['fixed','model']);});

test('private setup progress refreshes without overwriting unsaved settings or blocking the editor',async t=>{
 const f=await setup(t);f.$('generation-tokenizer').value='unsaved tokenizer';f.ui.updateRunner({state:'installing',progress:'Installation des bibliothèques…'});assert.match(f.$('generation-status').textContent,/Préparation automatique.*bibliothèques/);assert.equal(f.$('generation-tokenizer').value,'unsaved tokenizer');assert.equal(f.$('workflow-add').disabled,false);
 f.ui.updateRunner({state:'ready'});assert.match(f.$('generation-status').textContent,/Prêt/);assert.equal(f.$('generation-tokenizer').value,'unsaved tokenizer');
});
test('editor swaps the existing panel, saves native policies and reopens saved description',async t=>{const f=await setup(t);await f.ui.edit(f.template);assert.equal(f.$('settings-form').hidden,true);assert.equal(f.$('workflow-editor').hidden,false);f.$('native-workflow-description').value='Soft studio portraits';f.$('native-policy-width').value='model';f.$('native-policy-width').onchange();f.$('native-min-width').value='256';f.$('native-max-width').value='1024';assert.equal(await f.ui.saveEditor(),true);assert.equal(f.$('settings-form').hidden,false);const saved=f.calls.find(call=>call.route==='generation/workflows');assert.equal(saved.body.description,'Soft studio portraits');assert.deepEqual(saved.body.parameters.width,{policy:'model',type:'integer',default:512,min:256,max:1024});await f.ui.edit(f.workflows[0]);assert.equal(f.$('native-workflow-description').value,'Soft studio portraits');});
test('invalid server save preserves editor and last valid workflow',async t=>{const f=await setup(t);await f.ui.edit(f.template);f.$('native-workflow-description').value='Incompatible edit';f.failSave=true;assert.equal(await f.ui.saveEditor(),false);assert.equal(f.ui.isEditing(),true);assert.equal(f.workflows[0].description,'Portraits in studio');assert.match(f.$('native-workflow-error').textContent,/incompatible/);assert.equal(f.$('native-workflow-description').value,'Incompatible edit');});
test('dirty back stays in the same panel until discard and restores focus',async t=>{const f=await setup(t);await f.ui.edit(f.template);f.$('native-workflow-name').value='Changed';f.ui.requestBack();assert.equal(f.ui.isEditing(),true);assert.equal(f.$('native-workflow-unsaved').hidden,false);f.$('native-workflow-keep').onclick();assert.equal(f.ui.isEditing(),true);f.ui.requestBack();f.$('native-workflow-discard').onclick();assert.equal(f.ui.isEditing(),false);assert.equal(f.$('workflow-add').focused,true);});
test('LoRA enable and strength policies remain independent',async t=>{const f=await setup(t),template=structuredClone(f.template);template.loras=[{id:'style',asset:'lora-one',description:'Soft light',enabled:{policy:'model',default:true},strength:{policy:'fixed',value:0.55}}];await f.ui.edit(template);f.$('native-lora-enabled-style').value='off';f.$('native-lora-strength-policy-style').value='model';f.$('native-lora-strength-policy-style').onchange();f.$('native-lora-strength-min-style').value='0';f.$('native-lora-strength-max-style').value='1';assert.equal(await f.ui.saveEditor(),true);const saved=f.calls.find(call=>call.route==='generation/workflows').body.loras[0];assert.deepEqual(saved.enabled,{policy:'off'});assert.equal(saved.strength.policy,'model');assert.equal(saved.strength.default,0.55);});
test('settings read native generation values and descriptions come from workflow records',async t=>{const f=await setup(t);assert.deepEqual(f.ui.values(),{enabled:true,autoAllow:false,maxIterations:5,pythonPath:'',tokenizerPath:'',modelRoot:''});assert.equal(f.calls.some(call=>call.route==='comfy'),false);assert.deepEqual(f.ui.workflowDescriptions(),[]);});
test('an unchanged native prompt policy remains valid against the shared catalog contract',async t=>{const {validateNativeWorkflow}=await import('../lib/native-workflows.mjs');const f=await setup(t);await f.ui.edit(f.template);await f.ui.saveEditor();const saved=f.calls.find(call=>call.route==='generation/workflows').body;assert.doesNotThrow(()=>validateNativeWorkflow(saved));});
test('LoRA model strength starts with supported limits',async t=>{const {validateNativeWorkflow}=await import('../lib/native-workflows.mjs');const f=await setup(t),record=structuredClone(f.template);record.loras=[{id:'style',asset:'lora-one',description:'Light',enabled:{policy:'off'},strength:{policy:'fixed',value:0.55}}];await f.ui.edit(record);f.$('native-lora-strength-policy-style').value='model';f.$('native-lora-strength-policy-style').onchange();await f.ui.saveEditor();assert.doesNotThrow(()=>validateNativeWorkflow(f.calls.find(call=>call.route==='generation/workflows').body));});
test('video editor requires the coupled audio VAE without inventing selections or offering unsupported enhancement',async t=>{const f=await setup(t),record=structuredClone(f.template);record.pipeline='ltx25';record.mediaType='video';await f.ui.edit(record);assert.equal(f.$('native-component-audioVae').value,'');assert.equal(f.$('native-component-enhancer'),null);assert.equal(await f.ui.saveEditor(),false);assert.match(f.$('native-workflow-error').textContent,/VAE audio/);});
test('typing an unregistered local model path stays dirty and cannot be silently saved',async t=>{const f=await setup(t);await f.ui.edit(f.template);f.$('native-component-model-path').value='new-model.safetensors';assert.equal(f.ui.editorDirty(),true);assert.equal(await f.ui.saveEditor(),false);assert.match(f.$('native-workflow-error').textContent,/Utiliser/);assert.equal(f.ui.isEditing(),true);});
test('shipped pipeline templates round-trip through the editor without corrupting their policy contract',async t=>{const {validateNativeWorkflow}=await import('../lib/native-workflows.mjs'),{readFile}=await import('node:fs/promises');for(const pipeline of ['krea2','ltx25']){const f=await setup(t),record=JSON.parse(await readFile(new URL('../runner/templates/'+pipeline+'.json',import.meta.url),'utf8'));await f.ui.edit(record);assert.equal(await f.ui.saveEditor(),true);assert.doesNotThrow(()=>validateNativeWorkflow(f.calls.find(call=>call.route==='generation/workflows').body));}});

test('newly registered native files can become model-controlled allowed choices immediately',async t=>{const f=await setup(t);await f.ui.edit(f.template);await f.$('native-component-model').parent.children[1].onclick();f.$('native-component-model-policy').value='model';f.$('native-component-model-policy').onchange();assert.equal(f.$('native-component-model').value,'model-new');assert.equal(await f.ui.saveEditor(),true);const component=f.calls.find(call=>call.route==='generation/workflows').body.components.model;assert.equal(component.default,'model-new');assert.ok(component.choices.includes('model-new'));assert.deepEqual(f.calls.find(call=>call.route==='files/choose').body,{kind:'generation',initialPath:'model.safetensors'});assert.equal(f.calls.find(call=>call.route==='generation/assets').body.family,'krea2');});
test('Comfy file import submits its contents for automatic format detection and opens the disabled workflow',async t=>{
 const f=await setup(t),sourceText='{"graph":{"example":"workflow"}}';
 await f.$('native-comfy-file').onchange({target:{files:[],value:''}});assert.equal(f.calls.some(call=>call.route==='generation/import-comfy'),false);
 const target={files:[{size:sourceText.length,text:async()=>sourceText}],value:'workflow.json'};await f.$('native-comfy-file').onchange({target});
 assert.equal(target.value,'');assert.deepEqual(f.calls.find(call=>call.route==='generation/import-comfy').body,{sourceText,modelRoot:'C:/atelier/models/checkpoints'});assert.equal(f.ui.isEditing(),true);assert.equal(f.$('native-workflow-enabled').checked,false);
});

test('oversized Comfy files and reads completed after closing do not create workflows',async t=>{
 const f=await setup(t);await f.$('native-comfy-file').onchange({target:{files:[{size:2*1024*1024+1,text(){throw Error('Must not read oversized files');}}],value:''}});assert.match(f.$('native-import-status').textContent,/2 Mo/);assert.equal(f.ui.isEditing(),false);
 let finish;const text=new Promise(resolve=>{finish=resolve;}),pending=f.$('native-comfy-file').onchange({target:{files:[{size:100,text:()=>text}],value:''}});f.ui.cancelSettings();finish('{}');await pending;assert.equal(f.calls.some(call=>call.route==='generation/import-comfy'),false);assert.equal(f.ui.isEditing(),false);
});
test('parameter ownership uses accessible compact switches and updates selected state',async t=>{const f=await setup(t);await f.ui.edit(f.template);const owner=f.$('native-policy-seed');assert.equal(owner.getAttribute('role'),'group');assert.equal(owner.children.find(button=>button.textContent==='Aléatoire').getAttribute('aria-pressed'),'true');owner.children.find(button=>button.textContent==='Fixe').onclick();assert.equal(owner.value,'fixed');assert.equal(owner.children.find(button=>button.textContent==='Fixe').getAttribute('aria-pressed'),'true');});
test('closing settings cancels native refresh without surfacing an obsolete error',async t=>{const f=await setup(t);const ui=setupNativeWorkflows({state:{},node:f.node,notice(){},api:async(route,body,{signal}={})=>{if(route==='generation')await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));return f.api(route,body);}});const pending=ui.refresh();ui.cancelSettings();await assert.doesNotReject(pending);});
test('model-owned components and parameters can require a model choice without inventing defaults',async t=>{const f=await setup(t),record=structuredClone(f.template);record.components.model={policy:'model',choices:['model-one'],description:'Choose the portrait checkpoint'};record.parameters.width={policy:'model',type:'integer',min:256,max:1024};await f.ui.edit(record);assert.equal(await f.ui.saveEditor(),true);const saved=f.calls.find(call=>call.route==='generation/workflows').body;assert.equal(Object.hasOwn(saved.components.model,'default'),false);assert.equal(Object.hasOwn(saved.parameters.width,'default'),false);assert.equal(saved.components.model.description,'Choose the portrait checkpoint');});

test('blank creation opens, uses the checkpoint folder and rejects incomplete components without losing fields',async t=>{
 const f=await setup(t);await f.ui.edit();assert.equal(f.ui.isEditing(),true);assert.equal(f.$('native-workflow-name').value,'');assert.equal(f.$('native-component-model').value,'');
 f.$('native-workflow-name').value='Personal workflow';f.$('native-workflow-description').value='Portraits';assert.equal(await f.ui.saveEditor(),false);assert.match(f.$('native-workflow-error').textContent,/Choisissez un fichier/);
 await f.$('native-component-model').parent.children[1].onclick();assert.equal(f.calls.find(call=>call.route==='files/choose').body.initialPath,'C:/atelier/models/checkpoints');assert.equal(f.$('native-workflow-name').value,'Personal workflow');
});

test('checkpoint default is displayed while only a custom override is persisted; background refresh preserves the draft',async t=>{
 const f=await setup(t);assert.equal(f.$('native-convert-root').value,'C:/atelier/models/checkpoints');assert.equal(f.ui.values().modelRoot,'');
 f.$('native-convert-root').value='D:/other checkpoints';await f.ui.refresh({settings:false});assert.equal(f.ui.values().modelRoot,'D:/other checkpoints');await f.ui.edit();await f.$('native-component-model').parent.children[1].onclick();assert.equal(f.calls.find(call=>call.route==='files/choose').body.initialPath,'D:/other checkpoints');
});

test('LoRAs can be added and removed with incomplete sibling fields without rebuilding their drafts',async t=>{
 const f=await setup(t);await f.ui.edit(f.template);f.$('native-workflow-add-lora').onclick();const first=f.$('native-workflow-loras').children[0],strength=first.children.find(child=>child.className==='native-parameter'),value=strength.children.find(child=>child.className==='field-group').children[1];value.value='';
 f.$('native-workflow-add-lora').onclick();assert.equal(f.$('native-workflow-loras').children.length,2);assert.equal(value.value,'');first.children.at(-1).onclick();assert.equal(f.$('native-workflow-loras').children.length,1);assert.equal(f.$('native-lora-count').textContent,'1');
 f.$('native-workflow-loras').children[0].children.at(-1).onclick();assert.equal(await f.ui.saveEditor(),true);
});

test('the one-reference image limit survives busy transitions and removing its slot enables adding again',async t=>{
 const f=await setup(t);await f.ui.edit(f.template);f.$('native-workflow-add-reference').onclick();assert.equal(f.$('native-reference-count').textContent,'1');f.ui.setBusy(true);f.ui.setBusy(false);assert.equal(f.$('native-workflow-add-reference').disabled,true);
 f.$('native-workflow-references').children[0].children.at(-1).onclick();assert.equal(f.$('native-workflow-add-reference').disabled,false);
});

test('changing pipeline preserves the old draft until confirmed, even when numeric fields are invalid',async t=>{
 const f=await setup(t);await f.ui.edit(f.template);f.$('native-value-width').value='';f.$('native-workflow-pipeline').value='ltx25';await f.$('native-workflow-pipeline').onchange();assert.equal(f.$('native-workflow-switch').hidden,false);assert.equal(f.$('native-workflow-pipeline').value,'krea2');
 f.$('native-workflow-switch-cancel').onclick();assert.equal(f.$('native-value-width').value,'');f.$('native-workflow-pipeline').value='ltx25';await f.$('native-workflow-pipeline').onchange();await f.$('native-workflow-switch-confirm').onclick();assert.equal(f.$('native-workflow-pipeline').value,'ltx25');assert.equal(f.$('native-workflow-name').value,'Portrait');assert.equal(f.$('native-workflow-enabled').checked,false);assert.equal(f.$('native-component-model').value,'');
});

test('Atelier imports are validated, disabled and assigned new identities instead of overwriting a saved workflow',async t=>{
 const f=await setup(t),file={size:500,text:async()=>JSON.stringify({...f.template,enabled:true})};await f.$('native-workflow-file').onchange({target:{files:[file],value:'file'}});assert.equal(f.ui.isEditing(),true);assert.equal(f.$('native-workflow-enabled').checked,false);assert.equal(await f.ui.saveEditor(),true);
 const saved=f.calls.find(call=>call.route==='generation/workflows').body;assert.notEqual(saved.id,f.template.id);assert.equal(f.workflows.length,2);
});

test('invalid imports and file reads completed after closing never leave a half-open editor',async t=>{
 const f=await setup(t);await f.$('native-workflow-file').onchange({target:{files:[{size:100,text:async()=>JSON.stringify({...f.template,components:null})}],value:''}});assert.equal(f.ui.isEditing(),false);assert.equal(f.$('native-import-status').hidden,false);
 let finish;const text=new Promise(resolve=>{finish=resolve;}),pending=f.$('native-workflow-file').onchange({target:{files:[{size:100,text:()=>text}],value:''}});f.ui.cancelSettings();finish(JSON.stringify(f.template));await pending;assert.equal(f.ui.isEditing(),false);assert.equal(f.$('workflow-editor').hidden,true);
});

test('every static control used during settings initialization exists in the shipped HTML',async t=>{
 const f=await setup(t);assert.ok(f.ui);assert.match(html,/data-settings-section="Génération"/);assert.match(html,/class="settings-block workflow-settings"/);assert.doesNotMatch(html,/Importer un JSON natif|Convertir Krea avec sauvegarde|Format d’origine|Seuls ces deux formats/);
 const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);assert.equal(new Set(ids).size,ids.length);
});
