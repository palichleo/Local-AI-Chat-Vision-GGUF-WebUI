import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { createApplication } from '../server.mjs';
import { readSSE } from '../public/stream.mjs';
import { collectToolCalls, ToolRuntime } from '../lib/tool-runtime.mjs';
import { RemoteModels, connectionOf, nearbyHost, onThisComputer, serviceUrl } from '../lib/remote-models.mjs';
import {
  ChatModel,
  estimateContext,
  minimalBody,
  normalizedEvent,
  remoteBody,
  remoteFailure,
  remoteRequest,
} from '../lib/chat-model.mjs';
import { ChatGPTAccount, chatgptFailure, responseChunks, responsesRequest } from '../lib/chatgpt.mjs';

/**
 * The chat model reached by an address instead of llama.cpp (0.6.36): the connections and their
 * keys, the requests made for a service, its answers read as the chat reads llama.cpp's, the
 * sign-in « Continuer avec ChatGPT », and a turn of the chat with tools against a fake service.
 * Nothing here calls a real provider.
 */
const fixture = fileURLToPath(new URL('./fixtures/fake-tool-engine.mjs', import.meta.url));
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rLkAAAAASUVORK5CYII=',
  'base64',
);
const folder = async t => {
  const path = await mkdtemp(join(tmpdir(), 'moodix-remote-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
};
const stream = (...events) =>
  new Response(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''))
    .body;
async function chunksOf(body) {
  const events = [];
  await readSSE(body, event => events.push(event));
  return events;
}
async function until(check, tries = 400) {
  for (let i = 0; i < tries; i++) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('Timed out');
}

test('a connection keeps its key apart, never gives it back, and refuses a key sent in clear over the Internet', async t => {
  const data = await folder(t),
    remotes = new RemoteModels(data);
  const saved = await remotes.save({
    preset: 'mistral',
    model: 'mistral-medium-latest',
    key: 'Bearer sk-secret-1',
    vision: true,
  });
  assert.deepEqual(
    [saved.name, saved.baseUrl, saved.hasKey, saved.key],
    ['Mistral', 'https://api.mistral.ai/v1', true, undefined],
  );
  const listed = await remotes.list();
  assert.equal(JSON.stringify(listed).includes('sk-secret'), false, 'the page never sees the key');
  assert.equal((await readFile(join(data, 'remote-llms.json'), 'utf8')).includes('sk-secret'), false);
  assert.equal((await remotes.get(saved.id)).key, 'sk-secret-1', 'the « Bearer » pasted with it is left');
  // Saved again without a key: the one kept stays; with an empty one: removed.
  await remotes.save({ ...saved, model: 'mistral-large-latest' });
  assert.equal((await remotes.get(saved.id)).key, 'sk-secret-1');
  await remotes.save({ ...saved, key: '' });
  assert.equal((await remotes.get(saved.id)).key, '');
  await remotes.setActive(saved.id);
  assert.equal((await remotes.active()).id, saved.id);
  await remotes.remove(saved.id);
  assert.deepEqual(await remotes.list(), { connections: [], active: null });

  assert.equal(serviceUrl('https://openrouter.ai/api/v1/chat/completions/'), 'https://openrouter.ai/api/v1');
  assert.equal(serviceUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1');
  assert.equal(serviceUrl('http://192.168.1.20:1234/v1'), 'http://192.168.1.20:1234/v1');
  assert.throws(() => serviceUrl('http://api.example.com/v1'), /https:\/\//);
  assert.throws(() => serviceUrl('https://user:pass@api.example.com/v1'), /clé dans son champ/);
  assert.throws(() => connectionOf({ preset: 'openai', model: '' }), /nom du modèle/);
  assert.deepEqual(
    [nearbyHost('localhost'), nearbyHost('10.0.0.2'), nearbyHost('api.openai.com')],
    [true, true, false],
  );
  assert.deepEqual(
    [onThisComputer('http://127.0.0.1:1234/v1'), onThisComputer('http://192.168.1.2/v1')],
    [true, false],
  );
});

test('a request for a service leaves out what only llama.cpp knows, and its answer is read as llama.cpp’s', () => {
  const body = {
    model: 'local',
    messages: [
      { role: 'user', content: 'bonjour' },
      { role: 'assistant', content: 'salut', reasoning_content: 'pensée gardée' },
      { role: 'user', content: 'encore' },
    ],
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.7,
    top_p: 0.95,
    top_k: 20,
    max_tokens: 4096,
    reasoning_format: 'deepseek',
    chat_template_kwargs: { enable_thinking: true },
    tools: [{ type: 'function', function: { name: 'create_image', parameters: {} } }],
    tool_choice: 'auto',
    parallel_tool_calls: false,
  };
  const sent = remoteBody(body, { preset: 'openrouter', model: 'qwen/qwen3-235b' });
  assert.equal(sent.model, 'qwen/qwen3-235b');
  for (const key of ['top_k', 'reasoning_format', 'chat_template_kwargs']) assert.equal(key in sent, false, key);
  assert.equal(sent.messages[1].reasoning_content, undefined);
  assert.equal(body.messages[1].reasoning_content, 'pensée gardée', 'the conversation itself keeps it');
  // OpenAI wants its own word for the length; Mistral refuses what it does not know.
  const openai = remoteBody(body, { preset: 'openai', model: 'gpt-4.1' });
  assert.deepEqual([openai.max_tokens, openai.max_completion_tokens], [undefined, 4096]);
  assert.equal('stream_options' in remoteBody(body, { preset: 'mistral', model: 'm' }), false);
  assert.deepEqual(Object.keys(minimalBody(sent)).sort(), ['messages', 'model', 'stream', 'tool_choice', 'tools']);

  // The reflection under its other names, a content given as a list, a second call left.
  assert.equal(
    normalizedEvent({ choices: [{ delta: { reasoning: 'je pense' } }] }).choices[0].delta.reasoning_content,
    'je pense',
  );
  const mistral = normalizedEvent({
    choices: [
      {
        delta: {
          content: [
            { type: 'thinking', thinking: [{ type: 'text', text: 'hmm' }] },
            { type: 'text', text: 'Voilà' },
          ],
        },
      },
    ],
  }).choices[0].delta;
  assert.deepEqual([mistral.content, mistral.reasoning_content], ['Voilà', 'hmm']);
  const calls = normalizedEvent({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: 'a', function: { name: 'x' } },
            { index: 1, id: 'b', function: { name: 'y' } },
          ],
        },
      },
    ],
  }).choices[0].delta.tool_calls;
  assert.deepEqual(
    calls.map(call => call.id),
    ['a'],
  );
  assert.equal(
    normalizedEvent({ choices: [{ delta: { tool_calls: [{ id: 'c' }] } }] }).choices[0].delta.tool_calls[0].index,
    0,
  );
  assert.match(
    normalizedEvent({ error: { message: 'Rate limit exceeded' } }, 'openrouter.ai').error,
    /^openrouter\.ai : Rate limit exceeded/,
  );
});

test('a refusal of a service is said in the user’s words, never as a 401 the page would take for its own key', () => {
  const where = { host: 'api.mistral.ai', model: 'mistral-medium' };
  const said = (status, body) => remoteFailure(status, JSON.stringify(body), where);
  const refused = said(401, { message: 'Unauthorized' });
  assert.equal(refused.status, 502);
  assert.match(refused.message, /^La clé d’API est refusée par api\.mistral\.ai \(Unauthorized\)/);
  assert.match(
    said(404, { error: { message: 'Invalid model: mistral-medium' } }).message,
    /Modèle inconnu chez api\.mistral\.ai : « mistral-medium »/,
  );
  assert.match(said(404, { error: 'Not Found' }).message, /Adresse introuvable/);
  assert.match(said(402, { error: { message: 'Insufficient credits' } }).message, /Crédit épuisé/);
  assert.match(said(429, { error: { message: 'quota' } }).message, /Limite ou quota atteint/);
  assert.match(said(503, {}).message, /panne passagère \(erreur 503\)/);
  assert.match(
    said(422, { detail: [{ msg: 'Extra inputs are not permitted' }] }).message,
    /refuse la demande \(erreur 422\) \(Extra inputs are not permitted\)/,
  );
});

test('a service that refuses a field it does not know is asked again once with the fields every service takes', async () => {
  const sent = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    sent.push({ url, body, authorization: options.headers.Authorization });
    if ('temperature' in body) return new Response('{"message":"Extra inputs are not permitted"}', { status: 422 });
    return new Response(
      'data: {"choices":[{"delta":{"content":"Bonjour"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  };
  const connection = { preset: 'mistral', baseUrl: 'https://api.mistral.ai/v1', model: 'm', key: 'k' };
  const response = await remoteRequest(
    connection,
    { messages: [{ role: 'user', content: 'hi' }], stream: true, temperature: 0.7 },
    { fetchImpl },
  );
  const events = await chunksOf(response.body);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].url, 'https://api.mistral.ai/v1/chat/completions');
  assert.equal(sent[0].authorization, 'Bearer k');
  assert.deepEqual(Object.keys(sent[1].body).sort(), ['messages', 'model', 'stream']);
  assert.equal(events[0].choices[0].delta.content, 'Bonjour');
  // A service that ends without « [DONE] »: the answer is whole all the same, once it said its end.
  await assert.rejects(
    remoteRequest(
      { ...connection, key: '' },
      { messages: [], stream: true },
      {
        fetchImpl: async () => {
          throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
        },
      },
    ),
    /api\.mistral\.ai est introuvable : vérifiez la connexion à Internet/,
  );
  assert.deepEqual(estimateContext({ messages: [{ role: 'user', content: 'x'.repeat(360) }] }), {
    used: 104,
    precision: 'rough',
  });
});

test('the chat model in use: the local engine, or a remote connection that loads nothing and keeps the card free', async t => {
  const data = await folder(t),
    remotes = new RemoteModels(data);
  const events = [];
  const engine = {
    state: 'ready',
    busy: false,
    vision: true,
    error: '',
    logs: [],
    base: 'http://127.0.0.1:1',
    apiKey: 'local',
    status() {
      return { state: this.state, vision: this.vision, busy: this.busy, logs: [], error: '' };
    },
    async start() {
      events.push('llm started');
      this.state = 'ready';
    },
    async stop() {
      events.push('llm stopped');
      this.state = 'stopped';
    },
  };
  const chat = await new ChatModel({ engine, remotes }).load();
  assert.equal(chat.local, true);
  assert.equal(chat.status().remote, null);
  const saved = await remotes.save({ preset: 'ollama', model: 'qwen3:8b', vision: false });
  await chat.use(saved.id);
  assert.deepEqual(events, ['llm stopped'], 'the local model leaves the card');
  assert.equal(chat.state, 'ready', 'a remote model is ready as soon as it is chosen');
  assert.deepEqual(chat.limits({ contextSize: 8192, maxOutputTokens: 4096 }), { capacity: 131072, reserved: 4096 });
  const shown = chat.status().remote;
  assert.deepEqual(
    [shown.name, shown.host, shown.model, shown.leaves, shown.thinking],
    ['Ollama', '127.0.0.1:11434', 'qwen3:8b', false, false],
  );
  chat.busy = true;
  assert.equal(engine.busy, false, 'a remote answer does not lock the engine');
  await assert.rejects(chat.use(null), /Une réponse est en cours/);
  chat.busy = false;
  // Kept: read back at the next launch.
  assert.equal((await new ChatModel({ engine, remotes }).load()).connection.id, saved.id);
  await chat.use(null);
  assert.equal(chat.local, true);
  assert.equal((await remotes.list()).active, null);
});

test('a generation with a remote chat model: nothing is stopped nor reloaded, and a video still waits for its own consent', async t => {
  const data = await folder(t),
    remotes = new RemoteModels(data);
  const events = [];
  const engine = {
    state: 'stopped',
    busy: false,
    status: () => ({ state: 'stopped' }),
    stop: async () => events.push('llm stopped'),
    start: async () => events.push('llm started'),
  };
  const chat = await new ChatModel({ engine, remotes }).load();
  await chat.use((await remotes.save({ preset: 'openrouter', model: 'some/model', key: 'k' })).id);
  events.length = 0;
  const workflow = {
    schemaVersion: 1,
    id: 'video',
    name: 'Video',
    digest: 'b'.repeat(64),
    mediaType: 'video',
    pipeline: 'ltx25',
    enabled: true,
    ready: true,
    parameters: {},
    references: [],
  };
  const catalog = {
    list: async () => [workflow],
    read: async () => workflow,
    prepare: async () => ({
      workflow,
      job: {
        parameters: { prompt: 'a red boat', stage: 'draft', seed: 4, width: 384, height: 256 },
        references: [],
        loras: [],
      },
      outputNodes: [],
    }),
  };
  const freed = [];
  const runtime = new ToolRuntime({
    catalog,
    engine: chat,
    gallery: { put: async record => record },
    getConfig: () => ({ enabled: true, autoAllow: true, maxIterations: 5, baseUrl: 'native' }),
    engineConfig: () => ({ modelPath: '', projectorPath: '' }),
    clientFactory: () => ({
      status: async () => ({ idle: true }),
      preflight: async () => {},
      run: async () => {
        events.push('generate');
        return { outputs: [{ filename: 'video.mp4', subfolder: '', type: 'output' }] };
      },
      free: async options => {
        freed.push(options);
        return { kept: Boolean(options?.keep) };
      },
    }),
    keepMs: 50,
  });
  const id = randomUUID();
  const request = await runtime.request(
    [
      {
        id: 'video-call',
        type: 'function',
        function: { name: 'create_video', arguments: JSON.stringify({ intention: 'Test' }) },
      },
    ],
    { conversationId: id, turnId: id, messages: [] },
  );
  assert.equal(request.autoAllow, false, 'its card asks the user');
  assert.ok(request.approvalToken);
  await assert.rejects(runtime.execute({ requestId: request.requestId, permission: 'once' }), /confirmation explicite/);
  await runtime.execute({ requestId: request.requestId, permission: 'once', approvalToken: request.approvalToken });
  await runtime.finished;
  assert.equal(runtime.status().state, 'done', runtime.status().error);
  assert.deepEqual(events, ['generate'], 'the remote model is neither stopped nor started again');
  assert.equal(chat.state, 'ready');
  assert.deepEqual(
    freed[0],
    { keep: true, signal: freed[0].signal },
    'the generator keeps its models for the next creation',
  );
  await runtime.close();
});

/** A Responses API and a sign-in of ChatGPT as far as Moodix uses them, on this computer. */
async function fakeChatGPT() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const seen = { authorize: null, responses: [], tokens: [], revoked: [] };
  let base = '',
    refreshes = 0;
  const idToken = claims => {
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })).toString('base64url'),
      body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8'),
      url = new URL(req.url, base);
    const json = (value, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/.well-known/openid-configuration')
      return json({ issuer: base, jwks_uri: `${base}/jwks`, revocation_endpoint: `${base}/revoke` });
    if (url.pathname === '/jwks') return json({ keys: [jwk] });
    if (url.pathname === '/revoke') {
      seen.revoked.push(Object.fromEntries(new URLSearchParams(text)));
      res.writeHead(200);
      return res.end();
    }
    if (url.pathname === '/api/accounts/oauth/token') {
      const form = Object.fromEntries(new URLSearchParams(text));
      seen.tokens.push(form);
      if (form.grant_type === 'authorization_code') {
        const asked = seen.authorize;
        const challenge = createHash('sha256').update(form.code_verifier).digest('base64url');
        if (
          form.code !== 'the-code' ||
          form.client_id !== 'oaiapp_test' ||
          challenge !== asked.get('code_challenge') ||
          form.redirect_uri !== asked.get('redirect_uri')
        )
          return json({ error: 'invalid_grant' }, 400);
        return json({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          id_token: idToken({
            iss: base,
            aud: 'oaiapp_test',
            sub: 'user-1',
            email: 'reader@example.com',
            nonce: asked.get('nonce'),
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke',
        });
      }
      if (form.refresh_token === 'refresh-gone') return json({ error: 'invalid_grant' }, 400);
      refreshes++;
      return json({
        access_token: `access-${refreshes + 1}`,
        refresh_token: `refresh-${refreshes + 1}`,
        expires_in: 3600,
      });
    }
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (url.pathname === '/v1/models')
      return json({
        models: [
          { slug: 'gpt-test', display_name: 'GPT Test', visibility: 'list' },
          { slug: 'internal', visibility: 'hide' },
        ],
      });
    if (url.pathname === '/v1/responses') {
      const body = JSON.parse(text);
      seen.responses.push({ body, token });
      if (!token?.startsWith('access-')) return json({ detail: 'no' }, 401);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      const last = body.input.at(-1);
      const asked =
        typeof last?.content === 'string'
          ? last.content
          : (last?.content?.find?.(part => part.type === 'input_text')?.text ?? '');
      if (asked.startsWith('generate') && body.tools?.[0]?.tools?.some(tool => tool.name === 'create_image')) {
        send({
          type: 'response.output_item.added',
          output_index: 1,
          item: {
            type: 'function_call',
            call_id: 'call_cloud_1',
            name: 'create_image',
            namespace: 'moodix',
            arguments: '',
          },
        });
        send({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"prompt":"A red' });
        send({ type: 'response.function_call_arguments.delta', output_index: 1, delta: ' boat"}' });
        send({
          type: 'response.output_item.added',
          output_index: 2,
          item: { type: 'function_call', call_id: 'call_cloud_2', name: 'create_image', arguments: '{}' },
        });
        send({ type: 'response.completed', response: { usage: { input_tokens: 120, output_tokens: 12 } } });
        return res.end();
      }
      send({ type: 'response.reasoning_summary_text.delta', delta: 'Je salue.' });
      send({ type: 'response.output_text.delta', delta: 'Bon' });
      send({ type: 'response.output_text.delta', delta: 'jour' });
      send({ type: 'response.completed', response: { usage: { input_tokens: 30, output_tokens: 2 } } });
      return res.end();
    }
    json({}, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    seen,
    account: (dataDir, options = {}) =>
      new ChatGPTAccount({
        dataDir,
        issuer: base,
        api: `${base}/v1`,
        openUrl: url => {
          seen.authorize = new URL(url).searchParams;
          seen.opened = url;
        },
        ...options,
      }),
    /** The browser coming back from the page of ChatGPT to the page of Moodix. */
    async back({ state = seen.authorize.get('state'), error } = {}) {
      const redirect = seen.authorize.get('redirect_uri');
      const query = error
        ? `error=${error}&state=${state}`
        : `code=the-code&state=${state}&client_id=oaiapp_test&scope=openid`;
      return fetch(`${redirect}?${query}`);
    },
    close() {
      server.closeAllConnections();
      return new Promise(resolve => server.close(resolve));
    },
  };
}

test('« Continuer avec ChatGPT »: the registration of the open-source way, the ID token checked, the tokens kept here', async t => {
  const data = await folder(t),
    fake = await fakeChatGPT();
  t.after(() => fake.close());
  let clock = Date.now();
  const account = fake.account(data, { now: () => clock });
  assert.deepEqual(await account.status(), { connected: false, email: '', plan: false, pending: false, error: '' });
  const { url } = await account.signIn();
  assert.equal(url, fake.seen.opened, 'the page of ChatGPT opens by itself');
  const asked = fake.seen.authorize;
  assert.equal(new URL(url).pathname, '/api/accounts/authorize');
  assert.deepEqual(
    ['client_id', 'agent_name_hint', 'response_type', 'scope', 'resource', 'code_challenge_method'].map(key =>
      asked.get(key),
    ),
    [
      'dynamic_agent_client',
      'Moodix',
      'code',
      'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      'https://api.openai.com/v1',
      'S256',
    ],
  );
  assert.match(asked.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  assert.match(asked.get('ext_agent_host_id'), /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal((await account.status()).pending, true);
  // A page of another attempt is refused; the sign-in still waits.
  assert.equal((await fake.back({ state: 'other' })).status, 400);
  const backed = await fake.back();
  assert.equal(backed.status, 200);
  assert.match(await backed.text(), /Moodix est connecté à votre compte ChatGPT/);
  assert.deepEqual(await account.status(), {
    connected: true,
    email: 'reader@example.com',
    plan: true,
    pending: false,
    error: '',
  });
  const kept = JSON.parse(await readFile(join(data, 'chatgpt-account.json'), 'utf8'));
  assert.deepEqual(
    [kept.client_id, kept.subject, kept.access_token, kept.ext_agent_host_id],
    ['oaiapp_test', 'user-1', 'access-1', asked.get('ext_agent_host_id')],
  );
  assert.deepEqual(await account.models(), [{ id: 'gpt-test', name: 'GPT Test' }]);

  // An answer: instructions, input, store false, no temperature nor length; read as chat completions.
  const answer = await account.respond(
    {
      messages: [
        { role: 'system', content: 'Tu es Moodix.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'bonjour' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ],
      stream: true,
      temperature: 0.7,
      max_tokens: 4096,
      chat_template_kwargs: { enable_thinking: false },
    },
    { model: 'gpt-test' },
  );
  const events = await chunksOf(answer.body);
  const sent = fake.seen.responses.at(-1).body;
  assert.deepEqual(
    [
      sent.model,
      sent.instructions,
      sent.store,
      sent.stream,
      sent.temperature,
      sent.max_output_tokens,
      sent.reasoning.effort,
    ],
    ['gpt-test', 'Tu es Moodix.', false, true, undefined, undefined, 'low'],
  );
  assert.deepEqual(sent.input[0].content, [
    { type: 'input_text', text: 'bonjour' },
    { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
  ]);
  assert.equal(events.map(event => event.choices?.[0]?.delta?.content ?? '').join(''), 'Bonjour');
  assert.equal(events.map(event => event.choices?.[0]?.delta?.reasoning_content ?? '').join(''), 'Je salue.');
  assert.deepEqual(events.at(-1).usage, { prompt_tokens: 30, completion_tokens: 2, total_tokens: 32 });

  // Close to its end, the token is renewed first (one renewal), and the new one used.
  clock += 3590_000;
  await chunksOf(
    (await account.respond({ messages: [{ role: 'user', content: 'encore' }], stream: true }, { model: 'gpt-test' }))
      .body,
  );
  assert.equal(fake.seen.responses.at(-1).token, 'access-2');
  assert.equal(fake.seen.tokens.at(-1).grant_type, 'refresh_token');
  assert.equal(fake.seen.tokens.at(-1).client_id, 'oaiapp_test');

  // Signed out: revoked at OpenAI, the tokens gone, the registration kept for the next sign-in.
  assert.deepEqual(await account.signOut(), { revoked: true });
  assert.equal(fake.seen.revoked[0].token, 'refresh-2');
  const after = JSON.parse(await readFile(join(data, 'chatgpt-account.json'), 'utf8'));
  assert.deepEqual([after.access_token, after.refresh_token, after.client_id], [undefined, undefined, 'oaiapp_test']);
  await account.signIn();
  assert.deepEqual(
    [fake.seen.authorize.get('client_id'), fake.seen.authorize.get('agent_name_hint')],
    ['oaiapp_test', null],
  );
  assert.equal((await fake.back({ error: 'access_denied' })).status, 400);
  assert.match((await account.status()).error, /Connexion refusée dans la page de ChatGPT/);
  await assert.rejects(
    account.respond({ messages: [{ role: 'user', content: 'x' }], stream: true }, { model: 'gpt-test' }),
    /Connectez-vous d’abord à ChatGPT/,
  );
  account.close();
});

test('the Responses events made the chunks the chat reads: one call of a tool, its end, a failure in words', async () => {
  const request = responsesRequest(
    {
      messages: [
        { role: 'system', content: 'Consignes' },
        { role: 'user', content: 'crée un bateau' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'create_image', arguments: '{"prompt":"boat"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"status":"success"}' },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'create_image', description: 'Crée une image', parameters: { type: 'object' } },
        },
      ],
    },
    'gpt-test',
  );
  assert.deepEqual(request.input.slice(1), [
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'create_image',
      namespace: 'moodix',
      arguments: '{"prompt":"boat"}',
    },
    { type: 'function_call_output', call_id: 'call_1', output: '{"status":"success"}' },
  ]);
  assert.equal(request.tools[0].type, 'namespace');
  assert.deepEqual(request.tools[0].tools[0], {
    type: 'function',
    name: 'create_image',
    description: 'Crée une image',
    parameters: { type: 'object' },
    strict: false,
  });
  assert.equal(request.parallel_tool_calls, false);

  const chunks = [];
  for await (const chunk of responseChunks(
    stream(
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', call_id: 'call_9', name: 'moodix.create_video', arguments: '' },
      },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"intention":' },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"Essai"}' },
      { type: 'response.completed', response: {} },
    ),
  ))
    chunks.push(chunk);
  const calls = [];
  for (const chunk of chunks) collectToolCalls(calls, chunk.choices[0]?.delta ?? {});
  assert.deepEqual(calls, [
    { id: 'call_9', type: 'function', function: { name: 'create_video', arguments: '{"intention":"Essai"}' } },
  ]);
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');

  await assert.rejects(
    (async () => {
      for await (const chunk of responseChunks(
        stream({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }),
      ))
        void chunk;
    })(),
    /limite d’utilisation de votre abonnement ChatGPT est atteinte/,
  );
  await assert.rejects(
    (async () => {
      for await (const chunk of responseChunks(stream({ type: 'response.output_text.delta', delta: 'coupé' })))
        void chunk;
    })(),
    /interrompue/,
  );
  assert.match(
    chatgptFailure(403, '{"error":{"code":"subscription_sharing_user_not_eligible"}}').message,
    /abonnement ChatGPT Plus ou Pro/,
  );
  assert.equal(chatgptFailure(401, '{"detail":"no"}').status, 502);
});

async function freePort() {
  const probe = netServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}
async function checkpoint(path, tensors) {
  let offset = 0;
  const header = {};
  for (const [key, shape] of Object.entries(tensors)) {
    const length = shape.reduce((a, b) => a * b, 1);
    header[key] = { dtype: 'I8', shape, data_offsets: [offset, offset + length] };
    offset += length;
  }
  const body = Buffer.from(JSON.stringify(header)),
    prefix = Buffer.alloc(8);
  prefix.writeBigUInt64LE(BigInt(body.length));
  const handle = await open(path, 'w');
  try {
    await handle.write(Buffer.concat([prefix, body]));
    await handle.truncate(8 + body.length + offset);
  } finally {
    await handle.close();
  }
}
/** Moodix with its generator replaced (one image per job) and a Krea 2 workflow ready. */
async function moodix(t, options = {}) {
  const root = await folder(t),
    outputDir = join(root, 'output');
  await mkdir(outputDir);
  const spawned = [],
    released = [];
  const worker = {
    state: 'stopped',
    status() {
      return { state: this.state, error: '', capabilities: { krea2: { ready: true, mediaType: 'image', reason: '' } } };
    },
    async unload() {},
    async start() {
      this.state = 'ready';
      return this.status();
    },
    async close() {
      this.state = 'stopped';
    },
    async release(...args) {
      released.push(args);
      return { released: true, allocatedGiB: 0, kept: false };
    },
    async request(method, job) {
      if (method !== 'generate') return {};
      const filename = randomUUID().replaceAll('-', '') + '.png';
      await writeFile(join(outputDir, filename), png);
      return {
        jobId: job.id,
        outputs: [{ filename, subfolder: '', type: 'output', width: 1, height: 1 }],
        metadata: {},
      };
    },
  };
  const app = await createApplication({
    fullPrompts: false,
    port: 0,
    dataDir: root,
    outputDir,
    generationWorker: worker,
    openUrl: () => {},
    // The local engine never starts here: a remote model answers.
    spawnProcess: (...args) => {
      spawned.push(args);
      throw Error('llama.cpp started');
    },
    ...options,
  });
  t.after(() => app.close());
  const boot = await (await fetch(app.url + '/api/bootstrap')).json();
  const api = async (path, body, status = 200) => {
    const response = await fetch(app.url + '/api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + boot.token, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.status, status, await response.clone().text());
    return response;
  };
  const tensors = {
    model: { 'first.weight': [6144, 64], 'blocks.0.attn.wq.weight': [6144, 6144] },
    textEncoder: { 'model.embed_tokens.weight': [1, 2560] },
    vae: { 'encoder.conv1.weight': [1, 3, 1, 1, 1], 'decoder.conv1.weight': [1, 16, 1, 1, 1] },
  };
  for (const [kind, shape] of Object.entries(tensors)) {
    const path = join(root, kind + '.safetensors');
    await checkpoint(path, shape);
    await api('generation/assets', { id: kind, path, kind, family: 'krea2' });
  }
  const tokenizer = join(root, 'tokenizer');
  await mkdir(tokenizer);
  await writeFile(join(tokenizer, 'tokenizer_config.json'), '{}');
  await writeFile(join(tokenizer, 'vocab.json'), '{"a":0}');
  await writeFile(join(tokenizer, 'merges.txt'), '');
  await api('generation/assets', { id: 'tokenizer', path: tokenizer, kind: 'tokenizer', family: 'krea2' });
  await api('generation/config', { enabled: true, autoAllow: false, maxIterations: 5, pythonPath: process.execPath });
  await api('generation/workflows', {
    schemaVersion: 1,
    id: 'remote-boat',
    name: 'Native image',
    description: 'Generate a red boat',
    enabled: true,
    pipeline: 'krea2',
    mediaType: 'image',
    components: Object.fromEntries(
      ['model', 'textEncoder', 'tokenizer', 'vae'].map(k => [k, { policy: 'fixed', asset: k }]),
    ),
    parameters: {
      prompt: { policy: 'model', type: 'string' },
      seed: { policy: 'fixed', value: 5 },
      width: { policy: 'fixed', value: 512 },
      height: { policy: 'fixed', value: 512 },
      steps: { policy: 'fixed', value: 8 },
      cfg: { policy: 'fixed', value: 1 },
      denoise: { policy: 'fixed', value: 1 },
    },
    loras: [],
    references: [],
  });
  const chat = async (text, extra = {}) =>
    (
      await (
        await api('chat', {
          messages: [{ role: 'user', content: text }],
          conversationId: extra.conversationId ?? randomUUID(),
          turnId: randomUUID(),
          ...extra,
        })
      ).text()
    )
      .split(/\r?\n\r?\n/)
      .filter(frame => frame.startsWith('data: ') && frame !== 'data: [DONE]')
      .map(frame => JSON.parse(frame.slice(6)));
  return { app, api, chat, spawned, released };
}

test(
  'a turn of the chat against a remote service with a key: the request it gets, an image made at once, llama.cpp never started',
  { timeout: 30000 },
  async t => {
    const port = await freePort(),
      key = 'sk-test-' + randomUUID();
    const service = spawn(
      process.execPath,
      [fixture, '--offline', '--host', '127.0.0.1', '--port', String(port), '--api-key', key],
      { stdio: 'ignore' },
    );
    t.after(() => service.kill());
    await until(async () => (await fetch(`http://127.0.0.1:${port}/health`).catch(() => null))?.status === 401);
    const { api, chat, spawned } = await moodix(t);
    const address = `http://127.0.0.1:${port}/v1`;

    // « Tester la connexion », a wrong key then the right one, and a server that is not there.
    assert.match(
      (
        await (
          await api('remote/test', { preset: 'custom', baseUrl: address, model: 'test-model', key: 'wrong' }, 502)
        ).json()
      ).error,
      /La clé d’API est refusée par 127\.0\.0\.1:/,
    );
    assert.deepEqual(
      await (await api('remote/test', { preset: 'custom', baseUrl: address, model: 'test-model', key })).json(),
      { ok: true, said: '' },
    );
    assert.match(
      (
        await (
          await api(
            'remote/test',
            { preset: 'custom', baseUrl: `http://127.0.0.1:${await freePort()}/v1`, model: 'm' },
            502,
          )
        ).json()
      ).error,
      /ne répond pas : le serveur est-il démarré/,
    );

    const { saved } = await (
      await api('remote/save', {
        preset: 'custom',
        name: 'Service de test',
        baseUrl: address,
        model: 'test-model',
        key,
        vision: true,
      })
    ).json();
    assert.equal(saved.hasKey, true);
    const view = await (await api('remote')).json();
    assert.equal(JSON.stringify(view).includes(key), false, 'the key never reaches the page');
    const { status } = await (await api('remote/select', { id: saved.id })).json();
    assert.deepEqual(
      [status.state, status.remote.name, status.remote.model, status.remote.leaves],
      ['ready', 'Service de test', 'test-model', false],
    );

    // What the service gets: its model, without the fields of llama.cpp, with the tools of Moodix.
    const payload = (await chat('inspect tool context')).find(event => event.local_test_payload).local_test_payload;
    assert.equal(payload.model, 'test-model');
    for (const field of ['reasoning_format', 'chat_template_kwargs', 'top_k'])
      assert.equal(field in payload, false, field);
    assert.ok(payload.tools.some(tool => tool.function.name === 'create_image'));
    assert.deepEqual((await chat('bonjour')).map(event => event.choices?.[0]?.delta?.content).filter(Boolean), [
      'Ordinary chat, no generation.',
    ]);

    // An image is proposed and made at once (no card in the chat for an image), the model still there.
    const conversationId = randomUUID();
    const proposal = (await chat('generate a boat', { conversationId })).find(
      event => event.local_tool_request,
    ).local_tool_request;
    assert.equal(proposal.call.function.name, 'create_image');
    assert.equal(proposal.mediaType ?? 'image', 'image');
    // Run without its token: an image does not ask for the consent a video asks for.
    await api('tools/execute', { requestId: proposal.requestId, permission: 'once' }, 202);
    const job = await until(async () => {
      const current = await (await api('tools/job')).json();
      return current && ['done', 'error'].includes(current.state) && current;
    });
    assert.equal(job.state, 'done', job.error);
    const after = await (await api('status')).json();
    assert.deepEqual([after.state, after.remote?.id], ['ready', saved.id]);
    assert.equal(spawned.length, 0, 'llama.cpp was never started');
    // The context counted from the length of what is sent, as a remote service has no route for it.
    const counted = await (await api('context', { messages: [{ role: 'user', content: 'bonjour' }] })).json();
    assert.deepEqual([counted.capacity, counted.precision], [131072, 'rough']);
    assert.ok(counted.used > 0);

    // Back to the local model: the connection stays in the list.
    await api('remote/select', { id: null });
    assert.equal((await (await api('status')).json()).remote, null);
    assert.equal((await (await api('remote')).json()).connections.length, 1);
  },
);

test(
  'a turn of the chat with the ChatGPT plan: signed in, a model chosen, a call of a tool read from the Responses stream',
  { timeout: 30000 },
  async t => {
    const fake = await fakeChatGPT();
    t.after(() => fake.close());
    // A ChatGPT account against the fake server, given to the application.
    const data = await folder(t);
    const account = fake.account(data);
    const made = await moodix(t, { chatgpt: account });
    await made.api('remote/chatgpt/start', {});
    assert.equal((await made.api('remote').then(response => response.json())).chatgpt.pending, true);
    assert.equal((await fake.back()).status, 200);
    const view = await (await made.api('remote')).json();
    assert.deepEqual([view.chatgpt.connected, view.chatgpt.email], [true, 'reader@example.com']);
    assert.deepEqual((await (await made.api('remote/models', { preset: 'chatgpt' })).json()).models, [
      { id: 'gpt-test', name: 'GPT Test' },
    ]);
    const { saved } = await (
      await made.api('remote/save', { preset: 'chatgpt', name: 'ChatGPT', model: 'gpt-test', vision: true })
    ).json();
    const { status } = await (await made.api('remote/select', { id: saved.id })).json();
    assert.deepEqual(
      [status.remote.kind, status.remote.host, status.remote.leaves, status.remote.thinking],
      ['chatgpt', 'api.openai.com', true, true],
    );
    assert.equal(JSON.stringify(view).includes('access-1'), false, 'no token reaches the page');

    const said = await made.chat('bonjour');
    assert.equal(said.map(event => event.choices?.[0]?.delta?.content ?? '').join(''), 'Bonjour');
    const proposal = (await made.chat('generate a boat')).find(event => event.local_tool_request).local_tool_request;
    assert.equal(proposal.call.function.name, 'create_image');
    assert.equal(proposal.call.id, 'call_cloud_1', 'the first call only');
    assert.equal(JSON.parse(proposal.call.function.arguments).prompt, 'A red boat');
    const sent = fake.seen.responses.at(-1).body;
    assert.equal(sent.tools[0].name, 'moodix');
    assert.equal(made.spawned.length, 0);
  },
);
