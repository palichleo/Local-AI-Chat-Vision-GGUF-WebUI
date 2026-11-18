import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cardMeta, clipSeconds, setupGenerationUI, takeLine } from '../public/generation-ui.mjs';
// The parent of an element, out of what is compared (not enumerable).
const adopt = (parent, item) =>
  item instanceof Element && Object.defineProperty(item, 'parent', { value: parent, writable: true, configurable: true });
class Element {
  constructor(tag = '', cls = '', text = '') {
    const classes = new Set(cls.split(' '));
    Object.assign(this, {
      tag,
      cls,
      textContent: text,
      children: [],
      style: {
        setProperty(name, value) {
          this[name] = value;
        },
        removeProperty(name) {
          delete this[name];
        },
      },
      attributes: {},
      classList: {
        add(...names) {
          for (const name of names) classes.add(name);
        },
        remove(...names) {
          for (const name of names) classes.delete(name);
        },
        toggle(name, value) {
          if (value) classes.add(name);
          else classes.delete(name);
        },
        contains: name => classes.has(name),
      },
    });
  }
  append(...items) {
    for (const item of items) adopt(this, item);
    this.children.push(...items);
  }
  // The picture so far goes first in its frame (live-preview.mjs).
  prepend(...items) {
    for (const item of items) adopt(this, item);
    this.children.unshift(...items);
  }
  replaceChildren(...items) {
    for (const item of items) adopt(this, item);
    this.children = items;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  setAttribute(key, value) {
    this.attributes[key] = value;
  }
  removeAttribute(key) {
    delete this[key];
    delete this.attributes[key];
  }
}
test('organic frame uses the known size and is replaced by an original blob outside the model payload', async () => {
  const container = new Element(),
    original = new Blob(['full original bytes'], { type: 'image/png' }),
    api = async () => {
      throw Error('No request expected');
    };
  let opened;
  const ui = setupGenerationUI({
      api,
      node: (...args) => new Element(...args),
      openOutput: (...args) => {
        opened = args;
      },
    }),
    card = ui.mount(container, { resolution: { width: 1536, height: 1024 } }),
    frame = container.children[0].children[0];
  assert.equal(frame.style.aspectRatio, '1536 / 1024');
  assert.equal(frame.attributes['aria-busy'], 'true');
  card.progress('{"state":"running","promptId":"private"}');
  const [bar, label] = container.children[0].children[1].children;
  assert.equal(bar.attributes.role, 'progressbar');
  assert.equal(bar.attributes['aria-label'], 'Génération de l’image…');
  assert.equal(label.classList.contains('sr-only'), true);
  assert.equal(container.children[0].children[1].children.length, 2);
  const record = { id: 'run', workflowName: 'Custom', prompt: 'Prompt', parameters: { reference_count: 2 } };
  card.image({ record, index: 0, blob: original });
  const button = frame.children[0],
    img = button.children[0];
  assert.match(img.src, /^blob:/);
  assert.equal(await (await fetch(img.src)).text(), 'full original bytes');
  img.naturalWidth = 1536;
  img.naturalHeight = 1024;
  img.onload();
  button.onclick();
  assert.deepEqual(opened, [record, 0, original]);
  assert.equal(frame.attributes['aria-busy'], 'false');
  assert.equal(bar.classList.contains('is-complete'), false);
  card.finish({ record });
  assert.equal(bar.classList.contains('is-complete'), true);
  assert.equal(bar.attributes['aria-hidden'], 'true');
  assert.equal(label.classList.contains('sr-only'), false);
  assert.doesNotMatch(label.textContent, /1536|1024/);
  const completedLabel = label.textContent;
  card.progress('Late status update');
  assert.equal(label.textContent, completedLabel);
  assert.equal(bar.classList.contains('is-complete'), true);
  const url = img.src;
  ui.clear();
  await assert.rejects(fetch(url));
  assert.doesNotMatch(JSON.stringify(record), /blob:|full original/);
});
test('a reported fraction turns the bar determinate and completion hands it to the CSS finish', () => {
  const container = new Element();
  const ui = setupGenerationUI({
    api: async () => {
      throw Error('No request expected');
    },
    node: (...args) => new Element(...args),
    openOutput: () => {},
  });
  const card = ui.mount(container, { mediaType: 'video', resolution: { width: 384, height: 256 } });
  const [bar] = container.children[0].children[1].children;
  card.progress('Génération · 3/8');
  assert.equal(bar.classList.contains('is-determinate'), false);
  card.progress('Génération · 3/8', 0.384);
  assert.equal(bar.classList.contains('is-determinate'), true);
  assert.equal(bar.style['--generation-progress'], '0.384');
  assert.equal(bar.style['--generation-percent'], '38');
  assert.equal(bar.attributes['aria-valuenow'], '38');
  card.progress('Génération · 9/8', 7);
  assert.equal(bar.style['--generation-progress'], '1');
  card.fail('Interrompu');
  assert.equal(bar.classList.contains('is-complete'), true);
  assert.equal(bar.style['--generation-progress'], undefined);
});

test('the waiting frame takes the size the user chose in the confirmation window', () => {
  const container = new Element();
  const ui = setupGenerationUI({
    api: async () => {
      throw Error('No request expected');
    },
    node: (...args) => new Element(...args),
    openOutput: () => {},
  });
  // The proposal is landscape; the user picks 9:16 before confirming (the request is revised in place).
  const request = { mediaType: 'video', resolution: { width: 384, height: 256 } };
  const card = ui.mount(container, request);
  const frame = container.children[0].children[0];
  assert.equal(frame.style.aspectRatio, '384 / 256');
  Object.assign(request, { resolution: { width: 896, height: 1600 } });
  const label = container.children[0].children[1].children[1];
  assert.equal(label.classList.contains('sr-only'), true);
  card.progress('Génération · 1/11', 0.1);
  assert.equal(frame.style.aspectRatio, '896 / 1600');
  // The stage in progress is shown beside the percentage.
  assert.deepEqual([label.textContent, label.classList.contains('sr-only')], ['Génération · 1/11', false]);
  card.progress('Décodage de la vidéo…', 0.9);
  assert.equal(label.textContent, 'Décodage de la vidéo…');
  card.fail('Interrompu');
});

test('restored chat resolves the saved Comfy output and releases display blobs when conversation changes', async () => {
  const container = new Element(),
    requests = [],
    record = {
      id: 'run',
      conversationId: 'conversation',
      workflowName: 'Custom',
      prompt: 'Prompt',
      parameters: {},
      outputs: [{ source: { filename: 'original.png' } }],
    };
  const ui = setupGenerationUI({
    node: (...args) => new Element(...args),
    openOutput() {},
    api: async route => {
      requests.push(route);
      return route.endsWith('/0')
        ? new Response('original bytes', { headers: { 'content-type': 'image/png' } })
        : Response.json(record);
    },
  });
  ui.restore(container, 'conversation', 'run');
  assert.equal(container.children[0].children[1].children[0].hidden, true);
  await new Promise(setImmediate);
  assert.deepEqual(requests, ['gallery/conversation/run', 'gallery/conversation/run/0']);
  const img = container.children[0].children[0].children[0].children[0];
  assert.equal(await (await fetch(img.src)).text(), 'original bytes');
  ui.clear();
});

test('restoring a long conversation defers originals, serializes transfers and revokes offscreen blobs', async t => {
  const previous = globalThis.IntersectionObserver;
  let observed;
  globalThis.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      observed = this;
    }
    observe(target) {
      this.targets.add(target);
    }
    unobserve(target) {
      this.targets.delete(target);
    }
  };
  t.after(() => {
    globalThis.IntersectionObserver = previous;
  });
  const record = {
    id: 'run',
    conversationId: 'conversation',
    workflowName: 'Custom',
    prompt: 'Prompt',
    parameters: {},
    outputs: [0, 1].map(i => ({
      source: { filename: i + '.png' },
      width: 1024,
      height: 1024,
      analysisDataUrl: 'compressed-preview',
    })),
  };
  const calls = [],
    gates = [],
    container = new Element();
  const ui = setupGenerationUI({
    node: (...args) => new Element(...args),
    openOutput() {},
    api: async (route, _, options) => {
      calls.push(route);
      if (route === 'gallery/conversation/run') return Response.json(record);
      return new Promise((resolve, reject) => {
        gates.push(() => resolve(new Response('original bytes', { headers: { 'content-type': 'image/png' } })));
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
  });
  ui.restore(container, 'conversation', 'run');
  await new Promise(setImmediate);
  assert.equal(calls.length, 0, 'offscreen history must not fetch originals');
  observed.callback([{ target: container.children[0], isIntersecting: true }]);
  await new Promise(setImmediate);
  assert.equal(calls.length, 1);
  const [first, second] = container.children.map(figure => figure.children[0].children[0]);
  observed.callback([
    { target: first, isIntersecting: true },
    { target: second, isIntersecting: true },
  ]);
  await new Promise(setImmediate);
  assert.equal(calls.length, 2, 'only one original transfers at a time');
  gates[0]();
  await new Promise(setImmediate);
  assert.equal(calls.length, 3);
  const url = first.children[0].src;
  assert.match(url, /^blob:/);
  observed.callback([{ target: first, isIntersecting: false }]);
  await assert.rejects(fetch(url));
  assert.equal(first.children[0].src, 'compressed-preview');
  ui.clear();
  await new Promise(setImmediate);
  assert.equal(observed.targets.size, 0);
  gates[1]();
  await new Promise(setImmediate);
  assert.doesNotMatch(second.children[0].src || '', /^blob:/, 'late completion cannot resurrect a disposed original');
});

test('video output uses the original streaming URL, plays from its round button, and never buffers a full clip in the chat', async () => {
  const container = new Element(),
    record = {
      id: 'run',
      conversationId: 'conversation',
      mediaType: 'video',
      workflowName: 'Motion',
      prompt: 'Slow pan',
      parameters: { stage: 'draft' },
      outputs: [{ source: { filename: 'clip.mp4' }, originalUrl: '/media/generated/signed' }],
    };
  let opened;
  const ui = setupGenerationUI({
      node: (...args) => new Element(...args),
      openOutput: (...args) => (opened = args),
      api: async () => {
        throw Error('No full-video blob transfer expected');
      },
    }),
    card = ui.mount(container, { mediaType: 'video', plan: { stage: 'draft' } });
  const [bar, label] = container.children[0].children[1].children;
  card.progress('Génération de la vidéo…');
  assert.equal(label.classList.contains('sr-only'), true);
  assert.equal(bar.attributes['aria-label'], 'Génération de la vidéo…');
  card.image({ record, index: 0 });
  record.outputs[0].analysisDataUrl = 'compressed-preview';
  card.finish({ record });
  const frame = container.children[0].children[0],
    wrapper = frame.children[0],
    video = wrapper.children.find(node => node.tag === 'video');
  assert.ok(video);
  assert.equal(video.poster, 'compressed-preview');
  // Its picture and a round play button (capture 14); the controls of the player once it plays.
  const play = wrapper.children.find(node => node.cls === 'take-play');
  assert.equal(video.controls, false);
  assert.equal(play.attributes['aria-label'], 'Lire la vidéo');
  play.onclick();
  assert.equal(video.controls, true);
  assert.equal(play.hidden, true);
  assert.equal(video.preload, 'none');
  assert.equal(video.src, '/media/generated/signed');
  assert.match(label.textContent, /Brouillon/);
  assert.equal(bar.classList.contains('is-complete'), true);
  // Détails sits below the video, with the other output buttons.
  container.children[0].children.find(node => node.tag === 'button').onclick();
  assert.deepEqual(opened, [record, 0]);
  ui.clear();
  assert.equal(video.src, undefined);
});

test('a proposal declined goes without a trace: no card, no line, nothing left to watch (16/11)', () => {
  const container = new Element();
  let resized = 0;
  const ui = setupGenerationUI({
    node: (...args) => new Element(...args),
    api: async () => {
      throw Error('No generation expected');
    },
    openOutput() {},
    onResize() {
      resized++;
    },
  });
  container.classList.add('generation-grid');
  const card = ui.mount(container, { mediaType: 'video', resolution: { width: 768, height: 448 } });
  assert.equal(container.children.length, 1);
  card.finish({ denied: true });
  assert.deepEqual(container.children, []);
  assert.equal(container.classList.contains('generation-grid'), false, 'no empty room left under the text');
  assert.equal(card.finished, true);
  assert.ok(resized > 0);
  ui.clear();
});

test('a take that fails stays veiled at its format: « ÉCHEC », what failed, « Relancer » and « Modifier la proposition » (52)', () => {
  const container = new Element(),
    again = [];
  const ui = setupGenerationUI({
    node: (...args) => new Element(...args),
    api: async () => {
      throw Error('No request expected');
    },
    openOutput() {},
    onAgain: (request, options) => again.push([request.requestId, options.edit]),
  });
  const card = ui.mount(container, { requestId: 'r1', mediaType: 'video', workflowName: 'LTX 2.5', resolution: { width: 768, height: 448 } }),
    figure = container.children[0],
    [frame, caption] = figure.children;
  card.progress('Mémoire vidéo insuffisante : nouvel essai, plus lent…');
  assert.equal(figure.classList.contains('is-warned'), true, 'its point amber while it tries again');
  card.progress('Décodage de la vidéo…');
  assert.equal(figure.classList.contains('is-warned'), false);
  card.finish({ failed: true, error: 'La mémoire de la carte graphique a manqué au décodage.' });
  assert.equal(frame.hidden, false, 'at its place and its format');
  assert.equal(figure.classList.contains('is-failed'), true);
  const [chip, veil] = frame.children.slice(-2);
  assert.equal(chip.textContent, 'Échec');
  assert.equal(veil.children[0].textContent, 'La génération a échoué');
  // One sentence a line: « Rien » never left alone at the end of one.
  assert.deepEqual(veil.children[1].children.map(item => item.textContent), [
    'La mémoire de la carte graphique a manqué au décodage.',
    ' Rien n’a été enregistré.',
  ]);
  assert.equal(caption.children[1].textContent, 'Échec pendant le décodage de la vidéo');
  // The card held (54): the same words as in the Studio, then what failed once it is free again.
  ui.held(true);
  assert.equal(veil.children[0].textContent, 'Arrêtée');
  assert.deepEqual(veil.children[1].children.map(item => item.textContent), [
    'La carte graphique est restée prise par la dernière génération.',
    ' Rien n’a été enregistré.',
  ]);
  ui.held(false);
  assert.equal(veil.children[0].textContent, 'La génération a échoué');
  assert.equal(veil.children[1].children[0].textContent, 'La mémoire de la carte graphique a manqué au décodage.');
  const [relaunch, edit] = veil.children[2].children;
  relaunch.onclick();
  edit.onclick();
  assert.deepEqual(again, [
    ['r1', false],
    ['r1', true],
  ]);
  ui.clear();
});

test('cancelled generations hide the empty preview and its dimensions', async t => {
  for (const [name, settle] of [
    ['cancelled', card => card.fail('Generation cancelled')],
    ['missing original', card => card.finish({ record: { outputs: [] } })],
  ])
    await t.test(name, () => {
      const container = new Element();
      let resized = 0;
      const ui = setupGenerationUI({
          node: (...args) => new Element(...args),
          api: async () => {
            throw Error('No generation expected');
          },
          openOutput() {},
          onResize() {
            resized++;
          },
        }),
        card = ui.mount(container, { resolution: { width: 512, height: 512 } }),
        [frame, caption] = container.children[0].children;
      const before = resized;
      settle(card);
      assert.equal(frame.hidden, true);
      assert.equal(caption.children[0].classList.contains('is-complete'), true);
      assert.ok(caption.children[1].textContent);
      assert.equal(caption.children[1].classList.contains('sr-only'), false);
      assert.equal(frame.attributes['aria-busy'], 'false');
      assert.equal(card.finished, true);
      assert.ok(resized > before);
      ui.clear();
    });
});

test('an analysis or model reload failure preserves an original that was already produced', t => {
  const container = new Element(),
    ui = setupGenerationUI({
      node: (...args) => new Element(...args),
      api: async () => {
        throw Error('No request expected');
      },
      openOutput() {},
    });
  t.after(() => ui.clear());
  const card = ui.mount(container),
    record = { workflowName: 'User workflow', parameters: {}, outputs: [{}] };
  card.image({ record, index: 0, blob: new Blob(['original'], { type: 'image/png' }) });
  const frame = container.children[0].children[0],
    img = frame.children[0].children[0];
  card.finish({ record, failed: true, error: 'Analysis unavailable' });
  assert.notEqual(frame.hidden, true);
  assert.match(img.src, /^blob:/);
  card.fail('Model reload failed');
  assert.notEqual(frame.hidden, true);
  assert.match(img.src, /^blob:/);
});

test('sequential runs and batch outputs append separate tiles to the same grid without replacing originals', async t => {
  const container = new Element(),
    ui = setupGenerationUI({
      node: (...args) => new Element(...args),
      api: async () => {
        throw Error('No request expected');
      },
      openOutput() {},
    });
  t.after(() => ui.clear());
  const first = ui.mount(container),
    record = { workflowName: 'Batch', parameters: {}, outputs: [{}, {}] },
    blob = new Blob(['original'], { type: 'image/png' });
  first.image({ record, index: 0, blob });
  first.image({ record, index: 1, blob });
  first.finish({ record });
  const second = ui.mount(container, { resolution: { width: 768, height: 1024 } });
  assert.equal(container.children.length, 3);
  assert.equal(container.children[2].children[0].style.aspectRatio, '768 / 1024');
  for (const figure of container.children.slice(0, 2)) {
    const frame = figure.children[0];
    assert.equal(frame.children.length, 1);
    assert.match(frame.children[0].children[0].src, /^blob:/);
  }
  second.fail('Cancelled');
  assert.equal(container.children[2].children[0].hidden, true);
  assert.notEqual(container.children[0].children[0].hidden, true);
});

test('loading animation pauses outside the viewport and observation stops on refusal', t => {
  const previous = globalThis.IntersectionObserver;
  let observed;
  globalThis.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      observed = this;
    }
    observe(target) {
      this.targets.add(target);
    }
    unobserve(target) {
      this.targets.delete(target);
    }
  };
  t.after(() => {
    globalThis.IntersectionObserver = previous;
  });
  const container = new Element(),
    ui = setupGenerationUI({
      node: (...args) => new Element(...args),
      api: async () => {
        throw Error('No generation expected');
      },
      openOutput() {},
    });
  t.after(() => ui.clear());
  const card = ui.mount(container),
    figure = container.children[0],
    frame = figure.children[0];
  assert.equal(frame.classList.contains('is-paused'), true);
  observed.callback([{ target: figure, isIntersecting: true }]);
  assert.equal(frame.classList.contains('is-paused'), false);
  observed.callback([{ target: figure, isIntersecting: false }]);
  assert.equal(frame.classList.contains('is-paused'), true);
  card.finish({ denied: true });
  assert.equal(observed.targets.size, 0);
  assert.deepEqual(container.children, [], 'declined: nothing left');
});

test('a creation of the Studio is a card: what it is, and « Ouvrir », which leads to the Studio before it exists too', () => {
  const container = new Element(),
    opened = [];
  const ui = setupGenerationUI({
    api: async () => {
      throw Error('No request expected');
    },
    node: (...args) => new Element(...args),
    openOutput: () => {},
    onOpen: record => opened.push(record?.id ?? null),
  });
  const card = ui.mount(
    container,
    {
      mediaType: 'video',
      resolution: { width: 1344, height: 768 },
      plan: { prompt: 'Un renard se lève', parameters: { frames: 121, fps: 24 } },
    },
    { compact: true },
  );
  const [figure] = container.children,
    find = cls => figure.children.find(child => child.cls === cls);
  assert.equal(figure.cls, 'generation-card is-compact');
  assert.equal(find('card-text').children[0].textContent, 'Un renard se lève');
  // The true length of what is made, two figures each side of the point (121 frames at 24 a second).
  assert.equal(find('card-text').children[1].textContent, 'VIDÉO · 16:9 · 05.04 S');
  // Waiting for « Générer » in the Studio: « Ouvrir » goes there.
  find('card-open').onclick();
  assert.deepEqual(opened, [null]);
  const record = {
    id: 'r',
    conversationId: 'c',
    mediaType: 'video',
    prompt: 'Un renard se lève',
    workflowName: 'MiniMax',
    parameters: { width: 1344, height: 768, frames: 121, fps: 24 },
    outputs: [{ thumbUrl: '/thumb.jpg', originalUrl: '/clip.mp4' }],
  };
  card.image({ record, index: 0 });
  card.finish({ record });
  // Made: its first picture as it is (no grain over it) and its round play button; « Ouvrir » puts
  // it on the screen.
  const [shown, play] = figure.children[0].children;
  assert.equal(shown.tag, 'img');
  assert.equal(shown.src, '/thumb.jpg');
  assert.equal(figure.children[0].children.length, 2);
  assert.equal(play.cls, 'take-play');
  find('card-open').onclick();
  assert.deepEqual(opened, [null, 'r']);
  // Played where it is: the player, with its controls, in place of the picture.
  play.onclick();
  const [video] = figure.children[0].children;
  assert.equal(video.tag, 'video');
  assert.equal(video.src, '/clip.mp4');
  assert.equal(video.controls, true);
});

test('a card of the Studio shows its thumbnail, or its file once, and never downloads its original again', () => {
  const container = new Element();
  const ui = setupGenerationUI({
    api: async () => {
      throw Error('No request expected');
    },
    node: (...args) => new Element(...args),
    openOutput: () => {},
    onOpen: () => {},
  });
  const record = thumb => ({
    id: 'r',
    conversationId: 'c',
    mediaType: 'image',
    prompt: 'un chien',
    workflowName: 'Krea 2',
    parameters: { width: 1024, height: 1024 },
    outputs: [{ originalUrl: '/media/r', ...(thumb ? { thumbUrl: '/thumb/r' } : {}) }],
  });
  for (const [thumb, expected] of [
    [true, '/thumb/r'],
    [false, '/media/r'],
  ]) {
    const card = ui.mount(container, { resolution: { width: 1024, height: 1024 } }, { compact: true });
    const made = record(thumb);
    card.image({ record: made, index: 0 });
    const figure = container.children.at(-1),
      [button] = figure.children[0].children,
      [picture] = button.children;
    assert.equal(picture.src, expected);
  }
});

test('a proposal declined leaves nothing; stopped, it leaves its card without « Ouvrir »', () => {
  const container = new Element();
  const ui = setupGenerationUI({
    api: async () => {
      throw Error('No request expected');
    },
    node: (...args) => new Element(...args),
    openOutput: () => {},
    onOpen: () => {},
  });
  const proposal = { mediaType: 'video', resolution: { width: 768, height: 448 } };
  const declined = ui.mount(container, proposal, { compact: true });
  declined.finish({ denied: true });
  assert.deepEqual(container.children, []);
  const card = ui.mount(container, proposal, { compact: true });
  const open = container.children[0].children.find(child => child.cls === 'card-open');
  assert.equal(open.disabled, false, 'waiting: it leads to the Studio');
  card.fail('Génération interrompue.');
  assert.equal(open.disabled, true);
});

test('a creation of the Studio being made is drawn in the conversation as the other takes: the Flux, its line at the foot of its picture (0.6.96)', async () => {
  // Seen in the Chat after the Studio: the moving background of before, the picture so far dimmed
  // under it, and its line at the foot of the card, on « Ouvrir » (capture 33).
  class Canvas extends Element {
    getContext() {
      return new Proxy({ createRadialGradient: () => ({ addColorStop() {} }) }, { get: (pen, key) => pen[key] ?? (() => {}) });
    }
  }
  const page = {
    document: { createElement: () => Object.assign(new Canvas('canvas'), { width: 0, height: 0 }), documentElement: { dataset: {} } },
    devicePixelRatio: 1,
    performance: { now: () => 0 },
    matchMedia: () => ({ matches: false }),
    setTimeout: () => 0,
    clearTimeout() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
  };
  const before = globalThis.window,
    told = [];
  globalThis.window = page;
  try {
    const ui = setupGenerationUI({
      api: async () => {
        throw Error('No request expected');
      },
      node: (tag, cls = '', text = '') => (tag === 'canvas' ? new Canvas(tag, cls, text) : new Element(tag, cls, text)),
      openOutput() {},
      onOpen() {},
      onLive: event => told.push(event),
    });
    const request = { mediaType: 'video', workflowName: 'LTX 2.5', resolution: { width: 448, height: 768 }, plan: { prompt: 'Le petit lac' } },
      container = new Element(),
      card = ui.mount(container, request, { compact: true }),
      [figure] = container.children,
      [frame] = figure.children,
      find = cls => figure.children.find(child => child.cls === cls);
    // In its frame the Flux of the take, as on the screen of the Studio and the takes of the Chat.
    assert.equal(frame.classList.contains('has-flux'), true);
    assert.equal(frame.children.filter(child => child.cls === 'take-flux').length, 1);
    // Its line in its frame, at the foot of its picture; its words and « Ouvrir » under it, as before.
    const bar = frame.children.find(child => child.cls === 'generation-progress');
    assert.ok(bar, 'the line in the frame');
    assert.equal(find('generation-caption').children.includes(bar), false, 'not at the foot of the card');
    assert.equal(find('card-text').children[0].textContent, 'Le petit lac');
    assert.ok(find('card-open'));
    // Its stage over it, its time from its go at its right (0.6.93), its line filling, as the others.
    card.progress('Génération · 3/8', 0.4, null, { ms: 5200, running: true });
    assert.equal(bar.style['--generation-progress'], '0.4');
    const [stage, time] = find('generation-caption').children;
    assert.equal(stage.textContent, 'Génération · 3/8');
    assert.deepEqual([time?.cls, time?.textContent], ['generation-elapsed', '5 s']);
    // Its count told with its step: the Studio of its conversation counts from the same go (0.6.96).
    const step = told.findLast(event => event.type === 'progress');
    assert.deepEqual([step.compact, step.time?.ms], [true, 5200]);
    // A take of the Chat keeps its line under its picture (in its caption, which comes over it).
    const chat = new Element();
    ui.mount(chat, request);
    const [take] = chat.children;
    assert.equal(take.children[1].children[0].cls, 'generation-progress');
    assert.equal(take.children[0].classList.contains('has-flux'), true);
  } finally {
    globalThis.window = before;
  }
  // Out of sight, its line rests as under a picture.
  const sheet = await readFile(new URL('../public/moodix.css', import.meta.url), 'utf8');
  assert.match(sheet, /\.generation-frame\.is-paused > \.generation-progress > span,\s*\.generation-frame\.is-paused > \.generation-progress > span::after \{\s*animation-play-state: paused;/);
});

test('under a take made with LoRAs of the user: their number beside its format, their names to read', () => {
  const record = {
    mediaType: 'image',
    parameters: {
      width: 1024,
      height: 1024,
      styles: [
        { name: 'styles\\70sSCiFiKrea2Raw.safetensors', strength: 0.8 },
        { name: 'detail.safetensors', strength: 1 },
      ],
    },
    outputs: [{ take: 12 }],
  };
  const line = takeLine(record, 0);
  assert.deepEqual([line.number, line.format, line.loras], ['PRISE 12', '1:1', '2 LoRA']);
  assert.equal(line.lorasTitle, '70sSCiFiKrea2Raw · 0,8\ndetail · 1');
  // None: nothing is added.
  const plain = takeLine({ ...record, parameters: { width: 1024, height: 1024 } }, 0);
  assert.deepEqual([plain.loras, plain.lorasTitle], ['', '']);
});

test('a clip put back in a conversation takes the shape its record says, before its file is ever read', () => {
  const container = new Element(),
    record = {
      id: 'run',
      conversationId: 'conversation',
      mediaType: 'video',
      workflowName: 'LTX 2.5',
      prompt: 'A staircase above the clouds',
      parameters: { stage: 'draft', width: 288, height: 512, frames: 121, fps: 24 },
      outputs: [{ source: { filename: 'clip.mp4' }, originalUrl: '/media/generated/signed', take: 19 }],
    };
  const ui = setupGenerationUI({ node: (...args) => new Element(...args), openOutput() {}, api: async () => ({}) });
  // As a conversation reopened mounts it: nothing known of the request that made it.
  const card = ui.mount(container, {});
  card.image({ record, index: 0 });
  const frame = container.children[0].children[0];
  // (Left to the reading of the file, which waits for « play », an upright clip was drawn 560 px wide.)
  assert.equal(frame.style.aspectRatio, '288 / 512');
  // The size its file says, when it differs from its record (an enlargement), is the one kept.
  const larger = new Element(),
    big = { ...record, outputs: [{ ...record.outputs[0], width: 1152, height: 2048 }] },
    other = ui.mount(larger, {});
  other.image({ record: big, index: 0 });
  assert.equal(larger.children[0].children[0].style.aspectRatio, '1152 / 2048');
});

test('a continuation says the length of its file under its take, and what it adds on its proposal', () => {
  // As the engine records it: 120 new frames after the 121 of its clip, 9 of them shared.
  const parameters = {
    width: 896,
    height: 1600,
    frames: 129,
    fps: 24,
    overlap_frames: 9,
    continuation: { overlapFrames: 9, sourceFrames: 121, newFrames: 120 },
  };
  // Its file plays its clip, then the suite: 241 frames (it read « 05.38 S »).
  assert.equal(clipSeconds(parameters), 241 / 24);
  assert.equal(takeLine({ mediaType: 'video', parameters, outputs: [{ take: 28 }] }, 0).seconds, '10.04 S');
  // A clip that continues nothing: its frames.
  assert.equal(clipSeconds({ frames: 121, fps: 24 }), 121 / 24);
  assert.equal(clipSeconds({ frames: 121 }), null);
  // On the card of a proposal: « Suite », and the 5 s it adds.
  assert.equal(cardMeta({ media: 'video', width: 896, height: 1600, seconds: 5, added: true }), 'Suite · 9:16 · + 05.00 S');
});

test('a take being made tells the miniature where it is; a take put back from the history tells nothing (0.6.81)', async () => {
  const told = [];
  const ui = setupGenerationUI({
    node: (...args) => new Element(...args),
    api: async () => Response.json({ id: 'old', conversationId: 'a', outputs: [{ source: {} }] }),
    openOutput() {},
    onLive: event => told.push(event),
  });
  const request = { requestId: 'r1', mediaType: 'video', workflowName: 'LTX 2.5', resolution: { width: 768, height: 448 } },
    card = ui.mount(new Element(), request);
  card.progress('Génération · 5/8', 0.42, '/media/job-preview/j/3');
  const record = { id: 'run', conversationId: 'a', mediaType: 'video', workflowName: 'LTX 2.5', parameters: {}, outputs: [{ take: 14, thumbUrl: '/thumb' }] };
  card.image({ record, index: 0 });
  card.finish({ record });
  assert.deepEqual(
    told.map(({ type, text, fraction, preview, index }) => [type, text, fraction, preview, index].filter(value => value !== undefined)),
    [['start'], ['progress', 'Génération · 5/8', 0.42, '/media/job-preview/j/3'], ['image', 0], ['done']],
  );
  assert.ok(told.every(event => event.request === request), 'each with its request');
  assert.equal(told.at(-1).record, record);
  // Failed, stopped: said too.
  const failing = ui.mount(new Element(), request);
  failing.finish({ failed: true, error: 'La mémoire a manqué.' });
  ui.mount(new Element(), request).withdraw();
  assert.deepEqual(told.slice(4).map(event => [event.type, event.message].filter(Boolean)), [['start'], ['failed', 'La mémoire a manqué.'], ['start'], ['stopped']]);
  // Put back from the history (a conversation opened): nothing to follow.
  const before = told.length,
    restored = new Element();
  ui.restore(restored, 'a', 'old');
  assert.equal(told.length, before);
  // A miniature that breaks breaks nothing of the card.
  const sturdy = setupGenerationUI({ node: (...args) => new Element(...args), api: async () => ({}), openOutput() {}, onLive: () => {
    throw Error('miniature');
  } });
  assert.doesNotThrow(() => sturdy.mount(new Element(), request).progress('Génération · 1/8', 0.1));
});

test('a take in the making says how long since its go, at the right of its stage; made, how long it took, under it (0.6.93)', () => {
  const told = [];
  const ui = setupGenerationUI({
    node: (...args) => new Element(...args),
    api: async () => ({}),
    openOutput() {},
    onLive: event => told.push(event),
  });
  const container = new Element(),
    request = { requestId: 'r1', mediaType: 'video', workflowName: 'LTX 2.5', resolution: { width: 768, height: 448 } },
    card = ui.mount(container, request),
    [figure] = container.children,
    caption = figure.children[1],
    time = () => caption.children.find(child => child.cls === 'generation-elapsed');
  // Nothing counted by the server yet (a card that waits for « Confirmer »): no time.
  card.progress('Préparation…');
  assert.equal(time(), undefined);
  // Its count, from the go, as the server says it; the miniature hears it.
  card.progress('Génération · 5/8', 0.42, null, { ms: 72000, running: true });
  assert.deepEqual([time().tag, time().textContent], ['time', '1 min 12 s']);
  assert.deepEqual(told.filter(event => event.type === 'time').map(event => event.text), ['1 min 12 s']);
  // Made: the count leaves its stage, and how long it took is written under it, after « PRISE 14 ».
  const record = {
    id: 'run',
    conversationId: 'a',
    mediaType: 'video',
    workflowName: 'LTX 2.5',
    parameters: { width: 768, height: 448, frames: 121, fps: 24, generation_time: { total_ms: 73400, prepare_ms: 2400, engine_ms: 71000 } },
    outputs: [{ take: 14, thumbUrl: '/thumb', originalUrl: '/clip.mp4' }],
  };
  card.image({ record, index: 0 });
  assert.equal(time().textContent, '');
  const line = figure.children.find(child => child.cls === 'take-caption');
  assert.deepEqual(
    line.children.map(child => [child.cls, child.textContent]),
    [
      ['take-number', 'PRISE 14'],
      ['take-format', '16:9 · 768 × 448'],
      ['take-time', 'Générée en 1 min 13 s'],
    ],
  );
  // What the server says once the take is there changes nothing of it.
  card.progress('Rechargement du modèle et de la vision…', 0.98, null, { ms: 75000, running: false });
  assert.equal(time().textContent, '');
  card.finish({ record });
  // Put back from the history: under it too. A take of before, the engine's time alone: nothing there.
  assert.equal(takeLine(record, 0).time, 'Générée en 1 min 13 s');
  assert.equal(takeLine({ ...record, parameters: { width: 768, height: 448, generation_duration_ms: 70000 } }, 0).time, '');
  // A take that fails: no time left at its stage.
  const failing = ui.mount(new Element(), request);
  failing.progress('Génération · 2/8', 0.2, null, { ms: 30000, running: true });
  failing.failed('La mémoire a manqué.');
  assert.equal(failing.container.children[0].children[1].children.find(child => child.cls === 'generation-elapsed').textContent, '');
  ui.clear();
});

test('the cards of a conversation set aside stay while another is shown; they go with it (0.6.81)', () => {
  const ui = setupGenerationUI({ node: (...args) => new Element(...args), api: async () => ({}), openOutput() {} });
  const shown = new Element(),
    setAside = new Element();
  const left = ui.mount(setAside, { requestId: 'r1', mediaType: 'video' }),
    other = ui.mount(shown, { requestId: 'r2' });
  const disposed = card => {
    // A card disposed of hears no more of its take.
    card.progress('Génération · 8/8', 1);
    return !card.container.children[0].children[1].children[0].classList.contains('is-determinate');
  };
  // Another conversation opened: the cards on the page go, those set aside stay.
  ui.clear({ contains: element => element === setAside });
  assert.equal(disposed(other), true);
  assert.equal(disposed(left), false);
  // The conversation set aside leaves the page: its cards with it.
  const later = new Element(),
    again = ui.mount(later, { requestId: 'r3' });
  ui.drop({ contains: element => element === later });
  assert.equal(disposed(again), true);
});

test('while another creation runs, « Relancer » and « Modifier la proposition » are greyed, and say why (0.6.81)', () => {
  const container = new Element();
  const ui = setupGenerationUI({
    node: (...args) => new Element(...args),
    api: async () => ({}),
    openOutput() {},
    onAgain() {},
  });
  ui.mount(container, { requestId: 'r1', mediaType: 'video', resolution: { width: 768, height: 448 } }).finish({ failed: true, error: 'Échec.' });
  const veil = container.children[0].children[0].children.at(-1),
    [relaunch, edit] = veil.children[2].children;
  ui.busy('Génération en cours dans « Renard » : attendez sa fin.');
  assert.deepEqual([relaunch.disabled, edit.disabled], [true, true]);
  assert.equal(relaunch.title, 'Génération en cours dans « Renard » : attendez sa fin.');
  // One that fails meanwhile is greyed at once.
  const next = new Element();
  ui.mount(next, { requestId: 'r2', mediaType: 'video', resolution: { width: 768, height: 448 } }).finish({ failed: true, error: 'Échec.' });
  assert.equal(next.children[0].children[0].children.at(-1).children[2].children[0].disabled, true);
  // Over: as they were, their own words back.
  ui.busy('');
  assert.deepEqual([relaunch.disabled, edit.disabled], [false, false]);
  assert.equal(relaunch.title, 'Relancer avec les mêmes réglages');
  assert.equal(edit.title, 'Rouvrir la proposition pour la modifier');
});
