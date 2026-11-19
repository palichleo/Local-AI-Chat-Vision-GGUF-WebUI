import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { ToolCatalog, serves } from '../lib/tool-catalog.mjs';
import { families } from '../lib/families.mjs';
import { fits, modelsOf, versionComponent } from '../lib/model-files.mjs';
import { isCompanion, recipeOf, versionName } from '../lib/model-versions.mjs';
import { ownSettings, validateNativeWorkflow } from '../lib/native-workflows.mjs';
import { isSetting } from '../public/setting-names.mjs';

// (0.6.134) Wan 2.2, image to video, as Moodix ships it: the user's request of 19/11 (« intègre wan2.2 »).
const folder = new URL('../runner/workflows/', import.meta.url);
const shipped = readdirSync(folder)
  .filter(name => name.endsWith('.json'))
  .sort()
  .map(name => ({ ...JSON.parse(readFileSync(new URL(name, folder), 'utf8')), ready: true, builtin: true }));
const wan = shipped.find(workflow => workflow.pipeline === 'wan22');
const catalog = new ToolCatalog({ list: async () => shipped });
const media = { mediaOf: async () => 'image' };
const asked = { prompt: 'The fox turns its head and runs off.', intention: 'Le renard part en courant.' };

test('Wan 2.2 is shipped as a model that animates an image, its settings the user’s own (0.6.134)', () => {
  assert.equal(shipped.filter(workflow => workflow.pipeline === 'wan22').length, 1);
  const { ready, builtin, ...plain } = wan,
    { digest, ...valid } = validateNativeWorkflow(plain);
  assert.deepEqual(valid, plain);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(serves(wan, 'create_video'), true);
  for (const verb of ['extend_video', 'replace_character', 'create_image']) assert.equal(serves(wan, verb), false, verb);
  // An image to start from, and nothing else: the model draws from it.
  assert.deepEqual(wan.references, [{ id: 'start', role: 'start_image', required: true, name: 'Image de début' }]);
  // What Moodix AI may choose: the prompt and the length (the seed is drawn). Every setting has a
  // value of Moodix, which the user alone changes (the rule of 19/11).
  const p = wan.parameters;
  assert.deepEqual(
    Object.keys(p).filter(name => p[name].policy !== 'fixed'),
    ['prompt', 'seed', 'frames'],
  );
  for (const name of Object.keys(p)) if (isSetting(name)) assert.equal(p[name].policy, 'fixed', name);
  assert.deepEqual(ownSettings(plain), plain);
  // The values of the official configuration (wan/configs/wan_i2v_A14B.py): guidance, shift, rate.
  assert.deepEqual([p.cfg.value, p.shift.value, p.fps.value, p.frames.default], [3.5, 5, 16, 81]);
  assert.match(p.negative_prompt.value, /^色调艳丽，过曝，静态/);
  // Every length is 4n + 1 frames, as the model draws them.
  assert.ok(p.frames.choices.every(count => count % 4 === 1));
  assert.deepEqual(p.frames.choices, families().wan22.parameters.frames.choices);
});

test('a video that starts on an image still goes to LTX 2.5; Wan 2.2 makes it when it is named (0.6.134)', async () => {
  // (Its only input filled, Wan 2.2 would be « the most specific workflow »: a clip without sound,
  // minutes long to make, in the place of the one the user always had.)
  const usual = await catalog.route('create_video', { ...asked, duration: null, start_image: { image: 0 } }, media);
  assert.equal(usual.workflow.pipeline, 'ltx25');
  assert.ok(families().wan22.preference < 0);
  const named = await catalog.route(
    'create_video',
    { ...asked, duration: 3, workflow: wan.id, start_image: { image: 0 } },
    media,
  );
  assert.equal(named.workflow.id, wan.id);
  // Three seconds at 16 frames a second: 49 frames, the closest length the model draws.
  assert.equal(named.args.frames, 49);
  assert.deepEqual(named.args.references, [{ input: 'start', image: 0 }]);
  // No length asked: its usual five seconds.
  const plain = await catalog.route(
    'create_video',
    { ...asked, duration: null, workflow: wan.id, start_image: { image: 0 } },
    media,
  );
  assert.equal(plain.args.frames, 81);
  // What it does not take is said, never passed on: a stage (it has one size), steps (a setting).
  const staged = await catalog.route(
    'create_video',
    { ...asked, duration: null, workflow: wan.id, start_image: { image: 0 }, stage: 'final', steps: 40 },
    media,
  );
  assert.deepEqual([staged.args.stage, staged.args.steps], [undefined, undefined]);
  assert.equal(staged.notes.length, 2, staged.notes.join(' | '));
  // Without an image it cannot draw: another model makes the video, and the user is told.
  const bare = await catalog.route('create_video', { ...asked, duration: null, workflow: wan.id }, media);
  assert.notEqual(bare.workflow.pipeline, 'wan22');
  // (It was said « ne prend pas ces entrées ensemble », of a request that passed none.)
  assert.deepEqual(bare.notes, [`Wan 2.2 ne se fait pas sans « Image de début » : ${bare.workflow.name} est utilisé à la place.`]);
  // With an end image beside the start one, which it does not take: the usual words.
  const framed = await catalog.route(
    'create_video',
    { ...asked, duration: null, workflow: wan.id, start_image: { image: 0 }, end_image: { image: 1 } },
    media,
  );
  assert.deepEqual(framed.notes, ['Wan 2.2 ne prend pas ces entrées ensemble : LTX 2.5 est utilisé à la place.']);
});

test('a chat model reads Wan 2.2 after the models that make a video from words, and none of its settings (0.6.134)', async () => {
  const tool = (await catalog.definitions()).find(item => item.function.name === 'create_video').function;
  const at = name => tool.description.indexOf(`: ${name}. `);
  assert.ok(at('Wan 2.2') > at('LTX 2.5') && at('LTX 2.5') > 0 && at('Wan 2.2') > at('MiniMax H3 Omni'));
  assert.match(tool.description, /Wan 2\.2\. Animer une image : .* \(accepts: start_image\)/);
  for (const setting of ['steps', 'cfg', 'shift', 'negative_prompt', 'fps', 'width', 'height'])
    assert.equal(Object.hasOwn(tool.parameters.properties, setting), false, setting);
  // The Studio: after the two others, an image to start from it cannot do without, its lengths.
  const studio = (await catalog.studio()).create_video;
  assert.deepEqual(studio.map(item => item.family).sort(), ['ltx25', 'minimax_h3', 'wan22']);
  assert.equal(studio.at(-1).family, 'wan22');
  const own = studio.at(-1);
  assert.equal(own.roles.start_image.required, true);
  assert.deepEqual([own.roles.end_image.count, own.roles.reference.count], [0, 0]);
  assert.deepEqual(own.size, { width: 768, height: 448 });
  assert.deepEqual(own.lengths.seconds, [33, 49, 65, 81].map(count => count / 16));
  assert.equal(own.lengths.standard, 81 / 16);
});

test('the two files of Wan 2.2 are one version: the « low noise » file goes with the « high noise » one (0.6.134)', () => {
  const manifest = families().wan22,
    { role, spec } = versionComponent(manifest);
  assert.equal(role, 'model');
  // What the user's files hold (19/11): 36 channels in, forty blocks, no image encoder.
  const shapes = { 'patch_embedding.weight': [5120, 36, 1, 2, 2], 'blocks.39.self_attn.q.weight': [5120, 5120] };
  assert.equal(fits(shapes, spec.fingerprint), true);
  assert.deepEqual(modelsOf({ shapes }), ['wan22']);
  // Wan 2.1 image to video has an image encoder; text to video takes 16 channels; the 5B model 48.
  assert.deepEqual(modelsOf({ shapes: { ...shapes, 'img_emb.proj.0.weight': [1280] } }), []);
  for (const channels of [16, 48])
    assert.deepEqual(modelsOf({ shapes: { ...shapes, 'patch_embedding.weight': [5120, channels, 1, 2, 2] } }), []);
  const recipe = recipeOf(spec, { shapes });
  assert.equal(recipe.companion.role, 'modelLow');
  const second = file => isCompanion(recipe, { metadata: {} }, file);
  assert.equal(second('wan2.2_i2v_low_int8_convrot.safetensors'), true);
  assert.equal(second('Wan2_2-I2V-A14B-LOW_bf16.safetensors'), true);
  assert.equal(second('wan2.2_i2v_high_int8_convrot.safetensors'), false);
  // (« low » inside another word says nothing.)
  assert.equal(second('wan2.2_i2v_high_noise_slow_motion.safetensors'), false);
  assert.equal(versionName('wan2.2_i2v_high_int8_convrot.safetensors', manifest), 'Image vers vidéo');
  // The formats tried: no FP8 file of Wan 2.2 was, none is promised.
  assert.deepEqual(spec.reads, ['INT8', 'BF16', 'FP16', 'FP32']);
});

test('a file of a shipped model has an identifier of its own family: none is shared between two (0.6.134)', () => {
  // (The registry of the files keeps one family an identifier: Wan 2.2 written with the identifiers
  // of the encoder and the VAE of SCAIL-2, the same files, was « Fichier incompatible » on the
  // first real try.)
  const owners = new Map();
  for (const workflow of shipped)
    for (const entry of [...Object.values(workflow.components ?? {}), ...(workflow.loras ?? [])])
      if (entry.asset) owners.set(entry.asset, (owners.get(entry.asset) ?? new Set()).add(workflow.pipeline));
  const sharedIds = [...owners].filter(([, families]) => families.size > 1).map(([id, families]) => [id, [...families]]);
  assert.deepEqual(sharedIds, []);
  assert.equal(new Set(Object.values(wan.components).map(component => component.asset)).size, 4);
});
