import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { STEP, clipPlayer, playerTime, setupTakePlayer, stillClip } from '../public/take-player.mjs';

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
  fire(type, event = {}) {
    for (const listener of [...(this.listeners[type] ?? [])]) listener({ type, ...event });
  }
}
const node = (...args) => new Element(...args);
/** A key pressed on an element of the player (its keydown reaches the player, as in a page). */
const press = (host, target, key) => {
  let prevented = false;
  host.fire('keydown', { key, target, preventDefault: () => (prevented = true) });
  return prevented;
};

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
    readyState: 4,
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
  assert.equal(bar.children.length, 3, 'in the window of a take, no « Voir en grand »: it is the large view');
  player.attach(video);
  assert.equal(host.hidden, false);
  assert.equal(video.controls, false);
  assert.equal(video.attributes.controls, undefined);
  assert.equal(time.textContent, '00.00 / 06.04');
  assert.equal(play.hidden, false);
  assert.equal(play.attributes['aria-label'], 'Lire');
  // ▶: it plays, the ▶ goes out of sight (moodix.css) but stays in the hand, as « pause »; a click on
  // the picture pauses it.
  play.onclick();
  assert.equal(video.paused, false);
  assert.equal(host.classList.contains('is-playing'), true);
  assert.equal(play.hidden, false, 'not hidden: the keyboard would lose it, and nothing would pause the clip');
  assert.equal(play.attributes['aria-label'], 'Mettre en pause');
  video.currentTime = 2;
  video.fire('timeupdate');
  assert.equal(time.textContent, '02.00 / 06.04');
  assert.equal(seek.value, String(Math.round((2 / 6.04) * 1000)));
  assert.equal(seek.style.values['--progress'], ((2 / 6.04) * 100).toFixed(2) + '%');
  video.fire('click');
  assert.equal(video.paused, true);
  assert.equal(host.classList.contains('is-playing'), false);
  assert.equal(play.attributes['aria-label'], 'Lire');
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

// (0.6.97) The only player of a clip on the page: a card of the chat, the screen of the Studio, a
// video joined to a message.
test('a clip anywhere else plays with the same player, « Voir en grand » at the end of its bar: the clip pauses, its window opens', () => {
  const video = clip(),
    opened = [],
    player = clipPlayer({ node, video, onExpand: () => opened.push(video.currentTime), label: 'Lecteur · PRISE 12' }),
    host = player.element,
    [play, bar] = host.children,
    [seek, time, sound, expand] = bar.children;
  assert.equal(host.classList.contains('take-player'), true);
  assert.equal(host.classList.contains('has-expand'), true, 'moodix.css: the narrow layout of a bar with it');
  assert.deepEqual([host.attributes.role, host.attributes['aria-label']], ['group', 'Lecteur · PRISE 12']);
  assert.equal(host.hidden, false);
  assert.equal(video.controls, false);
  assert.deepEqual([seek.attributes['aria-label'], time.textContent, sound.attributes['aria-label']], ['Position dans la prise', '00.00 / 06.04', 'Couper le son']);
  assert.equal(expand.attributes['aria-label'], 'Voir en grand');
  assert.match(expand.title, /la prise dans sa fenêtre/);
  play.onclick();
  video.currentTime = 1.5;
  expand.onclick();
  assert.equal(video.paused, true, 'it goes on in its window, not here as well');
  assert.deepEqual(opened, [1.5]);
  // A video joined to a message: the position « dans la vidéo », no window of a take to open.
  const joined = clipPlayer({ node, video: clip(), what: 'la vidéo' });
  assert.equal(joined.element.children[1].children.length, 3);
  assert.equal(joined.element.children[1].children[0].attributes['aria-label'], 'Position dans la vidéo');
});

test('nothing brings the browser’s player back: no controls, no picture-in-picture, no casting, no menu of its own', () => {
  const video = clip(),
    player = setupTakePlayer({ host: new Element('div', 'take-player'), node });
  player.attach(video);
  assert.equal(video.controls, false);
  assert.equal(video.attributes.controls, undefined);
  assert.equal(video.disablePictureInPicture, true);
  assert.equal(video.disableRemotePlayback, true);
  assert.equal(video.attributes.controlslist, 'nodownload nofullscreen noremoteplayback');
  // Its menu (a right click) offered « Afficher les commandes ».
  let refused = false;
  video.fire('contextmenu', { preventDefault: () => (refused = true) });
  assert.equal(refused, true);
  // A clip shown as its first picture (a tile of the Pellicule, a take cited): the same.
  const still = stillClip(clip());
  assert.equal(still.controls, false);
  assert.equal(still.disablePictureInPicture, true);
  refused = false;
  still.fire('contextmenu', { preventDefault: () => (refused = true) });
  assert.equal(refused, true);
});

test('with the keyboard: the ▶ is « pause » while the clip plays; on the line ← → a second, the space plays or pauses', () => {
  const video = clip(),
    host = new Element('div', 'take-player'),
    player = setupTakePlayer({ host, node });
  player.attach(video);
  const [play, bar] = host.children,
    [seek, time] = bar.children;
  assert.equal(STEP, 1);
  // The space on the line: it plays, then pauses (and the page does not scroll).
  assert.equal(press(host, seek, ' '), true);
  assert.equal(video.paused, false);
  assert.equal(play.attributes['aria-label'], 'Mettre en pause');
  assert.equal(press(host, seek, ' '), true);
  assert.equal(video.paused, true);
  // → → ←: a second each, the time said at once; never past the end nor before the start.
  press(host, seek, 'ArrowRight');
  press(host, seek, 'ArrowRight');
  assert.equal(video.currentTime, 2);
  assert.equal(time.textContent, '02.00 / 06.04');
  assert.equal(press(host, seek, 'ArrowLeft'), true);
  assert.equal(video.currentTime, 1);
  for (let index = 0; index < 9; index++) press(host, seek, 'ArrowUp');
  assert.equal(video.currentTime, 6.04);
  for (let index = 0; index < 9; index++) press(host, seek, 'ArrowDown');
  assert.equal(video.currentTime, 0);
  // Page ↑ ↓, Début and Fin are the line's own; a key on another control is that control's.
  assert.equal(press(host, seek, 'PageUp'), false);
  assert.equal(press(host, play, ' '), false);
  assert.equal(press(host, seek, 'ArrowRight'), true);
  // The take window keeps the toggle for its own space (assets-ui.mjs): false with nothing shown.
  assert.equal(player.toggle(), true);
  player.detach();
  assert.equal(player.toggle(), false);
  assert.equal(host.classList.contains('is-playing'), false);
});

test('a card reads its clip once played: its length from its record meanwhile, a place chosen on its line gone to once read', () => {
  const video = clip();
  Object.assign(video, { duration: NaN, readyState: 0, preload: 'none' });
  let loads = 0;
  video.load = () => loads++;
  const player = clipPlayer({ node, video, length: 24.708 }),
    [, bar] = player.element.children,
    [seek, time] = bar.children;
  assert.equal(time.textContent, '00.00 / 24.70', 'its record says its length');
  // Its middle chosen before it was read: read now, there once it is.
  seek.value = '500';
  seek.oninput();
  assert.equal(loads, 1);
  assert.equal(video.preload, 'metadata');
  assert.equal(time.textContent, '12.35 / 24.70');
  seek.onchange();
  Object.assign(video, { duration: 24.7, readyState: 1 });
  video.fire('loadedmetadata');
  assert.equal(video.currentTime, 12.35);
  assert.equal(time.textContent, '12.35 / 24.70');
  // The file gone (the card out of sight), the record's length again.
  Object.assign(video, { duration: NaN, currentTime: 0 });
  video.fire('emptied');
  assert.equal(time.textContent, '00.00 / 24.70');
});

test('no video of the page shows the browser’s controls; the sounds alone keep theirs (0.6.97)', async () => {
  const folder = new URL('../public/', import.meta.url),
    names = (await readdir(folder)).filter(name => /\.(mjs|js|html)$/.test(name)),
    given = [];
  for (const name of names) {
    const source = (await readFile(new URL(name, folder), 'utf8')).replace(/\r\n/g, '\n');
    // Every place a control of the browser is given: `x.controls = …`, `controls: …`, the attribute.
    for (const match of source.matchAll(
      /\.controls\s*=(?![=\s]*false\b)[^;\n]+|(?<![\w-])controls\s*:(?!\s*false\b)[^,}\n]+|(?:set|toggle)Attribute\(\s*['"]controls['"]|<(?:video|audio)\b[^>]*\scontrols\b/g,
    )) {
      // To what: the element made last before it (node('audio'), createElement('video')…), or the tag.
      const made = [...source.slice(Math.max(0, match.index - 800), match.index).matchAll(/(?:\bnode|createElement)\(([^)]*)\)/g)].at(-1)?.[1] ?? '',
        sound = match[0].startsWith('<') ? match[0].startsWith('<audio') : /['"]audio['"]/.test(made) && !/['"]video['"]/.test(made);
      if (!sound) given.push(`${name}:${source.slice(0, match.index).split('\n').length} ${match[0].trim()}`);
    }
  }
  assert.deepEqual(given, [], 'a video plays with the player of a take (take-player.mjs), never the browser’s');
});
