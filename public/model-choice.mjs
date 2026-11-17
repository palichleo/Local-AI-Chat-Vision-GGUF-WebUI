import { closePopup, openPopup } from './glass-menu.mjs';

/**
 * The model and its reflection, chosen in the bar of the chat (17/11): one compact button beside
 * « Joindre », its menu of glass. With a remote model, its models (a filter when they are many) and
 * the efforts the model chosen takes (Faible, Moyenne, Élevée…), kept as the last choice by the
 * server (POST /api/remote/choice). With the local model, its reflection: with or without.
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

/** What the button says: the model and its effort, or the reflection of the local model. */
export function choiceLabel(status, options, thinking) {
  if (!status?.remote) return thinking ? 'Réflexion' : 'Sans réflexion';
  const model = options?.models?.find(item => item.id === status.remote.model)?.name ?? status.remote.model ?? '';
  const effort = options ? options.effort : status.remote.effort;
  return effort && EFFORT_NAMES[effort] ? `${model} · ${EFFORT_NAMES[effort]}` : model;
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
}) {
  const button = $('model-choice'),
    text = $('model-choice-text'),
    menu = $('model-choice-menu'),
    page = button.ownerDocument;
  let options = null,
    // The connection the options are of: asked again when another is chosen.
    of = null,
    filter = '',
    working = false;

  function render() {
    const status = getStatus();
    if ((status?.remote?.id ?? null) !== of) {
      options = null;
      of = status?.remote?.id ?? null;
    }
    const said = choiceLabel(status, options, getThinking());
    text.textContent = said;
    const tip = status?.remote
      ? `Modèle et réflexion : ${said}`
      : `Réflexion du modèle local : ${getThinking() ? 'oui' : 'non'}`;
    button.setAttribute('aria-label', tip);
    button.dataset.tip = tip;
    button.classList.toggle('is-off', !status?.remote && !getThinking());
  }
  async function refresh({ again = false } = {}) {
    const status = getStatus();
    if (!status?.remote) {
      options = null;
      return render();
    }
    try {
      options = (await (await api('remote/options' + (again ? '?again=1' : ''))).json()).options;
      of = status.remote.id;
    } catch (error) {
      options = {
        models: [],
        efforts: [],
        error: error.message,
        model: status.remote.model,
        effort: status.remote.effort,
      };
    }
    render();
  }

  const beside = event => {
    if (!menu.contains(event.target) && !button.contains(event.target)) close();
  };
  function close({ refocus = false } = {}) {
    if (menu.hidden) return;
    closePopup(menu);
    menu.replaceChildren();
    button.setAttribute('aria-expanded', 'false');
    page.removeEventListener('pointerdown', beside, true);
    if (refocus) button.focus();
  }
  function item(label, chosen, onclick, { note = '' } = {}) {
    const element = node('button', 'glass-menu-item' + (chosen ? ' is-chosen' : ''), label);
    element.type = 'button';
    element.setAttribute('role', 'menuitemradio');
    element.setAttribute('aria-checked', String(chosen));
    if (note) element.append(node('span', 'glass-menu-note', note));
    element.disabled = working;
    element.onclick = onclick;
    return element;
  }
  async function choose(change) {
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
      if (!menu.hidden) draw();
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
        ...shown.slice(0, 200).map(model =>
          item(
            model.name,
            model.id === options?.model,
            () => model.id !== options?.model && void choose({ model: model.id }),
            {
              note: model.id.endsWith(':free') ? 'gratuit' : '',
            },
          ),
        ),
      );
      if (!shown.length)
        list.append(node('p', 'glass-menu-empty', options ? 'Aucun modèle trouvé.' : 'Lecture des modèles…'));
      parts.push(list);
      const efforts = options?.efforts ?? [];
      if (efforts.length) {
        parts.push(node('p', 'glass-menu-title', 'Réflexion'));
        parts.push(
          ...efforts.map(level =>
            item(
              EFFORT_NAMES[level] ?? level,
              level === options.effort,
              () => level !== options.effort && void choose({ effort: level }),
            ),
          ),
        );
      }
      if (options?.error) parts.push(node('p', 'glass-menu-error', options.error));
    } else {
      parts.push(node('p', 'glass-menu-title', 'Réflexion'));
      for (const [label, on] of [
        ['Avec réflexion', true],
        ['Sans réflexion', false],
      ])
        parts.push(
          item(label, getThinking() === on, () => {
            setThinking(on);
            render();
            close({ refocus: true });
          }),
        );
    }
    menu.replaceChildren(...parts);
  }
  async function open() {
    if (!menu.hidden || button.disabled) return;
    filter = '';
    draw();
    openPopup(menu, button, { align: 'start' });
    button.setAttribute('aria-expanded', 'true');
    page.addEventListener('pointerdown', beside, true);
    if (getStatus()?.remote) {
      await refresh();
      if (menu.hidden) return;
      draw();
      // Placed again: the list of models may have made it taller.
      openPopup(menu, button, { align: 'start' });
    }
    (
      menu.querySelector('.glass-menu-filter') ??
      menu.querySelector('.is-chosen') ??
      menu.querySelector('button')
    )?.focus();
  }
  button.onclick = () => (menu.hidden ? void open() : close());
  menu.addEventListener('keydown', event => {
    const list = [...menu.querySelectorAll('button:not(:disabled)')],
      at = list.indexOf(page.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close({ refocus: true });
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      list[(at + (event.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
    } else if (event.key === 'Tab') close();
  });
  render();
  return { render, refresh, close };
}
