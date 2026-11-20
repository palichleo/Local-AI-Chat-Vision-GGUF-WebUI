#!/usr/bin/env node
/**
 * Goes through the interface in a headless browser, on a copy of the server with an empty data
 * folder (the user's library, chats and settings are never touched), and fails on any error of
 * the page: an exception, an error written to the console, a file the page cannot load, or the
 * notice of an unexpected error (app.js). Run before each commit (.githooks/pre-commit) and by
 * `npm run check:ui`. « Nouveau chat » stopped silently from 0.5.87 to 0.5.109: this would have
 * caught it at once. Last, the Studio is laid out with the tools of the shipped workflows, in every
 * mode and with every model: nothing of it under the Sortie, nothing in sight out of reach (0.6.98).
 *
 * The browser: MOODIX_BROWSER, or Brave, Chrome, Edge or Chromium where they are usually
 * installed. None found: said, and the check is skipped (it never blocks for want of one).
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Gallery } from '../lib/gallery.mjs';
import { ToolCatalog } from '../lib/tool-catalog.mjs';
import { validateNativeWorkflow } from '../lib/native-workflows.mjs';
import { STUDIO_ID } from '../lib/studio.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const local = process.env.LOCALAPPDATA || '';
const BROWSERS = [
  process.env.MOODIX_BROWSER,
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  join(local, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(local, 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/brave-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const browser = BROWSERS.find(path => existsSync(path));
// `--fluidity` (0.6.109, `npm run check:fluidity`): each step is also timed, and the slow ones listed
// at the end: the tasks that hold the page's thread more than 50 ms, the longest wait between two
// frames, the time spent in script, style and layout. `--fluidity=window` does it in a real window,
// drawn by the graphics card (the waits a user would see); without it the browser has no window, and
// only the page's own work is measured. Never part of the check before a commit.
const FLUIDITY = process.argv.find(argument => argument.startsWith('--fluidity')),
  PERF = Boolean(FLUIDITY),
  WINDOW = FLUIDITY === '--fluidity=window';
if (!browser) {
  console.log('Vérification de l’interface sautée : aucun navigateur Chromium trouvé (MOODIX_BROWSER pour en indiquer un).');
  process.exit(0);
}

// The tools of the Studio on a machine that has the files of every shipped workflow (0.6.98), as
// the application gives them (lib/tool-catalog.mjs), with three LoRAs of the user: this empty copy has
// none (no Python, no model), and the steps that lay the Studio out are served these in their place.
const shippedFolder = new URL('../runner/workflows/', import.meta.url);
const shipped = await Promise.all(
  (await readdir(shippedFolder))
    .filter(name => name.endsWith('.json'))
    .map(async name => JSON.parse(await readFile(new URL(name, shippedFolder), 'utf8'))),
);
const shippedStudio = {
  legacyId: STUDIO_ID,
  enabled: true,
  tools: await new ToolCatalog({ list: async () => shipped.map(item => ({ ...validateNativeWorkflow(item), ready: true })) }).studio(),
  styles: ['grain-argentique.safetensors', 'portrait-doux.safetensors', 'styles\\lumiere-70s.safetensors'],
  presets: {},
};
/**
 * The Studio gone through in the page (0.6.98): each mode and each of its models, as it opens and
 * with all it may show; what goes over the Sortie, what the pointer cannot reach, a page that scrolls,
 * in the user's words. The Studio draws each change at once (render): read as soon as it is done.
 */
const STUDIO_LAYOUT = `(() => {
  const found = [],
    desk = () => document.querySelector('#studio-view .studio-desk'),
    click = selector => document.querySelector(selector)?.click(),
    // What cuts what it holds: a control is in sight where all of them leave it.
    clips = control => {
      const rooms = [];
      for (let node = control.parentElement; node && node !== document.body; node = node.parentElement)
        if (getComputedStyle(node).overflowY !== 'visible') rooms.push(node.getBoundingClientRect());
      return rooms;
    },
    named = element => element ? element.getAttribute('class') || element.tagName : 'rien';
  function look(where) {
    const out = desk()?.querySelector('.studio-block.is-output');
    if (!out) return found.push(where + ' : pas de Sortie');
    const top = out.getBoundingClientRect().top;
    for (const [kind, label] of [['is-input', 'Entrée'], ['is-preview', 'Aperçu'], ['is-settings', 'Réglages']]) {
      const block = desk().querySelector('.studio-block.' + kind),
        over = block ? Math.round(block.getBoundingClientRect().bottom - top) : 0;
      if (over > 0) found.push(where + ' : le bloc ' + label + ' passe ' + over + ' px sous la Sortie');
    }
    const page = document.documentElement;
    if (page.scrollHeight > innerHeight + 1 || page.scrollWidth > innerWidth + 1) found.push(where + ' : la page défile');
    for (const control of desk().querySelectorAll('.studio-block:not(.is-output) :is(button, input, select, textarea, [tabindex="0"])')) {
      const box = control.getBoundingClientRect();
      if (!box.width || !box.height || control.closest('[hidden]') || getComputedStyle(control).visibility === 'hidden') continue;
      let left = Math.max(box.left, 0), right = Math.min(box.right, innerWidth), upper = Math.max(box.top, 0), lower = Math.min(box.bottom, innerHeight);
      for (const room of clips(control)) {
        left = Math.max(left, room.left);
        right = Math.min(right, room.right);
        upper = Math.max(upper, room.top);
        lower = Math.min(lower, room.bottom);
      }
      // Scrolled out of sight in its block: reached by scrolling it, not here.
      if (right - left < 2 || lower - upper < 2) continue;
      const hit = document.elementFromPoint((left + right) / 2, (upper + lower) / 2);
      // (A bubble of help, or the pointer of Moodix AI, passes over the page: no part of its layout.)
      if (hit?.closest('.help-bubble, .ai-cursor')) continue;
      if (!hit || !(hit === control || control.contains(hit) || (hit.tagName === 'LABEL' && hit.contains(control))))
        found.push(where + ' : « ' + (control.getAttribute('aria-label') || control.textContent.trim() || named(control)) + ' » hors de portée, sous ' + named(hit));
    }
  }
  for (const mode of ['Image', 'Vidéo', 'Son']) {
    click('#studio-kinds .kind-tab[aria-label="' + mode + '"]');
    const pick = () => document.querySelector('#studio-view .studio-model-pick'),
      ids = [...(pick()?.options ?? [])].map(option => option.value);
    for (const id of ids.length ? ids : [null]) {
      if (id !== null) {
        pick().value = id;
        pick().onchange();
      }
      const name = mode + ' · ' + (pick()?.selectedOptions[0]?.textContent ?? document.querySelector('#studio-view .studio-model-name')?.textContent ?? '');
      look(name);
      for (let added = 0; added < 3; added++) click('#studio-view .studio-lora-plus');
      click('#studio-view .studio-lyrics-toggle');
      if (!document.querySelector('#studio-view .studio-more-pill')?.classList.contains('is-open')) click('#studio-view .studio-more-pill');
      look(name + ', tout ouvert');
    }
  }
  return found;
})()`;

const data = await mkdtemp(join(tmpdir(), 'moodix-check-data-')),
  profile = await mkdtemp(join(tmpdir(), 'moodix-check-browser-'));
// A LLM registered, so that the message box is there (without one, the card of the first launch
// takes its place: tests/etats.mjs). Its files need not exist: nothing starts it here.
await writeFile(
  join(data, 'config.json'),
  JSON.stringify({
    enginePath: join(data, 'llama-server.exe'),
    modelPath: join(data, 'modele.gguf'),
    projectorPath: '',
    contextSize: 8192,
    maxOutputTokens: 4096,
    gpuLayers: 999,
  }),
);
// The server in a process of its own: its work in the background (status, folders) must not hold
// up the messages of the browser here.
const serverFile = pathToFileURL(fileURLToPath(new URL('../server.mjs', import.meta.url))).href;
const server = spawn(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `const { createApplication } = await import(${JSON.stringify(serverFile)});
     const app = await createApplication({ port: 0, dataDir: ${JSON.stringify(data)}, builtinWorkflowDir: ${JSON.stringify(fileURLToPath(shippedFolder))} });
     console.log('URL ' + app.url);`,
  ],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);
const app = {
  url: await new Promise((resolve, reject) => {
    let said = '';
    server.stdout.on('data', chunk => {
      said += chunk;
      const found = said.match(/URL (\S+)/);
      if (found) resolve(found[1]);
    });
    server.once('exit', code => reject(new Error('le serveur s’est arrêté (' + code + ')')));
    setTimeout(() => reject(new Error('le serveur ne répond pas')), 20000);
  }),
  close: async () => server.kill(),
};
// (`--fluidity=window`) A real window, drawn by the graphics card and never held back for being
// behind another, so that the waits between two frames are those a user would see.
const shown =
  WINDOW
    ? ['--window-size=1440,900', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion']
    : ['--headless=new'];
const chrome = spawn(browser, [...shown, '--mute-audio', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], {
  stdio: 'ignore',
});
const problems = [];
let socket,
  step = 'chargement';
async function finish(code) {
  socket?.close();
  chrome.kill();
  await app.close().catch(() => {});
  await wait(600);
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  process.exit(code);
}
try {
  // The browser says its port in its profile once it listens.
  let port;
  for (let attempt = 0; attempt < 80 && !port; attempt++) {
    await wait(150);
    port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0].trim();
  }
  if (!port) throw new Error('le navigateur n’a pas ouvert son port de pilotage');
  let page;
  for (let attempt = 0; attempt < 40 && !page; attempt++) {
    page = (await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()).catch(() => [])).find(target => target.type === 'page');
    if (!page) await wait(150);
  }
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method === 'Fetch.requestPaused' && laidOut)
      // The tools of the Studio, while the steps that lay it out are under way (shippedStudio); the
      // steps that simulate the answers of a model have their own (paused, below).
      socket.send(
        JSON.stringify({
          id: ++id,
          method: 'Fetch.fulfillRequest',
          params: {
            requestId: message.params.requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
            body: Buffer.from(JSON.stringify(shippedStudio)).toString('base64'),
          },
        }),
      );
    else if (message.method === 'Page.javascriptDialogOpening')
      // « Quitter la page ? » (a draft in the message box): left, as a user would.
      socket.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    else if (message.method === 'Runtime.exceptionThrown')
      problems.push([step, 'exception', message.params.exceptionDetails.exception?.description?.split('\n')[0] ?? message.params.exceptionDetails.text]);
    else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error')
      problems.push([step, 'console', message.params.args.map(arg => arg.value ?? arg.description).join(' ').slice(0, 300)]);
    else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error')
      problems.push([step, 'chargement', (message.params.entry.text + ' ' + (message.params.entry.url ?? '')).slice(0, 300)]);
    else if (message.method === 'Fetch.requestPaused') void paused(message.params);
  };
  /**
   * (0.6.95) While a step simulates them (`simulated`), the answers of the model and the tools of
   * the Studio, which this copy of the server does not have (no LLM, no Python): the Studio's tools,
   * the stream of each answer in turn, a model ready in its status. Anything else goes to the server.
   */
  let simulated = null;
  // Whether the steps that lay the Studio out with the shipped workflows are under way.
  let laidOut = false;
  async function paused({ requestId, request, responseStatusCode, responseHeaders }) {
    const answer = (body, type = 'application/json; charset=utf-8') =>
      send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: type }],
        body: Buffer.from(body).toString('base64'),
      });
    try {
      if (!simulated) return await send('Fetch.continueRequest', { requestId });
      if (responseStatusCode !== undefined) {
        const { body, base64Encoded } = await send('Fetch.getResponseBody', { requestId });
        const status = JSON.parse(base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body);
        return await send('Fetch.fulfillRequest', {
          requestId,
          responseCode: responseStatusCode,
          responseHeaders,
          body: Buffer.from(JSON.stringify({ ...status, state: 'ready', busy: false })).toString('base64'),
        });
      }
      if (/\/api\/studio(\?|$)/.test(request.url)) return await answer(JSON.stringify(simulated.studio));
      if (/\/api\/chat(\?|$)/.test(request.url))
        return await answer(simulated.replies.shift() ?? simulated.silence, 'text/event-stream; charset=utf-8');
      if (request.url.includes('/api/tools/')) return await answer('{}');
      return await send('Fetch.continueRequest', { requestId });
    } catch {
      // The page has moved on (a request cancelled): nothing to answer.
    }
  }
  // Each exchange with the browser within 20 s: a page that stops answering is an error, said.
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const number = ++id,
        late = setTimeout(() => {
          pending.delete(number);
          reject(new Error(`${step} : ${method} sans réponse en 20 s`));
        }, 20000);
      pending.set(number, message => {
        clearTimeout(late);
        if (message.error) reject(new Error(method + ' : ' + message.error.message));
        else resolve(message.result);
      });
      socket.send(JSON.stringify({ id: number, method, params }));
    });
  const js = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(step + ' : ' + (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
    return result.result.value;
  };
  const key = async (name, code, keyCode, modifiers = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code, windowsVirtualKeyCode: keyCode, modifiers });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: keyCode, modifiers });
  };
  const click = selector => js(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return false; element.click(); return true; })()`);
  const size = width => send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
  const results = [],
    // What a step may load in vain (its answer may come after it): left out of the report.
    allowances = [];
  /**
   * Asks the page for a condition until it holds, every 50 ms and `ceiling` ms at most, in place
   * of a fixed wait: its last answer (false when it never held).
   */
  async function until(condition, ceiling) {
    for (const end = Date.now() + ceiling; ; await wait(50)) {
      const answer = await condition();
      if (answer !== false || Date.now() >= end) return answer;
    }
  }
  /**
   * One step: what it does, then what the page must show. `allowed`: what this step may load in
   * vain, said beside it (the page answers it as it should). `within`: the page is asked for what
   * the step expects until it shows it, that many milliseconds at most, where the others wait
   * 700 ms and ask once.
   */
  // (`--fluidity`) What the browser counted so far, and what each step cost.
  const counted = async () =>
      Object.fromEntries(((await send('Performance.getMetrics')).metrics ?? []).map(metric => [metric.name, metric.value])),
    costs = [];
  async function run(name, action, expected, { allowed = null, within = 0 } = {}) {
    step = name;
    const before = PERF ? await counted() : null,
      began = Date.now();
    if (PERF) await js('window.__perfTake?.()');
    const done = await action();
    if (!within) await wait(700);
    if (allowed) allowances.push([name, allowed]);
    const shown = expected ? await (within ? until(expected, within) : expected()) : true;
    // An unexpected error said to the user (app.js) is one too.
    const said = await js(`document.getElementById('notice')?.hidden === false ? document.getElementById('notice-text').textContent : ''`);
    if (/inattendue/i.test(said)) problems.push([name, 'notice', said]);
    // A video given the browser's controls during the step, were it for an instant.
    for (const video of (await js(`window.__browserControls?.splice(0) ?? []`)) ?? [])
      problems.push([name, 'lecteur', 'contrôles du navigateur sur une vidéo : ' + video]);
    results.push([name, done !== false && shown !== false]);
    if (PERF) {
      const after = await counted(),
        seen = (await js('window.__perfTake?.()')) ?? { tasks: [], worst: 0, frames: 0 },
        spent = key => Math.round(((after[key] ?? 0) - (before[key] ?? 0)) * 1000);
      costs.push({
        name,
        ms: Date.now() - began,
        tasks: seen.tasks,
        frame: seen.worst,
        frames: seen.frames,
        work: spent('TaskDuration'),
        script: spent('ScriptDuration'),
        style: spent('RecalcStyleDuration'),
        layout: spent('LayoutDuration'),
        nodes: after.Nodes ?? 0,
        heap: Math.round((after.JSHeapUsedSize ?? 0) / 1024 ** 2),
      });
    }
    if (done === false) problems.push([name, 'absent', 'l’élément de cette étape est introuvable']);
    else if (shown === false) problems.push([name, 'état', 'la page ne montre pas ce que cette étape attend']);
  }
  const view = name => () => js(`document.body.dataset.view === ${JSON.stringify(name)}`);
  const dialog = name => () => js(`[...document.querySelectorAll('dialog[open]')].map(d => d.id).includes(${JSON.stringify(name)})`);
  const noDialog = () => js(`!document.querySelector('dialog[open]')`);
  // A line of a menu of the fil (0.6.0): its button opens it, then the line is clicked.
  const fromMenu = (opener, line) =>
    click(opener).then(opened => opened && wait(200).then(() => click(`.thread-menu ${line}`)));
  const menuOpen = () => js(`!!document.querySelector('.thread-menu')`);
  const menuClosed = () => js(`!document.querySelector('.thread-menu')`);
  /** A key as a person presses it (its character too: a button takes Espace from it). */
  const press = async (name, code, keyCode, text) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: keyCode, ...(text ? { text, unmodifiedText: text } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: keyCode });
  };
  /**
   * The clips (0.6.97): a conversation with a video joined to its first message and two takes, one
   * of a reply at 16:9, one of the Studio at 9:16, made of a second of colour the page records itself
   * (MediaRecorder: nothing of the user's, no tool of the computer). Each plays with the player of a
   * take, never the browser's: its ▶ with Espace, « Voir en grand » opens its window. A browser that
   * cannot record skips them, said.
   */
  async function clips() {
    // At the shape of each take (a card takes that of its file once read): 16:9 and 9:16.
    const recorded = await js(`(async () => {
      if (typeof MediaRecorder !== 'function' || !MediaRecorder.isTypeSupported('video/webm')) return null;
      const record = async (width, height) => {
        const canvas = Object.assign(document.createElement('canvas'), { width, height }),
          context = canvas.getContext('2d'),
          recorder = new MediaRecorder(canvas.captureStream(12), { mimeType: 'video/webm' }),
          parts = [],
          stopped = new Promise(resolve => (recorder.onstop = resolve));
        recorder.ondataavailable = event => parts.push(event.data);
        recorder.start();
        for (let frame = 0; frame < 12; frame++) {
          context.fillStyle = 'hsl(' + frame * 30 + ', 60%, 45%)';
          context.fillRect(0, 0, width, height);
          await new Promise(resolve => setTimeout(resolve, 80));
        }
        recorder.stop();
        await stopped;
        const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
        let text = '';
        for (const byte of bytes) text += String.fromCharCode(byte);
        return bytes.length ? btoa(text) : null;
      };
      const [wide, tall] = await Promise.all([record(96, 54), record(54, 96)]);
      return wide && tall ? { wide, tall } : null;
    })()`).catch(() => null);
    if (!recorded) return void console.log('Clips sautés : ce navigateur n’enregistre pas de vidéo (MediaRecorder).');
    const clip = name => Buffer.from(recorded[name], 'base64'),
      conversation = randomUUID(),
      takes = { wide: randomUUID(), tall: randomUUID() },
      gallery = new Gallery({ historyDir: join(data, 'history') });
    await mkdir(join(data, 'output', 'video'), { recursive: true });
    for (const name of ['wide', 'tall']) await writeFile(join(data, 'output', 'video', `verification-${name}.webm`), clip(name));
    for (const [name, [width, height, take]] of Object.entries({ wide: [768, 432, 1], tall: [432, 768, 2] }))
      await gallery.put(
        {
          id: takes[name],
          conversationId: conversation,
          provider: 'native',
          mediaType: 'video',
          workflowId: 'verification',
          workflowName: 'Vérification',
          prompt: 'Une seconde de couleur',
          parameters: { width, height, frames: 12, fps: 12 },
          createdAt: new Date().toISOString(),
          outputs: [{ source: { filename: `verification-${name}.webm`, subfolder: 'video', type: 'output' }, take, width, height }],
        },
        { persist: true },
      );
    // The key of the page, as the launcher reads it (from memory: no work of the server).
    const { token } = await (await fetch(app.url + '/api/bootstrap?brief=1')).json(),
      call = async (route, body, headers = {}) => {
        const response = await fetch(app.url + '/api/' + route, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...headers },
          body: Buffer.isBuffer(body) ? body : JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`${route} : ${response.status} ${await response.text()}`);
        return response.json();
      },
      joined = await call('resources/upload', clip('tall'), { 'Content-Type': 'video/webm', 'X-Resource-Name': 'jointe.webm', 'X-Resource-Project': 'inbox' }),
      made = (id, result) => [
        { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'create_video', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: id, content: JSON.stringify({ status: 'done', ...result }) },
      ];
    await call('history/save', {
      id: conversation,
      messages: [
        { role: 'user', content: `Deux clips à regarder\n[Vidéo jointe : ${joined.label || '#ref1'} « jointe.webm » — resource_id ${joined.id}]` },
        ...made('call_1', { run_id: takes.wide }),
        { role: 'user', content: 'Et une depuis le Studio' },
        ...made('call_2', { run_id: takes.tall, studio: true }),
      ],
    });
    const videos = `[...document.querySelectorAll('#messages video')]`,
      card = index => `document.querySelectorAll('#messages .generation-card .video-original')[${index}]`;
    await run('rechargement avec des clips', () => send('Page.reload').then(() => wait(2000)), view('chat'));
    await run('conversation aux clips', () =>
      click('#thread-conversation').then(() => wait(200)).then(() =>
        js(`(() => { const line = [...document.querySelectorAll('.thread-menu .thread-choice')].find(item => item.textContent.includes('Deux clips')); line?.click(); return !!line; })()`)),
    () => js(`${videos}.length >= 1`), { within: 3000 });
    // Each in sight once, for its card to read its take; then the three clips with the player of a take.
    await run('clips : lecteur de prise partout', async () => {
      for (const index of [0, 1]) {
        await until(() => js(`!!${card(index)} || (document.querySelectorAll('#messages .generation-card')[${index}]?.scrollIntoView({ block: 'center', behavior: 'instant' }), false)`), 3000);
        await js(`${card(index)}?.scrollIntoView({ block: 'center', behavior: 'instant' })`);
      }
    }, () =>
      js(`(() => {
        const all = ${videos},
          hosts = all.map(video => video.parentElement.querySelector(':scope > .take-player')),
          wrap = index => getComputedStyle(${card('index')}.querySelector('.take-player-bar')).flexWrap;
        return all.length === 3 && all.every(video => !video.controls) && hosts.every(host => host && !host.hidden)
          && document.querySelectorAll('#messages .take-player-expand').length === 2
          // At 9:16 (202 px) the time and the buttons go over the line; at 16:9 one row, as in the window of a take.
          && wrap(0) === 'nowrap' && wrap(1) === 'wrap';
      })()`), { within: 3000 });
    // (The clip lasts a second: played in a loop here, or a machine under load asked for its state
    // before it began then after it ended, and the step failed now and then, 0.6.104.)
    await run('clip : Espace sur ▶', async () => {
      await js(`${card(0)}.scrollIntoView({ block: 'center', behavior: 'instant' }); ${card(0)}.querySelector('video').loop = true; ${card(0)}.querySelector('.take-player-play').focus()`);
      await press(' ', 'Space', 32, ' ');
    }, () => js(`${card(0)}.querySelector('video').paused === false && document.activeElement?.getAttribute('aria-label') === 'Mettre en pause'`), { within: 5000 });
    await run('clip : Espace de nouveau, en pause', () => press(' ', 'Space', 32, ' '), () =>
      js(`${card(0)}.querySelector('video').paused === true && !${card(0)}.querySelector('video').controls`), { within: 5000 });
    await run('clip : Voir en grand', () => js(`${card(0)}.querySelector('.take-player-expand').click()`), () =>
      js(`document.getElementById('original-dialog').open && !document.getElementById('take-player').hidden && !document.getElementById('original-video').controls`), { within: 2000 });
    await run('Échap (fenêtre de la prise)', () => key('Escape', 'Escape', 27), noDialog);
    await run('Pellicule : clips', () => click('#library-open'), () =>
      js(`document.querySelectorAll('#library-view .library-tile[data-media="video"]').length === 2 && ![...document.querySelectorAll('#library-view video')].some(video => video.controls)`), { within: 2000 });
    await run('Chat depuis la Pellicule (clips)', () => click('#chat-open'), view('chat'));
  }

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  // Any video of the page given the browser's controls, even for an instant (0.6.97: the player of
  // a take everywhere, take-player.mjs), from the first line of the page to the last step.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__browserControls = [];
      new MutationObserver(changes => {
        for (const change of changes)
          for (const item of [change.target, ...change.addedNodes])
            for (const video of item.querySelectorAll ? [item, ...item.querySelectorAll('video')] : [])
              if (video.localName === 'video' && video.hasAttribute('controls'))
                window.__browserControls.push((video.getAttribute('aria-label') || video.parentElement?.className || 'vidéo') + '');
      }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['controls'] });` +
      (PERF
        ? `
      window.__perf = { tasks: [], worst: 0, frames: 0, last: 0 };
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) window.__perf.tasks.push(Math.round(entry.duration));
      }).observe({ entryTypes: ['longtask'] });
      requestAnimationFrame(function frame(now) {
        const perf = window.__perf;
        if (perf.last) perf.worst = Math.max(perf.worst, now - perf.last);
        perf.last = now;
        perf.frames++;
        requestAnimationFrame(frame);
      });
      window.__perfTake = () => {
        const perf = window.__perf,
          taken = { tasks: perf.tasks.splice(0), worst: Math.round(perf.worst), frames: perf.frames };
        perf.worst = 0;
        perf.frames = 0;
        return taken;
      };`
        : ''),
  });
  if (PERF) await send('Performance.enable');
  await size(1280);
  await send('Page.navigate', { url: app.url + '/' });
  await wait(2500);
  // At launch, with no conversation yet: a new conversation (0.5.123: no home page any more).
  await run('lancement', () => true, view('chat'));
  await run('chat', () => click('#chat-open'), view('chat'));
  // The welcome (0.6.5): a shortcut puts its label at the start of the box, its cross takes it off.
  await run('raccourci « Créer une image »', () => click('.suggestions [data-label="Image"]'), () =>
    js(`!document.getElementById('prompt-label').hidden && document.querySelector('[data-label="Image"]').getAttribute('aria-pressed') === 'true'`));
  await run('retirer l’étiquette', () => click('#prompt-label-clear'), () => js(`document.getElementById('prompt-label').hidden`));
  // « Modèle » and « Réflexion », two buttons of the bar (0.6.64): one menu at a time.
  await run('menu du modèle', () => click('#model-choice'), () =>
    js(`!document.getElementById('model-choice-menu').hidden && document.getElementById('model-choice-text').textContent.length > 0`));
  await run('menu de la réflexion', () => click('#effort-choice'), () =>
    js(`document.getElementById('model-choice-menu').hidden && !document.getElementById('effort-choice-menu').hidden`));
  await run('sans réflexion', () => click('#effort-choice-menu [data-key="thinking:false"]'), () =>
    js(`document.getElementById('effort-choice-menu').hidden && document.getElementById('effort-choice-text').textContent === 'Sans réflexion'`));
  await run('avec réflexion', () => click('#effort-choice').then(() => wait(200)).then(() => click('#effort-choice-menu [data-key="thinking:true"]')), () =>
    js(`document.getElementById('effort-choice-text').textContent === 'Réflexion'`));
  await run('nouvelle conversation depuis le chat', () => fromMenu('#thread-conversation', '.thread-action'), view('chat'));
  await run('studio', () => click('#studio-open'), view('studio'));
  for (const mode of ['Vidéo', 'Son', 'Image'])
    await run('mode ' + mode, () => click(`#studio-kinds .kind-tab[aria-label="${mode}"]`), view('studio'));
  // (0.6.137) « Montage », the fourth mode: the timeline in the place of the Sortie, the four blocks whole
  // in the window, three tracks, nothing to export yet, the page not scrolling; then back to Image.
  await run('mode Montage', () => click('#studio-kinds .kind-tab[aria-label="Montage"]'), () =>
    js(`(() => { const desk = document.querySelector('#studio-view .studio-desk.is-montage'); if (!desk) return false; const blocks = [...desk.querySelectorAll('.studio-block')]; return blocks.length === 4 && blocks.every(block => { const box = block.getBoundingClientRect(); return box.width > 100 && box.height > 100 && box.bottom <= innerHeight + 1 && box.right <= innerWidth + 1; }) && document.querySelector('#studio-kinds .kind-tab[aria-selected="true"]')?.dataset.mode === 'montage' && desk.querySelectorAll('.montage-track').length === 3 && desk.querySelector('.montage-export').disabled && desk.querySelector('.montage-frame').getBoundingClientRect().height > 80 && document.documentElement.scrollHeight <= innerHeight + 1; })()`), { within: 2500 });
  await run('retour au mode Image', () => click('#studio-kinds .kind-tab[aria-label="Image"]'), () =>
    js(`!document.querySelector('#studio-view .studio-desk.is-montage') && document.querySelector('#studio-kinds .kind-tab[aria-selected="true"]')?.dataset.mode === 'image'`), { within: 1500 });
  await run('Agent', () => click('#studio-view .studio-agent'), () => js(`document.body.dataset.chat === 'open'`));
  await run('Échap (Agent)', () => key('Escape', 'Escape', 27), () => js(`document.body.dataset.chat !== 'open'`));
  // (0.6.95) A video proposed from the chat of the Agent: the pointer sets it in the Studio, and what
  // Moodix AI understood is said at the top of the screen, its prompt folded under it, without moving
  // the Studio; both unfold; « Refuser » takes them away. The model and the tools of the Studio are
  // simulated (a real LLM, a real engine are not there), the page is the page.
  const words =
    'Un plan fixe de six secondes en 9:16 : la mer se lève doucement autour du phare, puis la lumière du phare ' +
    'balaie la brume, sans mouvement de caméra. Je garde la lumière bleue du soir et un cadrage serré, pour que ' +
    'le mouvement reste discret. Dites-moi si vous préférez une nuit plus noire.';
  const asked =
    'Plan fixe, cadrage serré sur un phare de pierre au crépuscule. La mer se lève doucement autour du rocher, ' +
    'des vagues lentes viennent battre la base du phare et retombent en écume. Au milieu du plan, la lumière du ' +
    'phare s’allume et balaie la brume de gauche à droite, une fois, lentement. Ciel bleu sombre, quelques étoiles, ' +
    'brume légère au ras de l’eau. Le son : le ressac, un vent léger, une corne de brume lointaine vers la fin. ' +
    'Pas de coupe, pas de mouvement de caméra, grain fin de pellicule.';
  const lengths = [121 / 24, 145 / 24, 193 / 24];
  const stream = events => events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n';
  const proposal = {
    kind: 'generation',
    requestId: 'verif-1',
    approvalToken: 'verif-1',
    tool: 'create_video',
    mediaType: 'video',
    workflowName: 'LTX 2.5',
    autoAllow: false,
    resolution: { width: 448, height: 768 },
    call: { id: 'call-verif-1', type: 'function', function: { name: 'create_video', arguments: '{}' } },
    plan: {
      prompt: asked,
      stage: 'draft',
      parameters: { prompt: asked, width: 448, height: 768, frames: 145, fps: 24, seed: 7 },
      editable: {
        prompt: true,
        stages: [],
        parameters: [
          { key: 'frames', type: 'integer', value: 145, choices: [121, 145, 193] },
          { key: 'width', type: 'integer', value: 448 },
          { key: 'height', type: 'integer', value: 768 },
          { key: 'seed', type: 'integer', value: 7 },
        ],
        references: [],
      },
      references: [],
    },
  };
  const sizes = { width: { min: 64, max: 4096, multipleOf: 32 }, height: { min: 64, max: 4096, multipleOf: 32 } };
  simulated = {
    studio: {
      enabled: true,
      styles: [],
      presets: {},
      tools: {
        create_video: [
          { id: 'ltx-verif', name: 'LTX 2.5', media: 'video', verb: 'create_video', family: 'ltx25', seeded: true, roles: {}, inputs: {},
            limits: sizes, size: { width: 768, height: 448 }, lengths: { seconds: lengths, standard: lengths[0] }, loras: [], settings: [] },
        ],
      },
    },
    replies: [stream([{ choices: [{ delta: { content: words } }] }, { local_tool_request: proposal }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }])],
    // Any other request of an answer (none is expected): nothing said.
    silence: stream([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]),
  };
  await send('Fetch.enable', {
    patterns: [
      { urlPattern: '*/api/studio', requestStage: 'Request' },
      { urlPattern: '*/api/chat', requestStage: 'Request' },
      { urlPattern: '*/api/tools/*', requestStage: 'Request' },
      { urlPattern: '*/api/status*', requestStage: 'Response' },
    ],
  });
  const explained = `document.querySelector('#studio-view .studio-screen-head > .studio-explain')`;
  await run(
    'proposition de Moodix AI dans le Studio',
    async () => {
      // (The status of a model ready read once by the page meanwhile.)
      await wait(600);
      if (!(await click('#agent-open'))) return false;
      await wait(500);
      // (0.6.101) Where the label of the pointer is, at each drawing of the page while it shows: it
      // must stay whole in the window, from the column of the prompt to the settings too.
      await js(`(() => {
        const cursor = document.getElementById('ai-cursor'), label = cursor.querySelector('.ai-cursor-label');
        window.__label = { seen: 0, left: Infinity, right: -Infinity };
        const look = () => {
          if (!cursor.hidden && cursor.classList.contains('is-visible')) {
            const box = label.getBoundingClientRect();
            window.__label.seen++;
            window.__label.left = Math.min(window.__label.left, box.left);
            window.__label.right = Math.max(window.__label.right, box.right);
          }
          window.__labelLook = requestAnimationFrame(look);
        };
        look();
      })()`);
      await js(`(() => { const p = document.getElementById('prompt'); p.value = 'Fais bouger la mer autour du phare.'; p.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      return click('#send');
    },
    () =>
      js(`(() => {
        const explain = ${explained}, view = document.getElementById('studio-view'), head = view.querySelector('.studio-screen-head');
        return !!explain && document.getElementById('ai-cursor-text')?.textContent === 'attend votre accord' && view.inert === false &&
          explain.querySelector('.studio-explain-said')?.textContent.replace(/\\u00a0/g, ' ') === ${JSON.stringify(words)} &&
          !explain.querySelector('.studio-explain-more').hidden && head.getBoundingClientRect().height <= 41 &&
          !!view.querySelector('.studio-prompt-field.is-folded.is-cut') && !view.querySelector('.studio-prompt-more').hidden &&
          view.scrollHeight <= view.clientHeight + 1 &&
          // (0.6.101) The empty screen does not tell to « laisser Moodix AI régler le Studio » while it
          // does so; the label of its pointer was whole in the window all along.
          !!view.querySelector('.studio-frame.is-empty .studio-blank-title') && !view.querySelector('.studio-blank-text') &&
          window.__label.seen > 0 && window.__label.left >= 0 && window.__label.right <= innerWidth;
      })()`),
    { within: 15000 },
  );
  await js(`cancelAnimationFrame(window.__labelLook)`);
  await run('explication dépliée', () => click('#studio-view .studio-explain-more'), () =>
    js(`${explained}?.classList.contains('is-open') && ${explained}.querySelector('.studio-explain-more').getAttribute('aria-expanded') === 'true' && document.querySelector('#studio-view .studio-screen-head').getBoundingClientRect().height > 41`), { within: 1500 });
  await run('prompt déplié', () => click('#studio-view .studio-prompt-more'), () =>
    js(`!document.querySelector('#studio-view .studio-prompt-field.is-folded') && document.querySelector('#studio-view .studio-prompt-more')?.getAttribute('aria-expanded') === 'true'`), { within: 1500 });
  // (Refused in the Studio, the turn ends there, without a word of the model: 16/11.)
  await run('refuser la proposition', () => click('#studio-view .studio-decline'), () =>
    js(`!document.querySelector('#studio-view .studio-explain') && !document.querySelector('#studio-view .studio-prompt-more') && !document.querySelector('#studio-view .studio-decline') && !document.getElementById('agent-open').classList.contains('is-thinking')`), { within: 3000 });
  // (0.6.101) The empty screen in every format, in a window of 720 px (a frame of 9:16 is 150 px wide
  // there): no part of it out of its frame, no word wider than its line. Each frame eases to its
  // format in 0.55 s before it is measured.
  await run(
    'écran vide dans chaque format (1280 × 720)',
    async () => {
      await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
      await wait(400);
      return js(`(async () => {
        const pause = ms => new Promise(resolve => setTimeout(resolve, ms)), wrong = [];
        for (const format of ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9']) {
          const chip = [...document.querySelectorAll('#studio-view .studio-format')].find(button => button.textContent.trim() === format);
          if (chip) chip.click();
          else {
            document.querySelector('#studio-view .studio-format.is-more')?.click();
            await pause(150);
            const choice = [...document.querySelectorAll('#studio-view .studio-format-menu button')].find(button => button.textContent.trim() === format);
            if (!choice) {
              wrong.push(format + ' absent');
              continue;
            }
            choice.click();
          }
          await pause(700);
          const frame = document.querySelector('#studio-view .studio-frame.is-empty');
          if (!frame) {
            wrong.push(format + ' sans écran vide');
            continue;
          }
          const edge = frame.getBoundingClientRect();
          for (const part of frame.querySelectorAll('.studio-blank > *')) {
            if (getComputedStyle(part).display === 'none') continue;
            const box = part.getBoundingClientRect();
            if (box.top < edge.top - 0.5 || box.bottom > edge.bottom + 0.5 || box.left < edge.left - 0.5 || box.right > edge.right + 0.5 || part.scrollWidth > part.clientWidth + 1)
              wrong.push(format + ' ' + (part.className.baseVal ?? part.className));
          }
        }
        window.__blankWrong = wrong;
        return true;
      })()`);
    },
    async () => {
      const wrong = await js(`window.__blankWrong`);
      if (wrong.length) problems.push([step, 'débord', wrong.join(', ')]);
      return wrong.length === 0;
    },
  );
  // (The window back to 800 px: its resizing closes any menu, so the next one is opened after it.)
  await size(1280);
  await wait(400);
  simulated = null;
  await send('Fetch.disable');
  await run('nouvelle conversation depuis le Studio', () => fromMenu('#thread-conversation', '.thread-action'), view('studio'));
  await run('menu des projets', () => click('#thread-project'), menuOpen);
  await run('Échap (menu des projets)', () => key('Escape', 'Escape', 27), menuClosed);
  await run('recherche des conversations', () =>
    click('#thread-conversation').then(() => wait(200)).then(() => js(`(() => { const f = document.querySelector('.thread-menu input'); if (!f) return false; f.value = 'renard'; f.dispatchEvent(new Event('input')); return true; })()`)),
  () => js(`!document.querySelector('.thread-empty')?.hidden`));
  await run('Échap (menu des conversations)', () => key('Escape', 'Escape', 27), menuClosed);
  // The fil heads the Pellicule (0.6.40): « Tous les projets » alone, then a project and its
  // conversations from its menus; « + Nouvelle conversation » opens the welcome in it.
  await run('Pellicule', () => click('#library-open'), () =>
    js(`document.body.dataset.view === 'library' && !!document.querySelector('#library-thread > #thread:not([hidden])') && document.getElementById('thread').dataset.scope === 'all' && document.getElementById('thread-project-name').textContent === 'Tous les projets' && !document.getElementById('library-empty').hidden`));
  await run('type Vidéos', () => click('#library-kinds [data-kind="video"]'), () =>
    js(`document.querySelector('#library-kinds [data-kind="video"]')?.getAttribute('aria-checked') === 'true'`));
  await run('menu des projets dans la Pellicule', () => click('#thread-project'), () =>
    js(`document.querySelector('.thread-menu .thread-line .thread-choice-name')?.textContent === 'Tous les projets'`));
  await run('projet dans la Pellicule', () => click('.thread-menu .thread-lines .thread-line:last-child .thread-choice'), () =>
    js(`document.body.dataset.view === 'library' && document.getElementById('thread').dataset.scope === 'project' && document.getElementById('thread-project-name').textContent === 'Sans projet' && document.getElementById('thread-shown').textContent === 'Toutes les conversations' && !document.querySelector('.thread-menu')`));
  await run('nouveau chat du projet', () => fromMenu('#thread-conversation', '.thread-action'), () =>
    js(`document.body.dataset.view === 'chat' && !!document.querySelector('.workspace > #thread:not([hidden])') && !document.getElementById('conversation-title').hidden`));
  await run('Pellicule, de nouveau', () => click('#library-open'), view('library'));
  await run('Chat depuis la Pellicule', () => click('#chat-open'), view('chat'));
  // Typed with a real key, as a person does: the page has had a gesture of its user, so that its
  // « Quitter la page ? » (a draft in the box) may show at the reload below (Ctrl+B gave it that
  // gesture until 0.6.1; Escape never does).
  await run('« # » dans la saisie', async () => {
    await js(`(() => { const p = document.getElementById('prompt'); p.value = ''; p.focus(); return true; })()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '#', text: '#', unmodifiedText: '#' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '#' });
    return js(`document.getElementById('prompt').value === '#'`);
  });
  await run('Configuration', () => click('#settings-open'), dialog('settings'));
  // The editor of a workflow, at 1280 × 720 (17/11): taller than the window, its body scrolls, to
  // the wheel as to the keys, and its foot (« Enregistrer le workflow ») stays in sight.
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  const editorBody = `document.getElementById('native-workflow-body')`;
  // These steps ask the page until it shows what they expect (`within`: the time each one waited
  // before, at most) instead of waiting that time every run: some seven seconds less.
  // (0.6.119) The page « Modèles » (maquette du 19/11): one line a model in four groups, with the
  // workflows Moodix ships (this copy has none of their files: every model is to be downloaded).
  const lines = `[...document.querySelectorAll('#workflow-list .model-line')]`,
    ltx = `document.querySelector('#workflow-list .model-line[data-model="LTX 2.5"]')`;
  // (0.6.131) « Dossiers à part » : a folder a line of 46 px (its name, the folder, « Parcourir »,
  // « Détecter », « ? »), nothing folded, nothing that scrolls sideways.
  await run('onglet Génération : un dossier par ligne', () => click('#settings-tab-generation'), () =>
    js(`(() => { const rows = [...document.querySelectorAll('#settings-panel-generation .set-folder')], panel = document.getElementById('settings-panel-generation'); return rows.length === 7 && rows.every(row => Math.round(row.getBoundingClientRect().height) === 46 && row.querySelectorAll('button.set-act').length === 2 && row.querySelector('.help-tip').dataset.help) && !panel.querySelector('details') && panel.scrollWidth <= panel.clientWidth + 1; })()`), { within: 2500 });
  await run('onglet Modèles', () => click('#settings-tab-workflows'), () =>
    js(`${lines}.length === 11 && document.querySelectorAll('#workflow-list .model-group').length === 4 && document.querySelector('#settings-tab-workflows .settings-tab-label').textContent === 'Modèles' && document.querySelectorAll('#workflow-list .model-row > .model-ai input').length === 11 && document.querySelectorAll('#workflow-list .model-ai-head').length === 1`), { within: 2500 });
  // Every line is 46 px tall, « Télécharger » in the place of the version as any other (capture 65);
  // nothing scrolls sideways, nothing of before is shown (no button to import or create, no dot).
  await run('Modèles : lignes de 46 px', async () => {}, () =>
    js(`(() => { const rows = [...document.querySelectorAll('#workflow-list .model-row')], panel = document.getElementById('settings-panel-workflows'), gone = id => !document.getElementById(id); return rows.length === 11 && rows.every(row => Math.round(row.getBoundingClientRect().height) === 46) && panel.scrollWidth <= panel.clientWidth + 1 && gone('workflow-add') && gone('native-workflow-import') && !document.querySelector('#workflow-list .workflow-state') && document.querySelectorAll('#workflow-list .model-download').length >= 5; })()`), { within: 700 });
  // The chevron unfolds the versions under the line, which stays as tall; « Réglages » is then in sight.
  await run('Modèles : versions dépliées', () => click('#workflow-list .model-line[data-model="LTX 2.5"] .model-chevron'), () =>
    js(`(() => { const line = ${ltx}; return line?.dataset.open === 'true' && Boolean(line.querySelector('.model-versions')) && Math.round(line.querySelector('.model-row').getBoundingClientRect().height) === 46 && line.querySelector('.model-chevron').getAttribute('aria-expanded') === 'true' && getComputedStyle(line.querySelector('.model-settings')).opacity === '1'; })()`), { within: 700 });
  // The page of a model, behind « Réglages », named after it (0.6.128: « Proposé à Moodix AI » at its
  // head, a line of 46 px a file and a setting, neither « Fixe » nor « Assistant »).
  await run('éditeur de modèle', () => click('#workflow-list .model-line[data-model="LTX 2.5"] .model-settings'), () =>
    js(`!document.getElementById('workflow-editor').hidden && document.getElementById('native-workflow-title').textContent === 'Réglages de LTX 2.5' && ${editorBody}.scrollHeight > ${editorBody}.clientHeight + 200`), { within: 1500 });
  await run('éditeur : une ligne par fichier et par réglage', async () => {}, () =>
    js(`(() => { const lines = [...document.querySelectorAll('#native-workflow-components .set-line, #native-workflow-parameters .set-line')], hero = document.getElementById('native-workflow-hero').getBoundingClientRect(), body = ${editorBody}; return lines.length >= 15 && lines.every(line => Math.round(line.getBoundingClientRect().height) === 46) && hero.height > 100 && document.getElementById('native-workflow-enabled').checked && body.scrollWidth <= body.clientWidth + 1 && !document.querySelector('#workflow-editor .native-policy-switch') && /choisit le format, la durée/.test(document.getElementById('native-workflow-chosen').textContent) && document.querySelector('#native-value-steps').disabled && document.querySelectorAll('#workflow-editor .set-line > .help-tip').length >= 15; })()`), { within: 700 });
  await run('éditeur : molette', async () => {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 400, deltaX: 0, deltaY: 600 });
  }, () => js(`${editorBody}.scrollTop > 100`), { within: 700 });
  await run('éditeur : touche Fin', async () => {
    await js(`${editorBody}.focus()`);
    await key('End', 'End', 35);
  }, () => js(`${editorBody}.scrollTop >= ${editorBody}.scrollHeight - ${editorBody}.clientHeight - 2`), { within: 1500 });
  // Back at the top, the foot is in sight (it never left: the body alone scrolls).
  // (0.6.128) The scroll « Fin » started is left to end first: the step before is answered two pixels
  // from the bottom, while it still glides, and a « Début » pressed then was lost two runs in three
  // (the page stayed at the bottom) once the page of a model was short enough for that to show.
  await run('éditeur : touche Début, pied en vue', async () => {
    await wait(400);
    await key('Home', 'Home', 36);
  }, () =>
    js(`(() => { const save = document.getElementById('native-workflow-save').getBoundingClientRect(), frame = document.getElementById('settings').getBoundingClientRect(); return ${editorBody}.scrollTop === 0 && save.height > 0 && save.bottom <= frame.bottom && save.bottom <= innerHeight; })()`), { within: 1500 });
  // « Retour » : nothing was changed, the page « Modèles » is there again, its line still unfolded.
  await run('quitter l’éditeur', () => click('#native-workflow-back'), () =>
    js(`document.getElementById('workflow-editor').hidden && !document.getElementById('settings-form').hidden && ${ltx}?.dataset.open === 'true'`), { within: 700 });
  await size(1280);
  await run('Échap (Configuration)', () => key('Escape', 'Escape', 27), noDialog);
  await run('nouveau projet', () => fromMenu('#thread-project', '.thread-action'), dialog('project-dialog'));
  await run('Échap (projet)', () => key('Escape', 'Escape', 27), noDialog);
  // The LLM registered here has no files: its start is refused (400), and the page says so.
  await run('bouton du modèle', () => click('#toggle-engine'), null, { allowed: /\/api\/start$/ });
  await run('Échap', () => key('Escape', 'Escape', 27), noDialog);
  await size(900);
  await wait(400);
  await run('Pellicule à 900 px', () => click('#library-open'), view('library'));
  await run('Chat à 900 px', () => click('#chat-open'), view('chat'));
  await size(1280);
  await clips();
  await run('rechargement', () => send('Page.reload').then(() => wait(2000)), view('chat'));
  // The Studio with the tools of the shipped workflows (0.6.98): no block of it over the Sortie,
  // every setting in sight within reach of the pointer, the page not scrolling. In each mode, with each
  // model, as it opens and with all it may show (three LoRAs, the lyrics, « Plus de réglages »), at
  // 1280 × 720 and 1440 × 900. At 1280 × 720 the settings of Krea 2 went 132 px under the Sortie,
  // which took the pointer there. The message box is emptied first: nothing to leave, nothing asked.
  laidOut = true;
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/studio', requestStage: 'Request' }] });
  await run(
    'Studio avec les workflows fournis',
    async () => {
      await js(`(() => { const p = document.getElementById('prompt'); p.value = ''; p.dispatchEvent(new Event('input')); return true; })()`);
      await send('Page.reload');
      await wait(2000);
      return click('#studio-open');
    },
    () => js(`document.querySelectorAll('#studio-view .studio-model-pick option').length > 1`),
    { within: 6000 },
  );
  for (const [width, height] of [
    [1280, 720],
    [1440, 900],
  ])
    await run(
      `Studio : rien sous la Sortie, tout à portée (${width} × ${height})`,
      () => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }),
      async () => {
        const found = await js(STUDIO_LAYOUT);
        for (const what of found) problems.push([step, 'état', what]);
        return found.length === 0;
      },
    );
  await send('Fetch.disable');
  laidOut = false;
  console.log(`Vérification de l’interface (${browser.split(/[\\/]/).pop()}) : ${results.filter(([, ok]) => ok).length}/${results.length} étapes.`);
  if (PERF) {
    // One line a step for whoever reads the numbers (a file, a chart), then the slow ones in words.
    console.log('FLUIDITE ' + JSON.stringify(costs));
    const slow = costs.filter(cost => cost.tasks.some(task => task >= 100) || cost.work >= 300 || cost.frame >= 100);
    console.log(
      `Fluidité${WINDOW ? ' (fenêtre réelle)' : ''} : ${costs.length - slow.length}/${costs.length} étapes sans tâche de 100 ms, ` +
        'sans 300 ms de travail et sans attente de 100 ms entre deux images.',
    );
    for (const cost of slow.sort((a, b) => b.work - a.work))
      console.log(
        `  · ${cost.name} : ${cost.work} ms de travail (script ${cost.script}, style ${cost.style}, mise en page ${cost.layout})` +
          `, attente la plus longue entre deux images ${cost.frame} ms` +
          (cost.tasks.length ? `, tâches longues ${cost.tasks.join(' + ')} ms` : ''),
      );
    // (Measured on 19 November 2026: 144 ms at the first opening of the settings with a new profile,
    // 11 and 17 ms at the next two launches with the same one.)
    if (WINDOW && slow.some(cost => cost.frame >= 100))
      console.log(
        '  (Le profil du navigateur est neuf à chaque mesure : la première apparition d’un flou d’arrière-plan est ' +
          'compilée par le pilote graphique, 100 à 250 ms une seule fois. Le navigateur d’un utilisateur la garde.)',
      );
  }
  for (const [name, allowed] of allowances)
    for (let index = problems.length - 1; index >= 0; index--)
      if (problems[index][0] === name && problems[index][1] === 'chargement' && allowed.test(problems[index][2]))
        problems.splice(index, 1);
  if (problems.length) {
    console.error('Erreurs de la page :');
    for (const [where, kind, what] of problems) console.error(`  · ${where} [${kind}] ${what}`);
    await finish(1);
  }
  await finish(0);
} catch (error) {
  console.error('Vérification de l’interface impossible : ' + error.message);
  for (const [where, kind, what] of problems) console.error(`  · ${where} [${kind}] ${what}`);
  await finish(1);
}
