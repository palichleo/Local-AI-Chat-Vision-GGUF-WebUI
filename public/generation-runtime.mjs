import { renderVideoPlan } from './video-plan.mjs';
import { prepareVideo } from './resource-preparation.mjs';
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
  onOutput = () => {},
}) {
  const $ = id => document.getElementById(id);
  let urls = [],
    galleryVersion = 0;
  function reset() {
    for (const video of $('gallery-list').querySelectorAll('video')) video.pause();
    galleryVersion++;
    for (const url of urls) URL.revokeObjectURL(url);
    urls = [];
    $('gallery-list').replaceChildren(node('p', 'asset-empty', 'Aucune génération dans cette conversation.'));
  }
  async function original(record, index, signal) {
    return (await api(`gallery/${record.conversationId}/${record.id}/${index}`, undefined, { signal })).blob();
  }
  async function renderGallery(conversationId) {
    if (conversationId && conversationId !== state.conversationId) return;
    reset();
    const version = galleryVersion;
    if (!conversationId) return;
    const result = await (await api(`gallery/${conversationId}`)).json();
    if (version !== galleryVersion || conversationId !== state.conversationId) return;
    if (result.runs.length) $('gallery-list').replaceChildren();
    for (const record of result.runs) {
      for (const [index, output] of record.outputs.entries()) {
        const card = node('article', 'gallery-card');
        if (record.mediaType === 'video' && output.originalUrl) {
          const video = node('video');
          video.controls = true;
          video.preload = 'none';
          video.playsInline = true;
          video.src = output.originalUrl;
          if (output.analysisDataUrl) video.poster = output.analysisDataUrl;
          card.append(video);
        }
        if (output.analysisDataUrl && record.mediaType !== 'video') {
          const img = node('img');
          img.loading = 'lazy';
          img.decoding = 'async';
          img.src = output.analysisDataUrl;
          img.alt = record.prompt;
          img.onclick = () => openOutput(record, index);
          card.append(img);
        }
        const prompt = node('details', 'output-prompt'),
          summary = node('summary');
        summary.setAttribute('aria-label', 'Afficher ou réduire le prompt');
        summary.append(node('span', '', record.prompt));
        prompt.append(summary);
        card.append(
          node('strong', '', record.workflowName),
          prompt,
          node('small', '', new Date(record.createdAt).toLocaleString('fr-FR')),
        );
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
        const actions = node('div', 'gallery-actions');
        for (const download of [false, true]) {
          const button = node('button', 'secondary', download ? 'Télécharger' : 'Details');
          button.type = 'button';
          button.onclick = async () => {
            if (!download) {
              await openOutput(record, index);
              return;
            }
            button.disabled = true;
            try {
              const blob = record.mediaType === 'video' ? null : await original(record, index);
              const url = blob ? URL.createObjectURL(blob) : output.originalUrl;
              if (blob) urls.push(url);
              const a = node('a');
              a.href = url;
              a.download = output.source.filename;
              a.click();
            } catch (error) {
              notice(`Original indisponible : ${error.message}`);
            } finally {
              button.disabled = false;
            }
          };
          actions.append(button);
        }
        card.append(actions);
        $('gallery-list').append(card);
      }
    }
  }
  async function permission(request, signal) {
    const video = request.mediaType === 'video';
    if (request.autoAllow && !video) return undefined;
    $('tool-title').textContent = video
      ? request.plan?.stage === 'draft'
        ? 'Brouillon vidéo · Confirmer ?'
        : 'Vidéo finale · Confirmer ?'
      : 'Autoriser la génération ?';
    $('tool-name').textContent = request.workflowName;
    $('tool-arguments').textContent = JSON.stringify(request.args, null, 2);
    $('tool-arguments').hidden = video;
    $('tool-plan').hidden = !video;
    $('tool-always').hidden = video;
    $('tool-always').disabled = video;
    $('tool-revise').hidden = !video;
    $('tool-once').textContent = video ? 'Confirmer et générer' : 'Cette fois';
    $('tool-deny').textContent = video ? 'Annuler' : 'Refuser';
    if (video) renderVideoPlan($('tool-plan'), request, node);
    $('tool-dialog').showModal();
    return new Promise((resolve, reject) => {
      const finish = value => {
        cleanup();
        resolve(value);
      };
      const cancel = event => {
        event?.preventDefault();
        finish('deny');
      };
      const abort = () => {
        cleanup();
        reject(signal.reason || new DOMException('Annulé', 'AbortError'));
      };
      function cleanup() {
        $('tool-dialog').close();
        signal.removeEventListener('abort', abort);
        $('tool-dialog').removeEventListener('cancel', cancel);
        for (const [id] of buttons) $(id).onclick = null;
      }
      const buttons = [
        ['tool-deny', 'deny'],
        ['tool-once', 'once'],
        ['tool-always', 'always'],
        ['tool-revise', 'revise'],
      ];
      for (const [id, value] of buttons) $(id).onclick = () => finish(value);
      $('tool-dialog').addEventListener('cancel', cancel);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  async function saveReview(record, text, status) {
    await api('gallery/review', { id: record.id, conversationId: record.conversationId, text, status });
    await renderGallery(record.conversationId);
  }
  async function requestTool(request, signal, onProgress, onImage = () => {}) {
    const cancel = () => api('tools/cancel', { requestId: request.requestId }).catch(() => {});
    let decision;
    try {
      decision = await permission(request, signal);
      signal.throwIfAborted();
    } catch (error) {
      await cancel();
      throw error;
    }
    if (['deny', 'revise'].includes(decision)) await cancel();
    if (decision === 'revise')
      return {
        content: JSON.stringify({
          status: 'revision_requested',
          message:
            'L’utilisateur souhaite modifier la proposition vidéo. Demande les changements souhaités et attends sa réponse. Aucune génération lancée.',
        }),
        images: [],
        denied: true,
        revised: true,
      };
    if (decision === 'deny')
      return {
        content: JSON.stringify({
          status: 'denied',
          message: 'L’utilisateur a refusé cette génération. Ne réessaie pas sans nouvelle demande.',
        }),
        images: [],
        denied: true,
      };
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
      // Transfer and compress one original at a time, including large workflow batches.
      originalsTask = (async () => {
        const prepared = [],
          errors = [];
        for (const [index, output] of record.outputs.entries()) {
          try {
            originalsSignal.throwIfAborted();
            const blob = record.mediaType === 'video' ? null : await original(record, index, originalsSignal);
            try {
              onImage({ record, index, blob });
            } catch (error) {
              notice('Affichage de l’original indisponible : ' + error.message);
            }
            if (record.mediaType === 'video') {
              if (!output.originalUrl) throw Error('Lien de lecture vidéo indisponible.');
              const video = await prepareVideo(output.originalUrl, {
                signal: originalsSignal,
                name: output.source.filename,
                frameCount: Math.max(1, Math.min(3, Math.floor(64 / record.outputs.length))),
                totalFrames: Math.min(64, record.outputs.length * 3),
              });
              prepared[index] = {
                url: video.frames[0].url,
                width: video.width,
                height: video.height,
                frames: video.frames,
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
          ...(request.mediaType === 'video' ? { approvalToken: request.approvalToken } : {}),
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
        onProgress(job.progress);
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
          content: JSON.stringify({ status: 'error', message: job.error }),
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
      onOutput();
      if (job.warning) notice(job.warning);
      let images = [],
        dimensions = record.outputs.map(() => null),
        frames = record.outputs.map(() => null),
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
          const copies = image.frames ? image.frames.map(frame => frame.url) : [image.url];
          analysisOutputs.push({
            output_index: index,
            image_indices: copies.map((_, offset) => images.length + offset),
          });
          frames[index] = image.frames || null;
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
                'negative_prompt',
                'references',
                'reference_image',
                'reference_resource',
                'reference_frame',
              ].includes(key),
            ),
          ),
          reference_default_count: record.parameters.reference_default_count ?? 0,
          reference_defaults: record.parameters.reference_defaults || [],
          ...(record.mediaType === 'video'
            ? {
                analysis_outputs: analysisOutputs,
                stage: record.parameters.stage,
                frame_times: frames.map((items, index) => ({
                  output: index,
                  times: items?.map(frame => frame.time) || [],
                })),
                inspection_limit:
                  'Only sampled compressed frames, without audio. Cannot verify continuous motion or exact last frames from these samples.',
              }
            : {}),
          reference_count: record.parameters?.reference_count ?? null,
          reference_capacity: record.parameters?.reference_capacity ?? null,
          reference_mode: record.parameters?.reference_mode || 'unknown',
          outputs: record.outputs.map(o => o.source),
          ...(error ? { warning: error } : {}),
          note:
            record.mediaType !== 'video'
              ? 'Image générée et affichée dans la galerie. Termine normalement sans analyse visuelle. Si la demande ou une raison précise le justifie, consulte la copie compressée avec local_read_output (run_id et output_index), sans demander son identifiant à l’utilisateur. Ne prétends pas avoir vu le résultat sans le consulter.'
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
