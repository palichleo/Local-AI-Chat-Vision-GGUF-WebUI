import { prepareResource } from './resource-preparation.mjs';
import { dismissSettingsOnOutsideClick } from './settings-controls.mjs';

export function setupAssets({
  api,
  state,
  node,
  icon,
  notice,
  onChange = () => {},
  onBusy = () => {},
  prepare = prepareResource,
}) {
  const $ = id => document.getElementById(id),
    controls = new Set();
  let items = [],
    working = 0,
    locked = false,
    refreshVersion = 0,
    importController,
    viewController,
    viewVersion = 0,
    objectURL,
    ready = false,
    activity = Promise.resolve();
  const size = value => (value >= 1024 ** 2 ? (value / 1024 ** 2).toFixed(1) + ' Mo' : Math.ceil(value / 1024) + ' Ko');
  const duration = value => Math.floor(value / 60) + ':' + String(Math.floor(value % 60)).padStart(2, '0');
  function pause(container = $('assets-panel')) {
    for (const video of container.querySelectorAll('video')) video.pause();
  }
  function show(tab) {
    for (const name of ['resources', 'output']) {
      $(`assets-${name}-tab`).setAttribute('aria-selected', String(tab === name));
      $(`assets-${name}-tab`).tabIndex = tab === name ? 0 : -1;
      $(`${name}-pane`).hidden = tab !== name;
      if (tab !== name) pause($(`${name}-pane`));
    }
  }
  function sync() {
    const changed = state.resourceWorking !== working > 0;
    state.resourceWorking = working > 0;
    const disabled = locked || working > 0;
    for (const control of controls) control.disabled = disabled || control.dataset.unready === 'true';
    $('resource-file').disabled = disabled;
    $('resource-cancel').hidden = !importController;
    $('assets-panel').classList.toggle('is-busy', disabled);
    if (ready && changed) onBusy();
  }
  function count() {
    const active = items.filter(item => item.enabled && item.ready).length;
    $('resource-count').textContent =
      `${items.length} ressource${items.length > 1 ? 's' : ''} · ${active} active${active > 1 ? 's' : ''}`;
  }
  async function mutate(work) {
    if (working || locked) return false;
    let done;
    activity = new Promise(resolve => {
      done = resolve;
    });
    working++;
    sync();
    try {
      await work();
      onChange();
      return true;
    } catch (error) {
      notice(error.message);
      return false;
    } finally {
      working--;
      sync();
      done();
    }
  }
  function render() {
    controls.clear();
    $('resources-list').replaceChildren();
    count();
    $('resources-empty').hidden = items.length > 0;
    for (const resource of items) {
      const card = node('article', 'resource-card');
      card.classList.toggle('inactive', !resource.enabled);
      card.dataset.resourceId = resource.id;
      const preview = node('button', 'resource-preview');
      preview.type = 'button';
      preview.setAttribute('aria-label', 'Voir ' + resource.name);
      if (resource.previewUrl) {
        const img = node('img');
        img.src = resource.previewUrl;
        img.loading = 'lazy';
        img.alt = resource.name;
        preview.append(img);
      } else preview.append(icon(resource.mime?.startsWith('video/') ? 'play' : 'image'));
      if (resource.mime?.startsWith('video/'))
        preview.append(
          node('span', 'resource-video', `▶ ${resource.duration ? duration(resource.duration) : 'Vidéo'}`),
        );
      preview.onclick = () => viewResource(resource);
      const remove = node('button', 'resource-remove icon-button');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Supprimer ' + resource.name);
      remove.title = 'Supprimer la copie de la bibliothèque';
      remove.append(icon('trash'));
      controls.add(remove);
      remove.onclick = () =>
        mutate(async () => {
          await api('resources/delete', { id: resource.id });
          items = items.filter(item => item.id !== resource.id);
          render();
        });
      const name = node('strong', 'resource-name', `${resource.label || 'Ressource'} · ${resource.name}`);
      name.title = resource.name;
      const enabled = node('input');
      enabled.type = 'checkbox';
      enabled.checked = resource.enabled;
      enabled.dataset.unready = String(!resource.ready);
      enabled.setAttribute('role', 'switch');
      enabled.setAttribute('aria-label', 'Activer ' + resource.name);
      controls.add(enabled);
      const label = node('label', 'resource-enabled');
      const status = node('span', '', resource.ready ? (resource.enabled ? 'Active' : 'Inactive') : 'Indisponible');
      label.append(enabled, status);
      enabled.onchange = () => {
        const wanted = enabled.checked;
        mutate(async () => {
          try {
            Object.assign(
              resource,
              await (await api('resources/update', { id: resource.id, patch: { enabled: wanted } })).json(),
            );
            card.classList.toggle('inactive', !resource.enabled);
            status.textContent = resource.enabled ? 'Active' : 'Inactive';
            count();
          } catch (error) {
            enabled.checked = resource.enabled;
            throw error;
          }
        });
      };
      const description = node('textarea', 'resource-description');
      description.rows = 2;
      description.maxLength = 300;
      description.value = resource.description;
      description.placeholder = 'Sujet, style, usage…';
      description.setAttribute('aria-label', 'Description de ' + resource.name);
      description.dataset.unready = String(resource.broken === true);
      controls.add(description);
      resource.descriptionControl = description;
      description.onblur = () => {
        if (description.value !== resource.description)
          return mutate(async () => {
            const text = description.value;
            Object.assign(
              resource,
              await (await api('resources/update', { id: resource.id, patch: { description: text } })).json(),
            );
            description.value = resource.description;
          });
      };
      card.append(preview, remove, name, label, description);
      $('resources-list').append(card);
    }
    sync();
  }
  async function refresh() {
    const version = ++refreshVersion,
      result = await (await api('resources')).json();
    if (version !== refreshVersion) return;
    items = result.resources;
    render();
  }
  async function importFiles(files) {
    if (working || locked || !files.length) return;
    show('resources');
    let done;
    activity = new Promise(resolve => {
      done = resolve;
    });
    working++;
    importController = new AbortController();
    sync();
    let finished = 0;
    try {
      for (const file of files) {
        const signal = importController.signal;
        signal.throwIfAborted();
        let uploaded;
        $('resource-progress').textContent = `Préparation ${++finished} / ${files.length} · ${file.name}`;
        try {
          const prepared = await prepare(file, { signal });
          signal.throwIfAborted();
          $('resource-progress').textContent = `Import ${finished} / ${files.length} · ${file.name}`;
          uploaded = await (
            await api('resources/upload', file, {
              raw: true,
              signal,
              headers: { 'Content-Type': prepared.mime, 'X-Resource-Name': encodeURIComponent(file.name) },
            })
          ).json();
          const resource = await (
            await api('resources/update', { id: uploaded.id, patch: { prepared } }, { signal })
          ).json();
          items.push(resource);
          items.sort((a, b) => (a.reference || 0) - (b.reference || 0));
          count();
        } catch (error) {
          if (uploaded) await api('resources/delete', { id: uploaded.id }).catch(() => {});
          if (signal.aborted) throw error;
          notice(`${file.name} : ${error.message}`);
        }
      }
      $('resource-progress').textContent = 'Import terminé.';
    } catch (error) {
      $('resource-progress').textContent = importController.signal.aborted ? 'Import interrompu.' : error.message;
    } finally {
      importController = null;
      working--;
      render();
      onChange();
      done();
    }
  }
  $('assets-resources-tab').onclick = () => show('resources');
  $('assets-output-tab').onclick = () => show('output');
  for (const tab of ['resources', 'output'])
    $(`assets-${tab}-tab`).onkeydown = event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next =
          event.key === 'Home'
            ? 'resources'
            : event.key === 'End'
              ? 'output'
              : tab === 'resources'
                ? 'output'
                : 'resources';
        show(next);
        $(`assets-${next}-tab`).focus();
      }
    };
  $('resource-file').onchange = event => {
    const files = [...event.target.files];
    event.target.value = '';
    void importFiles(files);
  };
  const panel = $('assets-panel');
  panel.ondragover = event => {
    event.preventDefault();
    if (!locked && !working) panel.classList.add('dragging');
  };
  panel.ondragleave = event => {
    if (!panel.contains(event.relatedTarget)) panel.classList.remove('dragging');
  };
  panel.ondrop = event => {
    event.preventDefault();
    event.stopPropagation();
    panel.classList.remove('dragging');
    void importFiles([...event.dataTransfer.files]);
  };
  $('resource-cancel').onclick = () => importController?.abort();

  function cleanViewer() {
    $('media-download').onclick = null;
    viewVersion++;
    viewController?.abort();
    $('original-video').onloadedmetadata = null;
    $('original-video').onerror = null;
    $('original-video').removeAttribute('poster');
    $('original-video').pause();
    $('original-video').removeAttribute('src');
    $('original-video').load();
    $('original-image').removeAttribute('src');
    $('original-image').onload = null;
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
  function begin(name) {
    pause();
    cleanViewer();
    $('original-name').textContent = name;
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
  function viewResource(resource) {
    begin(resource.name);
    row('Référence', resource.label);
    row('Type', resource.mime);
    row('Description', resource.description || 'Sans description');
    row('Ajoutée le', resource.createdAt ? new Date(resource.createdAt).toLocaleString('fr-FR') : null);
    row('Taille', resource.size ? size(resource.size) : null);
    row('Résolution', resource.width ? `${resource.width} × ${resource.height}` : null);
    row('État', resource.enabled ? 'Active pour le modèle' : 'Inactive');
    if (resource.mime?.startsWith('video/')) {
      row('Durée', resource.duration ? duration(resource.duration) : null);
      row('Vision du modèle', 'Trois images représentatives au maximum, sans audio.');
      $('original-video').hidden = false;
      $('original-video').src = resource.originalUrl;
    } else {
      $('original-image').hidden = false;
      $('original-image').src = resource.originalUrl;
    }
    download(resource.originalUrl, resource.name);
  }
  async function viewOutput(record, index, originalBlob) {
    const output = record.outputs[index],
      version = begin(output.source.filename);
    viewController = new AbortController();
    row('Workflow', record.workflowName);
    if (record.mediaType === 'video')
      row('Version', record.parameters.stage === 'draft' ? 'Brouillon vidéo' : 'Vidéo finale');
    row('Prompt', record.prompt);
    row('Date', new Date(record.createdAt).toLocaleString('fr-FR'));
    row('Seed', record.parameters.seed);
    const resolution = row(
      'Résolution originale',
      output.width && output.height ? `${output.width} × ${output.height}` : null,
    );
    row('Fichier', output.source.filename);
    row('Identifiant', record.id);
    const other = Object.fromEntries(
      Object.entries(record.parameters).filter(([key]) => !['seed', 'prompt', 'workflow_id'].includes(key)),
    );
    if (Object.keys(other).length) row('Paramètres', JSON.stringify(other, null, 2));
    if (record.analysis?.text) row('Analyse du modèle', record.analysis.text);
    $('media-download').disabled = true;
    $('media-error').textContent = 'Chargement de l’original…';
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
  show('resources');
  sync();
  ready = true;
  return {
    refresh,
    show,
    pause,
    viewOutput,
    async flush() {
      await activity;
      for (const item of items)
        if (item.descriptionControl && item.descriptionControl.value !== item.description)
          await item.descriptionControl.onblur();
      return !items.some(item => item.descriptionControl && item.descriptionControl.value !== item.description);
    },
    setBusy(value) {
      locked = value;
      sync();
    },
    importFiles,
    hasDraft: () => items.some(item => item.descriptionControl && item.descriptionControl.value !== item.description),
  };
}
