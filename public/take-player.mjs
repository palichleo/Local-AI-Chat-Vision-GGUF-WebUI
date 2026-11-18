/**
 * The player of a take opened (16/11, capture 33): none of the browser's controls. The round ▶ in
 * the middle of the picture (a click on the picture pauses it); at its foot, a fine line of progress
 * in the accent (a click or a drag goes there, the arrows of the keyboard too), the time in mono
 * (« 02.00 / 06.04 »), and the sound, on or off. A sound has the same bar, its ▶ at the left.
 *
 * (0.6.97) The only player of a clip on the page: the user wants none of the browser's anywhere
 * (« le nôtre est tellement meilleur »). A card of the chat, the screen of the Studio and a video
 * joined to a message play with this one too (`clipPlayer`), with « Voir en grand » at the end of
 * its bar: the take in its window, which is the large view (there is no full screen; the window of
 * a take has none either). What its size leaves room for is in moodix.css: narrow, the time and the
 * buttons go over the line; tiny, the ▶ and the line alone. With the keyboard: the ▶ (Entrée,
 * Espace), which stays in the hand while the clip plays, as « pause »; on the line ← → a second,
 * Page ↑ ↓ a tenth, Début and Fin, and Espace plays or pauses; the sound; « Voir en grand ».
 */
const figures = value => {
  const seconds = Math.max(0, Number(value) || 0);
  if (seconds >= 60) return Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
  return (Math.floor(seconds * 100) / 100).toFixed(2).padStart(5, '0');
};
/** « 02.00 / 06.04 »: where the take is, and how long it lasts. */
export const playerTime = (current, total) => figures(current) + ' / ' + figures(total);
/** How far ← and → go in a clip, in seconds. */
export const STEP = 1;

/**
 * What would bring the browser's player back to a video, taken away (0.6.97): its controls, the
 * picture-in-picture and the casting it offers by itself. Its menu (a right click) is refused where
 * the video is shown: its « Afficher les commandes » showed them.
 */
function quiet(element) {
  element.removeAttribute?.('controls');
  element.controls = false;
  element.disablePictureInPicture = true;
  element.disableRemotePlayback = true;
  element.setAttribute?.('controlslist', 'nodownload nofullscreen noremoteplayback');
}
const noMenu = event => event?.preventDefault?.();
/** A clip shown as its first picture only (a tile of the Pellicule, a take cited): never a player of the browser. */
export function stillClip(video) {
  quiet(video);
  video.addEventListener?.('contextmenu', noMenu);
  return video;
}

/**
 * `onExpand`: « Voir en grand » at the end of the bar (a card: the take in its window). `label`:
 * the name of the player for a screen reader (« Lecteur · PRISE 12 »); `what`: what its line is
 * the position in (« la prise », « la vidéo »).
 */
export function setupTakePlayer({ host, node, onExpand = null, label = '', what = 'la prise' }) {
  if (!host) return { attach() {}, detach() {}, toggle: () => false, element: null };
  const symbol = name => {
    const page = globalThis.document;
    if (!page?.createElementNS) return node('span', 'take-player-icon');
    const svg = page.createElementNS('http://www.w3.org/2000/svg', 'svg'),
      use = page.createElementNS('http://www.w3.org/2000/svg', 'use');
    svg.setAttribute('aria-hidden', 'true');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  };
  const play = node('button', 'take-play take-player-play'),
    bar = node('div', 'take-player-bar'),
    seek = node('input', 'take-player-seek'),
    time = node('span', 'take-player-time', playerTime(0, 0)),
    sound = node('button', 'take-player-sound'),
    expand = onExpand ? node('button', 'take-player-expand') : null;
  play.type = sound.type = 'button';
  Object.assign(seek, { type: 'range', min: '0', max: '1000', step: '1', value: '0' });
  seek.setAttribute('aria-label', 'Position dans ' + what);
  sound.append(symbol('sound'));
  bar.append(seek, time, sound);
  if (expand) {
    expand.type = 'button';
    expand.append(symbol('act-open'));
    expand.setAttribute('aria-label', 'Voir en grand');
    expand.title = 'Voir en grand : la prise dans sa fenêtre, avec ses détails';
    bar.append(expand);
    host.classList.add('has-expand');
  }
  host.replaceChildren(play, bar);
  host.setAttribute?.('role', 'group');
  if (label) host.setAttribute?.('aria-label', label);
  host.hidden = true;

  let media = null,
    audio = false,
    // The length its record gives, until the file says its own (a card reads it once played).
    known = 0,
    // A place chosen on the line before the file was read: gone to once it is.
    wanted = null,
    seeking = false;
  const listeners = [];
  const on = (target, type, listener) => {
    target.addEventListener?.(type, listener);
    listeners.push([target, type, listener]);
  };
  const length = () => (Number.isFinite(media?.duration) && media.duration > 0 ? media.duration : known);
  function paint() {
    if (!media) return;
    const total = length(),
      at = wanted === null ? media.currentTime : wanted * total,
      share = total ? Math.min(1, at / total) : 0,
      said = playerTime(at, total),
      playing = media.paused === false && !media.ended;
    if (!seeking) seek.value = String(Math.round(share * 1000));
    seek.style?.setProperty?.('--progress', (share * 100).toFixed(2) + '%');
    seek.setAttribute('aria-valuetext', said);
    time.textContent = said;
    // While a clip plays its ▶ is out of sight, not out of the hand (moodix.css): the keyboard finds it
    // there, as « pause ». (Hidden, it lost the focus, and nothing paused the clip any more.)
    host.classList.toggle('is-playing', playing);
    play.classList.toggle('is-playing', playing);
    play.setAttribute('aria-label', playing ? 'Mettre en pause' : 'Lire');
    play.title = playing ? 'Mettre en pause' : 'Lire';
    sound.classList.toggle('is-muted', Boolean(media.muted));
    sound.setAttribute('aria-pressed', String(Boolean(media.muted)));
    sound.setAttribute('aria-label', media.muted ? 'Remettre le son' : 'Couper le son');
    sound.title = media.muted ? 'Remettre le son' : 'Couper le son';
  }
  /** Plays what is shown, or pauses it; false with nothing to play. */
  const toggle = () => {
    if (!media) return false;
    if (media.paused !== false || media.ended) void media.play?.()?.catch?.(() => {});
    else media.pause();
    return true;
  };
  play.onclick = toggle;
  sound.onclick = () => {
    if (!media) return;
    media.muted = !media.muted;
    paint();
  };
  seek.oninput = () => {
    if (!media) return;
    seeking = true;
    const share = Number(seek.value) / 1000;
    if (Number.isFinite(media.duration) && media.duration > 0) media.currentTime = share * media.duration;
    else if (known && !media.readyState) {
      // Not read yet (a card reads its clip once played): read now, then there.
      wanted = share;
      media.preload = 'metadata';
      media.load?.();
    }
    paint();
  };
  seek.onchange = () => {
    seeking = false;
    paint();
  };
  const arrive = () => {
    if (wanted !== null && Number.isFinite(media?.duration)) media.currentTime = wanted * media.duration;
    wanted = null;
    paint();
  };
  if (expand)
    expand.onclick = () => {
      // The clip goes on in its window, not here as well.
      if (media?.paused === false) media.pause();
      onExpand();
    };
  // On the line, ← → go a second back or on (by its own steps, a thousandth of the clip, nothing
  // showed), the space plays or pauses as the ▶ does. Page ↑ ↓, Début and Fin are the line's own.
  host.addEventListener?.('keydown', event => {
    if (!media || event.target !== seek || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === ' ') {
      event.preventDefault();
      toggle();
      return;
    }
    const by = { ArrowLeft: -STEP, ArrowDown: -STEP, ArrowRight: STEP, ArrowUp: STEP }[event.key];
    if (!by || !(Number.isFinite(media.duration) && media.duration > 0)) return;
    event.preventDefault();
    media.currentTime = Math.min(media.duration, Math.max(0, media.currentTime + by));
    paint();
  });

  return {
    /** Where these controls are: over the clip, in the box that holds it. */
    element: host,
    toggle,
    /**
     * Plays `element` (the video or the sound of the take opened) with these controls. `length`: its
     * length in seconds as its record says it, shown until its file is read.
     */
    attach(element, { audio: sounding = false, length: given = 0 } = {}) {
      this.detach();
      media = element;
      audio = sounding;
      known = Number(given) > 0 ? Number(given) : 0;
      quiet(element);
      host.classList.toggle('is-audio', audio);
      host.hidden = false;
      for (const type of ['timeupdate', 'durationchange', 'play', 'pause', 'ended', 'volumechange', 'emptied'])
        on(element, type, paint);
      on(element, 'loadedmetadata', arrive);
      // A click on the picture plays it, or pauses it.
      if (!audio) on(element, 'click', toggle);
      on(element, 'contextmenu', noMenu);
      paint();
    },
    /** The take closed or another opened: nothing plays any more. */
    detach() {
      for (const [target, type, listener] of listeners.splice(0)) target.removeEventListener?.(type, listener);
      media = null;
      known = 0;
      wanted = null;
      seeking = false;
      seek.value = '0';
      seek.style?.setProperty?.('--progress', '0%');
      time.textContent = playerTime(0, 0);
      host.classList.remove('is-playing');
      play.classList.remove('is-playing');
      play.setAttribute('aria-label', 'Lire');
      play.title = 'Lire';
      host.hidden = true;
    },
  };
}

/**
 * A clip shown anywhere but in the window of a take (a card of the chat, the screen of the Studio, a
 * video joined to a message): the same player over it, `player.element` set beside the video in the
 * box that holds them (positioned). `length`: its length as its record says it.
 */
export function clipPlayer({ node, video, onExpand = null, label = '', what = 'la prise', length = 0 }) {
  const player = setupTakePlayer({ host: node('div', 'take-player'), node, onExpand, label, what });
  player.attach(video, { length });
  return player;
}
