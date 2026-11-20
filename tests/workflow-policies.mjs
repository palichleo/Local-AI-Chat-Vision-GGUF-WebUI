import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { familyCatalog } from '../lib/families.mjs';
import { ProgressHistory, timingKey } from '../lib/generation-progress.mjs';
import { CAPABLE } from '../lib/model-wording.mjs';
import {
  NativeWorkflowCatalog,
  ownSettings,
  resolveNativeWorkflow,
  validateNativeWorkflow,
  workflowFingerprint,
} from '../lib/native-workflows.mjs';
import { nearestFormat } from '../public/formats.mjs';
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
 * editor (public/native-workflow-ui.mjs). They stated what the application did at 0.6.90, flaws
 * included: a test whose name began with « today » described a flaw the correction was to turn round.
 * (0.6.102) Turned round, with the decisions of the user: « Fixe » is a rule for Moodix AI only (the
 * Studio and the card of a proposal show it at its value, the user may change it, within the bounds
 * of the workflow); the newer of a change in Paramètres and of the last take wins, setting by setting;
 * a file has no « Assistant », a reference slot no « Description » any more.
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
 * saved in Paramètres meanwhile: saveIn); `changes`, when the user changed each part of each one
 * (NativeWorkflowCatalog.changes, 0.6.102).
 */
function world(workflows) {
  const w = { workflows, jobs: [], saved: [], changes: {} };
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
    changes: async () => structuredClone(w.changes),
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
/**
 * A workflow saved in Paramètres › Workflows meanwhile, at `time`: the settings it changes are recorded
 * as the catalog records them (changedParts in lib/native-workflows.mjs, tested below on its own).
 */
function saveIn(w, workflow, time = Date.now()) {
  const before = w.workflows.find(item => item.id === workflow.id);
  w.workflows = w.workflows.map(item => (item.id === workflow.id ? workflow : item));
  for (const name of new Set([...Object.keys(before.parameters), ...Object.keys(workflow.parameters)]))
    if (JSON.stringify(before.parameters[name]) !== JSON.stringify(workflow.parameters[name]))
      (w.changes[workflow.id] ??= {})[name] = time;
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
    /** The line of a rare setting (« Plus de réglages »), by the name it shows: its name, its control. */
    rareLine: label =>
      body
        .find('studio-rare')[0]
        ?.find('studio-field')
        .find(item => item.children[0]?.textContent === label) ?? null,
    /** The field of a rare setting, by the name it shows. */
    field: label =>
      body
        .find('studio-rare')[0]
        ?.find('studio-field')
        .find(item => item.children[0]?.textContent === label)?.children[1] ?? null,
    /** The field of the seed, first of the rare settings. */
    seed: () => body.find('studio-seed')[0]?.children[1] ?? null,
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
  // (0.6.102: said under the name the editor shows, « steps ignoré » before.)
  for (const [workflow, made, notes] of [
    [fixed, 8, ['Étapes : valeur ignorée, fixée par le workflow Krea 2.']],
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
      'Influence des références MSR : aucune valeur donnée, et ce modèle n’en a pas par défaut. Choisissez-en une dans ses réglages (Paramètres › Modèles).',
  });
});

test('Chat · the card of a proposal lets the user change a « Fixe » setting too, within the bounds of its workflow, as for « Assistant »: not wider', async () => {
  // MOSS-SoundEffect: a sound waits for « Générer » on its card in the Chat.
  const fixed = variant('moss_sfx'),
    assistant = variant('moss_sfx', { steps: { policy: 'model', type: 'integer', default: 100, min: 50, max: 120 } });
  assert.deepEqual(fixed.parameters.steps, FIXED(100));
  const fromFixed = await ask(world([fixed]), 'create_audio', { prompt: 'Une porte qui grince', seconds: 3 });
  // Listed as a setting to change, as the one left to the assistant: shipped « Fixe » without bounds of
  // its own, it has those of its family.
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
  // (0.6.102) Turned « Fixe », it keeps them: they were given up for those of the family (1 to
  // 200), wider than those « Assistant » had. (0.6.128) No switch turns it any more: a setting is
  // never left to Moodix AI, and the catalog reads one a workflow of before left to it as « Fixe »
  // at its default, within those same bounds (ownSettings; the Studio's for one creation).
  const saved = ownSettings(assistant);
  assert.deepEqual(saved.parameters.steps, { policy: 'fixed', value: 100, min: 50, max: 120 });
  const ws = world([{ ...validateNativeWorkflow(saved), ready: true }]),
    held = await ask(ws, 'create_audio', { prompt: 'Une porte qui grince', seconds: 3, steps: 110 });
  // Moodix AI is held to its value; the user, to its bounds.
  assert.deepEqual(held.notes, ['Étapes : valeur ignorée, fixée par le workflow Bruitages (MOSS-SoundEffect v2).']);
  assert.deepEqual(editableOf(held, 'steps'), { key: 'steps', value: 100, type: 'integer', min: 50, max: 120 });
  await assert.rejects(revise(ws, held, { steps: 180 }), /Étapes : entre 50 et 120\./);
  assert.equal((await make(ws, await revise(ws, held, { steps: 120 }))).parameters.steps, 120);
  // The card draws them all the same way: a field to type in (public/video-plan.mjs), no padlock, no
  // word that one is fixed in the workflow.
  for (const proposal of [fromFixed, asked, held]) {
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
  assert.deepEqual(proposal.notes, ['Seed : valeur ignorée, fixée par le workflow Krea 2.']);
  assert.equal((await make(w, proposal)).parameters.seed, 1234);
  const v = world([drawn]);
  assert.equal((await make(v, await ask(v, 'create_image', { prompt: 'Un renard', seed: 42 }))).parameters.seed, 42);
});

test('a file left to « Assistant » (a workflow saved so before) is no argument of the model any more: made with its default, one it names left aside and said', async () => {
  // (0.6.102) It was offered as bare identifiers, nothing to tell them apart (neither the name of a
  // file nor what it does), and the Studio had no choice of it: « Assistant » left the files.
  const krea = stored('krea2'),
    vae = krea.components.vae.asset,
    other = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
    chosen = variant('krea2', {}, { components: { ...krea.components, vae: { policy: 'model', choices: [other, vae], default: vae } } });
  for (const options of [undefined, { wording: CAPABLE }]) {
    const tool = await offered([chosen], 'create_image', options);
    assert.equal(tool.properties.components, undefined, options ? 'capable' : 'rails');
  }
  const w = world([chosen]);
  assert.match((await make(w, await ask(w, 'create_image', { prompt: 'Un renard' }))).components.vae, new RegExp(vae));
  // Named all the same (a capable model, held by no grammar): the workflow's own, and said; never refused.
  const named = await ask(w, 'create_image', { prompt: 'Un renard', components: { vae: other } });
  assert.deepEqual(named.notes, ['« VAE » : fichier ignoré, fixé par le workflow Krea 2.']);
  assert.match((await make(w, named)).components.vae, new RegExp(vae));
  // The same file as the workflow's: taken, nothing to say. A file it does not take: said, not refused.
  // The same for a file « Fixe ».
  assert.equal((await ask(w, 'create_image', { prompt: 'Un renard', components: { vae } })).notes, undefined);
  assert.deepEqual((await ask(w, 'create_image', { prompt: 'Un renard', components: { lumiere: other } })).notes, [
    '« lumiere » : fichier ignoré, Krea 2 ne prend pas ce fichier.',
  ]);
  const v = world([variant('krea2')]);
  assert.deepEqual((await ask(v, 'create_image', { prompt: 'Un renard', components: { vae: other } })).notes, [
    '« VAE » : fichier ignoré, fixé par le workflow Krea 2.',
  ]);
  const [shown] = (await w.tools.studio()).create_image;
  assert.equal('components' in shown, false, 'nothing of it in the Studio: the file is the workflow’s');
});

test('a file left to « Assistant » without a default: the first allowed stands in, the one the editor shows and keeps', async () => {
  // (0.6.94) Every creation was refused, in English (« Select an allowed vae asset »). (0.6.102) With
  // several allowed it was asked for in French, a choice no one can make any more.
  const krea = stored('krea2'),
    vae = krea.components.vae.asset,
    other = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
  for (const choices of [[vae], [vae, other]]) {
    const w = world([variant('krea2', {}, { components: { ...krea.components, vae: { policy: 'model', choices } } })]);
    assert.match((await make(w, await ask(w, 'create_image', { prompt: 'Un renard' }))).components.vae, new RegExp(vae));
  }
  // The editor of Paramètres › Workflows: that file, « Fixe » (no switch any more), and so saved.
  const listed = variant('krea2', {}, { components: { ...krea.components, vae: { policy: 'model', choices: [vae, other] } } }),
    editor = await editorPage([listed]);
  try {
    assert.equal(await editor.ui.edit(listed), true);
    assert.equal(editor.$('native-component-vae-policy'), null);
    assert.equal(editor.$('native-component-vae').value, vae);
    assert.equal(await editor.ui.saveEditor(), true);
    assert.deepEqual(editor.saves[0].components.vae, { policy: 'fixed', asset: vae });
  } finally {
    editor.restore();
  }
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

test('a reference slot has no « Description » in the editor any more, it reached no one; a required input is asked for by what it is', async () => {
  const krea = stored('krea2'),
    [source] = krea.references,
    asked = variant('krea2', {}, { references: [{ ...source, description: 'CONSIGNE-REFERENCE', required: true }] });
  for (const options of [undefined, { wording: CAPABLE }]) {
    const tool = await offered([asked], 'create_image', options);
    assert.equal(JSON.stringify(tool).includes('CONSIGNE-REFERENCE'), false, options ? 'capable' : 'rails');
    assert.equal(tool.required.includes('source'), false, 'nor is the image required in the tool');
  }
  // (Said in French since 0.6.94: « Source image is required » was read by the user too.)
  await assert.rejects(
    ask(world([asked]), 'create_image', { prompt: 'Un renard' }),
    /Aucun workflow ne correspond à ces entrées pour create_image\. .*« Source image » est obligatoire dans ce workflow/,
  );
  // (0.6.102) The editor asks nothing of it any more; (0.6.128) the page of a model has no line
  // for a slot at all: its inputs are the model's. What a workflow holds of them stays as it was:
  // saved untouched, it is the same workflow.
  const editor = await editorPage([asked]);
  try {
    assert.equal(await editor.ui.edit(asked), true);
    assert.equal(editor.$('native-reference-name-' + source.id), null, 'no line for the slot');
    assert.equal(editor.$('native-reference-description-' + source.id), null, 'nor for its « Description »');
    assert.equal(await editor.ui.saveEditor(), true);
    assert.equal(editor.saves[0].references[0].description, 'CONSIGNE-REFERENCE');
    assert.equal(workflowFingerprint(editor.saves[0]), workflowFingerprint(asked));
  } finally {
    editor.restore();
  }
  // The Studio asks for it by what it is: the image to modify (« Ajoutez l’image du personnage » before,
  // the words of a character put in a video), the image of the start of a video.
  const w = world([asked]),
    page = await studioPage(w);
  try {
    write(page, 'Un renard');
    assert.equal(await page.generate(), null);
    assert.equal(page.body.find('studio-error')[0]?.textContent, 'Ajoutez l’image à modifier.');
  } finally {
    page.restore();
  }
  const ltx = stored('ltx25'),
    starting = variant('ltx25', {}, {
      references: ltx.references.map(slot => (slot.role === 'start_image' ? { ...slot, required: true } : slot)),
    }),
    v = world([starting]),
    video = await studioPage(v);
  try {
    video.mode(1);
    write(video, 'Un renard court dans la neige');
    assert.equal(await video.generate(), null);
    assert.equal(video.body.find('studio-error')[0]?.textContent, 'Ajoutez l’image de début.');
  } finally {
    video.restore();
  }
});

// ------------------------------------------------------------------ (b) the Studio by hand

test('Studio · a « Fixe » setting is shown at its value, without a mark, and is the user’s to change for a creation; « Assistant » as before', async () => {
  // (0.6.102) « Fixe » holds Moodix AI, not the user (decision of the user): it was not shown at all.
  const assistant = variant('krea2', { steps: { policy: 'model', type: 'integer', default: 8, min: 1, max: 50 } });
  const [shownFixed] = (await world([variant('krea2')]).tools.studio()).create_image,
    [shownAssistant] = (await world([assistant]).tools.studio()).create_image;
  assert.deepEqual(shownFixed.settings.map(setting => [setting.key, setting.fixed]), [
    ['steps', true],
    ['denoise', undefined],
  ]);
  assert.deepEqual(shownFixed.settings[0], { key: 'steps', type: 'integer', min: 1, max: 1000, default: 8, fixed: true });
  assert.deepEqual(
    shownAssistant.settings.find(setting => setting.key === 'steps'),
    { key: 'steps', type: 'integer', min: 1, max: 50, default: 8 },
  );
  // By hand: set in « Plus de réglages », it is what is made.
  const w = world([assistant]),
    page = await studioPage(w);
  try {
    write(page, 'Un renard dans la neige');
    const steps = page.field('Étapes');
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
    const line = fixedPage.rareLine('Étapes');
    assert.equal(line.children[1].value, '8', 'at its value');
    assert.deepEqual(line.children.map(child => child.tag), ['span', 'input'], 'its name and its field: no padlock, no word');
    // As it is: nothing sent, its value made.
    assert.equal((await fixedPage.generate()).parameters.steps, 8);
    assert.equal(fixedPage.lastAction().arguments.steps, undefined);
    assert.equal(fixedPage.lastRevise(), undefined);
    // Changed: made so, as the user's own change of the proposal (tools/revise, as on its card in the
    // Chat), never as an argument Moodix AI would see left aside.
    fixedPage.field('Étapes').value = '20';
    fixedPage.field('Étapes').oninput();
    assert.equal((await fixedPage.generate()).parameters.steps, 20);
    assert.equal(fixedPage.lastAction().arguments.steps, undefined);
    assert.deepEqual(fixedPage.lastRevise().edits, { steps: 20 });
    assert.deepEqual(v.saved[0].parameters.user_overrides, { steps: 20 });
    assert.equal(v.saved[0].parameters.routing_notes, undefined, 'nothing left aside');
  } finally {
    fixedPage.restore();
  }
});

test('Studio · a value typed beyond the bounds of its workflow is brought to the nearest one they allow, shown so, and made: never refused', async () => {
  // (0.6.102) A whole number beyond them refused the creation (« Étapes : entre 50 et 120. »), a
  // decimal was made at its limit while the Studio still showed 12; « Fixe » has the same bounds.
  const sfx = variant('moss_sfx', {
      steps: { policy: 'model', type: 'integer', default: 100, min: 50, max: 120 },
      guidance_scale: { policy: 'model', type: 'number', default: 4, min: 1, max: 8 },
      shift: { policy: 'fixed', value: 5, min: 2, max: 6 },
    }),
    w = world([sfx]),
    page = await studioPage(w);
  try {
    page.mode(2);
    write(page, 'Une porte qui grince');
    const typed = (label, value, { leave = true } = {}) => {
      const control = page.field(label);
      control.value = value;
      control.oninput();
      // Left (the next field, « Générer »): the browser says it changed.
      if (leave) control.onchange();
      return control;
    };
    assert.equal(page.field('Guidage').max, '8', 'the field says its bounds');
    assert.equal(typed('Guidage', '12').value, '8', 'brought back at once, shown as it will be made');
    assert.equal(typed('Décalage (shift)', '9').value, '6', '« Fixe » within the bounds of its workflow');
    assert.equal(typed('Décalage (shift)', '0,5').value, '2');
    assert.equal(typed('Étapes', '87.6').value, '88', 'a whole number');
    // Typed, then « Générer » at once (Ctrl + Entrée): brought back all the same, shown so after.
    typed('Étapes', '500', { leave: false });
    const job = await page.generate();
    assert.deepEqual([job.parameters.steps, job.parameters.guidance_scale, job.parameters.shift], [120, 8, 2]);
    assert.deepEqual([page.lastAction().arguments.steps, page.lastAction().arguments.guidance_scale], [120, 8]);
    assert.deepEqual(page.lastRevise().edits, { shift: 2 });
    assert.equal(page.body.find('studio-error').length, 0, 'nothing refused');
    assert.equal(page.field('Étapes').value, '120', 'the Studio shows what was made');
    assert.equal(w.saved[0].parameters.routing_notes, undefined, 'nothing for the router to bring back');
  } finally {
    page.restore();
  }
});

/** The value the bar « Résolution » of the Studio shows, and the format chosen above it. */
const sizeShown = page => {
  const line = page.body.find('studio-bar-line').find(row => row.children[0]?.textContent === 'Résolution'),
    chip = page.body.find('studio-format').find(item => item.attributes?.['aria-checked'] === 'true');
  return [line?.children[2]?.textContent ?? null, chip?.children[0]?.textContent ?? null];
};

test('Studio · a size « Fixe » (Krea 2) is where the bar of resolution and the formats start; the user may change it for a creation', async () => {
  // (0.6.102) « Fixe » holds Moodix AI only (decision of the user): the bar and the formats stay, the
  // size the workflow fixes is where they start (the nearest size of the list to it before), and the
  // pointer of Moodix AI never sets it as its choice (assistantSize).
  const wide = variant('krea2', { width: FIXED(1344), height: FIXED(768) }),
    w = world([wide]),
    [shown] = (await w.tools.studio()).create_image;
  assert.deepEqual([shown.direct, shown.assistantSize], [false, false], 'the size is not the model’s');
  assert.deepEqual(shown.size, { width: 1344, height: 768 });
  assert.ok(shown.limits.width && shown.limits.height, 'the Studio is given sizes to offer');
  // In the Chat the size stays the workflow's: no format for an image, a size the model gives is left aside.
  const chat = await ask(w, 'create_image', { prompt: 'Un renard', width: 1024, height: 1024 });
  assert.deepEqual([chat.plan.parameters.width, chat.plan.parameters.height], [1344, 768]);
  assert.deepEqual(chat.notes, [
    'Largeur : valeur ignorée, fixée par le workflow Krea 2.',
    'Hauteur : valeur ignorée, fixée par le workflow Krea 2.',
  ]);
  const page = await studioPage(w);
  try {
    write(page, 'Un renard dans la neige');
    assert.deepEqual(sizeShown(page), ['1344 × 768', nearestFormat(1344, 768).id], 'it starts at the size fixed');
    let job = await page.generate();
    assert.deepEqual([job.parameters.width, job.parameters.height], [1344, 768]);
    assert.equal(page.lastRevise(), undefined, 'as it is: nothing changed');
    page.body.find('studio-format').find(chip => chip.children[0]?.textContent === '1:1').onclick();
    job = await page.generate();
    // Sent as the user's own edit of the proposal (tools/revise), which may change what is fixed.
    const { width, height } = page.lastRevise().edits;
    assert.equal(width, height, `a square size was sent: ${width} × ${height}`);
    assert.deepEqual([job.parameters.width, job.parameters.height], [width, height], 'made at the size of the Studio');
    assert.deepEqual(w.saved[0].parameters.user_overrides, { width, height });
  } finally {
    page.restore();
  }
});

test('Studio · « Vidéo finale » fixed in LTX 2.5: the Studio starts from the size of the final, made at its own size', async () => {
  // (0.6.102) It started from the size of the draft profile: by hand the final was made at 288 × 512.
  const final = variant('ltx25', { stage: FIXED('final') }),
    w = world([final]),
    [shown] = (await w.tools.studio()).create_video;
  assert.equal(shown.stages, false);
  assert.deepEqual(final.profiles.draft.parameters, { width: 288, height: 512, steps: 8, frames: 25, fps: 24 });
  assert.deepEqual([shown.size, shown.final], [
    { width: 896, height: 1600 },
    { width: 896, height: 1600 },
  ]);
  // The Chat makes its final at the size of the final profile.
  const chat = await ask(w, 'create_video', { prompt: 'Un renard court', intention: 'Essai', duration: 5 });
  assert.deepEqual([chat.plan.stage, chat.plan.parameters.width, chat.plan.parameters.height], ['final', 896, 1600]);
  const page = await studioPage(w);
  try {
    page.mode(1);
    write(page, 'Un renard court dans la neige');
    assert.deepEqual(sizeShown(page), ['896 × 1600', '9:16']);
    const job = await page.generate();
    assert.equal(job.parameters.stage, 'final');
    assert.deepEqual([job.parameters.width, job.parameters.height], [896, 1600], 'a final at the size of the final');
    assert.equal(page.lastRevise(), undefined, 'nothing to change: the size of its version');
  } finally {
    page.restore();
  }
  // A draft fixed: its size, and no final to offer.
  const draft = variant('ltx25', { stage: FIXED('draft') }),
    [drafted] = (await world([draft]).tools.studio()).create_video;
  assert.deepEqual([drafted.size, drafted.final], [{ width: 288, height: 512 }, null]);
});

test('Studio · a workflow saved in Paramètres while the Studio is on screen: read at once as the settings close, what changed shows, the rest stays', async () => {
  // (0.6.102) The Studio kept the settings of before until another view was opened: a setting turned
  // « Fixe » still showed, and sent, the value set before.
  const assistant = variant('krea2', { steps: { policy: 'model', type: 'integer', default: 8, min: 1, max: 50 } }),
    w = world([assistant]),
    page = await studioPage(w);
  try {
    write(page, 'Un renard dans la neige');
    page.field('Étapes').value = '20';
    page.field('Étapes').oninput();
    page.seed().value = '42';
    page.seed().oninput();
    // « Étapes » set to « Fixe » 12 in Paramètres › Workflows, saved; the settings closed (app.js).
    saveIn(w, variant('krea2', { steps: FIXED(12) }));
    page.studio.invalidate({ tools: true });
    await page.studio.workflowsSaved();
    assert.equal(page.field('Étapes').value, '12', 'its fixed value, at once');
    assert.equal(page.seed().value, '42', 'the rest as it was');
    let job = await page.generate();
    assert.equal(page.lastAction().arguments.steps, undefined, 'nothing Moodix AI would see left aside');
    assert.deepEqual([job.parameters.steps, job.parameters.seed], [12, 42]);
    assert.equal(w.saved[0].parameters.routing_notes, undefined);
    // Changed again by the user, then the settings opened and closed with nothing saved: nothing moves.
    page.field('Étapes').value = '30';
    page.field('Étapes').oninput();
    await page.studio.workflowsSaved();
    assert.equal(page.field('Étapes').value, '30');
    job = await page.generate();
    assert.deepEqual([page.lastRevise().edits, job.parameters.steps], [{ steps: 30 }, 30], 'the user’s own change');
  } finally {
    page.restore();
  }
});

test('Studio · of a change in Paramètres and the last take of a conversation, the newer wins, setting by setting', async () => {
  // (0.6.102, decision of the user: « le plus récent des deux ».) A default changed in Paramètres did
  // not reach the Studio of a conversation that had a take: the take's value was sent.
  const at = (steps, guidance = 4) =>
      variant('moss_sfx', {
        steps: { policy: 'model', type: 'integer', default: steps, min: 50, max: 150 },
        guidance_scale: { policy: 'model', type: 'number', default: guidance, min: 1, max: 8 },
      }),
    w = world([at(100)]);
  // A take of the conversation: its steps at the default of then, its guidance chosen.
  await make(w, await ask(w, 'create_audio', { prompt: 'Une porte qui grince', seconds: 3, guidance_scale: 6 }));
  assert.deepEqual([w.saved[0].parameters.steps, w.saved[0].parameters.guidance_scale], [100, 6]);
  const madeAt = Date.parse(w.saved[0].createdAt);
  // Then the default of the steps is 120 (Paramètres › Workflows, after the take).
  saveIn(w, at(120), madeAt + 1000);
  const page = await studioPage(w);
  try {
    page.mode(2);
    assert.equal(page.field('Étapes').value, '120', 'changed after the take: the workflow’s value now');
    assert.equal(page.field('Guidage').value, '6', 'the rest as the take had it (16/11)');
    const job = await page.generate();
    assert.deepEqual([job.parameters.steps, job.parameters.guidance_scale], [120, 6]);
  } finally {
    page.restore();
  }
  // A change older than the take: the take's value.
  const before = world([at(100)]);
  await make(before, await ask(before, 'create_audio', { prompt: 'Une porte qui grince', seconds: 3, steps: 90 }));
  saveIn(before, at(110), Date.parse(before.saved[0].createdAt) - 60000);
  const older = await studioPage(before);
  try {
    older.mode(2);
    assert.equal(older.field('Étapes').value, '90');
  } finally {
    older.restore();
  }
  // A conversation without a take: the new default, nothing sent.
  const fresh = world([at(120)]),
    blank = await studioPage(fresh);
  try {
    blank.mode(2);
    write(blank, 'Une porte qui grince');
    assert.equal(blank.field('Étapes').value, '120');
    assert.equal((await blank.generate()).parameters.steps, 120);
    assert.equal(blank.lastAction().arguments.steps, undefined, 'left as it is, nothing is sent: the default');
  } finally {
    blank.restore();
  }
});

test('Studio · a setting on or off (« Audio » of LTX 2.5) is a switch, sent as true or false, « Fixe » or « Assistant »', async () => {
  // (0.6.102) It was a number field: « false » from a take was sent as the number 0, refused.
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
    const field = page.field('Audio');
    assert.deepEqual([field.tag, field.type, field.checked], ['input', 'checkbox', false], 'a switch, off');
    write(page, 'Un renard court dans la neige');
    assert.equal((await page.generate()).parameters.audio, false);
    assert.equal(page.lastAction().arguments.audio, false);
    page.field('Audio').checked = true;
    page.field('Audio').onchange();
    assert.equal((await page.generate()).parameters.audio, true);
    assert.equal(page.lastAction().arguments.audio, true);
  } finally {
    page.restore();
  }
  // Shipped, LTX 2.5 fixes it on: the same switch, on; off, the user's own change.
  const v = world([variant('ltx25')]),
    fixedPage = await studioPage(v);
  try {
    fixedPage.mode(1);
    write(fixedPage, 'Un renard court dans la neige');
    assert.equal(fixedPage.field('Audio').checked, true);
    fixedPage.field('Audio').checked = false;
    fixedPage.field('Audio').onchange();
    assert.equal((await fixedPage.generate()).parameters.audio, false);
    assert.deepEqual(fixedPage.lastRevise().edits, { audio: false });
  } finally {
    fixedPage.restore();
  }
});

test('« Proposé à Moodix AI » off takes the workflow out of Moodix AI’s tools only: the Studio and the buttons of a take keep it', async () => {
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
      message: 'Krea 2 n’est pas proposé à Moodix AI : activez « Proposé à Moodix AI » dans ses réglages (Paramètres › Modèles).',
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
      // (0.6.119: under its description, on the page « Modèles ».)
      const under = root => [root, ...root.children.flatMap(child => under(child))],
        line = under(editor.$('workflow-list')).find(item => item.className === 'model-line' && item.dataset.model === 'Krea 2');
      assert.deepEqual(under(line).filter(item => item.className === 'model-note').map(item => item.textContent), ['Pas proposé à Moodix AI : il reste dans le Studio.']);
    } finally {
      editor.restore();
    }
  } finally {
    await rm(user, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ (c) the Studio set by Moodix AI

test('Studio set by Moodix AI · an « Assistant » setting is set by the pointer and stays the user’s to change; a « Fixe » one is shown at its value, never as its choice', async () => {
  const assistant = variant('krea2', { steps: { policy: 'model', type: 'integer', default: 8, min: 1, max: 50 } });
  const w = world([assistant]),
    page = await studioPage(w);
  try {
    const proposal = await ask(w, 'create_image', { prompt: 'A red fox in the snow.', steps: 20 });
    const answer = page.studio.propose(proposal, new AbortController().signal);
    await until(() => page.said.includes('attend votre accord'));
    // (0.6.102: by its name, « règle steps » before.)
    assert.ok(page.said.includes('règle étapes'), page.said.join(' · '));
    assert.equal(page.field('Étapes').value, '20', 'the value of Moodix AI');
    page.field('Étapes').value = '30';
    page.field('Étapes').oninput();
    await page.body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    assert.deepEqual(page.lastRevise().edits, { steps: 30 });
    // The page then makes the proposal as revised (app.js): the user's value.
    assert.equal((await make(w, proposal)).parameters.steps, 30);
  } finally {
    page.restore();
  }
  // (0.6.102) « Fixe »: at its value from the start, the pointer does not set it (it is no choice of
  // Moodix AI), what Moodix AI sent for it is said left aside; the user may change it.
  const wide = variant('krea2', { width: FIXED(1344), height: FIXED(768) }),
    v = world([wide]),
    fixedPage = await studioPage(v);
  try {
    const proposal = await ask(v, 'create_image', { prompt: 'A red fox in the snow.', steps: 20, width: 1024, height: 1024 });
    const answer = fixedPage.studio.propose(proposal, new AbortController().signal);
    await until(() => fixedPage.said.includes('attend votre accord'));
    assert.equal(fixedPage.field('Étapes').value, '8');
    assert.deepEqual(sizeShown(fixedPage), ['1344 × 768', '16:9'], 'the size it fixes, shown at once');
    assert.equal(
      fixedPage.said.some(label => /étapes|passe en/.test(label)),
      false,
      'nothing of it set by the pointer: ' + fixedPage.said.join(' · '),
    );
    assert.deepEqual(fixedPage.body.find('studio-proposal-note').map(note => note.textContent), [
      'Étapes : valeur ignorée, fixée par le workflow Krea 2.',
      'Largeur : valeur ignorée, fixée par le workflow Krea 2.',
      'Hauteur : valeur ignorée, fixée par le workflow Krea 2.',
    ]);
    fixedPage.field('Étapes').value = '12';
    fixedPage.field('Étapes').oninput();
    await fixedPage.body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    assert.deepEqual(fixedPage.lastRevise().edits, { steps: 12 });
    assert.equal((await make(v, proposal)).parameters.steps, 12);
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
  // Until 0.6.127 the editor had « Fixe » to press on « Débruitage »: saved so, it kept the value it
  // showed, the default of before, within the bounds of before (0.6.102). (0.6.128) The page of a
  // model has no such switch: the denoise is Moodix AI's while the model is offered to it; a copy
  // saved so before is still the user's, as it is.
  const { digest, ...own } = validateNativeWorkflow(krea),
    record = { ...own, parameters: { ...own.parameters, denoise: { policy: 'fixed', value: 0.6, min: 0.6, max: 0.7 } } };
  assert.equal(digest.length, 64);
  // « Fixe 0,6 » without them is, to the byte, the Krea 2 shipped with 0.6.69 (runner/workflow-
  // history.json knows it), as « Fixe 0,75 » is that of 0.6.68 and « Fixe 1 » that of an earlier one.
  const known = JSON.parse(readFileSync(HISTORY, 'utf8')).workflows[krea.id];
  assert.equal(known.includes(workflowFingerprint(record)), false);
  for (const value of [0.6, 0.75, 1])
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
    await writeFile(
      join(user, 'workflow', krea.id + '.json'),
      JSON.stringify({ ...record, parameters: { ...record.parameters, denoise: FIXED(0.6) } }),
    );
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

test('the catalog keeps when the user changed each part of a workflow, for the Studio to show the newer of that change and of a take', async () => {
  // (0.6.102) « Le plus récent des deux »: nothing said when a setting had been changed.
  const user = await mkdtemp(join(tmpdir(), 'moodix-lot6-'));
  try {
    const catalog = new NativeWorkflowCatalog(join(user, 'workflow'), {
      assets: files,
      builtin: folder,
      statePath: join(user, 'workflow-natives.json'),
      historyPath: HISTORY,
      capabilities: { krea2: true },
    });
    const krea = stored('krea2');
    assert.deepEqual(await catalog.changes(), {});
    const before = Date.now();
    await catalog.save({ ...krea, parameters: { ...krea.parameters, steps: FIXED(12) } });
    const first = (await catalog.changes())[krea.id];
    assert.deepEqual(Object.keys(first), ['steps']);
    assert.ok(first.steps >= before && first.steps <= Date.now());
    // What is said to Moodix AI only (a description) is no part of what the Studio shows: not recorded.
    // Nor is a save that changes nothing.
    const saved = (await catalog.list()).find(item => item.id === krea.id);
    await catalog.save({ ...saved, parameters: { ...saved.parameters, denoise: { ...saved.parameters.denoise, description: 'Autre consigne.' } } });
    await catalog.save((await catalog.list()).find(item => item.id === krea.id));
    assert.deepEqual((await catalog.changes())[krea.id], first);
    // A LoRA added, a value changed: each by its part.
    await settle(5);
    const lora = { id: 'style', asset: '1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e', description: 'Lumière', enabled: FIXED(true), strength: FIXED(0.8) };
    await catalog.save({ ...krea, parameters: { ...krea.parameters, steps: FIXED(12), cfg: FIXED(1) }, loras: [lora] });
    const second = (await catalog.changes())[krea.id];
    assert.deepEqual(Object.keys(second).sort(), ['lora:style', 'steps']);
    assert.equal(second.steps, first.steps, 'unchanged since');
    // « Rétablir »: what it gives back is a change of the user's too.
    await settle(5);
    await catalog.reset(krea.id);
    const third = (await catalog.changes())[krea.id];
    assert.ok(third.steps > second.steps && third['lora:style'] > second['lora:style']);
    // Kept in the record of the saves, read again after a start; the Studio is told them.
    const again = new NativeWorkflowCatalog(join(user, 'workflow'), {
      assets: files,
      builtin: folder,
      statePath: join(user, 'workflow-natives.json'),
      historyPath: HISTORY,
      capabilities: { krea2: true },
    });
    assert.deepEqual((await again.changes())[krea.id], third);
    const shown = (await new ToolCatalog(again).studio()).create_image.find(item => item.id === krea.id);
    assert.deepEqual(shown.changed, third);
  } finally {
    await rm(user, { recursive: true, force: true });
  }
});

test('the page of a model has no « Fixe » nor « Assistant » to press and says who chooses what in one sentence; it keeps no field that changes nothing', async () => {
  // (0.6.102) One sentence said what « Fixe » and « Assistant » did. (0.6.128) Neither is there any
  // more: a setting is the user's, what is part of a request is Moodix AI's while the model is
  // offered to it, and the page says so under « Proposé à Moodix AI ».
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /native-policy-help|Fixe : Moodix AI garde/);
  assert.match(html, /<p id="native-workflow-chosen" class="model-hero-text is-next" hidden><\/p>/);
  const ui = readFileSync(new URL('../public/native-workflow-ui.mjs', import.meta.url), 'utf8');
  assert.match(ui, /' ; les réglages plus bas restent les vôtres\.'/);
  // Neither « Description » for a reference, nor « Assistant » for a file (0.6.102), nor a switch
  // of ownership or bounds for anything (0.6.128).
  assert.doesNotMatch(ui, /native-reference-description-/);
  assert.doesNotMatch(ui, /'-policy-'|'-min-'|'-max-'|'-use-default-'/);
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
    'generation-warm',
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
      seconds = { policy: 'model', type: 'number', default: 5, min: 1, max: 20, description: 'Court pour un choc.' },
      steps = { policy: 'model', type: 'integer', default: 100, min: 50, max: 120, description: 'Plus pour un son net.' };
    await catalog().save({ ...sfx, parameters: { ...sfx.parameters, seconds, steps } });
    const again = catalog();
    await again.adoptShipped();
    const read = (await again.list()).find(item => item.id === sfx.id).parameters;
    assert.deepEqual(read.seconds, seconds);
    // (0.6.128) A setting is never left to Moodix AI: sent so by a page of before, it is kept « Fixe »
    // at its default, within the bounds it had.
    assert.deepEqual(read.steps, { policy: 'fixed', value: 100, min: 50, max: 120 });
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

test('what a creation would be made with, and in how long, is said without keeping anything of the request (0.6.144)', async () => {
  // (Étape 2 du Montage, lot 3: « Combler les trous » says the model and the time of each plan before
  // anything is made. On the card, 20/11, a continuation went to another model than expected: five
  // minutes instead of one. Asked as server.mjs asks it: /api/tools/action with `estimate`.)
  const ltx = variant('ltx25'),
    w = world([ltx]),
    history = new ProgressHistory(join(await mkdtemp(join(tmpdir(), 'foreseen-')), 'timing.json'));
  w.runtime.timing = history;
  const byHand = (name, args) =>
    w.runtime.request(
      [{ id: 'action' + randomUUID().slice(0, 8), type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      { conversationId: CONVERSATION, turnId: randomUUID(), messages: [], byHand: true },
    );
  const wanted = { prompt: 'Un renard court dans la neige.', intention: 'Plan d’un montage, demandé dans le Studio.', duration: 5 };
  let proposal = await byHand('create_video', wanted);
  const { frames, fps } = proposal.plan.parameters;
  // Never made here: its model and the length it would make, no time.
  assert.deepEqual(await w.runtime.foreseen(proposal), { workflowName: ltx.name, seconds: Math.round((frames / fps) * 1000) / 1000 });
  // A continuation: its frames count what it takes back of its video, its length is not said.
  const held = randomUUID();
  w.runtime.pending.set(held, { prepared: { workflow: { name: 'LTX 2.5' }, job: { parameters: { frames: 57, fps: 24, width: 1600, height: 896 } } }, args: { workflow_id: ltx.id }, references: [{ role: 'source_video' }] });
  assert.deepEqual([await w.runtime.foreseen({ requestId: held }), w.runtime.pending.has(held)], [{ workflowName: 'LTX 2.5' }, false]);
  // Nothing is kept of it: it can neither be changed nor made.
  await assert.rejects(revise(w, proposal, { seed: 4 }));
  await assert.rejects(w.runtime.execute({ requestId: proposal.requestId, permission: 'once', approvalToken: proposal.approvalToken, studio: true }));
  assert.equal(w.jobs.length, 0);
  // Made here before at this size and length: that time, said as exact; at another length, brought to this one.
  await history.save(timingKey(ltx.id, proposal.plan.parameters, 0), [{ mark: 'loading', at: 3 }, { mark: 'done', at: 108.4 }]);
  proposal = await byHand('create_video', wanted);
  assert.deepEqual((await w.runtime.foreseen(proposal)).expected, { seconds: 108.4, exact: true });
  proposal = await byHand('create_video', { ...wanted, duration: 2 });
  const short = proposal.plan.parameters.frames;
  assert.deepEqual((await w.runtime.foreseen(proposal)).expected, { seconds: Math.round(((108.4 * short) / frames) * 10) / 10, exact: false });
  // A request that is no proposal (the files of its model are not there): its name, said as missing.
  // (0.6.153) What its download is, for « Télécharger · 20,0 Go » of the Bobine.
  assert.deepEqual(await w.runtime.foreseen({ requestId: randomUUID(), workflowName: 'LTX 2.5', missing: { files: [], bytes: 7 } }), { workflowName: 'LTX 2.5', missing: { files: [], bytes: 7 } });
  // A proposal that is made stays one: asked for real, it is created as before.
  proposal = await byHand('create_video', wanted);
  assert.equal((await make(w, proposal, { studio: true })).parameters.frames, frames);
});

test('a plan of a montage is made at the size of its film, as a size chosen in the Studio is (0.6.144)', async () => {
  // (Seen on the card, 20/11: asked without a size, the plan of a film of 1344 × 768 came out as a draft
  // of 512 × 288, the small size of its model. As server.mjs does: /api/tools/action with `size`.)
  const ltx = variant('ltx25'),
    w = world([ltx]);
  const byHand = (name, args) =>
    w.runtime.request(
      [{ id: 'action' + randomUUID().slice(0, 8), type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      { conversationId: CONVERSATION, turnId: randomUUID(), messages: [], byHand: true },
    );
  const wanted = { prompt: 'Un renard court dans la neige.', intention: 'Plan d’un montage, demandé dans le Studio.', duration: 5, format: '16:9' },
    of = proposal => [proposal.plan.parameters.stage, proposal.plan.parameters.width, proposal.plan.parameters.height];
  const plain = await byHand('create_video', wanted);
  assert.deepEqual(of(plain), ['draft', 512, 288]);
  // A large picture for its model: its final, at that very size; made so.
  const film = await w.runtime.sized(plain, { width: 1344, height: 768 });
  assert.deepEqual(of(film), ['final', 1344, 768]);
  assert.deepEqual((({ stage, width, height }) => [stage, width, height])((await make(w, film, { studio: true })).parameters), ['final', 1344, 768]);
  // The rule of the Studio (stageOf): more than one and a half times the draft of its model is a final,
  // 768 × 448 included. The size its model proposes is its draft: left as it is, the same proposal.
  assert.deepEqual(of(await w.runtime.sized(await byHand('create_video', wanted), { width: 768, height: 448 })), ['final', 768, 448]);
  const same = await byHand('create_video', wanted);
  assert.equal(await w.runtime.sized(same, { width: 512, height: 288 }), same);
  // A size its model does not take, or none: left as proposed, and still to be made.
  const odd = await byHand('create_video', wanted);
  assert.deepEqual(of(await w.runtime.sized(odd, { width: 1000, height: 30 })), ['draft', 512, 288]);
  // What is no size is not tried, and a continuation keeps the size of its video: nothing is asked again.
  const tried = [],
    change = w.runtime.revise.bind(w.runtime);
  w.runtime.revise = async request => (tried.push(request), change(request));
  for (const size of [undefined, {}, { width: 'x', height: 768 }, { width: -4, height: 768 }, { width: 1344.5, height: 768 }]) assert.equal(await w.runtime.sized(odd, size), odd);
  const kept = await byHand('create_video', wanted);
  w.runtime.pending.get(kept.requestId).sourceSize = { width: 1600, height: 896 };
  assert.equal(await w.runtime.sized(kept, { width: 1344, height: 768 }), kept);
  assert.equal(await w.runtime.sized({ requestId: randomUUID() }, { width: 1344, height: 768 }).then(made => made.plan), undefined, 'no proposal: as it came');
  assert.equal(tried.length, 0);
  w.runtime.revise = change;
  // What is foreseen of it is what will be made: its final, at the size of the film.
  const history = new ProgressHistory(join(await mkdtemp(join(tmpdir(), 'sized-')), 'timing.json'));
  w.runtime.timing = history;
  const sized = await w.runtime.sized(await byHand('create_video', wanted), { width: 1344, height: 768 });
  await history.save(timingKey(ltx.id, sized.plan.parameters, 0), [{ mark: 'loading', at: 3 }, { mark: 'done', at: 87 }]);
  assert.deepEqual((await w.runtime.foreseen(sized)).expected, { seconds: 87, exact: true });
});
