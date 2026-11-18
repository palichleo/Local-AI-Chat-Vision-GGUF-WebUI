import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TAB_KEY,
  askedOf,
  openCalls,
  recoveredContent,
  setupTakeRecovery,
  takesOf,
  withResult,
  withoutCall,
} from '../public/take-recovery.mjs';
import { closedCalls, STUDIO_NOTE } from '../public/transcript.mjs';

/**
 * A creation the server finishes without the page that asked for it (0.6.82, public/take-recovery.mjs):
 * the page reloaded or closed while its take was made. Its call is in the conversation; the page that
 * shows the conversation next gives it what it made, or follows it while it is made, and a reload
 * comes back where the tab was.
 */
const ID = 'a1111111-1111-4111-8111-111111111111',
  OTHER = 'b2222222-2222-4222-8222-222222222222';
const call = (id = 'call_1', name = 'create_image', args = { prompt: 'un bateau rouge' }) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
/** A take of the gallery, as /api/gallery lists it. */
const take = (id, callId, { createdAt = '2026-11-18T10:00:00.000Z', mediaType, number = 1 } = {}) => ({
  id,
  conversationId: ID,
  callId,
  ...(mediaType ? { mediaType } : {}),
  workflowId: 'krea',
  workflowName: 'Krea 2',
  prompt: 'un bateau rouge',
  createdAt,
  parameters: { seed: 7, width: 1024, height: 1024, workflow_digest: 'd' },
  outputs: [{ source: { filename: id + '.png', subfolder: 'image', type: 'output' }, take: number }],
});
/** A conversation saved while its creation was being made: its call closed as left without a result. */
const asked = (made = call()) => closedCalls([{ role: 'user', content: 'Un bateau rouge' }, { role: 'assistant', content: '', tool_calls: [made] }]);
const studioAsked = made =>
  closedCalls([
    { role: 'user', internal: true, content: 'Studio · Image : un bateau rouge\n\n' + STUDIO_NOTE },
    { role: 'assistant', content: '', tool_calls: [made] },
  ]);

test('the calls left without what they made are found: unanswered, without a result, a series kept between two images', () => {
  const series = call('call_s', 'create_image', { prompt: 'a', series: ['b', 'c'] });
  const messages = [
    ...asked(call('call_1')),
    { role: 'user', content: 'Encore' },
    { role: 'assistant', content: '', tool_calls: [call('call_2')] },
    { role: 'tool', tool_call_id: 'call_2', content: JSON.stringify({ status: 'success', run_id: 'r2' }) },
    { role: 'assistant', content: '', tool_calls: [call('call_read', 'local_read_output')] },
    { role: 'tool', tool_call_id: 'call_read', content: JSON.stringify({ status: 'cancelled', unanswered: true }) },
    { role: 'assistant', content: '', tool_calls: [series] },
    {
      role: 'tool',
      tool_call_id: 'call_s',
      content: JSON.stringify({ status: 'partial', made: 1, asked: 3, images: [{ status: 'success', run_id: 'r1' }], message: 'Série interrompue avant sa fin : 1 image sur 3 a été faite.' }),
    },
    { role: 'assistant', content: '', tool_calls: [call('call_4')] },
  ];
  const open = openCalls(messages);
  assert.deepEqual(
    open.map(item => [item.call.id, item.index, item.result, item.asked, item.made, item.studio]),
    [
      ['call_1', 1, 2, 1, [], false],
      ['call_s', 8, 9, 3, ['r1'], false],
      ['call_4', 10, -1, 1, [], false],
    ],
  );
  // A series stopped by the user, a refusal, a failure: they said what they made.
  assert.deepEqual(
    openCalls([
      { role: 'assistant', content: '', tool_calls: [call('d')] },
      { role: 'tool', tool_call_id: 'd', content: JSON.stringify({ status: 'denied' }) },
      { role: 'assistant', content: '', tool_calls: [series] },
      { role: 'tool', tool_call_id: 'call_s', content: JSON.stringify({ status: 'partial', made: 1, asked: 3, images: [], message: 'Série arrêtée par l’utilisateur : 1 image sur 3 a été faite.' }) },
    ]),
    [],
  );
  assert.equal(openCalls(studioAsked(call('call_st')))[0].studio, true);
  assert.deepEqual([askedOf(series), askedOf(call()), askedOf({ function: { name: 'create_image', arguments: '{' } })], [3, 1, 1]);
});

test('what an open call is given: the result of its take, or of the images of its series made so far', () => {
  const single = openCalls(asked())[0],
    result = JSON.parse(recoveredContent(single, [take('r1', 'call_1', { number: 12 })]));
  assert.deepEqual([result.status, result.run_id, result.takes, result.media_type], ['success', 'r1', [12], 'image']);
  assert.match(result.note, /^Image générée et affichée à l’utilisateur\. Tu ne l’as pas vue/);
  const series = openCalls(asked(call('call_s', 'create_image', { prompt: 'a', series: ['b', 'c'] })))[0],
    partial = JSON.parse(recoveredContent(series, [take('r1', 'call_s', { number: 1 }), take('r2', 'call_s', { number: 2 })]));
  assert.deepEqual([partial.status, partial.made, partial.asked, partial.takes], ['partial', 2, 3, [1, 2]]);
  assert.deepEqual(partial.images.map(image => image.run_id), ['r1', 'r2']);
  assert.match(partial.message, /^Série interrompue avant sa fin : 2 images sur 3 ont été faites\./);
  const whole = JSON.parse(recoveredContent(series, ['r1', 'r2', 'r3'].map((id, at) => take(id, 'call_s', { number: at + 1 }))));
  assert.deepEqual([whole.status, whole.made, whole.message], ['success', 3, undefined]);
  // A take of the Studio is shown as a card.
  assert.equal(JSON.parse(recoveredContent(openCalls(studioAsked(call('call_st')))[0], [take('r9', 'call_st')])).studio, true);
  assert.deepEqual(
    takesOf([take('b', 'x', { createdAt: '2026-11-18T10:05:00Z' }), take('o', 'y'), take('a', 'x', { createdAt: '2026-11-18T10:01:00Z' })], 'x').map(run => run.id),
    ['a', 'b'],
  );
});

test('a result takes the place of the one a call was left with; a creation of the Studio goes with its line', () => {
  const messages = asked(),
    written = withResult(messages, 'call_1', '{"status":"success"}');
  assert.deepEqual(
    written.map(message => [message.role, message.content]),
    [
      ['user', 'Un bateau rouge'],
      ['assistant', ''],
      ['tool', '{"status":"success"}'],
    ],
  );
  assert.equal(messages[2].content.includes('unanswered'), true, 'the messages given are left as they were');
  assert.deepEqual(withResult(messages.slice(0, 2), 'call_1', 'x').map(message => message.role), ['user', 'assistant', 'tool']);
  assert.equal(withResult(messages, 'absent', 'x'), null);
  const studio = [{ role: 'user', content: 'Bonjour' }, { role: 'assistant', content: 'Bonjour !' }, ...studioAsked(call('call_st'))];
  assert.deepEqual(withoutCall(studio, 'call_st').map(message => message.content), ['Bonjour', 'Bonjour !']);
  assert.deepEqual(withoutCall(asked(), 'call_1').map(message => message.role), ['user']);
});

/**
 * The page around the recovery: `messages` of the conversation shown (`id`), the job the server
 * makes (`job`), the takes of the gallery (`runs`), what /api/tools/job answers (`fresh`), and
 * followTool (`follow`). What it did is kept in `seen`.
 */
function page({ id = ID, messages = asked(), job = null, runs = [], fresh = undefined, follow = null, storage = null, tab = 'onglet-1', state: given = {} } = {}) {
  const seen = { saves: [], forgotten: [], rendered: 0, mounted: [], works: [], loaded: [], started: [], views: [], adopted: 0, studio: [], api: [], busy: 0 };
  const state = {
    conversationId: id,
    messages,
    archiveSnapshot: null,
    aside: null,
    work: null,
    controller: null,
    view: 'chat',
    projectId: 'inbox',
    projects: [{ id: 'inbox' }, { id: 'space' }],
    historyItems: [{ id: ID }, { id: OTHER }],
    status: { toolJob: job },
    studio: {
      followAgain: () => seen.adopted++,
      follow: (...given) => seen.studio.push(['follow', ...given]),
      settled: result => seen.studio.push(['settled', result.record?.id ?? result.error]),
      invalidate: () => seen.studio.push(['invalidate']),
    },
    ...given,
  };
  const views = () =>
    new Map(
      state.messages.map((message, index) => [
        index,
        { article: { remove() {} }, generations: { index, children: [], append: function (...items) { this.children.push(...items); } } },
      ]),
    );
  const holderOf = which => (which === state.conversationId ? state : state.aside?.conversationId === which ? state.aside : { conversationId: which });
  const recovery = setupTakeRecovery({
    api: async (route, body) => {
      seen.api.push(body === undefined ? route : [route, body]);
      // The server saves nothing during a generation: the page waits for its end (`busy` polls).
      if (route === 'status') return Response.json({ toolJob: seen.busy-- > 0 ? { id: 'job' } : null });
      if (route.startsWith('gallery/')) return Response.json({ runs });
      if (route === 'tools/job') return Response.json(fresh === undefined ? job : fresh);
      if (route === 'tools/series') return Response.json({ ended: true });
      if (route.startsWith('history/')) return Response.json({ messages: given.stored?.[decodeURIComponent(route.slice(8))] ?? [] });
      throw Error('route inattendue : ' + route);
    },
    state,
    holderOf,
    shownHere: which => !which || state.conversationId === which,
    // As app.js's: what the conversation holds when it is saved, nothing for one left meanwhile.
    persistConversation: async which => {
      const talk = holderOf(which);
      if (talk.archiveSnapshot?.messages?.length)
        seen.saves.push({ id: which, messages: structuredClone(talk.archiveSnapshot.messages), incomplete: talk.archiveSnapshot.incomplete });
      return true;
    },
    generationUI: {
      mount(container, request, options) {
        const card = { container, request, options, told: [] };
        for (const name of ['progress', 'image', 'finish', 'failed', 'withdraw']) card[name] = (...args) => card.told.push([name, ...args]);
        seen.mounted.push(card);
        return card;
      },
    },
    workflowsUI: {
      followTool: async (...args) => {
        seen.started.push(args);
        return follow ? follow(...args) : { content: JSON.stringify({ status: 'success', run_id: 'made' }), record: { id: 'made' } };
      },
    },
    beginWork: (kind, which) => {
      const work = { kind, conversationId: which };
      state.work = work;
      seen.works.push(['begin', kind, which]);
      return work;
    },
    endWork: work => {
      if (state.work === work) state.work = null;
      seen.works.push(['end', work.kind]);
    },
    rerender: () => {
      seen.rendered++;
      return views();
    },
    forget: async which => seen.forgotten.push(which),
    loadConversation: async which => {
      seen.loaded.push(which);
      state.conversationId = which;
      state.messages = closedCalls(given.stored?.[which] ?? []);
      const drawn = views();
      seen.views.push(drawn);
      void recovery.complete(which, drawn);
    },
    newConversation: async project => {
      seen.loaded.push('nouvelle:' + project);
      state.conversationId = null;
      state.messages = [];
    },
    showStudio: () => seen.loaded.push('studio'),
    showLibrary: () => seen.loaded.push('pellicule'),
    renderNavigation: () => seen.loaded.push('fil'),
    node: (tag, className, text) => ({ tag, className, text }),
    storage,
    tab,
  });
  return { state, seen, recovery, views };
}
const running = (overrides = {}) => ({ id: 'job', state: 'generating', fraction: 0.31, conversationId: ID, callId: 'call_1', media: 'image', workflowName: 'Krea 2', ...overrides });

test('a take made while no page followed it is given to its call, saved and shown', async () => {
  const { state, seen, recovery, views } = page({ runs: [take('r1', 'call_1', { number: 3 }), take('autre', 'call_x')] });
  await recovery.complete(ID, views());
  assert.equal(seen.saves.length, 1);
  const [saved] = seen.saves,
    result = JSON.parse(saved.messages[2].content);
  assert.deepEqual([result.status, result.run_id, result.takes], ['success', 'r1', [3]]);
  assert.equal(saved.incomplete, false);
  assert.equal(JSON.parse(state.messages[2].content).run_id, 'r1', 'kept in the page too');
  assert.equal(seen.rendered, 1, 'drawn again: the take is shown');
  // Opened again: nothing more to do.
  await recovery.complete(ID, views());
  assert.equal(seen.saves.length, 1);
});

test('nothing made and nothing running: the call stays as it was; a creation of the Studio goes, and the conversation begun for it', async () => {
  const chat = page();
  await chat.recovery.complete(ID, chat.views());
  assert.deepEqual([chat.seen.saves.length, chat.seen.rendered], [0, 0]);
  const studio = page({ messages: studioAsked(call('call_st')) });
  await studio.recovery.complete(ID, studio.views());
  assert.deepEqual(studio.seen.forgotten, [ID]);
  assert.deepEqual(studio.state.messages, []);
  // Begun in a conversation that had something before: only its line and its call go.
  const kept = page({ messages: [{ role: 'user', content: 'Bonjour' }, { role: 'assistant', content: 'Bonjour !' }, ...studioAsked(call('call_st'))] });
  await kept.recovery.complete(ID, kept.views());
  assert.deepEqual(kept.seen.saves.map(save => save.messages.map(message => message.content)), [['Bonjour', 'Bonjour !']]);
  assert.deepEqual(kept.seen.forgotten, []);
});

test('a creation still being made is followed under its call: its card, the work, « Interrompre », its result at its end', async () => {
  let finish;
  const gate = new Promise(resolve => (finish = resolve));
  const proposal = { call: call(), tool: 'create_image', workflowName: 'Krea 2', requestId: 'q', plan: { prompt: 'un bateau rouge' }, resolution: { width: 1024, height: 1024 } };
  const { state, seen, recovery, views } = page({
    job: running(),
    fresh: running({ proposal }),
    follow: async (job, request, signal, onProgress) => {
      onProgress('Génération · 12/30', 0.4, '/preview/1');
      await gate;
      return { content: JSON.stringify({ status: 'success', run_id: 'r1' }), record: { id: 'r1' } };
    },
  });
  assert.deepEqual([...recovery.waiting(ID, state.messages)], ['call_1'], 'its call waits for its card');
  assert.deepEqual([...recovery.waiting(OTHER, state.messages)], []);
  await recovery.complete(ID, views());
  // Under the message of its call, as the page that asked would show it.
  const [card] = seen.mounted;
  assert.equal(card.container.index, 1);
  assert.deepEqual([card.request.call.id, card.request.workflowName, card.request.requestId, card.options.compact], ['call_1', 'Krea 2', 'q', false]);
  const [job, request, signal, , , options] = seen.started[0];
  assert.deepEqual(job.proposal, proposal, 'followed from the job as the server has it now');
  assert.equal(request.plan.prompt, 'un bateau rouge');
  assert.deepEqual(options, { review: false, reviewImages: false, studio: false, conversationId: ID });
  assert.deepEqual(state.work, { kind: 'follow', conversationId: ID });
  assert.equal(state.controller.signal, signal, '« Interrompre » stops it');
  assert.deepEqual(card.told[0], ['progress', 'Génération · 12/30', 0.4, '/preview/1']);
  assert.equal(seen.saves.length, 0, 'nothing written while it is made');
  // Opened again meanwhile: not followed twice.
  await recovery.complete(ID, views());
  assert.equal(seen.started.length, 1);
  finish();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(card.told.at(-1)[0], 'finish');
  assert.equal(JSON.parse(seen.saves.at(-1).messages[2].content).run_id, 'r1');
  assert.deepEqual([state.work, state.controller], [null, null]);
  assert.deepEqual(seen.works, [['begin', 'follow', ID], ['end', 'follow']]);
  assert.deepEqual(seen.studio, [['invalidate']], 'the Studio reads its takes again');
});

test('a creation of the Studio being made is followed by the Studio too; stopped, it leaves nothing', async () => {
  const { state, seen, recovery, views } = page({
    messages: [{ role: 'user', content: 'Bonjour' }, { role: 'assistant', content: 'Bonjour !' }, ...studioAsked(call('call_st'))],
    job: running({ callId: 'call_st', studio: true }),
    fresh: running({ callId: 'call_st', studio: true }),
    follow: async (job, request, signal, onProgress) => {
      onProgress('Génération · 3/30', 0.1);
      seen.studioWork = state.work?.studio;
      state.controller.abort();
      throw new DOMException('Arrêtée', 'AbortError');
    },
  });
  await recovery.complete(ID, views());
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(seen.studioWork, true, 'the miniature brings the user back to the Studio');
  assert.equal(seen.adopted, 1);
  assert.equal(seen.mounted[0].options.compact, true);
  assert.deepEqual(seen.studio.map(([name]) => name), ['follow', 'settled']);
  assert.deepEqual(seen.mounted[0].told.at(-1), ['withdraw']);
  assert.deepEqual(seen.saves.at(-1).messages.map(message => message.content), ['Bonjour', 'Bonjour !']);
});

test('a proposal of Moodix AI approved in the Studio and stopped after a reload keeps its words and says it was stopped (0.6.86)', async () => {
  // Made with the Studio (job.studio), not by hand in it: before 0.6.86 the follow took it for a
  // creation of the Studio and took Moodix's message and its call out of the conversation.
  const proposed = [
    { role: 'user', content: 'Une vidéo de bateau' },
    { role: 'assistant', content: 'Je règle le Studio pour une vidéo.', tool_calls: [call('call_v', 'create_video')] },
  ];
  const { state, seen, recovery, views } = page({
    messages: closedCalls(proposed),
    job: running({ callId: 'call_v', studio: true, media: 'video' }),
    fresh: running({ callId: 'call_v', studio: true, media: 'video' }),
    follow: async () => {
      state.controller.abort();
      throw new DOMException('Arrêtée', 'AbortError');
    },
  });
  await recovery.complete(ID, views());
  await new Promise(resolve => setTimeout(resolve, 10));
  const saved = seen.saves.at(-1).messages;
  assert.deepEqual(saved.map(message => message.role), ['user', 'assistant', 'tool']);
  assert.equal(saved[1].content, 'Je règle le Studio pour une vidéo.');
  assert.equal(JSON.parse(saved[2].content).status, 'cancelled');
  assert.deepEqual(seen.studio.at(-1), ['settled', 'Génération arrêtée.'], 'the Studio followed it, and lets it go');
});

test('a stop that came once its take was saved gives the call its take, and the Studio shows it (0.6.86)', async () => {
  // The server was still handing the card back: before 0.6.86 the call said « rien n'a été produit »,
  // and a creation of the Studio by hand was taken out of the conversation.
  const holder = {};
  const { state, seen, recovery, views } = page({
    messages: [{ role: 'user', content: 'Bonjour' }, { role: 'assistant', content: 'Bonjour !' }, ...studioAsked(call('call_st'))],
    job: running({ callId: 'call_st', studio: true }),
    fresh: running({ callId: 'call_st', studio: true }),
    runs: [take('r1', 'call_st', { number: 4 })],
    follow: async (job, request, signal) => {
      holder.state.controller.abort();
      signal.throwIfAborted();
    },
  });
  holder.state = state;
  await recovery.complete(ID, views());
  await new Promise(resolve => setTimeout(resolve, 10));
  const saved = seen.saves.at(-1).messages;
  assert.deepEqual(saved.map(message => message.role), ['user', 'assistant', 'user', 'assistant', 'tool']);
  assert.deepEqual([JSON.parse(saved[4].content).run_id, JSON.parse(saved[4].content).takes], ['r1', [4]]);
  assert.deepEqual(seen.studio.at(-1), ['settled', 'r1'], 'the Studio shows it');
  assert.equal(seen.rendered, 1, 'drawn again: the take where its card was withdrawn');
});

test('a creation another tab follows is left to it: waiting under its call, nothing taken out; once that tab is gone, it is followed (0.6.86)', async () => {
  // Followed by two tabs before 0.6.86 (the launcher opens a second one): the second ended the
  // series of the first and saved its conversation over the other's.
  const elsewhere = running({ callId: 'call_st', studio: true, owner: 'onglet-2', ownerAway: false });
  const kept = page({ messages: [{ role: 'user', content: 'Bonjour' }, ...studioAsked(call('call_st'))], job: elsewhere, fresh: elsewhere });
  assert.deepEqual([...kept.recovery.waiting(ID, kept.state.messages)], ['call_st'], 'its call waits, never « sans suite »');
  await kept.recovery.complete(ID, kept.views());
  assert.deepEqual([kept.seen.started.length, kept.seen.saves.length, kept.seen.forgotten.length], [0, 0, 0]);
  assert.equal(kept.state.work, null);
  // This tab started it (reloaded since), or the other is gone: followed here.
  for (const job of [{ ...elsewhere, owner: 'onglet-1' }, { ...elsewhere, ownerAway: true }]) {
    const { seen, recovery, views } = page({ messages: [{ role: 'user', content: 'Bonjour' }, ...studioAsked(call('call_st'))], job, fresh: job });
    await recovery.complete(ID, views());
    assert.equal(seen.started.length, 1);
  }
});

test('a conversation left before its creation could be followed is not followed from elsewhere; its unsent message is kept (0.6.86)', async () => {
  const { state, seen, recovery, views } = page({ job: running(), fresh: running() });
  // Another conversation opened while the page asked the server for the job: no work held it, it was
  // not set aside; its card would have gone in a page no longer on screen.
  const complete = recovery.complete(ID, views());
  state.conversationId = OTHER;
  await complete;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual([seen.started.length, seen.mounted.length, state.work], [0, 0, null]);
  assert.equal(recovery.following(), null, 'followed at its next opening');
  // A take written for a conversation opened with its last message back in the message box: that
  // message is saved with it, still waiting (before 0.6.86 it left the history).
  const unsent = { role: 'user', content: 'Et maintenant en bleu' };
  const back = page({ runs: [take('r1', 'call_1')] });
  back.state.archiveSnapshot = { messages: [...asked(), unsent], incomplete: true };
  await back.recovery.complete(ID, back.views());
  const saved = back.seen.saves.at(-1);
  assert.deepEqual([saved.messages.at(-1).content, saved.incomplete], ['Et maintenant en bleu', true]);
  assert.equal(JSON.parse(saved.messages[2].content).run_id, 'r1');
});

test('a creation of the Studio that made nothing never leaves a conversation with takes empty: kept, its call said ended (0.6.87)', async () => {
  // Nothing else in it, and takes in its folder (its first message taken back by « Modifier »):
  // emptied, it was deleted with them.
  const { seen, recovery, views } = page({ messages: studioAsked(call('call_st')), runs: [take('ancienne', 'call_0')] });
  await recovery.complete(ID, views());
  assert.deepEqual(seen.forgotten, []);
  const saved = seen.saves.at(-1).messages;
  assert.deepEqual(saved.map(message => message.role), ['user', 'assistant', 'tool']);
  assert.deepEqual(JSON.parse(saved[2].content), { status: 'error', message: 'Rien n’a été produit.' });
  // Opened again: nothing more to do.
  const again = page({ messages: closedCalls(saved), runs: [take('ancienne', 'call_0')] });
  await again.recovery.complete(ID, again.views());
  assert.deepEqual([again.seen.saves.length, again.seen.forgotten.length], [0, 0]);
  // Its message put back in the message box keeps it in the history, saved with it.
  const unsent = { role: 'user', content: 'Et en bleu' };
  const box = page({ messages: studioAsked(call('call_st')) });
  box.state.archiveSnapshot = { messages: [...studioAsked(call('call_st')), unsent], incomplete: true };
  await box.recovery.complete(ID, box.views());
  assert.deepEqual(box.seen.forgotten, []);
  assert.deepEqual(box.seen.saves.at(-1), { id: ID, messages: [unsent], incomplete: true });
});

test('a creation made while this page has a work of its own is not followed: its card waits, its « Interrompre » stays (0.6.87)', async () => {
  // A card of Moodix waiting in another conversation: the follow took its place (state.work) and its
  // stop (state.controller).
  const own = { kind: 'turn', conversationId: OTHER },
    controller = new AbortController();
  const { state, seen, recovery, views } = page({ job: running(), fresh: running(), state: { work: own, controller } });
  await recovery.complete(ID, views());
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual([seen.started.length, seen.mounted.length], [0, 0]);
  assert.equal(state.work, own);
  assert.equal(state.controller, controller);
  assert.deepEqual([...recovery.waiting(ID, state.messages)], ['call_1'], 'still drawn waiting, never « sans suite »');
});

test('followed from another tab than its own, a series is not ended there, and what that tab wrote meanwhile stays (0.6.87)', async () => {
  // The tab that started it, frozen a while then woken: the second ended its series under it, and
  // wrote its own copy of the conversation over the other's.
  const series = call('call_s', 'create_image', { prompt: 'a', series: ['b', 'c'] }),
    job = running({ callId: 'call_s', owner: 'onglet-2', ownerAway: true }),
    written = [
      { role: 'user', content: 'Trois bateaux' },
      { role: 'assistant', content: '', tool_calls: [series] },
      { role: 'tool', tool_call_id: 'call_s', content: JSON.stringify({ status: 'success', images: [{ run_id: 'r1' }, { run_id: 'r2' }, { run_id: 'r3' }] }) },
      { role: 'assistant', content: 'Voici les trois.' },
    ];
  const { state, seen, recovery, views } = page({
    messages: asked(series),
    job,
    fresh: { ...job, proposal: { series: { id: 'S', index: 2, total: 3 } } },
    runs: [take('r1', 'call_s'), take('r2', 'call_s', { createdAt: '2026-11-18T10:01:00.000Z' })],
    state: { stored: { [ID]: written } },
  });
  await recovery.complete(ID, views());
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(seen.started.length, 1, 'followed: the other tab was silent');
  assert.equal(seen.api.some(item => Array.isArray(item) && item[0] === 'tools/series'), false, 'its series not ended');
  assert.deepEqual(seen.saves, [], 'what the other wrote is not written over');
  assert.equal(state.messages.at(-1).content, 'Voici les trois.', 'the page shows it');
});

test('a creation of the Studio the page loses while it follows it frees the Studio: it says why, nothing is written', async () => {
  const { state, seen, recovery, views } = page({
    messages: [{ role: 'user', content: 'Bonjour' }, { role: 'assistant', content: 'Bonjour !' }, ...studioAsked(call('call_st'))],
    job: running({ callId: 'call_st', studio: true }),
    fresh: running({ callId: 'call_st', studio: true }),
    follow: async (job, request, signal, onProgress) => {
      onProgress('Génération · 3/30', 0.1);
      throw Error('La génération suivie a été remplacée par une autre tâche.');
    },
  });
  await recovery.complete(ID, views());
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(seen.adopted, 1);
  // Before 0.6.86 the Studio kept « Génération en cours… » and its conversation until a reload.
  assert.deepEqual(seen.studio.at(-1), ['settled', 'La génération suivie a été remplacée par une autre tâche.']);
  assert.deepEqual(seen.mounted[0].told.at(-1), ['failed', 'La génération suivie a été remplacée par une autre tâche.']);
  assert.deepEqual(seen.saves, [], 'its take may be made: the next opening finds it');
  assert.deepEqual([state.work, state.controller], [null, null]);
});

test('a series followed again stops at the image it was making: every image made is said, the server lets the others go', async () => {
  const series = call('call_s', 'create_image', { prompt: 'a', series: ['b', 'c'] });
  const { seen, recovery, views } = page({
    messages: asked(series),
    job: running({ callId: 'call_s' }),
    fresh: running({ callId: 'call_s', proposal: { series: { id: 'S', index: 1, total: 3 } } }),
    runs: [take('r1', 'call_s', { number: 1 })],
    follow: async () => ({ content: JSON.stringify({ status: 'success', run_id: 'r1' }), record: { id: 'r1' } }),
  });
  await recovery.complete(ID, views());
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(seen.mounted[0].request.series, { id: 'S', index: 1, total: 3 });
  assert.ok(seen.api.some(item => Array.isArray(item) && item[0] === 'tools/series' && item[1].end === true && item[1].series === 'S'));
  const result = JSON.parse(seen.saves.at(-1).messages[2].content);
  assert.deepEqual([result.status, result.made, result.asked], ['partial', 1, 3]);
  assert.match(result.message, /^Série interrompue avant sa fin : 1 image sur 3/);
  // Said under its image at once, as the conversation reads it next.
  assert.deepEqual(seen.mounted[0].container.children, [{ tag: 'p', className: 'proposal-cancelled', text: result.message }]);
});

test('a conversation a work of this page holds is left to it; a job of another call is not followed', async () => {
  const held = page({ job: running(), state: { work: { kind: 'turn', conversationId: ID } } });
  await held.recovery.complete(ID, held.views());
  assert.deepEqual([held.seen.started.length, held.seen.api.length], [0, 0]);
  const other = page({ job: running({ callId: 'call_autre' }) });
  await other.recovery.complete(ID, other.views());
  assert.equal(other.seen.started.length, 0);
});

test('a reload comes back where the tab was: its conversation and its view; a new tab opens the welcome', async () => {
  const kept = new Map(),
    storage = { getItem: key => kept.get(key) ?? null, setItem: (key, value) => kept.set(key, value), removeItem: key => kept.delete(key) };
  const first = page({ storage, state: { view: 'studio' } });
  first.recovery.rememberTab();
  assert.deepEqual(JSON.parse(kept.get(TAB_KEY)), { conversationId: ID, projectId: 'inbox', view: 'studio' });
  // Reloaded: the page starts on nothing, comes back to it.
  const reloaded = page({ storage, state: { conversationId: null, messages: [] } });
  assert.equal(await reloaded.recovery.resumeTab(), true);
  assert.deepEqual(reloaded.seen.loaded, [ID, 'studio']);
  assert.equal(kept.has(TAB_KEY), false, 'read once');
  // A new tab: nothing kept, the welcome.
  assert.equal(await page({ storage, state: { conversationId: null } }).recovery.resumeTab(), false);
  // A conversation never saved is not kept, its project is.
  const fresh = page({ storage, state: { conversationId: 'c3333333-3333-4333-8333-333333333333', projectId: 'space', view: 'library' } });
  fresh.recovery.rememberTab();
  const back = page({ storage, state: { conversationId: null } });
  assert.equal(await back.recovery.resumeTab(), true);
  assert.deepEqual([back.state.projectId, back.seen.loaded], ['space', ['fil', 'pellicule']]);
  // Taken back already (an update, « Redémarrer »): theirs first.
  first.recovery.rememberTab();
  const restarted = page({ storage });
  assert.equal(await restarted.recovery.resumeTab(), false);
  assert.deepEqual(restarted.seen.loaded, []);
});

test('at launch, a creation being made elsewhere is followed in its conversation, set aside as the page comes back', async () => {
  const stored = { [ID]: asked(), [OTHER]: [{ role: 'user', content: 'Autre chose' }, { role: 'assistant', content: 'Oui.' }] };
  let finish;
  const gate = new Promise(resolve => (finish = resolve));
  const { state, seen, recovery } = page({
    id: OTHER,
    messages: stored[OTHER],
    job: running(),
    fresh: running(),
    follow: async () => (await gate, { content: '{"status":"success","run_id":"r1"}', record: { id: 'r1' } }),
    state: { stored, view: 'library' },
  });
  await recovery.followElsewhere();
  // Its conversation opened for its card, then the one of the tab again (0.6.81 sets the first aside).
  assert.deepEqual(seen.loaded, [ID, OTHER, 'pellicule']);
  assert.equal(seen.started.length, 1);
  assert.deepEqual(state.work, { kind: 'follow', conversationId: ID });
  finish();
  // In a new tab, on the welcome: back to a new conversation of its project.
  const welcome = page({ id: null, messages: [], job: running(), fresh: running(), state: { stored, projectId: 'space' } });
  await welcome.recovery.followElsewhere();
  assert.deepEqual(welcome.seen.loaded, [ID, 'nouvelle:space']);
  // Shown already, or its call not in its conversation (written before 0.6.82): nothing to do.
  const here = page({ job: running(), state: { stored } });
  await here.recovery.followElsewhere();
  assert.deepEqual(here.seen.loaded, []);
  const older = page({ id: OTHER, messages: stored[OTHER], job: running({ callId: 'absent' }), state: { stored } });
  await older.recovery.followElsewhere();
  assert.deepEqual(older.seen.loaded, []);
});

test('a creation stopped after a reload is written once the server has handed the card back: it saves nothing before', async () => {
  const { state, seen, recovery, views } = page({
    job: running(),
    fresh: running(),
    follow: async () => {
      state.controller.abort();
      throw new DOMException('Arrêtée', 'AbortError');
    },
  });
  // The job still hands the card back once stopped: the server refuses saves until then.
  seen.busy = 1;
  await recovery.complete(ID, views());
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(seen.saves.length, 0, 'not while the server still works');
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal(seen.saves.length, 1);
  const result = JSON.parse(seen.saves[0].messages[2].content);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.unanswered, undefined, 'stopped, not left without a result');
  assert.deepEqual(seen.mounted[0].told.at(-1), ['withdraw']);
});
