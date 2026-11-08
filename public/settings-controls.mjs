export const CONTEXT_SIZES = Object.freeze([4096, 8192, 16384, 32768, 65536, 131072, 262144]);
export const OUTPUT_LIMITS = Object.freeze([1024, 2048, 4096, 8192, 16384, 32768]);
const format = value => `${new Intl.NumberFormat('fr-FR').format(value)} tokens`;

export function setupTokenControls($) {
  const context = $('context-size'), output = $('output-tokens');
  let contexts = [...CONTEXT_SIZES], outputs = [...OUTPUT_LIMITS];
  function value(control, choices) { return choices[Number(control.value)] ?? choices[0]; }
  function display(control, text, tokens) {
    $(text).textContent = format(tokens);
    control.setAttribute('aria-valuetext', format(tokens));
    const span = Number(control.max) - Number(control.min);
    control.style.setProperty('--range-progress', `${span ? 100 * Number(control.value) / span : 0}%`);
  }
  function sync() {
    const size = value(context, contexts), wanted = value(output, outputs);
    const available = outputs.filter(tokens => tokens <= size);
    const selected = available.filter(tokens => tokens <= wanted).at(-1) ?? available[0];
    output.max = String(available.length - 1);
    output.value = String(outputs.indexOf(selected));
    display(context, 'context-value', size);
    display(output, 'output-value', selected);
    $('context-min').textContent = new Intl.NumberFormat('fr-FR').format(contexts[0]);
    $('context-max').textContent = new Intl.NumberFormat('fr-FR').format(contexts.at(-1));
    $('output-min').textContent = new Intl.NumberFormat('fr-FR').format(available[0]);
    $('output-max').textContent = new Intl.NumberFormat('fr-FR').format(available.at(-1));
  }
  function setValues({ contextSize = 8192, maxOutputTokens = 4096 } = {}) {
    if (!Number.isInteger(contextSize) || contextSize < 1024 || contextSize > 262144 || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 128 || maxOutputTokens > Math.min(contextSize, 32768)) throw new Error('Limites de tokens invalides.');
    contexts = [...new Set([...CONTEXT_SIZES, contextSize])].sort((a,b) => a-b);
    outputs = [...new Set([...OUTPUT_LIMITS, maxOutputTokens])].sort((a,b) => a-b);
    for (const [control, choices, tokens] of [[context,contexts,contextSize],[output,outputs,maxOutputTokens]]) {
      control.min = '0'; control.max = String(choices.length-1); control.step = '1'; control.value = String(choices.indexOf(tokens));
    }
    sync();
  }
  context.oninput = sync; output.oninput = sync;
  setValues();
  return { setValues, values: () => ({contextSize:value(context,contexts),maxOutputTokens:value(output,outputs)}) };
}

export function setupComputeControls($) {
  const mode = $('compute-mode'), layers = $('gpu-layers');
  function sync() {
    const custom = mode.value === 'custom';
    $('custom-layers-field').hidden = !custom;
    layers.disabled = !custom;
    layers.required = custom;
  }
  function values() {
    const text = mode.value === 'custom' ? layers.value.trim() : mode.value;
    const gpuLayers = Number(text);
    if (!text || !Number.isInteger(gpuLayers) || gpuLayers < 0 || gpuLayers > 999) throw new Error('Le nombre de couches GPU doit être compris entre 0 et 999.');
    return { gpuLayers };
  }
  function setValues({ gpuLayers = 999 } = {}) {
    mode.value = [0, 999].includes(gpuLayers) ? String(gpuLayers) : 'custom';
    layers.value = String(gpuLayers);
    sync();
  }
  mode.onchange = sync;
  setValues();
  return { setValues, values };
}

export function dismissSettingsOnOutsideClick(dialog) {
  let startedOutside = false;
  const outside = event => {
    const bounds = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom);
  };
  dialog.addEventListener('pointerdown', event => { startedOutside = outside(event); });
  dialog.addEventListener('pointercancel', () => { startedOutside = false; });
  dialog.addEventListener('click', event => { if (startedOutside && outside(event)) dialog.close(); startedOutside = false; });
  dialog.addEventListener('close', () => { startedOutside = false; });
}
