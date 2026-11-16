/**
 * The player of a take opened (16/11, capture 33): none of the browser's controls. The round ▶ in
 * the middle of the picture (a click on the picture pauses it); at its foot, a fine line of progress
 * in the accent (a click or a drag goes there, the arrows of the keyboard too), the time in mono
 * (« 02.00 / 06.04 »), and the sound, on or off. A sound has the same bar, its ▶ at the left.
 */
const figures = value => {
  const seconds = Math.max(0, Number(value) || 0);
  if (seconds >= 60) return Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
  return (Math.floor(seconds * 100) / 100).toFixed(2).padStart(5, '0');
};
/** « 02.00 / 06.04 »: where the take is, and how long it lasts. */
export const playerTime = (current, total) => figures(current) + ' / ' + figures(total);

export function setupTakePlayer({ host, node }) {
  if (!host) return { attach() {}, detach() {} };
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
    sound = node('button', 'take-player-sound');
  play.type = sound.type = 'button';
  Object.assign(seek, { type: 'range', min: '0', max: '1000', step: '1', value: '0' });
  seek.setAttribute('aria-label', 'Position dans la prise');
  sound.append(symbol('sound'));
  bar.append(seek, time, sound);
  host.replaceChildren(play, bar);
  host.hidden = true;

  let media = null,
    seeking = false;
  const listeners = [];
  const on = (target, type, listener) => {
    target.addEventListener(type, listener);
    listeners.push([target, type, listener]);
  };
  function paint() {
    if (!media) return;
    const total = Number.isFinite(media.duration) ? media.duration : 0,
      share = total ? Math.min(1, media.currentTime / total) : 0;
    if (!seeking) seek.value = String(Math.round(share * 1000));
    seek.style?.setProperty?.('--progress', (share * 100).toFixed(2) + '%');
    seek.setAttribute('aria-valuetext', playerTime(media.currentTime, total));
    time.textContent = playerTime(media.currentTime, total);
    const playing = !media.paused && !media.ended;
    play.hidden = playing && !host.classList.contains('is-audio');
    play.classList.toggle('is-playing', playing);
    play.setAttribute('aria-label', playing ? 'Mettre en pause' : 'Lire');
    play.title = playing ? 'Mettre en pause' : 'Lire';
    sound.classList.toggle('is-muted', Boolean(media.muted));
    sound.setAttribute('aria-pressed', String(Boolean(media.muted)));
    sound.setAttribute('aria-label', media.muted ? 'Remettre le son' : 'Couper le son');
    sound.title = media.muted ? 'Remettre le son' : 'Couper le son';
  }
  const toggle = () => {
    if (!media) return;
    if (media.paused || media.ended) void media.play?.()?.catch?.(() => {});
    else media.pause();
  };
  play.onclick = toggle;
  sound.onclick = () => {
    if (!media) return;
    media.muted = !media.muted;
    paint();
  };
  seek.oninput = () => {
    if (!media || !Number.isFinite(media.duration)) return;
    seeking = true;
    media.currentTime = (Number(seek.value) / 1000) * media.duration;
    paint();
  };
  seek.onchange = () => {
    seeking = false;
    paint();
  };

  return {
    /** Plays `element` (the video or the sound of the take opened) with these controls. */
    attach(element, { audio = false } = {}) {
      this.detach();
      media = element;
      element.controls = false;
      element.removeAttribute?.('controls');
      host.classList.toggle('is-audio', audio);
      host.hidden = false;
      for (const type of ['timeupdate', 'durationchange', 'loadedmetadata', 'play', 'pause', 'ended', 'volumechange'])
        on(element, type, paint);
      // A click on the picture plays it, or pauses it.
      if (!audio) on(element, 'click', toggle);
      paint();
    },
    /** The take closed or another opened: nothing plays any more. */
    detach() {
      for (const [target, type, listener] of listeners.splice(0)) target.removeEventListener?.(type, listener);
      media = null;
      seeking = false;
      seek.value = '0';
      seek.style?.setProperty?.('--progress', '0%');
      time.textContent = playerTime(0, 0);
      host.hidden = true;
    },
  };
}
