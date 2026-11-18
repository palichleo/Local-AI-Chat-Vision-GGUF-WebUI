import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { problem } from './engine.mjs';
import { MAX_CALL_ARGUMENTS, nativeFields } from './native-messages.mjs';
import {
  editableParameters,
  nativeWorkflowReferences,
  nativeWorkflowImageInputs,
  unreadParameters,
} from './native-workflows.mjs';
import { family } from './families.mjs';
import { ToolCatalog, STILL_FRAMES, apartInputs, imageRoles, openRoles, verbSlots } from './tool-catalog.mjs';
import { STILLS } from './video-still.mjs';
import { ProgressClock, milestone, timingKey } from './generation-progress.mjs';
import { imageSize } from './image-size.mjs';
import { STUDIO_ID } from './studio.mjs';
import { explainFailure } from './generation-failure.mjs';
import { citedNote } from './cited-resources.mjs';
import { creationName } from './output-names.mjs';
import { FORMATS } from '../public/formats.mjs';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
// An earlier result of another conversation of the project (the Sortie of the Studio is the
// project's): found in its own conversation, else in the one of the call.
const placeOf = (source, conversationId) =>
  uuid.test(source?.conversation ?? '') ? source.conversation : conversationId;
/**
 * A reference kept with a result, as a source of a call: the result, its output, its conversation.
 * `place` is the conversation of the record that keeps the reference, when a chain of results is
 * walked: a reference that names no conversation is in that one (it was made there), not in the
 * one of the call (`conversationId`). A clip upscaled in its own conversation, then continued from
 * another one of the project, was looked for in the wrong place.
 */
const asSource = (ref, place, conversationId) => {
  const conversation = ref.output_conversation ?? place;
  return {
    output: ref.output_id,
    ...(ref.output_index ? { index: ref.output_index } : {}),
    ...(conversation && conversation !== conversationId ? { conversation } : {}),
  };
};
const APPROVAL_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING = 32;
// Several images asked in one call (`series` of create_image): at most this many after the first;
// the others wait here until they are made, for as long as a Studio may leave them waiting.
const SERIES_MAX = 19;
const SERIES_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SERIES = 16;
// How long the chat model stays out of the card after an image of a series when the next one does
// not start: the page that was making the series is gone (closed, reloaded), the model comes back.
const SERIES_IDLE_MS = 60_000;
const RELEASE_TIMEOUT_MS = 90_000;
// A tab that started a generation and has said nothing for this long is gone (status: ownerAway).
const OWNER_AWAY_MS = 75_000;
// How long the generator keeps its models on the card after a creation of the Studio, when no
// other follows: long enough to try a few prompts in a row, not the whole evening.
const KEEP_MS = 5 * 60_000;
const RESTART_TIMEOUT_MS = 300_000;
// Verbs that return their source in another format (larger, smoother) rather than new footage.
const TRANSFORMS = new Set(['upscale', 'interpolate']);
// Verbs made from a prompt and images: one the user named and a proposal leaves out is said on it.
const CITING = new Set(['create_image', 'create_video', 'extend_video', 'replace_character']);
// Verbs the user may choose to confirm every time (Configuration › confirmReplacements).
const CONFIRMED = { replace_character: 'confirmReplacements' };
/**
 * Whether a proposal runs without the user's click: an image or a video as the settings say;
 * a character replaced in a video like the other videos (when Moodix AI made its image, the user
 * has checked it already), unless the user asked to confirm each replacement. A sound never.
 */
export function runsByItself(config, media, verb) {
  if (media === 'image') return config.autoAllow;
  if (media !== 'video' || config.autoAllowVideos !== true) return false;
  return !(CONFIRMED[verb] && config[CONFIRMED[verb]] === true);
}
const transforms = pipeline => {
  try {
    return family(pipeline).tasks.every(task => TRANSFORMS.has(task));
  } catch {
    return false;
  }
};
const fpsText = value => String(Math.round(value * 100) / 100).replace('.', ',');
/** A reason put after « … : » in a sentence: no capital on a plain word, no final point. */
const reasonText = value => {
  const text = String(value || '')
    .trim()
    .replace(/[.\s]+$/, '');
  if (!text) return 'raison inconnue';
  return /^\p{Lu}\p{Ll}*[’' ]/u.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
};

/**
 * Images the user attached in the visible conversation, in the order {"image": n} refers to them.
 * Shared by tool advertisement and reference resolution so both count the same images.
 */
export function chatImageUrls(messages) {
  return chatImageParts(messages).map(part => part.image_url?.url);
}

/** The same images as message parts: `file` names the stored attachment as the user gave it. */
export function chatImageParts(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(message => message?.role === 'user' && !message.internal)
    .flatMap(message =>
      Array.isArray(message.content) ? message.content.filter(part => part?.type === 'image_url') : [],
    );
}

const ORIGINAL_ATTACHMENT = /^original-[0-9a-f]{64}\.(png|jpg|webp)$/;

/** Accumulates streamed OpenAI-style tool-call deltas into complete calls. */
export function collectToolCalls(calls, delta) {
  for (const part of delta.tool_calls || []) {
    if (!Number.isInteger(part.index) || part.index < 0 || part.index > 7)
      throw problem('Appel d’outil invalide.', 502);
    const call = (calls[part.index] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
    if (part.id) call.id = part.id;
    if (part.function?.name) call.function.name += part.function.name;
    if (part.function?.arguments) call.function.arguments += part.function.arguments;
    // (Room for the largest series the tool allows: lib/native-messages.mjs.)
    if (call.function.arguments.length > MAX_CALL_ARGUMENTS) throw problem('Paramètres d’outil trop longs.', 502);
  }
}

/**
 * The other prompts of several images asked in one call (`series` of create_image), checked; null
 * for a single image. The first image is the call itself, with its `prompt`.
 */
function seriesOf(name, args) {
  if (args.series === undefined) return null;
  if (name !== 'create_image') throw problem('Une série se demande seulement pour des images (create_image).');
  const list = args.series;
  if (!Array.isArray(list) || !list.length || list.length > SERIES_MAX)
    throw problem(`series : une liste de 1 à ${SERIES_MAX} prompts, un par image après la première.`);
  if (list.some(item => typeof item !== 'string' || !item.trim() || item.length > 3000))
    throw problem('series : chaque prompt est un texte non vide de 3 000 caractères au plus.');
  return list.map(item => item.trim());
}

function parseArguments(call) {
  let args;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    throw problem('Le modèle a produit des paramètres d’outil invalides.', 502);
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw problem('Paramètres d’outil invalides.', 502);
  return args;
}

// What the worker is doing, in the user's words: a long stage is not a frozen bar.
const STAGE_LABELS = {
  'loading video prompt encoder': 'Chargement de l’encodeur de texte…',
  'encoding video prompt': 'Lecture du prompt…',
  'video prompt encoded': 'Chargement du modèle vidéo…',
  'encoding references': 'Préparation des images de référence…',
  'encoding source audio': 'Préparation du son de la vidéo source…',
  'finding subjects': 'Repérage des personnages dans la vidéo…',
  'subjects found': 'Préparation des images de référence…',
  'references encoded': 'Chargement du modèle vidéo…',
  'retrying with a smaller share of the model': 'Mémoire vidéo insuffisante : nouvel essai, plus lent…',
  'decoding video again without the model': 'Décodage de la vidéo, avec toute la carte…',
  'loading video model': 'Chargement du modèle vidéo…',
  'sampling video': 'Chargement du modèle vidéo…',
  'upscaling video latents': 'Agrandissement de la première passe…',
  'refining video': 'Affinage en pleine taille…',
  'video sampled': 'Décodage de la vidéo…',
  'decoding video': 'Décodage de la vidéo…',
  'video decoded': 'Décodage du son…',
  'decoding audio': 'Décodage du son…',
  'audio decoded': 'Enregistrement de la vidéo…',
  'sending to ComfyUI': 'Envoi à ComfyUI…',
  'loading text encoder': 'Chargement de l’encodeur de texte…',
  'encoding prompt': 'Lecture du prompt…',
  'preparing transformer': 'Chargement du modèle…',
  'decoding image': 'Décodage de l’image…',
  decoded: 'Enregistrement de l’image…',
  'loading music model': 'Chargement du modèle de musique…',
  'generating music': 'Composition…',
  'loading sound model': 'Chargement du modèle de bruitages…',
  'encoding sound prompt': 'Lecture du prompt…',
  'generating sound': 'Génération du son…',
  'decoding sound': 'Décodage du son…',
  'saving audio': 'Enregistrement du son…',
  'retrying without the video memory ceiling': 'Mémoire vidéo insuffisante : nouvel essai, plus lent…',
  'decoding video again without the video memory ceiling': 'Décodage de la vidéo, avec toute la carte…',
};
function progressLabel(value, media) {
  if (typeof value === 'string') return value;
  if (value.step) return `Génération · ${value.step}/${value.total}`;
  return (
    STAGE_LABELS[value.stage] ||
    { video: 'Génération de la vidéo…', audio: 'Génération du son…' }[media] ||
    'Génération de l’image…'
  );
}

// « court » is also the verb (« un chien qui court ») and « le long de » a place: neither speaks of
// a length, and both are everyday words of a video request.
const LENGTH_HINT =
  /\d|\b(?:sec(?:onde)?s?|seconds?|min(?:ute)?s?|dur[ée]e|longueur|(?<!\b(?:le|au|du) )long(?:ue)?s?|courtes?|courts|(?:plus|tr[èe]s|trop|assez|moins|aussi|si|clip|film|plan|extrait|format) court|court[- ]m[ée]trage|bref|br[èe]ve|length|duration|short|longer|shorter|brief)\b/i;
// What holds a number and says nothing of a length, taken out before a number is looked for: the
// label of a reference (« #ref3 », « ref 3 », « référence n°3 »), the number of a take (« prise 12 »,
// « les prises 3 et 4 »), a format (« 9:16 »), a size (« 1152 × 2048 », « 4K », « 1080p ») and a
// factor (« x2 »). References and takes are named by their number in most requests: left in, the
// guard below never applied to them (« anime #ref1 » kept the ten seconds the model made up).
const NOT_A_LENGTH = [
  /#?\br[ée]f(?:[ée]rence)?s?\s*(?:n°|#)?\s*\d{1,4}\b(?:\s*(?:et|and|&)\s*\d{1,4}\b)*/gi,
  /\b(?:prise|take)s?\s*(?:n°|#)?\s*\d{1,7}\b(?:\s*(?:et|and|&)\s*\d{1,7}\b)*/gi,
  new RegExp(`\\b(?:${FORMATS.map(format => format.id.replace(':', '\\s*[:/]\\s*')).join('|')})\\b`, 'g'),
  /\b\d{2,5}\s*[x×*]\s*\d{2,5}\b/gi,
  /\b\d{1,2}\s?k\b/gi,
  /\b\d{3,4}\s?p\b/gi,
  /(?<![\p{L}\d])[x×]\s?\d{1,2}\b|\b\d{1,2}\s?[x×](?![\p{L}\d])/giu,
  // The name of a model and its version (« sur LTX 2.5 », « avec MiniMax H3 », « Krea 2 »): asked
  // for by name, a model kept the length the assistant had made up.
  /\b(?:ltx|minimax|krea|moss|scail|wan|qwen|flux|seedvr|esrgan)(?:[\s-]*(?:h|v)?\d+(?:[.,]\d+)?)?\b/gi,
  /\bh\d\b/gi,
];
const withoutNames = text => NOT_A_LENGTH.reduce((rest, pattern) => rest.replace(pattern, ' '), text);
/**
 * Whether the model made up the length of a clip: the user wrote in this conversation, and
 * nothing they wrote speaks of a length (no number other than those above, no word about time
 * or length). A model asked for "the length the user asked for, or null" still tends to answer
 * with a number.
 */
export function inventedLength(messages) {
  // A length the model proposed in a message and the user answered is agreed on, not made up.
  const wrote = (messages || []).filter(
    message =>
      (message?.role === 'user' && !message.internal) || (message?.role === 'assistant' && !message.tool_calls?.length),
  );
  const said = wrote.map(message =>
    typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map(part => (typeof part?.text === 'string' ? part.text : '')).join(' ')
        : '',
  );
  return wrote.some(message => message.role === 'user') && !said.some(text => LENGTH_HINT.test(withoutNames(text)));
}

/**
 * Whether a workflow takes the LoRAs the user adds: the families of ComfyUI, and those of Atelier's
 * engine whose manifest says so (what the Studio is told as `styled`). Elsewhere the engine leaves
 * them out: they are not kept with the proposal, and the take never says it was made with them.
 */
export function takesStyles(workflow) {
  const manifest = family(workflow?.pipeline) ?? {};
  return manifest.engine === 'external' || manifest.styles === true;
}

/** A LoRA as it is named to the user: its file without its folder nor « .safetensors », its strength. */
const styleText = style =>
  `${String(style.name).split(/[\\/]/).pop().replace(/\.safetensors$/i, '')} · ${String(style.strength ?? 1).replace('.', ',')}`;
/** What a proposal says of the LoRAs it took from the settings saved for its model. */
export const savedStylesNote = (workflow, styles) =>
  `LoRA enregistré${styles.length > 1 ? 's' : ''} pour ${workflow} : ${styles.map(styleText).join(', ')}.`;
/** A LoRA by its file alone, without its folder nor « .safetensors ». */
const styleName = style =>
  String(style?.name ?? style)
    .split(/[\\/]/)
    .pop()
    .replace(/\.safetensors$/i, '');
/** What a proposal says of the LoRAs saved for its model whose file is no longer in its folder: left out. */
export const missingStylesNote = styles =>
  `LoRA enregistré${styles.length > 1 ? 's' : ''} introuvable${styles.length > 1 ? 's' : ''} dans le dossier loras : ${styles.map(styleName).join(', ')}.`;

/** The style LoRAs of a Studio request, checked: at most four, a listed name and a strength each. */
export function checkStyles(styles) {
  if (!Array.isArray(styles) || styles.length > 3) throw problem('Styles invalides : trois LoRA au plus.');
  return styles.map(style => {
    const strength = style?.strength ?? 1;
    if (
      typeof style?.name !== 'string' ||
      !style.name ||
      style.name.length > 300 ||
      /[\x00-\x1f\x7f]/.test(style.name) ||
      typeof strength !== 'number' ||
      !Number.isFinite(strength) ||
      strength < -4 ||
      strength > 4
    )
      throw problem('Style invalide : un LoRA de la liste et une force entre -4 et 4.');
    return { name: style.name, strength };
  });
}

/**
 * Turns one LLM tool call into an approved, executed generation:
 * request() validates and resolves it, execute() checks the approval, run() hands the GPU
 * over from the chat model to the generation worker and back.
 */
/**
 * The verb whose rule the inputs of a proposal follow (ToolCatalog: verbSlots). A video is a new
 * one or a continuation by what it holds, not by the name it was asked under: a draft that
 * continues a clip, promoted through create_video, still continues it.
 */
const ruleVerb = (name, references) =>
  ['create_video', 'extend_video'].includes(name)
    ? references.some(ref => ref.role === 'source_video')
      ? 'extend_video'
      : 'create_video'
    : name;
/**
 * The roles an input of `role` could take in this workflow for this verb, by the name each has in
 * the family: the slots of the same media the verb can fill, a source video excepted (a
 * continuation keeps its source). A continuation takes subject references where its family
 * combines them with its source, never a first or last frame.
 */
function movableRoles(workflow, verb, role) {
  const roles = family(workflow.pipeline).roles ?? {},
    media = roles[role]?.media;
  if (!media || role === 'source_video') return [];
  return [
    ...new Set(
      verbSlots(workflow, verb)
        .map(slot => slot.role)
        .filter(other => other !== 'source_video' && roles[other]?.media === media),
    ),
  ];
}
/**
 * The roles the input `index` of a proposal may take instead of its own (its own included): those
 * of movableRoles, less the ones the family does not combine with the other inputs (MiniMax: a
 * reference does not become the first frame while another reference stays). The rule route()
 * applies to what the model passes. One entry means no choice.
 */
function referenceRoles(workflow, verb, references, index) {
  const roles = family(workflow.pipeline).roles ?? {},
    own = references[index]?.role,
    others = references.filter((_, at) => at !== index).map(ref => ref.input);
  return movableRoles(workflow, verb, own)
    .filter(role => {
      const slot = workflow.references.find(item => item.role === role);
      return role === own || !apartInputs(workflow, [...others, slot.id]).length;
    })
    .map(role => ({ role, label: roles[role].label || role }));
}
/**
 * The image that gives a video its format, among the inputs of a proposal (#frameSize): the one it
 * starts from, else the one it ends on, as what tells it from another image; '' when there is none.
 */
// The inputs that give a creation its format, in their order: the first or last frame of a video,
// the image an image is made from (changed, it keeps its shape: a portrait fitted into the square of
// the profile lost its sides or its head).
const FRAME_ROLES = { video: ['start_image', 'end_image'], image: ['img2img', 'source_image'] };
function frameOf(references) {
  const frame = [...FRAME_ROLES.video, ...FRAME_ROLES.image]
    .map(role => references.find(ref => ref.role === role))
    .find(Boolean);
  return frame
    ? JSON.stringify(
        ['output_id', 'output_index', 'output_conversation', 'resource_id', 'frame', 'image'].map(
          key => frame[key] ?? null,
        ),
      )
    : '';
}
// The name of an input after « ne prend pas » : « d’image de fin », « de référence de sujet ».
const none = label => (/^[aeiouyàâéèêîôû]/i.test(label) ? 'd’' : 'de ') + label.toLowerCase();
/** The inputs a family does not combine (apartInputs), in the user's words: « image de référence et image de début ». */
function apartText(workflow, groups) {
  const roles = family(workflow.pipeline).roles ?? {},
    names = [...new Set(groups.flat().map(slot => (roles[slot.role]?.label || slot.role).toLowerCase()))];
  return names.length > 1 ? names.slice(0, -1).join(', ') + ' et ' + names.at(-1) : names[0];
}

export class ToolRuntime {
  constructor({
    engine,
    catalog,
    gallery,
    resources,
    getConfig,
    engineConfig,
    saveConfig = async () => {},
    persist = () => false,
    clientFactory,
    sourceMedia,
    previewOf = null,
    timing = null,
    keepMs = KEEP_MS,
    seriesIdleMs = SERIES_IDLE_MS,
    // The download a shipped workflow lacks (model-downloads offers): its files, sizes, what is left.
    offerOf = async () => null,
    // Writes into each file of a creation what made it (lib/media-info.mjs), once it is recorded.
    stamp = null,
    // The first or last picture of a video file, `(path, 'first' | 'last')` → { bytes, preview,
    // width, height } (lib/video-still.mjs); it is kept as a reference of the project (#stills).
    extractStill = null,
    // The project of a conversation: where such a reference is kept.
    projectOf = async () => 'inbox',
    // The LoRAs the user saved for a model (« Enregistrer » in the Studio), those still in their
    // folder: `workflowId` → [{ name, strength }]. A creation asked in the Chat is made with them.
    // With those whose file is gone, said on the proposal: { kept: [...], missing: [...] }.
    savedStyles = async () => [],
  }) {
    Object.assign(this, {
      keepMs,
      seriesIdleMs,
      stamp,
      extractStill,
      projectOf,
      savedStyles,
      engine,
      catalog,
      gallery,
      resources,
      getConfig,
      engineConfig,
      saveConfig,
      persist,
      clientFactory,
      sourceMedia,
      previewOf,
      timing,
      offerOf,
    });
    this.tools = new ToolCatalog(catalog);
    this.pending = new Map();
    // The proposals that ran, as they were confirmed: one that failed is made again from them (again).
    this.ran = new Map();
    // The images of a series still to make (beginSeries, next), by series.
    this.series = new Map();
    this.turns = new Map();
    this.job = null;
    this.finished = Promise.resolve();
    this.closing = false;
    this.gpuBlocked = false;
    // The client of a Studio creation whose models were left on the card for the next one.
    this.kept = null;
    this.keepTimer = null;
    // The series whose images left the local chat model out of the card until its last one (#owe),
    // and the model on its way back when that series stopped short (#chatBack).
    this.owed = null;
    this.owedTimer = null;
    this.returning = null;
  }

  /**
   * Between two images of a series asked in the Chat with the local chat model: the model is not
   * loaded again to be unloaded at once for the next image (and the generator keeps its models).
   * It comes back after the last image, as after any creation, or as soon as the series stops: an
   * image failed or stopped (its own hand-back), the page says the series is over (endSeries), one
   * of its proposals is let go (cancel), or no image follows for a while (a page closed).
   */
  #owe(series) {
    clearTimeout(this.owedTimer);
    this.owed = series;
    this.owedTimer = setTimeout(() => {
      // Another creation runs meanwhile: asked again once it is over.
      if (this.active) this.#owe(series);
      else void this.#chatBack();
    }, this.seriesIdleMs);
    this.owedTimer.unref?.();
  }

  /** Nothing is owed any more: the chat model is back, or a creation is bringing it back itself. */
  #settle() {
    clearTimeout(this.owedTimer);
    this.owed = null;
  }

  /**
   * The chat model back on the card after a series that stopped before its last image, without a
   * creation to hand the card back: the generator lets go, then the model starts again and is
   * waited for. Nothing to do when it was started meanwhile (a message asked for it), nor under a
   * creation, whose own end decides.
   */
  #chatBack() {
    // (Asked twice, by the page and by the time passed: the one return is waited for.)
    if (!this.owed) return this.returning ?? Promise.resolve();
    this.#settle();
    const idle = () => !this.closing && !this.active && this.engine.local !== false && this.engine.state === 'stopped';
    const back = (async () => {
      if (!idle()) return;
      await this.yieldGpu();
      if (!idle()) return;
      try {
        await this.#startChat();
      } catch {
        // Not started: the next message starts it again, and says what stops it.
      }
    })().finally(() => {
      if (this.returning === back) this.returning = null;
    });
    return (this.returning = back);
  }

  /** Starts the chat model and waits for it; throws what kept it from starting. */
  async #startChat() {
    await this.engine.start(this.engineConfig());
    const deadline = Date.now() + RESTART_TIMEOUT_MS;
    while (this.engine.state === 'loading' && Date.now() < deadline && !this.closing) await delay(250);
    if (this.engine.state !== 'ready') throw Error(this.engine.error || 'Le modèle n’a pas redémarré.');
  }

  /**
   * The page says a series is over before its last image (one refused or failed, the user's stop):
   * its prompts and the conversation kept for them are let go, and the chat model its images left
   * out comes back; the answer waits for it, so the page may write to it next. The same when a
   * proposal of the series is let go.
   */
  async endSeries({ series } = {}) {
    if (typeof series !== 'string' || !series) return { ended: false };
    const ended = this.series.delete(series);
    if (this.owed === series) {
      // An image of it still hands the card back: it brings the model back itself when it failed.
      await this.finished;
      if (this.owed === series) await this.#chatBack();
    }
    await this.returning;
    return { ended };
  }

  /** Leaves the generator loaded for the next creation, and gives the card back if none comes. */
  #keep(client) {
    clearTimeout(this.keepTimer);
    this.kept = client;
    this.keepTimer = setTimeout(() => {
      if (!this.active) void this.yieldGpu();
    }, this.keepMs);
    this.keepTimer.unref?.();
  }

  /**
   * Gives the card back for good: what a creation of the Studio left loaded in the generator
   * leaves the video memory. Asked before the chat model starts, when the user stops
   * everything, after a while without a creation, and on closing. True when something left.
   */
  async yieldGpu() {
    clearTimeout(this.keepTimer);
    const client = this.kept;
    this.kept = null;
    if (!client) return false;
    // A generator that cannot be reached holds nothing back from the chat model.
    await client
      .free({ signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS), reserve: await this.#chatBytes() })
      .catch(() => {});
    return true;
  }

  get active() {
    return this.gpuBlocked || (!!this.job && !['done', 'error', 'cancelled'].includes(this.job.state));
  }

  /**
   * Whether the generation being made writes its take for conversation `id` (0.6.86): that one alone
   * waits for its end to be saved. Any page opens during a generation (0.6.81), and a save writes
   * only the conversation's own file (lib/history.mjs): the others were refused for nothing.
   */
  writes(id) {
    return Boolean(id) && !!this.job && !['done', 'error', 'cancelled'].includes(this.job.state) && this.job.conversationId === id;
  }

  /**
   * The tab whose page started the generation was heard from (`tab`: what its page sends with each
   * request, kept across a reload): it is there, and no other tab takes the generation over (0.6.86).
   */
  seen(tab) {
    if (tab && this.job?.tab === tab) this.job.tabSeen = Date.now();
  }

  /** That tab was closed or left: another may follow the generation at once. */
  left(tab) {
    if (tab && this.job?.tab === tab) this.job.tabSeen = 0;
  }

  /** `view`: with what a page draws its card (`proposal`), for one that follows it without having started it. */
  status({ view = false } = {}) {
    if (!this.job) return null;
    const { id, state, progress, error, record, warning, clock, preview, conversationId, media, workflowName, callId, studio } =
      this.job;
    const fraction = clock ? clock.fraction(state) : null;
    // Only the number of the picture so far: the page asks for the picture itself when it changes.
    return {
      id,
      state,
      progress,
      fraction,
      error,
      record,
      warning,
      blocked: this.gpuBlocked,
      ...(preview ? { preview: preview.seq } : {}),
      // Where it was asked and what it makes (0.6.81): any page names it while it runs, a page opened
      // since included.
      ...(conversationId ? { conversationId } : {}),
      ...(media ? { media } : {}),
      ...(workflowName ? { workflowName } : {}),
      // The call of the conversation it answers, and whether the Studio made it (0.6.82): a page
      // reloaded meanwhile finds its call and follows it there.
      ...(callId ? { callId } : {}),
      ...(studio ? { studio: true } : {}),
      // The tab that started it, and whether it has been silent long enough to be gone (0.6.86): a page
      // of another tab follows it only then (take-recovery.mjs). A hidden tab is woken once a minute
      // by the browser at worst: silent longer than that, it is closed (or it said so, left()).
      ...(this.job.tab ? { owner: this.job.tab, ownerAway: Date.now() - (this.job.tabSeen ?? 0) > OWNER_AWAY_MS } : {}),
      ...(view && this.job.view ? { proposal: structuredClone(this.job.view) } : {}),
    };
  }

  /** The picture the generator has so far for the job in progress ({ bytes, mime, seq }), or null. */
  preview(jobId) {
    return this.job?.id === jobId ? (this.job.preview ?? null) : null;
  }

  clear() {
    this.pending.clear();
    this.series.clear();
    this.turns.clear();
    this.gallery.clearMemory?.();
    this.job = null;
    // A series gone with the rest: the chat model its images left out comes back.
    void this.#chatBack();
  }

  forgetConversation(conversationId) {
    for (const [key, value] of this.pending) if (value.conversationId === conversationId) this.pending.delete(key);
    for (const [key, value] of this.series)
      if (value.conversationId === conversationId) {
        this.series.delete(key);
        if (this.owed === key) void this.#chatBack();
      }
    if (this.job?.record?.conversationId === conversationId && !this.active) this.job = null;
  }

  /**
   * `styles` are LoRAs the user picked by hand in the Studio (`[{ name, strength }]`, names as
   * ComfyUI lists them): they are applied on top of the workflow's own, on ComfyUI only.
   * `cited`: the images the user named in their request (`[{ id, label }]`, lib/cited-resources.mjs);
   * the proposal says which of them it leaves out (`cited`, and a note the user reads).
   */
  async request(calls, { conversationId, turnId, messages, styles = [], cited = [], saved = false }) {
    if (this.closing) throw problem('L’application est en cours de fermeture.', 409);
    styles = checkStyles(styles);
    if (!this.getConfig().enabled) throw problem('La génération locale est désactivée.');
    if (!uuid.test(conversationId) || !uuid.test(turnId)) throw problem('Identifiant de conversation invalide.');
    if (calls.length !== 1 || !calls[0]?.id || !this.tools.isGenerationTool(calls[0].function?.name))
      throw problem('Le modèle doit demander une seule génération à la fois.', 502);
    if ((this.turns.get(turnId) || 0) >= this.getConfig().maxIterations)
      throw problem('La limite de générations pour ce message est atteinte.');

    const call = nativeFields({ role: 'assistant', tool_calls: calls }).tool_calls[0];
    let toolArgs = parseArguments(call);
    // Several images in one call: this proposal is the first, the others are made after it (next).
    const series = seriesOf(call.function.name, toolArgs);
    // A length nobody asked for: the workflow keeps its own.
    if (typeof toolArgs.duration === 'number' && inventedLength(messages)) toolArgs = { ...toolArgs, duration: null };
    let args,
      notes = [],
      reused = null,
      // The seed the user named, when the model passed one.
      asked,
      // The picture format the user named, when the model passed one.
      format,
      // The first or last images of videos this request made references of the project (#stills).
      stills = [];
    if (toolArgs.reuse_output === undefined) {
      const framed = await this.#stills(call.function.name, toolArgs, conversationId);
      toolArgs = framed.args;
      stills = framed.kept;
      notes.push(...framed.notes);
    }
    const extending = call.function.name === 'extend_video' && toolArgs.reuse_output === undefined;
    if (extending) {
      const origin = await this.#continuationOrigin(toolArgs.source, conversationId);
      if (origin) {
        toolArgs = { ...toolArgs, source: origin.source };
        notes.push(origin.note);
      }
    }
    if (toolArgs.reuse_output !== undefined) {
      if (!uuid.test(toolArgs.reuse_output)) throw problem('Identifiant de brouillon invalide.');
      const draft = await this.gallery.get(conversationId, toolArgs.reuse_output, { includeImages: false });
      const { reuse_output, stage, intention, prompt } = toolArgs;
      args = { workflow_id: draft.workflowId, reuse_output, stage, intention };
      // Its prompt and its length are the draft's. The tool asks for both in every call (they are
      // `required`, and a constrained decoder cannot leave them out): what the model writes there
      // is left aside, not refused, or no draft could ever be promoted. Anything else is refused.
      for (const key of Object.keys(toolArgs))
        if (!['reuse_output', 'stage', 'intention', 'prompt', 'duration'].includes(key))
          throw problem(
            'La version finale reprend les entrées du brouillon ; seuls le profil final et l’intention sont à fournir.',
          );
      // Another prompt than the draft's (as it was asked, or as its record keeps it): said.
      const own = [draft.prompt, draft.parameters?.replay_args?.prompt]
        .filter(text => typeof text === 'string')
        .map(text => text.trim());
      if (typeof prompt === 'string' && !own.includes(prompt.trim()))
        notes.push('Version finale du brouillon : son prompt est repris tel quel.');
    } else {
      const routed = await this.tools.route(call.function.name, toolArgs, {
        mediaOf: source => this.#mediaOf(source, conversationId),
        // A new shot belongs to the model that generated the footage, even seen through an
        // upscale; another upscale or smoothing stays with the tool that made its source.
        originOf: source => this.#originOf(source, conversationId, !TRANSFORMS.has(call.function.name)),
      });
      // Its workflow lacks a file Moodix can download (etats-maquette.md, 53): no proposal yet.
      if (routed.workflow?.ready === false)
        return this.#missing(routed.workflow, { call, conversationId, turnId, messages, styles });
      args = routed.args;
      asked = routed.seed;
      format = routed.format;
      notes.push(...routed.notes);
    }
    const workflow = await this.catalog.read(args.workflow_id);
    // The next shot of a final video is a final one too, unless the model asked otherwise.
    if (extending && args.stage === undefined && workflow.parameters.stage?.policy === 'model') {
      const made = await this.#recordOf(toolArgs.source, conversationId);
      if (made?.workflowId === workflow.id && workflow.profiles?.[made.parameters?.stage])
        args.stage = made.parameters.stage;
    }
    const video = workflow.mediaType === 'video',
      media = workflow.mediaType;
    if (args.reuse_output !== undefined) reused = await this.#draftToPromote(workflow, args, conversationId);
    if (reused)
      args = {
        ...structuredClone(reused.parameters.replay_args),
        stage: 'final',
        intention: args.intention,
        reuse_output: args.reuse_output,
      };

    const approvalArgs = structuredClone(args);
    const references = await this.#resolveReferences(workflow, args, { conversationId, messages });
    const sourceSize = await this.#sourceSize(workflow, args, conversationId);
    // The format of the picture: the one asked for; else the draft's own when it is promoted
    // (its final profile may be of another format); else that of the image the video starts from.
    const set = format
      ? { format }
      : reused && Number.isInteger(reused.parameters.width) && Number.isInteger(reused.parameters.height)
        ? { width: reused.parameters.width, height: reused.parameters.height }
        : null;
    const aspect = set ?? (await this.#frameSize(workflow, args, conversationId, messages, references));
    // A promoted draft keeps what the user changed on it, except its size: the final profile sets that.
    const { width, height, ...overrides } = reused?.parameters.user_overrides ?? {};
    const prepared = await this.catalog.prepare(args.workflow_id, args, {
      allowPendingReferences: true,
      // A promoted draft keeps its seed; otherwise the one the user named, or a drawn one.
      ...(reused ? { seed: reused.parameters.seed, overrides } : asked !== undefined ? { seed: asked } : {}),
      ...(sourceSize ? { sourceSize } : {}),
      ...(aspect ? { aspect } : {}),
    });
    // Refused now, before the user confirms and the chat model is unloaded.
    if (extending) {
      const format = await this.#videoFormat(toolArgs.source, conversationId);
      const fps = prepared.job.parameters.fps;
      if (format?.fps && Number.isFinite(fps) && Math.abs(format.fps - fps) > 0.01)
        throw problem(
          `Cette vidéo est à ${fpsText(format.fps)} images/s et ${workflow.name} génère à ${fpsText(fps)} images/s : elle ne peut pas être prolongée telle quelle.`,
        );
    }
    if (reused && JSON.stringify(prepared.job.components) !== JSON.stringify(reused.parameters.native_components))
      throw problem('Les composants du brouillon ont changé. Créez une nouvelle proposition.');

    // The LoRAs of the user it will be made with: those given with the request (the Studio, by
    // hand); those of the draft it promotes (its final was made without them); and, for a creation
    // asked in the Chat (`saved`), those kept for this model with « Enregistrer »: there is no
    // Studio on screen to show any, and Moodix AI used none of the user’s there. Not for the
    // continuation of a clip, which takes none by hand either.
    let stylesSaved = false,
      // Those saved for the model whose file is gone from its folder: left out, and said.
      stylesMissing = [];
    if (reused) styles = takesStyles(workflow) ? checkStyles(reused.parameters?.styles ?? []) : [];
    else if (saved && !styles.length && !extending && takesStyles(workflow)) {
      const found = await Promise.resolve(this.savedStyles(workflow.id)).catch(() => []),
        kept = Array.isArray(found) ? found : found?.kept,
        gone = Array.isArray(found) ? [] : found?.missing;
      if (Array.isArray(kept) && kept.length) {
        styles = checkStyles(kept.slice(0, 3));
        stylesSaved = true;
      }
      if (Array.isArray(gone))
        stylesMissing = gone
          .filter(style => typeof style?.name === 'string' && style.name)
          .slice(0, 3)
          .map(style => ({ name: style.name.slice(0, 300) }));
    }
    // A draft promoted takes the inputs of the draft and no other: an image the user names with
    // that request cannot go in the call. The model is not sent back to pass it (the call could
    // only be refused, and no draft promoted); the proposal says why it is left out.
    let cite = await this.#cite(workflow, call.function.name, references, cited);
    if (cite && reused) {
      const labels = cite.left.map(item => item.label),
        list = labels.length > 1 ? labels.slice(0, -1).join(', ') + ' et ' + labels.at(-1) : labels[0];
      notes.push(
        `${list} ${labels.length > 1 ? 'ne sont pas transmises' : 'n’est pas transmise'} : la version finale reprend les entrées du brouillon.`,
      );
      cite = null;
    }

    const now = Date.now();
    for (const [key, pending] of this.pending) if (now - pending.created > APPROVAL_TTL_MS) this.pending.delete(key);
    if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value);

    const proposal = this.#propose(workflow, {
      call,
      args,
      digest: workflow.digest,
      conversationId,
      turnId,
      references,
      approvalArgs,
      video,
      media,
      prepared,
      notes,
      sourceSize,
      aspect,
      // Nobody set the format: it follows the image the video starts from (else the one it ends
      // on), and is worked out again when the user changes that image on the proposal (revise).
      aspectFollows: !set,
      overrides: reused ? overrides : {},
      styles: takesStyles(workflow) ? styles : [],
      // They are the ones saved for the model, taken without being asked: the proposal says so.
      stylesSaved,
      stylesMissing,
      // The seed was named by whoever asked (not drawn): said in the record of the take.
      seedGiven: asked !== undefined || reused?.parameters?.seed_given === true,
      // The seed of the proposal before any change of the user: what a seed typed on it is compared to.
      baseSeed: prepared.job.parameters.seed,
      // (None kept for a draft promoted: what it leaves out is said above, with the notes of the routing.)
      cited: reused ? [] : cited.map(({ id, label }) => ({ id, label })),
      cite,
    });
    // Said to the page, whose list of the references of the project is then read again.
    if (stills.length) proposal.stills = stills;
    return series
      ? this.#beginSeries(proposal, series, { call, conversationId, turnId, messages, styles: stylesSaved ? [] : styles, cited, saved })
      : proposal;
  }

  /**
   * The exact first or last image of a video, where a verb takes an image (`frame`: "first" or
   * "last" on a take, an earlier result or a video reference): read once from the file of the
   * video, at its own size (`extractStill`), and kept as an image reference of the project,
   * « Dernière image · PRISE 25 ». The source becomes that reference before anything else is worked
   * out: the routing, the card of the proposal, the format of the clip and the record of the take
   * see an ordinary image. Asked again, the same image is the reference already kept. Named on an
   * image, a frame says nothing: the image itself. A role that takes a video whole keeps it
   * (ToolCatalog, sources). Returns the arguments, what the proposal says of it (`notes`) and the
   * references used (`kept`).
   */
  async #stills(name, toolArgs, conversationId) {
    const notes = [],
      kept = [],
      made = new Map(),
      args = { ...toolArgs };
    const named = source =>
      !!source && typeof source === 'object' && !Array.isArray(source) && typeof source.frame === 'string';
    for (const role of imageRoles(name)) {
      const value = toolArgs[role];
      if (Array.isArray(value)) {
        if (!value.some(named)) continue;
        args[role] = [];
        for (const source of value)
          args[role].push(named(source) ? await this.#still(source, conversationId, { notes, kept, made }) : source);
      } else if (named(value)) args[role] = await this.#still(value, conversationId, { notes, kept, made });
    }
    return { args, notes, kept };
  }

  /** One source of #stills: the reference its frame is, or the source itself for an image. */
  async #still(source, conversationId, { notes, kept, made }) {
    const { frame: at, ...whole } = source;
    if (!STILL_FRAMES.includes(at))
      throw problem(
        'frame : "first" ou "last" pour la première ou la dernière image d’une vidéo ; 0, 1 ou 2 pour un extrait d’une vidéo de référence.',
      );
    // An image joined to the message: itself.
    if (source.resource === undefined && source.output === undefined) return whole;
    let origin, title, whose, ref;
    if (source.resource !== undefined) {
      if (!this.resources) throw problem('La bibliothèque de ressources est indisponible.');
      const record = await this.resources.activeRecord(source.resource);
      if (!record.mime.startsWith('video/')) return whole;
      origin = `resource/${record.id}/${at}`;
      title = record.label || record.name;
      whose = record.label ? 'de ' + record.label : 'de cette vidéo';
      ref = { resource_id: source.resource };
    } else {
      if (!uuid.test(source.output ?? '')) throw problem('Identifiant de sortie invalide.');
      const place = placeOf(source, conversationId),
        index = Number.isInteger(source.index) ? source.index : 0,
        record = await this.gallery.get(place, source.output, { includeImages: false }),
        output = record.outputs?.[index];
      if (!output) throw problem('Sortie introuvable dans ce résultat.');
      if (record.mediaType !== 'video') return whole;
      origin = `take/${place}/${source.output}/${index}/${at}`;
      title = Number.isInteger(output.take) ? 'PRISE ' + output.take : record.workflowName || 'Vidéo';
      whose = Number.isInteger(output.take) ? 'de la prise ' + output.take : 'de cette vidéo';
      ref = {
        output_id: source.output,
        ...(index ? { output_index: index } : {}),
        ...(place !== conversationId ? { output_conversation: place } : {}),
      };
    }
    const what = `${STILLS[at].toLowerCase()} ${whose}`,
      refused = why => problem(`Impossible de lire la ${what} : ${reasonText(why)}.`);
    // Named twice in one call (the first frame and a reference): one reference.
    if (made.has(origin)) return { resource: made.get(origin) };
    const project = await this.projectOf(conversationId);
    let still = (await this.resources?.stillOf?.(project, origin)) ?? null;
    const found = Boolean(still);
    if (!still) {
      if (!this.extractStill || !this.sourceMedia || !this.resources?.keepStill)
        throw refused('cette lecture n’est pas disponible ici');
      let file, picture;
      try {
        file = await this.sourceMedia(ref, conversationId);
      } catch (error) {
        throw refused(
          error?.code === 'ENOENT' || error?.status === 404 ? 'le fichier de cette vidéo est introuvable' : error?.message,
        );
      }
      try {
        if (!file.mime?.startsWith('video/') || !file.path) throw Error('le fichier de cette vidéo est illisible');
        picture = await this.extractStill(file.path, at);
      } catch (error) {
        throw refused(error?.message);
      } finally {
        await file.handle?.close?.().catch(() => {});
      }
      try {
        still = await this.resources.keepStill({
          project,
          name: `${STILLS[at]} · ${title}`.replace(/[\\/\x00-\x1f\x7f]/g, ' ').slice(0, 255),
          origin,
          ...picture,
        });
      } catch (error) {
        throw refused(error?.message);
      }
      if (still.enabled === false) throw refused(`cette image est déjà la référence ${still.label}, désactivée`);
    }
    made.set(origin, still.id);
    kept.push({ id: still.id, label: still.label, name: still.name, existing: found || still.existing === true });
    const sentence = what[0].toUpperCase() + what.slice(1);
    notes.push(
      found || still.existing
        ? `${sentence} : ${still.label}, déjà dans les références du projet.`
        : `${sentence} gardée comme ${still.label}.`,
    );
    return { resource: still.id };
  }

  /**
   * Several images asked in one call: the proposal of the first, which says its series (`series`:
   * its id, the image it is, how many), and the prompts of the others kept for next(). Every image
   * of a series runs by itself, in the Studio too, whatever « lancer seules les images » says: the
   * user asked for them all (17/11).
   */
  #beginSeries(proposal, prompts, context) {
    const now = Date.now();
    for (const [key, entry] of this.series) if (now - entry.created > SERIES_TTL_MS) this.series.delete(key);
    if (this.series.size >= MAX_SERIES) this.series.delete(this.series.keys().next().value);
    const id = randomUUID(),
      total = prompts.length + 1;
    this.series.set(id, { ...context, prompts: [...prompts], index: 1, total, created: now });
    this.#inSeries(proposal, id, { index: 1, total });
    return { ...proposal, autoAllow: true, series: { id, index: 1, total } };
  }

  /**
   * The proposal kept for an image knows its series: let go, it ends it; run, it may spare the chat
   * model (#owe). And which image it is (`place`), for a page that follows it without having asked it.
   */
  #inSeries(proposal, id, place) {
    const held = this.pending.get(proposal.requestId);
    if (!held) return;
    held.series = id;
    held.seriesAt = place;
  }

  /**
   * The next image of a series: the call of the model with its next prompt, proposed as the model's
   * own (the same inputs and settings, a seed of its own), without asking the model again. The
   * last one ends the series.
   */
  async next({ series: id } = {}) {
    if (this.closing) throw problem('L’application est en cours de fermeture.', 409);
    // (The chat model on its way back after a while without an image: its next image waits for it.)
    await this.returning;
    const entry = typeof id === 'string' ? this.series.get(id) : undefined;
    if (!entry?.prompts.length)
      throw problem('Cette série est terminée ou a expiré : redemandez les images qui manquent.', 409);
    const { series, ...args } = JSON.parse(entry.call.function.arguments);
    const call = {
      ...entry.call,
      function: { ...entry.call.function, arguments: JSON.stringify({ ...args, prompt: entry.prompts[0] }) },
    };
    const proposal = await this.request([call], {
      conversationId: entry.conversationId,
      turnId: entry.turnId,
      messages: entry.messages,
      styles: entry.styles,
      cited: entry.cited,
      saved: entry.saved === true,
    });
    entry.prompts.shift();
    entry.index++;
    if (!entry.prompts.length) this.series.delete(id);
    this.#inSeries(proposal, id, { index: entry.index, total: entry.total });
    // (The page asked for the next image: it is still there, its time starts again.)
    if (this.owed === id) this.#owe(id);
    return { ...proposal, autoAllow: true, series: { id, index: entry.index, total: entry.total } };
  }

  /**
   * The images the user named that a proposal leaves out (`left`), with what its workflow could
   * have done with one more (ToolCatalog.room); null when none is left out, or when that cannot be
   * told: an image passed by its position among those attached may well be one of them.
   */
  async #cite(workflow, name, references, cited = []) {
    if (!cited?.length || !CITING.has(name)) return null;
    if (references.some(reference => reference.image !== undefined)) return null;
    const passed = new Set(references.map(reference => reference.resource_id).filter(Boolean)),
      left = cited.filter(item => !passed.has(item.id));
    if (!left.length) return null;
    return {
      left: left.map(({ id, label }) => ({ id, label })),
      ...(await this.tools.room(name, workflow, references)),
    };
  }

  /**
   * A request whose workflow lacks a file (53): said to the page with what to download (each file,
   * its size, what is left of a download stopped). Once it is there, the page sends the message
   * again: the request is made anew, with the workflow ready.
   */
  async #missing(workflow, held) {
    const offer = await this.offerOf(workflow);
    if (!offer?.complete)
      throw problem(`${workflow.name} n’est pas prêt : ${workflow.unavailableReason || 'un fichier manque.'}`, 409);
    return {
      requestId: randomUUID(),
      call: held.call,
      tool: held.call.function.name,
      workflowName: workflow.name,
      ...(workflow.mediaType !== 'image' ? { mediaType: workflow.mediaType } : {}),
      missing: {
        workflowId: workflow.id,
        files: offer.files,
        bytes: offer.bytes,
        left: offer.left,
        needsToken: offer.needsToken === true,
        page: offer.page || '',
      },
    };
  }
  /**
   * A verb none of the ready workflows makes, whose shipped workflow lacks a file (53): that request
   * said as missing, before anything is made for it (the image of a character, say); else null.
   */
  async lackingFile(calls, { conversationId, turnId, messages, styles = [] }) {
    const workflow = await this.tools.lacking(calls[0]?.function?.name);
    if (!workflow) return null;
    const call = nativeFields({ role: 'assistant', tool_calls: calls }).tool_calls[0];
    return this.#missing(workflow, { call, conversationId, turnId, messages, styles });
  }

  /** Stores a resolved proposal under a fresh request ID (and one-use video token) and describes it. */
  #propose(workflow, pending) {
    const requestId = randomUUID();
    // Every proposal carries a one-use token: required to run a video, and to edit any proposal.
    const approvalToken = randomUUID();
    const { prepared, args, references, approvalArgs, video, cite } = pending;
    const parameters = prepared.job.parameters;
    if (video) approvalArgs.stage = parameters.stage;
    this.pending.set(requestId, { ...pending, approvalToken, created: Date.now() });
    const continues = references.some(ref => ref.role === 'source_video');
    const roles = family(workflow.pipeline).roles ?? {};
    // The verb that says which inputs go together: the card follows the rule the model is held to.
    const verb = ruleVerb(pending.call.function.name, references);
    // What the routing says of itself, then an image the user named and this proposal leaves out
    // (worked out for each proposal, not kept with the routing: an image put in a case answers it).
    const notes = [
      ...pending.notes,
      // The LoRAs saved for the model, which the user did not choose for this creation: said
      // where they confirm, and to the model with its result.
      ...(pending.stylesSaved && pending.styles?.length ? [savedStylesNote(workflow.name, pending.styles)] : []),
      // One of them whose file is no longer in its folder: the creation is made without it.
      ...(pending.stylesMissing?.length ? [missingStylesNote(pending.stylesMissing)] : []),
      ...(cite ? [citedNote(cite.left, { ...cite, workflow: workflow.name, continues })] : []),
    ];
    return structuredClone({
      requestId,
      call: pending.call,
      tool: pending.call.function.name,
      workflowName: workflow.name,
      args: approvalArgs,
      ...(notes.length ? { notes } : {}),
      // Left out though its workflow has a place for them (`roles`): the model is told once.
      ...(cite ? { cited: { left: cite.left, roles: cite.here } } : {}),
      resolution: { width: parameters.width, height: parameters.height },
      referenceCapacity: nativeWorkflowImageInputs(workflow).length,
      // The inputs this proposal holds or may still take, by role: the card shows each place
      // (DÉBUT, FIN, RÉF. n). Only those the verb fills with this workflow, beside what is there:
      // the continuation of a clip by LTX 2.5 shows no case, where revise would refuse an image.
      inputRoles: openRoles(
        workflow,
        verb,
        references.map(ref => ref.input),
      ),
      referenceCount: references.length,
      // Images, and videos agreed on in the conversation, may run on their own when the settings
      // allow it (a video still with its token, see execute); a sound is always confirmed.
      autoAllow: runsByItself(this.getConfig(), pending.media, pending.call.function.name),
      ...(pending.media !== 'image' ? { mediaType: pending.media } : {}),
      // The LoRAs of the user it will be made with ([{ name, strength }]).
      ...(pending.styles?.length ? { styles: pending.styles } : {}),
      approvalToken,
      plan: {
        defaultReferences: [],
        stage: parameters.stage,
        intention: args.intention,
        prompt: parameters.prompt,
        parameters,
        loras: (prepared.job.loras ?? []).map(({ id, strength }) => ({ id, strength })),
        references: references.map(({ url, ...ref }) => {
          // A picture of it the page may show (`previewOf`), never the copy the model was given.
          const preview = this.previewOf?.(ref, pending.conversationId, roles[ref.role]?.media) ?? null;
          return {
            ...ref,
            roleLabel: roles[ref.role]?.label || ref.role,
            ...(roles[ref.role]?.as ? { as: roles[ref.role].as } : {}),
            ...(preview ? { preview } : {}),
          };
        }),
        editable: {
          // Per input, the roles it may take instead (same media, a slot this verb fills in this
          // workflow, beside the other inputs).
          references: references.map((_, index) => referenceRoles(workflow, verb, references, index)),
          prompt: workflow.parameters.prompt?.policy === 'model',
          stages:
            workflow.parameters.stage?.policy === 'model' && args.reuse_output === undefined
              ? Object.keys(workflow.profiles ?? {})
              : [],
          // (With its inputs: a setting read only with one of them is listed when it is there.)
          parameters: editableParameters(workflow, parameters, { continues, references }),
        },
        ...(Object.keys(pending.overrides).length ? { edited: Object.keys(pending.overrides) } : {}),
      },
    });
  }

  /**
   * What a page draws the card of a creation with when it did not start it (0.6.82: begun by a page
   * reloaded since): its call, its kind, its model, its size, its prompt, its inputs, which image of
   * a series it is. Nothing of the disk.
   */
  #followView(pending, requestId) {
    const workflow = pending.prepared?.workflow,
      parameters = pending.prepared?.job?.parameters ?? {},
      roles = workflow ? (family(workflow.pipeline).roles ?? {}) : {};
    return structuredClone({
      requestId,
      call: pending.call,
      tool: pending.call.function.name,
      workflowName: workflow?.name ?? '',
      ...(pending.media !== 'image' ? { mediaType: pending.media } : {}),
      args: pending.approvalArgs ?? {},
      resolution: { width: parameters.width, height: parameters.height },
      plan: {
        stage: parameters.stage,
        prompt: parameters.prompt,
        parameters: Object.fromEntries(
          ['width', 'height', 'frames', 'fps', 'seconds', 'overlap_frames', 'stage', 'seed']
            .filter(key => parameters[key] !== undefined)
            .map(key => [key, parameters[key]]),
        ),
        references: (pending.references ?? []).map(ref => {
          const preview = this.previewOf?.(ref, pending.conversationId, roles[ref.role]?.media) ?? null;
          return {
            role: ref.role,
            roleLabel: roles[ref.role]?.label || ref.role,
            ...(preview ? { preview } : {}),
          };
        }),
      },
      ...(pending.studio ? { studio: true } : {}),
      ...(pending.series && pending.seriesAt ? { series: { id: pending.series, ...pending.seriesAt } } : {}),
    });
  }

  /**
   * The user's own changes to a video proposal, typed in the approval dialog: the prompt, the
   * draft/final profile and any listed parameter. The proposal is resolved again (same seed
   * unless changed) and replaced by a new one, with a new token, that the user still confirms.
   */
  async revise({ requestId, approvalToken, edits }) {
    if (this.closing) throw problem('L’application est en cours de fermeture.', 409);
    const pending = this.pending.get(requestId);
    if (!pending || Date.now() - pending.created > APPROVAL_TTL_MS)
      throw problem('Cet appel a expiré. Relancez la demande.', 409);
    if (approvalToken !== pending.approvalToken) throw problem('Cette proposition ne peut plus être modifiée.', 403);
    if (!edits || typeof edits !== 'object' || Array.isArray(edits)) throw problem('Modifications invalides.');
    const workflow = await this.catalog.read(pending.args.workflow_id);
    if (workflow.digest !== pending.digest) throw problem('Le workflow a été modifié. Relancez la demande.', 409);
    const { prompt, stage, references: roleEdits, add, loras, styles, ...changes } = edits;
    // The LoRAs of the user shown with the proposal in the Studio (those of its family, three at
    // most), in place of those it had: what « Générer » makes is what the Studio shows. A proposal
    // of Moodix AI came without any, and its takes never had those the user had set.
    const chosen = styles === undefined ? pending.styles : takesStyles(workflow) ? checkStyles(styles) : [];
    const args = structuredClone(pending.args),
      approvalArgs = structuredClone(pending.approvalArgs);
    let references = pending.references;
    // The inputs follow the rule of their verb, as those the model passes (route).
    const verb = ruleVerb(pending.call.function.name, pending.references);
    if (roleEdits !== undefined) {
      ({ references } = this.#moveReferences(workflow, args, pending.references, roleEdits, verb));
      approvalArgs.references = structuredClone(args.references);
    }
    // An image put in a case of the card (a take of the project, a file dropped or pasted).
    if (add !== undefined) {
      references = await this.#addReference(workflow, args, references, add, pending.conversationId, verb);
      approvalArgs.references = structuredClone(args.references);
    }
    if (prompt !== undefined) {
      if (workflow.parameters.prompt?.policy !== 'model') throw problem('Le prompt est fixé par ce workflow.');
      if (typeof prompt !== 'string' || !prompt.trim()) throw problem('Le prompt ne peut pas être vide.');
      args.prompt = approvalArgs.prompt = prompt;
    }
    if (loras !== undefined) {
      // As the model would give them: { id: { enabled, strength } }, checked by the workflow.
      if (!loras || typeof loras !== 'object' || Array.isArray(loras)) throw problem('LoRA invalides.');
      args.loras = structuredClone(loras);
      approvalArgs.loras = structuredClone(loras);
    }
    if (stage !== undefined) {
      if (args.reuse_output !== undefined) throw problem('Une version finale reste en profil final.');
      if (workflow.parameters.stage?.policy !== 'model' || !workflow.profiles?.[stage])
        throw problem('Version indisponible pour ce workflow.');
      args.stage = approvalArgs.stage = stage;
    }
    const overrides = { ...pending.overrides, ...changes };
    let aspect = pending.aspect,
      aspectFollows = pending.aspectFollows === true;
    // A size the user set is theirs: the format no longer follows anything.
    const sized = overrides.width !== undefined || overrides.height !== undefined;
    // The image the video starts from (or ends on) is another one now, put in its case or given
    // that role here: the format follows it, as when the model passes it. Left as it was, a
    // landscape image added to DÉBUT was animated in the portrait of the profile.
    const framed =
      aspectFollows && !sized && !pending.sourceSize && frameOf(references) !== frameOf(pending.references);
    if (framed) aspect = await this.#frameSize(workflow, args, pending.conversationId, [], references);
    const shown = pending.prepared.job.parameters;
    if (stage !== undefined && stage !== shown.stage && !pending.sourceSize) {
      // Another version has its own scale, not another format: the picture keeps the format the
      // window shows (the size the user chose there included), at the size of the new profile.
      const width = overrides.width ?? shown.width,
        height = overrides.height ?? shown.height;
      // (The format just taken from a new first frame is the one to keep, not the one shown.)
      if (!framed && Number.isInteger(width) && Number.isInteger(height)) aspect = { width, height };
      if (sized) aspectFollows = false;
      delete overrides.width;
      delete overrides.height;
    }
    const options = {
      allowPendingReferences: true,
      // The seed the proposal came with, not the one shown: a seed the user typed is their edit,
      // and stays one at the next change (compared to itself below, it stopped being « given »:
      // the take no longer said its seed was named, and the Studio drew another).
      seed: pending.baseSeed ?? pending.prepared.job.parameters.seed,
      ...(pending.sourceSize ? { sourceSize: pending.sourceSize } : {}),
      ...(aspect ? { aspect } : {}),
    };
    let prepared;
    try {
      // A value set back to what the profile or the workflow gives is no longer an edit.
      const base = await this.catalog.prepare(args.workflow_id, args, options);
      for (const [key, value] of Object.entries(overrides))
        if (base.job.parameters[key] === value) delete overrides[key];
      // Nor is one the engine does not read with these inputs (the denoise of Krea 2 without an
      // image to modify): the take is not made with it, and is not said « modifié par vous ».
      for (const key of Object.keys(unreadParameters(workflow, references))) delete overrides[key];
      prepared = await this.catalog.prepare(args.workflow_id, args, { ...options, overrides });
    } catch (error) {
      throw problem(error.message);
    }
    if (pending.args.reuse_output !== undefined && pending.prepared.job.components) {
      if (JSON.stringify(prepared.job.components) !== JSON.stringify(pending.prepared.job.components))
        throw problem('Les composants du brouillon ont changé. Créez une nouvelle proposition.');
    }
    this.pending.delete(requestId);
    return this.#propose(workflow, {
      ...pending,
      args,
      approvalArgs,
      prepared,
      overrides,
      references,
      aspect,
      aspectFollows,
      styles: chosen,
      // Chosen on the proposal, they are no longer those taken from what was saved.
      stylesSaved: styles === undefined && pending.stylesSaved === true,
      stylesMissing: styles === undefined ? (pending.stylesMissing ?? []) : [],
      cite: await this.#cite(workflow, pending.call.function.name, references, pending.cited),
    });
  }

  /**
   * An input added by the user in the card of a proposal (`add`: { role, source }): a take
   * (`{ output, index?, conversation? }`) or a reference of the project (`{ resource }`), in the first
   * free slot of that role; every slot of it taken, it replaces the first input of that role.
   * The role is named as the family names its slots (`msr_image`) or as the verb names its roles
   * (`reference`). What route() would refuse to the model is refused here, in the user's words: a
   * slot the verb does not fill with this workflow (a last frame on a continuation: the worker
   * would run it or fail on it after « Générer », with no way to take the image out again), and
   * inputs the family does not combine.
   */
  async #addReference(workflow, args, current, add, conversationId, verb) {
    const source = add?.source;
    if (!add || typeof add.role !== 'string' || !source || typeof source !== 'object')
      throw problem('Entrée invalide.');
    const roles = family(workflow.pipeline).roles ?? {},
      named = slot => slot.role === add.role || roles[slot.role]?.as === add.role,
      slots = verbSlots(workflow, verb).filter(named);
    if (!slots.length) {
      // A place the workflow has, which a continuation leaves empty: said by its name.
      const label = (workflow.references ?? []).filter(named).map(slot => roles[slot.role]?.label)[0];
      throw problem(
        label && verb === 'extend_video'
          ? `${workflow.name} ne prend pas ${none(label)} pour la suite d’une vidéo.`
          : `${workflow.name} ne prend pas d’image à cet endroit.`,
      );
    }
    let list = [...current],
      given = [...(args.references ?? [])];
    let slot = slots.find(item => !list.some(ref => ref.input === item.id));
    if (!slot) {
      const replaced = list.findIndex(ref => slots.some(item => item.id === ref.input));
      slot = slots.find(item => item.id === list[replaced].input);
      list = list.filter((_, index) => index !== replaced);
      given = given.filter((_, index) => index !== replaced);
    }
    const apart = apartInputs(workflow, [...list.map(ref => ref.input), slot.id]);
    if (apart.length)
      throw problem(`${workflow.name} ne prend pas ces entrées ensemble : ${apartText(workflow, apart)}.`);
    let reference;
    if (typeof source.output === 'string') {
      reference = { input: slot.id, output_id: source.output };
      if (Number.isInteger(source.index) && source.index > 0) reference.output_index = source.index;
      if (typeof source.conversation === 'string' && source.conversation !== conversationId)
        reference.output_conversation = source.conversation;
    } else if (typeof source.resource === 'string') reference = { input: slot.id, resource_id: source.resource };
    else throw problem('Entrée invalide.');
    const [resolved] = await this.#resolveReferences(
      workflow,
      { references: [reference] },
      { conversationId, messages: [] },
    );
    args.references = [...given, reference];
    return [...list, resolved];
  }

  /**
   * The user gives an input another role (the model sent an image as a subject reference
   * where the user meant the first frame): each input takes the first free slot of its role.
   * As for an input added, what route() would refuse to the model is refused here.
   */
  #moveReferences(workflow, args, current, edits, verb) {
    if (!Array.isArray(edits) || edits.length > current.length) throw problem('Rôles des entrées invalides.');
    const wanted = current.map(ref => ref.role),
      roles = family(workflow.pipeline).roles ?? {};
    for (const edit of edits) {
      if (!edit || !Number.isInteger(edit.index) || !current[edit.index] || typeof edit.role !== 'string')
        throw problem('Rôles des entrées invalides.');
      // Each move is checked for itself (a slot of its media that this verb fills); what the
      // inputs make together is checked once all are moved: two references may become the
      // first and the last frame in one go. The role is named as the family names its slots
      // (`msr_image`, what a proposal lists) or as the verb names its roles (`reference`, what
      // the cases of the Studio are called): both are the same place.
      const options = movableRoles(workflow, verb, current[edit.index].role),
        target = options.find(role => role === edit.role) ?? options.find(role => roles[role]?.as === edit.role);
      if (!target) throw problem(`« ${current[edit.index].label} » ne peut pas prendre ce rôle dans ${workflow.name}.`);
      wanted[edit.index] = target;
    }
    const used = new Set();
    const inputs = wanted.map((role, index) => {
      const slot = workflow.references.find(item => item.role === role && !used.has(item.id));
      if (!slot)
        throw problem(
          `Plus de place pour « ${current[index].label} » comme ${(roles[role]?.label || role).toLowerCase()} dans ${workflow.name}.`,
        );
      used.add(slot.id);
      return slot.id;
    });
    const apart = apartInputs(workflow, inputs);
    if (apart.length)
      throw problem(`${workflow.name} ne prend pas ces entrées ensemble : ${apartText(workflow, apart)}.`);
    if (!Array.isArray(args.references) || args.references.length !== current.length)
      throw problem('Rôles des entrées invalides.');
    args.references = args.references.map((ref, index) => ({ ...ref, input: inputs[index] }));
    return {
      references: current.map((ref, index) => ({ ...ref, input: inputs[index], role: wanted[index] })),
    };
  }

  async #draftToPromote(workflow, args, conversationId) {
    if (!workflow.profiles?.final) throw problem('Ce workflow ne définit pas de profil final.');
    if (!uuid.test(args.reuse_output)) throw problem('Identifiant de brouillon invalide.');
    const draft = await this.gallery.get(conversationId, args.reuse_output, { includeImages: false });
    if (
      draft.provider !== 'native' ||
      draft.mediaType !== 'video' ||
      draft.workflowId !== workflow.id ||
      draft.parameters.workflow_digest !== workflow.digest ||
      draft.parameters.stage !== 'draft' ||
      !draft.parameters.replay_args
    )
      throw problem('Ce brouillon ne peut pas être repris avec ce workflow.');
    // (Its prompt is not compared: request() takes the draft's, whatever the call says.)
    const allowed = ['workflow_id', 'reuse_output', 'stage', 'intention'];
    if (args.stage !== 'final' || Object.keys(args).some(key => !allowed.includes(key)))
      throw problem(
        'La version finale reprend les entrées du brouillon ; seuls le profil final et l’intention sont à fournir.',
      );
    return draft;
  }

  async #recordOf(source, conversationId) {
    if (!uuid.test(source?.output ?? '')) return null;
    const record = await this.gallery
      .get(placeOf(source, conversationId), source.output, { includeImages: false })
      .catch(() => null);
    return record?.provider === 'native' ? record : null;
  }

  /**
   * A video made by upscaling or smoothing another one shows the same footage in a format a
   * video model does not generate (larger, more frames per second): its continuation starts
   * from the video it was made from, found through the references kept with each result.
   * Slow motion is other footage (new timing), so it is its own source. Returns null when the
   * source is to be continued as it is.
   */
  async #continuationOrigin(source, conversationId) {
    let current = source;
    const undone = [];
    for (let depth = 0; depth < 8; depth++) {
      const record = await this.#recordOf(current, conversationId);
      if (
        record?.mediaType !== 'video' ||
        !transforms(record.parameters?.pipeline) ||
        record.parameters.mode === 'slow_motion'
      )
        break;
      const from = record.parameters.references?.find(ref => ref.role === 'source_video');
      const previous = from?.output_id
        ? asSource(from, placeOf(current, conversationId), conversationId)
        : from?.resource_id
          ? { resource: from.resource_id }
          : null;
      // The video it came from must still be there (in the conversation of this result unless
      // it names another, or an active resource).
      if (!previous || (await this.#mediaOf(previous, conversationId).catch(() => null)) !== 'video') break;
      undone.unshift(record.workflowName);
      current = previous;
    }
    if (!undone.length) return null;
    return {
      source: current,
      note: `La suite repart de la vidéo d’origine, avant « ${undone.join(' » puis « ')} » : un modèle vidéo prolonge au format de ses propres générations. Relancez Upscale ou Interpoler sur le résultat.`,
    };
  }

  /** Size and frame rate of a video source as far as its records tell (fps null when unknown). */
  async #videoFormat(source, conversationId, depth = 0) {
    if (source?.resource !== undefined) {
      const record = await this.resources?.activeRecord(source.resource).catch(() => null);
      return record ? { width: record.width, height: record.height, fps: null } : null;
    }
    const record = await this.#recordOf(source, conversationId);
    if (!record || record.mediaType !== 'video') return null;
    const output = record.outputs?.[source.index ?? 0] || {},
      parameters = record.parameters || {};
    let fps = Number.isFinite(parameters.fps) ? parameters.fps : null;
    if (fps === null && depth < 8 && transforms(parameters.pipeline)) {
      const from = parameters.references?.find(ref => ref.role === 'source_video');
      const previous = from?.output_id
        ? await this.#videoFormat(
            { ...asSource(from, placeOf(source, conversationId), conversationId), index: from.output_index ?? 0 },
            conversationId,
            depth + 1,
          )
        : null;
      // Smoothing multiplies the frame rate; slow motion and upscaling keep it.
      if (previous?.fps)
        fps = previous.fps * (parameters.multiplier && parameters.mode !== 'slow_motion' ? parameters.multiplier : 1);
    }
    return { width: output.width ?? parameters.width, height: output.height ?? parameters.height, fps };
  }

  /** Workflow and model family that produced an earlier result, so a continuation can stay in them. */
  async #originOf(source, conversationId, generator = false) {
    let record = await this.#recordOf(source, conversationId),
      // Where the result being read is kept: its own references are found from there.
      place = placeOf(source, conversationId);
    // An upscaled or smoothed result still belongs to the model that generated its footage.
    for (let depth = 0; generator && depth < 8 && record && transforms(record.parameters?.pipeline); depth++) {
      const from = record.parameters.references?.find(ref => ref.role?.startsWith('source'));
      const earlier = from?.output_id ? asSource(from, place, conversationId) : null,
        previous = earlier ? await this.#recordOf(earlier, conversationId) : null;
      if (!previous) break;
      record = previous;
      place = placeOf(earlier, conversationId);
    }
    if (!record) return null;
    return { workflowId: record.workflowId, pipeline: record.parameters?.pipeline };
  }

  /**
   * Width and height of the video a continuation starts from, or null when unknown.
   * A continuation is generated at its source's own size: the profile size would not match
   * the source tail it has to land on.
   */
  async #sourceSize(workflow, args, conversationId) {
    const slots = new Map(workflow.references.map(slot => [slot.id, slot]));
    const source = nativeWorkflowReferences(workflow, args).find(ref => slots.get(ref.input)?.role === 'source_video');
    if (!source) return null;
    let width, height;
    if (source.output_id !== undefined) {
      const record = await this.gallery.get(placeOf(asSource(source), conversationId), source.output_id, {
        includeImages: false,
      });
      const output = record.outputs?.[source.output_index ?? 0] || {};
      width = output.width ?? record.parameters?.width;
      height = output.height ?? record.parameters?.height;
    } else if (source.resource_id !== undefined && this.resources) {
      ({ width, height } = await this.resources.activeRecord(source.resource_id));
    }
    return Number.isInteger(width) && Number.isInteger(height) ? { width, height } : null;
  }

  /**
   * The size of the image a video starts from (else the one it ends on), to give the video its
   * format. `resolved`: the inputs of the proposal as they were resolved, when there are some; an
   * image joined to the conversation is then measured from what they kept of it (revise has the
   * proposal, not the messages).
   */
  async #frameSize(workflow, args, conversationId, messages, resolved = []) {
    const roles = FRAME_ROLES[workflow.mediaType];
    if (!roles) return null;
    const slots = new Map(workflow.references.map(slot => [slot.id, slot]));
    const given = nativeWorkflowReferences(workflow, args);
    const source = roles
      .map(role => given.find(ref => slots.get(ref.input)?.role === role))
      .find(Boolean);
    if (!source) return null;
    try {
      let width, height;
      if (source.output_id !== undefined) {
        const record = await this.gallery.get(placeOf(asSource(source), conversationId), source.output_id, {
          includeImages: false,
        });
        const output = record.outputs?.[source.output_index ?? 0] || {};
        width = output.width ?? record.parameters?.width;
        height = output.height ?? record.parameters?.height;
      } else if (source.resource_id !== undefined && this.resources) {
        ({ width, height } = await this.resources.activeRecord(source.resource_id));
      } else if (source.image !== undefined) {
        const part = chatImageParts(messages)[source.image],
          kept = resolved.find(ref => ref.image === source.image),
          attachment = part?.file ?? kept?.attachment,
          url = part?.image_url?.url ?? kept?.url;
        if (attachment && ORIGINAL_ATTACHMENT.test(attachment) && this.sourceMedia) {
          const file = await this.sourceMedia({ attachment }, conversationId);
          try {
            const bytes = Buffer.alloc(Math.min(file.info?.size ?? 262144, 262144));
            await file.handle.read(bytes, 0, bytes.length, 0);
            ({ width, height } = imageSize(bytes) ?? {});
          } finally {
            await file.handle.close();
          }
        } else if (typeof url === 'string' && url.startsWith('data:image/'))
          ({ width, height } =
            imageSize(Buffer.from(url.slice(url.indexOf(',') + 1, url.indexOf(',') + 350000), 'base64')) ?? {});
      }
      return Number.isInteger(width) && Number.isInteger(height) ? { width, height } : null;
    } catch {
      // The format is a convenience: a source that cannot be measured keeps the profile's size.
      return null;
    }
  }

  /** Media type of a verb source: a chat image, an active resource (or one of its frames) or an earlier output. */
  async #mediaOf(source, conversationId) {
    if (source.image !== undefined) return 'image';
    if (source.resource !== undefined) {
      if (!this.resources) throw problem('La bibliothèque de ressources est indisponible.');
      const record = await this.resources.activeRecord(source.resource);
      // A frame only means something for a video. The tool offers `frame` on every image role as
      // soon as the project holds one video: named on an image, it made the generator work from
      // the reduced copy kept for the model instead of the file. Left out of the call here.
      if (!record.mime.startsWith('video/')) delete source.frame;
      return record.mime.startsWith('video/') && source.frame === undefined ? 'video' : 'image';
    }
    if (!uuid.test(source.output ?? '')) throw problem('Identifiant de sortie invalide.');
    const record = await this.gallery.get(placeOf(source, conversationId), source.output, { includeImages: false });
    if (!record.outputs[source.index ?? 0]) throw problem('Sortie introuvable dans ce résultat.');
    return record.mediaType || 'image';
  }

  /**
   * Maps each requested slot to its pixels. Chat images and video frames are compressed copies;
   * resources and earlier outputs are passed as their original files, so an upscale or a
   * continuation never works from a reduced preview.
   */
  async #resolveReferences(workflow, args, { conversationId, messages }) {
    const slots = nativeWorkflowImageInputs(workflow);
    const chatImages = chatImageParts(messages);
    const resources = new Map();
    const references = [];
    for (const source of nativeWorkflowReferences(workflow, args)) {
      const slot = slots.find(item => item.id === source.input);
      const media = family(workflow.pipeline).roles[slot.role].media;
      // An attached image is passed as the file the user gave, never as the model's compressed copy.
      const attachment = source.image !== undefined && chatImages[source.image]?.file;
      if (attachment && ORIGINAL_ATTACHMENT.test(attachment)) {
        if (!this.sourceMedia) throw problem('Le fichier original de cette source est indisponible.');
        const file = await this.sourceMedia({ attachment }, conversationId);
        try {
          if (!file.mime.startsWith(media + '/'))
            throw problem(`${slot.name || slot.id} attend ${media === 'video' ? 'une vidéo' : 'une image'}.`);
          references.push({
            ...source,
            attachment,
            original: true,
            label: 'Image ' + (source.image + 1),
            role: slot.role,
          });
        } finally {
          await file.handle.close();
        }
        continue;
      }
      // An image reference named with a frame (a request kept from before, replayed): its file all
      // the same, a frame being one of a video.
      const still =
        source.resource_id !== undefined &&
        source.frame !== undefined &&
        (await this.resources?.activeRecord?.(source.resource_id).catch(() => null))?.mime?.startsWith('image/') ===
          true;
      const original =
        source.output_id !== undefined || (source.resource_id !== undefined && (source.frame === undefined || still));
      if (original) {
        if (!this.sourceMedia) throw problem('Le fichier original de cette source est indisponible.');
        const file = await this.sourceMedia(source, conversationId);
        try {
          if (!file.mime.startsWith(media + '/'))
            throw problem(`${slot.name || slot.id} attend ${media === 'video' ? 'une vidéo' : 'une image'}.`);
          const { frame, ...whole } = source;
          // A reference that is a file of the user's is named as they name it (« #ref4 »), not by
          // the name of its file (« 297e3b9f….png »); one the application made keeps the name that
          // says what it is (« Dernière image · PRISE 25 »).
          const named =
            source.resource_id !== undefined && /\.[a-z0-9]{2,5}$/i.test(file.name || '')
              ? (await this.resources?.activeRecord?.(source.resource_id).catch(() => null))?.label
              : null;
          references.push({
            ...whole,
            original: true,
            label: named || file.name || 'Résultat précédent',
            role: slot.role,
          });
        } finally {
          await file.handle.close();
        }
        continue;
      }
      let url;
      let resource;
      if (source.resource_id !== undefined) {
        if (!this.resources) throw problem('La bibliothèque de ressources est indisponible.');
        if (!resources.has(source.resource_id))
          resources.set(source.resource_id, await this.resources.readActive(source.resource_id));
        resource = resources.get(source.resource_id);
        url = resource.frames[source.frame ?? 0]?.url;
      } else url = chatImages[source.image]?.image_url?.url;
      if (!url) throw problem('La référence demandée par le modèle est introuvable.');
      if (media !== 'image') throw problem(`${slot.name || slot.id} attend une vidéo originale.`);
      references.push({
        ...source,
        url,
        label: resource ? resource.label || resource.name : 'Image ' + (source.image + 1),
        role: slot.role,
        ...(resource ? { time: resource.frames[source.frame ?? 0]?.time } : {}),
      });
    }
    return references;
  }

  /**
   * `studio`: the user started it in the Studio (by hand, or with « Générer » on a proposal of
   * Moodix AI there). The chat model stays unloaded afterwards and the generator keeps its
   * models on the card: the user may well make another one at once.
   */
  /**
   * A creation that failed, made again with the same settings (etats-maquette.md, 52): its proposal
   * as it ran, under a fresh request and token, for the user to start at once (« Relancer ») or to
   * change first (« Modifier la proposition »).
   */
  async again({ requestId }) {
    if (this.closing) throw problem('L’application est en cours de fermeture.', 409);
    const ran = this.ran.get(requestId);
    if (!ran) throw problem('Cette génération ne peut plus être relancée : demandez-la de nouveau.', 409);
    const workflow = await this.catalog.read(ran.args.workflow_id);
    if (workflow.digest !== ran.digest)
      throw problem('Le workflow a changé depuis : demandez la génération de nouveau.', 409);
    // (Made again by itself, it is no longer an image of the series it was asked in.)
    const { series, ...made } = structuredClone(ran);
    // A call of its own (0.6.86): the conversation keeps the one that failed with its result, and this
    // one with its own. One identifier for both gave the take of a page reloaded meanwhile to the call
    // that failed (take-recovery.mjs), and a model that wants each call once (Claude) two of them.
    const call = made.call && { ...made.call, id: `call_${randomUUID().replaceAll('-', '').slice(0, 24)}` };
    return this.#propose(workflow, { ...made, ...(call ? { call } : {}), turnId: randomUUID() });
  }
  async execute({ requestId, permission, approvalToken, studio = false, tab = '' }) {
    if (this.closing) throw problem('L’application est en cours de fermeture.', 409);
    if (this.active || this.engine.busy) throw problem('Une opération GPU est déjà en cours.', 409);
    const pending = this.pending.get(requestId);
    if (!pending || Date.now() - pending.created > APPROVAL_TTL_MS)
      throw problem('Cet appel a expiré. Relancez la demande.', 409);
    const config = this.getConfig();
    if (!config.enabled) throw problem('La génération locale est désactivée.');
    if (pending.media !== 'image' && (permission !== 'once' || approvalToken !== pending.approvalToken))
      throw problem(
        `Chaque ${pending.video ? 'vidéo' : 'son'} nécessite une confirmation explicite de cette proposition.`,
        403,
      );
    if (!config.autoAllow && !['once', 'always'].includes(permission))
      throw problem('Une autorisation est nécessaire.', 403);
    if ((this.turns.get(pending.turnId) || 0) >= config.maxIterations)
      throw problem('La limite de générations est atteinte.');

    const controller = new AbortController();
    let finish;
    this.finished = new Promise(resolve => {
      finish = resolve;
    });
    this.job = {
      id: randomUUID(),
      requestId,
      state: 'checking',
      progress: 'Vérification du moteur de génération…',
      controller,
      conversationId: pending.conversationId,
      media: pending.media,
      workflowName: pending.prepared?.workflow?.name ?? '',
      callId: pending.call?.id,
      // The tab whose page started it (0.6.86): reloaded, that page follows it again; another tab
      // only once this one is gone (status: owner, ownerAway).
      ...(typeof tab === 'string' && tab ? { tab: tab.slice(0, 64), tabSeen: Date.now() } : {}),
    };
    this.pending.delete(requestId);
    try {
      this.ran.set(requestId, structuredClone(pending));
      if (this.ran.size > 32) this.ran.delete(this.ran.keys().next().value);
    } catch {
      // Not to be copied: it cannot be made again, it still runs.
    }
    if (studio === true) pending.studio = true;
    this.job.studio = pending.studio === true;
    try {
      this.job.view = this.#followView(pending, requestId);
    } catch {
      // Without it a page that did not start it shows its percentage alone, as before.
    }
    clearTimeout(this.keepTimer);
    clearTimeout(this.owedTimer);
    let client;
    try {
      if ((await this.catalog.read(pending.args.workflow_id)).digest !== pending.digest)
        throw problem('Le workflow a été modifié. Une nouvelle autorisation est nécessaire.', 409);
      // The previous run of this workflow at this size paces the progress bar.
      this.job.timingKey = timingKey(
        pending.args.workflow_id,
        pending.prepared.job?.parameters,
        pending.references.length,
      );
      this.job.clock = new ProgressClock(await this.timing?.reference(this.job.timingKey).catch(() => null));
      await this.#checkResources(pending);
      client = this.clientFactory();
      if (!(await client.status({ signal: controller.signal })).idle)
        throw problem('Le moteur de génération exécute déjà une tâche. Attendez sa fin.', 409);
      // The sources are staged first, so everything the worker can check without the GPU (a
      // source video of the wrong format, an unreadable image) fails here, while the chat
      // model is still loaded.
      const prepared = await this.#prepareJob(pending, client, controller.signal);
      await client.preflight(prepared.job, { signal: controller.signal });
      controller.signal.throwIfAborted();
      if (permission === 'always') await this.saveConfig({ ...config, autoAllow: true });
      controller.signal.throwIfAborted();
      this.turns.set(pending.turnId, (this.turns.get(pending.turnId) || 0) + 1);
      if (this.turns.size > 256) this.turns.delete(this.turns.keys().next().value);
      // Each reference this creation starts from: a use (the least used leave the model's list first).
      void this.resources?.used?.(pending.references.map(ref => ref.resource_id ?? ref.resource)).catch(() => {});
      this.job.state = 'unloading';
      // A remote chat model holds nothing on the card: there is nothing of it to free. Nor after an
      // image of a series, which left the local one out.
      this.job.progress =
        this.engine.local === false || this.owed
          ? 'Préparation de la génération…'
          : 'Libération du modèle et du projecteur…';
      this.job.clock.mark('unloading');
      this.run(pending, client, controller, prepared).finally(finish);
      return this.status();
    } catch (error) {
      // Staged copies of the sources are removed with the worker's release.
      await client?.free({ signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS) }).catch(() => {});
      this.job.state = 'error';
      this.job.error = error.message;
      finish();
      // What an earlier creation left loaded is still there: its time starts again.
      if (this.kept) this.#keep(this.kept);
      // And the chat model the images of a series left out is still owed.
      if (this.owed) this.#owe(this.owed);
      throw error;
    }
  }

  /** The approved job with its sources staged where the worker reads them. */
  async #prepareJob(pending, client, signal) {
    const staged = await this.#stageReferences(pending, client, signal);
    const prepared = structuredClone(pending.prepared);
    if (pending.styles?.length) prepared.job.styles = structuredClone(pending.styles);
    // The name of the file to come (lib/output-names.mjs): the time it starts, its model, a short
    // suffix. The engine puts it in the folder of its kind and says where in its answer.
    prepared.job.outputName = creationName(prepared.workflow.name);
    const slots = nativeWorkflowImageInputs(prepared.workflow);
    prepared.job.references = pending.references.map(ref => ({
      input: ref.input,
      role: slots.find(slot => slot.id === ref.input)?.role || 'img2img',
      path: staged[ref.input].path,
    }));
    return prepared;
  }

  async #checkResources(pending) {
    for (const id of new Set(pending.references.map(ref => ref.resource_id).filter(Boolean)))
      await this.resources.activeRecord(id);
  }

  /** Writes reference pixels and source videos where the worker can read them. */
  async #stageReferences(pending, client, signal) {
    const staged = {};
    const uploaded = new Map();
    for (const [index, ref] of pending.references.entries()) {
      signal.throwIfAborted();
      if (ref.original) {
        staged[ref.input] = await client.stage(await this.sourceMedia(ref, pending.conversationId), { signal });
        continue;
      }
      if (!uploaded.has(ref.url)) {
        const png = ref.url.startsWith('data:image/png');
        uploaded.set(
          ref.url,
          await client.upload(Buffer.from(ref.url.split(',')[1], 'base64'), {
            filename: `atelier-${this.job.id}-${index}.${png ? 'png' : 'jpg'}`,
            mime: png ? 'image/png' : 'image/jpeg',
            signal,
          }),
        );
      }
      staged[ref.input] = uploaded.get(ref.url);
    }
    return staged;
  }

  async run(pending, client, controller, prepared) {
    const job = this.job;
    const signal = controller.signal;
    try {
      // The workflow may have been edited while the engine status was checked.
      if ((await this.catalog.read(pending.args.workflow_id)).digest !== pending.digest)
        throw problem('Le workflow a été modifié. Une nouvelle autorisation est nécessaire.', 409);
      // The local chat model leaves the card; a remote one stays where it is, ready for the next words.
      if (this.engine.local !== false) await this.engine.stop();
      signal.throwIfAborted();
      await this.#checkResources(pending);
      prepared ??= await this.#prepareJob(pending, client, signal);
      if (prepared.workflow.digest !== pending.digest) throw problem('Le workflow a été modifié avant son exécution.');

      job.state = 'generating';
      job.progress = 'Génération en cours…';
      job.clock?.mark('generating');
      const started = Date.now();
      const result = await client.run(prepared.job, {
        signal,
        mediaType: pending.media,
        onProgress: value => {
          // The picture so far replaces the one before: one small image in memory, no more.
          if (value?.preview) {
            job.preview = { ...value.preview, seq: (job.preview?.seq ?? 0) + 1 };
            return;
          }
          job.progress = progressLabel(value, pending.media);
          job.clock?.mark(milestone(value), value);
        },
      });
      job.record = await this.#saveRecord(pending, prepared, result, Date.now() - started);
    } catch (error) {
      // Said in the user's words when it is known (the card out of memory): what the engine says
      // of it is in its journal.
      const asked = prepared?.job?.parameters ?? {};
      job.error = signal.aborted
        ? 'Génération annulée.'
        : explainFailure(error.message, {
            media: pending.media,
            width: asked.width,
            height: asked.height,
            frames: asked.frames,
            fps: asked.fps,
            overlap: asked.overlap_frames,
            continues: (pending.references ?? []).some(ref => ref.role === 'source_video'),
          });
    } finally {
      // The Studio works without the chat model: it comes back when a message or a style asks for it.
      // A remote chat model needs no card: the generator keeps its models for the next creation, as
      // in the Studio, and gives them back after a while without one.
      const reload = !pending.studio && pending.conversationId !== STUDIO_ID && this.engine.local !== false;
      // An image of a series made, and others to come (next): the chat model would be loaded to be
      // unloaded at once. It stays out and the generator keeps its models, as in the Studio, until
      // the last image, or until the series stops (#owe).
      const between = reload && !job.error && !this.closing && (this.series.get(pending.series)?.prompts.length ?? 0) > 0;
      if (between) this.#owe(pending.series);
      // (It comes back with this creation; one of the Studio leaves what is owed as it is.)
      else if (reload) this.#settle();
      await this.#handBackGpu(job, client, pending.media, signal, reload && !between);
      // The time without a next image is counted from the end of this one (unless it has begun).
      if (this.owed && this.job === job) this.#owe(this.owed);
    }
  }

  async #saveRecord(pending, prepared, result, duration) {
    const { job: resolved, workflow } = prepared;
    // What was made, where the engine decides it: a video that follows another has that one's
    // length, rate and shape, not those the workflow asked for. An upscale or a smoothing has no
    // such parameter at all: the engine says the rate and the frame count of the file it wrote
    // beside them (without them the record of a smoothed clip said neither, and its length and
    // its rate could only be guessed from the clip it came from).
    const told = result.metadata ?? {},
      drawn = told.parameters ?? {},
      made = Object.fromEntries(
        ['frames', 'fps', 'width', 'height']
          .map(key => [key, Number.isFinite(drawn[key]) || !['frames', 'fps'].includes(key) ? drawn[key] : told[key]])
          .filter(([, value]) => Number.isFinite(value)),
      );
    // The size of a file as the engine measured it: kept with its output (an upscale's is in none
    // of its parameters, and was only known once the page had measured it).
    const sizeOf = output =>
      [output?.width, output?.height].every(value => Number.isInteger(value) && value > 0 && value <= 131072)
        ? { width: output.width, height: output.height }
        : {};
    const parameters = {
      ...resolved.parameters,
      ...made,
      reference_count: pending.references.length,
      reference_capacity: nativeWorkflowImageInputs(workflow).length,
      reference_mode: pending.references.length ? 'pixels' : 'not_provided',
      reference_default_count: 0,
      reference_defaults: [],
      workflow_digest: workflow.digest,
      generation_duration_ms: duration,
      runner_duration_ms: duration,
      pipeline: resolved.pipeline,
      loras: resolved.loras.map(({ id, strength }) => ({ id, strength })),
      references: pending.references.map(({ url, ...ref }) => ref),
      replay_args: structuredClone(pending.args),
      native_components: resolved.components,
      ...(pending.args.reuse_output ? { reused_from: pending.args.reuse_output } : {}),
      ...(result.metadata?.continuation ? { continuation: result.metadata.continuation } : {}),
      ...(Object.keys(pending.overrides ?? {}).length ? { user_overrides: structuredClone(pending.overrides) } : {}),
      ...(pending.notes?.length ? { routing_notes: [...pending.notes] } : {}),
      ...(pending.styles?.length ? { styles: structuredClone(pending.styles) } : {}),
      // A seed the user named (asked for, or set on the proposal), not one drawn: the Studio gives it
      // back with the settings of the take, and draws a new one otherwise.
      ...(pending.seedGiven || pending.overrides?.seed !== undefined ? { seed_given: true } : {}),
    };
    // With prompt enhancement the image was generated from the rewritten prompt: keep it beside the request.
    const used = result.metadata?.parameters?.prompt;
    if (resolved.parameters.expandPrompt && typeof used === 'string' && used.trim())
      parameters.expanded_prompt = used.slice(0, 16000);
    delete parameters.prompt;
    const record = {
      ...(pending.media !== 'image' ? { mediaType: pending.media } : {}),
      provider: 'native',
      id: this.job.id,
      conversationId: pending.conversationId,
      // The call it answers (0.6.82): its conversation finds it by it when the page that asked is gone.
      ...(pending.call?.id ? { callId: pending.call.id } : {}),
      workflowId: pending.args.workflow_id,
      workflowName: workflow.name,
      // Verbs without a prompt (upscale, interpolate) are labelled by what was done to which source.
      prompt:
        resolved.parameters.prompt ||
        [pending.call.function.name, ...pending.references.map(ref => ref.label)].join(' · '),
      parameters,
      createdAt: new Date().toISOString(),
      outputs: result.outputs.map(source => ({ source, ...sizeOf(source) })),
    };
    const persist = this.persist();
    let saved;
    try {
      saved = await this.gallery.put(record, { persist });
    } catch (error) {
      if (!persist) throw error;
      this.job.warning = `Historique de l’image non enregistré : ${error.message} Les liens restent disponibles dans cette session.`;
      saved = await this.gallery.put(record, { persist: false });
    }
    // Its sheet goes into its own file (16/11): the image, the clip or the sound says by itself what
    // made it, whatever its name becomes. With its number of take, known now. Never fatal: it is made.
    if (this.stamp)
      try {
        await this.stamp(saved);
      } catch (error) {
        console.error('Fiche de la création non écrite dans son fichier :', error.message);
      }
    return saved;
  }

  /** Size on disk of the chat model and of its vision projector: about what they take once loaded. */
  async #chatBytes() {
    // A remote chat model comes back to no memory of this computer.
    if (this.engine.local === false) return 0;
    const config = this.engineConfig?.() ?? {};
    let total = 0;
    for (const path of [config.modelPath, config.projectorPath])
      if (typeof path === 'string' && path)
        try {
          total += (await stat(path)).size;
        } catch {}
    return total;
  }

  /**
   * Releases the generator, then reloads the chat model unless `reload` is false; a failed
   * release blocks the GPU until recover().
   */
  async #handBackGpu(job, client, media, signal, reload = true) {
    job.executionError = job.error || '';
    // The creation itself is there, or nothing is: the picture so far has had its time.
    job.preview = null;
    // The Studio goes on without the chat model, and its next creation is most often made by
    // the same models: after a success they stay on the card, and only the copies of the
    // sources are removed. yieldGpu() gives the card back when the chat model is wanted.
    const keep = !reload && !job.error && !this.closing;
    if (keep) {
      // Kept when the generator says so: it lets go by itself when main memory is short.
      const left = await client.free({ keep: true, signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS) }).catch(() => null);
      if (left?.kept) this.#keep(client);
      else {
        clearTimeout(this.keepTimer);
        this.kept = null;
      }
    } else {
      job.state = 'releasing';
      job.progress = 'Libération du moteur de génération…';
      job.clock?.mark('releasing');
    }
    let released = false;
    if (!keep)
      try {
        // What an earlier creation of the Studio left loaded goes too: it may sit in the other
        // engine than the one that ran this job.
        await this.yieldGpu();
        // The chat model comes back next: the generator is told how much memory that takes.
        await client.free({ signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS), reserve: await this.#chatBytes() });
        released = true;
        this.gpuBlocked = false;
      } catch (error) {
        this.gpuBlocked = true;
        job.error = `${job.error || ''} Libération du moteur de génération non confirmée : ${error.message}`.trim();
      }
    if (released && reload && !this.closing) {
      job.state = 'restarting';
      job.progress = 'Rechargement du modèle et de la vision…';
      job.clock?.mark('restarting');
      try {
        await this.#startChat();
      } catch (error) {
        job.error = `${job.error || ''} ${error.message}`.trim();
      }
    }
    job.state = job.error ? (signal.aborted ? 'cancelled' : 'error') : 'done';
    job.progress =
      job.error ||
      { video: 'Vidéo prête pour vérification.', audio: 'Son prêt à écouter.' }[media] ||
      'Image prête pour vérification.';
    if (job.state === 'done' && job.clock && job.timingKey)
      await this.timing?.save(job.timingKey, job.clock.timeline()).catch(() => {});
  }

  async recover() {
    if (this.closing || !this.gpuBlocked || !this.job || !['error', 'cancelled'].includes(this.job.state))
      throw problem('Aucune libération à reprendre.', 409);
    const job = this.job;
    job.state = 'releasing';
    let finish;
    this.finished = new Promise(resolve => {
      finish = resolve;
    });
    try {
      await this.clientFactory().free({ signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS) });
      this.gpuBlocked = false;
      job.error = job.executionError || '';
      job.state = job.error ? (job.controller.signal.aborted ? 'cancelled' : 'error') : 'done';
      job.progress = job.error || 'GPU libéré. Le modèle peut redémarrer.';
      return this.status();
    } catch (error) {
      job.state = 'error';
      job.error = error.message;
      throw error;
    } finally {
      finish();
    }
  }

  cancel({ requestId, jobId } = {}) {
    const held = requestId && !jobId ? this.pending.get(requestId) : null;
    if (held) {
      this.pending.delete(requestId);
      // A proposal of a series let go (refused, stopped, left out for an image the user named): the
      // series ends with it, its prompts are not kept, and the chat model it left out comes back.
      if (held.series) void this.endSeries({ series: held.series });
      return this.status();
    }
    if ((requestId && this.job?.requestId !== requestId) || (jobId && this.job?.id !== jobId))
      throw problem('Cette génération n’est plus la tâche courante.', 409);
    this.job?.controller.abort();
    return this.status();
  }

  async close() {
    this.closing = true;
    clearTimeout(this.owedTimer);
    this.cancel();
    await this.finished;
    await this.yieldGpu();
  }
}
