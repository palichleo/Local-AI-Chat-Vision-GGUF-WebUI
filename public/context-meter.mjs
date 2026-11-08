const format = value => new Intl.NumberFormat('fr-FR').format(value);
export function contextBudget({ used, capacity, reserved, precision }) {
  const known = Number.isSafeInteger(used) && used >= 0;
  const total = (known ? used : 0) + reserved;
  return { used: known ? used : null, capacity, reserved, precision,
    occupied: known ? Math.min(100, 100 * used / capacity) : 0,
    reservation: Math.min(100, 100 * Math.min(reserved, Math.max(0, capacity - (known ? used : 0))) / capacity),
    warning: known && total >= capacity ? 'full' : known && total >= capacity * .9 ? 'near' : '' };
}

export function setupContextMeter({ $, api, getRequest, getConfig, isReady, isBusy, delay = 800 }) {
  let timer, controller, revision = 0;
  const box = $('context-meter'), label = $('context-label'), warning = $('context-warning');
  function render(result = {}) {
    const { contextSize: capacity = 8192, maxOutputTokens: reserved = 4096 } = getConfig();
    const budget = contextBudget({ capacity, reserved, ...result });
    const qualifier = budget.precision === 'text-only' ? '≥ ' : budget.precision === 'estimated' ? '≈ ' : '';
    label.textContent = `Contexte ${budget.used === null ? '—' : qualifier + format(budget.used)} / ${format(capacity)} · Réponse ${format(budget.reserved)}`;
    box.style.setProperty('--context-used', `${budget.occupied}%`);
    box.style.setProperty('--context-reserved', `${budget.reservation}%`);
    box.dataset.warning = budget.warning;
    box.title = budget.precision === 'text-only' ? 'Texte compté avec le moteur. Le coût des images est inconnu et s’ajoute à cette valeur.'
      : budget.precision === 'estimated' ? 'Estimation du texte avec le template et le tokenizer du moteur. La réponse inclut la réflexion.'
      : budget.used === null ? 'Comptage disponible lorsque le moteur est prêt et compatible. Le plafond de réponse inclut la réflexion.'
      : 'Conversation, instructions, outils et brouillon comptés par le moteur. Le plafond de réponse inclut la réflexion.';
    warning.textContent = budget.warning === 'full' ? 'Contexte presque rempli : la réponse pourrait être écourtée.'
      : budget.warning === 'near' ? 'Peu de place restante dans le contexte.'
      : budget.precision === 'text-only' ? 'Coût des images non compté.' : '';
    warning.hidden = !warning.textContent;
  }
  function pause() { revision++; clearTimeout(timer); controller?.abort(); }
  function schedule() {
    pause(); const current = revision;
    if (isBusy()) return;
    render();
    if (!isReady()) return;
    timer = setTimeout(async () => {
      controller = new AbortController();
      try {
        const result = await (await api('context', getRequest(), { signal: controller.signal })).json();
        if (current === revision && !isBusy()) render(result);
      } catch { if (current === revision) render(); }
    }, delay);
  }
  function observe(event) {
    const usage = event.usage;
    if (!usage || !Number.isSafeInteger(usage.prompt_tokens) || usage.prompt_tokens < 0 || !Number.isSafeInteger(usage.completion_tokens) || usage.completion_tokens < 0) return;
    render({ used: usage.prompt_tokens + usage.completion_tokens, reserved: Math.max(0, getConfig().maxOutputTokens - usage.completion_tokens), precision: 'exact' });
  }
  render();
  return { schedule, pause, observe };
}
