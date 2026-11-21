/**
 * The Interface tab of the settings (parametres-maquette.md; captures 45 and 46): the room and its
 * light and grain, applied at once on the page (room.mjs, applyRoom); « Enregistrer » keeps them
 * with the other preferences, « Annuler » or closing goes back to what was kept, « Rétablir les
 * réglages par défaut » puts the defaults in hand. Grain « Aucun » fades Dose, Mouvement, Filtres.
 * Éclairage (18/11, lumiere-irisee-maquette.md): « Lumière », Dernière prise (the default) or
 * Irisée; « Sources », those of the light of the last take, faded and out of reach with Irisée.
 * (0.6.187) Watermark (watermark-maquette.md, capture 93): the one of the videos that go out of Moodix,
 * Aucun · L'Éclipse · L'Éclipse et le nom, each shown on a picture with its watermark laid; L'Éclipse by
 * default. Set here only (decision of 21/11), kept with the room.
 */
import { DEFAULTS, FILTERS, GRAINS, LIGHTINGS, LIGHTS, ROOMS, applyRoom, roomSettings } from './room.mjs';
import { WATERMARKS, WATERMARK_DEFAULT, WATERMARK_NAMES, watermarkSetting } from './watermark.mjs';

const ROOM_NAMES = { salle: 'Salle', ecran: 'Écran éteint', nuit: 'Nuit américaine', velours: 'Velours', tirage: 'Tirage', lavande: 'Lavande' };
const LIGHTING_NAMES = { prise: 'Dernière prise', irisee: 'Irisée' };
// Under the pointer (lumiere-irisee-maquette.md).
const LIGHTING_TIPS = {
  prise: 'La dernière prise éclaire la pièce et change avec elle',
  irisee: 'Une lumière irisée, comme le reflet d’un disque. Elle ne change pas avec les prises',
};
const LIGHT_NAMES = { plusieurs: 'Plusieurs sources', une: 'Une source', discret: 'Discret' };
const GRAIN_NAMES = { aucun: 'Aucun', poudre: 'Poudre', fin: 'Fin', film: 'Film', gros: 'Gros' };
const MOTION_NAMES = { fige: 'Figé', 24: '24 i/s' };
const FILTER_NAMES = { diffusion: 'Diffusion', lumiere: 'Lumière', centre: 'Centre clair' };

export function setupInterfaceSettings({ $, node, api, root = globalThis.document?.documentElement }) {
  let saved = roomSettings(),
    current = roomSettings(),
    savedMark = WATERMARK_DEFAULT,
    mark = WATERMARK_DEFAULT;
  const same = (a, b) => JSON.stringify(roomSettings(a)) === JSON.stringify(roomSettings(b));

  /**
   * A row of choices, one pressed (the same small group as Image · Vidéo · Son). `tips`: the words of
   * each under the pointer; `off`: none can be chosen (the keyboard does not reach them either).
   */
  function segments(box, names, list, value, pick, { tips = null, off = false } = {}) {
    box.replaceChildren(
      ...list.map(id => {
        const choice = node('button', 'settings-segment', names[id]);
        choice.type = 'button';
        choice.setAttribute('role', 'radio');
        choice.setAttribute('aria-checked', String(String(value) === String(id)));
        if (tips?.[id]) choice.title = tips[id];
        choice.disabled = off;
        choice.onclick = () => pick(id);
        return choice;
      }),
    );
    box.setAttribute('aria-disabled', String(off));
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
    segments($('room-lighting'), LIGHTING_NAMES, LIGHTINGS, current.lighting, lighting => change({ lighting }), {
      tips: LIGHTING_TIPS,
    });
    // The sources are those of the light of the last take: with Irisée, they fade and cannot be chosen.
    const iridescent = current.lighting === 'irisee';
    segments($('room-light'), LIGHT_NAMES, LIGHTS, current.light, light => change({ light }), { off: iridescent });
    $('room-sources')?.classList?.toggle('is-faded', iridescent);
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
    // (0.6.187) The three watermarks, each on its picture, its name under it (moodix.css, .watermark-choice).
    $('watermark-choices').replaceChildren(
      ...WATERMARKS.map(id => {
        const choice = node('button', 'watermark-choice'),
          frame = node('span', 'watermark-frame');
        choice.type = 'button';
        choice.dataset.watermark = id;
        choice.setAttribute('role', 'radio');
        choice.setAttribute('aria-checked', String(mark === id));
        if (id !== 'aucun') {
          const laid = node('img', 'watermark-mark');
          laid.src = `/assets/watermark-${id}.svg`;
          laid.alt = '';
          laid.draggable = false;
          frame.append(laid);
        }
        choice.append(frame, node('span', 'watermark-name', WATERMARK_NAMES[id]));
        choice.onclick = () => change({}, id);
        return choice;
      }),
    );
  }
  /**
   * The choice that has the focus, as a way to give it back once the choices are drawn again (its
   * group, its place in it); null when the focus is elsewhere. Read before they are drawn: replaced,
   * a button is no longer the one focused.
   */
  function held() {
    const active = globalThis.document?.activeElement;
    for (const id of ['room-choices', 'room-lighting', 'room-light', 'room-grain', 'room-motion', 'room-filters', 'watermark-choices']) {
      const at = active ? [...($(id).children ?? [])].indexOf(active) : -1;
      if (at >= 0) return () => $(id).children[at]?.focus?.();
    }
    return null;
  }
  function change(patch, watermark = mark) {
    current = roomSettings({ ...current, ...patch });
    mark = watermarkSetting(watermark);
    if (root) applyRoom(current, root);
    // Made on the keyboard, a choice keeps the focus, on the button drawn in its place: lost, it
    // went back to the top of the settings at each choice.
    const back = held();
    paint();
    back?.();
  }
  $('room-dose').oninput = () => change({ dose: Number($('room-dose').value) });
  $('room-reset').onclick = () => change({ ...DEFAULTS, filters: [...DEFAULTS.filters] }, WATERMARK_DEFAULT);

  return {
    /** The room and the watermark kept (the preferences), put on the page. */
    load(value, watermark) {
      saved = roomSettings(value);
      current = roomSettings(value);
      savedMark = mark = watermarkSetting(watermark);
      if (root) applyRoom(current, root);
      paint();
    },
    dirty: () => !same(current, saved) || mark !== savedMark,
    /** Kept with the other preferences: what changed of them. */
    async save() {
      const changed = {
        ...(same(current, saved) ? {} : { room: current }),
        ...(mark === savedMark ? {} : { watermark: mark }),
      };
      if (!Object.keys(changed).length) return;
      const { preferences } = await (await api('preferences', changed)).json();
      if ('room' in changed) saved = roomSettings(preferences.room);
      if ('watermark' in changed) savedMark = watermarkSetting(preferences.watermark);
    },
    /** Closed without « Enregistrer »: the page as it was. */
    revert() {
      current = roomSettings(saved);
      mark = savedMark;
      if (root) applyRoom(current, root);
      paint();
    },
  };
}
