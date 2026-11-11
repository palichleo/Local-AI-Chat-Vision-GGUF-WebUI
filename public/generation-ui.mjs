import { comparedSource, imageCompare, loadSource } from './image-compare.mjs';

export function setupGenerationUI({ api, node, openOutput, actions = null, onResize = () => {} }) {
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
  function tile(container, request) {
    const figure = node('figure', 'generation-card'),
      frame = node('div', 'generation-frame'),
      caption = node('figcaption', 'generation-caption'),
      label = node('span', 'sr-only', 'Préparation de la génération…'),
      progress = node('div', 'generation-progress');
    if (request.mediaType === 'video')
      label.textContent =
        'En attente de confirmation · ' + (request.plan?.stage === 'draft' ? 'Brouillon vidéo' : 'Vidéo finale');
    else if (request.mediaType === 'audio') {
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
    figure.append(frame, caption);
    container.append(figure);
    return { figure, frame, label, progress };
  }
  function mount(container, request = {}) {
    container.classList.add('generation-grid');
    const first = tile(container, request),
      { figure, frame, label } = first,
      tiles = [first];
    let disposed = false,
      finished = false,
      record,
      controller = new AbortController();
    const slots = new Map();
    function dimensions(width, height, target = first) {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return;
      target.frame.style.aspectRatio = `${width} / ${height}`;
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
    watch(figure, visible => frame.classList.toggle('is-paused', !visible));
    function progress(value, fraction) {
      if (disposed || finished) return;
      followSize();
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
      const preview = record?.outputs?.[slot.index]?.analysisDataUrl;
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
    function image({ record: outputRecord, index, blob }) {
      if (disposed || slots.has(index)) return;
      record = outputRecord;
      const target = slots.size ? tile(container, request) : first,
        { frame } = target;
      if (target !== first) tiles.push(target);
      unwatch(target.figure);
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
        frame.replaceChildren(audio);
        frame.classList.add('has-image');
        frame.setAttribute('aria-busy', 'false');
        onResize();
        return;
      }
      if (record.mediaType === 'video') {
        const output = record.outputs?.[index],
          wrapper = node('div', 'video-original'),
          video = node('video');
        video.controls = true;
        video.preload = 'none';
        video.playsInline = true;
        video.setAttribute('aria-label', 'Vidéo originale · ' + record.workflowName);
        if (output.analysisDataUrl) video.poster = output.analysisDataUrl;
        video.onloadedmetadata = () => dimensions(video.videoWidth, video.videoHeight, target);
        wrapper.append(video);
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
      const source = comparedSource(record);
      if (source) {
        const owner = record;
        slot.compare = imageCompare({ node, host: button, load: signal => loadSource(api, owner, source, signal) });
      }
      button.onclick = () => openOutput(record, index, slot.blob || undefined);
      frame.replaceChildren(button);
      target.figure.append(buttons(record, index));
      if (blob) display(slot, blob);
      else if (output?.analysisDataUrl) img.src = output.analysisDataUrl;
      else img.hidden = true;
      watch(button, visible => {
        slot.visible = visible;
        if (visible) loadOriginal(slot);
        else release(slot);
      });
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
      caption(message || 'Génération interrompue.');
      onResize();
    }
    function finish(result) {
      if (disposed) return;
      finished = true;
      settle();
      if (result.record) record = result.record;
      for (const slot of slots.values())
        if (slot.isVideo && record.outputs?.[slot.index]?.analysisDataUrl)
          slot.img.poster = record.outputs[slot.index].analysisDataUrl;
      if (result.denied)
        fail(
          result.revised ? 'Proposition à modifier · précisez vos changements dans le chat.' : 'Génération refusée.',
        );
      else if (result.record && !slots.size) fail('Original indisponible · consultez Output pour les détails.');
      else if (result.failed) fail(result.error || 'Image produite · analyse indisponible.');
      else if (record) {
        const count = record.parameters?.reference_count;
        caption(
          `${record.mediaType === 'video' ? (record.parameters.stage === 'draft' ? 'Brouillon vidéo' : 'Vidéo finale') : record.mediaType === 'audio' ? 'Son' + (record.parameters.seconds ? ' · ' + Math.round(record.parameters.seconds) + ' s' : '') : 'Image originale'} · ${record.workflowName}${Number.isInteger(count) ? ' · ' + count + ' référence(s) transmise(s)' : ''}`,
        );
      }
    }
    function dispose() {
      disposed = true;
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
    mount(container, request) {
      return mount(container, request).card;
    },
    restore(container, conversationId, runId) {
      const { card, figure, frame, label, progress } = mount(container);
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
