import { appSources } from './lib/app-sources.mjs';
import { Projects, projectId } from './lib/projects.mjs';
import { globalContext } from './lib/global-context.mjs';
import { ModelLibrary, modelFolderName } from './lib/models.mjs';
import {
  Resources,
  capableResourceTool,
  refsToIds,
  resourceCatalogPrompt,
  resourceTool,
  resourceReadIds,
} from './lib/resources.mjs';
import { citedImages, citedMessage, citedSaid, citedUnused, citedNumbers } from './lib/cited-resources.mjs';
import { briefMissing, cardBrief, studioBrief } from './lib/video-brief.mjs';
import { shortTitle, titleRequest } from './lib/conversation-title.mjs';
import { CAPABLE, CAPABLE_CARD, CAPABLE_STUDIO, capableMessages, screenOf, takesContext, wordingOf } from './lib/model-wording.mjs';
import { listedSources } from './lib/listed-takes.mjs';
import { stampRecord } from './lib/media-info.mjs';
import { SEEN_NOTE, unseenResources } from './lib/seen-resources.mjs';
import { askedSince, characterOf, characterPrompt, lastReplacement, withScenePrompt } from './lib/scene-prompt.mjs';
import { passedImages, thinNote } from './lib/thin-prompt.mjs';
import { capableOutputTool, outputToolFor, readOutput, takesToRead } from './lib/output-tools.mjs';
import { sendResourceMedia } from './lib/resource-media.mjs';
import { generatedFile } from './lib/generated-media.mjs';
import { countContext } from './lib/context-count.mjs';
import http from 'node:http';
import { compactSession } from './public/update-ui.mjs';
import { checkForUpdates } from './lib/updates.mjs';
import { componentVersions, runVersion } from './lib/components.mjs';
import { prepareUpdate, launchInstaller } from './lib/update-install.mjs';
import { atomicFile, atomicJson } from './lib/update-files.mjs';
import { updateSession, readUpdateSession } from './lib/update-session.mjs';
import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { AUTOMATIC_REASONS, History, MAX_CONVERSATION_MESSAGES, TRASH_DAYS } from './lib/history.mjs';
import { HistoryJournal } from './lib/history-journal.mjs';
import { chooseLocalFile } from './lib/file-picker.mjs';
import { Gallery } from './lib/gallery.mjs';
import { Thumbnails } from './lib/thumbnails.mjs';
import { ToolRuntime, chatImageUrls, collectToolCalls, firstWholeCall, unreadAnswer } from './lib/tool-runtime.mjs';
import { roomSettings } from './public/room.mjs';
import { nativeFields } from './lib/native-messages.mjs';
import { readSSE } from './public/stream.mjs';
import { Engine, defaults, normalizeConfig, problem } from './lib/engine.mjs';
import { ChatModel, estimateContext, listModels, testConnection } from './lib/chat-model.mjs';
import { PRESETS, RemoteModels, apiKey, connectionOf, hostOf } from './lib/remote-models.mjs';
import { ChatGPTAccount } from './lib/chatgpt.mjs';
import { OpenRouterSignIn, openRouterModels } from './lib/openrouter.mjs';
import { CLAUDE_DEFAULT, ClaudeAccess } from './lib/claude.mjs';
import { relocate } from './lib/relocate.mjs';
import { FOLDER_KEYS, GenerationService, generationConfig } from './lib/generation-service.mjs';
import { convertLongForge } from './lib/longforge-conversion.mjs';
import { generatedMedia } from './lib/generated-media.mjs';
import { validateNativeWorkflow } from './lib/native-workflows.mjs';
import { families, familyTemplate } from './lib/families.mjs';
import { ProgressHistory } from './lib/generation-progress.mjs';
import { StudioPresets } from './lib/studio-presets.mjs';
import { convertKreaWorkflow } from './lib/native-workflow-conversion.mjs';
import { importComfyWorkflow } from './lib/comfy-import.mjs';
import { previewWorkflowImport } from './lib/workflow-import.mjs';
import { STUDIO_ID, STUDIO_VERBS, enrichedPrompt, enrichMessages } from './lib/studio.mjs';
import { LlamaBuilds } from './lib/llama-builds.mjs';
import { Takes, numbered, takesToOutputs } from './lib/takes.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const maxBody = 20 * 1024 * 1024;
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  // The small logo (claude_design/maquettes/logo.md, Éclipse): its fallback, its icon for a phone's home
  // screen, a large one, and the mark of Moodix AI, in ivory and in ink.
  ['/favicon.ico', ['favicon.ico', 'image/x-icon']],
  ['/apple-touch-icon.png', ['apple-touch-icon.png', 'image/png']],
  ['/icon-512.png', ['icon-512.png', 'image/png']],
  ['/assets/moodix-mark.svg', ['assets/moodix-mark.svg', 'image/svg+xml']],
  ['/assets/moodix-mark-encre.svg', ['assets/moodix-mark-encre.svg', 'image/svg+xml']],
  ['/update-ui.mjs', ['update-ui.mjs', 'text/javascript; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/project-navigation.mjs', ['project-navigation.mjs', 'text/javascript; charset=utf-8']],
  ['/library.mjs', ['library.mjs', 'text/javascript; charset=utf-8']],
  ['/reference-tokens.mjs', ['reference-tokens.mjs', 'text/javascript; charset=utf-8']],
  ['/reference-picker.mjs', ['reference-picker.mjs', 'text/javascript; charset=utf-8']],
  ['/cited-takes.mjs', ['cited-takes.mjs', 'text/javascript; charset=utf-8']],
  ['/contact-sheet.mjs', ['contact-sheet.mjs', 'text/javascript; charset=utf-8']],
  ['/unexpected-errors.mjs', ['unexpected-errors.mjs', 'text/javascript; charset=utf-8']],
  ['/moodix.css', ['moodix.css', 'text/css; charset=utf-8']],
  // « Salle obscure » (0.6.0): the room behind the page, its two fonts, the tile of its dithering.
  ['/room.mjs', ['room.mjs', 'text/javascript; charset=utf-8']],
  ['/fonts/Gloock-latin.woff2', ['fonts/Gloock-latin.woff2', 'font/woff2']],
  ['/fonts/Gloock-latin-ext.woff2', ['fonts/Gloock-latin-ext.woff2', 'font/woff2']],
  ['/fonts/Jost-latin.woff2', ['fonts/Jost-latin.woff2', 'font/woff2']],
  ['/fonts/Jost-latin-ext.woff2', ['fonts/Jost-latin-ext.woff2', 'font/woff2']],
  ['/assets/tramage-64.png', ['assets/tramage-64.png', 'image/png']],
  ['/fonts/Michroma-Regular.ttf', ['fonts/Michroma-Regular.ttf', 'font/ttf']],
  ['/fonts/Manrope-Variable.ttf', ['fonts/Manrope-Variable.ttf', 'font/ttf']],
  ['/fonts/JetBrainsMono-Variable.ttf', ['fonts/JetBrainsMono-Variable.ttf', 'font/ttf']],
  ['/studio-pointer.mjs', ['studio-pointer.mjs', 'text/javascript; charset=utf-8']],
  ['/studio-explain.mjs', ['studio-explain.mjs', 'text/javascript; charset=utf-8']],
  ['/settings-search.mjs', ['settings-search.mjs', 'text/javascript; charset=utf-8']],
  ['/settings-tabs.mjs', ['settings-tabs.mjs', 'text/javascript; charset=utf-8']],
  ['/help-tips.mjs', ['help-tips.mjs', 'text/javascript; charset=utf-8']],
  ['/generation-ui.mjs', ['generation-ui.mjs', 'text/javascript; charset=utf-8']],
  ['/generation-time.mjs', ['generation-time.mjs', 'text/javascript; charset=utf-8']],
  ['/work-miniature.mjs', ['work-miniature.mjs', 'text/javascript; charset=utf-8']],
  ['/take-recovery.mjs', ['take-recovery.mjs', 'text/javascript; charset=utf-8']],
  // The takes no message of their conversation shows any more (0.6.99).
  ['/detached-takes.mjs', ['detached-takes.mjs', 'text/javascript; charset=utf-8']],
  ['/assets-ui.mjs', ['assets-ui.mjs', 'text/javascript; charset=utf-8']],
  ['/resource-preparation.mjs', ['resource-preparation.mjs', 'text/javascript; charset=utf-8']],
  ['/copy.mjs', ['copy.mjs', 'text/javascript; charset=utf-8']],
  ['/thumbnails.mjs', ['thumbnails.mjs', 'text/javascript; charset=utf-8']],
  ['/live-preview.mjs', ['live-preview.mjs', 'text/javascript; charset=utf-8']],
  ['/interface-settings.mjs', ['interface-settings.mjs', 'text/javascript; charset=utf-8']],
  ['/take-flux.mjs', ['take-flux.mjs', 'text/javascript; charset=utf-8']],
  ['/take-player.mjs', ['take-player.mjs', 'text/javascript; charset=utf-8']],
  ['/first-launch.mjs', ['first-launch.mjs', 'text/javascript; charset=utf-8']],
  ['/missing-file.mjs', ['missing-file.mjs', 'text/javascript; charset=utf-8']],
  ['/model-licenses.mjs', ['model-licenses.mjs', 'text/javascript; charset=utf-8']],
  ['/models-page.mjs', ['models-page.mjs', 'text/javascript; charset=utf-8']],
  ['/glass-menu.mjs', ['glass-menu.mjs', 'text/javascript; charset=utf-8']],
  ['/reflection.mjs', ['reflection.mjs', 'text/javascript; charset=utf-8']],
  ['/media-info.mjs', ['media-info.mjs', 'text/javascript; charset=utf-8']],
  ['/transcript.mjs', ['transcript.mjs', 'text/javascript; charset=utf-8']],
  ['/settings-guard.mjs', ['settings-guard.mjs', 'text/javascript; charset=utf-8']],
  ['/context-meter.mjs', ['context-meter.mjs', 'text/javascript; charset=utf-8']],
  ['/stream.mjs', ['stream.mjs', 'text/javascript; charset=utf-8']],
  ['/model-ready.mjs', ['model-ready.mjs', 'text/javascript; charset=utf-8']],
  ['/remote-llm-ui.mjs', ['remote-llm-ui.mjs', 'text/javascript; charset=utf-8']],
  ['/model-choice.mjs', ['model-choice.mjs', 'text/javascript; charset=utf-8']],
  ['/image-series.mjs', ['image-series.mjs', 'text/javascript; charset=utf-8']],
  ['/images.mjs', ['images.mjs', 'text/javascript; charset=utf-8']],
  ['/video-plan.mjs', ['video-plan.mjs', 'text/javascript; charset=utf-8']],
  ['/proposal-card.mjs', ['proposal-card.mjs', 'text/javascript; charset=utf-8']],
  ['/formats.mjs', ['formats.mjs', 'text/javascript; charset=utf-8']],
  ['/output-actions.mjs', ['output-actions.mjs', 'text/javascript; charset=utf-8']],
  ['/chat-videos.mjs', ['chat-videos.mjs', 'text/javascript; charset=utf-8']],
  ['/studio.mjs', ['studio.mjs', 'text/javascript; charset=utf-8']],
  ['/image-compare.mjs', ['image-compare.mjs', 'text/javascript; charset=utf-8']],
  ['/session-copies.mjs', ['session-copies.mjs', 'text/javascript; charset=utf-8']],
  ['/generation-runtime.mjs', ['generation-runtime.mjs', 'text/javascript; charset=utf-8']],
  ['/native-workflow-ui.mjs', ['native-workflow-ui.mjs', 'text/javascript; charset=utf-8']],
  ['/setting-names.mjs', ['setting-names.mjs', 'text/javascript; charset=utf-8']],
  ['/settings-controls.mjs', ['settings-controls.mjs', 'text/javascript; charset=utf-8']],
  ['/markdown.mjs', ['markdown.mjs', 'text/javascript; charset=utf-8']],
]);

async function jsonBody(req, limit = maxBody) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''))
    throw problem('Le format JSON est attendu.', 415);
  if (Number(req.headers['content-length'] || 0) > limit)
    throw problem('La requête dépasse 20 Mo. Réduisez le nombre d’images ou commencez une nouvelle conversation.', 413);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw problem('La requête dépasse 20 Mo.', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw problem('Le JSON reçu est invalide.');
  }
}

/**
 * A request for a remote model that does not see images: the images of the conversation said in
 * words in their place. Refused, every turn of a conversation that once had an image would fail.
 */
function withoutImages(input) {
  if (!Array.isArray(input?.messages)) return input;
  const said = { type: 'text', text: '[Image jointe non montrée : ce modèle ne voit pas les images.]' };
  return {
    ...input,
    messages: input.messages.map(message =>
      Array.isArray(message?.content) && message.content.some(part => part?.type === 'image_url')
        ? { ...message, content: message.content.map(part => (part?.type === 'image_url' ? said : part)) }
        : message,
    ),
  };
}

function chatPayload(input, vision, maxOutputTokens, countOnly = false) {
  if (
    !input ||
    !Array.isArray(input.messages) ||
    !input.messages.length ||
    input.messages.length > MAX_CONVERSATION_MESSAGES
  )
    throw problem(
      `La conversation doit contenir entre 1 et ${MAX_CONVERSATION_MESSAGES} messages. Commencez une nouvelle conversation si nécessaire.`,
    );
  const messages = input.messages.map((message, index) => {
    if (
      !message ||
      !['system', 'user', 'assistant', 'tool'].includes(message.role) ||
      (message.role === 'system' && index !== 0)
    )
      throw problem('Rôle de message invalide.');
    let content = message.content;
    if (typeof content === 'string') {
      if (content.length > 200000) throw problem('Un message est trop long.');
    } else if (Array.isArray(content) && content.length > 0 && content.length <= 65 && message.role === 'user') {
      let imageCount = 0;
      content = content.map(part => {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text.length <= 200000)
          return { type: 'text', text: part.text };
        if (part?.type !== 'image_url' || !vision)
          throw problem('Pour envoyer une image, charge le projecteur de vision avec le modèle.');
        if (++imageCount > 64) throw problem('Un message peut contenir au maximum 64 images.');
        const url = part.image_url?.url;
        if (typeof url !== 'string' || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(url))
          throw problem('Seules les images PNG/JPEG locales sont acceptées.');
        const comma = url.indexOf(',');
        const bytes = Buffer.from(url.slice(comma + 1), 'base64');
        if (bytes.length > 5 * 1024 * 1024) throw problem('Une image préparée dépasse 5 Mo.');
        const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        if (
          (!png && !jpeg) ||
          (url.startsWith('data:image/png') && !png) ||
          (url.startsWith('data:image/jpeg') && !jpeg)
        )
          throw problem('Le contenu d’une image est invalide.');
        return { type: 'image_url', image_url: { url } };
      });
    } else throw problem('Contenu de message invalide.');
    const result = { role: message.role, content, ...nativeFields(message) };
    if (message.role === 'assistant' && typeof message.reasoning_content === 'string') {
      if (message.reasoning_content.length > 200000)
        throw problem('Le raisonnement conservé est trop long. Commencez une nouvelle conversation.');
      result.reasoning_content = message.reasoning_content;
    }
    return result;
  });
  const unresolved = new Set();
  for (const message of messages) {
    if (message.tool_calls) {
      if (unresolved.size) throw problem('Résultat d’outil manquant.');
      for (const call of message.tool_calls) unresolved.add(call.id);
    } else if (message.role === 'tool') {
      if (!unresolved.delete(message.tool_call_id)) throw problem('Résultat d’outil sans appel correspondant.');
    } else if (unresolved.size) throw problem('Résultat d’outil manquant.');
  }
  if (unresolved.size) throw problem('Résultat d’outil manquant.');
  const last = messages.at(-1);
  if (
    !countOnly &&
    (!['user', 'tool'].includes(last.role) || (typeof last.content === 'string' && !last.content.trim()))
  )
    throw problem('Écrivez un message ou joignez une image.');
  return {
    model: 'local',
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.7,
    top_p: 0.95,
    top_k: 20,
    max_tokens: maxOutputTokens,
    reasoning_format: 'deepseek',
    chat_template_kwargs: { enable_thinking: input.thinking !== false },
  };
}

/** 32 random bytes kept in a file of their own: drawn the first time, then read again. */
async function keptSecret(path) {
  try {
    const bytes = await readFile(path);
    if (bytes.length === 32) return bytes;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const bytes = randomBytes(32);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { mode: 0o600 });
  return bytes;
}

export async function createApplication({
  port = 8787,
  dataDir = join(root, 'data'),
  publicDir = join(root, 'public'),
  modelsDir = join(root, 'models'),
  historyDir = dataDir === join(root, 'data') ? join(root, 'history') : join(dataDir, 'history'),
  workflowDir = dataDir === join(root, 'data') ? join(root, 'workflow') : join(dataDir, 'workflow'),
  // Workflows shipped with Atelier (replaced by updates); tests start without them.
  builtinWorkflowDir = dataDir === join(root, 'data') ? join(root, 'runner', 'workflows') : null,
  outputDir = dataDir === join(root, 'data') ? join(root, 'output') : join(dataDir, 'output'),
  generationWorker,
  spawnProcess,
  // Whether the local chat model is asked to name a conversation (/api/history/title): 'gpu', when
  // it runs on the card; true, always; false, never. Measured (17/11, RTX 4070 SUPER, a 9B model
  // with its projector, a prompt of 12 786 tokens): the request beside the conversation takes
  // 0.45 s, and the next message reads 188 tokens in 0.11 s, as without it — llama.cpp keeps the
  // prompt of the conversation aside and takes it back. Were it lost, that prompt would be read
  // again once (3.4 s on that card; far longer on a processor alone, hence 'gpu').
  localTitles = 'gpu',
  filePicker = chooseLocalFile,
  updateChecker = null,
  updateInstaller = null,
  managed = false,
  // Starts the launcher again (POST /api/relaunch); tests pass their own.
  launcher = startLauncher,
  // The official builds of llama.cpp (lib/llama-builds.mjs); tests pass their own.
  llamaBuilds: givenLlamaBuilds = null,
  // A generation call with a two-line prompt is sent back once (lib/thin-prompt.mjs).
  fullPrompts = true,
  currentSources = appSources,
  controlTimeoutMs = 15000,
  controlHeartbeatMs = 10000,
  controlReconnectMs = 2000,
  chatHeartbeatMs = 10000,
  // How long the chat model may take to enrich a prompt for the Studio.
  enrichTimeoutMs = 90000,
  // Opens a page in the browser of the system (the sign-in of ChatGPT); tests pass their own.
  openUrl = url => openBrowser(url, { report: () => {} }),
  // « Continuer avec ChatGPT » (lib/chatgpt.mjs); tests pass one that talks to their own server.
  chatgpt: givenChatGPT = null,
  // « Se connecter à OpenRouter » (lib/openrouter.mjs): where its pages are; tests pass their own server.
  openrouter: openrouterOptions = {},
  // Claude (lib/claude.mjs): where its API is, how its library loads; tests pass their own.
  claude: claudeOptions = {},
} = {}) {
  // Keep HTML, scripts and styles paired with this running backend until restart.
  const frontend = new Map(
    await Promise.all(
      [...staticFiles].map(async ([path, [file, mime]]) => [
        path,
        { contents: await readFile(join(publicDir, file)), mime, file },
      ]),
    ),
  );
  const sources = await appSources(root);
  await mkdir(dataDir, { recursive: true });
  const { version: applicationVersion } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  let applyingUpdate = false,
    installState = { state: 'idle', error: '' };
  let installTask = Promise.resolve(),
    installHandle = null;
  const installController = new AbortController();
  const configPath = join(dataDir, 'config.json');
  const models = new ModelLibrary(join(dataDir, 'models.json'), modelsDir);
  let config = { ...defaults };
  let configWarning = '';
  try {
    config = normalizeConfig(JSON.parse(await readFile(configPath, 'utf8')));
    const moved = {
      ...config,
      modelPath: relocate(config.modelPath, root),
      projectorPath: relocate(config.projectorPath, root),
    };
    if (moved.modelPath !== config.modelPath || moved.projectorPath !== config.projectorPath) {
      config = moved;
      await atomicJson(configPath, config);
    }
  } catch (error) {
    if (error.code !== 'ENOENT')
      configWarning = 'La configuration enregistrée est illisible. Renseigne à nouveau les chemins.';
  }
  const instructionsPath = join(dataDir, 'global-context.json');
  let instructions = '';
  try {
    const bytes = await readFile(instructionsPath);
    if (bytes.length > 100000) throw Error('too large');
    instructions = globalContext(JSON.parse(bytes).instructions);
  } catch (error) {
    if (error.code !== 'ENOENT') configWarning = 'Les consignes globales enregistrées sont illisibles.';
  }
  const preferencesPath = join(dataDir, 'preferences.json');
  let preferences = { theme: 'dark', saveHistory: true };
  try {
    const saved = JSON.parse(await readFile(preferencesPath, 'utf8'));
    if (['dark', 'light'].includes(saved?.theme)) preferences.theme = saved.theme;
    if (typeof saved?.saveHistory === 'boolean') preferences.saveHistory = saved.saveHistory;
    // Fond, éclairage, grain (Paramètres › Interface): read back too. Left out, they came back to
    // their defaults at every start, and the next preference saved wrote the file without them.
    if (saved?.room && typeof saved.room === 'object' && !Array.isArray(saved.room)) preferences.room = roomSettings(saved.room);
  } catch {
    /* Missing or damaged preferences use the default appearance. */
  }
  let savingPreferences = false;
  let disablingHistory = false;
  let clearingHistory = false;
  let persistingGallery = false;
  let galleryBatch = Promise.resolve();
  // What becomes of each conversation, one line each (0.6.103): data/history-journal.jsonl.
  const historyJournal = new HistoryJournal(join(dataDir, 'history-journal.jsonl'), { version: applicationVersion });
  const history = new History(historyDir, { journal: historyJournal });
  let historySaves = Promise.resolve();
  const projects = new Projects(join(dataDir, 'projects.json'));
  // « Enregistrer » of the Studio: the settings kept per model, apart from the workflows.
  const studioPresets = new StudioPresets(join(dataDir, 'studio-presets.json'));
  const attachmentUrl = (conversationId, file) =>
    `/media/attachments/${conversationId}/${file}?key=${mediaKey(conversationId + '/' + file, 'attachment')}`;
  /** A session taken back: each attached image links to its stored file, as in a conversation read from the history. */
  const sessionView = saved => {
    if (!saved?.conversationId) return saved;
    const seen = part =>
      part.type === 'image_url' && part.file ? { ...part, view: attachmentUrl(saved.conversationId, part.file) } : part,
      linked = list =>
        list.map(message => (Array.isArray(message.content) ? { ...message, content: message.content.map(seen) } : message));
    return {
      ...saved,
      messages: linked(saved.messages),
      ...(saved.archiveSnapshot
        ? { archiveSnapshot: { ...saved.archiveSnapshot, messages: linked(saved.archiveSnapshot.messages) } }
        : {}),
      images: saved.images.map(item =>
        item.file ? { ...item, view: attachmentUrl(saved.conversationId, item.file) } : item,
      ),
    };
  };
  const historyView = record => ({
    ...record,
    ...(record.preview
      ? { previewUrl: '/media/previews/' + record.id + '?key=' + mediaKey(record.id, 'conversation-preview') }
      : {}),
    // Each attached image links to its stored file, which the page shows instead of the model's copy.
    ...(Array.isArray(record.messages)
      ? {
          messages: record.messages.map(message =>
            Array.isArray(message.content)
              ? {
                  ...message,
                  content: message.content.map(part =>
                    part.type === 'image_url' && part.file ? { ...part, view: attachmentUrl(record.id, part.file) } : part,
                  ),
                }
              : message,
          ),
        }
      : {}),
  });
  const token = randomBytes(32).toString('hex');
  const engine = new Engine({ spawnProcess, cacheDir: join(dataDir, 'model-cache') });
  // The chat model of Moodix AI, the one of llama.cpp or a remote one (lib/chat-model.mjs): what the
  // chat, the Studio and the generations ask. `engine` stays for what only concerns llama.cpp.
  const remotes = new RemoteModels(dataDir);
  const chatgpt = givenChatGPT ?? new ChatGPTAccount({ dataDir, openUrl });
  // `chat` is made below: the sign-in only tells it once a key comes back.
  const openrouter = new OpenRouterSignIn({ remotes, openUrl, onSaved: id => chat.changed(id), ...openrouterOptions });
  // Claude by the key of its Console, through Anthropic's library installed on demand (lib/claude.mjs).
  const claude = new ClaudeAccess({ root, ...claudeOptions });
  const chat = await new ChatModel({
    engine,
    remotes,
    chatgpt,
    claude,
    openrouterModels: (connection, options) => openRouterModels(connection, { ...options, ...openrouterOptions.listing }),
  }).load();
  /** What the settings show of the remote models: the connections (whether a key is kept), the accounts. */
  const remoteView = async () => ({
    ...(await remotes.list()),
    presets: PRESETS,
    chatgpt: await chatgpt.status(),
    openrouter: openrouter.status(),
    claude: await claude.status(),
  });
  /**
   * The provider `name` of the list chosen for the chat (Paramètres › Moodix AI): its connection, made
   * the first time with a model it offers, once its account is associated (ChatGPT signed in, the
   * key of Claude checked, OpenRouter signed in).
   */
  async function useProvider(name, { key } = {}) {
    if (!['chatgpt', 'claude', 'openrouter'].includes(name)) throw problem('Fournisseur inconnu.');
    const existing = await remotes.provider(name);
    let model = existing?.model;
    if (name === 'chatgpt') {
      if (!(await chatgpt.status()).connected) throw problem('Connectez-vous d’abord à ChatGPT (Continuer avec ChatGPT).', 409);
      model ??= (await chatgpt.models())[0]?.id;
      if (!model) throw problem('Votre compte ChatGPT ne propose aucun modèle utilisable ici.', 502);
    } else if (name === 'claude') {
      const kept = typeof key === 'string' && key.trim() ? apiKey(key) : existing?.key;
      if (!kept) throw problem('Collez d’abord votre clé d’API Claude (console.anthropic.com › API Keys).', 409);
      // The key checked by the list of its models, before it is kept.
      const listed = await claude.models(kept, { signal: AbortSignal.timeout(30000) });
      model = listed.some(item => item.id === model) ? model : (listed.find(item => item.id === CLAUDE_DEFAULT) ?? listed[0])?.id;
      key = kept;
    } else if (!existing?.key) throw problem('Connectez-vous d’abord à OpenRouter (Se connecter à OpenRouter).', 409);
    const { key: _kept, ...rest } = existing ?? {};
    const saved = await remotes.save({
      ...rest,
      preset: name,
      model: model ?? existing.model,
      vision: existing?.vision ?? name !== 'openrouter',
      ...(name === 'claude' ? { key } : {}),
    });
    await chat.changed(saved.id);
    await chat.use(saved.id);
    // What the model takes (images, its context, its efforts) from its listing, as when it is chosen
    // in the bar of the chat; a listing that does not answer leaves what was kept.
    try {
      await chat.choose({ model: saved.model });
    } catch (error) {
      console.error(`Modèles de ${name} :`, error.message);
    }
    return remotes.get(saved.id);
  }
  let componentsCheck = null;
  let savingSettings = false;
  let modelOperation = Promise.resolve();
  let pickingFile = false;
  let savingGeneration = false;
  // The numbers of the takes, « PRISE n » (lib/takes.mjs): one counter per project. A take is
  // numbered in the project of its conversation: saved, its own; not saved yet, the one the page
  // named with its last request (chat, Studio); otherwise « Sans projet ».
  const takes = new Takes(join(dataDir, 'takes.json'));
  const namedProjects = new Map();
  const projectFor = async conversationId =>
    conversationId === STUDIO_ID
      ? 'inbox'
      : ((await history.projectOf(conversationId).catch(() => null)) ?? namedProjects.get(conversationId) ?? 'inbox');
  const gallery = new Gallery({
    historyDir,
    numbering: async (conversationId, count) => takes.next(await projectFor(conversationId), count),
  });
  /**
   * The takes made before the numbers (0.6.4), numbered once in the order of their creation, in
   * the project of their conversation; the counters made again from the manifests the same way if
   * takes.json is lost (a number already given is kept).
   */
  async function numberEarlierTakes() {
    if (await takes.ready()) return;
    const places = new Map();
    for (const item of (await history.list().catch(() => ({ conversations: [] }))).conversations)
      places.set(item.id, item.projectId || 'inbox');
    const byProject = new Map();
    for (const id of await gallery.conversations().catch(() => [])) {
      const project = id === STUDIO_ID ? 'inbox' : places.get(id) || 'inbox';
      try {
        const { runs } = await gallery.list(id, { includeImages: false });
        byProject.set(project, [...(byProject.get(project) ?? []), ...runs]);
      } catch {
        // A conversation that cannot be read leaves the others.
      }
    }
    const counters = { inbox: 0 };
    for (const [project, runs] of byProject) {
      const { changed, last } = numbered(runs);
      for (const { run, takes: numbers } of changed)
        await gallery.setTakes(run.conversationId, run.id, numbers).catch(error => console.error('Numéros de prise :', error.message));
      counters[project] = last;
    }
    await takes.raise(counters);
  }
  /**
   * The takes of a project by their number, for the model: those of the conversation open, and of
   * the others of its project (native results only: they are passed as their files).
   */
  async function projectTakes(conversationId, project) {
    const ids = new Set(conversationId ? [conversationId] : []);
    if (preferences.saveHistory)
      for (const item of (await history.list().catch(() => ({ conversations: [] }))).conversations)
        if ((item.projectId || 'inbox') === project) ids.add(item.id);
    const found = [];
    for (const id of ids)
      try {
        for (const run of (await gallery.list(id, { includeImages: false })).runs)
          if (run.provider === 'native')
            run.outputs.forEach((output, index) => {
              if (Number.isInteger(output.take))
                found.push({ take: output.take, id: run.id, index, conversationId: id, mediaType: run.mediaType || 'image' });
            });
      } catch {
        // A conversation that cannot be read leaves the others.
      }
    return found.sort((a, b) => a.take - b.take);
  }
  /** The sources of a call named by their number, `{ take: 12 }`, made the take they stand for. */
  async function withTakes(text, conversationId, project) {
    // (lib/takes.mjs: what else a source says stays, the `frame` of a video take among it.)
    return takesToOutputs(text, () => projectTakes(conversationId, project), conversationId);
  }
  /**
   * Conversations that go to another project (moved, or their project deleted): their takes take
   * the numbers that follow in it, in their order of creation.
   */
  async function renumber(conversationIds, project) {
    const runs = [];
    for (const id of conversationIds)
      try {
        runs.push(...(await gallery.list(id, { includeImages: false })).runs);
      } catch {
        // A conversation that cannot be read leaves the others.
      }
    runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const count = runs.reduce((sum, run) => sum + run.outputs.length, 0);
    if (!count) return;
    const numbers = await takes.next(project, count);
    let at = 0;
    for (const run of runs) await gallery.setTakes(run.conversationId, run.id, run.outputs.map(() => numbers[at++]));
  }
  // Small pictures of the creations, made by the page and kept here (lib/thumbnails.mjs).
  const thumbnails = await new Thumbnails(join(dataDir, 'thumbnails')).load();
  const resources = new Resources(join(dataDir, 'resources'));
  // The secret of the media addresses (their `?key=`): kept in the data folder, the same from one
  // launch to the next (0.5.128). A page left open through a restart takes the new key of the page
  // by itself (public/app.js) and goes on showing and playing what it shows.
  const mediaSecret = await keptSecret(join(dataDir, 'media-secret')),
    resourceTurns = new Map(),
    // How many times the chat model was asked to name each conversation (/api/history/title).
    titleTries = new Map();
  const mediaKey = (id, part) =>
    createHmac('sha256', mediaSecret)
      .update(id + '/' + part)
      .digest('hex');
  const resourceView = record => ({
    ...record,
    originalUrl: `/media/resources/${record.id}/original?key=${mediaKey(record.id, 'original')}`,
    previewUrl: record.ready ? `/media/resources/${record.id}/preview?key=${mediaKey(record.id, 'preview')}` : null,
  });
  await numberEarlierTakes().catch(error => console.error('Numéros de prise :', error.message));
  const pendingSession = await readUpdateSession(dataDir).catch(() => null);
  for (const record of pendingSession?.gallery || []) await gallery.put(record, { persist: false });
  // Attachments of conversations never saved belong to a session that has ended.
  await history.pruneUnsaved(pendingSession?.conversationId ?? null).catch(error => console.error(error));
  // What waited 30 days in the bin of the history goes for good, its thumbnails with it (0.6.103).
  for (const id of await history.purgeTrash().catch(error => (console.error(error), [])))
    await thumbnails.forget(id).catch(() => {});
  const generation = await new GenerationService({
    root,
    dataDir,
    workflowDir,
    builtinWorkflowDir,
    outputDir,
    worker: generationWorker,
  }).init();
  const runtime = new ToolRuntime({
    engine: chat,
    catalog: generation.catalog,
    gallery,
    resources,
    getConfig: () => ({ ...generation.config, baseUrl: 'native' }),
    engineConfig: () => config,
    saveConfig: value => generation.save(value),
    persist: () => preferences.saveHistory,
    clientFactory: () => generation.client(),
    timing: new ProgressHistory(join(dataDir, 'generation-timing.json')),
    // What made a creation, written in its own file (public/media-info.mjs reads it back).
    stamp: record => stampRecord(outputDir, record, { version: applicationVersion }),
    // What a shipped workflow lacks, to download from the chat (etats-maquette.md, 53).
    offerOf: async workflow => (await generation.downloads.offers([workflow]))[workflow.id] ?? null,
    // The first or last picture of a video (`frame`: "first" or "last" where an image is taken): read
    // from its file by the Python of the engine, kept as a reference of the conversation's project.
    extractStill: (path, at) => generation.videoStill(path, at),
    projectOf: conversationId => projectFor(conversationId),
    // The LoRAs kept for a model with « Enregistrer », those whose file is still listed (one gone
    // would fail the creation): a creation asked in the Chat is made with them. Those gone are
    // given apart (`missing`): the proposal says which it is made without.
    savedStyles: async id => {
      const kept = (await studioPresets.all())[id]?.styles ?? [];
      if (!kept.length) return [];
      const listed = new Set(await generation.styles());
      return {
        kept: kept.filter(style => listed.has(style.name)),
        missing: kept.filter(style => !listed.has(style.name)),
      };
    },
    sourceMedia: async (ref, conversationId) => {
      if (ref.attachment) return { ...(await history.attachment(conversationId, ref.attachment)), name: 'Image jointe' };
      if (ref.resource_id) {
        await resources.activeRecord(ref.resource_id);
        return resources.media(ref.resource_id, 'original');
      }
      // Made in another conversation of the project (the Sortie of the Studio is the project's).
      const record = await gallery.get(ref.output_conversation ?? conversationId, ref.output_id, {
        includeImages: false,
      });
      if (record.provider !== 'native' || !record.outputs[ref.output_index ?? 0])
        throw problem('Le fichier original de ce résultat est indisponible.');
      const output = record.outputs[ref.output_index ?? 0];
      return {
        ...(await generatedMedia(outputDir, output.source)),
        name: Number.isInteger(output.take) ? 'Prise ' + output.take : record.workflowName,
      };
    },
    // The picture of an input of a proposal, for its card (DÉBUT, FIN, RÉF. n): the image the user
    // joined, the preview of a reference, the thumbnail of a take (an image take itself until it has
    // one). Null for anything else: the card shows its name.
    previewOf: (ref, conversationId, media) => {
      if (ref.attachment) return attachmentUrl(conversationId, ref.attachment);
      if (ref.resource_id) return `/media/resources/${ref.resource_id}/preview?key=${mediaKey(ref.resource_id, 'preview')}`;
      if (!ref.output_id) return null;
      const owner = ref.output_conversation ?? conversationId,
        index = ref.output_index ?? 0;
      if (thumbnails.has(Thumbnails.key(owner, ref.output_id, index))) return thumbUrl(owner, ref.output_id, index);
      return media === 'image'
        ? `/media/generated/${owner}/${ref.output_id}/${index}?key=` +
            mediaKey(owner + '/' + ref.output_id + '/' + index, 'generated')
        : null;
    },
  });
  /**
   * A few frames of a video made earlier in a conversation, read from its file by the worker
   * (runner.video.frames): for the prompt of a character put in it. { urls, video }, or null.
   */
  async function outputFrames(conversationId, runId, index = 0) {
    const record = await gallery.get(conversationId, runId, { includeImages: false });
    const output = record.outputs[index];
    if (record.provider !== 'native' || !output?.source) return null;
    if ((record.mediaType || 'image') !== 'video') return { urls: [], video: false };
    const { path } = await generatedFile(outputDir, output.source);
    const frames = await generation.videoFrames(path, 3);
    return { urls: frames.map(frame => frame.url), video: true };
  }
  /** Width and height of the video a character is put in: as its record or its resource says. */
  async function sourceSize(source, conversationId) {
    try {
      if (typeof source?.resource === 'string') {
        const { width, height } = await resources.activeRecord(source.resource);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      if (typeof source?.output === 'string') {
        const record = await gallery.get(source.conversation ?? conversationId, source.output, { includeImages: false }),
          output = record.outputs[Number(source.index ?? 0)] ?? {},
          width = output.width ?? record.parameters?.width,
          height = output.height ?? record.parameters?.height;
        return width > 0 && height > 0 ? { width, height } : null;
      }
    } catch {
      // Unknown: the image of the character keeps the size of its own workflow.
    }
    return null;
  }
  function galleryView(record) {
    return {
      ...record,
      outputs: record.outputs.map((output, index) => ({
        ...output,
        ...(record.provider === 'native'
          ? {
              originalUrl:
                '/media/generated/' +
                record.conversationId +
                '/' +
                record.id +
                '/' +
                index +
                '?key=' +
                mediaKey(record.conversationId + '/' + record.id + '/' + index, 'generated'),
              // Only once the page has sent one: until then the original is shown.
              ...(thumbnails.has(Thumbnails.key(record.conversationId, record.id, index))
                ? { thumbUrl: thumbUrl(record.conversationId, record.id, index) }
                : {}),
            }
          : {}),
      })),
    };
  }
  // `v`: the time it was written; one made again has another address, the browser keeping each for good.
  const thumbUrl = (conversationId, runId, index) =>
    `/media/thumbs/${conversationId}/${runId}/${index}?key=${mediaKey(conversationId + '/' + runId + '/' + index, 'thumb')}` +
    `&v=${thumbnails.version(Thumbnails.key(conversationId, runId, index)).toString(36)}`;
  /** The creation the cover of a conversation shows: its thumbnail when there is one, else the image itself. */
  const coverOf = conversationId =>
    history.preview(conversationId, async runId => {
      const key = Thumbnails.key(conversationId, runId, 0);
      if (thumbnails.has(key)) return { bytes: await thumbnails.read(key), mime: 'image/jpeg', thumbnail: true };
      const record = await gallery.get(conversationId, runId, { includeImages: false });
      if (record.provider !== 'native' || ['video', 'audio'].includes(record.mediaType)) return null;
      const { handle, mime } = await generatedMedia(outputDir, record.outputs[0].source);
      try {
        return { bytes: await handle.readFile(), mime };
      } finally {
        await handle.close();
      }
    });
  const status = () => ({
    ...chat.status(),
    toolJob: runtime.active ? runtime.status() : null,
    runner: generation.status(),
  });
  // The official builds of llama.cpp the application installs (Réglages, Composants).
  const llamaBuilds = givenLlamaBuilds ?? new LlamaBuilds({ root: join(dataDir, 'engines', 'llama.cpp') });
  let llamaInstalling = null;
  /**
   * The build of llama.cpp just installed becomes the one the chat model runs on: once nothing
   * uses the model, it is stopped, the setting changed and the model started again on the new
   * build. If the model does not start on it, the former build comes back.
   */
  async function useLlama(kept) {
    const job = llamaBuilds.job;
    Object.assign(job, { state: 'switching', step: 'Mise en service dès que le modèle est libre…' });
    const until = Date.now() + 15 * 60000;
    while (chat.busy || runtime.active || savingSettings || ['loading', 'stopping'].includes(engine.state)) {
      if (closing || Date.now() > until)
        throw Object.assign(job, { state: 'error', error: 'Le modèle est resté occupé : llama.cpp n’a pas été mis en service.' });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const former = config.enginePath,
      restart = engine.state === 'ready';
    if (restart) await engine.stop();
    const next = { ...config, enginePath: kept.enginePath };
    await atomicJson(configPath, next);
    config = next;
    if (restart) {
      job.step = `Chargement du modèle sur llama.cpp ${kept.tag}…`;
      // start() returns once the program is launched: the model itself is waited for, loaded or
      // failed (a build that cannot load it, an argument it does not know), before it is kept.
      let failure = '';
      try {
        await engine.start(config);
        const deadline = Date.now() + 330000;
        while (engine.state === 'loading' && !closing && Date.now() < deadline)
          await new Promise(resolve => setTimeout(resolve, 250));
        // Stopped meanwhile on purpose (the Studio took the card): nothing said against the build,
        // which stays and is tried at the next start. A failure is the engine's error, or a load
        // that never ends.
        if (engine.state === 'error' || engine.state === 'loading') {
          const said = engine.logs.findLast(line => /error|failed|unknown|invalid/i.test(line));
          failure = (engine.error || 'le modèle n’a pas fini de charger.') + (said ? ` (${said.slice(0, 300)})` : '');
        }
      } catch (error) {
        failure = error.message;
      }
      if (failure) {
        await engine.stop().catch(() => {});
        // Only the engine goes back: a setting saved meanwhile stays.
        const restored = { ...config, enginePath: former };
        await atomicJson(configPath, restored);
        config = restored;
        if (!closing) await engine.start(config).catch(() => {});
        Object.assign(job, {
          state: 'error',
          step: '',
          error: `llama.cpp ${kept.tag} (${kept.label}) ne démarre pas avec le modèle : ${failure} Le moteur d’avant est remis.`,
        });
        return;
      }
    }
    Object.assign(job, { state: 'done', step: '', used: true });
  }
  let url;
  let saving = false;

  const updateController = new AbortController();
  let updates = Promise.resolve({ available: false });
  let controlResponse = null,
    controlledOnce = false,
    controlTimer;
  /** The project a request names (its conversation's), Conversations when it names none. */
  const projectOf = value => {
    try {
      return projectId(value || 'inbox');
    } catch {
      return 'inbox';
    }
  };
  async function includeTools(payload, body, { prune = null } = {}) {
    // The references of the conversation's project; those it names stay in the list.
    const project = projectOf(body?.project),
      cited = citedNumbers(body?.messages),
      // The words of the small local model, or those of a large remote one (lib/model-wording.mjs).
      wording = wordingOf(chat.connection);
    // A large model gets its own consigne and the facts of the results (the page's history unchanged).
    if (wording === CAPABLE) payload.messages = capableMessages(payload.messages, { vision: chat.vision });
    // A message answered (not a count of the context): too many references for the model's
    // list, the least used are removed from the disk (copies, never the user's originals), and
    // `prune` is told which.
    if (prune) {
      const removed = await resources.prune(project, { cited }).catch(error => {
        console.error('Références :', error.message);
        return [];
      });
      if (removed.length) prune(removed);
    }
    const active = await resources.catalog(project);
    const context = resourceCatalogPrompt(active, { cited, wording });
    // (A capable model is given it below, with what it is told of the takes.)
    if (context && wording !== CAPABLE) {
      if (payload.messages[0]?.role === 'system')
        payload.messages[0] = { ...payload.messages[0], content: payload.messages[0].content + context };
      else payload.messages.unshift({ role: 'system', content: context });
    }
    const definitions = [];
    const toolConfig = generation.config;
    generation.syncCapabilities();
    // Tools only advertise sources this conversation really holds, so the model is never asked
    // for a run_id, attached image or resource that does not exist.
    const conversationId =
      typeof body.conversationId === 'string' &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(body.conversationId)
        ? body.conversationId
        : null;
    // Not saved yet, the conversation is in the project the page names (its takes are numbered there).
    if (conversationId) namedProjects.set(conversationId, project);
    const runs = conversationId ? (await gallery.list(conversationId, { includeImages: false })).runs : [];
    if (wording === CAPABLE) {
      // A capable model: at the end of the user's last message, after the consigne, the tools and
      // the history its provider keeps in cache. In the consigne, each project changed the start
      // of every request (0.6.44: nothing read again from the cache on going to another project).
      // After the references, the latest take of the conversation and the one on the user's screen
      // (`screen`, from the page): told nowhere, « la dernière prise » was read as the one before,
      // and a remark on a video just made was answered with an image (17/11).
      const told = context + takesContext(runs, body.messages, body.screen),
        last = (body.messages ?? []).findLastIndex(message => message?.role === 'user' && !message.internal),
        said = payload.messages[last];
      if (told && said)
        payload.messages[last] = {
          ...said,
          content:
            typeof said.content === 'string'
              ? said.content + told
              : [...said.content, { type: 'text', text: told.trimStart() }],
        };
    }
    // (0.6.100) The earlier creations the tools of the local model list: the latest, and those the last
    // exchange or the user's message name (lib/listed-takes.mjs), no longer every one made since the
    // conversation began. A large model is given no list: its tools are the same at every request.
    const listed = (takes = []) =>
      wording === CAPABLE ? { runs, takes } : listedSources({ runs, takes, messages: body.messages, screen: screenOf(body.screen) });
    if (
      toolConfig.enabled &&
      body.tools !== false &&
      (runtime.turns.get(body.turnId) || 0) < toolConfig.maxIterations
    ) {
      const shown = listed(await projectTakes(conversationId, project));
      definitions.push(
        ...(await runtime.tools.definitions({
          images: chatImageUrls(body.messages).length,
          resources: active.map(({ id, type }) => ({ id, type })),
          // The takes of the project by their number (« PRISE n »), this conversation's and the others'.
          takes: shown.takes.map(({ take, mediaType }) => ({ take, mediaType })),
          // Only native results can be passed to a workflow as an original file.
          outputs: shown.runs
            .filter(run => run.provider === 'native')
            .map(run => ({
              id: run.id,
              mediaType: run.mediaType || 'image',
              count: run.outputs.length,
              workflowId: run.workflowId,
              draft:
                run.mediaType === 'video' && run.parameters?.stage === 'draft' && Boolean(run.parameters?.replay_args),
            })),
        }, { wording })),
      );
    }
    // A capable model reads by number, with the same two definitions at every request of every
    // conversation (the cache of its provider); the server answers a number or a run_id that is none.
    if (wording === CAPABLE) {
      if (chat.vision && body.resources !== false && (resourceTurns.get(body.turnId) || 0) < 8)
        definitions.push(capableResourceTool, capableOutputTool);
    } else if (active.length && chat.vision && body.resources !== false && (resourceTurns.get(body.turnId) || 0) < 8) {
      const definition = structuredClone(resourceTool),
        ids = active.map(item => item.id);
      definition.function.parameters.properties.resource_id.enum = ids;
      definition.function.parameters.properties.resource_ids.items.enum = ids;
      definition.function.parameters.properties.resource_ids.maxItems = 8 - (resourceTurns.get(body.turnId) || 0);
      definitions.push(definition);
    }
    const outputDefinition = wording === CAPABLE ? null : outputToolFor(listed().runs);
    if (chat.vision && outputDefinition && body.resources !== false && (resourceTurns.get(body.turnId) || 0) < 8)
      definitions.push(outputDefinition);
    if (definitions.length) {
      payload.tools = definitions;
      payload.tool_choice = 'auto';
      payload.parallel_tool_calls = false;
    }
    return definitions;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    const send = (status, body) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    try {
      const expected = new URL(url);
      const allowedHosts = [expected.host, `localhost:${expected.port}`];
      if (!allowedHosts.includes(req.headers.host)) throw problem('Hôte refusé.', 403);
      if (req.headers.origin && ![url, `http://localhost:${expected.port}`].includes(req.headers.origin))
        throw problem('Origine refusée.', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw problem('Requête externe refusée.', 403);
      const requestURL = new URL(req.url, url),
        path = requestURL.pathname;
      // The tab of the page asking (0.6.86): the one that started a generation is there while it asks
      // (heard only once its key is checked, below: anything else could keep it there, 0.6.87).
      const tab = String(req.headers['x-moodix-tab'] || '').slice(0, 64);
      const previewMatch = path.match(/^\/media\/previews\/([0-9a-f-]{36})$/);
      if (previewMatch) {
        if (!['GET', 'HEAD'].includes(req.method)) throw problem('Méthode non prise en charge.', 405);
        const key = requestURL.searchParams.get('key') || '';
        if (
          !/^[0-9a-f]{64}$/.test(key) ||
          !timingSafeEqual(
            Buffer.from(key, 'hex'),
            Buffer.from(mediaKey(previewMatch[1], 'conversation-preview'), 'hex'),
          )
        )
          throw problem('Accès refusé.', 401);
        if (!preferences.saveHistory) throw problem('L’historique est désactivé.', 403);
        let cover;
        try {
          cover = await coverOf(previewMatch[1]);
        } catch (error) {
          if (!error.nothingToShow) throw error;
          // Nothing to show (a conversation whose creations are videos without a thumbnail
          // yet): an empty answer, which the page takes as « no cover », not an error.
          res.writeHead(204);
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': cover.mime, 'Content-Length': cover.bytes.length });
        return res.end(req.method === 'HEAD' ? undefined : cover.bytes);
      }
      const livePreview = path.match(/^\/media\/job-preview\/([0-9a-f-]{36})\/[0-9]{1,6}$/);
      if (livePreview) {
        if (req.method !== 'GET') throw problem('Méthode non prise en charge.', 405);
        const key = requestURL.searchParams.get('key') || '';
        if (
          !/^[0-9a-f]{64}$/.test(key) ||
          !timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(mediaKey(livePreview[1], 'job-preview'), 'hex'))
        )
          throw problem('Accès refusé.', 401);
        // Whatever number was asked, the picture so far: the job may have moved on, or ended.
        const picture = runtime.preview(livePreview[1]);
        if (!picture) {
          res.writeHead(204);
          return res.end();
        }
        res.writeHead(200, {
          'Content-Type': picture.mime,
          'Content-Length': picture.bytes.length,
          'Cache-Control': 'no-store',
        });
        return res.end(picture.bytes);
      }
      const thumb = path.match(/^\/media\/thumbs\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9]{1,3})$/);
      if (thumb) {
        if (!['GET', 'HEAD'].includes(req.method)) throw problem('Méthode non prise en charge.', 405);
        const key = requestURL.searchParams.get('key') || '';
        if (
          !/^[0-9a-f]{64}$/.test(key) ||
          !timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(mediaKey(thumb.slice(1).join('/'), 'thumb'), 'hex'))
        )
          throw problem('Accès refusé.', 401);
        const bytes = await thumbnails.read(Thumbnails.key(thumb[1], thumb[2], thumb[3]));
        // Written once and never changed: the browser keeps it.
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': bytes.length,
          'Cache-Control': 'private, max-age=31536000, immutable',
        });
        return res.end(req.method === 'HEAD' ? undefined : bytes);
      }
      const attached = path.match(/^\/media\/attachments\/([0-9a-f-]{36})\/([a-z0-9.-]{1,90})$/);
      if (attached) {
        if (!['GET', 'HEAD'].includes(req.method)) throw problem('Méthode non prise en charge.', 405);
        const key = requestURL.searchParams.get('key') || '';
        if (
          !/^[0-9a-f]{64}$/.test(key) ||
          !timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(mediaKey(attached[1] + '/' + attached[2], 'attachment'), 'hex'))
        )
          throw problem('Accès refusé.', 401);
        await sendResourceMedia(req, res, await history.attachment(attached[1], attached[2]));
        return;
      }
      const generated = path.match(/^\/media\/generated\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9]+)$/);
      if (generated) {
        if (!['GET', 'HEAD'].includes(req.method)) throw problem('Méthode non prise en charge.', 405);
        const key = requestURL.searchParams.get('key') || '',
          identity = generated.slice(1).join('/');
        if (
          !/^[0-9a-f]{64}$/.test(key) ||
          !timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(mediaKey(identity, 'generated'), 'hex'))
        )
          throw problem('Accès refusé.', 401);
        const record = await gallery.get(generated[1], generated[2], { includeImages: false }),
          source = record.outputs[Number(generated[3])]?.source;
        if (!source) throw problem('Sortie introuvable.', 404);
        if (record.provider !== 'native')
          throw problem('Original ComfyUI non disponible : seule la copie compressée est conservée.', 410);
        await sendResourceMedia(req, res, await generatedMedia(outputDir, source));
        return;
      }
      const media = path.match(/^\/media\/resources\/([0-9a-f-]{36})\/(original|preview)$/);
      if (media) {
        if (!['GET', 'HEAD'].includes(req.method)) throw problem('Méthode non prise en charge.', 405);
        const key = requestURL.searchParams.get('key') || '';
        if (
          !/^[0-9a-f]{64}$/.test(key) ||
          !timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(mediaKey(media[1], media[2]), 'hex'))
        )
          throw problem('Accès refusé.', 401);
        await sendResourceMedia(req, res, await resources.media(media[1], media[2]));
        return;
      }
      if (req.method === 'GET' && staticFiles.has(path)) {
        const asset = frontend.get(path),
          { file, mime } = asset;
        let contents = asset.contents;
        if (file === 'index.html')
          contents = contents.toString('utf8').replace('data-theme="dark"', `data-theme="${preferences.theme}"`);
        res.writeHead(200, { 'Content-Type': mime });
        return res.end(contents);
      }
      if (path === '/api/bootstrap' && req.method === 'GET') {
        // Who answers on this port, for the launcher and the update installer: said from memory
        // alone. The page's answer below reads the workflow catalog and checks its files, which
        // takes most of a second, and several at once while the model loads.
        if (requestURL.searchParams.get('brief') === '1')
          return send(200, {
            application: 'atelier-local',
            ...sources,
            controlled: !!controlResponse,
            token,
            status: status(),
            version: applicationVersion,
            updateNonce: process.env.ATELIER_UPDATE_NONCE || '',
            updating: applyingUpdate,
          });
        const native = await generation.snapshot();
        return send(200, {
          application: 'atelier-local',
          ...sources,
          controlled: !!controlResponse,
          token,
          config,
          instructions,
          models: await models.list(),
          modelName:
            (await models.list()).find(
              item => item.modelPath === config.modelPath && item.projectorPath === config.projectorPath,
            )?.name || modelFolderName(config.modelPath),
          preferences,
          status: status(),
          generation: native.config,
          runner: native.runner,
          workflows: native.workflows,
          platform: process.platform,
          warning: configWarning,
          version: applicationVersion,
          updateNonce: process.env.ATELIER_UPDATE_NONCE || '',
          updating: applyingUpdate,
        });
      }
      if (!path.startsWith('/api/')) throw problem('Page introuvable.', 404);
      if (req.headers.authorization !== `Bearer ${token}`) throw problem('Accès refusé. Rechargez la page.', 401);
      runtime.seen(tab);
      if (req.method === 'GET' && path === '/api/generation') return send(200, await generation.snapshot());
      if (req.method === 'GET' && path === '/api/generation/assets')
        return send(200, { assets: await generation.assets.list() });
      if (req.method === 'GET' && path === '/api/generation/workflows')
        return send(200, { workflows: await generation.catalog.list() });
      if (req.method === 'GET' && path.startsWith('/api/generation/workflows/'))
        return send(
          200,
          await generation.catalog.read(decodeURIComponent(path.slice('/api/generation/workflows/'.length))),
        );
      if (req.method === 'GET' && path === '/api/generation/templates') {
        const templates = Object.values(families()).map(manifest => familyTemplate(manifest));
        const name = requestURL.searchParams.get('pipeline');
        return send(200, name ? { template: templates.find(t => t.pipeline === name) } : { templates });
      }
      if (path === '/api/lifecycle' && req.method === 'GET') {
        if (closing || controlResponse) throw problem('Une fenêtre contrôle déjà cette application.', 409);
        controlResponse = res;
        controlledOnce = true;
        clearTimeout(controlTimer);
        req.socket.setTimeout(0);
        res.setTimeout(0);
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        });
        const heartbeat = () => {
          if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify({ state: 'running' }) + '\n');
        };
        heartbeat();
        const keepalive = setInterval(heartbeat, controlHeartbeatMs);
        keepalive.unref();
        res.once('close', () => {
          clearInterval(keepalive);
          if (controlResponse === res) controlResponse = null;
          if (!closing) {
            clearTimeout(controlTimer);
            controlTimer = setTimeout(() => {
              void stopApplication().catch(console.error);
            }, controlReconnectMs);
            controlTimer.unref();
          }
        });
        return;
      }
      if (path === '/api/updates/install' && req.method === 'GET') {
        if (!applyingUpdate && installState.state === 'idle') {
          try {
            return send(200, JSON.parse(await readFile(join(dataDir, 'update-status.json'), 'utf8')));
          } catch {}
        }
        return send(200, installState);
      }
      if (path === '/api/updates/session' && req.method === 'GET')
        return send(200, applyingUpdate ? null : sessionView(await readUpdateSession(dataDir)));
      if (path === '/api/updates' && req.method === 'GET') {
        // Asked again from the update button: a failed check (offline) never hides a known update.
        if (requestURL.searchParams.get('refresh') === '1' && updateChecker && !applyingUpdate) {
          const fresh = await updateChecker({ signal: updateController.signal }).catch(() => ({ available: false }));
          if (fresh.available || !(await updates).available) updates = Promise.resolve(fresh);
        }
        return send(200, await updates);
      }
      if (path === '/api/llama' && req.method === 'GET')
        return send(200, { ...llamaBuilds.status(), ours: llamaBuilds.owns(config.enginePath) });
      if (path === '/api/components' && req.method === 'GET') {
        // The Update tab asks once when it opens and again on its button: two at once share one answer.
        componentsCheck ||= (async () =>
          componentVersions({
            config,
            pythonPath: generation.config.pythonPath || '',
            runtimeDir: generation.environment.directory,
            ...(spawnProcess ? { run: (command, args, options) => runVersion(command, args, { ...options, spawnProcess }) } : {}),
          }))().finally(() => {
          componentsCheck = null;
        });
        return send(200, { version: applicationVersion, components: await componentsCheck });
      }
      if (path === '/api/downloads' && req.method === 'GET')
        return send(200, { job: generation.downloads.status(), hasToken: await generation.downloads.hasToken() });
      if (path === '/api/models' && req.method === 'GET')
        return send(200, { models: await models.list(), ...(await models.scan()) });
      if (path === '/api/remote' && req.method === 'GET') return send(200, await remoteView());
      // What the bar of the chat offers for the remote model in use (its models, their efforts); null for the local one.
      if (path === '/api/remote/options' && req.method === 'GET')
        return send(200, {
          options: await chat.options({
            again: requestURL.searchParams.get('again') === '1',
            // A service that never answers leaves the menu with what stopped it, not waiting.
            signal: AbortSignal.timeout(30000),
          }),
        });
      if (path === '/api/status' && req.method === 'GET') return send(200, status());
      if (req.method === 'GET' && path === '/api/resources')
        return send(200, { resources: (await resources.list()).map(resourceView) });
      // An attached image as the user gave it, stored before the message is sent.
      if (path === '/api/attachments' && req.method === 'POST') {
        if (applyingUpdate || closing || relaunching) throw problem('L’application est occupée.', 409);
        if (clearingHistory) throw problem('Suppression de l’historique en cours.', 409);
        const conversationId = String(req.headers['x-conversation-id'] || '');
        const stored = await history.addOriginal(conversationId, req);
        return send(201, { ...stored, view: attachmentUrl(conversationId, stored.file) });
      }
      if (path === '/api/gallery/thumbnail' && req.method === 'POST') {
        if (applyingUpdate || closing || relaunching) throw problem('L’application est occupée.', 409);
        if (clearingHistory) throw problem('Suppression de l’historique en cours.', 409);
        const conversationId = String(req.headers['x-conversation-id'] || '');
        const parts = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 400 * 1024) throw problem('Vignette trop lourde.', 413);
          parts.push(chunk);
        }
        let runId = String(req.headers['x-run-id'] || ''),
          index = Number(req.headers['x-output-index'] || 0);
        if (req.headers['x-preview'] === '1') {
          // The cover of a conversation: the server knows which creation it shows.
          const cover = await coverOf(conversationId);
          if (cover.kind !== 'generation' || cover.thumbnail) return send(200, {});
          runId = cover.runId;
          index = 0;
        }
        const record = await gallery.get(conversationId, runId, { includeImages: false });
        if (record.provider !== 'native' || !record.outputs[index]) throw problem('Sortie introuvable.', 404);
        // `X-Replace`: made again, the one kept being black (see public/thumbnails.mjs).
        await thumbnails.write(Thumbnails.key(conversationId, runId, index), Buffer.concat(parts), {
          replace: req.headers['x-replace'] === '1' && req.headers['x-preview'] !== '1',
        });
        return send(201, { thumbUrl: thumbUrl(conversationId, runId, index) });
      }
      const attachmentRead = req.method === 'GET' && path.match(/^\/api\/attachments\/([0-9a-f-]{36})\/([a-z0-9.-]{1,90})$/);
      if (attachmentRead) {
        await sendResourceMedia(req, res, await history.attachment(attachmentRead[1], attachmentRead[2]));
        return;
      }
      if (path === '/api/resources/upload' && req.method === 'POST') {
        if (applyingUpdate || closing || relaunching) throw problem('L’application est occupée.', 409);
        let name;
        try {
          name = decodeURIComponent(req.headers['x-resource-name'] || '');
        } catch {
          throw problem('Nom de fichier invalide.');
        }
        const resource = await resources.add(req, {
          name,
          mime: (req.headers['content-type'] || '').split(';')[0],
          length: req.headers['content-length'],
          // The project of the conversation (the Studio, a chat): its references are shared there.
          project: String(req.headers['x-resource-project'] || 'inbox'),
        });
        // The same file already kept in this project: that reference (`existing`), not a new one.
        return send(resource.existing ? 200 : 201, resourceView(resource));
      }
      if (req.method === 'GET' && path === '/api/tools/actions') return send(200, await runtime.tools.actions());
      // The Studio: where its results are kept, and the style LoRAs of the loras folders.
      if (req.method === 'GET' && path === '/api/studio') {
        // Asked together: the workflows and the LoRAs are both read from the disk.
        const [tools, styles, presets] = await Promise.all([
          runtime.tools.studio(),
          generation.styles(),
          studioPresets.all(),
        ]);
        // `legacyId`: the Studio of before, whose creations had no conversation, still listed apart.
        // `presets`: the settings saved for each model (« Enregistrer »).
        return send(200, { legacyId: STUDIO_ID, enabled: generation.config.enabled === true, tools, styles, presets });
      }
      if (req.method === 'GET' && path === '/api/tools/job') {
        // With what a page draws its card (`proposal`): one reloaded meanwhile follows it again (0.6.82).
        const job = runtime.status({ view: true });
        return send(
          200,
          job && {
            ...job,
            ...(job.record ? { record: galleryView(job.record) } : {}),
            // Its number is in the address: the page loads each new picture once.
            ...(job.preview
              ? { previewUrl: `/media/job-preview/${job.id}/${job.preview}?key=${mediaKey(job.id, 'job-preview')}` }
              : {}),
          },
        );
      }
      // The Sortie of the Studio: the creations of every conversation of a project, the newest
      // first, the open one too (even before it is saved). Without the history, the open one alone.
      if (req.method === 'GET' && path.startsWith('/api/project-gallery/')) {
        const project = projectId(decodeURIComponent(path.slice('/api/project-gallery/'.length))),
          open = requestURL.searchParams.get('conversation'),
          includeImages = requestURL.searchParams.get('images') !== '0',
          ids = new Set(open ? [open] : []);
        if (preferences.saveHistory)
          for (const item of (await history.list()).conversations)
            if ((item.projectId || 'inbox') === project) ids.add(item.id);
        const runs = [];
        for (const id of ids)
          try {
            runs.push(...(await gallery.list(id, { includeImages })).runs);
          } catch {
            // A conversation that cannot be read leaves the others.
          }
        runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        // The number of the take to come (« PRISE 32 » on the screen of the Studio while it is made).
        return send(200, { runs: runs.map(galleryView), nextTake: (await takes.last(project)) + 1 });
      }
      // The Bibliothèque: the creations of every conversation of every project, the newest first,
      // each with its project; the open one too (even before it is saved, `project` its own), those
      // of conversations never saved (`unsaved`, under Conversations: made in the Studio before any
      // message, or a chat closed before its first save), and those of the Studio of before, which
      // had no conversation (`legacy`). Without the history, the open one and those of before.
      // The numbers the takes of a conversation would take in another project (the window of the
      // pencil says them before the move).
      if (req.method === 'GET' && path === '/api/takes/preview') {
        const project = projectId(requestURL.searchParams.get('project') || 'inbox'),
          { runs } = await gallery.list(requestURL.searchParams.get('conversation') || '', { includeImages: false }),
          count = runs.reduce((sum, run) => sum + run.outputs.length, 0),
          first = (await takes.last(project)) + 1;
        return send(200, { count, first, last: first + count - 1 });
      }
      if (req.method === 'GET' && path === '/api/library') {
        const open = requestURL.searchParams.get('conversation'),
          includeImages = requestURL.searchParams.get('images') !== '0',
          places = new Map(open ? [[open, projectId(requestURL.searchParams.get('project') || 'inbox')]] : []),
          unsaved = new Set();
        if (preferences.saveHistory) {
          for (const item of (await history.list()).conversations) places.set(item.id, item.projectId || 'inbox');
          for (const id of await gallery.conversations())
            if (!places.has(id) && id !== STUDIO_ID) {
              places.set(id, 'inbox');
              unsaved.add(id);
            }
        }
        places.set(STUDIO_ID, 'inbox');
        const runs = [];
        for (const [id, project] of places)
          try {
            for (const run of (await gallery.list(id, { includeImages })).runs)
              runs.push({
                ...run,
                projectId: project,
                ...(id === STUDIO_ID ? { legacy: true } : {}),
                ...(unsaved.has(id) ? { unsaved: true } : {}),
              });
          } catch {
            // A conversation that cannot be read leaves the others.
          }
        runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return send(200, { runs: runs.map(galleryView) });
      }
      if (req.method === 'GET' && path.startsWith('/api/gallery/')) {
        const [, , , conversationId, runId, index] = path.split('/');
        if (!runId) {
          // `?images=0`: without the session copies kept for the model (the Studio shows the files).
          const result = await gallery.list(conversationId, {
            includeImages: requestURL.searchParams.get('images') !== '0',
          });
          result.runs = result.runs.map(galleryView);
          return send(200, result);
        }
        const record = await gallery.get(conversationId, runId, { includeImages: index === undefined });
        if (res.destroyed) return;
        if (index === undefined) return send(200, galleryView(record));
        if (!/^\d+$/.test(index) || !record.outputs[Number(index)]) throw problem('Image introuvable.', 404);
        if (record.provider !== 'native')
          throw problem('Original ComfyUI non disponible : seule la copie compressée est conservée.', 410);
        await sendResourceMedia(req, res, await generatedMedia(outputDir, record.outputs[Number(index)].source));
        return;
      }
      if (req.method === 'GET' && path === '/api/projects') return send(200, { projects: await projects.list() });
      // The bin of the history (0.6.103), Paramètres › Application: what waits there, 30 days at most.
      // (With the history off too: what it holds is on the disk.)
      if (req.method === 'GET' && path === '/api/history/trash')
        return send(200, { conversations: (await history.trash()).filter(item => item.saved), days: TRASH_DAYS });
      if (req.method === 'GET' && (path === '/api/history' || path.startsWith('/api/history/'))) {
        if (!preferences.saveHistory) throw problem('L’historique est désactivé.', 403);
        if (path === '/api/history') {
          const result = await history.list();
          return send(200, {
            ...result,
            conversations: result.conversations.map(historyView),
            // Unreadable, their version before taken back (0.6.103): told once.
            recovered: history.takeRecovered(),
          });
        }
        return send(200, historyView(await history.read(path.slice('/api/history/'.length))));
      }
      if (req.method !== 'POST') throw problem('Méthode non prise en charge.', 405);
      const body = await jsonBody(req, path === '/api/updates/install' ? 40 * 1024 * 1024 : maxBody);
      // The files of a shipped workflow: downloaded in the background, followed with GET /api/downloads.
      if (path === '/api/downloads/start') {
        if (closing || relaunching) throw problem('L’application est en cours de fermeture.', 409);
        const record = (await generation.catalog.list()).find(item => item.id === body.id);
        if (!record) throw problem('Workflow introuvable.', 404);
        // `accepted`: the licences with conditions of these files were shown, read and confirmed.
        return send(200, await generation.downloads.start(record, { accepted: body.accepted === true }));
      }
      if (path === '/api/downloads/cancel') {
        generation.downloads.cancel();
        return send(200, generation.downloads.status());
      }
      if (path === '/api/downloads/token') return send(200, { hasToken: await generation.downloads.setToken(body.token) });
      if (path.startsWith('/api/generation/')) {
        if (closing || relaunching) throw problem('L’application est en cours de fermeture.', 409);
        if (runtime.active || chat.busy || clearingHistory || savingSettings || savingGeneration || pickingFile)
          throw problem('Attendez la fin de l’opération en cours.', 409);
        savingGeneration = true;
        try {
          if (path === '/api/generation/config') {
            return send(200, await generation.save(body));
          }
          if (path === '/api/generation/test') {
            if (body.config || body.pythonPath !== undefined) await generation.save(body.config || body);
            void generation.start().catch(() => {});
            return send(200, await generation.snapshot());
          }
          if (path === '/api/generation/assets') {
            const { pipeline: familyAlias, ...asset } = body;
            return send(200, await generation.assets.register({ ...asset, family: body.family || familyAlias }));
          }
          if (path === '/api/generation/tokenizer')
            return send(200, await generation.suggestTokenizer(body.encoder, body.family));
          if (path === '/api/generation/validate') return send(200, { workflow: validateNativeWorkflow(body) });
          if (path === '/api/generation/import') {
            const importConfig = generationConfig({
              ...generation.config,
              ...Object.fromEntries(FOLDER_KEYS.map(key => [key, body[key] ?? generation.config[key]])),
            });
            const importFolders = generation.folders(importConfig);
            return send(
              200,
              await previewWorkflowImport(body.sourceText, {
                name: body.name,
                assets: generation.assets,
                modelRoot: importFolders.model,
                additionalRoots: Object.values(importFolders).filter(path => path !== importFolders.model),
              }),
            );
          }
          if (path === '/api/generation/import-comfy')
            return send(
              200,
              await importComfyWorkflow(body.sourceText, {
                assets: generation.assets,
                catalog: generation.catalog,
                modelRoot: body.modelRoot || generation.folders().model,
                additionalRoots: generation.searchFolders().filter(
                  path => path !== generation.folders().model,
                ),
                backupDir: join(dataDir, 'migration'),
              }),
            );
          if (path === '/api/generation/workflows') return send(200, await generation.catalog.save(body));
          if (path === '/api/generation/convert-krea')
            return send(
              200,
              await convertKreaWorkflow(body.sourcePath, {
                assets: generation.assets,
                catalog: generation.catalog,
                modelRoot: body.modelRoot || generation.folders().model,
                additionalRoots: generation.searchFolders().filter(
                  path => path !== generation.folders().model,
                ),
                backupDir: join(dataDir, 'migration'),
                name: body.name,
                description: body.description,
              }),
            );
          if (path === '/api/generation/convert-longforge')
            return send(
              200,
              await convertLongForge(body.sourcePath, {
                assets: generation.assets,
                catalog: generation.catalog,
                modelRoot: body.modelRoot || generation.folders().model,
                additionalRoots: generation.searchFolders().filter(
                  path => path !== generation.folders().model,
                ),
                backupDir: join(dataDir, 'migration'),
                name: body.name,
                description: body.description,
              }),
            );
          if (path === '/api/generation/remove') {
            // The workflows shipped with Atelier stay: an edited one can only be restored.
            if ((await generation.catalog.list()).find(item => item.id === body.id)?.builtin)
              throw problem('Les workflows fournis avec Atelier ne se suppriment pas.');
            await generation.catalog.remove(body.id);
            return send(200, { removed: true });
          }
          // (0.6.118) The version of a model the user picks in the page « Modèles ».
          if (path === '/api/generation/models/version') {
            await generation.useVersion(body.workflowId, body.path);
            return send(200, await generation.snapshot());
          }
          if (path === '/api/generation/reset') {
            await generation.catalog.reset(body.id);
            return send(200, await generation.snapshot());
          }
          if (path === '/api/generation/unhide') {
            await generation.catalog.unhide();
            return send(200, await generation.snapshot());
          }
          throw problem('Route de génération introuvable.', 404);
        } finally {
          savingGeneration = false;
        }
      }
      if (applyingUpdate) throw problem('Installation de la mise à jour en cours.', 409);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem('Un objet JSON est attendu.');
      // Nothing running that a relaunch would cut short.
      const occupied = () =>
        closing ||
        relaunching ||
        chat.busy ||
        runtime.active ||
        savingSettings ||
        saving ||
        savingGeneration ||
        pickingFile ||
        savingPreferences ||
        clearingHistory ||
        persistingGallery ||
        ['loading', 'stopping'].includes(engine.state);
      if (path === '/api/relaunch') {
        // Loads the files of this folder as they are now, without a hand on the launcher: the
        // launcher is started again in its own window, stops this instance (only if idle, see
        // /api/shutdown below) and starts the new one. For changes made from another program.
        // `always` (« Redémarrer » in the settings): even when nothing changed; the open
        // conversation, its draft and its images are kept for the page to take back, as after an
        // update (a session too large or too long is left: the conversation is in the history).
        if (occupied())
          throw problem('Termine l’opération en cours avant de relancer l’application.', 409);
        const always = body.always === true;
        if (!always && (await currentSources(root)).sourceRevision === sources.sourceRevision)
          throw problem('Les fichiers de ce dossier n’ont pas changé depuis le lancement : rien à recharger.', 409);
        if (always && body.session) {
          let snapshot = null;
          try {
            snapshot = updateSession(body.session);
          } catch {
            // Not kept: the page starts on the history.
          }
          if (snapshot) {
            await historySaves;
            await history.flush();
            await gallery.pending;
            // With those of the conversation set aside without the history (0.6.103).
            snapshot.gallery = [];
            for (const id of [snapshot.conversationId, snapshot.aside?.conversationId].filter(Boolean))
              snapshot.gallery.push(...(await gallery.list(id)).runs);
            snapshot = { ...compactSession(snapshot), restarted: true };
            if (Buffer.byteLength(JSON.stringify(snapshot)) <= 40 * 1024 * 1024)
              await atomicJson(join(dataDir, 'update-session.json'), snapshot);
          }
        }
        launcher({ root, port: server.address().port, restart: always });
        return send(202, { relaunching: true });
      }
      if (path === '/api/shutdown') {
        if (body.onlyIfIdle === true) {
          if (body.installationId !== sources.installationId || body.sourceRevision !== sources.sourceRevision)
            throw problem('L’instance à relancer a changé.', 409);
          if (occupied())
            throw problem(
              'Termine l’opération en cours, puis relance l’application pour charger les derniers fichiers.',
              409,
            );
          relaunching = true;
          try {
            await engine.stop();
          } catch (error) {
            relaunching = false;
            throw error;
          }
        }
        send(202, { stopping: true });
        setImmediate(() => {
          void stopApplication().catch(console.error);
        });
        return;
      }
      if (closing || relaunching) throw problem('L’application est en cours de fermeture.', 409);
      if (path === '/api/llama/check')
        // The newest release of llama.cpp and the builds it offers this computer (GitHub asked at
        // most once an hour, unless `again`).
        return send(200, await llamaBuilds.check({ again: body.again === true }));
      if (path === '/api/llama/install') {
        // Downloaded, checked, unpacked and tried in the background; the status says where it is.
        if (llamaInstalling) throw problem('Une installation de llama.cpp est déjà en cours.', 409);
        llamaInstalling = (async () => {
          try {
            // The build in use stays on disk whatever comes: it is the one to go back to.
            await useLlama(await llamaBuilds.install({ inUse: config.enginePath }));
          } catch {
            // Told by the status of the installation.
          } finally {
            llamaInstalling = null;
            componentsCheck = null;
          }
        })();
        return send(202, llamaBuilds.status());
      }
      // The chat models reached by an address (Paramètres › Moodix AI) and the accounts of the user.
      // Keys and tokens stay here: the page only learns whether one is kept.
      if (path.startsWith('/api/remote/')) {
        // ChatGPT, Claude or OpenRouter chosen for the chat (its account associated: a key for Claude).
        if (path === '/api/remote/provider') {
          if (runtime.active || savingSettings || saving) throw problem('Attendez la fin de l’opération en cours.', 409);
          await useProvider(body.provider, { key: body.key });
          return send(200, { ...(await remoteView()), status: status() });
        }
        // The account of a provider taken off this computer: its connection (and its key) go; the
        // chat comes back to the local model if it was the one in use.
        if (path === '/api/remote/forget') {
          if (!['claude', 'openrouter', 'chatgpt'].includes(body.provider)) throw problem('Fournisseur inconnu.');
          const kept = await remotes.provider(body.provider);
          if (kept && chat.connection?.id === kept.id && (chat.busy || runtime.active))
            throw problem('Attendez la fin de la réponse avant de retirer ce compte.', 409);
          // The connection first: if it cannot be removed, the account stays signed in (nothing half done).
          if (kept) {
            await remotes.remove(kept.id);
            chat.forget(kept.id);
          }
          const revoked = body.provider === 'chatgpt' ? await chatgpt.signOut() : {};
          return send(200, { ...revoked, ...(await remoteView()), status: status() });
        }
        // The model and the effort chosen in the bar of the chat, kept as the last choice.
        if (path === '/api/remote/choice') {
          if (runtime.active) throw problem('Attendez la fin de la génération.', 409);
          const options = await chat.choose({ model: body.model, effort: body.effort });
          return send(200, { options, status: status() });
        }
        // Anthropic's library, installed on demand the first time Claude is chosen.
        if (path === '/api/remote/claude/install') {
          void claude.install();
          return send(202, await remoteView());
        }
        if (path === '/api/remote/save') {
          const saved = await remotes.save(body);
          await chat.changed(saved.id);
          return send(200, { saved, ...(await remoteView()), status: status() });
        }
        if (path === '/api/remote/remove') {
          if (chat.connection?.id === body.id && (chat.busy || runtime.active))
            throw problem('Attendez la fin de la réponse avant de retirer ce modèle.', 409);
          await remotes.remove(body.id);
          chat.forget(body.id);
          return send(200, { ...(await remoteView()), status: status() });
        }
        if (path === '/api/remote/select') {
          if (runtime.active || savingSettings || saving) throw problem('Attendez la fin de l’opération en cours.', 409);
          await chat.use(body.id ?? null);
          return send(200, { ...(await remoteView()), status: status() });
        }
        if (path === '/api/remote/test' || path === '/api/remote/models') {
          // What the editor holds, saved or not; its kept key when none is written.
          const listing = path === '/api/remote/models',
            draft = connectionOf({ ...body, key: undefined, model: listing ? body.model || '-' : body.model }),
            kept = typeof body.id === 'string' ? await remotes.get(body.id).catch(() => null) : null,
            // A kept key goes only to the server it was given for: another address, no key.
            sameHost = kept && hostOf(kept.baseUrl) === hostOf(draft.baseUrl),
            connection = {
              ...draft,
              key: typeof body.key === 'string' && body.key ? apiKey(body.key) : sameHost ? kept.key : '',
            },
            signal = AbortSignal.timeout(30000);
          if (listing)
            return send(200, {
              models:
                connection.preset === 'chatgpt'
                  ? await chatgpt.models()
                  : (await listModels(connection, { signal })).map(id => ({ id, name: id })),
            });
          return send(200, await testConnection(connection, { chatgpt, signal }));
        }
        if (path === '/api/remote/chatgpt/start') return send(200, await chatgpt.signIn());
        if (path === '/api/remote/chatgpt/cancel') {
          chatgpt.cancelSignIn();
          return send(200, await remoteView());
        }
        if (path === '/api/remote/chatgpt/signout') {
          // Signed out: its connection goes too, and the chat comes back to the local model if it used it.
          const kept = await remotes.provider('chatgpt');
          if (kept && chat.connection?.id === kept.id && (chat.busy || runtime.active))
            throw problem('Attendez la fin de la réponse avant de vous déconnecter.', 409);
          // The connection first: if it cannot be removed, the account stays signed in (nothing half done).
          if (kept) {
            await remotes.remove(kept.id);
            chat.forget(kept.id);
          }
          const result = await chatgpt.signOut();
          return send(200, { ...result, ...(await remoteView()), status: status() });
        }
        // A key of the user's OpenRouter account, made without copying it: the connection is saved once back.
        if (path === '/api/remote/openrouter/start') return send(200, await openrouter.start());
        if (path === '/api/remote/openrouter/cancel') {
          openrouter.cancel();
          return send(200, await remoteView());
        }
        throw problem('Route introuvable.', 404);
      }
      if (path === '/api/models/add' || path === '/api/models/select' || path === '/api/models/remove') {
        if (
          savingSettings ||
          saving ||
          savingGeneration ||
          pickingFile ||
          runtime.active ||
          chat.busy ||
          clearingHistory ||
          ['loading', 'stopping'].includes(engine.state)
        )
          throw problem('Attendez la fin de l’opération en cours.', 409);
        savingSettings = true;
        saving = true;
        let finishModelOperation;
        modelOperation = new Promise(done => {
          finishModelOperation = done;
        });
        try {
          if (path === '/api/models/add') {
            const profile = await models.add(body);
            return send(200, { profile, models: await models.list() });
          }
          if (path === '/api/models/remove') {
            const candidate =
              (await models.list()).find(item => item.id === body.id) ||
              (await models.scan()).detected.find(item => item.id === body.id);
            const previous = config,
              active =
                candidate &&
                candidate.modelPath === config.modelPath &&
                candidate.projectorPath === (config.projectorPath || '');
            if (active) {
              await engine.stop();
              const next = { ...config, modelPath: '', projectorPath: '' };
              await atomicJson(configPath, next);
              config = next;
            }
            try {
              await models.remove(body.id);
            } catch (error) {
              if (active) {
                await atomicJson(configPath, previous);
                config = previous;
              }
              throw error;
            }
            if (active) configWarning = '';
            return send(200, {
              models: await models.list(),
              ...(await models.scan()),
              config,
              modelName:
                (await models.list()).find(
                  item => item.modelPath === config.modelPath && item.projectorPath === (config.projectorPath || ''),
                )?.name || modelFolderName(config.modelPath),
              status: status(),
            });
          }
          const selected = await models.get(body.id),
            next = { ...config, modelPath: selected.modelPath, projectorPath: selected.projectorPath };
          // A local LLM chosen: the chat leaves the remote model it used.
          await chat.use(null);
          if (next.modelPath === config.modelPath && next.projectorPath === config.projectorPath)
            return send(200, { config, modelName: selected.name, status: status() });
          const restart = engine.state === 'ready';
          await engine.stop();
          await atomicJson(configPath, next);
          config = next;
          configWarning = '';
          let warning = '';
          if (restart && !closing) {
            try {
              await engine.start(config);
            } catch (error) {
              warning = error.message;
            }
          }
          return send(200, { config, modelName: selected.name, status: status(), warning });
        } finally {
          savingSettings = false;
          saving = false;
          finishModelOperation();
        }
      }
      if (path === '/api/resources/update') {
        if ((runtime.active || chat.busy) && ((await resources.record(body.id)).ready || !body.patch?.prepared))
          throw problem('Attendez la fin de la réponse avant de modifier une ressource.', 409);
        return send(200, resourceView(await resources.update(body.id, body.patch)));
      }
      if (path === '/api/resources/delete') {
        if ((runtime.active || chat.busy) && (await resources.record(body.id)).ready)
          throw problem('Attendez la fin de la réponse avant de supprimer une ressource.', 409);
        await resources.remove(body.id);
        return send(200, { deleted: true });
      }
      if (path === '/api/resources/read') {
        // Read by the model: a use, counted (the least used leave its list first).
        if (body.ids !== undefined) {
          const ids = resourceReadIds({ resource_ids: body.ids });
          const read = await Promise.all(ids.map(id => resources.readActive(id)));
          void resources.used(ids).catch(() => {});
          return send(200, { resources: read });
        }
        const read = await resources.readActive(body.id);
        void resources.used([body.id]).catch(() => {});
        return send(200, read);
      }
      if (path === '/api/updates/session/clear') {
        await rm(join(dataDir, 'update-session.json'), { force: true });
        return send(200, { cleared: true });
      }
      if (path === '/api/updates/install') {
        const available = await updates;
        if (!available.available || !updateInstaller) throw problem('Aucune mise à jour installable.', 409);
        if (
          resources.busy ||
          runtime.active ||
          chat.busy ||
          saving ||
          savingSettings ||
          savingGeneration ||
          savingPreferences ||
          clearingHistory ||
          disablingHistory ||
          persistingGallery ||
          pickingFile ||
          ['loading', 'stopping'].includes(engine.state)
        )
          // Busy: the page asks again (installFromButton) instead of dropping the click.
          throw Object.assign(problem('Attendez la fin de l’opération en cours avant la mise à jour.', 409), {
            busy: true,
          });
        let snapshot;
        try {
          snapshot = updateSession(body.session);
        } catch (error) {
          throw problem(error.message);
        }
        applyingUpdate = true;
        installState = { state: 'preparing', error: '' };
        installTask = (async () => {
          try {
            await historySaves;
            await history.flush();
            await gallery.pending;
            // With those of the conversation set aside without the history (0.6.103).
            snapshot.gallery = [];
            for (const id of [snapshot.conversationId, snapshot.aside?.conversationId].filter(Boolean))
              snapshot.gallery.push(...(await gallery.list(id)).runs);
            snapshot = compactSession(snapshot);
            if (Buffer.byteLength(JSON.stringify(snapshot)) > 40 * 1024 * 1024)
              throw new Error('La session est trop volumineuse pour une reprise automatique.');
            await atomicJson(join(dataDir, 'update-session.json'), snapshot);
            const plan = await updateInstaller.prepare({
              version: available.version,
              port: server.address().port,
              signal: installController.signal,
            });
            installController.signal.throwIfAborted();
            installHandle = await updateInstaller.launch({ ...plan, managed: managed || controlledOnce });
            installController.signal.throwIfAborted();
            installState = { state: 'restarting', error: '' };
            await closeApplication();
            await installHandle.commit();
            installHandle = null;
          } catch (error) {
            installHandle?.abort();
            installHandle = null;
            applyingUpdate = false;
            installState = { state: 'error', error: error.message };
            if (!closing) await rm(join(dataDir, 'update-session.json'), { force: true }).catch(() => {});
          }
        })();
        return send(202, { state: 'preparing' });
      }
      if (path === '/api/files/choose') {
        if (
          !['engine', 'model', 'projector', 'generation', 'python', 'tokenizer', 'directory', 'workflow'].includes(body?.kind)
        )
          throw problem('Type de fichier invalide.');
        if (saving || savingSettings || savingGeneration || pickingFile)
          throw problem('Un choix de fichier ou un enregistrement est déjà en cours.', 409);
        if (
          runtime.active ||
          chat.busy ||
          (body.kind === 'engine' && engine.child) ||
          ['loading', 'stopping'].includes(engine.state)
        )
          throw problem('Arrêtez le modèle avant de choisir un fichier.', 409);
        pickingFile = true;
        const controller = new AbortController();
        const abort = () => controller.abort();
        res.once('close', abort);
        const initialPath =
          body.initialPath ||
          {
            model: join(modelsDir, 'LLMs'),
            projector: join(modelsDir, 'vision'),
            generation: generation.folders().model,
            directory: generation.folders().model,
            workflow: join(root, 'workflow'),
          }[body.kind] ||
          '';
        try {
          return send(200, { path: await filePicker(body.kind, { initialPath, signal: controller.signal }) });
        } finally {
          res.off('close', abort);
          pickingFile = false;
        }
      }
      if (path === '/api/settings') {
        if (
          pickingFile ||
          savingSettings ||
          savingGeneration ||
          saving ||
          runtime.active ||
          chat.busy ||
          clearingHistory
        )
          throw problem('Attendez la fin de l’opération en cours.', 409);
        const nextConfig = normalizeConfig(body.config),
          nextGeneration = generationConfig(body.generation),
          nextInstructions = globalContext(body.instructions === undefined ? instructions : body.instructions);
        const modelChanged = JSON.stringify(config) !== JSON.stringify(nextConfig);
        if (modelChanged && (engine.child || ['loading', 'stopping'].includes(engine.state)))
          throw problem('Arrêtez le modèle avant de modifier ses réglages.', 409);
        const edits = body.workflowDescriptions === undefined ? [] : body.workflowDescriptions;
        if (!Array.isArray(edits) || edits.length > 1000 || new Set(edits.map(edit => edit?.id)).size !== edits.length)
          throw problem('Descriptions de workflows invalides.');
        savingSettings = true;
        saving = true;
        try {
          const updates = [];
          for (const edit of edits) {
            if (typeof edit?.description !== 'string' || edit.description.length > 2000)
              throw problem('Description de workflow invalide.');
            updates.push(
              validateNativeWorkflow({
                ...(await generation.catalog.read(edit.id)),
                description: edit.description.trim(),
              }),
            );
          }
          if (modelChanged) {
            await atomicFile(configPath, JSON.stringify(nextConfig, null, 2));
            config = nextConfig;
            configWarning = '';
          }
          await generation.save(nextGeneration);
          for (const update of updates) await generation.catalog.save(update);
          if (nextInstructions !== instructions) {
            await atomicJson(instructionsPath, { instructions: nextInstructions });
            instructions = nextInstructions;
          }
          return send(200, {
            config,
            instructions,
            generation: generation.config,
            runner: generation.worker.status(),
            workflows: await generation.catalog.list(),
          });
        } finally {
          savingSettings = false;
          saving = false;
        }
      }
      if (path === '/api/tools/recover') return send(200, await runtime.recover());
      if (path === '/api/tools/cancel') {
        if (
          (!body.requestId && !body.jobId) ||
          [body.requestId, body.jobId].some(
            id =>
              id !== undefined && (typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)),
          )
        )
          throw problem('Identifiant de génération requis.');
        return send(200, runtime.cancel(body));
      }
      if (path === '/api/tools/revise') return send(200, await runtime.revise(body));
      // A creation that failed, proposed again with the same settings (« Relancer », 52).
      if (path === '/api/tools/again') {
        if (chat.busy) throw problem('Une réponse est en cours. Attendez sa fin.', 409);
        return send(200, await runtime.again(body));
      }
      // The next image of a series the model asked in one call (create_image with `series`).
      if (path === '/api/tools/series') {
        // The page says the series stopped before its last image (`end`): its prompts are let go,
        // and the answer comes once the chat model its images left out is back (endSeries).
        if (body?.end === true) return send(200, await runtime.endSeries(body));
        if (runtime.active) throw problem('Une génération est déjà en cours.', 409);
        return send(200, await runtime.next(body));
      }
      // Output buttons (Upscale, Interpoler): the same proposal a model call would make, without the model.
      if (path === '/api/tools/action') {
        if (clearingHistory || savingGeneration || savingSettings || pickingFile)
          throw problem('Une opération est en cours.', 409);
        if (chat.busy) throw problem('Une réponse est en cours. Attendez sa fin.', 409);
        // In a conversation the output buttons, and every creation of its Studio (`studio`); the
        // former Studio, which had no conversation, keeps its own identifier.
        const studio = body.studio === true || body.conversationId === STUDIO_ID;
        if (typeof body.conversationId === 'string' && body.project !== undefined)
          namedProjects.set(body.conversationId, projectOf(body.project));
        const allowed = studio ? STUDIO_VERBS : ['upscale', 'interpolate'];
        if (!allowed.includes(body.name)) throw problem('Action inconnue.');
        if (body.styles !== undefined && !studio) throw problem('Action invalide.');
        if (!body.arguments || typeof body.arguments !== 'object' || Array.isArray(body.arguments))
          throw problem('Action invalide.');
        const call = {
          id: 'action' + randomUUID().replaceAll('-', '').slice(0, 24),
          type: 'function',
          function: { name: body.name, arguments: JSON.stringify(body.arguments) },
        };
        return send(
          200,
          await runtime.request([call], {
            conversationId: body.conversationId,
            turnId: randomUUID(),
            messages: [],
            ...(body.styles !== undefined ? { styles: body.styles } : {}),
            // The user's own hand (0.6.94): a workflow not offered to Moodix AI stays theirs.
            byHand: true,
          }),
        );
      }
      // A Studio mode is opened: the chat model leaves the GPU before the first generation, whether
      // it is loaded or still loading. Never under an answer, a generation or a change of model, and
      // the image and video models kept between generations stay (unlike /api/stop).
      if (path === '/api/studio/release') {
        const released =
          ['ready', 'loading', 'stopping'].includes(engine.state) && !chat.busy && !runtime.active && !savingSettings;
        if (released) await engine.stop();
        return send(200, { released, status: status() });
      }
      // A creation leaves the Studio of its conversation (or the former Studio); its file stays in output.
      if (path === '/api/studio/delete') {
        if (runtime.active || clearingHistory || persistingGallery) throw problem('Une opération est en cours.', 409);
        await gallery.remove(body.conversationId ?? STUDIO_ID, body.id);
        // Its thumbnail goes with it (it would stay the cover of its conversation).
        await thumbnails.forget(body.conversationId ?? STUDIO_ID, body.id).catch(() => {});
        return send(200, { removed: body.id });
      }
      // « Enregistrer » of the Studio: the settings of a model as the Studio has them, kept apart
      // from its workflow (Configuration › Workflows is never touched), given back when it is chosen.
      if (req.method === 'POST' && path === '/api/studio/preset')
        return send(200, { workflow: body.workflow, preset: await studioPresets.save(body.workflow, body.preset) });
      // What the user typed in the Studio, rewritten by the chat model as a full prompt.
      if (path === '/api/studio/enrich') {
        // A character put in a video needs no word: its prompt is written from the two pictures.
        const fromPictures = body.verb === 'replace_character' && Boolean(body.source && body.reference);
        if (typeof body.prompt !== 'string' || (!body.prompt.trim() && !fromPictures))
          throw problem('Écrivez d’abord quelques mots à enrichir.');
        if (runtime.active) throw problem('La génération utilise le GPU.', 409);
        if (chat.state !== 'ready') throw problem('Le moteur n’est pas prêt. Configure-le puis démarre-le.', 503);
        if (chat.busy) throw problem('Une réponse est déjà en cours.', 409);
        const controller = new AbortController();
        chat.activeRequest = controller;
        chat.busy = true;
        const onClose = () => controller.abort();
        res.once('close', onClose);
        try {
          // A character put in a video: the prompt is written from the video and the image handed
          // over (lib/scene-prompt.mjs), what is typed kept as what the user asks for. Words alone
          // would invent a scene the video does not show.
          if (fromPictures) {
            const typed = String(body.prompt ?? '').trim().slice(0, 4000),
              given = { prompt: typed, source: body.source, reference: body.reference },
              // What is typed is what the user asks for, not a draft to tidy up. A draft comes
              // apart: the prompt of Moodix AI for a character it has just made.
              drafted = typeof body.draft === 'string' ? body.draft.trim().slice(0, 4000) : '',
              written = await withScenePrompt(given, {
                resources,
                engine: chat,
                thumbnails,
                outputFrames,
                conversationId: typeof body.conversationId === 'string' ? body.conversationId : null,
                asked: typed,
                draft: drafted,
                timeoutMs: enrichTimeoutMs,
              });
            if (written !== given) return send(200, { prompt: written.prompt, seen: true });
            throw problem(
              chat.vision
                ? 'Le prompt n’a pas pu être écrit d’après la vidéo et l’image. Réessayez.'
                : 'Ce modèle de chat ne voit pas les images : écrivez le prompt vous-même, en décrivant ce que la vidéo montre.',
              502,
            );
          }
          const upstream = await chat.request(
            {
              // The global instructions of the user say how he wants his prompts (length, language).
              messages: enrichMessages(body.prompt, { verb: body.verb, preferences: instructions }),
              stream: false,
              max_tokens: 700,
              temperature: 0.7,
              reasoning_format: 'deepseek',
              chat_template_kwargs: { enable_thinking: false },
            },
            { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(enrichTimeoutMs)]) },
          );
          if (!upstream.ok)
            throw problem(`Le moteur refuse la requête (${upstream.status}). ${(await upstream.text()).slice(0, 500)}`, 502);
          const prompt = enrichedPrompt((await upstream.json()).choices?.[0]?.message?.content);
          if (!prompt) throw problem('Le modèle n’a rien écrit. Réessayez.', 502);
          return send(200, { prompt });
        } catch (error) {
          // A model slowed down to a crawl (the graphics card shared with another program) is
          // said as such, not as an unexpected local error.
          if (error.name === 'TimeoutError')
            throw problem(
              chat.local
                ? `Le modèle n’a pas répondu en ${Math.round(enrichTimeoutMs / 1000)} secondes : la carte graphique est peut-être occupée par un autre programme. Réessayez une fois qu’elle est libre.`
                : `Le modèle distant n’a pas répondu en ${Math.round(enrichTimeoutMs / 1000)} secondes. Réessayez dans un moment.`,
              504,
            );
          throw error;
        } finally {
          res.off('close', onClose);
          if (chat.activeRequest === controller) {
            chat.activeRequest = null;
            chat.busy = false;
          }
        }
      }
      if (path === '/api/tools/execute') {
        if (clearingHistory || persistingGallery || savingGeneration || savingSettings || pickingFile)
          throw problem('Une opération est en cours.', 409);
        const job = await runtime.execute({ ...body, tab });
        return send(202, job?.record ? { ...job, record: galleryView(job.record) } : job);
      }
      // The tab that started the generation is closed or reloaded (pagehide): another may follow it now.
      if (path === '/api/tools/leave') {
        runtime.left(tab);
        return send(200, { left: true });
      }
      if (path === '/api/gallery/persist') {
        if (!preferences.saveHistory || disablingHistory) throw problem('L’historique est désactivé.', 403);
        if (runtime.active || clearingHistory || persistingGallery)
          throw problem('Attendez la fin de l’opération en cours.', 409);
        persistingGallery = true;
        galleryBatch = (async () => {
          const { runs } = await gallery.list(body.conversationId);
          for (const record of runs) await gallery.put(record, { persist: true });
          return { saved: runs.length };
        })();
        try {
          return send(200, await galleryBatch);
        } finally {
          persistingGallery = false;
        }
      }
      if (path === '/api/gallery/analysis' || path === '/api/gallery/review') {
        if ((runtime.active && !runtime.gpuBlocked) || clearingHistory || disablingHistory || persistingGallery)
          throw problem('Attendez la fin de l’opération en cours.', 409);
        persistingGallery = true;
        try {
          const record = await gallery.get(body.conversationId, body.id);
          if (path === '/api/gallery/review') {
            if (
              typeof body.text !== 'string' ||
              body.text.length > 200000 ||
              !['reviewed', 'correction_requested'].includes(body.status)
            )
              throw problem('Analyse de galerie invalide.');
            record.analysis = { text: body.text, status: body.status, checkedAt: new Date().toISOString() };
          } else {
            if (!Array.isArray(body.images) || body.images.length !== record.outputs.length)
              throw problem('Copies d’analyse invalides.');
            if (
              body.dimensions !== undefined &&
              (!Array.isArray(body.dimensions) ||
                body.dimensions.length !== record.outputs.length ||
                body.dimensions.some(
                  size =>
                    size !== null &&
                    (!size ||
                      ![size.width, size.height].every(
                        value => Number.isInteger(value) && value > 0 && value <= 131072,
                      )),
                ))
            )
              throw problem('Résolutions de sortie invalides.');
            if (
              body.frames !== undefined &&
              (!Array.isArray(body.frames) || body.frames.length !== record.outputs.length)
            )
              throw problem('Images vidéo invalides.');
            record.outputs = record.outputs.map((output, i) =>
              body.images[i] === null
                ? output
                : {
                    ...output,
                    analysisDataUrl: body.images[i],
                    ...(body.dimensions?.[i] || {}),
                    ...(body.frames?.[i] ? { analysisFrames: body.frames[i] } : {}),
                  },
            );
          }
          return send(200, await gallery.put(record, { persist: preferences.saveHistory }));
        } finally {
          persistingGallery = false;
        }
      }
      if (path === '/api/gallery/read')
        return send(
          200,
          await readOutput(gallery, body.conversationId, { run_id: body.runId, output_index: body.outputIndex }),
        );
      if (path === '/api/preferences') {
        if (
          !body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          !Object.keys(body).length ||
          Object.keys(body).some(key => !['theme', 'saveHistory', 'room'].includes(key))
        )
          throw problem('Préférences invalides.');
        if ('theme' in body && !['dark', 'light'].includes(body.theme)) throw problem('Choisissez le mode jour ou nuit.');
        if ('saveHistory' in body && typeof body.saveHistory !== 'boolean')
          throw problem('Choix d’historique invalide.');
        // Fond, éclairage, grain (Paramètres › Interface): what is valid of it, the rest by default.
        if ('room' in body) {
          if (!body.room || typeof body.room !== 'object' || Array.isArray(body.room)) throw problem('Réglages de l’interface invalides.');
          body.room = roomSettings(body.room);
        }
        if ((runtime.active || persistingGallery || clearingHistory) && 'saveHistory' in body)
          throw problem('Attendez la fin de la génération.', 409);
        if (savingPreferences) throw problem('Préférences en cours d’enregistrement.', 409);
        const next = { ...preferences, ...body };
        savingPreferences = true;
        disablingHistory = body.saveHistory === false;
        try {
          if (disablingHistory) {
            await historySaves;
            await history.flush();
          }
          await atomicFile(preferencesPath, JSON.stringify(next, null, 2));
          preferences = next;
        } finally {
          savingPreferences = false;
          disablingHistory = false;
        }
        return send(200, { preferences });
      }
      if (path === '/api/history/delete') {
        if (body?.confirm !== true) throw problem('Confirmez la suppression de la conversation.');
        if (
          persistingGallery ||
          runtime.active ||
          clearingHistory ||
          disablingHistory ||
          savingPreferences ||
          chat.busy ||
          ['loading', 'stopping'].includes(engine.state)
        )
          throw problem('Attendez la fin de l’opération en cours avant de supprimer la conversation.', 409);
        // Why it leaves (0.6.103): the bin of a line of the fil, or the page by itself (a creation of the
        // Studio that made nothing, `studio-empty`; the same found after a reload, `recovery-empty`).
        // Asked by the page, it goes only when the disk says there is nothing of its own in it: never a
        // message of the user, words of Moodix or a take (the page's memory decided alone before).
        const reason = AUTOMATIC_REASONS.has(body.reason) ? body.reason : 'user';
        clearingHistory = true;
        try {
          await historySaves;
          await gallery.pending;
          if (AUTOMATIC_REASONS.has(reason)) {
            const held = await history.contentOf(body.id),
              { runs, skipped } = await gallery.list(body.id, { includeImages: false });
            if (held.exists && (!held.readable || held.own || runs.length || skipped)) {
              await history.note('suppression refusée', {
                id: body.id,
                title: held.title ?? '',
                messages: held.messages ?? 0,
                takes: runs.length + skipped,
                reason,
                tab,
              });
              throw problem('Cette conversation a des messages ou des prises : elle reste dans l’historique.', 409);
            }
          }
          // To the bin (0.6.103), 30 days: its thumbnails stay with it, until it is erased.
          const removed = await history.remove(body.id, { reason, tab });
          gallery.forgetConversation(body.id);
          runtime.forgetConversation(body.id);
          return send(200, { deleted: body.id, trashed: removed.trashed === true });
        } finally {
          clearingHistory = false;
        }
      }
      // Paramètres › Application, the bin (0.6.103): a conversation given back, or erased for good now.
      if (path === '/api/history/restore') {
        if (clearingHistory || disablingHistory) throw problem('Attendez la fin de l’opération en cours.', 409);
        clearingHistory = true;
        try {
          await historySaves;
          const restored = await history.restore(body?.id, { tab });
          return send(200, { restored: body.id, conversation: restored && historyView(restored) });
        } finally {
          clearingHistory = false;
        }
      }
      if (path === '/api/history/erase') {
        if (body?.confirm !== true) throw problem('Confirmez l’effacement définitif de la conversation.');
        if (clearingHistory || disablingHistory) throw problem('Attendez la fin de l’opération en cours.', 409);
        clearingHistory = true;
        try {
          const erased = await history.erase(body.id, { tab });
          await thumbnails.forget(body.id);
          return send(200, { erased: erased.erased === true });
        } finally {
          clearingHistory = false;
        }
      }
      if (path === '/api/history/clear') {
        if (body?.confirm !== true) throw problem('Confirmez la suppression de l’historique.');
        if (
          persistingGallery ||
          runtime.active ||
          clearingHistory ||
          disablingHistory ||
          savingPreferences ||
          chat.busy ||
          ['loading', 'stopping'].includes(engine.state)
        )
          throw problem('Attendez la fin de l’opération en cours avant de supprimer l’historique.', 409);
        clearingHistory = true;
        try {
          await historySaves;
          await gallery.pending;
          // Every conversation to the bin, each for 30 days (0.6.103); their thumbnails go when they do.
          const trashed = await history.clear({ tab });
          runtime.clear();
          // The text conditioning kept for recent prompts is derived from them: it goes too.
          await rm(join(dataDir, 'generation-cache', 'conditioning'), { recursive: true, force: true });
          return send(200, { cleared: true, trashed: trashed ?? 0 });
        } finally {
          clearingHistory = false;
        }
      }
      if (path === '/api/projects/save') return send(200, { project: await projects.save(body) });
      if (path === '/api/projects/delete') {
        if (body?.confirm !== true) throw problem('Confirmez la suppression du projet.');
        projectId(body.id);
        if (body.id === 'inbox') throw problem('« Sans projet » ne peut pas être supprimé.');
        if (clearingHistory || disablingHistory || savingPreferences || runtime.active || chat.busy)
          throw problem('Attendez la fin de l’opération en cours.', 409);
        clearingHistory = true;
        try {
          await historySaves;
          await projects.require(body.id);
          // Nothing is erased: the project's conversations go back to Conversations. Their takes
          // take the numbers that follow in « Sans projet », in their order of creation: first, so
          // that a deletion stopped there is made whole when asked again.
          // (One whose file cannot be read stays as it is: listed in « Sans projet » all the same, 0.6.103.)
          const leaving = (await history.list()).conversations.filter(item => item.projectId === body.id && !item.unreadable);
          await renumber(
            leaving.map(item => item.id),
            'inbox',
          );
          const moved = [];
          for (const item of leaving) {
            const conversation = await history.read(item.id);
            // Moved, not changed: the pages that hold it go on saving on the revision they read (0.6.103).
            moved.push(historyView(await history.save({ ...conversation, projectId: 'inbox' }, { keepRevision: true, tab })));
          }
          // Its references follow its conversations.
          await resources.moveProject(body.id, 'inbox');
          await projects.remove(body.id);
          return send(200, { deleted: body.id, moved });
        } finally {
          clearingHistory = false;
        }
      }
      if (path === '/api/projects/move') {
        if (!preferences.saveHistory) throw problem('L’historique est désactivé.', 403);
        if (clearingHistory || disablingHistory || savingPreferences || runtime.active || chat.busy)
          throw problem('Attendez la fin de l’opération en cours.', 409);
        clearingHistory = true;
        try {
          await historySaves;
          await projects.require(body.projectId);
          const conversation = await history.read(body.id);
          // Its takes take the numbers that follow in the project it joins: first, so that a move
          // stopped there is still to be made (asked again, it is made whole; saved first, it was
          // « already there » and its takes kept numbers the project had given to others).
          if ((conversation.projectId || 'inbox') !== body.projectId) await renumber([body.id], body.projectId);
          // Moved, not changed: its revision stays (0.6.103), the page that shows it saves on.
          const moved = historyView(await history.save({ ...conversation, projectId: body.projectId }, { keepRevision: true, tab }));
          return send(200, { conversation: moved });
        } finally {
          clearingHistory = false;
        }
      }
      // The pencil of the fil (0.6.0): a name the user gives, kept by the saves that follow.
      if (path === '/api/history/rename') {
        if (!preferences.saveHistory) throw problem('L’historique est désactivé.', 403);
        if (clearingHistory || disablingHistory) throw problem('Attendez la fin de l’opération en cours.', 409);
        const renamed = historySaves.then(() => history.rename(body?.id, body?.title));
        historySaves = renamed.catch(() => {});
        return send(200, { conversation: historyView(await renamed) });
      }
      // The name of a conversation in four words at most, asked to the chat model once it has
      // answered (lib/conversation-title.mjs). `later`: the model is not free now (a reply, a
      // creation, a model loading), there is nothing to name it from yet, or its first answer was
      // no name: the page asks again at the end of a next turn. `named: false`: not to be asked again.
      if (path === '/api/history/title') {
        if (!preferences.saveHistory) throw problem('L’historique est désactivé.', 403);
        if (clearingHistory || disablingHistory || runtime.active || chat.state !== 'ready' || chat.busy)
          return send(200, { later: true });
        if (await history.named(body?.id)) return send(200, { named: true });
        // The local model is asked when it runs on the card (`localTitles`, measured there): on a
        // processor alone, a prompt read again would cost far more than a name is worth.
        const localNamed = localTitles === true || (localTitles === 'gpu' && config.gpuLayers !== 0);
        if (wordingOf(chat.connection) !== CAPABLE && !localNamed) return send(200, { named: false });
        // Named after the first of its messages that gives something to name it from, among the
        // first three (`contents`, as the page sends them; `content`: the first alone). A message
        // without words (pictures alone for a model that sees none, a creation of the Studio made
        // without a prompt) answered « nothing to name » for good, whatever was written next.
        const given = Array.isArray(body?.contents) ? body.contents.slice(0, 3) : [body?.content];
        let asked = null;
        for (const content of given) if ((asked = titleRequest(content, { vision: chat.vision }))) break;
        // Nothing yet: a next message may have words.
        if (!asked) return send(200, { later: true });
        // Asked twice already, for no name (an empty answer, a refusal, a failure of the service):
        // the name made of its first message stays, and the model is not asked a third time.
        const tries = titleTries.get(body?.id) || 0;
        if (tries >= 2) return send(200, { named: false });
        titleTries.delete(body?.id);
        titleTries.set(body?.id, tries + 1);
        if (titleTries.size > 256) titleTries.delete(titleTries.keys().next().value);
        let said = '';
        try {
          // Its own request, beside the conversation's: no tool, no reflection, a few words. A
          // remote service is told it is one (`brief`): a short answer at its lowest effort is all
          // it may cost (lib/chat-model.mjs), where the conversation's requests have no limit.
          const upstream = await chat.request(
            {
              messages: asked,
              stream: false,
              max_tokens: 40,
              temperature: 0.2,
              reasoning_format: 'deepseek',
              chat_template_kwargs: { enable_thinking: false },
            },
            { signal: AbortSignal.timeout(30000), brief: true },
          );
          if (upstream.ok) said = (await upstream.json()).choices?.[0]?.message?.content;
        } catch {
          // Unanswered (a remote service, a model stopped for a creation): asked again later, once.
        }
        const title = shortTitle(said);
        if (!title) return send(200, tries ? { named: false } : { later: true });
        // The application is closing (an update, « Quitter »): its history is already written.
        if (closing || relaunching) return send(200, { later: true });
        const renamed = historySaves.then(() => history.rename(body.id, title, { auto: true }));
        historySaves = renamed.catch(() => {});
        return send(200, { conversation: historyView(await renamed) });
      }
      if (path === '/api/history/save') {
        // The conversation whose take is being made waits for its end; any other is saved meanwhile
        // (0.6.86: every conversation was refused during a generation, any page being open then).
        if (runtime.writes(body.id)) throw problem('Attendez la fin de la génération.', 409);
        if (clearingHistory) throw problem('Suppression de l’historique en cours.', 409);
        if (!preferences.saveHistory) throw problem('L’historique est désactivé.', 403);
        if (disablingHistory) throw problem('Désactivation de l’historique en cours.', 409);
        const save = historySaves.then(async () => {
          if (body.projectId !== undefined) await projects.require(body.projectId);
          // `body.revision`: the one the page read; another written since is refused (409, `stale`, 0.6.103).
          return history.save(body, { tab });
        });
        historySaves = save.catch(() => {});
        return send(200, { conversation: historyView(await save) });
      }
      if (path === '/api/config') {
        if (
          pickingFile ||
          runtime.active ||
          saving ||
          engine.child ||
          engine.state === 'loading' ||
          engine.state === 'stopping'
        )
          throw problem('Arrêtez le moteur avant de modifier sa configuration.', 409);
        const next = normalizeConfig(body);
        saving = true;
        try {
          await atomicFile(configPath, JSON.stringify(next, null, 2));
          config = next;
          configWarning = '';
        } finally {
          saving = false;
        }
        return send(200, { config });
      }
      if (path === '/api/start') {
        if (runtime.active) throw problem('La génération utilise le GPU. Attendez sa fin.', 409);
        if (saving || savingGeneration || pickingFile)
          throw problem('Choix de fichier ou enregistrement en cours.', 409);
        // The chat model takes the card: what the Studio left loaded in the generator leaves first.
        // A remote one takes nothing of it.
        if (chat.local) await runtime.yieldGpu();
        await chat.start(config);
        return send(202, chat.status());
      }
      if (path === '/api/stop') {
        if (savingSettings) throw problem('Changement de modèle en cours.', 409);
        if (runtime.active) throw problem('Annule la génération avec le bouton d’interruption.', 409);
        await chat.stop();
        // Stopped by hand: the image and video models kept between generations leave RAM and VRAM too.
        await runtime.yieldGpu();
        await generation.unload().catch(error => console.error('Déchargement des modèles :', error.message));
        return send(200, status());
      }
      if (path === '/api/context') {
        const payload = chatPayload(
          !chat.local && !chat.seesImages(config) ? withoutImages(body) : body,
          chat.seesImages(config),
          config.maxOutputTokens,
          true,
        );
        const limits = chat.limits(config);
        if (chat.state !== 'ready' || chat.busy || runtime.active)
          return send(200, { ...limits, used: null, precision: 'unavailable' });
        const controller = new AbortController();
        const abort = () => controller.abort();
        res.once('close', abort);
        try {
          await includeTools(payload, body);
          // A remote service has no route to count: the length of what is sent, then its own usage.
          const result = chat.local
            ? await countContext({
                base: engine.base,
                apiKey: engine.apiKey,
                payload,
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
              })
            : estimateContext(payload);
          return send(200, { ...limits, ...result });
        } catch {
          if (!res.destroyed) return send(200, { ...limits, used: null, precision: 'unavailable' });
        } finally {
          res.off('close', abort);
        }
        return;
      }
      if (path !== '/api/chat') throw problem('Route introuvable.', 404);
      if (savingSettings || savingGeneration || pickingFile)
        throw problem('Enregistrement des réglages en cours.', 409);
      if (runtime.active) throw problem('La génération utilise le GPU.', 409);
      if (clearingHistory) throw problem('Suppression de l’historique en cours.', 409);
      if (chat.state !== 'ready') throw problem('Le moteur n’est pas prêt. Configure-le puis démarre-le.', 503);
      if (chat.busy) throw problem('Une réponse est déjà en cours.', 409);
      // A remote model that does not see images: those of the conversation said in words.
      const payload = chatPayload(!chat.local && !chat.vision ? withoutImages(body) : body, chat.vision, config.maxOutputTokens);
      const controller = new AbortController();
      chat.activeRequest = controller;
      chat.busy = true;
      const onClose = () => controller.abort();
      res.once('close', onClose);
      let streamHeartbeat;
      try {
        const definitions = await includeTools(payload, body, {
          // Said to the page before the answer (its first bytes), which tells the user.
          prune: removed =>
            res.setHeader(
              'X-References-Removed',
              encodeURIComponent(JSON.stringify(removed.map(({ label, name }) => ({ label, name })))),
            ),
        });
        // The model that answers, here or remote (lib/chat-model.mjs): a remote refusal is thrown in
        // the user's words; the local engine's is said below.
        const upstream = await chat.request(payload, { signal: controller.signal });
        if (!upstream.ok) {
          const detail = (await upstream.text()).slice(0, 3000);
          throw problem(`Le moteur refuse la requête (${upstream.status}). ${detail}`, 502);
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
        streamHeartbeat = setInterval(() => {
          if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n');
        }, chatHeartbeatMs);
        streamHeartbeat.unref();
        const calls = [];
        let terminalReason = '';
        const emit = async event => {
          if (res.destroyed) return;
          if (!res.write(`data: ${JSON.stringify(event)}\n\n`))
            await new Promise(done => {
              const finish = () => {
                res.off('drain', finish);
                res.off('close', finish);
                done();
              };
              res.once('drain', finish);
              res.once('close', finish);
            });
        };
        // (0.6.111) An answer llama.cpp could not read again once written (lib/tool-runtime.mjs,
        // unreadAnswer): its words were shown as they came, « Failed to parse input at pos 693 »,
        // and the turn was lost. The call it had read before that is made, as below.
        let unread = null;
        try {
          await readSSE(upstream.body, async event => {
            collectToolCalls(calls, event.choices?.[0]?.delta || {});
            if (event.choices?.[0]?.finish_reason) terminalReason = event.choices[0].finish_reason;
            await emit(event);
          });
        } catch (error) {
          if (!unreadAnswer(error)) throw error;
          unread = error;
        }
        if (unread) {
          if (!firstWholeCall(calls)) {
            console.error('Réponse du modèle que le moteur n’a pas su lire :', unread.message.slice(0, 600));
            throw problem('Le moteur n’a pas su lire la réponse du modèle. Renvoyez votre message.', 502);
          }
          terminalReason = 'tool_calls';
        }
        if (calls.length) {
          if (terminalReason !== 'tool_calls')
            throw problem('L’appel d’outil du modèle est incomplet ou tronqué. Aucune génération lancée.', 502);
          // One tool a message (the request says so; a model may ask for several all the same): the
          // first is made, and the model asks for the others once it has its result. Refused whole,
          // « Le moteur a demandé un outil indisponible. » said nothing of what had happened.
          if (calls.length > 1 && firstWholeCall(calls)) calls.length = 1;
          if (calls.length !== 1 || !definitions.some(item => item.function.name === calls[0].function?.name))
            throw problem('Le moteur a demandé un outil indisponible.', 502);
          // Arguments the model got wrong are answered as a tool error so it can correct the call
          // or reply without a tool; operational failures (busy GPU, closing app, unexpected
          // errors) still end the turn.
          const rejectCall = async (call, error) => {
            if (!error.status || error.status === 409 || error.status === 503) throw error;
            await emit({ local_tool_request: { kind: 'invalid', call, message: error.message } });
          };
          if (calls[0].function.name === 'local_read_output') {
            const call = nativeFields({ role: 'assistant', tool_calls: calls }).tool_calls[0];
            let args;
            try {
              args = JSON.parse(call.function.arguments);
            } catch {
              throw problem('Paramètres de sortie invalides.', 502);
            }
            if (!body.turnId || !/^[0-9a-f-]{36}$/.test(body.turnId) || (resourceTurns.get(body.turnId) || 0) >= 8)
              throw problem('La limite de huit lectures pour ce tour est atteinte.', 502);
            // (0.6.112) Takes named by their numbers (lib/output-tools.mjs): one is read as a result
            // always was; several are read by the page together, and shown to the model on one
            // picture (`outputs`). One read of the turn either way.
            let metadata,
              several = null;
            try {
              if (args?.takes !== undefined) {
                const named = takesToRead(args, (await gallery.list(body.conversationId, { includeImages: false })).runs);
                if (named.length > 1) several = named;
                else args = { run_id: named[0].runId, output_index: named[0].outputIndex };
              }
              if (!several) ({ metadata } = await readOutput(gallery, body.conversationId, args, { includeImages: false }));
            } catch (error) {
              await rejectCall(call, error);
            }
            if (metadata || several) {
              resourceTurns.set(body.turnId, (resourceTurns.get(body.turnId) || 0) + 1);
              if (resourceTurns.size > 256) resourceTurns.delete(resourceTurns.keys().next().value);
              await emit({
                local_tool_request: several
                  ? {
                      kind: 'outputs',
                      call,
                      takes: several.map(({ take, runId, outputIndex }) => ({ take, runId, outputIndex })),
                      workflowName: several.map(item => 'PRISE ' + item.take).join(', '),
                    }
                  : {
                      kind: 'output',
                      call,
                      runId: metadata.run_id,
                      outputIndex: metadata.output_index,
                      workflowName: metadata.workflow,
                    },
              });
            }
          } else if (calls[0].function.name === 'local_read_resource') {
            // References named by their number (a capable model, « refs »): their ids in the project.
            let refError = null;
            try {
              calls[0].function.arguments = refsToIds(calls[0].function.arguments, await resources.catalog(projectOf(body.project)));
            } catch (error) {
              refError = error;
            }
            const call = nativeFields({ role: 'assistant', tool_calls: calls }).tool_calls[0];
            let args;
            try {
              args = JSON.parse(call.function.arguments);
            } catch {
              throw problem('Paramètres de ressource invalides.', 502);
            }
            // A number that is none: said to the model, which can read another or answer.
            if (refError) {
              await rejectCall(call, refError);
              res.write('data: [DONE]\n\n');
              return res.end();
            }
            const ids = resourceReadIds(args);
            if (
              !body.turnId ||
              !/^[0-9a-f-]{36}$/.test(body.turnId) ||
              (resourceTurns.get(body.turnId) || 0) + ids.length > 8
            )
              throw problem('La limite de huit lectures pour ce tour est atteinte.', 502);
            const selected = await Promise.all(ids.map(id => resources.activeRecord(id)));
            resourceTurns.set(body.turnId, (resourceTurns.get(body.turnId) || 0) + ids.length);
            if (resourceTurns.size > 256) resourceTurns.delete(resourceTurns.keys().next().value);
            await emit({
              local_tool_request: {
                kind: 'resource',
                call,
                resourceId: selected[0].id,
                resourceIds: ids,
                workflowName: selected.map(item => item.label + ' · ' + item.name).join(', '),
              },
            });
          } else {
            // « Anime la prise 12 » : a take named by its number is found in the project, before anything.
            let takeError = null;
            try {
              calls[0].function.arguments = await withTakes(calls[0].function.arguments, body.conversationId, projectOf(body.project));
              // « Anime #ref2 » : a reference named by its number (a capable model), its id in the project.
              calls[0].function.arguments = refsToIds(calls[0].function.arguments, await resources.catalog(projectOf(body.project)));
            } catch (error) {
              takeError = error;
            }
            const call = nativeFields({ role: 'assistant', tool_calls: calls }).tool_calls[0];
            let request;
            // Images passed to the generator and never looked at: the model sees them first.
            const unseen =
              chat.vision && body.resources !== false && /^[0-9a-f-]{36}$/.test(body.turnId || '')
                ? unseenResources(body.messages, await resources.catalog(projectOf(body.project)), call)
                : [];
            // (0.6.100) The other prompts of a series are looked at for a large model only: the local
            // one, sent back for them, wrote them in its answer and made no call (lib/thin-prompt.mjs).
            const thin = fullPrompts ? thinNote(body.messages, call, { series: wordingOf(chat.connection) === CAPABLE }) : '';
            if (unseen.length && (resourceTurns.get(body.turnId) || 0) + unseen.length <= 8) {
              resourceTurns.set(body.turnId, (resourceTurns.get(body.turnId) || 0) + unseen.length);
              if (resourceTurns.size > 256) resourceTurns.delete(resourceTurns.keys().next().value);
              // The model makes its call again once it has seen them: a video not talked over yet
              // is then proposed with its words (below).
              await emit({
                local_tool_request: {
                  kind: 'resource',
                  call,
                  resourceId: unseen[0].id,
                  resourceIds: unseen.map(item => item.id),
                  workflowName: unseen.map(item => item.label + ' · ' + item.name).join(', '),
                  note: SEEN_NOTE,
                },
              });
            }
            // A prompt of two lines: sent back once, with the images it is about shown again. For a
            // series, each of its prompts: the answer names those to write again (thinNote).
            else if (thin) {
              const images =
                chat.vision && body.resources !== false
                  ? passedImages(await resources.catalog(projectOf(body.project)), call)
                  : [];
              const room = /^[0-9a-f-]{36}$/.test(body.turnId || '') && (resourceTurns.get(body.turnId) || 0) + images.length <= 8;
              if (images.length && room) {
                resourceTurns.set(body.turnId, (resourceTurns.get(body.turnId) || 0) + images.length);
                if (resourceTurns.size > 256) resourceTurns.delete(resourceTurns.keys().next().value);
                await emit({
                  local_tool_request: {
                    kind: 'resource',
                    call,
                    resourceId: images[0].id,
                    resourceIds: images.map(item => item.id),
                    workflowName: images.map(item => item.label + ' · ' + item.name).join(', '),
                    note: thin,
                  },
                });
              } else await emit({ local_tool_request: { kind: 'retry', call, message: thin } });
            } else
              try {
                if (takeError) throw takeError;
                // An image the user named by its label and the model left out: said once.
                const active = await resources.catalog(projectOf(body.project)),
                  unused = citedUnused(body.messages, active, call);
                if (unused.length) throw problem(citedMessage(unused, null, { byNumber: wordingOf(chat.connection) === CAPABLE }), 400);
                // A character put in a video: its prompt is written here from the frames of the
                // video and the character, which the model no longer has under its eyes.
                const replacing = call.function.name === 'replace_character';
                let given = null,
                  skipped = '';
                if (replacing)
                  try {
                    given = JSON.parse(calls[0].function.arguments);
                  } catch {
                    given = null;
                  }
                // A change asked for a replacement already made (the same video, no character): its
                // character stays, the image the user kept (lib/scene-prompt.mjs, lastReplacement).
                const again =
                  replacing && given && given.reference == null && !String(given.character ?? '').trim()
                    ? lastReplacement(body.messages, given.source)
                    : null;
                if (again) {
                  given = { ...given, source: again.source, reference: again.reference };
                  calls[0].function.arguments = JSON.stringify(given);
                }
                const described =
                  replacing && given && given.reference == null
                    ? String(given.character || '').trim() || characterOf(given.prompt)
                    : '';
                const places = {
                  resources,
                  engine: chat,
                  asked: askedSince(body.messages),
                  messages: body.messages,
                  thumbnails,
                  outputFrames,
                  conversationId: body.conversationId,
                  onSkip: why => (skipped = why),
                };
                if (replacing && given && given.reference == null) {
                  // No image of the character: the page makes it, the user keeps it or has another
                  // made, then the replacement runs with it. Its prompt is written in the Studio
                  // once the image is kept, from the video and that image (the chat model comes
                  // back for it): written here from words, the person of the video lent the
                  // character their clothes (a headscarf and a tote bag on a volleyball player).
                  if (described.length < 3 || !given.source || typeof given.source !== 'object')
                    throw problem(
                      'Donne la vidéo à suivre (source) et le personnage : son image (reference), ou sa description (character).',
                      400,
                    );
                  const { character, ...rest } = given;
                  // Its workflow lacks a file (53): said first, before an image is made for it.
                  const lacking = await runtime.lackingFile(calls, {
                    conversationId: body.conversationId,
                    turnId: body.turnId,
                    messages: body.messages,
                  });
                  if (lacking) request = lacking;
                  else await emit({
                    local_tool_request: {
                      kind: 'character',
                      call,
                      character: described.slice(0, 600),
                      imagePrompt: characterPrompt(described),
                      sourceSize: await sourceSize(given.source, body.conversationId),
                      replace: { ...rest, prompt: String(rest.prompt || described).trim() },
                      // What the user asked, for the prompt written once the image is kept.
                      asked: places.asked,
                    },
                  });
                } else {
                  let seen = false;
                  if (replacing && given)
                    try {
                      const { character, ...rest } = given,
                        written = await withScenePrompt(rest, places);
                      seen = written !== rest;
                      calls[0].function.arguments = JSON.stringify(written);
                    } catch {
                      // The call keeps the prompt it came with.
                    }
                  const made = await runtime.request(calls, {
                    conversationId: body.conversationId,
                    turnId: body.turnId,
                    messages: body.messages,
                    // The images the user names: one the proposal leaves out is said on it.
                    cited: citedImages(body.messages, active),
                    // Asked in the Chat: with the LoRAs saved for the model. In the Studio those it
                    // shows go with « Générer » (`inStudio`, said by the page).
                    saved: body.inStudio !== true,
                  });
                  // Left out though the workflow that serves has a place for it, and the model not
                  // told yet (a continuation is not asked before its routing: the workflow that
                  // continues the clip decides whether an image can go with it): told once.
                  if (made?.cited?.roles?.length && !citedSaid(body.messages)) {
                    runtime.cancel({ requestId: made.requestId });
                    throw problem(citedMessage(made.cited.left, made.cited.roles, { byNumber: wordingOf(chat.connection) === CAPABLE }), 400);
                  }
                  request = made;
                  // A video the user has not had under their eyes yet (lib/video-brief.mjs): proposed
                  // with what Moodix is to say of it (`brief`), and it waits for the user. Its words come
                  // over the card of the proposal in the Chat (`cardBrief`), before the Studio is set
                  // in the Studio (`studioBrief`). The page knows where it is.
                  // (0.6.114) By the call the conversation keeps (`request.call`): a continuation
                  // nobody asked for is kept as the new video it was made (lib/unasked-suite.mjs),
                  // and the model's own call never matched it once the user had answered.
                  const capable = wordingOf(chat.connection) === CAPABLE;
                  if (request && !request.missing && briefMissing(body.messages, request.call ?? call, { talked: !capable })) {
                    request.brief = true;
                    request.cardBrief = capable ? CAPABLE_CARD : cardBrief();
                    request.studioBrief = capable ? CAPABLE_STUDIO : studioBrief();
                  }
                  // Said where the user confirms: what the prompt was written from.
                  if (replacing && request)
                    request.notes = [
                      ...(request.notes ?? []),
                      seen
                        ? 'Prompt écrit par l’application d’après la vidéo et l’image du personnage.'
                        : `Prompt de Moodix AI gardé (${skipped || 'raison inconnue'}) : relisez-le, il doit décrire ce que la vidéo montre.`,
                    ];
                }
              } catch (error) {
                await rejectCall(call, error);
              }
            if (request) await emit({ local_tool_request: request });
          }
        }
        res.write('data: [DONE]\n\n');
        res.end();
      } finally {
        clearInterval(streamHeartbeat);
        res.off('close', onClose);
        if (chat.activeRequest === controller) {
          chat.activeRequest = null;
          chat.busy = false;
        }
      }
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) {
        res.end(`data: ${JSON.stringify({ error: error.message })}\n\ndata: [DONE]\n\n`);
        return;
      }
      send(error.status || 500, {
        error: error.status ? error.message : 'Erreur locale inattendue. Consulte le terminal de l’application.',
        ...(error.busy ? { busy: true } : {}),
        // A save on a copy older than the disk's (0.6.103): the page reads the conversation again.
        ...(error.stale ? { stale: true } : {}),
      });
      if (!error.status && error.name !== 'AbortError') console.error(error);
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  await new Promise((yes, no) => {
    server.once('error', no);
    server.listen(port, '127.0.0.1', yes);
  });
  url = `http://127.0.0.1:${server.address().port}`;
  // A replacement process reads requirements only after all updated sources have been installed.
  void generation.prepareOnLaunch().catch(() => {});
  if (updateChecker)
    updates = Promise.resolve()
      .then(() => updateChecker({ signal: updateController.signal }))
      .catch(() => ({ available: false }));
  // Launched as the application (not as a test server): the registered LLM starts by itself.
  if (managed && chat.state === 'stopped' && (!chat.local || (config.enginePath && config.modelPath)))
    void chat.start(config).catch(error => console.error('Démarrage automatique du modèle :', error.message));
  let closing,
    relaunching = false;
  if (managed) {
    controlTimer = setTimeout(() => {
      void stopApplication().catch(console.error);
    }, controlTimeoutMs);
    controlTimer.unref();
  }
  function closeApplication() {
    return (closing ||= (async () => {
      clearTimeout(controlTimer);
      const serverClosed = new Promise(done => server.close(done));
      updateController.abort();
      await updates;
      await resources.close();
      await modelOperation;
      await models.pending;
      await runtime.close();
      await generation.close();
      chatgpt.close?.();
      openrouter.close();
      await chat.stop();
      await engine.stop();
      await projects.pending;
      await historySaves;
      await history.flush();
      await galleryBatch.catch(() => {});
      await gallery.pending;
      if (controlResponse && !controlResponse.destroyed)
        controlResponse.end(JSON.stringify({ state: applyingUpdate ? 'restarting' : 'stopped' }) + '\n');
      server.closeAllConnections();
      await serverClosed;
    })());
  }
  async function stopApplication() {
    installController.abort();
    llamaBuilds.cancel();
    await installTask;
    await llamaInstalling;
    return closeApplication();
  }
  return { url, close: stopApplication };
}

/**
 * Starts the launcher of this folder again, as a double click on it would: in a console window
 * of its own on Windows, in the background elsewhere. It finds the running instance, stops it
 * and starts the new one; if it cannot, the running instance simply stays. `restart`: the
 * instance is replaced even when the files of the folder have not changed.
 */
export function startLauncher({ root, port, restart = false }, { platform = process.platform, spawnProcess = spawn } = {}) {
  const script = [
    process.execPath,
    join(root, 'scripts', 'launch.mjs'),
    `--port=${port}`,
    '--wait-idle',
    ...(restart ? ['--restart'] : []),
  ];
  const [command, ...args] =
    platform === 'win32' ? ['cmd.exe', '/c', 'start', 'Atelier local', '/D', root, ...script] : script;
  const child = spawnProcess(command, args, { cwd: root, stdio: 'ignore', detached: true, windowsHide: true });
  child.once('error', () => {});
  child.unref();
}
export function openBrowser(url, { platform = process.platform, spawnProcess = spawn, report = console.log } = {}) {
  const command = platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawnProcess(command, args, { stdio: 'ignore', detached: true, windowsHide: true, shell: false });
  let reported = false;
  const fallback = () => {
    if (!reported) {
      reported = true;
      report(`Ouvrez cette adresse dans votre navigateur : ${url}`);
    }
  };
  child.once('error', fallback);
  child.once('exit', code => {
    if (code !== 0) fallback();
  });
  child.unref();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    console.error('Atelier local nécessite Node.js 22 ou ultérieur.');
    process.exitCode = 1;
  } else {
    let port = 8787;
    try {
      const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      const portArg = process.argv.find(arg => arg.startsWith('--port=') || arg.startsWith('--update-port='));
      port = portArg ? Number(portArg.split('=')[1]) : 8787;
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port invalide.');
      const app = await createApplication({
        port,
        managed: process.env.ATELIER_MANAGED_LAUNCH === '1',
        updateChecker: ({ signal }) => checkForUpdates({ currentVersion: version, signal }),
        updateInstaller: {
          prepare: args => prepareUpdate({ ...args, root, currentVersion: version }),
          launch: launchInstaller,
        },
      });
      console.log(`\nAtelier local — ${app.url}\nLes conversations restent sur cet ordinateur. Ctrl+C pour arrêter.\n`);
      let closing = false;
      const close = async () => {
        if (closing) return;
        closing = true;
        await app.close();
        process.exitCode = 0;
      };
      process.on('SIGINT', close);
      process.on('SIGTERM', close);
      process.on('SIGHUP', close);
      if (process.argv.includes('--open')) openBrowser(app.url);
    } catch (error) {
      console.error(
        error.code === 'EADDRINUSE'
          ? `Le port ${port} est déjà utilisé. Relance l’application avec son lanceur pour retrouver l’instance existante.`
          : error.message,
      );
      process.exitCode = 1;
    }
  }
}
