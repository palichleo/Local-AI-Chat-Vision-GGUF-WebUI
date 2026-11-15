import { comparedSource, imageCompare, loadSource } from './image-compare.mjs';
import { prepareResource } from './resource-preparation.mjs';
import { dismissSettingsOnOutsideClick } from './settings-controls.mjs';

/**
 * The references and the large view of a creation. No panel any more (0.5.106): a reference is
 * kept as it comes, from a case of the Studio or the message box of a chat, in the project of the
 * conversation (« #ref1 », « #ref2 »… there); the model knows those of its project.
 */
export function setupAssets({ api, state, node, notice, onChange = () => {}, onBusy = () => {}, prepare = prepareResource }) {
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
  const duration = value => Math.floor(value / 60) + ':' + String(Math.floor(value % 60)).padStart(2, '0');
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
          const resource = await (await api('resources/update', { id: uploaded.id, patch: { prepared } })).json();
          items = [...items.filter(item => item.id !== resource.id), resource];
          imported.push(resource);
        } catch (error) {
          if (uploaded) await api('resources/delete', { id: uploaded.id }).catch(() => {});
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
  function row(label, value) {
    const title = node('dt', '', label),
      content = node('dd', '', value === undefined || value === null ? 'Non disponible' : String(value));
    $('media-metadata').append(title, content);
    return content;
  }
  /** A creation, its name for screen readers only: its file is in « Fichier ». */
  function begin(name) {
    cleanViewer();
    $('original-name').textContent = name;
    $('original-name').classList.add('sr-only');
    $('media-metadata').replaceChildren();
    $('media-error').textContent = '';
    $('original-image').hidden = true;
    $('original-video').hidden = true;
    $('media-download').disabled = false;
    if (!$('original-dialog').open) $('original-dialog').showModal();
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
  async function viewOutput(record, index, originalBlob) {
    const output = record.outputs[index],
      version = begin(output.source.filename);
    viewController = new AbortController();
    row('Workflow', record.workflowName);
    if (record.mediaType === 'video')
      row('Version', record.parameters.stage === 'draft' ? 'Brouillon vidéo' : 'Vidéo finale');
    const expanded = record.parameters.expanded_prompt;
    row(expanded ? 'Prompt demandé' : 'Prompt', record.prompt);
    if (expanded) row('Prompt amélioré (utilisé pour l’image)', expanded);
    if (record.parameters.expandPrompt !== undefined) row('Prompt enhance', expanded ? 'Activé' : 'Désactivé');
    row('Date', new Date(record.createdAt).toLocaleString('fr-FR'));
    row('Seed', record.parameters.seed);
    const resolution =
      record.mediaType === 'audio'
        ? null
        : row('Résolution originale', output.width && output.height ? `${output.width} × ${output.height}` : null);
    row('Fichier', output.source.filename);
    row('Identifiant', record.id);
    const other = Object.fromEntries(
      Object.entries(record.parameters).filter(
        ([key]) => !['seed', 'prompt', 'workflow_id', 'expanded_prompt', 'expandPrompt'].includes(key),
      ),
    );
    if (Object.keys(other).length) row('Paramètres', JSON.stringify(other, null, 2));
    if (record.analysis?.text) row('Analyse du modèle', record.analysis.text);
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
          row('Durée', duration(player.duration));
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
          row('Durée', duration(video.duration));
          $('media-error').textContent = '';
        }
      };
      video.onerror = () => {
        if (version === viewVersion)
          $('media-error').textContent = 'Vidéo indisponible ou codec non pris en charge par le navigateur.';
      };
      row('Analyse du modèle', 'Images compressées échantillonnées, sans audio.');
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
      row('Format', blob.type || 'image');
      row('Taille', size(blob.size));
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
    hasDraft: () => false,
  };
}
