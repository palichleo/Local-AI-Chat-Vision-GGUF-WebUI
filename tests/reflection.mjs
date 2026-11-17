import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { paragraphs, reflection, thoughtTime } from '../public/reflection.mjs';
import { History } from '../lib/history.mjs';

// The reflection of Moodix in a message (claude_design/maquettes/reflexion-maquette.md, 58 to 61).
class Element {
  constructor(tag = '', className = '', text = '') {
    Object.assign(this, { tag, className, textContent: text, children: [], attributes: {}, style: {}, hidden: false });
  }
  append(...items) {
    this.children.push(...items);
  }
  replaceChildren(...items) {
    this.children = items;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
}
const node = (...args) => new Element(...args);
/** A reflection with a clock of its own: `clock.at` in ms, `clock.tick()` the second that passes. */
function setup({ animated = false, still = false, height = 0 } = {}) {
  const clock = { at: 0, run: null, stopped: 0 },
    changes = [];
  const thought = reflection({
    node,
    now: () => clock.at,
    every: run => {
      clock.run = run;
      return () => {
        clock.run = null;
        clock.stopped++;
      };
    },
    still: () => still,
    onChange: () => changes.push(true),
  });
  const moves = [];
  if (animated) {
    thought.element.getBoundingClientRect = () => ({ height: 63 });
    thought.element.animate = (frames, options) => {
      const move = { frames, options, cancel() {} };
      moves.push(move);
      return move;
    };
  }
  thought.content.scrollHeight = height;
  const [, word, time] = thought.label.children,
    [pane, more] = thought.element.children;
  return { thought, clock, moves, changes, word, time, pane, more };
}

test('its time: « 3 S » under a minute, « 1:12 » past it; while it counts, « 0:04 »', () => {
  assert.equal(thoughtTime(3), '3 S');
  assert.equal(thoughtTime(0.2), '1 S', 'never « 0 S »');
  assert.equal(thoughtTime(59.4), '59 S');
  assert.equal(thoughtTime(72), '1:12');
  assert.equal(thoughtTime(60), '1:00');
  assert.equal(thoughtTime(4, true), '0:04');
  assert.equal(thoughtTime(0, true), '0:00');
  assert.equal(thoughtTime(125, true), '2:05');
  // A paragraph per line of the model, never an empty one.
  assert.deepEqual(paragraphs('Un.\n\n\nDeux.\n  \nTrois.  '), ['Un.', 'Deux.', 'Trois.']);
  assert.deepEqual(paragraphs(''), []);
});

test('its label: « · RÉFLEXION 3 S » as a button, neither icon nor chevron; none without a reflection', () => {
  const { thought, word, time } = setup();
  assert.equal(thought.label.tag, 'button');
  assert.equal(thought.label.type, 'button');
  assert.deepEqual(
    thought.label.children.map(part => [part.tag, part.className, part.textContent]),
    [
      ['span', 'reasoning-dot', '·'],
      ['span', 'reasoning-word', 'Réflexion'],
      ['span', 'reasoning-time', ''],
    ],
  );
  assert.equal(word.textContent, 'Réflexion');
  assert.equal(time.textContent, '');
  // Thinking off, or a model that has none: nothing on the line of the signature.
  assert.equal(thought.label.hidden, true);
  assert.equal(thought.element.hidden, true);
  thought.show('', false);
  assert.equal(thought.label.hidden, true);
  assert.equal(thought.state(), 'none');
  thought.end();
  assert.equal(thought.seconds(), null);
});

test('while Moodix thinks it is open and counts its time; it folds by itself when the answer begins', () => {
  const { thought, clock, time, moves } = setup({ animated: true });
  thought.show('L’utilisateur demande un plan.', false);
  assert.equal(thought.state(), 'live');
  assert.equal(thought.element.attributes['data-state'], 'live');
  assert.equal(thought.label.attributes['aria-expanded'], 'true');
  assert.deepEqual([thought.label.hidden, thought.element.hidden], [false, false]);
  assert.equal(time.textContent, '0:00');
  clock.at = 4000;
  clock.run();
  assert.equal(time.textContent, '0:04');
  // Written as it comes, a paragraph per line.
  thought.show('L’utilisateur demande un plan.\n\nUn scénario simple.', false);
  assert.deepEqual(thought.content.children.map(part => [part.tag, part.textContent]), [
    ['p', 'L’utilisateur demande un plan.'],
    ['p', 'Un scénario simple.'],
  ]);
  // A click does not fold it while it is written.
  thought.label.onclick();
  assert.equal(thought.state(), 'live');
  // The answer begins, 3.4 s after its first thought: its time is said, and it folds in 200 ms.
  clock.at = 3400;
  thought.show('L’utilisateur demande un plan.\n\nUn scénario simple.', true);
  assert.equal(time.textContent, '3 S');
  assert.equal(thought.seconds(), 3);
  assert.equal(clock.stopped, 1, 'it counts no more');
  assert.equal(moves.length, 1);
  assert.deepEqual(moves[0].frames.map(frame => frame.height), ['63px', '0px']);
  assert.equal(moves[0].options.duration, 200);
  assert.equal(thought.element.hidden, false, 'still there while it folds');
  // The words of the answer keep coming while it folds (each one shows the reflection again, the
  // turn ends): the fold begun goes to its end, it does not start over at each of them.
  let cancelled = 0;
  moves[0].cancel = () => cancelled++;
  thought.show('L’utilisateur demande un plan.\n\nUn scénario simple.', true);
  thought.show('L’utilisateur demande un plan.\n\nUn scénario simple.', true);
  thought.end();
  assert.equal(moves.length, 1, 'one fold');
  assert.equal(cancelled, 0);
  moves[0].onfinish();
  assert.equal(thought.element.hidden, true);
  assert.equal(thought.state(), 'closed');
  assert.equal(thought.label.attributes['aria-expanded'], 'false');
  assert.equal(thought.label.hidden, false, 'only the label stays');
  // What comes after changes nothing of its time.
  clock.at = 9000;
  thought.show('L’utilisateur demande un plan.\n\nUn scénario simple.', true);
  thought.end();
  assert.equal(thought.seconds(), 3);
});

test('a click opens it and folds it back; past eight lines its foot fades, « Tout lire » then « Réduire »', () => {
  const { thought, more, changes } = setup({ height: 120 });
  thought.restore('Une pensée.\nUne autre.', 3);
  assert.equal(thought.state(), 'closed');
  thought.label.onclick();
  assert.equal(thought.state(), 'open');
  assert.deepEqual([thought.element.hidden, thought.label.attributes['aria-expanded']], [false, 'true']);
  // Eight lines or less: whole, no button.
  assert.equal(more.hidden, true);
  assert.equal('data-long' in thought.element.attributes, false);
  thought.label.onclick();
  assert.deepEqual([thought.state(), thought.element.hidden], ['closed', true]);
  // Longer than eight lines (168 px).
  thought.content.scrollHeight = 420;
  thought.label.onclick();
  assert.equal('data-long' in thought.element.attributes, true);
  assert.equal('data-whole' in thought.element.attributes, false);
  assert.deepEqual([more.hidden, more.textContent], [false, 'Tout lire']);
  const before = changes.length;
  more.onclick();
  assert.equal('data-whole' in thought.element.attributes, true);
  assert.equal(more.textContent, 'Réduire');
  assert.equal(changes.length, before + 1, 'the page follows its new height');
  more.onclick();
  assert.equal('data-whole' in thought.element.attributes, false);
  assert.equal(more.textContent, 'Tout lire');
  // Folded and opened again: eight lines again.
  more.onclick();
  thought.label.onclick();
  thought.label.onclick();
  assert.equal('data-whole' in thought.element.attributes, false);
});

test('read back from a conversation it is folded, with its time when it was kept; a silent step shows none', () => {
  const { thought, time, clock } = setup();
  thought.restore('Une pensée.', 72);
  assert.deepEqual([thought.label.hidden, thought.element.hidden, thought.state()], [false, true, 'closed']);
  assert.equal(time.textContent, '1:12');
  assert.equal(clock.run, null, 'nothing counts');
  // An older conversation did not keep its time: the label alone.
  thought.restore('Une pensée.');
  assert.equal(time.textContent, '');
  assert.equal(thought.seconds(), null);
  // No reflection kept: no label.
  thought.restore('');
  assert.deepEqual([thought.label.hidden, thought.state()], [true, 'none']);
  const silent = setup();
  silent.thought.show('Je regarde.', false);
  silent.thought.hide();
  assert.deepEqual([silent.thought.label.hidden, silent.thought.element.hidden, silent.clock.run], [true, true, null]);
});

test('a turn stopped while Moodix thinks: its reflection ends with the time it took; with less motion it folds at once', () => {
  const { thought, clock, time, moves } = setup({ animated: true, still: true });
  thought.show('Je réfléchis.', false);
  clock.at = 65000;
  thought.end();
  assert.equal(time.textContent, '1:05');
  assert.equal(moves.length, 0, 'no fold drawn');
  assert.deepEqual([thought.state(), thought.element.hidden], ['closed', true]);
});

test('a second click while it folds back changes nothing; read back during a fold, it is simply folded', () => {
  const { thought, moves } = setup({ animated: true });
  thought.restore('Une pensée.', 3);
  thought.label.onclick();
  moves[0].onfinish();
  assert.equal(thought.state(), 'open');
  thought.label.onclick();
  assert.equal(moves.length, 2, 'it folds back');
  thought.label.onclick();
  thought.label.onclick();
  assert.equal(moves.length, 2, 'the fold begun goes to its end');
  assert.equal(thought.state(), 'open', 'open until that fold is over');
  // The conversation is read again meanwhile: folded, nothing left of the move, and it opens again.
  let cancelled = 0;
  moves[1].cancel = () => cancelled++;
  thought.restore('Une pensée.', 3);
  assert.equal(cancelled, 1);
  assert.deepEqual([thought.state(), thought.element.hidden], ['closed', true]);
  thought.label.onclick();
  assert.equal(thought.state(), 'open');
  assert.equal(moves.length, 3);
});

test('a conversation keeps how long Moodix thought, and its words over the card of a video', async t => {
  const root = await mkdtemp(join(tmpdir(), 'atelier-reflection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const history = new History(join(root, 'history')),
    id = randomUUID();
  await history.save({
    id,
    messages: [
    { role: 'user', content: 'une vidéo' },
    {
      role: 'assistant',
      content: 'Voici ce que je propose.',
      reasoning_content: 'Une vidéo.',
      reasoning_seconds: 3.4,
      planned: true,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'create_video', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: '{"status":"denied"}' },
    // Nothing kept of what is not a time, nor on a message that is not Moodix's.
    { role: 'user', content: 'non', planned: true, reasoning_seconds: 9 },
    { role: 'assistant', content: 'D’accord.', reasoning_seconds: 'vite', planned: 'oui' },
    ],
  });
  const kept = (await history.read(id)).messages;
  assert.deepEqual([kept[1].reasoning_seconds, kept[1].planned], [3, true]);
  assert.deepEqual([kept[3].reasoning_seconds, kept[3].planned], [undefined, undefined]);
  assert.deepEqual([kept[4].reasoning_seconds, kept[4].planned], [undefined, undefined]);
});

test('the reflection as its mock-up draws it: the writing of « MOODIX », the margin of the answer, three lines, eight lines', async () => {
  const read = async name => (await readFile(new URL('../public/' + name, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const css = await read('moodix.css'),
    rule = selector => {
      const at = css.lastIndexOf('\n' + selector + ' {\n');
      assert.ok(at >= 0, selector);
      return css.slice(at, css.indexOf('\n}\n', at));
    };
  // The label: Jost 500, 10.5 px, capitals spaced .3em, a line of 22 px; a discreet grey, lit when open.
  const label = rule('#messages .reasoning-label');
  assert.match(label, /font: 500 var\(--size-label\) \/ 22px var\(--font-ui\);/);
  assert.match(label, /letter-spacing: 0\.3em;/);
  assert.match(label, /text-transform: uppercase;/);
  assert.match(label, /color: #615e67;/);
  assert.match(rule("#messages .reasoning-label:is(:hover, :focus-visible, [aria-expanded='true'])"), /color: #aaa7af;/);
  assert.match(rule('#messages .message-name'), /line-height: 22px;/);
  assert.match(rule('#messages .reasoning-time'), /font-family: var\(--font-mono\);/);
  // Its text: the margin of the answer, 13.5 px on 21, grey; 9 px between paragraphs; no bar of quotation.
  const text = rule('#messages .reasoning');
  assert.match(text, /padding: 0 0 0 32px;/);
  assert.match(text, /font: 400 13\.5px\/21px var\(--font-ui\);/);
  assert.match(text, /color: #8b8891;/);
  assert.match(text, /border: 0;/);
  assert.match(rule('#messages .reasoning-content p + p'), /margin-top: 9px;/);
  assert.match(rule('#messages .reasoning-content'), /white-space: normal;/);
  // The rule that comes down from the Éclipse: 1 px, 10.5 px from the edge, ivory from 22 % to 6 %.
  const line = rule('#messages .reasoning::before');
  assert.match(line, /left: 10\.5px;/);
  assert.match(line, /width: 1px;/);
  assert.match(line, /linear-gradient\(rgba\(238, 232, 222, 0\.22\), rgba\(238, 232, 222, 0\.06\)\)/);
  assert.match(rule('#messages .message.assistant .reasoning:not([hidden]) + .message-body'), /margin-top: 10px;/);
  // While it is written: three lines (63 px), the top fading. Long: eight lines (168 px), the foot fading.
  const live = rule("#messages .reasoning[data-state='live'] .reasoning-window");
  assert.match(live, /height: 63px;/);
  assert.match(live, /justify-content: flex-end;/);
  assert.match(live, /mask-image: linear-gradient\(to bottom, transparent 0/);
  const long = rule('#messages .reasoning[data-long]:not([data-whole]) .reasoning-window');
  assert.match(long, /max-height: 168px;/);
  // Less motion: the cursor does not pulse.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n  #messages \.reasoning\[data-state='live'\] \.reasoning-content p:last-child::after \{\n    animation: none;/);
  // Nothing left of the reflection of before, nor of its icon and chevron.
  assert.doesNotMatch(css, /\.reasoning > summary|details\.reasoning/);
  const app = await read('app.js');
  assert.doesNotMatch(app, /node\('details', 'reasoning'\)|reasoning-label', 'Réflexion'\)|thoughtFor/);
  // The length of a clip in the Chat: at the top left of its picture (at the bottom it hid the player's bar).
  const length = rule('#messages .take-duration');
  assert.match(length, /top: 10px;/);
  assert.match(length, /bottom: auto;/);
});
