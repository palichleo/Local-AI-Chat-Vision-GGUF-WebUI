import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../server.mjs';

test('install requires authentication and available version, then reserves mutations and closes only after preparation', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-update-api-'));
  let app,
    release,
    committed = false,
    prepared = false;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  try {
    app = await createApplication({
      port: 0,
      dataDir,
      updateChecker: async () => ({ available: true, version: '0.3.0' }),
      updateInstaller: {
        prepare: async ({ version, port }) => {
          assert.equal(version, '0.3.0');
          assert.ok(port > 0);
          prepared = true;
          await gate;
          return {};
        },
        launch: async () => ({
          commit: async () => {
            committed = true;
          },
          abort() {},
        }),
      },
    });
    const bootstrap = await (await fetch(app.url + '/api/bootstrap')).json();
    const call = (route, body, token = bootstrap.token) =>
      fetch(app.url + '/api/' + route, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const session = {
      messages: [
        { role: 'user', content: 'Local conversation' },
        { role: 'assistant', content: 'Reply' },
      ],
      conversationId: 'a1111111-1111-4111-8111-111111111111',
      prompt: 'draft',
      images: [],
      thinking: true,
      title: 'Local conversation',
    };
    assert.equal((await call('updates/install', { session }, '')).status, 401);
    const accepted = await call('updates/install', { session });
    assert.equal(accepted.status, 202);
    assert.equal(committed, false);
    const status = await (await call('updates/install')).json();
    assert.equal(status.state, 'preparing');
    for (let i = 0; !prepared && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(prepared, true);
    for (const route of ['start', 'history/clear', 'updates/install'])
      assert.equal((await call(route, {})).status, 409);
    const stored = JSON.parse(await readFile(join(dataDir, 'update-session.json'), 'utf8'));
    assert.equal(stored.prompt, 'draft');
    assert.deepEqual(stored.messages, session.messages);
    release();
    const deadline = Date.now() + 5000;
    while (!committed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(committed, true);
    await app.close();
    app = null;
    app = await createApplication({ port: 0, dataDir });
    const next = await (await fetch(app.url + '/api/bootstrap')).json();
    const headers = { Authorization: `Bearer ${next.token}`, 'Content-Type': 'application/json' };
    assert.equal((await (await fetch(app.url + '/api/updates/session', { headers })).json()).prompt, 'draft');
    assert.equal(
      (await fetch(app.url + '/api/updates/session/clear', { method: 'POST', headers, body: '{}' })).status,
      200,
    );
    assert.equal(await (await fetch(app.url + '/api/updates/session', { headers })).json(), null);
  } finally {
    release();
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a failed download keeps the old app available and can be retried, without deleting history', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-update-api-'));
  let app;
  try {
    app = await createApplication({
      port: 0,
      dataDir,
      updateChecker: async () => ({ available: true, version: '0.3.0' }),
      updateInstaller: {
        prepare: async () => {
          throw new Error('Network unavailable');
        },
      },
    });
    const { token } = await (await fetch(app.url + '/api/bootstrap')).json();
    const call = (route, body) =>
      fetch(app.url + '/api/' + route, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    assert.equal(
      (
        await call('updates/install', {
          session: { messages: [], prompt: '', images: [], conversationId: null, title: '', thinking: false },
        })
      ).status,
      202,
    );
    let state;
    for (let i = 0; i < 50; i++) {
      state = await (await call('updates/install')).json();
      if (state.state === 'error') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(state.state, 'error');
    assert.match(state.error, /Network/);
    assert.equal((await call('status')).status, 200);
    assert.equal((await call('preferences', { theme: 'light' })).status, 200);
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test(
  'a valid near-limit conversation plus an image draft fits the bounded update checkpoint',
  { timeout: 15000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'atelier-update-large-'));
    let app, release;
    const gate = new Promise(resolve => {
      release = resolve;
    });
    try {
      app = await createApplication({
        port: 0,
        dataDir,
        updateChecker: async () => ({ available: true, version: '0.3.0' }),
        updateInstaller: {
          prepare: async () => {
            await gate;
            throw Error('Fixture download stopped');
          },
        },
      });
      const { token } = await (await fetch(app.url + '/api/bootstrap')).json();
      const messages = Array.from({ length: 90 }, () => ({ role: 'user', content: 'x'.repeat(200000) }));
      const session = {
        messages,
        conversationId: null,
        prompt: 'Image draft',
        images: [{ name: 'draft.jpg', url: 'data:image/jpeg;base64,' + 'A'.repeat(4 * 1024 * 1024) }],
        title: 'Large',
        thinking: false,
      };
      const body = JSON.stringify({ session });
      assert.ok(Buffer.byteLength(body) > 20 * 1024 * 1024);
      const response = await fetch(app.url + '/api/updates/install', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body,
      });
      assert.equal(response.status, 202);
    } finally {
      release();
      await app?.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
