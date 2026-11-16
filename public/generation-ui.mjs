import { comparedSource, imageCompare, loadSource } from './image-compare.mjs';
import { thumbnailOf } from './thumbnails.mjs';
import { livePreview } from './live-preview.mjs';
import { takeFlux } from './take-flux.mjs';
import { formatOf } from './formats.mjs';

const KINDS = { image: 'IMAGE', video: 'VIDÉO', audio: 'SON' };
/** A length as the Studio writes it everywhere (moodix-design.md 27): « 05.04 S » in capitals. */
const twoFigures = value => (Math.round(Number(value) * 100) / 100).toFixed(2).padStart(5, '0');
const figures = value => twoFigures(value) + ' S';
/** What a card says of a creation: its kind, its format and its length (« VIDÉO · 16:9 · 05.04 S »). */
export function cardMeta({ media = 'image', width, height, seconds } = {}) {
  const format =
    media === 'audio' ? '' : (formatOf(width, height)?.id ?? (width && height ? width + '×' + height : ''));
  return [KINDS[media] ?? KINDS.image, format, Number.isFinite(seconds) && seconds > 0 ? figures(seconds) : '']
    .filter(Boolean)
    .join(' · ');
}
const recordMeta = record => {
  const p = record.parameters ?? {},
    output = record.outputs?.[0] ?? {},
    media = record.mediaType || 'image';
  return cardMeta({
    media,
    width: p.width ?? output.width,
    height: p.height ?? output.height,
    seconds: media === 'audio' ? p.seconds : p.frames && p.fps ? p.frames / p.fps : null,
  });
};
/**
 * Under a take: its number in its project (« PRISE 12 ») and its format (« 1:1 », « 16:9 · 768 × 448 »
 * for a clip, its length for a sound); `seconds`: the length written on a clip (« 06.04 S »).
 */
export function takeLine(record, index) {
  const output = record.outputs?.[index] ?? {},
    p = record.parameters ?? {},
    media = record.mediaType || 'image',
    width = output.width ?? p.width,
    height = output.height ?? p.height,
    seconds = media === 'audio' ? p.seconds : p.frames && p.fps ? p.frames / p.fps : null,
    format = formatOf(width, height)?.id ?? (width && height ? `${width} × ${height}` : '');
  return {
    number: Number.isInteger(output.take) ? `PRISE ${output.take}` : '',
    format:
      media === 'audio'
        ? Number.isFinite(seconds) && seconds > 0
          ? figures(seconds)
          : ''
        : media === 'video' && width && height && format !== `${width} × ${height}`
          ? `${format} · ${width} × ${height}`
          : format,
    seconds: media === 'video' && Number.isFinite(seconds) && seconds > 0 ? figures(seconds) : '',
  };
}
const requestMeta = request => {
  const p = request.plan?.parameters ?? {},
    media = request.mediaType || 'image';
  return cardMeta({
    media,
    width: request.resolution?.width ?? p.width,
    height: request.resolution?.height ?? p.height,
    seconds: media === 'audio' ? p.seconds : p.frames && p.fps ? p.frames / p.fps : null,
  });
};

/**
 * The creations of a conversation. A creation of the Studio (`compact`) is a card: its picture
 * as it is, what it is (« VIDÉO · 16:9 · 05 S ») and « Ouvrir », which shows it on the
 * Studio's screen (`onOpen`); its output buttons stay under it.
 */
// The stage a take failed at, said as a sentence (« Échec pendant le décodage de la vidéo »).
const ARTICLES = {
  Chargement: 'le ',
  Lecture: 'la ',
  Préparation: 'la ',
  Repérage: 'le ',
  Agrandissement: 'l’',
  Affinage: 'l’',
  Décodage: 'le ',
  Enregistrement: 'l’',
  Envoi: 'l’',
  Composition: 'la ',
  Génération: 'la ',
};
export function failedDuring(stage = '') {
  const words = String(stage).replace(/…$/, '').replace(/ · \d+\/\d+$/, '').trim().split(' '),
    article = ARTICLES[words[0]];
  return article ? 'Échec pendant ' + article + words.join(' ').replace(/^./, letter => letter.toLowerCase()) : 'Échec de la génération';
}

/**
 * `onAgain(request, { edit, figure, container })`: a take that failed is made again (« Relancer »),
 * or its proposal shown first (« Modifier la proposition », `edit`).
 */
export function setupGenerationUI({
  api,
  node,
  openOutput,
  actions = null,
  onResize = () => {},
  onOpen = null,
  onAgain = null,
}) {
  const cards = new Set(),
    watched = new Map();
  let downloads = Promise.resolve();
  const observer =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(
          entries => {
            for (const entry of entries) watched.get(entry.target)?.(entry.isIntersecting);
          },
          { rootMargin: '200px' },
        )
      : null;
  function watch(element, change) {
    watched.set(element, change);
    if (observer) observer.observe(element);
    else change(true);
  }
  function unwatch(element) {
    observer?.unobserve(element);
    watched.delete(element);
  }
  function tile(container, request, compact = false) {
    const figure = node('figure', 'generation-card' + (compact ? ' is-compact' : '')),
      frame = node('div', 'generation-frame'),
      caption = node('figcaption', 'generation-caption'),
      label = node('span', 'sr-only', 'Préparation de la génération…'),
      progress = node('div', 'generation-progress');
    if (request.mediaType === 'video') {
      label.textContent =
        'En attente de confirmation · ' + (request.plan?.stage === 'draft' ? 'Brouillon vidéo' : 'Vidéo finale');
      // A clip in progress has the size of its format from the start.
      figure.classList.add('is-video');
    } else if (request.mediaType === 'audio') {
      label.textContent = 'En attente de confirmation · Son';
      figure.classList.add('is-audio');
    }
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-label', label.textContent);
    progress.append(node('span'));
    frame.setAttribute('aria-busy', 'true');
    frame.setAttribute(
      'aria-label',
      request.mediaType === 'video'
        ? 'Génération de vidéo'
        : request.mediaType === 'audio'
          ? 'Génération de son'
          : 'Génération d’image en cours',
    );
    caption.append(progress, label);
    // Over a take in progress in a conversation (capture 13): « VIDÉO · LTX 2.5 », then its stage.
    caption.setAttribute(
      'data-kind',
      [KINDS[request.mediaType] ?? KINDS.image, request.workflowName].filter(Boolean).join(' · '),
    );
    figure.append(frame);
    let title = null,
      meta = null,
      open = null;
    if (compact) {
      const text = node('div', 'card-text');
      title = node('span', 'card-title', request.plan?.prompt || request.args?.prompt || 'Création du Studio');
      meta = node('span', 'card-meta', requestMeta(request));
      text.append(title, meta);
      open = node('button', 'card-open', 'Ouvrir');
      open.type = 'button';
      // Before its creation exists, « Ouvrir » leads to the Studio, where it is set or followed.
      open.title = 'Afficher dans le Studio';
      open.disabled = !onOpen;
      open.onclick = () => onOpen?.(null);
      figure.append(text, open);
    }
    figure.append(caption);
    container.append(figure);
    return { figure, frame, label, progress, title, meta, open };
  }
  function mount(container, request = {}, { compact = false } = {}) {
    container.classList.add('generation-grid');
    const first = tile(container, request, compact),
      { figure, frame, label } = first,
      tiles = [first];
    let disposed = false,
      finished = false,
      // The last stage said: where a take that fails stopped.
      lastStage = '',
      record,
      controller = new AbortController();
    const slots = new Map(),
      // In a conversation, the Flux of the take in progress, drawn from the picture so far: the start
      // image of a clip until the generator has one.
      flux = compact ? null : takeFlux(frame, { node }),
      // What the generator has so far, in the first tile.
      live = livePreview(node, frame, { onLoad: picture => flux?.source(picture) });
    const references = request.plan?.references ?? [],
      start = references.find(ref => ref.role === 'start_image' && ref.preview) ?? references.find(ref => ref.preview);
    // A take from words alone: the Flux on the colours of the room until the first picture.
    if (start) flux?.source(start.preview);
    else flux?.neutral();
    function dimensions(width, height, target = first) {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return;
      target.frame.style.aspectRatio = `${width} / ${height}`;
      // A clip in a conversation takes the size of its format (moodix.css, --take-ratio).
      target.figure.style.setProperty?.('--take-ratio', (width / height).toFixed(4));
      onResize();
    }
    function caption(text, shown = false) {
      for (const target of tiles) {
        // The stage in progress is shown beside the percentage: a long one is not a frozen bar.
        if (shown) target.label.classList.remove('sr-only');
        target.label.textContent = text;
        target.label.title = text;
        target.progress.setAttribute('aria-label', text);
      }
    }
    function settle() {
      flux?.stop();
      live.clear();
      for (const target of tiles) {
        unwatch(target.figure);
        target.frame.classList.add('is-finished');
        target.frame.setAttribute('aria-busy', 'false');
        target.progress.style.removeProperty('--generation-progress');
        target.progress.style.removeProperty('--generation-percent');
        target.progress.classList.add('is-complete');
        target.progress.setAttribute('aria-hidden', 'true');
        target.label.classList.remove('sr-only');
      }
    }
    // The size shown while waiting is the proposal's; the user may change it before confirming.
    let shownSize = '';
    function followSize() {
      const { width, height } = request.resolution || {},
        size = width + '×' + height;
      if (size === shownSize || record) return;
      shownSize = size;
      dimensions(width, height);
    }
    followSize();
    frame.classList.add('is-paused');
    watch(figure, visible => {
      frame.classList.toggle('is-paused', !visible);
      flux?.visible(visible);
    });
    function progress(value, fraction, preview) {
      if (disposed || finished) return;
      followSize();
      if (preview && !record) live.show(preview);
      if (Number.isFinite(fraction)) flux?.progress(fraction);
      // A real fraction replaces the indeterminate shimmer as soon as the job reports one.
      if (Number.isFinite(fraction)) {
        const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 1000) / 10;
        for (const target of tiles) {
          // Custom properties registered with @property: CSS eases fill and counter between polls.
          target.progress.classList.add('is-determinate');
          target.progress.style.setProperty('--generation-progress', String(percent / 100));
          target.progress.style.setProperty('--generation-percent', String(Math.floor(percent)));
          target.progress.setAttribute('aria-valuemin', '0');
          target.progress.setAttribute('aria-valuemax', '100');
          target.progress.setAttribute('aria-valuenow', String(Math.round(percent)));
        }
      }
      const named = typeof value === 'string' && !value.trim().startsWith('{');
      const text = named
        ? value
        : request.mediaType === 'video'
          ? 'Génération de la vidéo…'
          : request.mediaType === 'audio'
            ? 'Génération du son…'
            : 'Génération de l’image…';
      if (named) lastStage = text;
      // The video memory ran short and it tries again: its point is amber (etats-maquette.md, 52).
      for (const target of tiles) target.figure.classList.toggle('is-warned', /^Mémoire vidéo insuffisante/.test(text));
      // A named stage (loading, step 3/11, decoding…) is worth showing; the generic line is not.
      caption(text, named && !/^Génération (de la vidéo|de l’image|du son|en cours)…$/.test(text));
    }
    function release(slot) {
      slot.controller?.abort();
      slot.img.onload = null;
      if (slot.isVideo) {
        slot.img.onloadedmetadata = null;
        slot.img.pause?.();
        slot.img.removeAttribute('src');
        slot.img.load?.();
        return;
      }
      slot.compare?.release();
      if (slot.url) URL.revokeObjectURL(slot.url);
      slot.url = null;
      slot.blob = null;
      // Out of view: back to the small picture, the copy the model saw or the kept thumbnail.
      const output = record?.outputs?.[slot.index],
        preview = output?.analysisDataUrl || output?.thumbUrl;
      slot.img.hidden = !preview;
      if (preview) slot.img.src = preview;
      else slot.img.removeAttribute('src');
    }
    function display(slot, blob) {
      if (disposed) return;
      slot.blob = blob;
      slot.url = URL.createObjectURL(blob);
      slot.img.onload = () => {
        if (disposed) return;
        const width = slot.img.naturalWidth,
          height = slot.img.naturalHeight;
        if (width && height) {
          slot.button.style.aspectRatio = `${width} / ${height}`;
          dimensions(width, height, slot.tile);
        }
        // The original is decoded: a thumbnail of it is kept for the next displays.
        void thumbnailOf(api, record, slot.index, slot.img);
      };
      slot.img.hidden = false;
      slot.img.src = slot.url;
      slot.button.setAttribute('aria-busy', 'false');
    }
    function loadOriginal(slot) {
      if (disposed || !slot.visible || slot.url || slot.pending) return;
      slot.pending = true;
      downloads = downloads
        .then(async () => {
          if (disposed || !slot.visible || slot.url) return;
          slot.controller = new AbortController();
          slot.button.setAttribute('aria-busy', 'true');
          try {
            const blob = await (
              await api(`gallery/${record.conversationId}/${record.id}/${slot.index}`, undefined, {
                signal: slot.controller.signal,
              })
            ).blob();
            if (!disposed && slot.visible && !slot.controller.signal.aborted) display(slot, blob);
          } catch (error) {
            if (!disposed && !slot.controller.signal.aborted) {
              slot.tile.label.textContent = 'Original indisponible : ' + error.message;
              slot.tile.label.title = slot.tile.label.textContent;
            }
          } finally {
            slot.button.setAttribute('aria-busy', 'false');
          }
        })
        .finally(() => {
          slot.pending = false;
          if (!disposed && slot.visible && !slot.url && slot.controller?.signal.aborted) loadOriginal(slot);
        });
    }
    /** A card names its creation and opens it in the Studio. */
    function describe(target) {
      if (!compact || !record) return;
      target.title.textContent = record.prompt || 'Création du Studio';
      target.title.title = record.prompt || '';
      target.meta.textContent = recordMeta(record);
      target.open.disabled = !onOpen;
      const shown = record;
      target.open.onclick = () => onOpen?.(shown);
    }
    /**
     * A take as the captures draw it: « PRISE n » and its format under it, the length of a clip on
     * its picture, and over the takes of the message the line of their group (« IMAGE · 3 PRISES ·
     * KREA 2 »).
     */
    function dress(target, shown, index) {
      const line = takeLine(shown, index);
      target.takeLine ??= node('div', 'take-caption');
      target.takeLine.replaceChildren(node('span', 'take-number', line.number), node('span', 'take-format', line.format));
      target.figure.append(target.takeLine);
      target.figure.classList.add('has-take');
      target.figure.takeKind = KINDS[shown.mediaType] ?? KINDS.image;
      target.figure.takeWorkflow = shown.workflowName || '';
      if (line.seconds && !target.takeLength) {
        target.takeLength = node('span', 'take-duration', line.seconds);
        target.figure.append(target.takeLength);
      }
      const takes = [...container.children].filter(child => child.classList?.contains('has-take')),
        count = takes.length,
        // The kind and the model when the takes share them (a message can hold the Studio's, of all kinds).
        common = key => (new Set(takes.map(child => child[key])).size === 1 ? takes[0][key] : '');
      // Written by the sheet over the takes (an attribute: the grid keeps its takes alone).
      container.setAttribute(
        'data-takes',
        [common('takeKind'), count > 1 ? `${count} prises` : '', common('takeWorkflow')].filter(Boolean).join(' · '),
      );
    }
    function image({ record: outputRecord, index, blob }) {
      if (disposed || slots.has(index)) return;
      record = outputRecord;
      flux?.stop();
      live.clear();
      const target = slots.size ? tile(container, request, compact) : first,
        { frame } = target;
      if (target !== first) tiles.push(target);
      unwatch(target.figure);
      describe(target);
      dress(target, record, index);
      if (record.mediaType === 'video') target.figure.classList.add('is-video');
      if (record.mediaType === 'audio') {
        // A sound: its player, and the actions on the output beside it.
        const output = record.outputs?.[index],
          audio = node('audio');
        audio.controls = true;
        audio.preload = 'metadata';
        audio.setAttribute('aria-label', 'Son généré · ' + record.workflowName);
        audio.src = output?.originalUrl || '';
        const slot = { index, button: audio, img: audio, isVideo: true, tile: target };
        slots.set(index, slot);
        target.figure.classList.add('is-audio');
        target.figure.append(buttons(record, index));
        if (compact) {
          // A card shows a strip of sound; its player goes under the words.
          const wave = node('span', 'studio-thumb-wave');
          wave.setAttribute('aria-hidden', 'true');
          frame.replaceChildren(wave);
          target.figure.append(audio);
        } else frame.replaceChildren(audio);
        frame.classList.add('has-image');
        frame.setAttribute('aria-busy', 'false');
        onResize();
        return;
      }
      if (record.mediaType === 'video' && compact) {
        // A card shows the first picture of the clip; « Ouvrir » plays it on the Studio's screen.
        const output = record.outputs?.[index] ?? {},
          poster = output.analysisDataUrl || output.thumbUrl,
          shown = node(poster ? 'img' : 'video');
        if (poster) Object.assign(shown, { src: poster, alt: record.prompt || '', decoding: 'async' });
        else {
          Object.assign(shown, { muted: true, preload: 'metadata', playsInline: true });
          shown.onloadeddata = () => void thumbnailOf(api, record, index, shown);
          shown.src = (output.originalUrl || '') + '#t=0.1';
        }
        shown.title = 'Voir l’original et ses paramètres';
        shown.onclick = () => openOutput(record, index);
        target.figure.classList.add('is-video');
        target.figure.append(buttons(record, index));
        const slot = { index, button: shown, img: shown, isVideo: true, tile: target },
          play = node('button', 'take-play');
        slots.set(index, slot);
        // A take of the Studio in a conversation plays there too, from its round button (capture 14).
        play.type = 'button';
        play.setAttribute('aria-label', 'Lire la vidéo');
        play.title = 'Lire la vidéo';
        play.onclick = () => {
          const video = node('video');
          Object.assign(video, { controls: true, playsInline: true, preload: 'auto' });
          if (poster) video.poster = poster;
          video.setAttribute('aria-label', 'Vidéo originale · ' + record.workflowName);
          video.src = output.originalUrl || '';
          frame.replaceChildren(video);
          slot.button = slot.img = video;
          void video.play?.()?.catch?.(() => {});
        };
        frame.replaceChildren(shown, play);
        frame.classList.add('has-image');
        frame.setAttribute('aria-busy', 'false');
        onResize();
        return;
      }
      if (record.mediaType === 'video') {
        const output = record.outputs?.[index],
          wrapper = node('div', 'video-original'),
          video = node('video'),
          play = node('button', 'take-play');
        // Its picture and a round play button (capture 14); the controls of the player once it plays.
        video.controls = false;
        play.type = 'button';
        play.setAttribute('aria-label', 'Lire la vidéo');
        play.title = 'Lire la vidéo';
        play.onclick = () => {
          play.hidden = true;
          video.controls = true;
          void video.play?.()?.catch?.(() => {});
        };
        video.onplay = () => {
          play.hidden = true;
          video.controls = true;
        };
        video.preload = 'none';
        video.playsInline = true;
        video.setAttribute('aria-label', 'Vidéo originale · ' + record.workflowName);
        const poster = output.analysisDataUrl || output.thumbUrl;
        if (poster) video.poster = poster;
        video.onloadedmetadata = () => dimensions(video.videoWidth, video.videoHeight, target);
        video.onloadeddata = () => void thumbnailOf(api, record, index, video);
        wrapper.append(video, play);
        target.figure.append(buttons(record, index));
        const slot = { index, button: wrapper, img: video, isVideo: true, tile: target };
        slots.set(index, slot);
        frame.replaceChildren(wrapper);
        watch(wrapper, visible => {
          if (visible) video.src = output.originalUrl || '';
          else {
            video.pause?.();
            video.removeAttribute('src');
            video.load?.();
          }
        });
        frame.classList.add('has-image');
        frame.setAttribute('aria-busy', 'false');
        onResize();
        return;
      }
      const button = node('button', 'generation-original'),
        img = node('img');
      button.type = 'button';
      button.setAttribute('aria-label', 'Afficher les détails de l’image originale');
      img.alt = record.prompt || 'Image originale générée';
      img.decoding = 'async';
      img.loading = 'lazy';
      button.style.aspectRatio = '1';
      const output = record.outputs?.[index],
        slot = { index, button, img, visible: true, blob: null, url: null, pending: false, tile: target };
      slots.set(index, slot);
      if (output?.width && output.height) {
        button.style.aspectRatio = `${output.width} / ${output.height}`;
        dimensions(output.width, output.height, target);
      } else dimensions(request.resolution?.width, request.resolution?.height, target);
      button.append(img);
      // An upscale shows its source under the pointer; the upscaled image stays the one clicked and dragged.
      // A card is too small for that: « Détails » shows the image whole.
      const source = compact ? null : comparedSource(record);
      if (source) {
        const owner = record;
        slot.compare = imageCompare({ node, host: button, load: signal => loadSource(api, owner, source, signal) });
      }
      button.onclick = () => openOutput(record, index, slot.blob || undefined);
      frame.replaceChildren(button);
      target.figure.append(buttons(record, index));
      // While the original loads: the copy the model saw, or the thumbnail kept by the server.
      const small = output?.analysisDataUrl || output?.thumbUrl;
      if (compact) {
        // A card is a small picture: its thumbnail; without one, its file once, of which a
        // thumbnail is made. Nothing is downloaded again when the card comes back into view.
        if (blob) display(slot, blob);
        else if (small) img.src = small;
        else if (output?.originalUrl) {
          img.onload = () => void thumbnailOf(api, record, index, img);
          img.src = output.originalUrl;
        } else img.hidden = true;
      } else {
        if (blob) display(slot, blob);
        else if (small) img.src = small;
        else img.hidden = true;
        watch(button, visible => {
          slot.visible = visible;
          if (visible) loadOriginal(slot);
          else release(slot);
        });
      }
      frame.classList.add('has-image');
      frame.setAttribute('aria-busy', 'false');
      caption('Image originale · ' + record.workflowName);
      onResize();
    }
    // Output buttons (Détails, Upscale…) below each result; Détails alone without an action set.
    function buttons(record, index) {
      if (actions) return actions(record, index);
      const details = node('button', 'secondary', 'Détails');
      details.type = 'button';
      details.onclick = () => openOutput(record, index);
      return details;
    }
    function fail(message) {
      if (disposed) return;
      finished = true;
      settle();
      if (!slots.size) frame.hidden = true;
      // Refused, stopped or failed: nothing was made, nothing to open in the Studio.
      if (!record) for (const target of tiles) if (target.open) target.open.disabled = true;
      caption(message || 'Génération interrompue.');
      onResize();
    }
    /**
     * A take that failed (etats-maquette.md, 52): it stays at its place and its format, veiled (the
     * last picture, blurred and dark), ringed in amber, « ÉCHEC » in place of its number (nothing was
     * kept). In the middle what failed, « Relancer » and « Modifier la proposition »; over it, the
     * stage it stopped at, with an amber point.
     */
    function failed(message) {
      if (disposed) return;
      finished = true;
      flux?.stop();
      for (const target of tiles) {
        unwatch(target.figure);
        target.figure.classList.remove('is-warned');
        target.figure.classList.add('is-failed');
        target.frame.hidden = false;
        target.frame.setAttribute('aria-busy', 'false');
        target.frame.classList.add('is-finished');
        target.progress.classList.add('is-complete');
        target.progress.setAttribute('aria-hidden', 'true');
        const veil = node('div', 'generation-failure'),
          reason = String(message || 'La génération a échoué.').trim();
        veil.setAttribute('role', 'alert');
        veil.append(
          node('p', 'generation-failure-kicker', 'La génération a échoué'),
          node('p', 'generation-failure-reason', /enregistré/.test(reason) ? reason : reason + ' Rien n’a été enregistré.'),
        );
        if (onAgain && request.requestId) {
          const row = node('div', 'generation-failure-actions'),
            again = node('button', 'generation-again'),
            edit = node('button', 'generation-edit', 'Modifier la proposition');
          again.type = edit.type = 'button';
          again.append(node('span', 'generation-again-play'), node('span', '', 'Relancer'));
          again.title = 'Relancer avec les mêmes réglages';
          edit.title = 'Rouvrir la proposition pour la modifier';
          again.onclick = () => onAgain(request, { edit: false, figure: target.figure, container });
          edit.onclick = () => onAgain(request, { edit: true, figure: target.figure, container });
          row.append(again, edit);
          veil.append(row);
        }
        target.frame.append(node('span', 'generation-failed-chip', 'Échec'), veil);
        if (target.open) target.open.disabled = true;
      }
      caption(failedDuring(lastStage), true);
      onResize();
    }
    // Declined (a new message, « Refuser » in the Studio, « Annuler » of a card): the proposal goes
    // without a trace, no card, no line (16/11); « Annuler » alone leaves its own (proposal-card.mjs).
    function withdraw() {
      finished = true;
      settle();
      dispose();
      for (const target of tiles) target.figure.remove?.();
      if (!container.children.length) container.classList.remove('generation-grid');
      onResize();
    }
    function finish(result) {
      if (disposed) return;
      if (result.denied) return withdraw();
      // Failed with nothing made: veiled, its last picture kept under the veil (52).
      if (result.failed && !result.record && !record) return failed(result.error);
      finished = true;
      settle();
      if (result.record) record = result.record;
      for (const target of tiles) describe(target);
      for (const slot of slots.values())
        if (slot.isVideo && record.outputs?.[slot.index]?.analysisDataUrl)
          slot.img.poster = record.outputs[slot.index].analysisDataUrl;
      if (result.record && !slots.size) fail('Original indisponible · consultez Output pour les détails.');
      else if (result.failed) fail(result.error || 'Image produite · analyse indisponible.');
      else if (record) {
        const count = record.parameters?.reference_count;
        caption(
          `${record.mediaType === 'video' ? (record.parameters.stage === 'draft' ? 'Brouillon vidéo' : 'Vidéo finale') : record.mediaType === 'audio' ? 'Son' + (record.parameters.seconds ? ' · ' + twoFigures(record.parameters.seconds) + ' s' : '') : 'Image originale'} · ${record.workflowName}${Number.isInteger(count) ? ' · ' + count + ' référence(s) transmise(s)' : ''}`,
        );
      }
    }
    function dispose() {
      disposed = true;
      flux?.stop();
      controller.abort();
      for (const target of tiles) unwatch(target.figure);
      for (const slot of slots.values()) {
        unwatch(slot.button);
        release(slot);
        slot.compare?.dispose();
        slot.button.onclick = null;
        for (const child of slot.button.children || []) if (child.tagName === 'BUTTON') child.onclick = null;
      }
      slots.clear();
      cards.delete(card);
    }
    const card = {
      progress,
      image,
      fail,
      failed,
      finish,
      dispose,
      async load(conversationId, runId) {
        try {
          const response = await (
            await api(`gallery/${conversationId}/${runId}`, undefined, { signal: controller.signal })
          ).json();
          if (disposed) return;
          record = response;
          for (const [index] of response.outputs.entries()) image({ record: response, index });
          finish({ record: response });
        } catch (error) {
          if (!disposed) fail('Original indisponible : ' + error.message);
        }
      },
      get finished() {
        return finished;
      },
    };
    cards.add(card);
    return { card, figure, frame, label, progress: first.progress };
  }
  return {
    mount(container, request, options) {
      return mount(container, request, options).card;
    },
    restore(container, conversationId, runId, options) {
      const { card, figure, frame, label, progress } = mount(container, {}, options);
      frame.classList.add('is-finished');
      frame.setAttribute('aria-busy', 'false');
      progress.hidden = true;
      label.classList.remove('sr-only');
      label.textContent = 'Image générée';
      watch(figure, visible => {
        if (visible) {
          unwatch(figure);
          void card.load(conversationId, runId);
        }
      });
      return card;
    },
    clear() {
      for (const card of [...cards]) card.dispose();
    },
  };
}
