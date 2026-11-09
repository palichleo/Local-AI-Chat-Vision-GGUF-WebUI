import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectKreaWorkflow,
  convertKreaWorkflow,
  localFiles,
  locateAsset,
} from '../lib/native-workflow-conversion.mjs';
import { importComfyWorkflow } from '../lib/comfy-import.mjs';

test('conversion resolves separated component directories and rejects ambiguous or escaping names', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-layout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkpoint = join(root, 'checkpoints'),
    vae = join(root, 'VAE'),
    lora = join(root, 'LoRa');
  for (const directory of [checkpoint, vae, lora]) await mkdir(directory);
  await writeFile(join(checkpoint, 'model.safetensors'), 'test');
  await writeFile(join(vae, 'decoder.safetensors'), 'test');
  await writeFile(join(lora, 'style.safetensors'), 'test');
  const index = await localFiles(checkpoint, [vae, lora, join(root, 'LLMs')]);
  assert.equal(index.files.length, 3);
  assert.equal(await locateAsset(index, 'decoder.safetensors'), await realpath(join(vae, 'decoder.safetensors')));
  await assert.rejects(locateAsset(index, '../decoder.safetensors'), /Unsafe/);
  await writeFile(join(checkpoint, 'decoder.safetensors'), 'duplicate');
  await assert.rejects(locateAsset(await localFiles(checkpoint, [vae]), 'decoder.safetensors'), /found 2/);
});

test('uploaded Krea exports select their converter from content and keep the original source backup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'comfy-upload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const models = join(root, 'models');
  await mkdir(models);
  for (const name of ['model', 'encoder', 'vae', 'style'])
    await writeFile(join(models, name + '.safetensors'), 'fixture');
  const sourceText = '\uFEFF' + JSON.stringify({ graph: graph() }, null, 2),
    registered = [],
    saved = [];
  const result = await importComfyWorkflow(sourceText, {
    modelRoot: models,
    backupDir: join(root, 'backup'),
    assets: {
      register: async asset => {
        registered.push(asset);
        return asset;
      },
    },
    catalog: {
      save: async workflow => {
        saved.push(workflow);
        return workflow;
      },
    },
  });
  assert.equal(result.workflow.pipeline, 'krea2');
  assert.equal(result.workflow.enabled, false);
  assert.equal(registered.length, 4);
  assert.equal(saved.length, 1);
  assert.equal(await readFile(result.backupPath, 'utf8'), sourceText);
  const modified = graph();
  modified.sample.inputs.cfg = 4;
  await assert.rejects(
    importComfyWorkflow(JSON.stringify(modified), {
      assets: {
        register() {
          assert.fail('Must validate before registering assets');
        },
      },
    }),
    /CFG/,
  );
});

test('unknown, malformed, oversized and mixed uploaded formats fail before any file operations', async () => {
  for (const value of [
    JSON.stringify({ nodes: [] }),
    JSON.stringify({ schemaVersion: 1, pipeline: 'krea2' }),
    'null',
    '[]',
    '42',
  ])
    await assert.rejects(importComfyWorkflow(value), /compatible/);
  await assert.rejects(importComfyWorkflow('{'), /JSON/);
  await assert.rejects(importComfyWorkflow('é'.repeat(1024 * 1024 + 1)), /2 Mo/);
  await assert.rejects(
    importComfyWorkflow(JSON.stringify({ nodes: [{ type: 'LongForgeLTXVideoSettings' }], graph: graph() })),
    /plusieurs formats/,
  );
});

function graph() {
  return {
    raw: { class_type: 'PrimitiveStringMultiline', inputs: { value: 'A local scene' } },
    seed: { class_type: 'PrimitiveInt', inputs: { value: 0 } },
    model: { class_type: 'UNETLoader', inputs: { unet_name: 'model.safetensors' } },
    lora: {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: ['model', 0], lora_name: 'style.safetensors', strength_model: -0.5 },
    },
    choice: { class_type: 'ComfySwitchNode', inputs: { switch: true, on_true: ['lora', 0], on_false: ['model', 0] } },
    encoder: { class_type: 'CLIPLoader', inputs: { clip_name: 'encoder.safetensors', type: 'krea2' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'vae.safetensors' } },
    encode: { class_type: 'CLIPTextEncode', inputs: { text: ['raw', 0], clip: ['encoder', 0] } },
    latent: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    sample: {
      class_type: 'KSampler',
      inputs: {
        model: ['choice', 0],
        positive: ['encode', 0],
        latent_image: ['latent', 0],
        seed: ['seed', 0],
        steps: 8,
        cfg: 1,
        denoise: 1,
        sampler_name: 'euler',
        scheduler: 'simple',
      },
    },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } },
    save: { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: 'local' } },
  };
}
function expansionGraph() {
  const value = graph();
  Object.assign(value, {
    instruction: { class_type: 'PrimitiveStringMultiline', inputs: { value: 'Expand the following prompt: ' } },
    concat: {
      class_type: 'StringConcatenate',
      inputs: { string_a: ['instruction', 0], string_b: ['raw', 0], delimiter: '' },
    },
    expand: {
      class_type: 'TextGenerate',
      inputs: {
        prompt: ['concat', 0],
        clip: ['encoder', 0],
        max_length: 512,
        'sampling_mode.seed': 0,
        'sampling_mode.temperature': 0.5,
        'sampling_mode.top_k': 64,
        'sampling_mode.top_p': 0.95,
        'sampling_mode.min_p': 0.05,
        'sampling_mode.repetition_penalty': 1.05,
        'sampling_mode.presence_penalty': 0,
        sampling_mode: 'on',
        thinking: false,
        use_default_template: true,
        mtp: 'auto',
      },
    },
    expanded: { class_type: 'ComfySwitchNode', inputs: { switch: true, on_true: ['expand', 0], on_false: ['raw', 0] } },
    triggers: {
      class_type: 'StringConcatenate',
      inputs: { string_a: ['expanded', 0], string_b: 'style trigger', delimiter: ', ' },
    },
  });
  value.encode.inputs.text = ['triggers', 0];
  return value;
}

test('supported Krea graph preserves concrete seed, signed LoRA strength and disabled branches', () => {
  const source = graph();
  const plan = inspectKreaWorkflow(source);
  assert.equal(plan.parameters.seed, 0);
  assert.equal(plan.parameters.prompt, 'A local scene');
  assert.equal(plan.loras[0].strength, -0.5);
  assert.equal(plan.loras[0].enabled, true);
  source.choice.inputs.switch = false;
  assert.equal(inspectKreaWorkflow(source).loras[0].enabled, false);
  assert.equal(source.lora.inputs.strength_model, -0.5);
});

test('conversion preserves original prompt expansion template and every sampling setting', () => {
  const plan = inspectKreaWorkflow(expansionGraph());
  assert.equal(plan.parameters.expandPrompt, true);
  assert.equal(plan.parameters.prompt, 'A local scene');
  assert.deepEqual(plan.promptExpansion, {
    template: 'Expand the following prompt: {{prompt}}',
    maxTokens: 512,
    temperature: 0.5,
    topK: 64,
    topP: 0.95,
    minP: 0.05,
    repetitionPenalty: 1.05,
    seed: 0,
    suffix: ', style trigger',
  });
  assert.equal(plan.promptTemplate, '{{prompt}}, style trigger');
});

test('unknown graphs and changed sampling semantics fail without a guessed conversion', () => {
  const source = graph();
  source.unknown = { class_type: 'ExecuteAnything', inputs: {} };
  assert.throws(() => inspectKreaWorkflow(source), /unsupported.*ExecuteAnything/i);
  const sampler = graph();
  sampler.sample.inputs.scheduler = 'other';
  assert.throws(() => inspectKreaWorkflow(sampler), /scheduler|simple/i);
  const expansion = expansionGraph();
  expansion.expand.inputs['sampling_mode.presence_penalty'] = 0.2;
  assert.throws(() => inspectKreaWorkflow(expansion), /presence/i);
  assert.throws(() => inspectKreaWorkflow({ nodes: [], links: [] }), /editor|API/i);
});

test('explicit conversion backs up exact source bytes and resolves only assets under selected model root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-krea-convert-'));
  try {
    const modelRoot = join(directory, 'models');
    await mkdir(modelRoot);
    for (const name of ['model', 'encoder', 'vae', 'style'])
      await writeFile(join(modelRoot, `${name}.safetensors`), 'local checkpoint');
    const sourcePath = join(directory, 'source.json'),
      backupDir = join(directory, 'backups');
    const original = JSON.stringify({ id: 'old', name: 'Old', description: 'Local workflow', graph: graph() }, null, 2);
    await writeFile(sourcePath, original);
    const registered = [];
    const assets = {
      async register(asset) {
        registered.push(asset);
        return asset;
      },
    };
    let saved;
    const catalog = {
      async save(workflow) {
        saved = workflow;
        return workflow;
      },
    };
    const result = await convertKreaWorkflow(sourcePath, { modelRoot, backupDir, assets, catalog, id: 'converted' });
    assert.equal(await readFile(sourcePath, 'utf8'), original);
    assert.equal(await readFile(result.backupPath, 'utf8'), original);
    assert.equal(result.workflow, saved);
    assert.equal(saved.id, 'converted');
    assert.equal(saved.enabled, false);
    assert.equal(saved.parameters.seed.value, 0);
    assert.equal(saved.loras[0].strength.value, -0.5);
    assert.equal(registered.length, 4);
    assert.ok(registered.every(asset => asset.path.endsWith('.safetensors')));
    assert.equal((await readdir(backupDir)).length, 1);
    const unsafe = graph();
    unsafe.model.inputs.unet_name = '../model.safetensors';
    await writeFile(sourcePath, JSON.stringify(unsafe));
    await assert.rejects(
      convertKreaWorkflow(sourcePath, { modelRoot, backupDir, assets, catalog }),
      /asset|filename|path/i,
    );
    assert.equal((await readdir(backupDir)).length, 1);
    assert.equal(saved.id, 'converted');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
