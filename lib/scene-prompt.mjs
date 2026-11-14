import { enrichedPrompt } from './studio.mjs';

/**
 * The prompt of a character put in an existing video, written by a pass of its own.
 *
 * That prompt says two things from two sources: what the video shows (the place, the light,
 * what its person does and holds) and how the character looks. Left to the chat model in the
 * middle of a conversation, it was written without the video under its eyes: an apple wiped
 * with a handkerchief became a handkerchief alone, then an orchard a white-walled room (the
 * room of the character's image). Here the application itself shows the frames of the video and
 * the image of the character, at the moment of the call, to a request that does nothing else.
 */
const FRAMES = 3;

const SYSTEM =
  'You write the prompt of a video for a video model that knows nothing but this prompt. In that video, the ' +
  'character of an image takes the place of a person of an existing video. You are shown frames of the existing ' +
  'video, in order, then the image of the character. ' +
  'From the frames: the place, the light, the framing, and what the person does from the first frame to the ' +
  'last, with every object they hold or touch. All of it stays exactly as the frames show it. ' +
  'From the image of the character: only how the character looks (age, hair with its colour, clothes with their ' +
  'colours). Never describe the place, the pose or the background of that image. ' +
  'Write one paragraph of four to six sentences in English, present tense: the character with that look, doing ' +
  'what the person of the frames does, in the place of the frames. Only concrete, visible things. Never mention ' +
  'frames, a source video, a reference image or that someone is replaced. Answer with the prompt alone: no ' +
  'preamble, no title, no quotes, no list.';

const picture = url => ({ type: 'image_url', image_url: { url } });

/**
 * The messages of that request. `frames`: data URLs of frames of the video, in order;
 * `character`: data URL of the character's image; `asked`: what the user asked, in their words;
 * `draft`: the prompt the chat model wrote, kept for what the user asked beyond the pictures.
 */
export function sceneMessages({ frames, character, asked = '', draft = '' }) {
  const words = text =>
    String(text ?? '')
      .trim()
      .slice(0, 2000);
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'text', text: `Frames of the existing video, in order (${frames.length}):` },
        ...frames.map(picture),
        { type: 'text', text: 'The image of the character:' },
        picture(character),
        {
          type: 'text',
          text:
            (words(asked) ? `What the user asked: ${words(asked)}\n` : '') +
            (words(draft) ? `A first draft, written without seeing the frames (keep only what the user asked for): ${words(draft)}\n` : '') +
            'Write the prompt now.',
        },
      ],
    },
  ];
}

const resourceOf = source => (source && typeof source === 'object' && typeof source.resource === 'string' ? source.resource : null);

/**
 * The pictures a call hands over, read from the library: the frames of its video (a resource,
 * taken whole) and the image of its character. Null when either is not a resource of the
 * library (an earlier result, an image attached to the message): the prompt of the call stays.
 */
export async function scenePictures(args, resources) {
  const video = resourceOf(args?.source),
    image = resourceOf(args?.reference);
  if (!video || !image || !resources) return null;
  try {
    const [clip, person] = await Promise.all([resources.readActive(video), resources.readActive(image)]);
    if (!clip.mime?.startsWith('video/') || !clip.frames?.length || !person.frames?.length) return null;
    // A frame named for the character (a video as an image) is the one shown; else its first.
    const chosen = person.frames[Number.isInteger(args.reference.frame) ? args.reference.frame : 0] ?? person.frames[0];
    return { frames: clip.frames.slice(0, FRAMES).map(frame => frame.url), character: chosen.url };
  } catch {
    return null;
  }
}

/**
 * The arguments of a call with its prompt written from the pictures, or the arguments as they
 * are when it cannot be (no vision, pictures not in the library, the model silent or slow): a
 * prompt less good never stops a video.
 */
export async function withScenePrompt(args, { resources, engine, asked = '', fetchImpl = fetch, timeoutMs = 60000 }) {
  if (!engine?.vision || engine.state !== 'ready') return args;
  const pictures = await scenePictures(args, resources);
  if (!pictures) return args;
  try {
    const response = await fetchImpl(`${engine.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${engine.apiKey}` },
      body: JSON.stringify({
        messages: sceneMessages({ ...pictures, asked, draft: args.prompt }),
        stream: false,
        max_tokens: 500,
        temperature: 0.4,
        reasoning_format: 'deepseek',
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return args;
    const prompt = enrichedPrompt((await response.json()).choices?.[0]?.message?.content);
    // A sentence or two is not a description of a video: the first prompt stays.
    return prompt.split(/\s+/).length >= 25 ? { ...args, prompt } : args;
  } catch {
    return args;
  }
}
