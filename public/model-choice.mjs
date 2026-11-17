import { closePopup, openPopup } from './glass-menu.mjs';

/**
 * The model and its reflection, chosen in the bar of the chat: two compact buttons beside
 * « Joindre » (17/11; one button until then), each with its menu of glass.
 * - « Modèle »: with a remote model, its models (a filter when they are many), kept as the last
 *   choice by the server (POST /api/remote/choice); with the local model, its name. At the foot,
 *   « Changer de service… » or « Changer de modèle… » opens Paramètres › Moodix AI: nothing is
 *   started or stopped from the bar.
 * - « Réflexion »: the efforts the remote model takes (Faible, Moyenne, Élevée…), or with the local
 *   model, with or without. Greyed, with why, when the model has none to choose or the service
 *   refuses the one chosen.
 * Each says what goes with the next message as soon as the page opens; one menu opens at a time,
 * a choice closes it.
 */
export const EFFORT_NAMES = Object.freeze({
  none: 'Aucune',
  minimal: 'Minimale',
  low: 'Faible',
  medium: 'Moyenne',
  high: 'Élevée',
  xhigh: 'Très élevée',
  max: 'Maximale',
});
// What the button of the reflection says of an effort.
const EFFORT_WORDS = Object.freeze({
  none: 'Aucune réflexion',
  minimal: 'Réflexion minimale',
  low: 'Réflexion faible',
  medium: 'Réflexion moyenne',
  high: 'Réflexion élevée',
  xhigh: 'Réflexion très élevée',
  max: 'Réflexion maximale',
});
const FILTER_FROM = 12;
// The models shown at once in the menu; the filter finds the others.
export const SHOWN = 200;

/** What the button of the model says: the remote model by its name in the listing, or the local one. */
export function modelLabel(status, options, localName = '') {
  if (!status?.remote) return localName || 'Aucun LLM';
  return options?.models?.find(item => item.id === status.remote.model)?.name ?? status.remote.model ?? '';
}
/**
 * The reflection that goes with the next message, `{ label, off, why }`: the effort kept for the
 * connection (the one sent), or with or without for the local model. `off`: none goes (the local
 * model without, « Aucune », a model with nothing to choose, a service that refuses it); `why`, then.
 */
export function effortState(status, options, thinking) {
  if (!status?.remote) return { label: thinking ? 'Réflexion' : 'Sans réflexion', off: !thinking, why: '' };
  if (options?.ignored)
    return { label: 'Réflexion', off: true, why: 'Ce service refuse la force choisie : elle n’est pas envoyée avec ce modèle.' };
  // The effort kept goes with the message (the server sends it whatever the listing says): said.
  const effort = status.remote.effort;
  if (effort && EFFORT_WORDS[effort]) return { label: EFFORT_WORDS[effort], off: effort === 'none', why: '' };
  // None kept, and the model lists none: it reflects as it does, nothing to choose.
  if (options && !options.error && !(options.efforts ?? []).length)
    return { label: 'Réflexion', off: true, why: 'Ce modèle ne propose pas de réglage de la réflexion.' };
  // None chosen yet: none is sent, the service reflects as it does by default.
  return { label: 'Réflexion', off: false, why: 'Aucune force choisie : le service décide.' };
}

export function setupModelChoice({
  $,
  api,
  node,
  getStatus,
  getThinking,
  setThinking,
  getLocalName = () => '',
  openModels = null,
  onStatus = () => {},
  notice = () => {},
  view = globalThis,
}) {
  const page = $('model-choice').ownerDocument;
  let options = null,
    // The connection the options are of: asked again when another is chosen.
    of = null,
    loading = null,
    filter = '',
    working = false;

  /** One button and its menu: opened, closed, placed, gone through by the keyboard. */
  function popup(prefix, drawMenu) {
    const button = $(prefix),
      text = $(prefix + '-text'),
      menu = $(prefix + '-menu');
    // Focusable itself: a key pressed while nothing in it can be (the models being read) reaches it.
    menu.tabIndex = -1;
    // The menu never narrower than it was since it opened (a filter would make it jump).
    let widest = 0;
    const self = { button, text, menu, open, close, draw };
    const beside = event => {
      if (!menu.contains(event.target) && !button.contains(event.target)) close();
    };
    // Échap closes it wherever the focus is (a list being read, a choice just made).
    const keys = event => {
      if (event.key !== 'Escape' || menu.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      close({ refocus: true });
    };
    function close({ refocus = false } = {}) {
      if (menu.hidden) return;
      closePopup(menu);
      menu.replaceChildren();
      button.setAttribute('aria-expanded', 'false');
      page.removeEventListener('pointerdown', beside, true);
      page.removeEventListener('keydown', keys, true);
      widest = 0;
      render();
      if (refocus) button.focus();
    }
    /** Placed against its button, as tall as the room on the side it opens, never narrower than it was. */
    function place() {
      const box = button.getBoundingClientRect?.();
      if (box) {
        const room = Math.max(box.top, (view.innerHeight ?? 800) - box.bottom) - 24;
        menu.style.maxHeight = Math.round(Math.max(160, Math.min(560, room))) + 'px';
      }
      menu.style.minWidth = '';
      widest = Math.max(widest, Math.round(menu.getBoundingClientRect?.().width ?? 0), 220);
      menu.style.minWidth = widest + 'px';
      openPopup(menu, button, { view, align: 'start' });
    }
    function draw() {
      menu.replaceChildren(...drawMenu(self));
      // Placed again after each drawing: a list read, a filter typed change its size.
      if (!menu.hidden) place();
    }
    const first = () =>
      menu.querySelector('.glass-menu-filter') ?? menu.querySelector('.is-chosen') ?? menu.querySelector('button') ?? menu;
    async function open() {
      if (!menu.hidden || button.disabled) return;
      // One menu at a time.
      for (const other of popups) if (other !== self) other.close();
      filter = '';
      widest = 0;
      menu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      delete button.dataset.tip;
      page.addEventListener('pointerdown', beside, true);
      page.addEventListener('keydown', keys, true);
      draw();
      first().focus?.();
      if (getStatus()?.remote) {
        await refresh();
        if (menu.hidden) return;
        first().focus?.();
      }
    }
    button.onclick = () => (menu.hidden ? void open() : close());
    menu.addEventListener('keydown', event => {
      const list = [...menu.querySelectorAll('button:not(:disabled)')],
        at = list.indexOf(page.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!list.length) return;
        // From the filter (or the menu itself), ↓ goes to the first, ↑ to the last.
        if (at < 0) return void (event.key === 'ArrowDown' ? list[0] : list.at(-1)).focus();
        list[(at + (event.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length].focus();
      } else if (event.key === 'Tab') close();
    });
    return self;
  }

  function item(label, chosen, onclick, { note = '', key = '' } = {}) {
    const element = node('button', 'glass-menu-item' + (chosen ? ' is-chosen' : ''), label);
    element.type = 'button';
    element.setAttribute('role', 'menuitemradio');
    element.setAttribute('aria-checked', String(chosen));
    element.dataset.key = key;
    if (note) element.append(node('span', 'glass-menu-note', note));
    element.disabled = working;
    element.onclick = onclick;
    return element;
  }
  /** « Changer de service… », « Changer de modèle… »: Paramètres › Moodix AI. */
  function elsewhere(label, self) {
    const element = node('button', 'glass-menu-item glass-menu-action', label);
    element.type = 'button';
    element.setAttribute('role', 'menuitem');
    element.dataset.key = 'settings';
    element.onclick = () => {
      self.close();
      openModels();
    };
    return element;
  }
  /** A remote choice: kept by the server, then its menu closed and its button says it. */
  async function choose(change, self) {
    if (working) return;
    working = true;
    self.draw();
    let done = false;
    try {
      const result = await (await api('remote/choice', change)).json();
      options = result.options;
      onStatus(result.status);
      done = true;
    } catch (error) {
      notice(error.message);
    } finally {
      working = false;
      render();
      if (!self.menu.hidden) {
        // Kept: the menu closes. Refused: it stays, said, the focus on the one chosen.
        if (done) self.close({ refocus: true });
        else {
          self.draw();
          (self.menu.querySelector('.is-chosen') ?? self.menu)?.focus?.();
        }
      }
    }
  }

  const models = popup('model-choice', self => {
    const status = getStatus(),
      parts = [node('p', 'glass-menu-title', 'Modèle')];
    if (!status?.remote) {
      // The local model: its name; another one is chosen in the settings (the engine starts again).
      parts.push(item(modelLabel(status, null, getLocalName()), true, () => self.close({ refocus: true }), { key: 'local' }));
      if (openModels) parts.push(node('hr', 'glass-menu-rule'), elsewhere('Changer de modèle…', self));
      return parts;
    }
    const list = options?.models ?? [];
    if (list.length > FILTER_FROM) {
      const field = node('input', 'glass-menu-filter');
      field.type = 'search';
      field.placeholder = 'Chercher un modèle…';
      field.value = filter;
      field.setAttribute('aria-label', 'Chercher un modèle');
      field.addEventListener('input', () => {
        filter = field.value;
        self.draw();
        const again = self.menu.querySelector('.glass-menu-filter');
        again?.focus();
        again?.setSelectionRange?.(filter.length, filter.length);
      });
      parts.push(field);
    }
    const words = filter.trim().toLowerCase();
    const shown = words ? list.filter(model => `${model.name} ${model.id}`.toLowerCase().includes(words)) : list;
    const rows = node('div', 'glass-menu-list');
    rows.append(
      ...shown.slice(0, SHOWN).map(model =>
        item(
          model.name,
          model.id === options?.model,
          () => (model.id === options?.model ? self.close({ refocus: true }) : void choose({ model: model.id }, self)),
          { note: model.id.endsWith(':free') ? 'gratuit' : '', key: `model:${model.id}` },
        ),
      ),
    );
    if (shown.length > SHOWN)
      rows.append(node('p', 'glass-menu-empty', `${SHOWN} modèles montrés sur ${shown.length} : cherchez-en un par son nom.`));
    // Nothing listed: being read, or nothing matches (what stopped a listing is said below).
    if (!shown.length && !options?.error)
      rows.append(node('p', 'glass-menu-empty', options ? 'Aucun modèle trouvé.' : 'Lecture des modèles…'));
    parts.push(rows);
    if (options?.error) parts.push(node('p', 'glass-menu-error', options.error));
    if (openModels) parts.push(node('hr', 'glass-menu-rule'), elsewhere('Changer de service…', self));
    return parts;
  });

  const efforts = popup('effort-choice', self => {
    const status = getStatus(),
      parts = [node('p', 'glass-menu-title', 'Réflexion')];
    if (!status?.remote) {
      for (const [label, on] of [
        ['Avec réflexion', true],
        ['Sans réflexion', false],
      ])
        parts.push(
          item(
            label,
            getThinking() === on,
            () => {
              setThinking(on);
              render();
              self.close({ refocus: true });
            },
            { key: `thinking:${on}` },
          ),
        );
      return parts;
    }
    const levels = options?.efforts ?? [];
    parts.push(
      ...levels.map(level =>
        item(
          EFFORT_NAMES[level] ?? level,
          level === options.effort,
          () => (level === options.effort ? self.close({ refocus: true }) : void choose({ effort: level }, self)),
          { key: `effort:${level}` },
        ),
      ),
    );
    if (!options) parts.push(node('p', 'glass-menu-empty', 'Lecture des modèles…'));
    else if (!levels.length && !options.error)
      parts.push(node('p', 'glass-menu-empty', 'Ce modèle ne propose pas de réglage de la réflexion.'));
    if (options?.ignored)
      parts.push(node('p', 'glass-menu-empty', 'Ce service refuse la force choisie : elle n’est pas envoyée avec ce modèle.'));
    // The models not read: no effort to offer, and why.
    if (options?.error && !levels.length) parts.push(node('p', 'glass-menu-error', options.error));
    return parts;
  });
  const popups = [models, efforts];

  function render() {
    const status = getStatus();
    if ((status?.remote?.id ?? null) !== of) {
      options = null;
      of = status?.remote?.id ?? null;
    }
    // A remote model whose models are not read yet (the page just opened): read now, for the name
    // of its model and its efforts.
    if (status?.remote && options === null && !loading) void refresh();
    const name = modelLabel(status, options, getLocalName()),
      modelTip = status?.remote ? `Modèle : ${name}${status.remote.name ? ' · ' + status.remote.name : ''}` : `Modèle local : ${name}`;
    models.text.textContent = name;
    models.button.setAttribute('aria-label', modelTip);
    const reflection = effortState(status, options, getThinking()),
      effortTip = status?.remote
        ? reflection.why || `Réflexion : ${EFFORT_NAMES[status.remote.effort] ?? ''}`
        : `Réflexion du modèle local : ${getThinking() ? 'oui' : 'non'}`;
    efforts.text.textContent = reflection.label;
    efforts.button.setAttribute('aria-label', effortTip);
    efforts.button.classList.toggle('is-off', reflection.off);
    // No tip over a menu open under its button.
    for (const [popupOf, tip] of [
      [models, modelTip],
      [efforts, effortTip],
    ])
      if (popupOf.menu.hidden) popupOf.button.dataset.tip = tip;
      else delete popupOf.button.dataset.tip;
  }
  function refresh({ again = false } = {}) {
    const status = getStatus();
    if (!status?.remote) {
      options = null;
      render();
      return Promise.resolve();
    }
    loading ??= (async () => {
      try {
        options = (await (await api('remote/options' + (again ? '?again=1' : ''))).json()).options;
      } catch (error) {
        options = { models: [], efforts: [], error: error.message, model: status.remote.model, effort: status.remote.effort };
      } finally {
        of = status.remote.id;
        loading = null;
      }
      render();
      for (const open of popups) if (!open.menu.hidden) open.draw();
    })();
    return loading;
  }
  render();
  return {
    render,
    refresh,
    close: () => {
      for (const open of popups) open.close();
    },
  };
}
