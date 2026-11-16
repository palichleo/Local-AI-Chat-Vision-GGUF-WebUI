import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setupAssets } from '../public/assets-ui.mjs';
class Element {
  constructor(tag = 'div', className = '', text = '') {
    Object.assign(this, {
      tagName: tag.toUpperCase(),
      className,
      textContent: text,
      children: [],
      attributes: {},
      dataset: {},
      value: '',
      open: false,
      disabled: false,
      hidden: false,
      listeners: {},
      style: {},
    });
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(child.tagName === selector.toUpperCase() ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = [...children];
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  addEventListener(name, fn) {
    (this.listeners[name] ??= []).push(fn);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 500, bottom: 500 };
  }
  focus() {}
  pause() {}
  load() {}
  click() {}
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    for (const fn of this.listeners.close || []) fn();
  }
  contains() {
    return false;
  }
}
async function fixture(t) {
  const previous = globalThis.document,
    html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const $ = id => {
    assert.ok(nodes.has(id), 'Missing HTML id ' + id);
    return nodes.get(id);
  };
  globalThis.document = { getElementById: $ };
  t.after(() => {
    globalThis.document = previous;
  });
  let stored = [
    {
      id: 'one',
      name: 'Reference',
      mime: 'image/png',
      description: 'Light',
      ready: true,
      enabled: true,
      frames: [],
      originalUrl: '/original',
      previewUrl: '/preview',
    },
  ];
  const calls = [],
    notices = [];
  const api = async (route, body, options) => {
    calls.push({ route, body, options });
    if (route === 'resources') return Response.json({ resources: structuredClone(stored) });
    if (route === 'resources/update') {
      const record = stored.find(item => item.id === body.id);
      Object.assign(record, body.patch);
      return Response.json(record);
    }
    if (route === 'resources/delete') {
      stored = stored.filter(item => item.id !== body.id);
      return Response.json({ deleted: true });
    }
    if (route === 'resources/upload') {
      const record = { id: 'two', name: decodeURIComponent(options.headers['X-Resource-Name']), mime: 'image/png' };
      stored.push(record);
      return Response.json(record);
    }
    throw Error('Unexpected ' + route);
  };
  const state = { resourceWorking: false };
  const ui = setupAssets({
    api,
    state,
    node: (...args) => new Element(...args),
    icon: () => new Element('svg'),
    notice: text => notices.push(text),
    prepare: async file => ({ mime: file.type, width: 1, height: 1, frames: [] }),
  });
  await ui.refresh();
  return { ui, $, calls, state, notices };
}
test('no panel: a file is kept as a reference of the project it comes from', async t => {
  const { ui, calls, state } = await fixture(t);
  assert.equal(ui.resource('one').name, 'Reference');
  const file = new File(['x'], 'pluie.png', { type: 'image/png' });
  const [kept] = await ui.importFiles([file], { project: 'p' });
  assert.equal(kept.id, 'two');
  const upload = calls.find(call => call.route === 'resources/upload');
  assert.equal(upload.options.headers['X-Resource-Project'], 'p');
  assert.deepEqual(calls.at(-1).body, { id: 'two', patch: { prepared: { mime: 'image/png', width: 1, height: 1, frames: [] } } });
  assert.equal(ui.resource('two').id, 'two');
  assert.equal(state.resourceWorking, false);
  // Busy (a reply, a generation): nothing is kept meanwhile.
  ui.setBusy(true);
  assert.deepEqual(await ui.importFiles([file]), []);
  ui.setBusy(false);
  assert.equal(await ui.flush(), true);
  assert.equal(ui.hasDraft(), false);
});
test('output details expose full prompts, workflow, seed and available parameters', async t => {
  const { ui, $ } = await fixture(t);
  const record = {
    id: 'run',
    conversationId: 'conversation',
    workflowName: 'Portrait workflow',
    prompt: 'A full prompt with details',
    createdAt: '2026-01-02T12:00:00Z',
    parameters: { seed: 42, width: 1024, height: 768 },
    outputs: [{ source: { filename: 'result.png' }, analysisDataUrl: 'data:image/png;base64,AA==', take: 12 }],
  };
  const list = [{ id: 'newer' }, record, { id: 'older' }];
  await ui.viewOutput(record, 0, undefined, { list: () => list, at: () => 1 });
  assert.equal($('original-dialog').open, true);
  // Its head (capture 33): « PRISE 12 · IMAGE » and « 2 / 3 »; ‹ › to the takes beside it.
  assert.equal($('media-title').textContent, 'PRISE 12 · IMAGE');
  assert.equal($('media-position').textContent, '2 / 3');
  assert.deepEqual([$('media-prev').hidden, $('media-next').hidden], [false, false]);
  // The prompt whole, with Copier; then Modèle, Format, Résolution, Seed and Date.
  assert.equal($('media-prompt').textContent, record.prompt);
  const texts = $('media-metadata').children.map(item => item.textContent);
  assert.deepEqual(texts.filter((_, at) => at % 2 === 0), ['Modèle', 'Format', 'Résolution', 'Seed', 'Date']);
  assert.ok(texts.includes(record.workflowName));
  assert.ok(texts.includes('42'));
  assert.ok(texts.includes('1024 × 768'));
  // The rest under « Plus de détails »: its file, its id, its parameters.
  const more = $('media-more-list').children.map(item => item.textContent);
  assert.ok(more.includes('result.png'));
  assert.ok(more.includes('run'));
  assert.ok(more.some(text => text.includes('1024')));
  assert.match($('media-error').textContent, /Aperçu compressé/);
  $('original-close').onclick();
  assert.equal($('original-dialog').open, false);
});

test('chat details reuse the displayed original blob and persisted original dimensions', async t => {
  const { ui, $, calls } = await fixture(t),
    original = new Blob(['Original'], { type: 'image/png' }),
    record = {
      id: 'run',
      conversationId: 'conversation',
      workflowName: 'Workflow',
      prompt: 'Prompt',
      createdAt: '2026-01-02T12:00:00Z',
      parameters: {},
      outputs: [{ source: { filename: 'original.png' }, width: 1448, height: 1448 }],
    };
  const count = calls.length;
  await ui.viewOutput(record, 0, original);
  assert.equal(calls.length, count);
  assert.equal($('media-download').disabled, false);
  assert.ok($('media-metadata').children.some(item => item.textContent === '1448 × 1448'));
  assert.equal(await (await fetch($('original-image').src)).text(), 'Original');
  $('original-close').onclick();
});

