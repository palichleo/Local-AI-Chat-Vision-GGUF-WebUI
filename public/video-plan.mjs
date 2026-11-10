import { formatOf, formatsFor, nearestSize, sizesFor } from './formats.mjs';

const LABELS = {
  width: 'Largeur',
  height: 'Hauteur',
  frames: 'Images',
  fps: 'Cadence (i/s)',
  steps: 'Étapes',
  seed: 'Seed',
  audio: 'Audio',
  overlap_frames: 'Chevauchement (images)',
  cfg: 'CFG',
  guidance: 'Guidance',
  denoise: 'Débruitage',
  start_strength: 'Force de l’image de début',
  end_strength: 'Force de l’image de fin',
  image_compression: 'Compression des images',
  msr_strength: 'Force des références',
  msr_frames: 'Images guidées par les références',
  max_side: 'Plus grand côté (px)',
  scale: 'Facteur',
  passes: 'Passes',
  color_correction: 'Correction des couleurs',
  multiplier: 'Multiplicateur',
  mode: 'Mode',
  tile: 'Tuile',
  expandPrompt: 'Prompt enrichi',
};
const STAGES = { draft: 'Brouillon', final: 'Finale' };
// Shown in the main area; every other editable parameter goes to « Paramètres avancés ».
const MAIN = new Set(['frames', 'width', 'height', 'seed']);
const ADVANCED_FIRST = ['frames', 'fps', 'audio', 'width', 'height'];
const numeric = value => typeof value === 'number' && Number.isFinite(value);
const seconds = value => value.toFixed(2).replace('.', ',') + ' s';

/**
 * A proposal as one form: everything the user may change is editable in place, the common
 * settings first and the rest under « Paramètres avancés ». `edits()` returns only what
 * changed (and throws a readable message for an invalid value); `error(text)` shows a refusal.
 * `onStage(stage, edits)` is called when the version changes: its profile changes the size and
 * length, so the caller asks the server for the new proposal and renders it again.
 */
export function renderProposal(container, request, { node, onStage } = {}) {
  container.replaceChildren();
  const plan = request.plan || {},
    editable = plan.editable || {},
    parameters = plan.parameters || {},
    video = request.mediaType === 'video',
    items = new Map((editable.parameters || []).map(item => [item.key, item])),
    controls = new Map(),
    continues = plan.references?.some(ref => ref.role === 'source_video'),
    overlap = continues && numeric(parameters.overlap_frames) ? parameters.overlap_frames : 0;
  const message = node('p', 'video-edit-error');
  message.setAttribute('role', 'alert');
  message.hidden = true;

  function field(label, control, { help, wide = false } = {}) {
    const wrapper = node('label', 'proposal-field' + (wide ? ' is-wide' : ''));
    wrapper.append(node('span', '', label), control);
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

  container.append(node('p', 'video-intention', plan.intention || (video ? 'Proposition vidéo' : 'Génération d’image')));

  // Prompt: editable when the model owns it.
  let prompt = null;
  if (editable.prompt) {
    prompt = node('textarea', 'proposal-prompt');
    prompt.rows = 4;
    prompt.value = plan.prompt || '';
    prompt.setAttribute('aria-label', 'Prompt');
    container.append(field('Prompt', prompt, { wide: true }));
  } else if (plan.prompt) container.append(field('Prompt (fixé par le workflow)', fixed(plan.prompt), { wide: true }));

  // Inputs, each with the role it plays (and the others it may play).
  const roleControls = [];
  if (plan.references?.length) {
    const list = node('div', 'proposal-inputs');
    plan.references.forEach((ref, index) => {
      const label = ref.label || ref.resource_id || 'Image ' + ((ref.image ?? index) + 1),
        options = editable.references?.[index] || [];
      const row = node('div', 'proposal-input');
      row.append(node('span', 'proposal-input-name', label));
      if (options.length > 1) {
        const control = select(
          options.map(option => [option.role, option.label]),
          ref.role,
        );
        control.setAttribute('aria-label', 'Rôle de ' + label);
        roleControls.push({ index, control, initial: ref.role });
        row.append(control);
      } else row.append(node('span', 'proposal-input-role', ref.roleLabel || ref.role || ref.input));
      list.append(row);
    });
    container.append(list);
  } else if (video && !continues) container.append(node('p', 'field-help', 'Aucune image transmise : vidéo créée depuis le texte.'));

  const grid = node('div', 'proposal-grid');
  container.append(grid);

  // Version: changing it changes the profile, so the server proposes again.
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
    grid.append(field('Version', stage));
  } else if (STAGES[plan.stage]) grid.append(field('Version', fixed(STAGES[plan.stage])));

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
    grid.append(field(overlap ? 'Durée ajoutée' : 'Durée', duration));
  } else if (numeric(frames) && fps()) grid.append(field(overlap ? 'Durée ajoutée' : 'Durée', fixed(lengthText(frames))));

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
      resolutionControl.add(new Option(sizeText(item) + (!known && item === size && format ? ' (actuelle)' : ''), sizeKey(item)));
    resolutionControl.value = sizeKey(size);
    if (controls.get('width')) controls.get('width').value = String(size.width);
    if (controls.get('height')) controls.get('height').value = String(size.height);
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
  } else if (numeric(size.width) && numeric(size.height))
    grid.append(
      field('Résolution', fixed(sizeText(size)), widthItem?.locked ? { help: 'Gardée de la vidéo source.' } : undefined),
    );

  // Seed, with a new random one at a click.
  const seedItem = items.get('seed');
  if (seedItem && !seedItem.locked) {
    const seed = node('input');
    seed.type = 'number';
    seed.value = String(seedItem.value);
    seed.min = String(seedItem.min ?? 0);
    if (seedItem.max !== undefined) seed.max = String(seedItem.max);
    seed.step = '1';
    seed.setAttribute('aria-label', 'Seed');
    const roll = node('button', 'icon-button proposal-roll');
    roll.type = 'button';
    roll.title = 'Seed aléatoire';
    roll.setAttribute('aria-label', 'Seed aléatoire');
    roll.append(diceIcon(node));
    roll.onclick = () => {
      const max = Math.min(seedItem.max ?? 2 ** 32, Number.MAX_SAFE_INTEGER);
      seed.value = String(Math.floor(Math.random() * (max + 1)));
    };
    const row = node('div', 'proposal-seed');
    row.append(seed, roll);
    controls.set('seed', seed);
    grid.append(field('Seed', row));
  } else if (numeric(parameters.seed)) grid.append(field('Seed', fixed(String(parameters.seed))));

  // Everything else the user may change.
  const advanced = node('details', 'proposal-advanced');
  advanced.append(node('summary', '', 'Paramètres avancés'));
  const more = node('div', 'proposal-grid');
  advanced.append(more);
  const keys = [
    ...ADVANCED_FIRST.filter(key => items.has(key)),
    ...[...items.keys()].filter(key => !ADVANCED_FIRST.includes(key)),
  ];
  for (const key of keys) {
    const item = items.get(key);
    if (MAIN.has(key) && !['frames', 'width', 'height'].includes(key)) continue;
    const label = LABELS[key] || key;
    if (item.locked) {
      more.append(field(label, fixed(String(item.value)), { help: item.locked }));
      continue;
    }
    let control;
    if (item.type === 'boolean') {
      control = node('input');
      control.type = 'checkbox';
      control.checked = item.value === true;
    } else if (item.choices) {
      control = select(
        item.choices.map(choice => [choice, String(choice)]),
        item.value,
      );
      control.disabled = item.choices.length < 2;
    } else {
      control = node('input');
      control.type = 'number';
      control.value = String(item.value);
      if (item.min !== undefined) control.min = String(item.min);
      if (item.max !== undefined) control.max = String(item.max);
      control.step = item.multipleOf ? String(item.multipleOf) : item.type === 'integer' ? '1' : 'any';
    }
    controls.set(key, control);
    more.append(field(label, control, { help: item.note }));
  }
  if (more.children.length) container.append(advanced);

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

  const notes = [...(request.notes || [])];
  if (plan.edited?.length) notes.push('Modifié par vous : ' + plan.edited.map(key => LABELS[key] || key).join(', ') + '.');
  for (const note of notes) container.append(node('p', 'field-help proposal-note', note));
  container.append(message);

  const form = {
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
        else if (item.choices) value = item.choices.find(choice => String(choice) === String(raw));
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
    globalThis.document?.createElementNS
      ? document.createElementNS('http://www.w3.org/2000/svg', tag)
      : node(tag);
  const svg = make('svg'),
    use = make('use');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'proposal-dice');
  use.setAttribute('href', '#i-dice');
  svg.append(use);
  return svg;
}
