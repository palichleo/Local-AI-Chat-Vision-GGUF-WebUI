import { readFileSync } from 'node:fs';

/**
 * The Studio: the creation tools used by hand, without the chat model. Its results are kept
 * like those of a conversation, under one fixed identifier that is no conversation's.
 */
export const STUDIO_ID = '57ad1000-0000-4000-8000-000000000001';
/** What the Studio may start itself: the click on « Générer » is the confirmation. */
export const STUDIO_VERBS = ['create_image', 'create_video', 'extend_video', 'create_audio', 'upscale', 'interpolate'];

// What a prompt must say, as the chat model is told it for each verb when it writes one itself.
const TASKS = JSON.parse(readFileSync(new URL('./tasks.json', import.meta.url), 'utf8'));
const MADE = { create_image: 'an image', create_video: 'a video clip', extend_video: 'the continuation of a video clip' };

/**
 * The messages that make the chat model turn what the user typed in the Studio into the full
 * prompt a generator needs: nothing asked for is dropped, what is missing is added. `preferences`
 * are the user's standing instructions (the global ones of the application), which win.
 */
export function enrichMessages(prompt, { verb = 'create_image', preferences = '' } = {}) {
  const task = MADE[verb] ? verb : 'create_image',
    idea = String(prompt ?? '')
      .trim()
      .slice(0, 4000),
    wishes = String(preferences ?? '')
      .trim()
      .slice(0, 2000);
  const system =
    `You rewrite what the user typed into the prompt of ${MADE[task]}, for a generator that only reads this prompt. ` +
    'Keep everything the user asked for (the subject, the action, the place, the mood, any words to show or to say) and add what is missing. ' +
    `What the prompt must be: ${TASKS[task].prompt} ` +
    'Answer with the prompt alone: no preamble, no title, no quotes, no list, no explanation.' +
    (wishes ? `\nThe user's standing instructions, which come first where they differ: ${wishes}` : '');
  return [
    { role: 'system', content: system },
    { role: 'user', content: idea },
  ];
}

/** The model's answer as the prompt alone: no thinking block, label or quotes around it; 4000 characters at most. */
export function enrichedPrompt(text) {
  const quotes = /^["'«“\s]+|["'»”\s]+$/g;
  return String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, ' ')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
    .replace(quotes, '')
    .replace(/^(?:enriched |rewritten |final )?prompt\s*:\s*/i, '')
    .replace(quotes, '')
    .slice(0, 4000)
    .trim();
}
