import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { History } from './lib/history.mjs';
import { ComfyClient, normalizeComfyUrl } from './lib/comfy-client.mjs';
import { WorkflowCatalog } from './lib/comfy-workflows.mjs';
import { ComfyGallery } from './lib/comfy-gallery.mjs';
import { ToolRuntime, collectToolCalls } from './lib/tool-runtime.mjs';
import { nativeFields } from './lib/native-messages.mjs';
import { readSSE } from './public/stream.mjs';
import { Engine, defaults, normalizeConfig, problem } from './lib/engine.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const maxBody = 20 * 1024 * 1024;
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/stream.mjs', ['stream.mjs', 'text/javascript; charset=utf-8']],
  ['/model-ready.mjs', ['model-ready.mjs', 'text/javascript; charset=utf-8']],
  ['/images.mjs', ['images.mjs', 'text/javascript; charset=utf-8']],
  ['/comfy-ui.mjs', ['comfy-ui.mjs', 'text/javascript; charset=utf-8']],
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

function chatPayload(input, vision, maxOutputTokens) {
  if (!input || !Array.isArray(input.messages) || !input.messages.length || input.messages.length > 100) throw problem('La conversation doit contenir entre 1 et 100 messages. Recommence une conversation si nécessaire.');
  const messages = input.messages.map((message, index) => {
    if (!message || !['system', 'user', 'assistant', 'tool'].includes(message.role) || (message.role === 'system' && index !== 0)) throw problem('Rôle de message invalide.');
    let content = message.content;
    if (typeof content === 'string') {
      if (content.length > 200000) throw problem('Un message est trop long.');
    } else if (Array.isArray(content) && content.length > 0 && content.length <= 65 && message.role === 'user') {
      let imageCount = 0;
      content = content.map((part) => {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text.length <= 200000) return { type: 'text', text: part.text };
        if (part?.type !== 'image_url' || !vision) throw problem('Pour envoyer une image, charge le projecteur de vision avec le modèle.');
        if (++imageCount > 64) throw problem('Un message peut contenir au maximum 64 images.');
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
    const result = { role: message.role, content, ...nativeFields(message) };
    if (message.role === 'assistant' && typeof message.reasoning_content === 'string') {
      if (message.reasoning_content.length > 200000) throw problem('Le raisonnement conservé est trop long. Recommence une conversation.');
      result.reasoning_content = message.reasoning_content;
    }
    return result;
  });
  const unresolved=new Set();
  for(const message of messages){
    if(message.tool_calls){if(unresolved.size)throw problem('Résultat d’outil manquant.');for(const call of message.tool_calls)unresolved.add(call.id);}
    else if(message.role==='tool'){if(!unresolved.delete(message.tool_call_id))throw problem('Résultat d’outil sans appel correspondant.');}
    else if(unresolved.size)throw problem('Résultat d’outil manquant.');
  }
  if(unresolved.size)throw problem('Résultat d’outil manquant.');
  const last = messages.at(-1);
  if (!['user','tool'].includes(last.role) || (typeof last.content === 'string' && !last.content.trim())) throw problem('Écris un message ou joins une image.');
  return {
    model: 'local', messages, stream: true, temperature: 0.7, top_p: 0.95, top_k: 20,
    max_tokens: maxOutputTokens, reasoning_format: 'deepseek',
    chat_template_kwargs: { enable_thinking: input.thinking !== false },
  };
}

export async function createApplication({ port = 8787, dataDir = join(root, 'data'), historyDir = dataDir === join(root, 'data') ? join(root, 'history') : join(dataDir, 'history'), spawnProcess } = {}) {
  await mkdir(dataDir, { recursive: true });
  const configPath = join(dataDir, 'config.json');
  let config = { ...defaults };
  let configWarning = '';
  try { config = normalizeConfig(JSON.parse(await readFile(configPath, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') configWarning = 'La configuration enregistrée est illisible. Renseigne à nouveau les chemins.'; }
  const preferencesPath = join(dataDir, 'preferences.json');
  let preferences = { theme: 'dark', saveHistory: false };
  try {
    const saved = JSON.parse(await readFile(preferencesPath, 'utf8'));
    if (['dark', 'light'].includes(saved?.theme)) preferences.theme = saved.theme;
    if (typeof saved?.saveHistory === 'boolean') preferences.saveHistory = saved.saveHistory;
  } catch { /* Missing or damaged preferences use the default appearance. */ }
  let savingPreferences = false;
  let disablingHistory = false;
  let clearingHistory = false;
  let persistingGallery = false;
  let galleryBatch = Promise.resolve();
  const history = new History(historyDir);
  const token = randomBytes(32).toString('hex');
  const engine = new Engine({ spawnProcess, cacheDir: join(dataDir, 'model-cache') });
  const comfyPath=join(dataDir,'comfy.json');
  let comfy={enabled:false,baseUrl:'http://127.0.0.1:8188',autoAllow:false,maxIterations:3};
  function normalizeComfy(value){
    if(!value||typeof value.enabled!=='boolean'||typeof value.autoAllow!=='boolean'||!Number.isInteger(value.maxIterations)||value.maxIterations<1||value.maxIterations>10)throw problem('Configuration ComfyUI invalide.');
    return {enabled:value.enabled,baseUrl:normalizeComfyUrl(value.baseUrl),autoAllow:value.autoAllow,maxIterations:value.maxIterations};
  }
  try{comfy=normalizeComfy(JSON.parse(await readFile(comfyPath,'utf8')));}catch{}
  let savingComfy=false;
  async function saveComfy(value){
    if(savingComfy)throw problem('Enregistrement ComfyUI en cours.',409);
    const next=normalizeComfy(value);savingComfy=true;
    try{await writeFile(`${comfyPath}.tmp`,JSON.stringify(next,null,2),{mode:0o600});await rename(`${comfyPath}.tmp`,comfyPath);comfy=next;}finally{savingComfy=false;}
  }
  const catalog=new WorkflowCatalog(join(dataDir,'workflows'));
  const gallery=new ComfyGallery({historyDir});
  const runtime=new ToolRuntime({engine,catalog,gallery,getConfig:()=>comfy,engineConfig:()=>config,saveConfig:saveComfy,persist:()=>preferences.saveHistory});
  const status=()=>({...engine.status(),toolJob:runtime.active?runtime.status():null});
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
        let contents = await readFile(join(root, 'public', file));
        if (file === 'index.html') contents = contents.toString('utf8').replace('data-theme="dark"', `data-theme="${preferences.theme}"`);
        res.writeHead(200, { 'Content-Type': mime });
        return res.end(contents);
      }
      if (path === '/favicon.ico' && req.method === 'GET') { res.writeHead(204); return res.end(); }
      if (path === '/api/bootstrap' && req.method === 'GET') {
        return send(200, { token, config, preferences, status: status(), comfy, workflows: await catalog.list(), platform: process.platform, warning: configWarning });
      }
      if (!path.startsWith('/api/')) throw problem('Page introuvable.', 404);
      if (req.headers.authorization !== `Bearer ${token}`) throw problem('Accès refusé. Recharge la page.', 401);
      if (path === '/api/status' && req.method === 'GET') return send(200, status());
      if(req.method==='GET'&&path==='/api/comfy')return send(200,{config:comfy,workflows:await catalog.list()});
      if(req.method==='GET'&&path==='/api/comfy/status')return send(200,await new ComfyClient(comfy.baseUrl).status());
      if(req.method==='GET'&&path==='/api/comfy/workflows')return send(200,{workflows:await new ComfyClient(comfy.baseUrl).workflows()});
      if(req.method==='GET'&&path==='/api/tools/job')return send(200,runtime.status());
      if(req.method==='GET'&&path.startsWith('/api/gallery/')){
        const [, , ,conversationId,runId,index]=path.split('/');
        if(!runId)return send(200,await gallery.list(conversationId));
        const record=await gallery.get(conversationId,runId);
        if(index===undefined)return send(200,record);
        if(!/^\d+$/.test(index)||!record.outputs[Number(index)])throw problem('Image introuvable.',404);
        const original=await new ComfyClient(record.comfyUrl).original(record.outputs[Number(index)].source);
        res.writeHead(200,{'Content-Type':original.mime,'Content-Disposition':`inline; filename="${original.filename.replace(/[^A-Za-z0-9._-]/g,'_')}"`});return res.end(original.bytes);
      }
      if (req.method === 'GET' && (path === '/api/history' || path.startsWith('/api/history/'))) {
        if (!preferences.saveHistory) throw problem('L’historique est désactivé.', 403);
        return send(200, path === '/api/history' ? await history.list() : await history.read(path.slice('/api/history/'.length)));
      }
      if (req.method !== 'POST') throw problem('Méthode non prise en charge.', 405);
      const body = await jsonBody(req);
      if(path==='/api/tools/recover')return send(200,await runtime.recover());
      if(path==='/api/tools/cancel')return send(200,runtime.cancel());
      if(path==='/api/tools/execute'){
        if(clearingHistory||persistingGallery||savingComfy)throw problem('Une opération est en cours.',409);
        return send(202,await runtime.execute(body));
      }
      if(path==='/api/gallery/persist'){
        if(!preferences.saveHistory||disablingHistory)throw problem('L’historique est désactivé.',403);
        if(runtime.active||clearingHistory||persistingGallery)throw problem('Attends la fin de l’opération en cours.',409);
        persistingGallery=true;
        galleryBatch=(async()=>{
          const {runs}=await gallery.list(body.conversationId);
          for(const record of runs)await gallery.put(record,{persist:true});
          return {saved:runs.length};
        })();
        try{return send(200,await galleryBatch);}
        finally{persistingGallery=false;}
      }
      if(path==='/api/gallery/analysis'||path==='/api/gallery/review'){
        if(runtime.active||clearingHistory||disablingHistory)throw problem('Attends la fin de l’opération en cours.',409);
        const record=await gallery.get(body.conversationId,body.id);
        if(path==='/api/gallery/review'){
          if(typeof body.text!=='string'||body.text.length>200000||!['reviewed','correction_requested'].includes(body.status))throw problem('Analyse de galerie invalide.');
          record.analysis={text:body.text,status:body.status,checkedAt:new Date().toISOString()};
        }else{
        if(!Array.isArray(body.images)||body.images.length!==record.outputs.length)throw problem('Copies d’analyse invalides.');
        record.outputs=record.outputs.map((output,i)=>({...output,analysisDataUrl:body.images[i]}));
        }
        return send(200,await gallery.put(record,{persist:preferences.saveHistory}));
      }
      if(path.startsWith('/api/comfy/')){
        if(runtime.active||engine.busy||clearingHistory)throw problem('Attends la fin de l’opération GPU.',409);
        if(path==='/api/comfy/config'){await saveComfy(body);return send(200,{config:comfy});}
        if(path==='/api/comfy/import')return send(200,await catalog.save(body));
        if(path==='/api/comfy/remove'){await catalog.remove(body.id);return send(200,{removed:true});}
        throw problem('Route introuvable.',404);
      }
      if (path === '/api/preferences') {
        if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length || Object.keys(body).some((key) => !['theme', 'saveHistory'].includes(key))) throw problem('Préférences invalides.');
        if ('theme' in body && !['dark', 'light'].includes(body.theme)) throw problem('Choisis le mode jour ou nuit.');
        if ('saveHistory' in body && typeof body.saveHistory !== 'boolean') throw problem('Choix d’historique invalide.');
        if ((runtime.active || persistingGallery) && 'saveHistory' in body) throw problem('Attends la fin de la génération ComfyUI.',409);
        if (savingPreferences) throw problem('Préférences en cours d’enregistrement.', 409);
        const next = { ...preferences, ...body };
        savingPreferences = true;
        disablingHistory = body.saveHistory === false;
        try {
          if (disablingHistory) await history.flush();
          await writeFile(`${preferencesPath}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
          await rename(`${preferencesPath}.tmp`, preferencesPath);
          preferences = next;
        } finally { savingPreferences = false; disablingHistory = false; }
        return send(200, { preferences });
      }
      if (path === '/api/history/clear') {
        if (body?.confirm !== true) throw problem('Confirme la suppression de l’historique.');
        if (persistingGallery || runtime.active || clearingHistory || disablingHistory || savingPreferences || engine.busy || ['loading', 'stopping'].includes(engine.state)) throw problem('Attends la fin de l’opération en cours avant de supprimer l’historique.', 409);
        clearingHistory = true;
        try { await gallery.pending; await history.clear(); runtime.clear(); return send(200, { cleared: true }); }
        finally { clearingHistory = false; }
      }
      if (path === '/api/history/save') {
        if(runtime.active)throw problem('Attends la fin de la génération ComfyUI.',409);
        if (clearingHistory) throw problem('Suppression de l’historique en cours.', 409);
        if (!preferences.saveHistory) throw problem('L’historique est désactivé.', 403);
        if (disablingHistory) throw problem('Désactivation de l’historique en cours.', 409);
        return send(200, { conversation: await history.save(body) });
      }
      if (path === '/api/config') {
        if (runtime.active || saving || engine.child || engine.state === 'loading' || engine.state === 'stopping') throw problem('Arrête le moteur avant de modifier sa configuration.', 409);
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
        if (runtime.active) throw problem('ComfyUI utilise le GPU. Attends la fin de la génération.',409);
        if (saving) throw problem('Configuration en cours d’enregistrement.', 409);
        await engine.start(config);
        return send(202, engine.status());
      }
      if (path === '/api/stop') { if(runtime.active)throw problem('Annule la génération ComfyUI avec le bouton d’interruption.',409); await engine.stop(); return send(200, status()); }
      if (path !== '/api/chat') throw problem('Route introuvable.', 404);
      if(runtime.active)throw problem('ComfyUI utilise le GPU.',409);
      if (engine.state !== 'ready') throw problem('Le moteur n’est pas prêt. Configure-le puis démarre-le.', 503);
      if (engine.busy) throw problem('Une réponse est déjà en cours.', 409);
      const payload = chatPayload(body, engine.vision, config.maxOutputTokens);
      const controller = new AbortController();
      engine.activeRequest = controller;
      engine.busy = true;
      const onClose = () => controller.abort();
      res.once('close', onClose);
      try {
      const definition=comfy.enabled&&body.tools!==false?await catalog.definition():null;
      if(definition){
        payload.tools=[definition];payload.tool_choice='auto';payload.parallel_tool_calls=false;
        const instruction=`Tu as accès à l’outil local comfy_generate_image. Utilise un véritable appel de fonction uniquement pour générer/modifier une image demandée par l’utilisateur, jamais une imitation en texte. Un seul appel à la fois. Après chaque résultat, examine l’image fournie, compare à l’instruction originale et aux références, indique les écarts et corrige le prompt seulement si utile. Maximum ${comfy.maxIterations} générations par message. Si l’outil échoue ou est refusé, explique-le sans prétendre avoir généré une image. reference_image est l’index à partir de 0 des images utilisateur dans l’ordre chronologique. Les copies d’analyse sont réduites : ne prétends pas vérifier les détails invisibles. Workflows : ${JSON.stringify((await catalog.list()).map(w=>({id:w.id,name:w.name,description:w.description,parameters:Object.keys(w.bindings),requiresImage:w.requiresImage})))}`;
        if(payload.messages[0].role==='system')payload.messages[0].content+='\n'+instruction;
        else payload.messages.unshift({role:'system',content:instruction});
      }
        const upstream = await fetch(`${engine.base}/v1/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${engine.apiKey}` },
          body: JSON.stringify(payload), signal: controller.signal,
        });
        if (!upstream.ok) {
          const detail = (await upstream.text()).slice(0, 3000);
          throw problem(`Le moteur refuse la requête (${upstream.status}). ${detail}`, 502);
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
        const calls=[];let terminalReason='';
        const emit=async(event)=>{
          if(res.destroyed)return;
          if(!res.write(`data: ${JSON.stringify(event)}\n\n`))await new Promise(done=>{const finish=()=>{res.off('drain',finish);res.off('close',finish);done();};res.once('drain',finish);res.once('close',finish);});
        };
        await readSSE(upstream.body,async(event)=>{collectToolCalls(calls,event.choices?.[0]?.delta||{});if(event.choices?.[0]?.finish_reason)terminalReason=event.choices[0].finish_reason;await emit(event);});
        if(calls.length){
          if(terminalReason!=='tool_calls')throw problem('L’appel d’outil du modèle est incomplet ou tronqué. Aucune génération lancée.',502);
          if(!definition)throw problem('Le moteur a demandé un outil indisponible.',502);
          await emit({local_tool_request:await runtime.request(calls,{conversationId:body.conversationId,turnId:body.turnId,messages:body.messages})});
        }
        res.write('data: [DONE]\n\n');
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
      if (res.headersSent) { res.end(`data: ${JSON.stringify({error:error.message})}\n\ndata: [DONE]\n\n`); return; }
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
      await runtime.close();
      await engine.stop();
      server.closeAllConnections();
      await history.flush();
      await galleryBatch.catch(()=>{});
      await gallery.pending;
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
