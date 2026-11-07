import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { Engine, defaults, normalizeConfig, problem } from './lib/engine.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const maxBody = 20 * 1024 * 1024;
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/stream.mjs', ['stream.mjs', 'text/javascript; charset=utf-8']],
  ['/markdown.mjs', ['markdown.mjs', 'text/javascript; charset=utf-8']],
]);

async function jsonBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw problem('Le format JSON est attendu.', 415);
  if (Number(req.headers['content-length'] || 0) > maxBody) throw problem('La requête dépasse 20 Mo. Réduis le nombre d’images ou recommence une conversation.', 413);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBody) throw problem('La requête dépasse 20 Mo.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw problem('Le JSON reçu est invalide.'); }
}

function chatPayload(input, vision) {
  if (!input || !Array.isArray(input.messages) || !input.messages.length || input.messages.length > 100) throw problem('La conversation doit contenir entre 1 et 100 messages. Recommence une conversation si nécessaire.');
  const messages = input.messages.map((message, index) => {
    if (!message || !['system', 'user', 'assistant'].includes(message.role) || (message.role === 'system' && index !== 0)) throw problem('Rôle de message invalide.');
    let content = message.content;
    if (typeof content === 'string') {
      if (content.length > 200000) throw problem('Un message est trop long.');
    } else if (Array.isArray(content) && content.length > 0 && content.length <= 5 && message.role === 'user') {
      let imageCount = 0;
      content = content.map((part) => {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text.length <= 200000) return { type: 'text', text: part.text };
        if (part?.type !== 'image_url' || !vision) throw problem('Pour envoyer une image, charge le projecteur de vision avec le modèle.');
        if (++imageCount > 3) throw problem('Un message peut contenir au maximum trois images.');
        const url = part.image_url?.url;
        if (typeof url !== 'string' || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(url)) throw problem('Seules les images PNG/JPEG locales sont acceptées.');
        const comma = url.indexOf(',');
        const bytes = Buffer.from(url.slice(comma + 1), 'base64');
        if (bytes.length > 5 * 1024 * 1024) throw problem('Une image préparée dépasse 5 Mo.');
        const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        if ((!png && !jpeg) || (url.startsWith('data:image/png') && !png) || (url.startsWith('data:image/jpeg') && !jpeg)) throw problem('Le contenu d’une image est invalide.');
        return { type: 'image_url', image_url: { url } };
      });
    } else throw problem('Contenu de message invalide.');
    const result = { role: message.role, content };
    if (message.role === 'assistant' && typeof message.reasoning_content === 'string') {
      if (message.reasoning_content.length > 200000) throw problem('Le raisonnement conservé est trop long. Recommence une conversation.');
      result.reasoning_content = message.reasoning_content;
    }
    return result;
  });
  const last = messages.at(-1);
  if (last.role !== 'user' || (typeof last.content === 'string' && !last.content.trim())) throw problem('Écris un message ou joins une image.');
  return {
    model: 'local', messages, stream: true, temperature: 0.7, top_p: 0.95, top_k: 20,
    max_tokens: 4096, reasoning_format: 'deepseek',
    chat_template_kwargs: { enable_thinking: input.thinking !== false },
  };
}

export async function createApplication({ port = 8787, dataDir = join(root, 'data'), spawnProcess } = {}) {
  await mkdir(dataDir, { recursive: true });
  const configPath = join(dataDir, 'config.json');
  let config = { ...defaults };
  let configWarning = '';
  try { config = normalizeConfig(JSON.parse(await readFile(configPath, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') configWarning = 'La configuration enregistrée est illisible. Renseigne à nouveau les chemins.'; }
  const token = randomBytes(32).toString('hex');
  const engine = new Engine({ spawnProcess, cacheDir: join(dataDir, 'model-cache') });
  let url;
  let saving = false;

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const send = (status, body) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    try {
      const expected = new URL(url);
      const allowedHosts = [expected.host, `localhost:${expected.port}`];
      if (!allowedHosts.includes(req.headers.host)) throw problem('Hôte refusé.', 403);
      if (req.headers.origin && ![url, `http://localhost:${expected.port}`].includes(req.headers.origin)) throw problem('Origine refusée.', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw problem('Requête externe refusée.', 403);
      const path = new URL(req.url, url).pathname;
      if (req.method === 'GET' && staticFiles.has(path)) {
        const [file, mime] = staticFiles.get(path);
        const contents = await readFile(join(root, 'public', file));
        res.writeHead(200, { 'Content-Type': mime });
        return res.end(contents);
      }
      if (path === '/favicon.ico' && req.method === 'GET') { res.writeHead(204); return res.end(); }
      if (path === '/api/bootstrap' && req.method === 'GET') {
        return send(200, { token, config, status: engine.status(), platform: process.platform, warning: configWarning });
      }
      if (!path.startsWith('/api/')) throw problem('Page introuvable.', 404);
      if (req.headers.authorization !== `Bearer ${token}`) throw problem('Accès refusé. Recharge la page.', 401);
      if (path === '/api/status' && req.method === 'GET') return send(200, engine.status());
      if (req.method !== 'POST') throw problem('Méthode non prise en charge.', 405);
      const body = await jsonBody(req);
      if (path === '/api/config') {
        if (saving || engine.child || engine.state === 'loading' || engine.state === 'stopping') throw problem('Arrête le moteur avant de modifier sa configuration.', 409);
        const next = normalizeConfig(body);
        saving = true;
        try {
          await writeFile(`${configPath}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
          await rename(`${configPath}.tmp`, configPath);
          config = next;
          configWarning = '';
        } finally { saving = false; }
        return send(200, { config });
      }
      if (path === '/api/start') {
        if (saving) throw problem('Configuration en cours d’enregistrement.', 409);
        await engine.start(config);
        return send(202, engine.status());
      }
      if (path === '/api/stop') { await engine.stop(); return send(200, engine.status()); }
      if (path !== '/api/chat') throw problem('Route introuvable.', 404);
      if (engine.state !== 'ready') throw problem('Le moteur n’est pas prêt. Configure-le puis démarre-le.', 503);
      if (engine.busy) throw problem('Une réponse est déjà en cours.', 409);
      const payload = chatPayload(body, engine.vision);
      const controller = new AbortController();
      engine.activeRequest = controller;
      engine.busy = true;
      const onClose = () => controller.abort();
      res.once('close', onClose);
      try {
        const upstream = await fetch(`${engine.base}/v1/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${engine.apiKey}` },
          body: JSON.stringify(payload), signal: controller.signal,
        });
        if (!upstream.ok) {
          const detail = (await upstream.text()).slice(0, 3000);
          throw problem(`Le moteur refuse la requête (${upstream.status}). ${detail}`, 502);
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
        for await (const chunk of upstream.body) {
          if (res.destroyed) break;
          if (!res.write(chunk)) {
            await new Promise((done) => {
              const cleanup = () => { res.off('drain', finish); res.off('close', finish); done(); };
              const finish = () => cleanup();
              res.once('drain', finish);
              res.once('close', finish);
            });
          }
        }
        res.end();
      } finally {
        res.off('close', onClose);
        if (engine.activeRequest === controller) {
          engine.activeRequest = null;
          engine.busy = false;
        }
      }
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      send(error.status || 500, { error: error.status ? error.message : 'Erreur locale inattendue. Consulte le terminal de l’application.' });
      if (!error.status && error.name !== 'AbortError') console.error(error);
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  await new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); });
  url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    async close() {
      await engine.stop();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

function openBrowser(url) {
  const command = process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
  child.on('error', () => console.log(`Ouvre cette adresse dans ton navigateur : ${url}`));
  child.unref();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    console.error('Atelier local nécessite Node.js 22 ou ultérieur.');
    process.exitCode = 1;
  } else {
    try {
      const app = await createApplication();
      console.log(`\nAtelier local — ${app.url}\nTout reste sur cet ordinateur. Ctrl+C pour arrêter.\n`);
      let closing = false;
      const close = async () => { if (closing) return; closing = true; await app.close(); process.exitCode = 0; };
      process.on('SIGINT', close);
      process.on('SIGTERM', close);
      if (process.argv.includes('--open')) openBrowser(app.url);
    } catch (error) {
      console.error(error.code === 'EADDRINUSE' ? 'Le port 8787 est déjà utilisé. Ferme l’autre instance de l’application.' : error.message);
      process.exitCode = 1;
    }
  }
}
