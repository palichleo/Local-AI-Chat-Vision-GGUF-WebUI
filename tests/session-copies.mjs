import test from 'node:test';
import assert from 'node:assert/strict';
import { fillCopies, forgetCopies, needsCopies, rememberCopy, withoutCopies } from '../public/session-copies.mjs';

const conversationId = '11111111-1111-4111-8111-111111111111';
const file = 'original-' + 'a'.repeat(64) + '.png';
const copy = 'data:image/jpeg;base64,/9j/';

test('a stored attachment is saved by name only and gets its session copy back before the model sees it', async () => {
  const sent = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Look' },
        { type: 'image_url', image_url: { url: copy }, file, view: '/media/attachments/x' },
      ],
    },
  ];
  assert.deepEqual(withoutCopies(sent)[0].content[1], { type: 'image_url', file }, 'no pixels are stored');
  assert.equal(sent[0].content[1].image_url.url, copy, 'the page keeps its copy');

  const reopened = [{ role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', file }] }];
  assert.ok(needsCopies(reopened));
  rememberCopy(conversationId, file, copy);
  let fetched = 0;
  await fillCopies(reopened, { api: async () => (fetched++, new Response('')), conversationId });
  assert.equal(reopened[0].content[1].image_url.url, copy);
  assert.equal(fetched, 0, 'a copy made in this session is reused');
  assert.ok(!needsCopies(reopened));
  forgetCopies(conversationId);
});

test('a missing copy is made from the original, and a failure leaves no stale entry', async () => {
  forgetCopies();
  const messages = [{ role: 'user', content: [{ type: 'image_url', file }] }];
  const routes = [];
  const api = async route => {
    routes.push(route);
    throw Error('offline');
  };
  await assert.rejects(fillCopies(messages, { api, conversationId }), /offline/);
  assert.deepEqual(routes, [`attachments/${conversationId}/${file}`], 'the original is what gets read');
  await assert.rejects(fillCopies(messages, { api, conversationId }), /offline/);
  assert.equal(routes.length, 2, 'a failed attempt is retried later');
});
