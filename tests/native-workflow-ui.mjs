import test from 'node:test';
import { familyCatalog } from '../lib/families.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateNativeWorkflow } from '../lib/native-workflows.mjs';
import { setupNativeWorkflows } from '../public/native-workflow-ui.mjs';
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function fixture() {
  const nodes = new Map();
  class Element {
    constructor(tag = 'div', className = '', text = '') {
      this.tagName = tag.toUpperCase();
      this.className = className;
      this.textContent = text;
      this.children = [];
      this.listeners = {};
      this.hidden = false;
      this.value = '';
      this.checked = false;
      this.disabled = false;
      this.dataset = {};
      this.style = {};
      this.attributes = {};
      this.classList = { toggle() {}, add() {}, remove() {} };
    }
    set id(value) {
      this._id = value;
      nodes.set(value, this);
    }
    get id() {
      return this._id;
    }
    append(...items) {
      this.children.push(...items);
      for (const item of items) item.parent = this;
    }
    prepend(...items) {
      this.children.unshift(...items);
      for (const item of items) item.parent = this;
    }
    replaceChildren(...items) {
      this.children = [];
      this.append(...items);
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    }
    setAttribute(key, value) {
      this.attributes[key] = value;
    }
    getAttribute(key) {
      return this.attributes[key] ?? null;
    }
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    }
    focus() {
      this.focused = true;
    }
    scrollIntoView() {}
    querySelectorAll() {
      return this.children
        .flatMap(child => [child, ...child.querySelectorAll()])
        .filter(child => ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'FIELDSET'].includes(child.tagName));
    }
  }
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = new Element(match[1]);
    element.id = match[3];
    element.hidden = /\bhidden(?:\s|$)/.test(match[2]);
  }
  const $ = id => nodes.get(id) || null;
  // The page hears the keys too (Échap in the editor): `press` sends it one.
  const heard = {};
  const document = {
    getElementById: $,
    createElement: tag => new Element(tag),
    // Where the focus is when a model is opened: « Modèles », in the settings.
    activeElement: $('settings-tab-workflows'),
    addEventListener: (type, fn) => (heard[type] ??= []).push(fn),
    press: event => (heard.keydown ?? []).forEach(fn => fn(event)),
  };
  const template = {
    schemaVersion: 1,
    id: 'image-test',
    name: 'Portrait',
    description: 'Portraits in studio',
    enabled: false,
    pipeline: 'krea2',
    mediaType: 'image',
    components: {
      model: { policy: 'fixed', asset: 'model-one' },
      textEncoder: { policy: 'fixed', asset: 'encoder-one' },
      tokenizer: { policy: 'fixed', asset: 'tokenizer-one' },
      vae: { policy: 'fixed', asset: 'vae-one' },
    },
    parameters: {
      prompt: { policy: 'model', type: 'string', maxLength: 8000 },
      seed: { policy: 'random', type: 'integer' },
      width: { policy: 'fixed', value: 512 },
      height: { policy: 'fixed', value: 512 },
      steps: { policy: 'fixed', value: 8 },
    },
    loras: [],
    references: [],
  };
  const calls = [],
    tokenizerRequests = [],
    workflows = [structuredClone(template)];
  let failSave = false;
  const api = async (route, body) => {
    calls.push({ route, body: structuredClone(body) });
    if (route === 'generation')
      return Response.json({
        config: { enabled: true, autoAllow: false, maxIterations: 5, pythonPath: '' },
        folders: {
          model: 'C:/atelier/models/checkpoints',
          textEncoder: 'C:/atelier/models/LLMs',
          vae: 'C:/atelier/models/VAE',
          lora: 'C:/atelier/models/LoRa',
        },
        runner: { state: 'ready', capabilities: { krea2: true } },
        families: familyCatalog(),
        workflows,
        assets: [
          { id: 'model-one', kind: 'model', pipeline: 'krea2', path: 'model.safetensors' },
          { id: 'encoder-one', kind: 'textEncoder', pipeline: 'krea2', path: 'encoder.safetensors' },
          {
            id: 'tokenizer-one',
            kind: 'tokenizer',
            pipeline: 'krea2',
            path: 'C:/comfy/text_encoders/qwen25_tokenizer',
          },
          { id: 'vae-one', kind: 'vae', pipeline: 'krea2', path: 'vae.safetensors' },
          { id: 'lora-one', kind: 'lora', pipeline: 'krea2', path: 'lora.safetensors' },
        ],
      });
    if (route === 'files/choose') return Response.json({ path: 'C:/models/new.safetensors' });
    if (route === 'generation/assets')
      return Response.json({ asset: { id: 'model-new', path: body.path, kind: body.kind, family: body.family } });
    if (route === 'generation/tokenizer') {
      tokenizerRequests.push(body);
      return Response.json({
        asset: {
          id: 'tokenizer-one',
          kind: 'tokenizer',
          family: 'krea2',
          path: 'C:/comfy/text_encoders/qwen25_tokenizer',
        },
      });
    }
    if (route === 'generation/validate') return Response.json({ workflow: validateNativeWorkflow(body) });
    if (route.startsWith('generation/workflows/'))
      return Response.json(workflows.find(item => item.id === route.slice('generation/workflows/'.length)));
    if (route === 'generation/workflows' && body) {
      if (failSave) throw Error('Composant incompatible : choisissez un modèle Krea2.');
      const index = workflows.findIndex(item => item.id === body.id);
      if (index < 0) workflows.push(body);
      else workflows[index] = body;
      return Response.json({ workflow: body });
    }
    throw Error('Unexpected ' + route);
  };
  return {
    $,
    nodes,
    document,
    template,
    workflows,
    calls,
    tokenizerRequests,
    api,
    node: (...args) => new Element(...args),
    set failSave(value) {
      failSave = value;
    },
  };
}
async function setup(t) {
  const f = fixture(),
    previous = globalThis.document;
  globalThis.document = f.document;
  t.after(() => {
    globalThis.document = previous;
  });
  f.ui = setupNativeWorkflows({ api: f.api, state: {}, node: f.node, notice() {} });
  await f.ui.refresh();
  return f;
}

test('private setup progress refreshes without overwriting unsaved settings or blocking the editor', async t => {
  const f = await setup(t);
  f.$('generation-review').checked = true;
  f.ui.updateRunner({ state: 'installing', progress: 'Installation des bibliothèques…' });
  assert.match(f.$('generation-status').textContent, /Préparation automatique.*bibliothèques/);
  assert.equal(f.$('generation-review').checked, true);
  f.ui.updateRunner({ state: 'ready' });
  assert.match(f.$('generation-status').textContent, /Prêt/);
  assert.equal(f.$('generation-review').checked, true);
  // No Python of one's own nor limit of generations a message in the settings any more.
  assert.equal(f.$('generation-python'), null);
  assert.equal(f.$('generation-iterations'), null);
  assert.equal(f.$('generation-tokenizer'), null, 'the tokenizer is chosen per workflow, not in settings');
});

test('invalid server save preserves editor and last valid workflow', async t => {
  const f = await setup(t);
  await f.ui.edit(f.template);
  f.$('native-workflow-description').value = 'Incompatible edit';
  f.failSave = true;
  assert.equal(await f.ui.saveEditor(), false);
  assert.equal(f.ui.isEditing(), true);
  assert.equal(f.workflows[0].description, 'Portraits in studio');
  assert.match(f.$('native-workflow-error').textContent, /incompatible/);
  assert.equal(f.$('native-workflow-description').value, 'Incompatible edit');
});

test('settings read native generation values and descriptions come from workflow records', async t => {
  const f = await setup(t);
  assert.deepEqual(f.ui.values(), {
    enabled: true,
    autoAllow: false,
    autoAllowVideos: true,
    confirmReplacements: false,
    reviewImages: false,
    reviewVideos: false,
    warmEngine: true,
    pythonPath: '',
    modelsDir: '',
    modelRoot: '',
    vaeRoot: '',
    loraRoot: '',
    textEncoderRoot: '',
    tokenizerRoot: '',
    upscaleRoot: '',
    latentUpscaleRoot: '',
  });
  assert.equal(
    f.calls.some(call => call.route === 'comfy'),
    false,
  );
  assert.deepEqual(f.ui.workflowDescriptions(), []);
});

test('an unchanged native prompt policy remains valid against the shared catalog contract', async t => {
  const { validateNativeWorkflow } = await import('../lib/native-workflows.mjs');
  const f = await setup(t);
  await f.ui.edit(f.template);
  await f.ui.saveEditor();
  const saved = f.calls.find(call => call.route === 'generation/workflows').body;
  assert.doesNotThrow(() => validateNativeWorkflow(saved));
});

test('shipped pipeline templates round-trip through the editor without corrupting their policy contract', async t => {
  const { validateNativeWorkflow } = await import('../lib/native-workflows.mjs'),
    { families, familyTemplate } = await import('../lib/families.mjs');
  for (const manifest of Object.values(families())) {
    const f = await setup(t),
      record = familyTemplate(manifest);
    await f.ui.edit(record);
    assert.equal(await f.ui.saveEditor(), true);
    assert.doesNotThrow(() => validateNativeWorkflow(f.calls.find(call => call.route === 'generation/workflows').body));
  }
});

test('closing settings cancels native refresh without surfacing an obsolete error', async t => {
  const f = await setup(t);
  const ui = setupNativeWorkflows({
    state: {},
    node: f.node,
    notice() {},
    api: async (route, body, { signal } = {}) => {
      if (route === 'generation')
        await new Promise((resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      return f.api(route, body);
    },
  });
  const pending = ui.refresh();
  ui.cancelSettings();
  await assert.doesNotReject(pending);
});

test('every static control used during settings initialization exists in the shipped HTML', async t => {
  const f = await setup(t);
  assert.ok(f.ui);
  assert.match(html, /data-settings-section="Génération"/);
  assert.match(html, /class="settings-block workflow-settings models-page" data-settings-section="Modèles"/);
  // (0.6.119) The page « Modèles »: its tab, no word of help, the buttons of before never shown,
  // and at its foot « Fichiers »: the folder of the models and the token.
  assert.match(html, /<span class="settings-tab-label">Modèles<\/span>/);
  assert.doesNotMatch(html, /<span class="settings-tab-label">Workflows<\/span>|<h2 class="settings-panel-title">Workflows<\/h2>/);
  const page = html.slice(html.indexOf('id="settings-panel-workflows"'), html.indexOf('id="settings-panel-interface"'));
  assert.doesNotMatch(page, /help-tip|ComfyUI n’est pas|Enregistrer le jeton/);
  assert.match(page, /data-settings-section="Fichiers"><h3>Fichiers<\/h3>/);
  assert.match(page, /<label for="generation-models-dir">Dossier des modèles<\/label>.*<button id="generation-models-dir-browse"[^>]*>Changer<\/button>/);
  assert.match(page, /<label for="hf-token">Jeton Hugging Face<\/label>.*<button id="hf-token-remove"[^>]*>Retirer<\/button>/);
  assert.match(html, /<symbol id="i-sliders"/);
  assert.doesNotMatch(
    html,
    /Importer un JSON natif|Convertir Krea avec sauvegarde|Format d’origine|Seuls ces deux formats/,
  );
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(html.includes('native-comfy-file'), false);
});

test('Krea 2 is created by Atelier’s engine: its tokenizer is asked for, and proposed from the encoder', async t => {
  const f = await setup(t),
    record = structuredClone(f.template);
  delete record.components.tokenizer;
  await f.ui.edit(record);
  await new Promise(resolve => setImmediate(resolve));
  const ids = element => [element.id, ...element.children.flatMap(ids)].filter(Boolean);
  assert.ok(ids(f.$('native-workflow-components')).includes('native-component-textEncoder'));
  assert.ok(ids(f.$('native-workflow-components')).includes('native-component-tokenizer'));
  // The one that matches the encoder is asked of the server, and taken.
  assert.deepEqual(f.tokenizerRequests, [{ encoder: 'encoder-one', family: 'krea2' }]);
  assert.equal(await f.ui.saveEditor(), true);
  assert.deepEqual(f.workflows.at(-1).components.tokenizer, { policy: 'fixed', asset: 'tokenizer-one' });
});

test('the page « Modèles »: one line a model in its group, the version it uses, its versions under the chevron (0.6.119)', async t => {
  const f = await setup(t);
  const under = root => [root, ...root.children.flatMap(child => under(child))],
    find = (root, name) => under(root).filter(item => String(item.className).split(' ').includes(name)),
    list = () => f.$('workflow-list'),
    lineOf = name => find(list(), 'model-line').find(line => line.dataset.model === name),
    text = (root, name) => find(root, name).map(item => item.textContent);
  // With nothing said of the models (a server of before, the editor's own tests): a line a workflow.
  assert.deepEqual(list().children.map(item => item.className), ['model-group']);
  assert.deepEqual([text(list(), 'model-group-title'), text(list(), 'model-name')], [['Image'], ['Portrait']]);
  assert.equal(f.nodes.get('comfy-url'), undefined);
  const made = (id, name, pipeline, mediaType, more = {}) => ({ ...structuredClone(f.template), id, name, pipeline, mediaType, builtin: true, enabled: true, ready: true, ...more });
  f.workflows.push(
    made('ltx', 'LTX 2.5', 'ltx25', 'video'),
    made('moss-image', 'MOSS Image', 'moss', 'image', { ready: false, unavailableReason: 'ComfyUI n’est pas lancé.' }),
    made('esr-video', 'Upscale vidéo', 'realesrgan_video', 'video', { customized: true }),
    made('esr-image', 'Upscale rapide', 'realesrgan_image', 'image'),
    made('amd', 'SeedVR2', 'seedvr2', 'image', { ready: false, unavailableReason: 'Carte NVIDIA requise.', unavailableKind: 'hardware' }),
  );
  const version = (name, file, more = {}) => ({ path: 'D:\\models\\' + file, file, name, format: 'INT8', how: 'direct', bytes: 1, source: 'found', used: false, ...more });
  let used = 'ltx-distilled.safetensors';
  const versions = () =>
    [
      version('Distillé', 'ltx-distilled.safetensors', { source: 'provided' }),
      version('Uncensored v1.1', 'ltx25_uncensored.safetensors', { parameters: { steps: 8 } }),
      version('Cinema', 'cinema-Q8_0.gguf', { format: 'GGUF Q8', how: 'convert' }),
      version('Essai', 'essai-w4a8.safetensors', { format: 'W4A8', how: 'refused', reason: 'W4A8' }),
    ]
      .map(item => ({ ...item, used: item.file === used }))
      .sort((a, b) => Number(b.used) - Number(a.used));
  const models = () => [
    { name: 'MOSS Image', does: 'Affiches, mises en page, texte dans l’image.', group: 'image', order: 2, workflows: [{ id: 'moss-image', family: 'moss', version: 'SFT' }] },
    { name: 'LTX 2.5', does: 'Vidéos et prolongations.', group: 'video', order: 1, workflows: [{ id: 'ltx', family: 'ltx25', provided: 'ltx-distilled.safetensors', used: 'D:\\models\\' + used, versions: versions() }] },
    { name: 'SeedVR2', does: 'Agrandir et affiner une image.', group: 'retouch', order: 1, workflows: [{ id: 'amd', family: 'seedvr2', versions: [] }] },
    { name: 'Real-ESRGAN', does: 'Agrandir une image ou une vidéo.', group: 'retouch', order: 2, workflows: [{ id: 'esr-image', family: 'realesrgan_image', version: '×4 Plus' }, { id: 'esr-video', family: 'realesrgan_video', version: '×2 Plus' }] },
  ];
  const api = f.api;
  f.api = async (route, body) => {
    if (route === 'generation' || route === 'generation/models/version' || route === 'generation/reset') {
      if (route !== 'generation') f.calls.push({ route, body: structuredClone(body) });
      if (route === 'generation/models/version') used = body.path.split('\\').at(-1);
      return Response.json({ ...(await (await api('generation')).json()), models: models() });
    }
    return api(route, body);
  };
  f.ui = setupNativeWorkflows({ api: (...args) => f.api(...args), state: {}, node: f.node, notice() {} });
  await f.ui.refresh();
  // The groups in the order of the page, a line a model; a workflow that is no model of the page is no line.
  assert.deepEqual(text(list(), 'model-group-title'), ['Image', 'Vidéo', 'Retouches']);
  assert.deepEqual(text(list(), 'model-name'), ['MOSS Image', 'LTX 2.5', 'SeedVR2', 'Real-ESRGAN']);
  // No dot of state, no bubble of help, nothing of ComfyUI, no pencil nor bin.
  for (const gone of ['workflow-state', 'help-tip', 'workflow-comfy', 'workflow-comfy-start', 'native-edit', 'native-remove', 'workflow-card'])
    assert.deepEqual(find(list(), gone), [], gone);
  assert.equal(under(list()).some(item => item.textContent === 'Démarrer'), false);
  // A line: its name, what it does, the version used in mono, « Réglages », the chevron.
  const ltx = lineOf('LTX 2.5');
  assert.deepEqual([ltx.dataset.state, ltx.dataset.open], ['ready', undefined]);
  assert.deepEqual(ltx.children.map(item => item.className), ['model-row']);
  assert.deepEqual(ltx.children[0].children.map(item => item.className), ['model-name', 'model-about', 'model-side', 'model-settings', 'model-chevron']);
  assert.deepEqual([text(ltx, 'model-does'), text(ltx, 'model-version'), text(ltx, 'model-note')], [['Vidéos et prolongations.'], ['Distillé · INT8'], []]);
  const [settings] = find(ltx, 'model-settings'),
    [chevron] = find(ltx, 'model-chevron');
  assert.deepEqual([settings.attributes['aria-label'], settings.title], ['Réglages de LTX 2.5', 'Réglages de LTX 2.5']);
  assert.deepEqual([chevron.attributes['aria-label'], chevron.attributes['aria-expanded']], ['Versions de LTX 2.5', 'false']);
  // What is in the way of a model is said under its description, the name of its version staying.
  const moss = lineOf('MOSS Image');
  assert.deepEqual([moss.dataset.state, text(moss, 'model-note'), text(moss, 'model-version')], ['waiting', ['ComfyUI n’est pas lancé.'], ['SFT']]);
  assert.equal(find(moss, 'model-note')[0].className, 'model-note');
  assert.deepEqual([lineOf('SeedVR2').dataset.state, find(lineOf('SeedVR2'), 'model-note')[0].className], ['unavailable', 'model-note is-warning']);
  // A model in two workflows is one line, named by the version of its first.
  assert.deepEqual(text(lineOf('Real-ESRGAN'), 'model-version'), ['×4 Plus']);

  // The chevron unfolds its versions: the one used first, the others by what the model makes of them.
  chevron.onclick();
  const rows = () => find(lineOf('LTX 2.5'), 'model-version-row');
  assert.deepEqual([lineOf('LTX 2.5').dataset.open, find(lineOf('LTX 2.5'), 'model-chevron')[0].attributes['aria-expanded']], ['true', 'true']);
  assert.deepEqual(
    rows().map(row => [row.tagName, ...row.children.map(item => item.textContent)]),
    [
      ['DIV', 'Distillé', 'INT8', 'Utilisée'],
      ['BUTTON', 'Uncensored v1.1', 'INT8 · 8 étapes'],
      ['DIV', 'Cinema', 'GGUF Q8', 'À convertir'],
      ['DIV', 'Essai', 'W4A8', 'Non lu'],
    ],
  );
  assert.deepEqual(rows().map(row => [row.dataset.used, row.dataset.unavailable, row.dataset.source]), [['true', undefined, 'provided'], [undefined, undefined, 'found'], [undefined, 'true', 'found'], [undefined, 'true', 'found']]);
  // The name of its file under the pointer; why it cannot serve, for one that cannot.
  assert.deepEqual(rows().map(row => row.title), [
    'ltx-distilled.safetensors',
    'ltx25_uncensored.safetensors',
    'cinema-Q8_0.gguf : un GGUF se convertit avant de servir.',
    'essai-w4a8.safetensors : format W4A8, que ce modèle ne lit pas.',
  ]);
  // A click keeps another version: asked of the server, and the page is drawn with its answer, still unfolded.
  await rows()[1].onclick();
  assert.deepEqual(f.calls.filter(call => call.route === 'generation/models/version').map(call => call.body), [{ workflowId: 'ltx', path: 'D:\\models\\ltx25_uncensored.safetensors' }]);
  assert.deepEqual(rows().slice(0, 2).map(row => [row.tagName, row.children[0].textContent, row.dataset.used]), [['DIV', 'Uncensored v1.1', 'true'], ['BUTTON', 'Distillé', undefined]]);
  assert.deepEqual(text(lineOf('LTX 2.5'), 'model-version'), ['Uncensored v1.1 · INT8']);
  assert.equal(f.ui.takeChanges?.() ?? true, true);
  // Folded again by the chevron.
  find(lineOf('LTX 2.5'), 'model-chevron')[0].onclick();
  assert.deepEqual([lineOf('LTX 2.5').dataset.open, rows()], [undefined, []]);

  // A model in two workflows: a row each, with what it makes and its own « Réglages »; one whose
  // settings the user changed can be set back to those of Moodix.
  find(lineOf('Real-ESRGAN'), 'model-chevron')[0].onclick();
  const two = find(lineOf('Real-ESRGAN'), 'model-version-row');
  assert.deepEqual(two.map(row => row.children.slice(0, 3).map(item => item.textContent)), [['×4 Plus', 'Images', 'Utilisée'], ['×2 Plus', 'Vidéos', 'Utilisée']]);
  // Each carries its own « Réglages » at its end, and says so: its row has a column for it (0.6.125:
  // without one the button fell under the name, over the next row).
  assert.deepEqual(two.map(row => [row.children.length, row.className, row.children[3].className]), [[4, 'model-version-row has-settings', 'model-settings'], [4, 'model-version-row has-settings', 'model-settings']]);
  assert.equal(find(lineOf('LTX 2.5'), 'model-version-row').some(row => row.className.includes('has-settings')), false);
  assert.deepEqual(two.map(row => find(row, 'model-settings')[0].attributes['aria-label']), ['Réglages de Real-ESRGAN · Images', 'Réglages de Real-ESRGAN · Vidéos']);
  const [reset] = find(lineOf('Real-ESRGAN'), 'model-reset');
  assert.equal(reset.textContent, 'Rétablir les réglages de Moodix');
  await reset.onclick();
  assert.deepEqual(f.calls.filter(call => call.route === 'generation/reset').map(call => call.body), [{ id: 'esr-video' }]);
  // A model with none of its files here: the version Moodix ships is named, greyed.
  find(lineOf('SeedVR2'), 'model-chevron')[0].onclick();
  const [none] = find(lineOf('SeedVR2'), 'model-version-row');
  assert.deepEqual([none.children[0].textContent, none.dataset.unavailable], ['Version fournie avec Moodix', 'true']);
  // « Réglages » opens the page of details of the model, named after it.
  await find(lineOf('LTX 2.5'), 'model-settings')[0].onclick();
  assert.equal(f.$('workflow-editor').hidden, false);
  assert.equal(f.$('native-workflow-title').textContent, 'Réglages de LTX 2.5');
});

test('a model to download says « Télécharger » and its size in the place of its version; a licence with conditions is shown at the click, to accept or to refuse', async t => {
  // A download started is followed every second: the clock of the test never runs it.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await setup(t);
  const krea = {
      name: 'Krea 2 Community License Agreement v.1',
      url: 'https://huggingface.co/Comfy-Org/Krea-2/blob/main/LICENSE.pdf',
      limits:
        'Usage commercial du modèle et de ses sorties seulement sous 1 million de dollars de chiffre d’affaires annuel total.',
      restricted: true,
    },
    apache = { name: 'Apache-2.0', url: 'https://spdx.org/licenses/Apache-2.0.html', limits: '', restricted: false },
    giga = 1024 ** 3;
  const lacking = (id, name) => ({ ...structuredClone(f.template), id, name, builtin: true, enabled: true, ready: false });
  f.workflows.push(lacking('krea-two', 'Krea 2'), lacking('seedvr', 'Upscale SeedVR2'), lacking('gated', 'LTX 2.5'));
  const offer = (files, more = {}) => ({
    files,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
    left: files.reduce((sum, file) => sum + file.size, 0),
    complete: true,
    needsToken: false,
    page: '',
    ...more,
  });
  const offers = {
    'krea-two': offer([
      { role: 'textEncoder', file: 'qwen3vl_4b.safetensors', size: giga, license: apache },
      { role: 'model', file: 'krea2_turbo.safetensors', size: 3 * giga, license: krea },
    ]),
    seedvr: offer([{ role: 'model', file: 'seedvr2.safetensors', size: giga, license: apache }]),
    gated: offer([{ role: 'model', file: 'ltx.safetensors', size: 2 * giga, license: apache }], { needsToken: true, page: 'huggingface.co/Lightricks/LTX-2.5' }),
  };
  const api = f.api,
    starts = [],
    asked = [];
  let job = { state: 'idle' };
  f.api = async (route, body) => {
    if (route === 'generation') {
      const result = await (await api(route, body)).json();
      return Response.json({ ...result, downloads: { offers, job, hasToken: false } });
    }
    if (route === 'downloads/start') {
      starts.push(body);
      return Response.json((job = { state: 'running', workflowId: body.id, name: body.id, received: giga / 4, total: giga }));
    }
    if (route === 'downloads/cancel') {
      f.calls.push({ route, body });
      return Response.json((job = { state: 'idle' }));
    }
    return api(route, body);
  };
  const again = () =>
    (f.ui = setupNativeWorkflows({ api: (...args) => f.api(...args), state: {}, node: f.node, notice() {}, showTokenField: message => asked.push(message) }));
  again();
  await f.ui.refresh();
  const under = root => [root, ...root.children.flatMap(child => under(child))],
    find = (root, name) => under(root).filter(item => String(item.className).split(' ').includes(name)),
    lineOf = name => find(f.$('workflow-list'), 'model-line').find(line => line.dataset.model === name),
    download = name => find(lineOf(name), 'model-download')[0],
    confirm = name => find(lineOf(name), 'model-license')[0];

  // In the place of the version: « Télécharger » and what is left to fetch. No message, no list of files.
  assert.deepEqual([lineOf('Krea 2').dataset.state, find(lineOf('Krea 2'), 'model-version')], ['download', []]);
  assert.deepEqual(download('Krea 2').children.map(item => item.textContent).filter(Boolean), ['Télécharger · 4 Go']);
  assert.equal(download('Krea 2').attributes['aria-label'], 'Télécharger Krea 2 (4 Go)');
  assert.deepEqual([find(lineOf('Krea 2'), 'model-note'), find(lineOf('Krea 2'), 'license-block'), confirm('Krea 2')], [[], [], undefined]);
  // Its licences are under the pointer.
  assert.equal(download('Krea 2').title, 'Licences : Krea 2 Community License Agreement v.1 (à conditions) et Apache-2.0. En téléchargeant, vous les acceptez.');
  assert.equal(download('Upscale SeedVR2').title, 'Licence : Apache-2.0. En téléchargeant, vous l’acceptez.');

  // A licence with conditions: the click downloads nothing and shows it, to accept or to refuse.
  await download('Krea 2').onclick();
  assert.deepEqual(starts, []);
  const shown = confirm('Krea 2');
  assert.equal(find(shown, 'license-block')[0].attributes['data-confirm'], 'true');
  assert.deepEqual(find(shown, 'license-name').map(item => item.textContent), ['Krea 2 Community License Agreement v.1']);
  assert.deepEqual(shown.children.at(-1).children.map(item => item.textContent), ['Refuser', 'Accepter et télécharger']);
  assert.equal(shown.children.at(-1).children[1].focused, true);
  assert.equal(confirm('Upscale SeedVR2'), undefined, 'the other models are as they were');
  // Refused: nothing is downloaded, the line is as before.
  await shown.children.at(-1).children[0].onclick();
  assert.deepEqual([starts, confirm('Krea 2'), download('Krea 2').children.at(-1).textContent], [[], undefined, 'Télécharger · 4 Go']);
  // Accepted: the request says so, and the line shows its advance in the place of nothing else.
  await download('Krea 2').onclick();
  await confirm('Krea 2').children.at(-1).children[1].onclick();
  assert.deepEqual(starts, [{ id: 'krea-two', accepted: true }]);
  const running = lineOf('Krea 2');
  assert.deepEqual([running.dataset.state, confirm('Krea 2'), find(running, 'model-download')], ['downloading', undefined, []]);
  // The description stays; under it a trait and what came; « Arrêter » in the place of the button.
  assert.deepEqual(find(running, 'model-does').map(item => item.textContent), ['Portraits in studio']);
  assert.equal(find(running, 'model-progress')[0].children[0].style.width, '25%');
  assert.deepEqual(find(running, 'model-progress-text').map(item => item.textContent), ['0,3 / 1 Go']);
  const [stop] = find(running, 'model-stop');
  assert.equal(stop.textContent, 'Arrêter');
  // One download at a time: the others wait, and say why.
  assert.deepEqual([download('Upscale SeedVR2').disabled, download('Upscale SeedVR2').title], [true, 'Un autre téléchargement est en cours.']);
  await stop.onclick();
  assert.deepEqual(f.calls.filter(call => call.route === 'downloads/cancel').length, 1);

  // Free licences alone: one click starts it, with no word of a confirmation.
  await f.ui.refresh();
  await download('Upscale SeedVR2').onclick();
  assert.deepEqual(starts.at(-1), { id: 'seedvr' });
  job = { state: 'idle' };
  // A model that asks for an account: the token is asked for, nothing starts.
  await f.ui.refresh();
  await download('LTX 2.5').onclick();
  assert.equal(starts.length, 2);
  assert.match(asked.at(-1), /^LTX 2\.5 demande un compte Hugging Face : acceptez la licence sur huggingface\.co\/Lightricks\/LTX-2\.5 /);
  // Closing the settings forgets a confirmation left half-way.
  await download('Krea 2').onclick();
  assert.ok(confirm('Krea 2'));
  f.ui.cancelSettings();
  await f.ui.refresh();
  assert.equal(confirm('Krea 2'), undefined);
});

test('an existing tokenizer is never replaced by a suggestion, and families without one show no tokenizer', async t => {
  const f = await setup(t);
  await f.ui.edit(f.template);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.tokenizerRequests, []);
  const video = structuredClone(f.template);
  video.pipeline = 'ltx25';
  video.mediaType = 'video';
  delete video.components.tokenizer;
  f.ui.cancelSettings();
  await f.ui.edit(video);
  await new Promise(resolve => setImmediate(resolve));
  const ids = element => [element.id, ...element.children.flatMap(ids)].filter(Boolean);
  assert.ok(ids(f.$('native-workflow-components')).includes('native-component-audioVae'));
  assert.ok(!ids(f.$('native-workflow-components')).includes('native-component-tokenizer'));
  assert.deepEqual(f.tokenizerRequests, []);
});

test('every shipped workflow comes out of the editor unchanged when saved untouched', async t => {
  const { readdir, readFile } = await import('node:fs/promises');
  const folder = new URL('../runner/workflows/', import.meta.url);
  for (const name of (await readdir(folder)).filter(name => name.endsWith('.json'))) {
    const stored = JSON.parse(await readFile(new URL(name, folder), 'utf8'));
    const f = await setup(t);
    await f.ui.edit(structuredClone(stored));
    assert.equal(f.ui.editorDirty(), false, name + ' is dirty right after opening');
    assert.equal(await f.ui.saveEditor(), true, name + ': ' + f.$('native-workflow-error').textContent);
    const saved = f.calls.findLast(call => call.route === 'generation/workflows').body;
    // The file name is added on save; an empty reference description is the same as none.
    const strip = value =>
      JSON.parse(
        JSON.stringify(value, (key, item) =>
          key === 'file' || (key === 'description' && item === '') ? undefined : item,
        ),
      );
    const diff = (a, b, path = '') => {
      if (JSON.stringify(a) === JSON.stringify(b)) return [];
      if (a && b && typeof a === 'object' && typeof b === 'object')
        return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(k => diff(a[k], b[k], path + '.' + k));
      return [path + ': ' + JSON.stringify(b) + ' -> ' + JSON.stringify(a)];
    };
    assert.deepEqual(diff(strip(saved), strip(stored)), [], name);
  }
});

// ------------------------------------------------------------------ The page of a model (0.6.128)
// Maquette v2 du 19/11 : « Proposé à Moodix AI » en tête, une ligne par fichier, une ligne par réglage.
// A setting is the user's alone, never Moodix AI's: no « Fixe / Assistant », no bounds to type. What is
// part of a request (the prompt, the size, the length, the denoise of an image to modify) has no line.
const shippedWorkflow = async pipeline => {
  const { readdir, readFile } = await import('node:fs/promises');
  const folder = new URL('../runner/workflows/', import.meta.url);
  for (const name of (await readdir(folder)).filter(name => name.endsWith('.json'))) {
    const workflow = JSON.parse(await readFile(new URL(name, folder), 'utf8'));
    if (workflow.pipeline === pipeline) return workflow;
  }
};
const under = node => [node, ...(node.children ?? []).flatMap(under)];
/** The lines of a block of the page, by the name each begins with. */
const linesOf = (f, id) => f.$(id).children.filter(child => String(child.className).startsWith('set-line'));
const namesOf = (f, id) => linesOf(f, id).map(line => line.children[0].textContent);
/** What the user types in a field, or picks in a list: the page hears it. */
const typed = (control, value) => {
  control.value = value;
  for (const listener of control.listeners.input ?? []) listener();
};
const ticked = (control, value) => {
  control.checked = value;
  control.onchange?.();
  for (const listener of control.listeners.change ?? []) listener();
};
const lastSave = f => f.calls.findLast(call => call.route === 'generation/workflows').body;

test('the page of a model opens on « Proposé à Moodix AI »: what it is offered for, what Moodix AI then chooses, what it is told', async t => {
  const f = await setup(t);
  assert.equal(await f.ui.edit({ ...structuredClone(f.template), enabled: true }, { name: 'Krea 2' }), true);
  assert.equal(f.$('settings-form').hidden, true);
  assert.equal(f.$('workflow-editor').hidden, false);
  assert.equal(f.$('native-workflow-title').textContent, 'Réglages de Krea 2');
  assert.match(html, /<label class="model-hero-title" for="native-workflow-enabled">Proposé à Moodix AI<\/label>/);
  assert.match(html, /<p class="model-hero-text is-second">Désactivé, le modèle reste à vous dans le Studio\.<\/p>/);
  assert.equal(f.$('native-workflow-offer').textContent, 'Moodix AI peut choisir Krea 2 quand vous lui demandez une image.');
  // This one fixes its size: Moodix AI only writes its prompt.
  assert.equal(f.$('native-workflow-chosen').textContent, 'Il écrit le prompt ; les réglages plus bas restent les vôtres.');
  assert.equal(f.$('native-workflow-chosen').hidden, false);
  // On: its frame is lit; off, it goes out, and the model is no longer offered.
  assert.equal(f.$('native-workflow-enabled').checked, true);
  assert.equal(f.$('native-workflow-hero').dataset.off, 'false');
  ticked(f.$('native-workflow-enabled'), false);
  assert.equal(f.$('native-workflow-hero').dataset.off, 'true');
  // « Il le choisit pour » : what Moodix AI knows of the model, written in place.
  assert.match(html, /<label class="model-group-title" for="native-workflow-description">Il le choisit pour<\/label>/);
  f.$('native-workflow-description').value = 'Portraits en lumière douce';
  assert.equal(await f.ui.saveEditor(), true);
  assert.equal(f.$('settings-form').hidden, false);
  assert.deepEqual([lastSave(f).enabled, lastSave(f).description, lastSave(f).name], [false, 'Portraits en lumière douce', 'Portrait']);
  await f.ui.edit(f.workflows[0]);
  assert.equal(f.$('native-workflow-description').value, 'Portraits en lumière douce');
  // Without a word of what it is for, nothing is saved: Moodix AI would choose it blind.
  f.$('native-workflow-description').value = '  ';
  assert.equal(await f.ui.saveEditor(), false);
  assert.match(f.$('native-workflow-error').textContent, /pour quoi Moodix AI choisit ce modèle/);
});

test('what Moodix AI chooses of a request is said model by model, as its workflow leaves it: the size, the length, the denoise', async t => {
  // (19/11: « le débruitage, la résolution, le temps doivent encore être choisis par Moodix ».)
  const said = async (pipeline, name) => {
    const f = await setup(t);
    assert.equal(await f.ui.edit(await shippedWorkflow(pipeline), { name }), true);
    return [f.$('native-workflow-title').textContent, f.$('native-workflow-offer').textContent, f.$('native-workflow-chosen').textContent];
  };
  const kept = ' ; les réglages plus bas restent les vôtres.';
  assert.deepEqual(await said('krea2', 'Krea 2'), [
    'Réglages de Krea 2',
    'Moodix AI peut choisir Krea 2 quand vous lui demandez une image.',
    'Il écrit le prompt et choisit la taille et le débruitage' + kept,
  ]);
  assert.deepEqual(await said('moss', 'MOSS Image'), [
    'Réglages de MOSS Image',
    'Moodix AI peut choisir MOSS Image quand vous lui demandez une image.',
    'Il écrit le prompt et choisit la taille' + kept,
  ]);
  assert.deepEqual(await said('ltx25', 'LTX 2.5'), [
    'Réglages de LTX 2.5',
    'Moodix AI peut choisir LTX 2.5 quand vous lui demandez une vidéo.',
    'Il écrit le prompt et choisit le format, la durée et la version (brouillon ou finale)' + kept,
  ]);
  // (« d’ » before a vowel.)
  assert.deepEqual(await said('acestep15', 'ACE-Step 1.5'), [
    'Réglages d’ACE-Step 1.5',
    'Moodix AI peut choisir ACE-Step 1.5 quand vous lui demandez un son.',
    'Il écrit le prompt et choisit la durée et les paroles' + kept,
  ]);
  assert.deepEqual(await said('rife', 'RIFE'), [
    'Réglages de RIFE',
    'Moodix AI peut choisir RIFE quand vous lui demandez de rendre une vidéo plus fluide.',
    'Il choisit la fluidité' + kept,
  ]);
  assert.deepEqual(await said('realesrgan_video', 'Real-ESRGAN · Vidéos'), [
    'Réglages de Real-ESRGAN · Vidéos',
    'Moodix AI peut choisir Real-ESRGAN · Vidéos quand vous lui demandez d’agrandir une vidéo.',
    'Il choisit l’agrandissement' + kept,
  ]);
  assert.deepEqual((await said('wan_scail2', 'Wan 2.1 SCAIL-2')).slice(1), [
    'Moodix AI peut choisir Wan 2.1 SCAIL-2 quand vous lui demandez de remplacer un personnage dans une vidéo.',
    'Il écrit le prompt et choisit qui remplacer' + kept,
  ]);
});

test('a setting is one line: its name, its value, its « ? »; neither « Fixe » nor « Assistant », no bounds; what is part of a request has no line and stays as written', async t => {
  const f = await setup(t),
    record = structuredClone(f.template),
    size = { policy: 'model', type: 'integer', default: 512, min: 256, max: 1024 };
  record.parameters.width = size;
  record.parameters.height = size;
  await f.ui.edit(record);
  assert.deepEqual(namesOf(f, 'native-workflow-parameters'), ['Étapes', 'Améliorer le prompt avant chaque image']);
  assert.equal(f.$('native-workflow-empty').hidden, true);
  for (const id of [
    'native-policy-steps',
    'native-min-steps',
    'native-max-steps',
    'native-use-default-steps',
    'native-description-steps',
    'native-policy-width',
    'native-value-width',
    'native-value-seed',
    'native-policy-seed',
    'native-value-prompt',
    'native-workflow-name',
    'native-workflow-pipeline',
  ])
    assert.equal(f.$(id), null, id);
  const steps = f.$('native-value-steps'),
    line = steps.parent.parent;
  assert.deepEqual([steps.tagName, steps.type, steps.value, steps.attributes['aria-label']], ['INPUT', 'number', 8, 'Étapes']);
  assert.deepEqual(
    line.children.map(child => [child.tagName, child.className]),
    [['LABEL', 'set-name'], ['DIV', 'set-side'], ['SPAN', 'help-tip set-help']],
  );
  assert.equal(line.children[0].attributes.for, 'native-value-steps');
  // Its « ? »: what it does, under the pointer and on the focus (help-tips.mjs).
  const help = line.children[2];
  assert.equal(help.dataset.help, 'Nombre de passes de calcul. Plus il y en a, plus la création est longue.');
  assert.equal(help.attributes['aria-label'], 'Aide : ' + help.dataset.help);
  // What is no value is refused in the user's words, and nothing is sent.
  typed(steps, '');
  assert.equal(await f.ui.saveEditor(), false);
  assert.equal(f.$('native-workflow-error').textContent, 'Étapes : ajoutez une valeur.');
  typed(steps, '8.5');
  assert.equal(await f.ui.saveEditor(), false);
  assert.equal(f.$('native-workflow-error').textContent, 'Étapes : un nombre entier.');
  assert.equal(
    f.calls.some(call => call.route === 'generation/workflows'),
    false,
  );
  // Changed: kept « Fixe » at the user's value (which holds Moodix AI, never the user).
  typed(steps, '12');
  assert.equal(f.ui.editorDirty(), true);
  assert.equal(await f.ui.saveEditor(), true, f.$('native-workflow-error').textContent);
  const saved = lastSave(f);
  assert.deepEqual(saved.parameters.steps, { policy: 'fixed', value: 12 });
  // The size, the seed, the prompt: the request's, as the workflow wrote them.
  assert.deepEqual(
    [saved.parameters.width, saved.parameters.height, saved.parameters.seed, saved.parameters.prompt],
    [size, size, f.template.parameters.seed, f.template.parameters.prompt],
  );
  assert.doesNotThrow(() => validateNativeWorkflow(saved));
  // Not a word of « Fixe », « Assistant » nor of bounds in what draws the page.
  const page = readFileSync(new URL('../public/native-workflow-ui.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /'Assistant'|'Aléatoire'|native-policy-switch|Minimum|Maximum|Préférer une valeur par défaut/);
});

test('a setting a workflow of before left to the assistant is shown at its default and saved « Fixe », within the bounds it had', async t => {
  const f = await setup(t),
    record = structuredClone(f.template);
  record.parameters.steps = { policy: 'model', type: 'integer', default: 10, min: 4, max: 12, description: 'More steps.' };
  await f.ui.edit(record);
  assert.equal(f.$('native-value-steps').value, 10);
  assert.equal(f.ui.editorDirty(), false);
  assert.equal(await f.ui.saveEditor(), true);
  // Its bounds are those of the Studio for one creation: they stay with a value within them…
  assert.deepEqual(lastSave(f).parameters.steps, { policy: 'fixed', value: 10, min: 4, max: 12 });
  await f.ui.edit(structuredClone(lastSave(f)));
  typed(f.$('native-value-steps'), '6');
  assert.equal(await f.ui.saveEditor(), true);
  assert.deepEqual(lastSave(f).parameters.steps, { policy: 'fixed', value: 6, min: 4, max: 12 });
  // …and go with a value beyond, which is then the user's whole choice.
  await f.ui.edit(structuredClone(lastSave(f)));
  typed(f.$('native-value-steps'), '20');
  assert.equal(await f.ui.saveEditor(), true);
  assert.deepEqual(lastSave(f).parameters.steps, { policy: 'fixed', value: 20 });
  // A value left as it was is written as it was stored, to the letter: what it holds beside its value too.
  const other = await setup(t),
    kept = structuredClone(other.template);
  kept.parameters.steps = { policy: 'fixed', value: 8, type: 'integer', description: 'Eight for this model.' };
  await other.ui.edit(kept);
  other.$('native-workflow-description').value = 'Autres portraits';
  assert.equal(await other.ui.saveEditor(), true);
  assert.deepEqual(lastSave(other).parameters.steps, kept.parameters.steps);
});

test('« Valeur de base »: what the user changed says the value of Moodix before it, takes it again at a click, and « Remettre les valeurs de base » takes them all', async t => {
  const f = await setup(t),
    record = {
      ...structuredClone(f.template),
      builtin: true,
      customized: true,
      ready: false,
      unavailableReason: 'Aucune carte NVIDIA.',
      unavailableKind: 'hardware',
      // What Moodix ships of it, as the list says it (NativeWorkflowCatalog.list).
      base: { description: 'Portraits in studio', parameters: structuredClone(f.template.parameters) },
    };
  record.parameters.steps = { policy: 'fixed', value: 12 };
  await f.ui.edit(record);
  const steps = f.$('native-value-steps'),
    side = steps.parent,
    back = side.children.find(child => child.className === 'set-base'),
    help = side.parent.children.at(-1),
    reset = f.$('native-workflow-reset');
  assert.equal(steps.value, 12);
  assert.deepEqual([back.hidden, back.children[1].textContent, side.dataset.changed], [false, 'Valeur de base : 8', 'true']);
  assert.match(help.dataset.help, / Valeur de base : 8\.$/);
  assert.deepEqual([reset.hidden, reset.disabled, reset.dataset.unavailable], [false, false, 'false']);
  // What is in its way is said under the sentence of the model.
  assert.deepEqual([f.$('native-workflow-capability').textContent, f.$('native-workflow-capability').hidden], ['Aucune carte NVIDIA.', false]);
  // At a click, the value of Moodix again: nothing left to take back.
  back.onclick();
  assert.deepEqual([steps.value, back.hidden, side.dataset.changed], [8, true, 'false']);
  assert.deepEqual([reset.disabled, reset.dataset.unavailable], [true, 'true']);
  // Changed again, then all at once from the foot.
  typed(steps, '20');
  assert.deepEqual([back.hidden, reset.disabled], [false, false]);
  reset.onclick();
  assert.deepEqual([steps.value, back.hidden, reset.disabled], [8, true, true]);
  // Nothing is saved before « Enregistrer »; what the list said of the workflow is never sent back.
  assert.equal(
    f.calls.some(call => call.route === 'generation/workflows'),
    false,
  );
  assert.equal(await f.ui.saveEditor(), true, f.$('native-workflow-error').textContent);
  const saved = lastSave(f);
  assert.deepEqual(saved.parameters.steps, { policy: 'fixed', value: 8 });
  for (const key of ['base', 'builtin', 'customized', 'ready', 'unavailableReason', 'unavailableKind', 'automatic', 'digest'])
    assert.equal(Object.hasOwn(saved, key), false, key);
  assert.doesNotThrow(() => validateNativeWorkflow(saved));

  // A model as Moodix ships it: its own values are the base. Nothing is said until one changes.
  const shipped = await setup(t);
  await shipped.ui.edit({ ...structuredClone(shipped.template), builtin: true });
  const own = shipped.$('native-value-steps'),
    again = own.parent.children.find(child => child.className === 'set-base');
  assert.deepEqual([again.hidden, shipped.$('native-workflow-reset').disabled], [true, true]);
  typed(own, '9');
  assert.deepEqual([again.hidden, again.children[1].textContent, shipped.$('native-workflow-reset').disabled], [false, 'Valeur de base : 8', false]);

  // A workflow Moodix does not ship has no value of Moodix to take again.
  const user = await setup(t);
  await user.ui.edit(structuredClone(user.template));
  assert.equal(user.$('native-workflow-reset').hidden, true);
  assert.equal(
    user.$('native-value-steps').parent.children.some(child => child.className === 'set-base'),
    false,
  );
});

test('a video model: the size of its draft and of its final on a line each, what both make the same on one line, a single value greyed and said why; the length has no line', async t => {
  const f = await setup(t),
    ltx = await shippedWorkflow('ltx25');
  await f.ui.edit({ ...structuredClone(ltx), builtin: true }, { name: 'LTX 2.5' });
  assert.deepEqual(namesOf(f, 'native-workflow-parameters'), [
    'Taille du brouillon',
    'Taille de la vidéo finale',
    'Étapes',
    'Images par seconde',
    'Audio',
    'Influence de l’image de début',
    'Influence de l’image de fin',
    'Compression des références (CRF)',
    'Influence des références MSR',
    'Durée latente des références MSR',
    'Images de chevauchement',
  ]);
  const size = stage => ['width', 'height'].map(key => f.$(`native-profile-${stage}-${key}`).value);
  assert.deepEqual([size('draft'), size('final')], [[288, 512], [896, 1600]]);
  // Eight steps, the only value a distilled model takes: greyed, with why in the place of its base.
  const steps = f.$('native-value-steps');
  assert.deepEqual([steps.value, steps.disabled, steps.dataset.unavailable], [8, true, 'true']);
  assert.equal(steps.parent.children.find(child => child.className === 'set-reason').textContent, 'Seule valeur que ce modèle accepte');
  assert.equal(steps.parent.parent.dataset.held, 'true');
  // A list of values is a list: the frames a continuation takes up.
  const overlap = f.$('native-value-overlap_frames');
  assert.deepEqual([overlap.tagName, overlap.children.map(option => option.value)], ['SELECT', ['1', '9', '17', '25', '33']]);
  // The sound: a switch.
  assert.deepEqual([f.$('native-value-audio').type, f.$('native-value-audio').checked], ['checkbox', true]);
  // The length, the version, the size and the seed of a request: no line.
  const shown = under(f.$('native-workflow-parameters')).map(node => node.id).filter(Boolean);
  for (const id of ['native-value-frames', 'native-value-stage', 'native-value-width', 'native-value-seed', 'native-profile-draft-frames', 'native-profile-final-steps', 'native-value-attention'])
    assert.equal(shown.includes(id), false, id);
  assert.equal(f.ui.editorDirty(), false);
  // The frames a second, the same in the draft and the final: one line, written into both.
  typed(f.$('native-value-fps'), '30');
  typed(f.$('native-profile-final-width'), '1024');
  const sizeBack = f.$('native-profile-final-width').parent.children.find(child => child.className === 'set-base');
  assert.deepEqual([sizeBack.hidden, sizeBack.children[1].textContent], [false, 'Valeur de base : 896 × 1600']);
  assert.equal(await f.ui.saveEditor(), true, f.$('native-workflow-error').textContent);
  const saved = lastSave(f);
  assert.deepEqual(saved.profiles, {
    draft: { parameters: { ...ltx.profiles.draft.parameters, fps: 30 } },
    final: { parameters: { ...ltx.profiles.final.parameters, fps: 30, width: 1024 } },
  });
  // What the versions replace stays as written; so does everything of a request.
  for (const name of ['fps', 'width', 'height', 'steps', 'frames', 'stage', 'seed', 'prompt'])
    assert.deepEqual(saved.parameters[name], ltx.parameters[name], name);
  assert.doesNotThrow(() => validateNativeWorkflow(saved));
  // The LoRA of the subject references: on by itself with them, a file of the model among its files.
  assert.deepEqual(namesOf(f, 'native-workflow-components').at(-1), 'LoRA des sujets de référence');
  assert.match(linesOf(f, 'native-workflow-components').at(-1).children.at(-3).dataset.help, /^Activé seul quand un sujet de référence est donné, jamais autrement\./);
  assert.deepEqual(saved.loras, ltx.loras);
  assert.equal(f.$('native-lora-note').textContent, 'Aucun LoRA ajouté.');

  // The draft and the final differ on it: a line each.
  const two = await setup(t),
    own = structuredClone(ltx);
  own.profiles.draft.parameters.fps = 12;
  await two.ui.edit(own);
  const names = namesOf(two, 'native-workflow-parameters');
  assert.deepEqual(
    names.filter(name => name.startsWith('Images par seconde')),
    ['Images par seconde · brouillon', 'Images par seconde · vidéo finale'],
  );
  assert.deepEqual([two.$('native-profile-draft-fps').value, two.$('native-profile-final-fps').value], [12, 24]);
  typed(two.$('native-profile-final-fps'), '25');
  assert.equal(await two.ui.saveEditor(), true);
  assert.deepEqual([lastSave(two).profiles.draft.parameters.fps, lastSave(two).profiles.final.parameters.fps], [12, 25]);
});

test('a text to write comes after the figures; a model without a setting says so', async t => {
  const f = await setup(t);
  await f.ui.edit(await shippedWorkflow('moss'), { name: 'MOSS Image' });
  // (0.6.129) Its shift is a setting like the others: it was a constant of the engine.
  assert.deepEqual(namesOf(f, 'native-workflow-parameters'), ['Étapes', 'Guidage', 'Décalage (shift)', 'Prompt négatif']);
  assert.deepEqual([f.$('native-value-steps').value, f.$('native-value-cfg').value, f.$('native-value-shift').value], [50, 3, 5]);
  assert.match(f.$('native-value-shift').parent.parent.children.at(-1).dataset.help, /^Répartit les étapes entre la composition/);
  const negative = f.$('native-value-negative_prompt');
  assert.deepEqual([negative.type, negative.value, negative.placeholder], ['text', '', 'aucun']);
  const none = await setup(t);
  await none.ui.edit(await shippedWorkflow('rife'), { name: 'RIFE' });
  assert.deepEqual(namesOf(none, 'native-workflow-parameters'), []);
  assert.equal(none.$('native-workflow-empty').hidden, false);
  assert.match(html, /<p id="native-workflow-empty" class="set-empty" hidden>Aucun réglage : tout se choisit à chaque création\.<\/p>/);
});

test('a file is one line: its name, the file, « Parcourir », « Détecter », « ? »; found by itself or standing in for one that is gone, it is named', async t => {
  const f = await setup(t),
    record = {
      ...structuredClone(f.template),
      // What the server found in the folders of the settings (NativeWorkflowCatalog.list).
      automatic: { textEncoder: 'qwen3vl_4b_int8_convrot.safetensors', vae: 'vae-du-dossier.safetensors' },
    };
  delete record.components.textEncoder;
  record.components.vae = { policy: 'fixed', asset: 'vae-gone' };
  await f.ui.edit(record);
  const field = role => f.$('native-component-' + role + '-file'),
    part = (role, at) => field(role).parent.children[at];
  assert.deepEqual(
    field('model').parent.children.slice(0, 5).map(child => [child.tagName, child.textContent || child.className]),
    [['LABEL', 'Modèle'], ['INPUT', ''], ['BUTTON', 'Parcourir'], ['BUTTON', 'Détecter'], ['SPAN', '?']],
  );
  assert.equal(field('model').parent.className, 'set-line set-file');
  // A file chosen: its name on the line, where it is in its « ? ».
  assert.equal(field('model').value, 'model.safetensors');
  assert.equal(part('model', 4).dataset.help, 'model.safetensors');
  assert.deepEqual([part('model', 3).disabled, part('model', 3).title], [false, 'Ne plus fixer ce fichier : prendre celui du dossier des modèles.']);
  // Chosen by nobody: the folder answers, and its file is named where a chosen one's would be.
  assert.deepEqual([field('textEncoder').value, field('textEncoder').placeholder, field('textEncoder').dataset.automatic], ['', 'qwen3vl_4b_int8_convrot.safetensors', 'true']);
  assert.equal(part('textEncoder', 4).dataset.help, 'Trouvé seul dans le dossier des modèles : qwen3vl_4b_int8_convrot.safetensors.');
  assert.deepEqual([part('textEncoder', 3).disabled, part('textEncoder', 3).title], [true, 'Déjà pris seul dans le dossier des modèles.']);
  // The one the workflow names is gone: the one found stands in for it, and is the one named
  // (until 0.6.127: « Ce fichier n’est plus à sa place : X le remplace », under the field).
  assert.equal(field('vae').value, 'vae-du-dossier.safetensors');
  assert.equal(part('vae', 4).dataset.help, 'Pris dans le dossier des modèles : vae-du-dossier.safetensors.');
  assert.doesNotMatch(readFileSync(new URL('../public/native-workflow-ui.mjs', import.meta.url), 'utf8'), /n’est plus à sa place : \$/);
  // Its tokenizer says what it is, then where.
  assert.match(part('tokenizer', 4).dataset.help, /^Dossier qui découpe le prompt en tokens.* C:\/comfy\/text_encoders\/qwen25_tokenizer$/);
  assert.equal(f.ui.editorDirty(), false);
  // « Détecter »: the file of the folder again, for a component that had one chosen here.
  part('model', 3).onclick();
  assert.deepEqual([f.$('native-component-model').value, field('model').dataset.automatic, part('model', 3).disabled], ['', 'true', true]);
  assert.equal(await f.ui.saveEditor(), true, f.$('native-workflow-error').textContent);
  const saved = lastSave(f);
  // Only what is chosen is fixed in the workflow; the rest is left to the folders.
  assert.deepEqual(saved.components, { tokenizer: f.template.components.tokenizer, vae: { policy: 'fixed', asset: 'vae-gone' } });
  assert.equal(saved.automatic, undefined, 'what the server found is not part of the workflow');
});

test('a model folder cannot be told from another: « Détecter » is greyed and says why; without it nothing is saved', async t => {
  const { families, familyTemplate } = await import('../lib/families.mjs');
  const f = await setup(t);
  await f.ui.edit({ ...familyTemplate(families().acestep15), name: 'Musique', description: 'Chansons', components: {} });
  const field = f.$('native-component-musicModel-file'),
    detect = field.parent.children[3];
  assert.match(field.placeholder, /^Choisir un dossier/);
  assert.deepEqual([detect.disabled, detect.dataset.unavailable], [true, 'true']);
  assert.equal(detect.title, 'Ce fichier ne se reconnaît pas seul : choisissez-le avec « Parcourir ».');
  assert.equal(await f.ui.saveEditor(), false);
  assert.match(f.$('native-workflow-error').textContent, /Choisissez un fichier pour « Modèle de musique/);
});

test('a file field takes a listed file or a pasted path, and never saves text it does not recognise', async t => {
  const f = await setup(t);
  await f.ui.edit(f.template);
  const field = f.$('native-component-model-file');
  assert.equal(field.value, 'model.safetensors');
  assert.equal(field.attributes.list, 'native-component-model-files');
  assert.deepEqual(
    f.$('native-component-model-files').children.map(option => [option.value, option.label]),
    [['model.safetensors', 'model.safetensors']],
  );
  // Focused, it empties so every file is suggested; left untouched, it shows the choice again.
  field.onfocus();
  assert.equal(field.value, '');
  field.onblur();
  assert.equal(field.value, 'model.safetensors');
  // A name that is not a file and not a path: reported, kept dirty, not saved.
  field.value = 'new-model';
  field.onchange();
  assert.match(f.$('native-workflow-error').textContent, /Aucun fichier « new-model »/);
  assert.equal(f.ui.editorDirty(), true);
  assert.equal(await f.ui.saveEditor(), false);
  assert.match(f.$('native-workflow-error').textContent, /Fichier non reconnu pour « Modèle »/);
  assert.equal(f.ui.isEditing(), true);
  // A pasted path is registered, and Save waits for it.
  field.value = 'C:/models/pasted.safetensors';
  field.onchange();
  assert.equal(await f.ui.saveEditor(), true);
  const registered = f.calls.find(call => call.route === 'generation/assets');
  assert.deepEqual(registered.body, { path: 'C:/models/pasted.safetensors', kind: 'model', family: 'krea2' });
  assert.equal(lastSave(f).components.model.asset, 'model-new');
  // The name of a listed file, typed: taken at once, without a path.
  const other = await setup(t),
    record = structuredClone(other.template);
  delete record.components.model;
  await other.ui.edit(record);
  const empty = other.$('native-component-model-file');
  assert.deepEqual([empty.value, empty.placeholder], ['', 'Choisir un fichier…']);
  empty.value = 'model.safetensors';
  empty.oninput();
  assert.equal(other.$('native-component-model').value, 'model-one');
  assert.equal(
    other.calls.some(call => call.route === 'generation/assets'),
    false,
  );
});

test('« Parcourir » opens where the file is, else in the folder of its kind, the one typed in the settings before « Enregistrer » included', async t => {
  const f = await setup(t);
  // The folder shown is the default one; only one the user types is kept.
  assert.equal(f.$('native-convert-root').value, 'C:/atelier/models/checkpoints');
  assert.equal(f.ui.values().modelRoot, '');
  await f.ui.edit(f.template);
  await f.$('native-component-model-file').parent.children[2].onclick();
  assert.deepEqual(f.calls.find(call => call.route === 'files/choose').body, { kind: 'generation', initialPath: 'model.safetensors' });
  // The file just registered is the one the model is made with at once.
  assert.equal(f.$('native-component-model').value, 'model-new');
  assert.equal(await f.ui.saveEditor(), true);
  assert.deepEqual(lastSave(f).components.model, { policy: 'fixed', asset: 'model-new' });
  assert.equal(f.calls.find(call => call.route === 'generation/assets').body.family, 'krea2');
  // No file yet: the folders of the settings, as they stand on the page.
  f.$('native-convert-root').value = 'D:/other checkpoints';
  f.$('generation-vae-root').value = 'D:/my VAE';
  f.$('generation-lora-root').value = 'D:/my LoRA';
  await f.ui.refresh({ settings: false });
  assert.deepEqual([f.ui.values().modelRoot, f.ui.values().vaeRoot, f.ui.values().loraRoot], ['D:/other checkpoints', 'D:/my VAE', 'D:/my LoRA']);
  const record = structuredClone(f.template);
  delete record.components.model;
  delete record.components.vae;
  await f.ui.edit(record);
  const asked = () => f.calls.filter(call => call.route === 'files/choose').at(-1).body.initialPath;
  await f.$('native-component-model-file').parent.children[2].onclick();
  assert.equal(asked(), 'D:/other checkpoints');
  await f.$('native-component-vae-file').parent.children[2].onclick();
  assert.equal(asked(), 'D:/my VAE');
  f.$('native-workflow-add-lora').onclick();
  await linesOf(f, 'native-workflow-loras')[0].children[1].onclick();
  assert.equal(asked(), 'D:/my LoRA');
  // The folders themselves are browsed from the settings.
  f.ui.cancelSettings();
  await f.$('generation-vae-root-browse').onclick();
  assert.deepEqual(f.calls.filter(call => call.route === 'files/choose').at(-1).body, { kind: 'directory', initialPath: 'D:/my VAE' });
  assert.equal(f.$('generation-vae-root').value, 'C:/models/new.safetensors');
});

test('a file the family can do without has its switch: off, it is not part of the model', async t => {
  const f = await setup(t),
    ltx = await shippedWorkflow('ltx25');
  await f.ui.edit(structuredClone(ltx));
  const active = f.$('native-component-upscaler-enabled'),
    line = f.$('native-component-upscaler-file').parent;
  assert.deepEqual([line.className, active.checked, active.attributes['aria-label']], ['set-line set-file is-optional', true, 'Utiliser Agrandisseur de latents ×2']);
  assert.equal(line.dataset.off, 'false');
  ticked(active, false);
  assert.deepEqual([line.dataset.off, f.$('native-component-upscaler-file').disabled], ['true', true]);
  assert.equal(await f.ui.saveEditor(), true, f.$('native-workflow-error').textContent);
  assert.equal(Object.hasOwn(lastSave(f).components, 'upscaler'), false);
  assert.deepEqual(Object.keys(lastSave(f).components), Object.keys(ltx.components).filter(role => role !== 'upscaler'));
});

test('a LoRA is one line: its file, its strength, when it is on; « Au choix de Moodix AI » asks what it brings, and its strength is never Moodix AI’s', async t => {
  const f = await setup(t),
    record = structuredClone(f.template),
    lora = {
      id: 'style',
      asset: 'lora-one',
      description: 'Soft light',
      enabled: { policy: 'model', default: true },
      strength: { policy: 'fixed', value: 0.55 },
    };
  record.loras = [lora];
  await f.ui.edit(record);
  const choice = f.$('native-lora-enabled-style'),
    strength = f.$('native-lora-strength-value-style'),
    told = f.$('native-lora-description-style').parent;
  assert.deepEqual(
    choice.children.map(option => [option.value, option.textContent]),
    [['fixed', 'Toujours actif'], ['model', 'Au choix de Moodix AI'], ['off', 'Désactivé']],
  );
  assert.deepEqual([choice.value, strength.value, told.hidden, f.$('native-lora-description-style').value], ['model', 0.55, false, 'Soft light']);
  assert.equal(f.$('native-lora-asset-style-file').value, 'lora.safetensors');
  for (const id of ['native-lora-strength-policy-style', 'native-lora-strength-min-style', 'native-lora-strength-max-style', 'native-lora-default-style'])
    assert.equal(f.$(id), null, id);
  // Saved untouched: as it was written.
  assert.equal(f.ui.editorDirty(), false);
  assert.equal(await f.ui.saveEditor(), true);
  assert.deepEqual(lastSave(f).loras, [lora]);
  // Off: what it brings is asked of nobody, its strength is greyed; a strength typed is the user's.
  await f.ui.edit(structuredClone(record));
  const off = f.$('native-lora-enabled-style');
  off.value = 'off';
  off.onchange();
  assert.deepEqual([f.$('native-lora-description-style').parent.hidden, f.$('native-lora-strength-value-style').disabled], [true, true]);
  typed(f.$('native-lora-strength-value-style'), '0.8');
  assert.equal(await f.ui.saveEditor(), true);
  assert.deepEqual([lastSave(f).loras[0].enabled, lastSave(f).loras[0].strength], [{ policy: 'off' }, { policy: 'fixed', value: 0.8 }]);
  // Always on; then given to Moodix AI again: off until it turns it on for a request it fits.
  await f.ui.edit(structuredClone(lastSave(f)));
  const always = f.$('native-lora-enabled-style');
  assert.equal(always.value, 'off');
  always.value = 'fixed';
  always.onchange();
  assert.equal(await f.ui.saveEditor(), true);
  assert.deepEqual(lastSave(f).loras[0].enabled, { policy: 'fixed', value: true });
  await f.ui.edit(structuredClone(lastSave(f)));
  f.$('native-lora-enabled-style').value = 'model';
  f.$('native-lora-enabled-style').onchange();
  assert.equal(await f.ui.saveEditor(), true);
  assert.deepEqual(lastSave(f).loras[0].enabled, { policy: 'model', default: false });
  assert.doesNotThrow(() => validateNativeWorkflow(lastSave(f)));
  // A strength a workflow of before left to the assistant: shown at its default, kept « Fixe ».
  const before = await setup(t),
    old = structuredClone(before.template);
  old.loras = [{ ...lora, enabled: { policy: 'fixed', value: true }, strength: { policy: 'model', type: 'number', min: 0, max: 1, default: 0.4 } }];
  await before.ui.edit(old);
  assert.equal(before.$('native-lora-strength-value-style').value, 0.4);
  assert.equal(await before.ui.saveEditor(), true);
  assert.deepEqual(lastSave(before).loras[0].strength, { policy: 'fixed', value: 0.4 });
});

test('a LoRA is added on and removed by its cross; a model that takes none says so, greyed', async t => {
  const f = await setup(t);
  await f.ui.edit(f.template, { name: 'Krea 2' });
  assert.deepEqual([f.$('native-lora-note').textContent, f.$('native-lora-note').hidden], ['Aucun LoRA ajouté.', false]);
  assert.equal(f.$('native-lora-section').dataset.off, 'false');
  f.$('native-workflow-add-lora').onclick();
  f.$('native-workflow-add-lora').onclick();
  assert.equal(linesOf(f, 'native-workflow-loras').filter(line => line.className.includes('set-lora')).length, 2);
  assert.equal(f.$('native-lora-note').hidden, true);
  const [first] = linesOf(f, 'native-workflow-loras');
  // Added to be used: on.
  assert.equal(first.children[3].value, 'fixed');
  assert.deepEqual([first.children[4].className, first.children[4].attributes['aria-label']], ['icon-button set-remove', 'Retirer ce LoRA']);
  // Without its file, nothing is saved.
  assert.equal(await f.ui.saveEditor(), false);
  assert.equal(f.$('native-workflow-error').textContent, 'Choisissez le fichier de chaque LoRA, ou retirez les lignes inutilisées.');
  first.children[4].onclick();
  linesOf(f, 'native-workflow-loras')[0].children[4].onclick();
  assert.deepEqual([f.$('native-workflow-loras').children.length, f.$('native-lora-note').hidden], [0, false]);
  assert.equal(await f.ui.saveEditor(), true, f.$('native-workflow-error').textContent);
  assert.deepEqual(lastSave(f).loras, []);
  // Real-ESRGAN takes none: greyed, and said.
  await f.ui.edit(await shippedWorkflow('realesrgan_image'), { name: 'Real-ESRGAN · Images' });
  assert.equal(f.$('native-workflow-add-lora').dataset.unavailable, 'true');
  assert.deepEqual([f.$('native-lora-note').textContent, f.$('native-lora-note').hidden], ['Real-ESRGAN · Images ne prend pas de LoRA.', false]);
  assert.equal(f.$('native-lora-section').dataset.off, 'true');
  f.$('native-workflow-add-lora').onclick();
  assert.equal(f.$('native-workflow-loras').children.length, 0, 'nothing added');
  f.ui.setBusy(false);
  assert.equal(f.$('native-workflow-add-lora').disabled, true, 'stays greyed after a busy spell');
});

test('« Améliorer le prompt » is one line with its switch, whose instruction is saved with the model', async t => {
  const f = await setup(t);
  await f.ui.edit(f.template);
  const toggle = f.$('native-enhance-switch'),
    instruction = f.$('native-enhance-template');
  assert.deepEqual([toggle.type, toggle.checked], ['checkbox', false]);
  assert.match(instruction.value, /\{\{prompt\}\}/, 'the family default instruction is proposed');
  assert.deepEqual([instruction.parent.className, instruction.parent.hidden], ['set-more', true], 'the instruction only shows when it is on');
  // Off in a workflow that never had the setting: nothing is added to it.
  assert.equal(f.ui.editorDirty(), false);
  ticked(toggle, true);
  assert.equal(instruction.parent.hidden, false);
  instruction.value = 'Describe {{prompt}} in rich detail.';
  assert.equal(await f.ui.saveEditor(), true);
  let saved = lastSave(f);
  assert.deepEqual(saved.parameters.expandPrompt, { policy: 'fixed', value: true });
  assert.equal(saved.promptExpansion.template, 'Describe {{prompt}} in rich detail.');
  assert.equal(
    saved.promptExpansion.maxTokens,
    familyCatalog().find(item => item.family === 'krea2').promptExpansionDefault.maxTokens,
  );
  assert.ok(validateNativeWorkflow(saved), 'what the page saves is a valid workflow');

  await f.ui.edit(saved);
  assert.equal(f.$('native-enhance-switch').checked, true);
  assert.equal(f.ui.editorDirty(), false);
  f.$('native-enhance-template').value = 'No placeholder';
  assert.equal(await f.ui.saveEditor(), false);
  assert.match(f.$('native-workflow-error').textContent, /\{\{prompt\}\} exactement une fois/);
  ticked(f.$('native-enhance-switch'), false);
  assert.equal(await f.ui.saveEditor(), true);
  saved = lastSave(f);
  assert.deepEqual(saved.parameters.expandPrompt, { policy: 'fixed', value: false });
  assert.equal(saved.promptExpansion.template, 'Describe {{prompt}} in rich detail.', 'turning it off keeps the saved instruction');
  // A family that has none: no such line.
  await f.ui.edit(await shippedWorkflow('ltx25'));
  assert.equal(
    under(f.$('native-workflow-parameters')).some(node => node.id === 'native-enhance-switch'),
    false,
  );
});

test('the prompt, the seed and the size are no lines: what a workflow holds of them is kept to the letter; a fixed prompt of before leaves with a change', async t => {
  const { workflowFingerprint } = await import('../lib/native-workflows.mjs');
  const f = await setup(t),
    record = structuredClone(f.template);
  record.parameters.prompt = { policy: 'model', type: 'string', maxLength: 4000, default: 'Un chat roux', description: 'Décris la scène en anglais.' };
  record.parameters.seed = { policy: 'model', type: 'integer', default: 3 };
  record.parameters.width = { policy: 'model', type: 'integer', default: 512, min: 256, max: 1024, description: 'Wider for a landscape.' };
  await f.ui.edit(record);
  f.$('native-workflow-description').value = 'Chats';
  assert.equal(await f.ui.saveEditor(), true, f.$('native-workflow-error').textContent);
  for (const name of ['prompt', 'seed', 'width', 'height']) assert.deepEqual(lastSave(f).parameters[name], record.parameters[name], name);
  // A prompt fixed in a workflow of before was refused at each creation (a locked setting cannot
  // be written). Saved untouched, the workflow is the one that was stored…
  const fixed = structuredClone(f.template);
  fixed.parameters.prompt = { policy: 'fixed', value: 'Un portrait' };
  await f.ui.edit(fixed);
  assert.equal(f.ui.editorDirty(), false);
  assert.equal(await f.ui.saveEditor(), true, f.$('native-workflow-error').textContent);
  const untouched = lastSave(f);
  assert.deepEqual(untouched.parameters.prompt, { policy: 'fixed', value: 'Un portrait' });
  // (nor is a setting it never had added to it: « Améliorer le prompt », off)
  assert.equal(untouched.parameters.expandPrompt, undefined);
  assert.equal(workflowFingerprint(untouched), workflowFingerprint(fixed));
  // …and with a change of the user's, the prompt is written at each creation from then on.
  await f.ui.edit(structuredClone(untouched));
  f.$('native-workflow-description').value = 'Portraits serrés';
  assert.equal(f.ui.editorDirty(), true);
  assert.equal(await f.ui.saveEditor(), true, f.$('native-workflow-error').textContent);
  assert.deepEqual(lastSave(f).parameters.prompt, { policy: 'model', type: 'string' });
});

test('Krea 2: its denoise is Moodix AI’s, no line; one a copy of before fixed at 1 with an image to modify is said to ignore it', async t => {
  const f = await setup(t),
    krea = await shippedWorkflow('krea2');
  await f.ui.edit(structuredClone(krea), { name: 'Krea 2' });
  assert.deepEqual(namesOf(f, 'native-workflow-parameters'), ['Étapes', 'Guidage', 'Améliorer le prompt avant chaque image']);
  assert.equal(
    under(f.$('native-workflow-parameters')).some(node => node.id === 'native-value-denoise'),
    false,
  );
  assert.equal(f.$('native-workflow-warning').hidden, true);
  // The only guidance a distilled model takes: greyed, and said.
  assert.equal(f.$('native-value-cfg').disabled, true);
  assert.equal(await f.ui.saveEditor(), true, f.$('native-workflow-error').textContent);
  assert.deepEqual(lastSave(f).parameters.denoise, krea.parameters.denoise);
  // A copy the user fixed at 1 (« Fixe », until 0.6.127): the image to modify would be ignored.
  const own = structuredClone(krea);
  own.parameters.denoise = { policy: 'fixed', value: 1 };
  await f.ui.edit(own, { name: 'Krea 2' });
  assert.equal(f.$('native-workflow-warning').hidden, false);
  assert.match(f.$('native-workflow-warning').textContent, /image à modifier est ignorée/);
  assert.equal(f.$('native-workflow-chosen').textContent, 'Il écrit le prompt et choisit la taille ; les réglages plus bas restent les vôtres.');
  assert.equal(await f.ui.saveEditor(), true);
  assert.deepEqual(lastSave(f).parameters.denoise, { policy: 'fixed', value: 1 }, 'theirs, kept as it is');
});

test('back with a change asks first, in the same panel, and gives the focus back where it was', async t => {
  const f = await setup(t);
  await f.ui.edit(f.template);
  f.$('native-workflow-description').value = 'Changed';
  f.ui.requestBack();
  assert.equal(f.ui.isEditing(), true);
  assert.equal(f.$('native-workflow-unsaved').hidden, false);
  assert.match(html, /<p>Enregistrer les modifications de ce modèle \?<\/p>/);
  f.$('native-workflow-keep').onclick();
  assert.equal(f.ui.isEditing(), true);
  f.ui.requestBack();
  f.$('native-workflow-discard').onclick();
  assert.equal(f.ui.isEditing(), false);
  assert.equal(f.document.activeElement.focused, true);
  assert.equal(f.workflows[0].description, 'Portraits in studio', 'nothing saved');
});

test('Échap in the page of a model is answered at the key: the question, then « Continuer à modifier », never the settings closed', async t => {
  const f = await setup(t);
  f.$('settings').open = true;
  await f.ui.edit(f.template);
  f.$('native-workflow-description').value = 'Portraits de nuit';
  const press = (extra = {}) => {
    const event = {
      key: 'Escape',
      defaultPrevented: false,
      stopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      },
      ...extra,
    };
    f.document.press(event);
    return event;
  };
  // A page may refuse a close request only once per user activation, and Échap is not one: pressed
  // twice, it closed the settings and the changes were lost. Prevented at the key, none is made.
  let event = press();
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.stopped, true, 'the guard of the settings does not hear it');
  assert.equal(f.$('native-workflow-unsaved').hidden, false);
  // Again, on the question: « Continuer à modifier »; the page stays, with what was typed.
  event = press();
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.$('native-workflow-unsaved').hidden, true);
  assert.equal(f.ui.isEditing(), true);
  assert.equal(f.$('native-workflow-description').value, 'Portraits de nuit');
  // Answered already (a list of glass closes on Échap), another key, another window over the
  // settings: not this page's.
  for (const extra of [{ defaultPrevented: true }, { key: 'Enter' }, { isComposing: true }, { target: { closest: () => ({}) } }]) {
    event = press(extra);
    assert.equal(event.stopped, false);
    assert.equal(f.$('native-workflow-unsaved').hidden, true);
    assert.equal(f.ui.isEditing(), true);
  }
  // Nothing changed: Échap leaves the page for the list, the settings stay open.
  f.$('native-workflow-description').value = f.template.description;
  event = press({ target: { closest: () => f.$('settings') } });
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.ui.isEditing(), false);
  assert.equal(f.$('workflow-editor').hidden, true);
  assert.equal(f.$('settings').open, true);
  // No model open: the key is the settings' (their guard answers it).
  event = press();
  assert.equal(event.defaultPrevented, false);
  assert.equal(event.stopped, false);
});

test('the page of a model in the shipped HTML: its head, its three groups, its foot, and not a word of « workflow »', () => {
  const page = html.slice(html.indexOf('<section id="workflow-editor"'), html.indexOf('<dialog id="project-dialog"'));
  assert.match(page, /<section id="native-workflow-hero" class="model-hero">/);
  assert.match(page, /<h3 class="model-group-title">Fichiers<\/h3><div id="native-workflow-components"><\/div>/);
  assert.match(page, /<h3 class="model-group-title">Réglages<\/h3><p id="native-workflow-warning" class="set-note is-warning" hidden><\/p><div id="native-workflow-parameters"><\/div>/);
  assert.match(page, /<h3 class="model-group-title">LoRA<\/h3><button id="native-workflow-add-lora" type="button" class="set-act set-add">/);
  assert.match(page, /<button id="native-workflow-reset" type="button" class="settings-reset"><svg aria-hidden="true"><use href="#i-undo"\/><\/svg>Remettre les valeurs de base<\/button><button id="native-workflow-save" type="button" class="primary">Enregistrer<\/button>/);
  // What the user reads there: a model, its files, its settings. Never « workflow », « assistant », « Fixe ».
  const read = page.replace(/<[^>]+>/g, ' ');
  assert.doesNotMatch(read, /workflow|assistant|Fixe\b|moteur/i);
  // Neither a workflow to create, to import nor to export; no name nor engine to give one.
  assert.doesNotMatch(
    html,
    /native-workflow-import|id="workflow-add"|native-workflow-file|native-workflow-export|native-workflow-name|native-workflow-pipeline|native-workflow-switch|native-policy-help|native-workflow-references|native-workflow-profiles|native-source-section|Importer un workflow|Créer un workflow|Exporter pour Moodix/,
  );
});
