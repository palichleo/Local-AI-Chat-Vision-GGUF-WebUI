import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { problem } from './engine.mjs';
import { nativeFields } from './native-messages.mjs';
import { editableParameters, nativeWorkflowReferences, nativeWorkflowImageInputs } from './native-workflows.mjs';
import { family } from './families.mjs';
import { ToolCatalog } from './tool-catalog.mjs';
import { ProgressClock, milestone, timingKey } from './generation-progress.mjs';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const APPROVAL_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING = 32;
const RELEASE_TIMEOUT_MS = 90_000;
const RESTART_TIMEOUT_MS = 300_000;

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
    .flatMap(message => (Array.isArray(message.content) ? message.content.filter(part => part?.type === 'image_url') : []));
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

function progressLabel(value, video) {
  if (typeof value === 'string') return value;
  if (value.step) return `Génération · ${value.step}/${value.total}`;
  return video ? 'Génération de la vidéo…' : 'Génération de l’image…';
}

/**
 * Turns one LLM tool call into an approved, executed generation:
 * request() validates and resolves it, execute() checks the approval, run() hands the GPU
 * over from the chat model to the generation worker and back.
 */
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
    const toolArgs = parseArguments(call);
    let args,
      notes = [],
      reused = null;
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
        originOf: source => this.#originOf(source, conversationId),
      });
      ({ args, notes } = routed);
    }
    const workflow = await this.catalog.read(args.workflow_id);
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
    // A promoted draft keeps what the user changed on it, except its size: the final profile sets that.
    const { width, height, ...overrides } = reused?.parameters.user_overrides ?? {};
    const prepared = await this.catalog.prepare(args.workflow_id, args, {
      allowPendingReferences: true,
      ...(reused ? { seed: reused.parameters.seed, overrides } : {}),
      ...(sourceSize ? { sourceSize } : {}),
    });
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
        references: references.map(({ url, ...ref }) => ref),
        editable: {
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
    const { prompt, stage, ...changes } = edits;
    const args = structuredClone(pending.args),
      approvalArgs = structuredClone(pending.approvalArgs);
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
    const options = {
      allowPendingReferences: true,
      seed: pending.prepared.job.parameters.seed,
      ...(pending.sourceSize ? { sourceSize: pending.sourceSize } : {}),
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
    return this.#propose(workflow, { ...pending, args, approvalArgs, prepared, overrides });
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

  /** Workflow and model family that produced an earlier result, so a continuation can stay in them. */
  async #originOf(source, conversationId) {
    if (!uuid.test(source.output ?? '')) return null;
    const record = await this.gallery.get(conversationId, source.output, { includeImages: false }).catch(() => null);
    if (record?.provider !== 'native') return null;
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
        role: slot.description || 'Référence',
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
      const client = this.clientFactory();
      if (!(await client.status({ signal: controller.signal })).idle)
        throw problem('Le moteur de génération exécute déjà une tâche. Attends sa fin.', 409);
      await client.preflight({ ...pending.prepared.job, references: [] }, { signal: controller.signal });
      controller.signal.throwIfAborted();
      if (permission === 'always') await this.saveConfig({ ...config, autoAllow: true });
      controller.signal.throwIfAborted();
      this.turns.set(pending.turnId, (this.turns.get(pending.turnId) || 0) + 1);
      if (this.turns.size > 256) this.turns.delete(this.turns.keys().next().value);
      this.job.state = 'unloading';
      this.job.progress = 'Libération du modèle et du projecteur…';
      this.job.clock.mark('unloading');
      this.run(pending, client, controller).finally(finish);
      return this.status();
    } catch (error) {
      this.job.state = 'error';
      this.job.error = error.message;
      finish();
      throw error;
    }
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

  async run(pending, client, controller) {
    const job = this.job;
    const signal = controller.signal;
    try {
      // The workflow may have been edited while the engine status was checked.
      if ((await this.catalog.read(pending.args.workflow_id)).digest !== pending.digest)
        throw problem('Le workflow a été modifié. Une nouvelle autorisation est nécessaire.', 409);
      await this.engine.stop();
      signal.throwIfAborted();
      await this.#checkResources(pending);
      const staged = await this.#stageReferences(pending, client, signal);
      const prepared = structuredClone(pending.prepared);
      const slots = nativeWorkflowImageInputs(prepared.workflow);
      prepared.job.references = pending.references.map(ref => ({
        input: ref.input,
        role: slots.find(slot => slot.id === ref.input)?.role || 'img2img',
        path: staged[ref.input].path,
      }));
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
