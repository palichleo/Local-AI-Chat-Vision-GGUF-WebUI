import test from 'node:test';
import assert from 'node:assert/strict';
import { renderProposal } from '../public/video-plan.mjs';

class Node {
  constructor(tag, className = '', text = '') {
    Object.assign(this, { tag, className, textContent: text, children: [], attributes: {}, value: '', options: [] });
  }
  // As in a page: a node added elsewhere leaves where it was.
  append(...children) {
    for (const child of children) {
      if (child instanceof Node) {
        if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child);
        child.parent = this;
      }
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
    this.options = [];
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  add(option) {
    this.options.push(option);
    if (this.options.length === 1 && !this.value) this.value = option.value;
  }
}
globalThis.Option ??= class {
  constructor(text, value) {
    Object.assign(this, { text, value });
  }
};
const node = (tag, className, text) => new Node(tag, className, text);
const all = root => [root, ...root.children.flatMap(child => (child instanceof Node ? all(child) : []))];
const text = root =>
  all(root)
    .map(item => item.textContent)
    .join(' ');
const labelled = (root, label) =>
  all(root).find(item => item.tag === 'label' && item.children[0]?.textContent === label)?.children[1];

function proposal(overrides = {}) {
  return {
    mediaType: 'video',
    workflowName: 'LTX 2.5',
    plan: {
      stage: 'draft',
      intention: 'Le tigre court.',
      prompt: 'A tiger runs',
      parameters: { width: 384, height: 256, frames: 121, fps: 24, seed: 7, audio: true, steps: 8 },
      references: [
        { input: 'subject-1', role: 'msr_image', roleLabel: 'Sujet', label: 'Upscale SeedVR2' },
      ],
      editable: {
        prompt: true,
        stages: ['draft', 'final'],
        references: [
          [
            { role: 'start_image', label: 'Image de début' },
            { role: 'end_image', label: 'Image de fin' },
            { role: 'msr_image', label: 'Sujet' },
          ],
        ],
        parameters: [
          { key: 'width', value: 384, type: 'integer', min: 64, max: 4096, multipleOf: 32 },
          { key: 'height', value: 256, type: 'integer', min: 64, max: 4096, multipleOf: 32 },
          { key: 'frames', value: 121, type: 'integer', choices: [9, 73, 121, 241] },
          { key: 'fps', value: 24, type: 'number', min: 1, max: 60 },
          { key: 'seed', value: 7, type: 'integer', min: 0, max: 9007199254740991 },
          { key: 'audio', value: true, type: 'boolean' },
          { key: 'steps', value: 8, type: 'integer', choices: [8] },
        ],
      },
      ...overrides,
    },
  };
}

test('the proposal is one form: prompt, inputs, version, length, format, resolution and seed in view', () => {
  const box = node('section');
  const form = renderProposal(box, proposal(), { node });
  assert.match(text(box), /Le tigre court/);
  assert.equal(labelled(box, 'Prompt').value, 'A tiger runs');
  assert.equal(labelled(box, 'Version').value, 'draft');
  assert.deepEqual(
    labelled(box, 'Durée').options.map(option => option.text),
    ['0,38 s', '3,04 s', '5,04 s', '10,04 s'],
  );
  assert.equal(labelled(box, 'Format').value, '3:2');
  assert.equal(labelled(box, 'Résolution').value, '384x256');
  assert.ok(labelled(box, 'Résolution').options.every(option => /^\d+ × \d+$/.test(option.text)));
  // The role of an input is a French word, and can be changed.
  assert.doesNotMatch(text(box), /msr_image/);
  assert.equal(all(box).find(item => item.attributes['aria-label'] === 'Rôle de Upscale SeedVR2').value, 'msr_image');
  // Cadence and audio are in the advanced settings, the length only once (in seconds).
  const advanced = all(box).find(item => item.className === 'proposal-advanced');
  assert.ok(
    !labelled(advanced, 'Images') && !labelled(advanced, 'Durée (images)'),
    'no frame count next to the duration',
  );
  for (const label of ['Cadence (i/s)', 'Audio', 'Largeur', 'Hauteur', 'Étapes'])
    assert.ok(labelled(advanced, label), label);
  assert.ok(!labelled(advanced, 'Graine'), 'the seed is shown once');
  assert.deepEqual(form.edits(), {});
});

test('format, length and role changes become the edits sent to the server', () => {
  const box = node('section');
  const form = renderProposal(box, proposal(), { node });
  const format = labelled(box, 'Format');
  format.value = '9:16';
  format.onchange();
  // Portrait at the same scale: still a draft size.
  assert.equal(labelled(box, 'Résolution').value, '288x512');
  assert.equal(labelled(box, 'Largeur').value, '288');
  const duration = labelled(box, 'Durée');
  duration.value = '73';
  const role = all(box).find(item => item.attributes['aria-label'] === 'Rôle de Upscale SeedVR2');
  role.value = 'start_image';
  labelled(box, 'Prompt').value = 'A tiger sprints';
  assert.deepEqual(form.edits(), {
    prompt: 'A tiger sprints',
    references: [{ index: 0, role: 'start_image' }],
    frames: 73,
    width: 288,
    height: 512,
  });
});

test('subject-reference settings show only while an input is a subject reference', () => {
  const box = node('section');
  const request = proposal();
  request.plan.editable.parameters.push(
    { key: 'msr_frames', value: 33, type: 'integer', choices: [25, 33] },
    { key: 'msr_strength', value: 1, type: 'number', min: 0, max: 1 },
  );
  const form = renderProposal(box, request, { node });
  const wrapper = label => all(box).find(item => item.tag === 'label' && item.children[0]?.textContent === label);
  assert.equal(wrapper('Longueur des références (images)').hidden, false);
  assert.match(text(wrapper('Longueur des références (images)')), /court plan fixe/);
  // (0.6.190) What they do, said of « sujets »: the cases that receive a character, an object or a place.
  assert.match(text(wrapper('Longueur des références (images)')), /Chaque sujet est montré au modèle comme un court plan fixe de ce nombre d’images, avant la vidéo : plus long, il pèse un peu plus/);
  assert.match(text(wrapper('Force des références')), /À quel point la vidéo suit ses sujets \(1 : au plus près\)\./);
  const role = all(box).find(item => item.attributes['aria-label'] === 'Rôle de Upscale SeedVR2');
  role.value = 'start_image';
  role.onchange();
  assert.equal(wrapper('Longueur des références (images)').hidden, true);
  assert.equal(wrapper('Force des références').hidden, true);
  assert.deepEqual(form.edits(), { references: [{ index: 0, role: 'start_image' }] });
});

test('a length without fixed choices stays editable in frames', () => {
  const box = node('section');
  const request = proposal();
  request.plan.editable.parameters[2] = { key: 'frames', value: 121, type: 'integer', min: 9, max: 241 };
  const form = renderProposal(box, request, { node });
  labelled(box, 'Durée (images)').value = '97';
  assert.equal(form.edits().frames, 97);
});

test('a size typed by hand is kept as « Autre », and invalid values are refused in words', () => {
  const box = node('section');
  const form = renderProposal(box, proposal(), { node });
  labelled(box, 'Largeur').value = '1000';
  labelled(box, 'Hauteur').value = '320';
  labelled(box, 'Largeur').onchange();
  assert.equal(labelled(box, 'Format').value, 'custom');
  assert.throws(() => form.edits(), /Largeur : multiple de 32/);
  labelled(box, 'Largeur').value = '992';
  labelled(box, 'Largeur').onchange();
  assert.deepEqual(form.edits(), { width: 992, height: 320 });
  labelled(box, 'Prompt').value = '  ';
  assert.throws(() => form.edits(), /prompt ne peut pas être vide/);
});

test('the seed gets a new random value from its button, within its limits', () => {
  const box = node('section');
  const form = renderProposal(box, proposal(), { node });
  const roll = all(box).find(item => item.attributes['aria-label'] === 'Graine au hasard');
  roll.onclick();
  const { seed } = form.edits();
  assert.ok(Number.isSafeInteger(seed) && seed >= 0);
});

test('a continuation keeps its size and counts the seconds it adds', () => {
  const box = node('section');
  const request = proposal({
    parameters: { width: 768, height: 448, frames: 141, fps: 24, overlap_frames: 22, seed: 1 },
    references: [
      { input: 'source', role: 'source_video', roleLabel: 'Vidéo à prolonger', label: 'Résultat précédent' },
    ],
  });
  request.plan.editable = {
    prompt: true,
    stages: [],
    references: [[]],
    parameters: [
      { key: 'width', value: 768, type: 'integer', locked: 'Une continuation garde la taille de sa vidéo source.' },
      { key: 'height', value: 448, type: 'integer', locked: 'Une continuation garde la taille de sa vidéo source.' },
      { key: 'frames', value: 141, type: 'integer', choices: [124, 141] },
    ],
  };
  renderProposal(box, request, { node });
  assert.ok(!labelled(box, 'Format'), 'no format choice for a continuation');
  assert.equal(labelled(box, 'Résolution').textContent, '768 × 448');
  assert.deepEqual(
    labelled(box, 'Durée ajoutée').options.map(option => option.text),
    ['+4,25 s', '+4,96 s'],
  );
  assert.match(text(box), /Vidéo à prolonger/);
});

test('computed values never masquerade as numbers', () => {
  const box = node('section');
  renderProposal(
    box,
    {
      workflowName: 'User video',
      mediaType: 'video',
      plan: {
        prompt: 'Move',
        intention: 'A draft',
        parameters: { width: ['size', 0], height: 512, frames: 81, fps: ['rate', 0], seed: ['random', 0] },
        editable: {},
      },
    },
    { node },
  );
  assert.doesNotMatch(text(box), /size,0 ×|Durée|rate,0|random,0/);
});

test('a sound proposal shows its lyrics, length and language in view, and edits them as text and numbers', () => {
  const box = node('section');
  const form = renderProposal(
    box,
    {
      mediaType: 'audio',
      workflowName: 'Musique (ACE-Step 1.5 XL)',
      plan: {
        prompt: 'synth-pop, 110 BPM',
        parameters: { prompt: 'synth-pop, 110 BPM', lyrics: '[Verse]\nLa nuit', seconds: 60, language: 'fr', seed: 3 },
        references: [],
        editable: {
          prompt: true,
          stages: [],
          references: [],
          parameters: [
            { key: 'lyrics', value: '[Verse]\nLa nuit', type: 'string', maxLength: 20 },
            { key: 'seconds', value: 60, type: 'number', min: 10, max: 600 },
            { key: 'language', value: 'fr', type: 'string', choices: ['en', 'fr'] },
            { key: 'seed', value: 3, type: 'integer', min: 0, max: 9007199254740991 },
          ],
        },
      },
    },
    { node },
  );
  assert.match(text(box), /Proposition de son/);
  assert.equal(labelled(box, 'Paroles').tag, 'textarea');
  assert.match(text(box), /Vide pour un morceau instrumental/);
  assert.equal(labelled(box, 'Durée (s)').value, '60');
  assert.equal(labelled(box, 'Langue').value, 'fr');
  assert.ok(!all(box).some(item => item.className === 'proposal-advanced'), 'nothing left for the advanced settings');
  assert.deepEqual(form.edits(), {});
  labelled(box, 'Paroles').value = '';
  labelled(box, 'Durée (s)').value = '30';
  labelled(box, 'Langue').value = 'en';
  assert.deepEqual(form.edits(), { lyrics: '', seconds: 30, language: 'en' });
  labelled(box, 'Paroles').value = 'x'.repeat(21);
  assert.throws(() => form.edits(), /Paroles : 20 caractères au plus/);
});

test('in the card of the conversation: the length in one click, version and seed advanced, the prompt folded', () => {
  const box = node('section'),
    request = proposal();
  request.inputRoles = ['start_image', 'end_image', 'source_video', 'msr_image', 'msr_image'];
  request.plan.references[0].preview = '/media/ref.png';
  const form = renderProposal(box, request, { node, card: true });
  // The inputs as pictures: DÉBUT and FIN to give, a rule, SUJET 1 (0.6.190), and one more the workflow takes.
  const media = all(box).find(item => item.className === 'proposal-media');
  assert.deepEqual(
    media.children.map(item => [item.className, item.children[1]?.textContent ?? '']),
    [
      ['proposal-input is-empty', 'DÉBUT'],
      ['proposal-input is-empty', 'FIN'],
      ['proposal-media-rule', ''],
      ['proposal-input is-reference', 'SUJET 1'],
      ['proposal-input is-empty is-reference', ''],
    ],
  );
  assert.equal(media.children[3].children[0].children[0].src, '/media/ref.png');
  assert.equal(media.children[4].children[0].attributes['aria-label'], 'Ajouter un sujet');
  assert.equal(media.children[0].children[0].disabled, true, 'nothing to join an image with: greyed');
  // The prompt is folded at the foot of the card, with its way back to the prompt of Moodix.
  assert.equal(labelled(box, 'Prompt'), undefined);
  assert.deepEqual(
    form.folds.map(fold => fold.name),
    ['Paramètres avancés', 'Prompt'],
  );
  const [advanced, folded] = form.folds.map(fold => fold.panel);
  assert.equal(labelled(folded, 'Prompt').value, 'A tiger runs');
  assert.equal(all(folded).find(item => item.className === 'proposal-back').textContent, 'Revenir au prompt de Moodix');
  // The version and the seed are advanced settings in a card.
  assert.equal(labelled(advanced, 'Version').value, 'draft');
  assert.ok(labelled(advanced, 'Graine'));
  assert.equal(labelled(box, 'Version'), undefined);
  // The length in one click: the whole seconds the model accepts, and the one proposed, marked.
  const lengths = all(box).find(item => item.className === 'proposal-lengths'),
    buttons = lengths.children.filter(item => item.tag === 'button');
  assert.deepEqual(
    buttons.map(item => [item.textContent, item.attributes['aria-checked'], item.className]),
    [
      ['5', 'true', 'proposal-length is-proposed'],
      ['10', 'false', 'proposal-length'],
    ],
  );
  buttons[1].onclick();
  assert.deepEqual(form.edits(), { frames: 241 });
  // The role of an input may change under « Paramètres avancés »; the size is not repeated there.
  assert.ok(all(advanced).some(item => item.attributes['aria-label'] === 'Rôle de Upscale SeedVR2'));
  assert.ok(!labelled(advanced, 'Largeur') && !labelled(advanced, 'Hauteur'));
  // The choice of Moodix marked « proposé » in the open menu only: closed, the value alone.
  const format = labelled(box, 'Format'),
    marked = () => format.options.filter(option => option.text.endsWith(' · proposé')).map(option => option.value);
  assert.deepEqual(marked(), []);
  format.onmousedown();
  assert.deepEqual(marked(), ['3:2']);
  format.onblur();
  assert.deepEqual(marked(), []);
  // In the page a list is a menu of glass (glass-menu.mjs) and is never pressed itself: the choice
  // of Moodix carries its note, which that menu shows; the sizes too, rebuilt with each format.
  const noted = control => control.options.filter(option => option.dataset?.note === 'proposé').map(option => option.value),
    resolution = labelled(box, 'Résolution');
  assert.deepEqual(noted(format), ['3:2']);
  assert.deepEqual(noted(resolution), ['384x256']);
  format.value = '16:9';
  format.onchange();
  assert.deepEqual(noted(format), ['3:2']);
  assert.deepEqual(noted(resolution), [], 'no size of another format is the one proposed');
  format.value = '3:2';
  format.onchange();
  assert.deepEqual(noted(resolution), ['384x256']);
});

test('an image made from another: « Débruitage » among the advanced settings with its bounds; without an image the server lists none', () => {
  // As lib/tool-runtime.mjs describes a proposal of Krea 2 (its denoise left between 0.6 and 0.7).
  const image = source => ({
    workflowName: 'Krea 2',
    plan: {
      prompt: 'The same staircase at night.',
      parameters: { width: 1024, height: 1024, seed: 7, steps: 8, denoise: source ? 0.6 : 1 },
      references: source ? [{ input: 'source', role: 'img2img', roleLabel: 'Image à modifier', label: '#ref1' }] : [],
      editable: {
        prompt: true,
        stages: [],
        references: source ? [[{ role: 'img2img', label: 'Image à modifier' }]] : [],
        parameters: [
          { key: 'width', value: 1024, type: 'integer', min: 64, max: 4096, multipleOf: 16 },
          { key: 'height', value: 1024, type: 'integer', min: 64, max: 4096, multipleOf: 16 },
          { key: 'seed', value: 7, type: 'integer', min: 0, max: 9007199254740991 },
          ...(source ? [{ key: 'denoise', value: 0.6, type: 'number', min: 0.6, max: 0.7, note: 'Part de l’image refaite.' }] : []),
        ],
      },
    },
  });
  const box = node('section');
  const form = renderProposal(box, image(true), { node });
  const denoise = labelled(box, 'Débruitage');
  assert.deepEqual([denoise.type, denoise.value, denoise.min, denoise.max, denoise.step], ['number', '0.6', '0.6', '0.7', 'any']);
  assert.match(text(box), /Part de l’image refaite\./);
  assert.deepEqual(form.edits(), {});
  denoise.value = '0.65';
  assert.deepEqual(form.edits(), { denoise: 0.65 });
  // Outside its bounds: said in words before anything is sent.
  for (const value of ['0.75', '0.5']) {
    denoise.value = value;
    assert.throws(() => form.edits(), { message: 'Débruitage : entre 0,6 et 0,7.' });
  }
  // Without an image to modify the picture is made from nothing: no such setting to change.
  const alone = node('section');
  renderProposal(alone, image(false), { node });
  assert.equal(labelled(alone, 'Débruitage'), undefined);
  assert.ok(labelled(alone, 'Largeur'));
});

test('in a card a source says what is done with it, « À MODIFIER », « À PROLONGER », « À SUIVRE »; a subject is « SUJET 1 » (0.6.190)', () => {
  // (0.6.190, captures 105 and 107) « SOURCE » said nothing of what the model does with it. The end of the name the
  // server gives its role does (runner/families: « Image à modifier », « Vidéo à prolonger », « Vidéo à suivre »),
  // by its role alone when the proposal names none. The data keep their keys: only the word shown changes.
  const captions = request => {
    const box = node('section');
    renderProposal(box, request, { node, card: true });
    return all(box)
      .find(item => item.className === 'proposal-media')
      .children.map(item => item.children[1]?.textContent ?? '');
  };
  const card = (mediaType, workflowName, inputRoles, references, options) => ({
    mediaType,
    workflowName,
    inputRoles,
    plan: {
      prompt: 'x',
      parameters: { width: 768, height: 448, frames: 121, fps: 24, seed: 7 },
      references,
      editable: {
        prompt: true,
        stages: [],
        references: options ?? references.map(ref => [{ role: ref.role, label: ref.roleLabel }]),
        parameters: [],
      },
    },
  });
  // Krea 2: the image it modifies.
  assert.deepEqual(captions(card('image', 'Krea 2', ['img2img'], [{ input: 'source', role: 'img2img', roleLabel: 'Image à modifier', label: '#ref1' }])), ['À MODIFIER']);
  // MiniMax H3: the clip it continues, then a subject, and a case for one more.
  assert.deepEqual(
    captions(
      card('video', 'MiniMax H3 Omni', ['source_video', 'reference_image', 'reference_image'], [
        { input: 'source', role: 'source_video', roleLabel: 'Vidéo à prolonger', label: 'Prise 4' },
        { input: 'subject-1', role: 'reference_image', roleLabel: 'Sujet', label: 'Prise 2' },
      ]),
    ),
    ['À PROLONGER', '', 'SUJET 1', ''],
  );
  // SCAIL-2: the video it follows, then who is put in it.
  assert.deepEqual(
    captions(
      card('video', 'Wan 2.1 SCAIL-2', ['driving_video', 'reference_image'], [
        { input: 'video', role: 'driving_video', roleLabel: 'Vidéo à suivre', label: 'Prise 5' },
        { input: 'character', role: 'reference_image', roleLabel: 'Personnage', label: 'Prise 2' },
      ]),
    ),
    ['À SUIVRE', '', 'SUJET 1'],
  );
  // RIFE and Real-ESRGAN: the same role as a continuation, other names, other words; read in the list « Rôle » of
  // the card, else in the name sent with the input.
  assert.deepEqual(
    captions(card('video', 'Interpoler (RIFE 4.26)', ['source_video'], [{ input: 'source', role: 'source_video', label: 'Prise 4' }], [[{ role: 'source_video', label: 'Vidéo à fluidifier' }]])),
    ['À FLUIDIFIER'],
  );
  assert.deepEqual(
    captions(card('video', 'Upscale vidéo (Real-ESRGAN ×2)', ['source_video'], [{ input: 'source', role: 'source_video', roleLabel: 'Vidéo à agrandir', label: 'Prise 4' }], [])),
    ['À AGRANDIR'],
  );
  // Its name unknown (its role alone): the word of its role all the same.
  assert.deepEqual(captions(card('image', 'Krea 2', ['img2img'], [{ input: 'source', role: 'img2img', label: '#ref1' }], [])), ['À MODIFIER']);
});
