import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setupGenerationRuntime } from '../public/generation-runtime.mjs';

class Element {
  constructor(tag = 'div', className = '', text) {
    this.tagName = tag;
    this.className = className;
    this.textContent = text || '';
    this.children = [];
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.attributes = {};
    this.options = [];
  }
  querySelectorAll(selector) {
    const tags = selector.split(',').map(tag => tag.trim());
    return this.children.flatMap(child => [
      ...(tags.includes(child.tagName) ? [child] : []),
      ...(child.querySelectorAll?.(selector) || []),
    ]);
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = [...children];
    this.options = children.filter(c => c instanceof Option);
    this.value = this.options[0]?.value || '';
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  add(option) {
    this.options.push(option);
  }
  focus() {
    if (!this.disabled) this.focused = true;
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  addEventListener(name, fn) {
    (this.events ??= {})[name] = fn;
  }
  removeEventListener(name) {
    delete (this.events ??= {})[name];
  }
}
async function fixture(fn, { confirmDelay = 0 } = {}) {
  const previousDocument = globalThis.document,
    previousOption = globalThis.Option;
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(m => [m[1], new Element()]));
  const all = [];
  const details = new Element('details');
  globalThis.Option = class {
    constructor(text, value) {
      this.text = text;
      this.value = value;
    }
  };
  globalThis.document = {
    getElementById: id => {
      assert.ok(nodes.has(id), `Missing real HTML id ${id}`);
      return nodes.get(id);
    },
    querySelector: () => details,
    querySelectorAll: () =>
      all.filter(n => n.className.includes('workflow-description') || n.className.includes('workflow-remove')),
  };
  let stored = { enabled: true, baseUrl: 'http://127.0.0.1:7821', autoAllow: false, maxIterations: 3 };
  let workflows = [];
  const calls = [];
  let failTest = false;
  let importPause = Promise.resolve();
  let intercept = () => undefined;
  const busyChanges = [];
  const api = async (route, body, options) => {
    calls.push({ route, body });
    const intercepted = intercept(route, body, options);
    if (intercepted !== undefined) return intercepted;
    throw Error(`Unexpected route ${route}`);
  };
  const state = { conversationId: null };
  const ui = setupGenerationRuntime({
    api,
    state,
    node: (tag, c, t) => {
      const n = new Element(tag, c, t);
      all.push(n);
      return n;
    },
    notice: () => {},
    onChange: () => {},
    confirmDelay,
  });
  try {
    await fn({
      ui,
      nodes,
      all,
      calls,
      state,
      details,
      busyChanges,
      setIntercept: fn => {
        intercept = fn;
      },
      setImportPause: value => {
        importPause = value;
      },
      setFailTest: value => {
        failTest = value;
      },
      setWorkflows: value => {
        workflows = value;
      },
      setStored: value => {
        stored = value;
      },
    });
  } finally {
    globalThis.document = previousDocument;
    globalThis.Option = previousOption;
  }
}

test('latest gallery refresh wins without duplicate images', async () =>
  fixture(async ({ ui, state, nodes, setIntercept }) => {
    state.conversationId = 'conversation';
    const replies = [];
    setIntercept(route =>
      route === 'gallery/conversation' ? new Promise(resolve => replies.push(resolve)) : undefined,
    );
    const record = {
      id: 'run',
      conversationId: 'conversation',
      workflowName: 'Portrait',
      prompt: 'A portrait',
      createdAt: '2026-11-08T00:00:00Z',
      parameters: {},
      outputs: [{ source: { filename: 'image.png' } }],
    };
    const first = ui.renderGallery('conversation'),
      second = ui.renderGallery('conversation');
    replies[1](Response.json({ runs: [record] }));
    await second;
    replies[0](Response.json({ runs: [record] }));
    await first;
    assert.equal(nodes.get('gallery-list').children.length, 1);
  }));

test('cancel during launch acknowledgement is sent immediately and is scoped to that request', async () =>
  fixture(async ({ ui, state, calls, setIntercept }) => {
    state.conversationId = 'conversation';
    let release;
    setIntercept(route =>
      route === 'tools/execute'
        ? new Promise(resolve => {
            release = () => resolve(Response.json({ id: 'mine', state: 'checking' }));
          })
        : route === 'tools/cancel'
          ? Response.json({})
          : undefined,
    );
    const controller = new AbortController(),
      pending = assert.rejects(
        ui.requestTool({ autoAllow: true, requestId: 'request-mine' }, controller.signal, () => {}),
        { name: 'AbortError' },
      );
    await new Promise(setImmediate);
    controller.abort();
    try {
      assert.ok(calls.some(c => c.route === 'tools/cancel' && c.body.requestId === 'request-mine'));
    } finally {
      release();
      await pending;
    }
  }));

test('a replaced job is never followed or cancelled as if it belonged to this message', async () =>
  fixture(async ({ ui, state, calls, setIntercept }) => {
    state.conversationId = 'conversation';
    setIntercept(route =>
      route === 'tools/execute'
        ? Response.json({ id: 'mine', state: 'generating' })
        : route === 'tools/job'
          ? Response.json({ id: 'other', state: 'error', error: 'Other job' })
          : route === 'tools/cancel'
            ? Response.json({})
            : undefined,
    );
    await assert.rejects(
      ui.requestTool({ autoAllow: true, requestId: 'request-mine' }, new AbortController().signal, () => {}),
      /remplacée|correspond/,
    );
    assert.ok(calls.filter(c => c.route === 'tools/cancel').every(c => c.body.requestId === 'request-mine'));
  }));

async function rasterStub(check) {
  const priorBitmap = globalThis.createImageBitmap,
    priorCreate = document.createElement;
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
  document.createElement = () => ({
    width: 0,
    height: 0,
    getContext: () => ({ fillRect() {}, drawImage() {} }),
    toDataURL: mime => (mime === 'image/png' ? 'data:image/png;base64,iVBORw0KGgo=' : 'data:image/jpeg;base64,/9j/'),
  });
  try {
    await check();
  } finally {
    globalThis.createImageBitmap = priorBitmap;
    document.createElement = priorCreate;
  }
}
const generatedRecord = {
  id: 'mine',
  conversationId: 'conversation',
  workflowName: 'Portrait',
  prompt: 'A portrait',
  createdAt: '2026-11-08T00:00:00Z',
  parameters: {},
  outputs: [{ source: { filename: 'image.png' } }],
};

test('an image survives a failed model restart and still receives its compressed gallery copy', async () =>
  fixture(async ({ ui, state, calls, setIntercept }) => {
    state.conversationId = 'conversation';
    setIntercept(route =>
      route === 'tools/execute'
        ? Response.json({ id: 'mine', state: 'error', error: 'Model restart failed', record: generatedRecord })
        : route === 'gallery/conversation'
          ? Response.json({ runs: [generatedRecord] })
          : route.endsWith('/mine/0')
            ? new Response(Buffer.from('89504e470d0a1a0a', 'hex'), { headers: { 'Content-Type': 'image/png' } })
            : route === 'gallery/analysis'
              ? Response.json({})
              : undefined,
    );
    await rasterStub(async () => {
      const result = await ui.requestTool(
        { autoAllow: true, requestId: 'request-mine' },
        new AbortController().signal,
        () => {},
      );
      assert.equal(result.record?.id, 'mine');
      assert.equal(result.failed, true);
      assert.equal(result.images.length, 1);
      assert.match(result.error, /restart failed/);
      assert.ok(calls.some(c => c.route === 'gallery/analysis'));
    });
  }));

test('a missing original for compression cannot turn a produced image into a lost tool result', async () =>
  fixture(async ({ ui, state, setIntercept }) => {
    state.conversationId = 'conversation';
    setIntercept(route =>
      route === 'tools/execute'
        ? Response.json({ id: 'mine', state: 'done', record: generatedRecord })
        : route === 'gallery/conversation'
          ? Response.json({ runs: [generatedRecord] })
          : route.endsWith('/mine/0')
            ? Promise.reject(Error('Original unavailable'))
            : undefined,
    );
    const result = await ui.requestTool(
      { autoAllow: true, requestId: 'request-mine' },
      new AbortController().signal,
      () => {},
    );
    assert.equal(result.record?.id, 'mine');
    assert.equal(result.failed, true);
    assert.deepEqual(result.images, []);
    assert.match(result.content, /generated|générée/);
    assert.match(result.error, /Original unavailable/);
  }));

test('the original reaches the chat during model reload, while only a compressed copy goes to analysis', async () =>
  fixture(async ({ ui, state, calls, setIntercept }) => {
    state.conversationId = 'conversation';
    let shown = false;
    const bytes = Buffer.from('89504e470d0a1a0a0102030405060708', 'hex');
    setIntercept(route =>
      route === 'tools/execute'
        ? Response.json({ id: 'mine', state: 'restarting', progress: 'Reloading', record: generatedRecord })
        : route === 'tools/job'
          ? Response.json({ id: 'mine', state: 'done', record: generatedRecord })
          : route === 'gallery/conversation'
            ? Response.json({ runs: [generatedRecord] })
            : route.endsWith('/mine/0')
              ? new Response(bytes, { headers: { 'Content-Type': 'image/png' } })
              : route === 'gallery/analysis'
                ? Response.json({})
                : undefined,
    );
    await rasterStub(async () => {
      const result = await ui.requestTool(
        { autoAllow: true, requestId: 'request-mine' },
        new AbortController().signal,
        () => {},
        ({ blob }) => {
          shown = true;
          assert.equal(blob.size, bytes.length);
          assert.equal(
            calls.some(call => call.route === 'tools/job'),
            false,
          );
        },
      );
      assert.equal(shown, true);
      assert.equal(result.images[0], 'data:image/jpeg;base64,/9j/');
      const analysis = calls.find(call => call.route === 'gallery/analysis');
      assert.deepEqual(analysis.body.images, result.images);
      assert.notEqual(analysis.body.images[0].split(',')[1], bytes.toString('base64'));
    });
    assert.equal(calls.filter(call => call.route.endsWith('/mine/0')).length, 1);
  }));

test('batch output originals are transferred and compressed sequentially before the next download', async () =>
  fixture(async ({ ui, state, setIntercept, calls }) => {
    state.conversationId = 'conversation';
    const record = { ...generatedRecord, outputs: [0, 1, 2].map(i => ({ source: { filename: i + '.png' } })) },
      gates = [],
      shown = [];
    setIntercept(route =>
      route === 'tools/execute'
        ? Response.json({ id: 'mine', state: 'done', record })
        : route === 'gallery/conversation'
          ? Response.json({ runs: [record] })
          : /mine\/\d+$/.test(route)
            ? new Promise(resolve =>
                gates.push(() =>
                  resolve(
                    new Response(Buffer.from('89504e470d0a1a0a', 'hex'), { headers: { 'content-type': 'image/png' } }),
                  ),
                ),
              )
            : route === 'gallery/analysis'
              ? Response.json({})
              : undefined,
    );
    await rasterStub(async () => {
      const pending = ui.requestTool(
        { autoAllow: true, requestId: 'mine' },
        new AbortController().signal,
        () => {},
        event => shown.push(event.index),
      );
      for (let i = 0; i < 3; i++) {
        await new Promise(setImmediate);
        assert.equal(gates.length, i + 1);
        gates[i]();
      }
      const result = await pending;
      assert.deepEqual(shown, [0, 1, 2]);
      assert.equal(result.images.length, 3);
      assert.equal(calls.filter(call => /mine\/\d+$/.test(call.route)).length, 3);
    });
  }));

test('an unreadable original does not prevent later batch outputs from being shown', async () =>
  fixture(async ({ ui, state, calls, setIntercept }) => {
    state.conversationId = 'conversation';
    const record = { ...generatedRecord, outputs: [0, 1].map(i => ({ source: { filename: i + '.png' } })) },
      shown = [];
    setIntercept(route =>
      route === 'tools/execute'
        ? Response.json({ id: 'mine', state: 'done', record })
        : route === 'gallery/conversation'
          ? Response.json({ runs: [record] })
          : route === 'gallery/analysis'
            ? Response.json({})
            : route.endsWith('/mine/0')
              ? Promise.reject(Error('Missing first image'))
              : route.endsWith('/mine/1')
                ? new Response(Buffer.from('89504e470d0a1a0a', 'hex'), { headers: { 'content-type': 'image/png' } })
                : undefined,
    );
    await rasterStub(async () => {
      const result = await ui.requestTool(
        { autoAllow: true, requestId: 'mine' },
        new AbortController().signal,
        () => {},
        event => shown.push(event.index),
      );
      assert.deepEqual(shown, [1]);
      assert.equal(result.failed, true);
      assert.equal(result.images.length, 1);
      assert.deepEqual(calls.find(call => call.route === 'gallery/analysis').body.images, [null, result.images[0]]);
      assert.equal(JSON.parse(result.content).analysis_outputs, undefined);
      assert.match(JSON.parse(result.content).note, /local_read_output/);
      assert.match(result.error, /Missing first image/);
    });
  }));
test('an already cancelled automatic call releases its pending approval without executing', async () =>
  fixture(async ({ ui, calls, setIntercept }) => {
    setIntercept(route => (route === 'tools/cancel' ? Response.json(null) : undefined));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      ui.requestTool({ autoAllow: true, requestId: 'cancelled' }, controller.signal, () => {}),
      { name: 'AbortError' },
    );
    assert.equal(calls.filter(call => call.route === 'tools/execute').length, 0);
    assert.equal(calls.find(call => call.route === 'tools/cancel').body.requestId, 'cancelled');
  }));

const labelled = (all, label) =>
  all.find(n => n.tagName === 'label' && n.children[0]?.textContent === label)?.children[1];
const videoProposal = () => ({
  requestId: 'proposal',
  mediaType: 'video',
  autoAllow: true,
  workflowName: 'MiniMax',
  args: { prompt: 'dives' },
  approvalToken: 'first-token',
  plan: {
    stage: 'draft',
    intention: 'Continuer.',
    prompt: 'dives',
    parameters: { frames: 124, fps: 24, width: 768, height: 448, seed: 7, audio: true },
    references: [
      { input: 'source', label: 'Résultat précédent', role: 'source_video', roleLabel: 'Vidéo à prolonger' },
    ],
    editable: {
      prompt: true,
      stages: ['draft', 'final'],
      references: [[]],
      parameters: [
        { key: 'width', value: 768, type: 'integer', locked: 'Une continuation garde la taille de sa vidéo source.' },
        { key: 'height', value: 448, type: 'integer', locked: 'Une continuation garde la taille de sa vidéo source.' },
        { key: 'frames', value: 124, type: 'integer', choices: [124, 141, 345] },
        { key: 'seed', value: 7, type: 'integer', min: 0, max: 9007199254740991 },
        { key: 'audio', value: true, type: 'boolean' },
      ],
    },
  },
});
test('a video proposal is edited in place: no « Modifier », no unload notice, cancelling sends nothing', async () =>
  fixture(async ({ ui, nodes, all, calls, setIntercept }) => {
    setIntercept(route => (route === 'tools/cancel' ? Response.json({}) : undefined));
    const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /tool-revise|seront déchargés/);
    const pending = ui.requestTool(videoProposal(), new AbortController().signal, () => {});
    await new Promise(setImmediate);
    assert.equal(nodes.get('tool-dialog').open, true);
    assert.match(nodes.get('tool-title').textContent, /Brouillon/);
    assert.equal(nodes.get('tool-always').hidden, true);
    assert.equal(nodes.get('tool-once').textContent, 'Confirmer et générer');
    assert.equal(labelled(all, 'Prompt').value, 'dives');
    labelled(all, 'Prompt').value = 'changed but cancelled';
    nodes.get('tool-deny').onclick();
    const result = await pending;
    assert.equal(result.denied, true);
    assert.equal(nodes.get('tool-dialog').open, false);
    assert.ok(!calls.some(call => ['tools/execute', 'tools/revise'].includes(call.route)));
  }));
test('confirming applies the edits first and runs the revised proposal', async () =>
  fixture(async ({ ui, nodes, all, calls, setIntercept }) => {
    setIntercept((route, body) => {
      if (route === 'tools/revise')
        return Response.json({ ...videoProposal(), requestId: 'revised', approvalToken: 'revised-token' });
      if (route === 'tools/execute') return Response.json({ id: 'job', state: 'error', error: 'test boundary' });
    });
    const pending = ui.requestTool(videoProposal(), new AbortController().signal, () => {});
    await new Promise(setImmediate);
    const seed = all.find(n => n.attributes['aria-label'] === 'Seed');
    seed.value = 'abc';
    nodes.get('tool-once').onclick();
    await new Promise(setImmediate);
    assert.ok(!calls.some(call => ['tools/revise', 'tools/execute'].includes(call.route)), 'caught before sending');
    assert.ok(all.some(n => n.className === 'video-edit-error' && /Seed/.test(n.textContent)));
    seed.value = '99';
    labelled(all, 'Prompt').value = 'the boat dives into the clouds';
    const duration = labelled(all, 'Durée');
    duration.value = '345';
    nodes.get('tool-once').onclick();
    await pending;
    assert.deepEqual(calls.find(call => call.route === 'tools/revise').body, {
      requestId: 'proposal',
      approvalToken: 'first-token',
      edits: { prompt: 'the boat dives into the clouds', frames: 345, seed: 99 },
    });
    assert.deepEqual(calls.find(call => call.route === 'tools/execute').body, {
      requestId: 'revised',
      permission: 'once',
      approvalToken: 'revised-token',
    });
  }));
test('changing the version asks for the new profile at once and shows it', async () =>
  fixture(async ({ ui, nodes, all, calls, setIntercept }) => {
    setIntercept((route, body) => {
      if (route === 'tools/revise') {
        const revised = videoProposal();
        revised.requestId = 'final';
        revised.approvalToken = 'final-token';
        revised.plan.stage = 'final';
        revised.plan.parameters.frames = 141;
        revised.plan.editable.parameters[2].value = 141;
        return Response.json(revised);
      }
      if (route === 'tools/cancel') return Response.json({});
    });
    const pending = ui.requestTool(videoProposal(), new AbortController().signal, () => {});
    await new Promise(setImmediate);
    labelled(all, 'Prompt').value = 'kept across the version change';
    const stage = labelled(all, 'Version');
    stage.value = 'final';
    stage.onchange();
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    assert.deepEqual(calls.find(call => call.route === 'tools/revise').body.edits, {
      prompt: 'kept across the version change',
      stage: 'final',
    });
    assert.match(nodes.get('tool-title').textContent, /Vidéo finale/);
    assert.equal(nodes.get('tool-dialog').open, true, 'still waiting for the user');
    nodes.get('tool-deny').onclick();
    await pending;
  }));
test('an untouched video proposal starts by itself; touching the window stops the countdown', async () => {
  await fixture(
    async ({ ui, nodes, calls, setIntercept }) => {
      setIntercept(route =>
        route === 'tools/execute' ? Response.json({ id: 'job', state: 'error', error: 'test boundary' }) : undefined,
      );
      await ui.requestTool(videoProposal(), new AbortController().signal, () => {});
      assert.equal(calls.find(call => call.route === 'tools/execute').body.requestId, 'proposal');
      assert.equal(nodes.get('tool-dialog').open, false);
    },
    { confirmDelay: 20 },
  );
  await fixture(
    async ({ ui, nodes, calls, setIntercept }) => {
      setIntercept(route => (route === 'tools/cancel' ? Response.json({}) : undefined));
      const pending = ui.requestTool(videoProposal(), new AbortController().signal, () => {});
      await new Promise(setImmediate);
      nodes.get('tool-dialog').events.pointerdown();
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.ok(!calls.some(call => call.route === 'tools/execute'), 'stopped by a click in the window');
      assert.equal(nodes.get('tool-dialog').open, true);
      nodes.get('tool-deny').onclick();
      await pending;
    },
    { confirmDelay: 20 },
  );
});
test('video confirm sends the exact proposal token once and final label is explicit', async () =>
  fixture(async ({ ui, nodes, calls, setIntercept }) => {
    setIntercept(route =>
      route === 'tools/execute' ? Response.json({ id: 'job', state: 'error', error: 'test boundary' }) : undefined,
    );
    const pending = ui.requestTool(
      {
        requestId: 'final-proposal',
        mediaType: 'video',
        autoAllow: true,
        approvalToken: 'final-token',
        workflowName: 'Motion',
        args: {},
        plan: { stage: 'final', intention: 'Finaliser.', parameters: {}, references: [] },
      },
      new AbortController().signal,
      () => {},
    );
    await new Promise(setImmediate);
    assert.match(nodes.get('tool-title').textContent, /Vidéo finale/);
    nodes.get('tool-once').onclick();
    await pending;
    assert.deepEqual(calls.find(call => call.route === 'tools/execute').body, {
      requestId: 'final-proposal',
      permission: 'once',
      approvalToken: 'final-token',
    });
  }));

test('video tool result retains the effective recipe even when analysis frames cannot be decoded', async () =>
  fixture(async ({ ui, state, nodes, setIntercept }) => {
    state.conversationId = 'conversation';
    const record = {
      ...generatedRecord,
      mediaType: 'video',
      parameters: {
        stage: 'draft',
        seed: 123,
        width: 768,
        height: 512,
        frames: 81,
        fps: 16,
        workflow_digest: 'version',
        workflow_inputs: { private: 'unneeded context' },
      },
    };
    setIntercept(route =>
      route === 'tools/execute'
        ? Response.json({ id: 'job', state: 'done', record })
        : route === 'gallery/conversation'
          ? Response.json({ runs: [record] })
          : undefined,
    );
    const pending = ui.requestTool(
      {
        requestId: 'video',
        mediaType: 'video',
        approvalToken: 'token',
        args: {},
        plan: { stage: 'draft', parameters: {}, references: [] },
      },
      new AbortController().signal,
      () => {},
    );
    await new Promise(setImmediate);
    nodes.get('tool-once').onclick();
    const result = await pending,
      data = JSON.parse(result.content);
    assert.equal(result.record.id, 'mine');
    assert.equal(result.failed, true);
    assert.equal(data.parameters.seed, 123);
    assert.equal(data.parameters.fps, 16);
    assert.equal(data.parameters.frames, 81);
    assert.equal(data.workflow_digest, 'version');
    assert.equal(data.parameters.workflow_inputs, undefined);
  }));

test('photo tool results expose the actual seed and dimensions for a later correction', async () =>
  fixture(async ({ ui, state, setIntercept }) => {
    state.conversationId = 'conversation';
    const record = {
      ...generatedRecord,
      parameters: { seed: 42, width: 1024, height: 768, workflow_digest: 'photo-version' },
    };
    setIntercept(route =>
      route === 'tools/execute'
        ? Response.json({ id: 'mine', state: 'done', record })
        : route === 'gallery/conversation'
          ? Response.json({ runs: [record] })
          : route.endsWith('/mine/0')
            ? Promise.reject(Error('No preview'))
            : undefined,
    );
    const result = await ui.requestTool(
        { autoAllow: true, requestId: 'photo' },
        new AbortController().signal,
        () => {},
      ),
      data = JSON.parse(result.content);
    assert.equal(data.parameters.seed, 42);
    assert.equal(data.parameters.width, 1024);
    assert.equal(data.workflow_digest, 'photo-version');
  }));

test('replacing an Output gallery pauses its videos before removing their players', async () =>
  fixture(async ({ ui, nodes }) => {
    const video = new Element('video');
    let paused = 0;
    video.pause = () => paused++;
    nodes.get('gallery-list').append(video);
    ui.reset();
    assert.equal(paused, 1);
    assert.equal(nodes.get('gallery-list').children.includes(video), false);
  }));
test('an image proposal is the same form, never starts by itself, and keeps « Toujours autoriser »', async () =>
  fixture(
    async ({ ui, nodes, all, calls, setIntercept }) => {
      setIntercept((route, body) => {
        if (route === 'tools/revise')
          return Response.json({
            requestId: 'image-revised',
            approvalToken: 'image-token-2',
            workflowName: 'Krea 2',
            plan: { parameters: {} },
          });
        if (route === 'tools/execute') return Response.json({ id: 'job', state: 'error', error: 'test boundary' });
      });
      const pending = ui.requestTool(
        {
          requestId: 'image',
          approvalToken: 'image-token',
          autoAllow: false,
          workflowName: 'Krea 2',
          args: { prompt: 'a lighthouse' },
          plan: {
            prompt: 'a lighthouse',
            parameters: { width: 1024, height: 1024, seed: 3 },
            references: [],
            editable: {
              prompt: true,
              stages: [],
              parameters: [
                { key: 'width', value: 1024, type: 'integer', min: 64, max: 4096, multipleOf: 8 },
                { key: 'height', value: 1024, type: 'integer', min: 64, max: 4096, multipleOf: 8 },
              ],
            },
          },
        },
        new AbortController().signal,
        () => {},
      );
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.ok(!calls.some(call => call.route === 'tools/execute'), 'an image never starts by itself');
      assert.equal(nodes.get('tool-always').hidden, false);
      assert.equal(nodes.get('tool-once').textContent, 'Cette fois');
      const format = labelled(all, 'Format');
      assert.equal(format.value, '1:1');
      format.value = '3:4';
      format.onchange();
      nodes.get('tool-once').onclick();
      await pending;
      assert.deepEqual(calls.find(call => call.route === 'tools/revise').body.edits, { width: 960, height: 1280 });
      assert.deepEqual(calls.find(call => call.route === 'tools/execute').body, {
        requestId: 'image-revised',
        permission: 'once',
      });
    },
    { confirmDelay: 20 },
  ));

test('an action the user started with a button runs without a second confirmation', async () =>
  fixture(async ({ ui, nodes, calls, setIntercept }) => {
    setIntercept(route => (route === 'tools/execute' ? Promise.reject(Error('stop here')) : undefined));
    const request = {
      requestId: 'upscale',
      mediaType: 'video',
      workflowName: 'Upscale vidéo',
      approvalToken: 'one-use',
      args: {},
      plan: { parameters: {}, references: [] },
    };
    await assert.rejects(
      ui.requestTool(
        request,
        new AbortController().signal,
        () => {},
        () => {},
        { confirmed: true },
      ),
      /stop here/,
    );
    assert.notEqual(nodes.get('tool-dialog')?.open, true, 'no dialog was shown');
    assert.deepEqual(calls.find(call => call.route === 'tools/execute').body, {
      requestId: 'upscale',
      permission: 'once',
      approvalToken: 'one-use',
    });
  }));

test('in the Studio the « Créations » tab lists the Studio creations, with their details only', async () =>
  fixture(async ({ ui, state, nodes, calls, setIntercept }) => {
    const run = (id, conversationId) => ({
      id,
      conversationId,
      workflowName: 'Portrait',
      prompt: 'A portrait',
      createdAt: '2026-11-12T00:00:00Z',
      parameters: {},
      outputs: [{ source: { filename: id + '.png' } }],
    });
    setIntercept(route =>
      route === 'gallery/studio'
        ? Response.json({ runs: [run('a', 'studio'), run('b', 'studio')] })
        : route === 'gallery/conversation'
          ? Response.json({ runs: [run('c', 'conversation')] })
          : undefined,
    );
    const list = nodes.get('gallery-list'),
      texts = () => list.children.map(child => child.textContent);
    // A conversation is open, then the Studio is the view on screen: its id is not known yet.
    state.conversationId = 'conversation';
    state.view = 'studio';
    await ui.renderGallery(null);
    assert.deepEqual(texts(), ['Aucune création dans le Studio pour l’instant.']);
    // The conversation left behind is not what the tab shows there.
    await ui.renderGallery('conversation');
    assert.equal(
      calls.some(call => call.route === 'gallery/conversation'),
      false,
    );
    state.studioId = 'studio';
    await ui.renderGallery('studio');
    assert.equal(list.children.length, 2);
    // No action that would write to the conversation: « Détails » alone.
    for (const card of list.children) assert.equal(card.children.at(-1).textContent, 'Détails');
    // Back in the conversation, its own creations.
    state.view = 'chat';
    await ui.renderGallery('studio');
    assert.equal(list.children.length, 2, 'a late answer of the Studio changes nothing');
    await ui.renderGallery('conversation');
    assert.equal(list.children.length, 1);
    await ui.renderGallery(null);
    assert.deepEqual(texts(), ['Aucune génération dans cette conversation.']);
  }));
