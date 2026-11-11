import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { problem } from './engine.mjs';
import { nativeFields } from './native-messages.mjs';
import { editableParameters, nativeWorkflowReferences, nativeWorkflowImageInputs } from './native-workflows.mjs';
import { family } from './families.mjs';
import { ToolCatalog } from './tool-catalog.mjs';
import { ProgressClock, milestone, timingKey } from './generation-progress.mjs';
import { imageSize } from './image-size.mjs';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const APPROVAL_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING = 32;
const RELEASE_TIMEOUT_MS = 90_000;
const RESTART_TIMEOUT_MS = 300_000;
// Verbs that return their source in another format (larger, smoother) rather than new footage.
const TRANSFORMS = new Set(['upscale', 'interpolate']);
const transforms = pipeline => {
  try {
    return family(pipeline).tasks.every(task => TRANSFORMS.has(task));
  } catch {
    return false;
  }
};
const fpsText = value => String(Math.round(value * 100) / 100).replace('.', ',');

/**
 * Images the user attached in the visible conversation, in the order {"image": n} refers to them.
 * Shared by tool advertisement and reference resolution so both count the same images.
 */
export function chatImageUrls(messages) {
  return chatImageParts(messages).map(part => part.image_url?.url);
}

/** The same images as message parts: `file` names the stored attachment as the user gave it. */
export function chatImageParts(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(message => message?.role === 'user' && !message.internal)
    .flatMap(message =>
      Array.isArray(message.content) ? message.content.filter(part => part?.type === 'image_url') : [],
    );
}

const ORIGINAL_ATTACHMENT = /^original-[0-9a-f]{64}\.(png|jpg|webp)$/;

/** Accumulates streamed OpenAI-style tool-call deltas into complete calls. */
export function collectToolCalls(calls, delta) {
  for (const part of delta.tool_calls || []) {
    if (!Number.isInteger(part.index) || part.index < 0 || part.index > 7)
      throw problem('Appel d’outil invalide.', 502);
    const call = (calls[part.index] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
    if (part.id) call.id = part.id;
    if (part.function?.name) call.function.name += part.function.name;
    if (part.function?.arguments) call.function.arguments += part.function.arguments;
    if (call.function.arguments.length > 16000) throw problem('Paramètres d’outil trop longs.', 502);
  }
}

function parseArguments(call) {
  let args;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    throw problem('Le modèle a produit des paramètres d’outil invalides.', 502);
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw problem('Paramètres d’outil invalides.', 502);
  return args;
}

// What the worker is doing, in the user's words: a long stage is not a frozen bar.
const STAGE_LABELS = {
  'loading video prompt encoder': 'Chargement de l’encodeur de texte…',
  'encoding video prompt': 'Lecture du prompt…',
  'video prompt encoded': 'Chargement du modèle vidéo…',
  'encoding references': 'Préparation des images de référence…',
  'encoding source audio': 'Préparation du son de la vidéo source…',
  'loading video model': 'Chargement du modèle vidéo…',
  'sampling video': 'Chargement du modèle vidéo…',
  'upscaling video latents': 'Agrandissement de la première passe…',
  'refining video': 'Affinage en pleine taille…',
  'video sampled': 'Décodage de la vidéo…',
  'decoding video': 'Décodage de la vidéo…',
  'video decoded': 'Décodage du son…',
  'decoding audio': 'Décodage du son…',
  'audio decoded': 'Enregistrement de la vidéo…',
  'sending to ComfyUI': 'Envoi à ComfyUI…',
  'retrying without the video memory ceiling': 'Mémoire vidéo insuffisante : nouvel essai, plus lent…',
};
function progressLabel(value, video) {
  if (typeof value === 'string') return value;
  if (value.step) return `Génération · ${value.step}/${value.total}`;
  return STAGE_LABELS[value.stage] || (video ? 'Génération de la vidéo…' : 'Génération de l’image…');
}

/**
 * Turns one LLM tool call into an approved, executed generation:
 * request() validates and resolves it, execute() checks the approval, run() hands the GPU
 * over from the chat model to the generation worker and back.
 */
/**
 * The roles an input of `role` may take in this workflow: the slots for the same media, a
 * source video excepted (a continuation keeps its source). One entry means no choice.
 */
function referenceRoles(workflow, role) {
  const roles = family(workflow.pipeline).roles ?? {},
    media = roles[role]?.media;
  if (!media || role === 'source_video') return [];
  return [...new Set(workflow.references.map(slot => slot.role))]
    .filter(other => other !== 'source_video' && roles[other]?.media === media)
    .map(other => ({ role: other, label: roles[other].label || other }));
}

export class ToolRuntime {
  constructor({
    engine,
    catalog,
    gallery,
    resources,
    getConfig,
    engineConfig,
    saveConfig = async () => {},
    persist = () => false,
    clientFactory,
    sourceMedia,
    timing = null,
  }) {
    Object.assign(this, {
      engine,
      catalog,
      gallery,
      resources,
      getConfig,
      engineConfig,
      saveConfig,
      persist,
      clientFactory,
      sourceMedia,
      timing,
    });
    this.tools = new ToolCatalog(catalog);
    this.pending = new Map();
    this.turns = new Map();
    this.job = null;
    this.finished = Promise.resolve();
    this.closing = false;
    this.gpuBlocked = false;
  }

  get active() {
    return this.gpuBlocked || (!!this.job && !['done', 'error', 'cancelled'].includes(this.job.state));
  }

  status() {
    if (!this.job) return null;
    const { id, state, progress, error, record, warning, clock } = this.job;
    const fraction = clock ? clock.fraction(state) : null;
    return { id, state, progress, fraction, error, record, warning, blocked: this.gpuBlocked };
  }

  clear() {
    this.pending.clear();
    this.turns.clear();
    this.gallery.clearMemory?.();
    this.job = null;
  }

  forgetConversation(conversationId) {
    for (const [key, value] of this.pending) if (value.conversationId === conversationId) this.pending.delete(key);
    if (this.job?.record?.conversationId === conversationId && !this.active) this.job = null;
  }

  async request(calls, { conversationId, turnId, messages }) {
    if (this.closing) throw problem('L’application est en cours de fermeture.', 409);
    if (!this.getConfig().enabled) throw problem('La génération locale est désactivée.');
    if (!uuid.test(conversationId) || !uuid.test(turnId)) throw problem('Identifiant de conversation invalide.');
    if (calls.length !== 1 || !calls[0]?.id || !this.tools.isGenerationTool(calls[0].function?.name))
      throw problem('Le modèle doit demander une seule génération à la fois.', 502);
    if ((this.turns.get(turnId) || 0) >= this.getConfig().maxIterations)
      throw problem('La limite de générations pour ce message est atteinte.');

    const call = nativeFields({ role: 'assistant', tool_calls: calls }).tool_calls[0];
    let toolArgs = parseArguments(call);
    let args,
      notes = [],
      reused = null,
      // The seed the user named, when the model passed one.
      asked,
      // The picture format the user named, when the model passed one.
      format;
    const extending = call.function.name === 'extend_video' && toolArgs.reuse_output === undefined;
    if (extending) {
      const origin = await this.#continuationOrigin(toolArgs.source, conversationId);
      if (origin) {
        toolArgs = { ...toolArgs, source: origin.source };
        notes.push(origin.note);
      }
    }
    if (toolArgs.reuse_output !== undefined) {
      if (!uuid.test(toolArgs.reuse_output)) throw problem('Identifiant de brouillon invalide.');
      const draft = await this.gallery.get(conversationId, toolArgs.reuse_output, { includeImages: false });
      const { reuse_output, stage, intention, prompt } = toolArgs;
      args = {
        workflow_id: draft.workflowId,
        reuse_output,
        stage,
        intention,
        ...(prompt !== undefined ? { prompt } : {}),
      };
      for (const key of Object.keys(toolArgs))
        if (!['reuse_output', 'stage', 'intention', 'prompt'].includes(key))
          throw problem(
            'La version finale reprend les entrées du brouillon ; seuls le profil final et l’intention sont à fournir.',
          );
    } else {
      const routed = await this.tools.route(call.function.name, toolArgs, {
        mediaOf: source => this.#mediaOf(source, conversationId),
        // A new shot belongs to the model that generated the footage, even seen through an
        // upscale; another upscale or smoothing stays with the tool that made its source.
        originOf: source => this.#originOf(source, conversationId, !TRANSFORMS.has(call.function.name)),
      });
      args = routed.args;
      asked = routed.seed;
      format = routed.format;
      notes.push(...routed.notes);
    }
    const workflow = await this.catalog.read(args.workflow_id);
    // The next shot of a final video is a final one too, unless the model asked otherwise.
    if (extending && args.stage === undefined && workflow.parameters.stage?.policy === 'model') {
      const made = await this.#recordOf(toolArgs.source, conversationId);
      if (made?.workflowId === workflow.id && workflow.profiles?.[made.parameters?.stage])
        args.stage = made.parameters.stage;
    }
    const video = workflow.mediaType === 'video';
    if (args.reuse_output !== undefined) reused = await this.#draftToPromote(workflow, args, conversationId);
    if (reused)
      args = {
        ...structuredClone(reused.parameters.replay_args),
        stage: 'final',
        intention: args.intention,
        reuse_output: args.reuse_output,
      };

    const approvalArgs = structuredClone(args);
    const references = await this.#resolveReferences(workflow, args, { conversationId, messages });
    const sourceSize = await this.#sourceSize(workflow, args, conversationId);
    // The format of the picture: the one asked for; else the draft's own when it is promoted
    // (its final profile may be of another format); else that of the image the video starts from.
    const aspect = format
      ? { format }
      : reused && Number.isInteger(reused.parameters.width) && Number.isInteger(reused.parameters.height)
        ? { width: reused.parameters.width, height: reused.parameters.height }
        : await this.#frameSize(workflow, args, conversationId, messages);
    // A promoted draft keeps what the user changed on it, except its size: the final profile sets that.
    const { width, height, ...overrides } = reused?.parameters.user_overrides ?? {};
    const prepared = await this.catalog.prepare(args.workflow_id, args, {
      allowPendingReferences: true,
      // A promoted draft keeps its seed; otherwise the one the user named, or a drawn one.
      ...(reused ? { seed: reused.parameters.seed, overrides } : asked !== undefined ? { seed: asked } : {}),
      ...(sourceSize ? { sourceSize } : {}),
      ...(aspect ? { aspect } : {}),
    });
    // Refused now, before the user confirms and the chat model is unloaded.
    if (extending) {
      const format = await this.#videoFormat(toolArgs.source, conversationId);
      const fps = prepared.job.parameters.fps;
      if (format?.fps && Number.isFinite(fps) && Math.abs(format.fps - fps) > 0.01)
        throw problem(
          `Cette vidéo est à ${fpsText(format.fps)} images/s et ${workflow.name} génère à ${fpsText(fps)} images/s : elle ne peut pas être prolongée telle quelle.`,
        );
    }
    if (reused && JSON.stringify(prepared.job.components) !== JSON.stringify(reused.parameters.native_components))
      throw problem('Les composants du brouillon ont changé. Créez une nouvelle proposition.');

    const now = Date.now();
    for (const [key, pending] of this.pending) if (now - pending.created > APPROVAL_TTL_MS) this.pending.delete(key);
    if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value);

    return this.#propose(workflow, {
      call,
      args,
      digest: workflow.digest,
      conversationId,
      turnId,
      references,
      approvalArgs,
      video,
      prepared,
      notes,
      sourceSize,
      aspect,
      overrides: reused ? overrides : {},
    });
  }

  /** Stores a resolved proposal under a fresh request ID (and one-use video token) and describes it. */
  #propose(workflow, pending) {
    const requestId = randomUUID();
    // Every proposal carries a one-use token: required to run a video, and to edit any proposal.
    const approvalToken = randomUUID();
    const { prepared, args, references, approvalArgs, video, notes } = pending;
    const parameters = prepared.job.parameters;
    if (video) approvalArgs.stage = parameters.stage;
    this.pending.set(requestId, { ...pending, approvalToken, created: Date.now() });
    const continues = references.some(ref => ref.role === 'source_video');
    const roles = family(workflow.pipeline).roles ?? {};
    return structuredClone({
      requestId,
      call: pending.call,
      tool: pending.call.function.name,
      workflowName: workflow.name,
      args: approvalArgs,
      ...(notes.length ? { notes } : {}),
      resolution: { width: parameters.width, height: parameters.height },
      referenceCapacity: nativeWorkflowImageInputs(workflow).length,
      referenceCount: references.length,
      autoAllow: video ? false : this.getConfig().autoAllow,
      ...(video ? { mediaType: 'video' } : {}),
      approvalToken,
      plan: {
        defaultReferences: [],
        stage: parameters.stage,
        intention: args.intention,
        prompt: parameters.prompt,
        parameters,
        references: references.map(({ url, ...ref }) => ({ ...ref, roleLabel: roles[ref.role]?.label || ref.role })),
        editable: {
          // Per input, the roles it may take instead (same media, a slot in this workflow).
          references: references.map(ref => referenceRoles(workflow, ref.role)),
          prompt: workflow.parameters.prompt?.policy === 'model',
          stages:
            workflow.parameters.stage?.policy === 'model' && args.reuse_output === undefined
              ? Object.keys(workflow.profiles ?? {})
              : [],
          parameters: editableParameters(workflow, parameters, { continues }),
        },
        ...(Object.keys(pending.overrides).length ? { edited: Object.keys(pending.overrides) } : {}),
      },
    });
  }

  /**
   * The user's own changes to a video proposal, typed in the approval dialog: the prompt, the
   * draft/final profile and any listed parameter. The proposal is resolved again (same seed
   * unless changed) and replaced by a new one, with a new token, that the user still confirms.
   */
  async revise({ requestId, approvalToken, edits }) {
    if (this.closing) throw problem('L’application est en cours de fermeture.', 409);
    const pending = this.pending.get(requestId);
    if (!pending || Date.now() - pending.created > APPROVAL_TTL_MS)
      throw problem('Cet appel a expiré. Relance la demande.', 409);
    if (approvalToken !== pending.approvalToken) throw problem('Cette proposition ne peut plus être modifiée.', 403);
    if (!edits || typeof edits !== 'object' || Array.isArray(edits)) throw problem('Modifications invalides.');
    const workflow = await this.catalog.read(pending.args.workflow_id);
    if (workflow.digest !== pending.digest) throw problem('Le workflow a été modifié. Relance la demande.', 409);
    const { prompt, stage, references: roleEdits, ...changes } = edits;
    const args = structuredClone(pending.args),
      approvalArgs = structuredClone(pending.approvalArgs);
    let references = pending.references;
    if (roleEdits !== undefined) {
      ({ references } = this.#moveReferences(workflow, args, pending.references, roleEdits));
      approvalArgs.references = structuredClone(args.references);
    }
    if (prompt !== undefined) {
      if (workflow.parameters.prompt?.policy !== 'model') throw problem('Le prompt est fixé par ce workflow.');
      if (typeof prompt !== 'string' || !prompt.trim()) throw problem('Le prompt ne peut pas être vide.');
      args.prompt = approvalArgs.prompt = prompt;
    }
    if (stage !== undefined) {
      if (args.reuse_output !== undefined) throw problem('Une version finale reste en profil final.');
      if (workflow.parameters.stage?.policy !== 'model' || !workflow.profiles?.[stage])
        throw problem('Version indisponible pour ce workflow.');
      args.stage = approvalArgs.stage = stage;
    }
    const overrides = { ...pending.overrides, ...changes };
    let aspect = pending.aspect;
    const shown = pending.prepared.job.parameters;
    if (stage !== undefined && stage !== shown.stage && !pending.sourceSize) {
      // Another version has its own scale, not another format: the picture keeps the format the
      // window shows (the size the user chose there included), at the size of the new profile.
      const width = overrides.width ?? shown.width,
        height = overrides.height ?? shown.height;
      if (Number.isInteger(width) && Number.isInteger(height)) aspect = { width, height };
      delete overrides.width;
      delete overrides.height;
    }
    const options = {
      allowPendingReferences: true,
      seed: pending.prepared.job.parameters.seed,
      ...(pending.sourceSize ? { sourceSize: pending.sourceSize } : {}),
      ...(aspect ? { aspect } : {}),
    };
    let prepared;
    try {
      // A value set back to what the profile or the workflow gives is no longer an edit.
      const base = await this.catalog.prepare(args.workflow_id, args, options);
      for (const [key, value] of Object.entries(overrides))
        if (base.job.parameters[key] === value) delete overrides[key];
      prepared = await this.catalog.prepare(args.workflow_id, args, { ...options, overrides });
    } catch (error) {
      throw problem(error.message);
    }
    if (pending.args.reuse_output !== undefined && pending.prepared.job.components) {
      if (JSON.stringify(prepared.job.components) !== JSON.stringify(pending.prepared.job.components))
        throw problem('Les composants du brouillon ont changé. Créez une nouvelle proposition.');
    }
    this.pending.delete(requestId);
    return this.#propose(workflow, { ...pending, args, approvalArgs, prepared, overrides, references, aspect });
  }

  /**
   * The user gives an input another role (the model sent an image as a subject reference
   * where the user meant the first frame): each input takes the first free slot of its role.
   */
  #moveReferences(workflow, args, current, edits) {
    if (!Array.isArray(edits) || edits.length > current.length) throw problem('Rôles des entrées invalides.');
    const wanted = current.map(ref => ref.role);
    for (const edit of edits) {
      if (!edit || !Number.isInteger(edit.index) || !current[edit.index] || typeof edit.role !== 'string')
        throw problem('Rôles des entrées invalides.');
      if (!referenceRoles(workflow, current[edit.index].role).some(option => option.role === edit.role))
        throw problem(`« ${current[edit.index].label} » ne peut pas prendre ce rôle dans ${workflow.name}.`);
      wanted[edit.index] = edit.role;
    }
    const used = new Set(),
      roles = family(workflow.pipeline).roles ?? {};
    const inputs = wanted.map((role, index) => {
      const slot = workflow.references.find(item => item.role === role && !used.has(item.id));
      if (!slot)
        throw problem(
          `Plus de place pour « ${current[index].label} » comme ${(roles[role]?.label || role).toLowerCase()} dans ${workflow.name}.`,
        );
      used.add(slot.id);
      return slot.id;
    });
    if (!Array.isArray(args.references) || args.references.length !== current.length)
      throw problem('Rôles des entrées invalides.');
    args.references = args.references.map((ref, index) => ({ ...ref, input: inputs[index] }));
    return {
      references: current.map((ref, index) => ({ ...ref, input: inputs[index], role: wanted[index] })),
    };
  }

  async #draftToPromote(workflow, args, conversationId) {
    if (!workflow.profiles?.final) throw problem('Ce workflow ne définit pas de profil final.');
    if (!uuid.test(args.reuse_output)) throw problem('Identifiant de brouillon invalide.');
    const draft = await this.gallery.get(conversationId, args.reuse_output, { includeImages: false });
    if (
      draft.provider !== 'native' ||
      draft.mediaType !== 'video' ||
      draft.workflowId !== workflow.id ||
      draft.parameters.workflow_digest !== workflow.digest ||
      draft.parameters.stage !== 'draft' ||
      !draft.parameters.replay_args
    )
      throw problem('Ce brouillon ne peut pas être repris avec ce workflow.');
    const allowed = ['workflow_id', 'reuse_output', 'stage', 'intention', 'prompt'];
    if (
      args.stage !== 'final' ||
      Object.keys(args).some(key => !allowed.includes(key)) ||
      (args.prompt !== undefined && args.prompt !== draft.prompt)
    )
      throw problem(
        'La version finale reprend les entrées du brouillon ; seuls le profil final et l’intention sont à fournir.',
      );
    return draft;
  }

  async #recordOf(source, conversationId) {
    if (!uuid.test(source?.output ?? '')) return null;
    const record = await this.gallery.get(conversationId, source.output, { includeImages: false }).catch(() => null);
    return record?.provider === 'native' ? record : null;
  }

  /**
   * A video made by upscaling or smoothing another one shows the same footage in a format a
   * video model does not generate (larger, more frames per second): its continuation starts
   * from the video it was made from, found through the references kept with each result.
   * Slow motion is other footage (new timing), so it is its own source. Returns null when the
   * source is to be continued as it is.
   */
  async #continuationOrigin(source, conversationId) {
    let current = source;
    const undone = [];
    for (let depth = 0; depth < 8; depth++) {
      const record = await this.#recordOf(current, conversationId);
      if (
        record?.mediaType !== 'video' ||
        !transforms(record.parameters?.pipeline) ||
        record.parameters.mode === 'slow_motion'
      )
        break;
      const from = record.parameters.references?.find(ref => ref.role === 'source_video');
      const previous = from?.output_id
        ? { output: from.output_id, ...(from.output_index ? { index: from.output_index } : {}) }
        : from?.resource_id
          ? { resource: from.resource_id }
          : null;
      // The video it came from must still be there (same conversation, active resource).
      if (!previous || (await this.#mediaOf(previous, conversationId).catch(() => null)) !== 'video') break;
      undone.unshift(record.workflowName);
      current = previous;
    }
    if (!undone.length) return null;
    return {
      source: current,
      note: `La suite repart de la vidéo d’origine, avant « ${undone.join(' » puis « ')} » : un modèle vidéo prolonge au format de ses propres générations. Relancez Upscale ou Interpoler sur le résultat.`,
    };
  }

  /** Size and frame rate of a video source as far as its records tell (fps null when unknown). */
  async #videoFormat(source, conversationId, depth = 0) {
    if (source?.resource !== undefined) {
      const record = await this.resources?.activeRecord(source.resource).catch(() => null);
      return record ? { width: record.width, height: record.height, fps: null } : null;
    }
    const record = await this.#recordOf(source, conversationId);
    if (!record || record.mediaType !== 'video') return null;
    const output = record.outputs?.[source.index ?? 0] || {},
      parameters = record.parameters || {};
    let fps = Number.isFinite(parameters.fps) ? parameters.fps : null;
    if (fps === null && depth < 8 && transforms(parameters.pipeline)) {
      const from = parameters.references?.find(ref => ref.role === 'source_video');
      const previous = from?.output_id
        ? await this.#videoFormat({ output: from.output_id, index: from.output_index ?? 0 }, conversationId, depth + 1)
        : null;
      // Smoothing multiplies the frame rate; slow motion and upscaling keep it.
      if (previous?.fps)
        fps = previous.fps * (parameters.multiplier && parameters.mode !== 'slow_motion' ? parameters.multiplier : 1);
    }
    return { width: output.width ?? parameters.width, height: output.height ?? parameters.height, fps };
  }

  /** Workflow and model family that produced an earlier result, so a continuation can stay in them. */
  async #originOf(source, conversationId, generator = false) {
    let record = await this.#recordOf(source, conversationId);
    // An upscaled or smoothed result still belongs to the model that generated its footage.
    for (let depth = 0; generator && depth < 8 && record && transforms(record.parameters?.pipeline); depth++) {
      const from = record.parameters.references?.find(ref => ref.role?.startsWith('source'));
      const previous = from?.output_id ? await this.#recordOf({ output: from.output_id }, conversationId) : null;
      if (!previous) break;
      record = previous;
    }
    if (!record) return null;
    return { workflowId: record.workflowId, pipeline: record.parameters?.pipeline };
  }

  /**
   * Width and height of the video a continuation starts from, or null when unknown.
   * A continuation is generated at its source's own size: the profile size would not match
   * the source tail it has to land on.
   */
  async #sourceSize(workflow, args, conversationId) {
    const slots = new Map(workflow.references.map(slot => [slot.id, slot]));
    const source = nativeWorkflowReferences(workflow, args).find(ref => slots.get(ref.input)?.role === 'source_video');
    if (!source) return null;
    let width, height;
    if (source.output_id !== undefined) {
      const record = await this.gallery.get(conversationId, source.output_id, { includeImages: false });
      const output = record.outputs?.[source.output_index ?? 0] || {};
      width = output.width ?? record.parameters?.width;
      height = output.height ?? record.parameters?.height;
    } else if (source.resource_id !== undefined && this.resources) {
      ({ width, height } = await this.resources.activeRecord(source.resource_id));
    }
    return Number.isInteger(width) && Number.isInteger(height) ? { width, height } : null;
  }

  /** The size of the image a video starts from (else the one it ends on), to give the video its format. */
  async #frameSize(workflow, args, conversationId, messages) {
    if (workflow.mediaType !== 'video') return null;
    const slots = new Map(workflow.references.map(slot => [slot.id, slot]));
    const given = nativeWorkflowReferences(workflow, args);
    const source = ['start_image', 'end_image']
      .map(role => given.find(ref => slots.get(ref.input)?.role === role))
      .find(Boolean);
    if (!source) return null;
    try {
      let width, height;
      if (source.output_id !== undefined) {
        const record = await this.gallery.get(conversationId, source.output_id, { includeImages: false });
        const output = record.outputs?.[source.output_index ?? 0] || {};
        width = output.width ?? record.parameters?.width;
        height = output.height ?? record.parameters?.height;
      } else if (source.resource_id !== undefined && this.resources) {
        ({ width, height } = await this.resources.activeRecord(source.resource_id));
      } else if (source.image !== undefined) {
        const part = chatImageParts(messages)[source.image];
        const url = part?.image_url?.url;
        if (part?.file && ORIGINAL_ATTACHMENT.test(part.file) && this.sourceMedia) {
          const file = await this.sourceMedia({ attachment: part.file }, conversationId);
          try {
            const bytes = Buffer.alloc(Math.min(file.info?.size ?? 262144, 262144));
            await file.handle.read(bytes, 0, bytes.length, 0);
            ({ width, height } = imageSize(bytes) ?? {});
          } finally {
            await file.handle.close();
          }
        } else if (typeof url === 'string' && url.startsWith('data:image/'))
          ({ width, height } =
            imageSize(Buffer.from(url.slice(url.indexOf(',') + 1, url.indexOf(',') + 350000), 'base64')) ?? {});
      }
      return Number.isInteger(width) && Number.isInteger(height) ? { width, height } : null;
    } catch {
      // The format is a convenience: a source that cannot be measured keeps the profile's size.
      return null;
    }
  }

  /** Media type of a verb source: a chat image, an active resource (or one of its frames) or an earlier output. */
  async #mediaOf(source, conversationId) {
    if (source.image !== undefined) return 'image';
    if (source.resource !== undefined) {
      if (!this.resources) throw problem('La bibliothèque de ressources est indisponible.');
      const record = await this.resources.activeRecord(source.resource);
      return record.mime.startsWith('video/') && source.frame === undefined ? 'video' : 'image';
    }
    if (!uuid.test(source.output ?? '')) throw problem('Identifiant de sortie invalide.');
    const record = await this.gallery.get(conversationId, source.output, { includeImages: false });
    if (!record.outputs[source.index ?? 0]) throw problem('Sortie introuvable dans ce résultat.');
    return record.mediaType || 'image';
  }

  /**
   * Maps each requested slot to its pixels. Chat images and video frames are compressed copies;
   * resources and earlier outputs are passed as their original files, so an upscale or a
   * continuation never works from a reduced preview.
   */
  async #resolveReferences(workflow, args, { conversationId, messages }) {
    const slots = nativeWorkflowImageInputs(workflow);
    const chatImages = chatImageParts(messages);
    const resources = new Map();
    const references = [];
    for (const source of nativeWorkflowReferences(workflow, args)) {
      const slot = slots.find(item => item.id === source.input);
      const media = family(workflow.pipeline).roles[slot.role].media;
      // An attached image is passed as the file the user gave, never as the model's compressed copy.
      const attachment = source.image !== undefined && chatImages[source.image]?.file;
      if (attachment && ORIGINAL_ATTACHMENT.test(attachment)) {
        if (!this.sourceMedia) throw problem('Le fichier original de cette source est indisponible.');
        const file = await this.sourceMedia({ attachment }, conversationId);
        try {
          if (!file.mime.startsWith(media + '/'))
            throw problem(`${slot.name || slot.id} attend ${media === 'video' ? 'une vidéo' : 'une image'}.`);
          references.push({
            ...source,
            attachment,
            original: true,
            label: 'Image ' + (source.image + 1),
            role: slot.role,
          });
        } finally {
          await file.handle.close();
        }
        continue;
      }
      const original =
        source.output_id !== undefined || (source.resource_id !== undefined && source.frame === undefined);
      if (original) {
        if (!this.sourceMedia) throw problem('Le fichier original de cette source est indisponible.');
        const file = await this.sourceMedia(source, conversationId);
        try {
          if (!file.mime.startsWith(media + '/'))
            throw problem(`${slot.name || slot.id} attend ${media === 'video' ? 'une vidéo' : 'une image'}.`);
          references.push({ ...source, original: true, label: file.name || 'Résultat précédent', role: slot.role });
        } finally {
          await file.handle.close();
        }
        continue;
      }
      let url;
      let resource;
      if (source.resource_id !== undefined) {
        if (!this.resources) throw problem('La bibliothèque de ressources est indisponible.');
        if (!resources.has(source.resource_id))
          resources.set(source.resource_id, await this.resources.readActive(source.resource_id));
        resource = resources.get(source.resource_id);
        url = resource.frames[source.frame ?? 0]?.url;
      } else url = chatImages[source.image]?.image_url?.url;
      if (!url) throw problem('La référence demandée par le modèle est introuvable.');
      if (media !== 'image') throw problem(`${slot.name || slot.id} attend une vidéo originale.`);
      references.push({
        ...source,
        url,
        label: resource ? resource.label || resource.name : 'Image ' + (source.image + 1),
        role: slot.role,
        ...(resource ? { time: resource.frames[source.frame ?? 0]?.time } : {}),
      });
    }
    return references;
  }

  async execute({ requestId, permission, approvalToken }) {
    if (this.closing) throw problem('L’application est en cours de fermeture.', 409);
    if (this.active || this.engine.busy) throw problem('Une opération GPU est déjà en cours.', 409);
    const pending = this.pending.get(requestId);
    if (!pending || Date.now() - pending.created > APPROVAL_TTL_MS)
      throw problem('Cet appel a expiré. Relance la demande.', 409);
    const config = this.getConfig();
    if (!config.enabled) throw problem('La génération locale est désactivée.');
    if (pending.video && (permission !== 'once' || approvalToken !== pending.approvalToken))
      throw problem('Chaque vidéo nécessite une confirmation explicite de cette proposition.', 403);
    if (!config.autoAllow && !['once', 'always'].includes(permission))
      throw problem('Une autorisation est nécessaire.', 403);
    if ((this.turns.get(pending.turnId) || 0) >= config.maxIterations)
      throw problem('La limite de générations est atteinte.');

    const controller = new AbortController();
    let finish;
    this.finished = new Promise(resolve => {
      finish = resolve;
    });
    this.job = {
      id: randomUUID(),
      requestId,
      state: 'checking',
      progress: 'Vérification du moteur de génération…',
      controller,
    };
    this.pending.delete(requestId);
    let client;
    try {
      if ((await this.catalog.read(pending.args.workflow_id)).digest !== pending.digest)
        throw problem('Le workflow a été modifié. Une nouvelle autorisation est nécessaire.', 409);
      // The previous run of this workflow at this size paces the progress bar.
      this.job.timingKey = timingKey(
        pending.args.workflow_id,
        pending.prepared.job?.parameters,
        pending.references.length,
      );
      this.job.clock = new ProgressClock(await this.timing?.reference(this.job.timingKey).catch(() => null));
      await this.#checkResources(pending);
      client = this.clientFactory();
      if (!(await client.status({ signal: controller.signal })).idle)
        throw problem('Le moteur de génération exécute déjà une tâche. Attends sa fin.', 409);
      // The sources are staged first, so everything the worker can check without the GPU (a
      // source video of the wrong format, an unreadable image) fails here, while the chat
      // model is still loaded.
      const prepared = await this.#prepareJob(pending, client, controller.signal);
      await client.preflight(prepared.job, { signal: controller.signal });
      controller.signal.throwIfAborted();
      if (permission === 'always') await this.saveConfig({ ...config, autoAllow: true });
      controller.signal.throwIfAborted();
      this.turns.set(pending.turnId, (this.turns.get(pending.turnId) || 0) + 1);
      if (this.turns.size > 256) this.turns.delete(this.turns.keys().next().value);
      this.job.state = 'unloading';
      this.job.progress = 'Libération du modèle et du projecteur…';
      this.job.clock.mark('unloading');
      this.run(pending, client, controller, prepared).finally(finish);
      return this.status();
    } catch (error) {
      // Staged copies of the sources are removed with the worker's release.
      await client?.free({ signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS) }).catch(() => {});
      this.job.state = 'error';
      this.job.error = error.message;
      finish();
      throw error;
    }
  }

  /** The approved job with its sources staged where the worker reads them. */
  async #prepareJob(pending, client, signal) {
    const staged = await this.#stageReferences(pending, client, signal);
    const prepared = structuredClone(pending.prepared);
    const slots = nativeWorkflowImageInputs(prepared.workflow);
    prepared.job.references = pending.references.map(ref => ({
      input: ref.input,
      role: slots.find(slot => slot.id === ref.input)?.role || 'img2img',
      path: staged[ref.input].path,
    }));
    return prepared;
  }

  async #checkResources(pending) {
    for (const id of new Set(pending.references.map(ref => ref.resource_id).filter(Boolean)))
      await this.resources.activeRecord(id);
  }

  /** Writes reference pixels and source videos where the worker can read them. */
  async #stageReferences(pending, client, signal) {
    const staged = {};
    const uploaded = new Map();
    for (const [index, ref] of pending.references.entries()) {
      signal.throwIfAborted();
      if (ref.original) {
        staged[ref.input] = await client.stage(await this.sourceMedia(ref, pending.conversationId), { signal });
        continue;
      }
      if (!uploaded.has(ref.url)) {
        const png = ref.url.startsWith('data:image/png');
        uploaded.set(
          ref.url,
          await client.upload(Buffer.from(ref.url.split(',')[1], 'base64'), {
            filename: `atelier-${this.job.id}-${index}.${png ? 'png' : 'jpg'}`,
            mime: png ? 'image/png' : 'image/jpeg',
            signal,
          }),
        );
      }
      staged[ref.input] = uploaded.get(ref.url);
    }
    return staged;
  }

  async run(pending, client, controller, prepared) {
    const job = this.job;
    const signal = controller.signal;
    try {
      // The workflow may have been edited while the engine status was checked.
      if ((await this.catalog.read(pending.args.workflow_id)).digest !== pending.digest)
        throw problem('Le workflow a été modifié. Une nouvelle autorisation est nécessaire.', 409);
      await this.engine.stop();
      signal.throwIfAborted();
      await this.#checkResources(pending);
      prepared ??= await this.#prepareJob(pending, client, signal);
      if (prepared.workflow.digest !== pending.digest) throw problem('Le workflow a été modifié avant son exécution.');

      job.state = 'generating';
      job.progress = 'Génération en cours…';
      job.clock?.mark('generating');
      const started = Date.now();
      const result = await client.run(prepared.job, {
        signal,
        mediaType: pending.video ? 'video' : 'image',
        onProgress: value => {
          job.progress = progressLabel(value, pending.video);
          job.clock?.mark(milestone(value), value);
        },
      });
      job.record = await this.#saveRecord(pending, prepared, result, Date.now() - started);
    } catch (error) {
      job.error = signal.aborted ? 'Génération annulée.' : error.message;
    } finally {
      await this.#handBackGpu(job, client, pending.video, signal);
    }
  }

  async #saveRecord(pending, prepared, result, duration) {
    const { job: resolved, workflow } = prepared;
    const parameters = {
      ...resolved.parameters,
      reference_count: pending.references.length,
      reference_capacity: nativeWorkflowImageInputs(workflow).length,
      reference_mode: pending.references.length ? 'pixels' : 'not_provided',
      reference_default_count: 0,
      reference_defaults: [],
      workflow_digest: workflow.digest,
      generation_duration_ms: duration,
      runner_duration_ms: duration,
      pipeline: resolved.pipeline,
      loras: resolved.loras.map(({ id, strength }) => ({ id, strength })),
      references: pending.references.map(({ url, ...ref }) => ref),
      replay_args: structuredClone(pending.args),
      native_components: resolved.components,
      ...(pending.args.reuse_output ? { reused_from: pending.args.reuse_output } : {}),
      ...(result.metadata?.continuation ? { continuation: result.metadata.continuation } : {}),
      ...(Object.keys(pending.overrides ?? {}).length ? { user_overrides: structuredClone(pending.overrides) } : {}),
      ...(pending.notes?.length ? { routing_notes: [...pending.notes] } : {}),
    };
    // With prompt enhancement the image was generated from the rewritten prompt: keep it beside the request.
    const used = result.metadata?.parameters?.prompt;
    if (resolved.parameters.expandPrompt && typeof used === 'string' && used.trim())
      parameters.expanded_prompt = used.slice(0, 16000);
    delete parameters.prompt;
    const record = {
      ...(pending.video ? { mediaType: 'video' } : {}),
      provider: 'native',
      id: this.job.id,
      conversationId: pending.conversationId,
      workflowId: pending.args.workflow_id,
      workflowName: workflow.name,
      // Verbs without a prompt (upscale, interpolate) are labelled by what was done to which source.
      prompt:
        resolved.parameters.prompt ||
        [pending.call.function.name, ...pending.references.map(ref => ref.label)].join(' · '),
      parameters,
      createdAt: new Date().toISOString(),
      outputs: result.outputs.map(source => ({ source })),
    };
    const persist = this.persist();
    try {
      return await this.gallery.put(record, { persist });
    } catch (error) {
      if (!persist) throw error;
      this.job.warning = `Historique de l’image non enregistré : ${error.message} Les liens restent disponibles dans cette session.`;
      return this.gallery.put(record, { persist: false });
    }
  }

  /** Releases the generator, then reloads the chat model; a failed release blocks the GPU until recover(). */
  async #handBackGpu(job, client, video, signal) {
    job.executionError = job.error || '';
    job.state = 'releasing';
    job.progress = 'Libération du moteur de génération…';
    job.clock?.mark('releasing');
    let released = false;
    try {
      await client.free({ signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS) });
      released = true;
      this.gpuBlocked = false;
    } catch (error) {
      this.gpuBlocked = true;
      job.error = `${job.error || ''} Libération du moteur de génération non confirmée : ${error.message}`.trim();
    }
    if (released && !this.closing) {
      job.state = 'restarting';
      job.progress = 'Rechargement du modèle et de la vision…';
      job.clock?.mark('restarting');
      try {
        await this.engine.start(this.engineConfig());
        const deadline = Date.now() + RESTART_TIMEOUT_MS;
        while (this.engine.state === 'loading' && Date.now() < deadline && !this.closing) await delay(250);
        if (this.engine.state !== 'ready') throw Error(this.engine.error || 'Le modèle n’a pas redémarré.');
      } catch (error) {
        job.error = `${job.error || ''} ${error.message}`.trim();
      }
    }
    job.state = job.error ? (signal.aborted ? 'cancelled' : 'error') : 'done';
    job.progress = job.error || (video ? 'Vidéo prête pour vérification.' : 'Image prête pour vérification.');
    if (job.state === 'done' && job.clock && job.timingKey)
      await this.timing?.save(job.timingKey, job.clock.timeline()).catch(() => {});
  }

  async recover() {
    if (this.closing || !this.gpuBlocked || !this.job || !['error', 'cancelled'].includes(this.job.state))
      throw problem('Aucune libération à reprendre.', 409);
    const job = this.job;
    job.state = 'releasing';
    let finish;
    this.finished = new Promise(resolve => {
      finish = resolve;
    });
    try {
      await this.clientFactory().free({ signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS) });
      this.gpuBlocked = false;
      job.error = job.executionError || '';
      job.state = job.error ? (job.controller.signal.aborted ? 'cancelled' : 'error') : 'done';
      job.progress = job.error || 'GPU libéré. Le modèle peut redémarrer.';
      return this.status();
    } catch (error) {
      job.state = 'error';
      job.error = error.message;
      throw error;
    } finally {
      finish();
    }
  }

  cancel({ requestId, jobId } = {}) {
    if (requestId && !jobId && this.pending.delete(requestId)) return this.status();
    if ((requestId && this.job?.requestId !== requestId) || (jobId && this.job?.id !== jobId))
      throw problem('Cette génération n’est plus la tâche courante.', 409);
    this.job?.controller.abort();
    return this.status();
  }

  async close() {
    this.closing = true;
    this.cancel();
    await this.finished;
  }
}
