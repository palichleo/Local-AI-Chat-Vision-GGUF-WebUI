export function renderVideoPlan(container, request, node) {
  container.replaceChildren();
  const plan = request.plan || {},
    parameters = plan.parameters || {};
  container.append(node('p', 'video-intention', plan.intention || 'Proposition vidéo'));
  const details = node('dl', 'video-plan-fields');
  function row(label, value) {
    if (value === undefined || value === null) return;
    details.append(node('dt', '', label), node('dd', '', String(value)));
  }
  const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const value = (key, suffix = '') =>
    parameters[key] === undefined
      ? undefined
      : numeric(parameters[key])
        ? parameters[key] + suffix
        : 'Calculé par le workflow';
  if (plan.edited?.length)
    container.append(
      node('p', 'field-help', 'Modifié par vous : ' + plan.edited.map(key => LABELS[key] || key).join(', ') + '.'),
    );
  row('Workflow', request.workflowName);
  row('Version', plan.stage === 'draft' ? 'Brouillon' : plan.stage === 'final' ? 'Finale' : undefined);
  if (parameters.width !== undefined || parameters.height !== undefined)
    row(
      'Résolution',
      numeric(parameters.width) && numeric(parameters.height)
        ? parameters.width + ' × ' + parameters.height
        : 'Calculée par le workflow',
    );
  row('Images', value('frames'));
  row('Cadence', value('fps', ' i/s'));
  if (numeric(parameters.frames) && parameters.frames > 0 && numeric(parameters.fps) && parameters.fps > 0)
    row('Durée estimée', (parameters.frames / parameters.fps).toFixed(2) + ' s');
  row('Seed', value('seed'));
  if (typeof parameters.audio === 'boolean') row('Audio', parameters.audio ? 'Oui' : 'Non');
  if (plan.references?.some(ref => ref.role === 'source_video'))
    row('Chevauchement', value('overlap_frames', ' images'));
  container.append(details);
  if (plan.references?.length) {
    const refs = node('ul', 'video-plan-references');
    for (const ref of plan.references)
      refs.append(
        node(
          'li',
          '',
          (ref.label || ref.resource_id || 'Image ' + (ref.image + 1)) +
            ' → ' +
            (ref.role || ref.input) +
            (Number.isFinite(ref.time) ? ' · ' + ref.time.toFixed(2) + ' s' : ''),
        ),
      );
    container.append(refs);
  } else container.append(node('p', 'field-help', 'Aucune référence image transmise au workflow.'));
  if (plan.defaultReferences?.length)
    container.append(
      node(
        'p',
        'field-help',
        'Entrées conservées du workflow : ' + plan.defaultReferences.map(ref => ref.name || ref.input).join(', '),
      ),
    );
  const prompt = node('details', 'video-plan-prompt');
  prompt.open = true;
  prompt.append(node('summary', '', 'Prompt'), node('p', '', plan.prompt || request.args?.prompt || ''));
  container.append(prompt);
  const other = node('details', 'video-plan-extra');
  other.append(node('summary', '', 'Paramètres effectifs'), node('pre', '', JSON.stringify(parameters, null, 2)));
  container.append(other);
}

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
};
const STAGES = { draft: 'Brouillon', final: 'Finale' };

/**
 * The proposal as a form the user edits directly: prompt, draft/final version and the
 * parameters the server lists as editable. `edits()` returns only what changed (and throws a
 * readable message for an invalid number); `error(text)` shows a server refusal in place.
 */
export function renderVideoEditor(container, request, node) {
  container.replaceChildren();
  const plan = request.plan || {},
    editable = plan.editable || {},
    parameters = plan.parameters || {},
    fields = [];
  const message = node('p', 'video-edit-error');
  message.setAttribute('role', 'alert');
  message.hidden = true;
  container.append(node('p', 'video-intention', plan.intention || 'Proposition vidéo'));
  function field(label, control, help) {
    const wrapper = node('label', 'video-edit-field');
    wrapper.append(node('span', '', label), control);
    if (help) wrapper.append(node('small', 'field-help', help));
    return wrapper;
  }
  let prompt = null;
  if (editable.prompt) {
    prompt = node('textarea', 'video-edit-prompt');
    prompt.rows = 5;
    prompt.value = plan.prompt || '';
    container.append(field('Prompt', prompt));
  } else {
    const fixed = node('details', 'video-plan-prompt');
    fixed.open = true;
    fixed.append(node('summary', '', 'Prompt (fixé par le workflow)'), node('p', '', plan.prompt || ''));
    container.append(fixed);
  }
  const grid = node('div', 'video-edit-grid');
  let stage = null;
  if (editable.stages?.length > 1) {
    stage = node('select');
    for (const value of editable.stages) stage.add(new Option(STAGES[value] || value, value));
    stage.value = plan.stage;
    grid.append(field('Version', stage, 'Change la taille et la durée du profil, sauf valeurs modifiées ici.'));
  }
  const fps = Number(parameters.fps);
  for (const item of editable.parameters || []) {
    const label = LABELS[item.key] || item.key;
    if (item.locked) {
      grid.append(field(label, node('output', 'video-edit-locked', String(item.value)), item.locked));
      continue;
    }
    let control;
    if (item.type === 'boolean') {
      control = node('input');
      control.type = 'checkbox';
      control.checked = item.value === true;
    } else if (item.choices) {
      control = node('select');
      for (const choice of item.choices) {
        const text = item.key === 'frames' && fps > 0 ? `${choice} · ${(choice / fps).toFixed(2)} s` : String(choice);
        control.add(new Option(text, String(choice)));
      }
      control.value = String(item.value);
      control.disabled = item.choices.length < 2;
    } else {
      control = node('input');
      control.type = 'number';
      control.value = String(item.value);
      if (item.min !== undefined) control.min = String(item.min);
      if (item.max !== undefined) control.max = String(item.max);
      control.step = item.multipleOf ? String(item.multipleOf) : item.type === 'integer' ? '1' : 'any';
    }
    const wrapper = field(label, control, item.note);
    if (item.key === 'seed' && control.type === 'number') {
      const roll = node('button', 'secondary video-edit-roll', 'Aléatoire');
      roll.type = 'button';
      roll.onclick = () => {
        control.value = String(Math.floor(Math.random() * Math.min(item.max ?? 2 ** 32, Number.MAX_SAFE_INTEGER)));
      };
      wrapper.append(roll);
    }
    grid.append(wrapper);
    fields.push({ item, label, control });
  }
  container.append(grid, message);
  if (plan.references?.length)
    container.append(
      node(
        'p',
        'field-help',
        'Entrées : ' + plan.references.map(ref => ref.label || ref.role || ref.input).join(', ') + ' (inchangées).',
      ),
    );
  return {
    edits() {
      const edits = {};
      if (prompt && prompt.value !== (plan.prompt || '')) {
        if (!prompt.value.trim()) throw Error('Le prompt ne peut pas être vide.');
        edits.prompt = prompt.value;
      }
      if (stage && stage.value !== plan.stage) edits.stage = stage.value;
      for (const { item, label, control } of fields) {
        let value;
        if (item.type === 'boolean') value = control.checked;
        else if (item.choices) value = item.choices.find(choice => String(choice) === control.value);
        else {
          const text = String(control.value).trim();
          value = Number(text);
          if (!text || !Number.isFinite(value) || (item.type === 'integer' && !Number.isSafeInteger(value)))
            throw Error(`${label} : nombre invalide.`);
          if ((item.min !== undefined && value < item.min) || (item.max !== undefined && value > item.max))
            throw Error(`${label} : entre ${item.min ?? '…'} et ${item.max ?? '…'}.`);
          if (item.multipleOf && value % item.multipleOf) throw Error(`${label} : multiple de ${item.multipleOf}.`);
        }
        if (value !== item.value) edits[item.key] = value;
      }
      return edits;
    },
    error(text) {
      message.textContent = text;
      message.hidden = !text;
    },
  };
}
