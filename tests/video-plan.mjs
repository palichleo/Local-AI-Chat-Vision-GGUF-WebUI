import test from 'node:test';
import assert from 'node:assert/strict';
import { renderProposal } from '../public/video-plan.mjs';

class Node {
  constructor(tag, className = '', text = '') {
    Object.assign(this, { tag, className, textContent: text, children: [], attributes: {}, value: '', options: [] });
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = children;
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
const text = root => all(root).map(item => item.textContent).join(' ');
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
      references: [{ input: 'subject-1', role: 'msr_image', roleLabel: 'Référence de sujet', label: 'Upscale SeedVR2' }],
      editable: {
        prompt: true,
        stages: ['draft', 'final'],
        references: [
          [
            { role: 'start_image', label: 'Image de début' },
            { role: 'end_image', label: 'Image de fin' },
            { role: 'msr_image', label: 'Référence de sujet' },
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
  assert.deepEqual(labelled(box, 'Durée').options.map(option => option.text), ['0,38 s', '3,04 s', '5,04 s', '10,04 s']);
  assert.equal(labelled(box, 'Format').value, '3:2');
  assert.equal(labelled(box, 'Résolution').value, '384x256');
  assert.ok(labelled(box, 'Résolution').options.every(option => /^\d+ × \d+$/.test(option.text)));
  // The role of an input is a French word, and can be changed.
  assert.doesNotMatch(text(box), /msr_image/);
  assert.equal(all(box).find(item => item.attributes['aria-label'] === 'Rôle de Upscale SeedVR2').value, 'msr_image');
  // Frames, cadence and audio are in the advanced settings; nothing changed, nothing sent.
  const advanced = all(box).find(item => item.className === 'proposal-advanced');
  for (const label of ['Images', 'Cadence (i/s)', 'Audio', 'Largeur', 'Hauteur', 'Étapes']) assert.ok(labelled(advanced, label), label);
  assert.ok(!labelled(advanced, 'Seed'), 'the seed is shown once');
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
  duration.onchange();
  assert.equal(labelled(box, 'Images').value, '73', 'the two length controls follow each other');
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
  const roll = all(box).find(item => item.attributes['aria-label'] === 'Seed aléatoire');
  roll.onclick();
  const { seed } = form.edits();
  assert.ok(Number.isSafeInteger(seed) && seed >= 0);
});

test('a continuation keeps its size and counts the seconds it adds', () => {
  const box = node('section');
  const request = proposal({
    parameters: { width: 768, height: 448, frames: 141, fps: 24, overlap_frames: 22, seed: 1 },
    references: [{ input: 'source', role: 'source_video', roleLabel: 'Vidéo à prolonger', label: 'Résultat précédent' }],
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
  assert.deepEqual(labelled(box, 'Durée ajoutée').options.map(option => option.text), ['+4,25 s', '+4,96 s']);
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
