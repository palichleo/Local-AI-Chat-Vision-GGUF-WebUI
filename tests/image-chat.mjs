import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { readSSE } from '../public/stream.mjs';
import * as sessionCopies from '../public/session-copies.mjs';
import * as chatVideos from '../public/chat-videos.mjs';
const png = 'data:image/png;base64,iVBORw0KGgo=';
const call = {
  id: 'call_1',
  type: 'function',
  function: { name: 'create_image', arguments: '{"prompt":"cat"}' },
};
async function exchange({
  vision = true,
  ready = true,
  images = [png],
  failed = false,
  denied = false,
  hasRecord = true,
  readOutputAfterGeneration = false,
  readOutputAgain = false,
  readResourceDuringReview = false,
  mediaType = 'image',
  finalText = 'Result explained',
  finalReason = 'stop',
  generationCalls = 1,
  reviewVideos = false,
} = {}) {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const element = (tag = '', className = '', textContent = '') => ({
    tag,
    className,
    value: '',
    disabled: false,
    hidden: false,
    textContent,
    children: [],
    classList: { add() {} },
    append(...items) {
      this.children.push(...items);
    },
    replaceChildren(...items) {
      this.children = items;
    },
    setAttribute() {},
    remove() {},
    focus() {},
  });
  const nodes = new Map(),
    $ = id => {
      if (!nodes.has(id)) nodes.set(id, element());
      return nodes.get(id);
    };
  $('prompt').value = 'Generate a cat';
  const status = { state: ready ? 'ready' : 'error', vision, busy: false };
  const state = {
    config: { enginePath: 'engine', modelPath: 'model' },
    messages: [],
    images: [],
    videos: [],
    status: { state: 'ready', vision: true, busy: false },
    thinking: true,
    generation: { maxIterations: Math.max(5, generationCalls), reviewVideos },
  };
  const requests = [],
    toolOptions = [],
    reviews = [],
    views = [],
    generationContainers = [];
  const context = {
    ...sessionCopies,
    ...chatVideos,
    views,
    generationUI: {
      mount: container => {
        generationContainers.push(container);
        return { progress() {}, image() {}, finish() {}, fail() {} };
      },
    },
    assetsUI: { flush: async () => true },
    state,
    $,
    AbortController,
    performance,
    crypto: { randomUUID: () => 'a1111111-1111-4111-8111-111111111111' },
    readSSE,
    node: element,
    icon: () => element('svg'),
    userMessage: () => element(),
    contextMeter: { pause() {}, observe() {}, schedule() {} },
    renderAttachments() {},
    resizePrompt() {},
    notice() {},
    scrollToBottom() {},
    renderText() {},
    updateControls() {},
    openSettings() {},
    persistConversation: async () => true,
    waitForModel: async () => {},
    historyWrite: Promise.resolve(),
    refreshStatus: async () => {},
    setConversationTitle() {},
    workflowsUI: {
      requestTool: async (...args) => ({
        ...(toolOptions.push(args[4]) && {}),
        content: JSON.stringify({ status: denied ? 'denied' : failed ? 'generated' : 'success' }),
        images,
        failed,
        denied,
        error: failed ? 'Model restart failed' : '',
        ...(denied || !hasRecord ? {} : { record: { id: 'run', conversationId: state.conversationId, mediaType } }),
      }),
      saveReview: async (...args) => reviews.push(args),
    },
    api: async (route, body) => {
      if (route === 'status') return Response.json(status);
      if (route === 'gallery/read')
        return Response.json({
          metadata: {
            status: images.length ? 'loaded' : 'unavailable',
            run_id: body.runId,
            output_index: body.outputIndex,
            media_type: mediaType,
          },
          images,
        });
      if (route === 'resources/read')
        return Response.json({
          id: 'library',
          name: 'Reference',
          description: 'Visual reference',
          mime: 'image/png',
          width: 1,
          height: 1,
          frames: [{ url: png, time: null }],
        });
      assert.equal(route, 'chat');
      requests.push(body);
      const events =
        requests.length <= generationCalls
          ? [
              { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
              {
                local_tool_request: {
                  call: { ...call, id: requests.length === 1 ? call.id : 'call_' + requests.length },
                  workflowName: 'Photo',
                },
              },
            ]
          : readOutputAfterGeneration &&
              requests.length > generationCalls &&
              requests.length <= generationCalls + (readOutputAgain ? 2 : 1)
            ? [
                { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
                {
                  local_tool_request: {
                    kind: 'output',
                    runId: 'run',
                    outputIndex: 0,
                    workflowName: 'Photo',
                    call: {
                      id: 'read_output',
                      type: 'function',
                      function: { name: 'local_read_output', arguments: '{"run_id":"run"}' },
                    },
                  },
                },
              ]
            : readResourceDuringReview && requests.length === generationCalls + (readOutputAfterGeneration ? 2 : 1)
              ? [
                  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
                  {
                    local_tool_request: {
                      kind: 'resource',
                      resourceId: 'library',
                      workflowName: 'Reference',
                      call: {
                        id: 'read_reference',
                        type: 'function',
                        function: { name: 'local_read_resource', arguments: '{"resource_id":"library"}' },
                      },
                    },
                  },
                ]
              : [{ choices: [{ delta: { content: finalText }, finish_reason: finalReason }] }];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    },
  };
  const fn = source.slice(
    source.indexOf('async function sendMessage('),
    source.indexOf('setupMaterialLighting(document.'),
  );
  const helpers = source.slice(source.indexOf('function userContent('), source.indexOf('async function sendMessage('));
  const assistant = source.slice(source.indexOf('function assistantMessage('), source.indexOf('function userContent('));
  runInNewContext(
    assistant +
      '\nconst createAssistantMessage=assistantMessage;assistantMessage=parent=>{const view=createAssistantMessage(parent);views.push(view);return view;};\n' +
      helpers +
      fn +
      '\nthis.sendMessage=sendMessage;',
    context,
  );
  await context.sendMessage({ preventDefault() {} });
  return { state, requests, toolOptions, reviews, views, generationContainers, messages: $('messages') };
}

test('without vision, generated outputs are explained without marking them visually reviewed', async () => {
  const result = await exchange({ vision: false });
  assert.equal(result.reviews.length, 0);
  assert.equal(result.requests.length, 2);
});
test('missing image copies do not trigger an automatic review or an injected analysis request', async () => {
  const result = await exchange({ images: [], failed: true });
  assert.equal(result.requests[1].messages.at(-1).role, 'tool');
  assert.equal(
    result.requests[1].messages.some(message => message.internal),
    false,
  );
  assert.equal(result.reviews.length, 0);
});
test('a failed reload keeps the produced tool result and does not request a completion from a stopped engine', async () => {
  const result = await exchange({ ready: false, failed: true });
  assert.equal(result.requests.length, 1);
  assert.ok(result.state.messages.some(m => m.role === 'tool' && m.content.includes('generated')));
  assert.match(result.views.at(-1).note.textContent, /restart failed/);
});
test('image generation finishes without automatic pixels or review, while denial retains native protocol', async () => {
  const result = await exchange();
  assert.equal(result.reviews.length, 0);
  assert.equal(result.requests[1].messages.at(-1).role, 'tool');
  assert.doesNotMatch(JSON.stringify(result.requests), /base64/);
  const denied = await exchange({ denied: true, images: [] });
  // A refusal ends the turn: the model is not asked to comment on it.
  assert.equal(denied.requests.length, 1);
  assert.equal(denied.reviews.length, 0);
  assert.ok(
    denied.state.messages.some(m => m.role === 'tool' && m.tool_call_id === call.id && m.content.includes('denied')),
  );
});

test('a failed generation without output checks engine readiness before continuing the chat', async () => {
  const result = await exchange({ ready: false, failed: true, images: [], hasRecord: false });
  assert.equal(result.requests.length, 1);
  assert.match(result.views.at(-1).note.textContent, /restart failed/);
});

test('an optional output read supplies temporary pixels and can be followed by a reference comparison', async () => {
  const result = await exchange({ readOutputAfterGeneration: true, readResourceDuringReview: true });
  assert.equal(result.requests.length, 4);
  assert.equal(result.reviews.length, 1);
  assert.equal(result.reviews[0][1], 'Result explained');
  assert.equal(result.reviews[0][2], 'reviewed');
  assert.doesNotMatch(JSON.stringify(result.requests[1]), /base64/);
  assert.ok(
    result.requests[2].messages.some(
      message => message.outputId === 'run/0' && message.content.some(part => part.type === 'image_url'),
    ),
  );
  assert.doesNotMatch(JSON.stringify(result.state.messages), /base64|outputId/);
});

test('an output already read in the turn is not read again: the model answers from what it has', async () => {
  const result = await exchange({ readOutputAfterGeneration: true, readOutputAgain: true });
  assert.equal(result.requests.length, 4);
  const last = result.requests[3];
  assert.equal(last.messages.filter(message => message.outputId === 'run/0').length, 1);
  assert.match(last.messages.at(-1).content, /already_loaded/);
  assert.equal(last.resources, false, 'no further read is offered');
  assert.equal(result.reviews.length, 1);
});

test('an output inspection with no copy cannot mark the output visually reviewed', async () => {
  const result = await exchange({ readOutputAfterGeneration: true, images: [] });
  assert.equal(result.requests.length, 3);
  assert.equal(result.reviews.length, 0);
  assert.doesNotMatch(JSON.stringify(result.requests), /base64/);
});

test('a video is analysed after its generation only when the user chose it in the settings', async () => {
  const result = await exchange({ mediaType: 'video', reviewVideos: true });
  assert.equal(result.requests.length, 2);
  assert.equal(result.reviews.length, 1);
  assert.match(JSON.stringify(result.requests[1]), /base64/);
  assert.equal(result.toolOptions[0].review, true);
});

test('by default a video ends the turn like an image: no frames sent, no thinking, no text', async () => {
  const result = await exchange({ mediaType: 'video' });
  assert.equal(result.toolOptions[0].review, false);
  assert.equal(result.requests.length, 2);
  assert.equal(result.requests[1].thinking, false);
  assert.equal(result.requests[1].messages.at(-1).role, 'tool');
  assert.doesNotMatch(JSON.stringify(result.requests), /base64/);
  assert.equal(result.reviews.length, 0);
  assert.ok(!result.state.messages.some(message => message.content === 'Result explained'));
  // The model can still look at it when asked: the read tool hands it the frames.
  const read = await exchange({ mediaType: 'video', readOutputAfterGeneration: true });
  assert.equal(read.reviews.length, 1);
  assert.match(JSON.stringify(read.requests[2]), /base64/);
});

test('a tool call written as text once tools are withdrawn is never shown or stored', async () => {
  const leak = '<tool_call>\n<function=create_video>\n<parameter=prompt>\nA boat\n</parameter>\n</function>\n</tool_call>';
  const only = await exchange({ failed: true, images: [], finalText: leak });
  assert.equal(only.requests[1].tools, false);
  assert.doesNotMatch(JSON.stringify(only.state.messages.at(-1)), /tool_call|function=/);
  assert.match(only.state.messages.at(-1).content, /Renvoie ta demande/);
  const after = await exchange({ failed: true, images: [], finalText: 'La génération a échoué. ' + leak });
  assert.equal(after.state.messages.at(-1).content, 'La génération a échoué.');
});

test('blank or token-truncated model responses never mark an image as reviewed', async () => {
  for (const options of [{ finalText: '' }, { finalText: 'Partial analysis', finalReason: 'length' }]) {
    const result = await exchange({ ...options, readOutputAfterGeneration: true });
    assert.equal(result.reviews.length, 0);
    assert.equal(result.requests.length, 3);
  }
});

test('restoring repeated model call IDs associates each generation with its following result', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    restored = [];
  const element = () => ({ textContent: '', hidden: false, replaceChildren() {} }),
    context = {
    ...sessionCopies,
    ...chatVideos,
      state: { conversationId: 'selected' },
      generationUI: { restore: (_body, _conversation, run) => restored.push(run) },
      assistantMessage: () => ({ body: element(), reasoning: element(), thoughts: element(), note: element() }),
      renderText() {},
    };
  const messages = [
    { role: 'assistant', content: '', tool_calls: [call] },
    { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ run_id: 'first' }) },
    { role: 'assistant', content: '', tool_calls: [call] },
    { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ run_id: 'second' }) },
  ];
  runInNewContext(
    source.slice(source.indexOf('function renderTranscript('), source.indexOf('async function restoreUpdate(')) +
      ';this.draw=renderTranscript;',
    context,
  );
  context.draw(messages);
  assert.deepEqual(restored, ['first', 'second']);
  restored.length = 0;
  context.draw([messages[0], messages[2], messages[3]]);
  assert.deepEqual(restored, ['second']);
});

test('six sequential generations share one Atelier response and one image grid', async () => {
  const result = await exchange({ generationCalls: 6 });
  assert.equal(result.generationContainers.length, 6);
  assert.equal(new Set(result.generationContainers).size, 1);
  assert.equal(result.messages.children.length, 1);
  assert.equal(new Set(result.views.map(view => view.article)).size, 1);
  assert.equal(result.state.messages.filter(message => message.role === 'tool').length, 6);
  // Each request after an unseen image only decides whether to chain: no thinking, and its text is withheld.
  assert.equal(result.requests.length, 7);
  assert.ok(result.requests.slice(1).every(request => request.thinking === false));
  assert.equal(result.requests[0].thinking, true);
  assert.equal(result.state.messages.at(-1).role, 'tool');
  assert.ok(!result.state.messages.some(message => message.content === 'Result explained'));
});

test('restored generations share a response until the next real user message', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    roots = [],
    restored = [];
  const node = (tag = '', className = '', textContent = '') => ({
    tag,
    className,
    textContent,
    children: [],
    append(...items) {
      this.children.push(...items);
    },
    replaceChildren(...items) {
      this.children = items;
      this.textContent = '';
    },
    setAttribute() {},
  });
  const context = {
    ...sessionCopies,
    ...chatVideos,
    state: { conversationId: 'saved' },
    node,
    icon: () => node('svg'),
    $: () => ({ append: root => roots.push(root) }),
    savedUser: message => ({ text: message.content, images: [] }),
    userMessage() {},
    renderText(container, text) {
      container.textContent = text;
    },
    generationUI: { restore: (container, _, run) => restored.push({ container, run }) },
  };
  const messages = [
    { role: 'user', content: 'Two pictures' },
    ...[1, 2].flatMap(index => [
      { role: 'assistant', content: index === 1 ? 'Plan before generation' : '', tool_calls: [call] },
      { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ run_id: 'run' + index }) },
      { role: 'user', internal: true, content: 'Compressed analysis' },
    ]),
    { role: 'assistant', content: 'Done' },
    { role: 'user', content: 'Another image' },
    { role: 'assistant', content: '', tool_calls: [call] },
    { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ run_id: 'run3' }) },
  ];
  const assistant = source.slice(source.indexOf('function assistantMessage('), source.indexOf('function userContent(')),
    render = source.slice(
      source.indexOf('function renderTranscript('),
      source.indexOf('async function restoreUpdate('),
    );
  runInNewContext(assistant + render + ';this.draw=renderTranscript;', context);
  context.draw(messages);
  assert.equal(roots.length, 2);
  assert.equal(restored[0].container, restored[1].container);
  assert.notEqual(restored[1].container, restored[2].container);
  assert.deepEqual(
    restored.map(item => item.run),
    ['run1', 'run2', 'run3'],
  );
  assert.equal(roots[0].children.find(item => item.className === 'message-body').textContent, 'Plan before generation');
});
