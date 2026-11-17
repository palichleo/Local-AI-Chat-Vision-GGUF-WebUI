import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createApplication } from '../server.mjs';
import { RemoteModels } from '../lib/remote-models.mjs';
import { FREE_ROUTER, OpenRouterSignIn, exchangeFailure } from '../lib/openrouter.mjs';
import { OPENROUTER_NOTICE, setupRemoteModels } from '../public/remote-llm-ui.mjs';

/**
 * « Se connecter à OpenRouter » (0.6.37): a key of the user's account made by the OAuth PKCE way of
 * OpenRouter, kept as a pasted key, then its model chosen in the editor. Everything here talks to
 * a fake OpenRouter on 127.0.0.1: nothing calls the real one.
 */
const folder = async t => {
  const path = await mkdtemp(join(tmpdir(), 'moodix-openrouter-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
};
const hasIPv6Loopback = () =>
  Object.values(networkInterfaces())
    .flat()
    .some(item => item?.address === '::1');

/**
 * A fake OpenRouter: its page of consent (/auth) sends the browser back at once, as the user's
 * « Authorize » would (or as a refusal, without code nor state); /api/v1/auth/keys gives a key for
 * the code and the verifier of its challenge, once; the models and the chat need that key.
 */
async function fakeOpenRouter() {
  const seen = { authorize: null, exchanges: [], chats: [], listed: [] };
  const issued = new Map();
  let base = '',
    answer = 'consent',
    refusal = null;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8'),
      url = new URL(req.url, base);
    const json = (value, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/auth' && req.method === 'GET') {
      seen.authorize = url.searchParams;
      const back = new URL(url.searchParams.get('callback_url'));
      if (answer === 'consent') {
        const code = 'code-' + randomUUID();
        issued.set(code, { challenge: url.searchParams.get('code_challenge'), used: false });
        back.searchParams.set('code', code);
        back.searchParams.set('state', url.searchParams.get('state'));
      }
      res.writeHead(302, { Location: back.href });
      return res.end();
    }
    const key = req.headers.authorization?.replace(/^Bearer /, '');
    if (url.pathname === '/api/v1/auth/keys' && req.method === 'POST') {
      const body = JSON.parse(text);
      seen.exchanges.push(body);
      if (refusal) return json(refusal.body, refusal.status);
      const code = issued.get(body.code),
        challenge = createHash('sha256').update(String(body.code_verifier)).digest('base64url');
      if (body.code_challenge_method !== 'S256')
        return json({ error: { message: 'Invalid code_challenge_method' } }, 400);
      if (!code || code.used || code.challenge !== challenge)
        return json({ error: { message: 'Invalid code or code_verifier' } }, 403);
      code.used = true;
      const made = 'sk-or-v1-' + randomBytes(32).toString('hex');
      seen.key = made;
      return json({ key: made, user_id: 'user_test' });
    }
    if (key !== seen.key) return json({ error: { message: 'No auth credentials found', code: 401 } }, 401);
    if (url.pathname === '/api/v1/models') {
      seen.listed.push(key);
      return json({ data: [{ id: 'paid/model' }, { id: FREE_ROUTER }, { id: 'open/model:free' }] });
    }
    if (url.pathname === '/api/v1/chat/completions' && req.method === 'POST') {
      const body = JSON.parse(text);
      seen.chats.push(body);
      if (!body.stream)
        return json({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const chunk of [
        { choices: [{ index: 0, delta: { role: 'assistant', content: 'Bon' } }] },
        { choices: [{ index: 0, delta: { content: 'jour' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } },
      ])
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    json({ error: { message: 'Not found' } }, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    api: `${base}/api/v1`,
    seen,
    /** What the user does in the page of consent: accept, refuse. */
    answer(value) {
      answer = value;
    },
    /** The exchange refused as OpenRouter says it (status and body), or accepted again (null). */
    refuse(value) {
      refusal = value;
    },
    /** The browser opening the page of consent and following it back to Moodix. */
    browse: url => fetch(url, { redirect: 'follow' }),
    close() {
      server.closeAllConnections();
      return new Promise(resolve => server.close(resolve));
    },
  };
}

test('the sign-in asks OpenRouter by its PKCE way and comes back to localhost, on 127.0.0.1 and ::1', async t => {
  const data = await folder(t),
    fake = await fakeOpenRouter();
  t.after(() => fake.close());
  const remotes = new RemoteModels(data);
  let opened = '';
  const sign = new OpenRouterSignIn({ remotes, site: fake.base, api: fake.api, openUrl: url => (opened = url) });
  t.after(() => sign.close());
  assert.deepEqual(sign.status(), { pending: false, error: '', created: null });

  const { url } = await sign.start();
  assert.equal(url, opened, 'the page of OpenRouter opens by itself');
  const asked = new URL(url);
  assert.equal(`${asked.origin}${asked.pathname}`, `${fake.base}/auth`);
  assert.deepEqual([...asked.searchParams.keys()].sort(), [
    'callback_url',
    'code_challenge',
    'code_challenge_method',
    'key_label',
    'state',
  ]);
  assert.equal(asked.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(asked.searchParams.get('key_label'), 'Moodix');
  // SHA-256 in base64url, without padding: 43 characters. The verifier never leaves this computer.
  assert.match(asked.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  const callback = new URL(asked.searchParams.get('callback_url'));
  assert.equal(callback.protocol + '//' + callback.hostname, 'http://localhost', 'the address OpenRouter accepts');
  assert.equal(callback.pathname, '/openrouter/callback');
  assert.equal(sign.status().pending, true);

  // Where a browser may look for localhost: both answer (another path is not found).
  assert.equal((await fetch(`http://127.0.0.1:${callback.port}/other`)).status, 404);
  if (hasIPv6Loopback()) assert.equal((await fetch(`http://[::1]:${callback.port}/other`)).status, 404);
  // A page of another attempt is refused; the sign-in still waits, nothing exchanged.
  const stale = await fetch(`${callback.href}?code=x&state=other`);
  assert.equal(stale.status, 400);
  assert.match(await stale.text(), /ne correspond plus à une demande de Moodix/);
  assert.equal(sign.status().pending, true);
  assert.equal(fake.seen.exchanges.length, 0);

  // Accepted in the page of OpenRouter: the code and its verifier are exchanged once for a key.
  const back = await fake.browse(url);
  assert.equal(back.status, 200);
  assert.match(await back.text(), /Moodix est connecté à votre compte OpenRouter/);
  const [exchange] = fake.seen.exchanges;
  assert.deepEqual(Object.keys(exchange).sort(), ['code', 'code_challenge_method', 'code_verifier']);
  assert.equal(
    createHash('sha256').update(exchange.code_verifier).digest('base64url'),
    asked.searchParams.get('code_challenge'),
  );
  const status = sign.status();
  assert.deepEqual([status.pending, status.error], [false, '']);

  // Kept as a pasted key would be: apart, never in the list; the free router until a model is chosen.
  const { connections } = await remotes.list();
  assert.equal(connections.length, 1);
  const [made] = connections;
  assert.deepEqual(
    [made.id, made.preset, made.name, made.baseUrl, made.model, made.hasKey],
    [status.created, 'openrouter', 'OpenRouter', fake.api, FREE_ROUTER, true],
  );
  assert.equal(JSON.stringify(connections).includes(fake.seen.key), false);
  assert.equal((await remotes.get(made.id)).key, fake.seen.key);
  assert.equal(JSON.parse(await readFile(join(data, 'remote-llm-keys.json'), 'utf8'))[made.id], fake.seen.key);
  assert.equal(
    (await readFile(join(data, 'remote-llms.json'), 'utf8')).includes(fake.seen.key),
    false,
    'the key is not written beside the connection',
  );
  // Done: the page of Moodix no longer listens.
  await assert.rejects(fetch(`${callback.href}?code=x&state=${asked.searchParams.get('state')}`));
});

test('a refusal, an expired code or a cancelled sign-in saves nothing and says why', async t => {
  const data = await folder(t),
    fake = await fakeOpenRouter();
  t.after(() => fake.close());
  const remotes = new RemoteModels(data);
  const sign = new OpenRouterSignIn({ remotes, site: fake.base, api: fake.api });
  t.after(() => sign.close());

  // Refused in the page of OpenRouter: it comes back without code nor state.
  fake.answer('refuse');
  let back = await fake.browse((await sign.start()).url);
  assert.equal(back.status, 400);
  assert.match(await back.text(), /Connexion refusée dans la page d’OpenRouter/);
  assert.deepEqual(sign.status(), {
    pending: false,
    error: 'Connexion refusée dans la page d’OpenRouter : aucune clé n’a été créée.',
    created: null,
  });
  assert.equal(fake.seen.exchanges.length, 0);

  // Accepted, but the code given too late: the words of OpenRouter turned into the user's.
  fake.answer('consent');
  fake.refuse({ status: 403, body: { error: { message: 'Authorization code expired' } } });
  back = await fake.browse((await sign.start()).url);
  assert.equal(back.status, 400);
  assert.match(sign.status().error, /Le code de connexion d’OpenRouter a expiré/);
  assert.equal(sign.status().pending, false);

  // A new attempt clears what stopped the last one.
  fake.refuse(null);
  const { url } = await sign.start();
  assert.deepEqual(sign.status(), { pending: true, error: '', created: null });
  // Cancelled before coming back: its page no longer listens, nothing is exchanged.
  sign.cancel();
  assert.equal(sign.status().pending, false);
  await assert.rejects(fake.browse(url));
  assert.equal((await remotes.list()).connections.length, 0);
  assert.equal(fake.seen.exchanges.length, 1, 'only the expired code was sent');

  // A sign-in started again replaces the one waiting: the first page is no longer listened to.
  const first = new URL(new URL((await sign.start()).url).searchParams.get('callback_url'));
  const second = new URL(new URL((await sign.start()).url).searchParams.get('callback_url'));
  if (first.port !== second.port) await assert.rejects(fetch(`${first.origin}/openrouter/callback`));
  assert.equal(sign.status().pending, true);
});

test('a refusal of the exchange in the user’s words', () => {
  assert.match(exchangeFailure(403, '{"error":{"message":"Invalid code or code_verifier"}}').message, /refuse le code/);
  assert.match(exchangeFailure(403, { error: { message: 'Authorization code expired' } }).message, /a expiré/);
  assert.match(exchangeFailure(503, '').message, /ne répond pas pour l’instant \(erreur 503\)/);
  assert.match(exchangeFailure(405, 'Method Not Allowed').message, /erreur 405\) \(Method Not Allowed\)/);
  // Always a 502: the page would take a 401 or a 403 for its own token.
  assert.deepEqual(
    [403, 400, 500].map(status => exchangeFailure(status, '').status),
    [502, 502, 502],
  );
});

test(
  '« Se connecter à OpenRouter » in Moodix: the connection made, its model chosen, a turn of the chat with its key',
  { timeout: 30000 },
  async t => {
    const fake = await fakeOpenRouter();
    t.after(() => fake.close());
    const dataDir = await folder(t),
      spawned = [];
    await mkdir(join(dataDir, 'output'));
    let opened = '';
    const app = await createApplication({
      port: 0,
      dataDir,
      outputDir: join(dataDir, 'output'),
      openUrl: url => (opened = url),
      openrouter: { site: fake.base, api: fake.api },
      spawnProcess: (...args) => {
        spawned.push(args);
        throw Error('llama.cpp started');
      },
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
      return response.json();
    };

    assert.deepEqual((await api('remote')).openrouter, { pending: false, error: '', created: null });
    const { url } = await api('remote/openrouter/start', {});
    assert.equal(url, opened);
    assert.equal((await api('remote')).openrouter.pending, true);
    // The browser comes back from OpenRouter.
    assert.equal((await fake.browse(url)).status, 200);
    const view = await api('remote');
    assert.equal(view.openrouter.pending, false);
    const made = view.connections.find(item => item.id === view.openrouter.created);
    assert.deepEqual(
      [made.preset, made.baseUrl, made.model, made.hasKey, view.active],
      ['openrouter', fake.api, FREE_ROUTER, true, null],
    );
    assert.equal(JSON.stringify(view).includes(fake.seen.key), false, 'the key never reaches the page');

    // Chosen for the chat (its line in the settings, 0.6.38), then its model in the bar of the chat:
    // its models listed with the kept key, the free ones first.
    const chosen = await api('remote/provider', { provider: 'openrouter' });
    assert.deepEqual(
      [chosen.status.state, chosen.status.remote.name, chosen.status.remote.model, chosen.active],
      ['ready', 'OpenRouter', FREE_ROUTER, made.id],
    );
    const { options } = await api('remote/options');
    assert.deepEqual(
      options.models.map(item => item.id),
      [FREE_ROUTER, 'open/model:free', 'paid/model'],
    );
    assert.deepEqual(fake.seen.listed, [fake.seen.key]);
    const { status } = await api('remote/choice', { model: 'open/model:free' });
    assert.deepEqual(
      [status.state, status.remote.name, status.remote.model],
      ['ready', 'OpenRouter', 'open/model:free'],
    );
    assert.equal(
      (await api('remote/choice', { model: 'unknown/model' }, 400)).error,
      'Ce modèle n’est pas proposé par ce service.',
    );
    // Signed in again: the same connection, its model kept, its key replaced.
    const again = await api('remote/openrouter/start', {});
    assert.equal((await fake.browse(again.url)).status, 200);
    const after = await api('remote');
    assert.equal(after.connections.length, 1);
    assert.deepEqual([after.connections[0].id, after.connections[0].model], [made.id, 'open/model:free']);

    // A turn of the chat: answered by the model chosen, with the key OpenRouter gave.
    const frames = await fetch(app.url + '/api/chat', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + boot.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'bonjour' }],
        conversationId: randomUUID(),
        turnId: randomUUID(),
      }),
    }).then(response => response.text());
    const events = frames
      .split(/\r?\n\r?\n/)
      .filter(frame => frame.startsWith('data: ') && frame !== 'data: [DONE]')
      .map(frame => JSON.parse(frame.slice(6)));
    assert.equal(events.map(event => event.choices?.[0]?.delta?.content ?? '').join(''), 'Bonjour');
    assert.equal(fake.seen.chats.at(-1).model, 'open/model:free');
    assert.equal(spawned.length, 0, 'llama.cpp was never started');
    // Signed out: the key goes from this computer, the chat comes back to the local model.
    const gone = await api('remote/forget', { provider: 'openrouter' });
    assert.deepEqual([gone.connections.length, gone.active, gone.status.remote], [0, null, null]);
    await assert.rejects(readFile(join(dataDir, 'remote-llm-keys.json'), 'utf8'));
  },
);

/** The few elements setupRemoteModels touches, without a browser. */
function fakePage() {
  const elements = new Map();
  const element = () => ({
    hidden: false,
    disabled: false,
    open: false,
    value: '',
    checked: false,
    placeholder: '',
    href: '',
    textContent: '',
    focused: false,
    children: [],
    classList: { toggle() {} },
    listeners: {},
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
    replaceChildren(...children) {
      this.children = children;
    },
    append(...children) {
      this.children.push(...children);
    },
    setAttribute() {},
    focus() {
      this.focused = true;
    },
  });
  const $ = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const node = (tag, className = '', text = '') => Object.assign(element(), { tag, className, textContent: text });
  return { $, node, icon: () => element() };
}

test('the line of OpenRouter in the settings: told first what the key is, then chosen for the chat once back', async () => {
  const { $, node, icon } = fakePage();
  const made = {
    id: randomUUID(),
    name: 'OpenRouter',
    preset: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: FREE_ROUTER,
    vision: false,
    contextSize: 131072,
    hasKey: true,
  };
  const presets = {
    openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', key: true },
    custom: { name: 'Autre', baseUrl: '', key: false },
  };
  let server = {
    connections: [],
    active: null,
    presets,
    chatgpt: {},
    openrouter: { pending: false, error: '' },
    claude: { library: 'ready', error: '' },
  };
  const calls = [],
    asked = [],
    statuses = [];
  let accept = false;
  const api = async (path, body) => {
    calls.push([path, body]);
    if (path === 'remote/openrouter/start') {
      // Back from OpenRouter before the page asks again.
      server = { ...server, connections: [made], openrouter: { pending: false, error: '', created: made.id } };
      return Response.json({ url: 'https://openrouter.ai/auth?state=x' });
    }
    if (path === 'remote/provider') {
      server = { ...server, active: made.id };
      return Response.json({
        ...server,
        status: { state: 'ready', remote: { id: made.id, name: 'OpenRouter', model: FREE_ROUTER } },
      });
    }
    if (path === 'remote') return Response.json(server);
    throw Error('unexpected ' + path);
  };
  const remote = setupRemoteModels({
    $,
    api,
    node,
    icon,
    confirmFn: text => {
      asked.push(text);
      return accept;
    },
    onStatus: status => statuses.push(status),
  });
  await remote.load();
  // ChatGPT, Claude, OpenRouter, in that order; no name nor model to write.
  const line = () => remote.rows(false)[2];
  assert.deepEqual(
    remote.rows(false).map(row => row.children[0].children[1].children[0].textContent),
    ['ChatGPT', 'Claude', 'OpenRouter'],
  );
  assert.match(line().children[0].children[2].textContent, /sans copier de clé/);

  // Told before anything opens: a key of their OpenRouter account, kept on this computer.
  line().children[0].onclick();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(asked, [OPENROUTER_NOTICE]);
  assert.match(OPENROUTER_NOTICE, /clé d’API de votre compte/);
  assert.match(OPENROUTER_NOTICE, /gardée sur cet ordinateur/);
  assert.match(OPENROUTER_NOTICE, /dépense vos crédits OpenRouter/);
  assert.equal(calls.filter(([path]) => path === 'remote/openrouter/start').length, 0, 'declined: nothing opens');

  // Accepted: back from OpenRouter, the provider is chosen for the chat at once.
  accept = true;
  line().children[0].onclick();
  for (let i = 0; i < 100 && !calls.some(([path]) => path === 'remote/provider'); i++)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(calls.find(([path]) => path === 'remote/provider')[1], { provider: 'openrouter' });
  assert.equal(statuses.at(-1).remote.id, made.id);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.match(line().className, /is-chosen/);
  assert.match(line().children[0].children[2].textContent, /Connecté/);
  // Its action now: to sign out.
  assert.deepEqual(
    line().children[1].children.map(item => item.textContent),
    ['Se déconnecter'],
  );
});
