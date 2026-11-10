/**
 * Buttons under every generated output, in the Output panel and in the chat:
 * Détails for all; Upscale for images and videos; Interpoler and Prolonger for videos.
 * A button is disabled, with the reason, when no active workflow can do it.
 */
const ACTIONS = [
  { id: 'details', label: 'Détails', icon: 'info', media: ['image', 'video'] },
  {
    id: 'upscale',
    verb: 'upscale',
    label: 'Upscale',
    icon: 'upscale',
    media: ['image', 'video'],
    missing: media => `Aucun workflow d’upscale ${media === 'video' ? 'vidéo' : 'image'} actif.`,
  },
  {
    id: 'interpolate',
    verb: 'interpolate',
    label: 'Interpoler',
    icon: 'frames',
    media: ['video'],
    missing: () => 'Aucun workflow d’interpolation actif.',
  },
  {
    id: 'extend',
    verb: 'extend_video',
    label: 'Prolonger',
    icon: 'forward',
    media: ['video'],
    missing: () => 'Aucun workflow ne sait prolonger une vidéo.',
  },
];
const TITLES = {
  details: 'Voir l’original et ses paramètres',
  upscale: 'Agrandir et affiner ce résultat',
  interpolate: 'Ajouter des images intermédiaires pour une vidéo plus fluide',
  extend: 'Écrire la suite de cette vidéo pour le modèle',
};
const CACHE_MS = 5000;

/**
 * `actions(record, index)` builds the button row for one output. `onAction(record, index, id)`
 * receives upscale, interpolate or extend; Détails calls `onDetails(record, index)`.
 */
export function outputActions({ api, node, onDetails, onAction }) {
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
    const media = record.mediaType === 'video' ? 'video' : 'image',
      row = node('div', 'output-actions');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Actions sur ce résultat');
    const buttons = [];
    for (const action of ACTIONS.filter(item => item.media.includes(media))) {
      const button = node('button', 'output-action output-action-' + action.id);
      button.type = 'button';
      button.title = TITLES[action.id];
      button.append(icon(action.icon), node('span', '', action.label));
      button.onclick = () => (action.id === 'details' ? onDetails(record, index) : onAction(record, index, action.id));
      if (action.verb) {
        // Disabled until the server says an active workflow can do it.
        button.disabled = true;
        buttons.push([button, action]);
      }
      row.append(button);
    }
    load().then(verbs => {
      for (const [button, action] of buttons) {
        const ready = (verbs[action.verb] || []).includes(media);
        button.disabled = !ready;
        button.title = ready ? TITLES[action.id] : action.missing(media);
      }
    });
    return row;
  };
}
