import { FORMATS, formatOf, nearestSize, sizesFor } from './formats.mjs';
import { healThumbnail, thumbnailOf } from './thumbnails.mjs';
import { livePreview } from './live-preview.mjs';
import { setupPointer } from './studio-pointer.mjs';

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
};
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
const leaf = name =>
  String(name)
    .split(/[\\/]/)
    .pop()
    .replace(/\.safetensors$/i, '');
// A length as the Studio writes it everywhere (moodix-design.md 27): two figures before the
// point, two after (« 05.17 s »); in capitals on the screen (« 05.17 S »). The value is the true
// one, from the frames the model makes (5 s asked can be 5.17 s made).
const twoFigures = value => (Math.round(Number(value) * 100) / 100).toFixed(2).padStart(5, '0');
const seconds = value => twoFigures(value) + ' s';
const figures = value => twoFigures(value) + ' S';
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

/** The sizes offered for a workflow in a format, and the one closest to `pixels`. */
export function sizeChoices(workflow, formatId, pixels) {
  const format = FORMATS.find(item => item.id === formatId),
    sizes = format ? sizesFor(format, workflow.limits) : [];
  return { sizes, nearest: nearestSize(sizes, pixels) };
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
  const settings = {};
  for (const setting of workflow?.settings ?? [])
    if (parameters[setting.key] !== undefined) settings[setting.key] = parameters[setting.key];
  return {
    verb: request.tool || request.call?.function?.name || 'create_image',
    workflow: workflow?.id ?? null,
    prompt: String(plan.prompt ?? request.args?.prompt ?? ''),
    promptFree: Boolean(editable.prompt),
    size: width > 0 && height > 0 ? sizeKey({ width, height }) : null,
    format: formatOf(width, height)?.id ?? null,
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
  // The conversation the Studio works in: its id, or null before its first message or creation.
  conversation = () => null,
  // The project of that conversation: its Sortie shows the creations of all its conversations.
  project = () => 'inbox',
  // An id for the conversation, created when it has none yet: a creation belongs to it.
  ensureConversation = async () => conversation(),
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
    legacyRuns = [],
    legacy = false, // the Sortie shows, and the Studio works in, the Studio of before Moodix
    working = null, // { label, fraction, preview, controller | external } while a generation runs
    releasing = null, // the chat model leaving the GPU, asked once the user sets the Studio
    released = false,
    enriching = false,
    extending = null, // the clip being continued
    failure = '',
    advanced = false, // « Plus de réglages » is open
    formatsOpen = false, // « ··· » is open
    drawn = null, // the size the frame was last drawn at, to ease from
    watching = null, // follows the size of the stage
    live = null, // { frame, preview } : the picture so far, in the frame now on the page
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
    shownMedia = null; // { key, element }: what the screen shows, kept from one drawing to the next
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
    // A continuation stays with the workflow that made the clip when it can.
    if (mode === 'video' && extending && !proposal)
      return usable.find(item => item.id === extending.workflowId) ?? first;
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
  const agent = button('studio-agent', '', () => openAgent(), 'agent');
  agent.id = 'agent-open';
  agent.title = 'Agent Moodix AI';
  agent.setAttribute('aria-label', 'Agent Moodix AI');
  agent.setAttribute('aria-controls', 'chat-panel');
  // Its word leaves when the bar is just too narrow for one line (moodix.css): its name stays. No
  // colour along its foot (moodix-design.md 7 bis 22: the colour goes to Générer); a light runs
  // there while Moodix AI writes with the chat folded.
  const light = node('span', 'studio-agent-light');
  light.setAttribute('aria-hidden', 'true');
  agent.append(node('span', 'studio-agent-word', 'Agent'), light);
  // The settings Moodix AI may change wear its tile; the one it is changing, a ring; those it
  // has set, a fine trace while it works. Once it has stopped, nothing is framed any more.
  function aiTarget(element, key) {
    element.dataset.ai = key;
    if (ai?.active === key) element.setAttribute('data-ai-active', '');
    if (ai?.touched.has(key)) element.setAttribute('data-ai-touched', '');
    return element;
  }
  function field(label, control, { help, tip, wide = false, mark = false } = {}) {
    const wrapper = node('label', 'studio-field' + (wide ? ' is-wide' : '')),
      title = node('span', 'studio-label', label);
    if (mark) {
      const dot = node('span', 'ai-mark');
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', 'Moodix AI peut régler ce paramètre');
      dot.title = 'Moodix AI peut régler ce paramètre';
      title.append(dot);
    }
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
    // Kept as a reference of the project (« #ref3 »), shared with its chats.
    const imported = await assets.importFiles([file], { project: project() });
    if (!imported.length)
      return notice(
        (media === 'video' ? 'Vidéo non importée' : 'Image non importée') +
          ' : la bibliothèque est occupée ou le fichier est illisible.',
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
  // The slot an image is being dragged from: dropped on another, the image changes role.
  let dragged = null,
    // A creation of the Sortie dragged to a slot: it becomes that input.
    carried = null;
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
    // An input of a proposal takes only the roles its workflow offers it.
    const refused = [image, other].some(
      item =>
        item?.ref !== undefined &&
        !(proposal?.values.roleChoices[item.ref] ?? []).some(
          choice => choice.role === (item === image ? to.role : from.role),
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
      tile = node('div', 'studio-slot' + (value ? ' is-filled' : '') + (refused ? ' is-blocked' : ''));
    const pick = button('studio-slot-pick', '', () => {
      // An input that does not combine with those given says why. It still takes the image of
      // one of them, dragged here: that is how a role is changed.
      if (refused) return notice(refused);
      if (chosenByAi)
        return notice(
          'Les images de cette proposition sont celles de Moodix AI : demandez-lui dans le chat pour en changer.',
        );
      picker.accept = (media === 'video' ? VIDEO_TYPES : IMAGE_TYPES).join(',');
      picker.onchange = () => {
        const [file] = picker.files;
        picker.value = '';
        void fill(role, index, file, media);
      };
      picker.click();
    });
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
        dragged = { role, index, media };
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', label);
        tile.classList.add('is-dragged');
      };
      pick.ondragend = () => {
        dragged = null;
        tile.classList.remove('is-dragged');
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
    };
    tile.ondragleave = () => tile.classList.remove('is-target');
    tile.ondrop = event => {
      event.preventDefault();
      event.stopPropagation();
      tile.classList.remove('is-target');
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
    block.append(row);
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
    if (most > 1) {
      const count = node('span', 'studio-references-count', shown.length + '/' + most);
      count.title = shown.length + ' référence' + (shown.length > 1 ? 's' : '') + ' sur ' + most;
      row.append(count);
    }
    block.append(row);
    return block;
  }
  /** The image to modify (and any other input image): a slot each, with its picto. */
  function sourcesBlock(workflow) {
    const block = node('div', 'studio-input-block studio-sources'),
      row = node('div', 'studio-sources-row'),
      labels = [];
    for (const [role, spec] of Object.entries(workflow.roles ?? {})) {
      if (['start_image', 'end_image', 'reference'].includes(role)) continue;
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
      block.append(field(SETTINGS[setting.key], control, { mark: true, tip: WHO[setting.key].help }));
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
      formats = FORMATS.filter(format => sizesFor(format, workflow.limits).length),
      base = workflow.size ?? { width: 1024, height: 1024 };
    if (!formats.some(format => format.id === draft.format))
      draft.format = (formatOf(base.width, base.height) ?? formats[0])?.id ?? null;
    const { sizes, nearest } = sizeChoices(workflow, draft.format, base.width * base.height);
    const proposed = proposal?.mode === mode && proposal.values?.size === draft.size;
    if (!proposed && !sizes.some(size => sizeKey(size) === draft.size)) draft.size = nearest ? sizeKey(nearest) : null;
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
  // The colours of every bar of the Studio, from its start to its end (moodix-design.md 12).
  const STOPS = [
    [0x3d, 0x6b, 0xf5],
    [0x22, 0xa0, 0x60],
    [0xf6, 0xc3, 0x43],
    [0xe8, 0x40, 0x2f],
  ];
  /** The colour of a bar at a place between its ends (0 to 1). */
  function barColour(place) {
    const at = Math.min(1, Math.max(0, place)) * (STOPS.length - 1),
      index = Math.min(STOPS.length - 2, Math.floor(at)),
      part = at - index;
    return `rgb(${STOPS[index].map((value, channel) => Math.round(value + (STOPS[index + 1][channel] - value) * part)).join(', ')})`;
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
        ? 'Enregistrer ces réglages pour ' + workflow.name + ' : ils reviendront à chaque fois que tu le choisis'
        : saved
          ? 'Réglages de ' + workflow.name + ' enregistrés · ils reviennent à chaque fois que tu le choisis'
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
    if (list.length > 1 && !extending) {
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
      // A size of a proposal outside the list (kept from a source) is shown as it is.
      if (draft.size && !list.some(size => sizeKey(size) === draft.size)) {
        const [width, height] = draft.size.split('x').map(Number);
        list.push({ width, height });
      }
      if (list.length) {
        const line = barLine('Taille', {
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
        lines.push(line);
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
    // Left to the assistant: the tile of Moodix AI, which may switch it.
    if (lora.assistant) name.append(node('span', 'ai-mark'));
    name.append(node('span', 'studio-lora-label', lora.name));
    name.title = lora.description ? lora.name + ' · ' + lora.description : lora.name;
    if (!free) value.title = 'Force fixée dans Workflows';
    lock.append(icon('lock'));
    lock.setAttribute('role', 'img');
    lock.setAttribute('aria-label', 'LoRA du workflow');
    lock.title = 'LoRA du workflow : réglé dans Configuration › Workflows';
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
      const wrapper = field(label, control, { mark: true, wide: setting.type === 'string' && !setting.choices });
      if (setting.max !== undefined) wrapper.title = `De ${setting.min ?? 0} à ${setting.max}.`;
      lines.push(wrapper);
    }
    return lines;
  }

  // ------------------------------------------------------------------ the screen
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
   * The screen: a frame in the format of what will be made, as large as the stage allows, with
   * the last creation in it. It eases from the shape it had to the new one, across formats and
   * across modes, and follows the window when it is resized.
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
          (last ? ' has-result' : ''),
      ),
      next = shapeOf();
    frame.append(node('span', 'studio-frame-fill'), node('span', 'studio-frame-label', next.label));
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
    if (last) frame.append(result(last));
    else frame.setAttribute('aria-hidden', 'true');
    const shown = node('span', 'studio-readout', readoutText());
    shown.setAttribute('aria-hidden', 'true');
    frame.append(shown);
    // Over the frame, at its size, never clipped by it. No « i » on the screen: a click on a
    // creation of the Sortie shows it whole with its details.
    const over = node('div', 'studio-frame-over');
    // While a creation is made: the step under way at the foot of the screen, « Arrêter » beside
    // it, as the label is at its top; the bar under the screen keeps its line.
    if (working) {
      const step = node('p', 'studio-progress', working.label ?? '');
      step.id = 'studio-progress';
      step.setAttribute('role', 'status');
      step.hidden = false;
      const halt = button('studio-stop', '', stop, 'stop');
      halt.setAttribute('aria-label', 'Arrêter la génération');
      halt.title = 'Arrêter la génération';
      over.append(step, halt);
    }
    // Drawn at the previous shape first, so the browser has something to ease from.
    const from = drawn ?? frameSize(next.ratio);
    for (const element of [frame, over]) {
      element.style.width = from.width + 'px';
      element.style.height = from.height + 'px';
    }
    box.append(frame, over);
    screen.append(box);
    watching?.disconnect();
    if (typeof ResizeObserver === 'function') {
      // Called once the stage is laid out, then at every change of its size.
      watching = new ResizeObserver(() => reshape(frame, shapeOf(), over));
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
    if (clip) {
      Object.assign(element, { controls: true, preload: 'metadata', playsInline: true, src: output.originalUrl || '' });
      if (output.thumbUrl) element.poster = output.thumbUrl;
    } else {
      Object.assign(element, {
        alt: record.prompt || 'Dernière image créée',
        decoding: 'async',
        src: output.originalUrl,
      });
      element.title = 'Voir l’original et ses paramètres';
      element.onclick = () => viewOutput(record, 0);
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
    const more = button('studio-format is-more' + (extra ? ' is-on' : ''), extra ? extra + ' ···' : '···', () => {
      formatsOpen = !formatsOpen;
      menu.hidden = !formatsOpen;
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
        ? 'Ajoute d’abord la vidéo et le personnage'
        : drafts[mode].prompt.trim().length < IMPROVE_MIN
          ? 'Écris d’abord quelques mots'
          : 'Améliorer le prompt avec Moodix AI (' + MODIFIER + '+E)';
  /** Whether « Améliorer » has what it needs: a few words, or the pictures a prompt is written from. */
  const improves = () =>
    current()?.follows ? Boolean(sceneInputs()) : drafts[mode].prompt.trim().length >= IMPROVE_MIN;
  /** The button follows what is typed, without drawing the Studio again (the field keeps its focus). */
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
      failure = current()?.follows ? 'Ajoute d’abord la vidéo et le personnage.' : 'Écris d’abord quelques mots.';
      return render();
    }
    const reason = blocked();
    if (reason) return notice(reason);
    enriching = true;
    failure = '';
    render();
    const controller = new AbortController();
    try {
      // The chat model is started when it is not running, once it has finished leaving.
      await releasing;
      await waitForModel(api, controller.signal, () => {});
      const result = await (
        await api('studio/enrich', {
          prompt: text,
          verb: verbOf(),
          // Its video or its character made in the conversation are found there.
          ...(scene ? { ...scene, conversationId: place() } : {}),
        })
      ).json();
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
    make.title = enriching ? 'Moodix AI réécrit ton texte…' : improveTitle();
    if (enriching) {
      make.classList.add('is-working');
      make.setAttribute('aria-busy', 'true');
    }
    make.disabled = enriching || Boolean(working) || !improves();
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
    if (offered(verb).length > 1 && !extending) args.workflow = workflow.id;
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
      const chosen = (draft.inputs[role] ?? []).filter(Boolean).map(item => item.source);
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
  async function generate() {
    if (working) return;
    // The character being checked: the key that generates keeps it.
    if (checking) return checking.resolve('ok');
    if (answering()) return approve();
    const reason = blocked() || current()?.unavailable;
    if (reason) return notice(reason);
    let wanted;
    try {
      wanted = request();
    } catch (error) {
      failure = error.message;
      return render();
    }
    failure = '';
    const controller = new AbortController(),
      // Where the creation will be kept once made: the mode it was asked in.
      asked = mode,
      former = legacy;
    let made = null;
    working = { label: 'Préparation…', fraction: null, controller };
    render();
    onChange();
    const pause = () => new Promise(resolve => setTimeout(resolve, 700));
    try {
      await releasing;
      const conversationId = former ? info.legacyId : await ensureConversation();
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
          onProgress: (label, fraction, preview) => {
            if (!working) return;
            Object.assign(working, {
              label: typeof label === 'string' && label ? label : working.label,
              fraction: Number.isFinite(fraction) ? fraction : working.fraction,
              preview: preview ?? working.preview,
            });
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
      await refresh().catch(() => {});
      // It stays on the screen, as the gallery lists it (with the addresses it is shown from).
      const record = made && runs.find(item => item.id === made);
      if (record) kept[asked] = record;
      onChange();
      render();
      scrollStrip();
    }
  }
  function stop() {
    if (!working) return;
    if (working.external) return stopTurn();
    working.controller.abort();
    if (working.requestId) api('tools/cancel', { requestId: working.requestId }).catch(() => {});
  }
  /** Updates the button and the screen alone: the form keeps its focus while a generation runs. */
  function progress() {
    if (!working) return;
    const go = document.querySelector?.('#studio-view .studio-go'),
      line = $('studio-progress');
    const known = Number.isFinite(working.fraction) && working.fraction !== null,
      percent = known ? Math.round(Math.min(1, Math.max(0, working.fraction)) * 100) : null;
    if (go) {
      go.classList.toggle('is-indeterminate', !known);
      go.style.setProperty('--studio-progress', known ? String(percent / 100) : '0');
      const label = go.querySelector('.studio-go-label');
      if (label) label.textContent = known ? `Génération · ${percent} %` : 'Génération…';
      go.setAttribute('aria-valuenow', known ? String(percent) : '');
    }
    if (line) {
      line.hidden = false;
      line.textContent = working.label || '';
    }
    // A sound lights its bars as it goes.
    const bars = document.querySelectorAll?.('#studio-view .studio-bars span') ?? [];
    bars.forEach((bar, index) => bar.classList.toggle('is-lit', known && index < (percent * bars.length) / 100));
    // What the generator has so far, on the screen; the frame is rebuilt with the page.
    const frame = document.querySelector?.('#studio-view .studio-frame');
    if (frame && working.preview) {
      if (live?.frame !== frame) live = { frame, preview: livePreview(node, frame) };
      live.preview.show(working.preview);
    }
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
   * One step of the pointer: it goes (its glide, 0.25 s), it rings, it sets, it leaves a trace:
   * about 0.4 s. Stops when the user takes over.
   */
  async function stepTo(key, label, apply, { anchor } = {}) {
    if (!ai || ai.stopped) return false;
    ai.active = key;
    render();
    pointer?.move(targetOf(key), label, anchor);
    await wait(pointer?.reduced() ? 200 : 260);
    if (!ai || ai.stopped) return false;
    await apply();
    if (!ai || ai.stopped) return false;
    ai.touched.add(key);
    ai.active = null;
    render();
    pointer?.follow(targetOf(key), anchor);
    await wait(pointer?.reduced() ? 200 : 140);
    return Boolean(ai && !ai.stopped);
  }
  /** The prompt written as it is typed: fast, the whole of it in about half a second. */
  async function typePrompt(draft, text) {
    const box = document.querySelector?.('#studio-view [data-ai="prompt"]');
    if (pointer?.reduced() || !box) {
      draft.prompt = text;
      return;
    }
    const step = Math.max(2, Math.ceil(text.length / 36));
    for (let index = step; index < text.length + step; index += step) {
      if (!ai || ai.stopped) return;
      draft.prompt = text.slice(0, index);
      box.value = draft.prompt;
      box.scrollTop = box.scrollHeight;
      await wait(14);
    }
    draft.prompt = text;
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
        render();
        reject(signal.reason || new DOMException('Annulé', 'AbortError'));
      };
      proposal = {
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
      signal?.addEventListener('abort', abort, { once: true });
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
          reject(
            new Error('Le Studio n’a aucun workflow prêt pour cette création : vérifiez Configuration, Workflows.'),
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
    if (!workflow) return render();
    ai = { stopped: false, active: null, touched: new Set() };
    status(true);
    // What the assistant may not change is shown at once, as it will be made.
    if (values.source)
      extending = runs.find(item => item.id === values.source) ?? { id: values.source, prompt: '', parameters: {} };
    else if (target === 'video') extending = null;
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
    if (draft.workflow !== workflow.id && list.length > 1)
      steps.push(['model', 'choisit ' + workflow.name, () => (drafts[target].workflow = workflow.id)]);
    else draft.workflow = workflow.id;
    if (values.promptFree)
      steps.push(['prompt', 'écrit le prompt', () => typePrompt(draft, values.prompt), { anchor: { ax: 34, ay: 30 } }]);
    if (values.references.length)
      steps.push([
        'inputs',
        values.references.length > 1 ? 'place les images' : 'place l’image',
        () => placeReferences(draft, values.references),
      ]);
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
        () => {
          const key = extending ? 'extension' : 'length',
            near = workflow.lengths.seconds.reduce((best, value) =>
              Math.abs(value - values.seconds) < Math.abs(best - values.seconds) ? value : best,
            );
          draft[key] = near;
          values.lengthShown = near;
        },
      ]);
    for (const [key, value] of Object.entries(values.settings))
      if (values.settingsFree[key] && String(draft.settings[workflow.id]?.[key] ?? '') !== String(value))
        steps.push([
          'setting-' + key,
          'règle ' + (SETTINGS[key] || key).toLowerCase(),
          () => {
            (draft.settings[workflow.id] ??= {})[key] = value;
            if (key === 'lyrics' && value) draft.lyrics = true;
          },
        ]);
    for (const [key, label, apply, options] of steps) if (!(await stepTo(key, label, apply, options))) return;
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
      auto ? 'lance la génération (autorisé dans la configuration)' : 'attend ton accord',
    );
    await wait(300);
    if (!ai || ai.stopped || proposal !== current) return;
    status(false);
    if (auto) {
      endPointer();
      return approve();
    }
    await wait(350);
    if (ai && !ai.stopped && proposal === current) endPointer();
  }
  /** The images of a proposal, in the slots of their roles. */
  function placeReferences(draft, references) {
    const inputs = {};
    references.forEach((ref, index) => {
      const resource = ref.resource_id ? assets.resource?.(ref.resource_id) : null,
        record = ref.output_id ? runs.find(item => item.id === ref.output_id) : null,
        output = record?.outputs?.[ref.output_index ?? 0] ?? null,
        // The role as the verb names it (a video to follow is its « source »), else the slot's.
        role = ref.as ?? (ref.role in ROLES ? ref.role : ref.role === 'msr_image' ? 'reference' : ref.role),
        width = resource?.width ?? output?.width ?? record?.parameters?.width,
        height = resource?.height ?? output?.height ?? record?.parameters?.height;
      (inputs[role] ??= []).push({
        source: ref.resource_id
          ? { resource: ref.resource_id }
          : ref.output_id
            ? { output: ref.output_id, ...(ref.output_conversation ? { conversation: ref.output_conversation } : {}) }
            : null,
        preview: resource?.previewUrl || resource?.originalUrl || output?.thumbUrl || output?.originalUrl || '',
        name: ref.label || ref.roleLabel || ROLES[role] || 'Entrée',
        ...(width > 0 && height > 0 ? { width, height } : {}),
        ref: index,
        role,
      });
    });
    draft.inputs = inputs;
  }
  function endPointer() {
    if (ai) ai.stopped = true;
    ai = null;
    status(false);
    pointer?.hide();
    render();
  }
  /** « Reprendre la main », or a touch of the user while the pointer works: it stops, what it set stays. */
  function takeOver() {
    if (!ai) return;
    if (proposal && !proposal.values) return;
    if (proposal) proposal.touched = new Set(ai.touched);
    endPointer();
    $('live-status') &&
      ($('live-status').textContent = 'Vous avez repris la main ; ce que Moodix AI a réglé reste en place.');
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
      const stage = workflow?.stages ? stageOf(workflow, draft.size) : null;
      if (stage && values.stage && stage !== values.stage && plan.editable?.stages?.includes(stage))
        changes.stage = stage;
      else {
        const [width, height] = draft.size.split('x').map(Number);
        Object.assign(changes, { width, height });
      }
    }
    if (values.seconds !== null && items.has('frames') && values.fps) {
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
    // An image dragged to another slot changes role.
    const roles = [];
    for (const [role, list] of Object.entries(draft.inputs))
      for (const item of list ?? [])
        if (item?.ref !== undefined && item.role !== role) roles.push({ index: item.ref, role });
    if (roles.length) changes.references = roles;
    return changes;
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
        const revised = await (
          await api('tools/revise', {
            requestId: request.requestId,
            approvalToken: request.approvalToken,
            edits: changes,
          })
        ).json();
        Object.assign(request, revised);
      } catch (error) {
        working = null;
        failure = error.message;
        return render();
      }
    if (proposal !== current) return;
    proposal = null;
    if (extending) extending = null;
    giveBackSeed(current);
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
        reject(signal.reason || new DOMException('Annulé', 'AbortError'));
      };
      checking = {
        record,
        resolve: decision => {
          signal?.removeEventListener('abort', abort);
          const prompt = drafts.image.prompt.trim();
          checking = null;
          render();
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
    current.resolve('deny');
    render();
    return true;
  }
  /** The seed drawn for a proposal was its own: the next creation by hand draws again, unless the user typed one. */
  function giveBackSeed(answered) {
    const draft = drafts[answered.mode];
    if (answered.values && draft.seed === String(answered.values.seed)) draft.seed = answered.seedBefore ?? '';
  }
  /** A generation approved here, run by the chat turn: its progress comes from there. */
  function follow(label, fraction, preview) {
    if (!working?.external) return;
    Object.assign(working, {
      label: typeof label === 'string' && label ? label : working.label,
      fraction: Number.isFinite(fraction) ? fraction : working.fraction,
      preview: preview ?? working.preview,
    });
    progress();
  }
  /** The end of a generation approved here: its creation is shown on the screen. */
  async function settled(result) {
    const external = working?.external;
    if (external) working = null;
    await refresh().catch(() => {});
    if (result?.record) {
      const record = runs.find(item => item.id === result.record.id) ?? result.record;
      kept[mediaOf(record)] = record;
    } else if (external && result?.error) failure = result.error;
    render();
    scrollStrip();
  }

  // ------------------------------------------------------------------ results
  const mediaOf = record => record.mediaType || 'image';
  /** A creation as an input: its run, with its conversation when it is another of the project. */
  const outputSource = record =>
    record.conversationId && record.conversationId !== place()
      ? { output: record.id, conversation: record.conversationId }
      : { output: record.id };
  /** What the screen shows: the creation just made or opened from the chat, else the last of its mode. */
  function onStage() {
    if (working) return null;
    return kept[mode] ?? runs.find(item => mediaOf(item) === mode) ?? null;
  }
  /** Whether some ready workflow of this verb takes an input in this role. */
  const takes = (verb, role) => (info?.tools?.[verb] ?? []).some(item => item.roles[role]?.count);
  const sourceOf = record => record.parameters?.references?.find(ref => ref.role === 'source_video')?.output_id;
  async function remove(record) {
    try {
      // A creation of another conversation of the project leaves that conversation.
      await api('studio/delete', { id: record.id, conversationId: record.conversationId ?? place() });
      if (extending?.id === record.id) extending = null;
      for (const key of Object.keys(kept)) if (kept[key].id === record.id) delete kept[key];
      await refresh();
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
  // What the Sortie shows (its button at the right): every creation, or one kind of them.
  const SORTS = [
    { id: 'all', icon: 'media', label: 'Tout', none: 'Aucune création dans ce projet pour l’instant' },
    { id: 'image', icon: 'image', label: 'Images', none: 'Aucune image dans ce projet pour l’instant' },
    { id: 'video', icon: 'video', label: 'Vidéos', none: 'Aucune vidéo dans ce projet pour l’instant' },
    { id: 'audio', icon: 'wave', label: 'Sons', none: 'Aucun son dans ce projet pour l’instant' },
  ];
  let sortieKind = 'all', // the kind the Sortie shows
    sortOpen = false; // its button unfolded
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
  /** A creation of the Sortie (of any conversation of the project) in a slot of the mode shown. */
  function putCreation(record, role, index = 0) {
    const output = { ...record.outputs[0], ...measured.get(record.id) };
    (drafts[mode].inputs[role] ??= [])[index] = {
      source: outputSource(record),
      preview: output.thumbUrl || output.originalUrl,
      name: record.prompt || KIND[mediaOf(record)] || 'Création',
      width: output.width ?? record.parameters?.width,
      height: output.height ?? record.parameters?.height,
    };
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
  /** What can be done with a creation: Prolonger or Animer first, then Modifier, Détails, Supprimer. */
  function actionsOf(record) {
    const media = mediaOf(record),
      list = [];
    if (media === 'video')
      list.push({
        id: 'extend',
        label: 'Prolonger',
        glyph: 'extend',
        title: 'Prolonger · écrire la suite de ce clip',
        run: () => {
          extending = record;
          failure = '';
          menuFor = confirmFor = null;
          render();
          $('studio-view')?.scrollTo?.({ top: 0, behavior: 'smooth' });
        },
      });
    if (media === 'image' && animation())
      list.push({
        id: 'animate',
        label: 'Animer',
        glyph: 'animate',
        title: proposal ? 'Moodix AI est en train de proposer' : 'Animer · en faire une vidéo',
        off: Boolean(proposal),
        run: () => animateImage(record),
      });
    // Not in the design, kept: an image starts the next one, with a model that takes one.
    if (media === 'image' && takes('create_image', 'source'))
      list.push({
        id: 'edit',
        label: 'Modifier',
        glyph: 'edit',
        title: 'Modifier · repartir de cette image',
        run: () => useImage(record, 'image', 'source'),
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
  function item(record) {
    const media = mediaOf(record),
      output = record.outputs[0] ?? {},
      number = numberOf(record),
      name = (KIND[media] ?? 'Création') + ' #' + number,
      from = media === 'video' && sourceOf(record) ? numberOf({ id: sourceOf(record), mediaType: 'video' }) : null,
      said = [name, from ? 'suite du clip #' + from : '', record.prompt || ''].filter(Boolean).join(' · '),
      actions = actionsOf(record),
      shown = onStage()?.id === record.id,
      tile = node(
        'div',
        'studio-item' + (extending?.id === record.id ? ' is-selected' : '') + (shown ? ' is-shown' : ''),
      );
    tile.dataset.id = record.id;
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
      dragGhost(pick, event.dataTransfer, media);
    };
    pick.ondragend = () => {
      carried = null;
    };
    if (media === 'audio') {
      const wave = node('span', 'studio-thumb-wave');
      wave.setAttribute('aria-hidden', 'true');
      pick.append(wave);
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
    const badge = node('span', 'studio-item-number', '#' + number);
    badge.setAttribute('aria-hidden', 'true');
    tile.append(pick, badge);
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
  // The pictures of the Sortie, kept from one drawing to the next (those of this drawing in `used`).
  const pictures = new Map();
  let used = new Set();
  /**
   * The Sortie: the creations of the project, of all its conversations, images, clips and sounds
   * together, the newest at the left (a new one pushes the others to the right); nothing written,
   * no count; empty, its icon and a line that say so, without a frame (one would look like a place
   * to drop a file: moodix-design.md 7 bis 18).
   */
  function outputs() {
    used = new Set();
    const section = node('section', 'studio-block is-output studio-results'),
      about = modeOf(mode),
      sort = SORTS.find(item => item.id === sortieKind) ?? SORTS[0],
      shown = sort.id === 'all' ? runs : runs.filter(record => mediaOf(record) === sort.id);
    section.setAttribute('aria-label', 'Sortie');
    if (!runs.length) {
      const empty = node('div', 'studio-empty-strip');
      empty.append(icon(about.icon), node('span', '', SORTS[0].none));
      section.append(empty);
      return section;
    }
    // The creations, and at their right the button that sorts them.
    const row = node('div', 'studio-sortie-row');
    section.append(row);
    if (!shown.length) {
      const empty = node('div', 'studio-empty-strip');
      empty.append(icon(sort.icon), node('span', '', sort.none));
      row.append(empty, sortButton(sort));
      return section;
    }
    const strip = node('div', 'studio-strip studio-timeline');
    strip.setAttribute('aria-label', sort.id === 'all' ? 'Créations du projet' : sort.label + ' du projet');
    for (const record of shown) strip.append(item(record));
    // The wheel of a mouse scrolls it sideways, the pointer anywhere over the Sortie (a mouse has
    // no sideways wheel); a sideways move of a trackpad is left to the browser.
    section.onwheel = event => scrollSideways(strip, event);
    row.append(strip, sortButton(sort));
    // Those no longer shown (another mode, a creation removed) are let go.
    for (const key of pictures.keys()) if (!used.has(key)) pictures.delete(key);
    return section;
  }
  /**
   * What the pointer carries when a creation leaves the Sortie: its picture as small as a slot of
   * the inputs (one on the screen gives the size, 52 px otherwise), cut to fill it as the slot
   * shows it, corners rounded; a sound, its grey stripes. Drawn at once on a canvas, from the
   * picture the tile already holds: nothing is loaded while the drag starts.
   */
  function dragGhost(pick, transfer, media) {
    const page = globalThis.document;
    if (!transfer?.setDragImage || !page?.createElement || !page.body) return;
    const slot = page.querySelector?.('#studio-view .studio-slot')?.getBoundingClientRect?.(),
      width = Math.round(slot?.width || 52),
      height = Math.round(slot?.height || 52),
      ratio = globalThis.devicePixelRatio || 1,
      canvas = page.createElement('canvas'),
      context = canvas.getContext?.('2d');
    if (!context) return;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    Object.assign(canvas.style, {
      position: 'fixed',
      top: '-1000px',
      left: '-1000px',
      width: width + 'px',
      height: height + 'px',
      pointerEvents: 'none',
    });
    context.beginPath();
    if (context.roundRect) context.roundRect(0, 0, canvas.width, canvas.height, 6 * ratio);
    else context.rect(0, 0, canvas.width, canvas.height);
    context.clip();
    context.fillStyle = '#000';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const source = pick.querySelector?.('img, video'),
      sourceWidth = source?.naturalWidth || source?.videoWidth,
      sourceHeight = source?.naturalHeight || source?.videoHeight,
      // A picture still loading has its size and no pixels yet.
      drawable = source?.tagName === 'VIDEO' ? source.readyState >= 2 : source?.complete !== false;
    if (media !== 'audio' && sourceWidth && sourceHeight && drawable) {
      const scale = Math.max(canvas.width / sourceWidth, canvas.height / sourceHeight),
        drawn = [sourceWidth * scale, sourceHeight * scale];
      context.drawImage(source, (canvas.width - drawn[0]) / 2, (canvas.height - drawn[1]) / 2, ...drawn);
    } else if (media === 'audio') {
      context.fillStyle = '#6e7480';
      for (let x = 7 * ratio; x < canvas.width - 7 * ratio; x += 7 * ratio)
        context.fillRect(x, canvas.height * 0.34, 3 * ratio, canvas.height * 0.32);
    } else {
      // Its picture not there yet: the slot's size all the same, framed in grey.
      context.strokeStyle = '#6e7480';
      context.lineWidth = 2 * ratio;
      context.strokeRect(ratio, ratio, canvas.width - 2 * ratio, canvas.height - 2 * ratio);
    }
    page.body.append(canvas);
    transfer.setDragImage(canvas, width / 2, height / 2);
    // Its picture is taken as the drag starts: the canvas can go.
    setTimeout(() => canvas.remove(), 0);
  }
  /**
   * The button at the right of the Sortie: the kind it shows (all of them: the media icon). A
   * click unfolds it downward into the other kinds; one chosen, the Sortie shows only them. Échap
   * or the focus leaving folds it.
   */
  function sortButton(sort) {
    const box = node('div', 'studio-sort' + (sortOpen ? ' is-open' : '')),
      main = button('studio-sort-go is-current', '', () => {
        sortOpen = !sortOpen;
        render();
        document.querySelector?.('#studio-view .studio-sort-go')?.focus?.();
      }, sort.icon),
      said = sort.id === 'all' ? 'tout' : sort.label.toLowerCase();
    main.setAttribute('aria-label', 'Trier la Sortie · ' + said);
    main.title = sort.id === 'all' ? 'Tout afficher · trier' : sort.label + ' seulement · trier';
    main.setAttribute('aria-haspopup', 'menu');
    main.setAttribute('aria-expanded', String(sortOpen));
    box.append(main);
    if (sortOpen) {
      const menu = node('div', 'studio-sort-menu');
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', 'Trier la Sortie');
      for (const other of SORTS.filter(item => item.id !== sort.id)) {
        const choice = button('studio-sort-choice', '', () => {
          sortieKind = other.id;
          sortOpen = false;
          render();
          document.querySelector?.('#studio-view .studio-sort-go')?.focus?.();
        }, other.icon);
        const named = other.id === 'all' ? 'Tout afficher' : other.label + ' seulement';
        choice.setAttribute('role', 'menuitemradio');
        choice.setAttribute('aria-checked', 'false');
        choice.setAttribute('aria-label', named);
        choice.title = named;
        menu.append(choice);
      }
      box.append(menu);
    }
    box.onkeydown = event => {
      if (event.key !== 'Escape' || !sortOpen) return;
      event.preventDefault();
      event.stopPropagation?.();
      sortOpen = false;
      render();
      document.querySelector?.('#studio-view .studio-sort-go')?.focus?.();
    };
    box.onfocusout = event => {
      if (sortOpen && !box.contains?.(event.relatedTarget)) {
        sortOpen = false;
        render();
      }
    };
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
  /** A block of the Studio on its grain of old film (moodix.css): still dust and three scratches
   *  under what the block holds, which goes above it, so that no grain is ever over a picture. */
  function grained(block) {
    const grain = node('div', 'studio-grain'),
      body = node('div', 'studio-block-body');
    grain.setAttribute('aria-hidden', 'true');
    grain.innerHTML =
      '<svg class="studio-dust" width="100%" height="100%" focusable="false">' +
      '<rect width="100%" height="100%" filter="url(#moodix-dust)"/></svg><div class="studio-scratches"></div>';
    body.append(...block.children);
    block.replaceChildren(grain, body);
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
    const bar = $('studio-kinds');
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
          tab.append(icon(item.icon));
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
  function chooseMode(id) {
    if (working || mode === id) return;
    if (ai) takeOver();
    setMode(id);
    release();
  }
  function setMode(next) {
    mode = next;
    failure = '';
    formatsOpen = false;
    if (next !== 'video') extending = null;
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
    if (!info.enabled) return message('La génération locale est désactivée : activez-la dans Configuration.');
    if (!workflow)
      return message(
        mode === 'audio'
          ? 'Aucun workflow de son prêt : téléchargez les modèles de musique et de bruitages dans models\\audio.'
          : 'Aucun workflow prêt pour cette création : vérifiez Configuration, Workflows.',
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
    write.setAttribute('aria-label', 'Entrée');
    preview.setAttribute('aria-label', 'Aperçu et génération');
    settings.setAttribute('aria-label', 'Réglages');

    // Entrée: what the user writes and hands over.
    const named = node('label', 'sr-only', 'Prompt');
    named.htmlFor = 'studio-prompt';
    write.append(named);
    if (mode === 'video' && extending) {
      const banner = node('div', 'studio-extending');
      banner.append(icon('forward'), node('span', '', 'Suite du clip : ' + (extending.prompt || '').slice(0, 90)));
      if (!answering())
        banner.append(
          button('studio-link', 'Annuler', () => {
            extending = null;
            render();
          }),
        );
      write.append(banner);
    }
    const prompt = textarea(
      draft.prompt,
      8,
      extending
        ? 'Ce qui se passe ensuite…'
        : mode === 'image'
          ? 'Décris ton image…'
          : mode === 'video'
            ? workflow.follows
              ? 'Décris la vidéo avec ton personnage…'
              : 'Décris ta vidéo…'
            : 'Décris ton son…',
      value => {
        draft.prompt = value;
        // « Améliorer le prompt » waits for a few words.
        improvable();
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
        write.append(field(SETTINGS.lyrics, box, { wide: true, mark: true }));
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
    const shape = shapeBlock(workflow);
    if (shape) settings.append(shape);
    const styled = workflow.styled && mode !== 'audio' && !extending && !answering();
    const loras = loraBlock(workflow, styled);
    if (loras) settings.append(loras);
    const rare = rareLines(workflow);
    if (rare.length) {
      const more = button('studio-more-pill' + (advanced ? ' is-open' : ''), '···', () => {
        advanced = !advanced;
        render();
      });
      more.setAttribute('aria-label', 'Plus de réglages');
      more.title = 'Plus de réglages';
      more.setAttribute('aria-expanded', String(advanced));
      const block = node('div', 'studio-set-block studio-rare');
      block.hidden = !advanced;
      block.append(...rare);
      settings.append(more, block);
    }

    // The preview, its formats and the button.
    const { screen, frame } = stage();
    preview.append(screen);
    const bar = node('div', 'studio-actionbar');
    if (workflow.limits && !extending && mode !== 'audio') {
      bar.append(formatChips(workflow, frame));
      bar.classList.add('has-formats');
    }
    const go = aiTarget(button('primary studio-go', '', generate, 'play'), 'generate'),
      label = node('span', 'studio-go-label', working ? 'Génération…' : extending ? 'Générer la suite' : 'Générer'),
      fill = node('span', 'studio-go-bar');
    fill.setAttribute('aria-hidden', 'true');
    // The triangle and its word, centred (moodix-design.md 7 bis 22); the keys are in its tooltip.
    // While the creation is made, « Génération · 42 % » alone, over the bar that fills the button.
    go.append(label, fill);
    go.title = (answering() ? 'Générer la proposition de Moodix AI' : 'Générer') + ` (${MODIFIER}+Entrée)`;
    go.disabled = enriching || Boolean(working) || Boolean(workflow.unavailable);
    // The only model of this mode cannot run here: « Générer » is greyed and says why.
    if (workflow.unavailable) {
      go.title = workflow.unavailable;
      go.classList.add('is-unavailable');
    }
    if (working) {
      go.setAttribute('role', 'progressbar');
      go.setAttribute('aria-valuemin', '0');
      go.setAttribute('aria-valuemax', '100');
      go.setAttribute('aria-label', 'Génération en cours');
    }
    // « Agent » and « Générer » (and what goes with it) together at the right: they wrap as one.
    const group = node('div', 'studio-go-group');
    group.append(agent, go);
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
      const no = button('secondary studio-decline', 'Annuler', () => decline());
      no.title = 'Refuser cette proposition de Moodix AI';
      group.append(no);
    }
    bar.append(group);
    preview.append(bar);
    if (failure) {
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
    body.dataset.mode = mode;
    // The stage leaves with the form it is in, and nothing follows its size any longer: still
    // watched, it was reported once more as it went, with no mode left to read a format from.
    watching?.disconnect();
    watching = null;
    if (!info) {
      if (unreadable) return body.replaceChildren(message('Studio indisponible : ' + unreadable));
      sketched = true;
      return body.replaceChildren(skeleton());
    }
    // Where the Sortie was scrolled to: drawn again, it stays there (a click on a creation, a
    // change of model), not back at its start.
    const along = document.querySelector?.('#studio-view .studio-strip')?.scrollLeft ?? 0;
    const desk = form();
    if (sketched) desk.classList.add('is-arriving');
    sketched = false;
    body.replaceChildren(desk);
    if (along) {
      const strip = document.querySelector?.('#studio-view .studio-strip');
      if (strip) strip.scrollLeft = along;
    }
    if (working) progress();
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
    runs = route ? ((await (await api(route)).json()).runs ?? []) : [];
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
    // Drawn again only if what it shows has changed, once the page has stopped moving.
    await afterMove();
    if (shown() !== drawn) render();
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
    for (const key of Object.keys(kept)) delete kept[key];
    extending = null;
    failure = '';
    legacy = false;
  }
  /** Another conversation is open: the Studio shows its creations. */
  function conversationChanged() {
    forget();
    onConversation();
    if (info) void refresh().then(render, () => render());
  }
  /** « Ouvrir » on a card of the chat: the creation on the screen of its mode. */
  function show(record) {
    legacy = false;
    mode = mediaOf(record);
    kept[mode] = record;
    render();
  }

  // Ctrl + Entrée (⌘ on a Mac) generates from anywhere in the Studio, not only from the prompt.
  const shortcut = event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || working || enriching) return;
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
    // A touch of the user while the pointer works: it stops, and leaves what it set.
    const touched = event => {
      if (event.isTrusted !== false && ai) takeOver();
      else if (event.type === 'input' && !proposal) release();
    };
    view.addEventListener?.('input', touched, true);
    view.addEventListener?.('pointerdown', event => event.isTrusted !== false && ai && takeOver(), true);
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
    if (menu) menu.hidden = true;
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
    /** Whether a proposal of Moodix AI waits for « Générer », or a character for its check. */
    proposing: () => Boolean(proposal || checking),
    /** The verbs the Studio answers for Moodix AI. */
    accepts: name => name in MODE_OF_VERB,
  };
}
