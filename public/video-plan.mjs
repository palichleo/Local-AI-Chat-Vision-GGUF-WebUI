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
  } else container.append(node('p', 'comfy-help', 'Aucune référence image transmise au workflow.'));
  if (plan.defaultReferences?.length)
    container.append(
      node(
        'p',
        'comfy-help',
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
