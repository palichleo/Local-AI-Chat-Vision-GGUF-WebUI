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
 * tool, and when « Améliorer » is clicked in the Studio. A character with no image yet is
 * described in words (its image is made after, from those words: characterPrompt).
 */
const FRAMES = 3;
// Under this many words an answer is not the description of a video.
const LEAST = 25;

const SYSTEM =
  'You write the prompt of a video for a video model that knows nothing but this prompt. In that video, a ' +
  'character takes the place of a person (or an animal) of an existing video. You are shown frames of the ' +
  'existing video, in order, then the character: their image, or their description when there is no image. ' +
  'From the frames: the place, the light, the framing, and what the person does from the first frame to the ' +
  'last, with every object they hold or touch. All of it stays exactly as the frames show it. The person of ' +
  'the frames is not in the video: nothing of their face, their hair, their clothes or what they wear on ' +
  'their head is described. ' +
  'From the character: only how they look (age, hair with its colour, clothes with their colours). Never ' +
  'describe the place, the pose or the background of the image of the character. ' +
  'What the user asks for comes first: when they ask for a change (other clothes, another object, another ' +
  'weather), write that change in place of what the pictures show for that detail, as if it had always been ' +
  'so, and keep everything else. ' +
  'Write one paragraph of four to six sentences in English, present tense: the character with that look, doing ' +
  'what the person of the frames does, in the place of the frames. Only concrete, visible things. Never mention ' +
  'frames, a source video, a reference image or that someone is replaced. Answer with the prompt alone: no ' +
  'preamble, no title, no quotes, no list.';

const picture = url => ({ type: 'image_url', image_url: { url } });
const words = (text, most = 2000) =>
  String(text ?? '')
    .trim()
    .slice(0, most);

/**
 * The messages of that request. `frames`: data URLs of frames of the video, in order;
 * `character`: data URL of the character's image, or `described`: who they are, in words, when
 * there is no image; `asked`: what the user asked, in their words; `draft`: a prompt written
 * without the pictures, kept for what the user asked beyond them.
 */
export function sceneMessages({ frames, character = null, described = '', asked = '', draft = '' }) {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'text', text: `Frames of the existing video, in order (${frames.length}):` },
        ...frames.map(picture),
        ...(character
          ? [{ type: 'text', text: 'The image of the character:' }, picture(character)]
          : [{ type: 'text', text: `The character, described (no image yet): ${words(described, 600)}` }]),
        {
          type: 'text',
          text:
            (words(asked)
              ? `What the user asked, in their own language (it must be in the prompt, in English): « ${words(asked)} »\n`
              : '') +
            (words(draft)
              ? `A first draft, written without seeing the frames (keep only what the user asked for): ${words(draft)}\n`
              : '') +
            'Write the prompt now.',
        },
      ],
    },
  ];
}

/**
 * The prompt of the image of a character to put in a video, made before the video: the
 * character alone, whole and large in the frame, on a plain background. What else such an image
 * holds goes into the video too (a beach volleyball court behind a player stayed in it, around
 * him), and a small figure gives the video model little to keep of them.
 */
export function characterPrompt(described) {
  const who = words(described, 600).replace(/[.\s]+$/, '');
  return (
    `A full-length photo of ${who}, alone, standing and facing the camera, the whole figure from head to feet ` +
    'filling the height of the frame. Plain light grey studio background with nothing else in it, soft even ' +
    'light, sharp and realistic, true colours.'
  );
}

const jpeg = bytes => 'data:image/jpeg;base64,' + Buffer.from(bytes).toString('base64');

/**
 * The pictures of one source of a call, as data URLs: the frames kept of a resource of the
 * library, an image attached to the conversation (by its position), or an earlier result: a few
 * frames of its video read from the file (`outputFrames`), else the small picture kept of it.
 * Empty when there is none.
 */
async function picturesOf(source, { resources, messages, thumbnails, conversationId, outputFrames }) {
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
  if (typeof source.output === 'string' && conversationId) {
    const index = Number(source.index ?? 0);
    // A video made earlier: what happens in it, not only its first frame (a clip made from a
    // still image starts on that image).
    const read = outputFrames ? await outputFrames(conversationId, source.output, index).catch(() => null) : null;
    if (read?.urls?.length) return read;
    const key = `${conversationId}.${source.output}.${index}`;
    return { urls: thumbnails?.has?.(key) ? [jpeg(await thumbnails.read(key))] : [], video: read?.video ?? null };
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
 * they come from (the library, the conversation, an earlier result). With `described` (a
 * character with no image yet), the frames alone. Null when they cannot be shown, or when what
 * is given as the video is an image.
 */
export async function scenePictures(args, places = {}, { described = '' } = {}) {
  try {
    const [clip, person] = await Promise.all([
      picturesOf(args?.source, places),
      described ? { urls: [] } : picturesOf(args?.reference, places),
    ]);
    if (!clip.urls.length || clip.video === false || (!described && !person.urls.length)) return null;
    return { frames: clip.urls.slice(0, FRAMES), character: described ? null : person.urls[0] };
  } catch {
    return null;
  }
}

/**
 * The arguments of a call with its prompt written from the pictures, or the arguments as they
 * are (the same object) when it cannot be: no vision, pictures out of reach, the model silent
 * or slow. A prompt less good never stops a video; `onSkip` is told why, the caller says it.
 */
export async function withScenePrompt(
  args,
  {
    resources,
    messages,
    thumbnails,
    conversationId,
    outputFrames,
    engine,
    asked = '',
    // Who the character is, in words, when there is no image of them yet.
    described = '',
    // A prompt written without the pictures, when there is one beside what the user asked.
    draft = args?.prompt,
    fetchImpl = fetch,
    timeoutMs = 60000,
    onSkip = () => {},
  },
) {
  if (!engine?.vision || engine.state !== 'ready') {
    onSkip(engine?.vision ? 'le modèle de chat n’est pas prêt' : 'le modèle de chat ne voit pas les images');
    return args;
  }
  const pictures = await scenePictures(
    args,
    { resources, messages, thumbnails, conversationId, outputFrames },
    { described },
  );
  if (!pictures) {
    onSkip('les images de la vidéo ou du personnage sont introuvables');
    return args;
  }
  try {
    const response = await fetchImpl(`${engine.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${engine.apiKey}` },
      body: JSON.stringify({
        messages: sceneMessages({ ...pictures, described, asked, draft }),
        stream: false,
        max_tokens: 500,
        // Nearly the same words every time for the same pictures.
        temperature: 0.2,
        reasoning_format: 'deepseek',
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      onSkip(`le modèle de chat a refusé la demande (${response.status})`);
      return args;
    }
    const prompt = enrichedPrompt((await response.json()).choices?.[0]?.message?.content);
    if (prompt.split(/\s+/).length >= LEAST) return { ...args, prompt };
    onSkip('le modèle de chat a répondu trop court');
    return args;
  } catch (error) {
    onSkip(error?.name === 'TimeoutError' ? `pas de réponse en ${Math.round(timeoutMs / 1000)} s` : 'erreur de la demande');
    return args;
  }
}

/**
 * What the user asked about the replacement in their own words: their messages since the last
 * replacement made in the conversation (a correction is often said in two: « on voit encore le
 * terrain », then « refais-le »), the last three at most.
 */
export function askedSince(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const calls = new Set(
    list
      .flatMap(message => (message?.role === 'assistant' ? message.tool_calls || [] : []))
      .filter(call => call?.function?.name === 'replace_character')
      .map(call => call.id),
  );
  const made = list.findLastIndex(
    message =>
      message?.role === 'tool' &&
      calls.has(message.tool_call_id) &&
      typeof message.content === 'string' &&
      /"status"\s*:\s*"success"/.test(message.content),
  );
  return list
    .slice(made + 1)
    .filter(message => message?.role === 'user' && !message.internal && typeof message.content === 'string')
    .slice(-3)
    .map(message => message.content.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 2000);
}
