import { askedOf, openCalls, recoveredContent, takesOf, withResult } from './take-recovery.mjs';
import { closedCalls } from './transcript.mjs';

/**
 * The takes a conversation no longer shows (0.6.99). An exchange taken back (« Régénérer »,
 * « Modifier ») took its call and the result that named its takes; a tab left on an older copy wrote
 * it over. The takes stay in the conversation's gallery and in `output`, but nothing of the thread
 * names them: ten images of a series « disappeared » from a conversation after a restart (18/11).
 */

// What a call of the model may be called by, as the history keeps it (lib/native-messages.mjs).
const CALL_ID = /^[-A-Za-z0-9_]{1,128}$/;
// The longest prompt of a series (lib/tasks.json): what a call put back says of each image.
const PROMPT_MAX = 3000;

/** Every identifier of a take a result names: its own, those of a series, a character made for it. */
function namedTakes(messages) {
  const named = new Set();
  for (const message of messages ?? []) {
    if (message?.role !== 'tool' || typeof message.content !== 'string') continue;
    let result = null;
    try {
      result = JSON.parse(message.content);
    } catch {
      continue;
    }
    if (typeof result?.run_id === 'string') named.add(result.run_id);
    for (const image of Array.isArray(result?.images) ? result.images : []) if (typeof image?.run_id === 'string') named.add(image.run_id);
    if (typeof result?.character_image?.output === 'string') named.add(result.character_image.output);
  }
  return named;
}

/**
 * The takes of `runs` (the conversation's gallery, as /api/gallery lists it) that no message of
 * `messages` names, by the call they were made for: [{ callId, call, records, detached }], `call` the
 * call when it is still in the conversation (its result names fewer takes than it made), `records`
 * every take of that call the oldest first, `detached` how many of them nothing names. Left out:
 * takes without the identifier of their call (made before 0.6.82); those of tools/action (« action… »:
 * made by hand in the Studio, which writes its own line, or images of a character let go on purpose);
 * those of a call still open, which take-recovery.mjs completes.
 */
export function detachedTakes(messages = [], runs = []) {
  const named = namedTakes(messages),
    open = new Set(openCalls(closedCalls(messages ?? [])).map(item => item.call.id)),
    calls = new Map();
  for (const message of messages ?? [])
    for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) if (typeof call?.id === 'string') calls.set(call.id, call);
  const counts = new Map();
  for (const run of runs ?? []) {
    const callId = run?.callId;
    if (typeof run?.id !== 'string' || typeof callId !== 'string' || !CALL_ID.test(callId) || callId.startsWith('action')) continue;
    if (open.has(callId) || named.has(run.id)) continue;
    counts.set(callId, (counts.get(callId) ?? 0) + 1);
  }
  return [...counts].map(([callId, detached]) => ({ callId, call: calls.get(callId) ?? null, records: takesOf(runs, callId), detached }));
}

/**
 * `messages` with the takes of `group` back in them: the result of its call written again with all
 * its takes when the call is still there; else its call and its result after the last message, as
 * the call was made (a series: its first prompt, then the others).
 */
export function reattached(messages, group) {
  const records = group.records;
  if (group.call) {
    const asked = Math.max(askedOf(group.call), records.length);
    return withResult(messages, group.callId, recoveredContent({ asked, call: group.call, studio: false }, records)) ?? messages;
  }
  const media = records[0]?.mediaType || 'image',
    name = media === 'video' ? 'create_video' : media === 'audio' ? 'create_audio' : 'create_image',
    prompts = records.map(record => String(record.prompt ?? '').slice(0, PROMPT_MAX)),
    call = {
      id: group.callId,
      type: 'function',
      function: { name, arguments: JSON.stringify({ prompt: prompts[0], ...(prompts.length > 1 ? { series: prompts.slice(1) } : {}) }) },
    };
  return [
    ...messages,
    { role: 'assistant', content: '', tool_calls: [call] },
    { role: 'tool', tool_call_id: call.id, content: recoveredContent({ asked: records.length, call, studio: false }, records) },
  ];
}

/** « 10 prises », « 1 prise ». */
export const takesWord = count => `${count} prise${count > 1 ? 's' : ''}`;

/**
 * The takes the results of `messages` name, by kind: what « Régénérer », « Modifier » or « Réessayer »
 * would take out of the conversation with them.
 */
export function takesIn(messages) {
  const kinds = new Map();
  for (const message of messages ?? []) {
    if (message?.role !== 'tool' || typeof message.content !== 'string') continue;
    let result = null;
    try {
      result = JSON.parse(message.content);
    } catch {
      continue;
    }
    const media = result?.media_type === 'video' ? 'video' : result?.media_type === 'audio' ? 'audio' : 'image';
    if (typeof result?.run_id === 'string') kinds.set(result.run_id, media);
    for (const image of Array.isArray(result?.images) ? result.images : []) if (typeof image?.run_id === 'string') kinds.set(image.run_id, 'image');
    if (typeof result?.character_image?.output === 'string') kinds.set(result.character_image.output, 'image');
  }
  return [...kinds.values()];
}

/**
 * The question asked before an exchange holding takes leaves the conversation, in its words: « Cette
 * réponse a 10 images : elles quitteront la conversation et resteront dans la Pellicule. Continuer ? »;
 * '' when it holds none.
 */
export function leavingQuestion(messages) {
  const kinds = takesIn(messages);
  if (!kinds.length) return '';
  const count = kinds.length,
    one = count === 1,
    same = kinds.every(kind => kind === kinds[0]) ? kinds[0] : null,
    // « un son » is the only masculine one: « il quittera », « ils resteront ».
    masculine = same === 'audio',
    noun = same === 'video' ? 'vidéo' : same === 'audio' ? 'son' : same === 'image' ? 'image' : 'prise',
    pronoun = masculine ? (one ? 'il' : 'ils') : one ? 'elle' : 'elles';
  return (
    `Cette réponse a ${count} ${noun}${one ? '' : 's'} : ${pronoun} ${one ? 'quittera' : 'quitteront'} la conversation ` +
    `et ${one ? 'restera' : 'resteront'} dans les Archives. Continuer ?`
  );
}
