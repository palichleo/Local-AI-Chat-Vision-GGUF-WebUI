import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { History } from '../lib/history.mjs';
import { createApplication } from '../server.mjs';
import { updateSession } from '../lib/update-session.mjs';
test('global instructions are saved across app restarts and invalid input does not overwrite them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-instructions-'));
  let app;
  t.after(async () => {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  });
  app = await createApplication({ port: 0, dataDir: directory });
  let boot = await (await fetch(app.url + '/api/bootstrap')).json();
  const post = body =>
    fetch(app.url + '/api/settings', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + boot.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: boot.config, generation: boot.generation, ...body }),
    });
  assert.equal((await post({ instructions: 'Use the supplied project context.' })).status, 200);
  assert.equal((await post({ instructions: 'x'.repeat(16001) })).status, 400);
  await app.close();
  app = await createApplication({ port: 0, dataDir: directory });
  boot = await (await fetch(app.url + '/api/bootstrap')).json();
  assert.equal(boot.instructions, 'Use the supplied project context.');
});
test('conversation context survives history and update checkpoints, and old histories stay independent of new defaults', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-context-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const history = new History(join(directory, 'history')),
    id = randomUUID();
  await history.save({ id, messages: [{ role: 'user', content: 'Hello' }], instructions: 'Original context' });
  assert.equal((await history.read(id)).instructions, 'Original context');
  const input = {
    conversationId: id,
    conversationInstructions: 'Original context',
    messages: [],
    images: [],
    prompt: '',
    title: '',
    thinking: false,
  };
  assert.equal(updateSession(input).conversationInstructions, 'Original context');
  await assert.rejects(history.save({ id, messages: [{ role: 'user', content: 'Hello' }], instructions: 42 }));
});
test('global context appears once at the start of the model context and never grows with successive messages', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    begin = source.indexOf('function chatRequest('),
    end = source.indexOf('async function sendMessage(', begin);
  const state = { messages: [], globalInstructions: 'Initial guidance', conversationInstructions: null };
  const sandbox = { state };
  runInNewContext(source.slice(begin, end) + '\nthis.request=chatRequest;', sandbox);
  let request = sandbox.request([{ role: 'user', content: 'Hi' }]);
  assert.equal(request.messages[0].role, 'system');
  assert.match(request.messages[0].content, /Contexte fourni par l’utilisateur/);
  assert.equal(request.messages.filter(m => m.content.includes('Initial guidance')).length, 1);
  state.conversationInstructions = state.globalInstructions;
  state.globalInstructions = 'Changed guidance';
  state.messages = [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Answer' },
  ];
  request = sandbox.request([...state.messages, { role: 'user', content: 'Continue' }]);
  assert.match(request.messages[0].content, /Initial guidance/);
  assert.doesNotMatch(JSON.stringify(request), /Changed guidance/);
  assert.equal(request.messages.filter(m => m.content.includes('Initial guidance')).length, 1);
  state.conversationInstructions = '';
  request = sandbox.request(state.messages);
  assert.doesNotMatch(JSON.stringify(request), /Changed guidance/);
});
