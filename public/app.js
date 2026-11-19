import { refreshLight, showTakeReady } from './room.mjs';
import { withReference, withoutReference } from './reference-tokens.mjs';
import { markReferences, removedNotice, setupReferencePeek, setupReferencePicker } from './reference-picker.mjs';
import { setupUnexpectedErrors } from './unexpected-errors.mjs';
import { setupLibrary } from './library.mjs';
import { setupCitedTakes } from './cited-takes.mjs';
import { contactSheet } from './contact-sheet.mjs';

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
import { setupMiniature } from './work-miniature.mjs';
import { setupTakeRecovery, takesOf } from './take-recovery.mjs';
import { detachedTakes, leavingQuestion, reattached, takesWord } from './detached-takes.mjs';
// When a conversation went to the bin of the history, as the fil says its dates (0.6.103).
import { shortDate } from './project-navigation.mjs';
import { takeContent } from './generation-runtime.mjs';
import { setupAssets } from './assets-ui.mjs';
import { clipPlayer } from './take-player.mjs';
import { setupCopy } from './copy.mjs';
import { STUDIO_LINE, STUDIO_NOTE, callNote, closedCalls, conversationTitle, lastExchange, settledNotes, spokenText } from './transcript.mjs';
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
import { setupRemoteModels } from './remote-llm-ui.mjs';
import { setupModelChoice } from './model-choice.mjs';
import { runSeries } from './image-series.mjs';
import { setupFirstLaunch } from './first-launch.mjs';
import { missingFileCard } from './missing-file.mjs';
import { setupGlassSelects } from './glass-menu.mjs';
import { reflection, thoughtTime } from './reflection.mjs';
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
/** The mark of a reply moves while its model thinks: reasoning has come, the answer not yet. */
function markThinking(view, thinking) {
  view.article.querySelector('.message-avatar')?.classList.toggle('is-thinking', thinking);
}
/**
 * A message sent while the model loads (etats-maquette.md, 51): beside « MOODIX », « LE MODÈLE SE
 * CHARGE · 0:42 », the time gone by; under it, what happens. Failed, the same line says why in
 * amber, with « Réessayer ». `waiting`: what the line says meanwhile (0.6.99: after a creation, its
 * takes are there and Moodix AI comes back from the card to answer).
 */
function modelLoading(
  view,
  waiting = 'Votre message partira dès que Moodix AI sera prêt. Le premier chargement peut prendre quelques minutes.',
) {
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
      line.textContent = waiting;
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
/**
 * This tab, for the server (0.6.86): the page that starts a generation is the one that follows it
 * again once reloaded (the same tab, its storage kept); a page of another tab follows it only once
 * that one is gone (take-recovery.mjs). Each opening but a reload is a tab of its own (a tab
 * duplicated copies the storage of the first).
 */
const TAB = (() => {
  const key = 'moodix.tab',
    made = () => globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  try {
    const reload = performance.getEntriesByType?.('navigation')?.[0]?.type === 'reload',
      kept = reload ? sessionStorage.getItem(key) : null;
    if (kept) return kept;
    const tab = made();
    sessionStorage.setItem(key, tab);
    return tab;
  } catch {
    return made();
  }
})();
async function api(route, body, options = {}) {
  await pageReady;
  const { raw = false, headers: extraHeaders = {}, again = false, ...requestOptions } = options;
  const used = state.token;
  const response = await fetch(`/api/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${used}`,
      'Content-Type': raw ? 'application/octet-stream' : 'application/json',
      'X-Moodix-Tab': TAB,
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
      // A save on a copy older than the disk's (0.6.103): the conversation is read again.
      stale: data.stale === true,
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
    // The revision of it this page read (0.6.103): the page that comes saves on it.
    revision: state.revisions?.get(state.conversationId),
  };
  for (const less of [kept, { ...kept, images: [] }, { ...kept, images: [], messages: [], archiveSnapshot: null }])
    try {
      sessionStorage.setItem(RESUME, JSON.stringify(less));
      return;
    } catch {
      // Too large for the tab: less of it.
    }
}

/**
 * The conversation shown and its draft as an update or « Redémarrer » keeps them for the page that comes
 * back (restoreUpdate): with the revision it read (0.6.103), and without the history the conversation
 * set aside too, found nowhere else (it was lost there without a word).
 */
function sessionOfPage() {
  const aside = state.aside,
    revision = state.revisions?.get(state.conversationId);
  return {
    messages: state.messages,
    archiveSnapshot: state.archiveSnapshot,
    conversationId: state.conversationId,
    conversationInstructions: state.conversationInstructions,
    prompt: $('prompt').value,
    images: state.images,
    thinking: state.thinking,
    title: $('conversation-title').textContent,
    ...(Number.isInteger(revision) ? { revision } : {}),
    ...(!state.saveHistory && aside?.conversationId && aside.messages?.length
      ? {
          aside: compactSession({
            messages: aside.messages,
            archiveSnapshot: aside.archiveSnapshot,
            conversationId: aside.conversationId,
            conversationInstructions: aside.conversationInstructions,
            projectId: aside.projectId || 'inbox',
            prompt: aside.draft?.text ?? '',
            images: (aside.draft?.images ?? []).map(({ source, ...image }) => image),
            thinking: state.thinking,
            title: aside.title || '',
          }),
        }
      : {}),
  };
}

let historyWrite = Promise.resolve();
let historyDeleteTarget = null;
function confirmHistoryDeletion(item = null) {
  historyDeleteTarget = item;
  // To the bin, 30 days (0.6.103): said as it is, no longer « supprimée … définitivement ».
  $('history-delete-title').textContent = item ? 'Mettre cette conversation à la corbeille ?' : 'Mettre tout l’historique à la corbeille ?';
  $('history-delete-description').textContent = item
    ? '« ' +
      item.title +
      ' » ira dans la corbeille de l’historique, avec ses prises. Vous pourrez la restaurer pendant 30 jours depuis Paramètres › Application ; ensuite, elle sera effacée. Les fichiers originaux restent à leur emplacement. Le brouillon de saisie sera conservé.'
    : 'Toutes les conversations iront dans la corbeille de l’historique, avec leurs prises. Vous pourrez les restaurer pendant 30 jours depuis Paramètres › Application ; ensuite, elles seront effacées. Les fichiers originaux restent à leur emplacement. L’échange affiché sera fermé ; le brouillon de saisie sera conservé.';
  $('history-delete-error').hidden = true;
  if (!$('history-delete-dialog').open) $('history-delete-dialog').showModal();
}

/** `keep`: a menu of the fil open stays open (a save during a work, while the user navigates). */
function renderHistory(options) {
  projectUI.render(options);
}

/** `unnamed`: only while the conversation has no name yet (it is named once, by its first message). */
function setConversationTitle(title, { unnamed = false } = {}) {
  if (unnamed && !untitled($('conversation-title').textContent)) return;
  $('conversation-title').textContent = title;
  renderHistory();
}

/**
 * The name of the conversation in four words at most, asked to the chat model once it has answered
 * (POST /api/history/title, lib/conversation-title.mjs): the picture it opened on described, or its
 * first words summed up. Asked at the end of its first three turns at most, until the model is free
 * to answer; the name made of the first message stays meanwhile, and whenever it cannot.
 * Named after the first of its three first messages that gives something to name it from (the
 * server chooses): a conversation that opened on pictures alone, or on a creation of the Studio
 * made without a prompt, was never named, whatever was written next.
 */
async function nameConversation(messages, conversationId) {
  if (!state.saveHistory || !conversationId || state.named?.has(conversationId)) return;
  // What the user wrote and what they made in the Studio (its prompt): not what the application
  // writes for the model (the copies of a creation it looks at).
  const said = messages.filter(
    message =>
      message?.role === 'user' &&
      !message.resourceId &&
      !message.outputId &&
      (!message.internal || (typeof message.content === 'string' && STUDIO_LINE.test(message.content))),
  );
  if (!said.length || said.filter(message => !message.internal).length > 3) return;
  // The first as it is (a picture it opens on names it); of the next two, the words alone.
  const words = message =>
    typeof message.content === 'string' ? message.content : (message.content ?? []).filter(part => part?.type === 'text');
  try {
    const answer = await (
      await api('history/title', { id: conversationId, contents: [said[0].content, ...said.slice(1, 3).map(words)] })
    ).json();
    if (answer.later) return;
    (state.named ??= new Set()).add(conversationId);
    const named = answer.conversation;
    if (!named?.title) return;
    state.historyItems = (state.historyItems || []).map(item => (item.id === named.id ? { ...item, title: named.title } : item));
    // Set aside meanwhile, or followed by the miniature (0.6.81): its name there too.
    if (state.aside?.conversationId === named.id) state.aside.title = named.title;
    if (state.miniature?.work?.conversationId === named.id) state.miniature.rename(named.title);
    // Only what its name changes is drawn again: the whole navigation drawn anew closed the menu
    // open meanwhile (a list of conversations and what was typed in its search field). A list open
    // on the former name keeps it until it is opened next.
    if (state.conversationId === named.id) {
      $('conversation-title').textContent = named.title;
      // The button of the fil says it too, unless the Pellicule shows another name in its place.
      if (!$('conversation-title').hidden)
        $('thread-conversation').setAttribute('aria-label', 'Conversation : ' + named.title);
    }
    projectUI.renderResume();
  } catch {
    // The name made of the first message stays.
  }
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
  // By their names (0.6.103): one whose file could not be read and whose version before was taken
  // back; one that cannot be read at all, listed as such (it was left out, a count said so).
  const named = items => items.map(item => `« ${item.title || 'Sans titre'} »`).join(', '),
    recovered = result.recovered ?? [],
    damaged = (result.conversations ?? []).filter(item => item.unreadable);
  if (recovered.length)
    notice(`${named(recovered)} : son fichier était abîmé, sa version précédente a été reprise.`);
  else if (damaged.length)
    notice(`${named(damaged)} ne peut pas être lue : son fichier est gardé tel quel. Ouvrez-la dans la liste pour savoir quoi faire.`);
  else if (result.skipped)
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

function persistConversation(conversationId = state.conversationId) {
  // A work saves its own conversation, on screen or set aside while the user looks elsewhere (0.6.81).
  const talk = holderOf(conversationId),
    snapshot = talk.archiveSnapshot || { messages: talk.messages ?? [], incomplete: false };
  if (!state.saveHistory || state.disablingHistory || !snapshot.messages.length) return Promise.resolve(true);
  const projectId = talk.projectId || 'inbox';
  const id = (talk.conversationId ||= crypto.randomUUID());
  // Taken up by another tab (0.6.103: a save refused, or found so after a wait): nothing more of this
  // page's older copy is written until it is read again (readAgain, once its work is over).
  if (state.staleIds?.has(id)) return Promise.resolve(false);
  if (talk === state) rememberConversation(id);
  const instructions = talk.conversationInstructions || '';
  talk.historyDirty = true;
  historyWrite = historyWrite.then(async () => {
    if (!state.saveHistory) return true;
    state.savingHistory = true;
    // The revision of it this page read or wrote last (0.6.103), read as the save leaves (one queued
    // behind another takes the revision that one gave): written by another tab since, refused.
    const revisions = (state.revisions ??= new Map()),
      revision = revisions.get(id);
    try {
      const { conversation } = await (
        await api('history/save', {
          id,
          ...snapshot,
          messages: withoutCopies(snapshot.messages),
          instructions,
          projectId,
          ...(Number.isInteger(revision) ? { revision } : {}),
        })
      ).json();
      if (Number.isInteger(conversation.revision)) revisions.set(id, conversation.revision);
      state.historyItems = [conversation, ...state.historyItems.filter(item => item.id !== id)].sort(
        (a, b) => (b.createdAt || b.updatedAt).localeCompare(a.createdAt || a.updatedAt) || a.id.localeCompare(b.id),
      );
      // Where it is now: it may have been set aside, or taken back, meanwhile.
      const now = holderOf(id);
      if (now.conversationId === id && (!now.archiveSnapshot || now.archiveSnapshot === snapshot)) now.historyDirty = false;
      // The bar says the name the history keeps (the one given by the user, else its first message).
      if (state.conversationId === id && typeof conversation.title === 'string' && conversation.title)
        $('conversation-title').textContent = conversation.title;
      else if (now === state.aside && typeof conversation.title === 'string' && conversation.title) now.title = conversation.title;
      // A menu of the fil open meanwhile stays open (any page may be opened during a work, 0.6.81).
      renderHistory({ keep: true });
      return true;
    } catch (error) {
      // Another tab wrote it since this one read it (0.6.103): read again, what is being written in the
      // message box kept. It was written over before: ten images of the other tab left the conversation.
      if (error.stale) {
        void readAgain(id);
        return false;
      }
      notice(`Historique non enregistré : ${error.message} La conversation reste dans la page.`);
      return false;
    } finally {
      state.savingHistory = false;
      projectUI.sync();
    }
  });
  return historyWrite;
}
/**
 * Conversation `id` written meanwhile by another tab (0.6.103): its copy of the disk takes the place of
 * this page's, said simply; what is being written in the message box stays there. Not while a work of
 * this page goes on in it (said; read again once it is opened next), nor for one set aside (it leaves the
 * page: the copy of the disk is the newer one).
 */
async function readAgain(id) {
  // A work of this page goes on in it (the first save of a message refused): read again once it is over
  // (endWork), what it wrote in the box kept.
  if (state.generating || state.work?.conversationId === id) {
    (state.staleIds ??= new Set()).add(id);
    return;
  }
  if (state.aside?.conversationId === id) dropAside();
  if (!shownHere(id)) {
    notice('Cette conversation a changé dans un autre onglet : ce que cet onglet y a fait n’a pas été enregistré. Rouvrez-la pour voir sa dernière version.');
    return;
  }
  try {
    const known = state.revisions?.get(id),
      record = await (await api(`history/${encodeURIComponent(id)}`)).json();
    if (!shownHere(id) || state.generating) return;
    // Not written there after all (a creation of another tab only went on in it): this page's copy stands.
    if (Number.isInteger(known) && record.revision === known) return;
    (state.revisions ??= new Map()).set(id, record.revision);
    const messages = closedCalls(record.messages),
      last = messages.at(-1),
      written = Boolean($('prompt').value.trim() || state.images.length || state.videos.length);
    // Its last message unsent, as when it is opened: in the box when the box is empty (the line of the
    // thread says it waits there), or out of the thread when the box holds it already; else it stays in
    // the thread, the box keeping what this tab was writing.
    if (record.incomplete && last?.role === 'user' && !last.internal) {
      const asked = savedUser(last);
      if (!written) {
        messages.pop();
        $('prompt').value = asked.text;
        state.images = [...asked.images];
        state.videos = [...asked.videos];
        renderAttachments();
        resizePrompt();
      } else if ($('prompt').value.trim() === asked.text.trim()) messages.pop();
    }
    state.messages = messages;
    state.archiveSnapshot = { messages: record.messages, incomplete: record.incomplete };
    state.historyDirty = false;
    const views = rerender(id);
    setConversationTitle(record.title);
    notice(
      'Cette conversation a changé dans un autre onglet : elle a été rechargée.' +
        (written ? ' Ce que vous écriviez est resté dans la zone de saisie.' : ''),
    );
    // As when it is opened: what its calls made, written in it (take-recovery.mjs); the takes of this tab
    // that the copy of the other no longer names, said with « Les remettre ».
    void state.recovery?.complete(id, views);
    void offerDetached(id);
  } catch (error) {
    notice(error.message);
  }
}
/**
 * Whether another tab took conversation `id` up while this page waited for the model (0.6.103): « job », a
 * creation of that tab goes on in it; « written », it wrote it since (its revision on the disk is no longer
 * the one this page wrote last, once its own saves are over); else false. Marked then: this page writes
 * nothing more of its copy, read again once its work is over (endWork).
 */
async function takenElsewhere(id) {
  if (!id) return false;
  const job = state.status?.toolJob;
  let taken = job?.conversationId === id && job.owner && job.owner !== TAB && !job.ownerLeft && !job.ownerAway ? 'job' : false;
  if (!taken && state.saveHistory) {
    await historyWrite;
    const known = state.revisions?.get(id);
    if (Number.isInteger(known))
      try {
        const record = await (await api(`history/${encodeURIComponent(id)}`)).json();
        if (Number.isInteger(record.revision) && record.revision !== known) taken = 'written';
      } catch {
        // Not read: nothing is held for it, the save that follows still checks its revision.
      }
  }
  if (taken) (state.staleIds ??= new Set()).add(id);
  return taken;
}
/**
 * The end of the generation the server is making, if any (0.6.84): it keeps every save of the
 * history until then (/api/history/save), and one stopped still hands the card back for a few
 * seconds, the chat model coming back after it (a take made to its end is waited for so already).
 * Saved before, a stop said « Historique non enregistré : Attendez la fin de la génération. » and was
 * not kept. Not waited for when the card is held (54): only « Libérer le GPU » ends that. Only for
 * conversation `id`, the one whose take is being made (0.6.86: the server saves the others); ten
 * minutes at most, as long as the server may take to hand the card back and bring a local chat
 * model back (three minutes before 0.6.86: past them, the save was still refused).
 */
async function generationOver(id = state.conversationId) {
  for (const until = Date.now() + 600000; Date.now() < until; ) {
    let job;
    try {
      job = (await (await api('status')).json())?.toolJob;
    } catch {
      return;
    }
    if (!job || job.blocked || (job.conversationId && job.conversationId !== id)) return;
    await new Promise(resolve => setTimeout(resolve, 700));
  }
}
/**
 * A conversation begun for a creation of the Studio that made nothing (0.6.82: it is saved as the
 * creation starts): it leaves the history again, as it never came before. Kept when it cannot go: its
 * call reads « demande restée sans suite ».
 */
async function forgetConversation(id, reason = 'studio-empty') {
  if (!state.saveHistory || !state.historyItems.some(item => item.id === id)) return;
  try {
    await historyWrite;
    // Never with a take (0.6.87): deleted, a conversation takes its takes with it (their records are
    // in its folder). Kept when that cannot be read: in doubt, nothing is deleted. A record the gallery
    // cannot read is one too (0.6.89: `skipped`, it counted as none).
    const { runs = [], skipped = 0 } = await (await api(`gallery/${encodeURIComponent(id)}?images=0`)).json();
    if (runs.length || Number(skipped) > 0) return;
    // Its `reason` said (0.6.103): the server looks at the disk (nothing of the user, no take) before it
    // goes, to the bin, with a line in its journal; nothing on screen changes.
    await api('history/delete', { confirm: true, id, reason });
    state.historyItems = state.historyItems.filter(item => item.id !== id);
    const talk = holderOf(id);
    if (talk === state || talk === state.aside) talk.archiveSnapshot = null;
    renderHistory({ keep: true });
  } catch {
    // Left in the history: deleted by hand like any other.
  }
}

async function clearHistory() {
  if (state.clearingHistory) return;
  const target = historyDeleteTarget;
  // Never during a work (0.6.81): its take would be written in a conversation gone. (The server
  // refuses while a generation runs or Moodix answers, not while a card waits for the user.)
  if (state.work || state.generating) {
    $('history-delete-error').textContent = 'Attendez la fin de la génération en cours pour supprimer.';
    $('history-delete-error').hidden = false;
    return;
  }
  state.clearingHistory = true;
  state.loadingHistory = true;
  $('history-delete-error').hidden = true;
  updateControls();
  try {
    await historyWrite;
    await api(target ? 'history/delete' : 'history/clear', { confirm: true, ...(target ? { id: target.id } : {}) });
    forgetCopies(target?.id ?? null);
    state.historyItems = target ? state.historyItems.filter(item => item.id !== target.id) : [];
    // The conversation set aside goes with it (its work is over: deleting one is refused during a work).
    if (state.aside && (!target || target.id === state.aside.conversationId)) dropAside();
    // And the miniature of a work over in a conversation deleted, wherever it was (0.6.87: of the one
    // shown, « Prise prête » stayed after « Effacer l'historique », and its click could not read it).
    const shown = state.miniature?.work?.conversationId;
    if (shown && !state.miniature.running && (!target || target.id === shown)) state.miniature.forget();
    if (!target || target.id === state.conversationId) {
      state.messages = [];
      state.conversationId = null;
      state.conversationInstructions = null;
      state.archiveSnapshot = null;
      state.historyDirty = false;
      generationUI.clear(state.aside?.nodes);
      $('messages').replaceChildren();
      $('welcome').hidden = false;
      setConversationTitle(UNTITLED);
      state.studio?.conversationChanged?.();
    }
    renderHistory();
    // Deleted from the fil of the Pellicule: its takes leave the sheet.
    if (state.view === 'library') void libraryUI.refresh();
    notice('');
    $('live-status').textContent = target ? 'Conversation mise à la corbeille.' : 'Historique mis à la corbeille.';
    // The bin of Paramètres › Application says it at once when it is open (0.6.103).
    void refreshTrash();
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

/**
 * The Chat in place of the Pellicule, for a conversation opened or begun from there (the Studio on
 * screen stays): as by its tab, the sound playing in the Pellicule stops and the line goes under
 * « Chat ». (Set by hand, the view changed and the sound went on with nothing left to stop it.)
 */
function leaveLibrary() {
  if (state.view === 'studio') return;
  if (state.view === 'library') state.hushLibrary?.();
  state.view = 'chat';
  tabLine();
}

/**
 * Before the conversation shown is left (another opened, a new one, the Pellicule): it is saved. Not
 * while a generation runs, when nothing new waits in it or its own work saves it at its end (0.6.82):
 * the server keeps every save for the end of a generation (/api/history/save), and asked then, each
 * page opened during a generation said « Cette conversation n’a pas pu être enregistrée » (0.6.81),
 * the Pellicule did not open.
 */
function saveBeforeLeaving() {
  if (state.status?.toolJob && (!state.historyDirty || state.work?.conversationId === state.conversationId))
    return Promise.resolve(true);
  return persistConversation();
}

async function loadConversation(id) {
  // Any conversation opens while a work goes on (0.6.81): the one it goes on in is set aside, alive.
  if (!state.projectWorking && !state.preparing && !state.loadingHistory && id === state.conversationId) {
    leaveLibrary();
    projectUI.render();
    // Chosen in the fil while it is open (0.6.103): its last lines, and the line of a message that waits
    // in the box drawn again, seen. It did nothing a user could see: « my conversation is gone ».
    unsentNote({ called: true });
    state.stickToBottom = true;
    scrollToBottom();
    $('prompt').focus();
    return;
  }
  if (settingsGuard.isDirty()) return requestSettingsClose(() => loadConversation(id));
  if (state.projectWorking || state.preparing || state.loadingHistory) return;
  state.loadingHistory = true;
  updateControls();
  let setNow = false;
  // Where what is written in the one shown is kept, if it is left (keepDraft).
  const from = leftKey(state.conversationId, state.projectId);
  try {
    // A conversation that cannot be saved must not trap the user in it.
    if (
      !(await saveBeforeLeaving()) &&
      !confirm('Cette conversation n’a pas pu être enregistrée. Ouvrir l’autre conversation quand même ?')
    )
      return;
    // The one set aside comes back as it was left; the one left while its work goes on is set aside.
    const returning = state.aside?.conversationId === id ? state.aside : null;
    // Set aside in place of another, without the history: that one is lost, asked first (0.6.87).
    if (!returning && state.work?.conversationId === state.conversationId && !asideMayGo()) return;
    if (returning) state.aside = null;
    // Without the history, the one shown takes the place of the one coming back (0.6.103): left, it was
    // lost without a word, found nowhere else.
    setNow = setAside(Boolean(returning) && !state.saveHistory && state.messages.length > 0);
    // What was written in the one left, when it is not set aside with it: back when it is opened again.
    if (!setNow) keepDraft();
    if (returning) {
      takeBackAside(returning);
      leaveLibrary();
      turnActions();
      $('settings').close();
      renderAttachments();
      resizePrompt();
      state.stickToBottom = true;
      scrollToBottom();
      state.studio?.conversationChanged?.();
      return;
    }
    const record = await (await api(`history/${id}`)).json();
    // One saved with a call left without its result (before 0.6.31) is read with one.
    const messages = closedCalls(record.messages);
    const asked =
      record.incomplete && messages.at(-1)?.role === 'user' && !messages.at(-1).internal ? savedUser(messages.pop()) : null;
    // Or what was being written in it when it was left (keepDraft, 0.6.87): what the box held then,
    // that message in it when it was there (0.6.88: both, it came back once more at each visit).
    const left = draftLeft(id),
      draft = left ?? { text: asked?.text ?? '', images: asked?.images ?? [], videos: asked?.videos ?? [] };
    state.conversationId = id;
    rememberConversation(id);
    // The revision read (0.6.103): its saves go on from it, refused if another tab wrote it since.
    (state.revisions ??= new Map()).set(id, record.revision);
    state.conversationInstructions = record.instructions || '';
    state.messages = messages;
    state.projectId = record.projectId || 'inbox';
    // Chat and Studio are two views of the same conversation: the one on screen stays.
    leaveLibrary();
    state.archiveSnapshot = { messages: record.messages, incomplete: record.incomplete };
    state.historyDirty = false;
    state.images = draft.images;
    state.videos = draft.videos;
    $('prompt').value = draft.text;
    generationUI.clear(state.aside?.nodes);
    $('messages').replaceChildren();
    // A take deleted since (in the Pellicule, in the Studio) is not drawn from what was read before.
    citedTakes.forget();
    // A call whose take the server is still making waits for its card (0.6.82).
    const views = renderTranscript(messages, record.incomplete, { waiting: state.recovery?.waiting(id, messages) });
    turnActions();
    // Its last message unsent, put back in the box: said where the thread ends (0.6.103), never the
    // welcome of a new conversation.
    unsentNote();
    setConversationTitle(record.title);
    $('settings').close();
    renderAttachments();
    resizePrompt();
    state.stickToBottom = true;
    scrollToBottom();
    state.studio?.conversationChanged?.();
    $('prompt').focus();
    // What its calls made while no page followed them: written, shown, or followed (take-recovery.mjs).
    void state.recovery?.complete(id, views);
    // Takes of it that no message shows any more: said, and put back on a click (0.6.99).
    void offerDetached(id);
  } catch (error) {
    // Not opened: the conversation set aside for it is the one on screen again, as it was.
    if (setNow && state.aside?.conversationId === state.conversationId) takeBackAside();
    // Not left either: what keepDraft kept of it is still in its box, and is not to come back once
    // sent (0.6.88).
    else if (!setNow && leftKey(state.conversationId, state.projectId) === from) state.draftsLeft?.delete(from);
    notice(error.message);
  } finally {
    state.loadingHistory = false;
    updateControls();
    contextMeter.schedule();
    $('prompt').focus();
  }
}

/**
 * The messages of a conversation read back. `waiting`: the calls whose take the server is still making
 * (take-recovery.mjs, 0.6.82): their card comes under them, nothing says « sans suite ». Gives the view
 * of each message of Moodix by its place in `messages`.
 */
function renderTranscript(messages, incomplete = false, { waiting = null } = {}) {
  // Every tool other than the local readers is a generation verb, including names used by older versions.
  const isGeneration = call => Boolean(call.function?.name) && !call.function.name.startsWith('local_');
  const views = new Map();
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
      views.set(index, view);
      const made = Boolean(waiting?.has(message.tool_calls?.find(isGeneration)?.id));
      // A call the model wrote as text is not shown, as while a reply arrives; a call that left
      // no media is told in a line of its own words, not the result kept for the model.
      const text = spokenText(message.content);
      if (text) renderText(view.body, text);
      else if (made) view.body.replaceChildren();
      else if (message.tool_calls?.length) {
        const told = callNote(message.tool_calls[0], messages[index + 1]);
        view.body.replaceChildren(...(told ? [node('div', 'message-step', told)] : []));
      } else
        view.body.textContent = message.content
          ? 'Le modèle a écrit un appel d’outil au lieu de le lancer : rien n’a été généré.'
          : 'Aucune réponse finale reçue.';
      // The takes it names, small under its words.
      if (text) citedTakes.show(view, text);
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
          // Several images made in one call (its `series`): each of them, in their order.
          else if (Array.isArray(data?.images) && data.images.some(image => typeof image?.run_id === 'string')) {
            if (!text) view.body.replaceChildren();
            for (const image of data.images) if (typeof image?.run_id === 'string') generationUI.restore(view.generations, state.conversationId, image.run_id, { compact: data.studio === true });
            // Fewer images than asked: where it stopped, under them (« Série interrompue avant sa fin :
            // 1 image sur 3 a été faite. », a reload, 0.6.82; stopped by the user; an image refused).
            // (Not while its next image is still being made: its card says it.)
            if (data.status === 'partial' && typeof data.message === 'string' && data.message && !made)
              view.generations.append(node('p', 'proposal-cancelled', data.message));
          }
          // « Annuler » of a card: its line, where the card was (16/11); declined otherwise, nothing.
          if (data?.status === 'denied' && data.cancelled === 'card')
            view.generations.append(node('p', 'proposal-cancelled', 'Proposition annulée.'));
          // A card left without an answer (the page closed while it waited): said where it was.
          if (data?.status === 'cancelled' && data.unanswered === true && text && !made)
            view.generations.append(node('p', 'proposal-cancelled', 'Proposition restée sans réponse.'));
        } catch {}
      }
      if (view.thought) view.thought.restore(message.reasoning_content || '', message.reasoning_seconds);
      else {
        view.reasoning.hidden = !message.reasoning_content;
        view.thoughts.textContent = message.reasoning_content || '';
      }
      if (incomplete && index === messages.length - 1) view.note.textContent = 'Réponse partielle restaurée.';
    }
  }
  return views;
}

/**
 * Takes of the conversation shown that no message shows any more (0.6.99): an exchange taken back
 * (« Régénérer », « Modifier »: until 0.6.99 they said nothing of the takes they took away), or a tab
 * left on an older copy that wrote it over. Ten images of a series were in `output` and in the
 * Pellicule, and no longer in their conversation. A quiet line at the foot of the thread says so;
 * « Les remettre » writes their call and its result back from their records (detached-takes.mjs).
 * Not while a creation of this conversation is being made (its take is there before its result) or a
 * reply is written, here or in another tab; never for takes made by hand in the Studio, deleted, or
 * of a call still open (take-recovery.mjs completes those).
 */
async function offerDetached(id = state.conversationId) {
  if (!id || !state.saveHistory) return;
  let runs;
  try {
    runs = (await (await api(`gallery/${encodeURIComponent(id)}?images=0`)).json()).runs ?? [];
  } catch {
    return;
  }
  const job = state.status?.toolJob;
  if (
    !shownHere(id) ||
    state.generating ||
    state.work?.conversationId === id ||
    state.status?.busy ||
    (job && job.conversationId === id && !['done', 'error', 'cancelled'].includes(job.state))
  )
    return;
  const groups = detachedTakes(state.messages, runs);
  if (!groups.length) return;
  const count = groups.reduce((sum, group) => sum + group.detached, 0),
    line = node('p', 'takes-detached'),
    again = node('button', 'text-button message-retry', 'Les remettre');
  again.type = 'button';
  again.onclick = () => void putBack(id, groups, line);
  line.append(node('span', '', `${takesWord(count)} de cette conversation ${count > 1 ? 'ne sont' : 'n’est'} plus dans le fil.`), again);
  $('messages').append(line);
}
/** « Les remettre » (0.6.99): the takes of `groups` written back in their conversation, still the one shown. */
async function putBack(id, groups, line) {
  if (!shownHere(id) || state.generating || state.work) return;
  // Its last message left unsent in the message box (loadConversation) stays the last one.
  const kept = state.archiveSnapshot,
    last = kept?.incomplete ? kept.messages?.at(-1) : null,
    unsent = last?.role === 'user' && !last.internal && state.messages.at(-1)?.role !== 'user' ? [last] : [];
  let messages = state.messages;
  for (const group of groups) messages = reattached(messages, group);
  state.messages = messages;
  state.archiveSnapshot = { messages: [...archiveMessages(messages), ...unsent], incomplete: unsent.length > 0 };
  line.remove();
  rerender(id);
  await persistConversation(id);
}

/**
 * Without the history, the conversation set aside when the application started again (an update,
 * « Redémarrer », 0.6.103): drawn in a page of its own and set aside again beside the one shown; the fil
 * lists it (project-navigation.mjs). It was lost there, found nowhere else.
 */
function restoreAside(saved) {
  restoreSession(saved);
  const nodes = document.createDocumentFragment();
  nodes.append(...$('messages').childNodes);
  state.aside = {
    conversationId: saved.conversationId,
    projectId: saved.projectId || 'inbox',
    conversationInstructions: state.conversationInstructions,
    messages: state.messages,
    archiveSnapshot: state.archiveSnapshot,
    historyDirty: false,
    title: saved.title || '',
    draft: { text: saved.prompt || '', images: saved.images || [], videos: [] },
    nodes,
  };
  state.messages = [];
  state.conversationId = null;
  state.archiveSnapshot = null;
}

async function restoreUpdate() {
  const saved = await (await api('updates/session')).json();
  if (!saved) return;
  if (saved.aside) restoreAside(saved.aside);
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
  state.messages = closedCalls(saved.messages);
  state.conversationId = saved.conversationId;
  // The revision the page before had of it (0.6.103); one of an earlier version gives none.
  if (saved.conversationId && Number.isInteger(saved.revision)) (state.revisions ??= new Map()).set(saved.conversationId, saved.revision);
  state.conversationInstructions = saved.conversationInstructions ?? (saved.messages.length ? '' : null);
  state.archiveSnapshot = saved.archiveSnapshot;
  state.historyDirty = false;
  state.images = saved.images;
  state.thinking = saved.thinking;
  $('prompt').value = saved.prompt;
  $('thinking').setAttribute('aria-pressed', String(state.thinking));
  generationUI.clear(state.aside?.nodes);
  $('messages').replaceChildren();
  const views = renderTranscript(state.messages, saved.archiveSnapshot?.incomplete);
  turnActions();
  // (Its message unsent said where the thread ends, 0.6.103.)
  unsentNote();
  setConversationTitle(saved.title || UNTITLED);
  const restored = state.historyItems.find(item => item.id === state.conversationId);
  state.projectId = restored?.projectId || 'inbox';
  state.view = 'chat';
  renderAttachments();
  resizePrompt();
  renderHistory();
  scrollToBottom();
  contextMeter.schedule();
  // A take made just before the server stopped: its call is given it (0.6.82).
  void state.recovery?.complete(state.conversationId, views);
  // Takes of it that no message shows any more (0.6.99): said after an update too.
  void offerDetached(state.conversationId);
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
      session: compactSession(sessionOfPage()),
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
    // The takes that failed in the conversation say it too (after the page's first run: the UI
    // of the creations is made by then).
    queueMicrotask(() => generationUI.held(held));
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
  // To the bin, 30 days (0.6.103): « Supprimer définitivement » is the bin's own, for one conversation.
  $('history-delete-confirm').textContent = state.clearingHistory ? 'Mise à la corbeille…' : 'Mettre à la corbeille';
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
        : s.remote || state.config.modelPath
          ? 'Démarrer le modèle'
          : 'Aucun LLM enregistré · ouvrir les paramètres';
  $('toggle-engine').className =
    'engine-button ' +
    (paused ? 'is-paused' : running ? (s.state === 'ready' ? 'is-running' : 'is-running is-busy') : 'is-off');
  $('toggle-engine').setAttribute('aria-label', engineLabel);
  $('toggle-engine').title = engineLabel;
  // One icon whatever the state (⏻): the dot beside it says it (moodix.css, engine-button::after).
  $('toggle-engine').replaceChildren(icon('power'));
  // The capsule of the top bar names the model beside its switch (0.6.0); a remote one says so,
  // whatever leaves the computer with it (remote-llm-ui.mjs).
  const model = s.remote ? { name: s.remote.name } : (state.models || []).find(item => item.modelPath === state.config.modelPath);
  $('engine-remote').hidden = !s.remote?.leaves;
  $('engine-remote').title = s.remote?.leaves
    ? `Modèle de chat distant : vos messages partent chez ${s.remote.kind === 'chatgpt' ? 'OpenAI (ChatGPT)' : s.remote.host}.`
    : '';
  $('engine-name').textContent =
    model?.name ||
    (state.config.modelPath ? state.config.modelPath.split(/[\\/]/).pop().replace(/\.gguf$/i, '') : 'Aucun LLM');
  // A work goes on in another conversation than the one shown (0.6.81): this one is read and written
  // in, its message waits for the end of that one (greyed, the reason said), and nothing of it is
  // stopped or declined from here.
  const away = state.work && !shownHere(state.work.conversationId) ? workHeld() : '';
  // A proposal waits (in the Studio, or in a card of the conversation): a new message declines it.
  const proposing = !away && Boolean(state.studio?.proposing?.() || state.proposalCard);
  // Whether a message would not leave now, whatever it says (0.6.90): « Régénérer » asks nothing then
  // (takeBack), its question would let the conversation set aside go for a message that stays.
  state.sendHeld = Boolean(
    state.projectWorking ||
      toolBusy ||
      away ||
      !state.connected ||
      s.state === 'stopping' ||
      (s.busy && !proposing) ||
      (state.generating && !proposing) ||
      state.preparing ||
      state.operation ||
      state.loadingHistory,
  );
  $('send').disabled = state.sendHeld || (!$('prompt').value.trim() && !state.images.length && !state.videos.length);
  $('send').hidden = !away && ((state.generating && !proposing) || toolBusy);
  if (away && $('send').dataset) $('send').dataset.tip = away;
  else if ($('send').dataset?.tip) delete $('send').dataset.tip;
  // Interrompre only while something runs: Moodix thinking or writing, a generation (16/11). A
  // proposal waiting for the user (a card, the Studio) runs nothing: a new message declines it.
  $('cancel').hidden = Boolean(away) || proposing || (!state.generating && (!toolBusy || s.toolJob.blocked));
  const cancelLabel = state.waitingForModel ? 'Annuler le message en attente' : 'Interrompre la réponse';
  // The model loading under a message sent: « EN ATTENTE » and « Annuler », in words (51).
  $('cancel').classList.toggle('is-word', Boolean(state.waitingForModel));
  // Before the first message (etats-maquette.md, 50): no engine or no LLM, the card in place of
  // the message box, without shortcuts nor « Reprendre ».
  if (state.booted) {
    // A remote model chosen (remote-llm-ui.mjs) needs neither engine nor file.
    const setup = !s.remote && !(state.config.enginePath && state.config.modelPath);
    document.body.dataset.setup = setup ? 'incomplete' : 'done';
    firstLaunchCard().sync(setup);
  }
  $('cancel').setAttribute('aria-label', cancelLabel);
  $('cancel').title = cancelLabel;
  $('thinking').disabled = state.generating;
  // The model and its reflection, chosen in the bar of the chat (model-choice.mjs): never while it answers.
  $('model-choice').disabled = $('effort-choice').disabled = state.generating || toolBusy || !state.connected;
  state.modelChoice?.render();
  // A card of Moodix waits: an image may go with the message that answers it (in its conversation).
  $('attach').disabled = Boolean(away) || (state.generating && !state.proposalCard) || state.preparing || state.loadingHistory;
  // Its usual words come back once the work is over.
  const attach = $('attach');
  if (away && attach.dataset) {
    attach.dataset.idleTip ??= attach.dataset.tip || '';
    attach.dataset.tip = 'Joindre un fichier à la fin de la génération en cours';
  } else if (attach.dataset?.idleTip !== undefined) {
    attach.dataset.tip = attach.dataset.idleTip;
    delete attach.dataset.idleTip;
  }
  $('prompt').disabled = state.loadingHistory;
  $('compose-state').textContent = away
    ? workHeld({ short: true })
    : state.proposalCard
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
  state.remoteUI?.lock($('add-llm').disabled);
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
  // While a work goes on (0.6.81): the Paramètres say what they lock, the takes that failed elsewhere
  // wait to be made again, and the miniature shows the work wherever it is not seen.
  const working = Boolean(state.work || state.generating || toolBusy);
  if ($('settings-held')) $('settings-held').hidden = !working || held;
  // (The creations' UI is made after the page's first run, the miniature with it.)
  if (state.miniature) {
    generationUI.busy?.(workHeld() || (working ? 'Attendez la fin de la génération en cours pour relancer.' : ''));
    // A work the Studio held, over: left meanwhile, the Studio follows the page (it says it itself
    // at each end; asked again here, it changes nothing).
    state.studio?.letGo?.();
    // The take of the Chat the Studio follows, over or no longer shown (0.6.96): it says it at once.
    state.studio?.watch?.();
    // What greys « Générer » changed (a work began or ended): the Studio says it at once (0.6.86).
    state.studio?.busyChanged?.();
    syncMiniature();
  }
}

/**
 * Where the miniature of the chat shows (0.6.81): wherever the work in hand, or the one that ended
 * while the user was away, is not seen (another conversation, the Pellicule, the Paramètres, as a pill
 * in their foot); nowhere once the user is back in its conversation after its end.
 */
function syncMiniature() {
  const mini = state.miniature,
    work = mini?.work;
  if (!work) return;
  const settings = $('settings'),
    here = shownHere(work.conversationId) && !settings?.open,
    // Its Chat and its Studio are two views of one conversation (0.6.96): either shows its work, the
    // Studio a take of its Chat too (studio.mjs, watch). It showed in the Studio when the Studio did not
    // hold the take (one asked in the Chat, a card waiting there), as if it were another conversation.
    seen = here && (state.view === 'chat' || state.view === 'studio');
  // Back in its conversation once it is over: nothing more to say.
  if (here && !mini.running && state.view !== 'library') return mini.forget();
  if (seen) return mini.place(null);
  // A take in hand waiting for the user in the Studio of its conversation (0.6.88): its proposal not
  // set there yet, or set and resting on « Générer », a character to check. Said so, not
  // « Préparation… » over a Flux that moved for nothing.
  const held = Boolean(state.studio?.proposing?.()) && state.studio?.heldFor?.() === work.conversationId;
  if (state.work?.waits || held) mini.waitFor?.('Moodix AI vous attend dans le Studio de cette conversation');
  mini.answer(
    state.work?.waits
      ? 'Moodix AI vous attend dans le Studio de cette conversation'
      : state.waitingForModel
        ? 'Le modèle se charge…'
        : 'Moodix répond…',
  );
  mini.place(settings?.open ? (settings.querySelector?.('.settings-footer') ?? 'corner') : 'corner');
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
    // A remote model in use: its own line is lit, not the local one kept in the configuration.
    const lit = item.id === chosen && !state.modelAdding && !state.status?.remote,
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
    // Chosen while a remote model answers: the chat comes back to the local model at once.
    pick.onclick = () =>
      state.status?.remote ? void state.remoteUI?.select(null).then(done => done && chooseLLM(item.id)) : chooseLLM(item.id);
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
  // The APIs after the local LLMs, in the same list (parametres-maquette.md).
  const remote = state.remoteUI?.rows(off) ?? [];
  list.replaceChildren(
    ...(rows.length || remote.length
      ? [...rows, ...remote]
      : [node('p', 'settings-note', 'Aucun LLM pour l’instant : ajoutez le fichier GGUF du vôtre, ou une API.')]),
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

/**
 * The bin of the history, in Paramètres › Application (0.6.103): what was deleted these 30 days, by the
 * user or by the application, with why in a few words; « Restaurer » gives it back, « Supprimer
 * définitivement » erases it now (asked first). After 30 days it goes by itself, at the next launch.
 */
const TRASH_REASONS = {
  user: 'Supprimée par vous',
  'user-all': 'Avec tout l’historique',
  'studio-empty': 'Création du Studio sans résultat',
  'recovery-empty': 'Création sans résultat, retrouvée après un rechargement',
  prune: 'Jamais enregistrée',
};
async function refreshTrash() {
  const list = $('history-trash-list');
  if (!list) return;
  let items;
  try {
    items = (await (await api('history/trash')).json()).conversations ?? [];
  } catch {
    return;
  }
  list.replaceChildren(
    ...items.map(item => {
      const row = node('li', 'history-trash-item'),
        what = node('span', 'history-trash-what'),
        back = node('button', 'history-trash-restore', 'Restaurer'),
        erase = node('button', 'history-trash-erase', 'Supprimer définitivement');
      what.append(
        node('span', 'history-trash-title', item.title || 'Sans titre'),
        node('span', 'history-trash-why', `${TRASH_REASONS[item.reason] ?? 'Supprimée'} · ${shortDate(item.deletedAt)}`),
      );
      back.type = 'button';
      erase.type = 'button';
      back.onclick = () => void restoreFromTrash(item);
      erase.onclick = () => void eraseFromTrash(item);
      row.append(what, back, erase);
      return row;
    }),
  );
  $('history-trash-empty').hidden = items.length > 0;
}
async function restoreFromTrash(item) {
  try {
    await api('history/restore', { id: item.id });
    $('live-status').textContent = `« ${item.title || 'Sans titre'} » restaurée.`;
    await refreshHistory().catch(error => notice(error.message));
  } catch (error) {
    notice(error.message);
  }
  await refreshTrash();
}
async function eraseFromTrash(item) {
  if (
    !confirm(
      `« ${item.title || 'Sans titre'} » sera effacée pour de bon, avec la liste de ses prises (leurs fichiers restent dans le dossier de sortie). Cela ne peut pas être annulé. Continuer ?`,
    )
  )
    return;
  try {
    await api('history/erase', { id: item.id, confirm: true });
    $('live-status').textContent = `« ${item.title || 'Sans titre'} » effacée définitivement.`;
  } catch (error) {
    notice(error.message);
  }
  await refreshTrash();
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
  // The bin of the history, read each time (0.6.103).
  void refreshTrash();
  Promise.all([
    api('bootstrap').then(response => response.json()),
    workflowsUI.refresh(),
    api('models').then(response => response.json()),
    // The APIs and the ChatGPT account: a failure leaves the rest of the settings.
    state.remoteUI?.load().catch(() => null),
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
    // An API being written is saved (and chosen) first, as a local LLM being written is.
    if (state.remoteUI?.dirty() && !(await state.remoteUI.save())) return false;
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
      session: compactSession(sessionOfPage()),
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
  if (!running && !stopOnly && !state.status?.remote && (!state.config.enginePath || !state.config.modelPath))
    return openSettings();
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
  if (!files.length) return;
  // A work goes on in another conversation (0.6.81): joined at its end, said so.
  if (state.work && !shownHere(state.work.conversationId)) return notice(workHeld());
  // Dropped or pasted while a creation is made (the « + » stays within reach): said, not lost in silence.
  if (state.status.toolJob && !state.generating)
    return notice(
      state.status.toolJob.blocked
        ? 'Libérez d’abord la carte graphique pour joindre un fichier.'
        : 'Attendez la fin de la génération en cours pour joindre un fichier.',
    );
  if (
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
    // Shown to the model when it sees: its projector of vision, or its connection (remote-llm-ui.mjs).
    if (images.length && (state.status?.remote ? state.status.remote.vision === true : state.config.projectorPath)) {
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
        // Played by the player of a take (take-player.mjs, 0.6.97), never the browser's.
        const box = node('div', 'message-video'),
          player = node('video');
        player.preload = 'none';
        player.playsInline = true;
        player.src = resource.originalUrl;
        if (resource.previewUrl) player.poster = resource.previewUrl;
        player.setAttribute('aria-label', `${video.label} · ${video.name}`);
        box.append(player, clipPlayer({ node, video: player, label: 'Lecteur · ' + video.label, what: 'la vidéo', length: resource.duration }).element);
        previews.append(box);
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
  // Not while a reply is being written, nor for a message the application wrote itself; nor while a
  // take of it is followed again after a reload (0.6.82): its message is not over.
  if (
    state.generating ||
    (state.work?.kind === 'follow' && shownHere(state.work.conversationId)) ||
    lastExchange(state.messages) < 0
  )
    return;
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
    // The last message (0.6.99: the line said under the thread of takes no longer in it is none).
    reply = [...document.querySelectorAll('#messages > .message')].at(-1);
  sent?.append(
    action('Modifier', 'edit', 'Reprendre ce message dans la zone de texte ; sa réponse est retirée', () =>
      takeBack(false),
    ),
  );
  // Not under a reply whose takes are made and only the words of Moodix are to come (0.6.99: the chat
  // model not back after a creation): « Régénérer » would only make them again.
  if (reply?.classList.contains('assistant') && !reply.querySelector('.message-waiting.is-failed') && reply.dataset?.regenerate !== 'no')
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
  // The takes of the exchange that leaves, asked first (0.6.99): « Régénérer » after « Le moteur n’est
  // pas prêt » took the ten images of a series out of their conversation without a word (they stayed in
  // the Pellicule and in `output`). « Non »: nothing changes.
  const question = leavingQuestion(state.messages.slice(index + 1));
  if (question && !confirm(question)) return;
  // « Régénérer » begins a work (0.6.90): asked once nothing here stops it, before its last exchange
  // leaves the page. Not when its message would not leave (« Envoyer » greyed, no model chosen): a
  // « oui » let the conversation set aside go for nothing; the message waits in the box, as before,
  // and asks once it is sent.
  const leaves =
    !state.sendHeld && Boolean(state.status?.remote || (state.config?.enginePath && state.config?.modelPath));
  if (resend && leaves && !mayBeginBeside()) return;
  // Kept as a conversation whose last message is still being written: opened again, that
  // message comes back in the message box.
  state.archiveSnapshot = { messages: state.messages.slice(0, index + 1), incomplete: true };
  state.messages = state.messages.slice(0, index);
  state.images = [...draft.images, ...state.images];
  state.videos = [...draft.videos, ...state.videos];
  $('prompt').value = draft.text + (waiting ? '\n\n' + waiting : '');
  generationUI.clear(state.aside?.nodes);
  $('messages').replaceChildren();
  renderTranscript(state.messages);
  turnActions();
  // Its message in the box, said where the thread ends (0.6.103): « Modifier » on its only exchange
  // left the welcome of a new conversation.
  unsentNote();
  renderAttachments();
  resizePrompt();
  updateControls();
  contextMeter.schedule();
  await persistConversation();
  if (resend) {
    // Sent again as it was: the label chosen for the next message is not for it.
    state.resent = true;
    $('chat-form').requestSubmit();
    state.resent = false;
  } else $('prompt').focus();
}
/** `host`: where a new message goes (the page of its conversation, on screen or set aside). */
function assistantMessage(parent = null, host = null) {
  const article = parent?.article || node('article', 'message assistant');
  article.setAttribute('aria-label', 'Réponse du modèle');
  let header = null;
  if (!parent) {
    header = node('div', 'message-header');
    const avatar = node('span', 'message-avatar');
    avatar.setAttribute('aria-hidden', 'true');
    avatar.append(...moodixMark());
    header.append(avatar, node('span', 'message-name', 'Moodix'));
    article.append(header);
  }
  // Its reflection (reflection.mjs; reflexion-maquette.md): « · RÉFLEXION 3 S » on the line of the
  // signature, its text under it. A later step of the same turn has its label on a line of its own.
  const thought = reflection({ node, onChange: () => scrollToBottom() }),
    reasoning = thought.element,
    summary = thought.label,
    thoughts = thought.content;
  if (header) header.append(summary);
  else {
    const line = node('div', 'reasoning-line');
    line.append(summary);
    article.append(line);
  }
  const body = node('div', 'message-body');
  const note = node('div', 'message-note');
  // The cards of a step go under its words (17/11: a video proposed after a reference was read
  // stood above the text that proposed it). A later step of the turn takes the grid of the turn
  // while it is empty, moved under its words; a grid of its own once that one holds a card.
  const kept = parent && !parent.generations.children?.length ? parent.generations : null,
    generations = kept || node('div', 'generation-grid');
  kept?.remove?.();
  article.append(reasoning, body, note, generations);
  if (!parent) (host ?? $('messages')).append(article);
  return { article, reasoning, summary, thoughts, thought, body, note, generations };
}
/**
 * How long a turn took (« 17.3 s », « 1:56 »): at the top right of its message (16/11), on the line of its
 * takes when it has some (moodix.css: `data-time` on their grid), else on the line of « MOODIX ».
 */
function turnTime(view, started) {
  // As the lengths are written (16/11): « 17.3 s » under a minute, « 1:56 » past it.
  const took = (performance.now() - started) / 1000,
    text = took >= 59.95 ? thoughtTime(took) : `${took.toFixed(1)} s`;
  view.note.textContent = text;
  view.note.classList?.add('is-time');
  // On the line of the last takes of the turn: a step may have a grid of its own (assistantMessage).
  const grids = [...(view.article?.querySelectorAll?.('.generation-grid[data-takes]') ?? [])];
  (grids.at(-1) ?? view.generations)?.setAttribute?.('data-time', text);
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
/**
 * In the Chat (16/11): an image is made at once, a video (a new one, a continuation, a character
 * replaced) or a sound always waits for the user on its card, which never starts by itself. What the
 * settings allow to start alone is the agent's of the Studio, not the Chat's.
 */
function proposalChoice(view, proposal, abort) {
  const asked = proposal.mediaType === 'video' || proposal.mediaType === 'audio';
  if (!asked) return 'once';
  return cardChoice(view.generations, proposal, abort, 0);
}
/**
 * Whether a creation asked in this turn is set in the Studio (its agent's chat) rather than in the
 * Chat: only in the Studio of its own conversation (`conversationId`); left meanwhile, it waits on a
 * card in its conversation (0.6.81).
 */
const setInStudio = (request, conversationId = state.conversationId) =>
  state.view === 'studio' &&
  state.conversationId === conversationId &&
  Boolean(state.studio?.accepts?.(request.tool || request.call?.function?.name));
// What stands over the card when the model wrote nothing, or said the video was there.
const PLAN_FALLBACK =
  'Voici ce que je propose : la carte ci-dessous montre la durée, le format et le prompt. Modifiez ce que vous ' +
  'voulez, puis appuyez sur « Générer » si cela vous convient ; rien ne part sans votre accord.';
// The same when the proposal is set in the Studio: there is no card under those words.
const PLAN_FALLBACK_STUDIO =
  'Voici ce que je propose : le Studio montre la durée, le format et le prompt. Modifiez ce que vous ' +
  'voulez, puis appuyez sur « Générer » si cela vous convient ; rien ne part sans votre accord.';
/**
 * The words of Moodix over the card of a video it proposes, as they may stand there: never « here is
 * the video » (nothing is made yet: the chat model wrote it more than once), never nothing.
 * `inStudio`: the proposal is set in the Studio, not on a card.
 */
function planWords(text, inStudio = false) {
  const said = String(text || '').trim(),
    made = /\bvid[ée]o\b[^.!?\n]{0,40}\b(?:est|a été)\s+(?:prête|faite|générée|créée|terminée|envoyée)\b/i,
    here = /\b(?:voici|voil[àa])\s+(?:la|ta|votre|une)\s+vid[ée]o\b|\bhere(?:'s|’s| is)\s+(?:the|your|a)\s+video\b/i;
  if (said && !made.test(said) && !(said.length < 160 && here.test(said))) return said;
  return inStudio ? PLAN_FALLBACK_STUDIO : PLAN_FALLBACK;
}
/**
 * The words Moodix AI wrote for a proposal it sets in the Studio, said there at the top of the screen
 * while its pointer works and while it waits (0.6.95): its message with the call, as the chat shows
 * it, without the line the page puts in place of nothing (planWords). '' when it wrote nothing of its
 * own: the Studio then says the proposal in a sentence of the application (studio-explain.mjs).
 */
function saidFor(messages, call) {
  if (!call?.id) return '';
  const message = messages.findLast(item => item?.role === 'assistant' && item.tool_calls?.some(made => made?.id === call.id));
  let said = spokenText(typeof message?.content === 'string' ? message.content : '');
  for (const line of [PLAN_FALLBACK_STUDIO, PLAN_FALLBACK]) said = said.replace(line, '');
  return said.trim();
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
function missingFile(view, request, history, conversationId = state.conversationId) {
  // (`conversationId`: the one of the turn, 0.6.87; the one shown when the answer came, which the
  // user may have left meanwhile, said « Ouvrez la conversation de cette demande » back in it.)
  const many = request.missing.files.length > 1,
    sentence =
      `${MISSING_FOR[request.tool] ?? 'Pour cette création'}, il me faut ${request.workflowName}, et il lui manque ` +
      `${many ? 'des fichiers' : 'un fichier'}. Dès qu’${many ? 'ils sont' : 'il est'} là, je reprends votre demande.`,
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
      // Not by itself when it would cost the conversation set aside (0.6.90): the card offers it, the
      // question comes with the user's click.
      if (asideAtStake()) return false;
      // Nor when takes would leave with its exchange (0.6.99): never taken away by itself. The card
      // offers « Reprendre la demande », which sends it as a new message.
      if (leavingQuestion(state.messages.slice(index + 1))) return false;
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
      state.resent = true;
      $('chat-form').requestSubmit();
      state.resent = false;
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
    return notice(workHeld() || 'Attendez la fin de la réponse ou de la génération en cours.');
  if (!mayBeginBeside()) return;
  state.generating = true;
  // Its conversation, wherever the user is when it ends (0.6.81).
  const talkId = state.conversationId,
    work = beginWork('again', talkId);
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
    // Its call is kept before its take is made (0.6.82, take-recovery.mjs).
    const begun = holderOf(talkId);
    begun.archiveSnapshot = {
      messages: archiveMessages([...history, { role: 'assistant', content: '', tool_calls: [request.call] }]),
      incomplete: false,
    };
    await persistConversation(talkId);
    let result;
    try {
      result = await workflowsUI.requestTool(
        request,
        signal,
        (progress, fraction, preview, time) => {
          generation.progress(progress, fraction, preview, time);
          scrollToBottom();
        },
        image => generation.image(image),
        {
          conversationId: talkId,
          ...(edit ? { approve: (proposal, abort) => cardChoice(container, proposal, abort, 0) } : { confirmed: true }),
        },
      );
      generation.finish(result);
    } catch (error) {
      if (signal.aborted) generation.withdraw();
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
    // Stopped: kept once the server has handed the card back (generationOver, 0.6.84); where its
    // conversation is then (the user may have opened another meanwhile).
    await generationOver(talkId);
    const talk = holderOf(talkId);
    if (history.length > (talk.messages?.length ?? 0)) {
      talk.messages = archiveMessages(history);
      talk.archiveSnapshot = { messages: [...talk.messages], incomplete: false };
      await persistConversation(talkId);
    } else if (talk.archiveSnapshot && talk.archiveSnapshot.messages.length !== (talk.messages?.length ?? 0)) {
      // Stopped or failed: its call kept as it started goes again, as before (nothing was made of it).
      talk.archiveSnapshot = { messages: [...(talk.messages ?? [])], incomplete: false };
      await persistConversation(talkId);
    }
    state.generating = false;
    state.controller = null;
    endTurn();
    endWork(work);
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
    return notice(workHeld() || 'Attendez la fin de la réponse ou de la génération en cours.');
  if (record.conversationId !== state.conversationId) return notice('Ouvrez la conversation de ce résultat.');
  if (!mayBeginBeside()) return;
  const video = record.mediaType === 'video',
    text =
      action === 'upscale'
        ? `Agrandir et affiner ${reference}.`
        : `Interpoler ${reference} pour une vidéo plus fluide.`,
    history = [...state.messages, { role: 'user', content: text }];
  state.generating = true;
  // Its conversation, wherever the user is when it ends (0.6.81).
  const talkId = state.conversationId,
    work = beginWork('action', talkId);
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
    // Its line and its call are kept before its take is made (0.6.82, take-recovery.mjs).
    const begun = holderOf(talkId);
    begun.archiveSnapshot = { messages: archiveMessages(history), incomplete: false };
    await persistConversation(talkId);
    let result;
    try {
      result = await workflowsUI.requestTool(
        request,
        signal,
        (progress, fraction, preview, time) => {
          generation.progress(progress, fraction, preview, time);
          scrollToBottom();
        },
        image => generation.image(image),
        // The click on Upscale or Interpoler is the confirmation: no second question. No model
        // runs here, so the result does not say that images of the output are attached.
        { confirmed: true, review: false, conversationId: talkId },
      );
      generation.finish(result);
    } catch (error) {
      // Stopped by the user: said once, by the line of the message (not again by the take, in the
      // browser's words).
      if (signal.aborted) generation.withdraw();
      else generation.fail(error.message);
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
    // Stopped: kept once the server has handed the card back (generationOver, 0.6.84); where its
    // conversation is then.
    await generationOver(talkId);
    const talk = holderOf(talkId);
    if (history.length > (talk.messages?.length ?? 0) + 1) {
      talk.messages = archiveMessages(history);
      talk.archiveSnapshot = { messages: [...talk.messages], incomplete: false };
      await persistConversation(talkId);
    }
    state.generating = false;
    // Its controller ends with it: kept, « Interrompre » aborted it again in place of cancelling
    // the next creation of the Studio.
    state.controller = null;
    endWork(work);
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

/**
 * What is kept of a conversation: without the pictures read for one turn, and every call followed by
 * its result (closedCalls: the card of a video that waits is saved before its answer, 0.6.27).
 */
function archiveMessages(messages) {
  return closedCalls(messages.filter(message => !message.resourceId && !message.outputId));
}

/**
 * The last message of the conversation shown that has not left: put back in the message box
 * (« Annuler le message en attente », a send that failed before any answer, « Modifier », a conversation
 * opened again). Said by a quiet line where its thread ends (0.6.103): one of that message alone looked
 * like a new conversation, the welcome back, left out of « Reprendre », a click on it in the fil doing
 * nothing. `called`: chosen again in the fil, the line shows it is that one. Whether it waits.
 */
function unsentNote({ called = false } = {}) {
  const thread = dropUnsentNote(),
    kept = state.archiveSnapshot,
    last = kept?.incomplete ? kept.messages?.at(-1) : null,
    waiting = Boolean(state.conversationId) && last?.role === 'user' && !last.internal && state.messages.at(-1)?.role !== 'user';
  if (waiting)
    thread.append(
      node('p', 'unsent-note' + (called ? ' is-called' : ''), 'Votre dernier message attend dans la zone de saisie : il n’est pas encore parti.'),
    );
  $('welcome').hidden = state.messages.length > 0 || waiting;
  return waiting;
}
/** That line out of the thread (the message sent at last); the thread. */
function dropUnsentNote() {
  const thread = $('messages');
  for (const line of [...(thread.children ?? [])].filter(child => child.classList?.contains?.('unsent-note'))) line.remove();
  return thread;
}

/** `talk`: who holds the conversation of the turn (state, or the conversation set aside, 0.6.81). */
function chatRequest(messages, tools = true, resources = true, talk = state) {
  const context = talk.conversationInstructions ?? (talk.messages?.length ? '' : state.globalInstructions || '');
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
      // The consigne of a creation that failed is for the message it failed in, not the next ones.
      ...settledNotes(messages),
    ],
    // The switch of the local model; a remote one reflects with the effort chosen for it (model-choice.mjs).
    thinking: state.status?.remote ? true : state.thinking,
    tools,
    resources,
    // The references the model knows are those of the conversation's project.
    project: talk.projectId || 'inbox',
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

/**
 * A work of the page (0.6.81): a turn of Moodix, a creation of the Studio, an action on a take, a
 * take made again. One at a time (`state.work`). The user may open any page meanwhile: its
 * conversation, left, is set aside (`state.aside`) with its page alive, its messages and its draft;
 * opened again, it comes back as it was, and the miniature of the chat shows the work everywhere
 * else (work-miniature.mjs). What a work writes goes to its own conversation, on screen or set
 * aside, never to the one the user looks at.
 */
/** Who holds the fields of conversation `id` now (conversationId, projectId, messages, archiveSnapshot…). */
function holderOf(id) {
  if (id && state.aside?.conversationId === id) return state.aside;
  if (!id || state.conversationId === id) return state;
  // Neither (gone meanwhile): nothing of it is written.
  return { conversationId: id };
}
/** Where the messages of conversation `id` are: the page's, or those set aside with it. */
const messagesOf = id => (id && state.aside?.conversationId === id ? state.aside.nodes : $('messages'));
/** Whether conversation `id` is the one on screen. */
const shownHere = id => !id || state.conversationId === id;
/**
 * The name of a conversation as the page knows it, a real one first (not « Nouvelle conversation »,
 * see `untitled`); before it has one, the name its work in progress gives it (its first message, the
 * prompt of the Studio); '' otherwise.
 */
function titleOf(id) {
  const named = title => (title && title !== 'Nouvelle conversation' && title !== 'Nouveau chat' ? title : '');
  return (
    named(shownHere(id) ? $('conversation-title').textContent : '') ||
    named(state.aside?.conversationId === id ? state.aside.title : '') ||
    named((state.historyItems || []).find(item => item.id === id)?.title) ||
    (state.work?.conversationId === id ? state.work.title : '') ||
    (state.miniature?.work?.conversationId === id ? state.miniature.work.title : '') ||
    ''
  );
}
/**
 * Why nothing else can be made now, in the user's words, when a work goes on in another conversation
 * than the one shown (0.6.81): one creation at a time, and the chat model is taken; '' otherwise.
 * A generation the page does not follow (begun before a reload) is said too.
 */
function workHeld({ short = false } = {}) {
  const work = state.work,
    job = state.status?.toolJob;
  if (work && !shownHere(work.conversationId)) {
    // `short`: the line of the message box, whose name of the model would give way to a long one
    // (moodix.css, « The bar of the chat stays on one line »); the miniature names the conversation.
    // (Non-breaking spaces inside the guillemets: a line never begins with « » ».)
    const name = `« ${titleOf(work.conversationId) || 'Nouvelle conversation'} »`;
    if (state.proposalCard || state.studio?.proposing?.())
      return short ? 'Moodix attend votre accord ailleurs' : `Moodix attend votre accord dans ${name} : répondez-lui d’abord.`;
    if (job && !job.blocked) return short ? 'Génération en cours ailleurs' : `Génération en cours dans ${name} : attendez sa fin.`;
    return short ? 'Moodix répond ailleurs' : `Moodix répond dans ${name} : attendez la fin de sa réponse.`;
  }
  if (!work && job && !job.blocked && job.conversationId && !shownHere(job.conversationId)) {
    const name = titleOf(job.conversationId);
    return (name ? `Génération en cours dans « ${name} »` : 'Génération en cours') + (short ? '' : ' : attendez sa fin.');
  }
  return '';
}
/**
 * A work begins in the conversation on screen (or in `conversationId`, the Studio's). `title`: the
 * name it will have, for a conversation that has none yet (its first message).
 */
function beginWork(kind, conversationId = state.conversationId, title = '') {
  const work = { kind, conversationId, title: titleOf(conversationId) || title };
  state.work = work;
  state.miniature?.begin(work);
  updateControls();
  return work;
}
/** It ends: the page is free for the next one; the miniature keeps its end while the user is away. */
function endWork(work) {
  if (!work || state.work !== work) return;
  state.work = null;
  state.miniature?.end();
  updateControls();
  // Written by another tab while this work went on (0.6.103): its conversation read again now, and any
  // other whose save was refused meanwhile.
  for (const id of [...(state.staleIds ?? [])]) {
    state.staleIds.delete(id);
    void readAgain(id);
  }
}
/**
 * The take of the Chat being made in the conversation of the work (0.6.96), as its card tells it
 * (generation-ui.mjs, onLive): its request, its step, its fraction, its picture so far, how long it has
 * been in the making as the server counts it (`time`, 0.6.93); `running` once the generator has it,
 * `ended` once over. The Studio of that conversation, its other view, shows it (studio.mjs, watch).
 * Not a creation of the Studio (its card `compact`): the Studio follows those itself.
 */
function chatTake(event) {
  const work = state.work;
  if (!work || event.compact) return;
  if (event.type === 'start')
    work.take = { request: event.request, running: false, label: '', fraction: null, preview: null, time: null, ended: null };
  else if (work.take?.request !== event.request) return;
  else if (event.type === 'progress')
    Object.assign(work.take, {
      running: true,
      label: event.text || work.take.label,
      fraction: Number.isFinite(event.fraction) ? event.fraction : work.take.fraction,
      preview: event.preview || work.take.preview,
      time: event.time || work.take.time,
    });
  else if (['done', 'failed', 'stopped'].includes(event.type))
    Object.assign(work.take, {
      running: false,
      ended: { type: event.type, record: event.record ?? null, message: event.message || event.error || '' },
    });
  else return;
  state.studio?.watch?.();
}
/** The name a work gives its conversation (« named once, by its first message »), wherever it is. */
function nameHere(id, title) {
  if (shownHere(id)) return setConversationTitle(title, { unnamed: true });
  if (state.aside?.conversationId === id && untitled(state.aside.title)) {
    state.aside.title = title;
    state.miniature?.rename(title);
  }
}
/** Resolves once conversation `id` is on screen: a step that needs its Studio waits for the user. */
function backHere(id, signal) {
  if (shownHere(id)) return Promise.resolve();
  if (state.work) state.work.waits = true;
  updateControls();
  return new Promise((resolve, reject) => {
    const look = setInterval(() => {
      if (!shownHere(id)) return;
      done();
      resolve();
    }, 250);
    const abort = () => {
      done();
      reject(signal.reason || new DOMException('Annulé', 'AbortError'));
    };
    function done() {
      clearInterval(look);
      signal?.removeEventListener?.('abort', abort);
      if (state.work) state.work.waits = false;
      updateControls();
    }
    signal?.addEventListener?.('abort', abort, { once: true });
  });
}
/**
 * The conversation on screen is left while its work goes on: set aside as it is, alive. `force`: without
 * a work of it (0.6.103: without the history, the one shown leaving for the one set aside).
 */
function setAside(force = false) {
  if (!force && (!state.work || state.work.conversationId !== state.conversationId)) return false;
  // One at a time: one set aside before (its work over) leaves the page, saved as it was; what was
  // being written in it comes back when it is opened again (0.6.88: it went with it).
  if (state.aside) keepDraft({ id: state.aside.conversationId, projectId: state.aside.projectId, ...state.aside.draft });
  dropAside();
  const nodes = document.createDocumentFragment();
  nodes.append(...$('messages').childNodes);
  state.aside = {
    conversationId: state.conversationId,
    projectId: state.projectId,
    conversationInstructions: state.conversationInstructions,
    messages: state.messages,
    archiveSnapshot: state.archiveSnapshot,
    historyDirty: state.historyDirty,
    title: $('conversation-title').textContent,
    // What was being written in it, and joined to it.
    draft: { text: $('prompt').value, images: state.images, videos: state.videos },
    nodes,
  };
  return true;
}
/**
 * What the user was writing in the conversation shown, kept when they open another (0.6.87): opened
 * again, it comes back in the message box. Only one set aside during its work kept it before, and what
 * was written meanwhile in the one shown was lost when the miniature brought the user back.
 */
function keepDraft(from = shownDraft()) {
  const key = leftKey(from.id, from.projectId),
    drafts = (state.draftsLeft ??= new Map());
  // Left empty: nothing comes back (0.6.88: what was kept before, then sent, came back). Not for one
  // not begun yet: what is kept for its project is another's, not given back yet.
  if (!String(from.text ?? '').trim() && !from.images?.length && !from.videos?.length) {
    if (from.id) drafts.delete(key);
    return;
  }
  drafts.delete(key);
  drafts.set(key, { text: from.text, images: from.images ?? [], videos: from.videos ?? [] });
  if (drafts.size > 20) drafts.delete(drafts.keys().next().value);
}
/** What the message box of the conversation shown holds, as keepDraft keeps it. */
function shownDraft() {
  return { id: state.conversationId, projectId: state.projectId, text: $('prompt').value, images: state.images, videos: state.videos };
}
/**
 * Where the draft of a conversation is kept: its identifier; one not begun yet, by its project, given
 * to the next one begun there (0.6.88: written in a new conversation while another worked, it was
 * lost when the miniature brought the user back).
 */
function leftKey(id, projectId) {
  return id || `new:${projectId || 'inbox'}`;
}
/** The draft kept for conversation `id` when it was left (taken out), or null. */
function draftLeft(id) {
  const kept = state.draftsLeft?.get(id) ?? null;
  state.draftsLeft?.delete(id);
  return kept;
}
/**
 * Whether the conversation set aside may leave the page (0.6.87): another is set aside in its place,
 * or the miniature that leads back to it is closed. Without the history it cannot be opened again:
 * asked first, as « Recommencer » asks; it left without a word before.
 */
function asideMayGo() {
  const aside = state.aside;
  if (!aside || state.saveHistory || !aside.messages?.length) return true;
  return confirm(
    `« ${titleOf(aside.conversationId) || UNTITLED} » n’est pas enregistrée (historique désactivé) : elle sera effacée de la page. Continuer ?`,
  );
}
/**
 * A work begins in the conversation shown while the one set aside, without the history, waits there
 * (0.6.90): the miniature that led back to it goes to the new work, and nothing else leads to it.
 * Asked first, as when another is set aside in its place; it leaves the page once the user says so.
 */
function mayBeginBeside() {
  if (!asideAtStake()) return true;
  const aside = state.aside;
  if (!asideMayGo()) return false;
  dropAside();
  // Nor the miniature that led to it (its click read a conversation the history does not keep).
  if (state.miniature?.work?.conversationId === aside.conversationId) state.miniature.forget();
  return true;
}
/** Whether a work begun in the conversation shown would leave the one set aside out of reach (0.6.90). */
function asideAtStake() {
  const aside = state.aside;
  return Boolean(aside) && aside.conversationId !== state.conversationId && !state.saveHistory && aside.messages?.length > 0;
}
/** The conversation set aside leaves the page (another set aside, deleted, the history cleared). */
function dropAside() {
  if (!state.aside) return;
  generationUI.drop?.(state.aside.nodes);
  state.aside = null;
}
/** Back to the conversation set aside: its page, its messages and its draft, as they were left. */
function takeBackAside(kept = state.aside) {
  if (state.aside === kept) state.aside = null;
  // The cards of the page left go (those of a conversation set aside meanwhile stay with it); those
  // set aside come back with their page.
  generationUI.drop?.($('messages'));
  Object.assign(state, {
    conversationId: kept.conversationId,
    projectId: kept.projectId,
    conversationInstructions: kept.conversationInstructions,
    messages: kept.messages,
    archiveSnapshot: kept.archiveSnapshot,
    historyDirty: kept.historyDirty,
    images: kept.draft.images,
    videos: kept.draft.videos,
  });
  rememberConversation(kept.conversationId);
  $('prompt').value = kept.draft.text;
  $('messages').replaceChildren(kept.nodes);
  $('welcome').hidden = $('messages').childElementCount > 0;
  setConversationTitle((state.historyItems || []).find(item => item.id === kept.conversationId)?.title || kept.title);
}

async function sendMessage(event) {
  event.preventDefault();
  // One work at a time (0.6.81): written in another conversation, the message waits for its end.
  if (state.work && !shownHere(state.work.conversationId)) return notice(workHeld());
  if ($('send').disabled) return;
  if (state.generating) {
    // A proposal of Moodix waits (a card, or the Studio): this message answers it instead, and
    // the card goes (Moodix answers with another).
    if (state.proposalCard) state.proposalCard.decline();
    else if (!state.studio?.decline?.()) return;
    await state.turnEnded;
    if (state.generating) return;
  }
  // A remote model chosen (remote-llm-ui.mjs) needs neither engine nor file.
  if (!state.status?.remote && (!state.config.enginePath || !state.config.modelPath)) {
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
  // Without the history, the conversation set aside would be reached no more (0.6.90): asked before
  // anything of the message is kept or shown, so that a « non » leaves nothing (its images copied, the
  // identifier of a conversation not begun, under which its draft was kept then).
  if (!mayBeginBeside()) return;
  const text = $('prompt').value.trim();
  state.conversationId ||= crypto.randomUUID();
  // The conversation of this turn: the user may open another page meanwhile (0.6.81); what the turn
  // writes goes to it, on screen or set aside (`talk()`), never to the one shown.
  const talkId = state.conversationId,
    talk = () => holderOf(talkId);
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
  // (The line of a message that waited in the box goes: this one leaves, 0.6.103.)
  dropUnsentNote();
  const history = [...state.messages, { role: 'user', content }],
    userView = userMessage(text, images, videos);
  state.conversationInstructions ??= state.messages.length ? '' : state.globalInstructions || '';
  const turnId = crypto.randomUUID();
  // The take on the Studio's screen as the user writes, when the Studio is the view: a model told
  // it (server.mjs, a capable one) reads « celle-ci » as that take. The same at every request of the turn.
  const screen = state.view === 'studio' ? (state.studio?.screenTake?.() ?? null) : null,
    // Asked from the Studio: its creations are made with the LoRAs the Studio shows, the whole turn,
    // wherever the user goes meanwhile.
    fromStudio = state.view === 'studio';
  talk().archiveSnapshot = { messages: [...archiveMessages(history)], incomplete: true };
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
    silent = false,
    // The proposal of a video whose words Moodix is writing, its card to come under them.
    planFor = null;
  state.generating = true;
  // A conversation begun with this message is named after it in the miniature, as it will be.
  const work = beginWork('turn', talkId, state.messages.length ? '' : conversationTitle(text).slice(0, 120));
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
  // What a message keeps of the reflection of Moodix: its text, and how long it took once known.
  const thoughtOf = (view, reasoning) =>
    reasoning
      ? { reasoning_content: reasoning, ...(view?.thought?.seconds?.() ? { reasoning_seconds: view.thought.seconds() } : {}) }
      : {};
  function snapshot() {
    return {
      messages: [
        ...archiveMessages(history),
        ...(output || reasoning ? [{ role: 'assistant', content: output, ...thoughtOf(view, reasoning) }] : []),
      ],
      incomplete: true,
    };
  }
  function render() {
    if (silent) return;
    // « Réflexion en cours… »: the mark of Moodix AI thinks with it, until the answer is written.
    markThinking(view, Boolean(view.waiting) && !output);
    if (view.thought) view.thought.show(reasoning, Boolean(output));
    else {
      view.reasoning.hidden = !reasoning;
      view.thoughts.textContent = reasoning;
    }
    if (output) renderText(view.body, output);
    else view.body.replaceChildren();
    // The takes it names, small under its words, as soon as it names them (those of its project:
    // not while another conversation is shown, 0.6.81).
    if (shownHere(talkId)) citedTakes.show(view, output);
    if (output && shownHere(talkId)) showLastReply(output);
    scrollToBottom();
    lastRender = performance.now();
    talk().archiveSnapshot = snapshot();
    if ((output || reasoning) && performance.now() - lastArchive > 2000 && !state.savingHistory) {
      lastArchive = performance.now();
      persistConversation(talkId);
    }
  }
  /**
   * The chat model back on the card after a creation (0.6.99): at once when it is ready, else waited
   * for under its step, « Le modèle se charge » beside « MOODIX », as long as the server gives it to come
   * back (5 minutes, lib/tool-runtime.mjs). False when it is not back by then. A stop of the user stops it.
   */
  async function backAfterCreation() {
    if (state.status?.state === 'ready') return true;
    const waiting = modelLoading(view, 'Vos prises sont prêtes. Moodix AI revient sur la carte graphique pour vous répondre.'),
      limit = new AbortController(),
      stop = () => limit.abort(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    const clock = setTimeout(() => limit.abort(), 5 * 60 * 1000);
    try {
      await waitForModel(api, limit.signal, status => {
        state.status = status;
        if (status.state !== 'ready') waiting.show();
        updateControls();
      });
      // (Another tab may have taken the conversation up meanwhile, 0.6.103: marked, the turn ends below.)
      await takenElsewhere(talkId);
      return true;
    } catch (error) {
      if (signal.aborted) throw error;
      return false;
    } finally {
      clearTimeout(clock);
      signal.removeEventListener('abort', stop);
      waiting.stop();
    }
  }
  /**
   * The turn over after its creation, without the words of Moodix (0.6.99): its takes stay as they are,
   * one line says when it answers, and no « Régénérer » under it (it would only make them again).
   */
  function quietEnd() {
    complete = true;
    view.silent = true;
    view.body.replaceChildren(node('div', 'message-step', 'Moodix répondra à votre prochain message.'));
    if (view.article?.dataset) view.article.dataset.regenerate = 'no';
    turnTime(view, started);
  }
  const started = performance.now(),
    loading = modelLoading(view);
  try {
    // Moodix waits: its Éclipse breathes; the model loading, its line says so (etats-maquette.md, 51).
    view.body.replaceChildren();
    markThinking(view, true);
    if (!(await persistConversation(talkId)))
      throw Error(
        // (Refused because another tab wrote it since: it is read again once this turn is over, 0.6.103.)
        state.staleIds?.has(talkId)
          ? 'Cette conversation a changé dans un autre onglet : votre message n’est pas parti.'
          : 'Impossible de sauvegarder ce message. Vérifiez le dossier history ou désactivez l’historique.',
      );
    let waited = false;
    await waitForModel(api, signal, status => {
      state.status = status;
      if (status.state !== 'ready') {
        waited = true;
        loading.show();
      }
      updateControls();
    });
    loading.stop();
    // Waited for (0.6.103): another tab may have taken the conversation up meanwhile (Moodix opened again
    // during a long loading). The message is not sent by itself then: back in the box, the conversation
    // read again once this turn is over (endWork).
    const taken = waited && (await takenElsewhere(talkId));
    if (taken)
      throw Error(
        taken === 'job'
          ? 'Un autre onglet crée dans cette conversation : votre message n’est pas parti.'
          : 'Cette conversation a changé dans un autre onglet : votre message n’est pas parti.',
      );
    state.waitingForModel = false;
    updateControls();
    let allowTools = true,
      iterations = 0,
      invalidCalls = 0,
      resourceReads = 0,
      briefing = false,
      reviewRecord = null,
      // A creation was made in this turn: the chat model comes back from the card before its next words (0.6.99).
      afterCreation = false;
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
      // After a creation, the chat model comes back from the card (0.6.99): waited for as at the start of
      // a message (« Le modèle se charge… »), within the 5 minutes the server gives it. Asked at once, a
      // local model still loading answered « Le moteur n’est pas prêt » in red under the ten images of a
      // series, and « Régénérer » took them away. Not back: the turn ends there, quietly, its takes kept.
      if (afterCreation && !(await backAfterCreation())) {
        quietEnd();
        break;
      }
      // Written by another tab during this turn (0.6.103: a save of it refused, or the conversation taken
      // up there while the model came back): nothing more is asked of the model on this older copy.
      if (state.staleIds?.has(talkId)) {
        quietEnd();
        break;
      }
      // Attached images of a reopened conversation get their compressed copy from the original.
      await fillCopies(history, { api, conversationId: talkId, signal });
      let response;
      try {
        response = await api(
          'chat',
          {
            ...chatRequest(history, allowTools, resourceReads < 8, talk()),
            // Only deciding whether to chain another tool: thinking would cost seconds for nothing shown.
            // A plan put to the user before a video is a few lines: no thinking either.
            ...(silent || briefing ? { thinking: false } : {}),
            ...(screen ? { screen } : {}),
            // A creation asked from the Studio is made with the LoRAs the Studio shows; from the Chat, with those saved for its model.
            ...(fromStudio ? { inStudio: true } : {}),
            conversationId: talkId,
            turnId,
          },
          { signal },
        );
      } catch (error) {
        // Gone again between the two (0.6.99): the same quiet end, never an error under its takes.
        if (!afterCreation || error.status !== 503) throw error;
        quietEnd();
        break;
      }
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
        // The gauge of the message box is that of the conversation shown.
        if (shownHere(talkId)) contextMeter.observe(chunk);
        if (chunk.local_tool_request) request = chunk.local_tool_request;
        // The first or last image of a video, kept by the server as a reference of the project
        // (`stills`): the list of the references is read again, so that the page knows it.
        if (chunk.local_tool_request?.stills?.length) void assetsUI.refresh().catch(() => {});
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
      // (While it writes its words over a card, nothing is said in their place: planWords has its own.)
      if (leaked && !output && !planFor)
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
        view.thought?.hide();
        complete = true;
        turnTime(view, started);
        break;
      }
      silent = false;
      render();
      if (
        reviewRecord &&
        !['resource', 'output', 'outputs', 'invalid'].includes(request?.kind) &&
        output.trim() &&
        finishReason !== 'length'
      ) {
        try {
          await workflowsUI.saveReview(reviewRecord, output, request ? 'correction_requested' : 'reviewed');
        } catch (error) {
          notice(`Analyse de galerie non enregistrée : ${error.message}`);
        }
      }
      // Moodix has just said what the video it proposes will be: its words join the call they are
      // about (the note it was given for them leaves the conversation), and the card comes under them.
      let resumed = false;
      if (!request && planFor) {
        const held = planFor;
        planFor = null;
        ({ allowTools, resourceReads } = held);
        briefing = false;
        if (history.at(-1)?.role === 'tool' && history.at(-1).tool_call_id === held.request.call.id) history.pop();
        // After what it had written with its call, if anything (`lead`, still on the page above them).
        const words = [held.lead.trim(), planWords(output.slice(held.lead.length), setInStudio(held.request, talkId))].filter(Boolean).join('\n\n');
        if (words !== output) {
          output = words;
          render();
        }
        const calling = history.at(-1);
        calling.content = words;
        calling.planned = true;
        output = '';
        reasoning = '';
        request = held.request;
        // It came with its words: it waits for the user. Set in the Studio, the pointer rests on
        // « Générer » whatever the settings allow; a video starts by itself only when this very
        // proposal comes back after the user answered it in words (lib/video-brief.mjs).
        request.autoAllow = false;
        resumed = true;
        talk().archiveSnapshot = { messages: [...archiveMessages(history)], incomplete: true };
        await persistConversation(talkId);
      }
      if (!request) {
        complete = true;
        if (finishReason === 'length') view.note.textContent = 'Limite de sortie atteinte.';
        else turnTime(view, started);
        break;
      }
      await historyWrite;
      // Nor a creation (0.6.103): a save of this answer was refused, another tab having written the
      // conversation meanwhile. Its words stay; the conversation is read again once the turn is over.
      if (state.staleIds?.has(talkId)) {
        if (request.requestId) void api('tools/cancel', { requestId: request.requestId }).catch(() => {});
        break;
      }
      usedTool = true;
      if (!resumed) {
        // It thought and called a tool without a word: its reflection is over all the same.
        view.thought?.end();
        history.push({
          role: 'assistant',
          content: output,
          ...thoughtOf(view, reasoning),
          tool_calls: [request.call],
        });
        if (!output) view.body.replaceChildren();
        output = '';
        reasoning = '';
      }
      // A video the user has not had under their eyes yet (lib/video-brief.mjs): Moodix says in a few
      // sentences what the clip will be, then the proposal is put to them, and waits. In the Chat
      // (16/11) its card comes under those words; in the Studio (17/11) the pointer sets it and rests
      // on « Générer »: the plan used to come alone there, and the user had to write « go » to it.
      if (!resumed && request.brief && request.requestId && !request.missing) {
        const note = setInStudio(request, talkId) ? request.studioBrief : request.cardBrief;
        if (note) {
          history.push({
            role: 'tool',
            tool_call_id: request.call.id,
            content: JSON.stringify({ status: 'waiting_for_user', message: note }),
          });
          // Its words go on in the same place, over where the card will come (after what it wrote
          // with its call, if anything).
          const lead = String(history.at(-2)?.content || '').trim() ? history.at(-2).content.trimEnd() + '\n\n' : '';
          planFor = { request, allowTools, resourceReads, lead };
          allowTools = false;
          resourceReads = 8;
          briefing = true;
          output = lead;
          finishReason = '';
          continue;
        }
      }
      if (request.kind === 'retry') {
        // Sent back before any generation with what to improve: the model makes its call again.
        history.push({
          role: 'tool',
          tool_call_id: request.call.id,
          content: JSON.stringify({ status: 'nothing_generated', message: request.message }),
        });
        talk().archiveSnapshot = { messages: [...archiveMessages(history)], incomplete: true };
        await persistConversation(talkId);
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
        talk().archiveSnapshot = { messages: [...archiveMessages(history)], incomplete: true };
        await persistConversation(talkId);
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
        let outcome;
        try {
          outcome = await replaceWithCharacter(request, { view, signal, talkId, words: saidFor(history, request.call) });
        } catch (error) {
          // Stopped, or failed before its end: its call keeps a result, as any other creation.
          history.push({
            role: 'tool',
            tool_call_id: request.call.id,
            content: JSON.stringify(
              signal.aborted
                ? {
                    status: 'cancelled',
                    message:
                      'L’utilisateur a arrêté ce remplacement avant la fin : rien n’a été produit. S’il demande de recommencer, refais le même appel d’outil.',
                  }
                : { status: 'error', message: error.message },
            ),
          });
          throw error;
        }
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
          talk().archiveSnapshot = { messages: [...archiveMessages(history)], incomplete: true };
          await persistConversation(talkId);
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
                { conversationId: talkId, runId: request.runId, outputIndex: request.outputIndex },
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
                conversationId: talkId,
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
            reviewRecord = { id: request.runId, conversationId: talkId };
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
        talk().archiveSnapshot = { messages: [...archiveMessages(history)], incomplete: true };
        await persistConversation(talkId);
        view = assistantMessage(view);
        finishReason = '';
        continue;
      }
      if (request.kind === 'outputs') {
        // (0.6.112) Several takes looked at in one call: what each is, and one picture of them all
        // (contact-sheet.mjs), where each used to take a request and a picture of its own.
        resourceReads++;
        const numbers = request.takes.map(item => item.take),
          outputId = 'takes/' + numbers.join(',');
        if (history.some(message => message.outputId === outputId)) {
          history.push({
            role: 'tool',
            tool_call_id: request.call.id,
            content: JSON.stringify({
              status: 'already_loaded',
              takes: numbers,
              note: 'L’image de ces prises est déjà jointe à ce tour. Réponds à l’utilisateur à partir d’elle, sans les relire.',
            }),
          });
          resourceReads = 8;
          talk().archiveSnapshot = { messages: [...archiveMessages(history)], incomplete: true };
          await persistConversation(talkId);
          view = assistantMessage(view);
          finishReason = '';
          continue;
        }
        view.note.textContent = 'Consultation des prises…';
        try {
          const read = async item =>
            (
              await api(
                'gallery/read',
                { conversationId: talkId, runId: item.runId, outputIndex: item.outputIndex },
                { signal },
              )
            ).json();
          const looked = [];
          for (const item of request.takes) {
            let result = await read(item);
            // Its copy dates from an earlier session: made again from the original file.
            if (!result.images.length && result.metadata.status === 'unavailable')
              try {
                await remakeOutputCopy({ api, conversationId: talkId, runId: item.runId, index: item.outputIndex ?? 0, signal });
                result = await read(item);
              } catch (error) {
                if (signal.aborted) throw error;
              }
            looked.push({ item, result });
          }
          const seen = looked.filter(({ result }) => result.images.length);
          let sheet = '';
          if (seen.length)
            try {
              sheet = await contactSheet(seen.map(({ item, result }) => ({ label: 'PRISE ' + item.take, url: result.images[0] })));
            } catch {
              // No sheet could be drawn: their pictures follow one by one, as a single take's does.
            }
          history.push({
            role: 'tool',
            tool_call_id: request.call.id,
            content: JSON.stringify({
              status: seen.length ? 'loaded' : 'unavailable',
              takes: looked.map(({ item, result }) => {
                const { status, run_id, output_index, note, ...facts } = result.metadata;
                return { take: item.take, ...facts, ...(result.images.length ? {} : { picture: 'unavailable' }) };
              }),
              note: seen.length
                ? 'One picture follows: these takes side by side, each under its number (« PRISE n »). Compressed copies; a video is shown by its first sampled frame, without motion or audio. Do not infer what a take shows from its prompt alone.'
                : 'No picture of these takes is available: only their settings are known.',
            }),
          });
          if (seen.length)
            history.push({
              role: 'user',
              internal: true,
              outputId,
              content: [
                {
                  type: 'text',
                  text:
                    'Planche des prises ' +
                    seen.map(({ item }) => item.take).join(', ') +
                    ' : chaque image sous son numéro. Copies compressées, pixels temporaires pour ce tour uniquement.',
                },
                ...(sheet ? [sheet] : seen.map(({ result }) => result.images[0])).map(url => ({ type: 'image_url', image_url: { url } })),
              ],
            });
          view.note.textContent = seen.length
            ? 'Prises consultées · ' + numbers.map(number => 'PRISE ' + number).join(', ')
            : 'Copies visuelles indisponibles.';
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
        talk().archiveSnapshot = { messages: [...archiveMessages(history)], incomplete: true };
        await persistConversation(talkId);
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
        talk().archiveSnapshot = { messages: [...archiveMessages(history)], incomplete: true };
        await persistConversation(talkId);
        view = assistantMessage(view);
        finishReason = '';
        continue;
      }
      if (request.missing) {
        // Its workflow lacks a file (etats-maquette.md, 53): Moodix says it in a sentence, the card
        // offers the download, and the message goes again once the file is there. The turn ends here.
        view.generation = true;
        missingFile(view, request, history, talkId);
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
      const viaStudio = setInStudio(request, talkId);
      const generation = generationUI.mount(view.generations, request, { compact: viaStudio });
      // A video is commented by the model only when the user chose it in the settings: the
      // reload and the analysis take about a minute. An image too, by its own choice. Otherwise
      // the creation ends the turn; a sound always does. Never the images of a series: every copy
      // went to the model in one message (up to twenty: more than a local context holds), and what
      // it wrote was kept as the analysis of the last one alone. It looks at one when asked to.
      const review = state.generation?.reviewVideos === true,
        lookAtImage = !request.mediaType && state.generation?.reviewImages === true && !request.series;
      // Made from the Studio, the generator keeps its models for the next creation, and the chat
      // model comes back with the next message: unless it has a creation to look at.
      const kept = viaStudio && !(review && request.mediaType === 'video') && !lookAtImage;
      let result,
        // The image in hand was made at once, the Studio of its conversation not on screen (0.6.88).
        away = false;
      // A creation run on its card: the same for each image of a series (image-series.mjs).
      const runOn = (proposal, card) =>
        workflowsUI.requestTool(
          proposal,
          signal,
          (progress, fraction, preview, time) => {
            // (With how long it has been in the making, as the server counts it: 0.6.93.)
            card.progress(progress, fraction, preview, time);
            // Made at once while the user was elsewhere, it is followed by its Studio once that is on
            // screen again, as after a reload (0.6.88), with the settings it is made with (0.6.96).
            if (viaStudio && away && shownHere(talkId) && state.view === 'studio' && state.studio.followAgain?.(proposal))
              away = false;
            if (viaStudio && !away) state.studio.follow(progress, fraction, preview, time);
            scrollToBottom();
          },
          image => card.image(image),
          {
            review,
            reviewImages: lookAtImage,
            // Its take is this conversation's, wherever the user is when it is made.
            conversationId: talkId,
            ...(viaStudio
              ? {
                  approve: async (proposal, abort) => {
                    // What goes by itself (an image of a series the user asked for, a creation allowed
                    // in the settings) while the Studio of its conversation is not on screen is made at
                    // once, as in the Chat (0.6.88). Waiting for the user to come back stopped the series
                    // as long as they were elsewhere, and its proposal expired after 15 minutes; set in
                    // the Studio, it took the page back there from the Pellicule at each image. Not a
                    // video whose prompt the pointer writes from the character (`scene`).
                    away =
                      !(shownHere(talkId) && state.view === 'studio') &&
                      !proposal.scene &&
                      (Boolean(proposal.series) || proposal.autoAllow === true);
                    if (away) {
                      // With the LoRAs of the user its Studio has for that conversation, as « Générer »
                      // adds them there (studio.mjs, edits): left out, the images made meanwhile had none,
                      // and the Studio, set from the last of them, emptied its list.
                      const verb = proposal.tool || proposal.call?.function?.name,
                        target = verb === 'create_image' ? 'image' : verb === 'create_video' ? 'video' : null,
                        styles = target ? state.studio?.stylesFor?.(talkId, target) : null;
                      if (styles && JSON.stringify(styles) !== JSON.stringify(proposal.styles ?? [])) {
                        const revised = await (
                          await api(
                            'tools/revise',
                            { requestId: proposal.requestId, approvalToken: proposal.approvalToken, edits: { styles } },
                            { signal: abort },
                          )
                        ).json();
                        Object.assign(proposal, revised);
                      }
                      return 'once';
                    }
                    // In the Studio of this conversation (0.6.87): the user may have opened another
                    // meanwhile (an image of a series asked from the Studio); the proposal waits for
                    // them there, as runForTurn's. Set in the Studio of the one shown, it took its
                    // drafts and put this conversation's take on its screen.
                    await backHere(talkId, abort);
                    // With the words Moodix wrote for it, said at the top of the Studio (0.6.95).
                    const answer = state.studio.propose(proposal, abort, { said: saidFor(history, request.call) });
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
      const settle = outcome => {
        // Made at once away from its Studio (0.6.88): put on its screen only when that is on screen;
        // otherwise read again when it is shown next, as a take of the Chat (it is another's screen).
        if (viaStudio && (!away || (shownHere(talkId) && state.view === 'studio'))) void state.studio.settled(outcome);
        // Made from the Chat: the Studio reads its takes again when it is shown next (its Sortie and
        // its screen did not know of the take until another conversation was opened).
        else if (outcome.record) state.studio?.invalidate?.();
      };
      // The result of the call in the conversation: one for its call at any time. A series keeps
      // what it has made so far after each image, which the next result takes the place of.
      const answer = content => {
        const last = history.at(-1);
        if (last?.role === 'tool' && last.tool_call_id === request.call.id) last.content = content;
        else history.push({ role: 'tool', tool_call_id: request.call.id, content });
      };
      // Its call is kept before its take is made (0.6.82): the page reloaded or closed meanwhile, the
      // conversation knows of it, and the page that shows it next finds its take (take-recovery.mjs).
      talk().archiveSnapshot = { messages: [...archiveMessages(history)], incomplete: true };
      await persistConversation(talkId);
      try {
        result = await runOn(request, generation);
        generation.finish(result);
        settle(result);
        // Several images asked in one call: the others now, one after another, without the model.
        if (request.series && result.record && !result.denied && !result.failed)
          result = await runSeries(request, result, {
            api,
            signal,
            mount: proposal => generationUI.mount(view.generations, proposal, { compact: viaStudio }),
            run: runOn,
            settle,
            // Saved after each image: closed in the middle of a series, the application shows the
            // images made so far when the conversation is opened again (their `run_id`).
            keep: async made => {
              answer(made);
              talk().archiveSnapshot = { messages: [...archiveMessages(history)], incomplete: true };
              await persistConversation(talkId);
            },
          });
        // A series that goes no further than its first image (refused, failed): the server is told,
        // lets its prompts go, and the chat model its image may have left out is back before the
        // model is written to.
        else if (request.series) await api('tools/series', { series: request.series.id, end: true }).catch(() => {});
      } catch (error) {
        // (The same when its first image is stopped or breaks: runSeries says it for the next ones.)
        if (request.series && !error.series) void api('tools/series', { series: request.series.id, end: true }).catch(() => {});
        // (The same for its failure: one made away from its Studio leaves the Studio shown alone, 0.6.88.)
        if (viaStudio && (!away || (shownHere(talkId) && state.view === 'studio')))
          void state.studio.settled({ error: signal.aborted ? 'Génération arrêtée.' : error.message });
        // Stopped or broken after the first image of a series: its card said it, and the result of
        // the call says what was made (the first card stays as it is).
        if (error.series) {
          answer(error.series);
          throw error;
        }
        // Stopped by the user: the take goes and the message says it, once, in French (16/11: the
        // take repeated it in the browser's words); failed: the take veiled, to make again (52).
        if (signal.aborted) generation.withdraw();
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
      answer(result.content);
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
      // (`late`: the last image of a series made, what followed it went wrong, 0.6.99.)
      if ((result.failed || result.late) && state.status.state !== 'ready') {
        // Nothing made and the model cannot come back now (the card held, 54): the take says what
        // failed; the turn ends there, without the same words again in red.
        if (!result.record) {
          complete = true;
          break;
        }
        // Made, and the chat model not back within its 5 minutes (0.6.99): the takes stay, nothing in red
        // under them (« L’image est disponible dans la galerie, mais le modèle n’a pas redémarré. »
        // before); Moodix answers the next message. (Kept by the end of the turn, below.)
        view = assistantMessage(view);
        quietEnd();
        break;
      }
      // A take that failed says why on itself (52): no second line under the message.
      view.note.textContent = result.failed && result.record ? result.error || 'Analyse indisponible.' : '';
      if (result.denied || result.failed || result.stopped || iterations >= (state.generation?.maxIterations || 10)) allowTools = false;
      // After a refusal or a failure the model explains it: it does not go on inspecting outputs.
      if (result.denied || result.failed) resourceReads = 8;
      // Not seen (no analysis chosen for it): its text would only repeat what the user sees.
      silent = Boolean(result.record && !looked && !result.failed);
      talk().archiveSnapshot = { messages: [...archiveMessages(history)], incomplete: true };
      await persistConversation(talkId);
      view = assistantMessage(view);
      finishReason = '';
      afterCreation = true;
    }
  } catch (error) {
    const canceled = signal.aborted,
      // Its first save refused, another tab having written the conversation since (0.6.103): the message
      // goes back to the box, the conversation is read again once the turn is over (endWork).
      stale = Boolean(state.staleIds?.has(talkId)),
      // The model did not come (51): the message stays in the thread, the line says why.
      unloaded = !canceled && !stale && state.waitingForModel && !(output || reasoning || usedTool);
    loading.stop();
    if (unloaded) {
      loading.fail(error.message || 'Le modèle n’a pas démarré.', () => void takeBack(true));
      talk().messages = archiveMessages(history);
      talk().archiveSnapshot = { messages: [...talk().messages], incomplete: false };
    } else if (output || reasoning || usedTool) {
      render();
      view.note.textContent = canceled ? 'Opération interrompue à votre demande.' : error.message;
      if (!canceled) view.note.classList.add('error');
    } else if (shownHere(talkId)) {
      userView.remove();
      view.article.remove();
      $('prompt').value = text + ($('prompt').value ? `\n\n${$('prompt').value}` : '');
      state.images = images;
      // The videos joined come back with it (the text kept their « #ref », not their chip).
      state.videos = videos;
      renderAttachments();
      // Kept on the disk as the last message of the conversation, said where its thread ends (0.6.103):
      // « Annuler le message en attente » on its first message brought the welcome back.
      unsentNote();
    } else {
      // Its conversation set aside meanwhile (0.6.81): the draft goes back there, not in the one shown.
      userView.remove();
      view.article.remove();
      const draft = talk().draft;
      if (draft) Object.assign(draft, { text: text + (draft.text ? `\n\n${draft.text}` : ''), images, videos });
    }
    if (!canceled && !unloaded) notice(error.message || 'La connexion a été interrompue.');
  } finally {
    // Stopped or failed while Moodix wrote its words over a card: the card never came. What it had
    // written stays on its call (once, and on the page); the note for those words (« a card shows
    // this proposal ») leaves for the result of a proposal that was never shown, and the proposal
    // the server kept for the card is let go.
    let unshown = false;
    if (planFor) {
      const { request } = planFor;
      planFor = null;
      if (history.at(-1)?.role === 'tool' && history.at(-1).tool_call_id === request.call.id) history.pop();
      if (history.at(-1)?.tool_calls) history.at(-1).content = output.trim();
      history.push({
        role: 'tool',
        tool_call_id: request.call.id,
        content: JSON.stringify({
          status: 'cancelled',
          message:
            'La réponse a été interrompue avant que cette proposition soit montrée à l’utilisateur : rien n’a été produit. S’il la redemande, refais le même appel d’outil.',
        }),
      });
      void api('tools/cancel', { requestId: request.requestId }).catch(() => {});
      unshown = Boolean(output.trim());
      output = '';
      reasoning = '';
    }
    if (output || reasoning || usedTool) {
      if (output || reasoning) {
        render();
        if (!output) view.body.replaceChildren(node('div', 'text-block', 'Aucune réponse finale reçue.'));
        view.thought?.end();
        history.push({ role: 'assistant', content: output, ...thoughtOf(view, reasoning) });
      } else if (usedTool && !view.generation && !view.silent && !unshown)
        view.body.replaceChildren(
          node('div', 'text-block', complete ? 'Aucune réponse finale reçue.' : 'Opération interrompue.'),
        );
      talk().messages = archiveMessages(history);
      talk().archiveSnapshot = { messages: [...archiveMessages(history)], incomplete: !complete };
      // Named once, by its first message, as the history names it (persistConversation gives its
      // name back): at every turn the bar took the whole text of the last message, and lost the name
      // the user had given. (Its own conversation, set aside or not, 0.6.81.)
      nameHere(talkId, conversationTitle(text).slice(0, 120) || 'Une image à explorer');
    }
    // The turn is over, answered, failed or stopped: the mark is at rest, its thought timed.
    view.thought?.end();
    markThinking(view, false);
    // A creation stopped: kept once the server has handed the card back (generationOver, 0.6.84).
    if (usedTool) await generationOver(talkId);
    await persistConversation(talkId);
    // The conversation this turn was in: another may be opened before its name is asked.
    const answered = talkId;
    state.generating = false;
    state.waitingForModel = false;
    state.controller = null;
    endTurn();
    endWork(work);
    turnActions();
    resizePrompt();
    await refreshStatus();
    contextMeter.schedule();
    showLastReply();
    // The message box is that of the conversation shown: the keyboard goes there only if it is this one.
    if (shownHere(talkId)) $('prompt').focus();
    // Answered: its name in a few words, asked beside it (the pictures still in their copies here).
    if (complete) void nameConversation(history, answered);
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
// (0.6.92: no « ● Studio » in the message box of the Studio's chat any more, nor what showed it.)

/**
 * A proposal of the application itself in a chat turn (the image of a character, then its
 * replacement): set in the Studio by the pointer and started at once, followed by a card in the
 * conversation. Returns the result, as for a creation of the chat. `said`, `purpose`: what the Studio
 * says of it at the top of its screen meanwhile (0.6.95, studio.mjs propose).
 */
async function runForTurn(proposal, { view, signal, auto = false, talkId = state.conversationId, said = '', purpose = '' }) {
  // The image of a character starts at once (the user checks it right after); the video itself
  // starts alone only as the settings of the Studio's agent say (16/11), else on « Générer ».
  if (auto) proposal.autoAllow = true;
  // The pointer sets it in the Studio of its conversation: left meanwhile, it waits for the user to
  // come back there (0.6.81), the miniature says so.
  await backHere(talkId, signal);
  view.generation = true;
  const generation = generationUI.mount(view.generations, proposal, { compact: true });
  try {
    const result = await workflowsUI.requestTool(
      proposal,
      signal,
      (progress, fraction, preview, time) => {
        generation.progress(progress, fraction, preview, time);
        state.studio.follow(progress, fraction, preview, time);
        scrollToBottom();
      },
      image => generation.image(image),
      {
        review: false,
        reviewImages: false,
        conversationId: talkId,
        approve: async (asked, abort) => {
          // Left again before its answer: set when the user is back in its conversation.
          await backHere(talkId, abort);
          const answer = state.studio.propose(asked, abort, { said, purpose });
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
    // Stopped by the user: said once, by the message (not again by the take, in the browser's words).
    if (signal.aborted) generation.withdraw();
    else generation.fail(error.message);
    throw error;
  }
}

/**
 * A character put in a video when there is no image of them (replace_character with
 * `character`): their image made in the Studio, checked by the user (« OK », « Autre image »,
 * « Annuler »), then the replacement with it. Returns { content, record } for the model's call.
 * `words`: what Moodix wrote with its call, said at the top of the Studio with the replacement (0.6.95).
 */
async function replaceWithCharacter(request, { view, signal, talkId = state.conversationId, words = '' }) {
  const said = text => (view.note.textContent = text);
  // Asked in the conversation of the turn and in its project, wherever the user is meanwhile.
  const action = async (name, args) =>
    (
      await api('tools/action', {
        conversationId: talkId,
        project: holderOf(talkId).projectId || 'inbox',
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
    // (Said in the Studio as the image of the character, to be checked before the replacement, 0.6.95.)
    const made = await runForTurn(await action('create_image', { prompt, ...(size ?? {}) }), { view, signal, auto: true, talkId, purpose: 'character' });
    if (!made.record) {
      said(made.error || 'L’image du personnage n’a pas pu être faite.');
      return { content: JSON.stringify({ status: 'error', message: made.error || 'Image du personnage non faite.' }) };
    }
    said('Ce personnage vous convient ? Répondez dans le Studio : OK, Autre image ou Annuler.');
    // Checked in the Studio of its conversation: left meanwhile, when the user is back there.
    await backHere(talkId, signal);
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
  const result = await runForTurn(proposal, { view, signal, talkId, said: words });
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
async function runInStudio(proposal, { signal, onProgress, conversationId = state.conversationId }) {
  // The conversation the Studio asked it in: written there wherever the user is meanwhile (0.6.81).
  const talkId = conversationId;
  if (shownHere(talkId)) $('welcome').hidden = true;
  const view = assistantMessage(null, messagesOf(talkId));
  view.body.replaceChildren();
  view.generation = true;
  const generation = generationUI.mount(view.generations, proposal, { compact: true });
  const kinds = { image: 'Image', video: 'Vidéo', audio: 'Son' };
  // Its line and its call are kept as it starts (0.6.82): the page reloaded meanwhile, the conversation
  // exists, in its project, and the page that shows it next finds its take (take-recovery.mjs). Taken
  // back when nothing is made: a creation of the Studio that fails says nothing in the conversation.
  const begun = holderOf(talkId),
    before = [...(begun.messages ?? [])],
    // As it was before (0.6.87): what it kept saved (a message taken back into the box with
    // « Modifier » leaves no message in the page, but one in the history), and whether it existed.
    // Only a conversation begun for this very creation leaves the history when it makes nothing:
    // one emptied by « Modifier » was deleted with its takes.
    previous = begun.archiveSnapshot,
    existed = state.historyItems.some(item => item.id === talkId),
    // Its last message, put back in the message box (« Modifier », a conversation opened again): kept
    // on the disk after the creation, as take-recovery keeps it (0.6.88). Left out, it was only in the
    // box from the start of the creation: lost with a page reloaded meanwhile, or once it was made.
    pending = previous?.incomplete ? previous.messages?.at(-1) : null,
    unsent = pending?.role === 'user' && !pending.internal && before.at(-1)?.role !== 'user' ? [pending] : [];
  if (!before.length) begun.conversationInstructions ??= state.globalInstructions || '';
  begun.archiveSnapshot = {
    messages: [
      ...archiveMessages([
        ...before,
        {
          role: 'user',
          internal: true,
          content:
            `Studio · ${kinds[proposal.mediaType || 'image'] ?? 'Image'} : ${String(proposal.plan?.prompt || proposal.args?.prompt || '')}`.slice(0, 4000) +
            '\n\n' +
            STUDIO_NOTE,
        },
        { role: 'assistant', content: '', tool_calls: [proposal.call] },
      ]),
      ...unsent,
    ],
    incomplete: unsent.length > 0,
  };
  await persistConversation(talkId);
  const takeBack = async () => {
    // Stopped: once the server has handed the card back, it allows the save (generationOver, 0.6.84).
    await generationOver(talkId);
    const talk = holderOf(talkId);
    talk.archiveSnapshot = previous?.messages?.length ? previous : { messages: [...before], incomplete: false };
    if (talk.archiveSnapshot.messages.length) await persistConversation(talkId);
    else if (!existed) await forgetConversation(talkId);
  };
  let result,
    found = false;
  try {
    result = await workflowsUI.requestTool(
      proposal,
      signal,
      (progress, fraction, preview, time) => {
        generation.progress(progress, fraction, preview, time);
        onProgress(progress, fraction, preview, time);
      },
      image => generation.image(image),
      { confirmed: true, review: false, studio: true, conversationId: talkId },
    );
    generation.finish(result);
  } catch (error) {
    view.article.remove();
    // A stop (or a fault) that came once its take was saved, the server still handing the card back:
    // the take is kept and shown (0.6.86). Taken back with its line before, a conversation begun for
    // it left the history with the take, which left the Pellicule.
    await generationOver(talkId);
    let made = null;
    try {
      made = takesOf((await (await api(`gallery/${encodeURIComponent(talkId)}?images=0`)).json()).runs, proposal.call.id).at(-1) ?? null;
    } catch {}
    if (!made) {
      await takeBack();
      throw error;
    }
    result = { record: made, content: takeContent(made, { request: proposal, studio: true }), images: [], failed: false, error: '' };
    found = true;
  }
  // Nothing made, nothing to tell: the Studio says why.
  if (!result.record) {
    view.article.remove();
    await takeBack();
    return result;
  }
  const prompt = String(proposal.plan?.prompt || proposal.args?.prompt || result.record.prompt || ''),
    said = `Studio · ${kinds[result.record.mediaType || 'image'] ?? 'Image'} : ${prompt}`.slice(0, 4000);
  const talk = holderOf(talkId);
  // A conversation begun in the Studio still gets the global instructions with its first message.
  if (!talk.messages?.length) talk.conversationInstructions ??= state.globalInstructions || '';
  talk.messages = archiveMessages([
    ...(talk.messages ?? []),
    {
      role: 'user',
      internal: true,
      content: said + '\n\n' + STUDIO_NOTE,
    },
    { role: 'assistant', content: '', tool_calls: [proposal.call] },
    { role: 'tool', tool_call_id: proposal.call.id, content: result.content },
  ]);
  talk.archiveSnapshot = { messages: [...talk.messages, ...unsent], incomplete: unsent.length > 0 };
  // Named by its prompt alone, as the server names it (the pill of the title bar says the mode).
  const named = conversationTitle(said).slice(0, 120);
  if (named) nameHere(talkId, named);
  // A take found after its stop: drawn from the conversation, its card having gone.
  if (found) rerender(talkId);
  if (shownHere(talkId)) turnActions();
  await persistConversation(talkId);
  contextMeter.schedule();
  return result;
}

const tokenControls = setupTokenControls($);
const computeControls = setupComputeControls($);
// The one tooltip of the page: the « ? » of the settings and of the Studio, the names of the
// controls (their titles become its tips), in one bubble (help-tips.mjs).
const helpTips = setupHelpTips(document.body);
// No list of the system (white on white in the dark room): each `<select>` shown is a menu of glass.
setupGlassSelects(document.body);
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
// Closed during a work (0.6.81): the miniature leaves their foot for its corner at once.
$('settings').addEventListener('close', () => state.miniature && syncMiniature());
const projectUI = setupProjectNavigation({
  $,
  state,
  node,
  icon,
  api,
  openConversation: id => {
    requestSettingsClose(() => loadConversation(id));
  },
  // From the Pellicule, the welcome in that project, with the passage of the views (as the logo).
  newConversation: id => {
    if (state.view === 'library') return goHome(id);
    requestSettingsClose(() => newConversation(id));
  },
  removeConversation: confirmHistoryDeletion,
  // A move or a deletion refused during a work, said (0.6.81).
  notice: text => notice(text),
  // The conversation open, renamed from the fil: its new name at once.
  setTitle: title => setConversationTitle(title),
  // A project renamed or deleted: the library on screen says it too.
  onChange: () => {
    if (state.view === 'library') libraryUI.render();
    // The project of a conversation not begun changed in the fil: the Studio is that conversation's,
    // its screen, its Sortie, its prompt and its inputs with it (16/11).
    state.studio?.conversationChanged?.();
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
  // « + Nouvelle conversation » of an empty project: the welcome in it, as the logo opens it.
  newConversation: id => goHome(id),
  // The project chosen in the Pellicule: the page follows it.
  onFilter: filter => {
    state.libraryProject = filter.project;
    projectUI.render();
  },
  // On a take, the actions of the conversation (Ouvrir, Prolonger…), done in its conversation.
  actions: (record, index) => libraryActions(record, index),
});
// The fil heads the Pellicule (pellicule-fil-maquette.md): its menus choose the project and the
// conversation shown, with their numbers of takes; projects are made, renamed and deleted there.
projectUI.useLibrary(libraryUI);
// The takes a reply names (« la prise 12 », « #ref4 »), small under its words; a click opens one.
const citedTakes = setupCitedTakes({
  node,
  icon,
  load: () => projectTakes(),
  project: () => state.projectId || 'inbox',
  references: () => projectReferences(),
  viewOutput: (record, index, blob, around) => assetsUI.viewOutput(record, index, blob, around),
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
    workHeld() ||
    (state.generating || state.status.busy
      ? 'Attendez la fin de la réponse en cours.'
      : state.preparing || state.loadingHistory || state.updating || state.closingApp
        ? 'Attendez la fin de l’opération en cours.'
        : ''),
  // (0.6.81) Its creations by hand are works of the page, followed wherever the user goes; a
  // conversation not named yet is named in the miniature by the prompt, as it will be (runInStudio).
  // (0.6.90) Without the history, a creation begun beside the conversation set aside asks first.
  mayBegin: () => mayBeginBeside(),
  onWork: (id, prompt) =>
    id
      ? beginWork('studio', id, prompt ? conversationTitle(String(prompt)).slice(0, 120) : '')
      : endWork(state.work?.kind === 'studio' ? state.work : null),
  // Why « Générer » is greyed: a work in another conversation, or Moodix answering in this one
  // (its proposals set in the Studio are answered there, they hold it).
  elsewhere: () =>
    workHeld() ||
    (state.work && shownHere(state.work.conversationId) && !state.studio?.holds?.()
      ? state.proposalCard
        ? 'Moodix attend votre accord dans le Chat : répondez-lui d’abord.'
        : state.status.toolJob
          ? 'Génération en cours dans cette conversation : attendez sa fin.'
          : 'Moodix répond : attendez la fin de sa réponse.'
      : ''),
  nameOf: id => titleOf(id),
  // The pointer of Moodix AI sets the Studio: the places of the page wait for it (2 to 3 s).
  onLock: () => updateControls(),
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
  // A take of its Chat being made (0.6.96): in the Studio of that conversation, its screen and its settings.
  making: () => (state.work?.take && shownHere(state.work.conversationId) ? state.work.take : null),
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
  // Each take being made, as it goes: the miniature of the chat follows it (0.6.81), the Studio of its
  // conversation one of its Chat (0.6.96).
  onLive: event => {
    state.miniature?.take(event);
    chatTake(event);
  },
});
/**
 * The miniature of the chat (0.6.81): while a work goes on, in the corner of every page where it is
 * not seen; a click brings back to its conversation, where it is followed: its Studio when the
 * Studio holds it (a take made there), else its Chat.
 */
function backToWork(work) {
  if (!work?.conversationId) return;
  // (A creation of the Studio followed again after a reload too, 0.6.86: `studio`.)
  const toStudio = Boolean(state.studio?.holds?.()) || work.kind === 'studio' || work.studio === true;
  requestSettingsClose(async () => {
    if (!shownHere(work.conversationId)) await loadConversation(work.conversationId);
    if (!shownHere(work.conversationId)) return;
    if (toStudio) showStudio();
    else showChat();
  });
}
const miniature = setupMiniature({
  node,
  icon,
  mark: () => moodixMark()[0],
  open: work => backToWork(work),
  // Closed while it leads to the conversation set aside, without the history: that one goes with it,
  // once the user said so (it cannot be opened again from anywhere).
  mayClose: work => state.aside?.conversationId !== work?.conversationId || asideMayGo(),
  onClosed: work => {
    if (!state.saveHistory && state.aside?.conversationId === work?.conversationId) dropAside();
  },
});
document.body?.append?.(miniature.element);
state.miniature = miniature;
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
/** The conversation shown, drawn again from its messages (a result written meanwhile): its views by place. */
function rerender(id) {
  if (!shownHere(id)) return null;
  generationUI.clear(state.aside?.nodes);
  $('messages').replaceChildren();
  citedTakes.forget();
  // A call whose take the server still makes keeps waiting for its card, as at the opening.
  const views = renderTranscript(state.messages, false, { waiting: state.recovery?.waiting(id, state.messages) });
  turnActions();
  // (Its message unsent said where the thread ends, 0.6.103.)
  unsentNote();
  scrollToBottom();
  return views;
}
/**
 * A creation made while no page followed it (0.6.82): its call gets what it made when its
 * conversation is shown, or its card follows it there; a reload comes back where the tab was.
 */
state.recovery = setupTakeRecovery({
  api,
  state,
  holderOf,
  shownHere,
  persistConversation,
  generationUI,
  workflowsUI,
  beginWork,
  endWork,
  rerender,
  // (Found after a reload: said so to the server and its journal, 0.6.103.)
  forget: id => forgetConversation(id, 'recovery-empty'),
  loadConversation,
  newConversation,
  showStudio,
  showLibrary,
  renderNavigation: () => projectUI.render(),
  scrollToBottom,
  node,
  tab: TAB,
  onChange: () => {
    turnActions();
    void refreshStatus();
  },
});
window.addEventListener('pagehide', () => {
  state.recovery.rememberTab();
  // The generation this tab started: another tab may follow it at once (0.6.86); reloaded, this
  // same tab follows it again.
  if (state.token && state.status?.toolJob?.owner === TAB)
    void fetch('/api/tools/leave', {
      method: 'POST',
      keepalive: true,
      headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json', 'X-Moodix-Tab': TAB },
      body: '{}',
    }).catch(() => {});
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
    // An API being written, a key of Claude typed (remote-llm-ui.mjs): closing asks before they are
    // lost. Whether something changed, not what the editor holds: opened and left as it was, nothing is.
    api: state.remoteUI?.dirty() ?? false,
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
      // (0.6.94) Saved by « Enregistrer » like the others (native-workflow-ui.mjs, values()): changed
      // alone, the settings closed without a question and the change was lost.
      'generation-confirm-replace',
      'generation-review-images',
      'generation-review',
      'generation-warm',
      'generation-models-dir',
      'native-convert-root',
      'generation-vae-root',
      'generation-lora-root',
      'generation-text-encoder-root',
      'generation-tokenizer-root',
      'generation-upscale-root',
      'generation-latent-upscale-root',
    ].map(id => [id, $(id).value, $(id).checked]),
    room: interfaceUI.dirty(),
    descriptions: workflowsUI.workflowDescriptions(),
    pending: workflowsUI.hasPendingImport?.() || false,
    editor: workflowsUI.editorDirty?.() || false,
  }),
});
// The APIs of Paramètres › Moodix AI, beside the local LLMs (remote-llm-ui.mjs).
state.remoteUI = setupRemoteModels({
  $,
  api,
  node,
  icon,
  // A connection chosen, saved or removed: the model of the chat changes, and its top bar with it.
  onStatus: status => {
    if (status) state.status = status;
    contextMeter.schedule();
    updateControls();
    // Another provider, another list of models in the bar of the chat.
    void state.modelChoice?.refresh();
  },
  onChange: () => renderLLMList(),
});
const contextMeter = setupContextMeter({
  $,
  api,
  // What a remote model holds is its own (its connection), not the context of llama.cpp.
  getConfig: () => (state.status?.remote ? { ...state.config, contextSize: state.status.remote.contextSize } : state.config),
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
  // (0.6.102) A workflow saved meanwhile: the Studio reads its tools at once and shows what changed
  // (its settings of the last take stay for the rest), where it waited to come on screen again.
  if (workflowsUI.takeChanges?.()) void state.studio?.workflowsSaved?.();
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
// A click anywhere in the box that is not a button (its edges, the row of its tools) goes to the
// text (16/11): the whole box is where one writes.
$('chat-form').addEventListener('click', event => {
  if (event.target?.closest?.('button, a, input, select, textarea, label, .attachments > *')) return;
  $('prompt').focus();
});
$('cancel').onclick = () => {
  if (state.controller) state.controller.abort();
  else api('tools/cancel', { jobId: state.status.toolJob?.id }).catch(error => notice(error.message));
};
$('thinking').onclick = () => {
  state.thinking = !state.thinking;
  $('thinking').setAttribute('aria-pressed', String(state.thinking));
  contextMeter.schedule();
};
// The model and its reflection in the bar of the chat (17/11): the reflection of the local model,
// or the model and the effort of a remote one, kept by the server as the last choice.
/** The name of the local model, as the top bar says it: the one given in « Vos LLM », else its file. */
function localModelName() {
  const model = (state.models || []).find(item => item.modelPath === state.config?.modelPath);
  return (
    model?.name ||
    (state.config?.modelPath ? state.config.modelPath.split(/[\\/]/).pop().replace(/\.gguf$/i, '') : 'Aucun LLM')
  );
}
state.modelChoice = setupModelChoice({
  $,
  api,
  node,
  getStatus: () => state.status,
  getThinking: () => state.thinking,
  getLocalName: () => localModelName(),
  // « Changer de modèle… », « Changer de service… »: Paramètres › Moodix AI, where they are chosen.
  openModels: () => {
    openSettings();
    settingsTabs.select('ai');
  },
  setThinking: on => {
    state.thinking = on;
    $('thinking').setAttribute('aria-pressed', String(on));
    contextMeter.schedule();
  },
  onStatus: status => {
    if (status) state.status = status;
    updateControls();
  },
  notice,
});
/**
 * The library (the Pellicule since 0.6.0), a page of its own outside a conversation: every creation,
 * those of one project (`project`) or of every one. The conversation is kept first.
 */
function showLibrary({ project = 'all' } = {}) {
  // Not held by a work of Moodix or of the Studio (0.6.81): it goes on, the miniature shows it.
  const blocked = () =>
    state.projectWorking ||
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
      // Saved first, unless a generation runs and nothing new waits in it (saveBeforeLeaving, 0.6.82):
      // the server keeps saves for its end, and the Pellicule did not open during one.
      const held = state.status?.toolJob && (!state.historyDirty || state.work?.conversationId === state.conversationId);
      if (!(await assetsUI.flush()) || !(held || (await persistConversation()))) return;
      await switchView('library', () => {
        state.view = 'library';
        state.libraryProject = project;
        delete document.body.dataset.chat;
        projectUI.render();
        void libraryUI.show({ project });
      });
    } catch (error) {
      notice(error.message);
    } finally {
      state.loadingHistory = false;
      updateControls();
    }
  });
}
// The line under the tab of the view, which glides to the tab chosen (moodix.css, top-line).
const TABS = { chat: 'chat-open', studio: 'studio-open', library: 'library-open' };
function tabLine(kind = state.view) {
  const tab = $(TABS[kind]),
    line = $('top-line');
  if (!tab || !line || !tab.offsetWidth) return;
  line.style.transform = `translateX(${Math.round(tab.offsetLeft + tab.offsetWidth / 2 - 8)}px)`;
  line.hidden = false;
}
globalThis.addEventListener?.('resize', () => tabLine());
// The view that leaves fades (120 ms), then the one that comes appears (200 ms).
const VIEW_OUT = 120,
  VIEW_IN = 200;
/**
 * From one view to another (Chat, Studio, Pellicule), one transition, the same in both directions
 * (16/11): the view that leaves fades (opacity 1 → 0, 120 ms), then the one that comes appears
 * (opacity 0 → 1 and 6 px upwards, 200 ms): never two views together, no zoom, nothing opaque on
 * them; the light, the grain and the top bar do not move, the line under the tab glides to the new
 * one. With reduced motion, or a page out of sight, the view changes at once. In the Studio, the bar
 * still opens into the chat (`open`) and the chat folds back into it (`close`), by the browser's
 * view transitions (`data-switch`). Resolves once the page shows the change.
 */
function switchView(kind, apply) {
  // A sound playing in the Pellicule stops as the page changes.
  if (kind !== 'library') state.hushLibrary?.();
  const folding = kind === 'open' || kind === 'close';
  if (!folding) {
    // Asked while another moves: that one is shown at once.
    state.viewSwitch?.();
    const root = document.documentElement,
      moves =
        state.view !== kind &&
        document.visibilityState === 'visible' &&
        !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    tabLine(kind);
    if (!moves) {
      apply();
      tabLine();
      return Promise.resolve();
    }
    let stage = 'out',
      timer = 0,
      shown,
      ended;
    const visible = new Promise(resolve => (shown = resolve)),
      moving = new Promise(resolve => (ended = resolve));
    const finish = () => {
      if (stage === 'done') return;
      clearTimeout(timer);
      if (stage === 'out') {
        apply();
        tabLine();
        shown();
      }
      stage = 'done';
      delete root.dataset.viewMove;
      if (state.viewSwitch === finish) state.viewSwitch = null;
      ended();
    };
    root.dataset.viewMove = 'out';
    timer = setTimeout(() => {
      stage = 'in';
      apply();
      tabLine();
      root.dataset.viewMove = 'in';
      shown();
      timer = setTimeout(finish, VIEW_IN);
    }, VIEW_OUT);
    state.viewSwitch = finish;
    // What can wait (the gallery, the Studio drawn again) waits for the end of the move.
    state.moving = moving;
    void moving.then(() => {
      if (state.moving === moving) state.moving = null;
    });
    return visible;
  }
  const animate =
      typeof document.startViewTransition === 'function' &&
      state.view === 'studio' &&
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
/**
 * The logo, from any view (16/11): the accueil, a new conversation in the project in hand (the one
 * the Pellicule shows, when it shows one), or in `chosen` (« + Nouvelle conversation » of the
 * Pellicule).
 */
function goHome(chosen = null) {
  // (Not while Moodix AI sets the Studio on screen, 2 to 3 s: its places wait for it, 0.6.81.)
  if (state.updating || state.closingApp || state.loadingHistory || state.studio?.settingUp?.()) return;
  requestSettingsClose(async () => {
    const project =
      typeof chosen === 'string'
        ? chosen
        : state.view === 'library' && state.libraryProject && state.libraryProject !== 'all'
          ? state.libraryProject
          : state.projectId || 'inbox';
    await switchView('chat', () => {
      state.view = 'chat';
      delete document.body.dataset.chat;
      projectUI.render();
      updateControls();
    });
    await newConversation(project);
  });
}
$('brand-home').onclick = event => {
  event.preventDefault();
  goHome();
};
$('chat-open').onclick = () => showChat();
async function newConversation(projectId = state.projectId || 'inbox') {
  // Begun while a work goes on too (0.6.81): the conversation it goes on in is set aside, alive.
  if (state.projectWorking || state.preparing || state.loadingHistory) return;
  state.loadingHistory = true;
  updateControls();
  try {
    // A conversation that cannot be saved must not trap the user in it.
    if (
      !(await saveBeforeLeaving()) &&
      !confirm('Cette conversation n’a pas pu être enregistrée. En commencer une nouvelle quand même ?')
    )
      return;
    // Its work going on, it is set aside, not erased: the miniature brings it back.
    const going = Boolean(state.work) && state.work.conversationId === state.conversationId;
    if (
      !state.saveHistory &&
      state.messages.length &&
      !going &&
      !confirm('Recommencer effacera cette conversation de la page. Continuer ?')
    )
      return;
    // Set aside in place of another, without the history: that one is lost, asked first (0.6.87).
    if (going && !asideMayGo()) return;
    // What was written in the one left, when it is not set aside with it: back when it is opened again.
    // (One not begun yet is begun again: « Nouvelle conversation » empties it, as it always did.)
    if (!setAside() && state.conversationId) keepDraft();
    state.projectId = typeof projectId === 'string' ? projectId : 'inbox';
    leaveLibrary();
    state.messages = [];
    state.images = [];
    state.videos = [];
    state.conversationId = null;
    rememberConversation(null);
    state.conversationInstructions = null;
    state.archiveSnapshot = null;
    state.historyDirty = false;
    $('prompt').value = '';
    generationUI.clear(state.aside?.nodes);
    $('messages').replaceChildren();
    $('welcome').hidden = false;
    setConversationTitle(UNTITLED);
    // What was being written in a conversation of this project not begun yet, left for another
    // (0.6.88): it is this one's.
    const left = draftLeft(leftKey(null, state.projectId));
    if (left) {
      state.images = left.images;
      state.videos = left.videos;
      $('prompt').value = left.text;
    }
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
    // A message sent again (« Régénérer », « Reprendre la demande ») keeps its own words.
    if (!promptLabel || state.resent) return;
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
    // Not for a creation alone (of the Studio, or followed again): reloaded, the page follows it again
    // (0.6.82). Moodix writing, a card waiting for the user, a series still to make would be lost.
    // Without the history, nothing is found again: asked for those too.
    (state.work && (!['studio', 'follow'].includes(state.work.kind) || !state.saveHistory)) ||
    state.savingHistory ||
    state.historyDirty ||
    $('prompt').value.trim() ||
    state.images.length ||
    state.videos.length ||
    (!state.saveHistory && state.messages.length) ||
    // The one set aside too (0.6.88): it is found nowhere else either.
    (!state.saveHistory && state.aside?.messages?.length)
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
  tabLine();
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
  // A tab reloaded: its conversation and its view again (0.6.82); at launch, the welcome in the
  // project used last (0.6.5).
  if (!(await state.recovery.resumeTab())) welcomeInLastProject();
  // A creation being made in another conversation: followed there, the miniature shows it (0.6.82).
  await state.recovery.followElsewhere();
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
