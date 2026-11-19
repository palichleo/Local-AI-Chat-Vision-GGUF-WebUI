import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { problem } from './engine.mjs';
import { family } from './families.mjs';
import {
  componentStandIn,
  effective,
  madeLora,
  madePolicy,
  onlyRoles,
  policySchema,
  referenceLora,
  unreadParameters,
  workflowSchema,
} from './native-workflows.mjs';
import { FORMATS } from '../public/formats.mjs';
import { SETTING_NAMES } from '../public/setting-names.mjs';
import { CAPABLE, RAILS } from './model-wording.mjs';

/**
 * The language model sees a few intent verbs (tasks.json) instead of one tool per workflow.
 * It passes a prompt and assigns images or videos to roles (source, start_image, reference…);
 * the router then picks the enabled workflow whose reference slots match those roles.
 * Verbs, roles, parameters and descriptions are all derived from tasks.json, the family
 * manifests and the user's workflows: adding a workflow or a family adds or extends tools.
 */
export const TASKS = JSON.parse(readFileSync(new URL('./tasks.json', import.meta.url), 'utf8'));
/**
 * The words of the verbs for a capable model (lib/model-wording.mjs): what tasks.json says to the
 * small local model (a plan agreed in words before a video, limits of lines), said as a contract.
 * Only words: the roles, their media and what is required stay those of tasks.json.
 */
const CAPABLE_TASKS = JSON.parse(readFileSync(new URL('./tasks-capable.json', import.meta.url), 'utf8'));
function capableTask(name) {
  const task = TASKS[name],
    words = CAPABLE_TASKS[name] ?? {};
  const described = (specs, own) =>
    Object.fromEntries(
      Object.entries(specs ?? {}).map(([key, spec]) => [
        key,
        { ...spec, ...(own?.[key]?.description ? { description: own[key].description } : {}) },
      ]),
    );
  return {
    ...task,
    ...(words.summary ? { summary: words.summary } : {}),
    ...(words.guidance ? { guidance: words.guidance } : {}),
    ...(words.prompt ? { prompt: words.prompt } : {}),
    roles: described(task.roles, words.roles),
    ...(task.arguments ? { arguments: described(task.arguments, words.arguments) } : {}),
  };
}
// Settings a family leaves to the model without saying what they are: said to a capable model.
const CAPABLE_SETTINGS = {
  stage:
    'draft: a quick preview, smaller, to check the motion; final: full size and quality, several times slower. Leave it out for a draft; final only when the user asks for the final version.',
  width: 'Width in pixels, only when the user asks for a size or a shape. Omit it otherwise.',
  height: 'Height in pixels, only when the user asks for a size or a shape. Omit it otherwise.',
};
const RESERVED = new Set([
  'workflow',
  'prompt',
  'intention',
  'reuse_output',
  'loras',
  'components',
  'duration',
  'seed',
  'format',
]);
// `conversation`: an earlier result of another conversation of the project (the Sortie of the
// Studio is the project's), never offered to the model.
const SOURCE_KEYS = ['image', 'resource', 'frame', 'output', 'index', 'conversation'];
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
// `frame` by name: the exact first or last image of a video (a take, a video reference), where an
// image is taken. Offered to a capable model only; accepted from any (ToolRuntime, stills).
export const STILL_FRAMES = ['first', 'last'];
/** The roles of a verb that take an image: where a frame of a video stands in for one. */
export const imageRoles = name =>
  Object.entries(TASKS[name]?.roles ?? {})
    .filter(([, spec]) => spec.media.includes('image'))
    .map(([role]) => role);
// A take of the project by its number, « PRISE n »: the application finds it (server.mjs, withTakes).
const TAKE = 'Number of a take of this project, as the user sees it (« PRISE 12 », « la prise 12 »).';

const sourceSchema = {
  type: 'object',
  properties: {
    image: { type: 'integer', minimum: 0, description: 'Position of an image the user attached (0 = first).' },
    resource: { type: 'string', description: 'ID of an active resource.' },
    frame: { type: 'integer', minimum: 0, maximum: 2, description: 'Frame of a video resource used as an image.' },
    output: { type: 'string', description: 'run_id of an earlier result in this conversation.' },
    index: { type: 'integer', minimum: 0, description: 'Output position within that run (default 0).' },
    take: { type: 'integer', minimum: 1, description: TAKE },
  },
  additionalProperties: false,
};

/**
 * The sources of a capable model (lib/model-wording.mjs): the same for every request of every
 * conversation, so that the definitions stay in the cache of the provider. Takes and references by
 * their numbers, as the user names them; the application finds them in the project (server.mjs,
 * withTakes and refsToIds) and answers a number that is none. No list of identifiers: on 0.6.43 the
 * definitions changed with each project and each creation, and the cache with them.
 */
// (Said once in the description of the tool, « Sources: », not in each of its roles: a dozen roles
// repeated the same words, 1 300 tokens of every request.)
const capableSourceSchema = {
  type: 'object',
  properties: {
    take: { type: 'integer', minimum: 1 },
    ref: { type: 'integer', minimum: 1 },
    // An image of a video used as an image: its exact first or last one (of a take or a reference,
    // kept as a reference of the project: ToolRuntime, stills), or a sample of a video reference.
    frame: {
      anyOf: [
        { type: 'string', enum: STILL_FRAMES },
        { type: 'integer', minimum: 0, maximum: 2 },
      ],
    },
    image: { type: 'integer', minimum: 0 },
    output: { type: 'string' },
    index: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
};
const capableWholeSchema = {
  ...capableSourceSchema,
  properties: Object.fromEntries(Object.entries(capableSourceSchema.properties).filter(([key]) => key !== 'frame')),
};

/** A source for a role that takes a video whole: no frame of it to name. */
const wholeSourceSchema = {
  ...sourceSchema,
  properties: Object.fromEntries(Object.entries(sourceSchema.properties).filter(([key]) => key !== 'frame')),
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
        // A frame of a video stands in for an image: a role that takes the video itself is not
        // offered one (named there, the video became an image and the call was refused).
        ...(media.includes('image') && resources.some(item => item.type === 'video')
          ? { frame: sourceSchema.properties.frame }
          : {}),
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
  // The takes of the project by their number, those of this conversation and of the others.
  const takes = available.takes.filter(item => media.includes(item.mediaType));
  if (takes.length)
    variants.push({
      type: 'object',
      properties: { take: { type: 'integer', enum: takes.map(item => item.take), description: TAKE } },
      required: ['take'],
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
    takes: list(available.takes).filter(item => Number.isInteger(item?.take) && typeof item.mediaType === 'string'),
  };
}

/** Workflows of different families that each say what they are the one for. */
const chosen = serving =>
  serving.length > 1 &&
  serving.every(workflow => family(workflow.pipeline).chooseFor) &&
  new Set(serving.map(workflow => workflow.pipeline)).size > 1;
/**
 * One property for a setting several workflows own with different limits (a music length up
 * to ten minutes, a sound effect up to thirty seconds): the widest bounds, and each workflow's
 * own description when it differs. The application keeps the chosen workflow's bounds.
 */
function widen(current, schema, id) {
  const merged = { ...current };
  if (schema.minimum !== undefined && merged.minimum !== undefined)
    merged.minimum = Math.min(merged.minimum, schema.minimum);
  else delete merged.minimum;
  if (schema.maximum !== undefined && merged.maximum !== undefined)
    merged.maximum = Math.max(merged.maximum, schema.maximum);
  else delete merged.maximum;
  if (schema.description && !merged.description?.includes(schema.description))
    merged.description = [merged.description, `For ${id}: ${schema.description}`].filter(Boolean).join(' ');
  return merged;
}
/** Whether the model may choose this workflow's clip length (its frame count is a model choice). */
const timed = workflow => workflow.mediaType === 'video' && workflow.parameters.frames?.policy === 'model';
const drawsSeed = workflow => workflow.parameters.seed?.policy === 'random';
/** A video workflow whose width and height are its own: the model names a format, not a size. */
const sized = workflow =>
  workflow.mediaType === 'video' &&
  ['width', 'height'].every(key => workflow.parameters[key] && workflow.parameters[key].policy !== 'model');
// The rate a clip is made at: that of its profile when it has profiles, which replaces the value of
// the workflow in the job (the editor greys that value for this reason). Read the other way round,
// a length asked in seconds was counted at one rate and made at another: 5 s gave 4 s.
const fpsOf = workflow =>
  workflow.profiles?.draft?.parameters.fps ?? workflow.parameters.fps?.value ?? workflow.parameters.fps?.default ?? 24;
/** The frames of its source a continuation renders again with this workflow. */
const overlapOf = workflow =>
  workflow.parameters.overlap_frames?.value ??
  workflow.parameters.overlap_frames?.default ??
  family(workflow.pipeline).parameters.overlap_frames?.choices?.[0] ??
  0;
/** The frame counts a workflow allows: its list, or its range step by step. */
function frameCounts(workflow) {
  const spec = effective(workflow.parameters.frames, family(workflow.pipeline).parameters.frames ?? {});
  if (spec.choices) return spec.choices;
  const step = spec.multipleOf || 1,
    low = Math.ceil((spec.min ?? 1) / step) * step,
    high = spec.max ?? low + 600 * step,
    counts = [];
  for (let value = low; value <= high && counts.length < 4096; value += step) counts.push(value);
  return counts;
}

/**
 * The frame count closest to `seconds` (of new footage for a continuation, which also re-renders
 * `overlap` frames of its source) among those the workflow allows, and the length it gives.
 */
export function framesFor(workflow, seconds, { continuation = false } = {}) {
  const fps = fpsOf(workflow),
    overlap = continuation ? overlapOf(workflow) : 0,
    choices = frameCounts(workflow);
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

/**
 * The slots of a workflow that take a verb's role. Given the verb (`name`), a role its family
 * does not combine with one the verb requires has none (LTX 2.5: subject references beside the
 * video a continuation starts from).
 */
const slotsFor = (workflow, role, name) => {
  const manifest = family(workflow.pipeline);
  const groups = manifest.exclusive ?? [],
    own = groups.find(group => group.includes(role)),
    needed = Object.entries(TASKS[name]?.roles ?? {}).filter(([other, spec]) => spec.required && other !== role);
  if (own && needed.some(([other]) => groups.some(group => group !== own && group.includes(other)))) return [];
  return workflow.references.filter(slot => manifest.roles[slot.role]?.as === role);
};
const slotMedia = (workflow, slot) => family(workflow.pipeline).roles[slot.role].media;

/** Whether a workflow can perform a verb at all, independently of the sources provided. */
export function serves(workflow, name) {
  const task = TASKS[name],
    manifest = family(workflow.pipeline);
  if (!task || !manifest.tasks.includes(name)) return false;
  if (task.output !== 'source' && task.output !== manifest.mediaType) return false;
  for (const [role, spec] of Object.entries(task.roles))
    if (spec.required && !slotsFor(workflow, role, name).some(slot => spec.media.includes(slotMedia(workflow, slot))))
      return false;
  // A required slot outside this verb's roles (a mandatory source video, say) excludes the workflow.
  return workflow.references.every(slot => !slot.required || Object.hasOwn(task.roles, manifest.roles[slot.role].as));
}

/**
 * The slots of a workflow a verb can fill: those of the verb's own roles, less the ones its family
 * does not combine with a role the verb requires (slotsFor). What the model may pass and what the
 * card of a proposal lets the user add are the same slots: no first or last frame on a
 * continuation, no subject reference beside the video LTX 2.5 continues.
 */
export function verbSlots(workflow, name) {
  const task = TASKS[name];
  // A verb the catalog does not know has no rule of its own: every slot.
  if (!task) return [...workflow.references];
  const open = new Set(Object.keys(task.roles).flatMap(role => slotsFor(workflow, role, name).map(slot => slot.id)));
  return workflow.references.filter(slot => open.has(slot.id));
}

/**
 * The inputs a family does not combine, among the slots a proposal fills (`held`, their ids): the
 * slots filled of each of its exclusive groups, when several groups hold one (MiniMax: reference
 * images, and a start or an end image); empty when the inputs go together. The test route() makes
 * of what the model passes, made of what a card holds.
 */
export function apartInputs(workflow, held) {
  const manifest = family(workflow.pipeline),
    filled = workflow.references.filter(slot => held.includes(slot.id)),
    groups = (manifest.exclusive ?? [])
      .map(group => filled.filter(slot => group.includes(manifest.roles[slot.role]?.as)))
      .filter(slots => slots.length);
  return groups.length > 1 ? groups : [];
}

/**
 * The inputs the card of a proposal of `name` shows, by the role each slot has in its family
 * (`start_image`, `msr_image`…): the slots filled (`held`, their ids), and those where one more
 * input may go beside them.
 */
export function openRoles(workflow, name, held = []) {
  const open = new Set(verbSlots(workflow, name).map(slot => slot.id));
  return workflow.references
    .filter(slot => held.includes(slot.id) || (open.has(slot.id) && !apartInputs(workflow, [...held, slot.id]).length))
    .map(slot => slot.role);
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
      if (source.conversation !== undefined && (source.output === undefined || !UUID.test(String(source.conversation))))
        throw problem(`${role}: a conversation goes only with an output.`);
    }
    // A role that takes a video whole: a frame named with it says nothing, the video is meant.
    const whole = !spec.media.includes('image');
    if (list.length) assigned[role] = whole ? list.map(({ frame, ...source }) => source) : list;
  }
  return assigned;
}

/** Assigns each provided source to a compatible slot of the workflow, or explains why it cannot. */
function assign(workflow, provided, name) {
  const used = new Set(),
    references = [];
  for (const [role, list] of Object.entries(provided))
    for (const source of list) {
      const slot = slotsFor(workflow, role, name).find(
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
        if (source.conversation !== undefined) reference.output_conversation = source.conversation;
      }
      references.push(reference);
    }
  const missing = workflow.references.find(slot => slot.required && !used.has(slot.id));
  // (0.6.94) In the user's words, who reads it on the refusal too (« Appel d’outil refusé : … »).
  if (missing)
    return {
      error: `« ${missing.name || missing.id} » est obligatoire dans ce workflow`,
      missing: missing.name || missing.id,
    };
  return { references, unused: workflow.references.length - used.size };
}

/**
 * The LoRAs a workflow brings itself (Settings, Workflows), as the Studio shows them: always on
 * (« Activé »), or left to whoever asks (« Assistant », on by default or not), with a fixed
 * strength or a range to choose in. Those switched off are not offered, nor the one of the subject
 * references, on by itself with them (referenceLora). `names`: the file of each asset id.
 */
function workflowLoras(workflow, manifest, names) {
  const spec = manifest.loras?.strength ?? { type: 'number' },
    bound = referenceLora(workflow);
  return (workflow.loras ?? [])
    .filter(lora => lora !== bound)
    .filter(lora => lora.enabled.policy === 'model' || (lora.enabled.policy === 'fixed' && lora.enabled.value))
    .map(lora => {
      // (0.6.94) As it is made: a switch or a strength saved without a default has its stand-in.
      const made = madeLora(lora, workflow.pipeline),
        free = lora.strength.policy === 'model',
        range = free ? effective(lora.strength, spec) : null;
      return {
        id: lora.id,
        name: loraName(lora, names),
        description: lora.description ?? '',
        assistant: lora.enabled.policy === 'model',
        on: lora.enabled.policy === 'model' ? made.enabled.default === true : true,
        strength: free
          ? {
              min: range.min,
              max: range.max,
              ...(Object.hasOwn(made.strength, 'default') ? { default: made.strength.default } : {}),
            }
          : { value: lora.strength.value },
      };
    });
}
/** A LoRA of a workflow by what the user knows of it: its file, else what it is said to bring. */
const loraName = (lora, names) =>
  (names.get(lora.asset) ?? '').replace(/\.safetensors$/i, '') || lora.description || lora.id;

// (0.6.102) A setting as the user knows it, by its name in Paramètres › Workflows; a number as it is
// written to the user (« 0,6 »).
const nameOf = key => SETTING_NAMES[key] ?? key;
const shown = value => String(value).replace('.', ',');
// (0.6.102) What the Studio sets with its own controls (the prompt, the bars of size and length,
// the seed) or what has a section of its own in the editor (the enhancement of the prompt): no line
// of « Plus de réglages ».
const STUDIO_OWN = new Set(['prompt', 'width', 'height', 'frames', 'stage', 'seed', 'expandPrompt']);
// The settings of the subject references of LTX 2.5, read with one of them only (public/video-plan.mjs).
const SUBJECT_SETTINGS = /^msr_/;
/** The versions a workflow is made at, which its profiles apply to (as the editor says: inertSetting). */
function stagesOf(workflow, manifest) {
  const stage = workflow.parameters?.stage;
  if (!stage || !workflow.profiles) return [];
  if (stage.policy === 'fixed') return [stage.value];
  return stage.choices ?? manifest.parameters?.stage?.choices ?? Object.keys(workflow.profiles);
}
/** The input a setting is read with only, as the Studio greys it: its family's, or a subject reference. */
function settingInput(workflow, key, spec) {
  if (spec.onlyWith) return { ...spec.onlyWith };
  if (SUBJECT_SETTINGS.test(key) && (workflow.references ?? []).some(slot => slot.role === 'msr_image'))
    return { role: 'msr_image' };
  return null;
}
/**
 * (0.6.102) Whether a setting is one of the Studio's for a verb: left to Moodix AI, or fixed by the
 * workflow, which holds Moodix AI and leaves the user free to change it for a creation; unless it
 * changes nothing whatever it holds (read by no engine, one value only, replaced by the profile of
 * every version, read only with an input this verb never takes: the overlap of a continuation in a
 * new video).
 */
function studioSetting(workflow, manifest, key, policy, verb) {
  if (STUDIO_OWN.has(key) || !['model', 'fixed'].includes(policy?.policy)) return false;
  const spec = manifest.parameters[key];
  if (!spec || spec.unused) return false;
  const only = settingInput(workflow, key, spec);
  if (only) {
    const taken = new Set(
      Object.keys(TASKS[verb].roles).flatMap(role => slotsFor(workflow, role, verb).map(slot => slot.role)),
    );
    if (!(only.roles ?? [only.role]).some(role => taken.has(role))) return false;
  }
  if (policy.policy === 'model') return true;
  if (effective(policy, spec).choices?.length === 1) return false;
  const stages = stagesOf(workflow, manifest);
  return !(stages.length && stages.every(stage => Object.hasOwn(workflow.profiles?.[stage]?.parameters ?? {}, key)));
}

function accepted(workflow, name) {
  const roles = Object.keys(TASKS[name].roles).filter(role => slotsFor(workflow, role, name).length);
  return roles.length ? roles.join(', ') : 'prompt only';
}

/**
 * The workflows of a verb (`serving`) a model can pass by their name: a capable model is shown
 * names (« LTX 2.5 ») rather than identifiers, when no other workflow of the verb has the same one.
 */
const byName = serving => workflow =>
  serving.filter(other => other.name === workflow.name).length === 1 ? workflow.name : workflow.id;

export class ToolCatalog {
  constructor(workflows) {
    this.workflows = workflows;
  }

  /** Media each output button can act on now: { upscale: ['image', 'video'], interpolate: [...], ... }. */
  async actions() {
    // (0.6.94) The buttons of a take are the user's hand: a workflow not offered to Moodix AI serves them too.
    const result = {},
      ready = await this.#runnable();
    for (const name of ['upscale', 'interpolate', 'extend_video']) {
      const media = new Set();
      for (const workflow of await this.#serving(name, ready))
        for (const slot of slotsFor(workflow, 'source')) media.add(slotMedia(workflow, slot));
      result[name] = [...media];
    }
    // « Animer » a take: a clip that starts from the image (create_video and its first image).
    result.animate = [];
    for (const workflow of await this.#serving('create_video', ready))
      if (slotsFor(workflow, 'start_image', 'create_video').some(slot => slotMedia(workflow, slot) === 'image')) {
        result.animate = ['image'];
        break;
      }
    return result;
  }

  /**
   * What the Studio shows for each creation verb: the ready workflows, and for each the inputs
   * it takes (how many per role), its sizes, its lengths in seconds and its own settings. After
   * them, those this computer cannot run whatever the files chosen (`unavailable`, the reason:
   * no NVIDIA card for a model that computes on one): shown greyed, never left out unexplained.
   */
  async studio() {
    // (0.6.94) Those not offered to Moodix AI too (« Proposé à Moodix AI » off): the
    // Studio is the user's own hand.
    const result = {},
      all = await this.workflows.list(),
      ready = all.filter(workflow => workflow.ready),
      lacking = all.filter(workflow => !workflow.ready && workflow.unavailableKind === 'hardware'),
      names = await this.#loraFiles(ready),
      // (0.6.102) When the user last changed each part of each workflow: the Studio shows the newer
      // of such a change and the value of the last take of a conversation (« le plus récent des deux »).
      changes = (await this.workflows.changes?.().catch(() => ({}))) ?? {};
    for (const name of ['create_image', 'create_video', 'extend_video', 'replace_character', 'create_audio']) {
      const task = TASKS[name],
        // A video made from another one the user hands over (a character replaced in it) has
        // that video's length and shape: no size is offered. (A continuation is told apart
        // by the page, which knows the clip it continues.)
        follows = name !== 'extend_video' && Boolean(task.roles.source?.required);
      // The family the router prefers comes first: it is the one selected when the page opens.
      const preferred = (a, b) => (family(b.pipeline).preference ?? 0) - (family(a.pipeline).preference ?? 0);
      const serving = [
        ...(await this.#serving(name, ready)).sort(preferred),
        ...(await this.#serving(name, lacking)).sort(preferred),
      ];
      result[name] = serving.map(workflow => {
        const manifest = family(workflow.pipeline),
          p = workflow.parameters,
          // (0.6.102) The bounds of the workflow, « Fixe » as « Assistant »: the user's own.
          limit = key => {
            const spec = manifest.parameters[key];
            if (!spec || !p[key]) return null;
            const own = effective(p[key], spec);
            return { min: own.min, max: own.max, multipleOf: spec.multipleOf };
          },
          value = key => p[key]?.value ?? p[key]?.default,
          profile = stage => workflow.profiles?.[stage]?.parameters,
          size = from => (from?.width && from?.height ? { width: from.width, height: from.height } : null),
          // The version a workflow fixes (« Vidéo finale ») is the size the Studio starts from: from the
          // draft's, it made a final at 288 × 512 (0.6.102).
          start = p.stage?.policy === 'fixed' ? p.stage.value : 'draft';
        let lengths = null;
        if (workflow.mediaType === 'video' && p.frames?.policy === 'model') {
          const spec = effective(p.frames, manifest.parameters.frames ?? {}),
            fps = fpsOf(workflow),
            continuation = name === 'extend_video',
            overlap = continuation
              ? (value('overlap_frames') ?? manifest.parameters.overlap_frames?.choices?.[0] ?? 0)
              : 0;
          // A free range is offered by the second; a list as it is.
          const frames =
            spec.choices ??
            Array.from({ length: 30 }, (_, index) => framesFor(workflow, index + 1, { continuation }).frames);
          lengths = [...new Set(frames.filter(count => count > overlap).map(count => (count - overlap) / fps))]
            .filter(seconds => seconds >= 0.5)
            .sort((a, b) => a - b);
          const standard = p.frames.default ?? manifest.parameters.frames?.default;
          lengths = { seconds: lengths, standard: Number.isFinite(standard) ? (standard - overlap) / fps : null };
        }
        return {
          id: workflow.id,
          name: workflow.name,
          description: workflow.description,
          media: workflow.mediaType,
          verb: name,
          ...(follows ? { follows: true } : {}),
          ...(workflow.ready ? {} : { unavailable: workflow.unavailableReason }),
          // The family of the model: a LoRA made for one is of no use to another.
          family: workflow.pipeline,
          for: manifest.chooseFor ?? '',
          // It takes the style LoRAs of the Studio (the families whose manifest says so); the
          // size is an argument or a user edit; the workflow has draft and final profiles; its
          // seed is drawn unless given.
          styled: manifest.styles === true,
          direct: p.width?.policy === 'model' && p.height?.policy === 'model',
          // (0.6.102) Whether Moodix AI chooses the size (its own) or the format (a video's): the
          // pointer sets only what it chose, never a size the workflow fixes.
          assistantSize: (p.width?.policy === 'model' && p.height?.policy === 'model') || workflow.mediaType === 'video',
          stages: p.stage?.policy === 'model',
          seeded: drawsSeed(workflow),
          // (0.6.102) A seed « Fixe »: the Studio makes it unless the user names another one.
          ...(p.seed?.policy === 'fixed' ? { seedFixed: p.seed.value } : {}),
          ...(changes[workflow.id] ? { changed: structuredClone(changes[workflow.id]) } : {}),
          roles: Object.fromEntries(
            Object.keys(task.roles).map(role => [
              role,
              {
                count: slotsFor(workflow, role, name).length,
                media: [...new Set(slotsFor(workflow, role, name).map(slot => slotMedia(workflow, slot)))],
                many: Boolean(task.roles[role].many),
                // What the verb or this workflow cannot do without (its character, for a
                // replacement made by hand: the Studio does not make it from words).
                ...(task.roles[role].required || slotsFor(workflow, role, name).some(slot => slot.required)
                  ? { required: true }
                  : {}),
              },
            ]),
          ),
          // The role of this verb each input of the workflow takes, by its name in a take's record
          // (« reference_image » → « reference »): the Studio puts the inputs of a take back in their cases.
          inputs: Object.fromEntries(
            Object.keys(task.roles).flatMap(role => slotsFor(workflow, role, name).map(slot => [slot.role, role])),
          ),
          ...(manifest.exclusive ? { exclusive: manifest.exclusive } : {}),
          ...(workflow.mediaType !== 'audio' && p.width && p.height && !follows
            ? {
                limits: { width: limit('width'), height: limit('height') },
                // A draft size first when the workflow has one: quick by default.
                size: size(profile(start)) ?? size({ width: value('width'), height: value('height') }),
                final: start === 'draft' && p.stage?.policy === 'fixed' ? null : size(profile('final')),
              }
            : {}),
          ...(lengths ? { lengths } : {}),
          // Its own LoRAs, chosen in its settings: shown in the Studio, those left to the
          // assistant switched and set there too.
          loras: workflowLoras(workflow, manifest, names),
          // The workflow's own settings: lyrics, seconds, language… (0.6.102) Those it fixes too,
          // at their value: « Fixe » holds Moodix AI, the user may change it for a creation (`fixed`,
          // which is no mark on the page: the Studio sends it as the user's own change, and the
          // pointer of Moodix AI does not set it as its choice).
          settings: Object.entries(p)
            .filter(([key, policy]) => studioSetting(workflow, manifest, key, policy, name))
            .map(([key, policy]) => {
              // (0.6.94) With what is made when nothing is set (madePolicy): its default, or the
              // value that stands in for one the workflow was saved without.
              const spec = effective(policy, manifest.parameters[key]),
                made = policy.policy === 'fixed' ? { default: policy.value } : madePolicy(workflow, key),
                onlyWith = settingInput(workflow, key, spec);
              return {
                key,
                type: spec.type,
                ...(spec.min !== undefined ? { min: spec.min } : {}),
                ...(spec.max !== undefined ? { max: spec.max } : {}),
                ...(spec.choices ? { choices: spec.choices } : {}),
                ...(spec.maxLength ? { maxLength: spec.maxLength } : {}),
                ...(spec.multipleOf ? { multipleOf: spec.multipleOf } : {}),
                ...(Object.hasOwn(made, 'default') ? { default: made.default } : {}),
                ...(policy.policy === 'fixed' ? { fixed: true } : {}),
                // Read by the engine only with an input (the denoise of Krea 2 with an image to
                // modify, `role` as in `inputs` above): the Studio greys it while that case is empty.
                ...(onlyWith ? { onlyWith } : {}),
              };
            }),
        };
      });
    }
    return result;
  }

  /** The file of each LoRA asset the workflows use, read once from the registry (its name, or ''). */
  async #loraFiles(workflows) {
    const used = new Set(workflows.flatMap(workflow => (workflow.loras ?? []).map(lora => lora.asset)).filter(Boolean)),
      names = new Map();
    if (!used.size) return names;
    try {
      for (const asset of (await this.workflows.assets?.list?.()) ?? [])
        if (used.has(asset.id)) names.set(asset.id, asset.name || (asset.path ? basename(asset.path) : ''));
    } catch {
      // The registry is unreadable: the LoRAs are named by their description.
    }
    return names;
  }

  isGenerationTool(name) {
    return Object.hasOwn(TASKS, name);
  }

  /**
   * The ready workflows Moodix AI is offered. Listing them checks the files of every workflow (most
   * of a second with models on a hard disk): an answer about several verbs reads the list once and
   * passes it on. (0.6.94) « Proposé à Moodix AI » (`enabled`) off leaves one out here
   * only: the Studio and the buttons of a take still have it (#runnable).
   */
  async #ready() {
    return (await this.workflows.list()).filter(workflow => workflow.ready && workflow.enabled !== false);
  }
  /** The workflows that can be made here, offered to Moodix AI or not: those of the user's own hand. */
  async #runnable() {
    return (await this.workflows.list()).filter(workflow => workflow.ready);
  }
  /**
   * Shipped workflows that lack only a file Moodix can download (etats-maquette.md, 53): a verb
   * none of the ready ones makes still reaches them, and the file is offered in the chat.
   */
  /** The workflow of `name` that only lacks a file to download, when no ready one makes it (53). */
  async lacking(name) {
    if ((await this.#serving(name)).length) return null;
    return (await this.#fetchable(name))[0] ?? null;
  }
  async #fetchable(name) {
    return (await this.workflows.list()).filter(
      workflow => !workflow.ready && workflow.builtin && workflow.unavailableKind === 'files' && serves(workflow, name),
    );
  }
  async #serving(name, ready) {
    return (ready ?? (await this.#ready())).filter(workflow => serves(workflow, name));
  }

  /**
   * The clip lengths, in seconds, of the workflows that can perform this verb and let the model
   * choose. For a continuation, what it adds: it renders the end of its source again (the
   * overlap), so each frame count gives that much less new footage, and with no length asked it
   * adds about a standard clip (route). Told the lengths of a new clip, the model proposed
   * 14.4 s where MiniMax adds 13.5 s at most.
   */
  async lengths(name) {
    if (!TASKS[name]) return [];
    const continuation = name === 'extend_video';
    return (await this.#serving(name)).filter(timed).flatMap(workflow => {
      const manifest = family(workflow.pipeline).parameters.frames ?? {},
        spec = effective(workflow.parameters.frames, manifest),
        fps = fpsOf(workflow),
        overlap = continuation ? overlapOf(workflow) : 0,
        range = continuation
          ? frameCounts(workflow).filter(count => count > overlap)
          : (spec.choices ?? [spec.min, spec.max]).filter(Number.isFinite),
        standard = workflow.parameters.frames.default ?? manifest.default;
      if (!range.length || !Number.isFinite(standard)) return [];
      return [
        {
          name: workflow.name,
          min: (Math.min(...range) - overlap) / fps,
          max: (Math.max(...range) - overlap) / fps,
          standard: continuation ? framesFor(workflow, standard / fps, { continuation }).seconds : standard / fps,
        },
      ];
    });
  }

  /**
   * What one more image would find in a proposal: `references` are its inputs, each with the slot
   * (`input`) it fills in `workflow`. `here`: the roles of the verb in which that workflow would
   * still take an image beside them; `none`: it takes no image at all for this verb; `other`: when
   * it has no place left, the name of another ready workflow of the verb that would take these
   * inputs and the image.
   */
  async room(name, workflow, references = []) {
    const task = TASKS[name];
    if (!task) return { here: [], none: true, other: null };
    // The inputs as the router was given them: by role of the verb, each with its media.
    const roles = family(workflow.pipeline).roles ?? {},
      provided = {};
    for (const reference of references) {
      const slot = workflow.references.find(item => item.id === reference.input),
        role = roles[slot?.role];
      if (role?.as) (provided[role.as] ??= []).push({ media: role.media });
    }
    const pictured = Object.entries(task.roles).filter(([, spec]) => spec.media.includes('image'));
    const takes = candidate =>
      pictured
        .filter(([role, spec]) => spec.many || !provided[role]?.length)
        .filter(([role]) => {
          const more = { ...provided, [role]: [...(provided[role] ?? []), { media: 'image' }] },
            apart = (family(candidate.pipeline).exclusive || []).filter(group =>
              group.some(item => more[item]?.length),
            );
          return apart.length < 2 && !assign(candidate, more, name).error;
        })
        .map(([role]) => role);
    const here = takes(workflow);
    return {
      here,
      none: !pictured.some(([role]) =>
        slotsFor(workflow, role, name).some(slot => slotMedia(workflow, slot) === 'image'),
      ),
      other: here.length
        ? null
        : ((await this.#serving(name)).find(item => item.id !== workflow.id && takes(item).length)?.name ?? null),
    };
  }

  /**
   * One tool per verb that at least one ready workflow can perform.
   * `available` ({ images, resources: [{ id, type }], outputs: [{ id, mediaType, count, workflowId, draft }] })
   * describes what the current conversation can reference. When given, source roles only offer
   * those sources, with their IDs enumerated, and a verb whose required source has nothing to
   * point to is not offered at all: a model must never be asked for an ID that does not exist.
   * `wording` (lib/model-wording.mjs): the words of the small local model (« rails », as they always
   * were) or those of a capable one; the same tools, the same arguments either way.
   */
  async definitions(available, { wording = RAILS } = {}) {
    const context = availability(available);
    const tools = [],
      ready = await this.#ready();
    for (const name of Object.keys(TASKS)) {
      let serving = await this.#serving(name, ready);
      if (!serving.length) serving = await this.#fetchable(name);
      const definition = serving.length ? this.#definition(name, serving, context, wording === CAPABLE) : null;
      if (definition) tools.push(definition);
    }
    return tools;
  }

  #definition(name, serving, available, capable = false) {
    const task = capable ? capableTask(name) : TASKS[name],
      properties = {},
      required = [],
      offered = new Set(),
      // How the model names a workflow: its id, or for a capable model its name when it is the only one.
      named = capable ? byName(serving) : workflow => workflow.id;
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
      const capacity = Math.max(0, ...serving.map(workflow => slotsFor(workflow, role, name).length));
      if (!capacity) continue;
      const schema = capable
        ? spec.media.includes('image')
          ? capableSourceSchema
          : capableWholeSchema
        : available
          ? availableSourceSchema(spec.media, available)
          : spec.media.includes('image')
            ? sourceSchema
            : wholeSourceSchema;
      if (!schema) {
        // Nothing in this conversation can fill a required role: the verb cannot run yet.
        if (spec.required) return null;
        continue;
      }
      for (const variant of schema.anyOf || [schema])
        for (const key of ['image', 'resource', 'output', 'take', 'ref']) if (variant.properties[key]) offered.add(key);
      properties[role] = spec.many
        ? { type: 'array', items: schema, maxItems: capacity, description: spec.description }
        : { ...schema, description: spec.description };
      if (spec.required) required.push(role);
    }
    if (serving.length > 1) {
      // The model leaves the choice to the application, except for a workflow whose family says
      // what it is the one for (MOSS Image: posters and text in the picture). Asked to choose by
      // the descriptions alone, it named a video workflow that could not take the images passed.
      const special = serving
        .filter(workflow => family(workflow.pipeline).chooseFor)
        .map(workflow => ` Pass ${named(workflow)} for ${family(workflow.pipeline).chooseFor}.`);
      // Workflows that are each the one for something (music, sound effects): only the model
      // knows which the user wants, so it always says.
      const choose = chosen(serving);
      properties.workflow = {
        type: 'string',
        enum: serving.map(named),
        description:
          (choose
            ? 'The workflow that makes what the user asked for.'
            : capable
              ? 'Only when the user names one of the workflows listed above. Omit it otherwise: the application picks the one that takes what you pass.'
              : 'Optional: force one of the workflows listed above, when the user names it. Omit it to let the application pick the best match.') +
          special.join(''),
      };
      if (choose) required.push('workflow');
    }
    const durations = serving.filter(timed);
    if (task.output === 'video' && durations.length) {
      // Always asked for, so a length the user gave ("3 secondes") is not left in the prompt:
      // the model states it, or null for the workflow's own default.
      const always = durations.length === serving.length;
      properties.duration = {
        type: always ? ['number', 'null'] : 'number',
        minimum: 0.5,
        maximum: 120,
        description: capable
          ? (name === 'extend_video'
              ? 'Seconds of new footage to add after the source video, when the user gave a length'
              : 'Clip length in seconds, when the user gave one') +
            (always
              ? '; null when they gave none, and the application uses the usual length of the workflow.'
              : ` (only for: ${durations.map(named).join(', ')}).`) +
            ' Rounded to the closest length the workflow allows.'
          : (name === 'extend_video'
              ? 'Seconds of new footage to add after the source video: the length the user asked for'
              : 'Clip length in seconds: the length the user asked for') +
            (always ? ', or null when they gave none.' : ', if they gave one.') +
            ' Never write the length in the prompt. Rounded to the closest length the workflow allows' +
            (always ? '' : ` (only for: ${durations.map(workflow => workflow.id).join(', ')})`) +
            '.',
      };
      if (always) required.push('duration');
    }
    // A workflow that sets its own size still takes the format the user names; a video made
    // from another one (its continuation, a character replaced in it) has that video's.
    if (task.output === 'video' && !task.roles.source?.required && serving.some(sized))
      properties.format = {
        type: 'string',
        enum: FORMATS.map(format => format.id),
        description:
          'Picture format, only when the user asks for one ("vertical" or "portrait" is 9:16, "paysage" 16:9, "carré" 1:1). Omit it otherwise: a video that starts from an image takes the format of that image.',
      };
    // The application draws the seed; the model passes one only when the user named it.
    if (serving.some(drawsSeed))
      properties.seed = {
        type: 'integer',
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
        description:
          'Only when the user gives a seed number: exactly that number. Omit it otherwise; the application draws one.',
      };
    const owners = {};
    for (const workflow of serving) {
      const manifest = family(workflow.pipeline);
      for (const [key, policy] of Object.entries(workflow.parameters)) {
        if (key === 'prompt' || policy.policy !== 'model' || RESERVED.has(key) || Object.hasOwn(task.roles, key))
          continue;
        // The clip length is asked in seconds (duration), not as a frame count.
        if (key === 'frames' && properties.duration) continue;
        // A setting the engine only reads with an input (the denoise of Krea 2 with an image to
        // modify) is offered with the role of that input, by a workflow that takes it: nothing to
        // pass there, nothing said of it.
        const only = onlyRoles(manifest.parameters[key]).map(role => manifest.roles?.[role]?.as);
        if (only.length && !only.some(role => properties[role] && slotsFor(workflow, role, name).length)) continue;
        (owners[key] ??= []).push(named(workflow));
        // (0.6.94) With the value made when nothing is passed, a default the workflow lacks included.
        const schema = policySchema(madePolicy(workflow, key), manifest.parameters[key]);
        if (capable && !schema.description && CAPABLE_SETTINGS[key]) schema.description = CAPABLE_SETTINGS[key];
        properties[key] = properties[key] ? widen(properties[key], schema, named(workflow)) : schema;
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
    // The verb's own arguments (the description of a character to make, for replace_character):
    // answered by the application before any workflow is chosen.
    for (const [key, spec] of Object.entries(task.arguments ?? {})) properties[key] = structuredClone(spec);
    if (task.output === 'video' || (task.output === 'source' && video)) {
      properties.intention = {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
        description: capable
          ? 'One or two sentences in the user’s language, shown on the card of the proposal: what it will be.'
          : 'One or two sentences explaining the proposal to the user, who must confirm every video.',
      };
      if (task.output === 'video') required.push('intention');
    }
    const finals = serving.filter(workflow => workflow.profiles?.final).map(workflow => workflow.id);
    const drafts = available?.outputs.filter(item => item.draft && finals.includes(item.workflowId));
    // (A capable model: always offered, without the list of the drafts, the same at every request.)
    if (finals.length && (!available || capable || drafts.length))
      properties.reuse_output = {
        type: 'string',
        ...(available && !capable ? { enum: drafts.map(item => item.id) } : {}),
        description:
          // (prompt and duration stay `required` for every call: the application leaves them aside here.)
          capable
            ? 'When the user asks for the final version of a draft: the run_id of that draft, with stage final and intention. The draft keeps its prompt, its length and its inputs: prompt and duration are then not used, and no other argument is accepted.'
            : 'run_id of an approved draft to render again with the final profile: pass it with stage=final and intention. The draft keeps its prompt, its length and its inputs: what prompt and duration say is then not used, and no other argument is accepted.',
      };
    const list = serving
      .map(workflow =>
        capable
          ? `- ${named(workflow) === workflow.name ? workflow.name : `${workflow.id}: ${workflow.name}`}. ${workflow.description} (inputs: ${accepted(workflow, name)})`
          : `- ${workflow.id}: ${workflow.name}. ${workflow.description} (accepts: ${accepted(workflow, name)})`,
      )
      .join('\n');
    const kinds = (
      capable
        ? [
            ['take', '{"take": n} the take « PRISE n » of the project'],
            [
              'ref',
              '{"ref": n} the reference #refN of the project; "frame": "last" for the last image of a video take or reference (to start a new clip where it ends), "first" for its first; 0, 1 or 2 for a sample of a video reference',
            ],
            ['image', '{"image": n} the n-th image the user attached in this conversation (0 = first)'],
            [
              'output',
              '{"output": "run_id"} an earlier result of this conversation that has no take number, with "index" for its position in the run',
            ],
          ]
        : [
            ['image', '{"image": n} is the n-th image the user attached in this conversation (0 = first)'],
            ['resource', '{"resource": "id"} an active resource'],
            ['output', '{"output": "run_id"} an earlier result of this conversation'],
            ['take', '{"take": n} the take « PRISE n » of this project, when the user names a take by its number'],
          ]
    ).filter(([key]) => offered.has(key));
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
   * `byHand`: asked by the user's own hand (the Studio, the buttons of a take), whose workflows are
   * all those that can be made here, offered to Moodix AI or not (0.6.94).
   */
  async route(name, args, { mediaOf, originOf, byHand = false }) {
    const task = TASKS[name];
    if (!task) throw problem('Outil de génération inconnu.', 400);
    const known = new Set([...RESERVED, ...Object.keys(task.roles), ...Object.keys(task.arguments ?? {})]);
    // The verb's own arguments are not the workflow's: dealt with before (see #definition).
    args = Object.fromEntries(Object.entries(args).filter(([key]) => !Object.hasOwn(task.arguments ?? {}, key)));
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
    let serving = await this.#serving(name, byHand ? await this.#runnable() : undefined);
    if (!serving.length) serving = await this.#fetchable(name);
    // The workflow the model names comes first, when it can take what was passed: a model that
    // names one for its description (and overlooks an image it cannot take) still gets a video.
    // (By its id, or by its name for a capable model, which is shown names: byName.)
    const named =
      args.workflow === undefined
        ? null
        : (serving.find(workflow => workflow.id === args.workflow) ??
          serving.find(workflow => workflow.name === args.workflow && byName(serving)(workflow) === workflow.name));
    if (args.workflow !== undefined && !named)
      throw problem(`Le workflow ${args.workflow} ne peut pas exécuter ${name}.`, 400);
    const reasons = [];
    let best,
      lacking;
    for (const workflow of serving) {
      // Upscaling keeps the media type: an image source needs an image workflow.
      if (task.output === 'source' && provided.source && workflow.mediaType !== provided.source[0].media) {
        reasons.push(`${workflow.id}: ${workflow.mediaType} only`);
        continue;
      }
      const result = assign(workflow, provided, name);
      // Inputs the family cannot combine (MiniMax: reference images or start/end images).
      const apart = (family(workflow.pipeline).exclusive || []).filter(group =>
        group.some(role => provided[role]?.length),
      );
      // (0.6.134) What the workflow named cannot do without and was not given (Wan 2.2: an image to start from).
      if (result.missing && workflow === named) lacking = result.missing;
      if (result.error) reasons.push(`${workflow.id}: ${result.error}`);
      else if (apart.length > 1)
        reasons.push(`${workflow.id}: ${apart.map(group => group.join('/')).join(' and ')} do not combine`);
      else {
        // Origin of the source first, then the family the manifest prefers (SeedVR2 over
        // Real-ESRGAN for images), then the most specific workflow.
        const rank = [
          workflow === named ? 1 : 0,
          affinity(workflow),
          family(workflow.pipeline).preference ?? 0,
          -result.unused,
        ];
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
    if (named && workflow !== named)
      notes.push(
        lacking
          ? `${named.name} ne se fait pas sans « ${lacking} » : ${workflow.name} est utilisé à la place.`
          : `${named.name} ne prend pas ces entrées ensemble : ${workflow.name} est utilisé à la place.`,
      );
    if (args.prompt !== undefined) routed.prompt = args.prompt;
    if (args.duration !== undefined && args.duration !== null) {
      if (
        typeof args.duration !== 'number' ||
        !Number.isFinite(args.duration) ||
        args.duration <= 0 ||
        args.duration > 120
      )
        throw problem('duration doit être un nombre de secondes entre 0 et 120.', 400);
      if (!timed(workflow)) notes.push(`Durée ignorée : ${workflow.name} fixe la longueur du clip.`);
      else {
        const continuation = name === 'extend_video';
        const { frames, seconds } = framesFor(workflow, args.duration, { continuation });
        routed.frames = frames;
        if (Math.abs(seconds - args.duration) > 0.05)
          notes.push(
            `Durée ${continuation ? 'ajoutée ' : ''}: ${args.duration} s → ${seconds.toFixed(2)} s, la plus proche que ${workflow.name} permet.`,
          );
      }
    } else if (timed(workflow)) {
      // No length asked: the workflow's standard clip, in a draft as in a final. A draft profile
      // is a smaller picture; its own frame count (one second) is not a length anyone asked for.
      const standard = workflow.parameters.frames.default ?? family(workflow.pipeline).parameters.frames?.default;
      if (Number.isInteger(standard))
        routed.frames =
          name === 'extend_video'
            ? framesFor(workflow, standard / fpsOf(workflow), { continuation: true }).frames
            : standard;
    }
    let format;
    if (args.format !== undefined && args.format !== null) {
      if (!FORMATS.some(item => item.id === args.format))
        throw problem(`format doit être l’un de : ${FORMATS.map(item => item.id).join(', ')}.`, 400);
      if (sized(workflow)) format = args.format;
      // (0.6.102) Said as the other notes: the name, then what became of the value.
      else notes.push(`Format : valeur ignorée, ${workflow.name} ne règle pas sa taille ainsi.`);
    }
    let seed;
    if (args.seed !== undefined && args.seed !== null) {
      if (!Number.isSafeInteger(args.seed) || args.seed < 0) throw problem('seed doit être un entier positif.', 400);
      if (drawsSeed(workflow)) seed = args.seed;
      // (0.6.102) Said under the name the editor shows (« Seed »), as every note of the router.
      else notes.push(`Seed : valeur ignorée, fixée par le workflow ${workflow.name}.`);
    }
    // (0.6.102) The files named, as the LoRAs: the workflow's own (#componentsFor).
    if (args.components !== undefined) this.#componentsFor(workflow, args.components, notes);
    // (0.6.94) The LoRAs named, as the other settings passed: what the workflow fixes stays its own.
    // Named all the same, a LoRA « Activé » had the whole call refused (« enabled is fixed; a locked
    // parameter cannot be overridden »).
    if (args.loras !== undefined) {
      const loras = await this.#lorasFor(workflow, args.loras, serving, notes);
      if (loras !== undefined) routed.loras = loras;
    }
    // An intention only exists for video proposals; an image workflow rejects it.
    if (workflow.mediaType === 'video' && args.intention !== undefined) routed.intention = args.intention;
    // Upscaling or smoothing a video still goes through the video confirmation, which shows an intention.
    if (workflow.mediaType === 'video' && routed.intention === undefined) routed.intention = task.summary;
    // What the engine does not read with these inputs (the denoise of Krea 2 without an image to
    // modify): passed all the same, it is left aside without a word, as the tool says it is.
    const unread = unreadParameters(workflow, result.references);
    for (const [key, value] of Object.entries(args)) {
      if (known.has(key)) continue;
      const policy = workflow.parameters[key];
      if (policy?.policy === 'model' && Object.hasOwn(unread, key)) continue;
      if (policy?.policy === 'model') {
        // Bounds widened for several workflows: a value beyond this one's is brought back to it.
        const spec = effective(policy, family(workflow.pipeline).parameters[key]);
        const low = spec.min ?? -Infinity,
          high = spec.max ?? Infinity;
        if (typeof value === 'number' && spec.type === 'number' && (value < low || value > high)) {
          routed[key] = Math.min(high, Math.max(low, value));
          notes.push(`${nameOf(key)} : ${shown(value)} → ${shown(routed[key])}, la limite de ${workflow.name}.`);
        } else routed[key] = value;
      } else if (serving.some(other => other.parameters[key]?.policy === 'model'))
        // A setting of another workflow of this verb (lyrics passed for a sound effect).
        notes.push(`${nameOf(key)} : valeur ignorée, ${workflow.name} ne prend pas ce réglage.`);
      else if (Object.hasOwn(family(workflow.pipeline).parameters, key))
        notes.push(`${nameOf(key)} : valeur ignorée, fixée par le workflow ${workflow.name}.`);
      else throw problem(`${name} n’accepte pas l’argument ${key}.`, 400);
    }
    if (result.references.length) routed.references = result.references;
    return {
      workflow,
      args: routed,
      notes,
      ...(seed !== undefined ? { seed } : {}),
      ...(format !== undefined ? { format } : {}),
    };
  }

  /**
   * (0.6.102) The files a call names, which no tool offers any more: each is the workflow's own, as
   * a fixed setting is (« Assistant » left the files of the editor; a workflow saved so is made with its
   * default file). Never passed on: the same file is nothing to say, another one is left aside and said
   * in `notes`, as a file the workflow does not take; the call is never refused for it.
   */
  #componentsFor(workflow, given, notes) {
    if (!given || typeof given !== 'object' || Array.isArray(given)) {
      notes.push(`Fichiers ignorés : ${workflow.name} prend les siens.`);
      return;
    }
    const specs = family(workflow.pipeline).components;
    for (const [role, asset] of Object.entries(given)) {
      const policy = workflow.components?.[role],
        name = `« ${specs[role]?.label || role} »`;
      if (!policy) notes.push(`${name} : fichier ignoré, ${workflow.name} ne prend pas ce fichier.`);
      else if (asset !== (policy.policy === 'fixed' ? policy.asset : componentStandIn(policy)))
        notes.push(`${name} : fichier ignoré, fixé par le workflow ${workflow.name}.`);
    }
  }

  /**
   * (0.6.94) The LoRAs a call names, as the chosen workflow takes them: its switch or its strength,
   * when the workflow fixes them (« Activé », « Désactivé », a strength « Fixe »), are the workflow's,
   * as any fixed setting is. The same value is taken as it is (nothing is said); another is left
   * aside and said in `notes`; a strength for a LoRA that is not on, left aside too. A LoRA of another
   * workflow of the verb is left aside as its other settings are; one no workflow has is kept, for
   * the workflow to refuse. Undefined when nothing is left to pass.
   */
  async #lorasFor(workflow, given, serving, notes) {
    if (!given || typeof given !== 'object' || Array.isArray(given)) return given;
    const names = await this.#loraFiles([workflow]),
      bound = referenceLora(workflow),
      kept = {};
    for (const [id, selection] of Object.entries(given)) {
      const lora = (workflow.loras ?? []).find(item => item.id === id);
      if (!lora) {
        if (serving.some(other => other !== workflow && other.loras?.some(item => item.id === id)))
          notes.push(`LoRA ${id} ignoré : ${workflow.name} ne le prend pas.`);
        else kept[id] = selection;
        continue;
      }
      // The LoRA of the subject references is set by its images alone (resolveNativeWorkflow); what
      // is not an object is for the workflow to refuse.
      if (lora === bound || !selection || typeof selection !== 'object' || Array.isArray(selection)) {
        kept[id] = selection;
        continue;
      }
      const name = `« ${loraName(lora, names)} »`,
        entry = { ...selection },
        locked = lora.enabled.policy !== 'model',
        always = lora.enabled.policy === 'fixed' && lora.enabled.value === true;
      if (locked && !always) {
        // Off in the workflow: nothing of it is used.
        if (entry.enabled === true || Object.hasOwn(entry, 'strength'))
          notes.push(`LoRA ${name} ignoré : désactivé dans le workflow ${workflow.name}.`);
        continue;
      }
      if (locked && Object.hasOwn(entry, 'enabled')) {
        if (entry.enabled !== true) notes.push(`LoRA ${name} gardé : toujours activé dans le workflow ${workflow.name}.`);
        delete entry.enabled;
      }
      const on =
        locked ||
        (typeof entry.enabled === 'boolean' ? entry.enabled : madeLora(lora, workflow.pipeline).enabled.default === true);
      if (Object.hasOwn(entry, 'strength')) {
        if (!on) {
          if (entry.enabled !== false) notes.push(`Intensité du LoRA ${name} ignorée : ce LoRA n’est pas activé.`);
          delete entry.strength;
        } else if (lora.strength.policy !== 'model') {
          if (entry.strength !== lora.strength.value)
            notes.push(
              `Intensité du LoRA ${name} ignorée : ${String(lora.strength.value).replace('.', ',')}, fixée par le workflow ${workflow.name}.`,
            );
          delete entry.strength;
        }
      }
      if (Object.keys(entry).length) kept[id] = entry;
    }
    return Object.keys(kept).length ? kept : undefined;
  }
}
