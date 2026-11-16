import assert from 'node:assert/strict';
import test from 'node:test';
import { playerTime, setupTakePlayer } from '../public/take-player.mjs';

// The player of a take opened (16/11, capture 33): none of the browser's controls.
class Element {
  constructor(tag = 'div', className = '', text = '') {
    const classes = new Set(String(className).split(' ').filter(Boolean));
    Object.assign(this, { tag, textContent: text, children: [], attributes: {}, listeners: {}, hidden: false });
    this.classList = {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
    };
    this.style = {
      values: {},
      setProperty(name, value) {
        this.values[name] = value;
      },
    };
  }
  append(...items) {
    this.children.push(...items);
  }
  replaceChildren(...items) {
    this.children = [...items];
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  removeEventListener(type, listener) {
    this.listeners[type] = (this.listeners[type] ?? []).filter(item => item !== listener);
  }
  fire(type) {
    for (const listener of [...(this.listeners[type] ?? [])]) listener({ type });
  }
}
const node = (...args) => new Element(...args);

/** A video as the page has one: its time, its length, paused or not, its sound. */
function clip() {
  const video = new Element('video');
  Object.assign(video, {
    controls: true,
    attributes: { controls: '' },
    paused: true,
    ended: false,
    muted: false,
    duration: 6.04,
    currentTime: 0,
    play() {
      this.paused = false;
      this.fire('play');
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
      this.fire('pause');
    },
  });
  return video;
}

test('the time in mono: « 02.00 / 06.04 », past a minute « 1:05 »', () => {
  assert.equal(playerTime(2, 6.04), '02.00 / 06.04');
  assert.equal(playerTime(0, 0), '00.00 / 00.00');
  assert.equal(playerTime(65.3, 105), '1:05 / 1:45');
});

test('a clip plays with the round ▶, its line of progress, its time and its sound; never the browser’s controls', () => {
  const host = new Element('div', 'take-player'),
    player = setupTakePlayer({ host, node }),
    video = clip();
  const [play, bar] = host.children,
    [seek, time, sound] = bar.children;
  assert.equal(host.hidden, true, 'nothing until a take is opened');
  player.attach(video);
  assert.equal(host.hidden, false);
  assert.equal(video.controls, false);
  assert.equal(video.attributes.controls, undefined);
  assert.equal(time.textContent, '00.00 / 06.04');
  assert.equal(play.hidden, false);
  assert.equal(play.attributes['aria-label'], 'Lire');
  // ▶: it plays, the ▶ goes; a click on the picture pauses it.
  play.onclick();
  assert.equal(video.paused, false);
  assert.equal(play.hidden, true);
  video.currentTime = 2;
  video.fire('timeupdate');
  assert.equal(time.textContent, '02.00 / 06.04');
  assert.equal(seek.value, String(Math.round((2 / 6.04) * 1000)));
  assert.equal(seek.style.values['--progress'], ((2 / 6.04) * 100).toFixed(2) + '%');
  video.fire('click');
  assert.equal(video.paused, true);
  assert.equal(play.hidden, false);
  // The line: a place chosen in it.
  seek.value = '500';
  seek.oninput();
  assert.equal(video.currentTime, 3.02);
  seek.onchange();
  // The sound, off then on.
  sound.onclick();
  assert.equal(video.muted, true);
  assert.equal(sound.attributes['aria-label'], 'Remettre le son');
  sound.onclick();
  assert.equal(video.muted, false);
  // Another take, or the window closed: it lets this one go.
  player.detach();
  assert.equal(host.hidden, true);
  assert.equal(time.textContent, '00.00 / 00.00');
  video.currentTime = 4;
  video.fire('timeupdate');
  assert.equal(time.textContent, '00.00 / 00.00');
});

test('a sound has the same bar, its ▶ staying at the left while it plays', () => {
  const host = new Element('div', 'take-player'),
    player = setupTakePlayer({ host, node }),
    sound = clip();
  player.attach(sound, { audio: true });
  assert.equal(host.classList.contains('is-audio'), true);
  const [play] = host.children;
  play.onclick();
  assert.equal(play.hidden, false);
  assert.equal(play.attributes['aria-label'], 'Mettre en pause');
  play.onclick();
  assert.equal(sound.paused, true);
});
