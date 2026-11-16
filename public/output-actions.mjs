/**
 * The actions on a take, the same everywhere, the same icons and the same help (chat, Studio,
 * Pellicule; claude_design/maquettes/reference-maquettes.md):
 * - image: Ouvrir · Agrandir et affiner · Animer · Afficher dans le Studio;
 * - video: Ouvrir · Prolonger · Interpoler · Agrandir et affiner · Afficher dans le Studio;
 * - sound: Ouvrir · Afficher dans le Studio.
 * Icons only, their name and their help under the pointer. One that no active workflow can do is
 * greyed, with the reason. « Ouvrir » shows the original and its settings (« Détails » before 0.6.6).
 */
const ACTIONS = [
  {
    id: 'details',
    label: 'Ouvrir',
    help: 'L’original et ses réglages',
    icon: 'open',
    media: ['image', 'video', 'audio'],
  },
  {
    id: 'extend',
    verb: 'extend_video',
    label: 'Prolonger',
    help: 'Écrire la suite de cette vidéo pour Moodix',
    icon: 'forward',
    media: ['video'],
    missing: () => 'Aucun workflow ne sait prolonger une vidéo.',
  },
  {
    id: 'interpolate',
    verb: 'interpolate',
    label: 'Interpoler',
    help: 'Des images intermédiaires, pour une vidéo plus fluide',
    icon: 'frames',
    media: ['video'],
    missing: () => 'Aucun workflow d’interpolation actif.',
  },
  {
    id: 'upscale',
    verb: 'upscale',
    label: 'Agrandir et affiner',
    help: 'Une version plus grande et plus nette',
    icon: 'upscale',
    media: ['image', 'video'],
    missing: media => `Aucun workflow d’upscale ${media === 'video' ? 'vidéo' : 'image'} actif.`,
  },
  {
    id: 'animate',
    verb: 'animate',
    label: 'Animer',
    help: 'Une vidéo qui part de cette prise',
    icon: 'animate',
    media: ['image'],
    missing: () => 'Aucun workflow vidéo ne part d’une image.',
  },
  {
    id: 'studio',
    label: 'Afficher dans le Studio',
    help: 'Votre prompt et vos réglages ne changent pas',
    icon: 'panel',
    media: ['image', 'video', 'audio'],
  },
];
const CACHE_MS = 5000;
/** The tooltip of an action: its name, its help under it. */
const tipOf = (action, reason = '') => `${action.label}\n${reason || action.help}`;

/**
 * `actions(record, index)` builds the row of one take. `onAction(record, index, id)` receives
 * upscale, interpolate, extend and animate; Ouvrir calls `onDetails(record, index)`, Afficher dans
 * le Studio `onShow(record, index)` (absent: not offered, as in the Studio itself).
 */
export function outputActions({ api, node, onDetails, onAction, onShow = null }) {
  let available = null,
    loaded = 0;
  function load() {
    if (!available || Date.now() - loaded > CACHE_MS) {
      loaded = Date.now();
      available = api('tools/actions')
        .then(response => response.json())
        .catch(() => ({}));
    }
    return available;
  }
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
      use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    svg.setAttribute('aria-hidden', 'true');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }
  return function actions(record, index) {
    const media = ['video', 'audio'].includes(record.mediaType) ? record.mediaType : 'image',
      row = node('div', 'output-actions');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Actions sur cette prise');
    const buttons = [];
    for (const action of ACTIONS.filter(item => item.media.includes(media))) {
      if (action.id === 'studio' && !onShow) continue;
      const button = node('button', 'output-action output-action-' + action.id);
      button.type = 'button';
      button.setAttribute('aria-label', action.label);
      button.title = tipOf(action);
      button.append(icon(action.icon), node('span', '', action.label));
      button.onclick = () =>
        action.id === 'details'
          ? onDetails(record, index)
          : action.id === 'studio'
            ? onShow(record, index)
            : onAction(record, index, action.id);
      if (action.verb) {
        // Disabled until the server says an active workflow can do it.
        button.disabled = true;
        buttons.push([button, action]);
      }
      row.append(button);
    }
    function refresh() {
      return load().then(verbs => {
        for (const [button, action] of buttons) {
          const ready = (verbs[action.verb] || []).includes(media);
          button.disabled = !ready;
          button.title = tipOf(action, ready ? '' : action.missing(media));
        }
      });
    }
    // Workflows can become ready after the row was drawn (relaunch, model added):
    // the row checks again when the pointer reaches it. A disabled button gets no
    // pointer events, so the listener sits on the row.
    if (buttons.length) row.addEventListener('pointerenter', refresh);
    refresh();
    return row;
  };
}
