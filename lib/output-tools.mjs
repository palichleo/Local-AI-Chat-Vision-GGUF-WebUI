import { problem } from './engine.mjs';

/** How many takes one call may look at together: what one sheet holds (public/contact-sheet.mjs). */
export const TAKES_AT_ONCE = 12;

// (0.6.112) The takes are looked at by their numbers, several in one call. Asked to plan a video
// from three takes, the local model wrote three calls in one message (a message holds one: the
// turn was lost, 19/11), then looked at them one request after the other, copying a run_id of
// thirty-six characters for each. Its results name the takes by their number (« PRISE n »): so
// does this tool now, and those named together come back on one picture.
const TAKES_WORDS =
  'Look at takes of this conversation (« PRISE n ») by their numbers. Pass every take to look at in takes, in one call: several takes come back together on one picture, each under its number. Reads only saved compressed copies, never the originals. A video is read as a few timestamped frames, without audio or motion. After generating an image or a video, normally finish without visual analysis. Use this tool when the user requests a check or when a specific reason makes inspection relevant to their task; do not inspect every output routinely. No generation.';
const takesProperty = () => ({
  type: 'array',
  items: { type: 'integer', minimum: 1 },
  minItems: 1,
  maxItems: TAKES_AT_ONCE,
  description: 'Numbers of the takes to look at, as the user says them (« les prises 47, 49 et 50 » is [47, 49, 50]).',
});

export const outputTool = {
  type: 'function',
  function: {
    name: 'local_read_output',
    // (Its words for results without a take number; those of the takes are TAKES_WORDS, above.)
    description:
      'Inspect one generated output from this conversation using its run_id and zero-based output_index. Reads only the saved compressed copy, never the original. A video is read as a few timestamped frames, without audio or motion. After generating an image or a video, normally finish without visual analysis. Use this tool when the user requests a check or when a specific reason makes inspection relevant to their task; do not inspect every output routinely. IDs are in generation results, so do not ask the user to copy them. No generation.',
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
 * The inspection as a capable model is given it (lib/model-wording.mjs): any run_id a result of this
 * conversation gave, the same definition at every request; a run_id that is none is answered.
 */
export const capableOutputTool = {
  type: 'function',
  function: {
    name: 'local_read_output',
    description:
      'Look at earlier takes of this conversation by their numbers (compressed copies of images, a few frames of a video without its sound): pass every take to look at in takes, in one call; several come back together on one picture, each under its number. Only when the user asks for a check, or when what they show matters to the answer. Nothing is generated.',
    parameters: {
      type: 'object',
      properties: {
        takes: {
          ...takesProperty(),
          description: 'Numbers of the takes to look at (« PRISE 12 » is 12), up to twelve at once.',
        },
        run_id: { type: 'string', description: 'Only for a result that has no take number: its run_id.' },
        output_index: {
          type: 'integer',
          minimum: 0,
          maximum: 63,
          description: 'Position of the output in its run; 0 by default.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

/**
 * The inspection tool restricted to the results that exist in this conversation, or null when
 * there is none: the model is only ever offered takes it can actually look at. By their numbers
 * (0.6.112); a result without a number (made by a version that did not number the takes, and not
 * numbered since) is still read by its run_id, with the words the tool always had.
 */
export function outputToolFor(runs) {
  const usable = runs.filter(run => typeof run?.id === 'string' && run.outputs?.length);
  if (!usable.length) return null;
  const tool = structuredClone(outputTool),
    properties = tool.function.parameters.properties,
    numbers = [...new Set(usable.flatMap(run => run.outputs.map(output => output?.take)).filter(Number.isInteger))].sort((a, b) => a - b),
    unnumbered = usable.filter(run => run.outputs.some(output => !Number.isInteger(output?.take)));
  if (unnumbered.length) {
    properties.run_id.enum = unnumbered.map(run => run.id);
    properties.output_index.maximum = Math.min(63, Math.max(...unnumbered.map(run => run.outputs.length)) - 1);
  } else {
    delete properties.run_id;
    delete properties.output_index;
  }
  if (numbers.length) {
    tool.function.description = TAKES_WORDS;
    tool.function.parameters.properties = {
      takes: { ...takesProperty(), items: { type: 'integer', enum: numbers }, maxItems: Math.min(TAKES_AT_ONCE, numbers.length) },
      ...properties,
    };
  }
  // (One or the other when both are offered: said by the server, lib/output-tools.mjs, takesToRead.)
  tool.function.parameters.required = numbers.length ? (unnumbered.length ? [] : ['takes']) : ['run_id'];
  return tool;
}

/**
 * (0.6.112) The takes a call names by their numbers, found among the creations of the conversation:
 * [{ take, runId, outputIndex, mediaType, workflowName }], in the order asked, each once. A number
 * that is none of its takes is refused, and said to the model.
 */
export function takesToRead(args, runs) {
  const numbers = args?.takes;
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    Object.keys(args).some(key => key !== 'takes') ||
    !Array.isArray(numbers) ||
    !numbers.length ||
    numbers.length > TAKES_AT_ONCE ||
    numbers.some(number => !Number.isInteger(number) || number < 1)
  )
    throw problem('Numéros de prise invalides.');
  const known = new Map();
  for (const run of runs ?? [])
    (run?.outputs ?? []).forEach((output, index) => {
      if (Number.isInteger(output?.take))
        known.set(output.take, {
          take: output.take,
          runId: run.id,
          outputIndex: index,
          mediaType: run.mediaType || 'image',
          workflowName: run.workflowName,
        });
    });
  return [...new Set(numbers)].map(number => {
    const found = known.get(number);
    if (!found) throw problem(`La prise ${number} n’est pas une prise de cette conversation.`, 404);
    return found;
  });
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
      ...(record.mediaType === 'audio'
        ? { seconds: record.parameters?.seconds, lyrics: record.parameters?.lyrics || '' }
        : {}),
      note:
        record.mediaType === 'audio'
          ? 'A sound: there is nothing to see and you cannot hear it. Only its settings are known.'
          : record.mediaType === 'video'
            ? 'Sampled compressed frames only, without audio. Cannot establish continuous motion, exact last frames or audio quality.'
            : 'Compressed output copy. Compare relevant references visually before claiming fidelity; do not infer visual correctness from the prompt alone.',
    },
    images,
  };
}
