import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Resources, resourceCatalogPrompt, shownCatalog } from '../lib/resources.mjs';
import { citedNumbers } from '../lib/cited-resources.mjs';
import { createApplication } from '../server.mjs';
import { Gallery } from '../lib/gallery.mjs';
import { readSSE } from '../public/stream.mjs';
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rLkAAAAASUVORK5CYII=';
const bytes = Buffer.from(png.split(',')[1], 'base64');
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'atelier-resources-'));
  assert.equal(dirname(root), tmpdir());
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return root;
}
async function image(store, name = 'Reference.png', project) {
  const record = await store.add(Readable.from([bytes]), {
    name,
    mime: 'image/png',
    length: bytes.length,
    ...(project ? { project } : {}),
  });
  return store.update(record.id, {
    description: 'Reference de lumière bleue',
    prepared: { width: 1, height: 1, frames: [{ url: png, time: null }] },
  });
}
test('resources persist independently of conversations and activation survives reopening', async t => {
  const root = await directory(t),
    path = join(root, 'data/resources'),
    store = new Resources(path),
    record = await image(store);
  assert.equal((await store.catalog()).length, 1);
  assert.equal((await store.readActive(record.id)).frames[0].url, png);
  await store.update(record.id, { enabled: false, description: 'Un style précis' });
  const restored = new Resources(path);
  assert.equal((await restored.list())[0].description, 'Un style précis');
  assert.equal((await restored.catalog()).length, 0);
  await assert.rejects(restored.readActive(record.id), { status: 403 });
  await restored.update(record.id, { enabled: true });
  assert.equal((await restored.catalog()).length, 1);
  const original = join(root, 'external-original.png');
  await writeFile(original, bytes);
  await restored.remove(record.id);
  assert.deepEqual(await readFile(original), bytes);
  assert.equal((await store.list()).length, 0);
  await assert.rejects(store.readActive(record.id), { status: 404 });
});
test('invalid media, oversized uploads and library path links cannot become resources', async t => {
  const root = await directory(t),
    store = new Resources(join(root, 'resources'));
  await assert.rejects(
    store.add(Readable.from([Buffer.from('<script>bad</script>')]), { name: 'bad.png', mime: 'image/png' }),
    /contenu/,
  );
  await assert.rejects(store.add(Readable.from([bytes]), { name: '../outside', mime: 'image/png' }), /Nom/);
  await assert.rejects(
    store.add(Readable.from([bytes]), { name: 'large.png', mime: 'image/png', length: 65 * 1024 ** 2 }),
    { status: 413 },
  );
  const outside = join(root, 'outside');
  await mkdir(outside);
  const linked = join(root, 'linked');
  await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new Resources(linked).add(Readable.from([bytes]), { name: 'safe.png', mime: 'image/png' }));
  assert.equal((await store.list()).length, 0);
  await assert.rejects(store.remove('../outside'));
});
test('short annotations and video frame limits are validated, and originals stay byte exact', async t => {
  const root = await directory(t),
    store = new Resources(join(root, 'resources')),
    video = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, ...Buffer.from('isom12345678')]);
  const record = await store.add(Readable.from([video]), { name: 'clip.mp4', mime: 'video/mp4' });
  await assert.rejects(store.update(record.id, { description: 'x'.repeat(301) }));
  await assert.rejects(
    store.update(record.id, { prepared: { width: 100, height: 100, duration: 10, frames: [{ url: png, time: 11 }] } }),
  );
  await store.update(record.id, {
    prepared: { width: 100, height: 100, duration: 10, frames: [1, 5, 9].map(time => ({ time, url: png })) },
  });
  const restored = await store.readActive(record.id);
  assert.deepEqual(
    restored.frames.map(frame => frame.time),
    [1, 5, 9],
  );
  const asset = await store.media(record.id, 'original');
  try {
    assert.deepEqual(await asset.handle.readFile(), video);
  } finally {
    await asset.handle.close();
  }
  const prompt = resourceCatalogPrompt(await store.catalog());
  assert.match(prompt, /sans audio/);
  assert.doesNotMatch(prompt, /base64/);
});
test('closing aborts unfinished uploads and removes partial application copies', async t => {
  const root = await directory(t),
    store = new Resources(join(root, 'resources'));
  let received;
  const stream = new Readable({
    read() {
      if (!received) {
        received = true;
        this.push(bytes);
      }
    },
  });
  const upload = store.add(stream, { name: 'partial.png', mime: 'image/png' });
  await new Promise(resolve => setTimeout(resolve, 15));
  await store.close();
  await assert.rejects(upload);
  assert.equal((await new Resources(store.directory).list()).length, 0);
});
async function apiFixture(t, { engine = false } = {}) {
  const root = await directory(t);
  let app;
  const options = {
    port: 0,
    dataDir: root,
    chatHeartbeatMs: 20,
    ...(engine
      ? {
          spawnProcess: (_command, args, config) =>
            spawn(
              process.execPath,
              [fileURLToPath(new URL('./fixtures/fake-resource-engine.mjs', import.meta.url)), ...args],
              config,
            ),
        }
      : {}),
  };
  app = await createApplication(options);
  t.after(() => app.close());
  let token = (await (await fetch(app.url + '/api/bootstrap')).json()).token;
  const request = (route, body) =>
    fetch(app.url + '/api/' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const upload = async project => {
    const response = await fetch(app.url + '/api/resources/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'image/png',
        'X-Resource-Name': encodeURIComponent('native.png'),
        ...(project ? { 'X-Resource-Project': project } : {}),
      },
      body: bytes,
    });
    assert.equal(response.status, 201);
    const record = await response.json();
    return (
      await request('resources/update', {
        id: record.id,
        patch: {
          description: 'Blue light reference',
          prepared: { width: 1, height: 1, frames: [{ url: png, time: null }] },
        },
      })
    ).json();
  };
  return {
    root,
    options,
    get app() {
      return app;
    },
    request,
    upload,
    async reopen() {
      await app.close();
      app = await createApplication(options);
      token = (await (await fetch(app.url + '/api/bootstrap')).json()).token;
    },
  };
}
test('resource HTTP media uses scoped tickets, byte ranges and survives clearing history and restart', async t => {
  const f = await apiFixture(t),
    record = await f.upload();
  assert.match((await fetch(f.app.url)).headers.get('content-security-policy'), /media-src 'self' blob:/);
  assert.equal((await fetch(f.app.url + '/api/resources')).status, 401);
  let response = await fetch(f.app.url + record.originalUrl, { headers: { Range: 'bytes=1-4' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 1-4/${bytes.length}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(1, 5));
  response = await fetch(f.app.url + record.originalUrl, { headers: { Range: 'bytes=9999-' } });
  assert.equal(response.status, 416);
  assert.equal((await fetch(f.app.url + record.originalUrl.replace(/key=.*/, 'key=wrong'))).status, 401);
  assert.equal((await f.request('history/clear', { confirm: true })).status, 200);
  await f.reopen();
  const list = await (await f.request('resources')).json();
  assert.equal(list.resources.length, 1);
  assert.equal(list.resources[0].description, 'Blue light reference');
  assert.equal((await fetch(f.app.url + list.resources[0].previewUrl)).status, 200);
  await f.request('resources/update', { id: record.id, patch: { enabled: false } });
  assert.equal((await f.request('resources/read', { id: record.id })).status, 403);
});
test('native resource lookup receives the current active catalog without handing the GPU to Comfy', async t => {
  const f = await apiFixture(t, { engine: true }),
    active = await f.upload(),
    inactive = await f.upload();
  await f.request('resources/update', { id: inactive.id, patch: { enabled: false, description: 'Hidden annotation' } });
  const modelPath = join(f.root, 'model.gguf'),
    projectorPath = join(f.root, 'vision.gguf');
  await writeFile(modelPath, Buffer.from('GGUF\x03\0\0\0'));
  await writeFile(projectorPath, Buffer.from('GGUF\x03\0\0\0'));
  await f.request('config', {
    enginePath: process.execPath,
    modelPath,
    projectorPath,
    contextSize: 8192,
    maxOutputTokens: 1024,
    gpuLayers: 0,
  });
  await f.request('start', {});
  const end = Date.now() + 10000;
  while ((await (await f.request('status')).json()).state !== 'ready') {
    if (Date.now() > end) assert.fail('Engine did not become ready');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  const events = [];
  const response = await f.request('chat', {
    messages: [{ role: 'user', content: 'read ' + active.id }],
    turnId: randomUUID(),
    conversationId: randomUUID(),
  });
  await readSSE(response.body, event => events.push(event));
  const native = events.find(event => event.local_tool_request)?.local_tool_request;
  assert.equal(native.kind, 'resource');
  assert.equal(native.resourceId, active.id);
  assert.doesNotMatch(JSON.stringify(events), /base64/);
  assert.equal((await (await f.request('status')).json()).state, 'ready');
  assert.equal((await (await f.request('status')).json()).toolJob, null);
  const inspected = [];
  await readSSE(
    (
      await f.request('chat', {
        messages: [{ role: 'user', content: 'inspect resources' }],
        turnId: randomUUID(),
        conversationId: randomUUID(),
      })
    ).body,
    event => inspected.push(event),
  );
  const body = inspected.find(event => event.local_test_payload).local_test_payload;
  assert.match(body.messages[0].content, /Blue light reference/);
  assert.doesNotMatch(body.messages[0].content, /Hidden annotation/);
  assert.equal(body.tools[0].function.name, 'local_read_resource');
  assert.deepEqual(body.tools[0].function.parameters.properties.resource_id.enum, [active.id]);
  const another = await f.upload(),
    batch = [];
  await readSSE(
    (
      await f.request('chat', {
        messages: [{ role: 'user', content: 'read-many ' + [active.id, another.id].join(',') }],
        turnId: randomUUID(),
        conversationId: randomUUID(),
      })
    ).body,
    event => batch.push(event),
  );
  assert.deepEqual(batch.find(event => event.local_tool_request).local_tool_request.resourceIds, [
    active.id,
    another.id,
  ]);
  assert.doesNotMatch(JSON.stringify(batch), /base64/);
});

test('deleting a resource closes its open media handles before removing its managed copies', async t => {
  const root = await directory(t),
    store = new Resources(join(root, 'resources')),
    record = await image(store),
    asset = await store.media(record.id, 'original');
  await store.remove(record.id);
  await assert.rejects(asset.handle.stat());
  assert.equal((await store.list()).length, 0);
});

test('a new import can finalize while another client chats, without allowing active-resource mutations', async t => {
  const f = await apiFixture(t, { engine: true });
  const modelPath = join(f.root, 'model.gguf');
  await writeFile(modelPath, Buffer.from('GGUF\x03\0\0\0'));
  await f.request('config', {
    enginePath: process.execPath,
    modelPath,
    projectorPath: '',
    contextSize: 8192,
    maxOutputTokens: 1024,
    gpuLayers: 0,
  });
  await f.request('start', {});
  const end = Date.now() + 10000;
  while ((await (await f.request('status')).json()).state !== 'ready') {
    if (Date.now() > end) assert.fail('Engine did not start');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  const response = await f.request('chat', {
      messages: [{ role: 'user', content: 'slow resource test' }],
      turnId: randomUUID(),
      conversationId: randomUUID(),
    }),
    reader = response.body.getReader();
  await reader.read();
  assert.equal((await (await f.request('status')).json()).busy, true);
  try {
    const heartbeat = await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(Error('Chat stream idle timeout')), 1000);
        timer.unref();
      }),
    ]);
    assert.match(new TextDecoder().decode(heartbeat.value), /keepalive/);
    const resource = await f.upload();
    assert.equal(resource.ready, true);
    assert.equal((await f.request('resources/update', { id: resource.id, patch: { enabled: false } })).status, 409);
  } finally {
    await reader.cancel();
  }
});

test('reference labels survive deactivation, deletion, additional imports and reopening', async t => {
  const root = await directory(t),
    path = join(root, 'resources'),
    store = new Resources(path),
    a = await image(store, 'a.png'),
    b = await image(store, 'b.png');
  assert.equal(a.label, '#ref1');
  assert.equal(b.label, '#ref2');
  await store.update(a.id, { enabled: false });
  assert.equal((await store.catalog())[0].label, '#ref2');
  await store.remove(a.id);
  const c = await image(new Resources(path), 'c.png');
  assert.equal(c.label, '#ref3');
  assert.deepEqual(
    (await new Resources(path).list()).map(item => item.label),
    ['#ref2', '#ref3'],
  );
  const f = await apiFixture(t),
    one = await f.upload(),
    two = await f.upload();
  const result = await (await f.request('resources/read', { ids: [one.id, two.id] })).json();
  assert.deepEqual(
    result.resources.map(item => item.label),
    ['#ref1', '#ref2'],
  );
  await f.request('resources/update', { id: two.id, patch: { enabled: false } });
  assert.equal((await f.request('resources/read', { ids: [one.id, two.id] })).status, 403);
});

test('the final image review can still read references when further generations are disabled', async t => {
  const f = await apiFixture(t, { engine: true }),
    active = await f.upload();
  const modelPath = join(f.root, 'model.gguf'),
    projectorPath = join(f.root, 'vision.gguf');
  await writeFile(modelPath, Buffer.from('GGUF\x03\0\0\0'));
  await writeFile(projectorPath, Buffer.from('GGUF\x03\0\0\0'));
  await f.request('config', {
    enginePath: process.execPath,
    modelPath,
    projectorPath,
    contextSize: 8192,
    maxOutputTokens: 1024,
    gpuLayers: 0,
  });
  await f.request('start', {});
  const deadline = Date.now() + 10000;
  while ((await (await f.request('status')).json()).state !== 'ready') {
    if (Date.now() > deadline) assert.fail('Engine not ready');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  // The review follows a generated image: that result is the only one the model may inspect.
  const conversationId = randomUUID(),
    runId = randomUUID();
  await new Gallery({ historyDir: join(f.root, 'history') }).put(
    {
      id: runId,
      conversationId,
      provider: 'native',
      workflowId: 'custom',
      workflowName: 'User workflow',
      prompt: 'A boat',
      parameters: { seed: 1 },
      createdAt: new Date().toISOString(),
      outputs: [{ source: { filename: 'boat.png', subfolder: '', type: 'output' } }],
    },
    { persist: true },
  );
  const events = [];
  await readSSE(
    (
      await f.request('chat', {
        messages: [{ role: 'user', content: 'inspect resources' }],
        tools: false,
        resources: true,
        turnId: randomUUID(),
        conversationId,
      })
    ).body,
    event => events.push(event),
  );
  const body = events.find(event => event.local_test_payload).local_test_payload;
  assert.deepEqual(
    body.tools.map(tool => tool.function.name),
    ['local_read_resource', 'local_read_output'],
  );
  assert.deepEqual(body.tools[0].function.parameters.properties.resource_id.enum, [active.id]);
  assert.deepEqual(body.tools[1].function.parameters.properties.run_id.enum, [runId]);
});

test('each project numbers its own references, shared by its chats and its Studio', async t => {
  const root = await directory(t),
    path = join(root, 'resources'),
    store = new Resources(path),
    project = randomUUID(),
    a = await image(store, 'a.png'),
    b = await image(store, 'b.png', project),
    c = await image(store, 'c.png', project);
  assert.deepEqual([a.project, a.label], ['inbox', '#ref1']);
  assert.deepEqual([b.project, b.label, c.label], [project, '#ref1', '#ref2']);
  // The model of a conversation knows those of its project only.
  assert.deepEqual((await store.catalog(project)).map(item => item.label), ['#ref1', '#ref2']);
  assert.deepEqual((await store.catalog()).map(item => item.name), ['a.png']);
  assert.equal((await store.list()).length, 3);
  await assert.rejects(image(store, 'd.png', '../other'), /Projet invalide/);
  // A project removed: its references go to Conversations, numbered after those it has.
  await store.moveProject(project, 'inbox');
  assert.deepEqual(
    (await new Resources(path).catalog()).map(item => [item.name, item.label]),
    [
      ['a.png', '#ref1'],
      ['b.png', '#ref2'],
      ['c.png', '#ref3'],
    ],
  );
  assert.deepEqual(await store.catalog(project), []);
});

test('the library of before becomes the references of Conversations, their numbers kept', async t => {
  const root = await directory(t),
    path = join(root, 'resources'),
    store = new Resources(path),
    first = await image(store, 'first.png');
  // As 0.5.105 left it: one numbering for everything, « Ref 34 » the last given.
  const ids = { [first.id]: 34 };
  for (let number = 1; number < 34; number++) ids[randomUUID()] = number;
  await writeFile(join(path, 'references.json'), JSON.stringify({ version: 1, next: 35, ids }));
  const restored = new Resources(path);
  assert.equal((await restored.list())[0].label, '#ref34');
  assert.equal((await image(restored, 'next.png')).label, '#ref35');
  assert.equal((await image(restored, 'elsewhere.png', randomUUID())).label, '#ref1');
  const index = JSON.parse(await readFile(join(path, 'references.json'), 'utf8'));
  assert.equal(index.version, 2);
  assert.equal(index.projects.inbox.ids[first.id], 34);
});

test('too many for the model: the least used leave its list, never those the message names', async t => {
  const root = await directory(t),
    store = new Resources(join(root, 'resources')),
    old = await image(store, 'old.png'),
    newer = await image(store, 'newer.png'),
    newest = await image(store, 'newest.png');
  // The oldest is the most used, the newest the least.
  await store.used([old.id, old.id]);
  await store.used([old.id]);
  await store.used([newer.id, 'not-an-id']);
  const catalog = await store.catalog();
  assert.deepEqual(
    catalog.map(item => [item.name, item.uses]),
    [
      ['old.png', 2],
      ['newer.png', 1],
      ['newest.png', 0],
    ],
  );
  const size = items => JSON.stringify(shownCatalog(items, { budget: Infinity })).length;
  // Room for two: the least used leaves, not the oldest.
  const two = size(catalog.slice(0, 2)) + 5;
  assert.deepEqual(shownCatalog(catalog, { budget: two }).map(item => item.name), ['old.png', 'newer.png']);
  // Room for one: the two least used, at once.
  assert.deepEqual(shownCatalog(catalog, { budget: size(catalog.slice(0, 1)) + 5 }).map(item => item.name), ['old.png']);
  // Named in the user's last message: kept, another leaves in its place.
  const named = shownCatalog(catalog, { budget: two, cited: [newest.reference] });
  assert.deepEqual(named.map(item => item.name), ['old.png', 'newest.png']);
  // Used as often: the one whose last use is the oldest leaves.
  await store.used([newest.id]);
  const tied = await store.catalog();
  assert.deepEqual(shownCatalog(tied, { budget: two }).map(item => item.name), ['old.png', 'newest.png']);
  // What the model reads has no count, and nothing was removed from the disk.
  assert.doesNotMatch(resourceCatalogPrompt(tied, { budget: two }), /"uses"|"usedAt"/);
  assert.match(resourceCatalogPrompt(tied), /#ref1, #ref2/);
  assert.equal((await store.list()).length, 3);
  assert.deepEqual(citedNumbers([{ role: 'user', content: 'anime #ref3 et la ref 12' }, { role: 'assistant', content: '#ref9' }]), [3, 12]);
});

test('a reference sent from a chat or the Studio belongs to its project; a reading by the model is a use', async t => {
  const f = await apiFixture(t),
    project = randomUUID(),
    one = await f.upload(project),
    two = await f.upload();
  assert.deepEqual([one.project, one.label, two.project, two.label], [project, '#ref1', 'inbox', '#ref1']);
  await f.request('resources/read', { ids: [one.id] });
  await new Promise(resolve => setTimeout(resolve, 100));
  const listed = (await (await f.request('resources')).json()).resources;
  assert.equal(listed.length, 2);
  assert.equal(listed.find(item => item.id === one.id).uses, 1);
  assert.equal(listed.find(item => item.id === two.id).uses, undefined);
});
