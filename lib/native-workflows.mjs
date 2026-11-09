import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { families, family } from './families.mjs';
import { encoderVocabulary, tokenizerMismatch } from './generation-assets.mjs';

const invalid = message => Object.assign(new Error(message), { status: 400 });
const plain = value =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [null, Object.prototype].includes(Object.getPrototypeOf(value));
const owns = (value, key) => Object.hasOwn(value, key);
const MAX_BYTES = 2 * 1024 * 1024;
function identifier(value, label = 'id') {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value) ||
    /^(con|prn|aux|nul|com\d|lpt\d|constructor|prototype)$/i.test(value)
  )
    throw invalid(`Invalid ${label}`);
  return value;
}
function keys(value, allowed, label) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key)))
    throw invalid(`Unsupported or invalid ${label}`);
}
function text(value, max, label, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    throw invalid(`${label} must be ${required ? 'nonempty ' : ''}text of at most ${max} characters`);
}
export function jsonValue(value, depth = 0, ancestors = new Set()) {
  if (depth > 32) throw invalid('Workflow JSON is too deeply nested');
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return;
  if ((!Array.isArray(value) && !plain(value)) || ancestors.has(value))
    throw invalid('Workflow must contain only acyclic JSON values');
  ancestors.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw invalid('Unsafe workflow JSON key');
    jsonValue(child, depth + 1, ancestors);
  }
  ancestors.delete(value);
}
function canonical(value) {
  return Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : plain(value)
      ? `{${Object.keys(value)
          .sort()
          .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(',')}}`
      : JSON.stringify(value);
}
function valueMatches(value, spec, label) {
  if (spec.type === 'string') text(value, spec.maxLength ?? 8000, label, spec.nonempty);
  else if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') throw invalid(`${label} must be boolean`);
  } else if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (spec.type === 'integer' && !Number.isSafeInteger(value))
  )
    throw invalid(`${label} must be a finite ${spec.type}`);
  if (
    (spec.min !== undefined && (value < spec.min || (spec.exclusiveMin && value === spec.min))) ||
    (spec.max !== undefined && value > spec.max)
  )
    throw invalid(`${label} is outside the supported range`);
  if (spec.multipleOf && value % spec.multipleOf) throw invalid(`${label} must be a multiple of ${spec.multipleOf}`);
  if (spec.choices && !spec.choices.includes(value)) throw invalid(`${label} must be one of the allowed choices`);
}
function effective(policy, spec) {
  return {
    ...spec,
    min: policy.min ?? spec.min,
    max: policy.max ?? spec.max,
    maxLength: policy.maxLength ?? spec.maxLength,
    choices: policy.choices ?? spec.choices,
  };
}
function validatePolicy(policy, spec, label, { random = false, off = false } = {}) {
  if (!plain(policy)) throw invalid(`Invalid ${label} policy`);
  if (policy.policy === 'off' && off) {
    keys(policy, ['policy'], `${label} off policy`);
    return;
  }
  if (policy.policy === 'fixed') {
    keys(policy, ['policy', 'value', 'description', 'type'], `${label} fixed policy`);
    if (policy.type !== undefined && policy.type !== spec.type) throw invalid(`Invalid ${label} type`);
    valueMatches(policy.value, spec, label);
  } else if (policy.policy === 'random' && random) {
    keys(policy, ['policy', 'type', 'description'], `${label} random policy`);
    if (policy.type !== undefined && policy.type !== 'integer') throw invalid('Random seed type must be integer');
  } else if (policy.policy === 'model') {
    keys(
      policy,
      ['policy', 'type', 'default', 'min', 'max', 'maxLength', 'choices', 'description'],
      `${label} model policy`,
    );
    if (policy.type !== undefined && policy.type !== spec.type) throw invalid(`Invalid ${label} type`);
    for (const bound of ['min', 'max'])
      if (
        policy[bound] !== undefined &&
        (typeof policy[bound] !== 'number' ||
          !Number.isFinite(policy[bound]) ||
          !['number', 'integer'].includes(spec.type) ||
          (spec[bound] !== undefined && (bound === 'min' ? policy[bound] < spec[bound] : policy[bound] > spec[bound])))
      )
        throw invalid(`Invalid ${label} ${bound} range`);
    if (policy.min !== undefined && policy.max !== undefined && policy.min > policy.max)
      throw invalid(`Invalid ${label} range`);
    if (
      policy.maxLength !== undefined &&
      (spec.type !== 'string' ||
        !Number.isInteger(policy.maxLength) ||
        policy.maxLength < 1 ||
        policy.maxLength > spec.maxLength)
    )
      throw invalid(`Invalid ${label} maxLength`);
    if (policy.choices !== undefined) {
      if (
        !Array.isArray(policy.choices) ||
        !policy.choices.length ||
        policy.choices.length > 256 ||
        new Set(policy.choices).size !== policy.choices.length
      )
        throw invalid(`Invalid ${label} choices`);
      for (const value of policy.choices) valueMatches(value, spec, label);
    }
    const selected = effective(policy, spec);
    if (selected.min !== undefined && selected.max !== undefined && selected.min > selected.max)
      throw invalid(`Invalid ${label} range`);
    if (policy.choices) for (const value of policy.choices) valueMatches(value, selected, label);
    if (owns(policy, 'default')) valueMatches(policy.default, selected, label);
  } else throw invalid(`Unsupported ${label} policy`);
  if (policy.description !== undefined) text(policy.description, 1000, `${label} description`);
}
function componentPolicy(policy, label) {
  if (policy?.policy === 'fixed') {
    keys(policy, ['policy', 'asset'], `${label} component policy`);
    identifier(policy.asset, 'asset id');
  } else if (policy?.policy === 'model') {
    keys(policy, ['policy', 'choices', 'default', 'description'], `${label} component policy`);
    if (
      !Array.isArray(policy.choices) ||
      !policy.choices.length ||
      policy.choices.length > 128 ||
      new Set(policy.choices).size !== policy.choices.length
    )
      throw invalid(`Select compatible ${label} asset choices`);
    policy.choices.forEach(id => identifier(id, 'asset id'));
    if (policy.default !== undefined && !policy.choices.includes(policy.default))
      throw invalid(`Invalid ${label} default asset`);
    if (policy.description !== undefined) text(policy.description, 1000, `${label} description`);
  } else throw invalid(`Unsupported ${label} component policy`);
}
function promptTemplate(value, label) {
  text(value, 16000, label, true);
  if (value.split('{{prompt}}').length !== 2) throw invalid(`${label} must contain exactly one {{prompt}} placeholder`);
}
function expansionConfig(value) {
  const fields = [
    'template',
    'maxTokens',
    'temperature',
    'topK',
    'topP',
    'minP',
    'repetitionPenalty',
    'seed',
    'suffix',
  ];
  keys(value, fields, 'prompt expansion');
  if (fields.some(key => !owns(value, key))) throw invalid('Prompt expansion requires every sampling setting');
  promptTemplate(value.template, 'Prompt expansion template');
  text(value.suffix, 8000, 'Prompt expansion suffix');
  const specs = {
    maxTokens: { type: 'integer', min: 1, max: 4096 },
    temperature: { type: 'number', min: 0, max: 5, exclusiveMin: true },
    topK: { type: 'integer', min: 0, max: 1000 },
    topP: { type: 'number', min: 0, max: 1, exclusiveMin: true },
    minP: { type: 'number', min: 0, max: 1 },
    repetitionPenalty: { type: 'number', min: 0, max: 10, exclusiveMin: true },
    seed: { type: 'integer', min: 0, max: Number.MAX_SAFE_INTEGER },
  };
  for (const [name, spec] of Object.entries(specs)) valueMatches(value[name], spec, `Prompt expansion ${name}`);
}

export function validateNativeWorkflow(input) {
  jsonValue(input);
  if (!plain(input)) throw invalid('Invalid workflow');
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_BYTES) throw invalid('Workflow exceeds the 2 MiB size limit');
  if (owns(input, 'importDraft')) {
    const meta = input.importDraft;
    keys(meta, ['source', 'format', 'files', 'extras', 'warnings', 'blockers'], 'import draft');
    if (
      !plain(meta.source) ||
      !['atelier', 'comfy-api', 'comfy-editor'].includes(meta.format) ||
      !plain(meta.files) ||
      !Array.isArray(meta.extras) ||
      meta.extras.length > 4096
    )
      throw invalid('Invalid workflow import draft');
    for (const list of [meta.warnings, meta.blockers])
      if (
        !Array.isArray(list) ||
        list.length > 256 ||
        list.some(value => typeof value !== 'string' || value.length > 4000)
      )
        throw invalid('Invalid import warnings');
    for (const [key, value] of Object.entries(meta.files)) {
      identifier(key, 'import file');
      text(value, 4096, 'Imported filename');
    }
    for (const entry of meta.extras) {
      keys(entry, ['id', 'label', 'value'], 'imported setting');
      identifier(entry.id);
      text(entry.label, 300, 'Imported setting label', true);
      if (!owns(entry, 'value')) throw invalid('Missing imported setting value');
    }
    if (input.enabled) {
      if (meta.blockers.length)
        throw invalid('Ce brouillon ne peut pas encore être exécuté : ' + meta.blockers.join(' '));
      const { importDraft, ...workflow } = input;
      return validateNativeWorkflow(workflow);
    }
    identifier(input.id, 'workflow id');
    text(input.name, 120, 'Workflow name', true);
    text(input.description, 2000, 'Workflow description');
    if (
      input.schemaVersion !== 1 ||
      input.enabled !== false ||
      (input.pipeline !== '' && !owns(families(), input.pipeline)) ||
      !plain(input.components) ||
      !plain(input.parameters) ||
      !Array.isArray(input.loras) ||
      input.loras.length > 256 ||
      !Array.isArray(input.references) ||
      input.references.length > 256
    )
      throw invalid('Invalid imported workflow fields');
    for (const policy of Object.values(input.components)) componentPolicy(policy, 'imported component');
    for (const policy of Object.values(input.parameters)) {
      if (!plain(policy) || !['fixed', 'model', 'random'].includes(policy.policy))
        throw invalid('Invalid imported parameter');
      if (policy.policy === 'fixed' && !['string', 'number', 'boolean'].includes(typeof policy.value))
        throw invalid('Invalid imported parameter value');
    }
    for (const lora of input.loras) {
      identifier(lora.id);
      identifier(lora.asset);
      text(lora.description ?? '', 1000, 'LoRA description');
      validatePolicy(lora.enabled, { type: 'boolean' }, 'imported LoRA activation', { off: true });
      validatePolicy(lora.strength, { type: 'number' }, 'imported LoRA strength');
    }
    for (const reference of input.references) {
      identifier(reference.id);
      text(reference.role, 120, 'Reference role');
      if (reference.name !== undefined) text(reference.name, 120, 'Reference name');
    }
    const { digest, ready, unavailableReason, ...stored } = input;
    return { ...structuredClone(stored), digest: createHash('sha256').update(canonical(stored)).digest('hex') };
  }
  keys(
    input,
    [
      'schemaVersion',
      'id',
      'name',
      'description',
      'enabled',
      'pipeline',
      'mediaType',
      'components',
      'parameters',
      'loras',
      'references',
      'profiles',
      'promptTemplate',
      'promptExpansion',
      'digest',
      'ready',
      'unavailableReason',
    ],
    'workflow fields',
  );
  if (input.schemaVersion !== 1) throw invalid('Unsupported native workflow schemaVersion');
  identifier(input.id, 'workflow id');
  text(input.name, 120, 'Workflow name', true);
  text(input.description, 2000, 'Workflow description');
  if (typeof input.enabled !== 'boolean') throw invalid('Workflow enabled must be boolean');
  const pipeline = family(input.pipeline);
  if (pipeline.mediaType !== input.mediaType) throw invalid('Unsupported pipeline or mediaType');
  const features = pipeline.features ?? [];
  keys(input.components, Object.keys(pipeline.components), 'component roles');
  // A missing required component (a tokenizer added to a family later, say) keeps the workflow
  // readable and editable; saving, readiness and execution require it (see missingComponent).
  for (const [role, policy] of Object.entries(input.components)) {
    componentPolicy(policy, role);
    const allowed = pipeline.components[role].policies;
    if (allowed && !allowed.includes(policy.policy))
      throw invalid(`${pipeline.components[role].label || role} must be ${allowed.join(' or ')}`);
  }
  keys(input.parameters, Object.keys(pipeline.parameters), 'parameters');
  for (const required of pipeline.requiredParameters ?? [])
    if (!owns(input.parameters, required)) throw invalid(`Missing required parameter ${required}`);
  for (const [name, policy] of Object.entries(input.parameters))
    validatePolicy(policy, pipeline.parameters[name], name, { random: name === 'seed' });
  if (input.promptTemplate !== undefined) {
    if (!features.includes('promptTemplate')) throw invalid(`${pipeline.label} does not support prompt templates`);
    promptTemplate(input.promptTemplate, 'Prompt template');
  }
  if (input.promptExpansion !== undefined) {
    if (!features.includes('promptExpansion')) throw invalid(`${pipeline.label} does not support prompt expansion`);
    expansionConfig(input.promptExpansion);
  }
  const expansion = input.parameters.expandPrompt;
  if (expansion && (expansion.policy === 'model' || expansion.value === true) && input.promptExpansion === undefined)
    throw invalid('Enabled prompt expansion requires explicit template and sampling settings');
  const loraLimits = pipeline.loras ?? { max: 0 };
  if (!Array.isArray(input.loras) || input.loras.length > loraLimits.max)
    throw invalid(`Too many LoRAs for ${pipeline.label}`);
  const loraIds = new Set();
  for (const lora of input.loras) {
    keys(lora, ['id', 'asset', 'description', 'enabled', 'strength'], 'LoRA');
    identifier(lora.id, 'LoRA id');
    identifier(lora.asset, 'LoRA asset');
    text(lora.description, 1000, 'LoRA description');
    if (loraIds.has(lora.id)) throw invalid('Duplicate LoRA id');
    loraIds.add(lora.id);
    validatePolicy(lora.enabled, { type: 'boolean' }, `LoRA ${lora.id} enabled`, { off: true });
    validatePolicy(lora.strength, loraLimits.strength, `LoRA ${lora.id} strength`);
  }
  if (!Array.isArray(input.references) || input.references.length > 64)
    throw invalid('References must be an array of at most 64 entries');
  const referenceIds = new Set();
  for (const reference of input.references) {
    keys(reference, ['id', 'role', 'required', 'name', 'description'], 'reference slot');
    identifier(reference.id, 'reference id');
    if (
      referenceIds.has(reference.id) ||
      !owns(pipeline.roles, reference.role) ||
      typeof reference.required !== 'boolean'
    )
      throw invalid('Invalid or duplicate reference slot/role');
    referenceIds.add(reference.id);
    if (reference.name !== undefined) text(reference.name, 120, 'Reference name', true);
    if (reference.description !== undefined) text(reference.description, 1000, 'Reference description');
  }
  for (const [role, spec] of Object.entries(pipeline.roles))
    if (input.references.filter(slot => slot.role === role).length > (spec.max ?? 1))
      throw invalid(`${pipeline.label} accepts at most ${spec.max ?? 1} ${spec.label} slot(s)`);
  if (input.profiles !== undefined) {
    if (!pipeline.profiles) throw invalid(`${pipeline.label} does not support draft/final profiles`);
    keys(input.profiles, ['draft', 'final'], 'video profiles');
    for (const [stage, profile] of Object.entries(input.profiles)) {
      keys(profile, ['parameters'], `${stage} profile`);
      keys(profile.parameters, pipeline.profiles, `${stage} profile parameters`);
      for (const [name, value] of Object.entries(profile.parameters)) {
        if (!owns(input.parameters, name)) throw invalid(`Profile parameter ${name} must be declared`);
        valueMatches(value, pipeline.parameters[name], `${stage} ${name}`);
      }
    }
  }
  const { digest, ready, unavailableReason, ...stored } = input;
  const workflow = JSON.parse(JSON.stringify(stored));
  workflow.name = workflow.name.trim();
  return { ...workflow, digest: createHash('sha256').update(canonical(workflow)).digest('hex') };
}

export function nativeWorkflowImageInputs(workflow) {
  return (workflow.references ?? []).map(slot => ({
    ...slot,
    name: slot.name ?? slot.id,
    description: slot.description ?? '',
  }));
}
export function nativeWorkflowReferences(workflow, args) {
  if (!plain(args)) throw invalid('Workflow arguments must be an object');
  const references = args.references ?? [];
  if (!Array.isArray(references) || references.length > 64)
    throw invalid('References must be an array of at most 64 assignments');
  const slots = workflow.references ?? [],
    seen = new Set();
  for (const reference of references) {
    keys(reference, ['input', 'image', 'resource_id', 'frame', 'output_id', 'output_index'], 'reference source');
    if (!slots.some(slot => slot.id === reference.input) || seen.has(reference.input))
      throw invalid('Select distinct declared reference inputs');
    seen.add(reference.input);
    if (['image', 'resource_id', 'output_id'].filter(key => owns(reference, key)).length !== 1)
      throw invalid('Each reference requires exactly one image, resource_id or output_id source');
    const slot = slots.find(slot => slot.id === reference.input);
    const video = family(workflow.pipeline).roles[slot.role]?.media === 'video';
    if (owns(reference, 'output_id')) {
      if (
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(reference.output_id) ||
        owns(reference, 'frame') ||
        (reference.output_index !== undefined &&
          (!Number.isInteger(reference.output_index) || reference.output_index < 0 || reference.output_index > 255))
      )
        throw invalid('Invalid output video reference');
      continue;
    }
    if (owns(reference, 'output_index') || (video && (owns(reference, 'image') || owns(reference, 'frame'))))
      throw invalid('A video slot requires an original video resource or output');
    if (owns(reference, 'image')) {
      if (
        !Number.isInteger(reference.image) ||
        reference.image < 0 ||
        reference.image > 6399 ||
        owns(reference, 'frame')
      )
        throw invalid('Invalid reference image index');
    } else if (
      typeof reference.resource_id !== 'string' ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(reference.resource_id) ||
      (owns(reference, 'frame') && (!Number.isInteger(reference.frame) || reference.frame < 0 || reference.frame > 2))
    )
      throw invalid('Invalid resource reference or frame');
  }
  for (const slot of slots)
    if (slot.required && !seen.has(slot.id)) throw invalid(`A reference is required for ${slot.name ?? slot.id}`);
  return structuredClone(references);
}
function resolvePolicy(policy, spec, args, key, { seed } = {}) {
  const provided = owns(args, key);
  if (policy.policy !== 'model' && provided)
    throw invalid(`${key} is ${policy.policy}; a locked parameter cannot be overridden`);
  if (policy.policy === 'off') return false;
  if (policy.policy === 'fixed') return policy.value;
  if (policy.policy === 'random') {
    const result = seed ?? Number(randomBytes(8).readBigUInt64LE() & BigInt(Number.MAX_SAFE_INTEGER));
    valueMatches(result, spec, key);
    return result;
  }
  const value = provided ? args[key] : policy.default;
  if (value === undefined) throw invalid(`${key} is required`);
  valueMatches(value, effective(policy, spec), key);
  return value;
}
async function resolvedAsset(assets, id, kind, family) {
  if (!assets || typeof assets.resolve !== 'function') throw invalid('Local asset registry is unavailable');
  const asset = await assets.resolve(id, { kind, family });
  if (!asset || typeof asset.path !== 'string' || !isAbsolute(asset.path))
    throw invalid(`Asset ${id} must resolve to an absolute local path`);
  return asset.path;
}
/** The first required component a workflow does not select yet, as an error to show, or ''. */
export function missingComponent(workflow) {
  for (const [role, spec] of Object.entries(family(workflow.pipeline).components))
    if (spec.required && !owns(workflow.components, role))
      return `Choisissez ${spec.label ? 'le composant « ' + spec.label + ' »' : role} dans ce workflow.`;
  return '';
}
const assetIds = policy => (policy.policy === 'fixed' ? [policy.asset] : policy.choices);
async function checkAssets(workflow, assets) {
  const missing = missingComponent(workflow);
  if (missing) throw invalid(missing);
  for (const [role, policy] of Object.entries(workflow.components))
    for (const id of assetIds(policy)) await resolvedAsset(assets, id, role, workflow.pipeline);
  for (const lora of workflow.loras) await resolvedAsset(assets, lora.asset, 'lora', workflow.pipeline);
  // A tokenizer from another model family does not fail: it silently feeds the wrong tokens.
  for (const [role, spec] of Object.entries(family(workflow.pipeline).components)) {
    const encoder = spec.vocabularyOf && workflow.components[spec.vocabularyOf];
    if (!encoder || !workflow.components[role]) continue;
    for (const tokenizerId of assetIds(workflow.components[role])) {
      const tokenizer = await assets.resolve(tokenizerId, { kind: role, family: workflow.pipeline });
      if (!Number.isInteger(tokenizer?.inspection?.vocabulary)) continue;
      for (const encoderId of assetIds(encoder)) {
        const path = await resolvedAsset(assets, encoderId, spec.vocabularyOf, workflow.pipeline);
        // An unreadable encoder is reported by its own checks; this guard only compares vocabularies.
        const rows = await encoderVocabulary(path).catch(() => null);
        const mismatch = tokenizerMismatch(tokenizer.inspection.vocabulary, rows);
        if (mismatch) throw invalid(mismatch);
      }
    }
  }
}

export async function resolveNativeWorkflow(
  input,
  args,
  assets,
  { seed, jobId = randomUUID(), referenceImages = {}, allowPendingReferences = false, sourceSize, overrides = {} } = {},
) {
  const workflow = validateNativeWorkflow(input),
    pipeline = family(workflow.pipeline);
  if (workflow.importDraft) throw invalid('Ce workflow est un brouillon importé, pas un outil exécutable.');
  if (!workflow.enabled) throw invalid('Workflow is disabled');
  const missing = missingComponent(workflow);
  if (missing) throw invalid(missing);
  keys(
    args,
    [
      'workflow_id',
      ...Object.keys(workflow.parameters),
      'components',
      'loras',
      'references',
      ...(workflow.mediaType === 'video' ? ['intention', 'reuse_output'] : []),
    ],
    'workflow arguments',
  );
  if (owns(args, 'workflow_id') && args.workflow_id !== workflow.id)
    throw invalid('workflow_id does not match the selected workflow');
  if (workflow.mediaType === 'video') text(args.intention, 2000, 'Video intention', true);
  if (args.reuse_output !== undefined && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(args.reuse_output))
    throw invalid('Invalid reuse_output');
  identifier(jobId, 'job id');
  const parameters = { ...pipeline.implicitParameters };
  for (const [name, policy] of Object.entries(workflow.parameters))
    parameters[name] = resolvePolicy(policy, pipeline.parameters[name], args, name, { seed });
  if (!parameters.expandPrompt && workflow.promptTemplate) {
    parameters.prompt = workflow.promptTemplate.replace('{{prompt}}', () => parameters.prompt);
    valueMatches(parameters.prompt, pipeline.parameters.prompt, 'Templated prompt');
  }
  if (workflow.profiles && parameters.stage) {
    const profile = workflow.profiles[parameters.stage];
    if (!profile) throw invalid('Select an available draft/final profile');
    Object.assign(parameters, profile.parameters);
  }
  const selections = args.components ?? {};
  keys(selections, Object.keys(workflow.components), 'component arguments');
  const components = {};
  for (const [role, policy] of Object.entries(workflow.components)) {
    if (policy.policy === 'fixed' && owns(selections, role)) throw invalid(`${role} is fixed and locked`);
    const id = policy.policy === 'fixed' ? policy.asset : (selections[role] ?? policy.default);
    if (policy.policy === 'model' && !policy.choices.includes(id)) throw invalid(`Select an allowed ${role} asset`);
    components[role] = await resolvedAsset(assets, id, role, workflow.pipeline);
  }
  const loraArgs = args.loras ?? {};
  keys(
    loraArgs,
    workflow.loras.map(lora => lora.id),
    'LoRA arguments',
  );
  const loras = [];
  for (const lora of workflow.loras) {
    const selection = loraArgs[lora.id] ?? {};
    keys(selection, ['enabled', 'strength'], `LoRA ${lora.id} arguments`);
    const enabled = resolvePolicy(lora.enabled, { type: 'boolean' }, selection, 'enabled');
    if (!enabled && owns(selection, 'strength')) throw invalid(`LoRA ${lora.id} is off; strength cannot be overridden`);
    if (enabled) {
      const strength = resolvePolicy(lora.strength, pipeline.loras.strength, selection, 'strength');
      loras.push({ id: lora.id, path: await resolvedAsset(assets, lora.asset, 'lora', workflow.pipeline), strength });
    }
  }
  const requested = nativeWorkflowReferences(workflow, args),
    references = [];
  // A continuation keeps its source video's size (whatever the draft/final profile says): the
  // source tail is encoded onto the first latent frames of the new window, at the same grid.
  const continues = requested.some(
    reference => workflow.references.find(slot => slot.id === reference.input)?.role === 'source_video',
  );
  if (sourceSize && continues && pipeline.parameters.width && pipeline.parameters.height) {
    const { width, height } = sourceSize;
    try {
      valueMatches(width, pipeline.parameters.width, 'width');
      valueMatches(height, pipeline.parameters.height, 'height');
    } catch (error) {
      throw invalid(
        `The source video is ${width}×${height}; ${workflow.name} cannot continue it at that size (${error.message}). Upscale or crop it first.`,
      );
    }
    Object.assign(parameters, { width, height });
  }
  // Values the user typed in the approval dialog. The user may change locked settings too (the
  // policies restrict the model, not the owner), within the family's own limits.
  if (!plain(overrides)) throw invalid('Invalid parameter edits');
  const editable = new Map(editableParameters(workflow, parameters, { continues }).map(item => [item.key, item]));
  for (const [key, value] of Object.entries(overrides)) {
    const item = editable.get(key);
    if (!item) throw invalid(`${key} cannot be edited in this workflow`);
    if (item.locked) throw invalid(item.locked);
    valueMatches(value, item, key);
    parameters[key] = value;
  }
  keys(
    referenceImages,
    workflow.references.map(slot => slot.id),
    'staged references',
  );
  for (const reference of requested) {
    const slot = workflow.references.find(slot => slot.id === reference.input),
      source = referenceImages[slot.id];
    if (source === undefined && allowPendingReferences) {
      references.push({ input: slot.id, role: slot.role, path: null });
      continue;
    }
    if (typeof source !== 'string' || !isAbsolute(source))
      throw invalid(`A staged absolute local reference is required for ${slot.id}`);
    const path = await realpath(source);
    if (!(await lstat(path)).isFile()) throw invalid(`Reference ${slot.id} must be a regular local file`);
    references.push({ input: slot.id, role: slot.role, path });
  }
  return {
    schemaVersion: 1,
    id: jobId,
    pipeline: workflow.pipeline,
    mediaType: workflow.mediaType,
    workflowId: workflow.id,
    workflowDigest: workflow.digest,
    parameters,
    components,
    loras,
    references,
    ...(parameters.expandPrompt ? { promptExpansion: structuredClone(workflow.promptExpansion) } : {}),
  };
}
const STAGE_KEYS = new Set(['prompt', 'stage', 'expandPrompt']);
/**
 * The resolved parameters the user may change before confirming, with the limits that apply:
 * the workflow's own bounds for model-chosen values, the family's for locked ones.
 */
export function editableParameters(workflow, parameters, { continues = false } = {}) {
  const pipeline = family(workflow.pipeline),
    profiled = new Set(Object.values(workflow.profiles ?? {}).flatMap(profile => Object.keys(profile.parameters)));
  return Object.entries(parameters)
    .filter(
      ([key]) =>
        !STAGE_KEYS.has(key) &&
        pipeline.parameters[key] &&
        (owns(workflow.parameters, key) || profiled.has(key)) &&
        workflow.parameters[key]?.policy !== 'off',
    )
    .map(([key, value]) => {
      const policy = workflow.parameters[key],
        spec = policy?.policy === 'model' ? effective(policy, pipeline.parameters[key]) : pipeline.parameters[key];
      const item = { key, value, type: spec.type };
      for (const bound of ['min', 'max', 'multipleOf', 'choices', 'note'])
        if (spec[bound] !== undefined) item[bound] = spec[bound];
      if (spec.exclusiveMin) item.exclusiveMin = true;
      if (continues && (key === 'width' || key === 'height'))
        item.locked = 'Une continuation garde la taille de sa vidéo source.';
      return item;
    });
}
export function policySchema(policy, spec) {
  const selected = effective(policy, spec),
    schema = { type: spec.type };
  if (selected.min !== undefined) schema[selected.exclusiveMin ? 'exclusiveMinimum' : 'minimum'] = selected.min;
  if (selected.max !== undefined) schema.maximum = selected.max;
  if (selected.maxLength !== undefined) schema.maxLength = selected.maxLength;
  if (selected.nonempty) schema.minLength = 1;
  if (selected.multipleOf) schema.multipleOf = selected.multipleOf;
  if (selected.choices) schema.enum = selected.choices;
  if (policy.description) schema.description = policy.description;
  if (owns(policy, 'default')) schema.default = policy.default;
  return schema;
}
export function workflowSchema(workflow) {
  const properties = { workflow_id: { type: 'string', enum: [workflow.id] } },
    required = ['workflow_id'],
    pipeline = family(workflow.pipeline);
  for (const [name, policy] of Object.entries(workflow.parameters))
    if (policy.policy === 'model') {
      properties[name] = policySchema(policy, pipeline.parameters[name]);
      if (!owns(policy, 'default')) required.push(name);
    }
  const components = {},
    componentRequired = [];
  for (const [role, policy] of Object.entries(workflow.components))
    if (policy.policy === 'model') {
      components[role] = {
        type: 'string',
        enum: policy.choices,
        ...(policy.default ? { default: policy.default } : {}),
      };
      if (!policy.default) componentRequired.push(role);
    }
  if (Object.keys(components).length) {
    properties.components = {
      type: 'object',
      properties: components,
      required: componentRequired,
      additionalProperties: false,
    };
    if (componentRequired.length) required.push('components');
  }
  const loras = {};
  for (const lora of workflow.loras) {
    if (lora.enabled.policy === 'off' || (lora.enabled.policy === 'fixed' && !lora.enabled.value)) continue;
    const writable = {};
    if (lora.enabled.policy === 'model') writable.enabled = policySchema(lora.enabled, { type: 'boolean' });
    if (lora.strength.policy === 'model') writable.strength = policySchema(lora.strength, pipeline.loras.strength);
    if (Object.keys(writable).length)
      loras[lora.id] = {
        type: 'object',
        properties: writable,
        additionalProperties: false,
        description: lora.description,
      };
  }
  if (Object.keys(loras).length) properties.loras = { type: 'object', properties: loras, additionalProperties: false };
  if (workflow.references.length) {
    properties.references = {
      type: 'array',
      maxItems: workflow.references.length,
      items: {
        type: 'object',
        properties: {
          input: { type: 'string', enum: workflow.references.map(slot => slot.id) },
          image: { type: 'integer', minimum: 0, maximum: 6399 },
          resource_id: { type: 'string' },
          frame: { type: 'integer', minimum: 0, maximum: 2 },
          ...(workflow.references.some(slot => slot.role === 'source_video')
            ? {
                output_id: {
                  type: 'string',
                  description:
                    'ID of a native video output in this conversation; uses its original file for continuation.',
                },
                output_index: { type: 'integer', minimum: 0, maximum: 255 },
              }
            : {}),
        },
        required: ['input'],
        additionalProperties: false,
      },
      description: JSON.stringify(nativeWorkflowImageInputs(workflow)),
    };
    if (workflow.references.some(slot => slot.required)) required.push('references');
  }
  if (workflow.mediaType === 'video') {
    properties.intention = {
      type: 'string',
      minLength: 1,
      maxLength: 2000,
      description: 'Explain the concrete video proposal for mandatory user approval.',
    };
    required.push('intention');
    if (workflow.profiles?.final)
      properties.reuse_output = {
        type: 'string',
        description:
          'Promote an approved draft run_id from this conversation to the final profile, retaining its seed, prompt, references, components and LoRA choices. Supply stage=final and intention; do not change other inputs.',
      };
  }
  if (properties.reuse_output)
    return {
      type: 'object',
      properties,
      required: ['workflow_id', 'intention'],
      anyOf: [{ required }, { required: ['reuse_output', 'stage'] }],
      additionalProperties: false,
    };
  return { type: 'object', properties, required, additionalProperties: false };
}

export class NativeWorkflowCatalog {
  constructor(directory, { assets, capabilities = {} } = {}) {
    if (typeof directory !== 'string' || !directory) throw invalid('Workflow directory is required');
    this.kind = 'native';
    this.directory = resolve(directory);
    this.assets = assets;
    this.capabilities = capabilities;
    this.warnings = [];
  }
  async read(id) {
    const path = join(this.directory, `${identifier(id, 'workflow id')}.json`);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw invalid('Workflow file must be a regular file');
      if (stat.size > MAX_BYTES) throw invalid('Workflow exceeds the 2 MiB size limit');
      const bytes = await readFile(path);
      if (bytes.length > MAX_BYTES) throw invalid('Workflow exceeds the 2 MiB size limit');
      const workflow = validateNativeWorkflow(JSON.parse(bytes.toString('utf8')));
      if (workflow.id !== id) throw invalid('Stored workflow id does not match its filename');
      return workflow;
    } catch (error) {
      if (error.code === 'ENOENT') throw invalid(`Workflow ${id} not found`);
      throw error;
    }
  }
  async list() {
    this.warnings = [];
    let files;
    try {
      files = await readdir(this.directory);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const workflows = [];
    for (const filename of files.sort()) {
      if (!filename.endsWith('.json')) continue;
      try {
        const workflow = await this.read(filename.slice(0, -5));
        let ready = false,
          unavailableReason = 'Native executor has not been validated';
        if (workflow.importDraft) {
          const { source, extras, ...summary } = workflow.importDraft;
          workflows.push({
            ...workflow,
            importDraft: summary,
            importSummary: true,
            ready: false,
            unavailableReason: 'Brouillon importé · à vérifier avant activation',
          });
          continue;
        }
        try {
          await checkAssets(workflow, this.assets);
          const capability = this.capabilities[workflow.pipeline];
          ready = workflow.enabled && (capability === true || capability?.ready === true);
          if (!workflow.enabled) unavailableReason = 'Workflow is disabled';
          else if (!ready) unavailableReason = capability?.reason ?? unavailableReason;
        } catch (error) {
          unavailableReason = error.message;
        }
        workflows.push({ ...workflow, ready, ...(!ready ? { unavailableReason } : {}) });
      } catch (error) {
        this.warnings.push(`Skipped workflow ${filename}: ${error.message}`);
      }
    }
    return workflows;
  }
  async save(input) {
    const workflow = validateNativeWorkflow(input);
    if (!workflow.importDraft) await checkAssets(workflow, this.assets);
    await mkdir(this.directory, { recursive: true });
    const { digest, ...stored } = workflow,
      temporary = join(this.directory, `.${workflow.id}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(stored, null, 2), { flag: 'wx', mode: 0o600 });
      await rename(temporary, join(this.directory, `${workflow.id}.json`));
    } finally {
      await rm(temporary, { force: true });
    }
    return workflow;
  }
  async remove(id) {
    await rm(join(this.directory, `${identifier(id, 'workflow id')}.json`), { force: true });
  }
  async prepare(id, args, options = {}) {
    const workflow = await this.read(id);
    return { workflow, job: await resolveNativeWorkflow(workflow, args, this.assets, options), outputNodes: [] };
  }
}
