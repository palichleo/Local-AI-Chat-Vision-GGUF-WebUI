import test from 'node:test';
import assert from 'node:assert/strict';
import { citedIn, MOST, setupCitedTakes } from '../public/cited-takes.mjs';

const takes = text => citedIn(text).map(item => (item.kind === 'take' ? item.number : '#ref' + item.number));

test('a reply names takes by their number and references by « #refN », in its order, each once', () => {
  assert.deepEqual(takes('Voici la prise 12, faite à partir de #ref4.'), [12, '#ref4']);
  assert.deepEqual(takes('PRISE 3 et Prise 7 ; la prise n° 9, la prise #10, take 11'), [3, 7, 9, 10, 11]);
  // Lists and ranges.
  assert.deepEqual(takes('Les prises 12, 14 et 15 sont prêtes.'), [12, 14, 15]);
  assert.deepEqual(takes('Les prises 3 à 5, puis la 8.'), [3, 4, 5]);
  assert.deepEqual(takes('prises 2-4 ou la prise 6'), [2, 3, 4, 6]);
  // Each once; at most a few.
  assert.deepEqual(takes('la prise 12… encore la prise 12, et #ref1 puis #ref1'), [12, '#ref1']);
  assert.equal(citedIn('prises 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11').length, MOST);
  // Not a take: another word, a number that comes first, a « prise » without its number.
  assert.deepEqual(takes('une emprise 3, 12 prises, une prise de vue en 9:16, #ref, #refX'), []);
  assert.deepEqual(takes(''), []);
});

test('a number that is a length, a format, a size, a count or a day is not a take; a verb is not « take »', () => {
  // The verb, not the noun.
  assert.deepEqual(takes('La caméra takes 3 seconds'), []);
  assert.deepEqual(takes('It takes 5 steps'), []);
  // A definition, a format.
  assert.deepEqual(takes('une prise 4K'), []);
  assert.deepEqual(takes('une prise 16:9'), []);
  assert.deepEqual(takes('une prise 1080p, une prise 3,5 mm, une prise 3D'), []);
  // What follows a take is not always another take.
  assert.deepEqual(takes('La prise 12 - 16:9, 6 s'), [12]);
  assert.deepEqual(takes('La prise 3, 6 secondes'), [3]);
  assert.deepEqual(takes('prise 5, 24 fps'), [5]);
  assert.deepEqual(takes('prise 3 ou 4 secondes'), [3]);
  assert.deepEqual(takes('la prise 3 au 12 mars'), [3]);
  assert.deepEqual(takes('Prise 4 – 1280 × 720'), [4]);
  assert.deepEqual(takes('La prise 12 - 2 personnages'), [12]);
  // Not across a line: the dash of a list under it.
  assert.deepEqual(takes('Voici la prise 3\n- 2 personnages'), [3]);
  assert.deepEqual(takes('Voici la prise 3\r\n- 2 personnages'), [3]);
  assert.deepEqual(takes('les prises 3,\n4 personnages'), [3]);
  // Still takes.
  assert.deepEqual(takes('la prise 12'), [12]);
  assert.deepEqual(takes('les prises 3 à 5'), [3, 4, 5]);
  assert.deepEqual(takes('prises 3, 4 et 7'), [3, 4, 7]);
  assert.deepEqual(takes('prise 3 et 4'), [3, 4]);
  assert.deepEqual(takes('PRISE 12'), [12]);
  assert.deepEqual(takes('#ref4'), ['#ref4']);
  assert.deepEqual(takes('take 3 and take 5'), [3, 5]);
  assert.deepEqual(takes('prises 3-5'), [3, 4, 5]);
  assert.deepEqual(takes('prises 3 – 5'), [3, 4, 5]);
  // Words that only begin like a unit or a month; a full stop, a comma, an apostrophe after the number.
  assert.deepEqual(takes('La prise 3 s’ouvre, la prise 4 se termine, la prise 5 mais pas la prise 6.'), [3, 4, 5, 6]);
  assert.deepEqual(takes('la prise 7 minimale, la prise 8 secondaire, la prise 9 parfaite'), [7, 8, 9]);
});

test('code is not read: a block between fences, a word between backticks', () => {
  assert.deepEqual(takes('Voici la prise 2.\n```json\n{ "note": "prise 12, #ref4" }\n```\nEt la prise 3.'), [2, 3]);
  assert.deepEqual(takes('Le réglage `prise 9` et `#ref2`, puis la prise 4.'), [4]);
  // A block still being written (no closing fence yet).
  assert.deepEqual(takes('La prise 5.\n```\nprise 6'), [5]);
  // Nothing joins over a piece of code.
  assert.deepEqual(takes('prises 3, `x` 4'), [3]);
});

class Element {
  constructor(tag = '', className = '', textContent = '') {
    Object.assign(this, { tag, className, textContent, children: [], attributes: {}, style: { setProperty: (k, v) => (this.style[k] = v) } });
    this.classList = { add: name => (this.className = `${this.className} ${name}`.trim()) };
  }
  append(...items) {
    this.children.push(...items);
  }
  replaceChildren(...items) {
    this.children = items;
    this.drawn = (this.drawn ?? 0) + 1;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  after(item) {
    this.next = item;
  }
  remove() {
    this.removed = true;
  }
}
const run = (id, take, extra = {}) => ({
  id,
  mediaType: 'image',
  prompt: 'Un phare ' + take,
  outputs: [{ take, width: 768, height: 1344, originalUrl: `/media/${id}`, thumbUrl: `/thumb/${id}` }],
  ...extra,
});

test('under a reply, the takes it names small, at their format; a click opens one; read once, not at each piece', async () => {
  let loads = 0,
    runs = [run('a', 12), run('b', 14, { mediaType: 'video', outputs: [{ take: 14, originalUrl: '/media/b' }] }), run('c', 3, { mediaType: 'audio' })];
  const opened = [],
    cited = setupCitedTakes({
      node: (...args) => new Element(...args),
      icon: name => new Element('svg', 'icon-' + name),
      load: async () => (loads++, runs),
      project: () => 'p1',
      references: () => [{ reference: 4, name: 'phare.png', previewUrl: '/ref/4', id: 'r4' }],
      viewOutput: (record, index, blob, around) => opened.push([record.id, index, around.list().map(item => item.id), around.at()]),
    });
  const view = { body: new Element('div', 'message-body') };
  cited.show(view, 'Je prépare la prise 12');
  // The project read first.
  assert.ok(!view.cited);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(loads, 1);
  const strip = view.body.next;
  assert.equal(strip.className, 'message-cited');
  assert.equal(strip.attributes['aria-label'], 'Prises citées dans cette réponse');
  assert.deepEqual(strip.children.map(item => item.children.at(-1).textContent), ['PRISE 12']);
  const [first] = strip.children;
  assert.equal(first.children[0].children[0].src, '/thumb/a');
  assert.equal(first.style['--ratio'], (768 / 1344).toFixed(4));
  assert.equal(first.attributes['aria-label'], 'Ouvrir la prise 12 · Image · Un phare 12');
  // The reply goes on: the same pictures are not drawn again, the project not read again.
  cited.show(view, 'Je prépare la prise 12 pour vous');
  assert.equal(strip.drawn, 1);
  // It names more: a clip, a sound, a reference, a take the project does not have.
  cited.show(view, 'La prise 12, la prise 14, la prise 3, #ref4 et la prise 99.');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(strip.children.map(item => item.children.at(-1).textContent), ['PRISE 12', 'PRISE 14', 'PRISE 3', '#REF4']);
  assert.equal(loads, 2, 'read again once for the number it did not know');
  const [, clip, sound, reference] = strip.children;
  assert.equal(clip.children[0].children[0].tag, 'video');
  assert.equal(clip.children[0].children[0].src, '/media/b#t=0.1');
  assert.equal(clip.style['--ratio'], (16 / 9).toFixed(4));
  assert.match(sound.className, /is-sound/);
  assert.equal(reference.tag, 'figure');
  assert.equal(reference.children[0].children[0].src, '/ref/4');
  // A take opened, ‹ › through those of this reply.
  clip.onclick();
  assert.deepEqual(opened, [['b', 0, ['a', 'b', 'c'], 1]]);
  // The missing number is not asked again at each piece of the reply.
  cited.show(view, 'La prise 12, la prise 14, la prise 3, #ref4 et la prise 99. Fin.');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(loads, 2);
  // A reply that names nothing: no row.
  cited.show(view, 'Rien à montrer.');
  assert.equal(strip.removed, true);
  assert.equal(view.cited, null);
});

test('a take made since the project was read is found by reading it again', async () => {
  let runs = [run('a', 12)];
  const cited = setupCitedTakes({
    node: (...args) => new Element(...args),
    icon: name => new Element('svg', name),
    load: async () => runs,
    project: () => 'p1',
    references: () => [],
    viewOutput: () => {},
  });
  const before = { body: new Element('div') };
  cited.show(before, 'la prise 12');
  await new Promise(resolve => setTimeout(resolve, 0));
  runs = [run('b', 13), run('a', 12)];
  const after = { body: new Element('div') };
  cited.show(after, 'Voici la prise 13.');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(after.body.next.children.map(item => item.children.at(-1).textContent), ['PRISE 13']);
});

test('a conversation of another project opened while the first project is being read: its takes are read for it', async () => {
  let here = 'p1';
  const reads = [],
    cited = setupCitedTakes({
      node: (...args) => new Element(...args),
      icon: name => new Element('svg', name),
      // Each read answers when the test says so.
      load: () => new Promise(resolve => reads.push({ project: here, resolve })),
      project: () => here,
      references: () => [],
      viewOutput: () => {},
    }),
    tick = () => new Promise(resolve => setTimeout(resolve, 0)),
    labels = view => view.body.next?.children.map(item => item.children.at(-1).textContent);
  const first = { body: new Element('div') };
  cited.show(first, 'la prise 12');
  assert.deepEqual(reads.map(read => read.project), ['p1']);
  // The other project, before the answer: a read of its own (its numbers waited 8 s for nothing).
  here = 'p2';
  const second = { body: new Element('div') };
  cited.show(second, 'la prise 12 et la prise 7');
  assert.deepEqual(reads.map(read => read.project), ['p1', 'p2']);
  // The same project asked again meanwhile: no third read.
  cited.show(second, 'la prise 12 et la prise 7.');
  assert.equal(reads.length, 2);
  // The answer of the first project comes late: its take 12 is not that of this conversation.
  reads[0].resolve([run('a', 12)]);
  await tick();
  assert.equal(labels(second), undefined);
  assert.equal(labels(first), undefined);
  reads[1].resolve([run('b', 12), run('c', 7)]);
  await tick();
  assert.deepEqual(labels(second), ['PRISE 12', 'PRISE 7']);
  assert.equal(second.body.next.children[0].children[0].children[0].src, '/thumb/b');
  // Back to the first project at once: its numbers are asked again, not held back as asked in vain.
  here = 'p1';
  cited.show(first, 'la prise 12');
  assert.deepEqual(reads.map(read => read.project), ['p1', 'p2', 'p1']);
  reads[2].resolve([run('a', 12)]);
  await tick();
  assert.equal(first.body.next.children[0].children[0].children[0].src, '/thumb/a');
});

test('forgotten (a conversation opened again), a take deleted since is no longer drawn', async () => {
  let runs = [run('a', 12), run('b', 13)],
    loads = 0;
  const cited = setupCitedTakes({
      node: (...args) => new Element(...args),
      icon: name => new Element('svg', name),
      load: async () => (loads++, runs),
      project: () => 'p1',
      references: () => [],
      viewOutput: () => {},
    }),
    tick = () => new Promise(resolve => setTimeout(resolve, 0)),
    labels = view => view.body.next?.children.map(item => item.children.at(-1).textContent);
  const before = { body: new Element('div') };
  cited.show(before, 'Les prises 12 et 13.');
  await tick();
  assert.deepEqual(labels(before), ['PRISE 12', 'PRISE 13']);
  // Take 13 deleted in the Pellicule; without forgetting, it is still drawn from what was read.
  runs = [run('a', 12)];
  const stale = { body: new Element('div') };
  cited.show(stale, 'Les prises 12 et 13.');
  await tick();
  assert.deepEqual(labels(stale), ['PRISE 12', 'PRISE 13']);
  assert.equal(loads, 1);
  // The conversation opened again: read again, the take gone is not shown.
  cited.forget();
  const after = { body: new Element('div') };
  cited.show(after, 'Les prises 12 et 13.');
  assert.equal(labels(after), undefined);
  await tick();
  assert.equal(loads, 2);
  assert.deepEqual(labels(after), ['PRISE 12']);
});
