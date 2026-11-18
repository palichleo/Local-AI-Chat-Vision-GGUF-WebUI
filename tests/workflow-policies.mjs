import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { familyCatalog } from '../lib/families.mjs';
import { CAPABLE } from '../lib/model-wording.mjs';
import {
  NativeWorkflowCatalog,
  resolveNativeWorkflow,
  validateNativeWorkflow,
  workflowFingerprint,
} from '../lib/native-workflows.mjs';
import { STUDIO_ID } from '../lib/studio.mjs';
import { ToolCatalog } from '../lib/tool-catalog.mjs';
import { ToolRuntime } from '../lib/tool-runtime.mjs';
import { renderProposal } from '../public/video-plan.mjs';

/*
 * Audit of lot 6 (0.6.94): does a policy chosen in Paramètres › Workflows — « Fixe », « Assistant »,
 * « Aléatoire » for the seed; « Désactivé / Activé / Assistant » for a LoRA; « Fixe / Assistant » for a
 * file — change what is made, on each of the three ways a creation is asked: (a) the Chat with Moodix
 * AI, (b) the Studio by hand, (c) the Studio set by Moodix AI? Each test follows a setting from the
 * workflow to the job the engine receives, through the real router (lib/tool-catalog.mjs), runtime
 * (lib/tool-runtime.mjs), catalog (lib/native-workflows.mjs), Studio page (public/studio.mjs) and
 * editor (public/native-workflow-ui.mjs). They state what the application does at 0.6.90, flaws
 * included: a test whose name begins with « today » describes a flaw the correction is to turn round.
 */

const folder = fileURLToPath(new URL('../runner/workflows/', import.meta.url)),
  HISTORY = fileURLToPath(new URL('../runner/workflow-history.json', import.meta.url));
/** The shipped workflow of a family, as its file stores it. */
function stored(pipeline) {
  for (const file of readdirSync(folder).filter(name => name.endsWith('.json'))) {
    const workflow = JSON.parse(readFileSync(join(folder, file), 'utf8'));
    if (workflow.pipeline === pipeline) return workflow;
  }
  throw Error('No shipped workflow for ' + pipeline);
}
/** A shipped workflow with parameters set as the editor writes them (undefined removes one), ready. */
function variant(pipeline, parameters = {}, more = {}) {
  const workflow = { ...stored(pipeline), ...more };
  workflow.parameters = { ...workflow.parameters, ...parameters };
  for (const [name, policy] of Object.entries(parameters)) if (policy === undefined) delete workflow.parameters[name];
  return { ...validateNativeWorkflow(workflow), ready: true };
}
const FIXED = value => ({ policy: 'fixed', value });
// Every file of a workflow is here.
const files = {
  resolve: async (id, { kind } = {}) => ({ id, kind, path: join(tmpdir(), 'moodix-lot6', `${kind ?? 'file'}-${id}`) }),
  pick: async role => ({ path: join(tmpdir(), 'moodix-lot6', role) }),
};
const CONVERSATION = '61616161-6161-4161-8161-616161616161';
const settle = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, tries = 500) => {
  for (let at = 0; at < tries && !check(); at++) await settle(2);
};

/**
 * The application around its workflows, everything else in memory: the gallery, the chat model,
 * the generator (which keeps each job it is given: `jobs`). `workflows` may be replaced (a workflow
 * saved in Paramètres meanwhile).
 */
function world(workflows) {
  const w = { workflows, jobs: [], saved: [] };
  const client = {
    status: async () => ({ idle: true }),
    stage: async () => ({ path: join(tmpdir(), 'staged') }),
    upload: async () => ({ path: join(tmpdir(), 'uploaded.png') }),
    preflight: async () => {},
    run: async job => {
      w.jobs.push(structuredClone(job));
      return { outputs: [{ filename: 'made.png', subfolder: '', type: 'output' }], metadata: { parameters: job.parameters } };
    },
    free: async () => ({}),
  };
  const engine = {
    busy: false,
    state: 'ready',
    stop: async () => void (engine.state = 'stopped'),
    start: async () => void (engine.state = 'ready'),
  };
  const catalog = {
    kind: 'native',
    list: async () => w.workflows,
    read: async id => w.workflows.find(workflow => workflow.id === id),
    prepare: async (id, args, options) => {
      const workflow = w.workflows.find(item => item.id === id);
      return { workflow, job: await resolveNativeWorkflow(workflow, args, files, options), outputNodes: [] };
    },
  };
  w.runtime = new ToolRuntime({
    engine,
    catalog,
    gallery: {
      get: async (conversationId, id) => {
        const record = w.saved.find(item => item.id === id);
        if (!record) throw Object.assign(Error('Entrée introuvable.'), { status: 404 });
        return structuredClone(record);
      },
      put: async record => {
        w.saved.unshift(record);
        return record;
      },
    },
    resources: {
      activeRecord: async () => {
        throw Object.assign(Error('Ressource introuvable.'), { status: 404 });
      },
      used: async () => {},
    },
    getConfig: () => ({ enabled: true, autoAllow: false, autoAllowVideos: false, maxIterations: 100, baseUrl: 'native' }),
    engineConfig: () => ({}),
    clientFactory: () => client,
    sourceMedia: async () => {
      throw Error('No source in these tests.');
    },
  });
  w.tools = new ToolCatalog(catalog);
  return w;
}
/** A call of the chat model, as Moodix AI makes it. */
const ask = (w, name, args) =>
  w.runtime.request(
    [{ id: 'call_' + randomUUID().slice(0, 8), type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    { conversationId: CONVERSATION, turnId: randomUUID(), messages: [] },
  );
const revise = (w, proposal, edits) =>
  w.runtime.revise({ requestId: proposal.requestId, approvalToken: proposal.approvalToken, edits });
/** « Générer » on a proposal: the job the engine is given. */
async function make(w, proposal, { studio = false } = {}) {
  await w.runtime.execute({
    requestId: proposal.requestId,
    permission: 'once',
    approvalToken: proposal.approvalToken,
    studio,
  });
  await w.runtime.finished;
  assert.equal(w.runtime.status().state, 'done', w.runtime.status().error);
  return w.jobs.at(-1);
}
/** The arguments of a verb the model is offered for these workflows. */
async function offered(workflows, name, options) {
  const tools = await new ToolCatalog({ list: async () => workflows }).definitions(undefined, options);
  return tools.find(tool => tool.function.name === name)?.function.parameters;
}
const editableOf = (proposal, key) => proposal.plan.editable.parameters.find(item => item.key === key);

/**
 * The Studio page, in memory (as tests/studio.mjs draws it), on the real server side: its tools are
 * those ToolCatalog.studio() gives for the workflows of `w`, « Générer » goes through the runtime
 * (tools/action, tools/revise) and the creation is made there (`run`, as the page of a conversation
 * does). `runs`: the creations of the conversation (the takes of `w` by default).
 */
async function studioPage(w, { runs = null } = {}) {
  class Element {
    constructor(tag = '', className = '', textContent = '') {
      Object.assign(this, { tag, className, textContent, children: [], style: {}, dataset: {} });
      this.classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
    }
    append(...nodes) {
      this.children.push(...nodes);
    }
    prepend(...nodes) {
      this.children.unshift(...nodes);
    }
    replaceChildren(...nodes) {
      this.children = nodes;
    }
    add(option) {
      this.children.push(option);
    }
    setAttribute(name, value) {
      (this.attributes ??= {})[name] = value;
    }
    removeAttribute(name) {
      delete this.attributes?.[name];
    }
    querySelector() {
      return new Element();
    }
    querySelectorAll() {
      return [];
    }
    addEventListener(type, listener) {
      (this.listeners ??= {})[type] = listener;
    }
    click() {}
    /** Every element under this one whose classes include `name`. */
    find(name) {
      return this.children.flatMap(child =>
        child instanceof Element
          ? [...(child.className.split(' ').includes(name) ? [child] : []), ...child.find(name)]
          : [],
      );
    }
  }
  const page = Object.fromEntries(
    ['studio-view', 'studio-kinds', 'studio-body', 'ai-status', 'ai-takeover'].map(id => [id, new Element()]),
  );
  // The pointer of Moodix AI: what it says is kept in `said`.
  const said = [],
    classes = new Set();
  page['ai-cursor'] = {
    hidden: true,
    style: { setProperty() {} },
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      contains: name => classes.has(name),
    },
    querySelector: () => null,
  };
  page['ai-cursor-text'] = {
    set textContent(label) {
      if (label) said.push(label);
    },
  };
  const globals = {
    document: {
      getElementById: id => page[id] ?? null,
      querySelector: () => ({
        getBoundingClientRect: () => ({ left: 100, top: 100, width: 40, height: 40 }),
        scrollIntoView() {},
        style: { setProperty() {} },
        classList: { toggle() {} },
        querySelector: () => null,
        setAttribute() {},
      }),
      body: {},
      addEventListener() {},
    },
    Option: class {},
    ResizeObserver: undefined,
  };
  const before = Object.fromEntries(Object.keys(globals).map(key => [key, globalThis[key]]));
  Object.assign(globalThis, globals);
  const { setupStudio } = await import('../public/studio.mjs');
  const asked = [],
    notices = [];
  async function serve(route, body) {
    if (route === 'studio')
      return { enabled: true, legacyId: STUDIO_ID, styles: [], tools: await w.tools.studio(), presets: {} };
    if (route.startsWith('project-gallery/') || route.startsWith('gallery/')) return { runs: runs ?? w.saved };
    // As server.mjs answers « Générer » (/api/tools/action): a call made of the Studio's arguments.
    if (route === 'tools/action')
      return w.runtime.request(
        [
          {
            id: 'action' + randomUUID().replaceAll('-', '').slice(0, 24),
            type: 'function',
            function: { name: body.name, arguments: JSON.stringify(body.arguments) },
          },
        ],
        {
          conversationId: body.conversationId,
          turnId: randomUUID(),
          messages: [],
          ...(body.styles !== undefined ? { styles: body.styles } : {}),
          // (The user's own hand, 0.6.94.)
          byHand: true,
        },
      );
    if (route === 'tools/revise') return w.runtime.revise(body);
    return {};
  }
  const studio = setupStudio({
    api: async (route, body) => {
      asked.push([route, structuredClone(body)]);
      const answer = await serve(route, body);
      return { json: async () => answer };
    },
    node: (tag, className, text) => new Element(tag, className, text),
    icon: glyph => Object.assign(new Element('svg'), { glyph }),
    notice: text => notices.push(text),
    assets: { importFiles: async () => [], resource: () => null },
    viewOutput() {},
    waitForModel: async () => {},
    blocked: () => '',
    onChange() {},
    conversation: () => CONVERSATION,
    project: () => 'p1',
    ensureConversation: async () => CONVERSATION,
    reveal: () => {},
    pace: 0,
    // The page of a conversation makes the creation approved (app.js): here, the runtime at once.
    run: async proposed => {
      await w.runtime.execute({
        requestId: proposed.requestId,
        permission: 'once',
        approvalToken: proposed.approvalToken,
        studio: true,
      });
      await w.runtime.finished;
      const status = w.runtime.status();
      return status.record ? { record: status.record } : { error: status.error };
    },
  });
  await studio.open();
  const body = page['studio-body'];
  return {
    studio,
    page,
    body,
    asked,
    said,
    notices,
    restore: () => Object.assign(globalThis, before),
    prompt: () => body.find('studio-prompt-field')[0].children[0],
    /** Image, Vidéo or Son, by its place. */
    mode: index => page['studio-kinds'].children[index].onclick(),
    /** The field of a rare setting (« Plus de réglages »), by the name it shows. */
    field: label =>
      body
        .find('studio-rare')[0]
        ?.find('studio-field')
        .find(item => item.children[0]?.textContent === label)?.children[1] ?? null,
    /** « Générer », then the job the engine was given. */
    async generate() {
      const before = w.jobs.length;
      await body.find('studio-go')[0].onclick();
      await settle();
      return w.jobs.length > before ? w.jobs.at(-1) : null;
    },
    /** What the Studio sent with its last « Générer » (tools/action), and its edits (tools/revise). */
    lastAction: () => asked.findLast(([route]) => route === 'tools/action')?.[1],
    lastRevise: () => asked.findLast(([route]) => route === 'tools/revise')?.[1],
  };
}
/** Writes a prompt in the Studio, as the user types it. */
function write(page, text) {
  page.prompt().value = text;
  page.prompt().oninput();
}

// ------------------------------------------------------------------ (a) the Chat with Moodix AI

test('Chat · « Fixe » takes a setting out of the tool the model is given; « Assistant » puts it there with its default, bounds and instruction', async () => {
  const fixed = variant('krea2'),
    assistant = variant('krea2', {
      steps: { policy: 'model', type: 'integer', default: 8, min: 1, max: 50, description: 'CONSIGNE-ETAPES' },
    });
  assert.deepEqual(fixed.parameters.steps, FIXED(8), 'the shipped Krea 2 fixes its steps');
  // The small local model (rails) and a capable one (ChatGPT, Claude, OpenRouter) get the same.
  for (const options of [undefined, { wording: CAPABLE }]) {
    const where = options ? 'capable' : 'rails';
    assert.equal((await offered([fixed], 'create_image', options)).properties.steps, undefined, where);
    const tool = await offered([assistant], 'create_image', options);
    assert.deepEqual(
      tool.properties.steps,
      { type: 'integer', minimum: 1, maximum: 50, description: 'CONSIGNE-ETAPES', default: 8 },
      where,
    );
    assert.equal(tool.required.includes('steps'), false, `${where}: optional, its default stands for it`);
  }
});

test('Chat · a value the model sends for a « Fixe » setting is left aside with a note; for an « Assistant » one it is the value made, up to the engine', async () => {
  const fixed = variant('krea2'),
    assistant = variant('krea2', { steps: { policy: 'model', type: 'integer', default: 8, min: 1, max: 50 } });
  for (const [workflow, made, notes] of [
    [fixed, 8, ['steps ignoré : fixé par le workflow Krea 2.']],
    [assistant, 20, undefined],
  ]) {
    const w = world([workflow]),
      proposal = await ask(w, 'create_image', { prompt: 'Un renard dans la neige', steps: 20 });
    assert.equal(proposal.plan.parameters.steps, made, workflow.parameters.steps.policy);
    assert.deepEqual(proposal.notes, notes);
    const job = await make(w, proposal);
    assert.equal(job.parameters.steps, made, 'what the engine receives');
    // The note goes with the take (and with the result the model reads, generation-runtime.mjs).
    assert.deepEqual(w.saved[0].parameters.routing_notes, notes);
  }
  // Nothing passed: the fixed value, or the default of « Assistant », the same images either way.
  for (const workflow of [fixed, assistant]) {
    const w = world([workflow]);
    assert.equal((await make(w, await ask(w, 'create_image', { prompt: 'Un renard' }))).parameters.steps, 8);
  }
});

test('an « Assistant » setting saved without a default takes the value its family gives a new workflow, within its bounds; with none to take, it is asked for in French', async () => {
  // (0.6.94) Every call that left it out was refused, in English (« steps is required »), the Studio's too.
  const bare = variant('krea2', { steps: { policy: 'model', type: 'integer', min: 1, max: 50 } }),
    tool = await offered([bare], 'create_image');
  // The value made when the model names none is said to it as the default (the template of Krea 2: 8).
  assert.equal(tool.properties.steps.default, 8);
  assert.equal(tool.required.includes('steps'), false);
  const w = world([bare]);
  assert.equal((await make(w, await ask(w, 'create_image', { prompt: 'Un renard' }))).parameters.steps, 8);
  assert.equal((await make(w, await ask(w, 'create_image', { prompt: 'Un renard', steps: 20 }))).parameters.steps, 20);
  // The Studio shows it in its field (b).
  const [krea] = (await w.tools.studio()).create_image;
  assert.deepEqual(krea.settings.find(setting => setting.key === 'steps'), {
    key: 'steps',
    type: 'integer',
    min: 1,
    max: 50,
    default: 8,
  });
  // Brought within the bounds of the workflow: from 20 to 50, the nearest is 20.
  const high = world([variant('krea2', { steps: { policy: 'model', type: 'integer', min: 20, max: 50 } })]);
  assert.equal((await make(high, await ask(high, 'create_image', { prompt: 'Un renard' }))).parameters.steps, 20);
  // A LoRA saved so: off unless it is switched on, at the strength a LoRA starts with in the editor (1),
  // within its bounds.
  const style = {
      id: 'style',
      asset: '1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e',
      description: 'Lumière de cinéma',
      enabled: { policy: 'model' },
      strength: { policy: 'model', type: 'number', min: 0, max: 0.5 },
    },
    lora = world([variant('krea2', {}, { loras: [style] })]);
  assert.deepEqual((await make(lora, await ask(lora, 'create_image', { prompt: 'Un renard' }))).loras, []);
  const on = await make(lora, await ask(lora, 'create_image', { prompt: 'Un renard', loras: { style: { enabled: true } } }));
  assert.deepEqual(on.loras.map(item => [item.id, item.strength]), [['style', 0.5]]);
  const [shownLora] = (await lora.tools.studio()).create_image[0].loras;
  assert.deepEqual([shownLora.on, shownLora.strength], [false, { min: 0, max: 0.5, default: 0.5 }], 'the Studio says the same');
  // Nothing to take (the template of LTX 2.5 has no strength for its subject references): asked
  // for, under the name the editor shows, with what to do.
  const msr = world([variant('ltx25', { msr_strength: { policy: 'model', type: 'number', min: 0, max: 1 } })]);
  await assert.rejects(ask(msr, 'create_video', { prompt: 'Un renard court', intention: 'Essai', duration: 2 }), {
    status: 400,
    message:
      'Influence des références MSR : aucune valeur donnée, et ce workflow n’en a pas par défaut. Choisissez-en une dans Paramètres › Workflows.',
  });
});

test('Chat · the card of a proposal lets the user change a « Fixe » setting too, within the bounds of the family: wider than those of « Assistant »', async () => {
  // MOSS-SoundEffect: a sound waits for « Générer » on its card in the Chat.
  const fixed = variant('moss_sfx'),
    assistant = variant('moss_sfx', { steps: { policy: 'model', type: 'integer', default: 100, min: 50, max: 120 } });
  assert.deepEqual(fixed.parameters.steps, FIXED(100));
  const fromFixed = await ask(world([fixed]), 'create_audio', { prompt: 'Une porte qui grince', seconds: 3 });
  // Listed as a setting to change, as the one left to the assistant, with the limits of the family.
  assert.deepEqual(editableOf(fromFixed, 'steps'), { key: 'steps', value: 100, type: 'integer', min: 1, max: 200 });
  const wf = world([fixed]),
    card = await ask(wf, 'create_audio', { prompt: 'Une porte qui grince', seconds: 3 }),
    changed = await revise(wf, card, { steps: 180 });
  assert.deepEqual(changed.plan.edited, ['steps']);
  assert.equal((await make(wf, changed)).parameters.steps, 180, '« Fixe » changed by the user, made so');
  // Left to the assistant between 50 and 120, the user is held to those bounds.
  const wa = world([assistant]),
    asked = await ask(wa, 'create_audio', { prompt: 'Une porte qui grince', seconds: 3 });
  assert.deepEqual(editableOf(asked, 'steps'), { key: 'steps', value: 100, type: 'integer', min: 50, max: 120 });
  await assert.rejects(revise(wa, asked, { steps: 180 }), /Étapes : entre 50 et 120\./);
  // The card draws both the same way: a field to type in (public/video-plan.mjs), no padlock, no word
  // that one is fixed in the workflow.
  for (const proposal of [fromFixed, asked]) {
    const control = advancedControl(proposal, 'Étapes');
    assert.equal(control?.tag, 'input', 'a field to type in');
  }
});

/** The control of a setting under « Paramètres avancés » on the card of a proposal, by its label. */
function advancedControl(request, label) {
  class Node {
    constructor(tag = '', className = '', textContent = '') {
      Object.assign(this, { tag, className, textContent, children: [], dataset: {}, hidden: false });
      this.style = { setProperty() {} };
      this.classList = { toggle() {}, add() {}, remove() {} };
    }
    append(...nodes) {
      this.children.push(...nodes);
    }
    replaceChildren(...nodes) {
      this.children = nodes;
    }
    add(option) {
      this.children.push(option);
    }
    setAttribute() {}
    addEventListener() {}
  }
  const previous = globalThis.Option;
  globalThis.Option = class {};
  try {
    const form = renderProposal(new Node(), request, { node: (...args) => new Node(...args), card: true });
    const panel = form.folds.find(fold => fold.name === 'Paramètres avancés')?.panel;
    const line = panel?.children.find(child => child.children?.[0]?.textContent === label);
    return line?.children[1] ?? null;
  } finally {
    globalThis.Option = previous;
  }
}

test('Chat · « Aléatoire » draws the seed and takes one the user names; « Fixe » keeps its own whatever the model says', async () => {
  const drawn = variant('krea2'),
    kept = variant('krea2', { seed: FIXED(1234) });
  assert.equal((await offered([kept], 'create_image')).properties.seed, undefined);
  assert.ok((await offered([drawn], 'create_image')).properties.seed);
  const w = world([kept]),
    proposal = await ask(w, 'create_image', { prompt: 'Un renard', seed: 42 });
  assert.deepEqual(proposal.notes, ['seed ignoré : Krea 2 fixe le sien']);
  assert.equal((await make(w, proposal)).parameters.seed, 1234);
  const v = world([drawn]);
  assert.equal((await make(v, await ask(v, 'create_image', { prompt: 'Un renard', seed: 42 }))).parameters.seed, 42);
});

test('today · a file left to « Assistant » is offered to the model as bare identifiers, and the Studio has no choice of it', async () => {
  const krea = stored('krea2'),
    vae = krea.components.vae.asset,
    other = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
    chosen = variant('krea2', {}, { components: { ...krea.components, vae: { policy: 'model', choices: [vae, other], default: vae } } });
  for (const options of [undefined, { wording: CAPABLE }]) {
    const tool = await offered([chosen], 'create_image', options);
    // Two identifiers and nothing to tell them apart: neither the name of a file nor what it does.
    assert.deepEqual(tool.properties.components.properties.vae, { type: 'string', enum: [vae, other], default: vae });
  }
  const w = world([chosen]),
    [shown] = (await w.tools.studio()).create_image;
  assert.equal('components' in shown, false, 'nothing of it in the Studio');
});

test('a file left to « Assistant » without a default: the only one allowed stands in; with several, it is asked for in French', async () => {
  // (0.6.94) Every creation was refused, in English (« Select an allowed vae asset »).
  const krea = stored('krea2'),
    vae = krea.components.vae.asset,
    other = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
    only = variant('krea2', {}, { components: { ...krea.components, vae: { policy: 'model', choices: [vae] } } });
  assert.deepEqual((await offered([only], 'create_image')).properties.components.properties.vae, {
    type: 'string',
    enum: [vae],
    default: vae,
  });
  const w = world([only]);
  assert.match((await make(w, await ask(w, 'create_image', { prompt: 'Un renard' }))).components.vae, new RegExp(vae));
  const several = variant('krea2', {}, { components: { ...krea.components, vae: { policy: 'model', choices: [vae, other] } } });
  await assert.rejects(ask(world([several]), 'create_image', { prompt: 'Un renard' }), {
    status: 400,
    message:
      '« VAE » : aucun fichier par défaut dans ce workflow, et aucun n’a été choisi. Choisissez-en un dans Paramètres › Workflows.',
  });
  // A file it does not allow, named all the same.
  await assert.rejects(
    ask(world([several]), 'create_image', { prompt: 'Un renard', components: { vae: '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e' } }),
    { status: 400, message: '« VAE » : ce fichier n’est pas parmi ceux que ce workflow autorise.' },
  );
});

test('a LoRA the workflow fixes, named by the model all the same: the same value is taken, another is left aside and said, the call is never refused', async () => {
  // (0.6.94) A LoRA « Activé » named by a capable model (held by no grammar) had the whole call
  // refused: « enabled is fixed; a locked parameter cannot be overridden ».
  const lora = {
    id: 'style',
    asset: '1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e',
    description: 'Lumière de cinéma',
    enabled: FIXED(true),
    strength: FIXED(0.8),
  };
  const always = variant('krea2', {}, { loras: [lora] }),
    left = variant('krea2', {}, { loras: [{ ...lora, enabled: { policy: 'model', default: false } }] }),
    off = variant('krea2', {}, { loras: [{ ...lora, enabled: { policy: 'off' } }] });
  assert.equal((await offered([always], 'create_image')).properties.loras, undefined);
  assert.deepEqual((await offered([left], 'create_image')).properties.loras.properties.style.properties, {
    enabled: { type: 'boolean', default: false },
  });
  const made = async (workflow, loras) => {
    const w = world([workflow]),
      proposal = await ask(w, 'create_image', { prompt: 'Un renard', ...(loras ? { loras } : {}) }),
      job = await make(w, proposal);
    return [job.loras.map(item => [item.id, item.strength]), proposal.notes];
  };
  // Always on, at its strength, without a word of the model.
  assert.deepEqual(await made(always), [[['style', 0.8]], undefined]);
  // Said as the workflow has it: taken, nothing to say.
  assert.deepEqual(await made(always, { style: { enabled: true } }), [[['style', 0.8]], undefined]);
  assert.deepEqual(await made(always, { style: { enabled: true, strength: 0.8 } }), [[['style', 0.8]], undefined]);
  // Said otherwise: left aside, and said on the proposal (and to the model with its result).
  assert.deepEqual(await made(always, { style: { enabled: false } }), [
    [['style', 0.8]],
    ['LoRA « Lumière de cinéma » gardé : toujours activé dans le workflow Krea 2.'],
  ]);
  assert.deepEqual(await made(always, { style: { strength: 0.3 } }), [
    [['style', 0.8]],
    ['Intensité du LoRA « Lumière de cinéma » ignorée : 0,8, fixée par le workflow Krea 2.'],
  ]);
  // « Désactivé »: never on.
  assert.deepEqual(await made(off, { style: { enabled: true } }), [
    [],
    ['LoRA « Lumière de cinéma » ignoré : désactivé dans le workflow Krea 2.'],
  ]);
  assert.deepEqual(await made(off, { style: { enabled: false } }), [[], undefined]);
  // « Assistant », off by default: off unless the model switches it on; a strength for it off is left aside.
  assert.deepEqual(await made(left), [[], undefined]);
  assert.deepEqual(await made(left, { style: { enabled: true } }), [[['style', 0.8]], undefined]);
  assert.deepEqual(await made(left, { style: { strength: 0.5 } }), [
    [],
    ['Intensité du LoRA « Lumière de cinéma » ignorée : ce LoRA n’est pas activé.'],
  ]);
  assert.deepEqual(await made(left, { style: { enabled: false, strength: 0.5 } }), [[], undefined]);
});

test('today · what the editor asks of a reference slot (« Description ») never reaches the model; « Référence obligatoire » is refused after the call', async () => {
  const krea = stored('krea2'),
    [source] = krea.references,
    asked = variant('krea2', {}, { references: [{ ...source, description: 'CONSIGNE-REFERENCE', required: true }] });
  for (const options of [undefined, { wording: CAPABLE }]) {
    const tool = await offered([asked], 'create_image', options);
    assert.equal(JSON.stringify(tool).includes('CONSIGNE-REFERENCE'), false, options ? 'capable' : 'rails');
    // (It is in workflowSchema(), which the verbs do not use but for its LoRAs and files.)
    assert.equal(tool.required.includes('source'), false, 'nor is the image required in the tool');
  }
  // (Said in French since 0.6.94: « Source image is required » was read by the user too.)
  await assert.rejects(
    ask(world([asked]), 'create_image', { prompt: 'Un renard' }),
    /Aucun workflow ne correspond à ces entrées pour create_image\. .*« Source image » est obligatoire dans ce workflow/,
  );
  // The Studio requires it, in the words of a character put in a video.
  const w = world([asked]),
    page = await studioPage(w);
  try {
    write(page, 'Un renard');
    assert.equal(await page.generate(), null);
    assert.equal(page.body.find('studio-error')[0]?.textContent, 'Ajoutez l’image du personnage.');
  } finally {
    page.restore();
  }
});

// ------------------------------------------------------------------ (b) the Studio by hand

test('Studio · its own settings are those left to « Assistant »: a « Fixe » one is not shown, and the job keeps its value', async () => {
  const assistant = variant('krea2', { steps: { policy: 'model', type: 'integer', default: 8, min: 1, max: 50 } });
  const [shownFixed] = (await world([variant('krea2')]).tools.studio()).create_image,
    [shownAssistant] = (await world([assistant]).tools.studio()).create_image;
  assert.deepEqual(shownFixed.settings.map(setting => setting.key), ['denoise']);
  assert.deepEqual(
    shownAssistant.settings.find(setting => setting.key === 'steps'),
    { key: 'steps', type: 'integer', min: 1, max: 50, default: 8 },
  );
  // By hand: set in « Plus de réglages », it is what is made.
  const w = world([assistant]),
    page = await studioPage(w);
  try {
    write(page, 'Un renard dans la neige');
    const steps = page.field('steps');
    assert.equal(steps.value, '8', 'the default of the workflow');
    steps.value = '20';
    steps.oninput();
    assert.equal((await page.generate()).parameters.steps, 20);
    assert.equal(page.lastAction().arguments.steps, 20);
  } finally {
    page.restore();
  }
  const v = world([variant('krea2')]),
    fixedPage = await studioPage(v);
  try {
    write(fixedPage, 'Un renard dans la neige');
    assert.equal(fixedPage.field('steps'), null, 'no field for a fixed setting');
    assert.equal((await fixedPage.generate()).parameters.steps, 8);
  } finally {
    fixedPage.restore();
  }
});

test('today · Studio · a value typed beyond the bounds of « Assistant »: a whole number refuses the creation, a decimal is brought back without a word', async () => {
  const sfx = variant('moss_sfx', {
      steps: { policy: 'model', type: 'integer', default: 100, min: 50, max: 120 },
      guidance_scale: { policy: 'model', type: 'number', default: 4, min: 1, max: 8 },
    }),
    w = world([sfx]),
    page = await studioPage(w);
  try {
    page.mode(2);
    write(page, 'Une porte qui grince');
    assert.equal(page.field('guidance_scale').max, '8', 'the field says its bounds, and takes more');
    page.field('steps').value = '500';
    page.field('steps').oninput();
    assert.equal(await page.generate(), null);
    // (In French since 0.6.94, where « steps is outside the supported range » was said.)
    assert.equal(page.body.find('studio-error')[0]?.textContent, 'Étapes : entre 50 et 120.');
    page.field('steps').value = '100';
    page.field('steps').oninput();
    page.field('guidance_scale').value = '12';
    page.field('guidance_scale').oninput();
    const job = await page.generate();
    assert.equal(job.parameters.guidance_scale, 8, 'made at 8, the Studio still showing 12');
    // Said to the router's record only.
    assert.deepEqual(w.saved[0].parameters.routing_notes, ['guidance_scale : 12 → 8, la limite de Bruitages (MOSS-SoundEffect v2).']);
  } finally {
    page.restore();
  }
});

test('today · Studio · a size « Fixe » (Krea 2) is the size of the Studio all the same: the bar of resolution and the formats stay, and win', async () => {
  // The template of a new Krea 2 workflow fixes its size at 1024 × 1024 (runner/families/krea2.json).
  const square = variant('krea2', { width: FIXED(1024), height: FIXED(1024) }),
    w = world([square]),
    [shown] = (await w.tools.studio()).create_image;
  assert.equal(shown.direct, false, 'the size is not the model’s');
  assert.deepEqual(shown.size, { width: 1024, height: 1024 });
  assert.ok(shown.limits.width && shown.limits.height, 'yet the Studio is given sizes to offer');
  // In the Chat the size stays the workflow's: no format for an image, a size the model gives is left aside.
  const chat = await ask(w, 'create_image', { prompt: 'Un renard', width: 1344, height: 768 });
  assert.deepEqual([chat.plan.parameters.width, chat.plan.parameters.height], [1024, 1024]);
  assert.deepEqual(chat.notes, ['width ignoré : fixé par le workflow Krea 2.', 'height ignoré : fixé par le workflow Krea 2.']);
  const page = await studioPage(w);
  try {
    write(page, 'Un renard dans la neige');
    page.body.find('studio-format').find(chip => chip.children[0]?.textContent === '16:9').onclick();
    const job = await page.generate();
    // Sent as the user's own edit of the proposal (tools/revise), which may change what is fixed.
    const { width, height } = page.lastRevise().edits;
    assert.ok(width > height, `a landscape size was sent: ${width} × ${height}`);
    assert.deepEqual([job.parameters.width, job.parameters.height], [width, height], 'made at the size of the Studio');
    assert.deepEqual(w.saved[0].parameters.user_overrides, { width, height });
  } finally {
    page.restore();
  }
});

test('today · Studio · « Vidéo finale » fixed in LTX 2.5: by hand the final is made at the size of the draft', async () => {
  const final = variant('ltx25', { stage: FIXED('final') }),
    w = world([final]),
    [shown] = (await w.tools.studio()).create_video;
  assert.equal(shown.stages, false);
  // The Studio starts from the size of the draft profile, whatever version the workflow makes.
  assert.deepEqual(final.profiles.draft.parameters, { width: 288, height: 512, steps: 8, frames: 25, fps: 24 });
  assert.deepEqual(shown.size, { width: 288, height: 512 });
  assert.deepEqual(shown.final, { width: 896, height: 1600 });
  // The Chat makes its final at the size of the final profile.
  const chat = await ask(w, 'create_video', { prompt: 'Un renard court', intention: 'Essai', duration: 5 });
  assert.deepEqual([chat.plan.stage, chat.plan.parameters.width, chat.plan.parameters.height], ['final', 896, 1600]);
  const page = await studioPage(w);
  try {
    page.mode(1);
    write(page, 'Un renard court dans la neige');
    const job = await page.generate();
    assert.equal(job.parameters.stage, 'final');
    assert.deepEqual([job.parameters.width, job.parameters.height], [288, 512], 'a final at the size of the draft');
    assert.deepEqual(page.lastRevise().edits, { width: 288, height: 512 });
  } finally {
    page.restore();
  }
});

test('today · Studio · a workflow saved in Paramètres while the Studio is on screen: the Studio keeps the settings of before until another view is opened', async () => {
  const assistant = variant('krea2', { steps: { policy: 'model', type: 'integer', default: 8, min: 1, max: 50 } }),
    w = world([assistant]),
    page = await studioPage(w);
  try {
    write(page, 'Un renard dans la neige');
    page.field('steps').value = '20';
    page.field('steps').oninput();
    // « Étapes » set to « Fixe » in Paramètres › Workflows, saved; the settings closed (app.js tells the
    // Studio its tools are stale, nothing more: the Studio is on screen under the dialog).
    w.workflows = [variant('krea2')];
    page.studio.invalidate({ tools: true });
    page.body.find('studio-more-pill')[0].onclick();
    assert.equal(page.field('steps')?.value, '20', 'still shown, at the value set before');
    const job = await page.generate();
    assert.equal(page.lastAction().arguments.steps, 20, 'still sent');
    assert.equal(job.parameters.steps, 8, 'made with the fixed value');
    // What the router says of it is in the record of the take, not on the screen of the Studio.
    assert.deepEqual(w.saved[0].parameters.routing_notes, ['steps ignoré : fixé par le workflow Krea 2.']);
    assert.equal(page.body.find('studio-proposal-note').length, 0);
    // The Studio reads its tools again when it comes on screen again (another view, then back).
    await page.studio.open();
    await settle();
    assert.equal(page.field('steps'), null);
  } finally {
    page.restore();
  }
});

test('today · Studio · a default changed in Paramètres does not reach the Studio of a conversation that has a take: the take’s value is sent', async () => {
  const at = steps => variant('krea2', { steps: { policy: 'model', type: 'integer', default: steps, min: 1, max: 50 } }),
    w = world([at(8)]);
  // A take of the conversation, made at the default of then.
  await make(w, await ask(w, 'create_image', { prompt: 'Un renard' }));
  assert.equal(w.saved[0].parameters.steps, 8);
  // The default is 12 now (Paramètres › Workflows).
  w.workflows = [at(12)];
  const page = await studioPage(w);
  try {
    assert.equal(page.field('steps').value, '8', 'the Studio shows the settings of the last take (16/11)');
    const job = await page.generate();
    assert.equal(page.lastAction().arguments.steps, 8, 'sent as chosen by the user');
    assert.equal(job.parameters.steps, 8, 'the new default of the workflow is not used');
  } finally {
    page.restore();
  }
  // A conversation without a take: the new default.
  const fresh = world([at(12)]),
    blank = await studioPage(fresh);
  try {
    write(blank, 'Un renard');
    assert.equal(blank.field('steps').value, '12');
    assert.equal((await blank.generate()).parameters.steps, 12);
    assert.equal(blank.lastAction().arguments.steps, undefined, 'left as it is, nothing is sent: the default');
  } finally {
    blank.restore();
  }
});

test('today · Studio · a setting « Assistant » that is on or off (« Audio » of LTX 2.5) is a number field, and refuses the creation once a take has set it', async () => {
  const sound = variant('ltx25', { audio: { policy: 'model', type: 'boolean', default: true } }),
    w = world([sound]),
    [shown] = (await w.tools.studio()).create_video;
  assert.deepEqual(shown.settings.find(setting => setting.key === 'audio'), { key: 'audio', type: 'boolean', default: true });
  // The Chat and its card take it as it is: a box to tick (public/video-plan.mjs).
  const chat = await ask(w, 'create_video', { prompt: 'Un renard court', intention: 'Essai', duration: 2, audio: false });
  assert.equal(chat.plan.parameters.audio, false);
  assert.equal((await make(w, chat)).parameters.audio, false);
  // The Studio of that conversation, opened again: it takes the settings of its last take (16/11).
  const page = await studioPage(w);
  try {
    page.mode(1);
    const field = page.field('audio');
    assert.deepEqual([field.tag, field.type, field.value], ['input', 'number', 'false'], 'a number field showing « false »');
    write(page, 'Un renard court dans la neige');
    assert.equal(await page.generate(), null, 'nothing made');
    assert.equal(page.lastAction().arguments.audio, 0, 'false sent as the number 0');
    // (In French since 0.6.94; the field itself is for the Studio's own correction.)
    assert.equal(page.body.find('studio-error')[0]?.textContent, 'Audio : oui ou non.');
  } finally {
    page.restore();
  }
});

test('« Disponible pour l’assistant » unticked takes the workflow out of Moodix AI’s tools only: the Studio and the buttons of a take keep it', async () => {
  // (0.6.94) It was gone from the Studio too, which the box does not say.
  const user = await mkdtemp(join(tmpdir(), 'moodix-lot6-'));
  try {
    const catalog = new NativeWorkflowCatalog(join(user, 'workflow'), {
      assets: files,
      builtin: folder,
      statePath: join(user, 'workflow-natives.json'),
      capabilities: { krea2: true, moss: true, seedvr2: true },
    });
    const krea = stored('krea2'),
      upscaler = stored('seedvr2');
    await catalog.save({ ...krea, enabled: false });
    await catalog.save({ ...upscaler, enabled: false });
    const listed = (await catalog.list()).find(item => item.id === krea.id);
    assert.deepEqual([listed.enabled, listed.ready, listed.unavailableReason], [false, true, undefined], 'it can be made here');
    const tools = new ToolCatalog(catalog);
    assert.equal(
      (await tools.definitions()).find(tool => tool.function.name === 'create_image').function.description.includes('Krea 2'),
      false,
      'out of the assistant’s tools, as the box says',
    );
    assert.equal((await tools.studio()).create_image.some(item => item.id === krea.id), true, 'in the Studio');
    // « Agrandir et affiner » on a take: its upscaler is the user's too.
    assert.deepEqual((await tools.actions()).upscale, ['image']);
    // Made by hand (the Studio, through /api/tools/action), changed there, then made.
    const w = world(await catalog.list());
    const byHand = (name, args) =>
      w.runtime.request(
        [{ id: 'action' + randomUUID().slice(0, 8), type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        { conversationId: CONVERSATION, turnId: randomUUID(), messages: [], byHand: true },
      );
    const proposal = await byHand('create_image', { prompt: 'Un renard', workflow: krea.id });
    assert.equal(proposal.workflowName, 'Krea 2');
    const changed = await revise(w, proposal, { width: 1344, height: 768 });
    assert.deepEqual((await make(w, changed, { studio: true })).parameters.width, 1344);
    // Asked by Moodix AI, it is no workflow of its.
    await assert.rejects(ask(w, 'create_image', { prompt: 'Un renard', workflow: krea.id }), /ne peut pas exécuter create_image/);
    await assert.rejects(resolveNativeWorkflow(listed, { prompt: 'Un renard' }, files), {
      status: 400,
      message: 'Krea 2 n’est pas proposé à Moodix AI : cochez « Disponible pour l’assistant » dans Paramètres › Workflows.',
    });
    // The page of the Studio makes it at « Générer ».
    const page = await studioPage(w);
    try {
      write(page, 'Un renard dans la neige');
      assert.equal((await page.generate())?.workflowId, krea.id);
    } finally {
      page.restore();
    }
    // The line of the workflow in Paramètres says so.
    const editor = await editorPage(await catalog.list());
    try {
      const card = editor.$('workflow-list').children.find(item => item.children[1]?.children[0]?.children[0]?.textContent === 'Krea 2');
      assert.equal(card.children[0].dataset.help, 'Pas proposé à l’assistant : il reste dans le Studio.');
    } finally {
      editor.restore();
    }
  } finally {
    await rm(user, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ (c) the Studio set by Moodix AI

test('Studio set by Moodix AI · an « Assistant » setting is set by the pointer and stays the user’s to change; a « Fixe » one is said left aside', async () => {
  const assistant = variant('krea2', { steps: { policy: 'model', type: 'integer', default: 8, min: 1, max: 50 } });
  const w = world([assistant]),
    page = await studioPage(w);
  try {
    const proposal = await ask(w, 'create_image', { prompt: 'A red fox in the snow.', steps: 20 });
    const answer = page.studio.propose(proposal, new AbortController().signal);
    await until(() => page.said.includes('attend votre accord'));
    assert.ok(page.said.includes('règle steps'), page.said.join(' · '));
    assert.equal(page.field('steps').value, '20', 'the value of Moodix AI');
    page.field('steps').value = '30';
    page.field('steps').oninput();
    await page.body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    assert.deepEqual(page.lastRevise().edits, { steps: 30 });
    // The page then makes the proposal as revised (app.js): the user's value.
    assert.equal((await make(w, proposal)).parameters.steps, 30);
  } finally {
    page.restore();
  }
  const v = world([variant('krea2')]),
    fixedPage = await studioPage(v);
  try {
    const proposal = await ask(v, 'create_image', { prompt: 'A red fox in the snow.', steps: 20 });
    const answer = fixedPage.studio.propose(proposal, new AbortController().signal);
    await until(() => fixedPage.said.includes('attend votre accord'));
    assert.equal(fixedPage.field('steps'), null);
    assert.deepEqual(
      fixedPage.body.find('studio-proposal-note').map(note => note.textContent),
      ['steps ignoré : fixé par le workflow Krea 2.'],
    );
    await fixedPage.body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    assert.equal((await make(v, proposal)).parameters.steps, 8);
  } finally {
    fixedPage.restore();
  }
});

// ------------------------------------------------------------------ saved, read again

/** The editor of Paramètres › Workflows on a page in memory (as tests/native-workflow-ui.mjs draws it). */
async function editorPage(workflows) {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'),
    nodes = new Map();
  class Element {
    constructor(tag = 'div', className = '', text = '') {
      this.tagName = tag.toUpperCase();
      Object.assign(this, { className, textContent: text, children: [], listeners: {}, hidden: false, value: '' });
      Object.assign(this, { checked: false, disabled: false, dataset: {}, style: {}, attributes: {} });
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
    focus() {}
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
  const $ = id => nodes.get(id) || null,
    saves = [];
  const previous = globalThis.document;
  globalThis.document = {
    getElementById: $,
    createElement: tag => new Element(tag),
    activeElement: $('workflow-add'),
    addEventListener() {},
  };
  const api = async (route, body) => {
    if (route === 'generation')
      return Response.json({
        config: { enabled: true, autoAllow: false, maxIterations: 100, pythonPath: '' },
        folders: {},
        runner: { state: 'ready' },
        families: familyCatalog(),
        workflows,
        assets: [],
      });
    if (route === 'generation/workflows' && body) {
      saves.push(structuredClone(body));
      return Response.json({ workflow: body });
    }
    throw Error('Unexpected ' + route);
  };
  const { setupNativeWorkflows } = await import('../public/native-workflow-ui.mjs');
  const ui = setupNativeWorkflows({ api, state: {}, node: (...args) => new Element(...args), notice() {} });
  await ui.refresh();
  return { ui, $, saves, restore: () => (globalThis.document = previous) };
}

test('« Fixe » on « Débruitage » of Krea 2, saved, outlives the next start of Moodix: a copy the user saved is never taken for one an older version left', async () => {
  // (0.6.94) It was deleted at the next start (adoptShipped), the shipped one back without a word.
  const krea = stored('krea2');
  assert.equal(krea.parameters.denoise.policy, 'model', 'shipped: left to the assistant, 0.6 to 0.7');
  // The editor of Paramètres › Workflows: « Fixe » pressed on « Débruitage », nothing else, « Enregistrer ».
  const listed = { ...validateNativeWorkflow(krea), ready: true, builtin: true },
    editor = await editorPage([listed]);
  let record;
  try {
    assert.equal(await editor.ui.edit(listed), true);
    editor.$('native-policy-denoise').value = 'fixed';
    editor.$('native-policy-denoise').onchange();
    assert.equal(await editor.ui.saveEditor(), true);
    [record] = editor.saves;
  } finally {
    editor.restore();
  }
  assert.deepEqual(record.parameters.denoise, FIXED(0.6), 'the value it showed, the default of before');
  // That is, to the byte, the Krea 2 shipped with 0.6.69 (runner/workflow-history.json knows it), as
  // « Fixe 0,75 » is that of 0.6.68 and « Fixe 1 » that of an earlier one.
  const known = JSON.parse(readFileSync(HISTORY, 'utf8')).workflows[krea.id];
  assert.ok(known.includes(workflowFingerprint(record)));
  for (const value of [0.75, 1])
    assert.ok(known.includes(workflowFingerprint({ ...record, parameters: { ...record.parameters, denoise: FIXED(value) } })), String(value));
  const user = await mkdtemp(join(tmpdir(), 'moodix-lot6-'));
  try {
    // The catalog of the application (lib/generation-service.mjs): the user's folder, the shipped one.
    const catalog = () =>
      new NativeWorkflowCatalog(join(user, 'workflow'), {
        assets: files,
        builtin: folder,
        statePath: join(user, 'workflow-natives.json'),
        historyPath: HISTORY,
        capabilities: { krea2: true },
      });
    for (const value of [0.6, 0.75, 1]) {
      await catalog().save({ ...record, parameters: { ...record.parameters, denoise: FIXED(value) } });
      let listed = (await catalog().list()).find(item => item.id === krea.id);
      assert.deepEqual([listed.parameters.denoise, listed.customized], [FIXED(value), true], 'saved: « modifié par vous »');
      // Moodix starts again (GenerationService.init → adoptShipped): the user's version stays theirs.
      const again = catalog();
      assert.deepEqual(await again.adoptShipped(), { removed: [], kept: [krea.id] }, String(value));
      listed = (await again.list()).find(item => item.id === krea.id);
      assert.deepEqual([listed.parameters.denoise, listed.customized], [FIXED(value), true], String(value));
      // « Rétablir » gives the shipped one back, as before.
      await again.reset(krea.id);
      assert.equal((await again.list()).find(item => item.id === krea.id).parameters.denoise.policy, 'model');
    }
    // A copy no save recorded, left by a version before 0.4.4 in the folder both shared: unedited,
    // it still goes (tests/native-catalog.mjs); with the record of the saves unreadable, nothing does.
    await mkdir(join(user, 'workflow'), { recursive: true });
    await writeFile(join(user, 'workflow', krea.id + '.json'), JSON.stringify(record));
    await writeFile(join(user, 'workflow-natives.json'), '{ not json');
    assert.deepEqual(await catalog().adoptShipped(), { removed: [], kept: [] });
    assert.deepEqual(await readdir(join(user, 'workflow')), [krea.id + '.json']);
    assert.equal(readFileSync(join(user, 'workflow-natives.json'), 'utf8'), '{ not json', 'nor written over');
    await rm(join(user, 'workflow-natives.json'));
    assert.deepEqual(await catalog().adoptShipped(), { removed: [krea.id], kept: [] });
  } finally {
    await rm(user, { recursive: true, force: true });
  }
});

test('Paramètres closed without « Enregistrer »: every field of Génération it saves is watched, a change of one alone is asked about', () => {
  // (0.6.94) Six were not: « Demander avant de remplacer un personnage » and five folders.
  // What « Enregistrer » sends of Génération (native-workflow-ui.mjs, values() and folderControls).
  const saved = [
    'generation-enabled',
    'generation-auto',
    'generation-auto-video',
    'generation-confirm-replace',
    'generation-review-images',
    'generation-review',
    'generation-models-dir',
    'native-convert-root',
    'generation-vae-root',
    'generation-lora-root',
    'generation-text-encoder-root',
    'generation-tokenizer-root',
    'generation-upscale-root',
    'generation-latent-upscale-root',
  ];
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'),
    ui = readFileSync(new URL('../public/native-workflow-ui.mjs', import.meta.url), 'utf8');
  for (const id of saved) {
    assert.match(html, new RegExp(`id="${id}"`), id);
    assert.match(ui, new RegExp(`'${id}'`), `${id} is read by values()`);
  }
  // What the guard of the settings compares before closing them (app.js, setupSettingsGuard).
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'),
    list = app.match(/const settingsGuard = setupSettingsGuard\(\{[\s\S]*?fields: \[([\s\S]*?)\]\.map/)[1],
    watched = [...list.matchAll(/'([a-z-]+)'/g)].map(match => match[1]);
  assert.deepEqual(
    saved.filter(id => !watched.includes(id)),
    [],
  );
  // The folders of values() are all there, and nothing else is saved of Génération.
  const folders = [...ui.match(/const folderControls = \{([\s\S]*?)\};/)[1].matchAll(/\['([a-z-]+)'/g)].map(match => match[1]);
  assert.equal(folders.length, 8);
  for (const id of folders) assert.ok(saved.includes(id), id);
});

test('a policy saved is read again after a start, and a workflow whose file is missing cannot be saved at all', async () => {
  const user = await mkdtemp(join(tmpdir(), 'moodix-lot6-'));
  try {
    const catalog = (assets = files) =>
      new NativeWorkflowCatalog(join(user, 'workflow'), {
        assets,
        builtin: folder,
        statePath: join(user, 'workflow-natives.json'),
        historyPath: HISTORY,
        capabilities: { moss_sfx: true },
      });
    const sfx = stored('moss_sfx'),
      steps = { policy: 'model', type: 'integer', default: 100, min: 50, max: 120, description: 'Plus pour un son net.' };
    await catalog().save({ ...sfx, parameters: { ...sfx.parameters, steps } });
    const again = catalog();
    await again.adoptShipped();
    assert.deepEqual((await again.list()).find(item => item.id === sfx.id).parameters.steps, steps);
    // Its sound model not downloaded yet: no setting of it can be changed (the save checks every file).
    const absent = {
      resolve: async () => {
        throw Object.assign(Error('ENOENT: no such file'), { code: 'ENOENT' });
      },
    };
    await assert.rejects(
      catalog(absent).save({ ...sfx, parameters: { ...sfx.parameters, steps: FIXED(80) } }),
      /Fichier introuvable pour « Modèle de bruitages »|Fichier introuvable pour/,
    );
  } finally {
    await rm(user, { recursive: true, force: true });
  }
});
