import {appSources} from './lib/app-sources.mjs';
import {Projects} from './lib/projects.mjs';
import { globalContext } from './lib/global-context.mjs';
import { ModelLibrary, modelFolderName } from './lib/models.mjs';
import { Resources, resourceCatalogPrompt, resourceTool, resourceReadIds } from './lib/resources.mjs';
import { sendResourceMedia } from './lib/resource-media.mjs';
import { countContext } from './lib/context-count.mjs';
import http from 'node:http';
import { compactSession } from './public/update-ui.mjs';
import { checkForUpdates } from './lib/updates.mjs';
import { prepareUpdate, launchInstaller } from './lib/update-install.mjs';
import { atomicJson } from './lib/update-files.mjs';
import { updateSession, readUpdateSession } from './lib/update-session.mjs';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { History } from './lib/history.mjs';
import { discoverComfy, testComfyConnection } from './lib/comfy-discovery.mjs';
import { chooseLocalFile } from './lib/file-picker.mjs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ComfyClient, normalizeComfyUrl } from './lib/comfy-client.mjs';
import { WorkflowCatalog, validateWorkflow } from './lib/comfy-workflows.mjs';
import { ComfyGallery } from './lib/comfy-gallery.mjs';
import { ToolRuntime, collectToolCalls } from './lib/tool-runtime.mjs';
import { nativeFields } from './lib/native-messages.mjs';
import { readSSE } from './public/stream.mjs';
import { Engine, defaults, normalizeConfig, problem } from './lib/engine.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const maxBody = 20 * 1024 * 1024;
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/assets/metallic-grain.png', ['assets/metallic-grain.png', 'image/png']],
  ['/update-ui.mjs', ['update-ui.mjs', 'text/javascript; charset=utf-8']],
  ['/material-light.mjs', ['material-light.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/project-navigation.mjs',['project-navigation.mjs','text/javascript; charset=utf-8']],
  ['/workspace.css',['workspace.css','text/css; charset=utf-8']],
  ['/assets/metallic-surface.svg',['assets/metallic-surface.svg','image/svg+xml']],
  ['/settings-search.mjs',['settings-search.mjs','text/javascript; charset=utf-8']],
  ['/generation-ui.mjs', ['generation-ui.mjs','text/javascript; charset=utf-8']],
  ['/assets-ui.mjs', ['assets-ui.mjs','text/javascript; charset=utf-8']],
  ['/resource-preparation.mjs', ['resource-preparation.mjs','text/javascript; charset=utf-8']],
  ['/copy.mjs', ['copy.mjs', 'text/javascript; charset=utf-8']],
  ['/settings-guard.mjs', ['settings-guard.mjs', 'text/javascript; charset=utf-8']],
  ['/context-meter.mjs', ['context-meter.mjs', 'text/javascript; charset=utf-8']],
  ['/stream.mjs', ['stream.mjs', 'text/javascript; charset=utf-8']],
  ['/model-ready.mjs', ['model-ready.mjs', 'text/javascript; charset=utf-8']],
  ['/images.mjs', ['images.mjs', 'text/javascript; charset=utf-8']],
  ['/video-plan.mjs',['video-plan.mjs','text/javascript; charset=utf-8']],
  ['/comfy-ui.mjs', ['comfy-ui.mjs', 'text/javascript; charset=utf-8']],
  ['/settings-controls.mjs', ['settings-controls.mjs', 'text/javascript; charset=utf-8']],
  ['/markdown.mjs', ['markdown.mjs', 'text/javascript; charset=utf-8']],
]);

async function jsonBody(req, limit = maxBody) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw problem('Le format JSON est attendu.', 415);
  if (Number(req.headers['content-length'] || 0) > limit) throw problem('La requête dépasse 20 Mo. Réduis le nombre d’images ou recommence une conversation.', 413);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw problem('La requête dépasse 20 Mo.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw problem('Le JSON reçu est invalide.'); }
}

function chatPayload(input, vision, maxOutputTokens, countOnly = false) {
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
  if (!countOnly && (!['user','tool'].includes(last.role) || typeof last.content === 'string' && !last.content.trim())) throw problem('Écris un message ou joins une image.');
  return {
    model: 'local', messages, stream: true, stream_options: { include_usage: true }, temperature: 0.7, top_p: 0.95, top_k: 20,
    max_tokens: maxOutputTokens, reasoning_format: 'deepseek',
    chat_template_kwargs: { enable_thinking: input.thinking !== false },
  };
}

export async function createApplication({ port = 8787, dataDir = join(root, 'data'), publicDir = join(root,'public'), modelsDir = join(root, 'models'), historyDir = dataDir === join(root, 'data') ? join(root, 'history') : join(dataDir, 'history'), spawnProcess, filePicker = chooseLocalFile, comfyDiscovery = discoverComfy, updateChecker = null, updateInstaller = null, managed = false, controlTimeoutMs = 15000, controlHeartbeatMs = 10000, controlReconnectMs = 2000, chatHeartbeatMs = 10000 } = {}) {
  // Keep HTML, scripts and styles paired with this running backend until restart.
  const frontend=new Map(await Promise.all([...staticFiles].map(async([path,[file,mime]])=>[path,{contents:await readFile(join(publicDir,file)),mime,file}])));
  const sources=await appSources(root);
  await mkdir(dataDir, { recursive: true });
  const { version: applicationVersion } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  let applyingUpdate = false, installState = { state: 'idle', error: '' };
  let installTask = Promise.resolve(), installHandle = null;
  const installController = new AbortController();
  const configPath = join(dataDir, 'config.json');
  const models = new ModelLibrary(join(dataDir,'models.json'),modelsDir);
  let config = { ...defaults };
  let configWarning = '';
  try { config = normalizeConfig(JSON.parse(await readFile(configPath, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') configWarning = 'La configuration enregistrée est illisible. Renseigne à nouveau les chemins.'; }
  const instructionsPath=join(dataDir,'global-context.json');let instructions='';
  try{const bytes=await readFile(instructionsPath);if(bytes.length>100000)throw Error('too large');instructions=globalContext(JSON.parse(bytes).instructions);}catch(error){if(error.code!=='ENOENT')configWarning='Les consignes globales enregistrées sont illisibles.';}
  const preferencesPath = join(dataDir, 'preferences.json');
  let preferences = { theme: 'dark', saveHistory: true };
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
  let historySaves=Promise.resolve();
  const projects=new Projects(join(dataDir,'projects.json'));
  const historyView=record=>({...record,...(record.preview?{previewUrl:'/media/previews/'+record.id+'?key='+mediaKey(record.id,'conversation-preview')}:{} )});
  const token = randomBytes(32).toString('hex');
  const engine = new Engine({ spawnProcess, cacheDir: join(dataDir, 'model-cache') });
  const comfyPath=join(dataDir,'comfy.json');
  let comfy={enabled:false,baseUrl:'http://127.0.0.1:8188',autoAllow:false,maxIterations:5};
  function normalizeComfy(value){
    if(!value||typeof value.enabled!=='boolean'||typeof value.autoAllow!=='boolean'||!Number.isInteger(value.maxIterations)||value.maxIterations<1||value.maxIterations>10000)throw problem('Configuration ComfyUI invalide.');
    return {enabled:value.enabled,baseUrl:normalizeComfyUrl(value.baseUrl),autoAllow:value.autoAllow,maxIterations:value.maxIterations};
  }
  let comfyConfigured=false;
  try{comfy=normalizeComfy(JSON.parse(await readFile(comfyPath,'utf8')));comfyConfigured=true;}catch{}
  let savingComfy=false;
  let savingSettings=false;
  let modelOperation=Promise.resolve();
  let pickingFile=false;
  async function saveComfy(value){
    if(savingComfy)throw problem('Enregistrement ComfyUI en cours.',409);
    const next=normalizeComfy(value);savingComfy=true;
    try{await writeFile(`${comfyPath}.tmp`,JSON.stringify(next,null,2),{mode:0o600});await rename(`${comfyPath}.tmp`,comfyPath);comfy=next;comfyConfigured=true;discoveryTime=0;discovery={detected:false,baseUrl:comfy.baseUrl};}finally{savingComfy=false;}
  }
  const catalog=new WorkflowCatalog(join(dataDir,'workflows'));
  const gallery=new ComfyGallery({historyDir});
  const resources=new Resources(join(dataDir,'resources'));
  const mediaSecret=randomBytes(32),resourceTurns=new Map();
  const mediaKey=(id,part)=>createHmac('sha256',mediaSecret).update(id+'/'+part).digest('hex');
  const resourceView=record=>({...record,originalUrl:`/media/resources/${record.id}/original?key=${mediaKey(record.id,'original')}`,previewUrl:record.ready?`/media/resources/${record.id}/preview?key=${mediaKey(record.id,'preview')}`:null});
  const pendingSession = await readUpdateSession(dataDir).catch(() => null);
  for (const record of pendingSession?.gallery || []) await gallery.put(record, { persist: false });
  const runtime=new ToolRuntime({engine,catalog,gallery,resources,getConfig:()=>comfy,engineConfig:()=>config,saveConfig:saveComfy,persist:()=>preferences.saveHistory});
  let discovery={detected:false,baseUrl:comfy.baseUrl};
  let discoveryTime=0, discovering=null;
  async function detectComfy(){
    if(runtime.active||engine.busy||savingSettings||savingComfy)return discovery;
    if(Date.now()-discoveryTime<10000)return discovery;
    if(discovering)return discovering;
    const previous=comfy.baseUrl;
    discovering=comfyDiscovery(previous).then(result=>{
      if(!runtime.active&&!engine.busy&&!savingSettings&&!savingComfy&&comfy.baseUrl===previous){
        discovery=comfyConfigured&&result.baseUrl!==comfy.baseUrl?{detected:false,baseUrl:comfy.baseUrl}:result;
        if(discovery.detected&&!comfyConfigured)comfy={...comfy,baseUrl:normalizeComfyUrl(discovery.baseUrl)};
      }
      discoveryTime=Date.now();return discovery;
    }).finally(()=>{discovering=null;});
    return discovering;
  }
  function galleryView(record){return {...record,outputs:record.outputs.map((output,index)=>({...output,...(record.mediaType==='video'?{originalUrl: '/media/generated/'+record.conversationId+'/'+record.id+'/'+index+'?key='+mediaKey(record.conversationId+'/'+record.id+'/'+index,'generated')}:{} )}))};}
  const status=()=>({...engine.status(),toolJob:runtime.active?runtime.status():null});
  let url;
  let saving = false;

  const updateController = new AbortController();
  let updates = Promise.resolve({ available: false });
  let controlResponse = null, controlledOnce = false, controlTimer;
  async function includeTools(payload, body) {
    const active=await resources.catalog();
    const context=resourceCatalogPrompt(active);
    if(context){
      if(payload.messages[0]?.role==='system')payload.messages[0]={...payload.messages[0],content:payload.messages[0].content+context};
      else payload.messages.unshift({role:'system',content:context});
    }
    const definitions=[];
    if(comfy.enabled&&body.tools!==false&&(runtime.turns.get(body.turnId)||0)<comfy.maxIterations){
      for(const mediaType of ['image','video']){
      const definition=await catalog.definition(mediaType);
      if(definition){
        if(active.length&&definition.function.parameters.properties.reference_image){
          definition.function.parameters.properties.reference_resource={type:'string',description:'Active resource catalog ID to use instead of reference_image, only for workflows with an image input.'};
          definition.function.parameters.properties.reference_frame={type:'integer',minimum:0,maximum:2,description:'Frame index for a video reference_resource; defaults to 0.'};
        }
        definitions.push(definition);
      }}
    }
    if(active.length&&engine.vision&&body.resources!==false&&(resourceTurns.get(body.turnId)||0)<8){
      const definition=structuredClone(resourceTool),ids=active.map(item=>item.id);
      definition.function.parameters.properties.resource_id.enum=ids;definition.function.parameters.properties.resource_ids.items.enum=ids;definition.function.parameters.properties.resource_ids.maxItems=8-(resourceTurns.get(body.turnId)||0);
      definitions.push(definition);
    }
    if(definitions.length){payload.tools=definitions;payload.tool_choice='auto';payload.parallel_tool_calls=false;}
    return definitions;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
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
      const requestURL = new URL(req.url,url), path=requestURL.pathname;
      const previewMatch=path.match(/^\/media\/previews\/([0-9a-f-]{36})$/);
      if(previewMatch){
        if(!['GET','HEAD'].includes(req.method))throw problem('Méthode non prise en charge.',405);
        const key=requestURL.searchParams.get('key')||'';
        if(!/^[0-9a-f]{64}$/.test(key)||!timingSafeEqual(Buffer.from(key,'hex'),Buffer.from(mediaKey(previewMatch[1],'conversation-preview'),'hex')))throw problem('Accès refusé.',401);
        if(!preferences.saveHistory)throw problem('L’historique est désactivé.',403);
        const {bytes,mime}=await history.preview(previewMatch[1],async runId=>(await gallery.get(previewMatch[1],runId)).outputs.find(output=>output.analysisDataUrl)?.analysisDataUrl);
        res.writeHead(200,{'Content-Type':mime,'Content-Length':bytes.length});return res.end(req.method==='HEAD'?undefined:bytes);
      }
      const generated=path.match(/^\/media\/generated\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9]+)$/);
      if(generated){
        if(!['GET','HEAD'].includes(req.method))throw problem('Méthode non prise en charge.',405);
        const key=requestURL.searchParams.get('key')||'',identity=generated.slice(1).join('/');
        if(!/^[0-9a-f]{64}$/.test(key)||!timingSafeEqual(Buffer.from(key,'hex'),Buffer.from(mediaKey(identity,'generated'),'hex')))throw problem('Accès refusé.',401);
        const record=await gallery.get(generated[1],generated[2],{includeImages:false}),source=record.outputs[Number(generated[3])]?.source;
        if(!source)throw problem('Sortie introuvable.',404);
        const controller=new AbortController(),abort=()=>controller.abort();res.once('close',abort);
        try{const stream=await new ComfyClient(record.comfyUrl).streamVideo(source,{signal:controller.signal,range:req.headers.range});
          if(res.destroyed){await stream.body.cancel();return;}
          res.writeHead(stream.status,{'Content-Type':stream.mime,'Accept-Ranges':'bytes',...(stream.length?{'Content-Length':stream.length}:{}),...(stream.contentRange?{'Content-Range':stream.contentRange}:{})});
          if(req.method==='HEAD'){await stream.body.cancel();res.end();}else await pipeline(Readable.fromWeb(stream.body),res);return;
        }finally{res.off('close',abort);}
      }
      const media=path.match(/^\/media\/resources\/([0-9a-f-]{36})\/(original|preview)$/);
      if(media){
        if(!['GET','HEAD'].includes(req.method))throw problem('Méthode non prise en charge.',405);
        const key=requestURL.searchParams.get('key')||'';
        if(!/^[0-9a-f]{64}$/.test(key)||!timingSafeEqual(Buffer.from(key,'hex'),Buffer.from(mediaKey(media[1],media[2]),'hex')))throw problem('Accès refusé.',401);
        await sendResourceMedia(req,res,await resources.media(media[1],media[2]));return;
      }
      if (req.method === 'GET' && staticFiles.has(path)) {
        const asset = frontend.get(path),{file,mime}=asset;
        let contents = asset.contents;
        if (file === 'index.html') contents = contents.toString('utf8').replace('data-theme="dark"', `data-theme="${preferences.theme}"`);
        res.writeHead(200, { 'Content-Type': mime });
        return res.end(contents);
      }
      if (path === '/favicon.ico' && req.method === 'GET') { res.writeHead(204); return res.end(); }
      if (path === '/api/bootstrap' && req.method === 'GET') {
        return send(200, { application: 'atelier-local', ...sources, controlled: !!controlResponse, token, config, instructions, models: await models.list(), modelName: (await models.list()).find(item=>item.modelPath===config.modelPath&&item.projectorPath===config.projectorPath)?.name || modelFolderName(config.modelPath), preferences, status: status(), comfy, workflows: await catalog.list(), platform: process.platform, warning: configWarning, version: applicationVersion, updateNonce: process.env.ATELIER_UPDATE_NONCE || '', updating: applyingUpdate });
      }
      if (!path.startsWith('/api/')) throw problem('Page introuvable.', 404);
      if (req.headers.authorization !== `Bearer ${token}`) throw problem('Accès refusé. Recharge la page.', 401);
      if (path === '/api/lifecycle' && req.method === 'GET') {
        if (closing || controlResponse) throw problem('Une fenêtre contrôle déjà cette application.', 409);
        controlResponse = res; controlledOnce = true; clearTimeout(controlTimer);
        req.socket.setTimeout(0);res.setTimeout(0);
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control':'no-store', 'X-Accel-Buffering':'no' });
        const heartbeat=()=>{if(!res.destroyed&&!res.writableEnded)res.write(JSON.stringify({state:'running'})+'\n');};
        heartbeat();const keepalive=setInterval(heartbeat,controlHeartbeatMs);keepalive.unref();
        res.once('close', () => {
          clearInterval(keepalive);
          if (controlResponse === res) controlResponse = null;
          if (!closing) {clearTimeout(controlTimer);controlTimer=setTimeout(()=>{void stopApplication().catch(console.error);},controlReconnectMs);controlTimer.unref();}
        });
        return;
      }
      if (path === '/api/updates/install' && req.method === 'GET') {
        if (!applyingUpdate && installState.state === 'idle') {
          try { return send(200, JSON.parse(await readFile(join(dataDir, 'update-status.json'), 'utf8'))); } catch {}
        }
        return send(200, installState);
      }
      if (path === '/api/updates/session' && req.method === 'GET') return send(200, applyingUpdate ? null : await readUpdateSession(dataDir));
      if (path === '/api/updates' && req.method === 'GET') return send(200, await updates);
      if (path === '/api/models' && req.method === 'GET') return send(200,{models:await models.list(),...await models.scan()});
      if (path === '/api/status' && req.method === 'GET') return send(200, status());
      if(req.method==='GET'&&path==='/api/comfy'){await detectComfy();return send(200,{config:comfy,discovery,workflows:await catalog.list()});}
      if(req.method==='GET'&&path==='/api/comfy/status')return send(200,await new ComfyClient(comfy.baseUrl).status());
      if(req.method==='GET'&&path==='/api/comfy/workflows')return send(200,{workflows:await new ComfyClient(comfy.baseUrl).workflows()});
      if(req.method==='GET'&&path==='/api/resources')return send(200,{resources:(await resources.list()).map(resourceView)});
      if(path==='/api/resources/upload'&&req.method==='POST'){
        if(applyingUpdate||closing||relaunching)throw problem('L’application est occupée.',409);
        let name;try{name=decodeURIComponent(req.headers['x-resource-name']||'');}catch{throw problem('Nom de fichier invalide.');}
        const resource=await resources.add(req,{name,mime:(req.headers['content-type']||'').split(';')[0],length:req.headers['content-length']});
        return send(201,resourceView(resource));
      }
      if(req.method==='GET'&&path==='/api/tools/job'){const job=runtime.status();return send(200,job?.record?{...job,record:galleryView(job.record)}:job);}
      if(req.method==='GET'&&path.startsWith('/api/gallery/')){
        const [, , ,conversationId,runId,index]=path.split('/');
        if(!runId){const result=await gallery.list(conversationId);result.runs=result.runs.map(galleryView);return send(200,result);}
        const record=await gallery.get(conversationId,runId,{includeImages:index===undefined});
        if(res.destroyed)return;
        if(index===undefined)return send(200,galleryView(record));
        if(!/^\d+$/.test(index)||!record.outputs[Number(index)])throw problem('Image introuvable.',404);
        if(record.mediaType==='video'){res.writeHead(307,{Location:galleryView(record).outputs[Number(index)].originalUrl});return res.end();}
        const controller=new AbortController(),abort=()=>controller.abort();res.once('close',abort);
        try{
          const original=await new ComfyClient(record.comfyUrl).original(record.outputs[Number(index)].source,{signal:controller.signal});
          if(res.destroyed)return;
          res.writeHead(200,{'Content-Type':original.mime,'Content-Disposition':`inline; filename="${original.filename.replace(/[^A-Za-z0-9._-]/g,'_')}"`});return res.end(original.bytes);
        }finally{res.off('close',abort);}
      }
      if(req.method==='GET'&&path==='/api/projects')return send(200,{projects:await projects.list()});
      if (req.method === 'GET' && (path === '/api/history' || path.startsWith('/api/history/'))) {
        if (!preferences.saveHistory) throw problem('L’historique est désactivé.', 403);
        if(path==='/api/history'){const result=await history.list();return send(200,{...result,conversations:result.conversations.map(historyView)});}
        return send(200,historyView(await history.read(path.slice('/api/history/'.length))));
      }
      if (req.method !== 'POST') throw problem('Méthode non prise en charge.', 405);
      const body = await jsonBody(req, path === '/api/updates/install' ? 40 * 1024 * 1024 : maxBody);
      if (applyingUpdate) throw problem('Installation de la mise à jour en cours.', 409);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem('Un objet JSON est attendu.');
      if (path === '/api/shutdown') {
        if(body.onlyIfIdle===true){
          if(body.installationId!==sources.installationId||body.sourceRevision!==sources.sourceRevision)throw problem('L’instance à relancer a changé.',409);
          if(closing||relaunching||engine.busy||runtime.active||savingSettings||saving||savingComfy||pickingFile||savingPreferences||clearingHistory||persistingGallery||['loading','stopping'].includes(engine.state))throw problem('Termine l’opération en cours, puis relance l’application pour charger les derniers fichiers.',409);
          relaunching=true;
          try{await engine.stop();}catch(error){relaunching=false;throw error;}
        }
        send(202, { stopping: true });
        setImmediate(() => { void stopApplication().catch(console.error); });
        return;
      }
      if (closing||relaunching) throw problem('L’application est en cours de fermeture.', 409);
      if(path==='/api/models/add'||path==='/api/models/select'){
        if(savingSettings||saving||savingComfy||pickingFile||runtime.active||engine.busy||clearingHistory||['loading','stopping'].includes(engine.state))throw problem('Attends la fin de l’opération en cours.',409);
        savingSettings=true;saving=true;let finishModelOperation;modelOperation=new Promise(done=>{finishModelOperation=done;});
        try{
          if(path==='/api/models/add'){const profile=await models.add(body);return send(200,{profile,models:await models.list()});}
          const selected=await models.get(body.id),next={...config,modelPath:selected.modelPath,projectorPath:selected.projectorPath};
          if(next.modelPath===config.modelPath&&next.projectorPath===config.projectorPath)return send(200,{config,modelName:selected.name,status:status()});
          const restart=engine.state==='ready';await engine.stop();
          await atomicJson(configPath,next);config=next;configWarning='';
          let warning='';if(restart&&!closing){try{await engine.start(config);}catch(error){warning=error.message;}}
          return send(200,{config,modelName:selected.name,status:status(),warning});
        }finally{savingSettings=false;saving=false;finishModelOperation();}
      }
      if(path==='/api/resources/update'){
        if((runtime.active||engine.busy)&&((await resources.record(body.id)).ready||!body.patch?.prepared))throw problem('Attends la fin de la réponse avant de modifier une ressource.',409);
        return send(200,resourceView(await resources.update(body.id,body.patch)));
      }
      if(path==='/api/resources/delete'){
        if((runtime.active||engine.busy)&&(await resources.record(body.id)).ready)throw problem('Attends la fin de la réponse avant de supprimer une ressource.',409);
        await resources.remove(body.id);return send(200,{deleted:true});
      }
      if(path==='/api/resources/read'){
        if(body.ids!==undefined){const ids=resourceReadIds({resource_ids:body.ids});return send(200,{resources:await Promise.all(ids.map(id=>resources.readActive(id)))});}
        return send(200,await resources.readActive(body.id));
      }
      if (path === '/api/updates/session/clear') { await rm(join(dataDir, 'update-session.json'), { force: true }); return send(200, { cleared: true }); }
      if (path === '/api/updates/install') {
        const available = await updates;
        if (!available.available || !updateInstaller) throw problem('Aucune mise à jour installable.', 409);
        if (resources.busy || runtime.active || engine.busy || saving || savingSettings || savingComfy || savingPreferences || clearingHistory || disablingHistory || persistingGallery || pickingFile || ['loading', 'stopping'].includes(engine.state)) throw problem('Attends la fin de l’opération en cours avant la mise à jour.', 409);
        let snapshot;
        try { snapshot = updateSession(body.session); } catch (error) { throw problem(error.message); }
        applyingUpdate = true; installState = { state: 'preparing', error: '' };
        installTask = (async () => {
          try {
            await historySaves; await history.flush(); await gallery.pending;
            snapshot.gallery = snapshot.conversationId ? (await gallery.list(snapshot.conversationId)).runs : [];
            snapshot = compactSession(snapshot);
            if (Buffer.byteLength(JSON.stringify(snapshot)) > 40 * 1024 * 1024) throw new Error('La session est trop volumineuse pour une reprise automatique.');
            await atomicJson(join(dataDir, 'update-session.json'), snapshot);
            const plan = await updateInstaller.prepare({ version: available.version, port: server.address().port, signal: installController.signal });
            installController.signal.throwIfAborted();
            installHandle = await updateInstaller.launch({ ...plan, managed: managed || controlledOnce });
            installController.signal.throwIfAborted();
            installState = { state: 'restarting', error: '' };
            await closeApplication();
            await installHandle.commit(); installHandle = null;
          } catch (error) {
            installHandle?.abort(); installHandle = null;
            applyingUpdate = false; installState = { state: 'error', error: error.message };
            if (!closing) await rm(join(dataDir, 'update-session.json'), { force: true }).catch(() => {});
          }
        })();
        return send(202, { state: 'preparing' });
      }
      if(path==='/api/files/choose'){
        if(!['engine','model','projector'].includes(body?.kind))throw problem('Type de fichier invalide.');
        if(saving||savingSettings||savingComfy||pickingFile)throw problem('Un choix de fichier ou un enregistrement est déjà en cours.',409);
        if(runtime.active||engine.busy||body.kind==='engine'&&engine.child||['loading','stopping'].includes(engine.state))throw problem('Arrête le modèle avant de choisir un fichier.',409);
        pickingFile=true;const controller=new AbortController();const abort=()=>controller.abort();res.once('close',abort);
        try{return send(200,{path:await filePicker(body.kind,{initialPath:body.initialPath||'',signal:controller.signal})});}
        finally{res.off('close',abort);pickingFile=false;}
      }
      if(path==='/api/settings'){
        if(pickingFile||savingSettings||savingComfy||saving||runtime.active||engine.busy||clearingHistory)throw problem('Attends la fin de l’opération en cours.',409);
        const nextConfig=normalizeConfig(body.config),nextComfy=normalizeComfy(body.comfy),nextInstructions=globalContext(body.instructions===undefined?instructions:body.instructions);
        const modelChanged=JSON.stringify(config)!==JSON.stringify(nextConfig);
        if(modelChanged&&(engine.child||['loading','stopping'].includes(engine.state)))throw problem('Arrête le modèle avant de modifier ses réglages.',409);
        const edits=body.workflowDescriptions===undefined?[]:body.workflowDescriptions;
        if(!Array.isArray(edits)||edits.length>1000||new Set(edits.map(edit=>edit?.id)).size!==edits.length)throw problem('Descriptions de workflows invalides.');
        savingSettings=true;saving=true;
        try{
          const updates=[];
          for(const edit of edits){
            if(typeof edit?.description!=='string'||edit.description.length>2000)throw problem('Description de workflow invalide.');
            updates.push(validateWorkflow({...await catalog.read(edit.id),description:edit.description.trim()}));
          }
          if(modelChanged){await writeFile(`${configPath}.tmp`,JSON.stringify(nextConfig,null,2),{mode:0o600});await rename(`${configPath}.tmp`,configPath);config=nextConfig;configWarning='';}
          await saveComfy(nextComfy);
          for(const update of updates)await catalog.save(update);
          if(nextInstructions!==instructions){await atomicJson(instructionsPath,{instructions:nextInstructions});instructions=nextInstructions;}
          discoveryTime=0;
          return send(200,{config,comfy,instructions,workflows:await catalog.list()});
        }finally{savingSettings=false;saving=false;}
      }
      if(path==='/api/comfy/test'){
        const result=await testComfyConnection(body.baseUrl);
        return send(200,{...result,detected:true});
      }
      if(path==='/api/tools/recover')return send(200,await runtime.recover());
      if(path==='/api/tools/cancel'){
        if((!body.requestId&&!body.jobId)||[body.requestId,body.jobId].some(id=>id!==undefined&&(typeof id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id))))throw problem('Identifiant de génération requis.');
        return send(200,runtime.cancel(body));
      }
      if(path==='/api/tools/execute'){
        if(clearingHistory||persistingGallery||savingComfy||savingSettings||pickingFile)throw problem('Une opération est en cours.',409);
        const job=await runtime.execute(body);return send(202,job?.record?{...job,record:galleryView(job.record)}:job);
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
        if((runtime.active&&!runtime.gpuBlocked)||clearingHistory||disablingHistory||persistingGallery)throw problem('Attends la fin de l’opération en cours.',409);
        persistingGallery=true;
        try {
        const record=await gallery.get(body.conversationId,body.id);
        if(path==='/api/gallery/review'){
          if(typeof body.text!=='string'||body.text.length>200000||!['reviewed','correction_requested'].includes(body.status))throw problem('Analyse de galerie invalide.');
          record.analysis={text:body.text,status:body.status,checkedAt:new Date().toISOString()};
        }else{
        if(!Array.isArray(body.images)||body.images.length!==record.outputs.length)throw problem('Copies d’analyse invalides.');
        if(body.dimensions!==undefined&&(!Array.isArray(body.dimensions)||body.dimensions.length!==record.outputs.length||body.dimensions.some(size=>size!==null&&(!size||![size.width,size.height].every(value=>Number.isInteger(value)&&value>0&&value<=131072)))))throw problem('Résolutions de sortie invalides.');
        if(body.frames!==undefined&&(!Array.isArray(body.frames)||body.frames.length!==record.outputs.length))throw problem('Images vidéo invalides.');
        record.outputs=record.outputs.map((output,i)=>(body.images[i]===null?output:{...output,analysisDataUrl:body.images[i],...(body.dimensions?.[i]||{}),...(body.frames?.[i]?{analysisFrames:body.frames[i]}:{})}));
        }
        return send(200,await gallery.put(record,{persist:preferences.saveHistory}));
        } finally { persistingGallery=false; }
      }
      if(path.startsWith('/api/comfy/')){
        if(runtime.active||engine.busy||clearingHistory||savingSettings||savingComfy||pickingFile)throw problem('Attends la fin de l’opération GPU.',409);
        if(path==='/api/comfy/config'){await saveComfy(body);return send(200,{config:comfy});}
        if(path==='/api/comfy/import'||path==='/api/comfy/remove'){
          savingComfy=true;
          try{
            if(path==='/api/comfy/import')return send(200,await catalog.save(body));
            await catalog.remove(body.id);return send(200,{removed:true});
          }finally{savingComfy=false;}
        }
        throw problem('Route introuvable.',404);
      }
      if (path === '/api/preferences') {
        if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length || Object.keys(body).some((key) => !['theme', 'saveHistory'].includes(key))) throw problem('Préférences invalides.');
        if ('theme' in body && !['dark', 'light'].includes(body.theme)) throw problem('Choisis le mode jour ou nuit.');
        if ('saveHistory' in body && typeof body.saveHistory !== 'boolean') throw problem('Choix d’historique invalide.');
        if ((runtime.active || persistingGallery || clearingHistory) && 'saveHistory' in body) throw problem('Attends la fin de la génération ComfyUI.',409);
        if (savingPreferences) throw problem('Préférences en cours d’enregistrement.', 409);
        const next = { ...preferences, ...body };
        savingPreferences = true;
        disablingHistory = body.saveHistory === false;
        try {
          if (disablingHistory) { await historySaves; await history.flush(); }
          await writeFile(`${preferencesPath}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
          await rename(`${preferencesPath}.tmp`, preferencesPath);
          preferences = next;
        } finally { savingPreferences = false; disablingHistory = false; }
        return send(200, { preferences });
      }
      if (path === '/api/history/delete') {
        if (body?.confirm !== true) throw problem('Confirme la suppression de la conversation.');
        if (persistingGallery || runtime.active || clearingHistory || disablingHistory || savingPreferences || engine.busy || ['loading', 'stopping'].includes(engine.state)) throw problem('Attends la fin de l’opération en cours avant de supprimer la conversation.', 409);
        clearingHistory = true;
        try {
          await historySaves; await gallery.pending; await history.remove(body.id);
          gallery.forgetConversation(body.id); runtime.forgetConversation(body.id);
          return send(200, { deleted: body.id });
        } finally { clearingHistory = false; }
      }
      if (path === '/api/history/clear') {
        if (body?.confirm !== true) throw problem('Confirme la suppression de l’historique.');
        if (persistingGallery || runtime.active || clearingHistory || disablingHistory || savingPreferences || engine.busy || ['loading', 'stopping'].includes(engine.state)) throw problem('Attends la fin de l’opération en cours avant de supprimer l’historique.', 409);
        clearingHistory = true;
        try { await historySaves; await gallery.pending; await history.clear(); runtime.clear(); return send(200, { cleared: true }); }
        finally { clearingHistory = false; }
      }
      if(path==='/api/projects/save')return send(200,{project:await projects.save(body)});
      if(path==='/api/projects/move'){
        if(!preferences.saveHistory)throw problem('L’historique est désactivé.',403);
        if(clearingHistory||disablingHistory||savingPreferences||runtime.active||engine.busy)throw problem('Attends la fin de l’opération en cours.',409);
        clearingHistory=true;
        try{await historySaves; await projects.require(body.projectId);const conversation=await history.read(body.id);
        return send(200,{conversation:historyView(await history.save({...conversation,projectId:body.projectId}))});}finally{clearingHistory=false;}
      }
      if (path === '/api/history/save') {
        if(runtime.active)throw problem('Attends la fin de la génération ComfyUI.',409);
        if (clearingHistory) throw problem('Suppression de l’historique en cours.', 409);
        if (!preferences.saveHistory) throw problem('L’historique est désactivé.', 403);
        if (disablingHistory) throw problem('Désactivation de l’historique en cours.', 409);
        const save=historySaves.then(async()=>{if(body.projectId!==undefined)await projects.require(body.projectId);return history.save(body);});
        historySaves=save.catch(()=>{});
        return send(200, { conversation: historyView(await save) });
      }
      if (path === '/api/config') {
        if (pickingFile || runtime.active || saving || engine.child || engine.state === 'loading' || engine.state === 'stopping') throw problem('Arrête le moteur avant de modifier sa configuration.', 409);
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
        if (saving || savingComfy || pickingFile) throw problem('Choix de fichier ou enregistrement en cours.', 409);
        await engine.start(config);
        return send(202, engine.status());
      }
      if (path === '/api/stop') { if(savingSettings)throw problem('Changement de modèle en cours.',409);if(runtime.active)throw problem('Annule la génération ComfyUI avec le bouton d’interruption.',409); await engine.stop(); return send(200, status()); }
      if (path === '/api/context') {
        const payload = chatPayload(body, Boolean(config.projectorPath), config.maxOutputTokens, true);
        const limits = { capacity: config.contextSize, reserved: config.maxOutputTokens };
        if (engine.state !== 'ready' || engine.busy || runtime.active) return send(200, { ...limits, used: null, precision: 'unavailable' });
        const controller = new AbortController();
        const abort = () => controller.abort(); res.once('close', abort);
        try {
          await includeTools(payload, body);
          const result = await countContext({ base: engine.base, apiKey: engine.apiKey, payload, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
          return send(200, { ...limits, ...result });
        } catch { if (!res.destroyed) return send(200, { ...limits, used: null, precision: 'unavailable' }); }
        finally { res.off('close', abort); }
        return;
      }
      if (path !== '/api/chat') throw problem('Route introuvable.', 404);
      if(savingSettings||savingComfy||pickingFile)throw problem('Enregistrement des réglages en cours.',409);
      if(runtime.active)throw problem('ComfyUI utilise le GPU.',409);
      if(clearingHistory)throw problem('Suppression de l’historique en cours.',409);
      if (engine.state !== 'ready') throw problem('Le moteur n’est pas prêt. Configure-le puis démarre-le.', 503);
      if (engine.busy) throw problem('Une réponse est déjà en cours.', 409);
      const payload = chatPayload(body, engine.vision, config.maxOutputTokens);
      const controller = new AbortController();
      engine.activeRequest = controller;
      engine.busy = true;
      const onClose = () => controller.abort();
      res.once('close', onClose);
      let streamHeartbeat;
      try {
        const definitions = await includeTools(payload, body);
        const upstream = await fetch(`${engine.base}/v1/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${engine.apiKey}` },
          body: JSON.stringify(payload), signal: controller.signal,
        });
        if (!upstream.ok) {
          const detail = (await upstream.text()).slice(0, 3000);
          throw problem(`Le moteur refuse la requête (${upstream.status}). ${detail}`, 502);
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
        streamHeartbeat=setInterval(()=>{if(!res.destroyed&&!res.writableEnded)res.write(': keepalive\n\n');},chatHeartbeatMs);streamHeartbeat.unref();
        const calls=[];let terminalReason='';
        const emit=async(event)=>{
          if(res.destroyed)return;
          if(!res.write(`data: ${JSON.stringify(event)}\n\n`))await new Promise(done=>{const finish=()=>{res.off('drain',finish);res.off('close',finish);done();};res.once('drain',finish);res.once('close',finish);});
        };
        await readSSE(upstream.body,async(event)=>{collectToolCalls(calls,event.choices?.[0]?.delta||{});if(event.choices?.[0]?.finish_reason)terminalReason=event.choices[0].finish_reason;await emit(event);});
        if(calls.length){
          if(terminalReason!=='tool_calls')throw problem('L’appel d’outil du modèle est incomplet ou tronqué. Aucune génération lancée.',502);
          if(calls.length!==1||!definitions.some(item=>item.function.name===calls[0].function?.name))throw problem('Le moteur a demandé un outil indisponible.',502);
          if(calls[0].function.name==='local_read_resource'){
            const call=nativeFields({role:'assistant',tool_calls:calls}).tool_calls[0];let args;
            try{args=JSON.parse(call.function.arguments);}catch{throw problem('Paramètres de ressource invalides.',502);}
            const ids=resourceReadIds(args);
            if(!body.turnId||!/^[0-9a-f-]{36}$/.test(body.turnId)||(resourceTurns.get(body.turnId)||0)+ids.length>8)throw problem('La limite de huit lectures pour ce tour est atteinte.',502);
            const selected=await Promise.all(ids.map(id=>resources.activeRecord(id)));
            resourceTurns.set(body.turnId,(resourceTurns.get(body.turnId)||0)+ids.length);if(resourceTurns.size>256)resourceTurns.delete(resourceTurns.keys().next().value);
            await emit({local_tool_request:{kind:'resource',call,resourceId:selected[0].id,resourceIds:ids,workflowName:selected.map(item=>item.label+' · '+item.name).join(', ')}});
          }else await emit({local_tool_request:await runtime.request(calls,{conversationId:body.conversationId,turnId:body.turnId,messages:body.messages})});
        }
        res.write('data: [DONE]\n\n');
        res.end();
      } finally {
        clearInterval(streamHeartbeat);
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
  if (updateChecker) updates = Promise.resolve().then(() => updateChecker({ signal: updateController.signal })).catch(() => ({ available: false }));
  let closing,relaunching=false;
  if (managed) { controlTimer = setTimeout(() => { void stopApplication().catch(console.error); }, controlTimeoutMs); controlTimer.unref(); }
  function closeApplication() {
    return closing ||= (async () => {
      clearTimeout(controlTimer);
      const serverClosed = new Promise(done => server.close(done));
      updateController.abort(); await updates;
      await resources.close(); await modelOperation; await models.pending; await runtime.close(); await engine.stop();
      await projects.pending; await historySaves; await history.flush(); await galleryBatch.catch(() => {}); await gallery.pending;
      if (controlResponse && !controlResponse.destroyed) controlResponse.end(JSON.stringify({ state: applyingUpdate ? 'restarting' : 'stopped' }) + '\n');
      server.closeAllConnections();
      await serverClosed;
    })();
  }
  async function stopApplication() { installController.abort(); await installTask; return closeApplication(); }
  return { url, close: stopApplication };
}


export function openBrowser(url,{platform=process.platform,spawnProcess=spawn,report=console.log}={}) {
  const command = platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawnProcess(command, args, { stdio: 'ignore', detached: true, windowsHide: true, shell:false });
  let reported=false;const fallback=()=>{if(!reported){reported=true;report(`Ouvre cette adresse dans ton navigateur : ${url}`);}};
  child.once('error',fallback);child.once('exit',code=>{if(code!==0)fallback();});
  child.unref();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    console.error('Atelier local nécessite Node.js 22 ou ultérieur.');
    process.exitCode = 1;
  } else {
    let port = 8787;
    try {
      const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      const portArg = process.argv.find(arg => arg.startsWith('--port=') || arg.startsWith('--update-port='));
      port = portArg ? Number(portArg.split('=')[1]) : 8787;
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port invalide.');
      const app = await createApplication({ port, managed: process.env.ATELIER_MANAGED_LAUNCH === '1',
        updateChecker: ({ signal }) => checkForUpdates({ currentVersion: version, signal }),
        updateInstaller: { prepare: args => prepareUpdate({ ...args, root, currentVersion: version }), launch: launchInstaller },
      });
      console.log(`\nAtelier local — ${app.url}\nLes conversations restent sur cet ordinateur. Ctrl+C pour arrêter.\n`);
      let closing = false;
      const close = async () => { if (closing) return; closing = true; await app.close(); process.exitCode = 0; };
      process.on('SIGINT', close);
      process.on('SIGTERM', close);
      process.on('SIGHUP', close);
      if (process.argv.includes('--open')) openBrowser(app.url);
    } catch (error) {
      console.error(error.code === 'EADDRINUSE' ? `Le port ${port} est déjà utilisé. Relance l’application avec son lanceur pour retrouver l’instance existante.` : error.message);
      process.exitCode = 1;
    }
  }
}
