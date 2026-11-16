import { comparedSource, imageCompare, loadSource } from './image-compare.mjs';
import { prepareResource } from './resource-preparation.mjs';
import { dismissSettingsOnOutsideClick } from './settings-controls.mjs';
import { formatOf } from './formats.mjs';

/**
 * The references and the large view of a creation. No panel any more (0.5.106): a reference is
 * kept as it comes, from a case of the Studio or the message box of a chat, in the project of the
 * conversation (« #ref1 », « #ref2 »… there); the model knows those of its project.
 */
export function setupAssets({
  api,
  state,
  node,
  notice,
  onChange = () => {},
  onBusy = () => {},
  prepare = prepareResource,
  // Where a take was made (« test / Renard en pull bleu ») and how to open it; null when unknown.
  describe = () => null,
  // The actions of a take, as in the conversation (output-actions.mjs), at the foot of its panel.
  takeActions = null,
}) {
  const $ = id => document.getElementById(id);
  let items = [],
    working = 0,
    locked = false,
    refreshVersion = 0,
    viewController,
    viewVersion = 0,
    objectURL,
    comparison = null,
    ready = false,
    activity = Promise.resolve();
  const size = value => (value >= 1024 ** 2 ? (value / 1024 ** 2).toFixed(1) + ' Mo' : Math.ceil(value / 1024) + ' Ko');
  const duration = value =>
    value >= 60
      ? Math.floor(value / 60) + ':' + String(Math.floor(value % 60)).padStart(2, '0')
      : (Math.round(value * 100) / 100).toFixed(2).padStart(5, '0') + ' S';
  function sync() {
    const changed = state.resourceWorking !== working > 0;
    state.resourceWorking = working > 0;
    if (ready && changed) onBusy();
  }
  /** Every reference, of every project (a message shows those it names, wherever it now is). */
  async function refresh() {
    const version = ++refreshVersion,
      result = await (await api('resources')).json();
    if (version !== refreshVersion) return;
    items = result.resources;
  }
  /** Keeps files as references of `project` and returns them, in their order (those kept). */
  async function importFiles(files, { project = 'inbox' } = {}) {
    const imported = [];
    if (working || locked || !files.length) return imported;
    let done;
    activity = new Promise(resolve => {
      done = resolve;
    });
    working++;
    sync();
    try {
      for (const file of files) {
        let uploaded;
        try {
          const prepared = await prepare(file);
          uploaded = await (
            await api('resources/upload', file, {
              raw: true,
              headers: {
                'Content-Type': prepared.mime,
                'X-Resource-Name': encodeURIComponent(file.name),
                'X-Resource-Project': project,
              },
            })
          ).json();
          // The same file already kept in this project: that reference, as it is.
          const resource = uploaded.existing
            ? uploaded
            : await (await api('resources/update', { id: uploaded.id, patch: { prepared } })).json();
          items = [...items.filter(item => item.id !== resource.id), resource];
          imported.push(resource);
        } catch (error) {
          if (uploaded && !uploaded.existing) await api('resources/delete', { id: uploaded.id }).catch(() => {});
          notice(`${file.name} : ${error.message}`);
        }
      }
    } finally {
      working--;
      sync();
      onChange();
      done();
    }
    return imported;
  }

  function cleanViewer() {
    $('media-download').onclick = null;
    viewVersion++;
    viewController?.abort();
    $('original-video').onloadedmetadata = null;
    $('original-video').onerror = null;
    $('original-video').removeAttribute('poster');
    $('original-video').classList.remove('is-audio');
    $('original-video').pause();
    $('original-video').removeAttribute('src');
    $('original-video').load();
    $('original-image').removeAttribute('src');
    $('original-image').onload = null;
    if (comparison) {
      comparison.dispose();
      comparison = null;
      $('original-frame').style.removeProperty('--compare-ratio');
    }
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = null;
  }
  $('original-close').onclick = () => $('original-dialog').close();
  $('original-dialog').addEventListener('close', cleanViewer);
  dismissSettingsOnOutsideClick($('original-dialog'));
  // ‹ › and the arrows of the keyboard go from one take to the next of what was shown.
  let around = null,
    shownTake = null;
  /** Where a take is among those shown: by itself once moved to, by what opened it the first time. */
  const placeOf = (list, record) => (list.includes(record) ? list.indexOf(record) : (around?.at?.() ?? -1));
  function step(by) {
    const list = around?.list?.() ?? [],
      at = placeOf(list, shownTake),
      next = list[at + by];
    if (next) void viewOutput(next, 0, undefined, around);
  }
  $('media-prev').onclick = () => step(-1);
  $('media-next').onclick = () => step(1);
  $('original-dialog').addEventListener('keydown', event => {
    const typing = /^(INPUT|TEXTAREA|SELECT|VIDEO)$/.test(event.target?.tagName ?? '');
    if (typing || !around) return;
    if (event.key === 'ArrowLeft') step(-1);
    else if (event.key === 'ArrowRight') step(1);
  });
  $('media-copy').onclick = () => {
    const text = $('media-prompt').textContent;
    if (text) void navigator.clipboard?.writeText(text).then(() => notice('Prompt copié.'), () => {});
  };
  /** A line of its settings (Modèle, Format…), or of « Plus de détails » (`more`). */
  function row(label, value, { more = false } = {}) {
    const title = node('dt', '', label),
      content = node('dd', '', value === undefined || value === null ? 'Non disponible' : String(value));
    $(more ? 'media-more-list' : 'media-metadata').append(title, content);
    return content;
  }
  /** A creation, its name for screen readers only: its file is in « Fichier ». */
  function begin(name) {
    cleanViewer();
    $('original-name').textContent = name;
    $('original-name').classList.add('sr-only');
    $('media-metadata').replaceChildren();
    $('media-more-list').replaceChildren();
    $('media-error').textContent = '';
    $('original-image').hidden = true;
    $('original-video').hidden = true;
    $('media-download').disabled = false;
    if (!$('original-dialog').open) {
      $('original-dialog').showModal();
      // The take itself in hand, not its player: ‹ › and the arrows go to the next one (a video
      // focused would take them to move in its time).
      $('original-dialog').focus?.();
    }
    return viewVersion;
  }
  function download(url, name) {
    $('media-download').onclick = () => {
      const link = node('a');
      link.href = url;
      link.download = name;
      link.click();
    };
  }
  async function viewOutput(record, index, originalBlob, context = null) {
    const output = record.outputs[index],
      version = begin(output.source.filename),
      media = record.mediaType === 'video' || record.mediaType === 'audio' ? record.mediaType : 'image',
      parameters = record.parameters ?? {};
    viewController = new AbortController();
    // Its head: « PRISE 31 · VIDÉO » and « 2 / 46 »; « PRISE 31 » on the take too.
    around = context;
    shownTake = record;
    const list = context?.list?.() ?? [],
      at = context ? placeOf(list, record) : -1,
      take = Number.isInteger(output.take) ? 'PRISE ' + output.take : '',
      kind = { image: 'IMAGE', video: 'VIDÉO', audio: 'SON' }[media];
    $('media-title').textContent = [take, kind].filter(Boolean).join(' · ');
    $('media-position').textContent = at >= 0 && list.length ? `${at + 1} / ${list.length}` : '';
    $('media-take').textContent = take;
    $('media-take').hidden = !take || media === 'audio';
    $('media-prev').hidden = !(at > 0);
    $('media-next').hidden = !(at >= 0 && at < list.length - 1);
    // Where it was made: a click opens the conversation.
    const where = describe(record);
    $('media-conversation').textContent = where?.conversation ?? '';
    $('media-conversation').hidden = !where?.conversation;
    $('media-conversation').onclick = () => {
      $('original-dialog').close();
      where?.open?.();
    };
    // The prompt whole, with Copier.
    const expanded = parameters.expanded_prompt;
    $('media-prompt').textContent = record.prompt || '';
    $('media-copy').hidden = !record.prompt;
    // Its lines (capture 33): Modèle, Format, Résolution, Durée, Seed, Date, in mono.
    const width = output.width ?? parameters.width,
      height = output.height ?? parameters.height,
      seconds = Number(parameters.seconds) > 0 ? Number(parameters.seconds) : parameters.frames > 0 && parameters.fps > 0 ? parameters.frames / parameters.fps : null;
    row('Modèle', record.workflowName);
    if (media !== 'audio') row('Format', width && height ? (formatOf(width, height)?.id ?? 'Autre') : null);
    const resolution = media === 'audio' ? null : row('Résolution', width && height ? `${width} × ${height}` : null);
    const length = media === 'image' ? null : row('Durée', seconds ? duration(seconds) : null);
    row('Seed', parameters.seed);
    row('Date', record.createdAt ? new Date(record.createdAt).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null);
    // « Plus de détails »: the workflow, the version, the prompt made better, the file…
    if (media === 'video') row('Version', parameters.stage === 'draft' ? 'Brouillon vidéo' : 'Vidéo finale', { more: true });
    if (expanded) row('Prompt amélioré (utilisé pour l’image)', expanded, { more: true });
    if (parameters.expandPrompt !== undefined) row('Prompt enhance', expanded ? 'Activé' : 'Désactivé', { more: true });
    row('Fichier', output.source.filename, { more: true });
    row('Identifiant', record.id, { more: true });
    const other = Object.fromEntries(
      Object.entries(parameters).filter(
        ([key]) => !['seed', 'prompt', 'workflow_id', 'expanded_prompt', 'expandPrompt'].includes(key),
      ),
    );
    if (Object.keys(other).length) row('Paramètres', JSON.stringify(other, null, 2), { more: true });
    if (record.analysis?.text) row('Analyse du modèle', record.analysis.text, { more: true });
    // Télécharger, then the actions of the take, in icons.
    $('media-take-actions').replaceChildren(...(takeActions ? [takeActions(record, index)] : []));
    $('media-download').disabled = true;
    $('media-error').textContent = 'Chargement de l’original…';
    if (record.mediaType === 'audio') {
      // A sound plays in the same player, as a bar of controls without a picture.
      const player = $('original-video');
      player.classList.add('is-audio');
      player.hidden = false;
      player.preload = 'metadata';
      player.src = output.originalUrl || '';
      player.onloadedmetadata = () => {
        if (version === viewVersion) {
          if (length && Number.isFinite(player.duration)) length.textContent = duration(player.duration);
          $('media-error').textContent = '';
        }
      };
      player.onerror = () => {
        if (version === viewVersion) $('media-error').textContent = 'Son indisponible ou format non pris en charge.';
      };
      download(output.originalUrl, output.source.filename);
      $('media-download').disabled = false;
      return;
    }
    if (record.mediaType === 'video') {
      const video = $('original-video');
      video.hidden = false;
      video.preload = 'metadata';
      video.src = output.originalUrl || '';
      if (output.analysisDataUrl) video.poster = output.analysisDataUrl;
      video.onloadedmetadata = () => {
        if (version === viewVersion) {
          resolution.textContent = video.videoWidth + ' × ' + video.videoHeight;
          if (length && Number.isFinite(video.duration)) length.textContent = duration(video.duration);
          $('media-error').textContent = '';
        }
      };
      video.onerror = () => {
        if (version === viewVersion)
          $('media-error').textContent = 'Vidéo indisponible ou codec non pris en charge par le navigateur.';
      };
      row('Analyse du modèle', 'Images compressées échantillonnées, sans audio.', { more: true });
      download(output.originalUrl, output.source.filename);
      $('media-download').disabled = false;
      return;
    }
    if (output.analysisDataUrl) {
      $('original-image').src = output.analysisDataUrl;
      $('original-image').hidden = false;
    }
    // The same before/after comparison as in the chat, at the size of the view.
    const source = comparedSource(record);
    if (source) {
      const frame = $('original-frame');
      if (output.width && output.height) frame.style.setProperty('--compare-ratio', String(output.width / output.height));
      comparison = imageCompare({ node, host: frame, load: signal => loadSource(api, record, source, signal) });
    }
    try {
      const blob =
        originalBlob ||
        (await (
          await api(`gallery/${record.conversationId}/${record.id}/${index}`, undefined, {
            signal: viewController.signal,
          })
        ).blob());
      if (version !== viewVersion || !$('original-dialog').open) return;
      row('Type', blob.type || 'image', { more: true });
      row('Taille', size(blob.size), { more: true });
      objectURL = URL.createObjectURL(blob);
      const img = $('original-image');
      img.onload = () => {
        if (version === viewVersion) {
          if (comparison && img.naturalWidth)
            $('original-frame').style.setProperty('--compare-ratio', String(img.naturalWidth / img.naturalHeight));
          resolution.textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
          $('media-error').textContent = '';
        }
      };
      img.src = objectURL;
      img.hidden = false;
      if (img.decode)
        void img
          .decode()
          .then(() => {
            if (version === viewVersion && img.naturalWidth) {
              resolution.textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
              $('media-error').textContent = '';
            }
          })
          .catch(() => {});
      download(objectURL, output.source.filename);
      $('media-download').disabled = false;
    } catch (error) {
      if (version !== viewVersion) return;
      $('media-error').textContent = 'Original indisponible : ' + error.message;
      if (output.analysisDataUrl) {
        $('original-image').src = output.analysisDataUrl;
        $('original-image').hidden = false;
        $('media-error').textContent += ' · Aperçu compressé affiché.';
      }
    }
  }
  sync();
  ready = true;
  return {
    refresh,
    viewOutput,
    /** Waits for the references being kept. */
    async flush() {
      await activity;
      return true;
    },
    setBusy(value) {
      locked = value;
      sync();
    },
    importFiles,
    /** A reference by its id, or null (removed since). */
    resource: id => items.find(item => item.id === id) ?? null,
    /** The references of a project, ready, by their number (« # » in the message box). */
    references: (project = 'inbox') =>
      items
        .filter(item => (item.project || 'inbox') === project && item.ready)
        .sort((a, b) => a.reference - b.reference),
    hasDraft: () => false,
  };
}
