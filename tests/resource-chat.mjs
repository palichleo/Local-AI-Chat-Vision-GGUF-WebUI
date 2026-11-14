import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { readSSE } from '../public/stream.mjs';
import * as sessionCopies from '../public/session-copies.mjs';
import * as chatVideos from '../public/chat-videos.mjs';
test('grouped resource frames retain their separate labels and never enter saved conversation snapshots', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    png = 'data:image/png;base64,iVBORw0KGgo=';
  const element = () => ({
      value: '',
      disabled: false,
      hidden: false,
      textContent: '',
      classList: { add() {} },
      replaceChildren() {},
      remove() {},
      focus() {},
    }),
    nodes = new Map(),
    $ = id => {
      if (!nodes.has(id)) nodes.set(id, element());
      return nodes.get(id);
    };
  $('prompt').value = 'Inspect the reference';
  const state = {
      config: { enginePath: 'engine', modelPath: 'model' },
      messages: [],
      images: [],
      videos: [],
      status: { state: 'ready', vision: true },
      thinking: false,
    },
    requests = [],
    snapshots = [];
  let calls = 0;
  const context = {
    ...sessionCopies,
    ...chatVideos,
    turnActions() {},
    showLastReply() {},
    generationUI: { mount: () => ({ progress() {}, image() {}, finish() {}, fail() {} }) },
    assetsUI: { flush: async () => true },
    state,
    $,
    AbortController,
    performance,
    crypto,
    readSSE,
    contextMeter: { pause() {}, observe() {}, schedule() {} },
    node: () => element(),
    userMessage: () => element(),
    assistantMessage: () => ({
      article: element(),
      reasoning: element(),
      thoughts: element(),
      body: element(),
      note: element(),
    }),
    renderAttachments() {},
    resizePrompt() {},
    markThinking() {},
    notice() {},
    scrollToBottom() {},
    renderText() {},
    updateControls() {},
    openSettings() {},
    historyWrite: Promise.resolve(),
    refreshStatus: async () => {},
    setConversationTitle() {},
    waitForModel: async () => {},
    persistConversation: async () => {
      snapshots.push(JSON.stringify(state.archiveSnapshot));
      return true;
    },
    workflowsUI: { saveReview: async () => {} },
    api: async (route, body) => {
      if (route === 'resources/read') {
        assert.equal(body.ids.length, 2);
        return Response.json({
          resources: [
            {
              id: 'resource',
              label: 'Ref 1',
              name: 'Reference',
              description: 'Blue light',
              mime: 'image/png',
              width: 1,
              height: 1,
              frames: [{ url: png, time: null }],
            },
            {
              id: 'second',
              label: 'Ref 2',
              name: 'Second image',
              description: 'Other subject',
              mime: 'image/png',
              width: 1,
              height: 1,
              frames: [{ url: png, time: null }],
            },
          ],
        });
      }
      assert.equal(route, 'chat');
      requests.push(structuredClone(body));
      const events =
        ++calls === 1
          ? [
              { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
              {
                local_tool_request: {
                  kind: 'resource',
                  resourceId: 'resource',
                  resourceIds: ['resource', 'second'],
                  workflowName: 'Reference',
                  call: {
                    id: 'read_one',
                    type: 'function',
                    function: { name: 'local_read_resource', arguments: '{"resource_id":"resource"}' },
                  },
                },
              },
            ]
          : [{ choices: [{ delta: { content: 'The resource is blue.' }, finish_reason: 'stop' }] }];
      return new Response(events.map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('') + 'data: [DONE]\n\n');
    },
  };
  const helpers = source.slice(source.indexOf('function userContent('), source.indexOf('async function sendMessage(')),
    send = source.slice(
      source.indexOf('async function sendMessage('),
      source.indexOf('setupMaterialLighting(document.'),
    );
  runInNewContext(helpers + send + '\nthis.send=sendMessage;', context);
  await context.send({ preventDefault() {} });
  assert.equal(requests.length, 2);
  assert.ok(requests[1].messages.some(message => message.resourceId === 'resource'));
  assert.ok(requests[1].messages.some(message => message.resourceId === 'second'));
  assert.match(requests[1].messages.find(message => message.resourceId === 'resource').content[0].text, /Ref 1/);
  assert.match(requests[1].messages.find(message => message.resourceId === 'second').content[0].text, /Ref 2/);
  assert.doesNotMatch(JSON.stringify(state.messages), /base64/);
  assert.ok(snapshots.every(snapshot => !snapshot.includes('base64')));
  $('prompt').value = 'Continue';
  await context.send({ preventDefault() {} });
  assert.doesNotMatch(JSON.stringify(requests[2]), /base64/);
});

test('a failed description save keeps the composer intact and never sends a chat request', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    state = { config: { enginePath: 'engine', modelPath: 'model' } },
    prompt = { value: 'Keep my message' },
    send = { disabled: false };
  let calls = 0,
    warning = '';
  const context = {
    ...sessionCopies,
    ...chatVideos,
    turnActions() {},
    showLastReply() {},
    generationUI: { mount: () => ({ progress() {}, image() {}, finish() {}, fail() {} }) },
    state,
    $: id => (id === 'send' ? send : prompt),
    assetsUI: { flush: async () => false },
    updateControls() {},
    notice: text => {
      warning = text;
    },
    api: () => {
      calls++;
    },
  };
  const fn = source.slice(
    source.indexOf('async function sendMessage('),
    source.indexOf('function alignConversation()'),
  );
  runInNewContext(fn + '\nthis.send=sendMessage;', context);
  await context.send({ preventDefault() {} });
  assert.equal(calls, 0);
  assert.equal(prompt.value, 'Keep my message');
  assert.equal(state.preparing, false);
  assert.match(warning, /description/);
});
