import { problem } from './engine.mjs';
import { EFFORTS, PROVIDERS, REMOTE_CONTEXT, hostOf, onThisComputer } from './remote-models.mjs';

/**
 * The chat model of Moodix AI, whichever answers: the one llama.cpp runs on this computer (`engine`,
 * lib/engine.mjs), or a remote one (lib/remote-models.mjs): the ChatGPT account of the user
 * (lib/chatgpt.mjs), Claude by its key (lib/claude.mjs), OpenRouter (lib/openrouter.mjs), or any
 * service « compatible OpenAI ». The chat, the Studio and the generations ask it, never the engine
 * itself: its state, whether it is busy, whether it sees images, its answers.
 * A remote model has nothing to load nor to unload: it is ready as soon as it is chosen, and the
 * graphics card stays whole for the generations. Its model and its effort are chosen in the bar of
 * the chat (options, choose).
 */
// How long the models a provider lists are kept before it is asked again.
const LISTED_MS = 10 * 60_000;
export class ChatModel {
  constructor({ engine, remotes, chatgpt = null, claude = null, openrouterModels = null, fetchImpl = fetch }) {
    Object.assign(this, { engine, remotes, chatgpt, claude, openrouterModels, fetchImpl });
    // The connection in use, with its key; null: the local model.
    this.connection = null;
    this.remote = { state: 'stopped', busy: false, request: null, error: '' };
    // The models each connection listed, with when: { at, models }.
    this.listed = new Map();
    // The lightest form of request a service took, by connection and model (remoteRequest).
    this.lighter = new Map();
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
      kind: PROVIDERS.includes(connection.preset) ? connection.preset : 'api',
      preset: connection.preset,
      host: new URL(connection.baseUrl).host,
      model: connection.model,
      effort: connection.effort ?? '',
      vision: connection.vision,
      contextSize: connection.contextSize || REMOTE_CONTEXT,
      // What is written leaves this computer (not a server such as Ollama on it).
      leaves: !onThisComputer(connection.baseUrl),
      // The effort of the reflection can be chosen (the bar of the chat).
      thinking: PROVIDERS.includes(connection.preset),
    };
  }
  /** The models the connection in use lists, asked again after a while: [{ id, name, efforts, vision }]. */
  async #models(connection, { again = false, signal } = {}) {
    const kept = this.listed.get(connection.id);
    if (!again && kept && Date.now() - kept.at < LISTED_MS) return kept.models;
    const models =
      connection.preset === 'chatgpt'
        ? await this.chatgpt.models()
        : connection.preset === 'claude'
          ? await this.claude.models(connection.key, { signal })
          : connection.preset === 'openrouter' && this.openrouterModels
            ? await this.openrouterModels(connection, { signal })
            : (await listModels(connection, { fetchImpl: this.fetchImpl, signal })).map(id => ({
                id,
                name: id,
                efforts: [],
                vision: connection.vision,
              }));
    this.listed.set(connection.id, { at: Date.now(), models });
    return models;
  }
  /**
   * What the bar of the chat offers for the model in use: its models, the efforts of the one chosen,
   * the choice kept. A listing that fails leaves the model chosen, with what stopped it.
   */
  async options({ again = false, signal } = {}) {
    const connection = this.connection;
    if (!connection) return null;
    let models = [],
      error = '';
    try {
      models = await this.#models(connection, { again, signal });
    } catch (error_) {
      error = error_.status ? error_.message : 'Les modèles de ce service ne peuvent pas être lus pour l’instant.';
    }
    const chosen = models.find(item => item.id === connection.model);
    return {
      preset: connection.preset,
      model: connection.model,
      // The effort that goes with the next message (the one kept), never one it does not send.
      effort: connection.effort ?? '',
      efforts: chosen?.efforts ?? [],
      // The service refused the effort with this model: it is not sent (remoteRequest, its lightest form).
      ignored: Boolean(connection.effort) && (this.lighter.get(`${connection.id}|${connection.model}`) ?? 0) >= 2,
      models:
        models.length || !connection.model ? models : [{ id: connection.model, name: connection.model, efforts: [] }],
      error,
    };
  }
  /**
   * The model and the effort chosen in the bar of the chat, kept as the last choice of the
   * connection in use. The effort follows what the new model takes; whether it sees images and
   * what it keeps in mind too. Nothing is changed while its models cannot be read.
   */
  async choose({ model, effort } = {}) {
    if (this.busy) throw problem('Une réponse est en cours. Attendez sa fin.', 409);
    const connection = this.connection;
    if (!connection) throw problem('Le modèle local se règle par sa réflexion seulement.', 409);
    let models;
    try {
      models = await this.#models(connection, { signal: AbortSignal.timeout(30000) });
    } catch (error) {
      throw problem(
        `Les modèles de ce service ne se lisent pas pour l’instant${error.status ? ` (${error.message})` : ''} : rien n’a été changé.`,
        502,
      );
    }
    const next = model === undefined ? connection.model : model;
    const found = models.find(item => item.id === next);
    if (model !== undefined && !found) throw problem('Ce modèle n’est pas proposé par ce service.', 400);
    const efforts = found?.efforts ?? [];
    const wanted = effort === undefined ? connection.effort : effort;
    if (effort !== undefined && effort !== '' && !efforts.includes(effort))
      throw problem('Cette force de réflexion n’est pas proposée pour ce modèle.', 400);
    const { key, ...kept } = connection;
    await this.remotes.save({
      ...kept,
      model: next,
      effort: efforts.includes(wanted) ? wanted : defaultEffort(efforts),
      // A provider of the list knows whether its model sees images; another service, its box.
      vision: found && PROVIDERS.includes(connection.preset) ? found.vision !== false : connection.vision,
      // What the model keeps in mind, when its provider says it (the gauge of the context).
      contextSize:
        Number.isInteger(found?.context) && found.context >= 2048 && found.context <= 4194304
          ? found.context
          : connection.contextSize,
    });
    this.connection = await this.remotes.get(connection.id);
    return this.options();
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
    this.listed.delete(id);
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
    // A quick turn (no reflection asked: a decision of the chat, a prompt of the Studio): the lowest
    // effort the model takes, as its listing says it; none said when it is not known.
    const listed =
      this.listed.get(connection.id)?.models?.find(item => item.id === connection.model)?.efforts ?? [];
    const quick = EFFORTS.find(level => listed.includes(level)) ?? '';
    if (connection.preset === 'chatgpt') {
      if (!this.chatgpt) throw problem('La connexion à ChatGPT est indisponible.', 503);
      return this.chatgpt.respond(body, { model: connection.model, effort: connection.effort, quick, signal });
    }
    if (connection.preset === 'claude') {
      if (!this.claude) throw problem('La connexion à Claude est indisponible.', 503);
      return this.claude.respond(body, {
        model: connection.model,
        key: connection.key,
        effort: connection.effort,
        quick,
        signal,
      });
    }
    // The lightest form a service took with this model is kept: the refused one is not sent again.
    const kept = `${connection.id}|${connection.model}`;
    return remoteRequest(connection, body, {
      signal,
      fetchImpl: this.fetchImpl,
      level: this.lighter.get(kept) ?? 0,
      onLevel: level => this.lighter.set(kept, level),
    });
  }
}

/** The effort offered first: medium when the model takes it, else the middle of its list; none when it takes none. */
export function defaultEffort(efforts) {
  if (!efforts?.length) return '';
  return efforts.includes('medium') ? 'medium' : efforts[Math.floor((efforts.length - 1) / 2)];
}

/** Chunks of chat completions as the stream the chat reads (public/stream.mjs): a failure said in it, its end. */
export function sseOf(chunks) {
  const encoder = new TextEncoder();
  return ReadableStream.from(
    (async function* () {
      try {
        for await (const chunk of chunks) yield encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
      } catch (error) {
        // Said where the chat reads it (an event with `error`); stopped by the user, nothing to say.
        if (error?.name !== 'AbortError') yield encoder.encode(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      }
      yield encoder.encode('data: [DONE]\n\n');
    })(),
  );
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
 * Whether a refusal says that something (`what`: words joined by |) is not supported: « does not
 * support tool use », « tools are not supported », « no endpoints found that support tool use ».
 */
function unsupported(detail, what) {
  const thing = `(?:${what})`;
  return new RegExp(
    `(?:not|n't|no (?:endpoints?|providers?) found that)\\s+(?:\\w+\\s+){0,2}supports?\\s+(?:\\w+\\s+){0,2}${thing}\\b` +
      `|\\b${thing}\\s+(?:\\w+\\s+){0,2}(?:is|are)\\s+not\\s+(?:supported|available)` +
      `|\\bunsupported\\s+(?:\\w+\\s+){0,1}${thing}\\b`,
    'i',
  ).test(detail);
}

/** A text a service sent back, without the key it was given (a proxy may repeat it in its refusal). */
export function redacted(text, key) {
  return key && key.length >= 8 ? String(text).split(key).join('••••') : String(text);
}

/**
 * A refusal of a service, said to the user: the key, the model, the credit, the quota, what the
 * model cannot take (tools, images), a breakdown. Always a 502 for the page (never 401: the page
 * would take it for its own key).
 */
export function remoteFailure(status, said, { host, model }) {
  const detail = serviceDetail(said),
    told = detail ? ` (${detail})` : '';
  // What the model cannot do at all, said only on the refusals that say so (« does not support tool
  // use », « no endpoints found that support tool use »): an invalid call, a result in the wrong
  // place, an image too heavy are other refusals.
  const capability = [400, 404, 415, 422].includes(status);
  if (capability && unsupported(detail, 'tool|tools|tool use|tool calling|function calling|functions'))
    return problem(
      `Le modèle « ${model} » ne sait pas appeler d’outils chez ${host}${told} : Moodix crée par des outils. Choisissez-en un autre dans la barre du chat.`,
      502,
    );
  if (capability && unsupported(detail, 'image|images|image input|vision|multimodal input'))
    return problem(
      `Le modèle « ${model} » ne voit pas les images chez ${host}${told}. Choisissez-en un qui les voit, ou retirez l’image.`,
      502,
    );
  if (status === 401 || (status === 403 && /key|token|auth/i.test(detail)))
    return problem(`La clé d’API est refusée par ${host}${told}. Vérifiez-la dans Paramètres › Moodix AI.`, 502);
  if (status === 403) return problem(`${host} refuse l’accès${told}.`, 502);
  if (status === 402)
    return problem(`Crédit épuisé chez ${host}${told} : rechargez votre compte ou choisissez un modèle gratuit.`, 502);
  if (status === 404)
    return /model/i.test(detail) || !detail
      ? problem(`Modèle inconnu chez ${host} : « ${model} »${told}. Choisissez-en un autre dans la barre du chat.`, 502)
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
  // The longest answer of the local model is no limit for a remote one, which may reflect within it,
  // and a floor could pass what the model can write (refused, then sent again at each message): no
  // limit asked, the service's own.
  delete result.max_tokens;
  // Its models that reflect refuse a temperature or a top_p of their own: its defaults then.
  if (connection.preset === 'openai') {
    delete result.temperature;
    delete result.top_p;
  }
  // Mistral refuses any field it does not know.
  if (connection.preset === 'mistral') delete result.stream_options;
  // The effort chosen in the bar of the chat, the lowest for a quick decision of the chat. OpenRouter
  // passes it to the model when it reflects (and leaves it otherwise).
  const effort = chat_template_kwargs?.enable_thinking === false && connection.effort ? 'low' : connection.effort;
  if (effort && connection.preset === 'openrouter') result.reasoning = { effort };
  return result;
}
/** The same request with only what every service takes: its lightest form (level 2). */
export function minimalBody(body) {
  return Object.fromEntries(
    ['model', 'messages', 'stream', 'tools', 'tool_choice']
      .filter(key => body[key] !== undefined)
      .map(key => [key, body[key]]),
  );
}
/**
 * A request as light as `level` says: 0 whole; 1 without the fields a service may not know
 * (temperature, top_p, stream_options), the effort and the one call at a time kept; 2 its lightest
 * form (the effort no longer sent).
 */
export function lighterBody(body, level) {
  if (level <= 0) return body;
  if (level >= 2) return minimalBody(body);
  const { temperature, top_p, stream_options, ...rest } = body;
  return rest;
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

/** An identifier of a call as the history of Moodix keeps it (some services write `functions.x:0`). */
export const callId = id =>
  String(id)
    .replace(/[^-A-Za-z0-9_]/g, '_')
    .slice(0, 128);

/**
 * An event of a service as the chat reads it: the reflection named `reasoning_content` whatever
 * its name there, a content given as a list made text, one call of a tool (Moodix makes one
 * generation at a time: the first, by its identifier or its index; the others left), its
 * identifier made one the history keeps, an error in the user's words. `state` follows the calls
 * from one event to the next.
 */
export function normalizedEvent(event, host, state = {}) {
  if (event?.error)
    return {
      error: `${host} a interrompu la réponse : ${serviceDetail({ error: event.error }) || 'erreur sans détail.'}`,
    };
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
    const calls = [];
    for (const call of delta.tool_calls) {
      // Which call this part belongs to: a new identifier opens a call, an index says it, a part
      // without either follows the one before.
      if (call.id) state.current = state.first === undefined || state.first === call.id ? 'first' : 'other';
      else if (Number.isInteger(call.index))
        state.current = call.index === (state.index ?? call.index) ? 'first' : 'other';
      if (call.id && state.first === undefined) state.first = call.id;
      if (Number.isInteger(call.index) && state.index === undefined && state.current !== 'other')
        state.index = call.index;
      if (state.current === 'other') continue;
      state.called = true;
      calls.push({ ...call, index: 0, ...(call.id ? { id: callId(call.id) } : {}) });
    }
    if (calls.length) delta.tool_calls = calls;
    else delete delta.tool_calls;
  }
  // A call complete but ended as an answer (« stop »): read as the call it is.
  const reason = choice.finish_reason === 'stop' && state.called ? 'tool_calls' : choice.finish_reason;
  // A call that came without an identifier: given one at its end (the history keeps a call by it).
  if (reason && state.called && state.first === undefined) {
    state.first = `call_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
    delta.tool_calls = [...(delta.tool_calls ?? []), { index: 0, id: state.first }];
  }
  return { ...event, choices: [{ ...choice, delta, ...(reason ? { finish_reason: reason } : {}) }] };
}

/**
 * The stream of a service made the one the chat reads (normalizedEvent), its end said once. A
 * stream cut before its end is said in words, with the name of the service.
 */
export function normalizedStream(stream, host) {
  const encoder = new TextEncoder(),
    frame = data => encoder.encode(`data: ${data}\n\n`),
    state = {};
  return ReadableStream.from(
    (async function* () {
      const reader = stream.getReader(),
        decoder = new TextDecoder();
      let buffer = '',
        done = false,
        finished = false;
      function* emit(block) {
        const data = block
          .split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n');
        if (!data || done) return;
        if (data === '[DONE]') {
          done = true;
          return;
        }
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          // Unreadable: passed as it is, the reader of the chat says so.
          yield frame(data);
          return;
        }
        if (event?.choices?.[0]?.finish_reason) finished = true;
        yield frame(JSON.stringify(normalizedEvent(event, host, state)));
      }
      try {
        while (!done) {
          const { value, done: ended } = await reader.read();
          buffer += decoder.decode(value, { stream: !ended });
          let match;
          while (!done && (match = /\r?\n\r?\n/.exec(buffer))) {
            const block = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            yield* emit(block);
          }
          if (ended) {
            if (buffer.trim()) yield* emit(buffer);
            break;
          }
        }
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        yield frame(
          JSON.stringify({
            error: `La connexion à ${host} a été coupée pendant la réponse. La réponse reçue est conservée.`,
          }),
        );
        done = true;
      } finally {
        await reader.cancel().catch(() => {});
      }
      // A service that ends its answer without the last word: whole all the same once it said its
      // end; otherwise cut short, and said.
      if (!done && !finished)
        yield frame(
          JSON.stringify({
            error: `La réponse de ${host} s’est arrêtée avant sa fin. La réponse reçue est conservée.`,
          }),
        );
      yield frame('[DONE]');
    })(),
  );
}

/**
 * Asks a service « compatible OpenAI » (`connection`: address, key, model). Refused for a field
 * it does not know (400, 422), asked again once with the fields every service takes.
 */
export async function remoteRequest(connection, body, { signal, fetchImpl = fetch, level = 0, onLevel = () => {} } = {}) {
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
    // From the lightest form this service took with this model (`level`), lighter again while it
    // refuses a field it does not know (400, 422); the form that passed is kept (`onLevel`).
    let at = level,
      sent = lighterBody(full, at);
    response = await send(sent);
    while ([400, 422].includes(response.status) && at < 2) {
      const next = lighterBody(full, at + 1);
      at++;
      if (JSON.stringify(next) === JSON.stringify(sent)) continue;
      await response.body?.cancel();
      sent = next;
      response = await send(sent);
    }
    if (response.ok && at !== level) onLevel(at);
  } catch (error) {
    // Too slow: said as such (before the stop of the user, which is the other way a signal ends).
    if (error?.name === 'TimeoutError') throw networkFailure(error, host);
    if (error.status || signal?.aborted || error.name === 'AbortError') throw error;
    throw networkFailure(error, host);
  }
  if (!response.ok)
    throw remoteFailure(response.status, redacted(await response.text().catch(() => ''), connection.key), {
      host,
      model: connection.model,
    });
  // A page of a web site, not a service of models: the address is not the one of its API.
  if (!/json|event-stream/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    throw problem(
      `${host} ne répond pas comme un service de modèles compatible OpenAI : vérifiez l’adresse (elle finit souvent par /v1).`,
      502,
    );
  }
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
  // Something answered, but not a model: no answer of a model in it.
  if (!Array.isArray(answer?.choices))
    throw problem(
      `${hostOf(connection.baseUrl)} répond, mais pas comme un service de modèles compatible OpenAI : vérifiez l’adresse (elle finit souvent par /v1).`,
      502,
    );
  return { ok: true, said: short(answer.choices[0]?.message?.content ?? '').slice(0, 80) };
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
    throw remoteFailure(response.status, redacted(await response.text().catch(() => ''), connection.key), {
      host,
      model: connection.model,
    });
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
