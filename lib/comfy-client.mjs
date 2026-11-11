/**
 * ComfyUI as a separate program, driven only through its HTTP API on this machine: upload an
 * input, queue a graph, wait for its result, download the output, free the video memory.
 * Nothing of ComfyUI is imported or copied here.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/** The nodes an output depends on: the rest of a graph is not sent. */
function connectedNodes(graph, outputNodes) {
  const connected = new Set(),
    queue = [...outputNodes];
  while (queue.length) {
    const id = queue.pop();
    if (connected.has(id)) continue;
    connected.add(id);
    for (const value of Object.values(graph[id]?.inputs || {}))
      if (
        Array.isArray(value) &&
        value.length === 2 &&
        typeof value[0] === 'string' &&
        Object.hasOwn(graph, value[0]) &&
        Number.isInteger(value[1]) &&
        value[1] >= 0
      )
        queue.push(value[0]);
  }
  return connected;
}

const MAX_IMAGE = 64 * 1024 ** 2,
  MAX_VIDEO = 512 * 1024 ** 2;
export const isVideoSource = source => /\.(mp4|webm)$/i.test(source?.filename || '');
function videoMime(bytes) {
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'))) return 'video/webm';
  throw problem('Expected an MP4 or WebM video signature.');
}
const RELEASED_MEMORY = 512 * 1024 ** 2;
// Giving the graphics card back, for real. ComfyUI reads a /free request between two jobs: one
// that arrives while it finishes a job can wait ten seconds, and its memory manager holds video
// memory that the torch figures do not show. Whoever takes the card next sizes itself on what
// is free at that instant (a chat model 700 MiB short puts layers on the processor and answers
// five times slower). So the request is repeated at every poll, and the release is done when
// the card's free memory has stopped growing; this many polls at most.
const EMPTIED_CACHE = 256 * 1024 ** 2,
  STILL_GROWING = 64 * 1024 ** 2,
  CACHE_POLLS = 12;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
// A large upscale is a large PNG: read up to this size when asked.
const MAX_ORIGINAL = 512 * 1024 ** 2;
// Sending or reading a whole file may take longer than a question to the API.
const TRANSFER_TIMEOUT = 300_000;

function problem(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

function safePath(value, { empty = false, filename = false } = {}) {
  if (
    typeof value !== 'string' ||
    value.length > 1024 ||
    (!value && !empty) ||
    /[\\:%?#\x00-\x1f\x7f]/.test(value) ||
    (filename && value.includes('/')) ||
    (value && value.split('/').some(part => !part || part === '.' || part === '..'))
  ) {
    throw problem(`Invalid ${filename ? 'filename' : 'path'}.`, 400);
  }
  return value;
}

export function normalizeComfyUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\s\x00-\x1f\x7f]/.test(value))
    throw problem('Invalid Comfy URL; use loopback HTTP.', 400);
  const authority = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?=\/|$)/i.exec(value);
  if (!authority) throw problem('Comfy URL must use HTTP on localhost, 127.0.0.1 or ::1.', 400);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw problem('Invalid Comfy URL.', 400);
  }
  if (url.search || url.hash || url.username || url.password)
    throw problem('Invalid Comfy URL: credentials, query and fragment are not allowed.', 400);
  if (url.pathname !== '/' || value.slice(authority[0].length).replace(/\/$/, '') !== '')
    throw problem('Comfy URL must point to the loopback HTTP API root.', 400);
  return url.origin;
}

function descriptor(value, type = 'output') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== type)
    throw problem(`Invalid ${type} image descriptor.`, 400);
  const subfolder = typeof value.subfolder === 'string' ? value.subfolder.replace(/\\/g, '/') : (value.subfolder ?? '');
  return {
    filename: safePath(value.filename, { filename: true }),
    subfolder: safePath(subfolder, { empty: true }),
    type,
  };
}

function imageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  throw problem('Expected a PNG, JPEG or WebP image.', 400);
}

async function readLimited(response, limit, signal) {
  const length = Number(response.headers.get('content-length'));
  if (length > limit) {
    await response.body?.cancel();
    throw problem(`Comfy response exceeds ${Math.round(limit / 1024 ** 2)} MiB.`);
  }
  const chunks = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        signal?.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw problem(`Comfy response exceeds ${Math.round(limit / 1024 ** 2)} MiB.`);
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  signal?.throwIfAborted();
  return Buffer.concat(chunks, size);
}

function queueState(value) {
  if (
    !value ||
    !Array.isArray(value.queue_running) ||
    !Array.isArray(value.queue_pending) ||
    [...value.queue_running, ...value.queue_pending].some(
      entry => !Array.isArray(entry) || typeof entry[1] !== 'string',
    )
  ) {
    throw problem('Invalid Comfy queue response.');
  }
  return value;
}

function executionFailure(record) {
  const messages = record.status?.messages ?? [];
  const failure = messages.find(entry => ['execution_error', 'execution_interrupted'].includes(entry?.[0]));
  if (failure) return failure[1]?.exception_message ?? failure[1]?.exception_type ?? 'Comfy execution interrupted.';
  if (record.status?.status_str === 'error') return 'Comfy execution failed.';
  return null;
}

// A preview ComfyUI sends while it samples: a binary message, two big-endian numbers (the kind
// of message, 1 for a preview; the kind of image, 1 for JPEG and 2 for PNG) then the image.
// With `latent2rgb` it is the latent itself turned into colours, without the VAE: it costs the
// generator no video memory, and a few tens of kilobytes here.
const PREVIEW_EVENT = 1;
const PREVIEW_LIMIT = 2 * 1024 * 1024;
/** The image of a preview message, or null for anything else. */
export function previewFrame(data) {
  const bytes = Buffer.isBuffer(data) ? data : data instanceof ArrayBuffer ? Buffer.from(data) : null;
  if (!bytes || bytes.length < 12 || bytes.length > PREVIEW_LIMIT + 8 || bytes.readUInt32BE(0) !== PREVIEW_EVENT)
    return null;
  const image = bytes.subarray(8);
  if (image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff) return { bytes: Buffer.from(image), mime: 'image/jpeg' };
  if (image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { bytes: Buffer.from(image), mime: 'image/png' };
  return null;
}

export class ComfyClient {
  #baseUrl;
  #fetch;
  #pollMs;
  #socket;

  constructor(baseUrl, { fetchImpl = globalThis.fetch, pollMs = 500, socketImpl = globalThis.WebSocket } = {}) {
    this.#baseUrl = normalizeComfyUrl(baseUrl);
    if (typeof fetchImpl !== 'function' || !Number.isFinite(pollMs) || pollMs < 0 || pollMs > 60_000)
      throw problem('Invalid Comfy client options.', 400);
    this.#fetch = fetchImpl;
    this.#pollMs = pollMs;
    this.#socket = socketImpl;
  }

  /**
   * Sampling steps as ComfyUI announces them (`{ value, max, node }`). Only a comfort: the
   * result is read from the history, so a socket that fails changes nothing.
   */
  #listen(clientId, onStep, onPreview) {
    if (typeof this.#socket !== 'function') return () => {};
    let socket;
    try {
      socket = new this.#socket(`${this.#baseUrl.replace(/^http/, 'ws')}/ws?clientId=${clientId}`);
      socket.binaryType = 'arraybuffer';
      socket.onerror = () => {};
      socket.onmessage = event => {
        if (typeof event.data !== 'string') {
          // The picture so far, one per sampling step; the same comfort as the steps.
          const frame = onPreview && previewFrame(event.data);
          if (frame) onPreview(frame);
          return;
        }
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'progress' && Number.isFinite(message.data?.value) && message.data.max > 0)
            onStep(message.data);
        } catch {}
      };
    } catch {
      return () => {};
    }
    return () => {
      try {
        socket.close();
      } catch {}
    };
  }

  async #request(
    path,
    {
      signal,
      body,
      method = body === undefined ? 'GET' : 'POST',
      binary = false,
      limit = MAX_IMAGE,
      timeout = 30_000,
    } = {},
  ) {
    signal?.throwIfAborted();
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout);
    const multipart = body instanceof FormData;
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      signal: requestSignal,
      redirect: 'manual',
      ...(body === undefined
        ? {}
        : {
            body: multipart ? body : JSON.stringify(body),
            headers: multipart ? {} : { 'content-type': 'application/json' },
          }),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw problem(`Comfy redirects are not allowed (${response.status}).`);
    }
    const bytes = await readLimited(response, binary && response.ok ? limit : 16 * 1024 ** 2, requestSignal);
    if (!response.ok) {
      const details = bytes.toString('utf8').slice(0, 4096);
      throw problem(`Comfy ${path.split('?')[0]} returned ${response.status}: ${details}`, response.status);
    }
    if (binary) return { bytes, mime: (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() };
    if (!bytes.length) return {};
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      throw problem(`Invalid JSON response from Comfy ${path.split('?')[0]}.`);
    }
  }

  async #queue(options = {}) {
    return queueState(await this.#request('/queue', options));
  }

  async status({ signal } = {}) {
    const [queue, stats] = await Promise.all([this.#queue({ signal }), this.#request('/system_stats', { signal })]);
    if (!stats || !Array.isArray(stats.devices)) throw problem('Invalid Comfy memory response.');
    const gpuDevices = stats.devices.filter(device => device.type !== 'cpu');
    const measured = gpuDevices.every(
      device =>
        Number.isFinite(device.torch_vram_total) &&
        Number.isFinite(device.torch_vram_free) &&
        device.torch_vram_total >= 0 &&
        device.torch_vram_free >= 0 &&
        device.torch_vram_free <= device.torch_vram_total,
    );
    return {
      queue: queue.queue_pending.length,
      running: queue.queue_running.length,
      idle: queue.queue_pending.length === 0 && queue.queue_running.length === 0,
      devices: stats.devices,
      system: stats.system ?? {},
      memory: {
        torchVramTotal: measured ? gpuDevices.reduce((sum, device) => sum + device.torch_vram_total, 0) : null,
        torchVramFree: measured ? gpuDevices.reduce((sum, device) => sum + device.torch_vram_free, 0) : null,
        torchAllocated: measured
          ? gpuDevices.reduce((sum, device) => sum + device.torch_vram_total - device.torch_vram_free, 0)
          : null,
      },
    };
  }

  async workflows({ signal } = {}) {
    let files;
    try {
      files = await this.#request('/userdata?dir=workflows&recurse=true', { signal });
    } catch (error) {
      if (error.status === 404) return [];
      throw error;
    }
    if (!Array.isArray(files)) throw problem('Invalid Comfy workflow listing.');
    return files
      .map(path => safePath(path))
      .filter(path => /\.json$/i.test(path))
      .sort()
      .map(path => ({ name: path, path }));
  }

  async workflow(name, { signal } = {}) {
    safePath(name);
    if (!/\.json$/i.test(name)) throw problem('Workflow name must end in .json.', 400);
    return this.#request(`/userdata/${encodeURIComponent(`workflows/${name}`)}`, { signal });
  }

  /** Every node this ComfyUI knows, or only `node` ({} when it has no such node). */
  async objectInfo({ signal, node } = {}) {
    return this.#request(node ? `/object_info/${encodeURIComponent(node)}` : '/object_info', { signal });
  }

  /** Sends an image into ComfyUI's input folder. */
  async upload(bytes, { filename, mime, signal, subfolder = '' } = {}) {
    signal?.throwIfAborted();
    safePath(filename, { filename: true });
    safePath(subfolder, { empty: true });
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.byteLength > MAX_IMAGE)
      throw problem('Image upload must contain 1 byte to 64 MiB.', 400);
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (!IMAGE_MIMES.has(mime) || imageMime(data) !== mime)
      throw problem('Invalid image MIME type or image bytes.', 400);
    const form = new FormData();
    form.set('image', new Blob([data], { type: mime }), filename);
    form.set('type', 'input');
    if (subfolder) form.set('subfolder', subfolder);
    form.set('overwrite', 'false');
    const result = await this.#request('/upload/image', { signal, body: form, timeout: TRANSFER_TIMEOUT });
    const validated = descriptor({ filename: result?.name, subfolder: result?.subfolder, type: result?.type }, 'input');
    return { filename: validated.filename, name: validated.filename, subfolder: validated.subfolder, type: 'input' };
  }

  async #cancel(promptId) {
    await this.#request('/queue', { body: { delete: [promptId] } });
    let queue = await this.#queue();
    if (queue.queue_running.some(entry => entry[1] === promptId)) {
      try {
        await this.#request(`/api/jobs/${encodeURIComponent(promptId)}/cancel`, { body: {} });
      } catch (error) {
        if (error.status !== 404 && error.status !== 405) throw error;
      }
      // Legacy /interrupt can race into an unrelated prompt; wait instead.
    }
    while ([...queue.queue_running, ...queue.queue_pending].some(entry => entry[1] === promptId)) {
      await delay(this.#pollMs);
      queue = await this.#queue();
    }
  }

  async run(graph, { signal, outputNodes, onProgress, mediaType = 'image' } = {}) {
    signal?.throwIfAborted();
    if (
      !graph ||
      typeof graph !== 'object' ||
      Array.isArray(graph) ||
      !Object.keys(graph).length ||
      Object.values(graph).some(
        node =>
          !node ||
          typeof node.class_type !== 'string' ||
          !node.inputs ||
          typeof node.inputs !== 'object' ||
          Array.isArray(node.inputs),
      )
    ) {
      throw problem('Expected a Comfy API workflow graph.', 400);
    }
    const selected = outputNodes ?? Object.keys(graph).filter(id => graph[id].class_type === 'SaveImage');
    if (
      !Array.isArray(selected) ||
      !selected.length ||
      selected.some(id => typeof id !== 'string' || !Object.hasOwn(graph, id))
    )
      throw problem('Workflow requires valid final image output nodes.', 400);
    let promptId;
    let settled = false;
    const clientId = randomUUID();
    const silence = this.#listen(
      clientId,
      step => {
        if (!step.prompt_id || step.prompt_id === promptId)
          onProgress?.({ state: 'step', promptId, value: step.value, max: step.max, node: step.node });
      },
      // This socket only receives what its own prompt produces.
      frame => promptId && onProgress?.({ state: 'preview', promptId, ...frame }),
    );
    try {
      // Keep the acknowledgement so an abort cannot lose the ID of an accepted prompt.
      const connected = connectedNodes(graph, selected);
      const prompt = Object.fromEntries(Object.entries(graph).filter(([id]) => connected.has(id)));
      const queued = await this.#request('/prompt', {
        // The cheap preview is asked for by name: it does not depend on how ComfyUI was started,
        // and a heavier method chosen there (a small VAE) is not used for this job.
        body: {
          prompt,
          partial_execution_targets: selected,
          client_id: clientId,
          extra_data: { preview_method: 'latent2rgb' },
        },
      });
      if (typeof queued?.prompt_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(queued.prompt_id))
        throw problem(`Invalid Comfy prompt response: ${JSON.stringify(queued).slice(0, 4096)}`);
      promptId = queued.prompt_id;
      let absent = 0;
      while (true) {
        signal?.throwIfAborted();
        const history = await this.#request(`/history/${encodeURIComponent(promptId)}`, { signal });
        const record = history?.[promptId];
        if (record) {
          const failure = executionFailure(record);
          if (failure) {
            settled = true;
            throw problem(failure);
          }
          if (record.status?.completed === true || record.status?.status_str === 'success') {
            settled = true;
            const outputs = [];
            const seen = new Set();
            for (const node of selected)
              for (const source of mediaType === 'video'
                ? Object.values(record.outputs?.[node] || {})
                    .filter(Array.isArray)
                    .flat()
                    .filter(isVideoSource)
                : (record.outputs?.[node]?.images ?? [])) {
                if (source.type !== 'output') continue;
                const output = descriptor(source);
                const key = JSON.stringify(output);
                if (!seen.has(key)) {
                  seen.add(key);
                  outputs.push(output);
                }
              }
            if (!outputs.length) throw problem('Comfy completed without final saved media of the selected type.');
            onProgress?.({ state: 'completed', promptId });
            signal?.throwIfAborted();
            // What the selected nodes wrote as text (a preview of the prompt really used).
            const texts = Object.fromEntries(
              selected
                .map(node => [node, record.outputs?.[node]?.text])
                .filter(([, text]) => Array.isArray(text) && text.every(line => typeof line === 'string')),
            );
            return { promptId, outputs, ...(Object.keys(texts).length ? { texts } : {}) };
          }
        }
        const queue = await this.#queue({ signal });
        const running = queue.queue_running.some(entry => entry[1] === promptId);
        const pending = queue.queue_pending.some(entry => entry[1] === promptId);
        absent = running || pending ? 0 : absent + 1;
        if (absent >= 3) throw problem('Comfy prompt disappeared from the queue without a completed history record.');
        onProgress?.({ state: running ? 'running' : 'queued', promptId, queue: queue.queue_pending.length });
        await delay(this.#pollMs, undefined, { signal });
      }
    } catch (error) {
      if (promptId && !settled) {
        try {
          await this.#cancel(promptId);
        } catch (cleanupError) {
          throw Object.assign(problem(`${error.message} Cancellation failed: ${cleanupError.message}`), {
            cause: error,
            cleanupError,
          });
        }
      }
      throw error;
    } finally {
      silence();
    }
  }

  /** The saved file of an output; `large` reads an image as far as a video (a big upscale). */
  async original(source, { signal, large = false } = {}) {
    const output = descriptor(source);
    const video = isVideoSource(output);
    const result = await this.#request(`/view?${new URLSearchParams(output)}`, {
      signal,
      binary: true,
      limit: large ? MAX_ORIGINAL : video ? MAX_VIDEO : MAX_IMAGE,
      timeout: TRANSFER_TIMEOUT,
    });
    if (
      video
        ? videoMime(result.bytes) !== result.mime ||
          !result.mime.endsWith(output.filename.split('.').at(-1).toLowerCase())
        : !IMAGE_MIMES.has(result.mime) || imageMime(result.bytes) !== result.mime
    )
      throw problem('Comfy original is not a matching PNG, JPEG, WebP, MP4 or WebM file.');
    return { ...result, filename: output.filename };
  }

  async streamVideo(source, { signal, range } = {}) {
    const output = descriptor(source);
    if (!isVideoSource(output)) throw problem('Expected an MP4 or WebM filename.', 400);
    if (range !== undefined && !/^bytes=(?:[0-9]+-[0-9]*|-[0-9]+)$/.test(range))
      throw problem('Invalid video byte range.', 416);
    const response = await this.#fetch(`${this.#baseUrl}/view?${new URLSearchParams(output)}`, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000),
      redirect: 'manual',
      headers: range ? { Range: range } : {},
    });
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(),
      expected = output.filename.toLowerCase().endsWith('.mp4') ? 'video/mp4' : 'video/webm';
    const length = Number(response.headers.get('content-length')),
      contentRange = response.headers.get('content-range');
    const partial = contentRange?.match(/^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/);
    if (
      ![200, 206].includes(response.status) ||
      mime !== expected ||
      length > MAX_VIDEO ||
      (response.status === 206 &&
        (!partial ||
          Number(partial[1]) > Number(partial[2]) ||
          Number(partial[2]) >= Number(partial[3]) ||
          Number(partial[3]) > MAX_VIDEO))
    ) {
      await response.body?.cancel();
      throw problem('Comfy video response is invalid or exceeds 512 MiB.');
    }
    if (!response.body) throw problem('Comfy returned an empty video.');
    let size = 0;
    const reader = response.body.getReader();
    let prefix = Buffer.alloc(0);
    try {
      if (response.status === 200 || (partial?.[1] === '0' && Number(partial[2]) >= 11)) {
        while (prefix.length < 12) {
          const { value, done } = await reader.read();
          if (done) throw problem('Comfy returned an incomplete video.');
          prefix = Buffer.concat([prefix, Buffer.from(value)]);
        }
        if (prefix.length > MAX_VIDEO) throw problem('Comfy video exceeds 512 MiB.');
        if (videoMime(prefix) !== mime) throw problem('Invalid Comfy video signature.');
        size = prefix.length;
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
    return {
      status: response.status,
      mime,
      length: response.headers.get('content-length'),
      contentRange,
      body: new ReadableStream({
        start(controller) {
          if (prefix.length) controller.enqueue(prefix);
        },
        async pull(controller) {
          try {
            const { value, done } = await reader.read();
            if (done) {
              controller.close();
              return;
            }
            size += value.byteLength;
            if (size > MAX_VIDEO) throw problem('Comfy video exceeds 512 MiB.');
            controller.enqueue(value);
          } catch (error) {
            await reader.cancel().catch(() => {});
            controller.error(error);
          }
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      }),
    };
  }

  /**
   * Gives the video memory back. With `keepAbove` (bytes), ComfyUI keeps its models in main
   * memory, so the next generation starts sooner, as long as the machine still has that much
   * memory available; otherwise, or without it, ComfyUI lets go of everything.
   */
  async free({ signal, keepAbove } = {}) {
    let status = await this.status({ signal });
    while (!status.idle) {
      await delay(this.#pollMs, undefined, { signal });
      status = await this.status({ signal });
    }
    const release = async everything => {
      const body = { unload_models: true, ...(everything ? { free_memory: true } : {}) };
      let most = -1,
        steady = 0;
      for (let polls = 0; ; polls++) {
        if (polls <= CACHE_POLLS) await this.#request('/free', { signal, body });
        if (polls) await delay(this.#pollMs, undefined, { signal });
        const now = await this.status({ signal });
        if (now.memory?.torchAllocated === null || !Number.isFinite(now.memory?.torchAllocated))
          throw problem('Cannot measure Comfy torch memory allocation after unload.');
        const free = now.devices
          .filter(device => device.type !== 'cpu')
          .reduce((sum, device) => sum + device.vram_free, 0);
        // A card that does not say what is free is taken at its word on the torch figures.
        steady = !Number.isFinite(free) || free <= most + STILL_GROWING ? steady + 1 : 0;
        most = Math.max(most, Number.isFinite(free) ? free : most);
        if (!now.idle || now.memory.torchAllocated > RELEASED_MEMORY) continue;
        if (polls >= CACHE_POLLS || (now.memory.torchVramTotal <= EMPTIED_CACHE && steady >= 2)) return now;
      }
    };
    if (keepAbove === undefined) return release(true);
    const kept = await release(false);
    return Number(kept.system?.ram_free) >= keepAbove ? kept : release(true);
  }
}
