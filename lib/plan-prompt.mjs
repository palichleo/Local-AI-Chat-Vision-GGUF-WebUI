import { readFileSync } from 'node:fs';
import { enrichedPrompt } from './studio.mjs';
import { picturesOf } from './scene-prompt.mjs';

/**
 * (0.6.146) What happens in a plan to make of a montage, written by the chat model from the pictures of
 * that plan: the photo it starts on, the photo it arrives on, or the end of the video it goes on from.
 *
 * His words of 20/11: the user lays photos on the timeline, « et le modèle s'occupe de combler les
 * trous ». The chat model of the user follows long instructions badly in the middle of a conversation
 * (the prompt of a character put in a video, lib/scene-prompt.mjs): here, as there, the application
 * itself shows the pictures to a request that does nothing else, one plan at a time, and takes its
 * answer as the text of the plan. Nothing is created by it: the user reads the texts, then agrees.
 *
 * Seen on his card (20/11, his local model, two plans between three photos of the same man): shown what
 * happens in the plan before « for the story to go on », it gave that text back word for word as the
 * second plan. So that text is shown only to a model that is not the local one, and an answer that
 * says the plan before again is asked once more, without it, for what is different in this plan.
 */
// What a prompt must say, as the chat model is told it for each verb when it writes one itself.
const TASKS = JSON.parse(readFileSync(new URL('./tasks.json', import.meta.url), 'utf8'));
// Under this many words an answer is not the description of a shot.
const LEAST = 15;
// From this share of its words in common with the plan before, in the same order, an answer says that plan again.
const SAME = 0.7;

const picture = url => ({ type: 'image_url', image_url: { url } });
const words = (text, most = 2000) =>
  String(text ?? '')
    .trim()
    .slice(0, most);

/**
 * The messages of that request. `start`, `end`: data URLs of the picture the shot starts on and of the
 * one it ends on (one of them at least); `verb`: extend_video when the shot is the continuation of a
 * video (`start` is then the last picture of that video); `seconds`: its length; `previous`: what
 * happens in the shot before it, for the story to go on; `preferences`: the standing instructions of
 * the user, which win; `different`: asked again after an answer that said the shot before again.
 */
export function planMessages({ start = '', end = '', seconds, verb = 'create_video', previous = '', preferences = '', different = false }) {
  const continues = verb === 'extend_video',
    wishes = words(preferences),
    shown =
      start && end
        ? `${continues ? 'the last picture of the shot before it' : 'the picture the shot starts on'}, then the picture it ends on`
        : start
          ? continues
            ? 'the last picture of the shot before it: this shot goes on from there'
            : 'the picture the shot starts on'
          : 'the picture the shot ends on',
    asked =
      start && end
        ? 'Say what the first picture shows, then what happens to go from it to the last picture, in the order things ' +
          'happen: who or what moves and how, how the camera moves, and how the shot ends, as the last picture shows it. '
        : start
          ? 'Say what the picture shows, then what happens next, in the order things happen: who or what moves and how, ' +
            'how the camera moves, how the shot ends. The same people, the same place and the same light as in the picture. '
          : 'Say what happens in a shot that ends exactly as the picture shows it: the place, who or what is there, what ' +
            'they do to come to that last picture, how the camera moves. ';
  return [
    {
      role: 'system',
      content:
        'You write the prompt of one shot of a film, for a video model that is given the same pictures and reads ' +
        `nothing else than this prompt. You are shown ${shown}. ` +
        asked +
        'Only concrete things, seen or heard; nothing the pictures contradict; a simple action that fits the length ' +
        'of the shot. ' +
        `What the prompt must be: ${TASKS[continues ? 'extend_video' : 'create_video'].prompt} ` +
        'Never mention a picture, a photo, a frame or another shot. Answer with the prompt alone: no preamble, no ' +
        'title, no quotes, no list.' +
        (wishes ? `\nThe user's standing instructions, which come first where they differ: ${wishes}` : ''),
    },
    {
      role: 'user',
      content: [
        ...(start
          ? [{ type: 'text', text: continues ? 'The last picture of the shot before:' : 'The picture the shot starts on:' }, picture(start)]
          : []),
        ...(end ? [{ type: 'text', text: 'The picture the shot ends on:' }, picture(end)] : []),
        {
          type: 'text',
          text:
            `The shot lasts ${Math.round(Number(seconds) * 10) / 10} seconds.\n` +
            (words(previous) ? `What happens in the shot before it, for the story to go on: ${words(previous, 1200)}\n` : '') +
            (different
              ? 'Another shot of the film shows the same people in the same place. Say precisely what is different in ' +
                'this one: the pose, the hands, the gaze, what has moved, what the camera does.\n'
              : '') +
            'Write the prompt now.',
        },
      ],
    },
  ];
}

/**
 * How much two prompts say the same thing with the same words: the share of the runs of three words
 * of the shorter one that the other has too (1: the same text, or one inside the other).
 */
export function sameWords(a, b) {
  const runs = text => {
    const list = String(text ?? '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
    return new Set(list.slice(0, Math.max(0, list.length - 2)).map((word, at) => `${word} ${list[at + 1]} ${list[at + 2]}`));
  };
  const [one, other] = [runs(a), runs(b)].sort((left, right) => left.size - right.size);
  if (!one.size) return 0;
  let shared = 0;
  for (const run of one) if (other.has(run)) shared++;
  return shared / one.size;
}

/**
 * One picture of a source as the chat model is shown it (a data URL), or '' when there is none: a
 * photo by the small picture kept of it, else by its file (`original`); a video by its last picture
 * (the shot goes on from where it ends).
 */
export async function pictureOf(source, { resources, thumbnails, conversationId, outputFrames, original } = {}) {
  if (!source || typeof source !== 'object') return '';
  try {
    const read = await picturesOf(source, { resources, thumbnails, conversationId, outputFrames });
    if (read.urls.length) return read.video ? read.urls.at(-1) : read.urls[0];
    // (A video the engine could not read just now, busy as it is: nothing to show of it.)
    if (read.video || typeof source.output !== 'string' || !original) return '';
    return (await original(source.conversation ?? conversationId, source.output, Number(source.index ?? 0))) ?? '';
  } catch {
    return '';
  }
}

/**
 * The text of a plan written from its pictures: `{ prompt }`, or `{ reason }` in the user's words when
 * it cannot be (no vision, no picture within reach, a refusal, an answer too short). A request that
 * takes too long, or that is stopped, throws as the request of the engine does.
 */
export async function planPrompt(
  { start, end, seconds, verb, previous, preferences },
  { engine, resources, thumbnails, conversationId, outputFrames, original, signal, timeoutMs = 90000 },
) {
  if (!engine?.vision) return { reason: 'Ce modèle de chat ne voit pas les images : écrivez vous-même ce qui se passe dans cette prise.' };
  if (engine.state !== 'ready') return { reason: 'Le modèle de chat n’est pas prêt.' };
  const places = { resources, thumbnails, conversationId, outputFrames, original },
    [from, to] = await Promise.all([pictureOf(start, places), pictureOf(end, places)]);
  if (!from && !to) return { reason: 'Les photos de cette prise sont introuvables.' };
  const ask = async ({ told = '', different = false, temperature = 0.4 } = {}) => {
    const response = await engine.request(
      {
        messages: planMessages({ start: from, end: to, seconds, verb, previous: told, preferences, different }),
        stream: false,
        max_tokens: 600,
        // (Nearly the same words every time for the same pictures, with a little room for the action.)
        temperature,
        reasoning_format: 'deepseek',
        chat_template_kwargs: { enable_thinking: false },
      },
      { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) },
    );
    if (!response.ok) return { reason: `Le modèle de chat a refusé la demande (${response.status}).` };
    const prompt = enrichedPrompt((await response.json()).choices?.[0]?.message?.content);
    if (prompt.split(/\s+/).filter(Boolean).length < LEAST) return { reason: 'Le modèle de chat a répondu trop court. Réessayez.' };
    return { prompt };
  };
  // (What happens in the plan before is shown to a model that is not the local one only: that one gives it back.)
  const first = await ask({ told: engine.local === false ? previous : '' });
  if (!first.prompt || !words(previous) || sameWords(first.prompt, previous) < SAME) return first;
  // It says the plan before again: asked once more for what is different in this one. Its first answer stays if it fails.
  const second = await ask({ different: true, temperature: 0.8 });
  return second.prompt ? second : first;
}
