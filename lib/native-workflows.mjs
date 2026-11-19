import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { atomicFile } from './update-files.mjs';
import { families, family } from './families.mjs';
import { encoderVocabulary, tokenizerMismatch } from './generation-assets.mjs';
import { FORMATS, formatOf, nearestSize, sizesFor } from '../public/formats.mjs';
import { CHOICE_NAMES, SETTING_NAMES } from '../public/setting-names.mjs';

const invalid = message => Object.assign(new Error(message), { status: 400 });
const plain = value =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [null, Object.prototype].includes(Object.getPrototypeOf(value));
const owns = (value, key) => Object.hasOwn(value, key);
// A number as the application writes it to the user: « 0,6 ».
const decimal = value => String(value).replace('.', ',');
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
// (0.6.94) A setting as the user knows it, by its name in Paramètres › Workflows; a value as the
// editor shows it (« 0,6 », « vide », « Brouillon »).
const nameOf = label => SETTING_NAMES[label] ?? label;
const shownValue = value => (value === '' ? 'vide' : (CHOICE_NAMES[value] ?? decimal(value)));
/** The values a number may take, in words: « entre 0,6 et 0,7 », « 1 au moins », « plus de 0 »… */
function rangeText(spec) {
  const low = spec.min === undefined ? null : decimal(spec.min),
    high = spec.max === undefined ? null : decimal(spec.max);
  if (spec.exclusiveMin && low !== null) return high === null ? `plus de ${low}` : `plus de ${low} et ${high} au plus`;
  if (low !== null && high !== null) return `entre ${low} et ${high}`;
  return low !== null ? `${low} au moins` : `${high} au plus`;
}
/**
 * Refuses a value a setting cannot take, in the user's words (0.6.94): « Étapes : entre 1 et 50. »,
 * « Audio : oui ou non. », where « steps is outside the supported range » was said in the Studio.
 */
function valueMatches(value, spec, label) {
  const name = nameOf(label);
  if (spec.type === 'string') {
    const max = spec.maxLength ?? 8000;
    if (typeof value !== 'string') throw invalid(`${name} : un texte est attendu.`);
    if (spec.nonempty && !value.trim()) throw invalid(`${name} : à écrire, il ne peut pas rester vide.`);
    if (value.length > max) throw invalid(`${name} : ${max} caractères au plus.`);
  } else if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') throw invalid(`${name} : oui ou non.`);
  } else if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (spec.type === 'integer' && !Number.isSafeInteger(value))
  )
    throw invalid(`${name} : ${spec.type === 'integer' ? 'un nombre entier' : 'un nombre'}.`);
  if (
    (spec.min !== undefined && (value < spec.min || (spec.exclusiveMin && value === spec.min))) ||
    (spec.max !== undefined && value > spec.max)
  )
    throw invalid(`${name} : ${rangeText(spec)}.`);
  if (spec.multipleOf && value % spec.multipleOf) throw invalid(`${name} : un multiple de ${spec.multipleOf}.`);
  if (spec.choices && !spec.choices.includes(value))
    throw invalid(
      `${name} : ${spec.choices.length <= 8 ? 'une de ces valeurs : ' + spec.choices.map(shownValue).join(', ') : 'une des valeurs que ce workflow autorise'}.`,
    );
}
/** Whether a setting can take this value (valueMatches, without its refusal). */
function fits(value, spec) {
  try {
    valueMatches(value, spec, '');
    return true;
  } catch {
    return false;
  }
}
export function effective(policy, spec) {
  return {
    ...spec,
    min: policy.min ?? spec.min,
    max: policy.max ?? spec.max,
    maxLength: policy.maxLength ?? spec.maxLength,
    choices: policy.choices ?? spec.choices,
    // A minimum the family leaves out (a denoise above 0) is left out at that minimum only: one
    // the workflow raises (0.6 for Krea 2) is a value like the others.
    ...(spec.exclusiveMin ? { exclusiveMin: policy.min === undefined || policy.min === spec.min } : {}),
  };
}
/**
 * (0.6.94) What a setting left to the assistant is made with when nothing is given for it: its
 * default. One saved without (« Préférer une valeur par défaut » unticked, which the editor no
 * longer saves) refused every creation that did not name it, the Studio's included. It takes a value
 * sure to be right when there is one: the one its family gives a new workflow (`template`, its
 * template's policy for that setting), brought within what this workflow allows (its bounds, its
 * steps, the nearest of its choices); else the only value the workflow allows. Undefined when there is
 * none: the setting must then be given.
 */
export function standIn(policy, spec, template) {
  if (owns(policy, 'default')) return policy.default;
  const allowed = effective(policy, spec),
    given = template?.policy === 'fixed' ? template.value : template?.default,
    candidates = [given];
  if (typeof given === 'number' && Number.isFinite(given)) {
    if (allowed.choices?.length && allowed.choices.every(choice => typeof choice === 'number'))
      candidates.push(
        allowed.choices.reduce((best, choice) => (Math.abs(choice - given) < Math.abs(best - given) ? choice : best)),
      );
    else if (!allowed.choices) {
      let near = Math.min(allowed.max ?? Infinity, Math.max(allowed.min ?? -Infinity, given));
      if (allowed.multipleOf) near = Math.round(near / allowed.multipleOf) * allowed.multipleOf;
      candidates.push(near);
    }
  }
  if (allowed.choices?.length === 1) candidates.push(allowed.choices[0]);
  if (allowed.min !== undefined && allowed.min === allowed.max) candidates.push(allowed.min);
  return candidates.find(value => value !== undefined && fits(value, allowed));
}
/** (0.6.94) A parameter of a workflow as it is made: left to the assistant, with its stand-in default. */
export function madePolicy(workflow, name) {
  const policy = workflow.parameters?.[name];
  if (policy?.policy !== 'model' || owns(policy, 'default')) return policy;
  const pipeline = family(workflow.pipeline),
    value = standIn(policy, pipeline.parameters[name], pipeline.template?.parameters?.[name]);
  return value === undefined ? policy : { ...policy, default: value };
}
// What a LoRA left to the assistant without a default is made with (standIn): off, and at the
// strength a LoRA added in the editor starts with.
const LORA_OFF = { policy: 'fixed', value: false },
  LORA_STRENGTH = { policy: 'fixed', value: 1 };
/** (0.6.94) A LoRA of a workflow as it is made: its switch and strength with their stand-in defaults. */
export function madeLora(lora, pipeline) {
  const settle = (policy, spec, template) => {
    if (policy?.policy !== 'model' || owns(policy, 'default')) return policy;
    const value = standIn(policy, spec, template);
    return value === undefined ? policy : { ...policy, default: value };
  };
  return {
    ...lora,
    enabled: settle(lora.enabled, { type: 'boolean' }, LORA_OFF),
    strength: settle(lora.strength, family(pipeline).loras?.strength ?? { type: 'number' }, LORA_STRENGTH),
  };
}
/**
 * (0.6.94) The file a component left to the assistant is made with: its default, else the only one
 * allowed. (0.6.102) « Assistant » left the files of the editor, which shows such a file « Fixe » at
 * that same file: of several allowed without a default, the first, as the editor shows it.
 */
export const componentStandIn = policy => policy.default ?? policy.choices?.[0];
/** The roles of the inputs a setting is only read with (`onlyWith.role`, or several: `roles`). */
export const onlyRoles = spec => (spec?.onlyWith ? (spec.onlyWith.roles ?? [spec.onlyWith.role]) : []);
/**
 * The settings the engine does not read with these inputs (`onlyWith` in the family), each with the
 * value a job then really has (`otherwise`: the denoise of Krea 2 without an image to modify is 1),
 * or undefined when it has none: the strength of an end image without an end image, the overlap of
 * a continuation in a video that continues nothing are then no part of the job.
 * `references`: the inputs given, by the slot each takes (`input`).
 */
export function unreadParameters(workflow, references = []) {
  const unread = {},
    given = new Set(
      references.map(reference => (workflow.references ?? []).find(slot => slot.id === reference.input)?.role),
    );
  for (const [name, spec] of Object.entries(family(workflow.pipeline).parameters))
    if (spec.onlyWith && !onlyRoles(spec).some(role => given.has(role))) unread[name] = spec.onlyWith.otherwise;
  return unread;
}
/**
 * What a workflow narrows a setting to (a policy's `min`, `max`, `maxLength`, `choices`), within what
 * its family allows; the limits that then apply (effective).
 */
function checkNarrowing(policy, spec, label) {
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
  return selected;
}
function validatePolicy(policy, spec, label, { random = false, off = false } = {}) {
  if (!plain(policy)) throw invalid(`Invalid ${label} policy`);
  if (policy.policy === 'off' && off) {
    keys(policy, ['policy'], `${label} off policy`);
    return;
  }
  if (policy.policy === 'fixed') {
    // (0.6.102) « Fixe » holds Moodix AI to its value; the user may change it for a creation (the
    // Studio, the card of a proposal), within the limits a workflow gives it, as for « Assistant »:
    // those of « Assistant » stay when a setting is turned « Fixe » in the editor.
    keys(
      policy,
      ['policy', 'value', 'description', 'type', 'min', 'max', 'maxLength', 'choices'],
      `${label} fixed policy`,
    );
    if (policy.type !== undefined && policy.type !== spec.type) throw invalid(`Invalid ${label} type`);
    valueMatches(policy.value, checkNarrowing(policy, spec, label), label);
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
    const selected = checkNarrowing(policy, spec, label);
    if (owns(policy, 'default')) valueMatches(policy.default, selected, label);
  } else throw invalid(`Unsupported ${label} policy`);
  if (policy.description !== undefined) text(policy.description, 1000, `${label} description`);
}
function componentPolicy(policy, label) {
  if (policy?.policy === 'fixed') {
    keys(policy, ['policy', 'asset', 'file'], `${label} component policy`);
    identifier(policy.asset, 'asset id');
    // File name of the asset where it was saved: lets another installation find the same weights.
    if (
      policy.file !== undefined &&
      (typeof policy.file !== 'string' || !policy.file || policy.file.length > 255 || /[\\/\0]/.test(policy.file))
    )
      throw invalid(`Invalid ${label} file name`);
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
    const { digest, ready, unavailableReason, automatic, builtin, customized, update, ...stored } = input;
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
      'automatic',
      'builtin',
      'customized',
      'update',
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
    // (0.6.94) Named as the editor shows the LoRA (its use), not by its identifier.
    const called = `du LoRA « ${lora.description || lora.id} »`;
    validatePolicy(lora.enabled, { type: 'boolean' }, 'Activation ' + called, { off: true });
    validatePolicy(lora.strength, loraLimits.strength, 'Intensité ' + called);
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
  const { digest, ready, unavailableReason, automatic, builtin, customized, update, ...stored } = input;
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
    keys(
      reference,
      ['input', 'image', 'resource_id', 'frame', 'output_id', 'output_index', 'output_conversation'],
      'reference source',
    );
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
          (!Number.isInteger(reference.output_index) || reference.output_index < 0 || reference.output_index > 255)) ||
        // Made in another conversation of the project: that conversation.
        (reference.output_conversation !== undefined &&
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(reference.output_conversation))
      )
        throw invalid('Invalid output video reference');
      continue;
    }
    if (owns(reference, 'output_conversation')) throw invalid('A conversation goes only with an output');
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
    if (slot.required && !seen.has(slot.id))
      throw invalid(`« ${slot.name ?? slot.id} » : une entrée est obligatoire pour ce workflow.`);
  return structuredClone(references);
}
/**
 * The value of one setting in a job. `label`: its name when it is not a parameter (a LoRA's switch
 * or strength); `template`: what its family gives a new workflow (standIn), for one left to the
 * assistant without a default. (0.6.94) Refused in the user's words, under the name the editor
 * shows: « Étapes : aucune valeur donnée… » where « steps is required » was said.
 */
function resolvePolicy(policy, spec, args, key, { seed, label = key, template } = {}) {
  const provided = owns(args, key);
  if (policy.policy !== 'model' && provided)
    throw invalid(
      key === 'prompt'
        ? 'Le prompt de ce workflow est fixé : ouvrez-le dans Paramètres › Workflows et enregistrez-le, le prompt sera alors écrit à chaque création.'
        : policy.policy === 'random'
          ? `${nameOf(label)} : tirée à chaque création par ce workflow, elle ne se donne pas ainsi.`
          : `${nameOf(label)} : valeur fixée par ce workflow, elle ne se change pas.`,
    );
  if (policy.policy === 'off') return false;
  if (policy.policy === 'fixed') return policy.value;
  if (policy.policy === 'random') {
    const result = seed ?? Number(randomBytes(8).readBigUInt64LE() & BigInt(Number.MAX_SAFE_INTEGER));
    valueMatches(result, spec, label);
    return result;
  }
  const value = provided ? args[key] : standIn(policy, spec, template);
  if (value === undefined)
    throw invalid(
      `${nameOf(label)} : aucune valeur donnée, et ce workflow n’en a pas par défaut. Choisissez-en une dans Paramètres › Workflows.`,
    );
  valueMatches(value, effective(policy, spec), label);
  return value;
}
/**
 * The file of a component: the one the workflow names when it is here, else the one the
 * folders of the settings hold for it (`automatic` on the result; see GenerationAssets.pick).
 */
async function componentAsset(assets, id, kind, family, file, encoder) {
  if (!assets || typeof assets.resolve !== 'function') throw invalid('Local asset registry is unavailable');
  const asset = await assets.resolve(id, { kind, family, ...(file ? { file } : {}), ...(encoder ? { encoder } : {}) });
  if (!asset || typeof asset.path !== 'string' || !isAbsolute(asset.path))
    throw invalid(`Asset ${id} must resolve to an absolute local path`);
  return asset;
}
async function resolvedAsset(assets, id, kind, family, file, encoder) {
  return (await componentAsset(assets, id, kind, family, file, encoder)).path;
}
/** Components in the order they are settled: a tokenizer after the text encoder it must match. */
const settled = (entries, components) =>
  [...entries].sort(([a], [b]) => Boolean(components[a]?.vocabularyOf) - Boolean(components[b]?.vocabularyOf));
/**
 * The file for a required component the workflow leaves unset, taken from the folders of the
 * settings; `paths` holds the components settled so far (the text encoder of a tokenizer).
 */
async function unsetComponent(assets, workflow, role, paths) {
  const spec = family(workflow.pipeline).components[role];
  const picked =
    typeof assets?.pick === 'function'
      ? await assets.pick(role, workflow.pipeline, { encoder: paths[spec.vocabularyOf] ?? null })
      : null;
  if (!picked)
    throw invalid(
      `Aucun fichier pour ${spec.label ? '« ' + spec.label + ' »' : role} : choisissez-le dans ce workflow, ou placez-le dans le dossier de ce type de fichier (réglages, Dossiers des modèles de génération).`,
    );
  return picked;
}
/** Whether an asset cannot be found at all here (as opposed to found but unsuitable). */
async function absentAsset(assets, id, kind, family, file, encoder) {
  try {
    await resolvedAsset(assets, id, kind, family, file, encoder);
    return false;
  } catch (error) {
    return error.code === 'ENOENT' || /not found|absolute local path/.test(error.message);
  }
}
/** The first required component a workflow does not select yet, as an error to show, or ''. */
export function missingComponent(workflow) {
  for (const [role, spec] of Object.entries(family(workflow.pipeline).components))
    if (spec.required && !owns(workflow.components, role))
      return `Choisissez ${spec.label ? 'le composant « ' + spec.label + ' »' : role} dans ce workflow.`;
  return '';
}
const assetIds = policy => (policy.policy === 'fixed' ? [policy.asset] : policy.choices);
/**
 * Checks that every file of a workflow is here and is the right one. Returns the components
 * whose file was taken from the folders of the settings, by role: { textEncoder: 'name' }.
 */
async function checkAssets(workflow, assets) {
  const automatic = {},
    paths = {};
  // Said in the user's words: which file, for what, and whether it is missing or the wrong one.
  const usable = async (id, role, file, label) => {
    try {
      const asset = await componentAsset(
        assets,
        id,
        role,
        workflow.pipeline,
        file,
        paths[family(workflow.pipeline).components[role]?.vocabularyOf],
      );
      paths[role] ??= asset.path;
      if (asset.automatic) automatic[role] = basename(asset.path);
    } catch (error) {
      const name = file ? ` (${file})` : '',
        missing = error.code === 'ENOENT' || /not found|absolute local path/.test(error.message),
        refused = invalid(
          missing
            ? `Fichier introuvable pour « ${label} »${name} : choisissez-le dans le workflow.`
            : `Fichier incompatible pour « ${label} »${name} : ${error.message}`,
        );
      // A file that is not there (not a wrong one): it may be downloaded (etats-maquette.md, 53).
      if (missing) refused.missing = true;
      throw refused;
    }
  };
  const components = family(workflow.pipeline).components;
  for (const [role, policy] of settled(Object.entries(workflow.components), components))
    for (const id of assetIds(policy)) {
      // An optional component whose file is not here is simply not used (see resolveNativeWorkflow).
      if (
        !components[role]?.required &&
        (await absentAsset(assets, id, role, workflow.pipeline, policy.file, paths[components[role]?.vocabularyOf]))
      )
        continue;
      await usable(id, role, policy.file, components[role]?.label || role);
    }
  // A required component the workflow does not fix: the folders of the settings answer for it.
  for (const [role, spec] of settled(Object.entries(components), components)) {
    if (!spec.required || owns(workflow.components, role)) continue;
    const picked = await unsetComponent(assets, workflow, role, paths);
    paths[role] = picked.path;
    automatic[role] = basename(picked.path);
  }
  for (const lora of workflow.loras) await usable(lora.asset, 'lora', undefined, 'LoRA ' + lora.id);
  // A tokenizer from another model family does not fail: it silently feeds the wrong tokens.
  for (const [role, spec] of Object.entries(family(workflow.pipeline).components)) {
    const encoder = spec.vocabularyOf && workflow.components[spec.vocabularyOf];
    if (!encoder || !workflow.components[role]) continue;
    for (const tokenizerId of assetIds(workflow.components[role])) {
      const tokenizer = await assets.resolve(tokenizerId, {
        kind: role,
        family: workflow.pipeline,
        ...(workflow.components[role].file ? { file: workflow.components[role].file } : {}),
        ...(paths[spec.vocabularyOf] ? { encoder: paths[spec.vocabularyOf] } : {}),
      });
      if (!Number.isInteger(tokenizer?.inspection?.vocabulary)) continue;
      for (const encoderId of assetIds(encoder)) {
        const path = await resolvedAsset(assets, encoderId, spec.vocabularyOf, workflow.pipeline, encoder.file);
        // An unreadable encoder is reported by its own checks; this guard only compares vocabularies.
        const rows = await encoderVocabulary(path).catch(() => null);
        const mismatch = tokenizerMismatch(tokenizer.inspection.vocabulary, rows);
        if (mismatch) throw invalid(mismatch);
      }
    }
  }
  return automatic;
}

export async function resolveNativeWorkflow(
  input,
  args,
  assets,
  {
    seed,
    jobId = randomUUID(),
    referenceImages = {},
    allowPendingReferences = false,
    sourceSize,
    aspect,
    overrides = {},
    // (0.6.94) Asked by the user's own hand (the Studio, the buttons of a take): « Disponible pour
    // l’assistant » unticked takes a workflow out of Moodix AI's tools only, never out of the Studio.
    byHand = false,
  } = {},
) {
  const workflow = validateNativeWorkflow(input),
    pipeline = family(workflow.pipeline);
  if (workflow.importDraft) throw invalid('Ce workflow est un brouillon importé, pas un outil exécutable.');
  if (!workflow.enabled && !byHand)
    throw invalid(
      `${workflow.name} n’est pas proposé à Moodix AI : cochez « Disponible pour l’assistant » dans Paramètres › Workflows.`,
    );
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
    parameters[name] = resolvePolicy(policy, pipeline.parameters[name], args, name, {
      seed,
      template: pipeline.template?.parameters?.[name],
    });
  if (!parameters.expandPrompt && workflow.promptTemplate) {
    parameters.prompt = workflow.promptTemplate.replace('{{prompt}}', () => parameters.prompt);
    valueMatches(parameters.prompt, pipeline.parameters.prompt, 'Templated prompt');
  }
  if (workflow.profiles && parameters.stage) {
    const profile = workflow.profiles[parameters.stage];
    if (!profile) throw invalid('Select an available draft/final profile');
    // A value the model was allowed to choose and did choose (a duration, say) outlives the profile.
    for (const [key, value] of Object.entries(profile.parameters))
      if (!(owns(args, key) && workflow.parameters[key]?.policy === 'model')) parameters[key] = value;
  }
  const selections = args.components ?? {};
  keys(selections, Object.keys(workflow.components), 'component arguments');
  const components = {};
  for (const [role, policy] of settled(Object.entries(workflow.components), pipeline.components)) {
    // (0.6.94) Said by the name of the file in Paramètres › Workflows (« VAE »), in French.
    const label = `« ${pipeline.components[role]?.label || role} »`;
    if (policy.policy === 'fixed' && owns(selections, role))
      throw invalid(`${label} : fichier fixé par ce workflow, il ne se change pas.`);
    // Left to the assistant without a default file (componentStandIn): the only one allowed.
    const id = policy.policy === 'fixed' ? policy.asset : (selections[role] ?? componentStandIn(policy));
    if (policy.policy === 'model' && id === undefined)
      throw invalid(
        `${label} : aucun fichier par défaut dans ce workflow, et aucun n’a été choisi. Choisissez-en un dans Paramètres › Workflows.`,
      );
    if (policy.policy === 'model' && !policy.choices.includes(id))
      throw invalid(`${label} : ce fichier n’est pas parmi ceux que ce workflow autorise.`);
    const encoder = components[pipeline.components[role]?.vocabularyOf];
    // A shipped workflow may name an optional file this installation does not have (LTX's
    // latent upscaler): the family then works without it.
    if (
      !pipeline.components[role]?.required &&
      (await absentAsset(assets, id, role, workflow.pipeline, policy.file, encoder))
    )
      continue;
    components[role] = await resolvedAsset(assets, id, role, workflow.pipeline, policy.file, encoder);
  }
  // A required component the workflow does not fix: the folders of the settings answer for it.
  for (const [role, spec] of settled(Object.entries(pipeline.components), pipeline.components))
    if (spec.required && !owns(workflow.components, role))
      components[role] = (await unsetComponent(assets, workflow, role, components)).path;
  const loraArgs = args.loras ?? {};
  keys(
    loraArgs,
    workflow.loras.map(lora => lora.id),
    'LoRA arguments',
  );
  const requested = nativeWorkflowReferences(workflow, args),
    references = [];
  // Some references only work with their LoRA (the subject images of LTX): giving one switches
  // that LoRA on, and only that (referenceLora). The user hands over an image, not a setting, and
  // neither does the model: what an older request says of it is left aside.
  const dependent = requested
    .map(reference => pipeline.roles?.[workflow.references.find(slot => slot.id === reference.input)?.role])
    .find(role => role?.requiresLora);
  const loras = [],
    bound = referenceLora(workflow);
  for (const lora of workflow.loras) {
    const selection = loraArgs[lora.id] ?? {};
    keys(selection, ['enabled', 'strength'], `LoRA ${lora.id} arguments`);
    // (0.6.94) Said by what the editor shows of it, with a stand-in for a default it lacks (madeLora).
    const called = `du LoRA « ${lora.description || lora.id} »`,
      strengthOf = given =>
        resolvePolicy(lora.strength, pipeline.loras.strength, given, 'strength', {
          label: 'Intensité ' + called,
          template: LORA_STRENGTH,
        });
    if (lora === bound) {
      if (dependent)
        loras.push({
          id: lora.id,
          path: await resolvedAsset(assets, lora.asset, 'lora', workflow.pipeline),
          strength: strengthOf({}),
        });
      continue;
    }
    const enabled = resolvePolicy(lora.enabled, { type: 'boolean' }, selection, 'enabled', {
      label: 'Activation ' + called,
      template: LORA_OFF,
    });
    if (!enabled && owns(selection, 'strength'))
      throw invalid(`Intensité ${called} : ce LoRA n’est pas activé, son intensité ne se règle pas.`);
    if (enabled) {
      const strength = strengthOf(selection);
      loras.push({ id: lora.id, path: await resolvedAsset(assets, lora.asset, 'lora', workflow.pipeline), strength });
    }
  }
  if (dependent && !loras.length)
    throw invalid(
      `${workflow.name} ne peut pas utiliser de ${dependent.label.toLowerCase()} : le LoRA dont elle dépend n’est pas activé dans ce workflow.`,
    );
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
        `La vidéo source fait ${width}×${height} : ${workflow.name} ne peut pas la prolonger à cette taille (${error.message.replace(/\.$/, '')}).`,
      );
    }
    Object.assign(parameters, { width, height });
  }
  // A size the workflow sets takes the format asked for, or the one of the image the video
  // starts from, at the scale of its profile: a portrait image is not animated in landscape.
  if (
    aspect &&
    !continues &&
    !owns(args, 'width') &&
    !owns(args, 'height') &&
    Number.isInteger(parameters.width) &&
    Number.isInteger(parameters.height)
  ) {
    // (Among the sizes of its family when it has its own, as the Studio offers them: Krea 2's, 0.6.92.)
    const size = sizeInFormat(
      aspect,
      parameters.width * parameters.height,
      { width: pipeline.parameters.width, height: pipeline.parameters.height },
      workflow.pipeline,
    );
    if (size) Object.assign(parameters, size);
  }
  // A continuation renders its overlap with the source again: at the profile's own length a
  // short draft would add almost nothing. Unless a length was chosen, it adds one profile-length
  // clip of new footage (the closest count the workflow allows).
  if (
    continues &&
    workflow.parameters.frames?.policy === 'model' &&
    !owns(args, 'frames') &&
    Number.isInteger(parameters.frames) &&
    Number.isInteger(parameters.overlap_frames)
  ) {
    const spec = effective(workflow.parameters.frames, pipeline.parameters.frames),
      wanted = parameters.frames + parameters.overlap_frames;
    let choices = spec.choices;
    if (!choices) {
      const step = spec.multipleOf || 1;
      choices = [Math.min(spec.max ?? Infinity, Math.max(spec.min ?? 1, Math.round(wanted / step) * step))];
    }
    parameters.frames = choices.reduce((best, value) =>
      Math.abs(value - wanted) < Math.abs(best - wanted) ? value : best,
    );
  }
  // Values the user typed in the approval dialog. The user may change locked settings too (the
  // policies restrict the model, not the owner), within the limits of the workflow (0.6.102: those
  // of « Fixe » as those of « Assistant », editableParameters; the family's, where it gives none).
  if (!plain(overrides)) throw invalid('Invalid parameter edits');
  // A setting the engine only reads with a given input (`onlyWith` in the family: the denoise of
  // Krea 2 with an image to modify), when that input is not given.
  const unread = unreadParameters(workflow, requested);
  const editable = new Map(editableParameters(workflow, parameters, { continues }).map(item => [item.key, item]));
  for (const [key, value] of Object.entries(overrides)) {
    // What the family marks unused changes nothing in what is made and is no longer offered: an
    // edit of it kept from an earlier take is left aside, not refused. The same for a setting
    // whose input is not there.
    if ((pipeline.parameters[key]?.unused || owns(unread, key)) && owns(workflow.parameters, key)) continue;
    const item = editable.get(key);
    if (!item) throw invalid(`${key} cannot be edited in this workflow`);
    if (item.locked) throw invalid(item.locked);
    // A number outside its limits is said in the words of the user, « Débruitage : entre 0,6 et 0,7. »
    // (0.6.94: under the name Paramètres › Workflows gives the setting, as every refusal of the server).
    if (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      ((item.min !== undefined && value < item.min) || (item.max !== undefined && value > item.max))
    )
      throw invalid(`${nameOf(key)} : ${rangeText(item)}.`);
    valueMatches(value, item, key);
    parameters[key] = value;
  }
  // Without that input the job says the value it is really made with (pure noise, a denoise of
  // 1), whatever the workflow, the model or an edit says: the proposal, the Studio and the record
  // of the take then show it. A setting with no such value is left out of the job: the record of
  // a video made without an end image says nothing of the strength of one.
  for (const [name, value] of Object.entries(unread)) {
    if (!owns(parameters, name)) continue;
    if (value === undefined) delete parameters[name];
    else parameters[name] = value;
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
/**
 * The clean size of the format closest to `aspect` (a size, or `{ format: '9:16' }`) that is
 * nearest to `pixels` and that the model accepts (`family`: its pipeline, whose own sizes are
 * taken when it has some); null when no listed format is close.
 */
export function sizeInFormat(aspect, pixels, limits, family = null) {
  let format = FORMATS.find(item => item.id === aspect.format) || formatOf(aspect.width, aspect.height);
  if (!format && aspect.width > 0 && aspect.height > 0) {
    // An unusual ratio (a panorama, a tall banner): the nearest format, unless it is far off.
    const distance = item => Math.abs(Math.log(aspect.width / aspect.height / item.ratio));
    const nearest = FORMATS.reduce((best, item) => (distance(item) < distance(best) ? item : best));
    if (distance(nearest) < Math.log(1.25)) format = nearest;
  }
  return format ? nearestSize(sizesFor(format, limits, family), pixels) : null;
}
const STAGE_KEYS = new Set(['prompt', 'stage', 'expandPrompt']);
/**
 * The resolved parameters the user may change before confirming, with the limits that apply:
 * the workflow's own bounds, « Fixe » as « Assistant » (0.6.102: a fixed value was given the wider
 * ones of its family), else those of its family.
 * `references`: the inputs of the proposal, when it has some to say (`input`: the slot of each).
 * A setting the engine only reads with an input that is not among them (the denoise of Krea 2
 * without an image to modify) is then no setting to change: it comes back with that input.
 */
export function editableParameters(workflow, parameters, { continues = false, references } = {}) {
  const pipeline = family(workflow.pipeline),
    profiled = new Set(Object.values(workflow.profiles ?? {}).flatMap(profile => Object.keys(profile.parameters))),
    // A character put in a video: the video made has the shape of the one it follows.
    follows = pipeline.tasks.includes('replace_character'),
    unread = references ? unreadParameters(workflow, references) : {};
  return Object.entries(parameters)
    .filter(
      ([key]) =>
        !STAGE_KEYS.has(key) &&
        pipeline.parameters[key] &&
        // Declared by the family, read by no engine of it (`attention` for Krea 2 and LTX 2.5):
        // greyed in the editor of the workflow, and no setting to change before a creation.
        !pipeline.parameters[key].unused &&
        !owns(unread, key) &&
        (owns(workflow.parameters, key) || profiled.has(key)) &&
        workflow.parameters[key]?.policy !== 'off',
    )
    .map(([key, value]) => {
      const policy = workflow.parameters[key],
        spec = policy ? effective(policy, pipeline.parameters[key]) : pipeline.parameters[key];
      const item = { key, value, type: spec.type };
      for (const bound of ['min', 'max', 'maxLength', 'multipleOf', 'choices', 'note'])
        if (spec[bound] !== undefined) item[bound] = spec[bound];
      // What the editor of the workflow says of the setting (`help`) is said here too.
      if (item.note === undefined && spec.help) item.note = spec.help;
      if (spec.exclusiveMin) item.exclusiveMin = true;
      if (continues && (key === 'width' || key === 'height'))
        item.locked = 'Une continuation garde la taille de sa vidéo source.';
      else if (follows && (key === 'width' || key === 'height')) {
        item.locked = 'La vidéo prend la forme de celle qu’elle suit.';
        item.follows = true;
      }
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
/**
 * The LoRA the subject references of a workflow depend on (the learned slots of LTX's MSR images):
 * the first one left to the model, in a workflow that takes such references. It is no setting
 * (16/11): its slots serve those images only, and on without them its pairs would still change
 * the video. It is on exactly when one of them is given; neither the user nor the model sees it.
 */
export function referenceLora(workflow) {
  const roles = family(workflow.pipeline).roles ?? {};
  if (!(workflow.references ?? []).some(slot => roles[slot.role]?.requiresLora)) return null;
  return (workflow.loras ?? []).find(lora => lora.enabled.policy === 'model') ?? null;
}
export function workflowSchema(workflow) {
  const properties = { workflow_id: { type: 'string', enum: [workflow.id] } },
    required = ['workflow_id'],
    pipeline = family(workflow.pipeline);
  // (0.6.94) What is made when nothing is given is said as the default (madePolicy, madeLora):
  // required only when nothing stands in for it.
  for (const [name, policy] of Object.entries(workflow.parameters))
    if (policy.policy === 'model') {
      const made = madePolicy(workflow, name);
      properties[name] = policySchema(made, pipeline.parameters[name]);
      if (!owns(made, 'default')) required.push(name);
    }
  // (0.6.102) No file is the model's to choose any more: « Assistant » left the files of the editor
  // (it was offered bare identifiers, and the Studio no choice at all). A workflow saved so makes its
  // default file (resolveNativeWorkflow, componentStandIn).
  const loras = {},
    bound = referenceLora(workflow);
  for (const lora of workflow.loras) {
    if (lora === bound) continue;
    if (lora.enabled.policy === 'off' || (lora.enabled.policy === 'fixed' && !lora.enabled.value)) continue;
    const writable = {},
      made = madeLora(lora, workflow.pipeline);
    if (lora.enabled.policy === 'model') writable.enabled = policySchema(made.enabled, { type: 'boolean' });
    if (lora.strength.policy === 'model') writable.strength = policySchema(made.strength, pipeline.loras.strength);
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

/**
 * (0.6.102) The parts of a workflow whose value or policy differ from one version to the next, as
 * the Studio shows them: each parameter by its name, each LoRA (`lora:<id>`), the draft and final
 * profiles (`profiles`). What is said to Moodix AI only (a description) is no part of it.
 */
export function changedParts(before, after) {
  const plainly = value => {
      if (!plain(value)) return canonical(value ?? null);
      const { description, ...rest } = value;
      return canonical(rest);
    },
    parts = [];
  for (const name of new Set([...Object.keys(before?.parameters ?? {}), ...Object.keys(after?.parameters ?? {})]))
    if (plainly(before?.parameters?.[name]) !== plainly(after?.parameters?.[name])) parts.push(name);
  const loras = list => new Map((list ?? []).map(lora => [lora.id, plainly(lora)]));
  const was = loras(before?.loras),
    now = loras(after?.loras);
  for (const id of new Set([...was.keys(), ...now.keys()])) if (was.get(id) !== now.get(id)) parts.push('lora:' + id);
  if (canonical(before?.profiles ?? null) !== canonical(after?.profiles ?? null)) parts.push('profiles');
  return parts;
}

/**
 * What a workflow does, apart from how it was stored: the file names added on save, an empty
 * reference description and the fields computed on listing do not count. Two workflows with
 * the same fingerprint behave the same.
 */
export function workflowFingerprint(input) {
  const { digest, ready, unavailableReason, automatic, builtin, customized, update, ...stored } = input;
  const plainCopy = JSON.parse(
    JSON.stringify(stored, (key, value) =>
      key === 'file' || (key === 'description' && value === '') ? undefined : value,
    ),
  );
  return createHash('sha256').update(canonical(plainCopy)).digest('hex');
}

async function regularJson(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw invalid('Workflow file must be a regular file');
  if (stat.size > MAX_BYTES) throw invalid('Workflow exceeds the 2 MiB size limit');
  const bytes = await readFile(path);
  if (bytes.length > MAX_BYTES) throw invalid('Workflow exceeds the 2 MiB size limit');
  return JSON.parse(bytes.toString('utf8'));
}

async function workflowFiles(directory) {
  if (!directory) return new Map();
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
  const files = new Map();
  for (const name of names.sort())
    if (name.endsWith('.json') && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name.slice(0, -5)))
      files.set(name.slice(0, -5), join(directory, name));
  return files;
}

const sameName = name => name.trim().toLocaleLowerCase('fr');

/**
 * Workflows from two places. `builtin` holds the ones shipped with Atelier: an update replaces
 * that folder. `directory` holds the user's own: the ones they created, and their edited
 * versions of shipped ones (same id). An update never touches those:
 * - a shipped workflow the user edited stays as edited, and is the only one listed: an update
 *   that changes the shipped version lists nothing beside it (0.6.126; until then it was listed
 *   as "… V2", which meant nothing on a page of models). What the new version adds and theirs
 *   lacks (a file) is found by itself; « Rétablir les réglages de Moodix » takes Moodix's again.
 *   A copy that can no longer be read hides nothing: the shipped one is listed in its place;
 * - a shipped workflow named like one of the user's is listed as "… V2" (then V3…);
 * - a shipped workflow the user deleted stays hidden until an update changes it.
 * What each edit was based on, and what was hidden, is kept in `statePath`.
 *
 * (0.6.117) `versions` (lib/model-versions.mjs): a shipped workflow, as shipped, is listed as it
 * is made with the version of its model the user keeps. One they edited, or an update listed
 * beside it, is left as written.
 */
export class NativeWorkflowCatalog {
  constructor(
    directory,
    { assets, capabilities = {}, builtin = null, statePath = null, historyPath = null, versions = null } = {},
  ) {
    if (typeof directory !== 'string' || !directory) throw invalid('Workflow directory is required');
    this.kind = 'native';
    this.directory = resolve(directory);
    this.builtin = builtin ? resolve(builtin) : null;
    this.statePath = statePath ? resolve(statePath) : null;
    this.historyPath = historyPath ? resolve(historyPath) : null;
    this.assets = assets;
    this.capabilities = capabilities;
    this.versions = versions;
    this.warnings = [];
  }
  /**
   * `strict`: null when the file is there but cannot be read, rather than an empty state. `changed`
   * (0.6.102): when the user last changed each part of each workflow (changedParts).
   */
  async #state({ strict = false } = {}) {
    if (!this.statePath) return { basedOn: {}, hidden: {}, changed: {} };
    try {
      const stored = JSON.parse(await readFile(this.statePath, 'utf8'));
      return {
        basedOn: plain(stored?.basedOn) ? stored.basedOn : {},
        hidden: plain(stored?.hidden) ? stored.hidden : {},
        changed: plain(stored?.changed) ? stored.changed : {},
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.warnings.push('Workflow state unreadable: ' + error.message);
        if (strict) return null;
      }
      return { basedOn: {}, hidden: {}, changed: {} };
    }
  }
  async #saveState({ basedOn, hidden, changed = {} }) {
    if (!this.statePath) return;
    await mkdir(dirname(this.statePath), { recursive: true });
    await atomicFile(
      this.statePath,
      JSON.stringify({ schemaVersion: 1, basedOn, hidden, ...(Object.keys(changed).length ? { changed } : {}) }, null, 2),
    );
  }
  /**
   * (0.6.102) The parts of a workflow the user just changed, at this time (`now`): the Studio of a
   * conversation shows the newer of such a change and the value of its last take (« le plus récent
   * des deux »).
   */
  #touch(state, id, before, after, now = Date.now()) {
    const parts = changedParts(before, after);
    if (!parts.length) return false;
    state.changed[id] = { ...state.changed[id], ...Object.fromEntries(parts.map(part => [part, now])) };
    return true;
  }
  /** When the user last changed each part of each workflow: { id: { part: time in ms } } (changedParts). */
  async changes() {
    return structuredClone((await this.#state()).changed);
  }
  async #readAt(path, id) {
    try {
      const workflow = validateNativeWorkflow(await regularJson(path));
      if (workflow.id !== id) throw invalid('Stored workflow id does not match its filename');
      return workflow;
    } catch (error) {
      if (error.code === 'ENOENT') throw invalid(`Workflow ${id} not found`);
      throw error;
    }
  }
  /** Every listed workflow, with where it comes from: user, customized, builtin or update. */
  async #entries() {
    const [users, shipped, state] = await Promise.all([
      workflowFiles(this.directory),
      workflowFiles(this.builtin),
      this.#state(),
    ]);
    const entries = [],
      skipped = [];
    // The user's copies that could be read: each stands for its model.
    const kept = new Set();
    for (const [id, path] of users)
      try {
        entries.push({
          id,
          kind: shipped.has(id) ? 'customized' : 'user',
          path,
          workflow: await this.#readAt(path, id),
        });
        kept.add(id);
      } catch (error) {
        skipped.push(`Skipped workflow ${id}.json: ${error.message}`);
      }
    const taken = new Set(entries.map(entry => sameName(entry.workflow.name)));
    for (const [id, path] of shipped) {
      let workflow;
      try {
        workflow = await this.#readAt(path, id);
      } catch (error) {
        skipped.push(`Skipped shipped workflow ${id}.json: ${error.message}`);
        continue;
      }
      const fingerprint = workflowFingerprint(workflow);
      const entryId = id,
        kind = 'builtin';
      // Edited by the user: theirs is the model's, whatever an update ships since.
      if (kept.has(id)) continue;
      if (state.hidden[entryId] === fingerprint) continue;
      let name = workflow.name;
      for (let version = 2; taken.has(sameName(name)); version++) name = `${workflow.name} V${version}`;
      taken.add(sameName(name));
      const listed =
        entryId === id && name === workflow.name
          ? workflow
          : validateNativeWorkflow({ ...workflow, id: entryId, name });
      const made = kind === 'builtin' && this.versions ? await this.versions.applied(listed) : listed;
      entries.push({ id: entryId, kind, path, origin: id, fingerprint, workflow: made });
    }
    return { entries, skipped, state, shipped };
  }
  async read(id) {
    identifier(id, 'workflow id');
    const { entries } = await this.#entries();
    // A creation made with a « V2 » of before 0.6.126 names it (the id of its workflow, a dash,
    // twelve digits of its fingerprint): it is the workflow of that id.
    const former = /^(.+)-[0-9a-f]{12}$/.exec(id)?.[1];
    const found =
      entries.find(entry => entry.id === id) ??
      entries.find(entry => entry.id === former && entry.kind !== 'user');
    if (!found) throw invalid(`Workflow ${id} not found`);
    return found.workflow;
  }
  /** The workflow of `id` as Moodix ships it, whatever the user keeps or edited; null when it ships none. */
  async shippedOf(id) {
    identifier(id, 'workflow id');
    const path = (await workflowFiles(this.builtin)).get(id);
    return path ? this.#readAt(path, id) : null;
  }
  async list() {
    const { entries, skipped } = await this.#entries();
    this.warnings = skipped;
    const workflows = [];
    for (const { kind, workflow } of entries) {
      const origin = {
        ...(kind !== 'user' ? { builtin: true } : {}),
        ...(kind === 'customized' ? { customized: true } : {}),
      };
      if (workflow.importDraft) {
        const { source, extras, ...summary } = workflow.importDraft;
        workflows.push({
          ...workflow,
          ...origin,
          importDraft: summary,
          importSummary: true,
          ready: false,
          unavailableReason: 'Brouillon importé · à vérifier avant activation',
        });
        continue;
      }
      let ready = false,
        unavailableReason = 'Moteur de génération indisponible pour cette famille.',
        // What this computer lacks whatever the files chosen (a card of a given maker): such a
        // workflow is shown greyed with its reason where the others are left out.
        lacking = false,
        // Only a file missing: a shipped workflow then offers to download it (53).
        missingFile = false,
        automatic = {};
      try {
        automatic = await checkAssets(workflow, this.assets);
        const capability = this.capabilities[workflow.pipeline];
        // (0.6.94) Whether it can be made here, whether or not Moodix AI is offered it: « Disponible
        // pour l’assistant » (`enabled`) only takes it out of the assistant's tools (ToolCatalog),
        // never out of the Studio. Unticked, it was gone from both.
        ready = capability === true || capability?.ready === true;
        if (!ready) {
          unavailableReason = capability?.reason || unavailableReason;
          lacking = capability?.hardware === true;
        }
      } catch (error) {
        unavailableReason = error.message;
        missingFile = error.missing === true && workflow.enabled;
      }
      workflows.push({
        ...workflow,
        ...origin,
        ready,
        ...(!ready ? { unavailableReason } : {}),
        ...(lacking ? { unavailableKind: 'hardware' } : missingFile ? { unavailableKind: 'files' } : {}),
        // The files taken from the folders of the settings, for the editor to name them.
        ...(Object.keys(automatic).length ? { automatic } : {}),
      });
    }
    return workflows;
  }
  /** Shipped workflows the user deleted, still hidden. */
  async hiddenCount() {
    const { state, shipped } = await this.#entries();
    return Object.keys(state.hidden).filter(id => shipped.has(id) || shipped.has(id.slice(0, -13))).length;
  }
  async save(input) {
    const workflow = validateNativeWorkflow(input);
    if (!workflow.importDraft) await checkAssets(workflow, this.assets);
    // Saved workflows name their files too, so they keep working once shared or moved.
    for (const policy of Object.values(workflow.components)) {
      if (policy.policy !== 'fixed' || typeof this.assets?.read !== 'function') continue;
      const asset = await this.assets.read(policy.asset).catch(() => null);
      if (asset) policy.file = basename(asset.path);
    }
    const { entries, state, shipped } = await this.#entries();
    const previous = entries.find(entry => entry.id === workflow.id);
    // (0.6.102) What the user changes, and when (changedParts): kept with the record of the saves.
    let dirty = previous ? this.#touch(state, workflow.id, previous.workflow, workflow) : false;
    // Saving a shipped workflow unchanged keeps it shipped: it goes on following updates.
    if (shipped.has(workflow.id)) {
      const original = await this.#readAt(shipped.get(workflow.id), workflow.id);
      const fingerprint = workflowFingerprint(original);
      if (workflowFingerprint(workflow) === fingerprint) {
        await rm(join(this.directory, `${workflow.id}.json`), { force: true });
        delete state.basedOn[workflow.id];
        await this.#saveState(state);
        return original;
      }
      if (!state.basedOn[workflow.id] || previous?.kind === 'builtin') {
        state.basedOn[workflow.id] = fingerprint;
        dirty = true;
      }
    }
    if (dirty) await this.#saveState(state);
    await mkdir(this.directory, { recursive: true });
    const { digest, ...stored } = workflow;
    await atomicFile(join(this.directory, `${workflow.id}.json`), JSON.stringify(stored, null, 2));
    return workflow;
  }
  /** Deletes a user's workflow; a shipped one is hidden until an update changes it. */
  async remove(id) {
    identifier(id, 'workflow id');
    const { entries, state } = await this.#entries();
    const entry = entries.find(item => item.id === id);
    if (!entry) return;
    if (entry.kind === 'user' || entry.kind === 'customized')
      await rm(join(this.directory, `${id}.json`), { force: true });
    if (entry.kind === 'customized') {
      const original = await this.#readAt(join(this.builtin, `${id}.json`), id);
      state.hidden[id] = workflowFingerprint(original);
      delete state.basedOn[id];
    } else if (entry.kind === 'builtin') state.hidden[id] = entry.fingerprint;
    if (entry.kind !== 'user') await this.#saveState(state);
  }
  /** A shipped workflow the user edited goes back to the shipped version. */
  async reset(id) {
    identifier(id, 'workflow id');
    const { entries, state } = await this.#entries();
    const entry = entries.find(item => item.id === id);
    if (entry?.kind !== 'customized') throw invalid('Seul un workflow fourni et modifié peut être rétabli.');
    // (0.6.102) What « Rétablir » changes back is a change of the user's too (changedParts).
    const original = await this.#readAt(join(this.builtin, `${id}.json`), id).catch(() => null);
    if (original) this.#touch(state, id, entry.workflow, original);
    await rm(join(this.directory, `${id}.json`), { force: true });
    delete state.basedOn[id];
    await this.#saveState(state);
  }
  /** Shows the shipped workflows the user deleted again. */
  async unhide() {
    const state = await this.#state();
    await this.#saveState({ ...state, hidden: {} });
  }
  /**
   * Copies of shipped workflows left in the user's folder by earlier versions (where the two
   * shared one folder): an unedited copy, identical to a version Atelier shipped, is removed so
   * that workflow follows updates again. An edited one stays, based on the current version.
   * (0.6.94) A copy the user saved is never removed, whatever it holds: each of their saves is
   * recorded with what it was based on (`basedOn`, by save(); here too, for a copy kept once).
   * Identical to a version shipped before (Krea 2 with its denoise « Fixe » at 0,6, 0,75 or 1 is, to
   * the byte, the Krea 2 of 0.6.69, of 0.6.68 or of an earlier one), it was deleted at the next start
   * and the shipped one came back. Only a copy no save ever recorded is compared with the versions
   * shipped, and nothing is removed while that record cannot be read.
   */
  async adoptShipped() {
    if (!this.builtin) return { removed: [], kept: [] };
    let history = {};
    if (this.historyPath)
      try {
        history = JSON.parse(await readFile(this.historyPath, 'utf8')).workflows || {};
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    const [users, shipped, state] = await Promise.all([
      workflowFiles(this.directory),
      workflowFiles(this.builtin),
      this.#state({ strict: true }),
    ]);
    if (!state) return { removed: [], kept: [] };
    const removed = [],
      kept = [];
    let changed = false;
    for (const [id, path] of users) {
      if (!shipped.has(id)) continue;
      // Saved by the user (or kept as theirs once already): theirs, never compared.
      if (owns(state.basedOn, id)) {
        kept.push(id);
        continue;
      }
      let mine, original;
      try {
        mine = await regularJson(path);
        original = await this.#readAt(shipped.get(id), id);
      } catch {
        continue;
      }
      const known = new Set([workflowFingerprint(original), ...(history[id] || [])]);
      changed = true;
      if (known.has(workflowFingerprint(mine))) {
        await rm(path, { force: true });
        removed.push(id);
      } else {
        state.basedOn[id] = workflowFingerprint(original);
        kept.push(id);
      }
    }
    if (changed) await this.#saveState(state);
    return { removed, kept };
  }
  async prepare(id, args, options = {}) {
    const workflow = await this.read(id);
    return { workflow, job: await resolveNativeWorkflow(workflow, args, this.assets, options), outputNodes: [] };
  }
}
