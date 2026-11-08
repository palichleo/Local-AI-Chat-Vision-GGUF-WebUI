import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function pickerUI() {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', hidden: true, disabled: false, open: false, listeners: {},
      addEventListener(name, fn) { this.listeners[name] = fn; },
      close() { this.open = false; this.listeners.close?.(); }, showModal() { this.open = true; } });
    return nodes.get(id);
  };
  const buttons = ['engine','model','projector'].map(kind => ({ dataset: { fileKind: kind }, disabled: false }));
  const requests = [];
  const state = { operation: false, config: { modelPath: 'saved.gguf' }, status: {} };
  const context = { $, state, settingsGuard:{markSaved(){}}, applyModelLibrary(){}, AbortController, tokenControls: { setValues() {} }, comfyUI: { refresh: async () => {}, cancelSettings() {} }, computeControls: { setValues() {} }, notice() {}, updateControls() {},
    document: { querySelectorAll: () => buttons },
    api: (_route, _body, options) => _route === 'models' ? Promise.resolve(Response.json({models:[],detected:[],errors:[]})) : _route === 'bootstrap' ? Promise.resolve(Response.json({config:state.config})) : new Promise((resolve, reject) => requests.push({ resolve: path => resolve(Response.json({ path })), reject, signal: options?.signal })),
  };
  const open = source.slice(source.indexOf('function openSettings()'), source.indexOf('async function saveConfiguration()'));
  const start = source.includes('let filePickerController = null;') ? source.indexOf('let filePickerController = null;') : source.indexOf('for(const button of document.querySelectorAll(\'[data-file-kind]\'))');
  const handlers = source.slice(start, source.indexOf("$('settings-open').onclick"));
  runInNewContext(open + '\n' + handlers + '\nthis.openSettings=openSettings;', context);
  context.openSettings(); await new Promise(setImmediate);
  return { $, state, context, buttons, requests };
}

test('closing settings cancels browsing and an old result cannot overwrite reopened settings', async () => {
  const { $, state, context, buttons, requests } = await pickerUI();
  const pending = buttons[1].onclick();
  $('settings').close(); context.openSettings();
  assert.equal(requests[0].signal?.aborted, true);
  requests[0].resolve('old-dialog.gguf'); await pending;
  assert.equal($('model-path').value, 'saved.gguf'); assert.equal(state.operation, false);
});

test('late errors after closing settings stay out of the new dialog', async () => {
  const { $, context, buttons, requests } = await pickerUI();
  const pending = buttons[0].onclick();
  $('settings').close(); context.openSettings();
  requests[0].reject(new Error('old failure')); await pending;
  assert.equal($('config-error').hidden, true);
});

test('cancellation preserves a typed path; successful browse changes only the chosen field', async () => {
  const { $, buttons, requests } = await pickerUI();
  $('model-path').value = 'unsaved.gguf'; $('engine-path').value = 'engine.exe';
  const canceled = buttons[1].onclick(); requests[0].resolve(null); await canceled;
  assert.equal($('model-path').value, 'unsaved.gguf');
  const selected = buttons[2].onclick(); requests[1].resolve('vision.gguf'); await selected;
  assert.equal($('projector-path').value, 'vision.gguf'); assert.equal($('engine-path').value, 'engine.exe');
});

test('opening already visible settings preserves unsaved paths and duplicate browse clicks do nothing', async () => {
  const { $, context, buttons, requests } = await pickerUI();
  $('model-path').value = 'unsaved.gguf'; context.openSettings();
  assert.equal($('model-path').value, 'unsaved.gguf');
  const pending = buttons[1].onclick(); await buttons[0].onclick();
  assert.equal(requests.length, 1); requests[0].resolve(null); await pending;
});

test('a delayed close event from the old dialog cannot cancel a new file selection', async () => {
  const { $, context, buttons, requests } = await pickerUI();
  const dialog = $('settings'); dialog.close = () => { dialog.open = false; };
  const oldSelection = buttons[1].onclick(); dialog.close(); context.openSettings();
  requests[0].resolve(null); await oldSelection;
  const newSelection = buttons[0].onclick();
  dialog.listeners.close();
  assert.equal(requests[1].signal.aborted, false);
  requests[1].resolve('new-engine.exe'); await newSelection;
  assert.equal($('engine-path').value, 'new-engine.exe');
});
