import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createApplication } from '../server.mjs';
import { readSSE } from '../public/stream.mjs';
import { collectToolCalls } from '../lib/tool-runtime.mjs';
import { nativeFields } from '../lib/native-messages.mjs';
import { RemoteModels, nearbyHost } from '../lib/remote-models.mjs';
import { normalizedStream, remoteBody, remoteFailure, remoteRequest, testConnection } from '../lib/chat-model.mjs';
import { ChatGPTAccount, chatgptFailure, lighterRequest, responseChunks, responsesRequest } from '../lib/chatgpt.mjs';

/**
 * The findings of an independent review of the remote chat model (17/11), each turned into a test
 * that fails without its correction (0.6.39). Fake servers on 127.0.0.1 only.
 */
const folder = async t => {
  const path = await mkdtemp(join(tmpdir(), 'moodix-review-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
};
/** A server of one handler, closed with the test. */
async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}
const sse = (...events) =>
  new Response(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''))
    .body;
async function frames(body) {
  const events = [];
  await readSSE(body, event => events.push(event));
  return events;
}

test('M1 · a kept key never goes to another address: saved elsewhere it is dropped, tested elsewhere it is not sent', async t => {
  const data = await folder(t),
    remotes = new RemoteModels(data);
  const saved = await remotes.save({
    preset: 'custom',
    baseUrl: 'https://a.example/v1',
    model: 'm',
    key: 'sk-secret-a1',
  });
  // Saved again at another address without a new key: the kept one is not carried there.
  await remotes.save({ ...saved, baseUrl: 'https://b.example/v1' });
  assert.equal((await remotes.get(saved.id)).key, '');
  // The same address (another path): it stays.
  const other = await remotes.save({
    preset: 'custom',
    baseUrl: 'https://c.example/v1',
    model: 'm',
    key: 'sk-secret-c1',
  });
  await remotes.save({ ...other, baseUrl: 'https://c.example/api/v1' });
  assert.equal((await remotes.get(other.id)).key, 'sk-secret-c1');

  // « Tester la connexion » on a connection whose address was changed in the editor.
  const seen = [];
  const elsewhere = await serve(t, (req, res) => {
    seen.push(req.headers.authorization ?? '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"choices":[{"message":{"content":"OK"}}]}');
  });
  const app = await createApplication({ port: 0, dataDir: data, openUrl: () => {} });
  t.after(() => app.close());
  const token = (await (await fetch(app.url + '/api/bootstrap')).json()).token;
  const post = (path, body) =>
    fetch(`${app.url}/api/${path}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const kept = await remotes.save({
    preset: 'custom',
    baseUrl: 'https://d.example/v1',
    model: 'm',
    key: 'sk-secret-d1',
  });
  assert.equal(
    (await post('remote/test', { id: kept.id, preset: 'custom', baseUrl: `${elsewhere}/v1`, model: 'm' })).status,
    200,
  );
  assert.deepEqual(seen, [''], 'no key sent to the other address');
});

test('M1 · its hint in the editor: another address asks for its own key', async () => {
  // The words the page shows are checked in public/remote-llm-ui.mjs: the kept key is offered for its address only.
  const source = await readFile(new URL('../public/remote-llm-ui.mjs', import.meta.url), 'utf8');
  assert.match(source, /Nouvelle adresse : collez sa clé \(la clé enregistrée ne lui sera pas envoyée\)/);
  assert.match(source, /\$\('api-remove-key'\)\.hidden = !same;/);
});

test('M2 · a stream cut in the middle of the answer is said in French, with the name of the service', async t => {
  const base = await serve(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Bon' } }] })}\n\n`);
    setTimeout(() => res.destroy(), 30);
  });
  const connection = { preset: 'custom', baseUrl: `${base}/v1`, model: 'm', key: '' };
  const response = await remoteRequest(connection, { messages: [{ role: 'user', content: 'x' }], stream: true });
  await assert.rejects(frames(response.body), /La connexion à 127\.0\.0\.1:\d+ a été coupée pendant la réponse/);
  // Ended without its last word and without an end: said, not « connexion au moteur ».
  await assert.rejects(
    frames(normalizedStream(sse({ choices: [{ delta: { content: 'Bon' } }] }), 'api.example.com')),
    /La réponse de api\.example\.com s’est arrêtée avant sa fin/,
  );
  // ChatGPT: the same.
  const cut = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'x' })}\n\n`),
      );
      controller.error(new TypeError('terminated'));
    },
  });
  await assert.rejects(
    (async () => {
      for await (const chunk of responseChunks(cut)) void chunk;
    })(),
    /La connexion à ChatGPT a été coupée pendant la réponse/,
  );
});

test('M3 · a service too slow is said as such, never as an unexpected local error', async t => {
  const base = await serve(t, () => {});
  const connection = { preset: 'custom', baseUrl: `${base}/v1`, model: 'm', key: '' };
  await assert.rejects(
    remoteRequest(
      connection,
      { messages: [{ role: 'user', content: 'x' }], stream: false },
      { signal: AbortSignal.timeout(80) },
    ),
    error => error.status === 502 && /ne répond pas à temps/.test(error.message),
  );
});

test('M4 · a model that cannot call tools or see images is said so, not « adresse introuvable »', () => {
  const where = { host: 'openrouter.ai', model: 'some/model' };
  assert.match(
    remoteFailure(404, '{"error":{"message":"No endpoints found that support tool use."}}', where).message,
    /ne sait pas appeler d’outils/,
  );
  assert.match(
    remoteFailure(400, '{"error":{"message":"This model does not support image input"}}', where).message,
    /ne voit pas les images/,
  );
  assert.match(remoteFailure(404, '{"error":{"message":"Not Found"}}', where).message, /Adresse introuvable/);
});

test('M4 · images of the conversation said in words to a remote model that does not see them', async t => {
  const seen = [];
  const base = await serve(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push(JSON.parse(Buffer.concat(chunks)));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Vu' }, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const data = await folder(t);
  const app = await createApplication({ port: 0, dataDir: data, openUrl: () => {} });
  t.after(() => app.close());
  const token = (await (await fetch(app.url + '/api/bootstrap')).json()).token;
  const post = (path, body) =>
    fetch(`${app.url}/api/${path}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const { saved } = await (
    await post('remote/save', { preset: 'custom', baseUrl: `${base}/v1`, model: 'text-only', vision: false })
  ).json();
  await post('remote/select', { id: saved.id });
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rLkAAAAASUVORK5CYII=';
  const answer = await post('chat', {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Regarde' },
          { type: 'image_url', image_url: { url: png } },
        ],
      },
      { role: 'assistant', content: 'Je ne vois pas.' },
      { role: 'user', content: 'Et maintenant ?' },
    ],
    conversationId: randomUUID(),
    turnId: randomUUID(),
  });
  assert.equal(answer.status, 200, await answer.clone().text());
  assert.equal(JSON.stringify(seen[0].messages).includes('image_url'), false);
  assert.match(JSON.stringify(seen[0].messages), /Image jointe non montrée/);
});

test('M5 · the longest answer of the local model does not limit a remote one, which may reflect within it', () => {
  // No length asked at all (0.6.40): a floor could pass what the model can write.
  const connection = { preset: 'openrouter', model: 'm' };
  assert.equal(remoteBody({ messages: [], stream: true, max_tokens: 4096 }, connection).max_tokens, undefined);
  assert.equal(remoteBody({ messages: [], stream: false, max_tokens: 700 }, connection).max_tokens, undefined);
  assert.equal(remoteBody({ messages: [], stream: true, max_tokens: 32768 }, connection).max_tokens, undefined);
});

test('M6 · a renewal refused with an object: the user is asked to sign in again, the tokens go', async t => {
  const data = await folder(t);
  await writeFile(
    join(data, 'chatgpt-account.json'),
    JSON.stringify({
      client_id: 'oaiapp_x',
      access_token: 'old',
      refresh_token: 'gone',
      expires_at: 0,
      scopes: ['chatgpt.tokens.use.direct'],
    }),
  );
  const account = new ChatGPTAccount({
    dataDir: data,
    issuer: 'https://auth.example',
    api: 'https://api.example/v1',
    fetchImpl: async () =>
      Response.json({ error: { code: 'invalid_grant', message: 'Refresh token has expired' } }, { status: 400 }),
  });
  await assert.rejects(
    account.respond({ messages: [{ role: 'user', content: 'x' }], stream: true }, { model: 'm' }),
    /reconnectez-vous/,
  );
  const record = JSON.parse(await readFile(join(data, 'chatgpt-account.json'), 'utf8'));
  assert.deepEqual([record.access_token, record.refresh_token], [undefined, undefined]);
  assert.equal((await account.status()).connected, false);
});

test('the OpenAI preset sends no temperature nor top_p (its models that reflect refuse them)', () => {
  const sent = remoteBody(
    { messages: [], stream: true, temperature: 0.7, top_p: 0.95, max_tokens: 4096 },
    { preset: 'openai', model: 'o' },
  );
  assert.deepEqual(
    [sent.temperature, sent.top_p, sent.max_tokens, sent.max_completion_tokens],
    [undefined, undefined, undefined, undefined],
  );
});

test('calls of tools as other services write them: their identifier kept, a « stop » end, two calls without index', async () => {
  const events = await frames(
    normalizedStream(
      sse(
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { id: 'functions.create_image:0', function: { name: 'create_image', arguments: '{"prompt":' } },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ function: { arguments: '"boat"}' } }] } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ id: 'functions.create_video:1', function: { name: 'create_video', arguments: '{}' } }],
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        '[DONE]',
      ),
      'api.example.com',
    ),
  );
  const calls = [];
  for (const event of events) collectToolCalls(calls, event.choices?.[0]?.delta ?? {});
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].function, { name: 'create_image', arguments: '{"prompt":"boat"}' });
  assert.match(calls[0].id, /^[-A-Za-z0-9_]{1,128}$/);
  // The history takes it.
  assert.doesNotThrow(() => nativeFields({ role: 'assistant', tool_calls: calls }));
  assert.equal(events.find(event => event.choices?.[0]?.finish_reason).choices[0].finish_reason, 'tool_calls');
});

test('signed out of ChatGPT, another account can sign in, and no email is shown', async t => {
  const data = await folder(t);
  await writeFile(
    join(data, 'chatgpt-account.json'),
    JSON.stringify({
      ext_agent_host_id: 'urn:uuid:x',
      client_id: 'oaiapp_x',
      subject: 'a',
      email: 'a@example.com',
      access_token: 't',
    }),
  );
  let opened = '';
  const account = new ChatGPTAccount({ dataDir: data, issuer: 'https://auth.example', openUrl: url => (opened = url) });
  t.after(() => account.close());
  await account.signOut();
  assert.equal((await account.status()).email, '');
  await account.signIn();
  assert.equal(new URL(opened).searchParams.get('client_id'), 'dynamic_agent_client', 'registered anew');
  assert.equal(
    new URL(opened).searchParams.get('ext_agent_host_id'),
    'urn:uuid:x',
    'this computer keeps its identifier',
  );
});

test('two sign-ins asked at once (a double click) make one page of Moodix, not two', async t => {
  const data = await folder(t);
  const opened = [];
  const account = new ChatGPTAccount({
    dataDir: data,
    issuer: 'https://auth.example',
    openUrl: url => opened.push(url),
  });
  t.after(() => account.close());
  const [first, second] = await Promise.all([account.signIn(), account.signIn()]);
  assert.equal(first.url, second.url);
  assert.equal(opened.length, 1);
});

test('the effort chosen is never dropped in silence; a model that refuses it is said so', () => {
  const request = responsesRequest(
    { messages: [{ role: 'user', content: 'x' }], tools: [{ function: { name: 'a', parameters: {} } }] },
    'm',
    'high',
  );
  const lighter = lighterRequest(request);
  assert.deepEqual(lighter.reasoning, { effort: 'high' });
  assert.equal('tool_choice' in lighter, false);
  assert.match(
    chatgptFailure(400, '{"error":{"message":"Unsupported value: reasoning.effort"}}').message,
    /ne prend pas la force/,
  );
  assert.match(
    chatgptFailure(0, { error: { code: 'rate_limit_exceeded', message: 'Rate limit reached' } }).message,
    /Trop de demandes/,
  );
});

test('« Tester la connexion » on a web page that answers 200 is not a success', async t => {
  const base = await serve(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>Bienvenue</html>');
  });
  await assert.rejects(
    testConnection({ preset: 'custom', baseUrl: base, model: 'm', key: '' }),
    /ne répond pas comme un service de modèles compatible OpenAI/,
  );
});

test('a refusal that repeats the key does not show it', async t => {
  const key = 'sk-very-secret-key-123';
  const base = await serve(t, (req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Invalid key ${req.headers.authorization}` } }));
  });
  await assert.rejects(
    remoteRequest({ preset: 'custom', baseUrl: `${base}/v1`, model: 'm', key }, { messages: [], stream: false }),
    error => /refusée/.test(error.message) && !error.message.includes(key),
  );
});

test('the home network: a name of it (nas.local, nas) is near; a name that only begins like an address is not', () => {
  assert.deepEqual(
    [
      'nas.local',
      'nas',
      'box.lan',
      '10.0.0.4',
      '192.168.1.2',
      '10.example.com',
      '192.168.evil.com',
      'api.openai.com',
    ].map(nearbyHost),
    [true, true, true, true, true, false, false, false],
  );
});

test('a file of keys that cannot be read is not written again with one key (the others would be lost)', async t => {
  const data = await folder(t),
    remotes = new RemoteModels(data);
  await mkdir(data, { recursive: true });
  await writeFile(join(data, 'remote-llm-keys.json'), '{"broken"');
  await assert.rejects(
    remotes.save({ preset: 'custom', baseUrl: 'https://a.example/v1', model: 'm', key: 'sk-new-key-1' }),
    /ne se lit pas/,
  );
  assert.equal(await readFile(join(data, 'remote-llm-keys.json'), 'utf8'), '{"broken"');
});
