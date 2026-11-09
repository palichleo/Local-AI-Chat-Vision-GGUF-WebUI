import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { validateNativeWorkflow } from './native-workflows.mjs';
import { suggestTokenizer } from './generation-assets.mjs';

const invalid = message => Object.assign(new Error(message), { status: 400 });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const allowed = new Set([
  'SaveImage',
  'LivePreview',
  'LoadImage',
  'PrimitiveFloat',
  'PrimitiveInt',
  'PrimitiveBoolean',
  'PrimitiveString',
  'PrimitiveStringMultiline',
  'ResolutionSelector',
  'UNETLoader',
  'LoraLoaderModelOnly',
  'ComfySwitchNode',
  'CLIPTextEncode',
  'EmptyLatentImage',
  'KSampler',
  'VAEDecode',
  'CLIPLoader',
  'VAELoader',
  'ConditioningZeroOut',
  'TextGenerate',
  'StringConcatenate',
  'PreviewAny',
  'VAEEncode',
  'ImageScale',
]);
const RAW = '{{prompt}}',
  EXPANDED = '{{native_expanded_prompt}}';
const fixed = value => ({ policy: 'fixed', value });

function workflowFromPlan(
  plan,
  {
    id = randomUUID(),
    name = 'Converted Krea2 workflow',
    description = 'Local Krea2 workflow converted explicitly from its saved Comfy API graph.',
    components,
    loras,
  } = {},
) {
  return validateNativeWorkflow({
    schemaVersion: 1,
    id,
    name,
    description,
    enabled: false,
    pipeline: 'krea2',
    mediaType: 'image',
    components:
      components ??
      Object.fromEntries(['model', 'textEncoder', 'vae'].map(role => [role, { policy: 'fixed', asset: role }])),
    parameters: Object.fromEntries(
      Object.entries(plan.parameters).map(([name, value]) => [
        name,
        name === 'prompt' ? { policy: 'model', type: 'string', maxLength: 8000, default: value } : fixed(value),
      ]),
    ),
    loras:
      loras ??
      plan.loras.map(lora => ({
        id: lora.id,
        asset: lora.id,
        description: 'Imported local LoRA',
        enabled: lora.enabled ? fixed(true) : { policy: 'off' },
        strength: fixed(lora.strength),
      })),
    references: plan.reference
      ? [
          {
            id: 'source',
            name: 'Source image',
            description: 'Supply the image for the imported img2img operation.',
            role: 'img2img',
            required: true,
          },
        ]
      : [],
    ...(plan.promptTemplate && plan.promptTemplate !== RAW ? { promptTemplate: plan.promptTemplate } : {}),
    ...(plan.promptExpansion ? { promptExpansion: plan.promptExpansion } : {}),
  });
}

export function inspectKreaWorkflow(input) {
  const graph = plain(input?.graph) ? input.graph : input;
  if (!plain(graph) || Array.isArray(graph.nodes) || Object.hasOwn(graph, 'links'))
    throw invalid('Only supported Krea2 API graphs can be converted; editor graphs are unsupported');
  const entries = Object.entries(graph);
  if (!entries.length || entries.length > 512) throw invalid('Invalid Krea2 API graph size');
  for (const [id, node] of entries)
    if (!id || !plain(node) || !plain(node.inputs) || !allowed.has(node.class_type))
      throw invalid(`Unsupported graph node ${id}: ${node?.class_type ?? 'unknown'}`);
  const active = new Set();
  function nodeAt(link) {
    if (
      !Array.isArray(link) ||
      link.length !== 2 ||
      typeof link[0] !== 'string' ||
      !Object.hasOwn(graph, link[0]) ||
      !Number.isInteger(link[1]) ||
      link[1] < 0 ||
      link[1] > 1
    )
      throw invalid('Unsupported or invalid graph connection');
    if (link[1] !== 0 && graph[link[0]].class_type !== 'ResolutionSelector')
      throw invalid('Unsupported graph output index');
    return { id: link[0], node: graph[link[0]], index: link[1] };
  }
  function enter(id) {
    if (active.has(id) || active.size > 64) throw invalid('Cyclic or deeply nested graph is unsupported');
    active.add(id);
  }
  function bool(value) {
    if (typeof value !== 'boolean') throw invalid('A graph switch must resolve to a boolean');
    return value;
  }
  function value(input, { rawId, expand = EXPANDED, onExpansion } = {}) {
    if (!Array.isArray(input)) return input;
    const { id, node, index } = nodeAt(input);
    enter(id);
    try {
      if (id === rawId) return RAW;
      const get = name => value(node.inputs[name], { rawId, expand, onExpansion });
      if (node.class_type.startsWith('Primitive')) return get('value');
      if (node.class_type === 'ResolutionSelector') {
        const match = /^(\d+):(\d+)(?:\s|$)/.exec(node.inputs.aspect_ratio);
        const { megapixels, multiple } = node.inputs;
        if (!match || !Number.isFinite(megapixels) || megapixels <= 0 || !Number.isInteger(multiple) || multiple < 1)
          throw invalid('Unsupported resolution selector');
        const a = Number(match[1]),
          b = Number(match[2]);
        if (!a || !b) throw invalid('Invalid resolution aspect ratio');
        const scale = Math.sqrt((megapixels * 1024 ** 2) / (a * b));
        return Math.round(((index === 0 ? a : b) * scale) / multiple) * multiple;
      }
      if (node.class_type === 'StringConcatenate') {
        const a = get('string_a'),
          b = get('string_b'),
          delimiter = node.inputs.delimiter;
        if (typeof a !== 'string' || typeof b !== 'string' || typeof delimiter !== 'string')
          throw invalid('Only text concatenation is supported');
        return a + delimiter + b;
      }
      if (node.class_type === 'ComfySwitchNode') return get(bool(get('switch')) ? 'on_true' : 'on_false');
      if (node.class_type === 'PreviewAny') return get('source');
      if (node.class_type === 'TextGenerate') {
        onExpansion?.(id);
        return expand;
      }
      throw invalid(`Unsupported value node ${id}: ${node.class_type}`);
    } finally {
      active.delete(id);
    }
  }
  function selected(link) {
    const { id, node } = nodeAt(link);
    enter(id);
    try {
      if (node.class_type === 'ComfySwitchNode')
        return selected(node.inputs[bool(value(node.inputs.switch)) ? 'on_true' : 'on_false']);
      return { id, node };
    } finally {
      active.delete(id);
    }
  }
  function leaf(link) {
    const chosen = selected(link),
      { id, node } = chosen;
    enter(id);
    try {
      if (node.class_type.startsWith('Primitive'))
        return Array.isArray(node.inputs.value) ? leaf(node.inputs.value) : { id, text: node.inputs.value };
      if (node.class_type === 'PreviewAny') return leaf(node.inputs.source);
      if (node.class_type === 'StringConcatenate') return leaf(node.inputs.string_a);
      throw invalid(`Unsupported raw prompt source ${node.class_type}`);
    } finally {
      active.delete(id);
    }
  }
  const saves = entries.filter(([, node]) => node.class_type === 'SaveImage');
  if (saves.length !== 1) throw invalid('Conversion requires one SaveImage output');
  let output = selected(saves[0][1].inputs.images),
    hops = 0;
  while (output.node.class_type === 'LivePreview') {
    if (++hops > 64) throw invalid('Cyclic preview graph');
    output = selected(output.node.inputs.images);
  }
  if (output.node.class_type !== 'VAEDecode') throw invalid('SaveImage must receive a supported VAE decode');
  const vae = selected(output.node.inputs.vae);
  if (vae.node.class_type !== 'VAELoader') throw invalid('Unsupported VAE loader');
  const sampler = selected(output.node.inputs.samples);
  if (sampler.node.class_type !== 'KSampler') throw invalid('Only a supported Krea KSampler can be converted');
  const data = sampler.node.inputs;
  if (data.sampler_name !== 'euler' || data.scheduler !== 'simple')
    throw invalid('Only Euler sampler with simple scheduler is supported');
  if (value(data.cfg) !== 1) throw invalid('Only Krea2 CFG=1 is supported');
  const positive = selected(data.positive);
  if (positive.node.class_type !== 'CLIPTextEncode') throw invalid('Unsupported positive conditioning');
  const encoder = selected(positive.node.inputs.clip);
  if (encoder.node.class_type !== 'CLIPLoader' || encoder.node.inputs.type !== 'krea2')
    throw invalid('Only the Krea2 text encoder family is supported');
  const expansions = new Set();
  const positiveText = value(positive.node.inputs.text, { onExpansion: id => expansions.add(id) });
  if (typeof positiveText !== 'string' || expansions.size > 1)
    throw invalid('Unsupported prompt graph or multiple expansion nodes');
  let raw, promptTemplate, promptExpansion;
  if (expansions.size) {
    const expandId = [...expansions][0],
      expandNode = graph[expandId];
    const alternatives = entries.filter(
      ([, node]) =>
        node.class_type === 'ComfySwitchNode' &&
        Array.isArray(node.inputs.on_true) &&
        node.inputs.on_true[0] === expandId,
    );
    if (alternatives.length !== 1) throw invalid('Prompt expansion requires one explicit raw-prompt fallback switch');
    raw = leaf(alternatives[0][1].inputs.on_false);
    const expansionTemplate = value(expandNode.inputs.prompt, { rawId: raw.id });
    const finalTemplate = value(positive.node.inputs.text, { rawId: raw.id });
    if (
      typeof expansionTemplate !== 'string' ||
      expansionTemplate.split(RAW).length !== 2 ||
      typeof finalTemplate !== 'string' ||
      !finalTemplate.startsWith(EXPANDED) ||
      finalTemplate.split(EXPANDED).length !== 2
    )
      throw invalid('Unsupported prompt expansion template or prefix');
    const inputs = expandNode.inputs;
    if (
      inputs['sampling_mode'] !== 'on' ||
      inputs.thinking !== false ||
      inputs.use_default_template !== true ||
      inputs['sampling_mode.presence_penalty'] !== 0 ||
      inputs.mtp !== 'auto'
    )
      throw invalid('Unsupported expansion mode, template, thinking or presence penalty');
    const expansionEncoder = selected(inputs.clip);
    if (expansionEncoder.id !== encoder.id) throw invalid('Expansion must use the same local text encoder');
    promptExpansion = {
      template: expansionTemplate,
      maxTokens: value(inputs.max_length),
      temperature: inputs['sampling_mode.temperature'],
      topK: inputs['sampling_mode.top_k'],
      topP: inputs['sampling_mode.top_p'],
      minP: inputs['sampling_mode.min_p'],
      repetitionPenalty: inputs['sampling_mode.repetition_penalty'],
      seed: inputs['sampling_mode.seed'],
      suffix: finalTemplate.slice(EXPANDED.length),
    };
    promptTemplate = value(positive.node.inputs.text, { rawId: raw.id, expand: RAW });
  } else {
    if (Array.isArray(positive.node.inputs.text)) {
      raw = leaf(positive.node.inputs.text);
      promptTemplate = value(positive.node.inputs.text, { rawId: raw.id });
    } else {
      raw = { text: positiveText };
      promptTemplate = RAW;
    }
  }
  if (typeof raw.text !== 'string' || typeof promptTemplate !== 'string' || promptTemplate.split(RAW).length !== 2)
    throw invalid('Only one replaceable raw text prompt is supported');
  const loras = new Map(),
    models = new Set(),
    visiting = new Set();
  function modelBranch(link, enabled) {
    const { id, node } = nodeAt(link);
    if (visiting.has(id) || visiting.size > 64) throw invalid('Cyclic model graph');
    visiting.add(id);
    try {
      if (node.class_type === 'ComfySwitchNode') {
        const on = bool(value(node.inputs.switch));
        modelBranch(node.inputs.on_true, enabled && on);
        modelBranch(node.inputs.on_false, enabled && !on);
        return;
      }
      if (node.class_type === 'UNETLoader') {
        if (enabled) models.add(node.inputs.unet_name);
        return;
      }
      if (node.class_type !== 'LoraLoaderModelOnly') throw invalid(`Unsupported model chain node ${node.class_type}`);
      modelBranch(node.inputs.model, enabled);
      const previous = loras.get(id);
      loras.set(id, {
        id: `lora-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`,
        asset: node.inputs.lora_name,
        strength: value(node.inputs.strength_model),
        enabled: enabled || previous?.enabled === true,
      });
    } finally {
      visiting.delete(id);
    }
  }
  modelBranch(data.model, true);
  if (models.size !== 1) throw invalid('Expected one selected local Krea2 model');
  const latent = selected(data.latent_image);
  let width,
    height,
    reference = false;
  if (latent.node.class_type === 'EmptyLatentImage') {
    if (value(latent.node.inputs.batch_size) !== 1) throw invalid('Only a single image batch is supported');
    width = value(latent.node.inputs.width);
    height = value(latent.node.inputs.height);
  } else if (latent.node.class_type === 'VAEEncode') {
    const scale = selected(latent.node.inputs.pixels);
    if (
      scale.node.class_type !== 'ImageScale' ||
      scale.node.inputs.upscale_method !== 'lanczos' ||
      scale.node.inputs.crop !== 'center'
    )
      throw invalid('Only centered Lanczos img2img scaling is supported');
    if (
      selected(scale.node.inputs.image).node.class_type !== 'LoadImage' ||
      selected(latent.node.inputs.vae).id !== vae.id
    )
      throw invalid('Unsupported image source or input VAE');
    width = value(scale.node.inputs.width);
    height = value(scale.node.inputs.height);
    reference = true;
  } else throw invalid('Unsupported latent image input');
  const plan = {
    components: { model: [...models][0], textEncoder: encoder.node.inputs.clip_name, vae: vae.node.inputs.vae_name },
    parameters: {
      prompt: raw.text,
      seed: value(data.seed),
      width,
      height,
      steps: value(data.steps),
      cfg: 1,
      denoise: value(data.denoise),
      expandPrompt: expansions.size === 1,
    },
    loras: [...loras.values()],
    reference,
    promptTemplate,
    ...(promptExpansion ? { promptExpansion } : {}),
  };
  workflowFromPlan(plan);
  return plan;
}

function assetName(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 1024 ||
    isAbsolute(value) ||
    /^[a-z]:/i.test(value) ||
    /[\x00-\x1f:]/.test(value)
  )
    throw invalid('Graph asset filename must be a relative local model path');
  const normalized = value.replaceAll('\\', '/');
  if (normalized.split('/').some(part => !part || part === '.' || part === '..'))
    throw invalid('Unsafe graph asset path');
  return normalized;
}
export async function localFiles(modelRoot, additionalRoots = []) {
  if (typeof modelRoot !== 'string' || !isAbsolute(modelRoot)) throw invalid('Select an absolute local model root');
  const root = await realpath(modelRoot);
  if (!(await lstat(root)).isDirectory()) throw invalid('Model root must be a directory');
  const files = [],
    roots = [root];
  for (const directory of additionalRoots) {
    try {
      const path = await realpath(directory);
      if (!roots.includes(path) && (await lstat(path)).isDirectory()) roots.push(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const visited = new Set();
  async function walk(directory, depth) {
    if (visited.has(directory)) return;
    visited.add(directory);
    if (depth > 32 || files.length > 100000) throw invalid('Model root is too large; select a more specific folder');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.safetensors')) files.push(path);
    }
  }
  for (const directory of roots) await walk(directory, 0);
  return { root, roots, files };
}
export async function locateAsset(index, name) {
  const suffix = assetName(name),
    fold = value => (process.platform === 'win32' ? value.toLowerCase() : value);
  const roots = index.roots || [index.root];
  const matches = index.files.filter(path =>
    roots.some(root => {
      const name = relative(root, path).replaceAll('\\', '/');
      return fold(name) === fold(suffix) || fold(name).endsWith(`/${fold(suffix)}`);
    }),
  );
  if (matches.length !== 1) throw invalid(`Expected one matching local asset ${suffix}; found ${matches.length}`);
  const path = await realpath(matches[0]);
  if (
    !roots.some(root => {
      const inside = relative(root, path);
      return !isAbsolute(inside) && inside !== '..' && !inside.startsWith('..\\') && !inside.startsWith('../');
    })
  )
    throw invalid('Asset path escapes the selected model root');
  if (!(await lstat(path)).isFile()) throw invalid('Selected asset must be a regular local file');
  return path;
}

export async function readWorkflowSource(sourcePath, sourceText) {
  let bytes;
  if (sourceText !== undefined) {
    if (typeof sourceText !== 'string' || Buffer.byteLength(sourceText) > 2 * 1024 * 1024)
      throw invalid('Workflow limité à 2 Mo.');
    bytes = Buffer.from(sourceText);
  } else {
    if (typeof sourcePath !== 'string' || !isAbsolute(sourcePath))
      throw invalid('Select an absolute local workflow source path');
    const stat = await lstat(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024)
      throw invalid('Source workflow must be a regular JSON file below 2 MiB');
    bytes = await readFile(sourcePath);
    if (bytes.length > 2 * 1024 * 1024) throw invalid('Source workflow exceeds 2 MiB');
  }
  let source;
  try {
    source = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw invalid('Invalid source workflow JSON');
  }
  return { bytes, source };
}

export async function convertKreaWorkflow(
  sourcePath,
  { assets, catalog, modelRoot, additionalRoots, backupDir, id, name, description, sourceText } = {},
) {
  const { bytes, source } = await readWorkflowSource(sourcePath, sourceText);
  const plan = inspectKreaWorkflow(source),
    index = await localFiles(modelRoot, additionalRoots),
    requests = [];
  for (const [kind, filename] of Object.entries(plan.components))
    requests.push({ key: kind, kind, path: await locateAsset(index, filename) });
  for (const lora of plan.loras)
    requests.push({ key: lora.id, kind: 'lora', path: await locateAsset(index, lora.asset) });
  if (!assets?.register || !catalog?.save) throw invalid('Native asset registry and catalog are required');
  // Comfy keeps the tokenizer inside its own code, so the graph never names it: find it from the encoder.
  const known = typeof assets.list === 'function' ? await assets.list() : [];
  const encoderPath = requests.find(request => request.key === 'textEncoder')?.path;
  const tokenizer = encoderPath
    ? await suggestTokenizer(
        encoderPath,
        known.filter(asset => asset.kind === 'tokenizer').map(asset => asset.path),
      )
    : null;
  if (!tokenizer)
    throw invalid(
      'Tokenizer introuvable pour cet encodeur de texte. Créez le workflow depuis l’éditeur et choisissez le dossier du tokenizer.',
    );
  const directory = resolve(backupDir ?? dirname(sourcePath));
  await mkdir(directory, { recursive: true });
  const backupPath = join(directory, `comfy-krea-backup-${randomUUID()}.json`);
  await writeFile(backupPath, bytes, { flag: 'wx', mode: 0o600 });
  const registered = [],
    ids = new Map(),
    existing = typeof assets.list === 'function' ? await assets.list() : [];
  for (const request of requests) {
    const previous = existing.find(
      asset => asset.path === request.path && asset.kind === request.kind && asset.family === 'krea2',
    );
    const asset =
      previous ??
      (await assets.register({
        id: randomUUID(),
        name: `Krea2 ${request.kind}`,
        path: request.path,
        kind: request.kind,
        family: 'krea2',
      }));
    registered.push(asset);
    ids.set(request.key, asset.id);
  }
  const components = Object.fromEntries(
    Object.keys(plan.components).map(role => [role, { policy: 'fixed', asset: ids.get(role) }]),
  );
  const tokenizerAsset =
    existing.find(asset => asset.path === tokenizer.path && asset.kind === 'tokenizer' && asset.family === 'krea2') ??
    (await assets.register({
      id: randomUUID(),
      name: 'Krea2 tokenizer',
      path: tokenizer.path,
      kind: 'tokenizer',
      family: 'krea2',
    }));
  registered.push(tokenizerAsset);
  components.tokenizer = { policy: 'fixed', asset: tokenizerAsset.id };
  const loras = plan.loras.map(lora => ({
    id: lora.id,
    asset: ids.get(lora.id),
    description: 'Imported local LoRA',
    enabled: lora.enabled ? fixed(true) : { policy: 'off' },
    strength: fixed(lora.strength),
  }));
  const workflow = await catalog.save(
    workflowFromPlan(plan, {
      id,
      name: name ?? source.name ?? 'Converted Krea2 workflow',
      description:
        description ??
        source.description ??
        'Local Krea2 workflow converted explicitly from its saved Comfy API graph.',
      components,
      loras,
    }),
  );
  return {
    workflow,
    backupPath,
    assets: registered,
    warnings: plan.reference
      ? ['The original saved image was not copied. Supply a source image reference when running this workflow.']
      : [],
  };
}
