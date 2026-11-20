import test from 'node:test';
import assert from 'node:assert/strict';
import { arrangeMessages, bobineText, retryMessage } from '../lib/arrange-prompt.mjs';
import { placed } from '../public/montage-model.mjs';
import { newMontage, validateMontage } from '../lib/montages.mjs';

// (0.6.161) The arranger of the Bobine (claude_design/arrangeur/CONTRAT.md, « Pièce B »): what the chat
// model reads when it is asked, in a request of its own, to arrange a bobine. Its first reader is the
// small local model: constant short instructions, the state in the message, no identifier, no example.
const C = '11111111-1111-4111-8111-111111111111',
  id = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`,
  UUID = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i;
const record = (n, mediaType, prompt, more = {}) => ({
  id: id(n),
  conversationId: C,
  mediaType,
  prompt,
  parameters: {},
  outputs: [{ take: n }],
  // (The higher the number, the newer, unless said otherwise.)
  createdAt: new Date(Date.UTC(2026, 10, 20, 8) + n * 60000).toISOString(),
  ...more,
});
const photo = (n, prompt) => record(n, 'image', prompt),
  clip = (n, seconds, prompt) => record(n, 'video', prompt, { parameters: { frames: seconds * 24, fps: 24 } }),
  sound = (n, prompt) => record(n, 'audio', prompt, { parameters: { seconds: 30 } }),
  source = n => ({ conversationId: C, runId: id(n), output: 0 });
const still = (key, n, at, seconds = 3) => ({ id: id(key), at, kind: 'image', source: source(n), from: 0, to: seconds, frame: 'fit' }),
  shown = (key, n, at, from, to) => ({ id: id(key), at, kind: 'video', source: source(n), from, to, frame: 'fit', volume: 1 }),
  todo = (key, at, seconds, prompt = '', { suite = false, photos } = {}) => ({
    id: id(key),
    at,
    kind: 'video',
    todo: { prompt, ...(suite ? { suite: true } : {}) },
    from: 0,
    to: seconds,
    frame: 'fit',
    volume: 1,
    ...(photos ? { photos } : {}),
  });
const empty = () => newMontage({ id: id(900), now: '2026-11-20T10:00:00.000Z' }),
  bobine = (plans, more = {}) => validateMontage({ ...empty(), plans, ...more }, { now: '2026-11-20T10:00:00.000Z' });
const userOf = messages => messages[1].content,
  lines = text => text.split('\n');

// Six images and videos of a film on space, and a music; the bobine has five blocks and a black gap.
const TAKES = [
  photo(1, 'A small red-and-white rocket stands on a launch pad in the desert at sunrise, long shadows on the sand.'),
  clip(2, 5, 'The rocket lifts off in a burst of flame and white smoke; the camera tilts up to follow it into a clear blue sky.'),
  photo(3, 'The Earth seen from orbit at night, a thin blue line of atmosphere above the lights of the cities.'),
  clip(4, 6, 'Inside the capsule, an astronaut in a white suit floats past a round window, the Earth turning slowly below.'),
  sound(5, 'Slow ambient synth music with a deep pulse.'),
  photo(6, 'A grey lunar landscape full of craters under a black sky, the Earth rising above the horizon.'),
  clip(7, 4, 'In mission control, engineers in headsets watch rows of screens; one of them raises a fist and cheers.'),
];
const FILM = () =>
  bobine(
    [
      still(11, 1, 0),
      shown(12, 2, 3, 0, 5),
      todo(13, 8, 4, 'La fusée traverse les nuages et le ciel devient noir.', { suite: true, photos: { end: source(3) } }),
      shown(14, 4, 14, 1, 5),
      todo(15, 18, 5, '', { photos: { start: source(6) } }),
    ],
    { name: 'Premier voyage', sounds: [{ id: id(16), source: source(5), track: 'music', at: 0, from: 0, to: 23, volume: 0.6 }] },
  );
const REQUEST =
  'invente la suite avec un vaisseau qui monte dans le ciel en partant de la prise 2, puis un astronaute qui dérive 4 secondes, ' +
  'et après on doit voir la prise 3 d’une manière ou d’une autre';
const PREVIOUS = [
  { request: 'fais un essai', say: 'Rien posé.' },
  { request: 'crée une vidéo sur le thème de l’espace', say: 'J’ai posé quatre prises : le décollage, l’orbite et la Lune.' },
  { request: 'ajoute une image de la Terre', say: 'J’ai ajouté la prise 3 comme photo de fin.' },
  { request: 'une prise à créer après la vidéo de la capsule', say: '' },
];

test('the instructions are the same for every bobine and every request, short, and name nothing of them (0.6.161)', () => {
  const systems = [
    arrangeMessages({ montage: FILM(), takes: TAKES, request: REQUEST, previous: PREVIOUS, preferences: 'Des plans courts, en noir et blanc.' }),
    arrangeMessages({ montage: empty(), takes: [], request: 'crée une vidéo sur le thème de l’espace' }),
    arrangeMessages({ montage: FILM(), takes: TAKES, request: 'invente la suite', most: 2 }),
    arrangeMessages({}),
  ].map(messages => {
    assert.deepEqual(messages.map(message => message.role), ['system', 'user']);
    return messages[0].content;
  });
  const [system] = systems;
  for (const other of systems) assert.equal(other, system);
  assert.ok(system.length < 2500, `${system.length} characters`);
  // Nothing of the bobine, of the takes, of the request nor of the user's instructions (the same text for all
  // of them above): no take named, no identifier, none of the words of the request, of the name of the bobine
  // nor of the instructions.
  assert.doesNotMatch(system, /prise \d|take \d|block \d|#\d/i);
  assert.doesNotMatch(system, UUID);
  const words = [REQUEST, 'Premier voyage', 'Des plans courts, en noir et blanc.']
    .join(' ')
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(word => word.length >= 6);
  for (const word of new Set(words)) assert.doesNotMatch(system.toLowerCase(), new RegExp(`(?<!\\p{L})${word}(?!\\p{L})`, 'u'), word);
  // Never what happens once the plan is given (a weak model says it back), and no example to copy.
  assert.doesNotMatch(system, /\bwill\b|\blater\b|afterwards|then the user|Enrich|Moodix|example/i);
  // The shape of the plan, with « ... » where words go.
  assert.match(system, /\{"say": "\.\.\.", "fill": \[\.\.\.\], "add": \[\.\.\.\]\}/);
  assert.match(system, /\{"text": "\.\.\.", "seconds": 5, "link": "cut" or "suite", "start": "prise N" or null, "end": "prise N" or null\}/);
  assert.match(system, /\{"take": "prise N", "seconds": 3\}/);
  assert.match(system, /\{"block": its number, "text": "\.\.\."\}/);
  assert.match(system, /seconds: from 1 to 60, 5 when nothing says otherwise\./);
  assert.match(system, /A suite never follows an image, never opens an empty bobine and never has a start image\./);
  assert.match(system, /Only an image can be a start or an end, never a video\./);
  // (0.6.164, his choice of 21/11, « Oui, en anglais »: with his own ChatGPT the texts of the takes were in
  // French for one request and in English for the next two, all three asked in French. The text of a take
  // is the prompt of its video, always in English as Enrichir and the Éclipse write; what is said to him
  // stays in his language.)
  assert.match(system, /say is in the language the request itself is written in; every text is in English\./);
  assert.match(system, /text: the prompt of the video, always in English: two or three sentences/);
  assert.doesNotMatch(system, /every text are in the language/);
  const [simply] = arrangeMessages({ montage: empty(), takes: [], request: 'x', simple: true });
  assert.match(simply.content, /text: always in English: one or two sentences/);
  assert.match(simply.content, /say is in the language the request itself is written in; every text is in English\.$/);
  // (Measured on 20/11 with a small ChatGPT, 12 requests: offered as an item like the others, an image laid
  // still was taken in 8 of them, a film of fixed pictures; a video of 5 s stood for a shot asked of 6 s;
  // « Le vaisseau argenté de la prise 2 monte… » was written as the text of a take.)
  assert.match(system, /An image of the project is never laid by itself: to show it, a take to create starts on it or arrives on it/);
  assert.match(system, /Only when the request asks for a still image: \{"take": "prise N", "seconds": 3\}\./);
  assert.match(system, /It keeps its own length: a shot whose length is asked is a take to create\./);
  assert.match(system, /never a take or block number\./);
});

test('the blocks are numbered as placed(montage).plans, the black gaps without a number (0.6.161)', () => {
  const montage = FILM(),
    text = bobineText(montage, TAKES),
    blocks = lines(text).flatMap(line => {
      const found = /^Block (\d+), from ([\d.]+) to ([\d.]+) s \(([\d.]+) s\): /.exec(line);
      return found ? [found.slice(1).map(Number)] : [];
    });
  assert.deepEqual(
    blocks,
    placed(montage).plans.map((plan, index) => [index + 1, plan.at, plan.at + plan.to - plan.from, plan.to - plan.from]),
  );
  // The gap between the third and the fourth, said where it is, with no number of its own.
  const at = line => lines(text).findIndex(item => item.startsWith(line));
  assert.equal(at('Black gap, from 12 to 14 s (2 s): not a block.'), at('Block 3,') + 1);
  assert.equal(at('Block 4,'), at('Black gap') + 1);
  assert.equal(lines(text).filter(line => line.startsWith('Black gap')).length, 1);
  // A bobine kept before 0.6.149 (no instants): its plans end to end, a plan to make after a video its
  // suite; a gap before the first block; a plan laid over the one before it is pushed after it, as the
  // Bobine lays them.
  const old = { ...empty(), plans: [{ ...shown(21, 2, 0, 0, 5), at: undefined }, { ...todo(22, 0, 3, 'Elle continue.'), at: undefined }, { ...still(23, 1, 0), at: undefined }] };
  assert.deepEqual(lines(bobineText(old, TAKES)).slice(1, 4), [
    'Block 1, from 0 to 5 s (5 s): video prise 2, shown whole: "The rocket lifts off in a burst of flame and white smoke; the camera tilts up to follow it into a clear blue sky."',
    'Block 2, from 5 to 8 s (3 s): take to create, suite of block 1. Text: "Elle continue."',
    'Block 3, from 8 to 11 s (3 s): image prise 1, still: "A small red-and-white rocket stands on a launch pad in the desert at sunrise, long shadows on the sand."',
  ]);
  const late = bobine([still(31, 1, 2), still(32, 3, 3.5)]);
  assert.deepEqual(lines(bobineText(late, TAKES)).slice(1, 4).map(line => line.split(':')[0]), [
    'Black gap, from 0 to 2 s (2 s)',
    'Block 1, from 2 to 5 s (3 s)',
    'Block 2, from 5 to 8 s (3 s)',
  ]);
  // (A gap too short to be seen is not one.)
  assert.equal(bobineText(bobine([still(33, 1, 0), still(34, 3, 3.02)]), TAKES).includes('Black gap'), false);
});

test('each block says what it is; a take to create its text or none, its photos by name, suite or cut (0.6.161)', () => {
  const text = bobineText(FILM(), TAKES);
  assert.deepEqual(lines(text).slice(0, 9), [
    'The bobine "Premier voyage" now:',
    'Block 1, from 0 to 3 s (3 s): image prise 1, still: "A small red-and-white rocket stands on a launch pad in the desert at sunrise, long shadows on the sand."',
    'Block 2, from 3 to 8 s (5 s): video prise 2, shown whole: "The rocket lifts off in a burst of flame and white smoke; the camera tilts up to follow it into a clear blue sky."',
    'Block 3, from 8 to 12 s (4 s): take to create, suite of block 2. Text: "La fusée traverse les nuages et le ciel devient noir." Ends on image prise 3.',
    'Black gap, from 12 to 14 s (2 s): not a block.',
    'Block 4, from 14 to 18 s (4 s): video prise 4, shown from 1 to 5 s of its 6 s: "Inside the capsule, an astronaut in a white suit floats past a round window, the Earth turning slowly below."',
    'Block 5, from 18 to 23 s (5 s): take to create, cut. No text yet. Starts on image prise 6.',
    'The bobine ends at 23 s with block 5, a take to create: a suite may continue it.',
    'Takes to create with no text yet: block 5.',
  ]);
  // A take to create with both photos, a long text cut at a word, one whose photo is gone; a take whose
  // record is gone; a suite apart from its video.
  const long = 'Un vieil homme marche lentement sur une plage déserte au lever du soleil, '.repeat(6).trim(),
    other = bobine([
      todo(41, 0, 5, long, { photos: { start: source(1), end: source(3) } }),
      todo(42, 5, 3, '', { photos: { end: source(77) } }),
      shown(43, 88, 8, 0, 4),
      todo(44, 13, 2, 'Il se retourne.', { suite: true }),
    ]),
    read = lines(bobineText(other, TAKES));
  assert.match(read[1], /^Block 1, from 0 to 5 s \(5 s\): take to create, cut\. Text: "Un vieil homme marche .{150,240}…" Starts on image prise 1\. Ends on image prise 3\.$/);
  assert.equal(read[2], 'Block 2, from 5 to 8 s (3 s): take to create, cut. No text yet. Ends on an image no longer in the project.');
  assert.equal(read[3], 'Block 3, from 8 to 12 s (4 s): a video no longer in the project.');
  assert.match(bobineText(bobine([still(48, 9, 0)]), [{ ...photo(9, 'Sans numéro.'), outputs: [{}] }]), /\nBlock 1, from 0 to 3 s \(3 s\): an image that has no number\.\n/);
  assert.equal(read[5], 'Block 4, from 13 to 15 s (2 s): take to create, suite, not joined to the block before it. Text: "Il se retourne."');
  assert.equal(read.find(line => line.startsWith('Takes to create')), 'Takes to create with no text yet: block 2.');
  assert.match(bobineText(bobine([todo(45, 0, 5), still(46, 1, 5), todo(47, 8, 5)]), TAKES), /\nTakes to create with no text yet: blocks 1, 3\.\n/);
});

test('what may follow the end of the bobine is said, as the Bobine reads it (0.6.161)', () => {
  const end = (plans, lengthOf) => lines(bobineText(bobine(plans), TAKES, { lengthOf })).find(line => line.startsWith('The bobine ends') || line.startsWith('The bobine is empty'));
  assert.equal(end([]), 'The bobine is empty: what you add opens the film, and its first take is a cut.');
  assert.equal(end([still(51, 1, 0)]), 'The bobine ends at 3 s with block 1, an image: what you add first is a cut.');
  assert.equal(end([shown(51, 2, 0, 0, 5)]), 'The bobine ends at 5 s with block 1, a video shown to its end: a suite may continue it.');
  assert.equal(end([shown(51, 2, 0, 0, 3.5)]), 'The bobine ends at 3.5 s with block 1, a video cut before its end: what you add first is a cut.');
  assert.equal(end([shown(51, 4, 0, 2, 6)]), 'The bobine ends at 4 s with block 1, a video shown to its end: a suite may continue it.');
  assert.equal(end([todo(51, 0, 5, 'La mer.')]), 'The bobine ends at 5 s with block 1, a take to create: a suite may continue it.');
  // The length of a video is the one `lengthOf` gives (as for linkOf): nobody knows it, no suite.
  assert.equal(end([shown(51, 2, 0, 0, 5)], () => null), 'The bobine ends at 5 s with block 1, a video: what you add first is a cut.');
  assert.equal(end([shown(51, 2, 0, 0, 5)], wanted => (wanted.runId === id(2) ? 8 : null)), 'The bobine ends at 5 s with block 1, a video cut before its end: what you add first is a cut.');
  assert.match(bobineText(bobine([shown(51, 2, 0, 0, 5)]), TAKES, { lengthOf: () => 8 }), /video prise 2, shown from 0 to 5 s of its 8 s: /);
  // A suite joined to the video before it.
  assert.match(bobineText(bobine([shown(51, 2, 0, 0, 5), todo(52, 5, 3, 'Suite.', { suite: true })]), TAKES), /take to create, suite of block 1\./);
  // Every take to create has its text: no line for it.
  assert.equal(bobineText(bobine([todo(51, 0, 5, 'La mer.')]), TAKES).includes('Takes to create with no text yet'), false);
});

test('no identifier reaches a message (0.6.161)', () => {
  const said = `prise 2 ${id(2)}`,
    takes = TAKES.map(item => ({ ...item, prompt: `${item.prompt} (${id(500)})` })),
    montage = { ...FILM(), name: `Bobine ${C}`, plans: [...FILM().plans, shown(60, 99, 23, 0, 2)] },
    messages = [
      ...arrangeMessages({
        montage,
        takes,
        request: `${REQUEST} ${said}`,
        previous: [{ request: said, say: `${C} posé` }],
        preferences: `Jamais ${id(3)}.`,
      }),
      ...arrangeMessages({ montage: empty(), takes: [] }),
      retryMessage(`Le bloc ${id(13)} n’existe pas.`),
    ];
  for (const message of messages) assert.doesNotMatch(message.content, UUID, message.content.slice(0, 80));
  // The take names stay: they are how the model names them.
  assert.match(messages[1].content, /video prise 2, shown whole/);
});

test('the sounds of the project are never listed; one the request names is said to be a sound (0.6.161)', () => {
  const text = userOf(arrangeMessages({ montage: FILM(), takes: TAKES, request: 'invente la suite' }));
  assert.deepEqual(
    lines(text).filter(line => /^prise \d+,/.test(line)).map(line => line.split(',')[0]),
    ['prise 1', 'prise 2', 'prise 3', 'prise 4', 'prise 6', 'prise 7'],
  );
  assert.equal(text.includes('prise 5'), false);
  assert.equal(/music|synth|sound/i.test(text), false, 'nor the sounds of the bobine');
  // Named by the request: not listed either, said to be a sound; a take the project does not have is said too.
  const named = userOf(arrangeMessages({ montage: FILM(), takes: TAKES, request: 'mets la prise 5 puis la prise 12' }));
  assert.equal(/^prise 5,/m.test(named), false);
  assert.match(named, /\nNot in this project: prise 12\.\nA sound, which a plan cannot lay: prise 5\.\n/);
  // How each one is said: a video with its length, the prompt that made it, where the bobine shows it (a
  // take laid as a block has its prompt on that block already).
  assert.match(text, /\nprise 2, video of 5 s, laid as block 2\n/);
  assert.match(text, /\nprise 7, video of 4 s: "In mission control,/);
  assert.match(text, /\nprise 3, image, photo of block 3: "The Earth seen from orbit/);
  const twice = bobine([still(71, 3, 0), todo(72, 3, 5, 'La Terre.', { photos: { start: source(3), end: source(3) } }), todo(73, 8, 5, '', { photos: { start: source(3) } })]);
  assert.match(bobineText(twice, TAKES), /\nprise 3, image, laid as block 1, photo of blocks 2, 3\n/);
  assert.match(bobineText(empty(), [photo(8, '  ')]), /\nprise 8, image, no description$/);
  // (A take without a number cannot be named: it is not listed.)
  assert.doesNotMatch(bobineText(empty(), [{ ...photo(9, 'Sans numéro.'), outputs: [{}] }]), /Sans numéro/);
});

test('at most `most` takes: those the bobine and the request name first, then the newest (0.6.161)', () => {
  const many = Array.from({ length: 50 }, (_, at) => (at % 3 ? photo(at + 1, `Image ${at + 1}.`) : clip(at + 1, 5, `Vidéo ${at + 1}.`)));
  const montage = bobine([shown(61, 4, 0, 0, 5), todo(62, 5, 5, 'La suite.', { photos: { end: source(8) } })]),
    listed = text => lines(text).filter(line => /^prise \d+,/.test(line)).map(line => Number(/^prise (\d+)/.exec(line)[1]));
  const text = bobineText(montage, many, { most: 6, request: 'reprends la prise 10 et les prises 20 à 21, puis la prise 99' });
  // The bobine's (4, its photo 8), the request's (10, 20, 21), then the newest (50), listed by number.
  assert.deepEqual(listed(text), [4, 8, 10, 20, 21, 50]);
  assert.match(text, /\nThe takes of the project you may name \(6 of 50, the older ones left out\):\n/);
  assert.match(text, /\nNot in this project: prise 99\.$/);
  // By the default, forty; the newest by when they were made, not by their number.
  assert.equal(listed(bobineText(empty(), many)).length, 40);
  const older = many.map(item => (item.outputs[0].take === 2 ? { ...item, createdAt: '2026-11-21T08:00:00.000Z' } : item));
  assert.deepEqual(listed(bobineText(empty(), older, { most: 2 })), [2, 50]);
  // Fewer than `most`: all, without saying any is left out.
  assert.match(bobineText(empty(), many.slice(0, 3)), /\nThe takes of the project you may name:\n/);
  // arrangeMessages hands its request over: the takes it names are kept.
  assert.ok(listed(userOf(arrangeMessages({ montage: empty(), takes: many, request: 'pose la prise 1', most: 1 }))).includes(1));
});

test('the earlier requests and the standing instructions are in the message, the request last (0.6.161)', () => {
  const [system, user] = arrangeMessages({ montage: FILM(), takes: TAKES, request: `  ${REQUEST}  `, previous: PREVIOUS, preferences: '  Des plans courts,\nen noir et blanc.  ' }).map(
    message => message.content,
  );
  const parts = user.split('\n\n');
  assert.deepEqual(parts.slice(-3), [
    'Earlier requests on this bobine, oldest first (the bobine above is what came of them):\n' +
      '- « crée une vidéo sur le thème de l’espace » You answered: « J’ai posé quatre prises : le décollage, l’orbite et la Lune. »\n' +
      '- « ajoute une image de la Terre » You answered: « J’ai ajouté la prise 3 comme photo de fin. »\n' +
      '- « une prise à créer après la vidéo de la capsule »',
    "The user's standing instructions, which come first where they differ: Des plans courts, en noir et blanc.",
    `The request (say in its language, every text in English):\n« ${REQUEST} »\nAnswer with the JSON plan only.`,
  ]);
  assert.equal(user.includes('fais un essai'), false, 'the three last only');
  assert.equal(system.includes('noir et blanc'), false);
  // Neither said when there is none.
  const plain = userOf(arrangeMessages({ montage: FILM(), takes: TAKES, request: 'invente la suite', previous: [{ request: '  ', say: 'x' }, null] }));
  assert.equal(/Earlier requests|standing instructions/.test(plain), false);
  assert.ok(plain.endsWith('The request (say in its language, every text in English):\n« invente la suite »\nAnswer with the JSON plan only.'));
});

test('an empty bobine and a project without takes read plainly (0.6.161)', () => {
  assert.equal(
    userOf(arrangeMessages({ montage: empty(), takes: [], request: 'crée une vidéo sur le thème de l’espace' })),
    'The bobine is empty: what you add opens the film, and its first take is a cut.\n\n' +
      'The project has no image or video yet: start and end stay null, and add holds only takes to create.\n\n' +
      'The request (say in its language, every text in English):\n« crée une vidéo sur le thème de l’espace »\nAnswer with the JSON plan only.',
  );
  // Nothing given at all: still a message, without « undefined » or « NaN ».
  for (const messages of [arrangeMessages({}), arrangeMessages({ montage: null, takes: null, previous: 'x', most: Number.NaN })]) {
    assert.doesNotMatch(messages[1].content, /undefined|NaN|\[object/);
    assert.doesNotMatch(messages[1].content.replace('start and end stay null', ''), /null/);
  }
  assert.match(userOf(arrangeMessages({})), /\n\(no words: go on with the film\)\n/);
  // The takes of a project laid on an empty bobine: listed, none on the bobine.
  assert.doesNotMatch(bobineText(empty(), TAKES), /laid as|photo of/);
});

test('the message that asks for the plan again says why (0.6.161)', () => {
  assert.deepEqual(retryMessage('Moodix AI n’a pas rendu de plan lisible.'), {
    role: 'user',
    content:
      'Your answer could not be read as the plan: Moodix AI n’a pas rendu de plan lisible.\n' +
      'Answer again with the JSON plan only, {"say": "...", "fill": [...], "add": [...]}, with no words before or after it.',
  });
  assert.match(retryMessage('  il manque add\n et fill ').content, /^Your answer could not be read as the plan: il manque add et fill\.\n/);
  assert.match(retryMessage().content, /^Your answer could not be read as the plan\.\nAnswer again/);
});

test('a whole message, for reading (0.6.161)', t => {
  const messages = arrangeMessages({ montage: FILM(), takes: TAKES, request: REQUEST, previous: PREVIOUS.slice(1, 2), preferences: 'Des plans courts.' });
  // (One line of the report for each line of the message: TAP writes a line break of a diagnostic as « \n ».)
  for (const message of messages) {
    t.diagnostic(`--- ${message.role} (${message.content.length} characters) ---`);
    for (const line of message.content.split('\n')) t.diagnostic(line || ' ');
  }
  assert.ok(messages[1].content.length < 4000);
});

test('the simple form, for the local model: one list, no fill, images and videos apart (0.6.161)', () => {
  // (Measured on 20/11 on his card, Qwen3.5 9B, 24 requests, every plan read: given two lists, it wrote
  // its film in `fill` and laid a part of it only in `add`; it gave videos as start and end images.
  // With this form: his own example held twice of two, the lengths asked twice of two, none before.)
  const [system, user] = arrangeMessages({ montage: FILM(), takes: TAKES, request: REQUEST, previous: PREVIOUS, preferences: 'Des plans courts.', simple: true }),
    [other] = arrangeMessages({ montage: empty(), takes: [], request: 'autre chose', simple: true }),
    [whole] = arrangeMessages({ montage: FILM(), takes: TAKES, request: REQUEST });
  // Its instructions: the same for every request, shorter than the others, and no `fill` anywhere.
  assert.equal(system.content, other.content);
  assert.ok(system.content.length < whole.content.length && system.content.length < 1800, `${system.content.length} characters`);
  assert.doesNotMatch(system.content, /fill/);
  assert.match(system.content, /\{"say": "\.\.\.", "add": \[\.\.\.\]\}/);
  assert.match(system.content, /Every take of your film is in add; the blocks already on the bobine are not\./);
  assert.match(system.content, /Only images, never a video\./);
  assert.doesNotMatch(system.content, /prise \d|take \d|block \d|#\d/i);
  assert.doesNotMatch(system.content, UUID);
  // Its message: the takes to create without a text are not listed for it to write; the images and the
  // videos of the project are two lists of their own.
  const text = user.content;
  assert.doesNotMatch(text, /Takes to create with no text yet/);
  assert.doesNotMatch(text, /The takes of the project you may name/);
  const images = text.indexOf('The images of the project, to start or to end a take on:'),
    videos = text.indexOf('The videos of the project, never a start nor an end:');
  assert.ok(images > 0 && videos > images);
  assert.deepEqual(
    lines(text.slice(images, videos).trim()).slice(1).map(line => line.split(',')[0]),
    ['prise 1', 'prise 3', 'prise 6'],
  );
  assert.deepEqual(
    lines(text.slice(videos)).slice(1, 4).map(line => line.split(',')[0]),
    ['prise 2', 'prise 4', 'prise 7'],
  );
  assert.doesNotMatch(text, UUID);
  // Asked again after an answer that could not be read: its own shape.
  assert.match(retryMessage('x', { simple: true }).content, /\{"say": "\.\.\.", "add": \[\.\.\.\]\}/);
  assert.doesNotMatch(retryMessage('x', { simple: true }).content, /fill/);
  // The other form is as it was.
  assert.match(userOf(arrangeMessages({ montage: FILM(), takes: TAKES, request: REQUEST })), /Takes to create with no text yet: block 5\./);
});
