import test from 'node:test';
import assert from 'node:assert/strict';
import { ARRANGE_LIMITS, readArrangement, withArrangement } from '../public/montage-arrange.mjs';
import {
  MONTAGE_LIMITS,
  TODO_LIMITS,
  isTodo,
  linkOf,
  montageSeconds,
  placed,
  takeSeconds,
  withItemChanged,
  withTake,
  withTodoDrawn,
} from '../public/montage-model.mjs';
import { newMontage, validateMontage } from '../lib/montages.mjs';

// (0.6.161) The arranger of the Bobine, its version for measuring (claude_design/arrangeur/CONTRAT.md): a
// chat model answers a plan in JSON, read here kindly as to its form and strictly as to its sense, then
// laid after the end of the bobine as takes to create, without touching anything the user laid.
const C = '22222222-2222-4222-8222-222222222222',
  id = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const record = (n, mediaType, more = {}) => ({ id: id(n), conversationId: C, mediaType, prompt: `Prise ${n}.`, outputs: [{ take: n }], parameters: {}, ...more });
const photo = n => record(n, 'image'),
  clip = (n, seconds) => record(n, 'video', { parameters: { frames: seconds * 24, fps: 24 } }),
  source = n => ({ conversationId: C, runId: id(n), output: 0 });
// The project: three images, videos of 5 and 8 s, a video nobody knows the length of, a sound.
const TAKES = [photo(1), photo(2), photo(3), clip(5, 5), clip(6, 8), record(8, 'video'), record(7, 'audio', { parameters: { seconds: 9 } })];
const lengthOf = wanted => {
  const found = TAKES.find(item => item.id === wanted.runId);
  return found ? takeSeconds(found) : null;
};
const empty = () => newMontage({ id: id(900), now: '2026-11-20T10:00:00.000Z' });
const newIds = (from = 500) => {
  let n = from;
  return () => id(n++);
};
const round = value => Math.round(value * 1000) / 1000;
const UNREADABLE = { message: 'Moodix AI n’a pas rendu de plan lisible.' };
/** A take to create of a plan as readArrangement gives it. */
const todo = (text, more = {}) => ({ text, seconds: 5, link: 'cut', start: null, end: null, ...more });
const numberOf = given => (given ? (TAKES.find(item => item.id === given.runId)?.outputs[0].take ?? null) : null);
const shape = montage =>
  placed(montage).plans.map(item =>
    isTodo(item)
      ? ['à créer', item.at, item.to, item.todo.prompt, Boolean(item.todo.suite), numberOf(item.photos?.start), numberOf(item.photos?.end)]
      : [item.kind, item.at, round(item.to - item.from), numberOf(item.source)],
  );
const links = (result, look = lengthOf) => result.added.map(which => linkOf(result.montage, which, look).kind);

/**
 * (0.6.161) Each note is about a take of the returned bobine, or none (`id` null), and reads alone next
 * to its instants: a capital first, no number of block (the screen shows none).
 */
function told(result) {
  for (const { id: which, text, ...rest } of result.notes) {
    assert.deepEqual(rest, {});
    assert.ok(which === null || result.montage.plans.some(item => item.id === which), `${which} : ${text}`);
    assert.match(text, /^\p{Lu}.*\.$/u, text);
    assert.doesNotMatch(text, /\bbloc\b/i, text);
  }
}
/** The notes of a result as [id, text]. */
const said = result => result.notes.map(note => [note.id, note.text]);

/**
 * What every result keeps: the blocks laid before as they were (but the text written in them), the
 * sounds, what is laid after them against one another, what the server keeps, nothing laid that cannot
 * go on from what is before it, and notes that read alone.
 */
function kept(before, result, look = lengthOf) {
  told(result);
  const old = placed(before).plans,
    { montage, added, filled } = result,
    blank = item => (filled.includes(item.id) ? { ...item, todo: { ...item.todo, prompt: '' } } : item);
  assert.deepEqual(montage.plans.slice(0, old.length).map(blank), old.map(blank), 'what the user laid is as it was');
  assert.deepEqual(montage.sounds, before.sounds);
  assert.deepEqual(montage.plans.slice(old.length).map(item => item.id), added);
  let end = montageSeconds(before);
  for (const item of montage.plans.slice(old.length)) {
    assert.equal(item.at, end, 'each against the one before it');
    end = round(item.at + item.to - item.from);
  }
  assert.deepEqual(validateMontage(montage).plans, montage.plans, 'the server keeps it as it is');
  for (const item of montage.plans.slice(old.length))
    if (isTodo(item)) assert.ok(['suite', 'last', 'wait', 'photo', 'own'].includes(linkOf(montage, item.id, look).kind), linkOf(montage, item.id, look).kind);
  for (const which of filled) assert.ok(montage.plans.find(item => item.id === which).todo.prompt.trim());
  return result;
}
/** `montage` with the plan laid, and what every result keeps checked; the montage handed over is never changed. */
function arranged(montage, add = [], fill = [], options = {}) {
  const was = structuredClone(montage),
    result = withArrangement(montage, { say: '', fill, add }, { takes: TAKES, newId: newIds(), lengthOf, ...options });
  assert.deepEqual(montage, was, 'the montage handed over is never changed in place');
  return kept(montage, result, options.lengthOf ?? lengthOf);
}

// ------------------------------------------------------------------ readArrangement
const CONTRACT = {
  say: 'J’ai ajouté trois prises.',
  fill: [{ block: 4, text: 'Ce qui se passe dans cette prise.' }],
  add: [
    { text: 'Ce qui se passe.', seconds: 4, link: 'cut', start: 'prise 3', end: null },
    { text: 'Ce qui se passe ensuite.', seconds: 5, link: 'suite', start: null, end: 'prise 12' },
    { take: 'prise 9', seconds: 3 },
  ],
};
const READ = {
  arrangement: {
    say: 'J’ai ajouté trois prises.',
    fill: [{ block: 4, text: 'Ce qui se passe dans cette prise.' }],
    add: [
      { text: 'Ce qui se passe.', seconds: 4, link: 'cut', start: 3, end: null },
      { text: 'Ce qui se passe ensuite.', seconds: 5, link: 'suite', start: null, end: 12 },
      { take: 9, seconds: 3 },
    ],
  },
  problems: [],
};

test('the plan of the contract is read as it is written, the takes as their numbers (0.6.161)', () => {
  assert.deepEqual(readArrangement(JSON.stringify(CONTRACT)), READ);
  assert.deepEqual(readArrangement(JSON.stringify(CONTRACT, null, 2)), READ);
});

test('the plan is found alone, in a block ```json, or among sentences: the first balanced object that is a plan (0.6.161)', () => {
  const json = JSON.stringify(CONTRACT);
  for (const answer of [
    'Voici le plan :\n```json\n' + json + '\n```\nBonne création !',
    '```\n' + json + '\n```',
    'D’accord. ' + json + ' Voilà ce que je propose.',
    // (A brace of the sentences before it is no plan; nor an object that is none.)
    'Je propose {trois plans} : ' + json,
    '{"note": 1} puis ' + json,
    // (The plan given as a field of the object.)
    JSON.stringify({ plan: CONTRACT }),
    // (Two plans: the first.)
    json + '\n' + JSON.stringify({ say: 'Un autre.', add: [{ text: 'Autre chose.' }] }),
  ])
    assert.deepEqual(readArrangement(answer), READ, answer.slice(0, 50));
  // The braces and quotes of its strings are not counted.
  const braces = readArrangement('Plan : {"say": "Il dessine {une étoile} et \\"}\\".", "add": [{"text": "Un rond } {", "seconds": 2}]} Fin.');
  assert.deepEqual(braces.arrangement, { say: 'Il dessine {une étoile} et "}".', fill: [], add: [todo('Un rond } {', { seconds: 2 })] });
  // The commas JSON refuses before a closing brace or bracket.
  assert.deepEqual(readArrangement('{"say": "Ok", "add": [{"text": "La mer, au loin.", "seconds": 3,},],}').arrangement, {
    say: 'Ok',
    fill: [],
    add: [todo('La mer, au loin.', { seconds: 3 })],
  });
});

test('seconds are read as a number, « 4 s » or « 4,5 »; absent or not read, null (0.6.161)', () => {
  const secondsOf = value => readArrangement(JSON.stringify({ add: [{ text: 'La mer.', seconds: value }] })).arrangement.add[0].seconds;
  assert.deepEqual([4, 4.5, '4', '4 s', '4,5', '4.5s', '5 secondes', ' 6 sec ', 90, -3].map(secondsOf), [4, 4.5, 4, 4, 4.5, 4.5, 5, 6, 90, -3]);
  assert.deepEqual([undefined, null, '', 'environ 4 s', 'quatre', '4 min', true, [4]].map(secondsOf), Array(8).fill(null));
  // (A take of the project too.)
  assert.deepEqual(readArrangement('{"add": [{"take": "prise 1", "seconds": "2,5 s"}]}').arrangement.add, [{ take: 1, seconds: 2.5 }]);
});

test('a suite is said « suite », « continuation » or « continue »; anything else is a cut (0.6.161)', () => {
  const linkRead = value => readArrangement(JSON.stringify({ add: [{ text: 'La mer.', link: value }] })).arrangement.add[0].link;
  assert.deepEqual(['suite', 'Suite', 'continuation', ' CONTINUE '].map(linkRead), Array(4).fill('suite'));
  assert.deepEqual(['cut', 'coupe', 'new', undefined, null, 'fondu', true].map(linkRead), Array(7).fill('cut'));
});

test('a take is named « prise 3 », « take 3 », « #3 » or 3; nothing, null; what cannot be read is said (0.6.161)', () => {
  const read = (side, value) => readArrangement(JSON.stringify({ add: [{ text: 'La mer.', [side]: value }] }));
  // (The state shown to the model says « image prise 6 », « video prise 4 »: copied as it is, with words before.)
  for (const name of ['prise 3', 'Prise 3', 'take 3', '#3', 3, 'PRISE #3', ' prise n°3 ', 3.0, 'prise3', 'image prise 3', 'video prise 3', 'vidéo prise 3', 'la prise 3', 'the image prise 3', 'Image Take 3'])
    for (const side of ['start', 'end']) assert.deepEqual([read(side, name).arrangement.add[0][side], read(side, name).problems], [3, []], `${side} ${name}`);
  for (const name of [null, undefined, '', 'none', 'aucune', 'Aucune', '  '])
    for (const side of ['start', 'end']) assert.deepEqual([read(side, name).arrangement.add[0][side], read(side, name).problems], [null, []], `${side} ${name}`);
  // (Not ending with « prise N » or « take N », and no number alone: not read.)
  for (const [name, shown] of [
    ['ref2', '« ref2 »'],
    ['la fusée', '« la fusée »'],
    ['image 3', '« image 3 »'],
    ['surprise 3', '« surprise 3 »'],
    ['prise 3 de la fusée', '« prise 3 de la fusée »'],
    [3.5, '« 3.5 »'],
    [-1, '« -1 »'],
    [{}, '« {} »'],
  ]) {
    assert.deepEqual(read('start', name), {
      arrangement: { say: '', fill: [], add: [todo('La mer.', { seconds: null })] },
      problems: [`Le 1er ajout du plan a une image de début illisible (${shown}) : elle est laissée de côté.`],
    });
    assert.deepEqual(read('end', name).problems, [`Le 1er ajout du plan a une image de fin illisible (${shown}) : elle est laissée de côté.`]);
  }
  // A take of the project, by the same names.
  for (const name of ['prise 9', 'Take 9', '#9', 9, 'video prise 9', 'image prise 9']) assert.deepEqual(readArrangement(JSON.stringify({ add: [{ take: name }] })).arrangement.add, [{ take: 9, seconds: null }]);
});

test('texts are trimmed and cut to their limits, unknown fields left out (0.6.161)', () => {
  const long = 'a'.repeat(700),
    { arrangement, problems } = readArrangement(
      JSON.stringify({
        say: '  ' + 'b'.repeat(500),
        mood: 'calme',
        add: [{ text: long, seconds: 2, link: 'cut', camera: 'drone' }, { text: '  La mer.  ', start: 'prise 1' }],
        fill: [{ block: 1, text: long, color: 'rouge' }],
      }),
    );
  assert.deepEqual([arrangement.say, arrangement.add[0].text, arrangement.fill[0].text], ['b'.repeat(ARRANGE_LIMITS.say), 'a'.repeat(ARRANGE_LIMITS.text), 'a'.repeat(ARRANGE_LIMITS.text)]);
  assert.deepEqual(Object.keys(arrangement), ['say', 'fill', 'add']);
  assert.deepEqual(arrangement.add.map(Object.keys), [['text', 'seconds', 'link', 'start', 'end'], ['text', 'seconds', 'link', 'start', 'end']]);
  assert.deepEqual(Object.keys(arrangement.fill[0]), ['block', 'text']);
  assert.deepEqual(arrangement.add[1], todo('La mer.', { seconds: null, start: 1 }));
  assert.deepEqual(problems, []);
});

test('what is left out of a plan is said element by element; a take named wins over a text (0.6.161)', () => {
  const { arrangement, problems } = readArrangement(
    JSON.stringify({
      say: 'Voilà.',
      fill: [
        { block: 'quatre', text: 'x' },
        { block: 4.5, text: 'x' },
        { text: 'x' },
        { block: '2', text: '  ' },
        'bloc 3',
        { block: 'bloc 3', text: 'Il pleut.' },
        { block: '#5', text: 'Il neige.' },
        { block: 6.0, text: 'Il vente.' },
      ],
      add: [{ seconds: 4 }, 'prise 3', { take: 'la fusée' }, { take: 'la fusée', text: 'Une fusée décolle.' }, { take: 'prise 9', text: 'Ignoré.' }, null],
    }),
  );
  assert.deepEqual(arrangement, {
    say: 'Voilà.',
    fill: [{ block: 3, text: 'Il pleut.' }, { block: 5, text: 'Il neige.' }, { block: 6, text: 'Il vente.' }],
    add: [todo('Une fusée décolle.', { seconds: null }), { take: 9, seconds: null }],
  });
  assert.deepEqual(problems, [
    'Le 1er texte du plan ne dit pas quel bloc il écrit (« quatre ») : il est laissé de côté.',
    'Le 2e texte du plan ne dit pas quel bloc il écrit (« 4.5 ») : il est laissé de côté.',
    'Le 3e texte du plan ne dit pas quel bloc il écrit : il est laissé de côté.',
    'Le 4e texte du plan (bloc 2) est vide : il est laissé de côté.',
    'Le 5e texte du plan n’est pas le texte d’un bloc : il est laissé de côté.',
    'Le 1er ajout du plan n’a ni texte ni prise : il est laissé de côté.',
    'Le 2e ajout du plan n’est ni une prise à créer ni une prise du projet : il est laissé de côté.',
    'Le 3e ajout du plan nomme une prise illisible (« la fusée ») : elle est laissée de côté.',
    'Le 4e ajout du plan nomme une prise illisible (« la fusée ») : elle est laissée de côté.',
    'Le 6e ajout du plan n’est ni une prise à créer ni une prise du projet : il est laissé de côté.',
  ]);
  // A single element given alone is read as a list of it; what is no list is said.
  assert.deepEqual(readArrangement('{"add": {"text": "La mer."}}').arrangement.add, [todo('La mer.', { seconds: null })]);
  assert.deepEqual(readArrangement('{"say": "Ok", "add": "prise 3", "fill": 4}'), {
    arrangement: { say: 'Ok', fill: [], add: [] },
    problems: ['Les textes à écrire du plan ne sont pas une liste : ils sont laissés de côté.', 'Les prises à ajouter du plan ne sont pas une liste : elles sont laissées de côté.'],
  });
});

test('a text copied from the form of the plan, « ... » or « … », is no text (0.6.161)', () => {
  // (The coordinator’s precision of 20/11: the prompt shows the form of the plan with « ... » in place of
  // its texts, and a weak model copies it.)
  for (const dots of ['...', '…', '. . .', ' … ', '....', '. … .', '\n...\n']) {
    assert.throws(() => readArrangement(JSON.stringify({ say: dots, fill: [], add: [] })), UNREADABLE, `say ${dots}`);
    const { arrangement, problems } = readArrangement(
      JSON.stringify({
        say: dots,
        fill: [{ block: 1, text: dots }, { block: 2, text: 'Il pleut.' }],
        add: [{ text: dots, seconds: 5, link: 'cut', start: null, end: null }, { text: 'La mer.' }],
      }),
    );
    assert.deepEqual(arrangement, { say: '', fill: [{ block: 2, text: 'Il pleut.' }], add: [todo('La mer.', { seconds: null })] }, dots);
    assert.deepEqual(problems, ['Le 1er texte du plan (bloc 1) est vide : il est laissé de côté.', 'Le 1er ajout du plan n’a ni texte ni prise : il est laissé de côté.']);
  }
  // Only the copied form: a text that ends so is a text.
  assert.deepEqual(readArrangement('{"say": "Voilà...", "add": [{"text": "Il attend…"}]}').arrangement, { say: 'Voilà...', fill: [], add: [todo('Il attend…', { seconds: null })] });
  // Laid by hand, the same: nothing written nor laid, the same bobine.
  const bobine = withTodoDrawn(empty(), { id: id(10), at: 0, seconds: 4 }).montage,
    result = withArrangement(bobine, { say: '', fill: [{ block: 1, text: '…' }], add: [{ text: '. . .', seconds: 5, link: 'cut', start: null, end: null }] }, {
      takes: TAKES,
      newId: newIds(),
      lengthOf,
    });
  assert.equal(result.montage, bobine);
  told(result);
  assert.deepEqual(said(result), [
    [id(10), 'Le texte donné est vide : rien n’est écrit.'],
    [null, 'Le 1er ajout du plan n’a ni texte ni prise : il n’est pas posé.'],
  ]);
});

test('a plan that only says something is read, and lays nothing: the same bobine (0.6.161)', () => {
  // (The coordinator’s precision of 20/11: « Je ne trouve pas la prise 42. », nothing to lay.)
  const only = readArrangement('{ "say": "Je ne trouve pas la prise 42.", "add": [], "fill": [] }');
  assert.deepEqual(only, { arrangement: { say: 'Je ne trouve pas la prise 42.', fill: [], add: [] }, problems: [] });
  assert.deepEqual(readArrangement('Bien sûr. {"say": "Rien à faire ici."}').arrangement, { say: 'Rien à faire ici.', fill: [], add: [] });
  const bobine = withTake(empty(), clip(5, 5), { id: id(10) }),
    result = withArrangement(bobine, only.arrangement, { takes: TAKES, newId: newIds(), lengthOf });
  assert.equal(result.montage, bobine);
  assert.deepEqual([result.added, result.filled, result.notes], [[], [], []]);
});

test('an answer without a plan is refused: no object, or nothing said, laid nor written (0.6.161)', () => {
  for (const answer of [
    '',
    'Je ne peux pas faire ça.',
    '```json\n```',
    '{"say": "Je pose la première',
    '[1, 2, 3]',
    '{}',
    '{"answer": "oui"}',
    '{"say": "  ", "add": [], "fill": []}',
    '{"add": [{}], "fill": [{"block": "x"}]}',
    '{"say": 4, "add": "prise 3"}',
    '{ say: "non" }',
  ])
    assert.throws(() => readArrangement(answer), UNREADABLE, answer);
  for (const given of [undefined, null, 42, { say: 'Un objet, pas un texte.' }]) assert.throws(() => readArrangement(given), UNREADABLE);
});

test('the limits of a plan cannot be changed (0.6.161)', () => {
  assert.throws(() => {
    ARRANGE_LIMITS.add = 99;
  }, TypeError);
  assert.deepEqual(ARRANGE_LIMITS, { add: 24, fill: 24, say: 400, text: 600 });
});

// ------------------------------------------------------------------ withArrangement
test('on an empty bobine: from its start, each against the one before; a suite there has nothing to continue (0.6.161)', () => {
  const result = arranged(empty(), [
    todo('Une fusée sur son pas de tir.', { link: 'suite', seconds: 4 }),
    todo('Elle décolle.', { link: 'suite', seconds: 6, end: 2 }),
    { take: 6, seconds: null },
    todo('Elle traverse les nuages.', { link: 'suite' }),
    { take: 1, seconds: 2 },
    todo('La Terre, vue de loin.', { start: 1, end: 3 }),
  ]);
  assert.deepEqual(shape(result.montage), [
    ['à créer', 0, 4, 'Une fusée sur son pas de tir.', false, null, null],
    ['à créer', 4, 6, 'Elle décolle.', true, null, 2],
    ['video', 10, 8, 6],
    ['à créer', 18, 5, 'Elle traverse les nuages.', true, null, null],
    ['image', 23, 2, 1],
    ['à créer', 25, 5, 'La Terre, vue de loin.', false, 1, 3],
  ]);
  assert.deepEqual(result.added, [500, 501, 502, 503, 504, 505].map(id));
  assert.deepEqual(links(result), ['own', 'wait', 'made', 'suite', 'made', 'photo']);
  assert.deepEqual(said(result), [[id(500), 'Rien avant elle à continuer : c’est un nouveau plan, pas une suite.']]);
  assert.deepEqual(result.filled, []);
});

test('after a video shown whole, a suite goes on from it; towards a photo it arrives on it, which may start the next (0.6.161)', () => {
  const bobine = withTake(empty(), clip(5, 5), { id: id(10) });
  const plainSuite = arranged(bobine, [todo('Il se retourne.', { link: 'suite' })]);
  assert.deepEqual(shape(plainSuite.montage)[1], ['à créer', 5, 5, 'Il se retourne.', true, null, null]);
  assert.deepEqual([linkOf(plainSuite.montage, id(500), lengthOf), plainSuite.notes], [{ kind: 'suite', before: 1, whole: 5 }, []]);
  // The same image is the end of one and the start of the next.
  const both = arranged(bobine, [todo('Il marche vers la mer.', { link: 'suite', end: 2 }), todo('La mer, au loin.', { start: 2, seconds: 3 })]);
  assert.deepEqual(shape(both.montage).slice(1), [
    ['à créer', 5, 5, 'Il marche vers la mer.', true, null, 2],
    ['à créer', 10, 3, 'La mer, au loin.', false, 2, null],
  ]);
  assert.deepEqual(both.montage.plans.slice(1).map(item => item.photos), [{ end: source(2) }, { start: source(2) }]);
  assert.deepEqual([links(both), both.notes], [['last', 'photo'], []]);
});

test('after a video cut before its end, of a length nobody knows, or after an image: a new shot, said so (0.6.161)', () => {
  const whole = withTake(empty(), clip(5, 5), { id: id(10) }),
    suite = [todo('Il se retourne.', { link: 'suite' })],
    image = 'Une image est avant elle, une suite ne la continue pas : c’est un nouveau plan.',
    unknown = 'La durée de la vidéo d’avant n’est pas connue : c’est un nouveau plan, pas une suite.';
  const cut = arranged(withItemChanged(whole, id(10), { to: 3 }, { longest: 5 }), suite);
  assert.deepEqual([shape(cut.montage)[1], links(cut)], [['à créer', 3, 5, 'Il se retourne.', false, null, null], ['own']]);
  assert.deepEqual(said(cut), [[id(500), 'La vidéo d’avant est coupée avant sa fin : c’est un nouveau plan, pas une suite.']]);
  // A take nobody knows the length of: in the project, or for whoever lays the plan.
  assert.deepEqual(said(arranged(withTake(empty(), record(8, 'video'), { id: id(10) }), suite)), [[id(500), unknown]]);
  const blind = arranged(whole, suite, [], { lengthOf: () => null });
  assert.deepEqual([said(blind), links(blind, () => null)], [[[id(500), unknown]], ['own']]);
  const still = arranged(withTake(empty(), photo(1), { id: id(10) }), suite);
  assert.deepEqual([said(still), links(still)], [[[id(500), image]], ['own']]);
  // What the plan lays itself is read the same: a suite after its image, or after its video of unknown length.
  const own = arranged(empty(), [{ take: 1, seconds: 3 }, ...suite, { take: 8, seconds: null }, ...suite]);
  assert.deepEqual(links(own), ['made', 'own', 'made', 'own']);
  assert.deepEqual(said(own), [
    [id(501), image],
    [id(502), 'La durée de la prise 8 n’est pas connue : posée pour 3 s.'],
    [id(503), unknown],
  ]);
});

test('after a take to create, a suite waits for it (0.6.161)', () => {
  const bobine = withTodoDrawn(empty(), { id: id(10), at: 0, seconds: 4 }).montage,
    result = arranged(bobine, [todo('Le rideau se lève.', { link: 'suite', seconds: 3 })]);
  assert.deepEqual(shape(result.montage), [
    ['à créer', 0, 4, '', false, null, null],
    ['à créer', 4, 3, 'Le rideau se lève.', true, null, null],
  ]);
  assert.deepEqual([links(result), result.notes], [['wait'], []]);
});

test('a suite that starts on a photo is a new shot on that photo (0.6.161)', () => {
  const result = arranged(withTake(empty(), clip(5, 5), { id: id(10) }), [todo('Le phare s’allume.', { link: 'suite', start: 1, end: 3 })]);
  assert.deepEqual(shape(result.montage)[1], ['à créer', 5, 5, 'Le phare s’allume.', false, 1, 3]);
  assert.deepEqual([links(result), said(result)], [['photo'], [[id(500), 'Elle commence sur la prise 1 : une suite ne commence pas sur une image, c’est un nouveau plan.']]]);
});

test('a photo that is not of the project, or no image, is left out, and said (0.6.161)', () => {
  const result = arranged(withTake(empty(), clip(5, 5), { id: id(10) }), [
    todo('Un orage éclate.', { start: 42, end: 5 }),
    todo('La pluie tombe.', { link: 'suite', start: 7, end: 8 }),
  ]);
  // (Its start photo left out, the second can be a suite: it waits for the first.)
  assert.deepEqual(shape(result.montage).slice(1), [
    ['à créer', 5, 5, 'Un orage éclate.', false, null, null],
    ['à créer', 10, 5, 'La pluie tombe.', true, null, null],
  ]);
  assert.equal(result.montage.plans.some(item => item.photos), false);
  assert.deepEqual(links(result), ['own', 'wait']);
  assert.deepEqual(said(result), [
    [id(500), 'La prise 42 n’est pas dans ce projet : pas d’image de début.'],
    [id(500), 'La prise 5 n’est pas une image : elle ne peut pas être son image de fin.'],
    [id(501), 'La prise 7 n’est pas une image : elle ne peut pas être son image de début.'],
    [id(501), 'La prise 8 n’est pas une image : elle ne peut pas être son image de fin.'],
  ]);
  assert.deepEqual(said(arranged(empty(), [todo('La nuit tombe.', { end: 42 })])), [[id(500), 'La prise 42 n’est pas dans ce projet : pas d’image de fin.']]);
});

test('a take of the project is laid as it is: a video whole, an image for its seconds; a sound or an unknown take is not (0.6.161)', () => {
  const result = arranged(empty(), [
    { take: 5, seconds: 3 },
    { take: 1, seconds: null },
    { take: 2, seconds: 4.5 },
    { take: 7, seconds: 2 },
    { take: 42, seconds: null },
    { take: 8, seconds: null },
    { take: 3, seconds: 900 },
    { take: 3, seconds: 0 },
  ]);
  assert.deepEqual(shape(result.montage), [
    ['video', 0, 5, 5],
    ['image', 5, 3, 1],
    ['image', 8, 4.5, 2],
    ['video', 12.5, 3, 8],
    ['image', 15.5, MONTAGE_LIMITS.longest, 3],
    ['image', 615.5, MONTAGE_LIMITS.shortest, 3],
  ]);
  assert.deepEqual(result.montage.plans.map(item => item.source), [source(5), source(1), source(2), source(8), source(3), source(3)]);
  assert.equal(result.added.length, 6);
  // (A take not laid is of no take of the bobine: it gets no identifier.)
  assert.deepEqual(result.added, [500, 501, 502, 503, 504, 505].map(id));
  assert.deepEqual(said(result), [
    [id(500), 'La prise 5 est une vidéo : posée entière (5 s).'],
    // (An image without seconds stays 3 s, unsaid: no repair.)
    [null, 'La prise 7 est un son : elle n’est pas posée sur la bobine.'],
    [null, 'La prise 42 n’est pas dans ce projet : elle n’est pas posée.'],
    [id(503), 'La durée de la prise 8 n’est pas connue : posée pour 3 s.'],
    [id(504), 'Durée ramenée de 15 min 00 s à 10 min 00 s, le plus long pour une image.'],
    [id(505), 'Durée ramenée de 0 s à 0,1 s, le plus court pour une image.'],
  ]);
  // A video for as long as it is, or without seconds: nothing to say.
  assert.deepEqual(arranged(empty(), [{ take: 6, seconds: 8 }, { take: 5, seconds: null }]).notes, []);
  // Only a sound and a take that is not of the project: nothing laid, the same bobine.
  const bobine = withTake(empty(), clip(5, 5), { id: id(10) }),
    none = arranged(bobine, [{ take: 7, seconds: null }, { take: 42, seconds: 3 }]);
  assert.equal(none.montage, bobine);
  assert.deepEqual([none.added, none.notes.map(note => note.id)], [[], [null, null]]);
});

test('a take to create lasts from 1 to 60 s, 5 s when the plan does not say (0.6.161)', () => {
  const result = arranged(empty(), [
    todo('A.', { seconds: 90 }),
    todo('B.', { seconds: 0.5 }),
    todo('C.', { seconds: null }),
    todo('D.', { seconds: -3 }),
    todo('E.', { seconds: 4.26 }),
  ]);
  assert.deepEqual(result.montage.plans.map(item => item.to), [TODO_LIMITS.longest, TODO_LIMITS.shortest, TODO_LIMITS.usual, TODO_LIMITS.shortest, 4.3]);
  assert.deepEqual(said(result), [
    [id(500), 'Durée ramenée de 1 min 30 s à 1 min 00 s, le plus long pour une prise à créer.'],
    [id(501), 'Durée ramenée de 0,5 s à 1 s, le plus court pour une prise à créer.'],
    // (Without a length, the usual one, unsaid: no repair.)
    [id(503), 'Durée ramenée de -3 s à 1 s, le plus court pour une prise à créer.'],
  ]);
});

test('a text is written in a take to create of the bobine that has none; never over the user’s (0.6.161)', () => {
  // Block 1 to make without text, 2 a video, 3 to make with its text, then a hole (not numbered), 4 to make with blanks.
  let bobine = withTodoDrawn(empty(), { id: id(10), at: 0, seconds: 4 }).montage;
  bobine = withTake(bobine, clip(5, 5), { id: id(11) });
  bobine = withItemChanged(withTodoDrawn(bobine, { id: id(12), at: 9, seconds: 3 }).montage, id(12), { prompt: 'Son texte.' });
  bobine = withItemChanged(withTodoDrawn(bobine, { id: id(13), at: 14, seconds: 2 }).montage, id(13), { prompt: '  ' });
  const result = arranged(bobine, [], [
    { block: 1, text: 'Un phare dans la nuit.' },
    { block: 2, text: 'Une vague.' },
    { block: 3, text: 'Autre chose.' },
    { block: 4, text: 'La pluie.' },
    { block: 1, text: 'Encore.' },
    { block: 5, text: 'Rien.' },
    { block: 0, text: 'Rien.' },
  ]);
  assert.deepEqual(result.filled, [id(10), id(13)]);
  assert.deepEqual(result.montage.plans.map(item => item.todo?.prompt ?? null), ['Un phare dans la nuit.', null, 'Son texte.', 'La pluie.']);
  // (Each said of the take it aimed at; one that is not on the bobine, of none.)
  assert.deepEqual(said(result), [
    [id(11), 'Ce n’est pas une prise à créer : le texte écrit pour elle est laissé de côté.'],
    [id(12), 'Elle a déjà son texte : gardé tel quel.'],
    [id(10), 'Deux textes lui étaient donnés : seul le premier est écrit.'],
    [null, 'Un texte était écrit pour une prise qui n’est pas sur la bobine : laissé de côté.'],
    [null, 'Un texte était écrit pour une prise qui n’est pas sur la bobine : laissé de côté.'],
  ]);
  assert.deepEqual(result.added, []);
  // Written, then added after: the suite waits for the take it now has a text for.
  const then = arranged(withTodoDrawn(empty(), { id: id(10), at: 0, seconds: 4 }).montage, [todo('Il s’envole.', { link: 'suite' })], [{ block: 1, text: 'Un oiseau.' }]);
  assert.deepEqual([then.filled, links(then), shape(then.montage).map(item => item[3])], [[id(10)], ['wait'], ['Un oiseau.', 'Il s’envole.']]);
  // Nothing written: the same bobine.
  const none = arranged(bobine, [], [{ block: 2, text: 'x' }, { block: 3, text: 'x' }, { block: 9, text: 'x' }]);
  assert.equal(none.montage, bobine);
  assert.deepEqual(none.notes.map(note => note.id), [id(11), id(12), null]);
});

test('what is beyond the limits of a plan, or of a full bobine, is left out, and said (0.6.161)', () => {
  const many = arranged(empty(), Array.from({ length: 30 }, (_, at) => todo(`Plan ${at + 1}.`, { seconds: 1 })));
  assert.deepEqual([many.added.length, said(many)], [ARRANGE_LIMITS.add, [[null, 'Le plan ajoutait 30 prises : les 6 dernières sont laissées de côté (24 au plus).']]]);
  let blank = empty();
  for (let at = 0; at < 30; at++) blank = withTodoDrawn(blank, { id: id(100 + at), at, seconds: 1 }).montage;
  const texts = arranged(blank, [], Array.from({ length: 30 }, (_, at) => ({ block: at + 1, text: `Plan ${at + 1}.` })));
  assert.deepEqual(
    [texts.filled, said(texts)],
    [Array.from({ length: 24 }, (_, at) => id(100 + at)), [[null, 'Le plan écrivait 30 textes : les 6 derniers sont laissés de côté (24 au plus).']]],
  );
  // A bobine of 199 plans takes one more; one of 200, none.
  const full = count => ({ ...empty(), plans: Array.from({ length: count }, (_, at) => ({ id: id(100 + at), at, source: source(5), kind: 'video', from: 0, to: 1, frame: 'fit', volume: 1 })) });
  const three = [todo('A.'), todo('B.'), todo('C.')];
  const last = arranged(full(MONTAGE_LIMITS.plans - 1), three);
  assert.deepEqual([last.added, last.montage.plans.length], [[id(500)], MONTAGE_LIMITS.plans]);
  assert.deepEqual(said(last), [[null, 'La bobine est pleine (200 prises) : les 2 dernières prises du plan ne sont pas posées.']]);
  const bobine = full(MONTAGE_LIMITS.plans),
    none = arranged(bobine, [todo('A.')]);
  assert.equal(none.montage, bobine);
  assert.deepEqual(said(none), [[null, 'La bobine est pleine (200 prises) : la dernière prise du plan n’est pas posée.']]);
});

test('a plan with nothing to lay hands back the same bobine (0.6.161)', () => {
  const bobine = withTake(empty(), clip(5, 5), { id: id(10) }),
    options = { takes: TAKES, newId: newIds(), lengthOf };
  for (const plan of [{ say: 'Rien.', fill: [], add: [] }, {}, null, undefined]) {
    const result = withArrangement(bobine, plan, options);
    assert.deepEqual([result.montage === bobine, result.added, result.filled, result.notes], [true, [], [], []]);
  }
  const blank = withArrangement(bobine, { say: '', fill: [], add: [{ seconds: 3 }, null] }, options);
  assert.equal(blank.montage, bobine);
  told(blank);
  assert.deepEqual(said(blank), [
    [null, 'Le 1er ajout du plan n’a ni texte ni prise : il n’est pas posé.'],
    [null, 'Le 2e ajout du plan n’a ni texte ni prise : il n’est pas posé.'],
  ]);
  // A bobine kept before its instants (0.6.149) is read with them to be laid on: with nothing laid, it is
  // still the one given, not the one read (the page would take it for a change, and keep it for nothing).
  const old = { ...empty(), plans: [{ id: id(10), source: source(5), kind: 'video', from: 0, to: 5, frame: 'fit', volume: 1 }] };
  assert.equal(withArrangement(old, { say: 'Rien.', fill: [], add: [] }, options).montage, old);
  assert.equal(withArrangement(old, { say: '', fill: [{ block: 9, text: 'Un texte.' }], add: [] }, options).montage, old);
});

test('a bobine kept before its instants is laid on as the Bobine reads it (0.6.161)', () => {
  // (Before 0.6.149 the plans had no instant, and a take to make right after a video went on from it.)
  const old = {
    ...empty(),
    plans: [
      { id: id(10), source: source(5), kind: 'video', from: 0, to: 5, frame: 'fit', volume: 1 },
      { id: id(11), kind: 'video', todo: { prompt: '' }, from: 0, to: 3, frame: 'fit', volume: 1 },
    ],
  };
  const result = arranged(old, [todo('Il rentre chez lui.', { link: 'suite' })], [{ block: 2, text: 'Il se retourne.' }]);
  assert.deepEqual(shape(result.montage), [
    ['video', 0, 5, 5],
    ['à créer', 5, 3, 'Il se retourne.', true, null, null],
    ['à créer', 8, 5, 'Il rentre chez lui.', true, null, null],
  ]);
  assert.deepEqual([links(result), result.notes], [['wait'], []]);
});

test('what the model answers is read, then laid on the bobine (0.6.161)', () => {
  // A video, an image, a video, and a take to create without text: the plan of the contract on it,
  // with takes of this project.
  let bobine = withTake(empty(), clip(5, 5), { id: id(10) });
  bobine = withTake(withTake(bobine, photo(1), { id: id(11) }), clip(6, 8), { id: id(12) });
  bobine = withTodoDrawn(bobine, { id: id(13), at: montageSeconds(bobine), seconds: 4 }).montage;
  const answer =
    'Voici le plan.\n```json\n' +
    JSON.stringify({
      say: 'J’ai écrit la dernière prise et ajouté trois plans.',
      fill: [{ block: 4, text: 'La fusée attend sur son pas de tir.' }],
      add: [
        { text: 'Le compte à rebours.', seconds: '4 s', link: 'cut', start: 'Prise 3', end: 'aucune' },
        { text: 'Elle s’élève.', seconds: 5, link: 'continuation', start: null, end: '#2' },
        { take: 'take 1', seconds: '3' },
      ],
    }) +
    '\n```',
    { arrangement, problems } = readArrangement(answer),
    result = withArrangement(bobine, arrangement, { takes: TAKES, newId: newIds(), lengthOf });
  assert.deepEqual(problems, []);
  kept(bobine, result);
  assert.deepEqual(shape(result.montage), [
    ['video', 0, 5, 5],
    ['image', 5, 3, 1],
    ['video', 8, 8, 6],
    ['à créer', 16, 4, 'La fusée attend sur son pas de tir.', false, null, null],
    ['à créer', 20, 4, 'Le compte à rebours.', false, 3, null],
    ['à créer', 24, 5, 'Elle s’élève.', true, null, 2],
    ['image', 29, 3, 1],
  ]);
  assert.deepEqual([result.filled, result.added, links(result), result.notes], [[id(13)], [500, 501, 502].map(id), ['photo', 'wait', 'made'], []]);
});
