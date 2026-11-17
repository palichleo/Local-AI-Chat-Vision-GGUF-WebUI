import { PROVIDERS } from './remote-models.mjs';
import { cardBrief, studioBrief } from './video-brief.mjs';

/**
 * How Moodix speaks to the chat model. Everything it says was written for the small model of
 * llama.cpp (« rails »): a plan agreed in words before a video, five lines at most, orders in the
 * results of the tools (« n’écris ni commentaire »), one line of consigne. A large model follows those
 * orders to the letter: on 0.6.39 ChatGPT wrote its plan and waited for a « go » instead of
 * proposing the video, so its card never came at the first turn (3 tries out of 3, 17/11).
 * The models of ChatGPT, Claude and OpenRouter are given their own wording (« capable »): the tools
 * described as contracts (tasks-capable.json), the consigne of the product said once (below), the
 * results of the tools reduced to facts. The local model, and any other service (often a small model
 * on this computer or the home network), keep the rails to the character: tests/model-wording.mjs.
 * What must hold whatever the model (an image the user cites, a length nobody gave, a prompt too
 * thin, references not looked at, the card of a video and its words) stays the application's.
 */
export const RAILS = 'rails';
export const CAPABLE = 'capable';
/** The wording for the connection in use: null is the local model. */
export const wordingOf = connection => (connection && PROVIDERS.includes(connection.preset) ? CAPABLE : RAILS);

/** The line the page puts first in every request (public/app.js, chatRequest), for the local model. */
export const LOCAL_LINE =
  'Tu es un assistant local utile. Réponds dans la langue de l’utilisateur. Décris honnêtement les images et signale tes incertitudes.';

/**
 * The consigne of a capable model, in place of that line: what Moodix is, that only a call makes
 * something, what the user calls takes and references, what the model does not see, how it speaks.
 * The same for every request (no number, no list, no name of a tool), so the providers keep it in
 * their cache. It says nothing of what follows a call: told « an image is made as soon as you call
 * for it » and « the application then asks you for a few words », Ernie (OpenRouter) skipped the
 * call and wrote those words, « La carte est prête », five times in eleven requests (17/11).
 */
export const CAPABLE_SYSTEM = `You are Moodix AI, the assistant of Moodix, an application on the user's computer that makes images, videos, music and sound effects with generation models that run on that computer. You talk with the user and you call its tools.

Making things
- Nothing is made, proposed or changed unless you call a tool in your answer: text alone makes nothing. Never write that an image, a video, a sound or a proposal is ready, made, shown or on its way unless a tool result in this conversation says so.
- When the user asks for an image, a video, music, a sound effect, a larger or smoother version, call the matching tool now with your best proposal. The user confirms a video, a music or a sound in Moodix before it runs, so do not ask for their agreement in text first.
- Ask a question instead of calling only when the request gives nothing to build a prompt on, or when two readings would give very different results and nothing tells them apart. Never invent a length the user did not give.
- One call per message. For several images in one request (« 10 images de ce style », « trois variantes »), one call of the image tool: the first image in its prompt and the others in its series, every prompt prepared now. A proposal the user declined is not made again unless they ask for it.
- The prompts of the generation models are written in English, complete: those models know nothing of this conversation, and they only see the images passed to them as inputs, never an image that is only named in the prompt.

Takes and references
- Every result is a take, numbered in the project: the user says « PRISE 12 » or « la prise 12 », and so do you, never an identifier.
- #ref1, #ref2… are the references of the project: images and videos the user added, listed by Moodix at the end of the user's last message when there are some, with the notes the user wrote about them (their words, not what the pictures show).
- A remark on a result the user does not name is about the take on their screen, else the latest take (Moodix says which at the end of their last message); it asks for that same kind of thing again (a remark on a video asks for a video), unless they say otherwise. « La dernière prise » is the latest take, whatever its kind.
- A video to make again (« recommence », « on recommence », « refais la vidéo ») is a new clip, made with the video tool from the image the clip started on (for a continuation: the image the clip it continues started on), with a prompt that holds what they now ask. Never a continuation: that tool is only for a clip the user wants longer (« la suite », « continue », « prolonge »), and its result is the source clip itself followed by the new part.
- A new clip that starts where a video take ends (« pars de la dernière image de la prise 25 ») is a new video whose start image is that take with "frame": "last". Not a continuation.
- You only see an image, a reference or a take when it is shown to you in this conversation: never describe one you have not seen. You cannot hear sounds.
- When a tool result says a creation succeeded, the user already sees it: end your turn without comment, unless they asked you to check it.

Writing to the user
- Answer in the user's language; in French, address them as « vous ». Be brief and plain, without headings.
- Never name a tool, an argument or an identifier to the user.
- A call refused before anything ran comes back as an error: correct it from what the error says, without inventing an identifier, or answer without a tool. If a creation failed, say in a sentence or two what failed; the user decides whether to try again.`;

/**
 * Said after the consigne to a model that sees no image (its connection says so): with nothing to
 * look at, Ernie described a reference from its name and size (« une femme rousse » for a staircase).
 */
export const BLIND =
  '\n- This model cannot see images in this conversation. Asked what an image, a reference or a take shows, say that you cannot see it; the user’s notes about it may be repeated as their notes.';

/** What a capable model is told when the card of its video waits for the user: write the words over it. */
export const CAPABLE_CARD =
  'Not generated yet: the card of this proposal is shown to the user under your next words, with its length, format and prompt, and « Générer » and « Annuler ». Write two to four plain sentences saying what happens in the clip from its first moment to its last, then ask whether it suits them.';
/** The same when its video is set in the Studio, where the proposal waits on « Générer ». */
export const CAPABLE_STUDIO =
  'Not generated yet: the Studio now shows this proposal to the user, with its length, format, prompt and images, and « Générer » and « Refuser ». Write two to four plain sentences saying what happens in the clip from its first moment to its last, then ask whether it suits them.';

const KINDS = { image: 'image', video: 'video', audio: 'sound' };
/** What the page says is on the user's screen, { take, media }: a number and a kind it knows, else null. */
export function screenOf(value) {
  if (!value || typeof value !== 'object') return null;
  const { take, media } = value;
  return Number.isInteger(take) && take >= 1 && take <= 10000000 && Object.hasOwn(KINDS, media) ? { take, media } : null;
}
/**
 * What a capable model is told of the takes with the user's last message (the server puts it at its
 * end, after the references): the latest take of the conversation, and the one on the user's screen
 * when the page said it and it is another. `runs` are the creations of the conversation; one made
 * since that message (its result follows it in `messages`) is left out, so that the lines are those
 * of the message, the same at every request of its turn (the cache of the provider). Empty when
 * nothing is known.
 */
export function takesContext(runs, messages, screen) {
  const list = Array.isArray(messages) ? messages : [],
    last = list.findLastIndex(message => message?.role === 'user' && !message.internal),
    since = new Set();
  for (const message of list.slice(last + 1))
    if (message?.role === 'tool' && typeof message.content === 'string')
      for (const [, id] of message.content.matchAll(/"run_id"\s*:\s*"([^"]+)"/g)) since.add(id);
  let latest = null;
  for (const run of runs ?? [])
    if (!since.has(run?.id))
      for (const output of run?.outputs ?? [])
        if (Number.isInteger(output?.take) && output.take > (latest?.take ?? 0))
          latest = { take: output.take, media: run.mediaType || 'image' };
  const shown = screenOf(screen),
    lines = [];
  const said = ({ take, media }) => `PRISE ${take} (${KINDS[media] ?? 'image'}).`;
  if (latest) lines.push('Latest take of this conversation: ' + said(latest));
  if (shown && shown.take !== latest?.take) lines.push('On the user’s screen (Studio output): ' + said(shown));
  return lines.length ? `\n\n[Takes, added by Moodix. ${lines.join(' ')}]` : '';
}

// What a result carries for the application or for the small model, not facts a capable model needs:
// identifiers it is never to name, files, and the orders said once in CAPABLE_SYSTEM.
const NOT_FACTS = [
  'note',
  'takes_note',
  'use_as_source',
  'workflow_id',
  'workflow_digest',
  'outputs',
  'reference_default_count',
  'reference_defaults',
];
// Said by the reference counts of a result looked at (the page asks to check them then).
const REVIEW = ['reference_count', 'reference_capacity', 'reference_mode'];
// Statuses whose message is an order (CAPABLE_SYSTEM says it once), not what happened.
const ORDERED = new Set(['denied', 'cancelled', 'missing_file', 'already_loaded']);

/** The result of a tool as a capable model reads it: its facts. Not JSON: as it is. */
export function capableResult(content) {
  let result;
  try {
    result = JSON.parse(content);
  } catch {
    return content;
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return content;
  const facts = { ...result };
  for (const key of NOT_FACTS) delete facts[key];
  if (!facts.analysis_outputs) for (const key of REVIEW) delete facts[key];
  if (ORDERED.has(facts.status)) delete facts.message;
  // The words over a card, asked in the wording of the small model (a conversation begun with it).
  if (facts.status === 'waiting_for_user' && facts.message === cardBrief()) facts.message = CAPABLE_CARD;
  if (facts.status === 'waiting_for_user' && facts.message === studioBrief()) facts.message = CAPABLE_STUDIO;
  return JSON.stringify(facts);
}

/**
 * The messages of a request as a capable model gets them: its consigne in place of the local line
 * (the context the user gave stays after it), the results of the tools reduced to facts. The page
 * keeps its history as it is: the local model, chosen again, reads what it always read.
 */
export function capableMessages(messages, { vision = true } = {}) {
  return messages.map((message, index) => {
    if (index === 0 && message.role === 'system' && typeof message.content === 'string')
      return message.content.startsWith(LOCAL_LINE)
        ? {
            ...message,
            content: CAPABLE_SYSTEM + (vision ? '' : BLIND) + message.content.slice(LOCAL_LINE.length),
          }
        : message;
    if (message.role === 'tool' && typeof message.content === 'string')
      return { ...message, content: capableResult(message.content) };
    return message;
  });
}
