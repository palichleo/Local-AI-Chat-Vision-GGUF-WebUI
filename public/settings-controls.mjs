export const CONTEXT_SIZES = Object.freeze([4096, 8192, 16384, 32768, 65536, 131072, 262144]);
export const OUTPUT_LIMITS = Object.freeze([1024, 2048, 4096, 8192, 16384, 32768]);
const format = value => `${new Intl.NumberFormat('fr-FR').format(value)} tokens`;
// One scale for both (parametres-maquette.md, captures 41 and 42): 1 K · 2 K · … · 256 K, a column
// of 50 px each; the round handle of 14 px.
const COLUMN = 50,
  THUMB = 14;
const columnOf = tokens => Math.log2(tokens / 1024);
const short = tokens => {
  const thousands = tokens / 1024;
  return (Number.isInteger(thousands) ? String(thousands) : thousands.toFixed(1).replace('.', ',')) + '\u202fK';
};

/**
 * The notches of a control on the scale: its rail (in the accent up to the value), a notch of 6 px
 * and its label for each choice, the value's label lit. `usable`: the choices that can be taken (the
 * output never goes past the context): those after are hollow, their rail dotted, their labels faded.
 * The range of the page lies over the notches it takes, its steps on theirs.
 */
function drawScale(control, marks, choices, { selected, usable = choices.length }) {
  const first = columnOf(choices[0]),
    step = choices.length > 1 ? ((columnOf(choices.at(-1)) - first) * COLUMN) / (choices.length - 1) : 0,
    start = first * COLUMN + COLUMN / 2,
    at = index => start + index * step;
  control.style.setProperty('--notch-left', start - THUMB / 2 + 'px');
  control.style.setProperty('--notch-width', Math.max(0, usable - 1) * step + THUMB + 'px');
  const page = marks?.ownerDocument;
  if (!page?.createElement) return;
  const make = (className, style = {}, text = '') => {
    const element = page.createElement('span');
    element.className = className;
    element.textContent = text;
    Object.assign(element.style, style);
    return element;
  };
  const parts = [
    make('notch-rail', { left: at(0) + 'px', width: Math.max(0, usable - 1) * step + 'px' }),
    make('notch-rail is-lit', { left: at(0) + 'px', width: selected * step + 'px' }),
  ];
  if (usable < choices.length)
    parts.push(make('notch-rail is-over', { left: at(usable - 1) + 'px', width: (choices.length - usable) * step + 'px' }));
  choices.forEach((tokens, index) => {
    const over = index >= usable,
      state = (index <= selected ? ' is-lit' : '') + (over ? ' is-over' : ''),
      notch = make('notch' + state, { left: at(index) + 'px' }),
      label = make('notch-label' + (index === selected ? ' is-chosen' : '') + (over ? ' is-over' : ''), {
        left: at(index) + 'px',
      }, short(tokens));
    // Past the context: said under the pointer, and not taken.
    if (over) notch.title = label.title = 'Pas plus que le contexte total';
    parts.push(notch, label);
  });
  marks.replaceChildren(...parts);
}

export function setupTokenControls($) {
  const context = $('context-size'),
    output = $('output-tokens');
  let contexts = [...CONTEXT_SIZES],
    outputs = [...OUTPUT_LIMITS];
  function value(control, choices) {
    return choices[Number(control.value)] ?? choices[0];
  }
  function display(control, text, tokens) {
    $(text).textContent = format(tokens);
    control.setAttribute('aria-valuetext', format(tokens));
    const span = Number(control.max) - Number(control.min);
    control.style.setProperty('--range-progress', `${span ? (100 * Number(control.value)) / span : 0}%`);
  }
  function sync() {
    const size = value(context, contexts),
      wanted = value(output, outputs);
    const available = outputs.filter(tokens => tokens <= size);
    const selected = available.filter(tokens => tokens <= wanted).at(-1) ?? available[0];
    output.max = String(available.length - 1);
    output.value = String(outputs.indexOf(selected));
    display(context, 'context-value', size);
    display(output, 'output-value', selected);
    drawScale(context, $('context-marks'), contexts, { selected: contexts.indexOf(size) });
    drawScale(output, $('output-marks'), outputs, { selected: outputs.indexOf(selected), usable: available.length });
  }
  function setValues({ contextSize = 8192, maxOutputTokens = 4096 } = {}) {
    if (
      !Number.isInteger(contextSize) ||
      contextSize < 1024 ||
      contextSize > 262144 ||
      !Number.isInteger(maxOutputTokens) ||
      maxOutputTokens < 128 ||
      maxOutputTokens > Math.min(contextSize, 32768)
    )
      throw new Error('Limites de tokens invalides.');
    contexts = [...new Set([...CONTEXT_SIZES, contextSize])].sort((a, b) => a - b);
    outputs = [...new Set([...OUTPUT_LIMITS, maxOutputTokens])].sort((a, b) => a - b);
    for (const [control, choices, tokens] of [
      [context, contexts, contextSize],
      [output, outputs, maxOutputTokens],
    ]) {
      control.min = '0';
      control.max = String(choices.length - 1);
      control.step = '1';
      control.value = String(choices.indexOf(tokens));
    }
    sync();
  }
  context.oninput = sync;
  output.oninput = sync;
  setValues();
  return {
    setValues,
    values: () => ({ contextSize: value(context, contexts), maxOutputTokens: value(output, outputs) }),
  };
}

export function setupComputeControls($) {
  const mode = $('compute-mode'),
    layers = $('gpu-layers'),
    // The choices of the select as a small group (capture 41), the select keeping the value.
    group = $('compute-segments'),
    choices = group?.ownerDocument
      ? [...mode.options].map(option => {
          const choice = group.ownerDocument.createElement('button');
          choice.type = 'button';
          choice.className = 'settings-segment';
          choice.textContent = option.textContent;
          choice.dataset.value = option.value;
          choice.setAttribute('role', 'radio');
          if (option.value === 'custom') choice.title = 'GPU · un nombre de couches choisi';
          choice.onclick = () => {
            mode.value = option.value;
            sync();
            if (option.value === 'custom') layers.focus?.();
          };
          return choice;
        })
      : [];
  if (choices.length) group.replaceChildren(...choices);
  function sync() {
    const custom = mode.value === 'custom';
    $('custom-layers-field').hidden = !custom;
    layers.disabled = !custom;
    layers.required = custom;
    for (const choice of choices) choice.setAttribute('aria-checked', String(choice.dataset.value === mode.value));
  }
  function values() {
    const text = mode.value === 'custom' ? layers.value.trim() : mode.value;
    const gpuLayers = Number(text);
    if (!text || !Number.isInteger(gpuLayers) || gpuLayers < 0 || gpuLayers > 999)
      throw new Error('Le nombre de couches GPU doit être compris entre 0 et 999.');
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

/**
 * A window closed by a click beside it: pressed and released outside its box. `empty`: an element
 * of the window that counts as beside it too (a part of its box with nothing in it).
 */
export function dismissSettingsOnOutsideClick(dialog, requestClose = () => dialog.close(), { empty = () => false } = {}) {
  let startedOutside = false;
  const outside = event => {
    const bounds = dialog.getBoundingClientRect();
    return (
      (event.target === dialog &&
        (event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom)) ||
      empty(event.target)
    );
  };
  dialog.addEventListener('pointerdown', event => {
    startedOutside = outside(event);
  });
  dialog.addEventListener('pointercancel', () => {
    startedOutside = false;
  });
  dialog.addEventListener('click', event => {
    if (startedOutside && outside(event)) requestClose();
    startedOutside = false;
  });
  dialog.addEventListener('close', () => {
    startedOutside = false;
  });
}
