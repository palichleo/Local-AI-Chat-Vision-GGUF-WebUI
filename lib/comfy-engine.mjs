/**
 * Trial: generations run by ComfyUI instead of the built-in engine.
 *
 * Atelier keeps everything it does today (the model's proposal, the confirmation window, the
 * formats, the roles of the inputs, the gallery): only the job that the built-in worker would
 * run is turned into a ComfyUI graph (lib/comfy-graphs.mjs) and sent to a ComfyUI already
 * running on this machine. Switched on by `data/comfy-engine.json`
 * (`{ "enabled": true, "baseUrl": "http://127.0.0.1:7821" }`), read at every generation;
 * without that file nothing changes.
 */
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ComfyClient, normalizeComfyUrl } from './comfy-client.mjs';
import { COMFY_FAMILIES, comfyGraph, leaf } from './comfy-graphs.mjs';
import { imageSize } from './image-size.mjs';
import { mp4Bytes, mp4Info } from './video-info.mjs';

const problem = (message, status = 502) => Object.assign(new Error(message), { status });
const slashes = path => String(path).replaceAll('\\', '/').toLowerCase();
const INPUT_FOLDER = 'atelier';
const TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** The trial's settings, or null when it is off (no file, disabled, unreadable). */
export async function comfyEngine(dataDir) {
  let stored;
  try {
    stored = JSON.parse(await readFile(join(dataDir, 'comfy-engine.json'), 'utf8'));
  } catch {
    return null;
  }
  if (stored?.enabled !== true) return null;
  try {
    return { baseUrl: normalizeComfyUrl(stored.baseUrl) };
  } catch {
    return null;
  }
}

/**
 * Why this job stays on the built-in engine, or '' when ComfyUI can take it: a family without
 * a graph, or a request its graph is not written for (continuations, for instance).
 */
export function comfyUnsupported(job) {
  const family = COMFY_FAMILIES[job?.pipeline];
  return family ? family.unsupported(job) : 'no ComfyUI graph for this family';
}

/**
 * The job's model files under the names this ComfyUI gives them. Refuses, before the chat
 * model is unloaded, a ComfyUI without one of the nodes of the graph or one of the files.
 */
export async function comfyNames(client, job, { signal } = {}) {
  const nodes = new Map();
  const described = async node => {
    if (!nodes.has(node)) nodes.set(node, (await client.objectInfo({ signal, node }))?.[node] ?? null);
    if (!nodes.get(node)) throw problem(`Ce ComfyUI n’a pas le nœud ${node} que cette génération demande.`, 409);
    return nodes.get(node);
  };
  const names = {};
  for (const { key, path, node, input } of COMFY_FAMILIES[job.pipeline].files(job)) {
    const inputs = (await described(node)).input,
      spec = inputs?.required?.[input] ?? inputs?.optional?.[input] ?? [],
      listed = (Array.isArray(spec[0]) ? spec[0] : spec[1]?.options) ?? [],
      wanted = slashes(path);
    // A file listed in a sub-folder may have a namesake: the longest entry that ends this path,
    // else (ComfyUI reading another copy of the folder) the same file name.
    names[key] =
      listed.filter(name => wanted.endsWith('/' + slashes(name))).sort((a, b) => b.length - a.length)[0] ??
      listed.find(name => slashes(leaf(name)) === slashes(leaf(path)));
    if (!names[key]) throw problem(`ComfyUI ne liste pas le fichier ${leaf(path)}.`, 409);
  }
  // Every other node of the graph, with stand-ins for the inputs not sent yet.
  const { graph } = comfyGraph(job, Object.fromEntries(job.references.map(ref => [ref.input, 'x'])), names);
  for (const node of new Set(Object.values(graph).map(item => item.class_type))) await described(node);
  return names;
}

/**
 * Memory ComfyUI needs for a video it transforms: it holds every frame at once, where the
 * built-in engine reads them one by one. Null when the source says too little to tell.
 */
async function videoMemory(job) {
  const family = COMFY_FAMILIES[job.pipeline];
  if (!family.enlarges && !family.multiplies) return 0;
  const info = job.references[0]?.path && (await mp4Info(job.references[0].path));
  if (!info?.frames) return null;
  let { width, height, frames } = info;
  if (family.multiplies) frames *= family.multiplies(job);
  // Frames are held as 32-bit colours; half as much again for what the nodes copy on the way.
  const held = pixels => pixels * 12 * 1.5;
  if (family.enlarges) {
    const scale = family.enlarges(job),
      limit = job.parameters.max_side,
      ratio = limit ? Math.min(1, limit / (Math.max(width, height) * scale)) : 0;
    // The source, the frames straight out of the model, then the reduced ones beside them.
    return held(frames * width * height * (1 + scale ** 2 * (1 + ratio ** 2)));
  }
  return held((info.frames + frames) * width * height);
}

/**
 * The ComfyUI that takes this job, checked and ready, or null when the job stays on the
 * built-in engine (trial off, or a job no graph is written for).
 */
export async function comfyRoute(dataDir, job, { signal, connect = baseUrl => new ComfyClient(baseUrl) } = {}) {
  const engine = await comfyEngine(dataDir);
  if (!engine || comfyUnsupported(job)) return null;
  const client = connect(engine.baseUrl);
  let status;
  try {
    status = await client.status({ signal });
  } catch (error) {
    throw problem(`ComfyUI ne répond pas à ${engine.baseUrl} (${error.message}).`, 503);
  }
  // A long video would not fit in ComfyUI's memory: the built-in engine streams it instead.
  const memory = await videoMemory(job),
    available = Number(status.system?.ram_total) || 0;
  if (memory === null || (memory && available && memory > available / 2)) return null;
  return { client, names: await comfyNames(client, job, { signal }), baseUrl: engine.baseUrl };
}

/**
 * Runs one job on ComfyUI and saves its result in Atelier's output folder, as the built-in
 * worker does: `{ jobId, outputs: [{ filename, subfolder, type, width, height }], metadata }`.
 */
export async function runOnComfy(job, { client, names, baseUrl, outputDir, signal, onProgress } = {}) {
  const started = Date.now(),
    family = COMFY_FAMILIES[job.pipeline],
    video = job.mediaType === 'video';
  onProgress?.({ stage: 'sending to ComfyUI' });
  const inputs = {},
    sent = new Map();
  for (const ref of job.references) {
    const extension = (/\.[a-z0-9]+$/i.exec(ref.path)?.[0] || '').toLowerCase(),
      mime = TYPES[extension];
    if (!mime) throw problem('ComfyUI ne reçoit ici que des images PNG, JPEG ou WebP et des vidéos MP4 ou WebM.');
    if (!sent.has(ref.path)) {
      const stored = await client.upload(await readFile(ref.path), {
        filename: `atelier_${randomUUID().replaceAll('-', '')}${extension}`,
        mime,
        subfolder: family.folder ?? INPUT_FOLDER,
        signal,
      });
      sent.set(ref.path, [stored.subfolder, stored.filename].filter(Boolean).join('/'));
    }
    inputs[ref.input] = sent.get(ref.path);
  }
  const plan = comfyGraph(job, inputs, names);
  onProgress?.({ stage: video ? 'sampling video' : 'loading' });
  // ComfyUI counts the steps of a sampler; once they are done, what remains is the decoding.
  let sampled = false;
  const { promptId, outputs, texts } = await client.run(plan.graph, {
    signal,
    outputNodes: [plan.output, ...(plan.text ? [plan.text] : [])],
    mediaType: job.mediaType,
    onProgress: event => {
      if (event.state !== 'step' || !plan.steps.includes(event.node) || event.max < 2) return;
      if (event.value < event.max || !plan.decodes) {
        sampled = false;
        return onProgress?.({
          stage: video ? 'generating video' : 'generating',
          step: event.value,
          total: event.max,
        });
      }
      if (!sampled) onProgress?.({ stage: 'decoding video' });
      sampled = true;
    },
  });
  if (video) onProgress?.({ stage: 'audio decoded' });
  const original = await client.original(outputs[0], { signal, large: true });
  const name = randomUUID().replaceAll('-', ''),
    p = job.parameters,
    extension = video ? '.mp4' : '.png';
  if (original.mime !== TYPES[extension]) throw problem('ComfyUI a rendu un fichier d’un autre format que prévu.');
  // The size of what was really made: an upscale's is not in its parameters.
  const measured = video ? mp4Bytes(original.bytes) : imageSize(original.bytes),
    used = plan.text && texts?.[plan.text]?.[0];
  const result = {
    jobId: job.id,
    outputs: [
      {
        filename: name + extension,
        subfolder: '',
        type: 'output',
        width: measured?.width ?? p.width,
        height: measured?.height ?? p.height,
      },
    ],
    metadata: {
      job,
      parameters: typeof used === 'string' && used.trim() ? { ...p, prompt: used } : p,
      seconds: Math.round((Date.now() - started) / 10) / 100,
      backend: 'comfyui',
      ...(video
        ? {
            frames: measured?.frames ?? p.frames,
            fps: measured?.fps ?? p.fps,
            ...(p.stage ? { stage: p.stage } : {}),
          }
        : {}),
      comfy: { baseUrl, promptId, output: outputs[0] },
    },
  };
  // Written under a temporary name first: the gallery never sees half a file.
  await writeFile(join(outputDir, name + extension + '.tmp'), original.bytes, { flag: 'wx', mode: 0o600 });
  await rename(join(outputDir, name + extension + '.tmp'), join(outputDir, name + extension));
  await writeFile(join(outputDir, name + '.json'), JSON.stringify(result), { flag: 'wx', mode: 0o600 });
  return result;
}
