import test from 'node:test';
import * as settingsControls from '../public/settings-controls.mjs';
import assert from 'node:assert/strict';
import {
  CONTEXT_SIZES,
  OUTPUT_LIMITS,
  setupTokenControls,
  dismissSettingsOnOutsideClick,
} from '../public/settings-controls.mjs';

function controls() {
  const nodes = new Map(
    [
      'context-size',
      'output-tokens',
      'context-value',
      'output-value',
    ].map(id => [
      id,
      {
        value: '0',
        attributes: {},
        style: { setProperty() {} },
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
      },
    ]),
  );
  const $ = id => nodes.get(id);
  return { $, ui: setupTokenControls($) };
}
test('range steps preserve every previous context and output choice', () => {
  const { $, ui } = controls();
  assert.deepEqual(ui.values(), { contextSize: 8192, maxOutputTokens: 4096 });
  for (const [index, tokens] of CONTEXT_SIZES.entries()) {
    $('context-size').value = String(index);
    $('context-size').oninput();
    assert.equal(ui.values().contextSize, tokens);
    assert.ok(ui.values().maxOutputTokens <= tokens);
  }
  for (const [index, tokens] of OUTPUT_LIMITS.entries()) {
    $('output-tokens').value = String(index);
    $('output-tokens').oninput();
    assert.equal(ui.values().maxOutputTokens, tokens);
    assert.equal($('output-tokens').attributes['aria-valuetext'].replace(/\s/g, ''), `${tokens}tokens`);
  }
});
test('reducing context clamps the output without sending range indices as token counts', () => {
  const { $, ui } = controls();
  ui.setValues({ contextSize: 262144, maxOutputTokens: 32768 });
  $('context-size').value = '0';
  $('context-size').oninput();
  assert.deepEqual(ui.values(), { contextSize: 4096, maxOutputTokens: 4096 });
  assert.equal($('output-tokens').max, '2');
});
test('valid saved custom sizes remain selectable and invalid limits are rejected', () => {
  const { ui } = controls();
  for (const limits of [
    { contextSize: 6144, maxOutputTokens: 6000 },
    { contextSize: 1024, maxOutputTokens: 128 },
  ]) {
    ui.setValues(limits);
    assert.deepEqual(ui.values(), limits);
  }
  assert.throws(() => ui.setValues({ contextSize: 4096, maxOutputTokens: 8192 }));
});
test('settings close on a backdrop click and stay open after inside clicks or slider drags', () => {
  const listeners = {};
  let closed = 0;
  const dialog = {
    addEventListener(name, fn) {
      listeners[name] = fn;
    },
    getBoundingClientRect: () => ({ left: 100, right: 600, top: 80, bottom: 700 }),
    close: () => {
      closed++;
    },
  };
  dismissSettingsOnOutsideClick(dialog);
  const event = (x, y, target = dialog) => ({ clientX: x, clientY: y, target });
  listeners.pointerdown(event(200, 100, {}));
  listeners.click(event(200, 100, {}));
  assert.equal(closed, 0);
  listeners.pointerdown(event(200, 100, {}));
  listeners.click(event(20, 10));
  assert.equal(closed, 0);
  listeners.pointerdown(event(20, 10));
  listeners.click(event(20, 10));
  assert.equal(closed, 1);
  listeners.pointerdown(event(20, 10));
  listeners.pointercancel();
  listeners.click(event(20, 10));
  assert.equal(closed, 1);
});
test('a take opened closes on a click in the empty margins of its window, not on the take, its panel or its arrows', () => {
  const listeners = {};
  let closed = 0;
  const dialog = {
      addEventListener(name, fn) {
        listeners[name] = fn;
      },
      // The window of 1180 px around a narrow take (9:16) and its panel.
      getBoundingClientRect: () => ({ left: 115, right: 1295, top: 60, bottom: 830 }),
      close: () => closed++,
    },
    layout = { classList: { contains: name => name === 'media-details-layout' } },
    inside = { classList: { contains: () => false } };
  dismissSettingsOnOutsideClick(dialog, undefined, {
    empty: target => target === dialog || target?.classList?.contains('media-details-layout'),
  });
  const press = (x, y, target) => {
    listeners.pointerdown({ clientX: x, clientY: y, target });
    listeners.click({ clientX: x, clientY: y, target });
  };
  // The take, its panel, an arrow: it stays.
  press(500, 400, inside);
  assert.equal(closed, 0);
  // Its margins: the padding of the window (the window itself) and the grid around the take.
  press(160, 400, dialog);
  assert.equal(closed, 1);
  press(260, 400, layout);
  assert.equal(closed, 2);
  // Pressed on the take and released in a margin (a selection, a drag): it stays.
  listeners.pointerdown({ clientX: 500, clientY: 400, target: inside });
  listeners.click({ clientX: 260, clientY: 400, target: layout });
  assert.equal(closed, 2);
  // Outside its box, as before.
  press(20, 10, dialog);
  assert.equal(closed, 3);
});

function computeControls() {
  const nodes = new Map([
    ['compute-mode', { value: '999' }],
    ['gpu-layers', { value: '20', disabled: true, required: false }],
    ['custom-layers-field', { hidden: true }],
  ]);
  const $ = id => nodes.get(id);
  return { $, ui: settingsControls.setupComputeControls($) };
}

test('GPU all sends the supported maximum and preserves saved custom layer counts', () => {
  const { $, ui } = computeControls();
  assert.deepEqual(ui.values(), { gpuLayers: 999 });
  for (const layers of [20, 99, 998]) {
    ui.setValues({ gpuLayers: layers });
    assert.equal($('compute-mode').value, 'custom');
    assert.equal($('gpu-layers').value, String(layers));
    assert.deepEqual(ui.values(), { gpuLayers: layers });
  }
  ui.setValues({ gpuLayers: 0 });
  assert.equal($('compute-mode').value, '0');
  assert.deepEqual(ui.values(), { gpuLayers: 0 });
});

test('irrelevant GPU input is disabled and custom input becomes required on every mode change', () => {
  const { $, ui } = computeControls();
  for (const mode of ['custom', '0', 'custom', '999']) {
    $('gpu-layers').value = '1000';
    $('compute-mode').value = mode;
    $('compute-mode').onchange();
    assert.equal($('gpu-layers').disabled, mode !== 'custom');
    assert.equal($('gpu-layers').required, mode === 'custom');
    assert.equal($('custom-layers-field').hidden, mode !== 'custom');
    if (mode !== 'custom') assert.deepEqual(ui.values(), { gpuLayers: Number(mode) });
  }
});

test('empty and invalid custom GPU counts cannot silently become CPU mode', () => {
  const { $, ui } = computeControls();
  $('compute-mode').value = 'custom';
  $('compute-mode').onchange();
  for (const invalid of ['', ' ', '-1', '1.5', '1000', 'no']) {
    $('gpu-layers').value = invalid;
    assert.throws(() => ui.values(), /couches GPU/);
  }
  for (const layers of ['0', '1', '999']) {
    $('gpu-layers').value = layers;
    assert.deepEqual(ui.values(), { gpuLayers: Number(layers) });
  }
});

test('legacy minimum token counts survive a context reduction and later increase', () => {
  const { $, ui } = controls();
  ui.setValues({ contextSize: 1024, maxOutputTokens: 128 });
  $('context-size').value = '7';
  $('context-size').oninput();
  assert.deepEqual(ui.values(), { contextSize: 262144, maxOutputTokens: 128 });
  $('output-tokens').value = '6';
  $('output-tokens').oninput();
  assert.deepEqual(ui.values(), { contextSize: 262144, maxOutputTokens: 32768 });
  $('context-size').value = '0';
  $('context-size').oninput();
  assert.deepEqual(ui.values(), { contextSize: 1024, maxOutputTokens: 1024 });
  assert.equal($('output-tokens').max, '1');
  $('context-size').value = '7';
  $('context-size').oninput();
  assert.deepEqual(ui.values(), { contextSize: 262144, maxOutputTokens: 1024 });
  assert.equal($('output-tokens').max, '6');
});
