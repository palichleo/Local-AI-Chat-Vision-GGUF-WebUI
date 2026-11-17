import http from 'node:http';
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson } from './update-files.mjs';
import { problem } from './engine.mjs';
import { networkFailure, sseOf } from './chat-model.mjs';

/**
 * « Continuer avec ChatGPT »: the chat model answered with the ChatGPT plan of the user (Plus or
 * Pro), without an API key. The way OpenAI opens to applications run on the computer of their
 * user (developers.openai.com/siwc, « ChatGPT plan usage in your open-source app »): Moodix
 * registers itself in the account at the first sign-in (dynamic_agent_client), the browser comes
 * back to a page of Moodix on 127.0.0.1, the tokens stay in the data folder. Answers come from
 * the Responses API (POST /v1/responses, store false, stream true), turned here into the chat
 * completions the rest of Moodix reads.
 */
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PLAN = 'chatgpt.tokens.use.direct';
const RESOURCE = 'https://api.openai.com/v1';
// The tools of Moodix, grouped as this way asks (« group function tools in namespaces »).
export const NAMESPACE = 'moodix';
const SIGN_IN_MS = 10 * 60_000;
const base64url = bytes => Buffer.from(bytes).toString('base64url');
const short = text =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);

/** The page the browser shows once back from ChatGPT (or OpenRouter, lib/openrouter.mjs). */
export function page(res, status, message) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'Referrer-Policy': 'no-referrer',
    Connection: 'close',
  });
  const escaped = message.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
  res.end(
    `<!doctype html><html lang="fr"><meta charset="utf-8"><title>Moodix</title>` +
      `<body style="font:16px/1.5 system-ui,sans-serif;background:#0f0e0d;color:#eee8de;display:grid;place-items:center;min-height:100vh;margin:0">` +
      `<p style="max-width:32em;padding:0 24px">${escaped}</p></body></html>`,
  );
}

/** A refusal of the Responses API for a ChatGPT plan, in the user's words (always a 502 for the page). */
export function chatgptFailure(status, said) {
  let code = '',
    message = '';
  try {
    const body = typeof said === 'string' ? JSON.parse(said) : said;
    code = body?.error?.code ?? body?.code ?? '';
    message = body?.error?.message ?? body?.message ?? (typeof body?.detail === 'string' ? body.detail : '');
  } catch {
    message = short(said);
  }
  const known = {
    subscription_sharing_user_not_eligible:
      'Votre compte ChatGPT ne peut pas servir ici : il faut un abonnement ChatGPT Plus ou Pro.',
    subscription_sharing_usage_limit_exceeded:
      'La limite d’utilisation de votre abonnement ChatGPT est atteinte. Voyez chatgpt.com › Paramètres › Utilisation, ou attendez un peu.',
    subscription_sharing_usage_unavailable:
      'ChatGPT ne peut pas vérifier votre utilisation pour l’instant. Réessayez dans un moment.',
    subscription_sharing_invalid_user:
      'ChatGPT ne reconnaît plus cette connexion : reconnectez-vous dans Paramètres › Moodix AI.',
    subscription_sharing_user_unavailable:
      'Votre compte ChatGPT est momentanément indisponible. Réessayez dans un moment.',
    subscription_sharing_route_not_supported:
      'ChatGPT refuse cette demande pour un abonnement (route non prise en charge).',
  };
  const told = message ? ` (${short(message)})` : '';
  if (known[code]) return problem(known[code], 502);
  if (/rate_limit|too_many_requests/.test(code))
    return problem(`Trop de demandes à ChatGPT en peu de temps${told}. Attendez un peu, puis réessayez.`, 502);
  if (/reasoning|effort/i.test(`${code} ${message}`) && [0, 400].includes(status))
    return problem(
      `Ce modèle de ChatGPT ne prend pas la force de réflexion choisie${told} : choisissez-en une autre dans la barre du chat.`,
      502,
    );
  if (status === 401)
    return problem('ChatGPT n’accepte plus cette connexion : reconnectez-vous dans Paramètres › Moodix AI.', 502);
  if (status === 403) return problem(`ChatGPT refuse l’accès${told}.`, 502);
  if (status === 404)
    return problem(
      `Modèle indisponible pour votre compte ChatGPT${told} : choisissez-en un autre dans la barre du chat.`,
      502,
    );
  if (status === 429)
    return problem(
      'La limite d’utilisation de votre abonnement ChatGPT est atteinte. Voyez chatgpt.com › Paramètres › Utilisation, ou attendez un peu.',
      502,
    );
  if (status >= 500)
    return problem(
      `Le service ChatGPT ne répond pas pour l’instant (erreur ${status}). Réessayez dans un moment.`,
      502,
    );
  return problem(`ChatGPT refuse la demande${status ? ` (erreur ${status})` : ''}${told}.`, 502);
}

const textOf = content =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter(part => part?.type === 'text')
          .map(part => part.text)
          .join('\n')
      : '';

/**
 * A request of the chat (chat completions, as chatPayload makes it) as the Responses API takes it
 * for a ChatGPT plan: the first system message as `instructions`, the conversation as `input`
 * (calls and their results as items of their own), the tools in a namespace. No temperature, no
 * length of answer: this way refuses them.
 */
export function responsesRequest(body, model, effort = '') {
  const messages = [...body.messages];
  const instructions = messages[0]?.role === 'system' ? textOf(messages.shift().content) : '';
  const input = [];
  for (const message of messages) {
    if (message.role === 'system') input.push({ role: 'developer', content: textOf(message.content) });
    else if (message.role === 'user')
      input.push({
        role: 'user',
        content:
          typeof message.content === 'string'
            ? message.content
            : message.content.map(part =>
                part.type === 'image_url'
                  ? { type: 'input_image', image_url: part.image_url.url, detail: 'auto' }
                  : { type: 'input_text', text: part.text },
              ),
      });
    else if (message.role === 'assistant') {
      const said = textOf(message.content);
      if (said) input.push({ role: 'assistant', content: said });
      for (const call of message.tool_calls ?? [])
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          namespace: NAMESPACE,
          arguments: call.function.arguments,
        });
    } else if (message.role === 'tool')
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: textOf(message.content) });
  }
  const thinking = body.chat_template_kwargs?.enable_thinking;
  return {
    model,
    ...(instructions ? { instructions } : {}),
    input,
    store: false,
    stream: true,
    ...(body.tools?.length
      ? {
          tools: [
            {
              type: 'namespace',
              name: NAMESPACE,
              description: 'Les outils de Moodix : créer des images, des vidéos et des sons, regarder les références.',
              tools: body.tools.map(tool => ({
                type: 'function',
                name: tool.function.name,
                description: tool.function.description,
                parameters: tool.function.parameters,
                strict: false,
              })),
            },
          ],
          tool_choice: 'auto',
          parallel_tool_calls: false,
        }
      : {}),
    // The effort chosen in the bar of the chat; the lowest for a quick decision of the chat (no
    // reflection asked); its summary shown when there is one.
    reasoning: {
      ...(thinking === false ? { effort: 'low' } : effort ? { effort } : {}),
      summary: 'auto',
    },
  };
}
/**
 * The same request without what a model may not take: the choice of its tools, the summary of its
 * reflection. The effort the user chose stays (dropped in silence, the bar of the chat would say a
 * force the model does not use): a model that refuses it is said so.
 */
export function lighterRequest(request) {
  const { reasoning, tool_choice, parallel_tool_calls, ...rest } = request;
  return reasoning?.effort ? { ...rest, reasoning: { effort: reasoning.effort } } : rest;
}

/**
 * The events of a Responses stream as chunks of chat completions: the words, the summary of the
 * reflection, the first call of a tool, the end and its usage. A failure is thrown in the user's
 * words; a stream cut before its end too.
 */
export async function* responseChunks(stream) {
  const reader = stream.getReader(),
    decoder = new TextDecoder();
  let buffer = '',
    ended = false,
    called = false;
  const calls = new Map();
  const say = delta => ({ choices: [{ index: 0, delta }] });
  function* translate(event) {
    switch (event?.type) {
      case 'response.output_text.delta':
        if (event.delta) yield say({ content: event.delta });
        return;
      case 'response.reasoning_summary_part.added':
        if (event.summary_index > 0) yield say({ reasoning_content: '\n\n' });
        return;
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (event.delta) yield say({ reasoning_content: event.delta });
        return;
      case 'response.output_item.added': {
        const item = event.item;
        // One generation at a time: a second call in the same answer is left.
        if (item?.type !== 'function_call' || called) return;
        called = true;
        calls.set(event.output_index, item);
        const name = String(item.name ?? '').replace(new RegExp(`^${NAMESPACE}[.:]`), '');
        yield say({
          tool_calls: [
            { index: 0, id: item.call_id, type: 'function', function: { name, arguments: item.arguments ?? '' } },
          ],
        });
        return;
      }
      case 'response.function_call_arguments.delta':
        if (calls.has(event.output_index) && event.delta)
          yield say({ tool_calls: [{ index: 0, function: { arguments: event.delta } }] });
        return;
      case 'response.completed':
      case 'response.incomplete': {
        ended = true;
        const cut = event.type === 'response.incomplete';
        yield { choices: [{ index: 0, delta: {}, finish_reason: cut ? 'length' : called ? 'tool_calls' : 'stop' }] };
        const usage = event.response?.usage;
        if (Number.isSafeInteger(usage?.input_tokens) && Number.isSafeInteger(usage?.output_tokens))
          yield {
            choices: [],
            usage: {
              prompt_tokens: usage.input_tokens,
              completion_tokens: usage.output_tokens,
              total_tokens: usage.input_tokens + usage.output_tokens,
            },
          };
        return;
      }
      case 'response.failed':
        throw chatgptFailure(0, { error: event.response?.error ?? {} });
      case 'error':
        throw chatgptFailure(0, { error: { code: event.code, message: event.message } });
    }
  }
  try {
    while (!ended) {
      let read;
      try {
        read = await reader.read();
      } catch (error) {
        // The connection cut in the middle of the answer: said, not as « terminated ».
        if (error?.name === 'AbortError') throw error;
        throw problem('La connexion à ChatGPT a été coupée pendant la réponse. La réponse reçue est conservée.', 502);
      }
      const { value, done } = read;
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 4 * 1024 * 1024) throw problem('Une trame de la réponse de ChatGPT est trop grande.', 502);
      let match;
      while (!ended && (match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = block
          .split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n');
        if (!data || data === '[DONE]') continue;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          throw problem('La réponse de ChatGPT est illisible.', 502);
        }
        yield* translate(event);
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!ended) throw problem('La réponse de ChatGPT a été interrompue. La réponse reçue est conservée.', 502);
}

// The efforts of reflection a model of the account takes when its listing does not say them.
export const CHATGPT_EFFORTS = Object.freeze(['low', 'medium', 'high']);

export class ChatGPTAccount {
  constructor({
    dataDir,
    fetchImpl = fetch,
    issuer = 'https://auth.openai.com',
    api = RESOURCE,
    // The name the user sees in the page of ChatGPT that asks for their consent.
    appName = 'Moodix',
    // Opens the page of ChatGPT in the browser of the system.
    openUrl = () => {},
    now = () => Date.now(),
  }) {
    Object.assign(this, { fetchImpl, issuer, api, appName, openUrl, now });
    // Owner only, never sent to the page nor written in a journal (developers.openai.com/siwc).
    this.file = join(dataDir, 'chatgpt-account.json');
    this.pending = null;
    this.lastError = '';
    this.refreshing = null;
    this.discovery = null;
  }
  async #record() {
    try {
      const record = JSON.parse(await readFile(this.file, 'utf8'));
      return record && typeof record === 'object' && !Array.isArray(record) ? record : {};
    } catch {
      return {};
    }
  }
  async #save(record) {
    await atomicJson(this.file, record);
  }
  /** What the settings show: connected or not, the email of the account, whether its plan may be used. */
  async status() {
    const record = await this.#record(),
      connected = Boolean(record.refresh_token || record.access_token);
    return {
      connected,
      // Signed out, no account is named.
      email: connected ? record.email || '' : '',
      plan: Array.isArray(record.scopes) && record.scopes.includes(PLAN),
      pending: Boolean(this.pending),
      error: this.lastError,
    };
  }
  /**
   * Starts the sign-in: a page of Moodix listens on 127.0.0.1 for the browser coming back, and the
   * page of ChatGPT opens. { url } for the settings, which offer it again if no browser opened.
   */
  signIn() {
    // Asked twice (a double click): the one sign-in being prepared, not a second page of Moodix
    // listening with its own timer.
    this.starting ??= this.#begin().finally(() => (this.starting = null));
    return this.starting;
  }
  async #begin() {
    this.#end();
    const record = await this.#record();
    // This computer, the same from one sign-in to the next (« ext_agent_host_id »).
    const host = record.ext_agent_host_id || `urn:uuid:${randomUUID()}`;
    if (!record.ext_agent_host_id) await this.#save({ ...record, ext_agent_host_id: host });
    const state = base64url(randomBytes(24)),
      nonce = base64url(randomBytes(24)),
      verifier = base64url(randomBytes(48)),
      challenge = base64url(createHash('sha256').update(verifier).digest());
    const server = http.createServer((req, res) => void this.#callback(req, res, server));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const redirect = `http://127.0.0.1:${server.address().port}/auth/callback`,
      clientId = record.client_id || 'dynamic_agent_client';
    const params = new URLSearchParams({
      client_id: clientId,
      ...(record.client_id ? {} : { agent_name_hint: this.appName }),
      ext_agent_host_id: host,
      response_type: 'code',
      redirect_uri: redirect,
      scope: SCOPES,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    });
    const url = `${this.issuer}/api/accounts/authorize?${params}`;
    const timer = setTimeout(() => {
      this.lastError = 'La connexion n’a pas été terminée dans les dix minutes. Recommencez.';
      this.#end();
    }, SIGN_IN_MS);
    timer.unref?.();
    this.pending = { state, nonce, verifier, redirect, clientId, server, timer };
    this.lastError = '';
    try {
      this.openUrl(url);
    } catch {
      // The settings offer the address all the same.
    }
    return { url };
  }
  /**
   * The sign-in stopped: its page of Moodix stops listening. `gently`: once the page that answers
   * the browser is sent (its connection closes with it).
   */
  #end({ gently = false } = {}) {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.server.close();
    if (!gently) pending.server.closeAllConnections?.();
  }
  cancelSignIn() {
    this.#end();
  }
  async #callback(req, res, server) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/auth/callback' || req.method !== 'GET') {
      res.writeHead(404);
      return res.end();
    }
    const pending = this.pending;
    if (!pending || pending.server !== server || url.searchParams.get('state') !== pending.state)
      return page(
        res,
        400,
        'Cette page de connexion ne correspond plus à une demande de Moodix. Recommencez depuis ses Paramètres.',
      );
    try {
      const refused = url.searchParams.get('error');
      if (refused)
        throw problem(
          refused === 'access_denied'
            ? 'Connexion refusée dans la page de ChatGPT : rien n’a été enregistré.'
            : `ChatGPT a refusé la connexion (${short(refused)}).`,
        );
      const code = url.searchParams.get('code'),
        issued = url.searchParams.get('client_id');
      if (!code) throw problem('ChatGPT n’a pas renvoyé de code de connexion. Recommencez.');
      // Signed in again: the same registration, never another one put in its place.
      if (pending.clientId !== 'dynamic_agent_client' && issued && issued !== pending.clientId)
        throw problem('Le compte choisi ne correspond pas à celui déjà enregistré. Recommencez.');
      const clientId = pending.clientId === 'dynamic_agent_client' ? issued : pending.clientId;
      if (!clientId) throw problem('L’enregistrement de Moodix chez ChatGPT est incomplet. Recommencez.');
      const tokens = await this.#token({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: pending.verifier,
        redirect_uri: pending.redirect,
        resource: RESOURCE,
      });
      const claims = await this.#identity(tokens.id_token, { clientId, nonce: pending.nonce });
      const record = await this.#record();
      if (record.subject && record.client_id === clientId && record.subject !== claims.sub)
        throw problem('Le compte choisi ne correspond pas à celui déjà enregistré. Recommencez.');
      const scopes = String(tokens.scope ?? '')
        .split(/\s+/)
        .filter(Boolean);
      await this.#save({
        ...record,
        ...this.#kept(tokens, scopes),
        email: claims.email || '',
        subject: claims.sub,
        client_id: clientId,
      });
      this.lastError = scopes.includes(PLAN)
        ? ''
        : 'Le compte est connecté, mais l’usage de votre abonnement n’a pas été accepté : reconnectez-vous et acceptez-le.';
      page(
        res,
        200,
        scopes.includes(PLAN)
          ? 'Moodix est connecté à votre compte ChatGPT. Vous pouvez fermer cet onglet et revenir à Moodix.'
          : this.lastError,
      );
    } catch (error) {
      this.lastError = error.status ? error.message : `La connexion à ChatGPT a échoué : ${short(error.message)}`;
      page(res, 400, this.lastError);
    } finally {
      if (this.pending === pending) this.#end({ gently: true });
    }
  }
  #kept(tokens, scopes) {
    return {
      ...(tokens.id_token ? { id_token: tokens.id_token } : {}),
      access_token: tokens.access_token,
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      token_type: tokens.token_type || 'Bearer',
      expires_at: this.now() + (Number(tokens.expires_in) || 3600) * 1000,
      scopes,
      saved_at: new Date(this.now()).toISOString(),
    };
  }
  async #token(form) {
    let response;
    try {
      response = await this.fetchImpl(`${this.issuer}/api/accounts/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form),
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      throw networkFailure(error, new URL(this.issuer).host);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      // Its refusal as a word (« invalid_grant ») or as an object ({ code, message }).
      const code = typeof body.error === 'string' ? body.error : (body.error?.code ?? body.code ?? ''),
        said = body.error_description ?? body.error?.message ?? body.message ?? '';
      throw Object.assign(
        problem(
          `ChatGPT refuse la connexion (${short([code, said].filter(Boolean).join(' : ') || response.status)}).`,
          502,
        ),
        { code: String(code) },
      );
    }
    if (typeof body.access_token !== 'string') throw problem('ChatGPT n’a pas donné de jeton d’accès.', 502);
    return body;
  }
  async #configuration() {
    this.discovery ??= (async () => {
      const response = await this.fetchImpl(`${this.issuer}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw problem('La configuration de connexion de ChatGPT est illisible.', 502);
      return response.json();
    })().catch(error => {
      this.discovery = null;
      throw error;
    });
    return this.discovery;
  }
  /** The ID token checked: its signature against the published keys, its issuer, audience, time, nonce. */
  async #identity(idToken, { clientId, nonce }) {
    const parts = typeof idToken === 'string' ? idToken.split('.') : [];
    if (parts.length !== 3) throw problem('ChatGPT n’a pas donné de jeton d’identité.', 502);
    const [head, body, signature] = parts;
    let header, claims;
    try {
      header = JSON.parse(Buffer.from(head, 'base64url'));
      claims = JSON.parse(Buffer.from(body, 'base64url'));
    } catch {
      throw problem('Le jeton d’identité de ChatGPT est illisible.', 502);
    }
    const { jwks_uri } = await this.#configuration();
    const keys = (await (await this.fetchImpl(jwks_uri, { signal: AbortSignal.timeout(30000) })).json())?.keys ?? [];
    const jwk = keys.find(key => key.kid === header.kid) ?? (keys.length === 1 ? keys[0] : null);
    if (!jwk) throw problem('La clé qui signe le jeton de ChatGPT est introuvable.', 502);
    const key = createPublicKey({ key: jwk, format: 'jwk' }),
      data = Buffer.from(`${head}.${body}`),
      signed = Buffer.from(signature, 'base64url');
    const sound =
      header.alg === 'RS256'
        ? verify('RSA-SHA256', data, key, signed)
        : header.alg === 'ES256'
          ? verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signed)
          : false;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (
      !sound ||
      claims.iss !== this.issuer ||
      !audience.includes(clientId) ||
      !(claims.exp * 1000 > this.now() - 60_000) ||
      (nonce !== undefined && claims.nonce !== nonce) ||
      typeof claims.sub !== 'string'
    )
      throw problem('Le jeton d’identité de ChatGPT n’est pas valide. Recommencez la connexion.', 502);
    return claims;
  }
  /** The access token, renewed shortly before it ends; one renewal at a time. */
  async #access({ renew = false } = {}) {
    const record = await this.#record();
    if (!record.access_token) throw problem('Connectez-vous d’abord à ChatGPT dans Paramètres › Moodix AI.', 409);
    if (!renew && record.expires_at > this.now() + 120_000) return record.access_token;
    if (!record.refresh_token)
      throw problem('La connexion à ChatGPT a expiré : reconnectez-vous dans Paramètres › Moodix AI.', 409);
    this.refreshing ??= (async () => {
      try {
        const tokens = await this.#token({
          grant_type: 'refresh_token',
          client_id: record.client_id,
          refresh_token: record.refresh_token,
          resource: RESOURCE,
        });
        const scopes = tokens.scope ? String(tokens.scope).split(/\s+/).filter(Boolean) : record.scopes;
        await this.#save({ ...(await this.#record()), ...this.#kept(tokens, scopes) });
        return tokens.access_token;
      } catch (error) {
        // A renewal refused for good: the tokens go, the registration stays for the next sign-in.
        if (/invalid_grant|invalid_refresh_token|token_expired|refresh_token_/.test(error.code ?? '')) {
          const { access_token, refresh_token, id_token, expires_at, ...kept } = await this.#record();
          await this.#save(kept);
          throw problem('La connexion à ChatGPT a expiré : reconnectez-vous dans Paramètres › Moodix AI.', 409);
        }
        throw error;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }
  /** The models of the account, to choose one: [{ id, name, efforts, vision }]. */
  async models() {
    let response;
    try {
      response = await this.fetchImpl(`${this.api}/models`, {
        headers: { Authorization: `Bearer ${await this.#access()}` },
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      if (error.status) throw error;
      throw networkFailure(error, new URL(this.api).host);
    }
    if (!response.ok) throw chatgptFailure(response.status, await response.text().catch(() => ''));
    const listed = await response.json().catch(() => ({}));
    const items = Array.isArray(listed?.models) ? listed.models : Array.isArray(listed?.data) ? listed.data : [];
    // The efforts a model takes, when its listing says them (as `supported_reasoning_levels`).
    const efforts = item => {
      const levels = (Array.isArray(item.supported_reasoning_levels) ? item.supported_reasoning_levels : [])
        .map(level => (typeof level === 'string' ? level : level?.effort))
        .filter(level => typeof level === 'string' && /^[a-z]{1,16}$/.test(level));
      return levels.length ? levels : [...CHATGPT_EFFORTS];
    };
    return items
      .filter(item => !item.visibility || item.visibility === 'list')
      .map(item => ({
        id: item.slug ?? item.id,
        name: item.display_name ?? item.slug ?? item.id,
        efforts: efforts(item),
        vision: !Array.isArray(item.input_modalities) || item.input_modalities.includes('image'),
      }))
      .filter(item => typeof item.id === 'string');
  }
  /** Signs out: the renewable session revoked at OpenAI when it can be, the tokens cleared here. */
  async signOut() {
    this.#end();
    const record = await this.#record();
    let revoked = !record.refresh_token;
    if (record.refresh_token)
      try {
        const { revocation_endpoint } = await this.#configuration();
        const response = await this.fetchImpl(revocation_endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            token: record.refresh_token,
            token_type_hint: 'refresh_token',
            client_id: record.client_id,
          }),
          signal: AbortSignal.timeout(30000),
        });
        revoked = response.ok;
      } catch {
        revoked = false;
      }
    // Signed out: the account goes with its tokens (another one may sign in next, registered anew);
    // this computer keeps its identifier.
    const { access_token, refresh_token, id_token, expires_at, scopes, email, subject, client_id, ...kept } = record;
    await this.#save(kept);
    this.lastError = '';
    return { revoked };
  }
  /**
   * Asks the model with the plan of the account: `body` as the chat completions take it (chatPayload),
   * answered as them (lib/chat-model.mjs, ChatModel.request).
   */
  async respond(body, { model, effort = '', signal } = {}) {
    const host = new URL(this.api).host;
    const post = async (request, token) => {
      try {
        return await this.fetchImpl(`${this.api}/responses`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(request),
          signal,
        });
      } catch (error) {
        // Too slow: said as such (before the stop of the user, the other way a signal ends).
        if (error?.name === 'TimeoutError') throw networkFailure(error, host);
        if (signal?.aborted || error.name === 'AbortError') throw error;
        throw networkFailure(error, host);
      }
    };
    let request = responsesRequest(body, model, effort),
      response = await post(request, await this.#access());
    // Refused before its time is up (revoked, renewed elsewhere): renewed once.
    if (response.status === 401) {
      await response.body?.cancel();
      response = await post(request, await this.#access({ renew: true }));
    }
    // A model that takes neither the effort of its reflection nor the choice of its tools: once without.
    if (response.status === 400) {
      const said = await response.text().catch(() => '');
      const lighter = lighterRequest(request);
      if (Object.keys(lighter).length === Object.keys(request).length) throw chatgptFailure(400, said);
      request = lighter;
      response = await post(request, await this.#access());
    }
    if (!response.ok) throw chatgptFailure(response.status, await response.text().catch(() => ''));
    const chunks = responseChunks(response.body);
    if (body.stream)
      return new Response(sseOf(chunks), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      });
    let content = '';
    for await (const chunk of chunks) content += chunk.choices?.[0]?.delta?.content ?? '';
    return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
  }
  close() {
    this.#end();
  }
}
