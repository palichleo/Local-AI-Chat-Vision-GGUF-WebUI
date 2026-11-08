import {setupProjectNavigation} from './project-navigation.mjs';
import { setupSettingsSearch } from './settings-search.mjs';
import { setupGenerationUI } from './generation-ui.mjs';
import { setupAssets } from './assets-ui.mjs';
import { setupCopy } from './copy.mjs';
import { setupSettingsGuard } from './settings-guard.mjs';
import { setupContextMeter } from './context-meter.mjs';
import { installFromButton, compactSession } from './update-ui.mjs';
import { setupMaterialLighting } from './material-light.mjs';
import { readSSE } from './stream.mjs';
import { markdownToHtml } from './markdown.mjs';
import { setupComfy } from './comfy-ui.mjs';
import { prepareImages } from './images.mjs';
import { setupTokenControls, setupComputeControls, dismissSettingsOnOutsideClick } from './settings-controls.mjs';
import { waitForModel } from './model-ready.mjs';

const $ = (id) => document.getElementById(id);
const state = {
  view:'home', projectId:'inbox', projects:[{id:'inbox',name:'Conversations'}], projectWorking:false,
  token: '', config: {}, globalInstructions:'', conversationInstructions:null, models: [], detectedModels: [], modelName: '', status: { state: 'stopped', vision: false, busy: false, logs: [] },
  connected: false, thinking: true, messages: [], images: [], generating: false,
  preparing: false, operation: false, controller: null, stickToBottom: true, theme: 'dark', savingPreferences: false, waitingForModel: false, settingsLoading: false, settingsSession: 0, settingsReady: false, comfyWorking: false, disablingHistory: false,
  resourceWorking: false, saveHistory: true, conversationId: null, historyItems: [], archiveSnapshot: null, savingHistory: false, historyDirty: false, loadingHistory: false, clearingHistory: false,
};
const labels = { stopped: 'Moteur arrêté', loading: 'Chargement du modèle…', ready: 'Prêt à discuter', stopping: 'Arrêt en cours…', error: 'Vérifier le moteur' };

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function notice(message) {
  $('notice-text').textContent = message;
  $('notice').hidden = !message;
}

async function api(route, body, options = {}) {
  const {raw=false,headers:extraHeaders={},...requestOptions}=options;
  const response = await fetch(`/api/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': raw?'application/octet-stream':'application/json', ...extraHeaders },
    ...(body === undefined ? {} : { body: raw?body:JSON.stringify(body) }), ...requestOptions,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || `La requête a échoué (${response.status}).`), { status: response.status });
  }
  return response;
}

let historyWrite = Promise.resolve();
let historyDeleteTarget = null;
function confirmHistoryDeletion(item = null) {
  historyDeleteTarget = item;
  $('history-delete-title').textContent = item ? 'Supprimer cette conversation ?' : 'Supprimer l’historique ?';
  $('history-delete-description').textContent = item
    ? '« ' + item.title + ' » sera supprimée avec ses copies compressées et ses liens vers ComfyUI. Les images originales restent à leur emplacement. Le brouillon de saisie sera conservé.'
    : 'Les conversations, les copies compressées et les liens vers les sorties seront supprimés. Les originaux ComfyUI restent à leur emplacement. L’échange affiché sera fermé ; le brouillon de saisie sera conservé.';
  $('history-delete-error').hidden = true;
  if (!$('history-delete-dialog').open) $('history-delete-dialog').showModal();
}

function renderHistory() { projectUI.render(); }

function setConversationTitle(title) {
  $('conversation-title').textContent = title;
  $('chat-heading').textContent=title;
  renderHistory();
}

async function refreshHistory() {
  if (!state.saveHistory) { state.historyItems = []; renderHistory(); return; }
  const result = await (await api('history')).json();
  state.historyItems = result.conversations;
  renderHistory();
  if (result.skipped) notice(`${result.skipped} conversation(s) illisible(s) ignorée(s). Les fichiers restent sur disque.`);
}

async function changePreferences(patch) {
  if (state.savingPreferences) return false;
  state.savingPreferences = true;
  updateControls();
  state.disablingHistory = patch.saveHistory === false;
  try {
    if (state.disablingHistory) await historyWrite;
    const { preferences } = await (await api('preferences', patch)).json();
    state.saveHistory = preferences.saveHistory;
    applyTheme(preferences.theme);
    await refreshHistory().catch(error => notice(error.message));
    return true;
  } catch (error) { notice(error.message); return false; }
  finally { state.savingPreferences = false; state.disablingHistory = false; updateControls(); }
}

function persistConversation() {
  const snapshot = state.archiveSnapshot || { messages: state.messages, incomplete: false };
  if (!state.saveHistory || state.disablingHistory || !snapshot.messages.length) return Promise.resolve(true);
  const projectId=state.projectId||'inbox';
  const id = state.conversationId ||= crypto.randomUUID();const instructions=state.conversationInstructions||'';
  state.historyDirty = true;
  historyWrite = historyWrite.then(async () => {
    if (!state.saveHistory) return true;
    state.savingHistory = true;
    try {
      const { conversation } = await (await api('history/save', { id, ...snapshot, instructions, projectId })).json();
      state.historyItems = [conversation, ...state.historyItems.filter((item) => item.id !== id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      if (state.conversationId === id && (!state.archiveSnapshot || state.archiveSnapshot === snapshot)) state.historyDirty = false;
      renderHistory();
      return true;
    } catch (error) { notice(`Historique non enregistré : ${error.message} La conversation reste dans la page.`); return false; }
    finally { state.savingHistory = false; projectUI.sync(); }
  });
  return historyWrite;
}

async function clearHistory() {
  if (state.clearingHistory) return;
  const target = historyDeleteTarget;
  state.clearingHistory = true; state.loadingHistory = true;
  $('history-delete-error').hidden = true; updateControls();
  try {
    await historyWrite;
    await api(target ? 'history/delete' : 'history/clear', { confirm: true, ...(target ? { id: target.id } : {}) });
    state.historyItems = target ? state.historyItems.filter(item => item.id !== target.id) : [];
    if (!target || target.id === state.conversationId) {
      state.messages = []; state.conversationId = null; state.conversationInstructions=null; state.archiveSnapshot = null; state.historyDirty = false;
      comfyUI.reset(); generationUI.clear();$('messages').replaceChildren(); $('welcome').hidden = false;
      setConversationTitle('Nouvelle conversation');
    }
    renderHistory(); notice('');
    $('live-status').textContent = target ? 'Conversation supprimée.' : 'Historique supprimé.';
    $('history-delete-dialog').close(); historyDeleteTarget = null;
  } catch (error) { $('history-delete-error').textContent = error.message; $('history-delete-error').hidden = false; }
  finally { state.clearingHistory = false; state.loadingHistory = false; updateControls(); contextMeter.schedule(); }
}

function savedUser(message) {
  if (typeof message.content === 'string') return { text: message.content, images: [] };
  return {
    text: message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n'),
    images: message.content.filter((part) => part.type === 'image_url').map((part, index) => ({ name: `Image enregistrée ${index + 1}`, url: part.image_url.url })),
  };
}

async function loadConversation(id) {
  if(!state.projectWorking&&!state.generating&&!state.preparing&&!state.loadingHistory&&!state.status.toolJob&&id===state.conversationId){state.view='chat';closeNavigation();projectUI.render();$('prompt').focus();return;}
  if (settingsGuard.isDirty()) return settingsGuard.requestClose(() => loadConversation(id));
  if (state.projectWorking || state.status.toolJob || state.generating || state.preparing || state.loadingHistory) return;
  state.loadingHistory = true;
  updateControls();
  try {
    if (!await persistConversation()) return;
    const record = await (await api(`history/${id}`)).json();
    const messages = [...record.messages];
    const draft = record.incomplete && messages.at(-1)?.role === 'user' && !messages.at(-1).internal ? savedUser(messages.pop()) : { text: '', images: [] };
    state.conversationId = id;state.conversationInstructions=record.instructions||'';
    state.messages = messages;
    state.projectId=record.projectId||'inbox';state.view='chat';closeNavigation();
    state.archiveSnapshot = { messages: record.messages, incomplete: record.incomplete };
    state.historyDirty = false;
    state.images = draft.images;
    $('prompt').value = draft.text;
    generationUI.clear();$('messages').replaceChildren();
    renderTranscript(messages, record.incomplete);
    $('welcome').hidden = messages.length > 0;
    setConversationTitle(record.title);
    $('settings').close();
    renderAttachments();
    resizePrompt();
    state.stickToBottom = true;
    scrollToBottom();
    try { await comfyUI.renderGallery(id); } catch(error) { notice(`Galerie indisponible : ${error.message}`); }
    $('prompt').focus();
  } catch (error) { notice(error.message); }
  finally { state.loadingHistory = false; updateControls(); contextMeter.schedule(); $('prompt').focus(); }
}

function renderTranscript(messages, incomplete = false) {
    let reply=null;
    for (const [index, message] of messages.entries()) {
      if(message.internal||message.role==='tool')continue;
      if (message.role === 'user') { reply=null;const user = savedUser(message); userMessage(user.text, user.images); }
      else {
        const view = assistantMessage(reply);reply=view;
        if (message.content) renderText(view.body, message.content);
        else view.body.textContent = message.tool_calls ? 'Appel d’outil enregistré.' : 'Aucune réponse finale reçue.';
        if(message.tool_calls?.some(call=>['comfy_generate_image','comfy_generate_video'].includes(call.function?.name))){const call=message.tool_calls.find(call=>['comfy_generate_image','comfy_generate_video'].includes(call.function?.name)),result=messages[index+1];try{const data=result?.role==='tool'&&result.tool_call_id===call.id?JSON.parse(result.content):null;if(data?.run_id){if(!message.content)view.body.replaceChildren();generationUI.restore(view.generations,state.conversationId,data.run_id);}}catch{}}
        view.reasoning.hidden = !message.reasoning_content;
        view.thoughts.textContent = message.reasoning_content || '';
        if (incomplete && index === messages.length - 1) view.note.textContent = 'Réponse partielle restaurée.';
      }
    }

}

async function restoreUpdate() {
  const saved = await (await api('updates/session')).json();
  if (!saved) return;
  state.messages = saved.messages; state.conversationId = saved.conversationId;state.conversationInstructions=saved.conversationInstructions??(saved.messages.length?'':null);
  state.archiveSnapshot = saved.archiveSnapshot; state.historyDirty = false; state.images = saved.images; state.thinking = saved.thinking;
  $('prompt').value = saved.prompt; $('thinking').setAttribute('aria-pressed', String(state.thinking));
  generationUI.clear();$('messages').replaceChildren(); renderTranscript(state.messages, saved.archiveSnapshot?.incomplete);
  $('welcome').hidden = state.messages.length > 0; setConversationTitle(saved.title || 'Nouvelle conversation');
  const restored=state.historyItems.find(item=>item.id===state.conversationId);state.projectId=restored?.projectId||'inbox';state.view='chat';
  renderAttachments(); resizePrompt(); renderHistory(); scrollToBottom(); contextMeter.schedule();
  if (state.conversationId) await comfyUI.renderGallery(state.conversationId);
  await api('updates/session/clear', {});
  const result = await (await api('updates/install')).json();
  if (result.state === 'rolled-back' || result.state === 'error') notice(result.error);
  else $('live-status').textContent = 'Mise à jour installée. Conversation restaurée.';
}

async function installUpdate() {
  if (settingsGuard.isDirty()) return settingsGuard.requestClose(() => installUpdate());
  if ($('update-available').disabled) return;
  state.updating = true; updateControls(); $('settings').close();
  $('update-dialog').showModal();
  try {
    if (!await persistConversation()) throw new Error('La sauvegarde de la conversation a échoué. La mise à jour n’a pas commencé.');
    await historyWrite;
    await installFromButton({ api, token: state.token,
      session: compactSession({ messages: state.messages, archiveSnapshot: state.archiveSnapshot, conversationId: state.conversationId, conversationInstructions: state.conversationInstructions, prompt: $('prompt').value, images: state.images, thinking: state.thinking, title: $('conversation-title').textContent }),
      onProgress: text => { $('update-progress').textContent = text; },
      reload: () => { state.updateReload = true; location.reload(); },
    });
  } catch (error) {
    state.updating = false; state.updateReload = false; $('update-dialog').close();
    notice(error.message); await refreshStatus();
  }
}

function applyTheme(theme) {
  state.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = state.theme;
  const dark = state.theme === 'dark';
  const label = dark ? 'Passer en mode jour' : 'Passer en mode nuit';
  $('theme-toggle').replaceChildren(icon(dark ? 'sun' : 'moon'), node('span', '', dark ? 'Day' : 'Night'));
  $('theme-toggle').setAttribute('aria-label', label);
  $('theme-toggle').title = label;
}

async function toggleTheme() {
  await changePreferences({ theme: state.theme === 'dark' ? 'light' : 'dark' });
}

function updateControls() {
  const s = state.status;
  projectUI.sync();
  $('update-available').disabled = state.projectWorking || state.resourceWorking || state.comfyWorking || state.updating || state.generating || state.preparing || state.operation || state.settingsLoading || state.loadingHistory || state.savingHistory || state.savingPreferences || !state.connected || s.busy || !!s.toolJob || ['loading','stopping'].includes(s.state);
  const toolBusy=!!s.toolJob;
  $('comfy-recover').hidden=!s.toolJob?.blocked;
  const running = ['loading', 'ready', 'stopping'].includes(s.state);
  const text = state.connected ? labels[s.state] || 'État inconnu' : 'Connexion interrompue';
  $('settings-status').textContent = text;
  $('settings-dot').className = `dot ${state.connected ? s.state : 'error'}`;
  $('model-card').className = `model-card ${state.connected && s.state === 'ready' ? 'is-ready' : state.connected && ['loading', 'stopping'].includes(s.state) ? 'is-loading' : 'is-off'}`;
  $('model-card').setAttribute('aria-label', `Modèle : ${text}`);
  $('model-card').title = text;
  $('history-enabled').checked = state.saveHistory;
  $('history-enabled').disabled = state.savingPreferences || state.clearingHistory || toolBusy || state.generating || !state.connected;
  $('history-clear').disabled = toolBusy || !state.connected || state.generating || state.preparing || state.savingHistory || state.savingPreferences || state.loadingHistory || ['loading', 'stopping'].includes(s.state);
  $('history-delete-confirm').disabled = state.clearingHistory;
  $('history-delete-cancel').disabled = state.clearingHistory;
  $('history-delete-confirm').textContent = state.clearingHistory ? 'Suppression…' : 'Supprimer définitivement';
  $('theme-toggle').disabled = state.savingPreferences || !state.connected;
  $('config-fields').disabled = state.settingsLoading || state.settingsReady === false || state.comfyWorking || toolBusy || running || state.operation || state.generating || !state.connected;
  $('shutdown-app').disabled = state.projectWorking || state.resourceWorking || state.closingApp || state.updating || state.operation || state.generating || s.busy || toolBusy || state.savingPreferences || state.clearingHistory || state.comfyWorking || !state.connected;
  $('save-config').disabled = state.settingsReady === false || state.comfyWorking || s.busy || state.settingsLoading || toolBusy || state.operation || state.generating || !state.connected;
  $('settings-stop').hidden = !running;
  $('settings-stop').disabled = toolBusy || state.generating || s.state === 'stopping' || state.operation;
  $('toggle-engine').disabled = state.comfyWorking || toolBusy || state.generating || state.operation || s.state === 'stopping' || !state.connected;
  $('toggle-engine').classList.toggle('is-running', running);
  $('toggle-engine').replaceChildren(icon(running ? 'stop' : 'play'), node('span', '', running ? 'Arrêter le modèle' : 'Démarrer le modèle'));
  $('send').disabled = state.projectWorking || toolBusy || !state.connected || s.state === 'stopping' || s.busy || state.generating || state.preparing || state.operation || state.loadingHistory || (!$('prompt').value.trim() && !state.images.length);
  $('send').hidden = state.generating || toolBusy;
  $('cancel').hidden = !state.generating && (!toolBusy || s.toolJob.blocked);
  $('cancel').setAttribute('aria-label', state.waitingForModel ? 'Annuler le message en attente' : 'Interrompre la réponse');
  $('thinking').disabled = state.generating;
  $('attach').disabled = state.generating || state.preparing || state.loadingHistory;
  $('new-chat').disabled = state.projectWorking || toolBusy || state.generating || state.loadingHistory;
  $('new-chat-mobile').disabled = state.projectWorking || toolBusy || state.generating || state.loadingHistory;
  for (const button of document.querySelectorAll('.history-item, .history-delete-button')) {
    button.disabled = state.projectWorking || state.savingHistory || toolBusy || state.generating || state.preparing || state.loadingHistory || (button.classList.contains('history-delete-button') && $('history-clear').disabled);
    if (button.classList.contains('history-item')) button.classList.toggle('active', button.dataset.current === 'true');
  }
  $('prompt').disabled = state.loadingHistory;
  $('compose-state').textContent = toolBusy ? s.toolJob.progress || 'ComfyUI en cours…' : state.preparing ? 'Préparation des images…' : state.waitingForModel ? 'Chargement… message en attente' : state.generating ? 'Réponse en cours…' : s.state === 'loading' ? 'Le modèle se charge…' : '';
  comfyUI.setBusy(s.busy||toolBusy||state.generating||state.operation||state.settingsLoading||!state.connected);
  const logs = s.logs?.join('\n') || 'Les journaux apparaîtront au démarrage.';
  if ($('engine-logs').textContent !== logs) $('engine-logs').textContent = logs;
  if (s.error && $('config-error').hidden) {
    $('config-error').textContent = s.error;
    $('config-error').hidden = false;
  }
  assetsUI.setBusy(state.generating || s.busy || toolBusy || state.updating || state.closingApp);
  if (state.closingApp) for (const control of document.querySelectorAll('button,input,textarea,select')) control.disabled = true;
  $('model-select').disabled = toolBusy || state.generating || state.preparing || state.operation || state.settingsLoading || state.loadingHistory || state.updating || state.comfyWorking || s.busy || !state.connected || ['loading','stopping'].includes(s.state);
  $('add-llm').disabled = state.settingsLoading || state.operation || state.generating || state.comfyWorking || toolBusy || !state.connected || !state.settingsReady;
  $('global-instructions').disabled=$('add-llm').disabled;
  $('detected-model').disabled = $('add-llm').disabled || ['loading','stopping'].includes(s.state);
  $('llm-fields').disabled = $('add-llm').disabled || ['loading','stopping'].includes(s.state);
  $('save-llm').disabled = $('llm-fields').disabled;
}

async function checkUpdates() {
  try {
    const update = await (await api('updates')).json();
    const button = $('update-available');
    button.hidden = update.available !== true;
    if (update.available) {
      const label = 'Installer la mise à jour · v' + update.version;
      button.title = label; button.setAttribute('aria-label', label);
    }
  } catch { /* Offline checks stay silent. */ }
}

let statusRefreshing = false;
async function refreshStatus() {
  if (statusRefreshing || state.updating || state.closingApp) return;
  statusRefreshing = true;
  try {
    const previous = state.status.state;
    const wasConnected = state.connected;
    state.status = await (await api('status',undefined,{signal:AbortSignal.timeout(5000)})).json();
    state.connected = true;
    if (previous !== state.status.state || !wasConnected) contextMeter.schedule();
    if (state.status.state !== previous) {
      $('live-status').textContent = labels[state.status.state];
      if (state.status.state === 'error') notice(state.status.error || 'Le moteur s’est arrêté. Consultez la configuration.');
    }
  } catch {
    state.connected = false; contextMeter.schedule();
  } finally { statusRefreshing = false; }
  updateControls();
}


function renderModelSelect(){
 const select=$('model-select');select.replaceChildren();select.hidden=(state.models||[]).length<2;
 const active=(state.models||[]).find(item=>item.modelPath===state.config.modelPath&&item.projectorPath===(state.config.projectorPath||''));
 if(!active){const option=node('option','','Modèle actuel');option.value='';select.append(option);}
 for(const item of state.models||[]){const option=node('option','',item.name);option.value=item.id;option.title=item.modelPath;select.append(option);}
 select.value=active?.id||'';
}
function modelDraft(){return {id:state.modelEditId||'',adding:!!state.modelAdding,selection:$('detected-model').value,name:$('llm-name').value,modelPath:$('model-path').value,projectorPath:$('projector-path').value};}
function modelEditorDirty(){return state.modelDraftBaseline!==undefined&&JSON.stringify(modelDraft())!==state.modelDraftBaseline;}
function loadModelDraft(item,{adding=false}={}){
 state.modelAdding=adding;state.modelEditId=!adding&&state.models.some(saved=>saved.id===item?.id)?item.id:'';
 $('llm-name').value=item?.name||'';$('model-path').value=item?.modelPath||'';$('projector-path').value=item?.projectorPath||'';
 $('llm-error').hidden=true;state.modelDraftBaseline=JSON.stringify(modelDraft());
}
function activeModel(){return (state.models||[]).find(item=>item.modelPath===state.config.modelPath&&item.projectorPath===(state.config.projectorPath||''));}
function applyModelLibrary(library){
 state.models=library.models||[];state.detectedModels=[...state.models,...(library.detected||[]).filter(item=>!state.models.some(saved=>saved.id===item.id))];renderModelSelect();
 const current=activeModel()||{id:'current',name:state.modelName||state.config.modelPath?.split(/[\\/]/).slice(-2,-1)[0]||'',modelPath:state.config.modelPath||'',projectorPath:state.config.projectorPath||''};
 if(current.modelPath&&!state.detectedModels.some(item=>item.modelPath===current.modelPath&&item.projectorPath===current.projectorPath))state.detectedModels.unshift(current);
 const select=$('detected-model');select.replaceChildren();
 if(!state.detectedModels.length){const manual=node('option','','Chemins manuels ci-dessous');manual.value='';select.append(manual);}
 for(const item of state.detectedModels){const option=node('option','',item.name);option.value=item.id;select.append(option);}
 const selected=state.detectedModels.find(item=>item.modelPath===current.modelPath&&item.projectorPath===current.projectorPath)||state.detectedModels[0];
 select.value=selected?.id||'';loadModelDraft(selected);$('model-paths').open=false;
 $('models-status').textContent=(library.errors||[]).map(item=>item.name+' : '+item.error).join('\n');$('models-status').hidden=!$('models-status').textContent;
}
function chooseDetectedModel(){
 const item=state.detectedModels.find(item=>item.id===$('detected-model').value);if(!item)return;
 const previous=JSON.parse(state.modelDraftBaseline||'{}');
 const edited=['name','modelPath','projectorPath'].some(key=>modelDraft()[key]!==previous[key]);
 if(edited&&!confirm('Abandonner les modifications de ce LLM ?')){$('detected-model').value=previous.selection||'';return;}
 loadModelDraft(item);settingsSearch.refresh();
}
function addLLM(){
 if($('add-llm').disabled)return;
 if(modelEditorDirty()&&!confirm('Abandonner les modifications de ce LLM ?'))return;
 settingsSearch.reset();$('detected-model').value='';loadModelDraft(null,{adding:true});$('model-paths').open=true;$('llm-name').focus();
}
function cancelLLM(){
 if(modelEditorDirty()&&!confirm('Abandonner les modifications de ce LLM ?'))return;
 const current=activeModel()||state.detectedModels.find(item=>item.modelPath===state.config.modelPath&&item.projectorPath===(state.config.projectorPath||''));
 $('detected-model').value=current?.id||state.detectedModels[0]?.id||'';loadModelDraft(current||state.detectedModels[0]);$('model-paths').open=false;
}
async function saveLLM({withinSettingsSave=false}={}){
 if(!withinSettingsSave&&($('save-llm').disabled||state.operation))return false;
 const session=state.settingsSession,draft=modelDraft();
 if(!draft.name.trim()){ $('model-paths').open=true;$('llm-error').textContent='Indiquez un nom.';$('llm-error').hidden=false;$('llm-name').focus();return false;}
 if(!withinSettingsSave){state.operation=true;updateControls();}
 $('llm-error').hidden=true;
 try{
  const result=await(await api('models/add',{...(draft.id?{id:draft.id}:{}),name:draft.name,modelPath:draft.modelPath,projectorPath:draft.projectorPath})).json();state.models=result.models;renderModelSelect();
  if(session===state.settingsSession&&$('settings').open)state.modelEditId=result.profile.id;
  const selected=await(await api('models/select',{id:result.profile.id})).json();state.config=selected.config;state.modelName=selected.modelName;state.status=selected.status;
  if(selected.warning||selected.status?.state==='error')throw Error(selected.warning||selected.status.error||'Le modèle n’a pas démarré.');
  if(session===state.settingsSession&&$('settings').open){
   state.detectedModels=[result.profile,...state.detectedModels.filter(item=>item.id!==draft.id&&item.id!==result.profile.id)];
   const select=$('detected-model');select.replaceChildren();for(const item of state.detectedModels){const option=node('option','',item.name);option.value=item.id;select.append(option);}select.value=result.profile.id;
   loadModelDraft(result.profile);settingsGuard.markPartSaved('llm');$('model-paths').open=false;$('models-status').hidden=true;
  }
  renderModelSelect();contextMeter.schedule();return true;
 }catch(error){if(session===state.settingsSession&&$('settings').open){$('model-paths').open=true;$('llm-error').textContent=error.message;$('llm-error').hidden=false;}return false;}
 finally{if(!withinSettingsSave){state.operation=false;await refreshStatus();}}
}
async function switchLLM(){
 const id=$('model-select').value;if(!id||$('model-select').disabled)return;
 if(settingsGuard.isDirty()){renderModelSelect();return settingsGuard.requestClose(()=>{ $('model-select').value=id;void switchLLM();});}
 state.operation=true;updateControls();
 try{const result=await(await api('models/select',{id})).json();state.config=result.config;state.modelName=result.modelName;state.status=result.status;notice(result.warning||'');contextMeter.schedule();}
 catch(error){notice(error.message);}
 finally{state.operation=false;renderModelSelect();await refreshStatus();}
}

function openSettings() {
  if ($('settings').open) return;
  filePickerController?.abort();comfyUI.cancelSettings();
  const session = state.settingsSession = (state.settingsSession || 0) + 1;
  state.settingsLoading = true; state.settingsReady = false;
  $('config-error').hidden = true;settingsSearch.reset();
  $('settings').showModal();$('settings').scrollTop=0; updateControls();
  Promise.all([api('bootstrap').then(response => response.json()), comfyUI.refresh(), api('models').then(response=>response.json())]).then(([initial,,library]) => {
    if (session !== state.settingsSession || !$('settings').open) return;
    state.config = initial.config; state.modelName=initial.modelName||'';state.globalInstructions=initial.instructions||'';$('global-instructions').value=state.globalInstructions;applyModelLibrary(library);
    if (initial.preferences && !state.savingPreferences) {
      const historyChanged = state.saveHistory !== initial.preferences.saveHistory;
      state.saveHistory = initial.preferences.saveHistory; applyTheme(initial.preferences.theme);
      if (historyChanged) void refreshHistory().catch(error => notice(error.message));
    }
    $('engine-path').value = state.config.enginePath || '';
    tokenControls.setValues(state.config); computeControls.setValues(state.config);
    state.settingsReady = true; settingsGuard.markSaved();settingsSearch.refresh();
  }).catch(error => {
    if (session !== state.settingsSession || !$('settings').open) return;
    $('config-error').textContent = error.message; $('config-error').hidden = false;
  }).finally(() => {
    if (session === state.settingsSession) { state.settingsLoading = false; updateControls(); }
  });
}

async function saveConfiguration() {
  if (state.operation || state.settingsLoading || state.comfyWorking || !state.settingsReady || !$('settings').open) return;
  const session = state.settingsSession;
  if (comfyUI.hasPendingImport?.()) {
    if (!await comfyUI.finishImport?.()) return;
    if (session !== state.settingsSession || !$('settings').open) return;
  }
  state.operation = true;
  $('config-error').hidden = true;
  updateControls();
  try {
    const selectionChanged=$('model-path').value!==(state.config.modelPath||'')||$('projector-path').value!==(state.config.projectorPath||'');
    if((state.modelAdding||modelEditorDirty()||selectionChanged)&&!await saveLLM({withinSettingsSave:true}))return false;
    const config = {
      enginePath: $('engine-path').value, modelPath: state.config.modelPath,
      projectorPath: state.config.projectorPath, ...tokenControls.values(),
      ...computeControls.values(),
    };
    const saved=await(await api('settings',{config,instructions:$('global-instructions').value,comfy:comfyUI.values(),workflowDescriptions:comfyUI.workflowDescriptions()})).json();
    state.config=saved.config;state.comfy=saved.comfy;state.globalInstructions=saved.instructions??$('global-instructions').value;state.modelName=activeModel()?.name||'';renderModelSelect();
    const current = session === state.settingsSession && $('settings').open;
    if (current) { comfyUI.saved(saved); settingsGuard.markSaved(); $('settings').close(); }
    contextMeter.schedule(); return current;
  } catch (error) {
    if (session === state.settingsSession && $('settings').open) { $('config-error').textContent = error.message; $('config-error').hidden = false; }
  } finally {
    state.operation = false;
    await refreshStatus();
  }
}

async function shutdownApplication() {
  if ($('shutdown-app').disabled) return;
  if (settingsGuard.isDirty()) return settingsGuard.requestClose(() => shutdownApplication());
  const controls = [...document.querySelectorAll('button,input,textarea,select')].map(control => [control, control.disabled]);
  state.closingApp = true; updateControls();
  try {
    if (!await persistConversation()) throw Error('La conversation n’a pas été sauvegardée. L’application reste ouverte.');
    await historyWrite;
    await api('shutdown', {}); state.connected = false; $('settings').close();
    notice('Application arrêtée. Vous pouvez fermer cet onglet.');
  } catch (error) {
    state.closingApp = false;
    for (const [control, disabled] of controls) control.disabled = disabled;
    notice(error.message);
  }
  finally { updateControls(); }
}

async function toggleEngine(stopOnly = false) {
  if (state.operation) return;
  const running = ['loading', 'ready', 'stopping'].includes(state.status.state);
  if (!running && !stopOnly && (!state.config.enginePath || !state.config.modelPath)) return openSettings();
  state.operation = true;
  updateControls();
  try {
    state.status = await (await api(running || stopOnly ? 'stop' : 'start', {})).json();
    if (running) $('config-error').hidden = true;
    notice('');
  } catch (error) { notice(error.message); }
  finally { state.operation = false; await refreshStatus(); }
}

function resizePrompt() {
  $('prompt').style.height = 'auto';
  $('prompt').style.height = `${Math.min($('prompt').scrollHeight, 180)}px`;
  updateControls();
}

function renderAttachments() {
  $('attachments').replaceChildren();
  state.images.forEach((image, index) => {
    const box = node('div', 'attachment');
    const preview = node('img');
    preview.src = image.url;
    preview.alt = image.name;
    const remove = node('button');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Retirer ${image.name}`);
    remove.append(icon('close'));
    remove.onclick = () => { state.images.splice(index, 1); renderAttachments(); updateControls(); };
    box.append(preview, remove);
    $('attachments').append(box);
  });
}

async function addImages(files) {
  if (state.projectWorking || state.status.toolJob || state.generating || state.preparing || state.loadingHistory) return;
  if (!state.config.projectorPath) {
    notice('Ajoutez un projecteur de vision dans Configuration pour joindre des images.');
    return openSettings();
  }
  if (files.length + state.images.length > 64) return notice('Vous pouvez joindre 64 images au maximum par message.');
  state.preparing = true;
  updateControls();
  try {
    state.images = await prepareImages([...state.images, ...files]);
    notice('');
  } catch (error) { notice(error.message || 'Cette image ne peut pas être lue.'); }
  finally { state.preparing = false; renderAttachments(); updateControls(); }
}

function scrollToBottom() {
  if (state.stickToBottom) $('chat-area').scrollTop = $('chat-area').scrollHeight;
}

function renderText(target, text) {
  target.classList.add('markdown');
  target.innerHTML = markdownToHtml(text);
}

function userMessage(text, images) {
  const article = node('article', 'message user');
  article.setAttribute('aria-label', 'Votre message');
  if (images.length) {
    const previews = node('div', 'message-images');
    for (const image of images) {
      const img = node('img'); img.src = image.url; img.alt = image.name;
      previews.append(img);
    }
    article.append(previews);
  }
  if (text) article.append(node('div', 'message-body', text));
  $('messages').append(article);
  return article;
}

function assistantMessage(parent=null) {
  const article = parent?.article || node('article', 'message assistant');
  article.setAttribute('aria-label', 'Réponse du modèle');
  if(!parent){
    const header = node('div', 'message-header');
    const avatar = node('span', 'message-avatar'); avatar.append(icon('spark'));
    header.append(avatar, node('span', '', 'Atelier'));article.append(header);
  }
  const reasoning = node('details', 'reasoning');
  reasoning.hidden = true;
  const summary = node('summary', '', 'Réflexion du modèle');
  const thoughts = node('div', 'reasoning-content');
  reasoning.append(summary, thoughts);
  const body = node('div', 'message-body');
  body.append(node('span', 'pending-dot', '●'));
  const note = node('div', 'message-note');
  const generations=parent?.generations || node('div','generation-grid');
  article.append(reasoning, body, note);
  if(!parent){article.append(generations);$('messages').append(article);}
  return { article, reasoning, summary, thoughts, body, note, generations };
}

function userContent(text, images) {
  return images.length ? [{type:'text',text:text||'Décris les images.'},...images.map(image=>({type:'image_url',image_url:{url:image.url}}))] : text;
}

function archiveMessages(messages) { return messages.filter(message=>!message.resourceId); }

function chatRequest(messages, tools = true, resources = true) {
  const context=state.conversationInstructions??(state.messages.length?'':state.globalInstructions||'');
  const instructions=context?'\n\nContexte fourni par l’utilisateur au démarrage de cette conversation :\n'+context:'';
  return {messages:[{role:'system',content:'Tu es un assistant local utile. Réponds dans la langue de l’utilisateur. Décris honnêtement les images et signale tes incertitudes.'+instructions},...messages],thinking:state.thinking,tools,resources};
}

async function sendMessage(event) {
  event.preventDefault();
  if ($('send').disabled || state.generating) return;
  if (!state.config.enginePath || !state.config.modelPath) { notice('Renseignez les chemins du moteur et du modèle dans Configuration avant le premier envoi.'); return openSettings(); }
  state.preparing=true;updateControls();
  try{if(!await assetsUI.flush()){notice('La description de ressource n’a pas été enregistrée. Réessayez avant l’envoi.');return;}}finally{state.preparing=false;updateControls();}
  const text=$('prompt').value.trim(), images=[...state.images];
  const content=userContent(text,images);
  const history=[...state.messages,{role:'user',content}],userView=userMessage(text,images);
  state.conversationInstructions??=state.messages.length?'':state.globalInstructions||'';
  state.conversationId ||= crypto.randomUUID();const turnId=crypto.randomUUID();
  state.archiveSnapshot={messages:[...archiveMessages(history)],incomplete:true};
  let view=assistantMessage(),output='',reasoning='',finishReason='',complete=false,lastRender=0,lastArchive=0,usedTool=false;
  state.generating=true;
  $('welcome').hidden=true;$('prompt').value='';state.images=[];renderAttachments();
  state.waitingForModel=true;state.controller=new AbortController();state.stickToBottom=true;
  const signal=state.controller.signal;contextMeter.pause();resizePrompt();notice('');scrollToBottom();
  function snapshot(){return {messages:[...archiveMessages(history),...(output||reasoning?[{role:'assistant',content:output,...(reasoning?{reasoning_content:reasoning}:{})}]:[])],incomplete:true};}
  function render(){
    view.reasoning.hidden=!reasoning;view.thoughts.textContent=reasoning;
    if(output)renderText(view.body,output);else if(reasoning)view.body.replaceChildren(node('span','pending-dot','Réflexion en cours…'));
    scrollToBottom();lastRender=performance.now();state.archiveSnapshot=snapshot();
    if((output||reasoning)&&performance.now()-lastArchive>2000&&!state.savingHistory){lastArchive=performance.now();persistConversation();}
  }
  const started=performance.now();
  try{
    view.body.replaceChildren(node('span','pending-message','Démarrage du modèle… Votre message est en attente.'));
    if(!await persistConversation())throw Error('Impossible de sauvegarder ce message. Vérifiez le dossier history ou désactivez l’historique.');
    await waitForModel(api,signal,status=>{state.status=status;updateControls();});
    state.waitingForModel=false;updateControls();
    let allowTools=true,iterations=0,resourceReads=0,reviewRecord=null;
    while(true){
      signal.throwIfAborted();let request=null;
      view.body.replaceChildren(node('span','pending-dot','●'));
      const response=await api('chat',{...chatRequest(history,allowTools,resourceReads<8),conversationId:state.conversationId,turnId},{signal});
      await readSSE(response.body,chunk=>{
        contextMeter.observe(chunk);
        if(chunk.local_tool_request)request=chunk.local_tool_request;
        const choice=chunk.choices?.[0],delta=choice?.delta||{};
        output+=delta.content||'';reasoning+=delta.reasoning_content||'';if(choice?.finish_reason)finishReason=choice.finish_reason;
        if(performance.now()-lastRender>55)render();
      });
      render();
      if(reviewRecord&&request?.kind!=='resource'&&output.trim()&&finishReason!=='length'){
        try{await comfyUI.saveReview(reviewRecord,output,request?'correction_requested':'reviewed');}catch(error){notice(`Analyse de galerie non enregistrée : ${error.message}`);}
      }
      if(!request){complete=true;view.note.textContent=finishReason==='length'?'Limite de sortie atteinte.':`${((performance.now()-started)/1000).toFixed(1)} s`;break;}
      await historyWrite;
      usedTool=true;
      history.push({role:'assistant',content:output,...(reasoning?{reasoning_content:reasoning}:{}),tool_calls:[request.call]});
      if(!output)view.body.replaceChildren();
      output='';reasoning='';
      if(request.kind==='resource'){
        const ids=request.resourceIds||[request.resourceId];resourceReads+=ids.length;view.body.replaceChildren(node('span','pending-message','Ressource · '+request.workflowName));
        view.note.textContent='Consultation des références…';
        try{
          const response=await(await api('resources/read',request.resourceIds?{ids}:{id:request.resourceId},{signal})).json(),selected=response.resources||[response];
          const metadata=selected.map(resource=>({id:resource.id,label:resource.label,name:resource.name,description:resource.description,type:resource.mime,width:resource.width,height:resource.height,duration:resource.duration,frameTimes:resource.frames.map(frame=>frame.time)}));
          history.push({role:'tool',tool_call_id:request.call.id,content:JSON.stringify({status:'loaded',resources:metadata,note:'Pixels disponibles uniquement dans ce tour. Relire les ressources pour une comparaison visuelle ultérieure.'})});
          for(const [index,resource]of selected.entries())if(!history.some(message=>message.resourceId===resource.id))history.push({role:'user',internal:true,resourceId:resource.id,content:[{type:'text',text:'Référence visuelle '+JSON.stringify(metadata[index])+'. Les images suivantes appartiennent uniquement à cette référence. Copies temporaires pour ce tour ; pour une vidéo, images représentatives sans audio.'},...resource.frames.map(frame=>({type:'image_url',image_url:{url:frame.url}}))]});
          view.note.textContent='Références consultées · '+selected.map(resource=>resource.label||resource.name).join(', ');
        }catch(error){history.push({role:'tool',tool_call_id:request.call.id,content:JSON.stringify({status:'error',message:error.message})});resourceReads=8;if(signal.aborted)throw error;view.note.textContent=error.message;}
        state.archiveSnapshot={messages:[...archiveMessages(history)],incomplete:true};await persistConversation();
        view=assistantMessage(view);finishReason='';continue;
      }
      iterations++;
      view.generation=true;const generation=generationUI.mount(view.generations,request);
      let result;
      try{result=await comfyUI.requestTool(request,signal,progress=>{generation.progress(progress);scrollToBottom();},image=>generation.image(image));generation.finish(result);}
      catch(error){generation.fail(error.message);history.push({role:'tool',tool_call_id:request.call.id,content:JSON.stringify({status:'error',message:signal.aborted?'Génération annulée.':error.message})});throw error;}
      history.push({role:'tool',tool_call_id:request.call.id,content:result.content});
      if(result.record||result.failed)state.status=await(await api('status')).json();
      const reviewImages=state.status.state==='ready'&&state.status.vision?result.images:[];
      reviewRecord=reviewImages.length?result.record:null;
      if(result.record){
        history.push({role:'user',internal:true,content:[{type:'text',text:reviewImages.length?(result.record.mediaType==='video'?'Vidéo : les images suivantes sont seulement des échantillons compressés horodatés (voir frame_times du résultat), sans audio. Elles ne prouvent pas la fluidité, le raccord temporel ni la dernière image exacte. Ne prétends pas avoir visionné toute la vidéo. Toute nouvelle génération nécessite sa propre confirmation utilisateur. ':'')+'Voici les copies réduites des sorties du workflow, dans le même ordre. Les originaux affichés à l’utilisateur ne font pas partie de ce contexte. Vérifie les indications reference_count, reference_capacity et reference_mode du résultat : elles décrivent les références réellement transmises à Comfy. reference_count décrit les références réellement fournies par Atelier ; reference_defaults décrit les entrées conservées du workflow. Zéro référence fournie ne prouve pas que le workflow est textuel. Respecte analysis_outputs pour associer les copies aux sorties ; ne prétends pas avoir vu une sortie sans copie. Pour comparer aux ressources pertinentes, consulte leurs images avec local_read_resource si elles ne sont pas présentes dans ce tour ; les descriptions seules ne suffisent pas. Décris les écarts de sujet, de composition, de couleurs et de détails, ainsi que les limites observées. Ne conclus pas à la fidélité ou à une fusion sans comparaison visuelle. Si une correction est utile et possible avec les entrées configurées, adapte ton prompt.':state.status.vision?'La génération est terminée, mais les copies pour l’analyse sont indisponibles. Signale que tu ne peux pas vérifier visuellement le résultat.': 'La génération est terminée. Tu ne disposes pas de la vision : indique que tu ne peux pas vérifier visuellement le résultat.'},...reviewImages.map(url=>({type:'image_url',image_url:{url}}))]});
      }
      if(result.failed&&state.status.state!=='ready')throw Error(result.error||'L’image est disponible dans la galerie, mais le modèle n’a pas redémarré.');
      view.note.textContent=result.failed?(result.error||'Analyse indisponible.') : '';
      if(result.denied||result.failed||iterations>=(state.comfy?.maxIterations||5))allowTools=false;
      state.archiveSnapshot={messages:[...archiveMessages(history)],incomplete:true};await persistConversation();
      view=assistantMessage(view);finishReason='';
    }
  }catch(error){
    const canceled=signal.aborted;
    if(output||reasoning||usedTool){render();view.note.textContent=canceled?'Opération interrompue à votre demande.':error.message;if(!canceled)view.note.classList.add('error');}
    else{userView.remove();view.article.remove();$('prompt').value=text+($('prompt').value?`\n\n${$('prompt').value}`:'');state.images=images;renderAttachments();$('welcome').hidden=state.messages.length>0;}
    if(!canceled)notice(error.message||'La connexion a été interrompue.');
  }finally{
    if(output||reasoning||usedTool){
      if(output||reasoning){render();if(!output)view.body.replaceChildren(node('div','text-block','Aucune réponse finale reçue.'));history.push({role:'assistant',content:output,...(reasoning?{reasoning_content:reasoning}:{})});}
      else if(usedTool&&!view.generation)view.body.replaceChildren(node('div','text-block',complete?'Aucune réponse finale reçue.':'Opération interrompue.'));
      state.messages=archiveMessages(history);state.archiveSnapshot={messages:[...archiveMessages(history)],incomplete:!complete};setConversationTitle(text||'Une image à explorer');
    }
    await persistConversation();state.generating=false;state.waitingForModel=false;state.controller=null;resizePrompt();await refreshStatus();contextMeter.schedule();$('prompt').focus();
  }
}


function alignConversation() {
  if (typeof ResizeObserver !== 'function') return;
  const area = $('chat-area');
  const sync = () => document.documentElement.style.setProperty('--chat-scrollbar', Math.max(0, area.offsetWidth - area.clientWidth) + 'px');
  new ResizeObserver(sync).observe(area);
  sync();
}

alignConversation();
setupMaterialLighting(document.querySelectorAll('.composer, .model-card'));
const tokenControls=setupTokenControls($);
const computeControls=setupComputeControls($);
const settingsSearch=setupSettingsSearch({dialog:$('settings'),input:$('settings-search'),empty:$('settings-empty')});
dismissSettingsOnOutsideClick($('settings'), () => settingsGuard.requestClose());
const projectUI=setupProjectNavigation({$,state,node,icon,api,notice,openConversation:id=>{settingsGuard.requestClose(()=>loadConversation(id));},newConversation:id=>{settingsGuard.requestClose(()=>newConversation(id));},removeConversation:confirmHistoryDeletion,showHome,onBusy:()=>updateControls()});
const assetsUI=setupAssets({api,state,node,icon,notice,onChange:()=>contextMeter.schedule(),onBusy:()=>updateControls()});
const generationUI=setupGenerationUI({api,node,openOutput:(record,index,blob)=>assetsUI.viewOutput(record,index,blob),onResize:scrollToBottom});
const comfyUI=setupComfy({api,state,node,notice,openOutput:(record,index)=>assetsUI.viewOutput(record,index),onOutput:()=>{openFiles();assetsUI.show('output');},onChange:()=>refreshStatus(),onSettingsBusyChange:busy=>{state.comfyWorking=busy;updateControls();}});

const settingsGuard=setupSettingsGuard({
  dialog:$('settings'), confirmation:$('settings-unsaved'), keep:$('settings-keep'), discard:$('settings-discard'), saveButton:$('settings-save-close'), save:saveConfiguration,
  readDraft:()=>({llm:modelDraft(),fields:['global-instructions','engine-path','context-size','output-tokens','compute-mode','gpu-layers','comfy-enabled','comfy-auto','comfy-url','comfy-iterations'].map(id=>[id,id==='comfy-iterations'&&$('comfy-unlimited').getAttribute('aria-pressed')==='true'?null:$(id).value,$(id).checked]), unlimited:$('comfy-unlimited').getAttribute('aria-pressed'), descriptions:comfyUI.workflowDescriptions(), pending:comfyUI.hasPendingImport?.()||false}),
});
const contextMeter=setupContextMeter({$,api,getConfig:()=>state.config,isReady:()=>state.connected&&state.status.state==='ready',isBusy:()=>state.generating||!!state.status.toolJob,
  getRequest:()=>state.messages.length?chatRequest(state.messages):null, getConversation:()=>state.conversationId,
});
setupCopy($('messages'),{announce:message=>{$('live-status').textContent=message;if(message.startsWith('Copie indisponible'))notice(message);}});
applyTheme(document.documentElement.dataset.theme);
$('theme-toggle').onclick = toggleTheme;
$('history-clear').onclick = () => confirmHistoryDeletion();
$('history-delete-cancel').onclick = () => $('history-delete-dialog').close();
$('history-delete-confirm').onclick = clearHistory;
$('history-delete-dialog').addEventListener('cancel', (event) => { if (state.clearingHistory) event.preventDefault(); });
$('history-enabled').onchange = async () => {
  const enabled = $('history-enabled').checked;
  if (await changePreferences({ saveHistory: enabled }) && enabled) {
    await persistConversation();
    if(state.conversationId){
      state.loadingHistory=true;updateControls();
      try{await api('gallery/persist',{conversationId:state.conversationId});}catch(error){notice(`Galerie non enregistrée : ${error.message}`);}
      finally{state.loadingHistory=false;updateControls();}
    }
  }
};
let filePickerController = null;
$('settings').addEventListener('close', () => {
  if ($('settings').open) return;
  state.settingsSession = (state.settingsSession || 0) + 1;
  state.settingsLoading = false; state.settingsReady = false;settingsSearch.reset();
  filePickerController?.abort(); comfyUI.cancelSettings(); updateControls();
});
for(const button of document.querySelectorAll('[data-file-kind]'))button.onclick=async()=>{
  if (state.operation || button.disabled || !$('settings').open) return;
  const kind=button.dataset.fileKind,id=kind==='engine'?'engine-path':kind==='model'?'model-path':'projector-path';
  const controller = new AbortController(); filePickerController = controller;
  state.operation=true; $('config-error').hidden=true; updateControls();
  try {
    const result=await(await api('files/choose',{kind,initialPath:$(id).value},{signal:controller.signal})).json();
    if (!controller.signal.aborted && $('settings').open && result.path) $(id).value=result.path;
  } catch(error) {
    if (!controller.signal.aborted && $('settings').open) { $('config-error').textContent=error.message; $('config-error').hidden=false; }
  } finally {
    if (filePickerController === controller) { filePickerController=null; state.operation=false; updateControls(); }
  }
};
$('settings-open').onclick = openSettings;
$('detected-model').onchange=chooseDetectedModel;
$('add-llm').onclick=addLLM;
$('save-llm').onclick=()=>saveLLM();
$('cancel-llm').onclick=cancelLLM;
$('model-select').onchange=switchLLM;
$('update-available').onclick = installUpdate;
$('update-dialog').addEventListener('cancel', event => event.preventDefault());
$('shutdown-app').onclick = shutdownApplication;
$('settings-close').onclick = () => settingsGuard.requestClose();
$('settings-form').onsubmit = (event) => { event.preventDefault(); saveConfiguration(); };
$('toggle-engine').onclick = () => toggleEngine();
$('settings-stop').onclick = () => toggleEngine(true);
$('notice-close').onclick = () => notice('');
$('prompt').oninput = resizePrompt;
$('prompt').onkeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('chat-form').requestSubmit(); }
};
$('chat-form').onsubmit = sendMessage;
$('cancel').onclick = () => { if(state.controller)state.controller.abort(); else api('tools/cancel',{jobId:state.status.toolJob?.id}).catch(error=>notice(error.message)); };
$('thinking').onclick = () => { state.thinking = !state.thinking; $('thinking').setAttribute('aria-pressed', String(state.thinking)); contextMeter.schedule(); };
function closeNavigation(){document.body.dataset.navOpen='false';$('navigation-open').setAttribute('aria-expanded','false');}
function openFiles(open=true){if(!open)assetsUI.pause();document.body.dataset.files=open?'open':'closed';$('all-files').setAttribute('aria-pressed',String(open));}
function showHome(){
  const blocked=()=>state.projectWorking||state.status.toolJob||state.status.busy||state.generating||state.preparing||state.loadingHistory||state.savingPreferences||state.operation||state.updating||state.closingApp;
  if(blocked())return;
  settingsGuard.requestClose(async()=>{
    if(blocked())return;
    state.loadingHistory=true;updateControls();
    try{if(!await assetsUI.flush()||!await persistConversation())return;state.view='home';closeNavigation();projectUI.render();}
    catch(error){notice(error.message);}
    finally{state.loadingHistory=false;updateControls();}
  });
}
async function newConversation(projectId=state.projectId||'inbox') {
  if (state.projectWorking || state.status.toolJob || state.generating || state.preparing || state.loadingHistory) return;
  state.loadingHistory = true;
  updateControls();
  try {
    if (!await persistConversation()) return;
    if (!state.saveHistory && state.messages.length && !confirm('Recommencer effacera cette conversation de la page. Continuer ?')) return;
    state.projectId=typeof projectId==='string'?projectId:'inbox';state.view='chat';
    closeNavigation();
    state.messages = []; state.images = []; state.conversationId = null; state.conversationInstructions=null; state.archiveSnapshot = null; state.historyDirty = false;
    $('prompt').value = '';
    comfyUI.reset();
    generationUI.clear();$('messages').replaceChildren(); $('welcome').hidden = false;
    setConversationTitle('Nouvelle conversation');
    renderAttachments(); notice(''); resizePrompt();
  } finally { state.loadingHistory = false; updateControls(); contextMeter.schedule(); $('prompt').focus(); }
}
$('new-chat').onclick = ()=>newConversation();
$('new-chat-mobile').onclick = ()=>newConversation();
$('all-files').onclick=()=>openFiles(document.body.dataset.files!=='open');
$('assets-close').onclick=()=>openFiles(false);
$('navigation-open').onclick=()=>{const open=document.body.dataset.navOpen!=='true';document.body.dataset.navOpen=String(open);$('navigation-open').setAttribute('aria-expanded',String(open));};
document.querySelectorAll('[data-prompt]').forEach((button) => {
  button.onclick = () => { $('prompt').value = button.dataset.prompt; resizePrompt(); $('prompt').focus(); };
});
function chooseImage() {
  if (!state.config.projectorPath) { notice('Ajoutez un projecteur de vision dans Configuration pour joindre des images.'); openSettings(); }
  else $('image-input').click();
}
$('attach').onclick = chooseImage;
$('suggest-image').onclick = chooseImage;
$('image-input').onchange = (event) => { const files = [...event.target.files]; event.target.value = ''; addImages(files); };
$('prompt').onpaste = (event) => {
  const files = [...event.clipboardData.files];
  if (files.length) { event.preventDefault(); addImages(files); }
};
$('chat-form').ondragover = (event) => { event.preventDefault(); $('chat-form').classList.add('dragging'); };
$('chat-form').ondragleave = (event) => { if (!$('chat-form').contains(event.relatedTarget)) $('chat-form').classList.remove('dragging'); };
$('chat-form').ondrop = (event) => { event.preventDefault(); $('chat-form').classList.remove('dragging'); addImages([...event.dataTransfer.files]); };
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => event.preventDefault());
$('chat-area').onscroll = () => { const area = $('chat-area'); state.stickToBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 100; };
window.addEventListener('beforeunload', (event) => {
  if (state.updateReload) return;
  if (assetsUI.hasDraft() || state.resourceWorking || settingsGuard.isDirty() || state.generating || state.savingHistory || state.historyDirty || $('prompt').value.trim() || state.images.length || (!state.saveHistory && state.messages.length)) { event.preventDefault(); event.returnValue = ''; }
});

try {
  const response = await fetch('/api/bootstrap');
  if (!response.ok) throw new Error('Impossible de joindre le serveur local.');
  const initial = await response.json();
  Object.assign(state, { token: initial.token, config: initial.config, globalInstructions:initial.instructions||'', models: initial.models||[], modelName: initial.modelName||'', status: initial.status, connected: true });
  renderModelSelect();
  void checkUpdates();
  applyTheme(initial.preferences?.theme);
  state.saveHistory = initial.preferences?.saveHistory === true;
  await projectUI.refresh().catch(error=>notice('Projets indisponibles : '+error.message));
  await refreshHistory();
  await assetsUI.refresh().catch(error=>notice('Bibliothèque indisponible : '+error.message));
  await comfyUI.refresh();
  await restoreUpdate();
  if (initial.warning) notice(initial.warning);
  contextMeter.schedule();
  updateControls();
} catch (error) { notice(error.message); updateControls(); }
setInterval(() => { if (!document.hidden) refreshStatus(); }, 1200);
document.addEventListener('visibilitychange', () => { document.documentElement.dataset.pageHidden=String(document.hidden); if (!document.hidden) refreshStatus(); });
