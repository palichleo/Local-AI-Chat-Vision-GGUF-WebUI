import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { setupSettingsGuard } from '../public/settings-guard.mjs';

const tick = () => new Promise(setImmediate);
const savedConfig = { enginePath: 'engine.exe', modelPath: 'saved.gguf', projectorPath: '', contextSize: 4096, maxOutputTokens: 2048, gpuLayers: 999 };
const savedComfy = { enabled: false, baseUrl: 'http://127.0.0.1:8188', autoAllow: false, maxIterations: 5 };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function settingsUI({ request, refresh = async () => {}, saved = () => {} } = {}) {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', hidden: true, disabled: false, open: false, checked: false, dataset: {}, listeners: {}, style: {}, children: [],
      classList: { toggle() {}, contains: () => false, add() {}, remove() {} },
      addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); },
      setAttribute() {}, getAttribute:()=>null, append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; }, focus() {},
      close() { this.open = false; for (const listener of this.listeners.close || []) listener(); }, showModal() { this.open = true; } });
    return nodes.get(id);
  };
  const calls = [], refreshes = [], windowListeners = {};
  let comfyOptions,meterOptions,meterSchedules=0;
  const comfyUI = { refresh: options => { refreshes.push(options); return refresh(options); }, saved, cancelSettings() {}, setBusy() {}, values: () => savedComfy, workflowDescriptions: () => [], reset() {} };
  const context = { console, AbortController, AbortSignal, crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    setupProjectNavigation:()=>({render(){},sync(){},refresh:async()=>{}}),
    setupGenerationUI:()=>({clear(){},restore(){}}),
    setupAssets:()=>({setBusy(){},pause(){},hasDraft:()=>false}),
    confirm:()=>true,setupSettingsSearch:()=>({reset(){},refresh(){}}),setupSettingsGuard, setupCopy(){},setupContextMeter:options=>{meterOptions=options;return {schedule(){meterSchedules++;},pause(){},observe(){}};},
    setupMaterialLighting() {}, dismissSettingsOnOutsideClick() {}, setupTokenControls: () => ({ setValues() {}, values: () => ({ contextSize: 4096, maxOutputTokens: 2048 }) }),
    setupComputeControls: () => ({ setValues(config) { $('compute-mode').value = String(config.gpuLayers); }, values: () => ({ gpuLayers: 999 }) }),
    setupComfy: options => { comfyOptions = options; return comfyUI; },
    document: { getElementById: $, querySelectorAll: selector => selector === 'button,input,textarea,select' ? [...nodes.values()] : [], documentElement: { dataset: { theme: 'dark' } }, addEventListener() {}, createElement: () => $('node-' + nodes.size), createElementNS: () => $('node-' + nodes.size) },
    window: { addEventListener(name, listener) { windowListeners[name] = listener; } },
    fetch: async (url, options = {}) => {
      const call = { route: url.replace('/api/', ''), body: options.body === undefined ? undefined : JSON.parse(options.body), options }; calls.push(call);
      if (request) { const response = await request(call); if (response) return response; }
      if (call.route === 'models') return Response.json({models:[],detected:[],errors:[]});
      if (call.route === 'bootstrap') return Response.json({ config: savedConfig, preferences: { theme: 'dark', saveHistory: true }, status: { state: 'stopped', logs: [] } });
      if (call.route === 'shutdown') return Response.json({stopping:true});
      if (call.route === 'status') return Response.json({ state: 'stopped', logs: [] });
      if (call.route === 'history') return Response.json({ conversations: [], skipped: 0 });
      if (call.route === 'preferences') return Response.json({ preferences: { theme: 'dark', saveHistory: call.body.saveHistory ?? true } });
      if (call.route === 'settings') return Response.json({ config: call.body.config, instructions:call.body.instructions||'', comfy: savedComfy, workflows: [] });
      if (call.route === 'models/select') return Response.json({config:savedConfig,modelName:'Saved',status:{state:'stopped',logs:[]}});
      if (call.route === 'history/save') return Response.json({ conversation: { id: call.body.id, title: 'Saved', updatedAt: '2026-11-08T00:00:00.000Z' } });
      if (call.route === 'gallery/persist') return Response.json({});
      throw new Error('Unexpected route ' + call.route);
    },
  };
  const application = source.slice(0, source.lastIndexOf('\ntry {')).replace(/^import .*;\r?\n/gm, '');
  runInNewContext(application + '\nthis.app = { state, openSettings, saveConfiguration, changePreferences, persistConversation, refreshHistory, updateControls, refreshStatus, renderModelSelect, applyModelLibrary, switchLLM, addLLM, saveLLM, cancelLLM, modelDraft, modelEditorDirty, chooseDetectedModel, shutdownApplication: typeof shutdownApplication === "function" ? shutdownApplication : null };', context);
  Object.assign(context.app.state, { token: 'test', config: { ...savedConfig }, connected: true });
  return { ...context.app, $, calls, refreshes, windowListeners, comfyUI, comfyOptions, meterOptions, meterSchedules:()=>meterSchedules, async open() { context.app.openSettings(); await tick(); } };
}

test('an older settings load cannot unlock the next dialog', async () => {
  const pending = [];
  const ui = await settingsUI({ refresh: () => { const load = deferred(); pending.push(load); return load.promise; } });
  await ui.open(); ui.$('settings').close(); await ui.open();
  pending[0].resolve(); await tick();
  assert.equal(ui.state.settingsLoading, true);
  assert.equal(ui.$('save-config').disabled, true);
  pending[1].resolve(); await tick();
  assert.equal(ui.state.settingsLoading, false);
});

test('settings fields remain locked until every settings load succeeds', async () => {
  const pending = deferred();
  const ui = await settingsUI({ refresh: () => pending.promise });
  await ui.open();
  assert.equal(ui.$('config-fields').disabled, true);
  pending.reject(new Error('Cannot read Comfy settings')); await tick();
  assert.equal(ui.$('save-config').disabled, true);
  await ui.saveConfiguration();
  assert.equal(ui.calls.some(call => call.route === 'settings'), false);
});

test('a save finishing after reopening preserves the new dialog and its draft', async () => {
  const pending = deferred();
  const ui = await settingsUI({ request: call => call.route === 'settings' ? pending.promise : undefined });
  await ui.open(); const saving = ui.saveConfiguration();
  ui.$('settings').close(); await ui.open(); ui.$('model-path').value = 'new-draft.gguf';
  pending.resolve(Response.json({ config: { ...savedConfig, modelPath: 'just-saved.gguf' }, comfy: savedComfy, workflows: [] })); await saving;
  assert.equal(ui.$('settings').open, true);
  assert.equal(ui.$('model-path').value, 'new-draft.gguf');
});

test('a stale save error never appears in reopened settings', async () => {
  const pending = deferred();
  const ui = await settingsUI({ request: call => call.route === 'settings' ? pending.promise : undefined });
  await ui.open(); const saving = ui.saveConfiguration();
  ui.$('settings').close(); await ui.open();
  pending.reject(new Error('Old save failed')); await saving;
  assert.equal(ui.$('config-error').hidden, true);
});

test('saving uses the settings result without a second network read', async () => {
  let result;
  const ui = await settingsUI({ saved: saved => { assert.ok(saved, 'saved settings response is required'); result = saved; } });
  await ui.open(); await ui.saveConfiguration();
  assert.equal(result.config.modelPath, 'saved.gguf');
  assert.equal(ui.$('settings').open, false);
});

test('a Comfy operation locks settings saving, model fields and engine start', async () => {
  const ui = await settingsUI(); await ui.open();
  assert.equal(typeof ui.comfyOptions.onSettingsBusyChange, 'function');
  ui.comfyOptions.onSettingsBusyChange(true);
  for (const id of ['save-config', 'config-fields', 'toggle-engine', 'update-available']) assert.equal(ui.$(id).disabled, true, id);
  await ui.saveConfiguration();
  assert.equal(ui.calls.some(call => call.route === 'settings'), false);
  ui.comfyOptions.onSettingsBusyChange(false);
  assert.equal(ui.$('save-config').disabled, false);
});

test('engine polling preserves the settings validation error', async () => {
  const ui = await settingsUI({ request: call => call.route === 'settings' ? Response.json({ error: 'Select a valid model' }, { status: 400 }) : call.route === 'status' ? Response.json({ state: 'error', error: 'Previous engine error', logs: [] }) : undefined });
  await ui.open(); await ui.saveConfiguration(); await ui.refreshStatus();
  assert.equal(ui.$('config-error').textContent, 'Select a valid model');
});

test('reopening settings reads current model configuration from the server', async () => {
  const ui = await settingsUI({ request: call => call.route === 'bootstrap' ? Response.json({ config: { ...savedConfig, modelPath: 'other-tab.gguf' } }) : undefined });
  await ui.open();
  assert.equal(ui.$('model-path').value, 'other-tab.gguf');
  await ui.saveConfiguration();
  assert.equal(ui.calls.find(call => call.route === 'settings').body.config.modelPath, 'other-tab.gguf');
});

test('enabling history saves the current conversation even when listing history fails', async () => {
  const ui = await settingsUI({ request: call => call.route === 'history' ? Response.json({ error: 'Cannot list' }, { status: 500 }) : undefined });
  ui.state.saveHistory = false; ui.state.messages = [{ role: 'user', content: 'Keep this conversation' }];
  ui.$('history-enabled').checked = true; await ui.$('history-enabled').onchange();
  assert.equal(ui.state.saveHistory, true);
  assert.equal(ui.calls.filter(call => call.route === 'history/save').length, 1);
  assert.equal(ui.calls.filter(call => call.route === 'gallery/persist').length, 1);
});

test('disabling history waits for accepted queued writes before changing the preference', async () => {
  const firstWrite = deferred(); let writes = 0;
  const ui = await settingsUI({ request: call => call.route === 'history/save' && ++writes === 1 ? firstWrite.promise : undefined });
  ui.state.messages = [{ role: 'user', content: 'First message' }]; const first = ui.persistConversation(); await tick();
  ui.state.messages = [{ role: 'user', content: 'Second message' }]; const second = ui.persistConversation();
  const disabling = ui.changePreferences({ saveHistory: false }); await tick();
  assert.equal(ui.calls.some(call => call.route === 'preferences'), false);
  firstWrite.resolve(Response.json({ conversation: { id: ui.state.conversationId, title: 'First', updatedAt: '2026-11-08T00:00:00.000Z' } }));
  await Promise.all([first, second, disabling]);
  assert.equal(ui.calls.filter(call => call.route === 'history/save').length, 2);
  assert.equal(ui.state.historyDirty, false);
  assert.equal(ui.state.saveHistory, false);
});

test('clearing the configured model also clears the sidebar model name', async () => {
  const ui=await settingsUI();ui.updateControls();assert.equal(ui.$('sidebar-model').textContent,'Modèle GGUF');ui.state.config.modelPath='/models/Folder name/main.gguf';ui.updateControls();assert.equal(ui.$('sidebar-model').textContent,'Folder name');
  ui.state.config.modelPath='';ui.updateControls();
  assert.equal(ui.$('sidebar-model').textContent,'Modèle GGUF');
  assert.equal(ui.$('sidebar-model-detail').textContent,'Aucun modèle configuré');
});

test('opening settings reflects theme and history changed in another tab', async () => {
  const ui=await settingsUI({request:call=>call.route==='bootstrap'?Response.json({config:savedConfig,preferences:{theme:'light',saveHistory:false}}):undefined});
  await ui.open();
  assert.equal(ui.state.theme,'light');assert.equal(ui.state.saveHistory,false);assert.equal(ui.$('history-enabled').checked,false);
});

test('closing the application saves accepted conversation writes before shutting the server down',async()=>{
 const ui=await settingsUI();assert.equal(typeof ui.shutdownApplication,'function');await ui.open();
 ui.state.messages=[{role:'user',content:'Keep this conversation'}];await ui.shutdownApplication();
 const routes=ui.calls.map(call=>call.route);assert.ok(routes.indexOf('history/save')<routes.indexOf('shutdown'));
 assert.equal(ui.$('settings').open,false);assert.equal(ui.state.connected,false);assert.equal(ui.$('shutdown-app').disabled,true);
});

test('a history save failure leaves the app open and restores the settings controls',async()=>{
 const ui=await settingsUI({request:call=>call.route==='history/save'?Response.json({error:'Disk full'},{status:500}):undefined});await ui.open();
 ui.state.messages=[{role:'user',content:'Keep me'}];await ui.shutdownApplication();
 assert.equal(ui.state.connected,true);assert.equal(ui.$('settings-close').disabled,false);assert.equal(ui.$('settings-open').disabled,false);assert.equal(ui.calls.some(call=>call.route==='shutdown'),false);
});

test('changed paths warn on close and on browser closure; keep and discard preserve the intended settings',async()=>{
 const ui=await settingsUI();await ui.open();ui.$('model-path').value='unsaved.gguf';ui.$('settings-close').onclick();
 assert.equal(ui.$('settings').open,true);assert.equal(ui.$('settings-unsaved').open,true);
 let prevented=false;ui.windowListeners.beforeunload({preventDefault(){prevented=true;}});assert.equal(prevented,true);
 ui.$('settings-keep').onclick();assert.equal(ui.$('model-path').value,'unsaved.gguf');assert.equal(ui.$('settings').open,true);
 ui.$('settings-close').onclick();ui.$('settings-discard').onclick();assert.equal(ui.$('settings').open,false);
 await ui.open();assert.equal(ui.$('model-path').value,savedConfig.modelPath);
});
test('immediately saved preferences and reverted fields do not create a false unsaved warning',async()=>{
 const ui=await settingsUI();await ui.open();ui.$('model-path').value='draft';ui.$('model-path').value=savedConfig.modelPath;
 ui.$('history-enabled').checked=false;ui.$('theme-toggle').value='light';ui.$('settings-close').onclick();
 assert.equal(ui.$('settings').open,false);assert.equal(ui.$('settings-unsaved').open,false);
});
test('unsaved workflow descriptions prompt, and an unfinished workflow import cannot be discarded by the save button',async()=>{
 const ui=await settingsUI();await ui.open();ui.comfyUI.workflowDescriptions=()=>[{id:'photo',description:'Draft'}];ui.$('settings-close').onclick();assert.equal(ui.$('settings-unsaved').open,true);ui.$('settings-keep').onclick();
 ui.comfyUI.hasPendingImport=()=>true;ui.comfyUI.finishImport=async()=>false;await ui.saveConfiguration();assert.equal(ui.$('settings').open,true);assert.equal(ui.calls.some(call=>call.route==='settings'),false);
});

test('the main Save finishes a prepared workflow before saving configuration and closing',async()=>{
 const ui=await settingsUI();await ui.open();let pending=true,finished=0;
 ui.comfyUI.hasPendingImport=()=>pending;ui.comfyUI.finishImport=async()=>{finished++;assert.equal(ui.calls.some(call=>call.route==='settings'),false);pending=false;return true;};
 await ui.saveConfiguration();assert.equal(finished,1);assert.equal(ui.$('settings').open,false);assert.equal(ui.calls.filter(call=>call.route==='settings').length,1);
});

test('a rejected workflow remains unsaved and closing settings asks before discarding it',async()=>{
 const ui=await settingsUI();await ui.open();ui.comfyUI.hasPendingImport=()=>true;ui.comfyUI.finishImport=async()=>false;
 await ui.saveConfiguration();assert.equal(ui.$('settings').open,true);assert.equal(ui.calls.some(call=>call.route==='settings'),false);
 ui.$('settings-close').onclick();assert.equal(ui.$('settings-unsaved').open,true);ui.$('settings-keep').onclick();assert.equal(ui.$('settings').open,true);
});

test('slow status checks cannot accumulate concurrent polling requests',async()=>{
 const gate=deferred();let calls=0;
 const ui=await settingsUI({request:call=>{if(call.route==='status'){calls++;assert.ok(call.options.signal);return gate.promise.then(response=>response.clone());}}});
 const first=ui.refreshStatus();await ui.refreshStatus();await ui.refreshStatus();assert.equal(calls,1);
 gate.resolve(Response.json({state:'ready',vision:false,logs:[]}));await first;
 await ui.refreshStatus();assert.equal(calls,2);assert.equal(ui.state.connected,true);
});

test('opening settings rescans folders and selecting one fills both paths without choosing an engine',async()=>{
 let scans=0;const profile={id:'a',name:'Folder name',modelPath:'/models/Folder name/main.gguf',projectorPath:'/models/Folder name/mmproj.gguf'};
 const ui=await settingsUI({request:call=>call.route==='models'?(scans++,Response.json({models:[],detected:[profile],errors:[]})):undefined});
 await ui.open();assert.equal(scans,1);ui.$('detected-model').value='a';ui.chooseDetectedModel();assert.equal(ui.$('model-path').value,profile.modelPath);assert.equal(ui.$('projector-path').value,profile.projectorPath);assert.equal(ui.$('engine-path').value,'engine.exe');
 ui.$('settings').close();await ui.open();assert.equal(scans,2);
});
test('saved models have folder names and the sidebar selector locks during GPU work',async()=>{
 const ui=await settingsUI(),profiles=[{id:'a',name:'Alpha folder',modelPath:'/models/Alpha folder/main.gguf',projectorPath:''},{id:'b',name:'Beta folder',modelPath:'/models/Beta folder/main.gguf',projectorPath:''}];
 ui.applyModelLibrary({models:profiles,detected:[],errors:[]});ui.updateControls();assert.equal(ui.$('model-select').hidden,false);assert.ok(ui.$('model-select').children.some(item=>item.textContent==='Alpha folder'));
 ui.state.generating=true;ui.updateControls();assert.equal(ui.$('model-select').disabled,true);ui.state.generating=false;ui.updateControls();assert.equal(ui.$('model-select').disabled,false);
});

test('switching the sidebar model uses the saved profile and does not discard conversation messages',async()=>{
 const profile={id:'second',name:'Second folder',modelPath:'/models/Second folder/main.gguf',projectorPath:''};
 const ui=await settingsUI({request:call=>call.route==='models/select'?Response.json({config:{...savedConfig,...profile},modelName:profile.name,status:{state:'stopped',logs:[]}}):undefined});
 ui.state.messages=[{role:'user',content:'Keep this chat'}];ui.applyModelLibrary({models:[profile],detected:[],errors:[]});ui.updateControls();ui.$('model-select').value=profile.id;await ui.switchLLM();
 assert.equal(ui.calls.find(item=>item.route==='models/select').body.id,profile.id);assert.equal(ui.state.modelName,'Second folder');assert.equal(ui.state.messages[0].content,'Keep this chat');
});


test('LLM dropdown initially selects the current model and details remain collapsed',async()=>{
 const profile={id:'active',name:'Active name',modelPath:'saved.gguf',projectorPath:''},other={id:'other',name:'Other',modelPath:'other.gguf',projectorPath:''};
 const ui=await settingsUI({request:call=>call.route==='models'?Response.json({models:[other,profile],detected:[],errors:[]}):undefined});await ui.open();
 assert.equal(ui.$('detected-model').value,'active');assert.equal(ui.$('llm-name').value,'Active name');assert.equal(ui.$('model-paths').open,false);assert.equal(ui.$('detected-model').children.length,2);
});
test('Ajouter un LLM opens a blank editor and does not save before its local Enregistrer',async()=>{
 const ui=await settingsUI();await ui.open();ui.addLLM();assert.equal(ui.$('llm-name').value,'');assert.equal(ui.$('model-path').value,'');assert.equal(ui.$('projector-path').value,'');assert.equal(ui.$('model-paths').open,true);assert.equal(ui.calls.some(call=>call.route==='models/add'),false);
 assert.equal(await ui.saveLLM(),false);assert.equal(ui.$('llm-error').hidden,false);assert.equal(ui.calls.some(call=>call.route==='models/add'),false);ui.cancelLLM();assert.equal(ui.$('model-paths').open,false);
});
test('saving an LLM retains unrelated global drafts and uses the edited name and paths',async()=>{
 let pair;const ui=await settingsUI({request:call=>{
  if(call.route==='models/add'){pair={id:'saved',name:call.body.name,modelPath:call.body.modelPath,projectorPath:call.body.projectorPath};return Response.json({profile:pair,models:[pair]});}
  if(call.route==='models/select')return Response.json({config:{...savedConfig,modelPath:pair.modelPath,projectorPath:pair.projectorPath},modelName:pair.name,status:{state:'stopped',logs:[]}});
 }});await ui.open();ui.$('comfy-auto').checked=true;ui.$('global-instructions').value='Unrelated draft';ui.addLLM();ui.$('llm-name').value='Manual name';ui.$('model-path').value='/external/Manual/model.gguf';
 assert.equal(await ui.saveLLM(),true);assert.equal(ui.$('model-paths').open,false);assert.equal(ui.$('settings').open,true);assert.equal(ui.$('llm-name').value,'Manual name');assert.equal(ui.$('global-instructions').value,'Unrelated draft');
 ui.$('settings-close').onclick();assert.equal(ui.$('settings-unsaved').open,true,'other drafts must still warn');
});
test('a failed local LLM save keeps the editor and does not overwrite the active model',async()=>{
 const ui=await settingsUI({request:call=>call.route==='models/add'?Response.json({error:'Bad GGUF'},{status:400}):undefined});await ui.open();const path=ui.state.config.modelPath;ui.addLLM();ui.$('llm-name').value='New';ui.$('model-path').value='bad';assert.equal(await ui.saveLLM(),false);assert.equal(ui.state.config.modelPath,path);assert.equal(ui.$('model-paths').open,true);assert.match(ui.$('llm-error').textContent,/Bad GGUF/);
});

test('a saved profile can be retried if activation fails after its identity changed',async()=>{
 let activations=0,ids=[];const profile={id:'new-id',name:'Saved name',modelPath:'/new/model.gguf',projectorPath:''};
 const ui=await settingsUI({request:call=>{
  if(call.route==='models/add'){ids.push(call.body.id);return Response.json({profile,models:[profile]});}
  if(call.route==='models/select'){if(++activations===1)return Response.json({error:'Busy'},{status:409});return Response.json({config:{...savedConfig,modelPath:profile.modelPath},modelName:profile.name,status:{state:'stopped',logs:[]}});}
 }});await ui.open();ui.addLLM();ui.$('llm-name').value=profile.name;ui.$('model-path').value=profile.modelPath;
 assert.equal(await ui.saveLLM(),false);assert.equal(ui.state.config.modelPath,'saved.gguf');assert.equal(await ui.saveLLM(),true);assert.equal(ids[1],profile.id);
});

test('context counting contains only the selected conversation and typing does not schedule a recount',async()=>{
 const ui=await settingsUI();ui.$('prompt').value='Unsent draft';assert.equal(ui.meterOptions.getRequest(),null);
 const sent={role:'user',content:'Already sent'},reply={role:'assistant',content:'Already answered'};ui.state.messages=[sent,reply];const payload=ui.meterOptions.getRequest();assert.equal(payload.messages.length,3);assert.equal(payload.messages[1].content,'Already sent');assert.equal(payload.messages[2].content,'Already answered');assert.ok(!JSON.stringify(payload).includes('Unsent draft'));
 const scheduled=ui.meterSchedules();ui.$('prompt').oninput();assert.equal(ui.meterSchedules(),scheduled);
});
