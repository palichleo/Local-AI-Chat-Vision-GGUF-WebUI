import { takeFlux } from './take-flux.mjs';
import { livePreview } from './live-preview.mjs';

/**
 * The miniature of the chat (0.6.81). While a work of a conversation goes on (Moodix answers, a
 * card waits for the user, a take is made) and the user looks elsewhere (another conversation, the
 * Pellicule, the Studio when it does not show it, the Paramètres), a small window of glass at the
 * bottom right of the page shows it as the conversation does: the Éclipse of Moodix and the name of
 * the conversation, the take in progress (the Flux of the picture so far, « VIDÉO · LTX 2.5 », its
 * stage and its percentage, the line that fills). A click brings the user back to the conversation.
 * Ended while they are away, it says how (the take made, with its picture; a failure, in amber; a
 * cancellation) until they are back there, or close it (×). The dash folds it into a pill, which the
 * browser keeps; in the Paramètres it is that pill, in the foot of their window (`place`).
 *
 * app.js tells it the work (`begin`, `rename`, `answer`, `end`) and where it shows (`place`); the
 * cards of the conversation tell it the take (`take`, from generation-ui.mjs: start, progress,
 * image, done, failed, stopped). `open()` brings back to the conversation; `mark()` draws the
 * Éclipse of Moodix; `makeFlux` and `makePreview` draw the take (none in the tests).
 */
export const FOLDED_KEY = 'moodix.miniature';
const KINDS = { image: 'Image', video: 'Vidéo', audio: 'Son' };
// What « waiting » says when nothing else is said (waitFor).
const WAITING = 'En attente de votre accord';
/** « 42 % », as the message box says it. */
const percentOf = fraction => Math.floor(Math.min(1, Math.max(0, fraction)) * 100) + ' %';

export function setupMiniature({
  node,
  icon = () => null,
  mark = () => null,
  open = () => {},
  // « × »: whether the miniature may go (false keeps it), then what goes with it (0.6.87: without the
  // history, the conversation it leads back to can be found nowhere else).
  mayClose = () => true,
  onClosed = () => {},
  storage = globalThis.localStorage,
  makeFlux = takeFlux,
  makePreview = livePreview,
} = {}) {
  const root = node('aside', 'work-mini'),
    back = node('button', 'work-mini-back'),
    head = node('span', 'work-mini-head'),
    // The Éclipse of Moodix signs it (in 232 px, the word « MOODIX » left the name of the
    // conversation a few letters: measured 64 px at 1280 × 720).
    signature = node('span', 'work-mini-mark'),
    title = node('span', 'work-mini-title'),
    frame = node('span', 'work-mini-frame'),
    still = node('img', 'work-mini-still'),
    line = node('span', 'work-mini-line'),
    kind = node('span', 'work-mini-kind'),
    figure = node('span', 'work-mini-percent'),
    stage = node('span', 'work-mini-stage'),
    bar = node('span', 'work-mini-bar'),
    fill = node('span', 'work-mini-fill'),
    fold = node('button', 'work-mini-fold'),
    close = node('button', 'work-mini-close');
  root.hidden = true;
  root.setAttribute('aria-label', 'Miniature de la conversation en cours');
  back.type = fold.type = close.type = 'button';
  still.alt = '';
  still.decoding = 'async';
  still.hidden = true;
  const drawn = mark?.();
  if (drawn) signature.append(drawn);
  signature.setAttribute('aria-hidden', 'true');
  head.append(signature, title);
  frame.append(still);
  frame.setAttribute('aria-hidden', 'true');
  line.append(kind, figure);
  bar.append(fill);
  bar.setAttribute('aria-hidden', 'true');
  back.append(head, frame, line, stage, bar);
  // The chevron folds it (turned over once folded: it opens it again).
  for (const [button, glyph] of [
    [fold, 'chevron'],
    [close, 'close'],
  ]) {
    const drawnIcon = icon(glyph);
    if (drawnIcon) button.append(drawnIcon);
  }
  close.setAttribute('aria-label', 'Fermer la miniature');
  close.title = 'Fermer';
  close.hidden = true;
  root.append(back, fold, close);

  let work = null,
    // What it says: 'answer' (Moodix answers, no take in hand), 'waiting' (a card waits for the
    // user), 'making', then 'done', 'failed', 'stopped' or 'answered' (the turn over without a take).
    phase = 'answer',
    running = false,
    shown = false,
    words = 'Moodix répond…',
    // What 'waiting' says (0.6.88: Moodix AI may wait for the user in the Studio, see waitFor).
    waitingWords = WAITING,
    kindText = '',
    stageText = '',
    fraction = null,
    picture = '',
    // The address the still shows (`src` reads back as a whole address).
    stillAt = '',
    request = null,
    flux = null,
    live = null,
    // Somewhere to be put back when the Paramètres close (`place`).
    corner = null;
  let folded = false;
  try {
    folded = storage?.getItem?.(FOLDED_KEY) === 'pill';
  } catch {
    // Without the browser's storage: the card.
  }

  /** The Flux of the take in progress, in the frame, from the picture so far (as the card's). */
  function startFlux(asked) {
    stopFlux();
    flux = makeFlux?.(frame, { node }) ?? null;
    live = makePreview?.(node, frame, { onLoad: image => flux?.source(image) }) ?? null;
    const references = asked?.plan?.references ?? [],
      start = references.find(ref => ref.role === 'start_image' && ref.preview) ?? references.find(ref => ref.preview);
    if (start) flux?.source(start.preview);
    else flux?.neutral();
    flux?.visible(shown);
  }
  function stopFlux() {
    flux?.stop();
    live?.clear();
    flux = live = null;
  }
  function paint() {
    const making = phase === 'making' || phase === 'waiting',
      ended = ['done', 'failed', 'stopped', 'answered'].includes(phase),
      said =
        phase === 'answer'
          ? words
          : phase === 'waiting'
            ? waitingWords
            : phase === 'making'
              ? stageText
              : phase === 'done'
                ? stageText
                : phase === 'failed'
                  ? stageText
                  : phase === 'stopped'
                    ? 'Génération annulée'
                    : 'Moodix a répondu';
    title.textContent = work?.title || 'Nouvelle conversation';
    kind.textContent = phase === 'answer' || phase === 'answered' ? '' : kindText;
    figure.textContent = phase === 'making' && Number.isFinite(fraction) ? percentOf(fraction) : '';
    stage.textContent = said;
    fill.style?.setProperty?.('--mini-progress', String(Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0));
    root.dataset.phase = phase;
    root.classList.toggle('has-take', Boolean(kindText) && phase !== 'answer' && phase !== 'answered');
    root.classList.toggle('is-folded', folded);
    bar.hidden = !(phase === 'making' || phase === 'done');
    bar.classList.toggle('is-determinate', Number.isFinite(fraction));
    still.hidden = !picture || making;
    if (picture && stillAt !== picture) {
      stillAt = picture;
      still.src = picture;
    }
    // The × once the work is over: it stays until the user is back there, or closes it.
    close.hidden = running || !ended;
    const folding = folded ? 'Agrandir la miniature' : 'Réduire la miniature';
    fold.setAttribute('aria-label', folding);
    fold.setAttribute('aria-pressed', String(folded));
    fold.title = folded ? 'Agrandir' : 'Réduire';
    back.setAttribute(
      'aria-label',
      `Revenir à la conversation « ${title.textContent} » : ${[kind.textContent, said, figure.textContent].filter(Boolean).join(' · ')}`,
    );
  }
  back.onclick = () => open(work);
  fold.onclick = () => {
    folded = !folded;
    try {
      storage?.setItem?.(FOLDED_KEY, folded ? 'pill' : 'card');
    } catch {
      // Kept for this page only.
    }
    paint();
  };
  close.onclick = () => {
    const was = work;
    if (mayClose(was) === false) return;
    forget();
    onClosed(was);
  };

  /** The work of a conversation begins: what it says starts again. */
  function begin(given) {
    stopFlux();
    work = given ? { ...given } : null;
    phase = 'answer';
    running = Boolean(work);
    words = 'Moodix répond…';
    kindText = stageText = picture = '';
    fraction = null;
    request = null;
    paint();
  }
  /**
   * The take in hand, not begun, waits for the user somewhere else (0.6.88: Moodix AI in the Studio
   * of its conversation): `text` in place of « Préparation… », and no Flux. Its first progress makes
   * it again.
   */
  function waitFor(text) {
    if (!work || !running || !text || !['making', 'waiting'].includes(phase) || Number.isFinite(fraction)) return;
    if (phase === 'waiting' && waitingWords === text) return;
    stopFlux();
    phase = 'waiting';
    waitingWords = text;
    paint();
  }
  /** Moodix answers (no take in hand): what the line says (« Le modèle se charge… »). */
  function answer(text) {
    if (!work || !text) return;
    words = text;
    if (phase === 'answer') paint();
  }
  /** A card of the conversation says where its take is (generation-ui.mjs, `onLive`). */
  function take(event = {}) {
    if (!work || !running) return;
    const asked = event.request ?? request ?? {};
    if (event.type === 'start') {
      request = asked;
      waitingWords = WAITING;
      kindText = [KINDS[asked.mediaType] ?? KINDS.image, asked.workflowName].filter(Boolean).join(' · ');
      fraction = null;
      picture = '';
      stageText = 'Préparation…';
      // A video or a sound waits for the user on its card (or in the Studio); an image is made at once.
      phase = ['video', 'audio'].includes(asked.mediaType) && !asked.autoAllow ? 'waiting' : 'making';
      if (phase === 'making') startFlux(asked);
      else stopFlux();
    } else if (event.type === 'progress') {
      if (phase !== 'making') startFlux(asked);
      phase = 'making';
      stageText = event.text || stageText || 'Génération…';
      if (Number.isFinite(event.fraction)) {
        fraction = event.fraction;
        flux?.progress(fraction);
      }
      if (event.preview) live?.show(event.preview);
    } else if (event.type === 'image') {
      const output = event.record?.outputs?.[event.index ?? 0] ?? {};
      picture = output.thumbUrl || output.analysisDataUrl || (event.record?.mediaType === 'image' ? output.originalUrl : '') || picture;
      if (Number.isInteger(output.take)) work.take = output.take;
    } else if (event.type === 'done') {
      stopFlux();
      if (event.record || !event.failed) {
        const output = event.record?.outputs?.[0] ?? {};
        picture ||= output.thumbUrl || output.analysisDataUrl || (event.record?.mediaType === 'image' ? output.originalUrl : '') || '';
        const number = Number.isInteger(output.take) ? output.take : work.take;
        phase = 'done';
        fraction = 1;
        stageText = Number.isInteger(number) ? `Prise ${number} prête` : 'Prise prête';
      } else {
        phase = 'failed';
        stageText = 'Échec · ' + (event.error || 'la génération a échoué.');
      }
    } else if (event.type === 'failed') {
      stopFlux();
      phase = 'failed';
      stageText = 'Échec · ' + (event.message || 'la génération a échoué.');
    } else if (event.type === 'stopped') {
      stopFlux();
      phase = 'stopped';
    } else return;
    paint();
  }
  /** The work is over: its last state stays while the user is away (a turn without a take: answered). */
  function end() {
    if (!work) return;
    running = false;
    stopFlux();
    if (phase === 'answer') phase = 'answered';
    // Declined where it was shown (a card answered, a proposal refused): nothing is left to say.
    if (phase === 'waiting') phase = 'answered';
    paint();
  }
  /** Nothing to show any more: the user is back in the conversation, closed it, or it is gone. */
  function forget() {
    begin(null);
    place(null);
  }
  /**
   * Where it shows: `null` hidden, 'corner' at the bottom right of the page, or an element (the foot
   * of the Paramètres) where it goes as the pill. The Flux draws only while it is in sight.
   */
  function place(where) {
    const visible = Boolean(work && where);
    shown = visible;
    root.hidden = !visible;
    flux?.visible(visible);
    if (!visible) return;
    const inFoot = where !== 'corner';
    root.classList.toggle('is-foot', inFoot);
    if (inFoot && root.parentNode !== where) {
      corner ??= root.parentNode;
      where.prepend?.(root);
    } else if (!inFoot && corner && root.parentNode !== corner) corner.append(root);
    paint();
  }
  /** Another name for the conversation (the model named it, the user renamed it). */
  function rename(text) {
    if (!work || !text || work.title === text) return;
    work.title = text;
    paint();
  }
  return {
    element: root,
    begin,
    answer,
    waitFor,
    take,
    end,
    forget,
    place,
    rename,
    /** The work it shows: { conversationId, title, kind, take }, or null. */
    get work() {
      return work;
    },
    get running() {
      return running;
    },
    /** Whether it is about a take (in progress, waiting for the user, or ended), not words alone. */
    get taking() {
      return phase !== 'answer' && phase !== 'answered';
    },
    get phase() {
      return phase;
    },
    get folded() {
      return folded;
    },
  };
}
