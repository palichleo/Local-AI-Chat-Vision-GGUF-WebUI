import { takeContent } from './generation-runtime.mjs';
import { INTERRUPTED, interrupted, seriesContent } from './image-series.mjs';
import { STUDIO_LINE, closedCalls } from './transcript.mjs';

/**
 * A creation the server finishes without the page that asked for it (0.6.82): the page was reloaded,
 * closed or put to sleep while its take was made. Its call is written in its conversation before the
 * generation starts (app.js); the page that shows that conversation next finds what became of it, by
 * the identifier of the call the server keeps with the job and with the take (lib/tool-runtime.mjs,
 * lib/gallery.mjs):
 * - still being made: its card follows it under its message (the picture so far, the percentage,
 *   « Interrompre »), the Studio too when the Studio made it, and the miniature of the chat when the
 *   user looks elsewhere (0.6.81);
 * - made: its result is written for the model and the take is shown, as if the page had stayed;
 * - neither (the application was closed meanwhile): the call stays as it was (« demande restée sans
 *   suite »); a creation of the Studio, which says nothing when nothing is made, goes.
 * A series stopped by the reload keeps the images made (« Série interrompue »); the others are not
 * made. A reload also comes back where the tab was, its conversation and its view (rememberTab,
 * resumeTab); a new launch opens the welcome, as before.
 */

// Every tool but the local readers is a generation verb, as the transcript reads them.
const isGeneration = call => Boolean(call?.function?.name) && !call.function.name.startsWith('local_');
// A fault of the page itself (a name or a property that is not there), not a request that failed:
// the server not answering is said on the card, not as an error nobody expected.
const pageFault = error =>
  error instanceof ReferenceError || (error instanceof TypeError && !/fetch|network|load failed/i.test(String(error.message)));
const studioLine = message =>
  message?.role === 'user' && message.internal === true && typeof message.content === 'string' && STUDIO_LINE.test(message.content);
// What a stopped creation is told, as when the page that asked it is stopped (app.js, sendMessage).
const STOPPED =
  'L’utilisateur a arrêté cette génération avant la fin : rien n’a été produit. S’il demande de recommencer, refais le même appel d’outil.';
/** The key of the tab: what it showed when it was left (a reload comes back there). */
export const TAB_KEY = 'moodix.onglet';

/** How many takes a call asks for: the images of its `series` and its first one; one otherwise. */
export function askedOf(call) {
  try {
    const args = JSON.parse(call?.function?.arguments ?? '');
    return call.function.name === 'create_image' && Array.isArray(args?.series) && args.series.length
      ? args.series.length + 1
      : 1;
  } catch {
    return 1;
  }
}

/**
 * The creations of a conversation whose result does not say what they made: a call left without one
 * (closedCalls gives it « unanswered »), or a series kept between two of its images. Each:
 * { index, result, call, asked, made, studio } — where the call is, where its result is (-1: none),
 * how many takes it asks, the takes its result already names, whether the Studio made it.
 */
export function openCalls(messages = []) {
  const open = [];
  for (const [index, message] of messages.entries()) {
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    const call = message.tool_calls.find(isGeneration);
    if (typeof call?.id !== 'string' || !call.id) continue;
    let result = -1;
    for (let next = index + 1; messages[next]?.role === 'tool'; next++) if (messages[next].tool_call_id === call.id) result = next;
    let data = null;
    try {
      if (result >= 0) data = JSON.parse(messages[result].content);
    } catch {}
    const asked = askedOf(call),
      unanswered = result < 0 || (data?.status === 'cancelled' && data.unanswered === true),
      between = asked > 1 && Array.isArray(data?.images) && INTERRUPTED.test(String(data.message ?? ''));
    if (!unanswered && !between) continue;
    open.push({
      index,
      result,
      call,
      asked,
      made: between ? data.images.map(image => image?.run_id).filter(id => typeof id === 'string') : [],
      studio: studioLine(messages[index - 1]),
    });
  }
  return open;
}

/** The takes of a call among those of its conversation (`runs`, as /api/gallery lists them), the oldest first. */
export const takesOf = (runs, callId) =>
  (runs ?? [])
    .filter(run => run?.callId === callId)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

/**
 * The result of an open call once its takes are known (`records`, the oldest first), as requestTool
 * would have given it: nothing was shown to the model, which did not see them.
 */
export function recoveredContent(open, records) {
  if (open.asked > 1)
    return seriesContent(
      records.map(record => takeContent(record, { request: { call: open.call } })),
      open.asked,
      records.length < open.asked ? { stopped: interrupted(records.length, open.asked) } : {},
    );
  return takeContent(records.at(-1), { request: { call: open.call }, studio: open.studio });
}

/** Where the call `callId` is in `messages`, and its result (-1: none). */
function placeOf(messages, callId) {
  const at = messages.findIndex(message => message?.role === 'assistant' && message.tool_calls?.some(call => call?.id === callId));
  let result = -1;
  if (at >= 0) for (let next = at + 1; messages[next]?.role === 'tool'; next++) if (messages[next].tool_call_id === callId) result = next;
  return { at, result };
}

/** `messages` with `content` as the result of the call `callId` (null when the call is not there). */
export function withResult(messages, callId, content) {
  const list = [...messages],
    { at, result } = placeOf(list, callId);
  if (at < 0) return null;
  const answer = { role: 'tool', tool_call_id: callId, content };
  if (result >= 0) list[result] = answer;
  else list.splice(at + 1, 0, answer);
  return list;
}

/**
 * `messages` without the call `callId`, its result, and the line of the Studio before it: a creation
 * of the Studio that made nothing leaves nothing (null when the call is not there).
 */
export function withoutCall(messages, callId) {
  const { at } = placeOf(messages, callId);
  if (at < 0) return null;
  let end = at + 1;
  while (messages[end]?.role === 'tool' && messages[end].tool_call_id === callId) end++;
  return [...messages.slice(0, studioLine(messages[at - 1]) ? at - 1 : at), ...messages.slice(end)];
}

/** What a creation of the Studio that made nothing is told when it stays (leftWithout). */
export const ENDED = JSON.stringify({ status: 'error', message: 'Rien n’a été produit.' });
/**
 * What a creation of the Studio that made nothing leaves of `messages`: nothing of it, unless nothing
 * at all would be left of a conversation that has takes (`hasTakes`, 0.6.87). Never deleted with them,
 * it then keeps its call, said ended (opened again, it asks nothing more). Null when the call is not there.
 */
export function leftWithout(messages, callId, hasTakes) {
  const without = withoutCall(messages, callId);
  if (!without) return null;
  return without.length || !hasTakes ? without : withResult(messages, callId, ENDED);
}

/**
 * The page's side. `holderOf`, `shownHere`, `persistConversation`, `beginWork`, `endWork`,
 * `loadConversation`, `newConversation`, `showStudio`, `showLibrary`: app.js's. `rerender(id)` draws
 * the conversation shown again and gives the views of its messages (by their place); `forget(id)`
 * takes a conversation left empty out of the history; `onChange` says the work is over.
 */
export function setupTakeRecovery({
  api,
  state,
  holderOf,
  shownHere,
  persistConversation,
  generationUI,
  workflowsUI,
  beginWork,
  endWork,
  rerender = () => null,
  forget = async () => {},
  loadConversation = async () => {},
  newConversation = async () => {},
  showStudio = () => {},
  showLibrary = () => {},
  renderNavigation = () => {},
  scrollToBottom = () => {},
  onChange = () => {},
  // Makes an element of the page (app.js's `node`): the line of a series stopped.
  node = null,
  storage = globalThis.sessionStorage,
  // This tab, as the server knows the one that started a generation (app.js, TAB).
  tab = '',
}) {
  // The job followed here (one at a time, as the server makes them), and each conversation being completed.
  let following = null;
  const completing = new Map();
  /** The creation the server makes now: its conversation and its call known. */
  const makingJob = () => {
    const job = state.status?.toolJob;
    return job && !job.blocked && job.callId && job.conversationId && !['done', 'error', 'cancelled'].includes(job.state)
      ? job
      : null;
  };
  /**
   * The one this page may follow (0.6.86): started by this tab (a reload keeps it), or by a tab gone
   * since. One still open in another tab follows it there: a second tab that followed it too ended its
   * series (« Cette série est terminée ») and saved its conversation over the other's.
   */
  const runningJob = () => {
    const job = makingJob();
    return job && (!job.owner || job.owner === tab || job.ownerAway === true) ? job : null;
  };
  /** The calls of conversation `id` the job being made answers: drawn waiting for its card, not « sans suite ». */
  function waiting(id, messages) {
    const job = makingJob();
    return job && job.conversationId === id && openCalls(messages).some(item => item.call.id === job.callId)
      ? new Set([job.callId])
      : new Set();
  }
  /**
   * The server keeps the save of a conversation for the end of the generation that makes its take
   * (/api/history/save): one stopped still hands the card back for a while, the chat model coming
   * back after it. Waited for, ten minutes at most, for conversation `id` alone (the server saves the
   * others, 0.6.86); not when the card is held (54), which only « Libérer le GPU » ends (app.js,
   * generationOver).
   */
  async function idle(id) {
    for (const until = Date.now() + 600000; Date.now() < until; ) {
      let job;
      try {
        job = (await (await api('status')).json())?.toolJob;
      } catch {
        return;
      }
      if (!job || job.blocked || (job.conversationId && job.conversationId !== id)) return;
      await new Promise(resolve => setTimeout(resolve, 700));
    }
  }
  /**
   * What the gallery has of conversation `id`: its takes, and whether some of their records cannot be
   * read (0.6.89: they counted as none, and a conversation left with nothing else could go with them).
   */
  async function listed(id) {
    const answer = await (await api(`gallery/${encodeURIComponent(id)}?images=0`)).json();
    return { runs: answer.runs ?? [], unreadable: Number(answer.skipped) > 0 };
  }
  /** The messages of conversation `id` as they are now, kept where it is (shown or set aside) and saved. */
  async function keep(id, messages) {
    const talk = holderOf(id);
    // Neither shown nor set aside any more: completed when it is opened next.
    if (talk !== state && talk !== state.aside) return;
    // Its last message, left without an answer, was put back in the message box when it was opened
    // (app.js, loadConversation): saved with it as before, not lost if it is not sent again.
    const kept = talk.archiveSnapshot,
      last = kept?.incomplete ? kept.messages?.at(-1) : null,
      unsent = last?.role === 'user' && !last.internal && talk.messages?.at(-1)?.role !== 'user' ? last : null;
    talk.messages = messages;
    talk.archiveSnapshot = unsent ? { messages: [...messages, unsent], incomplete: true } : { messages: [...messages], incomplete: false };
    await idle(id);
    // As it is after the wait (0.6.88): another conversation opened meanwhile is the page's now, and
    // `talk` with it. Decided on that one, an empty one had this one forgotten (deleted when it had no
    // take), a new one threw. Neither shown nor set aside any more: completed when it is opened next.
    const now = holderOf(id);
    if (now !== state && now !== state.aside) return;
    // Left empty: out of the history (app.js keeps one that has takes); its unsent message keeps it.
    if (now.archiveSnapshot?.messages?.length) await persistConversation(id);
    else await forget(id);
  }
  /**
   * Conversation `id` was drawn (`views`: its messages by their place): its open calls are given what
   * they made, and the one the server still makes is followed. Resolves once that one is followed.
   */
  function complete(id, views) {
    const task = (async () => {
      const talk = holderOf(id);
      // A work of this page holds it (its own creation): it writes its own result.
      if (!id || (talk !== state && talk !== state.aside) || state.work?.conversationId === id) return;
      const open = openCalls(talk.messages ?? []);
      if (!open.length) return;
      const job = runningJob(),
        // Not while a work of this page goes on (0.6.87: a card of Moodix waiting in another
        // conversation), whose place and « Interrompre » a follow would take: followed at the next
        // opening once it is over.
        live =
          !state.work && job && job.conversationId === id && following !== job.id ? open.find(item => item.call.id === job.callId) : null;
      const done = open.filter(item => item !== live);
      if (done.length) {
        let runs = null,
          unreadable = false;
        try {
          ({ runs, unreadable } = await listed(id));
        } catch {
          // Unreadable now: completed when it is opened next.
        }
        let messages = holderOf(id).messages ?? [],
          changed = false;
        for (const item of runs ? done : []) {
          const made = takesOf(runs, item.call.id);
          if (made.length > item.made.length) {
            messages = withResult(messages, item.call.id, recoveredContent(item, made)) ?? messages;
            changed = true;
          } else if (!made.length && item.studio && makingJob()?.callId !== item.call.id) {
            messages = leftWithout(messages, item.call.id, runs.length > 0 || unreadable) ?? messages;
            changed = true;
          }
        }
        if (changed) {
          // Shown at once; saved once the server allows it (after the generation that makes its take,
          // followed below). Drawn only after its save before 0.6.86: up to the end of a video made in
          // another conversation.
          const saving = keep(id, messages);
          if (shownHere(id)) views = rerender(id) ?? views;
          if (!live) await saving;
        }
      }
      if (!live || following === job.id) return;
      // Its place may have moved (a creation of the Studio taken out before it).
      const now = openCalls(holderOf(id).messages ?? []).find(item => item.call.id === job.callId);
      if (now) await begin(id, now, job, views);
    })().catch(() => {});
    completing.set(id, task);
    return task;
  }
  /** Follows `job`, which answers `item` of conversation `id`; resolves once its card is there. */
  function begin(id, item, job, views) {
    following = job.id;
    return new Promise(started => {
      // (An error nobody expected goes on to the page, which says it: unexpected-errors.mjs.)
      void run(id, item, job, views, started).finally(() => {
        if (following === job.id) following = null;
        started();
      });
    });
  }
  async function run(id, item, job, views, started) {
    // As it is now, with what its card is drawn with (`proposal`).
    let fresh = job;
    try {
      fresh = (await (await api('tools/job')).json()) ?? null;
    } catch {}
    // Over and gone meanwhile (another took its place): the next opening finds its take. Left before
    // it could be followed (another conversation opened meanwhile, not set aside: no work held it):
    // the next opening follows it.
    if (fresh?.id !== job.id || (holderOf(id) !== state && holderOf(id) !== state.aside) || state.work) return;
    // Started by this tab (reloaded since), or by one that is gone (`ownerAway`): only the first is
    // its page, which ends its series and writes over its conversation as it holds it (0.6.87).
    const mine = !fresh.owner || fresh.owner === tab;
    // `studio`: shown as a creation of the Studio, which follows it too (« Générer » there, by hand
    // or on a proposal of Moodix AI); `item.studio`: made by hand in the Studio (its line before the
    // call), the only one that leaves nothing when it makes nothing. A proposal of Moodix AI keeps
    // its words and says how it ended, as when the page stays (sendMessage).
    const view = fresh.proposal ?? {},
      studio = Boolean(fresh.studio || view.studio || item.studio),
      request = {
        ...view,
        call: item.call,
        ...(view.mediaType || (fresh.media && fresh.media !== 'image') ? { mediaType: view.mediaType || fresh.media } : {}),
        workflowName: view.workflowName || fresh.workflowName || '',
      };
    // The work first: the miniature hears its card from its start (« Image · Krea 2 »).
    const work = beginWork('follow', id),
      controller = new AbortController(),
      host = views?.get?.(item.index) ?? null;
    // Made in the Studio: the miniature brings the user back there, as for one followed from its start.
    if (studio && work) work.studio = true;
    // « Interrompre » (and the stop of the Studio) stop it: the server cancels it by its identifier.
    state.controller = controller;
    let card = null,
      result;
    try {
      card = host?.generations ? generationUI.mount(host.generations, request, { compact: studio }) : null;
      if (host) host.generation = true;
      if (studio && shownHere(id)) state.studio?.followAgain?.();
      onChange();
      started();
      result = await workflowsUI.followTool(
        fresh,
        request,
        controller.signal,
        (progress, fraction, preview) => {
          card?.progress(progress, fraction, preview);
          if (studio) state.studio?.follow?.(progress, fraction, preview);
          scrollToBottom();
        },
        image => card?.image(image),
        { review: false, reviewImages: false, studio, conversationId: id },
      );
      card?.finish(result);
    } catch (error) {
      const stopped = controller.signal.aborted;
      if (stopped) card?.withdraw();
      else card?.failed(error.message);
      result = {
        failed: true,
        error: stopped ? 'Génération arrêtée.' : error.message,
        content: JSON.stringify(stopped ? { status: 'cancelled', message: STOPPED } : { status: 'error', message: error.message }),
      };
      // Not stopped by the user: the page lost the job (another took its place, the server did not
      // answer, a fault of the page). Nothing is written: its take may well be made, and the next
      // opening finds it; its card says what happened. A fault of the page goes on to the page.
      if (!stopped) {
        // The Studio followed it too: it stops saying « Génération en cours… » and holding the
        // conversation, and says what happened (as a creation of its own that fails).
        if (studio) void state.studio?.settled?.({ error: error.message });
        if (state.controller === controller) state.controller = null;
        endWork(work);
        onChange();
        if (pageFault(error)) throw error;
        return;
      }
    }
    try {
      let content = result.content,
        record = result.record ?? null,
        runs = [],
        unreadable = false;
      // A series stops at the image it was making: the others are not made (the server lets them go).
      // Not from another tab than its own: the server ends a series no page asks for after a minute,
      // and a tab woken since goes on with it (0.6.87: it was ended under it).
      if (item.asked > 1 && view.series?.id && mine) void api('tools/series', { series: view.series.id, end: true }).catch(() => {});
      // What its call made, read again: every image of a series, and the take of a stop that came once
      // it was saved (the server still handing the card back). Said « rien n'a été produit » before
      // 0.6.86, and a creation of the Studio in a new conversation took it out of the Pellicule.
      if (item.asked > 1 || !record) {
        try {
          ({ runs, unreadable } = await listed(id));
        } catch {}
        const made = takesOf(runs, item.call.id);
        if (made.length > item.made.length || (item.asked > 1 && made.length)) {
          content = recoveredContent(item, made);
          record ??= made.at(-1);
        }
      }
      if (studio) void state.studio?.settled?.(record ? { ...result, record } : { error: result.error });
      else if (record) state.studio?.invalidate?.();
      // A creation of the Studio by hand that made nothing leaves nothing, as when the page stays
      // (runInStudio); unless nothing else would be left of a conversation that has takes (leftWithout).
      const gone = item.studio && !record,
        before = holderOf(id).messages ?? [];
      let messages = gone ? leftWithout(before, item.call.id, runs.length > 0 || unreadable) : withResult(before, item.call.id, content);
      if (gone && messages && placeOf(messages, item.call.id).at < 0) host?.article?.remove?.();
      // Followed from another tab than its own: that tab, woken since, may have written it already;
      // its copy is the newer, and is kept (0.6.87: it was written over).
      if (!mine && messages) {
        try {
          const saved = (await (await api(`history/${encodeURIComponent(id)}`)).json()).messages ?? [];
          if (saved.length && !openCalls(closedCalls(saved)).some(open => open.call.id === item.call.id)) {
            const talk = holderOf(id);
            if (talk === state || talk === state.aside) {
              talk.messages = closedCalls(saved);
              talk.archiveSnapshot = { messages: [...saved], incomplete: false };
              if (shownHere(id)) rerender(id);
            }
            messages = null;
          }
        } catch {}
      }
      // A series stopped so says where under its images, as the conversation reads it next (app.js).
      if (item.asked > 1 && node && host?.generations) {
        let said = null;
        try {
          said = JSON.parse(content);
        } catch {}
        if (said?.status === 'partial' && said.message) host.generations.append(node('p', 'proposal-cancelled', said.message));
      }
      if (messages) await keep(id, messages);
      // The take of a stop that came once it was saved: shown where its card was withdrawn.
      if (record && !result.record && item.asked === 1 && shownHere(id)) rerender(id);
    } finally {
      if (state.controller === controller) state.controller = null;
      endWork(work);
      onChange();
    }
  }
  /** The tab is left (a reload, or closed): what it shows, for the page that comes back in it. */
  function rememberTab() {
    try {
      const saved = (state.historyItems ?? []).some(item => item.id === state.conversationId);
      storage?.setItem(
        TAB_KEY,
        JSON.stringify({ conversationId: saved ? state.conversationId : null, projectId: state.projectId || 'inbox', view: state.view }),
      );
    } catch {
      // Without the storage of the tab, a reload opens the welcome.
    }
  }
  /**
   * At launch, in a tab reloaded: its conversation and its view again; true when the tab had kept
   * them. Not after an update or « Redémarrer » (they take theirs back first), nor in a new tab.
   */
  async function resumeTab() {
    let kept = null;
    try {
      kept = JSON.parse(storage?.getItem(TAB_KEY) || 'null');
      storage?.removeItem(TAB_KEY);
    } catch {}
    if (!kept || typeof kept !== 'object' || state.conversationId) return false;
    if (typeof kept.conversationId === 'string' && (state.historyItems ?? []).some(item => item.id === kept.conversationId))
      await loadConversation(kept.conversationId);
    else if (typeof kept.projectId === 'string' && (state.projects ?? []).some(project => project.id === kept.projectId)) {
      state.projectId = kept.projectId;
      renderNavigation();
    }
    if (kept.view === 'studio') showStudio();
    else if (kept.view === 'library') showLibrary();
    return true;
  }
  /**
   * At launch, a creation being made in another conversation than the one shown (the user had left it
   * before reloading, or opens a new tab): that conversation is opened for its card, then set aside as
   * the page comes back where it was; the miniature shows it there (0.6.81).
   */
  async function followElsewhere() {
    const job = runningJob();
    if (!job || shownHere(job.conversationId) || !(state.historyItems ?? []).some(item => item.id === job.conversationId)) return;
    try {
      const record = await (await api('history/' + encodeURIComponent(job.conversationId))).json();
      if (!openCalls(closedCalls(record.messages ?? [])).some(item => item.call.id === job.callId)) return;
    } catch {
      return;
    }
    const back = { conversationId: state.conversationId, projectId: state.projectId || 'inbox', view: state.view };
    await loadConversation(job.conversationId);
    await completing.get(job.conversationId);
    if (back.conversationId) await loadConversation(back.conversationId);
    else await newConversation(back.projectId);
    if (back.view === 'studio') showStudio();
    else if (back.view === 'library') showLibrary();
  }
  return { waiting, complete, rememberTab, resumeTab, followElsewhere, following: () => following };
}
