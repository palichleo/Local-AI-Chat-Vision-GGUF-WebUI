import { setupProjectNavigation } from './project-navigation.mjs';
import { setupSettingsSearch } from './settings-search.mjs';
import { setupSettingsTabs } from './settings-tabs.mjs';
import { setupHelpTips } from './help-tips.mjs';
import { setupGenerationUI } from './generation-ui.mjs';
import { setupAssets } from './assets-ui.mjs';
import { setupCopy } from './copy.mjs';
import { callNote, lastExchange, spokenText } from './transcript.mjs';
import { setupSettingsGuard } from './settings-guard.mjs';
import { setupContextMeter } from './context-meter.mjs';
import { installFromButton, compactSession } from './update-ui.mjs';
import { setupMaterialLighting } from './material-light.mjs';
import { readSSE } from './stream.mjs';
import { markdownToHtml } from './markdown.mjs';
import { setupNativeWorkflows } from './native-workflow-ui.mjs';
import { prepareImages } from './images.mjs';
import { isVideo, splitVideos, withVideos } from './chat-videos.mjs';
import { setupStudio } from './studio.mjs';
import { setupTokenControls, setupComputeControls, dismissSettingsOnOutsideClick } from './settings-controls.mjs';
import { waitForModel } from './model-ready.mjs';
import { outputActions } from './output-actions.mjs';
import { fillCopies, forgetCopies, needsCopies, rememberCopy, remakeOutputCopy, withoutCopies } from './session-copies.mjs';

const $ = id => document.getElementById(id);
const state = {
  view: 'home',
  studioId: null,
  projectId: 'inbox',
  projects: [{ id: 'inbox', name: 'Conversations' }],
  projectWorking: false,
  token: '',
  config: {},
  globalInstructions: '',
  conversationInstructions: null,
  models: [],
  detectedModels: [],
  modelName: '',
  status: { state: 'stopped', vision: false, busy: false, logs: [] },
  connected: false,
  thinking: true,
  messages: [],
  images: [],
  // Videos joined to the message being written: library resources ({ id, label, name }).
  videos: [],
  generating: false,
  preparing: false,
  operation: false,
  controller: null,
  stickToBottom: true,
  theme: 'dark',
  savingPreferences: false,
  waitingForModel: false,
  settingsLoading: false,
  settingsSession: 0,
  settingsReady: false,
  generationSettingsWorking: false,
  disablingHistory: false,
  resourceWorking: false,
  saveHistory: true,
  conversationId: null,
  historyItems: [],
  archiveSnapshot: null,
  savingHistory: false,
  historyDirty: false,
  loadingHistory: false,
  clearingHistory: false,
  // The Studio's controls, once set up: the message box asks it whether a proposal waits there.
  studio: null,
  // The end of the turn in progress: a message sent over a proposal of the Studio waits for it.
  turnEnded: Promise.resolve(),
};
const labels = {
  stopped: 'Moteur arrêté',
  loading: 'Chargement du modèle…',
  ready: 'Prêt à discuter',
  stopping: 'Arrêt en cours…',
  error: 'Vérifier le moteur',
};

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

// The page learns its token from its first request, which takes up to several seconds while the
// model loads. Everything is already on screen: an action clicked meanwhile waits for the token
// instead of being refused (« Accès refusé. Recharge la page. »).
let tokenKnown;
const pageReady = new Promise(resolve => {
  tokenKnown = resolve;
});
async function api(route, body, options = {}) {
  await pageReady;
  const { raw = false, headers: extraHeaders = {}, ...requestOptions } = options;
  const response = await fetch(`/api/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${state.token}`,
      'Content-Type': raw ? 'application/octet-stream' : 'application/json',
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
    ...requestOptions,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || `La requête a échoué (${response.status}).`), {
      status: response.status,
    });
  }
  return response;
}

let historyWrite = Promise.resolve();
let historyDeleteTarget = null;
function confirmHistoryDeletion(item = null) {
  historyDeleteTarget = item;
  $('history-delete-title').textContent = item ? 'Supprimer cette conversation ?' : 'Supprimer l’historique ?';
  $('history-delete-description').textContent = item
    ? '« ' +
      item.title +
      ' » sera supprimée avec ses copies compressées et ses liens de sortie. Les fichiers originaux restent à leur emplacement. Le brouillon de saisie sera conservé.'
    : 'Les conversations, les copies compressées et les liens vers les sorties seront supprimés. Les fichiers originaux restent à leur emplacement. L’échange affiché sera fermé ; le brouillon de saisie sera conservé.';
  $('history-delete-error').hidden = true;
  if (!$('history-delete-dialog').open) $('history-delete-dialog').showModal();
}

function renderHistory() {
  projectUI.render();
}

function setConversationTitle(title) {
  $('conversation-title').textContent = title;
  $('chat-heading').textContent = title;
  renderHistory();
}

async function refreshHistory() {
  if (!state.saveHistory) {
    state.historyItems = [];
    renderHistory();
    return;
  }
  const result = await (await api('history')).json();
  state.historyItems = result.conversations;
  renderHistory();
  if (result.skipped)
    notice(`${result.skipped} conversation(s) illisible(s) ignorée(s). Les fichiers restent sur disque.`);
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
  } catch (error) {
    notice(error.message);
    return false;
  } finally {
    state.savingPreferences = false;
    state.disablingHistory = false;
    updateControls();
  }
}

function persistConversation() {
  const snapshot = state.archiveSnapshot || { messages: state.messages, incomplete: false };
  if (!state.saveHistory || state.disablingHistory || !snapshot.messages.length) return Promise.resolve(true);
  const projectId = state.projectId || 'inbox';
  const id = (state.conversationId ||= crypto.randomUUID());
  const instructions = state.conversationInstructions || '';
  state.historyDirty = true;
  historyWrite = historyWrite.then(async () => {
    if (!state.saveHistory) return true;
    state.savingHistory = true;
    try {
      const { conversation } = await (
        await api('history/save', {
          id,
          ...snapshot,
          messages: withoutCopies(snapshot.messages),
          instructions,
          projectId,
        })
      ).json();
      state.historyItems = [conversation, ...state.historyItems.filter(item => item.id !== id)].sort(
        (a, b) => (b.createdAt || b.updatedAt).localeCompare(a.createdAt || a.updatedAt) || a.id.localeCompare(b.id),
      );
      if (state.conversationId === id && (!state.archiveSnapshot || state.archiveSnapshot === snapshot))
        state.historyDirty = false;
      renderHistory();
      return true;
    } catch (error) {
      notice(`Historique non enregistré : ${error.message} La conversation reste dans la page.`);
      return false;
    } finally {
      state.savingHistory = false;
      projectUI.sync();
    }
  });
  return historyWrite;
}

async function clearHistory() {
  if (state.clearingHistory) return;
  const target = historyDeleteTarget;
  state.clearingHistory = true;
  state.loadingHistory = true;
  $('history-delete-error').hidden = true;
  updateControls();
  try {
    await historyWrite;
    await api(target ? 'history/delete' : 'history/clear', { confirm: true, ...(target ? { id: target.id } : {}) });
    forgetCopies(target?.id ?? null);
    state.historyItems = target ? state.historyItems.filter(item => item.id !== target.id) : [];
    if (!target || target.id === state.conversationId) {
      state.messages = [];
      state.conversationId = null;
      state.conversationInstructions = null;
      state.archiveSnapshot = null;
      state.historyDirty = false;
      void showCreations();
      generationUI.clear();
      $('messages').replaceChildren();
      $('welcome').hidden = false;
      setConversationTitle('Nouvelle conversation');
      state.studio?.conversationChanged?.();
    }
    renderHistory();
    notice('');
    $('live-status').textContent = target ? 'Conversation supprimée.' : 'Historique supprimé.';
    $('history-delete-dialog').close();
    historyDeleteTarget = null;
  } catch (error) {
    $('history-delete-error').textContent = error.message;
    $('history-delete-error').hidden = false;
  } finally {
    state.clearingHistory = false;
    state.loadingHistory = false;
    updateControls();
    contextMeter.schedule();
  }
}

function savedUser(message) {
  if (typeof message.content === 'string') return { ...splitVideos(message.content), images: [] };
  return {
    ...splitVideos(
      message.content
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('\n'),
    ),
    images: message.content
      .filter(part => part.type === 'image_url')
      .map((part, index) => ({
        name: `Image enregistrée ${index + 1}`,
        ...(part.image_url?.url ? { url: part.image_url.url } : {}),
        ...(part.file ? { file: part.file, view: part.view } : {}),
      })),
  };
}

async function loadConversation(id) {
  if (
    !state.projectWorking &&
    !state.generating &&
    !state.preparing &&
    !state.loadingHistory &&
    !state.status.toolJob &&
    id === state.conversationId
  ) {
    if (state.view !== 'studio') state.view = 'chat';
    closeNavigation();
    projectUI.render();
    $('prompt').focus();
    return;
  }
  if (settingsGuard.isDirty()) return requestSettingsClose(() => loadConversation(id));
  if (state.projectWorking || state.status.toolJob || state.generating || state.preparing || state.loadingHistory)
    return;
  state.loadingHistory = true;
  updateControls();
  try {
    // A conversation that cannot be saved must not trap the user in it.
    if (
      !(await persistConversation()) &&
      !confirm('Cette conversation n’a pas pu être enregistrée. Ouvrir l’autre conversation quand même ?')
    )
      return;
    const record = await (await api(`history/${id}`)).json();
    const messages = [...record.messages];
    const draft =
      record.incomplete && messages.at(-1)?.role === 'user' && !messages.at(-1).internal
        ? savedUser(messages.pop())
        : { text: '', images: [], videos: [] };
    state.conversationId = id;
    state.conversationInstructions = record.instructions || '';
    state.messages = messages;
    state.projectId = record.projectId || 'inbox';
    // Chat and Studio are two views of the same conversation: the one on screen stays.
    if (state.view !== 'studio') state.view = 'chat';
    closeNavigation();
    state.archiveSnapshot = { messages: record.messages, incomplete: record.incomplete };
    state.historyDirty = false;
    state.images = draft.images;
    state.videos = draft.videos;
    $('prompt').value = draft.text;
    generationUI.clear();
    $('messages').replaceChildren();
    renderTranscript(messages, record.incomplete);
    turnActions();
    $('welcome').hidden = messages.length > 0;
    setConversationTitle(record.title);
    $('settings').close();
    renderAttachments();
    resizePrompt();
    state.stickToBottom = true;
    scrollToBottom();
    state.studio?.conversationChanged?.();
    try {
      await workflowsUI.renderGallery(id);
    } catch (error) {
      notice(`Galerie indisponible : ${error.message}`);
    }
    $('prompt').focus();
  } catch (error) {
    notice(error.message);
  } finally {
    state.loadingHistory = false;
    updateControls();
    contextMeter.schedule();
    $('prompt').focus();
  }
}

function renderTranscript(messages, incomplete = false) {
  // Every tool other than the local readers is a generation verb, including names used by older versions.
  const isGeneration = call => Boolean(call.function?.name) && !call.function.name.startsWith('local_');
  let reply = null;
  for (const [index, message] of messages.entries()) {
    if (message.internal || message.role === 'tool') continue;
    if (message.role === 'user') {
      reply = null;
      const user = savedUser(message);
      userMessage(user.text, user.images, user.videos);
    } else {
      const view = assistantMessage(reply);
      reply = view;
      // A call the model wrote as text is not shown, as while a reply arrives; a call that left
      // no media is told in a line of its own words, not the result kept for the model.
      const text = spokenText(message.content);
      if (text) renderText(view.body, text);
      else if (message.tool_calls?.length) {
        const told = callNote(message.tool_calls[0], messages[index + 1]);
        view.body.replaceChildren(...(told ? [node('div', 'message-step', told)] : []));
      } else
        view.body.textContent = message.content
          ? 'Le modèle a écrit un appel d’outil au lieu de le lancer : rien n’a été généré.'
          : 'Aucune réponse finale reçue.';
      if (message.tool_calls?.some(isGeneration)) {
        const call = message.tool_calls.find(isGeneration),
          result = messages[index + 1];
        try {
          const data = result?.role === 'tool' && result.tool_call_id === call.id ? JSON.parse(result.content) : null;
          if (data?.run_id) {
            if (!text) view.body.replaceChildren();
            generationUI.restore(view.generations, state.conversationId, data.run_id, { compact: data.studio === true });
          }
        } catch {}
      }
      view.reasoning.hidden = !message.reasoning_content;
      view.thoughts.textContent = message.reasoning_content || '';
      if (incomplete && index === messages.length - 1) view.note.textContent = 'Réponse partielle restaurée.';
    }
  }
}

async function restoreUpdate() {
  const saved = await (await api('updates/session')).json();
  if (!saved) return;
  state.messages = saved.messages;
  state.conversationId = saved.conversationId;
  state.conversationInstructions = saved.conversationInstructions ?? (saved.messages.length ? '' : null);
  state.archiveSnapshot = saved.archiveSnapshot;
  state.historyDirty = false;
  state.images = saved.images;
  state.thinking = saved.thinking;
  $('prompt').value = saved.prompt;
  $('thinking').setAttribute('aria-pressed', String(state.thinking));
  generationUI.clear();
  $('messages').replaceChildren();
  renderTranscript(state.messages, saved.archiveSnapshot?.incomplete);
  turnActions();
  $('welcome').hidden = state.messages.length > 0;
  setConversationTitle(saved.title || 'Nouvelle conversation');
  const restored = state.historyItems.find(item => item.id === state.conversationId);
  state.projectId = restored?.projectId || 'inbox';
  state.view = 'chat';
  renderAttachments();
  resizePrompt();
  renderHistory();
  scrollToBottom();
  contextMeter.schedule();
  if (state.conversationId) await workflowsUI.renderGallery(state.conversationId);
  await api('updates/session/clear', {});
  if (saved.restarted) {
    $('live-status').textContent = 'Application redémarrée. Conversation restaurée.';
    return;
  }
  const result = await (await api('updates/install')).json();
  if (result.state === 'rolled-back' || result.state === 'error') notice(result.error);
  else $('live-status').textContent = 'Mise à jour installée. Conversation restaurée.';
}

async function installUpdate() {
  if (settingsGuard.isDirty()) return requestSettingsClose(() => installUpdate());
  if ($('settings-update-install').disabled) return;
  state.updating = true;
  updateControls();
  $('settings').close();
  $('update-dialog').showModal();
  try {
    if (!(await persistConversation()))
      throw new Error('La sauvegarde de la conversation a échoué. La mise à jour n’a pas commencé.');
    await historyWrite;
    await installFromButton({
      api,
      token: state.token,
      session: compactSession({
        messages: state.messages,
        archiveSnapshot: state.archiveSnapshot,
        conversationId: state.conversationId,
        conversationInstructions: state.conversationInstructions,
        prompt: $('prompt').value,
        images: state.images,
        thinking: state.thinking,
        title: $('conversation-title').textContent,
      }),
      onProgress: text => {
        $('update-progress').textContent = text;
      },
      reload: () => {
        state.updateReload = true;
        location.reload();
      },
    });
  } catch (error) {
    state.updating = false;
    state.updateReload = false;
    $('update-dialog').close();
    notice(error.message);
    await refreshStatus();
  }
}

function applyTheme(theme) {
  state.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = state.theme;
  const dark = state.theme === 'dark';
  const label = dark ? 'Passer en mode jour' : 'Passer en mode nuit';
  $('theme-toggle').replaceChildren(icon(dark ? 'sun' : 'moon'), node('span', '', dark ? 'Jour' : 'Nuit'));
  $('theme-toggle').setAttribute('aria-label', label);
  $('theme-toggle').title = label;
}

async function toggleTheme() {
  await changePreferences({ theme: state.theme === 'dark' ? 'light' : 'dark' });
}

function updateControls() {
  const s = state.status;
  projectUI.sync();
  $('settings-update-check').disabled = state.updating || !!state.checkingUpdates;
  $('settings-update-install').disabled =
    state.projectWorking ||
    state.resourceWorking ||
    state.generationSettingsWorking ||
    state.updating ||
    state.generating ||
    state.preparing ||
    state.operation ||
    state.settingsLoading ||
    state.loadingHistory ||
    state.savingHistory ||
    state.savingPreferences ||
    !state.connected ||
    s.busy ||
    !!s.toolJob ||
    ['loading', 'stopping'].includes(s.state);
  const toolBusy = !!s.toolJob;
  $('generation-recover').hidden = !s.toolJob?.blocked;
  const running = ['loading', 'ready', 'stopping'].includes(s.state);
  const text = state.connected ? labels[s.state] || 'État inconnu' : 'Connexion interrompue';
  $('settings-status').textContent = text;
  $('settings-dot').className = `dot ${state.connected ? s.state : 'error'}`;
  $('history-enabled').checked = state.saveHistory;
  $('history-enabled').disabled =
    state.savingPreferences || state.clearingHistory || toolBusy || state.generating || !state.connected;
  $('history-clear').disabled =
    toolBusy ||
    !state.connected ||
    state.generating ||
    state.preparing ||
    state.savingHistory ||
    state.savingPreferences ||
    state.loadingHistory ||
    ['loading', 'stopping'].includes(s.state);
  $('history-delete-confirm').disabled = state.clearingHistory;
  $('history-delete-cancel').disabled = state.clearingHistory;
  $('history-delete-confirm').textContent = state.clearingHistory ? 'Suppression…' : 'Supprimer définitivement';
  $('theme-toggle').disabled = state.savingPreferences || !state.connected;
  $('config-fields').disabled =
    state.settingsLoading ||
    state.settingsReady === false ||
    state.generationSettingsWorking ||
    toolBusy ||
    running ||
    state.operation ||
    state.generating ||
    !state.connected;
  $('shutdown-app').disabled =
    state.projectWorking ||
    state.resourceWorking ||
    state.closingApp ||
    state.updating ||
    state.operation ||
    state.generating ||
    s.busy ||
    toolBusy ||
    state.savingPreferences ||
    state.clearingHistory ||
    state.generationSettingsWorking ||
    !state.connected;
  $('restart-app').disabled = $('shutdown-app').disabled;
  $('save-config').disabled =
    state.settingsReady === false ||
    state.generationSettingsWorking ||
    s.busy ||
    state.settingsLoading ||
    toolBusy ||
    state.operation ||
    state.generating ||
    !state.connected;
  $('settings-stop').hidden = !running;
  $('settings-stop').disabled = toolBusy || state.generating || s.state === 'stopping' || state.operation;
  $('toggle-engine').disabled =
    state.generationSettingsWorking ||
    toolBusy ||
    state.generating ||
    state.operation ||
    s.state === 'stopping' ||
    !state.connected;
  // Green play when stopped, red stop while it runs; during a generation the model is set
  // aside to free the GPU: a stop square in amber, reloaded by itself afterwards.
  const paused = toolBusy && !running,
    engineLabel = paused
      ? 'Modèle en pause pendant la génération · il redémarre ensuite'
      : running
        ? `Arrêter le modèle · ${text}`
        : state.config.modelPath
          ? 'Démarrer le modèle'
          : 'Aucun LLM enregistré · ouvrir les paramètres';
  $('toggle-engine').className =
    'engine-button ' +
    (paused ? 'is-paused' : running ? (s.state === 'ready' ? 'is-running' : 'is-running is-busy') : 'is-off');
  $('toggle-engine').setAttribute('aria-label', engineLabel);
  $('toggle-engine').title = engineLabel;
  $('toggle-engine').replaceChildren(icon(paused || running ? 'stop' : 'play'));
  const proposing = Boolean(state.studio?.proposing?.());
  $('send').disabled =
    state.projectWorking ||
    toolBusy ||
    !state.connected ||
    s.state === 'stopping' ||
    (s.busy && !proposing) ||
    (state.generating && !proposing) ||
    state.preparing ||
    state.operation ||
    state.loadingHistory ||
    (!$('prompt').value.trim() && !state.images.length && !state.videos.length);
  $('send').hidden = (state.generating && !proposing) || toolBusy;
  // A proposal waits in the Studio: it is cancelled from here as from the Studio's « Annuler »,
  // and a new message declines it too.
  $('cancel').hidden = !state.generating && (!toolBusy || s.toolJob.blocked);
  const cancelLabel = proposing
    ? 'Annuler la proposition de Moodix AI'
    : state.waitingForModel
      ? 'Annuler le message en attente'
      : 'Interrompre la réponse';
  $('cancel').setAttribute('aria-label', cancelLabel);
  $('cancel').title = cancelLabel;
  $('thinking').disabled = state.generating;
  $('attach').disabled = state.generating || state.preparing || state.loadingHistory;
  $('new-chat').disabled = state.projectWorking || toolBusy || state.generating || state.loadingHistory;
  $('new-chat-mobile').disabled = state.projectWorking || toolBusy || state.generating || state.loadingHistory;
  for (const button of document.querySelectorAll('.history-item, .history-delete-button')) {
    button.disabled =
      state.projectWorking ||
      state.savingHistory ||
      toolBusy ||
      state.generating ||
      state.preparing ||
      state.loadingHistory ||
      (button.classList.contains('history-delete-button') && $('history-clear').disabled);
    if (button.classList.contains('history-item')) button.classList.toggle('active', button.dataset.current === 'true');
  }
  $('prompt').disabled = state.loadingHistory;
  $('compose-state').textContent = proposing
    ? 'Proposition dans le Studio · un message la refuse'
    : toolBusy
    ? s.toolJob.progress || 'Génération en cours…'
    : state.preparing
      ? 'Préparation des images…'
      : state.waitingForModel
        ? 'Chargement… message en attente'
        : state.generating
          ? 'Réponse en cours…'
          : s.state === 'loading'
            ? 'Le modèle se charge…'
            : '';
  workflowsUI.setBusy(
    s.busy || toolBusy || state.generating || state.operation || state.settingsLoading || !state.connected,
  );
  const logs = s.logs?.join('\n') || 'Les journaux apparaîtront au démarrage.';
  if ($('engine-logs').textContent !== logs) $('engine-logs').textContent = logs;
  if (s.error && $('config-error').hidden) {
    $('config-error').textContent = s.error;
    $('config-error').hidden = false;
  }
  assetsUI.setBusy(state.generating || s.busy || toolBusy || state.updating || state.closingApp);
  if (state.closingApp)
    for (const control of document.querySelectorAll('button,input,textarea,select')) control.disabled = true;
  $('add-llm').disabled =
    state.settingsLoading ||
    state.operation ||
    state.generating ||
    state.generationSettingsWorking ||
    toolBusy ||
    !state.connected ||
    !state.settingsReady;
  $('global-instructions').disabled = $('add-llm').disabled;
  $('detected-model').disabled = $('add-llm').disabled || ['loading', 'stopping'].includes(s.state);
  $('llm-fields').disabled = $('add-llm').disabled || ['loading', 'stopping'].includes(s.state);
  $('save-llm').disabled = $('llm-fields').disabled;
  $('remove-llm').disabled =
    $('detected-model').disabled ||
    state.modelAdding ||
    !state.detectedModels?.some(item => item.id === $('detected-model').value && item.id !== 'current');
}

/**
 * Updates live in the first tab of the settings. The server looks for one at launch; when it
 * finds one, the settings button and the tab wear a dot, and the tab offers to install it.
 */
async function checkUpdates({ refresh = false } = {}) {
  try {
    const update = await (await api(refresh ? 'updates?refresh=1' : 'updates')).json();
    state.updateAvailable = update.available === true;
    const at = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    $('settings-update-status').textContent = state.updateAvailable
      ? 'La version ' + update.version + ' est disponible.'
      : refresh
        ? 'Aucune mise à jour trouvée (recherche faite à ' + at + ').'
        : 'Aucune mise à jour trouvée au lancement.';
    $('settings-update-install').hidden = !state.updateAvailable;
    $('settings-update-install').textContent = state.updateAvailable
      ? 'Installer la version ' + update.version
      : 'Installer la mise à jour';
    const opener = $('settings-open');
    opener.classList.toggle('has-update', state.updateAvailable);
    const label = state.updateAvailable ? 'Configuration · mise à jour disponible' : 'Configuration';
    opener.setAttribute('aria-label', label);
    opener.title = label;
    settingsTabs.mark('update', state.updateAvailable);
    if (refresh) $('live-status').textContent = state.updateAvailable ? 'Mise à jour disponible.' : 'Aucune mise à jour trouvée.';
  } catch {
    /* Offline checks stay silent. */
  }
}

async function searchUpdate() {
  if (state.checkingUpdates) return;
  state.checkingUpdates = true;
  $('settings-update-check').textContent = 'Recherche…';
  updateControls();
  try {
    await checkUpdates({ refresh: true });
  } finally {
    state.checkingUpdates = false;
    $('settings-update-check').textContent = 'Rechercher une mise à jour';
    updateControls();
  }
}

/** The Hugging Face token: kept by the server on this computer, never sent back to the page. */
function renderToken(hasToken, message) {
  $('hf-token-remove').hidden = !hasToken;
  $('hf-token').placeholder = hasToken ? 'Jeton enregistré · collez-en un autre pour le remplacer' : 'hf_…';
  $('hf-token-status').textContent = message ?? (hasToken ? 'Un jeton est enregistré sur cet ordinateur.' : '');
}
async function refreshToken() {
  try {
    renderToken((await (await api('downloads')).json()).hasToken);
  } catch {
    /* Said again at the next opening. */
  }
}
async function saveToken(token) {
  try {
    const { hasToken } = await (await api('downloads/token', { token })).json();
    $('hf-token').value = '';
    renderToken(hasToken, hasToken ? 'Jeton enregistré sur cet ordinateur.' : 'Jeton retiré.');
    void workflowsUI.refresh({ settings: false }).catch(() => {});
  } catch (error) {
    $('hf-token-status').textContent = error.message;
  }
}

const COMPONENT_STATES = { missing: 'Manquant', error: 'Problème', off: 'Non utilisé' };
const LLAMA_WORKING = ['checking', 'downloading', 'unpacking', 'trying', 'switching'];
const megabytes = bytes => Math.max(1, Math.round((bytes || 0) / 1048576)).toLocaleString('fr-FR') + ' Mo';
/** The line under the llama.cpp row of the components (made once, filled again). */
function llamaLine() {
  const row = $('components-list').querySelector('[data-id="llama"]');
  if (!row) return null;
  let line = row.querySelector('.llama-install');
  if (!line) {
    line = node('div', 'llama-install');
    const text = node('span', 'llama-install-text'),
      go = node('button', 'secondary llama-install-go'),
      own = node('button', 'text-button llama-install-own', 'Choisir le mien…');
    go.type = 'button';
    go.hidden = true;
    // Their own llama-server stays theirs to choose: the field of the engine, in Génération.
    own.type = 'button';
    own.title = 'Utiliser votre propre llama-server : Réglages › Génération › Moteur llama.cpp';
    own.onclick = () => {
      $('settings-tab-generation').click();
      $('engine-path').scrollIntoView({ block: 'center' });
      $('engine-path').focus();
    };
    line.append(text, go, own);
    row.append(line);
  }
  return { line, text: line.querySelector('.llama-install-text'), go: line.querySelector('.llama-install-go') };
}
/**
 * Under the llama.cpp row: the official build that fits this computer (its system, its
 * processor, its graphics card), installed or brought up to date in one click: downloaded,
 * checked, tried on the card, then used by the chat model.
 */
async function showLlama() {
  const parts = llamaLine();
  if (!parts) return;
  const { text, go } = parts,
    current = $('components-list').querySelector('[data-id="llama"] .component-version')?.textContent || '';
  try {
    const job = await (await api('llama')).json();
    if (LLAMA_WORKING.includes(job.state)) return void followLlama();
    text.textContent = 'Recherche de la version officielle pour cet ordinateur…';
    go.hidden = true;
    const offer = await (await api('llama/check', {})).json(),
      best = offer.candidates[0];
    if (!best) {
      text.textContent = 'llama.cpp ne publie aucune version pour ce système.';
      return;
    }
    const upToDate = job.ours && current === offer.tag;
    text.textContent = upToDate
      ? `À jour : version officielle ${offer.tag}.`
      : job.ours
        ? `Version officielle plus récente : ${offer.tag} · ${best.label} (${megabytes(best.size)}).`
        : `Version officielle pour cet ordinateur : ${offer.tag} · ${best.label} (${megabytes(best.size)}). « Installer » la met à la place du moteur actuel.`;
    go.textContent = job.ours ? 'Mettre à jour' : 'Installer';
    go.hidden = upToDate;
    go.onclick = () => void installLlama();
  } catch (error) {
    text.textContent = 'Versions officielles de llama.cpp indisponibles : ' + error.message;
  }
}
async function installLlama() {
  const parts = llamaLine();
  if (!parts) return;
  parts.go.hidden = true;
  try {
    await api('llama/install', {});
  } catch (error) {
    parts.text.textContent = error.message;
    return;
  }
  await followLlama();
}
/** The installation as it goes, until the chat model runs on the new build (or what failed). */
async function followLlama() {
  if (state.followingLlama) return;
  state.followingLlama = true;
  try {
    while (true) {
      const job = await (await api('llama')).json(),
        parts = llamaLine();
      if (!parts) return;
      const { text, go } = parts;
      go.hidden = true;
      if (job.state === 'downloading') text.textContent = `${job.step} ${megabytes(job.received)} / ${megabytes(job.total)}`;
      else if (job.state === 'error') {
        text.textContent = job.error;
        return;
      } else if (job.state === 'done') {
        const { result } = job;
        text.textContent =
          `llama.cpp ${result.tag} (${result.label}) installé${job.used ? ' et utilisé par le modèle' : ''}.` +
          (result.devices[0] ? ' Il voit : ' + result.devices[0] + '.' : '');
        // The setting changed on the server: the field says so. A form without other changes
        // stays saved; one with changes of the user keeps them to save (the new path with them).
        const clean = !settingsGuard.isDirty();
        state.config.enginePath = result.enginePath;
        $('engine-path').value = result.enginePath;
        if (clean) settingsGuard.markSaved();
        await checkComponents({ again: true });
        return;
      } else text.textContent = job.step || 'Installation…';
      await new Promise(resolve => setTimeout(resolve, 800));
    }
  } catch (error) {
    const parts = llamaLine();
    if (parts) parts.text.textContent = error.message;
  } finally {
    state.followingLlama = false;
  }
}
/** The versions of the programs Atelier runs on (GET /api/components), once per opening of the tab. */
async function checkComponents({ again = false } = {}) {
  if (state.checkingComponents || (!again && state.componentsSession === state.settingsSession)) return;
  state.componentsSession = state.settingsSession;
  state.checkingComponents = true;
  $('components-check').disabled = true;
  $('components-status').textContent = 'Lecture des versions…';
  try {
    // Versions read for an earlier opening are still true: they are shown all the same.
    const result = await (await api('components')).json();
    $('settings-version').textContent = 'Atelier ' + result.version;
    $('components-list').replaceChildren(
      ...result.components.map(component => {
        const row = node('li', 'component-row');
        row.dataset.state = component.state;
        row.dataset.id = component.id;
        const name = node('div', 'component-name');
        name.append(node('strong', '', component.name));
        if (component.detail) name.append(node('span', 'component-detail', component.detail));
        const version = node('span', 'component-version', component.version || '—');
        row.append(name, version);
        if (COMPONENT_STATES[component.state])
          row.append(node('span', 'component-state', COMPONENT_STATES[component.state]));
        return row;
      }),
    );
    const problems = result.components.filter(component => ['missing', 'error'].includes(component.state)).length;
    $('components-status').textContent = problems
      ? problems + (problems > 1 ? ' composants demandent' : ' composant demande') + ' votre attention.'
      : '';
    void showLlama();
  } catch (error) {
    $('components-status').textContent = error.message;
  } finally {
    state.checkingComponents = false;
    $('components-check').disabled = false;
  }
}

let statusRefreshing = false;
async function refreshStatus() {
  if (statusRefreshing || state.updating || state.closingApp) return;
  statusRefreshing = true;
  try {
    const previous = state.status.state;
    const wasConnected = state.connected;
    state.status = await (await api('status', undefined, { signal: AbortSignal.timeout(5000) })).json();
    workflowsUI.updateRunner?.(state.status.runner);
    state.connected = true;
    if (previous !== state.status.state || !wasConnected) contextMeter.schedule();
    if (state.status.state !== previous) {
      $('live-status').textContent = labels[state.status.state];
      if (state.status.state === 'error')
        notice(state.status.error || 'Le moteur s’est arrêté. Consultez la configuration.');
    }
  } catch {
    state.connected = false;
    contextMeter.schedule();
  } finally {
    statusRefreshing = false;
  }
  updateControls();
}

function modelDraft() {
  return {
    id: state.modelEditId || '',
    adding: !!state.modelAdding,
    selection: $('detected-model').value,
    name: $('llm-name').value,
    modelPath: $('model-path').value,
    projectorPath: $('projector-path').value,
  };
}
function modelEditorDirty() {
  return state.modelDraftBaseline !== undefined && JSON.stringify(modelDraft()) !== state.modelDraftBaseline;
}
function loadModelDraft(item, { adding = false } = {}) {
  state.modelAdding = adding;
  state.modelEditId = !adding && state.models.some(saved => saved.id === item?.id) ? item.id : '';
  $('llm-name').value = item?.name || '';
  $('model-path').value = item?.modelPath || '';
  $('projector-path').value = item?.projectorPath || '';
  $('llm-error').hidden = true;
  state.modelDraftBaseline = JSON.stringify(modelDraft());
}
function activeModel() {
  return (state.models || []).find(
    item => item.modelPath === state.config.modelPath && item.projectorPath === (state.config.projectorPath || ''),
  );
}
function applyModelLibrary(library) {
  state.models = library.models || [];
  state.detectedModels = [
    ...state.models,
    ...(library.detected || []).filter(item => !state.models.some(saved => saved.id === item.id)),
  ];
  const current = activeModel() || {
    id: 'current',
    name: state.modelName || state.config.modelPath?.split(/[\\/]/).slice(-2, -1)[0] || '',
    modelPath: state.config.modelPath || '',
    projectorPath: state.config.projectorPath || '',
  };
  if (
    current.modelPath &&
    !state.detectedModels.some(
      item => item.modelPath === current.modelPath && item.projectorPath === current.projectorPath,
    )
  )
    state.detectedModels.unshift(current);
  const select = $('detected-model');
  select.replaceChildren();
  if (!state.detectedModels.length) {
    const manual = node('option', '', 'Chemins manuels ci-dessous');
    manual.value = '';
    select.append(manual);
  }
  for (const item of state.detectedModels) {
    const option = node('option', '', item.name);
    option.value = item.id;
    select.append(option);
  }
  const selected =
    state.detectedModels.find(
      item => item.modelPath === current.modelPath && item.projectorPath === current.projectorPath,
    ) || state.detectedModels[0];
  select.value = selected?.id || '';
  loadModelDraft(selected);
  $('model-paths').open = false;
  $('models-status').textContent = (library.errors || []).map(item => item.name + ' : ' + item.error).join('\n');
  $('models-status').hidden = !$('models-status').textContent;
}
function chooseDetectedModel() {
  const item = state.detectedModels.find(item => item.id === $('detected-model').value);
  if (!item) return;
  const previous = JSON.parse(state.modelDraftBaseline || '{}');
  const edited = ['name', 'modelPath', 'projectorPath'].some(key => modelDraft()[key] !== previous[key]);
  if (edited && !confirm('Abandonner les modifications de ce LLM ?')) {
    $('detected-model').value = previous.selection || '';
    return;
  }
  loadModelDraft(item);
  settingsSearch.refresh();
  updateControls();
}
function addLLM() {
  if ($('add-llm').disabled) return;
  if (modelEditorDirty() && !confirm('Abandonner les modifications de ce LLM ?')) return;
  settingsSearch.reset();
  $('detected-model').value = '';
  loadModelDraft(null, { adding: true });
  $('model-paths').open = true;
  $('llm-name').focus();
  updateControls();
}
function cancelLLM() {
  if (modelEditorDirty() && !confirm('Abandonner les modifications de ce LLM ?')) return;
  const current =
    activeModel() ||
    state.detectedModels.find(
      item => item.modelPath === state.config.modelPath && item.projectorPath === (state.config.projectorPath || ''),
    );
  $('detected-model').value = current?.id || state.detectedModels[0]?.id || '';
  loadModelDraft(current || state.detectedModels[0]);
  $('model-paths').open = false;
  updateControls();
}
async function removeLLM() {
  if ($('remove-llm').disabled || state.operation) return;
  const item = state.detectedModels.find(item => item.id === $('detected-model').value);
  if (!item) return;
  if (
    !confirm(
      'Retirer « ' +
        item.name +
        ' » de la liste ? Les fichiers sont conservés.' +
        (item.modelPath === state.config.modelPath ? ' Le modèle actif sera arrêté.' : '') +
        (modelEditorDirty() ? ' Les modifications de ce LLM seront abandonnées.' : ''),
    )
  )
    return;
  const session = state.settingsSession;
  state.operation = true;
  updateControls();
  try {
    const result = await (await api('models/remove', { id: item.id })).json();
    state.config = result.config;
    state.modelName = result.modelName;
    state.status = result.status;
    state.models = result.models;
    if (session === state.settingsSession && $('settings').open) {
      applyModelLibrary(result);
      settingsGuard.markPartSaved('llm');
      settingsSearch.refresh();
    }
    contextMeter.schedule();
  } catch (error) {
    notice(error.message);
  } finally {
    state.operation = false;
    await refreshStatus();
  }
}
async function saveLLM({ withinSettingsSave = false } = {}) {
  if (!withinSettingsSave && ($('save-llm').disabled || state.operation)) return false;
  const session = state.settingsSession,
    draft = modelDraft();
  if (!draft.name.trim()) {
    $('model-paths').open = true;
    $('llm-error').textContent = 'Indiquez un nom.';
    $('llm-error').hidden = false;
    $('llm-name').focus();
    return false;
  }
  if (!withinSettingsSave) {
    state.operation = true;
    updateControls();
  }
  $('llm-error').hidden = true;
  try {
    const result = await (
      await api('models/add', {
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name,
        modelPath: draft.modelPath,
        projectorPath: draft.projectorPath,
      })
    ).json();
    state.models = result.models;
    if (session === state.settingsSession && $('settings').open) state.modelEditId = result.profile.id;
    const selected = await (await api('models/select', { id: result.profile.id })).json();
    state.config = selected.config;
    state.modelName = selected.modelName;
    state.status = selected.status;
    if (selected.warning || selected.status?.state === 'error')
      throw Error(selected.warning || selected.status.error || 'Le modèle n’a pas démarré.');
    if (session === state.settingsSession && $('settings').open) {
      state.detectedModels = [
        result.profile,
        ...state.detectedModels.filter(item => item.id !== draft.id && item.id !== result.profile.id),
      ];
      const select = $('detected-model');
      select.replaceChildren();
      for (const item of state.detectedModels) {
        const option = node('option', '', item.name);
        option.value = item.id;
        select.append(option);
      }
      select.value = result.profile.id;
      loadModelDraft(result.profile);
      settingsGuard.markPartSaved('llm');
      $('model-paths').open = false;
      $('models-status').hidden = true;
    }
    contextMeter.schedule();
    return true;
  } catch (error) {
    if (session === state.settingsSession && $('settings').open) {
      $('model-paths').open = true;
      $('llm-error').textContent = error.message;
      $('llm-error').hidden = false;
    }
    return false;
  } finally {
    if (!withinSettingsSave) {
      state.operation = false;
      await refreshStatus();
    }
  }
}
function requestSettingsClose(after) {
  if (workflowsUI.isEditing?.()) return workflowsUI.requestBack(() => settingsGuard.requestClose(after));
  return settingsGuard.requestClose(after);
}

function openSettings() {
  if ($('settings').open) return;
  filePickerController?.abort();
  workflowsUI.cancelSettings();
  const session = (state.settingsSession = (state.settingsSession || 0) + 1);
  state.settingsLoading = true;
  state.settingsReady = false;
  $('config-error').hidden = true;
  settingsSearch.reset();
  $('settings').showModal();
  $('settings').scrollTop = 0;
  $('settings-body').scrollTop = 0;
  settingsTabs.opened();
  updateControls();
  Promise.all([
    api('bootstrap').then(response => response.json()),
    workflowsUI.refresh(),
    api('models').then(response => response.json()),
  ])
    .then(([initial, , library]) => {
      if (session !== state.settingsSession || !$('settings').open) return;
      state.config = initial.config;
      state.modelName = initial.modelName || '';
      state.globalInstructions = initial.instructions || '';
      $('global-instructions').value = state.globalInstructions;
      applyModelLibrary(library);
      if (initial.preferences && !state.savingPreferences) {
        const historyChanged = state.saveHistory !== initial.preferences.saveHistory;
        state.saveHistory = initial.preferences.saveHistory;
        applyTheme(initial.preferences.theme);
        if (historyChanged) void refreshHistory().catch(error => notice(error.message));
      }
      $('engine-path').value = state.config.enginePath || '';
      tokenControls.setValues(state.config);
      computeControls.setValues(state.config);
      state.settingsReady = true;
      settingsGuard.markSaved();
      settingsSearch.refresh();
    })
    .catch(error => {
      if (session !== state.settingsSession || !$('settings').open) return;
      $('config-error').textContent = error.message;
      $('config-error').hidden = false;
    })
    .finally(() => {
      if (session === state.settingsSession) {
        state.settingsLoading = false;
        updateControls();
      }
    });
}

async function saveConfiguration() {
  if (
    state.operation ||
    state.settingsLoading ||
    state.generationSettingsWorking ||
    !state.settingsReady ||
    !$('settings').open
  )
    return;
  const session = state.settingsSession;
  if (workflowsUI.hasPendingImport?.()) {
    if (!(await workflowsUI.finishImport?.())) return;
    if (session !== state.settingsSession || !$('settings').open) return;
  }
  state.operation = true;
  $('config-error').hidden = true;
  updateControls();
  try {
    const selectionChanged =
      $('model-path').value !== (state.config.modelPath || '') ||
      $('projector-path').value !== (state.config.projectorPath || '');
    if ((state.modelAdding || modelEditorDirty() || selectionChanged) && !(await saveLLM({ withinSettingsSave: true })))
      return false;
    const config = {
      enginePath: $('engine-path').value,
      modelPath: state.config.modelPath,
      projectorPath: state.config.projectorPath,
      ...tokenControls.values(),
      ...computeControls.values(),
    };
    const saved = await (
      await api('settings', {
        config,
        instructions: $('global-instructions').value,
        generation: workflowsUI.values(),
        workflowDescriptions: workflowsUI.workflowDescriptions(),
      })
    ).json();
    state.config = saved.config;
    state.generation = saved.generation;
    state.globalInstructions = saved.instructions ?? $('global-instructions').value;
    state.modelName = activeModel()?.name || '';
    const current = session === state.settingsSession && $('settings').open;
    if (current) {
      workflowsUI.saved(saved);
      settingsGuard.markSaved();
      $('settings').close();
    }
    contextMeter.schedule();
    return current;
  } catch (error) {
    if (session === state.settingsSession && $('settings').open) {
      $('config-error').textContent = error.message;
      $('config-error').hidden = false;
    }
  } finally {
    state.operation = false;
    await refreshStatus();
  }
}

async function shutdownApplication() {
  if ($('shutdown-app').disabled) return;
  if (settingsGuard.isDirty()) return requestSettingsClose(() => shutdownApplication());
  const controls = [...document.querySelectorAll('button,input,textarea,select')].map(control => [
    control,
    control.disabled,
  ]);
  state.closingApp = true;
  updateControls();
  try {
    if (!(await persistConversation()))
      throw Error('La conversation n’a pas été sauvegardée. L’application reste ouverte.');
    await historyWrite;
    await api('shutdown', {});
    state.connected = false;
    $('settings').close();
    notice('Application arrêtée. Vous pouvez fermer cet onglet.');
  } catch (error) {
    state.closingApp = false;
    for (const [control, disabled] of controls) control.disabled = disabled;
    notice(error.message);
  } finally {
    updateControls();
  }
}

/**
 * « Redémarrer » (Settings, beside « Fermer l'application »): the application starts again by
 * itself, its server and its model, from the files of its folder. The open conversation, its draft
 * and its images are kept for the page to take back, as after an update; the page loads again
 * from the new instance once it answers.
 */
async function restartApplication() {
  if ($('restart-app').disabled) return;
  if (settingsGuard.isDirty()) return requestSettingsClose(() => restartApplication());
  const token = state.token;
  state.closingApp = true;
  updateControls();
  try {
    if (!(await persistConversation()))
      throw Error('La conversation n’a pas été sauvegardée. L’application reste ouverte.');
    await historyWrite;
    $('settings').close();
    $('update-title').textContent = 'Redémarrage';
    $('update-progress').textContent = 'Redémarrage de l’application…';
    $('update-dialog').showModal();
    await api('relaunch', {
      always: true,
      session: compactSession({
        messages: state.messages,
        archiveSnapshot: state.archiveSnapshot,
        conversationId: state.conversationId,
        conversationInstructions: state.conversationInstructions,
        prompt: $('prompt').value,
        images: state.images,
        thinking: state.thinking,
        title: $('conversation-title').textContent,
      }),
    });
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 750));
      try {
        const next = await (
          await fetch('/api/bootstrap?brief=1', { cache: 'no-store', signal: AbortSignal.timeout(2000) })
        ).json();
        if (next?.token && next.token !== token) {
          state.updateReload = true;
          location.reload();
          return;
        }
      } catch {
        // Between the two instances: nothing answers for a moment.
      }
    }
    throw Error('Redémarrage non confirmé. Si l’application ne revient pas, relance-la avec Lancer-Windows.cmd.');
  } catch (error) {
    state.closingApp = false;
    $('update-dialog').close();
    $('update-title').textContent = 'Mise à jour';
    notice(error.message);
  } finally {
    updateControls();
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
  } catch (error) {
    notice(error.message);
  } finally {
    state.operation = false;
    await refreshStatus();
  }
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
    preview.src = image.url || image.view;
    preview.alt = image.name;
    const remove = node('button');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Retirer ${image.name}`);
    remove.append(icon('close'));
    remove.onclick = () => {
      state.images.splice(index, 1);
      renderAttachments();
      updateControls();
    };
    box.append(preview, remove);
    $('attachments').append(box);
  });
  state.videos.forEach((video, index) => {
    const box = node('div', 'attachment is-video'),
      resource = assetsUI.resource(video.id);
    box.title = `${video.label} · ${video.name}`;
    if (resource?.previewUrl) {
      const preview = node('img');
      preview.src = resource.previewUrl;
      preview.alt = video.name;
      box.append(preview);
    }
    box.append(node('span', 'attachment-badge', '▶ ' + video.label));
    const remove = node('button');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Retirer ${video.name}`);
    remove.append(icon('close'));
    // The video stays in the library: only this message no longer names it.
    remove.onclick = () => {
      state.videos.splice(index, 1);
      renderAttachments();
      updateControls();
    };
    box.append(remove);
    $('attachments').append(box);
  });
}

/** Images and videos dropped, pasted or chosen: videos go to the library, images to the message. */
function addFiles(files) {
  const videos = files.filter(isVideo),
    images = files.filter(file => !isVideo(file));
  if (videos.length) addVideos(videos);
  if (images.length) addImages(images);
}

async function addVideos(files) {
  if (state.projectWorking || state.status.toolJob || state.generating || state.preparing || state.loadingHistory)
    return;
  state.preparing = true;
  updateControls();
  try {
    const imported = await assetsUI.importFiles(files, { reveal: false });
    if (!imported.length)
      return notice('Vidéo non importée : la bibliothèque est occupée ou le fichier est illisible.');
    state.videos.push(...imported.map(resource => ({ id: resource.id, label: resource.label, name: resource.name })));
    notice('');
  } catch (error) {
    notice(error.message || 'Cette vidéo ne peut pas être lue.');
  } finally {
    state.preparing = false;
    renderAttachments();
    updateControls();
  }
}

async function addImages(files) {
  if (state.projectWorking || state.status.toolJob || state.generating || state.preparing || state.loadingHistory)
    return;
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
  } catch (error) {
    notice(error.message || 'Cette image ne peut pas être lue.');
  } finally {
    state.preparing = false;
    renderAttachments();
    updateControls();
  }
}

function scrollToBottom() {
  if (state.stickToBottom) $('chat-area').scrollTop = $('chat-area').scrollHeight;
}

function renderText(target, text) {
  target.classList.add('markdown');
  target.innerHTML = markdownToHtml(text);
}

function userMessage(text, images, videos = []) {
  const article = node('article', 'message user');
  article.setAttribute('aria-label', 'Votre message');
  if (videos.length) {
    const previews = node('div', 'message-videos');
    for (const video of videos) {
      const resource = assetsUI.resource(video.id);
      if (resource?.originalUrl) {
        const player = node('video');
        player.controls = true;
        player.preload = 'none';
        player.playsInline = true;
        player.src = resource.originalUrl;
        if (resource.previewUrl) player.poster = resource.previewUrl;
        player.setAttribute('aria-label', `${video.label} · ${video.name}`);
        previews.append(player);
      } else previews.append(node('span', 'message-video-missing', `▶ ${video.label} · ${video.name}`));
    }
    article.append(previews);
  }
  if (images.length) {
    const previews = node('div', 'message-images');
    for (const image of images) {
      const img = node('img');
      // The stored original when there is one; the model's copy is not what the user attached.
      img.src = image.view || image.url;
      img.alt = image.name;
      img.decoding = 'async';
      previews.append(img);
    }
    article.append(previews);
  }
  if (text) article.append(node('div', 'message-body', text));
  $('messages').append(article);
  return article;
}

/**
 * Under the last exchange: « Modifier » on what the user sent, « Régénérer » on the reply.
 * Drawn again whenever the conversation shown changes. Nothing copies a whole message: copying
 * belongs to the quotes and the code blocks of a reply (copy.mjs), and stays there.
 */
function turnActions() {
  for (const row of document.querySelectorAll('#messages .message-actions')) row.remove();
  // Not while a reply is being written, nor for a message the application wrote itself.
  if (state.generating || lastExchange(state.messages) < 0) return;
  const action = (label, glyph, title, onclick) => {
    const control = node('button', 'message-action');
    control.type = 'button';
    control.title = title;
    control.append(icon(glyph), node('span', '', label));
    control.onclick = onclick;
    const row = node('div', 'message-actions');
    row.append(control);
    return row;
  };
  const sent = [...document.querySelectorAll('#messages .message.user')].at(-1),
    reply = $('messages').lastElementChild;
  sent?.append(
    action('Modifier', 'edit', 'Reprendre ce message dans la zone de texte ; sa réponse est retirée', () =>
      takeBack(false),
    ),
  );
  if (reply?.classList.contains('assistant'))
    reply.append(
      action('Régénérer', 'update', 'Renvoyer le même message pour obtenir une autre réponse', () => takeBack(true)),
    );
}
/** Takes back the last message the user wrote: to edit it, or to send it again as it is. */
async function takeBack(resend) {
  if (state.generating || state.preparing || state.loadingHistory || state.status.toolJob)
    return notice('Attends la fin de la réponse ou de la génération en cours.');
  const index = lastExchange(state.messages);
  if (index < 0) return;
  const draft = savedUser(state.messages[index]),
    waiting = $('prompt').value.trim();
  if (resend && (waiting || state.images.length || state.videos.length))
    return notice('Envoyez ou effacez d’abord le message en cours d’écriture.');
  // Kept as a conversation whose last message is still being written: opened again, that
  // message comes back in the message box.
  state.archiveSnapshot = { messages: state.messages.slice(0, index + 1), incomplete: true };
  state.messages = state.messages.slice(0, index);
  state.images = [...draft.images, ...state.images];
  state.videos = [...draft.videos, ...state.videos];
  $('prompt').value = draft.text + (waiting ? '\n\n' + waiting : '');
  generationUI.clear();
  $('messages').replaceChildren();
  renderTranscript(state.messages);
  turnActions();
  $('welcome').hidden = state.messages.length > 0;
  renderAttachments();
  resizePrompt();
  updateControls();
  contextMeter.schedule();
  await persistConversation();
  if (resend) $('chat-form').requestSubmit();
  else $('prompt').focus();
}
function assistantMessage(parent = null) {
  const article = parent?.article || node('article', 'message assistant');
  article.setAttribute('aria-label', 'Réponse du modèle');
  if (!parent) {
    const header = node('div', 'message-header');
    const avatar = node('span', 'message-avatar');
    avatar.append(icon('spark'));
    header.append(avatar, node('span', '', 'Moodix AI'));
    article.append(header);
  }
  const reasoning = node('details', 'reasoning');
  reasoning.hidden = true;
  const summary = node('summary', '', 'Réflexion du modèle');
  const thoughts = node('div', 'reasoning-content');
  reasoning.append(summary, thoughts);
  const body = node('div', 'message-body');
  body.append(node('span', 'pending-dot', '●'));
  const note = node('div', 'message-note');
  const generations = parent?.generations || node('div', 'generation-grid');
  article.append(reasoning, body, note);
  if (!parent) {
    article.append(generations);
    $('messages').append(article);
  }
  return { article, reasoning, summary, thoughts, body, note, generations };
}

/**
 * Output buttons. Prolonger writes a line the model understands in the composer, for the user to
 * finish. Upscale and Interpoler run the same proposal a model call would, without a model reply:
 * the user confirms it, the result joins the conversation as an ordinary tool call.
 */
async function runOutputAction(record, index, action) {
  const reference = record.id + (index ? ` (sortie ${index + 1})` : '');
  if (action === 'extend') {
    const line = `Pour la sortie ${reference}, continue la vidéo : `,
      prompt = $('prompt');
    prompt.value = line + (prompt.value.trim() ? '\n\n' + prompt.value : '');
    resizePrompt();
    prompt.focus();
    prompt.setSelectionRange(line.length, line.length);
    return;
  }
  if (state.generating || state.preparing || state.loadingHistory || state.status.toolJob)
    return notice('Attends la fin de la réponse ou de la génération en cours.');
  if (record.conversationId !== state.conversationId) return notice('Ouvre la conversation de ce résultat.');
  const video = record.mediaType === 'video',
    text =
      action === 'upscale'
        ? `Upscale de la sortie ${reference}.`
        : `Interpolation de la sortie ${reference} pour une vidéo plus fluide.`,
    history = [...state.messages, { role: 'user', content: text }];
  state.generating = true;
  turnActions();
  state.controller = new AbortController();
  const signal = state.controller.signal;
  updateControls();
  $('welcome').hidden = true;
  userMessage(text, []);
  const view = assistantMessage();
  view.body.replaceChildren();
  state.stickToBottom = true;
  scrollToBottom();
  try {
    const request = await (
      await api(
        'tools/action',
        {
          conversationId: state.conversationId,
          name: action,
          arguments: {
            source: { output: record.id, ...(index ? { index } : {}) },
            intention:
              action === 'upscale' ? `Agrandir ${video ? 'la vidéo' : 'l’image'}.` : 'Rendre la vidéo plus fluide.',
          },
        },
        { signal },
      )
    ).json();
    history.push({ role: 'assistant', content: '', tool_calls: [request.call] });
    view.generation = true;
    const generation = generationUI.mount(view.generations, request);
    let result;
    try {
      result = await workflowsUI.requestTool(
        request,
        signal,
        (progress, fraction, preview) => {
          generation.progress(progress, fraction, preview);
          scrollToBottom();
        },
        image => generation.image(image),
        // The click on Upscale or Interpoler is the confirmation: no second question. No model
        // runs here, so the result does not say that images of the output are attached.
        { confirmed: true, review: false },
      );
      generation.finish(result);
    } catch (error) {
      generation.fail(error.message);
      history.push({
        role: 'tool',
        tool_call_id: request.call.id,
        content: JSON.stringify({ status: 'error', message: signal.aborted ? 'Génération annulée.' : error.message }),
      });
      throw error;
    }
    history.push({ role: 'tool', tool_call_id: request.call.id, content: result.content });
    if (result.record || result.failed) state.status = await (await api('status')).json();
    view.note.textContent = result.denied ? 'Action annulée.' : result.failed ? result.error || '' : '';
  } catch (error) {
    view.note.textContent = signal.aborted ? 'Opération interrompue à votre demande.' : error.message;
    if (!signal.aborted) {
      view.note.classList.add('error');
      notice(error.message);
    }
  } finally {
    if (history.length > state.messages.length + 1) {
      state.messages = archiveMessages(history);
      state.archiveSnapshot = { messages: [...state.messages], incomplete: false };
      await persistConversation();
    }
    state.generating = false;
    state.studio?.invalidate?.();
    turnActions();
    updateControls();
  }
}

function userContent(text, images) {
  return images.length
    ? [
        { type: 'text', text: text || 'Décris les images.' },
        ...images.map(image => ({
          type: 'image_url',
          ...(image.url ? { image_url: { url: image.url } } : {}),
          ...(image.file ? { file: image.file, view: image.view } : {}),
        })),
      ]
    : text;
}

function archiveMessages(messages) {
  return messages.filter(message => !message.resourceId && !message.outputId);
}

function chatRequest(messages, tools = true, resources = true) {
  const context = state.conversationInstructions ?? (state.messages.length ? '' : state.globalInstructions || '');
  const instructions = context
    ? '\n\nContexte fourni par l’utilisateur au démarrage de cette conversation :\n' + context
    : '';
  return {
    messages: [
      {
        role: 'system',
        content:
          'Tu es un assistant local utile. Réponds dans la langue de l’utilisateur. Décris honnêtement les images et signale tes incertitudes.' +
          instructions,
      },
      ...messages,
    ],
    thinking: state.thinking,
    tools,
    resources,
  };
}

/**
 * Stores each attached image as the user gave it, before it is sent: the conversation keeps
 * the original (shown on screen, passed to generation models) and the model gets the reduced
 * copy made when it was attached, held in memory for this session.
 */
async function storeAttachments(images, conversationId) {
  const stored = [];
  for (const image of images) {
    if (image.file) {
      stored.push(image);
      continue;
    }
    const blob = image.source || (await (await fetch(image.url)).blob());
    const result = await (
      await api('attachments', blob, {
        raw: true,
        headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-Conversation-Id': conversationId },
      })
    ).json();
    rememberCopy(conversationId, result.file, image.url);
    stored.push({ ...image, file: result.file, view: result.view });
  }
  return stored;
}

async function sendMessage(event) {
  event.preventDefault();
  if ($('send').disabled) return;
  if (state.generating) {
    // A proposal of Moodix AI waits in the Studio: this message answers it instead.
    if (!state.studio?.decline?.()) return;
    await state.turnEnded;
    if (state.generating) return;
  }
  if (!state.config.enginePath || !state.config.modelPath) {
    notice('Renseignez les chemins du moteur et du modèle dans Configuration avant le premier envoi.');
    return openSettings();
  }
  state.preparing = true;
  updateControls();
  try {
    if (!(await assetsUI.flush())) {
      notice('La description de ressource n’a pas été enregistrée. Réessayez avant l’envoi.');
      return;
    }
  } finally {
    state.preparing = false;
    updateControls();
  }
  const text = $('prompt').value.trim();
  state.conversationId ||= crypto.randomUUID();
  let images;
  state.preparing = true;
  updateControls();
  try {
    images = await storeAttachments(state.images, state.conversationId);
  } catch (error) {
    notice(`Image jointe non enregistrée : ${error.message}`);
    return;
  } finally {
    state.preparing = false;
    updateControls();
  }
  const videos = state.videos;
  const content = userContent(withVideos(text, videos), images);
  const history = [...state.messages, { role: 'user', content }],
    userView = userMessage(text, images, videos);
  state.conversationInstructions ??= state.messages.length ? '' : state.globalInstructions || '';
  const turnId = crypto.randomUUID();
  state.archiveSnapshot = { messages: [...archiveMessages(history)], incomplete: true };
  let view = assistantMessage(),
    output = '',
    reasoning = '',
    finishReason = '',
    complete = false,
    lastRender = 0,
    lastArchive = 0,
    usedTool = false,
    // After an output the assistant has not seen (an image, or a video without the automatic
    // analysis), it may only chain another tool: any text is withheld.
    silent = false;
  state.generating = true;
  let endTurn;
  state.turnEnded = new Promise(resolve => {
    endTurn = resolve;
  });
  turnActions();
  $('welcome').hidden = true;
  $('prompt').value = '';
  state.images = [];
  state.videos = [];
  renderAttachments();
  state.waitingForModel = true;
  state.controller = new AbortController();
  state.stickToBottom = true;
  const signal = state.controller.signal;
  contextMeter.pause();
  resizePrompt();
  notice('');
  scrollToBottom();
  function snapshot() {
    return {
      messages: [
        ...archiveMessages(history),
        ...(output || reasoning
          ? [{ role: 'assistant', content: output, ...(reasoning ? { reasoning_content: reasoning } : {}) }]
          : []),
      ],
      incomplete: true,
    };
  }
  function render() {
    if (silent) return;
    view.reasoning.hidden = !reasoning;
    view.thoughts.textContent = reasoning;
    if (output) renderText(view.body, output);
    else if (reasoning) view.body.replaceChildren(node('span', 'pending-dot', 'Réflexion en cours…'));
    if (output) showLastReply(output);
    scrollToBottom();
    lastRender = performance.now();
    state.archiveSnapshot = snapshot();
    if ((output || reasoning) && performance.now() - lastArchive > 2000 && !state.savingHistory) {
      lastArchive = performance.now();
      persistConversation();
    }
  }
  const started = performance.now();
  try {
    view.body.replaceChildren(node('span', 'pending-message', 'Démarrage du modèle… Votre message est en attente.'));
    if (!(await persistConversation()))
      throw Error('Impossible de sauvegarder ce message. Vérifiez le dossier history ou désactivez l’historique.');
    await waitForModel(api, signal, status => {
      state.status = status;
      updateControls();
    });
    state.waitingForModel = false;
    updateControls();
    let allowTools = true,
      iterations = 0,
      invalidCalls = 0,
      resourceReads = 0,
      briefing = false,
      reviewRecord = null;
    while (true) {
      signal.throwIfAborted();
      let request = null,
        // A model that wants a tool it was not given (after a failure, a refusal, the limit, or
        // while generation is unavailable) writes its call as text: that markup is never shown.
        leaked = false;
      view.body.replaceChildren(node('span', 'pending-dot', '●'));
      // Attached images of a reopened conversation get their compressed copy from the original.
      await fillCopies(history, { api, conversationId: state.conversationId, signal });
      const response = await api(
        'chat',
        {
          ...chatRequest(history, allowTools, resourceReads < 8),
          // Only deciding whether to chain another tool: thinking would cost seconds for nothing shown.
          // A plan put to the user before a video is a few lines: no thinking either.
          ...(silent || briefing ? { thinking: false } : {}),
          conversationId: state.conversationId,
          turnId,
        },
        { signal },
      );
      await readSSE(response.body, chunk => {
        contextMeter.observe(chunk);
        if (chunk.local_tool_request) request = chunk.local_tool_request;
        const choice = chunk.choices?.[0],
          delta = choice?.delta || {};
        if (!leaked) output += delta.content || '';
        if (!leaked) {
          // With tools on offer, only what is unmistakably a call (a reply may quote the tags).
          const cut = output.search(
            allowTools ? /<tool_call>\s*(?:<function=|\{)|(?:^|\n)<function=\w+>/ : /<tool_call>|<function=/,
          );
          if (cut >= 0) {
            output = output.slice(0, cut).trimEnd();
            leaked = true;
          }
        }
        reasoning += delta.reasoning_content || '';
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (performance.now() - lastRender > 55) render();
      });
      if (leaked && !output)
        output = allowTools
          ? 'Je n’ai pas pu lancer cet outil : la génération est peut-être indisponible en ce moment (voir les réglages). Renvoie ta demande pour que je réessaie.'
          : 'Je ne peux pas lancer d’autre génération dans ce message. Renvoie ta demande pour que je réessaie.';
      if (silent && !request) {
        // Nothing true to say about an unseen image: the image itself ends the turn.
        output = '';
        reasoning = '';
        view.silent = true;
        view.body.replaceChildren();
        view.reasoning.hidden = true;
        complete = true;
        view.note.textContent = `${((performance.now() - started) / 1000).toFixed(1)} s`;
        break;
      }
      silent = false;
      render();
      if (
        reviewRecord &&
        !['resource', 'output', 'invalid'].includes(request?.kind) &&
        output.trim() &&
        finishReason !== 'length'
      ) {
        try {
          await workflowsUI.saveReview(reviewRecord, output, request ? 'correction_requested' : 'reviewed');
        } catch (error) {
          notice(`Analyse de galerie non enregistrée : ${error.message}`);
        }
      }
      if (!request) {
        complete = true;
        view.note.textContent =
          finishReason === 'length'
            ? 'Limite de sortie atteinte.'
            : `${((performance.now() - started) / 1000).toFixed(1)} s`;
        break;
      }
      await historyWrite;
      usedTool = true;
      history.push({
        role: 'assistant',
        content: output,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        tool_calls: [request.call],
      });
      if (!output) view.body.replaceChildren();
      output = '';
      reasoning = '';
      if (request.kind === 'retry') {
        // Sent back before any generation with what to improve: the model makes its call again.
        history.push({
          role: 'tool',
          tool_call_id: request.call.id,
          content: JSON.stringify({ status: 'nothing_generated', message: request.message }),
        });
        state.archiveSnapshot = { messages: [...archiveMessages(history)], incomplete: true };
        await persistConversation();
        finishReason = '';
        continue;
      }
      if (request.kind === 'brief') {
        // A video is agreed on before it is generated: the model now writes its short plan and
        // its questions, without tools, and the user's answer starts the generation.
        history.push({
          role: 'tool',
          tool_call_id: request.call.id,
          content: JSON.stringify({ status: 'waiting_for_user', message: request.message }),
        });
        allowTools = false;
        resourceReads = 8;
        briefing = true;
        state.archiveSnapshot = { messages: [...archiveMessages(history)], incomplete: true };
        await persistConversation();
        finishReason = '';
        continue;
      }
      if (request.kind === 'invalid') {
        // Refused before any read or generation: the model learns why and may correct its call;
        // after a second refusal it must answer without tools, so a turn can never loop.
        invalidCalls++;
        history.push({
          role: 'tool',
          tool_call_id: request.call.id,
          content: JSON.stringify({
            status: 'error',
            message: request.message,
            note: 'Appel refusé avant toute génération. Corrige les arguments sans inventer d’identifiant, ou réponds sans outil.',
          }),
        });
        if (invalidCalls >= 2) {
          allowTools = false;
          resourceReads = 8;
        }
        view.note.textContent = 'Appel d’outil refusé : ' + request.message;
        state.archiveSnapshot = { messages: [...archiveMessages(history)], incomplete: true };
        await persistConversation();
        view = assistantMessage(view);
        finishReason = '';
        continue;
      }
      if (request.kind === 'output') {
        resourceReads++;
        // Its images are already in this turn: reading it again would only loop.
        if (history.some(message => message.outputId === request.runId + '/' + request.outputIndex)) {
          history.push({
            role: 'tool',
            tool_call_id: request.call.id,
            content: JSON.stringify({
              status: 'already_loaded',
              run_id: request.runId,
              output_index: request.outputIndex,
              note: 'Les images de cette sortie sont déjà jointes à ce tour. Réponds à l’utilisateur à partir d’elles, sans la relire.',
            }),
          });
          resourceReads = 8;
          state.archiveSnapshot = { messages: [...archiveMessages(history)], incomplete: true };
          await persistConversation();
          view = assistantMessage(view);
          finishReason = '';
          continue;
        }
        view.note.textContent = 'Consultation de la sortie…';
        try {
          const read = async () =>
            (
              await api(
                'gallery/read',
                { conversationId: state.conversationId, runId: request.runId, outputIndex: request.outputIndex },
                { signal },
              )
            ).json();
          let result = await read();
          // Its copy dates from an earlier session: make it again from the original file.
          if (!result.images.length && result.metadata.status === 'unavailable') {
            view.note.textContent = 'Préparation d’une copie compressée de la sortie…';
            try {
              await remakeOutputCopy({
                api,
                conversationId: state.conversationId,
                runId: request.runId,
                index: request.outputIndex ?? 0,
                signal,
              });
              result = await read();
            } catch (error) {
              if (signal.aborted) throw error;
            }
          }
          history.push({ role: 'tool', tool_call_id: request.call.id, content: JSON.stringify(result.metadata) });
          if (result.images.length) {
            reviewRecord = { id: request.runId, conversationId: state.conversationId };
            const outputId = request.runId + '/' + request.outputIndex;
            if (!history.some(message => message.outputId === outputId))
              history.push({
                role: 'user',
                internal: true,
                outputId,
                content: [
                  {
                    type: 'text',
                    text:
                      'Copie compressée de la sortie ' +
                      outputId +
                      '. ' +
                      result.metadata.note +
                      ' Pixels temporaires pour ce tour uniquement.',
                  },
                  ...result.images.map(url => ({ type: 'image_url', image_url: { url } })),
                ],
              });
          }
          view.note.textContent = result.images.length ? 'Sortie consultée.' : 'Copie visuelle indisponible.';
        } catch (error) {
          history.push({
            role: 'tool',
            tool_call_id: request.call.id,
            content: JSON.stringify({ status: 'error', message: error.message }),
          });
          resourceReads = 8;
          if (signal.aborted) throw error;
          view.note.textContent = error.message;
        }
        state.archiveSnapshot = { messages: [...archiveMessages(history)], incomplete: true };
        await persistConversation();
        view = assistantMessage(view);
        finishReason = '';
        continue;
      }
      if (request.kind === 'resource') {
        const ids = request.resourceIds || [request.resourceId];
        resourceReads += ids.length;
        view.body.replaceChildren(node('span', 'pending-message', 'Ressource · ' + request.workflowName));
        view.note.textContent = 'Consultation des références…';
        try {
          const response = await (
              await api('resources/read', request.resourceIds ? { ids } : { id: request.resourceId }, { signal })
            ).json(),
            selected = response.resources || [response];
          const metadata = selected.map(resource => ({
            id: resource.id,
            label: resource.label,
            name: resource.name,
            description: resource.description,
            type: resource.mime,
            width: resource.width,
            height: resource.height,
            duration: resource.duration,
            frameTimes: resource.frames.map(frame => frame.time),
          }));
          history.push({
            role: 'tool',
            tool_call_id: request.call.id,
            content: JSON.stringify({
              // Shown before a generation the model asked for: said first, so it is not taken for a result.
              ...(request.note ? { status: 'nothing_generated', message: request.note } : { status: 'loaded' }),
              resources: metadata,
              note: 'Pixels disponibles uniquement dans ce tour. Relire les ressources pour une comparaison visuelle ultérieure.',
            }),
          });
          for (const [index, resource] of selected.entries())
            if (!history.some(message => message.resourceId === resource.id))
              history.push({
                role: 'user',
                internal: true,
                resourceId: resource.id,
                content: [
                  {
                    type: 'text',
                    text:
                      'Référence visuelle ' +
                      JSON.stringify(metadata[index]) +
                      '. Les images suivantes appartiennent uniquement à cette référence. Copies temporaires pour ce tour ; pour une vidéo, images représentatives sans audio.',
                  },
                  ...resource.frames.map(frame => ({ type: 'image_url', image_url: { url: frame.url } })),
                ],
              });
          view.note.textContent =
            'Références consultées · ' + selected.map(resource => resource.label || resource.name).join(', ');
        } catch (error) {
          history.push({
            role: 'tool',
            tool_call_id: request.call.id,
            content: JSON.stringify({ status: 'error', message: error.message }),
          });
          resourceReads = 8;
          if (signal.aborted) throw error;
          view.note.textContent = error.message;
        }
        if (request.brief) {
          // The images were shown before a video not agreed on yet: the model now writes its plan.
          allowTools = false;
          resourceReads = 8;
          briefing = true;
        }
        state.archiveSnapshot = { messages: [...archiveMessages(history)], incomplete: true };
        await persistConversation();
        view = assistantMessage(view);
        finishReason = '';
        continue;
      }
      iterations++;
      view.generation = true;
      // A creation is set in the Studio: the pointer of Moodix AI sets it there and « Générer »
      // is the user's answer. Its card stays in the conversation.
      const viaStudio = Boolean(state.studio?.accepts?.(request.tool || request.call?.function?.name));
      const generation = generationUI.mount(view.generations, request, { compact: viaStudio });
      // A video is commented by the model only when the user chose it in the settings: the
      // reload and the analysis take about a minute. Otherwise it ends the turn, like an image.
      const review = state.generation?.reviewVideos === true;
      // Made from the Studio, the generator keeps its models for the next creation, and the chat
      // model comes back with the next message: unless it has a video to look at.
      const kept = viaStudio && !(review && request.mediaType === 'video');
      let result;
      try {
        result = await workflowsUI.requestTool(
          request,
          signal,
          (progress, fraction, preview) => {
            generation.progress(progress, fraction, preview);
            if (viaStudio) state.studio.follow(progress, fraction, preview);
            scrollToBottom();
          },
          image => generation.image(image),
          {
            review,
            ...(viaStudio
              ? {
                  approve: async (proposal, abort) => {
                    const answer = state.studio.propose(proposal, abort);
                    updateControls();
                    try {
                      return await answer;
                    } finally {
                      updateControls();
                    }
                  },
                  studio: kept,
                }
              : {}),
          },
        );
        generation.finish(result);
        if (viaStudio) void state.studio.settled(result);
      } catch (error) {
        if (viaStudio) void state.studio.settled({ error: signal.aborted ? 'Génération arrêtée.' : error.message });
        generation.fail(error.message);
        history.push({
          role: 'tool',
          tool_call_id: request.call.id,
          content: JSON.stringify(
            signal.aborted
              ? {
                  status: 'cancelled',
                  message:
                    'L’utilisateur a arrêté cette génération avant la fin : rien n’a été produit. S’il demande de recommencer, refais le même appel d’outil.',
                }
              : { status: 'error', message: error.message },
          ),
        });
        throw error;
      }
      history.push({ role: 'tool', tool_call_id: request.call.id, content: result.content });
      if (result.record || result.failed) state.status = await (await api('status')).json();
      if (kept && !result.denied) {
        // The creation is on the Studio's screen; the chat model stays unloaded until the next message.
        complete = true;
        break;
      }
      const reviewImages =
        review && result.record?.mediaType === 'video' && state.status.state === 'ready' && state.status.vision
          ? result.images
          : [];
      reviewRecord = reviewImages.length ? result.record : null;
      if (review && result.record?.mediaType === 'video') {
        history.push({
          role: 'user',
          internal: true,
          content: [
            {
              type: 'text',
              text: reviewImages.length
                ? (result.record.mediaType === 'video'
                    ? 'Vidéo : les images suivantes sont seulement des échantillons compressés horodatés (voir frame_times du résultat), sans audio. Elles ne prouvent pas la fluidité, le raccord temporel ni la dernière image exacte. Ne prétends pas avoir visionné toute la vidéo. Toute nouvelle génération nécessite sa propre confirmation utilisateur. '
                    : '') +
                  'Voici les copies réduites des sorties du workflow, dans le même ordre. Les originaux affichés à l’utilisateur ne font pas partie de ce contexte. Vérifie les indications reference_count, reference_capacity et reference_mode du résultat : elles décrivent les références réellement transmises au moteur de génération. reference_count décrit les références réellement fournies par Atelier ; reference_defaults décrit les entrées conservées du workflow. Zéro référence fournie ne prouve pas que le workflow est textuel. Respecte analysis_outputs pour associer les copies aux sorties ; ne prétends pas avoir vu une sortie sans copie. Pour comparer aux ressources pertinentes, consulte leurs images avec local_read_resource si elles ne sont pas présentes dans ce tour ; les descriptions seules ne suffisent pas. Décris les écarts de sujet, de composition, de couleurs et de détails, ainsi que les limites observées. Ne conclus pas à la fidélité ou à une fusion sans comparaison visuelle. Si une correction est utile et possible avec les entrées configurées, adapte ton prompt.'
                : state.status.vision
                  ? 'La génération est terminée, mais les copies pour l’analyse sont indisponibles. Signale que tu ne peux pas vérifier visuellement le résultat.'
                  : 'La génération est terminée. Tu ne disposes pas de la vision : indique que tu ne peux pas vérifier visuellement le résultat.',
            },
            ...reviewImages.map(url => ({ type: 'image_url', image_url: { url } })),
          ],
        });
      }
      if (result.denied) {
        // Refused in the confirmation window: the turn ends there, without an analysis of the
        // refusal. The model keeps it in its context for what the user asks next.
        complete = true;
        break;
      }
      if (result.failed && state.status.state !== 'ready')
        throw Error(result.error || 'L’image est disponible dans la galerie, mais le modèle n’a pas redémarré.');
      view.note.textContent = result.failed ? result.error || 'Analyse indisponible.' : '';
      if (result.denied || result.failed || iterations >= (state.generation?.maxIterations || 5)) allowTools = false;
      // After a refusal or a failure the model explains it: it does not go on inspecting outputs.
      if (result.denied || result.failed) resourceReads = 8;
      silent = Boolean(result.record && !(review && result.record.mediaType === 'video') && !result.failed);
      state.archiveSnapshot = { messages: [...archiveMessages(history)], incomplete: true };
      await persistConversation();
      view = assistantMessage(view);
      finishReason = '';
    }
  } catch (error) {
    const canceled = signal.aborted;
    if (output || reasoning || usedTool) {
      render();
      view.note.textContent = canceled ? 'Opération interrompue à votre demande.' : error.message;
      if (!canceled) view.note.classList.add('error');
    } else {
      userView.remove();
      view.article.remove();
      $('prompt').value = text + ($('prompt').value ? `\n\n${$('prompt').value}` : '');
      state.images = images;
      renderAttachments();
      $('welcome').hidden = state.messages.length > 0;
    }
    if (!canceled) notice(error.message || 'La connexion a été interrompue.');
  } finally {
    if (output || reasoning || usedTool) {
      if (output || reasoning) {
        render();
        if (!output) view.body.replaceChildren(node('div', 'text-block', 'Aucune réponse finale reçue.'));
        history.push({ role: 'assistant', content: output, ...(reasoning ? { reasoning_content: reasoning } : {}) });
      } else if (usedTool && !view.generation && !view.silent)
        view.body.replaceChildren(
          node('div', 'text-block', complete ? 'Aucune réponse finale reçue.' : 'Opération interrompue.'),
        );
      state.messages = archiveMessages(history);
      state.archiveSnapshot = { messages: [...archiveMessages(history)], incomplete: !complete };
      setConversationTitle(text || 'Une image à explorer');
    }
    await persistConversation();
    state.generating = false;
    state.waitingForModel = false;
    state.controller = null;
    endTurn();
    turnActions();
    resizePrompt();
    await refreshStatus();
    contextMeter.schedule();
    showLastReply();
    $('prompt').focus();
  }
}

function alignConversation() {
  if (typeof ResizeObserver !== 'function') return;
  const area = $('chat-area');
  const sync = () =>
    document.documentElement.style.setProperty(
      '--chat-scrollbar',
      Math.max(0, area.offsetWidth - area.clientWidth) + 'px',
    );
  new ResizeObserver(sync).observe(area);
  sync();
}

alignConversation();
setupMaterialLighting(document.querySelectorAll('.composer, .model-card'));

/**
 * While the chat is folded into its bar in the Studio, the bar tells what Moodix AI does: a light
 * runs along it while an answer is written, and it glows once an answer came unseen, until the
 * chat is opened.
 */
function showLastReply(streaming = '') {
  const bar = $('chat-bar'),
    folded = state.view === 'studio' && document.body.dataset.chat !== 'open';
  bar.classList.toggle('is-working', Boolean(streaming) && state.generating === true);
  if (streaming && folded) bar.dataset.unread = 'true';
}
/** What depends on the view: the switch between Chat and Studio, the context of the message box. */
function syncViews() {
  const studio = state.view === 'studio';
  $('composer-context').hidden = !studio;
  const label = studio ? 'Chat' : 'Studio';
  $('mode-switch').querySelector('.mode-switch-label').textContent = label;
  // The logo of the mode it goes to: MDX-CHAT from the Studio, MDX-STUDIO from the chat.
  const word = $('mode-switch').querySelector('.mode-word');
  word.setAttribute('viewBox', studio ? '0 0 472 100' : '0 0 618 100');
  word.querySelector('use').setAttribute('href', studio ? '#w-chat' : '#w-studio');
  $('mode-switch').setAttribute('aria-label', studio ? 'Revenir au chat' : 'Passer au Studio');
  $('mode-switch').title = studio ? 'Revenir au chat' : 'Passer au Studio';
}

/**
 * A creation made in the Studio, followed like those of the chat and written in the
 * conversation: a line for the model (the user made it by hand), its call and its result. The
 * conversation shows it as a card.
 */
async function runInStudio(proposal, { signal, onProgress }) {
  $('welcome').hidden = true;
  const view = assistantMessage();
  view.body.replaceChildren();
  view.generation = true;
  const generation = generationUI.mount(view.generations, proposal, { compact: true });
  let result;
  try {
    result = await workflowsUI.requestTool(
      proposal,
      signal,
      (progress, fraction, preview) => {
        generation.progress(progress, fraction, preview);
        onProgress(progress, fraction, preview);
      },
      image => generation.image(image),
      { confirmed: true, review: false, studio: true },
    );
    generation.finish(result);
  } catch (error) {
    view.article.remove();
    throw error;
  }
  // Nothing made, nothing to tell: the Studio says why.
  if (!result.record) {
    view.article.remove();
    return result;
  }
  const kinds = { image: 'Image', video: 'Vidéo', audio: 'Son' },
    prompt = String(proposal.plan?.prompt || proposal.args?.prompt || result.record.prompt || ''),
    said = `Studio · ${kinds[result.record.mediaType || 'image'] ?? 'Image'} : ${prompt}`.slice(0, 4000);
  // A conversation begun in the Studio still gets the global instructions with its first message.
  if (!state.messages.length) state.conversationInstructions ??= state.globalInstructions || '';
  state.messages = archiveMessages([
    ...state.messages,
    {
      role: 'user',
      internal: true,
      content: said + '\n\n(Créée dans le Studio : l’utilisateur a réglé et lancé cette génération lui-même.)',
    },
    { role: 'assistant', content: '', tool_calls: [proposal.call] },
    { role: 'tool', tool_call_id: proposal.call.id, content: result.content },
  ]);
  state.archiveSnapshot = { messages: [...state.messages], incomplete: false };
  if ($('conversation-title').textContent === 'Nouvelle conversation') setConversationTitle(said.slice(0, 120));
  turnActions();
  await persistConversation();
  contextMeter.schedule();
  return result;
}

const tokenControls = setupTokenControls($);
const computeControls = setupComputeControls($);
const helpTips = setupHelpTips($('settings'));
const settingsTabs = setupSettingsTabs({
  list: $('settings-tabs'),
  onShow: name => {
    helpTips.hide();
    $('settings-body').scrollTop = 0;
    if (name === 'update' && $('settings').open) {
      void checkComponents();
      void refreshToken();
    }
  },
});
const settingsSearch = setupSettingsSearch({
  dialog: $('settings'),
  input: $('settings-search'),
  empty: $('settings-empty'),
  scroller: $('settings-body'),
  onRefresh: searching => settingsTabs.matches(searching),
});
dismissSettingsOnOutsideClick($('settings'), () => requestSettingsClose());
const projectUI = setupProjectNavigation({
  $,
  state,
  node,
  icon,
  api,
  notice,
  openConversation: id => {
    requestSettingsClose(() => loadConversation(id));
  },
  newConversation: id => {
    requestSettingsClose(() => newConversation(id));
  },
  removeConversation: confirmHistoryDeletion,
  showHome,
  onBusy: () => updateControls(),
});
const assetsUI = setupAssets({
  api,
  state,
  node,
  icon,
  notice,
  onChange: () => contextMeter.schedule(),
  onBusy: () => updateControls(),
});
const actionButtons = outputActions({
  api,
  node,
  onDetails: (record, index) => assetsUI.viewOutput(record, index),
  onAction: (record, index, action) => runOutputAction(record, index, action),
});
const studioUI = setupStudio({
  api,
  node,
  icon,
  notice,
  assets: assetsUI,
  viewOutput: (record, index) => assetsUI.viewOutput(record, index),
  waitForModel: (...args) => waitForModel(...args),
  // A chat answer in progress keeps the model: the Studio waits for it.
  blocked: () =>
    state.generating || state.status.busy
      ? 'Attends la fin de la réponse en cours.'
      : state.preparing || state.loadingHistory || state.updating || state.closingApp
        ? 'Attends la fin de l’opération en cours.'
        : '',
  onChange: () => refreshStatus(),
  onRuns: (id, legacy) => {
    state.studioId = id;
    state.studioLegacy = legacy;
    if (state.view === 'studio') void showCreations();
  },
  conversation: () => state.conversationId,
  ensureConversation: async () => (state.conversationId ||= crypto.randomUUID()),
  run: runInStudio,
  reveal: () => closeChat().then(() => revealStudio()),
  stopTurn: () => state.controller?.abort(),
  onConversation: () => showLastReply(),
});
state.studio = studioUI;
const generationUI = setupGenerationUI({
  api,
  node,
  actions: actionButtons,
  openOutput: (record, index, blob) => assetsUI.viewOutput(record, index, blob),
  onResize: scrollToBottom,
  // « Ouvrir » on a card: the creation on the Studio's screen.
  onOpen: record => {
    void closeChat()
      .then(() => revealStudio())
      .then(() => record && studioUI.show(record));
  },
});
const workflowsUI = setupNativeWorkflows({
  api,
  state,
  node,
  notice,
  onRequestClose: () => requestSettingsClose(),
  openOutput: (record, index) => assetsUI.viewOutput(record, index),
  outputActions: actionButtons,
  // The « Créations » tab is drawn while the files panel is open, and as it opens.
  isShown: () => document.body.dataset.files === 'open',
  onOutput: () => {
    openFiles();
    assetsUI.show('output');
  },
  onChange: () => refreshStatus(),
  onSettingsBusyChange: busy => {
    state.generationSettingsWorking = busy;
    updateControls();
  },
  showTokenField: message => {
    settingsTabs.select('update');
    $('hf-token-status').textContent = message;
    $('hf-token').focus();
  },
  onHelpChange: target => helpTips.refresh(target),
});

const settingsGuard = setupSettingsGuard({
  dialog: $('settings'),
  confirmation: $('settings-unsaved'),
  keep: $('settings-keep'),
  discard: $('settings-discard'),
  saveButton: $('settings-save-close'),
  save: saveConfiguration,
  readDraft: () => ({
    llm: modelDraft(),
    fields: [
      'global-instructions',
      'engine-path',
      'context-size',
      'output-tokens',
      'compute-mode',
      'gpu-layers',
      'generation-enabled',
      'generation-auto',
      'generation-review',
      'generation-iterations',
      'generation-python',
      'native-convert-root',
      'generation-vae-root',
      'generation-lora-root',
    ].map(id => [
      id,
      id === 'generation-iterations' && $('generation-unlimited').getAttribute('aria-pressed') === 'true'
        ? null
        : $(id).value,
      $(id).checked,
    ]),
    unlimited: $('generation-unlimited').getAttribute('aria-pressed'),
    descriptions: workflowsUI.workflowDescriptions(),
    pending: workflowsUI.hasPendingImport?.() || false,
    editor: workflowsUI.editorDirty?.() || false,
  }),
});
const contextMeter = setupContextMeter({
  $,
  api,
  getConfig: () => state.config,
  isReady: () => state.connected && state.status.state === 'ready',
  isBusy: () => state.generating || !!state.status.toolJob,
  getRequest: () => {
    if (!state.messages.length) return null;
    // Counting needs the model's copies: make them from the originals, then count again.
    if (needsCopies(state.messages)) {
      const conversationId = state.conversationId;
      void fillCopies(state.messages, { api, conversationId })
        .then(() => conversationId === state.conversationId && contextMeter.schedule())
        .catch(() => {});
      return null;
    }
    return { ...chatRequest(state.messages), conversationId: state.conversationId };
  },
  getConversation: () => state.conversationId,
});
setupCopy($('messages'), {
  announce: message => {
    $('live-status').textContent = message;
    if (message.startsWith('Copie indisponible')) notice(message);
  },
});
applyTheme(document.documentElement.dataset.theme);
$('theme-toggle').onclick = toggleTheme;
$('history-clear').onclick = () => confirmHistoryDeletion();
$('history-delete-cancel').onclick = () => $('history-delete-dialog').close();
$('history-delete-confirm').onclick = clearHistory;
$('history-delete-dialog').addEventListener('cancel', event => {
  if (state.clearingHistory) event.preventDefault();
});
$('history-enabled').onchange = async () => {
  const enabled = $('history-enabled').checked;
  if ((await changePreferences({ saveHistory: enabled })) && enabled) {
    await persistConversation();
    if (state.conversationId) {
      state.loadingHistory = true;
      updateControls();
      try {
        await api('gallery/persist', { conversationId: state.conversationId });
      } catch (error) {
        notice(`Galerie non enregistrée : ${error.message}`);
      } finally {
        state.loadingHistory = false;
        updateControls();
      }
    }
  }
};
let filePickerController = null;
$('settings').addEventListener('close', () => {
  if ($('settings').open) return;
  state.studio?.invalidate?.({ tools: true });
  state.settingsSession = (state.settingsSession || 0) + 1;
  state.settingsLoading = false;
  state.settingsReady = false;
  settingsSearch.reset();
  filePickerController?.abort();
  workflowsUI.cancelSettings();
  updateControls();
});
for (const button of document.querySelectorAll('[data-file-kind]'))
  button.onclick = async () => {
    if (state.operation || button.disabled || !$('settings').open) return;
    const kind = button.dataset.fileKind,
      id = kind === 'engine' ? 'engine-path' : kind === 'model' ? 'model-path' : 'projector-path';
    const controller = new AbortController();
    filePickerController = controller;
    state.operation = true;
    $('config-error').hidden = true;
    updateControls();
    try {
      const result = await (
        await api('files/choose', { kind, initialPath: $(id).value }, { signal: controller.signal })
      ).json();
      if (!controller.signal.aborted && $('settings').open && result.path) $(id).value = result.path;
    } catch (error) {
      if (!controller.signal.aborted && $('settings').open) {
        $('config-error').textContent = error.message;
        $('config-error').hidden = false;
      }
    } finally {
      if (filePickerController === controller) {
        filePickerController = null;
        state.operation = false;
        updateControls();
      }
    }
  };
$('settings-open').onclick = openSettings;
$('detected-model').onchange = chooseDetectedModel;
$('add-llm').onclick = addLLM;
$('save-llm').onclick = () => saveLLM();
$('cancel-llm').onclick = cancelLLM;
$('remove-llm').onclick = removeLLM;
$('settings-update-check').onclick = searchUpdate;
$('settings-update-install').onclick = installUpdate;
$('components-check').onclick = () => checkComponents({ again: true });
$('hf-token-save').onclick = () => {
  const token = $('hf-token').value.trim();
  if (token) void saveToken(token);
  else $('hf-token-status').textContent = 'Collez d’abord un jeton.';
};
$('hf-token-remove').onclick = () => void saveToken('');
// Enter saves the token, not the whole settings form.
$('hf-token').addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  $('hf-token-save').click();
});
$('update-dialog').addEventListener('cancel', event => event.preventDefault());
$('shutdown-app').onclick = shutdownApplication;
$('restart-app').onclick = restartApplication;
$('settings-close').onclick = () => requestSettingsClose();
$('settings-form').onsubmit = event => {
  event.preventDefault();
  saveConfiguration();
};
$('toggle-engine').onclick = () => toggleEngine();
$('settings-stop').onclick = () => toggleEngine(true);
$('notice-close').onclick = () => notice('');
$('prompt').oninput = resizePrompt;
$('prompt').onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('chat-form').requestSubmit();
  }
};
$('chat-form').onsubmit = sendMessage;
$('cancel').onclick = () => {
  if (state.controller) state.controller.abort();
  else api('tools/cancel', { jobId: state.status.toolJob?.id }).catch(error => notice(error.message));
};
$('thinking').onclick = () => {
  state.thinking = !state.thinking;
  $('thinking').setAttribute('aria-pressed', String(state.thinking));
  contextMeter.schedule();
};
function closeNavigation() {
  const open = document.body.dataset.navOpen === 'true';
  document.body.dataset.navOpen = 'false';
  $('navigation-open').setAttribute('aria-expanded', 'false');
  // The focus left in the closed drawer goes back to the button that opens it.
  if (open && $('sidebar').contains?.(document.activeElement)) $('navigation-open').focus?.();
}
/** The « Créations » tab of the files panel follows the conversation, in the chat as in its Studio; the former Studio while its Sortie shows it. */
function showCreations() {
  const id = state.view === 'studio' && state.studioLegacy ? state.studioId : state.conversationId;
  return workflowsUI.renderGallery(id ?? null).catch(error => notice(`Galerie indisponible : ${error.message}`));
}
function openFiles(open = true) {
  if (!open) assetsUI.pause();
  const opening = open && document.body.dataset.files !== 'open';
  document.body.dataset.files = open ? 'open' : 'closed';
  $('all-files').setAttribute('aria-pressed', String(open));
  // Closed, its « Créations » tab was not kept up to date: it is drawn now.
  if (opening) void showCreations();
}
function showHome() {
  const blocked = () =>
    state.projectWorking ||
    state.status.toolJob ||
    state.status.busy ||
    state.generating ||
    state.preparing ||
    state.loadingHistory ||
    state.savingPreferences ||
    state.operation ||
    state.updating ||
    state.closingApp;
  if (blocked()) return;
  requestSettingsClose(async () => {
    if (blocked()) return;
    state.loadingHistory = true;
    updateControls();
    try {
      if (!(await assetsUI.flush()) || !(await persistConversation())) return;
      state.view = 'home';
      void showCreations();
      delete document.body.dataset.chat;
      closeNavigation();
      projectUI.render();
    } catch (error) {
      notice(error.message);
    } finally {
      state.loadingHistory = false;
      updateControls();
    }
  });
}
/**
 * The page moves in one movement, as quick as the screen of the Studio taking a new format: to the
 * Studio (`studio`) the chat folds into its bar while the Studio comes in, back to the chat
 * (`chat`) it unfolds from it; in the Studio the bar opens into the chat in the middle (`open`)
 * and the chat folds back into it (`close`). The browser's view transitions draw it, named in
 * moodix.css while `data-switch` is on the root. Without them, with reduced motion, or to and
 * from the home page, the page simply changes. Resolves once the page shows the change.
 */
function switchView(kind, apply) {
  const folding = kind === 'open' || kind === 'close',
    between = new Set([state.view, kind]),
    animate =
      typeof document.startViewTransition === 'function' &&
      (folding ? state.view === 'studio' : between.has('chat') && between.has('studio')) &&
      document.visibilityState === 'visible' &&
      !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!animate) {
    apply();
    return Promise.resolve();
  }
  const root = document.documentElement;
  root.dataset.switch = kind;
  const transition = document.startViewTransition(apply),
    end = () => {
      if (root.dataset.switch === kind) delete root.dataset.switch;
    };
  transition.finished.then(end, end);
  transition.ready.catch(() => {});
  return transition.updateCallbackDone;
}
/**
 * The Studio of the open conversation: its creation tools, beside its chat. Switching between
 * the two changes nothing of the conversation, so it is allowed even while an answer is written.
 * Resolves once it is on screen.
 */
function revealStudio() {
  const coming = state.view !== 'studio';
  return switchView('studio', () => {
    state.view = 'studio';
    closeNavigation();
    projectUI.render();
    syncViews();
    updateControls();
    showLastReply();
    if (coming) {
      void showCreations();
      void studioUI.open().catch(error => notice(error.message));
    }
  });
}
function showStudio() {
  if (state.updating || state.closingApp || state.loadingHistory) return;
  requestSettingsClose(() => revealStudio());
}
/** The chat of the open conversation (or of a new one). */
function showChat() {
  if (state.updating || state.closingApp || state.loadingHistory) return;
  requestSettingsClose(() => {
    const coming = state.view !== 'chat';
    void switchView('chat', () => {
      state.view = 'chat';
      delete document.body.dataset.chat;
      closeNavigation();
      projectUI.render();
      syncViews();
      updateControls();
      if (coming) void showCreations();
      // Back on its last lines at once: the chat grows back from the last answer, not from its top.
      state.stickToBottom = true;
      const area = $('chat-area');
      if (area.scrollTo) area.scrollTo({ top: area.scrollHeight, behavior: 'instant' });
      else scrollToBottom();
      $('prompt').focus();
    });
  });
}
/**
 * In the Studio the chat is folded into the bar at the bottom. Opened, it comes over everything,
 * in the middle of the window, on its last lines. Resolves once the page shows it.
 */
function openChat() {
  if (state.view !== 'studio' || document.body.dataset.chat === 'open') return Promise.resolve();
  return switchView('open', () => {
    document.body.dataset.chat = 'open';
    delete $('chat-bar').dataset.unread;
    const area = $('chat-area');
    if (area.scrollTo) area.scrollTo({ top: area.scrollHeight, behavior: 'instant' });
    $('prompt').focus({ preventScroll: true });
  });
}
/**
 * The chat folds back into its bar: Moodix AI sets the Studio, or Échap, or a click beside it
 * (`refocus`: the keyboard goes back to the bar).
 */
function closeChat({ refocus = false } = {}) {
  if (document.body.dataset.chat !== 'open') return Promise.resolve();
  return switchView('close', () => {
    delete document.body.dataset.chat;
    if (refocus) $('chat-bar').focus({ preventScroll: true });
  });
}
$('chat-bar').onclick = () => void openChat();
$('chat-scrim').onclick = () => void closeChat({ refocus: true });
$('studio-open').onclick = () => showStudio();
$('chat-open').onclick = () => showChat();
$('mode-switch').onclick = () => (state.view === 'studio' ? showChat() : showStudio());
async function newConversation(projectId = state.projectId || 'inbox') {
  if (state.projectWorking || state.status.toolJob || state.generating || state.preparing || state.loadingHistory)
    return;
  state.loadingHistory = true;
  updateControls();
  try {
    // A conversation that cannot be saved must not trap the user in it.
    if (
      !(await persistConversation()) &&
      !confirm('Cette conversation n’a pas pu être enregistrée. En commencer une nouvelle quand même ?')
    )
      return;
    if (
      !state.saveHistory &&
      state.messages.length &&
      !confirm('Recommencer effacera cette conversation de la page. Continuer ?')
    )
      return;
    state.projectId = typeof projectId === 'string' ? projectId : 'inbox';
    if (state.view !== 'studio') state.view = 'chat';
    closeNavigation();
    state.messages = [];
    state.images = [];
    state.videos = [];
    state.conversationId = null;
    state.conversationInstructions = null;
    state.archiveSnapshot = null;
    state.historyDirty = false;
    $('prompt').value = '';
    workflowsUI.reset();
    generationUI.clear();
    $('messages').replaceChildren();
    $('welcome').hidden = false;
    setConversationTitle('Nouvelle conversation');
    renderAttachments();
    notice('');
    resizePrompt();
    state.studio?.conversationChanged?.();
    showLastReply();
  } finally {
    state.loadingHistory = false;
    updateControls();
    contextMeter.schedule();
    $('prompt').focus();
  }
}
$('new-chat').onclick = () => newConversation();
$('new-chat-mobile').onclick = () => newConversation();
$('all-files').onclick = () => openFiles(document.body.dataset.files !== 'open');
$('assets-close').onclick = () => openFiles(false);
$('navigation-open').onclick = () => {
  const open = document.body.dataset.navOpen !== 'true';
  document.body.dataset.navOpen = String(open);
  $('navigation-open').setAttribute('aria-expanded', String(open));
  if (open) $('navigation-close').focus();
};
$('navigation-close').onclick = () => closeNavigation();
$('navigation-scrim').onclick = () => closeNavigation();
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.body.dataset.navOpen === 'true' && !document.querySelector('dialog[open]'))
    closeNavigation();
  // The chat opened over the Studio folds back into its bar.
  else if (
    event.key === 'Escape' &&
    document.body.dataset.chat === 'open' &&
    !event.defaultPrevented &&
    !document.querySelector('dialog[open]')
  )
    void closeChat({ refocus: true });
});
document.querySelectorAll('[data-prompt]').forEach(button => {
  button.onclick = () => {
    $('prompt').value = button.dataset.prompt;
    resizePrompt();
    $('prompt').focus();
  };
});
function chooseImage() {
  if (!state.config.projectorPath) {
    notice('Ajoutez un projecteur de vision dans Configuration pour joindre des images.');
    openSettings();
  } else $('image-input').click();
}
// Images need the vision projector (checked when they are added); videos go to the library.
$('attach').onclick = () => $('image-input').click();
$('suggest-image').onclick = chooseImage;
$('image-input').onchange = event => {
  const files = [...event.target.files];
  event.target.value = '';
  addFiles(files);
};
$('prompt').onpaste = event => {
  const files = [...event.clipboardData.files];
  if (files.length) {
    event.preventDefault();
    addFiles(files);
  }
};
$('chat-form').ondragover = event => {
  event.preventDefault();
  $('chat-form').classList.add('dragging');
};
$('chat-form').ondragleave = event => {
  if (!$('chat-form').contains(event.relatedTarget)) $('chat-form').classList.remove('dragging');
};
$('chat-form').ondrop = event => {
  event.preventDefault();
  $('chat-form').classList.remove('dragging');
  addFiles([...event.dataTransfer.files]);
};
document.addEventListener('dragover', event => event.preventDefault());
document.addEventListener('drop', event => event.preventDefault());
$('chat-area').onscroll = () => {
  const area = $('chat-area');
  state.stickToBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 100;
};
window.addEventListener('beforeunload', event => {
  if (state.updateReload) return;
  if (
    assetsUI.hasDraft() ||
    state.resourceWorking ||
    settingsGuard.isDirty() ||
    state.generating ||
    state.savingHistory ||
    state.historyDirty ||
    $('prompt').value.trim() ||
    state.images.length ||
    state.videos.length ||
    (!state.saveHistory && state.messages.length)
  ) {
    event.preventDefault();
    event.returnValue = '';
  }
});

try {
  const response = await fetch('/api/bootstrap');
  if (!response.ok) throw new Error('Impossible de joindre le serveur local.');
  const initial = await response.json();
  Object.assign(state, {
    token: initial.token,
    config: initial.config,
    globalInstructions: initial.instructions || '',
    models: initial.models || [],
    modelName: initial.modelName || '',
    status: initial.status,
    connected: true,
  });
  tokenKnown();
  if (initial.version) $('settings-version').textContent = 'Atelier ' + initial.version;
  void checkUpdates();
  applyTheme(initial.preferences?.theme);
  state.saveHistory = initial.preferences?.saveHistory === true;
  await projectUI.refresh().catch(error => notice('Projets indisponibles : ' + error.message));
  await refreshHistory();
  await assetsUI.refresh().catch(error => notice('Bibliothèque indisponible : ' + error.message));
  await workflowsUI.refresh();
  await restoreUpdate();
  syncViews();
  showLastReply();
  if (initial.warning) notice(initial.warning);
  contextMeter.schedule();
  updateControls();
} catch (error) {
  // Nothing is left waiting: each action then says itself what it could not do.
  tokenKnown();
  notice(error.message);
  updateControls();
}
setInterval(() => {
  if (!document.hidden) refreshStatus();
}, 1200);
document.addEventListener('visibilitychange', () => {
  document.documentElement.dataset.pageHidden = String(document.hidden);
  if (!document.hidden) refreshStatus();
});
