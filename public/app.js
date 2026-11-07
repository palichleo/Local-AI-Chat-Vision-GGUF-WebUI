import { readSSE } from './stream.mjs';
import { markdownToHtml } from './markdown.mjs';

const $ = (id) => document.getElementById(id);
const state = {
  token: '', config: {}, status: { state: 'stopped', vision: false, busy: false, logs: [] },
  connected: false, thinking: true, messages: [], images: [], generating: false,
  preparing: false, operation: false, controller: null, stickToBottom: true, theme: 'dark', savingTheme: false,
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
    throw new Error(data.error || `La requête a échoué (${response.status}).`);
  }
  return response;
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
  if (state.savingTheme || !state.connected) return;
  state.savingTheme = true;
  updateControls();
  try {
    const result = await (await api('preferences', { theme: state.theme === 'dark' ? 'light' : 'dark' })).json();
    applyTheme(result.preferences.theme);
  } catch (error) { notice(error.message); }
  finally { state.savingTheme = false; updateControls(); }
}

function updateControls() {
  const s = state.status;
  const running = ['loading', 'ready', 'stopping'].includes(s.state);
  const text = state.connected ? labels[s.state] || 'État inconnu' : 'Connexion interrompue';
  for (const id of ['sidebar-status', 'settings-status']) $(id).textContent = text;
  for (const dot of [$('sidebar-dot'), $('settings-dot')]) dot.className = `dot ${state.connected ? s.state : 'error'}`;
  $('theme-toggle').disabled = state.savingTheme || !state.connected;
  $('config-fields').disabled = running || state.operation || !state.connected;
  $('save-config').disabled = running || state.operation || !state.connected;
  $('save-start').disabled = running || state.operation || !state.connected;
  $('settings-stop').hidden = !running;
  $('settings-stop').disabled = s.state === 'stopping' || state.operation;
  $('toggle-engine').disabled = state.operation || s.state === 'stopping' || !state.connected;
  $('toggle-engine').classList.toggle('is-running', running);
  $('toggle-engine').replaceChildren(icon(running ? 'stop' : 'play'), node('span', '', running ? 'Arrêter le modèle' : 'Démarrer le modèle'));
  $('send').disabled = !state.connected || s.state !== 'ready' || s.busy || state.generating || state.preparing || (!$('prompt').value.trim() && !state.images.length);
  $('send').hidden = state.generating;
  $('cancel').hidden = !state.generating;
  $('thinking').disabled = state.generating;
  $('attach').disabled = state.generating || state.preparing;
  $('new-chat').disabled = state.generating;
  $('new-chat-mobile').disabled = state.generating;
  $('compose-state').textContent = state.preparing ? 'Préparation des images…' : state.generating ? 'Réponse en cours…' : s.state === 'ready' ? s.vision ? 'Texte + images' : 'Texte uniquement' : 'Démarrez le modèle pour discuter';
  $('engine-logs').textContent = s.logs?.join('\n') || 'Les journaux apparaîtront au démarrage.';
  if (s.error) {
    $('config-error').textContent = s.error;
    $('config-error').hidden = false;
  }
  const setup = {
    stopped: ['Commençons par votre modèle', state.config.modelPath ? 'Vos chemins sont enregistrés. Démarrez le modèle.' : 'Indiquez les fichiers locaux pour démarrer.'],
    loading: ['Le modèle prend place…', 'Le premier chargement peut prendre quelques instants.'],
    ready: ['Tout est prêt pour commencer', s.vision ? 'La vision est active. Ajoutez une image ou écrivez un message.' : 'Le modèle est chargé. Écrivez votre premier message.'],
    stopping: ['Arrêt du moteur…', 'La mémoire du modèle va être libérée.'],
    error: ['Le moteur demande votre attention', 'Ouvrez la configuration pour consulter le détail.'],
  }[s.state] || ['Connexion au serveur', 'Vérification de votre environnement…'];
  $('setup-title').textContent = setup[0];
  $('setup-description').textContent = setup[1];
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

function openSettings() {
  $('engine-path').value = state.config.enginePath || '';
  $('model-path').value = state.config.modelPath || '';
  $('projector-path').value = state.config.projectorPath || '';
  const size = String(state.config.contextSize || 8192);
  if (![...$('context-size').options].some((option) => option.value === size)) $('context-size').add(new Option(`${size} tokens`, size));
  $('context-size').value = size;
  const layers = state.config.gpuLayers ?? 99;
  $('compute-mode').value = [0, 99].includes(layers) ? String(layers) : 'custom';
  $('gpu-layers').value = String(layers);
  $('custom-layers-field').hidden = $('compute-mode').value !== 'custom';
  $('config-error').hidden = !state.status.error;
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
      projectorPath: $('projector-path').value, contextSize: Number($('context-size').value),
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
  if (state.generating || state.preparing) return;
  if (!state.status.vision) {
    notice('Pour envoyer des images, démarrez le modèle avec son projecteur de vision.');
    return openSettings();
  }
  if (files.length + state.images.length > 3) return notice('Vous pouvez joindre trois images au maximum par message.');
  state.preparing = true;
  updateControls();
  try {
    for (const file of files) {
      if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('Choisissez une image PNG ou JPEG.');
      if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} dépasse 10 Mo.`);
      const bitmap = await createImageBitmap(file);
      try {
        if (bitmap.width * bitmap.height > 40_000_000) throw new Error('Cette image dépasse 40 mégapixels. Réduisez sa taille avant de la joindre.');
        const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext('2d');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        state.images.push({ name: file.name, url: canvas.toDataURL('image/jpeg', 0.9) });
      } finally { bitmap.close(); }
    }
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
  const text = $('prompt').value.trim();
  const images = [...state.images];
  const content = images.length ? [
    { type: 'text', text: text || 'Décris cette image.' },
    ...images.map((image) => ({ type: 'image_url', image_url: { url: image.url } })),
  ] : text;
  const user = { role: 'user', content };
  const history = [...state.messages, user];
  const userView = userMessage(text, images);
  const view = assistantMessage();
  $('welcome').hidden = true;
  $('prompt').value = '';
  state.images = [];
  renderAttachments();
  state.generating = true;
  state.controller = new AbortController();
  state.stickToBottom = true;
  resizePrompt();
  notice('');
  scrollToBottom();
  let output = '', reasoning = '', finishReason = '', lastRender = 0;
  const started = performance.now();
  const render = () => {
    view.reasoning.hidden = !reasoning;
    view.thoughts.textContent = reasoning;
    if (output) renderText(view.body, output);
    else if (reasoning) view.body.replaceChildren(node('span', 'pending-dot', 'Réflexion en cours…'));
    scrollToBottom();
    lastRender = performance.now();
  };
  try {
    const response = await api('chat', { messages: [
      { role: 'system', content: 'Tu es un assistant utile. Réponds dans la langue de ton interlocuteur.' }, ...history,
    ], thinking: state.thinking }, { signal: state.controller.signal });
    await readSSE(response.body, (item) => {
      const choice = item.choices?.[0];
      const delta = choice?.delta || {};
      if (typeof delta.content === 'string') output += delta.content;
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (performance.now() - lastRender > 55) render();
    });
    if (!output && !reasoning) throw new Error('Le moteur a terminé sans produire de texte.');
    view.note.textContent = finishReason === 'length' ? 'Limite de 4 096 tokens atteinte. La réponse peut être incomplète.' : `${((performance.now() - started) / 1000).toFixed(1).replace('.', ',')} s · généré sur cet ordinateur`;
    $('live-status').textContent = 'La réponse du modèle est terminée.';
  } catch (error) {
    const canceled = state.controller.signal.aborted;
    if (output || reasoning) {
      view.note.textContent = canceled ? 'Réponse interrompue à votre demande.' : error.message;
      if (!canceled) view.note.classList.add('error');
    } else {
      userView.remove(); view.article.remove();
      $('prompt').value = text + ($('prompt').value ? `\n\n${$('prompt').value}` : '');
      state.images = images;
      renderAttachments();
      $('welcome').hidden = state.messages.length > 0;
    }
    if (!canceled) notice(error.message || 'La connexion a été interrompue.');
  } finally {
    if (output || reasoning) {
      render();
      if (!output) view.body.replaceChildren(node('div', 'text-block', 'Aucune réponse finale reçue.'));
      state.messages = [...history, { role: 'assistant', content: output, ...(reasoning ? { reasoning_content: reasoning } : {}) }];
      $('conversation-title').textContent = text || 'Une image à explorer';
    }
    state.generating = false;
    state.controller = null;
    resizePrompt();
    await refreshStatus();
    $('prompt').focus();
  }
}

applyTheme(document.documentElement.dataset.theme);
$('theme-toggle').onclick = toggleTheme;
$('settings-open').onclick = openSettings;
$('welcome-config').onclick = openSettings;
$('settings-close').onclick = () => $('settings').close();
$('settings-form').onsubmit = (event) => { event.preventDefault(); saveConfiguration(false); };
$('save-start').onclick = () => saveConfiguration(true);
$('compute-mode').onchange = () => { $('custom-layers-field').hidden = $('compute-mode').value !== 'custom'; };
$('toggle-engine').onclick = () => toggleEngine();
$('settings-stop').onclick = () => toggleEngine(true);
$('notice-close').onclick = () => notice('');
$('prompt').oninput = resizePrompt;
$('prompt').onkeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('chat-form').requestSubmit(); }
};
$('chat-form').onsubmit = sendMessage;
$('cancel').onclick = () => state.controller?.abort();
$('thinking').onclick = () => { state.thinking = !state.thinking; $('thinking').setAttribute('aria-pressed', String(state.thinking)); };
function newConversation() {
  if (state.messages.length && !confirm('Recommencer effacera cette conversation de la page. Continuer ?')) return;
  state.messages = []; state.images = [];
  $('messages').replaceChildren(); $('welcome').hidden = false;
  $('conversation-title').textContent = 'Nouvelle conversation';
  renderAttachments(); notice(''); updateControls(); $('prompt').focus();
}
$('new-chat').onclick = newConversation;
$('new-chat-mobile').onclick = newConversation;
document.querySelectorAll('[data-prompt]').forEach((button) => {
  button.onclick = () => { $('prompt').value = button.dataset.prompt; resizePrompt(); $('prompt').focus(); };
});
function chooseImage() {
  if (!state.status.vision) { notice('Démarrez le modèle avec son projecteur pour activer la vision.'); openSettings(); }
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
  if (state.messages.length || state.generating) { event.preventDefault(); event.returnValue = ''; }
});

try {
  const response = await fetch('/api/bootstrap');
  if (!response.ok) throw new Error('Impossible de joindre le serveur local.');
  const initial = await response.json();
  Object.assign(state, { token: initial.token, config: initial.config, status: initial.status, connected: true });
  applyTheme(initial.preferences?.theme);
  if (initial.platform !== 'win32') $('engine-path').placeholder = '/chemin/vers/llama-server';
  if (initial.warning) notice(initial.warning);
  updateControls();
} catch (error) { notice(error.message); updateControls(); }
setInterval(() => { if (!document.hidden) refreshStatus(); }, 1200);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus(); });
