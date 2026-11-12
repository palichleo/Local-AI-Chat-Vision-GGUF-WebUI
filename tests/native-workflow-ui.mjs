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
  const document = { getElementById: $, createElement: tag => new Element(tag), activeElement: $('workflow-add') };
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

test('only seed offers random ownership', () => {
  assert.deepEqual(parameterPolicies('seed'), ['fixed', 'model', 'random']);
  assert.deepEqual(parameterPolicies('steps'), ['fixed', 'model']);
});

test('private setup progress refreshes without overwriting unsaved settings or blocking the editor', async t => {
  const f = await setup(t);
  f.$('generation-python').value = 'unsaved python';
  f.ui.updateRunner({ state: 'installing', progress: 'Installation des bibliothèques…' });
  assert.match(f.$('generation-status').textContent, /Préparation automatique.*bibliothèques/);
  assert.equal(f.$('generation-python').value, 'unsaved python');
  assert.equal(f.$('workflow-add').disabled, false);
  f.ui.updateRunner({ state: 'ready' });
  assert.match(f.$('generation-status').textContent, /Prêt/);
  assert.equal(f.$('generation-python').value, 'unsaved python');
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
    maxIterations: 5,
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

test('newly registered native files can become model-controlled allowed choices immediately', async t => {
  const f = await setup(t);
  await f.ui.edit(f.template);
  await f.$('native-component-model').parent.children[1].onclick();
  f.$('native-component-model-policy').value = 'model';
  f.$('native-component-model-policy').onchange();
  assert.equal(f.$('native-component-model').value, 'model-new');
  assert.equal(await f.ui.saveEditor(), true);
  const component = f.calls.find(call => call.route === 'generation/workflows').body.components.model;
  assert.equal(component.default, 'model-new');
  assert.ok(component.choices.includes('model-new'));
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
test('model-owned components and parameters can require a model choice without inventing defaults', async t => {
  const f = await setup(t),
    record = structuredClone(f.template);
  record.components.model = { policy: 'model', choices: ['model-one'], description: 'Choose the portrait checkpoint' };
  record.parameters.width = { policy: 'model', type: 'integer', min: 256, max: 1024 };
  await f.ui.edit(record);
  assert.equal(await f.ui.saveEditor(), true);
  const saved = f.calls.find(call => call.route === 'generation/workflows').body;
  assert.equal(Object.hasOwn(saved.components.model, 'default'), false);
  assert.equal(Object.hasOwn(saved.parameters.width, 'default'), false);
  assert.equal(saved.components.model.description, 'Choose the portrait checkpoint');
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
  await f.$('workflow-list').children.at(-1).children.at(-1).children.at(-1).onclick();
  assert.ok(f.calls.some(call => call.route === 'generation/workflows/' + record.id));
  assert.equal(f.$('native-reference-count').textContent, '4');
  assert.equal(f.$('native-value-cfg').value, 4);
});

test('Krea 2 is run by ComfyUI: its tokenizer is neither asked for nor proposed', async t => {
  const f = await setup(t),
    record = structuredClone(f.template);
  delete record.components.tokenizer;
  await f.ui.edit(record);
  await new Promise(resolve => setImmediate(resolve));
  const ids = element => [element.id, ...element.children.flatMap(ids)].filter(Boolean);
  assert.ok(ids(f.$('native-workflow-components')).includes('native-component-textEncoder'));
  assert.ok(!ids(f.$('native-workflow-components')).includes('native-component-tokenizer'));
  assert.deepEqual(f.tokenizerRequests, []);
  assert.equal(await f.ui.saveEditor(), true);
  assert.equal(f.workflows.at(-1).components.tokenizer, undefined);
});

test('workflows are listed by engine: the built-in one, then ComfyUI with its address', async t => {
  const f = await setup(t);
  const list = f.$('workflow-list').children;
  const sections = list.filter(item => item.className === 'workflow-section');
  assert.deepEqual(
    sections.map(section => section.children[0].textContent),
    ['Moteur interne', 'Moteur externe · ComfyUI'],
  );
  // Nothing of the built-in engine in this installation; Krea 2 is ComfyUI's.
  assert.equal(list[list.indexOf(sections[0]) + 1].textContent, 'Aucun workflow.');
  assert.equal(list.at(-1).className, 'workflow-card');
  const panel = sections[1].children.at(-1),
    ids = element => [element.id, ...element.children.flatMap(ids)].filter(Boolean);
  assert.equal(panel.className, 'comfy-panel');
  assert.ok(ids(panel).includes('comfy-url') && ids(panel).includes('comfy-enabled'));
  // Saving the address goes to the server, whose answer redraws the list.
  f.$('comfy-url').value = ' http://127.0.0.1:7821 ';
  f.$('comfy-enabled').checked = true;
  await panel.children.at(-1).children.at(-1).onclick();
  assert.deepEqual(f.calls.at(-1), {
    route: 'generation/comfy',
    body: { enabled: true, baseUrl: 'http://127.0.0.1:7821', own: [] },
  });
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
