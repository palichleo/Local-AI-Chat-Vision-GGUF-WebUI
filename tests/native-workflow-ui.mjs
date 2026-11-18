import test from 'node:test';
import { familyCatalog } from '../lib/families.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateNativeWorkflow } from '../lib/native-workflows.mjs';
import { previewWorkflowImport } from '../lib/workflow-import.mjs';
import { setupNativeWorkflows, parameterPolicies } from '../public/native-workflow-ui.mjs';
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
    activeElement: $('workflow-add'),
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
    if (route === 'generation/import')
      return Response.json(await previewWorkflowImport(body.sourceText, { name: body.name }));
    if (route === 'generation/validate') return Response.json({ workflow: validateNativeWorkflow(body) });
    if (route.startsWith('generation/templates')) {
      const pipeline = new URLSearchParams(route.split('?')[1]).get('pipeline');
      return Response.json({
        template: pipeline === 'ltx25' ? { ...template, pipeline: 'ltx25', mediaType: 'video' } : template,
      });
    }
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

test('only seed offers random ownership, and never the assistant (tests/workflow-options.mjs)', () => {
  assert.deepEqual(parameterPolicies('seed'), ['fixed', 'random']);
  assert.deepEqual(parameterPolicies('steps'), ['fixed', 'model']);
});

test('private setup progress refreshes without overwriting unsaved settings or blocking the editor', async t => {
  const f = await setup(t);
  f.$('generation-review').checked = true;
  f.ui.updateRunner({ state: 'installing', progress: 'Installation des bibliothèques…' });
  assert.match(f.$('generation-status').textContent, /Préparation automatique.*bibliothèques/);
  assert.equal(f.$('generation-review').checked, true);
  assert.equal(f.$('workflow-add').disabled, false);
  f.ui.updateRunner({ state: 'ready' });
  assert.match(f.$('generation-status').textContent, /Prêt/);
  assert.equal(f.$('generation-review').checked, true);
  // No Python of one's own nor limit of generations a message in the settings any more.
  assert.equal(f.$('generation-python'), null);
  assert.equal(f.$('generation-iterations'), null);
  assert.equal(f.$('generation-tokenizer'), null, 'the tokenizer is chosen per workflow, not in settings');
});
test('editor swaps the existing panel, saves native policies and reopens saved description', async t => {
  const f = await setup(t);
  await f.ui.edit(f.template);
  assert.equal(f.$('settings-form').hidden, true);
  assert.equal(f.$('workflow-editor').hidden, false);
  f.$('native-workflow-description').value = 'Soft studio portraits';
  f.$('native-policy-width').value = 'model';
  f.$('native-policy-width').onchange();
  f.$('native-min-width').value = '256';
  f.$('native-max-width').value = '1024';
  assert.equal(await f.ui.saveEditor(), true);
  assert.equal(f.$('settings-form').hidden, false);
  const saved = f.calls.find(call => call.route === 'generation/workflows');
  assert.equal(saved.body.description, 'Soft studio portraits');
  assert.deepEqual(saved.body.parameters.width, {
    policy: 'model',
    type: 'integer',
    default: 512,
    min: 256,
    max: 1024,
  });
  await f.ui.edit(f.workflows[0]);
  assert.equal(f.$('native-workflow-description').value, 'Soft studio portraits');
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
test('dirty back stays in the same panel until discard and restores focus', async t => {
  const f = await setup(t);
  await f.ui.edit(f.template);
  f.$('native-workflow-name').value = 'Changed';
  f.ui.requestBack();
  assert.equal(f.ui.isEditing(), true);
  assert.equal(f.$('native-workflow-unsaved').hidden, false);
  f.$('native-workflow-keep').onclick();
  assert.equal(f.ui.isEditing(), true);
  f.ui.requestBack();
  f.$('native-workflow-discard').onclick();
  assert.equal(f.ui.isEditing(), false);
  assert.equal(f.$('workflow-add').focused, true);
});
test('Échap in the editor is answered at the key: the question, then « Continuer à modifier », never the settings closed', async t => {
  const f = await setup(t);
  f.$('settings').open = true;
  await f.ui.edit(f.template);
  f.$('native-workflow-name').value = 'Portrait de nuit';
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
  // twice, it closed the settings and the workflow was lost. Prevented at the key, none is made.
  let event = press();
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.stopped, true, 'the guard of the settings does not hear it');
  assert.equal(f.$('native-workflow-unsaved').hidden, false);
  // Again, on the question: « Continuer à modifier »; the editor stays, with what was typed.
  event = press();
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.$('native-workflow-unsaved').hidden, true);
  assert.equal(f.ui.isEditing(), true);
  assert.equal(f.$('native-workflow-name').value, 'Portrait de nuit');
  // Answered already (a list of glass closes on Échap), another key, another window over the
  // settings: not the editor's.
  for (const extra of [{ defaultPrevented: true }, { key: 'Enter' }, { isComposing: true }, { target: { closest: () => ({}) } }]) {
    event = press(extra);
    assert.equal(event.stopped, false);
    assert.equal(f.$('native-workflow-unsaved').hidden, true);
    assert.equal(f.ui.isEditing(), true);
  }
  // Nothing changed: Échap leaves the editor for the list, the settings stay open.
  f.$('native-workflow-name').value = f.template.name;
  event = press({ target: { closest: () => f.$('settings') } });
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.ui.isEditing(), false);
  assert.equal(f.$('workflow-editor').hidden, true);
  assert.equal(f.$('settings').open, true);
  // No workflow being edited: the key is the settings' (their guard answers it).
  event = press();
  assert.equal(event.defaultPrevented, false);
  assert.equal(event.stopped, false);
});
test('the engine of the workflow being edited stays shown when the workflows are read again', async t => {
  const f = await setup(t),
    list = f.$('native-workflow-pipeline'),
    rebuild = list.replaceChildren.bind(list);
  // As a list of the page: its choices replaced, it shows the first one.
  list.replaceChildren = (...options) => {
    rebuild(...options);
    list.value = options[0]?.value ?? '';
  };
  await f.ui.edit(f.template);
  assert.equal(list.value, 'krea2');
  // The generation engine just ready, a download ended, ComfyUI answering: read again from the server.
  await f.ui.refresh({ settings: false });
  assert.equal(list.value, 'krea2', 'not « Choisir un moteur… » for a workflow that has its engine');
  assert.equal(f.ui.isEditing(), true);
  // No workflow open: the list is left on its first line, as before.
  f.ui.requestBack();
  await f.ui.refresh({ settings: false });
  assert.equal(list.value, '');
});
test('LoRA enable and strength policies remain independent', async t => {
  const f = await setup(t),
    template = structuredClone(f.template);
  template.loras = [
    {
      id: 'style',
      asset: 'lora-one',
      description: 'Soft light',
      enabled: { policy: 'model', default: true },
      strength: { policy: 'fixed', value: 0.55 },
    },
  ];
  await f.ui.edit(template);
  f.$('native-lora-enabled-style').value = 'off';
  f.$('native-lora-strength-policy-style').value = 'model';
  f.$('native-lora-strength-policy-style').onchange();
  f.$('native-lora-strength-min-style').value = '0';
  f.$('native-lora-strength-max-style').value = '1';
  assert.equal(await f.ui.saveEditor(), true);
  const saved = f.calls.find(call => call.route === 'generation/workflows').body.loras[0];
  assert.deepEqual(saved.enabled, { policy: 'off' });
  assert.equal(saved.strength.policy, 'model');
  assert.equal(saved.strength.default, 0.55);
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
test('LoRA model strength starts with supported limits', async t => {
  const { validateNativeWorkflow } = await import('../lib/native-workflows.mjs');
  const f = await setup(t),
    record = structuredClone(f.template);
  record.loras = [
    {
      id: 'style',
      asset: 'lora-one',
      description: 'Light',
      enabled: { policy: 'off' },
      strength: { policy: 'fixed', value: 0.55 },
    },
  ];
  await f.ui.edit(record);
  f.$('native-lora-strength-policy-style').value = 'model';
  f.$('native-lora-strength-policy-style').onchange();
  await f.ui.saveEditor();
  assert.doesNotThrow(() => validateNativeWorkflow(f.calls.find(call => call.route === 'generation/workflows').body));
});
test('video editor shows the coupled audio VAE without inventing a selection or offering unsupported enhancement', async t => {
  const f = await setup(t),
    record = structuredClone(f.template);
  record.pipeline = 'ltx25';
  record.mediaType = 'video';
  await f.ui.edit(record);
  assert.equal(f.$('native-component-audioVae').value, '');
  assert.equal(f.$('native-component-enhancer'), null);
  // Left without a file it is not something missing: the folders of the settings answer for it.
  assert.match(f.$('native-component-audioVae-file').placeholder, /^Automatique · ou choisir un fichier/);
  assert.equal(f.$('native-component-audioVae-file').dataset.automatic, 'true');
});
test('a role shared by several families is named by the family of the open workflow', async t => {
  const { families, familyTemplate } = await import('../lib/families.mjs');
  const options = id => f.$(id).children.map(option => [option.value, option.textContent]);
  let f = await setup(t);
  // LTX extends a source video; Real-ESRGAN enlarges it, whatever family is listed first.
  await f.ui.edit(familyTemplate(families().realesrgan_video));
  assert.deepEqual(options('native-reference-role-source'), [['source_video', 'Vidéo à agrandir']]);
  f = await setup(t);
  await f.ui.edit(familyTemplate(families().ltx25));
  assert.ok(options('native-reference-role-source').some(([, label]) => label === 'Vidéo à prolonger'));
});
test('a file field takes a listed file or a pasted path, and never saves text it does not recognise', async t => {
  const f = await setup(t);
  await f.ui.edit(f.template);
  const field = f.$('native-component-model-file');
  // One field: no separate path section.
  assert.equal(f.$('native-component-model-path'), null);
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
  assert.match(f.$('native-workflow-error').textContent, /Fichier non reconnu/);
  assert.equal(f.ui.isEditing(), true);
  // A pasted path is registered, and Save waits for it.
  field.value = 'C:/models/pasted.safetensors';
  field.onchange();
  assert.equal(await f.ui.saveEditor(), true);
  const registered = f.calls.find(call => call.route === 'generation/assets');
  assert.deepEqual(registered.body, { path: 'C:/models/pasted.safetensors', kind: 'model', family: 'krea2' });
  const saved = f.calls.findLast(call => call.route === 'generation/workflows').body;
  assert.equal(saved.components.model.asset, 'model-new');
});
test('typing the name of a listed file selects it without a path', async t => {
  const f = await setup(t);
  await f.ui.edit();
  const field = f.$('native-component-model-file');
  assert.equal(field.value, '');
  assert.match(field.placeholder, /coller son chemin/);
  field.value = 'model.safetensors';
  field.oninput();
  assert.equal(f.$('native-component-model').value, 'model-one');
  assert.equal(
    f.calls.some(call => call.route === 'generation/assets'),
    false,
  );
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

test('a newly registered file is the one the workflow is made with at once; a file has no « Assistant » any more', async t => {
  // (0.6.102) Left to the assistant, a file was offered to the model as bare identifiers, nothing
  // to tell them apart, and the Studio had no choice of it: the editor no longer offers that choice.
  const f = await setup(t);
  await f.ui.edit(f.template);
  assert.equal(f.$('native-component-model-policy'), null, 'no switch « Fixe / Assistant » for a file');
  await f.$('native-component-model').parent.children[1].onclick();
  assert.equal(f.$('native-component-model').value, 'model-new');
  assert.equal(await f.ui.saveEditor(), true);
  const component = f.calls.find(call => call.route === 'generation/workflows').body.components.model;
  assert.deepEqual(component, { policy: 'fixed', asset: 'model-new' });
  assert.deepEqual(f.calls.find(call => call.route === 'files/choose').body, {
    kind: 'generation',
    initialPath: 'model.safetensors',
  });
  assert.equal(f.calls.find(call => call.route === 'generation/assets').body.family, 'krea2');
});
test('unified import accepts Comfy JSON and opens a fresh prefilled editor without saving', async t => {
  const f = await setup(t),
    sourceText = JSON.stringify({
      1: { class_type: 'CLIPLoader', inputs: { clip_name: 'my text.safetensors', type: 'krea2' } },
      2: { class_type: 'KSampler', inputs: { steps: 22, cfg: 4, width: 640, height: 768, seed: 42 } },
    });
  await f.$('native-workflow-file').onchange({ target: { files: [], value: '' } });
  assert.equal(
    f.calls.some(call => call.route === 'generation/import'),
    false,
  );
  const target = {
    files: [{ name: 'Custom.json', size: sourceText.length, text: async () => sourceText }],
    value: 'workflow.json',
  };
  await f.$('native-workflow-file').onchange({ target });
  assert.equal(target.value, '');
  assert.deepEqual(f.calls.find(call => call.route === 'generation/import').body, {
    sourceText,
    modelsDir: '',
    modelRoot: 'C:/atelier/models/checkpoints',
    vaeRoot: 'C:/atelier/models/VAE',
    loraRoot: 'C:/atelier/models/LoRa',
    textEncoderRoot: 'C:/atelier/models/LLMs',
    tokenizerRoot: '',
    upscaleRoot: '',
    latentUpscaleRoot: '',
    name: 'Custom.json',
  });
  assert.equal(f.ui.isEditing(), true);
  assert.equal(f.$('native-workflow-title').textContent, 'Créer un workflow');
  assert.equal(f.$('native-value-steps').value, 22);
  assert.equal(f.$('native-workflow-enabled').checked, false);
  assert.equal(
    f.calls.some(call => call.route === 'generation/workflows'),
    false,
  );
  assert.equal(await f.ui.saveEditor(), true);
  const saved = f.calls.find(call => call.route === 'generation/workflows').body;
  assert.ok(saved.importDraft);
  assert.equal(saved.parameters.cfg.value, 4);
});

test('oversized workflow files and reads completed after closing do not create workflows', async t => {
  const f = await setup(t);
  await f.$('native-workflow-file').onchange({
    target: {
      files: [
        {
          size: 2 * 1024 * 1024 + 1,
          text() {
            throw Error('Must not read oversized files');
          },
        },
      ],
      value: '',
    },
  });
  assert.match(f.$('native-import-status').textContent, /2 Mo/);
  assert.equal(f.ui.isEditing(), false);
  let finish;
  const text = new Promise(resolve => {
      finish = resolve;
    }),
    pending = f.$('native-workflow-file').onchange({ target: { files: [{ size: 100, text: () => text }], value: '' } });
  f.ui.cancelSettings();
  finish('{}');
  await pending;
  assert.equal(
    f.calls.some(call => call.route === 'generation/import'),
    false,
  );
  assert.equal(f.ui.isEditing(), false);
});

test('parameter ownership uses accessible compact switches and updates selected state', async t => {
  const f = await setup(t);
  await f.ui.edit(f.template);
  const owner = f.$('native-policy-seed');
  assert.equal(owner.getAttribute('role'), 'group');
  assert.equal(owner.children.find(button => button.textContent === 'Aléatoire').getAttribute('aria-pressed'), 'true');
  owner.children.find(button => button.textContent === 'Fixe').onclick();
  assert.equal(owner.value, 'fixed');
  assert.equal(owner.children.find(button => button.textContent === 'Fixe').getAttribute('aria-pressed'), 'true');
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
test('a setting left to the assistant is not saved without a default, said under its box; a file left so is shown at the one it is made with', async t => {
  // (0.6.94) Saved so, every creation that did not name it was refused, the Studio's too.
  // (0.6.102) « Assistant » left the files: a workflow saved so shows the file it is made with (its
  // default, else the first allowed: lib/native-workflows.mjs, componentStandIn), and keeps it.
  const f = await setup(t),
    record = structuredClone(f.template);
  record.components.model = { policy: 'model', choices: ['model-one'], description: 'Choose the portrait checkpoint' };
  record.parameters.width = { policy: 'model', type: 'integer', min: 256, max: 1024 };
  await f.ui.edit(record);
  const said = () => {
    const all = node => [node, ...(node.children ?? []).flatMap(all)];
    return ['native-workflow-components', 'native-workflow-parameters']
      .flatMap(id => all(f.$(id)))
      .filter(item => String(item.className).includes('native-needs-default') && !item.hidden)
      .map(item => item.textContent);
  };
  assert.equal(f.$('native-component-model-file').value, 'model.safetensors', 'the file it is made with');
  // Said at once, under the box of the setting; nothing of the file.
  assert.deepEqual(said(), [
    'Choisissez une valeur par défaut : c’est elle qui sert quand Moodix AI n’en donne pas. Sans elle, ce workflow ne s’enregistre pas.',
  ]);
  assert.equal(await f.ui.saveEditor(), false);
  assert.equal(
    f.$('native-workflow-error').textContent,
    'Largeur : choisissez une valeur par défaut (« Préférer une valeur par défaut »). C’est elle qui sert quand Moodix AI n’en donne pas.',
  );
  assert.equal(
    f.calls.some(call => call.route === 'generation/workflows'),
    false,
    'nothing saved so far',
  );
  f.$('native-use-default-width').checked = true;
  f.$('native-use-default-width').onchange();
  f.$('native-value-width').value = '512';
  assert.deepEqual(said(), []);
  assert.equal(await f.ui.saveEditor(), true);
  const saved = f.calls.find(call => call.route === 'generation/workflows').body;
  assert.deepEqual(saved.components.model, { policy: 'fixed', asset: 'model-one' });
  assert.deepEqual(saved.parameters.width, { policy: 'model', type: 'integer', default: 512, min: 256, max: 1024 });
});

test('the strength of a LoRA left to the assistant needs a default while the LoRA can be on', async t => {
  // (0.6.94) Saved without, a creation that did not name it was refused.
  const f = await setup(t),
    record = structuredClone(f.template);
  record.loras = [
    {
      id: 'style',
      asset: 'lora-one',
      description: 'Soft light',
      enabled: { policy: 'fixed', value: true },
      strength: { policy: 'model', type: 'number', min: 0, max: 1 },
    },
  ];
  await f.ui.edit(record);
  assert.equal(await f.ui.saveEditor(), false);
  assert.equal(
    f.$('native-workflow-error').textContent,
    'Intensité du LoRA « Soft light » : choisissez une valeur par défaut (« Préférer une valeur par défaut »). C’est elle qui sert quand Moodix AI n’en donne pas.',
  );
  // Off, its strength is not used: nothing to ask.
  f.$('native-lora-enabled-style').value = 'off';
  f.$('native-lora-enabled-style').onchange();
  assert.equal(await f.ui.saveEditor(), true);
  const saved = f.calls.find(call => call.route === 'generation/workflows').body.loras[0];
  assert.deepEqual([saved.enabled, saved.strength.default], [{ policy: 'off' }, undefined]);
});

test('blank creation opens, uses the checkpoint folder and leaves the files not chosen to the folders of the settings', async t => {
  const f = await setup(t);
  await f.ui.edit();
  assert.equal(f.ui.isEditing(), true);
  assert.equal(f.$('native-workflow-name').value, '');
  assert.equal(f.$('native-component-model').value, '');
  // Without its name and description nothing is sent.
  assert.equal(await f.ui.saveEditor(), false);
  f.$('native-workflow-name').value = 'Personal workflow';
  f.$('native-workflow-description').value = 'Portraits';
  await f.$('native-component-model').parent.children[1].onclick();
  assert.equal(f.calls.find(call => call.route === 'files/choose').body.initialPath, 'C:/atelier/models/checkpoints');
  assert.equal(f.$('native-workflow-name').value, 'Personal workflow');
});

test('checkpoint default is displayed while only a custom override is persisted; background refresh preserves the draft', async t => {
  const f = await setup(t);
  assert.equal(f.$('native-convert-root').value, 'C:/atelier/models/checkpoints');
  assert.equal(f.ui.values().modelRoot, '');
  f.$('native-convert-root').value = 'D:/other checkpoints';
  await f.ui.refresh({ settings: false });
  assert.equal(f.ui.values().modelRoot, 'D:/other checkpoints');
  await f.ui.edit();
  await f.$('native-component-model').parent.children[1].onclick();
  assert.equal(f.calls.find(call => call.route === 'files/choose').body.initialPath, 'D:/other checkpoints');
});

test('VAE and LoRA folders can be edited or browsed and feed component selection and imports before Save', async t => {
  const f = await setup(t);
  assert.equal(f.$('generation-vae-root').value, 'C:/atelier/models/VAE');
  assert.equal(f.$('generation-lora-root').value, 'C:/atelier/models/LoRa');
  assert.equal(f.ui.values().vaeRoot, '');
  assert.equal(f.ui.values().loraRoot, '');
  f.$('generation-vae-root').value = 'D:/my VAE';
  f.$('generation-lora-root').value = 'D:/my LoRA';
  await f.ui.refresh({ settings: false });
  assert.equal(f.ui.values().vaeRoot, 'D:/my VAE');
  assert.equal(f.ui.values().loraRoot, 'D:/my LoRA');
  await f.ui.edit();
  await f.$('native-component-vae').parent.children[1].onclick();
  assert.equal(f.calls.find(call => call.route === 'files/choose').body.initialPath, 'D:/my VAE');
  f.$('native-workflow-add-lora').onclick();
  const lora = f.$('native-workflow-loras').children[0];
  await lora.children[0].children[1].children[0].children[1].onclick();
  assert.equal(f.calls.filter(call => call.route === 'files/choose').at(-1).body.initialPath, 'D:/my LoRA');
  f.ui.cancelSettings();
  const text = JSON.stringify(f.template);
  await f
    .$('native-workflow-file')
    .onchange({ target: { files: [{ size: text.length, text: async () => text }], value: '' } });
  assert.equal(f.calls.find(call => call.route === 'generation/import').body.vaeRoot, 'D:/my VAE');
  assert.equal(f.calls.find(call => call.route === 'generation/import').body.loraRoot, 'D:/my LoRA');
  f.ui.cancelSettings();
  await f.$('generation-vae-root-browse').onclick();
  const browse = f.calls.filter(call => call.route === 'files/choose').at(-1);
  assert.deepEqual(browse.body, { kind: 'directory', initialPath: 'D:/my VAE' });
  assert.equal(f.$('generation-vae-root').value, 'C:/models/new.safetensors');
});

test('LoRAs can be added and removed with incomplete sibling fields without rebuilding their drafts', async t => {
  const f = await setup(t);
  await f.ui.edit(f.template);
  f.$('native-workflow-add-lora').onclick();
  const first = f.$('native-workflow-loras').children[0],
    strength = first.children.find(child => child.className === 'native-parameter'),
    value = strength.children.find(child => child.className === 'field-group').children[1];
  value.value = '';
  f.$('native-workflow-add-lora').onclick();
  assert.equal(f.$('native-workflow-loras').children.length, 2);
  assert.equal(value.value, '');
  first.children.at(-1).onclick();
  assert.equal(f.$('native-workflow-loras').children.length, 1);
  assert.equal(f.$('native-lora-count').textContent, '1');
  f.$('native-workflow-loras').children[0].children.at(-1).onclick();
  assert.equal(await f.ui.saveEditor(), true);
});

test('the one-reference image limit survives busy transitions and removing its slot enables adding again', async t => {
  const f = await setup(t);
  await f.ui.edit(f.template);
  f.$('native-workflow-add-reference').onclick();
  assert.equal(f.$('native-reference-count').textContent, '1');
  f.ui.setBusy(true);
  f.ui.setBusy(false);
  assert.equal(f.$('native-workflow-add-reference').disabled, true);
  f.$('native-workflow-references').children[0].children.at(-1).onclick();
  assert.equal(f.$('native-workflow-add-reference').disabled, false);
});

test('changing pipeline preserves the old draft until confirmed, even when numeric fields are invalid', async t => {
  const f = await setup(t);
  await f.ui.edit(f.template);
  f.$('native-value-width').value = '';
  f.$('native-workflow-pipeline').value = 'ltx25';
  await f.$('native-workflow-pipeline').onchange();
  assert.equal(f.$('native-workflow-switch').hidden, false);
  assert.equal(f.$('native-workflow-pipeline').value, 'krea2');
  f.$('native-workflow-switch-cancel').onclick();
  assert.equal(f.$('native-value-width').value, '');
  f.$('native-workflow-pipeline').value = 'ltx25';
  await f.$('native-workflow-pipeline').onchange();
  await f.$('native-workflow-switch-confirm').onclick();
  assert.equal(f.$('native-workflow-pipeline').value, 'ltx25');
  assert.equal(f.$('native-workflow-name').value, 'Portrait');
  assert.equal(f.$('native-workflow-enabled').checked, false);
  assert.equal(f.$('native-component-model').value, '');
});

test('Atelier imports are validated, disabled and assigned new identities instead of overwriting a saved workflow', async t => {
  const f = await setup(t),
    file = { size: 500, text: async () => JSON.stringify({ ...f.template, enabled: true }) };
  await f.$('native-workflow-file').onchange({ target: { files: [file], value: 'file' } });
  assert.equal(f.ui.isEditing(), true);
  assert.equal(f.$('native-workflow-enabled').checked, false);
  assert.equal(await f.ui.saveEditor(), true);
  const saved = f.calls.find(call => call.route === 'generation/workflows').body;
  assert.notEqual(saved.id, f.template.id);
  assert.equal(f.workflows.length, 2);
});

test('invalid imports and file reads completed after closing never leave a half-open editor', async t => {
  const f = await setup(t);
  await f.$('native-workflow-file').onchange({
    target: {
      files: [{ size: 100, text: async () => JSON.stringify({ ...f.template, components: null }) }],
      value: '',
    },
  });
  assert.equal(f.ui.isEditing(), false);
  assert.equal(f.$('native-import-status').hidden, false);
  let finish;
  const text = new Promise(resolve => {
      finish = resolve;
    }),
    pending = f.$('native-workflow-file').onchange({ target: { files: [{ size: 100, text: () => text }], value: '' } });
  f.ui.cancelSettings();
  finish(JSON.stringify(f.template));
  await pending;
  assert.equal(f.ui.isEditing(), false);
  assert.equal(f.$('workflow-editor').hidden, true);
});

test('every static control used during settings initialization exists in the shipped HTML', async t => {
  const f = await setup(t);
  assert.ok(f.ui);
  assert.match(html, /data-settings-section="Génération"/);
  assert.match(html, /class="settings-block workflow-settings"/);
  assert.doesNotMatch(
    html,
    /Importer un JSON natif|Convertir Krea avec sauvegarde|Format d’origine|Seuls ces deux formats/,
  );
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal((html.match(/>Importer un workflow<\/button>/g) || []).length, 1);
  assert.ok(html.indexOf('id="native-workflow-import"') < html.indexOf('id="workflow-add"'));
  assert.equal(html.includes('native-comfy-file'), false);
});

test('four unsupported references and three named LoRAs all appear in the editor and survive saving the draft', async t => {
  const f = await setup(t),
    source = {
      encoder: { class_type: 'CLIPLoader', inputs: { type: 'krea2', clip_name: 'text.safetensors' } },
      sampler: { class_type: 'KSampler', inputs: { steps: 19, cfg: 4 } },
    };
  for (let i = 0; i < 4; i++) source['ref' + i] = { class_type: 'LoadImage', inputs: { image: 'ref' + i + '.png' } };
  for (let i = 0; i < 3; i++)
    source['lora' + i] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: { lora_name: 'my-specific-' + i + '.safetensors', strength_model: 0.5 + i },
    };
  const text = JSON.stringify(source);
  await f.$('native-workflow-file').onchange({
    target: { files: [{ name: 'Four refs.json', size: text.length, text: async () => text }], value: '' },
  });
  assert.equal(f.$('native-reference-count').textContent, '4');
  assert.equal(f.$('native-lora-count').textContent, '3');
  assert.equal(f.$('native-workflow-enabled').dataset.unavailable, 'true');
  assert.equal(f.$('native-workflow-add-reference').disabled, false);
  assert.equal(f.$('native-source-settings').children.length, 0);
  f.$('native-source-section').open = true;
  f.$('native-source-section').ontoggle();
  assert.ok(f.$('native-source-settings').children.length > 0);
  assert.equal(await f.ui.saveEditor(), true);
  const record = f.calls.find(call => call.route === 'generation/workflows').body;
  assert.equal(record.references.length, 4);
  assert.equal(record.loras.length, 3);
  assert.ok(Object.values(record.importDraft.files).includes('my-specific-2.safetensors'));
  const cards = f.$('workflow-list').children.filter(item => item.className === 'workflow-card');
  // Its pencil (the bin follows it on a workflow of the user's own).
  await cards.at(-1).children.at(-1).children.find(item => item.className.includes('native-edit')).onclick();
  assert.ok(f.calls.some(call => call.route === 'generation/workflows/' + record.id));
  assert.equal(f.$('native-reference-count').textContent, '4');
  assert.equal(f.$('native-value-cfg').value, 4);
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

test('one list of workflows: MOSS Image says whether ComfyUI answers, « Démarrer » while it does not', async t => {
  // « Démarrer » asks every 2 s whether ComfyUI answers, for 2 min: left to the real clock, that
  // wait kept this file from ending for as long (cancelled by the limit of a run).
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await setup(t);
  const list = () => f.$('workflow-list').children;
  // No section of an external engine any more: Krea 2 alone here.
  assert.deepEqual(list().map(item => item.className), ['workflow-card']);
  assert.equal(f.nodes.get('comfy-url'), undefined);
  // MOSS Image, which ComfyUI runs: its line says ComfyUI is not started, and offers to start it.
  const moss = { ...structuredClone(f.template), id: 'moss-image', name: 'MOSS Image', pipeline: 'moss', builtin: true };
  f.workflows.push(moss);
  const answers = {
    'generation/comfy/start': [{ choose: true }, { started: true, app: 'Comfy Desktop.exe', comfy: { enabled: true, reachable: false, reason: 'stopped' } }],
  };
  const api = f.api;
  f.api = async (route, body) => {
    if (answers[route]) {
      f.calls.push({ route, body: structuredClone(body) });
      return Response.json(answers[route].shift());
    }
    if (route === 'files/choose') {
      f.calls.push({ route, body: structuredClone(body) });
      return Response.json({ path: 'D:\\Comfy\\Comfy Desktop\\Comfy Desktop.exe' });
    }
    return api(route, body);
  };
  f.ui = setupNativeWorkflows({ api: (...args) => f.api(...args), state: {}, node: f.node, notice() {} });
  await f.ui.refresh();
  // Its line (capture 44): the dot, its name with its kind in mono and its sentence, the actions.
  const mossCard = () => list().find(item => item.children[1].children[0].children[0].textContent === 'MOSS Image'),
    card = mossCard(),
    [, main] = card.children,
    line = main.children.at(-1);
  assert.deepEqual(main.children[0].children.map(item => item.textContent), ['MOSS Image', 'Image']);
  assert.equal(card.find?.('help-tip'), undefined);
  assert.equal(line.className, 'workflow-comfy');
  assert.equal(line.dataset.state, 'stopped');
  assert.equal(line.children[1].textContent, 'ComfyUI n’est pas lancé');
  const start = line.children.at(-1);
  assert.equal(start.textContent, 'Démarrer');
  // Not known which ComfyUI: the user chooses it, then it starts; the line says it is starting.
  await start.onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(
    f.calls.filter(call => ['generation/comfy/start', 'files/choose'].includes(call.route)).map(call => [call.route, call.body]),
    [
      ['generation/comfy/start', {}],
      ['files/choose', { kind: 'comfy', initialPath: '' }],
      ['generation/comfy/start', { launchPath: 'D:\\Comfy\\Comfy Desktop\\Comfy Desktop.exe' }],
    ],
  );
  const after = mossCard().children[1].children.at(-1);
  assert.equal(after.dataset.state, 'starting');
  assert.equal(after.children[1].textContent, 'ComfyUI démarre…');
  assert.equal(after.children.at(-1).disabled, true);
});

test('the licences of a download are on the line of its workflow; one with conditions is read and confirmed first', async t => {
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
  const lacking = (id, name) => ({
    ...structuredClone(f.template),
    id,
    name,
    builtin: true,
    enabled: true,
    ready: false,
  });
  f.workflows.push(lacking('krea-two', 'Krea 2'), lacking('seedvr', 'Upscale SeedVR2'));
  const offer = files => ({
    files,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
    left: files.reduce((sum, file) => sum + file.size, 0),
    complete: true,
    needsToken: false,
    page: '',
  });
  const offers = {
    'krea-two': offer([
      { role: 'textEncoder', file: 'qwen3vl_4b.safetensors', size: giga, license: apache },
      { role: 'model', file: 'krea2_turbo.safetensors', size: 3 * giga, license: krea },
    ]),
    seedvr: offer([{ role: 'model', file: 'seedvr2.safetensors', size: giga, license: apache }]),
  };
  const api = f.api,
    starts = [];
  f.api = async (route, body) => {
    if (route === 'generation') {
      const result = await (await api(route, body)).json();
      return Response.json({ ...result, downloads: { offers, job: { state: 'idle' }, hasToken: false } });
    }
    if (route === 'downloads/start') {
      starts.push(body);
      return Response.json({ state: 'running', workflowId: body.id, name: body.id, received: 0, total: giga });
    }
    return api(route, body);
  };
  f.ui = setupNativeWorkflows({ api: (...args) => f.api(...args), state: {}, node: f.node, notice() {} });
  await f.ui.refresh();
  const cardOf = name =>
      f.$('workflow-list').children.find(item => item.children[1]?.children[0].children[0].textContent === name),
    under = root => [root, ...root.children.flatMap(child => under(child))],
    find = (root, name) => under(root).filter(item => String(item.className).split(' ').includes(name)),
    lines = card =>
      find(card, 'license-item').map(item =>
        under(item)
          .map(part => part.textContent)
          .filter(Boolean),
      ),
    actions = card => card.children.at(-1).children.map(item => item.children.at(-1)?.textContent || item.textContent),
    download = card => find(card, 'workflow-download')[0];

  // Before any press: each licence named with its link, the files it covers, its limits.
  assert.deepEqual(lines(cardOf('Krea 2')), [
    ['Krea 2 Community License Agreement v.1', 'à conditions', 'krea2_turbo.safetensors', krea.limits],
    ['Apache-2.0', 'qwen3vl_4b.safetensors'],
  ]);
  assert.equal(find(cardOf('Krea 2'), 'license-name')[0].href, krea.url);
  assert.equal(find(cardOf('Krea 2'), 'license-head')[0].textContent, 'Licences');
  assert.match(
    cardOf('Krea 2').children[0].dataset.help,
    /Licence à conditions \(Krea 2 Community License Agreement v\.1\) : à lire et à confirmer/,
  );
  assert.deepEqual(lines(cardOf('Upscale SeedVR2')), [['Apache-2.0']]);
  assert.doesNotMatch(cardOf('Upscale SeedVR2').children[0].dataset.help, /Licence à conditions/);
  assert.deepEqual(actions(cardOf('Krea 2')).slice(0, 1), ['4 Go']);

  // A licence with conditions: the first press starts nothing, shows it alone and asks to confirm.
  await download(cardOf('Krea 2')).onclick();
  assert.deepEqual(starts, []);
  assert.equal(find(cardOf('Krea 2'), 'license-block')[0].attributes['data-confirm'], 'true');
  assert.equal(find(cardOf('Krea 2'), 'license-head')[0].textContent, 'À lire avant de télécharger');
  assert.deepEqual(
    lines(cardOf('Krea 2')).map(line => line[0]),
    ['Krea 2 Community License Agreement v.1'],
  );
  assert.deepEqual(actions(cardOf('Krea 2')).slice(0, 2), ['Annuler', 'J’ai lu, télécharger · 4 Go']);
  assert.equal(download(cardOf('Krea 2')).focused, true);
  assert.equal(download(cardOf('Krea 2')).attributes['aria-label'], 'J’ai lu la licence : télécharger (4 Go)');
  // The other workflows are as they were.
  assert.deepEqual(actions(cardOf('Upscale SeedVR2')).slice(0, 1), ['1 Go']);
  // « Annuler »: back to its line, nothing sent.
  await cardOf('Krea 2').children.at(-1).children[0].onclick();
  assert.deepEqual(actions(cardOf('Krea 2')).slice(0, 1), ['4 Go']);
  assert.equal(find(cardOf('Krea 2'), 'license-block')[0].attributes['data-confirm'], undefined);
  assert.deepEqual(starts, []);
  // Pressed, then confirmed: the request says the licence was read.
  await download(cardOf('Krea 2')).onclick();
  await download(cardOf('Krea 2')).onclick();
  assert.deepEqual(starts, [{ id: 'krea-two', accepted: true }]);
  assert.equal(cardOf('Krea 2').dataset.state, 'downloading');
  assert.deepEqual(find(cardOf('Krea 2'), 'license-block'), [], 'the licences are no longer asked while it downloads');

  // Free licences alone: one press starts it, with no word of a confirmation.
  await f.ui.refresh();
  await download(cardOf('Upscale SeedVR2')).onclick();
  assert.deepEqual(starts.at(-1), { id: 'seedvr' });
  // Closing the settings forgets a confirmation left half-way.
  await f.ui.refresh();
  await download(cardOf('Krea 2')).onclick();
  assert.deepEqual(actions(cardOf('Krea 2')).slice(0, 2), ['Annuler', 'J’ai lu, télécharger · 4 Go']);
  f.ui.cancelSettings();
  await f.ui.refresh();
  assert.deepEqual(actions(cardOf('Krea 2')).slice(0, 1), ['4 Go']);
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

test('prompt enhancement is one visible Off/On switch whose instruction is saved with the workflow', async t => {
  const f = await setup(t);
  await f.ui.edit(f.template);
  assert.equal(f.$('native-workflow-enhance').hidden, false);
  const toggle = f.$('native-enhance-switch'),
    instruction = f.$('native-enhance-template');
  assert.equal(toggle.value, 'off');
  assert.match(instruction.value, /\{\{prompt\}\}/, 'the family default instruction is proposed');
  assert.equal(instruction.parent.hidden, true, 'the instruction only shows when enhancement is on');
  toggle.value = 'on';
  toggle.onchange();
  assert.equal(instruction.parent.hidden, false);
  instruction.value = 'Describe {{prompt}} in rich detail.';
  assert.equal(await f.ui.saveEditor(), true);
  let saved = f.calls.filter(call => call.route === 'generation/workflows').at(-1).body;
  assert.deepEqual(saved.parameters.expandPrompt, { policy: 'fixed', value: true });
  assert.equal(saved.promptExpansion.template, 'Describe {{prompt}} in rich detail.');
  assert.equal(
    saved.promptExpansion.maxTokens,
    familyCatalog().find(item => item.family === 'krea2').promptExpansionDefault.maxTokens,
  );
  assert.ok(validateNativeWorkflow(saved), 'what the editor saves is a valid workflow');

  await f.ui.edit(saved);
  assert.equal(f.$('native-enhance-switch').value, 'on');
  f.$('native-enhance-template').value = 'No placeholder';
  assert.equal(await f.ui.saveEditor(), false);
  assert.match(f.$('native-workflow-error').textContent, /\{\{prompt\}\} exactement une fois/);
  f.$('native-enhance-switch').value = 'off';
  f.$('native-enhance-switch').onchange();
  assert.equal(await f.ui.saveEditor(), true);
  saved = f.calls.filter(call => call.route === 'generation/workflows').at(-1).body;
  assert.deepEqual(saved.parameters.expandPrompt, { policy: 'fixed', value: false });
  assert.equal(
    saved.promptExpansion.template,
    'Describe {{prompt}} in rich detail.',
    'turning it off keeps the saved instruction',
  );

  const video = structuredClone(f.template);
  video.pipeline = 'ltx25';
  video.mediaType = 'video';
  await f.ui.edit(video);
  assert.equal(f.$('native-workflow-enhance').hidden, true);
});

test('every shipped workflow comes out of the editor unchanged when saved untouched', async t => {
  const { readdir, readFile } = await import('node:fs/promises');
  const folder = new URL('../runner/workflows/', import.meta.url);
  for (const name of (await readdir(folder)).filter(name => name.endsWith('.json'))) {
    const stored = JSON.parse(await readFile(new URL(name, folder), 'utf8'));
    const f = await setup(t);
    await f.ui.edit(structuredClone(stored));
    assert.equal(f.ui.editorDirty(false), false, name + ' is dirty right after opening');
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

test('a component left without a file is sent as such, and the file found for it is named', async t => {
  const f = await setup(t),
    record = { ...structuredClone(f.template), automatic: { textEncoder: 'qwen3vl_4b_int8_convrot.safetensors' } };
  // As the server lists a workflow that fixes none of its files.
  record.components = {};
  await f.ui.edit(record);
  const field = role => f.$('native-component-' + role + '-file'),
    back = role => field(role).parent.children[2];
  // The text encoder was chosen by nobody: the server took it from the folder, and says which.
  assert.match(
    field('textEncoder').placeholder,
    /^Automatique : qwen3vl_4b_int8_convrot\.safetensors · ou choisir un fichier/,
  );
  assert.equal(field('textEncoder').dataset.automatic, 'true');
  assert.equal(back('textEncoder').textContent, 'Automatique');
  assert.equal(back('textEncoder').hidden, true, 'nothing to go back from');

  // A file chosen here overrides the folder; « Automatique » gives the choice back to it.
  await field('model').parent.children[1].onclick();
  assert.notEqual(f.$('native-component-model').value, '');
  assert.equal(field('model').dataset.automatic, 'false');
  assert.equal(back('model').hidden, false);
  back('model').onclick();
  assert.equal(f.$('native-component-model').value, '');
  assert.equal(field('model').dataset.automatic, 'true');

  f.$('native-workflow-name').value = 'Personal workflow';
  f.$('native-workflow-description').value = 'Portraits';
  await field('vae').parent.children[1].onclick();
  assert.equal(await f.ui.saveEditor(), true, f.$('native-workflow-error').textContent);
  const saved = f.calls.find(call => call.route === 'generation/workflows').body;
  // Only what was chosen here is fixed in the workflow; the rest is left to the folders.
  assert.deepEqual(Object.keys(saved.components), ['vae']);
  assert.equal(saved.automatic, undefined, 'what the server found is not part of the workflow');
});

test('a model folder cannot be told from another: without one, the workflow is not saved', async t => {
  const { families, familyTemplate } = await import('../lib/families.mjs');
  const f = await setup(t);
  await f.ui.edit({ ...familyTemplate(families().acestep15), components: {} });
  f.$('native-workflow-name').value = 'Musique';
  f.$('native-workflow-description').value = 'Chansons';
  assert.match(f.$('native-component-musicModel-file').placeholder, /^Choisir un dossier/);
  assert.equal(await f.ui.saveEditor(), false);
  assert.match(f.$('native-workflow-error').textContent, /Choisissez un fichier pour « Modèle de musique/);
});

// What changes nothing is greyed and said why (17/11); tests/workflow-options.mjs holds each reason
// against what the server sends the engine.
const shippedWorkflow = async pipeline => {
  const { readdir, readFile } = await import('node:fs/promises');
  const folder = new URL('../runner/workflows/', import.meta.url);
  for (const name of (await readdir(folder)).filter(name => name.endsWith('.json'))) {
    const workflow = JSON.parse(await readFile(new URL(name, folder), 'utf8'));
    if (workflow.pipeline === pipeline) return workflow;
  }
};
/** The note of the card a control is on: why it is greyed, or what it does unexpectedly. */
const noteOf = control => {
  let card = control;
  while (card && !['native-parameter', 'native-lora'].includes(card.className)) card = card.parent;
  return card.children.find(child => child.className.includes('native-inert'));
};
test('LTX 2.5: what its profiles replace, its single values and the length of its profiles are greyed, and said why', async t => {
  const f = await setup(t);
  await f.ui.edit(await shippedWorkflow('ltx25'));
  const off = id => f.$(id).dataset.unavailable === 'true' && f.$(id).disabled === true;
  // The size and the frame rate of « Réglages de génération »: the profiles set them.
  for (const name of ['width', 'height', 'fps']) {
    assert.ok(off('native-value-' + name), name);
    assert.match(noteOf(f.$('native-value-' + name)).textContent, /Brouillon et vidéo finale/);
  }
  // Eight steps, the only value LTX takes: the whole setting, and in each profile.
  assert.ok(off('native-value-steps') && f.$('native-policy-steps').dataset.unavailable === 'true');
  assert.match(noteOf(f.$('native-value-steps')).textContent, /Seule valeur que LTX2.5 accepte : 8\./);
  assert.ok(off('native-profile-draft-steps'));
  // The length is the one asked, else « Images vidéo »: the profiles' is never used, nor said to the model.
  assert.ok(off('native-profile-draft-frames') && off('native-profile-final-frames'));
  assert.match(f.$('native-profile-draft-frames').parent.children.at(-1).textContent, /durée est celle demandée/);
  assert.ok(off('native-description-frames'));
  assert.equal(f.$('native-value-frames').dataset.unavailable, 'false');
  // A list of choices has no bounds: they were shown, and never saved.
  assert.equal(f.$('native-min-frames').parent, undefined);
  assert.notEqual(f.$('native-min-start_strength').parent, undefined, 'a range keeps its bounds');
  // What stays theirs is open.
  assert.equal(f.$('native-profile-final-width').dataset.unavailable, 'false');
  assert.equal(f.$('native-value-audio').dataset.unavailable, 'false');
  // The prompt is a line, no switch.
  assert.equal(f.$('native-policy-prompt'), null);
  // The LoRA of the subject images: on by itself with them; its default and description do nothing.
  assert.ok(off('native-lora-default-reference-slots') && off('native-lora-description-reference-slots'));
  assert.match(noteOf(f.$('native-lora-default-reference-slots')).textContent, /Référence de sujet/);
  // Fixed, the length of the profiles is used again, and its own value is replaced (live).
  f.$('native-policy-frames').value = 'fixed';
  f.$('native-policy-frames').onchange();
  assert.equal(f.$('native-profile-draft-frames').dataset.unavailable, 'false');
  assert.ok(off('native-value-frames'));
  // Untouched, it is saved as it was.
  f.$('native-policy-frames').value = 'model';
  f.$('native-policy-frames').onchange();
  assert.equal(f.ui.editorDirty(false), false);
});
test('an engine without LoRA offers none, and says so; one with LoRAs offers them', async t => {
  const f = await setup(t);
  await f.ui.edit(await shippedWorkflow('realesrgan_image'));
  assert.equal(f.$('native-workflow-add-lora').dataset.unavailable, 'true');
  assert.equal(f.$('native-lora-note').hidden, false);
  assert.match(f.$('native-lora-note').textContent, /Real-ESRGAN ne prend pas de LoRA\./);
  f.$('native-workflow-add-lora').onclick();
  assert.equal(f.$('native-lora-count').textContent, '0', 'nothing added');
  f.ui.setBusy(false);
  assert.equal(f.$('native-workflow-add-lora').disabled, true, 'stays greyed after a busy spell');
  f.$('native-workflow-back').onclick();
  await f.ui.edit(f.template);
  assert.equal(f.$('native-workflow-add-lora').dataset.unavailable, 'false');
  assert.equal(f.$('native-lora-note').hidden, true);
  f.$('native-workflow-add-lora').onclick();
  assert.equal(f.$('native-lora-count').textContent, '1');
});
test('a music engine takes no reference: the button is greyed, and said why', async t => {
  const f = await setup(t);
  await f.ui.edit(await shippedWorkflow('acestep15'));
  assert.equal(f.$('native-workflow-add-reference').dataset.unavailable, 'true');
  assert.match(f.$('native-reference-note').textContent, /ACE-Step 1.5 ne prend pas d’image ni de vidéo de référence\./);
  assert.equal(f.$('native-reference-note').hidden, false);
});
test('a prompt is a line, never a switch: a fixed one is shown, kept by an untouched save, and leaves with a change', async t => {
  const { workflowFingerprint } = await import('../lib/native-workflows.mjs');
  const f = await setup(t),
    record = structuredClone(f.template);
  record.parameters.prompt = { policy: 'fixed', value: 'Un portrait' };
  await f.ui.edit(record);
  assert.equal(f.$('native-policy-prompt'), null);
  assert.equal(f.$('native-value-prompt'), null);
  // Its text is there to be read and copied, not to be changed; the line under it says what becomes of it.
  const stored = f.$('native-prompt-stored');
  assert.equal(stored.value, 'Un portrait');
  assert.equal(stored.readOnly, true);
  const said = stored.parent.parent.children.at(-1).textContent;
  assert.match(said, /Un prompt fixe est refusé à chaque création/);
  assert.match(said, /c’est désormais l’assistant qui écrit le prompt/);
  assert.match(said, /retiré du workflow dès que vous enregistrerez une modification/);
  // Opened and saved without a change: not dirty, and the workflow is the one that was stored.
  assert.equal(f.ui.editorDirty(false), false);
  assert.equal(await f.ui.saveEditor(), true, f.$('native-workflow-error').textContent);
  const untouched = f.calls.findLast(call => call.route === 'generation/workflows').body;
  assert.deepEqual(untouched.parameters.prompt, { policy: 'fixed', value: 'Un portrait' });
  // Nor is a setting it never had added to it (« Améliorer le prompt », off).
  assert.equal(untouched.parameters.expandPrompt, undefined);
  assert.equal(workflowFingerprint(untouched), workflowFingerprint(record));
  // With a change of the user's, it is written at each creation from then on.
  await f.ui.edit(structuredClone(untouched));
  assert.equal(f.$('native-prompt-stored').value, 'Un portrait', 'still shown when opened again');
  f.$('native-workflow-description').value = 'Portraits serrés';
  assert.equal(f.ui.editorDirty(false), true);
  assert.equal(await f.ui.saveEditor(), true, f.$('native-workflow-error').textContent);
  const changed = f.calls.findLast(call => call.route === 'generation/workflows').body;
  assert.deepEqual(changed.parameters.prompt, { policy: 'model', type: 'string' });
  await f.ui.edit(structuredClone(changed));
  const shown = f.$('native-workflow-parameters').querySelectorAll().map(control => control.id);
  assert.ok(shown.includes('native-value-width') && !shown.includes('native-prompt-stored'), 'no longer shown');
});
test('a prompt left to the assistant shows the default and the instruction stored with it, and keeps them', async t => {
  const f = await setup(t),
    record = structuredClone(f.template);
  await f.ui.edit(record);
  assert.equal(f.$('native-prompt-default'), null, 'nothing stored, nothing shown');
  assert.equal(f.$('native-prompt-description'), null);
  f.$('native-workflow-back').onclick();
  record.parameters.prompt = {
    policy: 'model',
    type: 'string',
    maxLength: 4000,
    default: 'Un chat roux',
    description: 'Décris la scène en anglais.',
  };
  await f.ui.edit(record);
  assert.equal(f.$('native-prompt-default').value, 'Un chat roux');
  assert.equal(f.$('native-prompt-default').readOnly, true);
  assert.equal(f.$('native-prompt-description').value, 'Décris la scène en anglais.');
  assert.equal(f.$('native-prompt-stored'), null);
  assert.equal(f.ui.editorDirty(false), false);
  f.$('native-workflow-description').value = 'Chats';
  assert.equal(await f.ui.saveEditor(), true, f.$('native-workflow-error').textContent);
  const saved = f.calls.findLast(call => call.route === 'generation/workflows').body;
  assert.deepEqual(saved.parameters.prompt, record.parameters.prompt);
});
test('the prompt of an imported graph is shown in its draft, and the draft saved untouched keeps it', async t => {
  const f = await setup(t),
    sourceText = JSON.stringify({
      1: { class_type: 'CLIPTextEncode', inputs: { text: 'a red fox in the snow' } },
      2: { class_type: 'KSampler', inputs: { steps: 22, cfg: 4, seed: 42, positive: ['1', 0] } },
    });
  await f.$('native-workflow-file').onchange({
    target: { files: [{ name: 'Graph.json', size: sourceText.length, text: async () => sourceText }], value: 'x' },
  });
  assert.equal(f.ui.isEditing(), true);
  assert.equal(f.$('native-prompt-stored').value, 'a red fox in the snow');
  assert.equal(await f.ui.saveEditor(), true, f.$('native-workflow-error').textContent);
  const saved = f.calls.findLast(call => call.route === 'generation/workflows').body;
  assert.ok(saved.importDraft);
  assert.deepEqual(saved.parameters.prompt, { policy: 'fixed', value: 'a red fox in the snow' });
  // Opened again and saved as it is: the same draft, to the last setting.
  const { workflowFingerprint } = await import('../lib/native-workflows.mjs');
  await f.ui.edit(structuredClone(saved));
  assert.equal(f.ui.editorDirty(false), false);
  assert.equal(await f.ui.saveEditor(), true, f.$('native-workflow-error').textContent);
  const again = f.calls.findLast(call => call.route === 'generation/workflows').body;
  assert.notEqual(again, saved);
  assert.equal(workflowFingerprint(again), workflowFingerprint(saved));
});
test('the seed is fixed or drawn; a seed left to the assistant stays shown, to be changed', async t => {
  const f = await setup(t);
  await f.ui.edit(f.template);
  assert.deepEqual(
    f.$('native-policy-seed').children.map(choice => choice.textContent),
    ['Fixe', 'Aléatoire'],
  );
  const record = structuredClone(f.template);
  record.parameters.seed = { policy: 'model', type: 'integer', default: 3 };
  f.$('native-workflow-back').onclick();
  await f.ui.edit(record);
  assert.deepEqual(
    f.$('native-policy-seed').children.map(choice => choice.textContent),
    ['Fixe', 'Aléatoire', 'Assistant'],
  );
  assert.equal(f.$('native-policy-seed').value, 'model');
});
test('Krea 2: a denoise of 1 with an image to modify is said to ignore it, until it is lowered', async t => {
  const f = await setup(t);
  await f.ui.edit(await shippedWorkflow('krea2'));
  const control = f.$('native-value-denoise'),
    note = noteOf(control),
    typed = value => {
      control.value = value;
      for (const listener of control.listeners.input) listener();
    };
  // The shipped workflow keeps a part of the image (0.6): nothing to warn of. It opens on
  // « Assistant », between 0.6 and 0.7, with what the assistant is told of it.
  assert.equal(control.value, 0.6);
  assert.equal(note.hidden, true);
  assert.equal(f.$('native-policy-denoise').value, 'model');
  assert.deepEqual([f.$('native-min-denoise').value, f.$('native-max-denoise').value], [0.6, 0.7]);
  assert.match(f.$('native-description-denoise').value, /^Only with an image to modify \(source\)/);
  assert.equal(f.$('native-description-denoise').hidden, false);
  // What the setting is, and that it only applies to an image given, is said whatever its value.
  const card = note.parent,
    help = card.children[card.children.indexOf(note) - 1];
  assert.equal(help.className, 'field-help');
  assert.match(help.textContent, /quand une image est donnée à modifier/);
  assert.match(help.textContent, /Sans image, l’image part toujours de zéro\./);
  // A workflow of the user's at 1: the image would be replaced entirely, and it is said.
  typed('1');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /image à modifier est ignorée/);
  assert.equal(control.dataset.unavailable, 'false', 'a warning, not greyed');
  typed('0.7');
  assert.equal(note.hidden, true);
  // Saved as it was opened, the setting is written as it is shipped.
  typed('0.6');
  assert.equal(await f.ui.saveEditor(), true, f.$('native-workflow-error').textContent);
  const saved = f.calls.findLast(call => call.route === 'generation/workflows').body;
  assert.deepEqual(saved.parameters.denoise, (await shippedWorkflow('krea2')).parameters.denoise);
});
