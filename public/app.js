import { readSSE } from './stream.mjs';
import { markdownToHtml } from './markdown.mjs';
import { setupComfy } from './comfy-ui.mjs';
import { prepareImages } from './images.mjs';
import { waitForModel } from './model-ready.mjs';

const $ = (id) => document.getElementById(id);
const state = {
  token: '', config: {}, status: { state: 'stopped', vision: false, busy: false, logs: [] },
  connected: false, thinking: true, messages: [], images: [], generating: false,
  preparing: false, operation: false, controller: null, stickToBottom: true, theme: 'dark', savingPreferences: false, waitingForModel: false,
  saveHistory: false, conversationId: null, historyItems: [], archiveSnapshot: null, savingHistory: false, historyDirty: false, loadingHistory: false, clearingHistory: false,
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
  const response = await fetch(`/api/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...options,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || `La requête a échoué (${response.status}).`), { status: response.status });
  }
  return response;
}

let historyWrite = Promise.resolve();

function renderHistory() {
  $('history-section').hidden = !state.saveHistory;
  $('history-mobile').hidden = !state.saveHistory;
  $('session-note').textContent = state.saveHistory ? 'Conversations sauvegardées sur cet ordinateur.' : 'Conversation conservée pendant cette session uniquement.';
  for (const id of ['history-list', 'history-list-mobile']) {
    const list = $(id);
    list.replaceChildren();
    if (!state.historyItems.length) list.append(node('p', 'history-empty', 'Aucune conversation enregistrée.'));
    for (const item of state.historyItems) {
      const button = node('button', `history-item${item.id === state.conversationId ? ' active' : ''}`);
      button.type = 'button';
      button.dataset.conversationId = item.id;
      button.disabled = !!state.status.toolJob || state.generating || state.preparing || state.loadingHistory;
      button.append(node('span', '', item.title), node('small', '', `${new Date(item.updatedAt).toLocaleDateString('fr-FR')}${item.incomplete ? ' · en cours / partielle' : ''}`));
      button.onclick = () => loadConversation(item.id);
      list.append(button);
    }
  }
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
  try {
    const { preferences } = await (await api('preferences', patch)).json();
    state.saveHistory = preferences.saveHistory;
    applyTheme(preferences.theme);
    await refreshHistory();
    return true;
  } catch (error) { notice(error.message); return false; }
  finally { state.savingPreferences = false; updateControls(); }
}

function persistConversation() {
  const snapshot = state.archiveSnapshot || { messages: state.messages, incomplete: false };
  if (!state.saveHistory || !snapshot.messages.length) return Promise.resolve(true);
  const id = state.conversationId ||= crypto.randomUUID();
  state.historyDirty = true;
  historyWrite = historyWrite.then(async () => {
    if (!state.saveHistory) return true;
    state.savingHistory = true;
    try {
      const { conversation } = await (await api('history/save', { id, ...snapshot })).json();
      state.historyItems = [conversation, ...state.historyItems.filter((item) => item.id !== id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      if (state.conversationId === id && (!state.archiveSnapshot || state.archiveSnapshot === snapshot)) state.historyDirty = false;
      renderHistory();
      return true;
    } catch (error) { notice(`Historique non enregistré : ${error.message} La conversation reste dans la page.`); return false; }
    finally { state.savingHistory = false; }
  });
  return historyWrite;
}

async function clearHistory() {
  if ($('history-clear').disabled) return;
  state.clearingHistory = true;
  state.loadingHistory = true;
  $('history-delete-error').hidden = true;
  updateControls();
  try {
    await historyWrite;
    await api('history/clear', { confirm: true });
    state.historyItems = []; state.messages = []; state.conversationId = null; state.archiveSnapshot = null; state.historyDirty = false;
    comfyUI.reset();
    $('messages').replaceChildren(); $('welcome').hidden = false;
    $('conversation-title').textContent = 'Nouvelle conversation';
    renderHistory(); notice('');
    $('live-status').textContent = 'Historique supprimé.';
    $('history-delete-dialog').close();
  } catch (error) { $('history-delete-error').textContent = error.message; $('history-delete-error').hidden = false; }
  finally { state.clearingHistory = false; state.loadingHistory = false; updateControls(); }
}

function savedUser(message) {
  if (typeof message.content === 'string') return { text: message.content, images: [] };
  return {
    text: message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n'),
    images: message.content.filter((part) => part.type === 'image_url').map((part, index) => ({ name: `Image enregistrée ${index + 1}`, url: part.image_url.url })),
  };
}

async function loadConversation(id) {
  if (state.status.toolJob || state.generating || state.preparing || state.loadingHistory) return;
  state.loadingHistory = true;
  updateControls();
  try {
    if (!await persistConversation()) return;
    const record = await (await api(`history/${id}`)).json();
    const messages = [...record.messages];
    const draft = record.incomplete && messages.at(-1)?.role === 'user' && !messages.at(-1).internal ? savedUser(messages.pop()) : { text: '', images: [] };
    state.conversationId = id;
    state.messages = messages;
    state.archiveSnapshot = { messages: record.messages, incomplete: record.incomplete };
    state.historyDirty = false;
    state.images = draft.images;
    $('prompt').value = draft.text;
    $('messages').replaceChildren();
    for (const [index, message] of messages.entries()) {
      if(message.internal||message.role==='tool')continue;
      if (message.role === 'user') { const user = savedUser(message); userMessage(user.text, user.images); }
      else {
        const view = assistantMessage();
        if (message.content) renderText(view.body, message.content);
        else view.body.textContent = message.tool_calls ? 'Appel ComfyUI enregistré.' : 'Aucune réponse finale reçue.';
        view.reasoning.hidden = !message.reasoning_content;
        view.thoughts.textContent = message.reasoning_content || '';
        if (record.incomplete && index === messages.length - 1) view.note.textContent = 'Réponse partielle restaurée.';
      }
    }
    $('welcome').hidden = messages.length > 0;
    $('conversation-title').textContent = record.title;
    $('settings').close();
    renderAttachments();
    resizePrompt();
    state.stickToBottom = true;
    scrollToBottom();
    try { await comfyUI.renderGallery(id); } catch(error) { notice(`Galerie indisponible : ${error.message}`); }
    $('prompt').focus();
  } catch (error) { notice(error.message); }
  finally { state.loadingHistory = false; updateControls(); $('prompt').focus(); }
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
  $('config-fields').disabled = toolBusy || running || state.operation || state.generating || !state.connected;
  $('save-config').disabled = toolBusy || running || state.operation || state.generating || !state.connected;
  $('save-start').disabled = toolBusy || running || state.operation || state.generating || !state.connected;
  $('settings-stop').hidden = !running;
  $('settings-stop').disabled = toolBusy || state.generating || s.state === 'stopping' || state.operation;
  $('toggle-engine').disabled = toolBusy || state.generating || state.operation || s.state === 'stopping' || !state.connected;
  $('toggle-engine').classList.toggle('is-running', running);
  $('toggle-engine').replaceChildren(icon(running ? 'stop' : 'play'), node('span', '', running ? 'Arrêter le modèle' : 'Démarrer le modèle'));
  $('send').disabled = toolBusy || !state.connected || s.state === 'stopping' || s.busy || state.generating || state.preparing || state.operation || state.loadingHistory || (!$('prompt').value.trim() && !state.images.length);
  $('send').hidden = state.generating || toolBusy;
  $('cancel').hidden = !state.generating && (!toolBusy || s.toolJob.blocked);
  $('cancel').setAttribute('aria-label', state.waitingForModel ? 'Annuler le message en attente' : 'Interrompre la réponse');
  $('thinking').disabled = state.generating;
  $('attach').disabled = state.generating || state.preparing || state.loadingHistory;
  $('new-chat').disabled = toolBusy || state.generating || state.loadingHistory;
  $('new-chat-mobile').disabled = toolBusy || state.generating || state.loadingHistory;
  for (const button of document.querySelectorAll('.history-item')) {
    button.disabled = toolBusy || state.generating || state.preparing || state.loadingHistory;
    button.classList.toggle('active', button.dataset.conversationId === state.conversationId);
  }
  $('prompt').disabled = state.loadingHistory;
  $('compose-state').textContent = toolBusy ? s.toolJob.progress || 'ComfyUI en cours…' : state.preparing ? 'Préparation des images…' : state.waitingForModel ? 'Chargement… message en attente' : state.generating ? 'Réponse en cours…' : s.state === 'ready' ? s.vision ? 'Texte + images' : 'Texte uniquement' : s.state === 'loading' ? 'Le modèle se charge…' : '';
  for(const id of ['comfy-enabled','comfy-url','comfy-auto','comfy-iterations','comfy-save','comfy-test','workflow-file','workflow-import'])$(id).disabled=toolBusy||state.generating;
  $('engine-logs').textContent = s.logs?.join('\n') || 'Les journaux apparaîtront au démarrage.';
  if (s.error) {
    $('config-error').textContent = s.error;
    $('config-error').hidden = false;
  }
  const basename = state.config.modelPath?.split(/[\\/]/).pop() || '';
  if (basename) {
    $('sidebar-model').textContent = /DeepSeek.*Qwen3\.5/i.test(basename) ? 'DeepSeek × Qwen3.5' : basename.replace(/\.gguf$/i, '');
    $('sidebar-model').title = basename;
    const quant = basename.match(/(?:\.|-)(Q\d[^.]*|IQ\d[^.]*)(?:\.gguf)?$/i)?.[1] || 'GGUF';
    $('sidebar-model-detail').textContent = `${quant} · ${state.config.projectorPath ? 'projecteur configuré' : 'texte uniquement'}`;
  }
}

async function refreshStatus() {
  try {
    const previous = state.status.state;
    state.status = await (await api('status')).json();
    state.connected = true;
    if (state.status.state !== previous) {
      $('live-status').textContent = labels[state.status.state];
      if (state.status.state === 'error') notice(state.status.error || 'Le moteur s’est arrêté. Consultez la configuration.');
    }
  } catch {
    state.connected = false;
  }
  updateControls();
}

function syncOutputOptions() {
  const context = Number($('context-size').value);
  for (const option of $('output-tokens').options) option.disabled = Number(option.value) > context;
  if (Number($('output-tokens').value) > context) $('output-tokens').value = [...$('output-tokens').options].filter((option) => !option.disabled).at(-1).value;
}

function openSettings() {
  $('engine-path').value = state.config.enginePath || '';
  $('model-path').value = state.config.modelPath || '';
  $('projector-path').value = state.config.projectorPath || '';
  const size = String(state.config.contextSize || 8192);
  if (![...$('context-size').options].some((option) => option.value === size)) $('context-size').add(new Option(`${size} tokens`, size));
  $('context-size').value = size;
  const output = String(state.config.maxOutputTokens || 4096);
  if (![...$('output-tokens').options].some((option) => option.value === output)) $('output-tokens').add(new Option(`${output} tokens`, output));
  $('output-tokens').value = output;
  syncOutputOptions();
  const layers = state.config.gpuLayers ?? 99;
  $('compute-mode').value = [0, 99].includes(layers) ? String(layers) : 'custom';
  $('gpu-layers').value = String(layers);
  $('custom-layers-field').hidden = $('compute-mode').value !== 'custom';
  $('config-error').hidden = !state.status.error;
  comfyUI.refresh().catch(error=>notice(error.message));
  if (!$('settings').open) $('settings').showModal();
  updateControls();
}

async function saveConfiguration(start) {
  state.operation = true;
  $('config-error').hidden = true;
  updateControls();
  try {
    const config = {
      enginePath: $('engine-path').value, modelPath: $('model-path').value,
      projectorPath: $('projector-path').value, contextSize: Number($('context-size').value), maxOutputTokens: Number($('output-tokens').value),
      gpuLayers: Number($('compute-mode').value === 'custom' ? $('gpu-layers').value : $('compute-mode').value),
    };
    state.config = (await (await api('config', config)).json()).config;
    if (start) state.status = await (await api('start', {})).json();
    else $('settings').close();
  } catch (error) {
    $('config-error').textContent = error.message;
    $('config-error').hidden = false;
  } finally {
    state.operation = false;
    await refreshStatus();
  }
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
  if (state.status.toolJob || state.generating || state.preparing || state.loadingHistory) return;
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

function assistantMessage() {
  const article = node('article', 'message assistant');
  article.setAttribute('aria-label', 'Réponse du modèle');
  const header = node('div', 'message-header');
  const avatar = node('span', 'message-avatar'); avatar.append(icon('spark'));
  header.append(avatar, node('span', '', 'Atelier'));
  const reasoning = node('details', 'reasoning');
  reasoning.hidden = true;
  const summary = node('summary', '', 'Réflexion du modèle');
  const thoughts = node('div', 'reasoning-content');
  reasoning.append(summary, thoughts);
  const body = node('div', 'message-body');
  body.append(node('span', 'pending-dot', '●'));
  const note = node('div', 'message-note');
  article.append(header, reasoning, body, note);
  $('messages').append(article);
  return { article, reasoning, summary, thoughts, body, note };
}

async function sendMessage(event) {
  event.preventDefault();
  if ($('send').disabled || state.generating) return;
  if (!state.config.enginePath || !state.config.modelPath) { notice('Renseignez les chemins du moteur et du modèle dans Configuration avant le premier envoi.'); return openSettings(); }
  const text=$('prompt').value.trim(), images=[...state.images];
  const content=images.length?[{type:'text',text:text||'Décris les images.'},...images.map(image=>({type:'image_url',image_url:{url:image.url}}))]:text;
  const history=[...state.messages,{role:'user',content}],userView=userMessage(text,images);
  state.conversationId ||= crypto.randomUUID();const turnId=crypto.randomUUID();
  state.archiveSnapshot={messages:[...history],incomplete:true};
  let view=assistantMessage(),output='',reasoning='',finishReason='',complete=false,lastRender=0,lastArchive=0,usedTool=false;
  $('welcome').hidden=true;$('prompt').value='';state.images=[];renderAttachments();
  state.generating=true;state.waitingForModel=true;state.controller=new AbortController();state.stickToBottom=true;
  const signal=state.controller.signal;resizePrompt();notice('');scrollToBottom();
  function snapshot(){return {messages:[...history,...(output||reasoning?[{role:'assistant',content:output,...(reasoning?{reasoning_content:reasoning}:{})}]:[])],incomplete:true};}
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
    let allowTools=true,iterations=0,reviewRecord=null;
    while(true){
      signal.throwIfAborted();let request=null;
      view.body.replaceChildren(node('span','pending-dot','●'));
      const response=await api('chat',{messages:[{role:'system',content:'Tu es un assistant local utile. Réponds dans la langue de l’utilisateur. Décris honnêtement les images et signale tes incertitudes.'},...history],thinking:state.thinking,tools:allowTools,conversationId:state.conversationId,turnId},{signal});
      await readSSE(response.body,chunk=>{
        if(chunk.local_tool_request)request=chunk.local_tool_request;
        const choice=chunk.choices?.[0],delta=choice?.delta||{};
        output+=delta.content||'';reasoning+=delta.reasoning_content||'';if(choice?.finish_reason)finishReason=choice.finish_reason;
        if(performance.now()-lastRender>55)render();
      });
      render();
      if(reviewRecord){
        try{await comfyUI.saveReview(reviewRecord,output,request?'correction_requested':'reviewed');}catch(error){notice(`Analyse de galerie non enregistrée : ${error.message}`);}
      }
      if(!request){complete=true;view.note.textContent=finishReason==='length'?'Limite de sortie atteinte.':`${((performance.now()-started)/1000).toFixed(1)} s`;break;}
      await historyWrite;
      usedTool=true;iterations++;
      history.push({role:'assistant',content:output,...(reasoning?{reasoning_content:reasoning}:{}),tool_calls:[request.call]});
      output='';reasoning='';
      view.body.replaceChildren(node('span','pending-message',`Outil · ${request.workflowName}`));
      let result;
      try{result=await comfyUI.requestTool(request,signal,progress=>{view.note.textContent=progress;scrollToBottom();});}
      catch(error){history.push({role:'tool',tool_call_id:request.call.id,content:JSON.stringify({status:'error',message:signal.aborted?'Génération annulée.':error.message})});throw error;}
      history.push({role:'tool',tool_call_id:request.call.id,content:result.content});
      reviewRecord=result.record||null;
      if(result.record)state.status=await(await api('status')).json();
      const reviewImages=state.status.vision?result.images:[];
      if(result.record){
        history.push({role:'user',internal:true,content:[{type:'text',text:reviewImages.length?'Voici les sorties du workflow, dans le même ordre. Compare-les à la demande initiale et aux références. Explique les écarts. Si une correction est utile et autorisée, adapte ton prompt.': 'La génération est terminée. Tu ne disposes pas de la vision : indique que tu ne peux pas vérifier visuellement le résultat.'},...reviewImages.map(url=>({type:'image_url',image_url:{url}}))]});
      }
      view.note.textContent=result.denied?'Génération refusée.':result.failed?'La génération a échoué.':'Sortie disponible dans la galerie.';
      if(result.denied||result.failed||iterations>=(state.comfy?.maxIterations||3))allowTools=false;
      state.archiveSnapshot={messages:[...history],incomplete:true};await persistConversation();
      view=assistantMessage();finishReason='';
    }
  }catch(error){
    const canceled=signal.aborted;
    if(output||reasoning||usedTool){render();view.note.textContent=canceled?'Opération interrompue à votre demande.':error.message;if(!canceled)view.note.classList.add('error');}
    else{userView.remove();view.article.remove();$('prompt').value=text+($('prompt').value?`\n\n${$('prompt').value}`:'');state.images=images;renderAttachments();$('welcome').hidden=state.messages.length>0;}
    if(!canceled)notice(error.message||'La connexion a été interrompue.');
  }finally{
    if(output||reasoning||usedTool){
      if(output||reasoning){render();if(!output)view.body.replaceChildren(node('div','text-block','Aucune réponse finale reçue.'));history.push({role:'assistant',content:output,...(reasoning?{reasoning_content:reasoning}:{})});}
      else if(usedTool)view.body.replaceChildren(node('div','text-block',complete?'Aucune réponse finale reçue.':'Opération interrompue.'));
      state.messages=history;state.archiveSnapshot={messages:[...history],incomplete:!complete};$('conversation-title').textContent=text||'Une image à explorer';
    }
    await persistConversation();state.generating=false;state.waitingForModel=false;state.controller=null;resizePrompt();await refreshStatus();$('prompt').focus();
  }
}


const comfyUI=setupComfy({api,state,node,notice,onChange:()=>refreshStatus()});
applyTheme(document.documentElement.dataset.theme);
$('theme-toggle').onclick = toggleTheme;
$('history-clear').onclick = () => { $('history-delete-error').hidden = true; if (!$('history-delete-dialog').open) $('history-delete-dialog').showModal(); };
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
$('settings-open').onclick = openSettings;
$('settings-close').onclick = () => $('settings').close();
$('settings-form').onsubmit = (event) => { event.preventDefault(); saveConfiguration(false); };
$('save-start').onclick = () => saveConfiguration(true);
$('context-size').onchange = syncOutputOptions;
$('compute-mode').onchange = () => { $('custom-layers-field').hidden = $('compute-mode').value !== 'custom'; };
$('toggle-engine').onclick = () => toggleEngine();
$('settings-stop').onclick = () => toggleEngine(true);
$('notice-close').onclick = () => notice('');
$('prompt').oninput = resizePrompt;
$('prompt').onkeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('chat-form').requestSubmit(); }
};
$('chat-form').onsubmit = sendMessage;
$('cancel').onclick = () => { if(state.controller)state.controller.abort(); else api('tools/cancel',{}).catch(error=>notice(error.message)); };
$('thinking').onclick = () => { state.thinking = !state.thinking; $('thinking').setAttribute('aria-pressed', String(state.thinking)); };
async function newConversation() {
  if (state.status.toolJob || state.generating || state.preparing || state.loadingHistory) return;
  state.loadingHistory = true;
  updateControls();
  try {
    if (!await persistConversation()) return;
    if (!state.saveHistory && state.messages.length && !confirm('Recommencer effacera cette conversation de la page. Continuer ?')) return;
    state.messages = []; state.images = []; state.conversationId = null; state.archiveSnapshot = null; state.historyDirty = false;
    $('prompt').value = '';
    comfyUI.reset();
    $('messages').replaceChildren(); $('welcome').hidden = false;
    $('conversation-title').textContent = 'Nouvelle conversation';
    renderAttachments(); notice(''); resizePrompt();
  } finally { state.loadingHistory = false; updateControls(); $('prompt').focus(); }
}
$('new-chat').onclick = newConversation;
$('new-chat-mobile').onclick = newConversation;
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
  if (state.generating || state.savingHistory || state.historyDirty || $('prompt').value.trim() || state.images.length || (!state.saveHistory && state.messages.length)) { event.preventDefault(); event.returnValue = ''; }
});

try {
  const response = await fetch('/api/bootstrap');
  if (!response.ok) throw new Error('Impossible de joindre le serveur local.');
  const initial = await response.json();
  Object.assign(state, { token: initial.token, config: initial.config, status: initial.status, connected: true });
  applyTheme(initial.preferences?.theme);
  state.saveHistory = initial.preferences?.saveHistory === true;
  await refreshHistory();
  await comfyUI.refresh();
  if (initial.platform !== 'win32') $('engine-path').placeholder = '/chemin/vers/llama-server';
  if (initial.warning) notice(initial.warning);
  updateControls();
} catch (error) { notice(error.message); updateControls(); }
setInterval(() => { if (!document.hidden) refreshStatus(); }, 1200);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus(); });
