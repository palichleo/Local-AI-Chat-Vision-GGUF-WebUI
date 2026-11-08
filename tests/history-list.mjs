import{readFile}from'node:fs/promises';import{runInNewContext}from'node:vm';
import test from 'node:test';import assert from 'node:assert/strict';import{setupProjectNavigation,projectGroups}from'../public/project-navigation.mjs';
class Element{
 constructor(tag='',className='',textContent=''){Object.assign(this,{tag,className,textContent,children:[],dataset:{},attributes:{},hidden:false,disabled:false,value:'',classList:{remove(){}}});}
 append(...items){this.children.push(...items);}replaceChildren(...items){this.children=items;}setAttribute(name,value){this.attributes[name]=value;}addEventListener(){}focus(){}close(){this.open=false;}showModal(){this.open=true;}
}
function fixture(t,patch={}){
 const previous=globalThis.document,nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
 globalThis.document={body:{dataset:{}},querySelectorAll:()=>[]};t.after(()=>{globalThis.document=previous;});$('conversation-title').textContent='Current conversation';
 const state={projects:[{id:'inbox',name:'Conversations'},{id:'project',name:'A project'}],projectId:'project',view:'chat',saveHistory:true,status:{},conversationId:'current',historyItems:[{id:'past',title:'Past',projectId:'project',updatedAt:'2026-11-07'},{id:'current',title:'Current',projectId:'project',updatedAt:'2026-11-08'}],...patch},calls=[];
 const ui=setupProjectNavigation({$,state,node:(...args)=>new Element(...args),icon:name=>new Element('svg',name),api:async(route,body)=>{calls.push([route,body]);return Response.json({project:{id:'created',name:body?.name},conversation:{...state.historyItems[0],projectId:body?.projectId}});},notice:text=>calls.push(['notice',text]),openConversation:id=>calls.push(['open',id]),newConversation:id=>calls.push(['new',id]),removeConversation:item=>calls.push(['delete',item.id]),showHome:()=>calls.push(['home'])});ui.render();return {ui,state,$,calls};
}
const walk=element=>[element,...element.children.flatMap(walk)];
test('one project level groups current and saved conversations without duplicates and keeps delete actions',t=>{
 const{$,calls}=fixture(t);for(const id of ['history-list','history-list-mobile']){
  const groups=$(id).children;assert.equal(groups.length,2);const conversations=groups[0].children[1].children;assert.equal(conversations.length,2);
  assert.equal(conversations[0].children[0].dataset.conversationId,'current');assert.equal(conversations[0].children[0].attributes['aria-current'],'page');conversations[1].children[0].onclick();conversations[0].children[1].onclick();
 }assert.deepEqual(calls,[['open','past'],['delete','current'],['open','past'],['delete','current']]);
});
test('history disabled still shows the current unsaved conversation only in its project',t=>{
 const{$}=fixture(t,{saveHistory:false,historyItems:[],conversationId:null});const rows=walk($('history-list')).filter(element=>element.className.startsWith('history-item'));assert.equal(rows.length,1);assert.equal(rows[0].attributes['aria-current'],'page');assert.equal(walk($('history-list')).filter(element=>element.className.includes('history-delete-button')).length,0);
});
test('home shows ten most recent first prompts, a visual cover and no invented active conversation',t=>{
 const items=Array.from({length:12},(_,i)=>({id:String(i),title:'Title '+i,firstPrompt:'First prompt '+i,projectId:'project',updatedAt:String(i).padStart(2,'0'),...(i===11?{previewUrl:'/media/preview'}:{})}));const{$,calls}=fixture(t,{view:'home',historyItems:items});
 assert.equal(walk($('history-list')).filter(element=>element.attributes['aria-current']).length,0);const card=$('project-grid').children[0];assert.match(card.className,/is-visual/);const recent=walk(card).filter(element=>element.className==='project-recent-item');assert.equal(recent.length,10);assert.equal(recent[0].children[0].textContent,'First prompt 11');recent[0].onclick();assert.deepEqual(calls,[['open','11']]);
});
test('project collapse, rename and project-specific new conversation keep the hierarchy intact',async t=>{
 const{$,calls,state}=fixture(t);const group=$('history-list').children[0];group.children[0].children[0].onclick();assert.equal($('history-list').children[0].children[1].hidden,true);
 $('project-create').onclick();$('project-name').value='A new idea';await $('project-form').onsubmit({preventDefault(){}});assert.ok(state.projects.some(project=>project.name==='A new idea'));
 const added=walk($('history-list')).find(element=>element.attributes['aria-label']==='Nouvelle conversation dans A new idea');added.onclick();assert.ok(calls.some(call=>call[0]==='new'&&call[1]==='created'));$('brand-home').onclick({preventDefault(){}});assert.deepEqual(calls.at(-1),['home']);
});
test('moving an unsaved conversation changes its organization without saving chat content',async t=>{
 const{$,calls,state}=fixture(t,{conversationId:null,historyItems:[]});$('conversation-project').value='inbox';await $('conversation-project').onchange();assert.equal(state.projectId,'inbox');assert.deepEqual(calls,[]);
});
test('unknown old project associations stay visible in the default group and sorting does not mutate history',()=>{
 const items=[{id:'old',projectId:'missing',updatedAt:'2025'},{id:'new',updatedAt:'2026'}],groups=projectGroups([{id:'inbox',name:'Conversations'}],items);assert.deepEqual(groups[0].conversations.map(item=>item.id),['new','old']);assert.equal(items[0].id,'old');
});

test('logo navigation keeps the current messages and draft and closes the mobile tree',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8'),state={projectWorking:false,status:{},view:'chat',messages:[{role:'user',content:'Keep'}]},prompt={value:'An unsent draft'},attributes={},document={body:{dataset:{navOpen:'true'}}};let pending,saves=0,renders=0;
 const context={updateControls(){},notice(){},state,document,$:id=>id==='prompt'?prompt:{setAttribute:(name,value)=>attributes[name]=value},assetsUI:{flush:async()=>true},persistConversation:async()=>{saves++;return true;},settingsGuard:{requestClose:action=>{pending=action();}},projectUI:{render:()=>renders++}};
 runInNewContext(source.slice(source.indexOf('function closeNavigation('),source.indexOf('async function newConversation('))+';this.show=showHome;',context);context.show();await pending;
 assert.equal(state.view,'home');assert.deepEqual(state.messages,[{role:'user',content:'Keep'}]);assert.equal(prompt.value,'An unsent draft');assert.equal(document.body.dataset.navOpen,'false');assert.equal(saves,1);assert.equal(renders,1);
});

test('home keeps an unsaved conversation reachable without adding it to saved project cards',t=>{
 const{$,calls}=fixture(t,{view:'home',conversationId:null,historyItems:[],messages:[{role:'user',content:'Unsaved'}],saveHistory:false});const row=walk($('history-list')).find(element=>element.className.startsWith('history-item'));assert.ok(row);assert.equal(row.attributes['aria-current'],undefined);row.onclick();assert.deepEqual(calls,[['open',null]]);assert.equal(walk($('project-grid')).filter(element=>element.className==='project-recent-item').length,0);
});

test('Home uses the existing return action and indicates the current view without changing the conversation',t=>{
 const{ui,state,$,calls}=fixture(t),before=JSON.stringify(state.historyItems);assert.equal($('home-open').attributes['aria-current'],'false');$('home-open').onclick();assert.deepEqual(calls,[['home']]);assert.equal(JSON.stringify(state.historyItems),before);assert.equal(state.conversationId,'current');state.view='home';ui.render();assert.equal($('home-open').attributes['aria-current'],'page');
});

test('Home locks navigation while pending descriptions and saves complete',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8'),state={status:{},view:'chat'},document={body:{dataset:{}}};let release,pending;
 const gate=new Promise(resolve=>{release=resolve;}),context={state,document,$:()=>({setAttribute(){}}),updateControls(){},notice(){},assetsUI:{flush:()=>gate},persistConversation:async()=>true,settingsGuard:{requestClose:action=>{pending=action();}},projectUI:{render(){}}};
 runInNewContext(source.slice(source.indexOf('function closeNavigation('),source.indexOf('async function newConversation('))+';this.home=showHome;',context);
 try{context.home();assert.equal(state.loadingHistory,true);}finally{release(true);await pending;}
 assert.equal(state.loadingHistory,false);assert.equal(state.view,'home');
});
test('a deferred Home action never hides a response that started while settings confirmation was pending',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8'),state={status:{},view:'chat'};let deferred,flushes=0;
 const context={state,document:{body:{dataset:{}}},$:()=>({setAttribute(){}}),updateControls(){},notice(){},assetsUI:{flush:async()=>{flushes++;return true;}},persistConversation:async()=>true,settingsGuard:{requestClose:action=>{deferred=action;}},projectUI:{render(){}}};
 runInNewContext(source.slice(source.indexOf('function closeNavigation('),source.indexOf('async function newConversation('))+';this.home=showHome;',context);context.home();state.generating=true;await deferred();assert.equal(state.view,'chat');assert.equal(flushes,0);
});
test('closing All files pauses media before hiding the panel',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8'),document={body:{dataset:{files:'open'}}};let paused=0;
 const context={document,assetsUI:{pause:()=>paused++},$:()=>({setAttribute(){}})};runInNewContext(source.slice(source.indexOf('function openFiles('),source.indexOf('function showHome('))+';this.close=()=>openFiles(false);',context);context.close();assert.equal(paused,1);assert.equal(document.body.dataset.files,'closed');
});

test('failed Home preparation keeps the chat visible and releases navigation controls',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 for(const failure of [false,new Error('Description save failed')]){
  const state={status:{},view:'chat'};let pending,renders=0,notices=[];
  const context={state,document:{body:{dataset:{}}},$:()=>({setAttribute(){}}),updateControls(){},notice:text=>notices.push(text),assetsUI:{flush:async()=>{if(failure)throw failure;return false;}},persistConversation:async()=>{throw Error('Must not save');},settingsGuard:{requestClose:action=>{pending=action();}},projectUI:{render:()=>renders++}};
  runInNewContext(source.slice(source.indexOf('function closeNavigation('),source.indexOf('async function newConversation('))+';this.home=showHome;',context);context.home();await pending;assert.equal(state.view,'chat');assert.equal(state.loadingHistory,false);assert.equal(renders,0);assert.equal(notices.length,failure?1:0);
 }
});
