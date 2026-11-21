import { splitVideos } from '../public/chat-videos.mjs';
import { conversationTitle } from '../public/transcript.mjs';

/**
 * The name of a conversation, asked to the chat model once it has answered (17/11): four words at
 * most, so that the list of conversations no longer shows a whole sentence. A conversation that
 * opens on a picture is named after what the picture shows; one that opens on words, after what
 * they ask. A request of its own, short and without tools nor reflection, the same for the small
 * local model and a remote one (as « Enrichir le prompt »): a consigne added to the conversation
 * itself is followed badly by the local model. Until it answers, and when it cannot (busy, no
 * vision for a picture), the conversation keeps the name made of its first message.
 */
export const TITLE_WORDS = 4;
const MAX_TEXT = 2000;
const IMAGE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;

const TEXT_SYSTEM =
  'You name conversations. Reply with a title of at most four words that says what the message asks for, ' +
  'in the language of the message. Only the title: no quotes, no final punctuation, no explanation.';
const IMAGE_SYSTEM =
  'You name conversations. Reply with a title of at most four words, in French, that says what the image shows. ' +
  'Only the title: no quotes, no final punctuation, no explanation.';

/**
 * What the model is asked for the first message of a conversation (`content`, as the page sends it
 * to the chat): the request, or null when there is nothing to name it from. `vision`: whether the
 * model sees images; without it, a picture is left aside for the words that go with it.
 */
export function titleRequest(content, { vision = false } = {}) {
  const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  const image = vision
    ? parts.find(part => part?.type === 'image_url' && IMAGE.test(String(part.image_url?.url ?? '')))
    : null;
  if (image)
    return [
      { role: 'system', content: IMAGE_SYSTEM },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: image.image_url.url } }] },
    ];
  // The words the user wrote: the prompt alone of a creation of the Studio, without a joined video's line.
  const said = parts
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => splitVideos(conversationTitle(part.text)).text)
    .join('\n')
    .trim()
    // (What the page writes for a message of pictures alone: no words of the user.)
    .replace(/^Décris les images\.$/, '')
    .slice(0, MAX_TEXT);
  if (!said) return null;
  return [
    { role: 'system', content: TEXT_SYSTEM },
    { role: 'user', content: said },
  ];
}

/**
 * The model's answer made a name: its first line, without a reflection, a label (« Titre : »),
 * quotes or final punctuation; four words at most, « ... » after the fourth when it wrote more.
 * Empty when nothing usable came back.
 */
const REFUSAL =
  /^(?:je\s+(?:suis\s+)?d[ée]sol[ée]|d[ée]sol[ée]e?(?![a-zà-ÿ])|je\s+ne\s+peux|i(?:'|’| a)m\s+sorry|sorry\b|i\s+can(?:'|’)?(?:no)?t\b|as an ai)/i;
export function shortTitle(text) {
  // An answer that is not words (a list of parts, an object) is no name: written as it was, the
  // conversation was called « [object Object] » for good.
  if (typeof text !== 'string') return '';
  // A reflection left open, a refusal or an excuse: no name either (cut at four words, « Je suis
  // désolé, je... » replaced a first message that said more, and is never asked again).
  if (/<think/i.test(text.replace(/<think>[\s\S]*?<\/think>/g, ' '))) return '';
  const line =
    String(text ?? '')
      .replace(/<think>[\s\S]*?<\/think>/g, ' ')
      .split('\n')
      .map(item => item.trim())
      .find(Boolean) ?? '';
  if (REFUSAL.test(line)) return '';
  const cleaned = line
    // What it says before the name (« Voici un titre : », « Sure! Here is a title: »).
    .replace(/^[^:]{0,60}\b(?:titre|title|nom|name|voici|here)\b[^:]{0,40}:\s*/i, '')
    .replace(/^(?:\*\*)?(?:titre|title|nom)\s*:\s*/i, '')
    .replace(/^[\s"'«“*#-]+|[\s"'»”*]+$/g, '')
    .replace(/[.!?;:,…]+$/, '')
    .replace(/^[\s"'«“*]+|[\s"'»”*]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const words = cleaned.split(' ');
  // A whole sentence is not a name: the one made of the first message stays.
  if (words.length > TITLE_WORDS * 2) return '';
  const kept = words.slice(0, TITLE_WORDS).join(' ').slice(0, 100);
  return words.length > TITLE_WORDS ? kept.replace(/[.!?;:,…]+$/, '') + '...' : kept;
}
