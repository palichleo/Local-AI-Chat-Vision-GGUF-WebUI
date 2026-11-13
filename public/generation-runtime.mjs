import { renderProposal } from './video-plan.mjs';
import { prepareStoryboard } from './resource-preparation.mjs';
import { compressImage } from './images.mjs';

/**
 * Chat-side generation flow: asks for approval, follows the job, prepares compressed
 * copies for the vision model and keeps the Output gallery in sync.
 */
export function setupGenerationRuntime({
  api,
  state,
  node,
  notice,
  onChange = () => {},
  openOutput,
  outputActions = null,
  onOutput = () => {},
  // A video proposal left untouched starts by itself after this delay (0: never).
  confirmDelay = 30000,
  // Whether the « Créations » tab is on screen: closed, it is drawn when it opens, not before.
  isShown = () => true,
}) {
  const $ = id => document.getElementById(id);
  let urls = [],
    galleryVersion = 0;
  // The place whose creations the « Créations » tab lists: the open conversation, in the chat as
  // in its Studio; or the former Studio, which had no conversation, while its Sortie shows it.
  const place = () =>
    state.view === 'studio' && state.studioLegacy
      ? { id: state.studioId ?? null, studio: true }
      : { id: state.conversationId, studio: false };
  function reset() {
    for (const media of $('gallery-list').querySelectorAll('video, audio')) media.pause();
    galleryVersion++;
    for (const url of urls) URL.revokeObjectURL(url);
    urls = [];
    $('gallery-list').replaceChildren(
      node(
        'p',
        'asset-empty',
        place().studio
          ? 'Aucune création dans le Studio pour l’instant.'
          : 'Aucune génération dans cette conversation.',
      ),
    );
  }
  async function original(record, index, signal) {
    return (await api(`gallery/${record.conversationId}/${record.id}/${index}`, undefined, { signal })).blob();
  }
  async function renderGallery(conversationId) {
    if (conversationId && conversationId !== place().id) return;
    // The files panel is closed: nothing to draw (it is drawn as it opens).
    if (!isShown()) return;
    reset();
    const version = galleryVersion;
    if (!conversationId) return;
    const result = await (await api(`gallery/${conversationId}`)).json();
    if (version !== galleryVersion || conversationId !== place().id) return;
    // Upscale, Interpoler and Prolonger are written to the open conversation: a creation of the
    // Studio, which has its own buttons in its view, only shows its details from here.
    const actions = place().studio ? null : outputActions;
    if (result.runs.length) $('gallery-list').replaceChildren();
    for (const record of result.runs) {
      for (const [index, output] of record.outputs.entries()) {
        const card = node('article', 'gallery-card');
        if (record.mediaType === 'video' && output.originalUrl) {
          const video = node('video');
          video.controls = true;
          // Without this session's copy as a poster, the first frame comes from the original.
          video.preload = output.analysisDataUrl ? 'none' : 'metadata';
          video.playsInline = true;
          video.src = output.originalUrl;
          if (output.analysisDataUrl) video.poster = output.analysisDataUrl;
          card.append(video);
        }
        if (record.mediaType === 'audio' && output.originalUrl) {
          const audio = node('audio');
          audio.controls = true;
          audio.preload = 'metadata';
          audio.src = output.originalUrl;
          card.append(audio);
        }
        // The user sees the original; the model's compressed copy only exists in this session.
        const still = !['video', 'audio'].includes(record.mediaType) && (output.originalUrl || output.analysisDataUrl);
        if (still) {
          const img = node('img');
          img.loading = 'lazy';
          img.decoding = 'async';
          img.src = still;
          img.alt = record.prompt;
          img.onclick = () => openOutput(record, index);
          card.append(img);
        }
        const prompt = node('details', 'output-prompt'),
          summary = node('summary');
        summary.setAttribute('aria-label', 'Afficher ou réduire le prompt');
        summary.append(node('span', '', record.prompt));
        prompt.append(summary);
        card.append(node('strong', '', record.workflowName), prompt);
        if (record.parameters.expanded_prompt) {
          const expanded = node('details', 'output-prompt output-prompt-enhanced'),
            label = node('summary');
          label.append(node('span', '', 'Prompt amélioré : ' + record.parameters.expanded_prompt));
          label.setAttribute('aria-label', 'Afficher ou réduire le prompt amélioré');
          expanded.append(label);
          card.append(expanded);
        }
        card.append(node('small', '', new Date(record.createdAt).toLocaleString('fr-FR')));
        const labels = { reviewed: 'Analyse disponible', correction_requested: 'Nouvelle génération demandée' };
        card.append(
          node(
            'small',
            'gallery-meta',
            [
              record.mediaType === 'video' ? (record.parameters.stage === 'draft' ? 'Brouillon' : 'Vidéo finale') : '',
              record.parameters.seed === undefined ? '' : `Seed : ${record.parameters.seed}`,
              labels[record.analysis?.status] || '',
            ]
              .filter(Boolean)
              .join(' · '),
          ),
        );
        if (record.analysis?.text) {
          const details = node('details', 'gallery-review');
          details.append(node('summary', '', 'Analyse du modèle'), node('p', '', record.analysis.text));
          card.append(details);
        }
        if (actions) card.append(actions(record, index));
        else {
          const details = node('button', 'secondary', 'Détails');
          details.type = 'button';
          details.onclick = () => openOutput(record, index);
          card.append(details);
        }
        $('gallery-list').append(card);
      }
    }
  }
  /**
   * The proposal, editable in place. A video starts by itself after CONFIRM_DELAY unless the
   * user does anything in the window (a click, a key): the countdown fills its button.
   */
  async function permission(request, signal) {
    const video = request.mediaType === 'video',
      // A sound is confirmed like a video (its lyrics and length are worth a look), without the countdown.
      confirmed = video || request.mediaType === 'audio';
    if (request.autoAllow && !confirmed) return undefined;
    const title = () =>
      ($('tool-title').textContent = video
        ? request.plan?.stage === 'draft'
          ? 'Brouillon vidéo · Confirmer ?'
          : 'Vidéo finale · Confirmer ?'
        : confirmed
          ? 'Son · Confirmer ?'
          : 'Autoriser la génération ?');
    const planned = Boolean(request.plan);
    $('tool-arguments').hidden = planned;
    $('tool-plan').hidden = !planned;
    $('tool-always').hidden = confirmed;
    $('tool-deny').textContent = confirmed ? 'Annuler' : 'Refuser';
    $('tool-once').textContent = confirmed ? 'Confirmer et générer' : 'Cette fois';
    $('tool-once').title =
      video && confirmDelay > 0
        ? `Se lance seul après ${Math.round(confirmDelay / 1000)} s, sauf si vous touchez à la fenêtre`
        : '';
    let form = null,
      saving = false;
    function render() {
      title();
      $('tool-name').textContent = request.workflowName;
      $('tool-arguments').textContent =
        JSON.stringify(request.args, null, 2) + (request.notes?.length ? '\n\n' + request.notes.join('\n') : '');
      form = planned
        ? renderProposal($('tool-plan'), request, { node, onStage: (stage, edits) => void revise({ ...edits, stage }) })
        : null;
    }
    function busy(value) {
      saving = value;
      for (const id of ['tool-once', 'tool-always']) $(id).disabled = value;
    }
    // Sends the edits; the revised proposal (new token) replaces this one.
    async function revise(edits) {
      if (saving) return false;
      busy(true);
      try {
        const revised = await (
          await api('tools/revise', { requestId: request.requestId, approvalToken: request.approvalToken, edits })
        ).json();
        if (signal.aborted) return false;
        Object.assign(request, revised);
        render();
        return true;
      } catch (error) {
        form?.error(error.message);
        return false;
      } finally {
        busy(false);
      }
    }
    render();
    $('tool-dialog').showModal();
    return new Promise((resolve, reject) => {
      let timer = null;
      const stopCountdown = () => {
        clearTimeout(timer);
        timer = null;
        $('tool-once').classList?.remove('is-counting');
        $('tool-dialog').removeEventListener('pointerdown', stopCountdown, true);
        $('tool-dialog').removeEventListener('keydown', stopCountdown, true);
      };
      const finish = value => {
        cleanup();
        resolve(value);
      };
      // Confirming applies what the user changed first: what runs is what the window shows.
      async function confirm(decision) {
        if (saving) return;
        if (form) {
          let edits;
          try {
            edits = form.edits();
          } catch (error) {
            form.error(error.message);
            return;
          }
          if (Object.keys(edits).length && !(await revise(edits))) return;
        }
        finish(decision);
      }
      const cancel = event => {
        event?.preventDefault();
        finish('deny');
      };
      const abort = () => {
        cleanup();
        reject(signal.reason || new DOMException('Annulé', 'AbortError'));
      };
      function cleanup() {
        stopCountdown();
        $('tool-dialog').close();
        signal.removeEventListener('abort', abort);
        $('tool-dialog').removeEventListener('cancel', cancel);
        for (const [id] of buttons) $(id).onclick = null;
      }
      const buttons = [
        ['tool-deny', () => finish('deny')],
        ['tool-once', () => void confirm('once')],
        ['tool-always', () => void confirm('always')],
      ];
      for (const [id, action] of buttons) $(id).onclick = action;
      $('tool-dialog').addEventListener('cancel', cancel);
      signal.addEventListener('abort', abort, { once: true });
      if (video && confirmDelay > 0) {
        $('tool-once').style?.setProperty('--countdown', confirmDelay + 'ms');
        $('tool-once').classList?.add('is-counting');
        $('tool-dialog').addEventListener('pointerdown', stopCountdown, true);
        $('tool-dialog').addEventListener('keydown', stopCountdown, true);
        timer = setTimeout(() => {
          timer = null;
          void confirm('once');
        }, confirmDelay);
      }
      if (signal.aborted) abort();
    });
  }
  async function saveReview(record, text, status) {
    await api('gallery/review', { id: record.id, conversationId: record.conversationId, text, status });
    await renderGallery(record.conversationId);
  }
  /**
   * `confirmed`: the user started this very action with a button (Upscale, Interpoler, or
   * « Générer » in the Studio), which is their confirmation; a proposal coming from the model
   * asks, in the window of confirmation or, with `approve`, in the Studio (the answer:
   * 'once' or 'deny'). `studio`: started from the Studio, whose generator stays loaded after it.
   */
  async function requestTool(
    request,
    signal,
    onProgress,
    onImage = () => {},
    // `review`: the storyboard of a generated video is handed to the model with the result.
    { confirmed = false, review = true, approve = null, studio = false } = {},
  ) {
    const cancel = () => api('tools/cancel', { requestId: request.requestId }).catch(() => {});
    let decision;
    try {
      decision = confirmed ? 'once' : approve ? await approve(request, signal) : await permission(request, signal);
      signal.throwIfAborted();
    } catch (error) {
      await cancel();
      throw error;
    }
    if (decision === 'deny') {
      await cancel();
      return {
        content: JSON.stringify({
          status: 'denied',
          message: 'L’utilisateur a refusé cette génération. Ne réessaie pas sans nouvelle demande.',
        }),
        images: [],
        denied: true,
      };
    }
    signal.throwIfAborted();
    signal.addEventListener('abort', cancel, { once: true });
    let terminal = false,
      originalsTask;
    const originalsController = new AbortController(),
      originalsSignal = AbortSignal.any([signal, originalsController.signal]);
    function receiveOriginals(record) {
      if (originalsTask) return;
      if (record.conversationId !== state.conversationId)
        throw Error('Cette sortie ne correspond pas à la conversation courante.');
      // Made in the Studio, with no model to look at it now: no copy for it, no original to
      // download; the card shows its file. The copies are made from the original when asked.
      if (studio && !review) {
        for (const [index] of record.outputs.entries()) onImage({ record, index });
        originalsTask = Promise.resolve({ prepared: [], errors: [] });
        return;
      }
      // Transfer and compress one original at a time, including large workflow batches.
      originalsTask = (async () => {
        const prepared = [],
          errors = [];
        for (const [index, output] of record.outputs.entries()) {
          try {
            originalsSignal.throwIfAborted();
            const played = ['video', 'audio'].includes(record.mediaType),
              blob = played ? null : await original(record, index, originalsSignal);
            try {
              onImage({ record, index, blob });
            } catch (error) {
              notice('Affichage de l’original indisponible : ' + error.message);
            }
            // A sound reaches the model as its description only: it cannot hear it.
            if (record.mediaType === 'audio') continue;
            if (record.mediaType === 'video') {
              if (!output.originalUrl) throw Error('Lien de lecture vidéo indisponible.');
              const video = await prepareStoryboard(output.originalUrl, {
                signal: originalsSignal,
                name: output.source.filename,
                fps: record.parameters.fps || 24,
              });
              prepared[index] = {
                url: video.frames[0].url,
                width: video.width,
                height: video.height,
                frames: video.frames,
                storyboard: video.storyboard,
              };
            } else {
              const image = await compressImage(blob, { name: output.source.filename, count: record.outputs.length });
              prepared[index] = { url: image.url, width: image.width, height: image.height };
            }
          } catch (error) {
            originalsSignal.throwIfAborted();
            errors.push(`Sortie ${index + 1} : ${error.message}`);
          }
        }
        return { prepared, errors };
      })().catch(error => ({ error }));
    }
    try {
      let job = await (
        await api('tools/execute', {
          requestId: request.requestId,
          permission: decision,
          ...(['video', 'audio'].includes(request.mediaType) ? { approvalToken: request.approvalToken } : {}),
          ...(studio ? { studio: true } : {}),
        })
      ).json();
      if (signal.aborted) {
        cancel();
        signal.throwIfAborted();
      }
      const jobId = job.id;
      while (!['done', 'error', 'cancelled'].includes(job.state)) {
        if (job.record) receiveOriginals(job.record);
        signal.throwIfAborted();
        onProgress(job.progress, job.fraction, job.previewUrl);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort);
            resolve();
          }, 700);
          const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          signal.addEventListener('abort', abort, { once: true });
        });
        job = await (await api('tools/job', undefined, { signal })).json();
        if (job?.id !== jobId) throw Error('La génération suivie a été remplacée par une autre tâche.');
      }
      terminal = true;
      if (!job.record)
        return {
          content: JSON.stringify({
            status: 'error',
            message: job.error,
            note: 'La génération a échoué et rien n’a été produit. Aucun outil n’est disponible pour la suite de ce message : explique l’échec à l’utilisateur en une ou deux phrases, sans écrire d’appel d’outil. Il relancera s’il le souhaite.',
          }),
          images: [],
          failed: true,
          error: job.error,
        };
      const record = job.record;
      receiveOriginals(record);
      if (record.conversationId !== state.conversationId)
        throw Error('Cette sortie ne correspond pas à la conversation courante.');
      const showGallery = () =>
        renderGallery(record.conversationId).catch(error => notice(`Galerie indisponible : ${error.message}`));
      await showGallery();
      // The Studio shows its creation on its own screen: the files panel stays as it is.
      if (!studio) onOutput();
      if (job.warning) notice(job.warning);
      let images = [],
        dimensions = record.outputs.map(() => null),
        frames = record.outputs.map(() => null),
        storyboards = record.outputs.map(() => null),
        analysisOutputs = [],
        error =
          job.state === 'done' ? '' : job.error || 'La génération a été interrompue après production de la sortie.';
      onProgress('Préparation des copies pour la vision…');
      try {
        const originals = await originalsTask;
        if (originals.error) throw originals.error;
        if (originals.errors?.length) {
          error = [error, originals.errors.join(' ')].filter(Boolean).join(' ');
          notice('Certaines sorties ne peuvent pas être analysées : ' + originals.errors.join(' '));
        }
        for (let index = 0; index < record.outputs.length; index++) {
          signal.throwIfAborted();
          const image = originals.prepared[index];
          if (!image) continue;
          // A video reaches the model as one storyboard image; an image as its compressed copy.
          const copies = image.storyboard ? [image.storyboard.url] : [image.url];
          analysisOutputs.push({
            output_index: index,
            image_indices: copies.map((_, offset) => images.length + offset),
          });
          frames[index] = image.frames || null;
          storyboards[index] = image.storyboard || null;
          images.push(...copies);
          record.outputs[index].analysisDataUrl = image.url;
          const size = image.width && image.height ? { width: image.width, height: image.height } : null;
          dimensions[index] = size;
          if (size) Object.assign(record.outputs[index], size);
        }
      } catch (failure) {
        if (signal.aborted) throw failure;
        images = [];
        error = [error, `Sortie générée, mais copie pour l’analyse indisponible : ${failure.message}`]
          .filter(Boolean)
          .join(' ');
        notice(error);
      }
      signal.throwIfAborted();
      if (images.length) {
        try {
          await api(
            'gallery/analysis',
            {
              conversationId: record.conversationId,
              id: record.id,
              images: record.outputs.map(output => output.analysisDataUrl ?? null),
              dimensions,
              ...(record.mediaType === 'video' ? { frames } : {}),
            },
            { signal },
          );
        } catch (failure) {
          if (signal.aborted) throw failure;
          notice(`Copies d’analyse non enregistrées : ${failure.message}`);
        }
      }
      await showGallery();
      return {
        content: JSON.stringify({
          status: error ? 'generated' : 'success',
          run_id: record.id,
          // Made in the Studio: the conversation shows it as a card.
          ...(studio ? { studio: true } : {}),
          use_as_source: { output: record.id },
          workflow: record.workflowName,
          prompt: record.prompt,
          workflow_id: record.workflowId,
          workflow_digest: record.parameters.workflow_digest,
          media_type: record.mediaType || 'image',
          parameters: Object.fromEntries(
            Object.entries(record.parameters).filter(([key]) =>
              [
                'workflow_id',
                'seed',
                'width',
                'height',
                'frames',
                'fps',
                'seconds',
                'language',
                'negative_prompt',
                'references',
                'reference_image',
                'reference_resource',
                'reference_frame',
                'routing_notes',
                'user_overrides',
              ].includes(key),
            ),
          ),
          reference_default_count: record.parameters.reference_default_count ?? 0,
          reference_defaults: record.parameters.reference_defaults || [],
          ...(record.mediaType === 'video' ? { stage: record.parameters.stage } : {}),
          ...(record.mediaType === 'video' && review
            ? {
                analysis_outputs: analysisOutputs,
                storyboards: storyboards.map((board, index) => ({
                  output: index,
                  layout: board ? `${board.columns}x${board.rows}` : null,
                  times: board?.times.map(time => Math.round(time * 100) / 100) || [],
                })),
                inspection_limit:
                  'Each attached image is a storyboard of one output: frames read left to right then top to bottom, each stamped with its order and time in seconds. It shows the progression of the clip, not continuous motion; no audio.',
              }
            : {}),
          reference_count: record.parameters?.reference_count ?? null,
          reference_capacity: record.parameters?.reference_capacity ?? null,
          reference_mode: record.parameters?.reference_mode || 'unknown',
          outputs: record.outputs.map(o => o.source),
          ...(error ? { warning: error } : {}),
          note:
            record.mediaType === 'audio'
              ? 'Son généré et proposé à l’écoute de l’utilisateur. Tu ne peux pas l’entendre : n’écris ni commentaire ni description, ton texte ne serait pas affiché. Si la demande exige encore une génération, appelle l’outil ; chaque son demande la confirmation de l’utilisateur. Sinon termine sans texte.'
              : record.mediaType !== 'video'
                ? 'Image générée et affichée à l’utilisateur. Tu ne l’as pas vue : n’écris ni commentaire ni description, ton texte ne serait pas affiché. Si la demande exige encore une génération, appelle l’outil. Si l’utilisateur a demandé une vérification, consulte la copie compressée avec local_read_output (run_id et output_index), sans demander son identifiant. Sinon termine sans texte.'
                : !review
                  ? 'Vidéo générée et affichée à l’utilisateur. Tu ne l’as pas vue : n’écris ni commentaire ni description, ton texte ne serait pas affiché. Si la demande exige encore une génération, appelle l’outil ; chaque vidéo demande la confirmation de l’utilisateur. Si l’utilisateur demande une vérification, consulte sa planche d’images avec local_read_output (run_id et output_index), sans demander son identifiant. Sinon termine sans texte.'
                  : images.length
                    ? 'Les images jointes sont les copies réduites des sorties identifiées par analysis_outputs (indices à partir de zéro). Les sorties sans copie ne sont pas vérifiables visuellement. Les entrées optionnelles absentes conservent leurs valeurs dans le workflow ; elles ne sont pas des références fournies par l’utilisateur. Les originaux sont dans la galerie.'
                    : 'Les originaux sont dans la galerie. Aucune copie visuelle n’est disponible pour vérifier le résultat.',
        }),
        images,
        record,
        failed: !!error,
        error,
      };
    } catch (error) {
      if (!terminal) cancel();
      if (signal.aborted) throw signal.reason;
      throw error;
    } finally {
      originalsController.abort();
      signal.removeEventListener('abort', cancel);
      onChange();
    }
  }
  return { reset, renderGallery, requestTool, saveReview };
}
