import { formatOf, formatsFor, nearestSize, sizesFor } from './formats.mjs';

const LABELS = {
  width: 'Largeur',
  height: 'Hauteur',
  frames: 'Images',
  fps: 'Cadence (i/s)',
  steps: 'Étapes',
  seed: 'Graine',
  audio: 'Audio',
  overlap_frames: 'Chevauchement (images)',
  cfg: 'CFG',
  guidance: 'Guidance',
  denoise: 'Débruitage',
  start_strength: 'Force de l’image de début',
  end_strength: 'Force de l’image de fin',
  image_compression: 'Compression des images',
  msr_strength: 'Force des références',
  msr_frames: 'Longueur des références (images)',
  max_side: 'Plus grand côté (px)',
  scale: 'Facteur',
  passes: 'Passes',
  color_correction: 'Correction des couleurs',
  multiplier: 'Multiplicateur',
  mode: 'Mode',
  tile: 'Tuile',
  expandPrompt: 'Prompt enrichi',
  seconds: 'Durée (s)',
  lyrics: 'Paroles',
  language: 'Langue',
  guidance_scale: 'Guidance',
  shift: 'Décalage',
  attention: 'Attention',
  sparse_attention: 'Attention creuse',
  sparse_keep: 'Cubes gardés (%)',
  sparse_start: 'Début de l’attention creuse',
  subject: 'Qui remplacer dans la vidéo',
  reference_subject: 'Qui dessiner depuis l’image',
  step_lora_strength: 'Force du LoRA de distillation',
  identity_lora_strength: 'Force du LoRA d’identité',
};
const STAGES = { draft: 'Brouillon', final: 'Finale' };
// Shown in the main area; every other editable parameter goes to « Paramètres avancés ».
const MAIN = new Set(['frames', 'width', 'height', 'seed']);
// Sound settings that matter to every take: shown in the main area too.
const SOUND_MAIN = ['seconds', 'language'];
const ADVANCED_FIRST = ['frames', 'fps', 'audio', 'width', 'height'];
const HELP = {
  msr_frames:
    'Chaque référence de sujet est montrée au modèle comme un court plan fixe de ce nombre d’images, avant la vidéo : plus long, elle pèse un peu plus et coûte un peu plus de calcul.',
  msr_strength: 'À quel point la vidéo suit les références de sujet (1 : au plus près).',
};
// Settings that only matter with a subject reference, and the role that brings one.
const SUBJECT_ROLE = 'msr_image';
const subjectSetting = key => key.startsWith('msr_');
const numeric = value => typeof value === 'number' && Number.isFinite(value);
// The places of the inputs in a card: the frames of the clip, the video followed; the rest are references.
const PLACES = { start_image: 'DÉBUT', end_image: 'FIN' };
const SOURCES = new Set(['source_video', 'driving_video', 'source_image', 'img2img']);
const seconds = value => value.toFixed(2).replace('.', ',') + ' s';

/**
 * A proposal as one form: everything the user may change is editable in place, the common
 * settings first and the rest under « Paramètres avancés ». `edits()` returns only what
 * changed (and throws a readable message for an invalid value); `error(text)` shows a refusal.
 * `onStage(stage, edits)` is called when the version changes: its profile changes the size and
 * length, so the caller asks the server for the new proposal and renders it again.
 * `card`: the form of the card of the conversation (proposal-card.mjs; captures 11 and 12): the
 * length in one click (2 · 4 · 6 · 8 · 10 s), the version and the seed under « Paramètres avancés »,
 * the prompt folded with « Revenir au prompt de Moodix », the choice of Moodix marked « proposé »;
 * the two folds are given back (`folds`: their name and their panel) for the card to place. Its
 * inputs are pictures (DÉBUT and FIN in the shape of the format, a rule, RÉF. 1…), « + » where the
 * workflow takes one more (`onAdd`: an image joined to the next message); a changed value turns
 * to the accent (`is-changed`).
 */
export function renderProposal(container, request, { node, onStage, card = false, onAdd = null } = {}) {
  container.replaceChildren();
  const plan = request.plan || {},
    editable = plan.editable || {},
    parameters = plan.parameters || {},
    video = request.mediaType === 'video',
    audio = request.mediaType === 'audio',
    items = new Map((editable.parameters || []).map(item => [item.key, item])),
    controls = new Map(),
    continues = plan.references?.some(ref => ref.role === 'source_video'),
    overlap = continues && numeric(parameters.overlap_frames) ? parameters.overlap_frames : 0;
  const message = node('p', 'video-edit-error');
  message.setAttribute('role', 'alert');
  message.hidden = true;

  function field(label, control, { help, wide = false, name = false } = {}) {
    const wrapper = node('label', 'proposal-field' + (wide ? ' is-wide' : ''));
    const title = node('span', name ? 'proposal-input-name' : '', label);
    if (name) title.title = label;
    wrapper.append(title, control);
    if (help) wrapper.append(node('small', 'field-help', help));
    return wrapper;
  }
  function select(choices, value) {
    const control = node('select');
    for (const [key, text] of choices) control.add(new Option(text, String(key)));
    control.value = String(value);
    return control;
  }
  function fixed(text) {
    return node('output', 'proposal-fixed', text);
  }

  // The control of one generic parameter: a checkbox, a list, a text or a number.
  function control(item) {
    let input;
    if (item.type === 'boolean') {
      input = node('input');
      input.type = 'checkbox';
      input.checked = item.value === true;
    } else if (item.choices) {
      input = select(
        item.choices.map(choice => [choice, String(choice)]),
        item.value,
      );
      input.disabled = item.choices.length < 2;
    } else if (item.type === 'string') {
      input = node('textarea', 'proposal-prompt');
      input.rows = 4;
      input.value = String(item.value ?? '');
    } else {
      input = node('input');
      input.type = 'number';
      input.value = String(item.value);
      if (item.min !== undefined) input.min = String(item.min);
      if (item.max !== undefined) input.max = String(item.max);
      input.step = item.multipleOf ? String(item.multipleOf) : item.type === 'integer' ? '1' : 'any';
    }
    return input;
  }

  container.append(
    node(
      'p',
      'video-intention',
      plan.intention || (video ? 'Proposition vidéo' : audio ? 'Proposition de son' : 'Génération d’image'),
    ),
  );

  // Prompt: editable when the model owns it (folded in a card, at its foot).
  let prompt = null,
    promptField = null;
  if (editable.prompt) {
    prompt = node('textarea', 'proposal-prompt');
    prompt.rows = 4;
    prompt.value = plan.prompt || '';
    prompt.setAttribute('aria-label', 'Prompt');
    promptField = field('Prompt', prompt, { wide: true });
  } else if (plan.prompt) promptField = field('Prompt (fixé par le workflow)', fixed(plan.prompt), { wide: true });
  if (promptField && !card) container.append(promptField);

  // Text settings (the lyrics of a song): wide, under the prompt.
  const texts = [...items.values()].filter(item => item.type === 'string' && !item.choices && !item.locked);
  for (const item of texts) {
    const input = control(item);
    input.setAttribute('aria-label', LABELS[item.key] || item.key);
    controls.set(item.key, input);
    container.append(
      field(LABELS[item.key] || item.key, input, {
        wide: true,
        help: item.key === 'lyrics' ? 'Vide pour un morceau instrumental.' : item.note,
      }),
    );
  }

  // In a card, the inputs as pictures, beside the settings in lines.
  const media = card ? node('div', 'proposal-media') : null;
  if (media) container.append(media);
  const grid = node('div', 'proposal-grid');
  container.append(grid);
  const shown = new Set(texts.map(item => item.key));
  if (audio)
    for (const key of SOUND_MAIN) {
      const item = items.get(key);
      if (!item) continue;
      shown.add(key);
      if (item.locked) {
        grid.append(field(LABELS[key] || key, fixed(String(item.value)), { help: item.locked }));
        continue;
      }
      const input = control(item);
      controls.set(key, input);
      grid.append(field(LABELS[key] || key, input));
    }

  // Inputs, each with the role it plays (and the others it may play); in a card their pictures say
  // it, and a role that may change goes under « Paramètres avancés ».
  const roleControls = [],
    roleFields = [];
  plan.references?.forEach((ref, index) => {
    const label = ref.label || ref.resource_id || 'Entrée ' + ((ref.image ?? index) + 1),
      options = editable.references?.[index] || [];
    if (options.length > 1) {
      const control = select(
        options.map(option => [option.role, option.label]),
        ref.role,
      );
      control.setAttribute('aria-label', 'Rôle de ' + label);
      roleControls.push({ index, control, initial: ref.role });
      roleFields.push(field(card ? 'Rôle de ' + label : label, control, { name: true }));
    } else if (!card) roleFields.push(field(label, fixed(ref.roleLabel || ref.role || ref.input), { name: true }));
  });
  if (!card) grid.append(...roleFields);

  // Version: changing it changes the profile, so the server proposes again.
  let versionField = null;
  if (editable.stages?.length > 1) {
    const stage = select(
      editable.stages.map(value => [value, STAGES[value] || value]),
      plan.stage,
    );
    stage.onchange = () => {
      let edits;
      try {
        edits = form.edits();
      } catch (error) {
        stage.value = plan.stage;
        form.error(error.message);
        return;
      }
      delete edits.stage;
      onStage?.(stage.value, edits);
    };
    controls.set('stage', stage);
    versionField = field('Version', stage);
  } else if (STAGES[plan.stage]) versionField = field('Version', fixed(STAGES[plan.stage]));
  if (versionField) grid.append(versionField);

  // Length: in seconds here, in frames under the advanced settings; both are the same value.
  const fps = () => {
    const control = controls.get('fps');
    const value = control ? Number(control.value) : parameters.fps;
    return value > 0 ? value : null;
  };
  const framesItem = items.get('frames');
  let frames = parameters.frames;
  const lengthText = count => {
    const rate = fps();
    if (!rate || !numeric(count)) return String(count);
    return overlap && count > overlap ? '+' + seconds((count - overlap) / rate) : seconds(count / rate);
  };
  let duration = null;
  if (framesItem && !framesItem.locked && framesItem.choices && fps()) {
    duration = select(
      framesItem.choices.map(choice => [choice, lengthText(choice)]),
      frames,
    );
    duration.disabled = framesItem.choices.length < 2;
    if (card && !duration.disabled) grid.append(lengths(overlap ? 'Durée ajoutée' : 'Durée', duration, framesItem.choices));
    else grid.append(field(overlap ? 'Durée ajoutée' : 'Durée', duration));
  } else if (numeric(frames) && fps())
    grid.append(field(overlap ? 'Durée ajoutée' : 'Durée', fixed(lengthText(frames))));

  /**
   * The length in one click in a card (« Durée : 2 · 4 · 6 · 8 · 10 s »): for each whole second, the
   * nearest length the model accepts, and the one Moodix proposed; the list (hidden) keeps the value.
   */
  function lengths(label, list, choices) {
    const rate = fps(),
      proposed = list.value,
      near = target => choices.reduce((best, choice) => (Math.abs(choice / rate - target) < Math.abs(best / rate - target) ? choice : best));
    const picks = [...new Set([2, 4, 6, 8, 10].map(near).filter(choice => [2, 4, 6, 8, 10].some(target => Math.abs(choice / rate - target) <= 0.6)))];
    if (!picks.some(choice => String(choice) === proposed)) picks.push(Number(proposed));
    picks.sort((a, b) => a - b);
    const wrapper = node('div', 'proposal-field'),
      row = node('div', 'proposal-lengths');
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', label);
    const buttons = picks.map(choice => {
      const button = node('button', 'proposal-length' + (String(choice) === proposed ? ' is-proposed' : ''), String(Math.round((choice - overlap) / rate)));
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(String(choice) === list.value));
      button.title = lengthText(choice) + (String(choice) === proposed ? ' · proposé' : '');
      button.onclick = () => {
        list.value = String(choice);
        list.onchange?.();
        for (const other of buttons) other.setAttribute('aria-checked', String(other === button));
        wrapper.classList?.toggle('is-changed', String(choice) !== proposed);
      };
      return button;
    });
    row.append(...buttons);
    const value = node('span', 'proposal-length-row');
    value.append(row, node('span', 'proposal-unit', 's'));
    list.hidden = true;
    wrapper.append(node('span', '', label), value, list);
    return wrapper;
  }
  // Format and resolution: a clean size for each format, within what the model accepts.
  const widthItem = items.get('width'),
    heightItem = items.get('height'),
    limits = { width: widthItem, height: heightItem },
    formats = formatsFor(limits);
  let size = { width: parameters.width, height: parameters.height };
  let formatControl = null,
    resolutionControl = null;
  const sizeText = value => value.width + ' × ' + value.height;
  const sizeKey = value => value.width + 'x' + value.height;
  // The size Moodix proposed, marked « proposé » in the open menus of a card.
  const proposedSize = sizeKey(size),
    proposedFormat = formatOf(size.width, size.height)?.id,
    unmarks = [];
  /**
   * « proposé » beside the choice of Moodix while a menu of a card opens (at the press of the pointer
   * or of a key); closed, the menu shows the value alone (« 16:9 · Paysage », « 768 × 448 »).
   */
  function proposedMark(control, proposed) {
    const show = open => {
      for (const option of control.options || [])
        option.text = option.text.replace(/ · proposé$/, '') + (open && option.value === proposed ? ' · proposé' : '');
    };
    control.onmousedown = control.onkeydown = () => show(true);
    control.onblur = () => show(false);
    unmarks.push(() => show(false));
  }
  const formatOfSize = () => {
    const format = formatOf(size.width, size.height);
    return format && formats.includes(format) ? format : null;
  };
  // Shows the format of the size (or « Autre ») and the sizes of that format.
  function showSize() {
    const format = formatOfSize();
    if (!format && ![...(formatControl.options || [])].some(option => option.value === 'custom'))
      formatControl.add(new Option('Autre', 'custom'));
    formatControl.value = format ? format.id : 'custom';
    const list = format ? sizesFor(format, limits) : [];
    const known = list.some(item => sizeKey(item) === sizeKey(size));
    resolutionControl.replaceChildren();
    for (const item of [...list, ...(known ? [] : [size])].sort((a, b) => a.width * a.height - b.width * b.height))
      resolutionControl.add(
        new Option(
          sizeText(item) + (!known && item === size && format ? ' (actuelle)' : ''),
          sizeKey(item),
        ),
      );
    resolutionControl.value = sizeKey(size);
    if (controls.get('width')) controls.get('width').value = String(size.width);
    if (controls.get('height')) controls.get('height').value = String(size.height);
    for (const unmark of unmarks) unmark();
    if (card) {
      formatControl.classList?.toggle('is-changed', formatControl.value !== proposedFormat);
      resolutionControl.classList?.toggle('is-changed', sizeKey(size) !== proposedSize);
      showMedia();
    }
  }
  const resizable =
    widthItem && heightItem && !widthItem.locked && !heightItem.locked && numeric(size.width) && numeric(size.height);
  if (resizable) {
    formatControl = select(
      formats.map(format => [format.id, format.label]),
      formats[0]?.id ?? '',
    );
    resolutionControl = node('select');
    formatControl.onchange = () => {
      const format = formats.find(item => item.id === formatControl.value);
      const next = format && nearestSize(sizesFor(format, limits), size.width * size.height);
      if (next) size = { ...next };
      showSize();
    };
    resolutionControl.onchange = () => {
      const [width, height] = resolutionControl.value.split('x').map(Number);
      size = { width, height };
      showSize();
    };
    grid.append(field('Format', formatControl), field('Résolution', resolutionControl));
    if (card) {
      proposedMark(formatControl, proposedFormat);
      proposedMark(resolutionControl, proposedSize);
    }
  } else if (widthItem?.follows)
    // A character put in a video: as many points as this, in the shape of the video followed.
    grid.append(field('Résolution', fixed('environ ' + sizeText(size)), { help: widthItem.locked }));
  else if (numeric(size.width) && numeric(size.height))
    grid.append(
      field(
        'Résolution',
        fixed(sizeText(size)),
        widthItem?.locked ? { help: 'Gardée de la vidéo source.' } : undefined,
      ),
    );

  // Seed, with a new random one at a click.
  let seedField = null;
  const seedItem = items.get('seed');
  if (seedItem && !seedItem.locked) {
    const seed = node('input');
    seed.type = 'number';
    seed.value = String(seedItem.value);
    seed.min = String(seedItem.min ?? 0);
    if (seedItem.max !== undefined) seed.max = String(seedItem.max);
    seed.step = '1';
    seed.setAttribute('aria-label', 'Graine');
    const roll = node('button', 'icon-button proposal-roll');
    roll.type = 'button';
    roll.title = 'Graine au hasard';
    roll.setAttribute('aria-label', 'Graine au hasard');
    roll.append(diceIcon(node));
    roll.onclick = () => {
      const max = Math.min(seedItem.max ?? 2 ** 32, Number.MAX_SAFE_INTEGER);
      seed.value = String(Math.floor(Math.random() * (max + 1)));
      seed.dispatchEvent?.(new Event('input'));
    };
    const row = node('div', 'proposal-seed');
    row.append(seed, roll);
    controls.set('seed', seed);
    seedField = field('Graine', row);
  } else if (numeric(parameters.seed)) seedField = field('Graine', fixed(String(parameters.seed)));
  if (seedField) grid.append(seedField);

  // Everything else the user may change.
  const advanced = node('details', 'proposal-advanced');
  advanced.append(node('summary', '', 'Paramètres avancés'));
  const more = node('div', 'proposal-grid');
  advanced.append(more);
  // In a card the version and the seed are advanced settings (« Paramètres avancés »).
  if (card) for (const moved of [versionField, seedField, ...roleFields]) if (moved) more.append(moved);
  const subjectFields = [];
  const keys = [
    ...ADVANCED_FIRST.filter(key => items.has(key)),
    ...[...items.keys()].filter(key => !ADVANCED_FIRST.includes(key)),
  ];
  for (const key of keys) {
    const item = items.get(key);
    if (MAIN.has(key) && !['frames', 'width', 'height'].includes(key)) continue;
    if (shown.has(key)) continue;
    // The length is chosen in seconds above; a count of frames would only repeat it.
    if (key === 'frames' && duration) continue;
    // In a card the size is the format and the resolution: its two numbers would repeat them.
    if (card && resizable && (key === 'width' || key === 'height')) continue;
    const label = key === 'frames' ? 'Durée (images)' : LABELS[key] || key;
    if (item.locked) {
      const wrapper = field(label, fixed(String(item.value)), { help: item.locked });
      more.append(wrapper);
      if (subjectSetting(key)) subjectFields.push(wrapper);
      continue;
    }
    const input = control(item);
    controls.set(key, input);
    const wrapper = field(label, input, { help: item.note || HELP[key] });
    more.append(wrapper);
    if (subjectSetting(key)) subjectFields.push(wrapper);
  }
  // In a card, the cadence and the steps of the workflow, read only (direction-artistique.md).
  if (card) {
    if (!items.has('fps') && numeric(parameters.fps)) more.append(field('Cadence', fixed(parameters.fps + ' i/s')));
    if (!items.has('steps') && numeric(parameters.steps)) more.append(field('Étapes', fixed(String(parameters.steps))));
  }
  // Subject-reference settings show only while an input is a subject reference.
  const showSubject = () => {
    const subject = roleControls.length
      ? roleControls.some(({ control }) => control.value === SUBJECT_ROLE) ||
        plan.references.some(
          (ref, index) => ref.role === SUBJECT_ROLE && !roleControls.some(item => item.index === index),
        )
      : plan.references?.some(ref => ref.role === SUBJECT_ROLE);
    for (const wrapper of subjectFields) wrapper.hidden = !subject;
    advanced.hidden = ![...more.children].some(child => !child.hidden);
  };
  for (const { control } of roleControls)
    control.onchange = () => {
      showSubject();
      showMedia();
    };
  if (more.children.length && !card) container.append(advanced);
  showSubject();

  // The two length controls and the two size controls follow each other.
  const framesControl = controls.get('frames');
  if (duration && framesControl) {
    duration.onchange = () => {
      framesControl.value = duration.value;
    };
    framesControl.onchange = () => {
      duration.value = framesControl.value;
    };
  }
  if (controls.get('fps') && duration)
    controls.get('fps').onchange = controls.get('fps').oninput = () => {
      for (const option of duration.options || []) option.text = lengthText(Number(option.value));
    };
  if (resizable) {
    showSize();
    for (const key of ['width', 'height'])
      if (controls.get(key))
        controls.get(key).onchange = () => {
          const width = Number(controls.get('width').value),
            height = Number(controls.get('height').value);
          if (Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0) {
            size = { width, height };
            showSize();
          }
        };
  }

  /**
   * The inputs of a card as pictures (captures 11 and 12): the video followed, DÉBUT and FIN in the
   * shape of the format, a rule, then the references (RÉF. 1…); « + » where the workflow takes one
   * more, to join an image to the next message (Moodix then proposes again with it).
   */
  function showMedia() {
    if (!media) return;
    const roleOf = index => roleControls.find(item => item.index === index)?.control.value ?? plan.references[index].role,
      placed = (plan.references || []).map((ref, index) => ({ ref, role: roleOf(index) })),
      slots = request.inputRoles || [],
      ratio = numeric(size.width) && numeric(size.height) && size.height > 0 ? size.width / size.height : 16 / 9;
    const tile = (ref, label, { shape = ratio, add = '' } = {}) => {
      const box = node('figure', 'proposal-input' + (ref ? '' : ' is-empty') + (shape ? '' : ' is-reference')),
        frame = node(ref ? 'span' : 'button', 'proposal-input-frame');
      if (shape) box.style?.setProperty('--ratio', shape.toFixed(3));
      if (ref?.preview) {
        const picture = node('img');
        picture.src = ref.preview;
        picture.alt = ref.label || label;
        picture.decoding = 'async';
        // Gone (a file removed since): its name instead.
        picture.onerror = () => picture.replaceWith(node('span', 'proposal-input-file', ref.label || label));
        frame.append(picture);
      } else if (ref) frame.append(node('span', 'proposal-input-file', ref.label || label));
      else {
        frame.type = 'button';
        frame.textContent = '+';
        frame.setAttribute('aria-label', add);
        frame.title = add + '\nElle part avec votre prochain message : Moodix refait sa proposition avec elle.';
        frame.disabled = !onAdd;
        frame.onclick = () => onAdd?.();
      }
      box.append(frame, node('figcaption', '', label));
      return box;
    };
    const frames = [];
    for (const { ref } of placed.filter(item => SOURCES.has(item.role))) frames.push(tile(ref, 'SOURCE'));
    for (const [role, label] of Object.entries(PLACES)) {
      const found = placed.find(item => item.role === role);
      if (found) frames.push(tile(found.ref, label));
      else if (slots.includes(role))
        frames.push(tile(null, label, { add: role === 'end_image' ? 'Joindre une image de fin' : 'Joindre une image de début' }));
    }
    const references = placed.filter(item => !SOURCES.has(item.role) && !PLACES[item.role]),
      room = Math.min(3, slots.filter(role => !SOURCES.has(role) && !PLACES[role]).length);
    const refs = references.map(({ ref }, index) => tile(ref, 'RÉF. ' + (index + 1), { shape: 0 }));
    if (references.length < room) refs.push(tile(null, '', { shape: 0, add: 'Joindre une image de référence' }));
    media.replaceChildren(...frames, ...(frames.length && refs.length ? [node('span', 'proposal-media-rule')] : []), ...refs);
    media.hidden = !frames.length && !refs.length;
  }
  showMedia();
  // A value changed in a card turns to the accent; Moodix's again, it goes back.
  if (card)
    for (const control of [...controls.values(), prompt].filter(Boolean)) {
      const read = () => (control.type === 'checkbox' ? control.checked : control.value),
        initial = read(),
        mark = () => control.classList?.toggle('is-changed', read() !== initial);
      control.addEventListener?.('input', mark);
      control.addEventListener?.('change', mark);
    }

  const notes = [...(request.notes || [])];
  if (plan.edited?.length)
    notes.push('Modifié par vous : ' + plan.edited.map(key => LABELS[key] || key).join(', ') + '.');
  for (const note of notes) container.append(node('p', 'field-help proposal-note', note));
  container.append(message);

  // A card places its two folds at its foot, beside Annuler and Générer.
  const folds = [];
  if (card) {
    if (more.children.length && !advanced.hidden) folds.push({ name: 'Paramètres avancés', panel: more });
    if (promptField) {
      const panel = node('div', 'proposal-prompt-panel');
      panel.append(promptField);
      if (prompt) {
        const back = node('button', 'proposal-back', 'Revenir au prompt de Moodix');
        back.type = 'button';
        back.hidden = true;
        back.onclick = () => {
          prompt.value = plan.prompt || '';
          back.hidden = true;
        };
        prompt.addEventListener?.('input', () => (back.hidden = prompt.value === (plan.prompt || '')));
        panel.append(back);
      }
      folds.push({ name: 'Prompt', panel });
    }
  }
  const form = {
    folds,
    edits() {
      const edits = {};
      if (prompt && prompt.value !== (plan.prompt || '')) {
        if (!prompt.value.trim()) throw Error('Le prompt ne peut pas être vide.');
        edits.prompt = prompt.value;
      }
      const roles = roleControls
        .filter(({ control, initial }) => control.value !== initial)
        .map(({ index, control }) => ({ index, role: control.value }));
      if (roles.length) edits.references = roles;
      // The main controls carry the same values as their advanced twins: read those last.
      const values = new Map();
      if (duration) values.set('frames', duration.value);
      if (resizable) {
        values.set('width', String(size.width));
        values.set('height', String(size.height));
      }
      for (const [key, control] of controls) {
        if (key === 'stage') continue;
        const item = items.get(key);
        if (!item) continue;
        if (item.type === 'boolean') values.set(key, control.checked);
        else if (!(values.has(key) && ['frames', 'width', 'height'].includes(key))) values.set(key, control.value);
      }
      for (const [key, raw] of values) {
        const item = items.get(key),
          label = LABELS[key] || key;
        let value;
        if (item.type === 'boolean') value = raw;
        else if (item.type === 'string') {
          value = String(raw);
          if (item.maxLength !== undefined && value.length > item.maxLength)
            throw Error(`${label} : ${item.maxLength} caractères au plus.`);
        } else if (item.choices) value = item.choices.find(choice => String(choice) === String(raw));
        else {
          const text = String(raw).trim();
          value = Number(text);
          if (!text || !Number.isFinite(value) || (item.type === 'integer' && !Number.isSafeInteger(value)))
            throw Error(`${label} : nombre invalide.`);
          if ((item.min !== undefined && value < item.min) || (item.max !== undefined && value > item.max))
            throw Error(`${label} : entre ${item.min ?? '…'} et ${item.max ?? '…'}.`);
          if (item.multipleOf && value % item.multipleOf) throw Error(`${label} : multiple de ${item.multipleOf}.`);
        }
        if (value !== undefined && value !== item.value) edits[key] = value;
      }
      return edits;
    },
    error(text) {
      message.textContent = text;
      message.hidden = !text;
    },
  };
  return form;
}

function diceIcon(node) {
  const make = tag =>
    globalThis.document?.createElementNS ? document.createElementNS('http://www.w3.org/2000/svg', tag) : node(tag);
  const svg = make('svg'),
    use = make('use');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'proposal-dice');
  use.setAttribute('href', '#i-dice');
  svg.append(use);
  return svg;
}
