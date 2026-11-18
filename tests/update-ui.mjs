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
          throw Object.assign(new Error('Attendez la fin de l’opération en cours avant la mise à jour.'), {
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
  // What the session of an update keeps of the page (0.6.103: with its revision, and the conversation set aside).
  const session = source.slice(source.indexOf('function sessionOfPage('), source.indexOf('let historyWrite'));
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id))
      nodes.set(id, {
        disabled: false,
        value: '',
        textContent: '',
        open: false,
        hidden: false,
        children: [],
        dataset: {},
        classList: { toggle() {}, contains: () => false },
        setAttribute() {},
        replaceChildren() {},
        append() {},
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
      // The room reads on the root whether a generation runs (0.6.0).
      documentElement: { dataset: {} },
      querySelectorAll: selector => (selector === 'button,input,textarea,select' ? [...nodes.values()] : []),
    },
    labels: { stopped: 'Stopped' },
    icon: () => ({}),
    node: () => ({}),
    moodixMark: () => [],
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
    controls + '\n' + session + '\n' + install + '\nthis.updateControls=updateControls;this.installUpdate=installUpdate;',
    context,
  );
  await context.installUpdate();
  for (const id of ['settings-open', 'settings-close', 'image-input', 'model-path', 'prompt', 'send'])
    assert.equal(!!get(id).disabled, id === 'send', id + ' availability after failure');
  assert.equal(state.updating, false);
  // The failure stays in the panel, with « Réessayer » (etats-maquette.md, 56); closing it, the
  // page is as it was.
  assert.equal(get('update-dialog').open, true);
  assert.equal(get('update-failure').hidden, false);
  assert.equal(get('update-failure-text').textContent, 'Download failed');
  // « Envoyer » greyed by its empty box only: what « Régénérer » reads first is not held (0.6.90).
  assert.equal(state.sendHeld, false);
  get('prompt').value = 'Un renard';
  state.connected = false;
  context.updateControls();
  assert.deepEqual([state.sendHeld, get('send').disabled], [true, true], 'the server away: held, whatever the message');
  state.connected = true;
  context.updateControls();
  assert.deepEqual([state.sendHeld, get('send').disabled], [false, false]);
});

test('what an update or « Redémarrer » keeps of the page: the revision read, and without the history the conversation set aside (0.6.103)', async () => {
  const { readFile } = await import('node:fs/promises');
  const { runInNewContext } = await import('node:vm');
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const fields = { prompt: { value: 'un brouillon' }, 'conversation-title': { textContent: 'Un chat roux' } };
  const aside = {
    conversationId: 'b2222222-2222-4222-8222-222222222222',
    projectId: 'inbox',
    messages: [{ role: 'user', content: 'Un renard' }],
    archiveSnapshot: null,
    conversationInstructions: '',
    title: 'Un renard',
    draft: { text: 'et un loup', images: [], videos: [] },
  };
  const state = {
    saveHistory: false,
    conversationId: 'a1111111-1111-4111-8111-111111111111',
    messages: [{ role: 'user', content: 'Un chat roux' }],
    archiveSnapshot: null,
    images: [],
    thinking: true,
    revisions: new Map([['a1111111-1111-4111-8111-111111111111', 3]]),
    aside,
  };
  const context = { state, $: id => fields[id], compactSession: module.compactSession };
  runInNewContext(source.slice(source.indexOf('function sessionOfPage('), source.indexOf('let historyWrite')) + ';this.sessionOfPage=sessionOfPage;', context);
  const kept = context.sessionOfPage();
  assert.equal(kept.revision, 3);
  assert.deepEqual([kept.aside.conversationId, kept.aside.prompt, kept.aside.title], [aside.conversationId, 'et un loup', 'Un renard']);
  // With the history, the one set aside is on the disk: not kept twice.
  state.saveHistory = true;
  assert.equal(context.sessionOfPage().aside, undefined);
});
