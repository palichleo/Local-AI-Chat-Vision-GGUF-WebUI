import { closePopup, openPopup } from './glass-menu.mjs';

/**
 * The model and its reflection, chosen in the bar of the chat (17/11): one compact button beside
 * « Joindre », its menu of glass. With a remote model, its models (a filter when they are many) and
 * the efforts the model chosen takes (Faible, Moyenne, Élevée…), kept as the last choice by the
 * server (POST /api/remote/choice). With the local model, its reflection: with or without.
 * The button says the model and the effort that go with the next message, as soon as the page
 * opens; its name cut short never hides the effort.
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
const FILTER_FROM = 12;
// The models shown at once in the menu; the filter finds the others.
export const SHOWN = 200;

/** What the button says: [the model, its effort] of a remote model, or the reflection of the local one. */
export function choiceParts(status, options, thinking) {
  if (!status?.remote) return [thinking ? 'Réflexion' : 'Sans réflexion', ''];
  const model = options?.models?.find(item => item.id === status.remote.model)?.name ?? status.remote.model ?? '';
  // The effort that goes with the next message: the one kept for the connection.
  const effort = status.remote.effort;
  return [model, effort && EFFORT_NAMES[effort] ? EFFORT_NAMES[effort] : ''];
}
/** The same, as one line (its tip, its name for a screen reader). */
export function choiceLabel(status, options, thinking) {
  const [model, effort] = choiceParts(status, options, thinking);
  return effort ? `${model} · ${effort}` : model;
}

export function setupModelChoice({
  $,
  api,
  node,
  getStatus,
  getThinking,
  setThinking,
  onStatus = () => {},
  notice = () => {},
  view = globalThis,
}) {
  const button = $('model-choice'),
    text = $('model-choice-text'),
    menu = $('model-choice-menu'),
    page = button.ownerDocument;
  const name = node('span', 'model-choice-name'),
    effort = node('span', 'model-choice-effort');
  text.replaceChildren(name, effort);
  // Focusable itself: a key pressed while nothing in it can be (the models being read) reaches it.
  menu.tabIndex = -1;
  let options = null,
    // The connection the options are of: asked again when another is chosen.
    of = null,
    loading = null,
    filter = '',
    working = false,
    // The menu never narrower than it was since it opened (a filter would make it jump).
    widest = 0;

  function render() {
    const status = getStatus();
    if ((status?.remote?.id ?? null) !== of) {
      options = null;
      of = status?.remote?.id ?? null;
    }
    // A remote model whose models are not read yet (the page just opened): read now, for the name
    // of its model and its efforts.
    if (status?.remote && options === null && !loading) void refresh();
    const [model, level] = choiceParts(status, options, getThinking());
    name.textContent = model;
    effort.textContent = level ? ` · ${level}` : '';
    effort.hidden = !level;
    const tip = status?.remote
      ? `Modèle et réflexion : ${choiceLabel(status, options, getThinking())}`
      : `Réflexion du modèle local : ${getThinking() ? 'oui' : 'non'}`;
    button.setAttribute('aria-label', tip);
    // No tip over the menu open under it.
    if (menu.hidden) button.dataset.tip = tip;
    else delete button.dataset.tip;
    button.classList.toggle('is-off', !status?.remote && !getThinking());
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
      if (!menu.hidden) draw();
    })();
    return loading;
  }

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
  /** Placed against its button, as tall as the room on the side it opens, never narrower than it was. */
  function place() {
    const box = button.getBoundingClientRect?.();
    if (box) {
      const room = Math.max(box.top, (view.innerHeight ?? 800) - box.bottom) - 24;
      menu.style.maxHeight = Math.round(Math.max(160, Math.min(560, room))) + 'px';
    }
    menu.style.minWidth = '';
    widest = Math.max(widest, Math.round(menu.getBoundingClientRect?.().width ?? 0), 260);
    menu.style.minWidth = widest + 'px';
    openPopup(menu, button, { view, align: 'start' });
  }
  async function choose(change, key) {
    if (working) return;
    working = true;
    draw();
    try {
      const result = await (await api('remote/choice', change)).json();
      options = result.options;
      onStatus(result.status);
    } catch (error) {
      notice(error.message);
    } finally {
      working = false;
      render();
      if (!menu.hidden) {
        draw();
        // The focus back where it was: the choice made, else the one chosen.
        const found = [...menu.querySelectorAll('[data-key]')].find(element => element.dataset.key === key);
        (found ?? menu.querySelector('.is-chosen') ?? menu)?.focus?.();
      }
    }
  }
  /** The menu drawn again from what is known: the models (filtered), the efforts, or the reflection. */
  function draw() {
    const status = getStatus(),
      parts = [];
    if (status?.remote) {
      const models = options?.models ?? [];
      parts.push(node('p', 'glass-menu-title', 'Modèle'));
      if (models.length > FILTER_FROM) {
        const field = node('input', 'glass-menu-filter');
        field.type = 'search';
        field.placeholder = 'Chercher un modèle…';
        field.value = filter;
        field.setAttribute('aria-label', 'Chercher un modèle');
        field.addEventListener('input', () => {
          filter = field.value;
          draw();
          const again = menu.querySelector('.glass-menu-filter');
          again?.focus();
          again?.setSelectionRange?.(filter.length, filter.length);
        });
        parts.push(field);
      }
      const words = filter.trim().toLowerCase();
      const shown = words ? models.filter(model => `${model.name} ${model.id}`.toLowerCase().includes(words)) : models;
      const list = node('div', 'glass-menu-list');
      list.append(
        ...shown.slice(0, SHOWN).map(model =>
          item(model.name, model.id === options?.model, () => model.id !== options?.model && void choose({ model: model.id }, `model:${model.id}`), {
            note: model.id.endsWith(':free') ? 'gratuit' : '',
            key: `model:${model.id}`,
          }),
        ),
      );
      if (shown.length > SHOWN)
        list.append(node('p', 'glass-menu-empty', `${SHOWN} modèles montrés sur ${shown.length} : cherchez-en un par son nom.`));
      // Nothing listed: being read, or nothing matches (what stopped a listing is said below).
      if (!shown.length && !options?.error)
        list.append(node('p', 'glass-menu-empty', options ? 'Aucun modèle trouvé.' : 'Lecture des modèles…'));
      parts.push(list);
      const efforts = options?.efforts ?? [];
      if (efforts.length) {
        parts.push(node('p', 'glass-menu-title', 'Réflexion'));
        parts.push(
          ...efforts.map(level =>
            item(EFFORT_NAMES[level] ?? level, level === options.effort, () => level !== options.effort && void choose({ effort: level }, `effort:${level}`), {
              key: `effort:${level}`,
            }),
          ),
        );
      }
      if (options?.ignored)
        parts.push(node('p', 'glass-menu-empty', 'Ce service refuse la force choisie : elle n’est pas envoyée avec ce modèle.'));
      if (options?.error) parts.push(node('p', 'glass-menu-error', options.error));
    } else {
      parts.push(node('p', 'glass-menu-title', 'Réflexion'));
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
              close({ refocus: true });
            },
            { key: `thinking:${on}` },
          ),
        );
    }
    menu.replaceChildren(...parts);
    // Placed again after each drawing: a list read, a model chosen, a filter typed change its size.
    if (!menu.hidden) place();
  }
  async function open() {
    if (!menu.hidden || button.disabled) return;
    filter = '';
    widest = 0;
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    delete button.dataset.tip;
    page.addEventListener('pointerdown', beside, true);
    page.addEventListener('keydown', keys, true);
    draw();
    (menu.querySelector('.glass-menu-filter') ?? menu.querySelector('.is-chosen') ?? menu.querySelector('button') ?? menu).focus?.();
    if (getStatus()?.remote) {
      await refresh();
      if (menu.hidden) return;
      (menu.querySelector('.glass-menu-filter') ?? menu.querySelector('.is-chosen') ?? menu.querySelector('button') ?? menu).focus?.();
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
  render();
  return { render, refresh, close };
}
