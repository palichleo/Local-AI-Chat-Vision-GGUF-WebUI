import { readFileSync } from 'node:fs';
import { problem } from './engine.mjs';
import { family } from './families.mjs';
import { policySchema, workflowSchema } from './native-workflows.mjs';

/**
 * The language model sees a few intent verbs (tasks.json) instead of one tool per workflow.
 * It passes a prompt and assigns images or videos to roles (source, start_image, reference…);
 * the router then picks the enabled workflow whose reference slots match those roles.
 * Verbs, roles, parameters and descriptions are all derived from tasks.json, the family
 * manifests and the user's workflows: adding a workflow or a family adds or extends tools.
 */
export const TASKS = JSON.parse(readFileSync(new URL('./tasks.json', import.meta.url), 'utf8'));
const RESERVED = new Set(['workflow', 'prompt', 'intention', 'reuse_output', 'loras', 'components']);
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

  isGenerationTool(name) {
    return Object.hasOwn(TASKS, name);
  }

  async #serving(name) {
    return (await this.workflows.list()).filter(workflow => workflow.ready && serves(workflow, name));
  }

  /** One tool per verb that at least one ready workflow can perform. */
  async definitions() {
    const tools = [];
    for (const name of Object.keys(TASKS)) {
      const serving = await this.#serving(name);
      if (serving.length) tools.push(this.#definition(name, serving));
    }
    return tools;
  }

  #definition(name, serving) {
    const task = TASKS[name],
      properties = {},
      required = [];
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
      properties[role] = spec.many
        ? { type: 'array', items: sourceSchema, maxItems: capacity, description: spec.description }
        : { ...sourceSchema, description: spec.description };
      if (spec.required) required.push(role);
    }
    if (serving.length > 1)
      properties.workflow = {
        type: 'string',
        enum: serving.map(workflow => workflow.id),
        description:
          'Optional: force one of the workflows listed above. Omit it to let the application pick the best match.',
      };
    const owners = {};
    for (const workflow of serving) {
      const manifest = family(workflow.pipeline);
      for (const [key, policy] of Object.entries(workflow.parameters)) {
        if (key === 'prompt' || policy.policy !== 'model' || RESERVED.has(key) || Object.hasOwn(task.roles, key))
          continue;
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
    if (serving.some(workflow => workflow.profiles?.final))
      properties.reuse_output = {
        type: 'string',
        description:
          'run_id of an approved draft to render again with the final profile; pass only reuse_output, stage=final and intention.',
      };
    const list = serving
      .map(
        workflow =>
          `- ${workflow.id}: ${workflow.name}. ${workflow.description} (accepts: ${accepted(workflow, name)})`,
      )
      .join('\n');
    return {
      type: 'function',
      function: {
        name,
        description: `${task.summary} ${task.guidance}\nWorkflows:\n${list}\nSources: {"image": n} is the n-th image the user attached in this conversation (0 = first); {"resource": "id"} an active resource; {"output": "run_id"} an earlier result of this conversation.`,
        parameters: { type: 'object', properties, required, additionalProperties: false },
      },
    };
  }

  /**
   * Picks the workflow for one verb call and converts the call into that workflow's arguments.
   * `mediaOf(source)` returns 'image', 'video' or 'audio' for a source object.
   */
  async route(name, args, { mediaOf }) {
    const task = TASKS[name];
    if (!task) throw problem('Outil de génération inconnu.', 400);
    const known = new Set([...RESERVED, ...Object.keys(task.roles)]);
    const provided = sources(name, args);
    for (const list of Object.values(provided)) for (const source of list) source.media = await mediaOf(source);
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
      else if (!best || result.unused < best.result.unused) best = { workflow, result };
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
    for (const key of ['intention', 'loras', 'components']) if (args[key] !== undefined) routed[key] = args[key];
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
