const format = value => new Intl.NumberFormat('fr-FR').format(value);
export function contextBudget({ used, capacity, precision }) {
  const known = Number.isSafeInteger(used) && used >= 0;
  return {
    used: known ? used : null,
    capacity,
    precision,
    occupied: known ? Math.min(100, (100 * used) / capacity) : 0,
    warning: known && used >= capacity ? 'full' : known && used >= capacity * 0.9 ? 'near' : '',
  };
}

/** The share in use as it is written beside the bar: « 12 % », « < 1 % », « ≈ 40 % » ; nothing when unknown. */
export function contextFigure({ used, occupied, precision }) {
  if (used === null) return '';
  const qualifier = precision === 'text-only' ? '≥ ' : precision === 'estimated' ? '≈ ' : '';
  return qualifier + (used > 0 && occupied < 1 ? '< 1' : String(Math.round(occupied))) + ' %';
}

export function setupContextMeter({
  $,
  api,
  getRequest,
  getConversation = () => undefined,
  getConfig,
  isReady,
  isBusy,
  delay = 800,
}) {
  let timer,
    controller,
    revision = 0,
    conversation = getConversation(),
    last = {};
  const box = $('context-meter'),
    figure = $('context-figure');
  function render(result = last) {
    last = result;
    const { contextSize: capacity = 8192 } = getConfig(),
      budget = contextBudget({ ...result, capacity });
    const qualifier = budget.precision === 'text-only' ? '≥ ' : budget.precision === 'estimated' ? '≈ ' : '';
    const percent = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(budget.occupied);
    const usage =
      budget.used === null
        ? 'Contexte utilisé : comptage indisponible.'
        : 'Contexte utilisé : ' +
          qualifier +
          format(budget.used) +
          ' / ' +
          format(capacity) +
          ' tokens (' +
          qualifier +
          percent +
          ' %).';
    const detail =
      budget.used === null
        ? 'Le comptage nécessite un moteur prêt et compatible.'
        : budget.precision === 'text-only'
          ? 'Texte compté ; le coût des images est inconnu et s’ajoute à cette valeur.'
          : budget.precision === 'estimated'
            ? 'Estimation avec le template et le tokenizer du moteur.'
            : 'Messages envoyés et réponses, avec les consignes et outils inclus dans cette conversation.';
    const warning =
      budget.warning === 'full' ? 'Contexte saturé.' : budget.warning === 'near' ? 'Contexte presque rempli.' : '';
    box.title = [usage, detail, warning].filter(Boolean).join('\n');
    box.style.setProperty('--context-used', budget.occupied + '%');
    if (figure) figure.textContent = contextFigure(budget);
    box.dataset.warning = budget.warning;
    box.setAttribute('aria-valuemax', String(capacity));
    box.setAttribute('aria-valuetext', box.title);
    if (budget.used === null) box.removeAttribute('aria-valuenow');
    else box.setAttribute('aria-valuenow', String(Math.min(capacity, budget.used)));
  }
  function pause() {
    revision++;
    clearTimeout(timer);
    controller?.abort();
  }
  function schedule() {
    pause();
    const current = revision;
    if (isBusy()) return;
    const selected = getConversation();
    if (selected !== conversation) {
      conversation = selected;
      last = {};
    }
    const request = getRequest();
    if (!request) {
      render({ used: 0, precision: 'exact' });
      return;
    }
    render();
    if (!isReady()) return;
    timer = setTimeout(async () => {
      controller = new AbortController();
      try {
        const result = await (await api('context', request, { signal: controller.signal })).json();
        if (current === revision && !isBusy()) render(result);
      } catch {
        if (current === revision) render({});
      }
    }, delay);
  }
  function observe(event) {
    const usage = event.usage;
    if (
      !usage ||
      !Number.isSafeInteger(usage.prompt_tokens) ||
      usage.prompt_tokens < 0 ||
      !Number.isSafeInteger(usage.completion_tokens) ||
      usage.completion_tokens < 0
    )
      return;
    conversation = getConversation();
    render({ used: usage.prompt_tokens + usage.completion_tokens, precision: 'exact' });
  }
  render(getRequest() ? {} : { used: 0, precision: 'exact' });
  return { schedule, pause, observe };
}
