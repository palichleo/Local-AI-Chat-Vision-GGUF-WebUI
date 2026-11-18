import { comparedSource, imageCompare, loadSource } from './image-compare.mjs';
import { prepareResource } from './resource-preparation.mjs';
import { dismissSettingsOnOutsideClick } from './settings-controls.mjs';
import { formatOf } from './formats.mjs';
import { setupTakePlayer } from './take-player.mjs';
import { generationTime, takeTime } from './generation-time.mjs';

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

  // The player of a take opened: none of the browser's controls (take-player.mjs).
  const player = setupTakePlayer({ host: $('take-player'), node });
  function cleanViewer() {
    player.detach();
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
  // Beside the take and its panel closes it, in the margins of its window too: the window keeps its
  // width (1180 px), a narrow take (9:16) leaves wide empty margins in it (17/11). Not the take, its
  // panel nor the arrows.
  // Where ‹ and › stand, shown or not, a few pixels more around. › clicked up to the last take is
  // hidden under the pointer: the next click at the same place, on the window itself, closed the take.
  // Read from the arrows themselves while they are shown (`stood`: how far each reaches from its
  // side of the window, how far above and under the middle of its height), so that a change of
  // moodix.css is followed; until one was measured, what « .media-step » says there: 40 px wide
  // and high, 4 px from a side of the window, at the middle of its height.
  const ARROWS = ['media-prev', 'media-next'],
    AROUND = 4,
    stood = {};
  function noteArrows() {
    const box = $('original-dialog').getBoundingClientRect(),
      middle = (box.top + box.bottom) / 2;
    ARROWS.forEach((id, right) => {
      const rect = $(id).hidden ? null : $(id).getBoundingClientRect?.();
      // (Laid out only: an arrow of a window not shown yet has no size.)
      if (rect?.width > 0 && rect.height > 0)
        stood[id] = { reach: right ? box.right - rect.left : rect.right - box.left, above: middle - rect.top, below: rect.bottom - middle };
    });
    return { box, middle };
  }
  const onArrow = event => {
    const { box, middle } = noteArrows(),
      x = event?.clientX,
      y = event?.clientY;
    if (!(x >= box.left && x <= box.right)) return false;
    return ARROWS.some((id, right) => {
      const { reach, above, below } = stood[id] ?? { reach: 44, above: 20, below: 20 };
      return (right ? box.right - x : x - box.left) <= reach + AROUND && y >= middle - above - AROUND && y <= middle + below + AROUND;
    });
  };
  dismissSettingsOnOutsideClick($('original-dialog'), undefined, {
    empty: (target, event) =>
      (target === $('original-dialog') || Boolean(target?.classList?.contains('media-details-layout'))) && !onArrow(event),
  });
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
  // The prompt of a take opened takes the room its panel leaves it (17/11): cut, it fades into a
  // blur at its foot, where a round arrow shows it whole (the panel then scrolls, its actions
  // staying at its foot); the arrow, turned up, folds it again. Measured again when the panel
  // changes size: the window resized, « Plus de détails » opened.
  let promptOpen = false,
    promptWatch = null;
  function fitPrompt() {
    const row = $('media-prompt-row'),
      prompt = $('media-prompt'),
      more = $('media-prompt-more'),
      full = prompt.scrollHeight || 0;
    row.classList.toggle('is-open', promptOpen);
    // Its whole height, for a short prompt to keep it (moodix.css: three lines at least otherwise).
    row.style?.setProperty?.('--prompt-height', full + 'px');
    // The panel as tall as its prompt asks, up to its limit (moodix.css: 80dvh). Its height is
    // otherwise that of the picture beside it: next to a wide clip, room was left unused under the
    // window while the prompt kept three lines.
    const panel = row.parentElement;
    if (panel?.style) {
      panel.style.minHeight = '';
      const natural =
        panel.scrollHeight - row.offsetHeight + (promptOpen ? row.offsetHeight : full) + (panel.offsetHeight - panel.clientHeight);
      if (natural > 0) panel.style.minHeight = `min(80dvh, ${Math.ceil(natural)}px)`;
    }
    const cut = !promptOpen && full > (row.clientHeight || 0) + 1;
    row.classList.toggle('is-cut', cut);
    more.hidden = !(cut || promptOpen);
    const said = promptOpen ? 'Replier le prompt' : 'Voir tout le prompt';
    more.title = said;
    more.setAttribute('aria-label', said);
    more.setAttribute('aria-expanded', String(promptOpen));
  }
  $('media-prompt-more').onclick = () => {
    promptOpen = !promptOpen;
    fitPrompt();
    // Folded again: the panel back at its head, where the prompt is.
    const panel = $('media-prompt-row').parentElement;
    if (!promptOpen && panel) panel.scrollTop = 0;
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
  const playerOf = () => player;
  /** The stage at the shape of the take (moodix.css: as large as the window allows, no band). */
  function shape(width, height) {
    if (width > 0 && height > 0) $('media-stage').style.setProperty?.('--media-ratio', (width / height).toFixed(4));
  }
  /**
   * What a take was made from, by role, each named by its number when it is among those shown
   * (« Image de début : PRISE 1 »; capture 33 of 16/11: the prompt of a clip made from a picture
   * speaks of the scene asked, the clip may keep the picture).
   */
  function inputsOf(parameters, list) {
    const names = {
        start_image: 'Image de début',
        end_image: 'Image de fin',
        source_video: 'Vidéo suivie',
        source: 'Image modifiée',
      },
      lines = new Map();
    for (const ref of parameters.references ?? []) {
      if (!ref?.output_id) continue;
      const label = names[ref.role] ?? 'Référence',
        made = list.find(item => item.id === ref.output_id),
        take = made?.outputs?.[ref.output_index ?? 0]?.take,
        value = Number.isInteger(take) ? 'PRISE ' + take : 'Une création';
      lines.set(label, [...(lines.get(label) ?? []), value]);
    }
    return [...lines].map(([label, values]) => [label, values.join(', ')]);
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
    // What has the focus, read before the arrows change: hidden, an arrow is no longer said to have it.
    const held = document.activeElement;
    // Where the arrows stand, read before one is hidden (onArrow).
    noteArrows();
    $('media-prev').hidden = !(at > 0);
    $('media-next').hidden = !(at >= 0 && at < list.length - 1);
    // The arrow that had the focus is gone (the first take, the last one): the take itself takes it.
    // Left on the page, the focus sent the keys there, and ← → no longer reached this window.
    if ([$('media-prev'), $('media-next')].some(arrow => arrow.hidden && arrow === held)) $('original-dialog').focus?.();
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
    // Another take: its prompt folded, at the room it has.
    promptOpen = false;
    $('media-copy').hidden = !record.prompt;
    // Its lines (capture 33): Modèle, Format, Résolution, Durée, Seed, Date, in mono.
    const width = output.width ?? parameters.width,
      height = output.height ?? parameters.height,
      stage = $('media-stage'),
      seconds = Number(parameters.seconds) > 0 ? Number(parameters.seconds) : parameters.frames > 0 && parameters.fps > 0 ? parameters.frames / parameters.fps : null;
    // The stage at the shape of the take, known from its record, then from its file.
    stage.classList.toggle('is-audio', media === 'audio');
    if (media !== 'audio' && width > 0 && height > 0) shape(width, height);
    else stage.style.removeProperty?.('--media-ratio');
    row('Modèle', record.workflowName);
    if (media !== 'audio') row('Format', width && height ? (formatOf(width, height)?.id ?? 'Autre') : null);
    const resolution = media === 'audio' ? null : row('Résolution', width && height ? `${width} × ${height}` : null);
    const length = media === 'image' ? null : row('Durée', seconds ? duration(seconds) : null);
    for (const [label, value] of inputsOf(parameters, list)) row(label, value);
    // The LoRAs the user had added, by their file, with their strength.
    if (Array.isArray(parameters.styles) && parameters.styles.length)
      row('LoRA', parameters.styles.map(style => `${String(style?.name ?? '').split(/[\\/]/).pop().replace(/\.safetensors$/i, '')} · ${String(style?.strength ?? 1).replace('.', ',')}`).join('\n')).classList?.add('media-lines');
    row('Seed', parameters.seed);
    row('Date', record.createdAt ? new Date(record.createdAt).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null);
    // How long it took to make (0.6.93), never « Durée » (the length of a clip): from its go to its
    // file. A take of before kept the engine's time alone: named so, never passed off as the whole.
    const took = takeTime(record);
    if (took && !took.whole) row('Temps du moteur', generationTime(took.ms));
    else row('Temps de génération', took ? generationTime(took.ms) : 'Non mesuré');
    // « Plus de détails »: the workflow, the version, the prompt made better, the file…
    if (media === 'video') row('Version', parameters.stage === 'draft' ? 'Brouillon vidéo' : 'Vidéo finale', { more: true });
    // What came before the engine (the checks, its sources, the chat model leaving the card), then the
    // engine itself (its models loaded, the computation, the file written).
    if (took?.whole && took.prepare !== undefined) row('Temps de préparation', generationTime(took.prepare), { more: true });
    if (took?.whole && took.engine !== undefined) row('Temps du moteur', generationTime(took.engine), { more: true });
    if (expanded) row('Prompt amélioré (utilisé pour l’image)', expanded, { more: true });
    if (parameters.expandPrompt !== undefined) row('Prompt enhance', expanded ? 'Activé' : 'Désactivé', { more: true });
    // Its file as it lies in the output folder: in its sub-folder (image/, video/, son/) when it has
    // one (a take of before them has none). Downloaded under its name alone.
    const folder = String(output.source.subfolder ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    row('Fichier', folder ? `${folder}/${output.source.filename}` : output.source.filename, { more: true });
    row('Identifiant', record.id, { more: true });
    const other = Object.fromEntries(
      Object.entries(parameters).filter(
        ([key]) => !['seed', 'prompt', 'workflow_id', 'expanded_prompt', 'expandPrompt', 'generation_time'].includes(key),
      ),
    );
    if (Object.keys(other).length) row('Paramètres', JSON.stringify(other, null, 2), { more: true });
    if (record.analysis?.text) row('Analyse du modèle', record.analysis.text, { more: true });
    // Its lines are there: the room left to the prompt is known (and once the page is laid out).
    fitPrompt();
    globalThis.requestAnimationFrame?.(fitPrompt);
    if (!promptWatch && globalThis.ResizeObserver) {
      promptWatch = new ResizeObserver(fitPrompt);
      promptWatch.observe($('media-metadata').parentElement ?? $('media-metadata'));
    }
    // Télécharger, then the actions of the take, in icons.
    $('media-take-actions').replaceChildren(...(takeActions ? [takeActions(record, index)] : []));
    $('media-download').disabled = true;
    $('media-error').textContent = 'Chargement de l’original…';
    if (record.mediaType === 'audio') {
      // A sound plays in the same player, as a bar of controls without a picture.
      const player = $('original-video'),
        takePlayer = playerOf();
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
      takePlayer.attach(player, { audio: true });
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
          shape(video.videoWidth, video.videoHeight);
          if (length && Number.isFinite(video.duration)) length.textContent = duration(video.duration);
          $('media-error').textContent = '';
        }
      };
      video.onerror = () => {
        if (version === viewVersion)
          $('media-error').textContent = 'Vidéo indisponible ou codec non pris en charge par le navigateur.';
      };
      row('Analyse du modèle', 'Images compressées échantillonnées, sans audio.', { more: true });
      playerOf().attach(video);
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
          shape(img.naturalWidth, img.naturalHeight);
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
