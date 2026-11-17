/**
 * A request whose workflow lacks a file (etats-maquette.md, 53): a card on the model of the proposal
 * card, in the message. « IL MANQUE UN FICHIER · VIDÉO · WAN SCAIL 2 », each file with an amber point,
 * its name and its size; where it goes; « Annuler » and « Télécharger · 28,6 Go ». While it downloads:
 * a line, « 3,4 / 28,6 GO » and « Arrêter » (what was fetched stays: it goes on from there). Once the
 * file is there, `onReady()`: true when the page sent the request again (the conversation had not
 * moved); else the card says « Wan SCAIL 2 est prêt » and offers « Reprendre la demande » (`onResume`):
 * a message sent hours later on its own would come out of context.
 *
 * Under the files, their licences (model-licenses.mjs): each by its name, a link to its text and its
 * limits. One with conditions (LTX 2.5, MiniMax H3, Krea 2, SAM 3.1) is confirmed first: « Télécharger »
 * then shows those licences alone, « À LIRE AVANT DE TÉLÉCHARGER », with « Retour » and « J’ai lu,
 * télécharger »; a free one is only named, and the download starts at once.
 */
import { licenseBlock, restrictedOf } from './model-licenses.mjs';

const KINDS = { video: 'Vidéo', audio: 'Son', image: 'Image' };

/** « 28,6 Go », « 578 Mo ». */
export function sizeText(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return (value / 1024 ** 3).toFixed(1).replace('.', ',') + ' Go';
  return Math.max(1, Math.round(value / 1024 ** 2)).toLocaleString('fr-FR') + ' Mo';
}

export function missingFileCard({
  host,
  request,
  node,
  icon,
  api,
  onReady = () => false,
  onResume = () => {},
  poll = 1000,
  wait = null,
}) {
  const missing = request.missing,
    card = node('section', 'missing-card'),
    pause = wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
    // The licences with conditions of these files: read and confirmed before the download.
    restricted = restrictedOf(missing.files);
  card.setAttribute('aria-label', 'Il manque un fichier');
  let state = 'idle',
    left = missing.left || missing.bytes,
    received = 0,
    total = missing.bytes,
    error = '',
    following = false,
    gone = false;

  function button(className, text, onclick, glyph) {
    const element = node('button', className);
    element.type = 'button';
    if (glyph) element.append(icon(glyph));
    element.append(node('span', '', text));
    element.onclick = onclick;
    return element;
  }
  function render() {
    if (gone) return;
    const head = node(
        'p',
        'missing-head',
        ['Il manque un fichier', KINDS[request.mediaType] ?? KINDS.image, request.workflowName].filter(Boolean).join(' · '),
      ),
      list = node('ul', 'missing-files');
    for (const file of missing.files) {
      const item = node('li', 'missing-file');
      item.append(
        node('span', 'missing-dot'),
        node('span', 'missing-name', file.file),
        node('span', 'missing-size', file.size ? sizeText(file.size) : ''),
      );
      list.append(item);
    }
    const note = node(
      'p',
      'missing-note',
      missing.needsToken
        ? `Ce fichier demande un compte Hugging Face : acceptez la licence${missing.page ? ' sur ' + missing.page : ''}, puis enregistrez votre jeton dans Paramètres › Mise à jour.`
        : 'Il va dans votre dossier des modèles, depuis Hugging Face. Le téléchargement reprend où il en était si vous l’arrêtez.',
    );
    const foot = node('div', 'missing-foot');
    if (state === 'running') {
      const progress = node('div', 'missing-progress'),
        line = node('span', 'missing-line'),
        fill = node('span', 'missing-fill');
      fill.style.width = (total ? Math.min(100, (received / total) * 100) : 0) + '%';
      line.append(fill);
      progress.append(line, node('span', 'missing-count', `${sizeText(received)} / ${sizeText(total)}`));
      progress.setAttribute('role', 'progressbar');
      progress.setAttribute('aria-valuenow', String(total ? Math.round((received / total) * 100) : 0));
      foot.append(progress, button('text-button missing-stop', 'Arrêter', () => void stop()));
    } else if (state === 'done') {
      foot.append(node('p', 'missing-done', 'Le fichier est là. Je reprends votre demande…'));
    } else if (state === 'ready') {
      foot.append(
        node('p', 'missing-done', `${request.workflowName} est prêt`),
        button('missing-go', 'Reprendre la demande', () => onResume(), 'play'),
      );
    } else if (state === 'confirm') {
      const several = restricted.length > 1;
      foot.append(
        node(
          'p',
          'missing-ask',
          `Vous avez lu ${several ? 'ces licences' : 'cette licence'} et vous en acceptez les conditions ?`,
        ),
        button('text-button missing-back', 'Retour', () => back()),
        button('missing-go', 'J’ai lu, télécharger · ' + sizeText(left), () => void confirm(), 'download'),
      );
    } else {
      foot.append(
        button('text-button missing-cancel', 'Annuler', () => cancel()),
        button('missing-go', 'Télécharger · ' + sizeText(left), () => void start(), 'download'),
      );
    }
    const parts = [head, list, note],
      licenses = licenseBlock({ node, files: missing.files, confirm: state === 'confirm' });
    if (licenses) parts.push(licenses);
    if (error) {
      const alert = node('p', 'missing-error', error);
      alert.setAttribute('role', 'alert');
      parts.push(alert);
    }
    card.replaceChildren(...parts, foot);
  }
  /** « Télécharger »: at once under free licences; one with conditions is shown alone and confirmed first. */
  async function start() {
    if (!restricted.length) return download(false);
    error = '';
    state = 'confirm';
    render();
  }
  /** « J’ai lu, télécharger »: the download, with the word that the licences were read. */
  const confirm = () => download(true);
  function back() {
    state = 'idle';
    render();
  }
  async function download(accepted) {
    error = '';
    try {
      const job = await (
        await api('downloads/start', { id: missing.workflowId, ...(accepted ? { accepted: true } : {}) })
      ).json();
      ({ received = 0, total = total } = job);
      state = 'running';
    } catch (failure) {
      state = 'idle';
      error = failure.message;
    }
    render();
    if (state === 'running') await follow();
  }
  /** The download as it goes (GET /api/downloads), until the file is there, stopped or failed. */
  async function follow() {
    if (following) return;
    following = true;
    try {
      while (!gone && card.isConnected !== false) {
        const { job } = await (await api('downloads')).json();
        if (job.workflowId !== missing.workflowId && job.state === 'running') {
          state = 'idle';
          error = `Un autre téléchargement est en cours (${job.name}) : attendez sa fin.`;
          return;
        }
        if (job.state === 'done' && job.workflowId === missing.workflowId) {
          // Sent again by the page, or left to the user (the conversation moved meanwhile).
          state = onReady() ? 'done' : 'ready';
          render();
          return;
        }
        if (job.state === 'cancelled' || job.state === 'error' || job.state === 'idle') {
          state = 'idle';
          left = Math.max(0, (job.total || total) - (job.received || 0)) || left;
          if (job.state === 'error') error = job.error;
          return;
        }
        received = job.received;
        total = job.total || total;
        render();
        await pause(poll);
      }
    } catch (failure) {
      state = 'idle';
      error = failure.message;
    } finally {
      following = false;
      render();
    }
  }
  async function stop() {
    try {
      await api('downloads/cancel', {});
    } catch (failure) {
      error = failure.message;
    }
  }
  /** « Annuler »: the card goes, a line says it where it was. */
  function cancel() {
    gone = true;
    card.remove();
    host.append(node('p', 'proposal-cancelled', 'Proposition annulée.'));
  }
  render();
  host.append(card);
  // A download of this file already under way (stopped and started again from the settings).
  void api('downloads')
    .then(response => response.json())
    .then(({ job }) => {
      if (job?.state === 'running' && job.workflowId === missing.workflowId) {
        state = 'running';
        ({ received = 0, total = total } = job);
        render();
        return follow();
      }
    })
    .catch(() => {});
  return { card, start, confirm, back, stop, cancel };
}
