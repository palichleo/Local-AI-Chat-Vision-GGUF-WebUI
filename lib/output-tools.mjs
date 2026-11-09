import { problem } from './engine.mjs';

export const outputTool = {
  type: 'function',
  function: {
    name: 'local_read_output',
    description:
      'Inspect one generated output from this conversation using its run_id and zero-based output_index. Reads only the saved compressed copy, never the original. After generating an image, normally finish without visual analysis. Use this tool when the user requests a check or when a specific reason makes inspection relevant to their task; do not inspect every output routinely. IDs are in generation results, so do not ask the user to copy them. No generation.',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'run_id from a generation result in this conversation.' },
        output_index: {
          type: 'integer',
          minimum: 0,
          maximum: 63,
          description: 'Zero-based output index; defaults to 0.',
        },
      },
      required: ['run_id'],
      additionalProperties: false,
    },
  },
};

/**
 * The inspection tool restricted to the results that exist in this conversation, or null when
 * there is none: the model is only ever offered run_ids it can actually read.
 */
export function outputToolFor(runs) {
  const usable = runs.filter(run => typeof run?.id === 'string' && run.outputs?.length);
  if (!usable.length) return null;
  const tool = structuredClone(outputTool),
    properties = tool.function.parameters.properties;
  properties.run_id.enum = usable.map(run => run.id);
  properties.output_index.maximum = Math.min(63, Math.max(...usable.map(run => run.outputs.length)) - 1);
  return tool;
}

export async function readOutput(gallery, conversationId, args, { includeImages = true } = {}) {
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    Object.keys(args).some(key => !['run_id', 'output_index'].includes(key)) ||
    typeof args.run_id !== 'string' ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(args.run_id)
  )
    throw problem('Identifiant de sortie invalide.');
  const index = args.output_index === undefined ? 0 : args.output_index;
  if (!Number.isInteger(index) || index < 0 || index > 63) throw problem('Index de sortie invalide.');
  const record = await gallery.get(conversationId, args.run_id, { includeImages, outputIndex: index }),
    output = record.outputs[index];
  if (!output) throw problem('Sortie introuvable.', 404);
  const frames = output.analysisFrames,
    images = frames?.length ? frames.map(frame => frame.url) : output.analysisDataUrl ? [output.analysisDataUrl] : [];
  return {
    metadata: {
      status: includeImages ? (images.length ? 'loaded' : 'unavailable') : 'available',
      run_id: record.id,
      output_index: index,
      media_type: record.mediaType || 'image',
      workflow: record.workflowName,
      prompt: record.prompt,
      width: output.width,
      height: output.height,
      ...(frames ? { frame_times: frames.map(frame => frame.time) } : {}),
      note:
        record.mediaType === 'video'
          ? 'Sampled compressed frames only, without audio. Cannot establish continuous motion, exact last frames or audio quality.'
          : 'Compressed output copy. Compare relevant references visually before claiming fidelity; do not infer visual correctness from the prompt alone.',
    },
    images,
  };
}
