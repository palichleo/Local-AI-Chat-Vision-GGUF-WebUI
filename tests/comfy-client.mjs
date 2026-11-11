import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ComfyClient, normalizeComfyUrl, previewFrame } from '../lib/comfy-client.mjs';

const png = Buffer.from('89504e470d0a1a0a000102030405', 'hex');
const graph = {
  7: { class_type: 'SaveImage', inputs: {} },
  8: { class_type: 'PreviewImage', inputs: {} },
  9: { class_type: 'CustomSave', inputs: {} },
};
const image = { filename: 'final.png', subfolder: '2026/11', type: 'output' };
const queue = (running = [], pending = []) => ({
  queue_running: running.map(id => [1, id, {}, {}, ['7']]),
  queue_pending: pending.map(id => [2, id, {}, {}, ['7']]),
});
const stats = (allocated = 0) => ({
  system: { comfyui_version: '0.3.0', ram_total: 1024 },
  devices: [
    {
      name: 'fake GPU',
      type: 'cuda',
      vram_total: 8 * 1024 ** 3,
      vram_free: 7 * 1024 ** 3,
      torch_vram_total: 2 * 1024 ** 3,
      torch_vram_free: 2 * 1024 ** 3 - allocated,
    },
  ],
});

async function server(t, handler) {
  const requests = [];
  const app = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://localhost');
    const entry = { method: req.method, url, body, headers: req.headers };
    requests.push(entry);
    try {
      const answer = await handler(entry, requests);
      res.writeHead(answer?.status ?? 200, { 'content-type': 'application/json', ...answer?.headers });
      res.end(
        Buffer.isBuffer(answer?.body) || typeof answer?.body === 'string'
          ? answer.body
          : JSON.stringify(answer?.body ?? {}),
      );
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve, reject) => {
        app.closeAllConnections();
        app.close(error => (error ? reject(error) : resolve()));
      }),
  );
  const url = `http://127.0.0.1:${app.address().port}`;
  return { client: new ComfyClient(url, { pollMs: 1 }), requests, url };
}

test('normalizes literal loopback HTTP URLs and rejects authority tricks', () => {
  assert.equal(normalizeComfyUrl('http://LOCALHOST:8188/'), 'http://localhost:8188');
  assert.equal(normalizeComfyUrl('http://[::1]:7821'), 'http://[::1]:7821');
  for (const value of [
    'https://localhost:8188',
    'http://localhost.evil',
    'http://127.0.0.2',
    'http://2130706433',
    'http://127.1',
    'http://0x7f000001',
    'http://user@localhost',
    'http://localhost/?x=1',
    'http://localhost/#x',
    'http://localhost\\@evil',
    'http://localhost/%2e%2e/secret',
    'http://localhost:8188/prefix',
    'file:///tmp',
    '',
    null,
  ]) {
    assert.throws(() => normalizeComfyUrl(value), /loopback|URL|localhost|HTTP/i, String(value));
  }
});

test('status exposes queue counts and measured torch allocation', async t => {
  const { client, requests } = await server(t, ({ url }) => ({
    body: url.pathname === '/queue' ? queue(['other'], ['pending']) : stats(123),
  }));
  const result = await client.status();
  assert.equal(result.running, 1);
  assert.equal(result.queue, 1);
  assert.equal(result.idle, false);
  assert.equal(result.memory.torchAllocated, 123);
  assert.equal(result.devices[0].name, 'fake GPU');
  assert.deepEqual(requests.map(({ url }) => url.pathname).sort(), ['/queue', '/system_stats']);
});

test('workflow discovery and reads use readonly userdata and encode names', async t => {
  const { client, requests } = await server(t, ({ url }) => {
    if (url.pathname === '/userdata') {
      assert.equal(url.searchParams.get('dir'), 'workflows');
      assert.equal(url.searchParams.get('recurse'), 'true');
      return { body: ['Portrait.json', 'nested/a b.json', 'readme.txt'] };
    }
    if (url.pathname === '/object_info') return { body: { SaveImage: { output_node: true } } };
    assert.equal(decodeURIComponent(url.pathname), '/userdata/workflows/nested/a b.json');
    return { body: { nodes: [{ id: 7 }], extra: {} } };
  });
  assert.deepEqual(await client.workflows(), [
    { name: 'Portrait.json', path: 'Portrait.json' },
    { name: 'nested/a b.json', path: 'nested/a b.json' },
  ]);
  assert.deepEqual(await client.workflow('nested/a b.json'), { nodes: [{ id: 7 }], extra: {} });
  assert.equal((await client.objectInfo()).SaveImage.output_node, true);
  for (const name of ['../secret.json', '/secret.json', 'a\\b.json', 'a/%2e%2e/b.json', 'a//b.json', 'a.txt'])
    await assert.rejects(client.workflow(name), /path|workflow|name/i);
  assert.ok(requests.every(({ method }) => method === 'GET'));
});

test('workflow discovery rejects hostile returned paths and treats missing folders as empty', async t => {
  const { client } = await server(t, () => ({ body: ['../secret.json'] }));
  await assert.rejects(client.workflows(), /path|workflow/i);
  const missing = await server(t, () => ({ status: 404, body: { error: 'missing' } }));
  assert.deepEqual(await missing.client.workflows(), []);
});

test('upload sends a nonoverwriting multipart input and returns a validated descriptor', async t => {
  const { client, requests } = await server(t, ({ method, url, body, headers }) => {
    assert.equal(method, 'POST');
    assert.equal(url.pathname, '/upload/image');
    assert.match(headers['content-type'], /^multipart\/form-data; boundary=/);
    assert.ok(body.includes(png));
    assert.match(body.toString('latin1'), /name="overwrite"\r\n\r\nfalse/);
    assert.match(body.toString('latin1'), /name="type"\r\n\r\ninput/);
    return { body: { name: 'ref (1).png', subfolder: '', type: 'input' } };
  });
  assert.deepEqual(await client.upload(png, { filename: 'ref.png', mime: 'image/png' }), {
    filename: 'ref (1).png',
    name: 'ref (1).png',
    subfolder: '',
    type: 'input',
  });
  await assert.rejects(client.upload(png, { filename: '../ref.png', mime: 'image/png' }), /filename|path/i);
  await assert.rejects(client.upload(png, { filename: 'ref.svg', mime: 'image/svg+xml' }), /image|mime/i);
  assert.equal(requests.length, 1);
});

test('original preserves exact bytes, supports image types, and requests only output originals', async t => {
  let fixture = { bytes: png, mime: 'image/png' };
  const { client } = await server(t, ({ url }) => {
    assert.equal(url.pathname, '/view');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      filename: 'final.png',
      subfolder: '2026/11',
      type: 'output',
    });
    return { body: fixture.bytes, headers: { 'content-type': fixture.mime } };
  });
  for (const next of [
    { bytes: png, mime: 'image/png' },
    { bytes: Buffer.from('ffd8ffe000010203', 'hex'), mime: 'image/jpeg' },
    { bytes: Buffer.from('52494646000000005745425001020304', 'hex'), mime: 'image/webp' },
  ]) {
    fixture = next;
    const result = await client.original(image);
    assert.deepEqual(result, { bytes: next.bytes, mime: next.mime, filename: 'final.png' });
  }
});

test('original rejects traversal, previews, redirects, MIME deception, and size overflow', async t => {
  let answer = { status: 302, headers: { location: 'http://example.com/private' } };
  const { client, requests } = await server(t, () => answer);
  for (const source of [
    { ...image, filename: '../bad.png' },
    { ...image, subfolder: '../private' },
    { ...image, subfolder: 'C:\\private' },
    { ...image, filename: '%2e%2e.png' },
    { ...image, type: 'temp' },
  ])
    await assert.rejects(client.original(source), /path|filename|output|descriptor/i);
  assert.equal(requests.length, 0);
  await assert.rejects(client.original(image), /redirect|302/i);
  assert.equal(requests.length, 1);
  answer = { body: Buffer.from('<html>not an image</html>'), headers: { 'content-type': 'image/png' } };
  await assert.rejects(client.original(image), /image|PNG/i);
  answer = { body: png, headers: { 'content-type': 'image/png', 'content-length': String(64 * 1024 ** 2 + 1) } };
  await assert.rejects(client.original(image), /64|large|size/i);
});

test('HTTP and malformed JSON errors include useful context; aborted calls do not fetch', async t => {
  let answer = { status: 400, body: { error: 'Node input missing', node_errors: { 7: { errors: [] } } } };
  const { client, requests } = await server(t, () => answer);
  await assert.rejects(client.objectInfo(), /400.*Node input missing|Node input missing.*400/);
  answer = { body: 'not JSON' };
  await assert.rejects(client.objectInfo(), /JSON|response/i);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.objectInfo({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(requests.length, 2);
});

test('run polls its own history and returns only final saved image outputs', async t => {
  let polls = 0;
  const progress = [];
  const { client } = await server(t, ({ method, url, body }) => {
    if (url.pathname === '/prompt') {
      assert.equal(method, 'POST');
      const submitted = JSON.parse(body),
        id = submitted.partial_execution_targets[0];
      assert.ok(['7', '9'].includes(id));
      assert.deepEqual(submitted.prompt, { [id]: graph[id] });
      return { body: { prompt_id: 'mine', number: 2, node_errors: {} } };
    }
    if (url.pathname === '/queue') return { body: queue(polls > 0 ? ['mine'] : ['other'], polls > 0 ? [] : ['mine']) };
    assert.equal(url.pathname, '/history/mine');
    polls++;
    return {
      body:
        polls < 3
          ? {}
          : {
              mine: {
                status: { status_str: 'success', completed: true, messages: [] },
                outputs: {
                  7: { images: [image, { ...image, type: 'temp' }] },
                  8: { images: [{ ...image, filename: 'preview.png' }] },
                  9: { images: [{ ...image, filename: 'custom.png' }] },
                },
              },
            },
    };
  });
  assert.deepEqual(await client.run(graph, { onProgress: entry => progress.push(entry) }), {
    promptId: 'mine',
    outputs: [image],
  });
  assert.ok(progress.some(({ state }) => state === 'running'));
  assert.ok(progress.some(({ state }) => state === 'completed'));
  assert.deepEqual(await client.run(graph, { outputNodes: ['9'] }), {
    promptId: 'mine',
    outputs: [{ ...image, filename: 'custom.png' }],
  });
});

test('run surfaces validation and execution failures without returning partial images', async t => {
  let mode = 'validation';
  const { client } = await server(t, ({ url }) => {
    if (url.pathname === '/prompt')
      return mode === 'validation'
        ? {
            status: 400,
            body: {
              error: { message: 'Invalid graph' },
              node_errors: { 7: { errors: [{ message: 'Missing images' }] } },
            },
          }
        : { body: { prompt_id: 'mine' } };
    if (url.pathname === '/queue') return { body: queue() };
    return {
      body: {
        mine: {
          status: {
            status_str: 'error',
            completed: false,
            messages: [['execution_error', { exception_message: 'Out of VRAM', node_id: '7' }]],
          },
          outputs: { 7: { images: [image] } },
        },
      },
    };
  });
  await assert.rejects(client.run(graph), /Invalid graph|Missing images/);
  mode = 'execution';
  await assert.rejects(client.run(graph), /Out of VRAM/);
});

test('run abort deletes only its own queued prompt and never interrupts unrelated execution', async t => {
  const controller = new AbortController();
  let deleted = false;
  const { client, requests } = await server(t, ({ url, method }) => {
    if (url.pathname === '/prompt') return { body: { prompt_id: 'mine' } };
    if (url.pathname === '/history/mine') return { body: {} };
    if (url.pathname === '/queue' && method === 'POST') deleted = true;
    if (url.pathname === '/queue') return { body: queue(['other'], deleted ? [] : ['mine']) };
    return { body: {} };
  });
  await assert.rejects(client.run(graph, { signal: controller.signal, onProgress: () => controller.abort() }), {
    name: 'AbortError',
  });
  assert.ok(
    requests.some(
      ({ method, url, body }) =>
        method === 'POST' && url.pathname === '/queue' && body.toString() === '{"delete":["mine"]}',
    ),
  );
  assert.ok(requests.every(({ url }) => url.pathname !== '/interrupt'));
});

test('run abort targets only its running prompt and waits until it leaves the queue', async t => {
  const controller = new AbortController();
  let interrupted = false;
  const { client, requests } = await server(t, ({ url, method, body }) => {
    if (url.pathname === '/prompt') return { body: { prompt_id: 'mine' } };
    if (url.pathname === '/history/mine') return { body: {} };
    if (url.pathname === '/queue' && method === 'GET')
      return { body: queue(interrupted ? ['other'] : ['mine'], ['other-pending']) };
    if (url.pathname === '/api/jobs/mine/cancel') {
      assert.equal(method, 'POST');
      interrupted = true;
      return { body: { cancelled: true } };
    }
    return { body: {} };
  });
  await assert.rejects(client.run(graph, { signal: controller.signal, onProgress: () => controller.abort() }), {
    name: 'AbortError',
  });
  assert.equal(interrupted, true);
  assert.ok(requests.every(({ url }) => url.pathname !== '/interrupt'));
  assert.ok(requests.filter(({ url, method }) => url.pathname === '/queue' && method === 'GET').length >= 2);
});

test('free waits for an idle queue then confirms low torch allocation', async t => {
  let statusPolls = 0;
  let memoryPolls = 0;
  let freed = false;
  const { client, requests } = await server(t, ({ method, url, body }) => {
    if (url.pathname === '/queue') return { body: ++statusPolls < 3 ? queue(['other']) : queue() };
    if (url.pathname === '/system_stats') return { body: stats(freed && ++memoryPolls >= 2 ? 100 : 1024 ** 3) };
    assert.equal(url.pathname, '/free');
    assert.equal(method, 'POST');
    assert.deepEqual(JSON.parse(body), { unload_models: true, free_memory: true });
    assert.ok(statusPolls >= 3);
    freed = true;
    return { body: {} };
  });
  const result = await client.free();
  assert.ok(result.memory.torchAllocated <= 512 * 1024 ** 2);
  // Asked again at each poll: a request that arrives while ComfyUI finishes a job can wait.
  assert.ok(requests.filter(({ url }) => url.pathname === '/free').length >= 1);
});

test('free can be aborted before unload and refuses unmeasurable memory', async t => {
  const controller = new AbortController();
  const { client, requests } = await server(t, ({ url }) => {
    if (url.pathname === '/queue') {
      controller.abort();
      return { body: queue(['other']) };
    }
    return { body: stats() };
  });
  await assert.rejects(client.free({ signal: controller.signal }), { name: 'AbortError' });
  assert.ok(requests.every(({ url }) => url.pathname !== '/free'));
  const unknown = await server(t, ({ url }) => ({
    body: url.pathname === '/queue' ? queue() : { system: {}, devices: [{ name: 'GPU', type: 'cuda' }] },
  }));
  await assert.rejects(unknown.client.free(), /memory|allocation|measure/i);
});

test('aborting while prompt submission is acknowledged still cancels the known prompt', async t => {
  const controller = new AbortController();
  let deleted = false;
  const { client } = await server(t, async ({ url, method }) => {
    if (url.pathname === '/prompt') {
      controller.abort();
      await new Promise(resolve => setTimeout(resolve, 10));
      return { body: { prompt_id: 'mine' } };
    }
    if (url.pathname === '/queue' && method === 'POST') deleted = true;
    return { body: queue() };
  });
  await assert.rejects(client.run(graph, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(deleted, true);
});

test('run rejects invalid selections, unsafe final descriptors, and vanished prompts', async t => {
  let mode = 'unsafe';
  const { client, requests } = await server(t, ({ url }) => {
    if (url.pathname === '/prompt') return { body: { prompt_id: 'mine' } };
    if (url.pathname === '/history/mine')
      return {
        body:
          mode === 'unsafe'
            ? {
                mine: {
                  status: { completed: true, status_str: 'success', messages: [] },
                  outputs: { 7: { images: [{ ...image, filename: '../secret.png' }] } },
                },
              }
            : {},
      };
    return { body: queue() };
  });
  for (const invalid of [{}, { nodes: [] }, { 1: { class_type: 'SaveImage' } }])
    await assert.rejects(client.run(invalid), /graph|workflow/i);
  await assert.rejects(client.run(graph, { outputNodes: ['missing'] }), /output/i);
  assert.equal(requests.length, 0);
  await assert.rejects(client.run(graph), /filename|path/i);
  mode = 'vanished';
  await assert.rejects(client.run(graph), /disappeared|history/i);
});

test('original enforces its byte cap while streaming without a Content-Length', async () => {
  let cancelled = false;
  const client = new ComfyClient('http://localhost:8188', {
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024 ** 2));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'image/png' } },
      ),
  });
  await assert.rejects(client.original(image), /64|large|size/i);
  assert.equal(cancelled, true);
});

test('all readonly calls propagate in-flight aborts to HTTP', async () => {
  const client = new ComfyClient('http://localhost:8188', {
    fetchImpl: async (_url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  });
  for (const invoke of [
    signal => client.status({ signal }),
    signal => client.workflows({ signal }),
    signal => client.workflow('portrait.json', { signal }),
    signal => client.objectInfo({ signal }),
    signal => client.original(image, { signal }),
  ]) {
    const controller = new AbortController();
    const pending = invoke(controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  }
});

test('legacy cancellation waits for its running prompt without any unsafe interrupt', async t => {
  const controller = new AbortController();
  let polls = 0;
  const { client, requests } = await server(t, ({ url, method }) => {
    if (url.pathname === '/prompt') return { body: { prompt_id: 'mine' } };
    if (url.pathname === '/history/mine') return { body: {} };
    if (url.pathname === '/queue' && method === 'GET') return { body: queue(++polls < 5 ? ['mine'] : ['other']) };
    if (url.pathname === '/api/jobs/mine/cancel') return { status: 404, body: {} };
    return { body: {} };
  });
  await assert.rejects(client.run(graph, { signal: controller.signal, onProgress: () => controller.abort() }), {
    name: 'AbortError',
  });
  assert.ok(polls >= 5);
  assert.ok(requests.every(({ url }) => url.pathname !== '/interrupt'));
});

test('cancellation cleanup failures remain explicit so callers cannot assume GPU release', async t => {
  const controller = new AbortController();
  const { client } = await server(t, ({ url, method }) => {
    if (url.pathname === '/prompt') return { body: { prompt_id: 'mine' } };
    if (url.pathname === '/history/mine') return { body: {} };
    if (url.pathname === '/queue' && method === 'POST') return { status: 503, body: { error: 'Queue unavailable' } };
    return { body: queue(['mine']) };
  });
  await assert.rejects(
    client.run(graph, { signal: controller.signal, onProgress: () => controller.abort() }),
    error => {
      assert.match(error.message, /Cancellation failed.*Queue unavailable/);
      assert.equal(error.cause.name, 'AbortError');
      assert.equal(error.cleanupError.status, 503);
      return true;
    },
  );
});

test('Windows nested SaveImage descriptors normalize before run results and original requests', async t => {
  const windowsImage = { filename: 'portrait.png', subfolder: 'Atelier\\portraits\\2026', type: 'output' };
  const normalized = { filename: 'portrait.png', subfolder: 'Atelier/portraits/2026', type: 'output' };
  const { client } = await server(t, ({ url }) => {
    if (url.pathname === '/prompt') return { body: { prompt_id: 'mine' } };
    if (url.pathname === '/history/mine')
      return {
        body: {
          mine: {
            status: { completed: true, status_str: 'success', messages: [] },
            outputs: { 7: { images: [windowsImage] } },
          },
        },
      };
    assert.equal(url.pathname, '/view');
    assert.deepEqual(Object.fromEntries(url.searchParams), normalized);
    return { body: png, headers: { 'content-type': 'image/png' } };
  });
  assert.deepEqual(await client.run(graph), { promptId: 'mine', outputs: [normalized] });
  assert.deepEqual(await client.original(windowsImage), { bytes: png, mime: 'image/png', filename: 'portrait.png' });
});

test('Windows nested uploaded input descriptors normalize without changing the filename', async t => {
  const { client } = await server(t, () => ({
    body: { name: 'reference.png', subfolder: 'Atelier\\references/mixed', type: 'input' },
  }));
  assert.deepEqual(await client.upload(png, { filename: 'reference.png', mime: 'image/png' }), {
    filename: 'reference.png',
    name: 'reference.png',
    subfolder: 'Atelier/references/mixed',
    type: 'input',
  });
});

test('mixed Windows separators cannot bypass image traversal, drive, UNC or filename checks', async t => {
  const { client, requests } = await server(t, () => ({ body: {} }));
  for (const subfolder of [
    'nested\\..\\secret',
    'nested/..\\secret',
    'nested\\../secret',
    'C:\\secret',
    '\\\\server\\share',
    '\\root',
    '/root',
    'nested\\\\empty',
  ]) {
    await assert.rejects(client.original({ ...image, subfolder }), /path|descriptor/i, subfolder);
  }
  await assert.rejects(client.original({ ...image, filename: 'nested\\portrait.png' }), /filename|path/i);
  assert.equal(requests.length, 0);
  const hostile = await server(t, () => ({
    body: { name: 'reference.png', subfolder: 'safe\\..\\private', type: 'input' },
  }));
  await assert.rejects(hostile.client.upload(png, { filename: 'reference.png', mime: 'image/png' }), /path/i);
});

test('video jobs collect final MP4/WebM outputs from native and extension history without image previews', async t => {
  const clip = { filename: 'clip.mp4', subfolder: 'motion', type: 'output' },
    webm = { filename: 'clip.webm', subfolder: 'motion', type: 'output' };
  const { client } = await server(t, ({ url }) => ({
    body:
      url.pathname === '/prompt'
        ? { prompt_id: 'video-job' }
        : {
            'video-job': {
              status: { completed: true },
              outputs: { 9: { images: [image], videos: [clip], gifs: [webm, { ...clip, type: 'temp' }, clip] } },
            },
          },
  }));
  const result = await client.run(graph, { outputNodes: ['9'], mediaType: 'video' });
  assert.deepEqual(result.outputs, [clip, webm]);
});
test('video originals are signature checked, MIME matched and filename constrained', async t => {
  const bytes = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex');
  let bad = false;
  const { client } = await server(t, () => ({ headers: { 'content-type': 'video/mp4' }, body: bad ? png : bytes }));
  const clip = { filename: 'clip.mp4', subfolder: 'motion', type: 'output' };
  assert.deepEqual((await client.original(clip)).bytes, bytes);
  bad = true;
  await assert.rejects(client.original(clip), /video|vidéo|matching|signature|MP4/i);
});

test('video streaming accepts a short initial browser range and propagates cancellation', async t => {
  const bytes = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex');
  const { client } = await server(t, ({ headers }) => {
    assert.equal(headers.range, 'bytes=0-7');
    return {
      status: 206,
      headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-7/24' },
      body: bytes.subarray(0, 8),
    };
  });
  const result = await client.streamVideo(
    { filename: 'clip.mp4', subfolder: '', type: 'output' },
    { range: 'bytes=0-7' },
  );
  assert.equal(result.status, 206);
  assert.deepEqual(Buffer.from(await new Response(result.body).arrayBuffer()), bytes.subarray(0, 8));
  let cancelled = false;
  const other = new ComfyClient('http://127.0.0.1:8188', {
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'video/mp4' } },
      ),
  });
  const stream = await other.streamVideo({ filename: 'clip.mp4', subfolder: '', type: 'output' });
  await stream.body.cancel();
  assert.equal(cancelled, true);
});

test('selected outputs submit only their upstream branch, excluding unselected photo and video outputs', async t => {
  const source = {
    1: { class_type: 'UserPrompt', inputs: { text: 'p' } },
    2: { class_type: 'ImageOutput', inputs: { text: ['1', 0] } },
    3: { class_type: 'VideoOutput', inputs: { text: ['1', 0] } },
    4: { class_type: 'UnusedHeavyModel', inputs: {} },
  };
  const { client } = await server(t, ({ url, body }) => {
    if (url.pathname === '/prompt') {
      const submitted = JSON.parse(body);
      assert.deepEqual(Object.keys(submitted.prompt), ['1', '2']);
      assert.deepEqual(submitted.partial_execution_targets, ['2']);
      return { body: { prompt_id: 'selected' } };
    }
    return { body: { selected: { status: { completed: true }, outputs: { 2: { images: [image] } } } } };
  });
  assert.deepEqual((await client.run(source, { outputNodes: ['2'] })).outputs, [image]);
  assert.equal(Object.keys(source).length, 4);
});

const jpegPreview = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7)]);
/** A binary message as ComfyUI sends it: the kind of message, the kind of image, the image. */
const binary = (event, format, image) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(event, 0);
  head.writeUInt32BE(format, 4);
  const bytes = Buffer.concat([head, image]);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
};

test('a preview message gives its image; anything else gives nothing', () => {
  assert.deepEqual(previewFrame(binary(1, 1, jpegPreview)), { bytes: jpegPreview, mime: 'image/jpeg' });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
  assert.deepEqual(previewFrame(binary(1, 2, png)), { bytes: png, mime: 'image/png' });
  // Another kind of message, bytes that are no image, a text message, too large a picture.
  assert.equal(previewFrame(binary(3, 1, jpegPreview)), null);
  assert.equal(previewFrame(binary(1, 1, Buffer.from('<svg onload=alert(1)>'))), null);
  assert.equal(previewFrame('{"type":"progress"}'), null);
  assert.equal(previewFrame(binary(1, 1, Buffer.concat([jpegPreview, Buffer.alloc(3 * 1024 * 1024)]))), null);
  assert.equal(previewFrame(new ArrayBuffer(4)), null);
});

test('the picture ComfyUI has so far reaches the caller, and the cheap preview is asked for by name', async t => {
  const sockets = [];
  class Socket {
    constructor(address) {
      this.address = address;
      sockets.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  let submitted,
    polls = 0;
  const { url } = await server(t, ({ url, body }) => {
    if (url.pathname === '/prompt') {
      submitted = JSON.parse(body);
      return { body: { prompt_id: 'mine' } };
    }
    if (url.pathname === '/queue') return { body: queue(['mine']) };
    if (++polls === 1) {
      // While it samples: a step, the picture so far, then messages that are not pictures.
      const [socket] = sockets;
      socket.onmessage({ data: JSON.stringify({ type: 'progress', data: { value: 3, max: 8, node: '7' } }) });
      socket.onmessage({ data: binary(1, 1, jpegPreview) });
      socket.onmessage({ data: binary(3, 1, jpegPreview) });
      socket.onmessage({ data: binary(1, 1, Buffer.from('not a picture at all')) });
    }
    return {
      body:
        polls < 2
          ? {}
          : { mine: { status: { status_str: 'success', completed: true }, outputs: { 7: { images: [image] } } } },
    };
  });
  const client = new ComfyClient(url, { pollMs: 1, socketImpl: Socket });
  const seen = [];
  await client.run(graph, { outputNodes: ['7'], onProgress: entry => seen.push(entry) });
  // latent2rgb turns the latent into colours without the VAE: no video memory is spent on it.
  assert.deepEqual(submitted.extra_data, { preview_method: 'latent2rgb' });
  assert.equal(sockets[0].binaryType, 'arraybuffer');
  assert.deepEqual(
    seen.filter(entry => entry.state === 'preview'),
    [{ state: 'preview', promptId: 'mine', bytes: jpegPreview, mime: 'image/jpeg' }],
  );
  assert.ok(seen.some(entry => entry.state === 'step' && entry.value === 3));
  assert.equal(sockets[0].closed, true);
});
