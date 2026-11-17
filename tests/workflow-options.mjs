import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { families, family } from '../lib/families.mjs';
import { effective, resolveNativeWorkflow, validateNativeWorkflow, workflowSchema } from '../lib/native-workflows.mjs';
import { ToolCatalog } from '../lib/tool-catalog.mjs';
import { inertSetting, parameterPolicies, settingWarning } from '../public/native-workflow-ui.mjs';

/*
 * Each setting of the workflow editor (Paramètres › Workflows, the pencil) against what the engine
 * receives (17/11: the editor did not scroll, and half the fields of some workflows did nothing).
 * A setting the editor leaves open must change the job sent to the engine; one it greys
 * (inertSetting) must not. Every shipped workflow, every one of its parameters and profiles.
 */
const folder = new URL('../runner/workflows/', import.meta.url);
const shipped = readdirSync(folder)
  .filter(name => name.endsWith('.json'))
  .map(name => ({ name, workflow: { ...JSON.parse(readFileSync(new URL(name, folder), 'utf8')), enabled: true } }));
// Every file is here: the same path for the same id, never absent.
const assets = {
  async resolve(id, { kind }) {
    return { id, kind, path: join(tmpdir(), 'moodix-options', `${kind}-${id}`) };
  },
  async pick(role) {
    return { path: join(tmpdir(), 'moodix-options', role) };
  },
};
const RESOURCE = '00000000-0000-4000-8000-000000000001';
/**
 * The arguments the router (tool-catalog.mjs) gives a workflow for a plain request: a prompt, an
 * intention for a video, the default length of a video whose length is the model's (always passed:
 * the length asked, else the standard one), and an input for each required slot.
 */
function argsFor(workflow, extra = {}) {
  const args = {};
  if (workflow.parameters.prompt?.policy === 'model') args.prompt = 'Un renard dans la neige';
  if (workflow.mediaType === 'video') args.intention = 'Essai des réglages';
  if (workflow.mediaType === 'video' && workflow.parameters.frames?.policy === 'model')
    args.frames = workflow.parameters.frames.default ?? family(workflow.pipeline).parameters.frames.default;
  const required = workflow.references.filter(slot => slot.required);
  if (required.length) args.references = required.map(slot => ({ input: slot.id, resource_id: RESOURCE }));
  return { ...args, ...extra };
}
const resolve = (workflow, extra) =>
  resolveNativeWorkflow(workflow, argsFor(workflow, extra), assets, {
    seed: 7,
    jobId: 'options',
    allowPendingReferences: true,
  });
/** What the engine receives, apart from what names the workflow itself (its digest). */
const sent = job => JSON.stringify({ ...job, workflowDigest: undefined });
const fits = (spec, value) =>
  (spec.min === undefined || value > spec.min || (value === spec.min && !spec.exclusiveMin)) &&
  (spec.max === undefined || value <= spec.max) &&
  (!spec.multipleOf || value % spec.multipleOf === 0);
/** Another value the spec allows, or undefined when it allows only this one. */
function otherValue(spec, current) {
  if (spec.choices) return spec.choices.find(value => value !== current);
  if (spec.type === 'boolean') return !current;
  if (spec.type === 'string') return current === 'a' ? 'b' : 'a';
  const step = spec.multipleOf ?? (spec.type === 'integer' ? 1 : 0.125);
  return [current + step, current - step].find(value => fits(spec, value));
}
const verdict = (where, moved, reason) =>
  `${where}: ${moved ? 'changes the job, yet greyed: ' + reason : 'changes nothing, yet left open'}`;

test('a setting the editor leaves open changes the job of every shipped workflow; one it greys changes nothing', async () => {
  let open = 0,
    greyed = 0;
  for (const { name: file, workflow } of shipped) {
    const manifest = family(workflow.pipeline),
      base = sent(await resolve(workflow));
    for (const [name, policy] of Object.entries(workflow.parameters)) {
      const spec = manifest.parameters[name];
      // The prompt has its own line (no setting), a drawn seed is drawn; `unused`: the next test.
      if (name === 'prompt' || policy.policy === 'random' || spec.unused) continue;
      if (policy.policy === 'model' && !Object.hasOwn(policy, 'default')) continue;
      const key = policy.policy === 'fixed' ? 'value' : 'default',
        alternative = otherValue(policy.policy === 'fixed' ? spec : effective(policy, spec), policy[key]),
        where = `${file} (${workflow.name}) · ${name}`;
      if (alternative === undefined) {
        assert.ok(inertSetting(manifest, workflow, name, 'parameter'), `${where}: one value only, yet not greyed`);
        greyed++;
        continue;
      }
      const changed = structuredClone(workflow);
      changed.parameters[name][key] = alternative;
      // « Prompt enhance » (its own section): switched on, with the instruction the family proposes.
      if (name === 'expandPrompt' && alternative) changed.promptExpansion ??= manifest.promptExpansionDefault;
      // A setting the engine only reads with an input (the denoise of Krea 2 with an image to
      // modify) is tried with that input: without it, it changes nothing, and its help says so.
      const slot = spec.onlyWith && workflow.references.find(item => item.role === spec.onlyWith.role),
        given = slot ? { references: [{ input: slot.id, resource_id: RESOURCE }] } : undefined;
      if (spec.onlyWith) {
        assert.ok(slot, `${where}: no input for it in this workflow`);
        assert.equal(sent(await resolve(changed)), base, `${where}: read without its input`);
        assert.match(spec.help, /Sans image/, where);
      }
      const reason =
          inertSetting(manifest, workflow, name, 'value') || inertSetting(manifest, workflow, name, 'parameter'),
        moved = sent(await resolve(changed, given)) !== (given ? sent(await resolve(workflow, given)) : base);
      assert.equal(moved, !reason, verdict(where, moved, reason));
      if (reason) greyed++;
      else open++;
    }
    for (const [stage, profile] of Object.entries(workflow.profiles ?? {})) {
      const stagePolicy = workflow.parameters.stage,
        extra = stagePolicy?.policy === 'model' ? { stage } : {},
        before = sent(await resolve(workflow, extra));
      for (const [name, value] of Object.entries(profile.parameters)) {
        const reason = inertSetting(manifest, workflow, name, stage),
          alternative = otherValue(manifest.parameters[name], value),
          where = `${file} (${workflow.name}) · ${stage} › ${name}`;
        if (alternative === undefined) {
          assert.ok(reason, `${where}: one value only, yet not greyed`);
          greyed++;
          continue;
        }
        const changed = structuredClone(workflow);
        changed.profiles[stage].parameters[name] = alternative;
        const moved = sent(await resolve(changed, extra)) !== before;
        assert.equal(moved, !reason, verdict(where, moved, reason));
        if (reason) greyed++;
        else open++;
      }
    }
  }
  // Not an empty loop: the shipped workflows have many of both.
  assert.ok(open > 40 && greyed > 10, `${open} open, ${greyed} greyed`);
});

test('what LTX 2.5 and MiniMax H3 did not use is greyed, and said why', async () => {
  const byPipeline = Object.fromEntries(shipped.map(({ workflow }) => [workflow.pipeline, workflow]));
  for (const pipeline of ['ltx25', 'minimax_h3']) {
    const workflow = byPipeline[pipeline],
      manifest = family(pipeline);
    // Their sizes and frame rate come from the draft and final profiles, whichever version is made
    // (MiniMax H3 makes 24 images a second, and nothing else).
    for (const name of ['width', 'height', 'fps'])
      assert.match(
        inertSetting(manifest, workflow, name, 'value'),
        pipeline === 'minimax_h3' && name === 'fps' ? /Seule valeur .* : 24\./ : /Brouillon et vidéo finale/,
        `${pipeline} ${name}`,
      );
    // Eight steps whatever is written: the model is distilled.
    assert.match(inertSetting(manifest, workflow, 'steps', 'parameter'), /Seule valeur .* : 8\./);
    assert.match(inertSetting(manifest, workflow, 'steps', 'draft'), /Seule valeur/);
    // The length is the one asked, else the default of « Images vidéo »: never the profile's.
    assert.match(inertSetting(manifest, workflow, 'frames', 'final'), /durée est celle demandée/);
    assert.equal(inertSetting(manifest, workflow, 'frames', 'value'), '');
    // What the profiles hold that is theirs stays open.
    assert.equal(inertSetting(manifest, workflow, 'width', 'final'), '');
  }
});

test('every parameter a family declares is read by its engine, unless the family says it is not', () => {
  const sources = {};
  // What a pipeline hands on is read further down: the models and the video tools of the engine.
  const beside = ['models', 'video']
    .flatMap(name => {
      const folder = new URL(`../runner/${name}/`, import.meta.url);
      return readdirSync(folder)
        .filter(file => file.endsWith('.py'))
        .map(file => readFileSync(new URL(file, folder), 'utf8'));
    })
    .join('\n');
  assert.ok(beside.length > 10000, 'runner/models and runner/video are read');
  for (const manifest of Object.values(families())) {
    // MOSS Image is made by ComfyUI: its graph is built in lib/comfy-graphs.mjs.
    const path =
      manifest.engine === 'external'
        ? new URL('../lib/comfy-graphs.mjs', import.meta.url)
        : new URL(`../runner/pipelines/${manifest.module ?? manifest.family}.py`, import.meta.url);
    const source = (sources[path] ??= readFileSync(path, 'utf8'));
    for (const [name, spec] of Object.entries(manifest.parameters)) {
      const named = new RegExp(`['"]${name}['"]|\\bp\\.${name}\\b`),
        read = named.test(source);
      if (spec.unused) {
        // In its own pipeline only: the models are shared, and another family may read that name there.
        assert.equal(read, false, `${manifest.family}.${name} is read: it is not « unused »`);
        assert.equal(inertSetting(manifest, { parameters: {} }, name, 'parameter'), spec.unused);
      } else if (spec.choices?.length !== 1)
        assert.equal(
          read || (manifest.engine !== 'external' && named.test(beside)),
          true,
          `${manifest.family}.${name} is offered in the editor and read by no engine`,
        );
    }
  }
  // `attention` served ComfyUI: the engine of Moodix runs LTX 2.5 and Krea 2 without reading it.
  assert.ok(family('ltx25').parameters.attention.unused && family('krea2').parameters.attention.unused);
  assert.equal(family('minimax_h3').parameters.attention.unused, undefined, 'MiniMax H3 reads its attention');
  // New workflows are made without it.
  for (const name of ['ltx25', 'krea2']) assert.equal(family(name).template.parameters.attention, undefined, name);
});

test('the router always passes a clip length: the length of a profile is never used', async () => {
  const ltx = shipped.find(({ workflow }) => workflow.pipeline === 'ltx25').workflow,
    tools = new ToolCatalog({ list: async () => [{ ...ltx, ready: true }] }),
    media = { mediaOf: async () => 'image' };
  // No length asked: the default of « Images vidéo » (121), in a draft as in a final.
  const plain = await tools.route('create_video', { prompt: 'Un renard', intention: 'Essai' }, media);
  assert.equal(plain.args.frames, ltx.parameters.frames.default);
  for (const stage of ['draft', 'final']) {
    const job = await resolveNativeWorkflow(ltx, { ...plain.args, stage }, assets, { seed: 7 });
    assert.equal(job.parameters.frames, 121, stage);
    assert.notEqual(ltx.profiles[stage].parameters.width, undefined);
    assert.equal(job.parameters.width, ltx.profiles[stage].parameters.width, `the ${stage} profile sets the size`);
  }
  assert.equal(ltx.profiles.draft.parameters.frames, 25, 'the draft profile names another length');
  // A length asked is passed too.
  const asked = await tools.route('create_video', { prompt: 'Un renard', intention: 'Essai', duration: 2 }, media);
  assert.ok(Number.isInteger(asked.args.frames) && asked.args.frames !== 121);
});

test('what is said of a clip length never reaches the model; what is said of another setting does', async () => {
  const ltx = structuredClone(shipped.find(({ workflow }) => workflow.pipeline === 'ltx25').workflow);
  ltx.parameters.frames.description = 'CONSIGNE-DES-IMAGES';
  ltx.parameters.stage.description = 'CONSIGNE-DE-LA-VERSION';
  const tools = JSON.stringify(await new ToolCatalog({ list: async () => [{ ...ltx, ready: true }] }).definitions());
  assert.equal(tools.includes('CONSIGNE-DES-IMAGES'), false);
  assert.equal(tools.includes('CONSIGNE-DE-LA-VERSION'), true);
  const manifest = family('ltx25');
  assert.match(inertSetting(manifest, ltx, 'frames', 'description'), /durée en secondes/);
  assert.equal(inertSetting(manifest, ltx, 'stage', 'description'), '');
});

test('a prompt is never fixed: the chat and the Studio write one at each creation, and a fixed one refused it', async () => {
  const krea = structuredClone(shipped.find(({ workflow }) => workflow.pipeline === 'krea2').workflow);
  krea.parameters.prompt = { policy: 'fixed', value: 'Un portrait' };
  // The verbs ask for a prompt, and the router passes it on (the Studio sends one too).
  const routed = await new ToolCatalog({ list: async () => [{ ...krea, ready: true }] }).route(
    'create_image',
    { prompt: 'Un renard' },
    { mediaOf: async () => 'image' },
  );
  assert.equal(routed.args.prompt, 'Un renard');
  await assert.rejects(resolveNativeWorkflow(krea, routed.args, assets), /locked parameter cannot be overridden/);
  // The editor shows it as a line, without a switch (tests/native-workflow-ui.mjs).
});

test('the assistant never chooses a seed: « Assistant » was a fixed seed in disguise', async () => {
  const krea = structuredClone(shipped.find(({ workflow }) => workflow.pipeline === 'krea2').workflow);
  krea.parameters.seed = { policy: 'model', type: 'integer', default: 5 };
  const tools = new ToolCatalog({ list: async () => [{ ...krea, ready: true }] }),
    definitions = await tools.definitions(),
    image = definitions.find(tool => tool.function.name === 'create_image').function.parameters;
  assert.equal(image.properties.seed, undefined, 'the model is not offered the seed');
  const routed = await tools.route('create_image', { prompt: 'Un renard', seed: 42 }, { mediaOf: async () => 'image' });
  assert.equal(routed.args.seed, undefined);
  assert.equal(routed.seed, undefined);
  assert.equal((await resolveNativeWorkflow(krea, routed.args, assets)).parameters.seed, 5, 'always its default');
  assert.deepEqual(parameterPolicies('seed'), ['fixed', 'random']);
});

test('a family without LoRAs refuses one on save: the editor offers none (tests/native-workflow-ui.mjs)', () => {
  const upscale = structuredClone(shipped.find(({ workflow }) => workflow.pipeline === 'realesrgan_image').workflow);
  upscale.loras = [
    { id: 'style', asset: 'lora', description: '', enabled: { policy: 'off' }, strength: { policy: 'fixed', value: 1 } },
  ];
  assert.throws(() => validateNativeWorkflow(upscale), /Too many LoRAs/);
  for (const manifest of Object.values(families()))
    assert.equal(manifest.loras?.max > 0, ['krea2', 'ltx25'].includes(manifest.family), manifest.family);
});

test('the LoRA of the subject images of LTX ignores its default and its description: on with them, off without', async () => {
  const ltx = shipped.find(({ workflow }) => workflow.pipeline === 'ltx25').workflow,
    [bound] = ltx.loras,
    on = structuredClone(ltx);
  on.loras[0].enabled = { policy: 'model', default: true };
  on.loras[0].description = 'Autre chose';
  // Without a subject image: off, whatever its default says.
  assert.deepEqual((await resolve(on)).loras, []);
  assert.equal(sent(await resolve(on)), sent(await resolve(ltx)), 'the same job');
  // Neither the model nor its tools see it.
  assert.equal(JSON.stringify(workflowSchema(on)).includes('Autre chose'), false);
  assert.equal(workflowSchema(on).properties.loras, undefined);
  // With one: on.
  const subject = ltx.references.find(slot => slot.role === 'msr_image');
  const job = await resolveNativeWorkflow(
    ltx,
    argsFor(ltx, { references: [{ input: subject.id, resource_id: RESOURCE }] }),
    assets,
    { seed: 7, allowPendingReferences: true },
  );
  assert.deepEqual(
    job.loras.map(lora => lora.id),
    [bound.id],
  );
});

test('at a denoise of 1 the image to modify of Krea 2 is ignored: the editor says so', () => {
  const krea = shipped.find(({ workflow }) => workflow.pipeline === 'krea2').workflow,
    manifest = family('krea2');
  // runner/pipelines/sampling.py (start_latents, which krea2.py calls): noise * sigma + source *
  // (1 - sigma); at a denoise of 1, the first sigma of simple_sigmas is the last point of its
  // grid, 1.0.
  const sampling = readFileSync(new URL('../runner/pipelines/sampling.py', import.meta.url), 'utf8'),
    source = readFileSync(new URL('../runner/pipelines/krea2.py', import.meta.url), 'utf8');
  assert.match(sampling, /return noise \* sigma \+ source \* \(1 - sigma\)/);
  assert.match(source, /latents = start_latents\(noise, source, sigmas\[0\]\)/);
  // The shipped workflow keeps a part of the image: nothing to warn of. One of the user's at 1 is.
  assert.deepEqual(krea.parameters.denoise, { policy: 'fixed', value: 0.6 });
  assert.ok(krea.references.some(slot => slot.role === 'img2img'));
  assert.equal(settingWarning(manifest, krea, 'denoise'), '');
  const whole = structuredClone(krea);
  whole.parameters.denoise.value = 1;
  assert.match(settingWarning(manifest, whole, 'denoise'), /image à modifier est ignorée/);
  assert.equal(settingWarning(manifest, { ...whole, references: [] }, 'denoise'), '', 'no image, nothing to warn of');
});
