import test from 'node:test';
import assert from 'node:assert/strict';
import { updateSession } from '../lib/update-session.mjs';

test('restart session retains the pending user turn and incomplete marker even when it is restored as a draft', () => {
  const snapshot = {
    messages: [
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Answer' },
      { role: 'user', content: 'Pending message' },
    ],
    incomplete: true,
  };
  const saved = updateSession({
    messages: snapshot.messages.slice(0, -1),
    archiveSnapshot: snapshot,
    conversationId: 'a1111111-1111-4111-8111-111111111111',
    prompt: 'Pending message',
    images: [],
    title: 'Question',
    thinking: true,
  });
  assert.deepEqual(saved.archiveSnapshot, snapshot);
  assert.equal(saved.prompt, 'Pending message');
  assert.equal(saved.messages.length, 2);
});
test('session checkpoint refuses remote images, unsupported roles and invalid pending records', () => {
  const base = { messages: [], conversationId: null, prompt: '', images: [], title: '', thinking: true };
  assert.throws(() => updateSession({ ...base, images: [{ name: 'x', url: 'https://example.org/x.png' }] }));
  assert.throws(() => updateSession({ ...base, messages: [{ role: 'system', content: 'Not permitted' }] }));
  assert.throws(() => updateSession({ ...base, archiveSnapshot: { messages: [], incomplete: 'no' } }));
});

test('a large valid transcript is transferred and checkpointed once while retaining a pending tail', async () => {
  const { compactSession } = await import('../public/update-ui.mjs');
  assert.equal(typeof compactSession, 'function');
  const messages = Array.from({ length: 80 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: 'x'.repeat(150000),
  }));
  const pending = { role: 'user', content: 'Draft waiting for an answer' };
  const input = {
    messages,
    archiveSnapshot: { messages: [...messages, pending], incomplete: true },
    conversationId: null,
    prompt: pending.content,
    images: [],
    title: 'Large conversation',
    thinking: true,
  };
  const wire = compactSession(input);
  assert.ok(Buffer.byteLength(JSON.stringify(wire)) < 20 * 1024 * 1024);
  const restored = updateSession(wire);
  assert.equal(restored.messages.length, 80);
  assert.equal(restored.archiveSnapshot.messages.length, 81);
  assert.equal(restored.archiveSnapshot.messages.at(-1).content, pending.content);
  assert.ok(Buffer.byteLength(JSON.stringify(compactSession(restored))) < 20 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(compactSession(JSON.parse(JSON.stringify(restored))))) < 20 * 1024 * 1024);
});
