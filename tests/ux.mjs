import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setupSettingsGuard } from '../public/settings-guard.mjs';
import { setupCopy } from '../public/copy.mjs';
import { contextBudget, contextFigure, setupContextMeter } from '../public/context-meter.mjs';
import { countContext } from '../lib/context-count.mjs';
import { createApplication } from '../server.mjs';
function element() {
  return {
    open: false,
    disabled: false,
    textContent: '',
    hidden: false,
    dataset: {},
    style: {
      setProperty(name, value) {
        this[name] = value;
      },
    },
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    listeners: {},
    addEventListener(name, fn) {
      (this.listeners[name] ??= []).push(fn);
    },
    emit(name, event = {}) {
      for (const fn of this.listeners[name] || []) fn(event);
    },
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
      this.emit('close');
    },
  };
}
function settings() {
  const dialog = element(),
    confirmation = element(),
    keep = element(),
    discard = element(),
    saveButton = element();
  let draft = 'saved',
    saves = 0,
    ok = true;
  const guard = setupSettingsGuard({
    dialog,
    confirmation,
    keep,
    discard,
    saveButton,
    readDraft: () => draft,
    save: async () => {
      saves++;
      if (ok) {
        guard.markSaved();
        dialog.close();
      }
      return ok;
    },
  });
  dialog.showModal();
  guard.markSaved();
  return {
    guard,
    dialog,
    confirmation,
    keep,
    discard,
    saveButton,
    change: value => {
      draft = value;
    },
    saves: () => saves,
    fail: () => {
      ok = false;
    },
  };
}
test('settings close silently when unchanged, and a reverted draft is clean', () => {
  const ui = settings();
  ui.change('changed');
  assert.equal(ui.guard.isDirty(), true);
  ui.change('saved');
  assert.equal(ui.guard.isDirty(), false);
  ui.guard.requestClose();
  assert.equal(ui.dialog.open, false);
  assert.equal(ui.confirmation.open, false);
});
test('settings Escape offers keep, discard and save without losing an unsuccessful save', async () => {
  const ui = settings();
  ui.change('draft');
  let prevented = false;
  ui.dialog.emit('cancel', {
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.equal(ui.confirmation.open, true);
  assert.equal(ui.dialog.open, true);
  ui.keep.onclick();
  assert.equal(ui.confirmation.open, false);
  assert.equal(ui.guard.isDirty(), true);
  ui.guard.requestClose();
  ui.fail();
  await ui.saveButton.onclick();
  assert.equal(ui.saves(), 1);
  assert.equal(ui.dialog.open, true);
  assert.equal(ui.guard.isDirty(), true);
  let closed = 0;
  ui.guard.requestClose(() => closed++);
  ui.discard.onclick();
  assert.equal(ui.dialog.open, false);
  assert.equal(closed, 1);
  const saved = settings();
  saved.change('new');
  saved.guard.requestClose(() => closed++);
  await saved.saveButton.onclick();
  assert.equal(saved.dialog.open, false);
  assert.equal(saved.guard.isDirty(), false);
  assert.equal(closed, 2);
});
test('Escape in the warning preserves settings and cancels the deferred action', () => {
  const ui = settings();
  ui.change('draft');
  let actions = 0;
  ui.guard.requestClose(() => actions++);
  ui.confirmation.emit('cancel', { preventDefault() {} });
  assert.equal(ui.dialog.open, true);
  assert.equal(ui.confirmation.open, false);
  assert.equal(actions, 0);
});
test('copying a quote uses its text and copying code excludes labels and fence markers', async () => {
  for (const code of [false, true]) {
    const root = element(),
      label = { textContent: 'Copier' },
      button = element(),
      writes = [],
      announcements = [];
    root.contains = target => target === button;
    button.querySelector = () => label;
    button.hasAttribute = () => code;
    button.closest = () => ({
      querySelector: () =>
        code
          ? { textContent: '<div>é & **literal**</div>' }
          : { nodeType: 3, textContent: 'Un prompt en texte simple.' },
    });
    setupCopy(root, { writeText: async text => writes.push(text), announce: text => announcements.push(text) });
    await root.listeners.click[0]({ target: { closest: () => button } });
    assert.deepEqual(writes, [code ? '<div>é & **literal**</div>' : 'Un prompt en texte simple.']);
    assert.equal(label.textContent, 'Copié');
    assert.match(announcements[0], /copié/);
  }
});
test('clipboard failure never reports success and restores the button', async () => {
  const root = element(),
    button = element(),
    label = { textContent: 'Copier' },
    announcements = [];
  root.contains = () => true;
  button.querySelector = () => label;
  button.hasAttribute = () => true;
  button.closest = () => ({ querySelector: () => ({ textContent: 'code' }) });
  setupCopy(root, {
    writeText: async () => {
      throw Error('Denied');
    },
    announce: text => announcements.push(text),
  });
  await root.listeners.click[0]({ target: { closest: () => button } });
  assert.equal(button.disabled, false);
  assert.equal(label.textContent, 'Copier');
  assert.match(announcements[0], /indisponible/);
});
test('context gauge fills only with used tokens, regardless of response reservation', () => {
  assert.equal(contextBudget({ used: 0, capacity: 65536, reserved: 32768 }).occupied, 0);
  assert.equal(contextBudget({ used: 8192, capacity: 65536, reserved: 32768 }).occupied, 12.5);
  assert.equal(contextBudget({ used: 5000, capacity: 10000, reserved: 4096 }).warning, '');
  assert.equal(contextBudget({ used: 9000, capacity: 10000, reserved: 0 }).warning, 'near');
  assert.equal(contextBudget({ used: 10000, capacity: 10000, reserved: 0 }).warning, 'full');
  const unknown = contextBudget({ used: null, capacity: 8192, reserved: 4096 });
  assert.equal(unknown.used, null);
  assert.equal(unknown.occupied, 0);
  assert.equal(unknown.warning, '');
});

test('the context gauge writes its share in figures beside the bar', () => {
  const figure = (used, precision = 'exact') => contextFigure(contextBudget({ used, capacity: 10000, precision }));
  assert.equal(figure(0), '0 %');
  // Something is used: never « 0 % ».
  assert.equal(figure(40), '< 1 %');
  assert.equal(figure(1249), '12 %');
  assert.equal(figure(4000, 'estimated'), '≈ 40 %');
  assert.equal(figure(6000, 'text-only'), '≥ 60 %');
  assert.equal(figure(12000), '100 %');
  // Not counted (engine stopped): no figure rather than a wrong one.
  assert.equal(figure(null), '');
});

test('no text of the interface is smaller than 12 px', async () => {
  for (const sheet of ['styles.css', 'workspace.css']) {
    const css = await readFile(new URL('../public/' + sheet, import.meta.url), 'utf8');
    const small = [...css.matchAll(/font-size:\s*(?:clamp\()?([\d.]+)px/g)].filter(([, size]) => Number(size) < 12);
    assert.deepEqual(
      small.map(([found]) => found),
      [],
      sheet,
    );
  }
});

test('the context meter ignores stale counts; its details are in its tooltip, its share beside the bar', async () => {
  const nodes = new Map(),
    $ = id => {
      if (!nodes.has(id)) nodes.set(id, element());
      return nodes.get(id);
    };
  const calls = [];
  let ready = true;
  const meter = setupContextMeter({
    $,
    api: (_route, body, options) => new Promise(resolve => calls.push({ body, options, resolve })),
    getRequest: () => ({ messages: [{ role: 'user', content: 'Sent' }] }),
    getConfig: () => ({ contextSize: 8192, maxOutputTokens: 4096 }),
    isReady: () => ready,
    isBusy: () => false,
    delay: 0,
  });
  const tick = () => new Promise(resolve => setTimeout(resolve, 8));
  meter.schedule();
  await tick();
  meter.schedule();
  await tick();
  assert.equal(calls[0].options.signal.aborted, true);
  calls[1].resolve(Response.json({ used: 6000, precision: 'text-only' }));
  await tick();
  assert.match($('context-meter').title, /≥.*6/);
  assert.equal($('context-meter').dataset.warning, '');
  assert.equal($('context-meter').attributes['aria-valuenow'], '6000');
  assert.equal($('context-figure').textContent, '≥ 73 %');
  calls[0].resolve(Response.json({ used: 1, precision: 'exact' }));
  await tick();
  assert.match($('context-meter').title, /6/);
  ready = false;
  meter.schedule();
  await tick();
  assert.equal(calls.length, 2);
  assert.equal($('context-meter').attributes['aria-valuenow'], '6000');
  meter.pause();
});

test('a new conversation resets the gauge to zero and never counts an unsent draft', async () => {
  const nodes = new Map(),
    $ = id => {
      if (!nodes.has(id)) nodes.set(id, element());
      return nodes.get(id);
    };
  let request = null,
    id = null,
    calls = 0;
  const meter = setupContextMeter({
    $,
    api: async () => {
      calls++;
      return Response.json({ used: 1024, precision: 'exact' });
    },
    getRequest: () => request,
    getConversation: () => id,
    getConfig: () => ({ contextSize: 8192, maxOutputTokens: 4096 }),
    isReady: () => true,
    isBusy: () => false,
    delay: 0,
  });
  meter.schedule();
  await new Promise(resolve => setTimeout(resolve, 8));
  assert.equal(calls, 0);
  assert.equal($('context-meter').style['--context-used'], '0%');
  id = 'first';
  request = { messages: [{ role: 'user', content: 'Sent' }] };
  meter.schedule();
  await new Promise(resolve => setTimeout(resolve, 8));
  assert.equal(calls, 1);
  assert.equal($('context-meter').style['--context-used'], '12.5%');
  meter.observe({ usage: { prompt_tokens: 1024, completion_tokens: 1024 } });
  assert.equal($('context-meter').style['--context-used'], '25%');
  id = null;
  request = null;
  meter.schedule();
  assert.equal($('context-meter').style['--context-used'], '0%');
  assert.equal($('context-meter').attributes['aria-valuenow'], '0');
  assert.equal(calls, 1);
  meter.pause();
});
async function countFixture(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push({ path: req.url, body, authorization: req.headers.authorization });
    const result = handler(req.url, body);
    res.writeHead(result.status || 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise(resolve => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    apiKey: 'local-key',
    signal: AbortSignal.timeout(5000),
    requests,
  };
}
const payload = {
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,image' } },
      ],
    },
  ],
  tools: [{ type: 'function' }],
  chat_template_kwargs: { enable_thinking: true },
};
test('native token counting forwards the exact chat inputs including vision and tools without generation', async t => {
  const fixture = await countFixture(t, () => ({ body: { input_tokens: 456 } }));
  assert.deepEqual(await countContext({ ...fixture, payload }), { used: 456, precision: 'exact' });
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].path, '/v1/chat/completions/input_tokens');
  assert.deepEqual(fixture.requests[0].body, payload);
  assert.equal(fixture.requests[0].authorization, 'Bearer local-key');
});
test('older engines count text without passing base64 to their tokenizer or claiming images were counted', async t => {
  const fixture = await countFixture(t, path =>
    path.includes('input_tokens')
      ? { status: 404, body: {} }
      : path === '/apply-template'
        ? { body: { prompt: 'formatted' } }
        : { body: { tokens: [1, 2, 3] } },
  );
  assert.deepEqual(await countContext({ ...fixture, payload }), { used: 3, precision: 'text-only' });
  assert.equal(fixture.requests[1].body.messages[0].content, 'Describe');
  assert.deepEqual(fixture.requests[1].body.tools, payload.tools);
  assert.equal(fixture.requests[2].body.content, 'formatted');
});
test('invalid native counts are rejected rather than displayed as zero', async t => {
  const fixture = await countFixture(t, () => ({ body: { input_tokens: -1 } }));
  await assert.rejects(countContext({ ...fixture, payload }), /Invalid token count/);
});
test('context API does not start a model and uses a ready local engine without starting chat inference', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-context-'));
  assert.equal(dirname(directory), tmpdir());
  const engineFile = fileURLToPath(new URL('./fixtures/fake-engine.mjs', import.meta.url));
  const app = await createApplication({
    port: 0,
    dataDir: directory,
    spawnProcess: (_cmd, args, options) => spawn(process.execPath, [engineFile, ...args], options),
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const boot = await (await fetch(app.url + '/api/bootstrap')).json(),
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${boot.token}` };
  const api = (route, body) =>
    fetch(app.url + '/api/' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const input = { messages: [{ role: 'user', content: '' }] };
  let result = await (await api('context', input)).json();
  assert.equal(result.used, null);
  assert.equal((await (await api('status')).json()).state, 'stopped');
  const modelPath = join(directory, 'model.gguf');
  await writeFile(modelPath, Buffer.from('GGUF\x03\0\0\0'));
  await api('config', {
    enginePath: process.execPath,
    modelPath,
    projectorPath: '',
    contextSize: 8192,
    maxOutputTokens: 4096,
    gpuLayers: 0,
  });
  await api('start', {});
  const end = Date.now() + 10000;
  while ((await (await api('status')).json()).state !== 'ready') {
    if (Date.now() > end) assert.fail('Engine did not start');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  result = await (await api('context', input)).json();
  assert.equal(result.used, 321);
  assert.equal(result.reserved, 4096);
  assert.equal(result.precision, 'exact');
  assert.equal((await (await api('status')).json()).busy, false);
  const completed = {
    messages: [
      { role: 'user', content: 'Sent' },
      { role: 'assistant', content: 'Answer' },
    ],
  };
  const counted = await api('context', completed);
  assert.equal(counted.status, 200);
  assert.equal((await counted.json()).used, 321);
  assert.equal((await api('chat', completed)).status, 400);
  assert.equal((await api('context', { messages: [] })).status, 400);
  assert.equal((await api('chat', input)).status, 400);
});
