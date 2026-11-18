import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ToolCatalog, serves } from '../lib/tool-catalog.mjs';
import { CAPABLE } from '../lib/model-wording.mjs';

const video = (id, references, extra = {}) => ({
  schemaVersion: 1,
  id,
  name: id,
  description: `Workflow ${id}`,
  enabled: true,
  ready: true,
  pipeline: 'ltx25',
  mediaType: 'video',
  parameters: {
    prompt: { policy: 'model', type: 'string' },
    stage: { policy: 'model', type: 'string', choices: ['draft', 'final'], default: 'draft' },
    fps: { policy: 'fixed', value: 24 },
  },
  components: {},
  loras: [],
  references,
  ...extra,
});
const image = (id, references = []) => ({
  schemaVersion: 1,
  id,
  name: id,
  description: `Workflow ${id}`,
  enabled: true,
  ready: true,
  pipeline: 'krea2',
  mediaType: 'image',
  parameters: { prompt: { policy: 'model', type: 'string' }, width: { policy: 'fixed', value: 512 } },
  components: {},
  loras: [],
  references,
});
const slot = (id, role, required = false) => ({ id, role, required });
const catalogOf = workflows => new ToolCatalog({ list: async () => workflows });
const media = { mediaOf: async source => (source.output === 'video-run' ? 'video' : 'image') };

const workflows = [
  image('portrait'),
  image('edit', [slot('source', 'img2img', true)]),
  video('t2v', []),
  video('keyframes', [slot('first', 'start_image'), slot('last', 'end_image')]),
  video('subject', [slot('a', 'msr_image'), slot('b', 'msr_image')]),
  video('continue', [slot('clip', 'source_video', true)]),
];

test('the model sees one tool per verb with only the roles some workflow accepts', async () => {
  const tools = Object.fromEntries((await catalogOf(workflows).definitions()).map(t => [t.function.name, t.function]));
  assert.deepEqual(Object.keys(tools).sort(), ['create_image', 'create_video', 'extend_video']);
  const create = tools.create_video.parameters;
  assert.deepEqual(Object.keys(create.properties).sort(), [
    'end_image',
    'intention',
    'prompt',
    'reference',
    'stage',
    'start_image',
    'workflow',
  ]);
  assert.equal(create.properties.reference.maxItems, 2);
  assert.deepEqual(create.required.sort(), ['intention', 'prompt']);
  assert.equal(create.properties.fps, undefined, 'fixed parameters are never exposed');
  assert.deepEqual(tools.extend_video.parameters.required.sort(), ['intention', 'prompt', 'source']);
  assert.match(tools.create_video.description, /keyframes.*accepts: start_image, end_image/);
  assert.equal(serves(workflows[5], 'create_video'), false, 'a required source video excludes plain creation');
});

test('roles choose the most specific workflow, and forcing one is still checked', async () => {
  const tools = catalogOf(workflows);
  const route = (name, args) => tools.route(name, { prompt: 'x', intention: 'y', ...args }, media);
  assert.equal((await route('create_video', {})).workflow.id, 't2v');
  assert.equal((await route('create_video', { start_image: { image: 0 } })).workflow.id, 'keyframes');
  const fl = await route('create_video', { start_image: { image: 0 }, end_image: { resource: 'r1' } });
  assert.deepEqual(fl.args.references, [
    { input: 'first', image: 0 },
    { input: 'last', resource_id: 'r1' },
  ]);
  const refs = await route('create_video', { reference: [{ image: 0 }, { output: 'run', index: 1 }] });
  assert.equal(refs.workflow.id, 'subject');
  assert.deepEqual(refs.args.references[1], { input: 'b', output_id: 'run', output_index: 1 });
  await assert.rejects(
    route('create_video', { reference: [{ image: 0 }, { image: 1 }, { image: 2 }] }),
    /Aucun workflow/,
  );
  // A named workflow that cannot take the images gives way to one that can, and says so.
  const moved = await route('create_video', { workflow: 'subject', start_image: { image: 0 } });
  assert.equal(moved.workflow.id, 'keyframes');
  assert.match(moved.notes.join(), /subject ne prend pas ces entrées ensemble : keyframes/);
  assert.equal((await route('create_video', { workflow: 'keyframes' })).workflow.id, 'keyframes', 'named and able');
  await assert.rejects(route('create_video', { workflow: 'nowhere' }), /ne peut pas exécuter/);
  assert.equal((await route('extend_video', { source: { output: 'video-run' } })).workflow.id, 'continue');
  await assert.rejects(route('extend_video', { source: { image: 0 } }), /Aucun workflow/);
  await assert.rejects(route('extend_video', {}), /needs a source/);
  assert.equal((await tools.route('create_image', { prompt: 'x', source: { image: 0 } }, media)).workflow.id, 'edit');
});

test('a plain image request goes to Krea 2; MOSS Image runs when the model asks for it', async () => {
  // MOSS takes no image at all, so it would win as the "most specific" workflow for a text-only
  // request: the Krea family is preferred instead, as the everyday image model.
  const tools = catalogOf([{ ...image('moss-image'), pipeline: 'moss' }, image('krea', [slot('source', 'img2img')])]);
  assert.equal((await tools.route('create_image', { prompt: 'un chat' }, media)).workflow.id, 'krea');
  // Only a family that says what it is the one for is put forward to the model.
  const choice = (await tools.definitions())[0].function.parameters.properties.workflow.description;
  assert.match(choice, /Omit it to let the application pick.* Pass moss-image for a poster/);
  const videos = await catalogOf(workflows).definitions();
  const video = videos.find(tool => tool.function.name === 'create_video').function.parameters.properties.workflow;
  assert.doesNotMatch(video.description, / Pass /);
  assert.equal(
    (await tools.route('create_image', { prompt: 'une affiche', workflow: 'moss-image' }, media)).workflow.id,
    'moss-image',
  );
});

test('MiniMax does not get a start image together with references, even when the model names it', async () => {
  const minimax = {
    ...video('minimax', [slot('s', 'start_image'), slot('e', 'end_image'), slot('r1', 'reference_image')]),
    pipeline: 'minimax_h3',
  };
  const ltx = video('ltx', [slot('first', 'start_image'), slot('a', 'msr_image')]);
  const tools = catalogOf([minimax, ltx]);
  const both = () => ({ prompt: 'x', intention: 'y', start_image: { image: 0 }, reference: [{ image: 1 }] });
  assert.equal((await tools.route('create_video', both(), media)).workflow.id, 'ltx');
  const named = await tools.route('create_video', { ...both(), workflow: 'minimax' }, media);
  assert.equal(named.workflow.id, 'ltx');
  assert.match(named.notes.join(), /minimax ne prend pas ces entrées ensemble/);
  // Alone, MiniMax refuses with the reason instead of failing later in its engine.
  await assert.rejects(catalogOf([minimax]).route('create_video', both(), media), /do not combine/);
  const refs = { prompt: 'x', intention: 'y', reference: [{ image: 1 }], workflow: 'minimax' };
  assert.equal((await tools.route('create_video', refs, media)).workflow.id, 'minimax');
});

test('a MiniMax continuation takes subject references; an LTX one does not yet', async () => {
  const minimax = {
    ...video('minimax-next', [
      slot('clip', 'source_video', true),
      slot('s', 'start_image'),
      slot('r1', 'reference_image'),
      slot('r2', 'reference_image'),
    ]),
    pipeline: 'minimax_h3',
  };
  const ltx = video('ltx-next', [slot('clip', 'source_video', true), slot('a', 'msr_image')]);
  const extendTool = async list =>
    (await catalogOf(list).definitions()).find(tool => tool.function.name === 'extend_video').function.parameters;
  const both = await extendTool([minimax, ltx]);
  assert.equal(both.properties.reference.maxItems, 2);
  assert.equal(both.properties.start_image, undefined, 'a continuation starts on its clip, not on an image');
  const args = () => ({ prompt: 'x', intention: 'y', source: { output: 'video-run' }, reference: [{ image: 0 }] });
  const routed = await catalogOf([minimax, ltx]).route('extend_video', args(), media);
  assert.equal(routed.workflow.id, 'minimax-next');
  assert.deepEqual(routed.args.references, [
    { input: 'clip', output_id: 'video-run' },
    { input: 'r1', image: 0 },
  ]);
  // LTX 2.5 alone: its subject references are not offered beside a continuation, nor accepted.
  assert.equal((await extendTool([ltx])).properties.reference, undefined);
  await assert.rejects(catalogOf([ltx]).route('extend_video', args(), media), /Aucun workflow/);
  // The Studio shows the reference slots of the MiniMax continuation only.
  const studio = (await catalogOf([minimax, ltx]).studio()).extend_video;
  const roles = Object.fromEntries(studio.map(item => [item.id, item.roles.reference.count]));
  assert.deepEqual(roles, { 'minimax-next': 2, 'ltx-next': 0 });
  // Creating a video with LTX still takes its subject references.
  const subject = video('subject', [slot('a', 'msr_image'), slot('b', 'msr_image')]);
  const create = (await catalogOf([subject]).definitions()).find(tool => tool.function.name === 'create_video');
  assert.equal(create.function.parameters.properties.reference.maxItems, 2);
});

test('the Studio offers its style LoRAs where the engine that creates applies them', async () => {
  const minimax = { ...video('minimax', []), pipeline: 'minimax_h3' },
    moss = { ...image('moss-image'), pipeline: 'moss' };
  const studio = await catalogOf([image('krea'), moss, video('ltx', []), minimax]).studio();
  const styled = Object.fromEntries(
    [...studio.create_image, ...studio.create_video].map(item => [item.id, item.styled]),
  );
  // Atelier's engine applies them to Krea 2 and LTX 2.5, ComfyUI to MOSS Image; MiniMax H3
  // takes none yet.
  assert.deepEqual(styled, { krea: true, 'moss-image': true, ltx: true, minimax: false });
});

test('the LoRA of the subject references is no setting: neither the Studio nor the model sees it (16/11)', async () => {
  const lora = (id, enabled) => ({ id, asset: id, description: id, enabled, strength: { policy: 'fixed', value: 1 } });
  const subject = video('subject', [slot('a', 'msr_image')], {
      loras: [lora('reference-slots', { policy: 'model', default: false }), lora('grain', { policy: 'model', default: true })],
    }),
    // Without subject references, a LoRA left to the model stays the user's to switch.
    plain = video('plain', [], { loras: [lora('grain', { policy: 'model', default: true })] });
  const studio = Object.fromEntries((await catalogOf([subject, plain]).studio()).create_video.map(item => [item.id, item]));
  assert.deepEqual(studio.subject.loras.map(item => item.id), ['grain']);
  assert.deepEqual(studio.plain.loras.map(item => item.id), ['grain']);
  const create = (await catalogOf([subject]).definitions()).find(tool => tool.function.name === 'create_video');
  assert.deepEqual(Object.keys(create.function.parameters.properties.loras.properties), ['grain']);
});

test('arguments are checked against the chosen workflow, never forwarded blindly', async () => {
  const tools = catalogOf(workflows);
  const routed = await tools.route('create_video', { prompt: 'x', intention: 'y', fps: 12, stage: 'final' }, media);
  assert.equal(routed.args.stage, 'final');
  assert.equal(routed.args.fps, undefined);
  // (0.6.102: under the name Paramètres › Workflows gives it, as every note of the router.)
  assert.match(routed.notes[0], /^Images par seconde : valeur ignorée, fixée par le workflow /);
  await assert.rejects(tools.route('create_image', { prompt: 'x', colour: 'red' }, media), /argument colour/);
  await assert.rejects(
    tools.route('create_image', { prompt: 'x', source: { image: 0, resource: 'r' } }, media),
    /exactly one/,
  );
});

test('the seed the user names is passed on, only to a workflow that draws its seed', async () => {
  const drawn = video('drawn', [], {});
  drawn.parameters.seed = { policy: 'random', type: 'integer' };
  const tools = catalogOf([drawn]);
  const definition = (await tools.definitions()).find(tool => tool.function.name === 'create_video').function;
  assert.equal(definition.parameters.properties.seed.type, 'integer');
  assert.ok(!definition.parameters.required.includes('seed'));
  const routed = await tools.route('create_video', { prompt: 'x', intention: 'y', seed: 7704106376826763 }, media);
  assert.equal(routed.seed, 7704106376826763);
  assert.equal(routed.args.seed, undefined, 'the seed is not a workflow argument: the application sets it');
  assert.equal((await tools.route('create_video', { prompt: 'x', intention: 'y' }, media)).seed, undefined);
  assert.equal((await tools.route('create_video', { prompt: 'x', intention: 'y', seed: null }, media)).seed, undefined);
  for (const seed of [-1, 1.5, '12', 2 ** 60])
    await assert.rejects(tools.route('create_video', { prompt: 'x', intention: 'y', seed }, media), /seed doit être/);
  // A workflow with its own seed keeps it, and says so.
  const fixed = await catalogOf(workflows).route('create_video', { prompt: 'x', intention: 'y', seed: 5 }, media);
  assert.equal(fixed.seed, undefined);
  assert.match(fixed.notes.join(), /Seed : valeur ignorée, fixée par le workflow/);
});

test('upscale follows the media of its source and interpolate only takes videos', async () => {
  const transform = (id, pipeline, mediaType, role, parameters = {}) => ({
    schemaVersion: 1,
    id,
    name: id,
    description: id,
    enabled: true,
    ready: true,
    pipeline,
    mediaType,
    parameters,
    components: {},
    loras: [],
    references: [slot('source', role, true)],
  });
  const tools = catalogOf([
    image('portrait'),
    transform('bigger-image', 'realesrgan_image', 'image', 'source_image'),
    transform('bigger-video', 'realesrgan_video', 'video', 'source_video'),
    transform('smooth', 'rife', 'video', 'source_video', {
      multiplier: { policy: 'model', type: 'integer', choices: [2, 4], default: 2 },
    }),
  ]);
  const names = (await tools.definitions()).map(tool => tool.function.name).sort();
  assert.deepEqual(names, ['create_image', 'interpolate', 'upscale']);
  const upscale = (await tools.definitions()).find(tool => tool.function.name === 'upscale').function.parameters;
  assert.equal(upscale.properties.prompt, undefined, 'upscaling has no prompt');
  assert.deepEqual(upscale.required, ['source']);
  assert.equal((await tools.route('upscale', { source: { image: 0 } }, media)).workflow.id, 'bigger-image');
  const video = await tools.route('upscale', { source: { output: 'video-run' } }, media);
  assert.equal(video.workflow.id, 'bigger-video');
  assert.ok(video.args.intention, 'a video upscale still carries an intention for its confirmation');
  const smooth = await tools.route('interpolate', { source: { output: 'video-run' }, multiplier: 4 }, media);
  assert.deepEqual([smooth.workflow.id, smooth.args.multiplier], ['smooth', 4]);
  await assert.rejects(tools.route('interpolate', { source: { image: 0 } }, media), /Aucun workflow/);
});

test('with a conversation context, sources list only what exists and never accept an empty object', async () => {
  const run = (id, mediaType, extra = {}) => ({ id, mediaType, count: 2, workflowId: 't2v', ...extra });
  const tools = catalogOf([...workflows, video('final', [], { profiles: { final: {} } })]);
  const named = async available =>
    Object.fromEntries((await tools.definitions(available)).map(tool => [tool.function.name, tool.function]));

  const empty = await named({ images: 0, resources: [], outputs: [] });
  assert.equal(empty.extend_video, undefined, 'a verb whose required source cannot exist is not offered');
  assert.equal(empty.create_image.parameters.properties.source, undefined);
  assert.equal(empty.create_video.parameters.properties.reference, undefined);
  assert.equal(empty.create_video.parameters.properties.reuse_output, undefined);
  assert.doesNotMatch(empty.create_image.description, /Sources:/);

  const rich = await named({
    images: 2,
    resources: [{ id: 'r-image', type: 'image' }],
    outputs: [run('img-run', 'image'), run('clip-run', 'video', { draft: true }), { id: 'broken', count: 0 }],
  });
  const source = rich.create_image.parameters.properties.source;
  assert.equal(source.anyOf.length, 3);
  for (const variant of source.anyOf) {
    assert.equal(variant.required.length, 1, 'each variant names exactly one kind of source');
    assert.equal(variant.additionalProperties, false);
  }
  assert.equal(source.anyOf[0].properties.image.maximum, 1);
  assert.deepEqual(source.anyOf[1].properties.resource.enum, ['r-image']);
  assert.deepEqual(source.anyOf[2].properties.output.enum, ['img-run'], 'a video result cannot be an image source');
  assert.equal(source.anyOf[2].properties.index.maximum, 1);
  assert.deepEqual(rich.extend_video.parameters.properties.source.properties.output.enum, ['clip-run']);
  assert.equal(
    rich.create_video.parameters.properties.reuse_output,
    undefined,
    'only drafts of a final-capable workflow',
  );
  assert.match(rich.create_image.description, /Sources: \{"image": n\}.*\{"resource": "id"\}.*\{"output": "run_id"\}/);

  const drafts = await named({
    images: 0,
    resources: [],
    outputs: [run('draft-run', 'video', { workflowId: 'final', draft: true })],
  });
  assert.deepEqual(drafts.create_video.parameters.properties.reuse_output.enum, ['draft-run']);
  const legacy = (await tools.definitions()).find(tool => tool.function.name === 'create_image').function;
  assert.ok(legacy.parameters.properties.source.properties.output, 'without context the generic schema is kept');
});

test('the shipped music workflow gives create_audio its lyrics, length and language, and routes them', async () => {
  const { readFile } = await import('node:fs/promises');
  const music = {
    ...JSON.parse(
      await readFile(new URL('../runner/workflows/8a2e5baf-0c02-4077-b36c-482b4e54bb13.json', import.meta.url), 'utf8'),
    ),
    ready: true,
  };
  const catalog = catalogOf([...workflows, music]);
  const tool = (await catalog.definitions()).find(item => item.function.name === 'create_audio').function;
  const { properties, required } = tool.parameters;
  assert.deepEqual(Object.keys(properties).sort(), ['language', 'lyrics', 'prompt', 'seconds', 'seed']);
  assert.deepEqual(required, ['prompt']);
  assert.match(properties.prompt.description, /BPM/);
  assert.match(properties.lyrics.description, /\[Chorus\]/);
  assert.equal(properties.seconds.maximum, 600);
  assert.ok(properties.language.enum.includes('fr'));
  assert.doesNotMatch(tool.description, /intention/);
  const routed = await catalog.route(
    'create_audio',
    { prompt: 'synth-pop, 110 BPM', lyrics: '[Verse]\nLa nuit', seconds: 30, language: 'fr' },
    media,
  );
  assert.equal(routed.workflow.id, music.id);
  assert.deepEqual(
    { lyrics: routed.args.lyrics, seconds: routed.args.seconds, language: routed.args.language },
    { lyrics: '[Verse]\nLa nuit', seconds: 30, language: 'fr' },
  );
});

test('music and sound effects: the model names the workflow, and each keeps its own limits', async () => {
  const { readFile } = await import('node:fs/promises');
  const shipped = async id => ({
    ...JSON.parse(await readFile(new URL(`../runner/workflows/${id}.json`, import.meta.url), 'utf8')),
    ready: true,
  });
  const music = await shipped('8a2e5baf-0c02-4077-b36c-482b4e54bb13'),
    effects = await shipped('84390db5-e4b9-413c-9352-bbac225fe79c');
  const catalog = catalogOf([music, effects]);
  const tool = (await catalog.definitions()).find(item => item.function.name === 'create_audio').function;
  const { properties, required } = tool.parameters;
  assert.deepEqual(required.sort(), ['prompt', 'workflow']);
  assert.match(properties.workflow.description, /sound effects/);
  assert.match(properties.workflow.description, /music/);
  assert.equal(properties.seconds.minimum, 1);
  assert.equal(properties.seconds.maximum, 600);
  assert.match(properties.seconds.description, /30 at most/);
  assert.match(properties.lyrics.description, /Only for: 8a2e5baf/);
  const routed = await catalog.route(
    'create_audio',
    { workflow: effects.id, prompt: 'Rain on a tin roof', seconds: 60, lyrics: '' },
    media,
  );
  assert.equal(routed.workflow.id, effects.id);
  assert.equal(routed.args.seconds, 30);
  assert.equal(routed.args.lyrics, undefined);
  assert.ok(routed.notes.some(note => /^Durée \(secondes\) : 60 → 30, la limite de /.test(note)), routed.notes.join(' | '));
  assert.ok(routed.notes.some(note => /^Paroles : valeur ignorée, .* ne prend pas ce réglage\.$/.test(note)));
  const song = await catalog.route('create_audio', { workflow: music.id, prompt: 'synth-pop', seconds: 200 }, media);
  assert.equal(song.args.seconds, 200);
  assert.deepEqual(song.notes, []);
});

test('a character is replaced in a video by a verb of its own: the video, the image, who is who', async () => {
  const scail = {
    ...JSON.parse(readFileSync(new URL('../runner/families/wan_scail2.json', import.meta.url), 'utf8')).template,
    schemaVersion: 1,
    id: 'scail',
    enabled: true,
    ready: true,
    pipeline: 'wan_scail2',
    mediaType: 'video',
  };
  const catalog = catalogOf([...workflows, scail]);
  assert.equal(serves(scail, 'replace_character'), true);
  // Neither a video made from a description nor the continuation of one.
  assert.equal(serves(scail, 'create_video'), false);
  assert.equal(serves(scail, 'extend_video'), false);
  const tools = Object.fromEntries((await catalog.definitions()).map(t => [t.function.name, t.function]));
  const replace = tools.replace_character.parameters;
  assert.deepEqual(Object.keys(replace.properties).sort(), [
    'character',
    'intention',
    'prompt',
    'reference',
    'reference_subject',
    'seed',
    'source',
    'subject',
  ]);
  // The length and the format are the source video's: the model is asked neither. The character
  // is its image, or its description when there is none (the application makes the image).
  assert.deepEqual(replace.required.sort(), ['intention', 'prompt', 'source']);
  assert.match(replace.properties.character.description, /no image of the character/);
  assert.match(tools.replace_character.description, /never make one\s+with create_image/);
  assert.match(replace.properties.subject.description, /girl, handkerchief/);
  // Without a video in the conversation there is nothing to follow: the verb is not offered.
  const none = await catalog.definitions({ images: 1, resources: [], outputs: [] });
  assert.ok(!none.some(tool => tool.function.name === 'replace_character'));
  const some = await catalog.definitions({
    images: 1,
    resources: [{ id: 'clip', type: 'video' }],
    outputs: [],
  });
  const offered = some.find(tool => tool.function.name === 'replace_character').function.parameters.properties;
  // The video is taken whole: no frame of it is offered for the source, one is for an image role.
  assert.deepEqual(Object.keys(offered.source.properties), ['resource']);
  assert.ok(
    offered.reference.anyOf.some(variant => variant.properties.frame),
    'a frame of a video can still stand for the image of the character',
  );
  // A model that names a frame all the same means the video: the call is not refused for it.
  const framed = await catalog.route(
    'replace_character',
    {
      prompt: 'x',
      intention: 'y',
      source: { resource: 'clip', frame: 1 },
      reference: { image: 0 },
    },
    { mediaOf: async source => (source.resource === 'clip' && source.frame === undefined ? 'video' : 'image') },
  );
  assert.deepEqual(framed.args.references[0], { input: 'video', resource_id: 'clip' });
  const routed = await catalog.route(
    'replace_character',
    {
      prompt: 'A woman in a white top eats an apple in an orchard.',
      intention: 'Remplacer la fille.',
      source: { output: 'video-run' },
      reference: { image: 0 },
      subject: 'girl, handkerchief',
    },
    media,
  );
  assert.equal(routed.workflow.id, 'scail');
  assert.equal(routed.args.subject, 'girl, handkerchief');
  assert.deepEqual(
    routed.args.references.map(ref => ref.input),
    ['video', 'character'],
  );
  await assert.rejects(
    catalog.route('replace_character', { prompt: 'x', intention: 'y', reference: { image: 0 } }, media),
    /needs a source/,
  );
  // A description given beside an image: the image is the character, the words go no further.
  const both = await catalog.route(
    'replace_character',
    {
      prompt: 'x',
      intention: 'y',
      source: { output: 'video-run' },
      reference: { image: 0 },
      character: 'a volleyball player',
    },
    media,
  );
  assert.equal(both.args.character, undefined);
  assert.equal(both.args.references.length, 2);
});

test('an output of another conversation of the project keeps its conversation; a conversation alone is refused', async () => {
  const tools = catalogOf([
    image('portrait'),
    {
      schemaVersion: 1,
      id: 'bigger-video',
      name: 'bigger-video',
      description: 'bigger-video',
      enabled: true,
      ready: true,
      pipeline: 'realesrgan_video',
      mediaType: 'video',
      parameters: {},
      components: {},
      loras: [],
      references: [slot('source', 'source_video', true)],
    },
  ]);
  const other = 'b2222222-2222-4222-8222-222222222222';
  const routed = await tools.route('upscale', { source: { output: 'video-run', conversation: other } }, media);
  assert.deepEqual(routed.args.references, [{ input: 'source', output_id: 'video-run', output_conversation: other }]);
  await assert.rejects(
    tools.route('upscale', { source: { resource: 'clip', conversation: other } }, media),
    /conversation goes only with an output/,
  );
  await assert.rejects(
    tools.route('upscale', { source: { output: 'video-run', conversation: 'not-an-id' } }, media),
    /conversation goes only with an output/,
  );
});

test('one more image: where a proposal still has a place for it, and which other workflow would', async () => {
  const minimax = {
      ...video('minimax-next', [
        slot('clip', 'source_video', true),
        slot('r1', 'reference_image'),
        slot('r2', 'reference_image'),
      ]),
      pipeline: 'minimax_h3',
    },
    ltx = video('ltx-next', [slot('clip', 'source_video', true), slot('a', 'msr_image')]),
    clip = [{ input: 'clip' }];
  // LTX 2.5 continues a clip without any image; MiniMax H3 takes subject references with it.
  assert.deepEqual(await catalogOf([minimax, ltx]).room('extend_video', ltx, clip), {
    here: [],
    none: true,
    other: 'minimax-next',
  });
  assert.deepEqual(await catalogOf([ltx]).room('extend_video', ltx, clip), { here: [], none: true, other: null });
  assert.deepEqual(await catalogOf([minimax, ltx]).room('extend_video', minimax, clip), {
    here: ['reference'],
    none: false,
    other: null,
  });
  // Its two references given: no place left, and LTX would not take them either.
  const full = [{ input: 'clip' }, { input: 'r1' }, { input: 'r2' }];
  assert.deepEqual(await catalogOf([minimax, ltx]).room('extend_video', minimax, full), {
    here: [],
    none: false,
    other: null,
  });
  // A new video: the roles left free, those the family does not combine with the ones given left out.
  const keys = video('keyframes', [slot('first', 'start_image'), slot('last', 'end_image')]),
    subject = video('subject', [slot('first', 'start_image'), slot('a', 'msr_image')]),
    omni = {
      ...video('omni', [slot('s', 'start_image'), slot('e', 'end_image'), slot('r1', 'reference_image')]),
      pipeline: 'minimax_h3',
    };
  const tools = catalogOf([keys, subject, omni]);
  assert.deepEqual((await tools.room('create_video', keys, [])).here, ['start_image', 'end_image']);
  assert.deepEqual((await tools.room('create_video', keys, [{ input: 'first' }])).here, ['end_image']);
  const taken = await tools.room('create_video', keys, [{ input: 'first' }, { input: 'last' }]);
  assert.deepEqual(taken, { here: [], none: false, other: null }, 'two key images and a third: no workflow here');
  // MiniMax H3: a reference does not go with a start image; an end image does.
  assert.deepEqual((await tools.room('create_video', omni, [{ input: 's' }])).here, ['end_image']);
  assert.deepEqual((await tools.room('create_video', omni, [{ input: 'r1' }])).here, []);
  // … which LTX 2.5 takes together: a reference, and the image as the one the clip starts on.
  assert.equal((await tools.room('create_video', omni, [{ input: 'r1' }])).other, 'subject');
  // A workflow without any image, beside one that takes a start image.
  const plain = video('t2v', []);
  assert.deepEqual(await catalogOf([plain, keys]).room('create_video', plain, []), {
    here: [],
    none: true,
    other: 'keyframes',
  });
  assert.deepEqual(await tools.room('nothing', keys, []), { here: [], none: true, other: null });
});

test('Krea 2: the denoise is the assistant’s with an image to modify, from 0.6 to 0.7, and said in its tool only', async () => {
  const { readFile } = await import('node:fs/promises');
  const shippedOf = async id => ({
    ...JSON.parse(await readFile(new URL(`../runner/workflows/${id}.json`, import.meta.url), 'utf8')),
    ready: true,
  });
  const krea = await shippedOf('fefb88eb-8311-4409-b636-6efbb42e952c'),
    moss = await shippedOf('3d6f1a8c-2b7e-4f59-9c41-8e0a5d2b7c36'),
    catalog = catalogOf([moss, krea]);
  const toolOf = async (tools, available, options) =>
    (await tools.definitions(available, options)).find(item => item.function.name === 'create_image').function
      .parameters;
  // Offered with its bounds, both included, and what each end does: the model is told there, and
  // nowhere else (lib/model-wording.mjs and lib/tasks.json say nothing of it).
  const generic = await toolOf(catalog);
  assert.deepEqual(Object.keys(generic.properties), [
    'prompt',
    'source',
    'workflow',
    'seed',
    'width',
    'height',
    'denoise',
    'series',
  ]);
  assert.deepEqual(generic.required, ['prompt']);
  const { description, ...schema } = generic.properties.denoise;
  assert.deepEqual(schema, { type: 'number', minimum: 0.6, maximum: 0.7, default: 0.6 });
  assert.equal(
    description,
    'Only with an image to modify (source): how much of that image is redone. 0.6 keeps its composition and changes its mood, light or colours; 0.7 also lets the composition change (another framing, a farther view). Omit it otherwise: 0.6 is used. Only for: fefb88eb-8311-4409-b636-6efbb42e952c.',
  );
  assert.equal(description, `${krea.parameters.denoise.description} Only for: ${krea.id}.`);
  for (const file of ['../lib/model-wording.mjs', '../lib/tasks.json', '../lib/tasks-capable.json'])
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /denoise/i, file);
  // A conversation that holds nothing to modify: no source to pass, and not a word of the denoise.
  const empty = { images: 0, resources: [], takes: [], outputs: [] };
  const fresh = (await toolOf(catalog, empty)).properties;
  assert.deepEqual([fresh.source, fresh.denoise], [undefined, undefined]);
  const attached = (await toolOf(catalog, { ...empty, images: 1 })).properties;
  assert.ok(attached.source && attached.denoise);
  // A capable model: the same words, the workflow by its name.
  const capable = (await toolOf(catalog, undefined, { wording: CAPABLE })).properties.denoise;
  assert.equal(capable.description, `${krea.parameters.denoise.description} Only for: Krea 2.`);
  assert.deepEqual([capable.minimum, capable.maximum], [0.6, 0.7]);
  // A workflow that fixes its denoise offers no such argument.
  const fixed = structuredClone(krea);
  fixed.parameters.denoise = { policy: 'fixed', value: 0.6 };
  const held = catalogOf([moss, fixed]);
  assert.equal((await toolOf(held)).properties.denoise, undefined);
  // Nor does one that takes no image to modify, whatever it says of its denoise.
  const slotless = { ...structuredClone(krea), id: 'krea-sans-image', name: 'Krea sans image', references: [] };
  assert.equal((await toolOf(catalogOf([moss, slotless]))).properties.denoise, undefined);
  assert.ok((await toolOf(catalogOf([slotless, krea]))).properties.denoise.description.endsWith(`Only for: ${krea.id}.`));

  // Routed: kept within the bounds, brought back to the nearest one beyond them, and said.
  // (The router writes the media of a source on it: a new one for each call.)
  const route = (args, tools = catalog) => tools.route('create_image', { prompt: 'x', ...structuredClone(args) }, media),
    source = { image: 0 };
  let routed = await route({ source, denoise: 0.7 });
  assert.equal(routed.workflow.id, krea.id);
  assert.deepEqual([routed.args.denoise, routed.notes], [0.7, []]);
  routed = await route({ source, denoise: 0.65 });
  assert.deepEqual([routed.args.denoise, routed.notes], [0.65, []]);
  routed = await route({ source, denoise: 0.9 });
  // (0.6.102: under the name the editor shows.)
  assert.deepEqual([routed.args.denoise, routed.notes], [0.7, ['Débruitage : 0,9 → 0,7, la limite de Krea 2.']]);
  routed = await route({ source, denoise: 0.3 });
  assert.deepEqual([routed.args.denoise, routed.notes], [0.6, ['Débruitage : 0,3 → 0,6, la limite de Krea 2.']]);
  // Without an image to modify: left aside without a word, whatever its value.
  for (const denoise of [0.7, 0.9, 0.3]) {
    routed = await route({ denoise });
    assert.equal(routed.workflow.id, krea.id);
    assert.deepEqual([Object.hasOwn(routed.args, 'denoise'), routed.notes], [false, []], String(denoise));
  }
  // The workflow that fixes it: ignored and said, never an error.
  routed = await route({ source, denoise: 0.7 }, held);
  assert.equal(Object.hasOwn(routed.args, 'denoise'), false);
  assert.match(routed.notes.join(), /Débruitage : valeur ignorée, fixée par le workflow Krea 2\./);

  // The Studio: a setting of the model, with its bounds and the input it is only read with.
  // (0.6.102) Those it fixes too (its steps), at their value: « Fixe » holds Moodix AI, the user
  // may change it for a creation.
  const shown = (await catalog.studio()).create_image.find(item => item.id === krea.id);
  assert.deepEqual(shown.settings, [
    { key: 'steps', type: 'integer', min: 1, max: 1000, default: 8, fixed: true },
    { key: 'denoise', type: 'number', min: 0.6, max: 0.7, default: 0.6, onlyWith: { role: 'img2img', otherwise: 1 } },
  ]);
  assert.equal(shown.inputs.img2img, 'source');
  assert.deepEqual(
    (await held.studio()).create_image
      .find(item => item.id === krea.id)
      .settings.map(setting => [setting.key, setting.default, setting.fixed, setting.min, setting.max]),
    [
      ['steps', 8, true, 1, 1000],
      ['denoise', 0.6, true, 0, 1],
    ],
  );
});
