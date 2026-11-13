import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import * as module from '../public/update-ui.mjs';
import * as sessionCopies from '../public/session-copies.mjs';
import * as chatVideos from '../public/chat-videos.mjs';
test('install click sends the session once and reloads only when a replacement server is ready', async () => {
  assert.equal(typeof module.installFromButton, 'function');
  let sent = 0,
    reads = 0,
    reloaded = 0;
  const progress = [];
  await module.installFromButton({
    token: 'old-token',
    session: { prompt: 'draft' },
    api: async (route, body) => {
      if (body) {
        assert.equal(route, 'updates/install');
        assert.equal(body.session.prompt, 'draft');
        sent++;
        return Response.json({ state: 'preparing' });
      }
      return Response.json({ state: 'preparing' });
    },
    bootstrap: async () =>
      ++reads === 1 ? { token: 'old-token', updating: true } : { token: 'new-token', updating: false },
    pause: async () => {},
    onProgress: message => progress.push(message),
    reload: () => {
      reloaded++;
    },
  });
  assert.equal(sent, 1);
  assert.equal(reloaded, 1);
  assert.equal(reads, 2);
  assert.ok(progress.length > 0);
});
test('a busy server keeps the click: the install is asked again until it can start', async () => {
  let asked = 0,
    reloaded = 0;
  const progress = [];
  await module.installFromButton({
    token: 'old',
    session: { prompt: 'draft' },
    api: async (route, body) => {
      if (body) {
        asked++;
        if (asked < 3)
          throw Object.assign(new Error('Attends la fin de l’opération en cours avant la mise à jour.'), {
            status: 409,
            busy: true,
          });
        return Response.json({ state: 'preparing' });
      }
      return Response.json({ state: 'restarting' });
    },
    bootstrap: async () => ({ token: 'new', updating: false }),
    pause: async () => {},
    onProgress: message => progress.push(message),
    reload: () => {
      reloaded++;
    },
  });
  assert.equal(asked, 3);
  assert.equal(reloaded, 1);
  assert.ok(progress.some(message => /démarrera ensuite/.test(message)));
  // Another refusal (no update to install) is said at once.
  await assert.rejects(
    module.installFromButton({
      token: 'old',
      session: {},
      api: async () => {
        throw Object.assign(new Error('Aucune mise à jour installable.'), { status: 409 });
      },
      bootstrap: async () => ({ token: 'old' }),
      pause: async () => {},
      onProgress() {},
    }),
    /Aucune mise à jour installable/,
  );
});
test('a failed install surfaces its error and leaves the current page and draft intact', async () => {
  assert.equal(typeof module.installFromButton, 'function');
  let reloaded = false;
  await assert.rejects(
    module.installFromButton({
      token: 'old',
      session: { prompt: 'keep' },
      api: async (_route, body) =>
        Response.json(body ? { state: 'preparing' } : { state: 'error', error: 'Download failed' }),
      bootstrap: async () => ({ token: 'old', updating: false }),
      pause: async () => {},
      onProgress() {},
      reload: () => {
        reloaded = true;
      },
    }),
    /Download failed/,
  );
  assert.equal(reloaded, false);
});

test('download failure keeps configuration, file selection and composer controls usable', async () => {
  const { readFile } = await import('node:fs/promises');
  const { runInNewContext } = await import('node:vm');
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const controls = source.slice(
    source.indexOf('function updateControls()'),
    source.indexOf('async function checkUpdates('),
  );
  const install = source.slice(source.indexOf('async function installUpdate('), source.indexOf('function applyTheme('));
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id))
      nodes.set(id, {
        disabled: false,
        value: '',
        textContent: '',
        open: false,
        classList: { toggle() {}, contains: () => false },
        setAttribute() {},
        replaceChildren() {},
        close() {
          this.open = false;
        },
        showModal() {
          this.open = true;
        },
      });
    return nodes.get(id);
  };
  for (const id of ['settings-open', 'settings-close', 'image-input', 'model-path', 'prompt', 'send']) get(id);
  const state = {
    status: { state: 'stopped', busy: false, logs: [] },
    connected: true,
    config: {},
    messages: [],
    images: [],
    videos: [],
    token: 'old',
  };
  const context = {
    ...sessionCopies,
    ...chatVideos,
    projectUI: { sync() {} },
    assetsUI: { setBusy() {} },
    settingsGuard: { isDirty: () => false },
    compactSession: module.compactSession,
    state,
    $: get,
    document: {
      querySelectorAll: selector => (selector === 'button,input,textarea,select' ? [...nodes.values()] : []),
    },
    labels: { stopped: 'Stopped' },
    icon: () => ({}),
    node: () => ({}),
    workflowsUI: { setBusy() {} },
    persistConversation: async () => true,
    historyWrite: Promise.resolve(),
    installFromButton: module.installFromButton,
    api: async (_route, body) =>
      Response.json(body ? { state: 'preparing' } : { state: 'error', error: 'Download failed' }),
    notice: () => {},
    refreshStatus: async () => context.updateControls(),
  };
  runInNewContext(
    controls + '\n' + install + '\nthis.updateControls=updateControls;this.installUpdate=installUpdate;',
    context,
  );
  await context.installUpdate();
  for (const id of ['settings-open', 'settings-close', 'image-input', 'model-path', 'prompt', 'send'])
    assert.equal(!!get(id).disabled, id === 'send', id + ' availability after failure');
  assert.equal(state.updating, false);
  assert.equal(get('update-dialog').open, false);
});
