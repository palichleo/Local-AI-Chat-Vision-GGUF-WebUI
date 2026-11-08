import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function invalid(message){return Object.assign(new Error(message),{status:400});}
const MAX_BYTES = 2 * 1024 * 1024;
const PARAMETERS = ['prompt', 'negative_prompt', 'seed', 'width', 'height', 'image', 'frames', 'fps'];
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
  const mediaType=input.mediaType??'image';
  if(!['image','video'].includes(mediaType))throw invalid('Workflow mediaType must be image or video');
  const videoStages=input.videoStages;
  if(mediaType==='video'&&(!Array.isArray(videoStages)||!videoStages.length||videoStages.some(stage=>!['draft','final'].includes(stage))||new Set(videoStages).size!==videoStages.length))throw invalid('Video workflows must declare supported draft/final stages');
  if(mediaType!=='video'&&videoStages!==undefined)throw invalid('Video stages require a video workflow');
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
    if (!PARAMETERS.includes(parameter)||mediaType!=='video'&&['frames','fps'].includes(parameter)) throw invalid(`Unsupported workflow binding: ${parameter}`);
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
  if (input.imageInputs !== undefined) {
    if (!Array.isArray(input.imageInputs) || input.imageInputs.length > 64 || owns(bindings, 'image')) throw invalid('Use either imageInputs (up to 64) or the legacy image binding');
    const ids = new Set();
    for (const slot of input.imageInputs) {
      if (!plain(slot) || Object.keys(slot).some(key => !['id','name','description','node','input','required'].includes(key))) throw invalid('Invalid image input');
      identifier(slot.id);
      if (ids.has(slot.id) || typeof slot.name !== 'string' || !slot.name.trim() || slot.name.length > 80 || typeof slot.description !== 'string' || !slot.description.trim() || slot.description.length > 300 || typeof slot.required !== 'boolean') throw invalid('Image inputs need a unique ID, a name, a role description and a required flag');
      if (typeof slot.node !== 'string' || !owns(graph, slot.node) || typeof slot.input !== 'string' || DANGEROUS_KEYS.has(slot.input) || !owns(graph[slot.node].inputs, slot.input) || typeof graph[slot.node].inputs[slot.input] !== 'string') throw invalid('Image inputs must target an existing filename string, not a graph connection');
      const target = JSON.stringify([slot.node, slot.input]);
      if (targets.has(target)) throw invalid('Workflow bindings must target different inputs');
      targets.add(target);ids.add(slot.id);
    }
  }
  const requiresImage = input.requiresImage === undefined ? false : input.requiresImage;
  if (typeof requiresImage !== 'boolean' || (requiresImage && !owns(bindings, 'image'))) throw invalid('requiresImage must be boolean and needs an image binding');
  const workflow = { ...(input.mediaType!==undefined?{mediaType}:{}),...(mediaType==='video'?{videoStages}:{}),id, name: input.name.trim(), description, graph, bindings, outputNodes, requiresImage, ...(input.imageInputs !== undefined ? {imageInputs:input.imageInputs} : {}) };
  jsonValue(workflow);
  const serialized = JSON.stringify(workflow);
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw invalid('Workflow exceeds the 2 MiB size limit');
  const copy = JSON.parse(serialized);
  return { ...copy, digest: createHash('sha256').update(canonical(copy)).digest('hex') };
}

export function validateWorkflow(input) {
  const workflow = record(input);
  if (Buffer.byteLength(JSON.stringify(workflow)) > MAX_BYTES) throw invalid('Workflow exceeds the 2 MiB size limit');
  return workflow;
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
   } else if(parameter==='frames'){
    if(!Number.isInteger(value)||value<1||value>36000)throw invalid('frames must be an integer from 1 to 36000');
  } else if(parameter==='fps'){
    if(!Number.isFinite(value)||value<0.1||value>240)throw invalid('fps must be from 0.1 to 240');
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

export function workflowImageInputs(workflow) {
  return workflow.imageInputs ?? (workflow.bindings?.image ? [{id:'image',name:'Image de référence',description:'',required:workflow.requiresImage,...workflow.bindings.image}] : []);
}

export function workflowConnectedNodes(workflow){
 const connected=new Set(),queue=[...workflow.outputNodes];
 while(queue.length){const id=queue.pop();if(connected.has(id))continue;connected.add(id);for(const value of Object.values(workflow.graph[id]?.inputs||{}))if(Array.isArray(value)&&value.length===2&&typeof value[0]==='string'&&Object.hasOwn(workflow.graph,value[0])&&Number.isInteger(value[1])&&value[1]>=0)queue.push(value[0]);}
 return connected;
}

export function workflowOutputSize(workflow,args={}){
 const value=key=>Object.hasOwn(args,key)?args[key]:(()=>{const binding=workflow.bindings?.[key];return binding&&workflow.graph?.[binding.node]?.inputs[binding.input];})();
 const width=value('width'),height=value('height');
 return [width,height].every(number=>Number.isInteger(number)&&number>0&&number<=131072)?{width,height}:null;
}

export function workflowReferences(workflow, args, provided = []) {
  const slots=workflowImageInputs(workflow);
  const legacy=['reference_image','reference_resource','reference_frame'].some(key=>owns(args,key));
  let references=[];
  if(owns(args,'references')) {
    if(legacy || !Array.isArray(args.references) || args.references.length>64) throw invalid('references must be an array of at most 64 assignments; do not mix reference formats');
    references=[...args.references];
  } else if(legacy) {
    if(!workflow.bindings?.image || args.reference_image!==undefined&&args.reference_resource!==undefined || args.reference_frame!==undefined&&args.reference_resource===undefined) throw invalid('Unsupported or conflicting reference source');
    references=[{input:'image',...(args.reference_resource!==undefined?{resource_id:args.reference_resource,...(args.reference_frame!==undefined?{frame:args.reference_frame}:{})}:{image:args.reference_image})}];
  }
  const seen=new Set();
  for(const ref of references) {
    if(!plain(ref) || Object.keys(ref).some(key=>!['input','image','resource_id','frame'].includes(key)) || !slots.some(slot=>slot.id===ref.input) || seen.has(ref.input)) throw invalid('Select a distinct declared workflow image input for each reference');
    seen.add(ref.input);
    if(owns(ref,'image')===owns(ref,'resource_id')) throw invalid('Each reference needs exactly one source: image or resource_id');
    if(owns(ref,'image')) { validateArgument('reference_image',ref.image);if(owns(ref,'frame'))throw invalid('frame requires a video resource_id'); }
    else if(typeof ref.resource_id!=='string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(ref.resource_id) || owns(ref,'frame')&&(!Number.isInteger(ref.frame)||ref.frame<0||ref.frame>2)) throw invalid('Invalid resource reference or frame');
  }
  for(const slot of slots)if(slot.required&&!seen.has(slot.id)&&!(workflow.bindings?.image&&slot.id==='image'&&provided.includes('image')))throw invalid(`A reference image is required for ${slot.name}`);
  return references;
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
    const workflow = validateWorkflow(input);
    const bytes = JSON.stringify(workflow);
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

  async prepare(id, args, { referenceImage, referenceImages = {} } = {}) {
    const workflow = await this.read(id);
    if (!plain(args)) throw invalid('Workflow arguments must be an object');
    if (!owns(args, 'prompt')) throw invalid('prompt is required');
    if(workflow.mediaType==='video'){
      if(!workflow.videoStages.includes(args.stage))throw invalid('Select a supported video stage: draft or final');
      if(typeof args.intention!=='string'||!args.intention.trim()||args.intention.length>2000)throw invalid('A video intention of 1 to 2000 characters is required');
    }
    const references=workflowReferences(workflow,args,[...Object.keys(referenceImages),...(referenceImage!=null?['image']:[])]);
    for (const [parameter, value] of Object.entries(args)) {
      if (parameter === 'workflow_id') {
        if (value !== id) throw invalid('workflow_id does not match the selected workflow');
        continue;
      }
      if (parameter === 'references'||workflow.mediaType==='video'&&['stage','intention'].includes(parameter)) continue;
      const binding = parameter === 'reference_image' ? 'image' : parameter;
      if (!PARAMETERS.includes(binding) || parameter === 'image' || !owns(workflow.bindings, binding)) {
        throw invalid(`Workflow ${id} does not support parameter ${parameter}`);
      }
      validateArgument(parameter, value);
    }
    if (workflow.bindings.image && referenceImage != null && !references.length) references.push({input:'image'});
    const graph = structuredClone(workflow.graph);
    for (const [parameter, binding] of Object.entries(workflow.bindings)) {
      if (parameter !== 'image' && owns(args, parameter)) graph[binding.node].inputs[binding.input] = args[parameter];
    }
    const connected=workflowConnectedNodes({graph,outputNodes:workflow.outputNodes});
    for(const [parameter,binding]of Object.entries(workflow.bindings))if(parameter!=='image'&&owns(args,parameter)&&!connected.has(binding.node))throw invalid(`Parameter ${parameter} is not connected to any selected output node`);
    for (const ref of references) {
      const slot=workflowImageInputs(workflow).find(slot=>slot.id===ref.input);
      if(!connected.has(slot.node))throw invalid(`Reference input ${slot.name} is not connected to any selected output node`);
      const uploaded=Object.hasOwn(referenceImages,ref.input)?referenceImages[ref.input]:ref.input==='image'?referenceImage:undefined;
      graph[slot.node].inputs[slot.input]=uploadedImage(uploaded);
    }
    return { graph, workflow, outputNodes: [...workflow.outputNodes] };
  }

  async definition(mediaType='image') {
    const workflows = (await this.list()).filter(workflow=>(workflow.mediaType??'image')===mediaType);
    if (!workflows.length) return null;
    const supported = new Set(workflows.flatMap(workflow => Object.keys(workflow.bindings)));
    const properties = {
      workflow_id: { type: 'string', enum: workflows.map(workflow => workflow.id), description: 'Registered local workflow to run.' },
      prompt: { type: 'string', minLength: 1, maxLength: 8000, description: mediaType==='video'?'Video content and motion instruction.':'Image generation or editing instruction.' },
    };
    if (supported.has('negative_prompt')) properties.negative_prompt = { type: 'string', maxLength: 8000, description: 'Content to avoid, only for workflows supporting negative_prompt.' };
    if (supported.has('seed')) properties.seed = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'Generation seed, only for workflows supporting seed.' };
    for (const dimension of ['width', 'height']) {
      if (supported.has(dimension)) properties[dimension] = { type: 'integer', minimum: 64, maximum: 4096, multipleOf: 8, description: `Image ${dimension}, only for workflows supporting ${dimension}.` };
    }
    if (supported.has('image')) properties.reference_image = { type: 'integer', minimum: 0, maximum: 6399, description: 'Zero-based index of user-supplied images in chronological order (excluding generated outputs), only for workflows supporting reference_image.' };
    if(mediaType==='video'){
      properties.stage={type:'string',enum:['draft','final'],description:'Explicit draft or final video. Must be supported by this workflow. A label does not change quality: set the actual supported resolution and frame count, or use a dedicated draft/final workflow.'};
      properties.intention={type:'string',minLength:1,maxLength:2000,description:'Explain in the user language what will be generated, the motion, reference roles, and what is preserved or changed from a draft or prior clip. The user reviews this plan before EVERY video generation.'};
      if(supported.has('frames'))properties.frames={type:'integer',minimum:1,maximum:36000,description:'Frame count, only for workflows with a frames binding. Respect the workflow description constraints.'};
      if(supported.has('fps'))properties.fps={type:'number',minimum:0.1,maximum:240,description:'Frames per second, only for workflows with an fps binding.'};
    }
    const slots=workflows.flatMap(workflow=>workflowImageInputs(workflow));
    if(slots.length) properties.references={type:'array',maxItems:64,description:'Map reference sources to the selected workflow image input IDs. Supply every required input, and use only declared inputs. Each assignment needs either image (chat image index) or resource_id (active library ID); optional frame selects a video frame.',items:{type:'object',properties:{input:{type:'string',enum:[...new Set(slots.map(slot=>slot.id))]},image:{type:'integer',minimum:0,maximum:6399,description:'Zero-based user chat image index, chronological, excluding internal/generated images.'},resource_id:{type:'string',description:'Active local resource catalog ID.'},frame:{type:'integer',minimum:0,maximum:2}},required:['input'],additionalProperties:false}};
    const description = workflows.map(workflow => `${workflow.id} (${workflow.name}): ${workflow.description}${mediaType==='video'?' Supported stages: '+workflow.videoStages.join(', ')+'.':''} Supported parameters: ${Object.keys(workflow.bindings).map(key => key === 'image' ? 'reference_image' : key).join(', ')}.${workflow.requiresImage ? ' A reference image is required.' : ''} ${workflowImageInputs(workflow).length?'Only declared image inputs can receive supplied reference pixels. Omitted optional inputs retain their saved workflow defaults; they are not references supplied by the user.':'No image reference input is configured: Atelier cannot supply new reference pixels. Existing workflow inputs remain in place; do not assume that its saved graph contains no images or claim that user references were injected.'} Image inputs for references: ${JSON.stringify(workflowImageInputs(workflow).map(({id,name,description,required})=>({id,name,description,required})))}.`).join('\n');
    return {
      type: 'function', function: {
        name: mediaType==='video'?'comfy_generate_video':'comfy_generate_image', description: mediaType==='video'?`Propose a video generation ONLY when the user asks to produce a video. Each call requires separate user confirmation, including retries, drafts, finals and continuations; global Comfy permission never bypasses it. Declare the supported stage and explain the actual operation. Use only the selected workflow's mapped parameters and reference slots. Do not invent video continuation, overlap, latent reuse or draft fidelity if its inputs are not configured. Same seed at a different resolution does not guarantee the same clip. Inspect relevant reference pixels before composing the prompt.\n${description}`:`Generate or edit an image when the user asks for an image to be produced or changed. Ordinary questions, image analysis and writing a prompt do not need this tool. Select a workflow according to its description and its declared capabilities, and use only its supported parameters. When visual references are relevant, inspect their pixels with the resource tool before composing the generation or evaluating fidelity; captions alone are not visual inspection.\n${description}`,
        parameters: { type: 'object', properties, required: ['workflow_id', 'prompt',...(mediaType==='video'?['stage','intention']:[])], additionalProperties: false },
      },
    };
  }
}
