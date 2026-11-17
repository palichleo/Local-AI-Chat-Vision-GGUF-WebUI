import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Where the cards of a turn go when it has several steps (17/11: Moodix read a reference, then
// wrote what it proposed and proposed the video; the card stood above the text that proposed it).
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

class El {
  constructor(tag, className = '', text = '') {
    Object.assign(this, { tag, className, textContent: text, children: [], parent: null, attributes: {}, classes: new Set() });
  }
  append(...items) {
    for (const item of items) {
      item.remove();
      item.parent = this;
      this.children.push(item);
    }
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  get classList() {
    return { add: name => this.classes.add(name) };
  }
  get all() {
    return this.children.flatMap(child => [child, ...child.all]);
  }
  // The one selector the page asks for here.
  querySelectorAll(selector) {
    assert.equal(selector, '.generation-grid[data-takes]');
    return this.all.filter(item => item.className === 'generation-grid' && 'data-takes' in item.attributes);
  }
}

function page() {
  const messages = new El('div'),
    node = (tag, className, text) => new El(tag, className, text),
    reflection = () => ({ element: node('div', 'reasoning'), label: node('span', 'reasoning-label'), content: node('div') });
  const made = new Function(
    'node',
    'reflection',
    'moodixMark',
    'scrollToBottom',
    '$',
    'thoughtTime',
    'performance',
    source.slice(source.indexOf('function assistantMessage('), source.indexOf('function userContent(')) +
      '\nreturn { assistantMessage, turnTime };',
  )(node, reflection, () => [], () => {}, () => messages, seconds => seconds + ' s', { now: () => 2000 });
  return { ...made, messages, node };
}
const names = article => article.children.map(child => child.className);

test('the cards of a turn with one step are under its words', () => {
  const { assistantMessage, messages } = page(),
    view = assistantMessage();
  assert.deepEqual(names(view.article), ['message-header', 'reasoning', 'message-body', 'message-note', 'generation-grid']);
  assert.equal(messages.children[0], view.article);
});

test('a later step that proposes has its card under its own words', () => {
  const { assistantMessage, node } = page(),
    first = assistantMessage(),
    second = assistantMessage(first);
  // Nothing was made by the first step (it read a reference): its grid goes under the second's words.
  assert.equal(second.generations, first.generations);
  assert.equal(second.article, first.article);
  assert.deepEqual(names(first.article), [
    'message-header',
    'reasoning',
    'message-body',
    'message-note',
    'reasoning-line',
    'reasoning',
    'message-body',
    'message-note',
    'generation-grid',
  ]);
  // The second step makes an image; the third writes about it and proposes a video: a grid of its
  // own under its words, the image staying where it is.
  second.generations.append(node('div', 'generation-card'));
  const third = assistantMessage(second);
  assert.notEqual(third.generations, second.generations);
  const order = first.article.children;
  assert.equal(order.at(-1), third.generations);
  assert.equal(order.indexOf(second.generations), 8);
  assert.equal(order.filter(child => child.className === 'generation-grid').length, 2);
  assert.ok(order.indexOf(third.body) > order.indexOf(second.generations), 'the words that follow a card are under it');
});

test('the time of a turn is on the line of its last takes, whichever step made them', () => {
  const { assistantMessage, turnTime, node } = page(),
    first = assistantMessage();
  first.generations.append(node('div', 'generation-card'));
  first.generations.setAttribute('data-takes', '1');
  // A last step that only writes: its own grid is empty, the time stays on the line of the takes.
  const last = assistantMessage(first);
  turnTime(last, 0);
  assert.equal(first.generations.attributes['data-time'], '2.0 s');
  assert.equal(last.generations.attributes['data-time'], undefined);
  assert.ok(last.note.classes.has('is-time'));
  // A turn that made nothing: on its own grid, as before (the note shows it).
  const alone = assistantMessage();
  turnTime(alone, 0);
  assert.equal(alone.generations.attributes['data-time'], '2.0 s');
});
