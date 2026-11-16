import { refreshLight, showTakeReady } from './room.mjs';
import { withReference, withoutReference } from './reference-tokens.mjs';
import { markReferences, removedNotice, setupReferencePeek, setupReferencePicker } from './reference-picker.mjs';
import { setupUnexpectedErrors } from './unexpected-errors.mjs';
import { setupLibrary } from './library.mjs';

/** The title of a conversation before its first message gives it one (« Nouveau chat » from 0.5.109 to
 * 0.5.129, the words of the fil again since 0.6.0). */
const UNTITLED = 'Nouvelle conversation';
const untitled = title => title === UNTITLED || title === 'Nouveau chat';
import { setupProjectNavigation } from './project-navigation.mjs';
import { setupSettingsSearch } from './settings-search.mjs';
import { setupSettingsTabs } from './settings-tabs.mjs';
import { setupInterfaceSettings } from './interface-settings.mjs';
import { setupHelpTips } from './help-tips.mjs';
import { setupGenerationUI } from './generation-ui.mjs';
import { setupAssets } from './assets-ui.mjs';
import { setupCopy } from './copy.mjs';
import { STUDIO_NOTE, callNote, conversationTitle, lastExchange, spokenText } from './transcript.mjs';
import { setupSettingsGuard } from './settings-guard.mjs';
import { setupContextMeter } from './context-meter.mjs';
import { installFromButton, compactSession } from './update-ui.mjs';
import { readSSE } from './stream.mjs';
import { markdownToHtml } from './markdown.mjs';
import { setupNativeWorkflows } from './native-workflow-ui.mjs';
import { prepareImages } from './images.mjs';
import { isVideo, splitVideos, withVideos } from './chat-videos.mjs';
import { setupStudio } from './studio.mjs';
import { proposalCard } from './proposal-card.mjs';
import { setupTokenControls, setupComputeControls, dismissSettingsOnOutsideClick } from './settings-controls.mjs';
import { waitForModel } from './model-ready.mjs';
import { setupFirstLaunch } from './first-launch.mjs';
import { missingFileCard } from './missing-file.mjs';
import { outputActions } from './output-actions.mjs';
import { fillCopies, forgetCopies, needsCopies, rememberCopy, remakeOutputCopy, withoutCopies } from './session-copies.mjs';

const $ = id => document.getElementById(id);
const state = {
  view: 'chat',
  // The project the Pellicule shows ('all': every one).
  libraryProject: 'all',
  studioId: null,
  projectId: 'inbox',
  projects: [{ id: 'inbox', name: 'Conversations' }],
  projectWorking: false,
  token: '',
  // The version of the application this page is the code of (bootstrap).
  version: '',
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

// The mark of Moodix AI (claude_design/maquettes/logo.md, Éclipse): a sphere in the dark, lit from
// below, and the light ring that draws the rest of it. While the model thinks it breathes: the shadow
// withdraws to the middle and the white fills the sphere, then the shadow comes back from the middle
// (its pace is in moodix.css). Each mark has a mask of its own, so that each breathes alone.
let eclipseCount = 0;
function moodixMark() {
  const id = `eclipse-${++eclipseCount}`,
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'eclipse');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="-8" y="-8" width="48" height="48">` +
    '<rect x="-8" y="-8" width="48" height="48" fill="#000"/><circle cx="16" cy="16" r="12.5" fill="#fff"/>' +
    '<circle class="eclipse-shadow" cx="16" cy="11.6" r="11.4" fill="#000"/></mask></defs>' +
    '<circle class="eclipse-ring" cx="16" cy="16" r="12.5"/>' +
    `<circle class="eclipse-sphere" cx="16" cy="16" r="12.5" mask="url(#${id})"/>`;
  return [svg];
}
/**
 * How long the model thought, said in its summary (« Réflexion · 4 s »): from its first thought to
 * the first words of its answer (or the end of the turn, `done`).
 */
function thoughtFor(view, reasoning, output, done = false) {
  if (!reasoning) return;
  view.thoughtFrom ??= performance.now();
  if ((output || done) && view.thoughtSeconds === undefined) {
    view.thoughtSeconds = Math.max(1, Math.round((performance.now() - view.thoughtFrom) / 1000));
    const label = view.summary?.querySelector?.('.reasoning-label');
    if (label) label.textContent = `Réflexion · ${view.thoughtSeconds}\u00a0s`;
  }
}
/** The mark of a reply moves while its model thinks: reasoning has come, the answer not yet. */
function markThinking(view, thinking) {
  view.article.querySelector('.message-avatar')?.classList.toggle('is-thinking', thinking);
}
/**
 * A message sent while the model loads (etats-maquette.md, 51): beside « MOODIX », « LE MODÈLE SE
 * CHARGE · 0:42 », the time gone by; under it, what happens. Failed, the same line says why in
 * amber, with « Réessayer ».
 */
function modelLoading(view) {
  const label = node('span', 'message-loading'),
    line = node('p', 'message-waiting');
  let timer = null,
    since = 0;
  const tick = () => {
    const seconds = Math.floor((performance.now() - since) / 1000);
    label.textContent = `Le modèle se charge · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  return {
    show() {
      if (timer) return;
      since = performance.now();
      tick();
      timer = setInterval(tick, 1000);
      view.article.querySelector('.message-header')?.append(label);
      line.textContent =
        'Votre message partira dès que Moodix AI sera prêt. Le premier chargement peut prendre quelques minutes.';
      view.body.replaceChildren(line);
    },
    stop() {
      clearInterval(timer);
      timer = null;
      label.remove();
      line.remove();
    },
    fail(message, retry) {
      const again = node('button', 'text-button message-retry', 'Réessayer');
      again.type = 'button';
      again.onclick = retry;
      line.className = 'message-waiting is-failed';
      line.setAttribute('role', 'alert');
      line.replaceChildren(node('span', '', message), again);
      view.body.replaceChildren(line);
    },
  };
}

function notice(message) {
  $('notice-text').textContent = message;
  $('notice').hidden = !message;
}

// The page learns its token from its first request, which takes up to several seconds while the
// model loads. Everything is already on screen: an action clicked meanwhile waits for the token
// instead of being refused (« Accès refusé. Rechargez la page. »).
let tokenKnown;
const pageReady = new Promise(resolve => {
  tokenKnown = resolve;
});
async function api(route, body, options = {}) {
  await pageReady;
  const { raw = false, headers: extraHeaders = {}, again = false, ...requestOptions } = options;
  const used = state.token;
  const response = await fetch(`/api/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${used}`,
      'Content-Type': raw ? 'application/octet-stream' : 'application/json',
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
    ...requestOptions,
  });
  // Refused with the key this page had: the server was started again with the page open. With its
  // new key (taken meanwhile by another request, or now), the same request once more. An update
  // or « Redémarrer » of this page reloads it by itself.
  if (
    response.status === 401 &&
    !again &&
    !state.updating &&
    !state.closingApp &&
    (used !== state.token || (await serverRestarted()))
  )
    return api(route, body, { ...options, again: true });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || `La requête a échoué (${response.status}).`), {
      status: response.status,
      // Busy for a moment: worth asking again (see installFromButton).
      busy: data.busy === true,
    });
  }
  return response;
}

/**
 * A request refused (401) with the key of this page: the server was started again with the page
 * open (the launcher, an update, a relaunch) and drew a new key (0.5.128). Of the same version, the
 * page takes the new key and goes on: the addresses of the media keep theirs (server.mjs). Of
 * another version, its code is old: it reloads, its draft and its conversation kept in this tab for
 * the page that replaces it (resumeAfterRestart). False when the key has not changed: the refusal
 * is real. Several refused requests share one question to the server.
 */
let restarting = null;
function serverRestarted() {
  restarting ??= (async () => {
    try {
      const next = await (
        await fetch('/api/bootstrap?brief=1', { cache: 'no-store', signal: AbortSignal.timeout(4000) })
      ).json();
      if (!next?.token || next.token === state.token || next.updating) return false;
      if (!state.version || next.version === state.version) {
        state.token = next.token;
        return true;
      }
      keepForReload();
      state.updateReload = true;
      location.reload();
      // The page goes: what asked waits for nothing more.
      return new Promise(() => {});
    } catch {
      return false;
    }
  })().finally(() => {
    restarting = null;
  });
  return restarting;
}
const RESUME = 'moodix.reprise';
/**
 * What the page replacing this one takes back: the draft (its words, its images, its videos), the
 * conversation (its messages when the history does not have them: history off, or not saved yet),
 * the view. Kept in this tab only; less of it when it does not fit (the images, then the messages).
 */
function keepForReload() {
  const saved = state.historyItems?.some(item => item.id === state.conversationId) && !state.historyDirty;
  const kept = {
    conversationId: state.conversationId,
    ...(saved
      ? {}
      : {
          messages: state.messages,
          archiveSnapshot: state.archiveSnapshot,
          conversationInstructions: state.conversationInstructions,
        }),
    prompt: $('prompt').value,
    // Without the files given (they are not written): their copy, as after « Redémarrer ».
    images: (state.images || []).map(({ source, ...image }) => image),
    videos: state.videos || [],
    thinking: state.thinking,
    title: $('conversation-title').textContent,
    view: state.view,
  };
  for (const less of [kept, { ...kept, images: [] }, { ...kept, images: [], messages: [], archiveSnapshot: null }])
    try {
      sessionStorage.setItem(RESUME, JSON.stringify(less));
      return;
    } catch {
      // Too large for the tab: less of it.
    }
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

/** The conversation open last, kept by the browser: its project is the one of the next launch. */
const LAST_CONVERSATION = 'moodix.lastConversation';
function rememberConversation(id) {
  try {
    if (id) localStorage.setItem(LAST_CONVERSATION, id);
    else localStorage.removeItem(LAST_CONVERSATION);
  } catch {
    // Without the browser's storage, the next launch is in « Sans projet ».
  }
}
/**
 * At launch, the welcome (direction-artistique.md), in the project used last: that of the
 * conversation open last; « Reprendre » opens it again. After « Redémarrer » or an update, the
 * conversation and its draft are taken back instead (restoreUpdate, resumeAfterRestart).
 */
function welcomeInLastProject() {
  if (state.conversationId || state.messages.length) return;
  let id = null;
  try {
    id = localStorage.getItem(LAST_CONVERSATION);
  } catch {
    // Unreadable: « Sans projet ».
  }
  const project = state.historyItems.find(item => item.id === id)?.projectId;
  if (project && state.projects?.some(item => item.id === project)) state.projectId = project;
  projectUI.render();
}

function persistConversation() {
  const snapshot = state.archiveSnapshot || { messages: state.messages, incomplete: false };
  if (!state.saveHistory || state.disablingHistory || !snapshot.messages.length) return Promise.resolve(true);
  const projectId = state.projectId || 'inbox';
  const id = (state.conversationId ||= crypto.randomUUID());
  rememberConversation(id);
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
      generationUI.clear();
      $('messages').replaceChildren();
      $('welcome').hidden = false;
      setConversationTitle(UNTITLED);
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
    rememberConversation(id);
    state.conversationInstructions = record.instructions || '';
    state.messages = messages;
    state.projectId = record.projectId || 'inbox';
    // Chat and Studio are two views of the same conversation: the one on screen stays.
    if (state.view !== 'studio') state.view = 'chat';
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
          // The character Moodix AI made for a replacement: its image first, as it was shown.
          if (typeof data?.character_image?.output === 'string')
            generationUI.restore(view.generations, state.conversationId, data.character_image.output, { compact: true });
          if (data?.run_id) {
            if (!text) view.body.replaceChildren();
            generationUI.restore(view.generations, state.conversationId, data.run_id, { compact: data.studio === true });
          }
          // « Annuler » of a card: its line, where the card was (16/11); declined otherwise, nothing.
          if (data?.status === 'denied' && data.cancelled === 'card')
            view.generations.append(node('p', 'proposal-cancelled', 'Proposition annulée.'));
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
  restoreSession(saved);
  await api('updates/session/clear', {});
  if (saved.restarted) {
    $('live-status').textContent = 'Application redémarrée. Conversation restaurée.';
    return;
  }
  const result = await (await api('updates/install')).json();
  if (result.state === 'rolled-back' || result.state === 'error') notice(result.error);
  else returnBand();
}
/**
 * Back after an update (etats-maquette.md, 57): a band of glass under the top bar, a green dot
 * and what came back; it fades after 4 s. The only band of the application.
 */
function returnBand() {
  const band = $('return-band');
  $('return-text').replaceChildren(
    node('strong', '', 'Moodix ' + state.version),
    node('span', 'return-what', ' · conversation et brouillon restaurés'),
  );
  band.hidden = false;
  band.classList.remove('is-leaving');
  clearTimeout(state.returnTimer);
  state.returnTimer = setTimeout(() => {
    band.classList.add('is-leaving');
    state.returnTimer = setTimeout(() => {
      band.hidden = true;
    }, 400);
  }, 4000);
}

/** A conversation and its draft as a page kept them (an update, « Redémarrer », another version). */
function restoreSession(saved) {
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
  setConversationTitle(saved.title || UNTITLED);
  const restored = state.historyItems.find(item => item.id === state.conversationId);
  state.projectId = restored?.projectId || 'inbox';
  state.view = 'chat';
  renderAttachments();
  resizePrompt();
  renderHistory();
  scrollToBottom();
  contextMeter.schedule();
}

/**
 * At launch: what a page of an older version kept in this tab before reloading (keepForReload,
 * 0.5.128): its conversation (from the history, or its messages), its draft and its view.
 */
async function resumeAfterRestart() {
  let kept = null;
  try {
    kept = JSON.parse(sessionStorage.getItem(RESUME) || 'null');
    sessionStorage.removeItem(RESUME);
  } catch {
    // Unreadable: nothing to take back.
  }
  // Taken back by the server already (an update, « Redémarrer »).
  if (!kept || state.conversationId) return;
  if (kept.messages?.length)
    restoreSession({ ...kept, archiveSnapshot: kept.archiveSnapshot ?? null, images: kept.images || [] });
  else if (kept.conversationId && state.historyItems.some(item => item.id === kept.conversationId))
    await loadConversation(kept.conversationId);
  $('prompt').value = kept.prompt || '';
  state.images = kept.images || [];
  state.videos = kept.videos || [];
  state.thinking = kept.thinking !== false;
  $('thinking').setAttribute('aria-pressed', String(state.thinking));
  renderAttachments();
  resizePrompt();
  returnBand();
  if (kept.view === 'studio') showStudio();
  else if (kept.view === 'library') showLibrary();
}

async function installUpdate({ confirmed = false } = {}) {
  // Unsaved settings are saved or let go first; then the update goes on, never dropped in silence.
  if (settingsGuard.isDirty()) return requestSettingsClose(() => installUpdate({ confirmed: true }));
  if (state.updating || state.closingApp || (!confirmed && $('settings-update-install').disabled)) return;
  state.updating = true;
  updateControls();
  $('settings').close();
  updatePanel('download');
  if (!$('update-dialog').open) $('update-dialog').showModal();
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
      onProgress: (text, step) => updatePanel(step, text),
      reload: () => {
        state.updateReload = true;
        location.reload();
      },
    });
  } catch (error) {
    state.updating = false;
    state.updateReload = false;
    // In the same panel (56): what failed in amber, and « Réessayer »; Échap or a click beside closes it.
    updatePanel('failed', error.message);
    await refreshStatus();
  }
}
/**
 * The panel of an update (etats-maquette.md, 56): the Éclipse that breathes, « Mise à jour vers
 * 0.6.20 », three steps (download, install, restart) and a line; nothing to press while it
 * installs. `step`: the one under way, or 'failed' with the reason (`text`).
 */
function updatePanel(step, text = '') {
  const panel = $('update-dialog'),
    order = ['download', 'install', 'restart'],
    at = order.indexOf(step),
    failed = step === 'failed';
  panel.dataset.mode = 'update';
  panel.classList.toggle('is-failed', failed);
  $('update-title').textContent = state.updateVersion ? 'Mise à jour vers ' + state.updateVersion : 'Mise à jour';
  if (!$('update-mark').firstChild) $('update-mark').append(...moodixMark());
  $('update-mark').classList.toggle('is-thinking', !failed);
  if (!failed) panel.dataset.step = String(Math.max(0, at));
  for (const item of $('update-steps').children) {
    const place = order.indexOf(item.dataset.step),
      now = Number(panel.dataset.step || 0);
    // Failed: the step it stopped at in amber, none « en cours » (56).
    item.className = place < now ? 'is-done' : place === now ? (failed ? 'is-failed' : 'is-current') : '';
  }
  // A server busy for a moment says so in place of the sentence; the sentence otherwise.
  $('update-progress').textContent = /démarrera ensuite\.$/.test(text)
    ? text
    : 'Votre conversation et votre brouillon seront restaurés. Moodix revient tout seul dans un instant.';
  $('update-progress').hidden = failed;
  $('update-failure').hidden = !failed;
  $('update-failure-text').textContent = failed ? text : '';
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

let firstLaunch = null;
/** The card of the first launch, made once: its steps save the engine and the LLM as Paramètres does. */
function firstLaunchCard() {
  firstLaunch ??= setupFirstLaunch({
    api,
    node,
    icon,
    host: $('setup-card'),
    config: () => state.config,
    onConfig: (config, models) => {
      state.config = config;
      if (models) state.models = models;
      updateControls();
    },
    // Both steps done: the message box comes back and the model loads.
    onDone: () => {
      api('start', {})
        .then(response => response.json())
        .then(status => {
          state.status = status;
          updateControls();
          $('prompt').focus();
        })
        .catch(error => notice(error.message));
    },
  });
  return firstLaunch;
}
function updateControls() {
  const s = state.status;
  projectUI.sync();
  // Never held by what the page believes: a flag left set by mistake must not lock updates for
  // good. The server refuses while it is busy, and the page asks again (installFromButton).
  $('settings-update-install').disabled = state.updating || state.closingApp || !state.connected;
  const toolBusy = !!s.toolJob;
  // A generation runs (the model's answer or a take): the room stops its grain, so that the page
  // takes nothing from the GPU while it works (moodix.css, part 4).
  document.documentElement.dataset.generating = String(Boolean(state.generating || toolBusy));
  // The card held by the last generation: « Libérer le GPU » where it is seen (the composer, the
  // Studio drawn again when that changes).
  const held = Boolean(s.toolJob?.blocked);
  $('composer-recover').hidden = !held;
  // Its only action then is « Libérer le GPU » (54): a take that failed waits for it.
  document.documentElement.dataset.gpuHeld = String(held);
  if (held !== Boolean(state.gpuHeld)) {
    state.gpuHeld = held;
    state.studio?.render?.();
  }
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
      ? held
        ? 'Modèle en pause : la carte graphique est encore prise'
        : 'Modèle en pause pendant la génération · il redémarre ensuite'
      : s.state === 'loading'
        ? 'Le modèle se charge…'
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
  // One icon whatever the state (⏻): the dot beside it says it (moodix.css, engine-button::after).
  $('toggle-engine').replaceChildren(icon('power'));
  // The capsule of the top bar names the model beside its switch (0.6.0).
  const model = (state.models || []).find(item => item.modelPath === state.config.modelPath);
  $('engine-name').textContent =
    model?.name ||
    (state.config.modelPath ? state.config.modelPath.split(/[\\/]/).pop().replace(/\.gguf$/i, '') : 'Aucun LLM');
  // A proposal waits (in the Studio, or in a card of the conversation): a new message declines it.
  const proposing = Boolean(state.studio?.proposing?.() || state.proposalCard);
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
  // Interrompre only while something runs: Moodix thinking or writing, a generation (16/11). A
  // proposal waiting for the user (a card, the Studio) runs nothing: a new message declines it.
  $('cancel').hidden = proposing || (!state.generating && (!toolBusy || s.toolJob.blocked));
  const cancelLabel = state.waitingForModel ? 'Annuler le message en attente' : 'Interrompre la réponse';
  // The model loading under a message sent: « EN ATTENTE » and « Annuler », in words (51).
  $('cancel').classList.toggle('is-word', Boolean(state.waitingForModel));
  // Before the first message (etats-maquette.md, 50): no engine or no LLM, the card in place of
  // the message box, without shortcuts nor « Reprendre ».
  if (state.booted) {
    const setup = !(state.config.enginePath && state.config.modelPath);
    document.body.dataset.setup = setup ? 'incomplete' : 'done';
    firstLaunchCard().sync(setup);
  }
  $('cancel').setAttribute('aria-label', cancelLabel);
  $('cancel').title = cancelLabel;
  $('thinking').disabled = state.generating;
  // A card of Moodix waits: an image may go with the message that answers it.
  $('attach').disabled = (state.generating && !state.proposalCard) || state.preparing || state.loadingHistory;
  $('prompt').disabled = state.loadingHistory;
  $('compose-state').textContent = state.proposalCard
    ? ''
    : held
    ? ''
    : proposing
    ? 'Proposition dans le Studio · un message la refuse'
    : toolBusy
    ? Number.isFinite(s.toolJob.fraction)
      ? Math.floor(Math.min(1, Math.max(0, s.toolJob.fraction)) * 100) + '\u202f%'
      : s.toolJob.progress || 'Génération en cours…'
    : state.preparing
      ? 'Préparation des images…'
      : state.waitingForModel
        ? 'En attente'
        : state.generating
          ? 'Réponse en cours…'
          : s.state === 'loading'
            ? 'Le modèle se charge…'
            : '';
  $('compose-state').classList.toggle('is-waiting', $('compose-state').textContent === 'En attente');
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
  if (
    state.llmListKey &&
    state.llmListKey !== [$('detected-model').disabled, !!state.modelAdding, $('detected-model').value, (state.detectedModels || []).length].join('|')
  )
    renderLLMList();
}

/** Whether `version` (x.y.z) is newer than the one installed: an update is offered only then. */
function newerThanInstalled(version) {
  const parts = value => (/^\d+\.\d+\.\d+$/.test(String(value ?? '')) ? String(value).split('.').map(Number) : null),
    next = parts(version),
    installed = parts(state.version);
  if (!next || !installed) return false;
  for (let index = 0; index < 3; index++) if (next[index] !== installed[index]) return next[index] > installed[index];
  return false;
}

/**
 * Updates live in the first tab of the settings. The server looks for one at launch; when it
 * finds one, the settings button and the tab wear a dot, and the tab offers to install it.
 */
async function checkUpdates({ refresh = false } = {}) {
  try {
    const update = await (await api(refresh ? 'updates?refresh=1' : 'updates')).json();
    // Offered only when newer than the version installed (16/11): no box, no dot otherwise.
    state.updateAvailable = update.available === true && newerThanInstalled(update.version);
    state.updateVersion = state.updateAvailable ? update.version : '';
    // Under « Version installée » (capture 48): when it was looked for, at the launch or since.
    const at = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    $('settings-update-checked').textContent = (refresh ? 'Vérifié aujourd’hui à ' : 'Vérifié au lancement, aujourd’hui à ') + at + '.';
    $('settings-update-status').textContent = state.updateAvailable ? 'La version ' + update.version + ' est disponible' : '';
    $('settings-update-offer').hidden = !state.updateAvailable;
    $('settings-update-install').hidden = !state.updateAvailable;
    $('settings-update-install').textContent = 'Installer';
    $('settings-update-install').setAttribute('aria-label', state.updateAvailable ? 'Installer la version ' + update.version : 'Installer');
    const opener = $('settings-open');
    opener.classList.toggle('has-update', state.updateAvailable);
    const label = state.updateAvailable ? 'Paramètres · une mise à jour est disponible' : 'Paramètres';
    opener.setAttribute('aria-label', label);
    opener.title = label;
    settingsTabs.mark('update', state.updateAvailable);
    if (refresh) $('live-status').textContent = state.updateAvailable ? 'Mise à jour disponible.' : 'Aucune mise à jour trouvée.';
  } catch {
    // Offline: said under the version, quietly (nothing else changes).
    $('settings-update-checked').textContent = 'Vérification impossible pour l’instant (hors ligne ?).';
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
    // Just installed (followLlama): what was done stays said, in place of « À jour ».
    const done = state.llamaDone;
    state.llamaDone = '';
    text.textContent = done || 'Recherche de la version officielle pour cet ordinateur…';
    go.hidden = true;
    const offer = await (await api('llama/check', {})).json(),
      best = offer.candidates[0];
    if (!best) {
      text.textContent = 'llama.cpp ne publie aucune version pour ce système.';
      return;
    }
    const upToDate = job.ours && current === offer.tag;
    text.textContent = upToDate
      ? done || `À jour : version officielle ${offer.tag}.`
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
        // Said again by showLlama once the list is drawn anew with the version now in use.
        state.llamaDone = text.textContent =
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
  $('components-status').textContent = 'Lecture des versions…';
  try {
    // Versions read for an earlier opening are still true: they are shown all the same.
    const result = await (await api('components')).json();
    $('settings-version').textContent = result.version;
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
  }
}

let statusRefreshing = false;
async function refreshStatus() {
  if (statusRefreshing || state.updating || state.closingApp) return;
  statusRefreshing = true;
  try {
    const previous = state.status.state;
    const runnerBefore = state.status.runner?.state;
    const wasConnected = state.connected;
    const jobBefore = state.status.toolJob?.id;
    // The server was out of reach: back, it may be another one (restarted, a new key). The key is
    // asked for first, so that the question is not refused (0.5.128).
    if (!wasConnected && state.token) await serverRestarted();
    state.status = await (await api('status', undefined, { signal: AbortSignal.timeout(5000) })).json();
    workflowsUI.updateRunner?.(state.status.runner);
    // A generation has just ended: the room takes the light of the new take (room.mjs).
    if (jobBefore && state.status.toolJob?.id !== jobBefore) state.onTakeDone?.();
    // The generation engine has just become ready: the Studio reads again what it offers.
    if (state.status.runner?.state === 'ready' && runnerBefore !== 'ready') {
      state.studio?.invalidate?.({ tools: true });
      void state.studio?.prefetch?.();
    }
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
  renderLLMList();
}
/**
 * « Vos LLM » (capture 40): one line per LLM, the chosen one lit; its name, « VISION » when it reads
 * images, the path of its file in mono; Modifier opens its editor under the list, Retirer takes it
 * off the list (its files stay). Local LLMs only for now. The hidden select keeps the choice.
 */
function renderLLMList() {
  const list = $('llm-list'),
    chosen = $('detected-model').value,
    off = $('detected-model').disabled;
  state.llmListKey = [off, !!state.modelAdding, chosen, (state.detectedModels || []).length].join('|');
  const rows = (state.detectedModels || []).map(item => {
    const lit = item.id === chosen && !state.modelAdding,
      row = node('div', 'llm-row' + (lit ? ' is-chosen' : '')),
      pick = node('button', 'llm-pick'),
      head = node('span', 'llm-head'),
      edit = node('button', 'llm-edit'),
      remove = node('button', 'llm-remove');
    pick.type = edit.type = remove.type = 'button';
    pick.setAttribute('role', 'radio');
    pick.setAttribute('aria-checked', String(lit));
    head.append(node('span', 'llm-name', item.name || 'Sans nom'));
    if (item.projectorPath) head.append(node('span', 'llm-tag', 'Vision'));
    pick.append(node('span', 'llm-radio'), head, node('span', 'llm-path', item.modelPath || ''));
    pick.disabled = off;
    pick.onclick = () => chooseLLM(item.id);
    edit.append(icon('edit'));
    edit.title = 'Modifier';
    edit.setAttribute('aria-label', 'Modifier ' + (item.name || 'ce LLM'));
    edit.disabled = off;
    edit.onclick = () => {
      if (!chooseLLM(item.id)) return;
      $('model-paths').open = true;
      $('llm-name').focus();
    };
    remove.append(icon('trash'));
    remove.title = 'Retirer de la liste (les fichiers restent)';
    remove.setAttribute('aria-label', 'Retirer ' + (item.name || 'ce LLM') + ' de la liste');
    remove.disabled = off || state.modelAdding || item.id === 'current';
    remove.onclick = () => void removeLLM(item.id);
    row.append(pick, edit, remove);
    return row;
  });
  list.replaceChildren(
    ...(rows.length ? rows : [node('p', 'settings-note', 'Aucun LLM pour l’instant : ajoutez le fichier GGUF du vôtre.')]),
  );
}
/** A line of « Vos LLM » chosen: its paths in the editor (true once it is the one chosen). */
function chooseLLM(id) {
  if ($('detected-model').value !== id || state.modelAdding) {
    $('detected-model').value = id;
    if (state.modelAdding) {
      if (modelEditorDirty() && !confirm('Abandonner les modifications de ce LLM ?')) {
        $('detected-model').value = '';
        return false;
      }
      state.modelAdding = false;
      state.modelDraftBaseline = JSON.stringify({ ...modelDraft(), adding: false });
    }
    chooseDetectedModel();
    // Another line chosen: its editor stays closed until Modifier.
    if ($('detected-model').value === id) $('model-paths').open = false;
  }
  return $('detected-model').value === id;
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
  renderLLMList();
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
  renderLLMList();
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
  renderLLMList();
}
/** Takes a LLM off the list (`id`: a line of « Vos LLM », else the one chosen); its files stay. */
async function removeLLM(id = $('detected-model').value) {
  if (typeof id !== 'string') id = $('detected-model').value;
  const chosen = id === $('detected-model').value;
  if ((chosen && $('remove-llm').disabled) || state.operation || state.modelAdding || id === 'current') return;
  const item = state.detectedModels.find(item => item.id === id);
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
      renderLLMList();
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
    // The room (Interface) goes with the other preferences.
    await interfaceUI.save();
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

async function shutdownApplication({ confirmed = false } = {}) {
  if (state.closingApp || (!confirmed && $('shutdown-app').disabled)) return;
  // After the question about unsaved settings it goes on: the server says if it cannot.
  if (settingsGuard.isDirty()) return requestSettingsClose(() => shutdownApplication({ confirmed: true }));
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
async function restartApplication({ confirmed = false } = {}) {
  if (state.closingApp || (!confirmed && $('restart-app').disabled)) return;
  // After the question about unsaved settings it goes on: the server says if it cannot.
  if (settingsGuard.isDirty()) return requestSettingsClose(() => restartApplication({ confirmed: true }));
  const token = state.token;
  state.closingApp = true;
  updateControls();
  try {
    if (!(await persistConversation()))
      throw Error('La conversation n’a pas été sauvegardée. L’application reste ouverte.');
    await historyWrite;
    $('settings').close();
    $('update-title').textContent = 'Redémarrage';
    $('update-dialog').dataset.mode = 'restart';
    $('update-failure').hidden = true;
    $('update-progress').hidden = false;
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
    throw Error('Redémarrage non confirmé. Si Moodix ne revient pas, relancez-le avec Lancer-Windows.cmd.');
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
    // The reference stays in the project: only this message no longer names it.
    remove.onclick = () => {
      state.images.splice(index, 1);
      if (image.ref) unwriteReference(image.ref);
      renderAttachments();
      updateControls();
    };
    box.append(preview);
    if (image.ref) box.append(node('span', 'attachment-badge', image.ref));
    box.append(remove);
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
    // The video stays in the project: only this message no longer names it.
    remove.onclick = () => {
      state.videos.splice(index, 1);
      unwriteReference(video.label);
      renderAttachments();
      updateControls();
    };
    box.append(remove);
    $('attachments').append(box);
  });
}

/** « #ref3 » written in the message where the cursor is. */
function writeReference(label) {
  const box = $('prompt'),
    written = withReference(box.value, label, box.selectionStart ?? box.value.length, box.selectionEnd ?? undefined);
  box.value = written.text;
  box.setSelectionRange?.(written.caret, written.caret);
  resizePrompt();
}
/** « #ref3 » taken out of the message with its attachment. */
function unwriteReference(label) {
  $('prompt').value = withoutReference($('prompt').value, label);
  resizePrompt();
}

/**
 * Images and videos dropped, pasted or chosen in the message box: each is kept as a reference of
 * the project, and « #ref3 » is written in the message. A video is named so; an image is shown to
 * the model in the message as well, when it can see (its projector of vision).
 */
async function addFiles(files) {
  if (
    !files.length ||
    state.projectWorking ||
    state.status.toolJob ||
    (state.generating && !state.proposalCard) ||
    state.preparing ||
    state.loadingHistory
  )
    return;
  // Joined while a card of Moodix waits: it is for the message that answers it, so the card waits too.
  state.proposalCard?.stop();
  if (files.filter(file => !isVideo(file)).length + state.images.length > 64)
    return notice('Vous pouvez joindre 64 images au maximum par message.');
  state.preparing = true;
  updateControls();
  const project = state.projectId || 'inbox',
    images = [];
  try {
    for (const file of files) {
      const [reference] = await assetsUI.importFiles([file], { project });
      if (!reference) continue;
      // Already joined to this message (the same file again, the same reference): nothing more.
      if (
        state.images.some(image => image.resource === reference.id) ||
        state.videos.some(video => video.id === reference.id) ||
        images.some(item => item.reference.id === reference.id)
      )
        continue;
      writeReference(reference.label);
      if (isVideo(file)) state.videos.push({ id: reference.id, label: reference.label, name: reference.name });
      else images.push({ file, reference });
    }
    if (images.length && state.config.projectorPath) {
      const refs = [...state.images.map(image => image.ref), ...images.map(item => item.reference.label)],
        ids = [...state.images.map(image => image.resource), ...images.map(item => item.reference.id)];
      state.images = (await prepareImages([...state.images, ...images.map(item => item.file)])).map((image, index) =>
        refs[index] ? { ...image, ref: refs[index], resource: ids[index] } : image,
      );
    }
    notice('');
  } catch (error) {
    notice(error.message || 'Ce fichier ne peut pas être lu.');
  } finally {
    state.preparing = false;
    renderAttachments();
    updateControls();
  }
}

function scrollToBottom() {
  if (state.stickToBottom) pinChat($('chat-area'));
}
/**
 * The chat on its last line, at once. The area scrolls smoothly (moodix.css) for the reader; done
 * so here, it stopped above an answer that grew meanwhile, and its steps read as the reader
 * scrolling up (onscroll), which then left the chat above its end.
 */
function pinChat(area) {
  if (area.scrollTo) area.scrollTo({ top: area.scrollHeight, behavior: 'instant' });
  else area.scrollTop = area.scrollHeight;
}

function renderText(target, text) {
  target.classList.add('markdown');
  target.innerHTML = markdownToHtml(text);
  // « #ref3 » marked: its picture under the pointer.
  markReferences(target, node);
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
    for (const [index, image] of images.entries()) {
      const img = node('img');
      // The stored original when there is one; the model's copy is not what the user attached.
      img.src = image.view || image.url;
      img.alt = image.name;
      img.decoding = 'async';
      // Each under its label, as the references of a proposal (« RÉF. 1 »).
      const figure = node('figure', 'message-ref');
      figure.append(img, node('figcaption', '', `RÉF. ${index + 1}`));
      previews.append(figure);
    }
    article.append(previews);
  }
  if (text) article.append(markReferences(node('div', 'message-body', text), node));
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
  if (reply?.classList.contains('assistant') && !reply.querySelector('.message-waiting.is-failed'))
    reply.append(
      action('Régénérer', 'update', 'Renvoyer le même message pour obtenir une autre réponse', () => takeBack(true)),
    );
}
/** Takes back the last message the user wrote: to edit it, or to send it again as it is. */
async function takeBack(resend) {
  if (state.generating || state.preparing || state.loadingHistory || state.status.toolJob)
    return notice('Attendez la fin de la réponse ou de la génération en cours.');
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
    avatar.setAttribute('aria-hidden', 'true');
    avatar.append(...moodixMark());
    header.append(avatar, node('span', 'message-name', 'Moodix'));
    article.append(header);
  }
  const reasoning = node('details', 'reasoning');
  reasoning.hidden = true;
  const summary = node('summary');
  summary.append(icon('spark'), node('span', 'reasoning-label', 'Réflexion'));
  summary.setAttribute('aria-label', 'Réflexion du modèle');
  const thoughts = node('div', 'reasoning-content');
  reasoning.append(summary, thoughts);
  const body = node('div', 'message-body');
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
 * A proposal of Moodix in the Chat (direction-artistique.md, « La proposition vidéo »): an image is
 * made at once, a video or a sound waits in a card of its message (proposal-card.mjs); allowed in
 * the settings, a video runs at once too. Resolves the decision of the user.
 */
/** The creations of the project of the conversation open, the newest first (as the Studio reads them). */
async function projectTakes() {
  const route =
    'project-gallery/' + encodeURIComponent(state.projectId || 'inbox') + '?images=0' +
    (state.conversationId ? '&conversation=' + encodeURIComponent(state.conversationId) : '');
  return (await (await api(route)).json()).runs ?? [];
}
function proposalChoice(view, proposal, abort) {
  const asked = proposal.mediaType === 'video' || proposal.mediaType === 'audio';
  if (proposal.autoAllow) return asked ? 'once' : undefined;
  if (!asked) return 'once';
  return cardChoice(view.generations, proposal, abort);
}
/** The card of a proposal in `host`, until the user answers (`delay`: the count of a video). */
function cardChoice(host, proposal, abort, delay) {
  const pending = proposalCard({
    host,
    request: proposal,
    signal: abort,
    node,
    api,
    ...(delay !== undefined ? { delay } : {}),
    composer: $('prompt'),
    // « + » on an input of the card: « Créations du projet » in the card; a file dropped or pasted on
    // it is kept as a reference of the project first. The image goes in its case, without a message.
    takes: () => projectTakes(),
    importImage: file => assetsUI.importFiles([file], { project: state.projectId || 'inbox' }).then(list => list[0] ?? null),
    onChange: () => scrollToBottom(),
  });
  state.proposalCard = pending;
  updateControls();
  return pending.answer.finally(() => {
    if (state.proposalCard === pending) state.proposalCard = null;
    updateControls();
  });
}

// What the request was for, in the sentence of a missing file (53).
const MISSING_FOR = {
  create_image: 'Pour créer cette image',
  create_video: 'Pour tourner ce plan',
  extend_video: 'Pour prolonger ce plan',
  replace_character: 'Pour remplacer un personnage',
  create_audio: 'Pour composer ce son',
  create_sound: 'Pour créer ce son',
  upscale: 'Pour agrandir et affiner',
  interpolate: 'Pour rendre la vidéo plus fluide',
};
/**
 * A request whose workflow lacks a file (etats-maquette.md, 53): the sentence of Moodix (written by
 * the application, which knows the file), then the card that downloads it. The file there, the
 * same message is sent again, if it is still the last one of this conversation and nothing runs.
 */
function missingFile(view, request, history) {
  const many = request.missing.files.length > 1,
    sentence =
      `${MISSING_FOR[request.tool] ?? 'Pour cette création'}, il me faut ${request.workflowName}, et il lui manque ` +
      `${many ? 'des fichiers' : 'un fichier'}. Dès qu’${many ? 'ils sont' : 'il est'} là, je reprends votre demande.`,
    conversationId = state.conversationId,
    original = history.findLast(message => message.role === 'user' && !message.internal),
    asked = JSON.stringify(original?.content ?? '');
  view.generations.append(node('p', 'missing-say', sentence));
  missingFileCard({
    host: view.generations,
    request,
    node,
    icon,
    api,
    // The conversation has not moved: the message goes again by itself. Written in meanwhile (or
    // something running, or a draft in the box): the card offers to take the request up again.
    onReady: () => {
      const index = lastExchange(state.messages);
      if (state.conversationId !== conversationId || index < 0 || JSON.stringify(state.messages[index].content) !== asked)
        return false;
      if (state.generating || state.preparing || state.status.toolJob) return false;
      if ($('prompt').value.trim() || state.images.length || state.videos.length) return false;
      void takeBack(true);
      return true;
    },
    // « Reprendre la demande »: the same message, sent as a new one.
    onResume: () => {
      if (state.conversationId !== conversationId) return notice('Ouvrez la conversation de cette demande.');
      if (state.generating || state.preparing || state.status.toolJob)
        return notice('Attendez la fin de la réponse ou de la génération en cours.');
      if ($('prompt').value.trim() || state.images.length || state.videos.length)
        return notice('Envoyez ou effacez d’abord le message en cours d’écriture.');
      const draft = savedUser(original);
      $('prompt').value = draft.text;
      state.images = [...draft.images];
      state.videos = [...draft.videos];
      renderAttachments();
      resizePrompt();
      $('chat-form').requestSubmit();
    },
  });
  scrollToBottom();
}
/**
 * A take that failed, made again (etats-maquette.md, 52): « Relancer » runs its proposal again with
 * the same settings at once (the click confirms it); « Modifier la proposition » shows its card first,
 * without a count. In the message where it failed; the conversation keeps the call and its result.
 */
async function againTake(failed, { edit = false, figure = null, container }) {
  if (state.generating || state.preparing || state.loadingHistory || state.status.toolJob)
    return notice('Attendez la fin de la réponse ou de la génération en cours.');
  state.generating = true;
  let endTurn;
  state.turnEnded = new Promise(resolve => {
    endTurn = resolve;
  });
  turnActions();
  state.controller = new AbortController();
  const signal = state.controller.signal,
    history = [...state.messages];
  updateControls();
  try {
    const request = await (await api('tools/again', { requestId: failed.requestId }, { signal })).json();
    figure?.remove();
    const generation = generationUI.mount(container, request);
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
        edit ? { approve: (proposal, abort) => cardChoice(container, proposal, abort, 0) } : { confirmed: true },
      );
      generation.finish(result);
    } catch (error) {
      if (signal.aborted) generation.fail(error.message);
      else generation.failed(error.message);
      throw error;
    }
    history.push(
      { role: 'assistant', content: '', tool_calls: [request.call] },
      { role: 'tool', tool_call_id: request.call.id, content: result.content },
    );
    if (result.record || result.failed) state.status = await (await api('status')).json();
  } catch (error) {
    if (!signal.aborted) notice(error.message);
  } finally {
    if (history.length > state.messages.length) {
      state.messages = archiveMessages(history);
      state.archiveSnapshot = { messages: [...state.messages], incomplete: false };
      await persistConversation();
    }
    state.generating = false;
    state.controller = null;
    endTurn();
    state.studio?.invalidate?.();
    turnActions();
    updateControls();
  }
}

/**
 * Output buttons. Prolonger writes a line the model understands in the composer, for the user to
 * finish. Upscale and Interpoler run the same proposal a model call would, without a model reply:
 * the user confirms it, the result joins the conversation as an ordinary tool call.
 */
async function runOutputAction(record, index, action) {
  // The take by its number when it has one (the model finds it by it: « la prise 12 »).
  const take = record.outputs?.[index]?.take,
    reference = Number.isInteger(take) ? `la prise ${take}` : `la sortie ${record.id}` + (index ? ` (sortie ${index + 1})` : '');
  // Prolonger and Animer write the start of a request, for the user to finish.
  if (action === 'extend' || action === 'animate') {
    const line =
      action === 'extend' ? `Prolonge ${reference} : ` : `Anime ${reference} : `,
      prompt = $('prompt');
    prompt.value = line + (prompt.value.trim() ? '\n\n' + prompt.value : '');
    resizePrompt();
    prompt.focus();
    prompt.setSelectionRange(line.length, line.length);
    return;
  }
  if (state.generating || state.preparing || state.loadingHistory || state.status.toolJob)
    return notice('Attendez la fin de la réponse ou de la génération en cours.');
  if (record.conversationId !== state.conversationId) return notice('Ouvrez la conversation de ce résultat.');
  const video = record.mediaType === 'video',
    text =
      action === 'upscale'
        ? `Agrandir et affiner ${reference}.`
        : `Interpoler ${reference} pour une vidéo plus fluide.`,
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
    // The references the model knows are those of the conversation's project.
    project: state.projectId || 'inbox',
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
    // A proposal of Moodix waits (a card, or the Studio): this message answers it instead, and
    // the card goes (Moodix answers with another).
    if (state.proposalCard) state.proposalCard.decline();
    else if (!state.studio?.decline?.()) return;
    await state.turnEnded;
    if (state.generating) return;
  }
  if (!state.config.enginePath || !state.config.modelPath) {
    notice('Choisissez votre LLM dans Paramètres › Moodix AI avant le premier envoi.');
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
  state.onChatSent?.();
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
    // « Réflexion en cours… »: the mark of Moodix AI thinks with it, until the answer is written.
    markThinking(view, Boolean(view.waiting) && !output);
    thoughtFor(view, reasoning, output);
    view.reasoning.hidden = !reasoning;
    view.thoughts.textContent = reasoning;
    if (output) renderText(view.body, output);
    else view.body.replaceChildren();
    if (output) showLastReply(output);
    scrollToBottom();
    lastRender = performance.now();
    state.archiveSnapshot = snapshot();
    if ((output || reasoning) && performance.now() - lastArchive > 2000 && !state.savingHistory) {
      lastArchive = performance.now();
      persistConversation();
    }
  }
  const started = performance.now(),
    loading = modelLoading(view);
  try {
    // Moodix waits: its Éclipse breathes; the model loading, its line says so (etats-maquette.md, 51).
    view.body.replaceChildren();
    markThinking(view, true);
    if (!(await persistConversation()))
      throw Error('Impossible de sauvegarder ce message. Vérifiez le dossier history ou désactivez l’historique.');
    await waitForModel(api, signal, status => {
      state.status = status;
      if (status.state !== 'ready') loading.show();
      updateControls();
    });
    loading.stop();
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
      // The Éclipse of the answer breathes until its first words (logo.md, Respiration).
      view.body.replaceChildren();
      view.waiting = true;
      markThinking(view, true);
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
      // References too little used for the model's list were removed from the disk: said.
      const removed = response.headers?.get?.('X-References-Removed');
      if (removed) {
        try {
          notice(removedNotice(JSON.parse(decodeURIComponent(removed))));
        } catch {
          // Unreadable: the list of references is refreshed all the same.
        }
        void assetsUI.refresh().catch(() => {});
      }
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
      // The stream ended: the Éclipse rests (a tool, or the answer written).
      view.waiting = false;
      markThinking(view, false);
      if (leaked && !output)
        output = allowTools
          ? 'Je n’ai pas pu lancer cet outil : la génération est peut-être indisponible en ce moment (voir les réglages). Renvoyez votre demande pour que je réessaie.'
          : 'Je ne peux pas lancer d’autre génération dans ce message. Renvoyez votre demande pour que je réessaie.';
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
      if (request.kind === 'character') {
        // A character to put in a video with no image of them: the application makes the image
        // (the pointer, in the Studio), the user keeps it or has another made, then the
        // replacement runs with it. The chat model leaves the card to the image as for any
        // creation, and comes back once it is kept to write the prompt of the video from it.
        iterations++;
        const outcome = await replaceWithCharacter(request, { view, signal });
        history.push({ role: 'tool', tool_call_id: request.call.id, content: outcome.content });
        if (outcome.record) state.status = await (await api('status')).json();
        complete = true;
        break;
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
      if (request.missing) {
        // Its workflow lacks a file (etats-maquette.md, 53): Moodix says it in a sentence, the card
        // offers the download, and the message goes again once the file is there. The turn ends here.
        view.generation = true;
        missingFile(view, request, history);
        history.push({
          role: 'tool',
          tool_call_id: request.call.id,
          content: JSON.stringify({
            status: 'missing_file',
            workflow: request.workflowName,
            message:
              'Il manque un fichier à ce workflow : l’application propose de le télécharger, puis renvoie la demande. N’écris rien de plus.',
          }),
        });
        complete = true;
        break;
      }
      iterations++;
      view.generation = true;
      // From the Studio (its agent's chat), a creation is set in the Studio: the pointer of Moodix
      // sets it there and « Générer » is the user's answer. In the Chat, a video or a sound is a card
      // of the message (an image is made at once): proposalChoice below.
      const viaStudio =
        state.view === 'studio' && Boolean(state.studio?.accepts?.(request.tool || request.call?.function?.name));
      const generation = generationUI.mount(view.generations, request, { compact: viaStudio });
      // A video is commented by the model only when the user chose it in the settings: the
      // reload and the analysis take about a minute. An image too, by its own choice. Otherwise
      // the creation ends the turn; a sound always does.
      const review = state.generation?.reviewVideos === true,
        lookAtImage = !request.mediaType && state.generation?.reviewImages === true;
      // Made from the Studio, the generator keeps its models for the next creation, and the chat
      // model comes back with the next message: unless it has a creation to look at.
      const kept = viaStudio && !(review && request.mediaType === 'video') && !lookAtImage;
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
            reviewImages: lookAtImage,
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
              : { approve: (proposal, abort) => proposalChoice(view, proposal, abort) }),
          },
        );
        generation.finish(result);
        if (viaStudio) void state.studio.settled(result);
      } catch (error) {
        if (viaStudio) void state.studio.settled({ error: signal.aborted ? 'Génération arrêtée.' : error.message });
        // Stopped by the user: said; failed: the take veiled, to make again (52).
        if (signal.aborted) generation.fail(error.message);
        else generation.failed(error.message);
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
      const looked =
        (review && result.record?.mediaType === 'video') || (lookAtImage && result.record?.mediaType === 'image');
      const reviewImages = looked && state.status.state === 'ready' && state.status.vision ? result.images : [];
      reviewRecord = reviewImages.length ? result.record : null;
      if (looked) {
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
      if (result.failed && state.status.state !== 'ready') {
        // Nothing made and the model cannot come back now (the card held, 54): the take says what
        // failed; the turn ends there, without the same words again in red.
        if (!result.record) {
          complete = true;
          break;
        }
        throw Error(result.error || 'L’image est disponible dans la galerie, mais le modèle n’a pas redémarré.');
      }
      // A take that failed says why on itself (52): no second line under the message.
      view.note.textContent = result.failed && result.record ? result.error || 'Analyse indisponible.' : '';
      if (result.denied || result.failed || iterations >= (state.generation?.maxIterations || 10)) allowTools = false;
      // After a refusal or a failure the model explains it: it does not go on inspecting outputs.
      if (result.denied || result.failed) resourceReads = 8;
      // Not seen (no analysis chosen for it): its text would only repeat what the user sees.
      silent = Boolean(result.record && !looked && !result.failed);
      state.archiveSnapshot = { messages: [...archiveMessages(history)], incomplete: true };
      await persistConversation();
      view = assistantMessage(view);
      finishReason = '';
    }
  } catch (error) {
    const canceled = signal.aborted,
      // The model did not come (51): the message stays in the thread, the line says why.
      unloaded = !canceled && state.waitingForModel && !(output || reasoning || usedTool);
    loading.stop();
    if (unloaded) {
      loading.fail(error.message || 'Le modèle n’a pas démarré.', () => void takeBack(true));
      state.messages = archiveMessages(history);
      state.archiveSnapshot = { messages: [...state.messages], incomplete: false };
    } else if (output || reasoning || usedTool) {
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
    if (!canceled && !unloaded) notice(error.message || 'La connexion a été interrompue.');
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
    // The turn is over, answered, failed or stopped: the mark is at rest, its thought timed.
    thoughtFor(view, reasoning, output, true);
    markThinking(view, false);
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

/**
 * While the chat is folded in the Studio, its « Agent » button tells what Moodix AI does: a light
 * runs along its colours while an answer is written, and it glows once an answer came unseen,
 * until the chat is opened.
 */
function showLastReply(streaming = '') {
  const agent = $('agent-open'),
    folded = state.view === 'studio' && document.body.dataset.chat !== 'open';
  if (!agent) return;
  agent.classList.toggle('is-working', Boolean(streaming) && state.generating === true);
  if (streaming && folded) agent.dataset.unread = 'true';
}
/** What depends on the view: the switch between Chat and Studio, the context of the message box. */
function syncViews() {
  const studio = state.view === 'studio';
  $('composer-context').hidden = !studio;
}

/**
 * A proposal of the application itself in a chat turn (the image of a character, then its
 * replacement): set in the Studio by the pointer and started at once, followed by a card in the
 * conversation. Returns the result, as for a creation of the chat.
 */
async function runForTurn(proposal, { view, signal }) {
  proposal.autoAllow = true;
  view.generation = true;
  const generation = generationUI.mount(view.generations, proposal, { compact: true });
  try {
    const result = await workflowsUI.requestTool(
      proposal,
      signal,
      (progress, fraction, preview) => {
        generation.progress(progress, fraction, preview);
        state.studio.follow(progress, fraction, preview);
        scrollToBottom();
      },
      image => generation.image(image),
      {
        review: false,
        reviewImages: false,
        approve: async (asked, abort) => {
          const answer = state.studio.propose(asked, abort);
          updateControls();
          try {
            return await answer;
          } finally {
            updateControls();
          }
        },
        studio: true,
      },
    );
    generation.finish(result);
    void state.studio.settled(result);
    return result;
  } catch (error) {
    void state.studio.settled({ error: signal.aborted ? 'Génération arrêtée.' : error.message });
    generation.fail(error.message);
    throw error;
  }
}

/**
 * A character put in a video when there is no image of them (replace_character with
 * `character`): their image made in the Studio, checked by the user (« OK », « Autre image »,
 * « Annuler »), then the replacement with it. Returns { content, record } for the model's call.
 */
async function replaceWithCharacter(request, { view, signal }) {
  const said = text => (view.note.textContent = text);
  const action = async (name, args) =>
    (
      await api('tools/action', {
        conversationId: state.conversationId,
        project: state.projectId || 'inbox',
        studio: true,
        name,
        arguments: args,
      })
    ).json();
  if (!state.studio) throw Error('Le Studio est indisponible : impossible de faire l’image du personnage.');
  let prompt = request.imagePrompt,
    image = null;
  for (let tries = 0; tries < 20 && !image; tries++) {
    said('Image du personnage…');
    const size = state.studio.imageSize?.(request.sourceSize) ?? null;
    const made = await runForTurn(await action('create_image', { prompt, ...(size ?? {}) }), { view, signal });
    if (!made.record) {
      said(made.error || 'L’image du personnage n’a pas pu être faite.');
      return { content: JSON.stringify({ status: 'error', message: made.error || 'Image du personnage non faite.' }) };
    }
    said('Ce personnage vous convient ? Répondez dans le Studio : OK, Autre image ou Annuler.');
    const answer = await state.studio.checkCharacter(made.record, signal);
    if (answer.decision === 'cancel') {
      said('Remplacement annulé.');
      return {
        content: JSON.stringify({
          status: 'cancelled',
          message:
            'L’utilisateur a annulé le remplacement après avoir vu l’image du personnage : la vidéo n’a pas été faite. ' +
            `L’image reste dans la conversation (run_id ${made.record.id}). Ne relance rien sans nouvelle demande.`,
          character_image: { output: made.record.id },
        }),
      };
    }
    if (answer.decision === 'again') {
      prompt = answer.prompt || prompt;
      continue;
    }
    image = made.record;
  }
  if (!image) return { content: JSON.stringify({ status: 'cancelled', message: 'Trop d’images refaites.' }) };
  said('');
  const proposal = await action('replace_character', { ...request.replace, reference: { output: image.id } });
  // Its prompt is written in the Studio from the video and the image kept, with what the user
  // asked (the pointer's wand: the chat model comes back for it).
  proposal.scene = { asked: request.asked ?? '' };
  const result = await runForTurn(proposal, { view, signal });
  if (!result.record) return { content: result.content ?? JSON.stringify({ status: 'error', message: result.error }) };
  // Said to the model with its result: the image of the character it can use again.
  const content = JSON.parse(result.content);
  content.character_image = { output: image.id };
  return { content: JSON.stringify(content), record: result.record };
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
      content: said + '\n\n' + STUDIO_NOTE,
    },
    { role: 'assistant', content: '', tool_calls: [proposal.call] },
    { role: 'tool', tool_call_id: proposal.call.id, content: result.content },
  ]);
  state.archiveSnapshot = { messages: [...state.messages], incomplete: false };
  // Named by its prompt alone, as the server names it (the pill of the title bar says the mode).
  const named = conversationTitle(said).slice(0, 120);
  if (named && untitled($('conversation-title').textContent)) setConversationTitle(named);
  turnActions();
  await persistConversation();
  contextMeter.schedule();
  return result;
}

const tokenControls = setupTokenControls($);
const computeControls = setupComputeControls($);
// The one tooltip of the page: the « ? » of the settings and of the Studio, the names of the
// controls (their titles become its tips), in one bubble (help-tips.mjs).
const helpTips = setupHelpTips(document.body);
const settingsTabs = setupSettingsTabs({
  list: $('settings-tabs'),
  onShow: name => {
    helpTips.hide();
    $('settings-body').scrollTop = 0;
    // Interface: the page stays sharp behind, to see each setting at once (moodix.css); its defaults
    // come back from the foot.
    $('settings').dataset.tab = name;
    $('room-reset').hidden = name !== 'interface';
    if (name === 'update' && $('settings').open) {
      void checkComponents();
      void refreshToken();
      // No « Rechercher une mise à jour » any more (16/11): looked for at the launch and here.
      void checkUpdates({ refresh: true });
    }
  },
});
const settingsSearch = setupSettingsSearch({
  dialog: $('settings'),
  input: $('settings-search'),
  empty: $('settings-empty'),
  title: $('settings-results'),
  scroller: $('settings-body'),
  onRefresh: searching => settingsTabs.matches(searching),
});
dismissSettingsOnOutsideClick($('settings'), () => requestSettingsClose());
// Fond, éclairage, grain (the Interface tab): applied at once, kept with « Enregistrer ».
const interfaceUI = setupInterfaceSettings({ $, node, api });
// Closed without « Enregistrer » (Annuler, Échap, a click beside it): the room as it was kept.
$('settings').addEventListener('close', () => interfaceUI.revert());
const projectUI = setupProjectNavigation({
  $,
  state,
  node,
  icon,
  api,
  openConversation: id => {
    requestSettingsClose(() => loadConversation(id));
  },
  newConversation: id => {
    requestSettingsClose(() => newConversation(id));
  },
  removeConversation: confirmHistoryDeletion,
  // The conversation open, renamed from the fil: its new name at once.
  setTitle: title => setConversationTitle(title),
  // A project renamed or deleted: the library on screen says it too.
  onChange: () => {
    if (state.view === 'library') libraryUI.render();
  },
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
  // A take opened (capture 33): where it was made, « test / Renard en pull bleu », which opens it.
  describe: record => {
    if (!record.conversationId || record.legacy || record.unsaved) return null;
    const item = (state.historyItems || []).find(entry => entry.id === record.conversationId);
    if (!item && record.conversationId !== state.conversationId) return null;
    const projectId = item?.projectId || state.projectId || 'inbox',
      project = projectId === 'inbox' ? 'Sans projet' : (state.projects || []).find(entry => entry.id === projectId)?.name || 'Sans projet';
    return {
      conversation: project + ' / ' + (item?.title || 'Nouvelle conversation'),
      open: () => requestSettingsClose(() => loadConversation(record.conversationId)),
    };
  },
  // Its actions at the foot of its panel, as in the conversation; done there, the take closed.
  takeActions: (record, index) => viewerActions(record, index),
});
// The library: every creation; a click shows it whole, its conversation opens it.
const libraryUI = setupLibrary({
  $,
  state,
  node,
  icon,
  api,
  // `around`: the takes shown, which ‹ › of the take opened go through.
  viewOutput: (record, index, blob, around) => assetsUI.viewOutput(record, index, blob, around),
  openConversation: id => requestSettingsClose(() => loadConversation(id)),
  newConversation: id => requestSettingsClose(() => newConversation(id)),
  // The project chosen in the Pellicule: the page follows it.
  onFilter: filter => {
    state.libraryProject = filter.project;
    projectUI.render();
  },
  // On a take, the actions of the conversation (Ouvrir, Prolonger…), done in its conversation.
  actions: (record, index) => libraryActions(record, index),
  // The projects live here too (pellicule-maquette.md): « + Nouveau projet », « ··· » on one.
  onNewProject: () => projectUI.edit(),
  onRenameProject: project => projectUI.edit(project),
  onDeleteProject: project => projectUI.remove(project),
  // « Ouvrir le Studio » on a project with nothing in it: the Studio of that project.
  openStudio: project =>
    requestSettingsClose(async () => {
      if ((state.projectId || 'inbox') !== project) await newConversation(project);
      showStudio();
    }),
});
const viewerActions = outputActions({
  api,
  node,
  onDetails: null,
  onAction: (record, index, action) => {
    $('original-dialog').close();
    actOnTake(record, index, action);
  },
  onShow: record => {
    $('original-dialog').close();
    showInStudio(record);
  },
});
// Leaving the Pellicule (switchView): its sound stops.
state.hushLibrary = () => libraryUI.hush();
const libraryActions = outputActions({
  api,
  node,
  onDetails: (record, index) => assetsUI.viewOutput(record, index),
  onAction: (record, index, action) => actOnTake(record, index, action),
  onShow: record => showInStudio(record),
});
/** An action on a take of the Pellicule: in its conversation, opened first (as from the chat). */
function actOnTake(record, index, action) {
  if (!record.conversationId || record.conversationId === state.conversationId) {
    showChat();
    return void runOutputAction(record, index, action);
  }
  requestSettingsClose(async () => {
    await loadConversation(record.conversationId);
    if (state.conversationId === record.conversationId) await runOutputAction(record, index, action);
  });
}
const actionButtons = outputActions({
  api,
  node,
  onDetails: (record, index) => assetsUI.viewOutput(record, index),
  onAction: (record, index, action) => runOutputAction(record, index, action),
  // « Afficher dans le Studio »: the take on the Studio's screen; the prompt and the settings stay.
  onShow: record => showInStudio(record),
});
function showInStudio(record) {
  void closeChat()
    .then(() => revealStudio())
    .then(() => record && studioUI.show(record));
}
const studioUI = setupStudio({
  api,
  node,
  icon,
  notice,
  assets: assetsUI,
  viewOutput: (record, index) => assetsUI.viewOutput(record, index),
  waitForModel: (...args) => waitForModel(...args),
  // A chat answer in progress keeps the model: the Studio waits for it.
  gpuBlocked: () => Boolean(state.status.toolJob?.blocked),
  mark: () => moodixMark()[0],
  recoverGPU: () => recoverGPU(),
  blocked: () =>
    state.generating || state.status.busy
      ? 'Attendez la fin de la réponse en cours.'
      : state.preparing || state.loadingHistory || state.updating || state.closingApp
        ? 'Attendez la fin de l’opération en cours.'
        : '',
  onChange: () => refreshStatus(),
  onRuns: (id, legacy) => {
    state.studioId = id;
    state.studioLegacy = legacy;
  },
  conversation: () => state.conversationId,
  // The Sortie of the Studio shows the creations of the whole project.
  project: () => state.projectId || 'inbox',
  ensureConversation: async () => (state.conversationId ||= crypto.randomUUID()),
  run: runInStudio,
  reveal: () => closeChat().then(() => revealStudio()),
  stopTurn: () => state.controller?.abort(),
  onConversation: () => showLastReply(),
  afterMove,
  openAgent: () => void openChat(),
  // A mode chosen while the Studio is not on screen: the Studio opens, in that mode.
  openStudio: () => showStudio(),
});
state.studio = studioUI;
const generationUI = setupGenerationUI({
  api,
  node,
  actions: actionButtons,
  openOutput: (record, index, blob) => assetsUI.viewOutput(record, index, blob),
  onResize: scrollToBottom,
  // « Ouvrir » on a card: the creation on the Studio's screen.
  onOpen: record => showInStudio(record),
  // A take that failed: « Relancer », « Modifier la proposition » (etats-maquette.md, 52).
  onAgain: (request, options) => void againTake(request, options),
});
const workflowsUI = setupNativeWorkflows({
  api,
  state,
  node,
  notice,
  onRequestClose: () => requestSettingsClose(),
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
      'generation-auto-video',
      'generation-review-images',
      'generation-review',
      'native-convert-root',
      'generation-vae-root',
      'generation-lora-root',
    ].map(id => [id, $(id).value, $(id).checked]),
    room: interfaceUI.dirty(),
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
$('settings-update-install').onclick = installUpdate;
/** « Libérer le GPU » (the composer, the Studio): the engine of the last generation lets the card go. */
async function recoverGPU() {
  try {
    await api('tools/recover', {});
  } catch (error) {
    notice(error.message);
  }
  await refreshStatus();
}
$('composer-recover').onclick = () => void recoverGPU();
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
// Nothing stops an update while it installs; failed, Échap or a click beside the panel closes it (56).
$('update-dialog').addEventListener('cancel', event => {
  if (!$('update-dialog').classList.contains('is-failed')) event.preventDefault();
});
$('update-dialog').addEventListener('click', event => {
  if (event.target === $('update-dialog') && $('update-dialog').classList.contains('is-failed')) $('update-dialog').close();
});
$('update-retry').onclick = () => void installUpdate({ confirmed: true });
$('shutdown-app').onclick = shutdownApplication;
$('restart-app').onclick = restartApplication;
$('settings-close').onclick = () => requestSettingsClose();
// « Annuler » at the foot: closed as by Échap (unsaved changes are asked about).
$('settings-cancel').onclick = () => requestSettingsClose();
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
/**
 * The library (the Pellicule since 0.6.0), a page of its own outside a conversation: every creation,
 * those of one project (`project`) or of every one. The conversation is kept first.
 */
function showLibrary({ project = 'all' } = {}) {
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
      state.view = 'library';
      state.libraryProject = project;
      delete document.body.dataset.chat;
      projectUI.render();
      void libraryUI.show({ project });
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
 * from the library, the page simply changes. Resolves once the page shows the change.
 */
function switchView(kind, apply) {
  // A sound playing in the Pellicule stops as the page changes.
  if (kind !== 'library') state.hushLibrary?.();
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
  // What can wait (the gallery, the Studio drawn again) waits for the end of the move: drawn while
  // the page moves, it made the movement stutter.
  const moving = transition.finished.then(end, end);
  state.moving = moving;
  void moving.then(() => {
    if (state.moving === moving) state.moving = null;
  });
  transition.ready.catch(() => {});
  return transition.updateCallbackDone;
}
/** Once the page has stopped moving (see switchView), at once when it does not move. */
function afterMove() {
  return state.moving ?? Promise.resolve();
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
    projectUI.render();
    syncViews();
    updateControls();
    showLastReply();
    if (coming) void studioUI.open().catch(error => notice(error.message));
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
      projectUI.render();
      syncViews();
      updateControls();
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
    unsendChat();
    document.body.dataset.chat = 'open';
    const agent = $('agent-open');
    if (agent) delete agent.dataset.unread;
    // A conversation already begun: in the middle of the window at once, as once a message is sent.
    if ($('messages').childElementCount) centreOpenedChat();
    const area = $('chat-area');
    if (area.scrollTo) area.scrollTo({ top: area.scrollHeight, behavior: 'instant' });
    $('prompt').focus({ preventScroll: true });
  });
}
/**
 * The chat folds back into « Agent »: Moodix AI sets the Studio, or Échap, or a click beside it
 * (`refocus`: the keyboard goes back to the button).
 */
function closeChat({ refocus = false } = {}) {
  if (document.body.dataset.chat !== 'open') return Promise.resolve();
  return switchView('close', () => {
    delete document.body.dataset.chat;
    unsendChat();
    if (refocus) $('agent-open')?.focus({ preventScroll: true });
  });
}
/**
 * A message sent from the chat opened over the Studio: the conversation comes to the middle of the
 * window, and stays there as the answer grows, its message box going down (moodix.css,
 * data-chat-sent). It moves by `translate` only, which the graphics card draws by itself.
 */
let chatCentring = null;
function centreChat() {
  const panel = $('chat-panel'),
    room = panel.offsetParent?.clientHeight || window.innerHeight;
  panel.style.setProperty('--chat-lift', Math.max(0, (room - 64 - panel.offsetHeight) / 2) + 'px');
}
function chatSent() {
  if (state.view !== 'studio' || document.body.dataset.chat !== 'open' || document.body.dataset.chatSent) return;
  const panel = $('chat-panel'),
    room = panel.offsetParent?.clientHeight || window.innerHeight;
  // From where it stands (the middle of its message box on the middle of the window, 32 px from
  // the foot of the room once sent), without a jump; then down to the middle as a whole.
  panel.style.transition = 'none';
  panel.style.setProperty('--chat-lift', Math.max(0, room / 2 - 95 - 32) + 'px');
  document.body.dataset.chatSent = 'true';
  void panel.offsetHeight;
  panel.style.removeProperty('transition');
  centreChat();
  watchChatCentring();
}
/** Opened on a conversation already begun: centred at once, without a glide from the middle. */
function centreOpenedChat() {
  const panel = $('chat-panel');
  panel.style.transition = 'none';
  document.body.dataset.chatSent = 'true';
  centreChat();
  void panel.offsetHeight;
  panel.style.removeProperty('transition');
  watchChatCentring();
}
/** Centred again as the answer grows or the window changes size. */
function watchChatCentring() {
  if (chatCentring || typeof ResizeObserver !== 'function') return;
  chatCentring = new ResizeObserver(() => {
    if (document.body.dataset.chatSent) centreChat();
  });
  chatCentring.observe($('chat-panel'));
  window.addEventListener('resize', () => {
    if (document.body.dataset.chatSent) centreChat();
  });
}
function unsendChat() {
  delete document.body.dataset.chatSent;
  $('chat-panel').style.removeProperty('--chat-lift');
}
state.onChatSent = chatSent;
$('chat-scrim').onclick = () => void closeChat({ refocus: true });
$('studio-open').onclick = () => showStudio();
$('library-open').onclick = () => showLibrary();
// The logo: back to the chat (0.5.123: there is no home page any more).
$('brand-home').onclick = event => {
  event.preventDefault();
  showChat();
};
$('chat-open').onclick = () => showChat();
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
    state.messages = [];
    state.images = [];
    state.videos = [];
    state.conversationId = null;
    rememberConversation(null);
    state.conversationInstructions = null;
    state.archiveSnapshot = null;
    state.historyDirty = false;
    $('prompt').value = '';
    generationUI.clear();
    $('messages').replaceChildren();
    $('welcome').hidden = false;
    setConversationTitle(UNTITLED);
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
document.addEventListener('keydown', event => {
  // The chat opened over the Studio folds back into its bar.
  if (
    event.key === 'Escape' &&
    document.body.dataset.chat === 'open' &&
    !event.defaultPrevented &&
    !document.querySelector('dialog[open]')
  )
    void closeChat({ refocus: true });
});
/**
 * The shortcuts under the message box (direction-artistique.md, « Zone de saisie ») put a label at
 * the start of the box (« Image × »), the one chosen underlined: they write nothing in it any more.
 * Sent, the message says what is asked (« Crée une image : … ») and the label goes.
 */
let promptLabel = null;
function setPromptLabel(button) {
  promptLabel = button ?? null;
  for (const item of document.querySelectorAll('[data-prompt]')) item.setAttribute('aria-pressed', String(item === promptLabel));
  $('prompt-label').hidden = !promptLabel;
  $('prompt-label-text').textContent = promptLabel?.dataset.label ?? '';
}
document.querySelectorAll('[data-prompt]').forEach(button => {
  button.onclick = () => {
    setPromptLabel(promptLabel === button ? null : button);
    $('prompt').focus();
  };
});
$('prompt-label-clear').onclick = () => {
  setPromptLabel(null);
  $('prompt').focus();
};
// Before the message leaves (a listener of the capture: it runs before sendMessage).
$('chat-form').addEventListener(
  'submit',
  () => {
    if (!promptLabel) return;
    const text = $('prompt').value.trim(),
      asked = promptLabel.dataset.prompt;
    if (text && !text.startsWith(asked.trim())) $('prompt').value = asked + text;
    setPromptLabel(null);
  },
  true,
);
// Images need the vision projector (checked when they are added); videos go to the library.
$('attach').onclick = () => $('image-input').click();
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

/**
 * The chat stays on its last lines while it grows or its room changes (pictures that come, the
 * message box that grows, the view shown again): it was left a little above its end. Not when the
 * reader has scrolled up.
 */
function keepChatAtBottom() {
  if (typeof ResizeObserver !== 'function') return;
  const area = $('chat-area');
  const keep = new ResizeObserver(() => {
    if (state.stickToBottom && area.clientHeight) pinChat(area);
  });
  keep.observe(area);
  keep.observe($('messages'));
}
keepChatAtBottom();
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
  state.version = initial.version || '';
  // The configuration is known: the card of the first launch may show (updateControls).
  state.booted = true;
  if (initial.version) $('settings-version').textContent = initial.version;
  void checkUpdates();
  applyTheme(initial.preferences?.theme);
  // The room kept (Paramètres › Interface), on the page from the start.
  interfaceUI.load(initial.preferences?.room);
  state.saveHistory = initial.preferences?.saveHistory === true;
  await projectUI.refresh().catch(error => notice('Projets indisponibles : ' + error.message));
  await refreshHistory();
  await assetsUI.refresh().catch(error => notice('Pellicule indisponible : ' + error.message));
  await workflowsUI.refresh();
  await restoreUpdate();
  // A page of an older version, replaced while it was open: its draft and its conversation (0.5.128).
  await resumeAfterRestart();
  // At launch, the welcome in the project used last (0.6.5).
  welcomeInLastProject();
  syncViews();
  showLastReply();
  if (initial.warning) notice(initial.warning);
  contextMeter.schedule();
  updateControls();
  // The Studio read ahead: drawn whole the first time it comes on screen.
  void studioUI.prefetch();
} catch (error) {
  // Nothing is left waiting: each action then says itself what it could not do.
  tokenKnown();
  notice(error.message);
  updateControls();
}
// The welcome of the chat comes and goes with the first message: the words of the message box and
// the line « Reprendre » follow it (« Écrivez à Moodix… » in a conversation).
const followWelcome = () => {
  $('prompt').placeholder = $('welcome').hidden
    ? 'Écrivez à Moodix…'
    : 'Une image, un plan, un son… quelques mots suffisent.';
  projectUI.renderResume();
};
new MutationObserver(followWelcome).observe($('welcome'), { attributes: true, attributeFilter: ['hidden'] });
followWelcome();
// The room (« Salle obscure », room.mjs): the light of the latest take behind the page, made once per
// take; a take ready while the page is out of sight lights a dot on the icon of its tab (logo.md).
let newestTake;
state.onTakeDone = async () => {
  const newest = await refreshLight(api);
  if (newest && newestTake !== undefined && newest !== newestTake && document.hidden) showTakeReady();
  if (newest !== undefined) newestTake = newest;
};
void refreshLight(api).then(newest => {
  if (newestTake === undefined && newest !== undefined) newestTake = newest;
});
// The references of the project at hand: « # » in the message box lists them, « #ref3 » in a
// message shows its picture under the pointer.
const projectReferences = () => assetsUI.references(state.projectId || 'inbox');
setupReferencePicker({
  input: $('prompt'),
  host: document.body,
  anchor: $('chat-form'),
  node,
  references: projectReferences,
  onPick: (item, typed) => {
    const box = $('prompt'),
      written = withReference(box.value, item.label, typed.start, box.selectionStart ?? box.value.length);
    box.value = written.text;
    box.setSelectionRange?.(written.caret, written.caret);
    resizePrompt();
  },
});
setupReferencePeek({
  root: $('messages'),
  page: document,
  node,
  lookup: number => projectReferences().find(item => item.reference === number) ?? null,
});
// An error nobody caught: said in a notice instead of a button that does nothing.
setupUnexpectedErrors({ notice, quiet: () => state.updating || state.closingApp });
setInterval(() => {
  if (!document.hidden) refreshStatus();
}, 1200);
document.addEventListener('visibilitychange', () => {
  document.documentElement.dataset.pageHidden = String(document.hidden);
  if (!document.hidden) refreshStatus();
});
