import { problem } from './engine.mjs';
import { REMOTE_CONTEXT, onThisComputer } from './remote-models.mjs';

/**
 * The chat model of Moodix AI, whichever answers: the one llama.cpp runs on this computer (`engine`,
 * lib/engine.mjs), or a service reached by its address (lib/remote-models.mjs), or the ChatGPT
 * account of the user (lib/chatgpt.mjs). The chat, the Studio and the generations ask it, never
 * the engine itself: its state, whether it is busy, whether it sees images, its answers.
 * A remote model has nothing to load nor to unload: it is ready as soon as it is chosen, and the
 * graphics card stays whole for the generations.
 */
export class ChatModel {
  constructor({ engine, remotes, chatgpt = null, fetchImpl = fetch }) {
    Object.assign(this, { engine, remotes, chatgpt, fetchImpl });
    // The connection in use, with its key; null: the local model.
    this.connection = null;
    this.remote = { state: 'stopped', busy: false, request: null, error: '' };
  }
  /** The connection kept as the one in use, read at launch. */
  async load() {
    this.connection = await this.remotes.active().catch(() => null);
    return this;
  }
  get local() {
    return !this.connection;
  }
  get state() {
    return this.local ? this.engine.state : this.remote.state;
  }
  get busy() {
    return this.local ? this.engine.busy : this.remote.busy;
  }
  set busy(value) {
    if (this.local) this.engine.busy = value;
    else this.remote.busy = value;
  }
  get activeRequest() {
    return this.local ? this.engine.activeRequest : this.remote.request;
  }
  set activeRequest(value) {
    if (this.local) this.engine.activeRequest = value;
    else this.remote.request = value;
  }
  get vision() {
    return this.local ? this.engine.vision : this.connection.vision && this.remote.state === 'ready';
  }
  /** Whether images go with the messages once the model is ready: its projector, or its connection. */
  seesImages(config) {
    return this.local ? Boolean(config.projectorPath) : this.connection.vision;
  }
  get error() {
    return this.local ? this.engine.error : this.remote.error;
  }
  get logs() {
    return this.local ? this.engine.logs : [];
  }
  /** What a conversation can hold, and the longest answer asked for. */
  limits(config) {
    return {
      capacity: this.local ? config.contextSize : this.connection.contextSize || REMOTE_CONTEXT,
      reserved: config.maxOutputTokens,
    };
  }
  /** The connection in use, as the page shows it (never its key). */
  describe() {
    const connection = this.connection;
    if (!connection) return null;
    return {
      id: connection.id,
      name: connection.name,
      kind: connection.preset === 'chatgpt' ? 'chatgpt' : 'api',
      preset: connection.preset,
      host: new URL(connection.baseUrl).host,
      model: connection.model,
      vision: connection.vision,
      contextSize: connection.contextSize || REMOTE_CONTEXT,
      // What is written leaves this computer (not a server such as Ollama on it).
      leaves: !onThisComputer(connection.baseUrl),
      // The switch of the reflection means something there (lib/chatgpt.mjs, its effort).
      thinking: connection.preset === 'chatgpt',
    };
  }
  status() {
    if (this.local) return { ...this.engine.status(), remote: null };
    return {
      state: this.remote.state,
      vision: this.vision,
      busy: this.remote.busy,
      logs: [],
      error: this.remote.error,
      remote: this.describe(),
    };
  }
  async start(config) {
    if (this.local) return this.engine.start(config);
    this.remote.state = 'ready';
    this.remote.error = '';
  }
  async stop() {
    if (this.local) return this.engine.stop();
    this.remote.request?.abort();
    this.remote.busy = false;
    this.remote.state = 'stopped';
  }
  /**
   * The chat answered from now on by the connection `id`, or by the local model (null). The local
   * model leaves the card when a remote one is chosen; it starts again when a message needs it.
   */
  async use(id) {
    if (this.busy) throw problem('Une réponse est en cours. Attendez sa fin.', 409);
    if (id === (this.connection?.id ?? null)) return;
    const next = id === null ? null : await this.remotes.get(id);
    await this.remotes.setActive(next ? next.id : null);
    if (next && this.local) await this.engine.stop();
    this.connection = next;
    this.remote = { state: next ? 'ready' : 'stopped', busy: false, request: null, error: '' };
  }
  /** A connection saved again: its new model, address or key at once, when it is the one in use. */
  async changed(id) {
    if (this.connection?.id === id) this.connection = await this.remotes.get(id);
  }
  /** A connection removed: the chat goes back to the local model if it was that one. */
  forget(id) {
    if (this.connection?.id !== id) return;
    this.remote.request?.abort();
    this.connection = null;
    this.remote = { state: 'stopped', busy: false, request: null, error: '' };
  }
  /**
   * Asks the model, as the chat completions of OpenAI do (`body`: what chatPayload makes, or a
   * request of the Studio). A Response: its stream in that format when `body.stream`, else its JSON.
   * A remote service that refuses is said in the user's words (a problem with status 502).
   */
  async request(body, { signal } = {}) {
    if (this.local)
      return this.fetchImpl(`${this.engine.base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.engine.apiKey}` },
        body: JSON.stringify(body),
        signal,
      });
    const connection = this.connection;
    if (connection.preset === 'chatgpt') {
      if (!this.chatgpt) throw problem('La connexion à ChatGPT est indisponible.', 503);
      return this.chatgpt.respond(body, { model: connection.model, signal });
    }
    return remoteRequest(connection, body, { signal, fetchImpl: this.fetchImpl });
  }
}

const short = text => String(text).replace(/\s+/g, ' ').trim().slice(0, 300);

/** What a service said of a refusal, in its own words when it gives some. */
export function serviceDetail(said) {
  let body = said;
  if (typeof said === 'string')
    try {
      body = JSON.parse(said);
    } catch {
      return short(said);
    }
  if (typeof body === 'string') return short(body);
  const found =
    body?.error?.message ??
    body?.error?.metadata?.raw ??
    (typeof body?.error === 'string' ? body.error : null) ??
    body?.message ??
    (typeof body?.detail === 'string' ? body.detail : body?.detail?.[0]?.msg);
  return found ? short(found) : '';
}

/**
 * A refusal of a service, said to the user: the key, the model, the credit, the quota, a
 * breakdown. Always a 502 for the page (never 401: the page would take it for its own key).
 */
export function remoteFailure(status, said, { host, model }) {
  const detail = serviceDetail(said),
    told = detail ? ` (${detail})` : '';
  if (status === 401 || (status === 403 && /key|token|auth/i.test(detail)))
    return problem(`La clé d’API est refusée par ${host}${told}. Vérifiez-la dans Paramètres › Moodix AI.`, 502);
  if (status === 403) return problem(`${host} refuse l’accès${told}.`, 502);
  if (status === 402)
    return problem(`Crédit épuisé chez ${host}${told} : rechargez votre compte ou choisissez un modèle gratuit.`, 502);
  if (status === 404)
    return /model/i.test(detail) || !detail
      ? problem(
          `Modèle inconnu chez ${host} : « ${model} »${told}. Recopiez son nom exact dans Paramètres › Moodix AI.`,
          502,
        )
      : problem(
          `Adresse introuvable chez ${host}${told} : vérifiez l’adresse du serveur (elle finit souvent par /v1).`,
          502,
        );
  if (status === 429)
    return problem(`Limite ou quota atteint chez ${host}${told}. Attendez un peu, ou vérifiez votre forfait.`, 502);
  if (status >= 500)
    return problem(`${host} a une panne passagère (erreur ${status})${told}. Réessayez dans un moment.`, 502);
  return problem(`${host} refuse la demande (erreur ${status})${told}.`, 502);
}

/** A service out of reach: no network, a wrong address, a server not started. */
export function networkFailure(error, host) {
  const code = error?.cause?.code || error?.code || '';
  if (['ECONNREFUSED', 'ECONNRESET'].includes(code))
    return problem(`${host} ne répond pas : le serveur est-il démarré, et son adresse juste ?`, 502);
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code))
    return problem(`${host} est introuvable : vérifiez la connexion à Internet et l’adresse du serveur.`, 502);
  if (error?.name === 'TimeoutError' || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code))
    return problem(`${host} ne répond pas à temps : vérifiez la connexion à Internet.`, 502);
  return problem(`Pas de réponse de ${host} : vérifiez la connexion à Internet et l’adresse du serveur.`, 502);
}

/**
 * The request for a service: the fields only llama.cpp knows taken out (its template, its way of
 * giving the reflection, top_k), the model of the connection named, the reflection kept by the
 * conversation left out of what is sent back. A few services want their own word for a field.
 */
export function remoteBody(body, connection) {
  const { reasoning_format, chat_template_kwargs, top_k, model, thinking, ...rest } = body;
  const result = {
    ...rest,
    model: connection.model,
    messages: rest.messages.map(({ reasoning_content, ...message }) => message),
  };
  if (connection.preset === 'openai' && result.max_tokens !== undefined) {
    result.max_completion_tokens = result.max_tokens;
    delete result.max_tokens;
  }
  // Mistral refuses any field it does not know.
  if (connection.preset === 'mistral') delete result.stream_options;
  return result;
}
/** The same request with only what every service takes: sent once when the first is refused. */
export function minimalBody(body) {
  return Object.fromEntries(
    ['model', 'messages', 'stream', 'tools', 'tool_choice']
      .filter(key => body[key] !== undefined)
      .map(key => [key, body[key]]),
  );
}

/** The text of a message part a service may give as a list (Mistral: its reflection in it). */
function contentParts(content) {
  let text = '',
    thought = '';
  for (const part of content) {
    if (typeof part === 'string') text += part;
    else if (part?.type === 'text') text += part.text ?? '';
    else if (part?.type === 'thinking')
      thought += (Array.isArray(part.thinking) ? part.thinking : [part.thinking])
        .map(item => (typeof item === 'string' ? item : (item?.text ?? '')))
        .join('');
  }
  return { text, thought };
}

/**
 * An event of a service as the chat reads it: the reflection named `reasoning_content` whatever
 * its name there, a content given as a list made text, one call of a tool (Moodix makes one
 * generation at a time), an error in the user's words.
 */
export function normalizedEvent(event, host) {
  if (event?.error)
    return { error: `${host} : ${serviceDetail({ error: event.error }) || 'erreur pendant la réponse.'}` };
  const choice = event?.choices?.[0];
  if (!choice?.delta) return event;
  const delta = { ...choice.delta };
  if (Array.isArray(delta.content)) {
    const { text, thought } = contentParts(delta.content);
    delta.content = text;
    if (thought) delta.reasoning_content = (delta.reasoning_content ?? '') + thought;
  }
  if (typeof delta.reasoning === 'string' && !delta.reasoning_content) delta.reasoning_content = delta.reasoning;
  delete delta.reasoning;
  delete delta.reasoning_details;
  if (Array.isArray(delta.tool_calls)) {
    const calls = delta.tool_calls
      .map(call => ({ ...call, index: Number.isInteger(call.index) ? call.index : 0 }))
      .filter(call => call.index === 0);
    if (calls.length) delta.tool_calls = calls;
    else delete delta.tool_calls;
  }
  return { ...event, choices: [{ ...choice, delta }] };
}

/** The stream of a service made the one the chat reads (normalizedEvent), its end said once. */
export function normalizedStream(stream, host) {
  const decoder = new TextDecoder(),
    encoder = new TextEncoder();
  let buffer = '',
    done = false,
    finished = false;
  const frame = data => encoder.encode(`data: ${data}\n\n`);
  function emit(block, controller) {
    const data = block
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n');
    if (!data || done) return;
    if (data === '[DONE]') {
      done = true;
      controller.enqueue(frame('[DONE]'));
      return;
    }
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      // Unreadable: passed as it is, the reader of the chat says so.
      controller.enqueue(frame(data));
      return;
    }
    if (event?.choices?.[0]?.finish_reason) finished = true;
    controller.enqueue(frame(JSON.stringify(normalizedEvent(event, host))));
  }
  return stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const block = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          emit(block, controller);
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.trim()) emit(buffer, controller);
        // A service that ends its answer without the last word: the answer is whole all the same.
        if (!done && finished) controller.enqueue(frame('[DONE]'));
      },
    }),
  );
}

/**
 * Asks a service « compatible OpenAI » (`connection`: address, key, model). Refused for a field
 * it does not know (400, 422), asked again once with the fields every service takes.
 */
export async function remoteRequest(connection, body, { signal, fetchImpl = fetch } = {}) {
  const host = new URL(connection.baseUrl).host;
  const send = payload =>
    fetchImpl(`${connection.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(connection.key ? { Authorization: `Bearer ${connection.key}` } : {}),
      },
      body: JSON.stringify(payload),
      signal,
    });
  const full = remoteBody(body, connection);
  let response;
  try {
    response = await send(full);
    if ([400, 422].includes(response.status)) {
      const minimal = minimalBody(full);
      if (Object.keys(minimal).length < Object.keys(full).length) {
        await response.body?.cancel();
        response = await send(minimal);
      }
    }
  } catch (error) {
    if (error.status || signal?.aborted || error.name === 'AbortError') throw error;
    throw networkFailure(error, host);
  }
  if (!response.ok)
    throw remoteFailure(response.status, await response.text().catch(() => ''), { host, model: connection.model });
  if (!body.stream) return response;
  return new Response(normalizedStream(response.body, host), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  });
}

/**
 * « Tester la connexion »: a word asked of the model, which tells at once whether the address,
 * the key and the name of the model are right. What it answered, a few words.
 */
export async function testConnection(connection, { fetchImpl = fetch, chatgpt = null, signal } = {}) {
  const body = {
    messages: [{ role: 'user', content: 'Réponds seulement : OK' }],
    stream: false,
    max_tokens: 32,
  };
  const response =
    connection.preset === 'chatgpt'
      ? await chatgpt.respond(body, { model: connection.model, signal })
      : await remoteRequest(connection, body, { fetchImpl, signal });
  const answer = await response.json().catch(() => null);
  return { ok: true, said: short(answer?.choices?.[0]?.message?.content ?? '').slice(0, 80) };
}

/** The models a service lists (GET /models), for the field of the editor; [] when it lists none. */
export async function listModels(connection, { fetchImpl = fetch, signal } = {}) {
  const host = new URL(connection.baseUrl).host;
  let response;
  try {
    response = await fetchImpl(`${connection.baseUrl}/models`, {
      headers: connection.key ? { Authorization: `Bearer ${connection.key}` } : {},
      signal,
    });
  } catch (error) {
    throw networkFailure(error, host);
  }
  if (!response.ok)
    throw remoteFailure(response.status, await response.text().catch(() => ''), { host, model: connection.model });
  const listed = await response.json().catch(() => ({}));
  const items = Array.isArray(listed?.data) ? listed.data : Array.isArray(listed?.models) ? listed.models : [];
  return [
    ...new Set(
      items.map(item => item?.id ?? item?.slug ?? item?.name).filter(id => typeof id === 'string' && id.length <= 200),
    ),
  ]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 2000);
}

/**
 * A count of the context for a remote model, from the length of what is sent: a service has no
 * route for it. Exact after each answer (the usage it gives, public/context-meter.mjs).
 */
export function estimateContext(payload) {
  let characters = 0,
    images = 0;
  for (const message of payload.messages) {
    if (typeof message.content === 'string') characters += message.content.length;
    else
      for (const part of message.content ?? [])
        if (part.type === 'text') characters += part.text.length;
        else images++;
    if (message.tool_calls) characters += JSON.stringify(message.tool_calls).length;
  }
  if (payload.tools) characters += JSON.stringify(payload.tools).length;
  return { used: Math.ceil(characters / 3.6) + 4 * payload.messages.length, precision: images ? 'text-only' : 'rough' };
}
