import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { problem } from './engine.mjs';
import { networkFailure } from './chat-model.mjs';
import { PRESETS, apiKey } from './remote-models.mjs';
import { page } from './chatgpt.mjs';

/**
 * « Se connecter à OpenRouter »: a key of the user's OpenRouter account made for Moodix without
 * copying it, by the OAuth PKCE way of OpenRouter (openrouter.ai/docs/guides/overview/auth/oauth).
 * The page of OpenRouter opens with a challenge; the browser comes back to a page of Moodix on
 * http://localhost:<port> (any port, no registration of the application); the code and its
 * verifier are exchanged for a key (POST /api/v1/auth/keys), kept as a pasted one
 * (lib/remote-models.mjs). That key spends the credits of the account until it is deleted there;
 * the free models need none.
 */
// The free models router of OpenRouter: one of its free models, able to call tools when asked.
export const FREE_ROUTER = 'openrouter/free';
const CALLBACK = '/openrouter/callback';
// A code expires ten minutes after it is given.
const SIGN_IN_MS = 10 * 60_000;
const base64url = bytes => Buffer.from(bytes).toString('base64url');
const short = text =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
const STALE = 'Cette page de connexion ne correspond plus à une demande de Moodix. Recommencez depuis ses Paramètres.';

/** A refusal of the exchange of the code, in the user's words (a 502 for the page). */
export function exchangeFailure(status, said) {
  let message = '';
  try {
    const body = typeof said === 'string' ? JSON.parse(said) : said;
    message = body?.error?.message ?? body?.message ?? (typeof body?.error === 'string' ? body.error : '');
  } catch {
    message = short(said);
  }
  const told = message ? ` (${short(message)})` : '';
  if (status === 403 && /expir/i.test(message))
    return problem('Le code de connexion d’OpenRouter a expiré (dix minutes). Recommencez.', 502);
  if (status === 403) return problem(`OpenRouter refuse le code de connexion${told}. Recommencez.`, 502);
  if (status >= 500)
    return problem(
      `Le service OpenRouter ne répond pas pour l’instant (erreur ${status}). Réessayez dans un moment.`,
      502,
    );
  return problem(`OpenRouter refuse la connexion (erreur ${status})${told}. Recommencez.`, 502);
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}
/**
 * A page of Moodix where the browser finds « localhost »: 127.0.0.1, and ::1 on the same port when
 * this computer has it (a browser may try one before the other). A port another program holds on
 * ::1 is left for another, so that the code comes back here only.
 */
async function loopback(handle) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const first = http.createServer(handle);
    await listen(first, 0, '127.0.0.1');
    const port = first.address().port,
      second = http.createServer(handle);
    try {
      await listen(second, port, '::1');
      return { port, servers: [first, second] };
    } catch (error) {
      if (error.code !== 'EADDRINUSE') return { port, servers: [first] };
      first.close();
    }
  }
  throw problem('Moodix ne trouve pas de port libre pour revenir de la page d’OpenRouter. Recommencez.', 500);
}

export class OpenRouterSignIn {
  constructor({
    remotes,
    fetchImpl = fetch,
    // Where the page of consent is, and the API the key is for (tests pass their own server).
    site = 'https://openrouter.ai',
    api = PRESETS.openrouter.baseUrl,
    // The name the key takes in the account of the user (openrouter.ai, Keys).
    label = 'Moodix',
    // Opens the page of OpenRouter in the browser of the system.
    openUrl = () => {},
  }) {
    Object.assign(this, { remotes, fetchImpl, site, api, label, openUrl });
    this.pending = null;
    this.lastError = '';
    // The connection the last sign-in made: the settings open its editor to choose the model.
    this.created = null;
  }
  /** What the settings show: a sign-in waiting, what stopped the last one, the connection it made. */
  status() {
    return { pending: Boolean(this.pending), error: this.lastError, created: this.created };
  }
  /**
   * Starts the sign-in: a page of Moodix listens on localhost for the browser coming back, and the
   * page of OpenRouter opens. { url } for the settings, which offer it again if no browser opened.
   */
  async start() {
    this.#end();
    const state = base64url(randomBytes(24)),
      verifier = base64url(randomBytes(32)),
      challenge = base64url(createHash('sha256').update(verifier).digest());
    const pending = { state, verifier, servers: [], timer: null, controller: new AbortController() };
    const { port, servers } = await loopback((req, res) => void this.#callback(req, res, pending));
    pending.servers = servers;
    const params = new URLSearchParams({
      callback_url: `http://localhost:${port}${CALLBACK}`,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      key_label: this.label,
      state,
    });
    const url = `${this.site}/auth?${params}`;
    pending.timer = setTimeout(() => {
      if (this.pending !== pending) return;
      this.lastError = 'La connexion à OpenRouter n’a pas été terminée dans les dix minutes. Recommencez.';
      this.#end();
    }, SIGN_IN_MS);
    pending.timer.unref?.();
    this.pending = pending;
    this.lastError = '';
    this.created = null;
    try {
      this.openUrl(url);
    } catch {
      // The settings offer the address all the same.
    }
    return { url };
  }
  /**
   * The sign-in stopped: its page of Moodix stops listening, an exchange under way is dropped.
   * `gently`: once the page that answers the browser is sent (its connection closes with it).
   */
  #end({ gently = false } = {}) {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    clearTimeout(pending.timer);
    if (!gently) pending.controller.abort();
    for (const server of pending.servers) {
      server.close();
      if (!gently) server.closeAllConnections?.();
    }
  }
  cancel() {
    this.#end();
  }
  close() {
    this.#end();
  }
  async #callback(req, res, pending) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== CALLBACK || req.method !== 'GET') {
      res.writeHead(404);
      return res.end();
    }
    if (this.pending !== pending) return page(res, 400, STALE);
    const code = url.searchParams.get('code'),
      state = url.searchParams.get('state');
    if (!code) {
      // Refused in the page of OpenRouter, which then gives no state back: no key was made.
      if (state && state !== pending.state) return page(res, 400, STALE);
      this.lastError = 'Connexion refusée dans la page d’OpenRouter : aucune clé n’a été créée.';
      page(res, 400, this.lastError);
      return this.#end({ gently: true });
    }
    if (state !== pending.state) return page(res, 400, STALE);
    // A code is used once: the same page opened again while it is exchanged waits for nothing.
    if (pending.exchanging) return page(res, 409, 'La connexion est déjà en cours : revenez à Moodix.');
    pending.exchanging = true;
    try {
      const key = await this.#exchange(code, pending);
      // Kept as a pasted key; the free router until the user chooses a model in the editor.
      const saved = await this.remotes.save({
        preset: 'openrouter',
        name: PRESETS.openrouter.name,
        baseUrl: this.api,
        model: FREE_ROUTER,
        key,
      });
      this.created = saved.id;
      this.lastError = '';
      page(
        res,
        200,
        'Moodix est connecté à votre compte OpenRouter. Vous pouvez fermer cet onglet et revenir à Moodix pour choisir le modèle.',
      );
    } catch (error) {
      this.lastError = error.status ? error.message : `La connexion à OpenRouter a échoué : ${short(error.message)}`;
      page(res, 400, this.lastError);
    } finally {
      if (this.pending === pending) this.#end({ gently: true });
    }
  }
  /** The code and its verifier given for a key of the account. */
  async #exchange(code, pending) {
    const signal = pending.controller.signal;
    let response;
    try {
      response = await this.fetchImpl(`${this.api}/auth/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: pending.verifier, code_challenge_method: 'S256' }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      });
    } catch (error) {
      if (signal.aborted) throw problem('Connexion à OpenRouter annulée : aucune clé n’a été enregistrée.');
      throw networkFailure(error, new URL(this.api).host);
    }
    const said = await response.text().catch(() => '');
    if (!response.ok) throw exchangeFailure(response.status, said);
    let key;
    try {
      key = JSON.parse(said)?.key;
    } catch {
      key = undefined;
    }
    if (typeof key !== 'string' || !key) throw problem('OpenRouter n’a pas donné de clé. Recommencez.', 502);
    return apiKey(key);
  }
}
