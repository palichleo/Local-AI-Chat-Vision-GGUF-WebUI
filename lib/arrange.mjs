import { readArrangement } from '../public/montage-arrange.mjs';
import { arrangeMessages, retryMessage } from './arrange-prompt.mjs';

/**
 * (0.6.162) The plan of a request written in the Bobine (« invente la suite »), asked of the chat model in
 * a request of its own (claude_design/arrangeur/CONTRAT.md): the messages are those of
 * lib/arrange-prompt.mjs, the answer is read by public/montage-arrange.mjs. Nothing is laid here: the plan
 * read is given back, for whoever asked to lay it on the bobine (withArrangement) and to show it.
 *
 * As in lib/plan-prompt.mjs: one answer, not streamed, without thinking aloud, each request held by a time
 * limit of its own. The local model reads the simple form of the instructions (measured on his card on
 * 20/11, lib/arrange-prompt.mjs), a model that is not the local one the whole of them. An answer that
 * cannot be read as a plan is asked again once, with what it answered and what was wrong with it; never
 * more: the user waits for it.
 */
// What the user reads when two answers in a row could not be read as a plan.
const UNREAD = 'Moodix AI n’a pas rendu de plan lisible. Réessayez, ou dites-le autrement.';

/**
 * The plan of a request: `{ arrangement, problems, tries }`, as readArrangement reads it (`tries`: 1, or 2
 * when it was asked again), or `{ reason }` in the user's words when there is none (a chat model that is
 * not ready, a refusal, two answers that could not be read). An empty request is one: « go on with the
 * film ». A request that takes too long, or that is stopped, throws as the request of the engine does.
 */
export async function arrangePlan(
  { montage, takes, lengthOf, request, previous = [], preferences = '' },
  { engine, signal, timeoutMs = 120000 },
) {
  if (engine?.state !== 'ready') return { reason: 'Le modèle de chat n’est pas prêt.' };
  const simple = engine.local !== false,
    messages = arrangeMessages({ montage, takes, lengthOf, request, previous, preferences, simple });
  // `{ arrangement, problems }`, `{ reason }` for a refusal, or `{ said, wrong }`: the answer that could not be read, and why.
  const ask = async list => {
    const response = await engine.request(
      {
        messages: list,
        stream: false,
        // (A plan of a few takes, each told in one or two sentences, with room for a longer film.)
        max_tokens: 1500,
        temperature: 0.6,
        reasoning_format: 'deepseek',
        chat_template_kwargs: { enable_thinking: false },
      },
      { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) },
    );
    if (!response.ok) return { reason: `Le modèle de chat a refusé la demande (${response.status}).` };
    const said = (await response.json())?.choices?.[0]?.message?.content;
    // (Only the reading is caught: a request stopped, or too slow, throws above, for whoever asked to say it.)
    try {
      return readArrangement(said);
    } catch (error) {
      return { said: typeof said === 'string' ? said : '', wrong: error.message };
    }
  };
  const first = await ask(messages);
  if (first.arrangement) return { arrangement: first.arrangement, problems: first.problems, tries: 1 };
  if (first.reason) return first;
  // Asked again once: the same messages, its answer, then what was wrong with it and the shape of the plan.
  const second = await ask([...messages, { role: 'assistant', content: first.said }, retryMessage(first.wrong, { simple })]);
  if (second.arrangement) return { arrangement: second.arrangement, problems: second.problems, tries: 2 };
  return second.reason ? second : { reason: UNREAD };
}
