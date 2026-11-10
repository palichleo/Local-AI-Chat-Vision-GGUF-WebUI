/**
 * Before/after comparison of an upscaled image, in the chat card and in the zoomed view.
 * The upscaled image stays the element underneath (so clicking zooms and dragging takes the
 * upscaled file); hovering lays the source over it, cut at the pointer: source on the left,
 * result on the right.
 */

/** The source image of an upscale record, as recorded with its references; null otherwise. */
export function comparedSource(record) {
  if (record?.mediaType === 'video') return null;
  return record?.parameters?.references?.find(ref => ref.role === 'source_image' && ref.original) ?? null;
}

/** Fetches the original pixels of that source: an earlier output or an imported resource. */
export async function loadSource(api, record, source, signal) {
  if (source.attachment) return (await api(`attachments/${record.conversationId}/${source.attachment}`, undefined, { signal })).blob();
  if (source.output_id !== undefined) {
    const route = `gallery/${record.conversationId}/${source.output_id}/${source.output_index ?? 0}`;
    return (await api(route, undefined, { signal })).blob();
  }
  const { resources = [] } = await (await api('resources', undefined, { signal })).json();
  const resource = resources.find(item => item.id === source.resource_id);
  if (!resource?.originalUrl) throw Error('Image source introuvable.');
  const response = await fetch(resource.originalUrl, { signal });
  if (!response.ok) throw Error('Image source indisponible.');
  return response.blob();
}

/**
 * Turns `host` (which already holds the upscaled image, filling it) into a comparison.
 * `load(signal)` resolves to the source blob; it is called on the first hover only.
 */
export function imageCompare({ node, host, load }) {
  const before = node('img', 'compare-before'),
    line = node('span', 'compare-line'),
    labels = [node('span', 'compare-tag compare-tag-before', 'Avant'), node('span', 'compare-tag compare-tag-after', 'Après')];
  before.alt = '';
  before.draggable = false;
  before.decoding = 'async';
  line.append(node('span', 'compare-handle'));
  line.setAttribute('aria-hidden', 'true');
  for (const label of labels) label.setAttribute('aria-hidden', 'true');
  host.classList.add('image-compare');
  host.append(before, line, ...labels);
  let controller = null,
    url = null;
  function fetchSource() {
    if (controller) return;
    controller = new AbortController();
    const signal = controller.signal;
    load(signal)
      .then(blob => {
        if (signal.aborted) return;
        url = URL.createObjectURL(blob);
        before.src = url;
        before.onload = () => host.classList.add('has-before');
      })
      .catch(() => {
        // Without a source the image stays a plain result; a later hover tries again.
        if (!signal.aborted) controller = null;
      });
  }
  function move(event) {
    const box = host.getBoundingClientRect();
    if (!box.width) return;
    const split = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    host.style.setProperty('--compare-split', (split * 100).toFixed(2) + '%');
  }
  function enter(event) {
    fetchSource();
    move(event);
    host.classList.add('is-comparing');
  }
  function leave() {
    host.classList.remove('is-comparing');
  }
  host.addEventListener('pointerenter', enter);
  host.addEventListener('pointermove', move);
  host.addEventListener('pointerleave', leave);
  return {
    /** Frees the source pixels; the next hover fetches them again. */
    release() {
      controller?.abort();
      controller = null;
      before.onload = null;
      before.removeAttribute('src');
      host.classList.remove('has-before');
      if (url) URL.revokeObjectURL(url);
      url = null;
    },
    dispose() {
      this.release();
      host.removeEventListener('pointerenter', enter);
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerleave', leave);
      host.classList.remove('image-compare', 'is-comparing');
      host.style.removeProperty('--compare-split');
      before.remove();
      line.remove();
      for (const label of labels) label.remove();
    },
  };
}
