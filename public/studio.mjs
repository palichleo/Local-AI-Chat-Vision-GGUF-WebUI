import { FORMATS, formatOf, nearestSize, sizesFor } from './formats.mjs';
import { thumbnailOf } from './thumbnails.mjs';
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
    none: 'Vos images apparaîtront ici.',
  },
  {
    id: 'video',
    verb: 'create_video',
    label: 'Vidéo',
    icon: 'video',
    output: 'Timeline',
    none: 'Vos vidéos s’aligneront ici, dans l’ordre de création.',
  },
  { id: 'audio', verb: 'create_audio', label: 'Son', icon: 'wave', output: 'Sons', none: 'Vos sons apparaîtront ici.' },
];
const MODE_OF_VERB = { create_image: 'image', create_video: 'video', extend_video: 'video', create_audio: 'audio' };
const ROLES = {
  source: 'Image à modifier',
  start_image: 'Image de début',
  end_image: 'Image de fin',
  reference: 'Référence',
};
// Under each input tile: one word, the full name in its tooltip.
const SHORT = { source: 'À modifier', start_image: 'Début', end_image: 'Fin', reference: 'Réf.' };
const SETTINGS = { lyrics: 'Paroles', seconds: 'Durée (s)', language: 'Langue' };
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
const seconds = value => (Math.round(value * 10) / 10).toString().replace('.', ',') + ' s';
// A length as the screen and the cards write it: two figures, in capitals (« 05 S »).
const figures = value => {
  const rounded = Math.round(value * 10) / 10;
  return (rounded < 10 ? '0' : '') + String(rounded).replace('.', ',') + ' S';
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
  // The pace of the pointer: 1 as it is seen, 0 at once (the tests).
  pace = 1,
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
  const verbOf = () => (mode === 'video' && extending ? 'extend_video' : modeOf(mode).verb);
  const offered = (verb = verbOf()) => info?.tools?.[verb] ?? [];
  const place = () => (legacy ? (info?.legacyId ?? null) : conversation());
  function current() {
    const draft = drafts[mode],
      list = offered();
    // A continuation stays with the workflow that made the clip when it can.
    if (mode === 'video' && extending && !proposal)
      return list.find(item => item.id === extending.workflowId) ?? list[0] ?? null;
    return list.find(item => item.id === draft.workflow) ?? list[0] ?? null;
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
  // The settings Moodix AI may change wear its tile; the one it is changing, a ring.
  function aiTarget(element, key) {
    element.dataset.ai = key;
    if (ai?.active === key) element.setAttribute('data-ai-active', '');
    if (ai?.touched.has(key) || proposal?.touched?.has(key)) element.setAttribute('data-ai-touched', '');
    return element;
  }
  function field(label, control, { help, wide = false, mark = false } = {}) {
    const wrapper = node('label', 'studio-field' + (wide ? ' is-wide' : '')),
      title = node('span', 'studio-label', label);
    if (mark) {
      const dot = node('span', 'ai-mark');
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', 'Moodix AI peut régler ce paramètre');
      dot.title = 'Moodix AI peut régler ce paramètre';
      title.append(dot);
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
  async function fill(role, index, file) {
    if (!file) return;
    const imported = await assets.importFiles([file], { reveal: false });
    if (!imported.length)
      return notice('Image non importée : la bibliothèque est occupée ou le fichier est illisible.');
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
  let dragged = null;
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
  function slot(workflow, role, index, label, short = label) {
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
      picker.onchange = () => {
        const [file] = picker.files;
        picker.value = '';
        void fill(role, index, file);
      };
      picker.click();
    });
    pick.title = refused || (value ? label + ' · glissez-la vers un autre emplacement pour changer son rôle' : label);
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
      pick.draggable = !working;
      pick.ondragstart = event => {
        dragged = { role, index };
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', label);
        tile.classList.add('is-dragged');
      };
      pick.ondragend = () => {
        dragged = null;
        tile.classList.remove('is-dragged');
      };
    } else pick.append(icon('plus'));
    // The whole tile takes a drop: a file from the computer, or the image of another slot.
    tile.ondragover = event => {
      event.preventDefault();
      if (dragged) event.dataTransfer.dropEffect = 'move';
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
        return move(workflow, from, { role, index });
      }
      if (refused) return notice(refused);
      if (chosenByAi) return;
      void fill(role, index, event.dataTransfer.files[0]);
    };
    tile.append(pick, node('span', 'studio-slot-label', short));
    if (value && !chosenByAi) {
      const remove = button(
        'studio-slot-remove',
        '',
        () => {
          draft.inputs[role][index] = null;
          render();
        },
        'close',
      );
      remove.setAttribute('aria-label', 'Retirer ' + label);
      tile.append(remove);
    }
    return tile;
  }
  function inputs(workflow) {
    const row = node('div', 'studio-slots');
    for (const [role, spec] of Object.entries(workflow.roles)) {
      if (!spec.count || !spec.media.includes('image')) continue;
      for (let index = 0; index < spec.count; index++)
        row.append(
          slot(
            workflow,
            role,
            index,
            ROLES[role] + (spec.count > 1 ? ' ' + (index + 1) : ''),
            SHORT[role] + (spec.count > 1 ? ' ' + (index + 1) : ''),
          ),
        );
    }
    return row.children.length ? aiTarget(row, 'inputs') : null;
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
  /** Fills the resolution list for the draft's format. */
  function listSizes(control, workflow) {
    const { sizes, final } = sizing(workflow),
      draft = drafts[mode],
      list = [...sizes];
    // A size of a proposal outside the list (kept from a source) is shown as it is.
    if (draft.size && !list.some(size => sizeKey(size) === draft.size)) {
      const [width, height] = draft.size.split('x').map(Number);
      list.push({ width, height });
    }
    control.replaceChildren();
    for (const size of list)
      control.add(
        new Option(`${size.width} × ${size.height}` + (sizeKey(size) === final ? ' · finale' : ''), sizeKey(size)),
      );
    control.value = draft.size ?? '';
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
  /**
   * The length, in a list like the other settings: the lengths the model allows, from its
   * counts of frames (MiniMax H3: 17n + 5 frames at 24 a second, from 5,2 s; LTX 2.5 from 0,7 s).
   */
  function lengthField(workflow) {
    const length = lengthOf(workflow);
    if (!length) return null;
    const draft = drafts[mode],
      control = select(
        length.list.map(value => [value, seconds(value)]),
        length.value,
        value => {
          draft[length.key] = Number(value);
          readout();
        },
      );
    control.className = 'studio-length';
    aiTarget(control, 'duration');
    return field(extending ? 'Durée ajoutée' : 'Durée', control);
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
    const format = FORMATS.find(item => item.id === drafts[mode].format);
    return { ratio: format?.ratio ?? 1, label: format?.id ?? '' };
  }
  /** What will be made, in figures, at the top left of the screen. */
  function readoutText(workflow = current()) {
    if (!workflow) return '';
    const shape = shapeOf(),
      length = lengthOf(workflow);
    if (mode === 'audio') {
      const sound =
        drafts.audio.settings[workflow.id]?.seconds ?? workflow.settings.find(s => s.key === 'seconds')?.default;
      return [(workflow.for || workflow.name || 'Son').toUpperCase(), sound ? figures(Number(sound)) : '']
        .filter(Boolean)
        .join(' · ');
    }
    if (mode === 'image') return [shape.label, 'IMAGE'].filter(Boolean).join(' · ');
    const stage = extending ? 'SUITE' : { draft: 'BROUILLON', final: 'FINALE' }[stageOf(workflow)];
    return [shape.label, length ? figures(length.value) : '', stage].filter(Boolean).join(' · ');
  }
  function readout() {
    const text = document.querySelector?.('.studio-readout');
    if (text) text.textContent = readoutText();
  }
  /** The room the frame has: its stage, less a margin; a default before the stage is laid out. */
  function room(frame) {
    const box = frame.parentElement,
      width = box?.clientWidth ?? 0,
      height = box?.clientHeight ?? 0;
    // As large as the stage: the Studio fills the window, the screen with it.
    return width > 40 && height > 40 ? { width: Math.min(width, 1600), height: Math.min(height, 1000) } : FRAME;
  }
  function reshape(frame, { ratio }) {
    const size = frameSize(ratio, room(frame));
    frame.style.width = size.width + 'px';
    frame.style.height = size.height + 'px';
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
      last = working ? null : (kept[mode] ?? null),
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
    // Drawn at the previous shape first, so the browser has something to ease from.
    const from = drawn ?? frameSize(next.ratio);
    frame.style.width = from.width + 'px';
    frame.style.height = from.height + 'px';
    box.append(frame);
    screen.append(box);
    watching?.disconnect();
    if (typeof ResizeObserver === 'function') {
      // Called once the stage is laid out, then at every change of its size.
      watching = new ResizeObserver(() => reshape(frame, shapeOf()));
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
  /** The formats under the preview: 1:1, 16:9, 9:16, and « ··· » for all of them. */
  function formatChips(workflow, frame, resolution) {
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
      listSizes(resolution, workflow);
      // The chips change with the format (another one may take the place of « ··· »).
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
  /**
   * The LoRAs the workflow brings, chosen in its settings (Workflows): a row each, its name, its
   * strength, and whether it is on. Those « Activé » there are always on; those left to the
   * « Assistant » (the tile of Moodix AI) are switched here as Moodix AI would, their strength too.
   */
  function workflowLoraSection(workflow) {
    const section = node('section', 'studio-loras is-workflow'),
      head = node('div', 'studio-loras-head');
    head.append(node('h3', '', 'LoRA du workflow'));
    section.append(head);
    for (const lora of workflow.loras) {
      const choice = loraChoice(workflow, lora),
        row = node('div', 'studio-lora is-workflow' + (choice.on ? '' : ' is-off')),
        name = node('span', 'studio-lora-name'),
        amount = node('output', 'studio-lora-strength', strengthText(choice.strength)),
        toggle = node('input', 'studio-lora-switch');
      let slider = null;
      if (lora.assistant) name.append(node('span', 'ai-mark'));
      name.append(node('span', 'studio-lora-label', lora.name));
      name.title = lora.description ? lora.name + ' · ' + lora.description : lora.name;
      toggle.type = 'checkbox';
      toggle.checked = choice.on;
      toggle.disabled = !lora.assistant;
      toggle.title = lora.assistant
        ? 'Utiliser ce LoRA pour cette création'
        : 'Activé dans Workflows : toujours appliqué';
      toggle.setAttribute('aria-label', 'LoRA ' + lora.name);
      toggle.onchange = () => {
        choice.on = toggle.checked;
        row.classList.toggle('is-off', !choice.on);
        if (slider) slider.disabled = !choice.on;
      };
      if (freeStrength(lora)) {
        slider = node('input');
        slider.type = 'range';
        slider.min = String(lora.strength.min ?? 0);
        slider.max = String(lora.strength.max ?? 2);
        slider.step = '0.05';
        slider.value = String(choice.strength);
        slider.disabled = !choice.on;
        slider.title = 'Force du LoRA';
        slider.setAttribute('aria-label', 'Force du LoRA ' + lora.name);
        slider.oninput = () => {
          choice.strength = Number(slider.value);
          amount.textContent = strengthText(choice.strength);
        };
        row.append(name, slider, amount, toggle);
      } else {
        amount.title = 'Force fixée dans Workflows';
        row.append(name, amount, toggle);
      }
      section.append(row);
    }
    return section;
  }

  // ------------------------------------------------------------------ LoRA
  /** The LoRAs added to the model for this creation: three at most, a card each, its name over its strength. */
  function loraSection() {
    const draft = drafts[mode],
      section = node('section', 'studio-loras'),
      head = node('div', 'studio-loras-head');
    head.append(
      node('h3', '', 'Style (LoRA)'),
      node('span', 'studio-loras-count', `${draft.styles.length} / ${MAX_STYLES}`),
    );
    section.append(head);
    draft.styles.forEach((style, index) => {
      const card = node('div', 'studio-lora'),
        name = select(
          info.styles.map(file => [file, leaf(file)]),
          style.name,
          value => {
            style.name = value;
          },
        ),
        slider = node('input'),
        amount = node('output', 'studio-lora-strength', strengthText(style.strength));
      name.setAttribute('aria-label', 'LoRA');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '2';
      slider.step = '0.05';
      slider.value = String(style.strength);
      slider.title = 'Force du LoRA';
      slider.setAttribute('aria-label', 'Force du LoRA');
      slider.oninput = () => {
        style.strength = Number(slider.value);
        amount.textContent = strengthText(style.strength);
      };
      const remove = button(
        'studio-lora-remove',
        '',
        () => {
          draft.styles.splice(index, 1);
          render();
        },
        'close',
      );
      remove.title = 'Retirer ce LoRA';
      remove.setAttribute('aria-label', 'Retirer ce LoRA');
      card.append(name, remove, slider, amount);
      section.append(card);
    });
    if (!info.styles.length)
      section.append(node('small', 'field-help', 'Aucun LoRA listé : le dossier loras est vide.'));
    else if (draft.styles.length < MAX_STYLES)
      section.append(
        button(
          'studio-lora-add',
          'Ajouter un LoRA',
          () => {
            draft.styles.push({ name: info.styles[0], strength: 1 });
            render();
          },
          'plus',
        ),
      );
    return section;
  }

  // ------------------------------------------------------------------ the prompt, enriched
  /** The chat model rewrites what is typed as a full prompt; what was typed can be taken back. */
  async function enrich() {
    if (enriching || working) return;
    const draft = drafts[mode],
      text = draft.prompt.trim();
    if (!text) {
      failure = 'Écrivez d’abord quelques mots à enrichir.';
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
      const result = await (await api('studio/enrich', { prompt: text, verb: verbOf() })).json();
      draft.before = text;
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
   * In the corner of the prompt: the star that enriches it (its name for screen readers and in
   * its tooltip), and once used the arrow back to what was typed.
   */
  function enrichRow() {
    const draft = drafts[mode],
      row = node('div', 'studio-enrich'),
      label = enriching ? 'Enrichissement…' : 'Enrichir le prompt',
      make = button('studio-enrich-go', '', enrich, 'spark');
    make.append(node('span', 'sr-only', label));
    make.setAttribute('aria-label', label);
    make.title = enriching
      ? 'Le modèle de chat réécrit votre texte…'
      : 'Enrichir le prompt : le modèle de chat réécrit votre texte en un prompt complet';
    if (enriching) {
      make.classList.add('is-working');
      make.setAttribute('aria-busy', 'true');
    }
    make.disabled = enriching || Boolean(working);
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
    if (!prompt) throw Error('Écrivez un prompt.');
    const args = { prompt },
      edits = {};
    if (offered().length > 1 && !extending) args.workflow = workflow.id;
    if (mode === 'video')
      args.intention = extending ? 'Suite demandée dans le Studio.' : 'Création demandée dans le Studio.';
    // A continuation starts from its clip; the inputs it also takes (subject references) follow.
    if (extending) args.source = { output: extending.id };
    for (const [role, spec] of Object.entries(workflow.roles)) {
      if (extending && role === 'source') continue;
      const chosen = (draft.inputs[role] ?? []).filter(Boolean).map(item => item.source);
      if (!chosen.length || !spec.count) continue;
      args[role] = role === 'reference' ? chosen : chosen[0];
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
    const styles = workflow.external && mode !== 'audio' && !extending ? draft.styles.filter(style => style.name) : [];
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
    if (answering()) return approve();
    const reason = blocked();
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
  /** The top bar says it while the pointer works, with the way to take over. */
  function status(on) {
    const pill = $('ai-status');
    if (pill) pill.hidden = !on;
    const take = $('ai-takeover');
    if (take) take.onclick = on ? () => takeOver() : null;
  }
  /** Where the pointer goes for a setting: the element that wears its key. */
  const targetOf = key =>
    key === 'kind'
      ? document.querySelector?.(`#studio-kinds [data-mode="${proposal?.mode ?? mode}"]`)
      : document.querySelector?.(`#studio-view [data-ai="${key}"]`);
  /**
   * One step of the pointer: it goes (its glide, 0.45 s), it rings, it sets, it leaves a trace:
   * about 0.75 s. Stops when the user takes over.
   */
  async function stepTo(key, label, apply, { anchor } = {}) {
    if (!ai || ai.stopped) return false;
    ai.active = key;
    render();
    pointer?.move(targetOf(key), label, anchor);
    await wait(pointer?.reduced() ? 200 : 475);
    if (!ai || ai.stopped) return false;
    await apply();
    if (!ai || ai.stopped) return false;
    ai.touched.add(key);
    ai.active = null;
    render();
    pointer?.follow(targetOf(key), anchor);
    await wait(pointer?.reduced() ? 200 : 275);
    return Boolean(ai && !ai.stopped);
  }
  /** The prompt written as it is typed: fast, the whole of it in about a second and a quarter. */
  async function typePrompt(draft, text) {
    const box = document.querySelector?.('#studio-view [data-ai="prompt"]');
    if (pointer?.reduced() || !box) {
      draft.prompt = text;
      return;
    }
    const step = Math.max(2, Math.ceil(text.length / 80));
    for (let index = step; index < text.length + step; index += step) {
      if (!ai || ai.stopped) return;
      draft.prompt = text.slice(0, index);
      box.value = draft.prompt;
      box.scrollTop = box.scrollHeight;
      await wait(15);
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
        if (!info) await load().catch(() => {});
        if (!proposal || proposal.request !== request) return;
        proposal.values = proposedValues(request, offered(request.tool || request.call?.function?.name));
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
    // The values it reached are those of the proposal: what changes after that is the user's.
    current.touched = new Set(ai.touched);
    ai.active = 'generate';
    render();
    const auto = request.autoAllow === true;
    pointer?.move(
      targetOf('generate'),
      auto ? 'lance la génération (autorisé dans la configuration)' : 'attend ton accord',
    );
    await wait(550);
    if (!ai || ai.stopped || proposal !== current) return;
    status(false);
    if (auto) {
      endPointer();
      return approve();
    }
    await wait(650);
    if (ai && !ai.stopped && proposal === current) endPointer();
  }
  /** The images of a proposal, in the slots of their roles. */
  function placeReferences(draft, references) {
    const inputs = {};
    references.forEach((ref, index) => {
      const resource = ref.resource_id ? assets.resource?.(ref.resource_id) : null,
        output = ref.output_id ? runs.find(item => item.id === ref.output_id)?.outputs?.[ref.output_index ?? 0] : null,
        role = ref.role in ROLES ? ref.role : ref.role === 'msr_image' ? 'reference' : ref.role;
      (inputs[role] ??= []).push({
        source: ref.resource_id ? { resource: ref.resource_id } : ref.output_id ? { output: ref.output_id } : null,
        preview: resource?.previewUrl || resource?.originalUrl || output?.thumbUrl || output?.originalUrl || '',
        name: ref.label || ref.roleLabel || ROLES[role] || 'Entrée',
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
  /** The proposal is declined: from its « Annuler », or by a new message in the chat. */
  function decline() {
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
  /** Whether some ready workflow of this verb takes an input in this role. */
  const takes = (verb, role) => (info?.tools?.[verb] ?? []).some(item => item.roles[role]?.count);
  const sourceOf = record => record.parameters?.references?.find(ref => ref.role === 'source_video')?.output_id;
  function length(record) {
    const p = record.parameters ?? {};
    if (mediaOf(record) === 'audio') return p.seconds ? figures(p.seconds) : '';
    return p.frames && p.fps ? figures(p.frames / p.fps) : '';
  }
  async function remove(record) {
    try {
      await api('studio/delete', { id: record.id, conversationId: place() });
      if (extending?.id === record.id) extending = null;
      for (const key of Object.keys(kept)) if (kept[key].id === record.id) delete kept[key];
      await refresh();
    } catch (error) {
      notice(error.message);
    }
    render();
  }
  function actions(record, extra = []) {
    const row = node('div', 'studio-actions');
    for (const [label, glyph, onclick, title] of [
      ...extra,
      ['Détails', 'info', () => viewOutput(record, 0), 'Voir l’original et ses paramètres'],
      [
        '',
        'trash',
        () => remove(record),
        legacy
          ? 'Retirer de l’ancien Studio (le fichier reste dans le dossier output)'
          : 'Retirer de cette conversation (le fichier reste dans le dossier output)',
      ],
    ]) {
      // An icon on the picture; its name for screen readers and in its tooltip.
      const control = button('output-action', '', onclick, glyph);
      if (label) control.append(node('span', 'sr-only', label));
      control.title = label ? label + ' · ' + title : title;
      control.setAttribute('aria-label', label || title);
      control.disabled = Boolean(working);
      row.append(control);
    }
    return row;
  }
  // The size of each image shown, read from the picture itself: a record does not keep it.
  const measured = new Map();
  function useImage(record, target, role) {
    const output = { ...record.outputs[0], ...measured.get(record.id) };
    setMode(target);
    extending = null;
    (drafts[target].inputs[role] ??= [])[0] = {
      source: { output: record.id },
      preview: output.thumbUrl || output.originalUrl,
      name: record.prompt,
      width: output.width ?? record.parameters?.width,
      height: output.height ?? record.parameters?.height,
    };
    followFormat(role);
    render();
    $('studio-view')?.scrollTo?.({ top: 0, behavior: 'smooth' });
  }
  /** Puts a creation on the screen; a clip starts playing. */
  function onScreen(record, play = false) {
    kept[mediaOf(record)] = record;
    render();
    if (play)
      document
        .querySelector?.('#studio-view .studio-frame video, #studio-view .studio-frame audio')
        ?.play?.()
        ?.catch?.(() => {});
  }
  function item(record, number, from) {
    const media = mediaOf(record),
      output = record.outputs[0] ?? {},
      card = node(
        'article',
        'studio-item studio-card' +
          (extending?.id === record.id ? ' is-selected' : '') +
          (kept[mode]?.id === record.id ? ' is-shown' : ''),
      ),
      thumb = node('div', 'studio-thumb');
    if (media === 'audio') {
      const wave = node('span', 'studio-thumb-wave');
      wave.setAttribute('aria-hidden', 'true');
      thumb.append(wave);
    } else {
      const small = output.thumbUrl,
        key = record.id + '|' + (small || output.originalUrl || '');
      let picture = pictures.get(key);
      if (picture) used.add(key);
      else if (small || media === 'image') {
        picture = node('img');
        Object.assign(picture, { alt: record.prompt || '', loading: 'lazy', decoding: 'async' });
        picture.src = small || output.originalUrl || '';
        picture.onload = () => {
          if (media === 'image' && !small) {
            measured.set(record.id, { width: picture.naturalWidth, height: picture.naturalHeight });
            void thumbnailOf(api, record, 0, picture);
          }
        };
      } else {
        // Its first picture only, of which a thumbnail is made for the next time.
        picture = node('video');
        Object.assign(picture, {
          muted: true,
          preload: 'metadata',
          playsInline: true,
          src: (output.originalUrl || '') + '#t=0.1',
        });
        picture.onloadeddata = () => void thumbnailOf(api, record, 0, picture);
      }
      if (!used.has(key)) {
        pictures.set(key, picture);
        used.add(key);
      }
      picture.title = 'Afficher sur l’écran du Studio';
      picture.onclick = () => onScreen(record);
      thumb.append(picture);
    }
    if (media !== 'image') {
      const play = button('studio-play', '', () => onScreen(record, true), 'play');
      play.setAttribute('aria-label', 'Lire sur l’écran du Studio');
      play.title = 'Lire sur l’écran du Studio';
      thumb.append(play);
    }
    const title = node('p', 'studio-item-title studio-prompt', (from ? `↳ #${from} · ` : '') + (record.prompt || ''));
    title.title = record.prompt || '';
    const meta = node(
      'p',
      'studio-item-meta studio-caption',
      [
        number ? '#' + number : '',
        media === 'audio' ? length(record) : '',
        media === 'video' ? length(record) : '',
        media === 'audio' ? (record.workflowName || '').toUpperCase() : '',
      ]
        .filter(Boolean)
        .join(' · '),
    );
    meta.title = record.workflowName || '';
    const extra = legacy
      ? []
      : media === 'video'
        ? [
            [
              'Prolonger',
              'forward',
              () => {
                extending = record;
                failure = '';
                render();
                $('studio-view')?.scrollTo?.({ top: 0, behavior: 'smooth' });
              },
              'Écrire la suite de ce clip',
            ],
          ]
        : media === 'image'
          ? [
              ...(takes('create_image', 'source')
                ? [['Modifier', 'edit', () => useImage(record, 'image', 'source'), 'Repartir de cette image']]
                : []),
              ...(takes('create_video', 'start_image')
                ? [
                    [
                      'Animer',
                      'video',
                      () => useImage(record, 'video', 'start_image'),
                      'En faire l’image de début d’une vidéo',
                    ],
                  ]
                : []),
            ]
          : [];
    thumb.append(actions(record, extra));
    card.append(thumb, title);
    if (meta.textContent) card.append(meta);
    return card;
  }
  // The pictures of the Sortie, kept from one drawing to the next (those of this drawing in `used`).
  const pictures = new Map();
  let used = new Set();
  function outputs() {
    used = new Set();
    const mine = runs.filter(record => mediaOf(record) === mode),
      section = node('section', 'studio-block is-output studio-results'),
      about = modeOf(mode);
    section.setAttribute('aria-label', 'Sortie');
    const extra = node('div', 'studio-output-tools');
    extra.append(node('span', 'studio-count', resultCount(mine.length)));
    if (legacyRuns.length) {
      // The creations of the Studio of before, which had no conversation: still there, apart.
      const where = select(
        [
          ['conversation', 'Cette conversation'],
          ['legacy', 'Ancien Studio'],
        ],
        legacy ? 'legacy' : 'conversation',
        value => {
          legacy = value === 'legacy';
          extending = null;
          void refresh().then(render);
        },
      );
      where.className = 'studio-source-pick';
      where.setAttribute('aria-label', 'Créations affichées');
      where.disabled = Boolean(working || proposal);
      extra.append(where);
    }
    section.append(blockHead('', { extra }));
    if (!mine.length) {
      section.append(node('p', 'studio-empty asset-empty', about.none));
      return section;
    }
    const strip = node(
      'div',
      'studio-strip studio-timeline' + (mode === 'image' ? ' is-images' : mode === 'audio' ? ' is-sounds' : ''),
    );
    if (mode === 'video') {
      // Oldest first: the timeline reads from left to right.
      const clips = [...mine].reverse(),
        numbers = new Map(clips.map((record, index) => [record.id, index + 1]));
      for (const record of clips) strip.append(item(record, numbers.get(record.id), numbers.get(sourceOf(record))));
    } else for (const record of mine) strip.append(item(record));
    section.append(strip);
    // Those no longer shown (another mode, a creation removed) are let go.
    for (const key of pictures.keys()) if (!used.has(key)) pictures.delete(key);
    return section;
  }
  /** A new clip goes at the end of the timeline: the strip shows it. */
  function scrollStrip() {
    const strip = document.querySelector?.('#studio-view .studio-strip');
    if (strip && mode === 'video') strip.scrollLeft = strip.scrollWidth;
  }

  // ------------------------------------------------------------------ the page
  function message(text) {
    const panel = node('section', 'studio-desk is-empty');
    panel.append(node('p', 'asset-empty', text));
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
    preview.append(screen, node('div', 'studio-actionbar is-waiting'));
    const blocks = [
      node('section', 'studio-block is-input'),
      preview,
      node('section', 'studio-block is-settings'),
      node('section', 'studio-block is-output'),
    ];
    desk.append(said, ...blocks.map(grained));
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
  function kinds() {
    const bar = $('studio-kinds');
    if (!bar) return;
    bar.replaceChildren();
    bar.removeAttribute('data-ai-active');
    bar.removeAttribute('data-ai-touched');
    aiTarget(bar, 'kind');
    for (const item of MODES) {
      const tab = button(
        'kind-tab',
        item.label,
        () => {
          if (working || mode === item.id) return;
          if (ai) takeOver();
          setMode(item.id);
          release();
        },
        item.icon,
      );
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(item.id === mode));
      tab.setAttribute('aria-label', item.label);
      tab.title = item.label;
      tab.dataset.mode = item.id;
      tab.disabled = Boolean(working);
      bar.append(tab);
    }
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
          ? 'Décrivez l’image…'
          : mode === 'video'
            ? 'Décrivez le clip : ce qu’on voit, ce qui se passe, la caméra, le son…'
            : 'Décrivez le son : genre, instruments, ambiance…',
      value => {
        draft.prompt = value;
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
    write.append(promptField);
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
    // A continuation shows only the inputs it takes (subject references, for MiniMax H3).
    const row = inputs(workflow);
    if (row) write.append(row);

    // Réglages: the model, the length, the size, the workflow's own settings; the rare ones under « Plus de réglages ».
    if (list.length > 1 && !extending) {
      const model = select(
        list.map(item => [item.id, item.name]),
        workflow.id,
        choose,
      );
      model.title = workflow.description;
      model.disabled = answering();
      if (answering()) model.title = 'Modèle choisi par Moodix AI pour cette proposition';
      aiTarget(model, 'model');
      settings.append(field(mode === 'audio' ? 'Type' : 'Modèle', model));
    }
    const length = lengthField(workflow);
    if (length) settings.append(length);
    const resolution = node('select');
    if (workflow.limits && !extending) {
      listSizes(resolution, workflow);
      resolution.onchange = () => {
        draft.size = resolution.value;
        readout();
      };
      aiTarget(resolution, 'size');
      const sized = field('Taille', resolution);
      sized.title = mode === 'video' ? 'Plus grand : plus long à générer. La taille finale est marquée.' : '';
      settings.append(sized);
    }
    for (const setting of workflow.settings) {
      if (setting.key === 'lyrics' && setting.type === 'string') continue;
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
      settings.append(wrapper);
    }
    const lora = workflow.external && mode !== 'audio' && !extending && !answering();
    // The LoRAs chosen in the workflow's settings: in sight, a proposal of Moodix AI included.
    if (workflow.loras?.length) settings.append(workflowLoraSection(workflow));
    if (workflow.seeded || lora) {
      const more = button('studio-more', advanced ? '− Moins de réglages' : '+ Plus de réglages', () => {
        advanced = !advanced;
        render();
      });
      more.setAttribute('aria-expanded', String(advanced));
      settings.append(more);
      const rare = node('div', 'studio-advanced');
      rare.hidden = !advanced;
      if (workflow.seeded) {
        const seed = node('input');
        seed.type = 'number';
        seed.min = '0';
        seed.placeholder = 'au hasard';
        seed.value = draft.seed;
        seed.oninput = () => {
          draft.seed = seed.value;
        };
        aiTarget(seed, 'seed');
        rare.append(field('Seed', seed));
      }
      if (lora) rare.append(loraSection());
      settings.append(rare);
    }

    // The preview, its formats and the button.
    const { screen, frame } = stage();
    preview.append(screen);
    const bar = node('div', 'studio-actionbar');
    if (workflow.limits && !extending && mode !== 'audio') bar.append(formatChips(workflow, frame, resolution));
    const go = aiTarget(button('primary studio-go', '', generate, 'spark'), 'generate'),
      label = node('span', 'studio-go-label', working ? 'Génération…' : extending ? 'Générer la suite' : 'Générer'),
      key = node('kbd', 'studio-go-key', MODIFIER + ' ↵'),
      fill = node('span', 'studio-go-bar');
    key.setAttribute('aria-hidden', 'true');
    fill.setAttribute('aria-hidden', 'true');
    go.append(label, key, fill);
    go.title = answering() ? 'Générer la proposition de Moodix AI · ' + MODIFIER + ' + Entrée' : MODIFIER + ' + Entrée';
    go.disabled = enriching || Boolean(working);
    if (working) {
      go.setAttribute('role', 'progressbar');
      go.setAttribute('aria-valuemin', '0');
      go.setAttribute('aria-valuemax', '100');
      go.setAttribute('aria-label', 'Génération en cours');
    }
    bar.append(go);
    if (working) {
      const halt = button('secondary studio-stop', '', stop, 'stop');
      halt.setAttribute('aria-label', 'Arrêter la génération');
      halt.title = 'Arrêter la génération';
      bar.append(halt);
    } else if (answering()) {
      const no = button('secondary studio-decline', 'Annuler', () => decline());
      no.title = 'Refuser cette proposition de Moodix AI';
      bar.append(no);
    }
    preview.append(bar);
    const line = node('p', 'studio-progress', working?.label ?? '');
    line.id = 'studio-progress';
    line.setAttribute('role', 'status');
    line.hidden = !working;
    preview.append(line);
    if (failure) {
      const alert = node('p', 'studio-error', failure);
      alert.setAttribute('role', 'alert');
      preview.append(alert);
    }

    desk.append(...[write, preview, settings, outputs()].map(grained));
    desk.classList.toggle('is-generating', Boolean(working));
    if (working) for (const control of desk.querySelectorAll('textarea, select, input')) control.disabled = true;
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
    const desk = form();
    if (sketched) desk.classList.add('is-arriving');
    sketched = false;
    body.replaceChildren(desk);
    if (working) progress();
  }
  async function refresh() {
    if (!info) return;
    const id = place();
    seenConversation = conversation();
    // Without the copies kept for the model (a storyboard per clip): the Studio shows the files.
    runs = id ? (await (await api(`gallery/${id}?images=0`)).json()).runs : [];
    runsFor = id;
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
    try {
      if (!info) await load();
      else if (toolsStale || Date.now() - toolsAt > TOOLS_TTL_MS) {
        const before = JSON.stringify(info);
        void load()
          .then(() => JSON.stringify(info) !== before && !ai && render())
          .catch(() => {});
      }
      if (runsStale || runsFor !== place() || seenConversation !== conversation()) await refresh();
    } catch (error) {
      if (!info) unreadable = error.message;
      notice('Studio indisponible : ' + error.message);
    }
    render();
  }
  /**
   * Reads ahead, as the page opens (app.js): its tools, most of the wait the first time, and the
   * creations of the conversation. The Studio is then drawn whole the first time it comes on screen.
   */
  async function prefetch() {
    try {
      if (!info) await load();
      if (runsStale || runsFor !== place() || seenConversation !== conversation()) await refresh();
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
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || working || enriching) return;
    // The message box of the chat sends with Entrée: the shortcut is the Studio's.
    if (event.target?.id === 'prompt') return;
    event.preventDefault();
    void generate();
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
    /** Whether a proposal of Moodix AI waits for « Générer ». */
    proposing: () => Boolean(proposal),
    /** The verbs the Studio answers for Moodix AI. */
    accepts: name => name in MODE_OF_VERB,
  };
}
