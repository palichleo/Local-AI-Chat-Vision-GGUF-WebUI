import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Resources } from '../lib/resources.mjs';
import { ToolCatalog } from '../lib/tool-catalog.mjs';
import { ToolRuntime, takesStyles } from '../lib/tool-runtime.mjs';
import { resolveNativeWorkflow, validateNativeWorkflow } from '../lib/native-workflows.mjs';

/**
 * Proposals as the application makes them, with the workflows it ships (their real slots, lengths
 * and profiles) and everything else in memory: the creations, the references of the project, the
 * chat model and the generator.
 */
const folder = fileURLToPath(new URL('../runner/workflows/', import.meta.url));
const shipped = () =>
  readdirSync(folder)
    .filter(name => name.endsWith('.json'))
    .map(name => ({ ...validateNativeWorkflow(JSON.parse(readFileSync(join(folder, name), 'utf8'))), ready: true }));
const of = (list, pipeline) => list.find(workflow => workflow.pipeline === pipeline);
const assets = { resolve: async id => ({ id, path: join(tmpdir(), `${id}.safetensors`) }) };
// Identifiers that read at a glance: uid(3) is 33333333-3333-4333-8333-333333333333.
const uid = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const call = (name, args, id = 'call-1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

/**
 * `library`: the references of the project kept for real (a Resources of lib/resources.mjs) in place
 * of those in memory; `extractStill`: what reads the first or last picture of a video file.
 */
function world({
  workflows = shipped(),
  records = {},
  resources = {},
  client = null,
  library = null,
  extractStill = null,
  projectOf,
  missing = [],
  savedStyles,
} = {}) {
  const saved = [],
    closing = { close: async () => {} };
  client ??= {
    status: async () => ({ idle: true }),
    stage: async () => ({ path: join(tmpdir(), 'staged') }),
    upload: async () => ({ path: join(tmpdir(), 'uploaded.png') }),
    preflight: async () => {},
    run: async job => ({
      outputs: [{ filename: 'made.mp4', subfolder: '', type: 'output' }],
      metadata: { parameters: job.parameters },
    }),
    free: async () => ({}),
  };
  const gallery = {
    get: async (conversation, id) => {
      const record = records[`${conversation}/${id}`];
      if (!record) throw Object.assign(Error('Entrée ou copie d’analyse introuvable.'), { status: 404 });
      return structuredClone(record);
    },
    put: async record => {
      saved.push(record);
      records[`${record.conversationId}/${record.id}`] = record;
      return record;
    },
  };
  library ??= {
    activeRecord: async id => {
      if (!resources[id]) throw Object.assign(Error('Ressource introuvable.'), { status: 404 });
      return { id, ready: true, enabled: true, ...resources[id] };
    },
    readActive: async id => ({
      ...(await library.activeRecord(id)),
      frames: [{ time: 0, url: 'data:image/png;base64,AAAA' }],
    }),
    used: async () => {},
  };
  const engine = {
    busy: false,
    state: 'ready',
    stop: async () => void (engine.state = 'stopped'),
    start: async () => void (engine.state = 'ready'),
  };
  const runtime = new ToolRuntime({
    engine,
    catalog: {
      kind: 'native',
      list: async () => workflows,
      read: async id => workflows.find(workflow => workflow.id === id),
      prepare: async (id, args, options) => {
        const workflow = workflows.find(item => item.id === id);
        return { workflow, job: await resolveNativeWorkflow(workflow, args, assets, options), outputNodes: [] };
      },
    },
    gallery,
    resources: library,
    getConfig: () => ({ enabled: true, autoAllow: false, maxIterations: 5, baseUrl: 'native' }),
    engineConfig: () => ({}),
    clientFactory: () => client,
    extractStill,
    ...(projectOf ? { projectOf } : {}),
    ...(savedStyles ? { savedStyles } : {}),
    // (`path`: where the file is, as the application says it; `missing`: files gone from the disk.)
    sourceMedia: async (ref, conversationId) => {
      if (ref.resource_id) {
        const record = await library.activeRecord(ref.resource_id);
        return { mime: record.mime, name: record.name, handle: closing, path: join('references', ref.resource_id) };
      }
      const record = await gallery.get(ref.output_conversation ?? conversationId, ref.output_id);
      const filename = record.outputs?.[ref.output_index ?? 0]?.source?.filename ?? '';
      if (missing.includes(filename)) throw Object.assign(Error('ENOENT: no such file'), { code: 'ENOENT' });
      return {
        mime: record.mediaType === 'video' ? 'video/mp4' : 'image/png',
        name: record.workflowName,
        handle: closing,
        path: join('output', filename),
      };
    },
  });
  return { runtime, saved, records, workflows };
}

const A = uid(1),
  turn = uid(2);
/** A clip as its record keeps it. */
const clip = (conversationId, id, workflow, parameters = {}, size = [768, 448]) => ({
  provider: 'native',
  mediaType: 'video',
  id,
  conversationId,
  workflowId: workflow.id,
  workflowName: workflow.name,
  parameters: { pipeline: workflow.pipeline, width: size[0], height: size[1], fps: 24, stage: 'draft', ...parameters },
  outputs: [{ source: { filename: id + '.mp4', subfolder: '', type: 'output' }, width: size[0], height: size[1] }],
});
const picture = (name, width = 1024, height = 1024) => ({ mime: 'image/png', width, height, name, label: name });
// A MiniMax H3 workflow with every slot of its family (the shipped « Omni » has no start nor end):
// reference images do not combine with a first or a last frame.
const minimaxFull = () => {
  const omni = of(shipped(), 'minimax_h3'),
    { ready, digest, ...stored } = omni;
  return {
    ...validateNativeWorkflow({
      ...stored,
      id: 'minimax-full',
      name: 'MiniMax H3',
      references: [
        { id: 'source', role: 'source_video', required: false, name: 'Vidéo à prolonger' },
        { id: 'start', role: 'start_image', required: false, name: 'Image de début' },
        { id: 'end', role: 'end_image', required: false, name: 'Image de fin' },
        { id: 'subject-1', role: 'reference_image', required: false, name: 'Référence 1' },
        { id: 'subject-2', role: 'reference_image', required: false, name: 'Référence 2' },
      ],
    }),
    ready: true,
  };
};
const revise = (runtime, request, edits) =>
  runtime.revise({ requestId: request.requestId, approvalToken: request.approvalToken, edits });
const rolesOf = request => request.plan.references.map(ref => ref.role);

test('the call the schema of create_video demands promotes a draft: its prompt and its duration are left aside', async () => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    { runtime, saved } = world({ workflows: list });
  const place = { conversationId: A, turnId: turn, messages: [] };
  const first = await runtime.request(
    [call('create_video', { prompt: 'A red boat crosses the bay at dawn.', intention: 'Brouillon', duration: 5, workflow: ltx.id })],
    place,
  );
  assert.equal(first.plan.stage, 'draft');
  await runtime.execute({ requestId: first.requestId, permission: 'once', approvalToken: first.approvalToken });
  await runtime.finished;
  assert.equal(runtime.status().state, 'done', runtime.status().error);
  const draft = saved[0];
  // What the model is offered next: prompt and duration are required in every call.
  const schema = (
    await new ToolCatalog({ list: async () => list }).definitions({
      images: 0,
      resources: [],
      takes: [],
      outputs: [{ id: draft.id, mediaType: 'video', count: 1, workflowId: draft.workflowId, draft: true }],
    })
  ).find(item => item.function.name === 'create_video').function.parameters;
  assert.deepEqual(schema.properties.reuse_output.enum, [draft.id]);
  for (const key of ['prompt', 'duration', 'intention']) assert.ok(schema.required.includes(key), key);
  assert.match(schema.properties.reuse_output.description, /prompt and duration say is then not used/);
  // The smallest call that satisfies it (what a constrained decoder writes).
  const conforming = { reuse_output: draft.id, stage: 'final', intention: 'Version finale', prompt: draft.prompt, duration: null };
  assert.ok(schema.required.every(key => key in conforming));
  const final = await runtime.request([call('create_video', conforming, 'call-2')], { ...place, turnId: uid(3) });
  assert.equal(final.plan.stage, 'final');
  assert.equal(final.plan.prompt, draft.prompt);
  assert.equal(final.plan.parameters.frames, draft.parameters.frames, 'the length of the draft');
  assert.equal(final.plan.parameters.seed, draft.parameters.seed, 'its seed');
  assert.equal(final.notes, undefined);
  // A length and other words made up for it: the draft's are kept, and the user is told for the prompt.
  const reworded = await runtime.request(
    [call('create_video', { ...conforming, prompt: 'A blue boat.', duration: 10 }, 'call-3')],
    { ...place, turnId: uid(4) },
  );
  assert.equal(reworded.plan.prompt, draft.prompt);
  assert.equal(reworded.plan.parameters.frames, draft.parameters.frames);
  assert.deepEqual(reworded.notes, ['Version finale du brouillon : son prompt est repris tel quel.']);
  // An image the user names with that request cannot go in the call: the model is not sent back
  // to pass it (no `cited`, which makes the chat route refuse the call), the proposal says why.
  const named = await runtime.request([call('create_video', conforming, 'call-4')], {
    ...place,
    turnId: uid(5),
    cited: [{ id: uid(6), label: '#ref1' }],
  });
  assert.equal(named.cited, undefined);
  assert.deepEqual(named.notes, ['#ref1 n’est pas transmise : la version finale reprend les entrées du brouillon.']);
  // The same image named for a new video is still asked for where the workflow has a place for it.
  const fresh = await runtime.request(
    [call('create_video', { prompt: 'A red boat.', intention: 'x', duration: 5, workflow: ltx.id }, 'call-5')],
    { ...place, turnId: uid(7), cited: [{ id: uid(6), label: '#ref1' }] },
  );
  assert.deepEqual(fresh.cited.left, [{ id: uid(6), label: '#ref1' }]);
  assert.ok(fresh.cited.roles.length);
});

test('the card of a continuation by LTX 2.5 shows and takes what the model may pass: its clip, nothing else', async () => {
  const list = shipped().filter(workflow => workflow.pipeline !== 'minimax_h3'),
    ltx = of(list, 'ltx25'),
    CLIP = uid(3),
    IMAGE = uid(4);
  const { runtime } = world({
    workflows: list,
    records: { [`${A}/${CLIP}`]: clip(A, CLIP, ltx) },
    resources: { [IMAGE]: picture('escalier.png') },
  });
  const place = { conversationId: A, turnId: turn, messages: [] };
  // The model is refused an image beside the clip…
  await assert.rejects(
    runtime.request(
      [call('extend_video', { prompt: 'x', intention: 'Suite', source: { output: CLIP }, reference: [{ resource: IMAGE }] })],
      place,
    ),
    /no free image slot for reference/,
  );
  // …so the card has no case for one (it had DÉBUT, FIN and RÉF., and revise took an image in each)…
  const proposal = await runtime.request(
    [call('extend_video', { prompt: 'x', intention: 'Suite', duration: 5, source: { output: CLIP } })],
    place,
  );
  assert.deepEqual(proposal.inputRoles, ['source_video']);
  assert.deepEqual(proposal.plan.editable.references, [[]]);
  // …and an image sent there all the same is refused in the user's words, under either name of its role.
  for (const [role, said] of [
    ['start_image', /LTX 2\.5 ne prend pas d’image de début pour la suite d’une vidéo\./],
    ['end_image', /LTX 2\.5 ne prend pas d’image de fin pour la suite d’une vidéo\./],
    ['msr_image', /LTX 2\.5 ne prend pas de référence de sujet pour la suite d’une vidéo\./],
    ['reference', /LTX 2\.5 ne prend pas de référence de sujet pour la suite d’une vidéo\./],
    ['nowhere', /LTX 2\.5 ne prend pas d’image à cet endroit\./],
  ])
    await assert.rejects(revise(runtime, proposal, { add: { role, source: { resource: IMAGE } } }), said, role);
  // A refusal changes nothing: the proposal is still the one to confirm.
  assert.ok(runtime.pending.has(proposal.requestId));
  assert.deepEqual(rolesOf(await revise(runtime, proposal, {})), ['source_video']);
});

test('inputs a family does not combine are refused on the card as they are to the model (MiniMax: references, or a first and last frame)', async () => {
  const minimax = minimaxFull(),
    CLIP = uid(3),
    [ONE, TWO, THREE] = [uid(4), uid(5), uid(6)];
  const { runtime } = world({
    workflows: [minimax],
    records: { [`${A}/${CLIP}`]: clip(A, CLIP, minimax) },
    resources: { [ONE]: picture('un.png'), [TWO]: picture('deux.png'), [THREE]: picture('trois.png') },
  });
  const place = { conversationId: A, turnId: turn, messages: [] };
  const video = (args, id) => runtime.request([call('create_video', { prompt: 'x', intention: 'x', ...args }, id)], place);
  await assert.rejects(video({ reference: [{ resource: ONE }], start_image: { resource: TWO } }), /do not combine/);

  // One reference: the cases left are those of references; alone, it may still become a frame.
  const one = await video({ reference: [{ resource: ONE }] });
  assert.deepEqual(one.inputRoles, ['reference_image', 'reference_image']);
  assert.deepEqual(
    one.plan.editable.references[0].map(option => option.role),
    ['start_image', 'end_image', 'reference_image'],
  );
  await assert.rejects(
    revise(runtime, one, { add: { role: 'start_image', source: { resource: TWO } } }),
    /MiniMax H3 ne prend pas ces entrées ensemble : image de référence et image de début\./,
  );
  const two = await revise(runtime, one, { add: { role: 'reference_image', source: { resource: TWO } } });
  assert.deepEqual(rolesOf(two), ['reference_image', 'reference_image']);
  // Two references: one of them alone cannot become the first frame, both can become first and last.
  assert.deepEqual(two.plan.editable.references.map(options => options.map(option => option.role)), [
    ['reference_image'],
    ['reference_image'],
  ]);
  await assert.rejects(
    revise(runtime, two, { references: [{ index: 0, role: 'start_image' }] }),
    /MiniMax H3 ne prend pas ces entrées ensemble : image de référence et image de début\./,
  );
  const framed = await revise(runtime, two, {
    references: [
      { index: 0, role: 'start_image' },
      { index: 1, role: 'end_image' },
    ],
  });
  assert.deepEqual(rolesOf(framed), ['start_image', 'end_image']);
  // A first and a last frame: no case for a reference any more.
  assert.deepEqual(framed.inputRoles, ['start_image', 'end_image']);
  await assert.rejects(
    revise(runtime, framed, { add: { role: 'reference_image', source: { resource: THREE } } }),
    /MiniMax H3 ne prend pas ces entrées ensemble : image de référence, image de début et image de fin\./,
  );

  // A continuation: references go with its clip, never a first or a last frame.
  const next = await runtime.request(
    [call('extend_video', { prompt: 'x', intention: 'Suite', source: { output: CLIP } }, 'call-9')],
    place,
  );
  assert.deepEqual(next.inputRoles, ['source_video', 'reference_image', 'reference_image']);
  await assert.rejects(
    revise(runtime, next, { add: { role: 'end_image', source: { resource: ONE } } }),
    /MiniMax H3 ne prend pas d’image de fin pour la suite d’une vidéo\./,
  );
  const withSubject = await revise(runtime, next, { add: { role: 'reference_image', source: { resource: ONE } } });
  assert.deepEqual(rolesOf(withSubject), ['source_video', 'reference_image']);
});

test('an input changes role under the name of the slot (msr_image) or the name of the verb’s role (reference)', async () => {
  const list = shipped().filter(workflow => workflow.pipeline !== 'minimax_h3'),
    ltx = of(list, 'ltx25'),
    IMAGE = uid(4);
  const { runtime } = world({ workflows: list, resources: { [IMAGE]: picture('plage.png', 1024, 576) } });
  const place = { conversationId: A, turnId: turn, messages: [] };
  const proposal = () =>
    runtime.request(
      [call('create_video', { prompt: 'x', intention: 'x', workflow: ltx.id, start_image: { resource: IMAGE } })],
      place,
    );
  // The Studio names its cases as the verb names its roles; a proposal lists the slots of the family.
  for (const role of ['reference', 'msr_image']) {
    const moved = await revise(runtime, await proposal(), { references: [{ index: 0, role }] });
    assert.deepEqual(
      moved.plan.references.map(ref => [ref.role, ref.as, ref.input]),
      [['msr_image', 'reference', 'subject-1']],
      role,
    );
    assert.deepEqual(moved.plan.loras.map(lora => lora.id), ['reference-slots'], 'a subject reference brings its LoRA');
    // And back, under the name both sides share.
    assert.deepEqual(rolesOf(await revise(runtime, moved, { references: [{ index: 0, role: 'start_image' }] })), ['start_image']);
  }
  for (const role of ['source', 'source_video', 'nowhere'])
    await assert.rejects(
      revise(runtime, await proposal(), { references: [{ index: 0, role }] }),
      /« plage\.png » ne peut pas prendre ce rôle dans LTX 2\.5\./,
      role,
    );
});

test('a clip upscaled or smoothed in its own conversation is traced back to its original from another conversation of the project', async () => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    esrgan = of(list, 'realesrgan_video'),
    rife = of(list, 'rife'),
    B = uid(5),
    C = uid(6),
    [CLIP, BIG, SMOOTH, BOTH, FAST, SLOW, HERE] = ['a', 'b', 'c', 'd', 'e', 'f', '9'].map(uid);
  // What a transform keeps of its source: no conversation when it was made in the same one.
  const made = (conversationId, id, workflow, source, parameters = {}, size = [768, 448]) => ({
    ...clip(conversationId, id, workflow, {}, size),
    parameters: {
      pipeline: workflow.pipeline,
      ...parameters,
      references: [{ input: 'source', original: true, role: 'source_video', ...source }],
    },
  });
  const { runtime } = world({
    workflows: list,
    records: {
      // In B: an LTX clip, its upscale, its smoothing (48 fps), and the upscale smoothed.
      [`${B}/${CLIP}`]: clip(B, CLIP, ltx),
      [`${B}/${BIG}`]: made(B, BIG, esrgan, { output_id: CLIP }, {}, [1536, 896]),
      [`${B}/${SMOOTH}`]: made(B, SMOOTH, rife, { output_id: CLIP }, { multiplier: 2, mode: 'smooth' }),
      [`${B}/${BOTH}`]: made(B, BOTH, rife, { output_id: BIG }, { multiplier: 2, mode: 'smooth' }, [1536, 896]),
      // In B: a clip at 30 images a second, and its slow motion (its own source, still 30).
      [`${B}/${FAST}`]: clip(B, FAST, ltx, { fps: 30 }),
      [`${B}/${SLOW}`]: made(B, SLOW, rife, { output_id: FAST }, { multiplier: 2, mode: 'slow_motion' }),
      // In A: an upscale of the clip of B, which names that conversation.
      [`${A}/${HERE}`]: made(A, HERE, esrgan, { output_id: CLIP, output_conversation: B }, {}, [1536, 896]),
    },
  });
  const extend = (conversationId, source) =>
    runtime.request([call('extend_video', { prompt: 'x', intention: 'Suite', source })], {
      conversationId,
      turnId: turn,
      messages: [],
    });
  const origin = request => request.plan.references.map(ref => [ref.output_id, ref.output_conversation]);
  // From B itself, as before: the clip, with no conversation to name.
  const own = await extend(B, { output: BIG });
  assert.deepEqual(origin(own), [[CLIP, undefined]]);
  // From A, the Sortie of the Studio lists the takes of B (« Prolonger » sends their conversation):
  // the same clip, at its own size, by the model that made it. It was the upscaled file itself,
  // 1536 × 896, handed to whatever workflow the ranking fell on.
  for (const output of [BIG, SMOOTH, BOTH]) {
    const request = await extend(A, { output, conversation: B });
    assert.deepEqual(origin(request), [[CLIP, B]], output);
    assert.deepEqual(request.resolution, { width: 768, height: 448 });
    assert.equal(request.workflowName, ltx.name, 'the family that made the footage continues it');
    assert.match(request.notes.join(' '), /vidéo d’origine/);
  }
  // A result of A whose source is in B, continued from A then from a third conversation.
  assert.deepEqual(origin(await extend(A, { output: HERE })), [[CLIP, B]]);
  assert.deepEqual(origin(await extend(C, { output: HERE, conversation: A })), [[CLIP, B]]);
  // The frame rate is read through the chain too: refused before the user confirms.
  await assert.rejects(extend(B, { output: SLOW }), /30 images\/s.*24 images\/s/);
  await assert.rejects(extend(A, { output: SLOW, conversation: B }), /30 images\/s.*24 images\/s/);
});

test('a length the model made up is dropped when the only numbers of the request name a reference, a take or a format', async () => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    IMAGE = uid(4);
  const { runtime } = world({ workflows: list, resources: { [IMAGE]: picture('plage.png', 1024, 576) } });
  // The model must answer « duration » (a number or null): it writes ten seconds nobody asked for.
  const frames = async said =>
    (
      await runtime.request(
        [call('create_video', { prompt: 'x', intention: 'x', workflow: ltx.id, duration: 10, start_image: { resource: IMAGE } })],
        { conversationId: A, turnId: turn, messages: [{ role: 'user', content: said }] },
      )
    ).plan.parameters.frames;
  const standard = ltx.parameters.frames.default;
  assert.equal(await frames('Anime cette image, la caméra avance lentement'), standard);
  assert.equal(await frames('Anime #ref1, la caméra avance lentement'), standard, 'a label is no length');
  assert.equal(await frames('Anime #ref1 en 9:16, comme la prise 12'), standard);
  // A length the user gave stays the one generated.
  assert.equal(await frames('Anime #ref1 pendant 10 secondes'), 241);
});

test('the format of a clip follows the image it starts from when the user puts it there, as when the model passes it', async () => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    [WIDE, TALL] = [uid(4), uid(5)],
    size = request => [request.resolution.width, request.resolution.height];
  const { runtime } = world({
    workflows: list,
    resources: { [WIDE]: picture('paysage.png', 1920, 1080), [TALL]: picture('portrait.png', 1080, 1920) },
  });
  const place = { conversationId: A, turnId: turn, messages: [] };
  const video = args =>
    runtime.request([call('create_video', { prompt: 'x', intention: 'x', workflow: ltx.id, ...args })], place);
  const start = resource => ({ add: { role: 'start_image', source: { resource } } });
  // The profile of the shipped LTX 2.5 draft is a portrait; the image is a landscape.
  assert.deepEqual(size(await video({})), [288, 512]);
  assert.deepEqual(size(await video({ start_image: { resource: WIDE } })), [512, 288], 'passed by the model');
  // Put in DÉBUT on the card: the same. (It stayed 288 × 512: a landscape animated in portrait.)
  const added = await revise(runtime, await video({}), start(WIDE));
  assert.deepEqual(size(added), [512, 288]);
  assert.equal(added.plan.edited, undefined, 'a format that follows the image is not an edit');
  // Another image in its place, of another format: followed too; and in the final version.
  assert.deepEqual(size(await revise(runtime, added, start(TALL))), [288, 512]);
  assert.deepEqual(size(await revise(runtime, await video({}), { ...start(WIDE), stage: 'final' })), [1600, 896]);
  // A reference given the role of first frame, then given back: the format follows, then leaves.
  const subject = await video({ reference: [{ resource: WIDE }] });
  assert.deepEqual(size(subject), [288, 512]);
  const first = await revise(runtime, subject, { references: [{ index: 0, role: 'start_image' }] });
  assert.deepEqual(size(first), [512, 288]);
  assert.deepEqual(size(await revise(runtime, first, { references: [{ index: 0, role: 'reference' }] })), [288, 512]);
  // A format asked for stays, and so does a size the user set.
  assert.deepEqual(size(await revise(runtime, await video({ format: '1:1' }), start(WIDE))), [384, 384]);
  const sized = await revise(runtime, await video({}), { width: 384, height: 256 });
  assert.deepEqual(size(await revise(runtime, sized, start(TALL))), [384, 256]);
});

test('an image joined to the message, given the role of first frame on the proposal, gives the clip its format', async () => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    // A PNG of one pixel: a square.
    png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rLkAAAAASUVORK5CYII=';
  const { runtime } = world({ workflows: list });
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'avec elle' }, { type: 'image_url', image_url: { url: png } }] }];
  const subject = await runtime.request(
    [call('create_video', { prompt: 'x', intention: 'x', workflow: ltx.id, reference: [{ image: 0 }] })],
    { conversationId: A, turnId: turn, messages },
  );
  assert.deepEqual(subject.resolution, { width: 288, height: 512 });
  // revise() has the proposal, not the conversation: the image is measured from what the proposal kept of it.
  const first = await revise(runtime, subject, { references: [{ index: 0, role: 'start_image' }] });
  assert.deepEqual(first.resolution, { width: 384, height: 384 });
});

test('the lengths told to the model before a continuation are those a continuation adds, the overlap counted', async () => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    minimax = of(list, 'minimax_h3'),
    tools = new ToolCatalog({ list: async () => list });
  const told = async name => Object.fromEntries((await tools.lengths(name)).map(item => [item.name, item]));
  const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} ≠ ${expected}`);
  // A new clip: every frame is new footage.
  const created = await told('create_video');
  near(created[ltx.name].min, 9 / 24, 'LTX shortest');
  near(created[ltx.name].max, 241 / 24, 'LTX longest');
  near(created[ltx.name].standard, 121 / 24, 'LTX usual');
  near(created[minimax.name].max, 345 / 24, 'MiniMax longest');
  // A continuation renders the end of its source again: 9 frames with LTX 2.5, 22 with MiniMax H3.
  const continued = await told('extend_video');
  near(continued[ltx.name].min, (17 - 9) / 24, 'LTX shortest continuation');
  near(continued[ltx.name].max, (241 - 9) / 24, 'LTX longest continuation');
  near(continued[ltx.name].standard, (129 - 9) / 24, 'LTX usual continuation');
  near(continued[minimax.name].min, (124 - 22) / 24, 'MiniMax shortest continuation');
  near(continued[minimax.name].max, (345 - 22) / 24, 'MiniMax longest continuation');
  near(continued[minimax.name].standard, (141 - 22) / 24, 'MiniMax usual continuation');
  // What is told is what the router gives: asked for, each of these lengths is met without a note.
  const media = { mediaOf: async () => 'video' };
  for (const workflow of [ltx, minimax])
    for (const key of ['min', 'max', 'standard']) {
      const duration = continued[workflow.name][key],
        routed = await tools.route(
          'extend_video',
          { prompt: 'x', intention: 'y', workflow: workflow.id, duration, source: { output: uid(3) } },
          media,
        );
      assert.deepEqual(routed.notes, [], `${workflow.name} ${key}`);
      near((routed.args.frames - (workflow.pipeline === 'ltx25' ? 9 : 22)) / 24, duration, `${workflow.name} ${key}`);
    }
});

test('a frame only means something for a video: an image reference named with one is passed as its file', async () => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    [IMAGE, VIDEO] = [uid(4), uid(5)],
    how = [];
  // The generator: an original is staged from its file, a copy made for the model is uploaded.
  const client = {
    status: async () => ({ idle: true }),
    stage: async () => (how.push('file'), { path: join(tmpdir(), 'staged') }),
    upload: async () => (how.push('copy'), { path: join(tmpdir(), 'uploaded.png') }),
    preflight: async () => {},
    run: async job => ({ outputs: [{ filename: 'made.mp4', subfolder: '', type: 'output' }], metadata: { parameters: job.parameters } }),
    free: async () => ({}),
  };
  const { runtime, saved } = world({
    workflows: list,
    client,
    resources: { [IMAGE]: picture('plage.png', 1024, 576), [VIDEO]: { mime: 'video/mp4', width: 768, height: 448, name: 'clip.mp4' } },
  });
  // The tool offers `frame` on an image role as soon as the project holds a video.
  const schema = (
    await new ToolCatalog({ list: async () => list }).definitions({
      images: 0,
      resources: [
        { id: IMAGE, type: 'image' },
        { id: VIDEO, type: 'video' },
      ],
      outputs: [],
      takes: [],
    })
  ).find(item => item.function.name === 'create_video').function.parameters.properties.start_image;
  assert.ok(schema.properties.frame, 'a frame may be named');
  const made = async (start_image, id) => {
    how.length = 0;
    const request = await runtime.request(
      [call('create_video', { prompt: 'x', intention: 'x', workflow: ltx.id, start_image }, id)],
      { conversationId: A, turnId: uid(6), messages: [] },
    );
    await runtime.execute({ requestId: request.requestId, permission: 'once', approvalToken: request.approvalToken });
    await runtime.finished;
    assert.equal(runtime.status().state, 'done', runtime.status().error);
    return request;
  };
  // Named on an image, the frame is left out: the generator gets the file, not the reduced copy.
  const still = await made({ resource: IMAGE, frame: 0 }, 'call-1');
  assert.deepEqual(still.args.references, [{ input: 'start', resource_id: IMAGE }]);
  assert.equal(still.plan.references[0].original, true);
  assert.deepEqual(how, ['file']);
  // A frame of a video is still the copy of that frame.
  const moving = await made({ resource: VIDEO, frame: 0 }, 'call-2');
  assert.deepEqual(moving.args.references, [{ input: 'start', resource_id: VIDEO, frame: 0 }]);
  assert.equal(moving.plan.references[0].original, undefined);
  assert.deepEqual(how, ['copy']);
  // A request kept from before, replayed with its frame on an image (a draft promoted): the file too.
  const draft = saved[0];
  draft.parameters.replay_args.references[0].frame = 0;
  const final = await runtime.request(
    [call('create_video', { reuse_output: draft.id, stage: 'final', intention: 'Version finale' }, 'call-3')],
    { conversationId: A, turnId: uid(7), messages: [] },
  );
  assert.equal(final.plan.references[0].original, true);
  assert.equal(final.plan.references[0].frame, undefined);
});

test('the record of an upscale or a smoothing keeps the size, the rate and the frame count the engine reports', async () => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    CLIP = uid(3),
    PHOTO = uid(4);
  // The engine, answering as its pipelines do (runner/pipelines): a transform has no parameter for
  // its size or its rate, it says them with the file it wrote.
  const client = {
    status: async () => ({ idle: true }),
    stage: async () => ({ path: join(tmpdir(), 'staged') }),
    upload: async () => ({ path: join(tmpdir(), 'uploaded.png') }),
    preflight: async () => {},
    free: async () => ({}),
    run: async job =>
      job.pipeline === 'rife'
        ? {
            outputs: [{ filename: 'slow.mp4', subfolder: '', type: 'output', width: 768, height: 448 }],
            metadata: { job, backend: 'pytorch-rife', frames: 241, fps: 24, source_fps: 24, mode: job.parameters.mode },
          }
        : job.mediaType === 'video'
          ? {
              outputs: [{ filename: 'big.mp4', subfolder: '', type: 'output', width: 1536, height: 896 }],
              metadata: { job, backend: 'pytorch-rrdbnet', scale: 2, frames: 121, fps: 24, source: [768, 448] },
            }
          : {
              outputs: [{ filename: 'big.png', subfolder: '', type: 'output', width: 2048, height: 2048 }],
              metadata: { job, backend: 'pytorch-seedvr2-7b', source: [1024, 1024] },
            },
  };
  // The real gallery: what it keeps of a record is what the next request reads.
  const { Gallery } = await import('../lib/gallery.mjs');
  const gallery = new Gallery({ historyDir: join(tmpdir(), 'moodix-test-no-history-' + uid(7)) });
  const kept = { prompt: 'A red boat.', createdAt: new Date().toISOString() };
  await gallery.put({ ...clip(A, CLIP, ltx, { frames: 121 }), ...kept });
  await gallery.put({
    ...clip(A, PHOTO, of(list, 'krea2'), {}, [1024, 1024]),
    ...kept,
    mediaType: 'image',
    outputs: [{ source: { filename: 'photo.png', subfolder: '', type: 'output' }, width: 1024, height: 1024 }],
  });
  const { runtime } = world({ workflows: list, client });
  runtime.gallery = gallery;
  runtime.sourceMedia = async ref => ({
    mime: ref.output_id === PHOTO ? 'image/png' : 'video/mp4',
    name: 'Prise',
    handle: { close: async () => {} },
  });
  const make = async (verb, args, id) => {
    const request = await runtime.request([call(verb, args, id)], { conversationId: A, turnId: uid(8), messages: [] });
    await runtime.execute({ requestId: request.requestId, permission: 'once', approvalToken: request.approvalToken });
    await runtime.finished;
    assert.equal(runtime.status().state, 'done', runtime.status().error);
    return gallery.get(A, runtime.status().record.id, { includeImages: false });
  };
  const big = await make('upscale', { source: { output: CLIP } }, 'call-1');
  assert.deepEqual([big.outputs[0].width, big.outputs[0].height], [1536, 896], 'the size of the file made');
  assert.deepEqual([big.parameters.fps, big.parameters.frames], [24, 121]);
  const still = await make('upscale', { source: { output: PHOTO } }, 'call-2');
  assert.deepEqual([still.outputs[0].width, still.outputs[0].height], [2048, 2048]);
  assert.equal(still.parameters.fps, undefined, 'an image has no rate');
  const slow = await make('interpolate', { source: { output: CLIP }, mode: 'slow_motion' }, 'call-3');
  assert.deepEqual([slow.outputs[0].width, slow.outputs[0].height], [768, 448]);
  assert.deepEqual([slow.parameters.fps, slow.parameters.frames], [24, 241]);
  // What reads it next: a slow motion is its own source, continued at the size its record says
  // (without it, the profile's 288 × 512, which the engine then refused against the file).
  const next = await runtime.request(
    [call('extend_video', { prompt: 'x', intention: 'Suite', workflow: ltx.id, source: { output: slow.id } }, 'call-4')],
    { conversationId: A, turnId: uid(9), messages: [] },
  );
  assert.equal(next.plan.references[0].output_id, slow.id);
  assert.deepEqual(next.resolution, { width: 768, height: 448 });
});

test('a seed typed on a proposal stays the user’s through the changes that follow', async () => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    { runtime, saved } = world({ workflows: list });
  const first = await runtime.request(
    [call('create_video', { prompt: 'A red boat.', intention: 'x', workflow: ltx.id })],
    { conversationId: A, turnId: turn, messages: [] },
  );
  const typed = await revise(runtime, first, { seed: 5 });
  assert.deepEqual(typed.plan.edited, ['seed']);
  // Anything else changed afterwards (the card only sends what differs from what it shows).
  const reworded = await revise(runtime, typed, { prompt: 'A blue boat.' });
  assert.equal(reworded.plan.parameters.seed, 5);
  assert.deepEqual(reworded.plan.edited, ['seed'], 'it was no longer an edit after a second change');
  await runtime.execute({ requestId: reworded.requestId, permission: 'once', approvalToken: reworded.approvalToken });
  await runtime.finished;
  const record = saved.at(-1);
  assert.equal(record.parameters.seed, 5);
  assert.equal(record.parameters.seed_given, true, 'the take says its seed was named');
  assert.deepEqual(record.parameters.user_overrides, { seed: 5 });
  // Set back to the seed the proposal came with, it is no edit any more.
  const again = await runtime.request(
    [call('create_video', { prompt: 'A red boat.', intention: 'x', workflow: ltx.id }, 'call-2')],
    { conversationId: A, turnId: uid(3), messages: [] },
  );
  const back = await revise(runtime, await revise(runtime, again, { seed: 7 }), { seed: again.plan.parameters.seed });
  assert.equal(back.plan.edited, undefined);
  assert.equal(back.plan.parameters.seed, again.plan.parameters.seed);
});

test('the LoRAs of the user shown with a proposal go with it: kept through later changes, said by the take, none where the family takes none', async () => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    minimax = of(list, 'minimax_h3'),
    { runtime, saved } = world({ workflows: list });
  const boat = (id, workflow = ltx) =>
    runtime.request([call('create_video', { prompt: 'A red boat.', intention: 'x', workflow: workflow.id }, id)], {
      conversationId: A,
      turnId: uid(4 + saved.length),
      messages: [],
    });
  // A proposal of Moodix AI comes without any.
  const first = await boat('call-1');
  assert.equal(first.styles, undefined);
  // Those the Studio shows for its family, sent with « Générer ».
  const styles = [{ name: 'sub\\grain.safetensors', strength: 0.8 }];
  const styled = await revise(runtime, first, { styles });
  assert.deepEqual(styled.styles, styles);
  // Another change afterwards says nothing of them: they stay.
  const reworded = await revise(runtime, styled, { prompt: 'A blue boat.' });
  assert.deepEqual(reworded.styles, styles);
  await runtime.execute({ requestId: reworded.requestId, permission: 'once', approvalToken: reworded.approvalToken });
  await runtime.finished;
  assert.deepEqual(saved.at(-1).parameters.styles, styles, 'the take says what it was made with');
  // Taken out on the proposal: none goes, and the take names none.
  const second = await revise(runtime, await revise(runtime, await boat('call-2'), { styles }), { styles: [] });
  assert.equal(second.styles, undefined);
  await runtime.execute({ requestId: second.requestId, permission: 'once', approvalToken: second.approvalToken });
  await runtime.finished;
  assert.equal(saved.at(-1).parameters.styles, undefined);
  // Checked as those of a creation by hand.
  const third = await boat('call-3');
  await assert.rejects(
    revise(runtime, third, { styles: [1, 2, 3, 4].map(n => ({ name: n + '.safetensors', strength: 1 })) }),
    /trois LoRA au plus/,
  );
  // A family whose engine takes none (MiniMax H3): never kept, by hand or on a proposal, so that
  // no take says it was made with a LoRA that was left out.
  assert.equal(takesStyles(minimax), false);
  assert.equal(takesStyles(ltx), true);
  const plain = await runtime.request(
    [call('create_video', { prompt: 'A red boat.', intention: 'x', workflow: minimax.id }, 'call-4')],
    { conversationId: A, turnId: uid(9), messages: [], styles },
  );
  assert.equal(plain.styles, undefined);
  assert.equal((await revise(runtime, plain, { styles })).styles, undefined);
});

test('an image made from another keeps its format: a portrait is not fitted into the square of the profile', async () => {
  const list = shipped(),
    krea = of(list, 'krea2'),
    PORTRAIT = uid(7),
    { runtime } = world({ workflows: list, resources: { [PORTRAIT]: picture('escalier.png', 1536, 2728) } });
  const edit = (args, id) =>
    runtime.request([call('create_image', { prompt: 'The same staircase at night.', workflow: krea.id, ...args }, id)], {
      conversationId: A,
      turnId: turn,
      messages: [],
    });
  // No size asked: the format of the source, at the number of pixels of the profile.
  const followed = await edit({ source: { resource: PORTRAIT } }, 'call-1');
  const { width, height } = followed.resolution;
  assert.ok(height > width, `${width}x${height}`);
  assert.ok(Math.abs(width / height - 9 / 16) < 0.02, `${width}x${height}`);
  assert.ok(Math.abs(width * height - 1024 * 1024) / (1024 * 1024) < 0.1, `${width}x${height}`);
  // A size asked for is kept, and an image without a source keeps the size of its profile.
  const asked = await edit({ source: { resource: PORTRAIT }, width: 1024, height: 1024 }, 'call-2');
  assert.deepEqual(asked.resolution, { width: 1024, height: 1024 });
  const alone = await edit({}, 'call-3');
  assert.deepEqual(alone.resolution, { width: 1024, height: 1024 });
});

/**
 * The first or last image of a video where an image is taken (`frame`: "first" or "last"): the
 * references of the project kept for real, in a folder of their own, and the reading of the video
 * replaced by a function that says what it was asked and gives a picture of 1280 × 720.
 */
const PROJECT = uid(9);
const DOT =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rLkAAAAASUVORK5CYII=';
// A PNG as far as its header goes (its size is read there), each `tag` its own file.
const pngOf = (width, height, tag = '') => {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return Buffer.concat([bytes, Buffer.from(tag)]);
};
async function stillsWorld(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'atelier-stills-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const library = new Resources(join(root, 'resources')),
    asked = [];
  const made = world({
    library,
    projectOf: async () => PROJECT,
    extractStill: async (path, at) => {
      asked.push([path, at]);
      return { bytes: pngOf(1280, 720, path + at), preview: DOT, width: 1280, height: 720 };
    },
    ...options,
  });
  return { ...made, library, asked };
}
// A video take of the project, « PRISE n »: its record, with its number.
const take = (conversationId, id, workflow, number) => {
  const record = clip(conversationId, id, workflow);
  if (number) record.outputs[0].take = number;
  return record;
};
const place = { conversationId: A, turnId: turn, messages: [] };

test('the last image of a video take starts a new clip: read once, kept as a reference of the project, then an ordinary image', async t => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    [CLIP, OTHER] = [uid(3), uid(4)];
  const { runtime, library, asked, saved } = await stillsWorld(t, {
    workflows: list,
    records: { [`${A}/${CLIP}`]: take(A, CLIP, ltx, 25), [`${A}/${OTHER}`]: take(A, OTHER, ltx) },
  });
  const video = (start_image, id = 'call-1') =>
    runtime.request([call('create_video', { prompt: 'x', intention: 'x', workflow: ltx.id, start_image }, id)], place);
  // The profile of the draft is a portrait (288 × 512, see above): the clip takes the format of the frame.
  const first = await video({ output: CLIP, frame: 'last' });
  assert.deepEqual(asked, [[join('output', CLIP + '.mp4'), 'last']], 'the file of the take, its last picture');
  const [kept] = await library.list(PROJECT);
  assert.deepEqual(
    [kept.name, kept.label, kept.mime, kept.width, kept.height, kept.ready, kept.enabled],
    ['Dernière image · PRISE 25', '#ref1', 'image/png', 1280, 720, true, true],
  );
  assert.equal((await library.list('inbox')).length, 0, 'a reference of the project of the conversation');
  // Before the routing: the call, the card and the format see an image reference like another.
  assert.deepEqual(first.args.references, [{ input: 'start', resource_id: kept.id }]);
  assert.deepEqual(rolesOf(first), ['start_image']);
  assert.deepEqual(
    [first.plan.references[0].resource_id, first.plan.references[0].original, first.plan.references[0].label],
    [kept.id, true, 'Dernière image · PRISE 25'],
  );
  assert.equal(first.plan.references[0].frame, undefined);
  assert.deepEqual(first.resolution, { width: 512, height: 288 });
  assert.deepEqual(first.notes, ['Dernière image de la prise 25 gardée comme #ref1.']);
  assert.deepEqual(first.stills, [{ id: kept.id, label: '#ref1', name: 'Dernière image · PRISE 25', existing: false }]);
  // The same image asked again: the reference already kept, the video not read again.
  const again = await video({ output: CLIP, frame: 'last' }, 'call-2');
  assert.equal(asked.length, 1);
  assert.deepEqual(again.args.references, [{ input: 'start', resource_id: kept.id }]);
  assert.deepEqual(again.notes, ['Dernière image de la prise 25 : #ref1, déjà dans les références du projet.']);
  assert.equal(again.stills[0].existing, true);
  assert.equal((await library.list(PROJECT)).length, 1);
  // Its first image is another reference; a video without a number is named by what made it.
  const opening = await video({ output: CLIP, frame: 'first' }, 'call-3');
  assert.deepEqual(asked[1], [join('output', CLIP + '.mp4'), 'first']);
  assert.deepEqual(opening.notes, ['Première image de la prise 25 gardée comme #ref2.']);
  const unnumbered = await video({ output: OTHER, frame: 'last' }, 'call-4');
  assert.deepEqual(unnumbered.notes, ['Dernière image de cette vidéo gardée comme #ref3.']);
  assert.deepEqual(
    (await library.list(PROJECT)).map(item => item.name),
    ['Dernière image · PRISE 25', 'Première image · PRISE 25', 'Dernière image · LTX 2.5'],
  );
  // Removed from the references since: read and kept again, under a new number.
  await library.remove(kept.id);
  const back = await video({ output: CLIP, frame: 'last' }, 'call-5');
  assert.equal(asked.length, 4);
  assert.deepEqual(back.notes, ['Dernière image de la prise 25 gardée comme #ref4.']);
  // The take made from it keeps an image reference in its record, which the Studio gives back as any other.
  await runtime.execute({ requestId: back.requestId, permission: 'once', approvalToken: back.approvalToken });
  await runtime.finished;
  assert.equal(runtime.status().state, 'done', runtime.status().error);
  const reference = saved[0].parameters.references[0];
  assert.deepEqual(
    [reference.role, reference.resource_id, reference.frame, reference.output_id],
    ['start_image', back.args.references[0].resource_id, undefined, undefined],
  );
  assert.deepEqual(saved[0].parameters.routing_notes, ['Dernière image de la prise 25 gardée comme #ref4.']);
  // Switched off by the user in the references: said, never put back on behind their back.
  await library.update(back.args.references[0].resource_id, { enabled: false });
  await assert.rejects(video({ output: CLIP, frame: 'last' }, 'call-6'), {
    status: 400,
    message: 'Impossible de lire la dernière image de la prise 25 : cette image est déjà la référence #ref4, désactivée.',
  });
});

test('a first or last image in every role that takes an image, of a take of another conversation and of a video reference', async t => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    krea = of(list, 'krea2'),
    [CLIP, FAR] = [uid(3), uid(4)],
    B = uid(5);
  const { runtime, library, asked } = await stillsWorld(t, {
    workflows: list,
    records: { [`${A}/${CLIP}`]: take(A, CLIP, ltx, 7), [`${B}/${FAR}`]: take(B, FAR, ltx, 8) },
  });
  // A video among the references of the project (#ref1), as the page adds one.
  const file = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)]);
  const added = await library.add(Readable.from([file]), { name: 'plage.mp4', mime: 'video/mp4', length: file.length, project: PROJECT });
  const clipRef = await library.update(added.id, {
    prepared: { width: 768, height: 448, duration: 2, frames: [0.2, 1, 1.8].map(time => ({ url: DOT, time })) },
  });
  const video = (args, id) =>
    runtime.request([call('create_video', { prompt: 'x', intention: 'x', workflow: ltx.id, ...args }, id)], place);
  // The last image of a video reference, as the first frame.
  const fromRef = await video({ start_image: { resource: clipRef.id, frame: 'last' } }, 'call-1');
  assert.deepEqual(asked, [[join('references', clipRef.id), 'last']]);
  const still = (await library.list(PROJECT)).find(item => item.name === 'Dernière image · #ref1');
  assert.ok(still, 'named after the reference it comes from');
  assert.deepEqual(fromRef.args.references, [{ input: 'start', resource_id: still.id }]);
  assert.deepEqual(fromRef.notes, ['Dernière image de #ref1 gardée comme #ref2.']);
  assert.deepEqual(fromRef.resolution, { width: 512, height: 288 });
  // A sample of it (0, 1 or 2) stays the small copy made when it was added: nothing is read.
  const sample = await video({ start_image: { resource: clipRef.id, frame: 1 } }, 'call-2');
  assert.equal(asked.length, 1);
  assert.deepEqual(sample.args.references, [{ input: 'start', resource_id: clipRef.id, frame: 1 }]);
  assert.equal(sample.notes, undefined);
  assert.equal(sample.stills, undefined);
  // The last frame, and a subject reference, from takes: one of them of another conversation of
  // the project. The same image in two roles is one reference.
  const both = await video(
    {
      start_image: { output: CLIP, frame: 'first' },
      end_image: { output: FAR, conversation: B, frame: 'last' },
      reference: [{ output: CLIP, frame: 'first' }],
    },
    'call-3',
  );
  assert.deepEqual(asked.slice(1), [
    [join('output', CLIP + '.mp4'), 'first'],
    [join('output', FAR + '.mp4'), 'last'],
  ]);
  const names = Object.fromEntries((await library.list(PROJECT)).map(item => [item.name, item.id]));
  assert.deepEqual(both.args.references, [
    { input: 'start', resource_id: names['Première image · PRISE 7'] },
    { input: 'end', resource_id: names['Dernière image · PRISE 8'] },
    { input: 'subject-1', resource_id: names['Première image · PRISE 7'] },
  ]);
  assert.deepEqual(both.notes.slice(0, 2), [
    'Première image de la prise 7 gardée comme #ref3.',
    'Dernière image de la prise 8 gardée comme #ref4.',
  ]);
  // The image an image is made from: the last picture of a clip, whose format the image keeps.
  const edited = await runtime.request(
    [call('create_image', { prompt: 'The same shot at night.', workflow: krea.id, source: { output: CLIP, frame: 'last' } }, 'call-4')],
    place,
  );
  const ending = (await library.list(PROJECT)).find(item => item.name === 'Dernière image · PRISE 7');
  assert.deepEqual(edited.args.references, [{ input: 'source', resource_id: ending.id }]);
  assert.ok(edited.resolution.width > edited.resolution.height, 'the landscape of the frame');
  // The clip a continuation starts from is taken whole: a frame named there says nothing, as before.
  const before = asked.length;
  const next = await runtime.request(
    [call('extend_video', { prompt: 'x', intention: 'x', duration: null, source: { output: CLIP, frame: 'last' } }, 'call-5')],
    place,
  );
  assert.equal(asked.length, before);
  assert.deepEqual(rolesOf(next), ['source_video']);
  assert.deepEqual(next.plan.references[0].output_id, CLIP);
  assert.equal(next.stills, undefined);
});

test('a frame named on an image is the image itself, and a picture that cannot be read is said before anything is made', async t => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    krea = of(list, 'krea2'),
    [CLIP, STILL, GONE] = [uid(3), uid(4), uid(5)];
  let failure = 'Ce fichier n’est pas une vidéo lisible.';
  const asked = [];
  const records = {
    [`${A}/${CLIP}`]: take(A, CLIP, ltx, 25),
    [`${A}/${GONE}`]: take(A, GONE, ltx, 26),
    [`${A}/${STILL}`]: { ...take(A, STILL, krea, 12), mediaType: 'image' },
  };
  const { runtime, library } = await stillsWorld(t, {
    workflows: list,
    records,
    missing: [GONE + '.mp4'],
    extractStill: async (path, at) => {
      asked.push([path, at]);
      throw Error(failure);
    },
  });
  const video = (start_image, id) =>
    runtime.request([call('create_video', { prompt: 'x', intention: 'x', workflow: ltx.id, start_image }, id)], place);
  // An image take, an image reference: themselves, nothing read, no reference made.
  const image = await video({ output: STILL, frame: 'last' }, 'call-1');
  assert.deepEqual(image.args.references, [{ input: 'start', output_id: STILL }]);
  assert.equal(image.notes, undefined);
  const file = pngOf(640, 360, 'plage');
  const added = await library.add(Readable.from([file]), { name: 'plage.png', mime: 'image/png', length: file.length, project: PROJECT });
  await library.update(added.id, { prepared: { width: 640, height: 360, frames: [{ url: DOT, time: null }] } });
  const picture = await video({ resource: added.id, frame: 'first' }, 'call-2');
  assert.deepEqual(picture.args.references, [{ input: 'start', resource_id: added.id }]);
  assert.deepEqual(asked, []);
  // A file of the user's is named in the card as they name it in the chat, not by its file name
  // (17/11: « Rôle de 297e3b9ff713460… »).
  assert.equal(picture.plan.references[0].label, (await library.list(PROJECT)).find(item => item.id === added.id).label);
  assert.match(picture.plan.references[0].label, /^#ref\d+$/);
  // The video cannot be read: said in the user's words, as a call the model can correct (400).
  await assert.rejects(video({ output: CLIP, frame: 'last' }, 'call-3'), {
    status: 400,
    message: 'Impossible de lire la dernière image de la prise 25 : ce fichier n’est pas une vidéo lisible.',
  });
  failure = 'l’environnement de génération n’est pas installé (Paramètres › Génération)';
  await assert.rejects(video({ output: CLIP, frame: 'first' }, 'call-4'), {
    status: 400,
    message:
      'Impossible de lire la première image de la prise 25 : l’environnement de génération n’est pas installé (Paramètres › Génération).',
  });
  assert.equal(asked.length, 2);
  // Its file is gone from the disk: said so, the video not even opened.
  await assert.rejects(video({ output: GONE, frame: 'last' }, 'call-5'), {
    status: 400,
    message: 'Impossible de lire la dernière image de la prise 26 : le fichier de cette vidéo est introuvable.',
  });
  assert.equal(asked.length, 2);
  // Nothing is kept of a picture that was not read, and nothing was proposed.
  assert.deepEqual((await library.list(PROJECT)).map(item => item.name), ['plage.png']);
  // Another word than first or last, a take that is none: refused too.
  await assert.rejects(video({ output: CLIP, frame: 'middle' }, 'call-6'), { status: 400, message: /^frame : "first" ou "last"/ });
  await assert.rejects(video({ output: uid(8), frame: 'last' }, 'call-7'), { status: 404 });
  // Where nothing reads a video (no engine): said, not an error of the application.
  const bare = world({ workflows: list, records });
  await assert.rejects(
    bare.runtime.request(
      [call('create_video', { prompt: 'x', intention: 'x', workflow: ltx.id, start_image: { output: CLIP, frame: 'last' } })],
      place,
    ),
    { status: 400, message: /^Impossible de lire la dernière image de la prise 25 : cette lecture n’est pas disponible ici\.$/ },
  );
});

test('a creation asked in the Chat is made with the LoRAs saved for its model, and says so; never one asked in the Studio', async () => {
  const list = shipped(),
    krea = of(list, 'krea2'),
    ltx = of(list, 'ltx25'),
    minimax = of(list, 'minimax_h3'),
    CLIP = uid(3),
    kept = {
      [krea.id]: [{ name: 'styles\\70sSCiFiKrea2Raw.safetensors', strength: 0.8 }, { name: 'detail.safetensors', strength: 1 }],
      [ltx.id]: [{ name: 'grain.safetensors', strength: 0.5 }],
      [minimax.id]: [{ name: 'grain.safetensors', strength: 0.5 }],
    },
    asked = [],
    { runtime, saved } = world({
      workflows: list,
      records: { [`${A}/${CLIP}`]: clip(A, CLIP, ltx) },
      savedStyles: async id => (asked.push(id), kept[id] ?? []),
    });
  let turns = 3;
  const ask = (name, args, options = {}) =>
    runtime.request([call(name, args, 'call-' + turns)], { conversationId: A, turnId: uid(turns++), messages: [], ...options });
  const image = { prompt: 'A lighthouse at night.', workflow: krea.id };
  // In the Chat (`saved`): those of the model, named on the proposal.
  const chat = await ask('create_image', image, { saved: true });
  assert.deepEqual(chat.styles, kept[krea.id]);
  assert.deepEqual(chat.notes, ['LoRA enregistrés pour Krea 2 : 70sSCiFiKrea2Raw · 0,8, detail · 1.']);
  await runtime.execute({ requestId: chat.requestId, permission: 'once', approvalToken: chat.approvalToken });
  await runtime.finished;
  assert.deepEqual(saved.at(-1).parameters.styles, kept[krea.id], 'the take says what it was made with');
  // From the Studio (no `saved`): none taken; those the Studio shows come with « Générer » (revise).
  const studio = await ask('create_image', image);
  assert.equal(studio.styles, undefined);
  assert.equal(studio.notes, undefined);
  // Given with the request (by hand): they are the ones, and nothing is said of the saved ones.
  const given = await ask('create_image', image, { saved: true, styles: [{ name: 'other.safetensors', strength: 1 }] });
  assert.deepEqual(given.styles, [{ name: 'other.safetensors', strength: 1 }]);
  assert.equal(given.notes, undefined);
  // Changed on the proposal, they are the user's: no longer said « enregistrés » ; another change keeps the line.
  const again = await ask('create_image', image, { saved: true });
  const reworded = await revise(runtime, again, { prompt: 'A lighthouse at dawn.' });
  assert.deepEqual(reworded.notes, chat.notes);
  const chosen = await revise(runtime, reworded, { styles: [{ name: 'detail.safetensors', strength: 0.4 }] });
  assert.deepEqual(chosen.styles, [{ name: 'detail.safetensors', strength: 0.4 }]);
  assert.equal(chosen.notes, undefined);
  // One LoRA: said in the singular. The continuation of a clip takes none, nor a family whose engine takes none.
  const video = await ask('create_video', { prompt: 'A red boat.', intention: 'x', workflow: ltx.id }, { saved: true });
  assert.deepEqual(video.notes, ['LoRA enregistré pour LTX 2.5 : grain · 0,5.']);
  const next = await ask(
    'extend_video',
    { source: { output: CLIP }, prompt: 'It sails on.', intention: 'x', workflow: ltx.id },
    { saved: true },
  );
  assert.equal(next.styles, undefined);
  const plain = await ask('create_video', { prompt: 'A red boat.', intention: 'x', workflow: minimax.id }, { saved: true });
  assert.equal(plain.styles, undefined);
  assert.equal(asked.includes(minimax.id), false);
  // The saved ones cannot be read: the creation is made without, not refused.
  const { runtime: broken } = world({
    workflows: list,
    savedStyles: async () => {
      throw Error('lecture impossible');
    },
  });
  const made = await broken.request([call('create_image', image)], { conversationId: A, turnId: turn, messages: [], saved: true });
  assert.equal(made.styles, undefined);
});

test('every image of a series asked in the Chat has the LoRAs saved for its model', async () => {
  const list = shipped(),
    krea = of(list, 'krea2'),
    styles = [{ name: 'detail.safetensors', strength: 1 }],
    { runtime } = world({ workflows: list, savedStyles: async () => styles });
  const first = await runtime.request(
    [call('create_image', { prompt: 'A fox.', series: ['A whale.', 'An owl.'], workflow: krea.id })],
    { conversationId: A, turnId: turn, messages: [], saved: true },
  );
  assert.deepEqual(first.styles, styles);
  const second = await runtime.next({ series: first.series.id });
  assert.deepEqual(second.styles, styles);
  assert.deepEqual(second.notes, ['LoRA enregistré pour Krea 2 : detail · 1.']);
});

test('a LoRA saved for a model whose file is gone is left out, and the proposal says which', async () => {
  const list = shipped(),
    krea = of(list, 'krea2'),
    detail = { name: 'detail.safetensors', strength: 1 },
    gone = { name: 'styles\\70sSCiFiKrea2Raw.safetensors', strength: 0.8 },
    other = { name: 'old/Grain_v2.SAFETENSORS', strength: 0.5 };
  let found = { kept: [detail], missing: [gone] };
  const { runtime, saved } = world({ workflows: list, savedStyles: async () => found });
  let turns = 3;
  const ask = (options = {}) =>
    runtime.request([call('create_image', { prompt: 'A lighthouse at night.', workflow: krea.id }, 'call-' + turns)], {
      conversationId: A,
      turnId: uid(turns++),
      messages: [],
      saved: true,
      ...options,
    });
  // One kept, one gone: made with the first, the second named beside it, by its file alone.
  const mixed = await ask();
  assert.deepEqual(mixed.styles, [detail]);
  assert.deepEqual(mixed.notes, [
    'LoRA enregistré pour Krea 2 : detail · 1.',
    'LoRA enregistré introuvable dans le dossier loras : 70sSCiFiKrea2Raw.',
  ]);
  await runtime.execute({ requestId: mixed.requestId, permission: 'once', approvalToken: mixed.approvalToken });
  await runtime.finished;
  assert.deepEqual(saved.at(-1).parameters.styles, [detail], 'the take is made with those found only');
  // Every one gone: made without any, said in the plural.
  found = { kept: [], missing: [gone, other] };
  const none = await ask();
  assert.equal(none.styles, undefined);
  assert.deepEqual(none.notes, ['LoRA enregistrés introuvables dans le dossier loras : 70sSCiFiKrea2Raw, Grain_v2.']);
  // The note stays through a change of the proposal; styles chosen on it are the user's: no note.
  assert.deepEqual((await revise(runtime, none, { prompt: 'A lighthouse at dawn.' })).notes, none.notes);
  assert.equal((await revise(runtime, await ask(), { styles: [detail] })).notes, undefined);
  // Nothing gone, in either form the application may answer: nothing more is said.
  found = { kept: [detail], missing: [] };
  assert.deepEqual((await ask()).notes, ['LoRA enregistré pour Krea 2 : detail · 1.']);
  found = [detail];
  assert.deepEqual((await ask()).notes, ['LoRA enregistré pour Krea 2 : detail · 1.']);
  // From the Studio (no `saved`), the saved ones are not read: nothing is said of them.
  found = { kept: [], missing: [gone] };
  assert.equal((await ask({ saved: false })).notes, undefined);
  // Each image of a series says it, as it says those it is made with.
  const first = await runtime.request(
    [call('create_image', { prompt: 'A fox.', series: ['A whale.'], workflow: krea.id })],
    { conversationId: A, turnId: uid(turns++), messages: [], saved: true },
  );
  const second = await runtime.next({ series: first.series.id });
  const said = ['LoRA enregistré introuvable dans le dossier loras : 70sSCiFiKrea2Raw.'];
  assert.deepEqual([first.notes, second.notes], [said, said]);
});

test('a draft promoted to its final keeps the LoRAs of the user it was made with', async () => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    styles = [{ name: 'grain.safetensors', strength: 0.5 }],
    { runtime, saved } = world({ workflows: list, savedStyles: async () => [{ name: 'other.safetensors', strength: 1 }] });
  const place = { conversationId: A, turnId: turn, messages: [] };
  const first = await runtime.request(
    [call('create_video', { prompt: 'A red boat crosses the bay at dawn.', intention: 'Brouillon', duration: 5, workflow: ltx.id })],
    { ...place, styles },
  );
  await runtime.execute({ requestId: first.requestId, permission: 'once', approvalToken: first.approvalToken });
  await runtime.finished;
  const draft = saved[0];
  assert.deepEqual(draft.parameters.styles, styles);
  // Its final, asked in the Chat: the draft's own, not those saved for the model, and no line about them.
  const final = await runtime.request(
    [call('create_video', { reuse_output: draft.id, stage: 'final', intention: 'Version finale', prompt: draft.prompt, duration: null }, 'call-2')],
    { ...place, turnId: uid(3), saved: true },
  );
  assert.equal(final.plan.stage, 'final');
  assert.deepEqual(final.styles, styles);
  assert.equal(final.notes, undefined);
});

test('a length asked in seconds is counted at the rate of the profile the clip is made with, not at the value it replaces', async () => {
  const list = shipped(),
    stored = of(list, 'ltx25');
  // Its two profiles set to 30 images a second; the value of the workflow, which they replace, left at 24.
  const ltx = structuredClone(stored);
  for (const profile of Object.values(ltx.profiles)) profile.parameters.fps = 30;
  assert.equal(ltx.parameters.fps?.value ?? ltx.parameters.fps?.default ?? 24, 24);
  const { runtime } = world({ workflows: list.map(workflow => (workflow.id === ltx.id ? ltx : workflow)) });
  const asked = await runtime.request(
    [call('create_video', { prompt: 'A red boat.', intention: 'x', duration: 5, workflow: ltx.id })],
    { conversationId: A, turnId: turn, messages: [] },
  );
  const { frames, fps } = asked.plan.parameters;
  assert.equal(fps, 30);
  // Five seconds asked: five seconds made (counted at 24, they were 121 images: 4 s at 30).
  assert.ok(Math.abs(frames / fps - 5) < 0.2, `${frames} images à ${fps}/s`);
});

test('Krea 2: the denoise the assistant passes with an image to modify stays from 0.6 to 0.7, may be changed there, and is in the record of the take', async () => {
  const list = shipped(),
    krea = of(list, 'krea2'),
    SOURCE = uid(7),
    OTHER = uid(8),
    { runtime, saved } = world({
      workflows: list,
      resources: { [SOURCE]: picture('escalier.png'), [OTHER]: picture('plage.png') },
    });
  let calls = 0;
  const ask = args =>
    runtime.request([call('create_image', { prompt: 'The same staircase at night.', ...args }, 'call-' + ++calls)], {
      conversationId: A,
      turnId: randomUUID(),
      messages: [],
    });
  const made = async request => {
    await runtime.execute({ requestId: request.requestId, permission: 'once', approvalToken: request.approvalToken });
    await runtime.finished;
    assert.equal(runtime.status().state, 'done', runtime.status().error);
    return saved.at(-1).parameters;
  };
  const source = () => ({ resource: SOURCE }),
    setting = request => request.plan.editable.parameters.find(item => item.key === 'denoise');

  // 0.7 asked with an image to modify: proposed, listed with its bounds, made and recorded at 0.7.
  let proposal = await ask({ source: source(), denoise: 0.7 });
  assert.equal(proposal.workflowName, krea.name);
  assert.equal(proposal.plan.parameters.denoise, 0.7);
  assert.deepEqual(
    [setting(proposal).value, setting(proposal).min, setting(proposal).max, setting(proposal).locked],
    [0.7, 0.6, 0.7, undefined],
  );
  assert.deepEqual([proposal.notes, proposal.plan.edited], [undefined, undefined], 'the choice of the assistant, no change of the user');
  let record = await made(proposal);
  assert.equal(record.denoise, 0.7);
  assert.equal(record.replay_args.denoise, 0.7, 'made again, it keeps it');
  assert.equal(record.user_overrides, undefined);
  // Nothing asked: 0.6.
  proposal = await ask({ source: source() });
  assert.deepEqual([proposal.plan.parameters.denoise, setting(proposal).value], [0.6, 0.6]);
  assert.equal((await made(proposal)).denoise, 0.6);
  // Beyond the bounds: brought to the nearest one (as the router does for every number left to the
  // model), said on the proposal, never refused.
  proposal = await ask({ source: source(), denoise: 0.9 });
  assert.equal(proposal.plan.parameters.denoise, 0.7);
  assert.deepEqual(proposal.notes, ['denoise : 0.9 → 0.7, la limite de Krea 2.']);
  assert.equal(proposal.plan.edited, undefined);
  assert.equal((await made(proposal)).denoise, 0.7);
  proposal = await ask({ source: source(), denoise: 0.3 });
  assert.equal(proposal.plan.parameters.denoise, 0.6);
  assert.deepEqual(proposal.notes, ['denoise : 0.3 → 0.6, la limite de Krea 2.']);
  assert.equal((await made(proposal)).denoise, 0.6);

  // Passed without an image to modify: no error, nothing said, the picture made from nothing (1),
  // and no setting to change there.
  for (const denoise of [0.7, 0.9]) {
    proposal = await ask({ denoise });
    assert.equal(proposal.plan.parameters.denoise, 1);
    assert.equal(setting(proposal), undefined);
    assert.ok(proposal.plan.editable.parameters.some(item => item.key === 'width'));
    assert.deepEqual([proposal.notes, proposal.plan.edited, proposal.args.denoise], [undefined, undefined, undefined]);
    record = await made(proposal);
    assert.deepEqual([record.denoise, record.user_overrides, record.replay_args.denoise], [1, undefined, undefined]);
  }
  // An edit of it there is left aside: not made with it, not said « modifié par vous ».
  proposal = await ask({});
  let revised = await revise(runtime, proposal, { denoise: 0.65 });
  assert.equal(revised.plan.parameters.denoise, 1);
  assert.equal(revised.plan.edited, undefined);
  assert.equal((await made(revised)).user_overrides, undefined);
  // An image put in its case on the card: the setting is there, at the value of the workflow.
  proposal = await ask({});
  revised = await revise(runtime, proposal, { add: { role: 'source', source: { resource: OTHER } } });
  assert.deepEqual(rolesOf(revised), ['img2img']);
  assert.deepEqual([revised.plan.parameters.denoise, setting(revised).value, setting(revised).max], [0.6, 0.6, 0.7]);
  revised = await revise(runtime, revised, { denoise: 0.68 });
  assert.equal((await made(revised)).denoise, 0.68);

  // On a proposal with its image, the user sets it within the bounds: said as their change, made
  // with it, and kept in the record of the take.
  proposal = await ask({ source: source() });
  revised = await revise(runtime, proposal, { denoise: 0.65 });
  assert.equal(revised.plan.parameters.denoise, 0.65);
  assert.deepEqual(revised.plan.edited, ['denoise']);
  assert.equal(setting(revised).value, 0.65);
  // Outside them: refused in plain words, and the proposal is still the one to confirm.
  for (const denoise of [0.75, 0.5, 1])
    await assert.rejects(revise(runtime, revised, { denoise }), { status: 400, message: 'Débruitage : entre 0,6 et 0,7.' });
  await assert.rejects(revise(runtime, revised, { denoise: '0.65' }), { status: 400, message: 'Débruitage : un nombre.' });
  // Both ends are values like the others.
  revised = await revise(runtime, revised, { denoise: 0.7 });
  assert.equal(revised.plan.parameters.denoise, 0.7);
  record = await made(revised);
  assert.equal(record.denoise, 0.7);
  assert.deepEqual(record.user_overrides, { denoise: 0.7 });
  // Set back to what the assistant gave, it is no change any more.
  proposal = await ask({ source: source(), denoise: 0.7 });
  revised = await revise(runtime, proposal, { denoise: 0.65 });
  revised = await revise(runtime, revised, { denoise: 0.7 });
  assert.deepEqual([revised.plan.parameters.denoise, revised.plan.edited], [0.7, undefined]);

  // A workflow of the user's that fixes it: the argument is said ignored, and the user may still
  // type any denoise the family takes (the policies restrict the model, not the owner).
  const { ready, digest, ...stored } = krea,
    fixed = { ...validateNativeWorkflow({ ...stored, parameters: { ...stored.parameters, denoise: { policy: 'fixed', value: 0.5 } } }), ready: true },
    own = world({ workflows: [fixed], resources: { [SOURCE]: picture('escalier.png') } });
  const held = await own.runtime.request([call('create_image', { prompt: 'x', source: source(), denoise: 0.7 })], {
    conversationId: A,
    turnId: randomUUID(),
    messages: [],
  });
  assert.equal(held.plan.parameters.denoise, 0.5);
  assert.deepEqual(held.notes, ['denoise ignoré : fixé par le workflow Krea 2.']);
  assert.deepEqual([setting(held).min, setting(held).max], [0, 1]);
  assert.equal((await revise(own.runtime, held, { denoise: 0.4 })).plan.parameters.denoise, 0.4);
});
