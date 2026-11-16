import assert from 'node:assert/strict';
import test from 'node:test';
import { setupFirstLaunch } from '../public/first-launch.mjs';
import { missingFileCard, sizeText } from '../public/missing-file.mjs';
import { ToolCatalog } from '../lib/tool-catalog.mjs';

// The states of etats-maquette.md (16/11): the first launch (50), a missing file (53).
class Element {
  constructor(tag = '', className = '', text = '') {
    Object.assign(this, { tag, className, textContent: text, children: [], parent: null, attributes: {}, style: {} });
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }
  append(...items) {
    for (const item of items) {
      if (typeof item !== 'object') continue;
      item.parent = this;
      this.children.push(item);
    }
  }
  replaceChildren(...items) {
    this.children = [];
    this.append(...items);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  get isConnected() {
    return Boolean(this.parent);
  }
}
const node = (...args) => new Element(...args);
const icon = glyph => Object.assign(new Element('svg'), { glyph });
const under = root => [root, ...root.children.flatMap(child => under(child))];
const find = (root, name) => under(root).filter(item => String(item.className).split(' ').includes(name));
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('50 · before the first message: the engine, then the LLM; both done, the message box comes back', async () => {
  let config = { enginePath: '', modelPath: '' };
  const host = new Element('section'),
    asked = [],
    jobs = [
      { state: 'idle' },
      { state: 'downloading', received: 64, total: 100 },
      { state: 'done', result: { enginePath: 'C:/llama/llama-server.exe' } },
    ];
  let done = 0;
  const answers = {
    llama: () => jobs.shift() ?? { state: 'done', result: { enginePath: 'C:/llama/llama-server.exe' } },
    'llama/check': () => ({ tag: 'b12359', candidates: [{ label: 'CUDA 13.5', size: 578 * 1048576 }] }),
    'llama/install': () => ({}),
    'files/choose': () => ({ path: 'D:/Modeles/Qwen3.5-9B-Instruct-Q5_K_M.gguf' }),
    'models/add': body => ({ profile: { id: 'q', ...body }, models: [{ id: 'q' }] }),
    'models/select': () => ({ config: { ...config, modelPath: 'D:/Modeles/Qwen3.5-9B-Instruct-Q5_K_M.gguf' } }),
  };
  const card = setupFirstLaunch({
    api: async (route, body) => {
      asked.push([route, body]);
      return { json: async () => answers[route](body) };
    },
    node,
    icon,
    host,
    config: () => config,
    onConfig: next => {
      config = next;
      card.sync(!(config.enginePath && config.modelPath));
    },
    onDone: () => done++,
  });
  card.sync(true);
  await settle();
  await settle();
  assert.equal(find(host, 'setup-kicker')[0].textContent, 'Avant le premier message');
  assert.equal(find(host, 'setup-count')[0].textContent, '0 / 2');
  const [engine, llm] = find(host, 'setup-text').map(item => item.textContent);
  assert.equal(
    engine,
    'llama-server fait tourner Moodix AI sur cet ordinateur. La version officielle pour votre carte : b12359 · CUDA 13.5 · 578 Mo.',
  );
  assert.match(llm, /^Un fichier GGUF sur cet ordinateur/);
  assert.equal(find(host, 'setup-foot')[0].textContent, 'Les images, les vidéos et les sons se règlent ensuite, dans Paramètres › Workflows.');
  // « Installer »: « TÉLÉCHARGEMENT · 64 % », the step ringed, then done.
  const install = find(host, 'setup-install')[0];
  const installing = install.onclick();
  await settle();
  await settle();
  await settle();
  assert.deepEqual(
    find(host, 'setup-progress-head')[0].children.map(item => item.textContent),
    ['Téléchargement', '64 %'],
  );
  assert.equal(find(host, 'is-current').length, 1);
  await new Promise(resolve => setTimeout(resolve, 900));
  await installing;
  assert.equal(config.enginePath, 'C:/llama/llama-server.exe');
  assert.equal(find(host, 'setup-count')[0].textContent, '1 / 2');
  assert.equal(done, 0, 'the LLM is still to choose');
  // The LLM: a file of this computer, registered and chosen; both done, the card goes.
  await find(host, 'setup-model')[0].onclick();
  await settle();
  assert.deepEqual(
    asked.find(([route]) => route === 'models/add')[1],
    { name: 'Qwen3.5-9B-Instruct-Q5_K_M', modelPath: 'D:/Modeles/Qwen3.5-9B-Instruct-Q5_K_M.gguf', projectorPath: '' },
  );
  assert.equal(host.hidden, true);
  assert.equal(done, 1, 'the model loads');
});

test('53 · a missing file: its card, the download as it goes, « Arrêter », and the request again once it is there', async () => {
  const host = new Element('div'),
    asked = [];
  let ready = 0;
  const jobs = [
    { job: { state: 'idle' } },
    { job: { state: 'running', workflowId: 'wan-scail2', received: 3.4 * 1024 ** 3, total: 28.6 * 1024 ** 3 } },
    { job: { state: 'done', workflowId: 'wan-scail2', received: 28.6 * 1024 ** 3, total: 28.6 * 1024 ** 3 } },
  ];
  const request = {
    requestId: 'r',
    tool: 'replace_character',
    workflowName: 'Wan SCAIL 2',
    mediaType: 'video',
    missing: {
      workflowId: 'wan-scail2',
      files: [{ file: 'wan2.2_scail_14B.safetensors', size: 28.6 * 1024 ** 3 }],
      bytes: 28.6 * 1024 ** 3,
      left: 28.6 * 1024 ** 3,
    },
  };
  const card = missingFileCard({
    host,
    request,
    node,
    icon,
    api: async (route, body) => {
      asked.push([route, body]);
      return {
        json: async () =>
          route === 'downloads/start'
            ? { state: 'running', workflowId: 'wan-scail2', received: 0, total: 28.6 * 1024 ** 3 }
            : route === 'downloads'
              ? (jobs.shift() ?? jobs.at(-1))
              : {},
      };
    },
    onReady: () => ++ready > 0,
    wait: () => settle(),
  });
  await settle();
  assert.equal(find(host, 'missing-head')[0].textContent, 'Il manque un fichier · Vidéo · Wan SCAIL 2');
  assert.deepEqual(
    find(host, 'missing-file')[0].children.map(item => item.textContent),
    ['', 'wan2.2_scail_14B.safetensors', '28,6 Go'],
  );
  assert.equal(find(host, 'missing-go')[0].children.at(-1).textContent, 'Télécharger · 28,6 Go');
  await card.start();
  assert.deepEqual(asked.find(([route]) => route === 'downloads/start')[1], { id: 'wan-scail2' });
  assert.equal(ready, 1, 'the request goes again');
  assert.equal(find(host, 'missing-done')[0].textContent, 'Le fichier est là. Je reprends votre demande…');
  assert.equal(sizeText(3.4 * 1024 ** 3), '3,4 Go');
  // Written in the conversation meanwhile: not sent on its own; « Reprendre la demande ».
  const later = new Element('div'),
    resumed = [];
  let polls = 0;
  const waiting = missingFileCard({
    host: later,
    request,
    node,
    icon,
    api: async route => ({
      json: async () =>
        route === 'downloads'
          ? { job: ++polls > 1 ? { state: 'done', workflowId: 'wan-scail2' } : { state: 'idle' } }
          : { state: 'running', workflowId: 'wan-scail2', received: 0, total: 1 },
    }),
    onReady: () => false,
    onResume: () => resumed.push(true),
    wait: () => settle(),
  });
  await settle();
  await waiting.start();
  assert.equal(find(later, 'missing-done')[0].textContent, 'Wan SCAIL 2 est prêt');
  const resume = find(later, 'missing-go')[0];
  assert.equal(resume.children.at(-1).textContent, 'Reprendre la demande');
  resume.onclick();
  assert.deepEqual(resumed, [true]);
  // « Annuler » leaves its line, as a proposal does.
  card.cancel();
  assert.deepEqual(
    host.children.map(child => [child.className, child.textContent]),
    [['proposal-cancelled', 'Proposition annulée.']],
  );
});

test('53 · a verb no ready workflow makes reaches the shipped one that lacks a file; a ready one comes first', async () => {
  const video = (id, extra = {}) => ({
    schemaVersion: 1,
    id,
    name: id,
    description: `Workflow ${id}`,
    enabled: true,
    ready: true,
    pipeline: 'ltx25',
    mediaType: 'video',
    parameters: { prompt: { policy: 'model', type: 'string' } },
    components: {},
    loras: [],
    references: [],
    ...extra,
  });
  const lacking = video('lacking', { ready: false, builtin: true, unavailableKind: 'files' }),
    broken = video('broken', { ready: false, builtin: true, unavailableReason: 'Fichier incompatible' });
  const alone = new ToolCatalog({ list: async () => [lacking, broken] });
  assert.ok((await alone.definitions()).some(tool => tool.function.name === 'create_video'));
  assert.equal((await alone.lacking('create_video'))?.id, 'lacking');
  const routed = await alone.route('create_video', { prompt: 'un phare', intention: 'x' }, { mediaOf: async () => 'image' });
  assert.equal(routed.workflow.id, 'lacking');
  // A workflow that is ready makes it: nothing is offered to download.
  const both = new ToolCatalog({ list: async () => [lacking, video('ready')] });
  assert.equal(await both.lacking('create_video'), null);
  assert.equal((await both.route('create_video', { prompt: 'un phare', intention: 'x' }, { mediaOf: async () => 'image' })).workflow.id, 'ready');
});
