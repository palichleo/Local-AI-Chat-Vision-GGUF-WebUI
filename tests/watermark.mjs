import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server.mjs';
import { Gallery } from '../lib/gallery.mjs';
import { newMontage } from '../lib/montages.mjs';
import { setupInterfaceSettings } from '../public/interface-settings.mjs';
import { WATERMARKS, WATERMARK_DEFAULT, watermarkSetting } from '../public/watermark.mjs';

// (0.6.187) The watermark of the videos that go out of Moodix (claude_design/maquettes/watermark-maquette.md),
// set in Paramètres › Interface only, L'Éclipse by default (decision of 21/11).

test('the watermark: three choices, L’Éclipse when none is kept or what is kept cannot be read', () => {
  assert.deepEqual(WATERMARKS, ['aucun', 'eclipse', 'eclipse-nom']);
  assert.equal(WATERMARK_DEFAULT, 'eclipse');
  assert.deepEqual([undefined, null, '', 'logo', 'aucun', 'eclipse-nom'].map(watermarkSetting), ['eclipse', 'eclipse', 'eclipse', 'eclipse', 'aucun', 'eclipse-nom']);
});

class Element {
  constructor(tag = 'div', className = '', text = '') {
    Object.assign(this, { tag, className, textContent: text, children: [], attributes: {}, dataset: {}, style: {}, value: '' });
    const marks = new Set();
    this.classList = { toggle: (name, on) => (on ? marks.add(name) : marks.delete(name)) };
  }
  append(...items) {
    this.children.push(...items);
  }
  replaceChildren(...items) {
    this.children = items;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  focus() {
    globalThis.document.activeElement = this;
  }
}

function settings(t) {
  const previous = globalThis.document,
    nodes = new Map(),
    $ = id => {
      if (!nodes.has(id)) nodes.set(id, new Element('div', id));
      return nodes.get(id);
    };
  globalThis.document = { activeElement: null };
  t.after(() => {
    globalThis.document = previous;
  });
  const sent = [],
    ui = setupInterfaceSettings({
      $,
      node: (...args) => new Element(...args),
      api: async (route, body) => (sent.push([route, body]), Response.json({ preferences: body ?? {} })),
      root: { dataset: {}, style: { setProperty() {} } },
    });
  const choices = () => $('watermark-choices').children,
    chosen = () => choices().filter(item => item.attributes['aria-checked'] === 'true').map(item => item.dataset.watermark);
  return { ui, $, sent, choices, chosen };
}

test('Paramètres › Interface, « Watermark »: each choice on its picture, its name under it; L’Éclipse chosen when none is kept', t => {
  const { ui, choices, chosen } = settings(t);
  ui.load({});
  assert.deepEqual(chosen(), ['eclipse']);
  assert.deepEqual(
    choices().map(item => [item.dataset.watermark, item.attributes.role, item.children.at(-1).textContent]),
    [
      ['aucun', 'radio', 'Aucun'],
      ['eclipse', 'radio', 'L’Éclipse'],
      ['eclipse-nom', 'radio', 'L’Éclipse et le nom'],
    ],
  );
  // The picture of each, with its watermark laid on it (none on « Aucun »).
  assert.deepEqual(
    choices().map(item => item.children[0].children.map(laid => laid.src)),
    [[], ['/assets/watermark-eclipse.svg'], ['/assets/watermark-eclipse-nom.svg']],
  );
  assert.equal(ui.dirty(), false);
});

test('the watermark chosen is kept with « Enregistrer », alone if the room is as it was; « Annuler » brings back the one kept', async t => {
  const { ui, sent, choices, chosen } = settings(t);
  ui.load({ room: 'velours' }, 'eclipse-nom');
  assert.deepEqual(chosen(), ['eclipse-nom']);
  choices()[0].onclick();
  assert.deepEqual(chosen(), ['aucun']);
  assert.equal(ui.dirty(), true);
  await ui.save();
  assert.deepEqual(sent, [['preferences', { watermark: 'aucun' }]]);
  assert.equal(ui.dirty(), false);
  // Changed, then closed without « Enregistrer »: what was kept.
  choices()[1].onclick();
  ui.revert();
  assert.deepEqual(chosen(), ['aucun']);
  assert.equal(ui.dirty(), false);
});

test('« Rétablir les réglages par défaut » puts L’Éclipse back with the room', t => {
  const { ui, $, chosen } = settings(t);
  ui.load({ room: 'nuit' }, 'aucun');
  $('room-reset').onclick();
  assert.deepEqual(chosen(), ['eclipse']);
  assert.equal(ui.dirty(), true);
});

test('a choice made on the keyboard keeps the focus on the picture drawn in its place', t => {
  const { ui, choices } = settings(t);
  ui.load({});
  const last = choices()[2];
  last.focus();
  last.onclick();
  assert.notEqual(choices()[2], last, 'drawn again');
  assert.equal(globalThis.document.activeElement, choices()[2]);
});

/** Moodix with an engine that only says what it was asked to assemble; a take and a bobine made of it. */
async function moodix(t) {
  const folder = await mkdtemp(join(tmpdir(), 'moodix-watermark-')),
    historyDir = join(folder, 'history'),
    outputDir = join(folder, 'output');
  t.after(() => rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const asked = [];
  // Always ready, closed or not: an engine not ready is started, and starting it first installs its
  // environment (Python, PyTorch…) in the folder of the test.
  const worker = {
    status() {
      return { state: 'ready', error: '', capabilities: {} };
    },
    async unload() {},
    async start() {
      throw new Error('this test never starts an engine');
    },
    async close() {},
    async release() {
      return { released: true, allocatedGiB: 0, kept: false };
    },
    async request(method, params) {
      if (method !== 'assemble') return {};
      asked.push(params);
      if (params.exportTo) return { outputs: [{ filename: params.exportTo.split('/').pop(), subfolder: 'bobines', type: 'export' }] };
      await mkdir(join(outputDir, 'video'), { recursive: true });
      await writeFile(join(outputDir, 'video', params.outputName + '.mp4'), 'film');
      return { jobId: params.id, outputs: [{ filename: params.outputName + '.mp4', subfolder: 'video', type: 'output', width: params.width, height: params.height }], metadata: {} };
    },
  };
  let app = await createApplication({ port: 0, dataDir: folder, historyDir, outputDir, generationWorker: worker });
  t.after(() => app.close());
  let token = (await (await fetch(`${app.url}/api/bootstrap`)).json()).token;
  const call = async (route, body) => {
    const response = await fetch(`${app.url}/api/${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await call('preferences', { saveHistory: true })).status, 200);
  const talk = randomUUID(),
    plan = randomUUID();
  assert.equal((await call('history/save', { id: talk, messages: [{ role: 'user', content: 'Le pêcheur' }] })).status, 200);
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'plan.png'), 'fichier');
  await new Gallery({ historyDir }).put(
    {
      id: plan,
      conversationId: talk,
      provider: 'native',
      mediaType: 'image',
      workflowId: 'basic',
      workflowName: 'Basic',
      prompt: 'Le pêcheur',
      parameters: {},
      createdAt: '2026-11-21T10:00:00.000Z',
      outputs: [{ source: { filename: 'plan.png', subfolder: '', type: 'output' } }],
    },
    { persist: true },
  );
  const bobine = {
    ...newMontage({ name: 'Le pêcheur' }),
    plans: [{ id: randomUUID(), kind: 'image', source: { conversationId: talk, runId: plan, output: 0 }, from: 0, to: 2, frame: 'fit' }],
    sounds: [],
  };
  assert.equal((await call('montages/save', { project: 'inbox', montage: bobine })).status, 200);
  const restart = async () => {
    await app.close();
    app = await createApplication({ port: 0, dataDir: folder, historyDir, outputDir, generationWorker: worker });
    const boot = await (await fetch(`${app.url}/api/bootstrap`)).json();
    token = boot.token;
    return boot;
  };
  return { call, asked, talk, bobine, folder, restart };
}

test('both exports of the Bobine carry the watermark of Paramètres › Interface, L’Éclipse by default; the film says it carries one', async t => {
  const { call, asked, talk, bobine, folder, restart } = await moodix(t);
  const film = () => call('montages/export', { project: 'inbox', id: bobine.id, conversation: talk }),
    takes = () => call('montages/export-takes', { project: 'inbox', id: bobine.id });
  // Nothing chosen: L'Éclipse, on the film and on each file of « Un fichier par prise ».
  const made = await film();
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal((await takes()).status, 200);
  assert.deepEqual(asked.map(request => request.watermark), ['eclipse', 'eclipse']);
  const { body: listed } = await call('library?images=0');
  const kept = listed.runs.find(run => run.id === made.body.id);
  assert.equal(kept?.parameters?.watermark, 'eclipse');
  // « L'Éclipse et le nom », then « Aucun »: nothing is asked of it then, and the film says nothing of one.
  assert.equal((await call('preferences', { watermark: 'eclipse-nom' })).body.preferences.watermark, 'eclipse-nom');
  await film();
  assert.equal(asked.at(-1).watermark, 'eclipse-nom');
  assert.equal((await call('preferences', { watermark: 'aucun' })).status, 200);
  const plain = await film();
  await takes();
  assert.deepEqual(asked.slice(-2).map(request => 'watermark' in request), [false, false]);
  const again = (await call('library?images=0')).body.runs.find(run => run.id === plain.body.id);
  assert.equal('watermark' in (again?.parameters ?? {}), false);
  // Kept for the next start.
  assert.equal(JSON.parse(await readFile(join(folder, 'preferences.json'), 'utf8')).watermark, 'aucun');
  assert.equal((await restart()).preferences.watermark, 'aucun');
  await film();
  assert.equal('watermark' in asked.at(-1), false);
});

test('the preferences take one of the three watermarks only, and say none before one is chosen', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'moodix-watermark-'));
  t.after(() => rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  // Kept before 0.6.187, or damaged: not said, L'Éclipse is the one (watermarkSetting).
  await writeFile(join(folder, 'preferences.json'), JSON.stringify({ theme: 'dark', saveHistory: true, watermark: '../logo.png' }));
  const app = await createApplication({ port: 0, dataDir: folder });
  t.after(() => app.close());
  const boot = await (await fetch(`${app.url}/api/bootstrap`)).json();
  assert.equal('watermark' in boot.preferences, false);
  const send = body =>
    fetch(`${app.url}/api/preferences`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${boot.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  for (const wrong of ['logo', '', null, 1, { name: 'eclipse' }]) {
    const refused = await send({ watermark: wrong });
    assert.deepEqual([refused.status, (await refused.json()).error], [400, 'Watermark invalide.'], JSON.stringify(wrong));
  }
  for (const name of WATERMARKS) assert.equal((await (await send({ watermark: name })).json()).preferences.watermark, name);
});
