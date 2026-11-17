import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { problem } from './engine.mjs';
import { networkFailure, sseOf } from './chat-model.mjs';

/**
 * Claude as the chat model of Moodix, with the API key of the user's Claude Console: Anthropic does
 * not let an application sign in with a Claude.ai account nor use a Pro or Max plan
 * (code.claude.com/docs/en/legal-and-compliance), so « associer son compte » is pasting a key.
 * Asked through Anthropic's official library (@anthropic-ai/sdk, Apache-2.0), installed on demand
 * in node_modules (`npm ci`, its version pinned by package-lock.json): Moodix runs without it.
 *
 * Claude answers by the Messages API (POST /v1/messages), turned here into the chat completions the
 * rest of Moodix reads (lib/chat-model.mjs). Its reflection is adaptive, its depth the effort the
 * user chose; no thinking block of an earlier turn is sent back (Moodix rebuilds the start of a
 * conversation at each turn: a replayed block would be refused), which the API accepts.
 */
const LIBRARY = '@anthropic-ai/sdk';
export const CLAUDE_HOST = 'api.anthropic.com';
// The current models, in the order they are offered when the Models API cannot be asked.
export const CLAUDE_MODELS = Object.freeze([
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-2', name: 'Claude Fable 5.2' },
]);
export const CLAUDE_DEFAULT = 'claude-opus-5-5';
export const CLAUDE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
// A model declined by its safety classifiers is answered by the one Anthropic recommends for that
// case (server-side fallback): a false positive is not a dead end.
const FALLBACK = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const short = text =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);

const textOf = content =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter(part => part?.type === 'text')
          .map(part => part.text)
          .join('\n')
      : '';

/** An image of a message (a data: URL of PNG or JPEG) as the Messages API takes it. */
function imageBlock(url) {
  const match = /^data:(image\/(?:png|jpeg));base64,(.+)$/.exec(url ?? '');
  return match ? { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } } : null;
}

/**
 * The conversation of the chat (chat completions, as chatPayload makes it) as the Messages API
 * takes it: the first system message apart, a call of a tool as a `tool_use` block of its turn,
 * its result as a `tool_result` of the next user turn; turns of the same speaker joined.
 */
export function claudeMessages(messages) {
  const list = [...messages];
  const system = list[0]?.role === 'system' ? textOf(list.shift().content) : '';
  const turns = [];
  const add = (role, blocks) => {
    if (!blocks.length) return;
    const last = turns.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  };
  for (const message of list) {
    if (message.role === 'user' || message.role === 'system') {
      const parts =
        typeof message.content === 'string'
          ? [{ type: 'text', text: message.content }]
          : message.content.map(part =>
              part.type === 'image_url' ? imageBlock(part.image_url?.url) : { type: 'text', text: part.text },
            );
      add(
        'user',
        parts.filter(part => part && (part.type !== 'text' || part.text.trim())),
      );
    } else if (message.role === 'assistant') {
      const said = textOf(message.content).trim(),
        blocks = said ? [{ type: 'text', text: said }] : [];
      for (const call of message.tool_calls ?? []) {
        let input = {};
        try {
          input = JSON.parse(call.function.arguments || '{}');
        } catch {
          // Arguments that never parsed were answered as an error: the call stays, empty.
        }
        blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: input ?? {} });
      }
      add('assistant', blocks);
    } else if (message.role === 'tool')
      add('user', [
        { type: 'tool_result', tool_use_id: message.tool_call_id, content: textOf(message.content) || '(vide)' },
      ]);
  }
  // A conversation begins with the user, and an answer is asked after a user turn (no prefill).
  if (turns[0]?.role !== 'user')
    turns.unshift({ role: 'user', content: [{ type: 'text', text: '(début de la conversation)' }] });
  return { system, messages: turns };
}

/**
 * The request for Claude: adaptive reflection with its summary shown, the effort chosen (the lowest
 * when the chat asks for no reflection: a quick decision), one call of a tool at a time, the
 * prompt cached, the fallback of Anthropic on a refusal. No temperature: these models refuse it.
 */
export function claudeRequest(body, { model, effort, quick: lowest = '' }) {
  const { system, messages } = claudeMessages(body.messages);
  const quick = body.chat_template_kwargs?.enable_thinking === false;
  const tools = (body.tools ?? []).map(tool => ({
    name: tool.function.name,
    description: tool.function.description ?? '',
    input_schema: tool.function.parameters ?? { type: 'object', properties: {} },
    // The arguments stream as they are written; lib/tool-runtime.mjs checks them before anything runs.
    ...(body.stream ? { eager_input_streaming: true } : {}),
  }));
  return {
    model,
    // Room for the reflection as well as the answer: it counts in max_tokens.
    max_tokens: body.stream ? 64000 : 16000,
    ...(system ? { system } : {}),
    messages,
    thinking: { type: 'adaptive', display: 'summarized' },
    // A quick turn: the lowest effort the model takes (as its listing says; low for every current one).
    output_config: { effort: quick ? lowest || 'low' : CLAUDE_EFFORTS.includes(effort) ? effort : 'medium' },
    ...(tools.length ? { tools, tool_choice: { type: 'auto', disable_parallel_tool_use: true } } : {}),
    cache_control: { type: 'ephemeral' },
    ...(FALLBACK.has(model) ? { fallbacks: 'default', betas: [FALLBACK_BETA] } : {}),
  };
}

/** Why Claude stopped on a refusal, in the user's words. */
function refusal(details) {
  const category = details?.category;
  return problem(
    `Claude a refusé de répondre à cette demande${category ? ` (motif : ${category})` : ''}. Reformulez-la, ou choisissez un autre modèle dans la barre du chat.`,
    502,
  );
}

/**
 * The events of a Messages stream as chunks of chat completions: the words, the summary of the
 * reflection, the call of a tool, the end and its usage. The call is given whole at the end: after
 * a fallback of Anthropic in the middle of the answer (a block `fallback`), the call the first
 * model had begun is left, only the one of the model that answers is kept. A refusal or a failure
 * is thrown in the user's words; a stream cut before its end too (`stopped`: what stopped it, when
 * its signal did).
 */
export async function* claudeChunks(events, { explain = error => error, stopped = () => null } = {}) {
  const say = delta => ({ choices: [{ index: 0, delta }] });
  // The call being written: its block, its identifier, its name, its arguments so far.
  let call = null,
    stop = null,
    details = null,
    input = 0,
    output = 0,
    ended = false;
  try {
    for await (const event of events) {
      switch (event?.type) {
        case 'message_start': {
          const usage = event.message?.usage ?? {};
          input =
            (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
          output = usage.output_tokens ?? 0;
          break;
        }
        case 'content_block_start': {
          const block = event.content_block;
          // Another model answers from here: what the first one began of a call is left.
          if (block?.type === 'fallback') call = null;
          else if (block?.type === 'tool_use' && call === null)
            call = { index: event.index, id: block.id, name: block.name, arguments: '' };
          else if (block?.type === 'thinking' && block.thinking) yield say({ reasoning_content: block.thinking });
          else if (block?.type === 'text' && block.text) yield say({ content: block.text });
          break;
        }
        case 'content_block_delta': {
          const delta = event.delta;
          if (delta?.type === 'text_delta' && delta.text) yield say({ content: delta.text });
          else if (delta?.type === 'thinking_delta' && delta.thinking) yield say({ reasoning_content: delta.thinking });
          else if (delta?.type === 'input_json_delta' && event.index === call?.index && delta.partial_json)
            call.arguments += delta.partial_json;
          break;
        }
        case 'message_delta':
          stop = event.delta?.stop_reason ?? stop;
          details = event.delta?.stop_details ?? details;
          output = event.usage?.output_tokens ?? output;
          break;
        case 'message_stop':
          ended = true;
          break;
      }
    }
  } catch (error) {
    // In the middle of the answer: a lost connection is an answer cut short.
    throw explain(error, true);
  }
  if (stop === 'refusal') throw refusal(details);
  // The library ends its stream without a word when its signal stops it: a stop, or a time passed.
  if (!ended) throw stopped() ?? problem('La réponse de Claude a été interrompue. La réponse reçue est conservée.', 502);
  // The call, whole (a call with no argument at all: an empty object, which reads as one).
  if (call)
    yield say({
      tool_calls: [
        { index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments || '{}' } },
      ],
    });
  yield {
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: stop === 'tool_use' ? 'tool_calls' : stop === 'max_tokens' ? 'length' : 'stop',
      },
    ],
  };
  yield { choices: [], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } };
}

/** Where npm is, beside the Node that runs Moodix (Windows) or in its prefix (elsewhere). */
async function npmCli(node = process.execPath) {
  for (const path of [
    join(dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(node), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ])
    try {
      await access(path);
      return path;
    } catch {
      // The next place.
    }
  return null;
}

export class ClaudeAccess {
  constructor({
    root,
    // Where the Messages API is; tests pass their own server.
    baseURL = `https://${CLAUDE_HOST}`,
    // Loads the official library (tests may give theirs).
    load = () => import(LIBRARY),
    spawnProcess = spawn,
    // How many times the library asks again after an overload or a cut (tests: none).
    retries = 2,
    // How long its install may take before it is stopped.
    installTime = 10 * 60 * 1000,
  }) {
    Object.assign(this, { root, baseURL, load, spawnProcess, retries, installTime });
    this.installing = null;
    this.installError = '';
    this.library = null;
  }
  /** The version of the library package.json pins, and the one installed (null when none is). */
  async #versions() {
    const pinned = JSON.parse(await readFile(join(this.root, 'package.json'), 'utf8')).dependencies?.[LIBRARY] ?? null;
    let installed = null;
    try {
      installed = JSON.parse(
        await readFile(join(this.root, 'node_modules', '@anthropic-ai', 'sdk', 'package.json'), 'utf8'),
      ).version;
    } catch {
      // Not installed.
    }
    return { pinned, installed };
  }
  /** What the settings show: the library ready, missing, being installed, or what stopped it. */
  async status() {
    if (this.installing) return { library: 'installing', error: '' };
    const { pinned, installed } = await this.#versions();
    return {
      library: installed && installed === pinned ? 'ready' : installed ? 'outdated' : 'missing',
      error: this.installError,
    };
  }
  /**
   * Installs the library as package-lock.json says (`npm ci`, no script run): asked by the user
   * the first time Claude is chosen. Resolves once done; its failure is said by status().
   */
  install() {
    this.installing ??= (async () => {
      this.installError = '';
      try {
        const cli = await npmCli();
        if (!cli)
          throw problem('npm est introuvable à côté de Node.js : réinstallez Node.js (avec npm), puis recommencez.');
        await new Promise((resolve, reject) => {
          let text = '';
          const child = this.spawnProcess(
            process.execPath,
            [cli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
            { cwd: this.root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
          );
          for (const stream of [child.stdout, child.stderr])
            stream?.on('data', chunk => {
              if (text.length < 8000) text += chunk;
            });
          // An install that never ends (a network that hangs) is stopped: the settings say it.
          let late = false;
          const timer = setTimeout(() => {
            late = true;
            child.kill?.();
          }, this.installTime);
          child.once('error', error => {
            clearTimeout(timer);
            reject(error);
          });
          child.once('close', code => {
            clearTimeout(timer);
            if (late) reject(Error('trop longue, arrêtée après 10 minutes'));
            else if (code === 0) resolve(text);
            else reject(Object.assign(Error(short(text.split('\n').filter(Boolean).at(-1))), { code }));
          });
        });
        this.library = null;
        const { pinned, installed } = await this.#versions();
        if (installed !== pinned) throw problem('La bibliothèque Claude ne s’est pas installée à la bonne version.');
      } catch (error) {
        this.installError = error.status
          ? error.message
          : `L’installation de la bibliothèque Claude a échoué (${short(error.message)}). Vérifiez la connexion à Internet, puis recommencez.`;
      } finally {
        this.installing = null;
      }
    })();
    return this.installing;
  }
  async #client(key, { retries = this.retries } = {}) {
    if (!key) throw problem('Associez d’abord votre clé d’API Claude dans Paramètres › Moodix AI.', 409);
    if (!this.library) {
      if ((await this.status()).library !== 'ready')
        throw problem(
          'La bibliothèque officielle de Claude n’est pas installée : installez-la dans Paramètres › Moodix AI.',
          409,
        );
      try {
        this.library = await this.load();
      } catch {
        throw problem(
          'La bibliothèque officielle de Claude ne se charge pas : réinstallez-la dans Paramètres › Moodix AI.',
          409,
        );
      }
    }
    const Anthropic = this.library.default ?? this.library.Anthropic;
    // The key and the address given, never what the environment of this computer holds.
    return {
      Anthropic,
      client: new Anthropic({ apiKey: key, authToken: null, baseURL: this.baseURL, maxRetries: retries }),
    };
  }
  /**
   * A failure of the library in the user's words (always 502 for the page, never its 401).
   * `during`: in the middle of the answer, where a lost connection is an answer cut short.
   * `signal`: the one of the request, whose reason tells a time passed from a stop of the user.
   */
  explain(error, { model, Anthropic, during = false, signal } = {}) {
    if (error?.status && !(Anthropic && error instanceof Anthropic.APIError)) return error;
    if (
      error?.name === 'AbortError' ||
      error?.name === 'TimeoutError' ||
      (Anthropic?.APIUserAbortError && error instanceof Anthropic.APIUserAbortError)
    )
      // The library says « aborted » for both: a time limit passed is no stop of the user.
      return error?.name === 'TimeoutError' || signal?.reason?.name === 'TimeoutError'
        ? networkFailure({ name: 'TimeoutError' }, CLAUDE_HOST)
        : Object.assign(new Error('Réponse interrompue.'), { name: 'AbortError' });
    const said = short(error?.error?.error?.message ?? error?.message);
    const told = said ? ` (${said})` : '';
    // The connection lost in the middle of the answer (« terminated »): said as such.
    if (
      during &&
      !(Anthropic && error instanceof Anthropic.APIError && !(error instanceof Anthropic.APIConnectionError))
    )
      return problem('La connexion à Claude a été coupée pendant la réponse. La réponse reçue est conservée.', 502);
    // No credit left (402, billing_error), or a balance too low (400): said as such.
    const credit = problem(
      'Crédit épuisé sur votre compte Claude Console : rechargez-le (console.anthropic.com › Billing).',
      502,
    );
    if (error?.status === 402 || error?.error?.error?.type === 'billing_error') return credit;
    if (Anthropic) {
      if (error instanceof Anthropic.AuthenticationError)
        return problem(
          'La clé d’API Claude est refusée. Vérifiez-la dans Paramètres › Moodix AI (console.anthropic.com › API Keys).',
          502,
        );
      if (error instanceof Anthropic.PermissionDeniedError)
        return problem(`Claude refuse l’accès avec cette clé${told}.`, 502);
      if (error instanceof Anthropic.NotFoundError)
        return problem(
          `Modèle Claude inconnu : « ${model} »${told}. Choisissez-en un autre dans la barre du chat.`,
          502,
        );
      if (error instanceof Anthropic.RateLimitError)
        return problem(
          `Limite d’utilisation de Claude atteinte${told}. Attendez un peu, ou vérifiez les limites de votre compte.`,
          502,
        );
      if (error instanceof Anthropic.BadRequestError)
        return /credit balance/i.test(said) ? credit : problem(`Claude refuse la demande${told}.`, 502);
      if (error instanceof Anthropic.InternalServerError)
        return problem(
          `Claude est surchargé ou en panne passagère (erreur ${error.status})${told}. Réessayez dans un moment.`,
          502,
        );
      if (error instanceof Anthropic.APIConnectionError) return networkFailure(error.cause ?? error, CLAUDE_HOST);
      if (error instanceof Anthropic.APIError) return problem(`Claude a répondu par une erreur${told}.`, 502);
    }
    return problem(`Claude a répondu par une erreur${told}.`, 502);
  }
  /**
   * The models of the account the key opens, with what each takes: [{ id, name, efforts, vision }].
   * Only those with adaptive reflection (the current ones); the known ones when none is listed.
   */
  async models(key, { signal } = {}) {
    const { client, Anthropic } = await this.#client(key);
    const found = [];
    try {
      for await (const model of client.models.list({ limit: 100 }, { signal })) {
        const caps = model.capabilities ?? {};
        if (caps.thinking?.types?.adaptive?.supported === false) continue;
        const efforts = CLAUDE_EFFORTS.filter(level => caps.effort?.[level]?.supported !== false);
        found.push({
          id: model.id,
          name: model.display_name || model.id,
          efforts: caps.effort?.supported === false ? [] : efforts,
          vision: caps.image_input?.supported !== false,
          ...(Number.isInteger(model.max_input_tokens) ? { context: model.max_input_tokens } : {}),
        });
      }
    } catch (error) {
      throw this.explain(error, { model: '', Anthropic, signal });
    }
    // Retired or older models (no adaptive reflection, an older family) are left: Moodix asks the current way.
    const current = found.filter(
      model => /^claude-(opus|sonnet|haiku|fable|mythos)-\d/.test(model.id) && !/-20\d{6}$/.test(model.id),
    );
    return current.length
      ? current
      : CLAUDE_MODELS.map(model => ({ ...model, efforts: [...CLAUDE_EFFORTS], vision: true }));
  }
  /**
   * Asks Claude: `body` as the chat completions take it (chatPayload), answered as them
   * (lib/chat-model.mjs, ChatModel.request). Its stream when `body.stream`, else its JSON.
   */
  async respond(body, { model, key, effort, quick = '', signal } = {}) {
    const { client, Anthropic } = await this.#client(key);
    const { betas, ...params } = claudeRequest(body, { model, effort, quick });
    const explain = (error, during = false) => this.explain(error, { model, Anthropic, during, signal });
    let events;
    try {
      events = betas
        ? await client.beta.messages.create({ ...params, betas, stream: true }, { signal })
        : await client.messages.create({ ...params, stream: true }, { signal });
    } catch (error) {
      throw explain(error);
    }
    const chunks = claudeChunks(events, {
      explain,
      stopped: () => (signal?.aborted ? explain(signal.reason ?? { name: 'AbortError' }) : null),
    });
    if (body.stream)
      return new Response(sseOf(chunks), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      });
    let content = '';
    for await (const chunk of chunks) content += chunk.choices?.[0]?.delta?.content ?? '';
    return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
  }
}
