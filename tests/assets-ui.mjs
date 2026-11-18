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
    this.classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
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
  const list = [{ ...record, id: 'newer' }, record, { ...record, id: 'older' }];
  await ui.viewOutput(record, 0, undefined, { list: () => list, at: () => 1 });
  assert.equal($('original-dialog').open, true);
  // Its head (capture 33): « PRISE 12 · IMAGE » and « 2 / 3 »; ‹ › to the takes beside it.
  assert.equal($('media-title').textContent, 'PRISE 12 · IMAGE');
  assert.equal($('media-position').textContent, '2 / 3');
  assert.deepEqual([$('media-prev').hidden, $('media-next').hidden], [false, false]);
  // The next one, then back: where it stands follows the take shown, not the one first opened.
  $('media-next').onclick();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal($('media-position').textContent, '3 / 3');
  assert.equal($('media-next').hidden, true);
  $('media-prev').onclick();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal($('media-position').textContent, '2 / 3');
  // The prompt whole, with Copier; then Modèle, Format, Résolution, Seed, Date and how long it took.
  assert.equal($('media-prompt').textContent, record.prompt);
  const texts = $('media-metadata').children.map(item => item.textContent);
  assert.deepEqual(texts.filter((_, at) => at % 2 === 0), ['Modèle', 'Format', 'Résolution', 'Seed', 'Date', 'Temps de génération']);
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

test('the arrow that had the focus gone (the first take, the last): the take itself takes it, the keys still move', async t => {
  const { ui, $ } = await fixture(t),
    record = {
      id: 'run',
      conversationId: 'conversation',
      workflowName: 'Workflow',
      prompt: 'Prompt',
      parameters: {},
      outputs: [{ source: { filename: 'result.png' }, analysisDataUrl: 'data:image/png;base64,AA==', take: 2 }],
    },
    list = [{ ...record, id: 'newer' }, record, { ...record, id: 'older' }],
    dialog = $('original-dialog'),
    tick = () => new Promise(resolve => setTimeout(resolve, 0)),
    press = key => dialog.listeners.keydown.forEach(fn => fn({ key, target: document.activeElement }));
  // As in a page: what is hidden no longer has the focus, the page has it (seen in Brave: read after
  // the arrow was hidden, `activeElement` was already the body).
  let focused = dialog;
  const body = new Element('body');
  Object.defineProperty(document, 'activeElement', { get: () => (focused.hidden ? body : focused), set: element => (focused = element) });
  dialog.focus = () => (focused = dialog);
  await ui.viewOutput(record, 0, undefined, { list: () => list, at: () => 1 });
  // ‹ clicked (it has the focus) up to the first take: hidden there. Its focus fell on the page,
  // and the keys of the keyboard no longer reached the window of the take.
  document.activeElement = $('media-prev');
  $('media-prev').onclick();
  await tick();
  assert.equal($('media-position').textContent, '1 / 3');
  assert.equal($('media-prev').hidden, true);
  assert.equal(document.activeElement, dialog);
  press('ArrowRight');
  await tick();
  assert.equal($('media-position').textContent, '2 / 3');
  // An arrow that stays shown keeps the focus it has.
  document.activeElement = $('media-prev');
  $('media-next').onclick();
  await tick();
  assert.equal($('media-position').textContent, '3 / 3');
  assert.equal($('media-next').hidden, true);
  assert.equal(document.activeElement, $('media-prev'));
  // › with the focus, on the last take: the same.
  $('media-prev').onclick();
  await tick();
  document.activeElement = $('media-next');
  $('media-next').onclick();
  await tick();
  assert.equal($('media-next').hidden, true);
  assert.equal(document.activeElement, dialog);
  $('original-close').onclick();
});

test('› clicked up to the last take then once more at the same place: the take stays open; its margins still close it', async t => {
  const { ui, $ } = await fixture(t),
    record = {
      id: 'run',
      conversationId: 'conversation',
      workflowName: 'Workflow',
      prompt: 'Prompt',
      parameters: {},
      outputs: [{ source: { filename: 'result.png' }, analysisDataUrl: 'data:image/png;base64,AA==', take: 2 }],
    },
    list = [{ ...record, id: 'newer' }, record, { ...record, id: 'older' }],
    dialog = $('original-dialog'),
    layout = { classList: { contains: name => name === 'media-details-layout' } },
    tick = () => new Promise(resolve => setTimeout(resolve, 0)),
    // A press and its click at one point, on the window itself unless said otherwise.
    press = (x, y, target = dialog) => {
      for (const name of ['pointerdown', 'click']) dialog.listeners[name].forEach(fn => fn({ clientX: x, clientY: y, target }));
    };
  await ui.viewOutput(record, 0, undefined, { list: () => list, at: () => 1 });
  // The window is 500 px wide and high here: › stands 4 px from its right edge, at mid-height.
  $('media-next').onclick();
  await tick();
  assert.equal($('media-next').hidden, true);
  // › is no longer there: the click falls on the padding of the window, where it stood.
  press(476, 250);
  press(458, 268);
  assert.equal(dialog.open, true);
  // The same for ‹, back at the first take.
  $('media-prev').onclick();
  await tick();
  $('media-prev').onclick();
  await tick();
  assert.equal($('media-prev').hidden, true);
  press(24, 250);
  assert.equal(dialog.open, true);
  // The place of an arrow that is shown is not a margin either (a click between its edge and its picture).
  press(476, 250);
  assert.equal(dialog.open, true);
  // Above the arrow, the margin of the window closes the take, as the grid around the take does.
  press(476, 120);
  assert.equal(dialog.open, false);
  await ui.viewOutput(record, 0, undefined, { list: () => list, at: () => 1 });
  press(120, 250, layout);
  assert.equal(dialog.open, false);
  // Outside the window, at the height of the arrows: closed too.
  await ui.viewOutput(record, 0, undefined, { list: () => list, at: () => 1 });
  dialog.getBoundingClientRect = () => ({ left: 100, top: 0, right: 500, bottom: 500 });
  press(60, 250);
  assert.equal(dialog.open, false);
});

test('where ‹ and › stand is read from the arrows themselves while they are shown: a change of their style is followed', async t => {
  const { ui, $ } = await fixture(t),
    record = {
      id: 'run',
      conversationId: 'conversation',
      workflowName: 'Workflow',
      prompt: 'Prompt',
      parameters: {},
      outputs: [{ source: { filename: 'result.png' }, analysisDataUrl: 'data:image/png;base64,AA==', take: 2 }],
    },
    list = [{ ...record, id: 'newer' }, record, { ...record, id: 'older' }],
    dialog = $('original-dialog'),
    tick = () => new Promise(resolve => setTimeout(resolve, 0)),
    press = (x, y) => {
      for (const name of ['pointerdown', 'click']) dialog.listeners[name].forEach(fn => fn({ clientX: x, clientY: y, target: dialog }));
    };
  // As if moodix.css had changed: 56 px wide and high, 20 px from a side of the window (500 px
  // wide and high here), where it said 40 px and 4 px.
  let box = { left: 0, top: 0, right: 500, bottom: 500 };
  const arrow = from => () => {
    const left = from === 'left' ? box.left + 20 : box.right - 76,
      top = (box.top + box.bottom) / 2 - 28;
    return { left, right: left + 56, top, bottom: top + 56, width: 56, height: 56 };
  };
  dialog.getBoundingClientRect = () => box;
  $('media-prev').getBoundingClientRect = arrow('left');
  $('media-next').getBoundingClientRect = arrow('right');
  await ui.viewOutput(record, 0, undefined, { list: () => list, at: () => 1 });
  $('media-next').onclick();
  await tick();
  assert.equal($('media-next').hidden, true);
  // Where › stood, 4 px more around: not a margin (the 48 px and 24 px of before stopped at 452 and 274).
  press(430, 250);
  press(478, 280);
  assert.equal(dialog.open, true);
  // The window moved since: counted from its sides and the middle of its height, not from where
  // the arrow was on the screen.
  box = { left: 100, top: 100, right: 600, bottom: 600 };
  press(530, 350);
  assert.equal(dialog.open, true);
  press(430, 250);
  assert.equal(dialog.open, false);
  // Beside where it stood, the margin of the window closes the take as before.
  await ui.viewOutput(list[2], 0, undefined, { list: () => list, at: () => 2 });
  press(510, 350);
  assert.equal(dialog.open, false);
  // ‹ too, from its own side.
  await ui.viewOutput(list[0], 0, undefined, { list: () => list, at: () => 0 });
  assert.equal($('media-prev').hidden, true);
  press(178, 350);
  assert.equal(dialog.open, true);
  press(190, 350);
  assert.equal(dialog.open, false);
});

test('the file of a take opened is said with its sub-folder of the output folder; it is downloaded under its name alone', async t => {
  const { ui, $ } = await fixture(t),
    take = source => ({
      id: 'run',
      conversationId: 'conversation',
      workflowName: 'Workflow',
      prompt: 'Prompt',
      parameters: {},
      outputs: [{ source, width: 1024, height: 1024 }],
    }),
    file = () => {
      const more = $('media-more-list').children.map(item => item.textContent);
      return more[more.indexOf('Fichier') + 1];
    },
    saved = [],
    click = Element.prototype.click;
  // The link « Télécharger » makes and clicks: the name it gives the file.
  Element.prototype.click = function () {
    saved.push(this.download);
  };
  t.after(() => {
    Element.prototype.click = click;
  });
  // A take of today: in « image/ », « video/ » or « son/ » of the output folder.
  await ui.viewOutput(take({ filename: 'Moodix_00012_.png', subfolder: 'image' }), 0, new Blob(['x'], { type: 'image/png' }));
  assert.equal(file(), 'image/Moodix_00012_.png');
  $('media-download').onclick();
  assert.deepEqual(saved, ['Moodix_00012_.png']);
  // A folder written as the disk writes it: one forward slash all the same.
  await ui.viewOutput(take({ filename: 'clip.mp4', subfolder: 'video\\' }), 0, new Blob(['x'], { type: 'image/png' }));
  assert.equal(file(), 'video/clip.mp4');
  // A take of before the sub-folders: its name alone.
  for (const source of [{ filename: 'ancien.png', subfolder: '' }, { filename: 'ancien.png' }]) {
    await ui.viewOutput(take(source), 0, new Blob(['x'], { type: 'image/png' }));
    assert.equal(file(), 'ancien.png');
  }
  $('original-close').onclick();
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

test('a take made with LoRAs of the user names them among its settings, by their file and their strength', async t => {
  const { ui, $ } = await fixture(t);
  const record = {
    id: 'run',
    conversationId: 'conversation',
    workflowName: 'Krea 2',
    prompt: 'un phare',
    createdAt: '2026-01-02T12:00:00Z',
    parameters: {
      seed: 42,
      width: 1024,
      height: 1024,
      styles: [
        { name: 'styles\\70sSCiFiKrea2Raw.safetensors', strength: 0.8 },
        { name: 'krea2_detail_slider.safetensors', strength: 1 },
      ],
    },
    outputs: [{ source: { filename: 'result.png' }, analysisDataUrl: 'data:image/png;base64,AA==', take: 3 }],
  };
  await ui.viewOutput(record, 0, undefined, { list: () => [record], at: () => 0 });
  const texts = $('media-metadata').children.map(item => item.textContent);
  assert.deepEqual(texts.filter((_, at) => at % 2 === 0), ['Modèle', 'Format', 'Résolution', 'LoRA', 'Seed', 'Date', 'Temps de génération']);
  assert.equal(texts[texts.indexOf('LoRA') + 1], '70sSCiFiKrea2Raw · 0,8\nkrea2_detail_slider · 1');
});

test('the window of a take says how long it took to make, apart from « Durée », the length of its clip (0.6.93)', async t => {
  const { ui, $ } = await fixture(t);
  const take = parameters => ({
    id: 'run',
    conversationId: 'conversation',
    mediaType: 'video',
    workflowName: 'LTX 2.5',
    prompt: 'Un escalier au-dessus des nuages',
    createdAt: '2026-11-18T18:12:00Z',
    parameters: { seed: 7, width: 1088, height: 1920, frames: 593, fps: 24, ...parameters },
    outputs: [{ source: { filename: 'clip.mp4', subfolder: 'video' }, originalUrl: '/clip.mp4', take: 44 }],
  });
  // Its lines as the window shows them, by their label.
  const lines = id => {
    const texts = $(id).children.map(item => item.textContent);
    return Object.fromEntries(texts.flatMap((text, at) => (at % 2 ? [] : [[text, texts[at + 1]]])));
  };
  await ui.viewOutput(take({ generation_time: { total_ms: 125400, prepare_ms: 3100, engine_ms: 122300 }, generation_duration_ms: 122300 }), 0);
  let shown = lines('media-metadata');
  assert.deepEqual(Object.keys(shown), ['Modèle', 'Format', 'Résolution', 'Durée', 'Seed', 'Date', 'Temps de génération']);
  // How long it lasts, and how long it took to make: two lines, two ways of writing them.
  assert.deepEqual([shown['Durée'], shown['Temps de génération']], ['24.71 S', '2 min 05 s']);
  // Its detail under « Plus de détails »: what came before the engine, and the engine itself; not
  // again among its other parameters.
  const more = lines('media-more-list');
  assert.deepEqual([more['Temps de préparation'], more['Temps du moteur']], ['3 s', '2 min 02 s']);
  assert.doesNotMatch(more['Paramètres'], /generation_time/);
  // A take of before: the engine's time alone was kept, said as such, never as the whole of it.
  await ui.viewOutput(take({ generation_duration_ms: 116300, runner_duration_ms: 116300 }), 0);
  shown = lines('media-metadata');
  assert.deepEqual([shown['Temps du moteur'], shown['Temps de génération']], ['1 min 56 s', undefined]);
  // Nothing measured: said so.
  await ui.viewOutput(take({}), 0);
  assert.equal(lines('media-metadata')['Temps de génération'], 'Non mesuré');
  $('original-close').onclick();
});

test('the prompt of a take opened: cut, a round arrow shows it whole and folds it again; short, no arrow; folded again at another take', async t => {
  const { ui, $ } = await fixture(t);
  const take = (id, prompt) => ({
    id,
    conversationId: 'conversation',
    workflowName: 'Krea 2',
    prompt,
    createdAt: '2026-01-02T12:00:00Z',
    parameters: { seed: 1, width: 1024, height: 1024 },
    outputs: [{ source: { filename: id + '.png' }, analysisDataUrl: 'data:image/png;base64,AA==', take: 19 }],
  });
  const more = $('media-prompt-more'),
    row = $('media-prompt-row'),
    prompt = $('media-prompt');
  // A long prompt: taller than the room its panel leaves it (what the page measures).
  Object.assign(prompt, { scrollHeight: 456 });
  Object.assign(row, { clientHeight: 100 });
  const long = take('long', 'The clip starts on the supplied vertical view. '.repeat(12));
  await ui.viewOutput(long, 0, undefined, { list: () => [long], at: () => 0 });
  assert.equal(more.hidden, false);
  assert.deepEqual([more.attributes['aria-expanded'], more.attributes['aria-label']], ['false', 'Voir tout le prompt']);
  // The arrow shows it whole (the panel scrolls, its actions staying at its foot: moodix.css), then folds it.
  more.onclick();
  assert.deepEqual([more.hidden, more.attributes['aria-expanded'], more.attributes['aria-label']], [false, 'true', 'Replier le prompt']);
  more.onclick();
  assert.deepEqual([more.hidden, more.attributes['aria-expanded']], [false, 'false']);
  // Left open, another take comes folded.
  more.onclick();
  await ui.viewOutput(long, 0, undefined, { list: () => [long], at: () => 0 });
  assert.equal(more.attributes['aria-expanded'], 'false');
  // A short prompt has the room it needs: no arrow.
  Object.assign(prompt, { scrollHeight: 24 });
  Object.assign(row, { clientHeight: 24 });
  const short = take('short', 'A fox.');
  await ui.viewOutput(short, 0, undefined, { list: () => [short], at: () => 0 });
  assert.equal(more.hidden, true);
  // The actions are a part of the panel that stays at its foot, the prompt the part that gives way.
  const css = await readFile(new URL('../public/moodix.css', import.meta.url), 'utf8');
  assert.match(css, /#original-dialog \.media-information > \.media-actions \{\r?\n  position: sticky;\r?\n  bottom: 0;/);
  assert.match(css, /#original-dialog \.media-information > \.media-prompt-row \{\r?\n  position: relative;\r?\n  flex: 0 1 auto;/);
});
