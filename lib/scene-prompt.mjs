import { enrichedPrompt } from './studio.mjs';

/**
 * The prompt of a character put in an existing video, written by a pass of its own.
 *
 * That prompt says two things from two sources: what the video shows (the place, the light,
 * what its person does and holds) and how the character looks. Left to the chat model in the
 * middle of a conversation, it was written without the video under its eyes: an apple wiped
 * with a handkerchief became a handkerchief alone, then an orchard a white-walled room (the
 * room of the character's image). Here the application itself shows the frames of the video and
 * the image of the character to a request that does nothing else: at the call of the chat's
 * tool, and when « Améliorer » is clicked in the Studio.
 */
const FRAMES = 3;
// Under this many words an answer is not the description of a video.
const LEAST = 25;

const SYSTEM =
  'You write the prompt of a video for a video model that knows nothing but this prompt. In that video, the ' +
  'character of an image takes the place of a person of an existing video. You are shown frames of the existing ' +
  'video, in order, then the image of the character. ' +
  'From the frames: the place, the light, the framing, and what the person does from the first frame to the ' +
  'last, with every object they hold or touch. All of it stays exactly as the frames show it. ' +
  'From the image of the character: only how the character looks (age, hair with its colour, clothes with their ' +
  'colours). Never describe the place, the pose or the background of that image. ' +
  'What the user asks for comes first: when they ask for a change (other clothes, another object, another ' +
  'mood), write that change in place of what the pictures show for that detail, and keep everything else. ' +
  'Write one paragraph of four to six sentences in English, present tense: the character with that look, doing ' +
  'what the person of the frames does, in the place of the frames. Only concrete, visible things. Never mention ' +
  'frames, a source video, a reference image or that someone is replaced. Answer with the prompt alone: no ' +
  'preamble, no title, no quotes, no list.';

const picture = url => ({ type: 'image_url', image_url: { url } });

/**
 * The messages of that request. `frames`: data URLs of frames of the video, in order;
 * `character`: data URL of the character's image; `asked`: what the user asked, in their words;
 * `draft`: a prompt written without the pictures, kept for what the user asked beyond them.
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
            (words(draft)
              ? `A first draft, written without seeing the frames (keep only what the user asked for): ${words(draft)}\n`
              : '') +
            'Write the prompt now.',
        },
      ],
    },
  ];
}

const jpeg = bytes => 'data:image/jpeg;base64,' + Buffer.from(bytes).toString('base64');

/**
 * The pictures of one source of a call, as data URLs: the frames kept of a resource of the
 * library, an image attached to the conversation (by its position), or the small picture kept
 * of an earlier result. Empty when there is none.
 */
async function picturesOf(source, { resources, messages, thumbnails, conversationId }) {
  if (!source || typeof source !== 'object') return { urls: [] };
  if (typeof source.resource === 'string' && resources) {
    const record = await resources.readActive(source.resource);
    const urls = (record.frames ?? []).map(frame => frame.url);
    // A frame named (a video given as an image) is the one meant.
    const named = Number.isInteger(source.frame) ? urls[source.frame] : null;
    return { urls: named ? [named] : urls, video: record.mime?.startsWith('video/') === true };
  }
  if (Number.isInteger(source.image)) {
    const url = chatImages(messages)[source.image];
    return { urls: url ? [url] : [] };
  }
  if (typeof source.output === 'string' && thumbnails && conversationId) {
    // The page keeps one small picture of each result: the start of a video, no more.
    const key = `${conversationId}.${source.output}.${Number(source.index ?? 0)}`;
    return { urls: thumbnails.has?.(key) ? [jpeg(await thumbnails.read(key))] : [], video: null };
  }
  return { urls: [] };
}

const chatImages = messages =>
  (Array.isArray(messages) ? messages : [])
    .filter(message => message?.role === 'user' && !message.internal)
    .flatMap(message => (Array.isArray(message.content) ? message.content : []))
    .filter(part => part?.type === 'image_url' && typeof part.image_url?.url === 'string')
    .map(part => part.image_url.url);

/**
 * The pictures a call hands over: frames of its video and the image of its character, wherever
 * they come from (the library, the conversation, an earlier result). Null when either cannot be
 * shown, or when what is given as the video is an image of the library.
 */
export async function scenePictures(args, places = {}) {
  try {
    const [clip, person] = await Promise.all([picturesOf(args?.source, places), picturesOf(args?.reference, places)]);
    if (!clip.urls.length || !person.urls.length || clip.video === false) return null;
    return { frames: clip.urls.slice(0, FRAMES), character: person.urls[0] };
  } catch {
    return null;
  }
}

/**
 * The arguments of a call with its prompt written from the pictures, or the arguments as they
 * are (the same object) when it cannot be: no vision, pictures out of reach, the model silent
 * or slow. A prompt less good never stops a video; the caller says which it was.
 */
export async function withScenePrompt(
  args,
  {
    resources,
    messages,
    thumbnails,
    conversationId,
    engine,
    asked = '',
    // A prompt written without the pictures, when there is one beside what the user asked.
    draft = args?.prompt,
    fetchImpl = fetch,
    timeoutMs = 60000,
  },
) {
  if (!engine?.vision || engine.state !== 'ready') return args;
  const pictures = await scenePictures(args, { resources, messages, thumbnails, conversationId });
  if (!pictures) return args;
  try {
    const response = await fetchImpl(`${engine.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${engine.apiKey}` },
      body: JSON.stringify({
        messages: sceneMessages({ ...pictures, asked, draft }),
        stream: false,
        max_tokens: 500,
        // Nearly the same words every time for the same pictures.
        temperature: 0.2,
        reasoning_format: 'deepseek',
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return args;
    const prompt = enrichedPrompt((await response.json()).choices?.[0]?.message?.content);
    return prompt.split(/\s+/).length >= LEAST ? { ...args, prompt } : args;
  } catch {
    return args;
  }
}
