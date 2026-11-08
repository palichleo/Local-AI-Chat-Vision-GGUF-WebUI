import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function invalid(message){return Object.assign(new Error(message),{status:400});}
const MAX_BYTES = 2 * 1024 * 1024;
const PARAMETERS = ['prompt', 'negative_prompt', 'seed', 'width', 'height', 'image'];
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const owns = (object, key) => Object.hasOwn(object, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [null, Object.prototype].includes(Object.getPrototypeOf(value));

function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value) || DANGEROUS_KEYS.has(value)) {
    throw invalid('Invalid workflow id; use letters, numbers, hyphens or underscores');
  }
  return value;
}

function jsonValue(value, depth = 0, ancestors = new Set()) {
  if (depth > 64) throw invalid('Workflow JSON is too deeply nested');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!Array.isArray(value) && !plain(value)) throw invalid('Workflow must contain only JSON values');
  if (ancestors.has(value)) throw invalid('Workflow JSON must not contain cycles');
  ancestors.add(value);
  for (const child of Object.values(value)) jsonValue(child, depth + 1, ancestors);
  ancestors.delete(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function record(input) {
  if (!plain(input)) throw invalid('Workflow must be an object');
  const id = identifier(input.id === undefined ? randomUUID() : input.id);
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) throw invalid('Workflow name must contain 1 to 120 characters');
  const description = input.description === undefined ? '' : input.description;
  if (typeof description !== 'string' || description.length > 2000) throw invalid('Workflow description must be text of at most 2000 characters');
  const { graph, bindings, outputNodes } = input;
  if (plain(graph) && (Array.isArray(graph.nodes) || owns(graph, 'links') || owns(graph, 'last_node_id'))) {
    throw invalid('This is a ComfyUI editor workflow. In ComfyUI enable developer mode and export the workflow in API format, then import that JSON.');
  }
  if (!plain(graph)) throw invalid('Workflow graph must be an API-format object');
  const nodes = Object.keys(graph);
  if (!nodes.length || nodes.length > 512) throw invalid('Workflow graph must contain 1 to 512 nodes');
  for (const node of nodes) {
    if (!node || node.length > 100 || DANGEROUS_KEYS.has(node)) throw invalid('Invalid graph node id');
    const value = graph[node];
    if (!plain(value) || typeof value.class_type !== 'string' || !value.class_type.trim()
      || value.class_type.length > 200 || !plain(value.inputs)
      || Object.keys(value).some(key => !['class_type', 'inputs', '_meta'].includes(key))) {
      throw invalid(`Node ${node} must have class_type and inputs in ComfyUI API format`);
    }
    if (value._meta !== undefined && !plain(value._meta)) throw invalid(`Invalid metadata for node ${node}`);
  }
  if (!plain(bindings) || !owns(bindings, 'prompt')) throw invalid('A prompt binding is required');
  const targets = new Set();
  for (const [parameter, binding] of Object.entries(bindings)) {
    if (!PARAMETERS.includes(parameter)) throw invalid(`Unsupported workflow binding: ${parameter}`);
    if (!plain(binding) || Object.keys(binding).length !== 2 || !owns(binding, 'node') || !owns(binding, 'input')
      || typeof binding.node !== 'string' || !owns(graph, binding.node)
      || typeof binding.input !== 'string' || !binding.input || DANGEROUS_KEYS.has(binding.input)
      || !owns(graph[binding.node].inputs, binding.input)) throw invalid(`Invalid ${parameter} binding; select an existing node input`);
    const target = JSON.stringify([binding.node, binding.input]);
    if (targets.has(target)) throw invalid('Workflow bindings must target different inputs');
    targets.add(target);
  }
  if (!Array.isArray(outputNodes) || !outputNodes.length || outputNodes.length > 512
    || outputNodes.some(node => typeof node !== 'string' || !owns(graph, node))
    || new Set(outputNodes).size !== outputNodes.length) throw invalid('Select distinct existing output nodes');
  const requiresImage = input.requiresImage === undefined ? false : input.requiresImage;
  if (typeof requiresImage !== 'boolean' || (requiresImage && !owns(bindings, 'image'))) throw invalid('requiresImage must be boolean and needs an image binding');
  const workflow = { id, name: input.name.trim(), description, graph, bindings, outputNodes, requiresImage };
  jsonValue(workflow);
  const serialized = JSON.stringify(workflow);
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw invalid('Workflow exceeds the 2 MiB size limit');
  const copy = JSON.parse(serialized);
  return { ...copy, digest: createHash('sha256').update(canonical(copy)).digest('hex') };
}

function validateArgument(parameter, value) {
  if (parameter === 'prompt' || parameter === 'negative_prompt') {
    if (typeof value !== 'string' || value.length > 8000 || (parameter === 'prompt' && !value.trim())) {
      throw invalid(`${parameter} must be ${parameter === 'prompt' ? 'nonempty ' : ''}text of at most 8000 characters`);
    }
  } else if (parameter === 'seed') {
    if (!Number.isSafeInteger(value) || value < 0) throw invalid('seed must be an integer from 0 to Number.MAX_SAFE_INTEGER');
  } else if (parameter === 'width' || parameter === 'height') {
    if (!Number.isInteger(value) || value < 64 || value > 4096 || value % 8) throw invalid(`${parameter} must be a multiple of 8 from 64 to 4096`);
  } else if (parameter === 'reference_image') {
    if (!Number.isInteger(value) || value < 0 || value > 6399) throw invalid('reference_image must be a zero-based reference index from 0 to 6399');
  }
}

function uploadedImage(value) {
  const descriptor = typeof value === 'string' ? { filename: value } : value;
  if (!plain(descriptor)) throw invalid('An uploaded reference image is required');
  const filename = descriptor.filename ?? descriptor.name;
  const subfolder = descriptor.subfolder ?? '';
  const type = descriptor.type ?? 'input';
  const unsafePart = part => !part || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part);
  if (typeof filename !== 'string' || !filename || filename.length > 255 || /[\\/\x00-\x1f\x7f:\[\]]/.test(filename)
    || unsafePart(filename) || typeof subfolder !== 'string' || subfolder.length > 1024
    || /[\\\x00-\x1f\x7f:\[\]]/.test(subfolder)
    || (subfolder && subfolder.split('/').some(unsafePart))
    || !['input', 'output', 'temp'].includes(type)) throw invalid('Invalid uploaded reference image descriptor');
  return `${subfolder ? `${subfolder}/` : ''}${filename}${type === 'input' ? '' : ` [${type}]`}`;
}

export class WorkflowCatalog {
  constructor(directory) {
    if (typeof directory !== 'string' || !directory) throw invalid('Workflow directory is required');
    this.directory = resolve(directory);
  }

  async list() {
    let files;
    try { files = await readdir(this.directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const records = [];
    for (const file of files.sort()) {
      if (!file.endsWith('.json')) continue;
      const { graph, ...metadata } = await this.read(file.slice(0, -5));
      records.push(metadata);
    }
    return records;
  }

  async read(id) {
    const filename = join(this.directory, `${identifier(id)}.json`);
    try {
      const stat = await lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) throw invalid('Workflow file must be a regular file');
      if (stat.size > MAX_BYTES) throw invalid('Workflow exceeds the 2 MiB size limit');
      const bytes = await readFile(filename);
      if (bytes.length > MAX_BYTES) throw invalid('Workflow exceeds the 2 MiB size limit');
      const data = JSON.parse(bytes.toString('utf8'));
      if (data.id !== id) throw invalid('Stored workflow id does not match its filename');
      return record(data);
    }
    catch (error) {
      if (error.code === 'ENOENT') throw invalid(`Workflow ${id} not found`);
      throw error;
    }
  }

  async save(input) {
    const workflow = record(input);
    const bytes = JSON.stringify(workflow);
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw invalid('Workflow exceeds the 2 MiB size limit');
    await mkdir(this.directory, { recursive: true });
    const temporary = join(this.directory, `.${workflow.id}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporary, join(this.directory, `${workflow.id}.json`));
    } finally { await rm(temporary, { force: true }); }
    return workflow;
  }

  async remove(id) {
    await rm(join(this.directory, `${identifier(id)}.json`), { force: true });
  }

  async prepare(id, args, { referenceImage } = {}) {
    const workflow = await this.read(id);
    if (!plain(args)) throw invalid('Workflow arguments must be an object');
    if (!owns(args, 'prompt')) throw invalid('prompt is required');
    for (const [parameter, value] of Object.entries(args)) {
      if (parameter === 'workflow_id') {
        if (value !== id) throw invalid('workflow_id does not match the selected workflow');
        continue;
      }
      const binding = parameter === 'reference_image' ? 'image' : parameter;
      if (!PARAMETERS.includes(binding) || parameter === 'image' || !owns(workflow.bindings, binding)) {
        throw invalid(`Workflow ${id} does not support parameter ${parameter}`);
      }
      validateArgument(parameter, value);
    }
    if ((workflow.requiresImage || owns(args, 'reference_image')) && referenceImage == null) throw invalid('An uploaded reference image is required');
    const graph = structuredClone(workflow.graph);
    for (const [parameter, binding] of Object.entries(workflow.bindings)) {
      if (parameter === 'image') {
        if (referenceImage != null) graph[binding.node].inputs[binding.input] = uploadedImage(referenceImage);
      } else if (owns(args, parameter)) graph[binding.node].inputs[binding.input] = args[parameter];
    }
    return { graph, workflow, outputNodes: [...workflow.outputNodes] };
  }

  async definition() {
    const workflows = await this.list();
    if (!workflows.length) return null;
    const supported = new Set(workflows.flatMap(workflow => Object.keys(workflow.bindings)));
    const properties = {
      workflow_id: { type: 'string', enum: workflows.map(workflow => workflow.id), description: 'Registered local workflow to run.' },
      prompt: { type: 'string', minLength: 1, maxLength: 8000, description: 'Image generation or editing instruction.' },
    };
    if (supported.has('negative_prompt')) properties.negative_prompt = { type: 'string', maxLength: 8000, description: 'Content to avoid, only for workflows supporting negative_prompt.' };
    if (supported.has('seed')) properties.seed = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'Generation seed, only for workflows supporting seed.' };
    for (const dimension of ['width', 'height']) {
      if (supported.has(dimension)) properties[dimension] = { type: 'integer', minimum: 64, maximum: 4096, multipleOf: 8, description: `Image ${dimension}, only for workflows supporting ${dimension}.` };
    }
    if (supported.has('image')) properties.reference_image = { type: 'integer', minimum: 0, maximum: 6399, description: 'Zero-based index of user-supplied images in chronological order (excluding generated outputs), only for workflows supporting reference_image.' };
    const description = workflows.map(workflow => `${workflow.id} (${workflow.name}): ${workflow.description} Supported parameters: ${Object.keys(workflow.bindings).map(key => key === 'image' ? 'reference_image' : key).join(', ')}.${workflow.requiresImage ? ' A reference image is required.' : ''}`).join('\n');
    return {
      type: 'function', function: {
        name: 'comfy_generate_image', description: `Generate or edit an image when the user asks for an image to be produced or changed. Ordinary questions, image analysis and writing a prompt do not need this tool. Select a workflow according to its description and use only its supported parameters.\n${description}`,
        parameters: { type: 'object', properties, required: ['workflow_id', 'prompt'], additionalProperties: false },
      },
    };
  }
}
