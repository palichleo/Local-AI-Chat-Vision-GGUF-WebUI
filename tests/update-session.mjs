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

test('a conversation taken back keeps the file of its attached images: it can be saved and gone on with', () => {
  const pixels = 'data:image/png;base64,iVBORw0KGgo=',
    file = 'original-' + 'a'.repeat(64) + '.png',
    base = { conversationId: 'a1111111-1111-4111-8111-111111111111', prompt: '', images: [], title: '', thinking: true };
  const saved = updateSession({
    ...base,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Regarde' },
          // As the page holds it: the model's copy, its file, the address it is shown by.
          { type: 'image_url', image_url: { url: pixels }, file, view: '/media/attachments/x?key=1' },
          // Just reopened: no copy made yet.
          { type: 'image_url', file },
        ],
      },
    ],
    // The draft: one joined now, one taken back from an interrupted message, one that is a reference.
    images: [
      { name: 'a.png', url: pixels },
      { name: 'b.png', file },
      { name: 'c.png', url: pixels, file, resource: 'c3333333-3333-4333-8333-333333333333', view: '/x', source: {} },
    ],
  });
  assert.deepEqual(saved.messages[0].content, [
    { type: 'text', text: 'Regarde' },
    { type: 'image_url', image_url: { url: pixels }, file },
    { type: 'image_url', file },
  ]);
  assert.deepEqual(saved.images, [
    { name: 'a.png', url: pixels },
    { name: 'b.png', file },
    { name: 'c.png', url: pixels, file, resource: 'c3333333-3333-4333-8333-333333333333' },
  ]);
  // A name that is no file of the history is not taken on trust; without pixels it is nothing.
  const odd = updateSession({ ...base, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: pixels }, file: '../secret.png' }] }] });
  assert.deepEqual(odd.messages[0].content, [{ type: 'image_url', image_url: { url: pixels } }]);
  assert.throws(() => updateSession({ ...base, messages: [{ role: 'user', content: [{ type: 'image_url', file: '../secret.png' }] }] }));
  assert.throws(() => updateSession({ ...base, images: [{ name: 'x', file: 'C:\\x.png' }] }));
});

test('a conversation of more than a hundred messages goes through an update or a restart', () => {
  const base = { conversationId: 'a1111111-1111-4111-8111-111111111111', prompt: '', images: [], title: '', thinking: true },
    many = count => Array.from({ length: count }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'm' + index }));
  // Thirty creations made from the chat are a hundred and twenty messages.
  assert.equal(updateSession({ ...base, messages: many(120) }).messages.length, 120);
  assert.equal(updateSession({ ...base, messages: many(1000) }).messages.length, 1000);
  assert.throws(() => updateSession({ ...base, messages: many(1001) }));
  const snapshot = { messages: many(121), incomplete: true };
  assert.equal(updateSession({ ...base, messages: snapshot.messages.slice(0, 120), archiveSnapshot: snapshot }).archiveSnapshot.messages.length, 121);
});
