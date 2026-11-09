import { randomUUID, createHash } from 'node:crypto';
import { basename } from 'node:path';
import { readWorkflowSource, localFiles, locateAsset, inspectKreaWorkflow } from './native-workflow-conversion.mjs';
import { inspectLongForge } from './longforge-conversion.mjs';
import { validateNativeWorkflow, jsonValue } from './native-workflows.mjs';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fixed = value => ({ policy: 'fixed', value });
const id = value => 'file-' + createHash('sha256').update(value).digest('hex').slice(0, 24);
const scalar = value => ['string', 'number', 'boolean'].includes(typeof value);
const names = {
  prompt: 'prompt',
  negative_prompt: 'negative_prompt',
  seed: 'seed',
  noise_seed: 'seed',
  width: 'width',
  height: 'height',
  steps: 'steps',
  cfg: 'cfg',
  denoise: 'denoise',
  fps: 'fps',
  frame_rate: 'fps',
  frames: 'frames',
  num_frames: 'frames',
  length: 'frames',
  duration: 'duration',
  audio: 'audio',
  overlap_frames: 'overlap_frames',
  start_strength: 'start_strength',
  end_strength: 'end_strength',
  msr_strength: 'msr_strength',
  msr_frames: 'msr_frames',
  image_compression: 'image_compression',
};
const widgets = {
  UNETLoader: ['unet_name', 'weight_dtype'],
  CheckpointLoaderSimple: ['ckpt_name'],
  CLIPLoader: ['clip_name', 'type', 'device'],
  DualCLIPLoader: ['clip_name1', 'clip_name2', 'type'],
  VAELoader: ['vae_name'],
  LoraLoaderModelOnly: ['lora_name', 'strength_model'],
  LoraLoader: ['lora_name', 'strength_model', 'strength_clip'],
  CLIPTextEncode: ['text'],
  EmptyLatentImage: ['width', 'height', 'batch_size'],
  LoadImage: ['image'],
  VHS_LoadVideo: ['video'],
  PrimitiveInt: ['value'],
  PrimitiveFloat: ['value'],
  PrimitiveBoolean: ['value'],
  PrimitiveString: ['value'],
  PrimitiveStringMultiline: ['value'],
};

function graphNodes(source) {
  const nodes = [];
  function editor(document, prefix = '') {
    const links = new Map(
      (Array.isArray(document.links) ? document.links : []).filter(Array.isArray).map(link => [link[0], link]),
    );
    for (const node of document.nodes || []) {
      if (!plain(node)) continue;
      const inputs = {};
      for (const entry of Array.isArray(node.inputs) ? node.inputs : [])
        if (entry?.name && entry.link !== null && entry.link !== undefined) {
          const link = links.get(entry.link);
          if (link) inputs[entry.name] = [prefix + link[1], link[2]];
        }
      const values = node.widgets_values;
      if (plain(values)) Object.assign(inputs, values);
      else if (Array.isArray(values)) {
        let keys = widgets[node.type] || [];
        if (node.type === 'KSampler')
          keys =
            typeof values[1] === 'string'
              ? ['seed', 'control_after_generate', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise']
              : ['seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'];
        const declared = (Array.isArray(node.inputs) ? node.inputs : [])
          .filter(input => input.widget?.name)
          .map(input => input.widget.name);
        if (!keys.length && declared.length === values.length) keys = declared;
        values.forEach((value, index) => {
          inputs[keys[index] || 'widget_' + index] = value;
        });
      }
      nodes.push({
        key: prefix + node.id,
        type: node.type || 'Node',
        title: node.title || node.type || 'Node',
        inputs,
      });
    }
    for (const [index, subgraph] of (Array.isArray(document.definitions?.subgraphs)
      ? document.definitions.subgraphs
      : []
    ).entries())
      editor(subgraph, prefix + 'sub' + index + ':');
  }
  if (Array.isArray(source.nodes)) editor(source);
  else
    for (const [key, node] of Object.entries(plain(source.graph) ? source.graph : source))
      if (plain(node) && typeof node.class_type === 'string' && plain(node.inputs))
        nodes.push({ key, type: node.class_type, title: node._meta?.title || node.class_type, inputs: node.inputs });
  if (!nodes.length || nodes.length > 2048)
    throw Object.assign(
      new Error('Le fichier ne contient pas de workflow Atelier ou ComfyUI lisible (2 048 nœuds maximum).'),
      { status: 400 },
    );
  return nodes;
}

export async function previewWorkflowImport(sourceText, { name = '', assets, modelRoot, additionalRoots = [] } = {}) {
  if (typeof name !== 'string' || name.length > 4096)
    throw Object.assign(new Error('Nom de fichier invalide.'), { status: 400 });
  const { source } = await readWorkflowSource(undefined, sourceText);
  jsonValue(source);
  if (!plain(source)) throw Object.assign(new Error('Un workflow JSON est attendu.'), { status: 400 });
  const atelier = source.schemaVersion === 1 && plain(source.components) && plain(source.parameters);
  const format = atelier ? 'atelier' : Array.isArray(source.nodes) ? 'comfy-editor' : 'comfy-api';
  let workflow = {
    schemaVersion: 1,
    id: randomUUID(),
    name: (name || (typeof source.name === 'string' ? source.name : '') || 'Workflow importé')
      .replace(/\.json$/i, '')
      .slice(0, 120),
    description: typeof source.description === 'string' ? source.description.slice(0, 2000) : '',
    enabled: false,
    pipeline: '',
    mediaType: 'image',
    components: {},
    parameters: {},
    loras: [],
    references: [],
  };
  const meta = { source, format, files: {}, extras: [], warnings: [], blockers: [] };
  const requests = [];
  function file(filename, kind) {
    if (typeof filename !== 'string' || !filename) return '';
    const key = id(kind + ':' + filename);
    meta.files[key] = filename;
    requests.push({ id: key, filename, kind });
    return key;
  }
  if (atelier) {
    const { digest, ready, unavailableReason, importDraft, ...record } = source;
    workflow = { ...record, id: workflow.id, enabled: false };
    if (importDraft) Object.assign(meta, importDraft);
    if (!['krea2', 'ltx25'].includes(workflow.pipeline)) {
      workflow.pipeline = '';
      meta.blockers.push('Le moteur de ce workflow n’est pas encore disponible.');
    }
    try {
      validateNativeWorkflow({ ...record, enabled: false });
    } catch (failure) {
      meta.warnings.push('Certains réglages nécessitent une vérification avant activation : ' + failure.message);
    }
  } else {
    const nodes = graphNodes(source),
      byId = new Map(nodes.map(node => [node.key, node]));
    const read = (value, seen = new Set()) => {
      if (Array.isArray(value) && value.length === 2 && byId.has(String(value[0]))) {
        const key = String(value[0]);
        if (seen.has(key)) return undefined;
        seen.add(key);
        const node = byId.get(key);
        if (node.type.startsWith('Primitive')) return read(node.inputs.value, seen);
        if (node.type === 'ComfySwitchNode') {
          const selected = read(node.inputs.switch, seen);
          return typeof selected === 'boolean' ? read(node.inputs[selected ? 'on_true' : 'on_false'], seen) : undefined;
        }
        return undefined;
      }
      return scalar(value) ? value : undefined;
    };
    workflow.pipeline = nodes.some(
      node => node.type.startsWith('LongForgeLTX') || ['ltxv', 'ltxv_audio'].includes(node.inputs.type),
    )
      ? 'ltx25'
      : nodes.some(node => node.inputs.type === 'krea2' || /Krea2/i.test(node.type))
        ? 'krea2'
        : '';
    workflow.mediaType = workflow.pipeline === 'ltx25' ? 'video' : 'image';
    const candidates = new Map();
    function candidate(key, value, node) {
      if (value === undefined) return;
      const values = candidates.get(key) || [];
      values.push({ value, node });
      candidates.set(key, values);
    }
    for (const [index, node] of nodes.entries()) {
      for (const [key, value] of Object.entries(node.inputs)) {
        meta.extras.push({
          id: 'setting-' + index + '-' + meta.extras.length,
          label: (node.title + ' [' + node.key + '] · ' + key).slice(0, 300),
          value,
        });
        if (names[key]) candidate(names[key], read(value), node);
      }
      const input = node.inputs;
      for (const [key, kind] of [
        ['unet_name', 'model'],
        ['ckpt_name', 'model'],
        ['clip_name', 'textEncoder'],
        ['vae_name', 'vae'],
      ])
        if (typeof input[key] === 'string' && !workflow.components[kind])
          workflow.components[kind] = { policy: 'fixed', asset: file(input[key], kind) };
      if (typeof input.lora_name === 'string')
        workflow.loras.push({
          id: 'lora-' + index,
          asset: file(input.lora_name, 'lora'),
          description: node.title.slice(0, 1000),
          enabled: fixed(typeof input.enabled === 'boolean' ? input.enabled : read(input.strength_model) !== 0),
          strength: fixed(read(input.strength_model) ?? 1),
        });
      if (['LoadImage', 'VHS_LoadVideo', 'LoadVideo'].includes(node.type)) {
        const filename = read(input.image ?? input.video ?? input.file),
          video = node.type !== 'LoadImage';
        workflow.references.push({
          id: 'reference-' + index,
          role: video ? 'source_video' : workflow.pipeline === 'krea2' ? 'img2img' : 'reference',
          required: false,
          name: String(filename || node.title).slice(0, 120),
          description: filename ? 'Fichier source : ' + filename : node.title,
        });
      }
      // Widget positions are used only for node types whose saved layout is known.
      if (node.type === 'LongForgeLTXVideoSettings')
        for (const [position, key] of [
          [0, 'width'],
          [1, 'height'],
          [2, 'duration'],
          [3, 'overlap_frames'],
        ]) {
          const value = input['widget_' + position];
          candidate(key, key === 'overlap_frames' && typeof value === 'string' ? Number(value) : value, node);
        }
    }
    for (const [key, values] of candidates) {
      const unique = [...new Map(values.map(entry => [JSON.stringify(entry.value), entry.value])).values()];
      if (unique.length === 1) workflow.parameters[key] = fixed(unique[0]);
      else meta.warnings.push('Plusieurs valeurs pour « ' + key + ' » : voir les réglages source.');
    }
    const encodes = nodes.filter(node => node.type === 'CLIPTextEncode');
    for (const [slot, key] of [
      ['positive', 'prompt'],
      ['negative', 'negative_prompt'],
    ]) {
      const samplers = nodes.filter(node => node.type === 'KSampler'),
        texts = samplers
          .map(node => node.inputs[slot])
          .map(link => (Array.isArray(link) ? byId.get(String(link[0])) : null))
          .filter(node => node?.type === 'CLIPTextEncode')
          .map(node => read(node.inputs.text))
          .filter(value => typeof value === 'string');
      if (new Set(texts).size === 1) workflow.parameters[key] = fixed(texts[0]);
    }
    if (!workflow.parameters.prompt && encodes.length === 1 && typeof read(encodes[0].inputs.text) === 'string')
      workflow.parameters.prompt = fixed(read(encodes[0].inputs.text));
    try {
      if (workflow.pipeline === 'krea2') {
        const plan = inspectKreaWorkflow(source);
        for (const [key, value] of Object.entries(plan.parameters))
          workflow.parameters[key] =
            key === 'prompt' ? { policy: 'model', type: 'string', maxLength: 8000, default: value } : fixed(value);
        if (plan.promptTemplate) workflow.promptTemplate = plan.promptTemplate;
        if (plan.promptExpansion) workflow.promptExpansion = plan.promptExpansion;
        for (const [kind, filename] of Object.entries(plan.components))
          workflow.components[kind] = { policy: 'fixed', asset: file(filename, kind) };
        workflow.loras = plan.loras.map(lora => ({
          ...lora,
          asset: file(lora.asset, 'lora'),
          description: 'LoRA importé',
          enabled: fixed(lora.enabled),
          strength: fixed(lora.strength),
        }));
        if (workflow.references.length > (plan.reference ? 1 : 0))
          meta.blockers.push(
            'Des images source supplémentaires ne sont pas reliées au chemin de génération pris en charge.',
          );
      } else if (workflow.pipeline === 'ltx25') {
        const plan = inspectLongForge(source, { strict: false });
        workflow.parameters = { ...workflow.parameters, ...plan.parameters };
        for (const [kind, filename] of Object.entries(plan.components))
          workflow.components[kind] = { policy: 'fixed', asset: file(filename, kind) };
        if (plan.msr) {
          workflow.loras.push({
            id: 'msr',
            asset: file(plan.msr.file, 'lora'),
            description: 'Références MSR',
            enabled: { policy: 'model', default: false },
            strength: fixed(plan.msr.strength),
          });
          workflow.parameters.msr_strength = fixed(plan.msr.guideStrength);
          workflow.parameters.msr_frames = fixed(plan.msr.frames);
        }
        meta.warnings.push(...plan.warnings);
        try {
          inspectLongForge(source);
        } catch (failure) {
          meta.blockers.push(
            'Le graphe source ne peut pas être exécuté fidèlement par le moteur actuel : ' + failure.message,
          );
        }
      } else meta.blockers.push('Choisissez un moteur compatible pour préparer l’exécution de ce workflow.');
    } catch (failure) {
      meta.blockers.push(
        'Le graphe source ne peut pas être exécuté fidèlement par le moteur actuel : ' + failure.message,
      );
    }
  }
  workflow.importDraft = meta;
  validateNativeWorkflow(workflow);
  let known = (await assets?.list()) || [],
    index;
  if (requests.length && workflow.pipeline) {
    try {
      index = await localFiles(modelRoot, additionalRoots);
    } catch {
      meta.warnings.push('Certains fichiers devront être sélectionnés dans l’éditeur.');
    }
  }
  const handled = new Set();
  for (const request of requests) {
    if (handled.has(request.id) || !workflow.pipeline) continue;
    handled.add(request.id);
    try {
      let asset = known.find(
        asset =>
          asset.kind === request.kind &&
          asset.family === workflow.pipeline &&
          (asset.path === request.filename || basename(asset.path) === request.filename),
      );
      if (!asset && index)
        asset = await assets.register({
          path: await locateAsset(index, request.filename),
          kind: request.kind,
          family: workflow.pipeline,
        });
      if (!asset) continue;
      known.push(asset);
      for (const policy of Object.values(workflow.components)) if (policy.asset === request.id) policy.asset = asset.id;
      for (const lora of workflow.loras) if (lora.asset === request.id) lora.asset = asset.id;
      meta.files[asset.id] = request.filename;
    } catch {
      meta.warnings.push('Fichier à vérifier : ' + request.filename);
    }
  }
  workflow.importDraft = meta;
  const record = validateNativeWorkflow(workflow);
  return { workflow: record, assets: known, warnings: meta.warnings };
}
