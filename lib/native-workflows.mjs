import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const invalid = message => Object.assign(new Error(message), { status: 400 });
const plain = value =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [null, Object.prototype].includes(Object.getPrototypeOf(value));
const owns = (value, key) => Object.hasOwn(value, key);
const MAX_BYTES = 2 * 1024 * 1024;
const common = {
  prompt: { type: 'string', maxLength: 8000, nonempty: true },
  seed: { type: 'integer', min: 0, max: Number.MAX_SAFE_INTEGER },
  width: { type: 'integer', min: 64, max: 4096, multipleOf: 8 },
  height: { type: 'integer', min: 64, max: 4096, multipleOf: 8 },
  steps: { type: 'integer', min: 1, max: 1000 },
  cfg: { type: 'number', min: 1, max: 1 },
  denoise: { type: 'number', min: 0, max: 1, exclusiveMin: true },
  expandPrompt: { type: 'boolean' },
};
const pipelines = {
  krea2: {
    mediaType: 'image',
    components: ['model', 'textEncoder', 'vae'],
    requiredComponents: ['model', 'textEncoder', 'vae'],
    parameters: common,
    roles: ['img2img'],
    loraStrength: { type: 'number', min: -4, max: 4 },
  },
  ltx25: {
    mediaType: 'video',
    components: ['model', 'textEncoder', 'vae', 'audioVae', 'textProjection', 'enhancer'],
    requiredComponents: ['model', 'textEncoder', 'vae'],
    parameters: {
      ...common,
      width: { ...common.width, multipleOf: 32 },
      height: { ...common.height, multipleOf: 32 },
      cfg: { type: 'number', min: 0, max: 30 },
      negative_prompt: { type: 'string', maxLength: 8000 },
      frames: { type: 'integer', min: 9, max: 481, choices: Array.from({ length: 60 }, (_, i) => 9 + 8 * i) },
      fps: { type: 'number', min: 1, max: 60 },
      duration: { type: 'number', min: 0.1, max: 600 },
      audio: { type: 'boolean' },
      stage: { type: 'string', choices: ['draft', 'final'] },
      start_strength: { type: 'number', min: 0, max: 1 },
      end_strength: { type: 'number', min: 0, max: 1 },
      image_compression: { type: 'integer', min: 0, max: 51 },
      overlap_frames: { type: 'integer', choices: [1, 9, 17, 25, 33] },
      msr_frames: { type: 'integer', choices: [25, 33] },
      msr_strength: { type: 'number', min: 0, max: 1 },
    },
    roles: ['start_image', 'end_image', 'msr_image', 'source_video'],
    loraStrength: { type: 'number', min: 0, max: 2 },
  },
};
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
    seed: common.seed,
  };
  for (const [name, spec] of Object.entries(specs)) valueMatches(value[name], spec, `Prompt expansion ${name}`);
}

function unsupported(workflow, capability) {
  if (!capability || capability === true) return '';
  if (capability.references && workflow.references.some(slot => !capability.references.includes(slot.role)))
    return 'Reference conditioning is not yet validated by this native executor';
  if (
    capability.loras === false &&
    workflow.loras.some(
      lora => lora.enabled.policy === 'model' || (lora.enabled.policy === 'fixed' && lora.enabled.value),
    )
  )
    return 'LoRAs/MSR are not yet validated by this native executor';
  if (capability.components && Object.keys(workflow.components).some(role => !capability.components.includes(role)))
    return 'An optional component is not yet supported by this native executor';
  if (capability.requiredComponents?.some(role => !workflow.components[role]))
    return 'Select every required native component';
  if (capability.parameters && Object.keys(workflow.parameters).some(name => !capability.parameters.includes(name)))
    return 'A parameter is not yet supported by this native executor';
  const constraints = { ...capability.parameterValues, ...(capability.audio === false ? { audio: [false] } : {}) };
  for (const [name, choices] of Object.entries(constraints)) {
    const policy = workflow.parameters[name];
    if (!policy) continue;
    if (
      policy.policy === 'fixed'
        ? !choices.includes(policy.value)
        : policy.policy !== 'model' || !policy.choices || policy.choices.some(value => !choices.includes(value))
    )
      return `Native executor does not support the selected ${name} policy`;
    if (
      Object.values(workflow.profiles || {}).some(
        profile => owns(profile.parameters, name) && !choices.includes(profile.parameters[name]),
      )
    )
      return `Native executor does not support the selected ${name} profile`;
  }
  return '';
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
      !['', 'krea2', 'ltx25'].includes(input.pipeline) ||
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
  if (typeof input.pipeline !== 'string' || !owns(pipelines, input.pipeline)) throw invalid('Unsupported pipeline');
  const pipeline = pipelines[input.pipeline];
  if (pipeline.mediaType !== input.mediaType) throw invalid('Unsupported pipeline or mediaType');
  keys(input.components, pipeline.components, 'component roles');
  for (const role of pipeline.requiredComponents)
    if (!owns(input.components, role)) throw invalid(`Missing required component ${role}`);
  for (const [role, policy] of Object.entries(input.components)) componentPolicy(policy, role);
  keys(input.parameters, Object.keys(pipeline.parameters), 'parameters');
  for (const required of ['prompt', 'seed', 'width', 'height', 'steps'])
    if (!owns(input.parameters, required)) throw invalid(`Missing required parameter ${required}`);
  for (const [name, policy] of Object.entries(input.parameters))
    validatePolicy(policy, pipeline.parameters[name], name, { random: name === 'seed' });
  if (input.promptTemplate !== undefined) {
    if (input.pipeline !== 'krea2') throw invalid('Prompt templates require Krea2');
    promptTemplate(input.promptTemplate, 'Prompt template');
  }
  if (input.promptExpansion !== undefined) {
    if (input.pipeline !== 'krea2') throw invalid('Prompt expansion requires Krea2');
    expansionConfig(input.promptExpansion);
  }
  const expansion = input.parameters.expandPrompt;
  if (expansion && (expansion.policy === 'model' || expansion.value === true) && input.promptExpansion === undefined)
    throw invalid('Enabled prompt expansion requires explicit template and sampling settings');
  if (!Array.isArray(input.loras) || input.loras.length > (input.pipeline === 'krea2' ? 32 : 64))
    throw invalid('Too many LoRAs for this pipeline');
  const loraIds = new Set();
  for (const lora of input.loras) {
    keys(lora, ['id', 'asset', 'description', 'enabled', 'strength'], 'LoRA');
    identifier(lora.id, 'LoRA id');
    identifier(lora.asset, 'LoRA asset');
    text(lora.description, 1000, 'LoRA description');
    if (loraIds.has(lora.id)) throw invalid('Duplicate LoRA id');
    loraIds.add(lora.id);
    validatePolicy(lora.enabled, { type: 'boolean' }, `LoRA ${lora.id} enabled`, { off: true });
    validatePolicy(lora.strength, pipeline.loraStrength, `LoRA ${lora.id} strength`);
  }
  if (!Array.isArray(input.references) || input.references.length > 64)
    throw invalid('References must be an array of at most 64 entries');
  const referenceIds = new Set();
  for (const reference of input.references) {
    keys(reference, ['id', 'role', 'required', 'name', 'description'], 'reference slot');
    identifier(reference.id, 'reference id');
    if (
      referenceIds.has(reference.id) ||
      !pipeline.roles.includes(reference.role) ||
      typeof reference.required !== 'boolean'
    )
      throw invalid('Invalid or duplicate reference slot/role');
    referenceIds.add(reference.id);
    if (reference.name !== undefined) text(reference.name, 120, 'Reference name', true);
    if (reference.description !== undefined) text(reference.description, 1000, 'Reference description');
  }
  if (input.pipeline === 'krea2' && input.references.length > 1) throw invalid('Krea2 supports one img2img reference');
  if (input.profiles !== undefined) {
    if (input.mediaType !== 'video') throw invalid('Profiles require a video workflow');
    keys(input.profiles, ['draft', 'final'], 'video profiles');
    for (const [stage, profile] of Object.entries(input.profiles)) {
      keys(profile, ['parameters'], `${stage} profile`);
      keys(
        profile.parameters,
        ['width', 'height', 'steps', 'frames', 'fps', 'duration'],
        `${stage} profile parameters`,
      );
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
    if (owns(reference, 'output_id')) {
      if (
        slot.role !== 'source_video' ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(reference.output_id) ||
        owns(reference, 'frame') ||
        (reference.output_index !== undefined &&
          (!Number.isInteger(reference.output_index) || reference.output_index < 0 || reference.output_index > 255))
      )
        throw invalid('Invalid output video reference');
      continue;
    }
    if (
      owns(reference, 'output_index') ||
      (slot.role === 'source_video' && (owns(reference, 'image') || owns(reference, 'frame')))
    )
      throw invalid('A source video requires an original resource or output');
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
async function checkAssets(workflow, assets) {
  for (const [role, policy] of Object.entries(workflow.components))
    for (const id of policy.policy === 'fixed' ? [policy.asset] : policy.choices)
      await resolvedAsset(assets, id, role, workflow.pipeline);
  for (const lora of workflow.loras) await resolvedAsset(assets, lora.asset, 'lora', workflow.pipeline);
}

export async function resolveNativeWorkflow(
  input,
  args,
  assets,
  { seed, jobId = randomUUID(), referenceImages = {}, allowPendingReferences = false } = {},
) {
  const workflow = validateNativeWorkflow(input),
    pipeline = pipelines[workflow.pipeline];
  if (workflow.importDraft) throw invalid('Ce workflow est un brouillon importé, pas un outil exécutable.');
  if (!workflow.enabled) throw invalid('Workflow is disabled');
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
  const parameters = workflow.pipeline === 'krea2' ? { cfg: 1, denoise: 1 } : {};
  for (const [name, policy] of Object.entries(workflow.parameters))
    parameters[name] = resolvePolicy(policy, pipeline.parameters[name], args, name, { seed });
  if (!parameters.expandPrompt && workflow.promptTemplate) {
    parameters.prompt = workflow.promptTemplate.replace('{{prompt}}', () => parameters.prompt);
    valueMatches(parameters.prompt, common.prompt, 'Templated prompt');
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
      const strength = resolvePolicy(lora.strength, pipeline.loraStrength, selection, 'strength');
      loras.push({ id: lora.id, path: await resolvedAsset(assets, lora.asset, 'lora', workflow.pipeline), strength });
    }
  }
  const requested = nativeWorkflowReferences(workflow, args),
    references = [];
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
function policySchema(policy, spec) {
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
function workflowSchema(workflow) {
  const properties = { workflow_id: { type: 'string', enum: [workflow.id] } },
    required = ['workflow_id'],
    pipeline = pipelines[workflow.pipeline];
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
    if (lora.strength.policy === 'model') writable.strength = policySchema(lora.strength, pipeline.loraStrength);
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
          if (ready) {
            const reason = unsupported(workflow, capability);
            if (reason) {
              ready = false;
              unavailableReason = reason;
            }
          }
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
  async toolDefinition(mediaType = 'image') {
    const workflows = (await this.list()).filter(workflow => workflow.mediaType === mediaType && workflow.ready);
    if (!workflows.length) return null;
    const variants = workflows.map(workflowSchema);
    return {
      type: 'function',
      function: {
        name: mediaType === 'video' ? 'generate_video' : 'generate_image',
        description: `${mediaType === 'video' ? 'Propose a video only when the user asks to produce one. Every execution requires separate explicit approval.' : 'Generate or edit an image only when the user asks to produce or change an image; writing a prompt does not imply generation.'} Use only the selected workflow's writable parameters and declared reference roles. Inspect relevant reference pixels before composing the prompt.\n${workflows.map(workflow => `${workflow.id} (${workflow.name}): ${workflow.description}`).join('\n')}`,
        parameters: variants.length === 1 ? variants[0] : { type: 'object', oneOf: variants },
      },
    };
  }
  async definition(mediaType = 'image') {
    return this.toolDefinition(mediaType);
  }
}
