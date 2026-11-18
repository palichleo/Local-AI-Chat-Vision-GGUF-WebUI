import { FORMATS, formatOf, nearestFormat, nearestSize, sizeFits, sizesFor } from './formats.mjs';
import { healThumbnail, thumbnailOf } from './thumbnails.mjs';
import { livePreview } from './live-preview.mjs';
import { takeFlux } from './take-flux.mjs';
import { outputActions } from './output-actions.mjs';
import { setupPointer } from './studio-pointer.mjs';
import { closePopup, openPopup } from './glass-menu.mjs';
import { fileInfo } from './media-info.mjs';
import { forgetCitedTakes } from './cited-takes.mjs';
import { elapsedClock } from './generation-time.mjs';

/**
 * The Studio: the creation tools of the conversation, beside the chat. Four blocks that never
 * move, each in the colour of its function: Entrée (blue), the preview and « Générer » (red),
 * Réglages (green), Sortie (yellow). Image, Vidéo or Son is chosen at the top left.
 *
 * The user sets everything and « Générer » is the confirmation. Moodix AI may set the Studio
 * too: a creation it proposes in the chat comes here, its pointer sets what its workflow leaves
 * to the assistant, and it stops on « Générer »: the user's click is the answer.
 */
const MODES = [
  {
    id: 'image',
    verb: 'create_image',
    label: 'Image',
    icon: 'image',
    output: 'Images',
    none: 'Aucune image pour l’instant',
  },
  {
    id: 'video',
    verb: 'create_video',
    label: 'Vidéo',
    icon: 'video',
    output: 'Timeline',
    none: 'Aucune vidéo pour l’instant',
  },
  { id: 'audio', verb: 'create_audio', label: 'Son', icon: 'wave', output: 'Sons', none: 'Aucun son pour l’instant' },
];
const MODE_OF_VERB = {
  create_image: 'image',
  create_video: 'video',
  extend_video: 'video',
  replace_character: 'video',
  create_audio: 'audio',
};
const ROLES = {
  source: 'Image à modifier',
  start_image: 'Image de début',
  end_image: 'Image de fin',
  reference: 'Référence',
};
// Each input image says what it is with a picto, never a word (moodix-design.md 13): its name is
// in its tooltip and for screen readers. A reference shows « @ », and « @1 » once given.
const PICTO = { source: 'edit', start_image: 'start', end_image: 'end' };
const ADD = {
  source: 'Ajouter l’image à modifier',
  start_image: 'Ajouter l’image de début',
  end_image: 'Ajouter l’image de fin',
};
const SETTINGS = {
  lyrics: 'Paroles',
  seconds: 'Durée (s)',
  language: 'Langue',
  subject: 'Qui remplacer',
  reference_subject: 'Qui dessiner',
  denoise: 'Débruitage',
};
// What the values of a setting on a bar do, said under it (measured on Krea 2, 17/11).
const BAR_HELP = { denoise: '0,6 garde la composition et change l’ambiance ; 0,7 laisse la composition changer.' };
// Why a setting the model only reads with an input is greyed while the case of that input is empty.
const ONLY_WITH = { source: 'Sert seulement avec une image à modifier.' };
// The settings on a bar that « Enregistrer » keeps for a model (lib/studio-presets.mjs checks each).
const KEPT_SETTINGS = ['denoise'];
// Who is who, for a character put in a video: said in a few words beside the inputs, not
// among the rare settings. Read by a detector that knows English words.
const WHO = {
  subject: {
    hint: 'girl, handkerchief',
    help:
      'La personne ou l’animal de la vidéo à remplacer, en quelques mots d’anglais : « girl », « penguin », ' +
      'ou « man in red jacket » quand la vidéo montre plusieurs personnes.\n' +
      'Après une virgule, un objet qu’elle tient reste tel quel : « girl, handkerchief ».\n' +
      '« person » suffit quand il n’y a qu’une personne.',
  },
  reference_subject: {
    hint: 'woman',
    help:
      'Le personnage à prendre dans l’image, en un ou deux mots d’anglais : « woman », « robot », « cartoon cat ». ' +
      'Le décor de l’image est laissé de côté.\n' +
      '« person » suffit pour un humain.',
  },
};
const VIDEO_TYPES = ['video/mp4', 'video/webm'];
const SETTING_HELP = { lyrics: 'Vide pour un morceau instrumental. Balises : [Verse], [Chorus], [Bridge]…' };
const MAX_STYLES = 3;
// The three formats shown under the preview; « ··· » opens all of them.
const MAIN_FORMATS = ['1:1', '16:9', '9:16'];
// The key that goes with Entrée to generate, as the keyboard names it.
const MODIFIER = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl';
const strengthText = value => (Math.round(value * 100) / 100).toFixed(2).replace('.', ',');
/**
 * A decimal setting between two close bounds (the denoise of Krea 2, 0.6 to 0.7): the Studio shows
 * it on a bar, by hundredths. A wider one, or a whole number, keeps its field.
 */
const fineSetting = setting =>
  setting.type === 'number' &&
  !setting.choices &&
  Number.isFinite(setting.min) &&
  Number.isFinite(setting.max) &&
  setting.max > setting.min &&
  setting.max - setting.min <= 1;
/** A value of such a setting within its bounds, at a hundredth; its default when there is none. */
function fineValue(setting, value) {
  const given = value === undefined || value === null || value === '' ? (setting.default ?? setting.min) : value,
    number = Number(given);
  if (!Number.isFinite(number)) return setting.min;
  return Math.round(Math.min(setting.max, Math.max(setting.min, number)) * 100) / 100;
}
/**
 * Whether a setting is read with these inputs (`roles`: their roles, as the family names its slots):
 * one the engine only reads with an input (`onlyWith`: the denoise of Krea 2 with an image to
 * modify) is none of a creation made without it, whose record then says another value (1).
 */
const onlyRoles = setting => (setting.onlyWith ? (setting.onlyWith.roles ?? [setting.onlyWith.role]) : []);
const settingRead = (setting, roles) => !setting.onlyWith || onlyRoles(setting).some(role => roles.includes(role));
/**
 * The case of the input a setting is only read with (by the role the Studio gives that input:
 * `inputs` of its workflow), or null for a setting read whatever the inputs.
 */
const onlyInputs = (workflow, setting) => onlyRoles(setting).map(role => workflow.inputs?.[role] ?? role);
const onlyRole = (workflow, setting) => onlyInputs(workflow, setting)[0] ?? null;
/** The settings on a bar of a model that « Enregistrer » keeps. */
const keptSettings = workflow =>
  (workflow.settings ?? []).filter(setting => KEPT_SETTINGS.includes(setting.key) && fineSetting(setting));
const leaf = name =>
  String(name)
    .split(/[\\/]/)
    .pop()
    .replace(/\.safetensors$/i, '');
// A length as the Studio writes it everywhere (moodix-design.md 27): two figures before the
// point, two after (« 05.17 s »); in capitals on the screen (« 05.17 S »). The value is the true
// one, from the frames the model makes (5 s asked can be 5.17 s made).
const twoFigures = value => (Math.round(Number(value) * 100) / 100).toFixed(2).padStart(5, '0');
// A length as everywhere: « 05.17 S » (16/11: no small « s » in the settings any more).
const seconds = value => twoFigures(value) + ' S';
// The name a slot shows while something that it takes is carried (studio-maquette.md, « Glisser »).
const SHORT = { start_image: 'Début', end_image: 'Fin', reference: 'Réf.', source: 'Image', source_video: 'Vidéo' };
const figures = value => twoFigures(value) + ' S';
/** The length of a sound in the Sortie (capture 23): « 08.00 S », « 1:45 » from a minute. */
const soundFigures = value => {
  const total = Math.round(Number(value));
  return total >= 60 ? Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0') : figures(value);
};
const sizeKey = size => size.width + 'x' + size.height;
// The box the format frame fits in before its stage is laid out.
const FRAME = { width: 264, height: 176 };
// The tools of the Studio are read again in the background past this age.
const TOOLS_TTL_MS = 60000;

/** The frame of a ratio, as large as its box allows. */
export function frameSize(ratio, box = FRAME) {
  return ratio >= box.width / box.height
    ? { width: box.width, height: Math.round(box.width / ratio) }
    : { width: Math.round(box.height * ratio), height: box.height };
}

/** The sizes offered for a workflow in a format (those of its family: Krea 2's), and the one closest to `pixels`. */
export function sizeChoices(workflow, formatId, pixels) {
  const format = FORMATS.find(item => item.id === formatId),
    sizes = format ? sizesFor(format, workflow.limits, workflow.family) : [];
  return { sizes, nearest: nearestSize(sizes, pixels) };
}

/**
 * Whether the size in a draft (« 1920x1080 ») is one the workflow makes in the format of that draft,
 * listed or not: a size a take or a proposal was made at (0.6.92).
 */
function madeSize(workflow, draft) {
  const [width, height] = /^\d+x\d+$/.test(draft.size ?? '') ? draft.size.split('x').map(Number) : [];
  return sizeFits({ width, height }, workflow.limits) && nearestFormat(width, height)?.id === draft.format;
}

/** The formats under the preview: the three main ones, and the one chosen when it is another (it takes the place of « ··· »). */
export function shownFormats(available, chosen) {
  const main = MAIN_FORMATS.filter(id => available.includes(id));
  return { main, extra: chosen && !main.includes(chosen) && available.includes(chosen) ? chosen : null };
}

/**
 * What a proposal of Moodix AI sets, in the Studio's terms: the workflow, the prompt, the size,
 * the length, the seed, the settings and the inputs; and what of it the assistant may change
 * (the parameters its workflow leaves to « Assistant »). The rest is shown as it will be made.
 */
export function proposedValues(request, offered = []) {
  const plan = request.plan || {},
    parameters = plan.parameters || {},
    editable = plan.editable || {},
    items = new Map((editable.parameters || []).map(item => [item.key, item])),
    free = key => items.has(key) && !items.get(key).locked,
    workflow = offered.find(item => item.name === request.workflowName) ?? offered[0] ?? null,
    references = plan.references || [],
    source = references.find(ref => ref.role === 'source_video'),
    fps = parameters.fps > 0 ? parameters.fps : null,
    overlap = source && Number.isFinite(parameters.overlap_frames) ? parameters.overlap_frames : 0,
    width = parameters.width ?? request.resolution?.width,
    height = parameters.height ?? request.resolution?.height;
  const settings = {},
    roles = references.map(ref => ref.role);
  // (Not a setting read only with an input the proposal does not have: the Studio keeps its own.)
  for (const setting of workflow?.settings ?? [])
    if (parameters[setting.key] !== undefined && settingRead(setting, roles))
      settings[setting.key] = parameters[setting.key];
  return {
    verb: request.tool || request.call?.function?.name || 'create_image',
    workflow: workflow?.id ?? null,
    prompt: String(plan.prompt ?? request.args?.prompt ?? ''),
    promptFree: Boolean(editable.prompt),
    size: width > 0 && height > 0 ? sizeKey({ width, height }) : null,
    // (Of a ratio no format is close to, the nearest one, 0.6.92: the format in hand stayed beside its size.)
    format: nearestFormat(width, height)?.id ?? null,
    sizeFree: free('width') && free('height'),
    seconds: fps && Number.isFinite(parameters.frames) ? Math.max(0, parameters.frames - overlap) / fps : null,
    frames: parameters.frames ?? null,
    fps,
    overlap,
    framesFree: free('frames'),
    framesChoices: items.get('frames')?.choices ?? null,
    seed: Number.isFinite(parameters.seed) ? parameters.seed : null,
    seedFree: free('seed'),
    stage: plan.stage ?? null,
    settings,
    settingsFree: Object.fromEntries(Object.keys(settings).map(key => [key, free(key)])),
    references: references.filter(ref => ref.role !== 'source_video'),
    // The LoRAs of the workflow it switches on, with their strength (the others are off).
    loras: Array.isArray(plan.loras) ? plan.loras : null,
    roleChoices: editable.references || [],
    source: source?.output_id ?? null,
    // The clip continued is a file of the disk kept as a reference of the project (« #ref1 »), not a take.
    sourceResource: source && !source.output_id ? (source.resource_id ?? null) : null,
    sourceLabel: String(source?.label ?? ''),
  };
}

/** A count of results, written like the choice beside it: « 1 résultat », « 3 résultats ». */
export function resultCount(count) {
  return count ? `${count} résultat${count > 1 ? 's' : ''}` : '';
}

export function setupStudio({
  api,
  node,
  icon,
  notice,
  assets,
  viewOutput,
  waitForModel,
  blocked,
  onChange,
  // Called with the place whose creations were read again (the conversation, or the former Studio).
  onRuns = () => {},
  // The conversation the page shows: its id, or null before its first message or creation. The
  // Studio works in it, unless it holds a work of another one (`conversation()` below, 0.6.81).
  conversation: shownConversation = () => null,
  // The project of that conversation: its Sortie shows the creations of all its conversations.
  project: shownProject = () => 'inbox',
  // An id for the conversation, created when it has none yet: a creation belongs to it.
  ensureConversation = async () => shownConversation(),
  // (0.6.81) A creation made here begins (its conversation) or ends (null): the page follows it,
  // whatever page the user opens meanwhile.
  onWork = () => {},
  // Whether a creation of its own may begin (0.6.90): false when the user said no to what it costs.
  mayBegin = () => true,
  // Why nothing can be made now, in the user's words: a work goes on in another conversation; ''.
  elsewhere = () => '',
  // The name of a conversation, said where the Studio is held by it.
  nameOf = () => '',
  // The few seconds the pointer of Moodix AI sets the Studio begin (true) or end (false).
  onLock = () => {},
  // Runs an approved proposal in the conversation and writes it there; the result of the
  // generation. Without it, the Studio follows the job itself and nothing is written.
  run = null,
  // Brings the Studio on screen: a proposal of Moodix AI arrives.
  reveal = () => {},
  // Stops the turn of the chat that a generation approved here belongs to.
  stopTurn = () => {},
  // Another conversation is open.
  onConversation = () => {},
  // Resolves once the page has stopped moving (a change of view): drawing the Studio again then
  // made the movement stutter.
  afterMove = () => Promise.resolve(),
  // The pace of the pointer: 1 as it is seen, 0 at once (the tests).
  pace = 1,
  // The last generation left the card held (its engine did not say it let it go): « Libérer le GPU ».
  gpuBlocked = () => false,
  recoverGPU = async () => {},
  // The mark of Moodix AI drawn with a mask of its own (app.js, moodixMark): it breathes.
  mark = null,
  // « Agent »: opens the chat of Moodix AI, as the band at the foot of the Studio did.
  openAgent = () => {},
  // Brings the Studio on screen (as « Studio » of the sidebar does): a mode chosen from elsewhere.
  openStudio = () => {},
}) {
  const $ = id => document.getElementById(id);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms * pace));
  let info = null,
    mode = 'image',
    runs = [],
    nextTake = null, // the number the next take of the project will have (the server's counter)
    legacyRuns = [],
    legacy = false, // the Sortie shows, and the Studio works in, the Studio of before Moodix
    working = null, // { label, fraction, preview, controller | external } while a generation runs
    busyDrawn = '', // why a work of the page greys « Générer », as last drawn (busyChanged)
    // A creation just over, its takes read again: the Studio still holds its conversation (holds),
    // or a status read meanwhile let it go (letGo) and its take went on the screen of the one shown.
    settling = false,
    releasing = null, // the chat model leaving the GPU, asked once the user sets the Studio
    released = false,
    enriching = false,
    extending = null, // the clip being continued
    failure = '',
    advanced = false, // « Plus de réglages » is open
    formatsOpen = false, // « ··· » is open
    drawn = null, // the size the frame was last drawn at, to ease from
    watching = null, // follows the size of the stage
    laidOut = false, // the stage was in sight at the last look: its screen eases to a new shape
    live = null, // { frame, preview } : the picture so far, in the frame now on the page
    flux = null, // { frame, flux }: the Flux of the take being made, in the frame now on the page
    proposal = null, // a proposal of Moodix AI waiting for « Générer »
    checking = null, // { record, resolve }: the character Moodix AI made, waiting for the user
    ai = null, // { stopped, active, touched } while the pointer sets the Studio
    seenConversation, // the conversation the creations were read for
    runsFor, // the place (conversation, or the former Studio) they were read from
    runsStale = false, // something was made elsewhere since
    loading = null, // the tools being read
    unreadable = '', // why the tools could not be read, while they are not
    sketched = false, // the blocks were drawn empty while the tools were read: what comes fades in
    toolsAt = 0,
    toolsStale = false,
    shownMedia = null, // { key, element }: what the screen shows, kept from one drawing to the next
    draftsKey = null, // the conversation whose settings are in the Studio (draftKey)
    // 0.6.81: a work held here (a take made, a proposal of Moodix AI, a character checked) keeps the
    // Studio in the conversation it began in, { conversation, project }, while the page shows
    // another one, where it is said held; it is that conversation's again when the work ends (letGo).
    heldIn = null;
  /** Whether the Studio holds a work: a take being made, a proposal waiting, a character checked. */
  // (`settling`: a creation just over, until its take is on the screen of its own conversation, 0.6.87.)
  const holds = () => Boolean(working || proposal || checking || ai || settling);
  /** The conversation the Studio works in, and its project: the page's, unless it holds a work of another. */
  const conversation = () => (heldIn ? heldIn.conversation : shownConversation());
  const project = () => (heldIn ? heldIn.project : shownProject());
  /** The page shows another conversation than the one whose work the Studio holds. */
  const away = () => Boolean(heldIn) && heldIn.conversation !== shownConversation();
  /** A work begins here, in the conversation shown (`id` once it has one): always on screen then. */
  function holdAt(id = shownConversation()) {
    heldIn = { conversation: id, project: shownProject() };
  }
  /** The work held here is over: left meanwhile, the Studio goes to the conversation shown. */
  function letGo() {
    if (!heldIn || holds()) return;
    const left = away();
    heldIn = null;
    if (left) conversationChanged();
  }
  // The Studio as each conversation was left (its mode, its drafts) with the newest take it had
  // then: it comes back so, unless a take was made in it since (16/11).
  const leftDrafts = new Map();
  // Per conversation, the newest take the Studio was set from, or made itself (settle).
  const lastSeen = new Map();
  // Counts the conversations the drafts were handed to (conversationChanged): the drafts are the
  // same objects from one conversation to the next, so what was asked for one and comes back later
  // (a prompt being improved, a file being imported) is told apart by this count, and not written.
  let draftsEpoch = 0,
    // The count when « Améliorer le prompt » was asked: it holds settle for its own conversation only.
    enrichEpoch = -1;
  // The take opened from the chat on the screen (« Afficher dans le Studio »): it stays there.
  let pinned = null,
    // A creation put on the screen to see what made it (inspect): the Studio as it was before, to
    // come back to with the button at the right of « Image · Vidéo · Son ».
    looked = null,
    // The address made for a file shown from the disk itself (a sound), to give back.
    lookedUrl = '';
  // What is shown on the screen for each mode: the last creation, or one opened from the chat.
  const kept = {};
  const blank = () => ({
    workflow: null,
    prompt: '',
    before: null, // what was typed before « Enrichir le prompt », to come back to
    styles: [],
    shelved: {}, // the LoRAs of the other families of models, for the way back
    workflowLoras: {}, // per workflow, its own LoRAs: { id: { on, strength } }
    format: null,
    size: null,
    seed: '',
    length: null,
    extension: null,
    inputs: {},
    settings: {},
    lyrics: false, // the lyrics are shown (« + Paroles »)
  });
  const drafts = Object.fromEntries(MODES.map(item => [item.id, blank()]));
  const picker = node('input');
  picker.type = 'file';
  picker.accept = 'image/png,image/jpeg,image/webp';
  picker.hidden = true;
  $('studio-view')?.append(picker);
  const cursor = $('ai-cursor'),
    pointer = cursor ? setupPointer({ cursor, text: $('ai-cursor-text') ?? cursor }) : null;

  const modeOf = id => MODES.find(item => item.id === id);
  /**
   * The models of a verb; without one, those the mode in hand offers: its own and, for a video,
   * those that put a character in an existing one (chosen in the same list, they bring their
   * own inputs).
   */
  const offered = verb => {
    if (verb) return info?.tools?.[verb] ?? [];
    if (mode === 'video' && extending) return info?.tools?.extend_video ?? [];
    const list = info?.tools?.[modeOf(mode).verb] ?? [];
    return mode === 'video' ? [...list, ...(info?.tools?.replace_character ?? [])] : list;
  };
  const verbOf = () => (mode === 'video' && extending ? 'extend_video' : (current()?.verb ?? modeOf(mode).verb));
  const place = () => (legacy ? (info?.legacyId ?? null) : conversation());
  function current() {
    const draft = drafts[mode],
      list = offered(),
      // A model this computer cannot run (`unavailable`, its reason) is shown greyed: it is the
      // one in hand only when no other can be.
      usable = list.filter(item => !item.unavailable),
      first = usable[0] ?? list[0] ?? null;
    // A continuation stays with the workflow that made the clip when it can. A clip of the disk was
    // made by none of them: the one chosen here (in the list, or by the proposal just answered).
    if (mode === 'video' && extending && !proposal)
      return usable.find(item => item.id === (extending.workflowId ?? draft.workflow)) ?? first;
    return usable.find(item => item.id === draft.workflow) ?? first;
  }
  // A proposal of Moodix AI is answered from its own mode: the others still work by hand.
  const answering = () => Boolean(proposal && proposal.mode === mode && !working);
  /**
   * Another model for this mode. A LoRA is made for one family of models: those chosen for
   * Krea 2 do not follow to MOSS Image (they were sent with it), and come back with Krea 2.
   */
  function choose(id) {
    const draft = drafts[mode],
      from = current()?.family,
      to = offered().find(item => item.id === id)?.family;
    if (from !== to) {
      draft.shelved[from] = draft.styles;
      draft.styles = draft.shelved[to] ?? [];
    }
    draft.workflow = id;
    // Its saved settings come back with it (« Enregistrer »), those its workflow leaves free.
    const chosen = current();
    if (chosen) applyPreset(chosen);
    render();
  }
  const button = (className, text, onclick, glyph) => {
    const control = node('button', className);
    control.type = 'button';
    if (glyph) control.append(icon(glyph));
    if (text) control.append(node('span', '', text));
    control.onclick = onclick;
    return control;
  };
  // « Agent », left of « Générer » (moodix-design.md 15 bis): the chat of Moodix AI opens from it as
  // it did from the band at the foot. Made once and moved from one drawing to the next: the move
  // between the chat and the Studio folds the chat into it (view transition, moodix.css).
  const agent = button('studio-agent', '', () => openAgent(), mark ? null : 'eclipse');
  if (mark) agent.append(mark());
  agent.id = 'agent-open';
  agent.title = 'Moodix AI · ouvrir le chat';
  agent.setAttribute('aria-label', 'Moodix AI · ouvrir le chat');
  agent.setAttribute('aria-controls', 'chat-panel');
  // Its word leaves when the bar is just too narrow for one line (moodix.css): its name stays. No
  // colour along its foot (moodix-design.md 7 bis 22: the colour goes to Générer); a light runs
  // there while Moodix AI writes with the chat folded.
  const light = node('span', 'studio-agent-light');
  light.setAttribute('aria-hidden', 'true');
  agent.append(node('span', 'studio-agent-word', 'Agent'), light);
  // The actions of the take on the screen, at the left of the bar (studio-maquette.md): the same
  // icons and the same help as in the conversation (output-actions.mjs), without « Ouvrir ».
  const takeActions = outputActions({
    api,
    node,
    icon,
    onDetails: null,
    onAction: (record, index, id) => takeAction(record, id),
  });
  // Image · Vidéo · Son: drawn in the head of the screen, put back above it when there is none.
  let kindsEl = null;
  const kindsBar = () => (kindsEl ??= $('studio-kinds'));
  // The setting Moodix AI is changing wears a ring, those it has set a fine trace, while it works.
  // Once it has stopped, nothing is framed any more. (0.6.92: no mark on the settings it may change
  // any more; there would be one on almost every setting.)
  function aiTarget(element, key) {
    element.dataset.ai = key;
    if (ai?.active === key) element.setAttribute('data-ai-active', '');
    if (ai?.touched.has(key)) element.setAttribute('data-ai-touched', '');
    return element;
  }
  function field(label, control, { help, tip, wide = false } = {}) {
    const wrapper = node('label', 'studio-field' + (wide ? ' is-wide' : '')),
      title = node('span', 'studio-label', label);
    // « ? » at the right of the name: its help at once under the pointer or on focus, as in the
    // settings (public/help-tips.mjs). A click on it does not go to the field.
    if (tip) {
      const ask = node('span', 'help-tip studio-tip', '?');
      ask.tabIndex = 0;
      ask.setAttribute('role', 'img');
      ask.setAttribute('aria-label', 'Aide : ' + tip);
      ask.dataset.help = tip;
      ask.onclick = event => event.preventDefault();
      title.append(ask);
    }
    wrapper.append(title, control);
    if (help) wrapper.append(node('small', 'field-help', help));
    return wrapper;
  }
  function select(choices, value, onchange) {
    const control = node('select');
    for (const [key, text] of choices) control.add(new Option(text, String(key)));
    control.value = String(value);
    control.onchange = () => onchange(control.value);
    return control;
  }
  function textarea(value, rows, placeholder, oninput) {
    const control = node('textarea');
    control.rows = rows;
    control.value = value;
    control.placeholder = placeholder;
    control.oninput = () => oninput(control.value);
    return control;
  }
  /** The head of a block: no title (the colour says the function), only what it holds. */
  function blockHead(title, { extra } = {}) {
    const head = node('div', 'studio-block-head');
    if (title) head.append(node('h2', 'sr-only', title));
    if (extra) head.append(extra);
    return head;
  }

  // ------------------------------------------------------------------ inputs (images)
  function exclusiveWith(workflow, role) {
    // The other inputs this one cannot be combined with, when one of them is filled.
    const groups = workflow.exclusive ?? [],
      own = groups.find(group => group.includes(role));
    if (!own) return [];
    // Only the inputs this request sends: a start image chosen for a new clip is not part of
    // its continuation.
    return groups
      .filter(group => group !== own)
      .flat()
      .filter(other => workflow.roles[other]?.count && drafts[mode].inputs[other]?.some(Boolean));
  }
  async function fill(role, index, file, media = 'image') {
    if (!file) return;
    if (media === 'video' && !VIDEO_TYPES.includes(file.type))
      return notice('Cette case attend une vidéo MP4 ou WebM.');
    if (media === 'image' && VIDEO_TYPES.includes(file.type))
      return notice('Cette case attend une image, pas une vidéo.');
    const epoch = draftsEpoch,
      asked = mode;
    // Kept as a reference of the project (« #ref3 »), shared with its chats.
    const imported = await assets.importFiles([file], { project: project() });
    if (!imported.length)
      return notice(
        (media === 'video' ? 'Vidéo non importée' : 'Image non importée') +
          ' : la bibliothèque est occupée ou le fichier est illisible.',
      );
    // Its copy took a moment (a clip): another conversation or another mode is shown by now, or
    // Moodix AI proposes there. The slot of that name on the page is no longer the one it was given
    // to (a clip dropped on « Vidéo à suivre » became the image to modify of Image): not placed.
    if (epoch !== draftsEpoch || asked !== mode || answering())
      return notice(
        (media === 'video' ? 'Vidéo gardée' : 'Image gardée') +
          ' dans les références du projet, mais pas placée : ' +
          (epoch === draftsEpoch && asked === mode
            ? 'Moodix AI propose une création ici.'
            : 'la conversation ou le mode a changé entre-temps. Déposez-la de nouveau dans sa case.'),
      );
    const [resource] = imported;
    (drafts[mode].inputs[role] ??= [])[index] = {
      source: { resource: resource.id },
      preview: resource.previewUrl || resource.originalUrl,
      name: `${resource.label} · ${resource.name}`,
      width: resource.width,
      height: resource.height,
    };
    followFormat(role);
    render();
  }
  /** A video takes the format of the image it starts from, unless the user chose one. */
  function followFormat(role) {
    const draft = drafts[mode],
      image = draft.inputs[role]?.[0];
    if (mode !== 'video' || role !== 'start_image' || !image?.width || draft.formatChosen) return;
    const format = formatOf(image.width, image.height);
    if (format) Object.assign(draft, { format: format.id, size: null });
  }
  // The take the pointer of Moodix AI carries: { id, role, index, preview, over } (over: above its case).
  let aiCarry = null;
  // While Moodix AI sets the Studio, the whole Studio is locked (16/11): no click, no key, no drop
  // reaches it (inert), and nothing stops the pointer. It is the user's again when the pointer rests
  // on « Générer » (settings, « Refuser », « Générer »), or when the proposal goes.
  let aiWorking = false;
  // The last picture of a take in progress: veiled on the screen when the card stays held (54).
  let seenPreview = '';
  // « GPU libéré. Le modèle peut redémarrer. » in place of the step, until then (54).
  let freedUntil = 0;
  function lockStudio(on) {
    const changed = aiWorking !== on;
    aiWorking = on;
    const view = $('studio-view');
    if (view) view.inert = on;
    // The page holds its places too meanwhile (0.6.81): the pointer sets the Studio on screen.
    if (changed) onLock(on);
  }
  // The slot an image is being dragged from: dropped on another, the image changes role.
  let dragged = null,
    // A creation of the Sortie dragged to a slot: it becomes that input.
    carried = null;
  /**
   * While something is carried, the slots that take it light up and say their name (moodix.css;
   * studio-maquette.md, « Glisser ») : `media`, what is carried, or null once it is dropped.
   */
  function carrying(media) {
    const desk = globalThis.document?.querySelector?.('#studio-view .studio-desk');
    if (media) desk?.setAttribute?.('data-carrying', media);
    else desk?.removeAttribute?.('data-carrying');
  }
  /** The file of the computer for a slot: what a click on it opens, empty or filled. */
  function openPicker(role, index, media) {
    picker.accept = (media === 'video' ? VIDEO_TYPES : IMAGE_TYPES).join(',');
    picker.onchange = () => {
      const [file] = picker.files;
      picker.value = '';
      void fill(role, index, file, media);
    };
    picker.click();
  }
  // The model each mode showed last: another one, and the blocks of the images say so for a
  // moment (moodix-design.md 21).
  const shownModel = {};
  // « Enregistrer »: the modes whose model showed its saved settings already, what each model
  // showed first (compared with, until it is saved), the floppy disk drawn, and the last saving.
  const presetShown = {},
    baselines = {};
  let saveButton = null,
    savedJust = null;
  let flashUntil = 0,
    flashTimer = null,
    // The line from the start to the end: its colour and its figure follow the duration bar.
    span = null;
  /**
   * The role of the verb an input of the workflow takes, from the name of its slot in the family
   * (« msr_image », « reference_image » → « reference »): said by the workflow (`inputs`), else read
   * from the name. The server names the roles an image of a proposal may take by those slots.
   */
  function roleOfSlot(workflow, name) {
    const named = workflow?.inputs?.[name] ?? (name in (workflow?.roles ?? {}) ? name : String(name).replace(/_image$/, ''));
    return named === 'msr' ? 'reference' : named;
  }
  /**
   * Moves an image to another slot; the two swap when that slot is taken. Refused, with the
   * reason, when the inputs would no longer combine (MiniMax: references, or start and end).
   */
  function move(workflow, from, to) {
    const draft = drafts[mode],
      image = draft.inputs[from.role]?.[from.index];
    if (!image || (from.role === to.role && from.index === to.index)) return;
    const other = draft.inputs[to.role]?.[to.index] ?? null;
    (draft.inputs[to.role] ??= [])[to.index] = image;
    draft.inputs[from.role][from.index] = other;
    const clash = [...exclusiveWith(workflow, to.role), ...(other ? exclusiveWith(workflow, from.role) : [])];
    // An input of a proposal takes only the roles its workflow offers it, while that proposal waits
    // (answered, its images are the user's: releaseInputs). The server lists those roles by the
    // names of the slots (« msr_image »), a case here is named by the role of the verb (« reference »).
    const offeredRoles = proposal?.mode === mode ? proposal.values?.roleChoices : null;
    const refused =
      Boolean(offeredRoles) &&
      [image, other].some(
        item =>
          item?.ref !== undefined &&
          !(offeredRoles[item.ref] ?? []).some(
            choice => roleOfSlot(workflow, choice.role) === (item === image ? to.role : from.role),
          ),
      );
    if (clash.length || refused) {
      draft.inputs[to.role][to.index] = other;
      draft.inputs[from.role][from.index] = image;
      failure = refused
        ? `${ROLES[to.role]} : ce rôle n’est pas possible pour cette image avec ce workflow.`
        : `${ROLES[to.role]} ne se combine pas avec : ${[...new Set(clash)].map(role => ROLES[role]).join(', ')}.`;
    } else {
      failure = '';
      followFormat(to.role);
    }
    render();
  }
  /**
   * One image of the inputs (moodix-design.md 13): dashed while empty, with its picto (« @ » for
   * a reference); given, its picture, the picto kept small in a badge (« @1 »). No word: the name
   * is in its tooltip and for screen readers. A click picks a file; a file dropped on it, or the
   * image of another slot (that changes its role); × takes it back.
   */
  function slot(workflow, role, index, { label, add, tip, picto = null, badge = '', onRemove = null, media = 'image' }) {
    const draft = drafts[mode],
      value = draft.inputs[role]?.[index],
      clash = exclusiveWith(workflow, role),
      refused = clash.length ? `Ne se combine pas avec : ${clash.map(other => ROLES[other]).join(', ')}` : '',
      // The inputs of a proposal are those Moodix AI chose: they change role, not image.
      chosenByAi = answering(),
      // The case the pointer of Moodix AI brings its take to: grown, the take shown in it.
      aiOver = Boolean(aiCarry?.over && aiCarry.role === role && aiCarry.index === index),
      tile = node(
        'div',
        'studio-slot' + (value ? ' is-filled' : '') + (refused ? ' is-blocked' : '') + (aiOver ? ' is-target' : ''),
      );
    tile.dataset.slot = role + '-' + index;
    if (aiOver && aiCarry.preview) tile.style.setProperty?.('--carried', `url("${aiCarry.preview}")`);
    const pick = button('studio-slot-pick', '', () => {
      // An input that does not combine with those given says why. It still takes the image of
      // one of them, dragged here: that is how a role is changed.
      if (refused) return notice(refused);
      if (chosenByAi)
        return notice(
          'Les images de cette proposition sont celles de Moodix AI : demandez-lui dans le chat pour en changer.',
        );
      // A file of the computer, empty or filled (16/11: « Créations du projet » is gone from here; a
      // take of the project is dragged to it from the Sortie).
      openPicker(role, index, media);
    });
    // Named for the hand that carries something here (moodix.css): « FIN », « RÉF. 2 », « REMPLACER ».
    tile.dataset.media = media;
    tile.dataset.name = value ? 'Remplacer' : (SHORT[role] ?? label) + (role === 'reference' ? ' ' + (index + 1) : '');
    pick.title = refused || (value ? label + ' · glissez-la vers un autre emplacement pour changer son rôle' : tip);
    pick.setAttribute('aria-label', value ? label + ' · ' + value.name : refused ? label + ' · ' + refused : add);
    pick.disabled = Boolean(working);
    if (refused) pick.setAttribute('aria-disabled', 'true');
    if (value) {
      const preview = node('img');
      preview.src = value.preview || '';
      preview.alt = value.name;
      // The tile is what is dragged, not the picture as a file of the browser.
      preview.draggable = false;
      if (value.preview) pick.append(preview);
      else pick.append(icon('image'));
      // What the image is, small, at the bottom left of it.
      const mark = node('span', 'studio-slot-badge' + (badge ? ' is-text' : ''), badge);
      mark.setAttribute('aria-hidden', 'true');
      if (!badge && picto) mark.append(icon(picto));
      pick.append(mark);
      pick.draggable = !working;
      pick.ondragstart = event => {
        dragged = { role, index, media, preview: value.preview };
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', label);
        dragGhost(pick, event.dataTransfer, media);
        tile.classList.add('is-dragged');
        carrying(media);
      };
      pick.ondragend = () => {
        dragged = null;
        tile.classList.remove('is-dragged');
        carrying(null);
      };
    } else if (picto) pick.append(icon(picto));
    else {
      const at = node('span', 'studio-slot-at', '@');
      at.setAttribute('aria-hidden', 'true');
      pick.append(at);
    }
    // The whole tile takes a drop: a file from the computer, or the image of another slot.
    tile.ondragover = event => {
      event.preventDefault();
      if (dragged) event.dataTransfer.dropEffect = 'move';
      else if (carried) event.dataTransfer.dropEffect = 'copy';
      tile.classList.add('is-target');
      // It shows what would come in it (studio-maquette.md, « Glisser »).
      const coming = dragged?.preview || (carried && (carried.outputs?.[0]?.thumbUrl || carried.outputs?.[0]?.originalUrl));
      if (coming) tile.style.setProperty?.('--carried', `url("${coming}")`);
    };
    tile.ondragleave = () => {
      tile.classList.remove('is-target');
      tile.style.removeProperty?.('--carried');
    };
    tile.ondrop = event => {
      event.preventDefault();
      event.stopPropagation();
      tile.classList.remove('is-target');
      carrying(null);
      if (working) return;
      if (dragged) {
        const from = dragged;
        dragged = null;
        // A video stays a video: it does not take the place of an image, nor an image its own.
        if (from.media !== media) return notice('Une vidéo et une image n’échangent pas leurs cases.');
        return move(workflow, from, { role, index });
      }
      if (refused) return notice(refused);
      if (chosenByAi) return;
      // A creation of the Sortie: a video in a slot of a video, an image in one of an image.
      if (carried) {
        const record = carried;
        carried = null;
        if (mediaOf(record) !== media)
          return notice(media === 'video' ? 'Cette case attend une vidéo.' : 'Cette case attend une image.');
        return putCreation(record, role, index);
      }
      void fill(role, index, event.dataTransfer.files[0], media);
    };
    tile.append(pick);
    if (value && !chosenByAi) {
      const remove = button(
        'studio-slot-remove',
        '',
        onRemove ??
          (() => {
            draft.inputs[role][index] = null;
            render();
          }),
        'close',
      );
      remove.setAttribute('aria-label', 'Retirer ' + label);
      remove.title = 'Retirer';
      tile.append(remove);
    }
    return tile;
  }
  /** Whether the workflow takes images in this role. */
  const takesImages = (workflow, role) =>
    Boolean(workflow.roles?.[role]?.count && workflow.roles[role].media.includes('image'));
  /** Whether the workflow takes a video in this role (the one a character is replaced in). */
  const takesVideo = (workflow, role) =>
    Boolean(workflow.roles?.[role]?.count && workflow.roles[role].media.includes('video'));
  /** The length set in Réglages, written as everywhere, and its place between the model's ends. */
  function spanLength(workflow) {
    const length = lengthOf(workflow);
    if (!length) return null;
    const low = length.list[0],
      high = length.list.at(-1);
    return { text: seconds(length.value), share: high > low ? (length.value - low) / (high - low) : 1 };
  }
  /**
   * The line from the start to the end, in the colour of the duration bar: the same gradient,
   * spread so that its end is the colour of the length set; the figure in that colour too.
   */
  function paintSpan() {
    if (!span) return;
    const length = spanLength(span.workflow);
    span.time.hidden = !length;
    if (!length) return;
    span.line.style.backgroundSize = 100 / Math.max(length.share, 0.01) + '% 100%';
    span.time.textContent = length.text;
    span.time.style.color = barColour(length.share);
  }
  /** « Inverser début et fin »: the two images change places; the end stays optional. */
  function swapEnds(workflow) {
    const start = { role: 'start_image', index: 0 },
      end = { role: 'end_image', index: 0 };
    if (drafts[mode].inputs.start_image?.[0]) move(workflow, start, end);
    else if (drafts[mode].inputs.end_image?.[0]) move(workflow, end, start);
  }
  /**
   * Bloc Début et fin: the start image at the start of a fine line of time, the end image at its
   * other end (when the model takes one), the length set in Réglages on the line: in its middle,
   * with the button that swaps them, « ⇄ 05.17 s ».
   */
  function framesBlock(workflow) {
    const start = takesImages(workflow, 'start_image'),
      end = takesImages(workflow, 'end_image');
    if (!start && !end) return null;
    const block = node('div', 'studio-input-block studio-frames'),
      row = node('div', 'studio-frames-row'),
      middle = node('div', 'studio-span' + (start && end ? ' is-both' : '')),
      line = node('span', 'studio-span-line'),
      time = node('span', 'studio-span-time');
    block.setAttribute('role', 'group');
    block.setAttribute('aria-label', start && end ? 'Début et fin' : start ? 'Image de début' : 'Image de fin');
    line.setAttribute('aria-hidden', 'true');
    middle.append(line);
    if (start && end) {
      const swap = button('studio-swap', '', () => swapEnds(workflow), 'swap');
      swap.setAttribute('aria-label', 'Inverser début et fin');
      swap.title = 'Inverser début et fin';
      swap.disabled = Boolean(working);
      swap.append(time);
      middle.append(swap);
    } else middle.append(time);
    if (start)
      row.append(
        slot(workflow, 'start_image', 0, {
          label: ROLES.start_image,
          add: ADD.start_image,
          tip: ROLES.start_image + ' · glisser, coller ou cliquer',
          picto: PICTO.start_image,
        }),
      );
    row.append(middle);
    if (end)
      row.append(
        slot(workflow, 'end_image', 0, {
          label: ROLES.end_image,
          add: ADD.end_image,
          tip: ROLES.end_image + (start ? ' (facultatif)' : '') + ' · glisser, coller ou cliquer',
          picto: PICTO.end_image,
        }),
      );
    span = { line, time, workflow };
    paintSpan();
    block.append(node('p', 'studio-input-title', start && end ? 'Début et fin' : start ? 'Image de début' : 'Image de fin'), row);
    return block;
  }
  /**
   * Bloc Références: a tray, no time; each image with its number (« @1 »), one empty slot at a
   * time, and « n/3 » at the end of the line (the model's own most).
   */
  function referencesBlock(workflow) {
    // The character of a video that follows another sits beside that video (sourcesBlock).
    if (!takesImages(workflow, 'reference') || workflow.follows) return null;
    const draft = drafts[mode],
      most = workflow.roles.reference.count,
      // Without holes: the numbers follow each other. What is sent leaves the holes out anyway.
      given = (draft.inputs.reference ?? []).filter(Boolean);
    draft.inputs.reference = given;
    // Those past the model's most stay kept, for a model that takes them.
    const shown = given.slice(0, most),
      block = node('div', 'studio-input-block studio-references'),
      row = node('div', 'studio-references-row'),
      name = place => (most > 1 ? ROLES.reference + ' ' + (place + 1) : ROLES.reference);
    block.setAttribute('role', 'group');
    block.setAttribute('aria-label', most > 1 ? 'Références' : 'Référence');
    shown.forEach((item, place) =>
      row.append(
        slot(workflow, 'reference', place, {
          label: name(place),
          badge: '@' + (place + 1),
          onRemove: () => {
            draft.inputs.reference.splice(place, 1);
            render();
          },
        }),
      ),
    );
    if (shown.length < most)
      row.append(
        slot(workflow, 'reference', shown.length, {
          label: name(shown.length),
          add: most > 1 ? 'Ajouter la référence ' + (shown.length + 1) : 'Ajouter la référence',
          tip: 'Référence : personnage, objet ou décor · glisser, coller ou cliquer',
        }),
      );
    const head = node('p', 'studio-input-title', most > 1 ? 'Références' : 'Référence');
    if (most > 1) {
      const count = node('span', 'studio-references-count', shown.length + '/' + most);
      count.title = shown.length + ' référence' + (shown.length > 1 ? 's' : '') + ' sur ' + most;
      head.append(count);
    }
    block.append(head, row);
    return block;
  }
  /** The image to modify (and any other input image): a slot each, with its picto. */
  function sourcesBlock(workflow) {
    const block = node('div', 'studio-input-block studio-sources'),
      row = node('div', 'studio-sources-row'),
      labels = [];
    for (const [role, spec] of Object.entries(workflow.roles ?? {})) {
      if (['start_image', 'end_image', 'reference'].includes(role)) continue;
      // A continuation: its clip is the one named above the prompt (« Suite du clip »), never asked
      // again in an empty case that « Générer » would not read.
      if (role === 'source' && mode === 'video' && extending) continue;
      // The video a character is replaced in: a slot like an image's, which takes a video.
      const video = takesVideo(workflow, role);
      if (!video && !takesImages(workflow, role)) continue;
      for (let index = 0; index < spec.count; index++) {
        const label = (video ? 'Vidéo à suivre' : (ROLES[role] ?? 'Image')) + (spec.count > 1 ? ' ' + (index + 1) : '');
        labels.push(label);
        row.append(
          slot(workflow, role, index, {
            label,
            add: video ? 'Ajouter la vidéo à suivre' : spec.count === 1 && ADD[role] ? ADD[role] : 'Ajouter : ' + label,
            tip: label + (video ? ' · glisser ou cliquer' : ' · glisser, coller ou cliquer'),
            picto: video ? 'video' : (PICTO[role] ?? 'image'),
            media: video ? 'video' : 'image',
          }),
        );
      }
    }
    // A character put in a video: the video, then who is drawn in it, side by side.
    if (workflow.follows && takesImages(workflow, 'reference')) {
      const draft = drafts[mode];
      draft.inputs.reference = (draft.inputs.reference ?? []).filter(Boolean);
      labels.push('personnage');
      row.append(
        slot(workflow, 'reference', 0, {
          label: 'Personnage',
          add: 'Ajouter l’image du personnage',
          tip: 'Personnage à mettre dans la vidéo · glisser, coller ou cliquer',
          badge: '@',
          onRemove: () => {
            draft.inputs.reference.splice(0, 1);
            render();
          },
        }),
      );
    }
    if (!labels.length) return null;
    // An empty slot says how it is given on hover only (« … · glisser, coller ou cliquer »), as
    // Début, Fin and Références (16/11).
    block.append(node('p', 'studio-input-title', workflow.follows ? 'Vidéo et personnage' : labels.length > 1 ? 'Images' : labels[0]));
    block.setAttribute('role', 'group');
    block.setAttribute(
      'aria-label',
      workflow.follows ? labels.join(' et ') : labels.length > 1 ? 'Images' : labels[0],
    );
    block.append(row);
    return block;
  }
  /**
   * Who is who, for a character put in a video: two short fields in a block of the inputs, the
   * person to replace and the character to draw (the settings `subject` and
   * `reference_subject` of the workflow).
   */
  function whoBlock(workflow) {
    const asked = workflow.settings.filter(setting => WHO[setting.key] && setting.type === 'string');
    if (!asked.length) return null;
    const store = (drafts[mode].settings[workflow.id] ??= {}),
      block = node('div', 'studio-input-block studio-who');
    block.setAttribute('role', 'group');
    block.setAttribute('aria-label', 'Qui est qui');
    for (const setting of asked) {
      const control = node('input');
      control.type = 'text';
      control.value = String(store[setting.key] ?? setting.default ?? '');
      control.placeholder = WHO[setting.key].hint;
      control.spellcheck = false;
      if (setting.maxLength) control.maxLength = setting.maxLength;
      control.disabled = Boolean(working);
      control.oninput = () => {
        store[setting.key] = control.value;
      };
      aiTarget(control, 'setting-' + setting.key);
      block.append(field(SETTINGS[setting.key], control, { tip: WHO[setting.key].help }));
    }
    return block;
  }
  /**
   * The input images, below the prompt: only what the model takes, each kind in its block in the
   * style of the prompt's box (the image to modify; the start and the end; the references, below).
   */
  function inputs(workflow) {
    span = null;
    const blocks = [
      sourcesBlock(workflow),
      framesBlock(workflow),
      referencesBlock(workflow),
      whoBlock(workflow),
    ].filter(Boolean);
    if (!blocks.length) return null;
    // Another model: a light line around them for a moment, which fades (nothing blinks). Drawn
    // again meanwhile, they keep it until the moment is over.
    if (Date.now() < flashUntil) {
      for (const block of blocks) block.className += ' is-flash';
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        const lit = globalThis.document?.querySelectorAll?.('#studio-view .studio-input-block.is-flash') ?? [];
        for (const block of lit) block.classList.remove('is-flash');
      }, flashUntil - Date.now());
    }
    const column = node('div', 'studio-inputs');
    column.append(...blocks);
    return aiTarget(column, 'inputs');
  }

  // ------------------------------------------------------------------ size, length
  /** The formats and sizes a workflow offers, with the draft settled on one of each. */
  function sizing(workflow) {
    const draft = drafts[mode],
      formats = FORMATS.filter(format => sizesFor(format, workflow.limits, workflow.family).length),
      base = workflow.size ?? { width: 1024, height: 1024 };
    if (!formats.some(format => format.id === draft.format))
      draft.format = (formatOf(base.width, base.height) ?? formats[0])?.id ?? null;
    const { sizes, nearest } = sizeChoices(workflow, draft.format, base.width * base.height);
    const proposed = proposal?.mode === mode && proposal.values?.size === draft.size;
    // A size a take or a proposal was made at stays, outside the list too, while the model makes it
    // in the format in hand (0.6.92): replaced by the size of the list nearest to the model's own,
    // the Studio showed 1344 × 768 beside a take of 1920 × 1080 asked in the Chat.
    if (!proposed && !madeSize(workflow, draft) && !sizes.some(size => sizeKey(size) === draft.size))
      draft.size = nearest ? sizeKey(nearest) : null;
    return { formats, sizes, final: workflow.final && sizeKey(workflow.final) };
  }
  /** Draft or final, from the size: a large picture is a final, a small one a draft. */
  function stageOf(workflow, size = drafts[mode].size) {
    if (!workflow?.stages || !size) return null;
    const [width, height] = size.split('x').map(Number),
      small = workflow.size ? workflow.size.width * workflow.size.height : 0;
    return width * height > small * 1.5 ? 'final' : 'draft';
  }
  function lengthOf(workflow) {
    const lengths = workflow.lengths;
    if (!lengths?.seconds.length) return null;
    const draft = drafts[mode],
      key = extending ? 'extension' : 'length',
      nearest = wanted =>
        lengths.seconds.reduce((best, value) => (Math.abs(value - wanted) < Math.abs(best - wanted) ? value : best));
    if (!lengths.seconds.includes(draft[key])) draft[key] = nearest(draft[key] ?? lengths.standard ?? 5);
    return { key, list: lengths.seconds, value: draft[key], nearest };
  }
  // ------------------------------------------------------------------ the bars and blocks of Réglages
  /**
   * The colour of a bar at a place between its ends (0 to 1): the ivory of the room all along
   * (studio-maquette.md, « glissières à poignée ronde »; the four colours of moodix-design.md 12 are
   * those of before).
   */
  function barColour() {
    return 'rgb(238, 232, 222)';
  }
  /**
   * A thin bar (2 px, its handle 8 px) over `count` choices, at `index`: its filled part in the
   * gradient of all the bars, as far as `share(index)` between its ends (the gradient spreads over
   * the whole bar, only the part travelled shows); `notches` for a bar of a few choices, those
   * passed in the colour of their place. Returns the bar and its value, written by `text`.
   */
  function slider({ label, key, count, index, share, text, onInput, notches = false, disabled = false }) {
    const track = node('div', 'studio-bar-track' + (notches ? ' has-notches' : '')),
      bar = node('input', 'studio-bar'),
      value = node('output', 'studio-bar-value', text(index));
    bar.type = 'range';
    bar.min = '0';
    bar.max = String(Math.max(0, count - 1));
    bar.step = '1';
    bar.value = String(index);
    bar.disabled = disabled || Boolean(working);
    bar.setAttribute('aria-label', label);
    if (key) aiTarget(bar, key);
    const marks = [];
    if (notches && count > 1)
      for (let at = 0; at < count; at++) {
        const mark = node('span', 'studio-bar-notch');
        mark.setAttribute('aria-hidden', 'true');
        mark.style.left = `calc(4px + ${at / (count - 1)} * (100% - 8px))`;
        marks.push(mark);
      }
    const show = place => {
      bar.style.setProperty?.('--fill', String(share(place)));
      value.textContent = text(place);
      bar.setAttribute('aria-valuetext', text(place));
      marks.forEach((mark, at) => {
        mark.style.background = at <= place ? barColour(share(at)) : '';
        mark.classList.toggle('is-passed', at <= place);
      });
    };
    show(index);
    bar.oninput = () => {
      const place = Number(bar.value);
      show(place);
      onInput(place);
      paintSave();
    };
    track.append(bar, ...marks);
    return { track, value };
  }
  /** One line « label — thin bar — value » (moodix-design.md 8, 9). */
  function barLine(label, options) {
    const row = node('div', 'studio-bar-line'),
      { track, value } = slider({ label, ...options });
    row.append(node('span', 'studio-bar-label', label), track, value);
    return row;
  }
  /** The choices of a strength, at 0.05 apart between its ends. */
  function strengths(min, max) {
    const list = [];
    for (let step = 0; min + step * 0.05 <= max + 1e-9; step++) list.push(Math.round((min + step * 0.05) * 100) / 100);
    return list;
  }
  // ------------------------------------------------------------------ « Enregistrer »
  /** A value written the same way whatever the order of its keys: settings compared as text. */
  const canonical = value =>
    JSON.stringify(value, (key, item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map(name => [name, item[name]]),
          )
        : item,
    );
  /**
   * What « Enregistrer » keeps for a model (moodix-design.md 7; 7 bis 1): its length, its format
   * and size, its seed, its LoRAs and their strength, as the Studio has them now. Only what the
   * workflow leaves free: a value « Fixe » in Configuration › Workflows is neither kept nor given
   * back (no bar of length, of size or seed is offered for it; its LoRAs keep their switch and
   * strength).
   */
  function snapshot(workflow) {
    const draft = drafts[mode],
      values = {};
    if (workflow.lengths?.seconds.length) values.length = draft[extending ? 'extension' : 'length'];
    if (workflow.limits && workflow.direct && !extending && draft.size)
      Object.assign(values, { format: draft.format, size: draft.size });
    if (workflow.seeded) values.seed = draft.seed.trim();
    if (workflow.styled && mode !== 'audio' && !extending)
      values.styles = draft.styles.filter(style => style.name).map(({ name, strength }) => ({ name, strength }));
    const loras = {};
    for (const lora of workflow.loras ?? []) {
      const free = freeStrength(lora);
      if (!lora.assistant && !free) continue;
      const choice = loraChoice(workflow, lora),
        entry = {};
      if (lora.assistant) entry.on = choice.on;
      if (free) entry.strength = choice.strength;
      loras[lora.id] = entry;
    }
    if (Object.keys(loras).length) values.loras = loras;
    const sound = workflow.settings.find(setting => setting.key === 'seconds' && setting.type === 'number');
    if (sound && !workflow.lengths) {
      const value = Number(draft.settings[workflow.id]?.seconds ?? sound.default);
      if (value > 0) values.settings = { seconds: value };
    }
    // Its settings on a bar (« Débruitage »), once set here: kept whatever the inputs of the moment.
    for (const setting of keptSettings(workflow)) {
      const value = draft.settings[workflow.id]?.[setting.key];
      if (value !== undefined && value !== '') (values.settings ??= {})[setting.key] = fineValue(setting, value);
    }
    return values;
  }
  /** Gives a model its saved settings back: those its workflow leaves free, as they still fit. */
  function applyPreset(workflow) {
    const saved = info?.presets?.[workflow.id],
      draft = drafts[mode];
    if (!saved || extending) return;
    const lengths = workflow.lengths?.seconds ?? [];
    if (Number.isFinite(saved.length) && lengths.length)
      draft.length = lengths.reduce((best, value) =>
        Math.abs(value - saved.length) < Math.abs(best - saved.length) ? value : best,
      );
    if (saved.format && saved.size && workflow.limits && workflow.direct) {
      const { sizes } = sizeChoices(workflow, saved.format, 0);
      if (sizes.some(size => sizeKey(size) === saved.size))
        Object.assign(draft, { format: saved.format, size: saved.size });
    }
    if (typeof saved.seed === 'string' && workflow.seeded) draft.seed = saved.seed;
    if (Array.isArray(saved.styles) && workflow.styled && mode !== 'audio')
      draft.styles = saved.styles
        .filter(style => info.styles.includes(style.name))
        .slice(0, MAX_STYLES)
        .map(({ name, strength }) => ({ name, strength }));
    for (const lora of workflow.loras ?? []) {
      const entry = saved.loras?.[lora.id];
      if (!entry) continue;
      const choice = loraChoice(workflow, lora);
      if (lora.assistant && typeof entry.on === 'boolean') choice.on = entry.on;
      if (freeStrength(lora) && Number.isFinite(entry.strength)) choice.strength = entry.strength;
      // Within the bounds the workflow gives today.
      loraChoice(workflow, lora);
    }
    const sound = workflow.settings.find(setting => setting.key === 'seconds' && setting.type === 'number');
    if (sound && Number(saved.settings?.seconds) > 0)
      (draft.settings[workflow.id] ??= {}).seconds = Math.min(
        Number(sound.max ?? Infinity),
        Math.max(Number(sound.min ?? 0), saved.settings.seconds),
      );
    // Within the bounds the workflow gives today.
    for (const setting of keptSettings(workflow))
      if (Number.isFinite(saved.settings?.[setting.key]))
        (draft.settings[workflow.id] ??= {})[setting.key] = fineValue(setting, saved.settings[setting.key]);
  }
  /**
   * The floppy disk (moodix-design.md 7, 15 ter): 32 px at the right of the model's name, its
   * name only in its tooltip; quiet while nothing changed, a light pill once something did since
   * the last saving, a check just after one.
   */
  function saveButtonFor(workflow) {
    const disk = button('studio-save', '', () => void savePreset(workflow)),
      floppy = icon('save'),
      check = icon('check');
    floppy.classList?.add?.('studio-save-disk');
    check.classList?.add?.('studio-save-check');
    disk.append(floppy, check);
    disk.dataset.workflow = workflow.id;
    disk.dataset.state = 'still';
    disk.disabled = Boolean(working) || answering();
    saveButton = disk;
    return disk;
  }
  /** The floppy disk says whether the settings changed since they were saved (or first shown). */
  function paintSave() {
    const disk = saveButton,
      workflow = current();
    if (!disk || !workflow || disk.dataset.workflow !== workflow.id) return;
    const saved = info?.presets?.[workflow.id],
      { savedAt, ...values } = saved ?? {},
      against = saved ? canonical(values) : baselines[workflow.id],
      changed = against !== undefined && canonical(snapshot(workflow)) !== against,
      done = savedJust?.id === workflow.id && Date.now() < savedJust.until;
    disk.dataset.state = done ? 'saved' : changed ? 'changed' : 'still';
    disk.title = done
      ? 'Réglages enregistrés pour ' + workflow.name
      : changed
        ? 'Enregistrer ces réglages pour ' + workflow.name + ' : ils reviendront chaque fois que vous le choisirez, et ses LoRA iront aussi avec les créations demandées dans le Chat'
        : saved
          ? 'Réglages de ' + workflow.name + ' enregistrés · ils reviennent chaque fois que vous le choisissez ; ses LoRA vont aussi avec les créations demandées dans le Chat'
          : 'Enregistrer ces réglages pour ' + workflow.name;
    disk.setAttribute('aria-label', disk.title);
  }
  /** Keeps the settings of the model on the server, apart from its workflow, in place of the last. */
  async function savePreset(workflow) {
    if (working || answering()) return;
    const values = snapshot(workflow);
    try {
      const answer = await (await api('studio/preset', { workflow: workflow.id, preset: values })).json();
      (info.presets ??= {})[workflow.id] = answer.preset ?? values;
      savedJust = { id: workflow.id, until: Date.now() + 1600 };
      paintSave();
      setTimeout(paintSave, 1650);
      const said = $('live-status');
      if (said) said.textContent = 'Réglages enregistrés pour ' + workflow.name + '.';
    } catch (error) {
      notice(error.message);
    }
  }
  /** Bloc Modèle: the model chosen (a list when there are several), its own block. */
  function modelBlock(workflow, list) {
    const block = node('div', 'studio-set-block studio-set-model');
    // A clip made here is continued with the model that made it, never chosen; one of the disk has
    // none of its own: its model is chosen like that of a new video.
    if (list.length > 1 && (!extending || !extending.workflowId)) {
      const model = select(
        list.map(item => [item.id, item.unavailable ? item.name + ' · indisponible' : item.name]),
        workflow.id,
        choose,
      );
      // Greyed, with its reason under the list (unavailableNote): never left out unexplained.
      list.forEach((item, index) => {
        if (item.unavailable) Object.assign(model.children[index], { disabled: true, title: item.unavailable });
      });
      model.className = 'studio-model-pick';
      model.title = workflow.description || workflow.name;
      model.disabled = answering() || Boolean(working);
      if (answering()) model.title = 'Modèle choisi par Moodix AI pour cette proposition';
      model.setAttribute('aria-label', mode === 'audio' ? 'Type' : 'Modèle');
      aiTarget(model, 'model');
      block.append(model);
    } else {
      const name = node('span', 'studio-model-name', workflow.name);
      name.title = workflow.description || workflow.name;
      if (workflow.unavailable) name.classList.add('is-unavailable');
      block.append(name);
    }
    // Not for a continuation: what it would keep would never come back (a clip is continued with
    // the model that made it, never chosen).
    if (!extending) block.append(saveButtonFor(workflow));
    return block;
  }
  /**
   * Why the greyed models of the list cannot be used on this computer (no NVIDIA card for a model
   * that computes on one), each reason once; null when every model can.
   */
  function unavailableNote(list) {
    const reasons = [...new Set(list.map(item => item.unavailable).filter(Boolean))];
    if (!reasons.length) return null;
    const note = node('p', 'studio-model-note', reasons.join(' '));
    note.setAttribute('role', 'note');
    return note;
  }
  /**
   * Bloc Durée + Taille: the length the model allows, step by step (its counts of frames at 24 a
   * second: MiniMax H3 from 5.17 s, LTX 2.5 from 0.71 s; a sound, its own setting), and the sizes
   * of the format chosen, a notch each; a fine line between them.
   */
  function shapeBlock(workflow) {
    const draft = drafts[mode],
      lines = [],
      length = lengthOf(workflow);
    if (length) {
      const list = length.list,
        low = list[0],
        high = list.at(-1);
      lines.push(
        barLine(extending ? 'Durée ajoutée' : 'Durée', {
          key: 'duration',
          count: list.length,
          index: Math.max(0, list.indexOf(length.value)),
          share: place => (high > low ? (list[place] - low) / (high - low) : 1),
          text: place => seconds(list[place]),
          onInput: place => {
            draft[length.key] = list[place];
            readout();
            lengthMoved();
          },
        }),
      );
    }
    const sound = workflow.settings.find(setting => setting.key === 'seconds' && setting.type === 'number');
    if (sound && !length) {
      const store = (draft.settings[workflow.id] ??= {}),
        low = Number(sound.min ?? 1),
        high = Number(sound.max ?? 30),
        step = Number(sound.step ?? 1),
        list = [];
      for (let value = low; value <= high + 1e-9; value += step) list.push(Math.round(value * 1000) / 1000);
      const wanted = Number(store.seconds ?? sound.default ?? low),
        index = list.reduce(
          (best, value, at) => (Math.abs(value - wanted) < Math.abs(list[best] - wanted) ? at : best),
          0,
        );
      lines.push(
        barLine('Durée', {
          key: 'setting-seconds',
          count: list.length,
          index,
          share: place => (high > low ? (list[place] - low) / (high - low) : 1),
          text: place => seconds(list[place]),
          onInput: place => {
            store.seconds = list[place];
            readout();
          },
        }),
      );
    }
    if (workflow.limits && !extending) {
      const { sizes } = sizing(workflow),
        list = [...sizes];
      // A size outside the list, of a proposal (kept from a source) or of a take (asked in the Chat),
      // is shown as it is, among the others by its number of pixels (0.6.92: at the end before).
      if (draft.size && !list.some(size => sizeKey(size) === draft.size)) {
        const [width, height] = draft.size.split('x').map(Number),
          larger = list.findIndex(size => size.width * size.height > width * height);
        list.splice(larger < 0 ? list.length : larger, 0, { width, height });
      }
      if (list.length) {
        const line = barLine('Résolution', {
          key: 'size',
          count: list.length,
          index: Math.max(
            0,
            list.findIndex(size => sizeKey(size) === draft.size),
          ),
          share: place => (list.length > 1 ? place / (list.length - 1) : 1),
          text: place => `${list[place].width} × ${list[place].height}`,
          onInput: place => {
            draft.size = sizeKey(list[place]);
            readout();
          },
          notches: true,
        });
        line.title = mode === 'video' ? 'Plus grand : plus long à générer.' : '';
        // Above the length, under the format (studio-maquette.md).
        lines.unshift(line);
      }
    }
    if (!lines.length) return null;
    const block = node('div', 'studio-set-block studio-set-shape');
    lines.forEach((line, at) => {
      if (at) block.append(node('div', 'studio-set-rule'));
      block.append(line);
    });
    return block;
  }
  /** What depends on the length, kept in step while its bar moves: the line from start to end. */
  function lengthMoved() {
    paintSpan();
  }
  /**
   * Bloc LoRA (moodix-design.md 11, 7 bis 5): « LoRA · n / 3 », those of the workflow first (a
   * padlock in place of ×, their bar greyed when their strength is fixed there, their switch when
   * they are left to the assistant), then those added here, three at most, 0 to 2.
   */
  function loraBlock(workflow, styled) {
    const own = workflow.loras ?? [];
    if (!own.length && !styled) return null;
    const draft = drafts[mode],
      section = node('section', 'studio-set-block studio-lora-block'),
      head = node('div', 'studio-lora-head');
    section.setAttribute('aria-label', 'LoRA');
    head.append(node('h3', 'studio-lora-heading', 'LoRA'));
    if (styled) {
      head.append(node('span', 'studio-lora-count', `· ${draft.styles.length} / ${MAX_STYLES}`));
      if (info.styles.length && draft.styles.length < MAX_STYLES) {
        const add = button(
          'studio-lora-plus',
          '',
          () => {
            draft.styles.push({ name: info.styles[0], strength: 1 });
            render();
          },
          'plus',
        );
        add.setAttribute('aria-label', 'Ajouter un LoRA');
        add.title = 'Ajouter un LoRA';
        add.disabled = Boolean(working);
        head.append(add);
      }
    }
    section.append(head);
    for (const lora of own) section.append(workflowLoraRow(workflow, lora));
    if (styled) {
      draft.styles.forEach((style, index) => section.append(styleRow(style, index)));
      if (!info.styles.length)
        section.append(node('small', 'field-help', 'Aucun LoRA listé : le dossier loras est vide.'));
    }
    return section;
  }
  /** A LoRA of the workflow: its name, its strength (greyed when fixed there), its switch, a padlock. */
  function workflowLoraRow(workflow, lora) {
    const choice = loraChoice(workflow, lora),
      free = freeStrength(lora),
      low = free ? Number(lora.strength.min ?? 0) : Math.min(0, choice.strength),
      high = free ? Number(lora.strength.max ?? 2) : Math.max(2, choice.strength),
      list = strengths(low, high),
      row = node('div', 'studio-lora-row is-workflow' + (choice.on ? '' : ' is-off')),
      name = node('span', 'studio-lora-title'),
      { track, value } = slider({
        label: 'Force du LoRA ' + lora.name,
        count: list.length,
        index: Math.max(0, Math.round((choice.strength - low) / 0.05)),
        share: place => (high > low ? (list[place] - low) / (high - low) : 1),
        text: place => strengthText(list[place]),
        onInput: place => {
          choice.strength = list[place];
        },
        disabled: !free || !choice.on,
      }),
      lock = node('span', 'studio-lora-lock');
    // (Left to the assistant, it has its switch: no mark of Moodix AI beside its name, 0.6.92.)
    name.append(node('span', 'studio-lora-label', lora.name));
    name.title = lora.description ? lora.name + ' · ' + lora.description : lora.name;
    if (!free) value.title = 'Force fixée dans Workflows';
    lock.append(icon('lock'));
    lock.setAttribute('role', 'img');
    lock.setAttribute('aria-label', 'LoRA du workflow');
    lock.title = 'LoRA du workflow : réglé dans Paramètres › Workflows';
    row.append(name, track, value);
    if (lora.assistant) {
      const toggle = node('input', 'studio-lora-switch');
      toggle.type = 'checkbox';
      toggle.checked = choice.on;
      toggle.disabled = Boolean(working);
      toggle.title = 'Utiliser ce LoRA pour cette création';
      toggle.setAttribute('aria-label', 'Utiliser le LoRA ' + lora.name);
      toggle.onchange = () => {
        choice.on = toggle.checked;
        render();
      };
      row.append(toggle);
    }
    row.append(lock);
    return row;
  }
  /** A LoRA added here: its name (a click opens the list), its strength from 0 to 2, × to remove it. */
  function styleRow(style, index) {
    const draft = drafts[mode],
      list = strengths(0, 2),
      row = node('div', 'studio-lora-row'),
      name = select(
        info.styles.map(file => [file, leaf(file)]),
        style.name,
        value => {
          style.name = value;
          name.title = leaf(value);
          paintSave();
        },
      ),
      { track, value } = slider({
        label: 'Force du LoRA ' + leaf(style.name),
        count: list.length,
        index: Math.max(0, Math.min(list.length - 1, Math.round(style.strength / 0.05))),
        share: place => list[place] / 2,
        text: place => strengthText(list[place]),
        onInput: place => {
          style.strength = list[place];
        },
      }),
      remove = button(
        'studio-lora-drop',
        '',
        () => {
          draft.styles.splice(index, 1);
          render();
        },
        'close',
      );
    name.className = 'studio-lora-pick';
    name.title = leaf(style.name);
    name.disabled = Boolean(working);
    name.setAttribute('aria-label', 'LoRA ' + (index + 1));
    remove.title = 'Retirer ce LoRA';
    remove.setAttribute('aria-label', 'Retirer ce LoRA');
    remove.disabled = Boolean(working);
    row.append(name, track, value, remove);
    return row;
  }
  /**
   * A decimal setting on its bar, by hundredths (« Débruitage », 0,60 to 0,70), what its values do
   * said in its tip, under the pointer and on the focus (help-tips.mjs), as the other settings say
   * theirs: no line under it any more (0.6.92). One the model only reads with an input (an image to
   * modify) is greyed while the case of that input is empty, and its tip says why in place of that
   * help: never unavailable without its reason.
   */
  function fineLine(workflow, setting) {
    const draft = drafts[mode],
      store = (draft.settings[workflow.id] ??= {}),
      low = setting.min,
      high = setting.max,
      list = [];
    for (let step = 0; low + step * 0.01 <= high + 1e-9; step++) list.push(Math.round((low + step * 0.01) * 100) / 100);
    const role = onlyRole(workflow, setting),
      idle = Boolean(role) && !onlyInputs(workflow, setting).some(input => (draft.inputs[input] ?? []).some(Boolean)),
      label = SETTINGS[setting.key] || setting.key,
      said = idle
        ? (ONLY_WITH[role] ?? `Sert seulement avec l’entrée « ${ROLES[role] ?? role} ».`)
        : (BAR_HELP[setting.key] ?? ''),
      line = barLine(label, {
        key: 'setting-' + setting.key,
        count: list.length,
        index: Math.max(0, list.indexOf(fineValue(setting, store[setting.key]))),
        share: place => (list[place] - low) / (high - low),
        text: place => strengthText(list[place]),
        onInput: place => {
          store[setting.key] = list[place];
        },
        disabled: idle,
      }),
      wrapper = node('div', 'studio-fine' + (idle ? ' is-idle' : ''));
    wrapper.append(line);
    if (said) {
      // The tip of the whole line: a greyed bar takes no focus, its label and its value the pointer.
      line.title = said;
      // Read by screen readers after the bar, where the line under it said it, without its room.
      wrapper.append(node('span', 'sr-only', said));
    }
    return wrapper;
  }
  /**
   * The rare settings, under « ··· » (moodix-design.md 10, 20, 28): the seed (a field, empty for
   * one drawn at each creation, and a die), then the workflow's own settings; one line each.
   */
  function rareLines(workflow) {
    const draft = drafts[mode],
      lines = [];
    if (workflow.seeded) {
      const row = node('div', 'studio-set-line studio-seed'),
        seed = node('input'),
        dice = button(
          'studio-dice',
          '',
          () => {
            seed.value = draft.seed = String(Math.floor(Math.random() * 2 ** 32));
            paintSave();
          },
          'dice',
        );
      seed.type = 'number';
      seed.min = '0';
      seed.placeholder = 'aléatoire';
      seed.value = draft.seed;
      seed.disabled = Boolean(working);
      seed.setAttribute('aria-label', 'Seed');
      seed.oninput = () => {
        draft.seed = seed.value;
        paintSave();
      };
      aiTarget(seed, 'seed');
      dice.title = 'Tirer une seed au hasard';
      dice.setAttribute('aria-label', 'Tirer une seed au hasard');
      dice.disabled = Boolean(working);
      row.append(node('span', 'studio-bar-label', 'Seed'), seed, dice);
      lines.push(row);
    }
    for (const setting of workflow.settings) {
      if (setting.key === 'lyrics' && setting.type === 'string') continue;
      // Who is who is said beside the inputs (whoBlock).
      if (WHO[setting.key] && setting.type === 'string') continue;
      // A sound's length is on the bar of Durée.
      if (setting.key === 'seconds' && setting.type === 'number') continue;
      if (fineSetting(setting)) {
        lines.push(fineLine(workflow, setting));
        continue;
      }
      // Kept per workflow: a song's length is not a sound effect's.
      const store = (draft.settings[workflow.id] ??= {}),
        value = store[setting.key] ?? setting.default ?? '',
        label = SETTINGS[setting.key] || setting.key,
        set = next => {
          store[setting.key] = next;
          readout();
        };
      let control;
      if (setting.type === 'string' && !setting.choices) {
        control = textarea(String(value), 4, SETTING_HELP[setting.key] ?? '', set);
        if (setting.maxLength) control.maxLength = setting.maxLength;
      } else if (setting.choices)
        control = select(
          setting.choices.map(choice => [choice, String(choice)]),
          value,
          set,
        );
      else {
        control = node('input');
        control.type = 'number';
        control.value = String(value);
        if (setting.min !== undefined) control.min = String(setting.min);
        if (setting.max !== undefined) control.max = String(setting.max);
        control.oninput = () => set(control.value);
      }
      aiTarget(control, 'setting-' + setting.key);
      const wrapper = field(label, control, { wide: setting.type === 'string' && !setting.choices });
      if (setting.max !== undefined) wrapper.title = `De ${setting.min ?? 0} à ${setting.max}.`;
      lines.push(wrapper);
    }
    return lines;
  }

  // ------------------------------------------------------------------ the screen
  /**
   * The shape of the screen (16/11): the take shown at its own format, in its filet, without bands
   * (the format chosen in the settings is for the next creation); while one is made, or with none,
   * the shape of what will be made.
   */
  /**
   * The screen always takes the format chosen (16/11), empty or not: a take of another format is
   * shown whole inside it, never cropped (moodix.css, studio-frame-result).
   */
  function screenShape() {
    return shapeOf();
  }
  /** The take shown measured once its file is read (a record without its size): the screen follows. */
  function measuredOnScreen(record, width, height) {
    if (!(width > 0 && height > 0) || sizeOfRecord(record)) return;
    measured.set(record.id, { width, height });
    const page = globalThis.document,
      frame = page?.querySelector?.('#studio-view .studio-frame');
    if (frame && onStage()?.id === record.id)
      reshape(frame, screenShape(record), page.querySelector('#studio-view .studio-frame-over'));
  }
  /** The number the take under way will have: the counter of the project, else the last one + 1. */
  function upcomingTake() {
    if (Number.isInteger(nextTake) && nextTake > 0) return nextTake;
    return 1 + Math.max(0, ...runs.flatMap(record => (record.outputs ?? []).map(output => output.take ?? 0)));
  }
  /** The shape of what will be made: a ratio, and the format it is. */
  function shapeOf() {
    if (mode === 'audio') return { ratio: 3.4, label: '' };
    if (extending) {
      const { width, height } = extending.parameters ?? {},
        format = formatOf(width, height);
      return { ratio: width > 0 && height > 0 ? width / height : 16 / 9, label: format?.id ?? 'Suite' };
    }
    // A character put in a video: the shape of that video, known once it is given.
    if (current()?.follows) {
      const video = drafts[mode].inputs.source?.[0],
        known = video?.width > 0 && video?.height > 0;
      return {
        ratio: known ? video.width / video.height : 16 / 9,
        label: known ? (formatOf(video.width, video.height)?.id ?? '') : '',
      };
    }
    const format = FORMATS.find(item => item.id === drafts[mode].format);
    return { ratio: format?.ratio ?? 1, label: format?.id ?? '' };
  }
  /**
   * What will be made, at the top left of the screen (moodix-design.md 25, 7 bis 13): its format
   * and its length, « 16:9 - 05.17 S »; an image, its format; a sound, its length. Whether it is
   * a draft or a final is said in the details of the creation (a click in the Sortie).
   */
  /** Under the empty frame (55): « 1:1 · 1024 × 1024 », the format and the size the settings have. */
  function blankSize(workflow = current()) {
    if (!workflow || mode === 'audio') return '';
    const draft = drafts[mode],
      kept = /^\d+x\d+$/.test(draft.size ?? '') ? draft.size.split('x').map(Number) : null,
      first = workflow.limits ? sizing(workflow).sizes[0] : null,
      [width, height] = kept ?? (first ? [first.width, first.height] : []);
    return [shapeOf().label, width && height ? `${width} × ${height}` : ''].filter(Boolean).join(' · ');
  }
  function readoutText(workflow = current()) {
    if (!workflow) return '';
    const shape = shapeOf(),
      length = lengthOf(workflow);
    if (mode === 'audio') {
      const sound = soundSeconds(workflow);
      return sound ? figures(sound) : '';
    }
    if (mode === 'image') return shape.label;
    return [shape.label, length ? figures(length.value) : ''].filter(Boolean).join(' - ');
  }
  /** The length of a sound to make, as its setting has it. */
  function soundSeconds(workflow) {
    const sound =
      drafts.audio.settings[workflow.id]?.seconds ??
      workflow.settings.find(setting => setting.key === 'seconds')?.default;
    return Number(sound) > 0 ? Number(sound) : null;
  }
  function readout() {
    const text = document.querySelector?.('.studio-readout');
    if (text) text.textContent = readoutText();
    const blank = document.querySelector?.('#studio-view .studio-blank-size');
    if (blank) blank.textContent = blankSize();
    paintSave();
  }
  /** The room the frame has: its stage, less a margin; a default before the stage is laid out. */
  function room(frame) {
    const box = frame.parentElement,
      width = box?.clientWidth ?? 0,
      height = box?.clientHeight ?? 0;
    // As large as the stage: the Studio fills the window, the screen with it.
    return width > 40 && height > 40 ? { width: Math.min(width, 1600), height: Math.min(height, 1000) } : FRAME;
  }
  function reshape(frame, { ratio }, over = null) {
    const size = frameSize(ratio, room(frame));
    for (const element of [frame, over].filter(Boolean)) {
      element.style.width = size.width + 'px';
      element.style.height = size.height + 'px';
    }
    drawn = size;
    readout();
  }
  /**
   * The screen: a frame at the format of the take shown (of what will be made while one is made,
   * or with none), as large as the stage allows. It eases from the shape it had to the new one,
   * across formats and across modes, and follows the window when it is resized.
   */
  function stage() {
    const screen = node('div', 'studio-screen'),
      box = node('div', 'studio-stage'),
      // While a creation is being made the frame is its own (the picture so far).
      last = onStage(),
      frame = node(
        'div',
        'studio-frame' +
          (mode === 'audio' ? ' is-audio' : '') +
          (working ? ' is-busy' : '') +
          (last ? ' has-result' : '') +
          (!last && !working && !gpuBlocked() ? ' is-empty' : '') +
          (gpuBlocked() && !working ? ' is-held' : ''),
      ),
      // The card held: the take that held it is drawn at the format chosen for it (54).
      shaped = gpuBlocked() && !working ? null : last,
      next = screenShape(shaped);
    const take = last?.outputs?.[0]?.take,
      numbered = Number.isInteger(take),
      // While a take is made: the number it will have, in the accent, instead of its format.
      coming = working && !numbered ? upcomingTake() : null;
    frame.append(
      node('span', 'studio-frame-fill'),
      node(
        'span',
        'studio-frame-label' + (numbered ? ' is-take' : coming ? ' is-take is-coming' : ''),
        numbered ? 'PRISE ' + take : coming ? 'PRISE ' + coming : next.label,
      ),
    );
    if (mode === 'audio') {
      const bars = node('div', 'studio-bars');
      bars.setAttribute('aria-hidden', 'true');
      for (let index = 0; index < 48; index++) {
        const bar = node('span');
        bar.style.height = 16 + Math.round(76 * Math.abs(Math.sin(index * 0.41) * Math.cos(index * 0.13))) + '%';
        bars.append(bar);
      }
      frame.append(bars);
    }
    if (gpuBlocked() && !working) {
      // The card stays held by the last generation (etats-maquette.md, 54): its take veiled, at its
      // format, « ÉCHEC » (nothing was kept) and « ARRÊTÉE », and what to do.
      if (seenPreview) {
        const picture = node('img', 'studio-held-picture');
        Object.assign(picture, { src: seenPreview, alt: '', draggable: false });
        frame.append(picture);
      }
      const veil = node('div', 'studio-held-veil');
      veil.setAttribute('role', 'alert');
      // The same words as in the chat (54b); « Libérer le GPU » says what to do, under it.
      const said = node('p', 'studio-held-text');
      said.append(
        node('span', '', 'La carte graphique est restée prise par la dernière génération.'),
        node('span', '', ' Rien n’a été enregistré.'),
      );
      veil.append(node('p', 'studio-held-kicker', 'Arrêtée'), said);
      frame.append(node('span', 'studio-failed-chip', 'Échec'), veil);
    } else if (last) {
      const shownTake = result(last);
      frame.append(shownTake);
      if (shownTake.playButton) frame.append(shownTake.playButton);
    } else if (!working) {
      // Nothing made in this mode yet (etats-maquette.md, 55): the Éclipse small, where the first take
      // will come, how to begin, and the format with its size, which follow the settings.
      const blank = node('div', 'studio-blank'),
        sign = mark?.();
      if (sign) {
        sign.classList?.add('studio-blank-mark');
        blank.append(sign);
      }
      blank.append(
        node('p', 'studio-blank-title', 'Votre première prise apparaîtra ici.'),
        node(
          'p',
          'studio-blank-text',
          'Écrivez un prompt à gauche, ou laissez Moodix AI régler le Studio avec la moitié droite du bouton.',
        ),
        node('p', 'studio-blank-size', blankSize()),
      );
      frame.append(blank);
    } else frame.setAttribute('aria-hidden', 'true');
    const shown = node('span', 'studio-readout', readoutText());
    shown.setAttribute('aria-hidden', 'true');
    frame.append(shown);
    // Over the frame, at its size, never clipped by it. No « i » on the screen: a click on a
    // creation of the Sortie shows it whole with its details.
    // The step under way is in the head of the screen, « Arrêter » in the Double verre (form).
    const over = node('div', 'studio-frame-over');
    // Drawn at the previous shape first, so the browser has something to ease from.
    const from = drawn ?? frameSize(next.ratio);
    for (const element of [frame, over]) {
      element.style.width = from.width + 'px';
      element.style.height = from.height + 'px';
    }
    box.append(frame, over);
    screen.append(box);
    // A take of the Sortie, or a file of the computer, dropped on the screen: shown there with what
    // made it (inspect, inspectFile). Not an image of a case, which only changes case.
    const takes = event => Boolean(carried) || (!dragged && [...(event.dataTransfer?.types ?? [])].includes('Files'));
    box.ondragover = event => {
      if (!takes(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      box.classList.add('is-target');
    };
    box.ondragleave = () => box.classList.remove('is-target');
    box.ondrop = event => {
      if (!takes(event)) return;
      event.preventDefault();
      event.stopPropagation?.();
      box.classList.remove('is-target');
      carrying(null);
      if (carried) {
        const record = carried;
        carried = null;
        return inspect(record);
      }
      const [file] = event.dataTransfer.files ?? [];
      if (file) void inspectFile(file);
    };
    watching?.disconnect();
    if (typeof ResizeObserver === 'function') {
      // Called once the stage is laid out, then at every change of its size.
      watching = new ResizeObserver(() => {
        // Another view is shown: nothing to size. Back in sight (16/11): at its size at once, the
        // screen never grows into place as the Studio comes; it eases only from one format to another.
        const there = box.clientWidth > 40 && box.clientHeight > 40;
        if (!there) return void (laidOut = false);
        const still = laidOut ? [] : [frame, over];
        for (const element of still) element.style.transition = 'none';
        reshape(frame, screenShape(shaped), over);
        if (still.length) void frame.offsetWidth;
        for (const element of still) element.style.transition = '';
        laidOut = true;
      });
      watching.observe(box);
    }
    return { screen, box, frame };
  }
  /** The creation on the screen: the image (a click shows it whole), the clip to play, or the sound. */
  function result(record) {
    const output = record.outputs[0],
      media = mediaOf(record),
      key = record.id + '|' + (output.originalUrl || '');
    if (shownMedia?.key === key) return shownMedia.element;
    const element = screenMedia(record, output, media);
    shownMedia = { key, element };
    return element;
  }
  /** The element that shows a creation on the screen: its picture, its clip to play, or its sound. */
  function screenMedia(record, output, media) {
    if (media === 'audio') {
      const player = node('audio', 'studio-frame-result studio-frame-sound');
      Object.assign(player, { controls: true, preload: 'metadata', src: output.originalUrl || '' });
      return player;
    }
    const clip = media === 'video',
      element = node(clip ? 'video' : 'img', 'studio-frame-result');
    // Its own shape, for the sheet (moodix.css, --media-ratio): the take is always a little smaller
    // than the frame and rounded on its own, whatever the format chosen (16/11). Known from its
    // record at once, from the picture itself once it is read.
    const shaped = (width, height) =>
      width > 0 && height > 0 && element.style.setProperty?.('--media-ratio', (width / height).toFixed(4));
    const known = sizeOfRecord(record);
    if (known) shaped(known.width, known.height);
    if (clip) {
      Object.assign(element, { controls: false, preload: 'metadata', playsInline: true, src: output.originalUrl || '' });
      if (output.thumbUrl) element.poster = output.thumbUrl;
      element.onloadedmetadata = () => {
        shaped(element.videoWidth, element.videoHeight);
        measuredOnScreen(record, element.videoWidth, element.videoHeight);
      };
      // Its picture and a round play button (capture 22), as in the conversation; the controls of the
      // player once it plays. Kept with the clip from one drawing to the next.
      const play = button('take-play', '', () => {
        play.hidden = true;
        element.controls = true;
        void element.play?.()?.catch?.(() => {});
      });
      play.setAttribute('aria-label', 'Lire la vidéo');
      play.title = 'Lire la vidéo';
      element.onplay = () => {
        play.hidden = true;
        element.controls = true;
      };
      element.playButton = play;
    } else {
      Object.assign(element, {
        alt: record.prompt || 'Dernière image créée',
        decoding: 'async',
        src: output.originalUrl,
      });
      if (!record.external) {
        element.title = 'Voir l’original et ses paramètres';
        element.onclick = () => viewOutput(record, 0);
      }
      element.onload = () => {
        shaped(element.naturalWidth, element.naturalHeight);
        measuredOnScreen(record, element.naturalWidth, element.naturalHeight);
      };
    }
    return element;
  }
  /** The number of a creation in the Sortie: the first made is #1, the newest the largest. */
  function numberOf(record) {
    // One count for all the creations of the Sortie, images, clips and sounds together: counted
    // kind by kind, an image, a clip and a sound were each « #1 » side by side.
    const at = runs.findIndex(item => item.id === record.id);
    return at < 0 ? null : runs.length - at;
  }

  /** The formats under the preview: 1:1, 16:9, 9:16, and « ··· » for all of them. */
  function formatChips(workflow, frame) {
    const draft = drafts[mode],
      wrap = node('div', 'studio-formats-wrap'),
      row = aiTarget(node('div', 'studio-formats'), 'ratio'),
      available = sizing(workflow).formats.map(format => format.id),
      { main, extra } = shownFormats(available, draft.format),
      menu = node('div', 'studio-format-menu');
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', 'Format');
    const pick = id => {
      Object.assign(draft, { format: id, size: null, formatChosen: true });
      formatsOpen = false;
      // The chips and the sizes change with the format (another one may take the place of « ··· »).
      render();
    };
    for (const id of main) {
      const format = FORMATS.find(item => item.id === id),
        chip = button('studio-format', id, () => pick(id));
      chip.title = format.label;
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', String(id === draft.format));
      chip.disabled = Boolean(working);
      row.append(chip);
    }
    // Never cut by its panel (16/11): shown above the page, on the side that has room (glass-menu.mjs).
    const more = button('studio-format is-more' + (extra ? ' is-on' : ''), extra ? extra + ' ···' : '···', () => {
      formatsOpen = !formatsOpen;
      if (formatsOpen) openPopup(menu, more);
      else closePopup(menu);
      more.setAttribute('aria-expanded', String(formatsOpen));
    });
    more.setAttribute('aria-label', extra ? `Format ${extra} · tous les formats` : 'Tous les formats');
    more.setAttribute('aria-expanded', String(formatsOpen));
    more.disabled = Boolean(working);
    if (extra) {
      more.setAttribute('role', 'radio');
      more.setAttribute('aria-checked', 'true');
    }
    row.append(more);
    menu.setAttribute('role', 'group');
    menu.setAttribute('aria-label', 'Tous les formats');
    menu.hidden = !formatsOpen;
    for (const id of available) {
      const choice = button('', id, () => pick(id));
      choice.title = FORMATS.find(item => item.id === id).label;
      choice.setAttribute('aria-pressed', String(id === draft.format));
      menu.append(choice);
    }
    wrap.append(row, menu);
    // Left open while the Studio is drawn again: shown once it is on the page.
    if (formatsOpen) globalThis.queueMicrotask?.(() => menu.isConnected && formatsOpen && openPopup(menu, more));
    return wrap;
  }

  // ------------------------------------------------------------------ LoRA of the workflow
  /** Whether the strength of a LoRA of the workflow is left to whoever asks (a range) or fixed there. */
  const freeStrength = lora => !Object.hasOwn(lora.strength, 'value');
  /**
   * What this creation does with a LoRA of its workflow: on or off, and how strongly. What the
   * workflow fixes follows it (switched there, it is so here at once); the rest is chosen here.
   */
  function loraChoice(workflow, lora, draft = drafts[mode]) {
    const own = (draft.workflowLoras[workflow.id] ??= {}),
      start = freeStrength(lora)
        ? (lora.strength.default ?? Math.min(lora.strength.max ?? 1, Math.max(lora.strength.min ?? 1, 1)))
        : lora.strength.value;
    const choice = (own[lora.id] ??= { on: lora.on, strength: start });
    if (!lora.assistant) choice.on = true;
    if (!freeStrength(lora)) choice.strength = lora.strength.value;
    else if (Number.isFinite(lora.strength.min) && Number.isFinite(lora.strength.max))
      choice.strength = Math.min(lora.strength.max, Math.max(lora.strength.min, choice.strength));
    return choice;
  }
  /** The workflow's LoRAs left to the assistant, as this creation has them, in the model's terms. */
  function loraArgs(workflow, draft = drafts[mode]) {
    const result = {};
    for (const lora of workflow?.loras ?? []) {
      const choice = loraChoice(workflow, lora, draft),
        entry = {};
      if (lora.assistant) entry.enabled = choice.on;
      if (choice.on && freeStrength(lora)) entry.strength = choice.strength;
      if (Object.keys(entry).length) result[lora.id] = entry;
    }
    return Object.keys(result).length ? result : null;
  }
  // ------------------------------------------------------------------ images handed over
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
  /** The first image of files pasted or dropped, if any. */
  const imageFile = files => [...(files ?? [])].find(file => IMAGE_TYPES.includes(file.type)) ?? null;
  /**
   * An image pasted or dropped on the column of the prompt goes to the first free slot the model
   * takes, in the order of its slots, never to one that would not combine with those given.
   */
  function placeImage(workflow, file) {
    if (working) return;
    if (answering())
      return notice(
        'Les images de cette proposition sont celles de Moodix AI : demandez-lui dans le chat pour en changer.',
      );
    const draft = drafts[mode];
    let taken = false;
    for (const [role, spec] of Object.entries(workflow.roles ?? {})) {
      if (!spec.count || !spec.media.includes('image')) continue;
      taken = true;
      if (exclusiveWith(workflow, role).length) continue;
      for (let index = 0; index < spec.count; index++)
        if (!draft.inputs[role]?.[index]) return void fill(role, index, file);
    }
    notice(taken ? 'Toutes les cases d’images sont prises.' : 'Ce modèle ne prend pas d’image en entrée.');
  }

  const videoFile = files => [...(files ?? [])].find(file => VIDEO_TYPES.includes(file.type)) ?? null;
  /** A video dropped on the column of the prompt goes to the slot of the model that takes one. */
  function placeVideo(workflow, file) {
    if (working || answering()) return;
    for (const [role, spec] of Object.entries(workflow.roles ?? {}))
      if (takesVideo(workflow, role)) {
        for (let index = 0; index < spec.count; index++)
          if (!drafts[mode].inputs[role]?.[index]) return void fill(role, index, file, 'video');
        return notice('La case de la vidéo est prise : retirez-la d’abord.');
      }
    notice('Ce modèle ne prend pas de vidéo en entrée.');
  }

  // ------------------------------------------------------------------ the prompt, improved
  // « Améliorer le prompt » asks for a few words first (moodix-design.md 17).
  const IMPROVE_MIN = 3;
  /**
   * A character put in a video: the video and the image handed over, from which the prompt is
   * written (not from words alone, which would invent a scene the video does not show). Null
   * for another model, or while one of the two is missing.
   */
  function sceneInputs() {
    if (!current()?.follows) return null;
    const { source, reference } = drafts[mode].inputs,
      video = source?.find(Boolean)?.source,
      character = reference?.find(Boolean)?.source;
    return video && character ? { source: video, reference: character } : null;
  }
  const improveTitle = () =>
    sceneInputs()
      ? 'Écrire le prompt d’après la vidéo et le personnage (' + MODIFIER + '+E)'
      : current()?.follows
        ? 'Ajoutez d’abord la vidéo et le personnage'
        : drafts[mode].prompt.trim().length < IMPROVE_MIN
          ? 'Écrivez d’abord quelques mots'
          : 'Améliorer le prompt avec Moodix AI (' + MODIFIER + '+E)';
  /** Whether « Améliorer » has what it needs: a few words, or the pictures a prompt is written from. */
  const improves = () =>
    current()?.follows ? Boolean(sceneInputs()) : drafts[mode].prompt.trim().length >= IMPROVE_MIN;
  /** The button follows what is typed, without drawing the Studio again (the field keeps its focus). */
  /** « Générer » as the prompt is typed: greyed while it is empty (55), without drawing the Studio again. */
  function goable() {
    const go = document.querySelector?.('#studio-view .studio-go');
    if (!go || working || enriching || answering() || checking || current()?.unavailable) return;
    const blank = !drafts[mode].prompt.trim();
    go.disabled = blank;
    go.classList.toggle('is-blank', blank);
    go.title = blank ? 'Écrivez un prompt pour générer' : `Générer (${MODIFIER}+Entrée)`;
  }
  function improvable() {
    const go = document.querySelector?.('#studio-view .studio-enrich-go');
    if (!go || enriching) return;
    go.disabled = Boolean(working) || !improves();
    go.title = improveTitle();
  }
  /** The chat model rewrites what is typed as a full prompt; what was typed can be taken back. */
  async function enrich() {
    if (enriching || working) return;
    const draft = drafts[mode],
      text = draft.prompt.trim(),
      scene = sceneInputs();
    if (!improves()) {
      failure = current()?.follows ? 'Ajoutez d’abord la vidéo et le personnage.' : 'Écrivez d’abord quelques mots.';
      return render();
    }
    const reason = blocked();
    if (reason) return notice(reason);
    // What it is asked for: the verb, the conversation and the mode in hand now. The chat model may
    // take seconds to come back and to write: the user may open another conversation meanwhile.
    const verb = verbOf(),
      home = place(),
      epoch = draftsEpoch,
      asked = mode,
      moved = () => epoch !== draftsEpoch || asked !== mode;
    enriching = true;
    enrichEpoch = epoch;
    failure = '';
    render();
    const controller = new AbortController();
    try {
      // The chat model is started when it is not running, once it has finished leaving.
      await releasing;
      await waitForModel(api, controller.signal, () => {});
      const result = moved()
        ? null
        : await (
            await api('studio/enrich', {
              prompt: text,
              verb,
              // Its video or its character made in the conversation are found there.
              ...(scene ? { ...scene, conversationId: home } : {}),
            })
          ).json();
      // Answered once another conversation or another mode is shown: the drafts are theirs now (the
      // same objects, emptied and set again), and the prompt of the one it was asked in is no
      // longer in the Studio. Written all the same, it replaced the prompt of the conversation open.
      if (moved()) {
        notice('Prompt non enrichi : la conversation ou le mode a changé entre-temps.');
        return;
      }
      draft.before = text;
      // The text rewritten writes itself in the box, in half a second (at once with less motion).
      const box = document.querySelector?.('#studio-view [data-ai="prompt"]');
      if (box && pointer && !pointer.reduced()) {
        const step = Math.max(2, Math.ceil(result.prompt.length / 36));
        for (let index = step; index < result.prompt.length + step; index += step) {
          box.value = result.prompt.slice(0, index);
          box.scrollTop = box.scrollHeight;
          await wait(14);
        }
      }
      draft.prompt = result.prompt;
      notice('');
    } catch (error) {
      notice('Prompt non enrichi : ' + error.message);
    } finally {
      enriching = false;
      onChange();
      render();
    }
  }
  /**
   * The prompt of a replacement whose character Moodix AI has just made, written from the video
   * and that image as the wand writes it: the chat model comes back for it (the generator of the
   * image leaves the card to it), with what the user asked and the prompt of Moodix AI as a draft.
   * When it cannot be, the prompt of Moodix AI stays and the Studio says why.
   */
  async function writeScene(current) {
    const draft = drafts[current.mode],
      scene = sceneInputs(),
      { signal } = current,
      before = draft.prompt;
    if (!scene) return;
    enriching = true;
    render();
    try {
      await releasing;
      await waitForModel(api, signal, () => {});
      const result = await (
        await api(
          'studio/enrich',
          {
            prompt: String(current.request.scene?.asked ?? ''),
            draft: before.trim(),
            verb: 'replace_character',
            ...scene,
            conversationId: place(),
          },
          { signal },
        )
      ).json();
      // The user wrote their own meanwhile: theirs stays.
      if (draft.prompt !== before) return;
      draft.before = before;
      enriching = false;
      render();
      if (ai && !ai.stopped) await typePrompt(draft, result.prompt);
      draft.prompt = result.prompt;
    } catch (error) {
      // Stopped with the turn: nothing to say.
      if (!signal?.aborted) notice('Prompt de Moodix AI gardé : ' + error.message);
    } finally {
      enriching = false;
      render();
    }
  }
  /**
   * In the corner of the prompt, inside its box: the wand that improves it (its name for screen
   * readers and in its tooltip, with its shortcut), and once used the arrow back to what was typed.
   */
  function enrichRow() {
    const draft = drafts[mode],
      row = node('div', 'studio-enrich'),
      label = enriching ? 'Amélioration du prompt…' : 'Améliorer le prompt',
      make = aiTarget(button('studio-enrich-go', '', enrich, 'wand'), 'enrich');
    make.append(node('span', 'sr-only', label));
    make.setAttribute('aria-label', label);
    make.setAttribute('aria-keyshortcuts', MODIFIER === '⌘' ? 'Meta+E' : 'Control+E');
    make.title = enriching ? 'Moodix AI réécrit votre texte…' : improveTitle();
    if (enriching) {
      make.classList.add('is-working');
      make.setAttribute('aria-busy', 'true');
    }
    make.disabled = enriching || Boolean(working) || !improves();
    // Moodix AI is taken by a work of another conversation (0.6.81): greyed, and why.
    const taken = !enriching && !working && !answering() && !checking ? elsewhere() : '';
    if (taken) {
      make.disabled = true;
      make.title = taken;
    }
    if (draft.before !== null && !enriching && !working) {
      const back = button(
        'studio-link',
        '',
        () => {
          draft.prompt = draft.before;
          draft.before = null;
          render();
        },
        'undo',
      );
      back.append(node('span', 'sr-only', 'Revenir à mon texte'));
      back.setAttribute('aria-label', 'Revenir à mon texte');
      back.title = 'Revenir à mon texte';
      row.append(back);
    }
    row.append(make);
    return row;
  }

  // ------------------------------------------------------------------ generation
  function request() {
    const draft = drafts[mode],
      workflow = current(),
      verb = verbOf(),
      prompt = draft.prompt.trim();
    if (!workflow) throw Error('Aucun workflow prêt pour cette création.');
    if (!prompt)
      throw Error(
        workflow?.follows
          ? 'Écrivez un prompt, ou cliquez sur la baguette : il sera écrit d’après la vidéo et le personnage.'
          : 'Écrivez un prompt.',
      );
    const args = { prompt },
      edits = {};
    // Named when its verb has several: the models of another verb of the list are not its rivals.
    // A continuation is not named (the server gives it the model of its clip), unless its clip is a
    // file of the disk, which no model made: the one chosen here.
    if (offered(verb).length > 1 && (!extending || !extending.workflowId)) args.workflow = workflow.id;
    if (mode === 'video')
      args.intention = extending
        ? 'Suite demandée dans le Studio.'
        : workflow.follows
          ? 'Personnage remplacé, demandé dans le Studio.'
          : 'Création demandée dans le Studio.';
    // A continuation starts from its clip; the inputs it also takes (subject references) follow.
    if (extending) args.source = outputSource(extending);
    for (const [role, spec] of Object.entries(workflow.roles)) {
      if (extending && role === 'source') continue;
      // Never an input without a source (an image of a proposal that was joined to its message).
      const chosen = (draft.inputs[role] ?? []).filter(item => item?.source).map(item => item.source);
      // What the model cannot do without is asked for here, in the user's words.
      if (spec.required && spec.count && !chosen.length)
        throw Error(
          spec.media.includes('video') ? 'Ajoutez la vidéo à suivre.' : 'Ajoutez l’image du personnage.',
        );
      if (!chosen.length || !spec.count) continue;
      // Several references go as a list; a single one (the character of a video) alone.
      args[role] = (spec.many ?? role === 'reference') ? chosen.slice(0, spec.count) : chosen[0];
    }
    if (workflow.lengths?.seconds.length) args.duration = draft[extending ? 'extension' : 'length'];
    if (workflow.limits && draft.size && !extending) {
      const [width, height] = draft.size.split('x').map(Number);
      if (workflow.direct) Object.assign(args, { width, height });
      else Object.assign(edits, { width, height });
      // A large picture is a final, a small one a draft: the profile only names it here.
      if (workflow.stages) args.stage = stageOf(workflow);
    }
    if (draft.seed.trim() && workflow.seeded) {
      const seed = Number(draft.seed);
      if (!Number.isSafeInteger(seed) || seed < 0) throw Error('Seed : un entier positif, ou vide pour un tirage.');
      args.seed = seed;
    }
    for (const setting of workflow.settings) {
      const value = draft.settings[workflow.id]?.[setting.key];
      if (value === undefined || value === '') continue;
      // Read only with an input that does not go with this creation (« Débruitage » without an
      // image to modify): greyed here, and not sent.
      if (setting.onlyWith && onlyInputs(workflow, setting).every(input => args[input] === undefined)) continue;
      args[setting.key] = setting.type === 'string' ? value : Number(value);
    }
    // The LoRAs of the workflow left to the assistant, as chosen here.
    const loras = loraArgs(workflow, draft);
    if (loras) args.loras = loras;
    const styles = workflow.styled && mode !== 'audio' && !extending ? draft.styles.filter(style => style.name) : [];
    return { verb, args, edits, styles };
  }
  // The user sets the Studio to make something: the chat model leaves the GPU now, not at the
  // first « Générer ». Asked in the background, never under an answer, a message waiting for the
  // model or a proposal of Moodix AI; a refusal changes nothing, a generation unloads it anyway.
  function release() {
    if (released || releasing || working || enriching || proposal || ai || blocked()) return;
    released = true;
    releasing = api('studio/release', {})
      .then(() => onChange())
      .catch(() => {})
      .finally(() => {
        releasing = null;
      });
  }
  /**
   * An action on the take on the screen (output-actions.mjs): Prolonger and Animer set the Studio as
   * before; Agrandir et affiner and Interpoler are made at once, from that take.
   */
  function takeAction(record, id) {
    if (working) return;
    if (proposal) return notice('Moodix AI est en train de proposer');
    if (id === 'animate') return animateImage(record);
    if (id === 'extend') return actionsOf(record).find(action => action.id === 'extend')?.run();
    const clip = mediaOf(record) === 'video';
    void generate({
      verb: id,
      args: {
        source: outputSource(record),
        intention: id === 'upscale' ? `Agrandir ${clip ? 'la vidéo' : 'l’image'}.` : 'Rendre la vidéo plus fluide.',
      },
      edits: {},
      styles: [],
    });
  }
  async function generate(given = null) {
    // (Nor from the Studio of another conversation than the one whose work it holds, 0.6.87.)
    if (working || away()) return;
    // An action on a take brings what to make; « Générer » (a click, its keys) does not.
    const onTake = given?.verb ? given : null;
    // The character being checked: the key that generates keeps it, where the question is asked
    // (Image, the button reads « OK »). From another mode, where it reads « Générer », it is no
    // answer: the question comes back on screen instead of being taken for a yes.
    if (!onTake && checking) {
      if (mode === 'image') return checking.resolve('ok');
      setMode('image');
      return notice('Ce personnage vous convient ? Répondez d’abord : OK, Autre image ou Annuler.');
    }
    if (!onTake && answering()) return approve();
    // No creation of its own while the take just made is put on its screen (0.6.88): its end would
    // have ended this one's work. (An answer to Moodix AI above is no such creation.)
    if (settling) return;
    const reason = blocked() || (onTake ? '' : current()?.unavailable);
    if (reason) return notice(reason);
    let wanted;
    try {
      wanted = onTake ?? request();
    } catch (error) {
      failure = error.message;
      return render();
    }
    // Asked once the creation can go (0.6.90): asked before, a « yes » cost the conversation set aside
    // for a creation that then did not go (an image missing, a seed refused).
    if (!mayBegin()) return;
    failure = '';
    const controller = new AbortController(),
      // Where the creation will be kept once made: the mode it was asked in.
      asked = mode,
      former = legacy;
    let made = null;
    working = { label: 'Préparation…', fraction: null, controller };
    // Its conversation from its first instant (0.6.81): the page may show another meanwhile, the
    // creation is still this one's, and the page follows it there.
    const conversationId = former ? info.legacyId : await ensureConversation();
    holdAt(conversationId);
    if (!former) onWork(conversationId, wanted.args?.prompt ?? '');
    render();
    onChange();
    const pause = () => new Promise(resolve => setTimeout(resolve, 700));
    try {
      await releasing;
      let proposed = await (
        await api('tools/action', {
          conversationId,
          // Its takes are numbered in this project (« PRISE n »).
          project: project(),
          studio: true,
          name: wanted.verb,
          arguments: wanted.args,
          ...(wanted.styles.length ? { styles: wanted.styles } : {}),
        })
      ).json();
      working.requestId = proposed.requestId;
      // The size chosen here, where the workflow sets its own.
      const shown = proposed.plan?.parameters ?? {},
        edits = Object.fromEntries(Object.entries(wanted.edits).filter(([key, value]) => shown[key] !== value));
      if (Object.keys(edits).length) {
        proposed = await (
          await api('tools/revise', { requestId: proposed.requestId, approvalToken: proposed.approvalToken, edits })
        ).json();
        working.requestId = proposed.requestId;
      }
      controller.signal.throwIfAborted();
      if (run && !former) {
        // In the conversation: followed and written there like a creation of the chat.
        const done = await run(proposed, {
          signal: controller.signal,
          conversationId,
          onProgress: (label, fraction, preview, time) => {
            if (!working) return;
            Object.assign(working, {
              label: typeof label === 'string' && label ? label : working.label,
              fraction: Number.isFinite(fraction) ? fraction : working.fraction,
              preview: preview ?? working.preview,
            });
            timeWork(time);
            progress();
          },
        });
        if (!done.record)
          throw Error(controller.signal.aborted ? 'Génération arrêtée.' : done.error || 'La génération a échoué.');
        made = done.record.id;
      } else {
        let job = await (
          await api('tools/execute', {
            requestId: proposed.requestId,
            permission: 'once',
            studio: true,
            ...(proposed.mediaType ? { approvalToken: proposed.approvalToken } : {}),
          })
        ).json();
        const jobId = job.id;
        let listed = false;
        while (!['done', 'error', 'cancelled'].includes(job.state)) {
          Object.assign(working, {
            label: job.progress || 'Génération…',
            fraction: job.fraction ?? null,
            preview: job.previewUrl ?? working.preview,
          });
          timeWork(job.elapsed);
          // The result is shown as soon as it exists.
          if (job.record && !listed) {
            listed = true;
            await refresh().catch(() => {});
            render();
          }
          progress();
          await pause();
          job = await (await api('tools/job')).json();
          if (job?.id !== jobId) throw Error('La génération suivie a été remplacée par une autre tâche.');
        }
        if (!job.record)
          throw Error(controller.signal.aborted ? 'Génération arrêtée.' : job.error || 'La génération a échoué.');
        made = job.record.id;
      }
      if (extending) extending = null;
    } catch (error) {
      failure = controller.signal.aborted ? 'Génération arrêtée.' : error.message;
    } finally {
      working = null;
      // Held until its take is on its own screen (settling, 0.6.87).
      settling = true;
      try {
        await refresh().catch(() => {});
        // It stays on the screen, as the gallery lists it (with the addresses it is shown from).
        const record = made && runs.find(item => item.id === made);
        if (record) {
          kept[asked] = record;
          // Made from what was looked at: those settings are the user's now, nothing to come back to.
          endLook();
        }
        settledHere();
      } finally {
        settling = false;
      }
      onChange();
      render();
      scrollStrip();
      // The page's work is over; left meanwhile, the Studio goes to the conversation shown.
      if (!former) onWork(null);
      letGo();
    }
  }
  function stop() {
    if (!working) return;
    if (working.external) return stopTurn();
    working.controller.abort();
    if (working.requestId) api('tools/cancel', { requestId: working.requestId }).catch(() => {});
  }
  /**
   * How long the take under way has been in the making (0.6.93), beside its step: the count of the
   * server (`time`, the fourth value of a progress), going on by itself between two of its answers;
   * for the work it was given for only (`timed`): the next one counts from its own go.
   */
  let elapsedNode = null,
    timed = null;
  const elapsed = elapsedClock(text => {
    if (!working || timed !== working) return elapsed.stop();
    working.time = text;
    if (elapsedNode) elapsedNode.textContent = text;
  });
  function timeWork(time) {
    if (!working) return;
    if (timed !== working) {
      elapsed.reset();
      timed = working;
    }
    elapsed.update(time);
  }
  /** Updates the button and the screen alone: the form keeps its focus while a generation runs. */
  function progress() {
    if (!working) return;
    if (working.preview) seenPreview = working.preview;
    // Held by another conversation than the one shown (0.6.81): the page shows that it is, not the take.
    if (away()) return;
    const go = document.querySelector?.('#studio-view .studio-go'),
      line = $('studio-progress');
    const known = Number.isFinite(working.fraction) && working.fraction !== null,
      percent = known ? Math.round(Math.min(1, Math.max(0, working.fraction)) * 100) : null;
    if (go) {
      go.classList.toggle('is-indeterminate', !known);
      go.style.setProperty('--studio-progress', known ? String(percent / 100) : '0');
      const label = go.querySelector('.studio-go-label');
      if (label) label.textContent = known ? `En cours · ${percent} %` : 'En cours…';
      go.setAttribute('aria-valuenow', known ? String(percent) : '');
    }
    if (line) {
      line.hidden = false;
      line.textContent = working.label || '';
      // (Its time stays beside it: the words of the step change, not the count.)
      if (elapsedNode) line.append(elapsedNode);
    }
    // A sound lights its bars as it goes.
    const bars = document.querySelectorAll?.('#studio-view .studio-bars span') ?? [];
    bars.forEach((bar, index) => bar.classList.toggle('is-lit', known && index < (percent * bars.length) / 100));
    // What the generator has so far, on the screen, through the Flux (take-flux.mjs, capture 24): the
    // start image until a picture comes, else the colours of the room. The frame is rebuilt with the page.
    const frame = document.querySelector?.('#studio-view .studio-frame');
    if (frame && mode !== 'audio') {
      if (flux?.frame !== frame) {
        flux?.flux.stop();
        flux = { frame, flux: takeFlux(frame, { node }) };
        const start = drafts[mode].inputs.start_image?.[0]?.preview;
        if (start) flux.flux.source(start);
        else flux.flux.neutral();
      }
      if (Number.isFinite(working.fraction)) flux.flux.progress(working.fraction);
    }
    if (frame && working.preview) {
      if (live?.frame !== frame)
        live = { frame, preview: livePreview(node, frame, { onLoad: picture => flux?.flux.source(picture) }) };
      live.preview.show(working.preview);
    }
    // The creation under way at the left of the Sortie says how far it is.
    const making = document.querySelector?.('#studio-view .studio-item.is-making .studio-item-meta');
    if (making) making.textContent = known ? percent + ' %' : '';
  }

  // ------------------------------------------------------------------ Moodix AI sets the Studio
  /** Said to screen readers while the pointer works; nothing shown: a touch of the user takes over. */
  function status(on) {
    const live = $('live-status');
    if (live && on) live.textContent = 'Moodix AI règle le Studio.';
  }
  /** Where the pointer goes for a setting: the element that wears its key. */
  const targetOf = key => {
    if (key !== 'kind') return document.querySelector?.(`#studio-view [data-ai="${key}"]`);
    const tab = document.querySelector?.(`#studio-kinds [data-mode="${proposal?.mode ?? mode}"]`);
    return tab && tab.checkVisibility?.({ visibilityProperty: true }) !== false ? tab : null;
  };
  /**
   * The pointer glides to `element` (0.25 s), saying what it does; false once it was stopped. The
   * first time it appears there, without a way to go: nothing to wait for.
   */
  async function glide(element, label, anchor) {
    if (!ai || ai.stopped) return false;
    const travels = Boolean(pointer?.visible);
    pointer?.move(element, label, anchor);
    await wait(pointer?.reduced() || !travels ? 0 : 260);
    return Boolean(ai && !ai.stopped);
  }
  /**
   * One step of the pointer, the whole animation in 2 to 3 s (16/11): it goes (0.25 s), it rings, it
   * sets, it leaves a trace. `hold`: what the change itself takes, a model or a setting 0.3 s (the
   * ring, the new value, the trace); a bar moves in its own 0.3 s, a prompt is written in 1 s at most.
   */
  async function stepTo(key, label, apply, { anchor, hold = 0, rare = false } = {}) {
    if (!ai || ai.stopped) return false;
    // The prompt is written without a mark (studio-maquette.md): no ring, no trace on it.
    const marked = key !== 'prompt';
    // `rare`: a setting under « Plus de réglages », opened for it: the pointer does not go to what
    // is folded, and the user sees the value it sets, theirs to change before « Générer ».
    if (rare) advanced = true;
    ai.active = marked ? key : null;
    render();
    if (!(await glide(targetOf(key), label, anchor))) return false;
    if (hold) await wait(hold / 2);
    await apply();
    if (hold) {
      render();
      await wait(hold / 2);
    }
    if (!ai || ai.stopped) return false;
    if (marked) ai.touched.add(key);
    ai.active = null;
    render();
    pointer?.follow(targetOf(key), anchor);
    return Boolean(ai && !ai.stopped);
  }
  /** The prompt written as it is typed: about 40 letters a second, 1 s at most whatever its length (16/11). */
  async function typePrompt(draft, text, { instant = false } = {}) {
    const box = document.querySelector?.('#studio-view [data-ai="prompt"]');
    if (instant || pointer?.reduced() || !box) {
      draft.prompt = text;
      return;
    }
    const length = Math.min(1000, (text.length / 40) * 1000),
      ticks = Math.max(1, Math.round(length / 33)),
      step = Math.max(1, Math.ceil(text.length / ticks));
    for (let index = step; index < text.length + step; index += step) {
      if (!ai || ai.stopped) return;
      draft.prompt = text.slice(0, index);
      box.value = draft.prompt;
      box.scrollTop = box.scrollHeight;
      await wait(length / ticks);
    }
    draft.prompt = text;
  }
  // Where a take goes, said by the pointer: « pose la prise 26 en fin ».
  const WHERE = {
    start_image: 'en début',
    end_image: 'en fin',
    reference: 'en référence',
    source: 'à modifier',
    source_video: 'en vidéo à suivre',
  };
  /**
   * A take of the project put in its case (studio-maquette.md, step 2): the pointer goes to the case
   * carrying the take, the case grows and shows it (0.2 s), and it is put down. A reference that is
   * no take is put at once.
   */
  async function dragIn(draft, entry, { instant = false } = {}) {
    const put = () => ((draft.inputs[entry.role] ??= [])[entry.index] = entry.item);
    const record = entry.ref.output_id ? runs.find(item => item.id === entry.ref.output_id) : null,
      take = record?.outputs?.[entry.ref.output_index ?? 0]?.take;
    if (instant || !pointer || pointer.reduced() || !record) {
      put();
      return true;
    }
    const label = 'pose ' + (Number.isInteger(take) ? 'la prise ' + take : 'l’image') + ' ' + (WHERE[entry.role] ?? ''),
      caseOf = () => document.querySelector?.(`#studio-view .studio-slot[data-slot="${entry.role}-${entry.index}"]`);
    aiCarry = { id: record.id, role: entry.role, index: entry.index, preview: entry.item.preview, over: false };
    pointer.carry(entry.item.preview, Number.isInteger(take) ? 'PRISE ' + take : '');
    render();
    if (!(await glide(caseOf(), label))) return false;
    aiCarry.over = true;
    render();
    // It marks 0.2 s over its case (16/11): the case grown, the take shown in it.
    await wait(200);
    if (!ai || ai.stopped) return false;
    put();
    aiCarry = null;
    pointer.carry(null);
    render();
    return Boolean(ai && !ai.stopped);
  }
  /**
   * Shows a proposal of Moodix AI in the Studio. What its workflow leaves to the assistant is
   * set by the pointer, the rest is shown as it will be made; the pointer stops on « Générer »
   * and waits. Resolves 'once' when the user generates (their changes sent first), 'deny' when
   * they decline; rejects when the turn is stopped.
   */
  function propose(request, signal) {
    const target = MODE_OF_VERB[request.tool || request.call?.function?.name] ?? request.mediaType ?? 'image';
    return new Promise((resolve, reject) => {
      const settle = () => {
        signal?.removeEventListener('abort', abort);
        endPointer();
      };
      const abort = () => {
        settle();
        proposal = null;
        failure = '';
        releaseInputs(mine);
        render();
        letGo();
        reject(signal.reason || new DOMException('Annulé', 'AbortError'));
      };
      const mine = {
        request,
        mode: target,
        values: null,
        touched: new Set(),
        signal,
        resolve: decision => {
          settle();
          resolve(decision);
        },
      };
      proposal = mine;
      // Its conversation, the one shown (0.6.81): left meanwhile, the proposal waits there.
      holdAt();
      signal?.addEventListener('abort', abort, { once: true });
      // Locked from now until the pointer rests on « Générer », or the proposal goes (endPointer).
      lockStudio(true);
      legacy = false;
      failure = '';
      const shown = reveal();
      void (async () => {
        // The Studio comes on screen first (from the chat, its movement), then the pointer works.
        try {
          await shown;
        } catch {
          // The view changed anyway, or did not: the proposal is shown where it is.
        }
        const verb = request.tool || request.call?.function?.name;
        // The tools read ahead may predate the workflow it proposes (the engine just ready, a
        // workflow switched on): read again, rather than wait for a « Générer » with nothing to set.
        if (!info || !offered(verb).some(item => item.name === request.workflowName)) await load().catch(() => {});
        if (!proposal || proposal.request !== request) return;
        if (!offered(verb).length) {
          // Still nothing to set it with: said to the chat, which would otherwise wait for good.
          settle();
          proposal = null;
          render();
          letGo();
          reject(
            new Error('Le Studio n’a aucun workflow prêt pour cette création : vérifiez Paramètres › Workflows.'),
          );
          return;
        }
        proposal.values = proposedValues(request, offered(verb));
        await animate(proposal);
      })();
    });
  }
  async function animate(current) {
    const { values, request } = current,
      target = current.mode,
      list = offered(values.verb),
      workflow = list.find(item => item.id === values.workflow) ?? list[0],
      draft = drafts[target];
    if (!workflow) {
      lockStudio(false);
      return render();
    }
    ai = { stopped: false, active: null, touched: new Set() };
    status(true);
    // What the assistant may not change is shown at once, as it will be made.
    if (values.source)
      extending = runs.find(item => item.id === values.source) ?? { id: values.source, prompt: '', parameters: {} };
    else if (values.sourceResource) {
      // A clip of the disk (« #ref1 »): continued like a take. It is not in the Sortie, so it is put
      // on the screen, where the user sees what is continued. (Left out, the Studio showed the cases
      // of a new video, all empty, while the proposal continued that clip.)
      const size = request.resolution ?? {};
      extending = resourceRecord(assets.resource?.(values.sourceResource) ?? { id: values.sourceResource }, 'video', {
        name: values.sourceLabel,
        width: size.width,
        height: size.height,
      });
      kept[target] = extending;
      pinned = extending.id;
    } else if (target === 'video') extending = null;
    // Kept with the proposal: it stays the continuation of that clip whatever mode the user looks
    // at while it waits (setMode gives it back with Vidéo).
    current.extending = target === 'video' ? extending : null;
    if (!values.sizeFree && values.size && !extending) {
      draft.format = values.format ?? draft.format;
      draft.size = values.size;
    }
    current.seedBefore = draft.seed;
    if (values.seed !== null) draft.seed = String(values.seed);
    // The LoRAs of the workflow as the proposal has them: on with their strength, the others off.
    if (values.loras && workflow.loras?.length) {
      const chosen = new Map(values.loras.map(item => [item.id, item.strength]));
      for (const item of workflow.loras) {
        const choice = loraChoice(workflow, item, draft);
        choice.on = chosen.has(item.id) || !item.assistant;
        if (chosen.has(item.id) && Number.isFinite(chosen.get(item.id))) choice.strength = chosen.get(item.id);
      }
      current.lorasShown = JSON.stringify(loraArgs(workflow, draft));
    }
    if (!values.promptFree) draft.prompt = values.prompt;
    for (const [key, value] of Object.entries(values.settings))
      if (!values.settingsFree[key]) (draft.settings[workflow.id] ??= {})[key] = value;
    const steps = [];
    if (mode !== target) steps.push(['kind', 'passe en ' + modeOf(target).label, () => setMode(target)]);
    // Its model, with the LoRAs of its family (takeModel), as when the user chooses it in the list.
    if (draft.workflow !== workflow.id && list.length > 1)
      steps.push(['model', 'choisit ' + workflow.name, () => takeModel(draft, target, workflow), { hold: 300 }]);
    else takeModel(draft, target, workflow);
    if (values.promptFree)
      steps.push(['prompt', 'écrit le prompt', options => typePrompt(draft, values.prompt, options), { anchor: { ax: 34, ay: 30 } }]);
    // Its cases are those of the proposal, and no other: an image the user had left in a case is not
    // part of what will be made, and shown there it said the contrary (a proposal without images
    // left them all in place). Each image of the proposal then goes in its case, one after the other:
    // a take of the project is carried there (dragIn).
    draft.inputs = {};
    for (const entry of referenceInputs(values.references))
      steps.push(['inputs', '', options => dragIn(draft, entry, options), { own: true }]);
    if (values.sizeFree && values.format && values.format !== draft.format && !extending)
      steps.push([
        'ratio',
        'passe en ' + values.format,
        () => Object.assign(draft, { format: values.format, size: values.size }),
      ]);
    else if (values.sizeFree && values.size)
      Object.assign(draft, { format: values.format ?? draft.format, size: values.size });
    if (values.framesFree && values.seconds !== null && workflow.lengths)
      steps.push([
        'duration',
        'règle la durée',
        // The handle of the bar goes from where it is to the length proposed, notch after notch, in
        // 0.3 s whatever their number (16/11).
        async ({ instant = false } = {}) => {
          const key = extending ? 'extension' : 'length',
            list = workflow.lengths.seconds,
            near = list.reduce((best, value) =>
              Math.abs(value - values.seconds) < Math.abs(best - values.seconds) ? value : best,
            ),
            from = list.indexOf(lengthOf(workflow)?.value),
            to = list.indexOf(near);
          values.lengthShown = near;
          if (!instant && pointer && !pointer.reduced() && from >= 0 && from !== to) {
            const way = Math.sign(to - from),
              pause = 300 / Math.abs(to - from);
            for (let at = from + way; ; at += way) {
              if (!ai || ai.stopped) break;
              draft[key] = list[at];
              render();
              await wait(pause);
              if (at === to) break;
            }
          }
          draft[key] = near;
        },
      ]);
    // (A setting on a bar, « Débruitage », shows its default until it is set: proposed at that
    // value, nothing moves. Set, « Plus de réglages » opens on it: see stepTo.)
    const onBar = key => {
      const setting = workflow.settings.find(item => item.key === key);
      return setting && fineSetting(setting) ? setting : null;
    };
    const shown = key => {
      const value = draft.settings[workflow.id]?.[key];
      return onBar(key) ? fineValue(onBar(key), value) : (value ?? '');
    };
    for (const [key, value] of Object.entries(values.settings))
      if (values.settingsFree[key] && String(shown(key)) !== String(value))
        steps.push([
          'setting-' + key,
          'règle ' + (SETTINGS[key] || key).toLowerCase(),
          () => {
            (draft.settings[workflow.id] ??= {})[key] = value;
            if (key === 'lyrics' && value) draft.lyrics = true;
            if (onBar(key)) advanced = true;
          },
          { hold: 300, rare: Boolean(onBar(key)) },
        ]);
    // With less motion asked, nothing moves: the end shows at once.
    const still = Boolean(pointer?.reduced());
    let done = 0;
    for (const [key, label, apply, options] of steps) {
      if (still) await apply({ instant: true });
      else if (!(await (options?.own ? apply() : stepTo(key, label, apply, options)))) break;
      done++;
    }
    if (done < steps.length) {
      if (proposal !== current) return;
      // The pointer stopped before the end (« Générer » pressed from elsewhere): what is left is set
      // at once, the proposal whole. The user cannot stop it: the Studio is locked (16/11).
      for (const [, , apply] of steps.slice(done)) await apply({ instant: true });
      lockStudio(false);
      return render();
    }
    if (!ai || ai.stopped || proposal !== current) return;
    // A character Moodix AI has just made: the pointer has the prompt written from the video and
    // that image, with the wand (the chat model comes back for it, then leaves the card again).
    if (request.scene && sceneInputs())
      if (!(await stepTo('enrich', 'écrit le prompt d’après la vidéo et le personnage', () => writeScene(current))))
        return;
    if (!ai || ai.stopped || proposal !== current) return;
    // The values it reached are those of the proposal: what changes after that is the user's.
    current.touched = new Set(ai.touched);
    ai.active = 'generate';
    render();
    const auto = request.autoAllow === true;
    pointer?.move(
      targetOf('generate'),
      // An image of a series the user asked for goes by itself whatever the settings (image-series.mjs).
      request.series
        ? `lance l’image ${request.series.index} sur ${request.series.total} demandée`
        : auto
          ? 'lance la génération (autorisé dans les Paramètres)'
          : 'attend votre accord',
    );
    await wait(still ? 0 : 260);
    if (!ai || ai.stopped || proposal !== current) return;
    status(false);
    if (auto) {
      endPointer();
      return approve();
    }
    // It stays on « Générer », « Refuser » beside it, until the user answers (studio-maquette.md):
    // the Studio is theirs again, its settings, « Refuser » and « Générer » (16/11).
    ai.waiting = true;
    lockStudio(false);
  }
  /**
   * The model of a draft set without the list (a proposal of Moodix AI): the LoRAs the user added
   * follow their family, as in choose(). Left in place, those made for Krea 2 stayed on under MOSS
   * Image and went with the next « Générer » by hand.
   */
  function takeModel(draft, target, workflow) {
    const models = modelsOf(target),
      held = models.find(item => item.id === draft.workflow) ?? models.find(item => !item.unavailable) ?? models[0];
    if (held && held.family !== workflow.family) {
      draft.shelved[held.family] = draft.styles;
      draft.styles = draft.shelved[workflow.family] ?? [];
    }
    draft.workflow = workflow.id;
  }
  /** The images of a proposal, each with the slot of its role: [{ role, index, item, ref }]. */
  function referenceInputs(references) {
    const counts = {};
    return references.map((ref, index) => {
      const resource = ref.resource_id ? assets.resource?.(ref.resource_id) : null,
        record = ref.output_id ? runs.find(item => item.id === ref.output_id) : null,
        output = record?.outputs?.[ref.output_index ?? 0] ?? null,
        // The role as the verb names it (a video to follow is its « source »), else the slot's.
        role = ref.as ?? (ref.role in ROLES ? ref.role : ref.role === 'msr_image' ? 'reference' : ref.role),
        width = resource?.width ?? output?.width ?? record?.parameters?.width,
        height = resource?.height ?? output?.height ?? record?.parameters?.height;
      const item = {
        source: ref.resource_id
          ? { resource: ref.resource_id }
          : ref.output_id
            ? { output: ref.output_id, ...(ref.output_conversation ? { conversation: ref.output_conversation } : {}) }
            : null,
        // An image joined to the message is neither a take nor a reference of the project: its
        // picture is the one the server gives for the card of the proposal (`preview`).
        preview:
          resource?.previewUrl || resource?.originalUrl || output?.thumbUrl || output?.originalUrl || ref.preview || '',
        name: ref.label || ref.roleLabel || ROLES[role] || 'Entrée',
        ...(width > 0 && height > 0 ? { width, height } : {}),
        ref: index,
        role,
      };
      counts[role] = (counts[role] ?? -1) + 1;
      return { role, index: counts[role], item, ref };
    });
  }
  function endPointer() {
    if (ai) ai.stopped = true;
    ai = null;
    aiCarry = null;
    lockStudio(false);
    status(false);
    pointer?.carry(null);
    pointer?.hide();
    render();
  }
  /**
   * A touch of the user once the pointer rests on « Générer » (« Générer » itself too): the pointer
   * goes, the proposal stays theirs to change; nothing is drawn again (a click there, or on « Refuser »,
   * keeps the button it was pressed on). While it works nothing takes over: the Studio is locked.
   */
  function takeOver() {
    if (!ai || aiWorking) return;
    ai.stopped = true;
    ai = null;
    status(false);
    pointer?.hide();
  }
  /** What the user changed in the Studio from the proposal, as the server takes it. */
  function edits() {
    const { values, request } = proposal,
      plan = request.plan || {},
      items = new Map((plan.editable?.parameters || []).map(item => [item.key, item])),
      draft = drafts[proposal.mode],
      workflow = offered(values.verb).find(item => item.id === values.workflow) ?? current(),
      changes = {};
    const prompt = draft.prompt.trim();
    if (!prompt) throw Error('Écrivez un prompt.');
    if (plan.editable?.prompt && prompt !== values.prompt.trim()) changes.prompt = prompt;
    if (
      values.size &&
      draft.size &&
      draft.size !== values.size &&
      items.has('width') &&
      items.has('height') &&
      !extending
    ) {
      const stage = workflow?.stages ? stageOf(workflow, draft.size) : null,
        [width, height] = draft.size.split('x').map(Number);
      // The size chosen goes in any case, and with it the version it belongs to when that changes
      // (a large picture is a final). « final » alone gave the size of that profile in the format
      // of the proposal: not the format, nor the size, the Studio showed.
      Object.assign(changes, { width, height });
      if (stage && values.stage && stage !== values.stage && plan.editable?.stages?.includes(stage))
        changes.stage = stage;
    }
    // Only when the pointer set the length of this proposal on its bar (`lengthShown`): a workflow
    // whose length is « Fixe » shows no bar, and what the draft holds then is the length of another
    // model, which went as a change of the user (241 frames proposed, 121 made).
    if (values.lengthShown !== undefined && values.seconds !== null && items.has('frames') && values.fps) {
      const wanted = draft[extending ? 'extension' : 'length'];
      if (Number.isFinite(wanted) && wanted !== values.lengthShown && Math.abs(wanted - values.seconds) > 0.01) {
        let frames = Math.round(wanted * values.fps) + values.overlap;
        const choices = values.framesChoices;
        if (choices?.length)
          frames = choices.reduce((best, value) => (Math.abs(value - frames) < Math.abs(best - frames) ? value : best));
        if (frames !== values.frames) changes.frames = frames;
      }
    }
    const seed = draft.seed.trim();
    if (seed && values.seed !== null && Number(seed) !== values.seed && items.has('seed')) {
      const number = Number(seed);
      if (!Number.isSafeInteger(number) || number < 0) throw Error('Seed : un entier positif.');
      changes.seed = number;
    }
    // The LoRAs of the user for this family, shown with the proposal (added, taken out or left as
    // they were): it is made with them, as « Générer » by hand makes it. Moodix AI proposes none
    // itself: left out here, what the Studio showed was not what was made, and the settings of
    // that take then emptied the list.
    if (workflow?.styled && proposal.mode !== 'audio' && !extending) {
      const styles = draft.styles.filter(style => style.name).map(({ name, strength }) => ({ name, strength }));
      if (JSON.stringify(styles) !== JSON.stringify(request.styles ?? [])) changes.styles = styles;
    }
    // The LoRAs of the workflow switched or set here.
    if (proposal.lorasShown !== undefined && workflow) {
      const now = loraArgs(workflow, draft);
      if (JSON.stringify(now) !== proposal.lorasShown) changes.loras = now ?? {};
    }
    for (const key of Object.keys(values.settings)) {
      const item = items.get(key),
        value = draft.settings[workflow?.id]?.[key];
      if (!item || item.locked || value === undefined || String(value) === String(values.settings[key])) continue;
      changes[key] = item.type === 'string' ? String(value) : Number(value);
    }
    // An image dragged to another slot changes role: said by the name the server gave that role
    // (the slot of the family, « msr_image » for a reference of LTX 2.5), the one it takes back.
    const roles = [];
    for (const [role, list] of Object.entries(draft.inputs))
      for (const item of list ?? []) {
        if (item?.ref === undefined || item.role === role) continue;
        const choice = (values.roleChoices[item.ref] ?? []).find(option => roleOfSlot(workflow, option.role) === role);
        roles.push({ index: item.ref, role: choice?.role ?? role });
      }
    if (roles.length) changes.references = roles;
    return changes;
  }
  /**
   * The proposal is answered (generated, refused, stopped with its turn): the images it put in the
   * slots are the user's from now on. They no longer carry what tied them to it (`ref`, `role`: an
   * image of a proposal changes role only as its workflow offers), and move like any other: kept,
   * « Inverser début et fin » and every drag were refused for good once the proposal was gone.
   */
  function releaseInputs(answered) {
    const inputs = drafts[answered.mode].inputs;
    for (const [role, list] of Object.entries(inputs))
      inputs[role] = (list ?? []).map(item => {
        // An image joined to the message was the proposal's alone: the Studio has nothing to name it
        // by (no take, no reference). Left in its slot, « Générer » by hand sent it as `null`, which
        // the server refuses at each try.
        if (!item?.source) return null;
        const own = { ...item };
        delete own.ref;
        delete own.role;
        return own;
      });
  }
  /** « Générer » on a proposal: the user's changes are sent, then the generation is theirs to watch. */
  async function approve() {
    if (!proposal || working) return;
    if (ai) takeOver();
    const current = proposal,
      { request } = current;
    let changes;
    try {
      changes = edits();
    } catch (error) {
      failure = error.message;
      return render();
    }
    failure = '';
    working = { label: 'Préparation…', fraction: null, external: true };
    render();
    if (Object.keys(changes).length)
      try {
        // Each answer is the proposal anew, under another identifier and another token.
        const revise = async changed => {
          const revised = await (
            await api('tools/revise', {
              requestId: request.requestId,
              approvalToken: request.approvalToken,
              edits: changed,
            })
          ).json();
          Object.assign(request, revised);
          return revised;
        };
        const made = (await revise(changes)).plan?.parameters ?? {};
        // Another version has its own scale for the server: asked with a size, it keeps the format
        // of that size and gives the size of its profile. When that is not the size chosen here, it
        // is asked again, alone (as « Générer » by hand asks it): what is made is what is shown.
        if (
          changes.stage &&
          Number.isInteger(made.width) &&
          Number.isInteger(made.height) &&
          (made.width !== changes.width || made.height !== changes.height)
        )
          await revise({ width: changes.width, height: changes.height });
      } catch (error) {
        working = null;
        failure = error.message;
        return render();
      }
    if (proposal !== current) return;
    proposal = null;
    if (extending) extending = null;
    giveBackSeed(current);
    releaseInputs(current);
    current.resolve('once');
  }
  /**
   * The image of a character Moodix AI made to put in a video, shown to the user before the
   * video is made: « OK » keeps it (the replacement runs at once), « Autre image » has another
   * made from the prompt of the screen (changed or not), « Annuler » stops everything. Resolves
   * { decision: 'ok' | 'again' | 'cancel', prompt }; rejects when the turn is stopped.
   */
  function checkCharacter(record, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => {
        checking = null;
        render();
        letGo();
        reject(signal.reason || new DOMException('Annulé', 'AbortError'));
      };
      // Checked in the conversation shown (0.6.81): left meanwhile, the question waits there.
      holdAt();
      checking = {
        record,
        resolve: decision => {
          signal?.removeEventListener('abort', abort);
          const prompt = drafts.image.prompt.trim();
          checking = null;
          render();
          letGo();
          // Read by screen readers: the question answered.
          $('live-status') &&
            ($('live-status').textContent =
              decision === 'cancel'
                ? 'Remplacement annulé.'
                : decision === 'again'
                  ? 'Autre image du personnage…'
                  : 'Personnage gardé : le remplacement se prépare.');
          resolve({ decision, prompt });
        },
      };
      signal?.addEventListener('abort', abort, { once: true });
      legacy = false;
      failure = '';
      if (mode !== 'image') setMode('image');
      kept.image = runs.find(item => item.id === record.id) ?? record;
      void reveal();
      render();
      $('live-status') &&
        ($('live-status').textContent = 'Image du personnage à vérifier : OK, autre image ou annuler.');
    });
  }
  /** The proposal is declined: from its « Annuler », or by a new message in the chat. */
  function decline() {
    if (checking) {
      checking.resolve('cancel');
      return true;
    }
    if (!proposal || working) return false;
    const current = proposal;
    proposal = null;
    extending = null;
    failure = '';
    giveBackSeed(current);
    releaseInputs(current);
    current.resolve('deny');
    render();
    letGo();
    return true;
  }
  /** The seed drawn for a proposal was its own: the next creation by hand draws again, unless the user typed one. */
  function giveBackSeed(answered) {
    const draft = drafts[answered.mode];
    if (answered.values && draft.seed === String(answered.values.seed)) draft.seed = answered.seedBefore ?? '';
  }
  /**
   * A creation of the conversation shown, made by the server for a page reloaded since (0.6.82): the
   * screen follows it again (follow) until it is over (settled), as one approved here; its stop stops
   * it (stopTurn). False when the Studio already holds a work.
   */
  function followAgain() {
    if (holds()) return false;
    holdAt();
    working = { label: 'Génération en cours…', fraction: null, external: true };
    render();
    return true;
  }
  /**
   * A work of the page began or ended (0.6.86): the Studio is drawn again when what greys « Générer »
   * changes. Drawn last while its own creation, or a turn of Moodix, still counted as a work of this
   * conversation, it said « Moodix répond » and kept « Générer » greyed until it was drawn again.
   */
  function busyChanged() {
    if (away() || !info || !$('studio-body')) return;
    const now = !working && !(gpuBlocked() && !working) && !answering() && !checking ? elsewhere() : '';
    if (now !== busyDrawn) render();
  }
  /** A generation approved here, run by the chat turn: its progress comes from there, with its time. */
  function follow(label, fraction, preview, time) {
    if (!working?.external) return;
    Object.assign(working, {
      label: typeof label === 'string' && label ? label : working.label,
      fraction: Number.isFinite(fraction) ? fraction : working.fraction,
      preview: preview ?? working.preview,
    });
    timeWork(time);
    progress();
  }
  /** The end of a generation approved here: its creation is shown on the screen. */
  async function settled(result) {
    const external = working?.external;
    if (external) working = null;
    // Held until its take is on its own screen (settling, 0.6.87).
    settling = true;
    try {
      await refresh().catch(() => {});
      // Made from the Studio as it is set: its settings are those of that take already.
      settledHere();
      if (result?.record) {
        const record = runs.find(item => item.id === result.record.id) ?? result.record;
        kept[mediaOf(record)] = record;
      } else if (external && result?.error) failure = result.error;
    } finally {
      settling = false;
    }
    render();
    scrollStrip();
    // Left meanwhile (0.6.81): the Studio goes to the conversation shown.
    letGo();
  }

  // ------------------------------------------------------------------ results
  const mediaOf = record => record.mediaType || 'image';
  /** A creation as an input: its run, with its conversation when it is another of the project. */
  const outputSource = record =>
    // A file put on the screen, kept as a reference of the project (inspectFile).
    record.resource
      ? { resource: record.resource }
      : record.conversationId && record.conversationId !== place()
        ? { output: record.id, conversation: record.conversationId }
        : { output: record.id };
  /** What the screen shows: the creation just made or opened from the chat, else the last of its mode. */
  /**
   * The takes of the open conversation: the screen is that conversation's (16/11), with the settings
   * of its last take (adopt). The Sortie is the project's: every take of all its conversations, a new
   * conversation included. (The former Studio, read alone, has all of its own.)
   */
  const ownRuns = () =>
    legacy ? runs : runs.filter(record => !record.conversationId || record.conversationId === conversation());
  function onStage() {
    if (working) return null;
    return kept[mode] ?? ownRuns().find(item => mediaOf(item) === mode) ?? null;
  }
  /** The image model « Modifier » works with: the one in hand when it takes an image to modify, else the first that does. */
  function editor() {
    const list = offered('create_image').filter(item => !item.unavailable && takesImages(item, 'source')),
      held = modelsOf('image').find(item => item.id === drafts.image.workflow);
    return list.find(item => item.id === held?.id) ?? list[0] ?? null;
  }
  // Agrandie (Real-ESRGAN) or interpolée (RIFE): made from a clip too (its « source_video »), but the
  // whole clip again, not its continuation (17/11: they were said « ↳ SUITE », their length « + »).
  const TRANSFORMED = { realesrgan_video: 'AGRANDIE', rife: 'INTERPOLÉE' };
  const transformOf = record => TRANSFORMED[record.parameters?.pipeline] ?? null;
  /** The clip a continuation goes on from; none for anything else. */
  const sourceOf = record =>
    transformOf(record) ? undefined : record.parameters?.references?.find(ref => ref.role === 'source_video')?.output_id;
  /** The clip an upscale or an interpolation was made from. */
  const transformedFrom = record =>
    transformOf(record) ? record.parameters?.references?.find(ref => ref.role === 'source_video')?.output_id : undefined;
  async function remove(record) {
    try {
      // A creation of another conversation of the project leaves that conversation.
      await api('studio/delete', { id: record.id, conversationId: record.conversationId ?? place() });
      // A later reply of the chat that names it no longer draws it from what was read before.
      forgetCitedTakes();
      if (extending?.id === record.id) extending = null;
      for (const key of Object.keys(kept)) if (kept[key].id === record.id) delete kept[key];
      await refresh();
      // A take deleted here leaves the settings in hand as they are (not those of the take before it).
      settledHere();
    } catch (error) {
      notice(error.message);
    }
    render();
  }
  // ------------------------------------------------------------------ the Sortie
  // (moodix-design.md 15, 15 bis, 22-24; 7 bis 7, 8, 11): pictures only, the newest at the left
  // with the largest number; one round button on each (Prolonger, Animer), the bin on hover or
  // focus, all of them and « Détails » under a right click or a long press; a click shows it whole
  // with its details; a deletion is asked on the picture itself.
  const KIND = { video: 'Clip', image: 'Image', audio: 'Son' };
  // What the Sortie shows: the whole project, images, clips and sounds (16/11: its button at the
  // right is pressed to begin with); released, the kind of the mode only.
  const SORTS = [
    { id: 'all', icon: 'grid', label: 'Tout', none: 'Aucune création dans ce projet pour l’instant' },
    // A mode without takes (etats-maquette.md, 55): what the Sortie will hold, the last at the left.
    { id: 'image', icon: 'image', label: 'Images', none: 'Rien pour l’instant. Vos images apparaîtront ici, la dernière à gauche.' },
    { id: 'video', icon: 'video', label: 'Vidéos', none: 'Rien pour l’instant. Vos vidéos apparaîtront ici, la dernière à gauche.' },
    { id: 'audio', icon: 'wave', label: 'Sons', none: 'Rien pour l’instant. Vos sons apparaîtront ici, la dernière à gauche.' },
  ];
  let sortieAll = true; // the Sortie shows the whole project, not only the kind of the mode
  let menuFor = null, // the creation whose menu is open
    confirmFor = null, // the creation whose deletion waits for its confirmation
    pressed = false; // a long press opened a menu: the click that ends it selects nothing
  // The size of each image shown, read from the picture itself: a record does not keep it.
  const measured = new Map();
  /** Puts an image of the Sortie in a slot of a mode (`index`: which one of its role). */
  function useImage(record, target, role, index = 0) {
    setMode(target);
    extending = null;
    putCreation(record, role, index);
    $('studio-view')?.scrollTo?.({ top: 0, behavior: 'smooth' });
  }
  /**
   * « Modifier »: the image is the one to modify of the next image. The model in hand may take none
   * (MOSS Image) while another does (Krea 2): that one is then chosen, as « Animer » chooses its
   * video model; left in hand, the image went into a slot no one saw and nothing happened.
   */
  function editImage(record) {
    const model = editor();
    if (!model || working) return;
    if (proposal?.mode === 'image') return notice('Moodix AI est en train de proposer');
    setMode('image');
    if (current()?.id !== model.id) choose(model.id);
    putCreation(record, 'source', 0);
    $('studio-view')?.scrollTo?.({ top: 0, behavior: 'smooth' });
  }
  /** A creation of the Sortie (of any conversation of the project) in a slot of the mode shown. */
  function putCreation(record, role, index = 0) {
    (drafts[mode].inputs[role] ??= [])[index] = creationInput(record);
    failure = '';
    followFormat(role);
    render();
  }
  /** Where « Animer » puts a picture: the first video model, its references, else its start image. */
  function animation() {
    const video = offered('create_video')[0];
    if (!video) return null;
    const role = takesImages(video, 'reference')
      ? 'reference'
      : takesImages(video, 'start_image')
        ? 'start_image'
        : null;
    return role ? { video, role } : null;
  }
  /**
   * « Animer » (7 bis 11): the picture goes to the first video model, among its references, or as
   * its start image when it takes none; nothing is added when it is there already. Not while a
   * proposal of Moodix AI waits.
   */
  function animateImage(record) {
    const target = animation();
    if (!target || working) return;
    if (proposal) return notice('Moodix AI est en train de proposer');
    const { video, role } = target,
      draft = drafts.video;
    setMode('video');
    extending = null;
    if (current()?.id !== video.id) choose(video.id);
    const given = Object.values(draft.inputs).some(list =>
      (list ?? []).some(item => item?.source?.output === record.id),
    );
    if (given) return;
    if (role === 'start_image') return useImage(record, 'video', role, 0);
    const list = (draft.inputs.reference ?? []).filter(Boolean),
      clash = exclusiveWith(video, 'reference');
    if (clash.length) return notice(`Ne se combine pas avec : ${clash.map(other => ROLES[other]).join(', ')}`);
    if (list.length >= video.roles.reference.count) return notice('Toutes les cases d’images sont prises.');
    draft.inputs.reference = list;
    useImage(record, 'video', 'reference', list.length);
  }
  /** « Détails » of a creation: shown whole, its details beside it (what a click on it does). */
  function showDetails(record) {
    menuFor = confirmFor = null;
    render();
    viewOutput(record, 0);
  }
  function askDelete(record) {
    menuFor = null;
    confirmFor = record.id;
    render();
    document.querySelector?.('#studio-view .studio-confirm-no')?.focus?.();
  }
  function openMenu(record) {
    if (working) return;
    confirmFor = null;
    menuFor = record.id;
    render();
    document.querySelector?.('#studio-view .studio-item-menu button')?.focus?.();
  }
  /** Back on the picture of a creation, its menu or its question closed. */
  function backTo(record) {
    menuFor = confirmFor = null;
    render();
    document.querySelector?.(`#studio-view .studio-item[data-id="${record.id}"] .studio-item-pick`)?.focus?.();
  }
  /**
   * Why a clip cannot be continued now, or '' when it can: a proposal of Moodix AI waits (the Studio
   * shows what it will make, as for « Animer »), or no workflow continues a video here. Then
   * « Prolonger » is greyed with that reason, as on the bar of the screen (output-actions.mjs): set
   * all the same, it left the Studio with « Aucun workflow prêt » and nothing to come back with.
   */
  function cannotExtend() {
    if (proposal) return 'Moodix AI est en train de proposer';
    const list = info?.tools?.extend_video ?? [];
    if (list.some(item => !item.unavailable)) return '';
    return list[0]?.unavailable || 'Aucun workflow ne sait prolonger une vidéo.';
  }
  /** What can be done with a creation: Prolonger or Animer first, then Modifier, Détails, Supprimer. */
  function actionsOf(record) {
    const media = mediaOf(record),
      list = [];
    if (media === 'video') {
      const held = cannotExtend();
      list.push({
        id: 'extend',
        label: 'Prolonger',
        glyph: 'act-extend',
        title: held ? 'Prolonger · écrire la suite de ce clip\n' + held : 'Prolonger · écrire la suite de ce clip',
        off: Boolean(held),
        run: () => {
          if (working) return;
          const refused = cannotExtend();
          if (refused) return notice(refused);
          // A continuation is made in Vidéo. The Sortie shows the whole project in every mode: pressed
          // from Image or Son, the clip made of that mode a continuation without its banner (no
          // « Annuler », no format, « Générer la suite » sending the clip as the source of an image).
          if (mode !== 'video') setMode('video');
          extending = record;
          failure = '';
          menuFor = confirmFor = null;
          render();
          $('studio-view')?.scrollTo?.({ top: 0, behavior: 'smooth' });
        },
      });
    }
    if (media === 'image' && animation())
      list.push({
        id: 'animate',
        label: 'Animer',
        glyph: 'act-animate',
        title: proposal ? 'Moodix AI est en train de proposer' : 'Animer · en faire une vidéo',
        off: Boolean(proposal),
        run: () => animateImage(record),
      });
    // Not in the design, kept: an image starts the next one, with a model that takes one. Held while
    // Moodix AI proposes an image: the slots of Image are those of its proposal.
    if (media === 'image' && editor())
      list.push({
        id: 'edit',
        label: 'Modifier',
        glyph: 'edit',
        title: proposal?.mode === 'image' ? 'Moodix AI est en train de proposer' : 'Modifier · repartir de cette image',
        off: proposal?.mode === 'image',
        run: () => editImage(record),
      });
    list.push({ id: 'details', label: 'Détails', glyph: 'info', title: 'Détails', run: () => showDetails(record) });
    list.push({
      id: 'delete',
      label: 'Supprimer',
      glyph: 'trash',
      title: 'Supprimer de cette conversation (le fichier reste dans le dossier output)',
      danger: true,
      run: () => askDelete(record),
    });
    return list;
  }
  /** A round button on the picture: its icon, its name and the creation's for screen readers. */
  function onPicture(action, className, name) {
    const control = button(className + (action.off ? ' is-off' : ''), '', action.run, action.glyph);
    control.setAttribute('aria-label', action.label + ' · ' + name);
    control.title = action.title;
    // Off while a proposal waits, it says why on hover, on focus, and when it is pressed.
    if (action.off) control.setAttribute('aria-disabled', 'true');
    control.disabled = Boolean(working);
    return control;
  }
  function item(record, next = null) {
    const media = mediaOf(record),
      output = record.outputs[0] ?? {},
      number = numberOf(record),
      name = (KIND[media] ?? 'Création') + ' #' + number,
      from = media === 'video' && sourceOf(record) ? numberOf({ id: sourceOf(record), mediaType: 'video' }) : null,
      // An upscale or an interpolation of a clip: the clip it was made from.
      transform = media === 'video' ? transformOf(record) : null,
      origin = transform && transformedFrom(record) ? numberOf({ id: transformedFrom(record), mediaType: 'video' }) : null,
      said = [
        name,
        from ? 'suite du clip #' + from : '',
        transform ? (transform === 'AGRANDIE' ? 'agrandissement' : 'interpolation') + (origin ? ' du clip #' + origin : '') : '',
        record.prompt || '',
      ]
        .filter(Boolean)
        .join(' · '),
      actions = actionsOf(record),
      shown = onStage()?.id === record.id,
      tile = node(
        'div',
        'studio-item' +
          (media === 'audio' ? ' is-sound' : '') +
          (extending?.id === record.id ? ' is-selected' : '') +
          (shown ? ' is-shown' : ''),
      );
    tile.dataset.id = record.id;
    tile.dataset.media = media;
    // The picture: a click shows it whole with its details (the screen keeps the last creation);
    // the one on the screen is ringed in white here (moodix-design.md 24). Dragged to a slot of
    // the inputs, it becomes that input.
    const pick = button('studio-item-pick', '', () => {
      if (pressed) return void (pressed = false);
      showDetails(record);
    });
    pick.setAttribute('aria-label', said);
    pick.title = said.length > 140 ? said.slice(0, 139) + '…' : said;
    if (shown) pick.setAttribute('aria-current', 'true');
    pick.draggable = !working;
    pick.ondragstart = event => {
      carried = record;
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('text/plain', name);
      // Carried at the size of a slot of the inputs: the whole picture hid where it would go.
      dragGhost(pick, event.dataTransfer, media, output.take);
      tile.classList.add('is-carried');
      carrying(media);
    };
    pick.ondragend = () => {
      carried = null;
      tile.classList.remove('is-carried');
      carrying(null);
    };
    if (media === 'audio') {
      // A card (capture 23): « PRISE 29 · 30.00 S » and its kind, its stripes, its name.
      const head = node('span', 'studio-sound-head'),
        wave = node('span', 'studio-thumb-wave'),
        sound = lengthOfRecord(record),
        title = String(record.prompt || 'Son').split('\n')[0];
      head.append(
        node('span', '', [Number.isInteger(output.take) ? 'PRISE ' + output.take : '#' + number, sound ? soundFigures(sound) : '']
          .filter(Boolean)
          .join(' · ')),
        node('span', '', /musi|ace-?step|song/i.test(record.workflowName || '') ? 'MUSIQUE' : 'BRUITAGE'),
      );
      for (const part of [head, wave]) part.setAttribute('aria-hidden', 'true');
      pick.append(head, wave, node('span', 'studio-sound-name', title));
    } else {
      const small = output.thumbUrl,
        key = record.id + '|' + (small || output.originalUrl || '');
      let picture = pictures.get(key);
      if (picture) used.add(key);
      else if (small || media === 'image') {
        picture = node('img');
        // The tile is what is dragged, not the picture as a file of the browser.
        Object.assign(picture, { alt: '', loading: 'lazy', decoding: 'async', draggable: false });
        picture.src = small || output.originalUrl || '';
        picture.onload = () => {
          if (media === 'image' && !small) {
            measured.set(record.id, { width: picture.naturalWidth, height: picture.naturalHeight });
            void thumbnailOf(api, record, 0, picture);
          }
          // The thumbnail of a clip found black (kept before 0.5.125): made again from the clip.
          else if (media === 'video' && small) void healThumbnail(api, record, 0, picture);
        };
      } else {
        // Its first picture only, of which a thumbnail is made for the next time.
        picture = node('video');
        Object.assign(picture, {
          muted: true,
          preload: 'metadata',
          playsInline: true,
          draggable: false,
          src: (output.originalUrl || '') + '#t=0.1',
        });
        picture.onloadeddata = () => void thumbnailOf(api, record, 0, picture);
      }
      if (!used.has(key)) {
        pictures.set(key, picture);
        used.add(key);
      }
      pick.append(picture);
    }
    // A right click, the menu key, or a long press: every action in a menu.
    tile.oncontextmenu = event => {
      event.preventDefault();
      openMenu(record);
    };
    let holding = null;
    pick.onpointerdown = event => {
      if (event.pointerType !== 'touch') return;
      holding = setTimeout(() => {
        pressed = true;
        openMenu(record);
      }, 550);
    };
    pick.onpointerup = pick.onpointercancel = pick.onpointerleave = () => clearTimeout(holding);
    // Under it (capture 22): « PRISE n » and its length (« 06.04 S »), its format for an image; a
    // continuation, « ↳ SUITE +04.00 S », glued to its take; an upscale or an interpolation,
    // « ↳ AGRANDIE » or « ↳ INTERPOLÉE » and its whole length. Made from a clip that is not in the
    // Sortie (a file of the disk, a take deleted since), « ↳ » would point at nothing: its own number.
    const take = output.take,
      caption = node('span', 'studio-item-caption'),
      badge = node(
        'span',
        'studio-item-number',
        from ? '↳ SUITE' : transform && origin ? '↳ ' + transform : Number.isInteger(take) ? 'PRISE ' + take : '#' + number,
      ),
      length = lengthOfRecord(record, Boolean(from)),
      shape = sizeOfRecord(record);
    caption.setAttribute('aria-hidden', 'true');
    caption.append(
      badge,
      node(
        'span',
        'studio-item-meta',
        media === 'image' ? (shape ? (formatOf(shape.width, shape.height)?.id ?? '') : '') : length ? (from ? '+' : '') + figures(length) : '',
      ),
    );
    // A clip as wide as it is long (30 px a second: captures 21 and 22), at the height of the strip;
    // its picture along it as frames at its format.
    if (media === 'video') {
      if (shape) tile.style.setProperty?.('--ratio', (shape.width / shape.height).toFixed(3));
      if (length) tile.style.setProperty?.('--seconds', length.toFixed(2));
      if (output.thumbUrl) {
        pick.style.setProperty?.('--strip', `url("${output.thumbUrl}")`);
        pick.classList.add('has-strip');
      }
    }
    if (from && next?.id === sourceOf(record)) tile.classList.add('is-suite');
    tile.append(pick, caption);
    const main = actions.find(action => action.id === 'extend' || action.id === 'animate');
    if (main) tile.append(onPicture(main, 'studio-item-main', name));
    // No « i » on the picture: a click on it shows its details.
    tile.append(
      onPicture(
        actions.find(action => action.id === 'delete'),
        'studio-item-del',
        name,
      ),
    );
    if (menuFor === record.id) {
      const menu = node('div', 'studio-item-menu');
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', 'Actions · ' + name);
      for (const action of actions) {
        const entry = button('studio-menu-item' + (action.danger ? ' is-danger' : ''), action.label, () => {
          menuFor = null;
          action.run();
        });
        entry.setAttribute('role', 'menuitem');
        entry.title = action.title;
        if (action.off) entry.setAttribute('aria-disabled', 'true');
        menu.append(entry);
      }
      menu.onkeydown = event => {
        const entries = [...(menu.querySelectorAll?.('button') ?? [])],
          at = entries.indexOf(document.activeElement);
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation?.();
          backTo(record);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          entries[(at + (event.key === 'ArrowDown' ? 1 : entries.length - 1)) % entries.length]?.focus?.();
        }
      };
      // Closed when the focus leaves it (a click elsewhere, Tab).
      menu.onfocusout = event => {
        if (menuFor === record.id && !menu.contains?.(event.relatedTarget)) {
          menuFor = null;
          render();
        }
      };
      tile.append(menu);
    }
    if (confirmFor === record.id) {
      const ask = node('div', 'studio-item-confirm'),
        row = node('div', 'studio-confirm-row'),
        no = button('studio-confirm-no', '', () => backTo(record), 'close'),
        yes = button(
          'studio-confirm-yes',
          '',
          () => {
            confirmFor = null;
            void remove(record);
          },
          'trash',
        );
      ask.setAttribute('role', 'alertdialog');
      ask.setAttribute('aria-label', 'Supprimer #' + number + ' ?');
      no.setAttribute('aria-label', 'Annuler');
      no.title = 'Annuler';
      yes.setAttribute('aria-label', 'Supprimer ' + name);
      yes.title = 'Supprimer de cette conversation (le fichier reste dans le dossier output)';
      ask.onkeydown = event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation?.();
        backTo(record);
      };
      row.append(no, yes);
      ask.append(node('span', 'studio-confirm-text', 'Supprimer #' + number + ' ?'), row);
      tile.append(ask);
    }
    return tile;
  }
  /** The length of a creation (`added`: what a continuation adds to its clip). */
  function lengthOfRecord(record, added = false) {
    const p = record.parameters ?? {};
    if (Number(p.seconds) > 0) return Number(p.seconds);
    if (!(p.frames > 0 && p.fps > 0)) return null;
    return Math.max(0, p.frames - (added && p.overlap_frames > 0 ? p.overlap_frames : 0)) / p.fps;
  }
  /** The size of a creation, from its file or its settings; null when neither says it. */
  function sizeOfRecord(record) {
    const output = record.outputs?.[0] ?? {},
      measuredSize = measured.get(record.id),
      width = output.width ?? record.parameters?.width ?? measuredSize?.width,
      height = output.height ?? record.parameters?.height ?? measuredSize?.height;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  // The pictures of the Sortie, kept from one drawing to the next (those of this drawing in `used`).
  const pictures = new Map();
  let used = new Set();
  /**
   * The Sortie: the creations of the project, of all its conversations, images, clips and sounds
   * together (16/11), the newest at the left (a new one pushes the others to the right); its button
   * at the right, released, keeps those of the kind of the mode (the images in Image, the clips in
   * Vidéo, the sounds in Son). Empty, its icon and a line that say so, without a frame (one would look like a place
   * to drop a file: moodix-design.md 7 bis 18).
   */
  function outputs() {
    used = new Set();
    const section = node('section', 'studio-block is-output studio-results'),
      about = modeOf(mode),
      own = SORTS.find(item => item.id === mode) ?? SORTS[0],
      sort = sortieAll ? SORTS[0] : own,
      // Of the whole project, whatever the conversation open (a new one too): they are shared in it.
      shown = sortieAll ? runs : runs.filter(record => mediaOf(record) === mode);
    section.setAttribute('aria-label', 'Sortie');
    if (!runs.length) {
      const empty = node('div', 'studio-empty-strip');
      empty.append(node('span', '', own.none));
      section.append(empty);
      return section;
    }
    // The creations, and at their right the button that sorts them.
    const row = node('div', 'studio-sortie-row');
    section.append(row);
    if (!shown.length) {
      const empty = node('div', 'studio-empty-strip');
      empty.append(node('span', '', sort.none));
      row.append(empty, sortButton(own));
      return section;
    }
    const strip = node('div', 'studio-strip studio-timeline');
    strip.setAttribute('aria-label', sort.id === 'all' ? 'Créations du projet' : sort.label + ' du projet');
    // The creation under way, at the far left (studio-maquette.md): dark, « EN COURS » and how far.
    if (working && !working.external) {
      const tile = node('div', 'studio-item is-making'),
        pick = node('div', 'studio-item-pick'),
        caption = node('span', 'studio-item-caption');
      caption.append(node('span', 'studio-item-number', 'En cours'), node('span', 'studio-item-meta', ''));
      tile.setAttribute('aria-hidden', 'true');
      tile.append(pick, caption);
      strip.append(tile);
    }
    // A continuation made just after its clip sits glued to it (« une suite reste collée à sa prise »).
    shown.forEach((record, at) => strip.append(item(record, shown[at + 1])));
    // The wheel of a mouse scrolls it sideways, the pointer anywhere over the Sortie (a mouse has
    // no sideways wheel); a sideways move of a trackpad is left to the browser.
    section.onwheel = event => scrollSideways(strip, event);
    row.append(strip, sortButton(own));
    // Those no longer shown (another mode, a creation removed) are let go.
    for (const key of pictures.keys()) if (!used.has(key)) pictures.delete(key);
    return section;
  }
  /**
   * What the hand carries (studio-maquette.md, « Glisser »; 16/11): the picture at the size of a slot
   * of the inputs (one on the screen gives it, 52 px otherwise) and 104 %, tilted by −3°, with its
   * shadow and « PRISE n » at its top left; a sound, its grey stripes. Drawn at once on a canvas from
   * the picture the tile already holds: nothing is loaded while the drag starts.
   */
  function dragGhost(pick, transfer, media, take = null) {
    const page = globalThis.document;
    if (!transfer?.setDragImage || !page?.createElement || !page.body) return;
    const slot = page.querySelector?.('#studio-view .studio-slot')?.getBoundingClientRect?.(),
      width = Math.round((slot?.width || 52) * 1.04),
      height = Math.round((slot?.height || 52) * 1.04),
      // Room around it for the tilt and the shadow.
      room = 16,
      full = [width + room * 2, height + room * 2],
      ratio = globalThis.devicePixelRatio || 1,
      canvas = page.createElement('canvas'),
      context = canvas.getContext?.('2d');
    if (!context) return;
    canvas.width = Math.round(full[0] * ratio);
    canvas.height = Math.round(full[1] * ratio);
    Object.assign(canvas.style, {
      position: 'fixed',
      top: '-1000px',
      left: '-1000px',
      width: full[0] + 'px',
      height: full[1] + 'px',
      pointerEvents: 'none',
    });
    const shape = () => {
      context.beginPath();
      if (context.roundRect) context.roundRect(0, 0, width, height, 6);
      else context.rect(0, 0, width, height);
    };
    context.scale(ratio, ratio);
    context.translate(full[0] / 2, full[1] / 2);
    context.rotate((-3 * Math.PI) / 180);
    context.translate(-width / 2, -height / 2);
    context.save();
    context.shadowColor = 'rgba(0, 0, 0, 0.55)';
    context.shadowBlur = 14;
    context.shadowOffsetY = 6;
    shape();
    context.fillStyle = '#000';
    context.fill();
    context.restore();
    context.save();
    shape();
    context.clip();
    const source = pick.querySelector?.('img, video'),
      sourceWidth = source?.naturalWidth || source?.videoWidth,
      sourceHeight = source?.naturalHeight || source?.videoHeight,
      // A picture still loading has its size and no pixels yet.
      drawable = source?.tagName === 'VIDEO' ? source.readyState >= 2 : source?.complete !== false;
    if (media !== 'audio' && sourceWidth && sourceHeight && drawable) {
      const scale = Math.max(width / sourceWidth, height / sourceHeight),
        drawn = [sourceWidth * scale, sourceHeight * scale];
      context.drawImage(source, (width - drawn[0]) / 2, (height - drawn[1]) / 2, ...drawn);
    } else if (media === 'audio') {
      context.fillStyle = '#6e7480';
      for (let x = 7; x < width - 7; x += 7) context.fillRect(x, height * 0.34, 3, height * 0.32);
    } else {
      // Its picture not there yet: the slot's size all the same, framed in grey.
      context.strokeStyle = '#6e7480';
      context.lineWidth = 2;
      context.strokeRect(1, 1, width - 2, height - 2);
    }
    context.restore();
    // « PRISE n » at its top left, as on the screen.
    if (Number.isInteger(take)) {
      const word = 'PRISE ' + take,
        mono = globalThis.getComputedStyle?.(page.documentElement)?.getPropertyValue?.('--font-mono')?.trim() || 'monospace';
      context.font = `400 8.5px ${mono}`;
      context.letterSpacing = '0.8px';
      const chip = context.measureText(word).width + 10;
      context.fillStyle = 'rgba(12, 11, 14, 0.78)';
      context.beginPath();
      if (context.roundRect) context.roundRect(4, 4, chip, 15, 4);
      else context.rect(4, 4, chip, 15);
      context.fill();
      context.fillStyle = '#eee8de';
      context.fillText(word, 9, 14.5);
    }
    page.body.append(canvas);
    transfer.setDragImage(canvas, full[0] / 2, full[1] / 2);
    // Its picture is taken as the drag starts: the canvas can go.
    setTimeout(() => canvas.remove(), 0);
  }
  /**
   * The button at the right of the Sortie: pressed, the whole project (as it is to begin with);
   * released, the kind of the mode only; a click goes from one to the other.
   */
  function sortButton(own) {
    const box = node('div', 'studio-sort'),
      main = button('studio-sort-go is-current', '', () => {
        sortieAll = !sortieAll;
        render();
        document.querySelector?.('#studio-view .studio-sort-go')?.focus?.();
      }, 'grid');
    main.setAttribute('aria-label', 'Trier la Sortie · ' + (sortieAll ? 'tout' : own.label.toLowerCase()));
    main.setAttribute('aria-pressed', String(sortieAll));
    main.title = 'Toutes les prises du projet';
    box.append(main);
    return box;
  }
  /** A turn of the wheel, as so many pixels sideways along `strip` (nothing when it all shows). */
  function scrollSideways(strip, event) {
    if (Math.abs(event.deltaX) >= Math.abs(event.deltaY) || strip.scrollWidth <= strip.clientWidth) return;
    // Lines (Firefox) or pages, as pixels.
    const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? strip.clientWidth : 1;
    event.preventDefault();
    strip.scrollLeft += event.deltaY * unit;
  }
  /** A new creation goes at the left of the strip: the strip shows it. */
  function scrollStrip() {
    const strip = document.querySelector?.('#studio-view .studio-strip');
    if (strip) strip.scrollLeft = 0;
  }

  // ------------------------------------------------------------------ the page
  function message(text) {
    const panel = node('section', 'studio-desk is-empty');
    // The chat stays at hand when nothing can be made here.
    panel.append(node('p', 'asset-empty', text), agent);
    return panel;
  }
  /**
   * The Studio as it will be, while its tools are read the first time: its four blocks on their
   * grain, the screen in the middle with the room of its bar. What they hold fades in once read.
   */
  function skeleton() {
    const desk = node('div', 'studio-desk is-loading'),
      said = node('p', 'sr-only', 'Chargement du Studio…'),
      screen = node('div', 'studio-screen'),
      preview = node('section', 'studio-block is-preview');
    desk.setAttribute('aria-busy', 'true');
    said.setAttribute('role', 'status');
    screen.append(node('div', 'studio-stage'));
    const waiting = node('div', 'studio-actionbar is-waiting');
    waiting.append(agent);
    preview.append(screen, waiting);
    const blocks = [node('section', 'studio-block is-input'), preview, node('section', 'studio-block is-settings')];
    desk.append(said, ...blocks.map(grained), grained(node('section', 'studio-block is-output')));
    return desk;
  }
  /**
   * A block of the Studio: what it holds, in its body. No grain of its own any more: the grain of the
   * room is behind the glass, never over a picture (reference-maquettes.md).
   */
  function grained(block) {
    const body = node('div', 'studio-block-body');
    body.append(...block.children);
    block.replaceChildren(body);
    return block;
  }
  /** Image / Vidéo / Son, at the top left. */
  /**
   * Image / Vidéo / Son, under « Studio » in the sidebar (moodix-design.md 7 bis 19): three tabs,
   * their icons only, their names for screen readers and in their tooltips. Each does what the
   * selector at the top of the Studio did (chooseMode); from the Chat or the home, the Studio
   * opens in that mode.
   */
  function kinds() {
    // The pill of the title bar: « Studio · Image », with the icon of the mode.
    const pill = $('studio-pill-text'),
      about = modeOf(mode);
    if (pill) {
      pill.textContent = 'Studio · ' + about.label;
      pill.parentElement?.querySelector?.('use')?.setAttribute('href', '#i-' + about.icon);
    }
    const bar = kindsBar();
    if (!bar) return;
    bar.removeAttribute('data-ai-active');
    bar.removeAttribute('data-ai-touched');
    aiTarget(bar, 'kind');
    if (bar.children.length !== MODES.length) {
      bar.replaceChildren(
        ...MODES.map(item => {
          const tab = node('button', 'kind-tab');
          tab.type = 'button';
          tab.setAttribute('role', 'tab');
          tab.setAttribute('aria-label', item.label);
          tab.title = item.label;
          // Its name at its right when the sidebar is folded (moodix.css).
          tab.dataset.tip = item.label;
          tab.dataset.mode = item.id;
          // Its name beside its icon when it is the one chosen (moodix.css).
          tab.append(icon(item.icon), node('span', 'kind-tab-name', item.label));
          tab.onclick = () => {
            chooseMode(item.id);
            if (globalThis.document?.body?.dataset?.view !== 'studio') openStudio();
          };
          return tab;
        }),
      );
      // The arrows go from one mode to the next, as in any row (or column) of tabs.
      bar.onkeydown = event => {
        const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
        if (!step || working) return;
        event.preventDefault();
        const next = MODES[(MODES.findIndex(item => item.id === mode) + step + MODES.length) % MODES.length];
        chooseMode(next.id);
        for (const tab of bar.children) if (tab.dataset.mode === next.id) tab.focus?.();
      };
    }
    for (const tab of bar.children) {
      const chosen = tab.dataset.mode === mode;
      tab.setAttribute('aria-selected', String(chosen));
      tab.tabIndex = chosen ? 0 : -1;
      tab.disabled = Boolean(working);
    }
  }
  /**
   * Image · Vidéo · Son are drawn in the head of the screen (form); without a screen (nothing ready to
   * make, the Studio being read), they go back above the body, never left in a page drawn away.
   */
  function keepKinds(body) {
    const bar = kindsBar();
    if (bar && !body.contains?.(bar)) body.parentElement?.insertBefore?.(bar, body);
  }
  function chooseMode(id) {
    if (working || mode === id || aiWorking) return;
    if (ai) takeOver();
    setMode(id);
    release();
  }
  function setMode(next) {
    mode = next;
    failure = '';
    formatsOpen = false;
    if (next !== 'video') extending = null;
    // Back in Vidéo while a proposal of Moodix AI waits there: the clip it continues is its own, not
    // lost with a look at Image or Son (it was then shown, and its length sent, as a new video's).
    else if (proposal?.mode === 'video' && proposal.values) extending = proposal.extending ?? null;
    render();
  }
  /**
   * The four blocks: Entrée, the preview with « Générer », Réglages, Sortie. Their places
   * depend on the width only: three columns and the output under them when wide.
   */
  function form() {
    const draft = drafts[mode],
      list = offered(),
      workflow = current();
    if (!info.enabled) return message('La génération locale est désactivée : activez-la dans Paramètres › Génération.');
    if (!workflow)
      return message(
        mode === 'audio'
          ? 'Aucun workflow de son prêt : téléchargez les modèles de musique et de bruitages dans models\\audio.'
          : 'Aucun workflow prêt pour cette création : vérifiez Paramètres › Workflows.',
      );
    // The first time a mode shows its model, the settings saved for it come back (not over a
    // proposal of Moodix AI, which sets its own).
    if (!presetShown[mode]) {
      presetShown[mode] = true;
      if (!answering() && !extending) applyPreset(workflow);
    }
    const desk = node('div', 'studio-desk'),
      write = node('section', 'studio-block is-input studio-write'),
      preview = node('section', 'studio-block is-preview studio-center'),
      settings = node('section', 'studio-block is-settings studio-settings');
    if (aiCarry) desk.setAttribute('data-carrying', 'image');
    write.setAttribute('aria-label', 'Entrée');
    preview.setAttribute('aria-label', 'Aperçu et génération');
    settings.setAttribute('aria-label', 'Réglages');

    // Entrée: what the user writes and hands over.
    const named = node('label', 'sr-only', 'Prompt');
    named.htmlFor = 'studio-prompt';
    write.append(named);
    if (mode === 'video' && extending) {
      const banner = node('div', 'studio-extending');
      banner.append(icon('forward'), node('span', '', 'Suite du clip : ' + (extending.prompt || extending.name || '').slice(0, 90)));
      if (!answering())
        banner.append(
          button('studio-link', 'Annuler', () => {
            extending = null;
            render();
          }),
        );
      write.append(banner);
    }
    // What a proposal of Moodix AI says of itself, as on its card in the chat: an image the user
    // named that it does not transmit (the continuation of a video by LTX 2.5 takes none), a model
    // used in place of the one asked for. Nothing else showed it here. At the head of the column:
    // under the cases it was out of sight in a window of 720 px (the column scrolls in itself).
    if (answering())
      for (const note of proposal.request.notes ?? []) write.append(node('p', 'studio-proposal-note', String(note)));
    const prompt = textarea(
      draft.prompt,
      8,
      extending
        ? 'Ce qui se passe ensuite…'
        : mode === 'image'
          ? 'Décrivez votre image…'
          : mode === 'video'
            ? workflow.follows
              ? 'Décrivez la vidéo avec votre personnage…'
              : 'Décrivez votre vidéo…'
            : 'Décrivez votre son…',
      value => {
        draft.prompt = value;
        // « Améliorer le prompt » waits for a few words; « Générer », for one.
        improvable();
        goable();
      },
    );
    prompt.id = 'studio-prompt';
    prompt.maxLength = 4000;
    prompt.title = MODIFIER + ' + Entrée pour générer';
    aiTarget(prompt, 'prompt');
    const promptField = node(
      'div',
      'studio-field studio-prompt-field is-wide' + (mode !== 'audio' ? ' has-enrich' : ''),
    );
    promptField.append(prompt);
    if (mode !== 'audio') promptField.append(enrichRow());
    if (enriching) promptField.classList.add('is-improving');
    write.append(promptField);
    // An image pasted (Ctrl+V) or dropped anywhere on the column: in the first free slot.
    write.ondragover = event => {
      if (!event.dataTransfer?.types?.includes?.('Files')) return;
      event.preventDefault();
      write.classList.add('is-dropping');
    };
    write.ondragleave = event => {
      if (!write.contains?.(event.relatedTarget)) write.classList.remove('is-dropping');
    };
    write.ondrop = event => {
      write.classList.remove('is-dropping');
      const file = imageFile(event.dataTransfer?.files),
        clip = file ? null : videoFile(event.dataTransfer?.files);
      if (!event.dataTransfer?.files?.length) return;
      event.preventDefault();
      if (file) placeImage(workflow, file);
      else if (clip) placeVideo(workflow, clip);
      else notice('Seules les images PNG, JPEG ou WebP vont dans les cases.');
    };
    write.onpaste = event => {
      const file = imageFile(event.clipboardData?.files);
      if (!file) return;
      event.preventDefault();
      placeImage(workflow, file);
    };
    // A song's lyrics are words handed over too: under the prompt, opened on demand.
    const lyrics = workflow.settings.find(setting => setting.key === 'lyrics' && setting.type === 'string');
    if (lyrics) {
      const store = (draft.settings[workflow.id] ??= {}),
        value = store.lyrics ?? lyrics.default ?? '';
      if (draft.lyrics || String(value).trim()) {
        const box = textarea(String(value), 4, SETTING_HELP.lyrics, next => {
          store.lyrics = next;
        });
        if (lyrics.maxLength) box.maxLength = lyrics.maxLength;
        aiTarget(box, 'setting-lyrics');
        write.append(field(SETTINGS.lyrics, box, { wide: true }));
      } else
        write.append(
          button('studio-lyrics-toggle', '+ Paroles (facultatif)', () => {
            draft.lyrics = true;
            render();
            document.querySelector?.('#studio-view [data-ai="setting-lyrics"]')?.focus?.();
          }),
        );
    }
    // The input images (a continuation shows only those it takes: subject references, for
    // MiniMax H3). Another model than the last one drawn: their blocks say so for a moment.
    if (shownModel[mode] && shownModel[mode] !== workflow.id) flashUntil = Date.now() + 650;
    shownModel[mode] = workflow.id;
    const row = inputs(workflow);
    if (row) write.append(row);

    // Réglages (moodix-design.md 16, 20, 28): blocks without titles, Modèle · Durée + Taille ·
    // LoRA, and « ··· » for the rare ones (the seed, the workflow's own settings).
    settings.append(modelBlock(workflow, list));
    const lacking = extending ? null : unavailableNote(list);
    if (lacking) settings.append(lacking);
    // The format, above the resolution (studio-maquette.md: no longer under the screen).
    if (workflow.limits && !extending && mode !== 'audio') {
      const formats = node('div', 'studio-set-block studio-set-format');
      formats.append(node('span', 'studio-label', 'Format'), formatChips(workflow));
      settings.append(formats);
    }
    const shape = shapeBlock(workflow);
    if (shape) settings.append(shape);
    // Those of the user show on a proposal of Moodix AI too: it is made with them (edits).
    const styled = workflow.styled && mode !== 'audio' && !extending;
    const loras = loraBlock(workflow, styled);
    if (loras) settings.append(loras);
    const rare = rareLines(workflow);
    if (rare.length) {
      const more = button('studio-more-pill' + (advanced ? ' is-open' : ''), '···', () => {
        advanced = !advanced;
        render();
      });
      more.append(node('span', 'studio-more-word', 'Plus de réglages'));
      more.setAttribute('aria-label', 'Plus de réglages');
      more.title = 'Plus de réglages';
      more.setAttribute('aria-expanded', String(advanced));
      const block = node('div', 'studio-set-block studio-rare');
      block.hidden = !advanced;
      block.append(...rare);
      settings.append(more, block);
    }

    // The preview, its formats and the button.
    const { screen } = stage(),
      head = node('div', 'studio-screen-head'),
      heldGpu = gpuBlocked() && !working,
      freed = !heldGpu && !working && Date.now() < freedUntil,
      // A work goes on in another conversation (0.6.81): nothing is made here until its end, said
      // on the line of the step (a proposal of Moodix AI answered here is this conversation's own).
      busyElsewhere = !working && !heldGpu && !answering() && !checking ? elsewhere() : '',
      step = node(
        'p',
        'studio-progress' + (heldGpu ? ' is-alert' : ''),
        heldGpu
          ? 'Carte graphique encore prise'
          : freed
            ? 'GPU libéré. Le modèle peut redémarrer.'
            : busyElsewhere
              ? busyElsewhere.replace(/ : .*$/, '')
              : (working?.label ?? ''),
      ),
      setting = node('p', 'studio-ai-line', 'Moodix AI règle le Studio');
    busyDrawn = busyElsewhere;
    // Image · Vidéo · Son at the left, the step under way in the middle, Moodix AI at the right.
    step.id = 'studio-progress';
    step.setAttribute('role', 'status');
    step.hidden = !working && !heldGpu && !freed && !busyElsewhere;
    // How long the take under way has been in the making (0.6.93), beside its step: not among what
    // the status says aloud, which would read it every second.
    elapsedNode = working ? node('time', 'studio-elapsed', working.time ?? '') : null;
    if (elapsedNode) {
      elapsedNode.setAttribute('aria-hidden', 'true');
      step.append(elapsedNode);
    }
    setting.hidden = !(answering() || ai);
    if (kindsBar()) head.append(kindsBar());
    head.append(step, setting);
    // A creation is on the screen to be looked at (inspect): back to the Studio as it was before.
    // Not while Moodix AI proposes or has a character checked, in whatever mode: the settings of
    // before would come under what it proposes (lookBack).
    if (looked && !proposal && !checking && !ai) {
      const back = button('studio-look-back', 'Revenir', lookBack, 'undo');
      back.title = 'Retirer ce média de l’écran et remettre vos réglages d’avant';
      back.setAttribute('aria-label', 'Revenir à mes réglages : retirer ce média de l’écran');
      back.disabled = Boolean(working);
      head.append(back);
    }
    preview.append(head, screen);
    const bar = node('div', 'studio-actionbar');
    // The actions of the take on the screen; held while Moodix AI proposes or a take is made.
    const onScreen = working ? (kept[mode] ?? ownRuns().find(item => mediaOf(item) === mode) ?? null) : onStage();
    if (onScreen && mode !== 'audio' && !extending && !heldGpu && !(onScreen.external && !onScreen.resource)) {
      const row = takeActions(onScreen, 0);
      // (Each makes a creation: not while another conversation makes one, 0.6.81.)
      row.inert = answering() || Boolean(working) || Boolean(busyElsewhere);
      if (row.inert) row.classList.add('is-held');
      bar.append(row);
    } else bar.append(node('div', 'output-actions is-empty'));
    const go = aiTarget(button('primary studio-go', '', generate, 'play'), 'generate'),
      label = node('span', 'studio-go-label', working ? 'En cours…' : extending ? 'Générer la suite' : 'Générer'),
      fill = node('span', 'studio-go-bar');
    fill.setAttribute('aria-hidden', 'true');
    // The triangle and its word, centred (moodix-design.md 7 bis 22); the keys are in its tooltip.
    // While the creation is made, « Génération · 42 % » alone, over the bar that fills the button.
    go.append(label, fill);
    go.title = (answering() ? 'Générer la proposition de Moodix AI' : 'Générer') + ` (${MODIFIER}+Entrée)`;
    // Nothing to make without a prompt (55): greyed, said in its tooltip; the half Agent stays.
    const blank = !draft.prompt.trim() && !answering() && !checking;
    go.disabled = enriching || Boolean(working) || Boolean(workflow.unavailable) || blank || Boolean(busyElsewhere);
    if (blank && !working) {
      go.title = 'Écrivez un prompt pour générer';
      go.classList.add('is-blank');
    }
    // The only model of this mode cannot run here: « Générer » is greyed and says why.
    if (workflow.unavailable) {
      go.title = workflow.unavailable;
      go.classList.add('is-unavailable');
    }
    // One creation at a time (0.6.81): greyed while another conversation makes one, and why.
    if (busyElsewhere && !workflow.unavailable) {
      go.title = busyElsewhere;
      go.classList.add('is-unavailable');
    }
    if (working) {
      go.setAttribute('role', 'progressbar');
      go.setAttribute('aria-valuemin', '0');
      go.setAttribute('aria-valuemax', '100');
      go.setAttribute('aria-label', 'Génération en cours');
    }
    // The Double verre (studio-maquette.md): « ▶ Générer » | the Agent; « Arrêter » in place of the
    // Agent while a take is made.
    const group = node('div', 'studio-go-group'),
      rule = node('span', 'studio-go-rule');
    rule.setAttribute('aria-hidden', 'true');
    if (working) {
      const halt = button('studio-stop', '', stop, 'stop');
      halt.setAttribute('aria-label', 'Arrêter la génération');
      halt.title = 'Arrêter la génération';
      group.append(go, rule, halt);
    } else {
      // Its Éclipse breathes while Moodix AI proposes: from its first setting to the user's answer.
      agent.classList?.toggle('is-thinking', Boolean(answering() || ai));
      group.append(go, rule, agent);
    }
    // The character Moodix AI made, on the screen: kept, made again, or everything stopped.
    if (checking && mode === 'image' && !working) {
      // The question on a line of its own above its three answers: on one line with them, « OK »
      // was cut at the right of a window of 1280 px.
      group.className += ' is-checking';
      label.textContent = 'OK';
      go.title = `Garder ce personnage : le remplacement se lance (${MODIFIER}+Entrée)`;
      go.disabled = false;
      const again = button('secondary studio-again', 'Autre image', () => checking.resolve('again'), 'dice');
      again.title = 'Faire une autre image du personnage, avec le prompt ci-contre';
      const stop = button('secondary studio-decline', 'Annuler', () => checking.resolve('cancel'));
      stop.title = 'Arrêter le remplacement';
      const question = node('span', 'studio-check-question', 'Ce personnage vous convient ?');
      group.replaceChildren(question, stop, again, go);
    }
    if (answering()) {
      // « Refuser » at the left of the Double verre; its half Agent tinted (moodix.css).
      const no = button('secondary studio-decline', 'Refuser', () => decline());
      no.title = 'Refuser cette proposition de Moodix AI';
      group.replaceChildren(no, ...group.children);
      group.classList.add('is-proposal');
    }
    if (heldGpu) {
      // The only thing to do (54): « Libérer le GPU » in place of Générer, the same glass and size.
      const free = button(
        'studio-go studio-recover',
        '',
        async () => {
          free.disabled = true;
          await recoverGPU();
          freedUntil = Date.now() + 4000;
          render();
          setTimeout(() => render(), 4100);
        },
        'chip',
      );
      free.append(node('span', 'studio-go-label', 'Libérer le GPU'));
      free.title = 'La carte graphique est restée prise par la dernière génération : la libérer';
      group.replaceChildren(free);
      group.classList.add('is-held');
    }
    bar.append(group);
    preview.append(bar);
    // The card held, its state says it all (54): no line of error beside it.
    if (failure && !heldGpu) {
      const alert = node('p', 'studio-error', failure);
      alert.setAttribute('role', 'alert');
      preview.append(alert);
    }

    desk.append(...[write, preview, settings].map(grained), grained(outputs()));
    desk.classList.toggle('is-generating', Boolean(working));
    if (working) for (const control of desk.querySelectorAll('textarea, select, input')) control.disabled = true;
    // What « Enregistrer » compares with, until the model is saved: the settings it showed first.
    baselines[workflow.id] ??= canonical(snapshot(workflow));
    paintSave();
    return desk;
  }
  function render() {
    kinds();
    const body = $('studio-body');
    if (!body) return;
    // The drafts are named after their conversation: at the first drawing, and when a new one gets
    // its identifier (its first take) while they are on the page.
    if (draftsKey === null || (draftsKey.startsWith('new|') && conversation())) draftsKey = draftKey();
    body.dataset.mode = mode;
    // The stage leaves with the form it is in, and nothing follows its size any longer: still
    // watched, it was reported once more as it went, with no mode left to read a format from.
    watching?.disconnect();
    watching = null;
    // Held by a work of another conversation than the one shown (0.6.81): said so, nothing of that
    // conversation drawn here (its take in progress is in the miniature).
    if (away()) {
      if (flux) {
        flux.flux.stop();
        flux = null;
      }
      body.replaceChildren(awayPanel());
      return;
    }
    if (!info) {
      if (unreadable) body.replaceChildren(message('Studio indisponible : ' + unreadable));
      else {
        sketched = true;
        body.replaceChildren(skeleton());
      }
      return keepKinds(body);
    }
    // Where the Sortie was scrolled to: drawn again, it stays there (a click on a creation, a
    // change of model), not back at its start.
    const along = document.querySelector?.('#studio-view .studio-strip')?.scrollLeft ?? 0;
    const desk = form();
    if (sketched) desk.classList.add('is-arriving');
    sketched = false;
    body.replaceChildren(desk);
    keepKinds(body);
    if (along) {
      const strip = document.querySelector?.('#studio-view .studio-strip');
      if (strip) strip.scrollLeft = along;
    }
    if (working) progress();
    // Nothing made any more: the Flux leaves with its frame.
    else if (flux) {
      flux.flux.stop();
      flux = null;
    }
  }
  /**
   * The Studio held by a work of another conversation (0.6.81), in place of its blocks: what holds it,
   * and the way back (the miniature). It is this conversation's again at the end of that work.
   */
  function awayPanel() {
    const panel = node('div', 'studio-away'),
      sign = mark?.(),
      // (Non-breaking spaces inside the guillemets: a line never begins with « » ».)
      name = `« ${nameOf(heldIn?.conversation) || 'une autre conversation'} »`;
    panel.setAttribute('role', 'status');
    if (sign) {
      sign.classList?.add('studio-away-mark');
      panel.append(sign);
    }
    panel.append(
      node('p', 'studio-away-kicker', 'Studio occupé'),
      node(
        'p',
        'studio-away-text',
        working
          ? `La génération de ${name} occupe le Studio jusqu’à sa fin.`
          : checking
            ? `L’image d’un personnage attend votre avis dans le Studio de ${name}.`
            : `Une proposition de Moodix AI attend votre accord dans le Studio de ${name}.`,
      ),
      node('p', 'studio-away-hint', `La miniature, en bas à droite, vous ramène à ${name}.`),
    );
    return panel;
  }
  async function refresh() {
    if (!info) return;
    const id = place();
    seenConversation = conversation();
    // Without the copies kept for the model (a storyboard per clip): the Studio shows the files.
    // Those of the whole project, the open conversation with them (the former Studio: its own).
    const route = legacy
      ? id && `gallery/${id}?images=0`
      : `project-gallery/${encodeURIComponent(project())}?images=0` + (id ? '&conversation=' + id : '');
    const read = route ? await (await api(route)).json() : {};
    runs = read.runs ?? [];
    nextTake = Number.isInteger(read.nextTake) ? read.nextTake : null;
    runsFor = where();
    runsStale = false;
    if (info.legacyId && !legacyRuns.loaded) {
      try {
        legacyRuns = (await (await api(`gallery/${info.legacyId}?images=0`)).json()).runs ?? [];
      } catch {
        legacyRuns = [];
      }
      legacyRuns.loaded = true;
    } else if (legacy) {
      legacyRuns = Object.assign([...runs], { loaded: true });
    }
    onRuns(id, legacy);
  }
  /**
   * Reads the tools of the Studio (the server checks the files of every workflow: most of a
   * second). Two callers at once (a proposal arriving as the Studio opens) share one request.
   */
  function load() {
    loading ??= api('studio')
      .then(response => response.json())
      .then(value => {
        info = value;
        unreadable = '';
        toolsAt = Date.now();
        toolsStale = false;
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  }
  /**
   * The Studio comes on screen. Its tools are read the first time, then again in the background
   * when the settings were closed since or a minute went by (the page shows them meanwhile, and
   * is drawn again only if they changed). The creations are read again only for another
   * conversation, or when something was made elsewhere: switching views costs nothing.
   */
  async function open() {
    // Another conversation: what was on the screen belonged to the one before.
    if (seenConversation !== undefined && seenConversation !== conversation()) forget();
    render();
    // A proposal of Moodix AI waits on « Générer » (the page was left meanwhile, 0.6.81): its pointer
    // is there again.
    if (ai?.waiting && !away()) pointer?.move(targetOf('generate'), 'attend votre accord');
    const drawn = shown();
    try {
      if (!info) await load();
      else if (toolsStale || Date.now() - toolsAt > TOOLS_TTL_MS) {
        const before = JSON.stringify(info);
        void load()
          .then(async () => {
            if (JSON.stringify(info) === before || ai) return;
            await afterMove();
            render();
          })
          .catch(() => {});
      }
      if (runsStale || runsFor !== where() || seenConversation !== conversation()) await refresh();
    } catch (error) {
      if (!info) unreadable = error.message;
      notice('Studio indisponible : ' + error.message);
    }
    const set = settle();
    // Drawn again only if what it shows has changed, once the page has stopped moving.
    await afterMove();
    if (set || shown() !== drawn) render();
  }
  /** Where the creations shown come from: the conversation and its project. */
  const where = () => `${place()}|${legacy ? '' : project()}`;
  /** What the Studio shows of what it reads: its tools and creations, from where. */
  const shown = () => JSON.stringify([info, runs, legacyRuns.length, legacy, unreadable]);
  /**
   * Reads ahead, as the page opens (app.js): its tools, most of the wait the first time, and the
   * creations of the conversation. The Studio is then drawn whole the first time it comes on screen.
   * Again once the generation engine is ready: until then no workflow is.
   */
  async function prefetch() {
    try {
      const before = info && JSON.stringify(info);
      if (!info || toolsStale) await load();
      if (runsStale || runsFor !== where() || seenConversation !== conversation()) await refresh();
      if (settle()) render();
      // Read again (the engine is ready): drawn again if what it offers changed.
      if (before && JSON.stringify(info) !== before && !ai && !working) {
        await afterMove();
        render();
      }
    } catch {
      // Said when the Studio opens, which reads them again.
    }
  }
  /**
   * Something changed elsewhere: a creation made from the chat (its creations are read again at
   * the next opening), or the settings (`tools`: its workflows too).
   */
  function invalidate({ tools = false } = {}) {
    runsStale = true;
    if (tools) toolsStale = true;
  }
  function forget() {
    // A creation was being looked at: the Studio is first as it was before (leaveLook), not left
    // with the settings of that creation and no way back.
    leaveLook();
    for (const key of Object.keys(kept)) delete kept[key];
    pinned = null;
    extending = null;
    failure = '';
    legacy = false;
  }
  /** What names the conversation of the drafts: its identifier; a new one, by its project. */
  const draftKey = () => conversation() ?? 'new|' + project();
  /**
   * Another conversation is open (or the project of one not begun changed): the Studio shows its
   * creations, and its own prompt and inputs; those of the one left are kept for its return. A new
   * conversation has none: the Studio empty (etats-maquette.md, 55).
   */
  function conversationChanged() {
    // A work held here goes on in its conversation (0.6.81): the Studio stays that one's, said held in
    // the one shown (render), and comes back to it as it was; it goes to the one shown at its end (letGo).
    if (heldIn && holds()) {
      // The pointer resting on « Générer » goes with it; it comes back there with the Studio (open).
      if (away()) pointer?.hide();
      render();
      return;
    }
    heldIn = null;
    // A creation was being looked at: the look ends as « Revenir » ends it, before anything is kept
    // of the conversation left. Kept as they were, its drafts were those of the take looked at (its
    // very seed with them, which followed into the conversation opened) and the user's own were lost.
    leaveLook();
    const next = draftKey();
    // A conversation not begun that gets its identifier while its first take is made: the same one.
    const begun = draftsKey?.startsWith('new|') && conversation() && Boolean(working);
    if (draftsKey !== null && next !== draftsKey && !begun) {
      if (!draftsKey.startsWith('new|')) {
        leftDrafts.set(draftsKey, { mode, drafts: structuredClone(drafts), newest: lastSeen.get(draftsKey) ?? null });
        if (leftDrafts.size > 40) leftDrafts.delete(leftDrafts.keys().next().value);
      }
      // Empty until its takes are read (settle): the prompt and the inputs are a conversation's own.
      for (const item of MODES) Object.assign(drafts[item.id], { prompt: '', before: null, inputs: {} });
      lastSeen.delete(next);
      draftsEpoch++;
    }
    draftsKey = next;
    forget();
    onConversation();
    if (info)
      void refresh()
        .then(settle, () => {})
        .then(render);
    else render();
  }
  /** The models a mode offers, whatever is being continued: its own and, for a video, those that follow one. */
  const modelsOf = id => [
    ...(info?.tools?.[modeOf(id).verb] ?? []),
    ...(id === 'video' ? (info?.tools?.replace_character ?? []) : []),
  ];
  /**
   * A reference of the project (an image or a clip of the disk, « #ref1 ») as a creation: what the
   * screen shows and what the actions and a continuation take as their source (`outputSource`).
   * `sheet`: what Moodix wrote in the file, when it made it; `name`, `width`, `height`: what is known
   * of it when the page has not its reference at hand.
   */
  function resourceRecord(resource, kind, { sheet = null, name = '', width, height } = {}) {
    const wide = resource.width ?? width,
      high = resource.height ?? height;
    return {
      id: 'file:' + resource.id,
      external: true,
      resource: resource.id,
      mediaType: kind,
      prompt: String(sheet?.prompt ?? ''),
      // How it is named where a clip continued is named (« Suite du clip : view.mp4 »).
      name: resource.name || name || '',
      workflowId: sheet?.workflowId,
      workflowName: sheet?.workflowName,
      parameters: sheet?.parameters ?? (wide > 0 && high > 0 ? { width: wide, height: high } : {}),
      outputs: [{ originalUrl: resource.originalUrl || resource.previewUrl || '', thumbUrl: resource.previewUrl || '', width: wide, height: high }],
    };
  }
  /** A take of the project as an input of the Studio (its picture, its name, its size). */
  function creationInput(record, index = 0) {
    const output = { ...record.outputs[index], ...measured.get(record.id) };
    return {
      source: { ...outputSource(record), ...(index > 0 ? { index } : {}) },
      preview: output.thumbUrl || output.originalUrl,
      name: record.prompt || KIND[mediaOf(record)] || 'Création',
      width: output.width ?? record.parameters?.width,
      height: output.height ?? record.parameters?.height,
    };
  }
  /**
   * The Studio as it was to make a take (16/11): its model, its prompt, its format and size, its
   * length, its settings, its LoRAs and its inputs, in the draft of its mode. Not its seed, drawn
   * again, unless the user had named it (`seed_given`) or the take is looked at for what made it
   * (`exactSeed`: inspect). An input that is no longer there (a take
   * deleted or gone to another project, a reference erased) leaves its case empty, and a LoRA of
   * the user whose file left its folder is not put back: how many inputs (`lost`) and which LoRAs
   * (`gone`, by their files) are returned, for the Studio to say so.
   */
  function adopt(record, { exactSeed = false } = {}) {
    const target = mediaOf(record),
      draft = drafts[target],
      made = record.parameters ?? {},
      workflow = modelsOf(target).find(item => item.id === record.workflowId) ?? null,
      gone = [];
    Object.assign(draft, { prompt: String(record.prompt ?? ''), before: null, inputs: {}, extension: null });
    if (!workflow) return { lost: 0, gone };
    // The LoRAs of the user are of one family of models: those of the family left wait for its return.
    const family = modelsOf(target).find(item => item.id === draft.workflow)?.family;
    if (family !== undefined && family !== workflow.family) {
      draft.shelved[family] = draft.styles;
      draft.styles = draft.shelved[workflow.family] ?? [];
    }
    draft.workflow = workflow.id;
    // Its saved settings (« Enregistrer ») do not come over those of the take.
    presetShown[target] = true;
    if (workflow.seeded)
      draft.seed = (exactSeed || made.seed_given === true) && Number.isSafeInteger(made.seed) ? String(made.seed) : '';
    if (workflow.limits && made.width > 0 && made.height > 0) {
      // Of a ratio no format is close to (1280 × 800 asked in the Chat), the nearest format (0.6.92):
      // left as they were, the format and the size shown were those of the take before.
      const format = nearestFormat(made.width, made.height);
      if (format) Object.assign(draft, { format: format.id, size: sizeKey(made), formatChosen: true });
    }
    const lengths = workflow.lengths?.seconds ?? [],
      // The whole clip; of a continuation, what it added to the clip it started from.
      length = lengthOfRecord(record, Boolean(sourceOf(record)));
    if (lengths.length && length > 0)
      draft.length = lengths.reduce((best, value) => (Math.abs(value - length) < Math.abs(best - length) ? value : best));
    // The roles of its inputs, as its record names them (those of the family: « img2img »).
    const given = (Array.isArray(made.references) ? made.references : []).map(ref => ref?.role);
    for (const setting of workflow.settings ?? []) {
      if (made[setting.key] === undefined || made[setting.key] === null) continue;
      // Read only with an input the take did not have (an image made from nothing says a denoise
      // of 1, which is no setting): the Studio keeps the one it has.
      if (!settingRead(setting, given)) continue;
      (draft.settings[workflow.id] ??= {})[setting.key] = fineSetting(setting)
        ? fineValue(setting, made[setting.key])
        : made[setting.key];
      if (setting.key === 'lyrics') draft.lyrics = Boolean(made[setting.key]);
    }
    // The LoRAs of its workflow as it had them: on with their strength, the others off.
    if (Array.isArray(made.loras) && workflow.loras?.length) {
      const chosen = new Map(made.loras.map(item => [item.id, item.strength]));
      for (const item of workflow.loras) {
        const choice = loraChoice(workflow, item, draft);
        choice.on = chosen.has(item.id) || !item.assistant;
        if (chosen.has(item.id) && Number.isFinite(chosen.get(item.id))) choice.strength = chosen.get(item.id);
        loraChoice(workflow, item, draft);
      }
    }
    // Those of the user, which are still in their folder; the others are named to the user.
    if (workflow.styled && target !== 'audio') {
      const had = (Array.isArray(made.styles) ? made.styles : []).filter(style => style?.name);
      draft.styles = had
        .filter(style => (info.styles ?? []).includes(style.name))
        .slice(0, MAX_STYLES)
        .map(({ name, strength }) => ({ name, strength }));
      gone.push(...had.filter(style => !(info.styles ?? []).includes(style.name)).map(style => leaf(style.name)));
    }
    // Its inputs, each in the case of its role, in their order.
    let lost = 0;
    const counts = {};
    for (const ref of Array.isArray(made.references) ? made.references : []) {
      // The role as the Studio names it: said by the workflow (`inputs`), else read from its name.
      const named = workflow.inputs?.[ref.role] ?? (ref.role in workflow.roles ? ref.role : String(ref.role).replace(/_image$/, '')),
        role = named === 'msr' ? 'reference' : named,
        spec = workflow.roles?.[role],
        index = counts[role] ?? 0;
      // Not a case of this model (the clip a continuation started from): nothing to fill.
      if (!spec?.count || index >= spec.count) continue;
      const taken = ref.output_id ? runs.find(item => item.id === ref.output_id) : null,
        resource = ref.resource_id ? assets.resource?.(ref.resource_id) : null;
      counts[role] = index + 1;
      if (taken && spec.media.includes(mediaOf(taken)))
        (draft.inputs[role] ??= [])[index] = creationInput(taken, ref.output_index > 0 ? ref.output_index : 0);
      else if (resource)
        (draft.inputs[role] ??= [])[index] = {
          source: { resource: resource.id },
          preview: resource.previewUrl || resource.originalUrl,
          name: `${resource.label} · ${resource.name}`,
          width: resource.width,
          height: resource.height,
        };
      else lost++;
    }
    return { lost, gone };
  }
  /**
   * What the Studio says of the LoRAs a take was made with whose files are no longer in their
   * folder (`of`: « cette prise », « la dernière prise »), each once; '' when none is missing.
   */
  function goneLoras(names, of) {
    const files = [...new Set(names)];
    return files.length > 1
      ? `${files.length} LoRA de ${of} ne sont plus dans le dossier loras : ${files.join(', ')}.`
      : files.length
        ? `Un LoRA de ${of} n’est plus dans le dossier loras : ${files[0]}.`
        : '';
  }
  /**
   * The creations of the conversation in hand have just been read: the Studio takes the settings of
   * its last take, mode by mode, and shows the mode of the newest (16/11). Only when that take is
   * new to it: one it made itself, or was set from already, changes nothing, and a conversation left
   * comes back as it was left unless a take was made in it since. A conversation without a take keeps
   * the model and the settings in hand, its prompt and its inputs empty. Nothing while a take is made
   * or Moodix AI proposes: the Studio is theirs.
   */
  function settle() {
    if (!info || legacy || runsFor !== where() || working || proposal || ai || checking) return false;
    // Nor while the prompt of this conversation is being improved: its answer would be written over
    // the settings taken here. (Asked in a conversation left since, it is dropped: nothing to wait for.)
    if (enriching && enrichEpoch === draftsEpoch) return false;
    const key = draftKey(),
      own = ownRuns(),
      newest = own[0]?.id ?? null,
      left = leftDrafts.get(key);
    leftDrafts.delete(key);
    if (!left && lastSeen.has(key) && lastSeen.get(key) === newest) return false;
    lastSeen.set(key, newest);
    if (lastSeen.size > 200) lastSeen.delete(lastSeen.keys().next().value);
    if (left && left.newest === newest) {
      for (const item of MODES) Object.assign(drafts[item.id], left.drafts[item.id]);
      mode = left.mode;
      return true;
    }
    if (!newest) return false;
    let lost = 0;
    const gone = [];
    for (const item of MODES) {
      // The last take of the mode that one of its models made (not an enlargement, which has no settings).
      const models = new Set(modelsOf(item.id).map(model => model.id)),
        last = own.find(record => mediaOf(record) === item.id && models.has(record.workflowId));
      if (!last) continue;
      const missing = adopt(last);
      lost += missing.lost;
      gone.push(...missing.gone);
    }
    // The screen shows that newest take: its mode (when a model makes that kind here), and no longer
    // a take the Studio kept on it; one opened from the chat (« Afficher dans le Studio ») stays.
    for (const kind of Object.keys(kept)) if (kept[kind].id !== pinned) delete kept[kind];
    if (!pinned && modelsOf(mediaOf(own[0])).length) mode = mediaOf(own[0]);
    extending = null;
    // What could not be put back as the take had it, said: the settings shown are not all its own.
    failure = [
      lost > 1
        ? `${lost} images utilisées pour la dernière prise n’existent plus : leurs cases sont restées vides.`
        : lost
          ? 'Une image utilisée pour la dernière prise n’existe plus : sa case est restée vide.'
          : '',
      goneLoras(gone, 'la dernière prise'),
    ]
      .filter(Boolean)
      .join(' ');
    return true;
  }
  /** The Studio has just made a take itself: its settings are already those of the newest take. */
  function settledHere() {
    if (!legacy && runsFor === where()) lastSeen.set(draftKey(), ownRuns()[0]?.id ?? null);
  }
  /** Nothing is looked at any more: no way back, the address of a file of the disk given back. */
  function endLook() {
    looked = null;
    if (!lookedUrl) return;
    // The file shown from that address leaves the screen with it: given back while a mode still
    // showed it (a sound looked at, then a take made in Image), it left there a player that could
    // no longer read anything.
    for (const key of Object.keys(kept))
      if (kept[key].outputs?.[0]?.originalUrl === lookedUrl) {
        if (pinned === kept[key].id) pinned = null;
        delete kept[key];
      }
    globalThis.URL?.revokeObjectURL?.(lookedUrl);
    lookedUrl = '';
  }
  /**
   * The Studio as it was before the look: its drafts, its screen, its mode, « Plus de réglages »;
   * the look is over. Nothing is drawn. What the take looked at added to a draft and was not there
   * before (the format said chosen) leaves with it.
   */
  function leaveLook() {
    if (!looked) return;
    const before = looked;
    endLook();
    for (const item of MODES) {
      const draft = drafts[item.id];
      for (const key of Object.keys(draft)) if (!(key in before.drafts[item.id])) delete draft[key];
      Object.assign(draft, before.drafts[item.id]);
    }
    for (const key of Object.keys(kept)) delete kept[key];
    Object.assign(kept, before.kept);
    ({ mode, advanced, pinned, extending } = before);
  }
  /**
   * A creation put on the screen to see what made it (16/11): dropped there from the Sortie or from
   * the computer, or « Afficher dans le Studio » on a take of the chat. Its kind opens (Image, Vidéo,
   * Son), it is on the screen with its actions (Agrandir, Prolonger…), and the Studio takes all that
   * made it: model, prompt, format, settings, LoRAs, inputs and its very seed, « Plus de réglages »
   * open. What made a file from elsewhere is not known: the settings stay as they are. The Studio as
   * it was before is kept: « Revenir », at the right of « Image · Vidéo · Son », gives it back.
   */
  /** Why a creation of this kind cannot be put on the screen now, or '' when it can. */
  function cannotLook(kind) {
    if (working) return 'Une création est en cours : attendez sa fin pour en regarder une autre.';
    if (proposal || ai) return 'Moodix AI est en train de proposer';
    // Nor while a character waits for its check (0.6.88): looked at, the image to check left the screen.
    if (checking) return 'Un personnage attend votre réponse dans le Studio : « OK », « Autre image » ou « Annuler ».';
    // A kind no model makes here has no screen: the Studio would only say so.
    if (info && !modelsOf(kind).length)
      return `Aucun modèle ${kind === 'audio' ? 'de son' : kind === 'video' ? 'de vidéo' : 'd’image'} n’est prêt : ce média ne peut pas être montré dans le Studio.`;
    return '';
  }
  function inspect(record) {
    const refused = cannotLook(mediaOf(record));
    if (refused) return notice(refused);
    looked ??= { mode, drafts: structuredClone(drafts), advanced, kept: { ...kept }, pinned, extending };
    legacy = false;
    const target = mediaOf(record);
    mode = target;
    kept[target] = record;
    pinned = record.id;
    extending = null;
    formatsOpen = false;
    failure = '';
    if (info && modelsOf(target).some(item => item.id === record.workflowId)) {
      const { lost, gone } = adopt(record, { exactSeed: true });
      advanced = true;
      failure = [
        lost > 1
          ? `${lost} images utilisées pour cette prise n’existent plus : leurs cases sont restées vides.`
          : lost
            ? 'Une image utilisée pour cette prise n’existe plus : sa case est restée vide.'
            : '',
        goneLoras(gone, 'cette prise'),
      ]
        .filter(Boolean)
        .join(' ');
    } else if (record.external && record.workflowName)
      // Made by Moodix, with a model this installation does not have.
      failure = `Créé avec ${record.workflowName}, qui n’est pas disponible ici : vos réglages sont restés tels quels.`;
    render();
  }
  /** « Revenir »: the creation looked at leaves the screen, the Studio is as it was before. */
  function lookBack() {
    // Held while a proposal of Moodix AI waits, as a look is (cannotLook): the drafts of before,
    // put back under it, went with « Générer » as changes of the user.
    if (!looked || working || proposal || checking || ai) return;
    leaveLook();
    formatsOpen = false;
    failure = '';
    render();
  }
  /**
   * A file of the computer dropped on the screen. One Moodix made says so itself (the sheet it
   * carries: public/media-info.mjs), whatever its name: a take of this project is that take; another
   * is shown with what made it. An image or a clip is kept as a reference of the project, so that it
   * can be enlarged, continued, animated; a sound is played from the file.
   */
  async function inspectFile(file) {
    const type = String(file?.type || ''),
      kind = type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : type.startsWith('audio/') ? 'audio' : null;
    if (!kind) return notice('Ce fichier n’est ni une image, ni une vidéo, ni un son.');
    const refused = cannotLook(kind);
    if (refused) return notice(refused);
    const sheet = await fileInfo(file).catch(() => null),
      known = sheet?.id ? runs.find(item => item.id === sheet.id) : null;
    if (known) return inspect(known);
    let resource = null;
    if (kind !== 'audio') [resource = null] = await assets.importFiles([file], { project: project() }).catch(() => []);
    if (working || proposal || ai) return;
    const address = resource ? resource.originalUrl || resource.previewUrl : (globalThis.URL?.createObjectURL?.(file) ?? '');
    if (!address) return notice('Ce fichier n’a pas pu être lu.');
    inspect(
      resource
        ? resourceRecord(resource, kind, { sheet })
        : {
            id: `file:${file.name}:${file.size}:${file.lastModified ?? 0}`,
            external: true,
            mediaType: kind,
            prompt: String(sheet?.prompt ?? ''),
            workflowId: sheet?.workflowId,
            workflowName: sheet?.workflowName,
            parameters: sheet?.parameters ?? {},
            outputs: [{ originalUrl: address, thumbUrl: '' }],
          },
    );
    if (!resource) {
      // Another file of the disk was on the screen: it left it for this one, its address is given back.
      if (lookedUrl && lookedUrl !== address) globalThis.URL?.revokeObjectURL?.(lookedUrl);
      lookedUrl = address;
    }
  }
  /** « Afficher dans le Studio » on a take of the chat: on the screen, with what made it (inspect). */
  function show(record) {
    inspect(record);
  }

  // Ctrl + Entrée (⌘ on a Mac) generates from anywhere in the Studio, not only from the prompt.
  const shortcut = event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || working || enriching || aiWorking) return;
    // Held by a work of another conversation (« Studio occupé », 0.6.87): nothing of that one is on
    // screen, its keys answer nothing (Ctrl + Entrée started the video waiting there, or said « OK »).
    if (away()) return;
    // The message box of the chat has its own keys: these are the Studio's.
    if (event.target?.id === 'prompt') return;
    if (event.key === 'Enter') {
      event.preventDefault();
      void generate();
    } else if (String(event.key).toLowerCase() === 'e' && !event.shiftKey && mode !== 'audio' && info?.enabled) {
      // « Améliorer le prompt » (moodix-design.md 17): Ctrl+E, ⌘+E on a Mac.
      event.preventDefault();
      void enrich();
    }
  };
  const view = $('studio-view');
  if (view) {
    view.onkeydown = shortcut;
    // While Moodix AI sets the Studio it is locked (inert, lockStudio): nothing of the user reaches it,
    // nothing stops the pointer (16/11). Resting on « Générer », a touch of the user sends the pointer
    // away; the proposal stays, theirs to change.
    const touched = event => {
      if (aiWorking) return;
      if (event.isTrusted !== false && ai) takeOver();
      else if (event.type === 'input' && !proposal) release();
    };
    view.addEventListener?.('input', touched, true);
    view.addEventListener?.('pointerdown', event => !aiWorking && event.isTrusted !== false && ai && takeOver(), true);
    // Pointer and rings follow their setting when the page scrolls under them.
    view.addEventListener?.('scroll', () => ai?.active && pointer?.follow(targetOf(ai.active)), { passive: true });
  }
  // With the focus on no field (after a click beside them) the key goes to the page itself: it
  // is taken there too, while the Studio is the view on screen and no window is open over it.
  document.addEventListener?.('keydown', event => {
    if (event.target !== document.body || $('studio-view')?.offsetParent == null) return;
    if (!document.querySelector('dialog[open]')) shortcut(event);
  });
  // A click outside « ··· » closes it.
  document.addEventListener?.('pointerdown', event => {
    if (!formatsOpen || event.target?.closest?.('.studio-formats-wrap')) return;
    formatsOpen = false;
    const menu = document.querySelector?.('#studio-view .studio-format-menu');
    if (menu) closePopup(menu);
  });
  // The modes under « Studio » in the sidebar are there from the start: seen from the Chat too.
  kinds();
  return {
    open,
    prefetch,
    render,
    busy: () => Boolean(working) || enriching,
    propose,
    decline,
    followAgain,
    busyChanged,
    follow,
    settled,
    show,
    takeOver,
    conversationChanged,
    invalidate,
    checkCharacter,
    /**
     * The size of the image of a character for a video of `size` (its format, about as many
     * points as the image workflow makes by itself), or null when that workflow sets its own.
     */
    imageSize: size => {
      const workflow = offered('create_image').find(item => !item.unavailable);
      const format = size?.width > 0 && size?.height > 0 ? formatOf(size.width, size.height) : null;
      if (!workflow?.direct || !workflow.limits || !format) return null;
      const pixels = (workflow.size?.width ?? 1024) * (workflow.size?.height ?? 1024);
      const { nearest } = sizeChoices(workflow, format.id, pixels);
      return nearest ? { width: nearest.width, height: nearest.height } : null;
    },
    /**
     * The LoRAs of the user the Studio has for conversation `id` in mode `target` (0.6.88): those it
     * shows when its settings are that conversation's, else those it kept when it left it; null when
     * it has none for it. A creation made at once while that Studio is not on screen takes them.
     */
    stylesFor: (id, target = 'image') => {
      const own = id && id === draftsKey ? drafts : leftDrafts.get(id)?.drafts,
        styles = own?.[target]?.styles;
      return Array.isArray(styles) ? styles.filter(style => style?.name).map(({ name, strength }) => ({ name, strength })) : null;
    },
    /** Whether a proposal of Moodix AI waits for « Générer », or a character for its check. */
    proposing: () => Boolean(proposal || checking),
    /**
     * Whether the Studio holds a work (0.6.81): a take being made, a proposal of Moodix AI waiting,
     * a character checked; it stays that conversation's while the page shows another.
     */
    holds,
    /** The conversation whose work the Studio holds, or null. */
    heldFor: () => (heldIn && holds() ? heldIn.conversation : null),
    /** The few seconds the pointer of Moodix AI sets the Studio (it is locked, the page holds its places). */
    settingUp: () => aiWorking,
    /** A work held here may be over (the page asks again): left meanwhile, the Studio follows the page. */
    letGo,
    /**
     * The take on the screen (« PRISE n » at its top left), for what Moodix AI is told of it:
     * { take, media }, or null when the screen shows none (nothing made, a file of the disk, a
     * creation being made).
     */
    screenTake: () => {
      const record = onStage(),
        take = record?.outputs?.[0]?.take;
      return Number.isInteger(take) ? { take, media: mediaOf(record) } : null;
    },
    /** The verbs the Studio answers for Moodix AI. */
    accepts: name => name in MODE_OF_VERB,
  };
}
