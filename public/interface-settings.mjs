/**
 * The Interface tab of the settings (parametres-maquette.md; captures 45 and 46): the room and its
 * light and grain, applied at once on the page (room.mjs, applyRoom); « Enregistrer » keeps them
 * with the other preferences, « Annuler » or closing goes back to what was kept, « Rétablir les
 * réglages par défaut » puts the defaults in hand. Grain « Aucun » fades Dose, Mouvement, Filtres.
 */
import { DEFAULTS, FILTERS, GRAINS, LIGHTS, ROOMS, applyRoom, roomSettings } from './room.mjs';

const ROOM_NAMES = { salle: 'Salle', ecran: 'Écran éteint', nuit: 'Nuit américaine', velours: 'Velours', tirage: 'Tirage', lavande: 'Lavande' };
const LIGHT_NAMES = { plusieurs: 'Plusieurs sources', une: 'Une source', discret: 'Discret' };
const GRAIN_NAMES = { aucun: 'Aucun', poudre: 'Poudre', fin: 'Fin', film: 'Film', gros: 'Gros' };
const MOTION_NAMES = { fige: 'Figé', 24: '24 i/s' };
const FILTER_NAMES = { diffusion: 'Diffusion', lumiere: 'Lumière', centre: 'Centre clair' };

export function setupInterfaceSettings({ $, node, api, root = globalThis.document?.documentElement }) {
  let saved = roomSettings(),
    current = roomSettings();
  const same = (a, b) => JSON.stringify(roomSettings(a)) === JSON.stringify(roomSettings(b));

  /** A row of choices, one pressed (the same small group as Image · Vidéo · Son). */
  function segments(box, names, list, value, pick) {
    box.replaceChildren(
      ...list.map(id => {
        const choice = node('button', 'settings-segment', names[id]);
        choice.type = 'button';
        choice.setAttribute('role', 'radio');
        choice.setAttribute('aria-checked', String(String(value) === String(id)));
        choice.onclick = () => pick(id);
        return choice;
      }),
    );
  }
  function paint() {
    // The six rooms, each its own colour, its name under it.
    $('room-choices').replaceChildren(
      ...ROOMS.map(id => {
        const choice = node('button', 'room-choice');
        choice.type = 'button';
        choice.dataset.room = id;
        choice.setAttribute('role', 'radio');
        choice.setAttribute('aria-checked', String(current.room === id));
        choice.append(node('span', 'room-swatch'), node('span', 'room-name', ROOM_NAMES[id]));
        choice.onclick = () => change({ room: id });
        return choice;
      }),
    );
    segments($('room-light'), LIGHT_NAMES, LIGHTS, current.light, light => change({ light }));
    segments($('room-grain'), GRAIN_NAMES, GRAINS, current.grain, grain => change({ grain }));
    segments($('room-motion'), MOTION_NAMES, ['fige', '24'], current.motion, motion => change({ motion }));
    $('room-filters').replaceChildren(
      ...FILTERS.map(id => {
        const chip = node('button', 'settings-chip', FILTER_NAMES[id]);
        chip.type = 'button';
        chip.setAttribute('aria-pressed', String(current.filters.includes(id)));
        chip.onclick = () =>
          change({ filters: current.filters.includes(id) ? current.filters.filter(name => name !== id) : [...current.filters, id] });
        return chip;
      }),
    );
    $('room-dose').value = String(current.dose);
    $('room-dose-value').textContent = current.dose + ' %';
    // No grain: its dose, its motion and its filters fade.
    const none = current.grain === 'aucun';
    for (const row of $('settings-panel-interface')?.querySelectorAll?.('.room-grain-more') ?? []) row.classList.toggle('is-faded', none);
  }
  /**
   * The choice that has the focus, as a way to give it back once the choices are drawn again (its
   * group, its place in it); null when the focus is elsewhere. Read before they are drawn: replaced,
   * a button is no longer the one focused.
   */
  function held() {
    const active = globalThis.document?.activeElement;
    for (const id of ['room-choices', 'room-light', 'room-grain', 'room-motion', 'room-filters']) {
      const at = active ? [...($(id).children ?? [])].indexOf(active) : -1;
      if (at >= 0) return () => $(id).children[at]?.focus?.();
    }
    return null;
  }
  function change(patch) {
    current = roomSettings({ ...current, ...patch });
    if (root) applyRoom(current, root);
    // Made on the keyboard, a choice keeps the focus, on the button drawn in its place: lost, it
    // went back to the top of the settings at each choice.
    const back = held();
    paint();
    back?.();
  }
  $('room-dose').oninput = () => change({ dose: Number($('room-dose').value) });
  $('room-reset').onclick = () => change({ ...DEFAULTS, filters: [...DEFAULTS.filters] });

  return {
    /** The room kept (the preferences), put on the page. */
    load(value) {
      saved = roomSettings(value);
      current = roomSettings(value);
      if (root) applyRoom(current, root);
      paint();
    },
    dirty: () => !same(current, saved),
    /** Kept with the other preferences. */
    async save() {
      if (same(current, saved)) return;
      const { preferences } = await (await api('preferences', { room: current })).json();
      saved = roomSettings(preferences.room);
    },
    /** Closed without « Enregistrer »: the page as it was. */
    revert() {
      current = roomSettings(saved);
      if (root) applyRoom(current, root);
      paint();
    },
  };
}
