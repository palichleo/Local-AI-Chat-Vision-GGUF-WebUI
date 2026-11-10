import { readFileSync } from 'node:fs';
import { problem } from './engine.mjs';
import { family } from './families.mjs';
import { effective, policySchema, workflowSchema } from './native-workflows.mjs';

/**
 * The language model sees a few intent verbs (tasks.json) instead of one tool per workflow.
 * It passes a prompt and assigns images or videos to roles (source, start_image, reference…);
 * the router then picks the enabled workflow whose reference slots match those roles.
 * Verbs, roles, parameters and descriptions are all derived from tasks.json, the family
 * manifests and the user's workflows: adding a workflow or a family adds or extends tools.
 */
export const TASKS = JSON.parse(readFileSync(new URL('./tasks.json', import.meta.url), 'utf8'));
const RESERVED = new Set(['workflow', 'prompt', 'intention', 'reuse_output', 'loras', 'components', 'duration']);
const SOURCE_KEYS = ['image', 'resource', 'frame', 'output', 'index'];

const sourceSchema = {
  type: 'object',
  properties: {
    image: { type: 'integer', minimum: 0, description: 'Position of an image the user attached (0 = first).' },
    resource: { type: 'string', description: 'ID of an active resource.' },
    frame: { type: 'integer', minimum: 0, maximum: 2, description: 'Frame of a video resource used as an image.' },
    output: { type: 'string', description: 'run_id of an earlier result in this conversation.' },
    index: { type: 'integer', minimum: 0, description: 'Output position within that run (default 0).' },
  },
  additionalProperties: false,
};

/**
 * Source schema restricted to what the conversation can actually reference: attached images
 * (by position), active resources and earlier native results (by enumerated ID). Each variant
 * requires its key, so a constrained decoder can neither leave a source empty nor invent an ID.
 * Returns null when nothing of a compatible media exists.
 */
function availableSourceSchema(media, available) {
  const variants = [];
  if (media.includes('image') && available.images > 0)
    variants.push({
      type: 'object',
      properties: { image: { ...sourceSchema.properties.image, maximum: available.images - 1 } },
      required: ['image'],
      additionalProperties: false,
    });
  // A video resource can stand in for an image through one of its frames.
  const resources = available.resources.filter(
    item => media.includes(item.type) || (item.type === 'video' && media.includes('image')),
  );
  if (resources.length)
    variants.push({
      type: 'object',
      properties: {
        resource: { type: 'string', enum: resources.map(item => item.id), description: 'ID of an active resource.' },
        ...(resources.some(item => item.type === 'video') ? { frame: sourceSchema.properties.frame } : {}),
      },
      required: ['resource'],
      additionalProperties: false,
    });
  const outputs = available.outputs.filter(item => media.includes(item.mediaType));
  if (outputs.length)
    variants.push({
      type: 'object',
      properties: {
        output: {
          type: 'string',
          enum: outputs.map(item => item.id),
          description: 'run_id of an earlier result in this conversation.',
        },
        index: { ...sourceSchema.properties.index, maximum: Math.max(...outputs.map(item => item.count)) - 1 },
      },
      required: ['output'],
      additionalProperties: false,
    });
  if (!variants.length) return null;
  return variants.length === 1 ? variants[0] : { anyOf: variants };
}

/** Normalizes the caller's description of referenceable sources, or null to advertise them generically. */
function availability(available) {
  if (available === undefined) return null;
  const list = value => (Array.isArray(value) ? value : []);
  return {
    images: Number.isInteger(available.images) && available.images > 0 ? available.images : 0,
    resources: list(available.resources).filter(item => typeof item?.id === 'string'),
    outputs: list(available.outputs).filter(
      item => typeof item?.id === 'string' && Number.isInteger(item.count) && item.count > 0,
    ),
  };
}

/** Whether the model may choose this workflow's clip length (its frame count is a model choice). */
const timed = workflow => workflow.mediaType === 'video' && workflow.parameters.frames?.policy === 'model';
const fpsOf = workflow =>
  workflow.parameters.fps?.value ?? workflow.profiles?.draft?.parameters.fps ?? workflow.parameters.fps?.default ?? 24;

/**
 * The frame count closest to `seconds` (of new footage for a continuation, which also re-renders
 * `overlap` frames of its source) among those the workflow allows, and the length it gives.
 */
export function framesFor(workflow, seconds, { continuation = false } = {}) {
  const manifest = family(workflow.pipeline),
    spec = effective(workflow.parameters.frames, manifest.parameters.frames),
    fps = fpsOf(workflow),
    overlap = continuation
      ? (workflow.parameters.overlap_frames?.value ??
        workflow.parameters.overlap_frames?.default ??
        manifest.parameters.overlap_frames?.choices?.[0] ??
        0)
      : 0;
  let choices = spec.choices;
  if (!choices) {
    const step = spec.multipleOf || 1,
      low = Math.ceil((spec.min ?? 1) / step) * step,
      high = spec.max ?? low + 600 * step;
    choices = [];
    for (let value = low; value <= high && choices.length < 4096; value += step) choices.push(value);
  }
  const length = frames => (frames - overlap) / fps;
  const frames = choices
    .filter(value => value > overlap)
    .reduce((best, value) => {
      const gap = Math.abs(length(value) - seconds),
        bestGap = Math.abs(length(best) - seconds);
      return gap < bestGap - 1e-9 || (Math.abs(gap - bestGap) <= 1e-9 && value > best) ? value : best;
    });
  return { frames, seconds: length(frames) };
}

const slotsFor = (workflow, role) =>
  workflow.references.filter(slot => family(workflow.pipeline).roles[slot.role]?.as === role);
const slotMedia = (workflow, slot) => family(workflow.pipeline).roles[slot.role].media;

/** Whether a workflow can perform a verb at all, independently of the sources provided. */
export function serves(workflow, name) {
  const task = TASKS[name],
    manifest = family(workflow.pipeline);
  if (!task || !manifest.tasks.includes(name)) return false;
  if (task.output !== 'source' && task.output !== manifest.mediaType) return false;
  for (const [role, spec] of Object.entries(task.roles))
    if (spec.required && !slotsFor(workflow, role).some(slot => spec.media.includes(slotMedia(workflow, slot))))
      return false;
  // A required slot outside this verb's roles (a mandatory source video, say) excludes the workflow.
  return workflow.references.every(slot => !slot.required || Object.hasOwn(task.roles, manifest.roles[slot.role].as));
}

function sources(name, args) {
  const assigned = {};
  for (const [role, spec] of Object.entries(TASKS[name].roles)) {
    if (args[role] === undefined) {
      if (spec.required) throw problem(`${name} needs a ${role}: ${spec.description}`);
      continue;
    }
    const list = spec.many ? args[role] : [args[role]];
    if (!Array.isArray(list) || list.length > 64)
      throw problem(`${role} must be ${spec.many ? 'a list of sources' : 'one source'}.`);
    for (const source of list) {
      const kinds = ['image', 'resource', 'output'].filter(key => source?.[key] !== undefined);
      if (
        !source ||
        typeof source !== 'object' ||
        Array.isArray(source) ||
        Object.keys(source).some(key => !SOURCE_KEYS.includes(key)) ||
        kinds.length !== 1
      )
        throw problem(`Each ${role} needs exactly one of image, resource or output.`);
    }
    if (list.length) assigned[role] = list;
  }
  return assigned;
}

/** Assigns each provided source to a compatible slot of the workflow, or explains why it cannot. */
function assign(workflow, provided) {
  const used = new Set(),
    references = [];
  for (const [role, list] of Object.entries(provided))
    for (const source of list) {
      const slot = slotsFor(workflow, role).find(
        slot => !used.has(slot.id) && slotMedia(workflow, slot) === source.media,
      );
      if (!slot) return { error: `no free ${source.media} slot for ${role}` };
      used.add(slot.id);
      const reference = { input: slot.id };
      if (source.image !== undefined) reference.image = source.image;
      if (source.resource !== undefined) {
        reference.resource_id = source.resource;
        if (source.frame !== undefined) reference.frame = source.frame;
      }
      if (source.output !== undefined) {
        reference.output_id = source.output;
        if (source.index !== undefined) reference.output_index = source.index;
      }
      references.push(reference);
    }
  const missing = workflow.references.find(slot => slot.required && !used.has(slot.id));
  if (missing) return { error: `${missing.name || missing.id} is required` };
  return { references, unused: workflow.references.length - used.size };
}

function accepted(workflow, name) {
  const roles = Object.keys(TASKS[name].roles).filter(role => slotsFor(workflow, role).length);
  return roles.length ? roles.join(', ') : 'prompt only';
}

export class ToolCatalog {
  constructor(workflows) {
    this.workflows = workflows;
  }

  /** Media each output button can act on now: { upscale: ['image', 'video'], interpolate: [...], ... }. */
  async actions() {
    const result = {};
    for (const name of ['upscale', 'interpolate', 'extend_video']) {
      const media = new Set();
      for (const workflow of await this.#serving(name))
        for (const slot of slotsFor(workflow, 'source')) media.add(slotMedia(workflow, slot));
      result[name] = [...media];
    }
    return result;
  }

  isGenerationTool(name) {
    return Object.hasOwn(TASKS, name);
  }

  async #serving(name) {
    return (await this.workflows.list()).filter(workflow => workflow.ready && serves(workflow, name));
  }

  /**
   * One tool per verb that at least one ready workflow can perform.
   * `available` ({ images, resources: [{ id, type }], outputs: [{ id, mediaType, count, workflowId, draft }] })
   * describes what the current conversation can reference. When given, source roles only offer
   * those sources, with their IDs enumerated, and a verb whose required source has nothing to
   * point to is not offered at all: a model must never be asked for an ID that does not exist.
   */
  async definitions(available) {
    const context = availability(available);
    const tools = [];
    for (const name of Object.keys(TASKS)) {
      const serving = await this.#serving(name);
      const definition = serving.length ? this.#definition(name, serving, context) : null;
      if (definition) tools.push(definition);
    }
    return tools;
  }

  #definition(name, serving, available) {
    const task = TASKS[name],
      properties = {},
      required = [],
      offered = new Set();
    const video = serving.some(workflow => workflow.mediaType === 'video');
    if (task.prompt && serving.some(workflow => workflow.parameters.prompt?.policy === 'model')) {
      properties.prompt = { type: 'string', minLength: 1, maxLength: 8000, description: task.prompt };
      if (
        serving.every(
          workflow =>
            workflow.parameters.prompt?.policy === 'model' && !Object.hasOwn(workflow.parameters.prompt, 'default'),
        )
      )
        required.push('prompt');
    }
    for (const [role, spec] of Object.entries(task.roles)) {
      const capacity = Math.max(0, ...serving.map(workflow => slotsFor(workflow, role).length));
      if (!capacity) continue;
      const schema = available ? availableSourceSchema(spec.media, available) : sourceSchema;
      if (!schema) {
        // Nothing in this conversation can fill a required role: the verb cannot run yet.
        if (spec.required) return null;
        continue;
      }
      for (const variant of schema.anyOf || [schema])
        for (const key of ['image', 'resource', 'output']) if (variant.properties[key]) offered.add(key);
      properties[role] = spec.many
        ? { type: 'array', items: schema, maxItems: capacity, description: spec.description }
        : { ...schema, description: spec.description };
      if (spec.required) required.push(role);
    }
    if (serving.length > 1)
      properties.workflow = {
        type: 'string',
        enum: serving.map(workflow => workflow.id),
        description:
          'Optional: force one of the workflows listed above. Omit it to let the application pick the best match.',
      };
    const durations = serving.filter(timed);
    if (task.output === 'video' && durations.length) {
      // Always asked for, so a length the user gave ("3 secondes") is not left in the prompt:
      // the model states it, or null for the workflow's own default.
      const always = durations.length === serving.length;
      properties.duration = {
        type: always ? ['number', 'null'] : 'number',
        minimum: 0.5,
        maximum: 120,
        description:
          (name === 'extend_video'
            ? 'Seconds of new footage to add after the source video: the length the user asked for'
            : 'Clip length in seconds: the length the user asked for') +
          (always ? ', or null when they gave none.' : ', if they gave one.') +
          ' Never write the length in the prompt. Rounded to the closest length the workflow allows' +
          (always ? '' : ` (only for: ${durations.map(workflow => workflow.id).join(', ')})`) +
          '.',
      };
      if (always) required.push('duration');
    }
    const owners = {};
    for (const workflow of serving) {
      const manifest = family(workflow.pipeline);
      for (const [key, policy] of Object.entries(workflow.parameters)) {
        if (key === 'prompt' || policy.policy !== 'model' || RESERVED.has(key) || Object.hasOwn(task.roles, key))
          continue;
        // The clip length is asked in seconds (duration), not as a frame count.
        if (key === 'frames' && properties.duration) continue;
        (owners[key] ??= []).push(workflow.id);
        properties[key] ??= policySchema(policy, manifest.parameters[key]);
      }
      const schema = workflowSchema(workflow).properties;
      for (const key of ['loras', 'components'])
        if (schema[key])
          properties[key] = {
            ...schema[key],
            properties: { ...properties[key]?.properties, ...schema[key].properties },
          };
    }
    for (const [key, ids] of Object.entries(owners))
      if (ids.length < serving.length)
        properties[key].description = [properties[key].description, `Only for: ${ids.join(', ')}.`]
          .filter(Boolean)
          .join(' ');
    if (task.output === 'video' || (task.output === 'source' && video)) {
      properties.intention = {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
        description: 'One or two sentences explaining the proposal to the user, who must confirm every video.',
      };
      if (task.output === 'video') required.push('intention');
    }
    const finals = serving.filter(workflow => workflow.profiles?.final).map(workflow => workflow.id);
    const drafts = available?.outputs.filter(item => item.draft && finals.includes(item.workflowId));
    if (finals.length && (!available || drafts.length))
      properties.reuse_output = {
        type: 'string',
        ...(available ? { enum: drafts.map(item => item.id) } : {}),
        description:
          'run_id of an approved draft to render again with the final profile; pass only reuse_output, stage=final and intention.',
      };
    const list = serving
      .map(
        workflow =>
          `- ${workflow.id}: ${workflow.name}. ${workflow.description} (accepts: ${accepted(workflow, name)})`,
      )
      .join('\n');
    const kinds = [
      ['image', '{"image": n} is the n-th image the user attached in this conversation (0 = first)'],
      ['resource', '{"resource": "id"} an active resource'],
      ['output', '{"output": "run_id"} an earlier result of this conversation'],
    ].filter(([key]) => offered.has(key));
    const sources = kinds.length ? `\nSources: ${kinds.map(([, text]) => text).join('; ')}.` : '';
    return {
      type: 'function',
      function: {
        name,
        description: `${task.summary} ${task.guidance}\nWorkflows:\n${list}${sources}`,
        parameters: { type: 'object', properties, required, additionalProperties: false },
      },
    };
  }

  /**
   * Picks the workflow for one verb call and converts the call into that workflow's arguments.
   * `mediaOf(source)` returns 'image', 'video' or 'audio' for a source object.
   * `originOf(source)`, when given, returns `{ workflowId, pipeline }` for an earlier result (or null):
   * a workflow that produced a source, or at least one of the same model family, is preferred
   * over a more specific one, so a continuation stays in the model that made the clip.
   */
  async route(name, args, { mediaOf, originOf }) {
    const task = TASKS[name];
    if (!task) throw problem('Outil de génération inconnu.', 400);
    const known = new Set([...RESERVED, ...Object.keys(task.roles)]);
    const provided = sources(name, args);
    for (const list of Object.values(provided)) for (const source of list) source.media = await mediaOf(source);
    const origins = [];
    if (originOf)
      for (const list of Object.values(provided))
        for (const source of list) {
          if (source.output === undefined) continue;
          const origin = await originOf(source);
          if (origin) origins.push(origin);
        }
    const affinity = workflow =>
      Math.max(
        0,
        ...origins.map(origin =>
          origin.workflowId === workflow.id ? 2 : origin.pipeline && origin.pipeline === workflow.pipeline ? 1 : 0,
        ),
      );
    let serving = await this.#serving(name);
    if (args.workflow !== undefined) {
      serving = serving.filter(workflow => workflow.id === args.workflow);
      if (!serving.length) throw problem(`Le workflow ${args.workflow} ne peut pas exécuter ${name}.`, 400);
    }
    const reasons = [];
    let best;
    for (const workflow of serving) {
      // Upscaling keeps the media type: an image source needs an image workflow.
      if (task.output === 'source' && provided.source && workflow.mediaType !== provided.source[0].media) {
        reasons.push(`${workflow.id}: ${workflow.mediaType} only`);
        continue;
      }
      const result = assign(workflow, provided);
      if (result.error) reasons.push(`${workflow.id}: ${result.error}`);
      else {
        // Origin of the source first, then the family the manifest prefers (SeedVR2 over
        // Real-ESRGAN for images), then the most specific workflow.
        const rank = [affinity(workflow), family(workflow.pipeline).preference ?? 0, -result.unused];
        const first = best ? rank.findIndex((value, i) => value !== best.rank[i]) : -1;
        if (!best || (first >= 0 && rank[first] > best.rank[first])) best = { workflow, result, rank };
      }
    }
    if (!best)
      throw problem(
        `Aucun workflow ne correspond à ces entrées pour ${name}. ${reasons.join('; ') || 'Aucun workflow actif.'}`,
        400,
      );
    const { workflow, result } = best,
      routed = { workflow_id: workflow.id },
      notes = [];
    if (args.prompt !== undefined) routed.prompt = args.prompt;
    if (args.duration !== undefined && args.duration !== null) {
      if (
        typeof args.duration !== 'number' ||
        !Number.isFinite(args.duration) ||
        args.duration <= 0 ||
        args.duration > 120
      )
        throw problem('duration doit être un nombre de secondes entre 0 et 120.', 400);
      if (!timed(workflow)) notes.push(`duration ignored: ${workflow.name} sets the clip length`);
      else {
        const continuation = name === 'extend_video';
        const { frames, seconds } = framesFor(workflow, args.duration, { continuation });
        routed.frames = frames;
        if (Math.abs(seconds - args.duration) > 0.05)
          notes.push(
            `duration ${args.duration} s → ${seconds.toFixed(2)} s${continuation ? ' added' : ''}: the closest length ${workflow.name} allows`,
          );
      }
    }
    for (const key of ['loras', 'components']) if (args[key] !== undefined) routed[key] = args[key];
    // An intention only exists for video proposals; an image workflow rejects it.
    if (workflow.mediaType === 'video' && args.intention !== undefined) routed.intention = args.intention;
    // Upscaling or smoothing a video still goes through the video confirmation, which shows an intention.
    if (workflow.mediaType === 'video' && routed.intention === undefined) routed.intention = task.summary;
    for (const [key, value] of Object.entries(args)) {
      if (known.has(key)) continue;
      if (workflow.parameters[key]?.policy === 'model') routed[key] = value;
      else if (Object.hasOwn(family(workflow.pipeline).parameters, key))
        notes.push(`${key} ignored: set by workflow ${workflow.name}`);
      else throw problem(`${name} n’accepte pas l’argument ${key}.`, 400);
    }
    if (result.references.length) routed.references = result.references;
    return { workflow, args: routed, notes };
  }
}
