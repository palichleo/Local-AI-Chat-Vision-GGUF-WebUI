#!/usr/bin/env node
/**
 * Goes through the interface in a headless browser, on a copy of the server with an empty data
 * folder (the user's library, chats and settings are never touched), and fails on any error of
 * the page: an exception, an error written to the console, a file the page cannot load, or the
 * notice of an unexpected error (app.js). Run before each commit (.githooks/pre-commit) and by
 * `npm run check:ui`. « Nouveau chat » stopped silently from 0.5.87 to 0.5.109: this would have
 * caught it at once.
 *
 * The browser: MOODIX_BROWSER, or Brave, Chrome, Edge or Chromium where they are usually
 * installed. None found: said, and the check is skipped (it never blocks for want of one).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
if (!browser) {
  console.log('Vérification de l’interface sautée : aucun navigateur Chromium trouvé (MOODIX_BROWSER pour en indiquer un).');
  process.exit(0);
}

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
     const app = await createApplication({ port: 0, dataDir: ${JSON.stringify(data)} });
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
const chrome = spawn(browser, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], {
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
    } else if (message.method === 'Page.javascriptDialogOpening')
      // « Quitter la page ? » (a draft in the message box): left, as a user would.
      socket.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    else if (message.method === 'Runtime.exceptionThrown')
      problems.push([step, 'exception', message.params.exceptionDetails.exception?.description?.split('\n')[0] ?? message.params.exceptionDetails.text]);
    else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error')
      problems.push([step, 'console', message.params.args.map(arg => arg.value ?? arg.description).join(' ').slice(0, 300)]);
    else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error')
      problems.push([step, 'chargement', (message.params.entry.text + ' ' + (message.params.entry.url ?? '')).slice(0, 300)]);
  };
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
   * One step: what it does, then what the page must show. `allowed`: what this step may load in
   * vain, said beside it (the page answers it as it should).
   */
  async function run(name, action, expected, { allowed = null } = {}) {
    step = name;
    const done = await action();
    await wait(700);
    if (allowed) allowances.push([name, allowed]);
    const shown = expected ? await expected() : true;
    // An unexpected error said to the user (app.js) is one too.
    const said = await js(`document.getElementById('notice')?.hidden === false ? document.getElementById('notice-text').textContent : ''`);
    if (/inattendue/i.test(said)) problems.push([name, 'notice', said]);
    results.push([name, done !== false && shown !== false]);
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

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
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
  await run('nouvelle conversation depuis le chat', () => fromMenu('#thread-conversation', '.thread-action'), view('chat'));
  await run('studio', () => click('#studio-open'), view('studio'));
  for (const mode of ['Vidéo', 'Son', 'Image'])
    await run('mode ' + mode, () => click(`#studio-kinds .kind-tab[aria-label="${mode}"]`), view('studio'));
  await run('Agent', () => click('#studio-view .studio-agent'), () => js(`document.body.dataset.chat === 'open'`));
  await run('Échap (Agent)', () => key('Escape', 'Escape', 27), () => js(`document.body.dataset.chat !== 'open'`));
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
  await run('onglet Workflows', () => click('#settings-tab-workflows'), () => js(`!document.getElementById('workflow-add').hidden`));
  await run('éditeur de workflow', () => click('#workflow-add'), () =>
    js(`!document.getElementById('workflow-editor').hidden && ${editorBody}.scrollHeight > ${editorBody}.clientHeight + 200`));
  await run('éditeur : molette', async () => {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 400, deltaX: 0, deltaY: 600 });
  }, () => js(`${editorBody}.scrollTop > 100`));
  await run('éditeur : touche Fin', async () => {
    await js(`${editorBody}.focus()`);
    await key('End', 'End', 35);
    await wait(800);
  }, () => js(`${editorBody}.scrollTop >= ${editorBody}.scrollHeight - ${editorBody}.clientHeight - 2`));
  await run('éditeur : touche Début', async () => {
    await key('Home', 'Home', 36);
    await wait(800);
  }, () => js(`${editorBody}.scrollTop === 0`));
  await run('éditeur : pied en vue', () => true, () =>
    js(`(() => { const save = document.getElementById('native-workflow-save').getBoundingClientRect(), frame = document.getElementById('settings').getBoundingClientRect(); return save.height > 0 && save.bottom <= frame.bottom && save.bottom <= innerHeight; })()`));
  await run('quitter l’éditeur', () => click('#native-workflow-back').then(() => wait(200)).then(() => click('#native-workflow-discard')), () =>
    js(`document.getElementById('workflow-editor').hidden && !document.getElementById('settings-form').hidden`));
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
  await run('rechargement', () => send('Page.reload').then(() => wait(2000)), view('chat'));
  console.log(`Vérification de l’interface (${browser.split(/[\\/]/).pop()}) : ${results.filter(([, ok]) => ok).length}/${results.length} étapes.`);
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
